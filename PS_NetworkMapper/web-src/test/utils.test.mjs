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
