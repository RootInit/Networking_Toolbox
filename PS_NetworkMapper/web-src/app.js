// App entry point: global error handler, core cross-cutting session state, file loading
// (incl. encrypted-file password flow), snapshot switching, and app-shell chrome.
// Other features live in utils.js, topology-crypto.js, persistence.js, graph.js,
// dashboard.js, search.js, drawer.js - all classic scripts sharing this global scope,
// loaded via <script> tags in network_vis.html.

/**
 * Global Error Catcher
 */
// "ResizeObserver loop completed/limit exceeded" is a benign browser warning, not a real
// error - vis-network's ResizeObserver on #mynetwork triggers it during panel CSS width
// transitions, and Chromium dispatches it as a window `error` event, which was popping
// the fatal-error modal over the graph on every panel toggle. Ignore it, like every major
// browser/framework does.
var IGNORED_ERROR_MESSAGES = /ResizeObserver loop/;
window.onerror = function(message, source, lineno, colno, error) {
    if (IGNORED_ERROR_MESSAGES.test(message)) return true;

    // textContent (not innerHTML) - message/source/stack can embed untrusted text (e.g. a
    // future Error thrown with a device/file-supplied string), matching the esc()/textContent
    // convention used for every other error-rendering sink in the app. white-space: pre-line
    // (index.html) turns the \n separators below into the same line-per-field layout the old
    // <br>-joined innerHTML gave.
    var errText = `Message: ${message}\nLine: ${lineno}:${colno}\nSource: ${source}\nStack: ${error ? error.stack : 'N/A'}`;
    var textEl = document.getElementById('fatal-error-text');
    var modalEl = document.getElementById('fatal-error-modal');
    if (textEl && modalEl) {
        textEl.textContent = errText;
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
// the graph/drawer view (globalTopologyData/deviceByIp mirror it - see setActiveSnapshot).
// Search spans every loaded snapshot regardless of which is active; only the rendered
// graph is single-snapshot.
var loadedSnapshots = [];   // {sourceFile, scanTimestamp, topology, deviceByIp}[]
var activeSnapshotIndex = -1;

// Guards window.processSelectedFiles against two independent triggers overlapping - a
// manual Load Folder/File click and a Scan Network completion both funnel through it, and
// each only disabled its own button, so nothing stopped one from starting mid-flight of the
// other. Same "claim a generation, bail if superseded" pattern as search.js's
// goToSearchResultGeneration, applied here so a slower call can't clobber loadedSnapshots/
// activeSnapshotIndex/deviceByIp with stale data (or report a misleading "Success") after a
// newer call already replaced them.
var loadFilesGeneration = 0;
// Which sidebar tab is showing (see window.switchSidebarTab).
var activeSidebarTab = 'sidebar-tab-load';
// Which center-panel view (Diagram / Map) is showing - see map.js's switchCenterView.
var activeCenterView = 'diagram';

// Search index, built once per file load rather than re-scanning every device on every
// search (see search.js). deviceByIp gives O(1) drawer lookups and is reassigned (not
// rebuilt) to whichever loadedSnapshots[i].deviceByIp is currently active.
var searchIndex = [];   // {deviceIp, snapshotIndex, field, value, valueLower}[]
var deviceByIp = new Map();

// Switches which loaded snapshot drives the graph/drawer view (search still spans all
// loaded snapshots regardless).
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

    // Map view (map.js) renders this same topology separately, so it needs its own
    // refresh on snapshot switch. No-op if Map view was never opened (leafletMap===null).
    window.renderMapMarkers();

    // Analysis Dashboard also renders this same topology separately (Fleet Health, New
    // Devices, Trend Chart, etc. - see dashboard.js). Its container elements exist in the
    // DOM regardless of which centre view is showing (map.js's switchCenterView just toggles
    // display), so the guards inside those render functions don't skip real work when it's
    // hidden - only refresh here if Analysis is the view actually showing. switchCenterView
    // already refreshes on activation, so a hidden dashboard is still fresh the instant the
    // user opens it.
    if (activeCenterView === 'analysis') window.refreshAnalysisDashboard();
};

// Shows the snapshot picker only when more than one snapshot is loaded.
window.renderSnapshotSwitcher = function() {
    var container = document.getElementById('snapshotSwitcherContainer');
    var select = document.getElementById('snapshotSwitcher');
    if (!container || !select) return;

    if (loadedSnapshots.length <= 1) {
        container.style.display = 'none';
        return;
    }

    select.innerHTML = loadedSnapshots.map((s, idx) => {
        var tsMs = window.parseTimestampMs(s.scanTimestamp);
        var label = tsMs !== null ? new Date(tsMs).toLocaleString('en-US') : `${s.sourceFile} (no timestamp)`;
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
            // Capture before clearing - drops the password out of the DOM immediately.
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

// Start-NetworkMapper.ps1 already prompted for this password at the console and hands it
// to the browser via GET /api/session-password, so callers can skip re-prompting on the
// common path. Cached/in-flight-deduped so multiple encrypted-file loads only hit the
// endpoint once. Resolves to '' (never rejects) when the server has nothing to offer, so
// callers can treat a falsy result as "fall back to promptForPassword".
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


// Drag-resize for #side-panel. vis-network picks up the resulting #center-panel resize
// on its own, but Leaflet does not self-observe its container, so Map view needs an
// explicit invalidateSize() call while dragging or its tiles freeze at the pre-drag size.
// Clamps a candidate side-panel width the same way for a live drag, a keyboard nudge, and
// a restore-on-load - min never exceeds the viewport-relative max (responsive-1/3).
function clampSidePanelWidth(width) {
    var maxWidth = window.innerWidth * 0.9;
    var minWidth = Math.min(320, maxWidth);
    return Math.max(minWidth, Math.min(maxWidth, width));
}

window.startSidePanelResize = function(e) {
    if (e.isPrimary === false) return; // ignore a second simultaneous touch
    e.preventDefault();
    var panel = document.getElementById('side-panel');
    var handle = document.getElementById('side-panel-handle');
    var startX = e.clientX;
    var startWidth = panel.getBoundingClientRect().width;
    document.body.classList.add('resizing-side-panel');
    handle.classList.add('dragging');

    function onMove(moveEvent) {
        // Dragging the right edge of a left-docked panel: rightward movement grows it.
        var dx = moveEvent.clientX - startX;
        panel.style.width = clampSidePanelWidth(startWidth + dx) + 'px';

        if (activeCenterView === 'map' && window.leafletMap) window.leafletMap.invalidateSize();
    }

    function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('resizing-side-panel');
        handle.classList.remove('dragging');
        if (typeof window.resizeDiagram === 'function') window.resizeDiagram();
        if (activeCenterView === 'map' && window.leafletMap) window.leafletMap.invalidateSize();
        try { localStorage.setItem('sidePanelWidth', String(panel.getBoundingClientRect().width)); } catch (err) {}
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
};

// Arrow-key alternative to dragging #side-panel-handle (a11y-3) - same clamp as a drag.
window.sidePanelHandleKeydown = function(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    var panel = document.getElementById('side-panel');
    var step = e.key === 'ArrowRight' ? 20 : -20;
    var newWidth = clampSidePanelWidth(panel.getBoundingClientRect().width + step);
    panel.style.width = newWidth + 'px';
    if (activeCenterView === 'map' && window.leafletMap) window.leafletMap.invalidateSize();
    if (typeof window.resizeDiagram === 'function') window.resizeDiagram();
    try { localStorage.setItem('sidePanelWidth', String(newWidth)); } catch (err) {}
};

// Drag the divider between the tool pane (Load File / Search / Settings) and the device
// area. Until dragged, the pane sizes to its content (capped by CSS); after the first drag it
// holds the dragged height (#tool-panel.sized) and remembers it across reloads.
window.startToolPanelResize = function(e) {
    if (e.isPrimary === false) return; // ignore a second simultaneous touch
    e.preventDefault();
    var pane = document.getElementById('tool-panel');
    var divider = document.getElementById('tool-divider');
    var startY = e.clientY;
    var startHeight = pane.getBoundingClientRect().height;
    document.body.classList.add('resizing-tool-panel');
    divider.classList.add('dragging');

    function onMove(moveEvent) {
        var panelHeight = document.getElementById('side-panel').getBoundingClientRect().height;
        var newHeight = Math.max(0, Math.min(panelHeight - 160, startHeight + (moveEvent.clientY - startY)));
        pane.classList.add('sized');
        pane.style.height = newHeight + 'px';
    }
    function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('resizing-tool-panel');
        divider.classList.remove('dragging');
        try { localStorage.setItem('toolPanelHeight', String(pane.getBoundingClientRect().height)); } catch (err) {}
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
};

// Arrow-key alternative to dragging #tool-divider (a11y-3) - same clamp as a drag.
window.toolDividerKeydown = function(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    var pane = document.getElementById('tool-panel');
    var panelHeight = document.getElementById('side-panel').getBoundingClientRect().height;
    var step = e.key === 'ArrowDown' ? 20 : -20;
    var newHeight = Math.max(0, Math.min(panelHeight - 160, pane.getBoundingClientRect().height + step));
    pane.classList.add('sized');
    pane.style.height = newHeight + 'px';
    try { localStorage.setItem('toolPanelHeight', String(newHeight)); } catch (err) {}
};

(function restoreToolPanelHeight() {
    try {
        var saved = parseFloat(localStorage.getItem('toolPanelHeight'));
        if (Number.isFinite(saved) && saved >= 0) {
            var pane = document.getElementById('tool-panel');
            pane.classList.add('sized');
            pane.style.height = Math.min(saved, window.innerHeight - 160) + 'px';
        }
    } catch (err) {}
})();

// Restores a previously dragged width on load - a display preference, not part of
// Configuration.json's saved state, so a plain localStorage read.
(function restoreSidePanelWidth() {
    try {
        var saved = parseFloat(localStorage.getItem('sidePanelWidth'));
        if (Number.isFinite(saved) && saved >= 280) {
            document.getElementById('side-panel').style.width = clampSidePanelWidth(saved) + 'px';
        }
    } catch (err) {}
})();

// Browser-window resize: vis-network picks this up via its own ResizeObserver, but
// Leaflet doesn't self-observe, so Map view needs an explicit invalidateSize(). Debounced
// since 'resize' fires continuously during an active drag.
var windowResizeDebounce = null;
window.addEventListener('resize', function() {
    // Re-clamp #side-panel immediately (not debounced) so a width saved on a wider
    // viewport can't force overflow on a shrunk one (responsive-3).
    var panel = document.getElementById('side-panel');
    var currentWidth = panel.getBoundingClientRect().width;
    var clamped = clampSidePanelWidth(currentWidth);
    if (clamped !== currentWidth) panel.style.width = clamped + 'px';

    clearTimeout(windowResizeDebounce);
    windowResizeDebounce = setTimeout(function() {
        if (activeCenterView === 'map' && window.leafletMap) window.leafletMap.invalidateSize();
    }, 150);
});

// Tool tabs at the top of the left-docked side panel (Load File / Search / Settings). Panes stay in the DOM when hidden (display:none, not removed), so
// getElementById-based reads elsewhere (getClusterThreshold, getLayoutSettings) work
// regardless of which tab is active. (The Analysis Dashboard is a centre view, not a
// sidebar tab - see map.js's switchCenterView.)
window.switchSidebarTab = async function(tabId) {
    document.querySelectorAll('.sidebar-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('#tool-tabs .tab').forEach(el => { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); });
    document.getElementById(tabId).classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    document.getElementById('btn-' + tabId).setAttribute('aria-selected', 'true');
    activeSidebarTab = tabId;

    if (tabId === 'sidebar-tab-settings') {
        // Immediate paint with whatever's already known, then load config (shares
        // map.js's ensureConfigLoaded gate, so the fetch/password-prompt happens once
        // per session regardless of which surface opens it first).
        window.populateSettingsInputs();
        await window.ensureConfigLoaded();
        window.populateSettingsInputs();
    }
};

// 1. File Loading & Parsing

// Reads and (if needed) decrypts one File into a {sourceFile, scanTimestamp, topology}
// snapshot record. Shared by forceLoadFile and forceLoadFolder.
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
                    // Try the session password silently first; only fall through to
                    // promptForPassword if it's unavailable or fails to decrypt.
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

                // Clients arrive pre-correlated server-side; the visualizer just displays them.
                data.Topology.forEach(device => { device.TrueClients = window.asArray(device.Clients); });

                resolve({ sourceFile: file.name, scanTimestamp: data.ScanTimestamp || null, topology: data.Topology });
            } catch (err) {
                reject(err);
            }
        };

        // Explicit UTF-8 - platform default guess would mis-decode non-ASCII hostnames/notes.
        reader.readAsText(file, 'UTF-8');
    });
}

// Startup autoload: fetches every archived snapshot from /api/snapshots and feeds them
// through the same path a manual "Load Folder" pick uses, so the last scan is on screen
// without a file-picker gesture. Silently does nothing (leaves manual load available) if
// there's nothing to load, the fetch fails, or snapshots are encrypted but no session
// password is cached yet - a surprise password prompt on page load would be worse than
// just requiring one manual load in that case.
window.autoloadLastScan = async function() {
    if (loadedSnapshots.length > 0) return; // already loaded by something else
    // Snapshotted before any `await` below - if a manual Load/Scan Network starts (bumps
    // this) or finishes (populates loadedSnapshots) while this function is still awaiting,
    // the re-check right before processSelectedFiles bails instead of clobbering it. A plain
    // "loadedSnapshots.length > 0" re-check alone wouldn't catch a call that's in-flight but
    // hasn't populated loadedSnapshots yet.
    var myGenerationAtStart = loadFilesGeneration;

    var entries;
    try {
        var resp = await fetch('/api/snapshots');
        if (!resp.ok) return;
        entries = (await resp.json()).snapshots;
    } catch (err) {
        return;
    }
    if (!Array.isArray(entries) || entries.length === 0) return;

    var encryptedEntries = entries.filter(e => {
        try { return JSON.parse(e.content).format === 'PSNetworkMapper-EncryptedTopology'; }
        catch (err) { return false; }
    });
    if (encryptedEntries.length > 0) {
        var sessionPassword = await window.getSessionEncryptionPassword();
        if (!sessionPassword) return;
        // Not just "a password is cached" - it must actually decrypt, or processSelectedFiles
        // would fall through to promptForPassword, exactly the surprise prompt this is meant
        // to avoid. Only the first encrypted entry is checked: they're all written by the same
        // running server with the same session password, so one failure means they all would.
        try {
            await window.TopologyCrypto.decryptEnvelope(JSON.parse(encryptedEntries[0].content), sessionPassword);
        } catch (err) {
            return;
        }
    }

    if (loadFilesGeneration !== myGenerationAtStart || loadedSnapshots.length > 0) return;
    var files = entries.map(e => new File([e.content], e.name, { type: 'application/json' }));
    // This is a silent background autoload, not a user-initiated action - a single corrupt/
    // malformed archived snapshot must not surface the fatal red error state (processSelectedFiles
    // re-throws once files.length === 1, since tolerateFailures only kicks in for multi-file
    // batches). Swallow and log instead, matching every other documented failure mode above
    // (nothing to load, fetch fails, encrypted-with-no-cached-password) which already fail silently.
    try {
        await window.processSelectedFiles(files);
    } catch (err) {
        console.warn('Autoload of the last scan failed - leaving manual load available.', err);
    }
};

document.addEventListener('DOMContentLoaded', async function() {
    // Reattach first, and AWAIT it before autoloading (P2SCAN-001): if a scan is already
    // running server-side (e.g. this tab was refreshed mid-crawl), autoloadLastScan would
    // otherwise race it and load the previous archived snapshot over the live poll, showing
    // a false "Success!" and stale topology for the remainder of the scan. If resumeScanIfInProgress
    // reattaches to a running scan, skip autoloadLastScan entirely - the completing scan will
    // load its own result via pollRunningScan's own processSelectedFiles call.
    var resumed = false;
    if (typeof window.resumeScanIfInProgress === 'function') resumed = await window.resumeScanIfInProgress().catch(function() { return false; });
    if (!resumed) window.autoloadLastScan();
});

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
    // A folder picker returns every file in the directory - filter to the actual
    // NetworkMap_<timestamp>.json[.enc] naming convention, excluding in-progress
    // .tmp.json(.enc) files that a mid-crawl folder pick could otherwise load as finished.
    var files = Array.from(input.files).filter(f =>
        /^NetworkMap_.*\.json(\.enc)?$/i.test(f.name) && !/\.tmp\.json(\.enc)?$/i.test(f.name)
    );
    if (files.length === 0) {
        window.setStatus("No NetworkMap_*.json(.enc) files found in that folder.", "red");
        return;
    }
    await window.processSelectedFiles(files);
};

// Shared by forceLoadFile and forceLoadFolder - turns a list of File objects into
// loadedSnapshots plus the active graph/search state.
window.processSelectedFiles = async function(files) {
    var myGeneration = ++loadFilesGeneration;
    var btn = document.getElementById('loadBtn');
    var folderBtn = document.getElementById('loadFolderBtn');
    // Also locked out here (rather than only by its own click handler) so a Scan Network
    // run in progress can't have its eventual processSelectedFiles call race this one - see
    // loadFilesGeneration's comment.
    var scanBtn = document.getElementById('scanNetworkBtn');
    btn.disabled = true;
    if (folderBtn) folderBtn.disabled = true;
    if (scanBtn) scanBtn.disabled = true;
    window.closeDrawer();
    // Reset the map's location editor too, before loadedSnapshots/deviceByIp are reassigned
    // wholesale - left open, its editorTargetIp would point into data that no longer exists.
    window.closeLocationEditor();
    // A rescan poll in flight would otherwise eventually splice its result into whichever
    // snapshot occupies its captured array slot once loadedSnapshots is replaced below -
    // mergeRescannedDevice's own targetSnapshot check catches that too, but there's no
    // reason to let a now-pointless poll keep running.
    if (window.cancelPendingRescan) window.cancelPendingRescan();
    // Same reasoning for an in-flight ping poll - its result would otherwise paint under
    // whichever device now occupies the drawer once loadedSnapshots is replaced below.
    if (window.cancelPendingPing) window.cancelPendingPing();

    var newSnapshots = [];
    var skipped = []; // {name, reason}[] - only used/reported for multi-file batches
    var parseSucceeded = false;
    // Single file: any failure aborts the whole load with no data shown. A multi-file/
    // folder batch is more forgiving - one bad file shouldn't discard the rest.
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
                    // A cancelled password prompt aborts the whole batch rather than being
                    // treated as "this one file is bad" - otherwise Cancel on file 1 of a
                    // folder of encrypted files just re-prompts for file 2, file 3, ...,
                    // forcing the user to dismiss the modal once per remaining file to
                    // actually stop the load.
                    if (fileErr && fileErr.message === 'Cancelled') throw fileErr;
                    skipped.push({ name: files[i].name, reason: fileErr.message });
                }
            } else {
                newSnapshots.push(await readSnapshotFile(files[i]));
            }
            if (myGeneration !== loadFilesGeneration) return; // superseded mid-read
        }

        if (newSnapshots.length === 0) {
            window.setStatus(`No usable snapshots found (${skipped.length} file(s) skipped - see console).`, "red");
            skipped.forEach(s => console.warn(`Skipped "${s.name}": ${s.reason}`));
            return;
        }
        parseSucceeded = true;

        if (myGeneration !== loadFilesGeneration) return; // superseded while reading files
        loadedSnapshots = newSnapshots;
        // A previously-rendered search result row carries an onclick closure over the OLD
        // loadedSnapshots/deviceByIp - once those are replaced, that row can reopen a drawer
        // for a device that no longer exists, or (worse) one that now resolves to a
        // different, unrelated device at the same IP. Clear the search UI state alongside
        // the data it was built from.
        var searchResultsEl = document.getElementById('searchResults');
        if (searchResultsEl) searchResultsEl.innerHTML = '';
        var globalSearchEl = document.getElementById('globalSearch');
        if (globalSearchEl) globalSearchEl.value = '';
        searchHighlightQuery = ""; // matches its declared default above
        window.showProgress("Indexing search data...", 100, true);
        await nextPaint();
        if (myGeneration !== loadFilesGeneration) return;
        window.buildSearchIndex();

        // Active = most recently captured snapshot. Files with no ScanTimestamp fall back
        // to selection order, preferring later ones.
        var bestIndex = 0, bestTime = -Infinity;
        loadedSnapshots.forEach((s, idx) => {
            var t = window.parseTimestampMs(s.scanTimestamp);
            var effectiveTime = t !== null ? t : idx;
            if (effectiveTime >= bestTime) { bestTime = effectiveTime; bestIndex = idx; }
        });

        window.renderSnapshotSwitcher();
        window.updateDeviceHistory();
        window.showProgress("Rendering Topology...", 100, true);
        await nextPaint();
        if (myGeneration !== loadFilesGeneration) return;
        await window.setActiveSnapshot(bestIndex);
        if (myGeneration !== loadFilesGeneration) return; // a newer load reassigned loadedSnapshots while this awaited

        document.getElementById('legend-group').style.display = 'block';
        var totalDevices = loadedSnapshots.reduce((sum, s) => sum + s.topology.length, 0);
        var skippedNote = skipped.length > 0 ? ` (${skipped.length} file(s) skipped - see console)` : '';
        if (skipped.length > 0) skipped.forEach(s => console.warn(`Skipped "${s.name}": ${s.reason}`));
        var bestSnapTs = window.parseTimestampMs(loadedSnapshots[bestIndex].scanTimestamp);
        window.setStatus(
            loadedSnapshots.length > 1
                ? `Success! Loaded ${loadedSnapshots.length} snapshots (${totalDevices} device-records total)${skippedNote}. Viewing: ${bestSnapTs !== null ? new Date(bestSnapTs).toLocaleString('en-US') : loadedSnapshots[bestIndex].sourceFile}.`
                : `Success! Mapped ${globalTopologyData.length} nodes.`,
            "green"
        );
    } catch (err) {
        if (myGeneration !== loadFilesGeneration) return; // superseded - a newer call owns the status line now
        if (err && err.message === 'Cancelled') {
            window.setStatus("Decryption cancelled.", "orange");
        } else {
            window.setStatus(parseSucceeded ? "Render error - see details." : "JSON Parse Error.", "red");
            throw err;
        }
    } finally {
        // Only the still-current call resets the busy UI - if a newer call has since
        // started, it owns the progress bar/buttons and this stale call must not clear
        // state out from under it.
        if (myGeneration === loadFilesGeneration) {
            window.hideProgress();
            btn.disabled = false;
            if (folderBtn) folderBtn.disabled = false;
            if (scanBtn) scanBtn.disabled = false;
        }
    }
};
