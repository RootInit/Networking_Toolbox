# Pass 2 adversarial verification — dashboard cluster

## P2DASH-001/002

**Verdict: CONFIRMED**

Read `web-src/drawer.js` and `web-src/index.html` directly.

- `web-src/drawer.js:16-18` — `window.switchTab`:
  ```js
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); });
  ```
  This is a bare `.tab` selector with no scoping to the drawer's own tab strip.

- `web-src/index.html:697-699` — the center-panel Diagram/Map toggle:
  ```html
  <div id="center-view-toggle" class="tabs" style="flex:0 0 auto;">
      <div class="tab active" id="btn-center-view-diagram" onclick="window.switchCenterView('diagram')">Diagram</div>
      <div class="tab" id="btn-center-view-map" onclick="window.switchCenterView('map')">Map</div>
  </div>
  ```
  Confirmed: same `.tab` class as the drawer's tab buttons (`web-src/index.html:772-779`, e.g. `<div class="tab active" tabindex="0" role="tab" aria-selected="true" ... id="btn-tab-summary">`). The center-view divs have **no `role`, no `tabindex`, no `onkeydown`/`activateOnKey`** — every other `.tab`-classed control in the file has all three (drawer tabs at 772-779, and sidebar tabs at 503-507, which deliberately use the *distinct* class `sidebar-tab` rather than `tab`, precisely avoiding this collision — confirms the claim that the author avoided it elsewhere but not here).

- Collision mechanism confirmed live: `switchCenterView` (`web-src/map.js:21-31`) toggles the Diagram/Map buttons' `active` class via `getElementById` + `classList.toggle`, independent of `switchTab`. But `switchTab` (called whenever a user clicks any drawer tab — Hardware/Alarms/Neighbors/etc., or via `search.js:181-182` jumping to a device+tab) unconditionally strips `active` from *every* `.tab` element, including whichever of `btn-center-view-diagram`/`btn-center-view-map` currently carries it, and stamps `aria-selected="false"` onto both.
  - `.tab.active` carries real visible styling: `web-src/index.html:356` — `.tab.active, .analysis-tab.active { color: var(--accent); border-bottom: 3px solid var(--accent); background: var(--panel-bg); }`.
  - Concrete repro: switch center view to Map (`btn-center-view-map` gets `.active`) → click a map marker or graph node to open the device drawer (`map.js:345` / `graph.js:152` call `openRightDrawer`) → click any drawer tab (e.g. "Hardware") → `switchTab` fires → `btn-center-view-map` loses its `.active` class and gets `aria-selected="false"` stamped on it (an element with no `role="tab"`, so this is invalid ARIA state on top of the visual bug). The map view keeps rendering correctly (display toggling lives in `switchCenterView`, untouched), but the toggle now shows *neither* Diagram nor Map as highlighted — a real, reachable, visible regression a sighted operator would notice, and a real ARIA correctness issue for a screen-reader user (unrelated non-tab elements gain `aria-selected`).
  - Keyboard-accessibility gap independently confirmed: the Diagram/Map toggle has no `tabindex`, so it is not reachable via Tab key at all, unlike every other interactive `.tab`/`sidebar-tab`/`role="button"` element in the page (which all went through the UX-005 fix in commit `804e8c6`/`5c4058d`).

All three sub-claims (selector collision, missing keyboard-accessibility treatment, invalid `aria-selected` stamped by the new write) hold exactly as described. No downgrade — severity MED/HIGH is reasonable given the combination of a visible styling regression plus a real accessibility defect on a highly-trafficked, always-visible control.

## P2DASH-003

**Verdict: CONFIRMED**

Read `web-src/dashboard.js` directly.

- `web-src/dashboard.js:160`: `var rebootCheckPossible = !!(activeSnapshot && activeSnapshot.scanTimestamp);` — gates only on snapshot-level `scanTimestamp` presence, exactly as claimed.
- `web-src/dashboard.js:161-169`, inside the per-device loop that only runs when `activeSnapshot.scanTimestamp` exists:
  ```js
  if (!d.Uptime || d.Uptime === "Unknown") return;
  var bootTime = new Date(d.Uptime).getTime();
  ...
  if (elapsedMin >= 0 && elapsedMin < settings.recentRebootMin) {
      recentlyRebooted.push({ device: d, elapsedMin: elapsedMin });
  }
  ```
  Any device with missing or `"Unknown"` `Uptime` is silently skipped (independent per-device gate, separate from `rebootCheckPossible`).
- Rendering (`web-src/dashboard.js:233-238`):
  ```js
  html += '<div>...<h3>Recently Rebooted...</h3>' + (!rebootCheckPossible
      ? '<p class="fleet-list-empty">Unable to determine (no scan timestamp on this snapshot).</p>'
      : recentlyRebooted.length === 0
      ? '<p class="fleet-list-empty">None.</p>'
      : recentlyRebooted.map(...).join('')
  ) + '</div></div></div>';
  ```
  Confirmed: there is no third state distinguishing "computed and genuinely zero reboots" from "computed over zero devices with usable Uptime data." A snapshot that has a `scanTimestamp` (crawl kicked off and the wrapper recorded a start/end time) but where every device's `Uptime` came back missing/`"Unknown"`/unparseable (e.g., a fully-failed crawl where devices were unreachable) renders the identical `<p class="fleet-list-empty">None.</p>` as a snapshot where every device really was up longer than `recentRebootMin`. This is a real, reachable ambiguity — a fully-failed crawl producing a timestamped-but-dataless snapshot is a plausible real-world scan-failure mode (network outage, credentials rotated, etc.), not a contrived edge case, and an operator reading "None." after a bad crawl would reasonably (and wrongly) conclude "no device rebooted" rather than "reboot status couldn't be determined."

No downgrade — MEDIUM severity as originally rated is appropriate: it's a silent-failure/misleading-empty-state class of bug (operator draws an incorrect conclusion from a crawl failure), not merely a cosmetic nicety.
