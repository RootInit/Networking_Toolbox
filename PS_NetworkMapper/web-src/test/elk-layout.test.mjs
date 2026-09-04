import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGridFallback, computeLayout } from '../elk-layout.js';
import * as GraphLayout from '../graph-layout.js';

// computeLayout reaches its positioning engine via window.GraphLayout.
// computeRecursiveRadialLayout (mirroring the browser global) rather than importing
// graph-layout.js directly - set that up once for every test in this file.
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

// A disconnected fabric island (graph-layout.js's buildPrimaryTree attaches those as
// extra top-level entries rather than dropping them) must still get a computed position -
// without one, graph.js would default every one of its nodes to (0, 0), stacking them on
// top of whatever else is there. computeLayout finds every node with no incoming
// visible edge and lays each out as its own component, offset along x.
test('computeLayout gives a disconnected second component (with no incoming edge) its own non-overlapping positions', async () => {
  // Main component: small 3-node star.
  const mainEdges = [
    { from: 'root', to: 'm1' },
    { from: 'root', to: 'm2' },
  ];
  // Second component: deliberately BIGGER than the main one (15 leaf children vs 2),
  // to catch an offset that was only sized off the FIRST component's extent - a
  // fixed one-sided margin from a small first tree is not enough to clear a much
  // larger second one.
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

// computeLayout's try/catch (elk-layout.js:89-108) is the last-resort safety net when
// the layout engine throws or times out - none of the tests above ever enter it, since
// they either call computeGridFallback directly or give computeLayout a well-formed
// input that completes normally. Force the catch branch via the same
// window.GraphLayout seam this file's own setup (line 9-10) already uses to reach the
// engine, and confirm computeLayout returns exactly what computeGridFallback would
// produce for the same node list, rather than throwing or hanging.
test('computeLayout falls back to computeGridFallback\'s output when the layout engine throws', async () => {
  // GraphLayout is a frozen ES module namespace object, so its own
  // computeRecursiveRadialLayout can't be reassigned - swap out window.GraphLayout
  // itself (the seam computeLayout actually reads through) for a plain object that
  // wraps it with a throwing override, then restore the real module namespace after.
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
