# Pass 2 adversarial verification — SSH/crypto track

Independent re-trace of 5 Pass 2 findings against current HEAD. For each, I read the actual
code myself (not just the finding's evidence quotes), checked for upstream guards the
original agent might have missed, and — where feasible — independently reproduced claimed
runtime behavior rather than trusting the prior report.

---

## 1. P2-SSH-STARTUP (P2SSH-1 / P2WS-001)

**Verdict: CONFIRMED**

Traced the full chain myself against current `HEAD`, independent of the finding's own line
citations:

- `Start-NetworkMapper.ps1:60-64` (`-NoEncryption` branch) and `:97-102` (encrypted branch):
  `$JunosUsername = $ConfigParsed.credentials.username` — read directly from parsed JSON/
  decrypted envelope. Grepped the whole file for the validation regex
  (`[A-Za-z0-9][A-Za-z0-9._-]`) — zero matches. No validation exists on this path.
- `Start-NetworkMapper.ps1:161-165`: CLI crawl (`-SwitchIP`) passes this value straight into
  `Invoke-FleetCrawl -Username $JunosUsername`, never touching `WebServer.ps1` at all.
- `Start-NetworkMapper.ps1:143` / `:169`: same unvalidated value seeds
  `Start-MapperWebServer -JunosUsername $JunosUsername`, which assigns it unconditionally to
  `$script:JunosUsername` at `WebServer.ps1:883` — confirmed by direct read of
  `Start-MapperWebServer`'s param block and body.
- The **only** validation site in the entire codebase is `WebServer.ps1:728-729`
  (`Invoke-SaveConfigAction`, regex `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`), which writes into
  `$script:JunosUsername` at line 761 — a *second*, later write to the same variable that
  line 883 already populated unvalidated at startup. Grepped `Username` across
  `SshHelpers.ps1`, `Connect-Switch.ps1`, `Get-JunosNodeData.ps1`, `FleetCrawl.ps1` — no
  independent/defense-in-depth check anywhere downstream.
- Confirmed both sinks are genuinely unescaped:
  - `Get-JunosNodeData.ps1:34-35` — `New-Object System.Diagnostics.ProcessStartInfo("cmd.exe", "/c ssh.exe $($SshArgs -join ' ') > ...")` — a raw joined string handed to `cmd.exe /c`, no escaping of `$Username` anywhere in `Get-JunosSshArgs` (`SshHelpers.ps1:97-106`, which just interpolates `"$Username@$TargetIP"` into an array later joined with `-join ' '`).
  - `Connect-Switch.ps1:37,42` — `New-Object System.Diagnostics.ProcessStartInfo("ssh.exe", ($SshArgs -join ' '))` uses the single-string `Arguments` constructor overload, which does not re-quote elements; `CommandLineToArgvW` will re-split on an embedded space.

**Upstream guards checked and ruled out:**
- `Unprotect-TopologyPayload` (`TopologyCrypto.ps1:150-162`) does verify an HMAC before
  returning the decrypted config JSON, so a *tampered* encrypted envelope is rejected — but
  this only proves integrity of the ciphertext, not of the plaintext `username` field's
  *shape*. A legitimately-encrypted file (saved by an older pre-fix build, or written by
  `Protect-MapperFile.ps1`'s standalone CLI encrypt path — confirmed no validation there
  either) still carries an arbitrary username through with a valid HMAC.
- No `ValidateScript`/`ValidatePattern` attribute on `-Username` anywhere in
  `Get-JunosNodeData.ps1`'s or `Connect-Switch.ps1`'s param blocks — checked directly, both
  are plain `[string]$Username`.
- `-NoEncryption` mode has zero integrity check at all on `Configuration.json` — confirmed,
  it's a bare `ConvertFrom-Json` with no signature/HMAC step.

This is a genuine, unconditional gap: the regex fix is scoped to one HTTP endpoint
(`/api/save-config`), not to the two actual injection sinks, and the two sinks remain
reachable with a config-loaded (as opposed to browser-POSTed) username on every startup,
every CLI crawl, and every web action until the operator performs one successful save.
Confidence: high (full trace, both sinks read directly, no PowerShell runtime available to
execute end-to-end but every hop is unconditional, unguarded code).

---

## 2. P2-ACL-SILENT (P2SSH-2 / P2REC-003)

**Verdict: CONFIRMED**

Read `SshHelpers.ps1:15-25` directly:

```powershell
function Protect-JunosTempFileAcl {
    param([Parameter(Mandatory=$true)][string]$Path)
    try {
        ...
        [System.IO.File]::SetAccessControl($Path, $Acl)
    } catch {}
}
```

Bare `catch {}`, no logging call, no return value the caller could check. Went further than
the original findings: grepped for `Write-MapperDebugLog`/`Write-DebugLogLocal` across
`SshHelpers.ps1`, `Get-JunosNodeData.ps1`, and `Connect-Switch.ps1` (the only three files
that call `Protect-JunosTempFileAcl`, at `SshHelpers.ps1:41,58,60`) — **zero matches**.
`Write-MapperDebugLog` is defined only in `WebServer.ps1:53` and `Write-DebugLogLocal` only
inside `FleetCrawl.ps1:39` (a local closure, not exported) — neither is even *in scope* at
this call depth. This is stronger than the original findings stated: it's not just that the
existing catch omits a log call, but that no logging facility is reachable from this file at
all without adding a dot-source dependency. The fix isn't a one-line add of an existing call;
it requires either passing a log delegate/path down through `New-JunosCredentialFile`/
`New-JunosAskPass`/`Protect-JunosTempFileAcl`, or `Write-Warning` as a stopgap.

Confirmed the "not a lockout risk" mitigating detail both source findings noted: the
`try` wraps only the ACL call, the file write happens before `Protect-JunosTempFileAcl` is
invoked at each of the three call sites — so a hardening failure never blocks credential
file creation, only silently leaves the file under a weaker ACL. Severity LOW/MEDIUM as
scoped by the originals is reasonable; not upgrading or downgrading.

---

## 3. P2WS-002

**Verdict: CONFIRMED**

Read `WebServer.ps1:186-203` (the WS-2-fixed `Invoke-RescanAction` orphan reap) and
`:252-264` (`Invoke-PingAction`'s equivalent, also fixed) — both correctly call
`Write-MapperDebugLog` on both the success and `catch` branches.

Then read the two claimed still-broken sites directly:

- `WebServer.ps1:269-273` (`Invoke-PingAction`, the *unpolled-client* reap, distinct from the
  orphan-timeout reap a few lines above it):
  ```powershell
  if ($script:PendingPing -and $script:PendingPing.Handle.IsCompleted) {
      try { $script:PendingPing.PS.EndInvoke($script:PendingPing.Handle) | Out-Null } catch {}
      try { $script:PendingPing.PS.Dispose() } catch {}
      $script:PendingPing = $null
  }
  ```
  No `Write-MapperDebugLog` in either `try`/`catch`. Confirmed silent.
- `WebServer.ps1:462-468` (`Invoke-ScanNetworkAction`, same shape):
  ```powershell
  if ($script:PendingScanNetwork -and $script:PendingScanNetwork.Handle.IsCompleted) {
      $Finished = $script:PendingScanNetwork
      if (-not $Finished.Collected) {
          try { $Finished.PS.EndInvoke($Finished.Handle) | Out-Null } catch {}
          try { $Finished.PS.Dispose() } catch {}
          try { $Finished.Runspace.Dispose() } catch {}
      }
      $script:PendingScanNetwork = $null
  }
  ```
  Also confirmed silent on both branches.

Exact line numbers match the finding. This is a straightforward code-comparison claim and it
holds under direct re-reading — the commit's "unlike every other ... path in this file" claim
in its own message is not accurate as a description of post-fix `WebServer.ps1`. LOW severity
(observability-only, no resource leak — `Dispose()` calls are unconditional and unaffected)
is correctly scoped.

---

## 4. P2CRYPTO-001

**Verdict: CONFIRMED (independently re-executed, not just re-traced)**

Read `lib/Protect-MapperFile.ps1:99-101` and `:132-134` — both branches do
`$TempTargetPath = "$TargetPath.tmp"; ... | Out-File ...; Move-Item -Path $TempTargetPath -Destination $TargetPath -Force`, exactly as claimed.

Rather than trust the prior agent's strace output, I ran my own independent repro against the
same `pwsh` 7.6.2 binary this repo's dev shell resolves:

```
$ echo OLD2 > target.json          # pre-existing destination, the in-place-overwrite case
$ echo OLD  > target.json.tmp
$ strace -f -e trace=rename,unlink -o strace.log pwsh -NoProfile -Command \
    'Move-Item -Path "./target.json.tmp" -Destination "./target.json" -Force'
$ grep -E 'rename|unlink' strace.log
unlink(".../target.json") = 0
rename(".../target.json.tmp", ".../target.json") = 0
$ cat target.json
OLD
```

Confirmed independently: two separate syscalls (`unlink` then `rename`), same PID, in that
order, not a single atomic replace. This matches the original finding's strace output
exactly (down to the syscall ordering) and directly falsifies Pass 1's "cosmetic, original
file untouched either way" judgment for the overwrite-existing-destination case — the
destination genuinely does not exist for a real (if narrow) window between the two syscalls.
`[System.IO.File]::Replace(...)` (single `renameat2`/`RENAME_EXCHANGE`-class atomic op) is not
used anywhere in this codebase — confirmed via grep, `Move-Item` is the only mechanism used
for both `Protect-MapperFile.ps1` and `FleetCrawl.ps1`'s topology writes.

One nuance worth flagging that neither source finding stated explicitly: `FleetCrawl.ps1`'s
own topology-write pattern (`FleetCrawl.ps1` — grepped `Move-Item`) uses the *identical*
delete-then-move `Move-Item -Force` mechanism when overwriting an existing snapshot file, so
this atomicity gap is not unique to `Protect-MapperFile.ps1` — it's inherited from the
pattern `efbc0df`'s commit message cites as precedent. That widens the blast radius beyond
what P2CRYPTO-001 scoped (Protect-MapperFile.ps1 only) but doesn't change the HIGH severity
verdict for the specific file/lines the finding names — confirming, not undermining, the
claim.

Confidence: high — directly reproduced, not merely traced.

---

## 5. P2CRYPTO-002

**Verdict: CONFIRMED**

Both claims verified by direct reading:

1. **No try/finally cleanup**: `Protect-MapperFile.ps1`'s full body (read start to end) has
   no `try`/`finally` wrapping either `Out-File`+`Move-Item` pair (lines 99-101, 132-134).
   An uncaught exception from `Move-Item` (including the P2CRYPTO-001 failure mode) exits the
   script with the `.tmp` file left on disk, no cleanup path. Compared directly against
   `FleetCrawl.ps1:507-513`'s `finally { if (Test-Path $TempOutputFile) { Remove-Item -Path $TempOutputFile -Force } }` — confirmed that pattern exists there and has no counterpart in
   `Protect-MapperFile.ps1`.
2. **Fixed, non-unique temp name**: `Protect-MapperFile.ps1:99,132` both compute
   `$TempTargetPath = "$TargetPath.tmp"` — no PID, timestamp, or GUID component. Compared
   against `FleetCrawl.ps1:119`'s `NetworkMap_$ScanTimestamp.tmp$OutputExtension` — confirmed
   unique per crawl run there, not here.

Severity/likelihood framing in the original (MEDIUM, low-likelihood since this is a
standalone CLI tool never invoked by `WebServer.ps1` or any automation) checked and
confirmed accurate — grepped the whole repo for `Protect-MapperFile` outside its own file:
no matches, it is genuinely never invoked programmatically elsewhere. Concurrent-invocation
trigger requires two manual operator launches against the same target file, which is a real
but narrow window. No basis found to upgrade or downgrade from MEDIUM.

---

## Summary

| Finding | Verdict |
|---|---|
| P2-SSH-STARTUP | CONFIRMED |
| P2-ACL-SILENT | CONFIRMED |
| P2WS-002 | CONFIRMED |
| P2CRYPTO-001 | CONFIRMED (independently re-executed) |
| P2CRYPTO-002 | CONFIRMED |

All five findings survive adversarial re-verification. No upstream guard, validation
attribute, or overlooked code path was found that would refute or downgrade any of them.
None require a second verifier on confidence grounds — all traces were direct reads of
current `HEAD` against exact cited line numbers (which matched in every case), and
P2CRYPTO-001 was independently reproduced end-to-end rather than trusted from the prior
agent's report.
