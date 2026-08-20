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
// Every node's children sit at fixed, evenly-spaced angles around it (same as before),
// but each child's DISTANCE from that shared center is relaxed individually instead of
// forced onto one uniform ring: pulled in toward its own natural resting distance (just
// far enough to clear its own cluster from the parent), pushed out only as far as an
// actual conflict with another child requires. A uniform ring - even one sized from the
// worst actual adjacent pair rather than the single biggest cluster everywhere (an
// earlier version) - still forces every child out to match whichever child needs the
// most room; a small cluster next to a huge one had no way to sit closer just because
// IT was small. This was requested directly against a manually-arranged reference
// layout: small clusters pulled in close, large ones given more room, individually.
//
// The relaxation is a fixed-iteration numerical pass, not a live physics simulation -
// same input always produces the same output, and it runs once during layout
// computation with no animation. It checks every pair of a node's children against each
// other each iteration, not just angular neighbors - two children two steps apart in
// angle can still end up closer to each other than to their own immediate neighbor once
// each has its own independent radius, so only checking adjacent pairs (correct when
// every child shared one radius) would miss that.
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
  const relaxIterations = opts.relaxIterations ?? 150;

  const positions = new Map();
  if (rootId == null) return positions;
  positions.set(rootId, { x: 0, y: 0 });

  const isLeaf = id => !childrenOf.has(id) || childrenOf.get(id).length === 0;
  const allChildrenAreLeaves = kids => kids.every(isLeaf);

  // Each child's angular slice is proportional to its own natural size (minRadius +
  // its extent), not an equal 1/n share - a child with a much bigger subtree than its
  // siblings gets a wider slice. Without this, a single disproportionately large child
  // (this network's sample data has two core switches; the second hangs off the first
  // as an ordinary child with a whole distribution/access tree of its own) still forced
  // its immediate angular neighbors out to nearly its own radius just to clear its disc
  // from that close an angle, even though radius alone was already being relaxed
  // per-child - confirmed directly (reported as two halves with a large gap between
  // them) and then measured: the two children adjacent to the oversized one landed at
  // radius ~9800 and ~11800, nearly as far as the oversized child's own ~12300, while
  // children further away in angle stayed at ~2000-3000. A wider slice for the big
  // child reduces how close its neighbors sit to it in angle, which directly reduces
  // how far out radius alone has to push them to clear it.
  function computeChildAngles(naturalMin) {
    const n = naturalMin.length;
    const total = naturalMin.reduce((a, b) => a + b, 0);
    const angles = [];
    let cumulative = 0;
    for (let i = 0; i < n; i++) {
      const width = (naturalMin[i] / total) * 2 * Math.PI;
      angles.push(cumulative + width / 2);
      cumulative += width;
    }
    return angles;
  }

  // Finds each of n children's own minimal radius from their shared center, given each
  // child's fixed angle (see computeChildAngles above - proportional to size, not an
  // equal share). Starts everyone at their own natural resting radius (just clears
  // their own extent from the center), then repeatedly checks every pair: if child i is
  // currently too close to child j (chord distance, from the law of cosines at their
  // angle gap, below the two extents' combined requirement), i is pushed out to
  // the minimum radius that clears j - never pulled back in below its own natural rest,
  // and never adjusted by moving j instead (j gets its own turn in the same sweep).
  function relaxRadii(extents, spacing) {
    const n = extents.length;
    if (n === 0) return { radii: [], angles: [] };
    const naturalMin = extents.map(e => minRadius + e);
    const angles = computeChildAngles(naturalMin);
    if (n === 1) return { radii: naturalMin, angles };

    const radii = naturalMin.slice();

    for (let iter = 0; iter < relaxIterations; iter++) {
      // Jacobi-style: every i's update this sweep reads only `radii` as it stood at the
      // START of the sweep, and all updates apply together at the end. Updating radii[i]
      // in place as each i is processed (Gauss-Seidel) makes the result depend on
      // processing order: whichever child is processed LAST in a sweep sees its
      // neighbors already freshly pushed outward, and since a large-enough neighbor
      // radius alone can satisfy the chord-distance requirement (dominating the
      // separation) even while ri stays small, that child can end up never growing at
      // all - confirmed empirically: 40 IDENTICAL leaves (same extent, so logically
      // interchangeable) converged to wildly different radii (190 to 1120) purely from
      // processing order. Reading a single consistent snapshot for the whole sweep
      // removes that order-dependence.
      const next = radii.slice();
      for (let i = 0; i < n; i++) {
        let desired = radii[i];
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const requiredDist = extents[i] + extents[j] + spacing;
          const rawDiff = Math.abs(angles[i] - angles[j]);
          const angleDiff = Math.min(rawDiff, 2 * Math.PI - rawDiff);
          const rj = radii[j];
          const cosA = Math.cos(angleDiff);
          // chord(ri)^2 = ri^2 - 2*rj*cosA*ri + rj^2 is a parabola in ri, minimized at
          // ri=rj*cosA - so the constraint chord(ri) >= requiredDist holds OUTSIDE
          // [smallerRoot, largerRoot], not inside. `desired` (a small, near-zero-ish
          // radius relative to a much bigger rj) can already be safely below
          // smallerRoot and satisfy the constraint on its own, dominated by rj's own
          // distance from center - pushing straight to the larger root regardless would
          // then be a needless, and compounding, escalation (confirmed empirically: a
          // version that always jumped to the larger root diverged to radii in the
          // billions within 150 iterations on realistic tree shapes). Only push out at
          // all when `desired` currently, actually violates the constraint.
          const chordSq = desired * desired - 2 * rj * cosA * desired + rj * rj;
          if (chordSq < requiredDist * requiredDist) {
            const b = -2 * rj * cosA;
            const c = rj * rj - requiredDist * requiredDist;
            const disc = b * b - 4 * c;
            const candidate = disc >= 0 ? (-b + Math.sqrt(disc)) / 2 : rj + requiredDist;
            if (candidate > desired) desired = candidate;
          }
        }
        next[i] = desired;
      }
      for (let i = 0; i < n; i++) radii[i] = next[i];
    }
    return { radii, angles };
  }

  const extentCache = new Map();
  const layoutCache = new Map(); // nodeId -> {radii, angles} for its children, same order as childrenOf.get(nodeId)

  function childLayout(nodeId) {
    if (layoutCache.has(nodeId)) return layoutCache.get(nodeId);
    const kids = childrenOf.get(nodeId) || [];
    const extents = kids.map(extent);
    const spacing = allChildrenAreLeaves(kids) ? leafSpacing : nodeSpacing;
    const layout = relaxRadii(extents, spacing);
    layoutCache.set(nodeId, layout);
    return layout;
  }

  // Bottom-up, cached: how far from its OWN position does nodeId's subtree extend?
  // Leaves: 0. Everything else: the farthest any child's own (radius from here + that
  // child's own extent) reaches, since children now sit at individually varying radii
  // rather than one uniform ring.
  function extent(nodeId) {
    if (extentCache.has(nodeId)) return extentCache.get(nodeId);
    let result;
    if (isLeaf(nodeId)) {
      result = 0;
    } else {
      const kids = childrenOf.get(nodeId);
      const { radii } = childLayout(nodeId);
      let maxReach = 0;
      for (let i = 0; i < kids.length; i++) {
        maxReach = Math.max(maxReach, radii[i] + extent(kids[i]));
      }
      result = maxReach;
    }
    extentCache.set(nodeId, result);
    return result;
  }

  function place(nodeId) {
    const kids = childrenOf.get(nodeId) || [];
    const n = kids.length;
    if (n === 0) return;
    const parentPos = positions.get(nodeId);
    const { radii, angles } = childLayout(nodeId);

    kids.forEach((childId, i) => {
      positions.set(childId, {
        x: parentPos.x + radii[i] * Math.cos(angles[i]),
        y: parentPos.y + radii[i] * Math.sin(angles[i]),
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
