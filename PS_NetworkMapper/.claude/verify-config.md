# Adversarial Verification — Config/Build/Test-Quality Track (CFG-001 .. CFG-006)

Verifier note: attempted to prove each finding wrong by tracing actual code, checking
for upstream guards/reachability, and (for CFG-002, CFG-005) actually running the
reproduction commands live against the current tree. `git status`/`git diff --stat`
confirmed clean (only pre-existing untracked `.claude/` and `AUDIT_LEDGER.md`) both
before and after this pass — no tracked file was modified.

---

## CFG-001 — CONFIRMED

Read `Start-NetworkMapper.ps1:1-16` directly: `[string[]]$AllowedScopes = @("131.30.")`
at line 6, confirmed hardcoded, organization-specific, no environment/config override.

Read `lib/FleetCrawl.ps1:300-335` (actual current line numbers ~318-328, close enough to
the finding's cited 318-327/320-331 — file has shifted slightly but the cited loop is
verbatim as quoted in the finding). The neighbor-enqueue loop:

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

confirmed no `else` branch. Ran `grep -rn "InScope\|out.of.scope\|OutOfScope" lib/
Start-NetworkMapper.ps1 web-src/` — only the three lines inside this loop match; no
logging, no warning, no counter anywhere else in the repo for the out-of-scope case.
The surrounding try/catch (added by a prior debugging pass, per its own comment) only
guards against a malformed `ManagementIP` throwing — it does not add any scope-exclusion
visibility. No upstream guard, no downstream reporting of excluded neighbors exists.

**Verdict: CONFIRMED as described.** Silent, total loss of visibility into
scope-excluded neighbors; hardcoded org-specific default. Severity/confidence as
assessed by the original finding.

---

## CFG-002 — CONFIRMED (reproduced live)

Read `web-src/tools/build-inline.mjs` in full. Confirmed the code path: `inlineLocalFile`
(lines 71-88) treats every missing local file identically (push to `skipped[]`, return
`''`, tag dropped) regardless of whether the file is `vendor/oui-data.js` (documented as
tolerably-absent) or a required app script. `process.exit()` appears exactly once in the
file (line 30, for a missing *input* HTML file) — never called for the missing-referenced-
file case. Lines 116-119 only `console.log` a "Skipped N missing file(s)" message with no
effect on exit code, which defaults to 0.

Reproduced live, exactly as the finding's repro steps specify:

```
$ cd web-src
$ cp index.html index-test.html
$ sed -i 's/graph-layout\.js/graph-layout-TYPOED.js/' index-test.html
$ node tools/build-inline.mjs index-test.html; echo "EXIT CODE: $?"
Inlined 17 file(s) into /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper/lib/Network_Visualizer.html
Skipped 1 missing file(s) (tag dropped, same as a 404'd src/href today): graph-layout-TYPOED.js
EXIT CODE: 0
```

Confirms the exact claim: a required script silently dropped from the build, `Skipped`
line printed, but process exits 0 — a `&&`-chained CI/automation gate would proceed as
if the build succeeded.

Cleanup performed: removed `index-test.html`, re-ran `node tools/build-inline.mjs` with
no args to regenerate the real `lib/Network_Visualizer.html`. Confirmed via `git status
--short` / `git diff --stat` in the repo root that the tree is byte-for-byte unchanged
(no tracked file modified; the regenerated build file matched what was already
committed).

**Verdict: CONFIRMED, empirically reproduced exactly as claimed.** This is the
highest-confidence finding of the six — directly observed, not inferred.

---

## CFG-003 — CONFIRMED

Read `web-src/test/topology-crypto.test.mjs` in full (95 lines, all 8 `test(...)`
blocks). Every envelope built by the shared `buildEnvelope()` helper (lines 9-29) hard-
codes `version: 1, kdf: 'PBKDF2-SHA256', cipher: 'AES-256-CBC', macAlgorithm:
'HMAC-SHA256'`, and `iterations` defaults to the module-level `ITERATIONS = 1000`
constant, only ever passed through unperturbed. Across all 8 tests, the only fields ever
mutated post-construction are `envelope.format` (implicitly, via the `format` argument),
password, `envelope.ciphertext` (corrupted / wrong length), and `delete envelope.salt`.
No test sets `envelope.version`, `envelope.kdf`, `envelope.cipher`,
`envelope.macAlgorithm`, or `envelope.iterations` to anything invalid.

Read `web-src/topology-crypto.js:33-52` directly and confirmed the four guard clauses
exist exactly as the finding describes, in this order: format check (lines 37-39,
covered by tests), `version !== 1` (43-45, uncovered), kdf/cipher/macAlgorithm mismatch
(46-48, uncovered), `Number.isInteger` + iteration range check against
`MIN_ITERATIONS`(1000)/`MAX_ITERATIONS`(5,000,000) (50-52, uncovered). Since every test's
envelope passes all four checks by construction, none of the existing tests can reach a
regression in this block — a broken `!==` turned into `!=`, a reordered check, a typo'd
constant, etc. would pass the current suite silently.

Spot-checked the finding's `git show c531285` claim about the PS-side hardening not
touching this JS test file — not independently re-verified via git log (out of scope for
this pass to re-derive; the finding's own quoted evidence is internally consistent and
the coverage gap is directly demonstrable by reading the test file alone, which is
sufficient to confirm the core claim).

**Verdict: CONFIRMED.** Coverage gap on validation branches is real and directly
observable from the test file; no test perturbs any of the four fields.

---

## CFG-004 — CONFIRMED

Ran directly (not assumed):

```
$ find . -iname "*.tests.ps1" -o -iname "*Tests.ps1"
(no output)
$ pwsh -NoProfile -Command 'Get-Module -ListAvailable Pester'
(no output)
```

Confirms no Pester (or any other) `.ps1` test file exists anywhere in the repo, and
Pester is not installed/available in this environment (a bare `Get-Module
-ListAvailable Pester` with genuinely no matching module prints nothing — consistent
with "not installed", not a tooling glitch, since `pwsh` itself is present and
functional at `/run/current-system/sw/bin/pwsh`).

**Verdict: CONFIRMED as a coverage-gap finding** (the finding itself labels this Low
severity / coverage-only, not a live bug — that framing is accurate). No PowerShell
code, including the two named entry-point/egress scripts, has any automated test
protection.

---

## CFG-005 — CONFIRMED (reproduced live)

Read `web-src/graph-layout.js:58-82` (`computeGraphRoot`). Confirmed the tie-break logic:
`sortedIds` is `Array.from(nodeIds).sort(compareIpIds)` (ascending), and the replace
condition on line 74-75 is `componentSize > bestComponentSize || (componentSize ===
bestComponentSize && eccentricity < bestEccentricity)` — a **strict** `<`, so a later
node with merely *equal* eccentricity to the current best never displaces it. Since
`'c3'` sorts before `'c4'` lexically (both fall through `compareIpIds`'s dotted-quad
fast path to plain string comparison, confirmed by reading `compareIpIds` at lines 6-17),
`'c3'` is visited first, and `'c4'`'s later tied eccentricity fails the strict check.

Reproduced live, exact command from the finding, exact fixture from the test file's own
`'computeGraphRoot prefers the largest component...'` test (`test/graph-layout.test.mjs`
lines 56-69, read directly):

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

Confirmed the test's actual assertion at line 69 is `assert.ok(['c3', 'c4'].includes
(root))` — a loose disjunction that accepts a value ('c4') the real implementation can
never currently produce for this input. This directly matches the finding's claim: the
test is strictly weaker than the deterministic behavior it's nominally checking, and
cannot catch a tie-break-direction regression (e.g. `<` flipped to `<=`) that still lands
on one of the two center nodes.

**Verdict: CONFIRMED, empirically reproduced.** Low severity is appropriately assessed
(narrow gap: only masks a tie-break-direction flip, not a broader wrong-root bug, since
`computeGraphRoot`'s other tests do use strict `assert.equal` for non-tied cases).

---

## CFG-006 — CONFIRMED

Read `web-src/test/elk-layout.test.mjs` in full (80 lines, exactly 4 `test(...)` blocks
as claimed). Three call `computeGridFallback` directly (placement, no-collision, empty-
input) — none touch `computeLayout` at all. The fourth and only `computeLayout` test
(`'computeLayout gives a disconnected second component... its own non-overlapping
positions'`, lines ~40-75) builds two well-formed connected components with no deadline
option passed and no scenario engineered to make `doLayout()` reject — it exercises only
the successful `try` path.

Read `web-src/elk-layout.js:74-108` directly and confirmed the finding's line citations:
`try` opens at line 89, `catch (err)` at line 91 (falls back to `console.error` +
DOM modal wiring + `return computeGridFallback(visibleNodeIds)` at line 105), `finally {
clearTimeout(timeoutId); }` at lines 106-108. No test in the file constructs an input
that makes the internal `doLayout()` promise reject, nor one that pushes the effective
deadline into the past to trip the `Promise.race` timeout — so the `catch` branch, the
one path whose entire job is graceful degradation, is never entered by anything in this
file.

Cross-checked the finding's claim about `graph-layout.test.mjs:614-620` providing only
partial, one-layer-down coverage: read that test directly
(`'computeRecursiveRadialLayout throws once an already-past opts.deadline is checked...'`,
lines 613-619) — confirmed it calls `computeRecursiveRadialLayout` directly, not through
`computeLayout`, so it demonstrates the inner function's throw behavior but never
reaches `elk-layout.js`'s own `try`/`catch`, `console.error` call, or
`computeGridFallback` fallback-return wiring. The finding's characterization of this as
"one layer down" coverage, not equivalent to a direct `computeLayout` catch-path test, is
accurate.

**Verdict: CONFIRMED.** Coverage gap on the fallback/safety-net path is real and
precisely bounded as described; existing adjacent coverage (the throw test one layer
down) does not substitute for it.

---

## Summary

All six findings verified as accurate on independent re-tracing, with CFG-002 and
CFG-005 additionally reproduced live against the current tree (both matched the
finding's claimed output exactly). No finding was rejected or downgraded. Repo working
tree confirmed clean (`git status --short` / `git diff --stat`) before and after this
verification pass — only pre-existing untracked `.claude/` and `AUDIT_LEDGER.md` remain,
no tracked file was modified.
