# Pass 3 findings — SSH/crawl path (lib/SshHelpers.ps1, lib/Connect-Switch.ps1, lib/Get-JunosNodeData.ps1)

Scope reviewed against `git show e24f17e` (Pass 2's P2-SSH-STARTUP / P2-ACL-SILENT / P2FRESH-001 fixes)
plus a fresh full read of the current files. Full CORE/SERVICE taxonomy applied; the four
directed questions in the task are answered inline below, findings follow.

## Task 1 — is there any SSH-invocation path that bypasses `Get-JunosSshArgs`?

Repo-wide search for `ssh.exe`, `cmd.exe`, `ProcessStartInfo`, `Start-Process`:
only two actual process-launch sites exist — `lib/Connect-Switch.ps1:42` and
`lib/Get-JunosNodeData.ps1:38` — and both call `Get-JunosSshArgs` immediately beforehand
(`Connect-Switch.ps1:37`, `Get-JunosNodeData.ps1:37`). `WebServer.ps1:156`/`:904` and
`web-src/drawer.js:29` only reference `Start-Process`/`ssh` in comments or to launch
`Connect-Switch.ps1`/`powershell.exe` itself, not `ssh.exe` directly. Every entry point that
supplies a `$Username` to a crawl/connect job (`WebServer.ps1` save endpoint, `/api/connect`,
`/api/rescan`, `/api/scan-network`, `Start-NetworkMapper.ps1`'s CLI path) also independently
gates on `[string]::IsNullOrWhiteSpace($JunosUsername)` before dispatch, so an empty/whitespace
username never even reaches the choke point. **Confirmed: no bypass exists.** `$TargetIP` is
separately regex-locked to a plain dotted-quad (`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$`) at every
web entry point, and the one non-web-validated source (`FleetCrawl.ps1`'s neighbor-IP-driven
queue expansion, `FleetCrawl.ps1:347`) is itself constrained upstream to digits-and-dots only by
the LLDP-parsing regex in `Get-JunosNodeData.ps1:357` (`\b(?:\d{1,3}\.){3}\d{1,3}\b`), so no
injection surface exists there either.

## Task 2 — regex duplication drift risk (`SshHelpers.ps1:106` vs `WebServer.ps1:739`)

Confirmed as a real (if currently benign) risk, not fixed. The two literals
(`'^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'`) are byte-for-byte identical today, but they are two
independent string literals with no shared constant/function — nothing enforces they stay in
sync. Pass 2's own ledger already flagged this exact regex as a candidate for future loosening
(realm-qualified `user@realm` logins, 64-char Junos limit vs. the current 32-char cap) and
explicitly deferred it "to the human." If that loosening is ever done at only one of the two
sites — the deployment's most likely next edit — the two outcomes are asymmetric: loosening only
`WebServer.ps1`'s copy blocks nothing new (SshHelpers.ps1's copy still rejects it at the choke
point, so the operator can save a username that then fails to connect — a usability regression,
not a security one); loosening only `SshHelpers.ps1`'s copy while leaving `WebServer.ps1`'s
alone is the dangerous direction, since it would loosen the actual command-line choke point
without the save-path guard catching it first, and doing so silently increases the injection
surface at the one function this pass's own fix designated as authoritative. Not asking for a
fix per the task instructions; flagging as confirmed drift risk.

## Findings

### P3SSH-001
- **Track**: CORE/SERVICE (INV-CREDS)
- **File:line**: `lib/SshHelpers.ps1:24-26` (`Protect-JunosTempFileAcl`'s `catch` block, the
  P2-ACL-SILENT fix), in combination with `lib/FleetCrawl.ps1:310-311` and the runspace dispatch
  sites in `lib/WebServer.ps1` (`Invoke-RescanAction:215`, `Invoke-ScanNetworkAction:501-510`)
- **Severity**: MEDIUM
- **Confidence**: HIGH
- **Claim**: P2-ACL-SILENT's fix (commit `e24f17e`) replaced `Protect-JunosTempFileAcl`'s bare
  `catch {}` with `Write-Warning "ACL hardening failed for temp file '$Path': $_"`. In the
  dominant code path — every automated crawl (`FleetCrawl.ps1`) and every web-triggered rescan
  (`/api/rescan`) or fleet scan (`/api/scan-network`) — `Get-JunosNodeData.ps1` runs inside a
  `[powershell]::Create()` runspace with no attached host, dispatched via `.AddCommand($WorkerPath)`
  / `.BeginInvoke()`. `Write-Warning` output in such a runspace is captured into
  `$PS.Streams.Warning`, not displayed anywhere, and the caller must explicitly drain that
  collection to ever see it. A repo-wide grep of `lib/FleetCrawl.ps1` and `lib/WebServer.ps1`
  shows exactly one stream ever read back from a completed job: `$Job.PS.Streams.Error`
  (`FleetCrawl.ps1:310-311`, gated on `$Job.PS.HadErrors`, which reflects only the Error stream
  count). Neither file contains the string `Warning` anywhere. `Get-JunosNodeData.ps1`'s own
  return value (`@{ Node = $NodeData; Logs = $Logs }`, drained by `FleetCrawl.ps1:317` via
  `foreach ($LogLine in $Result.Logs) { Write-DebugLogLocal $LogLine }`) also never receives this
  warning — `Protect-JunosTempFileAcl` calls `Write-Warning`, not the worker's own `Write-LogMsg`
  helper that actually populates `$Logs`. So the warning is generated, captured by the runspace,
  and then never read by anything — silently dropped in exactly the automated/background paths
  this fix was meant to make an ACL failure visible in.
- **Trigger**: An ACL-hardening failure (e.g. a non-NTFS `%TEMP%`, a locked file, a permissions
  error under `[System.IO.File]::SetAccessControl`) during any crawl/rescan/scan-network run —
  i.e. any run that isn't the interactive `Connect-Switch.ps1` single-connect path.
- **Evidence**: `grep -n "Warning" lib/WebServer.ps1 lib/FleetCrawl.ps1` returns zero matches;
  `grep -n "Streams\." lib/FleetCrawl.ps1 lib/WebServer.ps1 lib/Connect-Switch.ps1 lib/Get-JunosNodeData.ps1`
  returns only `FleetCrawl.ps1:310` (`$Job.PS.HadErrors`) and `:311` (`$Job.PS.Streams.Error`).
- **Invariant hit**: INV-CREDS (an ACL-hardening failure on a plaintext askpass/credential temp
  file is silent again, on the fleet/automated path, contradicting the fix's own stated goal in
  the Pass-2 ledger: "no logging function is even in scope ... needs a small plumbing addition,
  not a one-liner" — the landed fix was in fact only the one-liner it warned against).
- **Impact**: Same practical impact as the original P2-ACL-SILENT gap — an operator has no way to
  learn that a temp file holding a switch password in plaintext did NOT get its ACL narrowed to
  the current user, during the one class of run (unattended fleet crawl / web-triggered
  rescan/scan) where nobody is watching a console to notice a `Write-Warning` even if it were
  visible. Only the already-narrow interactive `Connect-Switch.ps1` path (attached console,
  `-NoExit`) would actually surface it.
- **Repro**: Trace-only (no live filesystem-permission-failure repro attempted, matching this
  pass's read-only mandate): (1) confirm `Protect-JunosTempFileAcl` is only called from
  `New-JunosCredentialFile`/`New-JunosAskPass` (`SshHelpers.ps1:43,60,62`); (2) confirm
  `New-JunosAskPass` runs inside the worker script executed via `[powershell]::Create()` for
  every crawl job (`FleetCrawl.ps1` dispatch at its `AddCommand($WorkerPath)` call,
  `WebServer.ps1:215` for rescan, `WebServer.ps1:501-510` for scan-network); (3) confirm no code
  path reads `.Streams.Warning` anywhere in the repo (grep above).
- **Fix sketch** (not applied, per instructions): have `Protect-JunosTempFileAcl` append to the
  same `$Logs`/`Write-LogMsg` mechanism the worker already plumbs back to the orchestrator
  (requires passing a logging delegate/list into `SshHelpers.ps1`'s functions, since they're
  dot-sourced standalone), or have the FleetCrawl/WebServer dispatch sites additionally drain and
  log `$Job.PS.Streams.Warning` alongside `.Streams.Error`.

### P3SSH-002
- **Track**: CORE (documentation/diagnostic accuracy, INV-UI-TRUTH-adjacent)
- **File:line**: `lib/Get-JunosNodeData.ps1:541-549`, comment at `544-546`; throw site
  `lib/SshHelpers.ps1:106-108`, called from `lib/Get-JunosNodeData.ps1:37` inside
  `Invoke-InteractiveBatch`, invoked at `lib/Get-JunosNodeData.ps1:116`
- **Severity**: LOW
- **Confidence**: HIGH
- **Claim**: The catch-all block's comment says "Reached only after a successful SSH session
  (ssh's own connect/auth failures are handled above, before parsing starts) - so any exception
  here is a parsing/script error, not a connectivity problem." This was true before Pass 2's
  P2-SSH-STARTUP fix. It is no longer true: `Get-JunosSshArgs`'s new validation `throw` (added at
  `SshHelpers.ps1:106-108`) fires from inside `Invoke-InteractiveBatch` (`Get-JunosNodeData.ps1:37`)
  *before* `ssh.exe`/`cmd.exe` is ever launched (`Get-JunosNodeData.ps1:38` is the next line). A
  malformed `$Username` that reaches this worker — exactly the scenario P2-SSH-STARTUP's fix was
  written to catch (e.g. a hand-edited `Configuration.json`/`.enc` bypassing `WebServer.ps1`'s
  save-time check) — throws here, is caught by the outer `catch` at line 541, and is classified
  identically to a genuine post-connection parsing bug: `ScanStatus = "Error"`,
  `ScanError = $_.ToString()`. This is a pre-connection input-validation failure, not "reached
  only after a successful SSH session."
- **Trigger**: Any crawl/rescan/connect where `$Username` fails `Get-JunosSshArgs`'s regex (e.g.
  a credential loaded straight from a manually-edited config file, bypassing the web save-path
  check).
- **Evidence**: Read of `Get-JunosNodeData.ps1:26-38` (throw site precedes any process launch)
  and `:541-549` (stale comment + generic classification), cross-referenced against `e24f17e`'s
  diff which added the throw without touching this comment or classification.
- **Invariant hit**: Not a live data-corruption/injection bug — flagged because the crawl's own
  `AuthFailureThreshold` circuit breaker (`FleetCrawl.ps1:169,437-441`, added specifically "to
  avoid a fleet-wide lockout") keys off `ScanStatus -eq "AuthFailed"` only
  (`FleetCrawl.ps1:326-333`); a validation-throw node is neither `AuthFailed` nor does it need the
  breaker (it never reaches the network, so no real lockout risk — confirmed by tracing that the
  throw precedes `Process.Start`), but the stale comment could mislead a future maintainer
  triaging generic `"Error"` nodes into assuming every one of them implies a successful
  connection, when this one class now does not.
- **Impact**: Diagnostic/maintainability only — a future debugging session reading this comment
  literally would incorrectly rule out "bad username never even got to try connecting" as an
  explanation for an `Error`-status node. No functional harm to the invariants (the crawl
  self-terminates naturally on a bad shared username since the failed seed node produces zero
  neighbors to expand the queue with, so there's no fleet-wide blast radius from this
  misclassification either).
- **Repro**: Trace-only — read `Get-JunosNodeData.ps1:21-38` (throw precedes `Process.Start` at
  line 52 inside `Invoke-InteractiveBatch`) and `:541-549` (single generic catch, stale comment).
- **Fix sketch** (not applied): either catch `Get-JunosSshArgs`'s throw specifically inside
  `Invoke-InteractiveBatch` and classify it as e.g. `ScanStatus = "InvalidCredential"`, or at
  minimum update the comment to note the new pre-connection exception source.

## Categories checked with no new finding
- **Askpass try/finally restructure** (`Get-JunosNodeData.ps1:21-28,610-611`) and the
  **Remove-JunosAskPass null-guard** (`Get-JunosNodeData.ps1:611`, `Connect-Switch.ps1:27,50`):
  re-read fresh, both correct — `$AskPass = $null` precedes the `try`, `New-JunosAskPass` runs
  inside it, `finally` guards on `if ($AskPass)` in both files, matching each other exactly.
- **Double-dispose / process leak on validation throw**: confirmed no leak — the throw fires
  before `[System.Diagnostics.Process]::Start` is ever called in either
  `Get-JunosNodeData.ps1:52` or `Connect-Switch.ps1:46`, so there is no orphaned process to clean
  up in that failure mode.
- **CLI `$SwitchIP` (`Start-NetworkMapper.ps1:4`) has no IPv4-shape validation before
  `Invoke-FleetCrawl`**, unlike every web entry point: traced but not flagged — this is a local
  operator supplying their own CLI argument to their own process on their own machine, the same
  trust boundary already established (and explicitly reasoned about) for SSH-001/002's
  CSRF/cross-principal adjudication in Pass 2; no privilege boundary is crossed.
- **Clear-StaleJunosTempFiles's bare `catch {}`** (`SshHelpers.ps1:91`): pre-existing,
  untouched by any Pass 1/2/3 fix, out of this pass's re-scan scope (best-effort age-gated sweep,
  not the P2-ACL-SILENT code path); not re-flagged here.
