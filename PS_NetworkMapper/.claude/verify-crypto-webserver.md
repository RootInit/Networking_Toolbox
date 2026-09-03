# Adversarial Verification — CRYPTO-001/002, WS-1/WS-2

## CRYPTO-001

**Verdict: CONFIRMED**

Read `lib/Protect-MapperFile.ps1` in full (126 lines).

- Decrypt branch (line 94): `$PlainJson | Out-File -FilePath $TargetPath -Encoding utf8 -Force`
- Encrypt branch (line 123): `$Envelope | ConvertTo-Json -Depth 10 | Out-File -FilePath $TargetPath -Encoding utf8 -Force`

Both are direct, single-step writes to `$TargetPath` with no temp-file staging and no
`Move-Item`. `Out-File` opens the destination handle (truncating any existing file) before
streaming content, so a kill/crash/disk-full partway through either write leaves a
truncated/invalid file at `$TargetPath` with no recovery path.

Compared directly against `lib/FleetCrawl.ps1:180-187`, which explicitly writes to
`$TempOutputFile` first and only does `Move-Item -Path $TempOutputFile -Destination
$OutputFile -Force` after the write succeeds, with an explicit code comment stating the
purpose is exactly to avoid "a truncated one a poller could read mid-write." This confirms
the safe pattern is known and deliberately used elsewhere in the same codebase — its
absence in `Protect-MapperFile.ps1` is a genuine inconsistency, not a considered tradeoff
documented anywhere in the file.

**In-place reachability confirmed on both cited paths:**
1. Line 119: `$DefaultOutput = if ($ResolvedInput -match '\.enc$') { $ResolvedInput } else { "$ResolvedInput.enc" }` — if `-InputFile` is a plaintext JSON file whose name happens to end in `.enc`, the default output path is the *same* file. The "already encrypted" guard at line 104 only checks `$ParsedInput.format -match '^PSNetworkMapper-Encrypted'`, which a plain JSON file with an `.enc`-suffixed name will not have — it sails through and gets encrypted onto itself.
2. Any explicit `-OutputFile` equal to `-InputFile` (natural in-place encrypt/decrypt usage, and the script's own header comment at lines 6-9 explicitly demonstrates `-OutputFile` as a normal option) hits the identical unguarded `Out-File -Force`.

**Reachability via the running app:** confirmed this script is a genuinely standalone CLI.
`grep -rl "Protect-MapperFile"` across the repo returns only the script itself and audit
documentation (`.claude/audit-findings-crypto.md`, `.claude/audit-findings-security.md`,
`AUDIT_LEDGER.md`) — no `.ps1` in `lib/` or the top-level entry points ever dot-sources or
invokes it. This matches its own header comment ("Not part of the app's own runtime. Run it
directly"). So this is not reachable through the live web UI/webserver session — it requires
an operator to run this admin utility directly from a shell, exactly as the finding itself
already states in its Impact section. The finding does not overclaim reachability here; it
correctly scopes the risk to the standalone-CLI workflow.

**Conclusion:** The finding's mechanism, code citations, and severity reasoning all hold up
under direct reading. No upstream guard prevents it (the `.enc`-in-name plaintext case
genuinely passes the encrypted-envelope check), and no test covers atomicity of this write
(the crypto test suite is round-trip/format focused, not process-interruption focused).
CONFIRMED as filed — High severity is reasonable given total, unrecoverable data loss on a
crash mid-write with no backup copy.

---

## CRYPTO-002

**Verdict: CONFIRMED (as a real but harmless doc-comment inaccuracy)**

`git log -p -- lib/TopologyCrypto.ps1` was inspected. `Get-TopologyPbkdf2Iterations` was
introduced already returning `600000` (comment in that same commit: "Start-WebServer.ps1's
Invoke-SaveConfigAction hardcoded its own $Iterations = 600000 separately from
Start-NetworkMapper.ps1's $PBKDF2_ITERATIONS = 600000 - both agreed today ... Added
Get-TopologyPbkdf2Iterations ... confirmed it returns 600000"). No commit in the file's
history ever set or referenced 200,000 as a real value — the number 200000 does not appear
anywhere in the crypto-related history. So the `web-src/topology-crypto.js:32-34` comment's
"(currently 200,000)" was never accurate; it's either a copy/paste guess or drift from an
earlier design discussion that never matched the shipped code.

Functional impact confirmed zero: `MIN_ITERATIONS = 1000` (line 35) is well below the real
600,000 value, so `decryptEnvelope`'s iteration-bounds check (`MIN_ITERATIONS <= iterations
<= MAX_ITERATIONS`) passes for every real file. `Get-TopologyPbkdf2Iterations` remains the
single source of truth referenced by all three writers (`Start-NetworkMapper.ps1`,
`lib/WebServer.ps1`, `lib/Protect-MapperFile.ps1`), all producing 600,000-iteration
envelopes that decrypt fine under the current MIN bound regardless of what the comment
claims.

**Conclusion:** CONFIRMED as filed — genuine stale/wrong comment, Low severity/no runtime
impact, exactly as the finding states. No downgrade or rejection warranted; it's already
filed at the right (low) severity.

---

## WS-1

**Verdict: REJECTED**

Read `lib/WebServer.ps1:1004-1022` (the shutdown `finally` block) in full, plus the
surrounding accept-loop `try`/`finally` structure and the two reap loops at 191-198 /
247-254 for context.

**PowerShell `finally`-abort semantics — confirmed accurate.** Empirically verified with
`pwsh` that an unguarded `throw` partway through a `finally` block does abort every
subsequent statement in that same block and propagates outward:

```
function Test-Finally {
    try { Write-Host "try" }
    finally {
        Write-Host "finally-start"
        try { throw "boom" } catch {}
        Write-Host "after-guarded-throw"
        throw "unguarded-boom"
        Write-Host "SHOULD-NOT-PRINT-1"
    }
}
try { Test-Finally } catch { Write-Host "caught outer: $_" }
```
Output: `try`, `finally-start`, `after-guarded-throw`, `caught outer: unguarded-boom` — the
line after the unguarded throw never printed. So *if* one of the unguarded `.Dispose()`
calls at lines 1007/1008/1018/1019 threw, the finding's claim that everything queued after it
(`$script:RescanPool.Close()/.Dispose()`, `$script:PingPool` cleanup, etc.) would be skipped
is mechanically correct.

**The load-bearing premise — "`Dispose()` can throw (e.g. `InvalidPowerShellStateException`)
when called on a pipeline that is still Running/Stopping" — does NOT hold up.** Tested
directly against `System.Management.Automation.PowerShell` (pwsh 7.6.2, the same BCL type
used by this code) across every state the finding hypothesizes as dangerous:

1. `Dispose()` called on a still-`Running` pipeline (never `.Stop()`'d first): no exception —
   `Dispose()` completed and left state `Stopped`.
2. `Dispose()` called immediately after an async `BeginStop()` while state is still
   `Stopping` (simulating the exact "Stop() not landing cleanly, blocked in a synchronous
   native call" scenario the finding describes for `ssh.exe`): no exception — `Dispose()`
   blocked internally until stop completed, then returned cleanly.
3. `Dispose()` called twice on the same instance: no exception (idempotent, as the standard
   .NET `IDisposable` contract requires).
4. `Dispose()` called on a `PowerShell` instance whose `RunspacePool` was already
   `.Close()`'d while the pipeline was still running: no exception.
5. As a control, `.Stop()` itself (the call the code *does* guard with `try{}catch{}`) was
   also tested on an already-`Completed` pipeline: no exception either — so even the
   defensive guard the file already has around `.Stop()` isn't observably protecting against
   anything reproducible.

`PowerShell.Dispose()` is implemented to internally stop the pipeline as part of disposal
(observed behavior: it blocks until the running/stopping pipeline actually reaches a
terminal state rather than throwing), consistent with the general .NET `IDisposable`
convention that `Dispose()` should be safe to call from any object state and safe to call
more than once. I could not reproduce `InvalidPowerShellStateException` — or any exception —
from `.Dispose()` under any of the states the finding names as the trigger.

I could not test against Windows PowerShell 5.1 specifically (this environment only has
`pwsh` 7.6.2; the codebase's own comments elsewhere indicate 5.1 compatibility is a live
constraint for the crypto code). I can't rule out a 5.1-specific difference with certainty,
but `PowerShell.Dispose()`'s internal-stop-on-dispose behavior has been part of
`System.Management.Automation` since `PowerShell` v3 and there is no known behavioral change
here between 5.1 and 7.x documented anywhere I could find, nor any comment in this codebase
suggesting the author observed or worked around such an exception (contrast with the
`.Stop()` comment at line 362, which cites a *specific, concrete* reason `.Stop()` is
untrustworthy — "can't interrupt a pipeline blocked in a synchronous native/WMI ping call" —
with no equivalent comment anywhere about `Dispose()` throwing).

**The asymmetry argument (one block guards every disposal, two don't) is not itself
evidence of a bug.** It's equally, and I think more plausibly, explained as: the
`$script:PendingScanNetwork` block at 1011-1015 also disposes a `Runspace` object (a
different type, `.Dispose()`'d after `PS.Dispose()`) that the *other* two blocks don't touch
at all — extra defensive wrapping there is consistent with ordinary inconsistent style
across a 1000+ line file, not with the author having specifically identified and worked
around a `PowerShell.Dispose()` failure mode.

**Conclusion:** The `finally`-block-abort mechanism is real (confirmed empirically), but the
finding's trigger condition — `.Dispose()` throwing — does not reproduce under direct testing
of the actual API surface this code calls, across every state scenario the finding itself
proposes. Without a demonstrated way to make `.Dispose()` throw, there is no live path to the
"leaked ssh.exe process after shutdown" impact claimed. REJECTED — the premise fails
empirical testing; this reads as a plausible-sounding pattern-match ("unguarded call in a
cleanup block") rather than a reproducible defect. If the maintainers want defense-in-depth
consistency for its own sake (matching style across the file), that's a legitimate but purely
cosmetic follow-up, not a High-severity leak.

---

## WS-2

**Verdict: CONFIRMED**

Read `lib/WebServer.ps1:191-198` (`Invoke-RescanAction`'s orphan reap) and `247-254`
(`Invoke-PingAction`'s orphan reap) verbatim, plus `Invoke-RescanStatusAction` (378-427) for
what the same `EndInvoke` payload drives when reaped *before* the 90s timeout.

Confirmed exact code:
```
191: for ($i = $script:OrphanedScans.Count - 1; $i -ge 0; $i--) {
192:     $Orphan = $script:OrphanedScans[$i]
193:     if ($Orphan.Handle.IsCompleted) {
194:         try { $Orphan.PS.EndInvoke($Orphan.Handle) | Out-Null } catch {}
195:         $Orphan.PS.Dispose()
196:         $script:OrphanedScans.RemoveAt($i)
197:     }
198: }
```
identical pattern at 247-254 for `$script:OrphanedPings`.

Confirmed what's thrown away: at line 391-414 (the non-orphaned path), the identical
`EndInvoke` return value is unpacked into `$Result.Node`/`$Result.Logs`, used to decide
`ok:true`/`ok:false`, and sent back to the browser as the rescan's actual outcome — a real,
otherwise-consumed payload, not a throwaway status object. In the orphan-reap path, the exact
same call's return value is piped to `Out-Null` with zero inspection, and any exception from
a failed job is swallowed by an empty `catch {}` — no branch of either logs, surfaces, or
persists what happened.

Confirmed the logging-convention comparison: `grep -n "Write-MapperDebugLog" lib/WebServer.ps1`
returns 9 call sites — `CONNECT ERROR` (162), `GET-CONFIG ERROR` (600), `GET-SNAPSHOTS
WARNING`/`ERROR` (666, 672), `SAVE-CONFIG ERROR` (734), `ACCEPT LOOP ERROR` (902),
`UNHANDLED REQUEST ERROR` (1000), plus the logger definition/header. None of them are inside
either reap loop, and no other logging call of any kind (`Write-Host`, `Write-Warning`, etc.)
appears near lines 191-198 or 247-254 either. This is genuinely the one silent-discard path
in the file — every other catch block that discards an error still logs it first.

**Trigger is realistic, not a corner case.** The file's own code and comments (lines
419-427, 360-372) establish that a job finishing shortly after the 90s/20s client timeout is
the *expected*, designed-for reap path (that's the entire reason `$script:OrphanedScans`/
`$script:OrphanedPings` exist) — not a rare race condition. Any device that's simply slow
(large ARP table, high stack-member count) hits this every time.

**Conclusion:** CONFIRMED exactly as filed. Medium severity is reasonable: no crash, no
resource leak (the job cleanup itself is fine), but a real, silent loss of both successful
scan data and failure diagnostics for exactly the "device is slow, not dead" case this tool
is meant to help diagnose. No existing test or upstream guard covers this — it's a genuine
gap.
