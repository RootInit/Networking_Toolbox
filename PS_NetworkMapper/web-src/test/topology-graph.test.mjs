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

// --- Additional coverage added after code review (post-commit d49f9d0) ---
//
// The 8 tests above are the brief's original test set, kept verbatim. The tests below
// close two gaps the review found: (1) nothing asserted the actual insertion ORDER of
// computeDeviceClassification's result, which is what makes "two full separate passes"
// a real, order-independent guarantee rather than an implementation detail that happens
// to pass under one specific array ordering; (2) nothing exercised, at the topology-graph
// level, the exact contract graph.js's buildSwitchMap depends on to safely skip a
// possibly-missing device lookup for an unscanned placeholder.

test('computeDeviceClassification: the scanned-override result is independent of array order (rules out a single interleaved pass with a shared insert-if-absent guard)', () => {
  // Same two devices as the "lets a scanned pass override" test above, but with sw1 and
  // sw2Scanned SWAPPED in the input array. A genuine two-full-passes implementation runs
  // ALL of pass 1 (every device's own scanned entry, unconditionally) before pass 2 (LLDP
  // placeholders) ever starts, so which device is listed first cannot matter. A single
  // interleaved pass that used one common `if (!result.has(ip))` guard for both a
  // device's own entry AND its neighbors' placeholders would NOT be order-independent -
  // whichever reference (own-entry vs. neighbor-placeholder) is encountered first in
  // traversal order would win, and reversing the array would flip the outcome for at
  // least one of the two orderings. Both orderings must agree for this to be real
  // evidence of two separate passes, not a coincidence of the one order actually tested.
  const sw2Scanned = { DeviceIP: '10.0.0.2', Hostname: 'sw2-real', StackMembers: [], Neighbors: [] };
  const resultReversed = computeDeviceClassification([sw2Scanned, SCANNED_STANDALONE]);
  assert.deepEqual(resultReversed.get('10.0.0.2'), { scanned: true, isStack: false, hostname: 'sw2-real' });
});

test('computeDeviceClassification: every pass-1 (scanned) key precedes every pass-2 (placeholder) key in insertion order, even when a placeholder-triggering neighbor reference is interleaved between two scanned devices in the source array', () => {
  // d1 (scanned) references n1 as an LLDP neighbor that is never itself scanned; d2
  // (scanned, unrelated to n1) is listed AFTER d1 in the source array. Under two full
  // separate passes, pass 1 walks the whole array first and inserts d1 then d2 (both
  // scanned, in array order) - only THEN does pass 2 walk the array again and insert n1's
  // placeholder, since it's still absent. Final order: [d1, d2, n1].
  //
  // A single interleaved pass (process each device's own entry, then immediately its
  // neighbors, before moving to the next device) would instead insert d1, then n1
  // (discovered while still processing d1), then d2 - order [d1, n1, d2]. The two
  // structures produce different key orders for identical input; asserting the exact
  // order pins down which structure actually ran, not just which values ended up correct.
  const d1 = { DeviceIP: '10.0.1.1', Hostname: 'd1', Neighbors: [{ ManagementIP: '10.0.1.99', Hostname: 'n1' }] };
  const d2 = { DeviceIP: '10.0.1.2', Hostname: 'd2', Neighbors: [] };
  const result = computeDeviceClassification([d1, d2]);
  assert.deepEqual(Array.from(result.keys()), ['10.0.1.1', '10.0.1.2', '10.0.1.99']);
  assert.deepEqual(result.get('10.0.1.99'), { scanned: false, isStack: false, hostname: 'n1' });
});

test('computeDeviceClassification: a pass-2-only (unscanned) placeholder is always isStack:false, never something a caller would need real device data to compute', () => {
  // graph.js's buildSwitchMap looks up each classified IP in a `deviceByIpLocal` map built
  // straight from the topology array; for an unscanned placeholder IP, that lookup is
  // guaranteed to miss (Pass 2 only placeholders an IP that never appeared as its own
  // topology entry), so `device` is `undefined` there. buildSwitchMap only survives that
  // by relying on `meta.isStack` short-circuiting the ternary that reads
  // `device.StackMembers.length` before `device` is ever dereferenced. This test pins
  // down the half of that contract that lives in topology-graph.js: an unscanned entry's
  // isStack is unconditionally false, for every unscanned placeholder, not just this one.
  const device = { DeviceIP: '10.0.2.1', Hostname: 'd1', Neighbors: [{ ManagementIP: '10.0.2.99', Hostname: 'ghost' }] };
  const result = computeDeviceClassification([device]);
  const placeholder = result.get('10.0.2.99');
  assert.equal(placeholder.isStack, false);
  assert.deepEqual(placeholder, { scanned: false, isStack: false, hostname: 'ghost' });
});

// graph.js's buildSwitchMap (window.buildSwitchMap) itself has no test file - like every
// other file in this app that touches the DOM/vis-network/window globals directly, it isn't
// unit-testable without a browser. Its node-construction logic (classification + device
// lookup + VLAN cache -> label/shape) has no such dependency though, so it lives here as
// buildSwitchMapNodeMeta and graph.js calls this exact function - making the tests below
// real regression coverage of the shipped code, not a frozen copy of it. This is the closest
// committed regression coverage for that integration point, specifically the
// `device === undefined` path for an unscanned placeholder, which neither committed sample
// snapshot exercises (see task-3-report.md for the differential check run against both real
// snapshots during manual verification).

test('buildSwitchMap-equivalent node-meta construction does not throw and produces a plain gray placeholder node for an unscanned neighbor (device undefined case)', () => {
  const device = { DeviceIP: '10.0.3.1', Hostname: 'd1', Neighbors: [{ ManagementIP: '10.0.3.99', Hostname: 'ghost' }] };
  const meta = buildSwitchMapNodeMeta([device]);
  assert.deepEqual(meta.get('10.0.3.99'), {
    label: 'Switch\n10.0.3.99\n(ghost)', shape: 'box', isStack: false, scanned: false, vlanCache: [],
  });
});

// --- computeVlanCache (shared by graph.js's buildSwitchMap and map.js's renderMapMarkers -
// added so a device's VLAN set can never diverge between the diagram and the map view) ---

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
