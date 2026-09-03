# Adversarial Verification — UX Audit Findings

Reviewer: verification pass (attempting to disprove each finding)

---

## UX-001 — Fleet-wide SSH crawl fires with zero confirmation

**Verdict: CONFIRMED**

Read `web-src/scan-network.js:58-115` in full. Confirmed exactly as claimed:
- When `loadedSnapshots.length > 0` (the common case), `startIp` is computed silently by
  `bestStartIpFromActiveSnapshot()` (line 71) with no user-facing prompt.
- The very next code executed is `fetch('/api/scan-network', {method:'POST', ...})` (line 102)
  inside the same `try` block — no modal, no `window.confirm()`, no intervening await on any
  user action.
- Searched the whole `web-src/` tree for `window.confirm(` / bare `confirm(` — zero hits. The
  only confirm-like pattern in the app is the promise-based `promptForStartIp()` modal
  (scan-network.js:7-46), and it is used **only** on the empty-snapshot path or as a defensive
  fallback when no root node can be computed (lines 64-69, 72-80) — never on the "snapshot
  already loaded" happy path that is the common case per the finding.
- Confirmed button adjacency in `web-src/index.html:512-515`: `loadBtn`, `loadFolderBtn`,
  `scanNetworkBtn` are three consecutive `<button>` siblings inside `#sidebar-tab-load`, with
  only inline `background`/`color` style differences (scan button is `var(--primary)` filled)
  — no divider, spacing, or grouping to signal escalating real-world impact.
- Checked "Categories checked with no surviving finding" section of the source audit — it only
  verified modals have exit paths (Cancel/Escape), not that a confirmation step exists before
  this specific action. Not a rebuttal.

No test coverage exists for this path (`web-src/test/*.mjs` has no scan-network tests).

This is a real, reachable, one-click path to firing live SSH sessions against every reachable
switch with no review step — matches High severity.

---

## UX-002 — Page refresh mid-crawl loses client poll state

**Verdict: CONFIRMED**

- `document.addEventListener('DOMContentLoaded', ...)` (app.js:369-371) calls only
  `window.autoloadLastScan()`, which fetches `/api/snapshots` (archived *completed* scans) —
  read the full function body (app.js:318-367): no call to `/api/scan-network/status` anywhere
  in it, and no other DOMContentLoaded/load listener exists in app.js, scan-network.js, or
  drawer.js that checks scan-in-progress status.
- `scanNetworkPollTimer` (scan-network.js:4) and `pollStart` (scan-network.js:117) are plain
  module-scoped `var`s with no persistence (no localStorage/sessionStorage backing) — confirmed
  lost on any reload.
- Backend genuinely persists the job server-side and 409s a duplicate start: confirmed at
  `lib/WebServer.ps1:463` — `Send-WebJson ... -StatusCode 409 -Object @{ error = "A network
  scan is already in progress"; ... }`. A `GET /api/scan-network/status` route does exist
  (`lib/WebServer.ps1:963`), so the server-side capability to reattach is present and unused
  by the client.
- Confirmed the generic 409 handling at scan-network.js:108-111: any non-ok response, 409
  included, falls into `finish("Could not start scan: " + (result.error || ...), "red")` —
  same red/failure treatment as a genuine error, no distinction for "already running, here's
  how to see it."

No mitigation found: no beforeunload warning, no localStorage flag marking a scan in flight, no
status-check on load. Matches High severity — operator has no way to distinguish "still running,
wait" from "safe to start," and a retry reads as an outright failure.

---

## UX-003 — Uncaught JS errors shown as raw stack dump

**Verdict: DOWNGRADED to Low**

Code matches the claim exactly (app.js:16-28, index.html:459-465): `window.onerror` builds
`Message/Line/Source/Stack` and dumps it verbatim into `#fatal-error-text`, preceded only by
the boilerplate sentence "The visualizer encountered a fatal error while processing the JSON
data."

However, applying the "nice to have" downgrade rule:
- This is the app's **only** channel for genuinely unexpected/unhandled exceptions — by
  definition, code paths that reach `window.onerror` are bugs the developers didn't anticipate,
  not routine operator-facing failure modes (contrast with UX-002's very real, routine "refresh
  during a scan" flow, or UX-001's routine misclick).
- The finding's own "Categories checked with no surviving finding" section notes the modal
  already has both a close button (`#fatal-error-close`) and a "Dismiss" button — i.e. it is
  not a dead end, and the operator's actual required action ("something broke, dismiss and
  retry/reload") is already recoverable without reading a word of the stack trace.
- The stack trace is genuinely useful (to a developer debugging a report) and is not shown in
  place of guidance — it's shown in place of *elaboration*. The heading "FATAL RENDER ERROR"
  plus "encountered a fatal error while processing the JSON data" already tells a technician
  the gist (something about the loaded data broke rendering) and the Dismiss button is the
  obvious next step.
- A network technician encountering this is very rare in practice (it requires an actual
  uncaught bug, not a normal operation), and the existing generic message + dismiss button is
  adequate, if inelegant, guidance. This is closer to "could be nicer" than "operator is stuck
  or misled."

Confirmed the underlying facts are accurate; downgrading because the impact is bounded (rare
trigger, already has a recoverable dismiss action, message isn't literally absent) — polish, not
a blocking usability defect.

---

## UX-004 — CPU/Mem/IP-utilization severity conveyed by color only

**Verdict: CONFIRMED (Medium)**

Verified line-by-line:
- `thresholdClass` (dashboard.js:143-145) and the IP-utilization inline equivalent
  (dashboard.js:727-728, `pctClass = pct >= 90 ? 'red' : ...`) both return only a CSS class
  name; the badge markup at dashboard.js:214, 219, and 732 renders `<span class="badge
  ${class}">${value}%</span>` with no `title`, no icon, no severity word.
- Checked the CSS (index.html:370-375): `.badge.red`/`.warn-badge`/`.green` differ only in
  `background-color` (#e74c3c / #d68910 / #27ae60) — genuinely color-only, no pattern/icon
  differentiation either.
- Verified the contrast claim against drawer.js: `stpBadge` (drawer.js:609) sets `green`/
  `red`/`gray` but the badge text itself is `esc(intf.STP)` i.e. the literal "FWD"/"BLK"
  string (drawer.js:620) — text and color both carry the state. `linkBadge` similarly renders
  `${Admin}/${Link}` as visible text (drawer.js:619). This confirms the finding's contrast is
  accurate: elsewhere in the same app, color is paired with a state word; here it isn't.
- No `title` attribute search hit on these three specific badges.

Checked whether "nice to have" applies: color-blind accessibility for a warn/critical medical-
grade distinction (orange vs. red, both plausibly appearing "orange-ish" to protanopia/
deuteranopia) is a legitimate, standards-recognized gap (WCAG 1.4.1), not a cosmetic wish — and
the fix is trivial (a `title` attribute costs nothing). A field technician who is colorblind or
reading a dim/bright screen genuinely cannot recover this information any other way in the UI.
Keeping at Medium as filed — this is a real, if narrow, accessibility gap with a cheap fix, not
inflated to High and not deflated to Low.

---

## UX-005 — Drawer/sidebar tabs and close button not keyboard-reachable

**Verdict: CONFIRMED**

Verified all cited elements:
- `index.html:503-506` (sidebar tabs), `index.html:756` (`.close-btn`), `index.html:770-777`
  (drawer tabs) — all `<div>`/`<span>` with only `onclick`, confirmed no `tabindex`, `role`, or
  `aria-*` attribute on any of them.
- Searched `web-src/app.js` and `web-src/drawer.js` for `keydown`/`tabindex`/`role=` — the only
  `keydown` handling in the whole app is the `scan-start-ip-modal` input field's own Enter/
  Escape handler (app.js:134-151), which is unrelated and does not generalize to tabs or the
  close button. No global document-level `keydown` listener exists (e.g. an Escape-to-close
  handler that might rescue the close button) — confirmed by the same grep returning nothing
  outside that one modal.
- `switchTab` (drawer.js:14-25) and `switchSidebarTab` (app.js:240-257) toggle only the
  `.active` CSS class — confirmed no `aria-selected` is ever set, matching the claim.
- Real click-path repro: with only Tab presses from anywhere in the document, focus moves
  between genuinely focusable elements (`<input>`, `<button>`, `<select>`) — `rescanBtn`,
  `pingBtn`, etc. next to the close button ARE real `<button>` elements and correctly receive
  focus, but the close button itself (`<span class="close-btn">`) and every `.tab`/
  `.sidebar-tab` (`<div>`) are skipped entirely. A keyboard-only or screen-reader user cannot
  switch tabs or close the drawer without a mouse — no alternate route exists (no keyboard
  shortcut, no menu).

No test coverage exists for this. Matches Medium severity as filed — real, broad (three
separate control groups), with a well-understood, low-effort fix (`tabindex="0"` + keydown, or
swap to `<button>`).

---

## UX-006 — "Recently Rebooted" shows identical "None." for zero-reboots vs uncomputable

**Verdict: CONFIRMED (Medium)**

Verified dashboard.js:149-161 and 222-225 exactly as quoted:
- `recentlyRebooted` is only ever populated inside `if (activeSnapshot &&
  activeSnapshot.scanTimestamp)` (line 150) — if `scanTimestamp` is falsy, the array stays `[]`
  with no distinguishing flag set anywhere.
- The render at line 222-225 branches only on `recentlyRebooted.length === 0` → `'<p
  class="fleet-list-empty">None.</p>'` — genuinely identical output whether the guard was never
  entered (uncomputable) or was entered and legitimately found zero matches.
- Verified the claimed contrast against the CPU/Memory sections immediately above (dashboard.js
  212-213, 217-218): those use `worstCpu.length === 0 ? 'No CPU data available.' : ...` /
  `'No memory data available.'` — these are actually a *different* case (empty result list from
  `worstBy()`, which filters devices lacking the field — not a structural "couldn't run the
  calculation at all" case), so the direct contrast is slightly loose, but it still correctly
  demonstrates the codebase's own established pattern of using a distinct string for "no data"
  vs. a generic empty-result state elsewhere in the very same function — reinforcing that the
  Recently Rebooted section is the outlier that skips this pattern entirely.
- Cross-checked against the user's own memory note
  (`pnm_uptime_field_is_boot_timestamp.md`) confirming `Uptime` semantics are intentional and
  correct — this finding doesn't touch that; it's specifically about the `scanTimestamp`-missing
  case, a different and real gap.

Checked "nice to have" bar: this is the same INV-UI-TRUTH failure class as the prior verified
Uptime bug per project history — presenting "never checked" identically to "checked, found
none" is a genuine misinterpretation risk for an operator making a real judgment call (e.g.
"did anything reboot after I pushed that change?"), not cosmetic. Confirmed at Medium as filed.

---

## Summary

| ID | Verdict | Severity (final) |
|----|---------|-------------------|
| UX-001 | CONFIRMED | High |
| UX-002 | CONFIRMED | High |
| UX-003 | DOWNGRADED | Low (was Medium) |
| UX-004 | CONFIRMED | Medium |
| UX-005 | CONFIRMED | Medium |
| UX-006 | CONFIRMED | Medium |
