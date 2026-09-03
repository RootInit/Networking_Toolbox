# Security Cross-Cut Audit — Phase 1

Scope: `lib/*.ps1`, `web-src/*.js` (excluding `web-src/vendor/`). Read-only review, no
fixes applied. Repo/threat model: localhost-only single-operator tool, real switch
credentials, no multi-tenant surface.

## Findings

### SEC-1: Plaintext SSH credential temp files written with no explicit ACL/permission restriction

- **Track**: SERVICE / CORE (credential handling, INV-CREDS)
- **File:line**: `lib/SshHelpers.ps1:14-24` (`New-JunosCredentialFile`), `lib/SshHelpers.ps1:34-45` (`New-JunosAskPass`)
- **Severity**: Medium
- **Confidence**: High
- **Claim**: `New-JunosCredentialFile` and `New-JunosAskPass` write the real Junos switch
  password in plaintext to files in `%TEMP%` (`junos_cred_*.json`, `ssh_pass_*.txt`,
  `ssh_askpass_*.bat`) via `[System.IO.File]::WriteAllText`, with no explicit ACL/DACL
  applied to the file after creation. Confidentiality of these files during their (short
  but nonzero) lifetime relies entirely on the OS default permissions of the process's
  `%TEMP%` directory.
- **Trigger**: Every `Invoke-ConnectAction` (Quick Connect from the dashboard) and every
  crawl/rescan against a Junos device via `Get-JunosNodeData.ps1`.
- **Evidence**:
  ```
  lib/SshHelpers.ps1:16-22
      $CredPath = Join-Path $env:TEMP "junos_cred_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).json"
      $Json = @{ Username = $Username; Password = $Password } | ConvertTo-Json -Compress
      [System.IO.File]::WriteAllText($CredPath, $Json)

  lib/SshHelpers.ps1:36-39
      $AskPassText = Join-Path $env:TEMP "ssh_pass_$($PID)_$([guid]::NewGuid().Guid.Substring(0,8)).txt"
      [System.IO.File]::WriteAllText($AskPassText, $Password)
  ```
  No `Set-Acl`, `icacls`, or POSIX chmod call exists anywhere in `lib/SshHelpers.ps1`,
  `lib/Get-JunosNodeData.ps1`, or `lib/Connect-Switch.ps1`.
- **Invariant hit**: INV-CREDS ("SSH credentials ... never left behind in plaintext on
  disk ... beyond the single operation's lifetime") — this doesn't violate the lifetime
  clause (cleanup is handled via `finally`/`Clear-StaleJunosTempFiles`), but it does mean
  that *during* that lifetime, and in the crash-survival window `Clear-StaleJunosTempFiles`
  itself documents (up to `-MaxAgeHours` after a hard kill), the plaintext password's
  confidentiality is only as strong as the default ACL on `%TEMP%`.
- **Impact**: On a normal single-user Windows workstation, `%TEMP%` resolves to
  `%USERPROFILE%\AppData\Local\Temp`, which already restricts access to the owning user
  plus Administrators/SYSTEM — so in the stated single-operator threat model this is
  low-impact. It becomes materially worse on a shared/multi-session host (RDS/Terminal
  Server, a shared service account, or any environment where `%TEMP%` is redirected to a
  location other than the per-user default) where another locally-authenticated principal
  could read a live switch password out of these files, or scrape a crashed run's leftovers
  before the 4-hour `Clear-StaleJunosTempFiles` sweep runs.
- **Repro**: Trigger a Quick Connect or crawl, and during the operation (or immediately
  after a forced-kill of the pwsh process before its `finally` runs), read
  `%TEMP%\junos_cred_*.json` / `%TEMP%\ssh_pass_*.txt` as any principal with access to that
  directory.
- **Fix sketch**: After writing each of these temp files, explicitly restrict its ACL to
  the current user only (e.g. `[System.IO.File]::SetAccessControl` with a DACL containing
  only the current `WindowsIdentity`, or `icacls <path> /inheritance:r /grant:r "$env:USERNAME:F"`)
  before any other process could plausibly open it. This is defense-in-depth given the
  existing cleanup discipline is otherwise solid.

---

### SEC-2: `window.onerror` fatal-error handler renders error text via `innerHTML`, not `textContent`

- **Track**: USER-FACING (XSS defense-in-depth)
- **File:line**: `web-src/app.js:16-28`
- **Severity**: Low (currently believed unreachable with attacker-controlled content; flagged as a latent sink)
- **Confidence**: Medium
- **Claim**: The global `window.onerror` handler builds `errText` by string-interpolating
  the raw `message`, `source`, `lineno`, `colno`, and `error.stack` values from *any*
  uncaught JS exception, and assigns it to `textEl.innerHTML` unescaped:
  ```js
  var errText = `Message: ${message}<br>Line: ${lineno}:${colno}<br>Source: ${source}<br>Stack: ${error ? error.stack : 'N/A'}`;
  ...
  textEl.innerHTML = errText;
  ```
  This is the only unescaped `innerHTML` sink found in the whole frontend sweep — every
  other `innerHTML` assignment in `app.js`, `drawer.js`, `map.js`, `graph.js`, `search.js`,
  `elk-layout.js` either passes content through the shared `esc()` helper or is a static
  string literal (elk-layout.js's own comment at line 97 explicitly calls out avoiding this
  exact pattern for `err.message`).
- **Trigger**: Any uncaught JS exception (`window.onerror`, not a caught `try/catch`)
  reaches this handler.
- **Evidence**: Traced all call sites that could plausibly throw an Error containing
  device-controlled or file-controlled text (`web-src/topology-crypto.js:44,47,51` —
  envelope `kdf`/`cipher`/`macAlgorithm`/`iterations` fields, which are attacker-shapeable
  by crafting a `.json`/`.json.enc` topology file). All three call sites
  (`app.js:288`, `app.js:349`, `map.js:148`) wrap `decryptEnvelope()` in a local
  `try/catch` and route the message through `promptForPassword()`, which uses
  `errEl.textContent` (`app.js:124`), not `innerHTML` — so this specific path is caught
  before reaching `window.onerror`. No other current code path was found that throws an
  Error embedding untrusted (device/file-supplied) text and lets it go uncaught.
- **Invariant hit**: None of the six named invariants directly; general defense-in-depth /
  XSS-sink hygiene.
- **Impact**: Not exploitable via any path found in this pass. However, it's a standing
  landmine: any future code that throws `new Error(...)` embedding untrusted text (a
  hostname, LLDP description, config diff line, filename) without going through a local
  `catch`, will render live HTML/script in the fatal-error modal the instant it's uncaught
  — a single missed `try/catch` in future work becomes DOM XSS with no further review
  needed. `source` (script URL) and `stack` are also attacker-influenceable if a future
  change ever surfaces a URL or filename an operator doesn't fully control (e.g. opening a
  maliciously-named topology file).
- **Repro**: Not currently reproducible end-to-end (no found path reaches it uncaught with
  attacker content) — a proof would require adding a `throw new Error(deviceHostname)`
  without a wrapping try/catch and then loading a snapshot with
  `Hostname: "<img src=x onerror=alert(1)>"`. Worth noting explicitly: `window.onerror`
  does not fire for unhandled Promise rejections at all, and essentially every path in this
  app that touches untrusted data (`readSnapshotFile`, `decryptEnvelope`,
  `processSelectedFiles`) is `async`/Promise-based — a rejection inside one of those, if it
  ever escaped its wrapping `try/catch`, would become an unhandled rejection, not reach
  `window.onerror` at all, and would need a separate `window.onunhandledrejection` handler
  (none exists) to surface anywhere. That makes today's "unreachable" verdict stronger, not
  just "not found yet" — this sink is currently reachable only by a *synchronous* uncaught
  throw, and no such path with untrusted content was found.
- **Fix sketch**: Build the `<br>`-separated lines via `textEl.textContent` + CSS
  `white-space: pre-line`, or construct the four lines as separate text nodes, instead of
  `innerHTML`. Trivial, zero functional change to the rendered layout.

---

### SEC-3: `cmd.exe /c` shell string for the Junos batch SSH process depends entirely on an upstream regex to stay injection-free

- **Track**: SERVICE / CORE (INV-CMDPATH)
- **File:line**: `lib/Get-JunosNodeData.ps1:35`, `lib/SshHelpers.ps1:84`, `lib/Get-JunosNodeData.ps1:354`
- **Severity**: Informational (not currently exploitable; noted for defense-in-depth / regression risk)
- **Confidence**: High
- **Claim**: `Invoke-InteractiveBatch` builds the ssh.exe invocation as a **raw shell
  command line** passed to `cmd.exe /c`:
  ```
  $ProcInfo = New-Object System.Diagnostics.ProcessStartInfo("cmd.exe", "/c ssh.exe $($SshArgs -join ' ') > `"$TempOut`" 2> `"$TempErr`"")
  ```
  `$SshArgs` includes `"$Username@$TargetIP"` (`SshHelpers.ps1:84`), where `$TargetIP` can
  originate from **LLDP-neighbor-reported management addresses** discovered during a crawl
  (`lib/FleetCrawl.ps1:321-330`, `$NIP = $Neigh.ManagementIP`) — i.e., data a rogue/
  compromised device on the network can influence via its LLDP management-address TLV. The
  only thing preventing shell-metacharacter injection into this `cmd.exe /c` string is
  that `Get-JunosNodeData.ps1:354` extracts `ManagementIP` with a strict digit/dot regex
  (`\b(?:\d{1,3}\.){3}\d{1,3}\b`), and `Invoke-RescanAction`/`Invoke-ConnectAction` in
  `lib/WebServer.ps1` validate any browser-supplied IP the same way
  (`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$`). Both regexes admit only digits and dots — no
  shell metacharacters can currently reach this string.
- **Trigger**: N/A today — this is a "the guard rail is doing all the work" observation,
  not a live bug.
- **Evidence**: See file:line references above; traced the full data flow from
  `Neigh.ManagementIP` parse regex through `FleetCrawl.ps1` enqueue, through
  `Get-JunosNodeData.ps1 -TargetIP`, through `Get-JunosSshArgs`, into the `cmd.exe /c`
  string.
- **Invariant hit**: INV-CMDPATH (commands reaching real switches must not be
  injectable/misrouted) — currently satisfied, but by a single point-of-failure regex
  rather than by the process-invocation design itself.
- **Impact**: None today. If either validating regex is ever loosened (e.g., to accept
  IPv6, hostnames, or a wider LLDP management-address format) without someone remembering
  this file builds a literal shell command line, it becomes a command-injection path
  triggered by a hostile device's LLDP advertisement, executed as the operator on their own
  machine — a genuine INV-CMDPATH breach with a network-reachable trigger, not just a
  local one.
- **Repro**: N/A (regex currently closes the path).
- **Fix sketch**: Use `ProcessStartInfo.ArgumentList` (or `-Command` with an argument
  array) instead of interpolating into a `cmd.exe /c "..."` string, so redirection/
  metacharacters in any future-loosened input can't be reinterpreted by the shell. Lower
  priority than SEC-1/SEC-2 since no live bug exists, but worth closing before the input
  format ever changes.

---

## Categories checked with no surviving finding

- **Path traversal on static file serving**: `Invoke-StaticFile`
  (`lib/WebServer.ps1:742-763`) resolves the request path with
  `[System.IO.Path]::GetFullPath((Join-Path $RootFull $RelPath))` and then requires
  `$FullPath.StartsWith($RootFull, OrdinalIgnoreCase)` before ever touching disk, with
  `$RootFull` given a trailing directory separator first specifically so this is a
  path-*segment* prefix match, not a naive string prefix match (the code's own comment at
  line 752-754 calls out the `Network_Visualizer` vs `Network_Visualizer_old` bypass this
  avoids). `../` sequences, absolute paths, and drive-letter/UNC requests all get resolved
  by `GetFullPath` before the containment check, so none of them escape `$VisualizerRoot`.
  The single-file-bundle server (`Invoke-SingleFileVisualizer`, lines 769-777) is even
  narrower — it serves only `/` and `/Network_Visualizer.html` by exact match, nothing
  path-derived at all. No traversal bug found in either handler.
- **Browser-side secret persistence**: grepped every `localStorage`/`sessionStorage` call
  in `web-src/*.js` (excluding vendor) — the only persisted values are UI state (right-panel
  width, dark-mode toggle, device/alarm history for the dashboard trend view). The
  master encryption password (from `/api/session-password`) and the Junos SSH credentials
  (`getLoadedCredentials`/`setLoadedCredentials`, `web-src/map.js:175-181`) are held only in
  plain in-memory module variables (`loadedCredentials`, session-password promise cache) —
  never written to `localStorage`/`sessionStorage`, so they don't persist past a page
  reload/tab close and aren't readable from disk via the browser profile.
- **`.gitignore` coverage for real credentials/topology data**: `Configuration.json` and
  `Configuration.json.enc` are explicitly gitignored (`.gitignore:5-6` in the parent
  `Networking_Toolbox/` repo), with a comment noting -NoEncryption mode's plaintext
  `Configuration.json` carries "the same sensitivity" as the `.enc` form — confirmed via
  `git check-ignore -v Configuration.json`. `Network_Maps/NetworkMap_*.json(.enc)` is
  globally ignored too; the three tracked exceptions
  (`NetworkMap_2026-08-13_091500.json`, `NetworkMap_2026-08-20_143207.json{,.enc}`) are
  explicitly whitelisted with a comment explaining they're intentional demo/sample
  snapshots for the multi-snapshot/diff feature. Spot-checked
  `NetworkMap_2026-08-13_091500.json`'s content: hostnames (`CORE-SW-01.local`,
  `DIST-SW-01.local`), serials (`SYN10000011`), and addressing (`10.55.x.x`) all read as
  synthetic/generated fixture data, not a real captured network — consistent with the
  `.gitignore` comment's claim. No accidental real-credential or real-topology leak into
  git history found.
- **HTTP server binding**: `lib/WebServer.ps1:815-816` binds `HttpListener` to
  `http://localhost:$Port/` only (not `+`/`*`/a LAN IP) — not reachable from the network.
- **CSRF-style same-origin check**: `Test-SameOriginRequest` (`lib/WebServer.ps1:116-124`)
  is applied to every state-changing endpoint *and* to the two read-only endpoints that
  hand back sensitive data (`/api/session-password`, `/api/snapshots`, `/api/config`) —
  verified against the full dispatch table at `lib/WebServer.ps1:908-993`; no sensitive
  endpoint is missing the gate. Already-documented residual gap (a hostile process running
  as a *different* OS user on the same machine can forge `Origin`) is out of the localhost/
  single-operator threat model and is called out honestly in the code's own comment
  (`WebServer.ps1:114-115`).
- **Secrets in logs**: grepped every `Write-MapperDebugLog` / `Write-DebugLogLocal` call
  site and `Get-JunosNodeData.ps1`'s `Write-LogMsg` call sites — none interpolate
  `$Password`/`$JunosPassword`/credential-file contents. Passwords are handed to ssh via a
  file (`SSH_ASKPASS`) or PowerShell `-AddParameter`, never via a logged command line.
- **Secrets in URL query strings**: only `jobId` (a GUID) appears in any query string
  (`lib/WebServer.ps1:932,946`); the session/encryption password and Junos credentials
  travel only in JSON request/response bodies.
- **Secrets in error messages returned to client**: reviewed every `Send-WebJson ... error
  = "... $_"` site in `WebServer.ps1` — exceptions surfaced are process-launch/serialization
  failures, not credential-bearing.
- **Injection sweep** (`Invoke-Expression`, `iex`, `eval(`, `Invoke-Command`, unescaped
  `-join`-into-shell): none of the first four found anywhere in `lib/`/`web-src/` outside
  `vendor/`. The one `-join`-into-a-process-string hit is SEC-3 above, and it's currently
  neutralized by upstream validation, not absent.
- **XSS sweep** (`innerHTML`): every assignment across `app.js`, `drawer.js`, `map.js`,
  `graph.js`, `search.js`, `elk-layout.js` passes untrusted content through the shared
  `esc()` helper except the one gap at SEC-2, which is not currently reachable with
  untrusted content.
- **Hardcoded credentials**: grepped for `password =`, `apikey =`, `secret =` literals
  across `lib/`/`web-src/` — only hit is a test fixture password
  (`web-src/test/topology-crypto.test.mjs:5`), not a real credential.
- **Vendored dependency version** (for the human to check against a CVE database — not
  guessed here): `web-src/vendor/leaflet/leaflet.js` header identifies itself as
  **Leaflet 1.9.4** (`/* @preserve\n * Leaflet 1.9.4 ... (c) 2010-2023 Vladimir Agafonkin`).
  Please cross-check 1.9.4 against the CVE database directly — not verified as
  vulnerable/non-vulnerable by this pass.
- **File permissions on `Network_Maps` files**: `Protect-MapperFile.ps1:94,123` and
  `WebServer.ps1:705,718` write topology/config files via `Out-File` with no explicit ACL —
  same default-permissions posture as SEC-1, but since these files are always the
  *encrypted* envelope (ciphertext, not plaintext credentials), a weaker OS-default ACL is
  lower-consequence here than for the plaintext credential temp files in SEC-1, so this
  wasn't raised as a separate finding.

## Notes for other tracks

- SEC-1 and SEC-3 both touch `lib/SshHelpers.ps1`/`lib/Get-JunosNodeData.ps1`, which the
  ledger says is also in scope for the SSH/crawl-internals track — flagging in case of
  overlap so findings aren't duplicated/contradicted.
