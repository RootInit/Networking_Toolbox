# Pass 2 — Category 30 "Recent-Change Review" — RootInit reviewer (second independent look)

Scope: all 9 non-doc fix commits from Pass 1 (`13736ee` through `7c32a00`; the 10th commit
in the `13736ee..949e803` range, `949e803`, is the doc-only "add audit ledger" commit the
task instructions say to skip), reviewed as the
reviewer who should have caught a bug in each diff — independent of Pass 1's own
fix-review pass (which already caught UX-005b). Also covers `web-src/tools/build-inline.mjs`
(CFG-002) and `web-src/test/graph-layout.test.mjs` / `web-src/test/elk-layout.test.mjs`
(CFG-005/006), which no other Pass 2 agent was assigned.

## Verification performed

- `cd web-src && node --test` → **91/91 pass**, matching AUDIT_LEDGER.md's claimed post-fix
  baseline.
- `cd web-src && node tools/build-inline.mjs` → exit 0, "Inlined 18 file(s)...". `git status
  --short` before/after shows **no diff** on `lib/Network_Visualizer.html` — the checked-in
  generated artifact is byte-identical to a fresh build from current `web-src/` sources (not
  drifted since the `7c32a00` rebuild commit). Working tree left clean (only an unrelated
  concurrent `AUDIT_LEDGER.md` modification from another process was present before and after
  — not touched by this review).
- Read every one of the 10 fix commits in full (`git show <hash>`) and traced each claimed
  fix against the current source to confirm the guard clauses/logic described actually exist
  (e.g. confirmed `topology-crypto.js`'s version/kdf/cipher/macAlgorithm/iterations checks are
  real code the new CFG-003 tests exercise, not testing dead code).

## Per-commit verdict summary (no new finding unless listed below)

- `13736ee` (SSH-001/002, SEC-1, WS-2): diff matches message. Username validation is
  correctly scoped to the single injection sink (`Invoke-SaveConfigAction`); empty-string
  clear-credentials path correctly bypasses the regex. No scope creep otherwise — but see
  **P2REC-003**: the SEC-1 ACL-hardening helper this same commit adds swallows its own
  failures silently, in the same commit that fixes WS-2's silent-catch problem for a
  different code path.
- `5ce1858` (CFG-001 logging): diff matches message exactly (2-line addition), `elseif`
  condition correctly restricted to the `-not $InScope` case only (does not also fire for
  already-visited/enqueued neighbors). No bug.
- `efbc0df` (CRYPTO-001/002, CFG-003 tests): diff matches message. New tests assert on the
  real error-message text thrown by real guard clauses in `topology-crypto.js` (verified by
  grep) — not tautological. No new finding (the known `.tmp`-orphan-on-Move-Item-failure gap
  is already logged in AUDIT_LEDGER.md's Phase-3 deferred list; not re-reported here).
- `99780f2` (CFG-002 build-inline.mjs): diff matches message; live-verified above.
- `804e8c6`, `5c4058d` (UX-001/002/SEC-2/UX-005b, UX-004/005/006): see **P2REC-001** and
  **P2REC-002** below.
- `9c0a0b8` (GRAPH-001/002): diff matches message. `graph.js`'s VLAN dropdown fix correctly
  keeps `allVlans.get(tag)` in sync with the now-string-typed `sortedTags` (traced: `allVlans`
  keys are always `String(c.VLAN_Tag)`, so `.get(tag)` on the un-mapped string key is
  correct). `map.js`'s two new `leafletMap.off(...)` calls (rebuild teardown, same-marker
  reclick) both correctly guard on `marker._disarmOnMapClick` before calling `.off`. Traced a
  third, pre-existing (not touched by this diff, not claimed as fixed by this commit) path —
  arming marker B while marker A is already armed — which still leaves marker A's one-shot
  listener registered; not reported as a finding because it is self-healing (Leaflet's
  `.once()` still fires and removes itself on the next map click, and the stale closure's
  `currentlyArmedMarker === marker` guard is stale-safe) — no functional bug, below the bar
  for this audit's evidence requirement.
- `22f7684` (CFG-005/006 test tightening): both new/tightened tests read real, non-tautological
  assertions against real code (`computeGraphRoot`'s tie-break is genuinely deterministic —
  confirmed by the sort/`<` logic the comment describes; the new elk-layout fallback test
  correctly forces `computeRecursiveRadialLayout` to throw via the actual seam
  `computeLayout` reads (`window.GraphLayout`, confirmed in `elk-layout.js:66`) and asserts
  the result equals `computeGridFallback`'s output for the same node list). No finding.
- `7c32a00` (rebuild): live-verified as byte-identical to current source; no finding.

---

## P2REC-001

**Track:** CORE (build/commit hygiene) / SERVICE
**File:line:** `web-src/index.html` (lines with `onkeydown="window.activateOnKey(...)"`,
added in commit `804e8c6`), `web-src/utils.js:22-29` (`window.activateOnKey`, added in
commit `5c4058d`)
**Severity:** Low
**Confidence:** High

**Claim:** Commit `804e8c6`'s message claims scope UX-001, UX-002, SEC-2, and UX-005b only
— it never mentions UX-005 — yet its actual diff adds the *entire* UX-005 keyboard-access
markup (`tabindex="0"`, `role="tab"`/`role="button"`, and `onkeydown="window.activateOnKey(...)"`)
to every drawer tab, every sidebar tab, and the drawer close button in `index.html`. The
very next commit, `5c4058d`, is titled "Add text/keyboard alternatives to color-only status
UI..." and its message explicitly claims: *"UX-005: drawer tabs, sidebar tabs, and the
drawer close button were `<div>`/`<span>` elements with only onclick — unreachable via
keyboard. **Added tabindex, role**, and a shared activateOnKey (utils.js) keydown handler..."*
— but `5c4058d`'s actual diff never touches `index.html` at all (confirmed via
`git show --stat 5c4058d`: only `dashboard.js`, `drawer.js`, `utils.js` changed). The
`tabindex`/`role` markup `5c4058d`'s message takes credit for was already committed one
commit earlier, in `804e8c6`, under a commit message that never mentions it.

Worse, this ordering means commit `804e8c6` alone (e.g. if `git bisect`ed to, or if this
repo used commit-per-review CI) ships `index.html` markup that calls
`window.activateOnKey(...)` from `onkeydown` handlers on every tab and the close button —
but `window.activateOnKey` is not defined anywhere until the *following* commit `5c4058d`
adds it to `utils.js`. Confirmed by direct diff of the pre-`804e8c6` tree
(`git show 804e8c6^:PS_NetworkMapper/web-src/utils.js | grep activateOnKey` → no match) and
by confirming `804e8c6^:index.html` has no `tabindex`/`onkeydown` on any `.tab`/`.sidebar-tab`
element at all.

**Trigger:** Checking out `804e8c6` alone (bisect, cherry-pick, or any tooling that treats
individual commits as independently-buildable states) and pressing Enter/Space on any
drawer tab, sidebar tab, or the drawer close button.

**Evidence:**
- `git show --stat 804e8c6` shows `index.html | 28 +++---` with `+tabindex="0" role="tab"
  ... onkeydown="window.activateOnKey(event, ...)"` added to every `.tab`/`.sidebar-tab`
  element and the `.close-btn`.
- `git show --stat 5c4058d` shows only `dashboard.js`, `drawer.js`, `utils.js` — no
  `index.html`.
- `git show 804e8c6^:PS_NetworkMapper/web-src/utils.js | grep -n activateOnKey` → empty
  (function doesn't exist yet at that point in history).
- At HEAD both commits are applied together so the function exists by page-load time — this
  is not a live bug in the current running app, only a commit-hygiene/attribution defect.

**Invariant hit:** none of the six named `AUDIT_LEDGER.md` invariants directly; this is a
process/audit-trail integrity issue — the audit protocol's own "does the diff match its own
commit message" check (this task's explicit brief) is what this finding answers.

**Impact:** Low in the shipped-code sense (HEAD is fully functional, 91/91 tests pass, and
this was manually confirmed via `activateOnKey` grep above). The impact is on future
maintainers/auditors: `git blame`/`git log -p` on `index.html`'s keyboard-accessibility
markup point to a commit (`804e8c6`) whose message gives zero indication that markup exists
there, while the commit whose message *describes* that exact markup (`5c4058d`) doesn't
contain it — anyone trying to revert/cherry-pick/audit UX-005 in isolation will grab the
wrong commit and get a broken partial state (dead `onkeydown` handlers, or in reverse order,
an orphaned `activateOnKey` function nothing calls).

**Repro:**
```
git show --stat 804e8c6 -- PS_NetworkMapper/web-src/index.html   # tabindex/role/onkeydown added here
git show --stat 5c4058d -- PS_NetworkMapper/web-src/index.html   # empty - no index.html changes
git show 804e8c6^:PS_NetworkMapper/web-src/utils.js | grep activateOnKey   # not defined yet
```

**Fix sketch:** No production-code change needed (HEAD is correct). If commit history is
considered part of the deliverable, an interactive rebase folding `804e8c6`'s `index.html`
hunk into `5c4058d` (or rewriting `804e8c6`'s message to also list UX-005's markup) would
make the two commits self-consistent and independently bisectable. Purely a process
finding, not blocking.

---

## P2REC-002

**Track:** USER-FACING / SERVICE
**File:line:** `web-src/scan-network.js:144-160,73-88` (`window.resumeScanIfInProgress`,
`pollRunningScan`, both added in commit `804e8c6`), racing against
`web-src/app.js:413-538` (`window.processSelectedFiles`'s own button disable/enable in its
`try`/`finally`, pre-existing), both reachable from the unsequenced
`web-src/app.js:377-380` `DOMContentLoaded` handler
**Severity:** Low
**Confidence:** Medium-High

**Claim:** `window.resumeScanIfInProgress` and `window.autoloadLastScan` are fired
unawaited, back-to-back, from the same `DOMContentLoaded` handler:
```js
if (typeof window.resumeScanIfInProgress === 'function') window.resumeScanIfInProgress();
window.autoloadLastScan();
```
(Checked and ruled out a stronger framing first: `autoloadLastScan`'s own generation-guard
re-check before it calls `processSelectedFiles`, and `processSelectedFiles`'s
newest-generation-wins semantics, together mean the *final displayed topology* can never end
up wrong/stale in either ordering — so this is not a reopening of UX-001's "unconfirmed data
replacement" class as initially suspected. The real, verifiable bug is narrower: a UI
control-disable state gets silently undone.)

`pollRunningScan()` (reached via `resumeScanIfInProgress` reattaching to an in-progress
scan) synchronously disables `loadBtn`/`loadFolderBtn`/`scanNetworkBtn` for the stated
purpose (per its own comment) of preventing "a Load click ... start[ing] reading files while
a scan the user is about to load is still in flight." Independently, if
`autoloadLastScan`'s own `processSelectedFiles` call is still in flight or starts around the
same time (both fire unawaited from the same handler), `processSelectedFiles`'s `finally`
block unconditionally re-enables the same three buttons **whenever its own generation is
still current** (`web-src/app.js:533-539`):
```js
} finally {
    if (myGeneration === loadFilesGeneration) {
        window.hideProgress();
        btn.disabled = false;
        if (folderBtn) folderBtn.disabled = false;
        if (scanBtn) scanBtn.disabled = false;
    }
}
```
Neither side is aware of the other's disable/enable of these buttons. If
`resumeScanIfInProgress`'s `/api/scan-network/status` fetch resolves to `running` and calls
`pollRunningScan()` (disabling the buttons) *before* `autoloadLastScan`'s own
`processSelectedFiles` call has reached its `finally` block, then when
`processSelectedFiles` does complete (still generation 1, since `pollRunningScan`'s
eventual completion `processSelectedFiles` call — generation 2 — hasn't fired yet, the scan
is still polling), its `finally` re-enables `loadBtn`/`loadFolderBtn`/`scanNetworkBtn` —
silently undoing the disable that is currently protecting an actively-polled, in-progress
reattached scan. The Load/Load-Folder/Scan-Network buttons become clickable again while
`scanNetworkBtn`'s own text still reads "Scanning (N found)..." and a poll timer is live,
defeating the exact protection `pollRunningScan`'s comment describes.

**Trigger:** Refresh the browser tab while a fleet-wide scan started earlier (this tab or
another) is genuinely still running server-side, with a previously-saved snapshot also on
disk for `autoloadLastScan` to pick up — precisely the UX-002 reattach scenario this commit
was written for. Whether `autoloadLastScan`'s `processSelectedFiles` call's `finally` fires
before or after `pollRunningScan()`'s disable determines whether the buttons end up
re-enabled out from under the in-progress reattach; not deterministic every time, but the
triggering scenario itself is exactly UX-002's target case, not a contrived edge case.

**Evidence:**
- `web-src/app.js:377-380` — both async entry points invoked unawaited from the same
  synchronous handler, no sequencing between them.
- `web-src/scan-network.js:73-88` (`pollRunningScan`) — disables the three buttons
  synchronously at call time; its own comment states the purpose is blocking Load clicks
  for the scan's duration.
- `web-src/app.js:421-423,533-539` (`processSelectedFiles`) — disables the same three
  buttons at its own start, re-enables them in `finally` guarded only by its own generation
  counter, with no awareness of `pollRunningScan`'s independent disable.
- Confirmed `loadFilesGeneration` is bumped only by `processSelectedFiles` itself
  (`web-src/app.js:414`), never by `pollRunningScan`/`resumeScanIfInProgress` before the
  scan actually completes — so `autoloadLastScan`'s in-flight `processSelectedFiles` call
  stays "current" (and its `finally` re-enable fires) for the whole time
  `resumeScanIfInProgress` is merely polling, not yet re-loading.

**Invariant hit:** none of the six named invariants directly (no data corruption/loss, no
misrepresented device truth) — a UI-control-state consistency bug: the "Load buttons stay
disabled for the duration of a reattached scan" guarantee `pollRunningScan`'s own comment
states is not actually held when `autoloadLastScan` races it.

**Impact:** Low. Worst case, an operator clicks "Load File" or "Scan Network" while a
reattached scan is still polling in the background; `processSelectedFiles`'s and
`startNetworkScan`'s own generation-guard/409-reattach logic (traced separately, not
re-derived here) still prevents actual data corruption or a doubled crawl — but the button
state visibly contradicts what's actually happening (clickable button, disabled-looking
intent), which is exactly the kind of UI-truth rough edge this pass was auditing for, just
below the bar of the invariants that would make it more than Low severity.

**Repro:** Start a fleet scan (`POST /api/scan-network`); before it completes, reload the
page (with a prior snapshot already saved to disk so `autoloadLastScan` has something to
load). Instrument or slow down `/api/snapshots` slightly relative to
`/api/scan-network/status` (or just observe across several reloads, since real network
timing already varies both ways) to catch the ordering where `pollRunningScan()`'s disable
lands before `autoloadLastScan`'s `processSelectedFiles` reaches its `finally` — the Load
buttons go clickable again while the scan button still shows "Scanning (N found)...".

**Fix sketch:** Have `pollRunningScan` (or `resumeScanIfInProgress`) participate in the same
`loadFilesGeneration` counter `processSelectedFiles` already uses to arbitrate button
ownership — e.g. bump it when reattaching, and have `processSelectedFiles`'s `finally`
re-check continue to work unmodified, since it already only acts "if
`myGeneration === loadFilesGeneration`."

---

## P2REC-003

**Track:** CORE / SERVICE (INV-CREDS surface)
**File:line:** `lib/SshHelpers.ps1:15-25` (`Protect-JunosTempFileAcl`, added in commit
`13736ee`)
**Severity:** Low/Medium
**Confidence:** High

**Claim:** `Protect-JunosTempFileAcl` — the SEC-1 fix that restricts a just-written SSH
credential/askpass temp file's ACL to the current user only — ends in a bare
`try { ... } catch {}`:
```powershell
function Protect-JunosTempFileAcl {
    param([Parameter(Mandatory=$true)][string]$Path)
    try {
        $CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $Acl = New-Object System.Security.AccessControl.FileSecurity
        $Acl.SetAccessRuleProtection($true, $false)
        $Rule = New-Object System.Security.AccessControl.FileSystemAccessRule($CurrentUser, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
        $Acl.AddAccessRule($Rule)
        [System.IO.File]::SetAccessControl($Path, $Acl)
    } catch {}
}
```
On any failure (a non-NTFS `%TEMP%`, an `SetAccessRuleProtection`/`SetAccessControl` API
failure, a `WindowsIdentity` lookup failure, etc. — the function's own header comment names
"non-NTFS temp" as an expected case), the function returns silently, and every caller
(`New-JunosCredentialFile`, `New-JunosAskPass`, both at `SshHelpers.ps1:41,58,60`) proceeds
as if the hardening succeeded. The plaintext-password credential/askpass file is then left
on disk with whatever default (potentially broader-than-current-user) ACL `%TEMP%` grants,
for the SSH operation's full lifetime, with **zero trace anywhere** that the hardening this
commit was written to add did not actually apply.

This is a direct, same-commit self-inconsistency: commit `13736ee`'s own message states
that its WS-2 half fixed exactly this pattern elsewhere in the file — *"results from
late-completing orphaned rescan/ping jobs were discarded via `Out-Null` with no log trace,
unlike every other error/completion path in this file. Now logged."* The new
`Protect-JunosTempFileAcl`, introduced by the same commit, adds a new instance of the exact
pattern WS-2 just got called out and fixed for (a swallowed failure with no log trace) —
except here the swallowed failure is a security-hardening step protecting plaintext switch
credentials (INV-CREDS), not a discarded scan result.

**Trigger:** Any environment where `[System.IO.File]::SetAccessControl` throws for the
temp-file path in use — e.g. `%TEMP%` redirected to a non-NTFS filesystem/network share, a
restrictive filesystem ACL that denies the current user `WRITE_DAC`, or a
`WindowsIdentity.GetCurrent()` failure under certain constrained/virtualized identity
contexts. Every `New-JunosCredentialFile`/`New-JunosAskPass` call thereafter silently ships
an unhardened plaintext credential file with no operator-visible or log-visible indication.

**Evidence:**
- `lib/SshHelpers.ps1:24` — `} catch {}` with no `Write-MapperDebugLog`/equivalent call, no
  re-throw, no fallback (e.g. `Remove-Item` the now-unhardened file and fail the SSH attempt
  outright).
- `lib/SshHelpers.ps1:12-14` (function's own comment) — explicitly names "non-NTFS temp" as
  an anticipated real-world failure mode this catch is expected to hit, confirming this
  isn't a theoretical-only path.
- `lib/WebServer.ps1`'s own `13736ee` diff (WS-2 half) — same commit, same file group,
  fixing the identical "swallowed failure, no log trace" pattern one function away,
  establishing that this commit's own standard for acceptable error handling is "log it,"
  not "swallow it."

**Invariant hit:** INV-CREDS ("SSH credentials... never left behind in plaintext on disk...
beyond the single operation's lifetime, and never logged") — the ACL hardening is the
control that keeps a plaintext credential file from being readable beyond the intended
principal for that lifetime; its failure mode is silent, so the invariant can degrade with
no detection path.

**Impact:** Low/Medium. The SSH flow still functions (best-effort by design, matching the
function's stated intent not to block on a hardening failure) and the file is still
short-lived and eventually removed by the caller's own cleanup — so this is not a
guaranteed credential leak, only a silent removal of one layer of defense-in-depth with no
way for an operator or a future auditor to know it happened, on infrastructure (redirected
`%TEMP%`, network home directories) that is plausible in a managed Windows fleet.

**Repro (traced, not executed — would require a non-NTFS-backed `%TEMP%` or a deliberately
revoked `WRITE_DAC` right to reproduce live):**
```powershell
. .\lib\SshHelpers.ps1
$env:TEMP = "\\some-unc-share\temp"   # or any path where SetAccessControl throws
$credPath = New-JunosCredentialFile -Username "admin" -Password "hunter2"
# Function returns normally; $credPath's ACL was never restricted; nothing logged anywhere.
```

**Fix sketch:** Log the failure (e.g. via the same `Write-MapperDebugLog` WS-2 just started
using one file over, if `SshHelpers.ps1` has access to it, or `Write-Warning` at minimum)
instead of a bare `catch {}`, so an operator/log-reviewer can tell the hardening didn't
apply. Optionally, treat a hardening failure as fatal for the credential-file path
specifically (delete the file and abort the SSH attempt) rather than silently continuing
with a weaker-than-intended ACL, since unlike WS-2's orphaned-job-result case, this is a
security control, not an already-discarded result.
