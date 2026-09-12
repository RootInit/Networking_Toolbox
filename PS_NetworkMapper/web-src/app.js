// App entry point: global error handler, cross-cutting session state, file loading (incl. the
// encrypted-file password flow), snapshot switching, and app-shell chrome.

// "ResizeObserver loop completed/limit exceeded" is a benign warning Chromium dispatches as a
// window `error` event; vis-network raises it during panel transitions and would pop the modal.
var IGNORED_ERROR_MESSAGES = /ResizeObserver loop/;
window.onerror = function(message, source, lineno, colno, error) {
    if (IGNORED_ERROR_MESSAGES.test(message)) return true;

    // textContent, not innerHTML: these can embed device- or file-supplied text.
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

var network = null;
var globalTopologyData = [];
var nodesDataset = null;
var edgesDataset = null;
var allVlans = new Map();
var currentSelectedNodeData = null;
var searchHighlightQuery = "";

// Only the rendered graph is single-snapshot; search spans every loaded snapshot.
var loadedSnapshots = [];   // {sourceFile, scanTimestamp, topology, deviceByIp}[]
var activeSnapshotIndex = -1;

// Generation claim guarding window.processSelectedFiles: a manual Load and a Scan Network completion
// both funnel through it. Every call takes the next number and bails if superseded.
var loadFilesGeneration = 0;
var activeSidebarTab = 'sidebar-tab-load';
var activeCenterView = 'diagram';

// Built once per file load. deviceByIp is reassigned to whichever snapshot's map is active.
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

    // Analysis is gated on being visible: its containers stay in the DOM, and activation refreshes it.
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

// Rejects with Error('Cancelled') so callers can tell a deliberate cancel from a real failure.
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

// Cached and in-flight-deduped; resolves to '' rather than rejecting, so falsy means "prompt".
var sessionPasswordPromise = null;
window.getSessionEncryptionPassword = function() {
    if (!sessionPasswordPromise) {
        sessionPasswordPromise = fetch('/api/session-password')
            .then(resp => resp.ok ? resp.json() : { password: '' })
            .then(json => json.password || '')
            .catch(() => {
                // A transport failure is transient (the single-threaded server is busy) - don't cache it.
                sessionPasswordPromise = null;
                return '';
            });
    }
    return sessionPasswordPromise;
};


// Shared by a live drag, a keyboard nudge and a restore-on-load, so min never exceeds max.
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

// Until first dragged the tool pane sizes to its content; `sized` switches it to a fixed height.
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

// Leaflet doesn't self-observe resizes, so every size change must call invalidateSize(). Debounced.
var windowResizeDebounce = null;
window.addEventListener('resize', function() {
    // Re-clamped undebounced, so a width saved on a wider viewport can't overflow a shrunk one.
    var panel = document.getElementById('side-panel');
    var currentWidth = panel.getBoundingClientRect().width;
    var clamped = clampSidePanelWidth(currentWidth);
    if (clamped !== currentWidth) panel.style.width = clamped + 'px';

    clearTimeout(windowResizeDebounce);
    windowResizeDebounce = setTimeout(function() {
        if (activeCenterView === 'map' && window.leafletMap) window.leafletMap.invalidateSize();
    }, 150);
});

// Hidden panes stay in the DOM, so getElementById reads elsewhere work whichever tab is active.
window.switchSidebarTab = async function(tabId) {
    document.querySelectorAll('.sidebar-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('#tool-tabs .tab').forEach(el => { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); });
    document.getElementById(tabId).classList.add('active');
    document.getElementById('btn-' + tabId).classList.add('active');
    document.getElementById('btn-' + tabId).setAttribute('aria-selected', 'true');
    activeSidebarTab = tabId;

    if (tabId === 'sidebar-tab-settings') {
        // Paint what's known, then repaint once the config resolves; the fetch happens once.
        window.populateSettingsInputs();
        await window.ensureConfigLoaded();
        window.populateSettingsInputs();
    }
};

// Reads and, if needed, decrypts one File. `batch` carries the last password that worked.
function readSnapshotFile(file, batch) {
    return new Promise((resolve, reject) => {
        var reader = new FileReader();
        reader.onerror = () => reject(new Error(`Browser blocked read access to "${file.name}".`));

        reader.onload = async (e) => {
            try {
                var data = JSON.parse(e.target.result);

                if (data && data.format === 'PSNetworkMapper-EncryptedTopology') {
                    var decryptedText = null;
                    var errorMsg = null;
                    // The session password is tried silently first.
                    var sessionPassword = await window.getSessionEncryptionPassword();
                    var triedSessionPassword = false;
                    var triedBatchPassword = false;
                    while (decryptedText === null) {
                        var password;
                        if (sessionPassword && !triedSessionPassword) {
                            password = sessionPassword;
                            triedSessionPassword = true;
                        } else if (batch && batch.password && !triedBatchPassword) {
                            password = batch.password;
                            triedBatchPassword = true;
                        } else {
                            password = await window.promptForPassword(errorMsg); // rejects on Cancel, exiting the loop
                        }
                        try {
                            decryptedText = await window.TopologyCrypto.decryptEnvelope(data, password);
                            if (batch) batch.password = password;
                        } catch (decErr) {
                            // Only a wrong password is worth another attempt.
                            if (!decErr.wrongPassword) throw decErr;
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

// Startup autoload of the archived snapshots, through the same path "Load Folder" uses. Every failure
// is silent - in particular an encrypted archive whose surprise password prompt would be worse.
window.autoloadLastScan = async function() {
    if (loadedSnapshots.length > 0) return;
    // Captured before any await: a competing load is only detectable as a bumped generation.
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

    // Bodies come one at a time: the server is single-threaded, so a bulk response would block it for
    // minutes on a large archive, and the gaps between requests let it serve a scan started meanwhile.
    var entries = [];
    for (var i = 0; i < listing.length; i++) {
        // Re-checked each iteration: scanNetworkPollActive moves when a scan STARTS, not finishes.
        if (scanNetworkPollActive || loadFilesGeneration !== myGenerationAtStart || loadedSnapshots.length > 0) return;
        try {
            var fileResp = await fetch('/api/snapshot?name=' + encodeURIComponent(listing[i].name));
            // One unreadable snapshot skips that file rather than abandoning the autoload.
            if (!fileResp.ok) continue;
            var content = await fileResp.text();
            if (content) entries.push({ name: listing[i].name, content: content });
        } catch (err) {
            // Keep what was retrieved: the multi-file path tolerates a partial batch.
            console.warn('Autoload stopped after a transport error - continuing with the ' + entries.length + ' snapshot(s) already retrieved.', err);
            break;
        }
    }
    if (entries.length === 0) return;

    var encryptedEntries = entries.filter(e => {
        // The marker appears verbatim in the text, so its absence rules out an envelope cheaply.
        if (e.content.indexOf('PSNetworkMapper-EncryptedTopology') === -1) return false;
        try { return JSON.parse(e.content).format === 'PSNetworkMapper-EncryptedTopology'; }
        catch (err) { return false; }
    });
    if (encryptedEntries.length > 0) {
        var sessionPassword = await window.getSessionEncryptionPassword();
        if (!sessionPassword) return;
        // The cached password must actually decrypt, or we fall through to the prompt this avoids.
        try {
            await window.TopologyCrypto.decryptEnvelope(JSON.parse(encryptedEntries[0].content), sessionPassword);
        } catch (err) {
            return;
        }
    }

    if (loadFilesGeneration !== myGenerationAtStart || loadedSnapshots.length > 0 || scanNetworkPollActive) return;
    var files = entries.map(e => new File([e.content], e.name, { type: 'application/json' }));
    // Nothing here was user-initiated, so a corrupt snapshot must not surface the fatal error state.
    try {
        await window.processSelectedFiles(files);
    } catch (err) {
        console.warn('Autoload of the last scan failed - leaving manual load available.', err);
    }
};

document.addEventListener('DOMContentLoaded', async function() {
    // resumeScanIfInProgress must be awaited first: autoloadLastScan would otherwise race a running
    // scan and paint a stale snapshot plus a false "Success!" over the live poll.
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
    // A folder picker returns every file; the .tmp exclusion keeps a mid-crawl file out.
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
    // Locked out here too, so a running scan's eventual call can't race this one.
    var scanBtn = document.getElementById('scanNetworkBtn');
    btn.disabled = true;
    if (folderBtn) folderBtn.disabled = true;
    if (scanBtn) scanBtn.disabled = true;
    window.closeDrawer();
    // These three hold references into the data replaced below.
    window.closeLocationEditor();
    if (window.cancelPendingRescan) window.cancelPendingRescan();
    if (window.cancelPendingPing) window.cancelPendingPing();

    var newSnapshots = [];
    var skipped = []; // {name, reason}[]
    var parseSucceeded = false;
    // A single file's failure aborts the load; in a folder batch one bad file must not discard the rest.
    var tolerateFailures = files.length > 1;
    // Scoped to this call, so a manually entered password is reused across the batch.
    var batch = { password: null };

    try {
        for (var i = 0; i < files.length; i++) {
            window.setStatus(`Reading file ${i + 1} of ${files.length}: ${files[i].name}...`, "orange");
            window.showProgress(`Reading ${files[i].name}...`, Math.round((i / files.length) * 100));
            await new Promise(r => setTimeout(r, 20)); // let the progress update paint

            if (tolerateFailures) {
                try {
                    newSnapshots.push(await readSnapshotFile(files[i], batch));
                } catch (fileErr) {
                    // A cancelled prompt aborts the batch; otherwise Cancel re-prompts per file.
                    if (fileErr && fileErr.message === 'Cancelled') throw fileErr;
                    skipped.push({ name: files[i].name, reason: fileErr.message });
                }
            } else {
                newSnapshots.push(await readSnapshotFile(files[i], batch));
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
        // Rendered rows close over the OLD deviceByIp, so clear the UI with the data it came from.
        var searchResultsEl = document.getElementById('searchResults');
        if (searchResultsEl) searchResultsEl.innerHTML = '';
        var globalSearchEl = document.getElementById('globalSearch');
        if (globalSearchEl) globalSearchEl.value = '';
        searchHighlightQuery = "";
        window.showProgress("Indexing search data...", 100, true);
        await nextPaint();
        if (myGeneration !== loadFilesGeneration) return;
        window.buildSearchIndex();

        // Most recently captured wins; files with no ScanTimestamp fall back to selection order.
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
        // Only the current call resets the busy UI; a newer one owns the progress bar by now.
        if (myGeneration === loadFilesGeneration) {
            window.hideProgress();
            btn.disabled = false;
            if (folderBtn) folderBtn.disabled = false;
            if (scanBtn) scanBtn.disabled = false;
        }
    }
};
