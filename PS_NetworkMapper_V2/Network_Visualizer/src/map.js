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

    if (view !== 'map') return;
    if (leafletMap === null) {
        window.initMapView();
    } else if (!mapConfigLoaded) {
        // A previous config load attempt was cancelled or failed (see loadMapConfiguration
        // below) - retry it on every return to Map view instead of leaving the view wedged.
        // The Leaflet instance itself is never torn down/recreated for this - only the
        // config fetch+decrypt is re-attempted.
        window.loadMapConfiguration().then(function () { window.renderMapMarkers(); });
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
    var size = 26;
    // meta.hostname is device-supplied (LLDP/DNS data this app doesn't control) and this
    // html string is rendered via Leaflet's innerHTML-based divIcon, unlike vis-network's
    // canvas-drawn (fillText) diagram labels - escape with the same window.esc (utils.js)
    // every other innerHTML-bound device string in this app already uses.
    var label = meta.hostname !== 'Unknown' ? window.esc(meta.hostname) : '';
    var html = '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:' + (meta.isStack ? '30%' : '50%') +
        ';background:' + colors.background + ';border:2px solid ' + colors.border +
        ';display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;' +
        'color:#333;text-align:center;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.4);">' + label + '</div>';
    return L.divIcon({ className: '', html: html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

window.renderMapMarkers = function() {
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

        placedByIp.set(ip, { lat: entry.lat, lng: entry.lng });
        var marker = L.marker([entry.lat, entry.lng], { icon: iconForClassification(meta) }).addTo(leafletMap);
        marker.on('click', function () { window.openRightDrawer(ip); });
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

    if (mapMarkersByIp.size > 0) {
        leafletMap.fitBounds(L.featureGroup(Array.from(mapMarkersByIp.values())).getBounds(), { padding: [40, 40] });
    }

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
var editorPendingLatLng = null;
var pendingConfigEdits = new Map(); // key (from bestKeyForSave) -> full entry object, accumulated across edits until Save

// Named (not inline) so closeLocationEditor can `off` it below - `leafletMap.once` still
// only ever fires it a single time per registration, but without a name, re-opening the
// editor (or opening/cancelling repeatedly without ever clicking the map) stacks up
// once-listeners that Leaflet never got the chance to auto-remove, and each stale one would
// still overwrite editorPendingLatLng if the map were ever clicked afterward for an
// unrelated reason. Cheap to avoid, so it's handled explicitly rather than left as
// benign-but-untidy.
function onEditorMapClick(e) {
    editorPendingLatLng = e.latlng;
    window.showMapStatus('Pin placed at ' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) + ' - fill in the form and click Set Pin.');
}

window.openLocationEditor = function(ip) {
    editorTargetIp = ip;
    editorPendingLatLng = null;
    var device = deviceByIp.get(String(ip));
    document.getElementById('editorDeviceLabel').textContent = 'Set Location: ' + (device && device.Hostname !== 'Unknown' ? device.Hostname : ip);
    document.getElementById('editorBuilding').value = '';
    document.getElementById('editorRoom').value = '';
    document.getElementById('editorNotes').value = '';
    document.getElementById('location-editor-modal').style.display = 'flex';

    leafletMap.once('click', onEditorMapClick);
};

window.closeLocationEditor = function() {
    document.getElementById('location-editor-modal').style.display = 'none';
    leafletMap.off('click', onEditorMapClick);
    editorTargetIp = null;
    editorPendingLatLng = null;
};

window.commitLocationEdit = function() {
    if (!editorPendingLatLng) {
        window.showMapStatus('Click a spot on the map first.');
        return;
    }
    var device = deviceByIp.get(String(editorTargetIp));
    var keyInfo = window.ConfigResolve.bestKeyForSave(device);
    var entry = {
        key: keyInfo.key, keyType: keyInfo.keyType,
        lat: editorPendingLatLng.lat, lng: editorPendingLatLng.lng,
        building: document.getElementById('editorBuilding').value,
        room: document.getElementById('editorRoom').value,
        notes: document.getElementById('editorNotes').value,
    };
    pendingConfigEdits.set(keyInfo.keyType + ':' + keyInfo.key, entry);
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
    // Merge pending edits over the currently-loaded config entries: an untouched entry
    // (its key+keyType never appears in pendingConfigEdits) survives unchanged, and a
    // pending edit for a device that already had an entry under the *same* key+keyType
    // replaces it in place. This does NOT collapse a device across a keyType change - an
    // edit that resolves to a device's serial (bestKeyForSave prefers serial when
    // available) is keyed 'serial:X', a completely different map key from any pre-existing
    // 'hostname:Y'/'ip:Z' entry for that same physical device, so the stale entry would
    // survive alongside the new one rather than being replaced. Harmless in practice since
    // resolveDeviceLocation (config-resolve.js) checks serial before hostname/ip and would
    // resolve to the newer entry either way, but it is a latent duplicate this merge does
    // not clean up.
    var merged = new Map(mapConfigEntries.map(function (e) { return [e.keyType + ':' + e.key, e]; }));
    pendingConfigEdits.forEach(function (entry, k) { merged.set(k, entry); });
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
