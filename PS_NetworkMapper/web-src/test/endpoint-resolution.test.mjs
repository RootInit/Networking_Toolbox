// Section 6.1. Resolution is tested separately from path computation because most of the ways it goes
// wrong are ambiguities, not failures - and an ambiguity reported as a single answer is the worst
// outcome available. The fault manifests from item 8 are the oracle for the fixture-scale cases.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EndpointResolution from '../endpoint-resolution.js';
import { MICRO_TOPOLOGIES, byName, ALLOWED_SCOPES } from '../tools/micro-topologies.mjs';

const { createResolver, resolveEndpoint } = EndpointResolution;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const GENERATOR = path.join(ROOT, 'web-src', 'tools', 'generate-fixture.mjs');

const resolverFor = (name) => createResolver(byName(name).snapshot.Topology, { allowedScopes: ALLOWED_SCOPES });

test('a known status and a matches array come back for every identifier shape', () => {
    const resolver = resolverFor('transit-sighting');
    const queries = ['10.30.9.10', 'aa:bb:00:00:09:01', 'micro-transit-access', 'nothing-like-this'];
    for (const query of queries) {
        const result = resolver.resolve(query);
        assert.ok(['FOUND', 'AMBIGUOUS', 'NOT_FOUND', 'TRANSIT_ONLY'].includes(result.status), query);
        assert.ok(Array.isArray(result.matches) && Array.isArray(result.notes));
        assert.ok(result.interpretations.length > 0, `${query} was not interpreted as anything`);
    }
});

// F4, the half the fixture never contained: two real rows, one host.
test('a MAC on an access port and an uplink resolves to one place, not two', () => {
    const topology = byName('transit-sighting');
    const result = resolverFor('transit-sighting').resolve(topology.clientMac);
    assert.equal(result.status, 'FOUND');
    assert.deepEqual(result.locations, [`${topology.accessIp}|${topology.accessPort}`]);
    // Both sightings are still reported - the uplink row is evidence, and suppressing it would hide the
    // only thing that shows the path the traffic took.
    const transit = result.matches.filter(m => m.transit);
    assert.equal(transit.length, 1);
    assert.equal(transit[0].deviceIp, topology.transitIp);
    assert.equal(transit[0].port, topology.transitPort);
    assert.ok(result.matches.some(m => !m.transit && m.via === 'clients'));
});

test('a MAC seen only in passing is TRANSIT_ONLY, never a location', () => {
    const topology = byName('transit-sighting');
    // The access switch dropped out of the crawl, so only the uplink's sighting survives.
    const trimmed = JSON.parse(JSON.stringify(topology.snapshot.Topology))
        .filter(d => String(d.DeviceIP) !== topology.accessIp);
    const result = resolveEndpoint(topology.clientMac, trimmed, { allowedScopes: ALLOWED_SCOPES });
    assert.equal(result.status, 'TRANSIT_ONLY');
    assert.deepEqual(result.locations, []);
    assert.ok(result.matches.every(m => m.transit));
});

test('a management IP resolves to the device, and a client IP to the client', () => {
    const resolver = resolverFor('transit-sighting');
    const topology = byName('transit-sighting');
    const device = resolver.resolve(topology.accessIp);
    assert.equal(device.status, 'FOUND');
    assert.equal(device.matches[0].type, 'device');
    assert.ok(device.interpretations.includes('management-ip') && device.interpretations.includes('client-ip'),
        'which of the two an address is cannot be decided from the string, so both are tried');

    const client = resolver.resolve('10.30.209.5');
    assert.equal(client.status, 'FOUND');
    assert.ok(client.matches.some(m => m.type === 'client' && m.macKey === topology.clientMac));
});

test('a hostname resolves whole or short, and a serial resolves to the member that carries it', () => {
    const resolver = resolverFor('virtual-chassis-across-fpcs');
    const vc = byName('virtual-chassis-across-fpcs').snapshot.Topology.find(d => d.StackMembers.length > 1);
    for (const query of [vc.Hostname, vc.Hostname.split('.')[0]]) {
        const result = resolver.resolve(query);
        assert.equal(result.status, 'FOUND');
        assert.equal(result.matches[0].deviceIp, String(vc.DeviceIP));
    }
    const backup = vc.StackMembers[1];
    const bySerial = resolver.resolve(backup.Serial);
    assert.equal(bySerial.status, 'FOUND');
    assert.equal(bySerial.matches[0].deviceIp, String(vc.DeviceIP), 'a VC is one node, whichever FPC you name');
    assert.equal(bySerial.matches[0].fpc, backup.FPC);
});

test('switch plus port resolves, and the two FPCs of a VC are different ports', () => {
    const resolver = resolverFor('virtual-chassis-across-fpcs');
    const vc = byName('virtual-chassis-across-fpcs').snapshot.Topology.find(d => d.StackMembers.length > 1);
    const first = resolver.resolve(`${vc.DeviceIP} ge-0/0/0`);
    const second = resolver.resolve(`${vc.DeviceIP} ge-1/0/0`);
    assert.equal(first.status, 'FOUND');
    assert.equal(second.status, 'FOUND');
    assert.notDeepEqual(first.locations, second.locations);
    // A unit suffix is not part of a port's identity (R14).
    assert.deepEqual(resolver.resolve(`${vc.DeviceIP} ge-0/0/0.0`).locations, first.locations);
});

test('an 802.1X user resolves to the client that presented it', () => {
    const held = { ...byName('transit-sighting') };
    const topology = JSON.parse(JSON.stringify(held.snapshot.Topology));
    const access = topology.find(d => String(d.DeviceIP) === held.accessIp);
    access.Clients[0].Dot1x_User = 'lab\\user101';
    access.Clients[0].Dot1x_State = 'Held';
    const resolver = createResolver(topology, { allowedScopes: ALLOWED_SCOPES });
    for (const query of ['lab\\user101', 'user101']) {
        const result = resolver.resolve(query);
        assert.equal(result.status, 'FOUND', query);
        assert.equal(result.matches[0].dot1xState, 'Held');
    }
});

// A failed scan makes a device a possible waypoint and never an endpoint; Partial is the dangerous case
// because it carries real data and reads as complete.
test('resolution flags a device whose scan failed or stopped early', () => {
    const waypointIp = byName('unscanned-waypoint').waypointIp;
    const failed = resolverFor('unscanned-waypoint').resolve(waypointIp);
    assert.equal(failed.status, 'FOUND');
    assert.ok(failed.notes.includes(`device-scan-failed:${waypointIp}`));
    assert.equal(failed.matches[0].scanStatus, 'Timeout');

    const partialIp = byName('partial-node-missing-stp-section').partialIp;
    const partial = resolverFor('partial-node-missing-stp-section').resolve(partialIp);
    assert.ok(partial.notes.includes(`device-scan-partial:${partialIp}`),
        'Partial carries real data, so nothing else distinguishes it from a complete capture');
});

test('a port description resolves and is allowed to be ambiguous', () => {
    const resolver = resolverFor('addressless-bridge-shared-segment');
    const result = resolver.resolve('UNMANAGED shared segment');
    assert.equal(result.status, 'AMBIGUOUS');
    assert.equal(result.locations.length, 2, 'both switches label the port the same way');
    assert.ok(result.matches.every(m => m.type === 'port'));
});

// The tier the free-text search sits in. Every uplink is labelled "UPLINK to <peer hostname>", so a
// substring search ranked alongside the exact identifiers would make resolving any switch by name
// ambiguous with the ports of everything patched to it.
test('a substring of a port label is only consulted when nothing matched exactly', () => {
    const resolver = resolverFor('virtual-chassis-across-fpcs');
    const vc = byName('virtual-chassis-across-fpcs').snapshot.Topology.find(d => d.StackMembers.length > 1);
    const byName_ = resolver.resolve(vc.Hostname);
    assert.equal(byName_.status, 'FOUND');
    assert.ok(!byName_.interpretations.includes('description'));
    assert.ok(byName_.matches.every(m => m.type === 'device'));
    // The label really does contain that hostname, and is reachable when nothing else matches.
    const byLabel = resolver.resolve('UPLINK to');
    assert.ok(byLabel.interpretations.includes('description'));
    assert.ok(byLabel.matches.every(m => m.type === 'port'));
});

test('nothing at all is NOT_FOUND, not an empty FOUND', () => {
    const result = resolverFor('transit-sighting').resolve('aa:bb:ff:ff:ff:ff');
    assert.equal(result.status, 'NOT_FOUND');
    assert.deepEqual(result.matches, []);
});

test('every micro-topology resolves each of its own clients to exactly one place', () => {
    for (const topology of MICRO_TOPOLOGIES) {
        const resolver = createResolver(topology.snapshot.Topology, { allowedScopes: ALLOWED_SCOPES });
        for (const device of topology.snapshot.Topology) {
            for (const client of device.Clients) {
                const result = resolver.resolve(client.MAC);
                assert.ok(['FOUND', 'AMBIGUOUS'].includes(result.status),
                    `${topology.name}: ${client.MAC} resolved ${result.status}`);
                if (result.status === 'AMBIGUOUS') continue;   // the inferred-segment port holds several
                assert.deepEqual(result.locations, [`${device.DeviceIP}|${String(client.Port).replace(/\.\d+$/, '')}`],
                    `${topology.name}: ${client.MAC}`);
            }
        }
    }
});

// ---------------------------------------------------------------- fixture scale
// The first real use of item 8's manifests: the injected fault says where it is, and resolution has to
// find exactly that. A golden file could not do this - any generator edit would invalidate it.

function generateFaulted() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pnm_resolve_'));
    execFileSync(process.execPath, [GENERATOR, '--out', out, '--devices', '60', '--seed', '11',
        '--snapshots', '1', '--faults', '9'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const mapName = fs.readdirSync(out).find(f => /^NetworkMap_.*\.fixture\.json$/.test(f));
    const manifestName = fs.readdirSync(out).find(f => /^FaultManifest_.*\.fixture\.json$/.test(f));
    const config = JSON.parse(fs.readFileSync(path.join(out, 'Configuration.fixture.json'), 'utf8'));
    return {
        snapshot: JSON.parse(fs.readFileSync(path.join(out, mapName), 'utf8')),
        manifest: JSON.parse(fs.readFileSync(path.join(out, manifestName), 'utf8')),
        allowedScopes: config.settings.allowedScopes,
    };
}

const fixture = generateFaulted();
const fixtureResolver = createResolver(fixture.snapshot.Topology, { allowedScopes: fixture.allowedScopes });
const faultsOfKind = (kind) => fixture.manifest.Faults.filter(f => f.kind === kind);

test('the manifest describes faults that are all placeable in this fixture', () => {
    assert.ok(fixture.manifest.Faults.length >= 7, 'a 60-device fleet places every kind at least once');
});

test('an injected duplicate MAC resolves AMBIGUOUS to exactly the two ports the manifest names', () => {
    const faults = faultsOfKind('duplicate-mac');
    assert.ok(faults.length > 0);
    for (const fault of faults) {
        const result = fixtureResolver.resolve(fault.mac);
        assert.equal(result.status, 'AMBIGUOUS', `${fault.id}: ${result.status}`);
        const expected = [
            `${fault.deviceIp}|${fault.port}`,
            `${fault.params.alsoOn}|${fault.params.alsoOnPort}`,
        ].sort();
        assert.deepEqual(result.locations, expected, fault.id);
    }
});

test('an injected duplicate IP reports both claimants rather than picking one', () => {
    for (const fault of faultsOfKind('duplicate-ip')) {
        const result = fixtureResolver.resolve(fault.params.ip);
        // The injected claimant has an ARP entry and no sighting anywhere, which is how the second
        // claimant of a contested address usually appears - so it has to come back in `claimants`
        // rather than only in the match list, or the reported ambiguity names nothing.
        const claimants = new Set(result.claimants.map(m => m.toUpperCase()));
        assert.ok(claimants.has(fault.mac.toUpperCase()), `${fault.id}: ${result.claimants}`);
        assert.ok(claimants.has(fault.params.alsoClaimedBy.toUpperCase()), `${fault.id}: ${result.claimants}`);
        assert.ok(result.notes.some(n => /^ip-claimed-by-\d+-macs$/.test(n)), fault.id);
    }
});

test('an injected off-subnet client still resolves, by its own address', () => {
    for (const fault of faultsOfKind('off-subnet-client')) {
        const result = fixtureResolver.resolve(fault.params.ip);
        assert.equal(result.status, 'FOUND', fault.id);
        assert.deepEqual(result.locations, [`${fault.deviceIp}|${fault.port}`], fault.id);
        assert.ok(!fixture.allowedScopes.some(s => fault.params.ip.startsWith(s)));
    }
});

test('an injected held supplicant is findable by the identity it presented', () => {
    for (const fault of faultsOfKind('dot1x-held')) {
        const result = fixtureResolver.resolve(fault.params.user);
        assert.ok(['FOUND', 'AMBIGUOUS'].includes(result.status), fault.id);
        assert.ok(result.locations.includes(`${fault.deviceIp}|${fault.port}`), fault.id);
        assert.ok(result.matches.some(m => m.macKey === fault.mac.toUpperCase() && m.dot1xState === 'Held'), fault.id);
    }
});

// An MED system name is an exact identifier and still not unique: the fleet reuses AP and phone labels
// across closets on purpose, so this is the ambiguity an operator reading a faceplate walks into.
test('an MED endpoint resolves by system name, ambiguously where the name is reused', () => {
    const names = new Map();
    for (const device of fixture.snapshot.Topology) {
        for (const med of device.MedNeighbors || []) {
            if (!names.has(med.Hostname)) names.set(med.Hostname, new Set());
            names.get(med.Hostname).add(`${device.DeviceIP}|${String(med.LocalPort).replace(/\.\d+$/, '')}`);
        }
    }
    const unique = [...names].find(([, places]) => places.size === 1);
    const reused = [...names].find(([, places]) => places.size > 1);
    assert.ok(unique, 'the fixture has MED endpoints');
    const single = fixtureResolver.resolve(unique[0]);
    assert.equal(single.status, 'FOUND');
    assert.ok(single.matches.some(m => m.type === 'med-endpoint'));
    if (reused) {
        const many = fixtureResolver.resolve(reused[0]);
        assert.equal(many.status, 'AMBIGUOUS', reused[0]);
        assert.deepEqual(many.locations, [...reused[1]].sort());
    }
});

test('a device that never answered is still resolvable, and flagged', () => {
    const failed = fixture.snapshot.Topology.filter(d => d.ScanStatus !== 'Ok');
    assert.ok(failed.length > 0, 'the fixture keeps failed scans');
    for (const device of failed) {
        const result = fixtureResolver.resolve(String(device.DeviceIP));
        assert.equal(result.status, 'FOUND');
        assert.ok(result.notes.some(n => n.startsWith('device-scan-')), String(device.DeviceIP));
    }
});

test('every client in the fixture resolves to a place, and none of them to two by accident', () => {
    const injected = new Set(fixture.manifest.Faults.filter(f => f.kind === 'duplicate-mac').map(f => f.mac));
    let checked = 0;
    let ambiguous = [];
    for (const device of fixture.snapshot.Topology) {
        for (const client of device.Clients) {
            if (injected.has(client.MAC)) continue;
            const result = fixtureResolver.resolve(client.MAC);
            assert.notEqual(result.status, 'NOT_FOUND', `${client.MAC} on ${device.DeviceIP}`);
            if (result.status === 'AMBIGUOUS') ambiguous.push(`${client.MAC}:${result.locations.join(',')}`);
            checked++;
        }
    }
    assert.ok(checked > 200, `only ${checked} clients checked`);
    // buildMacTable deliberately ages one MAC in on a second port of the same switch - R3's case, and a
    // genuine ambiguity: the host is on one of two ports and the table cannot say which. What must not
    // happen is one MAC resolving to two DEVICES with no injected fault behind it.
    for (const entry of ambiguous) {
        const places = entry.split(':').pop().split(',');
        const devices = new Set(places.map(place => place.split('|')[0]));
        assert.equal(devices.size, 1, `${entry} spans two devices with no fault injected`);
    }
    assert.ok(ambiguous.length > 0, 'the fixture is meant to contain the two-ports-one-switch case');
});
