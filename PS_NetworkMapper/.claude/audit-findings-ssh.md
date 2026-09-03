# Phase 1 Audit Findings — SSH / Command-and-Control Path

Scope: `lib/Connect-Switch.ps1`, `lib/SshHelpers.ps1`, `lib/Get-JunosNodeData.ps1`, `lib/FleetCrawl.ps1`
Reviewer: Phase 1 (read-only)

---

## SSH-001

- **Track**: CORE / command-and-control path
- **File:line**: `lib/SshHelpers.ps1:76-85` (`Get-JunosSshArgs`), consumed by `lib/Connect-Switch.ps1:42` and `lib/Get-JunosNodeData.ps1:34-35`
- **Severity**: Critical
- **Confidence**: High
- **Claim**: `Get-JunosSshArgs` builds the final SSH argv token as a raw, unescaped, unvalidated string interpolation — `"$Username@$TargetIP"` — and both callers pass the joined argument array to `System.Diagnostics.ProcessStartInfo` as a single unquoted command-line string (not an `ArgumentList`/argv array). `$Username` is operator-settable via the web UI with **zero format validation** and is never quoted or escaped anywhere on this path. A `$Username` value containing a space lets an attacker/careless operator inject arbitrary additional `ssh.exe` command-line options — most critically `-oProxyCommand=<command>`, which OpenSSH executes unconditionally as part of establishing the transport, before authentication even happens (so the `-o PreferredAuthentications=password`/`-o PubkeyAuthentication=no` hardening in the same arg list does not protect against it).
- **Trigger**: Operator (or anyone who can reach the local web UI's `/api/save-config`-style credentials endpoint — no auth token is checked in the code paths reviewed) saves a Junos username such as:
  `admin -oProxyCommand=calc.exe x`
  Any subsequent `/api/connect`, `/api/rescan`, or `/api/scan-network` action launches `ssh.exe`/`cmd.exe` with this identity.
- **Evidence**:
  - `lib/SshHelpers.ps1:84`: `return @("-o", "ConnectTimeout=5", ..., "$Username@$TargetIP")` — no validation of `$Username` anywhere in this function or its callers.
  - `lib/Connect-Switch.ps1:37,42-43`: `$SshArgs = Get-JunosSshArgs -Username $Username -TargetIP $TargetIP` then `$ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("ssh.exe", ($SshArgs -join ' '))` — `ProcInfo.Arguments` is a single joined string, passed verbatim to `CreateProcess`; Win32/CRT argv splitting on whitespace is what `ssh.exe` will see, so a space in `$Username` becomes new, independent argv tokens.
  - `lib/WebServer.ps1:727-729`: `$script:JunosUsername = [string]$Parsed.credentials.username` — this is the *only* place `Username` originates; it comes straight from the parsed JSON POST body with no regex/format check (contrast with `$TargetIP`, which is explicitly regex-locked to `^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$` at every call site in `WebServer.ps1`, e.g. lines 145, 184, 240 — the same discipline was never applied to `Username`).
- **Invariant hit**: INV-CMDPATH (commands must reach the intended device without injection/misrouting); indirectly INV-CREDS (an attacker who can inject `ProxyCommand` gets code execution on the box holding switch credentials, i.e. can exfiltrate every other credential/topology file it holds).
- **Impact**: Arbitrary code execution on the machine running `Start-NetworkMapper.ps1`/`WebServer.ps1`, achievable purely by controlling the saved Junos username string — no separate vulnerability needed. Because this process already holds the plaintext switch password and has established/authorized network reachability to the entire switch fleet, this is a full compromise of the command-and-control host, not merely a local nuisance.
- **Repro** (code trace, not executed against a live device):
  1. POST a config save with `credentials.username = "admin -oProxyCommand=calc.exe x"` (Windows) via whatever endpoint reaches `Invoke-SaveConfigAction`.
  2. Trigger `/api/connect` (or a rescan/scan) for any IP.
  3. `Get-JunosSshArgs` returns `[..., "admin -oProxyCommand=calc.exe x@<TargetIP>"]`.
  4. `Connect-Switch.ps1`/`Get-JunosNodeData.ps1` joins this into the process's `Arguments` string and starts `ssh.exe` (or `cmd.exe /c ssh.exe ...`); the OS-level argv split turns `-oProxyCommand=calc.exe` into its own argument, which `ssh.exe` accepts as a real option and executes.
- **Fix sketch**: Validate `$Username` at the point it's accepted from the web UI (e.g. reject anything outside `^[A-Za-z0-9._-]+$`, matching typical Junos login-name constraints) before it's ever stored to `$script:JunosUsername`, *and* defense-in-depth in `Get-JunosSshArgs`/callers: build the process invocation with a proper argv array (`ProcessStartInfo.ArgumentList`, available in PS 7/.NET Core for `Get-JunosNodeData.ps1`'s pwsh-hosted worker; for the hardcoded Windows PowerShell 5.1 `Connect-Switch.ps1` path, manually apply correct Win32 quoting per-argument) instead of a single joined/interpolated string.

---

## SSH-002

- **Track**: CORE / command-and-control path
- **File:line**: `lib/Get-JunosNodeData.ps1:35`
- **Severity**: Critical
- **Confidence**: High
- **Claim**: Beyond the argv-splitting issue in SSH-001, the batch-mode worker additionally routes the entire SSH invocation through `cmd.exe /c "..."`, with `$Username` (and the rest of `$SshArgs`) interpolated directly into that shell command-line string. This adds a second, broader injection surface: `cmd.exe` metacharacters (`&`, `|`, `"`, `^`, `<`, `>`, `%...%`) in `$Username`, not just whitespace, now let an attacker chain arbitrary shell commands, on top of (not instead of) the `ssh.exe`-level `ProxyCommand` vector in SSH-001.
- **Trigger**: Same as SSH-001, but the payload can be a plain shell command chain instead of needing valid `ssh.exe` option syntax, e.g. a saved username of:
  `admin & calc.exe & echo `
- **Evidence**: `lib/Get-JunosNodeData.ps1:35`: `$ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("cmd.exe", "/c ssh.exe $($SshArgs -join ' ') > `"$TempOut`" 2> `"$TempErr`"")` — `$SshArgs` (which embeds `$Username`) is concatenated into a live `cmd.exe /c` string with no quoting/escaping of the untrusted segment, and no validation exists upstream (see SSH-001 evidence for `$Username`'s origin).
- **Invariant hit**: INV-CMDPATH, INV-CREDS (same reasoning as SSH-001 — this path additionally runs on every fleet-crawl worker, i.e. it fires far more often than the interactive `Connect-Switch.ps1` path, once per device per crawl).
- **Impact**: Same class as SSH-001 (RCE on the crawl host) but reachable through a lower-skill payload (shell metacharacters vs. valid ssh option syntax) and triggered automatically and repeatedly by every fleet crawl, not just an interactive "Launch SSH Session" click.
- **Repro**: Same shape as SSH-001's repro, but trigger via `/api/scan-network` (fleet crawl) instead of `/api/connect`; the payload lands in the `cmd.exe /c` string built at `Get-JunosNodeData.ps1:35`.
- **Fix sketch**: Same root fix as SSH-001 (validate `$Username` format at ingestion). Independently, `Get-JunosNodeData.ps1`'s batch mode should not need a `cmd.exe` shell at all for stdout/stderr redirection — `System.Diagnostics.ProcessStartInfo` can redirect `StandardOutput`/`StandardError` natively (`RedirectStandardOutput`/`RedirectStandardError` + async read to file), removing the shell layer and its metacharacter risk entirely, independent of whether `$Username` is also fixed at the source.

---

## Notes on categories checked with no surviving finding

- **Credential temp-file cleanup on all exit paths**: `Connect-Switch.ps1` (try/finally around the whole body, null-guarded `$AskPass`) and `Get-JunosNodeData.ps1` (askpass cleanup in an outer `finally`, per-invocation `$TempOut`/`$TempErr` cleanup in `Invoke-InteractiveBatch`'s own `finally`) both correctly clean up on success, thrown exception, and early `return`. `Remove-*` helpers use `-ErrorAction SilentlyContinue`, so a cleanup failure (e.g. locked file) is silent, but the 4-hour age-gated `Clear-StaleJunosTempFiles` sweep at the start of every new session bounds the exposure window; not filed as a separate finding given the existing mitigation and lack of a concrete reproduction showing indefinite retention.
- **Command injection via device-supplied data (LLDP)**: `ManagementIP` (used to seed the next crawl target) is regex-constrained to `\d{1,3}(\.\d{1,3}){3}` at parse time (`Get-JunosNodeData.ps1:354`), and `TargetIP` is independently regex-locked to the same shape at every web-facing entry point in `WebServer.ps1`. A compromised/malicious device therefore cannot inject shell/SSH-argument content via its advertised management address — checked and ruled out.
- **Unbounded retry / retry storm against a live switch**: No per-device retry exists in `FleetCrawl.ps1` — each IP is added to `$Visited` before its job starts and is never requeued. The auth-failure circuit breaker (consecutive/total threshold of 3, throttled dispatch after the first failure) is a reasoned, bounded control against fleet-wide account lockout. No issue found.
- **Resource leaks (SSH processes/runspaces)**: `FleetCrawl.ps1`'s orphan-reaping (`Stop-JunosOrphanProcessesLocal`), async `BeginStop`/`PendingDisposal` drain, and `finally`-block runspace pool disposal are all present and reasoned about at length in the existing comments; reviewed and no gap found beyond what's already documented as accepted tradeoffs.
- **Parsing correctness / INV-UI-TRUTH**: Extensive review of the Junos CLI-output parsing in `Get-JunosNodeData.ps1` (interface/uplink/AE-bundle exclusion, VLAN routing-instance disambiguation, MAC-table access-vs-uplink precedence, LLDP switch/MED classification) found the logic already defends against several previously-identified failure modes (documented in-line) and did not surface a new concrete misparse with a reproducible trigger; no finding filed for this category in this pass.
- **Concurrency/shared state in FleetCrawl.ps1**: `$ProgressTable` is explicitly single-writer (crawl loop) / single-reader (poll handler) by design comment; `$TopologyList`/`$Visited`/`$Enqueued`/`$Queue` are only ever touched from the single-threaded main loop, never from worker runspaces. No race found.
