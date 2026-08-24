// "Scan Network" button (#sidebar-tab-load): kicks off a full fleet crawl from the browser
// via Start-WebServer.ps1's async POST /api/scan-network + GET /api/scan-network/status
// (see that file's Invoke-ScanNetworkAction/Invoke-ScanNetworkStatusAction). Reads
// loadedSnapshots/globalTopologyData (app.js), calls into window.processSelectedFiles
// (app.js) to load the finished scan through the exact same pipeline a manually-uploaded
// file goes through - no separate "apply a scan result" code path to keep in sync.

var scanNetworkPollTimer = null;

// Promise-based starting-IP prompt, same resolve-on-confirm/reject-on-cancel shape as
// window.promptForPassword (app.js) - only used when no previous scan is loaded this
// session (see window.startNetworkScan below).
function promptForStartIp() {
    return new Promise((resolve, reject) => {
        var modal = document.getElementById('scan-start-ip-modal');
        var input = document.getElementById('scan-start-ip-input');
        var errEl = document.getElementById('scan-start-ip-error');
        var confirmBtn = document.getElementById('scan-start-ip-confirm-btn');
        var cancelBtn = document.getElementById('scan-start-ip-cancel-btn');

        errEl.style.display = 'none';
        input.value = '';
        modal.style.display = 'flex';
        input.focus();

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

// "Best" starting IP from the currently active snapshot: the graph-center node (largest
// connected component, minimum eccentricity) - the same "core/backbone" selection
// graph.js's own diagram root uses (see graph.js line ~121's computeGraphRoot call), reused
// here via the same pure, DOM-free function rather than inventing a second heuristic.
function bestStartIpFromActiveSnapshot() {
    if (!globalTopologyData || globalTopologyData.length === 0) return null;
    var classification = window.TopologyGraph.computeDeviceClassification(globalTopologyData);
    var nodeIds = Array.from(classification.keys());
    var edges = window.TopologyGraph.computeNeighborEdges(globalTopologyData);
    return window.GraphLayout.computeGraphRoot(nodeIds, edges);
}

window.startNetworkScan = async function() {
    var btn = document.getElementById('scanNetworkBtn');
    var startIp;

    if (loadedSnapshots.length === 0) {
        try {
            startIp = await promptForStartIp();
        } catch (cancelErr) {
            return; // user cancelled - no status message needed, nothing was started
        }
    } else {
        startIp = bestStartIpFromActiveSnapshot();
        if (!startIp) {
            // Defensive - loadedSnapshots.length > 0 but somehow no classifiable node (e.g.
            // every device record is malformed). Fall back to asking, same as the
            // no-snapshot case, rather than silently failing to start.
            try {
                startIp = await promptForStartIp();
            } catch (cancelErr) {
                return;
            }
        }
    }

    function finish(msg, color) {
        if (scanNetworkPollTimer) { clearTimeout(scanNetworkPollTimer); scanNetworkPollTimer = null; }
        if (btn) { btn.disabled = false; btn.textContent = 'Scan Network'; }
        window.setStatus(msg, color);
    }

    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Starting scan...'; }
        var resp = await fetch('/api/scan-network', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startIp: startIp }),
        });
        var result = await resp.json();
        if (!resp.ok) {
            finish("Could not start scan: " + (result.error || ('HTTP ' + resp.status)), "red");
            return;
        }
    } catch (e) {
        finish("Could not start scan: " + e.message, "red");
        return;
    }

    var pollStart = Date.now();
    var poll = async function() {
        var statusResp, status;
        try {
            statusResp = await fetch('/api/scan-network/status');
            status = await statusResp.json();
        } catch (e) {
            finish("Lost connection to the local server - the scan may still be running server-side.", "red");
            return;
        }

        if (statusResp.status === 404) {
            finish("Scan job expired or the server restarted.", "red");
            return;
        }
        if (status.status === 'running') {
            if (btn) btn.textContent = 'Scanning (' + status.visited + ' found)...';
            scanNetworkPollTimer = setTimeout(poll, 2000);
            return;
        }
        // status.status === 'complete'
        if (!status.ok) {
            finish("Scan failed: " + (status.reason || "unknown error"), "red");
            return;
        }

        // Feed the finished scan through the exact same load pipeline a manually-uploaded
        // file goes through, by synthesizing a File object from the already-decrypted JSON
        // this endpoint returned - readSnapshotFile (app.js) already knows how to parse
        // this shape (it's the same {Topology, ScanTimestamp} envelope Start-NetworkMapper.ps1
        // writes to disk), so there is no second parsing path to keep in sync. This
        // intentionally REPLACES whatever was previously loaded (loadedSnapshots is
        // reassigned wholesale) - the same behavior any other new load already has via
        // processSelectedFiles, not special-cased here.
        var syntheticContent = JSON.stringify({ Topology: status.topology, ScanTimestamp: status.scanTimestamp });
        var syntheticFile = new File([syntheticContent], status.outputFile || 'scan-result.json', { type: 'application/json' });
        finish("Scan complete - " + status.visitedCount + " device(s) found. Loading...", "green");
        await window.processSelectedFiles([syntheticFile]);
    };
    poll();
};
