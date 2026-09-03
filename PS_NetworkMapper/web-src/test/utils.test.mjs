import { test } from 'node:test';
import assert from 'node:assert/strict';

// utils.js is a classic script (see its own header comment), not a dual-mode module like
// graph-layout.js/elk-layout.js - it assigns straight onto `window` and, at load time, calls
// window.addEventListener twice (global error/unhandledrejection reporting hooks). Shim just
// enough of `window` for that top-level code to run before importing it, mirroring the
// global.window pattern elk-layout.test.mjs already uses for the same reason.
global.window = global.window || {};
global.window.addEventListener = global.window.addEventListener || (() => {});
global.window.location = global.window.location || { href: 'http://localhost/' };

await import('../utils.js');

const parseTimestampMs = global.window.parseTimestampMs;
const esc = global.window.esc;

// Contract (see utils.js's own comment above the definition): returns a finite epoch-ms
// number for anything Date can parse, or null for anything falsy/unparseable. Never
// falsy-zero-unsafe - callers must check `=== null`/`!== null`, not a bare truthy check,
// since epoch 0 (1970-01-01T00:00:00.000Z) is itself a legitimate finite timestamp.

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
  // Every real caller passes a (possibly garbage) ISO string, never a raw number - so the
  // edge case that matters is the *return value* landing on exactly 0 ms, which callers
  // must not mistake for "unparseable". A non-empty string is truthy going in regardless
  // of what instant it names, so this exercises the `isNaN(ms) ? null : ms` return path
  // rather than the `!ts` falsy-input guard.
  assert.equal(parseTimestampMs('1970-01-01T00:00:00.000Z'), 0);
  // One millisecond after epoch is unambiguous either way - guards against an
  // implementation that only special-cases exactly 0.
  assert.equal(parseTimestampMs('1970-01-01T00:00:00.001Z'), 1);
});

// Contract (see utils.js's own comment above the definition): esc() is the single
// XSS-escaping choke point for every device-supplied string interpolated into innerHTML
// elsewhere in the app, via the HTML_ESCAPES map: & < > " '.

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
