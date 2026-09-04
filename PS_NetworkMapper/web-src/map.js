// Geographic map view: Leaflet-native rendering (not vis-network - unreliable when synced
// onto a Leaflet map). Owns Leaflet init, marker/edge rendering from the same topology data
// + classification the diagram uses (via TopologyGraph/ConfigResolve), the Unplaced Devices
// list, and the location editor. Reads globalTopologyData/deviceByIp (app.js), calls into
// drawer.js's openRightDrawer for details-drawer parity with the diagram.

var leafletMap = null;
var mapMarkersByIp = new Map();
var mapConfigEntries = [];      // decrypted Configuration.json's devices[], or [] if none loaded yet
var loadedCredentials = null;   // decrypted Configuration.json's credentials ({username, password}), or null
var loadedSettings = {};        // decrypted Configuration.json's settings (partial or empty) - merge over defaults at read time
var mapConfigLoaded = false;    // true once a GET /api/config attempt (success OR "no file yet") has completed
// In-flight loadMapConfiguration promise, so near-simultaneous ensureConfigLoaded callers
// share one fetch+password-prompt instead of racing two. Cleared once the load settles.
var configLoadPromise = null;
// True once fitBounds has run against real markers. renderMapMarkers fires on every topology
// change, so only the first marker appearance auto-frames the camera - otherwise every
// rescan/snapshot switch would reset the user's pan/zoom.
var hasFitBoundsOnce = false;

// Centre column views: 'diagram' (vis-network), 'map' (Leaflet), 'analysis' (dashboard.js's
// Analysis Dashboard - tables/charts that need this column's width, not the sidebar's).
window.switchCenterView = function(view) {
    activeCenterView = view;
    // #mapStatusNote is a sibling of #mapview, not a child, so it isn't covered by the
    // display-toggling below - clear it explicitly or it floats over the next view.
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
    // Same leak class as #mapStatusNote above: the floating Save button is also a sibling
    // of #mapview, so hide (not remove) it here to preserve its pending-edit count.
    var saveBtn = document.getElementById('mapSaveConfigBtn');
    if (saveBtn) saveBtn.style.display = (view === 'map') ? '' : 'none';

    if (view === 'analysis') {
        // Its render functions read the live topology, so a hidden dashboard is never
        // stale for long: refresh on every activation (setActiveSnapshot / rescan merges
        // refresh it too, but only while it's the view showing).
        window.refreshAnalysisDashboard();
        return;
    }
    if (view !== 'map') {
        // buildSwitchMap may have (re)created the vis.Network instance while #mynetwork was
        // hidden, sizing its canvas against a bogus 0x0 - force a re-measure now it's visible.
        if (typeof window.resizeDiagram === 'function') window.resizeDiagram();
        return;
    }

    if (leafletMap !== null) {
        // Markers/camera moves may have happened while #mapview was hidden - Leaflet reads
        // 0x0 from a display:none container, so tiles for the real viewport never loaded.
        // invalidateSize() re-measures and repaints without touching center/zoom.
        leafletMap.invalidateSize();
    }

    if (leafletMap === null) {
        window.initMapView().catch(function (err) {
            window.showMapStatus('Failed to load map: ' + err.message);
        });
    } else if (!mapConfigLoaded) {
        // A previous config load was cancelled or failed - retry via ensureConfigLoaded
        // (not loadMapConfiguration directly) so it shares the "already loaded" and
        // in-flight-promise guards with the Settings tab instead of double-prompting.
        window.ensureConfigLoaded().then(function () {
            window.renderMapMarkers();
        }).catch(function (err) {
            window.showMapStatus('Failed to load map: ' + err.message);
        });
    } else {
        // If markers first appeared while this view was hidden, the fit was deferred against
        // the bogus 0x0 size - retry now that invalidateSize() above sized it correctly.
        maybeFitBoundsToMarkers();
    }
};

window.initMapView = async function() {
    leafletMap = L.map('mapview', { zoomControl: true }).setView([0, 0], 2);
    // Keyless standard OSM tiles - CARTO's free tier now requires registration and watermarks
    // otherwise. No {r} retina placeholder: the OSM tile server doesn't serve @2x tiles.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(leafletMap);

    // ensureConfigLoaded, not loadMapConfiguration: the Settings tab may have already loaded
    // (and password-prompted for) the config, and calling loadMapConfiguration unconditionally
    // would re-prompt for the same password. It doesn't render on an already-loaded early
    // return, so renderMapMarkers below is still needed for that case.
    await window.ensureConfigLoaded();
    window.renderMapMarkers();
};

// Fetches and decrypts Configuration.json.enc (if any). Sets mapConfigEntries/mapConfigLoaded.
// A missing file (404, fresh checkout) is a normal empty state (mapConfigLoaded=true, nothing
// to retry). A cancelled password prompt or a network/parse failure is reported via
// showMapStatus and leaves mapConfigLoaded=false so switchCenterView's retry path can
// re-attempt it. Must never throw/reject - initMapView awaits it with nothing to catch a rejection.
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
    // A -NoEncryption server run serves Configuration.json as plain JSON directly - no
    // envelope, no password. Same format check app.js's readSnapshotFile uses.
    if (envelope && envelope.format === 'PSNetworkMapper-EncryptedConfig') {
        var decryptedText = null;
        var errorMsg = null;
        // Try the session password silently first (Start-NetworkMapper.ps1 already prompted
        // for it server-side); fall through to promptForPassword if unavailable or wrong.
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

// Idempotent, session-wide "make sure the config has been fetched" gate - Map view and the
// Settings tab both call this instead of loadMapConfiguration directly, so the password
// prompt and fetch happen at most once per session. Returns whether the config is actually
// loaded (false if the attempt failed/was cancelled). Callers about to WRITE the config
// (saveConfiguration, saveSettingsPanel) must check this and bail: on failure
// mapConfigEntries/loadedCredentials/loadedSettings are reset to empty, and proceeding would
// POST that empty state over everything previously saved.
window.ensureConfigLoaded = async function() {
    if (mapConfigLoaded) return true;
    if (!configLoadPromise) {
        configLoadPromise = window.loadMapConfiguration().finally(function () { configLoadPromise = null; });
    }
    await configLoadPromise;
    if (mapConfigLoaded) window.renderMapMarkers(); // no-op if Map view was never opened (leafletMap === null)
    return mapConfigLoaded;
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
    // Matches graph.js's applyVlanFilter "non-matching VLAN" node color for visual parity.
    vlanDimmed: { background: '#f2f2f2', border: '#e6e6e6' },
};

// dimmedByVlan: true when a VLAN filter is active and this device's clients don't carry the
// selected tag. Unscanned placeholders have no client data and always stay plain gray.
function iconForClassification(meta, dimmedByVlan) {
    var colors = !meta.scanned ? MARKER_COLORS.unscanned
        : dimmedByVlan ? MARKER_COLORS.vlanDimmed
        : (meta.isStack ? MARKER_COLORS.scannedStack : MARKER_COLORS.scanned);
    // Hostname is not drawn inside the circle - a larger circle to fit text also grows the
    // click target, and Leaflet markers default to bubblingMouseEvents:false, so an oversized
    // marker made the location editor's click-to-place-pin miss more often in clustered areas.
    // Kept small (22px, no text); the hostname is a separate tooltip below it (renderMapMarkers).
    var size = 22;
    var html = '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:' + (meta.isStack ? '30%' : '50%') +
        ';background:' + colors.background + ';border:2px solid ' + colors.border +
        ';box-shadow:0 1px 3px rgba(0,0,0,0.4);box-sizing:border-box;"></div>';
    return L.divIcon({ className: '', html: html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

// Fits the camera only the first time markers ever appear (see hasFitBoundsOnce). If the
// map container is hidden, Leaflet reads 0x0 size, so this defers rather than fitting
// against garbage - retried by switchCenterView's `else` branch on the next return to Map.
function maybeFitBoundsToMarkers() {
    if (hasFitBoundsOnce || mapMarkersByIp.size === 0) return;
    var container = document.getElementById('mapview');
    if (!container || container.style.display !== 'block') return; // hidden - retry later
    leafletMap.invalidateSize();
    leafletMap.fitBounds(L.featureGroup(Array.from(mapMarkersByIp.values())).getBounds(), { padding: [40, 40] });
    hasFitBoundsOnce = true;
}

// Bottom-up "which VLANs are reachable behind this edge", mirroring graph.js's
// computeSubtreeVlanSets/edgeTrunksVlan. Duplicated rather than shared: graph.js's version
// walks vis-network-diagram state that may not exist if Diagram view was never opened -
// this builds its own root/tree from the map's own node/edge set instead.
function computeMapVlanTrunkSets(nodeIds, edges, vlanCacheByIp) {
    var root = window.GraphLayout.computeGraphRoot(nodeIds, edges);
    var tree = window.GraphLayout.buildPrimaryTree(nodeIds, edges, root);
    var result = new Map();
    function visit(id) {
        if (result.has(id)) return result.get(id); // guards a malformed/cyclic childrenOf, cheap either way
        var set = new Set(vlanCacheByIp.get(id) || []);
        result.set(id, set); // set before recursing so a cycle can't loop forever
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
    // Safe to call unconditionally even if Map view was never opened this session - Leaflet
    // (leafletMap) only exists once initMapView has run, so there's nothing to update yet.
    if (leafletMap === null) return;

    mapMarkersByIp.forEach(function (marker) { leafletMap.removeLayer(marker); });
    mapMarkersByIp.clear();
    if (window.mapEdgeLayer) { leafletMap.removeLayer(window.mapEdgeLayer); window.mapEdgeLayer = null; }
    // Every marker is about to be torn down and rebuilt - any prior "Edit position" arming
    // pointed at an object that no longer exists on the map.
    if (currentlyArmedMarker && currentlyArmedMarker._disarmOnMapClick) {
        leafletMap.off('click', currentlyArmedMarker._disarmOnMapClick);
    }
    currentlyArmedMarker = null;

    var classification = window.TopologyGraph.computeDeviceClassification(globalTopologyData);
    var deviceByIpLocal = new Map(globalTopologyData.filter(d => d && d.DeviceIP).map(d => [String(d.DeviceIP), d]));
    var placedByIp = new Map(); // ip -> {lat, lng} for devices that resolved a location, used below for edges

    // Same #vlanFilter <select> the diagram's applyVlanFilter (graph.js) reads - one shared
    // control, read live off the DOM so a filter change is picked up on the next render.
    var vlanFilterEl = document.getElementById('vlanFilter');
    var selectedVlan = vlanFilterEl ? vlanFilterEl.value : 'ALL';
    var vlanCacheByIp = window.TopologyGraph.computeVlanCache(globalTopologyData);

    classification.forEach(function (meta, ip) {
        var device = deviceByIpLocal.get(ip); // undefined for an unscanned placeholder - resolveDeviceLocation needs a real device object
        if (!device) return; // unscanned neighbors have no chassis/serial data to resolve a location from
        var entry = window.ConfigResolve.resolveDeviceLocation(device, mapConfigEntries);
        // A drag (or the location editor) may have staged an edit for this device that hasn't
        // been saved yet - pendingConfigEdits, not mapConfigEntries, is the most current state.
        // Overlay it here so a re-render triggered by a VLAN filter change, snapshot switch, or
        // rescan (all of which call renderMapMarkers) doesn't visually snap the marker back to
        // its last-SAVED position while the "N unsaved changes" indicator still (correctly)
        // shows the newer edit as pending. Same key resolution saveConfiguration/the drag
        // handler/commitLocationEdit use to look up a pending edit for this device - reused
        // here rather than re-derived, so it can't drift from how edits are staged/saved.
        // Also covers a device with no prior saved location (resolveDeviceLocation above
        // returned null) that just got placed via the location editor - that edit exists only
        // in pendingConfigEdits until Save, so without this the marker wouldn't render at all.
        var pendingKeyInfo = window.ConfigResolve.bestKeyForSave(device);
        var pendingEdit = pendingConfigEdits.get(pendingKeyInfo.keyType + ':' + pendingKeyInfo.key);
        if (pendingEdit) entry = pendingEdit.entry;
        if (!entry) return;
        // /api/save-config doesn't validate entry shape, so a hand-crafted POST could write a
        // non-numeric lat/lng. L.marker throws on that, which would abort this whole forEach
        // (no per-entry try/catch) and wedge the map - skip the bad entry instead.
        if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lng)) {
            console.warn('Skipping map location entry with invalid lat/lng for device ' + ip, entry);
            return;
        }

        placedByIp.set(ip, { lat: entry.lat, lng: entry.lng });
        var dimmedByVlan = selectedVlan !== 'ALL' && !(vlanCacheByIp.get(ip) || []).includes(selectedVlan.toString());
        var marker = L.marker([entry.lat, entry.lng], { icon: iconForClassification(meta, dimmedByVlan) }).addTo(leafletMap);
        // Hostname label lives in a permanent tooltip below the marker, not inside the circle
        // (see iconForClassification). window.esc is required: Leaflet's DivOverlay sets
        // tooltip content via innerHTML, so an unescaped hostname would be an XSS sink.
        if (meta.hostname !== 'Unknown') {
            // dimmedByVlan fades the label too (.vlan-dimmed in network_vis.html), matching
            // applyVlanFilter's (graph.js) font-dimming for a non-matching diagram node.
            marker.bindTooltip(window.esc(meta.hostname), {
                permanent: true, direction: 'bottom', offset: [0, 8],
                className: dimmedByVlan ? 'map-marker-label vlan-dimmed' : 'map-marker-label',
            });
        }
        marker.on('click', function () {
            // A plain click (not a drag) after "Edit position" armed dragging means the user
            // changed their mind - disarm rather than leaving the marker draggable
            // indefinitely (dragging.enable() has no other timeout/blur to turn it back off).
            // No-op if a real drag already disabled it via dragend below.
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
        // Second entry point into the same window.openLocationEditor(ip) the Unplaced list
        // uses, so an already-placed marker can also edit its location. Built via DOM methods
        // (not innerHTML) since nothing here needs escaping.
        var popupEl = document.createElement('div');
        var editLink = document.createElement('a');
        editLink.href = '#';
        editLink.textContent = 'Edit location';
        editLink.style.cssText = 'color:var(--accent); cursor:pointer;';
        editLink.addEventListener('click', function (evt) {
            evt.preventDefault();
            marker.closePopup(); // otherwise sits over the map, blocking the editor's click-to-place-pin
            window.openLocationEditor(ip);
        });
        popupEl.appendChild(editLink);
        // Lighter alternative to "Edit location" above - repositions this one marker by drag
        // instead of opening the full building/room/notes modal. Only offered here (an
        // already-placed marker); an unplaced device has no marker yet to drag.
        var repositionLink = document.createElement('a');
        repositionLink.href = '#';
        repositionLink.textContent = 'Edit position';
        repositionLink.style.cssText = 'color:var(--accent); cursor:pointer; margin-left:10px;';
        repositionLink.addEventListener('click', function (evt) {
            evt.preventDefault();
            marker.closePopup();
            // Only one marker is ever draggable at a time - disarm whichever marker was
            // previously armed (bubblingMouseEvents:false means clicking THIS marker to open
            // its popup never reached leafletMap's 'click' handler, so the previous marker's
            // one-shot disarm listener below would otherwise never fire).
            if (currentlyArmedMarker && currentlyArmedMarker !== marker && currentlyArmedMarker.dragging.enabled()) {
                currentlyArmedMarker.dragging.disable();
            }
            marker.dragging.enable();
            currentlyArmedMarker = marker;
            window.showMapStatus('Drag "' + (meta.hostname !== 'Unknown' ? meta.hostname : ip) + '" to reposition it - release to stage the change.');
            // Covers "changed their mind and clicked elsewhere on the map" - the marker's own
            // click handler above covers "clicked the marker itself instead of dragging it".
            // Harmless no-op if a real drag already disabled dragging by the time this fires.
            // Stored on the marker so the dragend handler below can `off` it on a successful
            // drag - a completed drag doesn't emit a map 'click', so without this the listener
            // would otherwise dangle until some unrelated future map click consumed it.
            marker._disarmOnMapClick = function () {
                marker.dragging.disable();
                if (currentlyArmedMarker === marker) currentlyArmedMarker = null;
            };
            leafletMap.once('click', marker._disarmOnMapClick);
        });
        popupEl.appendChild(repositionLink);
        marker.bindPopup(popupEl);
        // Bound once at creation, not inside the click handler above - dragging.enable()/
        // disable() only toggles whether drags are possible, this listener just no-ops
        // (never fires) until "Edit position" arms it.
        marker.on('dragend', function () {
            marker.dragging.disable();
            if (currentlyArmedMarker === marker) currentlyArmedMarker = null;
            // A completed drag doesn't emit a map 'click', so the arm-time disarm listener
            // (see "Edit position" above) never fires on its own - remove it explicitly here
            // to avoid leaving a dangling one-shot listener on leafletMap.
            if (marker._disarmOnMapClick) {
                leafletMap.off('click', marker._disarmOnMapClick);
                marker._disarmOnMapClick = null;
            }
            var newLatLng = marker.getLatLng();
            var currentDevice = deviceByIp.get(String(ip));
            // Guarded the same way commitLocationEdit is - a snapshot reload/rescan while
            // this marker was mid-drag can leave `device` (the classification-time capture
            // above) stale relative to deviceByIp.
            if (!currentDevice) {
                marker.setLatLng([entry.lat, entry.lng]); // snap back - nothing to stage
                window.showMapStatus('That device is no longer in the currently loaded data (the topology was reloaded or rescanned while dragging) - the position was not saved.');
                return;
            }
            var keyInfo = window.ConfigResolve.bestKeyForSave(currentDevice);
            var deviceKeysAtCommit = window.ConfigResolve.extractDeviceKeys(currentDevice);
            // Preserves building/room/notes - a drag only ever changes lat/lng. Prefers an
            // already-pending edit (e.g. from "Edit location") over the render-time `entry`
            // closure above, which is the last-SAVED value and would otherwise silently
            // revert an unsaved building/room/notes edit made since this marker was drawn.
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
    // Links trunking the selected VLAN are emphasized, others fade - matches applyVlanFilter's
    // edge pass (graph.js). Only computed when a VLAN is selected.
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

// The marker (if any) currently armed for drag-to-reposition via "Edit position" below.
// Leaflet markers default to bubblingMouseEvents:false, so clicking marker B to open its own
// popup never bubbles to leafletMap's 'click' handler and can't disarm marker A's one-shot
// listener that way - only tracking the armed marker explicitly and disarming it here (when
// a DIFFERENT marker gets armed) guarantees at most one marker is ever draggable at a time.
var currentlyArmedMarker = null;

var editorTargetIp = null;
// keyType+':'+key (from bestKeyForSave) -> { entry, deviceIp, deviceKeysAtCommit },
// accumulated across edits until Save. deviceKeysAtCommit snapshots the device's full
// extractDeviceKeys() at commit time (not re-derived at save time): saveConfiguration uses
// it to collapse that device's other stale-keyed entries. Re-resolving via deviceByIp.get()
// at save time was wrong if that IP got reassigned to a different device meanwhile (DHCP
// churn) - it would delete the wrong device's saved location. deviceIp is now kept only for
// diagnostics.
var pendingConfigEdits = new Map();

// Staged edits (drags, location-editor commits) live only in pendingConfigEdits above until
// Save Configuration is clicked - a reload/close before that silently discards them despite
// the "N unsaved changes" status text. Warn via the browser's native confirmation.
window.addEventListener('beforeunload', function (e) {
    if (pendingConfigEdits.size === 0) return;
    e.preventDefault();
    e.returnValue = '';
});

// Named (not inline) so closeLocationEditor can `off` it - without a name, repeated
// open/cancel of the editor stacks up stale once-listeners that could still overwrite
// #editorLat/#editorLng on an unrelated later map click.
function onEditorMapClick(e) {
    document.getElementById('editorLat').value = e.latlng.lat.toFixed(6);
    document.getElementById('editorLng').value = e.latlng.lng.toFixed(6);
    window.showMapStatus('Pin placed at ' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) + ' - fill in the form and click Set Pin.');
}

window.openLocationEditor = function(ip) {
    editorTargetIp = ip;
    var device = deviceByIp.get(String(ip));
    document.getElementById('editorDeviceLabel').textContent = 'Set Location: ' + (device && device.Hostname !== 'Unknown' ? device.Hostname : ip);
    // Editor is reachable both from the Unplaced list (no existing location) and from an
    // already-placed marker's popup - prefill from the existing entry when there is one, so
    // re-saving without touching a field doesn't wipe it to empty. A not-yet-saved drag (see
    // "Edit position" above) takes priority over the saved config entry - otherwise clicking
    // Set Pin here without touching lat/lng would silently overwrite the drag with the old,
    // pre-drag position (both write into the same pendingConfigEdits key).
    var deviceKeyInfo = device ? window.ConfigResolve.bestKeyForSave(device) : null;
    var pending = deviceKeyInfo ? pendingConfigEdits.get(deviceKeyInfo.keyType + ':' + deviceKeyInfo.key) : null;
    var existing = pending ? pending.entry : (device ? window.ConfigResolve.resolveDeviceLocation(device, mapConfigEntries) : null);
    document.getElementById('editorBuilding').value = existing ? (existing.building || '') : '';
    document.getElementById('editorRoom').value = existing ? (existing.room || '') : '';
    document.getElementById('editorNotes').value = existing ? (existing.notes || '') : '';
    // Number.isFinite guard, not `existing.lat || ''` - that would blank a legitimate 0
    // (equator/prime meridian).
    document.getElementById('editorLat').value = (existing && Number.isFinite(existing.lat)) ? existing.lat : '';
    document.getElementById('editorLng').value = (existing && Number.isFinite(existing.lng)) ? existing.lng : '';
    document.getElementById('location-editor-modal').style.display = 'flex';

    // Remove any previous registration first - reopening the editor for a different device
    // (e.g. via a still-open popup's "Edit location" link) without closing it first would
    // otherwise stack up additional once-listeners alongside this one.
    leafletMap.off('click', onEditorMapClick);
    leafletMap.once('click', onEditorMapClick);
};

window.closeLocationEditor = function() {
    document.getElementById('location-editor-modal').style.display = 'none';
    // leafletMap is null until Map view has been opened - guarded since this is also called
    // defensively from app.js's processSelectedFiles on every file load.
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
    // The editor's backdrop is pointer-events:none, so a Scan/snapshot load can replace
    // deviceByIp while it's open, leaving editorTargetIp stale. bestKeyForSave(undefined)
    // would throw and trigger the fatal-error modal - guard against that.
    if (!device) {
        window.closeLocationEditor();
        window.showMapStatus('That device is no longer in the currently loaded data (the topology was reloaded or rescanned while this editor was open) - the location was not saved. Reopen the editor from the device on the current map.');
        return;
    }
    var keyInfo = window.ConfigResolve.bestKeyForSave(device);
    // Snapshotted at commit time, not re-resolved at save time - see pendingConfigEdits above.
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

// Pure helper (exported below for node:test): which pendingConfigEdits keys are safe to
// remove after a successful save. A key is only cleared if the entry currently sitting
// under it in pendingConfigEditsNow is IDENTICALLY (by reference) the one that was actually
// sent - if a newer edit landed on the same key while the save's fetch was in flight (a
// second drag, or the location editor committed again), pendingConfigEditsNow.get(key) is a
// different object and that key must survive uncleared.
function computeSaveKeysToClear(includedKeys, includedEditsSnapshot, pendingConfigEditsNow) {
    return includedKeys.filter(function (key) {
        return pendingConfigEditsNow.get(key) === includedEditsSnapshot.get(key);
    });
}

window.saveConfiguration = async function() {
    // Config may not have loaded yet if this is triggered before Map view was ever opened.
    // ensureConfigLoaded returns false if the load failed/was cancelled, in which case
    // in-memory state is EMPTY, not "the saved config" - refuse to save rather than
    // overwrite everything previously saved with empty defaults.
    var loaded = await window.ensureConfigLoaded();
    if (!loaded) {
        window.showMapStatus('Cannot save - the existing configuration has not loaded (password prompt was cancelled or the server could not be reached). Click Save Configuration again once it loads.');
        return false;
    }

    // Snapshot exactly which edits are going into THIS save, and the edit objects
    // themselves, before the request goes out. The POST payload below is built synchronously
    // from this snapshot, not from pendingConfigEdits read live later - a marker drag or the
    // location-editor modal (reachable mid-save; its backdrop is pointer-events:none) can add
    // a new entry to pendingConfigEdits while this request is in flight, and that entry must
    // survive the eventual pendingConfigEdits.clear() a naive "clear everything on success"
    // would otherwise do.
    var includedKeys = Array.from(pendingConfigEdits.keys());
    var includedEditsSnapshot = new Map(includedKeys.map(function (k) { return [k, pendingConfigEdits.get(k)]; }));

    // Merge the included edits over the currently-loaded config entries. An untouched entry
    // survives unchanged.
    //
    // Before inserting each pending edit, collapse any STALE entry left by a key change: if
    // a device was saved under one key (e.g. hostname, no serial yet) and its keys later
    // changed (rescan added a serial), the old entry would otherwise linger forever - and
    // could be silently reused by a different device if that old key is later reassigned.
    // pending.deviceKeysAtCommit holds every candidate key (serial/hostname/ip) the device
    // had at commit time, so all of them get removed here before the new entry is inserted.
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
        window.showMapStatus('Save failed: HTTP ' + resp.status);
        return false;
    }
    mapConfigEntries = devices;
    // Only remove the entries actually included in this successful save - not the whole map -
    // so an edit added to pendingConfigEdits during the request (or a newer edit that landed
    // on the same key) survives and is still treated as unsaved / included in the next save.
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

// Snapshotted by the render below so exportUnplacedDevicesCsv exports exactly what the
// panel is currently showing, without duplicating the filtering logic.
var unplacedDevicesForExport = [];

window.renderUnplacedDevicesList = function(classification, deviceByIpLocal, placedByIp) {
    var listEl = document.getElementById('mapUnplacedList');
    var countEl = document.getElementById('mapUnplacedCount');
    var exportBtn = document.getElementById('mapUnplacedExportBtn');
    listEl.innerHTML = '';

    var unplaced = [];
    classification.forEach(function (meta, ip) {
        if (!meta.scanned) return;          // only scanned devices are geo-taggable - an unscanned neighbor has no chassis data to key by
        if (placedByIp.has(ip)) return;      // already has a resolved location
        unplaced.push({ ip: ip, meta: meta, device: deviceByIpLocal.get(ip) });
    });

    countEl.textContent = unplaced.length + ' device' + (unplaced.length === 1 ? '' : 's') + ' with no location set';
    unplacedDevicesForExport = unplaced;
    if (exportBtn) exportBtn.style.display = unplaced.length > 0 ? '' : 'none';

    unplaced.forEach(function (row) {
        var rowEl = document.createElement('div');
        rowEl.style.cssText = 'padding:6px 12px; font-size:0.8rem; border-bottom:1px solid #f0f0f0; display:flex; justify-content:space-between; align-items:center; gap:8px;';
        // row.meta.hostname/row.ip are device-supplied (LLDP/DNS) and assigned via innerHTML
        // below - escape with window.esc first to avoid an XSS sink.
        var label = row.meta.hostname !== 'Unknown' ? window.esc(row.meta.hostname) : window.esc(row.ip);
        rowEl.innerHTML =
            '<span style="cursor:pointer; color:var(--accent);">' + label + '</span>' +
            '<button type="button" style="width:auto; margin:0; padding:4px 8px; font-size:0.72rem;">Set location</button>';
        rowEl.querySelector('span').addEventListener('click', function () { window.openRightDrawer(row.ip); });
        rowEl.querySelector('button').addEventListener('click', function () { window.openLocationEditor(row.ip); });
        listEl.appendChild(rowEl);
    });
};

// CSV of exactly what the Unplaced Devices list is currently showing, as a worklist for
// whoever is walking the building placing pins. Serial comes from the same
// extractDeviceKeys() config-resolve.js uses for location-key resolution, so it can't drift.
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
