// Section 5. The micro-topologies are this module's acceptance tests: each one was built for a
// structural case, and here that case becomes an assertion about the graph the case produces.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import L2Graph from '../l2-graph.js';
import { MICRO_TOPOLOGIES, byName, ALLOWED_SCOPES } from '../tools/micro-topologies.mjs';

const { buildPortGraph, groupSharedSegments, edgesFor } = L2Graph;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const GENERATOR = path.join(ROOT, 'web-src', 'tools', 'generate-fixture.mjs');

const graphOf = (name, options) =>
    buildPortGraph(byName(name).snapshot.Topology, options === undefined ? { allowedScopes: ALLOWED_SCOPES } : options);
const endsOf = (edge) => [edge.a, edge.b].sort((x, y) => (x.ip < y.ip ? -1 : 1));

test('every micro-topology builds a graph whose edges and terminals are disjoint', () => {
    for (const topology of MICRO_TOPOLOGIES) {
        const graph = buildPortGraph(topology.snapshot.Topology, { allowedScopes: ALLOWED_SCOPES });
        const edgePorts = new Set();
        for (const edge of graph.edges) {
            for (const end of [edge.a, edge.b]) edgePorts.add(`${end.ip}|${end.port}`);
            assert.ok(graph.deviceByIp.has(edge.a.ip) && graph.deviceByIp.has(edge.b.ip),
                `${topology.name}: an edge end is not a device in the snapshot`);
            assert.notEqual(edge.a.ip, edge.b.ip, `${topology.name}: an edge joins a device to itself`);
        }
        for (const terminal of graph.terminals) {
            // The distinction the module exists to keep: a terminal is where the topology ends, and
            // chaining two of them would invent a link that is not there (F14).
            assert.ok(!edgePorts.has(`${terminal.ip}|${terminal.port}`),
                `${topology.name}: ${terminal.ip} ${terminal.port} is both an edge end and a ${terminal.kind} terminal`);
            assert.ok(['unscanned', 'out-of-scope', 'addressless-bridge', 'inferred-segment'].includes(terminal.kind));
        }
    }
});

test('a VC fabric port is never an edge or a terminal', () => {
    for (const topology of MICRO_TOPOLOGIES) {
        const graph = buildPortGraph(topology.snapshot.Topology, { allowedScopes: ALLOWED_SCOPES });
        for (const end of graph.edges.flatMap(e => [e.a, e.b])) {
            assert.ok(!/^vcp/.test(end.port), `${topology.name}: ${end.port} is internal fabric, not a hop`);
        }
        for (const terminal of graph.terminals) assert.ok(!/^vcp/.test(terminal.port));
    }
});

// Section 5.3. STP rows exist only on aeN, so an edge keyed on a member port would carry no state at
// all and every LAG hop would read as unevaluated forever.
test('a two-member LAG collapses onto the bundle, one edge with both members', () => {
    const graph = graphOf('lag-two-members-up');
    assert.equal(graph.edges.length, 1);
    const edge = graph.edges[0];
    assert.equal(edge.a.port, 'ae0');
    assert.equal(edge.b.port, 'ae0');
    assert.deepEqual(edge.a.members.map(m => m.port), ['ge-0/0/0', 'ge-0/0/1']);
    assert.deepEqual(edge.b.members.map(m => m.port), ['ge-0/0/0', 'ge-0/0/1']);
    assert.equal(edge.reciprocal, true);
    assert.equal(edge.confirmation, 'reciprocal');
    // The state comes off the bundle row, which is the only row that has any.
    assert.equal(edge.a.stp.scopes['instance 0'].State, 'FWD');
    assert.equal(edge.a.stp.captured, true);
});

test('a LAG with a down member is still one link, with the member marked down', () => {
    const graph = graphOf('lag-two-members-one-down');
    assert.equal(graph.edges.length, 1);
    const edge = graph.edges[0];
    assert.equal(edge.a.port, 'ae0');
    assert.equal(edge.a.link, 'up', 'the bundle is up on one member');
    // Both configured members are named, not only the one still carrying a neighbour: a member whose
    // link is down stops advertising LLDP, and an edge reporting the aggregate as narrower than it is
    // would hide exactly the lost capacity that makes a half-down LAG worth noticing.
    assert.deepEqual(edge.a.members.map(m => m.port), ['ge-0/0/0', 'ge-0/0/1']);
    assert.deepEqual(edge.a.members.map(m => m.link), ['up', 'down']);
    const bundleRow = graph.deviceByIp.get(edge.a.ip).Interfaces.find(r => r.Port === 'ae0');
    assert.deepEqual(bundleRow.BundleMembers, ['ge-0/0/0', 'ge-0/0/1']);
});

test('a virtual chassis is one node with one edge, and its FPCs are distinct ports', () => {
    const graph = graphOf('virtual-chassis-across-fpcs');
    assert.equal(graph.edges.length, 1);
    const vcEdge = graph.edges[0];
    const vc = [vcEdge.a, vcEdge.b].find(e => graph.deviceByIp.get(e.ip).StackMembers.length > 1);
    assert.ok(vc, 'the VC is one node, not one per FPC');
    assert.equal(vc.port, 'xe-0/2/0');
    // Ports on two FPCs share a trailing number and are not the same port.
    const ports = graph.deviceByIp.get(vc.ip).Interfaces.map(r => r.Port);
    assert.ok(ports.includes('ge-0/0/0') && ports.includes('ge-1/0/0'));
});

// The waypoint case the item-7 work settled: a device we could not log into is still a bridge, and the
// link to it is real because the other end reported it.
test('an unscanned waypoint keeps both links, one-sided and with no far-end state', () => {
    const graph = graphOf('unscanned-waypoint');
    const waypointIp = byName('unscanned-waypoint').waypointIp;
    const touching = edgesFor(graph, waypointIp);
    assert.equal(touching.length, 2, 'the middle hop keeps a link to each neighbour');
    for (const edge of touching) {
        assert.equal(edge.reciprocal, false, 'the waypoint reported nothing back');
        // Two other devices independently report the same chassis MAC for it. That is corroboration
        // from third parties, not the far end confirming - which is why both fields are reported.
        assert.equal(edge.confirmation, 'chassis-consensus');
        const far = [edge.a, edge.b].find(e => e.ip === waypointIp);
        assert.equal(far.stp.captured, false, 'nothing was captured, so nothing can be evaluated');
        assert.deepEqual(far.stp.scopes, {});
        assert.equal(far.scanStatus, 'Timeout');
    }
    assert.deepEqual(graph.terminals, [], 'a device in the snapshot is an edge end, never a terminal');
});

// Section 5.2's second tier is corroboration, and corroboration that contradicts itself is none. Both
// halves are checked on the same topology: two reporters agreeing confirm, two camps disagreeing do not.
test('chassis consensus needs agreement, and a hostname only confirms a device that spoke for itself', () => {
    const base = byName('unscanned-waypoint').snapshot.Topology;
    const waypointIp = byName('unscanned-waypoint').waypointIp;

    // Two more reporters naming a different chassis for the same address. Both camps clear the
    // two-reporter bar, so whichever iterates last would become "consensus" on its own.
    const split = structuredClone(base);
    for (const host of ['10.30.5.20', '10.30.5.21']) {
        const intruder = structuredClone(split.find(d => d.ScanStatus === 'Ok'));
        intruder.DeviceIP = host;
        intruder.Hostname = `micro-wp-${host.split('.')[3]}.example.net`;
        intruder.Neighbors = [{
            ...structuredClone(split[0].Neighbors[0]),
            MacAddress: '02:AB:99:99:99:99', ManagementIP: waypointIp,
        }];
        split.push(intruder);
    }
    for (const edge of edgesFor(buildPortGraph(split, { allowedScopes: ALLOWED_SCOPES }), waypointIp)) {
        assert.notEqual(edge.confirmation, 'chassis-consensus',
            'reporters naming two different chassis for one address agree on nothing');
    }

    // With the MACs stripped, the only tier left is the hostname - and the waypoint's hostname is the one
    // its neighbours supplied, so matching it would be comparing a datum to a copy of itself.
    const nameOnly = structuredClone(base);
    for (const device of nameOnly) {
        for (const neighbor of device.Neighbors) neighbor.MacAddress = 'Unknown';
    }
    for (const edge of edgesFor(buildPortGraph(nameOnly, { allowedScopes: ALLOWED_SCOPES }), waypointIp)) {
        assert.equal(edge.confirmation, 'unconfirmed',
            'a node that captured nothing cannot corroborate its own name');
    }
    // The same tier does fire when the far device answered for itself: the Partial node reported its
    // hostname out of the VERSION section and lost only the tail.
    const partial = graphOf('partial-node-missing-stp-section');
    const oneSided = partial.edges.filter(e => !e.reciprocal);
    assert.equal(oneSided.length, 1);
    assert.equal(oneSided[0].confirmation, 'hostname');
});

// F14. The case the whole edge/terminal split exists for.
test('an address-less bridge yields no edge and two terminals that group into one segment', () => {
    const topology = byName('addressless-bridge-shared-segment');
    const graph = graphOf('addressless-bridge-shared-segment');
    assert.deepEqual(graph.edges, [], 'two DESG FWD ports either side of a bridge are not a link');
    assert.equal(graph.terminals.length, 2);
    for (const terminal of graph.terminals) {
        assert.equal(terminal.kind, 'addressless-bridge');
        assert.equal(terminal.mac, topology.bridgeMac.toUpperCase());
        assert.equal(terminal.reachable, false);
    }
    const segments = groupSharedSegments(graph);
    assert.equal(segments.length, 1, 'one bridge, reported once');
    assert.equal(segments[0].ends.length, 2);
    assert.notEqual(segments[0].ends[0].ip, segments[0].ends[1].ip);
});

test('an out-of-scope neighbour is a terminal, and says so only when the scopes are known', () => {
    const topology = byName('out-of-scope-neighbor');
    const scoped = graphOf('out-of-scope-neighbor');
    assert.deepEqual(scoped.edges, []);
    assert.equal(scoped.terminals.length, 1);
    assert.equal(scoped.terminals[0].kind, 'out-of-scope');
    assert.equal(scoped.terminals[0].farIp, topology.outOfScopeIp);
    assert.equal(scoped.terminals[0].scopesKnown, true);
    // Without them the two cases are indistinguishable, and claiming one would be a guess.
    const unscoped = graphOf('out-of-scope-neighbor', {});
    assert.equal(unscoped.terminals[0].kind, 'unscanned');
    assert.equal(unscoped.terminals[0].scopesKnown, false);
});

// Section 3.2's guarantee, at the graph level: an empty StpDetail on a captured device and on a
// truncated one are different facts, and only SectionsCaptured separates them.
test('a Partial node exposes captured:false while a complete node with no instance does not', () => {
    const partialIp = byName('partial-node-missing-stp-section').partialIp;
    const partial = graphOf('partial-node-missing-stp-section');
    assert.equal(partial.edges.length, 1);
    const edge = partial.edges[0];
    const far = [edge.a, edge.b].find(e => e.ip === partialIp);
    const near = [edge.a, edge.b].find(e => e.ip !== partialIp);
    assert.equal(edge.reciprocal, false, 'the session died before LLDP');
    assert.equal(far.stp.captured, false);
    assert.deepEqual(far.stp.scopes, {});
    assert.equal(near.stp.captured, true);
    assert.equal(near.stp.scopes['instance 0'].State, 'FWD');

    // The contrast: VLAN 30 has no instance on a device whose STP section arrived in full.
    const stpless = graphOf('vlan-with-no-stp-instance');
    for (const end of stpless.edges.flatMap(e => [e.a, e.b])) {
        assert.equal(end.stp.captured, true, 'the section arrived; the VLAN simply has no instance');
        assert.ok(!Object.keys(end.stp.scopes).includes('VLAN 30'));
    }
});

test('each end of an edge carries the VLAN membership of its own port', () => {
    const graph = graphOf('vlan-with-no-stp-instance');
    assert.equal(graph.edges.length, 1);
    for (const end of [graph.edges[0].a, graph.edges[0].b]) {
        assert.equal(end.vlans.captured, true, 'the VLANS section arrived on both ends');
        assert.deepEqual(end.vlans.members.map(v => v.Tag).sort((x, y) => x - y), [10, 30]);
        for (const vlan of end.vlans.members) assert.equal(typeof vlan.Tag, 'number', 'C4: tags are integers');
    }

    // Absent is not unknown: the Partial node's capture stopped before the VLANS section, so its end
    // reports no members AND says so, which is the distinction section 6.2's VLAN filter turns on.
    const partial = graphOf('partial-node-missing-stp-section');
    const ends = partial.edges.flatMap(e => [e.a, e.b]);
    const truncated = ends.find(e => e.scanStatus === 'Partial');
    assert.ok(truncated, 'the Partial node is an edge end');
    assert.deepEqual(truncated.vlans, { members: [], captured: false });
    assert.deepEqual(ends.find(e => e.scanStatus === 'Ok').vlans.members.map(v => v.Tag), [10]);
});

test('a VSTP edge exposes every scope both ends report', () => {
    for (const name of ['triangle-vstp-leg-blocked-in-one-vlan', 'diamond-two-paths-per-vlan']) {
        const graph = graphOf(name);
        assert.ok(graph.edges.length >= 3);
        for (const edge of graph.edges) {
            for (const end of [edge.a, edge.b]) {
                assert.deepEqual(Object.keys(end.stp.scopes).sort(), ['VLAN 10', 'VLAN 20']);
                assert.ok(['FWD', 'BLK'].includes(end.stp.collapsed));
            }
        }
    }
});

// Section 5.3's fourth fleet-edge case, and F4's other half: a MAC on a transit port is a sighting in
// passing, so the same predicate has to keep it out of both the inference and the endpoint's location.
test('an unmanaged segment is inferred from the MAC table, and never from an uplink', () => {
    const topology = byName('inferred-unmanaged-segment');
    const graph = graphOf('inferred-unmanaged-segment');
    const inferred = graph.terminals.filter(t => t.kind === 'inferred-segment');
    assert.equal(inferred.length, 1);
    assert.equal(inferred[0].ip, topology.segmentIp);
    assert.equal(inferred[0].port, topology.segmentPort);
    assert.equal(inferred[0].macCount, topology.macCount);
    assert.equal(graph.edges.length, 1, 'the inferred segment is not an edge');

    // The transit case must not be inferred as a segment, however many MACs the uplink has seen.
    const transit = byName('transit-sighting');
    const transitGraph = graphOf('transit-sighting');
    assert.deepEqual(transitGraph.terminals.filter(t => t.kind === 'inferred-segment'), []);
    assert.ok(transitGraph.transitPorts.get(transit.transitIp).has(transit.transitPort));
    assert.ok(!transitGraph.transitPorts.get(transit.accessIp).has(transit.accessPort));
});

// The generated fleet is the scale test: the micros prove the cases, this proves nothing blows up on a
// fleet with LAGs, stacks, failed scans and address-less neighbours all at once.
test('the generated fixture builds a graph consistent with its own neighbour list', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pnm_l2_'));
    execFileSync(process.execPath, [GENERATOR, '--out', out, '--devices', '60', '--seed', '7', '--snapshots', '1'],
        { stdio: ['ignore', 'ignore', 'ignore'] });
    const name = fs.readdirSync(out).find(f => /^NetworkMap_.*\.fixture\.json$/.test(f));
    const snapshot = JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(out, 'Configuration.fixture.json'), 'utf8'));
    const graph = buildPortGraph(snapshot.Topology, { allowedScopes: config.settings.allowedScopes });

    assert.ok(graph.edges.length > 50, `only ${graph.edges.length} edges from 60 devices`);
    // Every reciprocal edge is two half-edges, so the count cannot exceed the LLDP rows that produced it.
    const reciprocal = graph.edges.filter(e => e.reciprocal).length;
    assert.ok(reciprocal > 0 && reciprocal <= graph.edges.length);
    for (const edge of graph.edges) {
        assert.ok(edge.a.ip !== edge.b.ip);
        assert.ok(edge.key.includes('~'));
    }
    // The fleet's address-less desk switches are terminals, and each is one port on one device.
    const addressless = graph.terminals.filter(t => t.kind === 'addressless-bridge');
    assert.ok(addressless.length > 0, 'the fixture keeps R5 neighbours; they must not vanish');
    for (const terminal of addressless) assert.equal(terminal.reachable, false);
    // Nothing out of scope: every device the fixture generates is inside its own allowedScopes.
    assert.deepEqual(graph.terminals.filter(t => t.kind === 'out-of-scope'), []);
    // A failed scan is still a bridge, so its links survive as one-sided edges.
    const failed = snapshot.Topology.filter(d => d.ScanStatus !== 'Ok').map(d => String(d.DeviceIP));
    for (const ip of failed) {
        const touching = edgesFor(graph, ip);
        assert.ok(touching.length > 0, `${ip} lost every link when its scan failed`);
        for (const edge of touching) assert.equal(edge.reciprocal, false);
    }
});
