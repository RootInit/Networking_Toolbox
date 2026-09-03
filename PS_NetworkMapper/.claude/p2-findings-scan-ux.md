# Pass 2 Findings - web-src/scan-network.js, web-src/app.js, web-src/index.html

Re-scan of the UX-001/UX-002/SEC-2/UX-005b changes landed in 804e8c6. Read-only, no fixes applied.

---

## P2SCAN-001

**Track:** CORE (state integrity / concurrency)

**File:line:** web-src/app.js:375-380 (DOMContentLoaded handler), web-src/app.js:324-325,361 (`autoloadLastScan`), web-src/scan-network.js:144-165 (`resumeScanIfInProgress`)

**Severity:** High

**Confidence:** High

**Claim:** `resumeScanIfInProgress()` and `autoloadLastScan()` are both fired, unawaited, from the same `DOMContentLoaded` handler. The code comment directly above them claims reattach "goes first" specifically so a running scan isn't clobbered by the archived-snapshot autoload, but nothing in either function actually enforces that ordering or excludes the other from running concurrently. Re-reading the trace: this is **not actually timing-dependent** despite superficially looking like a fetch-resolution race. `autoloadLastScan`'s only guards, both before and after its own `await`, are `loadFilesGeneration` and `loadedSnapshots.length` (app.js:325, :361). `pollRunningScan()` (scan-network.js:73-137) never touches either of those until the real scan actually *completes* - it only sets `scanNetworkPollTimer` and disables buttons, neither of which `autoloadLastScan` consults. So regardless of which `fetch()` (`/api/scan-network/status` vs `/api/snapshots`) resolves first, `autoloadLastScan` proceeds and clobbers unless the scan happens to finish inside the window of autoload's own fetch+parse - which, for a fleet SSH crawl (the entire point of this feature), essentially never happens. This is deterministic given the preconditions below, not a narrow interleaving.

**Trigger:** Any page load/refresh where, simultaneously: (1) a scan is genuinely running server-side, and (2) at least one archived snapshot exists and is loadable (plaintext, or an encrypted one with a session password already cached - otherwise `autoloadLastScan` bails at app.js:349 before reaching the clobber). Given those two preconditions - both completely ordinary (any environment that's ever completed one prior scan, refreshed mid-crawl) - the clobber happens on effectively every such refresh, since the scan won't finish within autoload's own fetch+JSON-parse window.

**Evidence:**
- `web-src/app.js:375-380`:
  ```js
  document.addEventListener('DOMContentLoaded', function() {
      // Reattach first: if a scan is already running server-side ...
      if (typeof window.resumeScanIfInProgress === 'function') window.resumeScanIfInProgress();
      window.autoloadLastScan();
  });
  ```
  Neither call is awaited, so "first" only describes call order, not resolution order.
- `web-src/app.js:324-325` and `:361`: `autoloadLastScan`'s only re-entrancy guards are `loadedSnapshots.length > 0` (checked at entry and again after its own `await fetch('/api/snapshots')`). It never reads `scanNetworkPollTimer`.
- `web-src/scan-network.js:144-165`: `resumeScanIfInProgress` checks `scanNetworkPollTimer`/`loadedSnapshots.length` only at line 145, before `await fetch('/api/scan-network/status')`. After that await resolves (line 148) there is no re-check before calling `pollRunningScan()` (line 164), and `pollRunningScan()` itself (scan-network.js:73-137) sets `btn.disabled = true` immediately (lines 86-88) but never sets `loadedSnapshots` or `loadFilesGeneration` - the only two signals `autoloadLastScan`/`processSelectedFiles` actually consult.
- `web-src/app.js:413-423,530-539` (`processSelectedFiles`): unconditionally sets `loadBtn.disabled = true` / `folderBtn.disabled = true` / `scanBtn.disabled = true` at entry and, in its `finally`, re-enables all three once its own load completes - with no awareness of a scan poll being in flight.

**Invariant hit:** "A scan in progress disables Load/Load Folder/Scan Network until it resolves" (the entire stated purpose of `pollRunningScan`'s button-disable block) is not actually held for the duration of the scan when autoload races in after reattach has already disabled the buttons.

**Impact:** If `/api/snapshots` resolves after reattach has disabled the buttons and shown "Scanning (N found)...", `autoloadLastScan` -> `processSelectedFiles` still runs to completion: it replaces `globalTopologyData`/`loadedSnapshots` with the **stale archived snapshot**, shows `"Success! Mapped N nodes."` in green, and - critically - its `finally` block re-enables `loadBtn`/`loadFolderBtn`/`scanNetworkBtn` (scan-network.js's poll loop never re-disables them on subsequent ticks; it only sets `.textContent`). The user is left looking at stale data with all three buttons clickable while `scanNetworkBtn` still reads "Scanning (N found)...", and the buttons stay live for the remainder of the real scan (until the poll loop eventually completes and reloads for real). This directly enables P2SCAN-002 below (a legitimate click on the now-live Scan Network button during this window starts a second `pollRunningScan()` invocation).

**Repro (code trace, not executed - no server available in this pass):**
1. Complete one scan normally (so at least one archived snapshot exists on disk, satisfying `autoloadLastScan`'s precondition).
2. Start a new scan, then refresh the page while it's still running.
3. `DOMContentLoaded` fires; `resumeScanIfInProgress()` kicks off `fetch('/api/scan-network/status')`, `autoloadLastScan()` kicks off `fetch('/api/snapshots')` in the same tick. Both resolve well before the fleet crawl itself finishes (that's the whole reason reattach/polling exists).
4. Neither function's guards depend on the other in any way that would stop this: `autoloadLastScan` never reads `scanNetworkPollTimer`, and `pollRunningScan`/`resumeScanIfInProgress` never touch `loadedSnapshots`/`loadFilesGeneration` until the scan is done. So `autoloadLastScan` proceeds unconditionally to `processSelectedFiles(files)` with the old, pre-refresh archived snapshot.
5. Observe: status line flips to green "Success! Mapped N nodes" showing the stale snapshot, and Load/Load Folder/Scan Network become clickable again while `scanNetworkBtn`'s text still says "Scanning (...)..." - deterministically, on this refresh and every other mid-scan refresh under the same preconditions.

**Fix sketch:** Give `autoloadLastScan` (and `processSelectedFiles`'s button-reenable in `finally`) an explicit check against `scanNetworkPollTimer` (or a shared "scan reattach/poll active" flag `resumeScanIfInProgress`/`pollRunningScan` set synchronously before any await), and bail the same way the `loadedSnapshots.length > 0` check already does. Alternatively, `await window.resumeScanIfInProgress()` fully before calling `autoloadLastScan()`, and have `resumeScanIfInProgress` synchronously mark "a poll owns the load buttons now" before its own status fetch even starts, so `autoloadLastScan`'s pre-fetch guard can see it regardless of resolution order.

---

## P2SCAN-002

**Track:** CORE (concurrency / shared mutable state)

**File:line:** web-src/scan-network.js:73-137 (`pollRunningScan`), :4 (`scanNetworkPollTimer` declaration)

**Severity:** Medium-High

**Confidence:** High

**Claim:** `pollRunningScan()` has no re-entrancy guard and no per-invocation identity. If it is called twice while a scan is in flight (concretely reachable via P2SCAN-001, since that bug leaves `scanNetworkBtn` clickable while a real scan is still running - clicking it with `loadedSnapshots.length > 0` now true routes through the "already loaded" confirm-modal branch of `startNetworkScan`, POSTs, gets a 409 from the still-running scan, and calls `pollRunningScan()` a second time), the two independently-running `poll()` closures share the single module-level `scanNetworkPollTimer` variable both as "the current pending timer" and as the mutex `finish()` uses to know whether to `clearTimeout`. Whichever loop's `finish()` runs first executes `clearTimeout(scanNetworkPollTimer)` using whatever value that shared variable currently holds - which, after both loops have each done at least one `setTimeout(poll, 2000)`, is the *other* loop's timer id, not its own. That silently cancels the other loop's next tick with no error, no log, and no way for that loop to know it was killed.

**Trigger:** Two overlapping `pollRunningScan()` calls in the same page load (see P2SCAN-001 for a concrete, non-contrived path to this - no unusual typing speed required, just an ordinary click on a button the UI wrongly left enabled).

**Evidence:**
- `web-src/scan-network.js:4`: `var scanNetworkPollTimer = null;` - one shared, non-namespaced variable for the whole module.
- `web-src/scan-network.js:78-84` (`finish`, defined fresh per `pollRunningScan()` call but closing over the *same* shared var):
  ```js
  function finish(msg, color) {
      if (scanNetworkPollTimer) { clearTimeout(scanNetworkPollTimer); scanNetworkPollTimer = null; }
      ...
  }
  ```
- `web-src/scan-network.js:116-120`: each loop's `poll()` does `scanNetworkPollTimer = setTimeout(poll, 2000);` - the second loop's assignment silently overwrites the first loop's id in the shared variable, so the first loop's timer becomes unreachable/uncancelable by its own `finish()`, while the second loop's `finish()` can cancel a timer that isn't its own once a third overwrite happens, etc. There is no per-call token/generation (contrast with `loadFilesGeneration` in app.js, which exists specifically to solve this class of problem for `processSelectedFiles`).

**Invariant hit:** "Only one poll loop drives the Scan Network button/status at a time" - never explicitly stated but implied by the single shared timer var and single `scanNetworkBtn` target; broken once two loops coexist.

**Impact:** Depending on interleaving, one of the two loops gets its pending `setTimeout` silently cancelled and simply stops ticking. The condition that makes this user-visible: the *surviving* loop must exit via an error/terminal path (a transient `fetch` failure, a 404 from a server restart, or any non-`running` response reaching a loop whose own next tick was the one that got cancelled instead) rather than the `complete` branch - if the survivor happens to be the one that reaches `complete` first, it still loads the real result via `processSelectedFiles` and the dead loop is harmless (its own pending tick simply never fires, silently, but nothing depended on it). When the survivor exits via an error path instead, `finish()` re-enables the buttons and shows a red/orange status that doesn't reflect the real scan (which may still be running or may have completed with the *other*, now-dead loop never having found out) - so with two loops alive, a single transient blip on *either* one's poll tick can tear down button state and status for both, even though the scan itself is fine server-side. A manual page refresh recovers (reattach re-checks server state fresh), but nothing on-page indicates that's necessary.

**Repro (code trace):** Same as P2SCAN-001 steps 1-5, then click the now-enabled "Scan Network" button. `startNetworkScan` (scan-network.js:167) sees `loadedSnapshots.length > 0` (true, from the stale autoload), shows the replace-confirm modal pre-filled from the stale snapshot's computed root, POSTs on confirm, gets 409 (a scan is genuinely still running), and calls `pollRunningScan()` a second time (scan-network.js:217) while the original reattach-triggered loop (from resumeScanIfInProgress) is still alive. Both loops' `scanNetworkPollTimer` writes now race as described above.

**Fix sketch:** Give each `pollRunningScan()` invocation its own generation token (same pattern as `loadFilesGeneration`), stored in a module-level counter; `finish()` and the `setTimeout` continuation should check "am I still the current poll generation" before acting, and a new `pollRunningScan()` call should bump the generation (and optionally `clearTimeout` the previous one explicitly) rather than letting two independent chains write through the same variable un-coordinated. Simpler alternative: make `pollRunningScan()` a no-op / early-return if a poll is already active (`if (scanNetworkPollTimer) return;`), since reattach and a 409-triggered retry are both trying to converge on the same server-side job anyway.

---

## Other categories checked, nothing survived scrutiny

- **UX-001 confirm-modal skip/show correctness (all triggers):** Traced every path that can reach `startNetworkScan` - direct click, native Enter/Space activation on the `<button>` (no custom keydown handler needed or present; browsers fire `click` for buttons natively), the 409-retry path, and the reattach path (`resumeScanIfInProgress`, which bypasses the modal entirely by design since it isn't starting a new scan). Modal-skip logic is a single `loadedSnapshots.length === 0` branch and is correct on its own terms; the only way it produces a wrong outcome is via P2SCAN-001's stale-snapshot autoload artificially flipping `loadedSnapshots.length` from 0 to >0 mid-scan, which is that finding, not a separate one.
- **SEC-2 (`textContent` conversion):** Diff is a straight `innerHTML` -> `textContent` swap with matching CSS (`#fatal-error-text { white-space: pre-wrap; ... }`, index.html:194) that still renders the `\n`-joined fields on separate lines. No regression; code comment says "pre-line" but the actual CSS property is `pre-wrap` - functionally equivalent for this purpose (also preserves the newlines), so not worth a finding on its own.
- **UX-005b (`aria-selected` wiring for sidebar tabs) and the parallel drawer-tab attributes added in the same diff:** `window.switchSidebarTab` (app.js:245-250) now toggles `aria-selected` correctly, matching the pre-existing `window.switchTab` (drawer.js:14-19) pattern the diff extended to `.tab`/`.sidebar-tab` elements consistently. No gaps found.
- **Confirm-modal accessibility (new territory, not previously flagged):** The modal (`#scan-start-ip-modal`, index.html:484-497) has no `role="dialog"`/`aria-modal="true"`, and Escape-to-cancel only works while focus is inside the text input (keydown listener is attached to `#scan-start-ip-input` only, scan-network.js:55) - tabbing to Cancel/Confirm and pressing Escape does nothing. Not flagged as a P2 finding: this is the exact same pattern already used by the pre-existing `promptForPassword` modal (app.js:121-156, identical single-input-only keydown wiring), so it's a pre-existing codebase convention this diff reused rather than something UX-001 introduced.
- **Localization / hardcoded strings:** All new user-facing strings (modal description text, status messages, `aria-label="Close"`) are plain English literals consistent with the rest of the file; no i18n mechanism exists anywhere else in the codebase to be inconsistent with.
- **`startNetworkScan`'s 409 body parse (scan-network.js:207, `var result = await resp.json();`, outside any inner try, unlike `pollRunningScan`'s guarded `.json()` at scan-network.js:104-110):** checked whether the server's 409 response could have an empty/non-JSON body and push this into the outer `catch` (bypassing the reattach branch entirely, defeating UX-002). Verified against `lib/WebServer.ps1`: `Invoke-ScanNetworkAction`'s 409 (line 473) goes through `Send-WebJson`, which always serializes a real JSON object (falling back to its own `{error: ...}` JSON on a serialization failure, WebServer.ps1:35-49) and never emits an empty/non-JSON body. Not a bug.
- **`status.visited` (scan-network.js:117, :162) vs `status.visitedCount` (scan-network.js:133) field-name consistency:** checked whether the client references a field name the server never emits. Verified against `lib/WebServer.ps1:584` (`running` status: `visited = $Job.ProgressTable.Visited`) and `:560` (`complete` outcome: `visitedCount = $Payload.VisitedCount`) - the client's two different field names exactly match the two different server payload shapes for those two states. Not a bug.
- **`bestStartIpFromActiveSnapshot` / IP prefill correctness:** Returns `null` cleanly when `globalTopologyData` is empty (falls back to blank input, no prefill-select crash); no bug found in the graph-root computation path added here since it only calls existing, unmodified `TopologyGraph`/`GraphLayout` helpers.
