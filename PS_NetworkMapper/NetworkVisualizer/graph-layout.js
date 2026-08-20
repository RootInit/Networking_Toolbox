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

// Places every node in the visible tree recursively, with ONE rule applied uniformly at
// every depth: a node's children fan out around IT in a full circle, unconstrained by
// anything above it - "a smaller version of the center node," literally the same
// ring-packing math root uses, just a smaller radius, at every single level. A node
// whose children are all leaves uses leafSpacing for that circle's packing; every other
// node uses nodeSpacing. That's the only thing that varies by depth - the placement rule
// itself doesn't.
//
// Earlier versions special-cased this: only a "leaf-parent" (a node whose children are
// all themselves leaves) got a self-centered full circle: every other node continued a
// wedge inherited from ITS OWN parent, wide enough at the top (root's own wedge is the
// full circle) but narrower at every level down. That is wrong wherever the tree is
// deeper than root -> branch -> leaf: a second-level branch (e.g. this network's sample
// data has two core switches, the second one hanging off the first as an ordinary child,
// with its own ~8 distribution switches under it) inherited a narrow wedge from root and
// had to cram its own children's clusters into it, reproducing the exact "narrow wedge
// forces a huge radius" problem that motivated centering leaf clusters on themselves in
// the first place - confirmed directly (reported as visibly cramped), then measured: that
// second core's own children landed at radius ~26000px from it, roughly 3.4x root's own
// ring radius, on the real ~340-node sample. Dropping wedge inheritance for every level,
// not just the leaf tier, removes the problem instead of chasing it level by level.
//
// Every node computes its OWN children's spacing as the larger of the relevant spacing
// constant and the worst actual ADJACENT pair's combined extent among its children (a
// bottom-up "extent" pass, cached per node) - so if any one child has an unusually large
// subtree, only the neighbors actually sitting next to it are spaced out to match, not
// every sibling uniformly regardless of who's actually adjacent to whom (that was an
// earlier, needlessly conservative version - reported directly as clusters sitting far
// apart with no realistic risk of overlapping).
function computeRecursiveRadialLayout(rootId, childrenOf, options) {
  const opts = options || {};
  // nodeSpacing governs structural (branch-to-branch) placement: how far apart sibling
  // branches sit, and the safety margin between two different clusters. leafSpacing
  // governs only the packing WITHIN one cluster (leaf-to-leaf distance). Splitting these
  // was requested directly: clusters as a whole should be able to sit closer to root and
  // to each other (smaller nodeSpacing) while the individual leaves inside each one get
  // more room (bigger leafSpacing) - one shared constant couldn't do both at once.
  const nodeSpacing = opts.nodeSpacing ?? 190;
  const leafSpacing = opts.leafSpacing ?? 190;
  const minRadius = opts.minRadius ?? 190;

  const positions = new Map();
  if (rootId == null) return positions;
  positions.set(rootId, { x: 0, y: 0 });

  const isLeaf = id => !childrenOf.has(id) || childrenOf.get(id).length === 0;
  const allChildrenAreLeaves = kids => kids.every(isLeaf);

  // Only two children that actually end up NEXT TO EACH OTHER can ever collide - using
  // 2*(the single largest extent among all children) as the required spacing for EVERY
  // pair is only correct when the two biggest clusters happen to be adjacent, and is
  // needlessly conservative otherwise. The real, tighter requirement is the worst actual
  // adjacent pair's combined extent. Children are spread evenly in array order around a
  // full circle, so every child (including the pair wrapping from last back to first) has
  // exactly two neighbors.
  function maxAdjacentPairExtentSum(extents) {
    const n = extents.length;
    if (n < 2) return 0;
    let maxSum = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      maxSum = Math.max(maxSum, extents[i] + extents[j]);
    }
    return maxSum;
  }

  // Given n children each needing `spacing` clearance from their neighbors, the radius
  // of the single ring that fits them evenly around a full circle - solved from the
  // straight-line (chord) distance between adjacent same-radius points,
  // 2*radius*sin(PI/n), which must be >= spacing.
  function ringRadius(n, spacing) {
    return n > 1 ? spacing / (2 * Math.sin(Math.PI / n)) : 0;
  }

  // Bottom-up, cached: how far from its OWN position does nodeId's subtree extend?
  // Leaves: 0. Everything else: however far out its own child-placement ring reaches,
  // plus the largest extent among its children (since that child's own subtree
  // continues from there).
  const extentCache = new Map();
  function extent(nodeId) {
    if (extentCache.has(nodeId)) return extentCache.get(nodeId);
    let result;
    if (isLeaf(nodeId)) {
      result = 0;
    } else {
      const kids = childrenOf.get(nodeId);
      const extents = kids.map(extent);
      const maxChildExtent = Math.max(0, ...extents);
      const spacing = allChildrenAreLeaves(kids) ? leafSpacing : nodeSpacing;
      // A center distance of just the adjacent-pair extent sum only guarantees the two
      // DISCS don't overlap in area - a node sitting right on each disc's boundary,
      // pointing directly at the other, could still land arbitrarily close to its
      // counterpart (confirmed empirically: two adjacent large clusters landed nodes
      // 76px apart with only that margin). Adding the spacing constant on top
      // guarantees an actual gap.
      const effSpacing = spacing + maxAdjacentPairExtentSum(extents);
      result = Math.max(minRadius, ringRadius(kids.length, effSpacing)) + maxChildExtent;
    }
    extentCache.set(nodeId, result);
    return result;
  }

  function place(nodeId) {
    const kids = childrenOf.get(nodeId) || [];
    const n = kids.length;
    if (n === 0) return;
    const parentPos = positions.get(nodeId);

    const extents = kids.map(extent);
    const spacing = allChildrenAreLeaves(kids) ? leafSpacing : nodeSpacing;
    const effSpacing = spacing + maxAdjacentPairExtentSum(extents);
    const radius = Math.max(minRadius, ringRadius(n, effSpacing));

    kids.forEach((childId, i) => {
      const angle = (2 * Math.PI * i) / n;
      positions.set(childId, {
        x: parentPos.x + radius * Math.cos(angle),
        y: parentPos.y + radius * Math.sin(angle),
      });
      place(childId);
    });
  }

  place(rootId);
  return positions;
}

// Dual-mode export: node:test imports this file via ESM `import {...}` syntax, which
// Node resolves against `module.exports` here through its built-in CJS/ESM interop
// (confirmed working - no `export` keyword needed for named imports to work). The
// browser loads this same file as a classic <script>, where `module` doesn't exist,
// so it attaches to `window.GraphLayout` instead. Using `export` + `type="module"` here
// was the original approach, but ES modules cannot fetch anything under file://, which
// this tool must support with no local web server available.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { compareIpIds, computeGraphRoot, buildPrimaryTree, computeVisibleTree, expandAncestors, computeRecursiveRadialLayout };
} else if (typeof window !== 'undefined') {
    window.GraphLayout = { compareIpIds, computeGraphRoot, buildPrimaryTree, computeVisibleTree, expandAncestors, computeRecursiveRadialLayout };
}
