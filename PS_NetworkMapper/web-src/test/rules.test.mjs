// Section 3. The rule framework's guarantees, which are mostly about the two outcomes that are not
// "fired": a rule that could not see its input has to say so, and a rule whose condition held for a
// reason an operator already knows about has to say which one.
//
// The load-bearing test in this file is the Partial pair and its mutation. A rule reading an empty
// container on a truncated node looks exactly like a rule reading a healthy one, so the assertion is not
// only "NOT_EVALUATED on the Partial node" but "still NOT_EVALUATED after the missing field is filled in
// behind SectionsCaptured's back" - which is the state a field-list guard passes and a section guard does
// not.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Rules from '../rules.js';
import L2Graph from '../l2-graph.js';
import { byName, microNode, microRow, link, CAPTURE_SECTIONS, SCAN_TIMESTAMP } from '../tools/micro-topologies.mjs';

const { evaluate, RULES, OUTCOME, FIELD_SECTION, COMPARATORS, cidrContains, vridOf } = Rules;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const GENERATOR = path.join(ROOT, 'web-src', 'tools', 'generate-fixture.mjs');

const clone = (value) => structuredClone(value);
const snapshot = (devices) => ({ Topology: devices, ScanTimestamp: SCAN_TIMESTAMP });
const recordsFor = (result, ruleId, deviceIp) => result.records.filter(
    r => r.ruleId === ruleId && (deviceIp === undefined || r.deviceIp === deviceIp));
const only = (list) => { assert.equal(list.length, 1, `expected exactly one, got ${list.length}`); return list[0]; };

// A single switch with one fully-populated extensive row, so a rule's condition is the only variable.
// Every field FIELD_SECTION knows about is present: an absent field is a different test.
function detailRow(port, extra = {}) {
    return microRow(port, {
        Link: 'up', Admin: 'up',
        Mtu: 1514, SpeedConfigured: 'Auto', SpeedNegotiated: '1000 Mbps',
        Duplex: 'Full-duplex', DuplexNegotiated: 'Full-duplex',
        AutoNegotiation: 'Enabled', NegotiationStatus: 'Complete',
        MediaType: 'Copper', MacAddress: '02:ab:00:00:00:01', LinkLevelType: 'Ethernet',
        CarrierTransitions: 2, InputBytes: 700000, OutputBytes: 560000, InputBps: 1000, OutputBps: 800,
        InputErrors: { Errors: 0, Drops: 0, 'Framing errors': 0 },
        OutputErrors: { Errors: 0, Drops: 0, 'Carrier transitions': 2 },
        ActiveAlarms: 'None', ActiveDefects: 'None', StatisticsLastCleared: 'Never',
        InputPackets: 1000, OutputPackets: 800, RemoteFault: 'Online',
        InterfaceFlags: 'SNMP-Traps Internal: 0x4000', DeviceFlags: 'Present Running',
        BpduError: 'None', LoopDetectPduError: 'None', EthernetSwitchingError: 'None', MacRewriteError: 'None',
        MacStatistics: { 'CRC/Align errors': { Receive: 0, Transmit: 0 } },
        PcsStatistics: {}, FecStatistics: {},
        LastFlappedSeconds: 86400, LastFlappedState: 'Parsed',
        PoE: 'Unknown', PoeAdminStatus: null, PoeOperStatus: null, PoePairMode: null,
        PoeMaxPower: null, PoePriority: null, PoePowerConsumption: null, PoeClass: null,
        Dot1x: [],
        ...extra,
    });
}

// Uptime as the worker records it: a boot timestamp, not a duration.
function oneSwitch(rows, extra = {}) {
    const node = microNode('10.30.9.10', 'micro-rules.example.net', { ports: rows });
    node.CaptureTimestamp = SCAN_TIMESTAMP;
    node.Uptime = '2026-06-01 03:14:00 UTC';
    Object.assign(node, extra);
    return snapshot([node]);
}

const ruleOn = (rows, ruleId, extra) => {
    const result = evaluate(oneSwitch(rows, extra), { rules: [ruleId] });
    return { result, record: result.records[0] || null, finding: result.findings[0] || null };
};

// ---------------------------------------------------------------------------------------------------
// The guard framework

test('a field is declared against the section that supplies it, and the fixture drops both together', () => {
    const source = fs.readFileSync(GENERATOR, 'utf8');
    const block = /const SECTION_SUPPLIES = \{\n([\s\S]*?)\n\};\n/.exec(source);
    assert.ok(block, 'SECTION_SUPPLIES is no longer a single object literal in the generator');
    // Split on the top-level "NAME: (node) =>" headers; each body is what dropping that section costs.
    const bodies = new Map();
    let current = null;
    for (const raw of block[1].split('\n')) {
        // Comments out first: prose explaining a blanker is full of "word:" shapes that read as fields.
        const line = raw.replace(/\/\/.*$/, '');
        const header = /^    ([A-Z_0-9]+): \(node\) =>(.*)$/.exec(line);
        // The remainder of the header line counts: a one-field section is written on a single line.
        if (header) { current = header[1]; bodies.set(current, [header[2]]); continue; }
        if (current) bodies.get(current).push(line);
    }
    // Fields a section supplies that no rule reads yet. The list is the mechanism: when a rule starts
    // reading one, it moves out of here and into FIELD_SECTION.
    const UNREAD_BY_RULES = [
        'MasterCpuUtilization', 'MasterMemoryUtilization', 'LastConfigured', 'LastConfiguredBy',
        'Dot1x_State', 'Dot1x_User',
    ];
    for (const [section, lines] of bodies) {
        const text = lines.join('\n');
        const assigned = new Set([...text.matchAll(/(?:^|[\s{,.])([A-Za-z][A-Za-z0-9_]*)\s*[:=](?!=)/g)]
            .map(m => m[1]).filter(name => !['node', 'row', 'client', 'Receive', 'Transmit'].includes(name)));
        for (const field of assigned) {
            if (UNREAD_BY_RULES.includes(field)) continue;
            assert.equal(FIELD_SECTION[field], section,
                `the fixture drops ${field} with ${section}, so FIELD_SECTION has to name that section `
                + `for it (or the field belongs in UNREAD_BY_RULES in this test)`);
        }
        const declared = Object.keys(FIELD_SECTION).filter(f => FIELD_SECTION[f] === section);
        for (const field of declared) {
            assert.ok(assigned.has(field),
                `FIELD_SECTION says ${section} supplies ${field}, but the fixture's blanker for that `
                + `section leaves it behind - which is the false clean the guard exists to prevent`);
        }
    }
});

test('a truncated section and an unreported field are different missing datums', () => {
    const micro = byName('partial-node-missing-stp-section');
    const result = evaluate(micro.snapshot, { rules: ['duplex-half-on-up-link'] });
    // The Partial node lost the tail from STP onwards, extensive included.
    for (const record of recordsFor(result, 'duplex-half-on-up-link', micro.partialIp)) {
        assert.equal(record.outcome, OUTCOME.NOT_EVALUATED);
        assert.equal(record.missing, 'section:INTERFACES_EXT');
    }
    // The healthy node captured every section; its micro rows simply carry no extensive values.
    const healthy = recordsFor(result, 'duplex-half-on-up-link').filter(r => r.deviceIp !== micro.partialIp);
    assert.ok(healthy.length);
    for (const record of healthy) {
        assert.equal(record.outcome, OUTCOME.NOT_EVALUATED);
        assert.equal(record.missing, 'Interfaces[].Duplex');
    }
    assert.deepEqual(result.findings, []);
    assert.equal(result.stats['duplex-half-on-up-link'].evaluated, 0);
    assert.equal(result.stats['duplex-half-on-up-link'].notEvaluated, result.records.length);
});

test('filling a field the section never delivered does not make the rule evaluable', () => {
    const micro = byName('partial-node-missing-stp-section');
    const mutated = clone(micro.snapshot);
    const partial = mutated.Topology.find(d => String(d.DeviceIP) === micro.partialIp);
    // Exactly the state a needs: ['Interfaces[].Duplex'] guard would pass: the value is there, the
    // section is not, and half-duplex on an up port is the rule's own firing condition.
    partial.Interfaces[0].Duplex = 'Half-duplex';
    partial.Interfaces[0].Link = 'up';
    assert.equal(partial.SectionsCaptured.includes('INTERFACES_EXT'), false);
    const result = evaluate(mutated, { rules: ['duplex-half-on-up-link'] });
    const record = only(recordsFor(result, 'duplex-half-on-up-link', micro.partialIp).filter(r => r.port === 'xe-0/0/0'));
    assert.equal(record.outcome, OUTCOME.NOT_EVALUATED);
    assert.equal(record.missing, 'section:INTERFACES_EXT');
    assert.deepEqual(result.findings, []);
});

test('an empty counter container is NOT_EVALUATED, not a pass', () => {
    // Section 3.2's own example: InputErrors defaults to {} and serializes as {}, so a path check on the
    // container passes with zero data.
    const empty = ruleOn([detailRow('ge-0/0/0', { InputErrors: {} })], 'input-errors-present');
    assert.equal(empty.record.outcome, OUTCOME.NOT_EVALUATED);
    assert.equal(empty.record.missing, 'Interfaces[].InputErrors[Errors]');

    const zero = ruleOn([detailRow('ge-0/0/0')], 'input-errors-present');
    assert.equal(zero.record.outcome, OUTCOME.PASSED);

    const errors = ruleOn([detailRow('ge-0/0/0', { InputErrors: { Errors: 41 } })], 'input-errors-present');
    assert.equal(errors.record.outcome, OUTCOME.FIRED);
    assert.equal(errors.finding.evidence.value, 41);
});

test('a non-number reaching a numeric comparator is NOT_EVALUATED', () => {
    // 5e9 > null is true, which is why the type guard lives in the comparator and not in each rule.
    assert.equal(COMPARATORS.gt(null, 0), null);
    assert.equal(COMPARATORS.gt(undefined, 0), null);
    assert.equal(COMPARATORS.gt('41', 0), null);
    assert.equal(COMPARATORS.gt(41, 0), true);
    assert.equal(COMPARATORS.gt(0, 0), false);

    const stringly = ruleOn([detailRow('ge-0/0/0', { InputErrors: { Errors: '41' } })], 'input-errors-present');
    assert.equal(stringly.record.outcome, OUTCOME.NOT_EVALUATED);
    assert.equal(stringly.record.missing, 'Interfaces[].InputErrors[Errors]');
});

test('G-NOSCAN stops every rule on a device that contributed nothing', () => {
    const result = evaluate(oneSwitch([detailRow('ge-0/0/0', { Duplex: 'Half-duplex' })], {
        ScanStatus: 'Unreachable', ScanError: 'ssh: connect to host 10.30.9.10 port 22: No route to host',
    }));
    assert.deepEqual(result.findings, []);
    const evaluated = result.records.filter(r => r.outcome !== OUTCOME.NOT_EVALUATED);
    assert.deepEqual(evaluated, []);
    for (const record of result.records) assert.equal(record.missing, 'scan:Unreachable');
});

test('a two-ended rule reads a blank far end as unknown, never as agreement', () => {
    const a = microNode('10.30.9.10', 'micro-edge-a.example.net', { ports: [detailRow('xe-0/0/0', { Duplex: 'Half-duplex' })] });
    const b = microNode('10.30.9.11', 'micro-edge-b.example.net', { ports: [detailRow('xe-0/0/0')] });
    link(a, 'xe-0/0/0', b, 'xe-0/0/0');
    const both = evaluate(snapshot([clone(a), clone(b)]), { rules: ['duplex-mismatch'] });
    const finding = only(both.findings);
    // Anchored at the half-duplex end, once, though both ends are subjects.
    assert.equal(finding.deviceIp, '10.30.9.10');
    assert.equal(finding.port, 'xe-0/0/0');
    assert.equal(finding.evidence.far.duplex, 'Full-duplex');
    assert.equal(both.records.length, 2);

    const timedOut = clone(b);
    timedOut.ScanStatus = 'Timeout';
    timedOut.Interfaces = [];
    timedOut.Neighbors = [];
    timedOut.SectionsCaptured = [];
    const half = evaluate(snapshot([clone(a), timedOut]), { rules: ['duplex-mismatch'] });
    assert.deepEqual(half.findings, []);
    const missing = half.records.map(r => r.missing).sort();
    assert.deepEqual(missing, ['far.scan:Timeout', 'scan:Timeout']);
});

// ---------------------------------------------------------------------------------------------------
// Section 3.4's three traps

test('a down port is not a subject of a duplex rule, and an up one is', () => {
    // All 25 link-down ports in the measured capture print Half-duplex.
    const dark = ruleOn([detailRow('ge-0/0/0', { Link: 'down', Admin: 'up', Duplex: 'Half-duplex' })], 'duplex-half-on-up-link');
    assert.deepEqual(dark.result.records, []);
    assert.equal(dark.result.stats['duplex-half-on-up-link'].skipped, 1);

    const live = ruleOn([detailRow('ge-0/0/0', { Duplex: 'Half-duplex' })], 'duplex-half-on-up-link');
    assert.equal(live.record.outcome, OUTCOME.FIRED);
    assert.equal(live.finding.severity, 'warning');
});

test('output drops are not an error to any rule', () => {
    // The healthiest access port in the capture carries 14,635 drops against zero errors both ways.
    const result = evaluate(oneSwitch([detailRow('ge-0/0/0', {
        OutputErrors: { Errors: 0, Drops: 14635, 'Carrier transitions': 2 },
        InputErrors: { Errors: 0, Drops: 9000, 'Framing errors': 0 },
    })]));
    assert.deepEqual(result.findings, []);
});

test('a LINK alarm is a fault on an up port and noise on a down one', () => {
    const up = ruleOn([detailRow('ge-0/0/0', { ActiveAlarms: 'LINK' })], 'link-alarm-on-up-port');
    assert.equal(up.record.outcome, OUTCOME.FIRED);
    const down = ruleOn([detailRow('ge-0/0/0', { Link: 'down', ActiveAlarms: 'LINK', Duplex: 'Half-duplex' })], 'link-alarm-on-up-port');
    assert.deepEqual(down.result.records, []);
});

// ---------------------------------------------------------------------------------------------------
// Suppression (section 3.3)

test('a suppressor names itself on the record, and an unevaluable one leaves the finding standing', () => {
    const med = {
        MedNeighbors: [{
            LocalPort: 'ge-0/0/0.0', Manufacturer: 'Contoso Telecom', ModelName: 'CT-4100',
            SerialNumber: 'CTX000000001', HardwareRevision: 'CT4100-A1', SoftwareRevision: '6.8.5',
        }],
    };
    const rows = [detailRow('ge-0/0/0', { AutoNegotiation: 'Disabled' }), detailRow('ge-0/0/1', { AutoNegotiation: 'Disabled' })];

    const result = evaluate(oneSwitch(clone(rows), med), { rules: ['autoneg-disabled'] });
    const suppressed = only(recordsFor(result, 'autoneg-disabled').filter(r => r.port === 'ge-0/0/0'));
    assert.equal(suppressed.outcome, OUTCOME.SUPPRESSED);
    assert.deepEqual(suppressed.by, ['faces-med-endpoint']);
    const fired = only(result.findings);
    assert.equal(fired.port, 'ge-0/0/1');
    assert.deepEqual(fired.suppressors.evaluated, ['faces-med-endpoint']);
    assert.deepEqual(fired.suppressors.unevaluated, []);
    assert.equal(result.stats['autoneg-disabled'].suppressed, 1);
    assert.equal(result.stats['autoneg-disabled'].fired, 1);
    assert.equal(result.stats['autoneg-disabled'].evaluated, 2);

    // The LLDP section never arrived, so whether the port faces an endpoint is unknown - which is not
    // the same as knowing it does not.
    const blind = clone(oneSwitch(clone(rows), med));
    blind.Topology[0].SectionsCaptured = CAPTURE_SECTIONS.filter(s => s !== 'LLDP');
    blind.Topology[0].MedNeighbors = [];
    const unknown = evaluate(blind, { rules: ['autoneg-disabled'] });
    assert.equal(unknown.findings.length, 2);
    for (const finding of unknown.findings) {
        assert.deepEqual(finding.suppressors.unevaluated, ['faces-med-endpoint']);
        assert.deepEqual(finding.suppressors.evaluated, []);
    }
});

test('a device that booted within the hour suppresses its own flap findings', () => {
    const rows = [detailRow('ge-0/0/0', { LastFlappedSeconds: 600, LastFlappedState: 'Parsed' })];
    const settled = ruleOn(clone(rows), 'port-flapped-recently');
    assert.equal(settled.record.outcome, OUTCOME.FIRED);

    const justBooted = evaluate(oneSwitch(clone(rows), { Uptime: '2026-09-08 14:22:07 UTC' }), { rules: ['port-flapped-recently'] });
    const record = only(justBooted.records);
    assert.equal(record.outcome, OUTCOME.SUPPRESSED);
    assert.deepEqual(record.by, ['recently-rebooted']);

    // Uptime is fifth-from-last in the batch, so its absence is a real state and G-BASELINE's answer to
    // it is "cannot tell", not "assume a long uptime".
    const noUptime = evaluate(oneSwitch(clone(rows), { Uptime: 'Unknown' }), { rules: ['port-flapped-recently'] });
    assert.deepEqual(only(noUptime.findings).suppressors.unevaluated, ['recently-rebooted']);

    // "Never" is the healthy state C5 kept a separate field for, and it is not a missing duration.
    const never = ruleOn([detailRow('ge-0/0/0', { LastFlappedSeconds: null, LastFlappedState: 'Never' })], 'port-flapped-recently');
    assert.equal(never.record.outcome, OUTCOME.PASSED);
});

// ---------------------------------------------------------------------------------------------------
// The LLDP-only rules (R2) and the aggregate rule (section 5.3)

test('the neighbour advertisement is compared against the local row, in the real TLV wording', () => {
    assert.equal(Rules.advertisedAutoneg('Autonegotiation [supported, enabled (0x3)], PMD Autonegotiation Capability (0xc036), MAU Type (0x0)'), 'Enabled');
    assert.equal(Rules.advertisedAutoneg('Autonegotiation [supported, disabled (0x1)], PMD Autonegotiation Capability (0xc036), MAU Type (0x0)'), 'Disabled');
    // The form 27 of the capture's 43 blocks advertise, every one of them a switch on an optical port:
    // the field is unavailable, which is no evidence either way rather than evidence of "off".
    assert.equal(Rules.advertisedAutoneg('Autonegotiation [not supported, disabled (0x0)], PMD Autonegotiation Capability (0x0), MAU Type (0x0)'), null);
    assert.equal(Rules.advertisedFrameSize('MTU Size (1514)'), 1514);

    const a = microNode('10.30.9.10', 'micro-tlv-a.example.net', { ports: [detailRow('xe-0/0/0', { AutoNegotiation: 'Disabled' })] });
    const b = microNode('10.30.9.11', 'micro-tlv-b.example.net', { ports: [detailRow('xe-0/0/0')] });
    link(a, 'xe-0/0/0', b, 'xe-0/0/0');
    const result = evaluate(snapshot([a, b]), { rules: ['autoneg-mismatch', 'mtu-mismatch'] });
    // A's local row says disabled while B advertises enabled; B's row and A's advertisement agree.
    const mismatch = only(result.findings.filter(f => f.ruleId === 'autoneg-mismatch'));
    assert.equal(mismatch.deviceIp, '10.30.9.10');
    assert.deepEqual([mismatch.evidence.local, mismatch.evidence.advertised], ['Disabled', 'Enabled']);
    // The micro TLV advertises 9216 against a local 1514, which is G5's whole point.
    assert.equal(result.findings.filter(f => f.ruleId === 'mtu-mismatch').length, 2);

    // No neighbour on the port is not a missing datum: the rule has no subject there.
    const alone = evaluate(oneSwitch([detailRow('ge-0/0/9')]), { rules: ['autoneg-mismatch'] });
    assert.deepEqual(alone.records, []);
    assert.equal(alone.stats['autoneg-mismatch'].skipped, 1);
});

test('an aggregate with a down member is one finding on the bundle', () => {
    const down = evaluate(byName('lag-two-members-one-down').snapshot, { rules: ['lag-member-down'] });
    assert.equal(down.findings.length, 2);   // both ends of the micro topology have the same member down
    for (const finding of down.findings) {
        assert.equal(finding.port, 'ae0');
        assert.deepEqual(finding.evidence.members.map(m => m.link), ['up', 'down']);
    }
    const up = evaluate(byName('lag-two-members-up').snapshot, { rules: ['lag-member-down'] });
    assert.deepEqual(up.findings, []);
    // The members themselves are not subjects: only a row that owns a bundle is.
    assert.equal(up.stats['lag-member-down'].skipped, up.subjectCounts.port - 2);
});

test('a rule may not be selected by a name no rule has', () => {
    assert.throws(() => evaluate(oneSwitch([detailRow('ge-0/0/0')]), { rules: ['no-such-rule'] }), /unknown rule/);
    // Every rule declares only suppressors the engine knows, checked by running all of them.
    assert.doesNotThrow(() => evaluate(oneSwitch([detailRow('ge-0/0/0', {
        AutoNegotiation: 'Disabled', NegotiationStatus: 'Incomplete', RemoteFault: 'Local',
        ActiveAlarms: 'LINK', BpduError: 'Detected', LoopDetectPduError: 'Detected',
        EthernetSwitchingError: 'Detected', MacRewriteError: 'Detected',
        InputErrors: { Errors: 1, 'Framing errors': 1 }, OutputErrors: { Errors: 1 },
        MacStatistics: { 'CRC/Align errors': { Receive: 1 } },
        LastFlappedSeconds: 10, LastFlappedState: 'Parsed',
        PoE: 'Enabled (0.0W)', PoeAdminStatus: 'Disabled', PoeOperStatus: 'Denied',
        Dot1x: [{ Interface: 'ge-0/0/0.0', Role: 'Authenticator', State: 'Held', MacAddress: '02:ab:00:00:00:09', User: null }],
    })])));
});

// ---------------------------------------------------------------------------------------------------
// Fixture scale

function generate(args) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pnm_rules_'));
    execFileSync(process.execPath, [GENERATOR, '--out', out, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    const names = fs.readdirSync(out).filter(f => /^NetworkMap_.*\.fixture\.json$/.test(f)).sort();
    const manifests = fs.readdirSync(out).filter(f => /^FaultManifest_.*\.fixture\.json$/.test(f)).sort();
    return {
        dir: out, names,
        snapshots: names.map(n => JSON.parse(fs.readFileSync(path.join(out, n), 'utf8'))),
        faults: manifests.map(n => JSON.parse(fs.readFileSync(path.join(out, n), 'utf8'))),
    };
}

const ARGS = ['--devices', '60', '--seed', '5', '--snapshots', '2'];
// The fleet addresses out of 10.0.0.0/8, and the scopes are the caller's: without them
// client-outside-scope has no question to answer and says so rather than guessing.
const FLEET = { allowedScopes: ['10.'] };
const clean = generate(ARGS);
// One fault per injector plus a wrap, so every injector places at least once in every snapshot.
const faulted = generate([...ARGS, '--faults', '44']);

test('the clean fleet holds no disagreement between two ends of one wire', () => {
    for (const snap of clean.snapshots) {
        const result = evaluate(snap, { rules: ['duplex-mismatch', 'autoneg-mismatch', 'mtu-mismatch',
            'vlan-absent-on-one-trunk-end', 'stp-both-ends-claim-segment', 'stp-scope-drift', 'lldp-one-sided',
            'native-vlan-mismatch'] });
        assert.deepEqual(result.findings.map(f => `${f.ruleId} ${f.deviceIp} ${f.port}`), [],
            'a wire property drawn per end rather than per wire shows up here as the fault the '
            + 'injector is supposed to be the only source of');
        // Not vacuous: the rules ran on real subjects. The two that need a duplex or an autonegotiation
        // state at both ends only have subjects on the fleet's copper trunks - on optics neither field
        // exists - so their floor is much lower than the MTU rule's, which optics do report.
        assert.ok(result.stats['mtu-mismatch'].evaluated > 50, `mtu ${result.stats['mtu-mismatch'].evaluated}`);
        for (const id of ['autoneg-mismatch', 'duplex-mismatch']) {
            assert.ok(result.stats[id].evaluated > 10, `${id} evaluated ${result.stats[id].evaluated}`);
        }
        // The L2 pair comparisons have a subject on every edge, both ends: a VLAN set, a spanning-tree
        // instance and an LLDP reciprocity are all properties of the wire rather than of the transceiver.
        for (const id of ['vlan-absent-on-one-trunk-end', 'stp-both-ends-claim-segment', 'stp-scope-drift',
            'lldp-one-sided', 'native-vlan-mismatch']) {
            assert.ok(result.stats[id].evaluated > 100, `${id} evaluated ${result.stats[id].evaluated}`);
        }
    }
});

test('every rule reaches the fleet, and the counts add up per subject', () => {
    const result = evaluate(clean.snapshots[0], FLEET);
    const idle = RULES.filter(rule => {
        const stats = result.stats[rule.id];
        return stats.evaluated === 0 && stats.notEvaluated === 0;
    }).map(rule => rule.id);
    // Three subject shapes a healthy fleet does not contain: no aggregate exists at all (spec 8.2), and
    // an unmanaged bridge between two switches or a neighbour nobody scanned is a defect rather than a
    // shape - each is injected, and each is covered by the delta oracle below. Any OTHER rule appearing
    // here means a subject shape that does not exist anywhere.
    assert.deepEqual(idle, ['lag-member-down', 'shared-segment-not-a-link', 'neighbour-never-scanned']);

    for (const rule of RULES) {
        const stats = result.stats[rule.id];
        const records = recordsFor(result, rule.id);
        const byOutcome = (outcome) => records.filter(r => r.outcome === outcome).length;
        assert.equal(byOutcome(OUTCOME.NOT_EVALUATED), stats.notEvaluated, `${rule.id} notEvaluated`);
        assert.equal(byOutcome(OUTCOME.PASSED), stats.passed, `${rule.id} passed`);
        assert.equal(byOutcome(OUTCOME.SUPPRESSED), stats.suppressed, `${rule.id} suppressed`);
        // Fired records can exceed fired findings: an edge is a subject from both ends and one finding.
        assert.ok(byOutcome(OUTCOME.FIRED) >= stats.fired, `${rule.id} fired`);
        assert.equal(stats.evaluated, byOutcome(OUTCOME.PASSED) + byOutcome(OUTCOME.SUPPRESSED) + byOutcome(OUTCOME.FIRED));
        for (const datum of Object.keys(stats.missing)) {
            assert.ok(datum.startsWith('section:') || datum.startsWith('scan:') || datum.startsWith('far.')
                || datum.startsWith('Interfaces[') || datum.startsWith('Device.') || datum.startsWith('Neighbors[')
                || datum.startsWith('option:'),
                `${rule.id} reports an unrecognisable missing datum: ${datum}`);
        }
    }
});

test('a truncated node in the fleet explains its silence by section, not by field', () => {
    const snap = clean.snapshots[0];
    const truncated = snap.Topology.filter(d => d.ScanStatus === 'Ok' && !d.SectionsCaptured.includes('INTERFACES_EXT'));
    assert.ok(truncated.length, 'the fixture stopped producing truncated captures; this test is now vacuous');
    const result = evaluate(snap, { rules: ['duplex-half-on-up-link'] });
    for (const device of truncated) {
        const records = recordsFor(result, 'duplex-half-on-up-link', String(device.DeviceIP));
        assert.ok(records.length);
        for (const record of records) assert.equal(record.missing, 'section:INTERFACES_EXT');
    }
    assert.equal(result.stats['duplex-half-on-up-link'].missing['section:INTERFACES_EXT'] > 0, true);
});

// A subject filter that reads a field its own section supplies would skip a truncated port instead of
// letting the guard speak, turning "the capture stopped early" into "not a subject" - silence with no
// datum named. Stated for INTERFACES_EXT, the one section the fixture's truncation actually drops: every
// rule that reads a field from it must show that section among its missing data.
const EXT_DEPENDENT = RULES.filter(rule => rule.layer === 'L1').map(rule => rule.id)
    .filter(id => ['poe-admin-disabled-with-endpoint', 'poe-denied', 'lag-member-down',
        'dot1x-held', 'dot1x-auth-failed', 'dot1x-unauthenticated-traffic',
        'dot1x-fallback-vlan'].indexOf(id) === -1);
const NO_EXT_DEPENDENCE = RULES.map(rule => rule.id).filter(id => EXT_DEPENDENT.indexOf(id) === -1);

test('no rule lets a truncated extensive section pass as "not a subject"', () => {
    const result = evaluate(clean.snapshots[0], FLEET);
    for (const id of EXT_DEPENDENT) {
        assert.ok((result.stats[id].missing['section:INTERFACES_EXT'] || 0) > 0,
            `${id} never reports section:INTERFACES_EXT - a subject filter is reading a blanked field`);
    }
    for (const id of NO_EXT_DEPENDENCE) {
        assert.equal(result.stats[id].missing['section:INTERFACES_EXT'] || 0, 0,
            `${id} now depends on INTERFACES_EXT; move it out of the exception list`);
    }
});

// The DOT1X counterpart, which the fixture cannot produce: truncation loses the tail of the batch, so a
// lost DOT1X section only exists here. An empty supplicant list means "no supplicant" once the section has
// arrived, and "the capture stopped" before it - the distinction the dot1x subject filter now makes.
test('a lost DOT1X section is NOT_EVALUATED, not a port without supplicants', () => {
    const rules = ['dot1x-held', 'dot1x-auth-failed', 'dot1x-unauthenticated-traffic'];
    const rows = [detailRow('ge-0/0/4', { Dot1x: [], PoeAdminStatus: 'Enabled', PoeOperStatus: 'OFF' })];
    const blind = oneSwitch(rows, { SectionsCaptured: CAPTURE_SECTIONS.filter(s => s !== 'DOT1X') });
    const result = evaluate(blind, { rules });
    assert.equal(result.records.length, rules.length);
    for (const record of result.records) {
        assert.equal(record.outcome, OUTCOME.NOT_EVALUATED, record.ruleId);
        assert.equal(record.missing, 'section:DOT1X', record.ruleId);
    }
    // And with the section present the same empty list is no subject at all: no record, not a pass.
    assert.deepEqual(evaluate(oneSwitch(rows), { rules }).records, []);
});

// The same shape for every mid-batch section an L2 or L3 rule reads. Truncation only ever loses the tail,
// so none of these states exists at fixture scale: a rule that quietly skipped when its section was gone
// would look identical to one that has nothing to say, and only this catches the difference.
const SECTION_SUBJECTS = [
    ['STP', ['stp-port-not-converged']],
    ['MAC_TABLE', ['duplicate-mac-across-devices', 'mac-in-vlan-not-on-port']],
    ['ARP_TABLE', ['duplicate-ip-two-macs']],
    ['ROUTE', ['default-route-unreadable', 'gateway-not-on-a-local-subnet']],
    ['INTERFACES_TERSE', ['routed-unit-down']],
];

test('a lost section is NOT_EVALUATED for every rule that reads it', () => {
    for (const [section, rules] of SECTION_SUBJECTS) {
        const row = detailRow('ge-0/0/4', {
            Vlans: [{ Name: 'VLAN_STAFF', Tag: 20, Unit: 'ge-0/0/4.0', Active: true }],
            StpDetail: { 'instance 0': { State: 'FWD', Role: 'DESG', Cost: 20000 } },
        });
        const node = oneSwitch([row], {
            SectionsCaptured: CAPTURE_SECTIONS.filter(s => s !== section),
            MacTable: [{ RoutingInstance: 'default-switch', VlanName: 'VLAN_STAFF', MacAddress: 'AA:BB:00:00:00:01',
                Flags: 'D', Age: null, Interface: 'ge-0/0/4.0', PhysicalPort: 'ge-0/0/4' }],
            ArpEntries: [{ MAC: 'AA:BB:00:00:00:01', IP: '10.30.9.50' }],
        });
        const result = evaluate(node, { rules, allowedScopes: ['10.'] });
        assert.ok(result.records.length >= rules.length, `${section}: ${result.records.length} records`);
        for (const record of result.records) {
            assert.equal(record.outcome, OUTCOME.NOT_EVALUATED, `${section} ${record.ruleId}`);
            assert.equal(record.missing, `section:${section}`, `${section} ${record.ruleId}`);
        }
    }
});

test('the scopes are the caller\'s, and without them the scope rule says so rather than guessing', () => {
    const rows = [detailRow('ge-0/0/4')];
    const node = oneSwitch(rows, {
        Clients: [{ IP: '192.0.2.7', MAC: 'AA:BB:00:00:00:09', Port: 'ge-0/0/4.0', PortDesc: 'Unknown',
            VLAN_Name: 'VLAN_STAFF', VLAN_Tag: 20, Type: 'Dynamic', Dot1x_User: 'Unknown', Dot1x_State: 'Unknown' }],
    });
    const blind = evaluate(node, { rules: ['client-outside-scope'] });
    assert.equal(blind.records[0].outcome, OUTCOME.NOT_EVALUATED);
    assert.equal(blind.records[0].missing, 'option:allowedScopes');
    const told = evaluate(node, { rules: ['client-outside-scope'], allowedScopes: ['10.'] });
    assert.equal(told.records[0].outcome, OUTCOME.FIRED);
    assert.equal(told.findings[0].evidence.clients[0].ip, '192.0.2.7');
});

test('one-sided LLDP is a finding between two live switches and a missing section on a truncated one', () => {
    // The rule has no subject filter on ScanStatus, deliberately: the guards and G-NOSCAN are what
    // answer for an end that could not speak, and a filter would turn those answers back into silence.
    const a = microNode('10.30.7.10', 'micro-one-sided-a.example.net', { ports: ['xe-0/0/0'] });
    const b = microNode('10.30.7.11', 'micro-one-sided-b.example.net', { ports: ['xe-0/0/0'] });
    link(a, 'xe-0/0/0', b, 'xe-0/0/0');
    b.Neighbors = [];   // B never reports A: LLDP off at that end, or a one-way pair
    const live = evaluate(snapshot([a, b]), { rules: ['lldp-one-sided'] });
    assert.equal(live.findings.length, 1, JSON.stringify(live.records));
    assert.equal(live.findings[0].deviceIp, '10.30.7.10');

    // The same silence from a node whose capture stopped before LLDP is not evidence of anything, and
    // the record says which section rather than reporting the link as fine or skipping it outright.
    const micro = byName('partial-node-missing-stp-section');
    const truncated = evaluate(micro.snapshot, { rules: ['lldp-one-sided'] });
    assert.deepEqual(truncated.findings, []);
    assert.ok(truncated.records.length);
    for (const record of truncated.records) {
        assert.equal(record.outcome, OUTCOME.NOT_EVALUATED);
        assert.ok(['section:LLDP', 'far.section:LLDP'].includes(record.missing), record.missing);
    }
});

test('a VRRP virtual MAC is not a duplicated host', () => {
    // 00:00:5e:00:01:<VRID>, which every router in the group answers for by design. Section 6.4 reports
    // the VIP beside its gateway pick; a rule reading it as one host on two switches would fire on every
    // redundant gateway in the estate.
    assert.equal(vridOf('00:00:5e:00:01:0a'), 0x0a);
    assert.equal(vridOf('aa:bb:00:00:00:01'), null);
    const vip = (ip, port) => oneSwitch([detailRow(port)], {
        DeviceIP: ip, Hostname: `micro-${ip}.example.net`,
        MacTable: [{ RoutingInstance: 'default-switch', VlanName: 'VLAN_STAFF', MacAddress: '00:00:5e:00:01:0a',
            Flags: 'D', Age: null, Interface: `${port}.0`, PhysicalPort: port }],
    }).Topology[0];
    const both = { Topology: [vip('10.30.9.10', 'ge-0/0/4'), vip('10.30.9.11', 'ge-0/0/5')], ScanTimestamp: SCAN_TIMESTAMP };
    assert.deepEqual(evaluate(both, { rules: ['duplicate-mac-across-devices'] }).findings, []);
});

test('poe-denied matches the documented FAULT vocabulary, in any case, and nothing else', () => {
    // Section 3.5's first open question, narrowed by documentation: the column is ON / OFF / FAULT /
    // Disabled. OFF with Admin Enabled is the ordinary "nothing is plugged in" state and must stay a
    // pass, or the rule fires on every empty jack in the estate.
    const port = (status) => ({
        Port: 'ge-0/0/1', Link: 'up', Admin: 'up', PoeAdminStatus: 'Enabled', PoeOperStatus: status,
        Vlans: [], Dot1x: [], StpDetail: {},
    });
    const fire = (status) => {
        const device = {
            DeviceIP: '10.30.1.1', Hostname: 'poe', ScanStatus: 'Ok', SectionsCaptured: ['POE'],
            Interfaces: [port(status)], Clients: [], MacTable: [], Neighbors: [], ArpEntries: [],
        };
        const out = evaluate([device], { rules: ['poe-denied'] });
        return out.findings.length;
    };
    assert.equal(fire('FAULT'), 1);
    assert.equal(fire('Fault'), 1, 'the column\'s case is not stable across releases');
    assert.equal(fire('OFF'), 0, 'nothing plugged in is not a fault');
    assert.equal(fire('ON'), 0);
    assert.equal(fire('Disabled'), 0);
});

test('a prefix contains the addresses inside it and nothing else', () => {
    assert.equal(cidrContains('10.30.9.10/24', '10.30.9.1'), true);
    assert.equal(cidrContains('10.30.9.10/24', '10.30.10.1'), false);
    // Above 127: the operands go through ToInt32 on both sides of the mask, which is only correct
    // because both sides do.
    assert.equal(cidrContains('192.0.2.10/24', '192.0.2.254'), true);
    assert.equal(cidrContains('172.16.0.5/12', '172.31.255.254'), true);
    assert.equal(cidrContains('172.16.0.5/12', '172.32.0.1'), false);
    // Unreadable input is unmeasured, never containment: the rule treats null as "cannot tell".
    assert.equal(cidrContains('10.30.9.10', '10.30.9.1'), null);
    assert.equal(cidrContains('10.30.9.10/24', 'Unknown'), null);
});

test('the reboot suppressor is evaluable on a real fixture device', () => {
    // Uptime is a boot timestamp string, so this is really an assertion that the format parses at all:
    // an unparseable one would silently turn every reboot suppressor into "cannot tell".
    const result = evaluate(clean.snapshots[0], { rules: ['port-flapped-recently'] });
    const decided = result.records.filter(r => r.suppressors && r.suppressors.evaluated.includes('recently-rebooted'));
    assert.ok(decided.length > 0, 'no device in the fleet had an Uptime this engine could read');
});

// ---------------------------------------------------------------------------------------------------
// The rules the section 4.3 commands unblocked (item 15). Every field they read is UNVERIFIED on
// hardware (spec 4.3.1), which is the reason each of these asserts the unmeasured case as loudly as the
// firing one: if a release prints these stanzas differently, the parser returns nothing and the right
// answer is a NOT_EVALUATED row in the histogram, never a clean fleet.

// G5. The brief form of "show vlans" annotates nothing, so Tagged is null on every member - and null is
// unmeasured (section 2.5). A fleet captured that way must report the gap, not pass.
test('a capture with no tagged/untagged annotation is NOT_EVALUATED for the native VLAN, not clean', () => {
    const snap = clone(clean.snapshots[0]);
    for (const device of snap.Topology) {
        for (const row of device.Interfaces || []) {
            for (const member of row.Vlans || []) { member.Tagged = null; member.Mode = null; }
        }
        for (const vlan of device.Vlans || []) {
            for (const member of vlan.Interfaces || []) { member.Tagged = null; member.Mode = null; }
        }
    }
    const result = evaluate(snap, { rules: ['native-vlan-mismatch'] });
    const stats = result.stats['native-vlan-mismatch'];
    assert.deepEqual(result.findings, [], 'an unannotated capture cannot state a native VLAN either way');
    assert.equal(stats.evaluated, 0, 'nothing was evaluable, so nothing may be counted as evaluated');
    assert.ok(stats.notEvaluated > 100, `only ${stats.notEvaluated} ends reported the gap`);
    assert.ok(stats.missing['Interfaces[].Vlans[].Tagged'] > 0
        || stats.missing['far.Interfaces[].Vlans[].Tagged'] > 0,
        `the gap was named ${JSON.stringify(stats.missing)} rather than by the annotation it needs`);
});

test('a trunk end whose untagged VLAN differs from its peer is one finding on the wire', () => {
    const snap = clone(clean.snapshots[0]);
    const before = evaluate(snap, { rules: ['native-vlan-mismatch'] });
    assert.deepEqual(before.findings, [], 'the clean fleet agrees on every trunk by construction');
    // Move one end's native VLAN to another tag the SAME trunk already carries, so nothing but the
    // annotation changes - no VLAN appears or disappears, and both ends still forward.
    const device = snap.Topology.find(d => (d.Interfaces || []).some(row => {
        const trunk = (row.Vlans || []).filter(v => v.Mode === 'trunk');
        return trunk.filter(v => v.Tagged === false).length === 1 && trunk.length > 1;
    }));
    assert.ok(device, 'the fixture no longer has a trunk carrying more than one VLAN');
    const row = device.Interfaces.find(r => {
        const trunk = (r.Vlans || []).filter(v => v.Mode === 'trunk');
        return trunk.filter(v => v.Tagged === false).length === 1 && trunk.length > 1;
    });
    const trunk = row.Vlans.filter(v => v.Mode === 'trunk');
    // Both members are picked before either is changed: flipping one and then searching for "the tagged
    // one" would find the member just flipped and put it straight back.
    const was = trunk.find(v => v.Tagged === false);
    const now = trunk.find(v => v.Tagged === true);
    was.Tagged = true;
    now.Tagged = false;
    const after = evaluate(snap, { rules: ['native-vlan-mismatch'] });
    // One finding, not two: the rule anchors on the lower end of the wire, whichever end the engine
    // reached first.
    assert.equal(after.findings.length, 1, JSON.stringify(after.findings.map(f => `${f.deviceIp} ${f.port}`)));
    const ends = [String(device.DeviceIP), String(after.findings[0].evidence.farIp)];
    assert.ok(ends.includes(String(after.findings[0].deviceIp)));
    assert.notEqual(after.findings[0].evidence.here, after.findings[0].evidence.far);
});

// G4. The bridge view carries a change COUNT and an AGE, and only the age is read: with no previous
// snapshot to subtract it from, a large count is an old switch rather than a fault.
test('a recent topology change is a finding; a large change count on its own is not', () => {
    const snap = clone(clean.snapshots[0]);
    for (const device of snap.Topology) {
        for (const stanza of device.StpBridge || []) stanza.TopologyChangeCount = 900000;
    }
    assert.deepEqual(evaluate(snap, { rules: ['stp-topology-change-recent'] }).findings, [],
        'the count alone fired, which is the comparison that needs a baseline (G-BASELINE)');

    const device = snap.Topology.find(d => (d.StpBridge || []).length);
    assert.ok(device, 'the fixture no longer carries a bridge view');
    device.StpBridge[0].TimeSinceLastChangeSeconds = 42;
    const result = evaluate(snap, { rules: ['stp-topology-change-recent'] });
    const finding = only(result.findings);
    assert.equal(String(finding.deviceIp), String(device.DeviceIP));
    assert.equal(finding.port, null, 'the bridge view is per bridge, not per port');
    const scope = only(finding.evidence.scopes);
    assert.equal(scope.scope, device.StpBridge[0].Scope);
    assert.equal(scope.seconds, 42);
    // Joined to the per-port view on the scope string, so the finding names ports rather than only a VLAN.
    assert.ok(scope.ports.length > 0, 'no port was joined to the scope that reconverged');
});

test('a bridge view that prints no age at all is NOT_EVALUATED, not a quiet tree', () => {
    const snap = clone(clean.snapshots[0]);
    for (const device of snap.Topology) {
        for (const stanza of device.StpBridge || []) stanza.TimeSinceLastChangeSeconds = null;
    }
    const result = evaluate(snap, { rules: ['stp-topology-change-recent'] });
    const stats = result.stats['stp-topology-change-recent'];
    assert.deepEqual(result.findings, []);
    assert.equal(stats.evaluated, 0);
    assert.ok(stats.missing['Device.StpBridge[].TimeSinceLastChangeSeconds'] > 0,
        `named ${JSON.stringify(stats.missing)} instead`);
});

// The dot1x detail stanza. Fires on the landing, not on the configuration: a guest VLAN that exists and
// nobody is in is the normal case.
test('a supplicant authenticated into the guest VLAN is reported, and one in its own VLAN is not', () => {
    const dot1x = (state, authVlan, guestVlan) => [{
        Interface: 'ge-0/0/3.0', Role: 'Authenticator', State: state,
        MacAddress: '02:ab:00:00:00:09', User: 'host/desk-14',
        AuthenticatedVlan: authVlan, GuestVlan: guestVlan,
    }];
    const on = (rows) => ruleOn([detailRow('ge-0/0/3', { Dot1x: rows })], 'dot1x-fallback-vlan');

    const placed = on(dot1x('Authenticated', 'STAFF', 'GUEST'));
    assert.equal(placed.record.outcome, OUTCOME.PASSED);

    const fallback = on(dot1x('Authenticated', 'GUEST', 'GUEST'));
    assert.equal(fallback.record.outcome, OUTCOME.FIRED);
    assert.equal(only(fallback.finding.evidence.clients).vlan, 'GUEST');

    // Not authenticated at all is another rule's finding, not this one's.
    assert.equal(on(dot1x('Held', null, 'GUEST')).record.outcome, OUTCOME.PASSED);
    // No guest VLAN configured on the port: nothing to fall back INTO.
    assert.equal(on(dot1x('Authenticated', 'STAFF', null)).record.outcome, OUTCOME.PASSED);
    // The brief form names no VLAN, and an authenticated port with none is unmeasured rather than placed.
    const brief = on(dot1x('Authenticated', null, 'GUEST'));
    assert.equal(brief.record.outcome, OUTCOME.NOT_EVALUATED);
    assert.equal(brief.record.missing, 'Interfaces[].Dot1x[].AuthenticatedVlan');
});

// ---------------------------------------------------------------------------------------------------
// The delta oracle (section 8.3)
//
// The fleet is byte-identical between --faults 0 and --faults 30 apart from the faults, so the findings
// the faults are responsible for are exactly the set difference. Two directions, and both matter: every
// finding the manifest promised has to appear, and every finding that appeared has to be attributable to
// a fault the manifest names. The second is what catches a rule that fires on collateral - a defect
// planted on one port that the engine reports on an unrelated one.

const RULE_IDS = RULES.map(r => r.id);
const located = (finding) => `${finding.ruleId} ${finding.deviceIp} ${finding.port}`;

// The one rule with no fixture injector: the fixture holds no aggregate at all, and inventing one inside
// injectFaults would put ordinary topology behind a fault manifest. The micro-topology covers it.
const NO_INJECTOR = ['lag-member-down'];

test('one injector per rule, and the manifest says which rule each fault is for', () => {
    const promised = new Set(faulted.faults.flatMap(m => m.Faults)
        .map(f => f.expected && f.expected.finding).filter(id => RULE_IDS.includes(id)));
    assert.deepEqual([...promised].sort(), RULE_IDS.filter(id => NO_INJECTOR.indexOf(id) === -1).sort());
});

test('the findings a faulted fleet grows are exactly the faults the manifest names', () => {
    for (const [index, snap] of faulted.snapshots.entries()) {
        const before = new Set(evaluate(clean.snapshots[index], { records: false, ...FLEET }).findings.map(located));
        const after = evaluate(snap, { records: false, ...FLEET }).findings;
        const delta = after.filter(f => !before.has(located(f)));
        const afterKeys = new Set(after.map(located));
        const vanished = [...before].filter(key => !afterKeys.has(key));
        assert.deepEqual(vanished, [], 'an injected fault took an unrelated finding away with it');

        const manifest = faulted.faults[index].Faults;
        assert.equal(faulted.faults[index].Map, faulted.names[index]);
        // Every location a fault touched: the device and port it names, plus the far end where the fault
        // is a property of a wire and both ends can see it.
        const touched = new Set();
        for (const fault of manifest) {
            // Device-scope faults carry a null port, and so do the findings they produce: "10.0.0.1 null"
            // matches a device-wide finding on that device and nothing else.
            touched.add(`${fault.deviceIp} ${fault.port === undefined ? null : fault.port}`);
            const params = fault.params || {};
            if (params.peerIp && params.peerPort) touched.add(`${params.peerIp} ${params.peerPort}`);
            // A MAC planted on one switch is a duplicate at BOTH places it is now learned, and the
            // manifest names the other one - the fault is the pair, not the copy.
            if (params.alsoOn && params.alsoOnPort) touched.add(`${params.alsoOn} ${params.alsoOnPort}`);
            if (params.silentIp && params.silentPort) touched.add(`${params.silentIp} ${params.silentPort}`);
            // A shared segment is two ports facing one bridge: both of them are the fault.
            if (params.otherIp && params.otherPort) touched.add(`${params.otherIp} ${params.otherPort}`);
        }
        for (const fault of manifest) {
            if (!fault.expected || !RULE_IDS.includes(fault.expected.finding)) continue;
            const wanted = `${fault.expected.finding} ${fault.expected.deviceIp} ${fault.expected.port}`;
            assert.ok(delta.some(f => located(f) === wanted),
                `the manifest promised ${wanted} in snapshot ${index} and the engine did not report it`);
        }
        for (const finding of delta) {
            assert.ok(touched.has(`${finding.deviceIp} ${finding.port}`),
                `snapshot ${index} grew ${located(finding)}, which no manifest entry accounts for`);
        }
        assert.ok(delta.length >= 16, `only ${delta.length} findings changed; the oracle is going soft`);
    }
});

test.after(() => {
    for (const run of [clean, faulted]) fs.rmSync(run.dir, { recursive: true, force: true });
});
