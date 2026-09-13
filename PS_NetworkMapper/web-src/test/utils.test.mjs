import { test } from 'node:test';
import assert from 'node:assert/strict';

// utils.js is a classic script, not a dual-mode module: it assigns onto `window` and calls
// window.addEventListener twice at load time. Shim just enough of `window` for that top-level code
// to run before importing it, mirroring elk-layout.test.mjs.
global.window = global.window || {};
global.window.addEventListener = global.window.addEventListener || (() => {});
global.window.location = global.window.location || { href: 'http://localhost/' };

await import('../utils.js');

const parseTimestampMs = global.window.parseTimestampMs;
const esc = global.window.esc;
const asArray = global.window.asArray;

// Contract: normalizes PowerShell's single-element-array-as-bare-object quirk, and strips any
// null/undefined elements an array contains, since callers dereference elements unguarded.

test('asArray passes an array through unchanged when it has no null/undefined elements', () => {
  var input = [{ a: 1 }, { a: 2 }];
  assert.deepEqual(asArray(input), input);
});

test('asArray wraps a bare non-null value in a 1-element array', () => {
  assert.deepEqual(asArray({ a: 1 }), [{ a: 1 }]);
});

test('asArray returns [] for null/undefined', () => {
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray(undefined), []);
});

test('asArray filters out null/undefined elements from within an array', () => {
  assert.deepEqual(asArray([{ a: 1 }, null, { a: 2 }, undefined]), [{ a: 1 }, { a: 2 }]);
});

// Contract: a finite epoch-ms number for anything Date can parse, or null. Callers must check
// `=== null`, not truthiness - epoch 0 is itself a legitimate timestamp.

test('parseTimestampMs parses a valid ISO string to its correct epoch ms', () => {
  assert.equal(parseTimestampMs('2026-08-20T12:00:00.000Z'), Date.parse('2026-08-20T12:00:00.000Z'));
});

test('parseTimestampMs returns null for falsy input', () => {
  assert.equal(parseTimestampMs(''), null);
  assert.equal(parseTimestampMs(null), null);
  assert.equal(parseTimestampMs(undefined), null);
});

test('parseTimestampMs returns null for a truthy but unparseable string', () => {
  assert.equal(parseTimestampMs('not a date'), null);
  assert.equal(parseTimestampMs('Unknown'), null);
});

test('parseTimestampMs treats an epoch-zero-adjacent timestamp string as a valid finite result, not null', () => {
  // The edge case that matters is a return value of exactly 0 ms, which callers must not mistake
  // for "unparseable" - this exercises the `isNaN(ms) ? null : ms` path, not the `!ts` guard.
  assert.equal(parseTimestampMs('1970-01-01T00:00:00.000Z'), 0);
  // One millisecond after epoch guards against special-casing exactly 0.
  assert.equal(parseTimestampMs('1970-01-01T00:00:00.001Z'), 1);
});

// esc() is the single XSS-escaping choke point for device-supplied strings: & < > " '.

test('esc escapes each HTML_ESCAPES character individually', () => {
  assert.equal(esc('&'), '&amp;');
  assert.equal(esc('<'), '&lt;');
  assert.equal(esc('>'), '&gt;');
  assert.equal(esc('"'), '&quot;');
  assert.equal(esc("'"), '&#39;');
});

test('esc escapes a string exercising the full HTML_ESCAPES map together', () => {
  assert.equal(esc(`<script>alert("x" & 'y')</script>`),
    '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;');
});

test('esc leaves a string with no special characters unchanged', () => {
  assert.equal(esc('switch-01.example.com'), 'switch-01.example.com');
  assert.equal(esc(''), '');
});

// lookupVendor reads window.OUI_DATABASE at call time, so the shim can be installed after import.
global.window.OUI_DATABASE = {
  '00A021': 'General Dynamics Mission Systems',
  'A0B437': 'GD Mission Systems',
  '002689': 'General Dynamics Land Systems Inc.',
  '60C78D': 'Juniper Networks',
  '001565': 'Yealink(Xiamen) Network Technology',
  'AABBCC': 'Acme Widgets Ltd',
};
const lookupVendor = global.window.lookupVendor;
const detectEncryptorPorts = global.window.detectEncryptorPorts;
const detectAccessPointPorts = global.window.detectAccessPointPorts;

// Contract: a General Dynamics OUI is a candidate inline network encryptor, ranked ahead of the
// other vendor rules so a GD hit is never absorbed by them.

test('lookupVendor categorizes a General Dynamics Mission Systems OUI as Crypto/INE', () => {
  assert.deepEqual(lookupVendor('00:a0:21:11:22:33'),
    { vendor: 'General Dynamics Mission Systems', category: 'Crypto/INE' });
  assert.equal(lookupVendor('a0-b4-37-11-22-33').category, 'Crypto/INE');
});

test('lookupVendor categorizes other General Dynamics divisions as Crypto/INE too', () => {
  // Deliberate: the flag says "confirm this port", and a GD Land Systems box on a switch port is
  // itself worth a look. Narrowing to Mission Systems would silently drop legacy TACLANE OUIs.
  assert.equal(lookupVendor('00:26:89:11:22:33').category, 'Crypto/INE');
});

test('lookupVendor leaves the existing categories unchanged', () => {
  assert.equal(lookupVendor('60:c7:8d:11:22:33').category, 'Network-Infra');
  assert.equal(lookupVendor('00:15:65:11:22:33').category, 'Phone');
  assert.equal(lookupVendor('aa:bb:cc:11:22:33').category, 'Other');
  assert.equal(lookupVendor('de:ad:be:11:22:33').category, 'Unknown');
});

test('detectEncryptorPorts keys the ports whose learned MACs carry a GD OUI', () => {
  var device = { TrueClients: [
    { MAC: '00:a0:21:11:22:33', Port: 'ge-0/0/5.0' },
    { MAC: '60:c7:8d:11:22:33', Port: 'ge-0/0/6.0' },
    { MAC: 'a0:b4:37:44:55:66', Port: 'ge-0/0/5.0' },
  ] };
  var result = detectEncryptorPorts(device);
  assert.deepEqual([...result.keys()], ['ge-0/0/5']);
  assert.equal(result.get('ge-0/0/5').length, 2);
});

test('detectEncryptorPorts returns an empty map when nothing matches', () => {
  assert.equal(detectEncryptorPorts({ TrueClients: [{ MAC: '60:c7:8d:11:22:33', Port: 'ge-0/0/1.0' }] }).size, 0);
  assert.equal(detectEncryptorPorts({}).size, 0);
});

// Contract: an AP is identified by what it advertised over LLDP-MED, not by its OUI - MedNeighbors
// carries phones as well, and the vendors that build APs also build switches.

test('detectAccessPointPorts keys ports whose MED neighbour describes an access point', () => {
  var device = { MedNeighbors: [
    { LocalPort: 'ge-0/0/9.0', Description: 'ArubaOS (MODEL: AP-515), Version 8.10.0.4', Hostname: 'ap-lib-03' },
    { LocalPort: 'ge-0/0/10.0', Description: 'Yealink SIP-T46S 66.85.0.5', Hostname: 'phone-221' },
    { LocalPort: 'ge-0/0/11.0', Description: 'Cisco Aironet 2802I Access Point', Hostname: 'ap-lib-04' },
  ] };
  var result = detectAccessPointPorts(device);
  assert.deepEqual([...result.keys()], ['ge-0/0/9', 'ge-0/0/11']);
});

test('detectAccessPointPorts ignores a MED neighbour with no usable description', () => {
  assert.equal(detectAccessPointPorts({ MedNeighbors: [{ LocalPort: 'ge-0/0/1.0', Description: 'Unknown' }] }).size, 0);
  assert.equal(detectAccessPointPorts({}).size, 0);
});

test('detectAccessPointPorts does not match an Aruba CX switch neighbour', () => {
  var device = { MedNeighbors: [
    { LocalPort: 'ge-0/0/1.0', Description: 'ArubaOS-CX GL_10_08_1010', Hostname: 'sw-idf-02' },
    { LocalPort: 'ge-0/0/2.0', Description: 'ArubaOS (MODEL: AP-515), Version 8.10.0.4', Hostname: 'ap-lib-03' },
  ] };
  assert.deepEqual([...detectAccessPointPorts(device).keys()], ['ge-0/0/2']);
});

// Regression: an AP bridges every wireless client through one port, and advertises over LLDP-MED
// exactly as a phone does, so without the AP check each one reported a confirmed phone daisy-chain.
test('detectDaisyChains does not report an access-point port as a daisy chain', () => {
  var device = {
    MedNeighbors: [{ LocalPort: 'ge-0/0/9.0', Description: 'Wireless Access Point', Hostname: 'AP-1139' }],
    TrueClients: [
      { MAC: 'aa:bb:01:00:00:01', Port: 'ge-0/0/9.0', VLAN_Tag: '20' },
      { MAC: 'aa:bb:01:00:00:02', Port: 'ge-0/0/9.0', VLAN_Tag: '30' },
      { MAC: 'aa:bb:01:00:00:03', Port: 'ge-0/0/9.0', VLAN_Tag: '30' },
    ],
  };
  assert.equal(global.window.detectDaisyChains(device).size, 0);
});

test('detectDaisyChains still reports a phone port as a confirmed chain', () => {
  var device = {
    MedNeighbors: [{ LocalPort: 'ge-0/0/10.0', Description: 'Yealink SIP-T46S 66.85.0.5', Hostname: 'phone-221' }],
    TrueClients: [
      { MAC: 'aa:bb:02:00:00:01', Port: 'ge-0/0/10.0', VLAN_Tag: '20' },
      { MAC: 'aa:bb:02:00:00:02', Port: 'ge-0/0/10.0', VLAN_Tag: '30' },
    ],
  };
  assert.equal(global.window.detectDaisyChains(device).get('ge-0/0/10').confidence, 'confirmed');
});

const formatVlanTag = global.window.formatVlanTag;
const scanStatusMeaning = global.window.scanStatusMeaning;

// C4. Clients[].VLAN_Tag is an int or null now, matching Vlans[].Tag. Three display sites rendered it
// straight, so null would read as the literal "null" to an operator.
test('formatVlanTag renders a numeric tag as its digits', () => {
  assert.equal(formatVlanTag(100), '100');
});

test('formatVlanTag renders an absent tag as Unknown rather than "null"', () => {
  assert.equal(formatVlanTag(null), 'Unknown');
  assert.equal(formatVlanTag(undefined), 'Unknown');
});

// A snapshot written before C4 carries the string, and it still has to render as itself.
test('formatVlanTag passes a pre-C4 string tag through, and maps its "Unknown" to Unknown', () => {
  assert.equal(formatVlanTag('110'), '110');
  assert.equal(formatVlanTag('Unknown'), 'Unknown');
});

test('formatVlanTag does not mistake tag 0 for an absent tag', () => {
  assert.equal(formatVlanTag(0), '0');
});

// C6. AuthFailed is the one failure that is positive evidence about the device: sshd answered.
test('scanStatusMeaning frames AuthFailed as the device being reachable', () => {
  assert.match(scanStatusMeaning('AuthFailed'), /reachable/);
});

// C1. Each of the four says something different about WHERE the fault is, which is why they were split.
test('scanStatusMeaning distinguishes all four C1 classes', () => {
  const four = ['Refused', 'NoRoute', 'DnsFailed', 'Timeout'].map(scanStatusMeaning);
  assert.ok(four.every(Boolean), 'every C1 class needs a meaning');
  assert.equal(new Set(four).size, 4, 'two classes share wording, so the split says nothing to a reader');
  assert.match(scanStatusMeaning('NoRoute'), /scan host/i, 'NoRoute is a fault on the scan host, not the target');
});

test('scanStatusMeaning still explains the pre-C1 Unreachable an old snapshot carries', () => {
  assert.match(scanStatusMeaning('Unreachable'), /Refused/);
});

test('scanStatusMeaning returns null for Ok and for an unknown status, so callers can omit it', () => {
  assert.equal(scanStatusMeaning('Ok'), null);
  assert.equal(scanStatusMeaning('SomethingNew'), null);
});
