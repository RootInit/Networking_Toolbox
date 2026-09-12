// The settings panel plus the cross-session device and alarm/reboot histories the dashboard builds
// on. The histories are derived caches: PowerShell never writes them, and a reload rebuilds them.

// --- Dark Mode ---
// Two layers: localStorage is the first-paint cache index.html's boot script reads, since the
// server-synced config only resolves after a password prompt. The config is the source of truth,
// and applyDarkMode is the single writer keeping the two in step.
function applyDarkMode(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var checkbox = document.getElementById('setting-darkMode');
    if (checkbox) checkbox.checked = dark;
    try { localStorage.setItem('darkMode', dark ? 'dark' : 'light'); } catch (e) {}
    // The trend chart samples theme colors at draw time, so it needs an explicit re-render.
    var trendsTab = document.getElementById('analysis-tab-trends');
    if (trendsTab && trendsTab.classList.contains('active')) window.renderTrendChart();
}

window.initDarkModeToggle = function() {
    var checkbox = document.getElementById('setting-darkMode');
    if (!checkbox) return;
    checkbox.checked = document.documentElement.getAttribute('data-theme') === 'dark';
    checkbox.addEventListener('change', function() { applyDarkMode(checkbox.checked); });
};
document.addEventListener('DOMContentLoaded', window.initDarkModeToggle);

// --- Configurable Thresholds (#sidebar-tab-settings) --- persisted in Configuration.json.enc.
// The layout values must mirror index.html's static defaults, the fallback until a config loads.
var DEFAULT_SETTINGS = {
    cpuWarnPct: 70, cpuCriticalPct: 90,
    memWarnPct: 75, memCriticalPct: 90,
    crawlAgeFreshMin: 60, crawlAgeStaleMin: 1440,
    recentRebootMin: 60,
    clusterThreshold: 50, nodeSpacing: 350, leafSpacing: 250, minRadius: 250,
};
// Layout inputs are named by the bare key; threshold inputs carry a `setting-` prefix.
var LAYOUT_SETTING_KEYS = ['clusterThreshold', 'nodeSpacing', 'leafSpacing', 'minRadius'];
function settingInputId(key) {
    return LAYOUT_SETTING_KEYS.indexOf(key) === -1 ? 'setting-' + key : key;
}

// Synchronous by design: called every render tick, long before the config fetch completes.
window.loadSettings = function() {
    var loaded = window.getLoadedSettings ? window.getLoadedSettings() : {};
    return Object.assign({}, DEFAULT_SETTINGS, loaded);
};

// Runs twice per tab-open: once with best-available values, once after ensureConfigLoaded.
window.populateSettingsInputs = function() {
    var settings = window.loadSettings();
    // Raw .value strings, so the comparison below isn't string-vs-number and always "changed".
    var layoutBefore = LAYOUT_SETTING_KEYS.map(function (key) {
        var el = document.getElementById(settingInputId(key));
        return el ? el.value : null;
    });

    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById(settingInputId(key));
        if (el) el.value = settings[key];
    });

    // Tri-state: a config with no darkMode key must not override the choice applied at first paint.
    if (typeof settings.darkMode === 'boolean') applyDarkMode(settings.darkMode);

    var creds = window.getLoadedCredentials ? window.getLoadedCredentials() : { username: '', password: '' };
    var userEl = document.getElementById('setting-junosUsername');
    var passEl = document.getElementById('setting-junosPassword');
    if (userEl) userEl.value = creds.username || '';
    if (passEl) passEl.value = creds.password || '';

    // Programmatic el.value doesn't fire the layout inputs' onchange, so re-layout is triggered by
    // hand - only on a real change, since this runs twice per tab-open.
    var layoutChanged = LAYOUT_SETTING_KEYS.some(function (key, i) {
        var el = document.getElementById(settingInputId(key));
        return el ? el.value !== layoutBefore[i] : false;
    });
    if (layoutChanged && typeof window.renderVisibleGraph === 'function' && network) window.renderVisibleGraph();
};

// The config must be loaded before the form is read: saveConfiguration's own ensureConfigLoaded
// would otherwise run after setLoadedSettings and overwrite the just-typed values.
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

    // Not a DEFAULT_SETTINGS key, but written here regardless: setLoadedSettings REPLACES the
    // settings object, so a darkMode left out would be dropped on the next threshold save.
    var darkEl = document.getElementById('setting-darkMode');
    if (darkEl) settings.darkMode = darkEl.checked;

    var userEl = document.getElementById('setting-junosUsername');
    var passEl = document.getElementById('setting-junosPassword');
    window.setLoadedCredentials({
        username: userEl ? userEl.value : '',
        password: passEl ? passEl.value : '',
    });
    window.setLoadedSettings(settings);

    var ok = await window.saveConfiguration();
    if (ok) {
        // Refresh threshold/layout-dependent UI in place; `network` is null pre-snapshot.
        if (loadedSnapshots[activeSnapshotIndex]) window.renderCrawlAge(loadedSnapshots[activeSnapshotIndex].scanTimestamp);
        if (typeof window.renderVisibleGraph === 'function' && network) window.renderVisibleGraph();
        window.setStatus("Settings saved.", "green");
    } else {
        // noMirror: saveConfiguration already wrote the detailed reason to #mapStatusNote.
        window.setStatus("Settings not saved - see the status note for the error.", "red", { noMirror: true });
    }
};

// Resets the form fields only; nothing reaches Configuration.json.enc until Save is clicked.
window.resetSettingsPanel = function() {
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById(settingInputId(key));
        if (el) el.value = DEFAULT_SETTINGS[key];
    });
    if (typeof window.renderVisibleGraph === 'function' && network) window.renderVisibleGraph();
};

// --- Multi-Snapshot Analysis: New Devices + Trends (see #analysisview / dashboard.js) ---

var DEVICE_HISTORY_STORAGE_KEY = 'ps_networkmapper_device_history_v1';
// Without a cap this grows one entry per MAC ever seen; oldest lastSeen is trimmed first.
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
        return {}; // private browsing / storage disabled
    }
}

function saveDeviceHistory(history) {
    try {
        localStorage.setItem(DEVICE_HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
        console.warn('Could not persist device history to localStorage:', e.message);
    }
}

// Merges every client MAC across loaded snapshots, so "new device" detection spans weeks.
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
                    // firstSeen/lastSeen can be unparseable: the storage key was never version-bumped,
                    // so a null parse means the comparison is meaningless - treat it as "replace".
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

// --- Reliability Heatmap history --- keyed by window.resolveDeviceIdentity; the _v2 suffix
// abandons the old DeviceIP-keyed entries rather than mixing them under the new keys.
var ALARM_HISTORY_STORAGE_KEY = 'ps_networkmapper_alarm_history_v2';
// entry.days would grow a key per calendar day forever; yyyy-MM-dd sorts chronologically.
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

// lastUptimeSeen must stay local to this call: persisting it makes repeated runs non-idempotent -
// each refresh re-walks from the oldest snapshot against an already-advanced value and falsely
// flags a reboot, which sticks because `rebooted` is OR'd into storage.
window.updateAlarmHistory = function() {
    var history = loadAlarmHistory();
    var lastUptimeSeen = {};

    loadedSnapshots
        .map(s => ({ s: s, ts: window.parseTimestampMs(s.scanTimestamp) }))
        .filter(x => x.ts !== null)
        .sort((a, b) => a.ts - b.ts)
        .forEach(x => {
            var snapshot = x.s;
            // Slicing the raw "yyyy-MM-dd..." keeps the original local wall-clock date rather than
            // reinterpreting it through UTC. Any other shape would slice garbage, hence the fallback.
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
                // Ascending date order means the last write really is the most recent.
                entry.lastHostname = (device.Hostname && device.Hostname !== "Unknown") ? device.Hostname : entry.lastHostname;
                entry.lastIp = String(device.DeviceIP);

                if (device.Uptime && device.Uptime !== "Unknown") lastUptimeSeen[identity] = device.Uptime;
            });
        });

    trimAlarmHistoryDays(history);
    saveAlarmHistory(history);
    return history;
};
