import { test } from 'node:test';
import assert from 'node:assert/strict';

// chassis.js is dual-mode; the pure string builders are what's under test here.
const Chassis = (await import('../chassis.js')).default;
const { resolveModel, inferModel, activityState, linkState, buildMembers, lightStates, H72_S, H6MO_S, MODELS } = Chassis;

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

test('activityState: link up is green regardless of flap age', () => {
  assert.equal(activityState({ Link: 'up', LastFlappedSeconds: 10 * H6MO_S }), 'green');
  assert.equal(linkState({ Link: 'up' }), 'green');
});

// A down port shows the same "down" state chassis-side as the table's red badge - 'off' is reserved
// for a port the artwork has but the device didn't report at all.
test('linkState: down is red (matches the table\'s down badge), no interface data is off', () => {
  assert.equal(linkState({ Link: 'down' }), 'red');
  assert.equal(linkState({ Link: 'Unknown' }), 'red');
  assert.equal(linkState(null), 'off');
});

// LastFlappedSeconds is captured as of the snapshot's scan; a stale snapshot must not read as recent.
test('activityState: an ageSec offset (time since the snapshot was captured) ages out a stale-but-recent flap', () => {
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H72_S - 1 }, 0), 'green');
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H72_S - 1 }, 2), 'amber');
  assert.equal(activityState({ Link: 'down', LastFlappedSeconds: H72_S }, H6MO_S), 'off');
  // Link up short-circuits to green; only the LastFlappedSeconds comparison is age-adjusted.
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

// The ALM LED must reflect device.Alarms for both the statusCluster families and RIGHT.lcd.
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
  // A real EX4300-48P names access ports ge-0/0/x; this reports xe-0/0/x, which the art has no jacks for.
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

// mgig must be flagged per port, not per 12-port block, or a ge port sharing a block would be
// renamed too. The mge ports here (14, 15) don't align to the 12-port boundary.
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

test('buildMembers: a stack member with no reported ports blocks its sibling being demoted', () => {
  // 10.55.10.1's shape: fpc0 reports 9 ports the art has no jacks for, fpc1 reports none at all, so
  // demoting fpc0 alone would render one virtual chassis as two different switches.
  const ifs = [{ Port: 'xe-0/1/0', Link: 'up' }].concat(
    Array.from({ length: 8 }, (_, n) => ({ Port: `xe-0/0/${n}`, Link: 'up' })));
  const members = buildMembers({
    StackMembers: [{ FPC: '0', Model: 'ex4300-48p', Role: 'Master' }, { FPC: '1', Model: 'ex4300-48p', Role: 'Backup' }],
    Interfaces: ifs,
  });
  assert.deepEqual(members.map(m => m.inferred), [false, false]);
  assert.deepEqual(members.map(m => m.catalogueKey), ['EX4300-48P', 'EX4300-48P']);
});

test('buildMembers: a reported-port sample under the minimum floor cannot demote', () => {
  const ifs = Array.from({ length: 7 }, (_, n) => ({ Port: `xe-0/0/${n}`, Link: 'up' }));
  const [m] = buildMembers({ StackMembers: [{ FPC: '0', Model: 'ex4300-48p', Role: 'Master' }], Interfaces: ifs });
  assert.equal(m.inferred, false);
  assert.equal(m.catalogueKey, 'EX4300-48P');
});

test('buildMembers: pooling still demotes when every member carries contrary evidence', () => {
  const ifs = [];
  for (const fpc of [0, 1]) for (let n = 0; n < 8; n++) ifs.push({ Port: `xe-${fpc}/0/${n}`, Link: 'up' });
  const members = buildMembers({
    StackMembers: [{ FPC: '0', Model: 'ex4300-48p', Role: 'Master' }, { FPC: '1', Model: 'ex4300-48p', Role: 'Backup' }],
    Interfaces: ifs,
  });
  assert.deepEqual(members.map(m => m.inferred), [true, true]);
});

// ---- SFP cage binding: the prefix follows the optic, not the cage ----
// A 1G optic in an SFP+ cage reports ge-, not xe-. The art names EX4600 cages xe-, so exact-name
// binding covered none, the pool was demoted, and inferModel then drew RJ45 on an all-fiber switch.
function sfpVcDevice(prefix) {
  const interfaces = [];
  for (const fpc of [0, 1]) {
    for (let n = 0; n < 24; n++) {
      interfaces.push({ Port: `${prefix}-${fpc}/0/${n}`, Admin: 'up', Link: n % 3 ? 'down' : 'up' });
    }
  }
  return {
    StackMembers: [
      { FPC: '0', Model: 'EX4600-40F', Serial: 'A', Role: 'Master' },
      { FPC: '1', Model: 'EX4600-40F', Serial: 'B', Role: 'Backup' },
    ],
    Interfaces: interfaces, Alarms: [],
  };
}

test('an EX4600 reporting 1G optics as ge- still gets its catalogue art, not the inferred panel', () => {
  for (const m of buildMembers(sfpVcDevice('ge'))) {
    assert.equal(m.catalogueKey, 'EX4600-40F');
    assert.equal(m.inferred, false, 'catalogue art must not be demoted over an optic-speed prefix');
  }
});

test('a cage binds to the name the switch actually reports, so its lens and tooltip resolve', () => {
  const [m] = buildMembers(sfpVcDevice('ge'));
  assert.equal(m.catalogueKey, 'EX4600-40F', 'must be the catalogue art, not the inferred panel');
  // The art names this cage xe-0/0/7; the device reports ge-0/0/7, and that is what must reach data-port.
  assert.ok(m.html.includes('data-port="ge-0/0/7"'), 'cage bound to the reported ge- name');
  assert.ok(!m.html.includes('port-absent" data-port="xe-0/0/7"'), 'not reported as an absent xe- port');
});

test('the same art still binds xe- names when 10G optics are fitted', () => {
  const [m] = buildMembers(sfpVcDevice('xe'));
  assert.equal(m.catalogueKey, 'EX4600-40F');
  assert.equal(m.inferred, false);
  assert.ok(m.html.includes('data-port="xe-0/0/7"'));
});

// ---- catalogue-wide guard against the EX4600 failure mode ----
// Every model is driven through each prefix its cages could report. A model whose art binds only one
// spelling gets demoted and, if its ports are ge-, redrawn as RJ45.
function artPortsOf(key) {
  // Rendered with no interfaces: nothing reported, nothing can be demoted, so the art's names show.
  const [m] = buildMembers({ StackMembers: [{ FPC: '0', Model: key, Role: 'Standalone' }], Interfaces: [], Alarms: [] });
  return [...m.html.matchAll(/data-port="([^"]+)"/g)].map(x => x[1]);
}
function renderWith(key, ports) {
  const [m] = buildMembers({
    StackMembers: [{ FPC: '0', Model: key, Role: 'Standalone' }],
    Interfaces: ports.map(p => ({ Port: p, Admin: 'up', Link: 'up' })), Alarms: [],
  });
  return m;
}

const CATALOGUE = Object.keys(MODELS).filter(k => !MODELS[k].inferred);

test('every catalogue model keeps its art when its own port names are reported', () => {
  const failures = [];
  for (const key of CATALOGUE) {
    const ports = artPortsOf(key);
    if (ports.length < 8) continue; // under the demotion sample size; nothing to prove
    if (renderWith(key, ports).catalogueKey !== key) failures.push(key);
  }
  assert.deepEqual(failures, [], 'demoted despite reporting exactly their own ports');
});

test('no pluggable-cage model is demoted because a different optic speed is fitted', () => {
  const failures = [];
  for (const key of CATALOGUE) {
    if (MODELS[key].style !== 'sfp') continue; // rj45 access ports are fixed copper, not cages
    const ports = artPortsOf(key);
    if (ports.length < 8) continue;
    for (const prefix of ['ge', 'xe', 'et']) {
      const swapped = ports.map(p => p.replace(/^(ge|xe|et)-/, prefix + '-'));
      if (renderWith(key, swapped).catalogueKey !== key) failures.push(`${key} demoted when its cages report ${prefix}-`);
    }
  }
  assert.deepEqual(failures, []);
});

test('an rj45 model keeps its art when only the uplink cages change optic speed', () => {
  const failures = [];
  for (const key of CATALOGUE) {
    if (MODELS[key].style !== 'rj45') continue;
    const ports = artPortsOf(key);
    if (ports.length < 8) continue;
    for (const prefix of ['ge', 'xe', 'et']) {
      // PIC 0 is the fixed copper field and keeps its names; only the uplink cages vary.
      const swapped = ports.map(p => (/^(ge|xe|et)-\d+\/0\//.test(p) ? p : p.replace(/^(ge|xe|et)-/, prefix + '-')));
      if (renderWith(key, swapped).catalogueKey !== key) failures.push(`${key} demoted when its uplinks report ${prefix}-`);
    }
  }
  assert.deepEqual(failures, []);
});

// ---- EX4300-32F: an all-SFP chassis whose uplink bay is drawn from what is reported ----

const F32 = Array.from({ length: 32 }, (_, i) => `ge-0/0/${i}`);
const cageKeys = (html) => [...html.matchAll(/id="uplink_[^"]*"[^>]*data-port="([^"]+)"/g)].map(m => m[1]);

test('EX4300-32F resolves to its own art and binds all 32 SFP cages', () => {
  const m = renderWith('EX4300-32F', F32);
  assert.equal(m.catalogueKey, 'EX4300-32F');
  assert.equal(m.inferred, false);
  for (const p of F32) assert.ok(m.html.includes(`data-port="${p}"`), `${p} unbound`);
});

test('an unreported uplink bay draws a cover panel, not phantom cages', () => {
  assert.deepEqual(cageKeys(renderWith('EX4300-32F', F32).html).filter(p => /\/1\//.test(p)), []);
});

test('a populated uplink bay is drawn from the module actually fitted', () => {
  const sfpp = cageKeys(renderWith('EX4300-32F', F32.concat(Array.from({ length: 8 }, (_, i) => `xe-0/1/${i}`))).html);
  assert.deepEqual(sfpp.filter(p => /\/1\//.test(p)), Array.from({ length: 8 }, (_, i) => `xe-0/1/${i}`));

  const qsfp = cageKeys(renderWith('EX4300-32F', F32.concat(['et-0/1/0', 'et-0/1/1'])).html);
  assert.deepEqual(qsfp.filter(p => /\/1\//.test(p)), ['et-0/1/0', 'et-0/1/1']);
});

test('the bay is detected from any of its ports, not only port 0', () => {
  // device.Interfaces is a filtered subset, so a fitted module can arrive missing its first cage.
  const html = renderWith('EX4300-32F', F32.concat(['xe-0/1/3', 'xe-0/1/6'])).html;
  assert.ok(cageKeys(html).includes('xe-0/1/3'), 'a module reported only from port 3 must still draw');
});
