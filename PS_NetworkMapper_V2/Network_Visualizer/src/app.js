// App entry point: the global error handler, the core session state every other file in
// this app reads and mutates (network/globalTopologyData/loadedSnapshots/
// activeSnapshotIndex/searchIndex/deviceByIp/currentSelectedNodeData/etc. - declared once
// here since they're genuinely cross-cutting, not owned by any one feature), file loading
// (including the encrypted-file password flow), snapshot switching, and app-shell chrome
// (sidebar collapse/tabs). Everything else lives in its own file - see utils.js,
// topology-crypto.js, persistence.js, graph.js, dashboard.js, search.js, drawer.js - all
// classic scripts sharing this same global scope (see graph-layout.js's footer comment
// for why this app avoids ES modules), loaded via plain <script> tags in
// network_vis.html.

/**
 * Global Error Catcher
 */
// "ResizeObserver loop completed with undelivered notifications" (and the older Firefox
// wording "ResizeObserver loop limit exceeded") is a benign browser warning, not an
// application error - it fires whenever an observed element's size changes faster than
// the observer callback can keep up for one frame, which vis-network's internal
// ResizeObserver on #mynetwork does constantly during the left panel's CSS width
// transition (collapse/expand, or switching into/out of the wide Analysis Dashboard
// panel). Chromium dispatches it as a real `error` event on window, which is why it was
// reaching this handler and popping the fatal-error modal over the whole canvas on every
// panel toggle - the graph was still there underneath the whole time. Every major browser
// vendor and framework (Chrome DevTools itself, Next.js, Vite, etc.) explicitly ignores
// this exact message for the same reason: it never indicates a real bug.
var IGNORED_ERROR_MESSAGES = /ResizeObserver loop/;
window.onerror = function(message, source, lineno, colno, error) {
    if (IGNORED_ERROR_MESSAGES.test(message)) return true;

    var errText = `Message: ${message}<br>Line: ${lineno}:${colno}<br>Source: ${source}<br>Stack: ${error ? error.stack : 'N/A'}`;
    var textEl = document.getElementById('fatal-error-text');
    var modalEl = document.getElementById('fatal-error-modal');
    if (textEl && modalEl) {
        textEl.innerHTML = errText;
        modalEl.style.display = 'block';
    }
    if (typeof window.hideProgress === 'function') window.hideProgress();
    return true;
};

// Protect Globals
var network = null;
var globalTopologyData = [];
var nodesDataset = null;
var edgesDataset = null;
var allVlans = new Map();
var currentSelectedNodeData = null;
var searchHighlightQuery = "";

// Multi-snapshot state. loadedSnapshots holds every snapshot from the most recent
// "Render Topology" / "Load Folder" action; activeSnapshotIndex picks which one drives
// the graph/drawer view (globalTopologyData/deviceByIp always mirror it - see
// window.setActiveSnapshot). Search spans every loaded snapshot regardless of which is
// active (see search.js's buildSearchIndex) - only the rendered graph is single-snapshot.
var loadedSnapshots = [];   // {sourceFile, scanTimestamp, topology, deviceByIp}[]
var activeSnapshotIndex = -1;
// Which sidebar tab (Load File / Search / Settings / Analysis Dashboard) is showing -
// see window.switchSidebarTab. Used so a file load can refresh the Analysis Dashboard
// live when it's already the visible tab, instead of only on tab-switch.
var activeSidebarTab = 'sidebar-tab-load';
// Which center-panel view (Diagram / Map) is showing - see window.switchCenterView in
// map.js. Same cross-cutting UI-mode pattern as activeSidebarTab above.
var activeCenterView = 'diagram';

// Search index (see search.js's window.buildSearchIndex / window.performGlobalSearch) -
// built once per file load instead of re-scanning every device's nested StackMembers/
// TrueClients arrays (and re-lowercasing every field) on every search. deviceByIp turns
// the O(devices) linear scan every drawer open used to do into an O(1) lookup. deviceByIp
// itself is reassigned (not rebuilt) to whichever loadedSnapshots[i].deviceByIp is
// currently active - openRightDrawer/search click-through for the active snapshot need no
// changes for that.
var searchIndex = [];   // {deviceIp, snapshotIndex, field, value, valueLower}[]
var deviceByIp = new Map();

// Switches which loaded snapshot drives the graph/drawer view. Search always spans every
// loaded snapshot no matter which is active (see search.js's buildSearchIndex) - this only
// changes what's rendered as the topology graph and what deviceByIp/openRightDrawer
// resolve against, by reassigning the reference rather than rebuilding anything.
window.setActiveSnapshot = async function(index) {
    if (!loadedSnapshots[index]) return;
    activeSnapshotIndex = index;
    var snapshot = loadedSnapshots[index];

    globalTopologyData = snapshot.topology;
    deviceByIp = snapshot.deviceByIp;

    window.closeDrawer();
    window.renderCrawlAge(snapshot.scanTimestamp);
    window.extractVlans();
    await window.buildSwitchMap();

    var switcher = document.getElementById('snapshotSwitcher');
    if (switcher) switcher.value = String(index);

    // The map view (map.js) has its own rendering of this same topology data - without
    // this, switching snapshots only ever rebuilt the diagram, so a Map view opened before
    // this switch (or before any snapshot was ever loaded) would keep showing whatever it
    // showed last, silently, for the rest of the session. renderMapMarkers is a no-op if
    // Map view has never been initialized this session (see its own leafletMap===null
    // guard), and re-renders in place (no camera reset) if it has.
    window.renderMapMarkers();
};

// Shows the snapshot picker only when more than one snapshot is loaded - for the common
// single-file case this stays hidden and nothing about the UI changes from before
// multi-snapshot loading existed.
window.renderSnapshotSwitcher = function() {
    var container = document.getElementById('snapshotSwitcherContainer');
    var select = document.getElementById('snapshotSwitcher');
    if (!container || !select) return;

    if (loadedSnapshots.length <= 1) {
        container.style.display = 'none';
        return;
    }

    select.innerHTML = loadedSnapshots.map((s, idx) => {
        var label = s.scanTimestamp ? new Date(s.scanTimestamp).toLocaleString() : `${s.sourceFile} (no timestamp)`;
        return `<option value="${idx}">${esc(label)}</option>`;
    }).join('');
    container.style.display = 'block';
};

window.onSnapshotSwitcherChange = function() {
    var select = document.getElementById('snapshotSwitcher');
    var idx = parseInt(select.value, 10);
    if (Number.isFinite(idx)) window.setActiveSnapshot(idx);
};

// Promise-based password prompt for the #password-modal in network_vis.html. Resolves
// with the entered password on Unlock/Enter, rejects with Error('Cancelled') on
// Cancel/Escape so callers can tell a deliberate cancel apart from a real failure.
window.promptForPassword = function(errorMsg) {
    return new Promise((resolve, reject) => {
        var modal = document.getElementById('password-modal');
        var input = document.getElementById('password-input');
        var errEl = document.getElementById('password-error');
        var unlockBtn = document.getElementById('password-unlock-btn');
        var cancelBtn = document.getElementById('password-cancel-btn');

        errEl.textContent = errorMsg || '';
        errEl.style.display = errorMsg ? 'block' : 'none';
        input.value = '';
        modal.style.display = 'flex';
        input.focus();

        function cleanup() {
            modal.style.display = 'none';
            unlockBtn.removeEventListener('click', onUnlock);
            cancelBtn.removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onKeydown);
        }
        function onUnlock() {
            // Capture before clearing - cleanup() only hides the modal, this drops the
            // password out of the DOM the moment it's no longer needed there.
            var value = input.value;
            input.value = '';
            cleanup();
            resolve(value);
        }
        function onCancel() { cleanup(); reject(new Error('Cancelled')); }
        function onKeydown(e) {
            if (e.key === 'Enter') onUnlock();
            if (e.key === 'Escape') onCancel();
        }

        unlockBtn.addEventListener('click', onUnlock);
        cancelBtn.addEventListener('click', onCancel);
        input.addEventListener('keydown', onKeydown);
    });
};

// Start-NetworkMapper.ps1 already prompted for this exact password at the console and now
// hands it to the browser via GET /api/session-password (Start-WebServer.ps1), so
// readSnapshotFile (below) and map.js's loadMapConfiguration can both skip the password
// modal on the common path instead of asking the operator to re-type a password they just
// typed - it's the same one password for the whole session (see that script's "Network_
// Visualizer will prompt for this same password" comment). Cached/in-flight-deduped the
// same way map.js's ensureConfigLoaded dedupes its own fetch - loading several encrypted
// files, or a file load racing the Settings tab's own Configuration.json.enc fetch, only
// ever hits the endpoint once. Resolves to '' (never rejects) when the server has nothing to
// offer - a server-only launch with no Configuration.json.enc yet, or the "continue without
// credentials" startup path where the typed password was proven wrong - so every caller can
// treat a falsy result as "fall back to promptForPassword", exactly as before this existed.
var sessionPasswordPromise = null;
window.getSessionEncryptionPassword = function() {
    if (!sessionPasswordPromise) {
        sessionPasswordPromise = fetch('/api/session-password')
            .then(resp => resp.ok ? resp.json() : { password: '' })
            .then(json => json.password || '')
            .catch(() => '');
    }
    return sessionPasswordPromise;
};

window.toggleLeftPanel = function(e) {
    if (e) e.stopPropagation();
    document.getElementById('left-panel').classList.toggle('collapsed');
};

// Sidebar tabs (Load File / Search / Settings / Analysis Dashboard). Panes stay in the
// DOM when hidden (display:none, not removed), so getElementById-based reads elsewhere
// (getClusterThreshold, getLayoutSettings) work regardless of which tab is active. The
// Analysis Dashboard tab widens the panel (.wide-panel) since its tables/charts don't fit
// in the 320px other tabs use - vis-network's own container-size polling picks up the
// resulting #mynetwork resize the same way it already does for panel collapse/expand.
window.switchSidebarTab = async function(tabId) {
    document.querySelectorAll('.sidebar-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.sidebar-tab').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    document.getElementById('left-panel').classList.toggle('wide-panel', tabId === 'sidebar-tab-analysis');
    activeSidebarTab = tabId;

    if (tabId === 'sidebar-tab-settings') {
        // Immediate paint with whatever's already known (defaults, or an earlier load this
        // session), then widen the config-load trigger to fire here too (previously only
        // Map view did) - both surfaces share the same ensureConfigLoaded gate (map.js), so
        // the password prompt and fetch only ever happen once per session regardless of
        // which one the user opens first.
        window.populateSettingsInputs();
        await window.ensureConfigLoaded();
        window.populateSettingsInputs();
    }
    if (tabId === 'sidebar-tab-analysis') window.refreshAnalysisDashboard();
};

// 1. File Loading & Parsing

// Reads and (if needed) decrypts one File into a {sourceFile, scanTimestamp, topology}
// snapshot record. Shared by forceLoadFile and forceLoadFolder so there's exactly one
// place that knows the on-disk format, instead of two copies drifting apart over time.
function readSnapshotFile(file) {
    return new Promise((resolve, reject) => {
        var reader = new FileReader();
        reader.onerror = () => reject(new Error(`Browser blocked read access to "${file.name}".`));

        reader.onload = async (e) => {
            try {
                var data = JSON.parse(e.target.result);

                if (data && data.format === 'PSNetworkMapper-EncryptedTopology') {
                    var decryptedText = null;
                    var errorMsg = null;
                    // Try the session password (see window.getSessionEncryptionPassword) once,
                    // silently, before ever showing the modal - it's the same password
                    // Start-NetworkMapper.ps1 encrypted this file with in the first place. Only
                    // falls through to promptForPassword if that's unavailable/empty, or (rare -
                    // e.g. this file was manually re-encrypted under a different password) it
                    // fails to decrypt.
                    var sessionPassword = await window.getSessionEncryptionPassword();
                    var triedSessionPassword = false;
                    while (decryptedText === null) {
                        var password;
                        if (sessionPassword && !triedSessionPassword) {
                            password = sessionPassword;
                            triedSessionPassword = true;
                        } else {
                            password = await window.promptForPassword(errorMsg); // rejects on Cancel
                        }
                        try {
                            decryptedText = await window.TopologyCrypto.decryptEnvelope(data, password);
                        } catch (decErr) {
                            errorMsg = decErr.message;
                        }
                    }
                    data = JSON.parse(decryptedText);
                }

                if (!data.Topology) throw new Error(`"${file.name}": missing 'Topology' array.`);

                // Clients arrive pre-correlated (MAC table + cross-device ARP enrichment
                // done server-side by Start-NetworkMapper.ps1); the visualizer just displays them.
                data.Topology.forEach(device => { device.TrueClients = device.Clients || []; });

                resolve({ sourceFile: file.name, scanTimestamp: data.ScanTimestamp || null, topology: data.Topology });
            } catch (err) {
                reject(err);
            }
        };

        reader.readAsText(file);
    });
}

window.forceLoadFile = async function() {
    var input = document.getElementById('jsonUpload');
    if (!input.files || input.files.length === 0) {
        window.setStatus("Please select one or more JSON file(s).", "red");
        return;
    }
    await window.processSelectedFiles(Array.from(input.files));
};

window.forceLoadFolder = async function() {
    var input = document.getElementById('jsonUploadFolder');
    if (!input.files || input.files.length === 0) {
        window.setStatus("Please select a folder.", "red");
        return;
    }
    // A folder picker returns EVERY file in the directory, not just snapshots - the
    // PS_NetworkMapper root also holds Auth.json (real switch credentials, not a
    // topology file, but it does end in ".json" so a looser filter would try to load it
    // and fail confusingly). Match the actual naming convention Start-NetworkMapper.ps1
    // writes ("NetworkMap_<timestamp>.json[.enc]") instead of any file ending in .json,
    // and explicitly exclude its in-progress ".tmp.json(.enc)" files (picking the folder
    // mid-crawl would otherwise load a partial snapshot as if it were a finished one).
    var files = Array.from(input.files).filter(f =>
        /^NetworkMap_.*\.json(\.enc)?$/i.test(f.name) && !/\.tmp\.json(\.enc)?$/i.test(f.name)
    );
    if (files.length === 0) {
        window.setStatus("No NetworkMap_*.json(.enc) files found in that folder.", "red");
        return;
    }
    await window.processSelectedFiles(files);
};

// Shared by forceLoadFile and forceLoadFolder - the only place that turns a list of File
// objects into loadedSnapshots plus the active graph/search state.
window.processSelectedFiles = async function(files) {
    var btn = document.getElementById('loadBtn');
    var folderBtn = document.getElementById('loadFolderBtn');
    btn.disabled = true;
    if (folderBtn) folderBtn.disabled = true;
    window.closeDrawer();
    // Same "reset any open per-device UI before swapping the underlying data" reasoning as
    // closeDrawer above. This function reassigns loadedSnapshots/deviceByIp wholesale (a
    // manual load, a folder load, or the synthesized file scan-network.js feeds in after a
    // completed scan), and the map's location editor stays fully usable while that happens -
    // its backdrop is pointer-events:none, so the sidebar is still clickable with the editor
    // open. Left open, its editorTargetIp would then point into data that no longer exists.
    // Unguarded like the window.renderMapMarkers() call in setActiveSnapshot above:
    // network_vis.html loads map.js before app.js, and closeLocationEditor itself tolerates
    // Map view never having been opened (leafletMap === null).
    window.closeLocationEditor();

    var newSnapshots = [];
    var skipped = []; // {name, reason}[] - only used/reported for multi-file batches
    var parseSucceeded = false;
    // Single file keeps the exact original behavior: any failure (bad JSON, wrong
    // format, decrypt cancelled) aborts the whole load with no data shown - unchanged
    // from before multi-file loading existed. A multi-file/folder batch is more
    // forgiving: one bad or cancelled file (e.g. a folder picker sweeping up something
    // that isn't actually a snapshot) shouldn't throw away every other file already read.
    var tolerateFailures = files.length > 1;

    try {
        for (var i = 0; i < files.length; i++) {
            window.setStatus(`Reading file ${i + 1} of ${files.length}: ${files[i].name}...`, "orange");
            window.showProgress(`Reading ${files[i].name}...`, Math.round((i / files.length) * 100));
            await new Promise(r => setTimeout(r, 20)); // let the progress update actually paint

            if (tolerateFailures) {
                try {
                    newSnapshots.push(await readSnapshotFile(files[i]));
                } catch (fileErr) {
                    skipped.push({ name: files[i].name, reason: fileErr.message });
                }
            } else {
                newSnapshots.push(await readSnapshotFile(files[i]));
            }
        }

        if (newSnapshots.length === 0) {
            window.setStatus(`No usable snapshots found (${skipped.length} file(s) skipped - see console).`, "red");
            skipped.forEach(s => console.warn(`Skipped "${s.name}": ${s.reason}`));
            return;
        }
        parseSucceeded = true;

        loadedSnapshots = newSnapshots;
        window.showProgress("Indexing search data...", 100, true);
        await nextPaint();
        window.buildSearchIndex();

        // Active = most recently captured snapshot. Files with no ScanTimestamp (they
        // predate that field) fall back to selection order, preferring later ones, so a
        // mixed batch still lands on something reasonable instead of an arbitrary pick.
        var bestIndex = 0, bestTime = -Infinity;
        loadedSnapshots.forEach((s, idx) => {
            var t = s.scanTimestamp ? new Date(s.scanTimestamp).getTime() : NaN;
            var effectiveTime = Number.isFinite(t) ? t : idx;
            if (effectiveTime >= bestTime) { bestTime = effectiveTime; bestIndex = idx; }
        });

        window.renderSnapshotSwitcher();
        window.updateDeviceHistory();
        // Analysis Dashboard is a permanent tab now (not a button gated on having a
        // snapshot loaded - its own empty states handle "nothing loaded yet"). If it's
        // already the visible tab, refresh it now instead of leaving it stale until the
        // user clicks away and back.
        if (activeSidebarTab === 'sidebar-tab-analysis') window.refreshAnalysisDashboard();
        window.showProgress("Rendering Topology...", 100, true);
        await nextPaint();
        await window.setActiveSnapshot(bestIndex);

        document.getElementById('legend-group').style.display = 'block';
        var totalDevices = loadedSnapshots.reduce((sum, s) => sum + s.topology.length, 0);
        var skippedNote = skipped.length > 0 ? ` (${skipped.length} file(s) skipped - see console)` : '';
        if (skipped.length > 0) skipped.forEach(s => console.warn(`Skipped "${s.name}": ${s.reason}`));
        window.setStatus(
            loadedSnapshots.length > 1
                ? `Success! Loaded ${loadedSnapshots.length} snapshots (${totalDevices} device-records total)${skippedNote}. Viewing: ${loadedSnapshots[bestIndex].scanTimestamp ? new Date(loadedSnapshots[bestIndex].scanTimestamp).toLocaleString() : loadedSnapshots[bestIndex].sourceFile}.`
                : `Success! Mapped ${globalTopologyData.length} nodes.`,
            "green"
        );
    } catch (err) {
        if (err && err.message === 'Cancelled') {
            window.setStatus("Decryption cancelled.", "orange");
        } else {
            window.setStatus(parseSucceeded ? "Render error - see details." : "JSON Parse Error.", "red");
            throw err;
        }
    } finally {
        window.hideProgress();
        btn.disabled = false;
        if (folderBtn) folderBtn.disabled = false;
    }
};
