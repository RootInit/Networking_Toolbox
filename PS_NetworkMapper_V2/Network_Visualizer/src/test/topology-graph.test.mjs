import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDeviceClassification, computeNeighborEdges } from '../topology-graph.js';

const SCANNED_STANDALONE = {
  DeviceIP: '10.0.0.1', Hostname: 'sw1', StackMembers: [{ FPC: '0', Serial: 'ABC123', Role: 'Standalone' }],
  Neighbors: [{ ManagementIP: '10.0.0.2', Hostname: 'sw2' }],
};
const SCANNED_STACK = {
  DeviceIP: '10.0.0.3', Hostname: 'sw3',
  StackMembers: [{ FPC: '0', Serial: 'S1', Role: 'Master' }, { FPC: '1', Serial: 'S2', Role: 'Backup' }],
  Neighbors: [],
};

test('computeDeviceClassification marks a scanned standalone device correctly', () => {
  const result = computeDeviceClassification([SCANNED_STANDALONE]);
  assert.deepEqual(result.get('10.0.0.1'), { scanned: true, isStack: false, hostname: 'sw1' });
});

test('computeDeviceClassification marks a scanned stack (2+ StackMembers) as isStack', () => {
  const result = computeDeviceClassification([SCANNED_STACK]);
  assert.equal(result.get('10.0.0.3').isStack, true);
});

test('computeDeviceClassification adds an unscanned placeholder for an LLDP neighbor never itself scanned', () => {
  const result = computeDeviceClassification([SCANNED_STANDALONE]);
  assert.deepEqual(result.get('10.0.0.2'), { scanned: false, isStack: false, hostname: 'sw2' });
});

test('computeDeviceClassification skips a neighbor with no usable ManagementIP', () => {
  const device = { DeviceIP: '10.0.0.9', Neighbors: [{ ManagementIP: 'Unknown' }, { ManagementIP: '0.0.0.0' }] };
  const result = computeDeviceClassification([device]);
  assert.equal(result.size, 1); // only 10.0.0.9 itself, no placeholder for either bad neighbor
});

test('computeDeviceClassification lets a scanned pass override an earlier unscanned placeholder', () => {
  // sw2 is BOTH a neighbor of sw1 (pass 2 would placeholder it) AND independently scanned
  // (pass 1) - the scanned entry must win, matching graph.js's existing two-pass order.
  const sw2Scanned = { DeviceIP: '10.0.0.2', Hostname: 'sw2-real', StackMembers: [], Neighbors: [] };
  const result = computeDeviceClassification([SCANNED_STANDALONE, sw2Scanned]);
  assert.deepEqual(result.get('10.0.0.2'), { scanned: true, isStack: false, hostname: 'sw2-real' });
});

test('computeNeighborEdges produces one deduplicated edge per neighbor pair', () => {
  const edges = computeNeighborEdges([SCANNED_STANDALONE]);
  assert.deepEqual(edges, [{ from: '10.0.0.1', to: '10.0.0.2' }]);
});

test('computeNeighborEdges does not duplicate an edge reported from both ends', () => {
  const a = { DeviceIP: '10.0.0.1', Neighbors: [{ ManagementIP: '10.0.0.2' }] };
  const b = { DeviceIP: '10.0.0.2', Neighbors: [{ ManagementIP: '10.0.0.1' }] };
  const edges = computeNeighborEdges([a, b]);
  assert.equal(edges.length, 1);
});

test('computeNeighborEdges skips neighbors with no usable ManagementIP', () => {
  const device = { DeviceIP: '10.0.0.9', Neighbors: [{ ManagementIP: 'Unknown' }] };
  assert.deepEqual(computeNeighborEdges([device]), []);
});
