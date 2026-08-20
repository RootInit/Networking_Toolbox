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

// Places every node in the visible tree recursively: a node's children fan out around
// IT the same way root's children fan out around root. A "leaf-parent" (a node whose
// children are all themselves leaves) is the one special case - instead of continuing
// the wedge it inherited from ITS OWN parent, its children form a concentric-ring
// cluster centered on itself, using a full circle, unconstrained by that wedge: "a
// smaller version of the center node," literally the same ring-packing math root uses,
// just a smaller radius. That's what keeps it compact (ring capacity grows with radius,
// so packing scales roughly with sqrt(childCount) instead of linearly) without needing
// the wedge angle a wide leaf-heavy branch would otherwise be forced to squeeze into.
//
// Every node above a leaf-parent computes its OWN children's spacing as the larger of
// the normal nodeSpacing and twice the largest cluster radius among those children (a
// bottom-up "extent" pass, cached per node) - so if any one branch has an unusually
// large leaf cluster, EVERY sibling at that level is spaced out to match, uniformly.
// This was chosen deliberately over pushing just the oversized branch outward: pushing
// individual branches is what produced "some nodes way too close together, some pushed
// way too far" in an earlier version - a uniform spacing adjustment applied to a whole
// ring never singles one branch out.
//
// This replaces an ELK-based approach (plain 'radial' for inner tiers + a hand-rolled
// grid for the leaf tier): ELK computes one GLOBAL radius per depth level, weighted by
// how many descendants that whole level has - confirmed via headless-browser screenshot
// (not just reasoning about it) to visibly collapse the whole distribution-level ring
// down near the root whenever the network's full leaf tier is exposed at once, since
// that level's huge total descendant count dominates ELK's per-level radius choice for
// every other level too, not just its own.
//
// A first attempt at a from-scratch replacement gave every node (not just leaf-parents)
// a single ring, sized to its own local child count - "local" fixed the ELK bug, but a
// leaf-heavy branch inheriting a narrow wedge from a parent with many siblings still
// needed a huge radius to fit its children on one ring within that narrow wedge (~135000px
// on the real ~340-node sample, confirmed by measuring it - worse than what it replaced).
// A second attempt tried multiple rings within that inherited wedge to fix the blowup,
// reusing the same angular columns across every ring; that's wrong for recursion - two
// nodes sharing a column (one shallow, one a row further out) share an angle, and each
// independently recurses its own descendants straight outward along that same angle,
// which can land unrelated nodes on exactly identical coordinates (confirmed empirically,
// not hypothesized). Centering each leaf-parent's own cluster on itself instead of on an
// inherited wedge sidesteps the whole class of problem: it never needs to share angular
// territory with anything outside its own subtree in the first place.
function computeRecursiveRadialLayout(rootId, childrenOf, options) {
  const opts = options || {};
  const nodeSpacing = opts.nodeSpacing ?? 190;
  const minRadius = opts.minRadius ?? 190;

  const positions = new Map();
  if (rootId == null) return positions;
  positions.set(rootId, { x: 0, y: 0 });

  const isLeaf = id => !childrenOf.has(id) || childrenOf.get(id).length === 0;
  const isLeafParent = id => {
    const kids = childrenOf.get(id);
    return !!kids && kids.length > 0 && kids.every(isLeaf);
  };

  // How many concentric rings, each holding as many nodes as its own circumference
  // allows (>= nodeSpacing apart), does it take to fit n nodes around a point? Returns
  // the outermost ring's radius - the cluster's overall extent from its own center.
  function clusterRadius(n) {
    let idx = 0, ring = 0, r = minRadius;
    while (idx < n) {
      r = minRadius + ring * nodeSpacing;
      const capacity = Math.max(1, Math.floor((2 * Math.PI * r) / nodeSpacing));
      idx += Math.min(capacity, n - idx);
      ring++;
    }
    return r;
  }

  // Bottom-up, cached: how far from its OWN position does nodeId's subtree extend?
  // Leaves: 0. Leaf-parents: their own cluster's radius. Everything else: however far out
  // its own single-ring child placement reaches, plus the largest extent among its
  // children (since that child's own subtree continues from there).
  const extentCache = new Map();
  function extent(nodeId) {
    if (extentCache.has(nodeId)) return extentCache.get(nodeId);
    let result;
    if (isLeaf(nodeId)) {
      result = 0;
    } else if (isLeafParent(nodeId)) {
      result = clusterRadius(childrenOf.get(nodeId).length);
    } else {
      const kids = childrenOf.get(nodeId);
      const maxChildExtent = Math.max(0, ...kids.map(extent));
      const n = kids.length;
      // A center distance of just 2*maxChildExtent only guarantees the two DISCS don't
      // overlap in area - a node sitting right on each disc's boundary, pointing directly
      // at the other, could still land arbitrarily close to its counterpart (confirmed
      // empirically: two adjacent large clusters landed nodes 76px apart with only the
      // sum-of-radii margin). Adding nodeSpacing on top guarantees an actual gap.
      const effSpacing = nodeSpacing + 2 * maxChildExtent;
      const childRadius = n > 1 ? effSpacing / (2 * Math.sin(Math.PI / n)) : 0;
      result = Math.max(minRadius, childRadius) + maxChildExtent;
    }
    extentCache.set(nodeId, result);
    return result;
  }

  function placeClusterAround(centerPos, kids) {
    const n = kids.length;
    let idx = 0, ring = 0;
    while (idx < n) {
      const r = minRadius + ring * nodeSpacing;
      const capacity = Math.max(1, Math.floor((2 * Math.PI * r) / nodeSpacing));
      const count = Math.min(capacity, n - idx);
      for (let i = 0; i < count; i++) {
        const angle = (2 * Math.PI * i) / count;
        positions.set(kids[idx], {
          x: centerPos.x + r * Math.cos(angle),
          y: centerPos.y + r * Math.sin(angle),
        });
        idx++;
      }
      ring++;
    }
  }

  function place(nodeId, angleHint, angleSpan) {
    const kids = childrenOf.get(nodeId) || [];
    const n = kids.length;
    if (n === 0) return;
    const parentPos = positions.get(nodeId);

    if (isLeafParent(nodeId)) {
      placeClusterAround(parentPos, kids);
      return; // leaves have no children of their own - nothing left to recurse into
    }

    const maxChildExtent = Math.max(0, ...kids.map(extent));
    const effSpacing = nodeSpacing + 2 * maxChildExtent; // see extent()'s comment above on why +nodeSpacing, not just 2x
    const childSpan = angleSpan / n;
    // Straight-line (chord) distance between adjacent same-radius children is
    // 2*radius*sin(childSpan/2) - solving for the radius that keeps that >= effSpacing.
    const radius = Math.max(minRadius, n > 1 ? effSpacing / (2 * Math.sin(childSpan / 2)) : 0);

    kids.forEach((childId, i) => {
      const angle = angleHint - angleSpan / 2 + (i + 0.5) * childSpan;
      positions.set(childId, {
        x: parentPos.x + radius * Math.cos(angle),
        y: parentPos.y + radius * Math.sin(angle),
      });
      place(childId, angle, childSpan);
    });
  }

  place(rootId, 0, 2 * Math.PI);
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
