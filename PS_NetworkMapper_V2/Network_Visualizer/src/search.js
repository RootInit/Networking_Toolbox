// Global search: the prebuilt search index, the search box's Enter/button handler, the
// shared results-list renderer (also used by dashboard.js's stat-card drill-down), and the
// "jump to this result" navigation. Reads loadedSnapshots/globalTopologyData/
// activeSnapshotIndex/searchIndex/searchHighlightQuery/currentSelectedNodeData (app.js)
// and calls into graph.js (renderVisibleGraph)/drawer.js (openRightDrawer/switchTab).

// 'client_ip' is kept distinct from the device's own 'ip' field - a client hanging off a
// switch is not the switch, and collapsing the two made every client-IP match look like a
// hit on the switch's own management IP with no indication a client was even involved.
var SEARCH_FIELD_LABELS = { ip: 'IP Address', client_ip: 'Client IP', hostname: 'Hostname', mac: 'MAC Address', user: 'Username', serial: 'Serial Number' };
// Which tab to jump to for a match in each field - null means "leave whatever tab is
// already active" (matches on the device's own identity don't point anywhere specific).
var SEARCH_FIELD_TABS = { ip: null, client_ip: 'tab-clients', hostname: null, mac: 'tab-clients', user: 'tab-clients', serial: 'tab-stack' };
// The UI only exposes one "IP Address" checkbox for both the device's own IP and a
// client's IP - this maps a search-index field back to the checkbox id that gates it.
var SEARCH_FIELD_CHECKBOX = { ip: 'ip', client_ip: 'ip', hostname: 'hostname', mac: 'mac', user: 'user', serial: 'serial' };

// Rebuilds the index across ALL loaded snapshots (not just the active one) and, as a
// side effect, builds/refreshes each snapshot's own flat deviceByIp map - one map per
// snapshot rather than one shared map, so switching the active snapshot never has to
// rebuild anything, just reassign which map is "current" (see window.setActiveSnapshot
// in app.js).
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

            // StackMembers/TrueClients aren't asArray-wrapped elsewhere in this file either
            // (see drawer.js's renderStack/renderClients) - PowerShell's ConvertTo-Json only
            // collapses a single-element array to a bare object for fields this app has
            // needed to guard (Alarms), so this mirrors the existing, working assumption
            // rather than introducing an inconsistent one just for search.
            (device.StackMembers || []).forEach(sm => {
                if (sm && sm.Serial) {
                    searchIndex.push({ deviceIp: ip, snapshotIndex: snapshotIndex, field: 'serial', value: String(sm.Serial), valueLower: String(sm.Serial).toLowerCase() });
                }
            });

            (device.TrueClients || []).forEach(c => {
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

// Runs only on Enter / the Search button (see network_vis.html) - it used to run on
// every keystroke (onkeyup), which felt slow because each call didn't just search, it
// immediately expanded ancestors, re-rendered the whole visible graph, and animated the
// camera to the first match - all of that firing on every keystroke while typing is what
// was actually slow, not the string matching itself. Now that expensive chain only runs
// when a specific result is clicked (see window.goToSearchResult), not while searching.
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

    // searchIndex is prebuilt (see window.buildSearchIndex) with every value already
    // lowercased, so this is a single flat scan with a plain substring check - no nested
    // array walking and no re-lowercasing on every search.
    var matches = [];
    // Dedup key includes snapshotIndex - without it, the same IP/field/value appearing in
    // two different loaded snapshots would collapse into one row and silently hide that
    // the device/client existed in more than one of them. Within a single snapshot this
    // still collapses true duplicates the same way it always did (e.g. two clients
    // happening to share a MAC record).
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
        // Only show which snapshot a match came from when more than one is loaded - for
        // the common single-file case this stays exactly as it looked before Phase 0.
        var snapshotTag = (loadedSnapshots.length > 1 && snapshot)
            ? `<span class="sr-snapshot">${esc(snapshot.scanTimestamp ? new Date(snapshot.scanTimestamp).toLocaleString() : snapshot.sourceFile)}</span>`
            : '';
        return {
            line1Html: `${esc(m.deviceIp)}${hostname}${snapshotTag}`,
            line2Html: `${esc(SEARCH_FIELD_LABELS[m.field])}: <b>${esc(m.value)}</b>`,
            onClick: () => window.goToSearchResult(m.deviceIp, SEARCH_FIELD_TABS[m.field], m.snapshotIndex),
        };
    });

    window.renderResultsList(rows, { emptyText: `No matches for "${query}".` });
};

// Shared renderer for a .search-result list - used by the global text search and a
// dashboard stat drill-down (both target #searchResults, the default), and by the Config
// tab's cross-device compare search (drawer.js, targets #configCompareSearchResults) so
// that list looks and behaves exactly the same way without a second copy of this markup.
// `opts` - `targetId`: element id to render into, defaults to 'searchResults'; `headerText`:
// shown in a sticky bar with a "Clear" link (global-search drill-down only, since a text
// search's own input box already shows what's being searched for - other callers omit
// it); `emptyText`: shown when `rows` is empty.
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

// Everything a search result click actually needs to do: switch to the snapshot the
// match came from if it wasn't already active (a no-op for the common single-snapshot
// case), then reveal the device (expanding any collapsed cluster ancestors), re-render,
// select and focus it on the canvas, open its drawer, and land on whichever tab actually
// shows the field that matched.
//
// goToSearchResultGeneration guards against two clicks landing close together (two
// different result rows, or a drill-down row clicked twice) - each call claims the next
// generation number and checks it's still current after every await, since
// globalTopologyData/deviceByIp/primaryTree/expandedNodes are plain globals a second,
// newer call can overwrite mid-flight of the first. Without this, an older call's
// still-pending expandAncestors/openRightDrawer could run AFTER a newer call already
// switched snapshots, opening the wrong device's drawer against the wrong snapshot's tree
// (deviceByIp.get(x) returning undefined for a device that's real in its own snapshot).
var goToSearchResultGeneration = 0;
window.goToSearchResult = function(targetIp, tab, snapshotIndex) {
    var myGeneration = ++goToSearchResultGeneration;
    (async () => {
        if (typeof snapshotIndex === 'number' && snapshotIndex !== activeSnapshotIndex) {
            await window.setActiveSnapshot(snapshotIndex);
        }
        if (myGeneration !== goToSearchResultGeneration) return; // superseded by a newer click
        window.GraphLayout.expandAncestors(primaryTree.parentOf, primaryTree.childrenOf, targetIp, expandedNodes, getClusterThreshold());
        await window.renderVisibleGraph();
        if (myGeneration !== goToSearchResultGeneration) return;
        try {
            // A device with no LLDP neighbors at all (isolated, or the only device in its
            // snapshot) has no path from the graph root, so it's never part of the
            // "visible" tree renderVisibleGraph computes - vis-network throws selecting a
            // node it was never given. That's a real, separate gap in the graph/tree logic,
            // not something to paper over with a suppressed exception - but the drawer
            // opening below is strictly more important than the camera animation up here,
            // and one throwing must never block the other.
            network.selectNodes([targetIp]);
            network.focus(targetIp, { scale: 1.0, animation: { duration: 500 } });
        } catch (e) {
            console.warn(`Could not select/focus "${targetIp}" on the graph (likely not part of the visible tree):`, e.message);
        }
        window.openRightDrawer(targetIp);
        if (tab) window.switchTab(tab);
    })();
};
