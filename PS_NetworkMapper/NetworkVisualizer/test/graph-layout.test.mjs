import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGraphRoot, compareIpIds, buildPrimaryTree, computeVisibleTree, expandAncestors, applyLeafGridClustering } from '../graph-layout.js';

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

// Shared fixture: root at origin, one leaf-parent straight east of root (theta=0),
// with 9 leaf children (a clean 3x3 grid) - a plain, non-degenerate case.
function eastParentFixture(leafCount) {
  const childrenOf = new Map([
    ['root', ['parent']],
    ['parent', Array.from({ length: leafCount }, (_, i) => `leaf${i}`)],
  ]);
  const positions = new Map([
    ['root', { x: 0, y: 0 }],
    ['parent', { x: 500, y: 0 }],
  ]);
  return { childrenOf, positions };
}

test('applyLeafGridClustering leaves positions untouched below the threshold', () => {
  const { childrenOf, positions } = eastParentFixture(4);
  const result = applyLeafGridClustering(positions, 'root', childrenOf, { leafGridThreshold: 5 });
  // Below threshold: nothing about "parent"'s children was touched, so they're simply
  // absent from the input `positions` map still - applyLeafGridClustering never invents
  // positions for nodes it doesn't reposition.
  assert.equal(result.has('leaf0'), false);
  assert.deepEqual(result.get('parent'), { x: 500, y: 0 });
});

test('applyLeafGridClustering grids leaf children once at/over the threshold, in a cols=ceil(sqrt(n)) shape', () => {
  const { childrenOf, positions } = eastParentFixture(9);
  const result = applyLeafGridClustering(positions, 'root', childrenOf, { leafGridThreshold: 5 });
  const leafIds = Array.from({ length: 9 }, (_, i) => `leaf${i}`);
  for (const id of leafIds) {
    assert.equal(result.has(id), true, `${id} should have a position`);
  }
  const xs = new Set(leafIds.map(id => Math.round(result.get(id).x)));
  const ys = new Set(leafIds.map(id => Math.round(result.get(id).y)));
  // 9 nodes, cols = ceil(sqrt(9)) = 3 -> exactly 3 distinct columns and 3 distinct rows
  assert.equal(xs.size <= 3, true, `expected at most 3 distinct x-rows, got ${xs.size}`);
  assert.equal(ys.size <= 3, true, `expected at most 3 distinct y-rows, got ${ys.size}`);
});

test('applyLeafGridClustering never moves the leaf-parent itself, or the root', () => {
  const { childrenOf, positions } = eastParentFixture(9);
  const result = applyLeafGridClustering(positions, 'root', childrenOf, { leafGridThreshold: 5 });
  assert.deepEqual(result.get('root'), { x: 0, y: 0 });
  assert.deepEqual(result.get('parent'), { x: 500, y: 0 });
});

test('applyLeafGridClustering grows the grid outward along the root->parent direction, not perpendicular to it', () => {
  // Parent is due east of root (theta=0): row growth (the grid's "outward" axis) must
  // increase x while staying near parent's y - not the other way around, which is the
  // exact rotation-matrix sign mixup this function is easy to get backwards on.
  const { childrenOf, positions } = eastParentFixture(9);
  const result = applyLeafGridClustering(positions, 'root', childrenOf, { leafGridThreshold: 5, gridBaseOffset: 110, gridSpacingY: 90 });
  const parentPos = positions.get('parent');
  for (const id of ['leaf0', 'leaf1', 'leaf2', 'leaf3', 'leaf4', 'leaf5', 'leaf6', 'leaf7', 'leaf8']) {
    const pos = result.get(id);
    assert.equal(pos.x > parentPos.x, true, `${id} (${JSON.stringify(pos)}) should be further east than parent`);
  }
});

test('applyLeafGridClustering rotates the grid to follow a non-axis-aligned branch direction', () => {
  // Parent sits north-east of root (45 degrees) instead of due east - the grid must
  // rotate to match, not stay pinned to the world x/y axes.
  const childrenOf = new Map([
    ['root', ['parent']],
    ['parent', Array.from({ length: 6 }, (_, i) => `leaf${i}`)],
  ]);
  const positions = new Map([
    ['root', { x: 0, y: 0 }],
    ['parent', { x: 400, y: -400 }], // 45 degrees "up and to the right" in screen coords
  ]);
  const result = applyLeafGridClustering(positions, 'root', childrenOf, { leafGridThreshold: 5 });
  const parentPos = positions.get('parent');
  const branchAngle = Math.atan2(parentPos.y, parentPos.x);
  for (let i = 0; i < 6; i++) {
    const pos = result.get(`leaf${i}`);
    const leafAngleFromParent = Math.atan2(pos.y - parentPos.y, pos.x - parentPos.x);
    // Every leaf must fall within +/-90 degrees of the branch's own outward direction -
    // i.e. on the far side of the parent from the root, not doubling back toward it or
    // running perpendicular to the branch (which is what an unrotated axis-aligned grid,
    // or the rotation-matrix sign mixup, would produce instead).
    let delta = leafAngleFromParent - branchAngle;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    assert.equal(Math.abs(delta) < Math.PI / 2, true,
      `leaf${i} at angle ${leafAngleFromParent.toFixed(2)} should be within 90 degrees of branch angle ${branchAngle.toFixed(2)}`);
  }
});

test('applyLeafGridClustering keeps two colliding branches from overlapping by pushing one outward', () => {
  // Two leaf-parents close together in angle (both roughly east of root, one slightly
  // north, one slightly south) with big grids - without collision resolution their grids
  // would overlap in the middle.
  const childrenOf = new Map([
    ['root', ['parentA', 'parentB']],
    ['parentA', Array.from({ length: 12 }, (_, i) => `a${i}`)],
    ['parentB', Array.from({ length: 12 }, (_, i) => `b${i}`)],
  ]);
  const positions = new Map([
    ['root', { x: 0, y: 0 }],
    ['parentA', { x: 500, y: -40 }],
    ['parentB', { x: 500, y: 40 }],
  ]);
  const result = applyLeafGridClustering(positions, 'root', childrenOf, {
    leafGridThreshold: 5, minNodeSpacing: 170,
  });
  const aPositions = Array.from({ length: 12 }, (_, i) => result.get(`a${i}`));
  const bPositions = Array.from({ length: 12 }, (_, i) => result.get(`b${i}`));
  let minDist = Infinity;
  for (const a of aPositions) {
    for (const b of bPositions) {
      minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  assert.equal(minDist >= 170, true, `closest cross-branch pair was ${minDist.toFixed(1)}, expected >= 170`);
});

test('applyLeafGridClustering resolves collisions among many branches, not just the first pair (regression: used to leave most branches un-pushed while ejecting one or two far away)', () => {
  // 16 leaf-parents spread evenly in a full circle around root, each with a sizeable
  // grid - dense enough that every branch collides with at least one neighbor unless
  // collision resolution actually visits all of them.
  const BRANCH_COUNT = 16;
  const childrenOf = new Map([['root', []]]);
  const positions = new Map([['root', { x: 0, y: 0 }]]);
  for (let i = 0; i < BRANCH_COUNT; i++) {
    const parentId = `p${i}`;
    childrenOf.get('root').push(parentId);
    const angle = (2 * Math.PI * i) / BRANCH_COUNT;
    positions.set(parentId, { x: 300 * Math.cos(angle), y: 300 * Math.sin(angle) });
    childrenOf.set(parentId, Array.from({ length: 10 }, (_, k) => `${parentId}_leaf${k}`));
  }

  const result = applyLeafGridClustering(positions, 'root', childrenOf, { leafGridThreshold: 5 });

  // Every branch's grid must have been placed at least at the base offset from its own
  // parent - i.e. every branch was actually considered, not just one or two.
  for (let i = 0; i < BRANCH_COUNT; i++) {
    const parentId = `p${i}`;
    const pPos = positions.get(parentId);
    const leaf0 = result.get(`${parentId}_leaf0`);
    assert.equal(typeof leaf0.x, 'number');
    assert.equal(Math.hypot(leaf0.x - pPos.x, leaf0.y - pPos.y) >= 100, true,
      `${parentId}'s first leaf should be pushed out from its parent, got distance ${Math.hypot(leaf0.x - pPos.x, leaf0.y - pPos.y).toFixed(1)}`);
  }

  // No two leaves from DIFFERENT branches should end up closer than the collision
  // threshold (170, the default) - same-branch pairs are excluded since adjacent grid
  // rows are deliberately spaced closer than that (90px) by construction, not a collision.
  let minCrossBranchDist = Infinity;
  for (let i = 0; i < BRANCH_COUNT; i++) {
    for (let j = i + 1; j < BRANCH_COUNT; j++) {
      for (let ki = 0; ki < 10; ki++) {
        for (let kj = 0; kj < 10; kj++) {
          const a = result.get(`p${i}_leaf${ki}`), b = result.get(`p${j}_leaf${kj}`);
          minCrossBranchDist = Math.min(minCrossBranchDist, Math.hypot(a.x - b.x, a.y - b.y));
        }
      }
    }
  }
  assert.equal(minCrossBranchDist >= 170, true, `closest cross-branch pair was ${minCrossBranchDist.toFixed(1)}, expected >= 170`);
});

test('applyLeafGridClustering treats a cluster placeholder as a leaf', () => {
  // Cluster placeholder nodes ("cluster:X") never appear as a key in childrenOf, exactly
  // like a real leaf switch - confirm they're gridded the same way, not skipped.
  const childrenOf = new Map([
    ['root', ['parent']],
    ['parent', ['leaf0', 'leaf1', 'leaf2', 'leaf3', 'cluster:leaf4']],
  ]);
  const positions = new Map([
    ['root', { x: 0, y: 0 }],
    ['parent', { x: 500, y: 0 }],
  ]);
  const result = applyLeafGridClustering(positions, 'root', childrenOf, { leafGridThreshold: 5 });
  assert.equal(result.has('cluster:leaf4'), true);
});
