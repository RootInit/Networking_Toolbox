import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGridFallback, computeLayout } from '../elk-layout.js';
import * as GraphLayout from '../graph-layout.js';

// computeLayout reaches its engine via window.GraphLayout - set that up once for this file.
global.window = global.window || {};
global.window.GraphLayout = GraphLayout;

test('computeGridFallback places every node with a numeric x/y', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const positions = computeGridFallback(ids);
  assert.equal(positions.size, 5);
  for (const id of ids) {
    const pos = positions.get(id);
    assert.equal(typeof pos.x, 'number');
    assert.equal(typeof pos.y, 'number');
    assert.equal(Number.isNaN(pos.x), false);
    assert.equal(Number.isNaN(pos.y), false);
  }
});

test('computeGridFallback never places two nodes at the same position', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
  const positions = computeGridFallback(ids);
  const seen = new Set();
  for (const id of ids) {
    const key = `${positions.get(id).x},${positions.get(id).y}`;
    assert.equal(seen.has(key), false, `duplicate position for ${id}`);
    seen.add(key);
  }
});

test('computeGridFallback returns an empty map for no nodes', () => {
  assert.equal(computeGridFallback([]).size, 0);
});

// A disconnected fabric island (buildPrimaryTree keeps those as extra top-level entries) must still
// get a computed position, or graph.js defaults every one of its nodes to (0, 0). computeLayout
// finds every node with no incoming visible edge and lays each out as its own component.
test('computeLayout gives a disconnected second component (with no incoming edge) its own non-overlapping positions', async () => {
  // Main component: small 3-node star.
  const mainEdges = [
    { from: 'root', to: 'm1' },
    { from: 'root', to: 'm2' },
  ];
  // Deliberately BIGGER than the main component, to catch an offset sized only off the FIRST
  // component's extent.
  const islandChildren = Array.from({ length: 15 }, (_, i) => `i${i}`);
  const islandEdges = islandChildren.map(id => ({ from: 'island-root', to: id }));

  const visibleNodeIds = ['root', 'm1', 'm2', 'island-root', ...islandChildren];
  const visibleEdges = [...mainEdges, ...islandEdges];

  const positions = await computeLayout(visibleNodeIds, visibleEdges, {});
  assert.equal(positions.size, visibleNodeIds.length);
  for (const id of visibleNodeIds) {
    const pos = positions.get(id);
    assert.equal(Number.isNaN(pos.x), false);
    assert.equal(Number.isNaN(pos.y), false);
  }

  const mainIds = ['root', 'm1', 'm2'];
  const islandIds = ['island-root', ...islandChildren];
  const NODE_WIDTH = 160;
  for (const mId of mainIds) {
    for (const iId of islandIds) {
      const a = positions.get(mId), b = positions.get(iId);
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(dist >= NODE_WIDTH, `${mId} and ${iId} are only ${dist}px apart, expected >= ${NODE_WIDTH}`);
    }
  }
});

// computeLayout's try/catch is the last-resort net when the layout engine throws or times out, and
// no test above enters it. Force the catch via the same window.GraphLayout seam and confirm the
// result is exactly what computeGridFallback would produce.
test('computeLayout falls back to computeGridFallback\'s output when the layout engine throws', async () => {
  // GraphLayout is a frozen module namespace, so swap out window.GraphLayout itself (the seam
  // computeLayout reads through) for a wrapper with a throwing override, then restore it.
  const original = global.window.GraphLayout;
  global.window.GraphLayout = { ...GraphLayout, computeRecursiveRadialLayout: () => {
    throw new Error('simulated layout engine failure');
  } };
  try {
    const visibleNodeIds = ['root', 'a', 'b', 'c'];
    const visibleEdges = [
      { from: 'root', to: 'a' }, { from: 'root', to: 'b' }, { from: 'root', to: 'c' },
    ];
    const positions = await computeLayout(visibleNodeIds, visibleEdges, {});
    const expected = computeGridFallback(visibleNodeIds);
    assert.equal(positions.size, expected.size);
    for (const id of visibleNodeIds) {
      assert.deepEqual(positions.get(id), expected.get(id));
    }
  } finally {
    global.window.GraphLayout = original;
  }
});
