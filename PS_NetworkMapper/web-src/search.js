// Global search: the prebuilt search index, the search box's Enter/button handler, the
// shared results-list renderer (also used by dashboard.js's stat-card drill-down), and the
// "jump to this result" navigation. Reads loadedSnapshots/globalTopologyData/
// activeSnapshotIndex/searchIndex/searchHighlightQuery/currentSelectedNodeData (app.js)
// and calls into graph.js (renderVisibleGraph)/drawer.js (openRightDrawer/switchTab).

// 'client_ip' is kept distinct from the device's own 'ip' field so a client match doesn't
// look like a hit on the switch's own management IP.
var SEARCH_FIELD_LABELS = { ip: 'IP Address', client_ip: 'Client IP', hostname: 'Hostname', mac: 'MAC Address', user: 'Username', serial: 'Serial Number' };
// Which tab to jump to for a match in each field - null leaves the active tab as-is.
var SEARCH_FIELD_TABS = { ip: null, client_ip: 'tab-interfaces', hostname: null, mac: 'tab-interfaces', user: 'tab-interfaces', serial: 'tab-stack' };
// The UI only exposes one "IP Address" checkbox for both the device's own IP and a
// client's IP - this maps a search-index field back to the checkbox id that gates it.
var SEARCH_FIELD_CHECKBOX = { ip: 'ip', client_ip: 'ip', hostname: 'hostname', mac: 'mac', user: 'user', serial: 'serial' };

// Rebuilds the index across ALL loaded snapshots and, as a side effect, refreshes each
// snapshot's own deviceByIp map - so switching the active snapshot is just a reassignment,
// not a rebuild (see window.setActiveSnapshot in app.js).
window.buildSearchIndex = function() {
    searchIndex = [];

    loadedSnapshots.forEach((snapshot, snapshotIndex) => {
        snapshot.deviceByIp = new Map();

        snapshot.topology.forEach(device => {
            if (!device || !device.DeviceIP) return;
            var ip = String(device.DeviceIP);
            snapshot.deviceByIp.set(ip, device);

            searchIndex.push({ deviceIp: ip, snapshotIndex: snapshotIndex, field: 'ip', value: ip, valueLower: ip.toLowerCase() });
            if (device.Hostname) {
                searchIndex.push({ deviceIp: ip, snapshotIndex: snapshotIndex, field: 'hostname', value: String(device.Hostname), valueLower: String(device.Hostname).toLowerCase() });
            }

            window.asArray(device.StackMembers).forEach(sm => {
                if (sm && sm.Serial) {
                    searchIndex.push({ deviceIp: ip, snapshotIndex: snapshotIndex, field: 'serial', value: String(sm.Serial), valueLower: String(sm.Serial).toLowerCase() });
                }
            });

            window.asArray(device.TrueClients).forEach(c => {
                if (c.IP) searchIndex.push({ deviceIp: ip, snapshotIndex: snapshotIndex, field: 'client_ip', value: String(c.IP), valueLower: String(c.IP).toLowerCase() });
                if (c.MAC) searchIndex.push({ deviceIp: ip, snapshotIndex: snapshotIndex, field: 'mac', value: String(c.MAC), valueLower: String(c.MAC).toLowerCase() });
                if (c.Dot1x_User && c.Dot1x_User !== "Unknown") {
                    searchIndex.push({ deviceIp: ip, snapshotIndex: snapshotIndex, field: 'user', value: String(c.Dot1x_User), valueLower: String(c.Dot1x_User).toLowerCase() });
                }
            });
        });
    });

    deviceByIp = (activeSnapshotIndex >= 0 && loadedSnapshots[activeSnapshotIndex]) ? loadedSnapshots[activeSnapshotIndex].deviceByIp : new Map();
};

// Runs only on Enter / the Search button, not on keystroke - the expensive expand/render/
// camera-animate chain only runs when a result is clicked (window.goToSearchResult).
window.performGlobalSearch = function() {
    var query = document.getElementById('globalSearch').value.trim();
    var queryLower = query.toLowerCase();
    searchHighlightQuery = queryLower;

    if (!query) {
        document.getElementById('searchResults').innerHTML = '';
        if (currentSelectedNodeData) window.openRightDrawer(currentSelectedNodeData.DeviceIP);
        return;
    }

    var fieldsEnabled = {
        ip: document.getElementById('searchFieldIp').checked,
        hostname: document.getElementById('searchFieldHostname').checked,
        mac: document.getElementById('searchFieldMac').checked,
        user: document.getElementById('searchFieldUser').checked,
        serial: document.getElementById('searchFieldSerial').checked,
    };

    // searchIndex is prebuilt with values already lowercased, so this is a flat scan with
    // a plain substring check.
    var matches = [];
    // Dedup key includes snapshotIndex so the same value in two different snapshots
    // doesn't collapse into one row.
    var seen = new Set();
    for (var i = 0; i < searchIndex.length; i++) {
        var entry = searchIndex[i];
        if (!fieldsEnabled[SEARCH_FIELD_CHECKBOX[entry.field]] || entry.valueLower.indexOf(queryLower) === -1) continue;
        var key = entry.snapshotIndex + '|' + entry.deviceIp + '|' + entry.field + '|' + entry.value;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(entry);
    }
    matches.sort((a, b) => window.GraphLayout.compareIpIds(a.deviceIp, b.deviceIp) || (a.snapshotIndex - b.snapshotIndex) || a.field.localeCompare(b.field));

    var rows = matches.map(m => {
        var snapshot = loadedSnapshots[m.snapshotIndex];
        var device = snapshot ? snapshot.deviceByIp.get(m.deviceIp) : null;
        var hostname = device && device.Hostname ? ` (${esc(device.Hostname)})` : '';
        // Only show which snapshot a match came from when more than one is loaded.
        var snapshotTs = snapshot ? window.parseTimestampMs(snapshot.scanTimestamp) : null;
        var snapshotTag = (loadedSnapshots.length > 1 && snapshot)
            ? `<span class="sr-snapshot">${esc(snapshotTs !== null ? new Date(snapshotTs).toLocaleString('en-US') : snapshot.sourceFile)}</span>`
            : '';
        return {
            line1Html: `${esc(m.deviceIp)}${hostname}${snapshotTag}`,
            line2Html: `${esc(SEARCH_FIELD_LABELS[m.field])}: <b>${esc(m.value)}</b>`,
            onClick: () => window.goToSearchResult(m.deviceIp, SEARCH_FIELD_TABS[m.field], m.snapshotIndex,
                SEARCH_FIELD_TABS[m.field] === 'tab-interfaces' ? { client: m.value } : null),
        };
    });

    window.renderResultsList(rows, { emptyText: `No matches for "${query}".` });
};

// Shared renderer for a .search-result list - used by global text search, a dashboard
// stat drill-down, and drawer.js's cross-device compare search (#configCompareSearchResults).
// `opts.targetId`: element id, defaults to 'searchResults'. `opts.headerText`: sticky bar
// with "Clear" link (drill-down only). `opts.emptyText`: shown when `rows` is empty.
window.renderResultsList = function(rows, opts) {
    opts = opts || {};
    var resultsEl = document.getElementById(opts.targetId || 'searchResults');
    if (!resultsEl) return;
    var headerHtml = opts.headerText
        ? `<div class="search-results-header"><span>${esc(opts.headerText)}</span><span class="search-results-clear" id="searchResultsClearBtn">Clear</span></div>`
        : '';

    if (rows.length === 0) {
        resultsEl.innerHTML = headerHtml + `<div class="search-no-results">${esc(opts.emptyText || 'No results.')}</div>`;
    } else {
        resultsEl.innerHTML = headerHtml + rows.map((r, idx) => `<div class="search-result" data-idx="${idx}">
            <div class="sr-device">${r.line1Html}</div>
            ${r.line2Html ? `<div class="sr-match">${r.line2Html}</div>` : ''}
        </div>`).join('');
        Array.from(resultsEl.querySelectorAll('.search-result')).forEach((el, idx) => { el.onclick = rows[idx].onClick; });
    }

    if (opts.headerText) {
        var clearBtn = document.getElementById('searchResultsClearBtn');
        if (clearBtn) clearBtn.onclick = function() {
            document.getElementById('globalSearch').value = '';
            window.performGlobalSearch();
        };
    }
};

// Switches to the match's snapshot if needed, reveals the device (expanding collapsed
// ancestors), re-renders, selects/focuses it, opens its drawer, and jumps to the matched
// field's tab.
//
// goToSearchResultGeneration guards against two clicks landing close together: each call
// claims the next generation and checks it's still current after every await, since
// globalTopologyData/deviceByIp/primaryTree/expandedNodes are plain globals a newer call
// can overwrite mid-flight (otherwise an older call could open the wrong device's drawer
// against the wrong snapshot's tree).
var goToSearchResultGeneration = 0;

// Reveals a device in whichever center view is active - diagram (select+focus on the
// vis-network canvas) or map (pan/zoom to marker, or a status note if unlocated).
window.revealDeviceInActiveView = function(ip) {
    if (activeCenterView === 'map') {
        var revealed = window.revealDeviceOnMap(ip);
        if (!revealed) window.showMapStatus('No location set for this device.');
        else window.showMapStatus('');
        return;
    }
    try {
        // An isolated device (no LLDP neighbors) has no path from the graph root, so it's
        // never in the visible tree and vis-network throws selecting it. Swallow it here -
        // the drawer opening below must not be blocked by a failed camera animation.
        network.selectNodes([ip]);
        network.focus(ip, { scale: 1.0, animation: { duration: 500 } });
    } catch (e) {
        console.warn(`Could not select/focus "${ip}" on the graph (likely not part of the visible tree):`, e.message);
    }
};

// `focus` (optional) names the port the result is about - `{port: 'ge-0/0/5'}` or
// `{client: '<ip|mac|user>'}` - so the drawer expands that row and lights its jack on the
// front panel (drawer.js's focusPortFor / selectInterfacePort).
window.goToSearchResult = function(targetIp, tab, snapshotIndex, focus) {
    var myGeneration = ++goToSearchResultGeneration;
    (async () => {
        if (typeof snapshotIndex === 'number' && snapshotIndex !== activeSnapshotIndex) {
            await window.setActiveSnapshot(snapshotIndex);
        }
        if (myGeneration !== goToSearchResultGeneration) return; // superseded by a newer click
        // Open the drawer before the graph re-render below - the ELK layout pass can take
        // a few seconds on a large visible set, and the device info the user actually
        // wants is available immediately without waiting on it.
        window.openRightDrawer(targetIp);
        if (tab) window.switchTab(tab);
        if (focus && currentSelectedNodeData) {
            var port = window.focusPortFor(currentSelectedNodeData, focus);
            if (port) window.selectInterfacePort(port, { source: 'search' });
        }
        window.GraphLayout.expandAncestors(primaryTree.parentOf, primaryTree.childrenOf, targetIp, expandedNodes, getClusterThreshold());
        await window.renderVisibleGraph();
        if (myGeneration !== goToSearchResultGeneration) return;
        window.revealDeviceInActiveView(targetIp);
    })().catch(e => {
        console.error('goToSearchResult failed:', e);
        window.setStatus("Could not go to search result: " + e.message, "red");
    });
};
