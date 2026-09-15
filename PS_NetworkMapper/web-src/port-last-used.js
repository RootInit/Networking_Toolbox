// When was this switch port last actually carrying traffic?
//
// port-last-used-spec.md. "Last flapped" does not answer it: at boot every connected port transitions
// once and is then frozen for as long as the cable stays in, so on the measured fleet 41 of 75 ports
// carried a stamp that said nothing about when the port was last used.
//
// Three rules run through everything below.
//
// The answer is a bounded INTERVAL, never a timestamp (section 2.1). `resolution` says how wide the
// bound is, and it is usually the inter-snapshot gap: "last used about three weeks ago" means
// "somewhere in the week between these two scans", and an operator who is not told that will read a
// number that is not there.
//
// A positive input delta proves a TRANSMITTER was present, not that the port was used (section 2.3).
// Three ports in the capture carried one ~64 B frame every dozen seconds for eighteen days - a
// powered, unattended NIC - and under a naive rule every one reads active at the highest confidence.
// They are exactly the ports a reclaim view exists to surface, so the delta state is named
// TRANSMITTER_PRESENT and promotion to ACTIVE_NOW has to clear a rate floor.
//
// null is unmeasured and JavaScript will not respect that (section 2.4). `5e9 > null` is true and
// `null < 5e9` is true, which produce in turn a false active claim, a false counter reset and a false
// idle verdict - the last being the damaging answer this whole module exists to avoid. Every numeric
// comparison here goes through num(), which returns null for anything that is not a finite number,
// and every path returns evidence and caveats.

(function () {
    'use strict';

    var STATE = {
        ACTIVE_NOW: 'ACTIVE_NOW',
        TRANSMITTER_PRESENT: 'TRANSMITTER_PRESENT',
        IDLE_SINCE: 'IDLE_SINCE',
        NEVER_USED_THIS_EPOCH: 'NEVER_USED_THIS_EPOCH',
        DISABLED: 'DISABLED',
        UNKNOWN: 'UNKNOWN',
    };

    // Section 5.3: the two reasons are reported distinctly, because they call for different actions.
    var UNKNOWN_REASON = {
        NOT_PRESENT: 'port-not-in-any-loaded-snapshot',
        NO_USABLE_OBSERVATION: 'present-but-every-observation-unusable',
    };

    // Section 2.3. Calibrated on one fleet - the observed clusters are ~76 B and ~585 B mean frame -
    // so it is a default, not a constant, and both halves are reported in evidence wherever they decide
    // anything. Either clearing promotes a delta to ACTIVE_NOW.
    var DEFAULTS = {
        floorMeanFrameBytes: 128,
        floorPps: 0.5,
        // The LLDP TTL. Past it the entry is retained and the counter keeps running, so a larger Age is
        // still a real bound on when the neighbour last spoke - it is just no longer liveness.
        lldpActiveSeconds: 180,
        // Section 7, P8: the configuration is not parsed, so this is the Junos default and says so in
        // caveats. dot1x session pinning may override it in either direction on a real fleet.
        macAgingSeconds: 300,
        // Section 4.2. The relative form is minute-quantized above an hour and the two values come from
        // different commands in one batch, so "the flap IS the boot event" needs slack on both.
        bootFilterToleranceSeconds: 900,
        // Section 4.3's reset test allows for the inter-scan gap before calling a decrease a reboot.
        uptimeSlackSeconds: 120,
    };

    function num(x) {
        return (typeof x === 'number' && isFinite(x)) ? x : null;
    }

    function asList(x) {
        if (x === null || x === undefined) return [];
        return Object.prototype.toString.call(x) === '[object Array]' ? x : [x];
    }

    function physicalPort(port) {
        return String(port === null || port === undefined ? '' : port).replace(/\.\d+$/, '');
    }

    // The FPC a port lives on: the scope a counter epoch belongs to, because a linecard reboots its own
    // ports and nothing else's. An aggregate spans members and has no single one, so it falls back to
    // the chassis, which is what the device-level uptime already describes.
    function fpcOfPort(port) {
        var m = /^[a-z]+-(\d+)\//.exec(String(port));
        return m ? m[1] : null;
    }

    // ---------------------------------------------------------------------------------------------
    // Observations
    // ---------------------------------------------------------------------------------------------

    // Section 6. Every key a device answered to, so one port's history is not split in two when a
    // Partial scan loses StackMembers and the key silently drops from serial: to hostname:.
    function deviceKeysOf(device) {
        var keys = [];
        var members = asList(device && device.StackMembers);
        for (var i = 0; i < members.length; i++) {
            var serial = members[i] && members[i].Serial;
            if (serial) keys.push('serial:' + String(serial));
        }
        if (device && device.Hostname && device.Hostname !== 'Unknown') keys.push('hostname:' + String(device.Hostname));
        if (device && device.DeviceIP) keys.push('ip:' + String(device.DeviceIP));
        return keys;
    }

    // The uptime of the FPC this port lives on, which is what section 4.3's reset test compares. Falls
    // back to the device figure when the port names no member - an aggregate, or a platform whose port
    // names carry no FPC at all.
    function uptimeForPort(device, port) {
        var fpc = fpcOfPort(port);
        var rows = asList(device && device.FpcUptimes);
        for (var i = 0; i < rows.length; i++) {
            if (rows[i] && String(rows[i].FPC) === fpc) return num(rows[i].UptimeSeconds);
        }
        return num(device && device.UptimeSeconds);
    }

    // E0. The strongest source there is: a per-port, switch-clock, second-resolution last-seen, free in
    // output the crawler already collects. LLDP speakers only - phones, APs, switches, managed servers,
    // not a stock workstation - so it is coverage, not correctness, that limits it.
    function lldpAgeForPort(device, port) {
        var best = null;
        var lists = [asList(device && device.Neighbors), asList(device && device.MedNeighbors)];
        for (var i = 0; i < lists.length; i++) {
            for (var j = 0; j < lists[i].length; j++) {
                var entry = lists[i][j];
                if (!entry || physicalPort(entry.LocalPort) !== port) continue;
                var age = num(entry.AgeSeconds);
                if (age === null) continue;
                if (best === null || age < best) best = age;
            }
        }
        return best;
    }

    // E2. P5's whole point: a dynamic entry is evidence that the endpoint transmitted within the aging
    // time; a static or persistent one was configured and says nothing about traffic at all.
    function macsForPort(device, port) {
        var dynamic = 0;
        var total = 0;
        var rows = asList(device && device.MacTable);
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row) continue;
            if (physicalPort(row.PhysicalPort || row.Interface) !== port) continue;
            total += 1;
            if (String(row.Flags || '').indexOf('D') !== -1) dynamic += 1;
        }
        return { dynamic: dynamic, total: total };
    }

    function observationFor(device, row, tsMs, sections) {
        var port = String(row.Port);
        return {
            tsMs: tsMs,
            port: port,
            scanStatus: String(device.ScanStatus || ''),
            sections: sections,
            admin: row.Admin === null || row.Admin === undefined ? null : String(row.Admin).toLowerCase(),
            link: row.Link === null || row.Link === undefined ? null : String(row.Link).toLowerCase(),
            inputBytes: num(row.InputBytes),
            inputPackets: num(row.InputPackets),
            outputBytes: num(row.OutputBytes),
            inputBps: num(row.InputBps),
            carrierTransitions: num(row.CarrierTransitions),
            lastFlappedSeconds: num(row.LastFlappedSeconds),
            statisticsLastCleared: row.StatisticsLastCleared === null || row.StatisticsLastCleared === undefined
                ? null : String(row.StatisticsLastCleared),
            uptimeSeconds: uptimeForPort(device, port),
            lldpAgeSeconds: lldpAgeForPort(device, port),
            macs: macsForPort(device, port),
        };
    }

    // Snapshots in, one history per (device, port) out. Snapshots are `{ ScanTimestamp, Topology }` -
    // the shape the loaders already hold in memory, which section 8.1 is the reason this needs no
    // storage of its own: the loaded window IS the resolution window.
    function buildHistories(snapshots) {
        // Section 6: identity is resolved once per history, not per snapshot. Histories are accumulated
        // against every key a device answered to and merged where the key sets intersect, so a scan that
        // lost its serial joins the history it belongs to instead of starting a contradictory second one.
        var byKey = Object.create(null);
        var groups = [];

        function groupFor(keys) {
            var found = null;
            for (var i = 0; i < keys.length; i++) {
                var hit = byKey[keys[i]];
                if (!hit) continue;
                if (found === null) found = hit;
                else if (hit !== found) {
                    // Two groups now known to be the same device. Merge rather than pick: picking is
                    // what silently splits one port's history into an active row and an idle row.
                    for (var p in hit.ports) {
                        if (!Object.prototype.hasOwnProperty.call(hit.ports, p)) continue;
                        found.ports[p] = (found.ports[p] || []).concat(hit.ports[p]);
                    }
                    for (var k = 0; k < hit.keys.length; k++) {
                        if (found.keys.indexOf(hit.keys[k]) === -1) found.keys.push(hit.keys[k]);
                        byKey[hit.keys[k]] = found;
                    }
                    hit.merged = true;
                }
            }
            if (found === null) {
                found = { keys: [], ports: Object.create(null), keyTypes: Object.create(null), merged: false };
                groups.push(found);
            }
            for (var n = 0; n < keys.length; n++) {
                if (found.keys.indexOf(keys[n]) === -1) found.keys.push(keys[n]);
                byKey[keys[n]] = found;
                found.keyTypes[String(keys[n]).split(':')[0]] = true;
            }
            return found;
        }

        var sorted = asList(snapshots).slice().sort(function (a, b) {
            return Date.parse(a && a.ScanTimestamp) - Date.parse(b && b.ScanTimestamp);
        });

        for (var s = 0; s < sorted.length; s++) {
            var snapshot = sorted[s];
            var scanMs = Date.parse(snapshot && snapshot.ScanTimestamp);
            var devices = asList(snapshot && snapshot.Topology);
            for (var d = 0; d < devices.length; d++) {
                var device = devices[d];
                if (!device) continue;
                var keys = deviceKeysOf(device);
                if (!keys.length) continue;
                var group = groupFor(keys);
                // Per device (R12), falling back to the crawl's single stamp - which is too coarse to
                // compare counters across devices, and says so in a caveat when it is what was used.
                var own = Date.parse(device.CaptureTimestamp);
                var tsMs = isFinite(own) ? own : scanMs;
                if (!isFinite(tsMs)) continue;
                var sections = asList(device.SectionsCaptured).map(String);
                var rows = asList(device.Interfaces);
                for (var r = 0; r < rows.length; r++) {
                    if (!rows[r] || !rows[r].Port) continue;
                    var port = String(rows[r].Port);
                    if (!group.ports[port]) group.ports[port] = [];
                    var obs = observationFor(device, rows[r], tsMs, sections);
                    obs.usedScanTimestamp = !isFinite(own);
                    group.ports[port].push(obs);
                }
            }
        }

        var histories = [];
        for (var g = 0; g < groups.length; g++) {
            if (groups[g].merged) continue;
            var keyTypes = Object.keys(groups[g].keyTypes);
            for (var port in groups[g].ports) {
                if (!Object.prototype.hasOwnProperty.call(groups[g].ports, port)) continue;
                histories.push({
                    port: port,
                    // serial: outranks hostname: outranks ip:, the same order resolveDeviceIdentity uses.
                    deviceKey: preferredKey(groups[g].keys),
                    deviceKeys: groups[g].keys.slice(),
                    keyTypes: keyTypes,
                    observations: groups[g].ports[port],
                });
            }
        }
        return histories;
    }

    function preferredKey(keys) {
        var order = ['serial:', 'hostname:', 'ip:'];
        for (var i = 0; i < order.length; i++) {
            for (var k = 0; k < keys.length; k++) {
                if (String(keys[k]).indexOf(order[i]) === 0) return keys[k];
            }
        }
        return keys[0] || null;
    }

    // ---------------------------------------------------------------------------------------------
    // Segments - G-BASELINE (diagnostics-spec.md section 2.4)
    // ---------------------------------------------------------------------------------------------

    // Section 4.3. A counter epoch ends at a reboot, a statistics clear, or a port that went away and
    // came back, and a delta taken across one of those is not a delta at all.
    //
    // The test is `UptimeSeconds(N) < UptimeSeconds(N-1)`, per FPC. Bare `Uptime(N) != Uptime(N-1)` -
    // which is what this looked like before - fails four ways on a virtual chassis: a Partial scan whose
    // Uptime is "Unknown" reads as a reset, a non-master member's reboot is invisible, a mastership
    // change reads a different member's block and reports a reset that did not happen, and a clock step
    // moves the absolute stamp with no reboot at all. Monotonic relative uptime is immune to all four.
    //
    // "Unknown" on either side is NEITHER a reset nor a continuation: it is a boundary of unknown type,
    // and the segment ends there with a caveat rather than with a claim.
    function splitOnResets(observations, options) {
        var opts = options || {};
        var slack = num(opts.uptimeSlackSeconds) === null ? DEFAULTS.uptimeSlackSeconds : opts.uptimeSlackSeconds;
        var segments = [];
        var current = [];
        var boundaries = [];

        function close(reason, atMs) {
            if (current.length) segments.push({ observations: current, endedBy: reason, endedAtMs: atMs });
            current = [];
        }

        for (var i = 0; i < observations.length; i++) {
            var obs = observations[i];
            if (i > 0) {
                var prev = observations[i - 1];
                var reason = resetBetween(prev, obs, slack);
                if (reason) {
                    boundaries.push({ reason: reason, beforeMs: prev.tsMs, afterMs: obs.tsMs });
                    close(reason, prev.tsMs);
                }
            }
            current.push(obs);
        }
        close(null, observations.length ? observations[observations.length - 1].tsMs : null);
        return { segments: segments, boundaries: boundaries };
    }

    function resetBetween(prev, obs, slack) {
        var before = prev.uptimeSeconds;
        var after = obs.uptimeSeconds;
        if (before === null || after === null) return 'uptime-unknown';
        // Section 4.3's form exactly: uptime went BACKWARDS. Not "grew by less than the inter-scan
        // gap" - a device whose clock was stepped, or whose scans straddle a mastership change, grows
        // by the wrong amount without having rebooted, and calling that a reset throws away the
        // history this module exists to keep. The slack absorbs the relative form's minute
        // quantization above one hour, on both readings.
        if (after + slack < before) return 'reboot';
        // A manual clear, which looks exactly like "never used" to a cumulative counter unless P2 is read.
        if (prev.statisticsLastCleared !== null && obs.statisticsLastCleared !== null
            && prev.statisticsLastCleared !== obs.statisticsLastCleared) return 'statistics-cleared';
        // The counter itself going backwards. Never an equality test: section 10's ninth limitation is
        // that Number is exact to 2^53, not 2^64.
        if (prev.inputBytes !== null && obs.inputBytes !== null && obs.inputBytes < prev.inputBytes) {
            return 'counter-decreased';
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------------
    // The reduction (section 5.1)
    // ---------------------------------------------------------------------------------------------

    var STRENGTH = {};
    STRENGTH[STATE.ACTIVE_NOW] = 4;
    STRENGTH[STATE.TRANSMITTER_PRESENT] = 3;
    STRENGTH[STATE.IDLE_SINCE] = 2;
    STRENGTH[STATE.NEVER_USED_THIS_EPOCH] = 1;

    function blank(port, deviceKey, state, evidence, caveats, extra) {
        var out = {
            port: port,
            deviceKey: deviceKey,
            state: state,
            lastActive: { notBefore: null, notAfter: null },
            resolution: null,
            confidence: 'low',
            evidence: evidence || [],
            caveats: caveats || [],
        };
        for (var k in (extra || {})) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
        }
        return out;
    }

    function meanFrame(bytes, packets) {
        if (bytes === null || packets === null || packets <= 0) return null;
        return bytes / packets;
    }

    // Section 2.3: either half clears the floor. Returns null when neither could be evaluated, which is
    // not the same as "did not clear it" - a delta whose floor is unevaluable stays TRANSMITTER_PRESENT.
    function clearsFloor(deltaBytes, deltaPackets, seconds, opts) {
        var frame = meanFrame(deltaBytes, deltaPackets);
        var pps = (deltaPackets !== null && seconds > 0) ? deltaPackets / seconds : null;
        if (frame === null && pps === null) return null;
        if (frame !== null && frame >= opts.floorMeanFrameBytes) return true;
        if (pps !== null && pps >= opts.floorPps) return true;
        return false;
    }

    function computeLastUsed(history, options) {
        var opts = {};
        for (var key in DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) opts[key] = DEFAULTS[key];
        }
        for (var over in (options || {})) {
            if (num((options || {})[over]) !== null) opts[over] = options[over];
        }

        var port = history && history.port ? String(history.port) : null;
        var deviceKey = history && history.deviceKey ? history.deviceKey : null;
        var evidence = [];
        var caveats = [];

        var raw = asList(history && history.observations);
        if (!raw.length) {
            return blank(port, deviceKey, STATE.UNKNOWN, evidence,
                caveats, { reason: UNKNOWN_REASON.NOT_PRESENT });
        }

        // Section 5.1's preamble, in order and for the stated reasons: a device that contributed nothing
        // cannot report a counter (G-NOSCAN); an unparseable timestamp cannot be placed on the line; the
        // same file loaded twice must not change the answer; and caller ordering is never trusted.
        var dropped = { notScanned: 0, noTimestamp: 0, duplicate: 0 };
        var usable = [];
        for (var i = 0; i < raw.length; i++) {
            var obs = raw[i];
            if (!obs) continue;
            if (obs.scanStatus !== 'Ok' && obs.scanStatus !== 'Partial') { dropped.notScanned += 1; continue; }
            if (num(obs.tsMs) === null) { dropped.noTimestamp += 1; continue; }
            usable.push(obs);
        }
        usable.sort(function (a, b) { return a.tsMs - b.tsMs; });
        var obsList = [];
        for (var u = 0; u < usable.length; u++) {
            if (u > 0 && usable[u].tsMs === usable[u - 1].tsMs) { dropped.duplicate += 1; continue; }
            obsList.push(usable[u]);
        }
        if (dropped.notScanned) caveats.push('observations-from-unscanned-devices-ignored:' + dropped.notScanned);
        if (dropped.noTimestamp) caveats.push('observations-with-no-timestamp-ignored:' + dropped.noTimestamp);
        if (dropped.duplicate) caveats.push('duplicate-snapshots-ignored:' + dropped.duplicate);
        for (var c = 0; c < obsList.length; c++) {
            if (obsList[c].usedScanTimestamp) {
                caveats.push('per-device-capture-time-missing-interval-widened-by-the-crawl-span');
                break;
            }
        }
        if (asList(history && history.keyTypes).length > 1) {
            // Section 6. Not an error: the history was merged rather than split, which is the right
            // answer - but the operator is told the device answered to two kinds of key.
            caveats.push('device-identity-changed-key-type:' + asList(history.keyTypes).join('+'));
        }

        if (!obsList.length) {
            return blank(port, deviceKey, STATE.UNKNOWN, evidence, caveats,
                { reason: UNKNOWN_REASON.NO_USABLE_OBSERVATION });
        }

        var last = obsList[obsList.length - 1];
        if (last.admin === 'down') {
            evidence.push({ source: 'E-ADMIN', detail: 'Admin down at the most recent scan' });
            return blank(port, deviceKey, STATE.DISABLED, evidence, caveats, { reason: null });
        }

        var split = splitOnResets(obsList, opts);
        for (var b = 0; b < split.boundaries.length; b++) {
            caveats.push('counter-epoch-boundary:' + split.boundaries[b].reason);
        }
        var lastSeg = split.segments[split.segments.length - 1];
        var epochStart = null;
        if (last.uptimeSeconds !== null) epochStart = last.tsMs - last.uptimeSeconds * 1000;
        else caveats.push('epoch-start-unknown-no-uptime-in-seconds');

        var contributions = [];

        // -- E0. LLDP neighbour age -------------------------------------------------------------
        if (last.lldpAgeSeconds !== null) {
            var lldpFrom = last.tsMs - last.lldpAgeSeconds * 1000;
            var recent = last.lldpAgeSeconds <= opts.lldpActiveSeconds;
            contributions.push({
                state: recent ? STATE.ACTIVE_NOW : STATE.IDLE_SINCE,
                notBefore: lldpFrom,
                notAfter: last.tsMs,
                // Second resolution, at the moment of the scan - the one source not bounded by the scan
                // cadence, which is why section 2.2 makes it the exception it names.
                resolution: 1,
                confidence: 'high',
                evidence: {
                    source: 'E0',
                    detail: 'LLDP neighbour last heard ' + last.lldpAgeSeconds + ' s before the scan'
                        + (recent ? '' : ' (past the ' + opts.lldpActiveSeconds + ' s TTL, so retained rather than live)'),
                },
            });
        }

        // -- E1. Live input rate ----------------------------------------------------------------
        if (last.inputBps !== null && last.inputBps > 0) {
            var bpsFrame = meanFrame(last.inputBytes, last.inputPackets);
            var bpsClears = bpsFrame !== null && bpsFrame >= opts.floorMeanFrameBytes;
            contributions.push({
                state: bpsClears ? STATE.ACTIVE_NOW : STATE.TRANSMITTER_PRESENT,
                notBefore: null,
                notAfter: last.tsMs,
                resolution: null,
                confidence: 'medium',
                evidence: {
                    source: 'E1',
                    // Junos does not document the polling interval, so it is named rather than converted
                    // into a number of seconds nobody can justify.
                    detail: 'Input rate ' + last.inputBps + ' bps in the last statistics-polling interval'
                        + (bpsFrame === null ? ' (mean frame size unmeasured, so the floor was not evaluated)'
                            : ', mean frame ' + Math.round(bpsFrame) + ' B against a ' + opts.floorMeanFrameBytes + ' B floor'),
                },
            });
        }

        // -- E2. A dynamic MAC on the port ------------------------------------------------------
        if (last.macs && last.macs.dynamic > 0) {
            contributions.push({
                state: STATE.IDLE_SINCE,
                notBefore: last.tsMs - opts.macAgingSeconds * 1000,
                notAfter: last.tsMs,
                resolution: opts.macAgingSeconds,
                // Section 7: more than a handful of MACs means an unmanaged switch or a hypervisor
                // behind the port, and "something down there transmitted" stops being about this port.
                confidence: last.macs.total > 4 ? 'low' : 'medium',
                evidence: {
                    source: 'E2',
                    detail: last.macs.dynamic + ' dynamic MAC(s) learned on the port, within an assumed '
                        + opts.macAgingSeconds + ' s aging time',
                },
            });
            caveats.push('mac-aging-time-assumed-' + opts.macAgingSeconds + 's-configuration-not-parsed');
        }

        // -- E3. The input byte delta - the workhorse -------------------------------------------
        var delta = lastDeltaIn(lastSeg.observations);
        if (delta) {
            var floor = clearsFloor(delta.bytes, delta.packets, delta.seconds, opts);
            contributions.push({
                state: floor === true ? STATE.ACTIVE_NOW : STATE.TRANSMITTER_PRESENT,
                notBefore: delta.fromMs,
                notAfter: delta.toMs,
                resolution: delta.seconds,
                confidence: floor === null ? 'low' : 'medium',
                evidence: {
                    source: 'E3',
                    detail: delta.bytes + ' B in ' + Math.round(delta.seconds) + ' s'
                        + (delta.packets === null ? ' (packets unmeasured, so the floor used bytes alone)'
                            : ', mean frame ' + Math.round(delta.bytes / Math.max(1, delta.packets)) + ' B at '
                              + (delta.packets / delta.seconds).toFixed(2) + ' pps')
                        + (floor === false ? ' - below the rate floor, so a transmitter is present rather than the port in use' : ''),
                },
            });
        }

        // -- E4/E5. The cumulative counter, where there is no earlier observation to subtract ----
        // E5 reads every segment (section 2.5); E4 reads only the current epoch, because a cumulative
        // counter says nothing about the epochs before the one it is counting in.
        var allZero = true;
        var measuredAnywhere = false;
        for (var z = 0; z < obsList.length; z++) {
            if (obsList[z].inputBytes === null) continue;
            measuredAnywhere = true;
            if (obsList[z].inputBytes > 0) allZero = false;
        }
        if (measuredAnywhere && allZero) {
            // Section 2.5, the strongest claim in the model: only when NO observation in ANY segment
            // showed input. A reset must never be able to produce it, which is why this reads every
            // segment rather than the last one.
            contributions.push({
                state: STATE.NEVER_USED_THIS_EPOCH,
                notBefore: null,
                notAfter: epochStart,
                resolution: null,
                confidence: epochStart === null ? 'low' : 'high',
                evidence: { source: 'E5', detail: 'Zero input bytes in every observation of every segment' },
            });
        } else if (segmentHasInput(lastSeg) && !delta) {
            contributions.push({
                state: STATE.IDLE_SINCE,
                notBefore: epochStart,
                notAfter: last.tsMs,
                resolution: epochStart === null ? null : (last.tsMs - epochStart) / 1000,
                confidence: 'low',
                evidence: {
                    source: 'E4',
                    detail: 'Cumulative input above zero with no earlier observation to subtract, so the '
                        + 'bound is the whole epoch',
                },
            });
        }

        // -- Section 5.2. Earlier segments are lower bounds, never nothing. ----------------------
        // Revision 1 said only the most recent segment is usable, under which a port carrying 900 GB
        // that then saw a reboot returns a one-observation segment of zero bytes and reports
        // NEVER_USED_THIS_EPOCH at high confidence - for a port that was busy four days earlier, which
        // then lands on the reclaim list.
        if (split.segments.length > 1) {
            var priorActivity = null;
            for (var sIdx = 0; sIdx < split.segments.length - 1; sIdx++) {
                var seg = split.segments[sIdx];
                for (var o = 0; o < seg.observations.length; o++) {
                    if (seg.observations[o].inputBytes !== null && seg.observations[o].inputBytes > 0) {
                        priorActivity = { atMs: seg.observations[o].tsMs, endedAtMs: seg.endedAtMs };
                    }
                }
            }
            if (priorActivity) {
                contributions.push({
                    state: STATE.IDLE_SINCE,
                    notBefore: priorActivity.atMs,
                    notAfter: priorActivity.endedAtMs,
                    resolution: null,
                    confidence: 'medium',
                    evidence: {
                        source: 'E3-prior-segment',
                        detail: 'Activity in an earlier counter epoch, bounded at the epoch boundary',
                    },
                });
            }
        }

        // -- E6/E8. The epilogue, reached when nothing above could be computed ------------------
        if (last.link === 'up') {
            evidence.push({ source: 'E6', detail: 'Link up: a cable is connected and the far end is powered' });
        }
        var flap = bootFilteredFlap(last, opts);
        if (flap !== null) {
            evidence.push({ source: 'E8', detail: 'Port last changed link state ' + flap + ' s before the scan' });
        }

        for (var e = 0; e < contributions.length; e++) evidence.push(contributions[e].evidence);

        if (!contributions.length) {
            if (!measuredAnywhere) caveats.push('no-counter-was-measured-in-any-observation');
            return blank(port, deviceKey, STATE.UNKNOWN, evidence, caveats,
                { reason: UNKNOWN_REASON.NO_USABLE_OBSERVATION });
        }

        contributions.sort(function (a, b) {
            return (STRENGTH[b.state] || 0) - (STRENGTH[a.state] || 0);
        });
        var winner = contributions[0];

        // The tightest consistent bound, not the winner's alone: a later lower bound and an earlier
        // upper bound from any contributor both narrow the interval, and every contributor here is a
        // statement about the same port over the same window.
        var notBefore = winner.notBefore;
        var notAfter = winner.notAfter;
        for (var t = 1; t < contributions.length; t++) {
            var other = contributions[t];
            if (other.state === STATE.NEVER_USED_THIS_EPOCH) continue;
            if (other.notBefore !== null && (notBefore === null || other.notBefore > notBefore)
                && (notAfter === null || other.notBefore <= notAfter)) notBefore = other.notBefore;
            if (other.notAfter !== null && (notAfter === null || other.notAfter < notAfter)
                && (notBefore === null || other.notAfter >= notBefore)) notAfter = other.notAfter;
        }

        return {
            port: port,
            deviceKey: deviceKey,
            state: winner.state,
            lastActive: { notBefore: notBefore, notAfter: notAfter },
            resolution: winner.resolution,
            confidence: winner.confidence,
            evidence: evidence,
            caveats: caveats,
            reason: null,
        };
    }

    function segmentHasInput(segment) {
        var rows = segment ? segment.observations : [];
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].inputBytes !== null && rows[i].inputBytes > 0) return true;
        }
        return false;
    }

    // The most recent usable pair inside one segment. Observations whose counter is null are skipped
    // rather than treated as zero (section 2.4), and the pair carries the gap it spans because that gap
    // IS the resolution of the answer.
    function lastDeltaIn(observations) {
        var measured = [];
        for (var i = 0; i < observations.length; i++) {
            if (observations[i].inputBytes !== null) measured.push(observations[i]);
        }
        if (measured.length < 2) return null;
        var now = measured[measured.length - 1];
        var before = measured[measured.length - 2];
        var bytes = now.inputBytes - before.inputBytes;
        if (!(bytes > 0)) return null;
        var packets = (now.inputPackets !== null && before.inputPackets !== null)
            ? now.inputPackets - before.inputPackets : null;
        return {
            bytes: bytes,
            packets: packets !== null && packets > 0 ? packets : null,
            seconds: (now.tsMs - before.tsMs) / 1000,
            fromMs: before.tsMs,
            toMs: now.tsMs,
        };
    }

    // Section 4.2's boot-event filter. E8 is only usable once the boot stamp is removed, and the check
    // that does the work is the second one - the first is inert in practice, since every zero-transition
    // port in the capture is link-down where E5 already answers.
    function bootFilteredFlap(obs, opts) {
        if (obs.lastFlappedSeconds === null) return null;
        if (obs.carrierTransitions !== null && obs.carrierTransitions === 0) return null;
        if (obs.uptimeSeconds !== null
            && Math.abs(obs.uptimeSeconds - obs.lastFlappedSeconds) <= opts.bootFilterToleranceSeconds) return null;
        return obs.lastFlappedSeconds;
    }

    var API = {
        computeLastUsed: computeLastUsed,
        buildHistories: buildHistories,
        // diagnostics-spec.md section 2.4 names G-BASELINE as an integrity gate and points here for its
        // form. This is it - there is no second mechanism. The rule engine imports it when the first
        // counter-delta rule lands; until then plumbing it into the engine would be a gate with nothing
        // behind it.
        splitOnResets: splitOnResets,
        deviceKeysOf: deviceKeysOf,
        uptimeForPort: uptimeForPort,
        fpcOfPort: fpcOfPort,
        STATE: STATE,
        UNKNOWN_REASON: UNKNOWN_REASON,
        DEFAULTS: DEFAULTS,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = API;
    else if (typeof window !== 'undefined') window.PortLastUsed = API;
}());
