# USER-FACING Audit Findings — Phase 1
Scope: web-src/dashboard.js, web-src/drawer.js, web-src/app.js, web-src/index.html
Reviewer: Phase 1 (read-only)

---

## UX-001

**Track:** USER-FACING
**File:line:** web-src/scan-network.js:70-81 (`window.startNetworkScan`), triggered from web-src/index.html:515 (`#scanNetworkBtn`)
**Severity:** High
**Confidence:** High

**Claim:** When a topology is already loaded, clicking "Scan Network" immediately launches a real SSH-based fleet crawl against production switches with zero confirmation step — no dialog, no "are you sure," not even the IP-entry prompt that the no-snapshot path shows.

**Trigger:** Operator has any snapshot loaded (the common case — the tool is opened, a scan is on screen) and clicks the "Scan Network" button, which sits directly below "Load Folder of Snapshots" in the left panel (index.html:512-515), i.e. three stacked buttons of increasing real-world impact with no visual separation beyond one button's blue fill.

**Evidence:**
```js
// scan-network.js:58-81
window.startNetworkScan = async function() {
    ...
    if (loadedSnapshots.length === 0) {
        try { startIp = await promptForStartIp(); } catch (cancelErr) { return; }
    } else {
        startIp = bestStartIpFromActiveSnapshot();   // <-- computed silently, no prompt
        if (!startIp) { ... }
    }
    ...
    var resp = await fetch('/api/scan-network', { method: 'POST', ... });  // fires immediately
```
`bestStartIpFromActiveSnapshot()` auto-picks the graph-center node and the POST to `/api/scan-network` fires on the very next line — no modal, no review step. Per AUDIT_LEDGER.md, `/api/scan-network` drives `FleetCrawl.ps1`, which opens real SSH sessions to every reachable switch in the fleet.

**Invariant hit:** INV-CMDPATH (viewed from the UI: nothing prevents an accidental client-side trigger of a real command-and-control operation against the whole fleet).

**Impact:** A misclick (adjacent buttons, no confirmation) starts a live crawl touching every switch in the topology — SSH connection attempts, CLI command execution, and elevated logging/auth noise on production gear — with no way to preview or abort before it starts. During an incident, an operator moving quickly between "Load Folder" and "Scan Network" is exactly the person most likely to fat-finger this.

**Repro:** Load any snapshot → click "Scan Network" → crawl starts immediately (confirm via `/api/scan-network` request firing on click, no intervening dialog).

**Fix sketch:** Add a lightweight confirmation step (reuse the existing modal pattern already used for `scan-start-ip-modal`/`password-modal`) showing the computed start IP and an explicit "Start Scan" confirmation, even when a snapshot is already loaded — not just when no snapshot exists.

---

## UX-002

**Track:** USER-FACING
**File:line:** web-src/scan-network.js:58-165, web-src/app.js:369-371 (`DOMContentLoaded` → `autoloadLastScan`)
**Severity:** High
**Confidence:** High

**Claim:** If the browser tab is refreshed/reopened while a fleet crawl is in progress, the UI has no mechanism to detect and reattach to that in-flight job — it silently reverts to an idle state, and if the operator then clicks "Scan Network" again, they get a raw-looking error instead of a resumed progress view.

**Trigger:** Operator starts "Scan Network," then refreshes the page (or the tab is closed/reopened) before the crawl finishes.

**Evidence:** The only code path that runs on load is `document.addEventListener('DOMContentLoaded', ...) → window.autoloadLastScan()` (app.js:369-371), which only fetches `/api/snapshots` (archived completed scans) — it never calls `GET /api/scan-network/status` to check for an already-running job. `scanNetworkPollTimer`/`pollStart` are plain module-level JS variables (scan-network.js:4,117) that are lost on reload. The backend does track a single global in-flight job and 409s a fresh start (`lib/WebServer.ps1:463`, `error = "A network scan is already in progress"`), but on the client that 409 is handled generically:
```js
// scan-network.js:108-111
if (!resp.ok) {
    finish("Could not start scan: " + (result.error || ('HTTP ' + resp.status)), "red");
    return;
}
```
This paints a red "Could not start scan" status — reading as a failure — with no button or affordance to actually watch the still-running job's progress (that requires the client to already hold `scanNetworkPollTimer`/poll loop state, which was lost on refresh).

**Invariant hit:** INV-JOBS (as experienced from the UI) — the background crawl job genuinely outlives the browser tab correctly on the server side, but the UI does not correctly reflect that reality back to the operator.

**Impact:** After a refresh, an operator has no way to tell "a crawl is still running, wait" from "nothing is happening, it's safe to start one." The status line reads as an outright error rather than "in progress," and there is no route back to a live progress view — the operator must simply wait and guess, or repeatedly click and get the same red error, until the crawl finishes and its output eventually surfaces via `autoloadLastScan`/`/api/snapshots`.

**Repro:** Start "Scan Network" on a fleet large enough to take >5-10s → refresh the browser tab while `status: running` → UI shows "Waiting for file..." (idle) → click "Scan Network" again → red "Could not start scan: A network scan is already in progress" with no link to actual progress.

**Fix sketch:** On load (alongside `autoloadLastScan`), call `GET /api/scan-network/status` once; if a job is running, re-enter the same polling loop `startNetworkScan` uses instead of leaving the button idle, and reframe an "already in progress" 409 as informational (orange, "A scan is already running — reattaching...") rather than a red failure.

---

## UX-003

**Track:** USER-FACING
**File:line:** web-src/app.js:16-28 (`window.onerror`), web-src/index.html:459-465 (`#fatal-error-modal`)
**Severity:** Medium
**Confidence:** High

**Claim:** Any uncaught JavaScript error is surfaced to the operator as a raw technical stack trace with no plain-language explanation or suggested next step — exactly the "raw text/stack traces" anti-pattern the review explicitly calls out.

**Trigger:** Any uncaught client-side exception (e.g. a malformed snapshot field the code doesn't defensively handle, a null-deref in a rarely-hit code path).

**Evidence:**
```js
// app.js:16-28
window.onerror = function(message, source, lineno, colno, error) {
    if (IGNORED_ERROR_MESSAGES.test(message)) return true;
    var errText = `Message: ${message}<br>Line: ${lineno}:${colno}<br>Source: ${source}<br>Stack: ${error ? error.stack : 'N/A'}`;
    ...
    textEl.innerHTML = errText;
    modalEl.style.display = 'block';
```
The modal itself (index.html:461-462) only adds "The visualizer encountered a fatal error while processing the JSON data" — generic boilerplate — before dumping the full `Message/Line/Source/Stack` block verbatim.

**Invariant hit:** INV-UI-TRUTH-adjacent (error communication) — not a data-truth violation, but the review's explicit "error communication" criterion: is a backend/client error shown in a way the operator can act on?

**Impact:** A network technician (the stated user persona) is not the audience for a JS stack trace. There's no actionable guidance (which file/device triggered it, whether their data is safe, whether to retry/reload/report). This is the *only* channel for uncaught errors, so every one of them — regardless of underlying cause — reaches the operator this way.

**Repro:** Trigger any uncaught exception (e.g. via devtools: `throw new Error('test')` while the app is running) → fatal-error-modal shows the raw stack, no operator-actionable text.

**Fix sketch:** Keep the technical detail (useful for bug reports) but move it behind a collapsed "Technical details" section, and lead with a plain-language message plus a concrete next step (e.g. "Reload the page; if this keeps happening, note what you were doing and report it").

---

## UX-004

**Track:** USER-FACING
**File:line:** web-src/dashboard.js:143-145, 214, 219, 727-732
**Severity:** Medium
**Confidence:** High

**Claim:** Fleet Health's Highest-RE-CPU/Memory badges and the IP-Space-Utilization badge convey their warn/critical severity level through color alone — the visible text is only the raw percentage, with no textual severity label or icon.

**Trigger:** Open Analysis Dashboard → Fleet Health tab (worst CPU/memory over threshold), or → IP Space tab (subnet utilization over threshold).

**Evidence:**
```js
// dashboard.js:143-145
function thresholdClass(value, warn, critical) {
    return value >= critical ? 'red' : (value >= warn ? 'warn-badge' : 'green');
}
// dashboard.js:214
`<span class="badge ${thresholdClass(x.value, settings.cpuWarnPct, settings.cpuCriticalPct)}">${x.value}%</span>`
// dashboard.js:727-732
var pctClass = pct >= 90 ? 'red' : (pct >= 75 ? 'warn-badge' : 'green');
...
`<td><span class="badge ${pctClass}">${pct}%</span></td>`
```
No `title` attribute, icon, or text like "OK"/"WARN"/"CRITICAL" accompanies these badges — only the raw number rendered in a color-coded pill. (Contrast with e.g. `dot1xViolations`/`unreachableDevices` cards, or the interface Link/STP badges elsewhere in drawer.js, which always pair color with an actual state word like "up"/"down"/"FWD"/"BLK".)

**Invariant hit:** none of the six named invariants directly; matches the review's explicit "Accessibility: color-only status indicators" criterion.

**Impact:** A color-blind operator (or anyone reading a screen in bright daylight in the field, a plausible real scenario for network technicians) cannot tell from these badges alone whether a given CPU/memory/utilization number is fine, warned-about, or critical — they'd need to separately know and mentally apply `settings.cpuWarnPct`/`cpuCriticalPct`/the 75%/90% thresholds themselves.

**Repro:** Load a snapshot with devices whose `MasterCpuUtilization` spans the warn/critical thresholds → open Analysis Dashboard → Fleet Health → "Highest RE CPU" list shows only colored percentage pills, no severity word.

**Fix sketch:** Add a `title` attribute stating the severity ("Critical — above Xx%") and/or prefix the badge text with a short label ("CRIT 87%" / "WARN 62%").

---

## UX-005

**Track:** USER-FACING
**File:line:** web-src/index.html:770-777 (drawer tabs), 502-506 (sidebar tabs), 756 (`.close-btn`); web-src/drawer.js:6-25; web-src/app.js:240-257
**Severity:** Medium
**Confidence:** Medium-High

**Claim:** The primary navigation controls of the app — sidebar tabs, drawer tabs, and the drawer's close button — are built from non-interactive `<div>`/`<span>` elements with only an `onclick` handler, no `tabindex`, `role`, or keydown handler, and no `aria-selected` state. They are unreachable and unactivatable via keyboard alone.

**Trigger:** Attempt to operate the app using Tab/Enter/Space only (keyboard-only use, or a screen reader).

**Evidence:**
```html
<!-- index.html:756 -->
<span class="close-btn" onclick="window.closeDrawer()">&times;</span>
<!-- index.html:771-777 -->
<div class="tab active" onclick="window.switchTab('tab-summary')" id="btn-tab-summary">Summary</div>
...
<!-- index.html:503-506 -->
<div class="sidebar-tab active" id="btn-sidebar-tab-load" onclick="window.switchSidebarTab('sidebar-tab-load')">Load File</div>
```
None of these carry `tabindex="0"`, `role="tab"/"button"`, or a `keydown` handler for Enter/Space; `switchTab`/`switchSidebarTab` (drawer.js:14-25, app.js:240-257) only toggle `.active` classes, never set `aria-selected`.

**Invariant hit:** none of the six named invariants directly; matches the review's explicit "Accessibility: keyboard traps, focus management" criterion (broader than a literal trap: these controls are simply unreachable by keyboard, which is the more common real-world accessibility failure in this kind of hand-rolled UI).

**Impact:** An operator who cannot or does not want to use a mouse (RSI, a screen reader, keyboard-only workflow at a workstation) cannot switch drawer tabs, close the drawer, or switch sidebar tabs at all — there is no way to reach the equivalent functionality by keyboard elsewhere in the app.

**Repro:** Open the drawer for any device → press Tab repeatedly from the drawer header → focus never lands on the tab strip or the close button (only genuinely focusable elements like `<input>`/`<button>` receive it) → those controls cannot be activated without a mouse click.

**Fix sketch:** Convert these to real `<button>` elements (free keyboard focus + activation) or add `tabindex="0"`, `role="tab"`/`role="button"`, and a keydown handler mapping Enter/Space to the existing onclick logic; add `aria-selected` alongside the `.active` class toggle.

---

## UX-006

**Track:** USER-FACING
**File:line:** web-src/dashboard.js:147-161, 222-225
**Severity:** Medium
**Confidence:** High

**Claim:** Fleet Health's "Recently Rebooted" section renders the identical "None." empty state for two genuinely different situations: (a) no device actually rebooted recently, and (b) the calculation was never run at all because the active snapshot has no `scanTimestamp`. The operator cannot tell which one they're looking at.

**Trigger:** Load a snapshot (or a synthetic/manually-assembled one, e.g. from a partial/failed scan) whose `scanTimestamp` is missing or falsy, then view Analysis Dashboard → Fleet Health.

**Evidence:**
```js
// dashboard.js:149-161
var recentlyRebooted = [];
if (activeSnapshot && activeSnapshot.scanTimestamp) {
    ... // only populated inside this guard
}
...
// dashboard.js:222-225 (render)
html += '<div><div class="fleet-section"><h3>Recently Rebooted (&lt; ' + settings.recentRebootMin + ' min)</h3>' + (recentlyRebooted.length === 0
    ? '<p class="fleet-list-empty">None.</p>'
    : ...
```
Compare this to the CPU/Memory sections immediately above it (dashboard.js:212-220), which explicitly distinguish "no data available" (`'No CPU data available.'`) from a genuine empty result — the reboot section has no equivalent "couldn't be determined" message.

**Invariant hit:** INV-UI-TRUTH — the dashboard/map/graph must never present stale or misinterpreted device data as current truth; here, "unable to compute" is presented identically to "computed and found zero," which is a misinterpretation of an absent-data condition as a genuine negative result. This is squarely the failure mode INV-UI-TRUTH exists to catch (the same family as the previously-found `Uptime`-as-duration issue), just at the "missing timestamp" layer instead.

**Impact:** An operator reviewing fleet health after loading a snapshot with no `scanTimestamp` (e.g. an older/hand-edited file, or a snapshot type that doesn't set it) sees "None." under Recently Rebooted and reasonably concludes no devices rebooted — when in fact the tool never checked, because it structurally cannot without a snapshot timestamp to measure elapsed time against.

**Repro:** Load a snapshot JSON with `ScanTimestamp` omitted/null but otherwise valid `Topology` → Analysis Dashboard → Fleet Health → "Recently Rebooted" shows "None." indistinguishable from a snapshot where reboot data was actually checked and came back empty.

**Fix sketch:** Render a distinct message when `!activeSnapshot.scanTimestamp` (e.g. "Cannot determine — this snapshot has no scan timestamp") instead of falling through to the same "None." used for a genuine zero-result.

---

## Categories checked with no surviving finding
- **Dead-end/trap flows:** password-modal, scan-start-ip-modal both support Cancel + Escape; fatal-error-modal has an X and a Dismiss button. No modal found without an exit path.
- **Silent save failures:** clipboard/download/print actions in drawer.js all report failure explicitly (`window.setStatus(..., "red")`) rather than failing silently; rescan/ping/scan-network all report failure or discard-with-explanation rather than looking like silent success.
- **Layout shear (sibling of a238c3c):** the fix applied `overflow: clip` at both `html` and `body`, which structurally prevents any future `focus()`/`scrollIntoView()` call (including drawer.js's own `renderClients` highlight scroll) from shearing the page — confirmed this covers the mechanism, not just the one call site that triggered it.
