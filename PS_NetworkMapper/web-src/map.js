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
var loadedCredentials = null;   // decrypted Configuration.json's credentials ({username, password}), or null
var loadedSettings = {};        // decrypted Configuration.json's settings (partial or empty) - merge over defaults at read time
var mapConfigLoaded = false;    // true once a GET /api/config attempt (success OR "no file yet") has completed
// In-flight loadMapConfiguration promise, so two near-simultaneous ensureConfigLoaded
// callers (e.g. the Settings tab being opened while Map view is still loading) share one
// fetch+password-prompt instead of each starting their own - two prompts stacked on top of
// each other, and two racing writes to mapConfigEntries/loadedCredentials/loadedSettings.
// Cleared as soon as the load settles, so a failed/cancelled attempt is still retryable.
var configLoadPromise = null;
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
        //
        // Goes through ensureConfigLoaded, NOT loadMapConfiguration directly: the Settings
        // tab may have loaded (or be mid-load of) the config already, and calling
        // loadMapConfiguration here bypassed both of ensureConfigLoaded's guards - the
        // "already loaded, don't re-prompt" one and the shared-configLoadPromise one that
        // stops two near-simultaneous callers racing two promptForPassword calls against
        // the same single #password-modal. The trailing renderMapMarkers is kept even though
        // ensureConfigLoaded already renders on a successful load: it is idempotent, and
        // keeping it means this branch behaves exactly as before for the retry-succeeds case
        // while also covering the "another surface had already loaded it" early return.
        window.ensureConfigLoaded().then(function () {
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
    // CARTO's basemaps.cartocdn.com free/anonymous tiles now require a registered API key -
    // requests without one still load but are watermarked "api key required". Standard OSM
    // tile servers remain free and keyless (subject to OSM's usage policy, fine for this
    // app's internal/low-volume use) and need no {r} retina placeholder - the standard tile
    // server doesn't serve @2x tiles the way CARTO's did.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(leafletMap);

    // ensureConfigLoaded, not loadMapConfiguration: opening the Settings tab first already
    // loads (and password-prompts for) the config, and calling loadMapConfiguration here
    // unconditionally re-prompted for the SAME password the moment the user then clicked
    // Map - with cancelling that second prompt resetting mapConfigEntries/loadedCredentials/
    // loadedSettings back to empty even though the session had already loaded them fine.
    // ensureConfigLoaded is a no-op when the config is already loaded and dedups a still
    // in-flight load via configLoadPromise. It does not render on that already-loaded early
    // return, so the renderMapMarkers below is still required for the Settings-first case.
    await window.ensureConfigLoaded();
    window.renderMapMarkers();
};

// Fetches and decrypts Configuration.json.enc (if any). Sets mapConfigEntries/mapConfigLoaded.
// A missing file (404, fresh checkout) is a normal empty state, not an error - same "nothing
// configured yet" posture the server takes toward missing Juniper credentials elsewhere in
// this app, and mapConfigLoaded=true there since there's nothing to retry. A cancelled
// password prompt or a network/parse failure is a real
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
    // A -NoEncryption server run writes/serves Configuration.json as plain
    // {devices, credentials, settings} JSON directly - no envelope, no password. Same
    // format check app.js's readSnapshotFile uses for plain vs. encrypted topology files.
    if (envelope && envelope.format === 'PSNetworkMapper-EncryptedConfig') {
        var decryptedText = null;
        var errorMsg = null;
        // Try the session password (app.js's window.getSessionEncryptionPassword) once, silently,
        // before ever showing the modal - Start-NetworkMapper.ps1 already prompted for this exact
        // password at the console to decrypt this same file server-side. Only falls through to
        // promptForPassword if that's unavailable/empty, or (rare) it fails to decrypt.
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

// Idempotent, session-wide "make sure the config has been fetched" gate - both Map view
// (initMapView, above) and the Settings tab (app.js's switchSidebarTab) call this instead
// of loadMapConfiguration directly, so the password prompt and fetch only ever happen once
// per session regardless of which one the user opens first. A no-op once mapConfigLoaded is
// true; retries a previously failed/cancelled attempt otherwise.
// Returns whether the config is actually loaded now (true) or the attempt failed/was
// cancelled (false). Callers that are about to WRITE the config (saveConfiguration,
// saveSettingsPanel) must check this and bail: loadMapConfiguration resets
// mapConfigEntries/loadedCredentials/loadedSettings to empty on failure, so proceeding
// would POST that empty state over every previously-saved device location, the stored
// Juniper credentials and every setting.
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
    // Matches graph.js's applyVlanFilter's own "doesn't match the selected VLAN" node
    // color exactly - same visual language (a faded near-white circle) on both views.
    vlanDimmed: { background: '#f2f2f2', border: '#e6e6e6' },
};

// dimmedByVlan: true when a VLAN filter is active AND this device's own local clients
// don't carry the selected VLAN tag. Only applies to scanned devices - an unscanned
// neighbor placeholder has no client data to test and always stays plain gray, exactly
// like graph.js's applyVlanFilter leaves an unscanned node's background alone (it only
// dims that node's font color there, which has no equivalent here since the marker's
// circle never carries text - see below).
function iconForClassification(meta, dimmedByVlan) {
    var colors = !meta.scanned ? MARKER_COLORS.unscanned
        : dimmedByVlan ? MARKER_COLORS.vlanDimmed
        : (meta.isStack ? MARKER_COLORS.scannedStack : MARKER_COLORS.scanned);
    // The hostname is NOT drawn inside this circle. Two earlier attempts were: 26px with a
    // single clipped line, then 40px with wrapped text - a realistic 19-character hostname
    // ("ACCESS-SW-001.local") still needs four wrapped lines at that font size and overflows
    // a 40px circle top and bottom. Growing the circle far enough to hold arbitrary text was
    // the wrong lever anyway: it grows the CLICK target with it, and Leaflet markers default
    // to bubblingMouseEvents:false (verified in the vendored leaflet.js), so a click landing
    // on a marker never reaches the map's own click handler - which is exactly how the
    // location editor places its pin (leafletMap.once('click', onEditorMapClick)). A 40px
    // marker is 2.4x the area of the original 26px one, so click-to-place-pin silently
    // failed far more often in the clustered case the bug report screenshotted, leaving the
    // once-listener armed to misplace the pin on some later unrelated click.
    //
    // So: the circle is back to a small, low-collision 22px and carries no text, and the
    // hostname is a separate permanent Leaflet tooltip anchored below it (see
    // renderMapMarkers). Tooltips are interactive:false by default (also verified in the
    // vendored leaflet.js - .leaflet-tooltip is pointer-events:none in leaflet.css), so the
    // label adds no clickable area at all: only the small circle stays clickable.
    var size = 22;
    var html = '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:' + (meta.isStack ? '30%' : '50%') +
        ';background:' + colors.background + ';border:2px solid ' + colors.border +
        ';box-shadow:0 1px 3px rgba(0,0,0,0.4);box-sizing:border-box;"></div>';
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

// Bottom-up "which VLANs are reachable behind this edge" for the map's OWN edge set,
// mirroring graph.js's computeSubtreeVlanSets/edgeTrunksVlan (see graph.js for the full
// reasoning on why a subtree union is the right trunk-membership signal here). Duplicated
// rather than shared: graph.js's version walks its private primaryTree/graphRoot, which are
// vis-network-diagram state that may not even be built yet (Diagram view need never be
// opened this session for Map view to be used) - this instead builds its own root/tree from
// the map's own node/edge set via the same window.GraphLayout helpers scan-network.js
// already uses for its start-IP heuristic (see bestStartIpFromActiveSnapshot).
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
    // Anything buildPrimaryTree didn't reach from root (a genuinely disconnected device)
    // still gets its own local VLANs rather than an undefined lookup later.
    nodeIds.forEach(function (id) { if (!result.has(id)) result.set(id, new Set(vlanCacheByIp.get(id) || [])); });
    return result;
}

function mapEdgeTrunksVlan(subtreeVlanSets, fromId, toId, vlanTag) {
    var fromSet = subtreeVlanSets.get(String(fromId));
    var toSet = subtreeVlanSets.get(String(toId));
    return !!((fromSet && fromSet.has(vlanTag)) || (toSet && toSet.has(vlanTag)));
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

    // Same #vlanFilter <select> the diagram's own applyVlanFilter (graph.js) reads -
    // there's only one filter control on the page, shared by both views (see
    // network_vis.html). Read live off the DOM, same as every other render-time setting
    // this file/graph.js already reads this way (getClusterThreshold, etc.), so a filter
    // change is picked up on the very next render without map.js needing its own cached copy.
    var vlanFilterEl = document.getElementById('vlanFilter');
    var selectedVlan = vlanFilterEl ? vlanFilterEl.value : 'ALL';
    var vlanCacheByIp = window.TopologyGraph.computeVlanCache(globalTopologyData);

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
        var dimmedByVlan = selectedVlan !== 'ALL' && !(vlanCacheByIp.get(ip) || []).includes(selectedVlan.toString());
        var marker = L.marker([entry.lat, entry.lng], { icon: iconForClassification(meta, dimmedByVlan) }).addTo(leafletMap);
        // The hostname label lives here, not inside the marker's circle - see
        // iconForClassification's comment for why (text inside the circle either clips or
        // forces the circle - and with it the click target - to grow). permanent:true shows
        // it without a hover; direction 'bottom' + the offset below clear the 22px circle so
        // the two never overlap, and the tooltip is free to be as wide as the hostname needs
        // since nothing clips it. Non-interactive by Leaflet's default, so it adds no
        // clickable area (see .leaflet-tooltip's pointer-events:none in leaflet.css).
        //
        // window.esc is REQUIRED here despite the option being called plain content:
        // Leaflet's DivOverlay._updateContent does `contentNode.innerHTML = content` for a
        // STRING content (verified in the vendored leaflet.js) - it is not a textContent
        // assignment - so an unescaped device-supplied hostname would be an XSS sink exactly
        // like the divIcon html was.
        if (meta.hostname !== 'Unknown') {
            // dimmedByVlan fades the label too (see the .vlan-dimmed rule in
            // network_vis.html) - the marker circle alone dimming wasn't enough signal: the
            // permanent label is what a user actually reads on a map with many markers, and
            // it used to stay exactly as loud as a matching device's regardless of the
            // filter. Matches applyVlanFilter's (graph.js) own font-dimming for a
            // non-matching diagram node.
            marker.bindTooltip(window.esc(meta.hostname), {
                permanent: true, direction: 'bottom', offset: [0, 8],
                className: dimmedByVlan ? 'map-marker-label vlan-dimmed' : 'map-marker-label',
            });
        }
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
    // Links that trunk the selected VLAN get emphasized, every other link fades - same
    // visual language as applyVlanFilter's edge pass (graph.js). "ALL" leaves every line at
    // its plain default styling. Only computed when a VLAN is actually selected - the
    // trunk-set walk is wasted work otherwise.
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

var editorTargetIp = null;
// keyType+':'+key (from bestKeyForSave) -> { entry, deviceIp, deviceKeysAtCommit },
// accumulated across edits until Save. deviceKeysAtCommit is the device's full
// extractDeviceKeys() set as of the moment the edit was committed, snapshotted here rather
// than re-derived at save time: saveConfiguration uses it to collapse that device's OTHER
// stale-keyed entries (see its own comment below for why that collapse exists at all), and
// it used to do that by re-resolving deviceByIp.get(deviceIp) when Save was clicked. A
// network scan or snapshot load between commit and Save replaces deviceByIp wholesale, so
// if that IP had since been reassigned to a DIFFERENT device (fleet renumbering, DHCP
// churn) the save-time lookup resolved the wrong device and deleted ITS saved location.
// deviceIp is still carried for diagnostics/traceability only - nothing resolves it now.
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
    // leafletMap is null until initMapView has run, i.e. until Map view has been opened at
    // least once this session. This is now called defensively from app.js's
    // processSelectedFiles on EVERY file load (see there), including for users who never
    // touch Map view - without this guard that call would throw on `.off` of null and pop
    // the fatal-error modal, which is the exact failure class those callers exist to avoid.
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
    // The editor's backdrop is pointer-events:none, so the sidebar stays live while it's
    // open - a Scan Network or a snapshot/folder load can therefore replace loadedSnapshots/
    // deviceByIp out from under an open editor, leaving editorTargetIp pointing at a device
    // that no longer exists. bestKeyForSave(undefined) throws (extractDeviceKeys dereferences
    // .StackMembers), which the global error handler turns into the fatal-error modal over
    // the whole page. Guard it the same way openLocationEditor already guards its own lookup.
    // (app.js's processSelectedFiles also closes this editor pre-emptively on any new load -
    // this is the belt to that braces, covering any other path that swaps the data.)
    if (!device) {
        window.closeLocationEditor();
        window.showMapStatus('That device is no longer in the currently loaded data (the topology was reloaded or rescanned while this editor was open) - the location was not saved. Reopen the editor from the device on the current map.');
        return;
    }
    var keyInfo = window.ConfigResolve.bestKeyForSave(device);
    // Snapshotted at COMMIT time, not re-resolved at save time - see pendingConfigEdits's
    // declaration comment above and saveConfiguration's use of it below.
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

window.saveConfiguration = async function() {
    // Config may not have loaded yet if this is triggered from the Settings tab before Map
    // view was ever opened (or before an earlier load attempt finished) - saving now would
    // otherwise overwrite devices/credentials/settings this session never actually fetched
    // with empty defaults, silently wiping out everything previously saved (e.g. every
    // placed device location). ensureConfigLoaded is a no-op once a real load has completed,
    // and returns false when the load itself failed or its password prompt was cancelled -
    // in that case the in-memory state is EMPTY, not "the saved config", so saving must be
    // refused outright rather than merged over and written.
    var loaded = await window.ensureConfigLoaded();
    if (!loaded) {
        window.showMapStatus('Cannot save - the existing configuration has not loaded (password prompt was cancelled or the server could not be reached). Click Save Configuration again once it loads.');
        return false;
    }

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
    // pending.deviceKeysAtCommit is the device's full set of candidate keys (serial/
    // hostname/ip, whichever were non-null) as extractDeviceKeys saw them at the moment this
    // edit was committed - not just the one key this particular edit happens to be saved
    // under - so this removes every one of them from `merged`, regardless of which tier the
    // device used to be keyed by, before inserting the new entry under its (possibly
    // different) key.
    //
    // This used to re-resolve the device here via deviceByIp.get(pending.deviceIp), i.e. at
    // SAVE time. A scan or snapshot load between commit and Save replaces deviceByIp
    // wholesale, so if that IP had been reassigned to a different device in the meantime,
    // the lookup returned the WRONG device and this loop deleted that innocent third
    // device's saved location while still writing the pending edit under its own correct
    // key. Snapshotting the keys at commit time removes the re-resolution entirely: the
    // collapse now always operates on the device the user was actually editing.
    var merged = new Map(mapConfigEntries.map(function (e) { return [e.keyType + ':' + e.key, e]; }));
    pendingConfigEdits.forEach(function (pending) {
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
        // Same "must never leave the user without feedback" concern as loadMapConfiguration's
        // fetch above - an unreachable server here would otherwise be an unhandled rejection
        // from the Save button's onclick with no visible sign the click did anything.
        window.showMapStatus('Could not reach the server to save (' + fetchErr.message + '). Click Save Configuration to retry.');
        return false;
    }
    if (!resp.ok) {
        window.showMapStatus('Save failed: HTTP ' + resp.status);
        return false;
    }
    mapConfigEntries = devices;
    pendingConfigEdits.clear();
    window.renderSaveConfigButton();
    window.showMapStatus('Configuration saved.');
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

// Snapshotted by the render below so window.exportUnplacedDevicesCsv doesn't need its own
// copy of the classification/placedByIp filtering logic - always exports exactly what the
// panel is currently showing.
var unplacedDevicesForExport = [];

window.renderUnplacedDevicesList = function(classification, deviceByIpLocal, placedByIp) {
    var listEl = document.getElementById('mapUnplacedList');
    var countEl = document.getElementById('mapUnplacedCount');
    var exportBtn = document.getElementById('mapUnplacedExportBtn');
    listEl.innerHTML = '';

    var unplaced = [];
    classification.forEach(function (meta, ip) {
        if (!meta.scanned) return;          // only scanned devices are ever geo-taggable (see Task 4's key resolution - an unscanned neighbor has no chassis data to key by)
        if (placedByIp.has(ip)) return;      // already has a resolved location
        unplaced.push({ ip: ip, meta: meta, device: deviceByIpLocal.get(ip) });
    });

    countEl.textContent = unplaced.length + ' device' + (unplaced.length === 1 ? '' : 's') + ' with no location set';
    unplacedDevicesForExport = unplaced;
    if (exportBtn) exportBtn.style.display = unplaced.length > 0 ? '' : 'none';

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

// CSV of exactly what the Unplaced Devices list is currently showing - handed to whoever is
// walking the building placing pins, so they have a paper/spreadsheet worklist (hostname +
// serial to find the right unit on-site) instead of having to keep this panel open and
// scrolled to the right spot the whole time. Serial comes from the same StackMembers
// extraction config-resolve.js already uses for location-key resolution (extractDeviceKeys) -
// not reimplemented here - so "the serial this row would be saved under" and "the serial in
// this export" can never drift apart.
window.exportUnplacedDevicesCsv = function() {
    if (unplacedDevicesForExport.length === 0) return;
    var rows = [['Hostname', 'IP', 'Serial', 'Model', 'Junos Version', 'Uptime']];
    unplacedDevicesForExport.forEach(function (row) {
        var device = row.device;
        var keys = device ? window.ConfigResolve.extractDeviceKeys(device) : null;
        var model = (device && device.StackMembers && device.StackMembers[0]) ? device.StackMembers[0].Model : '';
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
