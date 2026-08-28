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
// True whenever buildSwitchMap most recently (re)constructed the vis.Network instance while
// #mynetwork was display:none (see window.resizeDiagram below) - i.e. there is a pending
// degenerate camera transform that a plain redraw won't correct. Deliberately NOT reset by
// anything except resizeDiagram actually running its fit() - same "only correct the thing
// that's actually broken, don't fight the user's own pan/zoom" reasoning as map.js's own
// hasFitBoundsOnce for the Leaflet side.
var diagramSizedWhileHidden = false;

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
    allEdges = window.TopologyGraph.computeNeighborEdges(globalTopologyData);

    var classification = window.TopologyGraph.computeDeviceClassification(globalTopologyData);
    var deviceByIpLocal = new Map(globalTopologyData.filter(d => d && d.DeviceIP).map(d => [String(d.DeviceIP), d]));
    var vlanCacheByIp = window.TopologyGraph.computeVlanCache(globalTopologyData);

    classification.forEach(function (meta, ip) {
        var device = deviceByIpLocal.get(ip);
        var stackIcon = meta.isStack ? `\n[VC: ${device.StackMembers.length} Node]` : "";
        allNodeMeta.set(ip, {
            label: meta.scanned
                ? `Switch\n${ip}\n(${meta.hostname})${stackIcon}`
                : `Switch\n${ip}\n(${meta.hostname})`,
            shape: meta.isStack ? 'database' : 'box', isStack: meta.isStack, scanned: meta.scanned,
            vlanCache: vlanCacheByIp.get(ip) || [],
        });
    });

    var nodeIds = Array.from(allNodeMeta.keys());
    graphRoot = window.GraphLayout.computeGraphRoot(nodeIds, allEdges);
    primaryTree = window.GraphLayout.buildPrimaryTree(nodeIds, allEdges, graphRoot);
    expandedNodes = new Set();

    if (network !== null) { network.destroy(); network = null; }
    var container = document.getElementById('mynetwork');
    // A construction while #mynetwork is display:none (e.g. a snapshot load/switch that
    // happened while Map view is showing) reads clientWidth/clientHeight as 0 - vis-network
    // computes its initial camera fit against that bogus size, which the container later
    // becoming visible again does not correct on its own (confirmed empirically: the
    // canvas's own pixel width/height self-corrects once visible again, but the pan/zoom
    // transform vis-network computed at construction time does not) - see resizeDiagram
    // below for the actual fix.
    diagramSizedWhileHidden = (container.clientWidth === 0 || container.clientHeight === 0);
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

// Bottom-up, per-node "which VLANs are reachable through here" - a node's own local
// clients' VLANs, unioned with every VLAN reachable through any of its primary-tree
// children. Every uplink toward the core necessarily carries whatever an access switch
// downstream of it serves, so this union is exactly "which VLANs does a link toward/
// through this node trunk" - the only trunk-membership signal available without a real
// "show vlans extensive"/trunk-config capture, which this repo doesn't collect today (the
// crawler only records per-client VLAN tags from the MAC table, not interface trunk
// membership). Operates on the full primaryTree.childrenOf, not the currently-visible/
// clustered subset, so a VLAN hidden inside a collapsed cluster is still correctly
// counted on the (visible) edge leading into that cluster.
function computeSubtreeVlanSets() {
    var result = new Map();
    function visit(id) {
        if (result.has(id)) return result.get(id); // guards a malformed/cyclic childrenOf, cheap either way
        var meta = allNodeMeta.get(id);
        var set = new Set(meta ? meta.vlanCache : []);
        result.set(id, set); // set before recursing so a cycle can't loop forever
        (primaryTree.childrenOf.get(id) || []).forEach(childId => {
            visit(childId).forEach(v => set.add(v));
        });
        return set;
    }
    if (graphRoot) visit(graphRoot);
    // Anything buildPrimaryTree didn't reach from graphRoot (a genuinely disconnected
    // device, if one ever exists) still gets its own local VLANs rather than an
    // undefined lookup later.
    allNodeMeta.forEach((meta, id) => { if (!result.has(id)) result.set(id, new Set(meta.vlanCache || [])); });
    return result;
}

// An edge into a collapsed cluster has the synthetic cluster id (never a key in
// subtreeVlanSets) as one endpoint - the other, real endpoint's accumulated set already
// includes every VLAN hidden inside that cluster (see computeSubtreeVlanSets), so falling
// back to whichever side resolves is correct, not a special case.
function edgeTrunksVlan(subtreeVlanSets, fromId, toId, vlanTag) {
    var fromSet = subtreeVlanSets.get(String(fromId));
    var toSet = subtreeVlanSets.get(String(toId));
    return !!((fromSet && fromSet.has(vlanTag)) || (toSet && toSet.has(vlanTag)));
}

// 3. Global Filters
window.applyVlanFilter = function() {
    // Refreshes the map FIRST, before any of the diagram-only work below (which touches
    // vis-network's nodesDataset/edgesDataset and, further down, openRightDrawer - a
    // 7-tab drawer render that isn't bulletproof against every possible device shape). If
    // any of that throws, a user on Map view would otherwise see the filter silently not
    // apply to the view they're actually looking at - the exact bug this function exists to
    // fix, just reintroduced under a different trigger. renderMapMarkers reads #vlanFilter
    // itself and no-ops if Map view has never been opened (leafletMap === null).
    if (typeof window.renderMapMarkers === 'function') window.renderMapMarkers();

    var selectedVlan = document.getElementById('vlanFilter').value;
    var scannedIps = new Set(globalTopologyData.filter(d => d && d.DeviceIP).map(d => String(d.DeviceIP)));
    var nodeUpdates = [];

    nodesDataset.get().forEach(node => {
        if (node.isCluster) {
            // Collapsed groups have no VLAN data of their own (their members are hidden) -
            // always keep the gold/dashed "collapsed group" styling regardless of filter.
            return;
        }

        var matchesVlan = selectedVlan === "ALL" || (node.vlanCache && node.vlanCache.includes(selectedVlan.toString()));

        if (!scannedIps.has(String(node.id))) {
            // Unscanned neighbor placeholders always stay gray; a VLAN filter can only dim them further.
            nodeUpdates.push({ id: node.id, color: { background: '#E8E8E8', border: '#B0B0B0' }, font: { color: matchesVlan ? '#666666' : '#dddddd' } });
        } else if (matchesVlan) {
            nodeUpdates.push({ id: node.id, color: node.isStack ? { background: '#D2E5FF', border: '#2B7CE9' } : { background: '#97C2FC', border: '#2B7CE9' }, font: { color: 'black' } });
        } else {
            nodeUpdates.push({ id: node.id, color: { background: '#f2f2f2', border: '#e6e6e6' }, font: { color: '#cccccc' } });
        }
    });
    nodesDataset.update(nodeUpdates);

    // Links that trunk the selected VLAN get emphasized the same way matching nodes do;
    // every other link fades - the same visual language as the node pass above, applied
    // to edges. "ALL" resets every edge back to its plain default styling (primary:
    // solid gray; secondary: thin dashed gray - matching doRenderVisibleGraph's own
    // initial values) rather than leaving a previous selection's highlighting stuck.
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
// single-device rescan (see drawer.js's mergeRescannedDevice) - deliberately NOT a call to
// window.buildSwitchMap(), which destroys and recreates the vis.Network instance,
// resetting pan/zoom and collapsing every manually-expanded cluster. A .update() (not
// .add()) on nodesDataset is a no-op if the node isn't currently rendered - e.g. it's
// hidden inside a collapsed cluster - which is the right behavior: this corrects one
// device's detail data, it does not attempt to keep the graph's shape/visibility live.
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
        vlanCache: device.TrueClients ? device.TrueClients.map(c => String(c.VLAN_Tag)) : [],
    };
    allNodeMeta.set(switchIp, meta);

    if (nodesDataset && nodesDataset.get(switchIp)) {
        // A rescanned device is always "scanned:true" now - covers both "existing scanned
        // node, data refreshed" and "was a gray unscanned LLDP placeholder, now promoted
        // to a real blue scanned node" with the same update call.
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

// Layout settings (leaf-grid threshold/spacing) share the same "just trigger a
// re-render, the actual value is re-read live at render time" approach - see
// getLayoutSettings above.
window.setLayoutSetting = function() {
    window.renderVisibleGraph();
};

// #mynetwork can be display:none while Map view is active (see map.js's switchCenterView) -
// called from map.js's switchCenterView whenever the user switches TO diagram view, so a
// diagram built (buildSwitchMap) while hidden is always corrected by the time it's actually
// looked at, regardless of what happened to it while it was hidden.
//
// setSize + redraw run every time - cheap, and correct the canvas's own pixel dimensions to
// the now-visible container regardless of cause. fit() is NOT unconditional, deliberately:
// re-framing the camera on every plain Map<->Diagram switch would reset the user's pan/zoom
// on every visit, which review waves on this branch have repeatedly flagged as worse than
// the bug being fixed (see hasFitBoundsOnce in map.js and refreshNodeVisual's comment above
// for the same principle applied to the Leaflet and single-device-update cases
// respectively). fit() only runs, and only once, when diagramSizedWhileHidden is true - i.e.
// buildSwitchMap actually (re)built the network against a bogus 0x0 size and its initial
// camera fit is genuinely degenerate, not just "the user switched tabs." Confirmed
// empirically (see final-followup-fix-report.md): an unconditional fit() measurably resets
// an in-progress pan/zoom on every switch; this guard eliminates that regression while still
// correcting the actual bug.
window.resizeDiagram = function() {
    if (!network) return;
    network.setSize('100%', '100%');
    network.redraw();
    if (diagramSizedWhileHidden) {
        network.fit();
        diagramSizedWhileHidden = false;
    }
};
