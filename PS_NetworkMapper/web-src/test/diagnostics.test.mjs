// The Diagnostics sub-tab's decisions, separated from its paint. diagnostics.js is DOM-bound at the top
// level (window.renderDiagnostics and friends), so the three pure functions are lifted out and run
// against real engine output rather than against a hand-written shape - a summary that agrees with a
// mock and disagrees with `evaluate` would pass a mocked test and mislead on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Rules from '../rules.js';
import { byName, ALLOWED_SCOPES } from '../tools/micro-topologies.mjs';

const src = fs.readFileSync(new URL('../diagnostics.js', import.meta.url), 'utf8');

function load() {
    const pick = (re) => {
        const hit = src.match(re);
        assert.ok(hit, `diagnostics.js no longer contains ${re}`);
        return hit[0];
    };
    const body = [
        pick(/var DIAG_TIER = \{[^}]*\};/),
        pick(/var DIAG_SEVERITY_ORDER = \[[^\]]*\];/),
        pick(/function groupFindings\(result\)[\s\S]*?\n\}/),
        pick(/function sectionRefusals\(devices\)[\s\S]*?\n\}/),
        pick(/function missingHistogram\(result\)[\s\S]*?\n\}/),
        pick(/function inferVlanTag\(resolution\)[\s\S]*?\n\}/),
        pick(/function pathPanelModel\(fromResolution, toResolution, requestedTag\)[\s\S]*?\n\}/),
        'return { groupFindings, missingHistogram, sectionRefusals, inferVlanTag, pathPanelModel, DIAG_TIER, DIAG_SEVERITY_ORDER };',
    ].join('\n');
    return new Function(body)();
}

const evaluatedSnapshot = () => byName('partial-node-missing-stp-section').snapshot;
const evaluated = () => Rules.evaluate(evaluatedSnapshot(), { allowedScopes: ALLOWED_SCOPES });

test('every severity a rule can carry has a tier, including the info the L2 rules introduced', () => {
    const { DIAG_TIER, DIAG_SEVERITY_ORDER } = load();
    const used = Array.from(new Set(Rules.RULES.map(r => r.severity))).sort();
    for (const severity of used) {
        assert.ok(DIAG_TIER[severity], `severity ${severity} has no tier`);
        assert.ok(DIAG_SEVERITY_ORDER.includes(severity), `severity ${severity} is in no band`);
    }
    assert.ok(used.includes('info'), 'the catalogue still has an info rule; this test is about it');
});

test('findings group by severity then rule, and the bands hold every finding exactly once', () => {
    const { groupFindings } = load();
    const result = evaluated();
    const bands = groupFindings(result);

    const listed = bands.flatMap(b => b.rules.flatMap(r => r.findings));
    assert.equal(listed.length, result.findings.length);
    assert.equal(new Set(listed.map(f => f.key)).size, result.findings.length, 'no finding is listed twice');
    for (const band of bands) {
        assert.equal(band.count, band.rules.reduce((sum, r) => sum + r.findings.length, 0));
        for (const entry of band.rules) {
            assert.ok(entry.findings.every(f => f.severity === band.severity), 'a band holds one severity');
            assert.ok(entry.findings.every(f => f.ruleId === entry.ruleId));
        }
        // Loudest rule first, so the screen's order is a property of the snapshot.
        const sizes = band.rules.map(r => r.findings.length);
        assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
    }
    // An empty band is not rendered at all rather than as a zero.
    assert.ok(bands.every(b => b.rules.length > 0));
});

test('the missing histogram reports the silence the findings cannot', () => {
    const { missingHistogram } = load();
    const result = evaluated();
    const rows = missingHistogram(result);

    // The micro-topology is a node whose STP section never arrived, so at least one rule has to say so.
    const stp = rows.filter(row => row.missing.some(entry => entry.datum.indexOf('section:STP') !== -1));
    assert.ok(stp.length, `no rule reported the missing STP section: ${JSON.stringify(rows.map(r => r.ruleId))}`);

    for (const row of rows) {
        const counts = result.stats[row.ruleId];
        assert.equal(row.notEvaluated, counts.notEvaluated);
        assert.equal(row.missing.reduce((sum, entry) => sum + entry.count, 0), counts.notEvaluated,
            'the histogram accounts for every unevaluated subject');
    }
    // Rules that read everything are dropped: the table exists for the gaps.
    assert.ok(rows.every(row => row.notEvaluated > 0));
    const sorted = rows.map(row => row.notEvaluated);
    assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a));
});

// Section 3.5's third state on screen, and the reason it is NOT a histogram row: a refused command still
// prints output, so its section lands in SectionsCaptured and the rules reading it correctly skip those
// ports as non-subjects. That silence is right and invisible, which is what this line is for.
test('a refused command is reported as a refusal, not as a missing section', () => {
    const { missingHistogram, sectionRefusals } = load();
    const snapshot = evaluatedSnapshot();
    assert.deepEqual(sectionRefusals(snapshot.Topology), [], 'nothing refused a command in this topology');
    assert.deepEqual(sectionRefusals(null), [], 'a snapshot with no devices cannot claim a refusal');

    const devices = snapshot.Topology.map((device, index) => (index === 0 ? device : {
        ...device, SectionErrors: { POE: 'error: PoE is not supported on this platform' },
    }));
    const refusals = sectionRefusals(devices);
    assert.equal(refusals.length, 1);
    assert.deepEqual(refusals[0], {
        section: 'POE', devices: devices.length - 1,
        message: 'error: PoE is not supported on this platform',
    });

    // And it stays out of the histogram, which counts UNEVALUATED SUBJECTS and nothing else. The
    // micro-topology's truncated node does produce a `section:POE` row - that one is a lost section, not
    // a refusal - and the row carries the datum and its count, with no refusal leaking into it.
    const result = evaluated();
    const poe = missingHistogram(result).flatMap(row => row.missing).filter(e => e.datum === 'section:POE');
    assert.ok(poe.length, 'the truncated node no longer loses its PoE section');
    for (const entry of poe) assert.deepEqual(Object.keys(entry).sort(), ['count', 'datum']);
});

test('a path query needs two settled endpoints and a VLAN, and says which it is missing', () => {
    const { pathPanelModel, inferVlanTag } = load();
    const found = (ip, port, tag) => ({
        query: ip, status: 'FOUND', locations: [`${ip}|${port}`], notes: [], interpretations: ['client-ip'],
        matches: [{ deviceIp: ip, port: port, vlanTag: tag, transit: false }],
    });

    const ready = pathPanelModel(found('10.30.1.10', 'ge-0/0/1', 10), found('10.30.1.11', 'ge-0/0/2', 10), '');
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.from, { ip: '10.30.1.10', port: 'ge-0/0/1' });
    assert.equal(ready.vlanTag, 10, 'the tag is taken from the sighting when the operator gave none');

    // A typed tag wins over the sighting: an operator asking about VLAN 20 is asking about VLAN 20.
    assert.equal(pathPanelModel(found('10.30.1.10', 'ge-0/0/1', 10), found('10.30.1.11', 'ge-0/0/2', 10), '20').vlanTag, 20);

    const ambiguous = { query: 'ap-1000', status: 'AMBIGUOUS', locations: ['a|1', 'b|2'], notes: [], interpretations: [], matches: [] };
    const blocked = pathPanelModel(ambiguous, found('10.30.1.11', 'ge-0/0/2', 10), '');
    assert.equal(blocked.ready, false);
    assert.ok(blocked.notes.includes('from-endpoint-ambiguous'), JSON.stringify(blocked.notes));

    // Two sightings in two VLANs is not a tag to guess at - it is a question to refuse.
    const twoVlans = { ...found('10.30.1.10', 'ge-0/0/1', 10) };
    twoVlans.matches = [...twoVlans.matches, { deviceIp: '10.30.1.10', port: 'ge-0/0/3', vlanTag: 20, transit: false }];
    assert.equal(inferVlanTag(twoVlans), null);
    const noTag = pathPanelModel(twoVlans, { ...found('10.30.1.11', 'ge-0/0/2', null) }, '');
    assert.equal(noTag.ready, false);
    assert.ok(noTag.notes.includes('no-vlan-given'));

    // A transit sighting is not the endpoint's VLAN; it is the same frame seen a second time (R3, F4).
    const transitOnly = found('10.30.1.10', 'ge-0/0/1', 30);
    transitOnly.matches[0].transit = true;
    assert.equal(inferVlanTag(transitOnly), null);
});
