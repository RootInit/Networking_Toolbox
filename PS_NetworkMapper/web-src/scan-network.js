// "Scan Network" button: kicks off an async fleet crawl (WebServer.ps1's /api/scan-network),
// then feeds the result through processSelectedFiles - same pipeline as a manual file upload.

var scanNetworkPollTimer = null;

// Promise-based starting-IP prompt, same resolve/reject shape as window.promptForPassword.
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

// "Best" starting IP from the active snapshot: the graph-center node, same heuristic as
// graph.js's own diagram root (computeGraphRoot).
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
            // Defensive: no classifiable node even though snapshots are loaded. Fall back
            // to asking, same as the no-snapshot case.
            try {
                startIp = await promptForStartIp();
            } catch (cancelErr) {
                return;
            }
        }
    }

    // window.setStatus mirrors to #mapStatusNote when #status-text isn't visible, so scan
    // messages are seen even if the user switched tabs mid-scan.
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
            scanNetworkPollTimer = setTimeout(poll, 2000);
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
    poll();
};
