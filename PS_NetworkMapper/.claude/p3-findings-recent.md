# Pass 3 — Category 30 "Recent-Change Review" — independent reviewer

Scope: Pass 2's 7 fix commits (`e24f17e` through `0948584`), reviewed as the reviewer who
should have caught a bug in each diff, independent of Pass 2's own fix-review pass. Also
independently re-verified (not trusted from prior reports) the two empirical claims in
AUDIT_LEDGER.md's Pass 2 verification notes: the `Move-Item -Force` vs
`[System.IO.File]::Replace` atomicity comparison, and the 91/91 test count + build-artifact
freshness.

## Independent empirical re-verification

**1. `[System.IO.File]::Replace` atomicity vs `Move-Item -Force`** — re-run from scratch,
not trusted from prior traces. `strace` 7.1 is installed at `/run/current-system/sw/bin/strace`,
`pwsh` 7.6.2 (via nix, confirmed `/run/current-system/sw/bin/pwsh`) also available; ltrace is
not installed (not needed).

```
$ strace -f -e trace=unlink,unlinkat,rename,renameat,renameat2 pwsh -NoProfile -Command \
    "Move-Item -Path src.txt -Destination dest.txt -Force"
unlink("/tmp/atomic_test/dest.txt") = 0
rename("/tmp/atomic_test/src.txt", "/tmp/atomic_test/dest.txt") = 0
```
Confirmed: `Move-Item -Force` over an existing destination is `unlink(dest)` followed by a
**separate** `rename(src, dest)` syscall — non-atomic, exactly as AUDIT_LEDGER.md claims.

```
$ strace -f -e trace=... pwsh -NoProfile -Command \
    "[System.IO.File]::Replace('src2.txt','dest2.txt',[NullString]::Value)"
rename("/tmp/atomic_test/src2.txt", "/tmp/atomic_test/dest2.txt") = 0
```
Confirmed: `[System.IO.File]::Replace` performs a **single** `rename()` syscall — atomic
under POSIX. Also confirmed (not previously reported) that `File.Replace` throws
`MethodInvocationException: "Unable to find the specified file."` when the destination does
not exist — correctly guarded against in both `Protect-MapperFile.ps1`'s and
`FleetCrawl.ps1`'s new `Move-FileAtomic`/`Move-TopologyOutputLocal` helpers via the
`Test-Path -LiteralPath $Destination` branch that falls back to plain `Move-Item` in that
case. **Claim independently CONFIRMED**, no discrepancy found.

**2. Test suite + build artifact freshness** — re-run from scratch:
```
$ cd web-src && node --test
ℹ tests 91
ℹ pass 91
ℹ fail 0
```
91/91, matching the ledger's claim.
```
$ node tools/build-inline.mjs
Inlined 18 file(s) into .../lib/Network_Visualizer.html
$ git diff --stat -- lib/Network_Visualizer.html
(empty)
```
Confirmed: at HEAD (`0948584`), the committed `lib/Network_Visualizer.html` is byte-identical
to a fresh build from current `web-src/` sources. **Claim independently CONFIRMED for HEAD.**
(But see P3REC-001 below — this is *not* true for one of the intermediate commits along the
way, which the "byte-identical at HEAD" check cannot surface.)

## Per-commit review

- `e24f17e` (P2-SSH-STARTUP, P2-ACL-SILENT, P2FRESH-001): diff matches message. Validation
  regex correctly placed as the sole choke point in `Get-JunosSshArgs`; `$AskPass = $null`
  initialized before the `try`, `New-JunosAskPass` call correctly moved inside it, `finally`
  correctly guards `if ($AskPass) { Remove-JunosAskPass ... }` against the null case. No bug.
- `788dea4` (P2WS-002): diff matches message exactly — both new log sites mirror the
  existing two Pass-1 sites' structure (`try`/`catch` around `EndInvoke`, log on both
  success and failure branches). No bug.
- `85b4220` (P2CRYPTO-001/002): diff matches message. `Move-FileAtomic`/
  `Move-TopologyOutputLocal` both correctly branch on `Test-Path` before calling
  `File.Replace` (confirmed by direct testing above this throws otherwise, correctly
  avoided). `$TempTargetPath` correctly `$PID`-uniqued; the `finally` cleanup's *sequencing*
  is correct (checks `Test-Path` first, so a successful replace doesn't try to delete the
  now-nonexistent temp path). But see **P3REC-002**: the cleanup's `Test-Path`/`Remove-Item`
  pair (in `Protect-MapperFile.ps1`, both branches) mixes literal and wildcard path
  semantics — a real, reproduced bug.
- `36638fc` (P2FRESH-002): diff matches message. Deliberately uses plain `Move-Item -Force`
  (not the new atomic helper) for `Update-OuiDatabase.ps1`, explicitly justified in the
  commit message as an accepted lower-stakes tradeoff (checked-into-git, recoverable,
  outside the automated crawl path) rather than an oversight — consistent, not flagged as a
  mismatch.
- `92db6cc` (P2DASH-003): diff matches message. `anyUptimeUsable` correctly set only inside
  the per-device loop that already gates on `d.Uptime`/`isNaN(bootTime)`; the new
  `devices.length > 0` guard correctly avoids claiming "no usable uptime data" for a
  genuinely empty device list (falls through to "None." instead, which is defensible for
  zero devices). No bug.
- `0948584` (P2SCAN-CLUSTER): diff matches message. Traced `resumeScanIfInProgress`'s
  early-return conditions, `pollRunningScan`'s re-entrancy guard (`scanNetworkPollActive`
  set synchronously before any `await`, cleared in every `finish()` exit path), and the new
  `await`-then-skip logic in `app.js`'s `DOMContentLoaded` handler. No bug found in the
  logic itself. Documented negative: traced whether `startNetworkScan`'s 409 handler (which
  re-enables `loadBtn`/`loadFolderBtn`/`scanNetworkBtn` *before* calling `pollRunningScan()`)
  could race a concurrently-reattached poll the way P2REC-002 (Pass 2) described — it can't
  post-fix, because `autoloadLastScan` no longer runs at all once `resumeScanIfInProgress`
  has reattached (`scanNetworkPollActive` true), which was the other half of P2REC-002's
  race. No reachable trigger; not filed.
- `56edb1e` (P2DASH-001/002): drawer.js/index.html/map.js hunks match the message. **The
  regenerated `lib/Network_Visualizer.html` hunk in this same commit does not** — see
  **P3REC-001**.

---

## P3REC-001

**Track:** CORE (build/commit hygiene) — same class as Pass 2's own P2REC-001, but this one
is a functional artifact/source mismatch at an intermediate commit, not just a message
misattribution.

**File:line:** `lib/Network_Visualizer.html` as committed in `56edb1e` (commit message:
"Fix drawer-tab selector collision with the Diagram/Map toggle" ... "Regenerated the built
artifact from source.")

**Severity:** Medium (see note below on why this is graded above Pass 2's structurally
similar P2REC-001, which was Low/informational: P2REC-001 was a message-attribution defect
only — the *code* at that commit was internally consistent, just credited to the wrong
commit message. Here the *artifact itself* diverges from its own commit's source tree, such
that re-running this project's own documented build step at that commit destroys two already
-committed fixes with exit 0 and no warning — a functional regression risk, not just a
bisect-hygiene annoyance. HEAD itself is unaffected — verified above — which is why this
stops short of High.)

**Confidence:** High (directly reproduced by rebuilding at that commit)

**Claim:** At commit `56edb1e`, running this project's own build step —
`node tools/build-inline.mjs`, exactly as the commit's message claims was done — silently
deletes two other commits' worth of already-fixed bugs from the served artifact: the
P2DASH-003 "no usable uptime data" distinction and the P2SCAN-CLUSTER reattach-race/
re-entrancy guard. Exit code 0, no warning, no test failure (the `node --test` suite
exercises `web-src/*.mjs` logic directly, never the generated `lib/Network_Visualizer.html`
artifact's contents, so nothing catches this).

Framed against this category's brief ("any unrelated/scope-creeping change bundled in?"):
`56edb1e`'s `lib/Network_Visualizer.html` hunk bundles in the *artifact halves* of two
other commits' fixes (`92db6cc`'s P2DASH-003, `0948584`'s P2SCAN-CLUSTER) that had not been
made to `56edb1e`'s own `web-src/` sources yet — i.e., `56edb1e`'s commit message claims a
from-this-commit's-source rebuild ("Regenerated the built artifact from source") while the
diff it actually contains was built against a later/working-tree state.

Concretely: `lib/Network_Visualizer.html`
already contains the `anyUptimeUsable` dashboard logic (`P2DASH-003`, not introduced until
the *next* commit `92db6cc`) and the `scanNetworkPollActive` re-entrancy guard plus the
`await`-ordered `DOMContentLoaded` handler (`P2SCAN-CLUSTER`, not introduced until the
*final* commit `0948584`) — even though `56edb1e`'s own `web-src/dashboard.js`,
`web-src/scan-network.js`, and `web-src/app.js` do **not** contain any of that code yet.

Reproduced directly: checked out `56edb1e` into a clean worktree and ran the actual build
tool the message claims was used:
```
$ git worktree add /tmp/wt_56edb1e 56edb1e
$ cd /tmp/wt_56edb1e/PS_NetworkMapper/web-src && node tools/build-inline.mjs
Inlined 18 file(s) into .../lib/Network_Visualizer.html
$ diff <(git show 56edb1e:.../lib/Network_Visualizer.html) lib/Network_Visualizer.html
```
The rebuild differs from the committed file at exactly the `anyUptimeUsable`/
`scanNetworkPollActive`/`await resumeScanIfInProgress` regions — 120 diff lines, all of them
code that a true "build from this commit's own source" would **not** have produced, because
`56edb1e:web-src/dashboard.js` has no `anyUptimeUsable` and `56edb1e:web-src/scan-network.js`
has no `scanNetworkPollActive` (confirmed via `git show 56edb1e:.../dashboard.js | grep
anyUptimeUsable` → no match, `git show 56edb1e:.../scan-network.js | grep
scanNetworkPollActive` → no match).

In other words, the artifact committed at `56edb1e` was built against a *later* (or
working-tree) state of `web-src/` that included not-yet-committed P2DASH-003/
P2SCAN-CLUSTER changes, then committed under a message that claims it was built from this
commit's own source. By the time `92db6cc` and `0948584` land, source and artifact converge
back to consistency (confirmed: HEAD's rebuild is byte-identical, see verification section
above) — so this is not a live bug in the currently-running application. It is a hazard for
anyone who treats `56edb1e` as an independently valid, buildable state: `git bisect`, a
partial `git revert` of just `92db6cc`+`0948584`, a cherry-pick of `56edb1e` alone onto
another branch, or any CI step that re-runs `build-inline.mjs` at that specific commit and
commits the result, would silently **regress** the served page — dropping both the
P2DASH-003 "no usable uptime data" distinction and the P2SCAN-CLUSTER reattach-race/
re-entrancy fix — with no commit recording that loss, and no test catching it (the
`node --test` suite covers `web-src/*.mjs` logic directly, not the generated
`lib/Network_Visualizer.html` artifact's contents).

**Trigger:** `git checkout 56edb1e && cd web-src && node tools/build-inline.mjs` (or any
tooling that independently rebuilds/bisects at that single commit) followed by loading the
resulting `lib/Network_Visualizer.html` in a browser and testing either dashboard reboot
rendering with zero valid-`Uptime` devices, or a page refresh mid-scan-with-prior-snapshot.

**Evidence:**
```
$ git show 56edb1e:PS_NetworkMapper/web-src/dashboard.js | grep anyUptimeUsable
(no output)
$ git show 56edb1e:PS_NetworkMapper/web-src/scan-network.js | grep scanNetworkPollActive
(no output)
$ git show 56edb1e:PS_NetworkMapper/lib/Network_Visualizer.html | grep -c \
    "anyUptimeUsable\|scanNetworkPollActive"
5
```
Full rebuild-vs-committed diff (120 lines) reproduced above; available by re-running the
`git worktree add` + `node tools/build-inline.mjs` steps against `56edb1e`.

**Invariant hit:** none of the six named invariants directly (INV-UI-TRUTH is the closest —
the served artifact briefly could have shown the pre-fix "None." ambiguity and the pre-fix
scan-reattach race — but only if someone actually deployed from this single intermediate
commit, which the current linear-history HEAD does not do). Primarily a process-integrity
finding, same family as Pass 2's own P2REC-001 (which flagged message/diff mismatches
elsewhere in Pass 1's history) — this instance is a step further, since the artifact itself
(not just the message) is inconsistent with its own commit's source tree.

**Impact:** Medium. HEAD is correct (independently re-verified above). The risk is entirely
in git-history operations that isolate `56edb1e` — a real possibility given this project's
own audit protocol already treats individual commits as meaningful units (per-commit review
is literally this category's method), and given Pass 2's ledger already documents one prior
case (P2REC-001) of exactly this kind of "artifact/logic doesn't match commit's own
message/diff" defect going undetected until a dedicated recent-change-review pass looked for
it.

**Fix sketch:** No production-code change needed (HEAD is fine). If commit hygiene matters
for this repo, `56edb1e`'s `Network_Visualizer.html` hunk should be split: (a) a version at
`56edb1e` regenerated from *only* that commit's own `drawer.js`/`index.html`/`map.js`
changes, deferring the P2DASH-003/P2SCAN-CLUSTER portions of the artifact to their own
commits (`92db6cc`, `0948584`), or (b) accept the current bundling but correct the
commit message to not claim a from-this-commit's-source rebuild. Recommend documenting this
in AUDIT_LEDGER.md as a known bisect hazard (informational) rather than rewriting already-
pushed history, consistent with how P2REC-001 was handled.

---

## P3REC-002

**Track:** DATA (INV-DATA — the highest-stakes file this pass touched)

**File:line:** `lib/Protect-MapperFile.ps1:130,168` (both the `-Decrypt` and encrypt
branches' new `finally` cleanup, added in commit `85b4220`)

**Severity:** Low/Medium (narrow trigger — requires both an operator-chosen output path
containing a bracket character and a write/replace failure — but a real, reproduced bug in
new code from the commit whose entire stated purpose was hardening this exact write path)

**Confidence:** High (directly reproduced via `pwsh`)

**Claim:** The new `finally` cleanup added by `85b4220` in both branches of
`Protect-MapperFile.ps1` mixes literal and wildcard path-matching semantics for the same
variable:
```powershell
$TempTargetPath = "$TargetPath.$PID.tmp"
try {
    $PlainJson | Out-File -FilePath $TempTargetPath -Encoding utf8 -Force
    Move-FileAtomic -Source $TempTargetPath -Destination $TargetPath
} finally {
    if (Test-Path -LiteralPath $TempTargetPath) { Remove-Item -Path $TempTargetPath -Force }
}
```
`Test-Path -LiteralPath` treats `$TempTargetPath` as a literal string (no wildcard
expansion) — correct, since `-TargetPath`/`-OutputFile` is an unrestricted operator-supplied
string (see the script's own param block: `[string]$OutputFile`, no `ValidateScript`
restricting characters, only `-InputFile` is `Test-Path`-validated). `Remove-Item -Path`,
one line later on the exact same variable, does **not** use `-LiteralPath` — `-Path`
interprets `[`, `]`, `*`, `?` as wildcard/glob syntax. If `$TargetPath`'s directory contains
a literal `[...]` segment (a plausible Windows folder name — e.g. an operator's
`Network_Maps [Site A]\` convention, or any bracketed archival/dated folder name), the two
calls disagree on what the path even refers to: `Test-Path -LiteralPath` correctly reports
the temp file exists, but `Remove-Item -Path` silently fails to match it and does not delete
it — with **no error, no exception, `Remove-Item` returns as if it succeeded**.

Reproduced directly, using the plausible-operator-folder-name case (a bracketed label, not
just digits, to rule out the mismatch being an artifact of `[2026]` specifically parsing as
a narrow character class):
```
$ mkdir "/tmp/bracket test [Site A]" && cd "$_"
$ echo data > "file.txt.12345.tmp"
$ pwsh -NoProfile -Command '
    $p = "/tmp/bracket test [Site A]/file.txt.12345.tmp"
    if (Test-Path -LiteralPath $p) { Write-Host "LiteralPath sees it: true" }
    Remove-Item -Path $p -Force -ErrorAction Stop
    Write-Host "Remove-Item -Path succeeded"
    Write-Host "Still exists: $(Test-Path -LiteralPath $p)"
  '
LiteralPath sees it: true
Remove-Item -Path succeeded
Still exists: True
```
(Also reproduced with `[2026]` as the bracketed segment — same outcome, so this isn't
sensitive to what's inside the brackets.) `Remove-Item -Path` reports success while leaving
the file in place — the cleanup this `finally` block exists to guarantee silently does
nothing, and nothing downstream notices.

**Trigger:** Only reachable on the cleanup path — i.e. when `Out-File` or `Move-FileAtomic`
throws partway through (disk full, permission denied, a lock on `$TargetPath`, or a
cross-volume `File.Replace` failure) **and** `-OutputFile`/the default output path resolves
into a directory containing a bracket character. On the ordinary success path this code
never runs (the temp file is already gone via rename), so this is specifically a
failure-inside-a-failure-recovery-path bug — the exact scenario `85b4220` was written to
harden, for the exact file (`Network_Maps`/`Configuration.json.enc`) INV-DATA calls out as
"never silently corrupted or unrecoverable."

**Evidence:** Reproduction above; source at `lib/Protect-MapperFile.ps1:126-133` (decrypt
branch) and `:163-170` (encrypt branch) — both introduced by `85b4220`, both share the
identical `-LiteralPath`/`-Path` mismatch. `FleetCrawl.ps1`'s equivalent cleanup at
`FleetCrawl.ps1:539` (`if (Test-Path $TempOutputFile) { Remove-Item -Path $TempOutputFile
-Force }`) does **not** have this specific mismatch — both calls there omit `-LiteralPath`
consistently — but is pre-existing code, not touched by `85b4220`'s diff, so out of this
category's scope (and has its own, different, already-known limitation: a bracket-containing
path would make *both* calls silently no-op there too, meaning `Test-Path` would report
false and skip cleanup entirely rather than reporting true and failing to act — a softer
failure mode, not filed here).

**Invariant hit:** INV-DATA indirectly — not data loss/corruption itself (the operator's
real file is untouched either way; `Move-FileAtomic`'s own correctness is unaffected by
this), but a silent failure of the cleanup this same commit's message specifically calls out
adding ("try/finally cleanup of any leftover temp file"), leaving a stray `.$PID.tmp` file
containing plaintext/decrypted topology or configuration data sitting alongside the
operator's chosen output path indefinitely with no trace anywhere that cleanup was
attempted and silently failed.

**Impact:** Low/Medium. Narrow trigger (needs both a bracket in the path and an independent
write failure), and the leaked temp file is the same plaintext content the operator already
has in the source file, not novel exposure of anything the operator doesn't already possess
— but it directly undercuts a guarantee this exact commit's message advertises adding, is a
straightforward copy-paste-class error (a repeated pattern of switching cmdlet flags
mid-`if`), and would be silent to both the operator and any future auditor. The leaked temp
file lands in whatever directory the operator's `-OutputFile` (or the input file's own
directory, by default) resolves to — this is a standalone CLI tool, not the automated
crawl/webserver runtime, so it is not necessarily `Network_Maps\`, only wherever the
operator pointed it.

**Fix sketch:** Use `-LiteralPath` on the `Remove-Item` call too:
`Remove-Item -LiteralPath $TempTargetPath -Force`, matching the `Test-Path` call it's
gated on. Same fix applies at both of `Protect-MapperFile.ps1`'s two occurrences.

---

## Summary

7 commits reviewed line-by-line; 5 fully clean (diff matches message, no scope creep, no
copy-paste/off-by-one errors found). Two findings survived independent skepticism with
concrete reproductions: **P3REC-001** (an intermediate commit's build artifact silently
diverges from — and, if rebuilt, would regress — its own commit's source, in the highest-
diff-volume commit of this pass) and **P3REC-002** (a `-LiteralPath`/`-Path` cmdlet-flag
mismatch in the new temp-file cleanup of `85b4220`, the highest-stakes commit of this pass,
that silently no-ops instead of erroring when the target path contains a bracket character).
Both of Pass 2's empirical verification claims (strace atomicity comparison, 91/91 +
build-artifact freshness) were independently re-run from scratch and confirmed with no
discrepancy.
