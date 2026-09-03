# Pass 3 — Fresh-Look Findings (second independent look, files with zero fix-commits)

Scope: web-src/graph.js, web-src/graph-layout.js, web-src/elk-layout.js, web-src/persistence.js,
web-src/config-resolve.js, web-src/search.js, web-src/topology-crypto.js, lib/TopologyCrypto.ps1,
lib/Connect-Switch.ps1, Start-NetworkMapper.ps1, Configuration.example.json,
web-src/tools/generate-fixture.mjs.

Read `web-src/test/*.mjs` first (graph-layout.test.mjs, elk-layout.test.mjs, topology-graph.test.mjs,
config-resolve.test.mjs, topology-crypto.test.mjs exist; no persistence.test.mjs or search.test.mjs).
Re-derived findings independently rather than re-confirming the parallel fresh-look agent's report.

---

## P3FRESH-001

- **Track**: CORE / SERVICE (command-and-control path, INV-CMDPATH)
- **File:line**: `lib/SshHelpers.ps1:99-116` (`Get-JunosSshArgs`), reached via `Start-NetworkMapper.ps1:161-165` (`-SwitchIP` CLI parameter → `Invoke-FleetCrawl -StartIP $SwitchIP`) and `lib/Get-JunosNodeData.ps1:37-38`
- **Severity**: MEDIUM (defense-in-depth gap at the documented choke point; see reachability note below for why this is not filed HIGH)
- **Confidence**: High on the code trace; the severity is deliberately conservative — no cross-principal trigger was found for this specific path (see below), unlike P2-SSH-STARTUP's username case

**Claim:** `Get-JunosSshArgs` — the single choke-point Pass 2 deliberately restructured so
every SSH-invoking caller in the repo funnels through one validation point (per its own
comment at SshHelpers.ps1:101-105, and per `AUDIT_LEDGER.md`'s P2-SSH-STARTUP fix group)
— validates `$Username` (line 106) but never validates `$TargetIP` at all. The final
returned argument is the unvalidated, raw-interpolated string `"$Username@$TargetIP"`
(line 115). Pass 2 closed the injection surface for a hostile *username* reaching this
function unvalidated (the startup-config-load / CLI-crawl paths); the exact same class of
gap exists today for a hostile *TargetIP* reaching the same function, and it was never
touched by any Pass 1 or Pass 2 fix.

**Trigger / reachability:**
- `Start-NetworkMapper.ps1`'s `-SwitchIP` parameter (line 1-4, `[string]$SwitchIP`, no
  format constraint at all) is passed straight through to `Invoke-FleetCrawl -StartIP
  $SwitchIP` (line 161), which enqueues it unvalidated (`FleetCrawl.ps1:156-157`,
  `$Queue.Enqueue($StartIP)`), and the crawl worker eventually calls
  `Get-JunosNodeData.ps1 -TargetIP $NextIP` for it (`FleetCrawl.ps1:242`).
- `Get-JunosNodeData.ps1:37-38` builds: `$SshArgs = Get-JunosSshArgs -Username $Username
  -TargetIP $TargetIP` then `New-Object System.Diagnostics.ProcessStartInfo("cmd.exe", "/c
  ssh.exe $($SshArgs -join ' ') > "$TempOut" 2> "$TempErr"")` — i.e. `$TargetIP` lands
  inside a **cmd.exe-interpreted** command line (worse than the already-fixed
  username case, which only went through raw `ProcessStartInfo` argv splitting, not a
  shell). A `-SwitchIP` value containing `&`, `|`, `>`, or a closing quote followed by
  shell syntax reaches `cmd.exe /c` verbatim.
- Contrast with every browser-triggered path: `WebServer.ps1`'s `Invoke-ConnectAction`
  (line 145), `Invoke-RescanAction` (line 184), `Invoke-PingAction`-family (line 245), and
  `Invoke-ScanNetworkAction` (line 491) **all** regex-lock their `TargetIP`/`startIp` to
  `^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$` before it ever reaches `Get-JunosSshArgs` — so the
  gap is specifically the CLI entry point, exactly mirroring how P2-SSH-STARTUP found the
  startup-config-load path bypassing the web save-endpoint's username check.
- LLDP-discovered neighbor IPs (the crawl's normal expansion path) are not exploitable the
  same way: `Get-JunosNodeData.ps1:357` extracts `ManagementIP` via a regex anchored to
  `(?:\d{1,3}\.){3}\d{1,3}` (digits/dots only), so a malicious/misbehaving neighbor device
  can't inject shell metacharacters through that specific field. The live, unvalidated
  path is the CLI `-SwitchIP` seed value only.

**Repro:** `pwsh -File Start-NetworkMapper.ps1 -SwitchIP '10.0.0.1" & calc.exe & "'`
(Windows) reaches `Get-JunosSshArgs -TargetIP '10.0.0.1" & calc.exe & "'` with no
rejection, and that string is later embedded in the `cmd.exe /c ssh.exe ...` command line
built at `Get-JunosNodeData.ps1:38`.

**Invariant hit:** INV-CMDPATH ("no injection, truncation, or silent misrouting").

**Severity reasoning (deliberately conservative):** Unlike P2-SSH-STARTUP's username case
— where the unvalidated value genuinely crossed a trust boundary in-repo (it came off
disk from `Configuration.json.enc`, itself writable via the CSRF-reachable
`/api/save-config` web endpoint, a different principal than whoever launches
`Start-NetworkMapper.ps1`) — the only unvalidated-`TargetIP` path found here is
`-SwitchIP`, typed directly by the operator at their own console. That operator already
has arbitrary code execution as themselves; self-injection via one's own CLI argument is
not a privilege-escalation trigger, and no evidence of a wrapper/scheduled-task/automation
layer forwarding untrusted input into `-SwitchIP` was found in this repo (checked: no
such caller exists in-tree). This is the same shape Pass 1 used to correctly **reject**
WS-1 ("no live trigger for the claimed abort") — so this finding is filed at MEDIUM, not
HIGH, on reachability grounds, even though the code-level gap (the function that
documents itself as *the* single validation choke point validates only one of its two
interpolated parameters) is real and worth closing as defense-in-depth: a future caller of
`Get-JunosSshArgs` (e.g. a REST-driven bulk-seed feature, or any code path added later
that doesn't happen to pre-validate its `TargetIP` the way today's four `WebServer.ps1`
endpoints do) would inherit this gap silently, since the function's own doc comment
promises validation happens here.

**Fix sketch:** Add the same `^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$` (or equivalent
`[System.Net.IPAddress]::TryParse`) check to `Get-JunosSshArgs` itself, right alongside
the existing username check — it is the documented single choke point, so this closes
every current and future caller at once, matching the reasoning that motivated the
Username check's placement there in Pass 2.

---

## P3FRESH-004

- **Track**: CORE (INV-CMDPATH — "no ... silent misrouting to the wrong device/IP")
- **File:line**: `Start-NetworkMapper.ps1:6` (`-AllowedScopes` parameter/default), consumed by `lib/FleetCrawl.ps1:350`
- **Severity**: MEDIUM
- **Confidence**: High

**Claim:** `-AllowedScopes` is documented (both in `Start-NetworkMapper.ps1`'s own default
and in the top-level `README.md:47`, "IP prefixes the crawl is allowed to follow — keeps
it from wandering off the intended network") as a prefix-based scope guard, but the match
against it is a raw string `StartsWith`, not a dot/octet-boundary-aware prefix match:

```
lib/FleetCrawl.ps1:350
foreach ($Scope in $AllowedScopes) { if ($NIP.StartsWith($Scope)) { $InScope = $true; break } }
```

The shipped default, `"131.30."`, happens to end on a dot boundary, which masks the
issue for the out-of-the-box case. But nothing in `Start-NetworkMapper.ps1`'s parameter
declaration (`[string[]]$AllowedScopes = @("131.30.")`, plain string array, no format
validation) or in `FleetCrawl.ps1`'s consumption of it enforces that an operator-supplied
override also ends on a dot boundary. `-AllowedScopes "10.1"` (a plausible typo for
`"10.1."`, or a deliberate but under-specified value) admits `10.1.x.x` **and**
`10.10.x.x`–`10.19.x.x` — a 16x silent over-match of the "intended network" scope this
parameter exists specifically to bound, for an unattended SSH crawl against real
production switches. Neither the README nor the parameter's own help text warns that the
match is a bare substring-prefix rather than a subnet/octet boundary.

**Trigger:** `Start-NetworkMapper.ps1 -SwitchIP <seed> -AllowedScopes "10.1"` against a
fleet where `10.1.0.0/16` is the intended scope but `10.10.0.0/16`-`10.19.0.0/16` also
exist and are reachable via LLDP-neighbor chaining from the seed switch — the crawl
silently follows into all of them, attempting SSH against every discovered device in
range, with no warning that the scope match was broader than the operator likely intended.
This does not require a hostile input — a plain operator typo omitting the trailing dot is
enough, unlike P3FRESH-001 above which needed an adversarial value.

**Invariant hit:** INV-CMDPATH ("no silent misrouting to the wrong device/IP" — the crawl
targeting an unintended device is exactly this class of failure, driven by a parameter
whose entire purpose is to prevent it).

**Fix sketch:** Either require each scope string to end with `.` (validate at parse time
in `Start-NetworkMapper.ps1` and reject/warn otherwise), or switch the match to a real
octet-boundary check (e.g. split both sides on `.` and compare whole-octet prefixes, or
accept CIDR notation and use proper subnet containment) in `FleetCrawl.ps1:350`. A cheap
first step: document the substring-match semantics explicitly in the parameter's
`HelpMessage` and README so an operator supplying a custom scope knows to include the
trailing dot.

---

## P3FRESH-002 (informational / not independently filed as a new bug)

- **Track**: DATA
- **File**: `lib/TopologyCrypto.ps1`, `web-src/topology-crypto.js`
- **Severity**: N/A — no finding
- **Confidence**: High

Re-derived the crypto correctness review from scratch (KDF params, IV/salt handling, MAC
verification order, error-message specificity, timing):
- PBKDF2-SHA256, 600,000 iterations (OWASP-current), 64-byte output split 0-31/32-63
  identically on both sides (`Get-TopologyKeyMaterial` vs `deriveKeyMaterial`) — confirmed
  by direct line comparison, not just re-reading Pass 1's claim.
- IV: fresh `Aes.GenerateIV()` per `Protect-TopologyPayload` call (PS side is the only
  encrypt path) — never reused across ciphertexts.
- Salt: generated fresh per encryption operation at each of its three call sites
  (`Start-NetworkMapper.ps1:129-131`, `WebServer.ps1:750-752`, `Protect-MapperFile.ps1:150-152`)
  via `RandomNumberGenerator`. `Start-NetworkMapper.ps1` derives one salt/key pair once at
  startup and reuses it for every topology snapshot written during that server session —
  this is intentional (avoids re-running 600k PBKDF2 iterations per scan) and is not a
  weakness for CBC as long as the IV varies per message, which it does.
- MAC verified before decrypt (encrypt-then-MAC, verify-then-decrypt) on both sides,
  closing the padding-oracle class of issue.
- Both sides collapse every failure mode (bad format, bad version, bad KDF/cipher/MAC
  name, out-of-range iterations, corrupt base64, wrong password, tampered MAC) into the
  single message "Incorrect password, or the file is corrupted." — no information leak
  distinguishing "wrong password" from "corrupted file" from "tampered ciphertext."
- Iteration-count bounds (1000-5,000,000) match exactly between PS (`$IterCheck -lt 1000
  -or $IterCheck -gt 5000000`) and JS (`MIN_ITERATIONS`/`MAX_ITERATIONS`).
- MAC comparison: PS side is byte-by-byte with early `break` (not constant-time), JS side
  uses `crypto.subtle.verify` (WebCrypto HMAC verify, effectively constant-time in
  practice). This was already flagged and explicitly accepted in Pass 1
  (`TopologyCrypto.ps1:154-155`'s own comment: "not constant-time - acceptable given this
  app's threat model") — re-verified the reasoning still holds (localhost-only server,
  single local operator, no network-observable timing channel) rather than re-filing it.

No new cryptographic-correctness bug found in either file. This matches the "no issues
found, genuinely" case for this pair — the extensive Pass 1 atomicity-focused review did
not, on this fresh pass, turn out to have overlooked the actual cipher/KDF/MAC mechanics.

---

## P3FRESH-003 (informational / not independently filed as a new bug)

- **Track**: CORE
- **File**: `lib/Connect-Switch.ps1`
- **Severity**: N/A — no finding
- **Confidence**: High

Re-verified the "reference pattern" claim skeptically rather than trusting the label:
- `New-JunosAskPass` (line 35) and the credential file read (line 33) both sit inside the
  `try` block (lines 28-47); `Remove-JunosAskPass`/`Remove-JunosCredentialFile` both run
  unconditionally in `finally` (lines 48-52), correctly null-guarded (`if ($AskPass)`) for
  the case where the throw happened before `New-JunosAskPass` ran. This genuinely does
  match the pattern Pass 2 restored to `Get-JunosNodeData.ps1` (P2FRESH-001) — the claim
  holds.
- Checked the one other candidate gap: `$TargetIP` here is **not validated inside this
  script** either (same absence as `Get-JunosSshArgs`, see P3FRESH-001) — but every caller
  that invokes `Connect-Switch.ps1` is `WebServer.ps1`'s `Invoke-ConnectAction`, which
  regex-validates `TargetIP` before launching this script (`WebServer.ps1:145`), so this
  file has no live unvalidated-TargetIP path of its own; it inherits P3FRESH-001's gap
  only if something other than `Invoke-ConnectAction` is ever added as a caller. Not filed
  as a separate finding — the actual exploitable gap is `Get-JunosSshArgs` itself
  (P3FRESH-001), not this file.
- `$Process.WaitForExit()` (line 47) blocks with no timeout, but this is a genuinely
  interactive user-attended SSH session launched by explicit operator action ("Launch SSH
  Session" button) — an indefinitely open interactive shell is the intended behavior, not
  a hang.

No new bug found in this file beyond the (correctly-scoped-elsewhere) TargetIP gap.

---

## Files checked, no findings (with justification)

- **web-src/graph.js**: `refreshNodeVisual`'s inline VLAN-cache computation
  (`device.TrueClients ? asArray(...).map(c => String(c.VLAN_Tag)) : []`) was compared
  line-by-line against `topology-graph.js`'s `computeVlanCache` (the path `buildSwitchMap`
  uses) since a single-device-rescan path recomputing cache differently from the full
  rebuild is a classic divergence bug shape — they are identical in behavior (no
  filter/dedup either way), so no divergence exists. `isStack` computation
  (`StackMembers.length > 1`) is likewise identical between `refreshNodeVisual` and
  `computeDeviceClassification`, including the "single-member StackMembers arrives as a
  bare object, not an array" PowerShell-serialization edge case both handle the same way
  (bare object has no numeric `.length`, so both correctly resolve `isStack: false`).
- **web-src/graph-layout.js / elk-layout.js**: heavily self-documented with edge-case
  reasoning already worked through in comments (deadline budget, Jacobi vs Gauss-Seidel
  ordering, angle-bucket caching soundness, disconnected-island handling via
  `extraRoots`). Traced the "pure cycle with no reachable root" degenerate case
  (a subgraph where every node has an incoming edge) — not reachable in practice because
  `visibleEdges`/`childrenOf` passed into `elk-layout.js` are always `buildPrimaryTree`'s
  output, which is constructed via BFS spanning-tree growth (`growTreeFrom`) and therefore
  cannot contain a cycle disconnected from every root. No fresh bug found.
- **web-src/persistence.js**: `updateAlarmHistory`'s reboot detection correctly treats
  `device.Uptime` as an opaque boot-timestamp string (string inequality, `prevUptime &&
  device.Uptime !== prevUptime`), consistent with the already-established
  not-a-bug finding that `Uptime` is a fixed boot timestamp, not an elapsed duration.
  `updateDeviceHistory`'s `firstSeen`/`lastSeen` date comparisons (`<` vs `>=`) are
  internally consistent (ties always resolve to "more recent wins" for `lastSeen`, "at
  least as old wins" for `firstSeen`, no gap or double-count). All `localStorage` access
  is wrapped in try/catch with a sane empty-state fallback (private browsing / storage
  disabled). No test file exists for this module (confirmed via `ls web-src/test/`), so
  this was read as true fresh territory, not a re-confirmation of prior coverage.
- **web-src/config-resolve.js**: `extractDeviceKeys`/`resolveDeviceLocation`/
  `bestKeyForSave`'s serial > hostname > IP fallback tiering is symmetric between the
  lookup side (`resolveDeviceLocation`) and the save side (`bestKeyForSave`) — a location
  saved under a device's serial will always be found again under the same tier next scan,
  since both functions derive `keys` from the identical `extractDeviceKeys`. No divergence
  found between the two directions.
- **web-src/search.js**: `goToSearchResultGeneration` guard correctly re-checked after
  every `await` point (`setActiveSnapshot`, `renderVisibleGraph`) so a superseded older
  click cannot clobber a newer one's drawer/selection state. `performGlobalSearch`'s dedup
  key (`snapshotIndex|deviceIp|field|value`) correctly keeps identical values from two
  different snapshots as separate rows per its own comment. No test file exists for this
  module either; read fresh, no bug found.
- **Configuration.example.json**: static example/documentation file; `keyType: "serial"`
  matches `config-resolve.js`'s expected `serial`/`hostname`/`ip` enum. No behavior to
  audit.
- **web-src/tools/generate-fixture.mjs**: explicitly a manual dev-only fixture generator
  ("Not part of the app - run manually"), not reachable from any production code path;
  uses a `Clients` field name that the real app doesn't read (`TrueClients` is what
  `graph.js`/`persistence.js`/`search.js` actually consume) — cosmetic inaccuracy in a
  throwaway test-data generator, not a shippable-code bug, not filed.

## Files with one finding above (justification for not filing more)

- **lib/TopologyCrypto.ps1 / web-src/topology-crypto.js**: see P3FRESH-002 — genuinely
  re-derived, no bug.
- **lib/Connect-Switch.ps1**: see P3FRESH-003 — genuinely re-derived, the "reference
  pattern" claim holds; the one real gap here (`TargetIP`) is filed against its actual
  root cause (P3FRESH-001, `Get-JunosSshArgs`), not duplicated here.
- **Start-NetworkMapper.ps1**: `-AllowedScopes`'s *semantics* (bare-prefix `StartsWith`,
  no octet-boundary enforcement) is a new, separately-filed finding — see **P3FRESH-004**
  above; this is distinct from CFG-001 (already confirmed/fixed in Pass 1), which was
  about the silent *drop* of out-of-scope neighbors with no logging, not the match
  semantics itself. `-NoEncryption`'s implications (plaintext topology + plaintext
  `Configuration.json`, distinct filename from the encrypted variant so the two modes
  never collide) are internally consistent and clearly commented as an intentional
  tradeoff (lines 10-13, 34-36). Specifically traced the asymmetry between the two
  config-load branches (encrypted branch nulls `$EncryptionPassword` on a failed decrypt,
  with a comment explaining `Invoke-SaveConfigAction` refuses to save when it's empty,
  lines 108-110; the plaintext branch at lines 65-67 has no equivalent guard on a parse
  failure) to see whether it's a live INV-DATA/INV-NO-LOCKOUT gap (a malformed
  `Configuration.json` silently overwritten by a subsequent browser save, destroying
  hand-entered device lat/lng/building/room data) — traced the front-end save path
  (`persistence.js:96`, `window.saveSettingsPanel` → `window.ensureConfigLoaded()`,
  and independently `map.js:606`, `window.saveConfiguration` → its own
  `ensureConfigLoaded()` check) and found **both** save entry points already refuse to
  write if the config load failed, regardless of what `Start-NetworkMapper.ps1` did at
  startup. The encrypted branch's guard exists to solve a problem specific to passwords
  (re-encrypting under an unverified password would relock every future session); no
  equivalent password-confusion risk exists in `-NoEncryption` mode, so the asymmetry is
  intentional, not an oversight, and the actual write-time safety net lives in the
  browser save path (already correct) rather than needing a mirror guard here. No finding
  filed for this.
  The one live gap found in this file's responsibility chain is **P3FRESH-001**
  (`-SwitchIP` reaching `Get-JunosSshArgs` unvalidated) — filed against `Get-JunosSshArgs`
  (the actual choke point) rather than here, per the "single fix, one location" preference
  the ledger itself uses for `FleetCrawl.ps1`'s participation in CFG-001.
