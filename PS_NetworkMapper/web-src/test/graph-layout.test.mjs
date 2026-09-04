import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGraphRoot, compareIpIds, buildPrimaryTree, computeVisibleTree, expandAncestors, computeRecursiveRadialLayout } from '../graph-layout.js';

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

test('computeGraphRoot prefers the largest component over a smaller-eccentricity isolated node', () => {
  // A 6-node chain (root candidates have eccentricity 2-5) plus one fully isolated
  // node (eccentricity 0 - the global minimum, but reachable to nobody). Without a
  // component-size preference, the isolated node wins and the whole chain vanishes
  // from any downstream tree/render built from this root.
  const nodeIds = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'isolated'];
  const edges = [
    { from: 'c1', to: 'c2' }, { from: 'c2', to: 'c3' }, { from: 'c3', to: 'c4' },
    { from: 'c4', to: 'c5' }, { from: 'c5', to: 'c6' },
  ];
  const root = computeGraphRoot(nodeIds, edges);
  assert.notEqual(root, 'isolated');
  // The real implementation is deterministic here: sortedIds visits 'c3' before 'c4'
  // (lowest-ID tie-break, see the test above), and the eccentricity-improvement check
  // is a strict '<', so 'c3' is set first and 'c4's later-tied eccentricity never
  // displaces it. Asserting the exact value (rather than accepting either) catches a
  // regression that flips the tie-break direction (e.g. '<' becoming '<=').
  assert.equal(root, 'c3'); // center of a 6-node chain, lowest-ID tie-break
});

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

test('buildPrimaryTree attaches an unreachable single node as its own extra root', () => {
  const nodeIds = ['root', 'a', 'island'];
  const edges = [{ from: 'root', to: 'a' }];
  const { parentOf, childrenOf, extraRoots } = buildPrimaryTree(nodeIds, edges, 'root');
  // It becomes a top-level entry of its own (parentOf === null, just like the main
  // root), rather than silently missing from parentOf/childrenOf.
  assert.deepEqual(extraRoots, ['island']);
  assert.equal(parentOf.get('island'), null);
  assert.deepEqual(childrenOf.get('island'), []);
});

test('buildPrimaryTree attaches a disconnected 2-node island as its own extra tree, reachable from parentOf/childrenOf', () => {
  // Main component: root-a. Separate island: island1-island2, with no edge back to
  // either root or a. Without its own extra root it would be unreachable from rootId
  // and never added to parentOf/childrenOf, so computeVisibleTree (which only walks
  // from rootId) would never render it and expandAncestors could never find a path to it.
  const nodeIds = ['root', 'a', 'island1', 'island2'];
  const edges = [
    { from: 'root', to: 'a' },
    { from: 'island1', to: 'island2' },
  ];
  const { parentOf, childrenOf, extraRoots } = buildPrimaryTree(nodeIds, edges, 'root');

  assert.equal(extraRoots.length, 1);
  const islandRoot = extraRoots[0];
  assert.ok(islandRoot === 'island1' || islandRoot === 'island2');
  const islandLeaf = islandRoot === 'island1' ? 'island2' : 'island1';

  // Both island nodes are now reachable via parentOf/childrenOf.
  assert.equal(parentOf.get(islandRoot), null);
  assert.equal(parentOf.get(islandLeaf), islandRoot);
  assert.deepEqual(childrenOf.get(islandRoot), [islandLeaf]);

  // The island's own edge became a tree edge (not left dangling in secondaryEdges).
  const { secondaryEdges } = buildPrimaryTree(nodeIds, edges, 'root');
  assert.equal(secondaryEdges.length, 0);

  // computeVisibleTree renders the island as a second top-level tree alongside root.
  const { visibleNodeIds, visibleEdges } = computeVisibleTree('root', childrenOf, new Set(), 8, extraRoots);
  assert.deepEqual(visibleNodeIds.sort(), ['a', 'island1', 'island2', 'root'].sort());
  assert.ok(visibleEdges.some(e => (e.from === islandRoot && e.to === islandLeaf)));

  // expandAncestors can walk up from a node buried in the island without silently
  // no-op'ing on an undefined parentOf entry (parentOf.get() on an unreached node
  // returns undefined, which would stop the ancestor walk before it starts).
  // Threshold 0 makes islandRoot's one child "over threshold", so a real expansion
  // must happen for this to pass - not just a no-op walk that happens to not throw.
  const expandedNodes = new Set();
  expandAncestors(parentOf, childrenOf, islandLeaf, expandedNodes, 0);
  assert.equal(expandedNodes.has(islandRoot), true);
});

function starTree(childCount) {
  const nodeIds = ['root', ...Array.from({ length: childCount }, (_, i) => `c${i}`)];
  const edges = nodeIds.slice(1).map(id => ({ from: 'root', to: id }));
  return buildPrimaryTree(nodeIds, edges, 'root');
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
  const { childrenOf } = buildPrimaryTree(nodeIds, edges, 'root');
  const { visibleNodeIds, clusters } = computeVisibleTree('root', childrenOf, new Set(), 8);
  assert.deepEqual(visibleNodeIds.sort(), ['cluster:mid', 'mid', 'root'].sort());
  assert.equal(clusters.get('cluster:mid').memberIds.length, 20);
});

test('computeVisibleTree returns a hiddenNodeToCluster map so a secondary edge into a collapsed cluster can be rerouted instead of dropped', () => {
  // root -> mid -> (20 leaves, over threshold so mid's children collapse into cluster:mid).
  // A secondary/redundant edge from "other" (visible) to one of mid's hidden leaves should
  // be reroutable to cluster:mid via hiddenNodeToCluster, rather than the leaf being unreachable.
  const nodeIds = ['root', 'mid', 'other', ...Array.from({ length: 20 }, (_, i) => `leaf${i}`)];
  const edges = [
    { from: 'root', to: 'mid' },
    { from: 'root', to: 'other' },
    ...Array.from({ length: 20 }, (_, i) => ({ from: 'mid', to: `leaf${i}` })),
  ];
  const { childrenOf } = buildPrimaryTree(nodeIds, edges, 'root');
  const { visibleNodeIds, hiddenNodeToCluster } = computeVisibleTree('root', childrenOf, new Set(), 8);

  assert.equal(visibleNodeIds.includes('leaf0'), false); // leaf0 is hidden, folded into cluster:mid
  assert.equal(hiddenNodeToCluster.get('leaf0'), 'cluster:mid');
  assert.equal(hiddenNodeToCluster.get('leaf19'), 'cluster:mid');
  assert.equal(hiddenNodeToCluster.has('other'), false); // "other" was never hidden, no entry expected
});

test('expandAncestors reveals a target buried behind an over-threshold ancestor', () => {
  const nodeIds = ['root', 'mid', 'leaf0', 'leaf1'];
  const edges = [
    { from: 'root', to: 'mid' }, { from: 'mid', to: 'leaf0' }, { from: 'mid', to: 'leaf1' },
  ];
  const { parentOf, childrenOf } = buildPrimaryTree(nodeIds, edges, 'root');
  const expandedNodes = new Set();
  expandAncestors(parentOf, childrenOf, 'leaf0', expandedNodes, 1); // threshold 1: "mid" (2 children) is over it
  assert.equal(expandedNodes.has('mid'), true);
  const { visibleNodeIds } = computeVisibleTree('root', childrenOf, expandedNodes, 1);
  assert.equal(visibleNodeIds.includes('leaf0'), true);
});


test('computeRecursiveRadialLayout places root at the origin', () => {
  const result = computeRecursiveRadialLayout('root', new Map([['root', []]]), {});
  assert.deepEqual(result.get('root'), { x: 0, y: 0 });
});

test('computeRecursiveRadialLayout returns an empty map for a null root', () => {
  assert.equal(computeRecursiveRadialLayout(null, new Map(), {}).size, 0);
});

test('computeRecursiveRadialLayout places a small leaf-parent\'s children evenly on one ring around itself', () => {
  const childrenOf = new Map([['root', ['a', 'b', 'c', 'd']]]); // root itself is a leaf-parent here
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 190, minRadius: 190 });
  const radii = ['a', 'b', 'c', 'd'].map(id => Math.hypot(result.get(id).x, result.get(id).y));
  for (const r of radii) assert.equal(Math.abs(r - radii[0]) < 0.01, true, 'all four should be on the same ring');
});

test('computeRecursiveRadialLayout keeps a large leaf-parent\'s single ring at a reasonable radius, not linear-in-n blowup, because it uses the full circle (not a narrow wedge)', () => {
  const childrenOf = new Map([['root', Array.from({ length: 40 }, (_, i) => `leaf${i}`)]]);
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 190, leafSpacing: 220, minRadius: 190 });
  const radii = Array.from({ length: 40 }, (_, i) => Math.hypot(result.get(`leaf${i}`).x, result.get(`leaf${i}`).y));
  for (const r of radii) assert.equal(Math.abs(r - radii[0]) < 0.01, true, 'all 40 should be on the same single ring');
  assert.equal(radii[0] < 3000, true, `expected a reasonable single-ring radius for 40 nodes on a full circle, got ${radii[0].toFixed(0)}`);
});

test('computeRecursiveRadialLayout gives an intermediate STRUCTURAL node (not just leaf-parents) a full circle around itself too (regression: a second-level branch - e.g. a second core switch hanging off the first - inherited a narrow wedge from root in an earlier version and needed radius ~26000px for its own 8 children on the real sample; confirmed by measuring it)', () => {
  // root -> [core2, dist0..dist11] (12 siblings for core2 to inherit a narrow wedge from,
  // if wedge inheritance still existed) -> core2 -> [b0..b7], each of which is itself a
  // leaf-parent with a real cluster, mirroring the real sample's second-core shape.
  const childrenOf = new Map([['root', ['core2']]]);
  for (let i = 0; i < 12; i++) childrenOf.get('root').push(`dist${i}`);
  childrenOf.set('core2', Array.from({ length: 8 }, (_, i) => `b${i}`));
  for (let i = 0; i < 8; i++) {
    childrenOf.set(`b${i}`, Array.from({ length: 10 + i * 4 }, (_, k) => `b${i}_leaf${k}`)); // 10..38 leaves
  }

  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 90, leafSpacing: 220, minRadius: 190 });
  const core2Pos = result.get('core2');
  const radii = Array.from({ length: 8 }, (_, i) => {
    const p = result.get(`b${i}`);
    return Math.hypot(p.x - core2Pos.x, p.y - core2Pos.y);
  });
  for (const r of radii) {
    assert.equal(r < 5000, true, `core2's own children should stay well under the old ~26000px blowup, got ${r.toFixed(0)}`);
  }
});

test('computeRecursiveRadialLayout centers a non-root leaf-parent\'s cluster on itself, using a full circle rather than a wedge inherited from its own parent', () => {
  // root -> mid (not a leaf-parent) -> [leaf0..leaf7] (mid IS a leaf-parent).
  const childrenOf = new Map([
    ['root', ['mid']],
    ['mid', Array.from({ length: 8 }, (_, i) => `leaf${i}`)],
  ]);
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 190, minRadius: 190 });
  const midPos = result.get('mid');
  const midAngle = Math.atan2(midPos.y, midPos.x); // mid is root's only child -> angle 0
  const leafAngles = Array.from({ length: 8 }, (_, i) => {
    const p = result.get(`leaf${i}`);
    return Math.atan2(p.y - midPos.y, p.x - midPos.x);
  });
  // At least one leaf should fall on the ROOT-FACING side of mid (within 90 degrees of
  // pointing back toward root, i.e. roughly PI away from mid's own outward angle) - proof
  // the cluster gets a full circle around mid, not an outward-only wedge.
  const facesRootward = leafAngles.some(a => {
    let delta = a - (midAngle + Math.PI);
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return Math.abs(delta) < Math.PI / 2;
  });
  assert.equal(facesRootward, true, 'expected at least one leaf on the root-facing side of its own cluster');
});

test('computeRecursiveRadialLayout lets a small branch sit much closer to its parent than an outsized sibling, while still keeping every pair clear of each other (requested directly: pull small clusters in, give big ones more room, individually - not one uniform ring sized from the worst case)', () => {
  const childrenOf = new Map([['root', []]]);
  for (let i = 0; i < 10; i++) {
    const id = `p${i}`;
    childrenOf.get('root').push(id);
    childrenOf.set(id, Array.from({ length: 6 }, (_, k) => `${id}_leaf${k}`)); // modest
  }
  childrenOf.get('root').push('huge');
  childrenOf.set('huge', Array.from({ length: 120 }, (_, i) => `huge_leaf${i}`)); // outsized

  const nodeSpacing = 190, leafSpacing = 190, minRadius = 190;
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing, leafSpacing, minRadius });
  const modestRadii = Array.from({ length: 10 }, (_, i) => Math.hypot(result.get(`p${i}`).x, result.get(`p${i}`).y));
  const hugeRadius = Math.hypot(result.get('huge').x, result.get('huge').y);

  assert.equal(Math.max(...modestRadii) < hugeRadius, true,
    `expected every modest branch closer to root than "huge", got modest max ${Math.max(...modestRadii).toFixed(1)} vs huge ${hugeRadius.toFixed(1)}`);

  // And still no collision anywhere, including each modest branch's own leaves against
  // "huge"'s leaves.
  const allPositions = Array.from(result.values());
  let minDist = Infinity;
  for (let i = 0; i < allPositions.length; i++) {
    for (let j = i + 1; j < allPositions.length; j++) {
      minDist = Math.min(minDist, Math.hypot(allPositions[i].x - allPositions[j].x, allPositions[i].y - allPositions[j].y));
    }
  }
  assert.equal(minDist >= nodeSpacing - 0.5, true, `closest pair anywhere was ${minDist.toFixed(1)}, expected >= ${nodeSpacing}`);
});

test('computeRecursiveRadialLayout never places two different nodes closer than nodeSpacing, on an uneven multi-branch tree', () => {
  const childrenOf = new Map([['root', []]]);
  for (let i = 0; i < 16; i++) {
    const id = `p${i}`;
    childrenOf.get('root').push(id);
    childrenOf.set(id, Array.from({ length: 3 + (i % 12) * 3 }, (_, k) => `${id}_leaf${k}`)); // 3..36 leaves, uneven
  }
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 190, minRadius: 190 });
  const allPositions = Array.from(result.values());
  let minDist = Infinity;
  for (let i = 0; i < allPositions.length; i++) {
    for (let j = i + 1; j < allPositions.length; j++) {
      minDist = Math.min(minDist, Math.hypot(allPositions[i].x - allPositions[j].x, allPositions[i].y - allPositions[j].y));
    }
  }
  assert.equal(minDist >= 190 - 0.5, true, `closest pair anywhere was ${minDist.toFixed(1)}, expected >= 190`);
});

test('computeRecursiveRadialLayout never places two different nodes closer than the relevant spacing, on a real multi-level tree with an intermediate structural node (like the second core switch) that itself has leaf-parent children with real clusters', () => {
  const childrenOf = new Map([['root', ['core2']]]);
  for (let i = 0; i < 12; i++) {
    const id = `dist${i}`;
    childrenOf.get('root').push(id);
    childrenOf.set(id, Array.from({ length: 3 + (i % 10) * 3 }, (_, k) => `${id}_leaf${k}`));
  }
  childrenOf.set('core2', []);
  for (let i = 0; i < 8; i++) {
    const id = `core2dist${i}`;
    childrenOf.get('core2').push(id);
    childrenOf.set(id, Array.from({ length: 5 + i * 4 }, (_, k) => `${id}_leaf${k}`));
  }

  const nodeSpacing = 90, leafSpacing = 220;
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing, leafSpacing, minRadius: 190 });
  const allPositions = Array.from(result.values());
  let minDist = Infinity;
  for (let i = 0; i < allPositions.length; i++) {
    for (let j = i + 1; j < allPositions.length; j++) {
      minDist = Math.min(minDist, Math.hypot(allPositions[i].x - allPositions[j].x, allPositions[i].y - allPositions[j].y));
    }
  }
  // The smallest spacing anywhere in the tree is nodeSpacing (90) - leafSpacing (220) only
  // applies within a single cluster's own ring, which is always >= nodeSpacing here.
  assert.equal(minDist >= nodeSpacing - 0.5, true, `closest pair anywhere was ${minDist.toFixed(1)}, expected >= ${nodeSpacing}`);
});

test('computeRecursiveRadialLayout spreads the largest children apart from each other instead of using their original array order (regression: two of the real sample\'s biggest leaf-parents, 25 and 42 devices, were consecutive in IP order, forcing far more separation between that one pair than the rest of the ring needed - reported directly as "still can be brought together more")', () => {
  const childrenOf = new Map([['root', []]]);
  // Two huge branches placed adjacently in array order, deliberately, plus several
  // modest ones - if array order were used as-is, the two huge branches would end up
  // angular neighbors; spreading by size should separate them instead.
  const sizes = [5, 5, 5, 80, 90, 5, 5, 5, 5];
  sizes.forEach((n, i) => {
    const id = `p${i}`;
    childrenOf.get('root').push(id);
    childrenOf.set(id, Array.from({ length: n }, (_, k) => `${id}_leaf${k}`));
  });

  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 90, leafSpacing: 190, minRadius: 190 });
  const rootPos = result.get('root');
  const angleOf = id => Math.atan2(result.get(id).y - rootPos.y, result.get(id).x - rootPos.x);

  // The two huge branches (p3, p4) should not be angularly adjacent - some other branch
  // should sit between them on at least one side, i.e. they should not be consecutive in
  // the final ordering of children sorted by angle around root.
  const idsSortedByAngle = childrenOf.get('root').slice().sort((a, b) => angleOf(a) - angleOf(b));
  let adjacent = false;
  for (let i = 0; i < idsSortedByAngle.length; i++) {
    const next = idsSortedByAngle[(i + 1) % idsSortedByAngle.length];
    if ((idsSortedByAngle[i] === 'p3' && next === 'p4') || (idsSortedByAngle[i] === 'p4' && next === 'p3')) {
      adjacent = true;
    }
  }
  assert.equal(adjacent, false,
    `expected the two huge branches (p3, p4) not to be angularly adjacent, but the sorted order was ${idsSortedByAngle.join(', ')}`);
});

test('computeRecursiveRadialLayout produces identical output across repeated runs on the same input (deterministic)', () => {
  const childrenOf = new Map([
    ['root', ['a', 'b', 'c']],
    ['a', ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']],
    ['b', ['b0', 'b1']],
  ]);
  const first = computeRecursiveRadialLayout('root', childrenOf, {});
  const second = computeRecursiveRadialLayout('root', childrenOf, {});
  for (const id of first.keys()) {
    assert.deepEqual(second.get(id), first.get(id), `position for ${id} differed between runs`);
  }
});

test('computeRecursiveRadialLayout: nodeSpacing and leafSpacing move independently - shrinking nodeSpacing pulls a cluster inward without changing its own internal leaf packing, and growing leafSpacing widens the cluster without moving it', () => {
  const childrenOf = new Map([['root', ['mid']], ['mid', Array.from({ length: 9 }, (_, i) => `leaf${i}`)]]);

  const base = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 190, leafSpacing: 190, minRadius: 190 });
  const tighterBranch = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 60, leafSpacing: 190, minRadius: 190 });
  const widerLeaves = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 190, leafSpacing: 400, minRadius: 190 });

  // mid is root's only child, so its own radius from root is just minRadius regardless of
  // nodeSpacing (no siblings to space out from) - but its own leaf packing (relative to
  // itself) should be identical between base and tighterBranch, since only nodeSpacing changed.
  const maxLeafExtentFromMid = (result) => {
    const midPos = result.get('mid');
    let maxR = 0;
    for (let i = 0; i < 9; i++) {
      const p = result.get(`leaf${i}`);
      maxR = Math.max(maxR, Math.hypot(p.x - midPos.x, p.y - midPos.y));
    }
    return maxR;
  };
  assert.equal(maxLeafExtentFromMid(tighterBranch), maxLeafExtentFromMid(base),
    'shrinking nodeSpacing should not change a cluster\'s own internal leaf packing extent');

  // Growing leafSpacing should make the cluster's own extent (furthest leaf from mid)
  // bigger. mid itself legitimately moves further from root too (mid has no siblings
  // to space out from, but its own bigger cluster still needs enough clearance from
  // root not to crowd it - a lone child's distance from its parent depends on its own
  // size, not just a flat minRadius).
  const midPosBase = base.get('mid'), midPosWider = widerLeaves.get('mid');
  const midRadiusBase = Math.hypot(midPosBase.x, midPosBase.y);
  const midRadiusWider = Math.hypot(midPosWider.x, midPosWider.y);
  assert.equal(midRadiusWider > midRadiusBase, true,
    `expected mid to sit further from root with a bigger leafSpacing-driven cluster (got ${midRadiusWider.toFixed(1)} vs ${midRadiusBase.toFixed(1)})`);
  const radiusBase = maxLeafExtentFromMid(base);
  const radiusWider = maxLeafExtentFromMid(widerLeaves);
  assert.equal(radiusWider > radiusBase, true,
    `expected leafSpacing=400 to produce a bigger cluster than leafSpacing=190 (got ${radiusWider.toFixed(1)} vs ${radiusBase.toFixed(1)})`);
});

test('computeRecursiveRadialLayout stays fast and does not blow up radius on the real ~340-node sample shape (regression: an earlier single-ring-per-node version reached max radius ~135000px on this exact shape - confirmed by measuring it, not assumed)', () => {
  const childrenOf = new Map([['root', []]]);
  for (let i = 0; i < 15; i++) {
    const id = `dist${i}`;
    childrenOf.get('root').push(id);
    childrenOf.set(id, Array.from({ length: 5 + (i % 8) }, (_, k) => `${id}_leaf${k}`));
  }
  childrenOf.get('root').push('huge');
  childrenOf.set('huge', Array.from({ length: 150 }, (_, i) => `huge_leaf${i}`));

  const startMs = Date.now();
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 190, minRadius: 190 });
  const elapsedMs = Date.now() - startMs;
  assert.equal(elapsedMs < 2000, true, `layout took ${elapsedMs}ms, expected well under 2000ms`);

  let maxRadius = 0;
  for (const p of result.values()) maxRadius = Math.max(maxRadius, Math.hypot(p.x, p.y));
  // A generous but meaningful bound: the huge branch's own cluster needs
  // clusterRadius(150) from ITSELF, plus root's own ring radius to reach that branch in
  // the first place - a small constant multiple of that sum catches an unbounded blowup
  // (an order of magnitude beyond this bound) while still allowing real, proportionate growth.
  const totalLeaves = 150 + Array.from({ length: 15 }, (_, i) => 5 + (i % 8)).reduce((a, b) => a + b, 0);
  const roughClusterRadius = 190 * Math.sqrt(150 / (2 * Math.PI)); // same math as clusterRadius(150), inlined
  const bound = 5 * (roughClusterRadius + 190 * 16); // + a generous root-ring allowance
  assert.equal(maxRadius < bound, true, `max radius was ${maxRadius.toFixed(0)}, expected under ${bound.toFixed(0)} (total leaves in tree: ${totalLeaves})`);
});

test('computeRecursiveRadialLayout lets modest siblings sit closer to a structural branch than its OWN worst-case reach (in some unrelated direction) would require (regression: sibling clearance used to be charged the branch\'s omnidirectional extent - farthest reach in ANY direction - against every neighbor regardless of which way it actually pointed; confirmed directly on the real sample by measuring true minimum distance between two whole subtrees: 2600-6500px against a 350px nodeSpacing requirement, 7-18x more than needed, because one branch\'s single most distant descendant, oriented in some direction irrelevant to a given neighbor, was still being charged against that neighbor)', () => {
  const childrenOf = new Map([['root', []]]);
  for (let i = 0; i < 10; i++) {
    const id = `p${i}`;
    childrenOf.get('root').push(id);
    childrenOf.set(id, Array.from({ length: 6 }, (_, k) => `${id}_leaf${k}`)); // modest leaf-parents
  }
  // A structural branch (like the real sample's second core switch) whose own children
  // are unevenly sized (24, 8, 7, 9, 6, 8, 7 - a ~3.4x spread, matching the real sample's
  // core2's own 354-1196 child extents) - its omnidirectional extent is dominated by its
  // one largest child, sitting at whatever angle it happens to land at within the
  // branch's own full circle, unrelated to which of root's other children are nearby.
  childrenOf.get('root').push('hub');
  const hubKids = [];
  [24, 8, 7, 9, 6, 8, 7].forEach((size, i) => {
    const id = `hub_c${i}`;
    hubKids.push(id);
    childrenOf.set(id, Array.from({ length: size }, (_, k) => `${id}_leaf${k}`));
  });
  childrenOf.set('hub', hubKids);

  const nodeSpacing = 190, leafSpacing = 190, minRadius = 190;
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing, leafSpacing, minRadius });

  function collectSubtree(id) {
    const out = [id];
    const stack = [...(childrenOf.get(id) || [])];
    while (stack.length) { const n = stack.pop(); out.push(n); stack.push(...(childrenOf.get(n) || [])); }
    return out;
  }
  const hubPositions = collectSubtree('hub').map(id => result.get(id));

  let minDistToHub = Infinity;
  for (let i = 0; i < 10; i++) {
    const siblingPositions = collectSubtree(`p${i}`).map(id => result.get(id));
    for (const a of hubPositions) for (const b of siblingPositions) {
      minDistToHub = Math.min(minDistToHub, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  // An omnidirectional-extent algorithm (charging a neighbor for a branch's farthest
  // reach in ANY direction, not just toward that neighbor) gives a closest true clearance
  // of 1157px on this exact tree shape; directional reach gives 906px, a real (if here
  // modest - the effect compounds much more on a deeper, wider tree) reduction. 5.5x
  // nodeSpacing sits comfortably between the two, catching a regression back toward
  // omnidirectional behavior without being so tight it's fragile to unrelated changes.
  assert.equal(minDistToHub < nodeSpacing * 5.5, true,
    `closest true clearance to hub's subtree was ${minDistToHub.toFixed(0)}, expected under ${nodeSpacing * 5.5} (nodeSpacing=${nodeSpacing})`);

  // Still never an actual collision anywhere.
  const allPositions = Array.from(result.values());
  let minDist = Infinity;
  for (let i = 0; i < allPositions.length; i++) {
    for (let j = i + 1; j < allPositions.length; j++) {
      minDist = Math.min(minDist, Math.hypot(allPositions[i].x - allPositions[j].x, allPositions[i].y - allPositions[j].y));
    }
  }
  assert.equal(minDist >= nodeSpacing - 0.5, true, `closest pair anywhere was ${minDist.toFixed(1)}, expected >= ${nodeSpacing}`);
});

test('computeRecursiveRadialLayout stays fast with many non-leaf siblings at one level (regression: reachToward, called for every pair on every relaxation sweep, made a 300-non-leaf-sibling tree take 11.9s - a 32x regression over the pre-directional-reach algorithm\'s 371ms on the same shape, confirmed by measuring both, not assumed. A leaf/leaf fast path - two leaves\' true clearance is always exactly `spacing`, so it skips the vector math and recursion entirely - an early exit once a relaxation sweep changes nothing by more than 0.01px, and a memo cache for reachToward keyed by node + a quantized angle bucket together brought this back under 5s)', () => {
  const childrenOf = new Map([['root', []]]);
  for (let i = 0; i < 150; i++) {
    const id = `br${i}`;
    childrenOf.get('root').push(id);
    childrenOf.set(id, Array.from({ length: 3 + (i % 5) }, (_, k) => `${id}_l${k}`)); // non-leaf siblings, mildly uneven
  }

  const startMs = Date.now();
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 190, leafSpacing: 190, minRadius: 190 });
  const elapsedMs = Date.now() - startMs;
  assert.equal(elapsedMs < 5000, true, `layout took ${elapsedMs}ms, expected well under 5000ms (the app's own layout timeout is 8000ms)`);
  assert.equal(result.size, 1 + 150 + Array.from({ length: 150 }, (_, i) => 3 + (i % 5)).reduce((a, b) => a + b, 0));
});

test('computeRecursiveRadialLayout\'s reachToward angle-bucket cache never returns less than the true clearance would require (regression: an earlier version cached the value AT the raw, unrounded query angle under a rounded bucket key - which can return a value computed for a slightly different angle than the one actually asked about, silently under-reserving whenever the true value at the exact angle was higher than at the bucket it got rounded into. Confirmed empirically, not just suspected: a 40-non-leaf-sibling case produced a real 189.8px true clearance against a 190px requirement. Fixed by caching the value at the bucket\'s CENTER angle and padding the return by extent(nodeId) times the angular distance from that center to the real query angle - a provably safe bound, since reachToward is extent(nodeId)-Lipschitz in angle by construction, not a fudge factor)', () => {
  const childrenOf = new Map([['root', []]]);
  for (let i = 0; i < 40; i++) {
    const id = `br${i}`;
    childrenOf.get('root').push(id);
    childrenOf.set(id, Array.from({ length: 5 }, (_, k) => `${id}_l${k}`));
  }
  const nodeSpacing = 190;
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing, leafSpacing: 190, minRadius: 190 });

  function collectSubtree(id) {
    const out = [id];
    const stack = [...(childrenOf.get(id) || [])];
    while (stack.length) { const n = stack.pop(); out.push(n); stack.push(...(childrenOf.get(n) || [])); }
    return out;
  }
  const subtrees = Array.from({ length: 40 }, (_, i) => collectSubtree(`br${i}`).map(id => result.get(id)));
  let minDist = Infinity;
  for (let i = 0; i < 40; i++) {
    for (let j = i + 1; j < 40; j++) {
      for (const a of subtrees[i]) for (const b of subtrees[j]) {
        minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
  }
  assert.equal(minDist >= nodeSpacing - 0.5, true,
    `closest true cross-branch clearance was ${minDist.toFixed(2)}, expected >= ${nodeSpacing}`);
});

test('computeRecursiveRadialLayout never divides by zero when minRadius is 0 and every child is a leaf (regression: naturalMin is minRadius+extent, and computeChildAngles divides each child\'s share by the sum of all of them - when minRadius is 0 and every child is a leaf (extent also 0), that sum is 0, silently turning every angle into NaN and every position into {x: NaN, y: NaN}. The app\'s own UI floors minRadius at 20 so this can\'t happen through normal use, but computeRecursiveRadialLayout is exported and callable directly - this guards the function\'s own contract, not just this one caller)', () => {
  const childrenOf = new Map([['root', ['a', 'b', 'c']]]);
  const result = computeRecursiveRadialLayout('root', childrenOf, { minRadius: 0, leafSpacing: 100 });
  for (const id of ['a', 'b', 'c']) {
    const p = result.get(id);
    assert.equal(Number.isFinite(p.x) && Number.isFinite(p.y), true, `${id} position was {x: ${p.x}, y: ${p.y}}, expected finite numbers`);
  }
});

test('computeRecursiveRadialLayout throws once an already-past opts.deadline is checked, rather than running to completion regardless (regression: elk-layout.js used to race this call against a setTimeout to enforce an 8s budget, which cannot work - JS is single-threaded, so the timer cannot preempt this synchronous call no matter how long it runs; the only way to actually bound wall-clock time is a check from inside the computation itself, which is what opts.deadline is for)', () => {
  const childrenOf = new Map([['root', Array.from({ length: 20 }, (_, i) => `child${i}`)]]);
  assert.throws(
    () => computeRecursiveRadialLayout('root', childrenOf, { deadline: Date.now() - 1 }),
    /time budget/
  );
});

test('computeRecursiveRadialLayout completes normally when opts.deadline is omitted or comfortably in the future (no accidental throw on the ordinary, unbounded-budget path every other caller/test relies on)', () => {
  const childrenOf = new Map([['root', ['a', 'b', 'c']]]);
  assert.doesNotThrow(() => computeRecursiveRadialLayout('root', childrenOf, {}));
  assert.doesNotThrow(() => computeRecursiveRadialLayout('root', childrenOf, { deadline: Date.now() + 60000 }));
});
