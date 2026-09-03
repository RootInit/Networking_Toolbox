# Pass 3 — USER-FACING findings (web-src/drawer.js, web-src/index.html, web-src/map.js, web-src/dashboard.js, lib/Network_Visualizer.html, web-src/utils.js)

Scope per dispatch: re-verify Pass 2's P2DASH-001/002 (drawer-tab selector scoping + toggle
ARIA/keyboard wiring) and P2DASH-003 (third reboot-state) fixes for self-introduced bugs, plus a
fresh look at these files. `git show 56edb1e` and `git show 92db6cc` reviewed in full.
Regenerated `lib/Network_Visualizer.html` via `node web-src/tools/build-inline.mjs` and diffed
byte-for-byte against the committed version to check for build drift — **identical, no drift**.
Full test suite re-run clean: 91/91 passing.

---

## P3UX-001

- **Track**: USER-FACING
- **File:line**: `web-src/dashboard.js:160-177` (rebootCheckPossible / anyUptimeUsable gate),
  interacting with `web-src/app.js:307` (`scanTimestamp: data.ScanTimestamp || null`)
- **Severity**: MEDIUM
- **Claim**: P2DASH-003's fix (commit `92db6cc`) added `anyUptimeUsable` to distinguish "no
  device had usable Uptime" from a genuine zero-reboot result, but only validates the *device*
  side of the elapsed-time computation. It never validates that `activeSnapshot.scanTimestamp`
  itself parses to a real date. `rebootCheckPossible` is a bare truthiness check
  (`!!(activeSnapshot && activeSnapshot.scanTimestamp)`), not a parse-validity check. If
  `scanTimestamp` is present but unparseable, `new Date(activeSnapshot.scanTimestamp).getTime()`
  is `NaN`; every device's `elapsedMin` becomes `NaN`, `NaN >= 0` is `false` for all of them, so
  `recentlyRebooted` stays empty — while `anyUptimeUsable` is still set `true` (it only checks
  `bootTime`, not `snapTime`). The render falls through past both new/existing guards straight to
  `recentlyRebooted.length === 0 ? 'None.'`, presenting a bogus computation as a genuine
  zero-reboot result — the exact INV-UI-TRUTH failure class P2DASH-003 was written to close, just
  moved to the other operand of the same subtraction.
- **Repro path**: Confirmed via direct simulation of the exact dashboard.js logic (`node -e`):
  `new Date("not-a-real-timestamp").getTime()` → `NaN`; with a valid device `Uptime`, `elapsedMin`
  comes out `NaN`, `NaN >= 0` is `false`, `recentlyRebooted` stays `[]`. Concretely reachable: any
  file the user loads via the sidebar's "Load File" flow reaches `app.js:307` with zero format
  validation on `ScanTimestamp` — `data.ScanTimestamp || null` accepts any truthy string. A hand
  edited, corrupted, or older/foreign-format snapshot JSON with a non-ISO or truncated
  `ScanTimestamp` field (still present, so truthy) reproduces this on the very next dashboard
  render for that snapshot.
- **Suggested fix direction** (not applied — read-only pass): gate `rebootCheckPossible` (or add a
  parallel check) on `!isNaN(new Date(activeSnapshot.scanTimestamp).getTime())`, not just
  presence, mirroring the same validity discipline P2DASH-003 already applies to `d.Uptime`.
- **Corroborating context (checked, not double-counted as a separate finding)**: the *other*
  in-scope consumer of the same `scanTimestamp` field, `window.renderCrawlAge`
  (`web-src/utils.js:110-121`, called from `app.js:82` with `snapshot.scanTimestamp`), does
  validate parseability (`isNaN(scanDate.getTime())`) and correctly renders "Capture time unknown
  (file predates this field)" for the identical unparseable input. So on a snapshot with a bad
  `scanTimestamp`, the operator sees one correct signal (the crawl-age badge) side-by-side with
  one incorrect one (the dashboard's "None." for Recently Rebooted) — a real internal
  inconsistency for the exact same corrupt field, not merely a theoretical gap; it doesn't
  invalidate the finding, but explains why it's calibrated MEDIUM rather than HIGH (a vigilant
  operator has one honest cue elsewhere on the same page). Out-of-scope-but-related: skimmed
  `web-src/persistence.js:236-259` (`updateAlarmHistory`, feeds the Reliability heatmap's
  `rebooted` flag) — it uses the same unvalidated `snapshot.scanTimestamp` as a history bucket key
  (`.slice(0, 10)` on whatever string is there) and shares this root cause, but its own reboot
  *detection* logic (consecutive-snapshot `Uptime` string inequality, gated on a non-null
  `prevUptime`) correctly excludes the first-seen snapshot the same way `dashboard.js:410` does.
  Not filed as a P3UX finding since `persistence.js` is outside this pass's assigned file list.

---

## P3UX-002

- **Track**: USER-FACING (accessibility/ARIA correctness)
- **File:line**: `web-src/index.html:697-699` (Diagram/Map toggle: `role="button"` +
  `aria-pressed`), contrasted with `web-src/index.html:771-779` (drawer tabs: `role="tab"` +
  `aria-selected`, same commit `56edb1e`)
- **Severity**: LOW/INFO (assistive-tech usability nuance — see explicit caveat below on why this
  is *not* a "swap the role" fix)
- **Claim**: The Diagram/Map toggle is a mutually-exclusive, always-exactly-one-active 2-way
  switch — behaviorally identical to the drawer's 7-way tab strip added in the *same* commit and
  the sidebar's 4-way tab strip (`role="tab"`/`aria-selected`, from Pass 1). P2DASH-001/002 gave
  the Diagram/Map pair `role="button"` + `aria-pressed` instead, whose semantics (independently
  toggleable state, like a bold/italic toolbar button) don't quite describe two elements whose
  pressed state is coupled (clicking one always flips the other). **However — and this is the
  reason the fix direction is not simply "use role=tab instead"**: none of the three tab-like
  strips in this file (drawer tabs, sidebar tabs, or this toggle) sit inside a `role="tablist"`
  container — confirmed by grepping the whole file for `tablist`, zero matches. A `role="tab"`
  element is only valid ARIA when owned by a `role="tablist"` ancestor; an orphan `role="tab"` div
  is arguably *worse* than what's currently on the toggle, not better. So the drawer/sidebar tabs
  are not themselves a complete, correct tab implementation to hold this toggle consistent with —
  matching them would mean matching an already-incomplete pattern. As shipped, `role="button"` +
  `aria-pressed` on a focusable, keyboard-operable div is at least internally consistent and does
  announce a real name/role/state today, which may make it the safer of the two incomplete
  options rather than the wrong one. The real gap is that neither pattern is finished anywhere in
  this UI: a correct fix has to build out one complete pattern (a `role="tablist"` wrapper with
  roving `tabindex` and `aria-controls` linking each tab to its panel, applied consistently to all
  three strips; or `role="radiogroup"`/`role="radio"` for the 2-way toggle specifically) rather
  than a one-attribute role swap on just this element.
- **Repro path**: Read `web-src/index.html:697-699` vs `:771-779` directly — same commit
  (`56edb1e`), same visual `.tabs`/`.tab` styling, different roles for structurally identical
  toggle-group behavior. `command grep -n "tablist" web-src/index.html` returns no matches,
  confirming no tab strip in this file (old or new) has a valid tablist container — this is a
  pre-existing gap (not introduced by Pass 2) that limits what "consistent with the rest of the
  UI" can honestly mean here, so this is filed as LOW/INFO calibration context rather than a
  clear-cut MEDIUM defect.
- **Not a finding**: the keyboard wiring itself is mechanically correct — `activateOnKey`
  (`web-src/utils.js:25-30`) fires on both `Enter` and `Space`/`Spacebar`, calls the passed
  closure, and both `onkeydown` handlers in `index.html:698-699` correctly close over
  `window.switchCenterView('diagram')` / `('map')` respectively. `map.js`'s `switchCenterView`
  (`web-src/map.js:31-32`) unconditionally sets `aria-pressed` on both buttons on every call
  (stronger than "only when the view changes" — idempotent, no state can drift), and the initial
  HTML (`aria-pressed="true"` on Diagram, `"false"` on Map) matches `app.js:63`'s
  `activeCenterView = 'diagram'` default with no init-time desync.

---

## Re-verified clean (no new bug found)

- **`#drawer-tabs` selector scoping (task item 1)**: Read the full `index.html` fresh. Exactly 7
  `.tab` elements exist inside `#drawer-tabs` (`btn-tab-summary/stack/alarms/neighbors/
  interfaces/clients/config`, lines 772-779) and exactly 2 `.tab` elements exist outside it
  (the Diagram/Map toggle, lines 698-699, inside `#center-view-toggle`, not `#drawer-tabs`) — no
  other element anywhere in the page has class `.tab`. The sidebar's own 4-tab strip uses class
  `.sidebar-tab` (distinct token) and the Analysis panel's 7-tab strip uses `.analysis-tab`
  (distinct token) — neither collides with the bare `.tab` selector, scoped or not. Grepped all of
  `web-src/*.js` for any dynamic `classList.add('tab')`/`className` assignment that could insert a
  `.tab`-classed element into `#drawer-tabs` at runtime — none exists; every `.tab`/`.tab-content`
  element is static markup in `index.html`. `drawer.js:15`'s `.tab-content` selector is likewise
  unscoped but safe: grepped `index.html` for `class="tab-content"` and found only the same 7
  drawer-tab-content divs (`sidebar-tab-content`/`analysis-tab-content` are distinct class
  strings, not substring matches CSS would confuse). Pass 2's "confirmed all 7 drawer tabs live
  inside #drawer-tabs" claim holds, and the reverse-collision risk (something else newly landing
  inside #drawer-tabs, or something outside it wrongly matching the old bare selector) does not
  currently exist.
- **Reboot-marker "first snapshot" edge case (task item 3's literal suggestion)**: The trend
  chart's independent reboot-marker pass (`dashboard.js:398-419`, comparing consecutive
  snapshots' `Uptime` via string inequality — the mechanism referenced in prior-session memory as
  "correct as written") starts its loop at `di = 1`, correctly skipping the first snapshot in a
  device's sorted history (no false marker drawn for "no previous Uptime to compare against").
  This is a different code path from P2DASH-003's fix (which needs no "previous" snapshot at all —
  it only compares one snapshot's device `Uptime` against that same snapshot's `scanTimestamp`)
  and was not touched by the Pass 2 diff. No bug found here; the actual "fourth case" that
  survives scrutiny is P3UX-001 above (unparseable `scanTimestamp`, not a missing-previous-
  snapshot issue).
- **`switchCenterView`'s aria-pressed sync**: unconditional per-call write, not gated — cannot
  drift out of sync with `.active` class or view state. Checked.
- **Build artifact freshness**: `lib/Network_Visualizer.html` regenerated from current
  `web-src/index.html` + `*.js` via the real `build-inline.mjs` and diffed byte-identical against
  the committed file. No hand-edit drift this pass (this was the exact failure mode of the earlier
  UX-005b finding — confirmed not recurring).
- **Full test suite**: 91/91 passing, no regression.
