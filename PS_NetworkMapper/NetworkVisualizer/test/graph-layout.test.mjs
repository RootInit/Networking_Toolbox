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
  assert.ok(['c3', 'c4'].includes(root)); // center of a 6-node chain is one of the two middle nodes
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

test('buildPrimaryTree leaves an unreachable node out of parentOf/childrenOf', () => {
  const nodeIds = ['root', 'a', 'island'];
  const edges = [{ from: 'root', to: 'a' }];
  const { parentOf, childrenOf } = buildPrimaryTree(nodeIds, edges, 'root');
  assert.equal(parentOf.has('island'), false);
  assert.equal(childrenOf.has('island'), false);
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

test('computeRecursiveRadialLayout wraps a large leaf-parent\'s children into more rings once one ring is full', () => {
  const childrenOf = new Map([['root', Array.from({ length: 40 }, (_, i) => `leaf${i}`)]]);
  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 190, minRadius: 190 });
  const radii = new Set(Array.from({ length: 40 }, (_, i) => Math.round(Math.hypot(result.get(`leaf${i}`).x, result.get(`leaf${i}`).y))));
  assert.equal(radii.size > 1, true, 'expected more than one distinct ring radius for 40 leaves');
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
  // the cluster isn't confined to the outward-only wedge the old grid/wedge designs used.
  const facesRootward = leafAngles.some(a => {
    let delta = a - (midAngle + Math.PI);
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return Math.abs(delta) < Math.PI / 2;
  });
  assert.equal(facesRootward, true, 'expected at least one leaf on the root-facing side of its own cluster');
});

test('computeRecursiveRadialLayout spaces ALL siblings uniformly when just one of them has an outsized cluster - never singles one branch out (regression: an earlier version pushed only the oversized branch, producing wildly uneven spacing)', () => {
  const childrenOf = new Map([['root', []]]);
  for (let i = 0; i < 10; i++) {
    const id = `p${i}`;
    childrenOf.get('root').push(id);
    childrenOf.set(id, Array.from({ length: 6 }, (_, k) => `${id}_leaf${k}`)); // modest
  }
  childrenOf.get('root').push('huge');
  childrenOf.set('huge', Array.from({ length: 120 }, (_, i) => `huge_leaf${i}`)); // outsized

  const result = computeRecursiveRadialLayout('root', childrenOf, { nodeSpacing: 190, minRadius: 190 });
  const radii = childrenOf.get('root').map(id => Math.hypot(result.get(id).x, result.get(id).y));
  const min = Math.min(...radii), max = Math.max(...radii);
  assert.equal(max - min < 0.01, true,
    `expected every one of root's 11 direct children at the same radius, saw a spread of ${(max - min).toFixed(1)}`);
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
  // bigger, without moving mid itself (mid has no siblings, so nodeSpacing never affected it).
  const midPosBase = base.get('mid'), midPosWider = widerLeaves.get('mid');
  assert.deepEqual(midPosWider, midPosBase, 'growing leafSpacing should not move the cluster\'s own anchor point');
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
  // the first place - a small constant multiple of that sum catches the earlier ~135000px
  // blowup (which was roughly 15x this bound) while still allowing real, proportionate growth.
  const totalLeaves = 150 + Array.from({ length: 15 }, (_, i) => 5 + (i % 8)).reduce((a, b) => a + b, 0);
  const roughClusterRadius = 190 * Math.sqrt(150 / (2 * Math.PI)); // same math as clusterRadius(150), inlined
  const bound = 5 * (roughClusterRadius + 190 * 16); // + a generous root-ring allowance
  assert.equal(maxRadius < bound, true, `max radius was ${maxRadius.toFixed(0)}, expected under ${bound.toFixed(0)} (total leaves in tree: ${totalLeaves})`);
});
