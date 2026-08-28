// Everything backed by localStorage: configurable thresholds (#sidebar-tab-settings), the
// cross-session "new device" history the Analysis Dashboard's New Devices/Trends tabs
// build on, and the cross-session alarm/reboot history the Reliability heatmap builds on.
// All three are derived caches the browser keeps between sessions - nothing here is
// written to disk by PowerShell (no ledger script by design); reload from a fresh set of
// snapshots and it rebuilds. Reads `loadedSnapshots`/`activeSnapshotIndex` (declared in
// app.js) and calls window.renderCrawlAge/window.setStatus (utils.js).

// --- Configurable Thresholds (see #sidebar-tab-settings) ---

// Threshold + graph-layout settings, now all persisted in the encrypted
// Configuration.json.enc (via map.js's loaded-config object) instead of localStorage or
// bare DOM state. Alarm severity (Major/Minor) is deliberately not here - it maps directly
// to Junos's own two-tier scheme, not a meaningful place for a user knob. clusterThreshold/
// nodeSpacing/leafSpacing/minRadius match network_vis.html's own static HTML defaults - kept
// here too so resetSettingsPanel and the "not yet loaded" fallback (before Configuration.json.enc
// has ever been fetched this session) have somewhere to fall back to.
var DEFAULT_SETTINGS = {
    cpuWarnPct: 70, cpuCriticalPct: 90,
    memWarnPct: 75, memCriticalPct: 90,
    crawlAgeFreshMin: 60, crawlAgeStaleMin: 1440,
    recentRebootMin: 60,
    clusterThreshold: 50, nodeSpacing: 350, leafSpacing: 250, minRadius: 250,
};
// The four graph-layout keys use their bare id as the DOM element id (#clusterThreshold,
// #nodeSpacing, ...) - a naming convention that predates this file (see network_vis.html) -
// while the threshold keys use a `setting-` prefix (#setting-cpuWarnPct, ...). This maps a
// settings key to its actual input id so populate/save/reset can loop over one key list
// instead of hand-writing two near-identical blocks.
var LAYOUT_SETTING_KEYS = ['clusterThreshold', 'nodeSpacing', 'leafSpacing', 'minRadius'];
function settingInputId(key) {
    return LAYOUT_SETTING_KEYS.indexOf(key) === -1 ? 'setting-' + key : key;
}

// Synchronous by design - utils.js's renderCrawlAge (a setInterval tick) and dashboard.js's
// fleet-health rendering both call this on every render, long before (or entirely without)
// the user ever opening the Map view or Settings tab that triggers the actual
// Configuration.json.enc fetch+decrypt (see map.js's ensureConfigLoaded). Reads whatever's
// currently in memory: DEFAULT_SETTINGS until a real config has loaded this session, the
// real saved values after. No longer reads localStorage - settings now live in
// Configuration.json.enc, loaded once per session by map.js's shared config machinery.
window.loadSettings = function() {
    var loaded = window.getLoadedSettings ? window.getLoadedSettings() : {};
    return Object.assign({}, DEFAULT_SETTINGS, loaded);
};

// Populates the Settings tab's inputs (thresholds, graph layout, Juniper login) from the
// loaded config - called on tab activation (see window.switchSidebarTab) since there's no
// "open" event for an always-present tab. Called twice per tab-open: once immediately (best
// available values - defaults, or an earlier load) and once after ensureConfigLoaded
// resolves (the real saved values, once the password prompt/fetch complete).
window.populateSettingsInputs = function() {
    var settings = window.loadSettings();
    // Only the four graph-layout inputs feed the diagram (graph.js's getClusterThreshold/
    // getLayoutSettings read them live off the DOM at render time); the threshold keys don't
    // affect layout at all. Captured as strings, straight off .value, and compared against
    // the same afterwards - comparing .value against settings[key] would compare a string to
    // a number and report "changed" on every single call.
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

    // Setting el.value programmatically does NOT fire the graph-layout inputs' onchange
    // handlers (window.setClusterThreshold/window.setLayoutSetting in graph.js), and those
    // handlers are the only thing that re-lays-out the diagram for a changed layout value -
    // so without this, a loaded config showed its saved numbers in the boxes while the
    // diagram kept the layout it was built with.
    //
    // Conditional, unlike the deliberate single-click Save/Reset paths: app.js's
    // switchSidebarTab calls this TWICE per Settings-tab open (once immediately, once after
    // ensureConfigLoaded resolves), so an unconditional call would mean two serialized ELK
    // layout round-trips and a "Computing layout..." overlay flash every time the tab is
    // opened, even when nothing changed. `network` (app.js) is null until a snapshot has
    // been loaded, where there is nothing laid out to refresh.
    var layoutChanged = LAYOUT_SETTING_KEYS.some(function (key, i) {
        var el = document.getElementById(settingInputId(key));
        return el ? el.value !== layoutBefore[i] : false;
    });
    if (layoutChanged && typeof window.renderVisibleGraph === 'function' && network) window.renderVisibleGraph();
};

// Loading the config MUST happen before the form is read, not after. saveConfiguration
// calls ensureConfigLoaded internally, so reading the form and calling
// setLoadedCredentials/setLoadedSettings first meant that - whenever the config hadn't
// already loaded this session - that internal first load ran afterwards and overwrote the
// values just typed with whatever was on disk (or with empties), silently discarding the
// user's edit while still reporting "Settings saved." in green. Doing the load first makes
// saveConfiguration's own ensureConfigLoaded call a cheap no-op, and leaves the freshly
// typed values as the last writers.
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
        // Thresholds affect already-rendered UI, not just future renders - refresh anything
        // currently showing threshold-driven state rather than requiring a reload.
        if (loadedSnapshots[activeSnapshotIndex]) window.renderCrawlAge(loadedSnapshots[activeSnapshotIndex].scanTimestamp);
        // The four graph-layout settings are read live from the DOM at render time (see
        // graph.js's getClusterThreshold/getLayoutSettings), so a saved change only becomes
        // visible once something re-lays-out the diagram. Their onchange handlers do that
        // for hand-typed edits; a Save (or a config load / Reset - see
        // populateSettingsInputs and resetSettingsPanel) needs it triggered explicitly.
        // Guarded on `network` (app.js) because nothing is laid out before a snapshot has
        // ever been loaded, and renderVisibleGraph would then throw on the still-null
        // nodesDataset and flash its "Computing layout..." overlay for nothing.
        if (typeof window.renderVisibleGraph === 'function' && network) window.renderVisibleGraph();
        window.setStatus("Settings saved.", "green");
    } else {
        // saveConfiguration already wrote a detailed reason to the map status note
        // (#mapStatusNote, visible regardless of which sidebar tab or center view is
        // active - see network_vis.html) - this is just the left-panel-local echo of "it
        // failed", not a duplicate of the reason itself. noMirror: true because
        // window.setStatus (utils.js) now mirrors any message to that same #mapStatusNote
        // whenever the Settings tab has #status-text hidden (which it always does here) -
        // without it, this generic redirect would overwrite the detailed reason above with
        // its own "see the status note" text, pointing at itself.
        window.setStatus("Settings not saved - see the status note for the error.", "red", { noMirror: true });
    }
};

// Resets the threshold + graph-layout fields only - the Juniper username/password are
// deliberately left alone (a "reset to defaults" has no business blanking a saved switch
// login). Nothing is written to Configuration.json.enc until Save is clicked.
window.resetSettingsPanel = function() {
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        var el = document.getElementById(settingInputId(key));
        if (el) el.value = DEFAULT_SETTINGS[key];
    });
    // Same programmatic-el.value-doesn't-fire-onchange problem as populateSettingsInputs
    // above - without this the layout inputs read as reset while the diagram keeps the
    // layout it was last built with.
    if (typeof window.renderVisibleGraph === 'function' && network) window.renderVisibleGraph();
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
// Cross-session per-device history, keyed by window.resolveDeviceIdentity (not DeviceIP, not
// client MAC) - same "recompute by re-walking every loaded snapshot, merge into whatever's
// already in localStorage" pattern as window.updateDeviceHistory, so loading more historical
// snapshots later only enriches this, never loses it. Reboot detection persists the same idea
// renderTrendChart already draws as a same-session-only marker (Uptime changing between
// snapshots), but kept across sessions here via a stored lastKnownUptime per device.
// Storage key bumped to _v2 (was DeviceIP-keyed under _v1) - the old entries are simply
// abandoned rather than merged under the new identity keys, so a renumbered device's
// pre-existing IP-keyed history doesn't silently mix into two different-shaped records.
var ALARM_HISTORY_STORAGE_KEY = 'ps_networkmapper_alarm_history_v2';

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
    var lastUptimeSeen = {}; // identity -> uptime string, scoped to this call only

    loadedSnapshots
        .filter(s => s.scanTimestamp)
        .slice()
        .sort((a, b) => new Date(a.scanTimestamp) - new Date(b.scanTimestamp))
        .forEach(snapshot => {
            var date = snapshot.scanTimestamp.slice(0, 10);
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

    saveAlarmHistory(history);
    return history;
};
