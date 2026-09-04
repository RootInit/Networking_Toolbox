// Analysis Dashboard (#analysisview, the third centre view beside Diagram/Map - see map.js's
// switchCenterView): Fleet Health, New Devices, Trends, Local
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


// --- Shared inline graphics for the dashboard (plain SVG/HTML strings, no library) ---

// Severity tier for a value against warn/critical thresholds - one vocabulary for every
// bar, band and badge on the dashboard: 'ok' | 'warn' | 'crit'.
function severityTier(value, warn, critical) {
    return value >= critical ? 'crit' : (value >= warn ? 'warn' : 'ok');
}
var SEVERITY_WORD = { ok: 'ok', warn: 'warning', crit: 'critical' };

// Horizontal bar with the value printed beside it. `pct` is the fill (0-100); `label` is the
// text shown; `tier` picks the fill colour. Used by the Fleet Health top-N lists and the
// IP Space table so "how full" reads at a glance instead of from a number.
function inlineBar(pct, label, tier, title) {
    var clamped = Math.max(0, Math.min(100, pct || 0));
    return `<span class="inline-bar" title="${esc(title || label)}"><span class="inline-bar-track"><span class="inline-bar-fill tier-${tier}" style="width:${clamped}%"></span></span><span class="inline-bar-label tier-${tier}">${esc(label)}</span></span>`;
}

// Tiny line chart of a fleet metric across the loaded snapshots (oldest left). Draws
// nothing for fewer than two points - a one-point sparkline would just be a dot. The last
// point is emphasised so the eye lands on "now"; warn/crit bands are shaded if given.
function sparklineSvg(values, opts) {
    opts = opts || {};
    var pts = values.filter(v => typeof v === 'number' && isFinite(v));
    if (pts.length < 2) return '';
    var w = opts.w || 110, h = opts.h || 26, pad = 2;
    var min = Math.min(0, ...pts), max = Math.max(...pts, opts.crit || 0);
    if (max === min) max = min + 1;
    var x = i => pad + (i / (pts.length - 1)) * (w - 2 * pad);
    var y = v => pad + (1 - (v - min) / (max - min)) * (h - 2 * pad);
    var d = pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    var area = d + ` L${x(pts.length - 1).toFixed(1)},${(h - pad).toFixed(1)} L${x(0).toFixed(1)},${(h - pad).toFixed(1)} Z`;
    var bands = '';
    if (opts.warn != null) bands += `<rect class="spark-band warn" x="0" y="${y(Math.min(max, opts.crit != null ? opts.crit : max)).toFixed(1)}" width="${w}" height="${Math.max(0, y(opts.warn) - y(Math.min(max, opts.crit != null ? opts.crit : max))).toFixed(1)}"></rect>`;
    if (opts.crit != null && opts.crit <= max) bands += `<rect class="spark-band crit" x="0" y="${pad}" width="${w}" height="${Math.max(0, y(opts.crit) - pad).toFixed(1)}"></rect>`;
    var last = pts[pts.length - 1];
    return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${bands}<path class="spark-area" d="${area}"></path><path class="spark-line" d="${d}"></path><circle class="spark-end" cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.2"></circle></svg>`;
}

// Loaded snapshots with a parseable timestamp, oldest first - the x-axis every trend shares.
function datedSnapshotsAsc() {
    return loadedSnapshots
        .map(s => ({ s: s, ts: window.parseTimestampMs(s.scanTimestamp) }))
        .filter(x => x.ts !== null)
        .sort((a, b) => a.ts - b.ts);
}

// Fleet-wide counts per snapshot for the Fleet Health cards' sparklines. Memoised per
// snapshot object - detectDaisyChains over every device isn't free and the dashboard
// re-renders on every activation.
var fleetTotalsCache = new WeakMap();
// Called wherever a snapshot's topology is mutated in place (see drawer.js's
// mergeRescannedDevice) so a stale cached total can never be drawn next to a stat that
// WAS recomputed live from the same mutated data.
window.invalidateFleetTotalsCache = function(snapshot) { fleetTotalsCache.delete(snapshot); };
function fleetTotalsFor(snapshot) {
    if (fleetTotalsCache.has(snapshot)) return fleetTotalsCache.get(snapshot);
    var t = { devices: 0, unreachable: 0, clients: 0, alarms: 0, dot1x: 0, daisy: 0 };
    (snapshot.topology || []).forEach(d => {
        if (!d) return;
        t.devices++;
        if (d.ScanStatus && d.ScanStatus !== "Ok") t.unreachable++;
        var clients = d.TrueClients || [];
        t.clients += clients.length;
        t.alarms += window.asArray(d.Alarms).length;
        clients.forEach(c => { if (c.Dot1x_State && c.Dot1x_State !== "Unknown" && c.Dot1x_State !== "Authenticated") t.dot1x++; });
        t.daisy += window.detectDaisyChains(d).size;
    });
    fleetTotalsCache.set(snapshot, t);
    return t;
}

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
    // "New This Snapshot" stays a plain count - it has no single natural list target. Each
    // card carries a sparkline of its metric across the loaded snapshots (nothing drawn with
    // a single snapshot), so a count reads as rising or falling rather than as a bare number.
    var series = datedSnapshotsAsc().map(x => fleetTotalsFor(x.s));
    var spark = key => sparklineSvg(series.map(t => t[key]));
    function card(opts) {
        var cls = 'fleet-stat-card' + (opts.onclick ? ' drillable' : '') + (opts.tier ? ' ' + opts.tier : '');
        var attrs = (opts.onclick ? ` onclick="${opts.onclick}"` : '') + (opts.title ? ` title="${esc(opts.title)}"` : '');
        return `<div class="${cls}"${attrs}><div class="stat-value">${opts.value}</div><div class="stat-label">${opts.label}</div>${opts.spark || ''}</div>`;
    }
    var html = `<div class="fleet-stats-grid">
        ${card({ value: devices.length, label: 'Devices', onclick: "window.drillDownStat('devices')", spark: spark('devices') })}
        ${card({ value: unreachableDevices.length, label: 'Unreachable / Failed', tier: unreachableDevices.length > 0 ? 'critical' : '', onclick: "window.drillDownStat('unreachable')", spark: spark('unreachable') })}
        ${card({ value: totalClients, label: 'Clients', onclick: "window.drillDownStat('clients')", spark: spark('clients') })}
        ${card({ value: totalAlarms, label: 'Active Alarms', tier: totalAlarms > 0 ? 'critical' : '', onclick: "window.drillDownStat('alarms')", spark: spark('alarms') })}
        ${card({ value: dot1xViolations.length, label: 'Dot1x Violations', tier: dot1xViolations.length > 0 ? 'warn' : '', onclick: "window.drillDownStat('dot1x')", spark: spark('dot1x') })}
        ${card({ value: daisyChainCount, label: 'Daisy-Chained Ports', onclick: "window.drillDownStat('daisychains')", spark: spark('daisy') })}
        ${card({ value: configChanges.length, label: 'Config Changed', tier: configChanges.length > 0 ? 'warn' : '', onclick: "window.drillDownStat('configchanged')" })}
        ${card({ value: newInThisSnapshot === null ? 'N/A' : newInThisSnapshot, label: 'New This Snapshot', title: newInThisSnapshot === null ? 'Unable to determine (no scan timestamp on this snapshot)' : '' })}
    </div>`;
    if (series.length < 2) html += '<p class="fleet-hint">Load a folder of snapshots to see how these counts move over time.</p>';

    // Top-N lists as bars: the bar is the value against 100%, coloured by the same
    // warn/critical thresholds the Settings tab exposes, with the word beside it.
    function barList(rows, warn, critical, unit) {
        return rows.map(x => {
            var tier = severityTier(x.value, warn, critical);
            var name = x.device.Hostname || x.device.DeviceIP;
            var tip = x.device.Hostname ? `${x.device.Hostname} (${x.device.DeviceIP})` : x.device.DeviceIP;
            return `<div class="fleet-bar-row"><span class="fleet-bar-name" title="${esc(tip)}">${esc(name)}</span>${inlineBar(x.value, `${x.value}${unit} ${SEVERITY_WORD[tier]}`, tier)}</div>`;
        }).join('');
    }

    html += '<div class="fleet-dashboard-columns">';
    html += '<div class="fleet-section"><h3>Highest RE CPU</h3>' + (worstCpu.length === 0
        ? '<p class="fleet-list-empty">No CPU data available.</p>'
        : barList(worstCpu, settings.cpuWarnPct, settings.cpuCriticalPct, '%')) + '</div>';
    html += '<div class="fleet-section"><h3>Highest RE Memory</h3>' + (worstMem.length === 0
        ? '<p class="fleet-list-empty">No memory data available.</p>'
        : barList(worstMem, settings.memWarnPct, settings.memCriticalPct, '%')) + '</div>';
    html += '<div class="fleet-section"><h3>Recently Rebooted (&lt; ' + settings.recentRebootMin + ' min)</h3>' + (!rebootCheckPossible
        ? '<p class="fleet-list-empty">Unable to determine (no scan timestamp on this snapshot).</p>'
        : (!anyUptimeUsable && devices.length > 0)
        ? '<p class="fleet-list-empty">Unable to determine (no devices reported usable uptime data).</p>'
        : recentlyRebooted.length === 0
        ? '<p class="fleet-list-empty">None.</p>'
        : recentlyRebooted.sort((a, b) => a.elapsedMin - b.elapsedMin).map(x => {
            var name = x.device.Hostname || x.device.DeviceIP;
            var tip = x.device.Hostname ? `${x.device.Hostname} (${x.device.DeviceIP})` : x.device.DeviceIP;
            return `<div class="fleet-bar-row"><span class="fleet-bar-name" title="${esc(tip)}">${esc(name)}</span>${inlineBar(100 - (x.elapsedMin / settings.recentRebootMin) * 100, `${Math.round(x.elapsedMin)} min ago`, 'warn', 'Booted ' + Math.round(x.elapsedMin) + ' minutes before this scan')}</div>`;
        }).join('')
    ) + '</div>';
    html += '</div>';

    // Vendor/category breakdown as one proportional bar - share of clients per category is
    // the question, and a stacked bar answers it without reading three numbers.
    var cats = Object.keys(categoryCounts).sort((a, b) => categoryCounts[b] - categoryCounts[a]);
    var vendorCls = cat => 'vendor-' + cat.toLowerCase().replace('/', '-');
    html += '<div class="fleet-section"><h3>Client Vendor/Category Breakdown</h3>' + (totalClients === 0
        ? '<p class="fleet-list-empty">No clients.</p>'
        : `<div class="fleet-stack">${cats.map(cat => `<span class="fleet-stack-seg vendor-tag ${vendorCls(cat)}" style="width:${(categoryCounts[cat] / totalClients * 100).toFixed(2)}%" title="${esc(cat)}: ${categoryCounts[cat]} (${Math.round(categoryCounts[cat] / totalClients * 100)}%)"></span>`).join('')}</div>
           <div class="fleet-stack-legend">${cats.map(cat => `<span><span class="vendor-tag ${vendorCls(cat)}">${esc(cat)}</span> ${categoryCounts[cat]} <span class="fleet-pct">${Math.round(categoryCounts[cat] / totalClients * 100)}%</span></span>`).join('')}</div>`) + '</div>';

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

// Threshold bands for the per-device metrics, from the same Settings the Fleet Health
// lists use; counts (alarms/clients) have no fixed bands.
function trendThresholds(metric, settings) {
    if (metric === 'cpu') return { warn: settings.cpuWarnPct, crit: settings.cpuCriticalPct };
    if (metric === 'mem') return { warn: settings.memWarnPct, crit: settings.memCriticalPct };
    return null;
}

// Per-device series for one metric across the dated snapshots: Map identity -> {label,
// points:[{t, v}|null per snapshot], last, peak, rebootsAt:[t]}. Identity (not IP) so a
// renumbered device stays one line. A snapshot the device is missing from is a gap.
function trendSeries(metric) {
    var snaps = datedSnapshotsAsc();
    var byId = new Map();
    snaps.forEach((x, i) => {
        (x.s.topology || []).forEach(d => {
            if (!d || !d.DeviceIP) return;
            var id = window.resolveDeviceIdentity(d);
            var e = byId.get(id);
            if (!e) { e = { id: id, label: '', points: new Array(snaps.length).fill(null), uptimes: new Array(snaps.length).fill(null) }; byId.set(id, e); }
            e.label = `${d.DeviceIP} (${d.Hostname || 'Unknown'})`;
            var v = trendMetricValue(d, metric);
            e.points[i] = (v === null || isNaN(v)) ? null : { t: x.ts, v: v };
            e.uptimes[i] = (d.Uptime && d.Uptime !== "Unknown") ? d.Uptime : null;
        });
    });
    byId.forEach(e => {
        var vals = e.points.filter(Boolean).map(p => p.v);
        e.last = vals.length ? vals[vals.length - 1] : NaN;
        e.peak = vals.length ? Math.max(...vals) : NaN;
        e.count = vals.length;
        // A different Uptime string between consecutive sightings means it rebooted in between.
        e.rebootsAt = [];
        var prev = null;
        e.uptimes.forEach((u, i) => { if (u && prev && u !== prev) e.rebootsAt.push(snaps[i].ts); if (u) prev = u; });
    });
    return { snaps: snaps, byId: byId };
}

// One SVG line chart. `series` is [{points, cls}], all sharing the snapshot x-axis; the
// first is the subject (drawn heavy), the rest context (fleet median, dashed). Threshold
// bands are shaded behind the lines; reboot markers are dashed verticals. Everything takes
// its colour from CSS classes so it follows the theme like the rest of the page.
function trendChartSvg(series, opts) {
    var w = opts.w, h = opts.h, big = !!opts.big;
    var pad = big ? { l: 46, r: 16, t: 26, b: 34 } : { l: 30, r: 8, t: 8, b: 18 };
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var all = [];
    series.forEach(s => s.points.forEach(p => { if (p) all.push(p); }));
    if (!all.length) return '';
    var minT = opts.minT, maxT = opts.maxT;
    var maxV = Math.max(...all.map(p => p.v), opts.thresholds ? opts.thresholds.crit : 0, opts.maxV || 0) * 1.1 || 1;
    var x = t => pad.l + (maxT === minT ? iw / 2 : (t - minT) / (maxT - minT) * iw);
    var y = v => pad.t + ih - (v / maxV) * ih;
    var out = `<svg class="trend-svg${big ? ' big' : ''}" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">`;
    if (opts.thresholds) {
        var th = opts.thresholds;
        if (th.crit <= maxV) out += `<rect class="trend-band crit" x="${pad.l}" y="${y(maxV)}" width="${iw}" height="${(y(th.crit) - y(maxV)).toFixed(1)}"></rect>`;
        if (th.warn <= maxV) out += `<rect class="trend-band warn" x="${pad.l}" y="${y(Math.min(th.crit, maxV))}" width="${iw}" height="${(y(th.warn) - y(Math.min(th.crit, maxV))).toFixed(1)}"></rect>`;
    }
    var steps = big ? 5 : 2;
    for (var i = 0; i <= steps; i++) {
        var v = maxV * i / steps, yy = y(v).toFixed(1);
        out += `<line class="trend-grid" x1="${pad.l}" y1="${yy}" x2="${pad.l + iw}" y2="${yy}"></line><text class="trend-tick" x="${pad.l - 6}" y="${(+yy + 3.5).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`;
    }
    (opts.rebootsAt || []).forEach(t => { if (t >= minT && t <= maxT) out += `<line class="trend-reboot" x1="${x(t).toFixed(1)}" y1="${pad.t}" x2="${x(t).toFixed(1)}" y2="${pad.t + ih}"></line>${big ? `<text class="trend-reboot-label" x="${x(t).toFixed(1)}" y="${pad.t - 8}" text-anchor="middle">reboot</text>` : ''}`; });
    series.slice().reverse().forEach(s => {
        var d = '', pen = false;
        s.points.forEach(p => { if (!p) { pen = false; return; } d += (pen ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p.v).toFixed(1) + ' '; pen = true; });
        out += `<path class="trend-line ${s.cls}" d="${d.trim()}"></path>`;
        if (s.cls === 'subject') s.points.forEach(p => { if (p) out += `<circle class="trend-dot" cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${big ? 3.5 : 2}"></circle>`; });
    });
    if (opts.xLabels) {
        var labelTs = opts.snaps.length <= 3 ? opts.snaps : [opts.snaps[0], opts.snaps[Math.floor(opts.snaps.length / 2)], opts.snaps[opts.snaps.length - 1]];
        // First/last labels anchor inward so neither runs off the drawing.
        labelTs.forEach((ts, i) => {
            var anchor = i === 0 ? 'start' : (i === labelTs.length - 1 ? 'end' : 'middle');
            out += `<text class="trend-tick" x="${x(ts).toFixed(1)}" y="${h - 10}" text-anchor="${anchor}">${new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</text>`;
        });
    }
    return out + '</svg>';
}

// Trends tab. Two modes (see #trendModeSelect): "top" draws small multiples - one panel per
// device with the highest peak of the chosen metric, each against the dashed fleet median -
// so the eight devices worth looking at are on screen together; "single" draws one large
// chart for the picked device with reboot markers. With one dated snapshot there is no trend
// to draw, so the current values are ranked as bars instead of an empty axis.
window.renderTrendChart = function() {
    var container = document.getElementById('trendChart');
    if (!container) return;
    var metric = document.getElementById('trendMetricSelect').value;
    var mode = document.getElementById('trendModeSelect').value;
    var deviceSel = document.getElementById('trendDeviceSelect');
    deviceSel.style.display = mode === 'single' ? '' : 'none';
    var deviceLabelEl = deviceSel.closest('label'); if (deviceLabelEl) deviceLabelEl.style.display = mode === 'single' ? '' : 'none';
    var settings = window.loadSettings();
    var th = trendThresholds(metric, settings);
    var unit = (metric === 'cpu' || metric === 'mem') ? '%' : '';
    var data = trendSeries(metric);
    var entries = Array.from(data.byId.values()).filter(e => e.count > 0);

    if (data.snaps.length === 0 || entries.length === 0) {
        container.innerHTML = '<p class="fleet-list-empty">No dated snapshots loaded.</p>';
        return;
    }
    if (data.snaps.length < 2) {
        var ranked = entries.slice().sort((a, b) => b.last - a.last).slice(0, 12);
        var maxLast = Math.max(...ranked.map(e => e.last), th ? th.crit : 0, 1);
        container.innerHTML = `<p class="fleet-hint">One dated snapshot is loaded, so there is no trend to draw yet - load a folder of snapshots to see ${TREND_METRIC_LABELS[metric]} over time. Current values, highest first:</p>
            <div class="trend-rank">${ranked.map(e => {
                var tier = th ? severityTier(e.last, th.warn, th.crit) : 'neutral';
                return `<div class="fleet-bar-row"><span class="fleet-bar-name" title="${esc(e.label)}">${esc(e.label)}</span>${inlineBar(e.last / maxLast * 100, `${e.last}${unit}${th ? ' ' + SEVERITY_WORD[tier] : ''}`, tier)}</div>`;
            }).join('')}</div>`;
        return;
    }

    var minT = data.snaps[0].ts, maxT = data.snaps[data.snaps.length - 1].ts;
    var snapTs = data.snaps.map(s => s.ts);
    // Fleet median per snapshot - the reference line every panel shares.
    var median = data.snaps.map((s, i) => {
        var vals = entries.map(e => e.points[i]).filter(Boolean).map(p => p.v).sort((a, b) => a - b);
        if (!vals.length) return null;
        var mid = Math.floor(vals.length / 2);
        return { t: s.ts, v: vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2 };
    });
    var common = { minT: minT, maxT: maxT, thresholds: th, snaps: snapTs };

    if (mode === 'single') {
        var e = data.byId.get(deviceSel.value) || entries[0];
        container.innerHTML = `<div class="trend-panel big"><div class="trend-panel-head"><span class="trend-title">${TREND_METRIC_LABELS[metric]} - ${esc(e.label)}</span><span class="trend-legend"><i class="swatch subject"></i>device <i class="swatch median"></i>fleet median${th ? ' <i class="swatch band"></i>warning / critical' : ''}</span></div>
            ${trendChartSvg([{ points: e.points, cls: 'subject' }, { points: median, cls: 'median' }], Object.assign({ w: 1000, h: 380, big: true, xLabels: true, rebootsAt: e.rebootsAt }, common))}</div>`;
        return;
    }

    var top = entries.slice().sort((a, b) => b.peak - a.peak).slice(0, 8);
    var sharedMax = Math.max(...top.map(e => e.peak));   // one y-scale across panels so heights compare
    container.innerHTML = `<div class="trend-panel-head"><span class="trend-title">${TREND_METRIC_LABELS[metric]} - ${top.length} devices with the highest peak, ${data.snaps.length} snapshots</span><span class="trend-legend"><i class="swatch subject"></i>device <i class="swatch median"></i>fleet median${th ? ' <i class="swatch band"></i>warning / critical' : ''} <i class="swatch reboot"></i>reboot</span></div>
        <div class="trend-multiples">${top.map(e => {
            var tier = th ? severityTier(e.last, th.warn, th.crit) : 'neutral';
            return `<div class="trend-panel" onclick="document.getElementById('trendModeSelect').value='single'; document.getElementById('trendDeviceSelect').value=${JSON.stringify(e.id).replace(/"/g, '&quot;')}; window.renderTrendChart();" title="Open this device's full chart">
                <div class="trend-panel-head"><span class="trend-name">${esc(e.label)}</span><span class="trend-last tier-${tier}">${e.last}${unit}</span></div>
                ${trendChartSvg([{ points: e.points, cls: 'subject' }, { points: median, cls: 'median' }], Object.assign({ w: 300, h: 110, maxV: sharedMax, rebootsAt: e.rebootsAt }, common))}</div>`;
        }).join('')}</div>`;
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
        while ((m = irbRe.exec(text)) !== null) {
            var prefix = parseInt(m[4], 10);
            // The regex's \d{1,2} matches 0-99, but a valid IPv4 prefix length is 0-32 - a
            // malformed/truncated config line (or a typo upstream) could otherwise produce a
            // negative or fractional "usable addresses" count below. Drop it here so the vlan
            // falls into the existing "boundary not found" empty state instead.
            if (prefix < 0 || prefix > 32) continue;
            irbToSubnet.set(m[1] + '.' + m[2], { ip: m[3], prefix: prefix });
        }

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

    // Rows with a known boundary first, fullest first - the subnets that need growing are
    // the reason to open this tab; unknown-boundary rows trail alphabetically.
    var rows = Array.from(vlanNames).map(vlanName => {
        var ips = vlanIps.get(vlanName) || new Set();
        var subnet = vlanToSubnet.get(vlanName);
        if (!subnet) return { vlanName, ips, subnet: null, pct: -1 };
        if (subnet.prefix >= 31) return { vlanName, ips, subnet, pct: -1, pointToPoint: true };
        var base = networkBase(ipToInt(subnet.ip), subnet.prefix);
        var usable = Math.pow(2, 32 - subnet.prefix) - 2;
        // Require actual CIDR membership, not just a VLAN name match.
        var inSubnet = Array.from(ips).filter(ip => { var n = ipToInt(ip); return n !== null && networkBase(n, subnet.prefix) === base; });
        var pct = usable > 0 ? Math.round((inSubnet.length / usable) * 100) : 0;
        return { vlanName, ips, subnet, usable, used: inSubnet.length, pct };
    }).sort((a, b) => (b.pct - a.pct) || a.vlanName.localeCompare(b.vlanName, undefined, { numeric: true }));

    tbody.innerHTML = rows.map(r => {
        if (!r.subnet) {
            return `<tr class="ipspace-unknown">
                <td>${esc(r.vlanName)}</td>
                <td class="ipspace-note">Boundary not found in captured config</td>
                <td>${r.ips.size} live IP${r.ips.size === 1 ? '' : 's'}</td>
                <td><span class="ipspace-note">no boundary</span></td>
            </tr>`;
        }
        if (r.pointToPoint) {
            return `<tr>
                <td>${esc(r.vlanName)}</td>
                <td style="font-family:monospace;">${esc(r.subnet.ip)}/${r.subnet.prefix}</td>
                <td>${r.ips.size} / N/A</td>
                <td><span class="ipspace-note">point-to-point /${r.subnet.prefix}</span></td>
            </tr>`;
        }
        var tier = severityTier(r.pct, 75, 90);
        return `<tr>
            <td>${esc(r.vlanName)}</td>
            <td style="font-family:monospace;">${esc(r.subnet.ip)}/${r.subnet.prefix}</td>
            <td style="font-variant-numeric:tabular-nums;">${r.used} / ${r.usable}</td>
            <td class="ipspace-util">${inlineBar(r.pct, `${r.pct}% ${SEVERITY_WORD[tier]}`, tier, `${r.used} of ${r.usable} usable addresses seen as live clients`)}</td>
        </tr>`;
    }).join('');
};

// Reliability tab: one row per device, one column per crawled day, every device on screen
// at once (previously one device at a time from a dropdown). Cell colour is that day's peak
// alarm count, a red ring marks a reboot. Rows are ranked by total alarms then reboots, so
// the flappy devices are at the top; devices with nothing recorded are hidden unless
// #reliabilityShowQuiet is ticked. Cells stretch to the column width (CSS), so more days
// means smaller cells rather than a sideways scroll until they hit the 8px floor.
window.renderReliabilityHeatmap = function() {
    var container = document.getElementById('reliability-heatmap');
    if (!container) return;
    var showQuiet = !!(document.getElementById('reliabilityShowQuiet') || {}).checked;
    var history = window.updateAlarmHistory();

    // `days` keys are plain YYYY-MM-DD strings (see updateAlarmHistory); union across devices
    // gives the column set. Only crawled days become columns - gaps between crawls carry no
    // information, and spacing them to scale would leave most of the strip empty.
    var dateSet = new Set();
    var rows = Object.keys(history).map(id => {
        var e = history[id], alarms = 0, reboots = 0;
        Object.keys(e.days || {}).forEach(d => { dateSet.add(d); alarms += e.days[d].alarmCount; if (e.days[d].rebooted) reboots++; });
        return { id: id, label: (e.lastIp || '') + (e.lastHostname ? ' (' + e.lastHostname + ')' : ''), ip: e.lastIp || '', days: e.days || {}, alarms: alarms, reboots: reboots };
    });
    var dates = Array.from(dateSet).sort();
    if (dates.length === 0) {
        container.innerHTML = '<p class="fleet-list-empty">No dated snapshots recorded yet - load snapshots with a ScanTimestamp spanning multiple days to build history.</p>';
        return;
    }
    var active = rows.filter(r => r.alarms > 0 || r.reboots > 0);
    var shown = (showQuiet ? rows : active).sort((a, b) => (b.alarms - a.alarms) || (b.reboots - a.reboots) || window.GraphLayout.compareIpIds(a.ip, b.ip));

    var level = count => count === 0 ? '' : (count === 1 ? 'lvl1' : (count <= 3 ? 'lvl2' : (count <= 6 ? 'lvl3' : 'lvl4')));
    // Column headers: month name where the month changes (and on the first column), day
    // number under every column when there are few enough to read.
    var showDays = dates.length <= 40;
    var header = dates.map((d, i) => {
        var monthChanged = i === 0 || d.slice(0, 7) !== dates[i - 1].slice(0, 7);
        var month = monthChanged ? new Date(d + 'T00:00:00Z').toLocaleString(undefined, { month: 'short', timeZone: 'UTC' }) : '';
        return `<div class="rel-col-head" title="${esc(d)}"><span class="rel-month">${month}</span><span class="rel-day">${showDays ? +d.slice(8, 10) : ''}</span></div>`;
    }).join('');

    var body = shown.map(r => `<div class="rel-row-label" title="${esc(r.label)}"><span class="rel-ip">${esc(r.ip)}</span><span class="rel-host">${esc(r.label.replace(r.ip, '').replace(/^\s*\((.*)\)\s*$/, '$1'))}</span></div>` +
        dates.map(d => {
            var day = r.days[d];
            if (!day) return '<div class="rel-cell none" title="' + esc(d + ': not crawled') + '"></div>';
            var title = `${d}: ${day.alarmCount} alarm${day.alarmCount === 1 ? '' : 's'}${day.rebooted ? ' - rebooted' : ''}`;
            // Colour alone (WCAG 1.4.1) isn't enough to read severity here, and a title
            // attribute alone is hover-only - unreachable by keyboard/screen-reader users. The
            // alarm count is printed in the cell itself as a second, non-colour encoding, and
            // tabindex/aria-label/onkeydown put the same detail behind focus, not just hover.
            // showDays (dense-column check above) also gates the printed digit - a genuine
            // count is only useful if the cell is wide enough to show it whole; below that
            // width, a clipped "12" reading as "1" would be worse than no digit at all. Colour,
            // title and aria-label still carry the full count either way.
            var countText = (showDays && day.alarmCount > 0) ? day.alarmCount : '';
            return `<div class="rel-cell heatmap-cell ${level(day.alarmCount)}${day.rebooted ? ' rebooted' : ''}" title="${esc(title)}" aria-label="${esc(title)}" tabindex="0" role="button" onclick="window.goToSearchResult(${JSON.stringify(r.ip).replace(/"/g, '&quot;')}, 'tab-alarms')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}">${countText}</div>`;
        }).join('') +
        `<div class="rel-row-total" title="alarm-days / reboots">${r.alarms}<span class="rel-sep">/</span>${r.reboots}</div>`).join('');

    container.innerHTML = `<div class="rel-summary">${active.length} of ${rows.length} devices recorded an alarm or reboot across ${dates.length} crawled day${dates.length === 1 ? '' : 's'}${showQuiet ? '' : (rows.length > active.length ? ` - ${rows.length - active.length} quiet device${rows.length - active.length === 1 ? '' : 's'} hidden` : '')}.</div>
        <div class="rel-grid" style="grid-template-columns: 220px repeat(${dates.length}, minmax(8px, 28px)) 96px;">
            <div class="rel-corner"></div>${header}<div class="rel-col-head rel-total-head">alarms / reboots</div>
            ${body || '<div class="fleet-list-empty" style="grid-column: 1 / -1;">Nothing to show.</div>'}
        </div>
        <div class="heatmap-legend">
            <span>Less</span>
            <div class="heatmap-cell"></div><div class="heatmap-cell lvl1"></div><div class="heatmap-cell lvl2"></div><div class="heatmap-cell lvl3"></div><div class="heatmap-cell lvl4"></div>
            <span>More alarms</span>
            <span style="margin-left:14px; display:inline-flex; align-items:center; gap:4px;"><span class="heatmap-cell rebooted"></span> rebooted that day</span>
            <span style="margin-left:14px; display:inline-flex; align-items:center; gap:4px;"><span class="heatmap-cell none"></span> not crawled</span>
            <span class="rel-hint">Click a cell to open that device's alarms.</span>
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
                onClick: () => window.goToSearchResult(String(d.DeviceIP), 'tab-interfaces', activeSnapshotIndex, { port: c.Port }),
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
                    onClick: () => window.goToSearchResult(String(d.DeviceIP), 'tab-interfaces', activeSnapshotIndex, { port: c.Port }),
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
                    onClick: () => window.goToSearchResult(String(d.DeviceIP), 'tab-interfaces', activeSnapshotIndex, { port: port }),
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
