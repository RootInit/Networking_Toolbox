# Phase 1 Audit Findings — graph.js / graph-layout.js / elk-layout.js / map.js / utils.js / search.js / scan-network.js

Scope reviewed in full: web-src/graph.js, web-src/graph-layout.js, web-src/elk-layout.js, web-src/map.js,
web-src/utils.js, web-src/search.js, web-src/scan-network.js, plus web-src/test/graph-layout.test.mjs and
web-src/test/elk-layout.test.mjs to identify what's already covered (extensive radial-layout regression
coverage: angle-bucket cache correctness, divide-by-zero at minRadius=0, deadline/timeout handling,
disconnected-island layout, spread-by-size, leaf/non-leaf fast paths — none of that is re-reported here).

Also spot-checked topology-graph.js (out of scope, but feeds graph.js/map.js data) for self-referencing
LLDP neighbor edges (a device listing itself) — confirmed handled safely: computeVisibleTree's secondary-edge
rendering pass in graph.js (`if (!from || !to || from === to) return;`) already discards a self-loop edge
before it reaches vis-network, so this is not reported as a bug.

---

## GRAPH-001

- **Track**: USER-FACING
- **File:line**: web-src/map.js:280-290 (renderMapMarkers teardown) and web-src/map.js:355-383 (Edit
  position arm) and web-src/map.js:329-337 (marker click handler)
- **Severity**: Low
- **Confidence**: High
- **Claim**: A `leafletMap.once('click', marker._disarmOnMapClick)` listener registered when the user arms
  "Edit position" drag-to-reposition on a map marker is never removed except by that exact marker's own
  successful `dragend`. Every other way of leaving the armed state — clicking the armed marker itself
  instead of dragging it, or `renderMapMarkers()` tearing down and rebuilding all markers while one is
  still armed — leaves the stale listener registered on `leafletMap`, referencing the now-orphaned marker
  object.
- **Trigger**:
  1. Click a placed marker's popup → "Edit position" (arms dragging, registers the `once` listener at
     map.js:382).
  2. Either (a) click the same marker again (its own `click` handler at map.js:329 disables dragging and
     resets `currentlyArmedMarker` but never calls `leafletMap.off('click', marker._disarmOnMapClick)`), or
     (b) trigger any of the several `renderMapMarkers()` call sites while still armed — e.g. rescan a single
     device from the drawer (drawer.js:462 calls `window.renderMapMarkers()` after every merge-rerender),
     change the VLAN filter (graph.js:323 calls it first thing in `applyVlanFilter`), or switch/load a
     snapshot (app.js:86). `renderMapMarkers()`'s teardown (map.js:285-290) removes every marker layer and
     resets `currentlyArmedMarker = null`, but never calls `leafletMap.off('click', ...)` for whatever
     `_disarmOnMapClick` closure was pending from the marker just destroyed.
- **Evidence**: map.js:280-290 removes/clears all markers and resets `currentlyArmedMarker` with no
  corresponding `leafletMap.off('click', ...)`. Contrast with the deliberate, explicit cleanup pattern used
  a few lines below for the *same* class of listener on a successful drag (map.js:395-398:
  `if (marker._disarmOnMapClick) { leafletMap.off('click', marker._disarmOnMapClick); marker._disarmOnMapClick = null; }`),
  which proves the author intended every arm to be paired with an eventual `off()` — this path just isn't
  reachable from teardown or from the marker's own click handler.
- **Invariant hit**: none of the six listed invariants directly (this is a map.js hygiene/leak bug, not
  INV-UI-TRUTH — no wrong data is shown). Flagged because it's explicitly one of the review categories
  requested ("map.js: ... event listener leaks on repeated re-render").
- **Impact**: Each stale listener is a Leaflet `once` handler, so it self-removes the next time the user
  clicks anywhere on the empty map — at that point it calls `.disable()` on an already-detached marker
  object (a no-op in Leaflet, since `Draggable.disable()` checks its own `_enabled` flag) and a
  `currentlyArmedMarker === marker` comparison that's already false post-reset. So in the common case this
  is inert — no visible symptom, no crash — but it is a genuine accumulating leak: repeatedly arming
  "Edit position" on different markers across several rescans/filter-changes without an intervening plain
  map click builds up multiple dangling listeners simultaneously, all referencing orphaned marker/device
  closures that would otherwise be garbage-collected.
- **Repro**: In a session with the Map view open and at least one placed device: open a marker's popup →
  "Edit position" → without dragging, click a *different* pending action that calls `renderMapMarkers()`
  (e.g. change the VLAN filter dropdown, or rescan any device from the drawer). Inspect Leaflet's internal
  `leafletMap._events.click` array (or instrument `leafletMap.once`) before/after — the old marker's
  `_disarmOnMapClick` closure is still present after the rebuild, with no corresponding entry in the new
  markers' state.
- **Fix sketch**: Track the pending `_disarmOnMapClick` listener at module scope (alongside
  `currentlyArmedMarker`, since only one marker is ever armed at a time) and call
  `leafletMap.off('click', pendingDisarmHandler)` unconditionally at the top of `renderMapMarkers()`'s
  teardown (next to the existing `currentlyArmedMarker = null;`), and also in the marker's own `click`
  handler (map.js:329-337) wherever it disables dragging without going through `dragend`.

---

## GRAPH-002

- **Track**: USER-FACING
- **File:line**: web-src/graph.js:66-87 (`window.extractVlans`)
- **Severity**: Low
- **Confidence**: Low (plausible code defect; real-world trigger condition is narrow and not confirmed
  against actual Junos `show vlans`/MAC-table output format)
- **Claim**: `extractVlans` builds the VLAN filter `<select>` by round-tripping each VLAN tag through
  `Number(...)` for sorting (`Array.from(allVlans.keys()).map(Number).sort((a,b) => a-b)`) and then uses
  that *numeric* value both as the `<option value>` and to look the display name back up
  (`allVlans.get(tag.toString())`, line 84) — but `allVlans` itself is keyed by the *original, unconverted*
  string (`String(c.VLAN_Tag)`, line 72), and every consumer that actually filters nodes/edges
  (`node.vlanCache.includes(selectedVlan.toString())` in graph.js:336, and the equivalent in map.js:316)
  compares against that same raw, unconverted string. If any device ever reports a VLAN tag whose string
  form isn't Number()'s canonical decimal round-trip (e.g. a leading zero, or a non-numeric value that
  isn't the literal `"unknown"` already filtered out), three things happen: (1) `allVlans.get(tag.toString())`
  at line 84 misses, so the dropdown shows the option with an empty/blank VLAN name; (2) the `<option
  value>` submitted no longer matches any `vlanCache` entry (which kept the original string), so selecting
  that VLAN filters everything out — every node/edge dims as if it doesn't carry that VLAN, even though it
  does; (3) a non-numeric tag produces `Number(tag) === NaN`, which both breaks the sort comparator's
  ordering guarantee and renders as `value="NaN"`, permanently unselectable/unmatchable.
- **Trigger**: A device's `TrueClients[].VLAN_Tag` string, once passed through `String(...)`, is not already
  in canonical `Number(x).toString()` form (leading zero, e.g. `"010"`; a non-integer/garbled value that
  isn't the literal string `"unknown"`).
- **Evidence**: graph.js:72 stores the raw string key; graph.js:82-84 re-derives the option's value/lookup
  key via `Number` and `.toString()` instead of reusing the original string directly; graph.js:336 (the
  actual filter predicate) and map.js:316 both compare against the raw string form kept in `vlanCache`
  (itself sourced from `topology-graph.js`'s `computeVlanCache`, which also just does `String(c.VLAN_Tag)`
  with no normalization) — so the two paths (dropdown value vs. filter predicate) only agree when the
  original tag string is already in bare-decimal canonical form.
- **Invariant hit**: INV-UI-TRUTH (a selected VLAN filter that silently matches nothing, or shows a blank
  VLAN name, misrepresents which devices/links actually carry that VLAN).
- **Impact**: If triggered, the VLAN filter for the affected tag becomes silently non-functional (dims
  everything) with no error surfaced to the operator — they'd conclude no device trunks that VLAN, when in
  fact it's a lookup-key mismatch.
- **Repro**: Not confirmed against real Junos output — `Get-JunosNodeData.ps1`'s `show vlans` Tag-column
  parsing (lib/Get-JunosNodeData.ps1 ~line 375-390) appears to extract a plain digit string, which likely
  keeps this latent rather than live in practice. Included because the code itself has no normalization
  guarantee tying the two paths together, and a defensive fix is cheap; treat as lower priority than
  GRAPH-001 pending confirmation of whether any real device/OS variant this tool targets ever emits a
  non-canonical VLAN tag string.
- **Fix sketch**: Don't round-trip through `Number`. Keep the original string as both the `<option value>`
  and the `allVlans` lookup key throughout (`sortedTags = Array.from(allVlans.keys()).sort((a, b) =>
  Number(a) - Number(b))` for ordering only, then iterate the *string* tags directly instead of
  `.map(Number)`).

---

## Categories checked with no surviving findings

- **Boundary conditions (empty graph, single node, cycles, self-referencing neighbors)**: `computeGraphRoot`/
  `buildPrimaryTree`/`computeVisibleTree` all have explicit empty/single-node handling and are covered by
  existing tests; a self-referencing LLDP neighbor edge (device lists itself) is produced by
  `topology-graph.js` as a same-endpoint edge but is explicitly discarded by graph.js's
  `from === to` guard in the secondary-edge rendering pass (doRenderVisibleGraph) before reaching
  vis-network — verified by code trace, not just assumption.
- **Integer/numeric (NaN/Infinity propagation, off-by-one)**: the radial-layout math in graph-layout.js is
  extensively regression-tested (deadline, divide-by-zero at minRadius=0, angle-bucket cache correctness);
  no new arithmetic path outside that coverage was found to produce NaN/Infinity in the reviewed files
  other than the VLAN-tag `Number()` conversion noted in GRAPH-002.
- **INV-UI-TRUTH / Uptime misuse**: grepped all seven scoped files for `Uptime` — the only reference
  (map.js:710/721, the Unplaced Devices CSV export) passes the raw field straight through as an opaque CSV
  column value; it is never parsed as a duration, diffed against `Date.now()`, or otherwise treated as
  elapsed time. No new Uptime misuse found.
- **State handling / races (search.js, scan-network.js)**: `search.js`'s `goToSearchResult` guards every
  await with a monotonic `goToSearchResultGeneration` check, correctly discarding a superseded click;
  `scan-network.js`'s poll loop is single-instance by construction (the triggering button is disabled for
  the whole scan, `finish()` clears the one `scanNetworkPollTimer`, and no other code path calls
  `window.startNetworkScan`). No stale-result-after-newer-scan race found.
- **Dead/unreachable code, copy-paste divergence between graph.js and graph-layout.js**: graph.js and
  map.js intentionally duplicate the subtree-VLAN-union walk (`computeSubtreeVlanSets`/
  `computeMapVlanTrunkSets`) per an explicit comment explaining why (map view must work without the
  diagram's vis-network state ever having been built) — reviewed both implementations side by side; they
  are consistent with each other given that documented reason, not an accidental divergence.
- **map.js marker lifecycle (leak on repeated re-render)**: see GRAPH-001 (found).
