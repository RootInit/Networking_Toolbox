import { test } from 'node:test';
import assert from 'node:assert/strict';

// chassis.js is dual-mode (module.exports under node, window.Chassis in the browser) - the
// pure string builders are what's under test here; the DOM binding only exists in the browser.
const Chassis = (await import('../chassis.js')).default;
const { resolveModel, inferModel, activityState, linkState, buildMembers, lightStates, H72_S, H6MO_S, MODELS } = Chassis;

// ---- model resolution: what Junos reports vs. catalogue keys ----

test('resolveModel is case-insensitive (virtual-chassis output is lower-case)', () => {
  assert.equal(resolveModel('ex2300-24t').key, 'EX2300-24T');
  assert.equal(resolveModel('EX4300-48P').key, 'EX4300-48P');
});

test('resolveModel strips ordering/airflow trailers', () => {
  assert.equal(resolveModel('EX4300-48P-AFI').key, 'EX4300-48P');
  assert.equal(resolveModel('qfx5100-48s-dc-afo').key, 'QFX5100-48S');
  assert.equal(resolveModel('EX4400-48P-TAA').key, 'EX4400-48P');
});

test('resolveModel falls back to a measured sibling with a different port option letter', () => {
  // -MP variants share the chassis with the -P; the catalogue has EX2300-48P measured.
  assert.equal(resolveModel('EX2300-48MP').key, 'EX2300-48P');
});

test('resolveModel returns null for unknown and empty input', () => {
  assert.equal(resolveModel(''), null);
  assert.equal(resolveModel(null), null);
  assert.equal(resolveModel('EX9999-99Z'), null);
});

test('every real model seen in the fixture snapshot resolves to a catalogue entry', () => {
  for (const m of ['ex4600-40f', 'ex4300-48p', 'ex4300-48t', 'ex2300-48p', 'ex3400-24p', 'ex2300-24t', 'ex3400-48p']) {
    assert.ok(resolveModel(m), `${m} should resolve`);
  }
});

// ---- activity lens thresholds ----

test('activityState: link up is green regardless of flap age', () => {
  assert.equal(activityState({ Link: 'up', LastFlappedSeconds: 10 * H6MO_S }), 'green');
  assert.equal(linkState({ Link: 'up' }), 'green');
});

// A down port shows the same "down" state chassis-side as the red badge the
// Interfaces table shows for it (drawer.js renderInterfaces) - 'off' is reserved for a port
// the artwork has but the device didn't report at all (linkState never even gets called for
// those - lightStates only iterates device.Interfaces).
test('linkState: down is red (matches the table\'s down badge), no interface data is off', () => {
  assert.equal(linkState({ Link: 'down' }), 'red');
  assert.equal(linkState({ Link: 'Unknown' }), 'red');
  assert.equal(linkState(null), 'off');
});

// LastFlappedSeconds is captured once, as of the snapshot's own scan - a stale
// snapshot must not read as "recently active" just because its age isn't accounted for.
test('activityState: an ageSec offset (time since the snapshot was captured) ages out a stale-but-recent flap', () => {
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H72_S - 1 }, 0), 'green');
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H72_S - 1 }, 2), 'amber');
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H72_S }, H6MO_S), 'off');
  // link up still short-circuits to green regardless of snapshot age - only the
  // LastFlappedSeconds comparison is age-adjusted.
  assert.equal(activityState({ Link: 'up', LastFlappedSeconds: 0 }, H6MO_S), 'green');
});

test('activityState: down ports grade by LastFlappedSeconds - green <=72h, amber <=6mo, off beyond', () => {
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H72_S - 1 }), 'green');
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H72_S }), 'green');
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H72_S + 1 }), 'amber');
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H6MO_S }), 'amber');
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H6MO_S + 1 }), 'off');
});

test('activityState: unknown flap time (null/undefined/NaN) is unlit, not green', () => {
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: null }), 'off');
  assert.equal(activityState({ Link: 'down' }), 'off');
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: NaN }), 'off');
  assert.equal(activityState(null), 'off');
});

// ---- member build: one SVG per stack member, ports bound by Junos name ----

const countAttr = (html, re) => (html.match(re) || []).length;

function vcDevice() {
  const ifs = [];
  for (const fpc of [0, 1]) for (let n = 0; n < 48; n++) ifs.push({ Port: `ge-${fpc}/0/${n}`, Admin: 'up', Link: n % 2 ? 'up' : 'down', Desc: n === 3 ? 'Desk <b>3</b>' : 'Unknown', LastFlappedSeconds: n * 3600 });
  ifs.push({ Port: 'xe-0/1/0', Admin: 'up', Link: 'up', Desc: 'Uplink' });
  ifs.push({ Port: 'ge-0/0/1.0', Admin: 'up', Link: 'up', Desc: 'logical unit - must be ignored' });
  return {
    DeviceIP: '10.0.0.1',
    StackMembers: [
      { FPC: '1', Model: 'ex2300-48p', Serial: 'B', Role: 'Backup' },
      { FPC: '0', Model: 'ex2300-48p', Serial: 'A', Role: 'Master' },
    ],
    Interfaces: ifs,
  };
}

test('buildMembers orders members by FPC and draws one SVG each with the right port bindings', () => {
  const members = buildMembers(vcDevice());
  assert.equal(members.length, 2);
  assert.deepEqual(members.map(m => m.fpc), [0, 1]);
  assert.equal(members[0].master, true);
  assert.equal(members[1].master, false);
  for (const m of members) {
    assert.ok(m.html.startsWith('<svg'), 'member has SVG art');
    assert.equal(m.catalogueKey, 'EX2300-48P');
    assert.equal(m.inferred, false);
    // 48 access jacks + 4 SFP uplinks, each a .port-el keyed by bare interface name
    assert.equal(countAttr(m.html, /class="port-el[^"]*" data-port="ge-/g), 48);
    assert.equal(countAttr(m.html, /class="port-el[^"]*" data-port="xe-/g), 4);
    assert.ok(m.html.includes(`data-port="ge-${m.fpc}/0/47"`));
    // every port has a link and an activity lens
    assert.equal(countAttr(m.html, /data-role="link"/g), 52);
    assert.equal(countAttr(m.html, /data-role="act"/g), 52);
  }
  // ports the artwork has but the device did not report are marked absent (fpc 0 uplinks 1..3)
  assert.equal(countAttr(members[0].html, /port-absent" data-port="xe-0\/1\//g), 3);
  assert.equal(countAttr(members[1].html, /port-absent" data-port="xe-1\/1\//g), 4);
  // tooltip detail carries state and description, HTML-escaped, beside the port binding
  assert.ok(members[0].html.includes('data-port="ge-0/0/3" data-kind="access" data-tip="up/up · Desk &lt;b&gt;3&lt;/b&gt;"'));
  assert.ok(members[0].html.includes('data-port="xe-0/1/1" data-kind="uplink" data-tip="not in scan data"'));
  assert.ok(!members[0].html.includes('<title>'));
});

test('lightStates maps each physical interface to lens colours and skips logical units', () => {
  const st = lightStates(vcDevice());
  assert.equal(st['ge-0/0/1.0'], undefined);
  assert.deepEqual(st['ge-0/0/1'], { link: 'green', act: 'green' });           // up
  assert.deepEqual(st['ge-0/0/0'], { link: 'red', act: 'green' });             // down, flapped 0h ago
  assert.deepEqual(st['ge-0/0/46'], { link: 'red', act: 'green' });            // 46h ago
  assert.deepEqual(st['ge-1/0/0'], { link: 'red', act: 'green' });
});

test('lightStates accepts an ageSec offset and applies it to every port\'s activity lens', () => {
  const st = lightStates(vcDevice(), H6MO_S + 1);
  assert.equal(st['ge-0/0/0'].act, 'off');   // 0h flap + 6mo-plus snapshot age is past the amber cutoff
});

test('buildMembers tolerates a null/undefined element in StackMembers (malformed scan data)', () => {
  const members = buildMembers({ StackMembers: [null, { FPC: '0', Model: 'EX2300-C-12P', Serial: 'X', Role: 'Standalone' }, undefined], Interfaces: [] });
  assert.equal(members.length, 1);
  assert.equal(members[0].master, true);
});

test('lightStates tolerates a null/undefined element in Interfaces (malformed scan data)', () => {
  const st = lightStates({ Interfaces: [null, { Port: 'ge-0/0/1', Link: 'up' }, undefined] });
  assert.deepEqual(st['ge-0/0/1'], { link: 'green', act: 'green' });
});

test('buildMembers handles a single-element StackMembers object (PowerShell ConvertTo-Json quirk)', () => {
  const members = buildMembers({ StackMembers: { FPC: '0', Model: 'EX2300-C-12P', Serial: 'X', Role: 'Standalone' }, Interfaces: [] });
  assert.equal(members.length, 1);
  assert.equal(members[0].master, true);
  assert.ok(members[0].html.includes('data-port="ge-0/0/11"'));
});

// The ALM LED must reflect device.Alarms, both for the statusCluster-drawn
// families (EX2300 right section) and RIGHT.lcd, which draws its ALM dot directly.
test('buildMembers wires the ALM LED to device.Alarms', () => {
  const withAlarm = vcDevice();
  withAlarm.Alarms = [{ Class: 'Major', Time: 'now', Description: 'psu' }];
  const [lit] = buildMembers(withAlarm);
  assert.ok(lit.html.includes('class="light-glyph red"'), 'ALM LED lit red when Alarms is non-empty');

  const [unlit] = buildMembers(vcDevice());
  assert.ok(!unlit.html.includes('class="light-glyph red"'), 'ALM LED unlit with no Alarms');
});

test('buildMembers wires ALM on the LCD family too (RIGHT.lcd draws its LEDs outside statusCluster)', () => {
  const device = { StackMembers: [{ FPC: '0', Model: 'ex4300-48p', Role: 'Standalone' }], Interfaces: [], Alarms: [{ Class: 'Major' }] };
  const [m] = buildMembers(device);
  assert.ok(m.html.includes('class="light-glyph red"'));
});

test('buildMembers: modular chassis gets a note, not artwork', () => {
  const [m] = buildMembers({ StackMembers: [{ FPC: '0', Model: 'ex9200-32xs', Role: 'Master' }], Interfaces: [{ Port: 'xe-0/0/0', Link: 'up' }] });
  assert.equal(m.html, undefined);
  assert.match(m.note, /Modular chassis/);
});

test('buildMembers: unknown fixed-config model is inferred from its interface names', () => {
  const ifs = [];
  for (let n = 0; n < 24; n++) ifs.push({ Port: `ge-0/0/${n}`, Link: 'down' });
  for (let n = 0; n < 4; n++) ifs.push({ Port: `xe-0/1/${n}`, Link: 'down' });
  const [m] = buildMembers({ StackMembers: [{ FPC: '0', Model: 'EX7777-24P', Role: 'Standalone' }], Interfaces: ifs });
  assert.equal(m.inferred, true);
  assert.equal(m.catalogueKey, null);
  assert.equal(countAttr(m.html, /class="port-el[^"]*" data-port="ge-/g), 24);
  assert.equal(countAttr(m.html, /class="port-el[^"]*" data-port="xe-0\/1\//g), 4);
  assert.ok(m.html.includes('EX7777-24P'));
});

test('buildMembers falls back to the inferred layout when catalogue art covers under half the reported ports', () => {
  // A real EX4300-48P names its access ports ge-0/0/x; this record reports only xe-0/0/x, which
  // the measured EX4300 artwork has no jacks for.
  const ifs = Array.from({ length: 8 }, (_, n) => ({ Port: `xe-0/0/${n}`, Link: 'up' }));
  const [m] = buildMembers({ StackMembers: [{ FPC: '0', Model: 'ex4300-48p', Role: 'Master' }], Interfaces: ifs });
  assert.equal(m.inferred, true);
  assert.equal(m.catalogueKey, null);
  assert.equal(countAttr(m.html, /class="port-el" data-port="xe-0\/0\//g), 8);
  // ...while a record that matches keeps the measured art
  const good = Array.from({ length: 48 }, (_, n) => ({ Port: `ge-0/0/${n}`, Link: 'up' }));
  const [g] = buildMembers({ StackMembers: [{ FPC: '0', Model: 'ex4300-48p', Role: 'Master' }], Interfaces: good });
  assert.equal(g.catalogueKey, 'EX4300-48P');
});

// mgig must be flagged per port, not per 12-port block, or a ge port sharing a block with
// an mge port would get renamed/mislabeled too. mge ports here (14, 15) don't align to the
// 12-port boundary (block 2 starts at port 12).
test('inferModel flags mgig per port, not per 12-port block', () => {
  const ifs = [];
  for (let n = 0; n < 14; n++) ifs.push({ Port: `ge-0/0/${n}` });
  ifs.push({ Port: 'mge-0/0/14' }, { Port: 'mge-0/0/15' });
  const [m] = buildMembers({ StackMembers: [{ FPC: '0', Model: 'EX7777-24P', Role: 'Standalone' }], Interfaces: ifs });
  assert.equal(m.inferred, true);
  // ports 12/13 share a block with the mge ports but are still named/bound as ge
  assert.ok(m.html.includes('data-port="ge-0/0/12"'));
  assert.ok(m.html.includes('data-port="ge-0/0/13"'));
  // the actual mge ports are named/bound as mge, not folded into the block's "ge" naming
  assert.ok(m.html.includes('data-port="mge-0/0/14"'));
  assert.ok(m.html.includes('data-port="mge-0/0/15"'));
});

test('inferModel picks the SFP family for fibre access ports and null when the FPC has none', () => {
  const ifs = Array.from({ length: 48 }, (_, n) => ({ Port: `xe-0/0/${n}` }));
  const sfp = inferModel('QFX0000-48S', 0, ifs);
  assert.equal(sfp.style, 'sfp');
  assert.equal(sfp.spec.groups.reduce((a, g) => a + g.cols, 0), 24);
  assert.equal(inferModel('X', 3, ifs), null);
});

test('buildMembers with no hardware record derives members from interface FPC numbers', () => {
  const members = buildMembers({ Interfaces: [{ Port: 'ge-2/0/0' }, { Port: 'ge-0/0/5' }] });
  assert.deepEqual(members.map(m => m.fpc), [0, 2]);
});

test('every catalogue entry renders without throwing and binds at least one port', () => {
  for (const key of Object.keys(MODELS)) {
    const [m] = buildMembers({ StackMembers: [{ FPC: '0', Model: key, Role: 'Standalone' }], Interfaces: [] });
    assert.ok(m.html && m.html.endsWith('</svg>'), `${key} renders`);
    assert.ok(countAttr(m.html, /data-port="/g) > 0, `${key} has ports`);
    assert.equal(m.catalogueKey, key);
  }
});
