// Pure device-classification/edge extraction shared by graph.js (diagram) and map.js
// (geo view), so both views classify devices identically. No DOM, no vis-network, no Leaflet.

// Local copy of utils.js's window.asArray (see it for the reason) - this file also runs
// under plain Node, where window doesn't exist.
function asArray(val) {
  if (Array.isArray(val)) return val.filter(function (item) { return item !== null && item !== undefined; });
  if (val === null || val === undefined) return [];
  return [val];
}

function computeDeviceClassification(topology) {
  var result = new Map();

  // Two passes so a scanned device always wins over a neighbor placeholder for the same IP.
  topology.forEach(function (device) {
    if (!device || !device.DeviceIP) return;
    var isStack = !!(device.StackMembers && device.StackMembers.length > 1);
    result.set(String(device.DeviceIP), {
      scanned: true, isStack: isStack, hostname: device.Hostname || 'Unknown',
    });
  });

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

// Per-device VLAN tags from the MAC table, keyed by DeviceIP. A device with no TrueClients
// gets an empty array, not a missing entry.
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

// Topology -> per-node {label, shape, isStack, scanned, vlanCache} keyed by IP. Kept out of
// graph.js's buildSwitchMap so the node-construction rules have one implementation shared by
// the real caller and its test; buildSwitchMap keeps the vis-network-specific pieces this
// function deliberately has no dependency on.
function buildSwitchMapNodeMeta(topology) {
  var allNodeMeta = new Map();
  var classification = computeDeviceClassification(topology);
  var deviceByIpLocal = new Map(topology.filter(function (d) { return d && d.DeviceIP; }).map(function (d) { return [String(d.DeviceIP), d]; }));
  var vlanCacheByIp = computeVlanCache(topology);

  classification.forEach(function (meta, ip) {
    var device = deviceByIpLocal.get(ip);
    var stackIcon = meta.isStack ? `\n[VC: ${device.StackMembers.length} Node]` : '';
    allNodeMeta.set(ip, {
      label: meta.scanned ? `Switch\n${ip}\n(${meta.hostname})${stackIcon}` : `Switch\n${ip}\n(${meta.hostname})`,
      shape: meta.isStack ? 'database' : 'box', isStack: meta.isStack, scanned: meta.scanned,
      vlanCache: vlanCacheByIp.get(ip) || [],
    });
  });

  return allNodeMeta;
}

// Dual-mode export: node:test (CJS/ESM interop) vs. browser <script> (no `module`).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeDeviceClassification: computeDeviceClassification, computeNeighborEdges: computeNeighborEdges, computeVlanCache: computeVlanCache, buildSwitchMapNodeMeta: buildSwitchMapNodeMeta };
} else if (typeof window !== 'undefined') {
    window.TopologyGraph = { computeDeviceClassification: computeDeviceClassification, computeNeighborEdges: computeNeighborEdges, computeVlanCache: computeVlanCache, buildSwitchMapNodeMeta: buildSwitchMapNodeMeta };
}
