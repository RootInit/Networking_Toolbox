import test from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Chassis from '../chassis.js';
import { computeNeighborEdges, buildSwitchMapNodeMeta } from '../topology-graph.js';

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

// One generation shared by most cases: it's deterministic, and per-test runs would dominate the suite.
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

// A fall back to the inferred panel means the catalogue's port names or the scrape have drifted.
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

    // An unpatched switch reads as a layout quirk, not a failure. A placeholder is exempt - unreadable.
    const orphans = topology.filter(d => d.ScanStatus === 'Ok' && d.Neighbors.length === 0);
    assert.deepEqual(orphans.map(d => d.Hostname), [], 'scanned devices with no neighbours at all');
});

test('interface rows carry the fields the table, faceplate and sort all read', () => {
    const rows = topology.flatMap(d => d.Interfaces);
    for (const field of ['Port', 'Admin', 'Link', 'Desc', 'STP', 'PoE']) {
        assert.ok(rows.every(r => r[field] !== undefined), `every row needs ${field}`);
    }
    // "Longest inactive" excludes rows with no LastFlappedSeconds, so both kinds must be present.
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

// Anything neither "Unknown" nor "Authenticated" counts as a violation, so all three must appear.
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

// A key the crawler always writes but the fixture omits reaches the UI as `undefined`.
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

    // Not all of it: a switch commissioned since the location file was written has no pin yet.
    const placedKeys = new Set(fixture.config.devices.map(d => d.key));
    const scanned = topology.filter(d => d.ScanStatus === 'Ok');
    const placedCount = scanned.filter(d => d.StackMembers.some(m => placedKeys.has(m.Serial))).length;
    assert.ok(placedCount > scanned.length * 0.9, `only ${placedCount} of ${scanned.length} scanned devices are placed`);
    assert.ok(placedCount < scanned.length, 'an entirely placed fleet never shows the unplaced-devices panel');
});

/* ---- geography: a closet uplinks to the nearest distribution frame, a closet fed from another
   closet is elsewhere in the same building, and nothing reaches across campus. ---- */

const metres = (a, b) => {
    const dLat = (a.lat - b.lat) * 111320;
    const dLng = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
};
const placedBySerial = () => new Map(fixture.config.devices.map(d => [d.key, d]));
const pinOf = (device, placed) => {
    for (const m of device.StackMembers || []) if (placed.has(m.Serial)) return placed.get(m.Serial);
    return null;   // a device the crawler could not read has no serial, so no pin
};
const roleOf = (device) => (/-core\d/.test(device.Hostname) ? 'CORE' : /-dist\d/.test(device.Hostname) ? 'DIST' : 'ACC');

test('every pin sits on the UW Seattle campus', () => {
    for (const placed of fixture.config.devices) {
        assert.ok(placed.lat > 47.646 && placed.lat < 47.665, `${placed.key} at lat ${placed.lat}`);
        assert.ok(placed.lng > -122.322 && placed.lng < -122.296, `${placed.key} at lng ${placed.lng}`);
        assert.match(placed.building, /\(([A-Z]{2,4})\)$/, 'a building name should carry its UW abbreviation');
    }
    const buildings = new Set(fixture.config.devices.map(d => d.building));
    assert.ok(buildings.size >= 20, `only ${buildings.size} distinct buildings`);
});

test('a stack is in one room, not spread across campus', () => {
    const placed = placedBySerial();
    for (const device of topology) {
        const pins = (device.StackMembers || []).map(m => placed.get(m.Serial)).filter(Boolean);
        for (const pin of pins) assert.ok(metres(pins[0], pin) < 150, `${device.Hostname} members are ${Math.round(metres(pins[0], pin))} m apart`);
    }
});

// Zone first, distance second - a building is fed from its own zone's frame even where another
// zone's is physically nearer (Fishery Sciences). The zone leads each placement's notes.
const zoneOfPin = (pin) => String(pin.notes).split(' - ')[0];

// Stated here rather than imported, so widening the fibre plant is a deliberate edit to both.
const ADJACENT = {
    'West Campus': ['Central Campus', 'North Campus'],
    'Central Campus': ['West Campus', 'North Campus', 'South Campus', 'East Campus'],
    'South Campus': ['Central Campus', 'East Campus'],
    'North Campus': ['Central Campus', 'West Campus'],
    'East Campus': ['Central Campus', 'South Campus'],
};

test('an access switch uplinks to the nearest frame in its own zone', () => {
    const placed = placedBySerial();
    const frames = topology.filter(d => roleOf(d) === 'DIST')
        .map(d => ({ ip: String(d.DeviceIP), pin: pinOf(d, placed) })).filter(f => f.pin);
    assert.ok(frames.length >= 4, 'campus needs several distribution frames for this to mean anything');
    const byIp = new Map(topology.map(d => [String(d.DeviceIP), d]));

    // Pins are jittered by about a footprint, so assert only that nothing is patched much further.
    const TIE_M = 120;
    const nearestOf = (pin, candidates) => Math.min(...candidates.map(f => metres(pin, f.pin)));

    let primaries = 0, secondaries = 0;
    for (const device of topology) {
        if (roleOf(device) !== 'ACC') continue;
        const pin = pinOf(device, placed);
        if (!pin) continue;
        const zone = zoneOfPin(pin);
        const inZone = frames.filter(f => zoneOfPin(f.pin) === zone);

        for (const neighbor of device.Neighbors) {
            const peer = byIp.get(String(neighbor.ManagementIP));
            if (!peer || roleOf(peer) !== 'DIST') continue;
            const peerZone = zoneOfPin(pinOf(peer, placed));
            const chosen = metres(pin, pinOf(peer, placed));

            if (peerZone === zone) {
                primaries++;
                assert.ok(chosen <= nearestOf(pin, inZone) + TIE_M,
                    `${device.Hostname} is patched to ${peer.Hostname} at ${Math.round(chosen)} m when its zone has one at ${Math.round(nearestOf(pin, inZone))} m`);
                continue;
            }
            // The only out-of-zone uplink is the deliberate dual-homing, to a bordering zone.
            secondaries++;
            assert.ok(ADJACENT[zone].includes(peerZone),
                `${device.Hostname} (${zone}) dual-homes to ${peer.Hostname} in ${peerZone}, which does not border it`);
            const bordering = frames.filter(f => ADJACENT[zone].includes(zoneOfPin(f.pin)));
            assert.ok(chosen <= nearestOf(pin, bordering) + TIE_M,
                `${device.Hostname} dual-homes to ${peer.Hostname} at ${Math.round(chosen)} m when a bordering zone has one at ${Math.round(nearestOf(pin, bordering))} m`);
        }
    }
    assert.ok(primaries > 20, `only ${primaries} primary uplinks checked`);
    assert.ok(secondaries > 0, 'no dual-homed closets, so the secondary-edge rendering is untested');
});

test('a switch fed from another switch is in the same building', () => {
    const placed = placedBySerial();
    const byIp = new Map(topology.map(d => [String(d.DeviceIP), d]));
    let daisies = 0;
    for (const device of topology) {
        if (roleOf(device) !== 'ACC') continue;
        const pin = pinOf(device, placed);
        if (!pin) continue;
        for (const neighbor of device.Neighbors) {
            const peer = byIp.get(String(neighbor.ManagementIP));
            if (!peer || roleOf(peer) !== 'ACC') continue;
            const peerPin = pinOf(peer, placed);
            if (!peerPin) continue;
            daisies++;
            assert.equal(peerPin.building, pin.building, `${device.Hostname} is daisy-chained to ${peer.Hostname} in another building`);
        }
    }
    assert.ok(daisies > 0, 'no daisy chains to check');
});

test('links are campus-length, not wishful', () => {
    const placed = placedBySerial();
    const byIp = new Map(topology.map(d => [String(d.DeviceIP), d]));
    const seen = new Set();
    const lengths = [];
    for (const device of topology) {
        const pin = pinOf(device, placed);
        if (!pin) continue;
        for (const neighbor of device.Neighbors) {
            const peer = byIp.get(String(neighbor.ManagementIP));
            const peerPin = peer && pinOf(peer, placed);
            if (!peerPin) continue;
            const key = [String(device.DeviceIP), String(neighbor.ManagementIP)].sort().join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            lengths.push(metres(pin, peerPin));
        }
    }
    lengths.sort((a, b) => a - b);
    assert.ok(lengths.length > 50);
    // The campus is ~1.5 km corner to corner, so nothing can legitimately exceed that.
    assert.ok(lengths[lengths.length - 1] < 2000, `longest link is ${Math.round(lengths[lengths.length - 1])} m`);
    assert.ok(lengths[Math.floor(lengths.length / 2)] < 400, `median link is ${Math.round(lengths[Math.floor(lengths.length / 2)])} m`);
});

// Four dashboard tabs are snapshot comparisons, so a one-snapshot fixture leaves them untestable.
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

    // Reboot detection compares boot timestamps, so a fleet whose Uptime never moves reports none.
    const bootOf = t => new Map(t.map(d => [String(d.DeviceIP), d.Uptime]));
    const [firstBoot, lastBoot] = [bootOf(first), bootOf(last)];
    assert.ok([...lastBoot].some(([ip, up]) => firstBoot.has(ip) && firstBoot.get(ip) !== up && up !== 'Unknown'),
        'no device rebooted between the first and last snapshot');
});

// Identity falls back to hostname for a placeholder, so a re-rolled failing set reads as churn.
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

/* ---- pins land indoors: closets ring inside each building's OSM footprint, because jitter wide
   enough to separate two closets also threw pins onto the lawn. ---- */

const CAMPUS_ROWS = new Map([...fs.readFileSync(GENERATOR, 'utf8')
    .matchAll(/\{ abbr: '([^']+)', name: '[^']+', lat: ([\d.]+), lng: (-[\d.]+), r: (\d+), closets: \d+/g)]
    .map(m => [m[1], { lat: +m[2], lng: +m[3], r: +m[4] }]));

test('the campus table declares a footprint radius for every building', () => {
    assert.equal(CAMPUS_ROWS.size, 48, 'the regex above must keep matching the table');
    for (const [abbr, b] of CAMPUS_ROWS) {
        assert.ok(b.r >= 5 && b.r <= 25, `${abbr} has an implausible footprint radius of ${b.r} m`);
    }
});

test('every pin is inside the footprint of the building it names', () => {
    // The rack ring nudges stack members off their closet's spot by up to 1.2 m.
    const RACK_ALLOWANCE = 1.3;
    for (const placed of fixture.config.devices) {
        const abbr = placed.building.match(/\(([A-Z]+)\)$/)[1];
        const b = CAMPUS_ROWS.get(abbr);
        assert.ok(b, `${placed.building} is not in the campus table`);
        const d = metres(placed, b);
        assert.ok(d <= b.r + RACK_ALLOWANCE,
            `${placed.key} is ${d.toFixed(1)} m from ${abbr}'s interior point, outside its ${b.r} m footprint`);
    }
});

test('no two devices share a pin', () => {
    const pins = fixture.config.devices;
    let closest = Infinity, pair = null;
    for (let i = 0; i < pins.length; i++) {
        for (let j = i + 1; j < pins.length; j++) {
            const d = metres(pins[i], pins[j]);
            if (d < closest) { closest = d; pair = [pins[i].key, pins[j].key]; }
        }
    }
    // Two members of one virtual chassis are the closest legitimate pair, about a metre apart.
    assert.ok(closest > 0.3, `${pair && pair.join(' and ')} are ${closest.toFixed(2)} m apart - effectively one dot`);
});

test("a building's distribution frame sits at its interior point, with the closets around it", () => {
    // The main frame is the one piece of kit whose location in a building is not arbitrary.
    const byBuilding = new Map();
    for (const placed of fixture.config.devices) {
        const abbr = placed.building.match(/\(([A-Z]+)\)$/)[1];
        if (!byBuilding.has(abbr)) byBuilding.set(abbr, []);
        byBuilding.get(abbr).push(placed);
    }
    let checked = 0;
    for (const [abbr, pins] of byBuilding) {
        // The room suffix 'A' is how the generator marks a frame rather than a closet.
        const frames = pins.filter(p => /A$/.test(p.room));
        if (!frames.length || pins.length < 3) continue;
        const b = CAMPUS_ROWS.get(abbr);
        const closets = pins.filter(p => !/A$/.test(p.room));
        const nearestFrame = Math.min(...frames.map(p => metres(p, b)));
        const medianCloset = closets.map(p => metres(p, b)).sort((x, y) => x - y)[Math.floor(closets.length / 2)];
        assert.ok(nearestFrame <= medianCloset,
            `${abbr}: the frame is ${nearestFrame.toFixed(1)} m out but the typical closet only ${medianCloset.toFixed(1)} m`);
        checked++;
    }
    assert.ok(checked >= 5, `only ${checked} buildings had both a frame and closets to compare`);
});

test('the default fleet size is the documented one', () => {
    const src = fs.readFileSync(GENERATOR, 'utf8');
    const dflt = src.match(/flag\('devices', '(\d+)'\)/)[1];
    assert.equal(dflt, '350');
    assert.match(src, new RegExp(`# ${dflt} devices ->`), 'the usage comment must match the default');
});

/* ---- server-config refresh: the app reads Configuration.json, so the generator keeps its
   placements in step. Gated on the file holding nothing but fixture output - a real operator's
   credentials and placements are never overwritten. ---- */

function generateInto(parent, args) {
    const maps = path.join(parent, 'Network_Maps');
    fs.mkdirSync(maps, { recursive: true });
    const res = spawnSync(process.execPath, [GENERATOR, '--out', maps, '--snapshots', '1', ...args],
        { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return { maps, stderr: res.stderr };
}
const tmpParent = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pnm_cfg_'));

const readServerConfig = parent => JSON.parse(fs.readFileSync(path.join(parent, 'Configuration.json'), 'utf8'));

test('a stale fixture config is refreshed to the fleet just written', () => {
    const parent = tmpParent();
    fs.writeFileSync(path.join(parent, 'Configuration.json'), JSON.stringify({
        devices: [{ key: 'SYN99999', building: 'Nowhere (NWH)', lat: 1, lng: 1 }],
        credentials: {}, settings: {},
    }));
    const { maps, stderr } = generateInto(parent, ['--devices', '40']);
    assert.match(stderr, /refreshed/);
    const written = JSON.parse(fs.readFileSync(path.join(maps, 'Configuration.fixture.json'), 'utf8'));
    assert.deepEqual(readServerConfig(parent).devices, written.devices);
});

// Only .devices: an operator testing against the fixture may have set their own login, scopes or
// thresholds in the viewer, and regenerating a fleet is no reason to discard them.
test('the refresh replaces only the placements', () => {
    const parent = tmpParent();
    fs.writeFileSync(path.join(parent, 'Configuration.json'), JSON.stringify({
        devices: [{ key: 'SYN99999', building: 'Nowhere (NWH)', lat: 1, lng: 1 }],
        credentials: { username: 'fixture-user', password: 'my-own-test-pw' },
        settings: { cpuWarnPct: 42, allowedScopes: ['10.20.'] },
    }));
    generateInto(parent, ['--devices', '40']);
    const after = readServerConfig(parent);
    assert.equal(after.credentials.password, 'my-own-test-pw');
    assert.equal(after.settings.cpuWarnPct, 42);
    assert.deepEqual(after.settings.allowedScopes, ['10.20.']);
    assert.ok(after.devices.length > 1);
});

test('an absent server config is created with fixture credentials and scopes', () => {
    const parent = tmpParent();
    const { stderr } = generateInto(parent, ['--devices', '40']);
    assert.match(stderr, /written/);
    const cfg = readServerConfig(parent);
    assert.equal(cfg.credentials.username, 'fixture-user');
    // Without a scope the crawl and every connect refuse, so a fresh clone would be inert.
    assert.ok(cfg.settings.allowedScopes.length > 0);
});

test("an operator's real config is never overwritten", () => {
    // Real serials are not SYN-prefixed. This is the one case that would destroy real credentials.
    const real = tmpParent();
    const original = {
        devices: [{ key: 'JN123REAL', building: 'A real site', lat: 1, lng: 1 }],
        credentials: { username: 'netops', password: 'real-secret' }, settings: {},
    };
    fs.writeFileSync(path.join(real, 'Configuration.json'), JSON.stringify(original));
    const { stderr } = generateInto(real, ['--devices', '40']);
    assert.match(stderr, /left\s+untouched/);
    assert.deepEqual(readServerConfig(real), original);
});

test('a --out that is not a Network_Maps directory writes no Configuration.json', () => {
    const parent = tmpParent();
    const elsewhere = path.join(parent, 'somewhere-else');
    fs.mkdirSync(elsewhere, { recursive: true });
    const res = spawnSync(process.execPath, [GENERATOR, '--out', elsewhere, '--snapshots', '1', '--devices', '40'],
        { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /no Configuration\.json was written/);
    assert.equal(fs.existsSync(path.join(parent, 'Configuration.json')), false);
});

// The device-level parity test above has an interface-level twin, and the gap there is much wider:
// accessRow emits 7 of the 30 fields the worker initializes, so every diagnostic field added in
// Phase 1 reaches the UI as `undefined` in fixture-driven work. This locks the gap rather than
// closing it - the fixture's values have to mean something (consistent with link state, spread
// across the bands the sorts rely on), and inventing 23 fields of plausible-looking data before the
// initializer settles would bake in assumptions Phase 1 is still moving.
//
// It fails usefully in BOTH directions: a new initializer field nobody accounted for widens the
// gap, and filling one in narrows it. Either way this list is the thing to edit, deliberately.
// Closed 2026-09-13 with work order item 11: the L1 rules read these fields, so every one of them is
// now emitted. The list stays as the mechanism - a new initializer field nobody accounted for lands
// here and this test is what says so.
const ACCESS_ROW_GAP = [];

function interfaceInitializerKeys() {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'Get-JunosNodeData.ps1'), 'utf8');
    // Anchored on the opening line's own indentation via a backreference, NOT on a brace at column
    // zero: this initializer's closing brace is indented 16 spaces, so the device-level test's
    // regex matches nothing here and its length guard would be what fired.
    const init = source.match(/^([ \t]*)\$NodeData\.Interfaces\[\$p\] = @\{\r?\n([\s\S]*?)\r?\n\1\}/m);
    assert.ok(init, 'could not locate the interface initializer - has it moved?');
    // Comment lines carry prose with semicolons and would otherwise contribute stray keys.
    const body = init[2].split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    return [...body.matchAll(/(?:^|;)\s*([A-Za-z][A-Za-z0-9]*)\s*=/gm)].map(m => m[1]).sort();
}

test('the interface initializer is still where the parity test looks for it', () => {
    const expected = interfaceInitializerKeys();
    assert.ok(expected.length > 20, `only found ${expected.length} interface keys`);
    assert.ok(expected.includes('Port') && expected.includes('StpDetail'), 'parsed the wrong block');
});

test('fixture interfaces match Get-JunosNodeData.ps1, except for a known and enumerated gap', () => {
    const expected = interfaceInitializerKeys();
    const device = topology.find(d => d.ScanStatus === 'Ok' && d.Interfaces.length > 0);
    assert.ok(device, 'no scanned device with interfaces in the fixture');

    // Every generated row, not just the first: accessRow has branches (cage, PoE, live) and a field
    // set that varies by branch is the same defect as one that is missing outright.
    const perRow = new Set(topology.flatMap(d => d.Interfaces).map(i => Object.keys(i).sort().join(',')));
    assert.equal(perRow.size, 1, `accessRow emits different field sets by branch:\n  ${[...perRow].join('\n  ')}`);

    const actual = Object.keys(device.Interfaces[0]).sort();
    const extra = actual.filter(k => !expected.includes(k));
    const missing = expected.filter(k => !actual.includes(k));

    assert.deepEqual(extra, [], `the fixture emits interface fields the worker never initializes: ${extra.join(', ')}`);
    assert.deepEqual(missing, ACCESS_ROW_GAP.slice().sort(),
        'the accessRow parity gap changed. Update ACCESS_ROW_GAP in this file to match, ' +
        `removing what generate-fixture.mjs now emits.\n  now missing: ${missing.join(', ')}`);
});

// Section 8.2, and the data section 6.2's first filter reads. Three things have to hold together or the
// VLAN filter is either vacuous (no membership anywhere) or F11 everywhere (ends that disagree by
// accident), and neither state can carry a test of the filter itself.
test('VLAN membership is coherent: trunk ends agree, clients sit in VLANs their port carries', () => {
    const byIp = new Map(topology.map(d => [String(d.DeviceIP), d]));
    const rowOf = (device, port) => device.Interfaces.find(r => r.Port === String(port).replace(/\.\d+$/, ''));
    const tagsOn = (row) => new Set((row.Vlans || []).map(v => v.Tag));

    const scannedDevices = topology.filter(d => d.ScanStatus === 'Ok');
    assert.ok(scannedDevices.every(d => d.Vlans.length > 0), 'every scanned device configures VLANs');

    let checked = 0;
    for (const device of scannedDevices) {
        for (const neighbor of device.Neighbors) {
            const peer = byIp.get(String(neighbor.ManagementIP));
            if (!peer || peer.ScanStatus !== 'Ok') continue;
            const near = rowOf(device, neighbor.LocalPort);
            const far = rowOf(peer, neighbor.RemotePort);
            if (!near || !far) continue;
            checked++;
            const a = tagsOn(near);
            const b = tagsOn(far);
            const differ = [...new Set([...a, ...b])].filter(tag => a.has(tag) !== b.has(tag));
            assert.deepEqual(differ, [],
                `${device.DeviceIP} ${near.Port} and ${peer.DeviceIP} ${far.Port} disagree on VLAN(s) ${differ}`);
        }
    }
    assert.ok(checked > 50, `only ${checked} trunk ends checked`);

    for (const device of scannedDevices) {
        for (const client of device.Clients) {
            const row = rowOf(device, client.Port);
            if (!row) continue;
            assert.ok(tagsOn(row).has(client.VLAN_Tag),
                `${device.DeviceIP} ${row.Port} holds a client in VLAN ${client.VLAN_Tag} it does not carry`);
        }
        // The membership and the config text are one fact: "set vlans" lists what the device carries.
        // Unless the CONFIG section was one of the ones a truncated capture lost, in which case there is
        // no config text to compare against - which is the point of blanking it with the section.
        const configured = new Set([...device.Configuration.matchAll(/^set vlans \S+ vlan-id (\d+)$/gm)].map(m => Number(m[1])));
        for (const vlan of device.Configuration === 'Unknown' ? [] : device.Vlans) {
            assert.ok(configured.has(vlan.Tag), `${device.DeviceIP} carries VLAN ${vlan.Tag} its configuration never sets`);
        }
        // A member marked as currently forwarding must be a port the spanning tree is forwarding on.
        for (const vlan of device.Vlans) {
            for (const member of vlan.Interfaces) {
                const row = rowOf(device, member.Port);
                if (member.Active && row.STP !== 'Unknown') {
                    assert.equal(row.STP, 'FWD',
                        `${device.DeviceIP} ${member.Port} is active in VLAN ${vlan.Tag} while ${row.STP}`);
                }
            }
        }
    }
});

// The same rule VLAN membership follows, for the same reason: autonegotiation state and frame size are
// properties of the WIRE. Drawn per neighbour entry, a quarter of the clean fleet's links carried an
// autoneg mismatch and nearly half an MTU mismatch - so the faults the injectors are supposed to be the
// only source of were the fleet's normal state, and no two-ended rule could be tested against it.
test('the two ends of a link agree about the wire, and about what each advertises for it', () => {
    const byIp = new Map(topology.map(d => [String(d.DeviceIP), d]));
    const tlv = (entry, prefix) => (entry.OrgInfo || []).find(o => String(o.Subtype).startsWith(prefix));
    const rowFor = (device, port) => device.Interfaces.find(r => r.Port === String(port).replace(/\.\d+$/, ''));
    let links = 0;
    const seen = new Set();
    for (const device of topology) {
        for (const neighbor of device.Neighbors) {
            const peer = byIp.get(String(neighbor.ManagementIP));
            if (!peer) continue;
            const back = peer.Neighbors.find(n => String(n.ManagementIP) === String(device.DeviceIP)
                && String(n.RemotePort) === String(neighbor.LocalPort));
            if (!back) continue;
            const key = [`${device.DeviceIP}|${neighbor.LocalPort}`, `${peer.DeviceIP}|${back.LocalPort}`].sort().join('~');
            if (seen.has(key)) continue;
            seen.add(key);
            links++;
            assert.equal(tlv(neighbor, 'MAC/PHY').Info, tlv(back, 'MAC/PHY').Info,
                `${device.DeviceIP} ${neighbor.LocalPort} and ${peer.DeviceIP} ${back.LocalPort} advertise different autoneg state`);
            assert.equal(tlv(neighbor, 'Maximum Frame').Info, tlv(back, 'Maximum Frame').Info,
                `${device.DeviceIP} ${neighbor.LocalPort} and ${peer.DeviceIP} ${back.LocalPort} advertise different frame sizes`);
            // And each end's own fields say the same thing it advertises, which is what a rule compares.
            for (const [dev, entry] of [[device, neighbor], [peer, back]]) {
                if (!dev.SectionsCaptured.includes('INTERFACES_EXT')) continue;
                const row = rowFor(dev, entry.LocalPort);
                if (!row) continue;
                const advertised = /not supported, disabled/.test(tlv(entry, 'MAC/PHY').Info) ? 'Disabled' : 'Enabled';
                assert.equal(row.AutoNegotiation, advertised, `${dev.DeviceIP} ${row.Port} contradicts its own TLV`);
                assert.equal(`MTU Size (${row.Mtu})`, tlv(entry, 'Maximum Frame').Info, `${dev.DeviceIP} ${row.Port} MTU`);
            }
        }
    }
    assert.ok(links > 50, `only ${links} symmetric links checked`);
});

// Section 3.4. The two traps are only testable if the fixture reproduces the states that spring them,
// and section 8.2 requires the states to be coherent with the rest of the row while it does.
test('the extensive-derived fields reproduce the states section 3.4 warns about', () => {
    const rows = topology.filter(d => d.ScanStatus === 'Ok'
        && d.SectionsCaptured.includes('INTERFACES_EXT')).flatMap(d => d.Interfaces);
    assert.ok(rows.length > 1000, `only ${rows.length} rows with the extensive section`);
    const up = rows.filter(r => r.Link === 'up');
    const down = rows.filter(r => r.Link === 'down');
    assert.ok(up.length > 100 && down.length > 100);

    // Trap two: every DOWN port prints Half-duplex, so an ungated duplex rule fires on all of them.
    assert.ok(down.every(r => r.Duplex === 'Half-duplex'), 'a down port reports Half-duplex');
    assert.ok(up.every(r => r.Duplex === 'Full-duplex'), 'an up port reports Full-duplex');
    // Trap three: LINK is noise on a down port and a real alarm on an up one.
    assert.ok(down.every(r => r.ActiveAlarms === 'LINK'), 'a down port carries the LINK alarm');
    assert.ok(up.every(r => r.ActiveAlarms === 'None'), 'no up port carries an alarm in a clean fleet');
    // Trap one: Drops without Errors, on ports that are otherwise perfectly healthy.
    const dropping = up.filter(r => r.OutputErrors.Drops > 0);
    assert.ok(dropping.length > 20, `only ${dropping.length} ports carry output drops`);
    assert.ok(dropping.every(r => r.OutputErrors.Errors === 0 && r.InputErrors.Errors === 0),
        'drops are the output queue at work, not an error - a fixture pairing them teaches the wrong rule');

    // Counters and the link state agree: a port that has never carried a frame has no traffic at all.
    assert.ok(down.every(r => r.InputPackets === 0 && r.OutputPackets === 0 && r.CarrierTransitions === 0));
    assert.ok(up.every(r => r.InputPackets > 0), 'an up port has carried something');
    // R4's tables are keyed by the label the switch prints, with the columns the parser reads.
    for (const row of up.slice(0, 50)) {
        assert.ok(row.MacStatistics['CRC/Align errors'], 'the R4 table must carry the CRC row');
        assert.deepEqual(Object.keys(row.MacStatistics['Total packets']), ['Receive', 'Transmit']);
        // A Receive-only row keeps its missing column missing rather than inventing a zero.
        assert.deepEqual(Object.keys(row.MacStatistics['Jabber frames']), ['Receive']);
        assert.equal(row.MacStatistics['Total packets'].Receive, row.InputPackets);
    }
    // R6/R7 are derived from the client list and the PoE string, so they cannot contradict them.
    for (const device of topology.filter(d => d.ScanStatus === 'Ok' && d.SectionsCaptured.includes('DOT1X'))) {
        for (const row of device.Interfaces) {
            const onPort = device.Clients.filter(c => String(c.Port).replace(/\.\d+$/, '') === row.Port);
            for (const entry of row.Dot1x) {
                if (!entry.MacAddress) { assert.equal(entry.State, 'Initialize'); continue; }
                const client = onPort.find(c => c.MAC === entry.MacAddress);
                assert.ok(client, `${row.Port} has a dot1x row for a MAC that is not on the port`);
                assert.equal(entry.State, client.Dot1x_State);
            }
            if (row.PoeOperStatus === 'Delivering') assert.match(row.PoE, /^Delivering/);
            if (row.PoE === 'Unknown') assert.equal(row.PoeAdminStatus, null);
        }
    }
});

// A truncated capture has to lose what the truncated section supplied, or a guard reading
// SectionsCaptured reports NOT_EVALUATED beside data that is sitting right there.
test('a node that lost the extensive section carries none of its fields', () => {
    const truncated = topology.filter(d => d.ScanStatus === 'Ok' && !d.SectionsCaptured.includes('INTERFACES_EXT'));
    assert.ok(truncated.length > 0, 'the generator truncates some captures; that is what this is about');
    for (const device of truncated) {
        for (const row of device.Interfaces) {
            assert.equal(row.Duplex, null, `${device.DeviceIP} ${row.Port} kept a duplex the capture never read`);
            assert.equal(row.ActiveAlarms, null);
            assert.equal(row.Mtu, null);
            assert.deepEqual(row.InputErrors, {});
            assert.deepEqual(row.MacStatistics, {});
            // What the terse and description sections supplied is still there: only the tail was lost.
            assert.ok(row.Link === 'up' || row.Link === 'down');
        }
    }
});

// Item 7 / section 8.2. The generator builds real cycles - the core ICL, every zone's first frame
// linked to both cores, 8% access dual-homing, daisy chains - and used to stamp FWD on all of them, so
// the fixture asserted a converged spanning tree forwarding on a loop. Nothing path-related could be
// tested against that, which is why this is the prerequisite for items 8 onward.
//
// This is the test the whole pass exists for: the forwarding graph must be a tree, which means it has
// exactly one fewer edge than it has nodes AND is connected. Either alone is satisfiable by a lie.
test('item 7: the forwarding subgraph is a spanning tree, not a loop stamped FWD', () => {
    // Every device, not just the scanned ones: a scan failure describes our ssh attempt, and a switch we
    // could not log into is still running RSTP. Its own rows are blank, so its end of a link is simply
    // unobservable - a link forwards when every end we CAN read says FWD.
    const bridges = topology;
    const byIp = new Map(bridges.map(d => [String(d.DeviceIP), d]));
    const stpOf = (d, port) => {
        const row = d.Interfaces.find(r => r.Port === String(port).replace(/\.\d+$/, ''));
        return row ? row.STP : null;
    };
    const linkForwards = (a, aPort, b, bPort) => {
        const ends = [stpOf(a, aPort), stpOf(b, bPort)].filter(x => x !== null);
        return ends.length > 0 && ends.every(x => x === 'FWD');
    };

    const fwdEdges = new Set();
    for (const d of bridges) {
        for (const n of d.Neighbors) {
            if (n.Reachable === false) continue;
            const peer = byIp.get(String(n.ManagementIP));
            if (!peer) continue;
            const key = [String(d.DeviceIP), String(peer.DeviceIP)].sort().join('~');
            if (linkForwards(d, n.LocalPort, peer, n.RemotePort)) fwdEdges.add(key);
        }
    }
    const allEdges = new Set();
    for (const d of bridges) {
        for (const n of d.Neighbors) {
            if (n.Reachable === false || !byIp.has(String(n.ManagementIP))) continue;
            allEdges.add([String(d.DeviceIP), String(n.ManagementIP)].sort().join('~'));
        }
    }
    assert.ok(allEdges.size > fwdEdges.size,
        `all ${allEdges.size} links forward - the fixture has no blocked port, so it still claims a tree on a loop`);

    // Connected, over the forwarding edges only.
    const adj = new Map(bridges.map(d => [String(d.DeviceIP), []]));
    for (const key of fwdEdges) {
        const [a, b] = key.split('~');
        adj.get(a).push(b);
        adj.get(b).push(a);
    }
    const seen = new Set([String(bridges[0].DeviceIP)]);
    const queue = [String(bridges[0].DeviceIP)];
    for (let head = 0; head < queue.length; head++) {
        for (const next of adj.get(queue[head])) {
            if (seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
        }
    }
    assert.equal(seen.size, bridges.length,
        `the forwarding graph reaches ${seen.size} of ${bridges.length} bridges - blocking partitioned the fleet`);
    assert.equal(fwdEdges.size, bridges.length - 1,
        `${fwdEdges.size} forwarding links over ${bridges.length} bridges - a tree has exactly ${bridges.length - 1}`);
});

test('item 7: exactly one root bridge, it has the best bridge ID, and only non-root bridges have a root port', () => {
    const bridges = topology.filter(d => d.ScanStatus === 'Ok');
    const roleOf = (r) => (r.StpDetail && r.StpDetail['instance 0'] ? r.StpDetail['instance 0'].Role : null);
    const rootPortCount = (d) => d.Interfaces.filter(r => roleOf(r) === 'Root').length;

    // A scan-failed device has no rows to read, so at most one OBSERVABLE bridge lacks a root port: the
    // elected root, and then only if our ssh happened to reach it.
    const roots = bridges.filter(d => rootPortCount(d) === 0);
    assert.ok(roots.length <= 1, `${roots.length} scanned bridges have no root port - at most one can be the root`);
    for (const d of roots) {
        // The root is elected on (priority, MAC) and only cores are given 4k. role is generator scratch
        // and never reaches a snapshot, so the config text is what a reader has to go on.
        assert.match(d.Configuration, /bridge-priority 4k/,
            'a bridge with no root port must be the root, and only cores carry the 4k priority');
    }
    for (const d of bridges) {
        if (roots.includes(d)) continue;
        assert.equal(rootPortCount(d), 1, `${d.Hostname} has ${rootPortCount(d)} root ports - RSTP allows exactly one`);
    }
});

// An asymmetric link - both ends Designated, or both Alternate - is what a half-converged or
// misconfigured tree looks like. The pass cannot produce one, so assert it does not.
test('item 7: every blocked port faces a designated one, and no link has two of either', () => {
    const bridges = topology.filter(d => d.ScanStatus === 'Ok');
    const byIp = new Map(bridges.map(d => [String(d.DeviceIP), d]));
    const detailOf = (d, port) => {
        const row = d.Interfaces.find(r => r.Port === String(port).replace(/\.\d+$/, ''));
        return row && row.StpDetail ? row.StpDetail['instance 0'] : null;
    };
    let blocked = 0;
    for (const d of bridges) {
        for (const n of d.Neighbors) {
            if (n.Reachable === false) continue;
            const peer = byIp.get(String(n.ManagementIP));
            if (!peer) continue;
            // A scan-failed peer has no rows, so one end is unobservable - a real snapshot's shape,
            // not a missing value to assert on.
            if (peer.ScanStatus !== 'Ok') continue;
            const mine = detailOf(d, n.LocalPort);
            const theirs = detailOf(peer, n.RemotePort);
            assert.ok(mine && theirs, `a link between ${d.Hostname} and ${peer.Hostname} has no STP detail`);
            const pair = [mine.Role, theirs.Role].sort().join('/');
            assert.ok(['Alternate/Designated', 'Designated/Root'].includes(pair),
                `${d.Hostname}:${n.LocalPort} and ${peer.Hostname}:${n.RemotePort} are ${pair}`);
            if (pair === 'Alternate/Designated') {
                blocked++;
                // Both ends agree on who won the segment, which is what DesignatedBridge records.
                assert.equal(mine.DesignatedBridge, theirs.DesignatedBridge, 'the two ends disagree on the designated bridge');
            }
        }
    }
    assert.ok(blocked > 0, 'no link blocks at all, so the cycles the generator builds are still all forwarding');
});

// The 8% dual-homing the generator builds. A switch can legitimately forward on two links - one up to
// the root, one down to a daisy-chained closet - so the assertion is about its UPWARD links: of the
// ports facing the root, exactly one is the Root port and the rest are Alternate and blocked.
test('item 7: a dual-homed access switch has one root port and blocks its other path to the root', () => {
    const byIp = new Map(topology.map(d => [String(d.DeviceIP), d]));
    const isAccess = (d) => typeof d.Configuration === 'string' && !/bridge-priority (4k|8k)/.test(d.Configuration);
    const detailOf = (d, port) => {
        const row = d.Interfaces.find(r => r.Port === String(port).replace(/\.\d+$/, ''));
        return row && row.StpDetail ? row.StpDetail['instance 0'] : null;
    };

    let examined = 0;
    for (const d of topology.filter(x => x.ScanStatus === 'Ok' && isAccess(x))) {
        const upward = d.Neighbors
            .filter(n => n.Reachable !== false && byIp.has(String(n.ManagementIP)))
            .map(n => detailOf(d, n.LocalPort))
            .filter(x => x && (x.Role === 'Root' || x.Role === 'Alternate'));
        if (upward.length < 2) continue;
        examined++;
        const roots = upward.filter(x => x.Role === 'Root');
        assert.equal(roots.length, 1, `${d.Hostname} has ${roots.length} root ports among ${upward.length} paths to the root`);
        for (const alt of upward.filter(x => x.Role === 'Alternate')) {
            assert.equal(alt.State, 'BLK', `${d.Hostname} has an Alternate port that is not blocked`);
        }
    }
    assert.ok(examined > 0, 'no access switch has a second path to the root - the 8% dual-homing is not being blocked');
});

// One chassis MAC per device. It was generated per LINK, so the same switch advertised a different
// chassis ID to every neighbour - and it is the tie-break the root election turns on.
test('item 7: a device advertises one chassis MAC to every neighbour', () => {
    const byIp = new Map(topology.map(d => [String(d.DeviceIP), d]));
    const seenFor = new Map();
    for (const d of topology) {
        for (const n of d.Neighbors) {
            if (!byIp.has(String(n.ManagementIP))) continue;
            if (!seenFor.has(String(n.ManagementIP))) seenFor.set(String(n.ManagementIP), new Set());
            seenFor.get(String(n.ManagementIP)).add(n.MacAddress);
        }
    }
    const multi = [...seenFor.entries()].filter(([, macs]) => macs.size > 1);
    assert.deepEqual(multi.map(([ip]) => ip), [],
        'these devices are advertised with more than one chassis MAC across their links');
    assert.ok([...seenFor.values()].some(macs => macs.size === 1), 'no neighbour MACs were checked at all');
});

// STP detail is per-scope because a trunk can block in one VLAN and forward in another. The config
// writes "set protocols rstp", one instance - so the scope is "instance 0" and nothing else. Faking
// "VLAN N" scopes on an RSTP config would assert a state no such switch can produce.
test('item 7: STP detail is keyed by the scope the config implies, with the fields the worker records', () => {
    const rows = topology.filter(d => d.ScanStatus === 'Ok').flatMap(d => d.Interfaces);
    const FIELDS = ['State', 'Role', 'Cost', 'PortId', 'DesignatedPortId', 'DesignatedBridge'];
    let checked = 0;
    for (const r of rows) {
        assert.ok(r.StpDetail && typeof r.StpDetail === 'object', `${r.Port} has no StpDetail`);
        assert.deepEqual(Object.keys(r.StpDetail), ['instance 0'], `${r.Port} scopes: ${Object.keys(r.StpDetail)}`);
        const d = r.StpDetail['instance 0'];
        for (const f of FIELDS) assert.ok(f in d, `${r.Port} detail is missing ${f}`);
        // The state string and the collapsed STP field must agree, or the drawer badge contradicts the tab.
        assert.equal(d.State, r.STP, `${r.Port} says ${r.STP} but its detail says ${d.State}`);
        assert.ok([2000, 20000].includes(d.Cost), `${r.Port} cost ${d.Cost} is neither a 10G nor a 1G RSTP cost`);
        assert.equal(d.Cost, /^(xe|et)/.test(r.Port) ? 2000 : 20000, `${r.Port} cost does not match its media`);
        checked++;
    }
    assert.ok(checked > 5000, `only ${checked} rows carried STP detail`);
});

// C3. @{} serialized as {} and window.asArray turned that into a one-element array holding an empty
// object; four consumers call it on device.Interfaces. The fixture already asserted [] here, so it was
// passing a shape production would have failed.
test('C3: a placeholder node Interfaces is an empty array, the shape a real scan also returns', () => {
    const failed = topology.filter(d => d.ScanStatus !== 'Ok');
    assert.ok(failed.length > 0, 'the fixture needs some failed scans');
    for (const d of failed) {
        assert.ok(Array.isArray(d.Interfaces), `${d.DeviceIP} Interfaces is ${typeof d.Interfaces}, not an array`);
        assert.equal(d.Interfaces.length, 0);
    }
});

// C1. The four classes each say something different about where the fault is; the fixture's own error
// text has to be a shape that classifies as the status it claims.
test('C1: failure statuses are the post-split set, and each carries text consistent with it', () => {
    const EXPECT = {
        Refused: /connection refused/i,
        NoRoute: /no route to host|network is unreachable|host is down/i,
        Timeout: /timed out/i,
        DnsFailed: /could not resolve|no address associated|name or service not known/i,
        AuthFailed: /permission denied|too many authentication failures/i,
    };
    const failed = topology.filter(d => d.ScanStatus !== 'Ok');
    const seen = new Set(failed.map(d => d.ScanStatus));
    assert.equal(seen.has('Unreachable'), false, 'Unreachable was split into four and must not be emitted');
    for (const d of failed) {
        assert.ok(d.ScanError, `${d.ScanStatus} needs an error string`);
        if (EXPECT[d.ScanStatus]) {
            assert.match(d.ScanError, EXPECT[d.ScanStatus],
                `${d.DeviceIP} claims ${d.ScanStatus} but its stderr would classify as something else`);
        }
    }
    assert.ok(seen.size >= 2, `only ${seen.size} distinct failure statuses - a rule keyed on one would pass trivially`);
    // A 120-device fixture will not draw every status, so the generator's own set is checked directly.
    const genSrc = fs.readFileSync(GENERATOR, 'utf8');
    const declared = genSrc.match(/const FAILURE_STATUSES = \[([^\]]*)\]/)[1];
    for (const cls of ['Refused', 'NoRoute', 'Timeout', 'DnsFailed']) {
        assert.match(declared, new RegExp(`'${cls}'`), `the generator cannot emit ${cls}`);
    }
    assert.equal(/'Unreachable'/.test(declared), false, 'the generator still lists the pre-split status');
});

// C4. Clients[].VLAN_Tag and Vlans[].Tag were a string-or-"Unknown" and an int-or-null for the same
// VLAN, so a consumer joining them had to know which of the pair it held.
test('C4: every client VLAN tag is a number or null, never a string and never "Unknown"', () => {
    const clients = topology.flatMap(d => [...(d.Clients || []), ...(d.TrueClients || [])]);
    assert.ok(clients.length > 500, `only ${clients.length} clients`);
    for (const c of clients) {
        assert.ok(c.VLAN_Tag === null || typeof c.VLAN_Tag === 'number',
            `VLAN_Tag is ${JSON.stringify(c.VLAN_Tag)} (${typeof c.VLAN_Tag})`);
    }
    assert.ok(new Set(clients.map(c => c.VLAN_Tag)).size >= 4, 'the VLAN filter needs several VLANs');
    // The filter and the dropdown both compare String(tag), so the round-trip has to be lossless.
    for (const c of clients.slice(0, 200)) {
        if (c.VLAN_Tag !== null) assert.equal(Number(String(c.VLAN_Tag)), c.VLAN_Tag);
    }
});

// C5. null seconds meant both "Never" - the healthy state, the port has not flapped since boot - and
// "this parser could not read the duration", which call for opposite actions.
test('C5: every interface row states WHY LastFlappedSeconds is null', () => {
    const rows = topology.filter(d => d.ScanStatus === 'Ok').flatMap(d => d.Interfaces);
    assert.ok(rows.length > 5000, `only ${rows.length} interface rows`);
    const states = new Set();
    for (const r of rows) {
        assert.ok('LastFlappedState' in r, 'an interface row is missing LastFlappedState');
        states.add(r.LastFlappedState);
        if (r.LastFlappedSeconds !== null) {
            assert.equal(r.LastFlappedState, 'Parsed', 'a row with a duration must say it parsed one');
        } else {
            assert.notEqual(r.LastFlappedState, 'Parsed', 'a row with no duration must not claim it parsed one');
        }
    }
    assert.ok(states.has('Never') && states.has('Parsed'),
        `states present: ${[...states].join(', ')} - both the healthy and the measured case must occur`);
});

// R1. Interfaces[] is keyed by physical port, so a unit whose parent is irb/vme/me0 has nowhere to live
// on a row - the node-level array is the one a gateway-candidate rule can read. The per-row array must
// be a filtered view of it, not a second parse that can drift.
test('R1: logical units are node-level, mirrored onto their parent row, and cover the unit-less parents', () => {
    const scanned = topology.filter(d => d.ScanStatus === 'Ok');
    assert.ok(scanned.length > 100, 'expected a populated fixture');
    for (const d of scanned) {
        assert.ok(Array.isArray(d.LogicalUnits) && d.LogicalUnits.length > 0, `${d.DeviceIP} has no logical units`);
        for (const u of d.LogicalUnits) {
            assert.ok(u.Parent && typeof u.Parent === 'string', 'a unit needs a parent');
            assert.equal(typeof u.Unit, 'number', 'a unit number is a number');
        }
        // The management unit's parent is not a physical port and gets no Interfaces row.
        const mgmt = d.LogicalUnits.filter(u => u.Parent === 'vme');
        assert.equal(mgmt.length, 1, `${d.DeviceIP} should carry exactly one management unit`);
        assert.match(mgmt[0].LocalAddress, /^\d+\.\d+\.\d+\.\d+\/\d+$/);
        assert.equal(d.Interfaces.some(r => r.Port === 'vme'), false, 'vme must not become a physical port row');

        // Every row-level unit appears node-level, and names its own row as its parent.
        const nodeKeys = new Set(d.LogicalUnits.map(u => `${u.Parent}.${u.Unit}`));
        for (const row of d.Interfaces) {
            for (const u of (row.LogicalUnits || [])) {
                assert.equal(u.Parent, row.Port, `unit on ${row.Port} claims parent ${u.Parent}`);
                assert.ok(nodeKeys.has(`${u.Parent}.${u.Unit}`), `${u.Parent}.${u.Unit} is missing node-level`);
            }
        }
    }
    const dark = scanned.flatMap(d => d.Interfaces).filter(r => !(r.LogicalUnits || []).length);
    assert.ok(dark.length > 0, 'no port has an empty LogicalUnits[] - the UI never sees that state');
});

// R2/R2b/R13/R5. The neighbour row grew ten fields; a fixture missing any of them lets a consumer that
// reads an undefined pass here and break on real data.
test('R2/R2b/R13: every LLDP neighbour row carries the retained LLDP fields', () => {
    const LLDP_FIELDS = ['Reachable', 'OrgInfo', 'AgeoutCount', 'TimeToLive', 'TimeMark', 'AgeSeconds',
        'Manufacturer', 'ModelName', 'SerialNumber', 'HardwareRevision', 'SoftwareRevision', 'FirmwareRevision'];
    const rows = topology.flatMap(d => [...(d.Neighbors || []), ...(d.MedNeighbors || [])]);
    assert.ok(rows.length > 500, `only ${rows.length} neighbour rows`);
    for (const n of rows) {
        for (const f of LLDP_FIELDS) assert.ok(f in n, `a neighbour row is missing ${f}`);
        assert.ok(Array.isArray(n.OrgInfo) && n.OrgInfo.length > 0, 'OrgInfo must carry the 802.3 TLVs');
        for (const o of n.OrgInfo) assert.ok(o.OUI && o.Subtype && o.Info, 'a stanza needs all three fields');
        // Age past the advertised TTL is a neighbour that would already have aged out.
        assert.ok(n.AgeSeconds >= 0 && n.AgeSeconds < n.TimeToLive, `age ${n.AgeSeconds} against TTL ${n.TimeToLive}`);
    }
    // The Junos wording, not a paraphrase of it: "Autonegotiation [not supported, disabled (0x0)]" is
    // what the TLV prints, and a rule written against an invented string works only against fixtures.
    const withAutonegOff = rows.filter(n => n.OrgInfo.some(o => /Autonegotiation \[not supported, disabled/.test(o.Info)));
    assert.ok(withAutonegOff.length > 0, 'no neighbour advertises autoneg disabled - the R2 rule has nothing to fire on');
    const frameSizes = rows.flatMap(n => n.OrgInfo.filter(o => /Maximum Frame Size/.test(o.Subtype)).map(o => o.Info));
    assert.ok(frameSizes.length > 0);
    for (const info of frameSizes) assert.match(info, /^MTU Size \(\d+\)$/, 'the frame-size TLV prints its value as Junos does');
});

test('R13: only LLDP-MED endpoints report inventory, and a switch neighbour reports none', () => {
    const med = topology.flatMap(d => d.MedNeighbors || []);
    assert.ok(med.length > 100, `only ${med.length} MED endpoints`);
    assert.ok(med.every(n => n.ModelName && n.Manufacturer && n.SerialNumber), 'every MED endpoint needs its inventory');
    assert.ok(new Set(med.map(n => n.ModelName)).size > 1, 'a single model would let a rule hard-code it');
    for (const n of topology.flatMap(d => d.Neighbors || [])) {
        assert.equal(n.ModelName, null, 'a switch neighbour must not carry MED inventory');
    }
});

// R5. These carry ManagementIP 'Unknown', which every edge and node-meta consumer already skips. If one
// stopped skipping it, an unmanaged desk switch would appear as a phantom node in the diagram.
test('R5: unreachable neighbours exist, are Bridge-capable, and reach no edge or node', () => {
    const unreachable = topology.flatMap(d => (d.Neighbors || []).map(n => [d, n])).filter(([, n]) => n.Reachable === false);
    assert.ok(unreachable.length >= 2, `expected some unreachable neighbours, got ${unreachable.length}`);
    for (const [, n] of unreachable) {
        assert.equal(n.ManagementIP, 'Unknown', 'an unreachable neighbour has no address to scan');
        assert.ok(n.LocalPort, 'it is still known which port it is on');
    }
    const reachable = topology.flatMap(d => (d.Neighbors || []).filter(n => n.Reachable !== false));
    assert.ok(reachable.every(n => n.ManagementIP && n.ManagementIP !== 'Unknown'),
        'a reachable neighbour must carry a real management address');

    const meta = buildSwitchMapNodeMeta(topology);
    assert.equal(meta.has('Unknown'), false, 'an unreachable neighbour became a graph node');
    const edges = computeNeighborEdges(topology);
    assert.equal(edges.some(e => e.to === 'Unknown' || e.from === 'Unknown'), false, 'an unreachable neighbour became an edge');
});

// R12: one ScanTimestamp covers a crawl spanning many minutes, so per-device capture times are what
// make cross-device comparison meaningful. A fixture where they were all identical, or all equal to
// ScanTimestamp, would let a rule that ignores the field pass.
test('R12: capture timestamps are per-device, inside the crawl window, and absent when unreachable', () => {
    const scanMs = Date.parse(fixture.map.ScanTimestamp);
    const scanned = topology.filter(d => d.ScanStatus === 'Ok');
    const stamps = scanned.map(d => d.CaptureTimestamp);
    assert.ok(stamps.every(s => typeof s === 'string' && !Number.isNaN(Date.parse(s))), 'every scanned device needs a parseable capture time');
    assert.ok(new Set(stamps).size > 10, `capture times barely vary (${new Set(stamps).size} distinct) - a rule ignoring the field would still pass`);
    for (const d of scanned) {
        const ms = Date.parse(d.CaptureTimestamp);
        assert.ok(ms <= scanMs, `${d.DeviceIP} was captured after the snapshot was written`);
        assert.ok(scanMs - ms <= 30 * 60000, `${d.DeviceIP} capture time is implausibly far before the snapshot`);
    }
    for (const d of topology.filter(x => x.ScanStatus !== 'Ok')) {
        assert.equal(d.CaptureTimestamp, null, `${d.DeviceIP} never answered, so it has no capture instant`);
    }
});

// R15: the truncation signal. Section names must be real, a truncated capture must lose its TAIL
// (the worker asks for the largest command last), and dropping a section must drop what it supplies
// - otherwise the fixture asserts a state no switch can produce.
test('R15: captured-section lists are real, tail-truncated, and consistent with the data present', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'Get-JunosNodeData.ps1'), 'utf8');
    const workerKeys = new Set([...source.matchAll(/\$DataDict\["([A-Z0-9_]+)"\]/g)].map(m => m[1]));
    assert.ok(workerKeys.size > 10, `only found ${workerKeys.size} DataDict keys in the worker`);

    const scanned = topology.filter(d => d.ScanStatus === 'Ok');
    const full = scanned.map(d => d.SectionsCaptured.length).reduce((a, b) => Math.max(a, b), 0);
    let truncated = 0;
    for (const d of scanned) {
        for (const name of d.SectionsCaptured) {
            assert.ok(workerKeys.has(name), `${d.DeviceIP} claims section "${name}", which the worker never produces`);
        }
        assert.equal(new Set(d.SectionsCaptured).size, d.SectionsCaptured.length, `${d.DeviceIP} lists a section twice`);
        if (d.SectionsCaptured.length === full) continue;
        truncated++;
        // A prefix of the full list: a real timeout cuts the tail, it does not drop from the middle.
        const fullList = scanned.find(x => x.SectionsCaptured.length === full).SectionsCaptured;
        assert.deepEqual(d.SectionsCaptured, fullList.slice(0, d.SectionsCaptured.length),
            `${d.DeviceIP}'s section list is not a prefix of the full one - truncation cut the middle`);
        // The coupling that keeps the fixture physically possible.
        if (!d.SectionsCaptured.includes('CONFIG')) {
            assert.equal(d.Configuration, 'Unknown', `${d.DeviceIP} has config text but never captured CONFIG`);
        }
        if (!d.SectionsCaptured.includes('ROUTING_ENGINE')) {
            assert.equal(d.MasterCpuUtilization, 'Unknown', `${d.DeviceIP} has CPU data but never captured ROUTING_ENGINE`);
        }
    }
    assert.ok(truncated > 0, 'no truncated capture in the fixture - the integrity gate would have nothing to catch');
    for (const d of topology.filter(x => x.ScanStatus !== 'Ok')) {
        assert.deepEqual(d.SectionsCaptured, [], `${d.DeviceIP} never answered, so it captured nothing`);
    }
});

// R3: MacTable is the un-collapsed view Clients is derived from. A fixture with clients but an empty
// table, or a table naming ports the device does not have, is a state no switch produces.
test('R3: the MAC table is consistent with Clients and contains a duplicate to detect', () => {
    const scanned = topology.filter(d => d.ScanStatus === 'Ok');
    let withDuplicate = 0;
    for (const d of scanned) {
        assert.ok(Array.isArray(d.MacTable), `${d.DeviceIP} MacTable must be an array`);
        const clients = window_asArray(d.Clients);
        assert.ok(d.MacTable.length >= clients.length,
            `${d.DeviceIP} has ${clients.length} clients but only ${d.MacTable.length} MAC-table rows`);
        const ports = new Set(d.Interfaces.map(i => i.Port));
        for (const row of d.MacTable) {
            assert.ok(ports.has(row.PhysicalPort), `${d.DeviceIP} MAC table names port ${row.PhysicalPort}, which the device does not have`);
            assert.ok(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(row.MacAddress), `bad MAC ${row.MacAddress}`);
            assert.ok(row.Flags, 'the raw flag character is the point of R3');
        }
        const byMac = new Map();
        for (const row of d.MacTable) {
            if (!byMac.has(row.MacAddress)) byMac.set(row.MacAddress, new Set());
            byMac.get(row.MacAddress).add(row.PhysicalPort);
        }
        if ([...byMac.values()].some(ports => ports.size > 1)) withDuplicate++;
    }
    assert.ok(withDuplicate > 0, 'no device shows one MAC on two ports - duplicate-MAC detection would have nothing to find');
    for (const d of topology.filter(x => x.ScanStatus !== 'Ok')) {
        assert.deepEqual(d.MacTable, [], `${d.DeviceIP} never answered, so it has no MAC table`);
    }
});

// Mirrors window.asArray, which is what the app uses for every PowerShell-emitted collection.
function window_asArray(v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); }
