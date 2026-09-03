// "Scan Network" button: kicks off an async fleet crawl (WebServer.ps1's /api/scan-network),
// then feeds the result through processSelectedFiles - same pipeline as a manual file upload.

var scanNetworkPollTimer = null;
// Re-entrancy guard (P2SCAN-002): set synchronously the instant a poll loop starts, before
// any await, so a second pollRunningScan() call (e.g. a 409-triggered retry landing while
// the original reattach loop is still alive) can't spawn a competing chain that fights the
// first one over the shared scanNetworkPollTimer id.
var scanNetworkPollActive = false;

// Promise-based starting-IP prompt, same resolve/reject shape as window.promptForPassword.
// prefillIp/replacing let the caller reuse this same confirm modal when a snapshot is
// already loaded (UX-001): the computed start IP is pre-filled and the description text
// warns that confirming will replace the currently-loaded data, instead of firing the
// fleet crawl with no review step at all.
function promptForStartIp(prefillIp, replacing) {
    return new Promise((resolve, reject) => {
        var modal = document.getElementById('scan-start-ip-modal');
        var input = document.getElementById('scan-start-ip-input');
        var errEl = document.getElementById('scan-start-ip-error');
        var descEl = document.getElementById('scan-start-ip-desc');
        var confirmBtn = document.getElementById('scan-start-ip-confirm-btn');
        var cancelBtn = document.getElementById('scan-start-ip-cancel-btn');

        errEl.style.display = 'none';
        input.value = prefillIp || '';
        if (descEl) {
            descEl.textContent = replacing
                ? 'A snapshot is already loaded. Confirm the starting switch IP to re-scan the fleet - this will replace the currently-loaded data.'
                : "No previous scan is loaded - enter the starting switch's IP address to begin a fleet crawl.";
        }
        modal.style.display = 'flex';
        input.focus();
        if (prefillIp) input.select();

        function cleanup() {
            modal.style.display = 'none';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onKeydown);
        }
        function onConfirm() {
            var value = input.value.trim();
            if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) {
                errEl.textContent = 'Enter a valid IPv4 address.';
                errEl.style.display = 'block';
                return;
            }
            cleanup();
            resolve(value);
        }
        function onCancel() { cleanup(); reject(new Error('Cancelled')); }
        function onKeydown(e) {
            if (e.key === 'Enter') onConfirm();
            if (e.key === 'Escape') onCancel();
        }

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        input.addEventListener('keydown', onKeydown);
    });
}

// "Best" starting IP from the active snapshot: the graph-center node, same heuristic as
// graph.js's own diagram root (computeGraphRoot).
function bestStartIpFromActiveSnapshot() {
    if (!globalTopologyData || globalTopologyData.length === 0) return null;
    var classification = window.TopologyGraph.computeDeviceClassification(globalTopologyData);
    var nodeIds = Array.from(classification.keys());
    var edges = window.TopologyGraph.computeNeighborEdges(globalTopologyData);
    return window.GraphLayout.computeGraphRoot(nodeIds, edges);
}

// Shared poll loop against /api/scan-network/status, used both by a freshly-started scan
// and by a page-load reattach to a scan already running server-side (UX-002). Disables the
// scan/load buttons for the duration and shows live progress on scanNetworkBtn, same as
// before this was extracted.
function pollRunningScan() {
    if (scanNetworkPollActive) return; // a poll loop is already driving this scan - let it continue
    scanNetworkPollActive = true;

    var btn = document.getElementById('scanNetworkBtn');
    var loadBtn = document.getElementById('loadBtn');
    var loadFolderBtn = document.getElementById('loadFolderBtn');

    // msg/color are optional (see runPoll's catch below) - omitting them still resets the
    // polling state/buttons but leaves whatever status line is already on screen alone.
    function finish(msg, color) {
        scanNetworkPollActive = false;
        if (scanNetworkPollTimer) { clearTimeout(scanNetworkPollTimer); scanNetworkPollTimer = null; }
        if (btn) { btn.disabled = false; btn.textContent = 'Scan Network'; }
        if (loadBtn) loadBtn.disabled = false;
        if (loadFolderBtn) loadFolderBtn.disabled = false;
        if (msg) window.setStatus(msg, color);
    }

    if (btn) btn.disabled = true;
    if (loadBtn) loadBtn.disabled = true;
    if (loadFolderBtn) loadFolderBtn.disabled = true;

    var poll = async function() {
        var statusResp;
        try {
            statusResp = await fetch('/api/scan-network/status');
        } catch (e) {
            finish("Lost connection to the local server - the scan may still be running server-side.", "red");
            return;
        }

        if (statusResp.status === 404) {
            finish("Scan job expired or the server restarted.", "red");
            return;
        }

        var status;
        try {
            status = await statusResp.json();
        } catch (e) {
            finish("Lost connection to the local server - the scan may still be running server-side.", "red");
            return;
        }

        if (!statusResp.ok) {
            finish("Scan failed: " + (status.reason || ('HTTP ' + statusResp.status)), "red");
            return;
        }
        if (status.status === 'running') {
            if (btn) btn.textContent = 'Scanning (' + status.visited + ' found)...';
            scanNetworkPollTimer = setTimeout(runPoll, 2000);
            return;
        }
        // status.status === 'complete'
        if (!status.ok) {
            finish("Scan failed: " + (status.reason || "unknown error"), "red");
            return;
        }

        // Synthesize a File from the returned JSON so it goes through the same
        // processSelectedFiles/readSnapshotFile pipeline as a manual upload - same
        // {Topology, ScanTimestamp} envelope Start-NetworkMapper.ps1 writes to disk.
        // This replaces whatever was previously loaded, same as any other new load.
        var syntheticContent = JSON.stringify({ Topology: status.topology, ScanTimestamp: status.scanTimestamp });
        var syntheticFile = new File([syntheticContent], status.outputFile || 'scan-result.json', { type: 'application/json' });
        finish("Scan complete - " + status.visitedCount + " device(s) found. Loading...", "green");
        await window.processSelectedFiles([syntheticFile]);
    };
    // poll() is fired-and-forgotten (directly here, and via setTimeout above) - without this
    // catch, an exception it doesn't already handle internally would leave
    // scanNetworkPollActive stuck true forever (finish(), which resets it, would never run),
    // permanently disabling the scan/load buttons with no visible error.
    function runPoll() {
        poll().catch(function(e) {
            // Every failure path inside poll() that can occur before the trailing
            // processSelectedFiles call already handles itself (its own try/catch calls
            // finish() with a specific message and returns) - so the only way to land here
            // is that final `await window.processSelectedFiles(...)` throwing. That function
            // always sets its own specific window.setStatus message (see its catch block)
            // before rethrowing - or, if superseded by a newer load, doesn't rethrow at all -
            // so a generic message here would only ever clobber a more useful one already on
            // screen. Reset the polling state/buttons without touching the status line, but
            // still log the underlying error for debugging. e may not be an Error (e.g. a
            // rejected-with-string/undefined promise), hence the defensive message extraction.
            var msg = (e && e.message) ? e.message : String(e);
            console.error("Unexpected error while polling scan status:", msg);
            finish();
        });
    }
    runPoll();
}

// Page-load reattach (UX-002): a refresh mid-crawl loses scanNetworkPollTimer/pollStart
// (plain JS vars), so on load check the server's status endpoint directly instead of
// leaving the UI idle with no way to tell "still running" from "safe to start." If a scan
// is running, resume the same poll loop and reflect progress on the button instead of
// silently reverting to idle.
// Returns true if a server-side scan was found running and this reattached to it (in which
// case the caller - app.js's DOMContentLoaded - must not let autoloadLastScan run, since that
// would overwrite the live poll's status/buttons with a stale archived snapshot - P2SCAN-001),
// false otherwise.
window.resumeScanIfInProgress = async function() {
    if (loadedSnapshots.length > 0 || scanNetworkPollActive) return false;
    var statusResp;
    try {
        statusResp = await fetch('/api/scan-network/status');
    } catch (e) {
        return false;
    }
    if (statusResp.status === 404 || !statusResp.ok) return false;
    var status;
    try {
        status = await statusResp.json();
    } catch (e) {
        return false;
    }
    if (status.status !== 'running') return false;

    // Re-check the same guard as above (P4UX-001): the await above gave a manually-
    // triggered Load Folder/File or a user-started Scan Network time to complete and
    // populate loadedSnapshots/scanNetworkPollActive while this was in flight. Reattaching
    // now would silently overwrite that just-loaded/just-started data with no confirmation,
    // unlike startNetworkScan's confirm-before-replace UX (see promptForStartIp's
    // "replacing" path above) - so abort quietly and let the fresher data/scan stand instead.
    if (loadedSnapshots.length > 0 || scanNetworkPollActive) {
        console.warn("resumeScanIfInProgress: state changed while checking scan status - not reattaching, leaving the newer data/scan in place.");
        return false;
    }

    var btn = document.getElementById('scanNetworkBtn');
    if (btn) btn.textContent = 'Scanning (' + status.visited + ' found)...';
    window.setStatus("A scan is already running - reattaching to progress...", "orange");
    pollRunningScan();
    return true;
};

window.startNetworkScan = async function() {
    var btn = document.getElementById('scanNetworkBtn');
    var loadBtn = document.getElementById('loadBtn');
    var loadFolderBtn = document.getElementById('loadFolderBtn');
    var startIp;

    if (loadedSnapshots.length === 0) {
        try {
            startIp = await promptForStartIp();
        } catch (cancelErr) {
            return; // user cancelled - no status message needed, nothing was started
        }
    } else {
        // A snapshot is already loaded - starting a scan here re-crawls the whole fleet
        // and replaces what's on screen, so require explicit confirmation (UX-001) via
        // the same start-IP modal, pre-filled with the computed root node.
        var computedIp = bestStartIpFromActiveSnapshot();
        try {
            startIp = await promptForStartIp(computedIp, true);
        } catch (cancelErr) {
            return;
        }
    }

    // window.setStatus mirrors to #mapStatusNote when #status-text isn't visible, so scan
    // messages are seen even if the user switched tabs mid-scan.
    // Also re-enables loadBtn/loadFolderBtn - they're disabled below for the whole scan
    // (not just once processSelectedFiles takes over at the end) so a Load click can't
    // start reading files while a scan the user is about to load is still in flight.
    // processSelectedFiles has its own generation guard against the two racing regardless,
    // but blocking the click here avoids wasted work and a confusing status-line back-and-forth.
    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Starting scan...'; }
        if (loadBtn) loadBtn.disabled = true;
        if (loadFolderBtn) loadFolderBtn.disabled = true;
        var resp = await fetch('/api/scan-network', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startIp: startIp }),
        });
        var result = await resp.json();
        if (!resp.ok) {
            if (btn) { btn.disabled = false; btn.textContent = 'Scan Network'; }
            if (loadBtn) loadBtn.disabled = false;
            if (loadFolderBtn) loadFolderBtn.disabled = false;
            if (resp.status === 409) {
                // A scan is already running server-side (e.g. started from another tab, or
                // this tab just doesn't know about it yet) - reattach instead of reporting
                // this as a failure.
                window.setStatus("A scan is already running - reattaching to progress...", "orange");
                pollRunningScan();
            } else {
                window.setStatus("Could not start scan: " + (result.error || ('HTTP ' + resp.status)), "red");
            }
            return;
        }
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Scan Network'; }
        if (loadBtn) loadBtn.disabled = false;
        if (loadFolderBtn) loadFolderBtn.disabled = false;
        window.setStatus("Could not start scan: " + e.message, "red");
        return;
    }

    pollRunningScan();
};
