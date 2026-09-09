import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// map.js is browser-only and Leaflet-bound, so the marker-icon decision and the selection
// updater are lifted out and run against a stub L/marker. What matters here is which colour a
// marker ends up with and that changing selection repaints only the two markers involved -
// a full renderMapMarkers would drop any in-progress "Edit position" arming.
const src = fs.readFileSync(new URL('../map.js', import.meta.url), 'utf8');

function load() {
  const icons = [];
  const L = { divIcon: (opts) => { icons.push(opts); return opts; } };
  const markers = new Map();
  const mkMarker = (ip, meta, dimmedByVlan) => {
    const m = { ip, _iconState: { meta, dimmedByVlan }, icon: null, setIconCalls: 0 };
    m.setIcon = (icon) => { m.icon = icon; m.setIconCalls++; };
    markers.set(ip, m);
    return m;
  };
  const pick = (re) => src.match(re)[0];
  const body = [
    pick(/var MARKER_COLORS = \{[\s\S]*?\n\};/),
    pick(/var selectedMapIp = null;/),
    pick(/function iconForClassification\(meta, dimmedByVlan, selected\)[\s\S]*?\n\}/),
    pick(/window\.updateMapSelection = function[\s\S]*?\n\};/),
    'return { iconForClassification: iconForClassification, updateMapSelection: window.updateMapSelection, MARKER_COLORS: MARKER_COLORS };',
  ].join('\n');
  const api = new Function('L', 'mapMarkersByIp', 'window', body)(L, markers, {});
  return { ...api, markers, mkMarker };
}

const bgOf = (icon) => icon.html.match(/background:([^;]+);/)[1];
const SCANNED = { scanned: true, isStack: false, hostname: 'sw1' };

test('a selected marker is green', () => {
  const { iconForClassification, MARKER_COLORS } = load();
  assert.equal(bgOf(iconForClassification(SCANNED, false, true)), MARKER_COLORS.selected.background);
  assert.notEqual(bgOf(iconForClassification(SCANNED, false, false)), MARKER_COLORS.selected.background);
});

test('selection outranks the VLAN dim, the stack shape and the unscanned grey', () => {
  const { iconForClassification, MARKER_COLORS } = load();
  const green = MARKER_COLORS.selected.background;
  assert.equal(bgOf(iconForClassification(SCANNED, true, true)), green, 'dimmed but selected');
  assert.equal(bgOf(iconForClassification({ scanned: true, isStack: true }, false, true)), green, 'stack but selected');
  assert.equal(bgOf(iconForClassification({ scanned: false, isStack: false }, false, true)), green, 'unscanned but selected');
});

test('unselected markers keep their existing classification colours', () => {
  const { iconForClassification, MARKER_COLORS } = load();
  assert.equal(bgOf(iconForClassification(SCANNED, false, false)), MARKER_COLORS.scanned.background);
  assert.equal(bgOf(iconForClassification(SCANNED, true, false)), MARKER_COLORS.vlanDimmed.background);
  assert.equal(bgOf(iconForClassification({ scanned: true, isStack: true }, false, false)), MARKER_COLORS.scannedStack.background);
  assert.equal(bgOf(iconForClassification({ scanned: false }, false, false)), MARKER_COLORS.unscanned.background);
});

test('changing selection repaints only the two markers involved', () => {
  const { updateMapSelection, mkMarker, markers, MARKER_COLORS } = load();
  const a = mkMarker('10.0.0.1', SCANNED, false);
  const b = mkMarker('10.0.0.2', SCANNED, false);
  const untouched = mkMarker('10.0.0.3', SCANNED, false);

  updateMapSelection('10.0.0.1');
  assert.equal(bgOf(a.icon), MARKER_COLORS.selected.background);

  updateMapSelection('10.0.0.2');
  assert.equal(bgOf(b.icon), MARKER_COLORS.selected.background);
  assert.equal(bgOf(a.icon), MARKER_COLORS.scanned.background, 'the previous selection reverts');
  assert.equal(untouched.setIconCalls, 0, 'every other marker is left alone');
  assert.equal(markers.size, 3);
});

test('closing the drawer clears the highlight, and re-selecting the same device is a no-op', () => {
  const { updateMapSelection, mkMarker, MARKER_COLORS } = load();
  const a = mkMarker('10.0.0.1', SCANNED, false);

  updateMapSelection('10.0.0.1');
  const calls = a.setIconCalls;
  updateMapSelection('10.0.0.1');
  assert.equal(a.setIconCalls, calls, 'no repaint when nothing changed');

  updateMapSelection(null);
  assert.equal(bgOf(a.icon), MARKER_COLORS.scanned.background);
});

test('selecting a device whose marker is not on the map is still remembered', () => {
  // The Map view may never have been opened; the first renderMapMarkers must paint it green.
  const { updateMapSelection, mkMarker, MARKER_COLORS } = load();
  updateMapSelection('10.9.9.9');
  const late = mkMarker('10.9.9.9', SCANNED, false);
  updateMapSelection('10.9.9.9'); // no-op, already selected
  assert.equal(late.setIconCalls, 0);
  assert.ok(src.includes('iconForClassification(meta, dimmedByVlan, ip === selectedMapIp)'),
    'renderMapMarkers must build each icon against the tracked selection');
  assert.ok(MARKER_COLORS.selected);
});
