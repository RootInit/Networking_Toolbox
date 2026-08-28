// Pure device-classification/edge extraction shared by graph.js (the diagram) and map.js
// (the geo view) - both need "which devices exist, are they scanned/stacked, and which
// pairs are LLDP neighbors" from the same raw topology array, and must never classify a
// device differently between the two views. No DOM, no vis-network, no Leaflet.

function computeDeviceClassification(topology) {
  var result = new Map();

  // Pass 1: every actually-scanned device, even if something below already placeholdered
  // its IP as a neighbor - scanned always wins (mirrors graph.js's existing two-pass order).
  topology.forEach(function (device) {
    if (!device || !device.DeviceIP) return;
    var isStack = !!(device.StackMembers && device.StackMembers.length > 1);
    result.set(String(device.DeviceIP), {
      scanned: true, isStack: isStack, hostname: device.Hostname || 'Unknown',
    });
  });

  // Pass 2: LLDP neighbors that were never themselves scanned get a placeholder entry.
  topology.forEach(function (device) {
    if (!device || !device.DeviceIP || !device.Neighbors) return;
    device.Neighbors.forEach(function (neighbor) {
      var neighborIp = String(neighbor.ManagementIP);
      if (!neighborIp || neighborIp === 'Unknown' || neighborIp === '0.0.0.0') return;
      if (!result.has(neighborIp)) {
        result.set(neighborIp, { scanned: false, isStack: false, hostname: neighbor.Hostname || 'Unknown' });
      }
    });
  });

  return result;
}

// Per-device VLAN tags seen on that device's own local clients (from its MAC table), keyed
// by DeviceIP - shared by graph.js (the diagram's per-node vlanCache) and map.js (VLAN
// highlighting on markers/edges) so the two views can never classify a device's VLANs
// differently. A device with no TrueClients (unscanned neighbor placeholder, or a scanned
// device with an empty MAC table) gets an empty array, not a missing entry.
function computeVlanCache(topology) {
  var result = new Map();
  topology.forEach(function (device) {
    if (!device || !device.DeviceIP) return;
    result.set(String(device.DeviceIP), device.TrueClients ? device.TrueClients.map(function (c) { return String(c.VLAN_Tag); }) : []);
  });
  return result;
}

function computeNeighborEdges(topology) {
  var edges = [];
  var seen = new Set();

  topology.forEach(function (device) {
    if (!device || !device.DeviceIP || !device.Neighbors) return;
    var switchIp = String(device.DeviceIP);
    device.Neighbors.forEach(function (neighbor) {
      var neighborIp = String(neighbor.ManagementIP);
      if (!neighborIp || neighborIp === 'Unknown' || neighborIp === '0.0.0.0') return;
      var edgeKey = [switchIp, neighborIp].sort().join('-');
      if (seen.has(edgeKey)) return;
      seen.add(edgeKey);
      edges.push({ from: switchIp, to: neighborIp });
    });
  });

  return edges;
}

// Dual-mode export: node:test imports this file via ESM `import {...}` syntax, which
// Node resolves against `module.exports` here through its built-in CJS/ESM interop. The
// browser loads this same file as a classic <script>, where `module` doesn't exist, so it
// attaches to `window.TopologyGraph` instead (see graph-layout.js for the same pattern).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeDeviceClassification: computeDeviceClassification, computeNeighborEdges: computeNeighborEdges, computeVlanCache: computeVlanCache };
} else if (typeof window !== 'undefined') {
    window.TopologyGraph = { computeDeviceClassification: computeDeviceClassification, computeNeighborEdges: computeNeighborEdges, computeVlanCache: computeVlanCache };
}
