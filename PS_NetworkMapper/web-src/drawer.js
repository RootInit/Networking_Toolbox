// Left-docked device detail drawer: the Summary/Hardware/Alarms/Neighbors/Interfaces/Config
// tabs, CSV and config export, the printable report, and drawer open/close/tab-switch.

// The side panel itself stays - it also hosts the Load/Search/Settings tabs; only the device
// section under them is shown or hidden.
window.closeDrawer = function() {
    document.getElementById('device-drawer').style.display = 'none';
    document.getElementById('device-empty').style.display = '';
    currentSelectedNodeData = null;
    if (network) network.unselectAll();
};

window.switchTab = function(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('#drawer-tabs .tab').forEach(el => { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); });
    document.getElementById(tabId).classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    document.getElementById('btn-' + tabId).setAttribute('aria-selected', 'true');

    if (currentSelectedNodeData) {
        if (tabId === 'tab-neighbors') window.renderNeighbors();
        if (tabId === 'tab-interfaces') window.renderInterfaces();
    }
};

// SSH quick-connect: the server launches Connect-Switch.ps1 as a real interactive session
// via Start-Process. Only viable because the server is localhost-only.
window.copyConnectCommand = async function() {
    var ip = document.getElementById('drawer-title').innerText;
    if (!ip) return;
    var btn = document.getElementById('copyConnectBtn');
    // A launch is already in flight; a double-click must not fire a second SSH session and
    // credential temp file.
    if (btn && btn.disabled) return;
    var original = btn ? btn.textContent : null;
    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Launching...'; }
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
        if (btn) setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
    }
};

// On-demand single-device rescan via /api/rescan, polled below. Also works for the
// "Unscanned Node" case, a device only ever seen as an LLDP neighbor.
var rescanPollTimer = null;
// The IP a poll is running for. Set the moment the button is disabled, unlike
// rescanPollTimer, which is null during the POST and each in-flight status fetch, so
// openRightDrawer can tell a poll for the device being opened from one for another device.
var rescanPollTargetIp = null;

// Called when a new file set is loaded mid-poll, so a pending result can't land in whatever
// snapshot happens to be active once loadedSnapshots is replaced.
window.cancelPendingRescan = function() {
    if (rescanPollTimer) { clearTimeout(rescanPollTimer); rescanPollTimer = null; }
    rescanPollTargetIp = null;
    // rescanDevice's finish() is never reached on an external cancel, so the button is
    // restored here or it stays disabled at "Scanning..." forever.
    var btn = document.getElementById('rescanBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'Re-scan'; }
};

window.rescanDevice = async function() {
    var ip = document.getElementById('drawer-title').innerText;
    if (!ip) return;

    // A rescan for another device is in flight and shares this button and the server's single
    // rescan slot. Starting a second would hit the 409 branch below and call finish(),
    // clearing that poll's timer out from under it - so refuse up front.
    if (rescanPollTargetIp && rescanPollTargetIp !== ip) {
        window.setStatus("A rescan of " + rescanPollTargetIp + " is still running - wait for it to finish.", "orange");
        return;
    }

    var btn = document.getElementById('rescanBtn');
    var original = btn ? btn.textContent : null;

    // Captured now, not re-read when the poll resolves: the result must land in the snapshot
    // that was active when the rescan STARTED. An object reference rather than an array
    // index, so it also survives snapshots being reordered or reloaded.
    var targetSnapshot = (activeSnapshotIndex >= 0) ? loadedSnapshots[activeSnapshotIndex] : null;

    function finish(msg, color) {
        if (rescanPollTimer) { clearTimeout(rescanPollTimer); rescanPollTimer = null; }
        if (rescanPollTargetIp === ip) rescanPollTargetIp = null;
        if (btn) { btn.disabled = false; btn.textContent = original; }
        window.setStatus(msg, color);
    }

    var jobId;
    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Scanning...'; }
        rescanPollTargetIp = ip;
        var resp = await fetch('/api/rescan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: ip })
        });
        var result = await resp.json();
        if (resp.status === 409 && result.jobId) {
            // One slot server-side: only attach if the running job is for this device.
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
        // Stays above the server's own ~90s hard timeout.
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
            rescanPollTimer = setTimeout(() => { poll().catch(e => finish("Rescan poll failed unexpectedly: " + e.message, "red")); }, 2000);
            return;
        }
        // status.status === 'complete'
        if (!status.ok) {
            finish("Rescan failed: " + (status.reason || "unknown error") + " - existing data left unchanged.", "red");
            return;
        }
        // A throw anywhere in the merge or re-render must still reach finish(), or #rescanBtn
        // stays disabled at "Scanning..." with no recovery short of a page reload.
        try {
            var merged = window.mergeRescannedDevice(status.node, targetSnapshot);
            if (!merged) {
                finish("Rescan of " + ip + " completed, but the snapshot it was scanned against is no longer loaded (a new file set was loaded while it was running) - the result was discarded.", "orange");
            } else {
                finish("Rescanned " + ip + " at " + new Date().toLocaleTimeString('en-US') + ".", "green");
            }
        } catch (e) {
            finish("Rescan of " + ip + " completed, but showing the result failed: " + e.message + " - the underlying data may still have been updated.", "red");
        }
    };
    poll().catch(e => finish("Rescan poll failed unexpectedly: " + e.message, "red"));
};

// Quick reachability check: /api/ping runs server-side as a background job, so this polls
// /api/ping/status just like rescanDevice above polls /api/rescan/status.
var pingPollTimer = null;
// Mirrors rescanPollTargetIp above, for the shared #pingBtn.
var pingPollTargetIp = null;

// Mirrors cancelPendingRescan, for the same reason. The completion path is self-defending
// too (see isDrawerShowing), since a ping poll - unlike a rescan - isn't cancelled merely by
// switching which device's drawer is open.
window.cancelPendingPing = function() {
    if (pingPollTimer) { clearTimeout(pingPollTimer); pingPollTimer = null; }
    pingPollTargetIp = null;
    var btn = document.getElementById('pingBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'Ping'; }
};

// #pingResult is a persistent element, unlike the rest of the drawer body, so a poll must
// re-check this before painting: a result for IP A resolving after the user switched to IP B
// would otherwise appear under B's data.
function isDrawerShowing(ip) {
    var titleEl = document.getElementById('drawer-title');
    return !!titleEl && titleEl.innerText === ip;
}

window.pingDevice = async function() {
    var ip = document.getElementById('drawer-title').innerText;
    if (!ip) return;

    // Mirrors rescanDevice's guard above, for the same reason.
    if (pingPollTargetIp && pingPollTargetIp !== ip) {
        window.setStatus("A ping of " + pingPollTargetIp + " is still running - wait for it to finish.", "orange");
        return;
    }

    var btn = document.getElementById('pingBtn');
    var original = btn ? btn.textContent : null;
    // Written inline as well as to setStatus: the sidebar's #status-text is easy to miss
    // from this panel.
    var resultEl = document.getElementById('pingResult');
    function showResult(msg, cls) {
        if (!resultEl) return;
        resultEl.textContent = msg;
        resultEl.className = cls || '';
    }

    function finish(msg, cls) {
        if (pingPollTimer) { clearTimeout(pingPollTimer); pingPollTimer = null; }
        if (pingPollTargetIp === ip) pingPollTargetIp = null;
        if (btn) { btn.disabled = false; btn.textContent = original; }
        // Only paint the inline result if the drawer still shows this ping's device;
        // setStatus is global and safe either way.
        if (isDrawerShowing(ip)) showResult(msg, cls);
        window.setStatus(msg, cls);
    }

    var jobId;
    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Pinging...'; }
        pingPollTargetIp = ip;
        showResult('Pinging...', '');
        var resp = await fetch('/api/ping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: ip })
        });
        var result = await resp.json();
        if (resp.status === 409 && result.jobId) {
            // Only one ping slot exists server-side; only attach if it's our own device
            // already in flight, not someone else's running job.
            if (result.ip !== ip) {
                finish("A ping of " + result.ip + " is already running - try again once it finishes.", "red");
                return;
            }
            jobId = result.jobId;
        } else if (!resp.ok) {
            finish("Could not ping " + ip + ": " + (result.error || ('HTTP ' + resp.status)), "red");
            return;
        } else {
            jobId = result.jobId;
        }
    } catch (e) {
        finish("Could not ping " + ip + ": " + e.message, "red");
        return;
    }

    var pollStart = Date.now();
    var poll = async function() {
        // Stays above the server's own 20s hard timeout.
        if (Date.now() - pollStart > 25000) { finish("Ping timed out waiting for a response.", "red"); return; }

        var statusResp;
        try {
            statusResp = await fetch('/api/ping/status?jobId=' + encodeURIComponent(jobId));
        } catch (e) {
            finish("Lost connection to the local server - retry once it's running again.", "red");
            return;
        }

        if (statusResp.status === 404) {
            finish("Ping job expired or the server restarted - try again.", "red");
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
            finish("Could not ping " + ip + ": " + (status.reason || ('HTTP ' + statusResp.status)), "red");
            return;
        }
        if (status.status === 'timeout') {
            finish("Ping of " + ip + " timed out.", "red");
            return;
        }
        if (status.status === 'running') {
            pingPollTimer = setTimeout(poll, 2000);
            return;
        }
        // status.status === 'complete'
        if (!status.ok) {
            finish("Could not ping " + ip + ": " + (status.reason || "unknown error"), "red");
            return;
        }
        if (pingPollTimer) { clearTimeout(pingPollTimer); pingPollTimer = null; }
        if (pingPollTargetIp === ip) pingPollTargetIp = null;
        if (btn) { btn.disabled = false; btn.textContent = original; }
        if (status.alive) {
            var okMsg = "Reachable (" + status.avgLatencyMs + "ms avg, " + status.received + "/" + status.sent + ")";
            if (isDrawerShowing(ip)) showResult(okMsg, 'green');
            window.setStatus(ip + " is reachable (" + status.avgLatencyMs + "ms avg, " + status.received + "/" + status.sent + " replies).", "green");
        } else {
            var failMsg = "No response (" + status.received + "/" + status.sent + ")";
            if (isDrawerShowing(ip)) showResult(failMsg, 'red');
            window.setStatus(ip + " did not respond to ping (" + status.received + "/" + status.sent + " replies).", "red");
        }
    };
    poll();
};

// Client-side port of Update-ClientIpCorrelation. A single-device rescan only has that
// switch's own ARP table, while client IPs usually resolve from the L3 gateway's - so this
// must re-run across the whole topology after a merge, or clients flip back to "Unknown".
function correlateClientIps(topology) {
    var globalArpMap = new Map();
    topology.forEach(device => {
        window.asArray(device.ArpEntries).forEach(arp => {
            if (arp && arp.MAC && arp.IP) globalArpMap.set(arp.MAC, arp.IP);
        });
    });
    topology.forEach(device => {
        window.asArray(device.Clients).forEach(client => {
            if (client && client.IP === "Unknown" && globalArpMap.has(client.MAC)) {
                client.IP = globalArpMap.get(client.MAC);
            }
        });
    });
}

// True when the targeted snapshot is no longer loaded, so a result arriving after a new file
// set must be discarded rather than spliced into whatever now occupies that slot.
function isRescanTargetSnapshotGone(snapshots, targetSnapshot) {
    return !targetSnapshot || snapshots.indexOf(targetSnapshot) === -1;
}

// True only while openRightDrawer runs from mergeRescannedDevice's re-render - a background
// poll completing, not a user action. Lets renderInterfaces' auto-scroll and the compare-target
// reset tell that apart from a genuine drawer-open, where their normal behavior is correct.
var isMergeRerender = false;

// Merges into targetSnapshot - the snapshot active when the rescan STARTED, not whatever
// activeSnapshotIndex reads now. Never written back to disk: the loaded file's password
// isn't retained, and snapshot immutability is load-bearing for Topology Diff and
// cross-snapshot config compare. RescannedAt surfaces that ephemerality in Summary.
// Returns false if targetSnapshot is no longer loaded.
window.mergeRescannedDevice = function(freshDevice, targetSnapshot) {
    if (!freshDevice || !freshDevice.DeviceIP) return false;
    if (isRescanTargetSnapshotGone(loadedSnapshots, targetSnapshot)) return false;

    var ip = String(freshDevice.DeviceIP);
    var topology = targetSnapshot.topology;

    freshDevice.TrueClients = window.asArray(freshDevice.Clients);
    freshDevice.RescannedAt = new Date().toISOString();

    var index = topology.findIndex(d => d && String(d.DeviceIP) === ip);
    if (index === -1) {
        topology.push(freshDevice); // was an "Unscanned Node" placeholder until now
    } else {
        topology[index] = freshDevice;
    }

    // dashboard.js memoises fleet totals on this same snapshot object, so it must be
    // invalidated here, where the topology actually changes - otherwise the sparklines show
    // pre-rescan numbers beside stat values that recompute live.
    if (window.invalidateFleetTotalsCache) window.invalidateFleetTotalsCache(targetSnapshot);

    correlateClientIps(topology);

    // buildSearchIndex replaces each snapshot.deviceByIp with a new Map rather than mutating
    // it, so the module-level deviceByIp must be re-pointed at the fresh one.
    window.buildSearchIndex();
    if (activeSnapshotIndex >= 0 && loadedSnapshots[activeSnapshotIndex]) {
        deviceByIp = loadedSnapshots[activeSnapshotIndex].deviceByIp;
    }

    // Visible search rows were rendered from PRE-merge values, so the search is re-run.
    // searchIndex spans every snapshot, hence no isActiveSnapshot gate. The box-content check
    // matters: searchHighlightQuery holds the last SUBMITTED query, so if the user is
    // mid-typing an unsubmitted one, re-running here would submit that half-typed text and
    // overwrite the results they are actually looking at.
    var searchBox = document.getElementById('globalSearch');
    if (searchBox && searchBox.value.trim() && window.performGlobalSearch
        && searchBox.value.trim().toLowerCase() === searchHighlightQuery) {
        window.performGlobalSearch();
    }

    // Everything below touches on-screen state, which reflects the ACTIVE snapshot only. If
    // the user switched away mid-rescan, the merge above still updated that background
    // snapshot, but nothing on screen may be re-rendered from the wrong snapshot's data.
    var isActiveSnapshot = (activeSnapshotIndex >= 0 && loadedSnapshots[activeSnapshotIndex] === targetSnapshot);
    if (!isActiveSnapshot) return true;

    window.extractVlans();

    // Gated on the displayed IP, not currentSelectedNodeData, which is null for an
    // "Unscanned Node" - exactly the case this feature exists for.
    var drawerIp = document.getElementById('drawer-title').innerText;
    var drawerOpen = document.getElementById('device-drawer').style.display !== 'none';
    if (drawerOpen && drawerIp === ip) {
        isMergeRerender = true;
        try {
            window.openRightDrawer(ip); // deviceByIp now resolves to freshDevice
        } finally {
            isMergeRerender = false;
        }
    }

    // Not a full buildSwitchMap rebuild, which would reset pan/zoom and collapse expanded
    // clusters. Known limitation: a new or removed LLDP neighbor won't change the edges
    // until the graph is fully reloaded.
    if (window.refreshNodeVisual) window.refreshNodeVisual(ip);

    // No-op if Map was never opened, and doesn't reset its pan/zoom if it was.
    if (window.renderMapMarkers) window.renderMapMarkers();

    // Same guard as setActiveSnapshot: the dashboard renders this topology separately and is
    // only refreshed while it is the visible view.
    if (activeCenterView === 'analysis') window.refreshAnalysisDashboard();

    return true;
};

window.openRightDrawer = function(ip) {
    var previous = currentSelectedNodeData;
    currentSelectedNodeData = deviceByIp.get(String(ip));
    // A port selection belongs to one device. A same-device reopen keeps it, so the
    // highlight survives a rescan merge.
    if (!previous || String(previous.DeviceIP) !== String(ip)) selectedInterfacePort = null;
    var panel = document.getElementById('device-drawer');
    var emptyNote = document.getElementById('device-empty');
    document.getElementById('drawer-title').innerText = ip;
    // Clear any stale "Reachable"/"No response" left from the previously open device.
    var pingResultEl = document.getElementById('pingResult');
    if (pingResultEl) { pingResultEl.textContent = ''; pingResultEl.className = ''; }

    // #rescanBtn/#pingBtn are shared, not per-device: a poll still running for a DIFFERENT
    // device would read as "stuck" under this one, so the button is reset while the poll
    // itself keeps running (its finish() then harmlessly re-enables an enabled button). A
    // poll for the same IP being reopened is left alone.
    var openIp = String(ip);
    if (rescanPollTargetIp && rescanPollTargetIp !== openIp) {
        var rescanBtn = document.getElementById('rescanBtn');
        if (rescanBtn) { rescanBtn.disabled = false; rescanBtn.textContent = 'Re-scan'; }
    }
    if (pingPollTargetIp && pingPollTargetIp !== openIp) {
        var pingBtn = document.getElementById('pingBtn');
        if (pingBtn) { pingBtn.disabled = false; pingBtn.textContent = 'Ping'; }
    }

    if (!currentSelectedNodeData) {
        document.getElementById('summary-content').innerHTML = `<div style="color:red; padding:20px;">No diagnostic data found (Unscanned Node).</div>`;
        // Every other tab still holds the PREVIOUS device's content, which would now be
        // mislabeled as this one's.
        var alarmsTbody = document.getElementById('alarms-tbody');
        if (alarmsTbody) alarmsTbody.innerHTML = `<tr><td colspan="3" style="text-align:center;">No active alarms</td></tr>`;
        var stackTbody = document.getElementById('stack-tbody');
        if (stackTbody) stackTbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No hardware data</td></tr>`;
        var neighborsTbody = document.getElementById('neighbors-tbody');
        if (neighborsTbody) neighborsTbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No LLDP neighbors found</td></tr>`;
        var interfacesTbody = document.getElementById('interfaces-tbody');
        if (interfacesTbody) interfacesTbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No interface data</td></tr>`;
        if (typeof window.renderChassisView === 'function') window.renderChassisView(null, null);
        var configContent = document.getElementById('config-content');
        if (configContent) configContent.textContent = 'No configuration backup available for this device.';
        var compareContainer = document.getElementById('configCompareContainer');
        if (compareContainer) compareContainer.style.display = 'none';
        var configDiffContent = document.getElementById('config-diff-content');
        if (configDiffContent) configDiffContent.style.display = 'none';
        if (configContent) configContent.style.display = '';
        configCompareTarget = null;
        panel.style.display = 'flex';
        emptyNote.style.display = 'none';
        return;
    }

    window.renderSummary();
    window.renderStack();
    window.renderNeighbors();
    window.renderInterfaces();
    window.renderConfig();

    panel.style.display = 'flex';
    emptyNote.style.display = 'none';
};

window.renderSummary = function() {
    var d = currentSelectedNodeData;
    var alarms = window.asArray(d.Alarms);
    var alarmsHtml = alarms.length > 0
        ? `<span class="badge red">${alarms.length} ACTIVE</span>`
        : `<span class="badge green">None</span>`;

    var rescannedHtml = d.RescannedAt
        ? `<div style="grid-column:1/-1; background:var(--warn-bg); color:var(--warn-text); padding:6px 12px; border-radius:4px; font-size:0.8rem; margin-bottom:4px;">
             Live rescan at ${esc(new Date(d.RescannedAt).toLocaleTimeString('en-US'))} - not saved to the snapshot file, this session only.
           </div>`
        : '';

    // Surfaced prominently so the mostly-empty fields below can't pass as a normal,
    // fully-scanned device.
    var scanStatusHtml = (d.ScanStatus && d.ScanStatus !== "Ok")
        ? `<div style="grid-column:1/-1; background:var(--danger-bg); color:var(--danger-text); border:1px solid var(--danger-border); padding:8px 12px; border-radius:4px; font-size:0.85rem; margin-bottom:4px;">
             <b>Scan ${esc(d.ScanStatus)}</b>${d.ScanError ? ` &mdash; ${esc(d.ScanError)}` : ''} - the data below may be incomplete or stale.
           </div>`
        : '';

    var html = `
        ${scanStatusHtml}
        ${rescannedHtml}
        <div class="summary-item"><label>Hostname</label><div>${esc(d.Hostname) || 'N/A'}</div></div>
        <div class="summary-item"><label>IP Address</label><div>${esc(d.DeviceIP) || 'N/A'}</div></div>
        <div class="summary-item"><label>Junos OS</label><div>${esc(d.JunosVersion) || 'N/A'}</div></div>
        <div class="summary-item"><label>Gateway</label><div>${esc(d.Gateway) || 'N/A'}</div></div>
        <div class="summary-item"><label>Connected Neighbors</label><div>${window.asArray(d.Neighbors).length} Switches</div></div>
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
    var stackMembers = window.asArray(currentSelectedNodeData.StackMembers);
    if (stackMembers.length > 0) {
        stackMembers.forEach(sm => {
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
    var neighborRows = window.asArray(currentSelectedNodeData.Neighbors);
    if (neighborRows.length > 0) {
        neighborRows.forEach(n => {
            html += `<tr>
                <td><b>${esc(n.LocalPort) || "?"}</b></td>
                <td>${esc(n.Hostname) || "Unknown"}<br><span style="font-family:monospace; color:var(--text-muted); font-size:0.75rem;">${esc(n.ManagementIP) || "Unknown"}</span></td>
                <td>${esc(n.RemotePort) || "?"}</td>
                <td style="font-style:italic; color:var(--text-muted);">${esc(n.Description)}</td>
            </tr>`;
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="4" style="text-align:center;">No LLDP neighbors found</td></tr>`;
};

// Column-click sort state for #interfaces-table. A null column means the default
// down-first/longest-inactive-first order. Deliberately not reset by openRightDrawer, so a
// chosen sort persists across devices.
var interfaceSortState = { column: null, dir: 1 };

// One comparator per data-sort-key in #interfaces-table's <thead>, each ASCENDING;
// sortInterfacesBy applies the direction on top, so no comparator needs to know it.
var INTERFACE_SORT_COMPARATORS = {
    port: (a, b) => String(a.Port || '').localeCompare(String(b.Port || ''), undefined, { numeric: true, sensitivity: 'base' }),
    // Third argument is renderInterfaces' classification map (trunk < access with clients <
    // idle access < shutdown); ties fall back to port order.
    type: (a, b, typeOf) => ((typeOf && typeOf.get(a) ? typeOf.get(a).order : 9) - (typeOf && typeOf.get(b) ? typeOf.get(b).order : 9)) || INTERFACE_SORT_COMPARATORS.port(a, b),
    state: (a, b) => `${a.Admin}/${a.Link}`.localeCompare(`${b.Admin}/${b.Link}`, undefined, { sensitivity: 'base' }),
    description: (a, b) => String(a.Desc || '').localeCompare(String(b.Desc || ''), undefined, { sensitivity: 'base' }),
};

window.sortInterfacesBy = function(column) {
    if (interfaceSortState.column === column) {
        interfaceSortState.dir *= -1;
    } else {
        interfaceSortState.column = column;
        interfaceSortState.dir = 1;
    }
    window.renderInterfaces();
};

function updateInterfaceSortArrows() {
    Object.keys(INTERFACE_SORT_COMPARATORS).forEach(col => {
        var el = document.getElementById('sort-arrow-' + col);
        if (!el) return;
        el.textContent = (interfaceSortState.column !== col) ? '' : (interfaceSortState.dir === 1 ? '▲' : '▼');
    });
}

// Bare interface name of the port highlighted in both the front panel and the interfaces
// table, or null. One selection per open device.
var selectedInterfacePort = null;

// Toggles the selected port. A chassis click on a down port turns off "Hide Inactive Ports"
// first, or the jack lights up with no row to show for it. Chassis clicks scroll the row
// into view; table clicks don't, since the row is already under the pointer.
window.selectInterfacePort = function(port, opts) {
    opts = opts || {};
    // A search/drill-down navigation sets the selection outright; clicks toggle it.
    var fromNav = opts.source === 'search';
    selectedInterfacePort = (!fromNav && selectedInterfacePort === port) ? null : port;
    if (selectedInterfacePort && (opts.source === 'chassis' || fromNav)) {
        var hideDownEl = document.getElementById('hideDownPorts');
        var intf = window.asArray(currentSelectedNodeData && currentSelectedNodeData.Interfaces)
            .find(i => i && String(i.Port) === selectedInterfacePort);
        if (hideDownEl && hideDownEl.checked && intf && String(intf.Link).toLowerCase() !== "up") hideDownEl.checked = false;
    }
    window.renderInterfaces();
    if (selectedInterfacePort && (opts.source === 'chassis' || fromNav)) {
        var row = document.querySelector('#interfaces-tbody tr.intf-row.selected');
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};

// Port modes parsed out of the captured config ("interface-mode", or "port-mode" on older
// Junos). Map of bare port -> 'trunk'|'access', memoised per device: the config is large.
var portModeCache = new WeakMap();
function buildPortModes(device) {
    if (!device) return new Map();
    if (portModeCache.has(device)) return portModeCache.get(device);
    var modes = new Map();
    var re = /^set interfaces (\S+) unit \d+ family ethernet-switching (?:interface-mode|port-mode) (trunk|access)\b/gm;
    var m, cfg = String(device.Configuration || '');
    while ((m = re.exec(cfg)) !== null) modes.set(window.normalizePort(m[1]), m[2]);
    portModeCache.set(device, modes);
    return modes;
}

// What a port IS, in one word, for the collapsed list. Precedence: shutdown beats
// everything; an LLDP switch on the far end or a configured trunk is a Trunk; the rest are
// Access. `order` is the Type column's sort rank.
function classifyInterface(intf, ctx) {
    var port = window.normalizePort(intf.Port);
    var adminUp = String(intf.Admin).toLowerCase() === "up", linkUp = String(intf.Link).toLowerCase() === "up";
    var neighbor = ctx.neighborsByPort.get(port);
    var clients = ctx.clientsByPort.get(port) || [];
    if (!adminUp) return { kind: 'shutdown', label: 'Shutdown', badge: 'gray', detailHtml: '<span class="intf-type-detail">admin down</span>', order: 3 };
    if (neighbor || ctx.modeByPort.get(port) === 'trunk') {
        var who = neighbor ? esc(neighbor.Hostname && neighbor.Hostname !== 'Unknown' ? neighbor.Hostname : neighbor.ManagementIP) + (neighbor.RemotePort && neighbor.RemotePort !== 'Unknown' ? ' <span class="intf-remote">' + esc(neighbor.RemotePort) + '</span>' : '') : 'no LLDP neighbor';
        return { kind: 'trunk', label: neighbor ? 'Trunk' : 'Trunk (config)', badge: 'accent', detailHtml: '<span class="intf-type-detail">' + who + '</span>', order: 0 };
    }
    if (clients.length) {
        var macs = clients.map(c => String(c.MAC || '').toUpperCase()).filter(Boolean);
        var shown = macs.slice(0, 2).map(mac => `<span class="intf-mac">${esc(mac)}</span>`).join('');
        var more = macs.length > 2 ? `<span class="intf-more">+${macs.length - 2}</span>` : '';
        return { kind: 'access', label: 'Access', badge: 'green', detailHtml: shown + more, order: 1 };
    }
    return { kind: 'access-idle', label: 'Access', badge: linkUp ? 'green' : 'gray', detailHtml: `<span class="intf-type-detail">${linkUp ? 'no clients learned' : 'no link'}</span>`, order: 2 };
}

// Resolves a search target to the bare port it lives on: `{port}` directly, or `{client}`
// matched case-insensitively against client IPs, MACs and 802.1X usernames.
window.focusPortFor = function(device, focus) {
    if (!device || !focus) return null;
    if (focus.port) return window.normalizePort(focus.port);
    if (focus.client) {
        var q = String(focus.client).toLowerCase();
        var hit = window.asArray(device.TrueClients).find(c => c && [c.IP, c.MAC, c.Dot1x_User].some(v => v && String(v).toLowerCase() === q));
        if (!hit) hit = window.asArray(device.TrueClients).find(c => c && [c.IP, c.MAC, c.Dot1x_User].some(v => v && String(v).toLowerCase().includes(q)));
        return hit ? window.normalizePort(hit.Port) : null;
    }
    return null;
};

// Interfaces and their edge clients in one table. Rows collapse to what identifies a port at
// a glance; the selected row expands into a detail strip plus its client rows, one port at a
// time. Clients still honor the shared #vlanFilter.
window.renderInterfaces = function() {
    var tbody = document.getElementById('interfaces-tbody');
    var hideDown = document.getElementById('hideDownPorts').checked;
    var vlanFilter = document.getElementById('vlanFilter').value;
    var daisyChains = window.detectDaisyChains(currentSelectedNodeData);
    var html = "";

    var clientsByPort = new Map();
    var clients = window.asArray(currentSelectedNodeData.TrueClients).slice();
    if (vlanFilter !== "ALL") {
        clients = clients.filter(c => String(c.VLAN_Tag) === vlanFilter.toString());
    }
    clients.sort((a, b) => {
        if (a.IP === "Unknown") return 1; if (b.IP === "Unknown") return -1;
        var numA = Number(String(a.IP).split('.').map(n => (`000${n}`).slice(-3)).join(''));
        var numB = Number(String(b.IP).split('.').map(n => (`000${n}`).slice(-3)).join(''));
        return numA - numB;
    });
    clients.forEach(c => {
        var key = window.normalizePort(c.Port);
        if (!clientsByPort.has(key)) clientsByPort.set(key, []);
        clientsByPort.get(key).push(c);
    });
    var neighborsByPort = new Map();
    window.asArray(currentSelectedNodeData.Neighbors).forEach(n => { if (n && n.LocalPort && n.LocalPort !== 'Unknown') neighborsByPort.set(window.normalizePort(n.LocalPort), n); });
    var ctx = { clientsByPort: clientsByPort, neighborsByPort: neighborsByPort, modeByPort: buildPortModes(currentSelectedNodeData) };

    if (currentSelectedNodeData.Interfaces) {
        var rows = window.asArray(currentSelectedNodeData.Interfaces).filter(intf => {
            if (!intf.Port || String(intf.Port).includes('.')) return false;
            if (hideDown && String(intf.Link).toLowerCase() !== "up") return false;
            return true;
        });
        var typeOf = new Map(rows.map(intf => [intf, classifyInterface(intf, ctx)]));

        if (interfaceSortState.column && INTERFACE_SORT_COMPARATORS[interfaceSortState.column]) {
            var cmp = INTERFACE_SORT_COMPARATORS[interfaceSortState.column];
            rows.sort((a, b) => interfaceSortState.dir * cmp(a, b, typeOf));
        } else {
            // Down ports first, longest-inactive first, unknown durations last among them -
            // the ports most worth attention surface at the top. Up ports keep their original
            // order: the comparator returns 0 for any up/up pair and the sort is stable.
            rows.sort((a, b) => {
                var aDown = String(a.Link).toLowerCase() !== "up", bDown = String(b.Link).toLowerCase() !== "up";
                if (aDown !== bDown) return aDown ? -1 : 1;
                if (!aDown) return 0;
                var av = a.LastFlappedSeconds, bv = b.LastFlappedSeconds;
                if (av === null || av === undefined) return (bv === null || bv === undefined) ? 0 : 1;
                if (bv === null || bv === undefined) return -1;
                return bv - av;
            });
        }

        rows.forEach(intf => {
            var portName = String(intf.Port);
            var selected = portName === selectedInterfacePort;
            var type = typeOf.get(intf);
            var linkBadge = String(intf.Link).toLowerCase() === "up" ? "green" : "red";
            var chain = daisyChains.get(window.normalizePort(intf.Port));
            var desc = (intf.Desc && intf.Desc !== 'Unknown') ? intf.Desc : '';

            html += `<tr class="intf-row${selected ? ' selected' : ''}" data-port="${esc(portName)}" tabindex="0" role="button" aria-pressed="${selected}" onclick="window.selectInterfacePort(this.dataset.port, {source:'table'})" onkeydown="window.activateOnKey(event, () => window.selectInterfacePort(this.dataset.port, {source:'table'}))">
                <td><span class="intf-chev">&#9656;</span><b>${esc(intf.Port)}</b></td>
                <td class="intf-type"><span class="badge ${type.badge}">${type.label}</span>${type.detailHtml}${chain ? ' ' + window.renderDaisyChainBadge(chain) : ''}</td>
                <td><span class="badge ${linkBadge}">${esc(intf.Admin)}/${esc(intf.Link)}</span></td>
                <td class="intf-desc" title="${esc(desc)}">${esc(desc)}</td>
            </tr>`;

            if (!selected) return;

            var stpBadge = String(intf.STP) === "FWD" ? "green" : (String(intf.STP) === "BLK" ? "red" : "gray");
            var poeTxt = (!intf.PoE || intf.PoE === "Unknown") ? "-" : intf.PoE;
            var secs = intf.LastFlappedSeconds;
            var inactiveFor = String(intf.Link).toLowerCase() === "up" ? "-"
                : ((secs === null || secs === undefined) ? "Unknown" : window.formatAge(secs * 1000));
            var neighbor = neighborsByPort.get(window.normalizePort(intf.Port));
            var portClients = clientsByPort.get(window.normalizePort(intf.Port)) || [];
            html += `<tr class="intf-detail"><td colspan="4"><div class="intf-detail-grid">
                <div><label>STP</label><span class="badge ${stpBadge}">${esc(intf.STP) || "?"}</span></div>
                <div><label>PoE</label>${esc(poeTxt)}</div>
                <div><label>Inactive for</label>${esc(inactiveFor)}</div>
                <div><label>Port mode</label>${esc(ctx.modeByPort.get(window.normalizePort(intf.Port)) || (neighbor ? 'trunk (LLDP)' : 'unknown'))}</div>
                ${neighbor ? `<div><label>LLDP neighbour</label>${esc(neighbor.Hostname || 'Unknown')} <span class="intf-remote">${esc(neighbor.ManagementIP || '')} ${esc(neighbor.RemotePort || '')}</span></div>` : ''}
                <div class="intf-detail-wide"><label>Description</label>${desc ? esc(desc) : '<span class="intf-type-detail">none configured</span>'}</div>
                <div class="intf-detail-wide"><label>Clients</label>${portClients.length ? portClients.length + ' learned on this port' + (vlanFilter !== "ALL" ? ' (VLAN filter applied)' : '') : '<span class="intf-type-detail">none learned</span>'}</div>
            </div></td></tr>`;
            portClients.forEach(c => { html += renderClientSubRow(c, daisyChains); });
        });
    }
    tbody.innerHTML = html || `<tr><td colspan="4" style="text-align:center;">No interface data</td></tr>`;
    updateInterfaceSortArrows();
    if (typeof window.renderChassisView === 'function') window.renderChassisView(currentSelectedNodeData, selectedInterfacePort);

    // Skipped on a merge-triggered re-render, so a background rescan completing can't yank
    // the user's scroll position while they're reading.
    if (searchHighlightQuery && !isMergeRerender) {
        var highlightedEl = tbody.querySelector('.highlight');
        if (highlightedEl) highlightedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};

function renderClientSubRow(c, daisyChains) {
    var isHighlighted = searchHighlightQuery && ((c.IP && String(c.IP).toLowerCase().includes(searchHighlightQuery)) || (c.MAC && String(c.MAC).toLowerCase().includes(searchHighlightQuery)) || (c.Dot1x_User && String(c.Dot1x_User).toLowerCase().includes(searchHighlightQuery)));
    var rowClass = 'client-subrow' + (isHighlighted ? ' highlight' : '');

    var dotUserStr = (c.Dot1x_User && c.Dot1x_User !== "Unknown") ? esc(c.Dot1x_User) : "None";
    var dotStateColor = (c.Dot1x_State && String(c.Dot1x_State).includes('Auth')) ? 'var(--success-text)' : (c.Dot1x_State !== "Unknown" ? 'var(--danger-text)' : 'var(--text-muted)');
    var dotStateStr = c.Dot1x_State !== "Unknown" ? ` <span style="font-size:0.7rem; color:${dotStateColor};">(${esc(c.Dot1x_State)})</span>` : "";
    var descStr = (c.PortDesc && c.PortDesc !== "Unknown") ? `<span style="color:var(--text-dim);">${esc(c.PortDesc)}</span>` : "";
    var typeClass = String(c.Type).toLowerCase().startsWith('dynamic') ? 'dynamic' : 'static';
    var typeStr = (c.Type && c.Type !== "Unknown") ? `<span class="type-badge ${typeClass}">${esc(c.Type)}</span>` : "";

    var vendorInfo = window.lookupVendor(c.MAC);
    var vendorStr = vendorInfo.vendor
        ? `<span class="vendor-tag vendor-${vendorInfo.category.toLowerCase().replace('/', '-')}" title="Category: ${esc(vendorInfo.category)}">${esc(vendorInfo.vendor)}</span>`
        : "";

    var chain = daisyChains.get(window.normalizePort(c.Port));
    var daisyStr = chain ? window.renderDaisyChainBadge(chain) : "";

    return `<tr class="${rowClass}"><td colspan="4"><div class="client-subrow-inner">
        <span class="csr-identity">${esc(c.IP)}</span>
        <span class="csr-mac">${esc(String(c.MAC).toUpperCase())}</span>
        ${vendorStr}
        <span class="badge" style="background:var(--primary);">VLAN ${esc(c.VLAN_Tag)}</span>
        ${typeStr}
        <span><b>${dotUserStr}</b>${dotStateStr}</span>
        ${descStr}
        ${daisyStr}
    </div></td></tr>`;
}

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

// The config backup is stored verbatim; this tab displays and exports it as-is.
window.renderConfig = function() {
    var el = document.getElementById('config-content');
    if (!el) return;
    var config = currentSelectedNodeData && currentSelectedNodeData.Configuration;
    el.textContent = (config && config !== "Unknown") ? config : "No configuration backup available for this device.";
    window.populateConfigCompareSelect();
};

// Config diff. The tab compares this device against either (a) the SAME device in another
// snapshot (the <select>) or (b) a DIFFERENT device (the search box). The two controls are
// mutually exclusive and both write configCompareTarget, which renderConfigDiff reads.
var configCompareTarget = null; // {idx, ip} being diffed against, or null

// snapshot index -> that snapshot's DeviceIP for the open device, which can differ from the
// drawer's current IP if the device was renumbered between captures.
var sameDeviceIpByIdx = {};

// (a) only. Bounded to one entry per other snapshot, so a plain select suffices here.
window.populateConfigCompareSelect = function() {
    var container = document.getElementById('configCompareContainer');
    var select = document.getElementById('configCompareSelect');
    var searchInput = document.getElementById('configCompareSearch');
    var searchResults = document.getElementById('configCompareSearchResults');
    if (!container || !select) return;

    // The compare selection survives a merge-triggered re-render and is only cleared on a
    // genuine switch to another device. Re-validated below rather than trusted: the rescan
    // can have renamed the OTHER device or dropped its config.
    var preservedTarget = (isMergeRerender && configCompareTarget) ? configCompareTarget : null;

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

    // Matched by identity, not literal IP, so a device renumbered since an older capture
    // still shows as "this same device".
    var identity = window.resolveDeviceIdentity(d);
    var sameDeviceOptions = [];
    loadedSnapshots.forEach((snap, idx) => {
        if (idx === activeSnapshotIndex) return;
        var other = (snap.topology || []).find(dev => dev && dev.DeviceIP && window.resolveDeviceIdentity(dev) === identity);
        if (other && other.Configuration && other.Configuration !== "Unknown") {
            sameDeviceIpByIdx[idx] = String(other.DeviceIP);
            var snapTs = window.parseTimestampMs(snap.scanTimestamp);
            sameDeviceOptions.push({
                idx: idx,
                ts: snapTs !== null ? snapTs : 0,
                label: snapTs !== null ? new Date(snapTs).toLocaleString('en-US') : snap.sourceFile,
            });
        }
    });
    sameDeviceOptions.sort((a, b) => b.ts - a.ts); // most recent other capture first

    select.innerHTML = '<option value="">-- Raw config only --</option>'
        + sameDeviceOptions.map(o => `<option value="${o.idx}">${esc(o.label)}</option>`).join('');
    select.value = '';
    container.style.display = 'flex';

    if (preservedTarget) {
        var otherSnap = loadedSnapshots[preservedTarget.idx];
        var other = otherSnap && (otherSnap.topology || []).find(dev => dev && String(dev.DeviceIP) === preservedTarget.ip);
        var stillValid = other && other.Configuration && other.Configuration !== "Unknown";
        if (stillValid) {
            configCompareTarget = preservedTarget;
            if (sameDeviceIpByIdx[preservedTarget.idx] === preservedTarget.ip) {
                // Still a "same device, other capture" pick - reselect it in the dropdown.
                select.value = String(preservedTarget.idx);
            } else if (searchInput) {
                // A cross-device pick from the search box - restore its label text.
                var label = (other.Hostname && other.Hostname !== "Unknown" ? other.Hostname : preservedTarget.ip) + ' (' + preservedTarget.ip + ')';
                searchInput.value = label;
            }
        }
    }

    window.renderConfigDiff();
};

// Clears the search box, since only one compare target can be active at a time.
window.selectConfigCompareSnapshot = function() {
    var select = document.getElementById('configCompareSelect');
    var searchInput = document.getElementById('configCompareSearch');
    var searchResults = document.getElementById('configCompareSearchResults');
    if (searchInput) searchInput.value = '';
    if (searchResults) searchResults.innerHTML = '';

    // From sameDeviceIpByIdx, not the drawer's IP: they differ if the device was renumbered.
    var idx = select.value ? parseInt(select.value, 10) : null;
    configCompareTarget = select.value
        ? { idx: idx, ip: sameDeviceIpByIdx[idx] || String(currentSelectedNodeData.DeviceIP) }
        : null;
    window.renderConfigDiff();
};

// Live-filters every other device across every loaded snapshot, capped so a broad query
// doesn't dump hundreds of rows into the DOM.
var CONFIG_COMPARE_MAX_RESULTS = 25;
window.searchConfigCompareDevices = function() {
    var input = document.getElementById('configCompareSearch');
    var resultsEl = document.getElementById('configCompareSearchResults');
    if (!input || !resultsEl) return;
    var query = input.value.trim();

    // Typing invalidates whatever was previously selected (search or dropdown).
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
            var snapTs = window.parseTimestampMs(snap.scanTimestamp);
            matches.push({
                idx: idx, ip: String(other.DeviceIP), hostname: hostname,
                ts: snapTs !== null ? snapTs : 0,
                snapLabel: snapTs !== null ? new Date(snapTs).toLocaleString('en-US') : snap.sourceFile,
            });
        });
    });
    matches.sort((a, b) => (a.hostname || a.ip).localeCompare(b.hostname || b.ip) || b.ts - a.ts);

    var truncated = matches.length > CONFIG_COMPARE_MAX_RESULTS;
    matches = matches.slice(0, CONFIG_COMPARE_MAX_RESULTS);

    var rows = matches.map(m => {
        var snapshotTag = loadedSnapshots.length > 1 ? `<span class="sr-snapshot">${esc(m.snapLabel)}</span>` : '';
        return {
            line1Html: `${esc(m.hostname || m.ip)}${m.hostname ? ` <span style="color:var(--text-dim); font-weight:normal;">(${esc(m.ip)})</span>` : ''}${snapshotTag}`,
            onClick: () => window.selectConfigCompareDevice(m.idx, m.ip),
        };
    });

    window.renderResultsList(rows, { targetId: 'configCompareSearchResults', emptyText: `No devices match "${query}".` });
    if (truncated) {
        resultsEl.insertAdjacentHTML('beforeend', `<div class="search-no-results">Showing first ${CONFIG_COMPARE_MAX_RESULTS} matches - keep typing to narrow it down.</div>`);
    }
};

// Resolves a clicked search result to a compare target and collapses the results list.
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
    // Identity-based: a "same device, other capture" pick can carry a different IP and must
    // not trip the cross-device banner below.
    var isCrossDevice = !other || window.resolveDeviceIdentity(other) !== window.resolveDeviceIdentity(d);
    var otherLabel = esc(other && other.Hostname && other.Hostname !== "Unknown" ? other.Hostname : otherIp);

    var header = isCrossDevice
        ? `<div class="config-diff-header">Comparing against <strong>${otherLabel}</strong> (${esc(otherIp)}) &mdash; these are two different switches, not a change history, so a large diff is expected. Left = ${otherLabel}, right = this device.</div>`
        : '<div class="config-diff-header">Left = previous snapshot, right = this device&apos;s current configuration.</div>';

    var lineRows = computeLineDiff(otherConfig, d.Configuration);
    var bodyHtml;
    if (lineRows === null) {
        // Too large for the positional diff - fall back to the order-independent set diff.
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

// Printable device report. Deliberately excludes the config backup text: it can hold SNMP
// communities and RADIUS/TACACS+ secrets, too sensitive for something printed or emailed
// around - the config export button exists for that. Opens with a visible Print button
// rather than auto-firing window.print(), avoiding popup/timing issues.
window.printDeviceReport = function() {
    var d = currentSelectedNodeData;
    if (!d) { window.setStatus("No device selected.", "red"); return; }

    var alarms = window.asArray(d.Alarms);
    var stack = window.asArray(d.StackMembers);
    var neighbors = window.asArray(d.Neighbors);
    var interfaces = window.asArray(d.Interfaces);
    var clients = window.asArray(d.TrueClients || d.Clients);

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
<div class="subtitle">${esc(d.DeviceIP)} &mdash; Junos ${esc(d.JunosVersion)} &mdash; report generated ${esc(new Date().toLocaleString('en-US'))}</div>

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

    // A blob URL rather than document.write(), and deliberately not revoked: the new tab
    // needs it valid while the user reviews and prints.
    var blob = new Blob([html], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var reportWindow = window.open(url, '_blank');
    if (!reportWindow) {
        URL.revokeObjectURL(url);
        window.setStatus("Could not open report - check your browser's popup blocker.", "red");
    }
};

// Exports the currently displayed (filtered) rows, not the full dataset, so the download
// matches what's on screen.
window.exportInterfacesCsv = function() {
    if (!currentSelectedNodeData) { window.setStatus("Select a switch first.", "red"); return; }
    var hideDown = document.getElementById('hideDownPorts').checked;
    var rows = [['Port', 'Admin', 'Link', 'STP', 'PoE', 'Description', 'Inactive For']];

    window.asArray(currentSelectedNodeData.Interfaces).forEach(intf => {
        if (!intf.Port || String(intf.Port).includes('.')) return;
        if (hideDown && String(intf.Link).toLowerCase() !== "up") return;
        var poeTxt = (!intf.PoE || intf.PoE === "Unknown") ? "-" : intf.PoE;
        // LastFlappedSeconds is captured once per scan, so this is as of the snapshot's
        // capture time, not a live clock.
        var secs = intf.LastFlappedSeconds;
        var inactiveFor = String(intf.Link).toLowerCase() === "up" ? "-"
            : ((secs === null || secs === undefined) ? "Unknown" : window.formatAge(secs * 1000));
        rows.push([intf.Port, intf.Admin, intf.Link, intf.STP, poeTxt, intf.Desc, inactiveFor]);
    });

    downloadCsv(`${currentSelectedNodeData.DeviceIP}_interfaces.csv`, rows);
};

window.exportClientsCsv = function() {
    if (!currentSelectedNodeData) { window.setStatus("Select a switch first.", "red"); return; }
    var vlanFilter = document.getElementById('vlanFilter').value;
    var clients = window.asArray(currentSelectedNodeData.TrueClients).slice();

    if (vlanFilter !== "ALL") { clients = clients.filter(c => String(c.VLAN_Tag) === vlanFilter.toString()); }
    clients.sort((a, b) => {
        if (a.IP === "Unknown") return 1; if (b.IP === "Unknown") return -1;
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
