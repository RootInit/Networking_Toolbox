// Everything backed by localStorage: configurable thresholds (#sidebar-tab-settings), the
// cross-session "new device" history the Analysis Dashboard builds on, and the cross-session
// alarm/reboot history the Reliability heatmap builds on. All three are derived caches the
// browser keeps between sessions; nothing here is written to disk by PowerShell - reload
// from a fresh set of snapshots and it rebuilds. Reads `loadedSnapshots`/`activeSnapshotIndex`
// (app.js) and calls window.renderCrawlAge/window.setStatus (utils.js).

// --- Dark Mode (see .settings-toggle-row in index.html) ---
// Client-only preference, deliberately separate from the server-synced settings below it -
// localStorage, not Configuration.json.enc. The actual theme is applied by the inline boot
// script in index.html's <head> (stamps data-theme before first paint, avoiding a flash of
// the wrong theme); this just keeps the checkbox and localStorage in sync with it afterward.
window.initDarkModeToggle = function() {
    var checkbox = document.getElementById('setting-darkMode');
    if (!checkbox) return;
    checkbox.checked = document.documentElement.getAttribute('data-theme') === 'dark';
    checkbox.addEventListener('change', function() {
        var dark = checkbox.checked;
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        try { localStorage.setItem('darkMode', dark ? 'dark' : 'light'); } catch (e) {}
        // Everything else is plain CSS and repaints on its own - the trend chart is the one
        // view drawn to a <canvas> (see window.renderTrendChart in dashboard.js), which reads
        // theme colors at draw time and needs an explicit re-render to pick up the flip.
        var trendsTab = document.getElementById('analysis-tab-trends');
        if (trendsTab && trendsTab.classList.contains('active')) window.renderTrendChart();
    });
};
document.addEventListener('DOMContentLoaded', window.initDarkModeToggle);

// --- Configurable Thresholds (see #sidebar-tab-settings) ---

// Threshold + graph-layout settings, persisted in the encrypted Configuration.json.enc (via
// map.js's loaded-config object). clusterThreshold/nodeSpacing/leafSpacing/minRadius mirror
// network_vis.html's static defaults, used as the fallback until a config has loaded.
var DEFAULT_SETTINGS = {
    cpuWarnPct: 70, cpuCriticalPct: 90,
    memWarnPct: 75, memCriticalPct: 90,
    crawlAgeFreshMin: 60, crawlAgeStaleMin: 1440,
    recentRebootMin: 60,
    clusterThreshold: 50, nodeSpacing: 350, leafSpacing: 250, minRadius: 250,
};
// Graph-layout keys use their bare id as the DOM element id (#clusterThreshold, ...);
// threshold keys use a `setting-` prefix (#setting-cpuWarnPct, ...). Maps a settings key
// to its actual input id.
var LAYOUT_SETTING_KEYS = ['clusterThreshold', 'nodeSpacing', 'leafSpacing', 'minRadius'];
function settingInputId(key) {
    return LAYOUT_SETTING_KEYS.indexOf(key) === -1 ? 'setting-' + key : key;
}

// Synchronous by design: called on every render tick (utils.js, dashboard.js) well before
// the Configuration.json.enc fetch+decrypt may have happened. Reads whatever's in memory -
// DEFAULT_SETTINGS until a real config has loaded, real saved values after.
window.loadSettings = function() {
    var loaded = window.getLoadedSettings ? window.getLoadedSettings() : {};
    return Object.assign({}, DEFAULT_SETTINGS, loaded);
};

// Populates the Settings tab's inputs (thresholds, graph layout, Juniper login) from the
// loaded config. Called twice per tab-open: once immediately with best-available values,
// once after ensureConfigLoaded resolves with the real saved values.
window.populateSettingsInputs = function() {
    var settings = window.loadSettings();
    // Captured as strings straight off .value so the before/after comparison below doesn't
    // compare a string to a number and report "changed" on every call.
    var layoutBefore = LAYOUT_SETTING_KEYS.map(function (key) {
        var el = document.getElementById(settingInputId(key));
        return el ? el.value : null;
    });

    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById(settingInputId(key));
        if (el) el.value = settings[key];
    });

    var creds = window.getLoadedCredentials ? window.getLoadedCredentials() : { username: '', password: '' };
    var userEl = document.getElementById('setting-junosUsername');
    var passEl = document.getElementById('setting-junosPassword');
    if (userEl) userEl.value = creds.username || '';
    if (passEl) passEl.value = creds.password || '';

    // Setting el.value programmatically doesn't fire the graph-layout inputs' onchange
    // handlers, which are what re-lays-out the diagram for a changed layout value - trigger
    // it manually, but only if a value actually changed (this fn runs twice per tab-open,
    // and `network` is null until a snapshot has been loaded).
    var layoutChanged = LAYOUT_SETTING_KEYS.some(function (key, i) {
        var el = document.getElementById(settingInputId(key));
        return el ? el.value !== layoutBefore[i] : false;
    });
    if (layoutChanged && typeof window.renderVisibleGraph === 'function' && network) window.renderVisibleGraph();
};

// Must load the config before reading the form: saveConfiguration's own internal
// ensureConfigLoaded call would otherwise run after setLoadedCredentials/setLoadedSettings
// and overwrite the just-typed values with what's on disk.
window.saveSettingsPanel = async function() {
    var loaded = await window.ensureConfigLoaded();
    if (!loaded) {
        window.setStatus("Settings not saved - the existing configuration has not finished loading. Try again in a moment.", "red");
        return;
    }

    var settings = {};
    var invalid = false;
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById(settingInputId(key));
        var n = el ? parseFloat(el.value) : NaN;
        var min = LAYOUT_SETTING_KEYS.indexOf(key) === -1 ? 0 : (key === 'clusterThreshold' ? 2 : 20);
        if (!Number.isFinite(n) || n < min) { invalid = true; return; }
        settings[key] = n;
    });
    if (invalid) {
        window.setStatus("Settings not saved - all fields must be valid numbers within range.", "red");
        return;
    }

    var userEl = document.getElementById('setting-junosUsername');
    var passEl = document.getElementById('setting-junosPassword');
    window.setLoadedCredentials({
        username: userEl ? userEl.value : '',
        password: passEl ? passEl.value : '',
    });
    window.setLoadedSettings(settings);

    var ok = await window.saveConfiguration();
    if (ok) {
        // Refresh already-rendered UI that depends on thresholds/layout rather than
        // requiring a reload; guarded on `network` since nothing is laid out pre-snapshot.
        if (loadedSnapshots[activeSnapshotIndex]) window.renderCrawlAge(loadedSnapshots[activeSnapshotIndex].scanTimestamp);
        if (typeof window.renderVisibleGraph === 'function' && network) window.renderVisibleGraph();
        window.setStatus("Settings saved.", "green");
    } else {
        // noMirror: true - saveConfiguration already wrote the detailed reason to
        // #mapStatusNote; without this, setStatus's mirroring would overwrite it.
        window.setStatus("Settings not saved - see the status note for the error.", "red", { noMirror: true });
    }
};

// Resets threshold + graph-layout fields only; Juniper username/password are left alone.
// Nothing is written to Configuration.json.enc until Save is clicked.
window.resetSettingsPanel = function() {
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById(settingInputId(key));
        if (el) el.value = DEFAULT_SETTINGS[key];
    });
    // Programmatic el.value doesn't fire onchange, so re-layout must be triggered manually.
    if (typeof window.renderVisibleGraph === 'function' && network) window.renderVisibleGraph();
};

// --- Multi-Snapshot Analysis: New Devices + Trends (see #analysisview / dashboard.js) ---

var DEVICE_HISTORY_STORAGE_KEY = 'ps_networkmapper_device_history_v1';
// Hard cap on distinct MACs tracked - without one this grows forever (one entry per MAC ever
// seen, never removed). Trimmed by oldest lastSeen first whenever a merge pushes past the cap.
var MAX_DEVICE_HISTORY_ENTRIES = 5000;

function trimDeviceHistory(history) {
    var keys = Object.keys(history);
    if (keys.length <= MAX_DEVICE_HISTORY_ENTRIES) return history;
    keys.sort(function (a, b) {
        var am = window.parseTimestampMs(history[a].lastSeen);
        var bm = window.parseTimestampMs(history[b].lastSeen);
        return (bm === null ? -Infinity : bm) - (am === null ? -Infinity : am);
    });
    keys.slice(MAX_DEVICE_HISTORY_ENTRIES).forEach(function (k) { delete history[k]; });
    return history;
}

function loadDeviceHistory() {
    try {
        var raw = localStorage.getItem(DEVICE_HISTORY_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        return {}; // private browsing / storage disabled - start from empty each time
    }
}

function saveDeviceHistory(history) {
    try {
        localStorage.setItem(DEVICE_HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
        console.warn('Could not persist device history to localStorage:', e.message);
    }
}

// Merges every client MAC across all currently loaded snapshots into a persisted
// cross-session history, so "new device" detection can span weeks without reloading every
// historical file each session. Snapshots without a ScanTimestamp are skipped.
window.updateDeviceHistory = function() {
    var history = loadDeviceHistory();

    loadedSnapshots.forEach(snapshot => {
        var ts = snapshot.scanTimestamp;
        var tsMs = window.parseTimestampMs(ts);
        if (tsMs === null) return;
        snapshot.topology.forEach(device => {
            window.asArray(device.TrueClients).forEach(c => {
                if (!c.MAC) return;
                var mac = String(c.MAC).toLowerCase();
                var entry = history[mac];
                if (!entry) {
                    history[mac] = { firstSeen: ts, lastSeen: ts, lastDeviceIp: device.DeviceIP, lastPort: c.Port, lastIp: c.IP, lastVlan: c.VLAN_Tag };
                } else {
                    // entry.firstSeen/lastSeen aren't guaranteed parseable just because this
                    // guard now validates every ts going in - `entry` can be a survivor from
                    // localStorage written by an earlier build (DEVICE_HISTORY_STORAGE_KEY was
                    // never version-bumped the way ALARM_HISTORY_STORAGE_KEY was) that predates
                    // this validation, so a truthy-garbage firstSeen/lastSeen can already be
                    // sitting there. A null parse loses the "older/newer" comparison entirely -
                    // treat it as "replace with this valid ts" rather than as smaller/larger.
                    var firstSeenMs = window.parseTimestampMs(entry.firstSeen);
                    if (firstSeenMs === null || tsMs < firstSeenMs) entry.firstSeen = ts;
                    var lastSeenMs = window.parseTimestampMs(entry.lastSeen);
                    if (lastSeenMs === null || tsMs >= lastSeenMs) {
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

    trimDeviceHistory(history);
    saveDeviceHistory(history);
    return history;
};

// --- Reliability Heatmap history (see #analysis-tab-reliability) ---
// Cross-session per-device history, keyed by window.resolveDeviceIdentity (not DeviceIP or
// MAC), same recompute-and-merge pattern as window.updateDeviceHistory. Storage key bumped
// to _v2 (was DeviceIP-keyed) so old entries are abandoned rather than mixed under new keys.
var ALARM_HISTORY_STORAGE_KEY = 'ps_networkmapper_alarm_history_v2';
// Hard cap on per-device heatmap days - without one entry.days grows one key per calendar day
// forever. yyyy-MM-dd keys sort lexicographically = chronologically, so a plain string sort
// finds the oldest. ~1.5yr of daily columns, comfortably past what the heatmap UI displays.
var MAX_ALARM_HISTORY_DAYS = 550;

function trimAlarmHistoryDays(history) {
    Object.keys(history).forEach(function (identity) {
        var days = history[identity] && history[identity].days;
        if (!days) return;
        var dates = Object.keys(days);
        if (dates.length <= MAX_ALARM_HISTORY_DAYS) return;
        dates.sort();
        dates.slice(0, dates.length - MAX_ALARM_HISTORY_DAYS).forEach(function (d) { delete days[d]; });
    });
    return history;
}

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

// lastUptimeSeen must stay local to this call, not persisted - persisting it would make
// repeated calls over the same loadedSnapshots non-idempotent (each dashboard refresh would
// re-walk from the oldest snapshot against an already-advanced value and falsely flag a
// reboot, which then sticks permanently since `rebooted` is OR'd into storage). Trade-off:
// a reboot in the gap between two separate file-load sessions goes undetected.
window.updateAlarmHistory = function() {
    var history = loadAlarmHistory();
    var lastUptimeSeen = {}; // identity -> uptime string, scoped to this call only

    loadedSnapshots
        .map(s => ({ s: s, ts: window.parseTimestampMs(s.scanTimestamp) }))
        .filter(x => x.ts !== null)
        .sort((a, b) => a.ts - b.ts)
        .forEach(x => {
            var snapshot = x.s;
            // x.ts is already parseTimestampMs-validated (see the .filter above), so a raw
            // slice is safe for the normal "yyyy-MM-dd..." shape FleetCrawl.ps1 writes -
            // and preserves the original local wall-clock date instead of reinterpreting
            // through UTC. A parseable-but-differently-shaped string ("08/20/2026", a Unix
            // timestamp, ...) would otherwise slice into a garbage (non-yyyy-MM-dd) heatmap
            // column key, so fall back to a UTC-derived key in that case only.
            var date = /^\d{4}-\d{2}-\d{2}/.test(snapshot.scanTimestamp)
                ? snapshot.scanTimestamp.slice(0, 10)
                : new Date(x.ts).toISOString().slice(0, 10);
            (snapshot.topology || []).forEach(device => {
                if (!device || !device.DeviceIP) return;
                var identity = window.resolveDeviceIdentity(device);
                if (!history[identity]) history[identity] = { days: {} };
                var entry = history[identity];
                var alarmCount = window.asArray(device.Alarms).length;
                var prevUptime = lastUptimeSeen[identity] || null;
                var rebootedToday = !!(device.Uptime && device.Uptime !== "Unknown" && prevUptime && device.Uptime !== prevUptime);

                if (!entry.days[date]) entry.days[date] = { alarmCount: 0, rebooted: false };
                entry.days[date].alarmCount = Math.max(entry.days[date].alarmCount, alarmCount);
                entry.days[date].rebooted = entry.days[date].rebooted || rebootedToday;
                // Latest-known label/IP, for populateReliabilityDeviceSelect's dropdown text -
                // ascending date order means the last write here really is the most recent.
                entry.lastHostname = (device.Hostname && device.Hostname !== "Unknown") ? device.Hostname : entry.lastHostname;
                entry.lastIp = String(device.DeviceIP);

                if (device.Uptime && device.Uptime !== "Unknown") lastUptimeSeen[identity] = device.Uptime;
            });
        });

    trimAlarmHistoryDays(history);
    saveAlarmHistory(history);
    return history;
};
