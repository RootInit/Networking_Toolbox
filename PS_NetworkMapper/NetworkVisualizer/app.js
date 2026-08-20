/**
 * Global Error Catcher
 */
window.onerror = function(message, source, lineno, colno, error) {
    var errText = `Message: ${message}<br>Line: ${lineno}:${colno}<br>Source: ${source}<br>Stack: ${error ? error.stack : 'N/A'}`;
    var textEl = document.getElementById('fatal-error-text');
    var modalEl = document.getElementById('fatal-error-modal');
    if (textEl && modalEl) {
        textEl.innerHTML = errText;
        modalEl.style.display = 'block';
    }
    if (typeof window.hideProgress === 'function') window.hideProgress();
    return true; 
};

// Protect Globals
var network = null;
var globalTopologyData = [];
var nodesDataset = null;
var edgesDataset = null;
var allVlans = new Map(); 
var currentSelectedNodeData = null;
var searchHighlightQuery = "";

// Deterministic layout state (see graph-layout.js / elk-layout.js).
var allNodeMeta = new Map();   // id -> {label, shape, isStack, vlanCache, scanned}
var allEdges = [];             // {from, to}[]
var graphRoot = null;
var primaryTree = { parentOf: new Map(), childrenOf: new Map(), secondaryEdges: [] };
var expandedNodes = new Set();
var clusterThreshold = 8;

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
    get clusterThreshold() { return clusterThreshold; },
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

// Escape device-supplied strings (hostnames, LLDP descriptions, etc. come from other
// network devices, not from this app, before they're interpolated into innerHTML.
var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
window.esc = function(val) {
    if (val === null || val === undefined) return "";
    return String(val).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
};

// UI Helpers
window.setStatus = function(msg, color="blue") {
    var el = document.getElementById('status-text');
    if(el) { el.innerText = msg; el.style.color = color; }
};

window.showProgress = function(text, percent) {
    document.getElementById('loadingBar').style.display = 'flex';
    document.getElementById('progress-text').innerText = text;
    document.getElementById('progress-fill').style.width = percent + '%';
};

window.hideProgress = function() {
    document.getElementById('loadingBar').style.display = 'none';
};

window.closeDrawer = function() {
    document.getElementById('right-panel').style.display = 'none';
    currentSelectedNodeData = null;
    if (network) network.unselectAll();
};

window.switchTab = function(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    
    if (currentSelectedNodeData) {
        if (tabId === 'tab-neighbors') window.renderNeighbors();
        if (tabId === 'tab-interfaces') window.renderInterfaces();
        if (tabId === 'tab-clients') window.renderClients();
    }
};

window.setClusterThreshold = function(value) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 2) return;
    clusterThreshold = n;
    window.renderVisibleGraph();
};

// 1. File Loading & Parsing
window.forceLoadFile = function() {
    var input = document.getElementById('jsonUpload');
    var btn = document.getElementById('loadBtn');
    
    if (!input.files || input.files.length === 0) {
        window.setStatus("Please select a JSON file.", "red");
        return;
    }

    btn.disabled = true;
    window.closeDrawer();
    var file = input.files[0];
    window.setStatus(`Reading file...`, "orange");

    var reader = new FileReader();
    
    reader.onerror = function() { 
        btn.disabled = false; 
        window.setStatus("Browser blocked read access.", "red"); 
        throw new Error("FileReader denied access to local file. Check browser CORS policies.");
    };
    
    reader.onprogress = function(e) {
        if (e.lengthComputable) {
            window.showProgress(`Reading File...`, Math.round((e.loaded / e.total) * 100));
        }
    };

    reader.onload = function(e) {
        window.showProgress("Processing Enterprise Topology...", 100);
        
        setTimeout(async function() {
            var parseSucceeded = false;
            try {
                var data = JSON.parse(e.target.result);
                if (!data.Topology) throw new Error("Missing 'Topology' array in JSON.");
                parseSucceeded = true;

                globalTopologyData = data.Topology;

                // Clients arrive pre-correlated (MAC table + cross-device ARP enrichment
                // done server-side by Start-NetworkMapper.ps1); the visualizer just displays them.
                globalTopologyData.forEach(device => { device.TrueClients = device.Clients || []; });

                window.extractVlans();
                await window.buildSwitchMap();

                document.getElementById('legend-group').style.display = 'block';
                window.setStatus(`Success! Mapped ${globalTopologyData.length} nodes.`, "green");
            } catch (err) {
                window.setStatus(parseSucceeded ? "Render error - see details." : "JSON Parse Error.", "red");
                throw err;
            } finally {
                btn.disabled = false;
            }
        }, 100);
    };
    
    reader.readAsText(file);
};

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
            vlanSelect.innerHTML += `<option value="${tag}">VLAN ${tag} - ${allVlans.get(tag.toString())}</option>`; 
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
    renderChain = renderChain.then(doRenderVisibleGraph).catch(err => { console.error('renderVisibleGraph failed:', err); throw err; });
    return renderChain;
};

async function doRenderVisibleGraph() {
    window.showProgress("Computing layout...", 100);
    var visible = window.GraphLayout.computeVisibleTree(graphRoot, primaryTree.childrenOf, expandedNodes, clusterThreshold);
    var positions = await window.ElkLayout.computeLayout(visible.visibleNodeIds, visible.visibleEdges);

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

    window.hideProgress();
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

window.performGlobalSearch = function() {
    var query = document.getElementById('globalSearch').value.toLowerCase().trim();
    searchHighlightQuery = query;
    
    if (!query) {
        if (currentSelectedNodeData) window.openRightDrawer(currentSelectedNodeData.DeviceIP);
        return;
    }

    var targetIp = null;
    for (var i = 0; i < globalTopologyData.length; i++) {
        var device = globalTopologyData[i];
        if (String(device.DeviceIP).toLowerCase().includes(query) || (device.Hostname && String(device.Hostname).toLowerCase().includes(query))) {
            targetIp = device.DeviceIP; break;
        }
        if (device.TrueClients && device.TrueClients.find(c => (c.IP && String(c.IP).toLowerCase().includes(query)) || (c.MAC && String(c.MAC).toLowerCase().includes(query)) || (c.Dot1x_User && String(c.Dot1x_User).toLowerCase().includes(query)))) {
            targetIp = device.DeviceIP; break;
        }
    }

    if (targetIp) {
        (async () => {
            window.GraphLayout.expandAncestors(primaryTree.parentOf, primaryTree.childrenOf, targetIp, expandedNodes, clusterThreshold);
            await window.renderVisibleGraph();
            network.selectNodes([targetIp]);
            network.focus(targetIp, { scale: 1.0, animation: { duration: 500 } });
            window.openRightDrawer(targetIp);
            if (!targetIp.toLowerCase().includes(query)) { window.switchTab('tab-clients'); }
        })();
    }
};

// 4. Data Drawer Renderer
window.openRightDrawer = function(ip) {
    currentSelectedNodeData = globalTopologyData.find(d => String(d.DeviceIP) === String(ip));
    var panel = document.getElementById('right-panel');
    document.getElementById('drawer-title').innerText = ip;
    
    if (!currentSelectedNodeData) {
        document.getElementById('summary-content').innerHTML = `<div style="color:red; padding:20px;">No diagnostic data found (Unscanned Node).</div>`;
        panel.style.display = 'flex'; 
        return;
    }

    window.renderSummary();
    window.renderStack();
    window.renderNeighbors();
    window.renderInterfaces();
    window.renderClients();
    
    panel.style.display = 'flex';
};

window.renderSummary = function() {
    var d = currentSelectedNodeData;
    var html = `
        <div class="summary-item"><label>Hostname</label><div>${esc(d.Hostname) || 'N/A'}</div></div>
        <div class="summary-item"><label>IP Address</label><div>${esc(d.DeviceIP) || 'N/A'}</div></div>
        <div class="summary-item"><label>Junos OS</label><div>${esc(d.JunosVersion) || 'N/A'}</div></div>
        <div class="summary-item"><label>Gateway</label><div>${esc(d.Gateway) || 'N/A'}</div></div>
        <div class="summary-item"><label>Connected Neighbors</label><div>${d.Neighbors ? d.Neighbors.length : 0} Switches</div></div>
    `;
    document.getElementById('summary-content').innerHTML = html;
};

window.renderStack = function() {
    var tbody = document.getElementById('stack-tbody');
    var html = "";
    if (currentSelectedNodeData.StackMembers && currentSelectedNodeData.StackMembers.length > 0) {
        currentSelectedNodeData.StackMembers.forEach(sm => {
            var roleBadge = String(sm.Role).includes("Master") ? "green" : (String(sm.Role).includes("Backup") ? "accent" : "gray");
            html += `<tr>
                <td><b>${esc(sm.FPC) || "?"}</b></td>
                <td><span class="badge ${roleBadge}">${esc(sm.Role) || "?"}</span></td>
                <td>${esc(sm.Model) || "?"}</td>
                <td style="font-family:monospace;">${esc(sm.Serial) || "?"}</td>
            </tr>`;
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="4" style="text-align:center;">No hardware data</td></tr>`;
};

window.renderNeighbors = function() {
    var tbody = document.getElementById('neighbors-tbody');
    var html = "";
    if (currentSelectedNodeData.Neighbors && currentSelectedNodeData.Neighbors.length > 0) {
        currentSelectedNodeData.Neighbors.forEach(n => {
            html += `<tr>
                <td><b>${esc(n.LocalPort) || "?"}</b></td>
                <td>${esc(n.Hostname) || "Unknown"}<br><span style="font-family:monospace; color:#666; font-size:0.75rem;">${esc(n.ManagementIP) || "Unknown"}</span></td>
                <td>${esc(n.RemotePort) || "?"}</td>
                <td style="font-style:italic; color:#666;">${esc(n.Description)}</td>
            </tr>`;
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="4" style="text-align:center;">No LLDP neighbors found</td></tr>`;
};

window.renderInterfaces = function() {
    var tbody = document.getElementById('interfaces-tbody');
    var hideDown = document.getElementById('hideDownPorts').checked;
    var html = "";
    
    if (currentSelectedNodeData.Interfaces && Array.isArray(currentSelectedNodeData.Interfaces)) {
        currentSelectedNodeData.Interfaces.forEach(intf => {
            if (!intf.Port || String(intf.Port).includes('.')) return;
            
            if (hideDown && String(intf.Link).toLowerCase() !== "up") return;

            var linkBadge = String(intf.Link).toLowerCase() === "up" ? "green" : "red";
            var stpBadge = String(intf.STP) === "FWD" ? "green" : (String(intf.STP) === "BLK" ? "red" : "gray");
            var poeTxt = (!intf.PoE || intf.PoE === "Unknown") ? "-" : intf.PoE;
            
            html += `<tr>
                <td><b>${esc(intf.Port)}</b></td>
                <td><span class="badge ${linkBadge}">${esc(intf.Admin)}/${esc(intf.Link)}</span></td>
                <td><span class="badge ${stpBadge}">${esc(intf.STP) || "?"}</span></td>
                <td>${esc(poeTxt)}</td>
                <td style="font-style:italic; color:#666;">${esc(intf.Desc)}</td>
            </tr>`;
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="5" style="text-align:center;">No interface data</td></tr>`;
};

window.renderClients = function() {
    var tbody = document.getElementById('clients-tbody');
    var vlanFilter = document.getElementById('vlanFilter').value;
    var html = "";
    
    if (currentSelectedNodeData.TrueClients && currentSelectedNodeData.TrueClients.length > 0) {
        var clients = currentSelectedNodeData.TrueClients;
        
        if (vlanFilter !== "ALL") { 
            clients = clients.filter(c => String(c.VLAN_Tag) === vlanFilter.toString()); 
        }
        
        clients = clients.sort((a, b) => {
            if (a.IP === "Unknown IP") return 1; if (b.IP === "Unknown IP") return -1;
            var numA = Number(String(a.IP).split('.').map(n => (`000${n}`).slice(-3)).join(''));
            var numB = Number(String(b.IP).split('.').map(n => (`000${n}`).slice(-3)).join(''));
            return numA - numB;
        });

        clients.forEach(c => {
            var isHighlighted = searchHighlightQuery && ((c.IP && String(c.IP).toLowerCase().includes(searchHighlightQuery)) || (c.MAC && String(c.MAC).toLowerCase().includes(searchHighlightQuery)) || (c.Dot1x_User && String(c.Dot1x_User).toLowerCase().includes(searchHighlightQuery)));
            var rowClass = isHighlighted ? 'highlight' : '';
            
            var dotUserStr = (c.Dot1x_User && c.Dot1x_User !== "Unknown") ? esc(c.Dot1x_User) : "None";
            var dotStateColor = (c.Dot1x_State && String(c.Dot1x_State).includes('Auth')) ? 'green' : (c.Dot1x_State !== "Unknown" ? 'red' : 'gray');
            var dotStateStr = c.Dot1x_State !== "Unknown" ? `<br><span style="font-size:0.7rem; color:${dotStateColor};">(${esc(c.Dot1x_State)})</span>` : "";
            var descStr = (c.PortDesc && c.PortDesc !== "Unknown") ? `<br><span style="font-size:0.75rem; color:#888;">${esc(c.PortDesc)}</span>` : "";
            var typeClass = String(c.Type).toLowerCase().startsWith('dynamic') ? 'dynamic' : 'static';
            var typeStr = (c.Type && c.Type !== "Unknown") ? `<span class="type-badge ${typeClass}">${esc(c.Type)}</span>` : "";

            html += `<tr class="${rowClass}">
                <td><span style="font-weight:bold; color:#2B7CE9; font-size:1rem;">${esc(c.IP)}</span><br><span style="font-family:monospace; color:#666;">${esc(String(c.MAC).toUpperCase())}</span></td>
                <td><b>${esc(c.Port)}</b><br><span class="badge" style="background:#2c3e50;">VLAN ${esc(c.VLAN_Tag)}</span>${typeStr}${descStr}</td>
                <td><b>${dotUserStr}</b>${dotStateStr}</td>
            </tr>`;
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="3" style="text-align:center;">No edge clients found</td></tr>`;
    
    if (searchHighlightQuery) {
        var highlightedEl = tbody.querySelector('.highlight');
        if (highlightedEl) highlightedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};
