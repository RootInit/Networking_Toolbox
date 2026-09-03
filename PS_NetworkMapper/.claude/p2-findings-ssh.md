# Pass 2 findings — SSH/command-and-control path (SshHelpers.ps1, Connect-Switch.ps1, Get-JunosNodeData.ps1, FleetCrawl.ps1)

Scope reviewed: `lib/SshHelpers.ps1`, `lib/Connect-Switch.ps1`, `lib/Get-JunosNodeData.ps1`, `lib/FleetCrawl.ps1`, plus the parts of `lib/WebServer.ps1` and `Start-NetworkMapper.ps1` needed to trace where `$Username` values entering this path actually originate (required to answer the audit's specific question about unvalidated fallbacks/other credential sources). Read-only — no fixes applied.

---

## P2SSH-1

- **Track**: CORE/SERVICE (INV-CMDPATH)
- **File:line**: `Start-NetworkMapper.ps1:62,100` (unvalidated load) → `Start-NetworkMapper.ps1:161-165` and `lib/FleetCrawl.ps1:216` (propagation) → `lib/Get-JunosNodeData.ps1:34-35` (cmd.exe injection sink) and `lib/Connect-Switch.ps1:37,42` (ssh.exe argv-split sink)
- **Severity**: HIGH
- **Confidence**: High (full static trace, no PowerShell runner available to execute it live, but every hop is unconditional code with no intervening validation)
- **Claim**: The SSH-001/SSH-002 fix (commit `13736ee`) validates `Username` only at `WebServer.ps1`'s `/api/save-config` endpoint (`Invoke-SaveConfigAction`, line ~729, regex `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`). It does **not** validate the username loaded from `Configuration.json`/`Configuration.json.enc` at process startup. That startup-loaded value is used, completely unvalidated, for (a) the entire CLI crawl path (`Start-NetworkMapper.ps1 -SwitchIP ...`), which never touches `WebServer.ps1` at all, and (b) every web-triggered `/api/connect`, `/api/rescan`, `/api/scan-network` action for the life of the running server, until an operator performs one successful save through the UI (which is the only thing that ever overwrites `$script:JunosUsername` with a validated value).
- **Trigger**: A `Configuration.json`/`Configuration.json.enc` file on disk whose `credentials.username` contains injection metacharacters (space + SSH option, or `&`/`|` for the cmd.exe sink). This file is attacker-reachable in the `-NoEncryption` mode (plain JSON, anyone with filesystem write access to the install directory) and reachable by anyone who knows the encryption password in the default mode (including a config written by an older/pre-fix build of this tool, or by any other local process/administrator with that password) — i.e. exactly the kind of "different credential source" / "value read directly from Configuration.json.enc without going through the validated save path" the audit brief asked to check for.
- **Evidence**:
  - `Start-NetworkMapper.ps1:60-64` (`-NoEncryption` branch): `$ConfigParsed = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json; ... $JunosUsername = $ConfigParsed.credentials.username` — no regex check anywhere in this file.
  - `Start-NetworkMapper.ps1:97-102` (encrypted branch): same pattern after `Unprotect-TopologyPayload`, still no validation.
  - `Start-NetworkMapper.ps1:161-165`: `$CrawlResult = Invoke-FleetCrawl -StartIP $SwitchIP ... -Username $JunosUsername -Password $JunosPassword ...` — CLI crawl uses the unvalidated value directly.
  - `Start-NetworkMapper.ps1:143,169`: `Start-MapperWebServer ... -JunosUsername $JunosUsername ...` — the unvalidated value also seeds `$script:JunosUsername` inside `WebServer.ps1` (`WebServer.ps1:883`), which is exactly the variable `Invoke-ConnectAction`/`Invoke-RescanAction`/`Invoke-ScanNetworkAction` use (`WebServer.ps1:952,959,994`) for every SSH action until a later `/api/save-config` overwrites it (`WebServer.ps1:761`, the only place the regex at line 729 runs).
  - `lib/FleetCrawl.ps1:216`: `$PS = [powershell]::Create().AddCommand($WorkerPath).AddParameter("TargetIP", $NextIP).AddParameter("Username", $Username)...` — passes the value through untouched to the worker.
  - `lib/Get-JunosNodeData.ps1:34-35`:
    ```
    $SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP
    $ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("cmd.exe", "/c ssh.exe $($SshArgs -join ' ') > `"$TempOut`" 2> `"$TempErr`"")
    ```
    This is the original SSH-002 sink verbatim — a raw string handed to `cmd.exe /c`. The Pass-1 fix never touched this sink; it only gated one of the inputs that can reach it. `$Username` still lands here unescaped whenever it came from the config-load path above, giving full cmd.exe metacharacter injection (`&`, `|`, `%VAR%`, etc.), not merely SSH-option injection.
  - `lib/Connect-Switch.ps1:34-42`: `$Username = $CredData.Username` (read straight from the credential temp file, itself written from `$JunosUsername` by `Invoke-ConnectAction` — same unvalidated `$script:JunosUsername`) → `$SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP` → `$ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("ssh.exe", ($SshArgs -join ' '))`. `ProcessStartInfo`'s string-`Arguments` constructor does not re-quote/escape `$SshArgs` elements before joining; a space inside `$Username` still splits `"$Username@$TargetIP"` back into multiple argv tokens when Windows re-parses the joined string via `CommandLineToArgvW`, reopening the original SSH-option-injection shape (e.g. `-oProxyCommand=...`) that SSH-001 was written to close.
- **Invariant hit**: INV-CMDPATH ("no injection, truncation, or silent misrouting" reaching the device) — actually broader than the device here: this is arbitrary local code execution on the operator's machine via `cmd.exe /c`, not just a misrouted device command.
- **Impact**: The fix's own commit message and the audit report both frame SSH-001/002 as closed "at its single point of entry." That framing is only true for usernames that arrive via a live `/api/save-config` POST. Any username baked into the config file by another means reaches the same two unhardened sinks (`cmd.exe /c` string in `Get-JunosNodeData.ps1`, `ProcessStartInfo` argv-join in `Connect-Switch.ps1`) with zero validation, for the CLI-crawl entry point unconditionally and for the web server's session credential until the first save. Given `Get-JunosNodeData.ps1` runs on every crawl/rescan/scan-network call (the routine, expected operation of this tool), this is not an edge case — it's the default code path whenever the operator launches via `-SwitchIP` or restarts the server without immediately re-saving credentials through the Settings tab.
- **Repro** (static trace, documented since no PS test runner exists per CFG-004):
  1. With `-NoEncryption`, hand-write `Configuration.json` containing `{"credentials":{"username":"admin & calc.exe & echo ","password":"x"}, ...}` (bypasses the regex entirely — it only runs inside `Invoke-SaveConfigAction`, never on file read).
  2. Run `Start-NetworkMapper.ps1 -SwitchIP 131.30.1.1 -NoEncryption`.
  3. `Start-NetworkMapper.ps1:62` loads the malicious username with no check → `Invoke-FleetCrawl -Username "admin & calc.exe & echo "` (line 162) → `FleetCrawl.ps1:216` → `Get-JunosNodeData.ps1:34-35` builds `cmd.exe /c ssh.exe -o ... admin & calc.exe & echo @131.30.1.1 > ... 2> ...` — `cmd.exe` executes `calc.exe` as a separate command.
  4. Equivalently, launch server-only (`Start-NetworkMapper.ps1 -NoEncryption`, no `-SwitchIP`) with the same config, then click "Launch SSH Session" in the UI before ever visiting Settings — `Invoke-ConnectAction` uses the same unvalidated `$script:JunosUsername`.
- **Fix sketch** (not applied — read-only pass): validate `credentials.username` against the same regex (or a corrected one, pending the escalated realm/length decision) at every load site — `Start-NetworkMapper.ps1:62` and `:100` — and/or, better, harden the actual sinks so no future input path can regress this: build `ProcessStartInfo.ArgumentList` (the `Collection<string>` API, which does proper Win32 quoting per element) instead of `-join ' '` into a single `Arguments` string in both `Get-JunosNodeData.ps1:35` and `Connect-Switch.ps1:42`, and replace the `cmd.exe /c "..."` wrapper in `Get-JunosNodeData.ps1` with a direct `ssh.exe` launch plus `RedirectStandardOutput`/`RedirectStandardError` (redirecting via `ProcessStartInfo` properties instead of a shell `>`/`2>` string) so there is no shell interpreting the joined string at all.

---

## P2SSH-2

- **Track**: SERVICE (INV-CREDS, defense-in-depth)
- **File:line**: `lib/SshHelpers.ps1:15-25` (`Protect-JunosTempFileAcl`)
- **Severity**: LOW
- **Confidence**: High (direct code reading; not independently run on a live Windows/NTFS box)
- **Claim**: `Protect-JunosTempFileAcl` fails open by design when `SetAccessControl` throws (non-NTFS temp dir, permission error mid-flight, etc.) — the bare `catch {}` is the documented, intentional behavior per its own header comment ("swallows failures ... rather than blocking the SSH flow"), so this is not a new bug on its own. What *is* new/unreviewed: unlike every other error path this same commit touched in adjacent files (WS-2's newly-added logging for discarded job results, CFG-001's newly-added logging for dropped scope neighbors), this failure path logs nothing anywhere — not even to `Write-MapperDebugLog`/`Write-DebugLogLocal`. A silent ACL-hardening failure is indistinguishable from success to anyone operating or auditing this tool.
- **Trigger**: Any environment where `[System.IO.File]::SetAccessControl` throws for the credential/askpass temp files — a non-NTFS `%TEMP%` (rare on Windows as the audit brief notes, but not impossible: mapped network drive, some third-party filesystem redirecting `%TEMP%`), or a transient sharing-violation/ACL-propagation error.
- **Evidence**: `SshHelpers.ps1:15-25`:
  ```
  function Protect-JunosTempFileAcl {
      param([Parameter(Mandatory=$true)][string]$Path)
      try {
          ...
          [System.IO.File]::SetAccessControl($Path, $Acl)
      } catch {}
  }
  ```
  No `Write-MapperDebugLog`/equivalent call in the `catch`, and none of the three call sites (`SshHelpers.ps1:41,58,60`) check a return value or log around the call either — the function returns nothing, so the caller has no way to detect degraded protection even if it wanted to.
- **Invariant hit**: INV-CREDS (soft — the credential file is still deleted promptly by the existing `finally`/cleanup paths; this only affects the window while it exists on disk, and it is not a "left behind indefinitely" scenario).
- **Impact**: Low in practice — the underlying files are already short-lived (removed in `finally` blocks) and this ACL hardening is explicitly best-effort/defense-in-depth per its own comment, so a failure here doesn't create the primary vulnerability, only widens the read audience for the plaintext password during the file's brief lifetime, with no record that it happened. Does not fail closed / does not risk breaking credential file creation (confirmed: the `try/catch` wraps only the ACL call, not the file write, and the write already happened before this function is called at each site) — so the "could this break credential file creation entirely" concern from the audit brief does not materialize; this is a fail-open-and-silent issue, not a fail-closed/lockout issue.
- **Repro**: Not independently executed (no Windows/NTFS box in this environment); based on direct reading of the `try/catch` control flow, which is unconditional regardless of platform.
- **Fix sketch** (not applied): add a one-line log call in the `catch` block (mirroring the pattern already used elsewhere in this same commit for WS-2/CFG-001), e.g. `Write-MapperDebugLog "ACL hardening failed for $Path: $_"` if a logging function is in scope at this call depth, so a degraded-security state is at least discoverable in `Mapper_Debug.log` rather than invisible.

---

## Categories checked with no surviving finding

- **Credential file cleanup / temp-file lifecycle** (`SshHelpers.ps1` `finally` blocks in `Connect-Switch.ps1`/`Get-JunosNodeData.ps1`, `Clear-StaleJunosTempFiles` age-gating): traced, matches Pass 1's description, no new gap found — cleanup is unconditional via `try/finally` in both consumers, and the age-gate correctly avoids racing a concurrent session.
- **CFG-001 logging fix correctness** (`FleetCrawl.ps1:327-330`, `git show 5ce1858`): the added `elseif (-not $InScope)` branch is correctly placed inside the same `if/elseif` chain as the enqueue check and only fires when the neighbor was in fact excluded by scope (not e.g. by the separate "already enqueued" condition) — read the surrounding ~30 lines to confirm the branch structure; no logic error found.
- **TargetIP validation surrounding this path** (`WebServer.ps1:145,184,245,481`): consistently regex-locked to IPv4 shape before reaching any process-launch code; no path found where an unvalidated IP reaches `Get-JunosSshArgs`/`ProcessStartInfo`.
- **`Get-JunosSshArgs`'s SSH option set itself** (`SshHelpers.ps1:97-106`): `PreferredAuthentications=password`/`PubkeyAuthentication=no`/`StrictHostKeyChecking=no` combination re-checked against MITM concerns already implicitly accepted by the codebase's own design comment ("these are internal, frequently reimaged switches") — consistent with Pass 1's scope decision not to flag `StrictHostKeyChecking=no` as new; not re-flagging.
