# Network Visualizer: Deterministic Hierarchical Layout

Date: 2026-08-19
Status: Draft, pending user review

## Problem

`NetworkVisualizer` currently lays out switches with vis-network's
`forceAtlas2Based` physics solver. At the scale it was built for (a
handful of switches) this looks fine. At the target scale — a real
network of ~500 switches — physics produces an unreadable "hairball":
node positions are unstable, nothing is grouped meaningfully, and there
is no way to get an overview without endless panning.

The fix needs to:
- Replace physics with a **deterministic** layout that reads clearly at
  500 nodes.
- Not assume the crawl started at a meaningful root — `Start-NetworkMapper.ps1`
  can be launched from any switch in the network, including a leaf access
  switch, so "root = crawl start" would produce an arbitrary hierarchy.
- Not require new scraper-side data or a schema change — `NetworkMap.json`
  stays exactly as Phase 1 left it.
- Leave room for an eventual "overlay on a physical map" mode without
  committing to it now. That mode is out of scope for this spec.

## Non-goals

- Physical/geographic map overlay mode. Explicitly a later phase; this
  design should not make it harder, but does not build any part of it.
- Site/building-based grouping. Confirmed with the user: there's no
  reliable site signal available today (no consistent hostname
  convention, `AllowedScopes` is just a crawl-time IP filter). Clustering
  here is by tree structure, not by site.
- Edge routing / orthogonal polylines. Accepted trade-off below.

## Architecture

### 1. Root selection: graph center, computed client-side

The root is **not** stored in `NetworkMap.json` and **not** tied to
crawl order. It's a pure function of the discovered topology, recomputed
every time the visualizer loads a file:

1. Build an undirected adjacency graph from every node currently in
   `nodesDataset`/`edgesDataset` (this reuses the two-pass node/edge
   construction already fixed in Phase 1 — both scanned devices and
   unscanned LLDP-only placeholders are graph nodes).
2. Run BFS from every node to get its **eccentricity** (max shortest-path
   distance to any other node in the graph).
3. Root = the node with minimum eccentricity (the graph center). Ties
   broken deterministically (lowest IP, sorted numerically).

Cost: ~500 BFS passes over ~500-600 edges ≈ trivial (well under 100ms),
plain synchronous JS, no worker needed for this part.

### 2. Primary spanning tree vs. secondary edges

Real topologies aren't trees — dual uplinks, redundant links, and
occasional loops exist. Feeding all of that directly into a layered
layout algorithm produces messier results (the algorithm has to decide
which edges to treat as "back edges").

Instead:
- Run one more BFS, from the computed root, over the **full** graph to
  get parent pointers — this is the **primary spanning tree**. Every
  node except the root has exactly one primary parent (whichever
  neighbor discovered it first in BFS order, ties broken by lowest IP).
- Every edge in the topology that is *not* a primary-tree edge is a
  **secondary edge** (dual uplink, mesh link, redundant path, etc).

Only the primary tree is handed to the layout engine (a tree is always
perfectly layerable — zero ambiguity, zero crossings within itself).
Secondary edges are drawn afterward as an overlay, straight lines
between whatever positions the tree layout already assigned their two
endpoints, rendered dashed and de-emphasized. They can visually cross
other things; that's an accepted trade-off for keeping the primary
structure unambiguous — see "Alternatives considered."

### 3. Clustering: by child count, not by depth or site

Per the user's answer, there's no site data to key off, so clustering is
purely structural: **any node whose primary-tree child count exceeds a
threshold** (default 8, exposed as a left-panel number input so the user
can tune it live against their real topology) has its children collapsed
into one synthetic cluster placeholder node by default, labeled
`+N devices`. Clicking a cluster node expands it (reveals its real
children, re-run layout); clicking an already-expanded parent's cluster
toggle (or a small "−" affordance on it) re-collapses.

State: an `expandedNodes` Set of node IDs whose children are currently
shown, initialized so any node under the threshold starts expanded and
any node over it starts collapsed. This is separate from vis-network's
own `cluster()` API — since node positions come from ELK, not vis's
physics, it's simpler to own the visible-subgraph computation directly:
on every expand/collapse, recompute the effective visible tree, re-run
layout on just that (small) subgraph, and rebuild `nodesDataset`/
`edgesDataset` from scratch the same way `buildSwitchMap` already does
today.

Real switch nodes keep today's click behavior (open the right-drawer).
Cluster placeholder nodes are visually distinct (dashed border, no
device data) and click toggles expansion instead.

### 4. Layout engine: ELK.js (`elk.layered`), in a Web Worker

Per your choice of approach #2. `elkjs` vendored locally next to
`vis-network.min.js` (same reasoning as Phase 1: pinned version, works
air-gapped, no CDN dependency) — both the main bundle and its worker
script.

Flow on every (re)render of the visible subgraph:
1. Build ELK input graph: visible primary-tree nodes + edges only
   (cluster placeholders count as leaf nodes for this purpose).
2. Post the graph to a Web Worker running `elk.layered` (`elk.direction:
   DOWN`, tuned `elk.spacing.nodeNode` / `nodeNodeBetweenLayers` for the
   existing label size) so computing positions for a large expanded
   subgraph never blocks the UI thread.
3. On the worker's response, apply `x`/`y` to each vis-network node,
   `physics: false` globally. `dragNodes` stays enabled — a user can
   still manually nudge a node, and since physics is off it won't spring
   back.
4. Draw primary edges (solid) and secondary edges (dashed) using those
   positions.
5. If the worker errors or times out (e.g. malformed input), fall back
   to a simple deterministic grid placement rather than leaving the
   canvas blank, and surface it through the existing `window.onerror`
   fatal-error modal path.

Reused UI: the existing `#loadingBar` progress overlay covers the
"waiting on the worker" period, same as it already covers file-read
progress today.

### 5. What doesn't change

- `NetworkMap.json` / `TestMap.json` schema: unchanged.
- The two-pass node/edge construction from Phase 1 (scanned vs.
  unscanned-neighbor styling): unchanged, feeds into this as the graph
  source.
- Right-drawer tabs, search, VLAN filter: unchanged in behavior: VLAN
  filter still recolors nodes; search still focuses+selects a node (if
  it's currently collapsed inside a cluster, search should expand that
  cluster first, then focus — noted as a required behavior change to
  `performGlobalSearch`, not a new feature).

## Testing plan

There's no real 500-switch network available to test against. Plan:
1. Generate a synthetic ~500-node fixture (script-generated, not
   hand-written) with a realistic branching shape: a handful of
   high-fan-out "distribution" nodes, deeper "access" leaves, and a
   sprinkling of secondary/redundant edges to exercise that path.
2. Load it through the same headless-Chromium + CDP harness used for
   Phase 1 verification. Confirm: render completes without hanging,
   the default view shows a manageable node count (clustering is
   working), expanding a cluster reveals children and re-lays-out
   sanely, VLAN filter/search still work against the new model.
3. Screenshot the result for visual review.

## Alternatives considered

- **Route secondary edges as ELK-computed polylines instead of straight
  lines.** Would look more polished but requires either replacing
  vis-network's edge rendering with a custom SVG overlay (to draw
  multi-point paths) or accepting the coordinate-sync complexity of two
  rendering systems. Rejected for now as disproportionate to the payoff;
  straight dashed lines between well-separated tree-laid-out nodes are
  already a large readability improvement over physics. Worth
  revisiting if secondary-edge crossings turn out to be a real problem
  once tested against real data.
- **vis-network's own `cluster()` API** instead of manually rebuilding
  the dataset per expand/collapse. Rejected because reconciling its
  internal cluster bounding-box/position model with externally-computed
  ELK positions adds complexity for no real benefit at this scale —
  rebuilding a small dataset on an infrequent user action (expand/
  collapse) is cheap and easy to reason about.
