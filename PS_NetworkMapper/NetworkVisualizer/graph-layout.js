// Pure graph algorithms for the topology layout: no DOM, no vis-network,
// no browser globals. Importable from both the browser and node:test.

// Splits a dotted-quad-shaped ID into comparable numeric octets; IDs that
// aren't dotted-quads (e.g. "cluster:10.55.2.2") fall back to string compare.
function compareIpIds(a, b) {
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

function computeGraphRoot(nodeIds, edges) {
  if (nodeIds.length === 0) return null;
  if (nodeIds.length === 1) return nodeIds[0];

  const adj = buildAdjacency(nodeIds, edges);
  let bestId = null;
  let bestComponentSize = -1;
  let bestEccentricity = Infinity;

  const sortedIds = Array.from(nodeIds).sort(compareIpIds);
  for (const id of sortedIds) {
    const dist = bfsDistances(adj, id);
    const componentSize = dist.size;
    let eccentricity = 0;
    for (const d of dist.values()) eccentricity = Math.max(eccentricity, d);

    if (componentSize > bestComponentSize ||
        (componentSize === bestComponentSize && eccentricity < bestEccentricity)) {
      bestComponentSize = componentSize;
      bestEccentricity = eccentricity;
      bestId = id;
    }
  }
  return bestId;
}

function buildPrimaryTree(nodeIds, edges, rootId) {
  const adj = buildAdjacency(nodeIds, edges);
  const parentOf = new Map([[rootId, null]]);
  const childrenOf = new Map([[rootId, []]]);
  const treeEdgeKeys = new Set();

  const edgeKey = (a, b) => [a, b].sort(compareIpIds).join('|');

  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = Array.from(adj.get(current) || []).sort(compareIpIds);
    for (const next of neighbors) {
      if (!parentOf.has(next)) {
        parentOf.set(next, current);
        childrenOf.set(next, []);
        childrenOf.get(current).push(next);
        treeEdgeKeys.add(edgeKey(current, next));
        queue.push(next);
      }
    }
  }

  const secondaryEdges = edges.filter(e => !treeEdgeKeys.has(edgeKey(e.from, e.to)));

  return { parentOf, childrenOf, secondaryEdges };
}

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

function computeVisibleTree(rootId, childrenOf, expandedNodes, threshold) {
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

function expandAncestors(parentOf, childrenOf, targetId, expandedNodes, threshold) {
  let current = parentOf.get(targetId);
  while (current != null) {
    const childCount = (childrenOf.get(current) || []).length;
    if (childCount > threshold) expandedNodes.add(current);
    current = parentOf.get(current);
  }
}

// Re-arranges the leaf children of any "leaf-parent" (a node whose children are all
// themselves leaves) into a compact grid instead of the wide arc a radial layout gives
// them, once there are enough of them to be worth it. The grid is rotated to point in
// the same root->parent direction the branch already radiates in, so it reads as "a
// cluster at the tip of this spoke" rather than a layout that's inconsistent with the
// rest of the (untouched) radial tree. Only leaf positions move - every non-leaf-parent
// node (including every leaf-parent itself) keeps exactly the position `positions` came
// in with, per this being scoped to "the outer ring only" (see the app's chat history:
// the inner rings' plain radial placement was explicitly fine and must not change).
function applyLeafGridClustering(positions, rootId, childrenOf, options) {
  const opts = options || {};
  const threshold = opts.leafGridThreshold ?? 5;
  const spacingX = opts.gridSpacingX ?? 190;
  const spacingY = opts.gridSpacingY ?? 90;
  const baseOffset = opts.gridBaseOffset ?? 110;
  const minNodeSpacing = opts.minNodeSpacing ?? 170;
  const maxPushesPerBranch = 200;

  const result = new Map(positions);
  const rootPos = positions.get(rootId);
  if (!rootPos) return result;

  const isLeaf = id => !childrenOf.has(id) || childrenOf.get(id).length === 0;
  const parents = Array.from(childrenOf.keys())
    .filter(id => {
      const kids = childrenOf.get(id);
      return kids.length >= threshold && kids.every(isLeaf) && positions.has(id);
    })
    // Angular order, not ID order: collision resolution below finalizes one branch at a
    // time and never revisits an earlier one, so branches must be visited in the same
    // order they're actually laid out around the root - otherwise a branch can be
    // finalized while a not-yet-placed neighbor still overlaps it, or the resolution
    // can end up pushing whichever branch happens to sort last in ID order regardless
    // of which one is actually closest to a collision (confirmed - this was a real bug,
    // not a hypothetical one: on the full 342-node sample it left most branches
    // un-pushed in a tight clump while repeatedly ejecting one or two unlucky others).
    .sort((a, b) => {
      const pa = positions.get(a), pb = positions.get(b);
      return Math.atan2(pa.y - rootPos.y, pa.x - rootPos.x) - Math.atan2(pb.y - rootPos.y, pb.x - rootPos.x);
    });

  if (parents.length === 0) return result;

  function placeGrid(parentId, offset) {
    const kids = childrenOf.get(parentId);
    const pPos = positions.get(parentId);
    const dx = pPos.x - rootPos.x, dy = pPos.y - rootPos.y;
    const dist = Math.hypot(dx, dy);
    const angle = dist > 0 ? Math.atan2(dy, dx) : 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const cols = Math.ceil(Math.sqrt(kids.length));
    const placed = new Map();
    kids.forEach((childId, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const localX = (col - (cols - 1) / 2) * spacingX; // perpendicular spread (columns)
      const localY = offset + row * spacingY;            // outward growth (rows)
      // Local +Y (outward growth) must map onto the root->parent direction (cos, sin);
      // local +X (column spread) onto the perpendicular (-sin, cos). Verified against
      // theta=0 (parent due east of root): row 0 should land further east of the parent,
      // continuing the same root->parent direction, not perpendicular to it.
      placed.set(childId, {
        x: pPos.x + localY * cos - localX * sin,
        y: pPos.y + localY * sin + localX * cos,
      });
    });
    return placed;
  }

  function collidesWithAny(gridPositions, finalizedGrids) {
    for (const other of finalizedGrids) {
      for (const a of gridPositions) {
        for (const b of other) {
          if (Math.hypot(a.x - b.x, a.y - b.y) < minNodeSpacing) return true;
        }
      }
    }
    return false;
  }

  // Single pass in angular order: each branch is pushed out just far enough to clear
  // every branch already finalized before it, then never revisited. Distinct rays out
  // of a common root diverge as radius grows, so a large-enough offset always exists
  // and this always terminates - no cross-branch re-checking, no oscillation.
  const finalizedGrids = [];
  const finalPositions = new Map();
  for (const p of parents) {
    let offset = baseOffset;
    let grid = placeGrid(p, offset);
    let pushes = 0;
    while (collidesWithAny(Array.from(grid.values()), finalizedGrids) && pushes < maxPushesPerBranch) {
      offset += spacingY;
      grid = placeGrid(p, offset);
      pushes++;
    }
    finalizedGrids.push(Array.from(grid.values()));
    finalPositions.set(p, grid);
  }

  for (const p of parents) {
    for (const [childId, pos] of finalPositions.get(p)) {
      result.set(childId, pos);
    }
  }
  return result;
}

// Dual-mode export: node:test imports this file via ESM `import {...}` syntax, which
// Node resolves against `module.exports` here through its built-in CJS/ESM interop
// (confirmed working - no `export` keyword needed for named imports to work). The
// browser loads this same file as a classic <script>, where `module` doesn't exist,
// so it attaches to `window.GraphLayout` instead. Using `export` + `type="module"` here
// was the original approach, but ES modules cannot fetch anything under file://, which
// this tool must support with no local web server available.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { compareIpIds, computeGraphRoot, buildPrimaryTree, computeVisibleTree, expandAncestors, applyLeafGridClustering };
} else if (typeof window !== 'undefined') {
    window.GraphLayout = { compareIpIds, computeGraphRoot, buildPrimaryTree, computeVisibleTree, expandAncestors, applyLeafGridClustering };
}
