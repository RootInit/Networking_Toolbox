import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Chassis from '../chassis.js';
import { computeNeighborEdges } from '../topology-graph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const GENERATOR = path.join(ROOT, 'web-src', 'tools', 'generate-fixture.mjs');

function generate(args) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pnm_fixture_'));
    execFileSync(process.execPath, [GENERATOR, '--out', out, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    // Sorted by name, which for NetworkMap_<iso-ish> is chronological order.
    const names = fs.readdirSync(out).filter(f => /^NetworkMap_.*\.fixture\.json$/.test(f)).sort();
    const snapshots = names.map(n => JSON.parse(fs.readFileSync(path.join(out, n), 'utf8')));
    return {
        dir: out, names, snapshots,
        map: snapshots[snapshots.length - 1],
        config: JSON.parse(fs.readFileSync(path.join(out, 'Configuration.fixture.json'), 'utf8')),
        raw: Buffer.concat(names.map(n => fs.readFileSync(path.join(out, n)))),
    };
}

// One generation shared by most cases: the generator is deterministic, so a second run would
// only re-prove that, and generating takes long enough that per-test runs would dominate the
// suite's runtime.
const fixture = generate(['--devices', '120', '--seed', '3']);
const topology = fixture.map.Topology;

test('the fixture is a snapshot the app can load', () => {
    assert.equal(topology.length, 120);
    assert.ok(fixture.map.ScanTimestamp, 'ScanTimestamp is what the crawl-age badge reads');
    // The server and the folder loader both match on NetworkMap_*.json and exclude *.tmp.json.
    for (const name of fixture.names) {
        assert.ok(/^NetworkMap_.*\.json$/.test(name) && !/\.tmp\.json$/.test(name), `${name} would not be picked up`);
    }
});

// The whole point of scraping port lists out of the artwork: if a generated device ever falls
// back to the inferred panel, either the catalogue's port names or the scrape has drifted, and
// the fixture would be silently testing the fallback instead of the real face.
test('every drawn member renders from its own catalogue art, never the inferred panel', () => {
    const offenders = [];
    for (const device of topology) {
        if (device.ScanStatus !== 'Ok') continue;
        for (const member of Chassis.buildMembers(device)) {
            if (member.note) continue;
            if (member.inferred) offenders.push(`${device.Hostname} fpc${member.fpc} ${member.model}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('a modular chassis reports ports but carries a no-drawing note', () => {
    const modular = topology.find(d => d.StackMembers.some(m => /EX9200/i.test(m.Model)));
    assert.ok(modular, 'the fixture keeps one undrawable chassis');
    assert.ok(modular.Interfaces.length > 0, 'missing art is a rendering decision, not missing scan data');
    assert.ok(Chassis.buildMembers(modular)[0].note);
});

test('port counts match the real hardware, not a token handful', () => {
    const fortyEightPort = topology.find(d =>
        d.ScanStatus === 'Ok' && d.StackMembers.length === 1 && /-48[PT]$/.test(d.StackMembers[0].Model));
    assert.ok(fortyEightPort, 'the fixture includes 48-port access switches');
    assert.ok(fortyEightPort.Interfaces.length >= 48,
        `${fortyEightPort.StackMembers[0].Model} reported only ${fortyEightPort.Interfaces.length} ports`);
});

test('LLDP is reported from both ends of every link', () => {
    const byIp = new Map(topology.map(d => [String(d.DeviceIP), d]));
    for (const device of topology) {
        for (const neighbor of device.Neighbors) {
            const peer = byIp.get(String(neighbor.ManagementIP));
            if (!peer || peer.ScanStatus !== 'Ok') continue;
            const back = peer.Neighbors.find(n => String(n.ManagementIP) === String(device.DeviceIP));
            assert.ok(back, `${peer.Hostname} does not report ${device.Hostname} back`);
            assert.equal(back.RemotePort, neighbor.LocalPort);
            assert.equal(back.LocalPort, neighbor.RemotePort);
        }
    }
});

test('the graph is connected and carries redundant links, not just a tree', () => {
    const edges = computeNeighborEdges(topology);
    const adjacency = new Map(topology.map(d => [String(d.DeviceIP), []]));
    for (const e of edges) {
        adjacency.get(String(e.from))?.push(String(e.to));
        adjacency.get(String(e.to))?.push(String(e.from));
    }
    const seen = new Set([String(topology[0].DeviceIP)]);
    const queue = [String(topology[0].DeviceIP)];
    while (queue.length) {
        for (const next of adjacency.get(queue.pop()) || []) {
            if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
    }
    const scanned = topology.filter(d => d.ScanStatus === 'Ok').length;
    assert.ok(seen.size >= scanned * 0.95, `only ${seen.size} of ${topology.length} devices are reachable`);
    assert.ok(edges.length > topology.length, 'a pure tree never reaches the secondary-edge rendering');
});

test('interface rows carry the fields the table, faceplate and sort all read', () => {
    const rows = topology.flatMap(d => d.Interfaces);
    for (const field of ['Port', 'Admin', 'Link', 'Desc', 'STP', 'PoE']) {
        assert.ok(rows.every(r => r[field] !== undefined), `every row needs ${field}`);
    }
    // "Longest inactive" sorts on LastFlappedSeconds and must exclude rows that have none, so
    // the fixture has to contain both kinds.
    assert.ok(rows.some(r => r.LastFlappedSeconds === null));
    assert.ok(rows.some(r => Number.isFinite(r.LastFlappedSeconds)));
    // The activity lens bands at 72h and 6 months; all three must be represented.
    const flaps = rows.map(r => r.LastFlappedSeconds).filter(Number.isFinite);
    assert.ok(flaps.some(s => s <= Chassis.H72_S));
    assert.ok(flaps.some(s => s > Chassis.H72_S && s <= Chassis.H6MO_S));
    assert.ok(flaps.some(s => s > Chassis.H6MO_S));
});

test('clients span VLANs and leave some IPs for ARP correlation to backfill', () => {
    const clients = topology.flatMap(d => d.Clients);
    assert.ok(new Set(clients.map(c => c.VLAN_Tag)).size >= 4, 'the VLAN filter needs several VLANs');
    const unknown = clients.filter(c => c.IP === 'Unknown');
    assert.ok(unknown.length > 0, 'an all-resolved fixture never exercises MAC->IP correlation');
    const arpMacs = new Set(topology.flatMap(d => d.ArpEntries).map(a => a.MAC));
    assert.ok(unknown.some(c => arpMacs.has(c.MAC)), 'an unresolved client needs its ARP entry on another device');
});

test('ports shared by two MACs produce all three daisy-chain confidences', () => {
    const verdicts = new Set();
    for (const device of topology) {
        const med = new Map(device.MedNeighbors.map(m => [m.LocalPort, m]));
        const byPort = new Map();
        for (const client of device.Clients) {
            const port = client.Port.replace(/\.\d+$/, '');
            if (!byPort.has(port)) byPort.set(port, []);
            byPort.get(port).push(client);
        }
        for (const [port, clients] of byPort) {
            if (new Set(clients.map(c => c.MAC)).size < 2) continue;
            verdicts.add(med.has(port) ? 'confirmed' : new Set(clients.map(c => c.VLAN_Tag)).size >= 2 ? 'likely' : 'possible');
        }
    }
    assert.deepEqual([...verdicts].sort(), ['confirmed', 'likely', 'possible']);
});

// The dashboard counts anything that is neither "Unknown" nor "Authenticated" as a violation,
// so all three states have to appear or that tile is stuck at zero.
test('dot1x states cover unobserved, authenticated and failed', () => {
    const states = new Set(topology.flatMap(d => d.Clients).map(c => c.Dot1x_State));
    assert.ok(states.has('Unknown'));
    assert.ok(states.has('Authenticated'));
    assert.ok([...states].some(s => s !== 'Unknown' && s !== 'Authenticated'), 'no dot1x violations to count');
});

test('failed scans appear as placeholder nodes carrying a status and an error', () => {
    const failed = topology.filter(d => d.ScanStatus !== 'Ok');
    assert.ok(failed.length > 0);
    for (const device of failed) {
        assert.ok(device.ScanError, `${device.ScanStatus} needs an error string`);
        assert.equal(device.Interfaces.length, 0, 'a device the crawler could not read has no interface data');
    }
});

// The fixture stands in for a real crawl, so a key the crawler always writes but the fixture
// omits reaches the UI as `undefined` rather than the "Unknown" the crawler would have written.
test('fixture devices carry every key Get-JunosNodeData.ps1 initializes', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'Get-JunosNodeData.ps1'), 'utf8');
    const init = source.match(/\$NodeData = @\{([\s\S]*?)\n\}/);
    assert.ok(init, 'could not locate the $NodeData initializer - has it moved?');
    const expected = [...init[1].matchAll(/(?:^|;)\s*([A-Za-z][A-Za-z0-9]*)\s*=/gm)].map(m => m[1]).sort();
    assert.ok(expected.length > 10, `only found ${expected.length} keys`);
    for (const device of [topology.find(d => d.ScanStatus === 'Ok'), topology.find(d => d.ScanStatus !== 'Ok')]) {
        assert.deepEqual(Object.keys(device).sort(), expected, `${device.ScanStatus} node key set`);
    }
});

test('placed devices are keyed by serial so the Map can find them', () => {
    assert.ok(fixture.config.devices.length > 0);
    for (const placed of fixture.config.devices) {
        assert.equal(placed.keyType, 'serial');
        assert.ok(Math.abs(placed.lat) <= 90 && Math.abs(placed.lng) <= 180);
        assert.ok(placed.building, 'a pin with no building cannot be grouped');
    }
    assert.ok(new Set(fixture.config.devices.map(d => d.building)).size > 1, 'clustering needs more than one building');

    // Most of the fleet is placed, but not all of it: a switch commissioned since the location
    // file was written has no pin yet, which is what the Map's unplaced-devices panel lists.
    const placedKeys = new Set(fixture.config.devices.map(d => d.key));
    const scanned = topology.filter(d => d.ScanStatus === 'Ok');
    const placedCount = scanned.filter(d => d.StackMembers.some(m => placedKeys.has(m.Serial))).length;
    assert.ok(placedCount > scanned.length * 0.9, `only ${placedCount} of ${scanned.length} scanned devices are placed`);
    assert.ok(placedCount < scanned.length, 'an entirely placed fleet never shows the unplaced-devices panel');
});

// Trends, New Devices, Topology Diff and Config Changed are all comparisons between snapshots,
// so a fixture with one snapshot leaves four dashboard tabs untestable.
test('successive daily snapshots differ the way a fleet does between crawls', () => {
    assert.ok(fixture.snapshots.length >= 3, 'the default is several snapshots');
    const times = fixture.snapshots.map(s => new Date(s.ScanTimestamp).getTime());
    for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'snapshots must be ordered in time');

    const [first, last] = [fixture.snapshots[0].Topology, fixture.map.Topology];
    const ipsOf = t => new Set(t.map(d => String(d.DeviceIP)));
    const [firstIps, lastIps] = [ipsOf(first), ipsOf(last)];
    assert.ok([...lastIps].some(x => !firstIps.has(x)), 'no device was ever commissioned');
    assert.ok([...firstIps].some(x => !lastIps.has(x)), 'no device was ever retired');

    const configOf = t => new Map(t.map(d => [String(d.DeviceIP), d.Configuration]));
    const [firstCfg, lastCfg] = [configOf(first), configOf(last)];
    assert.ok([...lastCfg].some(([ip, cfg]) => firstCfg.has(ip) && firstCfg.get(ip) !== cfg), 'no configuration changed');

    // Reboot detection compares a device's boot timestamp against the previous snapshot's, so a
    // fleet whose Uptime never moves reports none however many snapshots are loaded.
    const bootOf = t => new Map(t.map(d => [String(d.DeviceIP), d.Uptime]));
    const [firstBoot, lastBoot] = [bootOf(first), bootOf(last)];
    assert.ok([...lastBoot].some(([ip, up]) => firstBoot.has(ip) && firstBoot.get(ip) !== up && up !== 'Unknown'),
        'no device rebooted between the first and last snapshot');
});

// A placeholder has no StackMembers, so its cross-snapshot identity falls back from serial to
// hostname. Re-rolling which devices fail each crawl therefore reports most of the fleet as
// removed and re-added, burying the genuine changes.
test('the set of unreachable devices is stable across snapshots', () => {
    const failedIn = fixture.snapshots.map(s => new Set(s.Topology.filter(d => d.ScanStatus !== 'Ok').map(d => String(d.DeviceIP))));
    for (let i = 1; i < failedIn.length; i++) {
        const churn = [...failedIn[i]].filter(x => !failedIn[i - 1].has(x)).length
            + [...failedIn[i - 1]].filter(x => !failedIn[i].has(x)).length;
        assert.ok(churn <= 4, `${churn} devices changed reachability between snapshots ${i - 1} and ${i}`);
        assert.ok(churn > 0, 'a fleet where nothing ever changes state has no reliability signal');
    }
});

test('the same seed produces a byte-identical map', () => {
    const again = generate(['--devices', '120', '--seed', '3']);
    assert.ok(fixture.raw.equals(again.raw));
    fs.rmSync(again.dir, { recursive: true, force: true });
});

test('a different seed produces a different map', () => {
    const other = generate(['--devices', '120', '--seed', '4']);
    assert.ok(!fixture.raw.equals(other.raw));
    fs.rmSync(other.dir, { recursive: true, force: true });
});

test.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
