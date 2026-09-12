// Geographic map view, Leaflet-native: init, marker/edge rendering, Unplaced Devices, location editor.

var leafletMap = null;
var mapMarkersByIp = new Map();
var mapConfigEntries = [];      // decrypted Configuration.json's devices[], or [] if none loaded yet
var loadedCredentials = null;   // decrypted Configuration.json's credentials ({username, password}), or null
var loadedSettings = {};        // decrypted Configuration.json's settings (partial or empty) - merge over defaults at read time
var mapConfigLoaded = false;    // true once a GET /api/config attempt (success OR "no file yet") has completed
// In-flight promise, so simultaneous callers share one fetch and one password prompt.
var configLoadPromise = null;
// Only the first marker appearance auto-frames; otherwise every rescan resets the user's pan/zoom.
var hasFitBoundsOnce = false;

// Centre column views: 'diagram' (vis-network), 'map' (Leaflet), 'analysis' (dashboard.js).
window.switchCenterView = function(view) {
    activeCenterView = view;
    // A sibling of #mapview, not a child, so the display-toggling below misses it.
    window.showMapStatus('');
    document.getElementById('mynetwork').style.display = (view === 'diagram') ? 'block' : 'none';
    document.getElementById('mapview').style.display = (view === 'map') ? 'block' : 'none';
    document.getElementById('mapUnplacedPanel').style.display = (view === 'map') ? 'block' : 'none';
    document.getElementById('analysisview').style.display = (view === 'analysis') ? 'block' : 'none';
    // Gates the diagram-only overlays (#legend-group, #diagram-nav) via CSS.
    document.getElementById('center-panel').classList.toggle('view-diagram', view === 'diagram');
    ['diagram', 'map', 'analysis'].forEach(function (v) {
        var btn = document.getElementById('btn-center-view-' + v);
        btn.classList.toggle('active', view === v);
        btn.setAttribute('aria-pressed', String(view === v));
    });
    // Also a sibling of #mapview. Hidden rather than removed, to keep its pending-edit count.
    var saveBtn = document.getElementById('mapSaveConfigBtn');
    if (saveBtn) saveBtn.style.display = (view === 'map') ? '' : 'none';

    if (view === 'analysis') {
        // Refreshed on activation because the other refresh points skip it while hidden.
        window.refreshAnalysisDashboard();
        return;
    }
    if (view !== 'map') {
        // The network may have been built while #mynetwork was hidden, sizing its canvas against 0x0.
        if (typeof window.resizeDiagram === 'function') window.resizeDiagram();
        return;
    }

    if (leafletMap !== null) {
        // Leaflet reads 0x0 from a hidden container. invalidateSize() re-measures without moving it.
        leafletMap.invalidateSize();
    }

    if (leafletMap === null) {
        window.initMapView().catch(function (err) {
            window.showMapStatus('Failed to load map: ' + err.message);
        });
    } else if (!mapConfigLoaded) {
        // Via ensureConfigLoaded so it shares the in-flight guard instead of re-prompting.
        window.ensureConfigLoaded().then(function () {
            window.renderMapMarkers();
        }).catch(function (err) {
            window.showMapStatus('Failed to load map: ' + err.message);
        });
    } else {
        // Markers that appeared while hidden deferred their fit; retry now the size is right.
        maybeFitBoundsToMarkers();
    }
};

window.initMapView = async function() {
    leafletMap = L.map('mapview', { zoomControl: true }).setView([0, 0], 2);
    leafletMap.on('zoomend', applyLabelVisibility);
    // Keyless standard OSM tiles; no {r} retina placeholder, since OSM doesn't serve @2x.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        // OSM has no tiles past z19, so Leaflet upscales rather than 404ing - closets need the room.
        maxNativeZoom: 19,
        maxZoom: MAX_MAP_ZOOM,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(leafletMap);

    // ensureConfigLoaded returns early if Settings already loaded it, so still render explicitly.
    await window.ensureConfigLoaded();
    window.renderMapMarkers();
};

// A 404 is a normal empty state; any other failure leaves mapConfigLoaded false. Must never throw.
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
        loadedCredentials = null;
        loadedSettings = {};
        mapConfigLoaded = true;
        window.showMapStatus('');
        return;
    }
    if (!resp.ok) {
        window.showMapStatus('Failed to load Configuration.json.enc: HTTP ' + resp.status + '. Click Map again to retry.');
        mapConfigEntries = [];
        loadedCredentials = null;
        loadedSettings = {};
        mapConfigLoaded = false;
        return;
    }

    var envelope;
    try {
        envelope = await resp.json();
    } catch (parseErr) {
        window.showMapStatus('Configuration.json.enc is not valid JSON (' + parseErr.message + '). Click Map again to retry.');
        mapConfigEntries = [];
        loadedCredentials = null;
        loadedSettings = {};
        mapConfigLoaded = false;
        return;
    }

    var parsedConfig;
    // A -NoEncryption server run serves plain JSON with no envelope and no password.
    if (envelope && envelope.format === 'PSNetworkMapper-EncryptedConfig') {
        var decryptedText = null;
        var errorMsg = null;
        // Session password first, silently; the prompt is only reached if it is missing or wrong.
        var sessionPassword = await window.getSessionEncryptionPassword();
        var triedSessionPassword = false;
        while (decryptedText === null) {
            var password;
            if (sessionPassword && !triedSessionPassword) {
                password = sessionPassword;
                triedSessionPassword = true;
            } else {
                try {
                    password = await window.promptForPassword(errorMsg);
                } catch (cancelErr) {
                    window.showMapStatus('Location config decryption cancelled - devices will show without saved locations. Click Map again to retry.');
                    mapConfigEntries = [];
                    loadedCredentials = null;
                    loadedSettings = {};
                    mapConfigLoaded = false;
                    return;
                }
            }
            try {
                decryptedText = await window.TopologyCrypto.decryptEnvelope(envelope, password, ['PSNetworkMapper-EncryptedConfig']);
            } catch (decErr) {
                // Only a wrong password is retryable; a bad envelope fails for every password.
                if (!decErr.wrongPassword) {
                    window.showMapStatus('Could not decrypt Configuration.json.enc: ' + decErr.message + ' Devices will show without saved locations.');
                    mapConfigEntries = [];
                    loadedCredentials = null;
                    loadedSettings = {};
                    mapConfigLoaded = false;
                    return;
                }
                errorMsg = decErr.message;
            }
        }
        parsedConfig = JSON.parse(decryptedText);
    } else {
        parsedConfig = envelope;
    }
    mapConfigEntries = parsedConfig.devices || [];
    loadedCredentials = parsedConfig.credentials || null;
    loadedSettings = parsedConfig.settings || {};
    mapConfigLoaded = true;
    window.showMapStatus('');
};

window.getLoadedCredentials = function() {
    return loadedCredentials || { username: '', password: '' };
};

window.setLoadedCredentials = function(creds) {
    loadedCredentials = creds;
};

window.getLoadedSettings = function() {
    return loadedSettings || {};
};

window.setLoadedSettings = function(settings) {
    loadedSettings = settings;
};

// Session-wide gate. A caller about to WRITE must check the result: on failure the state is empty.
window.ensureConfigLoaded = async function() {
    if (mapConfigLoaded) return true;
    if (!configLoadPromise) {
        configLoadPromise = window.loadMapConfiguration().finally(function () { configLoadPromise = null; });
    }
    await configLoadPromise;
    if (mapConfigLoaded) window.renderMapMarkers(); // no-op if Map view was never opened
    return mapConfigLoaded;
};

// Repaints only the changed markers; a full rebuild would drop in-progress "Edit position" arming.
window.updateMapSelection = function(ip) {
    var next = (ip === null || ip === undefined) ? null : String(ip);
    if (next === selectedMapIp) return;
    var previous = selectedMapIp;
    selectedMapIp = next;
    [previous, next].forEach(function (target) {
        if (!target) return;
        var marker = mapMarkersByIp.get(target);
        if (!marker || !marker._iconState) return;
        marker.setIcon(iconForClassification(marker._iconState.meta, marker._iconState.dimmedByVlan, target === selectedMapIp));
    });
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
    // Matches applyVlanFilter's non-matching node color, for parity with the diagram.
    vlanDimmed: { background: '#f2f2f2', border: '#e6e6e6' },
    selected: { background: '#4CAF50', border: '#2E7D32' },
};

// Tracked here, not read from currentSelectedNodeData, so a pre-Map-view selection still paints.
var selectedMapIp = null;

// Selection outranks every other state, VLAN dimming included.
function iconForClassification(meta, dimmedByVlan, selected) {
    var colors = selected ? MARKER_COLORS.selected
        : !meta.scanned ? MARKER_COLORS.unscanned
        : dimmedByVlan ? MARKER_COLORS.vlanDimmed
        : (meta.isStack ? MARKER_COLORS.scannedStack : MARKER_COLORS.scanned);
    // Small and textless: Leaflet markers don't bubble clicks, so a big one made click-to-place miss.
    var size = 22;
    var html = '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:' + (meta.isStack ? '30%' : '50%') +
        ';background:' + colors.background + ';border:2px solid ' + colors.border +
        ';box-shadow:0 1px 3px rgba(0,0,0,0.4);box-sizing:border-box;"></div>';
    return L.divIcon({ className: '', html: html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

// Two levels past OSM's last real tile - 4x the z19 separation between closets in one building.
var MAX_MAP_ZOOM = 21;

// Permanent tooltips bury a campus-sized fleet at the initial fit's zoom; below this they hide.
var LABEL_MIN_ZOOM = 18;
// Below this many placed devices nothing overlaps, so hiding names would only lose information.
var LABEL_ALWAYS_BELOW = 20;

// One class, not per-tooltip toggling: hundreds of Leaflet tooltips can't be rebound during a pinch.
function applyLabelVisibility() {
    if (!leafletMap) return;
    var hide = mapMarkersByIp.size >= LABEL_ALWAYS_BELOW && leafletMap.getZoom() < LABEL_MIN_ZOOM;
    leafletMap.getContainer().classList.toggle('hide-marker-labels', hide);
}

// Defers rather than fitting against the 0x0 a hidden container reports; retried on return to Map.
function maybeFitBoundsToMarkers() {
    if (hasFitBoundsOnce || mapMarkersByIp.size === 0) return;
    var container = document.getElementById('mapview');
    if (!container || container.style.display !== 'block') return; // hidden - retry later
    leafletMap.invalidateSize();
    leafletMap.fitBounds(L.featureGroup(Array.from(mapMarkersByIp.values())).getBounds(), { padding: [40, 40] });
    hasFitBoundsOnce = true;
}

// Mirrors graph.js's computeSubtreeVlanSets; duplicated because that one walks vis-network state.
function computeMapVlanTrunkSets(nodeIds, edges, vlanCacheByIp) {
    var root = window.GraphLayout.computeGraphRoot(nodeIds, edges);
    var tree = window.GraphLayout.buildPrimaryTree(nodeIds, edges, root);
    var result = new Map();
    function visit(id) {
        if (result.has(id)) return result.get(id);
        var set = new Set(vlanCacheByIp.get(id) || []);
        result.set(id, set); // set before recursing so a cyclic childrenOf can't loop forever
        (tree.childrenOf.get(id) || []).forEach(function (childId) {
            visit(childId).forEach(function (v) { set.add(v); });
        });
        return set;
    }
    if (root) visit(root);
    // Disconnected devices buildPrimaryTree didn't reach still get their own local VLANs.
    nodeIds.forEach(function (id) { if (!result.has(id)) result.set(id, new Set(vlanCacheByIp.get(id) || [])); });
    return result;
}

function mapEdgeTrunksVlan(subtreeVlanSets, fromId, toId, vlanTag) {
    var fromSet = subtreeVlanSets.get(String(fromId));
    var toSet = subtreeVlanSets.get(String(toId));
    return !!((fromSet && fromSet.has(vlanTag)) || (toSet && toSet.has(vlanTag)));
}

window.renderMapMarkers = function() {
    if (leafletMap === null) return;

    mapMarkersByIp.forEach(function (marker) { leafletMap.removeLayer(marker); });
    mapMarkersByIp.clear();
    if (window.mapEdgeLayer) { leafletMap.removeLayer(window.mapEdgeLayer); window.mapEdgeLayer = null; }
    // Every marker is rebuilt below, so a prior arming points at an object no longer on the map.
    if (currentlyArmedMarker && currentlyArmedMarker._disarmOnMapClick) {
        leafletMap.off('click', currentlyArmedMarker._disarmOnMapClick);
    }
    currentlyArmedMarker = null;

    var classification = window.TopologyGraph.computeDeviceClassification(globalTopologyData);
    var deviceByIpLocal = new Map(globalTopologyData.filter(d => d && d.DeviceIP).map(d => [String(d.DeviceIP), d]));
    var placedByIp = new Map(); // ip -> {lat, lng}, used below for edges

    var vlanFilterEl = document.getElementById('vlanFilter');
    var selectedVlan = vlanFilterEl ? vlanFilterEl.value : 'ALL';
    var vlanCacheByIp = window.TopologyGraph.computeVlanCache(globalTopologyData);

    classification.forEach(function (meta, ip) {
        var device = deviceByIpLocal.get(ip);
        if (!device) return; // an unscanned neighbor has no chassis data to resolve a location from
        var entry = window.ConfigResolve.resolveDeviceLocation(device, mapConfigEntries);
        // pendingConfigEdits is the current state; without it a re-render reverts to the saved position.
        var pendingKeyInfo = window.ConfigResolve.bestKeyForSave(device);
        var pendingEdit = pendingConfigEdits.get(pendingKeyInfo.keyType + ':' + pendingKeyInfo.key);
        if (pendingEdit) entry = pendingEdit.entry;
        if (!entry) return;
        // A hand-crafted POST can write a non-numeric lat/lng, and L.marker throws on that.
        if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lng)) {
            console.warn('Skipping map location entry with invalid lat/lng for device ' + ip, entry);
            return;
        }

        placedByIp.set(ip, { lat: entry.lat, lng: entry.lng });
        var dimmedByVlan = selectedVlan !== 'ALL' && !(vlanCacheByIp.get(ip) || []).includes(selectedVlan.toString());
        var marker = L.marker([entry.lat, entry.lng], { icon: iconForClassification(meta, dimmedByVlan, ip === selectedMapIp) }).addTo(leafletMap);
        // Kept so updateMapSelection can regenerate this marker's icon without a full rebuild.
        marker._iconState = { meta: meta, dimmedByVlan: dimmedByVlan };
        // Leaflet sets tooltip content via innerHTML, so a device-supplied hostname is an XSS sink.
        if (meta.hostname !== 'Unknown') {
            marker.bindTooltip(window.esc(meta.hostname), {
                permanent: true, direction: 'bottom', offset: [0, 8],
                className: dimmedByVlan ? 'map-marker-label vlan-dimmed' : 'map-marker-label',
            });
        }
        marker.on('click', function () {
            // A click rather than a drag after arming means the user changed their mind.
            if (marker.dragging.enabled()) marker.dragging.disable();
            if (currentlyArmedMarker === marker) {
                currentlyArmedMarker = null;
                if (marker._disarmOnMapClick) {
                    leafletMap.off('click', marker._disarmOnMapClick);
                    marker._disarmOnMapClick = null;
                }
            }
            window.openRightDrawer(ip);
        });
        // Second entry point into openLocationEditor. Built with DOM methods, so no escaping.
        var popupEl = document.createElement('div');
        var editLink = document.createElement('a');
        editLink.href = '#';
        editLink.textContent = 'Edit location';
        editLink.style.cssText = 'color:var(--accent); cursor:pointer;';
        editLink.addEventListener('click', function (evt) {
            evt.preventDefault();
            marker.closePopup(); // otherwise it blocks the editor's click-to-place-pin
            window.openLocationEditor(ip);
        });
        popupEl.appendChild(editLink);
        // Drag-to-reposition, offered only here: an unplaced device has no marker to drag.
        var repositionLink = document.createElement('a');
        repositionLink.href = '#';
        repositionLink.textContent = 'Edit position';
        repositionLink.style.cssText = 'color:var(--accent); cursor:pointer; margin-left:10px;';
        repositionLink.addEventListener('click', function (evt) {
            evt.preventDefault();
            marker.closePopup();
            // A popup click never bubbles to leafletMap, so the armed marker's disarm would not fire.
            if (currentlyArmedMarker && currentlyArmedMarker !== marker && currentlyArmedMarker.dragging.enabled()) {
                currentlyArmedMarker.dragging.disable();
            }
            marker.dragging.enable();
            currentlyArmedMarker = marker;
            window.showMapStatus('Drag "' + (meta.hostname !== 'Unknown' ? meta.hostname : ip) + '" to reposition it - release to stage the change.');
            // Stored on the marker so dragend can `off` it: a completed drag emits no map 'click'.
            marker._disarmOnMapClick = function () {
                marker.dragging.disable();
                if (currentlyArmedMarker === marker) currentlyArmedMarker = null;
            };
            leafletMap.once('click', marker._disarmOnMapClick);
        });
        popupEl.appendChild(repositionLink);
        marker.bindPopup(popupEl);
        // Bound once at creation: it never fires until dragging is enabled.
        marker.on('dragend', function () {
            marker.dragging.disable();
            if (currentlyArmedMarker === marker) currentlyArmedMarker = null;
            if (marker._disarmOnMapClick) {
                leafletMap.off('click', marker._disarmOnMapClick);
                marker._disarmOnMapClick = null;
            }
            var newLatLng = marker.getLatLng();
            var currentDevice = deviceByIp.get(String(ip));
            // A reload mid-drag leaves the closed-over `device` stale, so re-resolve from deviceByIp.
            if (!currentDevice) {
                marker.setLatLng([entry.lat, entry.lng]); // snap back - nothing to stage
                window.showMapStatus('That device is no longer in the currently loaded data (the topology was reloaded or rescanned while dragging) - the position was not saved.');
                return;
            }
            var keyInfo = window.ConfigResolve.bestKeyForSave(currentDevice);
            var deviceKeysAtCommit = window.ConfigResolve.extractDeviceKeys(currentDevice);
            // A drag only changes lat/lng; the text fields come from a pending edit, not stale `entry`.
            var alreadyPending = pendingConfigEdits.get(keyInfo.keyType + ':' + keyInfo.key);
            var preserveFrom = alreadyPending ? alreadyPending.entry : entry;
            var newEntry = {
                key: keyInfo.key, keyType: keyInfo.keyType,
                lat: newLatLng.lat, lng: newLatLng.lng,
                building: preserveFrom.building || '', room: preserveFrom.room || '', notes: preserveFrom.notes || '',
            };
            pendingConfigEdits.set(keyInfo.keyType + ':' + keyInfo.key, {
                entry: newEntry, deviceIp: ip, deviceKeysAtCommit: deviceKeysAtCommit,
            });
            window.showMapStatus(pendingConfigEdits.size + ' unsaved change(s) - click Save Configuration to write them.');
            window.renderSaveConfigButton();
        });
        mapMarkersByIp.set(ip, marker);
    });

    var edges = window.TopologyGraph.computeNeighborEdges(globalTopologyData);
    // Links trunking the selected VLAN are emphasized, others fade - matching the diagram.
    var subtreeVlanSets = selectedVlan !== 'ALL'
        ? computeMapVlanTrunkSets(Array.from(classification.keys()), edges, vlanCacheByIp)
        : null;
    var lines = [];
    edges.forEach(function (edge) {
        var a = placedByIp.get(edge.from), b = placedByIp.get(edge.to);
        if (!a || !b) return; // one or both ends have no resolved location - no line to draw
        var color = '#5b7a9d', weight = 2;
        if (subtreeVlanSets) {
            var trunks = mapEdgeTrunksVlan(subtreeVlanSets, edge.from, edge.to, selectedVlan.toString());
            color = trunks ? '#2B7CE9' : '#e6e6e6';
            weight = trunks ? 3 : 1;
        }
        lines.push(L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: color, weight: weight }));
    });
    window.mapEdgeLayer = L.layerGroup(lines).addTo(leafletMap);

    maybeFitBoundsToMarkers();
    // After the markers and any fit: both the zoom and the marker count decide this.
    applyLabelVisibility();

    window.renderUnplacedDevicesList(classification, deviceByIpLocal, placedByIp);
};

// Returns whether the device had a marker, so the caller can report "no location set" instead.
window.revealDeviceOnMap = function(ip) {
    var marker = mapMarkersByIp.get(String(ip));
    if (!marker) return false;
    // LABEL_MIN_ZOOM, so the device this reveals arrives with its name showing.
    leafletMap.setView(marker.getLatLng(), Math.max(leafletMap.getZoom(), LABEL_MIN_ZOOM), { animate: true });
    return true;
};

// Leaflet markers don't bubble clicks, so B's arming code must disarm A to keep at most one.
var currentlyArmedMarker = null;

var editorTargetIp = null;
// keyType+':'+key -> { entry, deviceIp, deviceKeysAtCommit }, accumulated until Save. The keys are
// snapshotted at commit time; re-resolving at save time deleted the wrong device's location.
var pendingConfigEdits = new Map();

// Staged edits live only in memory until Save, so a reload would discard them silently.
window.addEventListener('beforeunload', function (e) {
    if (pendingConfigEdits.size === 0) return;
    e.preventDefault();
    e.returnValue = '';
});

// Named so closeLocationEditor can `off` it; anonymous listeners stack up across open/cancel cycles.
function onEditorMapClick(e) {
    document.getElementById('editorLat').value = e.latlng.lat.toFixed(6);
    document.getElementById('editorLng').value = e.latlng.lng.toFixed(6);
    window.showMapStatus('Pin placed at ' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) + ' - fill in the form and click Set Pin.');
}

window.openLocationEditor = function(ip) {
    editorTargetIp = ip;
    var device = deviceByIp.get(String(ip));
    document.getElementById('editorDeviceLabel').textContent = 'Set Location: ' + (device && device.Hostname !== 'Unknown' ? device.Hostname : ip);
    // Prefilled so re-saving an untouched field doesn't wipe it; an unsaved drag beats the saved entry.
    var deviceKeyInfo = device ? window.ConfigResolve.bestKeyForSave(device) : null;
    var pending = deviceKeyInfo ? pendingConfigEdits.get(deviceKeyInfo.keyType + ':' + deviceKeyInfo.key) : null;
    var existing = pending ? pending.entry : (device ? window.ConfigResolve.resolveDeviceLocation(device, mapConfigEntries) : null);
    document.getElementById('editorBuilding').value = existing ? (existing.building || '') : '';
    document.getElementById('editorRoom').value = existing ? (existing.room || '') : '';
    document.getElementById('editorNotes').value = existing ? (existing.notes || '') : '';
    // Number.isFinite, not `existing.lat || ''`, which would blank a legitimate 0.
    document.getElementById('editorLat').value = (existing && Number.isFinite(existing.lat)) ? existing.lat : '';
    document.getElementById('editorLng').value = (existing && Number.isFinite(existing.lng)) ? existing.lng : '';
    document.getElementById('location-editor-modal').style.display = 'flex';

    // Reopening for a different device without closing first would stack up extra once-listeners.
    leafletMap.off('click', onEditorMapClick);
    leafletMap.once('click', onEditorMapClick);
};

window.closeLocationEditor = function() {
    document.getElementById('location-editor-modal').style.display = 'none';
    // leafletMap is null until Map view has been opened, and app.js calls this on every load.
    if (leafletMap) leafletMap.off('click', onEditorMapClick);
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
    // The backdrop is pointer-events:none, so a load can replace deviceByIp while the editor is open.
    if (!device) {
        window.closeLocationEditor();
        window.showMapStatus('That device is no longer in the currently loaded data (the topology was reloaded or rescanned while this editor was open) - the location was not saved. Reopen the editor from the device on the current map.');
        return;
    }
    var keyInfo = window.ConfigResolve.bestKeyForSave(device);
    var deviceKeysAtCommit = window.ConfigResolve.extractDeviceKeys(device);
    var entry = {
        key: keyInfo.key, keyType: keyInfo.keyType,
        lat: lat, lng: lng,
        building: document.getElementById('editorBuilding').value,
        room: document.getElementById('editorRoom').value,
        notes: document.getElementById('editorNotes').value,
    };
    pendingConfigEdits.set(keyInfo.keyType + ':' + keyInfo.key, {
        entry: entry, deviceIp: String(editorTargetIp), deviceKeysAtCommit: deviceKeysAtCommit,
    });
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

// A key clears only if the entry still under it is by reference the one actually sent.
function computeSaveKeysToClear(includedKeys, includedEditsSnapshot, pendingConfigEditsNow) {
    return includedKeys.filter(function (key) {
        return pendingConfigEditsNow.get(key) === includedEditsSnapshot.get(key);
    });
}

window.saveConfiguration = async function() {
    // On a failed load the in-memory state is EMPTY, so saving would overwrite everything stored.
    var loaded = await window.ensureConfigLoaded();
    if (!loaded) {
        window.showMapStatus('Cannot save - the existing configuration has not loaded (password prompt was cancelled or the server could not be reached). Click Save Configuration again once it loads.');
        return false;
    }

    // Snapshotted before the request: an entry added mid-save must survive rather than be cleared.
    var includedKeys = Array.from(pendingConfigEdits.keys());
    var includedEditsSnapshot = new Map(includedKeys.map(function (k) { return [k, pendingConfigEdits.get(k)]; }));

    // Every candidate key the device had at commit time is deleted first, so an old key can't linger.
    var merged = new Map(mapConfigEntries.map(function (e) { return [e.keyType + ':' + e.key, e]; }));
    includedEditsSnapshot.forEach(function (pending) {
        var keys = pending.deviceKeysAtCommit;
        ['serial', 'hostname', 'ip'].forEach(function (keyType) {
            var value = keys[keyType];
            if (value !== null && value !== undefined) merged.delete(keyType + ':' + value);
        });
        merged.set(pending.entry.keyType + ':' + pending.entry.key, pending.entry);
    });
    var devices = Array.from(merged.values());

    var resp;
    try {
        resp = await fetch('/api/save-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ devices: devices, credentials: loadedCredentials, settings: loadedSettings }),
        });
    } catch (fetchErr) {
        window.showMapStatus('Could not reach the server to save (' + fetchErr.message + '). Click Save Configuration to retry.');
        return false;
    }
    if (!resp.ok) {
        // The server returns a JSON {error} body naming the actual validation failure.
        var serverMessage = null;
        try {
            var errBody = await resp.json();
            if (errBody && typeof errBody.error === 'string' && errBody.error) {
                serverMessage = errBody.error;
            }
        } catch (parseErr) {}
        window.showMapStatus('Save failed: ' + (serverMessage || ('HTTP ' + resp.status)));
        return false;
    }
    mapConfigEntries = devices;
    computeSaveKeysToClear(includedKeys, includedEditsSnapshot, pendingConfigEdits).forEach(function (key) {
        pendingConfigEdits.delete(key);
    });
    window.renderSaveConfigButton();
    window.showMapStatus(pendingConfigEdits.size > 0
        ? 'Configuration saved. ' + pendingConfigEdits.size + ' more unsaved change(s) made during the save - click Save Configuration to write them.'
        : 'Configuration saved.');
    window.renderMapMarkers();
    return true;
};

window.toggleUnplacedPanel = function() {
    var list = document.getElementById('mapUnplacedList');
    var icon = document.getElementById('mapUnplacedToggleIcon');
    var collapsed = list.style.display === 'none';
    list.style.display = collapsed ? 'block' : 'none';
    icon.innerHTML = collapsed ? '&#9660;' : '&#9650;';
};

// Snapshotted by the render below so the CSV export matches the panel without re-filtering.
var unplacedDevicesForExport = [];

window.renderUnplacedDevicesList = function(classification, deviceByIpLocal, placedByIp) {
    var listEl = document.getElementById('mapUnplacedList');
    var countEl = document.getElementById('mapUnplacedCount');
    var exportBtn = document.getElementById('mapUnplacedExportBtn');
    listEl.innerHTML = '';

    var unplaced = [];
    classification.forEach(function (meta, ip) {
        if (!meta.scanned) return;          // an unscanned neighbor has no chassis data to key by
        if (placedByIp.has(ip)) return;
        unplaced.push({ ip: ip, meta: meta, device: deviceByIpLocal.get(ip) });
    });

    countEl.textContent = unplaced.length + ' device' + (unplaced.length === 1 ? '' : 's') + ' with no location set';
    unplacedDevicesForExport = unplaced;
    if (exportBtn) exportBtn.style.display = unplaced.length > 0 ? '' : 'none';

    unplaced.forEach(function (row) {
        var rowEl = document.createElement('div');
        rowEl.style.cssText = 'padding:6px 12px; font-size:0.8rem; border-bottom:1px solid #f0f0f0; display:flex; justify-content:space-between; align-items:center; gap:8px;';
        // Device-supplied (LLDP/DNS) and assigned via innerHTML below, so esc is required.
        var label = row.meta.hostname !== 'Unknown' ? window.esc(row.meta.hostname) : window.esc(row.ip);
        rowEl.innerHTML =
            '<span style="cursor:pointer; color:var(--accent);">' + label + '</span>' +
            '<button type="button" style="width:auto; margin:0; padding:4px 8px; font-size:0.72rem;">Set location</button>';
        rowEl.querySelector('span').addEventListener('click', function () { window.openRightDrawer(row.ip); });
        rowEl.querySelector('button').addEventListener('click', function () { window.openLocationEditor(row.ip); });
        listEl.appendChild(rowEl);
    });
};

// A worklist for whoever walks the building placing pins. Serial comes from extractDeviceKeys.
window.exportUnplacedDevicesCsv = function() {
    if (unplacedDevicesForExport.length === 0) return;
    var rows = [['Hostname', 'IP', 'Serial', 'Model', 'Junos Version', 'Uptime']];
    unplacedDevicesForExport.forEach(function (row) {
        var device = row.device;
        var keys = device ? window.ConfigResolve.extractDeviceKeys(device) : null;
        var stackMember0 = device ? window.asArray(device.StackMembers)[0] : null;
        var model = stackMember0 ? stackMember0.Model : '';
        rows.push([
            row.meta.hostname !== 'Unknown' ? row.meta.hostname : '',
            row.ip,
            (keys && keys.serial) ? keys.serial : '',
            model || '',
            device ? device.JunosVersion : '',
            device ? device.Uptime : '',
        ]);
    });
    downloadCsv('unplaced_devices.csv', rows);
};
