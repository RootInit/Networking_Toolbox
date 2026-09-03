# Phase 1 Audit Findings — Config/Build/Test-Quality Track (CFG-)

Scope: Configuration.example.json, Start-NetworkMapper.ps1, lib/Update-OuiDatabase.ps1,
web-src/tools/build-inline.mjs, web-src/tools/generate-fixture.mjs, web-src/test/*.mjs,
and repo README/docs (none at PS_NetworkMapper root; a top-level README.md exists one
directory up, at the Networking_Toolbox repo root, documenting both tools — checked for
drift against current code, see "Categories checked, no finding" below).

Baseline re-confirmed by actually running it (not assumed):
```
$ cd web-src && node --test 2>&1 | tail -8
ℹ tests 80
ℹ suites 0
ℹ pass 80
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
Regenerating `lib/Network_Visualizer.html` via `node web-src/tools/build-inline.mjs`
produces a byte-identical file to the committed one (`git diff --stat` empty after
rebuild) — the checked-in single-file build is currently reproducible and not stale.

---

## CFG-001

**Track:** CORE / DATA (crawl completeness)
**File:line:** `Start-NetworkMapper.ps1:6` (default), corroborated by `lib/FleetCrawl.ps1:320-331`
**Severity:** Medium
**Confidence:** High

**Claim:** `-AllowedScopes` defaults to a single hardcoded, organization-specific prefix
(`@("131.30.")`), and any LLDP neighbor IP that doesn't match one of the configured
scope prefixes is silently dropped from the crawl queue — no log line (not even to the
debug log), no console warning, no field in the resulting topology recording that a
neighbor was seen but excluded.

**Scope note:** the hardcoded default itself lives in `Start-NetworkMapper.ps1:6`, this
track's assigned file. The silent-drop *mechanism* it feeds lives in
`lib/FleetCrawl.ps1`, which the ledger's risk ranking assigns to a different pass
(#4 in AUDIT_LEDGER.md's ranking, SSH/command-and-control track) — cited here only as
corroborating evidence for why the default's absence of a companion warning matters;
that other track should not independently re-file the FleetCrawl.ps1 half of this as a
new finding, and this track is not claiming ownership of FleetCrawl.ps1's broader
error-handling beyond this one loop.

**Trigger:** Run `Start-NetworkMapper.ps1 -SwitchIP <seed>` against any fleet whose
management IPs don't start with `131.30.` and without passing `-AllowedScopes`.

**Evidence:**
- `Start-NetworkMapper.ps1:6`: `[string[]]$AllowedScopes = @("131.30.")`
- `lib/FleetCrawl.ps1:318-327`:
  ```
  foreach ($Neigh in $Node.Neighbors) {
      $NIP = $Neigh.ManagementIP
      if ([string]::IsNullOrEmpty($NIP)) { continue }
      $InScope = $false
      foreach ($Scope in $AllowedScopes) { if ($NIP.StartsWith($Scope)) { $InScope = $true; break } }
      if ($InScope -and !$Visited.Contains($NIP) -and !$Enqueued.Contains($NIP)) {
          $Queue.Enqueue($NIP)
          $Enqueued.Add($NIP) | Out-Null
          Write-DebugLogLocal "ENQUEUED: $NIP"
      }
  }
  ```
  There is no `else` branch and no `Write-DebugLogLocal`/`Write-Host` call for the
  `-not $InScope` case anywhere in this loop or elsewhere in FleetCrawl.ps1 (grepped
  `InScope`/`scope` across FleetCrawl.ps1, WebServer.ps1, and web-src/*.js — the only
  hits are the two lines above and unrelated JS lexical-scope comments).

**Invariant hit:** INV-UI-TRUTH (adjacent) — not a display-truth bug per se, but the
resulting topology silently under-represents the real network with nothing to indicate
why, which is the data-completeness analogue of that invariant for a network-inventory
tool.

**Impact:** A first-time deployer running this against a network whose management IPs
don't happen to start with `131.30.` gets a crawl that silently stops at the seed
device (or its immediate same-scope neighbors) with no error, no partial-crawl warning,
and no record anywhere of which neighbor IPs were seen-but-excluded. The resulting map
looks like a complete, successful crawl of a small network rather than a truncated
crawl of a larger one — the worst failure mode for an inventory/audit tool. The README
does document the flag and its default, so an attentive reader is protected, but
nothing in the tool itself catches an unattended/scripted run, and even a user who did
set `-AllowedScopes` correctly has no visibility if they got a prefix slightly wrong
(e.g. missed a secondary subnet) — every excluded neighbor vanishes without a trace.

**Repro:**
1. `cd lib && pwsh -Command '. ./FleetCrawl.ps1'` (or read the loop above directly).
2. Confirm no output path exists for the `-not $InScope` branch: `grep -n "InScope" lib/FleetCrawl.ps1` shows only the two lines quoted.
3. Confirm the hardcoded default: `grep -n AllowedScopes Start-NetworkMapper.ps1` → `@("131.30.")`.

**Fix sketch:** Add an `else { Write-DebugLogLocal "SKIPPED (out of AllowedScopes): $NIP seen as neighbor of $($Job.IP)" }` branch, and surface a count of scope-excluded neighbor IPs in the crawl's final summary (console + the object returned to the browser via `Invoke-ScanNetworkAction`), so an incomplete crawl is visibly distinguishable from a genuinely small network.

---

## CFG-002

**Track:** SERVICE (build/release integrity)
**File:line:** `web-src/tools/build-inline.mjs:71-88` (`inlineLocalFile`), `:113-119` (final summary/exit)
**Severity:** Medium
**Confidence:** High (empirically reproduced)

**Claim:** `build-inline.mjs` exits with status 0 even when a *required* script (not
just the intentionally-optional `vendor/oui-data.js`) fails to inline because its
`src=` path is wrong or the file is missing — it logs a "Skipped N missing file(s)"
line to stdout but never sets a non-zero exit code, so any CI/automation that gates on
exit status (or a human skimming a longer build log) will not notice the release
artifact is broken.

**Trigger:** Rename/typo any required script's filename referenced by `index.html`
(e.g. `graph-layout.js`, the layout engine app.js depends on) and run
`node web-src/tools/build-inline.mjs`.

**Evidence (reproduced live):**
```
$ cd web-src
$ cp index.html index-test.html
$ sed -i 's/graph-layout\.js/graph-layout-TYPOED.js/' index-test.html
$ node tools/build-inline.mjs index-test.html; echo "EXIT CODE: $?"
Inlined 17 file(s) into .../lib/Network_Visualizer.html
Skipped 1 missing file(s) (tag dropped, same as a 404'd src/href today): graph-layout-TYPOED.js
EXIT CODE: 0
```
(cleanup performed: `index-test.html` removed, `node tools/build-inline.mjs` re-run
with no args to regenerate the real `lib/Network_Visualizer.html`; `git diff --stat`
on that file is empty, confirming the repo was left exactly as found.)

The code path: `inlineLocalFile()` (`build-inline.mjs:74-85`) treats every missing
local file identically — pushes to `skipped[]` and returns `''` (tag dropped) — with a
comment explaining this is deliberate *only* for `oui-data.js`'s known-optional case,
but the mechanism applies uniformly to any src, required or not. `process.exit()` is
never called with a non-zero code anywhere in the file.

**Invariant hit:** None of the six named invariants directly, but this is exactly the
"silent-success-on-failure" build-script failure mode the audit brief calls out.

**Impact:** `lib/Network_Visualizer.html` is the artifact a release ships (per its own
header comment: "a release ships only Start-NetworkMapper.ps1 + lib/... never
web-src/"). A broken inline (missing script) produces a `Network_Visualizer.html` that
loads in a browser with no console-visible build-time error, then fails at runtime with
a JS `ReferenceError`/`undefined is not a function` far from the actual cause, and any
automated "did the build succeed" check (`node tools/build-inline.mjs && git commit ...`
style) would proceed to commit a broken visualizer.

**Repro:** See the exact commands above — fully reproducible, no environment
dependencies beyond Node.

**Fix sketch:** Track a separate `requiredSkipped` list (everything except the one
file already known-optional, `vendor/oui-data.js`) and `process.exit(1)` with a loud
error if it's non-empty, distinct from the informational log for the one file that's
allowed to be absent.

---

## CFG-003

**Track:** DATA (test-quality / coverage gap on the encrypted-file read path)
**File:line:** `web-src/test/topology-crypto.test.mjs` (whole file), validating
`web-src/topology-crypto.js:43-52`
**Severity:** Medium
**Confidence:** High

**Claim:** `topology-crypto.test.mjs` never exercises the envelope-metadata validation
branches at `topology-crypto.js:43-52` — `version !== 1`, `kdf`/`cipher`/`macAlgorithm`
mismatch, and the `iterations` type/range check (`Number.isInteger` + `MIN_ITERATIONS`/
`MAX_ITERATIONS` bounds). Every test in the file builds envelopes with the one
fixed-valid combination (`version: 1, kdf: 'PBKDF2-SHA256', cipher: 'AES-256-CBC',
macAlgorithm: 'HMAC-SHA256'`, `iterations: 1000`) and only varies `format`, the
password, or corrupts `ciphertext`/removes `salt` — none of which reach the
version/kdf/cipher/macAlgorithm/iterations code path at all (that code runs and
returns normally *before* any of the exercised branches).

**Evidence:** `grep -n "iterations\|version\|kdf\|cipher\|macAlgorithm"
web-src/test/topology-crypto.test.mjs` shows these identifiers only inside the shared
`buildEnvelope()` helper (always constructing the one valid combination) — no test
sets `envelope.version` to something other than `1`, no test sets a non-`PBKDF2-SHA256`
`kdf` / non-`AES-256-CBC` `cipher` / non-`HMAC-SHA256` `macAlgorithm`, and no test sets
`envelope.iterations` to a non-integer, a string, `0`, or a value above
`MAX_ITERATIONS`.

This is specifically the validation the most recent debugging-pass commit
(`c531285`, "Tighten PBKDF2 envelope validation: catch iteration-count overflow before
it throws a raw exception, and make format/kdf/cipher/macAlgorithm/version comparisons
case-sensitive and type-strict to match the browser side instead of silently accepting
what it would reject") explicitly reworked. Checked the actual diff via
`git show c531285 -- web-src/topology-crypto.js web-src/test/topology-crypto.test.mjs
lib/TopologyCrypto.ps1`: the commit touches **only**
`lib/TopologyCrypto.ps1` (+22/-4) — switching `-ne`/`-notcontains` to case-sensitive
`-cne`/`-cnotcontains` and adding explicit numeric-type checks so the PowerShell side
matches what the JS side (`topology-crypto.js:43-52`) was *already* doing. Neither
`web-src/topology-crypto.js` nor `web-src/test/topology-crypto.test.mjs` appears in
that diff at all — meaning the JS-side validation this PS fix was written to match
predates all three recent debugging-pass commits and has *never* had a test written
against it, through three separate audit/fix passes that each touched this exact file
pair. (Separately confirmed via `git show 1c3fae9 -- web-src/test/topology-crypto.test.mjs`
that the three corruption/missing-field tests that *do* exist were added in the same
commit as the PS/JS "normalize malformed-envelope decrypt failures" fix they cover —
a same-commit test-matches-fix pattern that's a legitimate, if weaker, form of
coverage for that specific behavior, but doesn't extend to the
version/kdf/cipher/macAlgorithm/iterations-range branches, which no commit's test
diff ever touched.)

**Invariant hit:** INV-DATA (encrypt(PS)/decrypt(JS) round-trip contract) and
INV-NO-LOCKOUT — a regression in this exact validation (e.g. accepting an
out-of-range `iterations` and hanging/crashing on `deriveBits`, or accepting a
mismatched `kdf` and silently producing garbage plaintext instead of a clean error)
would not be caught by the existing suite.

**Impact:** Low likelihood of near-term regression given the code was just hardened,
but zero regression coverage on a security-relevant parsing path that a prior pass
found needed hardening once already.

**Repro:** Read `web-src/test/topology-crypto.test.mjs` in full (95 lines) — every
`test(...)` block is visible above; none constructs an envelope with the metadata
fields perturbed.

**Fix sketch:** Add tests asserting `decryptEnvelope` rejects: `version: 2`, a
lowercase/mismatched `kdf`/`cipher`/`macAlgorithm` string, `iterations: "1000"` (string,
not number), `iterations: 0.5` (non-integer), `iterations: 999` (just under
`MIN_ITERATIONS`), and `iterations: 5000001` (just over `MAX_ITERATIONS`) — mirroring
the granularity already used for the ciphertext/salt corruption tests in the same file.

---

## CFG-004

**Track:** CORE (coverage gap, not a functional bug)
**File:line:** `Start-NetworkMapper.ps1` (all 169 lines), `lib/Update-OuiDatabase.ps1` (all 54 lines)
**Severity:** Low
**Confidence:** High

**Claim:** Neither the entry point (`Start-NetworkMapper.ps1`) nor the OUI database
updater (`lib/Update-OuiDatabase.ps1`) has any automated test coverage — there is no
Pester (or any other PowerShell test framework) suite anywhere in the repository, only
the Node `web-src/test/*.mjs` suite, which cannot reach PowerShell code at all. This
was already flagged as a baseline fact in AUDIT_LEDGER.md ("No PowerShell test suite
exists"); this entry names the two specific files in this track's scope for the record
and notes what's untested in each:
- `Start-NetworkMapper.ps1`: the encryption-password retry loop (3-attempt decrypt,
  "Continue without credentials?" prompt), the `-NoEncryption` plaintext-config read
  path, and the crawl-vs-server-only branch selection are all unexercised by anything
  automated.
- `lib/Update-OuiDatabase.ps1`: the regex line-parser, the zero-entries and
  under-10,000-entries fail-safe thresholds, and the output-file write are all
  unexercised; this script's core parsing logic (`^(?<prefix>[A-Fa-f0-9]{6})\s*\(base
  16\)\s*(?<vendor>.+)$`) was manually reviewed for this audit against a real
  `oui.txt` line format and appears correct, but nothing regression-protects it.

**Invariant hit:** None directly — this is a coverage-gap finding, not a live bug.
Included per the audit brief's explicit instruction to list untested public
functions/modules in scope.

**Impact:** Any future change to either script (e.g. adjusting the retry count, the
threshold constants, or the regex) has no automated safety net; only the two scoped
files without any test harness at all in the whole repo happen to be entry-point-class
code (the thing every user runs first) and the one script with outbound internet
egress (explicitly called out in its own header comment as the one part of the app
that needs it) — both proportionally higher-value places for at least smoke coverage
than most of the already-tested `web-src/*.js` modules.

**Repro:** Both actually run (not assumed):
```
$ find . -iname "*.tests.ps1" -o -iname "*Tests.ps1"
(no output)
$ pwsh -NoProfile -Command 'Get-Module -ListAvailable Pester'
(no output - Pester is not installed/available in this environment)
```

**Fix sketch:** Not urgent enough to require Pester adoption on its own, but at minimum
`Update-OuiDatabase.ps1`'s regex/threshold logic could be extracted into a small
pure function and given Node-side or even manual test coverage alongside the existing
`web-src/test/` suite's spirit, since it has no PowerShell-specific dependencies beyond
the initial `Invoke-WebRequest` call.

---

## CFG-005

**Track:** USER-FACING (test-quality — under-asserting test on a claimed-deterministic function)
**File:line:** `web-src/test/graph-layout.test.mjs:56-69` (`'computeGraphRoot prefers the largest component over a smaller-eccentricity isolated node'`)
**Severity:** Low
**Confidence:** High (empirically reproduced against the real implementation)

**Claim:** The test's final assertion, `assert.ok(['c3', 'c4'].includes(root))`, accepts
either of two answers for a 6-node chain plus one isolated node — but the actual,
current implementation is deterministic and always returns `'c3'`, never `'c4'`, for
this exact input. The test is strictly weaker than the real behavior it's checking,
so it cannot catch a regression that flips the tie-break direction (e.g. a `<`
accidentally changed to `<=` in the comparison at `graph-layout.js:74-79`) as long as
the flipped version still lands on one of the two center nodes.

**Trigger:** N/A (this is a test-quality finding, not a runtime trigger) — demonstrated
by running the real function against the test's exact fixture.

**Evidence (reproduced live):**
```
$ cd web-src && node -e '
import("./graph-layout.js").then(m => {
  const nodeIds = ["c1","c2","c3","c4","c5","c6","isolated"];
  const edges = [
    { from: "c1", to: "c2" }, { from: "c2", to: "c3" }, { from: "c3", to: "c4" },
    { from: "c4", to: "c5" }, { from: "c5", to: "c6" },
  ];
  console.log("root:", m.computeGraphRoot(nodeIds, edges));
});'
root: c3
```
Traced why: `computeGraphRoot` (`graph-layout.js:58-82`) iterates `sortedIds` (the
node IDs sorted ascending via `compareIpIds`, which falls back to plain lexical string
comparison for non-dotted-quad IDs like `'c1'..'c6'` — see `compareIpIds` at
`graph-layout.js:6-17`) and only replaces `bestId` on a **strict** eccentricity
improvement (`eccentricity < bestEccentricity`, line 75). Since `'c3'` sorts before
`'c4'` lexically, `'c3'` is visited first, sets `bestEccentricity = 3`, and `'c4'`'s
later equal eccentricity of `3` fails the strict `<` check and is not swapped in. This
is exactly the same lowest-ID tie-break contract the adjacent test two blocks above
(`'computeGraphRoot breaks eccentricity ties by lowest IP'`, line 48) is written to
assert precisely — but that assertion style isn't carried through to this test.

The same test file treats determinism as independently load-bearing elsewhere (line
424, `'computeRecursiveRadialLayout produces identical output across repeated runs on
the same input (deterministic)'`), which is what makes the loose `.includes()` here
inconsistent with the suite's own stated standard, not just generically weak.

**Invariant hit:** None of the six named invariants directly — this is a coverage/
assertion-strength gap in the graph-root heuristic that INV-UI-TRUTH-adjacent behavior
(which switch renders as the diagram's center) depends on.

**Impact:** Low — the underlying behavior is correct today and the gap is narrow (only
masks a tie-break-direction regression, not a wrong-root regression generally, since
`computeGraphRoot`'s other tests already cover non-tied cases). Worth tightening
because it's cheap to fix and the suite's own convention (line 424) suggests the author
considers this exact property meaningful.

**Repro:** See the reproduced command above — fully reproducible, no environment
dependencies beyond Node and the checked-in `graph-layout.js`.

**Fix sketch:** Change the assertion to `assert.equal(root, 'c3')`, matching the
already-established lowest-ID-tie-break pattern used by the nearby test at line 48-54.

---

## CFG-006

**Track:** USER-FACING (coverage gap — untested fallback/safety-net path)
**File:line:** `web-src/test/elk-layout.test.mjs` (whole file, 4 tests), validating `web-src/elk-layout.js:89-108` (the `try`/`catch` in `computeLayout`)
**Severity:** Low
**Confidence:** High

**Claim:** None of `elk-layout.test.mjs`'s 4 tests exercise `computeLayout`'s
`catch` branch (`elk-layout.js:91-108`) — the path that falls back to
`computeGridFallback` and (in a browser) shows the "Layout engine failed" modal when
the underlying layout throws or the outer 9-second timeout race fires. `elk-layout.js`'s
own header comment calls `computeGridFallback` "the last-resort safety net if the
layout throws or times out," making this the one path whose entire job is to keep the
app usable when everything else has already gone wrong — exactly the kind of path
worth protecting with a direct test, and exactly the kind most likely to silently bit-rot
since it's never hit in normal operation.

The existing coverage only reaches the *throw* half, one layer down: a separate test in
`graph-layout.test.mjs:614-620` confirms `computeRecursiveRadialLayout` itself throws
once `opts.deadline` is in the past. That test calls `computeRecursiveRadialLayout`
directly, not `computeLayout`, so it never reaches `elk-layout.js`'s own `try`/`catch`,
`console.error` call, or `computeGridFallback` return value.

**Evidence:** Read the full file (all 80 lines, 4 `test(...)` blocks) directly, not by
grep: `computeGridFallback` places every node (direct call, no `computeLayout`
involved), `computeGridFallback` never collides (direct call), `computeGridFallback`
handles zero nodes (direct call), and one `computeLayout` test — the disconnected-
island-offset regression test — which completes normally (no thrown error, no deadline
pressure, `visibleEdges` all well-formed) and only exercises the `doLayout()` success
path inside the `try`. None of the four constructs an input that makes `doLayout()`
reject or that pushes `Date.now()` past the effective `deadline`, so `computeLayout`'s
`catch` block is never entered by any test in the file.

Cross-checked the target line range against the actual file contents
(`web-src/elk-layout.js`, read in full for this audit): `try` opens at line 89,
`catch (err)` at line 91, the `computeGridFallback(visibleNodeIds)` fallback return at
line 105, and the `finally { clearTimeout(timeoutId); }` cleanup at lines 106-108 —
confirming the `elk-layout.js:89-108` citation matches the real span of the
untested branch.

**Invariant hit:** None of the six named invariants directly — a regression here (e.g.
the fallback modal wiring breaking, or `computeGridFallback` itself throwing when
called with malformed input from the catch site) would degrade gracefully into a worse
failure (blank screen instead of a grid) rather than corrupt data, but this is
precisely the kind of rendering-availability path INV-UI-TRUTH's spirit (the app must
show *something* truthful, not nothing) cares about.

**Impact:** Low likelihood of near-term regression, but this was the exact
subsystem `1c3fae9` reworked (+43 lines to `elk-layout.js`, per that commit's stat) —
the file most recently touched by a bug-fix pass in this track's scope is the one
whose safety-net path has zero direct coverage.

**Repro:** Read `web-src/test/elk-layout.test.mjs` in full — no test constructs a
scenario where `computeLayout`'s internal `doLayout()` promise rejects or the deadline
race timer fires.

**Fix sketch:** Add a test that calls `computeLayout` with `layoutSettings` producing
an already-past effective deadline (mirroring the `graph-layout.test.mjs:614` throw
test, but through the `computeLayout` entry point) and asserts the returned positions
match what `computeGridFallback` would produce for the same `visibleNodeIds` — proving
the catch branch actually reaches and returns the fallback rather than merely trusting
that it does because the one layer down throws correctly.

---

## Categories checked, no finding

- **Configuration.example.json vs actual consumers:** Cross-checked every settings key
  (`cpuWarnPct`, `cpuCriticalPct`, `memWarnPct`, `memCriticalPct`, `crawlAgeFreshMin`,
  `crawlAgeStaleMin`, `recentRebootMin`, `clusterThreshold`, `nodeSpacing`,
  `leafSpacing`, `minRadius`) against `web-src/persistence.js`'s `DEFAULT_SETTINGS` —
  values match exactly, no drift.
- **build-inline.mjs reproducibility:** Regenerating `lib/Network_Visualizer.html` from
  current `web-src/` sources produces a byte-identical file to what's committed
  (`git diff --stat` empty) — the checked-in build is current, not stale, and the
  build is otherwise deterministic (verified by direct re-run, not assumed).
- **generate-fixture.mjs:** Manually traced the ID/IP-generation math
  (`distributionCount=6`, `accessPerDistribution=80` → max node id 486 →
  `ip(486)` = `10.90.1.237`, well within valid octet range) — no off-by-one or
  overflow found; this is a manual dev tool with no test harness expected or present
  elsewhere in the app for similar tools.
- **Update-OuiDatabase.ps1 fail-safe thresholds:** The zero-entries and
  under-10,000-entries checks both `throw` *before* `Set-Content`, so a failed/partial
  fetch cannot overwrite a good `oui-data.js` — correctly ordered, no finding.
- **`Join-Path` with backslash-separated `ChildPath` on Linux:** Suspected a real bug
  (backslashes aren't path separators on Linux) in `Update-OuiDatabase.ps1`'s
  `-OutputPath` default (`Join-Path $PSScriptRoot "..\web-src\vendor\oui-data.js"`);
  empirically tested against real `pwsh` on this machine — PowerShell 7's `Join-Path`
  normalizes backslashes correctly cross-platform, confirmed by writing an actual file
  and inspecting the resulting path with `find`. Not a bug.
- **README/docs drift:** No README exists at `PS_NetworkMapper/` root (confirmed via
  `find . -maxdepth 1 -iname "*.md" -o -iname "README*"` → only `AUDIT_LEDGER.md`,
  added for this audit). The top-level `Networking_Toolbox/README.md` (one directory
  up) documents `PS_NetworkMapper` and was checked for drift: parameter table matches
  `Start-NetworkMapper.ps1`'s actual param block and defaults (`-AllowedScopes` default
  `131.30.`, `-WebPort` default `8787`, `-NoEncryption` behavior, `-Log` behavior) —
  no mismatch found.
- **Configuration.example.json as a security artifact:** Contains an obvious
  placeholder credential (`"example-user"`/`"example-password"`) and placeholder device
  location — confirmed via grep that no code path in `Start-NetworkMapper.ps1` or
  `lib/*.ps1` ever reads `Configuration.example.json` automatically (it is
  documentation only, never auto-copied to `Configuration.json`), so this is not a
  live default-credential risk.
- **build-inline.mjs quoting/injection:** Pure Node `fs`/regex string handling, no
  shell invocation anywhere in the file — "unquoted variable" shell-injection concerns
  from the review checklist don't apply to this script.
- **Recent-change review of in-scope test files:** Ran actual diffs (not just `--stat`)
  for every commit among the last 30 that touched a file in this track's scope:
  `git show 1c3fae9 -- web-src/test/` (added `elk-layout.test.mjs`/`graph-layout.test.mjs`
  deadline/throw coverage and the 3 malformed-envelope tests in
  `topology-crypto.test.mjs`, all reviewed above — see CFG-003's discussion of the
  same-commit test-matches-fix pattern), `git show ee8e125 -- web-src/test/` (added one
  `graph-layout.test.mjs` test for the redundant-edge cluster-reroute regression,
  matches the described fix, no over-fitting concern found), and confirmed `c531285`
  touches no `web-src/test/*.mjs` file at all despite its TopologyCrypto.ps1 changes
  (see CFG-003). No additional test-matches-wrong-behavior pattern found beyond what's
  already called out in CFG-003 and CFG-005.
- **inlineCssUrls coverage of index.html's own inline `<style>` blocks:**
  `build-inline.mjs`'s `inlineCssUrls` only runs on linked stylesheet files (Leaflet's
  CSS); checked whether `web-src/index.html`'s own inline `<style>` block(s) contain
  any local relative `url(...)` reference that would leak an unembedded file path into
  the "genuinely self-contained" single-file build — `grep -n "url(" web-src/index.html`
  returns no matches, so this isn't a live gap; the file's inline styles don't
  reference external assets today.
