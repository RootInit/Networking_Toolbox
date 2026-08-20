import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGraphRoot, compareIpIds } from '../graph-layout.js';

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
