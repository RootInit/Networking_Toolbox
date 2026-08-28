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
  const nodeSpacing = opts.nodeSpacing ?? 350;
  const leafSpacing = opts.leafSpacing ?? 250;
  const minRadius = opts.minRadius ?? 250;
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
    // naturalMin[i] is minRadius+extent(child) - only 0 when minRadius is explicitly 0
    // AND every child is a leaf (extent 0 too). The app's own UI floors minRadius at 20,
    // so this can't happen through normal use, but this function is exported and can be
    // called directly (as the tests do) - dividing by a total of 0 would otherwise turn
    // every angle into NaN silently instead of failing loudly. Equal shares is the
    // correct fallback anyway: with every weight equal (all 0), an even split is exactly
    // what the weighted formula converges to as the weights approach each other.
    const angles = [];
    let cumulative = 0;
    for (let i = 0; i < n; i++) {
      const width = total > 0 ? (naturalMin[i] / total) * 2 * Math.PI : (2 * Math.PI) / n;
      angles.push(cumulative + width / 2);
      cumulative += width;
    }
    return angles;
  }

  // Children are placed in whatever order childrenOf happens to list them (typically IP
  // order, since that's how the tree was built) - nothing about that order has any
  // reason to spread big clusters apart from each other. Two of the largest clusters
  // landing next to each other by pure chance forces much more separation between that
  // one pair than the rest of the ring needs (confirmed on the real sample: the two
  // biggest leaf-parents, 25 and 42 devices, were consecutive in IP order). Returns
  // posOf[originalIndex] -> circular position, built by placing the largest extent
  // first, then repeatedly placing the next-largest extent into whichever remaining
  // position is farthest (by circular distance) from every already-placed position -
  // large clusters end up spread maximally apart, with smaller ones filling the gaps.
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

  // Finds each of n children's own minimal radius from their shared center, given each
  // child's fixed angle (see computeChildAngles above - proportional to size, not an
  // equal share - and spreadBySize above - ordered to keep large children apart from
  // each other, not their original array order). Starts everyone at their own natural
  // resting radius (just clears their own extent from the center), then repeatedly
  // checks every pair: if child i is currently too close to child j (chord distance,
  // from the law of cosines at their angle gap, below the two extents' combined
  // requirement), i is pushed out to the minimum radius that clears j - never pulled
  // back in below its own natural rest, and never adjusted by moving j instead (j gets
  // its own turn in the same sweep).
  function relaxRadii(kids, extents, spacing) {
    const n = extents.length;
    if (n === 0) return { radii: [], angles: [] };
    const naturalMinByOriginalIndex = extents.map(e => minRadius + e);
    if (n === 1) return { radii: naturalMinByOriginalIndex, angles: computeChildAngles(naturalMinByOriginalIndex) };

    // From here on, all computation works in POSITION order (spreadBySize's output),
    // not original array order - mapped back to original-index order just before return.
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

    // Precomputed once, not per-pair-per-iteration: two leaves' reachToward is always 0
    // (isLeaf short-circuits it), so their requiredDist collapses to exactly `spacing` -
    // identical to the plain extents[i]+extents[j]+spacing this replaced (both are 0 for
    // a leaf). Skipping straight to that for a leaf/leaf pair avoids the vector math and
    // recursion entirely for what is, on real networks, the overwhelming majority of
    // pairs: a single leaf-heavy branch (an access switch with hundreds of clients) means
    // most of relaxRadii's O(n^2) pairs are leaf/leaf. Confirmed as the dominant cost, not
    // assumed: 300 branch-level siblings (5 leaves each - one extra level, not even deep)
    // went from 371ms on the pre-directional-reach algorithm to 11863ms after it, a 32x
    // regression - this fast path alone brings a 800-leaf single fan-out back in line with
    // the old algorithm's timing.
    const isLeafOrdered = orderedKids.map(isLeaf);

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
        const angleI = angles[i];
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const rj = radii[j];
          const angleJ = angles[j];

          // requiredDist used to be a fixed extents[i]+extents[j]+spacing - the two
          // subtrees' worst-case reach in ANY direction, charged against each other
          // regardless of which way either actually points. Measured directly on the
          // real sample: true clearance between two subtrees came out 2600-6500px against
          // a 350px requirement, 7-18x more than needed, because one oversized branch's
          // reach in some unrelated direction was being charged to every neighbor
          // (reported as "two separate halves... large gap", confirmed by that
          // measurement, not assumed). reachToward(childId, angle) below answers the
          // narrower question that actually matters here: how far does THIS subtree
          // reach specifically toward the OTHER one, not in its single worst direction.
          //
          // The direction used is the real vector from i's (evolving, within this sweep)
          // position to j's (this sweep's snapshot) position, not just angleJ-angleI -
          // i and j generally sit at different radii from the shared center, so the true
          // direction between them is a real 2D vector, not a bearing difference. This
          // does NOT touch the chord/distance formula below, which is still the exact
          // law-of-cosines distance between two points at radii ri,rj separated by
          // angleDiff around a shared origin - unrelated geometry, still exact.
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
      // Most real topologies stop moving well before 150 sweeps - the escalation above
      // jumps straight to the exact required radius in one step, so what's left after the
      // first handful of sweeps is only the cross-coupling between children that each
      // pushed the other out in the same round. Once a full sweep changes nothing by more
      // than a fraction of a pixel, further sweeps can't change the answer, only cost
      // time - and with reachToward now doing real work for non-leaf pairs, that cost is
      // no longer negligible (300 branch-level siblings went from 371ms to 11863ms before
      // this and the leaf/leaf fast path above; confirmed, not assumed).
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
    const kids = childrenOf.get(nodeId) || [];
    const extents = kids.map(extent);
    const spacing = allChildrenAreLeaves(kids) ? leafSpacing : nodeSpacing;
    const layout = relaxRadii(kids, extents, spacing);
    layoutCache.set(nodeId, layout);
    return layout;
  }

  // Bottom-up, cached: how far from its OWN position does nodeId's subtree extend?
  // Leaves: 0. Everything else: the farthest any child's own (radius from here + that
  // child's own extent) reaches, since children now sit at individually varying radii
  // rather than one uniform ring. This is the OMNIDIRECTIONAL worst case, deliberately -
  // it's what naturalMin uses to keep nodeId's own descendants (which can be in ANY
  // direction around nodeId) from wrapping back and touching nodeId's OWN parent. That's
  // a different question from "how far does this subtree reach toward one specific
  // neighbor" - see reachToward below, which is what the sibling-clearance check needs.
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

  // How far nodeId's subtree extends in roughly the direction `angle` (global/absolute -
  // the same frame every node's own childLayout angles use, since place() adds them
  // straight onto the parent position with no per-level rotation, so a query angle means
  // the same physical direction at every depth). Measured from nodeId's own center.
  //
  // Only children whose own angle is on the `angle` side contribute positively; a child
  // roughly opposite `angle` projects negatively and is naturally outcompeted by `best`
  // starting at 0, so it never lowers the result. extent(child) is a safe (if loose)
  // upper bound on how far ANY child could reach in ANY direction, including `angle` - if
  // a child's best possible contribution (its own projected position plus that bound)
  // can't beat the best answer already found, it's skipped without recursing into it.
  // That's a safe prune (it never discards a child that could have improved the true
  // answer) and cuts off the vast majority of a large subtree in practice, since only
  // children whose own angle is reasonably close to the query direction have any real
  // chance of mattering.
  // nodeId's own childLayout is fixed for the rest of this pass (it's a sibling of
  // whatever's currently being relaxed one level up, not the thing being relaxed), so
  // reachToward(nodeId, angle) is a pure function of its two arguments for the remainder
  // of this computeRecursiveRadialLayout call - safe to memoize globally, not just within
  // one relaxRadii invocation. Quantizing angle to ~1.15 degrees (2*PI/315) turns the
  // repeated near-identical queries a converging relaxation naturally produces (the same
  // sibling pair, checked every sweep, with the angle between them barely moving once
  // things settle) into cache hits instead of fresh recursions. Confirmed necessary, not
  // just tidy: even with the leaf/leaf fast path and the early-exit above, 300 non-leaf
  // siblings needed 79 sweeps to converge, each doing up to 2*n^2 reachToward calls -
  // this cut that case from ~5.3s to well under a second.
  //
  // A first version rounded the query angle to its nearest bucket and cached the value
  // AT the raw query angle - which can round toward a LOWER true value than the exact
  // angle would have given, silently under-reserving. Confirmed empirically, not just
  // suspected: on a 300-sibling stress case, that version produced a real 189.8px
  // clearance against a 190px requirement. Fixed by computing and caching the value at
  // the bucket's CENTER angle instead, then padding the return by
  // extent(nodeId) * (angular distance from center to the real query angle) - a
  // provably safe bound, not a fudge factor: reachToward is extent(nodeId)-Lipschitz in
  // angle (by induction - each term's angular derivative is bounded by
  // radii[i]+extent(kids[i]), and extent(nodeId) is exactly the max of that sum over all
  // children, and the max of several L-Lipschitz functions is itself L-Lipschitz), so
  // this pad can never fall short of the true value anywhere inside the bucket.
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
