// The Analysis Dashboard (#sidebar-tab-analysis): Fleet Health, New Devices, Trends,
// Local Accounts, Topology Diff, IP Space, Reliability - plus the stat-card drill-down
// that jumps into a search.js results list. Reads loadedSnapshots/activeSnapshotIndex/
// globalTopologyData (app.js), window.loadSettings/updateDeviceHistory/updateAlarmHistory
// (persistence.js), window.asArray/lookupVendor/detectDaisyChains (utils.js), and
// window.renderResultsList/goToSearchResult/switchSidebarTab (search.js/app.js).

// Re-renders every Analysis Dashboard view - called on tab activation (see
// window.switchSidebarTab) and again after a file load if that tab is already showing,
// so it doesn't sit stale until the user clicks away and back.
window.refreshAnalysisDashboard = function() {
    window.renderFleetDashboard();
    window.renderNewDevicesTable();
    window.populateTrendDeviceSelect();
    window.renderTrendChart();
    window.renderLocalAccountsAudit();
    window.populateTopologyDiffSelects();
    window.renderTopologyDiff();
    window.renderIpSpaceUtilization();
    window.populateReliabilityDeviceSelect();
    window.renderReliabilityHeatmap();
};

window.switchAnalysisTab = function(tabId) {
    document.querySelectorAll('.analysis-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.analysis-tab').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    if (tabId === 'analysis-tab-trends') window.renderTrendChart();
    if (tabId === 'analysis-tab-fleethealth') window.renderFleetDashboard();
    if (tabId === 'analysis-tab-accounts') window.renderLocalAccountsAudit();
    if (tabId === 'analysis-tab-topodiff') window.renderTopologyDiff();
    if (tabId === 'analysis-tab-ipspace') window.renderIpSpaceUtilization();
    if (tabId === 'analysis-tab-reliability') window.renderReliabilityHeatmap();
};

// Aggregates the ACTIVE snapshot only (not every loaded snapshot merged together -
// merging different points in time into one "fleet" view would double-count devices and
// mix states that were never simultaneously true). Works with just one snapshot loaded,
// unlike New Devices/Trends which genuinely need history.
// Config diff (see the Config tab / window.renderConfigDiff in drawer.js). "show
// configuration | display set" output is a flat list of complete, order-independent
// statements - Junos doesn't guarantee stable line ordering between commits either - so
// this is a plain set difference, not a positional line diff (Myers/LCS). Blank lines are
// dropped and each line is trimmed so incidental whitespace never shows up as a phantom
// change.
function configSetDiff(oldText, newText) {
    var oldLines = new Set(String(oldText || '').split('\n').map(l => l.trim()).filter(Boolean));
    var newLines = new Set(String(newText || '').split('\n').map(l => l.trim()).filter(Boolean));
    return {
        removed: Array.from(oldLines).filter(l => !newLines.has(l)),
        added: Array.from(newLines).filter(l => !oldLines.has(l)),
    };
}

// For every device with a real config backup in 2+ loaded snapshots, compares its two
// MOST RECENT captures (by scanTimestamp) and flags whether they differ at all - cheap
// string equality, not a full diff (the actual line-level diff is computed lazily, only
// when a user opens that device's Config tab). Spans every loaded snapshot regardless of
// which is active, same as window.updateDeviceHistory - "did this change since last time"
// is a cross-snapshot question, not a single-snapshot one.
function computeConfigChanges() {
    var byDevice = new Map(); // deviceIp -> [{idx, ts, config, hostname}]
    loadedSnapshots.forEach((snap, idx) => {
        if (!snap.scanTimestamp) return;
        (snap.topology || []).forEach(d => {
            if (!d || !d.DeviceIP || !d.Configuration || d.Configuration === "Unknown") return;
            var ip = String(d.DeviceIP);
            if (!byDevice.has(ip)) byDevice.set(ip, []);
            byDevice.get(ip).push({ idx: idx, ts: new Date(snap.scanTimestamp).getTime(), config: d.Configuration, hostname: d.Hostname });
        });
    });

    var changed = [];
    byDevice.forEach((entries, ip) => {
        if (entries.length < 2) return;
        entries.sort((a, b) => b.ts - a.ts);
        if (entries[0].config !== entries[1].config) {
            changed.push({ deviceIp: ip, hostname: entries[0].hostname, newIdx: entries[0].idx, oldIdx: entries[1].idx });
        }
    });
    return changed;
}

window.renderFleetDashboard = function() {
    var container = document.getElementById('fleet-health-content');
    if (!container) return;
    var settings = window.loadSettings();
    var activeSnapshot = loadedSnapshots[activeSnapshotIndex];
    var devices = globalTopologyData || [];

    if (devices.length === 0) {
        container.innerHTML = '<p class="fleet-list-empty">No topology loaded.</p>';
        return;
    }

    // --- Fleet totals ---
    var totalClients = 0, totalAlarms = 0;
    devices.forEach(d => { totalClients += (d.TrueClients || []).length; totalAlarms += window.asArray(d.Alarms).length; });

    // --- Worst-N by CPU / Memory ---
    function worstBy(field) {
        return devices
            .map(d => ({ device: d, value: parseFloat(d[field]) }))
            .filter(x => !isNaN(x.value))
            .sort((a, b) => b.value - a.value)
            .slice(0, 5);
    }
    var worstCpu = worstBy('MasterCpuUtilization');
    var worstMem = worstBy('MasterMemoryUtilization');

    function thresholdClass(value, warn, critical) {
        return value >= critical ? 'red' : (value >= warn ? 'warn-badge' : 'green');
    }

    // --- Recently rebooted (elapsed since boot, measured from THIS snapshot's capture
    // time - not the browser's wall-clock "now", which would be wrong when viewing old
    // data long after it was captured) ---
    var recentlyRebooted = [];
    if (activeSnapshot && activeSnapshot.scanTimestamp) {
        var snapTime = new Date(activeSnapshot.scanTimestamp).getTime();
        devices.forEach(d => {
            if (!d.Uptime || d.Uptime === "Unknown") return;
            var bootTime = new Date(d.Uptime).getTime();
            if (isNaN(bootTime)) return;
            var elapsedMin = (snapTime - bootTime) / 60000;
            if (elapsedMin >= 0 && elapsedMin < settings.recentRebootMin) {
                recentlyRebooted.push({ device: d, elapsedMin: elapsedMin });
            }
        });
    }

    // --- Dot1x compliance: a live client whose port IS running dot1x but isn't
    // Authenticated. "Unknown" means dot1x isn't observed for that MAC at all (not
    // necessarily a violation - many uplinks/infra ports never run dot1x), so it's
    // excluded rather than counted. ---
    var dot1xViolations = [];
    devices.forEach(d => (d.TrueClients || []).forEach(c => {
        if (c.Dot1x_State && c.Dot1x_State !== "Unknown" && c.Dot1x_State !== "Authenticated") {
            dot1xViolations.push({ device: d, client: c });
        }
    }));

    // --- Vendor/category breakdown ---
    var categoryCounts = {};
    devices.forEach(d => (d.TrueClients || []).forEach(c => {
        var cat = window.lookupVendor(c.MAC).category;
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }));

    // --- Daisy-chain count ---
    var daisyChainCount = 0;
    devices.forEach(d => { daisyChainCount += window.detectDaisyChains(d).size; });

    // --- New devices detected in exactly this snapshot ---
    var history = window.updateDeviceHistory();
    var newInThisSnapshot = activeSnapshot ? Object.values(history).filter(h => h.firstSeen === activeSnapshot.scanTimestamp).length : 0;

    // --- Config changes since each device's previous capture (see computeConfigChanges) ---
    var configChanges = computeConfigChanges();

    // --- Render ---
    // Cards below are click-to-drill-down (see window.drillDownStat) into a full,
    // search-style list of the underlying devices/clients - "New This Snapshot" is left
    // as a plain count since it has no single natural list target of its own (it's a
    // count of distinct client MACs first seen in this snapshot, spread across devices).
    var html = `<div class="fleet-stats-grid">
        <div class="fleet-stat-card drillable" onclick="window.drillDownStat('devices')"><div class="stat-value">${devices.length}</div><div class="stat-label">Devices</div></div>
        <div class="fleet-stat-card drillable" onclick="window.drillDownStat('clients')"><div class="stat-value">${totalClients}</div><div class="stat-label">Clients</div></div>
        <div class="fleet-stat-card drillable ${totalAlarms > 0 ? 'critical' : ''}" onclick="window.drillDownStat('alarms')"><div class="stat-value">${totalAlarms}</div><div class="stat-label">Active Alarms</div></div>
        <div class="fleet-stat-card drillable ${dot1xViolations.length > 0 ? 'warn' : ''}" onclick="window.drillDownStat('dot1x')"><div class="stat-value">${dot1xViolations.length}</div><div class="stat-label">Dot1x Violations</div></div>
        <div class="fleet-stat-card drillable" onclick="window.drillDownStat('daisychains')"><div class="stat-value">${daisyChainCount}</div><div class="stat-label">Daisy-Chained Ports</div></div>
        <div class="fleet-stat-card drillable ${configChanges.length > 0 ? 'warn' : ''}" onclick="window.drillDownStat('configchanged')"><div class="stat-value">${configChanges.length}</div><div class="stat-label">Config Changed</div></div>
        <div class="fleet-stat-card"><div class="stat-value">${newInThisSnapshot}</div><div class="stat-label">New This Snapshot</div></div>
    </div>`;

    html += '<div class="fleet-dashboard-columns">';

    html += '<div><div class="fleet-section"><h3>Highest RE CPU</h3>' + (worstCpu.length === 0
        ? '<p class="fleet-list-empty">No CPU data available.</p>'
        : worstCpu.map(x => `<div class="fleet-list-row"><span>${esc(x.device.Hostname || x.device.DeviceIP)}</span><span class="badge ${thresholdClass(x.value, settings.cpuWarnPct, settings.cpuCriticalPct)}">${x.value}%</span></div>`).join('')
    ) + '</div>';

    html += '<div class="fleet-section"><h3>Highest RE Memory</h3>' + (worstMem.length === 0
        ? '<p class="fleet-list-empty">No memory data available.</p>'
        : worstMem.map(x => `<div class="fleet-list-row"><span>${esc(x.device.Hostname || x.device.DeviceIP)}</span><span class="badge ${thresholdClass(x.value, settings.memWarnPct, settings.memCriticalPct)}">${x.value}%</span></div>`).join('')
    ) + '</div></div>';

    html += '<div><div class="fleet-section"><h3>Recently Rebooted (&lt; ' + settings.recentRebootMin + ' min)</h3>' + (recentlyRebooted.length === 0
        ? '<p class="fleet-list-empty">None.</p>'
        : recentlyRebooted.map(x => `<div class="fleet-list-row"><span>${esc(x.device.Hostname || x.device.DeviceIP)}</span><span class="badge accent">${Math.round(x.elapsedMin)} min ago</span></div>`).join('')
    ) + '</div></div></div>';

    html += '<div class="fleet-section"><h3>Client Vendor/Category Breakdown</h3>' +
        Object.keys(categoryCounts).sort((a, b) => categoryCounts[b] - categoryCounts[a]).map(cat =>
            `<div class="fleet-list-row"><span class="vendor-tag vendor-${cat.toLowerCase().replace('/', '-')}">${esc(cat)}</span><span>${categoryCounts[cat]}</span></div>`
        ).join('') + '</div>';

    container.innerHTML = html;
};

// Reverse-chronological by First Seen, per the explicit request - newest detections at
// the top, so it doubles as a "what's new" alert list.
window.renderNewDevicesTable = function() {
    var tbody = document.getElementById('new-devices-tbody');
    var history = window.updateDeviceHistory();

    var rows = Object.keys(history).map(mac => Object.assign({ mac: mac }, history[mac]));
    rows.sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No client history yet.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(r => {
        var vendorInfo = window.lookupVendor(r.mac);
        var vendorStr = vendorInfo.vendor
            ? esc(vendorInfo.vendor) + (vendorInfo.category !== 'Other' ? ` (${esc(vendorInfo.category)})` : '')
            : '-';
        return `<tr>
            <td>${esc(new Date(r.firstSeen).toLocaleString())}</td>
            <td style="font-family:monospace;">${esc(r.mac.toUpperCase())}</td>
            <td>${vendorStr}</td>
            <td>${esc(r.lastIp)}</td>
            <td>${esc(r.lastDeviceIp)} / ${esc(r.lastPort)}</td>
            <td>${esc(new Date(r.lastSeen).toLocaleString())}</td>
        </tr>`;
    }).join('');
};

window.populateTrendDeviceSelect = function() {
    var select = document.getElementById('trendDeviceSelect');
    var deviceMap = new Map(); // ip -> hostname, from whichever loaded snapshot last saw it
    loadedSnapshots.slice()
        .sort((a, b) => new Date(a.scanTimestamp || 0) - new Date(b.scanTimestamp || 0))
        .forEach(s => s.topology.forEach(d => { if (d && d.DeviceIP) deviceMap.set(String(d.DeviceIP), d.Hostname || 'Unknown'); }));

    var ips = Array.from(deviceMap.keys()).sort((a, b) => window.GraphLayout.compareIpIds(a, b));
    var prevValue = select.value;
    select.innerHTML = ips.map(ip => `<option value="${esc(ip)}">${esc(ip)} (${esc(deviceMap.get(ip))})</option>`).join('');
    if (ips.includes(prevValue)) select.value = prevValue;
};

var TREND_METRIC_LABELS = { cpu: 'RE CPU %', mem: 'RE Memory %', alarms: 'Alarm Count', clients: 'Client Count' };

function trendMetricValue(device, metric) {
    if (metric === 'cpu') return parseFloat(device.MasterCpuUtilization);
    if (metric === 'mem') return parseFloat(device.MasterMemoryUtilization);
    if (metric === 'alarms') return window.asArray(device.Alarms).length;
    if (metric === 'clients') return (device.TrueClients || []).length;
    return NaN;
}

// Plain <canvas> line chart - no vendored charting library, matching the rest of this
// codebase's "vendor only what's necessary, hand-roll everything else" pattern (see the
// topology graph's own radial layout).
window.renderTrendChart = function() {
    var canvas = document.getElementById('trendCanvas');
    var ctx = canvas.getContext('2d');
    var metric = document.getElementById('trendMetricSelect').value;
    var deviceIp = document.getElementById('trendDeviceSelect').value;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '13px sans-serif';

    function centeredMessage(msg) {
        ctx.fillStyle = '#888';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
    }

    if (!deviceIp) { centeredMessage('No devices available - load 2+ snapshots first.'); return; }

    var points = loadedSnapshots
        .filter(s => s.scanTimestamp)
        .slice()
        .sort((a, b) => new Date(a.scanTimestamp) - new Date(b.scanTimestamp))
        .map(s => {
            var device = s.topology.find(d => d && String(d.DeviceIP) === deviceIp);
            if (!device) return null;
            var v = trendMetricValue(device, metric);
            return (v === null || isNaN(v)) ? null : { t: new Date(s.scanTimestamp), v: v };
        })
        .filter(Boolean);

    if (points.length === 0) { centeredMessage(`No "${TREND_METRIC_LABELS[metric]}" data points for this device.`); return; }

    var pad = { left: 55, right: 30, top: 30, bottom: 50 };
    var w = canvas.width - pad.left - pad.right;
    var h = canvas.height - pad.top - pad.bottom;

    var minT = points[0].t.getTime(), maxT = points[points.length - 1].t.getTime();
    var minV = Math.min(0, ...points.map(p => p.v));
    var maxV = Math.max(...points.map(p => p.v)) * 1.15 || 1;

    function x(t) { return pad.left + (maxT === minT ? w / 2 : (t - minT) / (maxT - minT) * w); }
    function y(v) { return pad.top + h - ((v - minV) / (maxV - minV || 1)) * h; }

    // Gridlines + Y-axis labels
    ctx.strokeStyle = '#eee';
    ctx.fillStyle = '#888';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    var ySteps = 5;
    for (var i = 0; i <= ySteps; i++) {
        var v = minV + (maxV - minV) * (i / ySteps);
        var yy = y(v);
        ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(pad.left + w, yy); ctx.stroke();
        ctx.fillText(Math.round(v), pad.left - 8, yy + 4);
    }

    // Axes
    ctx.strokeStyle = '#999';
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + h);
    ctx.lineTo(pad.left + w, pad.top + h);
    ctx.stroke();

    // X-axis labels (first, middle, last point - avoids overlap from labeling every point)
    ctx.fillStyle = '#888';
    ctx.textAlign = 'center';
    var xLabelPoints = points.length <= 2 ? points : [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]];
    xLabelPoints.forEach(p => {
        ctx.fillText(p.t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), x(p.t.getTime()), pad.top + h + 20);
    });

    // Reboot markers: a device's reported boot timestamp (Uptime) jumping to a new value
    // between two consecutive snapshots means it rebooted in between - "did this reboot
    // around when CPU spiked" is the useful question, so these draw on every metric's
    // chart, not a separate one. Independent pass over all snapshots (not the
    // metric-filtered `points` above), since a reboot is a fact about the device
    // regardless of whether this particular metric had a value at that snapshot.
    var deviceSnapshotsSorted = loadedSnapshots
        .filter(s => s.scanTimestamp)
        .slice()
        .sort((a, b) => new Date(a.scanTimestamp) - new Date(b.scanTimestamp))
        .map(s => ({ t: new Date(s.scanTimestamp), device: s.topology.find(d => d && String(d.DeviceIP) === deviceIp) }))
        .filter(entry => entry.device);

    ctx.strokeStyle = '#c0392b';
    ctx.setLineDash([4, 3]);
    ctx.fillStyle = '#c0392b';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    for (var di = 1; di < deviceSnapshotsSorted.length; di++) {
        var prevUptime = deviceSnapshotsSorted[di - 1].device.Uptime;
        var currUptime = deviceSnapshotsSorted[di].device.Uptime;
        var rebootTime = deviceSnapshotsSorted[di].t.getTime();
        if (!prevUptime || !currUptime || prevUptime === "Unknown" || currUptime === "Unknown" || prevUptime === currUptime) continue;
        if (rebootTime < minT || rebootTime > maxT) continue; // outside this metric's plotted range - skip rather than draw off-axis
        var rx = x(rebootTime);
        ctx.beginPath(); ctx.moveTo(rx, pad.top); ctx.lineTo(rx, pad.top + h); ctx.stroke();
        ctx.fillText('reboot', rx, pad.top - 6);
    }
    ctx.setLineDash([]);

    // Line
    ctx.strokeStyle = '#2B7CE9';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
        var px = x(p.t.getTime()), py = y(p.v);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // Points
    ctx.fillStyle = '#2B7CE9';
    points.forEach(p => {
        ctx.beginPath();
        ctx.arc(x(p.t.getTime()), y(p.v), 3.5, 0, Math.PI * 2);
        ctx.fill();
    });

    // Title
    ctx.fillStyle = '#2c3e50';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${TREND_METRIC_LABELS[metric]} — ${deviceIp}`, pad.left, 18);
};

// --- Local Account Audit (see #analysis-tab-accounts) ---
// Both regexes read the already-captured Configuration text - zero new SSH commands.
// Deliberately does NOT flag specific usernames as "suspicious" (e.g. treating "admin" as
// inherently bad) - that's a judgment call this tool can't make correctly across every
// org's naming convention, same reasoning as skipping a hand-maintained Junos EOL table
// elsewhere in this codebase. The one thing checked objectively is whether centralized
// RADIUS/TACACS+ auth is referenced at all - a binary fact, not a guess.
function extractLocalAccounts(configText) {
    var accounts = [];
    var re = /set system login user (\S+) class (\S+)/g;
    var m;
    while ((m = re.exec(configText)) !== null) accounts.push({ username: m[1], cls: m[2] });
    return accounts;
}

function hasCentralizedAuth(configText) {
    return /set system authentication-order[^\r\n]*\b(radius|tacplus)\b/i.test(configText);
}

window.renderLocalAccountsAudit = function() {
    var tbody = document.getElementById('accounts-tbody');
    var noAuthEl = document.getElementById('accounts-noauth-count');
    var totalEl = document.getElementById('accounts-total-count');
    if (!tbody) return;

    var devices = globalTopologyData || [];
    var rows = [];
    var noAuthCount = 0;

    devices.forEach(d => {
        if (!d.Configuration || d.Configuration === "Unknown") return;
        var centralized = hasCentralizedAuth(d.Configuration);
        if (!centralized) noAuthCount++;
        extractLocalAccounts(d.Configuration).forEach(a => rows.push({ device: d, username: a.username, cls: a.cls, centralized: centralized }));
    });

    if (noAuthEl) noAuthEl.textContent = noAuthCount;
    if (totalEl) totalEl.textContent = rows.length;

    tbody.innerHTML = rows.length ? rows.map(r => `<tr>
        <td>${esc(r.device.Hostname || r.device.DeviceIP)}</td>
        <td style="font-family:monospace;">${esc(r.username)}</td>
        <td>${esc(r.cls)}</td>
        <td>${r.centralized ? '<span class="badge green">Yes</span>' : '<span class="badge warn-badge">No</span>'}</td>
    </tr>`).join('') : `<tr><td colspan="4" style="text-align:center;">No local accounts found (no config backups loaded, or none define local users).</td></tr>`;
};

// --- Topology Diff (see #analysis-tab-topodiff) - a pure per-snapshot set difference,
// not a rendered graph. The layout engine only ever positions one connected tree from one
// root, so a device/link present in only the "From" snapshot has nowhere to be drawn -
// a list view answers "what changed" completely without that structural mismatch, and
// this never touches the live allNodeMeta/allEdges/graphRoot/primaryTree singletons the
// interactive graph uses, so it can't destabilize clustering/expand-collapse. ---
window.populateTopologyDiffSelects = function() {
    var fromSel = document.getElementById('topoDiffFromSelect');
    var toSel = document.getElementById('topoDiffToSelect');
    if (!fromSel || !toSel) return;

    var opts = loadedSnapshots.map((s, idx) => ({
        idx: idx,
        ts: s.scanTimestamp ? new Date(s.scanTimestamp).getTime() : idx,
        label: s.scanTimestamp ? new Date(s.scanTimestamp).toLocaleString() : s.sourceFile,
    })).sort((a, b) => a.ts - b.ts);

    var optionsHtml = opts.map(o => `<option value="${o.idx}">${esc(o.label)}</option>`).join('');
    var prevFrom = fromSel.value, prevTo = toSel.value;
    fromSel.innerHTML = optionsHtml;
    toSel.innerHTML = optionsHtml;
    if (opts.length === 0) return;

    fromSel.value = opts.some(o => String(o.idx) === prevFrom) ? prevFrom : String(opts[0].idx);
    toSel.value = opts.some(o => String(o.idx) === prevTo) ? prevTo : String(opts[opts.length - 1].idx);
};

// Edge identity matches window.buildSwitchMap's own convention exactly (sorted
// [deviceIp, neighborIp] pair) so "added/removed link" here means the same thing the
// interactive graph's edges mean - built independently per snapshot, not from the live
// allEdges global, since two snapshots need two independent sets to diff against each other.
function snapshotEdgeSet(snapshot) {
    var edges = new Map();
    (snapshot.topology || []).forEach(device => {
        if (!device || !device.DeviceIP) return;
        var switchIp = String(device.DeviceIP);
        window.asArray(device.Neighbors).forEach(n => {
            var neighborIp = String(n.ManagementIP);
            if (!neighborIp || neighborIp === "Unknown" || neighborIp === "0.0.0.0") return;
            var key = [switchIp, neighborIp].sort().join('-');
            if (!edges.has(key)) edges.set(key, { from: switchIp, to: neighborIp, localPort: n.LocalPort, remotePort: n.RemotePort });
        });
    });
    return edges;
}

window.renderTopologyDiff = function() {
    var container = document.getElementById('topodiff-content');
    var fromSel = document.getElementById('topoDiffFromSelect');
    var toSel = document.getElementById('topoDiffToSelect');
    if (!container || !fromSel) return;

    if (!fromSel.value || !toSel.value) {
        container.innerHTML = '<p class="fleet-list-empty">Load 2+ snapshots to compare topology over time.</p>';
        return;
    }

    var fromSnap = loadedSnapshots[parseInt(fromSel.value, 10)];
    var toSnap = loadedSnapshots[parseInt(toSel.value, 10)];
    if (!fromSnap || !toSnap) return;
    if (fromSnap === toSnap) {
        container.innerHTML = '<p class="fleet-list-empty">Pick two different snapshots to compare.</p>';
        return;
    }

    var fromByIp = new Map((fromSnap.topology || []).filter(d => d && d.DeviceIP).map(d => [String(d.DeviceIP), d]));
    var toByIp = new Map((toSnap.topology || []).filter(d => d && d.DeviceIP).map(d => [String(d.DeviceIP), d]));

    var devicesAdded = Array.from(toByIp.keys()).filter(ip => !fromByIp.has(ip));
    var devicesRemoved = Array.from(fromByIp.keys()).filter(ip => !toByIp.has(ip));

    var fromEdges = snapshotEdgeSet(fromSnap);
    var toEdges = snapshotEdgeSet(toSnap);
    var edgesAdded = Array.from(toEdges.keys()).filter(k => !fromEdges.has(k)).map(k => toEdges.get(k));
    var edgesRemoved = Array.from(fromEdges.keys()).filter(k => !toEdges.has(k)).map(k => fromEdges.get(k));

    function deviceLabel(ip, byIp) {
        var d = byIp.get(ip);
        return `${esc(d && d.Hostname ? d.Hostname : 'Unknown')} <span style="color:#999;">(${esc(ip)})</span>`;
    }
    function edgeLabel(e) {
        return `${esc(e.from)} <b>${esc(e.localPort || '?')}</b> ↔ <b>${esc(e.remotePort || '?')}</b> ${esc(e.to)}`;
    }
    function section(title, items, emptyText) {
        return `<div class="fleet-section"><h3>${esc(title)}</h3>` + (items.length === 0
            ? `<p class="fleet-list-empty">${esc(emptyText)}</p>`
            : items.map(html => `<div class="fleet-list-row"><span>${html}</span></div>`).join('')
        ) + '</div>';
    }

    var html = '<div class="fleet-dashboard-columns">'
        + '<div>' + section('Devices Added', devicesAdded.map(ip => deviceLabel(ip, toByIp)), 'None.') + '</div>'
        + '<div>' + section('Devices Removed', devicesRemoved.map(ip => deviceLabel(ip, fromByIp)), 'None.') + '</div>'
        + '</div><div class="fleet-dashboard-columns">'
        + '<div>' + section('Links Added', edgesAdded.map(edgeLabel), 'None.') + '</div>'
        + '<div>' + section('Links Removed', edgesRemoved.map(edgeLabel), 'None.') + '</div>'
        + '</div>';

    container.innerHTML = html;
};

// --- IP-Space / Subnet Utilization (see #analysis-tab-ipspace) ---
// Subnet boundaries are read opportunistically from captured config text (IRB/L3-gateway
// lines) - this only works if a device with that VLAN's L3 gateway was actually crawled.
// That's a property of which devices are in the crawl target list, not something a new SSH
// command can fix (the gap is "device not crawled", not "command not run") - see the
// caveat rendered directly in the tab. VLANs with no discovered boundary still show a raw
// live-IP count instead of a fabricated or omitted percentage.
function extractSubnetsFromConfigs(devices) {
    var irbToSubnet = new Map(); // irb unit -> {ip, prefix}
    var vlanToIrb = new Map();   // vlan name -> irb unit

    devices.forEach(d => {
        if (!d.Configuration || d.Configuration === "Unknown") return;
        var text = d.Configuration;
        var m;
        var irbRe = /set interfaces irb\.(\d+)[^\r\n]*family inet address (\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})/g;
        while ((m = irbRe.exec(text)) !== null) irbToSubnet.set(m[1], { ip: m[2], prefix: parseInt(m[3], 10) });
        var vlanRe = /set vlans (\S+) l3-interface irb\.(\d+)/g;
        while ((m = vlanRe.exec(text)) !== null) vlanToIrb.set(m[1], m[2]);
    });

    var vlanToSubnet = new Map();
    vlanToIrb.forEach((irbUnit, vlanName) => {
        var subnet = irbToSubnet.get(irbUnit);
        if (subnet) vlanToSubnet.set(vlanName, subnet);
    });
    return vlanToSubnet;
}

function ipToInt(ip) {
    var parts = String(ip).split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function networkBase(ipInt, prefix) {
    if (prefix <= 0) return 0;
    var mask = (0xFFFFFFFF << (32 - prefix)) >>> 0;
    return (ipInt & mask) >>> 0;
}

window.renderIpSpaceUtilization = function() {
    var tbody = document.getElementById('ipspace-tbody');
    if (!tbody) return;
    var devices = globalTopologyData || [];
    var vlanToSubnet = extractSubnetsFromConfigs(devices);

    var vlanIps = new Map(); // vlan name -> Set of distinct known (non-"Unknown") client IPs
    devices.forEach(d => (d.TrueClients || []).forEach(c => {
        if (!c.VLAN_Name || !c.IP || c.IP === "Unknown") return;
        if (!vlanIps.has(c.VLAN_Name)) vlanIps.set(c.VLAN_Name, new Set());
        vlanIps.get(c.VLAN_Name).add(c.IP);
    }));

    var vlanNames = new Set([...vlanToSubnet.keys(), ...vlanIps.keys()]);
    if (vlanNames.size === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No VLAN/client data available.</td></tr>`;
        return;
    }

    tbody.innerHTML = Array.from(vlanNames).sort().map(vlanName => {
        var ips = vlanIps.get(vlanName) || new Set();
        var subnet = vlanToSubnet.get(vlanName);

        if (!subnet) {
            return `<tr>
                <td>${esc(vlanName)}</td>
                <td style="color:#888; font-style:italic;">Boundary not found in captured config</td>
                <td>${ips.size} live IP${ips.size === 1 ? '' : 's'}</td>
                <td>-</td>
            </tr>`;
        }
        if (subnet.prefix >= 31) {
            return `<tr>
                <td>${esc(vlanName)}</td>
                <td style="font-family:monospace;">${esc(subnet.ip)}/${subnet.prefix}</td>
                <td>${ips.size} / N/A</td>
                <td>N/A (/${subnet.prefix})</td>
            </tr>`;
        }

        var base = networkBase(ipToInt(subnet.ip), subnet.prefix);
        var usable = Math.pow(2, 32 - subnet.prefix) - 2;
        // Only count client IPs that actually fall within the discovered subnet - a VLAN
        // name match alone doesn't guarantee every seen IP genuinely belongs to that CIDR.
        var inSubnet = Array.from(ips).filter(ip => { var n = ipToInt(ip); return n !== null && networkBase(n, subnet.prefix) === base; });
        var pct = usable > 0 ? Math.round((inSubnet.length / usable) * 100) : 0;
        var pctClass = pct >= 90 ? 'red' : (pct >= 75 ? 'warn-badge' : 'green');
        return `<tr>
            <td>${esc(vlanName)}</td>
            <td style="font-family:monospace;">${esc(subnet.ip)}/${subnet.prefix}</td>
            <td>${inSubnet.length} / ${usable}</td>
            <td><span class="badge ${pctClass}">${pct}%</span></td>
        </tr>`;
    }).join('');
};

window.populateReliabilityDeviceSelect = function() {
    var select = document.getElementById('reliabilityDeviceSelect');
    if (!select) return;
    var deviceMap = new Map();
    loadedSnapshots.slice()
        .sort((a, b) => new Date(a.scanTimestamp || 0) - new Date(b.scanTimestamp || 0))
        .forEach(s => s.topology.forEach(d => { if (d && d.DeviceIP) deviceMap.set(String(d.DeviceIP), d.Hostname || 'Unknown'); }));

    var ips = Array.from(deviceMap.keys()).sort((a, b) => window.GraphLayout.compareIpIds(a, b));
    var prevValue = select.value;
    select.innerHTML = ips.map(ip => `<option value="${esc(ip)}">${esc(ip)} (${esc(deviceMap.get(ip))})</option>`).join('');
    if (ips.includes(prevValue)) select.value = prevValue;
};

window.renderReliabilityHeatmap = function() {
    var container = document.getElementById('reliability-heatmap');
    var select = document.getElementById('reliabilityDeviceSelect');
    if (!container || !select) return;

    var history = window.updateAlarmHistory();
    var entry = select.value && history[select.value];
    var days = entry ? entry.days : {};
    var dates = Object.keys(days).sort();

    if (dates.length === 0) {
        container.innerHTML = '<p class="fleet-list-empty">No dated snapshots recorded yet for this device - load snapshots with a ScanTimestamp spanning multiple days to build history.</p>';
        return;
    }

    // `dates` are plain YYYY-MM-DD keys sliced from a UTC ISO ScanTimestamp (see
    // persistence.js's updateAlarmHistory) - every construction/comparison/arithmetic
    // below has to stay in UTC terms (the 'Z' suffix, and the getUTC*/setUTC* variants,
    // not their local-time counterparts) to keep `iso` matching those keys. Parsing as
    // local time and reading back via toISOString() (both UTC-based) used to roll the
    // date back by one for any positive UTC-offset timezone - e.g. browser at UTC+2,
    // "2026-08-20T00:00:00" parses as local midnight = 2026-08-19T22:00:00Z, so
    // toISOString() always produced the day BEFORE what was actually stored, and every
    // `days[iso]` lookup below missed - the heatmap rendered as empty for most timezones
    // east of UTC, every time, not just as an edge case.
    var minDate = new Date(dates[0] + 'T00:00:00Z');
    var maxDate = new Date(dates[dates.length - 1] + 'T00:00:00Z');
    // Start the grid on the Sunday on/before minDate so day-of-week rows line up.
    var gridStart = new Date(minDate);
    gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay());

    var cells = [];
    var cursor = new Date(gridStart);
    while (cursor <= maxDate) {
        var iso = cursor.toISOString().slice(0, 10);
        var dow = cursor.getUTCDay();
        var week = Math.floor((cursor - gridStart) / (7 * 86400000));
        var d = days[iso];
        var count = d ? d.alarmCount : 0;
        var lvl = count === 0 ? '' : (count === 1 ? 'lvl1' : (count <= 3 ? 'lvl2' : (count <= 6 ? 'lvl3' : 'lvl4')));
        var rebootedCls = d && d.rebooted ? 'rebooted' : '';
        var title = `${iso}: ${count} alarm${count === 1 ? '' : 's'}${d && d.rebooted ? ' - rebooted' : ''}`;
        cells.push(`<div class="heatmap-cell ${lvl} ${rebootedCls}" style="grid-row:${dow + 1}; grid-column:${week + 1};" title="${esc(title)}"></div>`);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    container.innerHTML = `<div class="heatmap-grid">${cells.join('')}</div>
        <div class="heatmap-legend">
            <span>Less</span>
            <div class="heatmap-cell"></div><div class="heatmap-cell lvl1"></div><div class="heatmap-cell lvl2"></div><div class="heatmap-cell lvl3"></div><div class="heatmap-cell lvl4"></div>
            <span>More alarms</span>
            <span style="margin-left:14px; display:inline-flex; align-items:center; gap:4px;"><span class="heatmap-cell rebooted"></span> rebooted that day</span>
        </div>`;
};

// Entry point for a dashboard stat card click (see the .fleet-stat-card.drillable onclick
// handlers above) - jumps to the Search tab and renders the full underlying list for that
// stat via search.js's results-list UI, instead of the small always-truncated inline lists
// the dashboard itself used to show.
window.drillDownStat = function(kind) {
    window.switchSidebarTab('sidebar-tab-search');
    document.getElementById('globalSearch').value = '';
    searchHighlightQuery = '';

    var devices = globalTopologyData || [];
    var rows = [];
    var headerText = '';

    if (kind === 'devices') {
        rows = devices.filter(d => d && d.DeviceIP).map(d => ({
            line1Html: `${esc(d.DeviceIP)}${d.Hostname ? ` (${esc(d.Hostname)})` : ''}`,
            onClick: () => window.goToSearchResult(String(d.DeviceIP), null, activeSnapshotIndex),
        }));
        headerText = `All ${rows.length} Devices`;
    } else if (kind === 'clients') {
        devices.forEach(d => (d.TrueClients || []).forEach(c => {
            rows.push({
                line1Html: `${esc(d.Hostname || d.DeviceIP)} <span style="color:#999; font-weight:normal;">/ ${esc(c.Port || '')}</span>`,
                line2Html: `Client: <b>${esc(c.IP || c.MAC || 'Unknown')}</b>${c.MAC ? ` (${esc(c.MAC)})` : ''}`,
                onClick: () => window.goToSearchResult(String(d.DeviceIP), 'tab-clients', activeSnapshotIndex),
            });
        }));
        headerText = `All ${rows.length} Clients`;
    } else if (kind === 'alarms') {
        devices.forEach(d => window.asArray(d.Alarms).forEach(a => {
            rows.push({
                line1Html: `${esc(d.Hostname || d.DeviceIP)}`,
                line2Html: `<span class="badge ${String(a.Class).toLowerCase() === 'major' ? 'red' : 'accent'}">${esc(a.Class)}</span> ${esc(a.Description)}`,
                onClick: () => window.goToSearchResult(String(d.DeviceIP), 'tab-alarms', activeSnapshotIndex),
            });
        }));
        headerText = `All ${rows.length} Active Alarms`;
    } else if (kind === 'dot1x') {
        devices.forEach(d => (d.TrueClients || []).forEach(c => {
            if (c.Dot1x_State && c.Dot1x_State !== "Unknown" && c.Dot1x_State !== "Authenticated") {
                rows.push({
                    line1Html: `${esc(d.Hostname || d.DeviceIP)} <span style="color:#999; font-weight:normal;">/ ${esc(c.Port || '')}</span>`,
                    line2Html: `<b style="color:#c0392b;">${esc(c.Dot1x_State)}</b>${c.MAC ? ` — ${esc(c.MAC)}` : ''}`,
                    onClick: () => window.goToSearchResult(String(d.DeviceIP), 'tab-clients', activeSnapshotIndex),
                });
            }
        }));
        headerText = `All ${rows.length} Dot1x Violations`;
    } else if (kind === 'daisychains') {
        devices.forEach(d => {
            window.detectDaisyChains(d).forEach((chain, port) => {
                rows.push({
                    line1Html: `${esc(d.Hostname || d.DeviceIP)} <span style="color:#999; font-weight:normal;">/ ${esc(port)}</span>`,
                    line2Html: chain.confidence === 'confirmed' ? 'Phone + PC (confirmed)' : `${chain.clients.length} devices (possible daisy-chain)`,
                    onClick: () => window.goToSearchResult(String(d.DeviceIP), 'tab-interfaces', activeSnapshotIndex),
                });
            });
        });
        headerText = `All ${rows.length} Daisy-Chained Ports`;
    } else if (kind === 'configchanged') {
        computeConfigChanges().forEach(c => {
            rows.push({
                line1Html: `${esc(c.hostname || c.deviceIp)} <span style="color:#999; font-weight:normal;">(${esc(c.deviceIp)})</span>`,
                line2Html: `Configuration changed since its previous capture`,
                onClick: () => {
                    window.goToSearchResult(c.deviceIp, 'tab-config', c.newIdx);
                    // Best-effort: pre-select the exact "previous capture" in the Config
                    // tab's compare picker once the drawer has finished opening. Falls
                    // back gracefully to the raw view if the picker isn't ready in time -
                    // nothing here is required for the drill-down itself to work.
                    setTimeout(() => {
                        var sel = document.getElementById('configCompareSelect');
                        if (sel && Array.from(sel.options).some(o => o.value === String(c.oldIdx))) {
                            sel.value = String(c.oldIdx);
                            window.renderConfigDiff();
                        }
                    }, 300);
                },
            });
        });
        headerText = `All ${rows.length} Devices with Config Changes`;
    } else if (kind === 'noauth') {
        devices.forEach(d => {
            if (!d.Configuration || d.Configuration === "Unknown" || hasCentralizedAuth(d.Configuration)) return;
            rows.push({
                line1Html: `${esc(d.Hostname || d.DeviceIP)}`,
                line2Html: `No RADIUS/TACACS+ referenced in authentication-order`,
                onClick: () => window.goToSearchResult(String(d.DeviceIP), 'tab-config', activeSnapshotIndex),
            });
        });
        headerText = `All ${rows.length} Devices Without Centralized Auth`;
    }

    window.renderResultsList(rows, { headerText: headerText, emptyText: 'None found.' });
};
