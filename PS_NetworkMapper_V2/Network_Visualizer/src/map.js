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

// Replaced by Task 11 - intentionally empty for now.
window.renderUnplacedDevicesList = function(classification, deviceByIpLocal, placedByIp) {
};
