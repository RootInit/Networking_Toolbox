// Analysis Dashboard (#sidebar-tab-analysis): Fleet Health, New Devices, Trends, Local
// Accounts, Topology Diff, IP Space, Reliability - plus stat-card drill-down into a
// search.js results list. Depends on globals from app.js/persistence.js/utils.js/search.js.

// Re-renders every Analysis Dashboard view - called on tab activation and after a file
// load if that tab is already showing.
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

// Aggregates the ACTIVE snapshot only - merging snapshots from different times would
// double-count devices and mix states never simultaneously true.

// Plain set difference of "display set" config lines (order isn't stable between Junos
// commits, so this isn't a positional diff). Blank/whitespace-only differences are ignored.
function configSetDiff(oldText, newText) {
    var oldLines = new Set(String(oldText || '').split('\n').map(l => l.trim()).filter(Boolean));
    var newLines = new Set(String(newText || '').split('\n').map(l => l.trim()).filter(Boolean));
    return {
        removed: Array.from(oldLines).filter(l => !newLines.has(l)),
        added: Array.from(newLines).filter(l => !oldLines.has(l)),
    };
}

// Real (Myers/LCS) positional line diff for the Config tab's git-style side-by-side view,
// so unchanged lines align and only +/- rows are shaded (unlike configSetDiff above).
// Standard O(n*m) DP LCS with a backtrack; CONFIG_DIFF_CELL_LIMIT below caps it so an
// unusually large config pair falls back to the flat set diff instead of locking up the tab.
var CONFIG_DIFF_CELL_LIMIT = 4000000; // ~16MB of Int32Array at 4 bytes/cell
function computeLineDiff(oldText, newText) {
    var oldLines = String(oldText || '').split('\n');
    var newLines = String(newText || '').split('\n');
    var n = oldLines.length, m = newLines.length;

    if (n * m > CONFIG_DIFF_CELL_LIMIT) return null; // caller falls back to the flat set diff

    var dp = new Array(n + 1);
    for (var i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
    for (i = n - 1; i >= 0; i--) {
        for (var j = m - 1; j >= 0; j--) {
            dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    var rows = [];
    var ii = 0, jj = 0;
    while (ii < n && jj < m) {
        if (oldLines[ii] === newLines[jj]) {
            rows.push({ type: 'equal', oldNum: ii + 1, newNum: jj + 1, oldLine: oldLines[ii], newLine: newLines[jj] });
            ii++; jj++;
        } else if (dp[ii + 1][jj] >= dp[ii][jj + 1]) {
            rows.push({ type: 'removed', oldNum: ii + 1, newNum: null, oldLine: oldLines[ii], newLine: null });
            ii++;
        } else {
            rows.push({ type: 'added', oldNum: null, newNum: jj + 1, oldLine: null, newLine: newLines[jj] });
            jj++;
        }
    }
    while (ii < n) { rows.push({ type: 'removed', oldNum: ii + 1, newNum: null, oldLine: oldLines[ii], newLine: null }); ii++; }
    while (jj < m) { rows.push({ type: 'added', oldNum: null, newNum: jj + 1, oldLine: null, newLine: newLines[jj] }); jj++; }
    return rows;
}

// For every device with a config backup in 2+ loaded snapshots, compares its two most
// recent captures (by scanTimestamp) via cheap string equality - the real line-level diff
// is computed lazily when the user opens that device's Config tab. Spans all loaded
// snapshots regardless of which is active, same as window.updateDeviceHistory.
function computeConfigChanges() {
    // Keyed by window.resolveDeviceIdentity, not DeviceIP, so a device renumbered between
    // captures still accumulates entries under one key.
    var byDevice = new Map(); // identity -> [{idx, ts, config, hostname, ip}]
    loadedSnapshots.forEach((snap, idx) => {
        var ts = window.parseTimestampMs(snap.scanTimestamp);
        if (ts === null) return;
        (snap.topology || []).forEach(d => {
            if (!d || !d.DeviceIP || !d.Configuration || d.Configuration === "Unknown") return;
            var identity = window.resolveDeviceIdentity(d);
            if (!byDevice.has(identity)) byDevice.set(identity, []);
            byDevice.get(identity).push({ idx: idx, ts: ts, config: d.Configuration, hostname: d.Hostname, ip: String(d.DeviceIP) });
        });
    });

    var changed = [];
    byDevice.forEach((entries, identity) => {
        if (entries.length < 2) return;
        entries.sort((a, b) => b.ts - a.ts);
        if (entries[0].config !== entries[1].config) {
            // deviceIp is the newest capture's IP, for drill-down opening the drawer now.
            changed.push({ deviceIp: entries[0].ip, hostname: entries[0].hostname, newIdx: entries[0].idx, oldIdx: entries[1].idx });
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

    // Severity as a word, not just a color - mirrors drawer.js's STP/Link badges, which
    // always pair color with a real status word (e.g. "FWD"/"BLK") rather than relying on
    // color alone.
    function thresholdLabel(value, warn, critical) {
        return value >= critical ? 'critical' : (value >= warn ? 'warning' : 'ok');
    }

    // --- Recently rebooted (elapsed since boot, measured from this snapshot's capture
    // time, not wall-clock "now") ---
    var recentlyRebooted = [];
    // Distinguishes "checked and found nothing" from "couldn't check" (INV-UI-TRUTH: no
    // scanTimestamp means elapsed-since-boot can't be computed at all, which must not
    // render the same as a genuine zero-result).
    // A truthy scanTimestamp isn't enough - it must also parse (same check renderCrawlAge
    // in utils.js uses), or snapTime below is NaN and every elapsed-since-boot comparison
    // silently comes back false, which would otherwise render as a trustworthy "None."
    var rebootCheckPossible = !!(activeSnapshot && window.parseTimestampMs(activeSnapshot.scanTimestamp) !== null);
    // Tracks whether at least one device had a usable Uptime to compute from - distinguishes
    // "checked every device, zero had usable data" from a genuine zero-reboot result, one
    // level deeper than rebootCheckPossible (which only covers the snapshot-wide gate above).
    var anyUptimeUsable = false;
    if (rebootCheckPossible) {
        var snapTime = window.parseTimestampMs(activeSnapshot.scanTimestamp);
        devices.forEach(d => {
            if (!d.Uptime || d.Uptime === "Unknown") return;
            var bootTime = window.parseTimestampMs(d.Uptime);
            if (bootTime === null) return;
            anyUptimeUsable = true;
            var elapsedMin = (snapTime - bootTime) / 60000;
            if (elapsedMin >= 0 && elapsedMin < settings.recentRebootMin) {
                recentlyRebooted.push({ device: d, elapsedMin: elapsedMin });
            }
        });
    }

    // --- Dot1x compliance: a client whose port runs dot1x but isn't Authenticated.
    // "Unknown" means dot1x isn't observed at all (not necessarily a violation), so it's
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

    // --- Devices that didn't scan cleanly (ScanStatus/ScanError, set server-side; absent or
    // "Ok" means a normal successful scan) - tallied separately so they don't inflate/hide
    // inside the plain "Devices" count above. ---
    var unreachableDevices = devices.filter(d => d.ScanStatus && d.ScanStatus !== "Ok");

    // --- New devices detected in exactly this snapshot ---
    // window.updateDeviceHistory skips any snapshot whose scanTimestamp doesn't parse (never
    // writes a firstSeen from it), so a plain string-equality filter against an unparseable
    // activeSnapshot.scanTimestamp always comes back empty - that would silently render as a
    // trustworthy "0 new," indistinguishable from a genuine zero-result (same class of gap
    // rebootCheckPossible exists to close for the reboot card above). Show "N/A" instead.
    var history = window.updateDeviceHistory();
    var activeSnapTs = activeSnapshot ? window.parseTimestampMs(activeSnapshot.scanTimestamp) : null;
    var newInThisSnapshot = activeSnapTs !== null
        ? Object.values(history).filter(h => h.firstSeen === activeSnapshot.scanTimestamp).length
        : null;

    // --- Config changes since each device's previous capture (see computeConfigChanges) ---
    var configChanges = computeConfigChanges();

    // --- Render ---
    // Cards below drill down (window.drillDownStat) into a search-style device/client list;
    // "New This Snapshot" stays a plain count - it has no single natural list target.
    var html = `<div class="fleet-stats-grid">
        <div class="fleet-stat-card drillable" onclick="window.drillDownStat('devices')"><div class="stat-value">${devices.length}</div><div class="stat-label">Devices</div></div>
        <div class="fleet-stat-card drillable ${unreachableDevices.length > 0 ? 'critical' : ''}" onclick="window.drillDownStat('unreachable')"><div class="stat-value">${unreachableDevices.length}</div><div class="stat-label">Unreachable / Failed</div></div>
        <div class="fleet-stat-card drillable" onclick="window.drillDownStat('clients')"><div class="stat-value">${totalClients}</div><div class="stat-label">Clients</div></div>
        <div class="fleet-stat-card drillable ${totalAlarms > 0 ? 'critical' : ''}" onclick="window.drillDownStat('alarms')"><div class="stat-value">${totalAlarms}</div><div class="stat-label">Active Alarms</div></div>
        <div class="fleet-stat-card drillable ${dot1xViolations.length > 0 ? 'warn' : ''}" onclick="window.drillDownStat('dot1x')"><div class="stat-value">${dot1xViolations.length}</div><div class="stat-label">Dot1x Violations</div></div>
        <div class="fleet-stat-card drillable" onclick="window.drillDownStat('daisychains')"><div class="stat-value">${daisyChainCount}</div><div class="stat-label">Daisy-Chained Ports</div></div>
        <div class="fleet-stat-card drillable ${configChanges.length > 0 ? 'warn' : ''}" onclick="window.drillDownStat('configchanged')"><div class="stat-value">${configChanges.length}</div><div class="stat-label">Config Changed</div></div>
        <div class="fleet-stat-card"${newInThisSnapshot === null ? ' title="Unable to determine (no scan timestamp on this snapshot)"' : ''}><div class="stat-value">${newInThisSnapshot === null ? 'N/A' : newInThisSnapshot}</div><div class="stat-label">New This Snapshot</div></div>
    </div>`;

    html += '<div class="fleet-dashboard-columns">';

    html += '<div><div class="fleet-section"><h3>Highest RE CPU</h3>' + (worstCpu.length === 0
        ? '<p class="fleet-list-empty">No CPU data available.</p>'
        : worstCpu.map(x => `<div class="fleet-list-row"><span>${esc(x.device.Hostname || x.device.DeviceIP)}</span><span class="badge ${thresholdClass(x.value, settings.cpuWarnPct, settings.cpuCriticalPct)}" title="${thresholdLabel(x.value, settings.cpuWarnPct, settings.cpuCriticalPct)}">${x.value}% (${thresholdLabel(x.value, settings.cpuWarnPct, settings.cpuCriticalPct)})</span></div>`).join('')
    ) + '</div>';

    html += '<div class="fleet-section"><h3>Highest RE Memory</h3>' + (worstMem.length === 0
        ? '<p class="fleet-list-empty">No memory data available.</p>'
        : worstMem.map(x => `<div class="fleet-list-row"><span>${esc(x.device.Hostname || x.device.DeviceIP)}</span><span class="badge ${thresholdClass(x.value, settings.memWarnPct, settings.memCriticalPct)}" title="${thresholdLabel(x.value, settings.memWarnPct, settings.memCriticalPct)}">${x.value}% (${thresholdLabel(x.value, settings.memWarnPct, settings.memCriticalPct)})</span></div>`).join('')
    ) + '</div></div>';

    html += '<div><div class="fleet-section"><h3>Recently Rebooted (&lt; ' + settings.recentRebootMin + ' min)</h3>' + (!rebootCheckPossible
        ? '<p class="fleet-list-empty">Unable to determine (no scan timestamp on this snapshot).</p>'
        : (!anyUptimeUsable && devices.length > 0)
        ? '<p class="fleet-list-empty">Unable to determine (no devices reported usable uptime data).</p>'
        : recentlyRebooted.length === 0
        ? '<p class="fleet-list-empty">None.</p>'
        : recentlyRebooted.map(x => `<div class="fleet-list-row"><span>${esc(x.device.Hostname || x.device.DeviceIP)}</span><span class="badge accent">${Math.round(x.elapsedMin)} min ago</span></div>`).join('')
    ) + '</div></div></div>';

    html += '<div class="fleet-section"><h3>Client Vendor/Category Breakdown</h3>' +
        Object.keys(categoryCounts).sort((a, b) => categoryCounts[b] - categoryCounts[a]).map(cat =>
            `<div class="fleet-list-row"><span class="vendor-tag vendor-${cat.toLowerCase().replace('/', '-')}">${esc(cat)}</span><span>${categoryCounts[cat]}</span></div>`
        ).join('') + '</div>';

    container.innerHTML = html;
};

// Reverse-chronological by First Seen - newest detections at top, doubling as a "what's new" list.
window.renderNewDevicesTable = function() {
    var tbody = document.getElementById('new-devices-tbody');
    var history = window.updateDeviceHistory();

    // history entries are written from parseTimestampMs-validated data going forward (see
    // window.updateDeviceHistory), but an entry can still be a survivor from localStorage
    // written by an earlier build that didn't validate on write (DEVICE_HISTORY_STORAGE_KEY
    // was never version-bumped) - so firstSeen/lastSeen aren't guaranteed parseable here.
    // Sort those to the bottom (oldest-first-ish, rather than NaN silently no-op-sorting them
    // into an arbitrary spot) and show "unknown" instead of "Invalid Date".
    var rows = Object.keys(history).map(mac => Object.assign({ mac: mac }, history[mac]));
    rows.sort((a, b) => {
        var am = window.parseTimestampMs(a.firstSeen), bm = window.parseTimestampMs(b.firstSeen);
        if (am === null && bm === null) return 0;
        if (am === null) return 1;
        if (bm === null) return -1;
        return bm - am;
    });

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No client history yet.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(r => {
        var vendorInfo = window.lookupVendor(r.mac);
        var vendorStr = vendorInfo.vendor
            ? esc(vendorInfo.vendor) + (vendorInfo.category !== 'Other' ? ` (${esc(vendorInfo.category)})` : '')
            : '-';
        var firstSeenMs = window.parseTimestampMs(r.firstSeen);
        var lastSeenMs = window.parseTimestampMs(r.lastSeen);
        return `<tr>
            <td>${esc(firstSeenMs !== null ? new Date(firstSeenMs).toLocaleString() : 'unknown')}</td>
            <td style="font-family:monospace;">${esc(r.mac.toUpperCase())}</td>
            <td>${vendorStr}</td>
            <td>${esc(r.lastIp)}</td>
            <td>${esc(r.lastDeviceIp)} / ${esc(r.lastPort)}</td>
            <td>${esc(lastSeenMs !== null ? new Date(lastSeenMs).toLocaleString() : 'unknown')}</td>
        </tr>`;
    }).join('');
};

window.populateTrendDeviceSelect = function() {
    var select = document.getElementById('trendDeviceSelect');
    // Keyed by window.resolveDeviceIdentity so a trend line stays continuous across a
    // device renumbering instead of forking into two series.
    var deviceMap = new Map(); // identity -> {hostname, ip}, from whichever loaded snapshot last saw it
    loadedSnapshots.slice()
        .sort((a, b) => (window.parseTimestampMs(a.scanTimestamp) ?? 0) - (window.parseTimestampMs(b.scanTimestamp) ?? 0))
        .forEach(s => s.topology.forEach(d => {
            if (!d || !d.DeviceIP) return;
            deviceMap.set(window.resolveDeviceIdentity(d), { hostname: d.Hostname || 'Unknown', ip: String(d.DeviceIP) });
        }));

    var identities = Array.from(deviceMap.keys()).sort((a, b) => window.GraphLayout.compareIpIds(deviceMap.get(a).ip, deviceMap.get(b).ip));
    var prevValue = select.value;
    select.innerHTML = identities.map(id => `<option value="${esc(id)}">${esc(deviceMap.get(id).ip)} (${esc(deviceMap.get(id).hostname)})</option>`).join('');
    if (identities.includes(prevValue)) select.value = prevValue;
};

var TREND_METRIC_LABELS = { cpu: 'RE CPU %', mem: 'RE Memory %', alarms: 'Alarm Count', clients: 'Client Count' };

function trendMetricValue(device, metric) {
    if (metric === 'cpu') return parseFloat(device.MasterCpuUtilization);
    if (metric === 'mem') return parseFloat(device.MasterMemoryUtilization);
    if (metric === 'alarms') return window.asArray(device.Alarms).length;
    if (metric === 'clients') return (device.TrueClients || []).length;
    return NaN;
}

// Plain <canvas> line chart - no vendored charting library.
window.renderTrendChart = function() {
    var canvas = document.getElementById('trendCanvas');
    var ctx = canvas.getContext('2d');
    var metric = document.getElementById('trendMetricSelect').value;
    // Despite the name, this is a resolveDeviceIdentity key, not a literal IP.
    var deviceIdentity = document.getElementById('trendDeviceSelect').value;

    // Canvas 2D draws are invisible to CSS - reading the live custom properties (rather than
    // duplicating a light/dark palette here) keeps this chart in sync with the CSS theme
    // with one source of truth, and picks up a live toggle without a page reload.
    var rootStyle = getComputedStyle(document.documentElement);
    var cssVar = function(name) { return rootStyle.getPropertyValue(name).trim(); };
    var gridColor = cssVar('--border'), dimColor = cssVar('--text-dim'), mutedColor = cssVar('--text-muted');
    var headingColor = cssVar('--heading'), dangerColor = cssVar('--danger-text'), accentColor = cssVar('--accent');

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '13px sans-serif';

    function centeredMessage(msg) {
        ctx.fillStyle = dimColor;
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
    }

    if (!deviceIdentity) { centeredMessage('No devices available - load 2+ snapshots first.'); return; }

    var points = loadedSnapshots
        .map(s => ({ s: s, ts: window.parseTimestampMs(s.scanTimestamp) }))
        .filter(x => x.ts !== null)
        .sort((a, b) => a.ts - b.ts)
        .map(x => {
            var device = x.s.topology.find(d => d && d.DeviceIP && window.resolveDeviceIdentity(d) === deviceIdentity);
            if (!device) return null;
            var v = trendMetricValue(device, metric);
            return (v === null || isNaN(v)) ? null : { t: new Date(x.ts), v: v };
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
    ctx.strokeStyle = gridColor;
    ctx.fillStyle = dimColor;
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
    ctx.strokeStyle = mutedColor;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + h);
    ctx.lineTo(pad.left + w, pad.top + h);
    ctx.stroke();

    // X-axis labels (first, middle, last point - avoids overlap from labeling every point)
    ctx.fillStyle = dimColor;
    ctx.textAlign = 'center';
    var xLabelPoints = points.length <= 2 ? points : [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]];
    xLabelPoints.forEach(p => {
        ctx.fillText(p.t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), x(p.t.getTime()), pad.top + h + 20);
    });

    // Reboot markers: Uptime jumping to a new value between consecutive snapshots means a
    // reboot happened in between. Drawn on every metric's chart from an independent pass
    // over all snapshots (not the metric-filtered `points`), since a reboot is a fact about
    // the device regardless of whether this metric had a value then.
    var deviceSnapshotsSorted = loadedSnapshots
        .map(s => ({ s: s, ts: window.parseTimestampMs(s.scanTimestamp) }))
        .filter(x => x.ts !== null)
        .sort((a, b) => a.ts - b.ts)
        .map(x => ({ t: new Date(x.ts), device: x.s.topology.find(d => d && d.DeviceIP && window.resolveDeviceIdentity(d) === deviceIdentity) }))
        .filter(entry => entry.device);

    ctx.strokeStyle = dangerColor;
    ctx.setLineDash([4, 3]);
    ctx.fillStyle = dangerColor;
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
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
        var px = x(p.t.getTime()), py = y(p.v);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // Points
    ctx.fillStyle = accentColor;
    points.forEach(p => {
        ctx.beginPath();
        ctx.arc(x(p.t.getTime()), y(p.v), 3.5, 0, Math.PI * 2);
        ctx.fill();
    });

    // Title uses the selected <option>'s text, not deviceIdentity (an opaque "serial:..." key).
    var selectedOption = document.getElementById('trendDeviceSelect').selectedOptions[0];
    ctx.fillStyle = headingColor;
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${TREND_METRIC_LABELS[metric]} — ${selectedOption ? selectedOption.textContent : deviceIdentity}`, pad.left, 18);
};

// --- Local Account Audit (see #analysis-tab-accounts) ---
// Reads already-captured Configuration text only. Deliberately doesn't flag specific
// usernames as "suspicious" - that's not a judgment call this tool can make reliably.
// Only checked objectively: whether centralized RADIUS/TACACS+ auth is referenced at all.
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

// Groups the flat (device, username, class) rows by username+class, since the same local
// account is usually defined identically fleet-wide. `centralized` is per-device, not part
// of the group key - see the mixed-badge handling below for devices that disagree on it.
function groupLocalAccounts(rows) {
    var groups = new Map(); // "username class" -> {username, cls, entries: [{device, centralized}]}
    rows.forEach(r => {
        var key = r.username + ' ' + r.cls;
        if (!groups.has(key)) groups.set(key, { username: r.username, cls: r.cls, entries: [] });
        groups.get(key).entries.push({ device: r.device, centralized: r.centralized });
    });
    return Array.from(groups.values());
}

window.toggleAccountGroup = function(key) {
    var row = document.getElementById('acct-devices-' + key);
    if (!row) return;
    var collapsed = row.style.display === 'none';
    row.style.display = collapsed ? '' : 'none';
    var btn = document.getElementById('acct-toggle-' + key);
    if (btn) btn.textContent = collapsed ? 'Hide switches ▴' : 'Show switches ▾';
};

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
    // (account, device) instance count, not distinct-account count - the grouped-row count
    // would understate total fleet-wide exposure.
    if (totalEl) totalEl.textContent = rows.length;

    var groups = groupLocalAccounts(rows).sort((a, b) => a.username.localeCompare(b.username) || a.cls.localeCompare(b.cls));

    tbody.innerHTML = groups.length ? groups.map((g, i) => {
        var key = 'g' + i;
        var allCentralized = g.entries.every(e => e.centralized);
        var noneCentralized = g.entries.every(e => !e.centralized);
        var authBadge = allCentralized ? '<span class="badge green">Yes</span>'
            : noneCentralized ? '<span class="badge warn-badge">No</span>'
            : '<span class="badge warn-badge" title="Centralized auth is configured on some but not all of these switches">Mixed</span>';
        var deviceList = g.entries.map(e => `<div>${esc(e.device.Hostname || e.device.DeviceIP)} ${e.centralized ? '<span class="badge green" style="font-size:0.65rem;">centralized auth</span>' : '<span class="badge warn-badge" style="font-size:0.65rem;">no centralized auth</span>'}</div>`).join('');

        return `<tr>
            <td style="font-family:monospace;">${esc(g.username)}</td>
            <td>${esc(g.cls)}</td>
            <td>${authBadge}</td>
            <td>
                ${g.entries.length} switch${g.entries.length === 1 ? '' : 'es'}
                ${g.entries.length > 1 ? `<button type="button" id="acct-toggle-${key}" class="link-btn" onclick="window.toggleAccountGroup('${key}')" style="margin-left:8px;">Show switches ▾</button>` : ''}
                <div id="acct-devices-${key}" style="display:${g.entries.length > 1 ? 'none' : ''}; margin-top:4px; font-size:0.8rem; color:#666;">${deviceList}</div>
            </td>
        </tr>`;
    }).join('') : `<tr><td colspan="4" style="text-align:center;">No local accounts found (no config backups loaded, or none define local users).</td></tr>`;
};

// --- Topology Diff (see #analysis-tab-topodiff) - a pure per-snapshot set difference,
// rendered as a list rather than a graph (the layout engine only positions one connected
// tree, so a device/link present in only one snapshot has nowhere to be drawn). Doesn't
// touch the live graph's allNodeMeta/allEdges/graphRoot/primaryTree singletons. ---
window.populateTopologyDiffSelects = function() {
    var fromSel = document.getElementById('topoDiffFromSelect');
    var toSel = document.getElementById('topoDiffToSelect');
    if (!fromSel || !toSel) return;

    var opts = loadedSnapshots.map((s, idx) => {
        var tsMs = window.parseTimestampMs(s.scanTimestamp);
        return {
            idx: idx,
            ts: tsMs !== null ? tsMs : idx,
            label: tsMs !== null ? new Date(tsMs).toLocaleString() : s.sourceFile,
        };
    }).sort((a, b) => a.ts - b.ts);

    var optionsHtml = opts.map(o => `<option value="${o.idx}">${esc(o.label)}</option>`).join('');
    var prevFrom = fromSel.value, prevTo = toSel.value;
    fromSel.innerHTML = optionsHtml;
    toSel.innerHTML = optionsHtml;
    if (opts.length === 0) return;

    fromSel.value = opts.some(o => String(o.idx) === prevFrom) ? prevFrom : String(opts[0].idx);
    toSel.value = opts.some(o => String(o.idx) === prevTo) ? prevTo : String(opts[opts.length - 1].idx);
};

// Edge display (e.from/e.to) uses real IPs, but the map KEY uses window.resolveDeviceIdentity
// where possible, so a link between two devices that just got renumbered doesn't falsely
// read as "removed" + "added". A neighbor that was never crawled has no device object to
// resolve, so it falls back to a plain IP key.
function snapshotEdgeSet(snapshot) {
    var ipToIdentity = new Map();
    (snapshot.topology || []).forEach(d => { if (d && d.DeviceIP) ipToIdentity.set(String(d.DeviceIP), window.resolveDeviceIdentity(d)); });
    function keyFor(ip) { return ipToIdentity.get(ip) || ('ip:' + ip); }

    var edges = new Map();
    (snapshot.topology || []).forEach(device => {
        if (!device || !device.DeviceIP) return;
        var switchIp = String(device.DeviceIP);
        window.asArray(device.Neighbors).forEach(n => {
            var neighborIp = String(n.ManagementIP);
            if (!neighborIp || neighborIp === "Unknown" || neighborIp === "0.0.0.0") return;
            var key = [keyFor(switchIp), keyFor(neighborIp)].sort().join('-');
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

    // Keyed by window.resolveDeviceIdentity, not DeviceIP - a device that changed IP but
    // kept its serial/hostname is neither removed nor added; see the IP Changed section below.
    var fromByKey = new Map((fromSnap.topology || []).filter(d => d && d.DeviceIP).map(d => [window.resolveDeviceIdentity(d), d]));
    var toByKey = new Map((toSnap.topology || []).filter(d => d && d.DeviceIP).map(d => [window.resolveDeviceIdentity(d), d]));

    var devicesAdded = Array.from(toByKey.keys()).filter(key => !fromByKey.has(key));
    var devicesRemoved = Array.from(fromByKey.keys()).filter(key => !toByKey.has(key));
    var devicesReIpd = Array.from(toByKey.keys())
        .filter(key => fromByKey.has(key))
        .map(key => ({ key: key, from: fromByKey.get(key), to: toByKey.get(key) }))
        .filter(pair => String(pair.from.DeviceIP) !== String(pair.to.DeviceIP));

    var fromEdges = snapshotEdgeSet(fromSnap);
    var toEdges = snapshotEdgeSet(toSnap);
    var edgesAdded = Array.from(toEdges.keys()).filter(k => !fromEdges.has(k)).map(k => toEdges.get(k));
    var edgesRemoved = Array.from(fromEdges.keys()).filter(k => !toEdges.has(k)).map(k => fromEdges.get(k));

    function deviceLabel(key, byKey) {
        var d = byKey.get(key);
        return `${esc(d && d.Hostname ? d.Hostname : 'Unknown')} <span style="color:#999;">(${esc(d ? d.DeviceIP : '')})</span>`;
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
        + '<div>' + section('Devices Added', devicesAdded.map(key => deviceLabel(key, toByKey)), 'None.') + '</div>'
        + '<div>' + section('Devices Removed', devicesRemoved.map(key => deviceLabel(key, fromByKey)), 'None.') + '</div>'
        + '</div>'
        + section('IP Changed (same device)', devicesReIpd.map(pair =>
            `${esc(pair.to.Hostname && pair.to.Hostname !== 'Unknown' ? pair.to.Hostname : 'Unknown')} <span style="color:#999;">${esc(pair.from.DeviceIP)} &rarr; ${esc(pair.to.DeviceIP)}</span>`
          ), 'None.')
        + '<div class="fleet-dashboard-columns">'
        + '<div>' + section('Links Added', edgesAdded.map(edgeLabel), 'None.') + '</div>'
        + '<div>' + section('Links Removed', edgesRemoved.map(edgeLabel), 'None.') + '</div>'
        + '</div>';

    container.innerHTML = html;
};

// --- IP-Space / Subnet Utilization (see #analysis-tab-ipspace) ---
// Subnet boundaries are read opportunistically from captured config (IRB/L3-gateway lines);
// this only works if a device with that VLAN's L3 gateway was actually crawled. VLANs with
// no discovered boundary still show a raw live-IP count rather than a fabricated percentage.
function extractSubnetsFromConfigs(devices) {
    // irb unit numbers are only unique within one device's config, not fleet-wide - resolve
    // each device's own irb->subnet map before merging into vlanName->subnet.
    var vlanToSubnet = new Map();
    var conflicts = [];

    devices.forEach(d => {
        if (!d.Configuration || d.Configuration === "Unknown") return;
        var text = d.Configuration;
        var m;

        // Also matches "vlan unit N ..." for the older EX2200/3200/4200-style RVI (uses
        // "vlan" instead of "irb"). Keyed by "irb.N"/"vlan.N" to avoid unit-number collisions
        // between the two interface types.
        var irbToSubnet = new Map(); // "irb.N" or "vlan.N" -> {ip, prefix}, scoped to this device only
        var irbRe = /set interfaces (irb|vlan) unit (\d+)[^\r\n]*family inet address (\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})/g;
        while ((m = irbRe.exec(text)) !== null) irbToSubnet.set(m[1] + '.' + m[2], { ip: m[3], prefix: parseInt(m[4], 10) });

        var vlanRe = /set vlans (\S+) l3-interface ((?:irb|vlan)\.\d+)/g;
        while ((m = vlanRe.exec(text)) !== null) {
            var vlanName = m[1], irbUnit = m[2];
            var subnet = irbToSubnet.get(irbUnit);
            if (!subnet) continue;

            var existing = vlanToSubnet.get(vlanName);
            if (existing && (existing.ip !== subnet.ip || existing.prefix !== subnet.prefix)) {
                // Two devices report different subnets for the same VLAN name - keep
                // whichever was found first (deterministic) and surface the conflict.
                conflicts.push({ vlanName: vlanName, device: d.Hostname || d.DeviceIP, kept: existing, sawInstead: subnet });
                continue;
            }
            if (!existing) vlanToSubnet.set(vlanName, subnet);
        }
    });

    if (conflicts.length > 0) {
        console.warn('IP Space: conflicting subnet boundaries for the same VLAN name across devices - kept the first one found for each:', conflicts);
    }
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
        // Require actual CIDR membership, not just a VLAN name match.
        var inSubnet = Array.from(ips).filter(ip => { var n = ipToInt(ip); return n !== null && networkBase(n, subnet.prefix) === base; });
        var pct = usable > 0 ? Math.round((inSubnet.length / usable) * 100) : 0;
        var pctClass = pct >= 90 ? 'red' : (pct >= 75 ? 'warn-badge' : 'green');
        var pctLabel = pct >= 90 ? 'critical' : (pct >= 75 ? 'warning' : 'ok');
        return `<tr>
            <td>${esc(vlanName)}</td>
            <td style="font-family:monospace;">${esc(subnet.ip)}/${subnet.prefix}</td>
            <td>${inSubnet.length} / ${usable}</td>
            <td><span class="badge ${pctClass}" title="${pctLabel}">${pct}% (${pctLabel})</span></td>
        </tr>`;
    }).join('');
};

window.populateReliabilityDeviceSelect = function() {
    var select = document.getElementById('reliabilityDeviceSelect');
    if (!select) return;
    // Keyed by window.resolveDeviceIdentity (matching window.updateAlarmHistory), so a
    // renumbered device stays one dropdown entry instead of splitting its history.
    var deviceMap = new Map(); // identity -> {hostname, ip}
    loadedSnapshots.slice()
        .sort((a, b) => (window.parseTimestampMs(a.scanTimestamp) ?? 0) - (window.parseTimestampMs(b.scanTimestamp) ?? 0))
        .forEach(s => s.topology.forEach(d => {
            if (!d || !d.DeviceIP) return;
            deviceMap.set(window.resolveDeviceIdentity(d), { hostname: d.Hostname || 'Unknown', ip: String(d.DeviceIP) });
        }));

    var identities = Array.from(deviceMap.keys()).sort((a, b) => window.GraphLayout.compareIpIds(deviceMap.get(a).ip, deviceMap.get(b).ip));
    var prevValue = select.value;
    select.innerHTML = identities.map(id => `<option value="${esc(id)}">${esc(deviceMap.get(id).ip)} (${esc(deviceMap.get(id).hostname)})</option>`).join('');
    if (identities.includes(prevValue)) select.value = prevValue;
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

    // `dates` are plain YYYY-MM-DD keys sliced from a UTC ISO ScanTimestamp. Everything below
    // must stay in UTC terms (the 'Z' suffix, getUTC*/setUTC*) to keep `iso` matching those
    // keys - parsing as local time shifts the date for any positive UTC-offset timezone and
    // silently breaks every `days[iso]` lookup.
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

// Entry point for a dashboard stat card click - jumps to the Search tab and renders the
// full underlying list for that stat via search.js's results-list UI.
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
    } else if (kind === 'unreachable') {
        devices.filter(d => d.ScanStatus && d.ScanStatus !== "Ok").forEach(d => {
            rows.push({
                line1Html: `${esc(d.Hostname || d.DeviceIP)} <span style="color:#999; font-weight:normal;">(${esc(d.DeviceIP)})</span>`,
                line2Html: `<b style="color:#c0392b;">${esc(d.ScanStatus)}</b>${d.ScanError ? ` — ${esc(d.ScanError)}` : ''}`,
                onClick: () => window.goToSearchResult(String(d.DeviceIP), null, activeSnapshotIndex),
            });
        });
        headerText = `All ${rows.length} Unreachable / Failed Devices`;
    } else if (kind === 'clients') {
        devices.forEach(d => (d.TrueClients || []).forEach(c => {
            rows.push({
                line1Html: `${esc(d.Hostname || d.DeviceIP)} <span style="color:#999; font-weight:normal;">/ ${esc(c.Port || '')}</span>`,
                line2Html: `Client: <b>${esc(c.IP || c.MAC || 'Unknown')}</b>${c.MAC ? ` (${esc(c.MAC)})` : ''}`,
                onClick: () => window.goToSearchResult(String(d.DeviceIP), 'tab-interfaces', activeSnapshotIndex),
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
                    onClick: () => window.goToSearchResult(String(d.DeviceIP), 'tab-interfaces', activeSnapshotIndex),
                });
            }
        }));
        headerText = `All ${rows.length} Dot1x Violations`;
    } else if (kind === 'daisychains') {
        devices.forEach(d => {
            window.detectDaisyChains(d).forEach((chain, port) => {
                rows.push({
                    line1Html: `${esc(d.Hostname || d.DeviceIP)} <span style="color:#999; font-weight:normal;">/ ${esc(port)}</span>`,
                    line2Html: chain.confidence === 'confirmed' ? 'Phone + PC (confirmed)' : `${chain.clients.length} devices (${chain.confidence} daisy-chain)`,
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
                    // Best-effort: pre-select the "previous capture" in the compare picker
                    // once the drawer opens; falls back to raw view if not ready in time.
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
