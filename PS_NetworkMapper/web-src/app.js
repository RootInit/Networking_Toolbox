// App entry point: global error handler, cross-cutting session state, file loading (incl.
// the encrypted-file password flow), snapshot switching, and app-shell chrome. Every other
// file is a classic script sharing this global scope, loaded by <script> in index.html.

// "ResizeObserver loop completed/limit exceeded" is a benign warning Chromium dispatches as
// a window `error` event; vis-network's observer on #mynetwork raises it during panel width
// transitions, which would pop the fatal-error modal on every panel toggle.
var IGNORED_ERROR_MESSAGES = /ResizeObserver loop/;
window.onerror = function(message, source, lineno, colno, error) {
    if (IGNORED_ERROR_MESSAGES.test(message)) return true;

    // textContent, not innerHTML: message/source/stack can embed device- or file-supplied
    // text. #fatal-error-text carries white-space: pre-line so the \n separators still lay
    // out one field per line.
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

// Only the rendered graph is single-snapshot; search spans every loaded snapshot regardless
// of which is active.
var loadedSnapshots = [];   // {sourceFile, scanTimestamp, topology, deviceByIp}[]
var activeSnapshotIndex = -1;

// Generation claim guarding window.processSelectedFiles: a manual Load click and a Scan
// Network completion both funnel through it, each disabling only its own button. Every call
// takes the next number and bails if superseded, so a slower one can't clobber
// loadedSnapshots/activeSnapshotIndex/deviceByIp with stale data or a misleading "Success".
var loadFilesGeneration = 0;
var activeSidebarTab = 'sidebar-tab-load';
var activeCenterView = 'diagram';

// Built once per file load rather than re-scanned per search. deviceByIp is reassigned, not
// rebuilt, to whichever loadedSnapshots[i].deviceByIp is active.
var searchIndex = [];   // {deviceIp, snapshotIndex, field, value, valueLower}[]
var deviceByIp = new Map();

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

    // Map and Analysis render this topology separately and need their own refresh. Analysis
    // is gated on being the visible view: its containers stay in the DOM when hidden, so its
    // render functions would do full work for nothing - switchCenterView refreshes on
    // activation anyway.
    window.renderMapMarkers();

    if (activeCenterView === 'analysis') window.refreshAnalysisDashboard();
};

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

// Resolves with the entered password; rejects with Error('Cancelled') on Cancel/Escape so
// callers can tell a deliberate cancel from a real failure.
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
            // Captured before clearing, so the password leaves the DOM immediately.
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

// The server already prompted for this password at the console, so the common path can skip
// re-prompting. Cached and in-flight-deduped; resolves to '' rather than rejecting, so a
// falsy result means "fall back to promptForPassword".
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


// Shared by a live drag, a keyboard nudge and a restore-on-load, so min never exceeds the
// viewport-relative max.
function clampSidePanelWidth(width) {
    var maxWidth = window.innerWidth * 0.9;
    var minWidth = Math.min(320, maxWidth);
    return Math.max(minWidth, Math.min(maxWidth, width));
}

window.startSidePanelResize = function(e) {
    if (e.isPrimary === false) return;
    e.preventDefault();
    var panel = document.getElementById('side-panel');
    var handle = document.getElementById('side-panel-handle');
    var startX = e.clientX;
    var startWidth = panel.getBoundingClientRect().width;
    document.body.classList.add('resizing-side-panel');
    handle.classList.add('dragging');

    function onMove(moveEvent) {
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

// Arrow-key alternative to dragging #side-panel-handle.
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

// Until first dragged the tool pane sizes to its content; the `sized` class switches it to
// the dragged height, which then persists across reloads.
window.startToolPanelResize = function(e) {
    if (e.isPrimary === false) return;
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

// Arrow-key alternative to dragging #tool-divider.
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

// A display preference, deliberately in localStorage rather than Configuration.json.
(function restoreSidePanelWidth() {
    try {
        var saved = parseFloat(localStorage.getItem('sidePanelWidth'));
        if (Number.isFinite(saved) && saved >= 280) {
            document.getElementById('side-panel').style.width = clampSidePanelWidth(saved) + 'px';
        }
    } catch (err) {}
})();

// vis-network self-observes via ResizeObserver, but Leaflet does not, so every path that
// changes the map container's size must call invalidateSize() or its tiles freeze at the
// old size. Debounced because 'resize' fires continuously during a window drag.
var windowResizeDebounce = null;
window.addEventListener('resize', function() {
    // Re-clamped undebounced, so a width saved on a wider viewport can't overflow a
    // shrunk one even momentarily.
    var panel = document.getElementById('side-panel');
    var currentWidth = panel.getBoundingClientRect().width;
    var clamped = clampSidePanelWidth(currentWidth);
    if (clamped !== currentWidth) panel.style.width = clamped + 'px';

    clearTimeout(windowResizeDebounce);
    windowResizeDebounce = setTimeout(function() {
        if (activeCenterView === 'map' && window.leafletMap) window.leafletMap.invalidateSize();
    }, 150);
});

// Hidden panes stay in the DOM, so getElementById reads elsewhere (getClusterThreshold,
// getLayoutSettings) work whichever tab is active.
window.switchSidebarTab = async function(tabId) {
    document.querySelectorAll('.sidebar-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('#tool-tabs .tab').forEach(el => { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); });
    document.getElementById(tabId).classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    document.getElementById('btn-' + tabId).setAttribute('aria-selected', 'true');
    activeSidebarTab = tabId;

    if (tabId === 'sidebar-tab-settings') {
        // Paint what's known, then repaint once the config resolves. ensureConfigLoaded is
        // shared, so the fetch/password prompt happens once per session.
        window.populateSettingsInputs();
        await window.ensureConfigLoaded();
        window.populateSettingsInputs();
    }
};

// Reads and, if needed, decrypts one File into a {sourceFile, scanTimestamp, topology} record.
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
                    // The session password is tried silently first; the prompt is only
                    // reached if it is missing or fails to decrypt.
                    var sessionPassword = await window.getSessionEncryptionPassword();
                    var triedSessionPassword = false;
                    while (decryptedText === null) {
                        var password;
                        if (sessionPassword && !triedSessionPassword) {
                            password = sessionPassword;
                            triedSessionPassword = true;
                        } else {
                            password = await window.promptForPassword(errorMsg); // rejects on Cancel, exiting the loop
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

                // Clients arrive pre-correlated server-side.
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

// Startup autoload of the archived snapshots, through the same path a manual "Load Folder"
// uses. Every failure is silent and leaves manual load available - in particular an
// encrypted archive with no cached session password, where a surprise password prompt on
// page load would be worse than one manual load.
window.autoloadLastScan = async function() {
    if (loadedSnapshots.length > 0) return;
    // Captured before any await: a competing load that has started but not yet populated
    // loadedSnapshots is only detectable as a bumped generation.
    var myGenerationAtStart = loadFilesGeneration;

    var listing;
    try {
        var resp = await fetch('/api/snapshots');
        if (!resp.ok) return;
        listing = (await resp.json()).snapshots;
    } catch (err) {
        return;
    }
    if (!Array.isArray(listing) || listing.length === 0) return;

    // /api/snapshots returns names and sizes only; bodies come one at a time from
    // /api/snapshot. The server is single-threaded, so one bulk response would block it from
    // answering anything else for minutes on a large archive - and for the same reason these
    // are fetched sequentially, not in parallel: concurrency buys nothing and the gaps
    // between requests are what let the server serve a scan the user starts meanwhile.
    var entries = [];
    for (var i = 0; i < listing.length; i++) {
        // Re-checked every iteration because the loop yields to the server between fetches.
        // scanNetworkPollActive is the canonical "a scan is in flight" flag: unlike
        // loadFilesGeneration/loadedSnapshots it moves when a scan starts, not when it
        // finishes, so it catches a crawl whose results will supersede all of this.
        if (scanNetworkPollActive || loadFilesGeneration !== myGenerationAtStart || loadedSnapshots.length > 0) return;
        try {
            var fileResp = await fetch('/api/snapshot?name=' + encodeURIComponent(listing[i].name));
            // One unreadable snapshot (a crawl mid-write, a permissions issue) skips that
            // file rather than abandoning the autoload.
            if (!fileResp.ok) continue;
            var content = await fileResp.text();
            if (content) entries.push({ name: listing[i].name, content: content });
        } catch (err) {
            return; // the server is gone or blocked; stop quietly
        }
    }
    if (entries.length === 0) return;

    var encryptedEntries = entries.filter(e => {
        try { return JSON.parse(e.content).format === 'PSNetworkMapper-EncryptedTopology'; }
        catch (err) { return false; }
    });
    if (encryptedEntries.length > 0) {
        var sessionPassword = await window.getSessionEncryptionPassword();
        if (!sessionPassword) return;
        // The cached password must actually decrypt, or processSelectedFiles falls through to
        // promptForPassword - the surprise prompt this is meant to avoid. Checking the first
        // entry suffices: all were written by this server with the same session password.
        try {
            await window.TopologyCrypto.decryptEnvelope(JSON.parse(encryptedEntries[0].content), sessionPassword);
        } catch (err) {
            return;
        }
    }

    if (loadFilesGeneration !== myGenerationAtStart || loadedSnapshots.length > 0 || scanNetworkPollActive) return;
    var files = entries.map(e => new File([e.content], e.name, { type: 'application/json' }));
    // Nothing here was user-initiated, so a corrupt archived snapshot must not surface the
    // fatal error state - which processSelectedFiles does re-throw into when files.length
    // is 1, tolerateFailures being multi-file only.
    try {
        await window.processSelectedFiles(files);
    } catch (err) {
        console.warn('Autoload of the last scan failed - leaving manual load available.', err);
    }
};

document.addEventListener('DOMContentLoaded', async function() {
    // resumeScanIfInProgress must be awaited before autoloading: if a scan is running
    // server-side (this tab refreshed mid-crawl), autoloadLastScan would race it and paint
    // the previous archived snapshot plus a false "Success!" over the live poll. When it
    // reattaches, skip the autoload entirely - the scan loads its own result on completion.
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
    // A folder picker returns every file in the directory. The .tmp exclusion matters: a
    // mid-crawl pick would otherwise load an in-progress file as a finished snapshot.
    var files = Array.from(input.files).filter(f =>
        /^NetworkMap_.*\.json(\.enc)?$/i.test(f.name) && !/\.tmp\.json(\.enc)?$/i.test(f.name)
    );
    if (files.length === 0) {
        window.setStatus("No NetworkMap_*.json(.enc) files found in that folder.", "red");
        return;
    }
    await window.processSelectedFiles(files);
};

// Turns a list of File objects into loadedSnapshots plus the active graph/search state.
window.processSelectedFiles = async function(files) {
    var myGeneration = ++loadFilesGeneration;
    var btn = document.getElementById('loadBtn');
    var folderBtn = document.getElementById('loadFolderBtn');
    // Locked out here as well as by its own handler, so a running scan's eventual call
    // can't race this one.
    var scanBtn = document.getElementById('scanNetworkBtn');
    btn.disabled = true;
    if (folderBtn) folderBtn.disabled = true;
    if (scanBtn) scanBtn.disabled = true;
    window.closeDrawer();
    // These three all hold references into the data replaced below: the location editor's
    // editorTargetIp, a rescan poll's captured snapshot slot, and a ping poll's drawer.
    window.closeLocationEditor();
    if (window.cancelPendingRescan) window.cancelPendingRescan();
    if (window.cancelPendingPing) window.cancelPendingPing();

    var newSnapshots = [];
    var skipped = []; // {name, reason}[]
    var parseSucceeded = false;
    // A single file's failure aborts the load; in a folder batch one bad file must not
    // discard the rest.
    var tolerateFailures = files.length > 1;

    try {
        for (var i = 0; i < files.length; i++) {
            window.setStatus(`Reading file ${i + 1} of ${files.length}: ${files[i].name}...`, "orange");
            window.showProgress(`Reading ${files[i].name}...`, Math.round((i / files.length) * 100));
            await new Promise(r => setTimeout(r, 20)); // let the progress update paint

            if (tolerateFailures) {
                try {
                    newSnapshots.push(await readSnapshotFile(files[i]));
                } catch (fileErr) {
                    // A cancelled password prompt aborts the batch instead of counting as
                    // one bad file; otherwise Cancel just re-prompts for the next encrypted
                    // file, once per remaining file.
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

        if (myGeneration !== loadFilesGeneration) return;
        loadedSnapshots = newSnapshots;
        // Rendered result rows close over the OLD loadedSnapshots/deviceByIp, so once those
        // are replaced a stale row can open a drawer for a device that no longer exists, or
        // an unrelated one now at the same IP. Clear the UI with the data it was built from.
        var searchResultsEl = document.getElementById('searchResults');
        if (searchResultsEl) searchResultsEl.innerHTML = '';
        var globalSearchEl = document.getElementById('globalSearch');
        if (globalSearchEl) globalSearchEl.value = '';
        searchHighlightQuery = "";
        window.showProgress("Indexing search data...", 100, true);
        await nextPaint();
        if (myGeneration !== loadFilesGeneration) return;
        window.buildSearchIndex();

        // Most recently captured snapshot wins; files with no ScanTimestamp fall back to
        // selection order, preferring later ones.
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
        if (myGeneration !== loadFilesGeneration) return;

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
        if (myGeneration !== loadFilesGeneration) return; // a newer call owns the status line
        if (err && err.message === 'Cancelled') {
            window.setStatus("Decryption cancelled.", "orange");
        } else {
            window.setStatus(parseSucceeded ? "Render error - see details." : "JSON Parse Error.", "red");
            throw err;
        }
    } finally {
        // Only the current call resets the busy UI; a newer one owns the progress bar and
        // buttons by now.
        if (myGeneration === loadFilesGeneration) {
            window.hideProgress();
            btn.disabled = false;
            if (folderBtn) folderBtn.disabled = false;
            if (scanBtn) scanBtn.disabled = false;
        }
    }
};
