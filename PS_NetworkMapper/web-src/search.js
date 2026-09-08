// Global search: prebuilt index, the search handler, the shared results-list renderer, and
// "jump to this result" navigation. Operates on app.js's globals (loadedSnapshots,
// activeSnapshotIndex, searchIndex, ...).

// 'client_ip' stays distinct from 'ip' so a client match doesn't read as a hit on the
// switch's own management IP.
var SEARCH_FIELD_LABELS = { ip: 'IP Address', client_ip: 'Client IP', hostname: 'Hostname', mac: 'MAC Address', user: 'Username', serial: 'Serial Number' };
// Which tab to jump to for a match in each field - null leaves the active tab as-is.
var SEARCH_FIELD_TABS = { ip: null, client_ip: 'tab-interfaces', hostname: null, mac: 'tab-interfaces', user: 'tab-interfaces', serial: 'tab-stack' };
// Maps an index field to the checkbox gating it; one "IP Address" checkbox covers both
// the device's own IP and a client's.
var SEARCH_FIELD_CHECKBOX = { ip: 'ip', client_ip: 'ip', hostname: 'hostname', mac: 'mac', user: 'user', serial: 'serial' };

// Indexes ALL loaded snapshots and, as a side effect, refreshes each snapshot's deviceByIp
// map, so setActiveSnapshot is a reassignment rather than a rebuild.
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

// Bound to Enter / the Search button rather than keystrokes.
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

    var matches = [];
    // snapshotIndex is part of the dedup key so the same value in two snapshots stays two rows.
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

// Shared .search-result renderer for global search, dashboard drill-downs and drawer.js's
// compare search. Callers pass pre-escaped line1Html/line2Html.
// opts: targetId (default 'searchResults'), headerText (adds a sticky bar with Clear),
// emptyText.
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

// Generation claim: each goToSearchResult call takes the next number and bails if it is no
// longer current after an await. globalTopologyData/deviceByIp/primaryTree/expandedNodes are
// plain globals, so without it a superseded click finishes against a newer snapshot's tree.
var goToSearchResultGeneration = 0;

window.revealDeviceInActiveView = function(ip) {
    if (activeCenterView === 'map') {
        var revealed = window.revealDeviceOnMap(ip);
        if (!revealed) window.showMapStatus('No location set for this device.');
        else window.showMapStatus('');
        return;
    }
    try {
        // An isolated device (no LLDP neighbors) is never in the visible tree, and
        // vis-network throws when selecting it. Swallowed so a failed camera animation
        // can't block the caller's drawer.
        network.selectNodes([ip]);
        network.focus(ip, { scale: 1.0, animation: { duration: 500 } });
    } catch (e) {
        console.warn(`Could not select/focus "${ip}" on the graph (likely not part of the visible tree):`, e.message);
    }
};

// Optional `focus` names what the result is about - {port: 'ge-0/0/5'} or
// {client: '<ip|mac|user>'} - so the drawer expands that row and lights its front-panel jack.
window.goToSearchResult = function(targetIp, tab, snapshotIndex, focus) {
    var myGeneration = ++goToSearchResultGeneration;
    (async () => {
        if (typeof snapshotIndex === 'number' && snapshotIndex !== activeSnapshotIndex) {
            await window.setActiveSnapshot(snapshotIndex);
        }
        if (myGeneration !== goToSearchResultGeneration) return; // superseded by a newer click
        // Drawer first: the layout pass below can take seconds on a large visible set, and
        // the device info the user asked for doesn't depend on it.
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
