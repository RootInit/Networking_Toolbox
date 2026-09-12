import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDeviceClassification, computeNeighborEdges, computeVlanCache, buildSwitchMapNodeMeta } from '../topology-graph.js';

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

test('computeDeviceClassification tolerates a null/undefined element in Neighbors (malformed scan data)', () => {
  const device = { DeviceIP: '10.0.0.10', Hostname: 'sw10', StackMembers: [], Neighbors: [null, { ManagementIP: '10.0.0.11', Hostname: 'sw11' }, undefined] };
  const result = computeDeviceClassification([device]);
  assert.deepEqual(result.get('10.0.0.11'), { scanned: false, isStack: false, hostname: 'sw11' });
});

test('computeDeviceClassification skips a neighbor with no usable ManagementIP', () => {
  const device = { DeviceIP: '10.0.0.9', Neighbors: [{ ManagementIP: 'Unknown' }, { ManagementIP: '0.0.0.0' }] };
  const result = computeDeviceClassification([device]);
  assert.equal(result.size, 1); // only 10.0.0.9 itself, no placeholder for either bad neighbor
});

test('computeDeviceClassification lets a scanned pass override an earlier unscanned placeholder', () => {
  // sw2 is both a neighbor of sw1 (pass 2) and independently scanned (pass 1); scanned must win.
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

// Two gaps: nothing asserted the insertion ORDER of computeDeviceClassification's result, and
// nothing exercised the contract buildSwitchMap relies on for an unscanned placeholder.

test('computeDeviceClassification: the scanned-override result is independent of array order (rules out a single interleaved pass with a shared insert-if-absent guard)', () => {
  // The same two devices as above, with sw1 and sw2Scanned SWAPPED in the input array. Two full
  // passes make order irrelevant; a single interleaved pass sharing one `if (!result.has(ip))` guard
  // would let whichever reference came first win, so both orderings must agree.
  const sw2Scanned = { DeviceIP: '10.0.0.2', Hostname: 'sw2-real', StackMembers: [], Neighbors: [] };
  const resultReversed = computeDeviceClassification([sw2Scanned, SCANNED_STANDALONE]);
  assert.deepEqual(resultReversed.get('10.0.0.2'), { scanned: true, isStack: false, hostname: 'sw2-real' });
});

test('computeDeviceClassification: every pass-1 (scanned) key precedes every pass-2 (placeholder) key in insertion order, even when a placeholder-triggering neighbor reference is interleaved between two scanned devices in the source array', () => {
  // d1 (scanned) references n1, never itself scanned; d2 is listed after d1. Two full passes insert
  // d1, d2 (pass 1, array order), then n1 (pass 2) - [d1, d2, n1]. A single interleaved pass would
  // give [d1, n1, d2]. Asserting the exact order pins down which structure ran, not just that the
  // values came out right.
  const d1 = { DeviceIP: '10.0.1.1', Hostname: 'd1', Neighbors: [{ ManagementIP: '10.0.1.99', Hostname: 'n1' }] };
  const d2 = { DeviceIP: '10.0.1.2', Hostname: 'd2', Neighbors: [] };
  const result = computeDeviceClassification([d1, d2]);
  assert.deepEqual(Array.from(result.keys()), ['10.0.1.1', '10.0.1.2', '10.0.1.99']);
  assert.deepEqual(result.get('10.0.1.99'), { scanned: false, isStack: false, hostname: 'n1' });
});

test('computeDeviceClassification: a pass-2-only (unscanned) placeholder is always isStack:false, never something a caller would need real device data to compute', () => {
  // For an unscanned placeholder IP, buildSwitchMap's deviceByIpLocal lookup is guaranteed to miss,
  // so `device` is undefined and only `meta.isStack` short-circuiting keeps it from dereferencing.
  // This pins the topology-graph half: an unscanned entry's isStack is unconditionally false.
  const device = { DeviceIP: '10.0.2.1', Hostname: 'd1', Neighbors: [{ ManagementIP: '10.0.2.99', Hostname: 'ghost' }] };
  const result = computeDeviceClassification([device]);
  const placeholder = result.get('10.0.2.99');
  assert.equal(placeholder.isStack, false);
  assert.deepEqual(placeholder, { scanned: false, isStack: false, hostname: 'ghost' });
});

// graph.js's buildSwitchMap has no test file - it touches the DOM and vis-network. Its node
// construction (classification + device lookup + VLAN cache -> label/shape) has no such dependency,
// so it lives here as buildSwitchMapNodeMeta and graph.js calls this exact function. That makes the
// tests below real coverage of the `device === undefined` path no sample snapshot exercises.

test('buildSwitchMap-equivalent node-meta construction does not throw and produces a plain gray placeholder node for an unscanned neighbor (device undefined case)', () => {
  const device = { DeviceIP: '10.0.3.1', Hostname: 'd1', Neighbors: [{ ManagementIP: '10.0.3.99', Hostname: 'ghost' }] };
  const meta = buildSwitchMapNodeMeta([device]);
  assert.deepEqual(meta.get('10.0.3.99'), {
    label: 'Switch\n10.0.3.99\n(ghost)', shape: 'box', isStack: false, scanned: false, vlanCache: [],
  });
});

// --- computeVlanCache, shared by buildSwitchMap and renderMapMarkers so the two can't diverge ---

test('computeVlanCache maps each scanned device to the VLAN tags of its own TrueClients', () => {
  const device = { DeviceIP: '10.0.4.1', TrueClients: [{ VLAN_Tag: 10 }, { VLAN_Tag: 20 }] };
  const result = computeVlanCache([device]);
  assert.deepEqual(result.get('10.0.4.1'), ['10', '20']);
});

test('computeVlanCache gives an empty array (not a missing entry) for a device with no TrueClients', () => {
  const device = { DeviceIP: '10.0.4.2' };
  const result = computeVlanCache([device]);
  assert.deepEqual(result.get('10.0.4.2'), []);
});

test('computeVlanCache skips a malformed entry with no DeviceIP', () => {
  const result = computeVlanCache([{ TrueClients: [{ VLAN_Tag: 5 }] }]);
  assert.equal(result.size, 0);
});

test('buildSwitchMap-equivalent node-meta construction produces a correctly styled stack node for a scanned device', () => {
  const meta = buildSwitchMapNodeMeta([SCANNED_STACK]);
  assert.deepEqual(meta.get('10.0.0.3'), {
    label: 'Switch\n10.0.0.3\n(sw3)\n[VC: 2 Node]', shape: 'database', isStack: true, scanned: true, vlanCache: [],
  });
});
