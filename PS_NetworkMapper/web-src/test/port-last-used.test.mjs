// port-last-used-spec.md section 9.2, case for case.
//
// The cases that matter most are the ones asserting a NEGATIVE: a delta below the rate floor is not
// active, a reboot does not make a busy port never-used, and a null counter produces neither a state
// nor a silent pass. Those are the three ways this module would ship a confidently wrong answer.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PortLastUsed from '../port-last-used.js';

const { computeLastUsed, buildHistories, splitOnResets, STATE, UNKNOWN_REASON } = PortLastUsed;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const GENERATOR = path.join(ROOT, 'web-src', 'tools', 'generate-fixture.mjs');

const DAY = 86400000;
const T0 = Date.parse('2026-09-01T12:00:00.000Z');

// One observation, with everything measured unless the case says otherwise. Written as a builder
// rather than a literal per case so that "this field is null" is visible as the single difference.
function obs(overrides) {
    return Object.assign({
        tsMs: T0,
        port: 'ge-0/0/12',
        scanStatus: 'Ok',
        sections: ['INTERFACES_EXT', 'LLDP', 'MAC_TABLE', 'UPTIME'],
        admin: 'up',
        link: 'up',
        inputBytes: 0,
        inputPackets: 0,
        outputBytes: 0,
        inputBps: 0,
        carrierTransitions: 1,
        lastFlappedSeconds: null,
        statisticsLastCleared: 'Never',
        uptimeSeconds: 21 * 86400,
        lldpAgeSeconds: null,
        macs: { dynamic: 0, total: 0 },
    }, overrides);
}

function history(observations, extra) {
    return Object.assign({ port: 'ge-0/0/12', deviceKey: 'serial:ABC123', keyTypes: ['serial'], observations }, extra);
}

const sourcesOf = (r) => r.evidence.map(e => e.source);

// One device, one port, one snapshot, read through the real intake path - which is where the
// per-source section gate lives.
function onePortHistory(spec) {
    const device = {
        DeviceIP: '10.0.0.1',
        Hostname: 'test-switch',
        ScanStatus: spec.ScanStatus,
        CaptureTimestamp: new Date(T0).toISOString(),
        SectionsCaptured: spec.SectionsCaptured,
        StackMembers: [{ FPC: '0', Serial: 'ABC123', IsMaster: true }],
        UptimeSeconds: 21 * 86400,
        FpcUptimes: [{ FPC: '0', UptimeSeconds: 21 * 86400, SystemBooted: null }],
        Neighbors: [], MedNeighbors: [], MacTable: [],
        Interfaces: [spec.row],
    };
    const built = buildHistories([{ ScanTimestamp: new Date(T0).toISOString(), Topology: [device] }]);
    const found = built.find(h => h.port === spec.row.Port);
    assert.ok(found, 'buildHistories produced no history for the port');
    return found;
}

// Every path, on every case in this file - section 2.1 says evidence and caveats are always populated,
// and a result that explains nothing is as unusable as a wrong one.
function wellFormed(result) {
    assert.ok(Array.isArray(result.evidence), 'evidence must always be an array');
    assert.ok(Array.isArray(result.caveats), 'caveats must always be an array');
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'lastActive'));
    assert.ok(['high', 'medium', 'low'].includes(result.confidence));
    return result;
}

const run = (h, o) => wellFormed(computeLastUsed(h, o));

// ---------------------------------------------------------------------------------------------
// E0 - LLDP age, the one source not bounded by the scan cadence
// ---------------------------------------------------------------------------------------------

test('LLDP age of 12 s is active now, at second resolution rather than the scan gap', () => {
    const r = run(history([obs({ lldpAgeSeconds: 12, inputBytes: 5e9, inputPackets: 8e6 })]));
    assert.equal(r.state, STATE.ACTIVE_NOW);
    assert.equal(r.confidence, 'high');
    assert.equal(r.resolution, 1, 'E0 is a switch-clock read, not an inter-snapshot bound');
    assert.equal(r.lastActive.notAfter, T0);
    assert.equal(r.lastActive.notBefore, T0 - 12000);
});

test('LLDP age of 900 s bounds the answer at 15 minutes, not "idle since the last scan"', () => {
    const r = run(history([obs({ lldpAgeSeconds: 900, inputBytes: 5e9, inputPackets: 8e6 })]));
    assert.equal(r.state, STATE.IDLE_SINCE);
    assert.equal(r.lastActive.notBefore, T0 - 900000);
    assert.ok(sourcesOf(r).includes('E0'));
    assert.match(r.evidence.find(e => e.source === 'E0').detail, /TTL/,
        'past the TTL the entry is retained, which is a different claim from live');
});

// ---------------------------------------------------------------------------------------------
// The cumulative counter with a single snapshot
// ---------------------------------------------------------------------------------------------

test('one snapshot, zero input, three weeks of uptime: never used this epoch, bounded at the epoch', () => {
    const r = run(history([obs({ inputBytes: 0, inputPackets: 0 })]));
    assert.equal(r.state, STATE.NEVER_USED_THIS_EPOCH);
    assert.equal(r.lastActive.notAfter, T0 - 21 * 86400 * 1000, 'notAfter is epochStart');
    assert.equal(r.confidence, 'high');
});

test('one snapshot with input above zero is idle since the epoch, never active', () => {
    const r = run(history([obs({ inputBytes: 9e8, inputPackets: 1e6 })]));
    assert.equal(r.state, STATE.IDLE_SINCE);
    assert.equal(r.lastActive.notBefore, T0 - 21 * 86400 * 1000);
    assert.ok(sourcesOf(r).includes('E4'));
});

// ---------------------------------------------------------------------------------------------
// E3 - the workhorse, and the floor that keeps it honest
// ---------------------------------------------------------------------------------------------

test('a delta above the floor is active now, and the interval is the gap that bounds it', () => {
    const r = run(history([
        obs({ tsMs: T0 - 7 * DAY, inputBytes: 1e9, inputPackets: 1.7e6 }),
        obs({ tsMs: T0, inputBytes: 2e9, inputPackets: 3.4e6 }),
    ]));
    assert.equal(r.state, STATE.ACTIVE_NOW);
    assert.equal(r.resolution, 7 * 86400);
    assert.equal(r.lastActive.notBefore, T0 - 7 * DAY);
    assert.equal(r.lastActive.notAfter, T0);
});

test('a delta of 64 B frames at 0.1 pps is a transmitter present, NOT active', () => {
    // Section 2.3's regression test, and the reason the state has that name: this is the powered,
    // unattended NIC, and it is exactly the port a reclaim view exists to surface.
    const seconds = 7 * 86400;
    const packets = Math.round(0.1 * seconds);
    const r = run(history([
        obs({ tsMs: T0 - 7 * DAY, inputBytes: 1e9, inputPackets: 1e7 }),
        obs({ tsMs: T0, inputBytes: 1e9 + packets * 64, inputPackets: 1e7 + packets }),
    ]));
    assert.equal(r.state, STATE.TRANSMITTER_PRESENT);
    assert.match(r.evidence.find(e => e.source === 'E3').detail, /below the rate floor/);
});

test('output growing while input is flat is idle - output is corroboration, never evidence', () => {
    // A switch floods broadcast and multicast out every port in the VLAN whether or not anything is
    // listening, so output climbs on a port whose device is powered off but still linked.
    const r = run(history([
        obs({ tsMs: T0 - 7 * DAY, inputBytes: 1e9, inputPackets: 1e6, outputBytes: 2e9 }),
        obs({ tsMs: T0, inputBytes: 1e9, inputPackets: 1e6, outputBytes: 9e9 }),
    ]));
    assert.equal(r.state, STATE.IDLE_SINCE);
    assert.ok(!sourcesOf(r).includes('E3'), 'no input delta, so the workhorse contributed nothing');
});

// ---------------------------------------------------------------------------------------------
// Section 5.2 - the segment rule revision 1 got dangerously wrong
// ---------------------------------------------------------------------------------------------

test('activity, then a reboot, then quiet is idle since - never "never used"', () => {
    const r = run(history([
        obs({ tsMs: T0 - 14 * DAY, inputBytes: 9e11, inputPackets: 1e9, uptimeSeconds: 30 * 86400 }),
        obs({ tsMs: T0 - 7 * DAY, inputBytes: 9.2e11, inputPackets: 1.02e9, uptimeSeconds: 37 * 86400 }),
        // Rebooted four days before this scan: uptime fell, so the counters below start a new epoch.
        obs({ tsMs: T0, inputBytes: 0, inputPackets: 0, uptimeSeconds: 4 * 86400 }),
    ]));
    assert.notEqual(r.state, STATE.NEVER_USED_THIS_EPOCH,
        'a port carrying 900 GB four days ago must never land on the reclaim list');
    assert.equal(r.state, STATE.IDLE_SINCE);
    assert.ok(r.lastActive.notBefore <= T0 - 7 * DAY && r.lastActive.notAfter <= T0);
    assert.ok(r.caveats.some(c => c.includes('reboot')));
});

test('never-used requires zero input in every observation of every segment', () => {
    const r = run(history([
        obs({ tsMs: T0 - 14 * DAY, inputBytes: 0, inputPackets: 0, uptimeSeconds: 30 * 86400 }),
        obs({ tsMs: T0, inputBytes: 0, inputPackets: 0, uptimeSeconds: 4 * 86400 }),
    ]));
    assert.equal(r.state, STATE.NEVER_USED_THIS_EPOCH);
});

// ---------------------------------------------------------------------------------------------
// Section 2.4 - null is unmeasured, and the single most likely way this ships a wrong answer
// ---------------------------------------------------------------------------------------------

test('a null counter in one snapshot produces no false active, no false reset and no false idle', () => {
    const r = run(history([
        obs({ tsMs: T0 - 14 * DAY, inputBytes: 1e9, inputPackets: 1e6 }),
        obs({ tsMs: T0 - 7 * DAY, inputBytes: null, inputPackets: null }),
        obs({ tsMs: T0, inputBytes: 3e9, inputPackets: 5e6 }),
    ]));
    // The delta is taken across the pair that WAS measured, skipping the blank rather than reading it
    // as zero - which would be both a reset and then a huge delta.
    assert.equal(r.state, STATE.ACTIVE_NOW);
    assert.ok(!r.caveats.some(c => c.includes('counter-decreased')), 'a blank counter is not a reset');
    assert.equal(r.lastActive.notBefore, T0 - 14 * DAY, 'the bound spans the window actually measured');
});

test('every counter null at once yields UNKNOWN with the reason, not a clean idle', () => {
    const r = run(history([
        obs({ tsMs: T0 - 7 * DAY, inputBytes: null, inputPackets: null, inputBps: null, uptimeSeconds: null }),
        obs({ tsMs: T0, inputBytes: null, inputPackets: null, inputBps: null, uptimeSeconds: null }),
    ]));
    assert.equal(r.state, STATE.UNKNOWN);
    assert.equal(r.reason, UNKNOWN_REASON.NO_USABLE_OBSERVATION);
    assert.ok(r.caveats.includes('no-counter-was-measured-in-any-observation'));
});

// One generic pass over every counter, because section 2.4 calls this the single most likely way the
// feature ships a confidently wrong answer: blanking any one field must never invent activity.
test('blanking any single numeric field never produces an active claim on a quiet port', () => {
    const fields = ['inputBytes', 'inputPackets', 'outputBytes', 'inputBps', 'carrierTransitions',
        'lastFlappedSeconds', 'uptimeSeconds', 'lldpAgeSeconds'];
    for (const field of fields) {
        const r = run(history([
            obs({ tsMs: T0 - 7 * DAY, [field]: null }),
            obs({ tsMs: T0, [field]: null }),
        ]));
        assert.ok(r.state !== STATE.ACTIVE_NOW && r.state !== STATE.TRANSMITTER_PRESENT,
            `blanking ${field} made a quiet port look used (${r.state})`);
        wellFormed(r);
    }
});

test('a truncated capture gates each source, so a blank counter is never read as a real zero', () => {
    // Section 3. On a Partial node E1/E3/E4/E5/E7 are unavailable and the gate is per source, not a
    // filter at intake: the JSON still carries whatever the parser left in those fields, and a zero
    // that was never measured is exactly what produces the strongest claim in the model.
    // Through buildHistories, because the gate is where an observation is read off a device - a real
    // truncated node's JSON carries the fields whatever the parser left in them.
    const r = run(onePortHistory({
        ScanStatus: 'Partial',
        SectionsCaptured: ['VERSION', 'INTERFACES_TERSE', 'STP'],
        row: { Port: 'ge-0/0/12', Admin: 'up', Link: 'up', InputBytes: 0, InputPackets: 0 },
    }));
    assert.notEqual(r.state, STATE.NEVER_USED_THIS_EPOCH,
        'a counter the capture never reached must not read as "nothing ever arrived here"');
    assert.equal(r.state, STATE.UNKNOWN);
    assert.ok(r.caveats.includes('section-not-captured:INTERFACES_EXT'));
});

test('a snapshot older than R15 carries no section list and is read in full, not refused', () => {
    // SectionsCaptured did not exist before R15. An empty list means "nothing was recorded about
    // sections", and treating it as "no section arrived" would make every port in an old snapshot
    // UNKNOWN - a regression dressed up as caution.
    const r = run(onePortHistory({
        ScanStatus: 'Ok',
        SectionsCaptured: [],
        row: { Port: 'ge-0/0/12', Admin: 'up', Link: 'up', InputBytes: 0, InputPackets: 0 },
    }));
    assert.equal(r.state, STATE.NEVER_USED_THIS_EPOCH);
    assert.ok(!r.caveats.some(c => c.startsWith('section-not-captured')));
});

test('an Unknown uptime is neither a reset nor a continuation, and says so', () => {
    const r = run(history([
        obs({ tsMs: T0 - 7 * DAY, inputBytes: 1e9, inputPackets: 1e6, uptimeSeconds: 30 * 86400 }),
        obs({ tsMs: T0, inputBytes: 2e9, inputPackets: 2e6, uptimeSeconds: null }),
    ]));
    assert.ok(r.caveats.some(c => c.includes('uptime-unknown')));
    assert.ok(!r.caveats.some(c => c.includes('counter-epoch-boundary:reboot')), 'unknown is not a reboot');
});

// ---------------------------------------------------------------------------------------------
// Section 4.3 - reset detection
// ---------------------------------------------------------------------------------------------

test('a counter cleared without a reboot is a reset, even when the bytes after are higher', () => {
    const r = run(history([
        obs({ tsMs: T0 - 7 * DAY, inputBytes: 5e9, inputPackets: 8e6, statisticsLastCleared: 'Never' }),
        obs({
            tsMs: T0, inputBytes: 9e9, inputPackets: 1.4e7, uptimeSeconds: 28 * 86400,
            statisticsLastCleared: '2026-08-30 09:00:00 UTC (2d 03:00 ago)',
        }),
    ]));
    assert.ok(r.caveats.some(c => c.includes('statistics-cleared')));
    assert.ok(!sourcesOf(r).includes('E3'), 'no delta may be taken across a clear');
});

test('a non-master FPC reboot resets that member s ports and leaves the others alone', () => {
    const rebooted = [
        obs({ tsMs: T0 - 7 * DAY, port: 'ge-1/0/4', inputBytes: 5e9, inputPackets: 8e6, uptimeSeconds: 30 * 86400 }),
        obs({ tsMs: T0, port: 'ge-1/0/4', inputBytes: 1e6, inputPackets: 2e3, uptimeSeconds: 2 * 86400 }),
    ];
    const untouched = [
        obs({ tsMs: T0 - 7 * DAY, port: 'ge-0/0/4', inputBytes: 5e9, inputPackets: 8e6, uptimeSeconds: 30 * 86400 }),
        obs({ tsMs: T0, port: 'ge-0/0/4', inputBytes: 6e9, inputPackets: 9e6, uptimeSeconds: 37 * 86400 }),
    ];
    const a = run(history(rebooted, { port: 'ge-1/0/4' }));
    const b = run(history(untouched, { port: 'ge-0/0/4' }));
    assert.ok(a.caveats.some(c => c.includes('reboot')));
    assert.ok(!b.caveats.some(c => c.includes('reboot')), 'the other member did not reboot');
    assert.equal(b.state, STATE.ACTIVE_NOW);
});

test('splitOnResets is G-BASELINE: it returns the boundaries and what caused each', () => {
    const { segments, boundaries } = splitOnResets([
        obs({ tsMs: T0 - 14 * DAY, uptimeSeconds: 30 * 86400 }),
        obs({ tsMs: T0 - 7 * DAY, uptimeSeconds: 2 * 86400 }),
        obs({ tsMs: T0, uptimeSeconds: 9 * 86400 }),
    ]);
    assert.equal(segments.length, 2);
    assert.deepEqual(boundaries.map(b => b.reason), ['reboot']);
});

// ---------------------------------------------------------------------------------------------
// Ordering, idempotency and the shapes a loaded window actually produces
// ---------------------------------------------------------------------------------------------

test('snapshots supplied out of order are sorted, and no resolution is negative', () => {
    const rows = [
        obs({ tsMs: T0, inputBytes: 3e9, inputPackets: 5e6 }),
        obs({ tsMs: T0 - 7 * DAY, inputBytes: 1e9, inputPackets: 1.7e6 }),
    ];
    const r = run(history(rows));
    assert.ok(r.resolution > 0);
    assert.equal(r.lastActive.notAfter, T0);
});

test('the same snapshot loaded twice does not change the answer', () => {
    const once = run(history([
        obs({ tsMs: T0 - 7 * DAY, inputBytes: 1e9, inputPackets: 1.7e6 }),
        obs({ tsMs: T0, inputBytes: 3e9, inputPackets: 5e6 }),
    ]));
    const twice = run(history([
        obs({ tsMs: T0 - 7 * DAY, inputBytes: 1e9, inputPackets: 1.7e6 }),
        obs({ tsMs: T0, inputBytes: 3e9, inputPackets: 5e6 }),
        obs({ tsMs: T0, inputBytes: 3e9, inputPackets: 5e6 }),
    ]));
    assert.equal(twice.state, once.state);
    assert.deepEqual(twice.lastActive, once.lastActive);
    assert.ok(twice.caveats.some(c => c.startsWith('duplicate-snapshots-ignored')));
});

test('an observation from a device that never answered is discarded, not read as zero', () => {
    const r = run(history([
        obs({ tsMs: T0 - 7 * DAY, inputBytes: 1e9, inputPackets: 1.7e6 }),
        obs({ tsMs: T0 - 3 * DAY, scanStatus: 'Timeout', inputBytes: null, inputPackets: null }),
        obs({ tsMs: T0, inputBytes: 3e9, inputPackets: 5e6 }),
    ]));
    assert.ok(r.caveats.some(c => c.startsWith('observations-from-unscanned-devices-ignored')));
    assert.equal(r.state, STATE.ACTIVE_NOW);
});

test('admin down is DISABLED and never reaches the counter walk', () => {
    const r = run(history([obs({ admin: 'down', link: 'down', inputBytes: 0, inputPackets: 0 })]));
    assert.equal(r.state, STATE.DISABLED);
});

test('a port in no loaded snapshot is a different UNKNOWN from one whose data was unusable', () => {
    const absent = run(history([]));
    assert.equal(absent.state, STATE.UNKNOWN);
    assert.equal(absent.reason, UNKNOWN_REASON.NOT_PRESENT);
    const unusable = run(history([obs({ scanStatus: 'Unreachable' })]));
    assert.equal(unusable.reason, UNKNOWN_REASON.NO_USABLE_OBSERVATION);
});

// ---------------------------------------------------------------------------------------------
// E2 - the MAC table, and what P5 bought
// ---------------------------------------------------------------------------------------------

test('a static MAC alone does not satisfy E2', () => {
    // P5's whole point: a static or persistent entry was configured and says nothing about traffic.
    const r = run(history([obs({ macs: { dynamic: 0, total: 1 }, inputBytes: 0, inputPackets: 0 })]));
    assert.ok(!sourcesOf(r).includes('E2'));
});

test('a dynamic MAC bounds the answer at the aging time, and says the time is assumed', () => {
    const r = run(history([obs({ macs: { dynamic: 1, total: 1 }, inputBytes: 5e8, inputPackets: 1e6 })]));
    assert.ok(sourcesOf(r).includes('E2'));
    assert.ok(r.caveats.some(c => c.includes('mac-aging-time-assumed')));
});

test('more than four MACs on a port downgrades E2s confidence', () => {
    const many = computeLastUsed(history([obs({ macs: { dynamic: 6, total: 6 }, inputBytes: 5e8, inputPackets: 1e6 })]));
    const one = computeLastUsed(history([obs({ macs: { dynamic: 1, total: 1 }, inputBytes: 5e8, inputPackets: 1e6 })]));
    const e2 = (r) => r.evidence.find(e => e.source === 'E2');
    assert.ok(e2(many) && e2(one));
    // "Something down there transmitted" stops being a statement about this port once an unmanaged
    // switch or a hypervisor is behind it.
    assert.equal(many.confidence === one.confidence, false);
});

// ---------------------------------------------------------------------------------------------
// Section 6 - identity, and section 4.2's boot filter
// ---------------------------------------------------------------------------------------------

test('a device whose key type changed is one merged history with a caveat, not two rows', () => {
    const r = run(history([obs({ tsMs: T0 - 7 * DAY }), obs({ tsMs: T0 })], { keyTypes: ['serial', 'hostname'] }));
    assert.ok(r.caveats.some(c => c.startsWith('device-identity-changed-key-type')));
});

test('the boot stamp is filtered out of E8, and a genuine post-boot flap is not', () => {
    const atBoot = run(history([obs({ lastFlappedSeconds: 21 * 86400, uptimeSeconds: 21 * 86400 })]));
    assert.ok(!sourcesOf(atBoot).includes('E8'), 'the flap IS the boot event');
    const later = run(history([obs({ lastFlappedSeconds: 3600, uptimeSeconds: 21 * 86400 })]));
    assert.ok(sourcesOf(later).includes('E8'));
});

test('a zero carrier-transition count discards E8 as a guard', () => {
    const r = run(history([obs({ lastFlappedSeconds: 500, carrierTransitions: 0, uptimeSeconds: 21 * 86400 })]));
    assert.ok(!sourcesOf(r).includes('E8'), 'no transition ever occurred, so the stamp is an ifd-init artifact');
});

// ---------------------------------------------------------------------------------------------
// Fleet scale, against the real generator
// ---------------------------------------------------------------------------------------------

function generate(args) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pnm_plu_'));
    execFileSync(process.execPath, [GENERATOR, '--out', out, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    const names = fs.readdirSync(out).filter(f => /^NetworkMap_.*\.fixture\.json$/.test(f)).sort();
    return names.map(n => JSON.parse(fs.readFileSync(path.join(out, n), 'utf8')));
}

const snapshots = generate(['--devices', '40', '--seed', '11']);

test('the loaded window is the resolution window: every port resolves to a state with evidence', () => {
    const histories = buildHistories(snapshots);
    assert.ok(histories.length > 500, `only ${histories.length} port histories built`);
    const states = new Map();
    for (const h of histories) {
        const r = wellFormed(computeLastUsed(h));
        states.set(r.state, (states.get(r.state) || 0) + 1);
    }
    // The fixture's live ports carry cumulative counters that climb between snapshots and its dark
    // ports carry zero, so both ends of the model have to appear. A run that produced only UNKNOWN
    // would pass every case above and still be useless.
    assert.ok((states.get(STATE.ACTIVE_NOW) || 0) + (states.get(STATE.TRANSMITTER_PRESENT) || 0) > 50,
        `no port reads as carrying traffic: ${JSON.stringify([...states])}`);
    assert.ok((states.get(STATE.NEVER_USED_THIS_EPOCH) || 0) > 10,
        `no dark port reads as never used: ${JSON.stringify([...states])}`);
});

test('the chattering ports the fixture plants are transmitters, not active ports', () => {
    // Section 2.3, end to end: the generator gives a minority of live ports ~72 B frames at a fraction
    // of a packet per second, and the floor is what keeps them off the active list.
    const results = buildHistories(snapshots).map(h => computeLastUsed(h));
    const e3 = (r) => r.evidence.find(e => e.source === 'E3');
    const belowFloor = results.filter(r => e3(r) && /below the rate floor/.test(e3(r).detail));
    assert.ok(belowFloor.length > 0, 'no port fell below the rate floor, so the floor is untested at scale');
    for (const r of belowFloor) {
        // A chatterer whose far end is an LLDP speaker really is active: E0 is a direct read that the
        // neighbour transmitted seconds ago, and it outranks a delta the floor could not promote. What
        // must not happen is a below-floor delta promoting itself.
        const hasLldp = r.evidence.some(e => e.source === 'E0');
        if (!hasLldp) assert.equal(r.state, STATE.TRANSMITTER_PRESENT, `${r.deviceKey} ${r.port}`);
    }
    assert.ok(belowFloor.some(r => r.state === STATE.TRANSMITTER_PRESENT),
        'every chattering port had an LLDP neighbour, so the floor decided nothing');
});

// Section 9.3's six injections are the delta oracle for the states: each manifest entry names a port
// and the state it was planted to produce, and computeLastUsed has to agree.
test('every planted port reports the state its manifest entry promised', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pnm_plu_faults_'));
    execFileSync(process.execPath, [GENERATOR, '--out', out, '--devices', '60', '--seed', '5',
        '--snapshots', '2', '--faults', '50'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const names = fs.readdirSync(out).filter(f => /^NetworkMap_.*\.fixture\.json$/.test(f)).sort();
    const manifests = fs.readdirSync(out).filter(f => /^FaultManifest_/.test(f)).sort()
        .map(n => JSON.parse(fs.readFileSync(path.join(out, n), 'utf8')));

    let checked = 0;
    for (let i = 0; i < names.length; i++) {
        const window = names.slice(0, i + 1)
            .map(n => JSON.parse(fs.readFileSync(path.join(out, n), 'utf8')));
        // The window up to and including the snapshot the fault was planted in - which is what the
        // operator has loaded, and what makes the reboot and the counter clear the cases they are:
        // both are statements about a CHANGE, and the snapshot they land in cannot carry one alone.
        const snapshot = window[window.length - 1];
        const byPort = new Map(buildHistories(window).map(h => [`${h.deviceKey}|${h.port}`, h]));
        const devices = new Map(snapshot.Topology.map(d => [String(d.DeviceIP), d]));
        for (const fault of (manifests[i].Faults || [])) {
            const want = (fault.expected || {}).lastUsed;
            if (!want) continue;
            const device = devices.get(String(fault.deviceIp));
            const key = `${PortLastUsed.deviceKeysOf(device).find(k => k.startsWith('serial:'))}|${fault.port}`;
            const h = byPort.get(key);
            assert.ok(h, `${fault.kind}: no history for ${fault.deviceIp} ${fault.port}`);
            const r = wellFormed(computeLastUsed(h));
            assert.equal(r.state, want, `${fault.kind} on ${fault.deviceIp} ${fault.port} promised ${want}`);
            checked += 1;
        }
    }
    assert.ok(checked >= 10, `only ${checked} planted ports checked across ${names.length} snapshots`);
});

test('a port on a device that stopped answering keeps its history and widens its bound', () => {
    // The chronically failing devices in the fixture become placeholders carrying no interfaces at all,
    // so the port simply has fewer observations - it must not become a second, contradictory history.
    const histories = buildHistories(snapshots);
    const byKey = new Map();
    for (const h of histories) {
        const k = `${h.deviceKey}|${h.port}`;
        assert.ok(!byKey.has(k), `${k} appears twice - one port's history was split`);
        byKey.set(k, h);
    }
    const thin = histories.filter(h => h.observations.length < snapshots.length);
    assert.ok(thin.length > 0, 'no port is missing from a snapshot, so the widening case is untested');
    for (const h of thin.slice(0, 40)) wellFormed(computeLastUsed(h));
});
