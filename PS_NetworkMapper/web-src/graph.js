// Topology data -> node/edge metadata -> vis-network rendering. Owns the graph-structure
// state and the vis.Network instance's lifecycle. Reads globalTopologyData/network/
// nodesDataset/edgesDataset (app.js) and window.GraphLayout/window.ElkLayout.

// Deterministic layout state (see graph-layout.js / elk-layout.js).
var allNodeMeta = new Map();   // id -> {label, shape, isStack, vlanCache, scanned}
var allEdges = [];             // {from, to}[]
var graphRoot = null;
var primaryTree = { parentOf: new Map(), childrenOf: new Map(), secondaryEdges: [] };
var expandedNodes = new Set();
// True whenever buildSwitchMap most recently (re)constructed the vis.Network instance while
// #mynetwork was display:none (see window.resizeDiagram below) - i.e. there's a pending
// degenerate camera transform that a plain redraw won't correct. Only reset when
// resizeDiagram actually runs fit(), so the user's own pan/zoom is never fought otherwise.
var diagramSizedWhileHidden = false;

// Read fresh from the DOM on every use rather than cached from the input's `change`
// event, since the first render after page load could otherwise run before that event
// fires and silently use the stale default.
function getClusterThreshold() {
    var el = document.getElementById('clusterThreshold');
    var n = el ? parseInt(el.value, 10) : NaN;
    return (Number.isFinite(n) && n >= 2) ? n : 50;
}

// Same live-DOM-read approach as getClusterThreshold. Falls back to graph-layout.js's
// own defaults (via undefined) when a field is missing/invalid.
function readPositiveIntSetting(id, min) {
    var el = document.getElementById(id);
    var n = el ? parseInt(el.value, 10) : NaN;
    return (Number.isFinite(n) && n >= min) ? n : undefined;
}
function getLayoutSettings() {
    return {
        nodeSpacing: readPositiveIntSetting('nodeSpacing', 20),
        leafSpacing: readPositiveIntSetting('leafSpacing', 20),
        minRadius: readPositiveIntSetting('minRadius', 20),
    };
}

// CDP/headless-browser verification needs to inspect internal state.
window.__debug = {
    get nodesDataset() { return nodesDataset; },
    get edgesDataset() { return edgesDataset; },
    get network() { return network; },
    get expandedNodes() { return expandedNodes; },
    get graphRoot() { return graphRoot; },
    get primaryTree() { return primaryTree; },
    get clusterThreshold() { return getClusterThreshold(); },
};

// Ensure Vis.js is ready before declaring DataSets
document.addEventListener("DOMContentLoaded", function() {
    try {
        if (typeof vis !== 'undefined') {
            nodesDataset = new vis.DataSet();
            edgesDataset = new vis.DataSet();
        } else {
            throw new Error("Vis.js library failed to load. Check your internet connection or CDN.");
        }
    } catch (e) {
        window.onerror(e.message, "app.js", 0, 0, e);
    }
});

window.extractVlans = function() {
    allVlans.clear();
    globalTopologyData.forEach(device => {
        if (device.TrueClients) {
            window.asArray(device.TrueClients).forEach(c => {
                if (c.VLAN_Tag && String(c.VLAN_Tag).toLowerCase() !== "unknown") {
                    allVlans.set(String(c.VLAN_Tag), c.VLAN_Name || "Unknown");
                }
            });
        }
    });

    var vlanSelect = document.getElementById('vlanFilter');
    vlanSelect.innerHTML = '<option value="ALL">Show All VLANs</option>';

    if (allVlans.size > 0) {
        var sortedTags = Array.from(allVlans.keys()).sort((a,b) => Number(a) - Number(b));
        sortedTags.forEach(tag => {
            vlanSelect.innerHTML += `<option value="${esc(tag)}">VLAN ${esc(tag)} - ${esc(allVlans.get(tag))}</option>`;
        });
    }
};

// Bumped by buildSwitchMap before it mutates allNodeMeta/graphRoot/primaryTree/expandedNodes
// and tears down/recreates `network`. renderVisibleGraph's own queuing only serializes CALLS
// to it - it doesn't stop buildSwitchMap from mutating this state out from under a render
// that's already in progress (e.g. still awaiting ElkLayout.computeLayout) when a snapshot
// switch or reload triggers a fresh buildSwitchMap. doRenderVisibleGraph checks this after
// its own await and bails rather than resuming against a mix of the old visible-set/positions
// and the new allNodeMeta/primaryTree - a subsequent renderVisibleGraph() (buildSwitchMap
// always calls one itself, at the end) supersedes it with a consistent render anyway.
var renderGeneration = 0;

// 2. Topology data -> node/edge metadata (positions are computed separately by renderVisibleGraph)
window.buildSwitchMap = async function() {
    renderGeneration++;
    allNodeMeta.clear();
    allEdges = window.TopologyGraph.computeNeighborEdges(globalTopologyData);

    // Node label/shape/vlanCache construction lives in topology-graph.js (buildSwitchMapNodeMeta)
    // so it's shared with, and exercised directly by, that file's regression test - rather than
    // being reimplemented here with no real coverage. Copy into allNodeMeta in place; other code
    // in this file holds a reference to this same Map instance.
    window.TopologyGraph.buildSwitchMapNodeMeta(globalTopologyData).forEach(function (meta, ip) {
        allNodeMeta.set(ip, meta);
    });

    var nodeIds = Array.from(allNodeMeta.keys());
    graphRoot = window.GraphLayout.computeGraphRoot(nodeIds, allEdges);
    primaryTree = window.GraphLayout.buildPrimaryTree(nodeIds, allEdges, graphRoot);
    expandedNodes = new Set();

    if (network !== null) { network.destroy(); network = null; }
    var container = document.getElementById('mynetwork');
    // Construction while #mynetwork is display:none reads clientWidth/clientHeight as 0,
    // so vis-network's initial camera fit is against a bogus size - the canvas's own pixel
    // size self-corrects once visible again, but the pan/zoom transform does not. See
    // resizeDiagram below for the fix.
    diagramSizedWhileHidden = (container.clientWidth === 0 || container.clientHeight === 0);
    network = new vis.Network(container, { nodes: nodesDataset, edges: edgesDataset }, {
        layout: { hierarchical: false },
        physics: { enabled: false },
        edges: { smooth: false },
        // bindToWindow: false - vis-network's keyboard shortcuts (+/- zoom, arrow-key pan)
        // default to binding on window, not the graph container, so typing "-" in any text
        // field elsewhere on the page (an IP, a note, a search box) got eaten as a zoom-out
        // instead of typing a dash. Scoped to the container, they only fire while it has focus.
        // navigationButtons: false - vis-network's own green corner buttons are replaced by
        // #diagram-nav (window.buildDiagramNav below), which adds rotation and stays inside
        // the canvas instead of clipping at its bottom edge.
        interaction: { navigationButtons: false, keyboard: { bindToWindow: false }, hover: true, dragNodes: true },
    });
    window.buildDiagramNav();
    // vis-network still fires "click" for a blank click (unlike "selectNode"), so close
    // the drawer instead of leaving it pointing at a stale selection.
    network.on("click", function (params) {
        if (params.nodes.length === 0 && params.edges.length === 0) window.closeDrawer();
    });
    network.on("selectNode", function (params) {
        if (params.nodes.length === 0) return;
        var id = params.nodes[0];
        var meta = allNodeMeta.get(id);
        if (meta) { window.openRightDrawer(id); return; }
        // Not real device metadata - it's a cluster placeholder. Toggle expansion.
        var clusterParentId = id.startsWith('cluster:') ? id.slice('cluster:'.length) : null;
        if (clusterParentId) {
            expandedNodes.add(clusterParentId);
            window.renderVisibleGraph();
        }
    });
    network.on("doubleClick", function (params) {
        if (params.nodes.length === 0) return;
        var id = params.nodes[0];
        // Only way to undo a manual expand short of reloading the file.
        if (expandedNodes.has(id)) {
            expandedNodes.delete(id);
            window.renderVisibleGraph();
        }
    });

    await window.renderVisibleGraph();
};

// 2b. Recompute the visible subgraph (clustering) and lay it out. Owns the progress-bar
// lifecycle itself so every caller is covered - the ELK round-trip can take a few seconds
// on a large visible set.
var renderChain = Promise.resolve();
window.renderVisibleGraph = function() {
    // Swallow a PRIOR call's rejection before chaining, so one failed render doesn't wedge
    // every future call - only this call's own outcome (thisRender) reaches its caller.
    var thisRender = renderChain.catch(() => {}).then(doRenderVisibleGraph);
    renderChain = thisRender;
    thisRender.catch(err => { console.error('renderVisibleGraph failed:', err); });
    return thisRender;
};

async function doRenderVisibleGraph() {
    var myGeneration = renderGeneration;
    window.showProgress("Computing layout...", 100, true);
    await nextPaint();
    // Wrapped so a thrown error can't leave the loading overlay stuck at "Computing
    // layout..." forever - the caller only logs a rejection, it doesn't hide progress.
    try {
        var visible = window.GraphLayout.computeVisibleTree(graphRoot, primaryTree.childrenOf, expandedNodes, getClusterThreshold(), primaryTree.extraRoots);
        var positions = await window.ElkLayout.computeLayout(visible.visibleNodeIds, visible.visibleEdges, getLayoutSettings());
        // buildSwitchMap ran while the above awaited - graphRoot/primaryTree/allNodeMeta/
        // `network` are now for a different topology than `visible` was computed from.
        // Bail without touching nodesDataset/edgesDataset; buildSwitchMap's own trailing
        // renderVisibleGraph() call will render the new topology correctly right after this.
        if (myGeneration !== renderGeneration) return;

        nodesDataset.clear(); edgesDataset.clear();

        visible.visibleNodeIds.forEach(id => {
            var pos = positions.get(id) || { x: 0, y: 0 };
            var meta = allNodeMeta.get(id);
            if (meta) {
                nodesDataset.add({
                    id: id, label: meta.label, shape: meta.shape, isStack: meta.isStack,
                    color: meta.scanned
                        ? (meta.isStack ? { background: '#D2E5FF', border: '#2B7CE9' } : { background: '#97C2FC', border: '#2B7CE9' })
                        : { background: '#E8E8E8', border: '#B0B0B0' },
                    font: { multi: true, bold: true, color: meta.scanned ? 'black' : '#666666' },
                    vlanCache: meta.vlanCache, x: pos.x, y: pos.y, physics: false,
                    title: expandedNodes.has(id) ? 'Double-click to collapse' : undefined,
                });
            } else {
                var cluster = visible.clusters.get(id);
                nodesDataset.add({
                    id: id, label: `+${cluster.memberIds.length} devices`, shape: 'box', isCluster: true,
                    color: { background: '#fdf6e3', border: '#d9b34e' },
                    font: { bold: true, color: '#8a6d1a' },
                    borderWidth: 2, shapeProperties: { borderDashes: [6, 4] },
                    vlanCache: [], x: pos.x, y: pos.y, physics: false,
                });
            }
        });

        // Tracks each primary edge's resolved endpoint pair (order-independent) so a
        // rerouted secondary edge landing on the exact same pair - e.g. a switch linked
        // to a neighbor by both a primary LLDP-tree link and a redundant/backup link,
        // where that neighbor's own subtree just collapsed into a cluster placeholder -
        // can be recognized as a visual duplicate of the primary edge already rendered.
        var primaryPairs = new Set();
        visible.visibleEdges.forEach((e, i) => {
            edgesDataset.add({ id: `primary-${i}`, from: e.from, to: e.to, width: 2, color: '#848484', dashes: false });
            var pKey = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from;
            primaryPairs.add(pKey);
        });

        var visibleSet = new Set(visible.visibleNodeIds);
        var seenSecondary = new Set();
        primaryTree.secondaryEdges.forEach((e, i) => {
            // A secondary/redundant edge whose real endpoint is hidden inside a collapsed
            // cluster gets rerouted to that cluster's placeholder node instead of being
            // dropped, mirroring how computeVisibleTree already reroutes primary edges.
            var from = visibleSet.has(e.from) ? e.from : visible.hiddenNodeToCluster.get(e.from);
            var to = visibleSet.has(e.to) ? e.to : visible.hiddenNodeToCluster.get(e.to);
            if (!from || !to || from === to) return;
            // Several distinct hidden nodes can all reroute to the same cluster placeholder
            // (e.g. multiple redundant links into one collapsed subtree) - dedupe on the
            // resolved pair so they don't stack into overlapping parallel edges. Also skip
            // a pair that a primary edge already rendered (e.g. the cluster's own primary
            // parent-to-placeholder edge) so the secondary edge doesn't visually duplicate it.
            var key = from < to ? from + '|' + to : to + '|' + from;
            if (seenSecondary.has(key) || primaryPairs.has(key)) return;
            seenSecondary.add(key);
            edgesDataset.add({ id: `secondary-${i}`, from: from, to: to, width: 1, color: '#c0c0c0', dashes: [4, 4] });
        });

        var vlanFilterEl = document.getElementById('vlanFilter');
        if (vlanFilterEl && vlanFilterEl.value !== 'ALL') { window.applyVlanFilter(); }
    } finally {
        window.hideProgress();
    }
}

// Bottom-up, per-node "which VLANs are reachable through here" - a node's own local
// client VLANs, unioned with every VLAN reachable through its primary-tree children. This
// is the only trunk-membership signal available since the crawler records per-client MAC
// table VLAN tags, not interface trunk config. Operates on the full primaryTree.childrenOf
// (not the visible/clustered subset), so VLANs inside a collapsed cluster still count on
// the visible edge leading into it.
function computeSubtreeVlanSets() {
    var result = new Map();
    function visit(id) {
        if (result.has(id)) return result.get(id); // guards a malformed/cyclic childrenOf
        var meta = allNodeMeta.get(id);
        var set = new Set(meta ? meta.vlanCache : []);
        result.set(id, set); // set before recursing so a cycle can't loop forever
        (primaryTree.childrenOf.get(id) || []).forEach(childId => {
            visit(childId).forEach(v => set.add(v));
        });
        return set;
    }
    if (graphRoot) visit(graphRoot);
    // Disconnected fabric islands (buildPrimaryTree.extraRoots) are separate trees, not
    // reachable via graphRoot's own recursion - walk each one too so their subtree VLAN
    // unions are computed the same way, instead of only getting each node's own local
    // VLANs via the fallback below.
    (primaryTree.extraRoots || []).forEach(r => visit(r));
    // Anything buildPrimaryTree still didn't reach (shouldn't happen now that
    // extraRoots covers every component, but kept as a safety net) still gets its own
    // local VLANs rather than an undefined lookup later.
    allNodeMeta.forEach((meta, id) => { if (!result.has(id)) result.set(id, new Set(meta.vlanCache || [])); });
    return result;
}

// A `cluster:X` placeholder id is never itself a key in subtreeVlanSets (that map is only
// keyed by real device ids), but X's own entry already IS the union of X's local VLANs plus
// everything reachable through its full subtree - collapsed or not, since computeSubtreeVlanSets
// recurses over the full primaryTree.childrenOf regardless of what's currently visible. So a
// `cluster:X` id resolves to that same entry by stripping the prefix back to X. For a primary
// cluster edge (real parent -> its own cluster:parent placeholder) this was already safe because
// the real parent side alone carried the answer; this also makes a cluster-to-cluster secondary
// edge (both endpoints synthetic, e.g. a redundant link between two independently-collapsed
// subtrees) resolve correctly instead of always missing.
function vlanSetKeyFor(id) {
    var s = String(id);
    return s.indexOf('cluster:') === 0 ? s.slice('cluster:'.length) : s;
}

function edgeTrunksVlan(subtreeVlanSets, fromId, toId, vlanTag) {
    var fromSet = subtreeVlanSets.get(vlanSetKeyFor(fromId));
    var toSet = subtreeVlanSets.get(vlanSetKeyFor(toId));
    return !!((fromSet && fromSet.has(vlanTag)) || (toSet && toSet.has(vlanTag)));
}

// 3. Global Filters
window.applyVlanFilter = function() {
    // Refresh the map FIRST, before the diagram-only work below - if that later work
    // throws, a user on Map view should still see the filter applied to their own view.
    // No-ops if Map view was never opened (leafletMap === null).
    if (typeof window.renderMapMarkers === 'function') window.renderMapMarkers();

    var selectedVlan = document.getElementById('vlanFilter').value;
    var scannedIps = new Set(globalTopologyData.filter(d => d && d.DeviceIP).map(d => String(d.DeviceIP)));
    var nodeUpdates = [];

    nodesDataset.get().forEach(node => {
        if (node.isCluster) {
            // Collapsed groups have no VLAN data of their own - keep the gold/dashed
            // "collapsed group" styling regardless of filter.
            return;
        }

        var matchesVlan = selectedVlan === "ALL" || (node.vlanCache && node.vlanCache.includes(selectedVlan.toString()));

        if (!scannedIps.has(String(node.id))) {
            // Unscanned neighbor placeholders stay gray; a VLAN filter can only dim them further.
            nodeUpdates.push({ id: node.id, color: { background: '#E8E8E8', border: '#B0B0B0' }, font: { color: matchesVlan ? '#666666' : '#dddddd' } });
        } else if (matchesVlan) {
            nodeUpdates.push({ id: node.id, color: node.isStack ? { background: '#D2E5FF', border: '#2B7CE9' } : { background: '#97C2FC', border: '#2B7CE9' }, font: { color: 'black' } });
        } else {
            nodeUpdates.push({ id: node.id, color: { background: '#f2f2f2', border: '#e6e6e6' }, font: { color: '#cccccc' } });
        }
    });
    nodesDataset.update(nodeUpdates);

    // Links that trunk the selected VLAN get emphasized like matching nodes; others fade.
    // "ALL" resets every edge to its plain default styling rather than leaving a previous
    // selection's highlighting stuck.
    var subtreeVlanSets = selectedVlan !== "ALL" ? computeSubtreeVlanSets() : null;
    var edgeUpdates = [];
    edgesDataset.get().forEach(edge => {
        var isPrimary = String(edge.id).indexOf('primary-') === 0;
        var baseColor = isPrimary ? '#848484' : '#c0c0c0';
        var baseWidth = isPrimary ? 2 : 1;
        var baseDashes = isPrimary ? false : [4, 4];

        if (!subtreeVlanSets) {
            edgeUpdates.push({ id: edge.id, color: baseColor, width: baseWidth, dashes: baseDashes });
            return;
        }

        var trunks = edgeTrunksVlan(subtreeVlanSets, edge.from, edge.to, selectedVlan.toString());
        edgeUpdates.push(trunks
            ? { id: edge.id, color: '#2B7CE9', width: baseWidth + 1, dashes: baseDashes }
            : { id: edge.id, color: '#e6e6e6', width: baseWidth, dashes: baseDashes });
    });
    edgesDataset.update(edgeUpdates);

    if (currentSelectedNodeData) window.openRightDrawer(currentSelectedNodeData.DeviceIP);
};

// Updates one node's metadata and (if currently visible) its rendered appearance after a
// single-device rescan. Deliberately NOT window.buildSwitchMap(), which would destroy/
// recreate the vis.Network instance and reset pan/zoom + collapse expanded clusters.
// .update() (not .add()) is a no-op if the node is hidden inside a collapsed cluster,
// which is correct - this only refreshes data, not graph shape/visibility.
window.refreshNodeVisual = function(ip) {
    var device = globalTopologyData.find(d => d && String(d.DeviceIP) === String(ip));
    if (!device) return;

    var switchIp = String(device.DeviceIP);
    var hostname = device.Hostname || "Unknown";
    var isStack = !!(device.StackMembers && device.StackMembers.length > 1);
    var stackIcon = isStack ? `\n[VC: ${device.StackMembers.length} Node]` : "";

    var meta = {
        label: `Switch\n${switchIp}\n(${hostname})${stackIcon}`,
        shape: isStack ? 'database' : 'box', isStack: isStack, scanned: true,
        vlanCache: device.TrueClients ? window.asArray(device.TrueClients).map(c => String(c.VLAN_Tag)) : [],
    };
    allNodeMeta.set(switchIp, meta);

    if (nodesDataset && nodesDataset.get(switchIp)) {
        // A rescanned device is always "scanned:true" - covers both a data refresh and a
        // gray unscanned placeholder being promoted to a real scanned node.
        nodesDataset.update({
            id: switchIp, label: meta.label, shape: meta.shape, isStack: meta.isStack,
            color: meta.isStack ? { background: '#D2E5FF', border: '#2B7CE9' } : { background: '#97C2FC', border: '#2B7CE9' },
            font: { multi: true, bold: true, color: 'black' },
            vlanCache: meta.vlanCache,
        });
    }
};

window.setClusterThreshold = function(value) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 2) return;
    window.renderVisibleGraph();
};

// Just trigger a re-render - the value is re-read live at render time (getLayoutSettings).
window.setLayoutSetting = function() {
    window.renderVisibleGraph();
};

// Called from map.js's switchCenterView when switching TO diagram view, so a diagram built
// while #mynetwork was hidden gets corrected. setSize+redraw always run (cheap, fixes
// canvas pixel size). fit() runs only once, only when diagramSizedWhileHidden is true -
// an unconditional fit() would reset the user's pan/zoom on every plain view switch.
window.resizeDiagram = function() {
    if (!network) return;
    network.setSize('100%', '100%');
    network.redraw();
    if (diagramSizedWhileHidden) {
        network.fit();
        diagramSizedWhileHidden = false;
    }
};

// ---- Diagram navigation widget (#diagram-nav) ----
// A ring of eight segments around a centre button, replacing vis-network's built-in
// navigation buttons: pan (N/E/S/W), zoom (+/-), rotate the whole layout (left/right), and
// "fit to view" in the middle. Pan and zoom repeat while the pointer is held; rotation steps
// 15 degrees per click. Drawn once as SVG; the same element survives graph rebuilds because
// it lives in #center-panel, not inside #mynetwork.
var DIAGRAM_NAV_STEP_PX = 120;      // pan distance per tick, in screen pixels
var DIAGRAM_NAV_ZOOM = 1.18;        // zoom factor per tick
var DIAGRAM_NAV_ROTATE_DEG = 15;

window.buildDiagramNav = function() {
    var host = document.getElementById('diagram-nav');
    if (!host || host.dataset.built) return;
    host.dataset.built = '1';
    var C = 75, R = 72, r = 32;   // centre, outer radius, inner (button) radius
    // Segment order clockwise from the top: up, rotate-right, right, zoom-in, down, zoom-out, left, rotate-left.
    var segs = [
        { a: 'up',      glyph: 'M-6,3 L0,-3 L6,3' },
        { a: 'rotcw',   glyph: 'M-5,4 A7,7 0 1 1 5,-2 M5,-2 L5,-7 M5,-2 L0,-2' },
        { a: 'right',   glyph: 'M-3,-6 L3,0 L-3,6' },
        { a: 'zoomin',  glyph: 'M0,-6 V6 M-6,0 H6 M0,0 m-9,0 a9,9 0 1 0 18,0 a9,9 0 1 0 -18,0' },
        { a: 'down',    glyph: 'M-6,-3 L0,3 L6,-3' },
        { a: 'zoomout', glyph: 'M-6,0 H6 M0,0 m-9,0 a9,9 0 1 0 18,0 a9,9 0 1 0 -18,0' },
        { a: 'left',    glyph: 'M3,-6 L-3,0 L3,6' },
        { a: 'rotccw',  glyph: 'M5,4 A7,7 0 1 0 -5,-2 M-5,-2 L-5,-7 M-5,-2 L0,-2' },
    ];
    var titles = { up: 'Pan up', down: 'Pan down', left: 'Pan left', right: 'Pan right', zoomin: 'Zoom in', zoomout: 'Zoom out', rotcw: 'Rotate clockwise', rotccw: 'Rotate counter-clockwise' };
    var polar = function (rad, deg) { var t = (deg - 90) * Math.PI / 180; return [C + rad * Math.cos(t), C + rad * Math.sin(t)]; };
    var f = function (v) { return v.toFixed(2); };
    var html = '<svg viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg">';
    segs.forEach(function (s, i) {
        var a0 = i * 45 - 22.5, a1 = a0 + 45, mid = a0 + 22.5;
        var o0 = polar(R, a0), o1 = polar(R, a1), i0 = polar(r + 2, a0), i1 = polar(r + 2, a1);
        var d = 'M' + f(o0[0]) + ',' + f(o0[1]) + ' A' + R + ',' + R + ' 0 0 1 ' + f(o1[0]) + ',' + f(o1[1]) +
                ' L' + f(i1[0]) + ',' + f(i1[1]) + ' A' + (r + 2) + ',' + (r + 2) + ' 0 0 0 ' + f(i0[0]) + ',' + f(i0[1]) + ' Z';
        var g = polar((R + r + 2) / 2, mid);
        html += '<path class="nav-seg" data-action="' + s.a + '" d="' + d + '"><title>' + titles[s.a] + '</title></path>' +
                '<path class="nav-glyph" transform="translate(' + f(g[0]) + ',' + f(g[1]) + ')" d="' + s.glyph + '"></path>';
    });
    html += '<circle class="nav-center" data-action="fit" cx="' + C + '" cy="' + C + '" r="' + r + '"><title>Fit whole diagram</title></circle>' +
            '<path class="nav-glyph" transform="translate(' + C + ',' + C + ')" d="M-9,-3 V-9 H-3 M3,-9 H9 V-3 M9,3 V9 H3 M-3,9 H-9 V3"></path>' +
            '<circle class="nav-ring" cx="' + C + '" cy="' + C + '" r="' + R + '"></circle></svg>';
    host.innerHTML = html;

    // Press-and-hold repeat for pan/zoom; single step for rotate and fit.
    var holdTimer = null, heldEl = null;
    var stop = function () { if (holdTimer) { clearInterval(holdTimer); holdTimer = null; } if (heldEl) { heldEl.classList.remove('held'); heldEl = null; } };
    host.addEventListener('mousedown', function (ev) {
        var el = ev.target.closest('[data-action]');
        if (!el || !network) return;
        ev.preventDefault();
        var action = el.dataset.action;
        window.diagramNavAction(action);
        if (action === 'fit' || action === 'rotcw' || action === 'rotccw') return;
        heldEl = el; el.classList.add('held');
        holdTimer = setInterval(function () { window.diagramNavAction(action); }, 140);
    });
    document.addEventListener('mouseup', stop);
    host.addEventListener('mouseleave', stop);
};

window.diagramNavAction = function(action) {
    if (!network) return;
    var scale = network.getScale();
    var view = network.getViewPosition();
    var anim = { duration: 120, easingFunction: 'linear' };
    switch (action) {
        case 'up':    network.moveTo({ position: { x: view.x, y: view.y - DIAGRAM_NAV_STEP_PX / scale }, animation: anim }); break;
        case 'down':  network.moveTo({ position: { x: view.x, y: view.y + DIAGRAM_NAV_STEP_PX / scale }, animation: anim }); break;
        case 'left':  network.moveTo({ position: { x: view.x - DIAGRAM_NAV_STEP_PX / scale, y: view.y }, animation: anim }); break;
        case 'right': network.moveTo({ position: { x: view.x + DIAGRAM_NAV_STEP_PX / scale, y: view.y }, animation: anim }); break;
        case 'zoomin':  network.moveTo({ scale: scale * DIAGRAM_NAV_ZOOM, animation: anim }); break;
        case 'zoomout': network.moveTo({ scale: scale / DIAGRAM_NAV_ZOOM, animation: anim }); break;
        case 'fit': network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } }); break;
        case 'rotcw':  rotateDiagram(DIAGRAM_NAV_ROTATE_DEG); break;
        case 'rotccw': rotateDiagram(-DIAGRAM_NAV_ROTATE_DEG); break;
    }
};

// vis-network has no camera rotation, so rotate the layout itself: every node (clusters
// included - they are ordinary nodes in nodesDataset) swings around the current view
// centre. Physics is off and positions are fixed, so the new coordinates simply stick;
// a re-layout (renderVisibleGraph) recomputes positions from scratch and resets the angle.
function rotateDiagram(deg) {
    var rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    var centre = network.getViewPosition();
    var positions = network.getPositions();
    Object.keys(positions).forEach(function (id) {
        var p = positions[id], dx = p.x - centre.x, dy = p.y - centre.y;
        network.moveNode(id, centre.x + dx * cos - dy * sin, centre.y + dx * sin + dy * cos);
    });
}
