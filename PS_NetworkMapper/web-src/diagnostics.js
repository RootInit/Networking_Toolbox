// The Diagnostics analysis sub-tab: the rule engine (section 3), endpoint resolution (6.1), path
// computation (6.2) and the gateway report (6.4) on screen.
//
// Two things here are deliberate and easy to undo by accident:
//
//   - The `missing` histogram is rendered beside the findings, not behind a toggle. A rule that never
//     evaluated because a section never arrived produces no findings, and a screen that shows only
//     findings reports that silence as health (section 2.4). "Nothing fired" and "nothing was read" are
//     different answers and both are shown.
//   - A path query runs through the resolver first and passes the resolved PORTS into computePath. A
//     device-to-device answer is clean up to the last switch even when the endpoint's own access port is
//     not in the VLAN, which is the gap item 14 exists to close.
//
// Rendering is pure-function-first (groupFindings, missingHistogram, pathPanelModel) so the summaries
// can be tested without a DOM; only the paint below touches the document.

// Rule severities are `error` / `warning` / `info`; the dashboard's bars and badges speak
// `crit` / `warn` / `ok`. `info` is new to the UI with the L2 rules (`neighbour-never-scanned`) and is
// mapped explicitly rather than falling through to a default.
var DIAG_TIER = { error: 'crit', warning: 'warn', info: 'ok' };
var DIAG_SEVERITY_ORDER = ['error', 'warning', 'info'];
var DIAG_SEVERITY_LABEL = { error: 'Error', warning: 'Warning', info: 'Info' };

// Findings by severity, then by rule, each rule keeping its own findings. Order is fixed rather than
// insertion-dependent so two renders of one snapshot cannot differ.
function groupFindings(result) {
    var byRule = new Map();
    (result.findings || []).forEach(function (finding) {
        if (!byRule.has(finding.ruleId)) {
            byRule.set(finding.ruleId, {
                ruleId: finding.ruleId, title: finding.title, layer: finding.layer,
                severity: finding.severity, findings: [],
            });
        }
        byRule.get(finding.ruleId).findings.push(finding);
    });
    return DIAG_SEVERITY_ORDER.map(function (severity) {
        var rules = Array.from(byRule.values())
            .filter(function (entry) { return entry.severity === severity; })
            .sort(function (x, y) { return y.findings.length - x.findings.length || (x.ruleId < y.ruleId ? -1 : 1); });
        return {
            severity: severity, rules: rules,
            count: rules.reduce(function (sum, entry) { return sum + entry.findings.length; }, 0),
        };
    }).filter(function (band) { return band.rules.length > 0; });
}

// Section 3.5's third state, on screen. A REFUSED command is not a truncated capture - a non-PoE chassis
// answers "show poe interface" with an error, which IS output, so the section lands in SectionsCaptured
// and every PoE rule correctly skips those ports as non-subjects. Correct, and silent: the histogram has
// no row to show, because there is no unevaluated subject. This is the line that explains the silence.
//
// Presentation only. `hasSection` still reads SectionsCaptured alone; making a refused section missing
// would turn a switch that is simply built differently into a fleet of findings.
function sectionRefusals(devices) {
    var bySection = new Map();
    (devices || []).forEach(function (device) {
        var errors = device && device.SectionErrors;
        if (!errors) return;
        Object.keys(errors).forEach(function (section) {
            if (!bySection.has(section)) bySection.set(section, { section: section, devices: 0, message: null });
            var entry = bySection.get(section);
            entry.devices += 1;
            if (!entry.message) entry.message = String(errors[section]);
        });
    });
    return Array.from(bySection.values())
        .sort(function (x, y) { return y.devices - x.devices || (x.section < y.section ? -1 : 1); });
}

// Section 2.4's deliverable: per rule, how many subjects it could not evaluate and which datum was
// missing each time. Rules that evaluated everything are dropped - the point of the table is the gaps.
function missingHistogram(result) {
    var rows = [];
    Object.keys(result.stats || {}).forEach(function (ruleId) {
        var counts = result.stats[ruleId];
        var data = Object.keys(counts.missing || {}).map(function (datum) {
            return { datum: datum, count: counts.missing[datum] };
        }).sort(function (x, y) { return y.count - x.count || (x.datum < y.datum ? -1 : 1); });
        if (!data.length) return;
        rows.push({
            ruleId: ruleId, evaluated: counts.evaluated, notEvaluated: counts.notEvaluated,
            fired: counts.fired, skipped: counts.skipped, missing: data,
        });
    });
    return rows.sort(function (x, y) { return y.notEvaluated - x.notEvaluated || (x.ruleId < y.ruleId ? -1 : 1); });
}

// Memoised per snapshot object: a fleet-scale evaluation builds the port graph and every fleet-level
// join, and the tab re-renders on every activation.
var diagnosticsCache = new WeakMap();

window.invalidateDiagnosticsCache = function(snapshot) {
    if (snapshot) diagnosticsCache.delete(snapshot);
};

function activeSnapshot() {
    return loadedSnapshots[activeSnapshotIndex] || null;
}

function allowedScopesNow() {
    var settings = window.loadSettings ? window.loadSettings() : {};
    return window.asArray(settings.allowedScopes);
}

function diagnosticsFor(snapshot) {
    if (!snapshot) return null;
    var scopes = allowedScopesNow();
    var cached = diagnosticsCache.get(snapshot);
    // Keyed on the scopes too: editing the allowed scopes in Settings changes which neighbours are in
    // the fleet at all, so a cached evaluation from before the edit is an answer to a different question.
    if (cached && cached.allowedScopes.join(',') === scopes.join(',')) return cached;
    var result = window.Rules.evaluate(
        { Topology: snapshot.topology, ScanTimestamp: snapshot.scanTimestamp },
        { records: false, allowedScopes: scopes.length ? scopes : null });
    var bundle = { result: result, graph: result.graph, allowedScopes: scopes };
    diagnosticsCache.set(snapshot, bundle);
    return bundle;
}

function portLink(ip, port, text) {
    var focus = port ? ', {port: ' + JSON.stringify(String(port)) + '}' : '';
    var tab = port ? "'tab-interfaces'" : 'null';
    // The handler is JavaScript inside a double-quoted attribute, so it is escaped like any other value:
    // JSON.stringify emits double quotes, which would otherwise end the attribute mid-call and leave a
    // handler that only fails when someone clicks it.
    var handler = 'event.preventDefault(); window.goToSearchResult(' + JSON.stringify(String(ip))
        + ', ' + tab + ', activeSnapshotIndex' + focus + ');';
    return '<a href="#" class="diag-link" onclick="' + esc(handler) + '">' + esc(text) + '</a>';
}

function evidenceText(evidence) {
    if (evidence === null || evidence === undefined) return '';
    var parts = Object.keys(evidence).map(function (key) {
        var value = evidence[key];
        if (value === null || value === undefined) return key + ': null';
        if (Array.isArray(value)) return key + ': ' + (value.length ? value.map(String).join(', ') : '[]');
        if (typeof value === 'object') return key + ': ' + JSON.stringify(value);
        return key + ': ' + value;
    });
    return parts.join('  ·  ');
}

window.renderDiagnostics = function() {
    var host = document.getElementById('diagnostics-findings');
    var gaps = document.getElementById('diagnostics-gaps');
    var summary = document.getElementById('diagnostics-summary');
    if (!host || !gaps || !summary) return;

    var snapshot = activeSnapshot();
    if (!snapshot) {
        summary.innerHTML = '';
        host.innerHTML = '<p class="diag-empty">Load a snapshot to run the rules.</p>';
        gaps.innerHTML = '';
        return;
    }

    var bundle = diagnosticsFor(snapshot);
    var result = bundle.result;
    var bands = groupFindings(result);
    var counted = {};
    DIAG_SEVERITY_ORDER.forEach(function (severity) {
        var band = bands.find(function (entry) { return entry.severity === severity; });
        counted[severity] = band ? band.count : 0;
    });
    var histogram = missingHistogram(result);
    var refusals = sectionRefusals(snapshot.topology);
    var unevaluated = histogram.reduce(function (sum, row) { return sum + row.notEvaluated; }, 0);

    summary.innerHTML = ''
        + '<div class="fleet-stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 14px;">'
        + DIAG_SEVERITY_ORDER.map(function (severity) {
            // The stat card's own vocabulary is `critical`/`warn`, not the `--tier` one below it.
            var card = { error: 'critical', warning: 'warn', info: '' }[severity];
            return '<div class="fleet-stat-card ' + (counted[severity] ? card : '') + '">'
                + '<div class="stat-value">' + counted[severity] + '</div>'
                + '<div class="stat-label">' + DIAG_SEVERITY_LABEL[severity] + '</div></div>';
        }).join('')
        + '<div class="fleet-stat-card"><div class="stat-value">' + result.rules.length + '</div><div class="stat-label">Rules Run</div></div>'
        + '<div class="fleet-stat-card"><div class="stat-value">' + unevaluated + '</div><div class="stat-label">Subjects Not Evaluated</div></div>'
        + '</div>'
        + '<p class="diag-note">' + result.subjectCounts.port + ' ports, ' + result.subjectCounts.device
        + ' devices and ' + result.subjectCounts.edge + ' link ends were offered to ' + result.rules.length
        + ' rules. A rule with no findings has either passed or gone unevaluated - the second table says which, per datum.'
        + (bundle.allowedScopes.length ? '' : ' No allowed scopes are configured, so every scope-dependent rule reports its subjects as unevaluated rather than as clean.')
        + '</p>';

    host.innerHTML = !bands.length
        ? '<p class="diag-empty">No rule fired on this snapshot.</p>'
        : bands.map(function (band) {
            return '<div class="diag-band">'
                + '<h4 class="diag-band-title tier-' + DIAG_TIER[band.severity] + '">'
                + DIAG_SEVERITY_LABEL[band.severity] + ' &middot; ' + band.count + '</h4>'
                + band.rules.map(function (entry) {
                    return '<details class="diag-rule"><summary><span class="diag-badge tier-' + DIAG_TIER[band.severity] + '">'
                        + entry.findings.length + '</span> <code>' + esc(entry.ruleId) + '</code> <span class="diag-layer">'
                        + esc(entry.layer) + '</span> ' + esc(entry.title) + '</summary>'
                        + '<table class="diag-table"><thead><tr><th>Device</th><th>Port</th><th>Evidence</th></tr></thead><tbody>'
                        + entry.findings.map(function (finding) {
                            return '<tr><td>' + portLink(finding.deviceIp, null, finding.hostname && finding.hostname !== 'Unknown'
                                ? finding.hostname + ' (' + finding.deviceIp + ')' : finding.deviceIp) + '</td>'
                                + '<td>' + (finding.port ? portLink(finding.deviceIp, finding.port, finding.port) : '<span class="diag-dim">device</span>') + '</td>'
                                + '<td class="diag-evidence">' + esc(evidenceText(finding.evidence)) + '</td></tr>';
                        }).join('')
                        + '</tbody></table></details>';
                }).join('')
                + '</div>';
        }).join('');

    var refusalHtml = !refusals.length ? '' : '<p class="diag-note">Commands the chassis refused, which is'
        + ' why the rules reading them have fewer subjects rather than more gaps: '
        + refusals.map(function (entry) {
            return '<code>' + esc(entry.section) + '</code> on ' + entry.devices + ' device'
                + (entry.devices === 1 ? '' : 's') + ' &mdash; ' + esc(entry.message);
        }).join('; ')
        + '</p>';

    gaps.innerHTML = refusalHtml + (!histogram.length
        ? '<p class="diag-empty">Every rule evaluated every subject it had.</p>'
        : '<table class="diag-table"><thead><tr><th>Rule</th><th>Fired</th><th>Evaluated</th><th>Not evaluated</th><th>Missing datum</th></tr></thead><tbody>'
            + histogram.map(function (row) {
                return '<tr><td><code>' + esc(row.ruleId) + '</code></td><td>' + row.fired + '</td><td>' + row.evaluated
                    + '</td><td>' + row.notEvaluated + '</td><td class="diag-evidence">'
                    + row.missing.map(function (entry) { return esc(entry.datum) + ' &times;' + entry.count; }).join('<br>')
                    + '</td></tr>';
            }).join('')
            + '</tbody></table>');
};

// ---- Path query (sections 6.1, 6.2, 6.4) ----

function resolutionSummary(resolution, label) {
    var where = resolution.locations.map(function (place) { return place.replace('|', ' '); });
    return '<div class="diag-resolution"><strong>' + esc(label) + ':</strong> ' + esc(resolution.query)
        + ' &rarr; <span class="diag-status">' + esc(resolution.status) + '</span>'
        + (where.length ? ' <span class="diag-dim">' + esc(where.join(', ')) + '</span>' : '')
        + (resolution.interpretations.length ? ' <span class="diag-dim">read as ' + esc(resolution.interpretations.join('/')) + '</span>' : '')
        + (resolution.notes.length ? '<div class="diag-notes">' + esc(resolution.notes.join(' · ')) + '</div>' : '')
        + '</div>';
}

// The VLAN the operator did not type. A tag is required (a path is per VLAN and `NaN` would fabricate
// an absence), so it is taken from the resolved client's own sighting when there is exactly one - and
// left null, to be refused, when the evidence does not agree.
function inferVlanTag(resolution) {
    var tags = new Set();
    (resolution.matches || []).forEach(function (match) {
        if (match.transit) return;
        if (match.vlanTag === null || match.vlanTag === undefined || match.vlanTag === 'Unknown') return;
        var tag = Number(match.vlanTag);
        if (isFinite(tag)) tags.add(tag);
    });
    return tags.size === 1 ? Array.from(tags)[0] : null;
}

// The one place the resolver's answer becomes path arguments, kept out of the paint so it can be
// tested: which (device, port) each end resolved to, or why neither can be used.
function pathPanelModel(fromResolution, toResolution, requestedTag) {
    var model = { ready: false, from: null, to: null, vlanTag: null, notes: [] };
    [[fromResolution, 'from'], [toResolution, 'to']].forEach(function (pair) {
        var resolution = pair[0];
        if (resolution.status === 'FOUND') {
            var parts = resolution.locations[0].split('|');
            // G1 needs the endpoint's own MAC, which only the resolver knows. Taken from the match at
            // this location and only when the location has exactly one: two MACs behind one port is an
            // endpoint question, and verifying a path against a guess between them is worse than not
            // verifying it.
            var here = (resolution.matches || []).filter(function (match) {
                return match.mac && (match.deviceIp + '|' + match.port) === resolution.locations[0];
            });
            var macs = here.map(function (match) { return match.mac; })
                .filter(function (mac, index, all) { return all.indexOf(mac) === index; });
            model[pair[1]] = { ip: parts[0], port: parts[1] || null, mac: macs.length === 1 ? macs[0] : null };
            return;
        }
        model.notes.push(pair[1] + '-endpoint-' + resolution.status.toLowerCase().replace(/_/g, '-'));
    });
    var tag = requestedTag === null || requestedTag === undefined || requestedTag === ''
        ? (inferVlanTag(fromResolution) === null ? inferVlanTag(toResolution) : inferVlanTag(fromResolution))
        : Number(requestedTag);
    if (tag === null || !isFinite(tag)) model.notes.push('no-vlan-given');
    else model.vlanTag = tag;
    model.ready = !!(model.from && model.to && model.vlanTag !== null);
    return model;
}

// G1 on screen. The symbol carries the state and the title the evidence, because a hop row already has
// five columns and the common answers - confirmed and absent - need no explaining; a contradiction does.
var MAC_EVIDENCE_MARK = { CONFIRMED: '&#10003;', CONTRADICTED: '&#10007;', ABSENT: '&ndash;', UNMEASURED: '?' };

function macEvidenceCell(hop) {
    return ['target', 'source'].map(function (direction) {
        var evidence = hop.macEvidence ? hop.macEvidence[direction] : null;
        if (!evidence) return '<span class="diag-dim">?</span>';
        var detail = direction + ' ' + (evidence.mac || 'no MAC') + ': ' + evidence.state.toLowerCase()
            + (evidence.learnedOn.length ? ' on ' + evidence.learnedOn.join(', ') : '')
            + (evidence.reason ? ' (' + evidence.reason + ')' : '');
        var tier = evidence.state === 'CONTRADICTED' ? 'crit' : evidence.state === 'CONFIRMED' ? 'ok' : '';
        return '<span class="' + (tier ? 'tier-' + tier : 'diag-dim') + '" title="' + esc(detail) + '">'
            + MAC_EVIDENCE_MARK[evidence.state] + '</span>';
    }).join(' ');
}

function hopRow(hop) {
    var notes = hop.notes.length ? '<div class="diag-notes">' + esc(hop.notes.join(' · ')) + '</div>' : '';
    var scope = function (side) {
        var detail = hop.scope[side];
        return detail.key ? esc(detail.key + ' ' + (detail.state || '?') + '/' + (detail.role || '?')) : '<span class="diag-dim">' + esc(detail.kind) + '</span>';
    };
    return '<tr><td>' + portLink(hop.from.ip, hop.from.port, (hop.from.hostname || hop.from.ip) + ' ' + hop.from.port) + '</td>'
        + '<td>' + portLink(hop.to.ip, hop.to.port, (hop.to.hostname || hop.to.ip) + ' ' + hop.to.port) + '</td>'
        + '<td>' + esc(hop.confidence) + notes + '</td>'
        + '<td>' + scope('from') + ' &rarr; ' + scope('to') + '</td>'
        + '<td>' + (hop.captureSpreadSeconds === null ? '<span class="diag-dim">unknown</span>' : hop.captureSpreadSeconds + ' s') + '</td>'
        + '<td>' + macEvidenceCell(hop) + '</td></tr>';
}

function endpointRow(endpoint) {
    return '<tr><td>' + esc(endpoint.role) + '</td>'
        + '<td>' + portLink(endpoint.ip, endpoint.port, endpoint.ip + ' ' + endpoint.port) + '</td>'
        + '<td>' + esc(endpoint.vlan) + '</td>'
        + '<td>' + (endpoint.scope.key ? esc(endpoint.scope.key + ' ' + (endpoint.scope.state || '?')) : '<span class="diag-dim">' + esc(endpoint.scope.kind) + '</span>') + '</td>'
        + '<td>' + esc(endpoint.confidence) + '</td></tr>';
}

function gatewayHtml(report) {
    if (!report) return '';
    var rows = report.candidates.map(function (candidate) {
        return '<tr><td>' + portLink(candidate.deviceIp, null, (candidate.hostname || candidate.deviceIp)) + '</td>'
            + '<td>' + esc(candidate.unit) + '</td><td>' + esc(candidate.address) + '</td>'
            + '<td>' + esc(String(candidate.admin) + '/' + String(candidate.link)) + '</td></tr>';
    }).join('');
    return '<h4 class="diag-subhead">Gateway for ' + esc(report.ip) + ' &middot; ' + esc(report.status) + '</h4>'
        + (rows
            ? '<table class="diag-table"><thead><tr><th>Device</th><th>Unit</th><th>Address</th><th>Admin/Link</th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<p class="diag-empty">No crawled device holds a configured prefix containing this address.</p>')
        + (report.vrrp.length
            ? '<p class="diag-note">VRRP virtual MAC present: ' + report.vrrp.map(function (entry) {
                return esc(entry.mac) + ' (VRID ' + entry.vrid + (entry.vlanName ? ', ' + esc(entry.vlanName) : '') + ')';
            }).join(', ') + ' - the L3 hop is one of several routers, and which one is master is not in the snapshot.</p>'
            : '')
        + (report.notes.length ? '<p class="diag-note">' + esc(report.notes.join(' · ')) + '</p>' : '');
}

window.runPathQuery = function() {
    var out = document.getElementById('diag-path-result');
    if (!out) return;
    var snapshot = activeSnapshot();
    if (!snapshot) { out.innerHTML = '<p class="diag-empty">Load a snapshot first.</p>'; return; }

    var fromText = (document.getElementById('diagPathFrom').value || '').trim();
    var toText = (document.getElementById('diagPathTo').value || '').trim();
    var tagText = (document.getElementById('diagPathVlan').value || '').trim();
    if (window.clearPathHighlight) window.clearPathHighlight();
    if (!fromText || !toText) { out.innerHTML = '<p class="diag-empty">Give both ends: an IP, a MAC, a hostname, a dot1x user or "switch port".</p>'; return; }

    var bundle = diagnosticsFor(snapshot);
    var resolver = window.EndpointResolution.createResolver(snapshot.topology, {
        graph: bundle.graph, allowedScopes: bundle.allowedScopes.length ? bundle.allowedScopes : null,
    });
    var fromResolution = resolver.resolve(fromText);
    var toResolution = resolver.resolve(toText);
    var model = pathPanelModel(fromResolution, toResolution, tagText);

    var html = resolutionSummary(fromResolution, 'From') + resolutionSummary(toResolution, 'To');
    if (!model.ready) {
        out.innerHTML = html + '<p class="diag-empty">No path computed: ' + esc(model.notes.join(', '))
            + '. An ambiguous endpoint is an answer, not a failure - name the switch and port to settle it.</p>';
        return;
    }

    var result = window.L2Path.computePath(bundle.graph, {
        from: model.from.ip, to: model.to.ip,
        fromPort: model.from.port, toPort: model.to.port,
        vlanTag: model.vlanTag,
        sourceMac: model.from.mac, targetMac: model.to.mac,
        allowedScopes: bundle.allowedScopes.length ? bundle.allowedScopes : null,
    });

    html += '<div class="diag-path-status tier-' + (result.status === 'PATH' ? 'ok' : result.status === 'AMBIGUOUS' ? 'warn' : 'crit') + '">'
        + esc(result.status) + ' in VLAN ' + model.vlanTag
        + (result.status === 'AMBIGUOUS' ? ' - ' + result.paths.length + ' paths survive pruning; that is the finding, not a choice to make' : '')
        + (result.truncated ? ' (enumeration truncated)' : '') + '</div>';

    if (result.endpoints.length) {
        html += '<table class="diag-table"><thead><tr><th>End</th><th>Port</th><th>VLAN</th><th>Scope</th><th>Confidence</th></tr></thead><tbody>'
            + result.endpoints.map(endpointRow).join('') + '</tbody></table>';
    }

    result.paths.forEach(function (candidate, index) {
        html += '<h4 class="diag-subhead">Path ' + (index + 1) + ' &middot; ' + esc(candidate.confidence)
            + (candidate.macCoherent === false ? ' &middot; capture spread exceeds MAC aging' : '')
            + (candidate.macEvidence ? ' &middot; MAC evidence ' + candidate.macEvidence.confirmed + ' confirmed, '
                + candidate.macEvidence.contradicted + ' contradicted' : '') + '</h4>'
            + (candidate.hops.length
                ? '<table class="diag-table"><thead><tr><th>From</th><th>To</th><th>Confidence</th><th>Scope</th><th>Capture spread</th>'
                    + '<th title="Forwarding-plane evidence: is the far endpoint\'s MAC learned on the port facing the next hop, and the near one on the port facing back?">MAC</th></tr></thead><tbody>'
                    + candidate.hops.map(hopRow).join('') + '</tbody></table>'
                : '<p class="diag-note">Both ends are the same device; there is no hop.</p>')
            + (candidate.notes.length ? '<p class="diag-note">' + esc(candidate.notes.join(' · ')) + '</p>' : '');
    });

    if (result.reasons.length) {
        html += '<h4 class="diag-subhead">Why not</h4><ul class="diag-reasons">'
            + result.reasons.map(function (reason) {
                return '<li><code>' + esc(reason.kind) + '</code>' + (reason.failureMode ? ' <span class="diag-dim">' + esc(reason.failureMode) + '</span>' : '')
                    + ' - ' + esc(reason.detail) + '</li>';
            }).join('') + '</ul>';
    }
    if (result.lastReachedHop) {
        html += '<p class="diag-note">Furthest reached: ' + portLink(result.lastReachedHop.ip, null,
            (result.lastReachedHop.hostname || result.lastReachedHop.ip))
            + (result.lastReachedHop.hopsFromTarget === null ? '' : ', ' + result.lastReachedHop.hopsFromTarget + ' physical hops from the target') + '.</p>';
    }
    if (result.notes.length) html += '<p class="diag-note">' + esc(result.notes.join(' · ')) + '</p>';

    // Section 6.4, reported beside the L2 answer rather than folded into it: the endpoint's gateway is
    // an L3 question and the path above is an L2 one.
    var targetIp = toResolution.matches.map(function (match) { return match.ip; }).find(Boolean);
    if (targetIp) html += gatewayHtml(window.L2Path.gatewayCandidates(snapshot.topology, targetIp, { vlanTag: model.vlanTag }));

    out.innerHTML = html;

    // One unambiguous path is the only case where drawing on the diagram cannot mislead.
    if (result.status === 'PATH' && result.paths[0] && result.paths[0].hops.length && window.highlightPathOnDiagram) {
        var route = [result.paths[0].hops[0].from.ip].concat(result.paths[0].hops.map(function (hop) { return hop.to.ip; }));
        var drawn = window.highlightPathOnDiagram(route);
        out.innerHTML += '<p class="diag-note">' + (drawn === route.length - 1
            ? 'The path is drawn on the diagram.'
            : drawn + ' of ' + (route.length - 1) + ' hops are drawn on the diagram; the rest are inside collapsed clusters.') + '</p>';
    }
};
