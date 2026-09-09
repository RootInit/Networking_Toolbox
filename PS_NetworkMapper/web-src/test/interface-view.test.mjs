import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// drawer.js is browser-only, so buildInterfaceView and inactiveForText are lifted out of the
// source and run against a stub of the two controls they read. This is the single decision
// point for which interface rows are shown and in what order - the table, the CSV export and
// the printable report all go through it, which is what stops them disagreeing.
const src = fs.readFileSync(new URL('../drawer.js', import.meta.url), 'utf8');

function load({ hideDown = false, vlan = 'ALL', sortColumn = null, sortDir = 1 } = {}) {
  const document = {
    getElementById: (id) => ({ hideDownPorts: { checked: hideDown }, vlanFilter: { value: vlan } }[id] || null),
  };
  const window = {
    asArray: (v) => (Array.isArray(v) ? v.filter(x => x !== null && x !== undefined) : (v === null || v === undefined ? [] : [v])),
    normalizePort: (p) => String(p || '').split('.')[0],
    formatAge: (ms) => `${Math.round(ms / 86400000)}d`,
  };
  const pick = (re) => src.match(re)[0];
  const body = [
    pick(/var interfaceSortState = \{[^}]*\};/),
    pick(/var INTERFACE_SORT_COMPARATORS = \{[\s\S]*?\n\};/),
    pick(/var portModeCache = new WeakMap\(\);/),
    pick(/function buildPortModes\(device\)[\s\S]*?\n\}/),
    pick(/function classifyInterface\([\s\S]*?\n\}/),
    pick(/window\.buildInterfaceView = function[\s\S]*?\n\};/),
    pick(/window\.inactiveForText = function[\s\S]*?\n\};/),
    `interfaceSortState.column = ${JSON.stringify(sortColumn)}; interfaceSortState.dir = ${sortDir};`,
    'return { buildInterfaceView: window.buildInterfaceView, inactiveForText: window.inactiveForText };',
  ].join('\n');
  return new Function('window', 'document', 'esc', body)(window, document, (x) => x);
}

const DEV = {
  DeviceIP: '10.0.0.1', Neighbors: [], TrueClients: [], Configuration: '',
  Interfaces: [
    { Port: 'ge-0/0/0', Admin: 'up', Link: 'up', Desc: 'live', STP: 'FWD' },
    { Port: 'ge-0/0/1', Admin: 'up', Link: 'down', Desc: 'recent', STP: '-', LastFlappedSeconds: 3600 },
    { Port: 'ge-0/0/2', Admin: 'up', Link: 'down', Desc: 'ancient', STP: '-', LastFlappedSeconds: 9000000 },
    { Port: 'ge-0/0/3', Admin: 'up', Link: 'down', Desc: 'never flapped', STP: '-' },
    { Port: 'ge-0/0/0.0', Admin: 'up', Link: 'up', Desc: 'logical unit', STP: '-' },
  ],
};

test('the default order is down ports first, longest inactive first, unknown last', () => {
  const { buildInterfaceView } = load();
  const ports = buildInterfaceView(DEV).rows.map(r => r.Port);
  assert.deepEqual(ports, ['ge-0/0/2', 'ge-0/0/1', 'ge-0/0/3', 'ge-0/0/0']);
});

test('logical sub-interface units are never rows', () => {
  const { buildInterfaceView } = load();
  assert.ok(!buildInterfaceView(DEV).rows.some(r => String(r.Port).includes('.')));
});

test('the hide-inactive control drops link-down ports', () => {
  const { buildInterfaceView } = load({ hideDown: true });
  assert.deepEqual(buildInterfaceView(DEV).rows.map(r => r.Port), ['ge-0/0/0']);
});

test('a chosen column overrides the default order, and its direction flips', () => {
  const asc = load({ sortColumn: 'port', sortDir: 1 }).buildInterfaceView(DEV).rows.map(r => r.Port);
  assert.deepEqual(asc, ['ge-0/0/0', 'ge-0/0/1', 'ge-0/0/2', 'ge-0/0/3']);
  const desc = load({ sortColumn: 'port', sortDir: -1 }).buildInterfaceView(DEV).rows.map(r => r.Port);
  assert.deepEqual(desc, [...asc].reverse());
});

test('inactiveForText: up has none, unknown stays Unknown rather than reading as zero', () => {
  const { inactiveForText } = load();
  assert.equal(inactiveForText({ Link: 'up' }), '-');
  assert.equal(inactiveForText({ Link: 'down' }), 'Unknown');
  assert.equal(inactiveForText({ Link: 'down', LastFlappedSeconds: null }), 'Unknown');
  assert.equal(inactiveForText({ Link: 'down', LastFlappedSeconds: 86400 }), '1d');
});

// The point of the refactor: one view, so an export can no longer disagree with the screen.
test('the CSV export and print report read the same view as the table', () => {
  const usesView = (fnName) => {
    const fn = src.match(new RegExp(`window\\.${fnName} = (?:async )?function[\\s\\S]*?\\n\\};`))[0];
    return /buildInterfaceView\(/.test(fn) && !/asArray\((?:currentSelectedNodeData|d)\.Interfaces\)/.test(fn);
  };
  assert.ok(usesView('exportInterfacesCsv'), 'CSV export must not walk the raw interface array');
  assert.ok(usesView('printDeviceReport'), 'print report must not walk the raw interface array');
});

test('the printed interfaces table carries the Inactive For column', () => {
  const fn = src.match(/window\.printDeviceReport = function[\s\S]*?\n\};/)[0];
  assert.match(fn, /'Port', 'Admin', 'Link', 'STP', 'PoE', 'Description', 'Inactive For'/);
});
