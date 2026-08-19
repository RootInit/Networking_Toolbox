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
var globalArpMap = new Map();
var nodesDataset = null;
var edgesDataset = null;
var allVlans = new Map(); 
var currentSelectedNodeData = null;
var searchHighlightQuery = "";
var physicsEnabled = true;

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
        if (tabId === 'tab-interfaces') window.renderInterfaces();
        if (tabId === 'tab-clients') window.renderClients();
    }
};

window.togglePhysics = function() {
    if (!network) return;
    var btn = document.getElementById('physicsToggle');
    physicsEnabled = !physicsEnabled;
    network.setOptions({ physics: { enabled: physicsEnabled } });
    btn.innerText = physicsEnabled ? "Freeze Map Layout" : "Unfreeze Map Layout";
    btn.style.backgroundColor = physicsEnabled ? "#f39c12" : "#27ae60";
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
        
        setTimeout(function() {
            try {
                var data = JSON.parse(e.target.result);
                if (!data.Topology) throw new Error("Missing 'Topology' array in JSON.");
                
                globalTopologyData = data.Topology;
                
                // Build Global ARP Correlation Map
                globalArpMap.clear();
                globalTopologyData.forEach(device => {
                    if (device.ArpEntries) {
                        device.ArpEntries.forEach(arp => {
                            if(arp.MAC && arp.IP) globalArpMap.set(arp.MAC.toLowerCase(), arp.IP);
                        });
                    }
                });

                // Correlate Clients Safely
                globalTopologyData.forEach(device => {
                    device.TrueClients = [];
                    
                    // FIX: Fallback to directly using Clients if MacTable is not present
                    if (!device.MacTable) {
                        if (device.Clients) {
                            device.TrueClients = device.Clients;
                        }
                        return;
                    }
                    
                    // Safely extract trunk ports (ignore nulls)
                    var trunkPorts = [];
                    if (device.Neighbors) {
                        device.Neighbors.forEach(n => {
                            if (n && n.LocalPort && typeof n.LocalPort === 'string') {
                                trunkPorts.push(n.LocalPort.split('.')[0]);
                            }
                        });
                    }

                    device.MacTable.forEach(macEntry => {
                        // FIX: Safely check for valid Port strings before parsing
                        if (!macEntry || !macEntry.Port || typeof macEntry.Port !== 'string') return;
                        
                        var physPort = macEntry.Port.split('.')[0];
                        
                        // Ignore Trunks, Lag (ae), Redundant Ethernet (reth), and IRB/VLAN interfaces
                        if (trunkPorts.includes(physPort) || physPort.startsWith('ae') || physPort.startsWith('reth') || physPort.startsWith('vlan') || physPort.startsWith('irb')) return;

                        var clientIP = globalArpMap.get(macEntry.MAC.toLowerCase()) || "Unknown IP";
                        var dotUser = "Unknown", dotState = "Unknown";
                        
                        if (device.Clients) {
                            var dotMatch = device.Clients.find(c => c.MAC && c.MAC.toLowerCase() === macEntry.MAC.toLowerCase());
                            if (dotMatch) { 
                                dotUser = dotMatch.Dot1x_User || "Unknown"; 
                                dotState = dotMatch.Dot1x_State || "Unknown"; 
                            }
                        }

                        device.TrueClients.push({
                            IP: clientIP, MAC: macEntry.MAC, Port: macEntry.Port, PortDesc: macEntry.PortDesc || "Unknown",
                            VLAN_Name: macEntry.VLAN_Name || "Unknown", VLAN_Tag: macEntry.VLAN_Tag || "Unknown",
                            Type: macEntry.Type || "Unknown", Dot1x_User: dotUser, Dot1x_State: dotState
                        });
                    });
                });

                window.extractVlans();
                window.buildSwitchMap();
                
                document.getElementById('physicsToggle').style.display = 'block';
                window.setStatus(`Success! Mapped ${globalTopologyData.length} nodes.`, "green");
            } catch (err) { 
                window.setStatus("JSON Parse Error.", "red"); 
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

// 2. THE REPULSION GRAPH ENGINE
window.buildSwitchMap = function() {
    window.hideProgress(); 

    nodesDataset.clear(); edgesDataset.clear();
    var addedNodes = new Set(); var addedEdges = new Set();

    globalTopologyData.forEach(device => {
        if (!device || !device.DeviceIP) return; 
        
        var switchIp = String(device.DeviceIP);
        var hostname = device.Hostname || "Unknown";
        var isStack = false; var stackIcon = "";
        
        if (device.StackMembers && device.StackMembers.length > 1) {
            isStack = true; stackIcon = `\n[VC: ${device.StackMembers.length} Node]`;
        }

        if (!addedNodes.has(switchIp)) {
            nodesDataset.add({ 
                id: switchIp, label: `Switch\n${switchIp}\n(${hostname})${stackIcon}`, 
                shape: isStack ? 'database' : 'box', 
                color: { background: '#97C2FC', border: '#2B7CE9' }, font: { multi: true, bold: true, color: 'black' }, 
                vlanCache: device.TrueClients ? device.TrueClients.map(c => String(c.VLAN_Tag)) : [],
                x: Math.random() * 4000 - 2000, y: Math.random() * 4000 - 2000
            });
            addedNodes.add(switchIp);
        }

        if (device.Neighbors) {
            device.Neighbors.forEach(neighbor => {
                var neighborIp = String(neighbor.ManagementIP);
                if (!neighborIp || neighborIp === "Unknown" || neighborIp === "0.0.0.0") return;

                if (!addedNodes.has(neighborIp)) {
                    nodesDataset.add({ 
                        id: neighborIp, label: `Switch\n${neighborIp}\n(${neighbor.Hostname || "Unknown"})`, 
                        shape: 'box', color: { background: '#E8E8E8', border: '#B0B0B0' }, font: { multi: true, bold: true, color: '#666666' }, 
                        vlanCache: [], x: Math.random() * 4000 - 2000, y: Math.random() * 4000 - 2000
                    });
                    addedNodes.add(neighborIp);
                }
                
                var edgeId = [switchIp, neighborIp].sort().join('-');
                if (!addedEdges.has(edgeId)) {
                    edgesDataset.add({ id: edgeId, from: switchIp, to: neighborIp, width: 2, color: '#848484', smooth: { type: 'continuous', roundness: 0.2 } });
                    addedEdges.add(edgeId);
                }
            });
        }
    });

    if (network !== null) { network.destroy(); }
    
    var container = document.getElementById('mynetwork');
    var options = {
        layout: { hierarchical: false }, 
        physics: {
            enabled: true,
            solver: 'forceAtlas2Based',
            forceAtlas2Based: { gravitationalConstant: -300, centralGravity: 0.005, springLength: 350, springConstant: 0.05, avoidOverlap: 1 },
            maxVelocity: 50, minVelocity: 0.1, stabilization: false 
        }, 
        interaction: { navigationButtons: true, keyboard: true, hover: true }
    };
    
    network = new vis.Network(container, { nodes: nodesDataset, edges: edgesDataset }, options);
    physicsEnabled = true;

    network.on("selectNode", function (params) {
        if (params.nodes.length > 0) window.openRightDrawer(params.nodes[0]);
    });
};

// 3. Global Filters
window.applyVlanFilter = function() {
    var selectedVlan = document.getElementById('vlanFilter').value;
    var updates = [];

    nodesDataset.get().forEach(node => {
        if (selectedVlan === "ALL" || (node.vlanCache && node.vlanCache.includes(selectedVlan.toString()))) {
            var isStack = node.label.includes("[VC:");
            updates.push({ id: node.id, color: isStack ? { background: '#D2E5FF', border: '#2B7CE9' } : { background: '#97C2FC', border: '#2B7CE9' }, font: { color: 'black' } });
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
        network.selectNodes([targetIp]);
        network.focus(targetIp, { scale: 1.0, animation: { duration: 500 } });
        window.openRightDrawer(targetIp);
        if (!targetIp.toLowerCase().includes(query)) { window.switchTab('tab-clients'); }
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
    window.renderInterfaces();
    window.renderClients();
    
    panel.style.display = 'flex';
};

window.renderSummary = function() {
    var d = currentSelectedNodeData;
    var html = `
        <div class="summary-item"><label>Hostname</label><div>${d.Hostname || 'N/A'}</div></div>
        <div class="summary-item"><label>IP Address</label><div>${d.DeviceIP || 'N/A'}</div></div>
        <div class="summary-item"><label>Junos OS</label><div>${d.JunosVersion || 'N/A'}</div></div>
        <div class="summary-item"><label>Gateway</label><div>${d.Gateway || 'N/A'}</div></div>
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
                <td><b>${sm.FPC || "?"}</b></td>
                <td><span class="badge ${roleBadge}">${sm.Role || "?"}</span></td>
                <td>${sm.Model || "?"}</td>
                <td style="font-family:monospace;">${sm.Serial || "?"}</td>
            </tr>`;
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="4" style="text-align:center;">No hardware data</td></tr>`;
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
                <td><b>${intf.Port}</b></td>
                <td><span class="badge ${linkBadge}">${intf.Admin}/${intf.Link}</span></td>
                <td><span class="badge ${stpBadge}">${intf.STP || "?"}</span></td>
                <td>${poeTxt}</td>
                <td style="font-style:italic; color:#666;">${intf.Desc || ""}</td>
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
            
            var dotUserStr = (c.Dot1x_User && c.Dot1x_User !== "Unknown") ? c.Dot1x_User : "None";
            var dotStateColor = (c.Dot1x_State && String(c.Dot1x_State).includes('Auth')) ? 'green' : (c.Dot1x_State !== "Unknown" ? 'red' : 'gray');
            var dotStateStr = c.Dot1x_State !== "Unknown" ? `<br><span style="font-size:0.7rem; color:${dotStateColor};">(${c.Dot1x_State})</span>` : "";
            var descStr = (c.PortDesc && c.PortDesc !== "Unknown") ? `<br><span style="font-size:0.75rem; color:#888;">${c.PortDesc}</span>` : "";

            html += `<tr class="${rowClass}">
                <td><span style="font-weight:bold; color:#2B7CE9; font-size:1rem;">${c.IP}</span><br><span style="font-family:monospace; color:#666;">${String(c.MAC).toUpperCase()}</span></td>
                <td><b>${c.Port}</b><br><span class="badge" style="background:#2c3e50;">VLAN ${c.VLAN_Tag}</span>${descStr}</td>
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
