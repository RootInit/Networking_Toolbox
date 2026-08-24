// Geographic map view: Leaflet-native rendering (NOT vis-network - confirmed unreliable
// when synced onto a Leaflet map, see docs/superpowers/specs/2026-08-23-geo-map-view-design.md's
// "Background: what the spike proved"). Owns Leaflet init, marker/edge rendering from the
// same topology data + classification the diagram uses (via TopologyGraph/ConfigResolve),
// the Unplaced Devices list, and the location editor. Reads globalTopologyData/deviceByIp
// (app.js), calls into drawer.js's openRightDrawer for details-drawer parity with the
// diagram.

var leafletMap = null;
var mapMarkersByIp = new Map();
var mapConfigEntries = [];      // decrypted Configuration.json's devices[], or [] if none loaded yet
var mapConfigLoaded = false;    // true once a GET /api/config attempt (success OR "no file yet") has completed
// True once fitBounds has ever run against real markers. renderMapMarkers is now called
// from every place topology data can change (new snapshot, single-device rescan), not just
// from the original three call sites - re-fitting the camera on every one of those would
// reset the user's pan/zoom every time a rescan completes or a snapshot switches, which is
// worse than the stale-map bug this is fixing. Only the very first time markers appear
// does the camera auto-frame; every re-render after that only touches markers/edges.
var hasFitBoundsOnce = false;

window.switchCenterView = function(view) {
    activeCenterView = view;
    // A status note shown while in one view (e.g. Task 9's "No location set for this
    // device." from a map-view search) is a plain #mapStatusNote sibling, not a child of
    // #mapview - it isn't covered by the display-toggling below, so it stays visibly
    // floating over whichever view comes next unless explicitly cleared here.
    window.showMapStatus('');
    document.getElementById('mynetwork').style.display = (view === 'diagram') ? 'block' : 'none';
    document.getElementById('mapview').style.display = (view === 'map') ? 'block' : 'none';
    document.getElementById('mapUnplacedPanel').style.display = (view === 'map') ? 'block' : 'none';
    document.getElementById('btn-center-view-diagram').classList.toggle('active', view === 'diagram');
    document.getElementById('btn-center-view-map').classList.toggle('active', view === 'map');
    // Same leak class as #mapStatusNote above (see the comment there, fixed in d5e884c) -
    // a second instance the final review caught: the floating Save button is a sibling of
    // #mapview too, so it isn't covered by the display-toggling above and would otherwise
    // float over the diagram canvas whenever pending edits exist and the user switches away.
    // Hidden (not removed) here so it reappears correctly on the next switch back to Map
    // without losing the pending-edit count it's tracking.
    var saveBtn = document.getElementById('mapSaveConfigBtn');
    if (saveBtn) saveBtn.style.display = (view === 'map') ? '' : 'none';

    if (view !== 'map') {
        // Mirror image of the leafletMap.invalidateSize() call below, for the diagram side:
        // buildSwitchMap may have (re)created the vis.Network instance while #mynetwork was
        // display:none (a snapshot load/switch that happened while Map view was showing),
        // sizing its canvas against the hidden container's bogus 0x0 clientWidth/
        // clientHeight - graph.js's window.resizeDiagram forces a re-measure/redraw/refit
        // now that the container is actually visible again. Guarded for existence per the
        // brief, though graph.js loads before map.js in network_vis.html's script order so
        // it should always be defined here.
        if (typeof window.resizeDiagram === 'function') window.resizeDiagram();
        return;
    }

    if (leafletMap !== null) {
        // renderMapMarkers (and any camera move) may have run while #mapview was
        // display:none (e.g. a snapshot load or single-device rescan that happened while
        // Diagram view was showing) - Leaflet sizes itself from the container's
        // clientWidth/clientHeight, which read 0 while hidden, so tiles for the real
        // viewport were never fetched. invalidateSize() re-measures the now-visible
        // container and repaints; it does not change the center/zoom itself, so this does
        // not fight the hasFitBoundsOnce/pan-preservation logic in renderMapMarkers - it
        // only fixes the rendering, not the framing. Hoisted above the branches below (not
        // just in the "already loaded" branch) so BOTH re-entry paths - the common "config
        // already loaded, just returning to Map" case and the rarer "retrying a
        // previously-failed config load" case - get it, not just one of them.
        leafletMap.invalidateSize();
    }

    if (leafletMap === null) {
        window.initMapView().catch(function (err) {
            window.showMapStatus('Failed to load map: ' + err.message);
        });
    } else if (!mapConfigLoaded) {
        // A previous config load attempt was cancelled or failed (see loadMapConfiguration
        // below) - retry it on every return to Map view instead of leaving the view wedged.
        // The Leaflet instance itself is never torn down/recreated for this - only the
        // config fetch+decrypt is re-attempted.
        window.loadMapConfiguration().then(function () {
            window.renderMapMarkers();
        }).catch(function (err) {
            window.showMapStatus('Failed to load map: ' + err.message);
        });
    } else {
        // If markers appeared for the very first time while this view was hidden,
        // renderMapMarkers's own maybeFitBoundsToMarkers() call deferred the first fit
        // rather than fitting against the bogus 0x0 size the container had while hidden -
        // retry it now that invalidateSize() above has it visible and correctly sized. A
        // no-op if the first fit already happened, or if there are still no markers.
        maybeFitBoundsToMarkers();
    }
};

window.initMapView = async function() {
    leafletMap = L.map('mapview', { zoomControl: true }).setView([0, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }).addTo(leafletMap);

    await window.loadMapConfiguration();
    window.renderMapMarkers();
};

// Fetches and decrypts Configuration.json.enc (if any). Sets mapConfigEntries/mapConfigLoaded.
// A missing file (404, fresh checkout) is a normal empty state, not an error - matches how
// a missing Auth.json is handled elsewhere in this app, and mapConfigLoaded=true there since
// there's nothing to retry. A cancelled password prompt or a network/parse failure is a real
// failure: it's reported via showMapStatus (same "Cancelled" handling app.js's own
// processSelectedFiles already does for the identical rejection from the topology-file
// password prompt) and leaves mapConfigLoaded=false so switchCenterView's retry path above
// can re-attempt it - this function must never throw/reject, since initMapView awaits it
// with nothing downstream to catch a rejection.
window.loadMapConfiguration = async function() {
    var resp;
    try {
        resp = await fetch('/api/config');
    } catch (fetchErr) {
        window.showMapStatus('Could not reach the server to load saved locations (' + fetchErr.message + '). Click Map again to retry.');
        mapConfigEntries = [];
        mapConfigLoaded = false;
        return;
    }
    if (resp.status === 404) {
        mapConfigEntries = [];
        mapConfigLoaded = true;
        window.showMapStatus('');
        return;
    }
    if (!resp.ok) {
        window.showMapStatus('Failed to load Configuration.json.enc: HTTP ' + resp.status + '. Click Map again to retry.');
        mapConfigEntries = [];
        mapConfigLoaded = false;
        return;
    }

    var envelope;
    try {
        envelope = await resp.json();
    } catch (parseErr) {
        window.showMapStatus('Configuration.json.enc is not valid JSON (' + parseErr.message + '). Click Map again to retry.');
        mapConfigEntries = [];
        mapConfigLoaded = false;
        return;
    }

    var decryptedText = null;
    var errorMsg = null;
    while (decryptedText === null) {
        var password;
        try {
            password = await window.promptForPassword(errorMsg);
        } catch (cancelErr) {
            window.showMapStatus('Location config decryption cancelled - devices will show without saved locations. Click Map again to retry.');
            mapConfigEntries = [];
            mapConfigLoaded = false;
            return;
        }
        try {
            decryptedText = await window.TopologyCrypto.decryptEnvelope(envelope, password, ['PSNetworkMapper-EncryptedConfig']);
        } catch (decErr) {
            errorMsg = decErr.message;
        }
    }
    mapConfigEntries = JSON.parse(decryptedText).devices || [];
    mapConfigLoaded = true;
    window.showMapStatus('');
};

window.showMapStatus = function(message) {
    var el = document.getElementById('mapStatusNote');
    el.textContent = message;
    el.style.display = message ? 'block' : 'none';
};

var MARKER_COLORS = {
    scannedStack: { background: '#D2E5FF', border: '#2B7CE9' },
    scanned: { background: '#97C2FC', border: '#2B7CE9' },
    unscanned: { background: '#E8E8E8', border: '#B0B0B0' },
};

function iconForClassification(meta) {
    var colors = !meta.scanned ? MARKER_COLORS.unscanned : (meta.isStack ? MARKER_COLORS.scannedStack : MARKER_COLORS.scanned);
    // Was 26px/8px-single-line, which clipped real hostnames (e.g. "ACCESS-SW-042.local")
    // mid-word - bumped to 40px and switched the label to wrap onto up to 2 lines (below)
    // instead of truncating, while staying small enough that clustered markers (see the
    // reported screenshot - markers sitting close together along a road) don't overlap
    // each other's labels.
    var size = 40;
    // meta.hostname is device-supplied (LLDP/DNS data this app doesn't control) and this
    // html string is rendered via Leaflet's innerHTML-based divIcon, unlike vis-network's
    // canvas-drawn (fillText) diagram labels - escape with the same window.esc (utils.js)
    // every other innerHTML-bound device string in this app already uses.
    var label = meta.hostname !== 'Unknown' ? window.esc(meta.hostname) : '';
    var html = '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:' + (meta.isStack ? '30%' : '50%') +
        ';background:' + colors.background + ';border:2px solid ' + colors.border +
        ';display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;line-height:1.05;' +
        'color:#333;text-align:center;overflow:hidden;box-sizing:border-box;padding:2px;' +
        'white-space:normal;word-break:break-word;box-shadow:0 1px 3px rgba(0,0,0,0.4);">' + label + '</div>';
    return L.divIcon({ className: '', html: html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

// Only fits the camera to the placed markers the first time markers ever appear - see
// hasFitBoundsOnce's own comment above. If the map container is currently hidden (the user
// is on Diagram view while a snapshot load/rescan triggers a re-render), Leaflet's own size
// (clientWidth/clientHeight) reads 0x0 and both invalidateSize/fitBounds would compute
// against that bogus size - so this defers instead of fitting against garbage; the pending
// first-fit is retried by switchCenterView the next time the user actually returns to Map
// view (see the `else` branch there).
function maybeFitBoundsToMarkers() {
    if (hasFitBoundsOnce || mapMarkersByIp.size === 0) return;
    var container = document.getElementById('mapview');
    if (!container || container.style.display !== 'block') return; // hidden - retry later
    leafletMap.invalidateSize();
    leafletMap.fitBounds(L.featureGroup(Array.from(mapMarkersByIp.values())).getBounds(), { padding: [40, 40] });
    hasFitBoundsOnce = true;
}

window.renderMapMarkers = function() {
    // Safe to call unconditionally from anywhere in the app (a new snapshot loading, a
    // single-device rescan merging) even if Map view has never been opened this session -
    // Leaflet itself (leafletMap) only exists once initMapView has run at least once, so
    // there is nothing to update yet; the next actual switch to Map view runs initMapView
    // and renders from current data normally.
    if (leafletMap === null) return;

    mapMarkersByIp.forEach(function (marker) { leafletMap.removeLayer(marker); });
    mapMarkersByIp.clear();
    if (window.mapEdgeLayer) { leafletMap.removeLayer(window.mapEdgeLayer); window.mapEdgeLayer = null; }

    var classification = window.TopologyGraph.computeDeviceClassification(globalTopologyData);
    var deviceByIpLocal = new Map(globalTopologyData.filter(d => d && d.DeviceIP).map(d => [String(d.DeviceIP), d]));
    var placedByIp = new Map(); // ip -> {lat, lng} for devices that resolved a location, used below for edges

    classification.forEach(function (meta, ip) {
        var device = deviceByIpLocal.get(ip); // undefined for an unscanned placeholder - resolveDeviceLocation needs a real device object
        if (!device) return; // unscanned neighbors have no chassis/serial data to resolve a location from
        var entry = window.ConfigResolve.resolveDeviceLocation(device, mapConfigEntries);
        if (!entry) return;
        // /api/save-config only validates that a `devices` key exists on the request body,
        // not the shape of each entry - a hand-crafted POST (e.g. via curl) could write a
        // malformed entry with a missing/non-numeric lat or lng. L.marker/L.polyline throw
        // Leaflet's own "Invalid LatLng object" on a non-finite coordinate, which - since
        // this runs inside a forEach with no per-entry try/catch - would abort the rest of
        // this render pass (later markers, the edge layer, the Unplaced list all never
        // render) with no visible error, wedging the map. Skip the bad entry instead.
        if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lng)) {
            console.warn('Skipping map location entry with invalid lat/lng for device ' + ip, entry);
            return;
        }

        placedByIp.set(ip, { lat: entry.lat, lng: entry.lng });
        var marker = L.marker([entry.lat, entry.lng], { icon: iconForClassification(meta) }).addTo(leafletMap);
        marker.on('click', function () { window.openRightDrawer(ip); });
        // Spec ("In-app editor", Architecture item 8): the editor is reachable from an
        // Unplaced-Devices row OR from an existing marker's popup ("Edit location") - only
        // the first half existed before this fix. Built via DOM methods (not innerHTML),
        // same reasoning as renderUnplacedDevicesList's escaping below: nothing here embeds
        // device-supplied data into markup via string concatenation. This is a second,
        // independent way to open the same window.openLocationEditor(ip) the Unplaced list
        // already calls - openLocationEditor itself doesn't change for a device that
        // already has a location.
        var popupEl = document.createElement('div');
        var editLink = document.createElement('a');
        editLink.href = '#';
        editLink.textContent = 'Edit location';
        editLink.style.cssText = 'color:var(--accent); cursor:pointer;';
        editLink.addEventListener('click', function (evt) {
            evt.preventDefault();
            marker.closePopup(); // the popup would otherwise sit over the map, blocking the click-to-place-pin the editor is about to ask for - same failure class as Task 12's modal-backdrop bug
            window.openLocationEditor(ip);
        });
        popupEl.appendChild(editLink);
        marker.bindPopup(popupEl);
        mapMarkersByIp.set(ip, marker);
    });

    var edges = window.TopologyGraph.computeNeighborEdges(globalTopologyData);
    var lines = [];
    edges.forEach(function (edge) {
        var a = placedByIp.get(edge.from), b = placedByIp.get(edge.to);
        if (!a || !b) return; // one or both ends have no resolved location - no line to draw
        lines.push(L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: '#5b7a9d', weight: 2 }));
    });
    window.mapEdgeLayer = L.layerGroup(lines).addTo(leafletMap);

    maybeFitBoundsToMarkers();

    window.renderUnplacedDevicesList(classification, deviceByIpLocal, placedByIp);
};

// Pans/zooms to the device's marker if it has a resolved location; returns whether it did,
// so search.js (Task 9) knows whether to show a "no location set" status note instead.
window.revealDeviceOnMap = function(ip) {
    var marker = mapMarkersByIp.get(String(ip));
    if (!marker) return false;
    leafletMap.setView(marker.getLatLng(), Math.max(leafletMap.getZoom(), 17), { animate: true });
    return true;
};

var editorTargetIp = null;
// keyType+':'+key (from bestKeyForSave) -> { entry, deviceIp }, accumulated across edits
// until Save. deviceIp is carried alongside the entry (not just the entry itself) so
// saveConfiguration can look the device back up via deviceByIp and collapse any of its
// OTHER stale-keyed entries at save time - see saveConfiguration's own comment below for
// why that lookup, not just the map key, is what makes the collapse possible.
var pendingConfigEdits = new Map();

// Named (not inline) so closeLocationEditor can `off` it below - `leafletMap.once` still
// only ever fires it a single time per registration, but without a name, re-opening the
// editor (or opening/cancelling repeatedly without ever clicking the map) stacks up
// once-listeners that Leaflet never got the chance to auto-remove, and each stale one would
// still overwrite #editorLat/#editorLng's values if the map were ever clicked afterward for
// an unrelated reason. Cheap to avoid, so it's handled explicitly rather than left as
// benign-but-untidy.
function onEditorMapClick(e) {
    document.getElementById('editorLat').value = e.latlng.lat.toFixed(6);
    document.getElementById('editorLng').value = e.latlng.lng.toFixed(6);
    window.showMapStatus('Pin placed at ' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) + ' - fill in the form and click Set Pin.');
}

window.openLocationEditor = function(ip) {
    editorTargetIp = ip;
    var device = deviceByIp.get(String(ip));
    document.getElementById('editorDeviceLabel').textContent = 'Set Location: ' + (device && device.Hostname !== 'Unknown' ? device.Hostname : ip);
    // This editor is reachable two ways (see renderMapMarkers's "Edit location" popup link
    // comment above): from the Unplaced Devices list, where the device by definition has no
    // resolved location yet, and from an already-placed marker's own popup, where it does.
    // Blanking the form unconditionally was correct for the first case but silently
    // discarded the existing building/room/notes (and now lat/lng) for the second the moment
    // the user hit Save (commitLocationEdit always writes whatever the form currently holds)
    // - prefill from the existing resolved entry when there is one, so re-saving without
    // touching these fields preserves them instead of wiping them to empty strings, and so
    // editing an already-placed device shows its real current coordinates instead of
    // requiring a re-click just to have something valid to save.
    var existing = device ? window.ConfigResolve.resolveDeviceLocation(device, mapConfigEntries) : null;
    document.getElementById('editorBuilding').value = existing ? (existing.building || '') : '';
    document.getElementById('editorRoom').value = existing ? (existing.room || '') : '';
    document.getElementById('editorNotes').value = existing ? (existing.notes || '') : '';
    // Number.isFinite guard (not `existing.lat || ''`) because `|| ''` would blank a
    // legitimate 0 latitude/longitude (e.g. a device placed exactly on the equator/prime
    // meridian) - unlikely for this app's real data, but the guard costs nothing.
    document.getElementById('editorLat').value = (existing && Number.isFinite(existing.lat)) ? existing.lat : '';
    document.getElementById('editorLng').value = (existing && Number.isFinite(existing.lng)) ? existing.lng : '';
    document.getElementById('location-editor-modal').style.display = 'flex';

    leafletMap.once('click', onEditorMapClick);
};

window.closeLocationEditor = function() {
    document.getElementById('location-editor-modal').style.display = 'none';
    leafletMap.off('click', onEditorMapClick);
    editorTargetIp = null;
};

window.commitLocationEdit = function() {
    var lat = parseFloat(document.getElementById('editorLat').value);
    var lng = parseFloat(document.getElementById('editorLng').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        window.showMapStatus('Enter valid latitude/longitude - click a spot on the map, or type coordinates directly.');
        return;
    }
    var device = deviceByIp.get(String(editorTargetIp));
    var keyInfo = window.ConfigResolve.bestKeyForSave(device);
    var entry = {
        key: keyInfo.key, keyType: keyInfo.keyType,
        lat: lat, lng: lng,
        building: document.getElementById('editorBuilding').value,
        room: document.getElementById('editorRoom').value,
        notes: document.getElementById('editorNotes').value,
    };
    pendingConfigEdits.set(keyInfo.keyType + ':' + keyInfo.key, { entry: entry, deviceIp: String(editorTargetIp) });
    window.closeLocationEditor();
    window.showMapStatus(pendingConfigEdits.size + ' unsaved change(s) - click Save Configuration to write them.');
    window.renderSaveConfigButton();
};

window.renderSaveConfigButton = function() {
    var existing = document.getElementById('mapSaveConfigBtn');
    if (pendingConfigEdits.size === 0) {
        if (existing) existing.remove();
        return;
    }
    if (existing) { existing.textContent = 'Save Configuration (' + pendingConfigEdits.size + ')'; return; }
    var btn = document.createElement('button');
    btn.id = 'mapSaveConfigBtn';
    btn.type = 'button';
    btn.textContent = 'Save Configuration (' + pendingConfigEdits.size + ')';
    btn.style.cssText = 'position:absolute; top:50px; right:10px; z-index:900; width:auto; padding:8px 14px;';
    btn.onclick = window.saveConfiguration;
    document.getElementById('mapview').parentElement.appendChild(btn);
};

window.saveConfiguration = async function() {
    // Merge pending edits over the currently-loaded config entries. An untouched entry
    // (its key+keyType never appears in pendingConfigEdits) survives unchanged.
    //
    // Before inserting each pending edit's entry, collapse any STALE entry left behind by a
    // key change: if a device was saved once under one key (e.g. hostname-keyed, because it
    // had no serial yet) and is now being edited again after its keys changed (e.g. a
    // rescan gave it a serial, so bestKeyForSave now returns the serial key), the old
    // hostname-keyed entry would otherwise never be removed - saveConfiguration only ever
    // added/updated by the NEW key, leaving the stale old-keyed entry sitting in
    // Configuration.json.enc forever. That's not just clutter: resolveDeviceLocation
    // (config-resolve.js) matches purely on `entry.key === value` within a keyType tier
    // with no binding to which device created the entry, so if that old key is ever reused
    // by a DIFFERENT device before that device's own serial is captured, resolution could
    // silently attach the new device to the old device's stale saved location.
    //
    // extractDeviceKeys(device) gives the device's full set of CURRENT candidate keys
    // (serial/hostname/ip, whichever are non-null) - not just the one key this particular
    // edit happens to be saved under - so this removes every one of them from `merged`,
    // regardless of which tier the device used to be keyed by, before inserting the new
    // entry under its (possibly different) current key.
    var merged = new Map(mapConfigEntries.map(function (e) { return [e.keyType + ':' + e.key, e]; }));
    pendingConfigEdits.forEach(function (pending) {
        var device = deviceByIp.get(pending.deviceIp);
        if (device) {
            var keys = window.ConfigResolve.extractDeviceKeys(device);
            ['serial', 'hostname', 'ip'].forEach(function (keyType) {
                var value = keys[keyType];
                if (value !== null && value !== undefined) merged.delete(keyType + ':' + value);
            });
        }
        merged.set(pending.entry.keyType + ':' + pending.entry.key, pending.entry);
    });
    var devices = Array.from(merged.values());

    var resp;
    try {
        resp = await fetch('/api/save-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ devices: devices }),
        });
    } catch (fetchErr) {
        // Same "must never leave the user without feedback" concern as loadMapConfiguration's
        // fetch above - an unreachable server here would otherwise be an unhandled rejection
        // from the Save button's onclick with no visible sign the click did anything.
        window.showMapStatus('Could not reach the server to save (' + fetchErr.message + '). Click Save Configuration to retry.');
        return;
    }
    if (!resp.ok) {
        window.showMapStatus('Save failed: HTTP ' + resp.status);
        return;
    }
    mapConfigEntries = devices;
    pendingConfigEdits.clear();
    window.renderSaveConfigButton();
    window.showMapStatus('Configuration saved.');
    window.renderMapMarkers();
};

window.toggleUnplacedPanel = function() {
    var list = document.getElementById('mapUnplacedList');
    var icon = document.getElementById('mapUnplacedToggleIcon');
    var collapsed = list.style.display === 'none';
    list.style.display = collapsed ? 'block' : 'none';
    icon.innerHTML = collapsed ? '&#9660;' : '&#9650;';
};

window.renderUnplacedDevicesList = function(classification, deviceByIpLocal, placedByIp) {
    var listEl = document.getElementById('mapUnplacedList');
    var countEl = document.getElementById('mapUnplacedCount');
    listEl.innerHTML = '';

    var unplaced = [];
    classification.forEach(function (meta, ip) {
        if (!meta.scanned) return;          // only scanned devices are ever geo-taggable (see Task 4's key resolution - an unscanned neighbor has no chassis data to key by)
        if (placedByIp.has(ip)) return;      // already has a resolved location
        unplaced.push({ ip: ip, meta: meta });
    });

    countEl.textContent = unplaced.length + ' device' + (unplaced.length === 1 ? '' : 's') + ' with no location set';

    unplaced.forEach(function (row) {
        var rowEl = document.createElement('div');
        rowEl.style.cssText = 'padding:6px 12px; font-size:0.8rem; border-bottom:1px solid #f0f0f0; display:flex; justify-content:space-between; align-items:center; gap:8px;';
        // row.meta.hostname/row.ip are device-supplied (LLDP/DNS data this app doesn't
        // control) and this string is assigned to .innerHTML, same as iconForClassification's
        // marker label above - escape with window.esc (utils.js) before concatenating,
        // matching the fix applied there (see Task 8's post-review XSS fix).
        var label = row.meta.hostname !== 'Unknown' ? window.esc(row.meta.hostname) : window.esc(row.ip);
        rowEl.innerHTML =
            '<span style="cursor:pointer; color:var(--accent);">' + label + '</span>' +
            '<button type="button" style="width:auto; margin:0; padding:4px 8px; font-size:0.72rem;">Set location</button>';
        rowEl.querySelector('span').addEventListener('click', function () { window.openRightDrawer(row.ip); });
        rowEl.querySelector('button').addEventListener('click', function () { window.openLocationEditor(row.ip); });
        listEl.appendChild(rowEl);
    });
};
