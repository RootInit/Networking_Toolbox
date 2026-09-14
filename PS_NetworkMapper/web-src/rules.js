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
    Vlans: 'VLANS', StpDetail: 'STP', STP: 'STP',
    Bundle: 'INTERFACES_TERSE', BundleMembers: 'INTERFACES_TERSE',
    Admin: 'INTERFACES_TERSE', Link: 'INTERFACES_TERSE', Desc: 'INTERFACES_DESC',
    // Device-level.
    Neighbors: 'LLDP', MedNeighbors: 'LLDP', MacTable: 'MAC_TABLE', ArpEntries: 'ARP_TABLE',
    Uptime: 'UPTIME', Alarms: 'ALARMS', Configuration: 'CONFIG',
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

function missingOn(sections, holder, prefix, field) {
    var section = FIELD_SECTION[field];
    if (section && sections.indexOf(section) === -1) return 'section:' + section;
    var value = holder ? holder[field] : undefined;
    if (value === null || value === undefined) return prefix + field;
    return null;
}

function needPort(ctx, field) { return missingOn(ctx.facts.sections, ctx.row, 'Interfaces[].', field); }
function needDevice(ctx, field) { return missingOn(ctx.facts.sections, ctx.device, 'Device.', field); }

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
        // PROVISIONAL vocabulary. The measured capture's PoE table prints only ON and OFF in the
        // Oper-status column, and OFF with Admin Enabled is the ordinary "nothing plugged in" state - so
        // the fault values below are derived from Junos documentation rather than observed, and the
        // fixture's injector plants one of them. A pass here is evidence the plumbing works, not that
        // these are the strings a PoE fault prints. Confirm against hardware with item 12.
        id: 'poe-denied', layer: 'L1', severity: 'error', scope: 'port',
        title: 'PoE reports a fault state on the port',
        only: poeCapable,
        guard: function (ctx) { return needPort(ctx, 'PoeOperStatus'); },
        field: 'PoeOperStatus', cmp: 'in', value: ['Fault', 'Denied', 'Power-Denied', 'Overload', 'Powered-down'],
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

function buildSubjects(devices, factsByIp, graph) {
    var ports = [];
    var deviceSubjects = [];
    devices.forEach(function (device) {
        var ip = String(device.DeviceIP);
        var facts = factsByIp.get(ip);
        deviceSubjects.push({ scope: 'device', device: device, ip: ip, port: null, facts: facts });
        asList(device.Interfaces).forEach(function (row) {
            if (!row || !row.Port) return;
            ports.push({ scope: 'port', device: device, ip: ip, port: String(row.Port), row: row, facts: facts });
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
                facts: facts, farFacts: farFacts,
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

    var needsGraph = rules.some(function (rule) { return rule.scope === 'edge'; });
    var graph = opts.graph || (needsGraph && L2 ? L2.buildPortGraph(devices, { allowedScopes: opts.allowedScopes }) : null);
    var subjects = buildSubjects(devices, factsByIp, graph);

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
    advertisedFrameSize: advertisedFrameSize,
    orgInfo: orgInfo,
};

// Dual-mode export: node:test (CJS/ESM interop) vs. browser <script> (no `module`).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Rules;
} else if (typeof window !== 'undefined') {
    window.Rules = Rules;
}
