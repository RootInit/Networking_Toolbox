// "Scan Network" button: starts an async fleet crawl (/api/scan-network), then feeds the result
// through processSelectedFiles - the same pipeline as a manual file upload.

var scanNetworkPollTimer = null;
// Re-entrancy guard, set synchronously before any await: a second pollRunningScan() would spawn a
// competing chain fighting over the shared scanNetworkPollTimer id.
var scanNetworkPollActive = false;

// Promise-based starting-IP prompt; prefillIp/replacing reuse the modal as a confirm step.
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

// Reuses computeGraphRoot so the suggested start IP is the same node the diagram roots on.
function bestStartIpFromActiveSnapshot() {
    if (!globalTopologyData || globalTopologyData.length === 0) return null;
    var classification = window.TopologyGraph.computeDeviceClassification(globalTopologyData);
    var nodeIds = Array.from(classification.keys());
    var edges = window.TopologyGraph.computeNeighborEdges(globalTopologyData);
    return window.GraphLayout.computeGraphRoot(nodeIds, edges);
}

// Shared poll loop, used by a freshly-started scan and by a page-load reattach alike.
function pollRunningScan() {
    if (scanNetworkPollActive) return;
    scanNetworkPollActive = true;

    var btn = document.getElementById('scanNetworkBtn');
    var loadBtn = document.getElementById('loadBtn');
    var loadFolderBtn = document.getElementById('loadFolderBtn');

    // msg/color are optional: omitting them leaves the status line already on screen alone.
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
        if (!status.ok) {
            finish("Scan failed: " + (status.reason || "unknown error"), "red");
            return;
        }

        // The crawl already wrote this snapshot to disk, so fetch the file rather than have the
        // status endpoint return it inline - that re-serialized the whole fleet on every poll. It
        // also means an encrypted setup gets the real .enc envelope and decrypts it normally.
        if (!status.outputFile) {
            finish("Scan finished but the server did not report an output file - use Load Folder to open the snapshot manually.", "red");
            return;
        }
        var snapshotResp;
        try {
            snapshotResp = await fetch('/api/snapshot?name=' + encodeURIComponent(status.outputFile));
        } catch (e) {
            finish("Scan finished but its snapshot could not be retrieved. " + window.describeServerError(e), "red");
            return;
        }
        if (!snapshotResp.ok) {
            finish("Scan finished but its snapshot could not be read back (HTTP " + snapshotResp.status + "). It is saved in Network_Maps - use Load Folder to open it.", "red");
            return;
        }
        // Read through processSelectedFiles, the same pipeline a manual upload uses.
        var snapshotFile = new File([await snapshotResp.text()], status.outputFile, { type: 'application/json' });
        finish("Scan complete - " + status.visitedCount + " device(s) found. Loading...", "green");
        await window.processSelectedFiles([snapshotFile]);
    };
    // poll() is fire-and-forget; an unhandled rejection would leave scanNetworkPollActive stuck true.
    function runPoll() {
        poll().catch(function(e) {
            // Every failure before the trailing processSelectedFiles already called finish(), so the
            // only way here is that call throwing, having set a more specific status already.
            var msg = (e && e.message) ? e.message : String(e);
            console.error("Unexpected error while polling scan status:", msg);
            finish();
        });
    }
    runPoll();
}

// Page-load reattach: a refresh mid-crawl loses the in-memory poll state. Returns true when it
// reattached, in which case the caller must not run autoloadLastScan - that would overwrite the
// live poll's status and buttons with a stale archived snapshot.
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

    // Re-checked after the awaits: a manual Load or a user-started Scan may have completed while
    // the status request was in flight, and reattaching would skip the confirm-before-replace step.
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
            return; // cancelled - nothing was started, so no status message
        }
    } else {
        // Scanning replaces what's on screen, so require explicit confirmation.
        var computedIp = bestStartIpFromActiveSnapshot();
        try {
            startIp = await promptForStartIp(computedIp, true);
        } catch (cancelErr) {
            return;
        }
    }

    // The Load buttons stay disabled for the whole scan, so a Load click can't start reading files
    // mid-crawl. processSelectedFiles guards the race anyway; this avoids a flip-flopping status.
    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Starting scan...'; }
        if (loadBtn) loadBtn.disabled = true;
        if (loadFolderBtn) loadFolderBtn.disabled = true;
        var scanRequest = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startIp: startIp }),
        };
        // When fetch rejects outright, how long it took separates two causes and only one is worth
        // retrying:
        //   fast - refused, or a stale pooled socket (this POST idles while the user types). Safe to
        //     repeat: if the first attempt did start a crawl, the retry gets a 409 and reattaches.
        //   slow - the server accepted and never answered; retrying only waits out a second timeout.
        var SERVER_UNRESPONSIVE_MS = 5000;
        var resp;
        var attemptStartedAt = Date.now();
        try {
            resp = await fetch('/api/scan-network', scanRequest);
        } catch (firstErr) {
            if (Date.now() - attemptStartedAt >= SERVER_UNRESPONSIVE_MS) {
                firstErr.serverUnresponsive = true;
                throw firstErr;
            }
            resp = await fetch('/api/scan-network', scanRequest);
        }
        // A non-JSON error body must not throw to the outer catch, which would report a server that
        // demonstrably answered as unreachable. The !resp.ok branch falls back to the status code.
        var result = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            if (btn) { btn.disabled = false; btn.textContent = 'Scan Network'; }
            if (loadBtn) loadBtn.disabled = false;
            if (loadFolderBtn) loadFolderBtn.disabled = false;
            if (resp.status === 409) {
                // Already running server-side (another tab, or this tab's retry) - reattach.
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
        window.setStatus("Could not start scan. " + window.describeServerError(e), "red");
        return;
    }

    pollRunningScan();
};
