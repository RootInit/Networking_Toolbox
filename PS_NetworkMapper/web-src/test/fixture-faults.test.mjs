// Section 8.3. The manifest is the oracle: every entry has to be findable in the snapshot it names,
// and a snapshot must hold no fault the manifest is silent about.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const GENERATOR = path.join(ROOT, 'web-src', 'tools', 'generate-fixture.mjs');

function generate(args) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pnm_faults_'));
    execFileSync(process.execPath, [GENERATOR, '--out', out, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    const names = fs.readdirSync(out).filter(f => /^NetworkMap_.*\.fixture\.json$/.test(f)).sort();
    const manifests = fs.readdirSync(out).filter(f => /^FaultManifest_.*\.fixture\.json$/.test(f)).sort();
    return {
        dir: out, names, manifests,
        snapshots: names.map(n => JSON.parse(fs.readFileSync(path.join(out, n), 'utf8'))),
        faults: manifests.map(n => JSON.parse(fs.readFileSync(path.join(out, n), 'utf8'))),
        bytes: new Map(names.map(n => [n, fs.readFileSync(path.join(out, n))])),
    };
}

const ARGS = ['--devices', '60', '--seed', '5', '--snapshots', '2'];
// Nine against eight kinds, so the cycle wraps and a second instance of a kind has to place as well.
const faulted = generate([...ARGS, '--faults', '9']);
const clean = generate(ARGS);

const byIp = (snapshot) => new Map(snapshot.Topology.map(d => [String(d.DeviceIP), d]));
const rowOf = (device, port) => device.Interfaces.find(r => r.Port === port);
const entries = faulted.faults.flatMap(m => m.Faults);
const find = (kind) => entries.filter(f => f.kind === kind);
// The snapshot an entry belongs to, resolved through the map name the manifest records rather than by
// position: pairing them by index would pass even if the generator wrote them out of step.
const mapFor = (manifest) => faulted.snapshots[faulted.names.indexOf(manifest.Map)];
const manifestOf = (entry) => faulted.faults.find(m => m.Faults.includes(entry));
const snapshotOf = (entry) => mapFor(manifestOf(entry));

// Links whose two ends both forward, keyed the way the generator's own assertion keys them.
function forwardingEdges(snapshot) {
    const devices = byIp(snapshot);
    const edges = new Set();
    for (const d of snapshot.Topology) {
        for (const n of d.Neighbors) {
            if (n.Reachable === false) continue;
            const peer = devices.get(String(n.ManagementIP));
            if (!peer) continue;
            const near = rowOf(d, String(n.LocalPort).replace(/\.\d+$/, ''));
            const far = rowOf(peer, String(n.RemotePort).replace(/\.\d+$/, ''));
            if (near && far && near.STP === 'FWD' && far.STP === 'FWD') {
                edges.add([String(d.DeviceIP), String(peer.DeviceIP)].sort().join('~'));
            }
        }
    }
    return [...edges].sort();
}

test('a manifest is written per snapshot and names the map it describes', () => {
    assert.equal(faulted.manifests.length, faulted.names.length);
    for (const [i, m] of faulted.faults.entries()) {
        assert.equal(m.Map, faulted.names[i], 'the manifest and the map must pair by timestamp');
        assert.equal(m.Requested, 9);
        assert.ok(m.Faults.length > 0, 'a 60-device fleet is large enough to place every kind');
    }
});

// A manifest named NetworkMap_* would be offered to the operator as a snapshot to open.
test('a manifest is not picked up by the snapshot loaders', () => {
    for (const name of faulted.manifests) {
        assert.ok(!/^NetworkMap_.*\.json$/.test(name), `${name} would load as a snapshot`);
    }
});

// Written every run, so a manifest always describes the snapshot beside it and no run can leave a
// stale one behind claiming faults it did not inject.
test('--faults 0 writes an empty manifest rather than none', () => {
    assert.equal(clean.manifests.length, clean.names.length);
    for (const m of clean.faults) {
        assert.deepEqual(m.Faults, []);
        assert.equal(m.Requested, 0);
    }
});

test('every fault kind places, and each entry carries an oracle a rule can be checked against', () => {
    const kinds = new Set(entries.map(f => f.kind));
    assert.deepEqual([...kinds].sort(), [
        'autoneg-asymmetric', 'dot1x-held', 'duplicate-ip', 'duplicate-mac',
        'off-subnet-client', 'stp-unconverged', 'unmanaged-bridge-shared-segment',
        'vlan-missing-from-trunk',
    ]);
    const ids = entries.map(f => f.id);
    assert.equal(new Set(ids).size, ids.length, 'ids must be unique across snapshots');
    for (const f of entries) {
        // A kind section 7 does not catalogue carries an empty list rather than a label invented to
        // satisfy this check: the label is what item 11 maps a finding to, so a wrong one is a wrong
        // oracle. Every kind that is missing one says why at its injector.
        assert.ok(Array.isArray(f.failureModes), `${f.id} has no failureModes list`);
        assert.ok(f.failureModes.every(m => /^F\d+$/.test(m)), `${f.id}: ${f.failureModes} is not a section 7 label`);
        assert.ok(f.expected && f.expected.finding, `${f.id} has no expected finding`);
        assert.equal(f.expected.deviceIp, f.deviceIp);
    }
    // And the labels that do appear must be ones section 7 actually lists.
    const catalogued = new Set([...fs.readFileSync(path.join(ROOT, 'docs', 'diagnostics-spec.md'), 'utf8')
        .matchAll(/^\| (F\d+) \|/gm)].map(m => m[1]));
    assert.ok(catalogued.size >= 14, `only ${catalogued.size} failure modes read from the spec`);
    for (const f of entries) {
        for (const mode of f.failureModes) assert.ok(catalogued.has(mode), `${f.id}: ${mode} is not in section 7`);
    }
});

test('no fault is claimed on a device that never answered', () => {
    for (const m of faulted.faults) {
        const devices = byIp(mapFor(m));
        for (const f of m.Faults) {
            const device = devices.get(String(f.deviceIp));
            assert.ok(device, `${f.id} names ${f.deviceIp}, which is not in ${m.Map}`);
            assert.equal(device.ScanStatus, 'Ok', `${f.id} is claimed on a device with no capture`);
        }
    }
});

test('duplicate-mac puts one MAC on two switches, in Clients and in the MAC table', () => {
    const found = find('duplicate-mac');
    assert.ok(found.length >= 2, 'the injector cycle wraps, so this kind places twice');
    for (const f of found) {
        const devices = byIp(snapshotOf(f));
        const host = devices.get(String(f.deviceIp));
        const other = devices.get(String(f.params.alsoOn));
        assert.notEqual(f.deviceIp, f.params.alsoOn);
        assert.ok(host.Clients.some(c => c.MAC === f.mac && c.Port === `${f.port}.0`));
        // The consistency an injector owns: stampCapture already ran, so the row it implies is its own.
        assert.ok(host.MacTable.some(r => r.MacAddress === f.mac && r.PhysicalPort === f.port),
            `${f.id} left a client with no MAC-table row`);
        assert.ok(other.Clients.some(c => c.MAC === f.mac && c.Port === `${f.params.alsoOnPort}.0`));
    }
});

test('duplicate-ip leaves one address claimed by two MACs in ARP', () => {
    for (const f of find('duplicate-ip')) {
        const host = byIp(snapshotOf(f)).get(String(f.deviceIp));
        const claims = host.ArpEntries.filter(a => a.IP === f.params.ip);
        assert.equal(claims.length, 2, `${f.id} did not produce a contested address`);
        assert.deepEqual([...new Set(claims.map(a => a.MAC))].sort(), [f.mac, f.params.alsoClaimedBy].sort());
    }
});

test('off-subnet-client sits outside every allowedScopes prefix', () => {
    const config = JSON.parse(fs.readFileSync(path.join(faulted.dir, 'Configuration.fixture.json'), 'utf8'));
    for (const f of find('off-subnet-client')) {
        const host = byIp(snapshotOf(f)).get(String(f.deviceIp));
        const client = host.Clients.find(c => c.MAC === f.mac);
        assert.ok(client, `${f.id} named a MAC with no client row`);
        assert.equal(client.IP, f.params.ip);
        assert.ok(!config.settings.allowedScopes.some(s => client.IP.startsWith(s)),
            `${client.IP} is inside the fleet's own scopes, so it is not off-subnet`);
        assert.ok(host.ArpEntries.some(a => a.MAC === f.mac && a.IP === f.params.ip));
    }
});

test('dot1x-held leaves a supplicant held on a link that is still up', () => {
    for (const f of find('dot1x-held')) {
        const host = byIp(snapshotOf(f)).get(String(f.deviceIp));
        const client = host.Clients.find(c => c.MAC === f.mac);
        assert.equal(client.Dot1x_State, 'Held');
        assert.notEqual(client.Dot1x_User, 'Unknown', 'a held supplicant presented an identity');
        assert.equal(rowOf(host, f.port).Link, 'up', 'the port staying up is what makes this hard to see');
    }
});

// The reason this fault is safe to inject after the tree pass: it only ever relabels a blocked port.
test('stp-unconverged adds a third port state without breaking the forwarding tree', () => {
    for (const f of find('stp-unconverged')) {
        const snapshot = snapshotOf(f);
        const host = byIp(snapshot).get(String(f.deviceIp));
        const row = rowOf(host, f.port);
        assert.equal(row.STP, 'LRN');
        assert.equal(f.params.previousState, 'BLK');
        for (const detail of Object.values(row.StpDetail || {})) {
            assert.equal(detail.State, 'LRN', 'the collapsed state and the per-scope detail must agree');
        }
        // The forwarding set itself is untouched. Not devices - 1: a placeholder device carries no
        // neighbours, so its links are unobservable in the written snapshot even though the generator
        // asserted the full tree before withFailures blanked it. Comparing against the clean run is
        // the exact statement - whatever the tree was, this fault did not move it.
        const name = manifestOf(f).Map;
        assert.deepEqual(
            forwardingEdges(JSON.parse(faulted.bytes.get(name))),
            forwardingEdges(JSON.parse(clean.bytes.get(name))),
            'relabelling a blocked port must not change which links forward');
    }
});

test('autoneg-asymmetric leaves the two ends of one link disagreeing', () => {
    for (const f of find('autoneg-asymmetric')) {
        const devices = byIp(snapshotOf(f));
        const near = devices.get(String(f.deviceIp));
        const far = devices.get(String(f.params.peerIp));
        const phy = (entry) => (entry.OrgInfo || []).find(o => String(o.Subtype).startsWith('MAC/PHY')).Info;
        const toPeer = near.Neighbors.find(n => String(n.ManagementIP) === String(f.params.peerIp));
        const back = far.Neighbors.find(n => String(n.ManagementIP) === String(f.deviceIp));
        assert.match(phy(toPeer), /disabled/);
        assert.match(phy(back), /enabled/);
    }
});

test('unmanaged-bridge-shared-segment gives two switches one address-less neighbour', () => {
    for (const f of find('unmanaged-bridge-shared-segment')) {
        const devices = byIp(snapshotOf(f));
        const ends = [[f.deviceIp, f.port], [f.params.otherIp, f.params.otherPort]];
        for (const [ip, port] of ends) {
            const device = devices.get(String(ip));
            const neighbor = device.Neighbors.find(n => n.MacAddress === f.mac);
            assert.ok(neighbor, `${f.id}: ${ip} has no neighbour for the bridge`);
            assert.equal(neighbor.ManagementIP, 'Unknown');
            assert.equal(neighbor.Reachable, false, 'an address-less bridge must not be enqueued for a crawl');
            assert.equal(String(neighbor.LocalPort).replace(/\.\d+$/, ''), port);
        }
        assert.notEqual(f.deviceIp, f.params.otherIp);
    }
});

// F11, and the strongest form of "the manifest is the oracle" available: the clean fleet's trunk ends
// agree on VLAN membership everywhere, so every disagreement in the faulted fleet must be one the
// manifest names - and each named one must actually be there, on the end the manifest says.
test('vlan-missing-from-trunk removes a tag from exactly one end, and nothing else disagrees', () => {
    const tagsOn = (row) => new Set((row.Vlans || []).map(v => v.Tag));
    const disagreements = (snapshot) => {
        const devices = byIp(snapshot);
        const found = [];
        for (const d of snapshot.Topology) {
            if (d.ScanStatus !== 'Ok') continue;
            for (const n of d.Neighbors) {
                const peer = devices.get(String(n.ManagementIP));
                if (!peer || peer.ScanStatus !== 'Ok') continue;
                const near = rowOf(d, String(n.LocalPort).replace(/\.\d+$/, ''));
                const far = rowOf(peer, String(n.RemotePort).replace(/\.\d+$/, ''));
                if (!near || !far) continue;
                const a = tagsOn(near);
                const b = tagsOn(far);
                for (const tag of new Set([...a, ...b])) {
                    // Recorded from the end that is MISSING the tag, which is the end a rule reports.
                    if (!a.has(tag) && b.has(tag)) found.push(`${d.DeviceIP}|${near.Port}|${tag}`);
                }
            }
        }
        return found.sort();
    };

    for (const snapshot of clean.snapshots) {
        assert.deepEqual(disagreements(snapshot), [], 'an uninjected fleet must carry no F11 of its own');
    }
    for (const manifest of faulted.faults) {
        const expected = manifest.Faults
            .filter(f => f.kind === 'vlan-missing-from-trunk')
            .map(f => `${f.deviceIp}|${f.port}|${f.params.vlanTag}`).sort();
        assert.ok(expected.length > 0, `${manifest.Map}: the F11 injector placed nothing`);
        assert.deepEqual(disagreements(mapFor(manifest)), expected);
    }
    for (const f of find('vlan-missing-from-trunk')) {
        const devices = byIp(snapshotOf(f));
        const device = devices.get(String(f.deviceIp));
        const peer = devices.get(String(f.params.peerIp));
        // Removed from the node's own Vlans[] as well as from the port row: the worker derives one from
        // the other, so a snapshot carrying only one of them is a shape no capture produces.
        const vlan = device.Vlans.find(v => v.Tag === f.params.vlanTag);
        assert.ok(vlan, `${f.id}: the VLAN itself must still be configured on the device`);
        assert.ok(!vlan.Interfaces.some(m => m.Port === f.port), `${f.id}: ${f.port} is still a member`);
        assert.ok(peer.Vlans.find(v => v.Tag === f.params.vlanTag).Interfaces
            .some(m => m.Port === f.params.peerPort), `${f.id}: the far end must still carry the VLAN`);
        // The link is otherwise healthy - that is what makes it worth testing.
        assert.equal(rowOf(device, f.port).Link, 'up');
        assert.equal(rowOf(peer, f.params.peerPort).Link, 'up');
    }
});

// The sub-PRNG rule from section 8.3, stated as a property rather than as a review note: if an injector
// reached rnd(), the main stream would shift and devices no fault touches would differ between runs.
test('injection does not perturb the main PRNG: untouched devices are byte-identical', () => {
    const namedIps = new Set();
    const collect = (value) => {
        if (value && typeof value === 'object') { for (const v of Object.values(value)) collect(v); return; }
        if (typeof value === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(value)) namedIps.add(value);
    };
    for (const f of entries) collect(f);
    assert.ok(namedIps.size > 0);

    assert.deepEqual(faulted.names, clean.names, 'the same run with faults must write the same snapshots');
    let compared = 0;
    for (const name of clean.names) {
        const a = new Map(JSON.parse(clean.bytes.get(name)).Topology.map(d => [String(d.DeviceIP), d]));
        const b = new Map(JSON.parse(faulted.bytes.get(name)).Topology.map(d => [String(d.DeviceIP), d]));
        assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), 'the fleet itself must not change');
        for (const [ip, device] of a) {
            if (namedIps.has(ip)) continue;
            assert.equal(JSON.stringify(b.get(ip)), JSON.stringify(device),
                `${ip} differs between --faults 0 and --faults 9, so an injector reached the main PRNG`);
            compared++;
        }
    }
    // Every device a manifest entry names anywhere is excluded, and eight kinds across two snapshots
    // name a good third of a 60-device fleet - so the bar is "most of the fleet", not a fixed count.
    assert.ok(compared > 60, `only ${compared} devices compared; the guard is not covering the fleet`);
});

test('a fleet too small to hold a fault reports fewer faults rather than claiming one', () => {
    const tiny = generate(['--devices', '4', '--seed', '5', '--snapshots', '1', '--faults', '9']);
    const placed = tiny.faults[0].Faults;
    assert.equal(tiny.faults[0].Requested, 9);
    assert.ok(placed.length <= 9);
    for (const f of placed) {
        const device = byIp(tiny.snapshots[0]).get(String(f.deviceIp));
        assert.ok(device && device.ScanStatus === 'Ok');
    }
});
