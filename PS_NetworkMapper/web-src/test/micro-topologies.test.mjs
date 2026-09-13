// Section 8.4. Each micro-topology is asserted on the structural property it was built for - not on a
// rule verdict, because the rule engine does not exist yet (work order item 11). When it does, these
// are its inputs, and a test here failing means the input drifted rather than the rule regressed.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MICRO_TOPOLOGIES, byName, ALLOWED_SCOPES, CAPTURE_SECTIONS, STP_PRECEDENCE } from '../tools/micro-topologies.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const GENERATOR = path.join(ROOT, 'web-src', 'tools', 'generate-fixture.mjs');

const devices = (topology) => topology.snapshot.Topology;
const byIp = (topology) => new Map(devices(topology).map(d => [String(d.DeviceIP), d]));
const rowOf = (device, port) => device.Interfaces.find(r => r.Port === String(port).replace(/\.\d+$/, ''));

// Links whose two ends both forward in `scope`. A scope no port reports is not the same as a scope in
// which nothing forwards, so an absent scope yields null rather than an empty set.
function forwardingEdges(topology, scope) {
    const map = byIp(topology);
    const edges = new Set();
    let sawScope = false;
    for (const device of devices(topology)) {
        for (const neighbor of device.Neighbors) {
            const peer = map.get(String(neighbor.ManagementIP));
            if (!peer) continue;
            const near = rowOf(device, neighbor.LocalPort);
            const far = rowOf(peer, neighbor.RemotePort);
            if (!near || !far) continue;
            const nearDetail = near.StpDetail[scope];
            const farDetail = far.StpDetail[scope];
            if (!nearDetail || !farDetail) continue;
            sawScope = true;
            if (nearDetail.State === 'FWD' && farDetail.State === 'FWD') {
                edges.add([String(device.DeviceIP), String(peer.DeviceIP)].sort().join('~'));
            }
        }
    }
    return sawScope ? [...edges].sort() : null;
}

// Links reachable with no spanning-tree filtering at all, which is what a naive graph over LLDP sees.
function allEdges(topology) {
    const map = byIp(topology);
    const edges = new Set();
    for (const device of devices(topology)) {
        for (const neighbor of device.Neighbors) {
            const peer = map.get(String(neighbor.ManagementIP));
            if (peer) edges.add([String(device.DeviceIP), String(peer.DeviceIP)].sort().join('~'));
        }
    }
    return [...edges].sort();
}

function connects(topology, edges) {
    const adjacency = new Map(devices(topology).map(d => [String(d.DeviceIP), []]));
    for (const edge of edges) {
        const [a, b] = edge.split('~');
        adjacency.get(a).push(b);
        adjacency.get(b).push(a);
    }
    const start = String(devices(topology)[0].DeviceIP);
    const seen = new Set([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
        for (const next of adjacency.get(queue[head])) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    return seen.size === devices(topology).length;
}

const catalogued = new Set([...fs.readFileSync(path.join(ROOT, 'docs', 'diagnostics-spec.md'), 'utf8')
    .matchAll(/^\| (F\d+) \|/gm)].map(m => m[1]));

test('every micro-topology is named, described, and labelled only with real failure modes', () => {
    assert.ok(catalogued.size >= 14, `only ${catalogued.size} failure modes read from the spec`);
    assert.equal(MICRO_TOPOLOGIES.length, 12);
    // The cases that do carry a label must cover the ones section 8.4 names by number.
    const labelled = new Set(MICRO_TOPOLOGIES.flatMap(t => t.failureModes));
    for (const mode of ['F5', 'F10', 'F13', 'F14']) assert.ok(labelled.has(mode), `no topology covers ${mode}`);
    const names = MICRO_TOPOLOGIES.map(t => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const topology of MICRO_TOPOLOGIES) {
        assert.ok(topology.description.length > 40, `${topology.name} has no usable description`);
        // An empty list is the honest answer for the cases section 8.4 lists without a failure mode;
        // each one says why at its builder. A label invented to satisfy a test would mis-train item 11.
        assert.ok(Array.isArray(topology.failureModes));
        assert.ok(topology.failureModes.every(f => catalogued.has(f)),
            `${topology.name}: ${topology.failureModes} is not all in section 7`);
        assert.ok(devices(topology).length >= 1 && devices(topology).length <= 4,
            `${topology.name} has ${devices(topology).length} devices; these are meant to be readable by hand`);
        assert.ok(topology.snapshot.ScanTimestamp);
    }
});

// Nothing in the module may be random: a regression test needs a fixed input.
test('micro-topologies are byte-identical between two imports of the module', async () => {
    const again = await import('../tools/micro-topologies.mjs?reimport=1');
    assert.equal(
        JSON.stringify(again.MICRO_TOPOLOGIES.map(t => t.snapshot)),
        JSON.stringify(MICRO_TOPOLOGIES.map(t => t.snapshot)));
});

// The shape contract: a consumer written against a real snapshot must read these unchanged. Checked
// against the worker's own initializers rather than against the generator, which omits fields itself.
test('every node and interface key exists in the worker initializers', () => {
    const worker = fs.readFileSync(path.join(ROOT, 'lib', 'Get-JunosNodeData.ps1'), 'utf8');
    // Both initializers are one hashtable literal ending on a line with a bare closing brace, so the
    // key set can be read from the source rather than restated here and left to rot.
    const blockAfter = (marker) => {
        const start = worker.indexOf(marker);
        assert.notEqual(start, -1, `${marker} is gone from the worker`);
        const closing = `\n${marker.match(/^\s*/)[0]}}`;
        const end = worker.indexOf(closing, start);
        assert.ok(end > start, `${marker} has no closing brace at its own indent`);
        const block = worker.slice(start, end);
        return new Set([...block.matchAll(/(?:^|[{;\s])([A-Z]\w+)\s*=/gm)].map(m => m[1]));
    };
    const nodeKeys = blockAfter('$NodeData = @{');
    const rowKeys = blockAfter('                $NodeData.Interfaces[$p] = @{');
    // Guard against a regex that silently matched nothing: these counts only ever grow.
    assert.ok(nodeKeys.size > 20, `only ${nodeKeys.size} node keys read from the worker`);
    assert.ok(rowKeys.size > 40, `only ${rowKeys.size} interface keys read from the worker`);

    for (const topology of MICRO_TOPOLOGIES) {
        for (const device of devices(topology)) {
            for (const key of Object.keys(device)) {
                assert.ok(nodeKeys.has(key), `${topology.name}: node key ${key} is in no worker initializer`);
            }
            for (const row of device.Interfaces) {
                for (const key of Object.keys(row)) {
                    // LogicalUnits is the per-row filtered view R1 attaches after the initializer.
                    assert.ok(rowKeys.has(key) || key === 'LogicalUnits',
                        `${topology.name}: interface key ${key} is in no worker initializer`);
                }
            }
        }
    }
});

test('SectionsCaptured uses the worker command order the generator also uses', () => {
    const source = fs.readFileSync(GENERATOR, 'utf8');
    const block = source.match(/const CAPTURE_SECTIONS = \[([\s\S]*?)\];/);
    assert.ok(block, 'the generator no longer declares CAPTURE_SECTIONS');
    const generatorSections = [...block[1].matchAll(/'([A-Z0-9_]+)'/g)].map(m => m[1]);
    assert.deepEqual(CAPTURE_SECTIONS, generatorSections);
});

// A hand-authored per-VLAN state is easy to get wrong in a way no consumer would notice until it made a
// rule look broken, so each VSTP topology's every instance must be a spanning tree in its own right.
test('each VSTP instance forwards over a spanning tree of its own', () => {
    for (const name of ['triangle-vstp-leg-blocked-in-one-vlan', 'diamond-two-paths-per-vlan']) {
        const topology = byName(name);
        for (const scope of ['VLAN 10', 'VLAN 20']) {
            const edges = forwardingEdges(topology, scope);
            assert.ok(edges, `${name}: no port reports ${scope}`);
            assert.equal(edges.length, devices(topology).length - 1,
                `${name}: ${scope} forwards on ${edges.length} links, not ${devices(topology).length - 1}`);
            assert.ok(connects(topology, edges), `${name}: ${scope} does not reach every bridge`);
        }
    }
});

// F5. The hard rule from section 2.2, as a property of the input rather than a note in the spec.
test('F5: a leg blocked in one VLAN and forwarding in another collapses to BLK', () => {
    const topology = byName('triangle-vstp-leg-blocked-in-one-vlan');
    const leg = topology.blockedLeg;
    const row = rowOf(byIp(topology).get(leg.deviceIp), leg.port);
    assert.equal(row.StpDetail[leg.blockedIn].State, 'BLK');
    assert.equal(row.StpDetail[leg.forwardingIn].State, 'FWD');
    // Worst case wins, exactly as the worker's precedence table has it.
    assert.equal(row.STP, 'BLK');
    assert.ok(STP_PRECEDENCE.BLK > STP_PRECEDENCE.FWD);
    // The point of the case: pruning on the collapsed field alone removes a hop VLAN 20 forwards on.
    const collapsedEdges = new Set();
    for (const device of devices(topology)) {
        for (const neighbor of device.Neighbors) {
            const peer = byIp(topology).get(String(neighbor.ManagementIP));
            const near = rowOf(device, neighbor.LocalPort);
            const far = rowOf(peer, neighbor.RemotePort);
            if (near.STP === 'FWD' && far.STP === 'FWD') {
                collapsedEdges.add([String(device.DeviceIP), String(peer.DeviceIP)].sort().join('~'));
            }
        }
    }
    const vlan20 = forwardingEdges(topology, 'VLAN 20');
    assert.ok(vlan20.some(e => !collapsedEdges.has(e)),
        'the topology no longer contains a hop the collapsed field would wrongly prune');
});

// F13. Absent evidence, not evidence of absence: the VLAN is configured and carried, and no instance
// covers it, so a hop in it cannot be pruned at all.
test('F13: a configured VLAN with no spanning-tree instance', () => {
    const topology = byName('vlan-with-no-stp-instance');
    const tag = topology.unscopedVlanTag;
    const scopes = new Set();
    for (const device of devices(topology)) {
        for (const row of device.Interfaces) for (const scope of Object.keys(row.StpDetail)) scopes.add(scope);
    }
    assert.ok(scopes.size > 0, 'the topology does run a spanning tree, just not in this VLAN');
    assert.ok(!scopes.has(`VLAN ${tag}`), `VLAN ${tag} has an instance after all`);
    // Configured, carried on the trunk, and used by a client: it is not a leftover definition.
    for (const device of devices(topology)) {
        assert.ok(device.Vlans.some(v => v.Tag === tag), 'the VLAN must be configured on both bridges');
    }
    const client = devices(topology).flatMap(d => d.Clients).find(c => c.VLAN_Tag === tag);
    assert.ok(client, 'a VLAN nothing sits in would be an uninteresting case');
    assert.equal(typeof client.VLAN_Tag, 'number', 'C4: tags are integers on both sides');
});

// F10. Three different wrong answers from one topology, which is why the case is worth hand-building.
test('F10: two paths in the unpruned graph, one per VLAN, none on the collapsed field', () => {
    const topology = byName('diamond-two-paths-per-vlan');
    const access = devices(topology).find(d => d.Hostname.includes('access'));
    const uplinks = access.Interfaces.filter(r => access.Neighbors.some(n => n.LocalPort === r.Port));
    assert.equal(uplinks.length, 2, 'the access switch is dual-homed');
    assert.equal(allEdges(topology).length, topology.edgeCount);
    // Every uplink forwards in exactly one VLAN and blocks in the other.
    for (const row of uplinks) {
        const states = Object.values(row.StpDetail).map(d => d.State).sort();
        assert.deepEqual(states, ['BLK', 'FWD']);
        assert.equal(row.STP, 'BLK', 'the collapse hides the VLAN that forwards');
    }
    // So a path computer pruning on the collapsed field cannot leave the access switch at all.
    const upstreamNames = new Set(uplinks.map(r => r.Port));
    assert.ok([...upstreamNames].every(p => rowOf(access, p).STP !== 'FWD'));
});

test('a two-member LAG reports two LLDP links over one aggregate', () => {
    const topology = byName('lag-two-members-up');
    for (const device of devices(topology)) {
        const bundle = rowOf(device, topology.bundle);
        assert.deepEqual(bundle.BundleMembers, ['ge-0/0/0', 'ge-0/0/1']);
        assert.equal(bundle.StpDetail['instance 0'].State, 'FWD');
        for (const member of bundle.BundleMembers) {
            const row = rowOf(device, member);
            assert.equal(row.Bundle, topology.bundle);
            // The spanning tree runs on the aggregate, so a member carries no state of its own.
            assert.deepEqual(row.StpDetail, {});
            assert.ok(device.Neighbors.some(n => n.LocalPort === member), 'LLDP runs on the member links');
        }
        assert.ok(!device.Neighbors.some(n => n.LocalPort === topology.bundle),
            'an aggregate does not speak LLDP itself, which is what makes the dedup necessary');
    }
});

test('a LAG with a down member still forwards, on half the links', () => {
    const topology = byName('lag-two-members-one-down');
    for (const device of devices(topology)) {
        const bundle = rowOf(device, topology.bundle);
        assert.equal(bundle.Link, 'up');
        assert.equal(bundle.StpDetail['instance 0'].State, 'FWD');
        assert.equal(bundle.BundleMembers.length, 2, 'configuration is unchanged by a member going down');
        const down = bundle.BundleMembers.filter(m => rowOf(device, m).Link === 'down');
        assert.deepEqual(down, ['ge-0/0/1']);
        assert.ok(!device.Neighbors.some(n => n.LocalPort === 'ge-0/0/1'),
            'a down member carries no neighbour');
        assert.equal(device.Neighbors.length, 1);
    }
});

test('a virtual chassis puts the same port number on two FPCs', () => {
    const topology = byName('virtual-chassis-across-fpcs');
    const vc = devices(topology).find(d => d.StackMembers.length > 1);
    assert.equal(vc.StackMembers.length, 2);
    assert.deepEqual(vc.StackMembers.map(m => m.Role), ['Master', 'Backup']);
    assert.ok(vc.StackMembers.every(m => m.Status === 'Prsnt'));
    const clientPorts = vc.Clients.map(c => c.Port);
    assert.deepEqual(clientPorts.sort(), ['ge-0/0/0.0', 'ge-1/0/0.0']);
    // Two distinct ports whose trailing number is the same: port identity is the whole fpc/pic/port.
    assert.equal(new Set(clientPorts.map(p => p.split('/').pop())).size, 1);
    assert.equal(new Set(clientPorts).size, 2);
});

test('an unscanned waypoint keeps its links and has no port state', () => {
    const topology = byName('unscanned-waypoint');
    const waypoint = byIp(topology).get(topology.waypointIp);
    assert.equal(waypoint.ScanStatus, 'Timeout');
    assert.deepEqual(waypoint.Interfaces, [], 'C3: a placeholder Interfaces is an array');
    assert.deepEqual(waypoint.Neighbors, []);
    assert.deepEqual(waypoint.SectionsCaptured, []);
    assert.equal(waypoint.CaptureTimestamp, null);
    // The link is real: both ends of it reported the waypoint over LLDP.
    const pointingAtIt = devices(topology).filter(d => d.Neighbors.some(n => n.ManagementIP === waypoint.DeviceIP));
    assert.equal(pointingAtIt.length, 2);
    // And a path through it crosses a hop with nothing to evaluate: the ports its neighbours name do
    // not exist on it, so there is no state to compare either end against.
    for (const device of pointingAtIt) {
        const neighbor = device.Neighbors.find(n => n.ManagementIP === waypoint.DeviceIP);
        assert.equal(rowOf(waypoint, neighbor.RemotePort), undefined);
        assert.equal(rowOf(device, neighbor.LocalPort).STP, 'FWD', 'our own end forwards regardless');
    }
    assert.equal(forwardingEdges(topology, 'instance 0'), null,
        'not an empty set: no link in this snapshot has two ends whose state can be read');
});

test('an address-less bridge is two DESG FWD ports and no node between them', () => {
    const topology = byName('addressless-bridge-shared-segment');
    const ends = [];
    for (const device of devices(topology)) {
        const neighbor = device.Neighbors.find(n => n.MacAddress === topology.bridgeMac);
        assert.ok(neighbor);
        assert.equal(neighbor.ManagementIP, 'Unknown');
        assert.equal(neighbor.Reachable, false, 'R5: an address-less neighbour is not enqueued for a crawl');
        const row = rowOf(device, neighbor.LocalPort);
        assert.equal(row.StpDetail['instance 0'].Role, 'Designated');
        assert.equal(row.STP, 'FWD');
        ends.push(`${device.DeviceIP}|${row.Port}`);
    }
    assert.equal(ends.length, 2);
    // F14: the two ends share a segment, and no node exists to chain them through.
    assert.ok(!devices(topology).some(d => d.MacAddress === topology.bridgeMac));
    assert.equal(allEdges(topology).length, 0, 'neither end resolves to a device in the snapshot');
});

test('an out-of-scope neighbour has an address and still no node', () => {
    const topology = byName('out-of-scope-neighbor');
    const neighbor = devices(topology)[0].Neighbors.find(n => n.ManagementIP === topology.outOfScopeIp);
    assert.ok(neighbor);
    assert.equal(neighbor.Reachable, true, 'it is reachable; it is simply not ours to crawl');
    assert.ok(!ALLOWED_SCOPES.some(s => String(neighbor.ManagementIP).startsWith(s)));
    assert.ok(!byIp(topology).has(topology.outOfScopeIp), 'an out-of-scope device is never a node');
});

test('a Partial node carries data and is missing the section a rule would need', () => {
    const topology = byName('partial-node-missing-stp-section');
    const partial = byIp(topology).get(topology.partialIp);
    assert.equal(partial.ScanStatus, 'Partial');
    // Partial is not a placeholder: it captured everything up to the point the session died.
    assert.ok(partial.Interfaces.length > 0);
    assert.ok(partial.StackMembers.length > 0);
    assert.equal(partial.DefaultRoute.State, 'Parsed');
    // And dropping a section drops what that section supplies, or the node asserts a state no switch
    // produces and a guard-gated rule reads NOT_EVALUATED beside data that is plainly there.
    assert.deepEqual(partial.Clients, []);
    assert.deepEqual(partial.MacTable, []);
    assert.deepEqual(partial.Neighbors, [], 'LLDP is past the truncation point');
    assert.equal(partial.Configuration, 'Unknown');
    assert.equal(partial.MasterCpuUtilization, 'Unknown');
    // One-sided LLDP is what a session dying mid-capture leaves behind, and is its own interesting case.
    const other = devices(topology).find(d => d !== partial);
    assert.ok(other.Neighbors.some(n => n.ManagementIP === partial.DeviceIP));
    assert.ok(!partial.SectionsCaptured.includes(topology.missingSection));
    assert.ok(partial.SectionsCaptured.length > 0 && partial.SectionsCaptured.length < CAPTURE_SECTIONS.length);
    // The false clean the guard exists to prevent: empty containers, not null or absent ones.
    for (const row of partial.Interfaces) {
        assert.deepEqual(row.StpDetail, {});
        assert.equal(row.STP, 'Unknown');
    }
    // Distinguishable only through SectionsCaptured, which is why section 3.2 gates on a guard rather
    // than on a path string that would find StpDetail present and empty.
    assert.ok(!partial.SectionsCaptured.includes('STP'));
});

// The CLI exists so one of these can be opened in the visualizer by hand.
test('the module writes loadable snapshots when run directly', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pnm_micro_'));
    execFileSync(process.execPath, [path.join(ROOT, 'web-src', 'tools', 'micro-topologies.mjs'), '--out', out],
        { stdio: ['ignore', 'ignore', 'ignore'] });
    const names = fs.readdirSync(out).sort();
    assert.equal(names.length, MICRO_TOPOLOGIES.length);
    for (const name of names) {
        assert.ok(/^NetworkMap_.*\.json$/.test(name), `${name} would not be picked up by the loaders`);
        const parsed = JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
        assert.ok(Array.isArray(parsed.Topology) && parsed.Topology.length > 0);
    }
});
