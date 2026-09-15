// Section 3. The rule framework, and the L1 (link-layer) rules that are the best-supported layer.
//
// Four outcomes per subject, not two. A rule that cannot see its input reports NOT_EVALUATED and says
// which datum was missing; a rule whose condition held but whose suppressors excuse it reports
// SUPPRESSED and says which one. Both are recorded per subject and counted per rule, because "no
// findings" has to be separable from "no data", and the per-rule `missing` histogram is how a truncated
// fleet explains its own silence (section 2.4).
//
// Three shapes this file commits to, each because the alternative was tried in review and cannot work:
//
//   - Data dependencies are a guard FUNCTION, never a path string (section 3.2). Five interface fields
//     default to empty collections, so `InputErrors` exists and is `{}` on a device whose extensive
//     section never arrived - a path check passes with zero data, which is the false clean the guard
//     exists to prevent. A guard can also express a data-dependent KEY, which is what the counter and
//     statistics rules actually need.
//   - Every guard reads SectionsCaptured through FIELD_SECTION before it reads the field, so
//     "the section never arrived" and "the platform does not report this field" stay distinct strings.
//     A field list hard-coded per rule rots on every command added to the batch (section 2.4).
//   - One comparator layer, and a non-number reaching a numeric comparator is NOT_EVALUATED rather than
//     false. `5e9 > null` is true in JavaScript and $null means unmeasured (section 2.5), so the type
//     guard has to live in the comparator where no rule can forget it.
//
// No DOM, no window: this file also runs under Node in the test suite.

var L2 = (typeof module !== 'undefined' && module.exports)
    ? require('./l2-graph.js')
    : (typeof window !== 'undefined' ? window.L2Graph : null);

// The L2 rules must agree with the path computer about what a converged link looks like, so the
// definition is imported rather than restated (section 6.3).
var L2Path = (typeof module !== 'undefined' && module.exports)
    ? require('./l2-path.js')
    : (typeof window !== 'undefined' ? window.L2Path : null);

var OUTCOME = { FIRED: 'FIRED', PASSED: 'PASSED', SUPPRESSED: 'SUPPRESSED', NOT_EVALUATED: 'NOT_EVALUATED' };

// G-NOSCAN (section 2.4). The device contributed nothing, so no rule may read its blank fields as
// health - and no two-ended rule may read the absence as "the far end is fine".
var NO_CONTRIBUTION = ['AuthFailed', 'Unreachable', 'Error', 'Timeout', 'Aborted'];

// Which capture section supplies each field a rule reads. The worker's $DataDict keys, so a rule names
// the section a human would look for in the transcript. Parity with the fixture's own section-blanking
// table is asserted by the test suite: a field listed here that a dropped section does not actually take
// with it would make this guard decorative.
//
// R15's semantics, which this depends on: a section key lands in SectionsCaptured when its command
// produced any output at all (`Get-JunosCapturedSections`, keyed on non-whitespace content). A feature
// the chassis does not have therefore still records its section - the command's error text is output -
// and the fields stay null, which each rule's `only` reads as "no subject here". A command that prints
// NOTHING is the one case indistinguishable from truncation. Unverified against a non-PoE chassis; if
// one turns out to print nothing, the fix is worker-side (record the key on the command marker rather
// than on its content), not here.
var FIELD_SECTION = {
    // "show interfaces extensive", issued last and so lost first.
    Mtu: 'INTERFACES_EXT', SpeedConfigured: 'INTERFACES_EXT', SpeedNegotiated: 'INTERFACES_EXT',
    Duplex: 'INTERFACES_EXT', DuplexNegotiated: 'INTERFACES_EXT', AutoNegotiation: 'INTERFACES_EXT',
    NegotiationStatus: 'INTERFACES_EXT', MediaType: 'INTERFACES_EXT', MacAddress: 'INTERFACES_EXT',
    LinkLevelType: 'INTERFACES_EXT', CarrierTransitions: 'INTERFACES_EXT',
    InputBytes: 'INTERFACES_EXT', OutputBytes: 'INTERFACES_EXT',
    InputBps: 'INTERFACES_EXT', OutputBps: 'INTERFACES_EXT',
    InputErrors: 'INTERFACES_EXT', OutputErrors: 'INTERFACES_EXT',
    ActiveAlarms: 'INTERFACES_EXT', ActiveDefects: 'INTERFACES_EXT',
    StatisticsLastCleared: 'INTERFACES_EXT', InputPackets: 'INTERFACES_EXT', OutputPackets: 'INTERFACES_EXT',
    RemoteFault: 'INTERFACES_EXT', InterfaceFlags: 'INTERFACES_EXT', DeviceFlags: 'INTERFACES_EXT',
    BpduError: 'INTERFACES_EXT', LoopDetectPduError: 'INTERFACES_EXT',
    EthernetSwitchingError: 'INTERFACES_EXT', MacRewriteError: 'INTERFACES_EXT',
    MacStatistics: 'INTERFACES_EXT', PcsStatistics: 'INTERFACES_EXT', FecStatistics: 'INTERFACES_EXT',
    // C5. Parsed from the same extensive block as the fields above, not from the terse listing.
    LastFlappedSeconds: 'INTERFACES_EXT', LastFlappedState: 'INTERFACES_EXT',
    PoE: 'POE', PoeAdminStatus: 'POE', PoeOperStatus: 'POE', PoePairMode: 'POE',
    PoeMaxPower: 'POE', PoePriority: 'POE', PoePowerConsumption: 'POE', PoeClass: 'POE',
    Dot1x: 'DOT1X',
    Vlans: 'VLANS', StpDetail: 'STP', STP: 'STP', StpBridge: 'STP_BRIDGE',
    Bundle: 'INTERFACES_TERSE', BundleMembers: 'INTERFACES_TERSE',
    Admin: 'INTERFACES_TERSE', Link: 'INTERFACES_TERSE', Desc: 'INTERFACES_DESC',
    // Device-level.
    Neighbors: 'LLDP', MedNeighbors: 'LLDP', MacTable: 'MAC_TABLE', ArpEntries: 'ARP_TABLE',
    Uptime: 'UPTIME', Alarms: 'ALARMS', Configuration: 'CONFIG',
    // Clients is the de-duplicated view of the MAC table, joined to ARP and dot1x: no table, no clients.
    Clients: 'MAC_TABLE', DefaultRoute: 'ROUTE', Gateway: 'ROUTE',
    // R1's units are parsed out of the terse listing, not the extensive block.
    LogicalUnits: 'INTERFACES_TERSE',
};

function asList(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined) return [];
    return [value];
}

function stripUnit(port) {
    return L2 ? L2.stripUnit(port) : String(port === null || port === undefined ? '' : port).replace(/\.\d+$/, '');
}

function lower(value) {
    return value === null || value === undefined ? '' : String(value).toLowerCase();
}

// ---------------------------------------------------------------------------------------------------
// Guard primitives (section 3.2)

function missingOn(sections, holder, prefix, field, sectionPrefix) {
    var section = FIELD_SECTION[field];
    if (section && sections.indexOf(section) === -1) return (sectionPrefix || '') + 'section:' + section;
    var value = holder ? holder[field] : undefined;
    if (value === null || value === undefined) return prefix + field;
    return null;
}

function needPort(ctx, field) { return missingOn(ctx.facts.sections, ctx.row, 'Interfaces[].', field); }
function needDevice(ctx, field) { return missingOn(ctx.facts.sections, ctx.device, 'Device.', field); }
// The far end of an edge, named as the far end: "far.section:VLANS" and "section:VLANS" send an operator
// to two different switches.
function needFarPort(ctx, field) {
    return missingOn(ctx.farFacts.sections, ctx.farRow, 'far.Interfaces[].', field, 'far.');
}
function needFarDevice(ctx, field) {
    return missingOn(ctx.farFacts.sections, ctx.farDevice, 'far.Device.', field, 'far.');
}

// A container that exists and is empty is the case a path string cannot express: `InputErrors` is `{}`
// both when the port reports no counters and when the section never arrived, and `StpDetail` is keyed by
// a scope string the switch chose. So the guard names the KEY it needs.
function needPortKey(ctx, field, key) {
    var gap = needPort(ctx, field);
    if (gap) return gap;
    if (!Object.prototype.hasOwnProperty.call(ctx.row[field], key)) return 'Interfaces[].' + field + '[' + key + ']';
    return null;
}

function hasSection(ctx, name) { return ctx.facts.sections.indexOf(name) !== -1; }

// Whether this port is a SUBJECT of a rule reading `field`. A field the section delivered and the port
// does not report is hardware absence - an optical port has no duplex, a non-PoE port no PoE row - and
// that is not a subject. While the section is missing the port stays a subject, so the guard reports the
// truncation rather than a subject filter hiding it: the difference is the section 3.2 guarantee.
function reports(ctx, field) {
    var section = FIELD_SECTION[field];
    if (section && !hasSection(ctx, section)) return true;
    var value = ctx.row ? ctx.row[field] : undefined;
    return value !== null && value !== undefined;
}

function firstGap() {
    for (var i = 0; i < arguments.length; i++) { if (arguments[i]) return arguments[i]; }
    return null;
}

// ---------------------------------------------------------------------------------------------------
// The one comparator layer

function numeric(fn) {
    return function (a, b) {
        if (typeof a !== 'number' || !isFinite(a)) return null;   // NOT_EVALUATED, never a pass
        return fn(a, b);
    };
}

var COMPARATORS = {
    gt: numeric(function (a, b) { return a > b; }),
    gte: numeric(function (a, b) { return a >= b; }),
    lt: numeric(function (a, b) { return a < b; }),
    lte: numeric(function (a, b) { return a <= b; }),
    eq: function (a, b) { return a === b; },
    ne: function (a, b) { return a !== b; },
    eqi: function (a, b) { return lower(a) === lower(b); },
    nei: function (a, b) { return lower(a) !== lower(b); },
    'in': function (a, b) { return asList(b).indexOf(a) !== -1; },
    notIn: function (a, b) { return asList(b).indexOf(a) === -1; },
    contains: function (a, b) { return lower(a).indexOf(lower(b)) !== -1; },
};

// ---------------------------------------------------------------------------------------------------
// LLDP 802.3 TLVs (R2). The far end's own view of the wire, without scanning it.

function orgInfo(neighbor, subtypePrefix) {
    var found = null;
    asList(neighbor && neighbor.OrgInfo).forEach(function (entry) {
        if (found !== null || !entry) return;
        if (String(entry.Subtype || '').indexOf(subtypePrefix) === 0) found = entry.Info;
    });
    return found === null || found === undefined ? null : String(found);
}

// Junos prints two facts in this TLV, not one: whether the far end SUPPORTS the field and whether it is
// ENABLED - "Autonegotiation [supported, enabled (0x3)]" or "[not supported, disabled (0x0)]".
//
// `not supported` is unmeasured, not off (section 2.5). Twenty-seven of the measured capture's 43 LLDP
// blocks advertise it, every one of them a switch on an optical port, where there is no autonegotiation
// to report - so reading it as "autonegotiation is disabled" would fire a mismatch on every fibre uplink
// in the estate. Only `supported, disabled` is evidence that somebody turned it off.
function advertisedAutoneg(info) {
    if (info === null) return null;
    var match = /\[\s*(not supported|supported)\s*,\s*(enabled|disabled)/i.exec(info);
    if (!match || /not supported/i.test(match[1])) return null;
    return /enabled/i.test(match[2]) ? 'Enabled' : 'Disabled';
}

// "Info: MTU Size (1514)". In the measured capture the local `MTU: 1514` and this TLV carry the same
// number on the same wire, which is what makes a bare equality comparison the right one (G5).
function advertisedFrameSize(info) {
    var match = info === null ? null : /(\d+)/.exec(info);
    return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------------------------------
// Per-device derived facts, computed once for every rule that needs them

function deviceFacts(device, referenceMs) {
    var sections = asList(device.SectionsCaptured).map(String);
    var rowsByPort = new Map();
    asList(device.Interfaces).forEach(function (row) { if (row && row.Port) rowsByPort.set(String(row.Port), row); });
    var medPorts = new Set(asList(device.MedNeighbors).map(function (entry) { return stripUnit(entry.LocalPort); }));
    var neighborsByPort = new Map();
    asList(device.Neighbors).forEach(function (neighbor) {
        var port = stripUnit(neighbor.LocalPort);
        if (!neighborsByPort.has(port)) neighborsByPort.set(port, []);
        neighborsByPort.get(port).push(neighbor);
    });
    var macsByPort = new Map();
    asList(device.MacTable).forEach(function (row) {
        var port = row.PhysicalPort ? String(row.PhysicalPort) : stripUnit(row.Interface);
        if (!port) return;
        if (!macsByPort.has(port)) macsByPort.set(port, new Set());
        macsByPort.get(port).add(String(row.MacAddress).toUpperCase());
    });
    // Uptime is a boot TIMESTAMP, not a duration (and it is fifth-from-last in the batch, so a Partial
    // node can lose it - G-BASELINE reports NOT_EVALUATED rather than assuming a long uptime).
    var booted = Date.parse(device.Uptime);
    var reference = Date.parse(device.CaptureTimestamp);
    if (!isFinite(reference)) reference = referenceMs;
    var bootAgeSeconds = (isFinite(booted) && isFinite(reference)) ? (reference - booted) / 1000 : null;
    return {
        sections: sections, rowsByPort: rowsByPort, medPorts: medPorts,
        neighborsByPort: neighborsByPort, macsByPort: macsByPort,
        bootAgeSeconds: bootAgeSeconds,
        contributes: NO_CONTRIBUTION.indexOf(String(device.ScanStatus)) === -1,
    };
}

// ---------------------------------------------------------------------------------------------------
// Fleet-level derived facts (section 3, the L2 and L3 rules)
//
// An L1 rule reads one port. Every rule below compares one device's datum against the rest of the
// snapshot - a MAC seen twice, an address claimed twice, a neighbour nobody scanned - so the join is
// built once per evaluation rather than per subject.

// Address containment and the VRRP virtual-MAC prefix live in l2-graph.js: section 6.4's gateway report
// tests the same prefixes against the same addresses, and one copy is the only way the rule and the
// report cannot drift apart.
var cidrContains = L2.cidrContains;
var vridOf = L2.vridOf;
var VRRP_MAC_PREFIX = L2.VRRP_MAC_PREFIX;

function fleetFacts(devices, factsByIp, graph, allowedScopes) {
    // MAC -> the places it was learned that are LOCATIONS rather than sightings in passing. A MAC on an
    // uplink is the same frame seen a second time (R3, F4), so counting those would report every client
    // in the fleet as duplicated.
    var macLocations = new Map();
    var macsByLocation = new Map();
    // IP -> the MACs claiming it, across every ARP table in the snapshot (C2's order-independence made
    // visible: two claims are an ambiguity to report, never a winner to pick).
    var ipClaims = new Map();
    devices.forEach(function (device) {
        var ip = String(device.DeviceIP);
        var facts = factsByIp.get(ip);
        if (!facts.contributes) return;
        var transit = graph && graph.transitPorts ? (graph.transitPorts.get(ip) || new Set()) : new Set();
        asList(device.MacTable).forEach(function (row) {
            var port = row.PhysicalPort ? String(row.PhysicalPort) : stripUnit(row.Interface);
            if (!port || (L2 && L2.isInterconnect(port)) || transit.has(port)) return;
            var mac = String(row.MacAddress).toUpperCase();
            if (vridOf(mac) !== null) return;   // a VIP is learned wherever the master is, by design
            if (!macLocations.has(mac)) macLocations.set(mac, []);
            macLocations.get(mac).push({ ip: ip, port: port, vlan: row.VlanName, tag: row.VlanTag });
            // The same join read the other way round. Without it every port subject would walk the whole
            // fleet's MAC map, which the measured switch alone fills with a thousand entries.
            var key = ip + '|' + port;
            if (!macsByLocation.has(key)) macsByLocation.set(key, []);
            macsByLocation.get(key).push(mac);
        });
        asList(device.ArpEntries).forEach(function (entry) {
            var address = String(entry.IP);
            if (!address || address === 'Unknown') return;
            if (!ipClaims.has(address)) ipClaims.set(address, []);
            ipClaims.get(address).push({ ip: ip, mac: String(entry.MAC).toUpperCase() });
        });
    });
    // Terminals and shared segments, keyed the way a port-scope rule asks for them.
    var terminalsByPort = new Map();
    var segmentEnds = new Set();
    if (graph) {
        asList(graph.terminals).forEach(function (terminal) {
            var key = terminal.ip + '|' + terminal.port;
            if (!terminalsByPort.has(key)) terminalsByPort.set(key, []);
            terminalsByPort.get(key).push(terminal);
        });
        (L2 ? L2.groupSharedSegments(graph) : []).forEach(function (segment) {
            segment.ends.forEach(function (end) { segmentEnds.add(end.ip + '|' + end.port); });
        });
    }
    return {
        macLocations: macLocations, macsByLocation: macsByLocation, ipClaims: ipClaims,
        terminalsByPort: terminalsByPort, segmentEnds: segmentEnds,
        allowedScopes: asList(allowedScopes).map(String),
    };
}

function terminalsAt(ctx, kind) {
    var list = ctx.fleet.terminalsByPort.get(ctx.ip + '|' + ctx.port) || [];
    return list.filter(function (terminal) { return terminal.kind === kind; });
}

// Every scope key both ends of this edge report, so a comparison never reads one end's instance against
// nothing (section 6.3: an end with no instance is NO_STP_INSTANCE, not disagreement).
function sharedScopes(ctx) {
    var mine = (ctx.near.stp && ctx.near.stp.scopes) || {};
    var theirs = (ctx.far.stp && ctx.far.stp.scopes) || {};
    return Object.keys(mine).filter(function (key) {
        return Object.prototype.hasOwnProperty.call(theirs, key);
    }).sort();
}

function vlanTagsOf(end) {
    var tags = [];
    asList(end && end.vlans && end.vlans.members).forEach(function (member) {
        if (member.Tag === null || member.Tag === undefined) return;
        if (tags.indexOf(Number(member.Tag)) === -1) tags.push(Number(member.Tag));
    });
    return tags.sort(function (x, y) { return x - y; });
}

// ---------------------------------------------------------------------------------------------------
// Suppressors (section 3.3)
//
// A suppressor can itself be unevaluable, and a finding records that rather than silently standing or
// silently vanishing: "not suppressed" and "could not tell whether it is suppressed" are different
// facts, and the second one is what a Partial node produces.

var RECENT_BOOT_SECONDS = 3600;

var SUPPRESSORS = {
    'faces-med-endpoint': {
        why: 'the port faces an LLDP-MED endpoint, which negotiates on its own terms',
        guard: function (ctx) { return needDevice(ctx, 'MedNeighbors'); },
        test: function (ctx) { return ctx.facts.medPorts.has(ctx.port); },
    },
    'link-not-up': {
        why: 'the port is not in service, so the value is history rather than a symptom',
        guard: function (ctx) { return needPort(ctx, 'Link'); },
        test: function (ctx) { return lower(ctx.row.Link) !== 'up'; },
    },
    'recently-rebooted': {
        why: 'the device booted within the hour, so counters and flap times start from there',
        guard: function (ctx) {
            return firstGap(needDevice(ctx, 'Uptime'), ctx.facts.bootAgeSeconds === null ? 'Device.Uptime' : null);
        },
        test: function (ctx) { return ctx.facts.bootAgeSeconds < RECENT_BOOT_SECONDS; },
    },
};

function applySuppressors(rule, ctx) {
    var by = [];
    var evaluated = [];
    var unevaluated = [];
    asList(rule.suppressors).forEach(function (name) {
        var suppressor = SUPPRESSORS[name];
        if (!suppressor) throw new Error('unknown suppressor ' + name + ' on rule ' + rule.id);
        if (suppressor.guard(ctx)) { unevaluated.push(name); return; }
        evaluated.push(name);
        if (suppressor.test(ctx)) by.push(name);
    });
    return { by: by, evaluated: evaluated, unevaluated: unevaluated };
}

// ---------------------------------------------------------------------------------------------------
// The L1 rule table
//
// Derived from section 4.1's *Unlocks* column (the fields Phase 1 retained specifically so these could
// exist), section 3.4's three traps, and G5. There was no rule catalogue in the repo to copy from - the
// six-way audit behind Appendix A's counts is not in the tree - so this table IS the catalogue, and
// Appendix A's "14 supported today" is superseded by the count here.
//
// Excluded deliberately: every rule needing a counter DELTA between two snapshots (Appendix A's "+6"),
// which section 3.1 holds back until G-BASELINE's reset detection exists.
//
// Two traps encoded rather than described (section 3.4):
//   - No rule reads output `Drops`. It is the RED mechanism, and the healthiest access port in the
//     measured capture carries 14,635 of them against zero errors in both directions.
//   - Every duplex rule is gated on `Link = up` by `only`, not by a suppressor: all 25 link-down ports
//     in the capture print Half-duplex, so a down port is not a subject of the rule at all.

var live = function (ctx) { return lower(ctx.row.Link) === 'up'; };
// A port with no PoE hardware reports null for every PoE field once the POE section HAS arrived, and
// that is not a subject of a PoE rule. While the section is missing it stays a subject, so the guard -
// not this predicate - is what reports the truncation.
var poeCapable = function (ctx) { return reports(ctx, 'PoeOperStatus'); };
// The same shape for the dot1x rules: no supplicant row means nothing to judge, but only once the section
// has arrived. An empty Dot1x[] on a node that lost DOT1X is truncation.
var dot1xConfigured = function (ctx) { return !hasSection(ctx, 'DOT1X') || asList(ctx.row.Dot1x).length > 0; };
var neighborsHere = function (ctx) { return asList(ctx.facts.neighborsByPort.get(ctx.port)); };
var switchNeighbor = function (ctx) {
    var found = null;
    neighborsHere(ctx).forEach(function (neighbor) {
        if (found) return;
        if (neighbor.Reachable === false) return;              // R5: a bridge nobody can scan
        if (ctx.facts.medPorts.has(ctx.port)) return;           // an endpoint, not a wire between switches
        found = neighbor;
    });
    return found;
};

// ---------------------------------------------------------------------------------------------------
// Readers for the L2 and L3 rules. Each one answers a question the rule states, so the rule table stays
// a table (section 3.1) and the joins stay in one place.

var NOT_CONVERGED_STATES = ['LRN', 'LST'];

function stpScopes(row) { return (row && row.StpDetail) || {}; }

function hasStpRow(ctx) {
    return !hasSection(ctx, 'STP') || Object.keys(stpScopes(ctx.row)).length > 0;
}

function unconvergedScopes(ctx) {
    var scopes = stpScopes(ctx.row);
    return Object.keys(scopes).filter(function (key) {
        return NOT_CONVERGED_STATES.indexOf(String(scopes[key].State).toUpperCase()) !== -1;
    }).map(function (key) { return { scope: key, state: scopes[key].State }; });
}

function learnedHere(ctx) {
    return ctx.fleet.macsByLocation.get(ctx.ip + '|' + ctx.port) || [];
}

function duplicatedMacs(ctx) {
    return learnedHere(ctx).map(function (mac) {
        var elsewhere = ctx.fleet.macLocations.get(mac).filter(function (place) { return place.ip !== ctx.ip; });
        return { mac: mac, elsewhere: elsewhere };
    }).filter(function (entry) { return entry.elsewhere.length > 0; });
}

function portVlanNames(ctx) {
    return asList(ctx.row && ctx.row.Vlans).map(function (entry) {
        return entry && typeof entry === 'object' ? String(entry.Name) : String(entry);
    });
}

function strayVlans(ctx) {
    var carried = portVlanNames(ctx);
    var stray = [];
    asList(ctx.device.MacTable).forEach(function (row) {
        var port = row.PhysicalPort ? String(row.PhysicalPort) : stripUnit(row.Interface);
        if (port !== ctx.port) return;
        var name = String(row.VlanName);
        if (!name || name === 'undefined' || carried.indexOf(name) !== -1) return;
        if (stray.indexOf(name) === -1) stray.push(name);
    });
    return stray;
}

// The mirror of stpComparable, and for the same reason: an end carrying NO tag while its peer carries
// several is the worst shape F11 takes, not a reason to stop looking.
function vlansComparable(ctx) {
    if (!(ctx.near.vlans && ctx.near.vlans.captured) || !(ctx.far.vlans && ctx.far.vlans.captured)) return true;
    return vlanTagsOf(ctx.far).length > 0;
}

function vlansOnlyFar(ctx) {
    var here = vlanTagsOf(ctx.near);
    return vlanTagsOf(ctx.far).filter(function (tag) { return here.indexOf(tag) === -1; });
}

// ---- Native VLAN (G5). "show vlans extensive" annotates each member tagged/untagged with its port
// mode, and the one thing that combination states is the native VLAN: the untagged member of a trunk.

function vlanMembersOf(end) { return ((end && end.vlans) || {}).members || []; }

// Not "is a trunk" but "is not KNOWN to be an access port": a capture that ran the brief form reports
// Mode as null on every member, and that end has to stay a subject so the guard can report the gap
// rather than a subject filter turning an unmeasured fleet into a silent one (section 2.5).
function trunkish(end) {
    var members = vlanMembersOf(end);
    return members.length > 0 && !members.every(function (m) { return lower(m.Mode) === 'access'; });
}

function nativeVlanComparable(ctx) { return trunkish(ctx.near) && trunkish(ctx.far); }

// The gap the brief form leaves. Named per end, like the section guards, because the two ends are two
// switches and only one of them may have run the upgraded command.
function taggingGap(end, prefix) {
    var members = vlanMembersOf(end);
    var measured = members.some(function (m) { return m.Tagged === true || m.Tagged === false; });
    return measured ? null : (prefix || '') + 'Interfaces[].Vlans[].Tagged';
}

// The untagged tag on a trunk. Two untagged members are not a native VLAN, they are a second question,
// so the ambiguity returns null and the guard above has already proved the field was measured.
function nativeVlanOf(end) {
    var untagged = vlanMembersOf(end).filter(function (m) { return m.Tagged === false; });
    return untagged.length === 1 ? untagged[0].Tag : null;
}

function nativeVlanMismatch(ctx) {
    var here = nativeVlanOf(ctx.near);
    var there = nativeVlanOf(ctx.far);
    if (here === null || there === null) return null;
    return here === there ? null : { here: here, far: there };
}

// ---- Topology-change churn (G4). "show spanning-tree bridge" carries a change count and a time since
// the last one, per scope. The COUNT is deliberately not read: with no previous snapshot to subtract it
// from, a large count is an old switch, not a fault - that comparison belongs behind G-BASELINE.
var RECENT_TOPOLOGY_CHANGE_SECONDS = 600;

function bridgeStanzas(ctx) { return asList(ctx.device && ctx.device.StpBridge); }

function recentTopologyChanges(ctx) {
    return bridgeStanzas(ctx).filter(function (stanza) {
        var seconds = stanza.TimeSinceLastChangeSeconds;
        return typeof seconds === 'number' && isFinite(seconds) && seconds < RECENT_TOPOLOGY_CHANGE_SECONDS;
    }).map(function (stanza) {
        return {
            scope: stanza.Scope, seconds: stanza.TimeSinceLastChangeSeconds,
            changes: stanza.TopologyChangeCount, ports: portsInScope(ctx, stanza.Scope),
        };
    });
}

// The bridge view names the scope and nothing else; the per-port view names the ports. Joined on the
// scope string the parser normalises, so a finding says which ports reconverged rather than only which
// VLAN did.
function portsInScope(ctx, scope) {
    var ports = [];
    asList(ctx.device.Interfaces).forEach(function (row) {
        var scopes = stpScopes(row);
        if (Object.prototype.hasOwnProperty.call(scopes, scope)) ports.push(row.Port);
    });
    return ports.sort();
}

// ---- dot1x fallback VLAN (section 4.3). A supplicant that authenticated INTO the guest VLAN is on the
// network, so nothing else in the snapshot looks wrong - and it is not on the network it was meant to be.
function dot1xRows(ctx) { return asList(ctx.row && ctx.row.Dot1x); }

function authenticatedRows(ctx) {
    return dot1xRows(ctx).filter(function (entry) { return lower(entry.State) === 'authenticated'; });
}

function fallbackVlanClients(ctx) {
    return authenticatedRows(ctx).filter(function (entry) {
        return entry.GuestVlan && entry.AuthenticatedVlan
            && lower(entry.GuestVlan) === lower(entry.AuthenticatedVlan);
    }).map(function (entry) {
        return { mac: entry.MacAddress, user: entry.User, vlan: entry.AuthenticatedVlan };
    });
}

// A subject whenever the FAR end runs an instance: an end with none is the drift, not a reason to stop
// looking. Sections missing at either end leave it a subject too, so the guard is what answers.
function stpComparable(ctx) {
    if (!(ctx.near.stp && ctx.near.stp.captured) || !(ctx.far.stp && ctx.far.stp.captured)) return true;
    return Object.keys((ctx.far.stp || {}).scopes || {}).length > 0;
}

function scopesOnlyFar(ctx) {
    var here = Object.keys((ctx.near.stp || {}).scopes || {});
    return Object.keys((ctx.far.stp || {}).scopes || {}).filter(function (key) { return here.indexOf(key) === -1; });
}

function conflictingScopes(ctx) {
    var mine = (ctx.near.stp || {}).scopes || {};
    var theirs = (ctx.far.stp || {}).scopes || {};
    return sharedScopes(ctx).filter(function (key) {
        return L2Path && L2Path.bothEndsClaimSegment(
            { role: mine[key].Role }, { role: theirs[key].Role });
    }).map(function (key) { return { scope: key, role: mine[key].Role }; });
}

// One finding per edge, and the same one whichever end the engine reached first.
function lowestEnd(ctx) {
    var here = ctx.near.ip + '|' + ctx.near.port;
    var there = ctx.far.ip + '|' + ctx.far.port;
    return here <= there ? { ip: ctx.near.ip, port: ctx.near.port } : { ip: ctx.far.ip, port: ctx.far.port };
}

function contestedAddresses(ctx) {
    var contested = [];
    asList(ctx.device.ArpEntries).forEach(function (entry) {
        var address = String(entry.IP);
        var claims = ctx.fleet.ipClaims.get(address) || [];
        var macs = [];
        claims.forEach(function (claim) { if (macs.indexOf(claim.mac) === -1) macs.push(claim.mac); });
        if (macs.length < 2) return;
        if (contested.some(function (row) { return row.ip === address; })) return;
        contested.push({ ip: address, macs: macs.sort(), claimedBy: claims.map(function (c) { return c.ip; }).sort() });
    });
    return contested;
}

function nextHopOf(ctx) {
    var hop = (ctx.device.DefaultRoute || {}).NextHop;
    return hop === null || hop === undefined || hop === 'Unknown' ? null : String(hop);
}

function inetUnits(ctx) {
    return asList(ctx.device.LogicalUnits).filter(function (unit) {
        return unit && lower(unit.Family) === 'inet' && unit.LocalAddress;
    });
}

function inetPrefixes(ctx) {
    return inetUnits(ctx).map(function (unit) { return String(unit.LocalAddress); });
}

function downUnits(ctx) {
    return inetUnits(ctx).filter(function (unit) {
        return lower(unit.Admin) === 'up' && lower(unit.Link) === 'down';
    }).map(function (unit) {
        return { parent: unit.Parent, unit: unit.Unit, address: unit.LocalAddress };
    });
}

function clientsHere(ctx) {
    return asList(ctx.device.Clients).filter(function (client) {
        return stripUnit(client.Port) === ctx.port;
    });
}

function offScopeClients(ctx) {
    return clientsHere(ctx).filter(function (client) {
        var address = String(client.IP);
        if (!address || address === 'Unknown') return false;
        return !ctx.fleet.allowedScopes.some(function (scope) { return address.indexOf(scope) === 0; });
    }).map(function (client) { return { ip: client.IP, mac: client.MAC, vlanTag: client.VLAN_Tag }; });
}

var RULES = [
    // --- Negotiation and duplex -------------------------------------------------------------------
    {
        id: 'duplex-half-on-up-link', layer: 'L1', severity: 'warning', scope: 'port',
        title: 'Port is up and running half-duplex',
        only: live,
        guard: function (ctx) { return needPort(ctx, 'Duplex'); },
        field: 'Duplex', cmp: 'eqi', value: 'Half-duplex',
    },
    {
        // Gated on live AND on autonegotiation being enabled: the status is only meaningful where
        // negotiation was attempted, and all 25 of the capture's down ports print Incomplete because the
        // link is down. Without the second gate this would restate every autoneg-disabled finding.
        id: 'negotiation-incomplete', layer: 'L1', severity: 'warning', scope: 'port',
        title: 'Port is up but autonegotiation never completed',
        only: function (ctx) {
            if (!live(ctx)) return false;
            // Not `=== 'enabled'` alone: on a truncated node the field is blank, and skipping there would
            // report silence as "no subject" instead of as the missing section it is.
            return !hasSection(ctx, 'INTERFACES_EXT') || lower(ctx.row.AutoNegotiation) === 'enabled';
        },
        guard: function (ctx) { return firstGap(needPort(ctx, 'AutoNegotiation'), needPort(ctx, 'NegotiationStatus')); },
        field: 'NegotiationStatus', cmp: 'eqi', value: 'Incomplete',
        suppressors: ['faces-med-endpoint'],
    },
    {
        id: 'autoneg-disabled', layer: 'L1', severity: 'info', scope: 'port',
        title: 'Autonegotiation is disabled on a live port',
        only: live,
        guard: function (ctx) { return needPort(ctx, 'AutoNegotiation'); },
        field: 'AutoNegotiation', cmp: 'eqi', value: 'Disabled',
        suppressors: ['faces-med-endpoint'],
    },
    {
        // R2's own purpose: the far end's autoneg state without scanning the far end.
        id: 'autoneg-mismatch', layer: 'L1', severity: 'error', scope: 'port',
        title: 'Local autonegotiation state disagrees with what the neighbour advertises',
        only: function (ctx) { return live(ctx) && !!switchNeighbor(ctx); },
        guard: function (ctx) {
            var gap = firstGap(needDevice(ctx, 'Neighbors'), needPort(ctx, 'AutoNegotiation'));
            if (gap) return gap;
            if (advertisedAutoneg(orgInfo(switchNeighbor(ctx), 'MAC/PHY')) === null) {
                return 'Neighbors[].OrgInfo[MAC/PHY Configuration/Status]';
            }
            return null;
        },
        when: function (ctx) {
            var far = advertisedAutoneg(orgInfo(switchNeighbor(ctx), 'MAC/PHY'));
            return lower(ctx.row.AutoNegotiation) !== lower(far);
        },
        evidence: function (ctx) {
            var neighbor = switchNeighbor(ctx);
            return {
                local: ctx.row.AutoNegotiation,
                advertised: advertisedAutoneg(orgInfo(neighbor, 'MAC/PHY')),
                farIp: neighbor.ManagementIP, farPort: neighbor.RemotePort,
            };
        },
    },
    {
        // G5, which the spec listed as described nowhere. This is where R2's Maximum Frame Size TLV is
        // compared with something.
        id: 'mtu-mismatch', layer: 'L1', severity: 'error', scope: 'port',
        title: 'Local MTU disagrees with the frame size the neighbour advertises',
        only: function (ctx) { return live(ctx) && !!switchNeighbor(ctx); },
        guard: function (ctx) {
            var gap = firstGap(needDevice(ctx, 'Neighbors'), needPort(ctx, 'Mtu'));
            if (gap) return gap;
            if (advertisedFrameSize(orgInfo(switchNeighbor(ctx), 'Maximum Frame Size')) === null) {
                return 'Neighbors[].OrgInfo[Maximum Frame Size]';
            }
            return null;
        },
        when: function (ctx) {
            var far = advertisedFrameSize(orgInfo(switchNeighbor(ctx), 'Maximum Frame Size'));
            return COMPARATORS.ne(Number(ctx.row.Mtu), far);
        },
        evidence: function (ctx) {
            var neighbor = switchNeighbor(ctx);
            return {
                local: ctx.row.Mtu,
                advertised: advertisedFrameSize(orgInfo(neighbor, 'Maximum Frame Size')),
                farIp: neighbor.ManagementIP, farPort: neighbor.RemotePort,
            };
        },
    },
    {
        // The only rule here that needs both ends scanned, and so the only user of the two-ended gate.
        // Half-duplex against Full-duplex is a real mismatch; Half against Half is a configuration
        // choice, and neither end can tell which of the two it is alone.
        id: 'duplex-mismatch', layer: 'L1', severity: 'error', scope: 'edge',
        title: 'The two ends of one link report different duplex',
        only: function (ctx) {
            // An end that contributed nothing stays a subject so G-NOSCAN is the thing that answers for
            // it; skipping here would let a blank far end read as "no mismatch".
            if (!ctx.facts.contributes || !ctx.farFacts.contributes) return true;
            return lower(ctx.nearRow && ctx.nearRow.Link) === 'up' && lower(ctx.farRow && ctx.farRow.Link) === 'up';
        },
        guard: function (ctx) {
            return firstGap(
                missingOn(ctx.facts.sections, ctx.nearRow, 'Interfaces[].', 'Duplex'),
                missingOn(ctx.farFacts.sections, ctx.farRow, 'far.Interfaces[].', 'Duplex'));
        },
        when: function (ctx) { return lower(ctx.nearRow.Duplex) !== lower(ctx.farRow.Duplex); },
        // The half-duplex end is the one an operator has to go and look at.
        anchor: function (ctx) {
            return lower(ctx.nearRow.Duplex) === 'half-duplex' ? ctx.near : ctx.far;
        },
        evidence: function (ctx) {
            return {
                near: { ip: ctx.near.ip, port: ctx.near.port, duplex: ctx.nearRow.Duplex },
                far: { ip: ctx.far.ip, port: ctx.far.port, duplex: ctx.farRow.Duplex },
                confirmation: ctx.edge.confirmation,
            };
        },
    },

    // --- Error counters and link-level error flags -------------------------------------------------
    {
        // R4's own purpose: the one non-zero CRC value in the measured capture sits in a fixed-width
        // table the error-counter parser structurally could not reach.
        id: 'crc-align-errors', layer: 'L1', severity: 'error', scope: 'port',
        title: 'MAC statistics report CRC/Align errors',
        guard: function (ctx) { return needPortKey(ctx, 'MacStatistics', 'CRC/Align errors'); },
        read: function (ctx) { return ctx.row.MacStatistics['CRC/Align errors'].Receive; },
        datum: 'Interfaces[].MacStatistics[CRC/Align errors].Receive',
        cmp: 'gt', value: 0,
        suppressors: ['link-not-up', 'recently-rebooted'],
    },
    {
        id: 'input-errors-present', layer: 'L1', severity: 'error', scope: 'port',
        title: 'Input error counter is non-zero',
        guard: function (ctx) { return needPortKey(ctx, 'InputErrors', 'Errors'); },
        read: function (ctx) { return ctx.row.InputErrors.Errors; },
        datum: 'Interfaces[].InputErrors[Errors]',
        cmp: 'gt', value: 0,
        suppressors: ['link-not-up', 'recently-rebooted'],
    },
    {
        id: 'output-errors-present', layer: 'L1', severity: 'error', scope: 'port',
        title: 'Output error counter is non-zero',
        // Errors, never Drops: see the note above the table.
        guard: function (ctx) { return needPortKey(ctx, 'OutputErrors', 'Errors'); },
        read: function (ctx) { return ctx.row.OutputErrors.Errors; },
        datum: 'Interfaces[].OutputErrors[Errors]',
        cmp: 'gt', value: 0,
        suppressors: ['link-not-up', 'recently-rebooted'],
    },
    {
        id: 'framing-errors-present', layer: 'L1', severity: 'warning', scope: 'port',
        title: 'Framing error counter is non-zero',
        guard: function (ctx) { return needPortKey(ctx, 'InputErrors', 'Framing errors'); },
        read: function (ctx) { return ctx.row.InputErrors['Framing errors']; },
        datum: 'Interfaces[].InputErrors[Framing errors]',
        cmp: 'gt', value: 0,
        suppressors: ['link-not-up', 'recently-rebooted'],
    },
    {
        id: 'remote-fault', layer: 'L1', severity: 'error', scope: 'port',
        title: 'Link-level remote fault reported',
        only: live,
        guard: function (ctx) { return needPort(ctx, 'RemoteFault'); },
        field: 'RemoteFault', cmp: 'nei', value: 'Online',
    },
    {
        // Section 3.4's third trap, the one revision 1 got backwards: LINK on a port reporting up is a
        // real alarm, and it is only noise on a port that is down.
        id: 'link-alarm-on-up-port', layer: 'L1', severity: 'error', scope: 'port',
        title: 'Port reports a LINK alarm while up',
        only: live,
        guard: function (ctx) { return needPort(ctx, 'ActiveAlarms'); },
        field: 'ActiveAlarms', cmp: 'contains', value: 'LINK',
    },
    {
        id: 'bpdu-error', layer: 'L1', severity: 'error', scope: 'port',
        title: 'BPDU error on the link-level line',
        guard: function (ctx) { return needPort(ctx, 'BpduError'); },
        field: 'BpduError', cmp: 'nei', value: 'None',
        suppressors: ['link-not-up'],
    },
    {
        id: 'loop-detect-pdu-error', layer: 'L1', severity: 'error', scope: 'port',
        title: 'Loop-detect PDU error on the link-level line',
        guard: function (ctx) { return needPort(ctx, 'LoopDetectPduError'); },
        field: 'LoopDetectPduError', cmp: 'nei', value: 'None',
        suppressors: ['link-not-up'],
    },
    {
        id: 'ethernet-switching-error', layer: 'L1', severity: 'error', scope: 'port',
        title: 'Ethernet-switching error on the link-level line',
        guard: function (ctx) { return needPort(ctx, 'EthernetSwitchingError'); },
        field: 'EthernetSwitchingError', cmp: 'nei', value: 'None',
        suppressors: ['link-not-up'],
    },
    {
        id: 'mac-rewrite-error', layer: 'L1', severity: 'warning', scope: 'port',
        title: 'MAC-rewrite error on the link-level line',
        guard: function (ctx) { return needPort(ctx, 'MacRewriteError'); },
        field: 'MacRewriteError', cmp: 'nei', value: 'None',
        suppressors: ['link-not-up'],
    },

    // --- Stability ---------------------------------------------------------------------------------
    {
        // C5's reason for keeping the state separate: "Never" is the healthy case and an undecodable
        // duration is a parser gap, and both used to read as the same null.
        id: 'port-flapped-recently', layer: 'L1', severity: 'warning', scope: 'port',
        title: 'Port last changed state within the hour',
        only: live,
        guard: function (ctx) {
            return firstGap(needPort(ctx, 'LastFlappedState'),
                lower(ctx.row.LastFlappedState) === 'never' ? null : needPort(ctx, 'LastFlappedSeconds'));
        },
        when: function (ctx) {
            if (lower(ctx.row.LastFlappedState) === 'never') return false;
            return COMPARATORS.lt(ctx.row.LastFlappedSeconds, RECENT_BOOT_SECONDS);
        },
        datum: 'Interfaces[].LastFlappedSeconds',
        evidence: function (ctx) { return { seconds: ctx.row.LastFlappedSeconds, state: ctx.row.LastFlappedState }; },
        suppressors: ['recently-rebooted'],
    },
    {
        // Section 5.3: an aggregate reporting fewer members than it has is exactly the capacity loss
        // worth noticing, and the bundle keeps the whole member list whether or not a member advertises.
        id: 'lag-member-down', layer: 'L1', severity: 'error', scope: 'port',
        title: 'Aggregate has a member whose link is down',
        only: function (ctx) { return asList(ctx.row.BundleMembers).length > 0; },
        guard: function (ctx) {
            var gap = needPort(ctx, 'BundleMembers');
            if (gap) return gap;
            var unseen = null;
            asList(ctx.row.BundleMembers).forEach(function (port) {
                var member = ctx.facts.rowsByPort.get(String(port));
                if (!unseen && (!member || member.Link === null || member.Link === undefined)) {
                    unseen = 'Interfaces[' + port + '].Link';
                }
            });
            return unseen;
        },
        when: function (ctx) {
            return asList(ctx.row.BundleMembers).some(function (port) {
                return lower(ctx.facts.rowsByPort.get(String(port)).Link) !== 'up';
            });
        },
        evidence: function (ctx) {
            return {
                members: asList(ctx.row.BundleMembers).map(function (port) {
                    var member = ctx.facts.rowsByPort.get(String(port));
                    return { port: port, link: member.Link, admin: member.Admin };
                }),
            };
        },
    },

    // --- Power and access control ------------------------------------------------------------------
    {
        // R7's reason for keeping AdminStatus: without it, "administratively disabled" and "nothing is
        // drawing power" both read OFF, and only the first one is a fault.
        id: 'poe-admin-disabled-with-endpoint', layer: 'L1', severity: 'warning', scope: 'port',
        title: 'PoE is administratively disabled on a port facing a powered endpoint',
        only: function (ctx) { return ctx.facts.medPorts.has(ctx.port) && poeCapable(ctx); },
        guard: function (ctx) { return firstGap(needDevice(ctx, 'MedNeighbors'), needPort(ctx, 'PoeAdminStatus')); },
        field: 'PoeAdminStatus', cmp: 'eqi', value: 'Disabled',
    },
    {
        // PROVISIONAL vocabulary, narrowed 2026-09-14. The measured capture's PoE table prints only ON
        // and OFF in the Oper-status column, and OFF with Admin Enabled is the ordinary "nothing plugged
        // in" state, so no fault string here was ever observed. Juniper's published output-field table
        // enumerates the column as ON / OFF / FAULT / Disabled, which is narrower than the five values
        // this used to match - the extra four were invented. Still unconfirmed against hardware.
        id: 'poe-denied', layer: 'L1', severity: 'error', scope: 'port',
        title: 'PoE reports a fault state on the port',
        only: poeCapable,
        guard: function (ctx) { return needPort(ctx, 'PoeOperStatus'); },
        // Juniper documents exactly four Oper status values - ON, OFF, FAULT, Disabled - so the four
        // extra strings this used to match ("Denied", "Power-Denied", "Overload", "Powered-down") were
        // invented, and matching them made the rule look better-founded than it was. The FAULT REASON
        // is a separate "Operational status detail" field the brief table does not carry. Matched
        // case-insensitively and by substring, because the one thing the capture proves is that this
        // column's case is not stable across releases.
        field: 'PoeOperStatus', cmp: 'contains', value: 'fault',
    },
    {
        // R6 exists because the MAC-keyed parse could not represent a port with nothing authenticated.
        id: 'dot1x-held', layer: 'L1', severity: 'error', scope: 'port',
        title: 'A supplicant on this port is in the Held state',
        only: dot1xConfigured,
        guard: function (ctx) { return needPort(ctx, 'Dot1x'); },
        when: function (ctx) {
            return asList(ctx.row.Dot1x).some(function (entry) { return lower(entry.State) === 'held'; });
        },
        datum: 'Interfaces[].Dot1x[].State',
        evidence: function (ctx) { return { supplicants: asList(ctx.row.Dot1x) }; },
    },
    {
        id: 'dot1x-auth-failed', layer: 'L1', severity: 'error', scope: 'port',
        title: 'A supplicant on this port failed authentication',
        only: dot1xConfigured,
        guard: function (ctx) { return needPort(ctx, 'Dot1x'); },
        when: function (ctx) {
            return asList(ctx.row.Dot1x).some(function (entry) {
                return ['failed', 'force-unauthorized'].indexOf(lower(entry.State)) !== -1;
            });
        },
        datum: 'Interfaces[].Dot1x[].State',
        evidence: function (ctx) { return { supplicants: asList(ctx.row.Dot1x) }; },
    },
    {
        // Traffic is being learned on a port where dot1x is configured and nobody authenticated. An
        // Initialize row with no MAC-table entry behind it is a quiet port, not this.
        id: 'dot1x-unauthenticated-traffic', layer: 'L1', severity: 'warning', scope: 'port',
        title: 'MACs are learned on a dot1x port with nothing authenticated',
        only: function (ctx) { return live(ctx) && dot1xConfigured(ctx); },
        guard: function (ctx) { return firstGap(needPort(ctx, 'Dot1x'), needDevice(ctx, 'MacTable')); },
        when: function (ctx) {
            var authenticated = asList(ctx.row.Dot1x).some(function (entry) { return lower(entry.State) === 'authenticated'; });
            var learned = ctx.facts.macsByPort.get(ctx.port);
            return !authenticated && !!learned && learned.size > 0;
        },
        datum: 'Interfaces[].Dot1x[].State',
        evidence: function (ctx) {
            return {
                states: asList(ctx.row.Dot1x).map(function (entry) { return entry.State; }),
                learned: (ctx.facts.macsByPort.get(ctx.port) || new Set()).size,
            };
        },
    },

    {
        // Section 4.3's dot1x upgrade. The supplicant authenticated and landed in the port's GUEST VLAN
        // rather than the one it was meant to have - it is on the network, so no other rule sees a
        // problem. Informational: a guest VLAN exists to be landed in. UNVERIFIED on hardware (4.3.1):
        // the stanza's field LABELS are documented, its layout is this project's inference.
        id: 'dot1x-fallback-vlan', layer: 'L1', severity: 'info', scope: 'port',
        title: 'An authenticated supplicant landed in the guest VLAN',
        only: function (ctx) { return dot1xConfigured(ctx); },
        guard: function (ctx) {
            var gap = needPort(ctx, 'Dot1x');
            if (gap) return gap;
            var rows = authenticatedRows(ctx);
            if (!rows.length) return null;   // nothing authenticated here is a pass, not a gap
            var measured = rows.some(function (entry) { return entry.AuthenticatedVlan; });
            // The brief form of the command names no VLAN at all, so an authenticated port with no
            // VLAN on any of its rows is unmeasured rather than correctly placed.
            return measured ? null : 'Interfaces[].Dot1x[].AuthenticatedVlan';
        },
        when: function (ctx) { return fallbackVlanClients(ctx).length > 0; },
        datum: 'Interfaces[].Dot1x[].AuthenticatedVlan',
        evidence: function (ctx) { return { clients: fallbackVlanClients(ctx) }; },
    },

    // -----------------------------------------------------------------------------------------------
    // L2 switching (section 3, item 13).
    {
        // F9. A port mid-transition is neither forwarding nor blocking, and a path computer reading only
        // FWD and BLK has no answer for it. Reported per port, naming the scope it is unconverged in.
        id: 'stp-port-not-converged', layer: 'L2', severity: 'warning', scope: 'port',
        title: 'A spanning-tree port is still learning or listening',
        only: function (ctx) { return hasStpRow(ctx); },
        guard: function (ctx) { return needPort(ctx, 'StpDetail'); },
        when: function (ctx) { return unconvergedScopes(ctx).length > 0; },
        datum: 'Interfaces[].StpDetail[].State',
        evidence: function (ctx) { return { scopes: unconvergedScopes(ctx) }; },
    },
    {
        // F1/F4. One MAC learned as a LOCATION on two devices: a loop, a spoof, or a host that moved
        // between two captures. Sightings on transit ports are excluded upstream - every client in the
        // fleet is visible on its uplink, and counting those would report the whole estate as duplicated.
        id: 'duplicate-mac-across-devices', layer: 'L2', severity: 'error', scope: 'port',
        title: 'A MAC is learned on access ports of two different switches',
        only: function (ctx) { return learnedHere(ctx).length > 0; },
        guard: function (ctx) { return needDevice(ctx, 'MacTable'); },
        when: function (ctx) { return duplicatedMacs(ctx).length > 0; },
        datum: 'Device.MacTable[].MacAddress',
        evidence: function (ctx) {
            return {
                macs: duplicatedMacs(ctx).map(function (entry) {
                    return { mac: entry.mac, alsoOn: entry.elsewhere };
                }),
            };
        },
    },
    {
        // A MAC learned in a VLAN the port is not a member of. The switch answers both questions and
        // they disagree, which is a membership change that did not reach the forwarding table.
        id: 'mac-in-vlan-not-on-port', layer: 'L2', severity: 'warning', scope: 'port',
        title: 'A MAC is learned in a VLAN this port does not carry',
        only: function (ctx) { return learnedHere(ctx).length > 0; },
        guard: function (ctx) { return firstGap(needDevice(ctx, 'MacTable'), needPort(ctx, 'Vlans')); },
        when: function (ctx) { return strayVlans(ctx).length > 0; },
        datum: 'Device.MacTable[].VlanName',
        evidence: function (ctx) {
            return { learnedIn: strayVlans(ctx), portCarries: portVlanNames(ctx) };
        },
    },
    {
        // F14. Two ports facing one address-less bridge are a shared segment, and chaining them would
        // invent a link across a device that is not in the snapshot. Reported, never traversed.
        id: 'shared-segment-not-a-link', layer: 'L2', severity: 'warning', scope: 'port', usesGraph: true,
        title: 'This port shares a segment with another through an unmanaged bridge',
        only: function (ctx) { return ctx.fleet.segmentEnds.has(ctx.ip + '|' + ctx.port); },
        guard: function (ctx) { return needDevice(ctx, 'Neighbors'); },
        when: function () { return true; },
        datum: 'Neighbors[].ManagementIP',
        evidence: function (ctx) {
            var here = terminalsAt(ctx, 'addressless-bridge')[0] || null;
            return { bridgeMac: here ? here.mac : null, description: here ? here.description : null };
        },
    },
    {
        // R5/F6. A bridge that advertises Bridge or Router capability and no management address is a
        // switch nothing can scan. One end only - two ends of the same bridge are the segment above.
        id: 'bridge-without-management-address', layer: 'L2', severity: 'warning', scope: 'port', usesGraph: true,
        title: 'The neighbour here is a bridge with no management address',
        only: function (ctx) {
            return terminalsAt(ctx, 'addressless-bridge').length > 0
                && !ctx.fleet.segmentEnds.has(ctx.ip + '|' + ctx.port);
        },
        guard: function (ctx) { return needDevice(ctx, 'Neighbors'); },
        when: function () { return true; },
        datum: 'Neighbors[].ManagementIP',
        evidence: function (ctx) {
            var here = terminalsAt(ctx, 'addressless-bridge')[0];
            return { bridgeMac: here.mac, remotePort: here.remotePort, description: here.description };
        },
    },
    {
        // Section 5.3's fourth fleet edge: several client MACs behind a port with no LLDP neighbour and
        // no MED endpoint. Something is bridging there that nobody has recorded.
        id: 'unmanaged-segment-inferred', layer: 'L2', severity: 'warning', scope: 'port', usesGraph: true,
        title: 'Several MACs sit behind a port with no neighbour of any kind',
        only: function (ctx) { return terminalsAt(ctx, 'inferred-segment').length > 0; },
        guard: function (ctx) { return firstGap(needDevice(ctx, 'MacTable'), needDevice(ctx, 'Neighbors')); },
        when: function () { return true; },
        datum: 'Device.MacTable[].MacAddress',
        evidence: function (ctx) {
            var here = terminalsAt(ctx, 'inferred-segment')[0];
            return { macCount: here.macCount, macs: here.macs };
        },
    },
    {
        // A neighbour that named a management address no device in the snapshot carries. Not a device
        // fault - a coverage gap, and the reason a path stops at F8 rather than crossing.
        id: 'neighbour-never-scanned', layer: 'L2', severity: 'info', scope: 'port', usesGraph: true,
        title: 'The neighbour on this port is not in the snapshot',
        only: function (ctx) { return terminalsAt(ctx, 'unscanned').length > 0; },
        guard: function (ctx) { return needDevice(ctx, 'Neighbors'); },
        when: function () { return true; },
        datum: 'Neighbors[].ManagementIP',
        evidence: function (ctx) {
            var here = terminalsAt(ctx, 'unscanned')[0];
            return { farIp: here.farIp, farHostname: here.farHostname, scopesKnown: here.scopesKnown };
        },
    },
    {
        // F11. One VLAN on one end of a trunk. Both ends forward, nothing about either port looks wrong,
        // and frames in that VLAN cannot cross. Anchored on the end that is MISSING the VLAN.
        id: 'vlan-absent-on-one-trunk-end', layer: 'L2', severity: 'error', scope: 'edge',
        title: 'A VLAN is configured on one end of this link only',
        only: vlansComparable,
        guard: function (ctx) { return firstGap(needPort(ctx, 'Vlans'), needFarPort(ctx, 'Vlans')); },
        when: function (ctx) { return vlansOnlyFar(ctx).length > 0; },
        anchor: function (ctx) { return { ip: ctx.near.ip, port: ctx.near.port }; },
        datum: 'Interfaces[].Vlans',
        evidence: function (ctx) {
            return { missingHere: vlansOnlyFar(ctx), here: vlanTagsOf(ctx.near), far: vlanTagsOf(ctx.far) };
        },
    },
    {
        // Section 6.3. Within a converged instance exactly one end of a link is designated; two ends
        // claiming the same role over one wire is a tree that has not converged or is not one tree.
        id: 'stp-both-ends-claim-segment', layer: 'L2', severity: 'error', scope: 'edge',
        title: 'Both ends of this link hold the same spanning-tree role',
        only: function (ctx) { return sharedScopes(ctx).length > 0; },
        guard: function (ctx) { return firstGap(needPort(ctx, 'StpDetail'), needFarPort(ctx, 'StpDetail')); },
        when: function (ctx) { return conflictingScopes(ctx).length > 0; },
        anchor: function (ctx) { return lowestEnd(ctx); },
        datum: 'Interfaces[].StpDetail[].Role',
        evidence: function (ctx) { return { scopes: conflictingScopes(ctx) }; },
    },
    {
        // G2. One end runs an instance for a scope the other does not, so the pruning that decides
        // whether a frame may cross is happening on one side of the wire only.
        id: 'stp-scope-drift', layer: 'L2', severity: 'warning', scope: 'edge',
        title: 'The two ends of this link run different spanning-tree instances',
        only: stpComparable,
        guard: function (ctx) { return firstGap(needPort(ctx, 'StpDetail'), needFarPort(ctx, 'StpDetail')); },
        when: function (ctx) { return scopesOnlyFar(ctx).length > 0; },
        anchor: function (ctx) { return { ip: ctx.near.ip, port: ctx.near.port }; },
        datum: 'Interfaces[].StpDetail',
        evidence: function (ctx) {
            return { missingHere: scopesOnlyFar(ctx), here: Object.keys((ctx.near.stp || {}).scopes || {}).sort() };
        },
    },
    {
        // G5. Two trunk ends with different untagged VLANs: untagged frames leaving one end arrive in a
        // different broadcast domain at the other, which is a VLAN leak in the direction nothing else in
        // the snapshot reports. Reads the section 4.3 fields, which are UNVERIFIED on hardware (4.3.1).
        id: 'native-vlan-mismatch', layer: 'L2', severity: 'error', scope: 'edge',
        title: 'The two ends of this trunk use different native VLANs',
        only: nativeVlanComparable,
        guard: function (ctx) {
            return firstGap(needPort(ctx, 'Vlans'), needFarPort(ctx, 'Vlans'),
                taggingGap(ctx.near, ''), taggingGap(ctx.far, 'far.'));
        },
        when: function (ctx) { return nativeVlanMismatch(ctx) !== null; },
        anchor: function (ctx) { return lowestEnd(ctx); },
        datum: 'Interfaces[].Vlans[].Tagged',
        evidence: function (ctx) {
            var mismatch = nativeVlanMismatch(ctx) || {};
            return { here: mismatch.here, far: mismatch.far, farPort: ctx.far.port, farIp: ctx.far.ip };
        },
    },
    {
        // Both devices answered and only one of them sees the other. LLDP off on one end, a one-way
        // fibre pair, or a neighbour entry that has not aged out - all of them worth a look, and all of
        // them a reason section 6.2 will not call the hop VERIFIED.
        id: 'lldp-one-sided', layer: 'L2', severity: 'warning', scope: 'edge',
        title: 'Only one end of this link reports the other',
        // No subject filter: a Partial node still ran LLDP (tenth in the batch, well ahead of the tail),
        // so a truncated switch whose peer stopped seeing it is a real one-sided link. G-NOSCAN answers
        // for an end that contributed nothing and the guards answer for a missing section; a filter on
        // ScanStatus would only turn those answers back into silence.
        guard: function (ctx) { return firstGap(needDevice(ctx, 'Neighbors'), needFarDevice(ctx, 'Neighbors')); },
        when: function (ctx) { return ctx.edge.reciprocal === false; },
        anchor: function (ctx) { return lowestEnd(ctx); },
        datum: 'Neighbors[].ManagementIP',
        evidence: function (ctx) { return { confirmation: ctx.edge.confirmation }; },
    },

    {
        // G4. A scope that reconverged in the last few minutes explains "why is this broken NOW" better
        // than which bridge is root. Device-scope because the bridge view is per bridge, not per port;
        // the ports are joined on in the evidence. Reads a section 4.3 command, UNVERIFIED (4.3.1).
        id: 'stp-topology-change-recent', layer: 'L2', severity: 'warning', scope: 'device',
        title: 'A spanning-tree instance reconverged in the last few minutes',
        only: function (ctx) { return !hasSection(ctx, 'STP_BRIDGE') || bridgeStanzas(ctx).length > 0; },
        guard: function (ctx) {
            var gap = needDevice(ctx, 'StpBridge');
            if (gap) return gap;
            var measured = bridgeStanzas(ctx).some(function (stanza) {
                return typeof stanza.TimeSinceLastChangeSeconds === 'number';
            });
            // A scope that prints fewer fields leaves the age null, and null is unmeasured, never "long
            // ago" (section 2.5) - so a bridge view with no age at all is NOT_EVALUATED, not clean.
            return measured ? null : 'Device.StpBridge[].TimeSinceLastChangeSeconds';
        },
        when: function (ctx) { return recentTopologyChanges(ctx).length > 0; },
        datum: 'Device.StpBridge[].TimeSinceLastChangeSeconds',
        evidence: function (ctx) {
            return { withinSeconds: RECENT_TOPOLOGY_CHANGE_SECONDS, scopes: recentTopologyChanges(ctx) };
        },
    },

    // -----------------------------------------------------------------------------------------------
    // L3 and policy. Section 4.4 stands: none of these reads the configuration.
    {
        // C2. Two MACs claiming one address, anywhere in the fleet. The crawler's ARP map picks one to
        // resolve a client with; the ambiguity is the finding, and picking is what it must not do.
        id: 'duplicate-ip-two-macs', layer: 'L3', severity: 'error', scope: 'device',
        title: 'One address is claimed by two MACs',
        only: function (ctx) { return asList(ctx.device.ArpEntries).length > 0; },
        guard: function (ctx) { return needDevice(ctx, 'ArpEntries'); },
        when: function (ctx) { return contestedAddresses(ctx).length > 0; },
        datum: 'Device.ArpEntries[].MAC',
        evidence: function (ctx) { return { addresses: contestedAddresses(ctx) }; },
    },
    {
        // R9's sentinel, surfaced. The switch answered the route query and the parser read nothing out
        // of it: either this device has no default route, or the output has a shape the regex misses.
        // Both are worth a human; conflating them with "Unknown" is what R9 fixed.
        id: 'default-route-unreadable', layer: 'L3', severity: 'warning', scope: 'device',
        title: 'The route table gave no default route this parser could read',
        only: function (ctx) { return ctx.device.DefaultRoute !== null && ctx.device.DefaultRoute !== undefined; },
        guard: function (ctx) { return needDevice(ctx, 'DefaultRoute'); },
        when: function (ctx) { return String((ctx.device.DefaultRoute || {}).State) === 'Unparsed'; },
        datum: 'Device.DefaultRoute.State',
        evidence: function (ctx) { return { route: ctx.device.DefaultRoute }; },
    },
    {
        // The next hop has to be on a subnet this device holds an address on, or it cannot ARP for it.
        // Read off R1's units, which is the only place the snapshot carries a configured prefix.
        id: 'gateway-not-on-a-local-subnet', layer: 'L3', severity: 'error', scope: 'device',
        title: 'The default gateway is on no subnet this device has an address on',
        only: function (ctx) { return nextHopOf(ctx) !== null && inetPrefixes(ctx).length > 0; },
        guard: function (ctx) { return firstGap(needDevice(ctx, 'DefaultRoute'), needDevice(ctx, 'LogicalUnits')); },
        when: function (ctx) {
            var hop = nextHopOf(ctx);
            return !inetPrefixes(ctx).some(function (cidr) { return cidrContains(cidr, hop) === true; });
        },
        datum: 'Device.LogicalUnits[].LocalAddress',
        evidence: function (ctx) { return { nextHop: nextHopOf(ctx), prefixes: inetPrefixes(ctx) }; },
    },
    {
        // A routed interface administratively up with no link: the device's own L3 presence in that
        // VLAN is down, which no physical port's state says on its own.
        id: 'routed-unit-down', layer: 'L3', severity: 'error', scope: 'device',
        title: 'A routed interface is enabled and down',
        only: function (ctx) { return inetUnits(ctx).length > 0; },
        guard: function (ctx) { return needDevice(ctx, 'LogicalUnits'); },
        when: function (ctx) { return downUnits(ctx).length > 0; },
        datum: 'Device.LogicalUnits[].Link',
        evidence: function (ctx) { return { units: downUnits(ctx) }; },
    },
    {
        // A client resolved to an address outside every scope the crawl was told about. Section 6.4's
        // gateway question, surfaced as a finding rather than swallowed by endpoint resolution.
        id: 'client-outside-scope', layer: 'L3', severity: 'warning', scope: 'port',
        title: 'A client on this port has an address outside every scanned scope',
        only: function (ctx) { return clientsHere(ctx).length > 0; },
        guard: function (ctx) {
            // The scopes are the caller's, not the device's: without them the question has no answer,
            // and answering it anyway would report every address as out of scope.
            if (!ctx.fleet.allowedScopes.length) return 'option:allowedScopes';
            return needDevice(ctx, 'Clients');
        },
        when: function (ctx) { return offScopeClients(ctx).length > 0; },
        datum: 'Device.Clients[].IP',
        evidence: function (ctx) { return { clients: offScopeClients(ctx) }; },
    },
];

var RULES_BY_ID = new Map(RULES.map(function (rule) { return [rule.id, rule]; }));

// ---------------------------------------------------------------------------------------------------
// The engine

function emptyStats() {
    return { evaluated: 0, fired: 0, suppressed: 0, passed: 0, notEvaluated: 0, skipped: 0, missing: {} };
}

function conditionOf(rule, ctx) {
    if (rule.when) return rule.when(ctx);
    var read = rule.read ? rule.read(ctx) : ctx.row ? ctx.row[rule.field] : ctx.device[rule.field];
    return COMPARATORS[rule.cmp](read, rule.value);
}

function datumOf(rule) {
    return rule.datum || (rule.field ? 'Interfaces[].' + rule.field : rule.id + ':condition');
}

function buildSubjects(devices, factsByIp, graph, fleet) {
    var ports = [];
    var deviceSubjects = [];
    devices.forEach(function (device) {
        var ip = String(device.DeviceIP);
        var facts = factsByIp.get(ip);
        deviceSubjects.push({ scope: 'device', device: device, ip: ip, port: null, facts: facts, fleet: fleet });
        asList(device.Interfaces).forEach(function (row) {
            if (!row || !row.Port) return;
            ports.push({ scope: 'port', device: device, ip: ip, port: String(row.Port), row: row, facts: facts, fleet: fleet });
        });
    });
    var edges = [];
    asList(graph && graph.edges).forEach(function (edge) {
        // One subject per END, so a rule sees "my side and theirs" the way an operator does. The finding
        // is anchored once per edge by the rule's own `anchor`, so a mismatch is not reported twice.
        [[edge.a, edge.b], [edge.b, edge.a]].forEach(function (pair) {
            var near = pair[0];
            var far = pair[1];
            var nearDevice = graph.deviceByIp.get(near.ip);
            var farDevice = graph.deviceByIp.get(far.ip);
            if (!nearDevice || !farDevice) return;
            var facts = factsByIp.get(near.ip);
            var farFacts = factsByIp.get(far.ip);
            edges.push({
                scope: 'edge', edge: edge, device: nearDevice, ip: near.ip, port: near.port,
                near: near, far: far, farDevice: farDevice,
                row: facts.rowsByPort.get(near.port) || null,
                nearRow: facts.rowsByPort.get(near.port) || null,
                farRow: farFacts.rowsByPort.get(far.port) || null,
                facts: facts, farFacts: farFacts, fleet: fleet,
            });
        });
    });
    return { device: deviceSubjects, port: ports, edge: edges };
}

// The gate G-NOSCAN is, stated once: a device that contributed nothing cannot pass or fail a rule, and
// for a two-ended rule neither can a link whose far end contributed nothing.
function noScanGate(ctx) {
    if (!ctx.facts.contributes) return 'scan:' + ctx.device.ScanStatus;
    if (ctx.scope === 'edge' && !ctx.farFacts.contributes) return 'far.scan:' + ctx.farDevice.ScanStatus;
    return null;
}

function evaluate(input, options) {
    var opts = options || {};
    var snapshot = (input && input.Topology) ? input : null;
    var devices = asList(snapshot ? snapshot.Topology : input);
    var rules = opts.rules ? asList(opts.rules).map(function (id) {
        var rule = RULES_BY_ID.get(id);
        if (!rule) throw new Error('unknown rule ' + id);
        return rule;
    }) : RULES;
    var keepRecords = opts.records !== false;

    var referenceMs = Date.parse(opts.now || (snapshot && snapshot.ScanTimestamp));
    if (!isFinite(referenceMs)) referenceMs = Date.now();
    var factsByIp = new Map();
    devices.forEach(function (device) { factsByIp.set(String(device.DeviceIP), deviceFacts(device, referenceMs)); });

    var needsGraph = rules.some(function (rule) { return rule.scope === 'edge' || rule.usesGraph; });
    var graph = opts.graph || (needsGraph && L2 ? L2.buildPortGraph(devices, { allowedScopes: opts.allowedScopes }) : null);
    var fleet = fleetFacts(devices, factsByIp, graph, opts.allowedScopes);
    var subjects = buildSubjects(devices, factsByIp, graph, fleet);

    var findings = [];
    var records = [];
    var stats = {};
    var anchored = new Set();

    rules.forEach(function (rule) {
        var counts = emptyStats();
        stats[rule.id] = counts;
        var note = function (datum) { counts.missing[datum] = (counts.missing[datum] || 0) + 1; };

        subjects[rule.scope].forEach(function (ctx) {
            var record = { ruleId: rule.id, deviceIp: ctx.ip, port: ctx.port, outcome: null, missing: null, by: [] };
            if (ctx.scope === 'edge') { record.farIp = ctx.far.ip; record.farPort = ctx.far.port; }

            // Skipped is not an outcome: the rule has no subject here (no aggregate on this row, no
            // neighbour on this port, the port is dark for a duplex rule). Counting those as passes
            // would drown the histogram the four real outcomes exist to produce.
            if (rule.only && !rule.only(ctx)) { counts.skipped += 1; return; }

            var gap = firstGap(noScanGate(ctx), rule.guard ? rule.guard(ctx) : null);
            if (gap) {
                counts.notEvaluated += 1;
                note(gap);
                record.outcome = OUTCOME.NOT_EVALUATED;
                record.missing = gap;
                if (keepRecords) records.push(record);
                return;
            }

            var held = conditionOf(rule, ctx);
            if (held === null || held === undefined) {
                // The comparator refused: a non-number reached a numeric comparison, which is a parser
                // change or an unmeasured field, never a pass.
                var datum = datumOf(rule);
                counts.notEvaluated += 1;
                note(datum);
                record.outcome = OUTCOME.NOT_EVALUATED;
                record.missing = datum;
                if (keepRecords) records.push(record);
                return;
            }

            counts.evaluated += 1;
            if (!held) {
                counts.passed += 1;
                record.outcome = OUTCOME.PASSED;
                if (keepRecords) records.push(record);
                return;
            }

            var suppression = applySuppressors(rule, ctx);
            record.by = suppression.by;
            record.suppressors = suppression;
            if (suppression.by.length) {
                counts.suppressed += 1;
                record.outcome = OUTCOME.SUPPRESSED;
                if (keepRecords) records.push(record);
                return;
            }

            var anchor = rule.anchor ? rule.anchor(ctx) : { ip: ctx.ip, port: ctx.port };
            var key = rule.id + '|' + anchor.ip + '|' + (anchor.port === null ? '' : anchor.port);
            record.outcome = OUTCOME.FIRED;
            record.anchor = key;
            if (keepRecords) records.push(record);
            // Finding identity is (ruleId, deviceIp, port): an edge seen from both ends, or one rule
            // reaching one port twice, is one finding.
            if (anchored.has(key)) return;
            anchored.add(key);
            counts.fired += 1;
            findings.push({
                key: key, ruleId: rule.id, layer: rule.layer, severity: rule.severity, title: rule.title,
                scope: rule.scope, deviceIp: anchor.ip,
                hostname: (graph && graph.deviceByIp.get(anchor.ip) || ctx.device).Hostname,
                port: anchor.port === undefined ? null : anchor.port,
                evidence: rule.evidence ? rule.evidence(ctx) : defaultEvidence(rule, ctx),
                suppressed: false, suppressors: suppression,
            });
        });
        // Suppressed and fired subjects both had their condition computed, and a fired subject that lost
        // the anchor race is still one of them - so `evaluated` is not the sum of the other three.
    });

    findings.sort(function (x, y) { return x.key < y.key ? -1 : x.key > y.key ? 1 : 0; });
    return {
        findings: findings, records: records, stats: stats,
        rules: rules.map(function (rule) { return rule.id; }),
        subjectCounts: { device: subjects.device.length, port: subjects.port.length, edge: subjects.edge.length },
        graph: graph,
    };
}

function defaultEvidence(rule, ctx) {
    var evidence = {};
    if (rule.field) evidence[rule.field] = ctx.row ? ctx.row[rule.field] : ctx.device[rule.field];
    else if (rule.read) evidence.value = rule.read(ctx);
    return evidence;
}

var Rules = {
    evaluate: evaluate,
    RULES: RULES,
    OUTCOME: OUTCOME,
    FIELD_SECTION: FIELD_SECTION,
    SUPPRESSORS: SUPPRESSORS,
    COMPARATORS: COMPARATORS,
    NO_CONTRIBUTION: NO_CONTRIBUTION,
    RECENT_BOOT_SECONDS: RECENT_BOOT_SECONDS,
    advertisedAutoneg: advertisedAutoneg,
    cidrContains: cidrContains,
    vridOf: vridOf,
    VRRP_MAC_PREFIX: VRRP_MAC_PREFIX,
    advertisedFrameSize: advertisedFrameSize,
    orgInfo: orgInfo,
};

// Dual-mode export: node:test (CJS/ESM interop) vs. browser <script> (no `module`).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Rules;
} else if (typeof window !== 'undefined') {
    window.Rules = Rules;
}
