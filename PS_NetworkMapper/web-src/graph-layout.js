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

// Places every node in the visible tree recursively: a node's children fan out around IT
// in a full circle at every depth (not a wedge inherited from its parent - that made deep
// branches cram into a narrow slice and blow up their radius). leafSpacing packs a
// circle whose children are all leaves; nodeSpacing is used otherwise.
//
// Each child's angle is fixed and evenly spaced, but its DISTANCE from the shared center
// is relaxed individually via a fixed-iteration numerical pass (deterministic, no
// animation) rather than forced onto one uniform ring - so a small cluster can sit closer
// than a large sibling instead of both being pushed to the same radius. All pairs of
// children are checked each iteration, not just angular neighbors, since two children
// with independent radii can end up closer to each other than to their nominal neighbor.
function computeRecursiveRadialLayout(rootId, childrenOf, options) {
  const opts = options || {};
  // nodeSpacing: branch-to-branch separation and inter-cluster margin.
  // leafSpacing: packing within one cluster (leaf-to-leaf distance).
  const nodeSpacing = opts.nodeSpacing ?? 350;
  const leafSpacing = opts.leafSpacing ?? 250;
  const minRadius = opts.minRadius ?? 250;
  const relaxIterations = opts.relaxIterations ?? 150;
  // Absolute Date.now() timestamp (not a duration - this function runs synchronously
  // start-to-finish, so there's no "elapsed since call" to track against; the caller,
  // elk-layout.js, computes this from its own timeout budget). Undefined/null means no
  // bound, which is what every existing caller (including every test) gets by omitting it.
  //
  // This exists because racing this call against a timer Promise (elk-layout.js used to do
  // this alone, with no cap in here) cannot work: JS is single-threaded, so a pending
  // setTimeout callback can't run until this synchronous computation returns control to the
  // event loop - by which point it has already finished, whether that took 1 second or 100.
  // The only way to actually cap wall-clock time is to check it from inside the computation.
  const deadline = opts.deadline ?? null;
  function checkDeadline() {
    if (deadline !== null && Date.now() > deadline) {
      throw new Error(`Layout exceeded its time budget (${relaxIterations} max relax iterations/level)`);
    }
  }

  const positions = new Map();
  if (rootId == null) return positions;
  positions.set(rootId, { x: 0, y: 0 });

  const isLeaf = id => !childrenOf.has(id) || childrenOf.get(id).length === 0;
  const allChildrenAreLeaves = kids => kids.every(isLeaf);

  // Each child's angular slice is proportional to its own natural size (minRadius +
  // extent), not an equal 1/n share - otherwise a disproportionately large child forces
  // its close angular neighbors out to nearly its own radius just to clear it.
  function computeChildAngles(naturalMin) {
    const n = naturalMin.length;
    const total = naturalMin.reduce((a, b) => a + b, 0);
    // total is only 0 if every child is a leaf with minRadius 0 (not reachable via the
    // UI, which floors minRadius at 20, but this fn is called directly in tests) -
    // guard against NaN and fall back to an equal split.
    const angles = [];
    let cumulative = 0;
    for (let i = 0; i < n; i++) {
      const width = total > 0 ? (naturalMin[i] / total) * 2 * Math.PI : (2 * Math.PI) / n;
      angles.push(cumulative + width / 2);
      cumulative += width;
    }
    return angles;
  }

  // childrenOf lists children in IP order, which has no reason to keep big clusters
  // apart - two large clusters landing adjacent by chance forces excess separation.
  // Returns posOf[originalIndex] -> circular position: places the largest extent first,
  // then each next-largest into whichever remaining slot is farthest (by circular
  // distance) from what's already placed, spreading large clusters apart maximally.
  function spreadBySize(extents) {
    const n = extents.length;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => extents[b] - extents[a]);
    const posOf = new Array(n).fill(-1);
    const filled = new Array(n).fill(false);
    posOf[order[0]] = 0;
    filled[0] = true;
    for (let k = 1; k < n; k++) {
      let bestPos = -1, bestMinDist = -1;
      for (let p = 0; p < n; p++) {
        if (filled[p]) continue;
        let minDist = Infinity;
        for (let q = 0; q < n; q++) {
          if (!filled[q]) continue;
          const raw = Math.abs(p - q);
          minDist = Math.min(minDist, Math.min(raw, n - raw));
        }
        if (minDist > bestMinDist) { bestMinDist = minDist; bestPos = p; }
      }
      posOf[order[k]] = bestPos;
      filled[bestPos] = true;
    }
    return posOf;
  }

  // Finds each of n children's minimal radius from the shared center at its fixed angle
  // (from computeChildAngles/spreadBySize above). Starts each at its own natural resting
  // radius, then repeatedly checks every pair: if i is too close to j (chord distance
  // from law of cosines at their angle gap, below the combined requirement), i is pushed
  // out to just clear j - never pulled in below its natural rest, and j gets pushed in
  // its own turn rather than being moved here.
  function relaxRadii(kids, extents, spacing) {
    const n = extents.length;
    if (n === 0) return { radii: [], angles: [] };
    const naturalMinByOriginalIndex = extents.map(e => minRadius + e);
    if (n === 1) return { radii: naturalMinByOriginalIndex, angles: computeChildAngles(naturalMinByOriginalIndex) };

    // Computation below runs in spreadBySize's POSITION order, mapped back to original
    // index order just before return.
    const posOf = spreadBySize(extents);
    const orderedExtents = new Array(n);
    const orderedKids = new Array(n);
    for (let i = 0; i < n; i++) {
      orderedExtents[posOf[i]] = extents[i];
      orderedKids[posOf[i]] = kids[i];
    }
    const naturalMin = orderedExtents.map(e => minRadius + e);
    const angles = computeChildAngles(naturalMin);

    const radii = naturalMin.slice();

    // Leaf/leaf pairs always have reachToward == 0, so requiredDist collapses to plain
    // `spacing` - skip the vector math/recursion for them. These pairs dominate on real
    // networks (an access switch with hundreds of clients), so this fast path matters:
    // without it, 300 branch-level siblings went from 371ms to 11863ms.
    const isLeafOrdered = orderedKids.map(isLeaf);

    for (let iter = 0; iter < relaxIterations; iter++) {
      // Cheap relative to the O(n^2) sweep below - checked every iteration so one
      // pathologically large sibling set (the case this whole budget exists for) can't run
      // unbounded even within a single relaxRadii call.
      checkDeadline();
      // Jacobi-style: reads `radii` as of the start of the sweep and applies all updates
      // together at the end. Updating in place (Gauss-Seidel) makes the result depend on
      // processing order - confirmed empirically, 40 identical leaves converged to wildly
      // different radii (190-1120) purely from order.
      const next = radii.slice();
      for (let i = 0; i < n; i++) {
        let desired = radii[i];
        const angleI = angles[i];
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const rj = radii[j];
          const angleJ = angles[j];

          // requiredDist uses reachToward(childId, angle) - how far THIS subtree reaches
          // specifically toward the other one - rather than a fixed extents[i]+extents[j]
          // (each subtree's worst-case reach in any direction), which over-charged
          // neighbors for reach pointing away from them and forced excess clearance.
          // The direction used is the real vector between i's and j's positions (they sit
          // at different radii), not just the angle difference.
          let requiredDist;
          if (isLeafOrdered[i] && isLeafOrdered[j]) {
            requiredDist = spacing;
          } else {
            const ax = desired * Math.cos(angleI), ay = desired * Math.sin(angleI);
            const bx = rj * Math.cos(angleJ), by = rj * Math.sin(angleJ);
            const abAngle = Math.atan2(by - ay, bx - ax);
            requiredDist = reachToward(orderedKids[i], abAngle) + reachToward(orderedKids[j], abAngle + Math.PI) + spacing;
          }

          const rawDiff = Math.abs(angleI - angleJ);
          const angleDiff = Math.min(rawDiff, 2 * Math.PI - rawDiff);
          const cosA = Math.cos(angleDiff);
          // chord(ri)^2 = ri^2 - 2*rj*cosA*ri + rj^2 is a parabola in ri, minimized at
          // ri=rj*cosA, so chord(ri) >= requiredDist holds OUTSIDE [smallerRoot,
          // largerRoot]. `desired` can already satisfy it below smallerRoot (dominated by
          // rj alone) - jumping straight to the larger root unconditionally caused radii
          // to diverge to the billions within 150 iterations. Only push out when the
          // constraint is actually violated.
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
      // Most topologies converge well before 150 sweeps; stop early once a sweep changes
      // nothing meaningfully - further sweeps only cost time, and that cost is real once
      // reachToward is doing work for non-leaf pairs.
      let maxChange = 0;
      for (let i = 0; i < n; i++) {
        const change = Math.abs(next[i] - radii[i]);
        if (change > maxChange) maxChange = change;
        radii[i] = next[i];
      }
      if (maxChange < 0.01) break;
    }

    // Map back from position order to original array order, so callers never need to
    // know spreadBySize reordered anything internally.
    const resultRadii = new Array(n);
    const resultAngles = new Array(n);
    for (let i = 0; i < n; i++) {
      resultRadii[i] = radii[posOf[i]];
      resultAngles[i] = angles[posOf[i]];
    }
    return { radii: resultRadii, angles: resultAngles };
  }

  const extentCache = new Map();
  const layoutCache = new Map(); // nodeId -> {radii, angles} for its children, same order as childrenOf.get(nodeId)

  function childLayout(nodeId) {
    if (layoutCache.has(nodeId)) return layoutCache.get(nodeId);
    // Also checked here (once per distinct node, vs. once per relaxation sweep above) so
    // the budget is enforced across a WIDE tree (many cheap nodes) as well as a single
    // expensive one.
    checkDeadline();
    const kids = childrenOf.get(nodeId) || [];
    const extents = kids.map(extent);
    const spacing = allChildrenAreLeaves(kids) ? leafSpacing : nodeSpacing;
    const layout = relaxRadii(kids, extents, spacing);
    layoutCache.set(nodeId, layout);
    return layout;
  }

  // Bottom-up, cached: how far from its own position does nodeId's subtree extend, in
  // the OMNIDIRECTIONAL worst case (children sit at individually varying radii, not one
  // ring). Used by naturalMin to keep descendants from wrapping back onto nodeId's own
  // parent. Different question from reachToward below (reach toward one neighbor).
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

  // How far nodeId's subtree extends toward `angle` (global/absolute frame - place() adds
  // child angles straight onto the parent position with no per-level rotation), measured
  // from nodeId's own center. Children roughly opposite `angle` project negatively and are
  // outcompeted by `best` starting at 0. extent(child) is a safe upper bound on any
  // child's reach in any direction, so a child whose best-case contribution can't beat the
  // current `best` is skipped without recursing - prunes most of a large subtree safely.
  //
  // Results are memoized globally per (nodeId, angle bucket) - safe since nodeId's own
  // childLayout is fixed for the rest of this pass. Bucketing angle to ~1.15deg
  // (2*PI/315) turns the near-identical repeated queries a converging relaxation produces
  // into cache hits; without it, 300 non-leaf siblings went from ~5.3s to under a second.
  // The cached value is computed at the bucket's CENTER angle (not the raw query angle -
  // that rounded toward a lower, under-reserving value in testing), then padded by
  // extent(nodeId) * (angular distance to the real query angle): a provably safe bound
  // since reachToward is extent(nodeId)-Lipschitz in angle.
  const reachCache = new Map(); // nodeId -> Map<bucket, valueAtBucketCenter>
  const REACH_ANGLE_BUCKET = (2 * Math.PI) / 315;

  function reachToward(nodeId, angle) {
    if (isLeaf(nodeId)) return 0;
    const bucket = Math.round(angle / REACH_ANGLE_BUCKET);
    const centerAngle = bucket * REACH_ANGLE_BUCKET;
    let cache = reachCache.get(nodeId);
    if (cache === undefined) { cache = new Map(); reachCache.set(nodeId, cache); }
    let centerValue = cache.get(bucket);
    if (centerValue === undefined) {
      const kids = childrenOf.get(nodeId);
      const { radii, angles } = childLayout(nodeId);
      let best = 0;
      for (let i = 0; i < kids.length; i++) {
        const rawDiff = Math.abs(angles[i] - centerAngle);
        const angleDiff = Math.min(rawDiff, 2 * Math.PI - rawDiff);
        const projected = radii[i] * Math.cos(angleDiff);
        if (projected + extent(kids[i]) <= best) continue;
        const trueReach = projected + reachToward(kids[i], centerAngle);
        if (trueReach > best) best = trueReach;
      }
      centerValue = best;
      cache.set(bucket, centerValue);
    }
    const rawSlop = Math.abs(angle - centerAngle);
    const angularSlop = Math.min(rawSlop, 2 * Math.PI - rawSlop);
    return centerValue + extent(nodeId) * angularSlop;
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

// Dual-mode export: node:test imports via ESM, which Node resolves against
// module.exports through its CJS/ESM interop; the browser loads this as a classic
// <script> (no `module`), so it attaches to window.GraphLayout instead. Not an ES module
// with `export`, because file:// (no local web server) can't fetch ES modules.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { compareIpIds, computeGraphRoot, buildPrimaryTree, computeVisibleTree, expandAncestors, computeRecursiveRadialLayout };
} else if (typeof window !== 'undefined') {
    window.GraphLayout = { compareIpIds, computeGraphRoot, buildPrimaryTree, computeVisibleTree, expandAncestors, computeRecursiveRadialLayout };
}
