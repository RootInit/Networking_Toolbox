// Everything backed by localStorage: configurable thresholds (#sidebar-tab-settings), the
// cross-session "new device" history the Analysis Dashboard's New Devices/Trends tabs
// build on, and the cross-session alarm/reboot history the Reliability heatmap builds on.
// All three are derived caches the browser keeps between sessions - nothing here is
// written to disk by PowerShell (no ledger script by design); reload from a fresh set of
// snapshots and it rebuilds. Reads `loadedSnapshots`/`activeSnapshotIndex` (declared in
// app.js) and calls window.renderCrawlAge/window.setStatus (utils.js).

// --- Configurable Thresholds (see #sidebar-tab-settings) ---

var SETTINGS_STORAGE_KEY = 'ps_networkmapper_settings_v1';
// Alarm severity (Major/Minor) is deliberately not here - it maps directly to Junos's
// own two-tier scheme, not a meaningful place for a user knob.
var DEFAULT_SETTINGS = {
    cpuWarnPct: 70, cpuCriticalPct: 90,
    memWarnPct: 75, memCriticalPct: 90,
    crawlAgeFreshMin: 60, crawlAgeStaleMin: 1440,
    recentRebootMin: 60,
};

// Merges saved settings over the defaults (not a bare Object.assign the other way) so a
// version of this tool that adds a new setting later doesn't crash reading an older
// saved blob that's simply missing that key - it just falls back to the new default.
window.loadSettings = function() {
    try {
        var raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        return Object.assign({}, DEFAULT_SETTINGS, raw ? JSON.parse(raw) : {});
    } catch (e) {
        return Object.assign({}, DEFAULT_SETTINGS);
    }
};

window.saveSettings = function(settings) {
    try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn('Could not persist settings to localStorage:', e.message);
    }
};

// Populates the Settings tab's threshold inputs from storage - called on tab activation
// (see window.switchSidebarTab) since there's no "open" event for an always-present tab.
window.populateSettingsInputs = function() {
    var settings = window.loadSettings();
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById('setting-' + key);
        if (el) el.value = settings[key];
    });
};

window.saveSettingsPanel = function() {
    var settings = {};
    var invalid = false;
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById('setting-' + key);
        var n = el ? parseFloat(el.value) : NaN;
        if (!Number.isFinite(n) || n < 0) { invalid = true; return; }
        settings[key] = n;
    });
    if (invalid) {
        window.setStatus("Settings not saved - all thresholds must be non-negative numbers.", "red");
        return;
    }
    window.saveSettings(settings);
    // Thresholds affect already-rendered UI, not just future renders - refresh anything
    // currently showing threshold-driven state rather than requiring a reload.
    if (loadedSnapshots[activeSnapshotIndex]) window.renderCrawlAge(loadedSnapshots[activeSnapshotIndex].scanTimestamp);
    window.setStatus("Settings saved.", "green");
};

window.resetSettingsPanel = function() {
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById('setting-' + key);
        if (el) el.value = DEFAULT_SETTINGS[key];
    });
};

// --- Multi-Snapshot Analysis: New Devices + Trends (see #sidebar-tab-analysis) ---

var DEVICE_HISTORY_STORAGE_KEY = 'ps_networkmapper_device_history_v1';

function loadDeviceHistory() {
    try {
        var raw = localStorage.getItem(DEVICE_HISTORY_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        return {}; // private browsing / storage disabled - just start from empty each time
    }
}

function saveDeviceHistory(history) {
    try {
        localStorage.setItem(DEVICE_HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
        // Storage full/unavailable - history won't persist across sessions, but the
        // current in-memory computation from loadedSnapshots still works this session.
        console.warn('Could not persist device history to localStorage:', e.message);
    }
}

// Merges every client MAC seen across all currently loaded snapshots into a persisted
// cross-session history - this is what lets "new device" detection span weeks without
// reloading every historical snapshot file every session. Purely a browser-side cache of
// derived data; nothing is written to disk by PowerShell for this (per explicit design
// direction - no ledger script). Snapshots with no ScanTimestamp (predate that field)
// can't be placed in time and are skipped for history purposes, same as elsewhere.
window.updateDeviceHistory = function() {
    var history = loadDeviceHistory();

    loadedSnapshots.forEach(snapshot => {
        var ts = snapshot.scanTimestamp;
        if (!ts) return;
        snapshot.topology.forEach(device => {
            (device.TrueClients || []).forEach(c => {
                if (!c.MAC) return;
                var mac = String(c.MAC).toLowerCase();
                var entry = history[mac];
                if (!entry) {
                    history[mac] = { firstSeen: ts, lastSeen: ts, lastDeviceIp: device.DeviceIP, lastPort: c.Port, lastIp: c.IP, lastVlan: c.VLAN_Tag };
                } else {
                    if (new Date(ts) < new Date(entry.firstSeen)) entry.firstSeen = ts;
                    if (new Date(ts) >= new Date(entry.lastSeen)) {
                        entry.lastSeen = ts;
                        entry.lastDeviceIp = device.DeviceIP;
                        entry.lastPort = c.Port;
                        entry.lastIp = c.IP;
                        entry.lastVlan = c.VLAN_Tag;
                    }
                }
            });
        });
    });

    saveDeviceHistory(history);
    return history;
};

// --- Reliability Heatmap history (see #analysis-tab-reliability) ---
// Cross-session per-device history, keyed by DeviceIP (not client MAC) - same "recompute
// by re-walking every loaded snapshot, merge into whatever's already in localStorage"
// pattern as window.updateDeviceHistory, so loading more historical snapshots later only
// enriches this, never loses it. Reboot detection persists the same idea renderTrendChart
// already draws as a same-session-only marker (Uptime changing between snapshots), but
// kept across sessions here via a stored lastKnownUptime per device.
var ALARM_HISTORY_STORAGE_KEY = 'ps_networkmapper_alarm_history_v1';

function loadAlarmHistory() {
    try {
        var raw = localStorage.getItem(ALARM_HISTORY_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        return {};
    }
}

function saveAlarmHistory(history) {
    try {
        localStorage.setItem(ALARM_HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
        console.warn('Could not persist alarm/reboot history to localStorage:', e.message);
    }
}

// Per-device "uptime as of the previous snapshot in THIS walk" - local to one call, never
// persisted. Comparing against a PERSISTED lastKnownUptime instead (as this used to) made
// repeated calls over the same loadedSnapshots non-idempotent: this runs on every
// dashboard refresh (renderReliabilityHeatmap calls it every time), and a second call
// would start its walk by comparing the OLDEST snapshot's uptime against whatever the
// FIRST call had already advanced lastKnownUptime to (the NEWEST snapshot's uptime) -
// falsely flagging the oldest loaded day as a reboot on every single refresh, and since
// `rebooted` is OR'd into storage, that false flag then stuck permanently. The trade-off:
// a reboot that happened exactly in the gap between two separate file-load sessions (no
// snapshot overlap) is no longer detected - accepting that is far better than corrupting
// the record on ordinary repeated use.
window.updateAlarmHistory = function() {
    var history = loadAlarmHistory();
    var lastUptimeSeen = {}; // deviceIp -> uptime string, scoped to this call only

    loadedSnapshots
        .filter(s => s.scanTimestamp)
        .slice()
        .sort((a, b) => new Date(a.scanTimestamp) - new Date(b.scanTimestamp))
        .forEach(snapshot => {
            var date = snapshot.scanTimestamp.slice(0, 10);
            (snapshot.topology || []).forEach(device => {
                if (!device || !device.DeviceIP) return;
                var ip = String(device.DeviceIP);
                if (!history[ip]) history[ip] = { days: {} };
                var entry = history[ip];
                var alarmCount = window.asArray(device.Alarms).length;
                var prevUptime = lastUptimeSeen[ip] || null;
                var rebootedToday = !!(device.Uptime && device.Uptime !== "Unknown" && prevUptime && device.Uptime !== prevUptime);

                if (!entry.days[date]) entry.days[date] = { alarmCount: 0, rebooted: false };
                entry.days[date].alarmCount = Math.max(entry.days[date].alarmCount, alarmCount);
                entry.days[date].rebooted = entry.days[date].rebooted || rebootedToday;

                if (device.Uptime && device.Uptime !== "Unknown") lastUptimeSeen[ip] = device.Uptime;
            });
        });

    saveAlarmHistory(history);
    return history;
};
