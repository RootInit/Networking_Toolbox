// Topology data -> node/edge metadata -> vis-network rendering. Owns the vis.Network lifecycle.

var allNodeMeta = new Map();   // id -> {label, shape, isStack, vlanCache, scanned}
var allEdges = [];             // {from, to}[]
var graphRoot = null;
var primaryTree = { parentOf: new Map(), childrenOf: new Map(), secondaryEdges: [] };
var expandedNodes = new Set();
// Set when the vis.Network instance was constructed while #mynetwork was display:none, leaving a
// degenerate camera transform. Cleared only by resizeDiagram's fit(), never fighting the user.
var diagramSizedWhileHidden = false;
// A fresh vis.Network opens at 1:1 on the origin, showing a handful of nodes, so only the FIRST
// render of an instance fits - a cluster expand or setting change must keep the user's pan/zoom.
var fitOnNextRender = false;

// Read live from the DOM: the first render after page load can precede the input's change event.
function getClusterThreshold() {
    var el = document.getElementById('clusterThreshold');
    var n = el ? parseInt(el.value, 10) : NaN;
    return (Number.isFinite(n) && n >= 2) ? n : 50;
}

// undefined defers to graph-layout.js's own defaults when a field is missing or invalid.
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

// A failed vis.js load surfaces here rather than as a cryptic ReferenceError at first use.
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

// Bumped by buildSwitchMap before it replaces the graph state. doRenderVisibleGraph re-checks after
// its await and bails rather than mixing an old visible set with new metadata.
var renderGeneration = 0;

// Node/edge metadata only; positions are computed separately by renderVisibleGraph.
window.buildSwitchMap = async function() {
    renderGeneration++;
    allNodeMeta.clear();
    allEdges = window.TopologyGraph.computeNeighborEdges(globalTopologyData);

    // Copied in place rather than reassigned: other code holds a reference to this same Map.
    window.TopologyGraph.buildSwitchMapNodeMeta(globalTopologyData).forEach(function (meta, ip) {
        allNodeMeta.set(ip, meta);
    });

    var nodeIds = Array.from(allNodeMeta.keys());
    graphRoot = window.GraphLayout.computeGraphRoot(nodeIds, allEdges);
    primaryTree = window.GraphLayout.buildPrimaryTree(nodeIds, allEdges, graphRoot);
    expandedNodes = new Set();

    if (network !== null) { network.destroy(); network = null; }
    var container = document.getElementById('mynetwork');
    // While display:none, clientWidth/Height read 0 and vis fits against that. The canvas size
    // self-corrects once visible; the pan/zoom transform does not - resizeDiagram fixes it.
    diagramSizedWhileHidden = (container.clientWidth === 0 || container.clientHeight === 0);
    network = new vis.Network(container, { nodes: nodesDataset, edges: edgesDataset }, {
        layout: { hierarchical: false },
        physics: { enabled: false },
        edges: { smooth: false },
        // Declared globally: vis falls back to this whenever a node's own colour object omits
        // highlight, which the VLAN filter's wholesale rewrites do.
        nodes: { color: { highlight: { background: '#4CAF50', border: '#2E7D32' } } },
        // bindToWindow: false - vis binds keyboard shortcuts to window, eating "-" in text fields.
        // navigationButtons: false - replaced by #diagram-nav, which adds rotation and doesn't clip.
        interaction: { navigationButtons: false, keyboard: { bindToWindow: false }, hover: true, dragNodes: true },
    });
    fitOnNextRender = true;
    window.buildDiagramNav();
    // "selectNode" doesn't fire for a blank click, but "click" does, so close the drawer here.
    network.on("click", function (params) {
        if (params.nodes.length === 0 && params.edges.length === 0) window.closeDrawer();
    });
    network.on("selectNode", function (params) {
        if (params.nodes.length === 0) return;
        var id = params.nodes[0];
        var meta = allNodeMeta.get(id);
        if (meta) { window.openRightDrawer(id); return; }
        // No metadata means this is a cluster placeholder, not a device.
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

// Recomputes the visible subgraph and lays it out. Owns the progress bar so every caller is covered.
var renderChain = Promise.resolve();
window.renderVisibleGraph = function() {
    // A prior rejection is swallowed before chaining, so one failed render can't wedge the rest.
    var thisRender = renderChain.catch(() => {}).then(doRenderVisibleGraph);
    renderChain = thisRender;
    thisRender.catch(err => { console.error('renderVisibleGraph failed:', err); });
    return thisRender;
};

async function doRenderVisibleGraph() {
    var myGeneration = renderGeneration;
    window.showProgress("Computing layout...", 100, true);
    await nextPaint();
    // try/finally so a throw can't leave the overlay stuck at "Computing layout...".
    try {
        var visible = window.GraphLayout.computeVisibleTree(graphRoot, primaryTree.childrenOf, expandedNodes, getClusterThreshold(), primaryTree.extraRoots);
        var positions = await window.ElkLayout.computeLayout(visible.visibleNodeIds, visible.visibleEdges, getLayoutSettings());
        // buildSwitchMap ran during the await, so the graph state no longer matches `visible`.
        if (myGeneration !== renderGeneration) return;

        nodesDataset.clear(); edgesDataset.clear();

        // Added in one call each: vis redraws synchronously per dataset change and queues a repeat
        // via rAF, so n individual adds cost ~2n full repaints.
        var nodeRows = [], edgeRows = [];

        visible.visibleNodeIds.forEach(id => {
            var pos = positions.get(id) || { x: 0, y: 0 };
            var meta = allNodeMeta.get(id);
            if (meta) {
                nodeRows.push({
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
                nodeRows.push({
                    id: id, label: `+${cluster.memberIds.length} devices`, shape: 'box', isCluster: true,
                    // Keeps its own amber when selected: green means "this device's drawer is open".
                    color: { background: '#fdf6e3', border: '#d9b34e', highlight: { background: '#fdf6e3', border: '#d9b34e' } },
                    font: { bold: true, color: '#8a6d1a' },
                    borderWidth: 2, shapeProperties: { borderDashes: [6, 4] },
                    vlanCache: [], x: pos.x, y: pos.y, physics: false,
                });
            }
        });

        // Order-independent endpoint pairs, so a rerouted secondary edge can be spotted as a duplicate.
        var primaryPairs = new Set();
        visible.visibleEdges.forEach((e, i) => {
            edgeRows.push({ id: `primary-${i}`, from: e.from, to: e.to, width: 2, color: '#848484', dashes: false });
            var pKey = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from;
            primaryPairs.add(pKey);
        });

        var visibleSet = new Set(visible.visibleNodeIds);
        var seenSecondary = new Set();
        primaryTree.secondaryEdges.forEach((e, i) => {
            // A hidden endpoint reroutes to its cluster placeholder rather than being dropped.
            var from = visibleSet.has(e.from) ? e.from : visible.hiddenNodeToCluster.get(e.from);
            var to = visibleSet.has(e.to) ? e.to : visible.hiddenNodeToCluster.get(e.to);
            if (!from || !to || from === to) return;
            // Several hidden nodes can reroute to the same placeholder, so dedupe on the resolved
            // pair and skip pairs a primary edge already drew.
            var key = from < to ? from + '|' + to : to + '|' + from;
            if (seenSecondary.has(key) || primaryPairs.has(key)) return;
            seenSecondary.add(key);
            edgeRows.push({ id: `secondary-${i}`, from: from, to: to, width: 1, color: '#c0c0c0', dashes: [4, 4] });
        });

        nodesDataset.add(nodeRows);
        edgesDataset.add(edgeRows);

        if (fitOnNextRender) {
            fitOnNextRender = false;
            // A display:none container measures 0; resizeDiagram owns that case.
            if (!diagramSizedWhileHidden) network.fit();
        }

        var vlanFilterEl = document.getElementById('vlanFilter');
        if (vlanFilterEl && vlanFilterEl.value !== 'ALL') { window.applyVlanFilter(); }
    } finally {
        window.hideProgress();
    }
}

// Per-node "which VLANs are reachable through here": local client VLANs unioned with every VLAN
// under its primary-tree children - the only trunk signal available, since the crawler records
// per-client MAC-table tags, not trunk config. Walks the full childrenOf, not the visible subset.
function computeSubtreeVlanSets() {
    var result = new Map();
    function visit(id) {
        if (result.has(id)) return result.get(id);
        var meta = allNodeMeta.get(id);
        var set = new Set(meta ? meta.vlanCache : []);
        result.set(id, set); // set before recursing so a cyclic childrenOf can't loop forever
        (primaryTree.childrenOf.get(id) || []).forEach(childId => {
            visit(childId).forEach(v => set.add(v));
        });
        return set;
    }
    if (graphRoot) visit(graphRoot);
    // Disconnected islands are separate trees graphRoot's recursion never reaches.
    (primaryTree.extraRoots || []).forEach(r => visit(r));
    // Safety net: anything still unreached gets its local VLANs rather than an undefined lookup.
    allNodeMeta.forEach((meta, id) => { if (!result.has(id)) result.set(id, new Set(meta.vlanCache || [])); });
    return result;
}

// subtreeVlanSets is keyed by real device ids, so a `cluster:X` placeholder maps back to X. Without
// this, an edge with two synthetic endpoints always misses.
function vlanSetKeyFor(id) {
    var s = String(id);
    return s.indexOf('cluster:') === 0 ? s.slice('cluster:'.length) : s;
}

function edgeTrunksVlan(subtreeVlanSets, fromId, toId, vlanTag) {
    var fromSet = subtreeVlanSets.get(vlanSetKeyFor(fromId));
    var toSet = subtreeVlanSets.get(vlanSetKeyFor(toId));
    return !!((fromSet && fromSet.has(vlanTag)) || (toSet && toSet.has(vlanTag)));
}

window.applyVlanFilter = function() {
    // Map first: if the diagram work below throws, a user on Map view still sees the filter.
    if (typeof window.renderMapMarkers === 'function') window.renderMapMarkers();

    var selectedVlan = document.getElementById('vlanFilter').value;
    var scannedIps = new Set(globalTopologyData.filter(d => d && d.DeviceIP).map(d => String(d.DeviceIP)));
    var nodeUpdates = [];

    nodesDataset.get().forEach(node => {
        if (node.isCluster) {
            // Collapsed groups have no VLAN data of their own, so keep their styling.
            return;
        }

        var matchesVlan = selectedVlan === "ALL" || (node.vlanCache && node.vlanCache.includes(selectedVlan.toString()));

        if (!scannedIps.has(String(node.id))) {
            // Unscanned placeholders stay gray; the filter can only dim them further.
            nodeUpdates.push({ id: node.id, color: { background: '#E8E8E8', border: '#B0B0B0' }, font: { color: matchesVlan ? '#666666' : '#dddddd' } });
        } else if (matchesVlan) {
            nodeUpdates.push({ id: node.id, color: node.isStack ? { background: '#D2E5FF', border: '#2B7CE9' } : { background: '#97C2FC', border: '#2B7CE9' }, font: { color: 'black' } });
        } else {
            nodeUpdates.push({ id: node.id, color: { background: '#f2f2f2', border: '#e6e6e6' }, font: { color: '#cccccc' } });
        }
    });
    nodesDataset.update(nodeUpdates);

    // "ALL" resets every edge so a previous selection's highlighting can't stick.
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

// Refreshes one node after a rescan. Not buildSwitchMap, which would recreate the vis.Network and
// reset pan/zoom. .update() no-ops for a node in a collapsed cluster, which is correct.
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
        // Always scanned:true, so this also promotes a gray unscanned placeholder.
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

// No argument needed: getLayoutSettings re-reads the value live at render time.
window.setLayoutSetting = function() {
    window.renderVisibleGraph();
};

// Corrects a diagram built while #mynetwork was hidden. fit() is gated on diagramSizedWhileHidden
// because running it unconditionally would reset the user's pan/zoom on every view switch.
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
// A ring of eight segments (pan, zoom, rotate) around a "fit to view" centre. Lives in
// #center-panel, so it survives graph rebuilds.
var DIAGRAM_NAV_STEP_PX = 120;      // pan distance per tick, in screen pixels
var DIAGRAM_NAV_ZOOM = 1.18;
var DIAGRAM_NAV_ROTATE_DEG = 15;

window.buildDiagramNav = function() {
    var host = document.getElementById('diagram-nav');
    if (!host || host.dataset.built) return;
    host.dataset.built = '1';
    var C = 75, R = 72, r = 32;   // centre, outer radius, inner (button) radius
    // Clockwise from the top.
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

// vis-network has no camera rotation, so the layout itself is rotated around the view centre.
// Physics is off, so the new coordinates stick; any re-layout resets the angle.
function rotateDiagram(deg) {
    var rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    var centre = network.getViewPosition();
    var positions = network.getPositions();
    Object.keys(positions).forEach(function (id) {
        var p = positions[id], dx = p.x - centre.x, dy = p.y - centre.y;
        network.moveNode(id, centre.x + dx * cos - dy * sin, centre.y + dx * sin + dy * cos);
    });
}
