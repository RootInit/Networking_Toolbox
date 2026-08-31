// Pure device-classification/edge extraction shared by graph.js (diagram) and map.js
// (geo view), so both views classify devices identically. No DOM, no vis-network, no Leaflet.

// Local copy of utils.js's window.asArray - this file also runs under plain Node (see the
// dual-mode export below), where window.asArray doesn't exist. PowerShell's ConvertTo-Json
// serializes a single-element array as a bare object, so device.Neighbors/TrueClients with
// exactly one entry arrive as {..} instead of [{..}] and must be normalized before .forEach/.map.
function asArray(val) {
  if (Array.isArray(val)) return val;
  if (val === null || val === undefined) return [];
  return [val];
}

function computeDeviceClassification(topology) {
  var result = new Map();

  // Pass 1: scanned devices always win over a later placeholder for the same IP.
  topology.forEach(function (device) {
    if (!device || !device.DeviceIP) return;
    var isStack = !!(device.StackMembers && device.StackMembers.length > 1);
    result.set(String(device.DeviceIP), {
      scanned: true, isStack: isStack, hostname: device.Hostname || 'Unknown',
    });
  });

  // Pass 2: unscanned LLDP neighbors get a placeholder entry.
  topology.forEach(function (device) {
    if (!device || !device.DeviceIP || !device.Neighbors) return;
    asArray(device.Neighbors).forEach(function (neighbor) {
      var neighborIp = String(neighbor.ManagementIP);
      if (!neighborIp || neighborIp === 'Unknown' || neighborIp === '0.0.0.0') return;
      if (!result.has(neighborIp)) {
        result.set(neighborIp, { scanned: false, isStack: false, hostname: neighbor.Hostname || 'Unknown' });
      }
    });
  });

  return result;
}

// Per-device VLAN tags from local clients (MAC table), keyed by DeviceIP; shared by
// graph.js and map.js. A device with no TrueClients gets an empty array, not a missing entry.
function computeVlanCache(topology) {
  var result = new Map();
  topology.forEach(function (device) {
    if (!device || !device.DeviceIP) return;
    result.set(String(device.DeviceIP), device.TrueClients ? asArray(device.TrueClients).map(function (c) { return String(c.VLAN_Tag); }) : []);
  });
  return result;
}

function computeNeighborEdges(topology) {
  var edges = [];
  var seen = new Set();

  topology.forEach(function (device) {
    if (!device || !device.DeviceIP || !device.Neighbors) return;
    var switchIp = String(device.DeviceIP);
    asArray(device.Neighbors).forEach(function (neighbor) {
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

// Dual-mode export: node:test (CJS/ESM interop) vs. browser <script> (no `module`).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeDeviceClassification: computeDeviceClassification, computeNeighborEdges: computeNeighborEdges, computeVlanCache: computeVlanCache };
} else if (typeof window !== 'undefined') {
    window.TopologyGraph = { computeDeviceClassification: computeDeviceClassification, computeNeighborEdges: computeNeighborEdges, computeVlanCache: computeVlanCache };
}
