// Topology data -> node/edge metadata -> vis-network rendering. Owns the graph-structure
// state (allNodeMeta/allEdges/graphRoot/primaryTree/expandedNodes) and the vis.Network
// instance's lifecycle. Reads globalTopologyData/network/nodesDataset/edgesDataset
// (declared in app.js) and window.GraphLayout/window.ElkLayout (graph-layout.js/
// elk-layout.js).

// Deterministic layout state (see graph-layout.js / elk-layout.js).
var allNodeMeta = new Map();   // id -> {label, shape, isStack, vlanCache, scanned}
var allEdges = [];             // {from, to}[]
var graphRoot = null;
var primaryTree = { parentOf: new Map(), childrenOf: new Map(), secondaryEdges: [] };
var expandedNodes = new Set();

// clusterThreshold is read fresh from the DOM on every use (see getClusterThreshold
// below) instead of cached from the input's `change` event - relying on that event
// having already fired left the very first render after a page load using the stale
// default whenever change didn't fire in time, silently clustering any root with more
// than that many immediate children into a single node. Keep in sync with
// network_vis.html's #clusterThreshold input value.
function getClusterThreshold() {
    var el = document.getElementById('clusterThreshold');
    var n = el ? parseInt(el.value, 10) : NaN;
    return (Number.isFinite(n) && n >= 2) ? n : 50;
}

// Same "read live from the DOM, never cache" approach as getClusterThreshold above -
// same bug class, same fix. Falls back to graph-layout.js's own defaults (via undefined)
// whenever a field is missing/invalid, rather than duplicating those default numbers here.
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

// CDP/headless-browser verification needs to inspect internal state. Kept even though
// app.js is a classic script again (its top-level vars ARE window properties) because
// every verification step written while it was still a module already depends on this
// exact interface - removing it would mean touching all of that again for no benefit.
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
            device.TrueClients.forEach(c => {
                if (c.VLAN_Tag && String(c.VLAN_Tag).toLowerCase() !== "unknown") {
                    allVlans.set(String(c.VLAN_Tag), c.VLAN_Name || "Unknown");
                }
            });
        }
    });

    var vlanSelect = document.getElementById('vlanFilter');
    vlanSelect.innerHTML = '<option value="ALL">Show All VLANs</option>';

    if (allVlans.size > 0) {
        var sortedTags = Array.from(allVlans.keys()).map(Number).sort((a,b) => a-b);
        sortedTags.forEach(tag => {
            vlanSelect.innerHTML += `<option value="${tag}">VLAN ${tag} - ${esc(allVlans.get(tag.toString()))}</option>`;
        });
    }
};

// 2. Topology data -> node/edge metadata (positions are computed separately by renderVisibleGraph)
window.buildSwitchMap = async function() {
    allNodeMeta.clear();
    allEdges = [];
    var addedEdges = new Set();

    // Pass 1: every device that was actually scanned gets a fully-styled node,
    // even if another device already referenced its IP as a neighbor below.
    globalTopologyData.forEach(device => {
        if (!device || !device.DeviceIP) return;

        var switchIp = String(device.DeviceIP);
        var hostname = device.Hostname || "Unknown";
        var isStack = !!(device.StackMembers && device.StackMembers.length > 1);
        var stackIcon = isStack ? `\n[VC: ${device.StackMembers.length} Node]` : "";

        allNodeMeta.set(switchIp, {
            label: `Switch\n${switchIp}\n(${hostname})${stackIcon}`,
            shape: isStack ? 'database' : 'box', isStack: isStack, scanned: true,
            vlanCache: device.TrueClients ? device.TrueClients.map(c => String(c.VLAN_Tag)) : [],
        });
    });

    // Pass 2: neighbors mentioned via LLDP that were never themselves scanned
    // get a placeholder node instead.
    globalTopologyData.forEach(device => {
        if (!device || !device.DeviceIP || !device.Neighbors) return;
        var switchIp = String(device.DeviceIP);

        device.Neighbors.forEach(neighbor => {
            var neighborIp = String(neighbor.ManagementIP);
            if (!neighborIp || neighborIp === "Unknown" || neighborIp === "0.0.0.0") return;

            if (!allNodeMeta.has(neighborIp)) {
                allNodeMeta.set(neighborIp, {
                    label: `Switch\n${neighborIp}\n(${neighbor.Hostname || "Unknown"})`,
                    shape: 'box', isStack: false, scanned: false, vlanCache: [],
                });
            }

            var edgeKey = [switchIp, neighborIp].sort().join('-');
            if (!addedEdges.has(edgeKey)) {
                allEdges.push({ from: switchIp, to: neighborIp });
                addedEdges.add(edgeKey);
            }
        });
    });

    var nodeIds = Array.from(allNodeMeta.keys());
    graphRoot = window.GraphLayout.computeGraphRoot(nodeIds, allEdges);
    primaryTree = window.GraphLayout.buildPrimaryTree(nodeIds, allEdges, graphRoot);
    expandedNodes = new Set();

    if (network !== null) { network.destroy(); network = null; }
    var container = document.getElementById('mynetwork');
    network = new vis.Network(container, { nodes: nodesDataset, edges: edgesDataset }, {
        layout: { hierarchical: false },
        physics: { enabled: false },
        edges: { smooth: false },
        interaction: { navigationButtons: true, keyboard: true, hover: true, dragNodes: true },
    });
    // Clicking empty canvas space (no node, no edge) closes the drawer instead of leaving
    // it open pointing at whatever was last selected - vis-network still fires "click" for
    // a blank click even though nothing was selected, unlike "selectNode" below which only
    // fires when a node was actually hit.
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
        // Double-clicking a real node that's currently manually expanded collapses it
        // back down - the only way to undo an expand short of reloading the file.
        if (expandedNodes.has(id)) {
            expandedNodes.delete(id);
            window.renderVisibleGraph();
        }
    });

    await window.renderVisibleGraph();
};

// 2b. Recompute the visible subgraph (clustering) and lay it out. Owns the
// progress-bar lifecycle itself so every caller (initial load, cluster
// expand/collapse, threshold change, search) gets covered automatically -
// the ELK round-trip this awaits can take up to a few seconds on a large
// visible set, and the canvas would otherwise sit blank with no indicator.
var renderChain = Promise.resolve();
window.renderVisibleGraph = function() {
    // renderChain.catch(() => {}) swallows a PRIOR call's rejection before chaining the
    // next one, so one failed render doesn't permanently wedge every future call - only
    // this call's own outcome (thisRender) is what callers actually see and can react to.
    var thisRender = renderChain.catch(() => {}).then(doRenderVisibleGraph);
    renderChain = thisRender;
    thisRender.catch(err => { console.error('renderVisibleGraph failed:', err); });
    return thisRender;
};

async function doRenderVisibleGraph() {
    window.showProgress("Computing layout...", 100, true);
    await nextPaint();
    // Everything below is wrapped so a thrown error (a visible node id present in neither
    // allNodeMeta nor visible.clusters, say) can't leave the loading overlay stuck at
    // "Computing layout..." forever - renderVisibleGraph's caller only logs a rejection,
    // it doesn't call hideProgress itself, and window.onerror's own hideProgress call
    // only fires for an UNCAUGHT error, not one already caught by that .catch().
    try {
        var visible = window.GraphLayout.computeVisibleTree(graphRoot, primaryTree.childrenOf, expandedNodes, getClusterThreshold());
        var positions = await window.ElkLayout.computeLayout(visible.visibleNodeIds, visible.visibleEdges, getLayoutSettings());

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

        visible.visibleEdges.forEach((e, i) => {
            edgesDataset.add({ id: `primary-${i}`, from: e.from, to: e.to, width: 2, color: '#848484', dashes: false });
        });

        var visibleSet = new Set(visible.visibleNodeIds);
        primaryTree.secondaryEdges.forEach((e, i) => {
            if (visibleSet.has(e.from) && visibleSet.has(e.to)) {
                edgesDataset.add({ id: `secondary-${i}`, from: e.from, to: e.to, width: 1, color: '#c0c0c0', dashes: [4, 4] });
            }
        });

        var vlanFilterEl = document.getElementById('vlanFilter');
        if (vlanFilterEl && vlanFilterEl.value !== 'ALL') { window.applyVlanFilter(); }
    } finally {
        window.hideProgress();
    }
}

// 3. Global Filters
window.applyVlanFilter = function() {
    var selectedVlan = document.getElementById('vlanFilter').value;
    var scannedIps = new Set(globalTopologyData.filter(d => d && d.DeviceIP).map(d => String(d.DeviceIP)));
    var updates = [];

    nodesDataset.get().forEach(node => {
        if (node.isCluster) {
            // Collapsed groups have no VLAN data of their own (their members are hidden) -
            // always keep the gold/dashed "collapsed group" styling regardless of filter.
            return;
        }

        var matchesVlan = selectedVlan === "ALL" || (node.vlanCache && node.vlanCache.includes(selectedVlan.toString()));

        if (!scannedIps.has(String(node.id))) {
            // Unscanned neighbor placeholders always stay gray; a VLAN filter can only dim them further.
            updates.push({ id: node.id, color: { background: '#E8E8E8', border: '#B0B0B0' }, font: { color: matchesVlan ? '#666666' : '#dddddd' } });
        } else if (matchesVlan) {
            updates.push({ id: node.id, color: node.isStack ? { background: '#D2E5FF', border: '#2B7CE9' } : { background: '#97C2FC', border: '#2B7CE9' }, font: { color: 'black' } });
        } else {
            updates.push({ id: node.id, color: { background: '#f2f2f2', border: '#e6e6e6' }, font: { color: '#cccccc' } });
        }
    });
    nodesDataset.update(updates);

    if (currentSelectedNodeData) window.openRightDrawer(currentSelectedNodeData.DeviceIP);
};

window.setClusterThreshold = function(value) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 2) return;
    window.renderVisibleGraph();
};

// Layout settings (leaf-grid threshold/spacing) share the same "just trigger a
// re-render, the actual value is re-read live at render time" approach - see
// getLayoutSettings above.
window.setLayoutSetting = function() {
    window.renderVisibleGraph();
};
