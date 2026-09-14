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

const { evaluate, RULES, OUTCOME, FIELD_SECTION, COMPARATORS } = Rules;
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
    assert.equal(Rules.advertisedAutoneg('Autonegotiation [not supported, disabled (0x0)], PMD Autonegotiation Capability (0x0), MAU Type (0x0)'), 'Disabled');
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
const clean = generate(ARGS);
// One fault per injector plus a wrap, so every L1 injector places at least once in every snapshot.
const faulted = generate([...ARGS, '--faults', '30']);

test('the clean fleet holds no disagreement between two ends of one wire', () => {
    for (const snap of clean.snapshots) {
        const result = evaluate(snap, { rules: ['duplex-mismatch', 'autoneg-mismatch', 'mtu-mismatch'] });
        assert.deepEqual(result.findings.map(f => `${f.ruleId} ${f.deviceIp} ${f.port}`), [],
            'a wire property drawn per end rather than per wire shows up here as the fault the '
            + 'injector is supposed to be the only source of');
        // Not vacuous: the rules ran on real subjects.
        for (const id of ['autoneg-mismatch', 'mtu-mismatch']) assert.ok(result.stats[id].evaluated > 50);
        assert.ok(result.stats['duplex-mismatch'].evaluated > 50);
    }
});

test('every rule reaches the fleet, and the counts add up per subject', () => {
    const result = evaluate(clean.snapshots[0]);
    const idle = RULES.filter(rule => {
        const stats = result.stats[rule.id];
        return stats.evaluated === 0 && stats.notEvaluated === 0;
    }).map(rule => rule.id);
    // The fixture holds no aggregate at all (noted in spec 8.2), so this rule is exercised only by the
    // micro topology above. Any other rule appearing here means a subject shape that does not exist.
    assert.deepEqual(idle, ['lag-member-down']);

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
                || datum.startsWith('Interfaces[') || datum.startsWith('Device.') || datum.startsWith('Neighbors['),
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

test('the reboot suppressor is evaluable on a real fixture device', () => {
    // Uptime is a boot timestamp string, so this is really an assertion that the format parses at all:
    // an unparseable one would silently turn every reboot suppressor into "cannot tell".
    const result = evaluate(clean.snapshots[0], { rules: ['port-flapped-recently'] });
    const decided = result.records.filter(r => r.suppressors && r.suppressors.evaluated.includes('recently-rebooted'));
    assert.ok(decided.length > 0, 'no device in the fleet had an Uptime this engine could read');
});

// ---------------------------------------------------------------------------------------------------
// The delta oracle (section 8.3)
//
// The fleet is byte-identical between --faults 0 and --faults 30 apart from the faults, so the findings
// the faults are responsible for are exactly the set difference. Two directions, and both matter: every
// finding the manifest promised has to appear, and every finding that appeared has to be attributable to
// a fault the manifest names. The second is what catches a rule that fires on collateral - a defect
// planted on one port that the engine reports on an unrelated one.

const L1_RULE_IDS = RULES.map(r => r.id);
const located = (finding) => `${finding.ruleId} ${finding.deviceIp} ${finding.port}`;

test('one injector per L1 rule, and the manifest says which rule each fault is for', () => {
    const promised = new Set(faulted.faults.flatMap(m => m.Faults)
        .map(f => f.expected && f.expected.finding).filter(id => L1_RULE_IDS.includes(id)));
    // lag-member-down is the documented exception: the fixture holds no aggregate, so its injector would
    // have to invent ordinary topology behind a fault manifest. The micro-topology covers it.
    assert.deepEqual([...promised].sort(), L1_RULE_IDS.filter(id => id !== 'lag-member-down').sort());
});

test('the findings a faulted fleet grows are exactly the faults the manifest names', () => {
    for (const [index, snap] of faulted.snapshots.entries()) {
        const before = new Set(evaluate(clean.snapshots[index], { records: false }).findings.map(located));
        const after = evaluate(snap, { records: false }).findings;
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
            if (fault.port) touched.add(`${fault.deviceIp} ${fault.port}`);
            const params = fault.params || {};
            if (params.peerIp && params.peerPort) touched.add(`${params.peerIp} ${params.peerPort}`);
        }
        for (const fault of manifest) {
            if (!fault.expected || !L1_RULE_IDS.includes(fault.expected.finding)) continue;
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
