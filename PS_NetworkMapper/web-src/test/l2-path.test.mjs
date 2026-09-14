// Section 6.2. Each micro-topology was built for a case the algorithm has to get right, and here that
// case becomes an assertion about the paths the case produces. The two load-bearing ones are the triangle
// (pruning on the collapsed STP field refuses a hop that forwards - F5) and the diamond (two surviving
// paths, which a breadth-first search cannot report - F10).
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import L2Graph from '../l2-graph.js';
import L2Path from '../l2-path.js';
import { byName, ALLOWED_SCOPES } from '../tools/micro-topologies.mjs';

const { computePath, enumerateSimplePaths, scopeFor } = L2Path;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const GENERATOR = path.join(ROOT, 'web-src', 'tools', 'generate-fixture.mjs');

const pathIn = (name, options) =>
    computePath(byName(name).snapshot.Topology, { allowedScopes: ALLOWED_SCOPES, ...options });
const route = (result) => (result.paths[0] ? result.paths[0].hops.map(h => `${h.from.ip} ${h.from.port} -> ${h.to.ip} ${h.to.port}`) : []);
const visited = (candidate) => [candidate.hops[0].from.ip, ...candidate.hops.map(h => h.to.ip)];

// The devices reachable from one device in one VLAN, computed here rather than read off the result, so
// the frontier property below is asserted against an independent walk.
function reachedSet(graph, fromIp, tag) {
    const adjacency = new Map();
    for (const edge of graph.edges) {
        if (L2Path.assessEdge(edge, tag).pruned) continue;
        for (const [x, y] of [[edge.a.ip, edge.b.ip], [edge.b.ip, edge.a.ip]]) {
            if (!adjacency.has(x)) adjacency.set(x, []);
            adjacency.get(x).push(y);
        }
    }
    const seen = new Set([fromIp]);
    const queue = [fromIp];
    for (let head = 0; head < queue.length; head++) {
        for (const next of adjacency.get(queue[head]) || []) {
            if (seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
        }
    }
    return seen;
}

// A deliberately wrong pruner: the one section 2.2 forbids, kept here so the F5 regression asserts that
// the wrong answer really is wrong rather than merely asserting the right one.
function pathOnCollapsedField(topology, fromIp, toIp) {
    const graph = L2Graph.buildPortGraph(topology, { allowedScopes: ALLOWED_SCOPES });
    const adjacency = new Map();
    for (const edge of graph.edges) {
        if (edge.a.stp.collapsed !== 'FWD' || edge.b.stp.collapsed !== 'FWD') continue;
        for (const [x, y] of [[edge.a.ip, edge.b.ip], [edge.b.ip, edge.a.ip]]) {
            if (!adjacency.has(x)) adjacency.set(x, []);
            adjacency.get(x).push({ to: y, assessment: { edge } });
        }
    }
    return enumerateSimplePaths(adjacency, fromIp, toIp, 8, 10000).paths;
}

test('F5: a leg blocked in one VLAN and forwarding in another is a hop in the VLAN that forwards', () => {
    const topology = byName('triangle-vstp-leg-blocked-in-one-vlan');
    const [a, b, c] = topology.snapshot.Topology.map(d => String(d.DeviceIP));

    // VLAN 10 blocks the B-C leg, so B reaches C the long way round, through A.
    const inTen = pathIn(topology.name, { from: b, to: c, vlanTag: 10 });
    assert.equal(inTen.status, 'PATH');
    assert.deepEqual(visited(inTen.paths[0]), [b, a, c]);
    assert.equal(inTen.paths[0].confidence, 'VERIFIED');

    // VLAN 20 blocks the A-C leg instead, so the direct B-C leg is the one that carries it.
    const inTwenty = pathIn(topology.name, { from: b, to: c, vlanTag: 20 });
    assert.equal(inTwenty.status, 'PATH');
    assert.deepEqual(visited(inTwenty.paths[0]), [b, c]);
    assert.equal(inTwenty.paths[0].confidence, 'VERIFIED');

    // Every hop of both answers reads its own VLAN's scope, never the collapsed field.
    for (const [result, scope] of [[inTen, 'VLAN 10'], [inTwenty, 'VLAN 20']]) {
        for (const hop of result.paths[0].hops) {
            assert.equal(hop.scope.from.key, scope);
            assert.equal(hop.scope.to.key, scope);
            assert.equal(hop.scope.from.state, 'FWD');
            assert.equal(hop.scope.to.state, 'FWD');
        }
    }

    // The regression: both of C's ports read BLK once collapsed, so the forbidden pruner finds no path
    // to C at all - in either VLAN.
    assert.deepEqual(pathOnCollapsedField(topology.snapshot.Topology, b, c), [],
        'the collapsed field hides both legs; that is why section 2.2 forbids pruning on it');
});

test('F10: two surviving paths are reported as ambiguous, not resolved into one', () => {
    const topology = byName('diamond-two-paths-per-vlan');
    const [root, d1, d2, acc] = topology.snapshot.Topology.map(d => String(d.DeviceIP));

    // VLAN 10 blocks the dist2 uplink and VLAN 20 the dist1 one, so each is a single path - and a
    // shortest-path search would look entirely correct on these two alone.
    const ten = pathIn(topology.name, { from: acc, to: root, vlanTag: 10 });
    assert.equal(ten.status, 'PATH');
    assert.deepEqual(visited(ten.paths[0]), [acc, d1, root]);
    const twenty = pathIn(topology.name, { from: acc, to: root, vlanTag: 20 });
    assert.equal(twenty.status, 'PATH');
    assert.deepEqual(visited(twenty.paths[0]), [acc, d2, root]);

    // VLAN 30 is carried on all four trunks and has no instance anywhere, so nothing prunes either leg.
    // This is the case the enumeration exists for: a search returning one path would report a route with
    // no evidence that a second one is equally good.
    const thirty = pathIn(topology.name, { from: acc, to: root, vlanTag: 30 });
    assert.equal(thirty.status, 'AMBIGUOUS');
    assert.equal(thirty.paths.length, 2);
    assert.equal(thirty.truncated, false);
    assert.deepEqual(thirty.paths.map(visited).sort(), [[acc, d1, root], [acc, d2, root]].sort());
    for (const candidate of thirty.paths) {
        assert.equal(candidate.confidence, 'NO_STP_INSTANCE', 'unpruned is weaker than unverified');
        assert.ok(candidate.notes.includes('no-stp-instance-for-vlan'));
    }

    // And the forbidden pruner finds nothing here either: both access uplinks collapse to BLK.
    assert.deepEqual(pathOnCollapsedField(topology.snapshot.Topology, acc, root), []);
});

test('F13: a VLAN with no instance is unpruned, and never verified', () => {
    const topology = byName('vlan-with-no-stp-instance');
    const [a, b] = topology.snapshot.Topology.map(d => String(d.DeviceIP));

    const unscoped = pathIn(topology.name, { from: a, to: b, vlanTag: topology.unscopedVlanTag });
    assert.equal(unscoped.status, 'PATH');
    assert.equal(unscoped.paths[0].hops.length, 1);
    assert.equal(unscoped.paths[0].confidence, 'NO_STP_INSTANCE');
    for (const hop of unscoped.paths[0].hops) {
        assert.equal(hop.scope.from.kind, 'NO_INSTANCE');
        assert.equal(hop.scope.from.key, null, 'there is no scope to name');
    }
    // The same hop in the VLAN that does have an instance is the verified case, which is what makes the
    // distinction worth drawing at all.
    const scoped = pathIn(topology.name, { from: a, to: b, vlanTag: topology.stpVlanTag });
    assert.equal(scoped.paths[0].confidence, 'VERIFIED');
});

test('a VLAN carried nowhere yields NO_PATH naming the absence, not a silent failure', () => {
    const topology = byName('vlan-with-no-stp-instance');
    const [a, b] = topology.snapshot.Topology.map(d => String(d.DeviceIP));
    const result = pathIn(topology.name, { from: a, to: b, vlanTag: 999 });
    assert.equal(result.status, 'NO_PATH');
    assert.deepEqual(result.paths, []);
    assert.equal(result.reasons.length, 1);
    assert.equal(result.reasons[0].kind, 'vlan-absent');
    assert.equal(result.reasons[0].failureMode, 'F11');
    assert.ok(result.reasons[0].detail.includes('VLAN 999'));
    // Both ends are named: the tag is missing from each, and a rule reporting one of them would be
    // reporting half the fault.
    assert.deepEqual(result.reasons[0].ends.map(e => e.ip).sort(), [a, b].sort());
    assert.equal(result.lastReachedHop.ip, a, 'nothing was traversed, so the source is as far as it got');
});

test('a hop through an unscanned waypoint is physical only, and the waypoint is still on the path', () => {
    const topology = byName('unscanned-waypoint');
    const ips = topology.snapshot.Topology.map(d => String(d.DeviceIP));
    const waypoint = topology.waypointIp;
    const [a, c] = ips.filter(ip => ip !== waypoint);

    const result = pathIn(topology.name, { from: a, to: c, vlanTag: 10 });
    assert.equal(result.status, 'PATH');
    assert.deepEqual(visited(result.paths[0]), [a, waypoint, c]);
    assert.equal(result.paths[0].confidence, 'PHYSICAL_ONLY');
    // Why it cannot be better: the middle hop read nothing, so neither its membership nor its state is a
    // datum at all - and the LLDP is one-sided because it never answered.
    assert.ok(result.paths[0].notes.includes('vlan-membership-not-captured'));
    assert.ok(result.paths[0].notes.includes('stp-section-not-captured'));
    assert.ok(result.paths[0].notes.some(n => n.startsWith('one-sided-lldp:')));
    for (const hop of result.paths[0].hops) {
        const far = [hop.from, hop.to].find(end => end.ip === waypoint);
        assert.ok(far, 'the waypoint is an end of both hops');
    }
});

test('a Partial node caps the hop it is on, and says which datum was missing', () => {
    const topology = byName('partial-node-missing-stp-section');
    const [a, b] = topology.snapshot.Topology.map(d => String(d.DeviceIP));
    const result = pathIn(topology.name, { from: a, to: b, vlanTag: 10 });
    assert.equal(result.status, 'PATH');
    assert.equal(result.paths[0].confidence, 'PHYSICAL_ONLY');
    assert.ok(result.paths[0].notes.includes('stp-section-not-captured'));
    assert.ok(result.notes.includes(`endpoint-scan-partial:${b}`));
    // Not the same as the VLAN being absent: the section never arrived, and the hop is not pruned for it.
    assert.deepEqual(result.reasons, []);
});

test('F14: an address-less bridge is not a hop, and the reason names the segment', () => {
    const topology = byName('addressless-bridge-shared-segment');
    const [a, b] = topology.snapshot.Topology.map(d => String(d.DeviceIP));
    const result = pathIn(topology.name, { from: a, to: b, vlanTag: 10 });
    assert.equal(result.status, 'NO_PATH');
    const terminal = result.reasons.find(r => r.kind === 'terminal');
    assert.ok(terminal, 'the port facing the bridge is where the topology ends');
    assert.equal(terminal.failureMode, 'F14');
    assert.equal(terminal.terminal, 'addressless-bridge');
    assert.ok(terminal.detail.includes('shared segment'), terminal.detail);
    assert.ok(result.reasons.some(r => r.kind === 'disconnected') === false,
        'the frontier reason is specific, so the generic one is not reported');
});

test('a LAG is one hop, and it reports its members', () => {
    for (const name of ['lag-two-members-up', 'lag-two-members-one-down']) {
        const topology = byName(name);
        const [a, b] = topology.snapshot.Topology.map(d => String(d.DeviceIP));
        const result = computePath(topology.snapshot.Topology, { from: a, to: b, vlanTag: 10, allowedScopes: ALLOWED_SCOPES });
        assert.equal(result.status, 'PATH', name);
        assert.equal(result.paths[0].hops.length, 1, `${name}: two members are one hop`);
        const hop = result.paths[0].hops[0];
        assert.equal(hop.from.port, 'ae0');
        assert.equal(hop.to.port, 'ae0');
        assert.equal(hop.confidence, 'VLAN_ONLY', 'the bundle runs one RSTP instance, not one per VLAN');
        const members = hop.from.members.map(m => m.port).sort();
        assert.deepEqual(members, ['ge-0/0/0', 'ge-0/0/1'], name);
        if (name.endsWith('one-down')) {
            assert.deepEqual(hop.from.members.filter(m => m.link === 'down').map(m => m.port), ['ge-0/0/1']);
        }
    }
});

test('an out-of-scope neighbour is not a path endpoint at all', () => {
    const topology = byName('out-of-scope-neighbor');
    const a = String(topology.snapshot.Topology[0].DeviceIP);
    const result = pathIn(topology.name, { from: a, to: topology.outOfScopeIp, vlanTag: 10 });
    assert.equal(result.status, 'NO_PATH');
    assert.deepEqual(result.reasons.map(r => r.kind), ['endpoint-not-in-snapshot']);
    assert.equal(result.reasons[0].failureMode, 'F7');
    assert.ok(result.notes.includes(`unknown-device:${topology.outOfScopeIp}`));
});

test('a device is a path to itself, with no hops', () => {
    const topology = byName('transit-sighting');
    const a = String(topology.snapshot.Topology[0].DeviceIP);
    const result = pathIn(topology.name, { from: a, to: a, vlanTag: 10 });
    assert.equal(result.status, 'PATH');
    assert.deepEqual(result.paths[0].hops, []);
    assert.ok(result.paths[0].notes.includes('same-device'));
});

// The bound has to be visible when it bites: "exactly two paths" and "the first two of an unknown number"
// are different answers, and only one of them is safe to report.
test('the enumeration is bounded, and says when the bound bit', () => {
    const topology = byName('diamond-two-paths-per-vlan');
    const [, , , acc] = topology.snapshot.Topology.map(d => String(d.DeviceIP));
    const root = String(topology.snapshot.Topology[0].DeviceIP);
    const capped = pathIn(topology.name, { from: acc, to: root, vlanTag: 30, limit: 1 });
    assert.equal(capped.paths.length, 1, 'the limit is what is reported');
    assert.equal(capped.truncated, true);
    // The count is the finding, so the status follows what was FOUND rather than what fits: reporting
    // one of two paths as the answer is the mistake the enumeration exists to prevent.
    assert.equal(capped.status, 'AMBIGUOUS');

    // And a limit the enumeration does not reach is not truncation: exactly two paths at limit 2 is a
    // fact, because the walk looks for a third.
    const exact = pathIn(topology.name, { from: acc, to: root, vlanTag: 30, limit: 2 });
    assert.equal(exact.paths.length, 2);
    assert.equal(exact.truncated, false);
    assert.equal(exact.status, 'AMBIGUOUS');

    const starved = pathIn(topology.name, { from: acc, to: root, vlanTag: 30, stepBudget: 1 });
    assert.equal(starved.truncated, true);
    assert.deepEqual(starved.paths, []);
});

test('a path is per VLAN, and asking without one is not answered with a fabricated absence', () => {
    const topology = byName('vlan-with-no-stp-instance');
    const [a, b] = topology.snapshot.Topology.map(d => String(d.DeviceIP));
    const result = pathIn(topology.name, { from: a, to: b });
    assert.equal(result.status, 'NO_PATH');
    assert.deepEqual(result.reasons.map(r => r.kind), ['no-vlan-given']);
    assert.ok(result.notes.includes('no-vlan-given'));
});

// F12, the case a device-level protocol guess gets wrong: one device running VSTP for some VLANs and RSTP
// for the rest. The per-VLAN scope wins where it exists, and the single instance answers elsewhere.
test('VSTP and RSTP on one device resolve per VLAN, not per device', () => {
    const end = {
        stp: { captured: true, collapsed: 'FWD', scopes: {
            'VLAN 10': { State: 'FWD', Role: 'Root' },
            'instance 0': { State: 'BLK', Role: 'Alternate' },
        } },
    };
    assert.deepEqual(scopeFor(end, 10), { kind: 'PER_VLAN', key: 'VLAN 10', state: 'FWD', role: 'Root' });
    assert.deepEqual(scopeFor(end, 20), { kind: 'RSTP', key: 'instance 0', state: 'BLK', role: 'Alternate' });

    const mstp = { stp: { captured: true, collapsed: 'FWD', scopes: { 'MSTI 1': { State: 'FWD', Role: 'Root' } } } };
    assert.equal(scopeFor(mstp, 10).kind, 'MSTI', 'without the VLAN-to-MSTI map, the instance is unattributable');
    const none = { stp: { captured: true, collapsed: 'Unknown', scopes: {} } };
    assert.equal(scopeFor(none, 10).kind, 'NO_INSTANCE');
    const silent = { stp: { captured: false, collapsed: null, scopes: {} } };
    assert.equal(scopeFor(silent, 10).kind, 'NOT_CAPTURED');
});

// Fixture scale. Item 7 guarantees the forwarding subgraph is a spanning tree, so between any two
// scanned devices there is exactly one path once pruned - which makes "one path" an assertion about
// dozens of pairs rather than about one hand-built case.
test('on the generated fleet, a pruned VLAN leaves exactly one path between scanned devices', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pnm_path_'));
    execFileSync(process.execPath, [GENERATOR, '--out', out, '--devices', '60', '--seed', '11',
        '--snapshots', '1', '--faults', '9'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const mapName = fs.readdirSync(out).find(f => /^NetworkMap_.*\.fixture\.json$/.test(f));
    const manifestName = fs.readdirSync(out).find(f => /^FaultManifest_.*\.fixture\.json$/.test(f));
    const snapshot = JSON.parse(fs.readFileSync(path.join(out, mapName), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(out, manifestName), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(out, 'Configuration.fixture.json'), 'utf8'));
    const graph = L2Graph.buildPortGraph(snapshot.Topology, { allowedScopes: config.settings.allowedScopes });
    const byIp = new Map(snapshot.Topology.map(d => [String(d.DeviceIP), d]));

    // The fault manifest's own hop is excluded from the sampling: it is asserted separately below, and a
    // pair whose route crosses it is entitled to a different answer.
    const f11 = manifest.Faults.find(f => f.kind === 'vlan-missing-from-trunk');
    const scanned = snapshot.Topology.filter(d => d.ScanStatus === 'Ok').map(d => String(d.DeviceIP));
    const scannedSet = new Set(scanned);
    const tagsOf = (ip) => (byIp.get(ip).Vlans || []).map(v => v.Tag);

    let checked = 0;
    let spreadOver = 0;
    const levels = new Map();
    for (let i = 0; i < scanned.length; i += 1) {
        // A deterministic sample of pairs rather than all ~1700: one partner per device, stepped.
        const from = scanned[i];
        const to = scanned[(i * 7 + 3) % scanned.length];
        if (from === to) continue;
        const shared = tagsOf(from).filter(tag => tagsOf(to).includes(tag));
        if (!shared.length) continue;
        const tag = shared[0];
        const result = computePath(graph, { from, to, vlanTag: tag });
        if (result.status === 'NO_PATH' && result.reasons.some(r => r.ends.some(e => e.ip === String(f11.deviceIp)))) continue;
        checked++;
        assert.notEqual(result.status, 'NO_PATH',
            `${from} -> ${to} in VLAN ${tag}: ${result.status} (${result.reasons.map(r => r.detail).join('; ')})`);
        assert.equal(result.truncated, false);
        // The spanning tree is unique among the devices that ANSWERED. A device that never answered
        // carries no STP state, so nothing prunes a route through it and it survives as a second
        // candidate - which section 6.5 reports rather than adjudicates. So the assertion is that exactly
        // one path stays inside the scanned fleet, and any other crosses a hole in it.
        const certified = result.paths.filter(p => visited(p).every(ip => scannedSet.has(ip)));
        assert.equal(certified.length, 1,
            `${from} -> ${to} in VLAN ${tag}: ${certified.length} paths among scanned devices`);
        for (const extra of result.paths.filter(p => !certified.includes(p))) {
            assert.ok(visited(extra).some(ip => !scannedSet.has(ip)),
                `${from} -> ${to} in VLAN ${tag} has a second path entirely inside the scanned fleet`);
        }
        levels.set(certified[0].confidence, (levels.get(certified[0].confidence) || 0) + 1);
        if (certified[0].macCoherent === false) spreadOver++;
        // No hop may be a repeat: a simple path visits each device once.
        const seen = visited(certified[0]);
        assert.equal(new Set(seen).size, seen.length, `${from} -> ${to} revisits a device`);
    }
    assert.ok(checked > 30, `only ${checked} pairs checked`);
    // R12/F2, measured rather than assumed: the crawl spreads capture over minutes, so most multi-hop
    // paths do span more than one MAC aging interval. That is why the flag is reported beside the
    // confidence instead of collapsing into it - hop state comes from a spanning tree, not a MAC entry.
    assert.ok(spreadOver > 0, 'the fleet crawl spans minutes; some path must exceed one aging interval');
    // The generated fleet runs one RSTP instance by construction - per-VLAN divergence needs VSTP config
    // generation and is not faked there - so at this scale the honest answer for every path is VLAN_ONLY.
    // VERIFIED is reachable only where a per-VLAN scope exists, which is what the VSTP micros carry.
    assert.deepEqual([...levels.keys()], ['VLAN_ONLY'], `unexpected confidence mix: ${[...levels]}`);
    assert.equal(levels.get('VLAN_ONLY'), checked);

    // The injected F11 hop: a path in that VLAN across that trunk reports the missing tag, on the end the
    // manifest names. The same pair in another VLAN the trunk carries is unaffected.
    const near = String(f11.deviceIp);
    const far = String(f11.params.peerIp);
    const blocked = computePath(graph, { from: near, to: far, vlanTag: f11.params.vlanTag });
    const named = blocked.status === 'NO_PATH'
        ? blocked.reasons.some(r => r.kind === 'vlan-absent' && r.ends.some(e => e.ip === near && e.port === f11.port))
        // The fleet is redundant enough that another route may survive; then the pruned hop must not be
        // on it, which is the same guarantee stated the other way.
        : blocked.paths.every(p => !p.hops.some(h => h.from.ip === near && h.from.port === f11.port));
    assert.ok(named, `the F11 hop was neither reported nor avoided: ${JSON.stringify(blocked.reasons)}`);

    const otherTag = (byIp.get(near).Vlans.find(v => v.Tag !== f11.params.vlanTag
        && v.Interfaces.some(m => m.Port === f11.port)) || {}).Tag;
    if (otherTag !== undefined) {
        const fine = computePath(graph, { from: near, to: far, vlanTag: otherTag });
        assert.equal(fine.status, 'PATH', 'the trunk still carries every other VLAN');
    }

    // The reasons are a frontier, not a survey: every one of them has exactly one end among the devices
    // actually reached. A pruned leg with both ends already reachable adds no device and cannot be why
    // the target was missed, so listing it would only bury the reason that is.
    if (blocked.status === 'NO_PATH') {
        assert.ok(blocked.lastReachedHop, 'something was reached');
        assert.ok(blocked.reasons.some(r => r.kind === 'vlan-absent'));
        const reached = reachedSet(graph, near, f11.params.vlanTag);
        const prunedEdges = graph.edges.filter(e => L2Path.assessEdge(e, f11.params.vlanTag).pruned);
        for (const reason of blocked.reasons) {
            const inside = reason.ends.filter(e => reached.has(e.ip)).length;
            assert.equal(inside, 1, `${reason.kind} on ${JSON.stringify(reason.ends)} is not on the frontier`);
        }
        assert.ok(blocked.reasons.length < prunedEdges.length,
            'the frontier must be narrower than the set of every pruned edge in the snapshot');
    }

    // F9 as an oracle, the same way: the injected learning port is either the reason a path stops or a
    // port no reported path crosses. A path computer reading only FWD/BLK has a third state to account
    // for, and this is where it is accounted for.
    const f9 = manifest.Faults.find(f => f.kind === 'stp-unconverged');
    const learning = String(f9.deviceIp);
    const learningEdge = graph.edges.find(e => (e.a.ip === learning && e.a.port === f9.port) || (e.b.ip === learning && e.b.port === f9.port));
    assert.ok(learningEdge, 'the LRN port is an end of a real edge');
    const otherEnd = learningEdge.a.ip === learning ? learningEdge.b : learningEdge.a;
    const sharedTag = (byIp.get(learning).Vlans || []).map(v => v.Tag)
        .find(tag => (byIp.get(otherEnd.ip).Vlans || []).some(v => v.Tag === tag));
    assert.ok(sharedTag !== undefined, 'the two ends share a VLAN to ask about');
    const across = computePath(graph, { from: learning, to: otherEnd.ip, vlanTag: sharedTag });
    if (across.status === 'NO_PATH') {
        const reason = across.reasons.find(r => r.kind === 'stp-not-converged');
        assert.ok(reason, `no F9 reason: ${JSON.stringify(across.reasons)}`);
        assert.equal(reason.failureMode, 'F9');
        assert.ok(reason.ends.some(e => e.ip === learning && e.port === f9.port && e.state === 'LRN'));
    } else {
        for (const candidate of across.paths) {
            assert.ok(!candidate.hops.some(h => h.from.ip === learning && h.from.port === f9.port),
                'a port still learning is not a hop');
        }
    }
});
