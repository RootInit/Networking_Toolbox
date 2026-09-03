# Pass 2 findings — web-src/dashboard.js, web-src/drawer.js, web-src/utils.js

Scope: re-scan of these three files after 5c4058d (UX-004/UX-005/UX-006). `git show 5c4058d`
reviewed in full; index.html and app.js also read where the diff's own elements (tab strips,
`switchTab`/`switchSidebarTab`) required following the collision surface outside the three
files. Full suite still 91/91 after this review; `build-inline.mjs` rebuild of
`lib/Network_Visualizer.html` produced no diff (generated artifact is current).

---

## P2DASH-001

- **Track**: USER-FACING (INV-UI-TRUTH-adjacent: visible UI state goes stale/wrong, not data)
- **File:line**: `web-src/drawer.js:14-19` (`window.switchTab`), colliding with
  `web-src/index.html:698-699` (`#btn-center-view-diagram` / `#btn-center-view-map`)
- **Severity**: MEDIUM
- **Confidence**: HIGH
- **Claim**: `switchTab`'s `document.querySelectorAll('.tab')` is not scoped to the drawer's
  own tab strip — it matches every element in the document carrying class `tab`, which
  includes the unrelated center-panel Diagram/Map toggle (`#center-view-toggle` at
  index.html:697-699, which also uses `class="tab"`/`class="tab active"`). Every drawer
  tab switch therefore also strips `.active` from whichever of Diagram/Map is currently
  highlighted, and — new in 5c4058d — now also stamps `aria-selected="false"` onto those
  two `<div>`s even though they carry no `role="tab"` (an invalid/orphaned ARIA state
  attribute; UX-005 never touched them). The codebase's own author was aware of exactly
  this hazard: index.html:253-259 documents that `.sidebar-tab` was deliberately given a
  *distinct* class from `.tab`/`.analysis-tab` "so querySelectorAll('.tab') must not
  collide across independent tab groups" — but the center-view-toggle pair was left
  sharing `.tab` with the drawer's own tab strip, so the exact collision the comment
  warns about still exists between those two groups.
- **Trigger**: Any call to `window.switchTab(tabId)` while the device drawer is open —
  not only a user clicking a drawer tab strip entry. `search.js:181`
  (`window.goToSearchResult`) calls `switchTab(tab)` whenever a `tab` argument is passed,
  and `dashboard.js`'s own `drillDownStat` (lines 850, 859, 869, 880, 891, 911) routes
  through `goToSearchResult(ip, 'tab-clients'|'tab-alarms'|'tab-interfaces'|'tab-config', …)`
  for the Clients/Alarms/Dot1x/Daisy-Chain/Config-Changed/No-Auth stat cards — so simply
  clicking one of those Analysis Dashboard cards fires the collision too, without the user
  ever touching the drawer's tab strip directly.
- **Evidence**:
  - `drawer.js:16`: `document.querySelectorAll('.tab').forEach(el => { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); })`
  - `index.html:698-699`: `<div class="tab active" id="btn-center-view-diagram" onclick="window.switchCenterView('diagram')">Diagram</div><div class="tab" id="btn-center-view-map" onclick="window.switchCenterView('map')">Map</div>` — same `.tab` class, no `role`/`tabindex`.
  - `index.html:253-259`: comment establishing the collision pattern was a known, deliberately-avoided hazard for the sidebar tabs — but not applied to the center-view toggle.
  - `map.js:29-30` (`switchCenterView`) independently and correctly toggles `.active` on just these two IDs by `getElementById`, so the visible Diagram/Map *panel* itself is unaffected — only the toggle's visual highlight (and now its ARIA state) goes wrong.
  - Provenance: the `classList.remove('active')` half of line 16 is pre-existing (5c4058d's diff only reformatted the existing one-line `forEach` into a block body to add the new `setAttribute` call) — the collision itself predates this commit, but 5c4058d is the first commit to write an ARIA attribute into it, turning a cosmetic glitch into an accessibility-invalid state.
- **Invariant hit**: INV-UI-TRUTH (dashboard/UI must not misrepresent current state — here, the visible Diagram/Map toggle shows neither tab as selected while one of them is actually showing) and the a11y intent of UX-005 itself (a screen reader now sees `aria-selected="false"` on a non-`role="tab"` element it was never told to track).
- **Impact**: Cosmetic-but-real: after opening the drawer via any tabbed entry point (a search result with a `tab-*` target, a drillDownStat card with a specific tab, or clicking any drawer tab by hand) and then switching drawer tabs, the center-view-toggle strip shows neither "Diagram" nor "Map" as active/underlined, even though one of the two panels is genuinely showing — self-corrects only the next time the user clicks Diagram or Map. Assistive tech querying `aria-selected` on the toggle divs now gets stale/false info on elements that were never declared as tabs to begin with.
- **Repro**:
  1. Load a topology so the graph/drawer are usable.
  2. Note the Diagram/Map toggle above the center panel — "Diagram" shows the active underline.
  3. Click any device node to open the drawer (defaults to the Summary tab).
  4. Click the "Hardware" tab in the drawer (or trigger `drillDownStat('clients')` from the Analysis Dashboard, which calls `goToSearchResult(..., 'tab-clients', ...)` → `switchTab('tab-clients')`).
  5. Observe the Diagram/Map toggle strip: neither button now carries the `active`-underline styling, and `document.getElementById('btn-center-view-diagram').getAttribute('aria-selected')` reads `"false"` despite Diagram still being the visible panel.
- **Fix sketch**: Scope `switchTab`'s selector to the drawer's own tab strip only (e.g. `document.querySelectorAll('#right-panel .tab')` or give the drawer tabs their own class like `.sidebar-tab` got, per the existing precedent at index.html:253-259) rather than a bare `.tab`. Land this before/together with any fix to P2DASH-002 below — adding `role="tab"`/`aria-selected` to the center-view-toggle without first de-scoping this selector would make a real tab's ARIA state get falsely zeroed on every unrelated drawer-tab switch, which is worse than the current "orphaned attribute on a non-tab div."

---

## P2DASH-002

- **Track**: USER-FACING (keyboard accessibility — same class of issue UX-005 targeted)
- **File:line**: `web-src/index.html:698-699` (center-view-toggle Diagram/Map), relative to the `activateOnKey` pattern added to every other `.tab`/`.sidebar-tab`/close-button element in `web-src/utils.js:25-30` + `web-src/drawer.js`
- **Severity**: MEDIUM
- **Confidence**: HIGH
- **Claim**: The center-view-toggle's Diagram/Map buttons are `<div class="tab" onclick="window.switchCenterView(...)">` with no `tabindex`, no `role`, and no `onkeydown="window.activateOnKey(...)"` — the exact click-only, keyboard-unreachable pattern UX-005 fixed for the drawer tabs, sidebar tabs, and drawer close button in this same commit, but this pair was never touched. A user relying on keyboard navigation can reach and activate every other tab-like control in the app (drawer tabs, sidebar tabs, drawer close) but cannot Tab to or activate the Diagram/Map center-view toggle at all — it's simply skipped in the Tab order.
- **Trigger**: Any keyboard-only or screen-reader user attempting to switch between the Diagram and Map center views without a mouse.
- **Evidence**: Compare index.html:698-699 (no `tabindex`/`role`/`onkeydown`) against every other `.tab`-classed element modified by 5c4058d, e.g. index.html:772 (`tabindex="0" role="tab" aria-selected="true" onclick="..." onkeydown="window.activateOnKey(event, () => window.switchTab('tab-summary'))"`) and the sidebar tabs at index.html:503-507 (same pattern). `git show 5c4058d` confirms only `dashboard.js`, `drawer.js`, `utils.js` were touched by the commit that added `activateOnKey`; `index.html`'s center-view-toggle markup is untouched history, so it was never brought in line with the new pattern applied everywhere else with the identical `.tab` class.
- **Invariant hit**: Same UX-005 keyboard-reachability intent this commit was explicitly written to satisfy, left incomplete for one control that visually and structurally matches every control that was fixed.
- **Impact**: A keyboard/screen-reader user cannot switch to the Map view (or back to Diagram) at all through this control — no alternate keyboard path exists elsewhere in the UI to toggle `activeCenterView`.
- **Repro**: Tab through the page from the top; observe focus lands on the drawer/sidebar tabs (now focusable per 5c4058d) but skips over "Diagram"/"Map" entirely — `document.getElementById('btn-center-view-map').tabIndex` is `-1`/unset, so it never receives focus via Tab, and even if focused programmatically, `Enter`/`Space` do nothing (no keydown handler bound).
- **Fix sketch**: Add `tabindex="0" role="tab" onkeydown="window.activateOnKey(event, () => window.switchCenterView('diagram'))"` (and the `'map'` counterpart) to index.html:698-699, matching the pattern used everywhere else in this diff. If `aria-selected` is added here too, also extend `switchCenterView` (map.js:21-30) to toggle it (it currently only toggles the `active` class) — and land P2DASH-001's selector fix first/together, since without it a newly-`role="tab"`'d pair here would have its `aria-selected` state falsely zeroed by every drawer tab switch (see P2DASH-001).

---

## P2DASH-003

- **Track**: USER-FACING (INV-UI-TRUTH)
- **File:line**: `web-src/dashboard.js:160-172` (`rebootCheckPossible` / recently-rebooted computation)
- **Severity**: MEDIUM
- **Confidence**: HIGH
- **Claim**: UX-006's fix gates `rebootCheckPossible` purely at the snapshot level
  (`!!(activeSnapshot && activeSnapshot.scanTimestamp)`), but the actual computation that
  populates `recentlyRebooted` is per-device and silently skips any device lacking usable
  `Uptime` data (`if (!d.Uptime || d.Uptime === "Unknown") return;` and the `isNaN(bootTime)`
  guard right after). If the active snapshot has a `scanTimestamp` but none of its devices
  have a parseable `Uptime` (e.g. a snapshot where every device failed to scan cleanly, or an
  older/partial capture that never recorded boot time), `rebootCheckPossible` is `true`,
  `recentlyRebooted` stays empty, and the panel renders `"None."` — indistinguishable from a
  genuine "checked every device, zero rebooted recently" result. This is the same
  data-absent-vs-negative-result conflation UX-006 was written to fix, reproduced one level
  down (per-device instead of per-snapshot) in the exact code the fix touched.
- **Trigger**: Load a snapshot whose `scanTimestamp` is present but whose devices all have
  `Uptime` missing/`"Unknown"`/unparseable — most concretely, a snapshot where every device's
  `ScanStatus` is non-`"Ok"` (dashboard.js:198's own `unreachableDevices` concept — a fully
  failed crawl still carries a top-level `scanTimestamp` written once per crawl, per
  utils.js:106-109's comment on `ScanTimestamp`). A partial version of the same defect also
  applies when only some devices lack `Uptime` (e.g. 18 of 20 devices unreachable) — the
  "None." message still reads as "fleet-wide zero," silently absorbing the un-checked devices.
- **Evidence**: dashboard.js:160 (`rebootCheckPossible` definition, snapshot-scoped) vs.
  dashboard.js:164 (`if (!d.Uptime || d.Uptime === "Unknown") return;`, device-scoped skip)
  and dashboard.js:166 (`if (isNaN(bootTime)) return;`) inside the same loop — none of these
  per-device skips affect `rebootCheckPossible`, so the two concepts ("can I check at all"
  vs. "did I actually check this device") were only reconciled at the snapshot granularity,
  not the device granularity the loop itself operates at.
- **Invariant hit**: INV-UI-TRUTH — this is the identical invariant UX-006's own commit
  message cites ("must not render the same as a genuine zero-result"), not satisfied for the
  case where the snapshot-level gate passes but no device individually contributes data.
- **Impact**: An operator sees "None." on the Recently Rebooted panel and reasonably reads it
  as "checked the fleet, nobody rebooted" when the real state is "couldn't determine uptime
  for any/most devices" — exactly the false-confidence failure mode UX-006 was meant to close.
- **Repro**: Construct/load a snapshot JSON with a top-level `scanTimestamp` set, and every
  `topology[].Uptime` either absent or `"Unknown"` (e.g. all devices show `ScanStatus:
  "Failed"` from a crawl that couldn't reach any switch). `renderFleetDashboard()` computes
  `rebootCheckPossible = true` (snapshot has a timestamp) but the `devices.forEach` loop
  contributes zero entries to `recentlyRebooted`, so the rendered HTML is
  `<p class="fleet-list-empty">None.</p>` — the same markup as a fleet that was fully checked
  and found clean.
- **Fix sketch**: Track how many devices actually contributed a valid `Uptime` reading (e.g.
  a `checkedCount` incremented only when both the `Uptime` and `isNaN(bootTime)` guards pass)
  and fold that into the empty-state message — e.g. "Unable to determine for N of M devices
  (no Uptime data)" when `checkedCount === 0` or is a small fraction of `devices.length`,
  distinct from the current "None." reserved for `checkedCount > 0` and zero hits.

---

## Reviewed and found correct (no finding) — task's explicit checklist items

- **`activateOnKey` (utils.js:25-30) itself is correct**: `event.preventDefault()` runs
  unconditionally before `fn()` for both `'Enter'` and `' '`/`'Spacebar'`, so Space on a
  focused tab/close-button does not also scroll the page. No caller passes an `fn` that
  itself depends on default behavior. No existing test (`grep` across `test/*.mjs` for
  `switchTab|activateOnKey|closeDrawer` returns nothing) exercises this path, and the full
  91/91 suite still passes unchanged — no interference with click-based behavior found.
  Coverage gap noted but not filed separately (already generically covered by the
  ledger's CFG-003-class concern; task asked for fewer, well-evidenced findings).
- **Tab/button tabindex+role vs. keydown-handler consistency**: every drawer tab, every
  sidebar tab, and the drawer close button that received `tabindex`/`role` in 5c4058d also
  received the matching `onkeydown="window.activateOnKey(...)"` in the same edit — no
  partial application found among files actually touched by the commit. The one real gap
  (center-view-toggle, which got neither) is filed above as P2DASH-002, and is outside the
  set of elements 5c4058d edited, not an inconsistency within the edit itself.
- **`thresholdLabel()` cannot diverge from `thresholdClass()`'s color at any of the three
  usage sites (CPU, Memory, IP-space)**: both CPU/Memory call sites (dashboard.js:143-152)
  share the identical `value >= critical ? A : (value >= warn ? B : C)` shape over the same
  `(value, warn, critical)` inputs, so they can never disagree, including under a
  misconfigured `warn > critical` setting (critical still wins in both branches). The
  IP-space usage (dashboard.js:740-741, `renderIpSpaceUtilization`) doesn't call the shared
  helpers at all — it duplicates the same three-way comparison inline as `pctClass`/
  `pctLabel` against the same already-rounded `pct`, so it likewise cannot mismatch today.
  Noted as INFO, not filed as a finding: the IP-space duplication (hardcoded 90/75 twice,
  once per variable, instead of reusing `thresholdClass`/`thresholdLabel`) is a latent risk
  if either copy is edited without the other in the future, but there is no current
  reproduction of an actual mismatch, so it doesn't meet this pass's bar for a finding.
- **Task hint 3's premise ("only one snapshot loaded, so no previous uptime to compare
  against") does not apply to the code UX-006 touched.** `recentlyRebooted`
  (dashboard.js:154-172) is a single-snapshot computation — `elapsedMin = (snapTime -
  bootTime) / 60000` against only the active snapshot's own `scanTimestamp` and each
  device's own `Uptime` (a boot timestamp, not a duration — consistent with the prior
  memory note on this field). It never reads a previous snapshot's `Uptime` and has no
  "not enough snapshots" failure mode. The consecutive-snapshot uptime *comparison* lives
  in `renderTrendChart`'s reboot markers (dashboard.js:387-412, comparing
  `deviceSnapshotsSorted[di-1].device.Uptime` vs. `[di].device.Uptime`), which is
  unchanged by 5c4058d and already independently guarded (loop simply doesn't execute
  with under 2 dated snapshots for that device — no misleading "None." text is rendered
  there at all, since that panel has no such state to render). The real per-device gap in
  the code UX-006 *did* touch is P2DASH-003 above, which is a different edge case than the
  one hinted at.
- **Generated artifact**: `lib/Network_Visualizer.html` rebuilt via the real
  `build-inline.mjs` and diffed clean against the committed copy — no drift between
  `index.html`/`web-src/*.js` and the served artifact for this diff.
