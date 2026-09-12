import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// map.js is Leaflet-bound, so the marker-icon decision and the selection updater are lifted out and
// run against a stub L/marker: which colour a marker gets, and that only two markers repaint.
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

// ---- the diagram and the Map must agree on which device is open ----

const graphSrc = fs.readFileSync(new URL('../graph.js', import.meta.url), 'utf8');
const drawerSrc = fs.readFileSync(new URL('../drawer.js', import.meta.url), 'utf8');
const indexSrc = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the diagram paints the selected node the same green as the map marker', () => {
  const { MARKER_COLORS } = load();
  const opts = graphSrc.match(/nodes: \{ color: \{ highlight: \{[^}]*\} \} \}/)[0];
  assert.match(opts, new RegExp(`background: '${MARKER_COLORS.selected.background}'`));
  assert.match(opts, new RegExp(`border: '${MARKER_COLORS.selected.border}'`));
});

test('the highlight is declared globally so a colour rewrite cannot drop it', () => {
  // Both replace a node's whole colour object; vis falls back to the network-level highlight.
  const perNode = [...graphSrc.matchAll(/color: (node\.isStack \?|meta\.(?:isStack|scanned) \?|\{ background: '#(?:97C2FC|D2E5FF|E8E8E8|f2f2f2)')/g)];
  assert.ok(perNode.length > 0, 'the per-node colour sites should still exist');
  for (const m of perNode) {
    const tail = graphSrc.slice(m.index, m.index + 260);
    assert.ok(!/highlight/.test(tail.split('\n')[0]), 'device nodes must not carry their own highlight');
  }
});

test('a cluster placeholder keeps its own colour when selected', () => {
  const cluster = graphSrc.match(/color: \{ background: '#fdf6e3'[^\n]*/)[0];
  assert.match(cluster, /highlight: \{ background: '#fdf6e3', border: '#d9b34e' \}/);
});

test('opening the drawer from anywhere selects the diagram node too', () => {
  const fn = drawerSrc.match(/window\.openRightDrawer = function[\s\S]*?\n\};/)[0];
  assert.match(fn, /network\.selectNodes\(\[String\(ip\)\]\)/);
  assert.match(fn, /nodesDataset\.get\(String\(ip\)\)/, 'guarded: a node inside a collapsed cluster does not exist');
});

test('a focused port does not draw the UA focus ring over the panel art', () => {
  // Every port carries tabindex; the default ring is a ~3px band around a ~12px jack.
  assert.match(indexSrc, /svg\.chassis-svg \.port-el:focus \{ outline: none; \}/);
  assert.match(indexSrc, /\.port-el:focus-visible \.port-body[^\n]*stroke-width: \.7;/);
});

/* ---- marker labels ----
   Hostname labels are permanent Leaflet tooltips and bury a campus-sized fleet at the initial fit's
   zoom. They are gated by a class on the map container, the only checkable part without a browser. */

test('marker labels are hidden below a zoom threshold', () => {
  assert.match(src, /var LABEL_MIN_ZOOM = \d+;/);
  const fn = src.match(/function applyLabelVisibility\(\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /getZoom\(\) < LABEL_MIN_ZOOM/);
  assert.match(fn, /classList\.toggle\('hide-marker-labels'/);
  // Without the CSS rule the class is inert, and the JS alone would look correct.
  assert.match(indexSrc, /\.hide-marker-labels \.map-marker-label \{ display: none; \}/);
});

test('label visibility is re-evaluated on zoom and after a re-render', () => {
  assert.match(src, /leafletMap\.on\('zoomend', applyLabelVisibility\)/);
  // Both the zoom and the marker count decide it, and fitBounds runs inside renderMapMarkers.
  const render = src.match(/window\.renderMapMarkers = function[\s\S]*?\n\};/)[0];
  assert.match(render, /applyLabelVisibility\(\)/);
});

test('a handful of markers keep their labels at every zoom', () => {
  // The problem is density, not zoom: a few markers never overlap.
  assert.match(src, /var LABEL_ALWAYS_BELOW = \d+;/);
  assert.match(src, /mapMarkersByIp\.size >= LABEL_ALWAYS_BELOW/);
});

const num = (re) => Number(src.match(re)[1]);

test('the map zooms past the last real OSM tile', () => {
  // Leaflet upscales beyond maxNativeZoom; without it every tile past 19 would 404.
  const maxZoom = num(/var MAX_MAP_ZOOM = (\d+);/);
  const native = num(/maxNativeZoom: (\d+),/);
  assert.equal(native, 19, "OSM's last served zoom level");
  assert.ok(maxZoom > native, `maxZoom ${maxZoom} must exceed maxNativeZoom ${native}`);
  assert.match(src, /maxZoom: MAX_MAP_ZOOM,/);
});

test('labels become reachable before the map runs out of zoom', () => {
  const maxZoom = num(/var MAX_MAP_ZOOM = (\d+);/);
  const labelZoom = num(/var LABEL_MIN_ZOOM = (\d+);/);
  assert.ok(labelZoom <= maxZoom, `labels at ${labelZoom} are unreachable below maxZoom ${maxZoom}`);
});

test('revealing a device zooms in far enough to show its name', () => {
  // Revealing a marker with its label suppressed would look like a jump to an unnamed dot.
  const fn = src.match(/window\.revealDeviceOnMap = function[\s\S]*?\n\};/)[0];
  assert.match(fn, /Math\.max\(leafletMap\.getZoom\(\), LABEL_MIN_ZOOM\)/);
});
