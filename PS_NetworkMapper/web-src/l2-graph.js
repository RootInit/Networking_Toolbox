// Section 5. A port-level L2 graph, parallel to the diagram's edge set and not a replacement for it.
//
// computeNeighborEdges in topology-graph.js dedups on a sorted IP pair and keeps only {from,to}: it
// loses the port names and collapses a four-member LAG to one unlabelled edge. That is the right shape
// for drawing and the wrong one for deciding whether a frame can cross a link, so this builds a second
// graph and leaves that one alone.
//
// Two collections come out, and the distinction is load-bearing: an EDGE joins two devices in the
// snapshot and may be traversed; a TERMINAL is a port where the topology ends - the far side is a
// device we never scanned, one outside our scopes, an address-less bridge, or an unmanaged segment we
// only inferred. A terminal is never an edge, because the four cases have four different answers and
// chaining two of them would invent a link (section 7, F14).
//
// No DOM, no window: this file also runs under Node in the test suite.

// utils.js's window.normalizePort is browser-only, as topology-graph.js's local asArray is.
function stripUnit(port) {
    return String(port === null || port === undefined ? '' : port).replace(/\.\d+$/, '');
}

function asList(value) {
    if (Array.isArray(value)) return value.filter(function (item) { return item !== null && item !== undefined; });
    if (value === null || value === undefined) return [];
    return [value];
}

// The worker's own exclusion (Get-JunosNodeData.ps1: $InterconnectPortPattern). A VC's fabric links and
// the management interfaces never carry an LLDP neighbour and are never a hop.
var INTERCONNECT_RE = /^(?:vcp|bme|reth|me|vme)/;

function isInterconnect(port) {
    return INTERCONNECT_RE.test(stripUnit(port));
}

// Section 5.3. LLDP runs on the members of an aggregate, so a bundle yields one half-edge per member.
// The edge is keyed on the bundle because the spanning-tree rows exist only on aeN - an edge keyed on a
// member port carries no StpDetail at all and every LAG hop would read as unevaluated forever.
function portIndexFor(device) {
    var rows = new Map();
    var bundleOf = new Map();
    asList(device.Interfaces).forEach(function (row) {
        rows.set(row.Port, row);
        if (row.Bundle) bundleOf.set(row.Port, row.Bundle);
    });
    return { rows: rows, bundleOf: bundleOf };
}

function transitPortsFor(device, index) {
    // The predicate the worker uses to keep uplink MACs out of Clients: a port facing a switch or
    // router LLDP neighbour, plus the bundle it belongs to. Kept identical here so the two sides agree
    // on which ports are transit - a MAC seen on one of these is a sighting in passing, not a location.
    var transit = new Set();
    asList(device.Neighbors).forEach(function (neighbor) {
        var port = stripUnit(neighbor.LocalPort);
        transit.add(port);
        var bundle = index.bundleOf.get(port);
        if (bundle) transit.add(bundle);
    });
    return transit;
}

function stpEndFor(device, row) {
    // StpDetail {} means two different things and item 10 has to tell them apart: the section arrived
    // and no instance covers this port (NO_STP_INSTANCE, section 2.3), or the section never arrived at
    // all (NOT_EVALUATED, section 3.2). Only SectionsCaptured distinguishes them.
    var captured = asList(device.SectionsCaptured).indexOf('STP') !== -1;
    var scopes = {};
    if (row && row.StpDetail) {
        Object.keys(row.StpDetail).forEach(function (scope) { scopes[scope] = row.StpDetail[scope]; });
    }
    return { scopes: scopes, captured: captured, collapsed: row ? row.STP : null };
}

// Same absent-versus-empty distinction stpEndFor draws, for the same reason: section 6.2 filters a hop on
// VLAN membership first, and a port with no members because the VLANS section never arrived
// (VLAN_UNKNOWN) is not a port the VLAN is genuinely absent from (VLAN_ABSENT, F11).
function vlanEndFor(device, row) {
    return {
        members: vlanMembersFor(row),
        captured: asList(device.SectionsCaptured).indexOf('VLANS') !== -1,
    };
}

function vlanMembersFor(row) {
    return asList(row && row.Vlans).map(function (entry) {
        // Pre-C4 snapshots and hand-built inputs can carry a bare VLAN name; keep the shape uniform.
        if (entry && typeof entry === 'object') return { Name: entry.Name, Tag: entry.Tag, Unit: entry.Unit, Active: entry.Active };
        return { Name: entry, Tag: null, Unit: null, Active: null };
    });
}

function endFor(device, index, port, memberPorts) {
    var row = index.rows.get(port) || null;
    // The bundle's own member list, not only the members that carried an LLDP neighbour: a member whose
    // link is down stops advertising, and reporting the aggregate as narrower than it is hides exactly
    // the capacity loss that makes a half-down LAG worth noticing (section 5.3).
    var ports = memberPorts.slice();
    asList(row && row.BundleMembers).forEach(function (memberPort) {
        if (ports.indexOf(memberPort) === -1) ports.push(memberPort);
    });
    ports.sort();
    var members = ports.map(function (memberPort) {
        var memberRow = index.rows.get(memberPort) || null;
        return {
            port: memberPort,
            link: memberRow ? memberRow.Link : null,
            admin: memberRow ? memberRow.Admin : null,
        };
    });
    return {
        ip: String(device.DeviceIP), hostname: device.Hostname, port: port,
        desc: row ? row.Desc : null,
        link: row ? row.Link : null,
        members: members,
        vlans: vlanEndFor(device, row),
        stp: stpEndFor(device, row),
        scanStatus: device.ScanStatus,
    };
}

// One end for a port that is not on an edge - an access port an endpoint resolved to. Same shape and
// same absent-versus-empty rules as the halves above, so section 6.2 can filter on it with the
// predicates it already uses rather than a second, subtly different reading of the same row.
function portEndFor(device, port) {
    if (!device) return null;
    var bare = stripUnit(port);
    var index = portIndexFor(device);
    if (!index.rows.has(bare)) return null;
    return endFor(device, index, bare, []);
}

function ipToLong(text) {
    var parts = String(text === null || text === undefined ? '' : text).split('.');
    if (parts.length !== 4) return null;
    var value = 0;
    for (var i = 0; i < 4; i++) {
        var octet = Number(parts[i]);
        if (!isFinite(octet) || octet < 0 || octet > 255 || parts[i] === '') return null;
        value = (value * 256) + octet;
    }
    return value;
}

// Shared by the L3 rules and by section 6.4's gateway candidates, so the two cannot disagree about
// which addresses a configured prefix contains.
function cidrContains(cidr, ip) {
    var parts = String(cidr === null || cidr === undefined ? '' : cidr).split('/');
    var network = ipToLong(parts[0]);
    var address = ipToLong(ip);
    // NaN, not null: isFinite(null) is true, so a bare address with no prefix would otherwise be read as
    // a /0 and swallow every address in the fleet.
    var bits = parts.length === 2 && parts[1] !== '' ? Number(parts[1]) : NaN;
    if (network === null || address === null || !isFinite(bits) || bits < 0 || bits > 32) return null;
    if (bits === 0) return true;
    // ToInt32 on both sides of the & is consistent, so a /8 network above 127.x compares correctly.
    var mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
    return ((network & mask) >>> 0) === ((address & mask) >>> 0);
}

// The VRRP virtual-MAC prefix: 00:00:5e:00:01:<VRID> (G3). No rule fires on one - a VIP on a trunk is
// how VRRP is supposed to look - so the only consumer is section 6.4's gateway report.
var VRRP_MAC_PREFIX = '00:00:5E:00:01:';

function vridOf(mac) {
    var text = String(mac === null || mac === undefined ? '' : mac).toUpperCase();
    return text.indexOf(VRRP_MAC_PREFIX) === 0 ? parseInt(text.slice(VRRP_MAC_PREFIX.length), 16) : null;
}

function inScope(ip, allowedScopes) {
    if (!allowedScopes || !allowedScopes.length) return null;   // undecidable without them
    for (var i = 0; i < allowedScopes.length; i++) {
        if (String(ip).indexOf(String(allowedScopes[i])) === 0) return true;
    }
    return false;
}

// Chassis-ID confirmation, section 5.2's second tier, with the one adjustment the data forces: no node
// field carries a device's OWN chassis MAC (show chassis hardware has no MAC line), so the only
// available form is agreement between other devices' LLDP about one management address. Two distinct
// reporters agreeing is corroboration from third parties - it is not the far end confirming, which is
// why `reciprocal` stays a separate field rather than being folded into this one.
function chassisConsensus(topology) {
    var reporters = new Map();   // peer ip -> Map(mac -> Set(reporter ip))
    topology.forEach(function (device) {
        asList(device.Neighbors).forEach(function (neighbor) {
            var ip = String(neighbor.ManagementIP);
            if (!ip || ip === 'Unknown') return;
            if (!neighbor.MacAddress || neighbor.MacAddress === 'Unknown') return;
            var mac = String(neighbor.MacAddress).toUpperCase();
            if (!reporters.has(ip)) reporters.set(ip, new Map());
            var byMac = reporters.get(ip);
            if (!byMac.has(mac)) byMac.set(mac, new Set());
            byMac.get(mac).add(String(device.DeviceIP));
        });
    });
    var consensus = new Map();
    reporters.forEach(function (byMac, ip) {
        var agreed = null;
        byMac.forEach(function (who, mac) {
            if (who.size < 2) return;
            // Two camps of reporters each naming a different chassis for one address is the absence of
            // consensus, not the later camp winning.
            agreed = agreed === null ? mac : false;
        });
        if (agreed) consensus.set(ip, agreed);
    });
    return consensus;
}

// A device that captured at least one section answered for itself; one that captured none exists only
// because a neighbour named it.
function selfReported(device) {
    return asList(device.SectionsCaptured).length > 0;
}

function buildPortGraph(topology, options) {
    var devices = asList(topology);
    var opts = options || {};
    var allowedScopes = opts.allowedScopes || null;
    var byIp = new Map();
    devices.forEach(function (device) { byIp.set(String(device.DeviceIP), device); });
    var indexes = new Map();
    devices.forEach(function (device) { indexes.set(String(device.DeviceIP), portIndexFor(device)); });
    var consensus = chassisConsensus(devices);

    var halves = [];       // one per LLDP neighbour that names a device in this snapshot
    var terminals = [];

    devices.forEach(function (device) {
        var ip = String(device.DeviceIP);
        var index = indexes.get(ip);
        asList(device.Neighbors).forEach(function (neighbor) {
            var localPort = stripUnit(neighbor.LocalPort);
            if (isInterconnect(localPort)) return;
            var bundle = index.bundleOf.get(localPort);
            var edgePort = bundle || localPort;
            var peerIp = String(neighbor.ManagementIP);
            var addressless = !peerIp || peerIp === 'Unknown';

            if (addressless) {
                // R5: a bridge that advertises Bridge capability with no management address. Two of
                // these sharing a MAC are one unmanaged bridge, and the two ports facing it are a
                // shared segment - which is not a link (F14).
                terminals.push({
                    kind: 'addressless-bridge', ip: ip, port: edgePort, memberPort: localPort,
                    mac: neighbor.MacAddress ? String(neighbor.MacAddress).toUpperCase() : null,
                    remotePort: neighbor.RemotePort, description: neighbor.Description,
                    reachable: neighbor.Reachable === false ? false : null,
                });
                return;
            }

            var peer = byIp.get(peerIp);
            if (!peer) {
                var scoped = inScope(peerIp, allowedScopes);
                terminals.push({
                    // Out of scope and never scanned are different facts with different answers, and
                    // without allowedScopes they are indistinguishable - so say which one it is only
                    // when the caller supplied them. The crawler knows the real reason and logs it to
                    // the debug file only (FleetCrawl.ps1); closing that is a worker-side change.
                    kind: scoped === false ? 'out-of-scope' : 'unscanned',
                    ip: ip, port: edgePort, memberPort: localPort,
                    farIp: peerIp, farHostname: neighbor.Hostname,
                    mac: neighbor.MacAddress ? String(neighbor.MacAddress).toUpperCase() : null,
                    remotePort: neighbor.RemotePort,
                    scopesKnown: !!(allowedScopes && allowedScopes.length),
                });
                return;
            }

            var peerIndex = indexes.get(peerIp);
            var remotePort = stripUnit(neighbor.RemotePort);
            var remoteBundle = peerIndex.bundleOf.get(remotePort);
            halves.push({
                ip: ip, port: edgePort, memberPort: localPort,
                peerIp: peerIp, peerPort: remoteBundle || remotePort, peerMemberPort: remotePort,
                mac: neighbor.MacAddress ? String(neighbor.MacAddress).toUpperCase() : null,
                hostname: neighbor.Hostname,
            });
        });
    });

    // Keyed on the collapsed port pair, so a LAG's members land on one edge.
    var edgesByKey = new Map();
    halves.forEach(function (half) {
        var mine = half.ip + '|' + half.port;
        var theirs = half.peerIp + '|' + half.peerPort;
        var key = [mine, theirs].sort().join('~');
        if (!edgesByKey.has(key)) edgesByKey.set(key, { key: key, halves: [] });
        edgesByKey.get(key).halves.push(half);
    });

    var edges = [];
    edgesByKey.forEach(function (bucket) {
        var first = bucket.halves[0];
        var aIp = first.ip;
        var aPort = first.port;
        var bIp = first.peerIp;
        var bPort = first.peerPort;
        var aMembers = [];
        var bMembers = [];
        var sawFromA = false;
        var sawFromB = false;
        bucket.halves.forEach(function (half) {
            if (half.ip === aIp && half.port === aPort) {
                sawFromA = true;
                if (aMembers.indexOf(half.memberPort) === -1) aMembers.push(half.memberPort);
                if (bMembers.indexOf(half.peerMemberPort) === -1) bMembers.push(half.peerMemberPort);
            } else {
                sawFromB = true;
                if (bMembers.indexOf(half.memberPort) === -1) bMembers.push(half.memberPort);
                if (aMembers.indexOf(half.peerMemberPort) === -1) aMembers.push(half.peerMemberPort);
            }
        });
        aMembers.sort();
        bMembers.sort();

        var aDevice = byIp.get(aIp);
        var bDevice = byIp.get(bIp);
        var reciprocal = sawFromA && sawFromB;
        var confirmation = 'unconfirmed';
        if (reciprocal) {
            confirmation = 'reciprocal';
        } else {
            var reporterHalf = sawFromA ? first : bucket.halves[0];
            var farIp = sawFromA ? bIp : aIp;
            var far = byIp.get(farIp);
            if (reporterHalf.mac && consensus.get(farIp) === reporterHalf.mac) {
                confirmation = 'chassis-consensus';
            } else if (reporterHalf.hostname && far && selfReported(far)
                       && reporterHalf.hostname === far.Hostname) {
                // Only a device that answered for itself can confirm its own name. A node that captured
                // nothing is a placeholder whose Hostname was filled in by whoever enqueued it, so
                // matching against it would compare the reporter's datum to a copy of itself.
                confirmation = 'hostname';
            }
        }

        edges.push({
            key: bucket.key, kind: 'link',
            a: endFor(aDevice, indexes.get(aIp), aPort, aMembers),
            b: endFor(bDevice, indexes.get(bIp), bPort, bMembers),
            reciprocal: reciprocal,
            confirmation: confirmation,
        });
    });
    edges.sort(function (x, y) { return x.key < y.key ? -1 : x.key > y.key ? 1 : 0; });

    // Section 5.3's fourth fleet-edge case: a port with several client MACs behind it, no MED endpoint
    // and no LLDP neighbour at all is an unmanaged switch nobody recorded. Reported, never traversed.
    devices.forEach(function (device) {
        var ip = String(device.DeviceIP);
        var index = indexes.get(ip);
        var transit = transitPortsFor(device, index);
        var medPorts = new Set(asList(device.MedNeighbors).map(function (m) { return stripUnit(m.LocalPort); }));
        var macsByPort = new Map();
        asList(device.MacTable).forEach(function (row) {
            var port = row.PhysicalPort ? String(row.PhysicalPort) : stripUnit(row.Interface);
            if (!port || isInterconnect(port)) return;
            if (!macsByPort.has(port)) macsByPort.set(port, new Set());
            macsByPort.get(port).add(String(row.MacAddress).toUpperCase());
        });
        macsByPort.forEach(function (macs, port) {
            if (macs.size < 3) return;
            if (transit.has(port) || medPorts.has(port)) return;
            terminals.push({
                kind: 'inferred-segment', ip: ip, port: port, memberPort: port,
                macCount: macs.size, macs: Array.from(macs).sort(),
            });
        });
    });
    terminals.sort(function (x, y) {
        var left = x.kind + '|' + x.ip + '|' + x.port;
        var right = y.kind + '|' + y.ip + '|' + y.port;
        return left < right ? -1 : left > right ? 1 : 0;
    });

    return {
        edges: edges,
        terminals: terminals,
        deviceByIp: byIp,
        // Which ports carry transit rather than endpoints, per device: endpoint resolution needs the
        // same predicate to tell a client's location from a sighting in passing (R3, F4).
        transitPorts: new Map(devices.map(function (device) {
            var ip = String(device.DeviceIP);
            return [ip, transitPortsFor(device, indexes.get(ip))];
        })),
    };
}

// Two ports facing one address-less bridge are a shared segment. Grouping them is how F14 gets
// reported without ever becoming an edge.
function groupSharedSegments(graph) {
    var byMac = new Map();
    graph.terminals.forEach(function (terminal) {
        if (terminal.kind !== 'addressless-bridge' || !terminal.mac) return;
        if (!byMac.has(terminal.mac)) byMac.set(terminal.mac, []);
        byMac.get(terminal.mac).push(terminal);
    });
    var segments = [];
    byMac.forEach(function (ends, mac) {
        if (ends.length < 2) return;
        segments.push({ mac: mac, ends: ends.slice().sort(function (x, y) { return x.ip < y.ip ? -1 : 1; }) });
    });
    return segments.sort(function (x, y) { return x.mac < y.mac ? -1 : 1; });
}

function edgesFor(graph, ip) {
    return graph.edges.filter(function (edge) { return edge.a.ip === String(ip) || edge.b.ip === String(ip); });
}

var L2Graph = {
    buildPortGraph: buildPortGraph,
    groupSharedSegments: groupSharedSegments,
    edgesFor: edgesFor,
    portEndFor: portEndFor,
    stripUnit: stripUnit,
    isInterconnect: isInterconnect,
    ipToLong: ipToLong,
    cidrContains: cidrContains,
    vridOf: vridOf,
    VRRP_MAC_PREFIX: VRRP_MAC_PREFIX,
};

// Dual-mode export: node:test (CJS/ESM interop) vs. browser <script> (no `module`).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = L2Graph;
} else if (typeof window !== 'undefined') {
    window.L2Graph = L2Graph;
}
