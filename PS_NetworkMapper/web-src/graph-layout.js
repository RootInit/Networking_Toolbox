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

// BFS distances from `startId`. The head pointer keeps dequeue O(1); `queue.shift()` is
// O(n) and would make this worse than its nominal O(V+E). Neighbors are visited unsorted
// because only component size and max depth matter here, and neither depends on visit
// order - unlike buildPrimaryTree's BFS, where order decides each node's parent.
function bfsDistances(adj, startId) {
  const dist = new Map([[startId, 0]]);
  const queue = [startId];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const neighbors = adj.get(current);
    if (!neighbors) continue;
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
  const parentOf = new Map();
  const childrenOf = new Map();
  const treeEdgeKeys = new Set();
  const extraRoots = [];

  const edgeKey = (a, b) => [a, b].sort(compareIpIds).join('|');

  // Used for the primary root and for each disconnected component's own local root.
  function growTreeFrom(start) {
    parentOf.set(start, null);
    childrenOf.set(start, []);
    const queue = [start];
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
  }

  growTreeFrom(rootId);

  // Anything the BFS never reached is a disconnected fabric island. Left out, computeVisibleTree
  // would never see it and expandAncestors' parentOf.get() would return undefined for it - so
  // each gets its own local root (same heuristic, scoped to that component) recorded as another
  // top-level entry, exactly like rootId.
  const remaining = nodeIds.filter(id => !parentOf.has(id)).sort(compareIpIds);
  for (const id of remaining) {
    if (parentOf.has(id)) continue; // swept into an earlier component this loop

    // Plain adjacency walk: the component's root isn't known yet, so growTreeFrom can't
    // be used here.
    const componentIds = [];
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop();
      componentIds.push(cur);
      for (const next of (adj.get(cur) || [])) {
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }

    const componentIdSet = new Set(componentIds);
    const componentEdges = edges.filter(e => componentIdSet.has(e.from) && componentIdSet.has(e.to));
    const localRoot = computeGraphRoot(componentIds, componentEdges);
    extraRoots.push(localRoot);
    growTreeFrom(localRoot);
  }

  const secondaryEdges = edges.filter(e => !treeEdgeKeys.has(edgeKey(e.from, e.to)));

  return { parentOf, childrenOf, secondaryEdges, extraRoots };
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

function computeVisibleTree(rootId, childrenOf, expandedNodes, threshold, extraRoots) {
  const visibleNodeIds = [];
  const visibleEdges = [];
  const clusters = new Map();
  // hidden node id -> the `cluster:X` placeholder standing in for it, so an edge onto a
  // hidden endpoint can be rerouted to the placeholder rather than dropped.
  const hiddenNodeToCluster = new Map();

  if (rootId == null) return { visibleNodeIds, visibleEdges, clusters, hiddenNodeToCluster };

  // extraRoots are disconnected islands' local roots and need walking just like rootId.
  const roots = [rootId, ...(extraRoots || [])];
  const queue = [...roots];
  visibleNodeIds.push(...roots);
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
      const memberIds = collectDescendants(childrenOf, current);
      clusters.set(clusterId, { parentId: current, memberIds });
      for (const memberId of memberIds) hiddenNodeToCluster.set(memberId, clusterId);
    }
  }

  return { visibleNodeIds, visibleEdges, clusters, hiddenNodeToCluster };
}

function expandAncestors(parentOf, childrenOf, targetId, expandedNodes, threshold) {
  let current = parentOf.get(targetId);
  while (current != null) {
    const childCount = (childrenOf.get(current) || []).length;
    if (childCount > threshold) expandedNodes.add(current);
    current = parentOf.get(current);
  }
}

// Places the visible tree recursively. Children fan out around their own parent in a full
// circle at every depth rather than a wedge inherited from above, which crammed deep
// branches into a narrow slice and blew up their radius.
//
// Angles are fixed and proportional; each child's DISTANCE from the shared centre is relaxed
// individually by a fixed-iteration numerical pass (deterministic, no animation), so a small
// cluster can sit closer than a large sibling. Every pair is checked each iteration, not just
// angular neighbors, since independent radii can bring non-neighbors closer together.
function computeRecursiveRadialLayout(rootId, childrenOf, options) {
  const opts = options || {};
  // nodeSpacing: branch-to-branch separation and inter-cluster margin.
  // leafSpacing: packing within one cluster (leaf-to-leaf distance).
  const nodeSpacing = opts.nodeSpacing ?? 350;
  const leafSpacing = opts.leafSpacing ?? 250;
  const minRadius = opts.minRadius ?? 250;
  const relaxIterations = opts.relaxIterations ?? 150;
  // An absolute Date.now() timestamp (the caller derives it from its own budget); null
  // means unbounded. It has to be checked from inside the computation: this function runs
  // synchronously start-to-finish, so a racing setTimeout cannot fire until it has already
  // returned, however long it took.
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

  // Angular slices are proportional to each child's natural size rather than an equal 1/n
  // share; otherwise one large child forces its angular neighbors out to nearly its own
  // radius just to clear it.
  function computeChildAngles(naturalMin) {
    const n = naturalMin.length;
    const total = naturalMin.reduce((a, b) => a + b, 0);
    // total is 0 only when every child is a leaf with minRadius 0 - unreachable from the
    // UI, which floors minRadius, but tests call this directly. Equal split avoids NaN.
    const angles = [];
    let cumulative = 0;
    for (let i = 0; i < n; i++) {
      const width = total > 0 ? (naturalMin[i] / total) * 2 * Math.PI : (2 * Math.PI) / n;
      angles.push(cumulative + width / 2);
      cumulative += width;
    }
    return angles;
  }

  // childrenOf is in IP order, so two large clusters can land adjacent by chance and force
  // excess separation. Returns posOf[originalIndex] -> circular position, placing each
  // next-largest extent in whichever free slot is farthest from those already placed.
  function spreadBySize(extents) {
    const n = extents.length;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => extents[b] - extents[a]);
    const posOf = new Array(n).fill(-1);
    // All-equal extents (every child a leaf - the common case, and the same one relaxRadii
    // fast-paths) make every permutation equivalent, so the O(n^3) search below buys nothing.
    // Without this, n=3000 spent 15.2s here before the 8s budget could even be noticed.
    if (extents.every(e => e === extents[0])) return posOf.map((_, i) => i);
    const filled = new Array(n).fill(false);
    posOf[order[0]] = 0;
    filled[0] = true;
    for (let k = 1; k < n; k++) {
      // The sweep below is O(n^2) per placement, long enough that the budget must be
      // observed here rather than only once this whole function has returned.
      checkDeadline();
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

  // Finds each child's minimal radius at its fixed angle. Each starts at its natural resting
  // radius; every pair is then checked, and i is pushed out to just clear j when their chord
  // distance falls short. Nothing is ever pulled below its natural rest, and j moves on its
  // own turn rather than being moved from here.
  function relaxRadii(kids, extents, spacing) {
    const n = extents.length;
    if (n === 0) return { radii: [], angles: [] };
    const naturalMinByOriginalIndex = extents.map(e => minRadius + e);
    if (n === 1) {
      const soleAngle = computeChildAngles(naturalMinByOriginalIndex);
      return { radii: [minRadius + reachToward(kids[0], soleAngle[0] + Math.PI)], angles: soleAngle };
    }

    // Everything below runs in spreadBySize's POSITION order, mapped back before return.
    const posOf = spreadBySize(extents);
    const orderedExtents = new Array(n);
    const orderedKids = new Array(n);
    for (let i = 0; i < n; i++) {
      orderedExtents[posOf[i]] = extents[i];
      orderedKids[posOf[i]] = kids[i];
    }
    const naturalMin = orderedExtents.map(e => minRadius + e);
    const angles = computeChildAngles(naturalMin);

    // The floor only has to keep a child's descendants off the PARENT, so it charges for the
    // reach back along the child's own spoke, not for extent's omnidirectional worst case.
    // Angles still come from extent (a child's total size is what earns it angular room);
    // sibling clearance is the pair sweep's job below, and it measures directionally too.
    // Paying the omnidirectional price here compounded: each level's radius covered the whole
    // subtree beneath it, so radii roughly doubled per level and a 6-deep tree spent 32x the
    // space it needed.
    const radii = orderedKids.map((k, i) => minRadius + reachToward(k, angles[i] + Math.PI));

    // Leaf/leaf pairs have reachToward == 0, so requiredDist collapses to plain `spacing`
    // and the vector math can be skipped. They dominate on real networks: without this fast
    // path, 300 branch-level siblings took 11863ms instead of 371ms.
    const isLeafOrdered = orderedKids.map(isLeaf);

    for (let iter = 0; iter < relaxIterations; iter++) {
      // Cheap next to the O(n^2) sweep, and per-iteration so one pathologically large
      // sibling set can't run unbounded inside a single relaxRadii call.
      checkDeadline();
      // Jacobi-style: reads `radii` from the start of the sweep, applies all updates at the
      // end. Updating in place (Gauss-Seidel) makes the result order-dependent - 40
      // identical leaves converged to radii between 190 and 1120 purely from order.
      const next = radii.slice();
      for (let i = 0; i < n; i++) {
        let desired = radii[i];
        const angleI = angles[i];
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const rj = radii[j];
          const angleJ = angles[j];

          // reachToward measures how far each subtree reaches toward the other, along the
          // real vector between their positions. A fixed extents[i]+extents[j] (worst-case
          // reach in any direction) over-charges for reach pointing away and forces excess
          // clearance.
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
          // chord(ri)^2 = ri^2 - 2*rj*cosA*ri + rj^2 is a parabola in ri, so the constraint
          // holds OUTSIDE the root interval - including below the smaller root, where
          // `desired` may already satisfy it. Jumping to the larger root unconditionally
          // made radii diverge to the billions within 150 iterations.
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
      // Most topologies converge well before relaxIterations sweeps, and further sweeps
      // cost real time once reachToward is working on non-leaf pairs.
      let maxChange = 0;
      for (let i = 0; i < n; i++) {
        const change = Math.abs(next[i] - radii[i]);
        if (change > maxChange) maxChange = change;
        radii[i] = next[i];
      }
      if (maxChange < 0.01) break;
    }

    // Back to original array order, so callers never see spreadBySize's reordering.
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
    // Once per distinct node, so the budget also binds a WIDE tree of cheap nodes, not
    // just a single expensive one.
    checkDeadline();
    const kids = childrenOf.get(nodeId) || [];
    const extents = kids.map(extent);
    const spacing = allChildrenAreLeaves(kids) ? leafSpacing : nodeSpacing;
    const layout = relaxRadii(kids, extents, spacing);
    layoutCache.set(nodeId, layout);
    return layout;
  }

  // How far nodeId's subtree extends from its own position in the OMNIDIRECTIONAL worst
  // case - distinct from reachToward below, which answers "toward one neighbor". Used by
  // naturalMin to keep descendants from wrapping back onto nodeId's own parent.
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

  // How far nodeId's subtree extends toward `angle`, in the absolute frame (place() adds
  // child angles straight onto the parent position). extent(child) upper-bounds any child's
  // reach, so a child that can't beat the current `best` is skipped without recursing.
  //
  // Memoized per (nodeId, angle bucket) - safe because childLayout is fixed for the rest of
  // the pass. Bucketing turns a converging relaxation's near-identical repeated queries into
  // hits; without it, 300 non-leaf siblings took ~5.3s instead of under a second. The cached
  // value is computed at the bucket's CENTRE (the raw query angle rounded toward a lower,
  // under-reserving value) and padded by extent(nodeId) * angular distance, which is a safe
  // bound because reachToward is extent(nodeId)-Lipschitz in angle.
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

// Dual-mode export: node:test reaches module.exports through Node's CJS/ESM interop, while
// the browser loads this as a classic <script> and gets window.GraphLayout. Deliberately not
// an ES module - file:// can't fetch those, and the bundle must open straight off disk.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { compareIpIds, computeGraphRoot, buildPrimaryTree, computeVisibleTree, expandAncestors, computeRecursiveRadialLayout };
} else if (typeof window !== 'undefined') {
    window.GraphLayout = { compareIpIds, computeGraphRoot, buildPrimaryTree, computeVisibleTree, expandAncestors, computeRecursiveRadialLayout };
}
