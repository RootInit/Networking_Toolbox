import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGridFallback } from '../elk-layout.js';

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
