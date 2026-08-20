import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGraphRoot, compareIpIds, buildPrimaryTree } from '../graph-layout.js';

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
