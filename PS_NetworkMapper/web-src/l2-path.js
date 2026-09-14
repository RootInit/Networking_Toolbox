// Section 6.2. Path computation over the port-level graph l2-graph.js builds.
//
// Two filters, in this order: a hop survives only if both ends carry the VLAN, and then only if neither
// end is blocking in that VLAN's own spanning-tree scope. What is left is enumerated - every simple path,
// up to a limit - and the COUNT is part of the answer. One path is an answer; two paths are a fault
// (F10) and reported as one; none is a diagnosis naming the hop that stopped it.
//
// Three things this deliberately does not do:
//
//   - It does not run a shortest-path search. Breadth-first returns one path and never notices a second,
//     which throws away the whole safety story: a pruned VLAN topology is not always a tree (a VLAN with
//     no instance at all is unpruned, MSTP without the VLAN-to-MSTI map degrades every device, and a
//     shared segment behind an unmanaged bridge is not point-to-point).
//   - It does not use Dijkstra on STP cost. The snapshot is a converged election's RESULT; re-electing it
//     on cost would produce a single confident answer where the evidence has two.
//   - It does not read the collapsed STP field for anything. That field is worst-case-among-blocked, so a
//     leg forwarding in VLAN 20 and blocked in VLAN 10 reads BLK on both (F5).
//
// No DOM, no window: this file also runs under Node in the test suite.

var L2 = (typeof module !== 'undefined' && module.exports)
    ? require('./l2-graph.js')
    : (typeof window !== 'undefined' ? window.L2Graph : null);

// Section 2.3's ladder, worst last. A path is as good as its worst hop.
var CONFIDENCE_ORDER = ['VERIFIED', 'VLAN_ONLY', 'NO_STP_INSTANCE', 'PHYSICAL_ONLY', 'INFERRED', 'UNVERIFIED'];

// A port in any of these states is not forwarding in that scope, and one end is enough: RSTP blocks
// one-endedly, leaving the other end Designated and forwarding.
var NOT_FORWARDING = ['BLK', 'DIS', 'LRN', 'LST'];

// The default MAC aging interval. F2's threshold reads on the MAC-table evidence, not on hop state - see
// the note on captureSpread below.
var DEFAULT_MAC_AGING_SECONDS = 300;

var DEFAULT_PATH_LIMIT = 8;
// The unpruned graph has cycles, so the path limit alone does not bound the search: a fleet-sized graph
// with no STP data can hold enormous numbers of simple paths. This bounds the walk itself.
var DEFAULT_STEP_BUDGET = 200000;

function worst(a, b) {
    return CONFIDENCE_ORDER.indexOf(a) >= CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

// F12, stated once. A device can run VSTP for some VLANs and RSTP for the rest at the same time, so the
// scope that governs one VLAN on one port is a per-port lookup and never a per-device protocol guess.
function scopeFor(end, tag) {
    if (!end.stp || !end.stp.captured) return { kind: 'NOT_CAPTURED', key: null, state: null, role: null };
    var scopes = end.stp.scopes || {};
    var perVlan = 'VLAN ' + tag;
    if (Object.prototype.hasOwnProperty.call(scopes, perVlan)) return detail('PER_VLAN', perVlan, scopes[perVlan]);
    // RSTP's single instance covers every VLAN that has no VSTP instance of its own, so it answers for
    // this VLAN - but not per-VLAN, which is what caps the hop at VLAN_ONLY.
    if (Object.prototype.hasOwnProperty.call(scopes, 'instance 0')) return detail('RSTP', 'instance 0', scopes['instance 0']);
    var msti = Object.keys(scopes).filter(function (key) { return /^MSTI /.test(key); }).sort()[0];
    // Which MSTI carries this VLAN lives in the configuration, which section 4.4 decided not to parse.
    // The instance is real and unattributable, so every MSTP hop is VLAN_ONLY rather than verified.
    if (msti) return detail('MSTI', msti, scopes[msti]);
    return { kind: 'NO_INSTANCE', key: null, state: null, role: null };
}

function detail(kind, key, scope) {
    return { kind: kind, key: key, state: scope ? scope.State : null, role: scope ? scope.Role : null };
}

// Absent is not empty. A port with no members because the VLANS section never arrived is unknown, and a
// hop must not be pruned on a datum nobody read (section 3.2's NOT_EVALUATED, applied to the filter).
function carriesVlan(end, tag) {
    if (!end.vlans || !end.vlans.captured) return 'UNKNOWN';
    var members = end.vlans.members || [];
    for (var i = 0; i < members.length; i++) {
        if (Number(members[i].Tag) === Number(tag)) return 'YES';
    }
    return 'NO';
}

function endLabel(end) {
    return end.ip + ' ' + end.port;
}

// One hop's worth of judgement about one edge, computed once and reused by the filter, the enumeration
// and the report - so a hop cannot be pruned for one reason and then reported with another.
// Section 6.3. Both ends Designated, or both Root, in one scope is not a hop to trust: within a
// converged instance exactly one end is designated. The role column prints the Junos abbreviations
// (DESG, ROOT, ALT, DIS), not the words - see section 8.2's fifth vocabulary correction.
var SEGMENT_ROLES = ['DESG', 'ROOT'];

function bothEndsClaimSegment(scopeA, scopeB) {
    var role = scopeA.role ? String(scopeA.role).toUpperCase() : null;
    if (!role || SEGMENT_ROLES.indexOf(role) === -1) return false;
    return scopeB.role && role === String(scopeB.role).toUpperCase();
}

function assessEdge(edge, tag) {
    var vlanA = carriesVlan(edge.a, tag);
    var vlanB = carriesVlan(edge.b, tag);
    var scopeA = scopeFor(edge.a, tag);
    var scopeB = scopeFor(edge.b, tag);
    var notes = [];

    var pruned = null;
    if (vlanA === 'NO' || vlanB === 'NO') {
        // F11. Not a path failure to be swallowed: the absence is the diagnosis, and it names an end.
        var missing = [];
        if (vlanA === 'NO') missing.push(edge.a);
        if (vlanB === 'NO') missing.push(edge.b);
        pruned = {
            reason: 'vlan-absent',
            failureMode: 'F11',
            detail: 'VLAN ' + tag + ' is not on ' + missing.map(endLabel).join(' or '),
            ends: missing.map(function (end) { return { ip: end.ip, port: end.port }; }),
        };
    } else {
        var blocking = [];
        [[edge.a, scopeA], [edge.b, scopeB]].forEach(function (pair) {
            if (pair[1].state && NOT_FORWARDING.indexOf(pair[1].state) !== -1) blocking.push({ end: pair[0], scope: pair[1] });
        });
        if (blocking.length) {
            var learning = blocking.filter(function (b) { return b.scope.state === 'LRN' || b.scope.state === 'LST'; });
            pruned = {
                reason: learning.length ? 'stp-not-converged' : 'stp-blocking',
                // F9 is a port mid-transition, which is neither forwarding nor a settled block. It stops
                // a path the same way and has to be said differently.
                failureMode: learning.length ? 'F9' : null,
                detail: blocking.map(function (b) {
                    return b.scope.state + ' on ' + endLabel(b.end) + ' in ' + b.scope.key;
                }).join(', '),
                ends: blocking.map(function (b) { return { ip: b.end.ip, port: b.end.port, state: b.scope.state }; }),
            };
        }
    }

    var confidence = 'VERIFIED';
    if (vlanA === 'UNKNOWN' || vlanB === 'UNKNOWN') {
        confidence = 'PHYSICAL_ONLY';
        notes.push('vlan-membership-not-captured');
    }
    if (scopeA.kind === 'NOT_CAPTURED' || scopeB.kind === 'NOT_CAPTURED') {
        confidence = worst(confidence, 'PHYSICAL_ONLY');
        notes.push('stp-section-not-captured');
    }
    if (scopeA.kind === 'NO_INSTANCE' || scopeB.kind === 'NO_INSTANCE') {
        // F13. The filter above was vacuous here, and saying so is the whole point of the level: the hop
        // is UNPRUNED, which is a weaker statement than unverified.
        confidence = worst(confidence, 'NO_STP_INSTANCE');
        notes.push('no-stp-instance-for-vlan');
    }
    if (scopeA.kind === 'RSTP' || scopeB.kind === 'RSTP' || scopeA.kind === 'MSTI' || scopeB.kind === 'MSTI') {
        confidence = worst(confidence, 'VLAN_ONLY');
        notes.push(scopeA.kind === 'MSTI' || scopeB.kind === 'MSTI' ? 'mstp-vlan-to-instance-map-not-parsed' : 'stp-scope-not-per-vlan');
    }
    if (confidence === 'VERIFIED' && !(scopeA.state === 'FWD' && scopeB.state === 'FWD')) {
        // Reached when a scope exists and reports something other than forwarding or blocking, which is
        // a state this engine has no reading for rather than a state it may assume is fine.
        confidence = 'UNVERIFIED';
        notes.push('stp-state-unreadable');
    }
    if (!edge.reciprocal) {
        notes.push('one-sided-lldp:' + edge.confirmation);
        confidence = worst(confidence, 'PHYSICAL_ONLY');
    }
    // Section 6.3. Both ends Designated, or both Root, in one scope is not a hop to trust: within a
    // converged instance exactly one end is Designated.
    if (bothEndsClaimSegment(scopeA, scopeB)) {
        notes.push('both-ends-' + String(scopeA.role).toLowerCase());
        confidence = worst(confidence, 'UNVERIFIED');
    }

    return {
        edge: edge, vlan: { a: vlanA, b: vlanB }, scope: { a: scopeA, b: scopeB },
        confidence: confidence, notes: notes, pruned: pruned,
    };
}

function captureInstant(device) {
    if (!device || !device.CaptureTimestamp) return null;
    var value = Date.parse(device.CaptureTimestamp);
    return isNaN(value) ? null : value;
}

// R12/F2. The instants two ends of a hop were actually read at. A fleet crawl spans minutes, so this is
// reported on every path rather than folded into the confidence: hop state comes from a spanning tree
// that changes on the order of minutes at most, while the MAC-table evidence F2 is about ages out in
// 300 seconds. The caller gets the spread and the flag and decides.
function spreadOf(instants) {
    var known = instants.filter(function (value) { return value !== null; });
    if (known.length < 2) return null;
    return Math.round((Math.max.apply(null, known) - Math.min.apply(null, known)) / 1000);
}

function hopFor(assessment, fromIp, deviceByIp) {
    var edge = assessment.edge;
    var near = edge.a.ip === fromIp ? edge.a : edge.b;
    var far = near === edge.a ? edge.b : edge.a;
    var nearScope = near === edge.a ? assessment.scope.a : assessment.scope.b;
    var farScope = far === edge.a ? assessment.scope.a : assessment.scope.b;
    return {
        edgeKey: edge.key,
        from: { ip: near.ip, hostname: near.hostname, port: near.port, desc: near.desc, members: near.members, scanStatus: near.scanStatus },
        to: { ip: far.ip, hostname: far.hostname, port: far.port, desc: far.desc, members: far.members, scanStatus: far.scanStatus },
        confidence: assessment.confidence,
        scope: { from: nearScope, to: farScope },
        reciprocal: edge.reciprocal,
        confirmation: edge.confirmation,
        notes: assessment.notes.slice(),
        captureSpreadSeconds: spreadOf([captureInstant(deviceByIp.get(near.ip)), captureInstant(deviceByIp.get(far.ip))]),
    };
}

function adjacencyOf(assessments) {
    var adjacency = new Map();
    var push = function (ip, entry) {
        if (!adjacency.has(ip)) adjacency.set(ip, []);
        adjacency.get(ip).push(entry);
    };
    assessments.forEach(function (assessment) {
        var edge = assessment.edge;
        push(edge.a.ip, { to: edge.b.ip, assessment: assessment });
        push(edge.b.ip, { to: edge.a.ip, assessment: assessment });
    });
    // Sorted so enumeration order is a property of the snapshot and not of object iteration order.
    adjacency.forEach(function (entries) {
        entries.sort(function (x, y) {
            return x.to < y.to ? -1 : x.to > y.to ? 1 : (x.assessment.edge.key < y.assessment.edge.key ? -1 : 1);
        });
    });
    return adjacency;
}

// Every simple path, bounded twice: by how many paths are reported and by how much walking is done. The
// count is the answer, so the limit has to be visible when it bites - a truncated enumeration cannot be
// reported as "exactly two paths". Callers ask for one more than they intend to report, so that finding
// exactly `limit` paths is a fact and not an unknown; see computePath.
function enumerateSimplePaths(adjacency, fromIp, toIp, limit, stepBudget) {
    var paths = [];
    var onPath = new Set([fromIp]);
    var trail = [];
    var steps = 0;
    var truncated = false;

    var walk = function (ip) {
        if (paths.length >= limit) { truncated = true; return; }
        if (ip === toIp) { paths.push(trail.slice()); return; }
        var entries = adjacency.get(ip) || [];
        for (var i = 0; i < entries.length; i++) {
            if (++steps > stepBudget) { truncated = true; return; }
            var entry = entries[i];
            if (onPath.has(entry.to)) continue;
            onPath.add(entry.to);
            trail.push(entry);
            walk(entry.to);
            trail.pop();
            onPath.delete(entry.to);
            if (paths.length >= limit || steps > stepBudget) { truncated = true; return; }
        }
    };
    walk(fromIp);
    return { paths: paths, truncated: truncated };
}

function reachableFrom(adjacency, fromIp) {
    var seen = new Set([fromIp]);
    var queue = [fromIp];
    var parent = new Map();
    for (var head = 0; head < queue.length; head++) {
        var entries = adjacency.get(queue[head]) || [];
        for (var i = 0; i < entries.length; i++) {
            if (seen.has(entries[i].to)) continue;
            seen.add(entries[i].to);
            parent.set(entries[i].to, { from: queue[head], assessment: entries[i].assessment });
            queue.push(entries[i].to);
        }
    }
    return { seen: seen, parent: parent };
}

// Hop distance over the UNPRUNED graph, so "how far from the target did we get" can be answered even
// though no pruned path reaches it.
function hopDistances(graph, toIp) {
    var adjacency = new Map();
    graph.edges.forEach(function (edge) {
        if (!adjacency.has(edge.a.ip)) adjacency.set(edge.a.ip, []);
        if (!adjacency.has(edge.b.ip)) adjacency.set(edge.b.ip, []);
        adjacency.get(edge.a.ip).push(edge.b.ip);
        adjacency.get(edge.b.ip).push(edge.a.ip);
    });
    var distance = new Map([[toIp, 0]]);
    var queue = [toIp];
    for (var head = 0; head < queue.length; head++) {
        var next = adjacency.get(queue[head]) || [];
        for (var i = 0; i < next.length; i++) {
            if (distance.has(next[i])) continue;
            distance.set(next[i], distance.get(queue[head]) + 1);
            queue.push(next[i]);
        }
    }
    return distance;
}

function pathFrom(parent, fromIp, ip, deviceByIp) {
    var hops = [];
    var cursor = ip;
    while (cursor !== fromIp) {
        var step = parent.get(cursor);
        if (!step) return [];
        hops.unshift(hopFor(step.assessment, step.from, deviceByIp));
        cursor = step.from;
    }
    return hops;
}

// The specific reason section 6.2 asks for: the pruned edges on the frontier of what IS reachable, plus
// the terminals there - a port facing an address-less bridge or an inferred segment is where the
// topology ends, and chaining across it would invent the hop the path is missing (F14).
function reasonsAtFrontier(reachable, pruned, terminals, segments) {
    var reasons = [];
    pruned.forEach(function (assessment) {
        var edge = assessment.edge;
        var aIn = reachable.has(edge.a.ip);
        var bIn = reachable.has(edge.b.ip);
        // Strictly the frontier. A pruned edge with BOTH ends already reachable adds no device if it is
        // unpruned, so it cannot be why the target was not reached - and listing every blocked Alternate
        // leg inside the reachable component buries the one reason that matters.
        if (aIn === bIn) return;
        reasons.push({
            kind: assessment.pruned.reason,
            failureMode: assessment.pruned.failureMode,
            detail: assessment.pruned.detail,
            edgeKey: edge.key,
            ends: assessment.pruned.ends,
        });
    });
    terminals.forEach(function (terminal) {
        if (!reachable.has(terminal.ip)) return;
        var segment = segments.find(function (candidate) {
            return candidate.ends.some(function (end) { return end.ip === terminal.ip && end.port === terminal.port; });
        });
        // A shared segment whose other side is reachable anyway joins two devices we already have, so it
        // is inside the component rather than on its edge - the same frontier rule as above.
        if (segment && segment.ends.every(function (end) { return reachable.has(end.ip); })) return;
        reasons.push({
            kind: 'terminal',
            failureMode: terminal.kind === 'addressless-bridge' || terminal.kind === 'inferred-segment' ? 'F14' : 'F8',
            detail: 'the topology ends at ' + terminal.ip + ' ' + terminal.port + ' (' + terminal.kind + ')'
                + (segment ? ', a shared segment with ' + segment.ends.map(endLabel).join(' and ') : ''),
            terminal: terminal.kind,
            ends: [{ ip: terminal.ip, port: terminal.port }],
        });
    });
    return reasons;
}

function graphFor(input, options) {
    if (input && input.edges && input.deviceByIp) return input;
    return L2.buildPortGraph(input, { allowedScopes: options.allowedScopes || null });
}

// l2Path(a, b, T) of section 6.2. `from` and `to` are device management addresses; the VLAN is a tag.
function computePath(input, options) {
    var opts = options || {};
    var graph = graphFor(input, opts);
    var fromIp = String(opts.from);
    var toIp = String(opts.to);
    var tag = Number(opts.vlanTag);
    var limit = opts.limit === undefined ? DEFAULT_PATH_LIMIT : opts.limit;
    var stepBudget = opts.stepBudget === undefined ? DEFAULT_STEP_BUDGET : opts.stepBudget;
    var agingSeconds = opts.macAgingSeconds === undefined ? DEFAULT_MAC_AGING_SECONDS : opts.macAgingSeconds;

    var result = {
        from: fromIp, to: toIp, vlanTag: tag,
        status: 'NO_PATH', paths: [], truncated: false, reasons: [], lastReachedHop: null,
        notes: [],
    };
    // Without this, a missing tag is NaN, no port matches it, and every hop is pruned with a plausible
    // "VLAN NaN is not on ..." - a wrong answer that reads like a real diagnosis.
    if (!isFinite(tag)) {
        result.notes.push('no-vlan-given');
        result.reasons.push({ kind: 'no-vlan-given', failureMode: null, detail: 'a path is per VLAN; none was given', ends: [] });
        return result;
    }
    if (!graph.deviceByIp.has(fromIp)) result.notes.push('unknown-device:' + fromIp);
    if (!graph.deviceByIp.has(toIp)) result.notes.push('unknown-device:' + toIp);
    if (result.notes.length) {
        result.reasons.push({ kind: 'endpoint-not-in-snapshot', failureMode: 'F7', detail: result.notes.join(', '), ends: [] });
        return result;
    }
    [fromIp, toIp].forEach(function (ip) {
        var device = graph.deviceByIp.get(ip);
        if (device.ScanStatus === 'Ok') return;
        // Section 6.1's rule, on the path side: such a device can be a waypoint, and its own end of
        // every hop is unreadable, so the answer can never be better than PHYSICAL_ONLY.
        result.notes.push((device.ScanStatus === 'Partial' ? 'endpoint-scan-partial:' : 'endpoint-scan-failed:') + ip);
    });

    var assessments = graph.edges.map(function (edge) { return assessEdge(edge, tag); });
    var surviving = assessments.filter(function (assessment) { return !assessment.pruned; });
    var pruned = assessments.filter(function (assessment) { return assessment.pruned; });
    var adjacency = adjacencyOf(surviving);

    if (fromIp === toIp) {
        result.status = 'PATH';
        result.paths.push({ hops: [], confidence: 'VERIFIED', notes: ['same-device'], captureSpreadSeconds: 0, macCoherent: true });
        return result;
    }

    // One past the limit, so finding exactly `limit` paths is a fact rather than an unknown - and so a
    // limit of 1 on a topology with two paths still reports AMBIGUOUS, which is the answer that matters.
    var found = enumerateSimplePaths(adjacency, fromIp, toIp, limit + 1, stepBudget);
    var overLimit = found.paths.length > limit;
    result.truncated = overLimit || (found.truncated && found.paths.length <= limit);
    var enumerated = found.paths.length;
    result.paths = found.paths.slice(0, limit).map(function (trail) {
        var hops = [];
        var cursor = fromIp;
        var confidence = 'VERIFIED';
        var notes = [];
        var instants = [captureInstant(graph.deviceByIp.get(fromIp))];
        trail.forEach(function (entry) {
            var hop = hopFor(entry.assessment, cursor, graph.deviceByIp);
            hops.push(hop);
            confidence = worst(confidence, hop.confidence);
            hop.notes.forEach(function (note) { if (notes.indexOf(note) === -1) notes.push(note); });
            instants.push(captureInstant(graph.deviceByIp.get(hop.to.ip)));
            cursor = entry.to;
        });
        var spread = spreadOf(instants);
        // F2's threshold, reported rather than applied to the hop states: see spreadOf.
        var coherent = spread === null ? null : spread <= agingSeconds;
        if (coherent === false) notes.push('capture-spread-exceeds-mac-aging');
        return { hops: hops, confidence: confidence, notes: notes, captureSpreadSeconds: spread, macCoherent: coherent };
    });

    // Status comes from how many paths were FOUND, not from how many are reported: knowing a second path
    // exists is the finding, and reporting one of two as an answer is the mistake this guards against.
    if (enumerated === 1) {
        result.status = 'PATH';
        return result;
    }
    if (enumerated > 1) {
        // F10. Two surviving paths is the fault, not an invitation to choose one.
        result.status = 'AMBIGUOUS';
        return result;
    }

    var reachable = reachableFrom(adjacency, fromIp);
    result.reasons = reasonsAtFrontier(reachable.seen, pruned, graph.terminals, L2.groupSharedSegments(graph));
    var distance = hopDistances(graph, toIp);
    var best = null;
    reachable.seen.forEach(function (ip) {
        var d = distance.has(ip) ? distance.get(ip) : Infinity;
        if (best === null || d < best.distance || (d === best.distance && ip < best.ip)) best = { ip: ip, distance: d };
    });
    if (best) {
        var device = graph.deviceByIp.get(best.ip);
        result.lastReachedHop = {
            ip: best.ip,
            hostname: device ? device.Hostname : null,
            hopsFromTarget: best.distance === Infinity ? null : best.distance,
            hops: pathFrom(reachable.parent, fromIp, best.ip, graph.deviceByIp),
        };
    }
    if (!result.reasons.length) {
        // Nothing pruned on the frontier and still no path: the two ends are in different components of
        // the physical graph to begin with (F8).
        result.reasons.push({
            kind: 'disconnected', failureMode: 'F8',
            detail: toIp + ' is not reachable from ' + fromIp + ' over any LLDP adjacency in this snapshot',
            ends: [],
        });
    }
    return result;
}

var L2Path = {
    computePath: computePath,
    bothEndsClaimSegment: bothEndsClaimSegment,
    assessEdge: assessEdge,
    scopeFor: scopeFor,
    carriesVlan: carriesVlan,
    enumerateSimplePaths: enumerateSimplePaths,
    CONFIDENCE_ORDER: CONFIDENCE_ORDER,
    NOT_FORWARDING: NOT_FORWARDING,
};

// Dual-mode export: node:test (CJS/ESM interop) vs. browser <script> (no `module`).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = L2Path;
} else if (typeof window !== 'undefined') {
    window.L2Path = L2Path;
}
