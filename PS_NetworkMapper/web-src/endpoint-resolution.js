// Section 6.1. Turning whatever an operator typed into a place on the network - separate from path
// computation, and separately tested, because most of the ways this goes wrong are ambiguities rather
// than failures.
//
// Every ambiguity is an outcome, never a pick: one MAC on two devices' access ports is a genuinely
// unanswerable question, an address claimed by two MACs is the same, and a port description in this
// fleet is deliberately not unique. A resolver that returned its first hit would be wrong far more
// often than it would be useful.
//
// The other half of the job is telling a location from a sighting. A switch learns every MAC it
// forwards, so the MAC of a host three closets away is in the uplink's table too (R3, F4). Those rows
// are transit, and the predicate that says so is the worker's own, taken from l2-graph.js so the two
// sides cannot drift apart.
//
// No DOM, no window: this file also runs under Node in the test suite.

var L2 = (typeof module !== 'undefined' && module.exports)
    ? require('./l2-graph.js')
    : (typeof window !== 'undefined' ? window.L2Graph : null);

function asList(value) {
    if (Array.isArray(value)) return value.filter(function (item) { return item !== null && item !== undefined; });
    if (value === null || value === undefined) return [];
    return [value];
}

var IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
var MAC_RE = /^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;
var PORT_RE = /^(?:ge|xe|et|ae|mge|vcp|irb|vme|me|bme|reth)[\w\/\-.]*$/;

function normalizeMac(value) {
    return String(value).replace(/-/g, ':').toUpperCase();
}

function stripUnit(port) {
    return String(port === null || port === undefined ? '' : port).replace(/\.\d+$/, '');
}

// A device whose scan failed can be a waypoint on a path and can never be an endpoint: there is no
// capture in which to sight anything. Partial is the dangerous one - it carries real data, so a naive
// reader treats it as complete (FleetCrawl.ps1 preserves partial data over a placeholder on purpose).
function deviceNote(device) {
    if (!device) return null;
    if (device.ScanStatus === 'Ok') return null;
    if (device.ScanStatus === 'Partial') return 'device-scan-partial';
    return 'device-scan-failed';
}

function createResolver(topology, options) {
    var devices = asList(topology);
    var opts = options || {};
    var graph = opts.graph || (L2 ? L2.buildPortGraph(devices, { allowedScopes: opts.allowedScopes }) : null);
    var transitPorts = graph ? graph.transitPorts : new Map();

    var byManagementIp = new Map();
    var byHostname = new Map();       // lower-cased; a hostname is not guaranteed unique
    var bySerial = new Map();
    devices.forEach(function (device) {
        byManagementIp.set(String(device.DeviceIP), device);
        var host = String(device.Hostname || '').toLowerCase();
        if (host && host !== 'unknown') {
            if (!byHostname.has(host)) byHostname.set(host, []);
            byHostname.get(host).push(device);
            var short = host.split('.')[0];
            if (short !== host) {
                if (!byHostname.has(short)) byHostname.set(short, []);
                byHostname.get(short).push(device);
            }
        }
        asList(device.StackMembers).forEach(function (member) {
            if (!member.Serial || member.Serial === 'Unknown') return;
            var serial = String(member.Serial).toUpperCase();
            if (!bySerial.has(serial)) bySerial.set(serial, []);
            bySerial.get(serial).push({ device: device, member: member });
        });
    });

    function transitFor(device) {
        return transitPorts.get(String(device.DeviceIP)) || new Set();
    }

    function clientMatch(device, client, via) {
        var port = stripUnit(client.Port);
        return {
            type: 'client', via: via,
            deviceIp: String(device.DeviceIP), hostname: device.Hostname, port: port,
            mac: client.MAC || null, macKey: client.MAC ? normalizeMac(client.MAC) : null,
            ip: client.IP && client.IP !== 'Unknown' ? client.IP : null,
            vlanName: client.VLAN_Name === undefined ? null : client.VLAN_Name,
            vlanTag: client.VLAN_Tag === undefined ? null : client.VLAN_Tag,
            dot1xUser: client.Dot1x_User === undefined ? null : client.Dot1x_User,
            dot1xState: client.Dot1x_State === undefined ? null : client.Dot1x_State,
            transit: false, scanStatus: device.ScanStatus,
        };
    }

    function deviceMatch(device, via, extra) {
        var match = {
            type: 'device', via: via,
            deviceIp: String(device.DeviceIP), hostname: device.Hostname, port: null,
            mac: null, macKey: null, ip: String(device.DeviceIP), transit: false, scanStatus: device.ScanStatus,
        };
        if (extra) Object.keys(extra).forEach(function (key) { match[key] = extra[key]; });
        return match;
    }

    // MAC-table rows the client list does not cover: transit sightings, and the second port of a MAC
    // learned twice on one device - which Clients silently collapses by last-wins (R3).
    function macTableMatches(mac, out, notes) {
        devices.forEach(function (device) {
            var transit = transitFor(device);
            var seenPorts = new Set();
            asList(device.MacTable).forEach(function (row) {
                if (normalizeMac(row.MacAddress) !== mac) return;
                var port = row.PhysicalPort ? String(row.PhysicalPort) : stripUnit(row.Interface);
                if (seenPorts.has(port)) return;
                seenPorts.add(port);
                out.push({
                    type: 'client', via: 'mac-table',
                    deviceIp: String(device.DeviceIP), hostname: device.Hostname, port: port,
                    mac: row.MacAddress, macKey: mac, ip: null,
                    vlanName: row.VlanName === undefined ? null : row.VlanName,
                    vlanTag: null,
                    transit: transit.has(port), scanStatus: device.ScanStatus,
                });
            });
            if (seenPorts.size > 1) {
                var accessPorts = Array.from(seenPorts).filter(function (port) { return !transit.has(port); });
                if (accessPorts.length > 1) notes.push('mac-on-two-ports-of-' + device.DeviceIP);
            }
        });
    }

    function byMac(rawMac, notes) {
        var mac = normalizeMac(rawMac);
        var out = [];
        devices.forEach(function (device) {
            asList(device.Clients).forEach(function (client) {
                if (normalizeMac(client.MAC) === mac) out.push(clientMatch(device, client, 'clients'));
            });
            asList(device.MedNeighbors).forEach(function (med) {
                if (!med.MacAddress || normalizeMac(med.MacAddress) !== mac) return;
                out.push({
                    type: 'med-endpoint', via: 'med', deviceIp: String(device.DeviceIP),
                    hostname: med.Hostname, port: stripUnit(med.LocalPort),
                    mac: med.MacAddress, macKey: mac,
                    ip: med.ManagementIP && med.ManagementIP !== 'Unknown' ? med.ManagementIP : null,
                    description: med.Description, transit: false, scanStatus: device.ScanStatus,
                });
            });
        });
        macTableMatches(mac, out, notes);
        return out;
    }

    function byClientIp(ip, notes, claimants) {
        var macs = claimants;
        var out = [];
        devices.forEach(function (device) {
            asList(device.Clients).forEach(function (client) {
                if (client.IP === ip) { out.push(clientMatch(device, client, 'clients')); macs.add(normalizeMac(client.MAC)); }
            });
            asList(device.ArpEntries).forEach(function (entry) {
                if (entry.IP === ip && entry.MAC) macs.add(normalizeMac(entry.MAC));
            });
            asList(device.MedNeighbors).forEach(function (med) {
                if (med.ManagementIP === ip && med.MacAddress) macs.add(normalizeMac(med.MacAddress));
            });
        });
        if (macs.size > 1) notes.push('ip-claimed-by-' + macs.size + '-macs');
        // Reported even when a claimant has no sighting anywhere: an ARP entry with no MAC-table row is
        // how the second claimant of a contested address usually appears, and dropping it would leave
        // the ambiguity in the notes with nothing to name.
        macs.forEach(function (mac) {
            byMac(mac, notes).forEach(function (match) { out.push(match); });
        });
        return out;
    }

    function byDot1xUser(user, notes) {
        var needle = String(user).toLowerCase();
        var out = [];
        devices.forEach(function (device) {
            asList(device.Clients).forEach(function (client) {
                var name = String(client.Dot1x_User || '').toLowerCase();
                if (!name || name === 'unknown') return;
                if (name === needle || name.split('\\').pop() === needle) out.push(clientMatch(device, client, 'dot1x'));
            });
        });
        return out;
    }

    // An LLDP-MED endpoint's system name: an exact identifier, unlike the free-text port label below.
    function byMedHostname(text) {
        var needle = String(text).toLowerCase();
        var out = [];
        devices.forEach(function (device) {
            asList(device.MedNeighbors).forEach(function (med) {
                if (String(med.Hostname || '').toLowerCase() !== needle) return;
                out.push({
                    type: 'med-endpoint', via: 'med', deviceIp: String(device.DeviceIP),
                    hostname: med.Hostname, port: stripUnit(med.LocalPort),
                    mac: med.MacAddress || null,
                    macKey: med.MacAddress ? normalizeMac(med.MacAddress) : null,
                    ip: med.ManagementIP && med.ManagementIP !== 'Unknown' ? med.ManagementIP : null,
                    description: med.Description, transit: false, scanStatus: device.ScanStatus,
                });
            });
        });
        return out;
    }

    // Free text against port labels, and deliberately non-unique in this fleet: AP-1000 and PHONE-2000
    // are reused across closets, which is exactly the AMBIGUOUS case an operator typing a label off a
    // faceplate needs to be told about. A substring hit is the weakest kind of match there is, so it is
    // only consulted when nothing identified the query exactly - otherwise resolving a switch by
    // hostname would come back ambiguous with every uplink labelled "UPLINK to <that hostname>".
    function byDescription(text) {
        var needle = String(text).toLowerCase();
        var out = [];
        devices.forEach(function (device) {
            asList(device.Interfaces).forEach(function (row) {
                var desc = String(row.Desc || '');
                if (!desc || desc === 'Unknown') return;
                if (desc.toLowerCase().indexOf(needle) === -1) return;
                out.push({
                    type: 'port', via: 'description', deviceIp: String(device.DeviceIP),
                    hostname: device.Hostname, port: row.Port, mac: null, macKey: null, ip: null,
                    description: desc, transit: transitFor(device).has(row.Port), scanStatus: device.ScanStatus,
                });
            });
        });
        return out;
    }

    function bySwitchAndPort(deviceText, portText) {
        var device = byManagementIp.get(deviceText)
            || (byHostname.get(String(deviceText).toLowerCase()) || [])[0];
        if (!device) return [];
        var port = stripUnit(portText);
        var row = asList(device.Interfaces).find(function (candidate) { return candidate.Port === port; });
        if (!row) return [];
        return [{
            type: 'port', via: 'switch-port', deviceIp: String(device.DeviceIP), hostname: device.Hostname,
            port: row.Port, mac: null, macKey: null, ip: null, description: row.Desc,
            transit: transitFor(device).has(row.Port), scanStatus: device.ScanStatus,
        }];
    }

    function dedupe(matches) {
        var seen = new Set();
        var out = [];
        matches.forEach(function (match) {
            var key = [match.type, match.via, match.deviceIp, match.port, match.macKey, match.ip].join('|');
            if (seen.has(key)) return;
            seen.add(key);
            out.push(match);
        });
        return out;
    }

    // One location is one (device, port) pair, however many rows in however many tables named it: a
    // client that also appears in the MAC table of the switch it is plugged into is one endpoint, not
    // two. Ambiguity is about places, not evidence.
    function locationsOf(matches) {
        var places = new Set();
        matches.forEach(function (match) {
            // Only a MAC sighting can be "in passing". A port named directly is a place whatever crosses
            // it - including a port facing an address-less bridge, which is transit AND a real location.
            if (match.transit && match.type === 'client') return;
            places.add(match.deviceIp + '|' + (match.port === null ? '' : match.port));
        });
        return places;
    }

    function resolve(query, hint) {
        var text = String(query === null || query === undefined ? '' : query).trim();
        var notes = [];
        var interpretations = [];
        var matches = [];
        var claimants = new Set();   // MACs claiming the queried address, sighted or not
        var type = hint || null;

        var switchPort = text.match(/^(\S+)\s*[\s,+]\s*(\S+)$/);
        if (!type && switchPort && PORT_RE.test(switchPort[2])) type = 'switch-port';
        if (!type && MAC_RE.test(text)) type = 'mac';
        if (!type && IPV4_RE.test(text)) type = 'ip';

        if (type === 'switch-port') {
            interpretations.push('switch-port');
            matches = matches.concat(bySwitchAndPort(switchPort[1], switchPort[2]));
        } else if (type === 'mac') {
            interpretations.push('client-mac');
            matches = matches.concat(byMac(text, notes));
        } else if (type === 'ip') {
            // An address can be a switch's own or a client's, and which one it is cannot be decided
            // from the string, so both are tried and both are reported.
            interpretations.push('management-ip', 'client-ip');
            var device = byManagementIp.get(text);
            if (device) matches.push(deviceMatch(device, 'management-ip'));
            matches = matches.concat(byClientIp(text, notes, claimants));
        } else {
            var lower = text.toLowerCase();
            var upper = text.toUpperCase();
            interpretations.push('hostname', 'serial', 'dot1x-user', 'med-hostname');
            (byHostname.get(lower) || []).forEach(function (hit) { matches.push(deviceMatch(hit, 'hostname')); });
            (bySerial.get(upper) || []).forEach(function (hit) {
                matches.push(deviceMatch(hit.device, 'serial', { fpc: hit.member.FPC, model: hit.member.Model }));
            });
            matches = matches.concat(byDot1xUser(text, notes));
            matches = matches.concat(byMedHostname(text));
            if (!matches.length) {
                interpretations.push('description');
                matches = matches.concat(byDescription(text));
            }
        }

        matches = dedupe(matches);
        matches.forEach(function (match) {
            var note = deviceNote(byManagementIp.get(match.deviceIp));
            if (note && notes.indexOf(note + ':' + match.deviceIp) === -1) notes.push(note + ':' + match.deviceIp);
        });

        var places = locationsOf(matches);
        var status;
        if (!matches.length) status = 'NOT_FOUND';
        else if (!places.size) status = 'TRANSIT_ONLY';   // seen forwarding, nowhere to place it
        else if (places.size > 1) status = 'AMBIGUOUS';
        else status = 'FOUND';

        // A hostname that resolves to two devices is a different question from a MAC on two ports, and a
        // caller that only reads `status` should still be able to tell them apart.
        if (status === 'AMBIGUOUS' && matches.every(function (m) { return m.type === 'device'; })) {
            notes.push('identifier-matches-' + places.size + '-devices');
        }

        return {
            query: text, interpretations: interpretations, status: status,
            matches: matches, locations: Array.from(places).sort(),
            claimants: Array.from(claimants).sort(), notes: notes,
        };
    }

    return { resolve: resolve, graph: graph, deviceByIp: byManagementIp };
}

function resolveEndpoint(query, topology, options) {
    return createResolver(topology, options).resolve(query, options && options.type);
}

var EndpointResolution = {
    createResolver: createResolver,
    resolveEndpoint: resolveEndpoint,
    normalizeMac: normalizeMac,
};

// Dual-mode export: node:test (CJS/ESM interop) vs. browser <script> (no `module`).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = EndpointResolution;
} else if (typeof window !== 'undefined') {
    window.EndpointResolution = EndpointResolution;
}
