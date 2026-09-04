// Front-panel drawing for the device drawer's Interfaces tab: one SVG per stack member,
// drawn in millimetres from Juniper's own front-view photos, with two LED lenses per port
// bound to that port's Interfaces row (left = link, right = recent activity). Two-tone line
// art only - fills/strokes come from --chassis-bg/--chassis-fg so it inverts with the theme.
//
// Three parameterised families cover every Juniper fixed-config switch style; a model is a
// MODELS entry that picks a family and passes measured positions. A model string the
// catalogue doesn't know is first normalised (case, T/P/MP suffix, -AFI/-DC style trailers)
// and, failing that, drawn generically from the interface names it actually reports, so a
// new SKU still gets a usable panel instead of nothing. Modular chassis (EX9200, QFX10000,
// MX) have vertical line cards and no meaningful 1U front - they render a one-line note.
//
// Dual-mode like graph-layout.js: node:test imports the pure string builders through
// module.exports; the browser loads it as a classic <script> and gets window.Chassis plus the
// DOM-facing window.renderChassisView / window.highlightChassisPort used by drawer.js.

(function () {
'use strict';

var RACK_W = 482.6, RACK_H = 44.45, EAR_W = 20.3, BODY_W = 442, B = EAR_W;
var f = function (v) { return (+v).toFixed(2); };
var pn = function (prefix, fpc, pic, n) { return prefix + '-' + fpc + '/' + pic + '/' + n; };
var JACK = { w: 12.5, open: 6.6, strip: 3.7, nO: 4.4, nI: 6.6, dO: 2.0, win: { w: 2.5, h: 2.9 } };
var ROWBAR = 4.5, JACK_H = JACK.strip + JACK.open;

var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/[&<>"']/g, function (c) { return HTML_ESCAPES[c]; });
}

/* ---------- primitives ---------- */
function svgOpen(uid, vbW, vbH) {
    var hexes = [[2.3, 2], [0, 6], [4.6, 6]].map(function (c) {
        var pts = [0, 1, 2, 3, 4, 5].map(function (k) { var a = Math.PI / 3 * k + Math.PI / 6; return f(c[0] + 1.35 * Math.cos(a)) + ',' + f(c[1] + 1.35 * Math.sin(a)); }).join(' ');
        return '<polygon class="vent-hex" points="' + pts + '"/>';
    }).join('');
    return '<svg viewBox="0 0 ' + f(vbW) + ' ' + f(vbH) + '" xmlns="http://www.w3.org/2000/svg" class="chassis-svg" style="width:' + f(vbW / RACK_W * 100) + '%" data-unit="' + uid + '">' +
        '<defs>' +
        '<filter id="ledGlow-' + uid + '" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation=".7"></feGaussianBlur></filter>' +
        '<pattern id="hex-' + uid + '" width="4.6" height="8.0" patternUnits="userSpaceOnUse">' + hexes + '</pattern>' +
        '<pattern id="holes-' + uid + '" width="4.4" height="4.4" patternUnits="userSpaceOnUse"><circle class="vent-hole" cx="2.2" cy="2.2" r="1.15"/></pattern>' +
        '</defs>';
}
function rackEars() {
    var ear = function (tx) {
        return '<g transform="translate(' + tx + ',0)">' +
            '<rect class="chassis-ear" x=".25" y=".25" width="' + (EAR_W - .5) + '" height="' + (RACK_H - .5) + '" rx=".8"></rect>' +
            '<rect class="ear-slot" x="7.4" y="6" width="5.5" height="9.5" rx="2.6"></rect>' +
            '<rect class="ear-slot" x="7.4" y="29" width="5.5" height="9.5" rx="2.6"></rect></g>';
    };
    return ear(0) + ear(RACK_W - EAR_W);
}
var rackBody = function () { return '<rect class="chassis-body" x="' + f(B) + '" y=".4" width="' + BODY_W + '" height="' + f(RACK_H - .8) + '" rx=".8"></rect>'; };
function wordmark(x, y, opts) {
    opts = opts || {};
    return '<g class="brand" transform="translate(' + f(x) + ',' + f(y) + ')">' +
        '<text class="wordmark" x="0" y="0">Juniper</text>' +
        '<text class="wordmark-sub" x="8.6" y="1.9">' + (opts.mist ? 'driven by Mist AI' : 'NETWORKS') + '</text>' +
        (opts.model ? '<text class="model-text' + (opts.big ? ' big' : '') + '" x="' + f(opts.modelX == null ? 0 : opts.modelX) + '" y="' + f(opts.modelY == null ? 5.2 : opts.modelY) + '">' + escHtml(opts.model) + '</text>' : '') + '</g>';
}
var junosMark = function (x, y) { return '<g transform="translate(' + f(x) + ',' + f(y) + ')"><circle cx="1.8" cy="-1.2" r="1.6" fill="var(--chassis-fg)"></circle><text class="junos-sub" x="4.2" y="-2.2">RUNNING</text><text class="junos-text" x="4.2" y="0.4">JUNOS</text></g>'; };
// Current unit while drawing - the glow filter id is per-SVG so two stacked members never
// share a <defs> reference that only the first SVG in the document defines.
var curUid = 'u';
function lens(x, y, w, h, key, role) {
    var bind = key ? ' data-lightfor="' + escHtml(key) + '" data-role="' + role + '"' : '';
    return '<g class="light-glyph"' + bind + ' transform="translate(' + f(x) + ',' + f(y) + ')">' +
        '<rect class="light-glow" x="' + f(-w * .5) + '" y="' + f(-h * .5) + '" width="' + f(w * 2) + '" height="' + f(h * 2) + '" rx=".6" filter="url(#ledGlow-' + curUid + ')"></rect>' +
        '<rect class="light-base" x="0" y="0" width="' + f(w) + '" height="' + f(h) + '" rx=".25"></rect>' +
        '<rect class="light-core" x=".35" y=".35" width="' + f(w - .7) + '" height="' + f(h - .7) + '" rx=".15"></rect></g>';
}
function dot(cx, cy, r, key, role, state) {
    var bind = key ? ' data-lightfor="' + escHtml(key) + '" data-role="' + role + '"' : '';
    return '<g class="light-glyph' + (state ? ' ' + state : '') + '"' + bind + ' transform="translate(' + f(cx) + ',' + f(cy) + ')">' +
        '<circle class="light-glow" cx="0" cy="0" r="' + f(r * 2.2) + '" filter="url(#ledGlow-' + curUid + ')"></circle>' +
        '<circle class="light-base" cx="0" cy="0" r="' + f(r) + '"></circle>' +
        '<circle class="light-core" cx="0" cy="0" r="' + f(r * .55) + '"></circle></g>';
}
// Port groups carry data-port (the bare Junos interface name) for click selection, plus a
// <title> tooltip when the unit knows the interface; ports the artwork has but the device
// didn't report get .port-absent so they read as physically present but not in the data.
function portBind(unit, key, kind) {
    if (!key) return '';
    var known = unit && unit.hasPort ? unit.hasPort(key) : true;
    return ' class="port-el' + (known ? '' : ' port-absent') + '" data-port="' + escHtml(key) + '" data-kind="' + kind + '"';
}
// Tooltip detail (state and description) as a data attribute; the browser side pairs it with
// data-port in a custom hover tooltip (window.renderChassisView) - the native SVG <title>
// tooltip was too slow to appear and too easy to miss on a 10px jack.
function portTitle(unit, key) {
    var t = key && unit && unit.title ? unit.title(key) : '';
    return t ? ' data-tip="' + escHtml(t) + '"' : '';
}
function rj45(x, y, g, key, id, opts, unit) {
    opts = opts || {};
    var w = g.w, s = g.strip, o = g.open, H = s + o, cx = w / 2, nO = g.nO / 2, nI = g.nI / 2, dO = g.dO;
    var hole = 'M0,' + f(s) + ' H' + f(cx - nI) + ' V' + f(dO) + ' H' + f(cx - nO) + ' V0 H' + f(cx + nO) + ' V' + f(dO) + ' H' + f(cx + nI) + ' V' + f(s) + ' H' + f(w) + ' V' + f(H) + ' H0 Z';
    var contacts = '';
    for (var i = 0; i < 8; i++) { var px = cx - 2.8 + i * 0.8; contacts += '<line class="port-contacts" x1="' + f(px) + '" y1="' + f(s + .6) + '" x2="' + f(px) + '" y2="' + f(s + 2.2) + '"></line>'; }
    var lenses = '';
    if (g.win) {
        var ly = s - g.win.h - .15;
        lenses = opts.static ? lens(.15, ly, g.win.w, g.win.h) + lens(w - g.win.w - .15, ly, g.win.w, g.win.h)
            : lens(.15, ly, g.win.w, g.win.h, key, 'link') + lens(w - g.win.w - .15, ly, g.win.w, g.win.h, key, 'act');
    }
    var xf = opts.flip ? 'translate(' + f(x) + ',' + f(y + H) + ') scale(1,-1)' : 'translate(' + f(x) + ',' + f(y) + ')';
    var bind = opts.static ? '' : ' id="port_' + id + '"' + portBind(unit, key, 'access');
    return '<g' + bind + (opts.static ? '' : portTitle(unit, key)) + ' transform="' + xf + '"><path class="' + (opts.static ? 'port-static' : 'port-body') + '" d="' + hole + '"></path>' + contacts + lenses + '</g>';
}
/* 2-row ganged RJ45 block, top row even / bottom row odd */
function rj45Block(x, y, cols, pitch, firstN, unit, opts) {
    opts = opts || {};
    var g = JACK, H = JACK_H, pic = opts.pic || 0;
    // opts.prefix is usually a fixed string, but inferModel() passes a per-port function so a
    // mixed mge/ge block (mgig ports that don't fall on a 12-port boundary) names each jack
    // from its own actual interface, not the whole block's.
    var prefixOf = typeof opts.prefix === 'function' ? opts.prefix : function () { return opts.prefix || 'ge'; };
    var out = '';
    for (var c = 0; c < cols; c++) {
        var jx = x + c * pitch, nT = firstN + 2 * c, nB = nT + 1;
        out += rj45(jx, y, g, unit.key(pn(prefixOf(nT), unit.fpc, pic, nT)), unit.id + '_' + pic + '_' + nT, {}, unit)
            + rj45(jx, y + H + ROWBAR, g, unit.key(pn(prefixOf(nB), unit.fpc, pic, nB)), unit.id + '_' + pic + '_' + nB, { flip: true }, unit);
        if (opts.labelsY) out += '<text class="port-num" x="' + f(jx + g.w / 2 - 1.2) + '" y="' + f(opts.labelsY) + '" text-anchor="end">' + nT + '</text><text class="port-num odd" x="' + f(jx + g.w / 2 + .3) + '" y="' + f(opts.labelsY + .5) + '">' + nB + '</text>';
    }
    var x1 = x + (cols - 1) * pitch + g.w;
    return '<rect class="block-frame' + (opts.solid ? ' solid' : '') + (opts.mgig ? ' mgig' : '') + '" x="' + f(x - 1.1) + '" y="' + f(y - .8) + '" width="' + f(x1 - x + 2.2) + '" height="' + f(2 * H + ROWBAR + 1.6) + '" rx=".4"></rect>' + out;
}
function sfpCage(x, y, w, h, key, id, opts, unit) {
    opts = opts || {};
    var bail = '<rect class="uplink-bail" x="' + f(w / 2 - 2.2) + '" y="' + f(opts.bailTop ? .35 : h - 1.4) + '" width="4.4" height="1.05" rx=".3"></rect>';
    var inner = '<rect class="uplink-inner" x="1.1" y="1.1" width="' + f(w - 2.2) + '" height="' + f(h - 2.2) + '" rx=".6"></rect>';
    if (!key) return '<g transform="translate(' + f(x) + ',' + f(y) + ')"><rect class="uplink-static" x="0" y="0" width="' + f(w) + '" height="' + f(h) + '" rx="1.2"></rect>' + inner + bail + '</g>';
    return '<g id="uplink_' + id + '"' + portBind(unit, key, opts.kind || 'uplink') + portTitle(unit, key) + ' transform="translate(' + f(x) + ',' + f(y) + ')">' +
        '<rect class="uplink-body" x="0" y="0" width="' + f(w) + '" height="' + f(h) + '" rx="1.2"></rect>' + inner + bail + '</g>';
}
/* lens pair + number under/over a cage: 'lens' = rectangular windows, 'dots' = round holes */
function cageLabel(cx, y, key, n, style) {
    if (style === 'dots') return dot(cx - 4.4, y + .7, .8, key, 'link') + dot(cx + 4.4, y + .7, .8, key, 'act') + '<text class="port-num" x="' + f(cx) + '" y="' + f(y + 1.4) + '" text-anchor="middle">' + n + '</text>';
    return lens(cx - 4.6, y, 1.9, 1.5, key, 'link') + lens(cx + 2.7, y, 1.9, 1.5, key, 'act') + '<text class="port-num" x="' + f(cx) + '" y="' + f(y + 1.5) + '" text-anchor="middle">' + n + '</text>';
}
/* one column of two stacked cages (top even nT, bottom odd nB) with labels above and below */
function cageColumn(x, yT, yB, w, h, unit, prefix, pic, nT, nB, style, kind) {
    var kT = unit.key(pn(prefix, unit.fpc, pic, nT)), kB = unit.key(pn(prefix, unit.fpc, pic, nB));
    var s = sfpCage(x, yT, w, h, kT, unit.id + '_' + pic + '_' + nT, { kind: kind }, unit) + sfpCage(x, yB, w, h, kB, unit.id + '_' + pic + '_' + nB, { bailTop: true, kind: kind }, unit);
    if (style === 'dots') { s += cageLabel(x + w / 2, yT - 3.2, kT, nT, 'dots') + cageLabel(x + w / 2, yB + h + .8, kB, nB, 'dots'); }
    else if (style === 'arrows') {
        var y = yB + h + 1.2, cx = x + w / 2;
        s += lens(cx - 5.4, y, 1.6, 1.3, kT, 'link') + lens(cx - 3.6, y, 1.6, 1.3, kT, 'act')
            + '<text class="port-num" x="' + f(cx) + '" y="' + f(y + 1.3) + '" text-anchor="middle">' + nT + '▴ ▾' + nB + '</text>'
            + lens(cx + 2.0, y, 1.6, 1.3, kB, 'link') + lens(cx + 3.8, y, 1.6, 1.3, kB, 'act');
    }
    return s;
}
var ventHex = function (uid, x, y, w, h) { return '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) + '" fill="url(#hex-' + uid + ')"></rect>'; };
var ventHoles = function (uid, x, y, w, h) { return '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) + '" fill="url(#holes-' + uid + ')"></rect>'; };
function ventSlots(x0, x1, y, h) { var s = ''; for (var x = x0; x + 5.0 <= x1; x += 7.9) s += '<rect class="vent-slot" x="' + f(x) + '" y="' + f(y) + '" width="5.0" height="' + f(h) + '" rx=".6"></rect>'; return s; }
var screw = function (cx, cy, r) { return '<circle class="screw" cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(r) + '"></circle><line class="screw-x" x1="' + f(cx - r * .6) + '" y1="' + f(cy - r * .6) + '" x2="' + f(cx + r * .6) + '" y2="' + f(cy + r * .6) + '"></line><line class="screw-x" x1="' + f(cx + r * .6) + '" y1="' + f(cy - r * .6) + '" x2="' + f(cx - r * .6) + '" y2="' + f(cy + r * .6) + '"></line>'; };
var cornerMarks = function (x, y, w, h) { return '<path class="corner-mark" d="M' + f(x) + ',' + f(y + 2.2) + ' V' + f(y) + ' H' + f(x + 2.2) + ' M' + f(x + w - 2.2) + ',' + f(y + h) + ' H' + f(x + w) + ' V' + f(y + h - 2.2) + '"></path>'; };
var usbA = function (x, y, w, h) { return '<g transform="translate(' + f(x) + ',' + f(y) + ')"><rect class="usb-port" x="0" y="0" width="' + f(w) + '" height="' + f(h) + '" rx=".5"></rect><rect class="usb-inner" x="' + f(w * .25) + '" y="' + f(h * .15) + '" width="' + f(w * .5) + '" height="' + f(h * .7) + '" rx=".2"></rect></g>'; };
var usbSmall = function (x, y, w, h) { return '<rect class="usb-port" x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) + '" rx="' + f(h / 2) + '"></rect><rect class="usb-inner" x="' + f(x + w * .22) + '" y="' + f(y + h * .3) + '" width="' + f(w * .56) + '" height="' + f(h * .4) + '" rx=".3"></rect>'; };
var label = function (x, y, text, anchor) { return '<text class="tiny-label" x="' + f(x) + '" y="' + f(y) + '"' + (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + escHtml(text) + '</text>'; };
var menuButton = function (cx, cy, r) { return '<circle class="btn" cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(r) + '"></circle><path class="btn-glyph" d="M' + f(cx + r + 1.2) + ',' + f(cy - 1) + ' h3 M' + f(cx + r + 1.2) + ',' + f(cy) + ' h3 M' + f(cx + r + 1.2) + ',' + f(cy + 1) + ' h3"></path>'; };
var esdMark = function (x, y) { return '<path class="corner-mark" d="M' + f(x) + ',' + f(y + 4.4) + ' l2.6,-4.4 l2.6,4.4 z M' + f(x + 2.6) + ',' + f(y) + ' v-1.6"></path>'; };
var warnTri = function (x, y) { return '<path class="warn" d="M' + f(x) + ',' + f(y + 5) + ' l3,-5.2 l3,5.2 z M' + f(x + 3) + ',' + f(y + 1.6) + ' v2 M' + f(x + 3) + ',' + f(y + 4.3) + ' v.5"></path>'; };
// ALM is the one LED here that means trouble when lit, not normal operation - red, not green.
var ledColor = function (label) { return label === 'ALM' ? 'red' : 'green'; };
function statusCluster(x, y, rows, lit, rowPitch, opts) {
    opts = opts || {};
    var s = '';
    rows.forEach(function (r, i) {
        var cy = y + i * rowPitch;
        if (r[0]) s += dot(x, cy, .95, null, null, lit[r[0]] ? ledColor(r[0]) : null) + label(x - 1.8, cy + .6, r[0], 'end');
        if (r[1]) s += dot(x + 6.5, cy, .95, null, null, lit[r[1]] ? ledColor(r[1]) : null) + label(x + 8.3, cy + .6, r[1]);
    });
    if (opts.bracket) s += '<path class="bracket" d="M' + f(x + 3.2) + ',' + f(y - 2.6) + ' h1.4 v' + f((rows.length - 1) * rowPitch + 5) + ' h-1.4"></path>';
    return s;
}
/* static RJ45 pair for MGMT/CON on a rack unit */
function mgmtConPair(x, y, uid) {
    var G = { w: 12.5, open: 6.2, strip: 3.4, nO: 4.4, nI: 6.6, dO: 1.8, win: { w: 2.4, h: 2.6 } };
    return rj45(x, y, G, null, uid + '_mgmt', { static: true }) + label(x + G.w / 2, y - 1.2, 'MGMT', 'middle')
        + rj45(x, y + 13.4, G, null, uid + '_con', { static: true, flip: true }) + label(x + G.w / 2, y + 26.6, 'CON', 'middle');
}
/* removable module bay (uplink / expansion): frame, two thumbscrews, contents drawn by caller */
function moduleBay(x, y, w, h, inner, name) {
    return '<rect class="bay" x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) + '" rx=".8"></rect>' +
        screw(x + 3, y + 3, 1.4) + screw(x + w - 3, y + 3, 1.4) +
        '<rect class="handle" x="' + f(x + 1) + '" y="' + f(y + h * .45) + '" width="1.6" height="' + f(h * .4) + '" rx=".5"></rect>' +
        '<rect class="handle" x="' + f(x + w - 2.6) + '" y="' + f(y + h * .45) + '" width="1.6" height="' + f(h * .4) + '" rx=".5"></rect>' +
        inner + (name ? label(x + w / 2, y + h - .8, name, 'middle') : '');
}

/* ---------- right-hand sections shared by the RJ45 rack family ---------- */
var RIGHT = {
    /* EX2200/2300/3300/3400: model text, RUNNING JUNOS, status+mode LEDs with bracket, hex patch,
       4x SFP(+) in a row (lens+number under each), menu button, mini-USB console. */
    ex2300: function (u, s) {
        var ux = B + 365.4;
        var sfps = '';
        for (var i = 0; i < 4; i++) { var cx0 = ux + i * 14.35, key = u.key(pn(s.upPrefix || 'xe', u.fpc, 1, i)); sfps += sfpCage(cx0, 26.3, 9.8, 9.2, key, u.id + '_u' + i, {}, u) + cageLabel(cx0 + 4.9, 38.6, key, i); }
        return '<rect class="block-frame" x="' + f(ux - 1.4) + '" y="25" width="' + f(4 * 14.35 - 4.5 + 2.8) + '" height="11.8" rx=".5"></rect>' +
            ventHex(u.id, ux - 1, 18, 55, 6) +
            '<text class="model-text big" x="' + f(B + 367.6) + '" y="5.4">' + escHtml(s.modelText) + '</text>' +
            '<text class="tiny-label" x="' + f(B + 394.5) + '" y="5.2">RUNNING JUNOS</text>' +
            statusCluster(B + 427, 6.2, [['SYS', 'SPD'], ['ALM', 'DX'], ['MST', 'EN'], ['', 'PoE']], { SYS: true, MST: u.master, PoE: u.poe, ALM: u.alarm }, 4.6, { bracket: true }) +
            menuButton(B + 434.5, 33, 1.9) + usbSmall(B + 426.5, 37.8, 6.5, 3.2) + label(B + 434.4, 40.6, 'CON') + sfps;
    },
    /* EX4200/EX4300: mini-USB CON, model text, LCD + menu/enter, SYS/ALM/MST, SFP+ uplink module. */
    lcd: function (u, s) {
        var cages = '';
        for (var i = 0; i < 4; i++) { var cx0 = B + 378.5 + i * 14.7, key = u.key(pn(s.upPrefix || 'xe', u.fpc, 2, i)); cages += sfpCage(cx0, 26.4, 11, 10.4, key, u.id + '_u' + i, {}, u) + cageLabel(cx0 + 5.5, 37.7, key, i); }
        var mx = B + 372.5, my = 24.4, mw = 69, mh = 16.6;
        return usbSmall(B + 361, 2.4, 9, 3.6) + label(B + 360.2, 5.2, 'CON', 'end') +
            '<text class="model-text big" x="' + f(B + 384) + '" y="5.6">' + escHtml(s.modelText) + '</text>' +
            '<rect class="lcd-screen" x="' + f(B + 381) + '" y="12.4" width="37" height="7.6" rx=".5"></rect>' +
            '<text class="lcd-text" x="' + f(B + 383) + '" y="15.5">MEMBER ' + u.fpc + (u.master ? ' MASTER' : '') + '</text>' +
            '<text class="lcd-text" x="' + f(B + 383) + '" y="18.6">' + escHtml(s.lcd2 || '48x1G PoE+ 4x10G') + '</text>' +
            '<circle class="btn" cx="' + f(B + 428) + '" cy="12.6" r="2.5"></circle><path class="btn-glyph" d="M' + f(B + 426.5) + ',11.6 h3 M' + f(B + 426.5) + ',12.6 h3 M' + f(B + 426.5) + ',13.6 h3"></path>' +
            '<circle class="btn" cx="' + f(B + 428) + '" cy="20.2" r="2.5"></circle><path class="btn-glyph" d="M' + f(B + 429.4) + ',19 v1.4 h-2.6 m.9,-.9 l-.9,.9 l.9,.9"></path>' +
            dot(B + 435.5, 11.6, .9, null, null, 'green') + label(B + 437.2, 12.2, 'SYS') +
            dot(B + 435.5, 16.0, .9, null, null, u.alarm ? 'red' : null) + label(B + 437.2, 16.6, 'ALM') +
            dot(B + 435.5, 20.4, .9, null, null, u.master ? 'green' : null) + label(B + 437.2, 21.0, 'MST') +
            '<rect class="sfp-frame" x="' + f(mx) + '" y="' + f(my) + '" width="' + f(mw) + '" height="' + f(mh) + '" rx=".8"></rect>' +
            '<rect class="sfp-latch" x="' + f(mx + .6) + '" y="30" width="4.6" height="9.8" rx=".8"></rect><rect class="sfp-latch" x="' + f(mx + mw - 5.2) + '" y="30" width="4.6" height="9.8" rx=".8"></rect>' +
            screw(mx + 3, 27.6, 1.3) + screw(mx + mw - 3, 27.6, 1.3) + cages;
    },
    /* EX4400 / EX4300-MP: sub-panel with model text, RUNNING JUNOS, console (USB-C or mini),
       2x4 LED cluster, mode button, uplink-module bay drawn populated with a 4x SFP+ module. */
    ex4400: function (u, s) {
        var panelX = s.panelX || 361, px = B + panelX, w = BODY_W - panelX - 2;   // lay out from the available width
        var bayX = px + 3, bayW = w - 6, pitch = (bayW - 12) / 4, cw = Math.min(10, pitch - 3.2);
        var cages = '';
        for (var i = 0; i < 4; i++) { var cx0 = bayX + 6 + i * pitch + (pitch - cw) / 2, key = u.key(pn('xe', u.fpc, 2, i)); cages += sfpCage(cx0, 23.5, cw, 9.4, key, u.id + '_u' + i, {}, u) + cageLabel(cx0 + cw / 2, 35.2, key, i); }
        var bay = moduleBay(bayX, 16.5, bayW, 25.5, '<rect class="block-frame" x="' + f(bayX + 5) + '" y="22" width="' + f(4 * pitch + 2) + '" height="16" rx=".5"></rect>' + cages, s.moduleName || 'EX4400-EM-4S');
        var wide = w > 70;
        return '<rect class="subpanel" x="' + f(px) + '" y="1.6" width="' + f(w) + '" height="41.2" rx=".5"></rect>' +
            '<text class="model-text' + (wide ? ' big' : '') + '" x="' + f(px + 3) + '" y="5.6">' + escHtml(s.modelText) + '</text> ' + junosMark(px + 4, 12.4) +
            (s.console === 'mini' ? usbSmall(px + w - 42, 5.4, 6.5, 3.2) : usbSmall(px + w - 42, 5.2, 7, 3.4)) +
            statusCluster(px + w - 25, 4.6, s.leds || [['SYS', 'SPD'], ['ALM', 'DX'], ['MST', 'EN'], ['CLD', 'PoE']], { SYS: true, MST: u.master, PoE: u.poe, ALM: u.alarm }, 2.9) +
            (wide ? '<circle class="btn" cx="' + f(px + w - 5) + '" cy="9" r="1.4"></circle>' : '') + bay;
    },
    /* EX4100-48: 2x2 SFP+ uplinks (PIC 2) + 2x2 SFP28 VC ports, sub-panel with 8 LEDs, button, USB-C. */
    ex4100: function (u, s) {
        var gx = [B + 361, B + 393.3], cw = 13.2, ch = 8.6;
        var out = '';
        [0, 1].forEach(function (c) { out += cageColumn(gx[0] + c * (cw + 1.2), 12.8, 24.6, cw, ch, u, 'xe', 2, c * 2, c * 2 + 1, 'arrows'); });
        [0, 1].forEach(function (c) { [0, 1].forEach(function (r) { out += sfpCage(gx[1] + c * (cw + 1.2), r === 0 ? 12.8 : 24.6, cw, ch, null, null, { bailTop: r === 1 }); }); out += '<text class="port-num" x="' + f(gx[1] + c * (cw + 1.2) + cw / 2) + '" y="36.7" text-anchor="middle">' + (c * 2) + '▴ ▾' + (c * 2 + 1) + '</text>'; });
        var px = B + 421.6;
        return '<rect class="block-frame" x="' + f(gx[0] - 1.3) + '" y="11.5" width="' + f(2 * cw + 1.2 + 2.6) + '" height="23" rx=".6"></rect>' +
            '<rect class="block-frame" x="' + f(gx[1] - 1.3) + '" y="11.5" width="' + f(2 * cw + 1.2 + 2.6) + '" height="23" rx=".6"></rect> ' + out +
            '<path class="bracket" d="M' + f(gx[0] + 1) + ',38.2 v.8 h9 m9,0 h9 v-.8"></path>' + label(gx[0] + cw + .6, 40.2, 'UPLINK', 'middle') + label(gx[1] + cw + .6, 40.2, 'VC', 'middle') +
            '<rect class="subpanel" x="' + f(px) + '" y="1.6" width="' + f(BODY_W - 421.6 - 2) + '" height="41.2" rx=".5"></rect>' +
            statusCluster(px + 7.2, 12.2, [['SYS', 'SPD'], ['ALM', 'DX'], ['MST', 'EN'], ['CLD', 'PoE']], { SYS: true, MST: u.master, PoE: u.poe, ALM: u.alarm }, 4.55) +
            menuButton(px + 8.1, 32.9, 2.6) + usbSmall(px + 4.5, 37.7, 7.6, 3.1) + label(px + 13.5, 40.4, 'CON');
    },
    /* EX4000-48: 2x2 SFP+ uplinks, SYS/MST/CLD pill top-right, USB, reset. */
    ex4000: function (u, s) {
        var gx = B + 372, cw = 13.2, ch = 8.6;
        var out = '';
        [0, 1].forEach(function (c) { out += cageColumn(gx + c * (cw + 1.2), 12.8, 24.6, cw, ch, u, 'xe', 2, c * 2, c * 2 + 1, 'arrows'); });
        return '<rect class="block-frame" x="' + f(gx - 1.3) + '" y="11.5" width="' + f(2 * cw + 1.2 + 2.6) + '" height="23" rx=".6"></rect> ' + out +
            '<rect class="block-frame" x="' + f(B + 404) + '" y="2.4" width="34" height="5.4" rx="2.7"></rect>' +
            dot(B + 408, 5.1, .9, null, null, 'green') + label(B + 409.8, 5.7, 'SYS') + dot(B + 419, 5.1, .9, null, null, u.master ? 'green' : null) + label(B + 420.8, 5.7, 'MST') + dot(B + 430, 5.1, .9) + label(B + 431.8, 5.7, 'CLD') +
            usbA(B + 412, 24, 11, 5.4) + label(B + 417.5, 34, 'USB', 'middle') + '<circle class="btn" cx="' + f(B + 434) + '" cy="34" r="1.1"></circle>';
    },
    /* QFX5100-48T: 2x3 QSFP+ (48..53) on the right, dots+numbers above/below. */
    qsfp6: function (u, s) {
        var out = '';
        for (var c = 0; c < 3; c++) out += cageColumn(B + 378 + c * 19, 8.4, 22.8, 16.9, 11, u, 'et', 0, 48 + 2 * c, 49 + 2 * c, 'dots');
        return '<rect class="block-frame" x="' + f(B + 377) + '" y="7.4" width="' + f(2 * 19 + 16.9 + 2) + '" height="27.4" rx=".5"></rect>' + out + esdMark(B + 4, 6);
    },
};

/* ================= family 1: RJ45 rack ================= */
function rj45Rack(u) {
    var s = u.spec, uid = u.id, yTop = s.yTop || 9.3, pitch = s.pitch || 14.15;
    var labelsY = yTop + 2 * JACK_H + ROWBAR + 2.9;
    var blocks = '', n = 0;
    s.blocks.forEach(function (b) { blocks += rj45Block(B + b.x, yTop, b.cols, pitch, n, u, { labelsY: labelsY, solid: s.vents === 'hexAll', mgig: b.mgig, prefix: b.prefix }); n += 2 * b.cols; });
    var vents = '', brand = '';
    if (s.vents === 'hexAll') { vents = '<rect class="solid" x="' + f(B + 2) + '" y="1.5" width="' + f(BODY_W - 4) + '" height="41.5"></rect>' + ventHex(uid, B + 3, 1.6, s.hexW || 356, 41.2); brand = '<rect class="solid" x="' + f(B + 2) + '" y="1.5" width="30" height="8.2"></rect>' + wordmark(B + 3, 6, {}); }
    else if (s.vents === 'hexBands') { vents = ventHex(uid, B + 63, 1.2, s.hexW || 295, 7.4) + ventHex(uid, B + 3, 1.2, 4.6, 41.5) + ventHex(uid, B + BODY_W - 7.6, 1.2, 4.6, 41.5) + ventHex(uid, B + 9, 40.2, 349, 2.9); brand = wordmark(B + 3, 6.2, { model: s.modelText, modelX: 30, modelY: 0, big: true, mist: true }); }
    else if (s.vents === 'holesAll') { vents = ventHoles(uid, B + 3, 1.2, BODY_W - 6, 6.2) + ventHoles(uid, B + 3, 36.8, BODY_W - 6, 6); brand = ''; }
    else { vents = ventHex(uid, B + 34, 1.2, s.hexW || 327, 6.6) + ventSlots(B + 20, B + (s.slotsTo || 357), 39.6, 2.6); brand = wordmark(B + 2, 5.6, {}); }
    return svgOpen(uid, RACK_W, RACK_H) + rackBody() + rackEars() + vents + brand + blocks + RIGHT[s.right](u, s) + '</svg>';
}

/* ================= family 2: SFP / QSFP rack ================= */
function sfpRack(u) {
    var s = u.spec, uid = u.id;
    var yT = s.yT || 9.4, yB = s.yB || 23.4, style = s.labels || 'dots';
    var out = '', n = 0;
    (s.groups || []).forEach(function (g) {
        var w = g.w || 13.6, h = g.h || 10.9, pitch = g.pitch || 14.4;
        for (var c = 0; c < g.cols; c++) { out += cageColumn(B + g.x + c * pitch, yT, yB, w, h, u, g.prefix || s.prefix || 'et', g.pic || 0, (g.base || 0) + n, (g.base || 0) + n + 1, style, g.kind || 'access'); n += 2; }
        out += '<rect class="block-frame" x="' + f(B + g.x - 1) + '" y="' + f(yT - .8) + '" width="' + f((g.cols - 1) * pitch + w + 2) + '" height="' + f(yB + h - yT + 1.6) + '" rx=".5"></rect>';
    });
    if (s.qsfp) {
        var q = s.qsfp, qw = q.w || 18.2, qh = q.h || 11.6, qpitch = q.pitch || 19.3;
        for (var c = 0; c < q.cols; c++) {
            var x = B + q.x + c * qpitch, nT = q.base + 2 * c, nB = nT + 1;
            if (q.rows === 1) {
                var k = u.key(pn(q.prefix || 'et', u.fpc, q.pic || 0, q.base + c));
                out += sfpCage(x, yT - .4, qw, qh, k, uid + '_q' + c, {}, u) + cageLabel(x + qw / 2, yT + qh + 1.2, k, q.base + c, 'dots');
            } else out += cageColumn(x, yT - .4, yB - .4, qw, qh, u, q.prefix || 'et', q.pic || 0, nT, nB, 'dots', q.kind || 'uplink');
        }
        out += '<rect class="block-frame" x="' + f(B + q.x - 1) + '" y="' + f(yT - 1.2) + '" width="' + f((q.cols - 1) * qpitch + qw + 2) + '" height="' + f((q.rows === 1 ? qh : yB + qh - yT) + 2) + '" rx=".5"></rect>';
    }
    (s.bays || []).forEach(function (bay) {
        var w = bay.cw || 13.2, h = bay.ch || 9.2, pitch = bay.pitch || 14.6;
        var inner = '';
        for (var c = 0; c < bay.cols; c++) inner += cageColumn(B + bay.x + 12 + c * pitch, 8.6, 21.6, w, h, u, bay.prefix || 'xe', bay.pic, 2 * c, 2 * c + 1, 'dots', 'uplink');
        out += moduleBay(B + bay.x, 3, bay.w, 38.5, inner, bay.name);
    });
    var extras = '';
    if (s.left === 'qfx5120') {
        extras += wordmark(B + 20, 9, {}) + label(B + 38, 13.8, 'ID') + dot(B + 41.5, 13.2, .8) + '<circle class="btn" cx="' + f(B + 36) + '" cy="26" r="1.1"></circle>' + label(B + 36, 30, 'RESET', 'middle') + ventHex(uid, B + 2, 8, 12, 30);
        extras += mgmtConPair(B + 367, 8.8, uid) + sfpCage(B + 387, 8.4, 11.5, 9.2, null) + sfpCage(B + 387, 21.6, 11.5, 9.2, null, null, { bailTop: true }) + label(B + 392.7, 33.5, '32 33', 'middle') + usbA(B + 402, 9, 5, 10) + label(B + 420, 27, 'RUNNING JUNOS', 'middle') + ventHex(uid, B + 428, 8, 12, 30);
    }
    if (s.left === 'qfx5200') {
        extras += mgmtConPair(B + 12, 8.8, uid).replace('CON', '') + '<circle class="coax" cx="' + f(B + 34) + '" cy="14" r="2.2"></circle><circle class="coax" cx="' + f(B + 34) + '" cy="14" r=".8"></circle>' + label(B + 34, 9.6, 'PPS', 'middle') + '<circle class="coax" cx="' + f(B + 44) + '" cy="14" r="2.2"></circle><circle class="coax" cx="' + f(B + 44) + '" cy="14" r=".8"></circle>' + label(B + 44, 9.6, '10M', 'middle') + ventHex(uid, B + 2, 20, 50, 20) + ventHex(uid, B + 400, 8, 38, 28) + warnTri(B + 412, 16);
    }
    if (s.left === 'esd') extras += esdMark(B + 4, 20) + '<circle class="btn" cx="' + f(B + 6.5) + '" cy="33" r="1.1"></circle>';
    if (s.left === 'ex4400-24x') {
        var GJ = { w: 12.5, open: 6.2, strip: 3.4, nO: 4.4, nI: 6.6, dO: 1.8, win: { w: 2.4, h: 2.6 } };
        extras += wordmark(B + 3, 6.4, { mist: true })
            + rj45(B + 5, 22.6, GJ, null, uid + '_con', { static: true }) + label(B + 11.2, 35.6, 'CON', 'middle')
            + rj45(B + 26, 22.6, GJ, null, uid + '_mgmt', { static: true }) + label(B + 32.2, 35.6, 'MGMT', 'middle')
            + usbA(B + 45, 22, 5, 10.5) + label(B + 47.5, 35.6, 'USB', 'middle') + '<circle class="btn" cx="' + f(B + 57) + '" cy="27" r="1.1"></circle>' + label(B + 57, 31.4, 'RESET', 'middle');
        extras += RIGHT.ex4400(u, Object.assign({ panelX: 355, modelText: 'EX4400-24X', leds: [['SYS', 'SPD'], ['ALM', 'DX'], ['MST', 'EN'], ['CLD', '']] }, s));
    }
    var vents = '';
    if (s.vents === 'hexBands') vents = ventHex(uid, B + 6, 1.0, s.hexW || 430, 4.4) + ventHex(uid, B + 6, 38.6, s.hexW || 430, 4.4);
    else if (s.vents === 'holesBands') vents = ventHoles(uid, B + 8, 1.2, s.hexW || 425, 5.6) + ventHoles(uid, B + 8, 37.4, s.hexW || 425, 5.6);
    else if (s.vents === 'hexTop') vents = ventHex(uid, B + 62, 1.2, s.hexW || 340, 6);
    return svgOpen(uid, RACK_W, RACK_H) + rackBody() + rackEars() + vents + out + extras + '</svg>';
}

/* ================= family 3: compact desktop ================= */
function compact(u) {
    var s = u.spec, uid = u.id;
    var BUMP = 12.4, W = 267, TOTAL = W + 2 * BUMP, HT = 43.7, R = BUMP;
    var G = { w: 12.6, open: 6.7, strip: 3.5, nO: 4.4, nI: 6.6, dO: 1.8, win: { w: 2.4, h: 2.7 } };
    var pitch = s.pitch || 14.8, rowBar = 3.8, yTop = s.yTop || 7.9, H = G.strip + G.open, x0 = R + (s.x0 || 27.3);
    var labelsY = yTop + 2 * H + rowBar + 2.7;
    var block = '<rect class="block-frame" x="' + f(x0 - 1.1) + '" y="' + f(yTop - .8) + '" width="' + f(5 * pitch + G.w + 2.2) + '" height="' + f(2 * H + rowBar + 1.6) + '" rx=".4"></rect>';
    for (var c = 0; c < 6; c++) {
        var jx = x0 + c * pitch, nT = 2 * c, nB = nT + 1;
        block += rj45(jx, yTop, G, u.key(pn('ge', u.fpc, 0, nT)), uid + '_0_' + nT, {}, u) + rj45(jx, yTop + H + rowBar, G, u.key(pn('ge', u.fpc, 0, nB)), uid + '_0_' + nB, { flip: true }, u)
            + (s.arrowLabels ? '<text class="port-num" x="' + f(jx + G.w / 2) + '" y="' + f(labelsY) + '" text-anchor="middle">' + nT + '▴ ▾' + nB + '</text>'
                : '<text class="port-num" x="' + f(jx + G.w / 2 - 1.2) + '" y="' + f(labelsY) + '" text-anchor="end">' + nT + '</text><text class="port-num odd" x="' + f(jx + G.w / 2 + .3) + '" y="' + f(labelsY + .5) + '">' + nB + '</text>');
    }
    var bumper = function (x) { var fins = ''; for (var i = 0; i < 5; i++) { var fx = x + 2.4 + i * 2.0; fins += '<line class="bumper-fin" x1="' + f(fx) + '" y1="4" x2="' + f(fx) + '" y2="' + f(HT - 4) + '"></line>'; } return '<rect class="bumper" x="' + f(x + .2) + '" y=".2" width="' + f(BUMP - .4) + '" height="' + f(HT - .4) + '" rx="2.6"></rect>' + fins; };
    var sfps = '', right = '';
    if (s.variant === 'ex4100f') {
        /* EX4100-F-12: 4x SFP+ in a row (PIC 1) right of the block, labels under, SYS..PoE cluster,
           menu button, USB-C CON, warning triangle, green base stripe (drawn as a thick lip). */
        for (var i = 0; i < 4; i++) { var x = R + 180 + i * 15, key = u.key(pn('xe', u.fpc, 1, i)); sfps += sfpCage(x, 23.3, 13.8, 10.5, key, uid + '_u' + i, {}, u) + cageLabel(x + 6.9, 35.2, key, i); }
        sfps += '<rect class="block-frame" x="' + f(R + 179) + '" y="22.3" width="' + f(3 * 15 + 13.8 + 2) + '" height="12.5" rx=".5"></rect>';
        right = statusCluster(R + 248, 7.5, [['SYS', 'SPD'], ['ALM', 'DX'], ['MST', 'EN'], ['CLD', 'PoE']], { SYS: true, MST: u.master, PoE: u.poe, ALM: u.alarm }, 5.0)
            + menuButton(R + 253, 29, 2.2) + usbSmall(R + 249.5, 35.6, 7, 3.2) + label(R + 258, 38.4, 'CON') + warnTri(R + 206, 8)
            + esdMark(R + 6, 27) + '<circle class="btn" cx="' + f(R + 8) + '" cy="21" r="1.1"></circle>' + cornerMarks(R + 17, 20, 16.5, 15)
            + '<line class="lip thick" x1="' + f(R + .3) + '" y1="39.6" x2="' + f(R + W - .3) + '" y2="39.6"></line>';
    } else {
        /* EX2300-C / EX2200-C: 2x SFP with LINK/ST dots, USB-A, MGMT over CON (+ mini-USB), RUNNING JUNOS cluster. */
        [{ x: R + 135.5, ledX: R + 128.6 }, { x: R + 171.2, ledX: R + 164 }].forEach(function (c, i) {
            var key = u.key(pn(s.upPrefix || 'xe', u.fpc, 1, i));
            sfps += sfpCage(c.x, 23, 14.2, 9.4, key, uid + '_u' + i, {}, u) + dot(c.ledX, 25.2, 1.0, key, 'link') + label(c.ledX - 2.2, 25.8, 'LINK', 'end') + dot(c.ledX, 29.2, 1.0, key, 'act') + label(c.ledX - 2.2, 29.8, 'ST', 'end') + '<text class="port-num" x="' + f(c.x + 7.1) + '" y="35.6" text-anchor="middle">' + i + '</text>';
        });
        var GM = { w: 13.1, open: 6.4, strip: 3.4, nO: 4.4, nI: 6.6, dO: 1.8, win: { w: 2.5, h: 2.6 } };
        var sx = R + 246;
        right = usbA(R + 195.5, 19.5, 5.5, 12.3) + label(R + 198.2, 35, 'USB', 'middle')
            + rj45(R + 212.4, 7.9, GM, null, uid + '_mgmt', { static: true }) + label(R + 227.5, 6.6, 'MGMT') + rj45(R + 212.4, 21.6, GM, null, uid + '_con', { static: true, flip: true })
            + usbSmall(R + 232, 28.6, 9, 3.8) + '<path class="bracket" d="M' + f(R + 213) + ',34.6 v.8 h11 m5,0 h11 v-.8"></path>' + label(R + 237, 35.9, 'CON', 'end')
            + '<text class="tiny-label" x="' + f(R + 253) + '" y="9.4" text-anchor="middle">RUNNING JUNOS</text>'
            + statusCluster(sx, 14.3, [['SYS', 'SPD'], ['ALM', 'DX'], ['MST', 'EN'], ['PoE', '']], { SYS: true, MST: u.master, PoE: u.poe, ALM: u.alarm }, 5.0)
            + '<path class="bracket" d="M' + f(sx + 7) + ',22.2 h5.2 v9.6 h-5.2"></path><rect class="btn" x="' + f(sx + 8.9) + '" y="25.4" width="3.6" height="3.4" rx=".5"></rect><path class="btn-glyph" d="M' + f(sx + 9.6) + ',26.3 h2.2 M' + f(sx + 9.6) + ',27.1 h2.2 M' + f(sx + 9.6) + ',27.9 h2.2"></path>'
            + esdMark(R + 6.5, 22.8) + screw(R + 10.6, 32.4, .9) + cornerMarks(R + 121.8, 7, 27.2, 8);
    }
    return svgOpen(uid, TOTAL, HT) +
        '<rect class="chassis-body" x="' + f(R) + '" y="2.6" width="' + W + '" height="35.6" rx=".6"></rect>' +
        '<line class="lip" x1="' + f(R + .3) + '" y1="40.2" x2="' + f(R + W - .3) + '" y2="40.2"></line>' +
        '<rect class="chassis-body" x="' + f(R + .8) + '" y="38.2" width="' + f(W - 1.6) + '" height="2.2" rx=".3"></rect>' +
        bumper(0) + bumper(R + W) +
        wordmark(R + 3, 10.4, { model: s.modelText || u.model, modelX: s.variant === 'ex4100f' ? 30 : 0, modelY: s.variant === 'ex4100f' ? 0 : 4.6, mist: s.variant === 'ex4100f', big: s.variant === 'ex4100f' }) +
        block + sfps + right +
        '</svg>';
}

/* ================= model catalogue =================
   style: which family draws it. Measured = positions taken from Juniper's front-view photo;
   the legacy EX2200/3300/4200 entries reuse their successor's measured layout (same panel
   family, no photo). Keys are upper-case; resolveModel() normalises what Junos reports. */
var RJ = function (blocks, right, extra) { return Object.assign({ blocks: blocks, right: right, vents: 'hexTopSlots' }, extra || {}); };
var FAMILY_BLOCKS = [9.3, 98.6, 187.9, 277.2].map(function (x) { return { x: x, cols: 6 }; });
var MODELS = {
    // ---- compact ----
    'EX2300-C-12P': { style: 'compact', label: 'compact', spec: {}, poe: true },
    'EX2300-C-12T': { style: 'compact', label: 'compact', spec: {}, poe: false },
    'EX2200-C-12P': { style: 'compact', label: 'compact (legacy)', spec: { upPrefix: 'ge' }, poe: true },
    'EX2200-C-12T': { style: 'compact', label: 'compact (legacy)', spec: { upPrefix: 'ge' }, poe: false },
    'EX4100-F-12P': { style: 'compact', label: 'compact', spec: { variant: 'ex4100f', modelText: 'EX4100-F 12PoE+', x0: 79, arrowLabels: true }, poe: true },
    'EX4100-F-12T': { style: 'compact', label: 'compact', spec: { variant: 'ex4100f', modelText: 'EX4100-F 12', x0: 79, arrowLabels: true }, poe: false },
    // ---- RJ45 rack: EX2300 / EX3400 / legacy EX2200 / EX3300 ----
    'EX2300-24T': { style: 'rj45', label: '2x6 RJ45 rack', spec: RJ(FAMILY_BLOCKS.slice(2), 'ex2300', { modelText: 'EX2300' }), poe: false },
    'EX2300-24P': { style: 'rj45', label: '2x6 RJ45 rack', spec: RJ(FAMILY_BLOCKS.slice(2), 'ex2300', { modelText: 'EX2300 PoE+' }), poe: true },
    'EX2300-48T': { style: 'rj45', label: '2x6 RJ45 rack', spec: RJ(FAMILY_BLOCKS, 'ex2300', { modelText: 'EX2300' }), poe: false },
    'EX2300-48P': { style: 'rj45', label: '2x6 RJ45 rack', spec: RJ(FAMILY_BLOCKS, 'ex2300', { modelText: 'EX2300 PoE+' }), poe: true },
    'EX3400-24T': { style: 'rj45', label: '2x6 RJ45 rack', spec: RJ(FAMILY_BLOCKS.slice(2), 'ex2300', { modelText: 'EX3400' }), poe: false },
    'EX3400-24P': { style: 'rj45', label: '2x6 RJ45 rack', spec: RJ(FAMILY_BLOCKS.slice(2), 'ex2300', { modelText: 'EX3400 PoE+' }), poe: true },
    'EX3400-48T': { style: 'rj45', label: '2x6 RJ45 rack', spec: RJ(FAMILY_BLOCKS, 'ex2300', { modelText: 'EX3400' }), poe: false },
    'EX3400-48P': { style: 'rj45', label: '2x6 RJ45 rack', spec: RJ(FAMILY_BLOCKS, 'ex2300', { modelText: 'EX3400 PoE+' }), poe: true },
    'EX2200-24T': { style: 'rj45', label: '2x6 RJ45 rack (legacy)', spec: RJ(FAMILY_BLOCKS.slice(2), 'ex2300', { modelText: 'EX2200', upPrefix: 'ge' }), poe: false },
    'EX2200-24P': { style: 'rj45', label: '2x6 RJ45 rack (legacy)', spec: RJ(FAMILY_BLOCKS.slice(2), 'ex2300', { modelText: 'EX2200 PoE', upPrefix: 'ge' }), poe: true },
    'EX2200-48T': { style: 'rj45', label: '2x6 RJ45 rack (legacy)', spec: RJ(FAMILY_BLOCKS, 'ex2300', { modelText: 'EX2200', upPrefix: 'ge' }), poe: false },
    'EX2200-48P': { style: 'rj45', label: '2x6 RJ45 rack (legacy)', spec: RJ(FAMILY_BLOCKS, 'ex2300', { modelText: 'EX2200 PoE', upPrefix: 'ge' }), poe: true },
    'EX3300-24T': { style: 'rj45', label: '2x6 RJ45 rack (legacy)', spec: RJ(FAMILY_BLOCKS.slice(2), 'ex2300', { modelText: 'EX3300' }), poe: false },
    'EX3300-24P': { style: 'rj45', label: '2x6 RJ45 rack (legacy)', spec: RJ(FAMILY_BLOCKS.slice(2), 'ex2300', { modelText: 'EX3300 PoE+' }), poe: true },
    'EX3300-48T': { style: 'rj45', label: '2x6 RJ45 rack (legacy)', spec: RJ(FAMILY_BLOCKS, 'ex2300', { modelText: 'EX3300' }), poe: false },
    'EX3300-48P': { style: 'rj45', label: '2x6 RJ45 rack (legacy)', spec: RJ(FAMILY_BLOCKS, 'ex2300', { modelText: 'EX3300 PoE+' }), poe: true },
    // ---- RJ45 rack: LCD family ----
    'EX4300-24T': { style: 'rj45', label: '2x6 RJ45 rack + LCD', spec: RJ(FAMILY_BLOCKS.slice(2), 'lcd', { modelText: 'EX4300', lcd2: '24x1G 4x10G' }), poe: false },
    'EX4300-24P': { style: 'rj45', label: '2x6 RJ45 rack + LCD', spec: RJ(FAMILY_BLOCKS.slice(2), 'lcd', { modelText: 'EX4300 PoE+', lcd2: '24x1G PoE+ 4x10G' }), poe: true },
    'EX4300-48T': { style: 'rj45', label: '2x6 RJ45 rack + LCD', spec: RJ(FAMILY_BLOCKS, 'lcd', { modelText: 'EX4300', lcd2: '48x1G 4x10G' }), poe: false },
    'EX4300-48P': { style: 'rj45', label: '2x6 RJ45 rack + LCD', spec: RJ(FAMILY_BLOCKS, 'lcd', { modelText: 'EX4300 PoE+' }), poe: true },
    'EX4200-24T': { style: 'rj45', label: '2x6 RJ45 rack + LCD (legacy)', spec: RJ(FAMILY_BLOCKS.slice(2), 'lcd', { modelText: 'EX4200', lcd2: '24x1G 4x1G', upPrefix: 'ge' }), poe: false },
    'EX4200-48T': { style: 'rj45', label: '2x6 RJ45 rack + LCD (legacy)', spec: RJ(FAMILY_BLOCKS, 'lcd', { modelText: 'EX4200', lcd2: '48x1G 4x1G', upPrefix: 'ge' }), poe: false },
    'EX4200-48P': { style: 'rj45', label: '2x6 RJ45 rack + LCD (legacy)', spec: RJ(FAMILY_BLOCKS, 'lcd', { modelText: 'EX4200 PoE', lcd2: '48x1G PoE 4x1G', upPrefix: 'ge' }), poe: true },
    'EX4300-48MP': { style: 'rj45', label: '2x6 RJ45 rack, mGig, module bay', spec: RJ([{ x: 8, cols: 6 }, { x: 97.6, cols: 6 }, { x: 189, cols: 6, mgig: true, prefix: 'mge' }, { x: 282.6, cols: 6, mgig: true, prefix: 'mge' }], 'ex4400', { modelText: 'EX4300-48MP', console: 'mini', panelX: 372, moduleName: 'EX-UM-4SFPP-MR', slotsTo: 365, hexW: 335, leds: [['SYS', 'SPD'], ['ALM', 'DX'], ['MST', 'EN'], ['', 'PoE']] }), poe: true },
    // ---- RJ45 rack: EX4400 (fully perforated) ----
    'EX4400-24T': { style: 'rj45', label: '2x6 RJ45 rack, perforated', spec: RJ(FAMILY_BLOCKS.slice(0, 2), 'ex4400', { modelText: 'EX4400', vents: 'hexAll' }), poe: false },
    'EX4400-24P': { style: 'rj45', label: '2x6 RJ45 rack, perforated', spec: RJ(FAMILY_BLOCKS.slice(0, 2), 'ex4400', { modelText: 'EX4400 PoE++', vents: 'hexAll' }), poe: true },
    'EX4400-48T': { style: 'rj45', label: '2x6 RJ45 rack, perforated', spec: RJ(FAMILY_BLOCKS, 'ex4400', { modelText: 'EX4400', vents: 'hexAll' }), poe: false },
    'EX4400-48P': { style: 'rj45', label: '2x6 RJ45 rack, perforated', spec: RJ(FAMILY_BLOCKS, 'ex4400', { modelText: 'EX4400 PoE++', vents: 'hexAll' }), poe: true },
    // ---- RJ45 rack: 2x8 blocks ----
    'EX4100-48T': { style: 'rj45', label: '2x8 RJ45 rack', spec: RJ([{ x: 9.1, cols: 8 }, { x: 127, cols: 8 }, { x: 244.9, cols: 8 }], 'ex4100', { modelText: 'EX4100', vents: 'hexBands', pitch: 14.0, yTop: 10.3 }), poe: false },
    'EX4100-48P': { style: 'rj45', label: '2x8 RJ45 rack', spec: RJ([{ x: 9.1, cols: 8 }, { x: 127, cols: 8 }, { x: 244.9, cols: 8 }], 'ex4100', { modelText: 'EX4100 PoE+', vents: 'hexBands', pitch: 14.0, yTop: 10.3 }), poe: true },
    'EX4100-24T': { style: 'rj45', label: '2x8 RJ45 rack', spec: RJ([{ x: 9.1, cols: 8 }, { x: 127, cols: 4 }], 'ex4100', { modelText: 'EX4100', vents: 'hexBands', pitch: 14.0, yTop: 10.3 }), poe: false },
    'EX4100-24P': { style: 'rj45', label: '2x8 RJ45 rack', spec: RJ([{ x: 9.1, cols: 8 }, { x: 127, cols: 4 }], 'ex4100', { modelText: 'EX4100 PoE+', vents: 'hexBands', pitch: 14.0, yTop: 10.3 }), poe: true },
    'EX4000-48T': { style: 'rj45', label: '2x8 RJ45 rack', spec: RJ([{ x: 9.1, cols: 8 }, { x: 127, cols: 8 }, { x: 244.9, cols: 8 }], 'ex4000', { modelText: 'EX4000', vents: 'hexBands', pitch: 14.0, yTop: 10.3, hexW: 300 }), poe: false },
    'EX4000-48P': { style: 'rj45', label: '2x8 RJ45 rack', spec: RJ([{ x: 9.1, cols: 8 }, { x: 127, cols: 8 }, { x: 244.9, cols: 8 }], 'ex4000', { modelText: 'EX4000 PoE+', vents: 'hexBands', pitch: 14.0, yTop: 10.3, hexW: 300 }), poe: true },
    'QFX5100-48T': { style: 'rj45', label: '2x8 10GBASE-T + QSFP', spec: RJ([{ x: 13.6, cols: 8, prefix: 'xe' }, { x: 134, cols: 8, prefix: 'xe' }, { x: 254.6, cols: 8, prefix: 'xe' }], 'qsfp6', { vents: 'holesAll', pitch: 14.0, yTop: 9.0 }), poe: false },
    // ---- SFP rack ----
    'EX4650-48Y': { style: 'sfp', label: '48x SFP28 + 8x QSFP28', spec: { groups: [{ x: 7.8, cols: 8 }, { x: 125.4, cols: 8 }, { x: 243.3, cols: 8 }], qsfp: { x: 362, cols: 4, rows: 2, base: 48 }, vents: 'hexBands', prefix: 'et' }, poe: false },
    'QFX5120-48Y': { style: 'sfp', label: '48x SFP28 + 8x QSFP28', spec: { groups: [{ x: 7.8, cols: 8 }, { x: 125.4, cols: 8 }, { x: 243.3, cols: 8 }], qsfp: { x: 362, cols: 4, rows: 2, base: 48 }, vents: 'hexBands', prefix: 'et' }, poe: false },
    'QFX5100-48S': { style: 'sfp', label: '48x SFP+ + 6x QSFP+', spec: { groups: [{ x: 10, cols: 6, pitch: 14.1, w: 12.9 }, { x: 100.6, cols: 6, pitch: 14.1, w: 12.9 }, { x: 189.6, cols: 6, pitch: 14.1, w: 12.9 }, { x: 278.5, cols: 6, pitch: 14.1, w: 12.9 }], qsfp: { x: 378, cols: 3, rows: 2, base: 48, w: 16.9, h: 11, pitch: 19 }, vents: 'holesBands', left: 'esd', prefix: 'xe' }, poe: false },
    'QFX5110-48S': { style: 'sfp', label: '48x SFP+ + 4x QSFP28', spec: { groups: [{ x: 10, cols: 6, pitch: 14.1, w: 12.9 }, { x: 100.6, cols: 6, pitch: 14.1, w: 12.9 }, { x: 189.6, cols: 6, pitch: 14.1, w: 12.9 }, { x: 278.5, cols: 6, pitch: 14.1, w: 12.9 }], qsfp: { x: 392, cols: 2, rows: 2, base: 48, w: 16.9, h: 11, pitch: 19 }, vents: 'holesBands', left: 'esd', prefix: 'xe' }, poe: false },
    'EX4400-24X': { style: 'sfp', label: '24x SFP+ + 2x QSFP28, module bay', spec: { groups: [{ x: 64, cols: 12, pitch: 20.6, w: 14.5, h: 9.6 }], qsfp: { x: 317, cols: 2, rows: 1, base: 24, w: 17, h: 11.6, pitch: 19.6, prefix: 'et' }, yT: 9, yB: 21, labels: 'arrows', left: 'ex4400-24x', vents: 'hexTop', hexW: 250, prefix: 'xe' }, poe: false },
    'EX4600-40F': { style: 'sfp', label: '24x SFP+ + 4x QSFP+, two module bays', spec: { groups: [{ x: 12.8, cols: 6, pitch: 14.6, w: 14 }, { x: 107.4, cols: 6, pitch: 14.6, w: 14 }], qsfp: { x: 200, cols: 2, rows: 2, base: 24, w: 16.4, h: 11, pitch: 28.6 }, bays: [{ x: 263.4, w: 85.6, cols: 4, pic: 1, name: 'EX4600-EM-8F' }, { x: 353.6, w: 81.4, cols: 4, pic: 2, name: 'EX4600-EM-8F' }], vents: 'hexBands', hexW: 240, left: 'esd', prefix: 'xe' }, poe: false },
    // ---- QSFP rack ----
    'QFX5120-32C': { style: 'sfp', label: '32x QSFP28', spec: { groups: [{ x: 45.9, cols: 4, pitch: 19.2, w: 18.7, h: 11.4 }, { x: 126.5, cols: 4, pitch: 19.2, w: 18.7, h: 11.4 }, { x: 206.8, cols: 4, pitch: 19.2, w: 18.7, h: 11.4 }, { x: 287.4, cols: 4, pitch: 19.2, w: 18.7, h: 11.4 }], yT: 9.8, yB: 22.4, vents: 'hexTop', hexW: 290, left: 'qfx5120', prefix: 'et' }, poe: false },
    'QFX5200-32C': { style: 'sfp', label: '32x QSFP28', spec: { groups: [{ x: 60, cols: 4, pitch: 19.2, w: 18.7, h: 11.4 }, { x: 140.6, cols: 4, pitch: 19.2, w: 18.7, h: 11.4 }, { x: 220.9, cols: 4, pitch: 19.2, w: 18.7, h: 11.4 }, { x: 301.5, cols: 4, pitch: 19.2, w: 18.7, h: 11.4 }], yT: 9.8, yB: 22.4, vents: 'holesBands', hexW: 425, left: 'qfx5200', prefix: 'et' }, poe: false },
    'QFX5100-24Q': { style: 'sfp', label: '24x QSFP+, two module bays', spec: { groups: [{ x: 10, cols: 3, pitch: 19.3, w: 14.7, h: 11 }, { x: 74, cols: 3, pitch: 19.3, w: 14.7, h: 11 }, { x: 138, cols: 3, pitch: 19.3, w: 14.7, h: 11 }, { x: 202, cols: 3, pitch: 19.3, w: 14.7, h: 11 }], bays: [{ x: 263.6, w: 82, cols: 2, pic: 1, cw: 16.4, ch: 11, pitch: 28, prefix: 'et', name: 'QFX-EM-4Q' }, { x: 350, w: 84, cols: 2, pic: 2, cw: 16.4, ch: 11, pitch: 28, prefix: 'et', name: 'QFX-EM-4Q' }], vents: 'holesBands', hexW: 240, prefix: 'et' }, poe: false },
};
var STYLE_GEN = { rj45: rj45Rack, sfp: sfpRack, compact: compact };

// Modular / chassis-based platforms: vertical line cards, no 1U front to draw.
var MODULAR_RE = /^(EX92|EX82|EX62|QFX10|MX|PTX|SRX[1-9]\d{3})/;

// Maps whatever Junos reports (`show virtual-chassis` gives lower-case "ex2300-24t",
// `show chassis hardware` gives "EX4300-48P"; both may carry ordering trailers such as
// -AFI/-AFO/-DC/-TAA) onto a catalogue key. Returns { key, model } or null.
function resolveModel(modelStr) {
    if (!modelStr) return null;
    var m = String(modelStr).trim().toUpperCase();
    if (MODELS[m]) return { key: m, model: MODELS[m] };
    // Strip ordering/airflow/power trailers one at a time: EX4300-48P-AFI, QFX5100-48S-DC-AFO, EX4400-48P-TAA
    var parts = m.split('-');
    while (parts.length > 2) {
        parts.pop();
        var cand = parts.join('-');
        if (MODELS[cand]) return { key: cand, model: MODELS[cand] };
    }
    // Same chassis with a different port option letter we haven't measured separately: draw the sibling.
    var sib = m.match(/^([A-Z]+\d{4}(?:-[A-Z])?-\d{2})([A-Z]+)/);
    if (sib) {
        var candidates = ['P', 'T', 'MP', 'S', 'Y', 'F'].map(function (sfx) { return sib[1] + sfx; });
        for (var i = 0; i < candidates.length; i++) if (MODELS[candidates[i]]) return { key: candidates[i], model: MODELS[candidates[i]] };
    }
    return null;
}

var PORT_RE = /^(ge|mge|xe|et)-(\d+)\/(\d+)\/(\d+)$/;
function parsePort(name) {
    var m = PORT_RE.exec(String(name || ''));
    return m ? { prefix: m[1], fpc: +m[2], pic: +m[3], n: +m[4] } : null;
}

// Fallback for a fixed-config model the catalogue doesn't know: infer the panel from the
// interfaces this member actually reports. Copper (ge/mge) access on PIC 0 -> the 2x6 RJ45
// rack family in 12-port blocks with the EX2300-style right section; fibre access -> plain
// SFP columns. Returns a spec-bearing model like a catalogue entry, or null if nothing
// parseable belongs to this FPC.
function inferModel(modelStr, fpc, interfaces) {
    var access = [], uplinkPics = {};
    (interfaces || []).forEach(function (intf) {
        var p = parsePort(intf && intf.Port);
        if (!p || p.fpc !== fpc) return;
        if (p.pic === 0) access.push(p); else uplinkPics[p.pic] = p.prefix;
    });
    if (!access.length) return null;
    var maxN = access.reduce(function (a, p) { return Math.max(a, p.n); }, 0);
    var copper = access.every(function (p) { return p.prefix === 'ge' || p.prefix === 'mge'; });
    var text = String(modelStr || '').toUpperCase() || 'JUNIPER';
    if (copper) {
        var nBlocks = Math.min(4, Math.max(1, Math.ceil((maxN + 1) / 12)));
        // Per-port, not per-block: a device can report mge ports that don't align to a
        // 12-port block boundary, and flagging the whole block would mislabel the ge ports
        // sharing it (or hide a live mge port outside the flagged block).
        var mgigPorts = {};
        access.forEach(function (p) { if (p.prefix === 'mge') mgigPorts[p.n] = true; });
        var prefixOf = function (n) { return mgigPorts[n] ? 'mge' : 'ge'; };
        var blocks = FAMILY_BLOCKS.slice(4 - nBlocks).map(function (b, i) {
            var first = 12 * i, hasMgig = false;
            for (var k = 0; k < 12; k++) if (mgigPorts[first + k]) { hasMgig = true; break; }
            return hasMgig ? Object.assign({}, b, { mgig: true, prefix: prefixOf }) : b;
        });
        var right = uplinkPics[2] ? 'lcd' : 'ex2300';
        return { style: 'rj45', label: 'inferred from interface list', inferred: true, poe: false,
            spec: RJ(blocks, right, { modelText: text, upPrefix: uplinkPics[2] || uplinkPics[1] || 'xe', lcd2: (maxN + 1) + 'x1G INFERRED' }) };
    }
    var cols = Math.min(24, Math.ceil((maxN + 1) / 2)), groups = [];
    for (var g = 0; g * 6 < cols; g++) groups.push({ x: 10 + g * 89.5, cols: Math.min(6, cols - g * 6), pitch: 14.1, w: 12.9 });
    return { style: 'sfp', label: 'inferred from interface list', inferred: true, poe: false,
        spec: { groups: groups, vents: 'holesBands', left: 'esd', prefix: access[0].prefix } };
}

// Activity lens: green = carrying traffic now or flapped within 72 h, amber = last change
// between 72 h and 6 months ago, 'off' = older than that, never, or unknown (null
// LastFlappedSeconds - pre-dates the field, or Junos reported "Never").
// LastFlappedSeconds is captured once, as of the snapshot's own scan (drawer.js's CSV export
// notes the same thing) - it does not keep counting up while the snapshot sits loaded. A port
// that flapped 70h before an since-then-2-months-old scan is not "recently active" now; ageSec
// (seconds elapsed since that scan, 0 for a live/unknown snapshot) is added before thresholding
// so a stale snapshot ages out of 'green' the same way live data would.
var H72_S = 72 * 3600, H6MO_S = 182 * 24 * 3600;
function activityState(intf, ageSec) {
    if (!intf) return 'off';
    if (String(intf.Link).toLowerCase() === 'up') return 'green';
    var s = intf.LastFlappedSeconds;
    if (s === null || s === undefined || !isFinite(s)) return 'off';
    var elapsed = s + (ageSec > 0 ? ageSec : 0);
    if (elapsed <= H72_S) return 'green';
    if (elapsed <= H6MO_S) return 'amber';
    return 'off';
}
// 'red' mirrors the down badge the Interfaces table shows for this same intf.Link check
// (drawer.js renderInterfaces); 'off' stays reserved for a port the artwork has but the
// device didn't report at all (no intf, so lightStates() never calls this for it).
function linkState(intf) {
    if (!intf) return 'off';
    return String(intf.Link).toLowerCase() === 'up' ? 'green' : 'red';
}

// Builds the members of one device: [{fpc, model, key, role, master, unit, html|note}] in
// FPC order. Pure - no DOM. `device` is a topology record (StackMembers, Interfaces).
function buildMembers(device) {
    var asArr = function (v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); };
    var interfaces = asArr(device && device.Interfaces);
    // Chassis Alarms are device-wide (drawer.js's Summary/Alarms tabs use this same truthy
    // check), not per stack member - every member's ALM LED reflects the same device state.
    var hasAlarm = asArr(device && device.Alarms).length > 0;
    var byPort = new Map();
    interfaces.forEach(function (intf) { if (intf && intf.Port) byPort.set(String(intf.Port), intf); });
    var members = asArr(device && device.StackMembers).map(function (sm) {
        return { fpc: parseInt(sm.FPC, 10), fpcRaw: sm.FPC, model: sm.Model, role: sm.Role, serial: sm.Serial };
    }).filter(function (m) { return !isNaN(m.fpc); });
    // No hardware record at all - fall back to whichever FPC numbers the interface names carry.
    if (!members.length) {
        var seen = {};
        interfaces.forEach(function (intf) { var p = parsePort(intf.Port); if (p && !seen[p.fpc]) { seen[p.fpc] = true; members.push({ fpc: p.fpc, fpcRaw: String(p.fpc), model: 'Unknown', role: '' }); } });
    }
    members.sort(function (a, b) { return a.fpc - b.fpc; });
    var multi = members.length > 1;
    return members.map(function (m) {
        var out = { fpc: m.fpc, role: m.role || '', model: m.model || 'Unknown', master: multi ? /master/i.test(m.role || '') : true, multi: multi };
        var upper = String(m.model || '').toUpperCase();
        if (MODULAR_RE.test(upper)) { out.note = 'Modular chassis (' + m.model + ') - no front-panel drawing.'; return out; }
        var res = resolveModel(m.model);
        var model = res ? res.model : inferModel(m.model, m.fpc, interfaces);
        if (!model) { out.note = 'No front-panel drawing for ' + (m.model || 'this model') + '.'; return out; }
        // Physical ports the device reports on this member - used to check the catalogue art
        // actually fits them (below).
        var reported = interfaces.filter(function (intf) { var p = parsePort(intf && intf.Port); return p && p.fpc === m.fpc; }).map(function (intf) { return String(intf.Port); });
        var bound = {};
        var makeUnit = function (mdl) { return {
            id: 'fpc' + m.fpc, fpc: m.fpc, model: out.model, master: out.master, poe: mdl.poe, alarm: hasAlarm, spec: mdl.spec,
            key: function (ifname) { bound[ifname] = true; return ifname; },
            hasPort: function (ifname) { return byPort.has(ifname); },
            // Detail line only - the tooltip prints the interface name itself from data-port.
            title: function (ifname) {
                var intf = byPort.get(ifname);
                if (!intf) return 'not in scan data';
                var t = (intf.Admin || '?') + '/' + (intf.Link || '?');
                if (intf.Desc && intf.Desc !== 'Unknown') t += ' · ' + intf.Desc;
                return t;
            },
        }; };
        curUid = 'fpc' + m.fpc;
        var html = STYLE_GEN[model.style](makeUnit(model));
        // A catalogue match whose artwork covers under half of the ports this member actually
        // reports (a naming scheme the measured SKU doesn't use, a wrongly identified model)
        // would light almost nothing - the interface-derived layout is the more honest picture.
        if (res && reported.length) {
            var covered = reported.filter(function (p) { return bound[p]; }).length;
            if (covered / reported.length < 0.5) {
                var inferred = inferModel(m.model, m.fpc, interfaces);
                if (inferred) { bound = {}; res = null; model = inferred; html = STYLE_GEN[model.style](makeUnit(model)); }
            }
        }
        out.catalogueKey = res ? res.key : null;
        out.inferred = !res;
        out.label = model.label;
        out.html = html;
        return out;
    });
}

// Which lenses light, keyed by interface name: { 'ge-0/0/1': {link:'green', act:'amber'}, ... }
function lightStates(device, ageSec) {
    var asArr = function (v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); };
    var out = {};
    asArr(device && device.Interfaces).forEach(function (intf) {
        if (!intf || !intf.Port || String(intf.Port).indexOf('.') !== -1) return;
        out[String(intf.Port)] = { link: linkState(intf), act: activityState(intf, ageSec) };
    });
    return out;
}

var api = {
    MODELS: MODELS, resolveModel: resolveModel, inferModel: inferModel, parsePort: parsePort,
    activityState: activityState, linkState: linkState, buildMembers: buildMembers, lightStates: lightStates,
    H72_S: H72_S, H6MO_S: H6MO_S,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
} else if (typeof window !== 'undefined') {
    window.Chassis = api;

    // ---- DOM side (browser only) ----
    var renderedFor = null;   // the device object the current SVGs were built from
    var zoomed = false;       // double-width panels in a sideways-scrolling strip (session only)

    // Seconds elapsed since the LastFlappedSeconds fields on `device` were captured. A live
    // rescan (drawer.js mergeRescanResult) stamps device.RescannedAt with a fresh timestamp
    // without touching the loaded snapshot's own scanTimestamp, so that per-device stamp wins
    // when present; otherwise fall back to the active snapshot's capture time. app.js/drawer.js
    // load after chassis.js, so these globals only need to exist by the time this actually
    // runs (a user interaction), not at script-load time.
    function snapshotAgeSeconds(device) {
        try {
            var ts = (device && device.RescannedAt) || (window.loadedSnapshots && window.loadedSnapshots[window.activeSnapshotIndex] && window.loadedSnapshots[window.activeSnapshotIndex].scanTimestamp);
            var ms = window.parseTimestampMs ? window.parseTimestampMs(ts) : null;
            return ms === null ? 0 : Math.max(0, (Date.now() - ms) / 1000);
        } catch (e) { return 0; }
    }

    window.toggleChassisZoom = function () {
        zoomed = !zoomed;
        var root = document.getElementById('chassis-view');
        if (!root) return;
        root.classList.toggle('zoomed', zoomed);
        var btn = root.querySelector('.chassis-zoom-btn');
        if (btn) btn.textContent = zoomed ? 'Fit' : 'Zoom';
    };

    // Draws (or, for the same device object, just re-lights) the front panels into
    // #chassis-view. Called from drawer.js's renderInterfaces so sort clicks and the
    // hide-down toggle re-light without rebuilding, while a rescan merge (new device object)
    // rebuilds. selectedPort (bare ifname or null) gets the .selected highlight.
    window.renderChassisView = function (device, selectedPort) {
        var root = document.getElementById('chassis-view');
        if (!root) return;
        if (!device) { root.innerHTML = ''; renderedFor = null; return; }
        if (renderedFor !== device) {
            var members = buildMembers(device);
            var html = members.map(function (m) {
                var who = 'fpc ' + m.fpc + (m.multi ? ' · ' + (m.role || (m.master ? 'master' : 'member')).toLowerCase() : '');
                var tag = m.inferred ? '<span class="chassis-tag" title="Model not in the panel catalogue - layout inferred from its interface names">inferred</span>' : '';
                var head = '<div class="chassis-member-label"><span class="chassis-model">' + escHtml(m.model) + '</span><span class="chassis-member">' + escHtml(who) + '</span>' + tag + '</div>';
                if (m.note) return '<div class="chassis-member">' + head + '<div class="chassis-note">' + escHtml(m.note) + '</div></div>';
                return '<div class="chassis-member">' + head + '<div class="chassis-art">' + m.html + '</div></div>';
            }).join('');
            root.innerHTML = html
                ? '<div class="chassis-stack">' + html + '</div>' +
                  '<div class="chassis-legend">' +
                  '<span><i class="lens-sample green"></i>left lens: link up</span>' +
                  '<span><i class="lens-sample red"></i>left lens: link down</span>' +
                  '<span><i class="lens-sample green"></i>right lens: active within 72 h</span>' +
                  '<span><i class="lens-sample amber"></i>72 h to 6 months</span>' +
                  '<span><i class="lens-sample"></i>longer / never / unknown</span>' +
                  '<button type="button" class="chassis-zoom-btn" onclick="window.toggleChassisZoom()" title="Draw the panels at double width (scrolls sideways)">' + (zoomed ? 'Fit' : 'Zoom') + '</button>' +
                  '</div>'
                : '<div class="chassis-note">No hardware or interface data to draw a front panel from.</div>';
            renderedFor = device;
        }
        root.classList.toggle('zoomed', zoomed);
        var states = lightStates(device, snapshotAgeSeconds(device));
        root.querySelectorAll('[data-lightfor]').forEach(function (el) {
            var st = states[el.getAttribute('data-lightfor')];
            el.classList.remove('green', 'amber', 'red');
            if (!st) return;
            var v = el.getAttribute('data-role') === 'link' ? st.link : st.act;
            if (v !== 'off') el.classList.add(v);
        });
        window.highlightChassisPort(selectedPort);
    };

    window.highlightChassisPort = function (port) {
        var root = document.getElementById('chassis-view');
        if (!root) return;
        root.querySelectorAll('.port-body.selected, .uplink-body.selected').forEach(function (el) { el.classList.remove('selected'); });
        if (!port) return;
        var g = root.querySelector('.port-el[data-port="' + (window.CSS && CSS.escape ? CSS.escape(port) : port) + '"]');
        if (!g) return;
        var body = g.querySelector('.port-body, .uplink-body');
        if (body) body.classList.add('selected');
    };

    // Click a jack/cage -> drawer.js's selectInterfacePort; hover -> tooltip with the
    // interface name and its state. Delegated once; the SVGs are rebuilt per device but
    // #chassis-view itself is permanent. The tooltip is one fixed-position element appended
    // to <body> so the drawer's overflow can't clip it.
    document.addEventListener('DOMContentLoaded', function () {
        var root = document.getElementById('chassis-view');
        if (!root) return;
        var tip = document.createElement('div');
        tip.className = 'chassis-tooltip';
        tip.hidden = true;
        document.body.appendChild(tip);
        var portOf = function (ev) { return ev.target.closest ? ev.target.closest('.port-el[data-port]') : null; };
        var place = function (ev) {
            var pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
            var x = ev.clientX + pad, y = ev.clientY + pad;
            if (x + w > window.innerWidth - 4) x = ev.clientX - w - pad;   // flip left near the right edge (the drawer lives there)
            if (y + h > window.innerHeight - 4) y = ev.clientY - h - pad;
            tip.style.left = x + 'px';
            tip.style.top = y + 'px';
        };
        root.addEventListener('mouseover', function (ev) {
            var g = portOf(ev);
            if (!g) return;
            var name = document.createElement('b');
            name.textContent = g.getAttribute('data-port');
            tip.replaceChildren(name);
            var detail = g.getAttribute('data-tip');
            if (detail) { var span = document.createElement('span'); span.textContent = detail; tip.appendChild(span); }
            tip.hidden = false;
            place(ev);
        });
        root.addEventListener('mousemove', function (ev) { if (!tip.hidden) place(ev); });
        root.addEventListener('mouseout', function (ev) {
            var g = portOf(ev);
            // Leaving one jack for a sibling fires mouseover for the new one right after; only
            // hide when the pointer actually left a jack for something that isn't one.
            if (g && !(ev.relatedTarget && ev.relatedTarget.closest && ev.relatedTarget.closest('.port-el[data-port]') === g)) tip.hidden = true;
        });
        // While a mouse button is held, Chromium keeps delivering mouse events to the element
        // the press started on and never fires mouseout for it - so dragging off a jack (or
        // starting a drag on one) left the tooltip stranded. Hide on press, and on any move
        // anywhere that isn't over a jack, which also covers releasing outside the panel.
        root.addEventListener('mousedown', function () { tip.hidden = true; });
        document.addEventListener('mousemove', function (ev) {
            if (tip.hidden) return;
            var over = ev.target && ev.target.closest ? ev.target.closest('.port-el[data-port]') : null;
            if (!over) tip.hidden = true;
        });
        document.addEventListener('mouseleave', function () { tip.hidden = true; });
        root.addEventListener('click', function (ev) {
            var g = portOf(ev);
            if (!g || g.classList.contains('port-absent')) return;
            if (typeof window.selectInterfacePort === 'function') window.selectInterfacePort(g.getAttribute('data-port'), { source: 'chassis' });
        });
    });
}
})();
