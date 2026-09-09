import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// drawer.js is browser-only (no module.exports), so csvEscapeField is lifted out of the
// source rather than imported.
const src = fs.readFileSync(new URL('../drawer.js', import.meta.url), 'utf8');
const csvEscapeField = new Function(src.match(/function csvEscapeField[\s\S]*?\n}/)[0] + '; return csvEscapeField;')();

test('csvEscapeField neutralises a device-supplied formula prefix', () => {
  assert.equal(csvEscapeField('=1+1'), "'=1+1");
  assert.equal(csvEscapeField('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(csvEscapeField('-2+3'), "'-2+3");
  assert.equal(csvEscapeField('@import'), "'@import");
});

test('csvEscapeField leaves the exports\' lone "-" placeholder alone', () => {
  assert.equal(csvEscapeField('-'), '-');
});

test('csvEscapeField still quotes delimiters, and quotes a neutralised field too', () => {
  assert.equal(csvEscapeField('Desc, with comma'), '"Desc, with comma"');
  assert.equal(csvEscapeField('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscapeField('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
  assert.equal(csvEscapeField(null), '');
});
