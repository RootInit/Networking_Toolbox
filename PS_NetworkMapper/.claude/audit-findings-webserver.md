# Audit Findings — lib/WebServer.ps1 (Phase 1)

Reviewer scope: lib/WebServer.ps1 only (1023 lines), read-only. Cross-referenced
lib/Get-JunosNodeData.ps1 and web-src/drawer.js only to confirm/refute hypotheses
(e.g. worker-side timeout bound, client polling contract) — no findings filed
against those files here.

Categories checked and ruled out (no surviving finding): request-dispatch
concurrency/races (accept loop is single-threaded/serial by design, confirmed no
check-then-act race across the $script:Pending* gates), command injection via
$TargetIP into Invoke-ConnectAction's Start-Process ArgString (regex-locked to
digits/dots before use), path traversal in Invoke-StaticFile (prefix-matched
against a trailing-separator-normalized root), CSRF/DNS-rebinding coverage
(Test-SameOriginRequest applied consistently to every stateful/sensitive
endpoint, fails closed when neither Origin nor Referer present), malformed-JSON
handling in every ConvertFrom-Json call site (all fall through to a clear 4xx,
never an unhandled exception), interface contract vs. web-src/drawer.js's
rescan/ping polling (status shapes, timeout thresholds, and 409-vs-4xx handling
all matched on inspection).

---

## WS-1

**Track:** SERVICE / CORE
**File:line:** lib/WebServer.ps1:1004-1022 (specifically the unguarded calls at
1007, 1008, 1018, 1019, and the pool cleanup that follows them at 1016-1017,
1020-1021)
**Severity:** High
**Confidence:** Medium

**Claim:** The server's shutdown path (the `finally` block that runs on Ctrl+C /
listener stop) disposes `$script:PendingScan`, each entry in
`$script:OrphanedScans`, `$script:PendingPing`, and each entry in
`$script:OrphanedPings` by calling `.PS.Stop()` (guarded by `try{}catch{}`)
immediately followed by an **unguarded** `.PS.Dispose()`. If any of those
`Dispose()` calls throws, the exception propagates out of the `finally` block
and aborts every cleanup statement that was still queued after it — including
`$script:RescanPool.Close()/.Dispose()` and the entire `$script:PendingPing` /
`$script:OrphanedPings` / `$script:PingPool` cleanup block that follows.

**Trigger:** Ctrl+C (or any other exit from the accept-loop `while`) while a
rescan or an already-orphaned scan/ping job's `PowerShell` pipeline is not yet
fully in the `Stopped` state when `.Dispose()` is called. `System.Management.
Automation.PowerShell.Dispose()` can throw (e.g.
`InvalidPowerShellStateException`) when called on a pipeline that is still
`Running`/`Stopping`. The code's own `.Stop()` call is wrapped in `try{}catch{}`
specifically because `Stop()` itself can fail/no-op in certain states — meaning
the very case this code anticipates (`Stop()` not landing cleanly) is exactly
the case that leaves the pipeline in a state where the immediately-following
unguarded `Dispose()` is most likely to throw.

**Evidence:** Compare the two disposal blocks in the same `finally`:
- Line 1007: `if ($script:PendingScan) { try { $script:PendingScan.PS.Stop() } catch {}; $script:PendingScan.PS.Dispose() }` — `Dispose()` unguarded.
- Line 1008: `foreach ($Orphan in $script:OrphanedScans) { try { $Orphan.PS.Stop() } catch {}; $Orphan.PS.Dispose() }` — `Dispose()` unguarded.
- Lines 1012-1014 (the `$script:PendingScanNetwork` block, three statements
  later): every single disposal (`PS.Stop()`, `PS.Dispose()`,
  `Runspace.Dispose()`) is individually wrapped in its own `try{}catch{}`.
- Lines 1018-1019: same unguarded-`Dispose()` pattern repeated for
  `$script:PendingPing` / `$script:OrphanedPings`.

The asymmetry (one block defensively guards every disposal call, the other two
don't) is itself evidence this is an oversight rather than an intentional
design choice — the author clearly knew `Dispose()` can throw and guarded for
it once, but not consistently.

**Invariant hit:** INV-JOBS ("Background runspace jobs ... are always cleaned
up — no leaked SSH sessions/processes/runspaces on error, cancel, or client
disconnect") — this is specifically the "cancel" case.

**Impact:** If the early `Dispose()` throws, `$script:RescanPool` and
`$script:PingPool` are never `.Close()`d/`.Disposed()`d, and any still-tracked
`$script:PendingPing`/`$script:OrphanedPings` entries are never stopped either.
Because `Invoke-RescanAction`'s worker (`Get-JunosNodeData.ps1`) shells out to
`ssh.exe` as a **separate OS child process** (via `cmd.exe /c ssh.exe ...`,
see Get-JunosNodeData.ps1:35,49), a runspace that never gets `.Stop()`'d on
this path can leave its underlying `ssh.exe` process running detached after
the PowerShell host process exits — i.e. after the operator believes they've
shut the tool down, a live SSH session to a production switch can keep
running in the background, unnoticed. This is a concrete, operationally
meaningful violation of "no leaked SSH sessions ... on ... cancel."

**Repro (code trace, not empirically forced in this read-only pass):**
1. Start a rescan (`/api/rescan`) or let one time out into
   `$script:OrphanedScans` (per the 90s status-timeout logic at
   WebServer.ps1:419-430) while its underlying `ssh.exe` child process is
   still actually connected/running.
2. Hit Ctrl+C while that pipeline is not yet `Stopped` (e.g. immediately after
   the timeout, or while `.Stop()` at line 1007 is itself failing/no-op'ing —
   plausible given the pipeline may be blocked in a synchronous native call,
   the same reasoning the code's own comments give for why `.Stop()` isn't
   trusted to interrupt these jobs promptly elsewhere in this file, e.g.
   lines 420-422, 361-363).
3. `.PS.Dispose()` at line 1007 throws → `finally` block aborts at that
   statement → lines 1008-1021 (including `$script:RescanPool.Dispose()` and
   all of `$script:PingPool`'s cleanup) never execute.

**Fix sketch:** Wrap every `Dispose()` call in this `finally` block in its own
`try{}catch{}`, matching the pattern already used for `$script:
PendingScanNetwork` at lines 1011-1015 — i.e. make lines 1007, 1008, 1018, 1019
symmetric with 1012-1014. Optionally also guard `$script:RescanPool.Close()/
.Dispose()` and `$script:PingPool.Close()/.Dispose()` the same way, so a
failure disposing one pool can't skip disposing the other.

---

## WS-2

**Track:** SERVICE
**File:line:** lib/WebServer.ps1:191-198 (Invoke-RescanAction's orphan reap)
and lib/WebServer.ps1:247-254 (Invoke-PingAction's orphan reap)
**Severity:** Medium
**Confidence:** High

**Claim:** When a previously-timed-out ("orphaned") rescan or ping job
subsequently finishes on its own, the code that reaps it discards the job's
outcome entirely — both the result (on success) and the failure reason (on
error) — without writing anything to `Mapper_Debug.log` or anywhere else. The
operator has no way to learn that a device they thought failed to rescan
actually *did* answer, nor to see why an orphaned job ultimately failed.

**Trigger:** A rescan/ping that runs past its client-facing timeout window
(90s for rescan per WebServer.ps1:419-430, comment explicitly reasoning that
`.Stop()` isn't safe here because `New-JunosAskPass` writes a plaintext
credential file cleaned up only by the worker's own `finally`; 20s for ping
per WebServer.ps1:360-372) but was not actually hung — it completes shortly
after being moved into `$script:OrphanedScans`/`$script:OrphanedPings`. This is
a normal, expected occurrence for any device that's simply slow (e.g. a stack
member enumerating a large ARP/MAC table), not just a truly dead one — the
file's own comments already acknowledge jobs finish "on their own" after the
timeout as the expected reap path, so this isn't a rare corner case.

**Evidence:**
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
`EndInvoke`'s return value — the actual `@{ Node = ...; Logs = ... }` payload
`Invoke-RescanStatusAction` would otherwise have turned into a `node`/`ok:true`
response (see lines 406-414 for what that payload normally drives) — is piped
straight to `Out-Null`. No `Write-MapperDebugLog` call exists in this loop at
all, on either the success or the `catch {}` (failure) path. The identical
pattern repeats at lines 247-254 for `$script:OrphanedPings`. Contrast with
every other error path in this file (e.g. `CONNECT ERROR`, `SAVE-CONFIG
ERROR`, `GET-SNAPSHOTS WARNING` at lines 162, 734, 666), which all log via
`Write-MapperDebugLog` — this reap path is the one place in the file that
silently drops an outcome with zero trace.

**Invariant hit:** Adjacent to INV-JOBS (job lifecycle: this is a real "no exit
transition surfaced to the operator" gap — the job *is* cleaned up
resource-wise, but its terminal state is thrown away) and to the general
"swallowed exceptions" review category — a real fault (or real success) that
the operator needs to know about is silently discarded.

**Impact:** A device that was actually reachable and returned good data during
a rescan that merely ran past the 90s UI timeout never gets its data merged
into the topology, and the operator is never told the SSH session that they
were led to believe had "timed out" (client-facing message: "Rescan of X timed
out.") in fact succeeded a few seconds later. Repeated on a flaky/slow device,
this can look like a persistently broken device when it isn't, with no log
line anywhere to reveal the truth — actively misleading for exactly the
troubleshooting scenario (a marginal/slow device) this tool exists to surface.

**Repro:** Trigger a rescan against a device whose SSH session responds in,
say, 92-100 seconds (slow but not hung — e.g. add an artificial delay in a
test double for the worker, or observe against a real stack member with a
very large `show ethernet-switching table`/ARP output). Confirm via the UI
that the rescan reports "timed out" at 90s. Trigger a second rescan (any
device) shortly after so `Invoke-RescanAction`'s reap loop runs; confirm in
`Mapper_Debug.log` that no line records the first device's late completion,
and confirm the first device's dashboard data was never updated despite the
SSH session having actually succeeded.

**Fix sketch:** In both reap loops, branch on whether `EndInvoke` succeeded
and log the outcome either way — e.g. `Write-MapperDebugLog "RESCAN ORPHAN
[$($Orphan.IP)] Job completed after client timeout: $(if success) 'ok, data
discarded' else 'failed: $_'"`. If reviving the result into the live topology
is out of scope for a quick fix, at minimum log it so the operator isn't
flying blind; a deeper fix could stash the late result somewhere the UI can
surface it as "device answered after all — rescan again to pick it up" rather
than nowhere.
