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

// Real (Myers/LCS) positional line diff for the Config tab's git-style side-by-side view -
// unlike configSetDiff above, this cares about WHICH lines are common, not just whether a
// line exists on both sides, so the side-by-side view can align unchanged lines next to each
// other and only shade the actual +/- rows, the way `git diff --color` reads. Standard
// dynamic-programming LCS: dp[i][j] = length of the longest common subsequence of
// oldLines[i:] and newLines[j:], then a single backtrack from (0,0) reconstructs the
// alignment. O(n*m) time and space - fine for real switch configs (typically a few hundred
// to a couple thousand "display set" lines), but the ROW_LIMIT guard below caps it before an
// unusually huge pair of configs (or two wildly different devices being compared) turns into
// a multi-hundred-MB table and locks up the tab.
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

// For every device with a real config backup in 2+ loaded snapshots, compares its two
// MOST RECENT captures (by scanTimestamp) and flags whether they differ at all - cheap
// string equality, not a full diff (the actual line-level diff is computed lazily, only
// when a user opens that device's Config tab). Spans every loaded snapshot regardless of
// which is active, same as window.updateDeviceHistory - "did this change since last time"
// is a cross-snapshot question, not a single-snapshot one.
function computeConfigChanges() {
    // Keyed by window.resolveDeviceIdentity, not DeviceIP - otherwise a device renumbered
    // between two captures never accumulates 2+ entries under the same key at all, so a real
    // config change on that device goes completely undetected (not just mis-attributed).
    var byDevice = new Map(); // identity -> [{idx, ts, config, hostname, ip}]
    loadedSnapshots.forEach((snap, idx) => {
        if (!snap.scanTimestamp) return;
        (snap.topology || []).forEach(d => {
            if (!d || !d.DeviceIP || !d.Configuration || d.Configuration === "Unknown") return;
            var identity = window.resolveDeviceIdentity(d);
            if (!byDevice.has(identity)) byDevice.set(identity, []);
            byDevice.get(identity).push({ idx: idx, ts: new Date(snap.scanTimestamp).getTime(), config: d.Configuration, hostname: d.Hostname, ip: String(d.DeviceIP) });
        });
    });

    var changed = [];
    byDevice.forEach((entries, identity) => {
        if (entries.length < 2) return;
        entries.sort((a, b) => b.ts - a.ts);
        if (entries[0].config !== entries[1].config) {
            // deviceIp is the NEWEST capture's IP - the current, drill-down-clickable
            // identity for opening this device's drawer right now, even though the older
            // capture being diffed against may have shown a different IP.
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
    // Keyed by window.resolveDeviceIdentity, same reasoning as populateReliabilityDeviceSelect
    // above - a device's CPU/memory/alarm/client trend line should stay one continuous
    // series across a renumbering, not fork into two partial series under two different IPs.
    var deviceMap = new Map(); // identity -> {hostname, ip}, from whichever loaded snapshot last saw it
    loadedSnapshots.slice()
        .sort((a, b) => new Date(a.scanTimestamp || 0) - new Date(b.scanTimestamp || 0))
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

// Plain <canvas> line chart - no vendored charting library, matching the rest of this
// codebase's "vendor only what's necessary, hand-roll everything else" pattern (see the
// topology graph's own radial layout).
window.renderTrendChart = function() {
    var canvas = document.getElementById('trendCanvas');
    var ctx = canvas.getContext('2d');
    var metric = document.getElementById('trendMetricSelect').value;
    // Despite the name, this is now an identity key (window.resolveDeviceIdentity), not a
    // literal IP - see populateTrendDeviceSelect's own comment. Kept as `deviceIp` below only
    // where it's genuinely still comparing against a real DeviceIP (the reboot-marker pass).
    var deviceIdentity = document.getElementById('trendDeviceSelect').value;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '13px sans-serif';

    function centeredMessage(msg) {
        ctx.fillStyle = '#888';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
    }

    if (!deviceIdentity) { centeredMessage('No devices available - load 2+ snapshots first.'); return; }

    var points = loadedSnapshots
        .filter(s => s.scanTimestamp)
        .slice()
        .sort((a, b) => new Date(a.scanTimestamp) - new Date(b.scanTimestamp))
        .map(s => {
            var device = s.topology.find(d => d && d.DeviceIP && window.resolveDeviceIdentity(d) === deviceIdentity);
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
        .map(s => ({ t: new Date(s.scanTimestamp), device: s.topology.find(d => d && d.DeviceIP && window.resolveDeviceIdentity(d) === deviceIdentity) }))
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

    // Title - the selected <option>'s own text ("10.0.0.1 (hostname)", from
    // populateTrendDeviceSelect), not deviceIdentity itself: that's an opaque
    // "serial:SYN..." /"hostname:..." string, meaningless to read on a chart title.
    var selectedOption = document.getElementById('trendDeviceSelect').selectedOptions[0];
    ctx.fillStyle = '#2c3e50';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${TREND_METRIC_LABELS[metric]} — ${selectedOption ? selectedOption.textContent : deviceIdentity}`, pad.left, 18);
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

// Groups the flat (device, username, class) audit rows by username+class - the same local
// account defined identically on every switch in the fleet is the common case, and a table
// with one row per device drowns that pattern under hundreds of duplicate-looking rows. The
// group key intentionally does NOT fold in `centralized` (that's a per-device fact, not part
// of the account's identity) - see the mixed-badge handling below for how a group whose
// member devices disagree on it is surfaced instead of silently picking one.
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
    // Kept as the (account, device) instance count, not distinct-account count - this is an
    // audit total ("how many local-login exposures exist across the fleet"), and collapsing
    // it to the grouped-row count would understate that by exactly the amount grouping saves
    // on screen.
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

// Edge identity matches window.buildSwitchMap's own convention (sorted [deviceIp,
// neighborIp] pair) for DISPLAY (e.from/e.to still show real, current IPs, same as the
// interactive graph), but the map KEY is built from window.resolveDeviceIdentity where
// possible - a link between two devices that are each still there, just renumbered since the
// other snapshot, must not read as "link removed" + "link added" on top of the (correctly
// suppressed) device churn. A neighbor that was never itself crawled has no device object to
// resolve an identity from in this snapshot - IP is genuinely the only identifier available
// for it, so it's kept as a plain IP key in that case, same tiered "best identity available"
// approach as window.ConfigResolve.
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

    // Keyed by window.resolveDeviceIdentity, not DeviceIP - a device that kept its serial/
    // hostname but changed IP between these two snapshots is neither "removed" nor "added",
    // it's the same device (see the IP Changed section below, which is exactly the
    // information a raw add+remove pair would have destroyed).
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
// Subnet boundaries are read opportunistically from captured config text (IRB/L3-gateway
// lines) - this only works if a device with that VLAN's L3 gateway was actually crawled.
// That's a property of which devices are in the crawl target list, not something a new SSH
// command can fix (the gap is "device not crawled", not "command not run") - see the
// caveat rendered directly in the tab. VLANs with no discovered boundary still show a raw
// live-IP count instead of a fabricated or omitted percentage.
function extractSubnetsFromConfigs(devices) {
    // Both regexes are joined PER DEVICE (irb unit numbers are only unique within one
    // device's own config, not fleet-wide) before merging into the final vlanName->subnet
    // map - joining through two flat, fleet-wide maps used to let an unrelated device that
    // happens to reuse the same irb unit NUMBER for a different purpose silently overwrite
    // an earlier device's real mapping, with no way to tell it happened.
    var vlanToSubnet = new Map();
    var conflicts = [];

    devices.forEach(d => {
        if (!d.Configuration || d.Configuration === "Unknown") return;
        var text = d.Configuration;
        var m;

        // "display set" always spells the logical unit out as "... unit N family inet
        // address ..." - never as the dotted "irb.N" shorthand that only appears when an
        // interface name is used as a REFERENCE (e.g. the l3-interface line below). Also
        // matches "vlan unit N ..." for the older EX2200/3200/4200-style RVI, which uses
        // "vlan" instead of "irb" as the routed-VLAN interface name. Keyed by "irb.N"/
        // "vlan.N" (matching l3-interface's own reference form) so both interface types
        // can coexist in one fleet without colliding on unit number alone.
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
                // A genuine conflict: two different devices report different subnets for
                // the same VLAN name (could be a real stretched-VLAN-different-subnet
                // multi-site design, or a config error) - keep whichever was found first
                // (deterministic, not "whichever device happened to be processed last")
                // and surface it instead of silently picking one.
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
    // Keyed by window.resolveDeviceIdentity (serial > hostname > IP, matching
    // window.updateAlarmHistory) rather than DeviceIP - a renumbered device stays one entry
    // in this dropdown instead of splitting into an old-IP ghost and a new-IP "device" with
    // no history. Label shows the latest-known hostname/IP for readability; sorted by that
    // latest IP too, since that's what an operator actually recognizes a device by on sight.
    var deviceMap = new Map(); // identity -> {hostname, ip}
    loadedSnapshots.slice()
        .sort((a, b) => new Date(a.scanTimestamp || 0) - new Date(b.scanTimestamp || 0))
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
