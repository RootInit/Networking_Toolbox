# Pass 2 findings — untouched-by-Pass-1-fixes scope

Scope per dispatch: lib/Connect-Switch.ps1, lib/Get-JunosNodeData.ps1 (full re-read),
lib/Update-OuiDatabase.ps1, Start-NetworkMapper.ps1, web-src/search.js,
web-src/config-resolve.js, web-src/persistence.js, web-src/elk-layout.js,
web-src/graph-layout.js. Read-only pass, no fixes applied.

---

## P2FRESH-001

- **Track**: CORE/SERVICE (INV-CREDS)
- **File:line**: `lib/Get-JunosNodeData.ps1:21` (call site) vs. its own `:25` (try) /
  `:607-609` (finally); compare `lib/SshHelpers.ps1:53-66` (`New-JunosAskPass`) and the
  correctly-guarded sibling call in `lib/Connect-Switch.ps1:28-35`.
- **Severity**: HIGH
- **Confidence**: High (code-trace confirmed; the failure mode is explicitly anticipated
  and guarded against in the sibling script, proving it's a known real risk class, not a
  theoretical one)
- **Claim**: `Get-JunosNodeData.ps1` calls `New-JunosAskPass -Password $Password` at
  line 21, *before* its own `try` block begins at line 25 (whose `finally` at
  line 607-609 is the only code that removes the askpass files). If
  `New-JunosAskPass` throws after writing the first of its two plaintext files but
  before returning, the plaintext switch password is left on disk with **no cleanup
  path at all** for this script invocation.
- **Trigger**: Inside `New-JunosAskPass` (`SshHelpers.ps1:53-66`):
  ```
  [System.IO.File]::WriteAllText($AskPassText, $Password)   # writes plaintext password
  Protect-JunosTempFileAcl -Path $AskPassText                # best-effort, swallows errors
  [System.IO.File]::WriteAllText($AskPassPath, "@type `"$AskPassText`"")  # can throw here
  Protect-JunosTempFileAcl -Path $AskPassPath
  return [PSCustomObject]@{...}
  ```
  If the *second* `WriteAllText` throws (disk full, `%TEMP%` quota hit, AV lock,
  permission change, network-temp-dir drop — all plausible on a long-running fleet
  crawl invoking this once per switch), the function throws. Since the call at
  `Get-JunosNodeData.ps1:21` is outside any try/finally, the exception propagates
  straight out of the whole script. The `$AskPassText` file (real plaintext switch
  password) was already written and is now orphaned — `$AskPass` was never assigned,
  so the script's own `finally { Remove-JunosAskPass -AskPassContext $AskPass }`
  (line 608) is never reached in the first place (the throw happens before `try` is
  even entered).
- **Evidence**:
  - `Get-JunosNodeData.ps1:23-24` (the script's own comment) claims: *"Everything below
    runs inside a try/finally so the plaintext askpass files (containing the real
    switch password) are always removed, even on error or exit."* This is false for the
    `New-JunosAskPass` call itself, which sits one line above that comment, outside the
    guarded region.
  - `Connect-Switch.ps1:24-26` shows the correct pattern was known and deliberately
    applied in the sibling script: *"Everything that touches the credential file lives
    inside the try, so the finally always runs cleanup even if e.g. New-JunosAskPass
    fails partway (%TEMP% full/locked), which would otherwise leave the plaintext
    credential on disk with nothing to remove it."* — and indeed, in
    `Connect-Switch.ps1`, `$AskPass = New-JunosAskPass -Password $CredData.Password` is
    at line 35, *inside* the try that starts at line 28. `Get-JunosNodeData.ps1` is the
    one script where this same call was left outside the equivalent boundary — a
    copy-paste/refactor divergence between two near-identical files.
  - `WebServer.ps1:430-432`'s own comment repeats the same (here, false) assumption:
    *"New-JunosAskPass writes the switch password to a plaintext %TEMP% file cleaned up
    only by the worker's own finally block"* — i.e. the rest of the codebase's reasoning
    about cleanup guarantees for this exact code path is built on the same wrong
    premise.
  - No `catch` anywhere between `Get-JunosNodeData.ps1:21` and the top of the script, so
    nothing else could clean this up either.
- **Invariant hit**: INV-CREDS ("SSH credentials ... are never left behind in plaintext
  on disk ... beyond the single operation's lifetime, and never logged").
- **Impact**: `Get-JunosNodeData.ps1` is the crawl worker invoked once per switch during
  every fleet crawl (`FleetCrawl.ps1`) and every single ad-hoc rescan
  (`WebServer.ps1`'s `Invoke-RescanAction`) — far higher exposure than
  `Connect-Switch.ps1`'s one-off interactive-connect path, which got the fix. On
  trigger, the real switch password sits in a `%TEMP%\ssh_pass_*.txt` file (readable
  only by the current user thanks to `Protect-JunosTempFileAcl`, which *did* succeed on
  that first file before the second write failed) with nothing removing it — until
  `Clear-StaleJunosTempFiles`'s age-gated sweep (only called from `FleetCrawl.ps1:35` at
  the *start* of the *next* crawl, default `MaxAgeHours = 4`) eventually deletes it.
  That is a multi-hour plaintext-credential exposure window on a machine an operator may
  share, not "the single operation's lifetime" the invariant requires. If crawls are run
  infrequently (e.g. weekly), the exposure window is proportionally longer.
- **Repro**: Deterministic code trace (no live device needed):
  1. Make the second `[System.IO.File]::WriteAllText($AskPassPath, ...)` call in
     `SshHelpers.ps1:59` throw — e.g. temporarily fill/lock `%TEMP%`, or (for a quick
     local repro) monkey-patch/mock `WriteAllText` to throw on its second invocation
     within a test harness.
  2. Invoke `Get-JunosNodeData.ps1` with any `-TargetIP/-Username/-Password`.
  3. Observe: the script throws uncaught at line 21; `%TEMP%\ssh_pass_<pid>_<guid>.txt`
     (containing the plaintext password passed in) exists on disk afterward; no code
     path in this invocation removes it.
- **Fix sketch**: Move `$AskPass = New-JunosAskPass -Password $Password` inside the
  `try` block (i.e. make it the first statement after `try {` on line 25), exactly
  matching the pattern already used in `Connect-Switch.ps1:28-35`. The existing
  `finally { Remove-JunosAskPass -AskPassContext $AskPass }` requires no change since
  `Remove-JunosAskPass`/`Remove-Item -ErrorAction SilentlyContinue` already tolerates a
  partially-written pair of files (it just needs `$AskPass` — or a null-guarded
  best-effort cleanup of both candidate paths — to be reachable from the finally in the
  partial-failure case).

---

## P2FRESH-002

- **Track**: CORE (build/asset integrity — same failure class as the already-fixed
  CRYPTO-001)
- **File:line**: `lib/Update-OuiDatabase.ps1:51`
- **Severity**: MEDIUM
- **Confidence**: High (direct code read; same pattern Pass 1 already confirmed and
  fixed elsewhere in this repo)
- **Claim**: `Update-OuiDatabase.ps1` writes its output with a single in-place
  `Set-Content -Path $OutputPath ...` (no temp-file + rename), so a crash/kill/disk-full
  partway through the write truncates or corrupts the *existing* `oui-data.js` in place
  — the exact defect Pass 1 found and fixed in `Protect-MapperFile.ps1` (CRYPTO-001,
  HIGH), which this script was not audited against in Pass 1 (Pass 1's risk ranking
  filed it under "everything else," category 7, lowest priority, and CFG-004 separately
  flagged it as having *zero* test coverage of any kind).
- **Trigger**: Any interruption of the `Set-Content` call at line 51 — process killed,
  machine sleeps/loses power, `%TEMP%`/target disk fills up mid-write, antivirus lock —
  after the file handle has been opened and truncated but before all bytes are flushed.
- **Evidence**:
  ```
  Set-Content -Path $OutputPath -Value ($Header + $JsBody) -Encoding utf8 -NoNewline
  ```
  `Set-Content` opens `$OutputPath` (an *existing* 1.4MB file per `ls -la
  web-src/vendor/`), truncates it, then writes the new content — there is no
  write-to-`.tmp`-then-`Move-Item` step, unlike the already-hardened pattern in
  `Protect-MapperFile.ps1` (post-CRYPTO-001 fix) and `FleetCrawl.ps1`'s own snapshot
  writes (per `AUDIT_LEDGER.md`'s note that `FleetCrawl.ps1` already used this safer
  pattern even before Pass 1).
- **Invariant hit**: Not one of the six named invariants verbatim (those are scoped to
  `Network_Maps`/SSH/jobs/UI/lockout), but it is the identical failure shape as
  INV-DATA's concern applied to a different persisted artifact this repo depends on:
  `web-src/vendor/oui-data.js` is loaded as a classic `<script>` tag by the live
  visualizer (per this file's own header comment) and is also the exact asset
  `web-src/tools/build-inline.mjs` inlines into the single-file
  `lib/Network_Visualizer.html` release artifact (CFG-002's file). A truncated/corrupted
  `oui-data.js` is not just "vendor lookups degrade" — it's a JS syntax error in a
  `<script>` block that can break the *entire* inlined visualizer bundle it's built
  into, not merely OUI lookups within it.
- **Impact**: Lower likelihood than CRYPTO-001 (this script is run manually,
  occasionally, per its own header comment — "kept separate... re-run occasionally" —
  not automatically on every crawl), but the blast radius on trigger is arguably worse:
  a corrupted `oui-data.js` is a byte-for-byte JS asset, and unlike
  `Network_Maps/*.enc` (which fails a clean, recoverable decrypt-error check on
  load — INV-NO-LOCKOUT holds there), a truncated JS file can produce a raw
  `SyntaxError` at `<script>` parse time, which — depending on where the truncation
  lands relative to `window.OUI_DATABASE = {...};` — can take down the whole page's
  script execution, not just OUI lookups. The file is tracked in git
  (`git log` shows one prior commit, `823acb1`), so the damage is recoverable via
  `git checkout`, but the script itself gives the operator no indication anything went
  wrong (no error, exit code 0) if the crash happens after `Set-Content` starts — they'd
  only discover it when the visualizer breaks.
- **Repro**: Interrupt the process between opening `$OutputPath` for write and the write
  completing — e.g. run the script and `kill -9` the `pwsh` process a few hundred
  milliseconds after `Write-Host "Fetching..."` prints (the ~1.4MB write is not
  instantaneous), or fill the destination volume to just under the ~1.4MB needed right
  before running it. Confirm `web-src/vendor/oui-data.js` is left shorter than before
  and/or lacking its trailing `;`.
- **Fix sketch**: Same pattern as CRYPTO-001's fix: write to `"$OutputPath.tmp"` via
  `Set-Content`/`[IO.File]::WriteAllText`, then `Move-Item -Path
  "$OutputPath.tmp" -Destination $OutputPath -Force` (which is atomic on the same
  volume) so a crash mid-write leaves the original file untouched and only orphans a
  `.tmp` file.

---

## Files checked with no findings surviving self-review

- **`lib/Connect-Switch.ps1`**: Re-read in full. The one thing worth flagging elsewhere
  (`New-JunosAskPass` cleanup boundary) is actually the one place this script gets it
  *right* — see P2FRESH-001, which is about the sibling `Get-JunosNodeData.ps1`
  diverging from this correct pattern. `ProcessStartInfo`'s `Arguments` is built from
  `Get-JunosSshArgs`, whose only variable components (`$Username`, `$TargetIP`) are both
  regex-validated upstream in `WebServer.ps1` (IPv4 dotted-quad shape for `$TargetIP` at
  every call site; the SSH-001/002-fix alphanumeric regex for `$Username` at
  config-save time) before ever reaching this script, so no new injection surface here.
  No other bug found on a fresh pass.
- **`lib/Get-JunosNodeData.ps1`**: Full re-read beyond the SSH-001/002 lines. The
  CLI-output parsing is unusually well-commented about its own known edge cases (VC
  member `$Matches` clobbering already guarded at line 202, AE/LACP uplink leak already
  guarded, VC interconnect-port leak already guarded, VLAN routing-instance ambiguity
  already guarded with a documented degrade-to-"Unknown" behavior, MAC-table
  incumbent-preference already guarded). One regex worth a second look but not written
  up as a finding for lack of a confirmed real-world trigger: the DOT1X line-parser at
  line 322 (`"(?<interface>\S+)\s+(?:Authenticator)?\s+(?<state>...)"`) requires two
  consecutive `\s+` groups when the optional "Authenticator" token is absent, i.e.
  effectively demands 2+ whitespace characters between the interface and state columns
  in that case — plausible given Junos CLI tables are typically multi-space-padded, but
  not confirmed against a real "show dot1x interface" sample, so this is noted for
  awareness rather than claimed as a finding.
- **`lib/Update-OuiDatabase.ps1`**: Error-handling trace requested by the dispatch was
  done end-to-end: network failure (caught, rethrown with context), non-2xx HTTP
  response (`Invoke-WebRequest` throws by default on 4xx/5xx in both PS 5.1 and pwsh,
  caught by the same catch), zero-entries-parsed (explicit throw), and
  fewer-than-expected entries from a truncated download (explicit threshold-guarded
  throw at `<10000`, with a comment explaining exactly why a naive "count > 0" check
  isn't sufficient). All of that is solid. The one real gap found is the non-atomic
  write, written up as P2FRESH-002.
- **`Start-NetworkMapper.ps1`**: Full re-read. Password-retry loop (3 attempts, correct
  bound), encryption-vs-plaintext branching (no cross-contamination between
  `Configuration.json` and `Configuration.json.enc` — the ledger's out-of-band
  "no migration code" finding already confirmed this), and the guarded blank-out of
  `$EncryptionPassword` on failed decrypt (so a subsequent save can't silently succeed
  encrypting with a password the operator never re-confirmed) are all correct. No new
  finding.
- **`web-src/search.js`**: Re-read in full, including the `goToSearchResultGeneration`
  race guard for overlapping search-result clicks. The generation checks bracket every
  `await` point correctly (JS's single-threaded run-to-completion semantics mean the
  synchronous work between checks can't be preempted by a second click), so a stale
  in-flight navigation genuinely can't clobber a newer one. No finding.
- **`web-src/config-resolve.js`**: Re-read in full (55 lines, pure logic, dual
  Node/browser export). `extractDeviceKeys` takes the *last* matching
  Standalone/Master stack member if more than one exists in `StackMembers`, but real
  Junos data only produces one such entry per device (a VC has exactly one Master; a
  standalone chassis-hardware fallback produces exactly one "Standalone" entry) per the
  producer code in `Get-JunosNodeData.ps1`, so this isn't a live bug. No finding.
- **`web-src/persistence.js`**: Re-read in full. `updateAlarmHistory`'s
  `device.Uptime`-as-boot-timestamp comparison is consistent with the confirmed prior
  finding (memory: "Uptime field is a boot timestamp, not a duration") — the
  reboot-detection equality/inequality check here is the same correct pattern.
  `lastUptimeSeen` is deliberately scoped per-call (commented trade-off, not a bug).
  `try/catch` around every `localStorage` read/write correctly degrades to an empty
  history rather than throwing in private-browsing/storage-disabled contexts. No
  finding.
- **`web-src/elk-layout.js`**: Re-read in full against the existing test file
  (`elk-layout.test.mjs`, which already exercises: grid-fallback placement/no-overlap/
  empty-input, the multi-root disconnected-island offset logic including a
  deliberately-larger second component, and the catch-path fallback via a forced
  `computeRecursiveRadialLayout` throw). The error-modal DOM update
  (`textEl.innerHTML = '<static safe string>'` followed by `appendChild` of a
  `textContent`-only node for `err.message`) is genuinely XSS-safe as commented — traced
  it specifically since the pattern *looks* like an innerHTML/textContent mismatch bug
  at a glance, but the static and dynamic parts are correctly separated. No finding.
- **`web-src/graph-layout.js`**: Re-read the whole radial-layout algorithm (535 lines).
  The two most subtle pieces — `reachToward`'s angle-bucketed memoization (correctness
  argument: cached value is Lipschitz-bounded and padded by
  `extent(nodeId) * angularSlop`, so the cache can only under-claim reach, never
  over-claim it, which is the safe direction for a spacing/collision computation) and
  `relaxRadii`'s Jacobi-style (not Gauss-Seidel) update order (explicitly commented as
  fixing a real order-dependence bug found empirically) — both check out on a fresh
  trace. `computeChildAngles`'s `total > 0` guard against `NaN` for an all-zero-extent
  child set is real but explicitly noted as unreachable via the UI (`minRadius` floored
  at 20) and only exercised directly by tests. No finding.
