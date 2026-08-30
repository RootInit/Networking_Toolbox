// The right-hand device detail drawer: all seven tabs (Summary/Hardware/Alarms/Neighbors/
// Interfaces/Clients/Config), CSV/config export, the printable report, and the drawer's
// own open/close/tab-switch chrome. Reads currentSelectedNodeData/deviceByIp/
// loadedSnapshots/activeSnapshotIndex/searchHighlightQuery (app.js), calls
// window.asArray/lookupVendor/detectDaisyChains/renderDaisyChainBadge/setStatus
// (utils.js), and configSetDiff (dashboard.js, plain function - see its own comment).

window.closeDrawer = function() {
    document.getElementById('right-panel').style.display = 'none';
    var handle = document.getElementById('right-panel-handle');
    if (handle) handle.style.display = 'none';
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

// SSH quick-connect: a browser page can't spawn a process itself (no such API exists), but
// this is served by WebServer.ps1 - itself a PowerShell process on the analyst's own
// machine - so this can POST to that server's one fixed action instead:
// /api/connect launches lib\Connect-Switch.ps1 (a real interactive SSH session) against
// the given IP via Start-Process. Only works because the server is localhost-only; see
// WebServer.ps1's header comment.
window.copyConnectCommand = async function() {
    var ip = document.getElementById('drawer-title').innerText;
    if (!ip) return;
    var btn = document.getElementById('copyConnectBtn');
    var original = btn ? btn.textContent : null;
    try {
        if (btn) btn.textContent = 'Launching...';
        var resp = await fetch('/api/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: ip })
        });
        var result = await resp.json();
        if (!resp.ok) throw new Error(result.error || ('HTTP ' + resp.status));
        window.setStatus(`SSH session launched for ${ip}`, "green");
    } catch (e) {
        window.setStatus("Could not launch SSH session: " + e.message, "red");
    } finally {
        if (btn) setTimeout(() => { btn.textContent = original; }, 1500);
    }
};

// On-demand single-device rescan: re-runs the same fixed read-only diagnostic batch
// Get-JunosNodeData.ps1 already runs for a full crawl, against just this one IP, via
// WebServer.ps1's /api/rescan (async - see that endpoint's own comment for why a
// synchronous call would freeze the whole server). Works for the "Unscanned Node"
// placeholder case too (a device only ever seen as an LLDP neighbor) - that's a
// legitimate rescan target, not just a refresh of already-scanned data.
var rescanPollTimer = null;

window.rescanDevice = async function() {
    var ip = document.getElementById('drawer-title').innerText;
    if (!ip) return;
    var btn = document.getElementById('rescanBtn');
    var original = btn ? btn.textContent : null;

    function finish(msg, color) {
        if (rescanPollTimer) { clearTimeout(rescanPollTimer); rescanPollTimer = null; }
        if (btn) { btn.disabled = false; btn.textContent = original; }
        window.setStatus(msg, color);
    }

    var jobId;
    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Scanning...'; }
        var resp = await fetch('/api/rescan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: ip })
        });
        var result = await resp.json();
        if (resp.status === 409 && result.jobId) {
            // Only one rescan slot exists server-side. Attaching is only safe when it's
            // OUR device already in flight (e.g. a double-click) - the server hands back
            // which IP the running job is actually for, and if it's a different device,
            // silently attaching would poll that job to completion and then report ITS
            // result under this device's name once merged/messaged.
            if (result.ip !== ip) {
                finish("A rescan of " + result.ip + " is already running - try again once it finishes.", "red");
                return;
            }
            jobId = result.jobId;
        } else if (!resp.ok) {
            finish("Could not start rescan: " + (result.error || ('HTTP ' + resp.status)), "red");
            return;
        } else {
            jobId = result.jobId;
        }
    } catch (e) {
        finish("Could not start rescan: " + e.message, "red");
        return;
    }

    var pollStart = Date.now();
    var poll = async function() {
        // Client-side ceiling stays above the server's own ~90s hard timeout so the
        // browser never gives up before the server has had a chance to report one.
        if (Date.now() - pollStart > 100000) { finish("Rescan timed out waiting for a response.", "red"); return; }

        var statusResp;
        try {
            statusResp = await fetch('/api/rescan/status?jobId=' + encodeURIComponent(jobId));
        } catch (e) {
            finish("Lost connection to the local server - retry once it's running again.", "red");
            return;
        }

        if (statusResp.status === 404) {
            finish("Rescan job expired or the server restarted - try again.", "red");
            return;
        }

        var status;
        try {
            status = await statusResp.json();
        } catch (e) {
            finish("Lost connection to the local server - retry once it's running again.", "red");
            return;
        }

        if (!statusResp.ok) {
            finish("Rescan failed: " + (status.reason || ('HTTP ' + statusResp.status)) + " - existing data left unchanged.", "red");
            return;
        }
        if (status.status === 'timeout') {
            finish("Rescan of " + ip + " timed out.", "red");
            return;
        }
        if (status.status === 'running') {
            rescanPollTimer = setTimeout(poll, 2000);
            return;
        }
        // status.status === 'complete'
        if (!status.ok) {
            finish("Rescan failed: " + (status.reason || "unknown error") + " - existing data left unchanged.", "red");
            return;
        }
        window.mergeRescannedDevice(status.node);
        finish("Rescanned " + ip + " at " + new Date().toLocaleTimeString() + ".", "green");
    };
    poll();
};

// Quick reachability check via WebServer.ps1's /api/ping - a handful of ICMP echoes against
// this device's management IP, synchronous (unlike /api/rescan, a ping is a couple seconds
// at most, not worth a job-queue/poll dance for).
window.pingDevice = async function() {
    var ip = document.getElementById('drawer-title').innerText;
    if (!ip) return;
    var btn = document.getElementById('pingBtn');
    var original = btn ? btn.textContent : null;
    // Written to directly, not just window.setStatus (still called below for consistency
    // with every other drawer action) - #status-text lives in the left sidebar's Load File
    // tab, which is easy to not be looking at while sitting in THIS panel on the right; see
    // #pingResult's own comment in index.html.
    var resultEl = document.getElementById('pingResult');
    function showResult(msg, cls) {
        if (!resultEl) return;
        resultEl.textContent = msg;
        resultEl.className = cls || '';
    }

    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Pinging...'; }
        showResult('Pinging...', '');
        var resp = await fetch('/api/ping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: ip })
        });
        var result = await resp.json();
        if (!resp.ok) {
            var errMsg = "Could not ping " + ip + ": " + (result.error || ('HTTP ' + resp.status));
            showResult(errMsg, 'red');
            window.setStatus(errMsg, "red");
            return;
        }
        if (result.alive) {
            var okMsg = "Reachable (" + result.avgLatencyMs + "ms avg, " + result.received + "/" + result.sent + ")";
            showResult(okMsg, 'green');
            window.setStatus(ip + " is reachable (" + result.avgLatencyMs + "ms avg, " + result.received + "/" + result.sent + " replies).", "green");
        } else {
            var failMsg = "No response (" + result.received + "/" + result.sent + ")";
            showResult(failMsg, 'red');
            window.setStatus(ip + " did not respond to ping (" + result.received + "/" + result.sent + " replies).", "red");
        }
    } catch (e) {
        var exMsg = "Could not ping " + ip + ": " + e.message;
        showResult(exMsg, 'red');
        window.setStatus(exMsg, "red");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = original; }
    }
};

// Client-side port of Start-NetworkMapper.ps1's Update-ClientIpCorrelation. A
// single-device rescan only ever has that one switch's own local ARP table - a
// downstream client's IP is usually resolved from the L3 gateway's ARP table instead,
// which the full crawl correlates once across every device. Without re-running that same
// two-pass correlation after a merge, a client that showed a real IP (from the original
// crawl) would flip back to "Unknown" after "refreshing" its access switch - the exact
// opposite of what this feature is for.
function correlateClientIps(topology) {
    var globalArpMap = new Map();
    topology.forEach(device => {
        (device.ArpEntries || []).forEach(arp => {
            if (arp && arp.MAC && arp.IP) globalArpMap.set(arp.MAC, arp.IP);
        });
    });
    topology.forEach(device => {
        (device.Clients || []).forEach(client => {
            if (client && client.IP === "Unknown" && globalArpMap.has(client.MAC)) {
                client.IP = globalArpMap.get(client.MAC);
            }
        });
    });
}

// Merges a successful rescan result into the active snapshot's in-memory state only -
// never written back to the on-disk snapshot file. Two independent reasons: the loaded
// file may be encrypted and its password is deliberately not retained after use, and
// snapshot immutability is load-bearing for Topology Diff and cross-snapshot config
// compare elsewhere in this app. The rescanned data lives only in this tab, only for this
// session; RescannedAt (shown in the Summary tab) makes that ephemerality visible instead
// of surprising.
window.mergeRescannedDevice = function(freshDevice) {
    if (!freshDevice || !freshDevice.DeviceIP || activeSnapshotIndex < 0) return;
    var ip = String(freshDevice.DeviceIP);
    var topology = loadedSnapshots[activeSnapshotIndex].topology; // same array globalTopologyData references

    freshDevice.TrueClients = freshDevice.Clients || [];
    freshDevice.RescannedAt = new Date().toISOString();

    var index = topology.findIndex(d => d && String(d.DeviceIP) === ip);
    if (index === -1) {
        topology.push(freshDevice); // was an "Unscanned Node" placeholder until now
    } else {
        topology[index] = freshDevice;
    }

    correlateClientIps(topology);

    // buildSearchIndex() replaces snapshot.deviceByIp with a brand-new Map rather than
    // mutating the existing one - re-pointing the module-level deviceByIp variable here
    // is required, not optional, or search click-through would keep serving the stale
    // object even though the drawer itself is showing fresh data.
    window.buildSearchIndex();
    deviceByIp = loadedSnapshots[activeSnapshotIndex].deviceByIp;

    window.extractVlans();

    // Gated on the drawer's own displayed IP, not on currentSelectedNodeData - for the
    // "Unscanned Node" placeholder case (the whole other reason to rescan something),
    // currentSelectedNodeData is null (openRightDrawer never set it, that's exactly why
    // the placeholder message shows), so checking it here would silently skip the
    // re-render on precisely the case this feature advertises supporting.
    var drawerIp = document.getElementById('drawer-title').innerText;
    var drawerOpen = document.getElementById('right-panel').style.display !== 'none';
    if (drawerOpen && drawerIp === ip) {
        window.openRightDrawer(ip); // deviceByIp now resolves to freshDevice - re-renders every tab from it
    }

    // Deliberately not a full window.buildSwitchMap() rebuild - that destroys the
    // vis.Network instance, resetting pan/zoom and collapsing every manually-expanded
    // cluster, for a feature whose whole pitch is a quick single-node refresh. Known
    // limitation: a structural change (new/removed LLDP neighbor) won't show as a new
    // edge until the graph is fully reloaded.
    if (window.refreshNodeVisual) window.refreshNodeVisual(ip);

    // Same "the map has its own rendering of this data" reasoning as setActiveSnapshot
    // (app.js) - a rescanned device's freshly-resolved location (or a chassis serial that
    // now resolves where it didn't before) should show up on the map too, not just the
    // diagram. No-op if Map view was never opened this session (renderMapMarkers's own
    // leafletMap===null guard) and does not reset the user's pan/zoom if it has been
    // (hasFitBoundsOnce in map.js).
    if (window.renderMapMarkers) window.renderMapMarkers();
};

window.openRightDrawer = function(ip) {
    currentSelectedNodeData = deviceByIp.get(String(ip));
    var panel = document.getElementById('right-panel');
    document.getElementById('drawer-title').innerText = ip;
    // A stale "Reachable"/"No response" from whatever device was open before this one would
    // otherwise still be sitting there, silently mislabeled as belonging to the new device.
    var pingResultEl = document.getElementById('pingResult');
    if (pingResultEl) { pingResultEl.textContent = ''; pingResultEl.className = ''; }

    var handle = document.getElementById('right-panel-handle');

    if (!currentSelectedNodeData) {
        document.getElementById('summary-content').innerHTML = `<div style="color:red; padding:20px;">No diagnostic data found (Unscanned Node).</div>`;
        panel.style.display = 'flex';
        if (handle) handle.style.display = 'block';
        return;
    }

    window.renderSummary();
    window.renderStack();
    window.renderNeighbors();
    window.renderInterfaces();
    window.renderClients();
    window.renderConfig();

    panel.style.display = 'flex';
    if (handle) handle.style.display = 'block';
};

window.renderSummary = function() {
    var d = currentSelectedNodeData;
    var alarms = window.asArray(d.Alarms);
    var alarmsHtml = alarms.length > 0
        ? `<span class="badge red">${alarms.length} ACTIVE</span>`
        : `<span class="badge green">None</span>`;

    var rescannedHtml = d.RescannedAt
        ? `<div style="grid-column:1/-1; background:#fff8e1; color:#7a6224; padding:6px 12px; border-radius:4px; font-size:0.8rem; margin-bottom:4px;">
             Live rescan at ${esc(new Date(d.RescannedAt).toLocaleTimeString())} - not saved to the snapshot file, this session only.
           </div>`
        : '';

    var html = `
        ${rescannedHtml}
        <div class="summary-item"><label>Hostname</label><div>${esc(d.Hostname) || 'N/A'}</div></div>
        <div class="summary-item"><label>IP Address</label><div>${esc(d.DeviceIP) || 'N/A'}</div></div>
        <div class="summary-item"><label>Junos OS</label><div>${esc(d.JunosVersion) || 'N/A'}</div></div>
        <div class="summary-item"><label>Gateway</label><div>${esc(d.Gateway) || 'N/A'}</div></div>
        <div class="summary-item"><label>Connected Neighbors</label><div>${d.Neighbors ? d.Neighbors.length : 0} Switches</div></div>
        <div class="summary-item"><label>Uptime</label><div>${esc(d.Uptime) || 'N/A'}</div></div>
        <div class="summary-item"><label>Last Configured</label><div>${esc(d.LastConfigured) || 'N/A'} by ${esc(d.LastConfiguredBy) || 'N/A'}</div></div>
        <div class="summary-item"><label>RE CPU / Memory</label><div>${esc(d.MasterCpuUtilization) || 'N/A'} / ${esc(d.MasterMemoryUtilization) || 'N/A'}</div></div>
        <div class="summary-item"><label>Chassis Alarms</label><div>${alarmsHtml}</div></div>
    `;
    document.getElementById('summary-content').innerHTML = html;

    var alarmsTbody = document.getElementById('alarms-tbody');
    if (alarmsTbody) {
        alarmsTbody.innerHTML = alarms.length > 0
            ? alarms.map(a => `<tr>
                <td><span class="badge ${String(a.Class).toLowerCase() === 'major' ? 'red' : 'accent'}">${esc(a.Class)}</span></td>
                <td>${esc(a.Time)}</td>
                <td>${esc(a.Description)}</td>
              </tr>`).join('')
            : `<tr><td colspan="3" style="text-align:center;">No active alarms</td></tr>`;
    }
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
    var daisyChains = window.detectDaisyChains(currentSelectedNodeData);
    var html = "";

    if (currentSelectedNodeData.Interfaces && Array.isArray(currentSelectedNodeData.Interfaces)) {
        currentSelectedNodeData.Interfaces.forEach(intf => {
            if (!intf.Port || String(intf.Port).includes('.')) return;

            if (hideDown && String(intf.Link).toLowerCase() !== "up") return;

            var linkBadge = String(intf.Link).toLowerCase() === "up" ? "green" : "red";
            var stpBadge = String(intf.STP) === "FWD" ? "green" : (String(intf.STP) === "BLK" ? "red" : "gray");
            var poeTxt = (!intf.PoE || intf.PoE === "Unknown") ? "-" : intf.PoE;

            var chain = daisyChains.get(window.normalizePort(intf.Port));
            var daisyStr = chain
                ? `<br>${window.renderDaisyChainBadge(chain)}`
                : "";

            html += `<tr>
                <td><b>${esc(intf.Port)}</b>${daisyStr}</td>
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
    var daisyChains = window.detectDaisyChains(currentSelectedNodeData);
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

            var vendorInfo = window.lookupVendor(c.MAC);
            var vendorStr = vendorInfo.vendor
                ? `<br><span class="vendor-tag vendor-${vendorInfo.category.toLowerCase().replace('/', '-')}" title="Category: ${esc(vendorInfo.category)}">${esc(vendorInfo.vendor)}</span>`
                : "";

            var chain = daisyChains.get(window.normalizePort(c.Port));
            var daisyStr = chain ? `<br>${window.renderDaisyChainBadge(chain)}` : "";

            html += `<tr class="${rowClass}">
                <td><span style="font-weight:bold; color:#2B7CE9; font-size:1rem;">${esc(c.IP)}</span><br><span style="font-family:monospace; color:#666;">${esc(String(c.MAC).toUpperCase())}</span>${vendorStr}</td>
                <td><b>${esc(c.Port)}</b><br><span class="badge" style="background:#2c3e50;">VLAN ${esc(c.VLAN_Tag)}</span>${typeStr}${descStr}${daisyStr}</td>
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

// CSV export - mirrors the currently displayed (filtered) rows for the selected switch,
// not the full unfiltered dataset, so what downloads matches what's on screen.
function csvEscapeField(val) {
    var s = (val === null || val === undefined) ? '' : String(val);
    if (/[",\r\n]/.test(s)) { s = '"' + s.replace(/"/g, '""') + '"'; }
    return s;
}

function downloadCsv(filename, rows) {
    var csv = rows.map(row => row.map(csvEscapeField).join(',')).join('\r\n');
    downloadBlob(filename, csv, 'text/csv;charset=utf-8;');
}

function downloadBlob(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Config backup (see Get-JunosNodeData.ps1's Invoke-ConfigBackup) - stored verbatim, so
// this tab just displays/copies/downloads it as-is, no parsing or reformatting.
window.renderConfig = function() {
    var el = document.getElementById('config-content');
    if (!el) return;
    var config = currentSelectedNodeData && currentSelectedNodeData.Configuration;
    el.textContent = (config && config !== "Unknown") ? config : "No configuration backup available for this device.";
    window.populateConfigCompareSelect();
};

// Config diff (see configSetDiff in dashboard.js) - lets this device's Config tab compare
// its current config against either (a) the SAME device's config from another loaded
// snapshot (the <select>, since that list is always small - one entry per other capture),
// or (b) a DIFFERENT device's config from ANY loaded snapshot (the search box) - e.g.
// diffing a misconfigured switch against a known-good one, on a fleet too large to browse
// as a flat dropdown. The two controls are mutually exclusive - picking one clears the
// other - and both write into the same configCompareTarget state that renderConfigDiff
// actually reads.
var configCompareTarget = null; // {idx, ip} of the device/snapshot being diffed against, or null

// idx (in loadedSnapshots) -> that OTHER snapshot's own DeviceIP for the currently-open
// device - NOT necessarily the same IP the drawer is showing right now. Populated by
// populateConfigCompareSelect below, read by selectConfigCompareSnapshot: a device matched
// by identity (serial/hostname) can easily have had a different IP in an older capture, and
// this is what lets renderConfigDiff's own DeviceIP-based lookup (unchanged, see below)
// still find it in that specific snapshot.
var sameDeviceIpByIdx = {};

// (a) only - the "This device, other capture" list. Small and bounded (one entry per
// OTHER loaded snapshot that has this same device with real config), so a plain select is
// still the right control here; it's (b), searching potentially hundreds of other
// devices, that a flat list stopped being usable for.
window.populateConfigCompareSelect = function() {
    var container = document.getElementById('configCompareContainer');
    var select = document.getElementById('configCompareSelect');
    var searchInput = document.getElementById('configCompareSearch');
    var searchResults = document.getElementById('configCompareSearchResults');
    if (!container || !select) return;

    configCompareTarget = null;
    sameDeviceIpByIdx = {};
    if (searchInput) searchInput.value = '';
    if (searchResults) searchResults.innerHTML = '';

    var d = currentSelectedNodeData;
    var hasOwnConfig = d && d.Configuration && d.Configuration !== "Unknown";

    if (!hasOwnConfig) {
        container.style.display = 'none';
        document.getElementById('config-diff-content').style.display = 'none';
        document.getElementById('config-content').style.display = '';
        return;
    }

    // Matched by window.resolveDeviceIdentity (serial > hostname > IP), not a literal IP
    // comparison - a device renumbered since an older capture is still "this same device"
    // for compare purposes; it would otherwise silently disappear from this list the moment
    // its IP changed, with no error, just fewer options than expected.
    var identity = window.resolveDeviceIdentity(d);
    var sameDeviceOptions = [];
    loadedSnapshots.forEach((snap, idx) => {
        if (idx === activeSnapshotIndex) return;
        var other = (snap.topology || []).find(dev => dev && dev.DeviceIP && window.resolveDeviceIdentity(dev) === identity);
        if (other && other.Configuration && other.Configuration !== "Unknown") {
            sameDeviceIpByIdx[idx] = String(other.DeviceIP);
            sameDeviceOptions.push({
                idx: idx,
                ts: snap.scanTimestamp ? new Date(snap.scanTimestamp).getTime() : 0,
                label: snap.scanTimestamp ? new Date(snap.scanTimestamp).toLocaleString() : snap.sourceFile,
            });
        }
    });
    sameDeviceOptions.sort((a, b) => b.ts - a.ts); // most recent other capture first

    select.innerHTML = '<option value="">-- Raw config only --</option>'
        + sameDeviceOptions.map(o => `<option value="${o.idx}">${esc(o.label)}</option>`).join('');
    select.value = '';
    container.style.display = 'flex';
    window.renderConfigDiff();
};

// The <select> changed - either back to "raw config only", or to a different capture of
// THIS same device. Clears whatever the search box had selected, since only one compare
// target can be active.
window.selectConfigCompareSnapshot = function() {
    var select = document.getElementById('configCompareSelect');
    var searchInput = document.getElementById('configCompareSearch');
    var searchResults = document.getElementById('configCompareSearchResults');
    if (searchInput) searchInput.value = '';
    if (searchResults) searchResults.innerHTML = '';

    // ip comes from sameDeviceIpByIdx (that OTHER snapshot's own DeviceIP for this device),
    // NOT currentSelectedNodeData.DeviceIP - those two can legitimately differ when the
    // device was renumbered between the two captures being compared. Falls back to the
    // active device's IP only as a last resort (should never actually trigger, since every
    // <option> value here came from a key populateConfigCompareSelect just wrote).
    var idx = select.value ? parseInt(select.value, 10) : null;
    configCompareTarget = select.value
        ? { idx: idx, ip: sameDeviceIpByIdx[idx] || String(currentSelectedNodeData.DeviceIP) }
        : null;
    window.renderConfigDiff();
};

// Live-filters every OTHER device (by hostname or IP substring) across every loaded
// snapshot - not just the active one, since a search box (unlike a flat dropdown) stays
// usable regardless of fleet size, so there's no reason left to restrict it to one
// capture. Capped at MAX_RESULTS so a broad query on a large fleet doesn't dump hundreds
// of rows into the DOM at once; narrowing the query is the intended way to get past that,
// same tradeoff a global search box makes.
var CONFIG_COMPARE_MAX_RESULTS = 25;
window.searchConfigCompareDevices = function() {
    var input = document.getElementById('configCompareSearch');
    var resultsEl = document.getElementById('configCompareSearchResults');
    if (!input || !resultsEl) return;
    var query = input.value.trim();

    // Typing invalidates whatever was previously selected (search or dropdown) - the
    // input no longer reflects a resolved device, it reflects an in-progress query.
    configCompareTarget = null;
    var select = document.getElementById('configCompareSelect');
    if (select) select.value = '';
    window.renderConfigDiff();

    if (!query) { resultsEl.innerHTML = ''; return; }
    var queryLower = query.toLowerCase();

    var d = currentSelectedNodeData;
    var selfIp = d ? String(d.DeviceIP) : null;
    var matches = [];
    loadedSnapshots.forEach((snap, idx) => {
        (snap.topology || []).forEach(other => {
            if (!other || !other.DeviceIP || String(other.DeviceIP) === selfIp) return;
            if (!other.Configuration || other.Configuration === "Unknown") return;
            var hostname = (other.Hostname && other.Hostname !== "Unknown") ? other.Hostname : '';
            if (hostname.toLowerCase().indexOf(queryLower) === -1 && String(other.DeviceIP).toLowerCase().indexOf(queryLower) === -1) return;
            matches.push({
                idx: idx, ip: String(other.DeviceIP), hostname: hostname,
                ts: snap.scanTimestamp ? new Date(snap.scanTimestamp).getTime() : 0,
                snapLabel: snap.scanTimestamp ? new Date(snap.scanTimestamp).toLocaleString() : snap.sourceFile,
            });
        });
    });
    matches.sort((a, b) => (a.hostname || a.ip).localeCompare(b.hostname || b.ip) || b.ts - a.ts);

    var truncated = matches.length > CONFIG_COMPARE_MAX_RESULTS;
    matches = matches.slice(0, CONFIG_COMPARE_MAX_RESULTS);

    var rows = matches.map(m => {
        var snapshotTag = loadedSnapshots.length > 1 ? `<span class="sr-snapshot">${esc(m.snapLabel)}</span>` : '';
        return {
            line1Html: `${esc(m.hostname || m.ip)}${m.hostname ? ` <span style="color:#999; font-weight:normal;">(${esc(m.ip)})</span>` : ''}${snapshotTag}`,
            onClick: () => window.selectConfigCompareDevice(m.idx, m.ip),
        };
    });

    window.renderResultsList(rows, { targetId: 'configCompareSearchResults', emptyText: `No devices match "${query}".` });
    if (truncated) {
        resultsEl.insertAdjacentHTML('beforeend', `<div class="search-no-results">Showing first ${CONFIG_COMPARE_MAX_RESULTS} matches - keep typing to narrow it down.</div>`);
    }
};

// A search result was clicked - resolve it to a compare target, reflect the pick back
// into the search box (so it reads like a resolved selection, not a live query), and
// collapse the results list.
window.selectConfigCompareDevice = function(idx, ip) {
    configCompareTarget = { idx: idx, ip: ip };

    var otherSnap = loadedSnapshots[idx];
    var other = otherSnap && (otherSnap.topology || []).find(dev => dev && String(dev.DeviceIP) === ip);
    var label = (other && other.Hostname && other.Hostname !== "Unknown" ? other.Hostname : ip) + ' (' + ip + ')';

    var input = document.getElementById('configCompareSearch');
    if (input) input.value = label;
    var resultsEl = document.getElementById('configCompareSearchResults');
    if (resultsEl) resultsEl.innerHTML = '';

    window.renderConfigDiff();
};

window.renderConfigDiff = function() {
    var diffEl = document.getElementById('config-diff-content');
    var rawEl = document.getElementById('config-content');
    if (!diffEl || !rawEl) return;

    if (!configCompareTarget) {
        diffEl.style.display = 'none';
        rawEl.style.display = '';
        return;
    }

    var otherSnap = loadedSnapshots[configCompareTarget.idx];
    var otherIp = configCompareTarget.ip;
    var d = currentSelectedNodeData;
    var other = otherSnap && (otherSnap.topology || []).find(dev => dev && String(dev.DeviceIP) === otherIp);
    var otherConfig = other ? other.Configuration : '';
    // Identity-based, not otherIp !== d.DeviceIP - the "This device, other capture" picker
    // (populateConfigCompareSelect) can legitimately hand back a capture where this same
    // physical switch had a different IP, and that must NOT trip the "two different
    // switches" cross-device banner below.
    var isCrossDevice = !other || window.resolveDeviceIdentity(other) !== window.resolveDeviceIdentity(d);
    var otherLabel = esc(other && other.Hostname && other.Hostname !== "Unknown" ? other.Hostname : otherIp);

    var header = isCrossDevice
        ? `<div class="config-diff-header">Comparing against <strong>${otherLabel}</strong> (${esc(otherIp)}) &mdash; these are two different switches, not a change history, so a large diff is expected. Left = ${otherLabel}, right = this device.</div>`
        : '<div class="config-diff-header">Left = previous snapshot, right = this device&apos;s current configuration.</div>';

    var lineRows = computeLineDiff(otherConfig, d.Configuration);
    var bodyHtml;
    if (lineRows === null) {
        // Configs too large for the O(n*m) positional diff (see CONFIG_DIFF_CELL_LIMIT) -
        // fall back to the flat, order-independent set diff instead of hanging the tab.
        var diff = configSetDiff(otherConfig, d.Configuration);
        bodyHtml = (diff.added.length === 0 && diff.removed.length === 0)
            ? '<div class="config-diff-empty">No differences - configuration is identical between these two.</div>'
            : '<div class="config-diff-header">These configs are too large to align line-by-line - showing an unordered set difference instead.</div>'
              + diff.removed.map(l => `<div class="config-diff-line removed">- ${esc(l)}</div>`).join('')
              + diff.added.map(l => `<div class="config-diff-line added">+ ${esc(l)}</div>`).join('');
    } else if (lineRows.every(r => r.type === 'equal')) {
        bodyHtml = '<div class="config-diff-empty">No differences - configuration is identical between these two.</div>';
    } else {
        bodyHtml = '<div class="config-diff-table">' + lineRows.map(r => {
            var oldNum = r.oldNum !== null ? r.oldNum : '';
            var newNum = r.newNum !== null ? r.newNum : '';
            var oldContent = r.oldLine !== null ? esc(r.oldLine) : '';
            var newContent = r.newLine !== null ? esc(r.newLine) : '';
            return `<div class="config-diff-row ${r.type}">`
                + `<div class="config-diff-linenum old-side">${oldNum}</div>`
                + `<div class="config-diff-cell old-side">${oldContent}</div>`
                + `<div class="config-diff-linenum new-side">${newNum}</div>`
                + `<div class="config-diff-cell new-side">${newContent}</div>`
                + `</div>`;
        }).join('') + '</div>';
    }

    diffEl.innerHTML = header + bodyHtml;
    diffEl.style.display = 'block';
    rawEl.style.display = 'none';
};

window.copyDeviceConfig = async function() {
    var config = currentSelectedNodeData && currentSelectedNodeData.Configuration;
    if (!config || config === "Unknown") { window.setStatus("No configuration backup available for this device.", "red"); return; }
    try {
        await navigator.clipboard.writeText(config);
        window.setStatus("Configuration copied to clipboard.", "green");
    } catch (e) {
        window.setStatus("Could not copy to clipboard: " + e.message, "red");
    }
};

window.downloadDeviceConfig = function() {
    var config = currentSelectedNodeData && currentSelectedNodeData.Configuration;
    if (!config || config === "Unknown") { window.setStatus("No configuration backup available for this device.", "red"); return; }
    var ip = currentSelectedNodeData.DeviceIP || 'device';
    downloadBlob(`${ip}_config.txt`, config, 'text/plain;charset=utf-8;');
};

// Printable device report - same "device needs to be replaced or restored" motivation as
// the config backup itself, but everything ELSE captured about a device: identity,
// hardware, alarms, neighbors, interfaces, clients. Deliberately excludes the config
// backup text - SNMP communities, RADIUS/TACACS+ shared secrets, local user secrets live
// in there (same sensitivity call Get-JunosNodeData.ps1's RawDumps redaction already
// makes), and a printed/PDF'd report is exactly the kind of copy that ends up left on a
// shared printer or emailed around. The config export button elsewhere in this file is
// the deliberate, single-purpose way to get that text out. Opens a self-contained document
// in a new tab (no library, same "hand-roll it" pattern as everything else) with a visible
// Print button rather than auto-firing window.print() on open - avoids popup/timing edge
// cases around a new window's print dialog firing before content has settled, and lets the
// user review first.
window.printDeviceReport = function() {
    var d = currentSelectedNodeData;
    if (!d) { window.setStatus("No device selected.", "red"); return; }

    var alarms = window.asArray(d.Alarms);
    var stack = window.asArray(d.StackMembers);
    var neighbors = window.asArray(d.Neighbors);
    var interfaces = Array.isArray(d.Interfaces) ? d.Interfaces : [];
    var clients = d.TrueClients || d.Clients || [];

    function row(cells) { return `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`; }
    function table(headers, rows, emptyText) {
        return `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
            rows.length ? rows.join('') : `<tr><td colspan="${headers.length}">${esc(emptyText)}</td></tr>`
        }</tbody></table>`;
    }

    var html = `<!doctype html><html><head><meta charset="utf-8"><title>Device Report - ${esc(d.Hostname || d.DeviceIP)}</title>
<style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #222; margin: 0; padding: 30px; }
    h1 { margin: 0 0 4px; font-size: 1.5rem; }
    h2 { font-size: 1.05rem; margin: 28px 0 8px; border-bottom: 2px solid #2c3e50; padding-bottom: 4px; }
    .subtitle { color: #666; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-bottom: 4px; }
    th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #ddd; }
    th { background: #f0f0f0; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f7f7f7; border: 1px solid #ddd; padding: 12px; font-size: 0.75rem; }
    #printBar { margin-bottom: 20px; }
    #printBar button { font-size: 0.9rem; padding: 8px 16px; cursor: pointer; }
    @media print { #printBar { display: none; } body { padding: 0; } }
</style>
</head><body>
<div id="printBar"><button onclick="window.print()">Print / Save as PDF</button></div>
<h1>${esc(d.Hostname || 'Unknown')}</h1>
<div class="subtitle">${esc(d.DeviceIP)} &mdash; Junos ${esc(d.JunosVersion)} &mdash; report generated ${esc(new Date().toLocaleString())}</div>

<h2>Identity</h2>
${table(['Field', 'Value'], [
    row([esc('Gateway'), esc(d.Gateway)]),
    row([esc('Uptime'), esc(d.Uptime)]),
    row([esc('Last Configured'), `${esc(d.LastConfigured)} by ${esc(d.LastConfiguredBy)}`]),
    row([esc('RE CPU / Memory'), `${esc(d.MasterCpuUtilization)} / ${esc(d.MasterMemoryUtilization)}`]),
], '')}

<h2>Hardware</h2>
${table(['FPC', 'Role', 'Model', 'Serial'], stack.map(sm => row([esc(sm.FPC), esc(sm.Role), esc(sm.Model), esc(sm.Serial)])), 'No hardware data')}

<h2>Alarms</h2>
${table(['Class', 'Time', 'Description'], alarms.map(a => row([esc(a.Class), esc(a.Time), esc(a.Description)])), 'No active alarms')}

<h2>Neighbors</h2>
${table(['Local Port', 'Neighbor', 'Remote Port', 'Description'], neighbors.map(n => row([esc(n.LocalPort), `${esc(n.Hostname)} (${esc(n.ManagementIP)})`, esc(n.RemotePort), esc(n.Description)])), 'No LLDP neighbors found')}

<h2>Interfaces</h2>
${table(['Port', 'Admin', 'Link', 'STP', 'PoE', 'Description'], interfaces.map(i => row([esc(i.Port), esc(i.Admin), esc(i.Link), esc(i.STP), esc(i.PoE), esc(i.Desc)])), 'No interface data')}

<h2>Clients</h2>
${table(['IP', 'MAC', 'Port', 'VLAN', 'Dot1x User', 'Dot1x State'], clients.map(c => row([esc(c.IP), esc(c.MAC), esc(c.Port), esc(c.VLAN_Tag), esc(c.Dot1x_User), esc(c.Dot1x_State)])), 'No clients')}

</body></html>`;

    // A Blob URL navigation target, not document.write() - every dynamic field above is
    // already run through esc() (same escaping this codebase uses everywhere else for
    // device-supplied strings like hostnames/LLDP descriptions before innerHTML), so this
    // isn't fixing a missing-escape bug - it's just the cleaner, non-deprecated mechanism.
    // Deliberately NOT revoked: the new tab needs the URL to stay valid for as long as the
    // user keeps it open to review/print, unlike the click-and-forget CSV/config downloads
    // elsewhere in this file that revoke immediately after triggering a save.
    var blob = new Blob([html], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var reportWindow = window.open(url, '_blank');
    if (!reportWindow) {
        URL.revokeObjectURL(url);
        window.setStatus("Could not open report - check your browser's popup blocker.", "red");
    }
};

window.exportInterfacesCsv = function() {
    if (!currentSelectedNodeData) { window.setStatus("Select a switch first.", "red"); return; }
    var hideDown = document.getElementById('hideDownPorts').checked;
    var rows = [['Port', 'Admin', 'Link', 'STP', 'PoE', 'Description']];

    (currentSelectedNodeData.Interfaces || []).forEach(intf => {
        if (!intf.Port || String(intf.Port).includes('.')) return;
        if (hideDown && String(intf.Link).toLowerCase() !== "up") return;
        var poeTxt = (!intf.PoE || intf.PoE === "Unknown") ? "-" : intf.PoE;
        rows.push([intf.Port, intf.Admin, intf.Link, intf.STP, poeTxt, intf.Desc]);
    });

    downloadCsv(`${currentSelectedNodeData.DeviceIP}_interfaces.csv`, rows);
};

window.exportClientsCsv = function() {
    if (!currentSelectedNodeData) { window.setStatus("Select a switch first.", "red"); return; }
    var vlanFilter = document.getElementById('vlanFilter').value;
    var clients = (currentSelectedNodeData.TrueClients || []).slice();

    if (vlanFilter !== "ALL") { clients = clients.filter(c => String(c.VLAN_Tag) === vlanFilter.toString()); }
    clients.sort((a, b) => {
        if (a.IP === "Unknown IP") return 1; if (b.IP === "Unknown IP") return -1;
        var numA = Number(String(a.IP).split('.').map(n => (`000${n}`).slice(-3)).join(''));
        var numB = Number(String(b.IP).split('.').map(n => (`000${n}`).slice(-3)).join(''));
        return numA - numB;
    });

    var rows = [['IP', 'MAC', 'Vendor', 'Category', 'Port', 'VLAN_Tag', 'Type', 'PortDesc', 'Dot1x_User', 'Dot1x_State']];
    clients.forEach(c => {
        var vendorInfo = window.lookupVendor(c.MAC);
        rows.push([c.IP, c.MAC, vendorInfo.vendor || '', vendorInfo.category, c.Port, c.VLAN_Tag, c.Type, c.PortDesc, c.Dot1x_User, c.Dot1x_State]);
    });

    downloadCsv(`${currentSelectedNodeData.DeviceIP}_clients.csv`, rows);
};
