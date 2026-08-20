# Deterministic Hierarchical Graph Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the NetworkVisualizer's physics-based (`forceAtlas2Based`) graph layout with a deterministic hierarchical layout that stays readable at ~500 switch nodes.

**Architecture:** Two new pure-logic ES modules — `graph-layout.js` (root selection via graph-center, primary spanning tree / secondary edges, child-count-based clustering — all plain-data functions, unit-testable under Node) and `elk-layout.js` (thin wrapper around a vendored ELK.js instance running its layout in a Web Worker, with a grid fallback on failure/timeout). `app.js`'s `buildSwitchMap` is rewritten to call these instead of configuring vis-network physics, feeding ELK-computed positions into vis-network with `physics: false`.

**Tech Stack:** Vanilla ES modules (no build step, no bundler), vis-network 9.1.9 (already vendored), elkjs 0.12.0 (vendored in this plan), Node's built-in `node:test` for the pure-logic unit tests, headless Chromium + the existing `~/.claude/tools/cdp.mjs` driver for browser-dependent verification.

**Spec:** `docs/superpowers/specs/2026-08-19-graph-layout-design.md`

## Global Constraints

- No new scraper-side data or `NetworkMap.json` schema changes — the root is computed client-side from the topology already loaded, every time a file is loaded.
- No live CDN dependencies — elkjs is vendored locally and pinned to 0.12.0, same as vis-network was in the prior round of work.
- Physical/geographic map overlay mode is explicitly out of scope for this plan.
- Site/building-based grouping is explicitly out of scope — clustering is purely by primary-tree child count, threshold configurable in the UI (default 8).
- Secondary (non-tree) edges are rendered as straight dashed lines between ELK-computed tree positions — no custom edge-routing/polylines (see spec "Alternatives considered").
- `app.js`'s existing behavior (right-drawer tabs, VLAN filter, search-and-focus, the Phase 1 two-pass scanned/unscanned node styling) must keep working exactly as before; this plan changes *how positions are computed*, not the rest of the UI.

---

## File Structure

- **Create** `PS_NetworkMapper/NetworkVisualizer/graph-layout.js` — pure graph algorithms (root selection, spanning tree, visible-subgraph/clustering). No DOM, no vis-network, no browser globals. ES module, importable from both the browser and Node's test runner.
- **Create** `PS_NetworkMapper/NetworkVisualizer/elk-layout.js` — ELK Worker wrapper (`computeLayout`) plus a pure grid fallback (`computeGridFallback`). ES module. Depends on the browser global `ELK` (from the vendored classic script) and the browser `Worker` API, so only `computeGridFallback` is Node-testable; `computeLayout` is verified via the browser CDP harness.
- **Create** `PS_NetworkMapper/NetworkVisualizer/vendor/elk.bundled.js`, `PS_NetworkMapper/NetworkVisualizer/vendor/elk-worker.min.js` — vendored elkjs 0.12.0.
- **Create** `PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs` — `node:test` unit tests for `graph-layout.js`.
- **Create** `PS_NetworkMapper/NetworkVisualizer/test/elk-layout.test.mjs` — `node:test` unit tests for `elk-layout.js`'s `computeGridFallback`.
- **Create** `PS_NetworkMapper/NetworkVisualizer/test/generate-fixture.mjs` — generates a synthetic ~500-node topology JSON fixture for large-scale verification (Task 8 only; not part of the app itself).
- **Modify** `PS_NetworkMapper/NetworkVisualizer/app.js` — `buildSwitchMap` rewritten to call the new modules instead of configuring physics; new clustering state (`expandedNodes`, `clusterThreshold`) and click handling; `performGlobalSearch` expands ancestor clusters before focusing. Converted to `type="module"` so it can `import` the new files.
- **Modify** `PS_NetworkMapper/NetworkVisualizer/network_vis.html` — script tags for the vendored ELK files and the module-typed `app.js`; new "Max children before grouping" number input in the left panel.

---

### Task 1: Graph-center root selection

**Files:**
- Create: `PS_NetworkMapper/NetworkVisualizer/graph-layout.js`
- Test: `PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `export function computeGraphRoot(nodeIds, edges)` — `nodeIds: string[]`, `edges: {from: string, to: string}[]` (undirected, already deduped — one entry per pair). Returns `string | null`: the node ID with minimum eccentricity (graph center), ties broken by ascending dotted-IP-numeric sort of the ID; `null` if `nodeIds` is empty.
  - `export function compareIpIds(a, b)` — comparator used for the tie-break; exported because Task 2 needs the same deterministic ordering when choosing among multiple candidate parents.

- [ ] **Step 1: Write the failing tests**

Create `PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGraphRoot, compareIpIds } from '../graph-layout.js';

test('compareIpIds sorts dotted-quad IDs numerically, not lexically', () => {
  const ids = ['10.55.2.10', '10.55.2.2', '10.55.2.1'];
  ids.sort(compareIpIds);
  assert.deepEqual(ids, ['10.55.2.1', '10.55.2.2', '10.55.2.10']);
});

test('computeGraphRoot returns null for an empty graph', () => {
  assert.equal(computeGraphRoot([], []), null);
});

test('computeGraphRoot returns the only node for a single-node graph', () => {
  assert.equal(computeGraphRoot(['10.55.1.1'], []), '10.55.1.1');
});

test('computeGraphRoot picks the center of a straight line, not either end', () => {
  // A - B - C - D - E: eccentricity(C) = 2 is the minimum; A and E have eccentricity 4.
  const nodeIds = ['A', 'B', 'C', 'D', 'E'];
  const edges = [
    { from: 'A', to: 'B' }, { from: 'B', to: 'C' },
    { from: 'C', to: 'D' }, { from: 'D', to: 'E' },
  ];
  assert.equal(computeGraphRoot(nodeIds, edges), 'C');
});

test('computeGraphRoot is independent of which end of the line is "first"', () => {
  // Same line, but the crawl could have started anywhere - root must not depend on it.
  const nodeIds = ['E', 'D', 'C', 'B', 'A'];
  const edges = [
    { from: 'D', to: 'E' }, { from: 'C', to: 'D' },
    { from: 'B', to: 'C' }, { from: 'A', to: 'B' },
  ];
  assert.equal(computeGraphRoot(nodeIds, edges), 'C');
});

test('computeGraphRoot picks a star graph\'s hub, not a leaf', () => {
  const nodeIds = ['hub', 'leaf1', 'leaf2', 'leaf3', 'leaf4'];
  const edges = [
    { from: 'hub', to: 'leaf1' }, { from: 'hub', to: 'leaf2' },
    { from: 'hub', to: 'leaf3' }, { from: 'hub', to: 'leaf4' },
  ];
  assert.equal(computeGraphRoot(nodeIds, edges), 'hub');
});

test('computeGraphRoot breaks eccentricity ties by lowest IP', () => {
  // A - B - C: both A and C have eccentricity 2, B has 1 and would normally win;
  // here we force a tie by using a 2-node graph where both nodes tie at eccentricity 1.
  const nodeIds = ['10.0.0.5', '10.0.0.2'];
  const edges = [{ from: '10.0.0.5', to: '10.0.0.2' }];
  assert.equal(computeGraphRoot(nodeIds, edges), '10.0.0.2');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`
Expected: FAIL — `graph-layout.js` does not exist yet (module not found).

- [ ] **Step 3: Implement `graph-layout.js`**

Create `PS_NetworkMapper/NetworkVisualizer/graph-layout.js`:

```javascript
// Pure graph algorithms for the topology layout: no DOM, no vis-network,
// no browser globals. Importable from both the browser and node:test.

// Splits a dotted-quad-shaped ID into comparable numeric octets; IDs that
// aren't dotted-quads (e.g. "cluster:10.55.2.2") fall back to string compare.
export function compareIpIds(a, b) {
  const partsA = String(a).split('.');
  const partsB = String(b).split('.');
  if (partsA.length === 4 && partsB.length === 4 && partsA.every(p => /^\d+$/.test(p)) && partsB.every(p => /^\d+$/.test(p))) {
    for (let i = 0; i < 4; i++) {
      const diff = Number(partsA[i]) - Number(partsB[i]);
      if (diff !== 0) return diff;
    }
    return 0;
  }
  return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
}

function buildAdjacency(nodeIds, edges) {
  const adj = new Map();
  nodeIds.forEach(id => adj.set(id, new Set()));
  edges.forEach(e => {
    if (!adj.has(e.from) || !adj.has(e.to)) return;
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  });
  return adj;
}

// BFS distances from `startId` to every reachable node.
function bfsDistances(adj, startId) {
  const dist = new Map([[startId, 0]]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = Array.from(adj.get(current) || []).sort(compareIpIds);
    for (const next of neighbors) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(current) + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

export function computeGraphRoot(nodeIds, edges) {
  if (nodeIds.length === 0) return null;
  if (nodeIds.length === 1) return nodeIds[0];

  const adj = buildAdjacency(nodeIds, edges);
  let bestId = null;
  let bestEccentricity = Infinity;

  const sortedIds = Array.from(nodeIds).sort(compareIpIds);
  for (const id of sortedIds) {
    const dist = bfsDistances(adj, id);
    let eccentricity = 0;
    for (const d of dist.values()) eccentricity = Math.max(eccentricity, d);
    if (eccentricity < bestEccentricity) {
      bestEccentricity = eccentricity;
      bestId = id;
    }
  }
  return bestId;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add PS_NetworkMapper/NetworkVisualizer/graph-layout.js PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs
git commit -m "feat: graph-center root selection for the topology layout"
```

---

### Task 2: Primary spanning tree + secondary edges

**Files:**
- Modify: `PS_NetworkMapper/NetworkVisualizer/graph-layout.js`
- Modify: `PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`

**Interfaces:**
- Consumes: `compareIpIds` from Task 1 (same file, already in scope).
- Produces: `export function buildPrimaryTree(nodeIds, edges, rootId)` returning:
  ```javascript
  {
    parentOf: Map<string, string|null>,   // rootId -> null; every other visited node -> its primary parent
    childrenOf: Map<string, string[]>,    // every node id (incl. leaves, which map to []) -> its primary-tree children, ascending compareIpIds order
    secondaryEdges: {from: string, to: string}[]  // every input edge that is not a parent-child pair in the tree
  }
  ```
  A node unreachable from `rootId` (shouldn't happen given the crawl is one connected BFS, but the function must not throw) gets `parentOf.get(id) === undefined` and is absent from `childrenOf` as a value anywhere — Task 3 must treat "not in `childrenOf`/`parentOf`" as "not part of the visible tree at all."

- [ ] **Step 1: Write the failing tests**

Append to `PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`:

```javascript
import { buildPrimaryTree } from '../graph-layout.js';

test('buildPrimaryTree assigns BFS-order parents on a simple tree', () => {
  const nodeIds = ['root', 'a', 'b', 'a1', 'a2'];
  const edges = [
    { from: 'root', to: 'a' }, { from: 'root', to: 'b' },
    { from: 'a', to: 'a1' }, { from: 'a', to: 'a2' },
  ];
  const { parentOf, childrenOf } = buildPrimaryTree(nodeIds, edges, 'root');
  assert.equal(parentOf.get('root'), null);
  assert.equal(parentOf.get('a'), 'root');
  assert.equal(parentOf.get('b'), 'root');
  assert.equal(parentOf.get('a1'), 'a');
  assert.equal(parentOf.get('a2'), 'a');
  assert.deepEqual(childrenOf.get('root').sort(), ['a', 'b']);
  assert.deepEqual(childrenOf.get('a').sort(), ['a1', 'a2']);
  assert.deepEqual(childrenOf.get('b'), []);
});

test('buildPrimaryTree picks the deterministic (lowest-ID) parent when a node has two equal-depth candidates', () => {
  // root -> {10.0.0.1, 10.0.0.2}, both root's children, both connected to "leaf".
  // "leaf" is discovered at depth 2 either way; its parent must deterministically
  // be whichever of 10.0.0.1/10.0.0.2 sorts first among root's children.
  const nodeIds = ['root', '10.0.0.2', '10.0.0.1', 'leaf'];
  const edges = [
    { from: 'root', to: '10.0.0.2' }, { from: 'root', to: '10.0.0.1' },
    { from: '10.0.0.2', to: 'leaf' }, { from: '10.0.0.1', to: 'leaf' },
  ];
  const { parentOf, secondaryEdges } = buildPrimaryTree(nodeIds, edges, 'root');
  assert.equal(parentOf.get('leaf'), '10.0.0.1');
  assert.equal(secondaryEdges.length, 1);
  assert.deepEqual(
    [secondaryEdges[0].from, secondaryEdges[0].to].sort(),
    ['10.0.0.2', 'leaf'].sort()
  );
});

test('buildPrimaryTree puts every non-tree edge into secondaryEdges', () => {
  // Triangle: root-a, root-b, a-b. a-b is not a tree edge (a and b are both
  // root's direct children), so it's secondary.
  const nodeIds = ['root', 'a', 'b'];
  const edges = [
    { from: 'root', to: 'a' }, { from: 'root', to: 'b' }, { from: 'a', to: 'b' },
  ];
  const { secondaryEdges } = buildPrimaryTree(nodeIds, edges, 'root');
  assert.equal(secondaryEdges.length, 1);
  assert.deepEqual([secondaryEdges[0].from, secondaryEdges[0].to].sort(), ['a', 'b']);
});

test('buildPrimaryTree leaves an unreachable node out of parentOf/childrenOf', () => {
  const nodeIds = ['root', 'a', 'island'];
  const edges = [{ from: 'root', to: 'a' }];
  const { parentOf, childrenOf } = buildPrimaryTree(nodeIds, edges, 'root');
  assert.equal(parentOf.has('island'), false);
  assert.equal(childrenOf.has('island'), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`
Expected: FAIL — `buildPrimaryTree` is not exported yet.

- [ ] **Step 3: Implement `buildPrimaryTree`**

Append to `PS_NetworkMapper/NetworkVisualizer/graph-layout.js` (after `computeGraphRoot`, reusing the `buildAdjacency` helper already defined above it):

```javascript
export function buildPrimaryTree(nodeIds, edges, rootId) {
  const adj = buildAdjacency(nodeIds, edges);
  const parentOf = new Map([[rootId, null]]);
  const childrenOf = new Map(nodeIds.map(id => [id, []]));
  const treeEdgeKeys = new Set();

  const edgeKey = (a, b) => [a, b].sort(compareIpIds).join('|');

  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = Array.from(adj.get(current) || []).sort(compareIpIds);
    for (const next of neighbors) {
      if (!parentOf.has(next)) {
        parentOf.set(next, current);
        childrenOf.get(current).push(next);
        treeEdgeKeys.add(edgeKey(current, next));
        queue.push(next);
      }
    }
  }

  const secondaryEdges = edges.filter(e => !treeEdgeKeys.has(edgeKey(e.from, e.to)));

  return { parentOf, childrenOf, secondaryEdges };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add PS_NetworkMapper/NetworkVisualizer/graph-layout.js PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs
git commit -m "feat: primary spanning tree + secondary edge classification"
```

---

### Task 3: Visible-subgraph computation (clustering) + ancestor expansion

**Files:**
- Modify: `PS_NetworkMapper/NetworkVisualizer/graph-layout.js`
- Modify: `PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`

**Interfaces:**
- Consumes: `parentOf`, `childrenOf` shapes from Task 2's `buildPrimaryTree`.
- Produces:
  - `export function computeVisibleTree(rootId, childrenOf, expandedNodes, threshold)` returning:
    ```javascript
    {
      visibleNodeIds: string[],   // real node ids + synthetic cluster ids, root first then BFS order
      visibleEdges: {from: string, to: string}[],  // primary edges between visible nodes/clusters only
      clusters: Map<string, {parentId: string, memberIds: string[]}>  // clusterId -> {parentId, memberIds}; memberIds is every real descendant hidden behind it (the whole collapsed subtree, not just direct children)
    }
    ```
    Cluster IDs are `` `cluster:${parentId}` ``. A node is treated as expanded if its direct child count is `<= threshold`, OR it's in `expandedNodes` — callers don't need to pre-seed `expandedNodes` for small nodes.
  - `export function expandAncestors(parentOf, childrenOf, targetId, expandedNodes, threshold)` — mutates `expandedNodes` in place, adding every ancestor of `targetId` (walking `parentOf`) whose child count exceeds `threshold`, so a subsequent `computeVisibleTree` call will reveal `targetId`. Returns nothing.

- [ ] **Step 1: Write the failing tests**

Append to `PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`:

```javascript
import { buildPrimaryTree as buildTreeForVisibility } from '../graph-layout.js';
import { computeVisibleTree, expandAncestors } from '../graph-layout.js';

function starTree(childCount) {
  const nodeIds = ['root', ...Array.from({ length: childCount }, (_, i) => `c${i}`)];
  const edges = nodeIds.slice(1).map(id => ({ from: 'root', to: id }));
  return buildTreeForVisibility(nodeIds, edges, 'root');
}

test('computeVisibleTree shows everything when under the threshold', () => {
  const { childrenOf } = starTree(5);
  const { visibleNodeIds, clusters } = computeVisibleTree('root', childrenOf, new Set(), 8);
  assert.equal(visibleNodeIds.length, 6); // root + 5 children
  assert.equal(clusters.size, 0);
});

test('computeVisibleTree collapses children into one cluster when over the threshold', () => {
  const { childrenOf } = starTree(20);
  const { visibleNodeIds, clusters } = computeVisibleTree('root', childrenOf, new Set(), 8);
  assert.equal(visibleNodeIds.length, 2); // root + 1 cluster placeholder
  assert.equal(clusters.size, 1);
  const cluster = clusters.get('cluster:root');
  assert.equal(cluster.parentId, 'root');
  assert.equal(cluster.memberIds.length, 20);
});

test('computeVisibleTree reveals real children once the parent is in expandedNodes', () => {
  const { childrenOf } = starTree(20);
  const { visibleNodeIds, clusters } = computeVisibleTree('root', childrenOf, new Set(['root']), 8);
  assert.equal(visibleNodeIds.length, 21); // root + all 20 children, no cluster
  assert.equal(clusters.size, 0);
});

test('computeVisibleTree collapses a deep subtree behind its nearest over-threshold ancestor', () => {
  // root -> mid -> (20 leaves). mid has 20 children (over threshold), root has 1 (mid, under threshold).
  const nodeIds = ['root', 'mid', ...Array.from({ length: 20 }, (_, i) => `leaf${i}`)];
  const edges = [
    { from: 'root', to: 'mid' },
    ...Array.from({ length: 20 }, (_, i) => ({ from: 'mid', to: `leaf${i}` })),
  ];
  const { childrenOf } = buildTreeForVisibility(nodeIds, edges, 'root');
  const { visibleNodeIds, clusters } = computeVisibleTree('root', childrenOf, new Set(), 8);
  assert.deepEqual(visibleNodeIds.sort(), ['cluster:mid', 'mid', 'root'].sort());
  assert.equal(clusters.get('cluster:mid').memberIds.length, 20);
});

test('expandAncestors reveals a target buried behind an over-threshold ancestor', () => {
  const nodeIds = ['root', 'mid', 'leaf0', 'leaf1'];
  const edges = [
    { from: 'root', to: 'mid' }, { from: 'mid', to: 'leaf0' }, { from: 'mid', to: 'leaf1' },
  ];
  const { parentOf, childrenOf } = buildTreeForVisibility(nodeIds, edges, 'root');
  const expandedNodes = new Set();
  expandAncestors(parentOf, childrenOf, 'leaf0', expandedNodes, 1); // threshold 1: "mid" (2 children) is over it
  assert.equal(expandedNodes.has('mid'), true);
  const { visibleNodeIds } = computeVisibleTree('root', childrenOf, expandedNodes, 1);
  assert.equal(visibleNodeIds.includes('leaf0'), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`
Expected: FAIL — `computeVisibleTree`/`expandAncestors` not exported yet.

- [ ] **Step 3: Implement `computeVisibleTree` and `expandAncestors`**

Append to `PS_NetworkMapper/NetworkVisualizer/graph-layout.js`:

```javascript
function collectDescendants(childrenOf, nodeId) {
  const result = [];
  const stack = [...(childrenOf.get(nodeId) || [])];
  while (stack.length > 0) {
    const next = stack.pop();
    result.push(next);
    stack.push(...(childrenOf.get(next) || []));
  }
  return result;
}

function isExpanded(childrenOf, nodeId, expandedNodes, threshold) {
  const childCount = (childrenOf.get(nodeId) || []).length;
  return childCount <= threshold || expandedNodes.has(nodeId);
}

export function computeVisibleTree(rootId, childrenOf, expandedNodes, threshold) {
  const visibleNodeIds = [];
  const visibleEdges = [];
  const clusters = new Map();

  if (rootId == null) return { visibleNodeIds, visibleEdges, clusters };

  const queue = [rootId];
  visibleNodeIds.push(rootId);
  while (queue.length > 0) {
    const current = queue.shift();
    const children = childrenOf.get(current) || [];

    if (isExpanded(childrenOf, current, expandedNodes, threshold)) {
      for (const child of children) {
        visibleNodeIds.push(child);
        visibleEdges.push({ from: current, to: child });
        queue.push(child);
      }
    } else {
      const clusterId = `cluster:${current}`;
      visibleNodeIds.push(clusterId);
      visibleEdges.push({ from: current, to: clusterId });
      clusters.set(clusterId, { parentId: current, memberIds: collectDescendants(childrenOf, current) });
    }
  }

  return { visibleNodeIds, visibleEdges, clusters };
}

export function expandAncestors(parentOf, childrenOf, targetId, expandedNodes, threshold) {
  let current = parentOf.get(targetId);
  while (current != null) {
    const childCount = (childrenOf.get(current) || []).length;
    if (childCount > threshold) expandedNodes.add(current);
    current = parentOf.get(current);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add PS_NetworkMapper/NetworkVisualizer/graph-layout.js PS_NetworkMapper/NetworkVisualizer/test/graph-layout.test.mjs
git commit -m "feat: child-count clustering and ancestor expansion for the topology layout"
```

---

### Task 4: Vendor elkjs 0.12.0

**Files:**
- Create: `PS_NetworkMapper/NetworkVisualizer/vendor/elk.bundled.js`
- Create: `PS_NetworkMapper/NetworkVisualizer/vendor/elk-worker.min.js`

**Interfaces:**
- Consumes: nothing.
- Produces: browser global `ELK` (from `elk.bundled.js`, once loaded via a classic `<script>` tag) and the worker script path `vendor/elk-worker.min.js` that Task 5's `elk-layout.js` passes as `workerUrl`.

- [ ] **Step 1: Download the pinned files**

```bash
cd PS_NetworkMapper/NetworkVisualizer
mkdir -p vendor
curl -s --max-time 20 -o vendor/elk.bundled.js https://unpkg.com/elkjs@0.12.0/lib/elk.bundled.js
curl -s --max-time 20 -o vendor/elk-worker.min.js https://unpkg.com/elkjs@0.12.0/lib/elk-worker.min.js
```

- [ ] **Step 2: Verify both files downloaded correctly**

```bash
head -c 200 vendor/elk.bundled.js
echo
head -c 200 vendor/elk-worker.min.js
wc -l vendor/elk.bundled.js vendor/elk-worker.min.js
```

Expected: both files start with JS content (not an HTML error page), non-trivial line counts (elkjs is a large bundled library — expect tens of thousands of lines / a multi-MB file for `elk.bundled.js`, and a smaller but still substantial worker file).

- [ ] **Step 3: Commit**

```bash
git add PS_NetworkMapper/NetworkVisualizer/vendor/elk.bundled.js PS_NetworkMapper/NetworkVisualizer/vendor/elk-worker.min.js
git commit -m "chore: vendor elkjs 0.12.0"
```

---

### Task 5: ELK layout wrapper with grid fallback

**Files:**
- Create: `PS_NetworkMapper/NetworkVisualizer/elk-layout.js`
- Create: `PS_NetworkMapper/NetworkVisualizer/test/elk-layout.test.mjs`
- Modify: `PS_NetworkMapper/NetworkVisualizer/network_vis.html` (load `vendor/elk.bundled.js` as a classic script, before the module script that will need `window.ELK`)

**Interfaces:**
- Consumes: `visibleNodeIds: string[]`, `visibleEdges: {from,to}[]` (the shape `computeVisibleTree` from Task 3 produces). Browser global `ELK` (from `vendor/elk.bundled.js`, loaded via classic `<script>` before this module runs).
- Produces:
  - `export function computeGridFallback(visibleNodeIds)` — pure, Node-testable. Returns `Map<string, {x: number, y: number}>`.
  - `export async function computeLayout(visibleNodeIds, visibleEdges)` — returns `Promise<Map<string, {x: number, y: number}>>`. Runs ELK's `layered` algorithm (`elk.direction: DOWN`) in a Web Worker via `workerUrl: 'vendor/elk-worker.min.js'`; on error or after an 8-second timeout, resolves with `computeGridFallback(visibleNodeIds)` instead of rejecting — Task 6 can always `await` this without a try/catch.

- [ ] **Step 1: Write the failing test for the pure fallback function**

Create `PS_NetworkMapper/NetworkVisualizer/test/elk-layout.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGridFallback } from '../elk-layout.js';

test('computeGridFallback places every node with a numeric x/y', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const positions = computeGridFallback(ids);
  assert.equal(positions.size, 5);
  for (const id of ids) {
    const pos = positions.get(id);
    assert.equal(typeof pos.x, 'number');
    assert.equal(typeof pos.y, 'number');
    assert.equal(Number.isNaN(pos.x), false);
    assert.equal(Number.isNaN(pos.y), false);
  }
});

test('computeGridFallback never places two nodes at the same position', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
  const positions = computeGridFallback(ids);
  const seen = new Set();
  for (const id of ids) {
    const key = `${positions.get(id).x},${positions.get(id).y}`;
    assert.equal(seen.has(key), false, `duplicate position for ${id}`);
    seen.add(key);
  }
});

test('computeGridFallback returns an empty map for no nodes', () => {
  assert.equal(computeGridFallback([]).size, 0);
});
```

Note: `elk-layout.js` imports the browser global `ELK`, which does not exist under plain `node --test`. Task 3's `computeGridFallback` must not reference `ELK` at module load time (only inside `computeLayout`), so importing the module under Node doesn't throw — verified in the next step.

- [ ] **Step 2: Run the test to verify it fails (module doesn't exist yet)**

Run: `node --test PS_NetworkMapper/NetworkVisualizer/test/elk-layout.test.mjs`
Expected: FAIL — `elk-layout.js` does not exist yet.

- [ ] **Step 3: Implement `elk-layout.js`**

Create `PS_NetworkMapper/NetworkVisualizer/elk-layout.js`:

```javascript
// Wraps a vendored ELK.js instance to lay out the currently-visible subgraph
// in a Web Worker (never on the main thread), with a deterministic grid
// fallback if the worker errors or takes too long. `ELK` is a browser global
// from vendor/elk.bundled.js, loaded via a classic <script> tag before this
// module - referenced lazily (inside computeLayout, not at module scope) so
// this file still imports cleanly under `node --test`, where computeGridFallback
// is exercised without a browser.

const NODE_WIDTH = 160;
const NODE_HEIGHT = 50;
const LAYOUT_TIMEOUT_MS = 8000;

let elkInstance = null;
function getElk() {
  if (!elkInstance) {
    elkInstance = new ELK({ workerUrl: 'vendor/elk-worker.min.js' });
  }
  return elkInstance;
}

export function computeGridFallback(visibleNodeIds) {
  const positions = new Map();
  const perRow = Math.ceil(Math.sqrt(visibleNodeIds.length)) || 1;
  visibleNodeIds.forEach((id, i) => {
    positions.set(id, {
      x: (i % perRow) * (NODE_WIDTH + 60),
      y: Math.floor(i / perRow) * (NODE_HEIGHT + 80),
    });
  });
  return positions;
}

export async function computeLayout(visibleNodeIds, visibleEdges) {
  if (visibleNodeIds.length === 0) return new Map();

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    },
    children: visibleNodeIds.map(id => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: visibleEdges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('ELK layout timed out')), LAYOUT_TIMEOUT_MS);
  });

  try {
    const laidOut = await Promise.race([getElk().layout(graph), timeout]);
    const positions = new Map();
    laidOut.children.forEach(n => positions.set(n.id, { x: n.x, y: n.y }));
    return positions;
  } catch (err) {
    console.error('ELK layout failed, falling back to a grid:', err);
    return computeGridFallback(visibleNodeIds);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test PS_NetworkMapper/NetworkVisualizer/test/elk-layout.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the vendored ELK script into the page**

In `PS_NetworkMapper/NetworkVisualizer/network_vis.html`, find:

```html
    <!-- Load Vis.js (vendored: PS_NetworkMapper/NetworkVisualizer/vendor/vis-network.min.js, v9.1.9 pinned) -->
    <script type="text/javascript" src="vendor/vis-network.min.js"></script>
```

Add immediately after it (classic script, so `window.ELK` exists before any module script runs):

```html
    <!-- Load ELK.js (vendored: vendor/elk.bundled.js + vendor/elk-worker.min.js, v0.12.0 pinned) -->
    <script type="text/javascript" src="vendor/elk.bundled.js"></script>
```

- [ ] **Step 6: Verify `ELK` and `computeLayout` work in a real browser**

Start a static server rooted at `PS_NetworkMapper/` and a headless Chromium instance with remote debugging (same pattern as the Phase 1 verification: `python3 -m http.server <port>` from `PS_NetworkMapper/`, `chromium --headless --disable-gpu --remote-debugging-port=<port2> --user-data-dir=<tmp dir>`). Then drive it with `node ~/.claude/tools/cdp.mjs <port2> <plan.json>` where `plan.json` is:

```json
[
  {"nav": "http://localhost:<port>/NetworkVisualizer/network_vis.html"},
  {"wait": 1000},
  {"eval": "typeof ELK"},
  {"eval": "(async () => { const mod = await import('./elk-layout.js'); const positions = await mod.computeLayout(['a','b','c'], [{from:'a',to:'b'},{from:'a',to:'c'}]); window.__testResult = { size: positions.size, a: positions.get('a'), b: positions.get('b'), c: positions.get('c') }; return 'done'; })()"},
  {"wait": 500},
  {"eval": "JSON.stringify(window.__testResult)"}
]
```

Expected: `typeof ELK` evaluates to `"function"`, and the final eval shows `size: 3` with three distinct, non-NaN `{x, y}` positions — `b` and `c` should not share the same `y` as `a` (they're one layer below it in a `DOWN`-directed layered layout).

- [ ] **Step 7: Commit**

```bash
git add PS_NetworkMapper/NetworkVisualizer/elk-layout.js PS_NetworkMapper/NetworkVisualizer/test/elk-layout.test.mjs PS_NetworkMapper/NetworkVisualizer/network_vis.html
git commit -m "feat: ELK-backed layout computation with a grid fallback"
```

---

### Task 6: Wire the new layout into `buildSwitchMap`

**Files:**
- Modify: `PS_NetworkMapper/NetworkVisualizer/app.js`
- Modify: `PS_NetworkMapper/NetworkVisualizer/network_vis.html` (make `app.js` a module)

**Interfaces:**
- Consumes: `computeGraphRoot`, `buildPrimaryTree` from `graph-layout.js`; `computeLayout` from `elk-layout.js`.
- Produces: `window.buildSwitchMap` (existing name, now `async`) and a new `window.renderVisibleGraph` (`async`, no args — recomputes the visible subgraph from current `expandedNodes`/`clusterThreshold` state and re-renders; Task 7 calls this on every expand/collapse/threshold change). New module-scope state: `allNodeMeta` (`Map<id, {label, shape, isStack, vlanCache, scanned}>`), `allEdges` (`{from,to}[]`), `graphRoot` (`string|null`), `primaryTree` (`{parentOf, childrenOf, secondaryEdges}`), `expandedNodes` (`Set<string>`, starts empty), `clusterThreshold` (`number`, starts at `8` — Task 7 wires this to a UI control).

- [ ] **Step 1: Make `app.js` a module and import the new files**

In `PS_NetworkMapper/NetworkVisualizer/network_vis.html`, find:

```html
    <!-- Load the Application Logic -->
    <script src="app.js"></script>
```

Replace with:

```html
    <!-- Load the Application Logic -->
    <script type="module" src="app.js"></script>
```

At the very top of `PS_NetworkMapper/NetworkVisualizer/app.js`, add:

```javascript
import { computeGraphRoot, buildPrimaryTree, computeVisibleTree, expandAncestors } from './graph-layout.js';
import { computeLayout } from './elk-layout.js';
```

(Task 7 needs `expandAncestors` in `performGlobalSearch`, in the same file — importing it here now avoids a second, inconsistent dynamic `import()` later.)

- [ ] **Step 2: Add the new layout state**

In `app.js`, find (in the "Protect Globals" section):

```javascript
var physicsEnabled = true;
```

Replace with:

```javascript
var physicsEnabled = true;

// Deterministic layout state (see graph-layout.js / elk-layout.js).
var allNodeMeta = new Map();   // id -> {label, shape, isStack, vlanCache, scanned}
var allEdges = [];             // {from, to}[]
var graphRoot = null;
var primaryTree = { parentOf: new Map(), childrenOf: new Map(), secondaryEdges: [] };
var expandedNodes = new Set();
var clusterThreshold = 8;
```

- [ ] **Step 3: Rewrite `buildSwitchMap` to build metadata instead of rendering directly, then call `renderVisibleGraph`**

Find the whole existing `window.buildSwitchMap` function (from `// 2. THE REPULSION GRAPH ENGINE` through the closing `};` that includes the `network.on("selectNode", ...)` handler) and replace it with:

```javascript
// 2. Topology data -> node/edge metadata (positions are computed separately by renderVisibleGraph)
window.buildSwitchMap = async function() {
    window.hideProgress();

    allNodeMeta.clear();
    allEdges = [];
    var addedEdges = new Set();

    // Pass 1: every device that was actually scanned gets a fully-styled node,
    // even if another device already referenced its IP as a neighbor below.
    globalTopologyData.forEach(device => {
        if (!device || !device.DeviceIP) return;

        var switchIp = String(device.DeviceIP);
        var hostname = device.Hostname || "Unknown";
        var isStack = !!(device.StackMembers && device.StackMembers.length > 1);
        var stackIcon = isStack ? `\n[VC: ${device.StackMembers.length} Node]` : "";

        allNodeMeta.set(switchIp, {
            label: `Switch\n${switchIp}\n(${hostname})${stackIcon}`,
            shape: isStack ? 'database' : 'box', isStack: isStack, scanned: true,
            vlanCache: device.TrueClients ? device.TrueClients.map(c => String(c.VLAN_Tag)) : [],
        });
    });

    // Pass 2: neighbors mentioned via LLDP that were never themselves scanned
    // get a placeholder node instead.
    globalTopologyData.forEach(device => {
        if (!device || !device.DeviceIP || !device.Neighbors) return;
        var switchIp = String(device.DeviceIP);

        device.Neighbors.forEach(neighbor => {
            var neighborIp = String(neighbor.ManagementIP);
            if (!neighborIp || neighborIp === "Unknown" || neighborIp === "0.0.0.0") return;

            if (!allNodeMeta.has(neighborIp)) {
                allNodeMeta.set(neighborIp, {
                    label: `Switch\n${neighborIp}\n(${neighbor.Hostname || "Unknown"})`,
                    shape: 'box', isStack: false, scanned: false, vlanCache: [],
                });
            }

            var edgeKey = [switchIp, neighborIp].sort().join('-');
            if (!addedEdges.has(edgeKey)) {
                allEdges.push({ from: switchIp, to: neighborIp });
                addedEdges.add(edgeKey);
            }
        });
    });

    var nodeIds = Array.from(allNodeMeta.keys());
    graphRoot = computeGraphRoot(nodeIds, allEdges);
    primaryTree = buildPrimaryTree(nodeIds, allEdges, graphRoot);
    expandedNodes = new Set();

    if (network !== null) { network.destroy(); network = null; }
    var container = document.getElementById('mynetwork');
    network = new vis.Network(container, { nodes: nodesDataset, edges: edgesDataset }, {
        layout: { hierarchical: false },
        physics: { enabled: false },
        interaction: { navigationButtons: true, keyboard: true, hover: true, dragNodes: true },
    });
    network.on("selectNode", function (params) {
        if (params.nodes.length === 0) return;
        var id = params.nodes[0];
        var meta = allNodeMeta.get(id);
        if (meta) { window.openRightDrawer(id); return; }
        // Not real device metadata - it's a cluster placeholder. Toggle expansion.
        var clusterParentId = id.startsWith('cluster:') ? id.slice('cluster:'.length) : null;
        if (clusterParentId) {
            expandedNodes.add(clusterParentId);
            window.renderVisibleGraph();
        }
    });

    await window.renderVisibleGraph();
};

// 2b. Recompute the visible subgraph (clustering) and lay it out.
window.renderVisibleGraph = async function() {
    var visible = computeVisibleTree(graphRoot, primaryTree.childrenOf, expandedNodes, clusterThreshold);
    var positions = await computeLayout(visible.visibleNodeIds, visible.visibleEdges);

    nodesDataset.clear(); edgesDataset.clear();

    visible.visibleNodeIds.forEach(id => {
        var pos = positions.get(id) || { x: 0, y: 0 };
        var meta = allNodeMeta.get(id);
        if (meta) {
            nodesDataset.add({
                id: id, label: meta.label, shape: meta.shape, isStack: meta.isStack,
                color: meta.scanned
                    ? (meta.isStack ? { background: '#D2E5FF', border: '#2B7CE9' } : { background: '#97C2FC', border: '#2B7CE9' })
                    : { background: '#E8E8E8', border: '#B0B0B0' },
                font: { multi: true, bold: true, color: meta.scanned ? 'black' : '#666666' },
                vlanCache: meta.vlanCache, x: pos.x, y: pos.y, physics: false,
            });
        } else {
            var cluster = visible.clusters.get(id);
            nodesDataset.add({
                id: id, label: `+${cluster.memberIds.length} devices`, shape: 'box', isCluster: true,
                color: { background: '#fdf6e3', border: '#d9b34e' },
                font: { bold: true, color: '#8a6d1a' },
                borderWidth: 2, shapeProperties: { borderDashes: [6, 4] },
                vlanCache: [], x: pos.x, y: pos.y, physics: false,
            });
        }
    });

    visible.visibleEdges.forEach((e, i) => {
        edgesDataset.add({ id: `primary-${i}`, from: e.from, to: e.to, width: 2, color: '#848484', dashes: false });
    });

    var visibleSet = new Set(visible.visibleNodeIds);
    primaryTree.secondaryEdges.forEach((e, i) => {
        if (visibleSet.has(e.from) && visibleSet.has(e.to)) {
            edgesDataset.add({ id: `secondary-${i}`, from: e.from, to: e.to, width: 1, color: '#c0c0c0', dashes: [4, 4] });
        }
    });
};
```

Note: `physicsToggle` / `togglePhysics` become dead UI now that physics is always off — Task 7 removes that button; leave it as-is for this task so the diff stays reviewable on its own (it'll simply have no visible effect until Task 7).

- [ ] **Step 4: Regression-verify against `TestMap.json` (small graph, no clustering triggered)**

`TestMap.json` has 4 nodes total (3 scanned + 1 unscanned placeholder from Phase 1's fixture), all well under the default threshold of 8 - clustering shouldn't trigger, so this is a pure regression check that everything from Phase 1 still works with the new layout path.

Using the same static-server + headless-Chromium + CDP pattern as Task 5 Step 6, plan:

```json
[
  {"nav": "http://localhost:<port>/NetworkVisualizer/network_vis.html"},
  {"wait": 1000},
  {"eval": "(async () => { const resp = await fetch('../TestMap.json'); const text = await resp.text(); const file = new File([text], 'TestMap.json', {type: 'application/json'}); const dt = new DataTransfer(); dt.items.add(file); document.getElementById('jsonUpload').files = dt.files; window.forceLoadFile(); })(); 'triggered'"},
  {"wait": 3000},
  {"eval": "document.getElementById('status-text').innerText"},
  {"eval": "nodesDataset.length"},
  {"eval": "nodesDataset.get().map(n => ({id: n.id, x: n.x, y: n.y, color: n.color}))"},
  {"eval": "window.openRightDrawer('10.55.2.1'); document.getElementById('drawer-title').innerText"},
  {"shot": "<scratchpad>/task6_regression.png"}
]
```

Expected: status still reads `"Success! Mapped 3 nodes."`; `nodesDataset.length` is `4` (3 scanned + `10.55.2.3` unscanned placeholder); every node has distinct, non-NaN `x`/`y` (confirms ELK positions, not all stacked at `0,0`); `10.55.2.1`'s color is still the blue "scanned" color (confirms the Phase 1 two-pass fix carried over); the drawer still opens on click/selectNode. Compare the screenshot's node layout against the Task 1 (`01_overview.png`) screenshot from Phase 1's manual verification — same 4 nodes, now laid out top-down in tree layers instead of physics-scattered.

- [ ] **Step 5: Commit**

```bash
git add PS_NetworkMapper/NetworkVisualizer/app.js PS_NetworkMapper/NetworkVisualizer/network_vis.html
git commit -m "feat: replace physics layout with graph-center rooted ELK layout"
```

---

### Task 7: Clustering UI + search expands ancestor clusters

**Files:**
- Modify: `PS_NetworkMapper/NetworkVisualizer/network_vis.html` (threshold input; remove the now-dead "Freeze Map Layout" button and its `#legend-group` gets one more line)
- Modify: `PS_NetworkMapper/NetworkVisualizer/app.js` (wire the threshold input; `performGlobalSearch` expands ancestors first)

**Interfaces:**
- Consumes: `expandAncestors` from `graph-layout.js`; `renderVisibleGraph`, `expandedNodes`, `clusterThreshold`, `primaryTree` from Task 6.
- Produces: no new exports — this task is UI wiring only.

- [ ] **Step 1: Remove the dead physics button, add the threshold control**

In `PS_NetworkMapper/NetworkVisualizer/network_vis.html`, find:

```html
            <button id="physicsToggle" class="btn-secondary" onclick="window.togglePhysics()" style="display:none;">Freeze Map Layout</button>
        </div>
```

Replace with:

```html
            <label style="font-size: 0.85rem; font-weight: bold;">Max children before grouping:</label>
            <input type="number" id="clusterThreshold" min="2" max="200" value="8" onchange="window.setClusterThreshold(this.value)">
        </div>
```

Also update the legend block (find `<div class="control-group" id="legend-group"` ... its closing `</div>`) to add one more line documenting the cluster node style, right before the closing `</div>` of that control-group:

```html
            <div class="legend-item"><span class="legend-swatch" style="background:#fdf6e3; border-color:#d9b34e; border-style:dashed;"></span> Collapsed group (click to expand)</div>
```

- [ ] **Step 2: Wire the threshold control and remove `togglePhysics`**

In `app.js`, find:

```javascript
window.togglePhysics = function() {
    if (!network) return;
    var btn = document.getElementById('physicsToggle');
    physicsEnabled = !physicsEnabled;
    network.setOptions({ physics: { enabled: physicsEnabled } });
    btn.innerText = physicsEnabled ? "Freeze Map Layout" : "Unfreeze Map Layout";
    btn.style.backgroundColor = physicsEnabled ? "#f39c12" : "#27ae60";
};
```

Replace with:

```javascript
window.setClusterThreshold = function(value) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 2) return;
    clusterThreshold = n;
    window.renderVisibleGraph();
};
```

Also remove the now-unused `var physicsEnabled = true;` line and the `document.getElementById('physicsToggle').style.display = 'block';` line inside `forceLoadFile`'s success path (search for it — it's right before the `legend-group` display line added in Phase 1; leave that `legend-group` line as-is).

- [ ] **Step 3: Make search expand ancestor clusters before focusing**

In `app.js`, find `window.performGlobalSearch`:

```javascript
    if (targetIp) {
        network.selectNodes([targetIp]);
        network.focus(targetIp, { scale: 1.0, animation: { duration: 500 } });
        window.openRightDrawer(targetIp);
        if (!targetIp.toLowerCase().includes(query)) { window.switchTab('tab-clients'); }
    }
```

Replace with:

```javascript
    if (targetIp) {
        (async () => {
            expandAncestors(primaryTree.parentOf, primaryTree.childrenOf, targetIp, expandedNodes, clusterThreshold);
            await window.renderVisibleGraph();
            network.selectNodes([targetIp]);
            network.focus(targetIp, { scale: 1.0, animation: { duration: 500 } });
            window.openRightDrawer(targetIp);
            if (!targetIp.toLowerCase().includes(query)) { window.switchTab('tab-clients'); }
        })();
    }
```

- [ ] **Step 4: Verify clustering + search-expansion in the browser**

Generate a small fixture with one over-threshold fan-out (11 children off a single "hub" switch, plus a couple of ordinary edges) — save as `/tmp/.../scratchpad/cluster_test.json` with the same `{Topology: [...]}` shape as `TestMap.json` (a hub device whose `Neighbors` array lists 11 distinct `ManagementIP`s, each with a `Hostname`; none of the 11 need their own top-level `Topology` entry — they'll render as unscanned leaves, which is fine for testing clustering purely on tree shape).

Using the static-server + Chromium + CDP pattern from prior tasks:

```json
[
  {"nav": "http://localhost:<port>/NetworkVisualizer/network_vis.html"},
  {"wait": 1000},
  {"eval": "(async () => { const resp = await fetch('/cluster_test.json'); const text = await resp.text(); const file = new File([text], 'cluster_test.json', {type: 'application/json'}); const dt = new DataTransfer(); dt.items.add(file); document.getElementById('jsonUpload').files = dt.files; window.forceLoadFile(); })(); 'triggered'"},
  {"wait": 2000},
  {"eval": "nodesDataset.get().map(n => n.id)"},
  {"shot": "<scratchpad>/task7_clustered.png"},
  {"eval": "(async () => { document.getElementById('globalSearch').value = 'leaf5'; window.performGlobalSearch(); await new Promise(r => setTimeout(r, 1500)); return nodesDataset.get().map(n => n.id); })()"},
  {"wait": 300},
  {"shot": "<scratchpad>/task7_expanded_via_search.png"}
]
```

Expected: first `nodesDataset.get()` shows the hub plus exactly one `cluster:<hubId>` node (not all 11 leaves) — confirms clustering triggers. After searching for a leaf hostname/IP that's inside the collapsed cluster, the second `nodesDataset.get()` includes that leaf directly (no more `cluster:<hubId>` entry, replaced by all 11 real leaf nodes) — confirms `expandAncestors` + re-render correctly reveals it, and the screenshot shows the drawer open on the found node.

- [ ] **Step 5: Commit**

```bash
git add PS_NetworkMapper/NetworkVisualizer/app.js PS_NetworkMapper/NetworkVisualizer/network_vis.html
git commit -m "feat: cluster threshold control, remove dead physics toggle, search expands clusters"
```

---

### Task 8: Synthetic ~500-node fixture and large-scale verification

**Files:**
- Create: `PS_NetworkMapper/NetworkVisualizer/test/generate-fixture.mjs`

**Interfaces:**
- Consumes: nothing (standalone script, run manually with Node — not imported by the app).
- Produces: a generated JSON file (path given on the command line) in the same `{Topology: [...]}` shape as `TestMap.json`/`NetworkMap.json`.

- [ ] **Step 1: Write the fixture generator**

Create `PS_NetworkMapper/NetworkVisualizer/test/generate-fixture.mjs`:

```javascript
// Generates a synthetic ~500-switch topology fixture to verify the layout
// stays readable at real-world scale. Not part of the app - run manually:
//   node generate-fixture.mjs > /tmp/big-fixture.json

function ip(n) {
  return `10.90.${Math.floor(n / 250)}.${(n % 250) + 1}`;
}

const topology = [];
let nextId = 0;
const core = nextId++;

// 6 distribution switches off the core, each with ~80 access switches,
// so the total lands close to 500 (1 core + 6 distribution + ~480 access).
const distributionCount = 6;
const accessPerDistribution = 80;

function makeDevice(id, neighborIds, model) {
  const deviceIp = ip(id);
  return {
    DeviceIP: deviceIp,
    Hostname: `SW-${id}.local`,
    JunosVersion: "22.4R3.25",
    Gateway: ip(core),
    StackMembers: [{ FPC: "0", Model: model, Serial: `SYN${1000000 + id}`, Role: "Standalone" }],
    Neighbors: neighborIds.map(nid => ({
      LocalPort: "xe-0/0/0", RemotePort: "xe-0/0/0",
      Hostname: `SW-${nid}.local`, MacAddress: "02:00:00:00:00:00",
      ManagementIP: ip(nid), Description: "Juniper Networks, Inc.",
    })),
    Clients: [],
    ArpEntries: [],
    Interfaces: [],
  };
}

const distributionIds = Array.from({ length: distributionCount }, () => nextId++);
const accessIdsByDistribution = distributionIds.map(() =>
  Array.from({ length: accessPerDistribution }, () => nextId++)
);

// A handful of redundant/secondary links between distribution switches,
// to exercise the primary-tree/secondary-edge split at scale.
const secondaryLinks = [
  [distributionIds[0], distributionIds[1]],
  [distributionIds[2], distributionIds[3]],
];

topology.push(makeDevice(core, distributionIds, "ex4600-40f"));
distributionIds.forEach((distId, i) => {
  const neighbors = [core, ...accessIdsByDistribution[i]];
  secondaryLinks.forEach(([a, b]) => { if (a === distId) neighbors.push(b); if (b === distId) neighbors.push(a); });
  topology.push(makeDevice(distId, neighbors, "ex3400-48p"));
});
distributionIds.forEach((distId, i) => {
  accessIdsByDistribution[i].forEach(accessId => {
    topology.push(makeDevice(accessId, [distId], "ex2300-24t"));
  });
});

process.stdout.write(JSON.stringify({ Topology: topology }, null, 2));
```

- [ ] **Step 2: Generate the fixture and sanity-check its size**

```bash
cd PS_NetworkMapper/NetworkVisualizer/test
node generate-fixture.mjs > /tmp/claude-1000/big-fixture.json
node -e "const d = require('/tmp/claude-1000/big-fixture.json'); console.log('devices:', d.Topology.length); console.log('total neighbor edges (directed):', d.Topology.reduce((s,t) => s + t.Neighbors.length, 0));"
```

Expected: `devices:` prints a number close to 487 (1 core + 6 distribution + 480 access); edge count consistent with a mostly-tree topology plus the two secondary links.

- [ ] **Step 3: Load it in the browser and verify the layout stays usable**

Using the static-server + Chromium + CDP pattern from prior tasks (serve `/tmp/claude-1000/` alongside `PS_NetworkMapper/`, or copy the fixture into a location the server already roots — simplest is copying it to `PS_NetworkMapper/big-fixture.json` temporarily for this manual verification, then deleting it afterward since it's not meant to be committed):

```json
[
  {"nav": "http://localhost:<port>/NetworkVisualizer/network_vis.html"},
  {"wait": 1000},
  {"eval": "(async () => { const resp = await fetch('../big-fixture.json'); const text = await resp.text(); const file = new File([text], 'big-fixture.json', {type: 'application/json'}); const dt = new DataTransfer(); dt.items.add(file); document.getElementById('jsonUpload').files = dt.files; window.forceLoadFile(); })(); 'triggered'"},
  {"wait": 15000},
  {"eval": "document.getElementById('status-text').innerText"},
  {"eval": "nodesDataset.length"},
  {"shot": "<scratchpad>/task8_large_topology_overview.png"},
  {"eval": "(async () => { var clusterId = nodesDataset.get().find(n => n.isCluster).id; var parentId = clusterId.slice('cluster:'.length); expandedNodes.add(parentId); await window.renderVisibleGraph(); return nodesDataset.length; })()"},
  {"wait": 300},
  {"shot": "<scratchpad>/task8_after_expand.png"}
]
```

Expected: status reads `"Success! Mapped 487 nodes."` (or whatever the actual generated count is); render completes without the tab hanging (bounded by the 15s wait plus ELK's own 8s internal timeout - if it's still not done, that's a real problem to investigate, not something to raise the wait past); `nodesDataset.length` after initial load is small (single digits to low tens — 1 core + 6 distribution + 6 cluster placeholders, since every distribution switch has 80 children, over the default threshold of 8) rather than 487, confirming clustering keeps the default view readable; the first screenshot shows a clean top-down tree of a manageable number of boxes; after expanding one cluster, `nodesDataset.length` grows by that cluster's member count and the second screenshot shows those newly-revealed leaves laid out sanely (not overlapping, not off-screen at extreme coordinates).

- [ ] **Step 4: Clean up the temporary fixture copy and commit the generator**

```bash
rm -f /home/alexander/Documents/Programming/Networking_Toolbox/PS_NetworkMapper/big-fixture.json
git add PS_NetworkMapper/NetworkVisualizer/test/generate-fixture.mjs
git commit -m "test: add synthetic ~500-node fixture generator for large-scale layout verification"
```

---

## Self-Review Notes

- **Spec coverage:** graph-center root (Task 1) ✓, primary tree / secondary edges (Task 2) ✓, child-count clustering (Task 3, Task 7 UI) ✓, ELK in a Web Worker with fallback (Task 4, 5) ✓, integration replacing physics (Task 6) ✓, search expands clusters (Task 7 Step 3) ✓, 500-node testing (Task 8) ✓. Map-overlay mode and site-based grouping: explicitly out of scope per the spec, no task implements them, none should.
- **Placeholder scan:** every step has concrete code or a concrete verification plan with expected output; no "add error handling" or "TBD" left in.
- **Type consistency:** `visibleNodeIds`/`visibleEdges`/`clusters` shape from Task 3 is consumed as-is by Task 6's `renderVisibleGraph`; `parentOf`/`childrenOf` shape from Task 2 is consumed as-is by Task 3's tests and Task 7's `expandAncestors` call; `computeLayout`'s `Map<string,{x,y}>` return is consumed as-is in Task 6. Function names match their Task 1/2/3 export declarations everywhere they're called in later tasks.
