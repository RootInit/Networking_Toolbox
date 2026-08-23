# Network Visualizer: Geographic Map View

Date: 2026-08-23
Status: Draft, pending user review

## Problem

`Network_Visualizer` draws switches on a force-directed / hierarchical
canvas (`graph.js`, see `2026-08-19-graph-layout-design.md`, which
explicitly deferred this exact feature as a non-goal). That view answers
"how is the fleet wired together" but not "where is this switch" — an
analyst standing in a building with a dead port has no way to find the
right physical closet from the app.

This adds a second view: devices plotted on a real geographic map
(Leaflet), positioned from a new encrypted sidecar file holding
building/room/coordinate metadata, with full search/details parity with
the existing diagram.

A throwaway spike (`Spike_GeoMapOverlay/`, not part of the shipped app —
delete once this is implemented) de-risked the two hardest technical
questions ahead of this design:

1. **vis-network's canvas cannot be reliably synced on top of a Leaflet
   map** — confirmed broken two independent ways (headless Chromium
   screenshot capture, and a real interactive Firefox session), even
   after fixing a real camera-reset bug found along the way. Root cause:
   vis-network owns and redraws its own canvas with no hook to render
   into a Leaflet-managed pane instead. This is why the map view is built
   on Leaflet's **native** rendering (`L.marker`/`L.divIcon`/`L.polyline`),
   not vis-network, and is a separate code path from `graph.js`.
2. **Leaflet's native rendering carries the visual vocabulary this needs**
   — confirmed working (both headless and the user's real browser): text
   inside labels, different marker shapes/sizes via CSS `divIcon`, and
   styled path lines between markers.

## Non-goals

- **Porting the diagram's full visual language to the map.** VLAN
  Highlight Layer colors, collapsed-cluster grouping, and daisy-chain
  badges stay diagram-only. The map reuses the diagram's existing
  scanned/scanned-stack/unscanned-neighbor classification for marker
  shape/color (that data already exists and the map should look
  consistent with the legend), but does not attempt a pixel-for-pixel
  port of every diagram affordance. Confirmed with the user.
- **Offline/self-hosted map tiles.** Tiles come from CARTO's free basemap
  service (see spike's tile-provider note — raw `tile.openstreetmap.org`
  is explicitly unsuitable for embedded-app traffic per its usage
  policy). This requires outbound internet from the browser; the
  webserver itself stays localhost-only, unaffected. Self-hosting a
  vendored tile set for air-gapped deployments is a real follow-up, not
  in this pass.
- **Rewriting the rest of the app to key by serial number.** See
  "Future work" below — `Configuration.json` gets a durable key because
  it's new and cross-snapshot by nature; retrofitting `deviceByIp`/search
  index/graph node ids/drawer/rescan/SSH-connect across the whole
  existing app is a separate, much larger effort and not bundled here.
- **Editing anything other than location metadata.** The in-app editor
  sets `lat`/`lng`/`building`/`room`/`notes`. It does not touch topology
  data, switch configuration, or `Auth.json`.

## Architecture

### 1. Data model & keying

`Configuration.json` (plaintext shape, before encryption):

```json
{
  "devices": [
    { "key": "JN123ABC0456", "keyType": "serial",
      "lat": 47.65335, "lng": -122.30687,
      "building": "Paul G. Allen Center for CS&E", "room": "B1 Comm Room",
      "notes": "Core switch, MDF for CSE building complex." }
  ]
}
```

**Keying, not by `DeviceIP`.** IP addresses are reassignable (renumbering,
DHCP on a management VLAN, device replacement); a location tag keyed by IP
would silently point at the wrong physical device after a change, or
orphan itself. Every scanned device already carries at least one
`StackMembers` entry with a real chassis serial (`Get-JunosNodeData.ps1`
line ~212 gives even a standalone switch a `Role: "Standalone"` entry;
a virtual-chassis stack gets one `Role: "Master"` entry among its
members) — that's the actual physical box's identity, stable across IP
renumbering, hostname changes, and reimaging. It only goes stale if the
hardware itself is swapped, which is the *correct* behavior (a swapped
unit should re-prompt for a location).

Resolution priority when matching a currently-scanned device to a
`Configuration.json` entry, tried in order until one hits:
1. `keyType: "serial"` — the device's Standalone/Master `StackMembers`
   entry's `Serial` (find the entry with `Role === "Standalone"` or
   `Role === "Master"`; if neither exists — e.g. a stack that only ever
   reported `Backup`/`Linecard`/`Unknown` roles, a real but rare parsing
   gap — this tier simply doesn't match and resolution falls through to
   hostname).
2. `keyType: "hostname"` — `device.Hostname` (only if not `"Unknown"`/empty).
3. `keyType: "ip"` — `device.DeviceIP`. Last resort only, for the rare
   case a scan never captured chassis hardware at all.

The in-app editor always **writes** using the best key available at save
time — so an entry created when a device had no serial yet (fell back to
hostname) silently upgrades to serial-keyed the next time it's edited
after a successful rescan. No explicit migration step needed.

This keying only applies to `Configuration.json`. The rest of the app
(`deviceByIp`, search index, vis-network node ids, `openRightDrawer`,
`/api/rescan`, `/api/connect`) keeps using `DeviceIP` exactly as today —
see "Future work."

### 2. Crypto

Reuses the exact envelope `topology-crypto.js` already decrypts
(AES-256-CBC, PBKDF2-SHA256, HMAC-SHA256, encrypt-then-MAC) — proven in
the spike with a real cross-implementation round trip (Node's `webcrypto`
encrypting, the browser decrypting). Two changes to the real (non-spike)
`topology-crypto.js`:

- `decryptEnvelope(envelope, password, expectedFormats)` gains the third
  param, defaulting to `['PSNetworkMapper-EncryptedTopology']` so existing
  callers are unaffected. `Configuration.json.enc` uses format
  `"PSNetworkMapper-EncryptedConfig"` and passes that explicitly, so a
  config file can never be silently parsed as a topology snapshot (or
  vice versa).
- No other changes — same KDF/cipher/MAC, same `MIN_ITERATIONS`/
  `MAX_ITERATIONS` bounds.

### 3. File location, loading, saving

Lives at `PS_NetworkMapper/Network_Mapper/Configuration.json.enc`, next
to `Auth.json` — same "V2 shares data with V1" convention already used
for `Network_Maps/`.

Unlike `NetworkMap.json(.enc)` (manually picked via `<input type=file>`,
no server round-trip), this file is now editable in-app, so it gets two
new endpoints in `Start-WebServer.ps1`, following the exact
`/api/connect`/`/api/rescan` pattern (same-origin CSRF check via the
existing `Test-SameOriginRequest`, JSON body, `Send-WebJson` responses):

- **`GET /api/config`** — auto-loads on page load, no manual picker.
  Returns 404 if the file doesn't exist yet (fresh checkout, same as
  `Auth.json` missing today) — the app treats that as "zero devices
  geo-tagged" rather than an error.
- **`POST /api/save-config`** — browser sends **plaintext** edited config
  JSON (the shape above); the server encrypts it using `Auth.json`'s
  `EncryptionPassword` (the same password source `Write-TopologyOutput`
  already uses for topology writes) and writes the file. The password
  never crosses the wire in either direction: decrypt-for-*viewing* still
  happens client-side with a human-typed password via the existing
  `promptForPassword` flow, same as topology snapshots — the server-side
  write password and the human's view password must be the same value
  for the round trip to work, exactly as they already must be for
  topology files today.

`Protect-TopologyPayload` (currently private to `Start-NetworkMapper.ps1`)
gets extracted into a small shared file
(`Network_Mapper/lib/TopologyCrypto.ps1`, dot-sourced by both scripts) so
the encryption logic exists in exactly one place instead of drifting
between the crawler and the webserver.

### 4. Map rendering

New `src/map.js`, parallel to `graph.js` — owns Leaflet init, marker/edge
rendering, and the map-specific UI (editor, unplaced-devices list).
Leaflet is **vendored** (`src/vendor/leaflet/`, matching how
`vis-network.min.js` is already vendored), not loaded from a CDN — the
app is designed to work under `file://` with no build step and the spike
already hit real friction from CDN dependencies (SRI/ORB, tile-policy
blocks); the core library shouldn't be a third one.

Marker shape/color reuses the diagram's existing classification (already
computed in `graph.js` from real topology data, matching the visible
legend) rather than inventing a second taxonomy:
- Scanned, non-stack → circle, blue (`#97C2FC`/`#2B7CE9`, matching the
  diagram's own scanned-switch color).
- Scanned, stack (`StackMembers.length > 1`) → the stack shape, light
  blue (`#D2E5FF`/`#2B7CE9`, matching the diagram).
- Unscanned LLDP neighbor → faded/gray outline, matching the diagram's
  gray unscanned styling. (Only plotted if it independently has a
  `Configuration.json` entry — an unscanned device has no serial to key
  by, so realistically these are rare, hostname/IP-keyed exceptions.)

Labels: short device identifier (hostname if present, else IP) inside
each marker, sized to fit — proven working in the spike (`map-native.html`).

Edges: drawn between two devices' markers if they are LLDP neighbors in
the **current topology** (`device.Neighbors`, the same data `graph.js`
already reads for diagram edges) **and** both ends resolve to a
`Configuration.json` entry. No separate hand-maintained link list — this
is the correction from the spike's throwaway data, and it means edges
stay correct as snapshots change instead of drifting from reality. One
consistent line style (see Non-goals — no VLAN/trunk styling here).

### 5. View toggle

A `Diagram | Map` toggle above `#center-panel`'s canvas, visually
consistent with the existing `.tabs`/`.analysis-tab` pattern. Swaps
`#mynetwork` visibility for a new `#mapview` container; `map.js` lazily
initializes Leaflet on first switch to Map (not on page load) so a
session that never opens the map view pays no Leaflet/tile cost.

### 6. Search & details-drawer parity

`window.goToSearchResult` (`search.js`) currently always does
`network.selectNodes([ip])` / `network.focus(ip, ...)` — diagram-specific.
This gets extracted into a small "reveal this device in whichever view is
active" step:
- Diagram view active: unchanged (today's `selectNodes`/`focus`).
- Map view active: pan/zoom to the device's marker if it resolves to a
  `Configuration.json` entry; otherwise leave the map where it is and
  show a small status note ("no location set for this device").

**Either branch still calls `window.openRightDrawer(ip)` unchanged** —
the details drawer (Summary/Hardware/Alarms/Neighbors/Interfaces/Clients/
Config, rescan, SSH launch, print, config diff) is the exact same
component regardless of which view revealed the device. Clicking a map
marker calls `openRightDrawer(ip)` directly, same as a diagram node click
does today. This is the actual "full data visibility parity" requirement
— one drawer, reused as-is, not a second implementation.

### 7. Unplaced devices

A collapsible list inside the map view (not a new sidebar tab — scoped to
when you're actually looking at the map) listing every scanned device
that doesn't resolve to a `Configuration.json` entry. Each row: opens the
drawer (info parity, same as above) plus a "Set location" action that
opens the editor pre-selected for that device.

### 8. In-app editor

Triggered from an Unplaced-Devices row or from an existing marker's popup
("Edit location"). Click a spot on the map to place/move a pin; small
form for building/room/notes. Pending edits accumulate in local browser
state with an explicit "Save Configuration" button (matches the existing
Settings tab's explicit Save/Reset pattern, not autosave-per-field) —
that button is what calls `POST /api/save-config`.

## New / changed files

- New: `Network_Visualizer/src/map.js`
- New: `Network_Visualizer/src/vendor/leaflet/` (vendored JS+CSS)
- New: `Network_Mapper/lib/TopologyCrypto.ps1` (extracted from
  `Start-NetworkMapper.ps1`)
- New: `Network_Mapper/Configuration.json.enc` (runtime-created via the
  editor, like `Auth.json` — not committed; a `.example` template may be
  worth adding, matching `Auth.example.json`)
- Changed: `Start-NetworkMapper.ps1` (dot-source the extracted crypto lib
  instead of its own private `Protect-TopologyPayload`)
- Changed: `Start-WebServer.ps1` (`/api/config`, `/api/save-config`)
- Changed: `Network_Visualizer/src/topology-crypto.js` (`expectedFormats`
  param)
- Changed: `Network_Visualizer/src/search.js` (extract the
  view-aware "reveal" step out of `goToSearchResult`)
- Changed: `Network_Visualizer/network_vis.html` (view toggle, `#mapview`
  container, editor markup, new `<script>` tags)

## Future work

- **Rewrite the rest of the app to key by chassis serial instead of
  `DeviceIP`.** The same instability that motivated `Configuration.json`'s
  keying applies everywhere: `deviceByIp`, the search index, vis-network
  node ids, `openRightDrawer`, `/api/rescan`, `/api/connect` all
  currently assume `DeviceIP` is a stable device identity across
  snapshots/rescans. It mostly holds in practice (management IPs change
  less often than this concern implies) but is not actually guaranteed,
  and a renumbering event would silently fragment a device's history
  across two "different" nodes today. Out of scope here — this is a
  cross-cutting rework of the whole app's identity model, not a
  map-specific concern, and deserves its own design pass.
- Self-hosted/vendored map tiles for air-gapped deployments (spike
  finding, not yet spiked further).
- Porting VLAN/trunk edge styling to the map, if it turns out to matter
  in practice once the map view is in use.
