# Geographic Map View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, geographic view to the Network Visualizer — devices plotted on a real map from a new encrypted `Configuration.json` sidecar file, with full search/details-drawer parity with the existing diagram.

**Architecture:** A new Leaflet-based `map.js` (native rendering — vis-network cannot reliably sync onto Leaflet, confirmed by spike) reuses the diagram's existing device classification and neighbor-edge data via a new shared pure-logic module, and reuses the existing details drawer/search infrastructure unchanged. `Configuration.json.enc` is keyed by chassis serial (not IP — IPs are reassignable), loaded via a new read-only webserver endpoint and written back via a new CSRF-protected save endpoint that encrypts server-side with the same password already used for topology snapshots.

**Tech Stack:** Vanilla JS (classic scripts, no build step, no ES modules — must work under `file://`), `node:test`/`node:assert` for pure-logic unit tests, Leaflet 1.9.x (vendored), PowerShell (`Start-WebServer.ps1`'s `HttpListener`), Web Crypto API / .NET `Rfc2898DeriveBytes`+AES+HMAC.

**Spec:** `docs/superpowers/specs/2026-08-23-geo-map-view-design.md`

## Global Constraints

- No ES modules anywhere in `Network_Visualizer/src/` — classic `<script>` tags sharing one global scope, so the app keeps working opened directly via `file://` with no local server (see `graph-layout.js`'s header comment).
- Every new pure-logic file uses the dual CJS/`window` export pattern already established by `graph-layout.js` (lines 556–567) — `module.exports = {...}` when `module` exists, else `window.<Name> = {...}`.
- Crypto: AES-256-CBC, PBKDF2-SHA256, HMAC-SHA256, encrypt-then-MAC — the exact envelope shape `topology-crypto.js`/`Protect-TopologyPayload` already use. No new crypto primitives.
- `Configuration.json.enc` lives at `PS_NetworkMapper/Network_Mapper/Configuration.json.enc` (next to `Auth.json`), envelope `format: "PSNetworkMapper-EncryptedConfig"`.
- Devices in `Configuration.json` are keyed by `{key, keyType}` where `keyType` is `"serial"` (preferred) → `"hostname"` → `"ip"`, resolved in that priority order. Never key by `DeviceIP` alone for this file.
- Map view reuses the diagram's existing scanned/scanned-stack/unscanned classification and real LLDP-neighbor edges — no separate hand-maintained device-kind or link list.
- No VLAN/trunk styling on map edges, no cluster grouping, no daisy-chain badges on the map (confirmed non-goals in the spec) — one consistent edge style.
- Leaflet is vendored under `Network_Visualizer/src/vendor/leaflet/`, not loaded from a CDN.
- This sandbox has no `pwsh`/PowerShell available — every PowerShell task's "run it" step is a structural/manual verification (careful construction against the existing, proven `Protect-TopologyPayload`/`/api/rescan` code, plus exact commands the user runs later on a machine with PowerShell). This is called out explicitly in each PowerShell task; it is not a skipped step, it's a different kind of step.

---

### Task 1: Shared PowerShell crypto lib

**Files:**
- Create: `PS_NetworkMapper_V2/Network_Mapper/lib/TopologyCrypto.ps1`
- Modify: `PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1:52-151` (encryption setup block)

**Interfaces:**
- Produces: `Get-TopologyKeyMaterial -Password <string> -Salt <byte[]> -Iterations <int>` → `@{ EncKey = <byte[32]>; MacKey = <byte[32]> }`
- Produces: `Protect-TopologyPayload -PlainJson <string> -EncKey <byte[]> -MacKey <byte[]> -Salt <byte[]> -Iterations <int> [-Format <string> = "PSNetworkMapper-EncryptedTopology"]` → `[ordered]@{ format; version; kdf; iterations; cipher; macAlgorithm; salt; iv; mac; ciphertext }`

Today `Protect-TopologyPayload` lives inline in `Start-NetworkMapper.ps1` and hardcodes `format = "PSNetworkMapper-EncryptedTopology"`. Task 5 (the new `/api/save-config` endpoint) needs the identical encrypt logic but with `format = "PSNetworkMapper-EncryptedConfig"` — extracting it now with a `-Format` parameter means Task 5 doesn't duplicate the AES/HMAC logic, and both call sites can never drift apart.

This is a pure refactor — behavior for `Start-NetworkMapper.ps1`'s existing topology writes must be byte-for-byte unchanged (same default `-Format`, same key-derivation math, just moved to a shared file and dot-sourced instead of defined inline).

- [ ] **Step 1: Create the shared lib with the extracted, generalized functions**

```powershell
# PS_NetworkMapper_V2/Network_Mapper/lib/TopologyCrypto.ps1
#
# Shared AES-256-CBC + PBKDF2-SHA256 + HMAC-SHA256 (encrypt-then-MAC) envelope logic,
# used by both Start-NetworkMapper.ps1 (topology snapshot writes) and Start-WebServer.ps1
# (Configuration.json.enc writes via /api/save-config) - extracted so this crypto exists
# in exactly one place instead of drifting between the crawler and the webserver.
# Mirrors Network_Visualizer/src/topology-crypto.js's decryptEnvelope on the browser side.
#
# Not meant to be run directly - dot-source it.

function Get-TopologyKeyMaterial {
    param(
        [Parameter(Mandatory=$true)][string]$Password,
        [Parameter(Mandatory=$true)][byte[]]$Salt,
        [Parameter(Mandatory=$true)][int]$Iterations
    )
    $Kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new($Password, $Salt, $Iterations, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    $KeyMaterial = $Kdf.GetBytes(64)
    $Kdf.Dispose()
    return @{ EncKey = $KeyMaterial[0..31]; MacKey = $KeyMaterial[32..63] }
}

# Builds an encrypted envelope from a plaintext JSON string. IV is fresh per call; the
# caller derives (and may cache/reuse across multiple calls) EncKey/MacKey/Salt via
# Get-TopologyKeyMaterial above.
function Protect-TopologyPayload {
    param(
        [Parameter(Mandatory=$true)][string]$PlainJson,
        [Parameter(Mandatory=$true)][byte[]]$EncKey,
        [Parameter(Mandatory=$true)][byte[]]$MacKey,
        [Parameter(Mandatory=$true)][byte[]]$Salt,
        [Parameter(Mandatory=$true)][int]$Iterations,
        [string]$Format = "PSNetworkMapper-EncryptedTopology"
    )

    $Aes = [System.Security.Cryptography.Aes]::Create()
    $Aes.KeySize = 256
    $Aes.Key = $EncKey
    $Aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
    $Aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
    $Aes.GenerateIV()
    $IvBytes = $Aes.IV

    $PlainBytes = [System.Text.Encoding]::UTF8.GetBytes($PlainJson)
    $Encryptor = $Aes.CreateEncryptor()
    $CipherBytes = $Encryptor.TransformFinalBlock($PlainBytes, 0, $PlainBytes.Length)
    $Encryptor.Dispose()
    $Aes.Dispose()

    $Hmac = [System.Security.Cryptography.HMACSHA256]::new($MacKey)
    $MacBytes = $Hmac.ComputeHash($IvBytes + $CipherBytes)
    $Hmac.Dispose()

    return [ordered]@{
        format       = $Format
        version      = 1
        kdf          = "PBKDF2-SHA256"
        iterations   = $Iterations
        cipher       = "AES-256-CBC"
        macAlgorithm = "HMAC-SHA256"
        salt         = [Convert]::ToBase64String($Salt)
        iv           = [Convert]::ToBase64String($IvBytes)
        mac          = [Convert]::ToBase64String($MacBytes)
        ciphertext   = [Convert]::ToBase64String($CipherBytes)
    }
}
```

- [ ] **Step 2: Verify the extraction is byte-for-byte identical to the original**

This sandbox has no `pwsh` to execute against. Verify by direct comparison instead:
diff the new `Protect-TopologyPayload` body above against the original in
`Start-NetworkMapper.ps1` (the version before this task's Step 3 edit) — every line of
AES/HMAC logic must match exactly; the only changes should be the added `-Format`
parameter (defaulting to the original hardcoded string, so omitting it changes nothing)
and the `$Format` variable substituted for the literal string in the returned hashtable.

- [ ] **Step 3: Update `Start-NetworkMapper.ps1` to dot-source the shared lib instead of defining these functions itself**

In `Start-NetworkMapper.ps1`, replace the `Protect-TopologyPayload` function definition
(currently lines 69–104) and the inline key-derivation block (currently lines 138–151,
the `$SaltBytes`/`Rfc2898DeriveBytes`/`$EncKeyBytes`/`$MacKeyBytes` setup) with:

```powershell
. (Join-Path $ScriptDir "lib\TopologyCrypto.ps1")
```

placed alongside the existing `. (Join-Path $ScriptDir "lib\Start-WebServer.ps1")` dot-source
near the top of the file (line 30). Then replace the inline derivation block with a call
to the new shared function:

```powershell
$SaltBytes = [byte[]]::new(16)
$Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$Rng.GetBytes($SaltBytes)
$Rng.Dispose()

$KeyMaterial = Get-TopologyKeyMaterial -Password $EncryptionPassword -Salt $SaltBytes -Iterations $PBKDF2_ITERATIONS
$EncKeyBytes = $KeyMaterial.EncKey
$MacKeyBytes = $KeyMaterial.MacKey
$EncryptionPassword = $null
```

`Protect-TopologyPayload`'s call site at (formerly) line 114 needs no change — it's
called with the same named parameters (`-PlainJson -EncKey -MacKey -Salt -Iterations`),
and omitting `-Format` keeps the existing `"PSNetworkMapper-EncryptedTopology"` default.

- [ ] **Step 4: Structural re-check**

Read through the edited `Start-NetworkMapper.ps1` top-to-bottom once more and confirm:
(a) the dot-source line runs before `$PBKDF2_ITERATIONS` is used, (b) `$EncKeyBytes`/
`$MacKeyBytes`/`$SaltBytes` are still assigned before `Write-TopologyOutput`'s first call,
(c) no other reference to the now-deleted inline function/derivation code remains
(`grep -n "Rfc2898DeriveBytes\|function Protect-TopologyPayload" Start-NetworkMapper.ps1`
should return nothing).

- [ ] **Step 5: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/lib/TopologyCrypto.ps1 PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1
git commit -m "Extract topology crypto into a shared lib, generalize envelope format"
```

---

### Task 2: `topology-crypto.js` — multi-format envelopes + real tests

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/src/topology-crypto.js`
- Create: `PS_NetworkMapper_V2/Network_Visualizer/src/test/topology-crypto.test.mjs`

**Interfaces:**
- Produces: `TopologyCrypto.decryptEnvelope(envelope, password, expectedFormats)` →
  `Promise<string>` (decrypted plaintext). `expectedFormats` is optional, defaults to
  `['PSNetworkMapper-EncryptedTopology']` (today's only behavior, unchanged for every
  existing caller).

This file currently has no test coverage and no dual-mode export (it's a browser-only
IIFE attaching straight to `window.TopologyCrypto`). Both are needed: the export style to
match `graph-layout.js`'s established pattern, the tests because this is exactly the kind
of pure, input→output logic (given an envelope + password, decrypt or throw) this repo
already unit-tests elsewhere, and because a real cross-implementation round trip (Node's
global `crypto.subtle` — confirmed available without importing anything, same Web Crypto
API the browser uses) is a strong test of the actual bug this task fixes (a config file
silently parsed as a topology snapshot, or vice versa).

- [ ] **Step 1: Write the failing tests**

```javascript
// PS_NetworkMapper_V2/Network_Visualizer/src/test/topology-crypto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TopologyCrypto } from '../topology-crypto.js';

const PASSWORD = 'correct-horse-battery-staple';
const ITERATIONS = 1000; // MIN_ITERATIONS in topology-crypto.js; keeps tests fast

function b64(bytes) { return Buffer.from(bytes).toString('base64'); }

async function buildEnvelope(plainJson, password, format, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));

  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, baseKey, 512);
  const keyMaterial = new Uint8Array(bits);
  const encKeyBytes = keyMaterial.slice(0, 32), macKeyBytes = keyMaterial.slice(32, 64);

  const encKey = await crypto.subtle.importKey('raw', encKeyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, encKey, new TextEncoder().encode(plainJson));
  const cipherBytes = new Uint8Array(cipherBuf);

  const macKey = await crypto.subtle.importKey('raw', macKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const macBuf = await crypto.subtle.sign('HMAC', macKey, new Uint8Array([...iv, ...cipherBytes]));

  return {
    format, version: 1, kdf: 'PBKDF2-SHA256', iterations,
    cipher: 'AES-256-CBC', macAlgorithm: 'HMAC-SHA256',
    salt: b64(salt), iv: b64(iv), mac: b64(new Uint8Array(macBuf)), ciphertext: b64(cipherBytes),
  };
}

test('decryptEnvelope round-trips a real envelope built independently (cross-implementation check)', async () => {
  const envelope = await buildEnvelope('{"hello":"world"}', PASSWORD, 'PSNetworkMapper-EncryptedTopology');
  const plain = await TopologyCrypto.decryptEnvelope(envelope, PASSWORD);
  assert.equal(plain, '{"hello":"world"}');
});

test('decryptEnvelope defaults expectedFormats to the topology format (backward compatible)', async () => {
  const envelope = await buildEnvelope('{"a":1}', PASSWORD, 'PSNetworkMapper-EncryptedTopology');
  const plain = await TopologyCrypto.decryptEnvelope(envelope, PASSWORD); // no third arg
  assert.equal(plain, '{"a":1}');
});

test('decryptEnvelope accepts a config envelope when PSNetworkMapper-EncryptedConfig is in expectedFormats', async () => {
  const envelope = await buildEnvelope('{"devices":[]}', PASSWORD, 'PSNetworkMapper-EncryptedConfig');
  const plain = await TopologyCrypto.decryptEnvelope(envelope, PASSWORD, ['PSNetworkMapper-EncryptedConfig']);
  assert.equal(plain, '{"devices":[]}');
});

test('decryptEnvelope rejects a config envelope when only the topology format is expected', async () => {
  const envelope = await buildEnvelope('{"devices":[]}', PASSWORD, 'PSNetworkMapper-EncryptedConfig');
  await assert.rejects(
    () => TopologyCrypto.decryptEnvelope(envelope, PASSWORD), // default expectedFormats = topology only
    /Not a recognized encrypted file/
  );
});

test('decryptEnvelope rejects the wrong password with a clear error, not a crypto exception', async () => {
  const envelope = await buildEnvelope('{"x":1}', PASSWORD, 'PSNetworkMapper-EncryptedTopology');
  await assert.rejects(
    () => TopologyCrypto.decryptEnvelope(envelope, 'wrong-password'),
    /Incorrect password, or the file is corrupted/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd PS_NetworkMapper_V2/Network_Visualizer && node --test src/test/topology-crypto.test.mjs`
Expected: FAIL — `topology-crypto.js` has no `export`, so `import { TopologyCrypto }` throws
`SyntaxError: The requested module '../topology-crypto.js' does not provide an export named 'TopologyCrypto'`.

- [ ] **Step 3: Add the dual-mode export and the `expectedFormats` parameter**

In `topology-crypto.js`, change the `decryptEnvelope` signature and its format check:

```javascript
    async function decryptEnvelope(envelope, password, expectedFormats) {
        expectedFormats = expectedFormats || ['PSNetworkMapper-EncryptedTopology'];
        if (!envelope || expectedFormats.indexOf(envelope.format) === -1) {
            throw new Error('Not a recognized encrypted file (expected one of: ' + expectedFormats.join(', ') + ').');
        }
```

(replacing the current hardcoded
`if (!envelope || envelope.format !== 'PSNetworkMapper-EncryptedTopology') { throw new Error('Not a recognized encrypted topology file.'); }`)
— every other line of `decryptEnvelope` (version/kdf/cipher/mac checks, iteration bounds,
MAC verify, AES decrypt) is unchanged.

Then replace the file's closing IIFE-return block:

```javascript
    return { decryptEnvelope: decryptEnvelope };
})();
```

with the dual-export version (same pattern as `graph-layout.js` lines 556–567):

```javascript
    var TopologyCryptoExports = { decryptEnvelope: decryptEnvelope };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { TopologyCrypto: TopologyCryptoExports };
    } else if (typeof window !== 'undefined') {
        window.TopologyCrypto = TopologyCryptoExports;
    }
    return TopologyCryptoExports;
})();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd PS_NetworkMapper_V2/Network_Visualizer && node --test src/test/topology-crypto.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Regression-check the app's only existing caller**

`grep -n "decryptEnvelope" PS_NetworkMapper_V2/Network_Visualizer/src/app.js` — confirm the
one call site (`readSnapshotFile`, currently `window.TopologyCrypto.decryptEnvelope(data, password)`,
two args) still works unchanged: two args means `expectedFormats` is `undefined`, which
the new code defaults to `['PSNetworkMapper-EncryptedTopology']` — identical behavior to
today. No edit needed there.

- [ ] **Step 6: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/topology-crypto.js PS_NetworkMapper_V2/Network_Visualizer/src/test/topology-crypto.test.mjs
git commit -m "Generalize topology-crypto.js to multiple envelope formats, add test coverage"
```

---

### Task 3: Shared device-classification/edge logic (`topology-graph.js`)

**Files:**
- Create: `PS_NetworkMapper_V2/Network_Visualizer/src/topology-graph.js`
- Create: `PS_NetworkMapper_V2/Network_Visualizer/src/test/topology-graph.test.mjs`
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/src/graph.js:93-137` (`buildSwitchMap`'s two passes)
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/network_vis.html:608` (new `<script>` tag)

**Interfaces:**
- Produces: `computeDeviceClassification(topology)` → `Map<string, {scanned: boolean, isStack: boolean, hostname: string}>` keyed by `DeviceIP`, one entry per device that appears anywhere in `topology` (scanned) or as an LLDP neighbor of a scanned device (unscanned placeholder).
- Produces: `computeNeighborEdges(topology)` → `Array<{from: string, to: string}>`, one entry per undirected neighbor pair, deduplicated (same dedup rule `graph.js` already uses: sorted `[from,to].join('-')` as the seen-set key).

The diagram (`graph.js`) already computes exactly this (its "Pass 1" / "Pass 2" in
`buildSwitchMap`) but inline, mixed with vis-network-specific rendering concerns (labels,
`shape: 'box'|'database'`). The map view needs the same classification (to choose marker
shape/color consistent with the diagram's legend) and the same edges (to draw lines
between geo-tagged neighbors) — extracting this into a shared, pure, tested module means
the two views can never classify the same device differently, instead of two independent
implementations quietly drifting.

- [ ] **Step 1: Write the failing tests**

```javascript
// PS_NetworkMapper_V2/Network_Visualizer/src/test/topology-graph.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDeviceClassification, computeNeighborEdges } from '../topology-graph.js';

const SCANNED_STANDALONE = {
  DeviceIP: '10.0.0.1', Hostname: 'sw1', StackMembers: [{ FPC: '0', Serial: 'ABC123', Role: 'Standalone' }],
  Neighbors: [{ ManagementIP: '10.0.0.2', Hostname: 'sw2' }],
};
const SCANNED_STACK = {
  DeviceIP: '10.0.0.3', Hostname: 'sw3',
  StackMembers: [{ FPC: '0', Serial: 'S1', Role: 'Master' }, { FPC: '1', Serial: 'S2', Role: 'Backup' }],
  Neighbors: [],
};

test('computeDeviceClassification marks a scanned standalone device correctly', () => {
  const result = computeDeviceClassification([SCANNED_STANDALONE]);
  assert.deepEqual(result.get('10.0.0.1'), { scanned: true, isStack: false, hostname: 'sw1' });
});

test('computeDeviceClassification marks a scanned stack (2+ StackMembers) as isStack', () => {
  const result = computeDeviceClassification([SCANNED_STACK]);
  assert.equal(result.get('10.0.0.3').isStack, true);
});

test('computeDeviceClassification adds an unscanned placeholder for an LLDP neighbor never itself scanned', () => {
  const result = computeDeviceClassification([SCANNED_STANDALONE]);
  assert.deepEqual(result.get('10.0.0.2'), { scanned: false, isStack: false, hostname: 'sw2' });
});

test('computeDeviceClassification skips a neighbor with no usable ManagementIP', () => {
  const device = { DeviceIP: '10.0.0.9', Neighbors: [{ ManagementIP: 'Unknown' }, { ManagementIP: '0.0.0.0' }] };
  const result = computeDeviceClassification([device]);
  assert.equal(result.size, 1); // only 10.0.0.9 itself, no placeholder for either bad neighbor
});

test('computeDeviceClassification lets a scanned pass override an earlier unscanned placeholder', () => {
  // sw2 is BOTH a neighbor of sw1 (pass 2 would placeholder it) AND independently scanned
  // (pass 1) - the scanned entry must win, matching graph.js's existing two-pass order.
  const sw2Scanned = { DeviceIP: '10.0.0.2', Hostname: 'sw2-real', StackMembers: [], Neighbors: [] };
  const result = computeDeviceClassification([SCANNED_STANDALONE, sw2Scanned]);
  assert.deepEqual(result.get('10.0.0.2'), { scanned: true, isStack: false, hostname: 'sw2-real' });
});

test('computeNeighborEdges produces one deduplicated edge per neighbor pair', () => {
  const edges = computeNeighborEdges([SCANNED_STANDALONE]);
  assert.deepEqual(edges, [{ from: '10.0.0.1', to: '10.0.0.2' }]);
});

test('computeNeighborEdges does not duplicate an edge reported from both ends', () => {
  const a = { DeviceIP: '10.0.0.1', Neighbors: [{ ManagementIP: '10.0.0.2' }] };
  const b = { DeviceIP: '10.0.0.2', Neighbors: [{ ManagementIP: '10.0.0.1' }] };
  const edges = computeNeighborEdges([a, b]);
  assert.equal(edges.length, 1);
});

test('computeNeighborEdges skips neighbors with no usable ManagementIP', () => {
  const device = { DeviceIP: '10.0.0.9', Neighbors: [{ ManagementIP: 'Unknown' }] };
  assert.deepEqual(computeNeighborEdges([device]), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd PS_NetworkMapper_V2/Network_Visualizer && node --test src/test/topology-graph.test.mjs`
Expected: FAIL — `src/topology-graph.js` doesn't exist yet (`Cannot find module`).

- [ ] **Step 3: Write the implementation**

```javascript
// PS_NetworkMapper_V2/Network_Visualizer/src/topology-graph.js
//
// Pure device-classification/edge extraction shared by graph.js (the diagram) and map.js
// (the geo view) - both need "which devices exist, are they scanned/stacked, and which
// pairs are LLDP neighbors" from the same raw topology array, and must never classify a
// device differently between the two views. No DOM, no vis-network, no Leaflet.

function computeDeviceClassification(topology) {
  var result = new Map();

  // Pass 1: every actually-scanned device, even if something below already placeholdered
  // its IP as a neighbor - scanned always wins (mirrors graph.js's existing two-pass order).
  topology.forEach(function (device) {
    if (!device || !device.DeviceIP) return;
    var isStack = !!(device.StackMembers && device.StackMembers.length > 1);
    result.set(String(device.DeviceIP), {
      scanned: true, isStack: isStack, hostname: device.Hostname || 'Unknown',
    });
  });

  // Pass 2: LLDP neighbors that were never themselves scanned get a placeholder entry.
  topology.forEach(function (device) {
    if (!device || !device.DeviceIP || !device.Neighbors) return;
    device.Neighbors.forEach(function (neighbor) {
      var neighborIp = String(neighbor.ManagementIP);
      if (!neighborIp || neighborIp === 'Unknown' || neighborIp === '0.0.0.0') return;
      if (!result.has(neighborIp)) {
        result.set(neighborIp, { scanned: false, isStack: false, hostname: neighbor.Hostname || 'Unknown' });
      }
    });
  });

  return result;
}

function computeNeighborEdges(topology) {
  var edges = [];
  var seen = new Set();

  topology.forEach(function (device) {
    if (!device || !device.DeviceIP || !device.Neighbors) return;
    var switchIp = String(device.DeviceIP);
    device.Neighbors.forEach(function (neighbor) {
      var neighborIp = String(neighbor.ManagementIP);
      if (!neighborIp || neighborIp === 'Unknown' || neighborIp === '0.0.0.0') return;
      var edgeKey = [switchIp, neighborIp].sort().join('-');
      if (seen.has(edgeKey)) return;
      seen.add(edgeKey);
      edges.push({ from: switchIp, to: neighborIp });
    });
  });

  return edges;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeDeviceClassification: computeDeviceClassification, computeNeighborEdges: computeNeighborEdges };
} else if (typeof window !== 'undefined') {
    window.TopologyGraph = { computeDeviceClassification: computeDeviceClassification, computeNeighborEdges: computeNeighborEdges };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd PS_NetworkMapper_V2/Network_Visualizer && node --test src/test/topology-graph.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire `graph.js`'s `buildSwitchMap` to use the shared functions instead of its own inline passes**

In `graph.js`, replace the body of `window.buildSwitchMap` from `allNodeMeta.clear();`
through the end of Pass 2 (currently lines 94–137) with:

```javascript
window.buildSwitchMap = async function() {
    allNodeMeta.clear();
    allEdges = window.TopologyGraph.computeNeighborEdges(globalTopologyData);

    var classification = window.TopologyGraph.computeDeviceClassification(globalTopologyData);
    var deviceByIpLocal = new Map(globalTopologyData.filter(d => d && d.DeviceIP).map(d => [String(d.DeviceIP), d]));

    classification.forEach(function (meta, ip) {
        var device = deviceByIpLocal.get(ip);
        var stackIcon = meta.isStack ? `\n[VC: ${device.StackMembers.length} Node]` : "";
        allNodeMeta.set(ip, {
            label: meta.scanned
                ? `Switch\n${ip}\n(${meta.hostname})${stackIcon}`
                : `Switch\n${ip}\n(${meta.hostname})`,
            shape: meta.isStack ? 'database' : 'box', isStack: meta.isStack, scanned: meta.scanned,
            vlanCache: (device && device.TrueClients) ? device.TrueClients.map(c => String(c.VLAN_Tag)) : [],
        });
    });
```

(the rest of `buildSwitchMap` — `graphRoot`/`primaryTree`/`network = new vis.Network(...)`
onward — is unchanged; only the node/edge *construction* moves to the shared functions,
the vis-network setup that follows it stays exactly as-is).

- [ ] **Step 6: Add the new script tag so the browser loads it before `graph.js`**

In `network_vis.html`, add `<script src="src/topology-graph.js"></script>` immediately
before the existing `<script src="src/graph.js"></script>` (both need to be in this
relative order since `graph.js` now calls `window.TopologyGraph` at `buildSwitchMap`
call time, which is always after page load, but keeping load order matching dependency
order is the existing convention every other file here follows).

- [ ] **Step 7: Regression-check the diagram still renders identically**

Serve the app and load the two committed sample snapshots (`PS_NetworkMapper/Network_Maps/NetworkMap_2026-08-13_091500.json`, `PS_NetworkMapper/Network_Maps/NetworkMap_2026-08-20_143207.json`):

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox && (python3 -m http.server 8930 &)
```

Then drive it with the CDP pattern already established in this project (see this
session's earlier spike verification for the exact `cdp.mjs` invocation) — navigate to
`http://localhost:8930/PS_NetworkMapper_V2/Network_Visualizer/network_vis.html`, upload
the plain (non-`.enc`) sample snapshot via the file input, screenshot the result, and
confirm it visually matches a screenshot taken from `main` before this task's edits (same
node count, same shapes/colors, no console errors from the new `TopologyGraph` reference).

- [ ] **Step 8: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/topology-graph.js PS_NetworkMapper_V2/Network_Visualizer/src/test/topology-graph.test.mjs PS_NetworkMapper_V2/Network_Visualizer/src/graph.js PS_NetworkMapper_V2/Network_Visualizer/network_vis.html
git commit -m "Extract device classification and neighbor-edge logic, shared by diagram and map view"
```

---

### Task 4: Device location key resolution (`config-resolve.js`)

**Files:**
- Create: `PS_NetworkMapper_V2/Network_Visualizer/src/config-resolve.js`
- Create: `PS_NetworkMapper_V2/Network_Visualizer/src/test/config-resolve.test.mjs`
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/network_vis.html:608` (new `<script>` tag)

**Interfaces:**
- Produces: `extractDeviceKeys(device)` → `{serial: string|null, hostname: string|null, ip: string}`.
  `serial` comes from the `StackMembers` entry with `Role === "Standalone"` or
  `Role === "Master"` (`null` if neither role is present). `hostname` is `device.Hostname`
  unless it's missing/`"Unknown"` (`null` in that case). `ip` is always `String(device.DeviceIP)`.
- Produces: `resolveDeviceLocation(device, configEntries)` → the matching entry object from
  `configEntries` (shape `{key, keyType, lat, lng, building, room, notes}`) or `null`.
  Tries `keyType: "serial"` first, then `"hostname"`, then `"ip"` — first match wins.
- Produces: `bestKeyForSave(device)` → `{key: string, keyType: 'serial'|'hostname'|'ip'}`,
  same priority order, used when the editor (Task 12) writes a new/updated entry.

- [ ] **Step 1: Write the failing tests**

```javascript
// PS_NetworkMapper_V2/Network_Visualizer/src/test/config-resolve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDeviceKeys, resolveDeviceLocation, bestKeyForSave } from '../config-resolve.js';

const STANDALONE = { DeviceIP: '10.0.0.1', Hostname: 'sw1', StackMembers: [{ Serial: 'SER1', Role: 'Standalone' }] };
const STACK = { DeviceIP: '10.0.0.2', Hostname: 'sw2', StackMembers: [{ Serial: 'S-BACKUP', Role: 'Backup' }, { Serial: 'S-MASTER', Role: 'Master' }] };
const NO_SERIAL = { DeviceIP: '10.0.0.3', Hostname: 'sw3', StackMembers: [] };
const NO_SERIAL_NO_HOSTNAME = { DeviceIP: '10.0.0.4', Hostname: 'Unknown', StackMembers: [] };

test('extractDeviceKeys reads a standalone device\'s serial', () => {
  assert.deepEqual(extractDeviceKeys(STANDALONE), { serial: 'SER1', hostname: 'sw1', ip: '10.0.0.1' });
});

test('extractDeviceKeys picks the Master member\'s serial for a stack, not Backup/Linecard', () => {
  assert.equal(extractDeviceKeys(STACK).serial, 'S-MASTER');
});

test('extractDeviceKeys returns null serial when no StackMembers entry has role Standalone or Master', () => {
  assert.equal(extractDeviceKeys(NO_SERIAL).serial, null);
});

test('extractDeviceKeys returns null hostname when Hostname is "Unknown"', () => {
  assert.equal(extractDeviceKeys(NO_SERIAL_NO_HOSTNAME).hostname, null);
});

test('extractDeviceKeys always returns ip', () => {
  assert.equal(extractDeviceKeys(NO_SERIAL_NO_HOSTNAME).ip, '10.0.0.4');
});

test('resolveDeviceLocation matches by serial first', () => {
  const entries = [
    { key: '10.0.0.1', keyType: 'ip', building: 'Wrong (stale IP-keyed entry)' },
    { key: 'SER1', keyType: 'serial', building: 'Right' },
  ];
  assert.equal(resolveDeviceLocation(STANDALONE, entries).building, 'Right');
});

test('resolveDeviceLocation falls back to hostname when no serial entry matches', () => {
  const entries = [{ key: 'sw3', keyType: 'hostname', building: 'By hostname' }];
  assert.equal(resolveDeviceLocation(NO_SERIAL, entries).building, 'By hostname');
});

test('resolveDeviceLocation falls back to ip as a last resort', () => {
  const entries = [{ key: '10.0.0.4', keyType: 'ip', building: 'By IP' }];
  assert.equal(resolveDeviceLocation(NO_SERIAL_NO_HOSTNAME, entries).building, 'By IP');
});

test('resolveDeviceLocation returns null when nothing matches', () => {
  assert.equal(resolveDeviceLocation(STANDALONE, []), null);
});

test('bestKeyForSave prefers serial when available', () => {
  assert.deepEqual(bestKeyForSave(STANDALONE), { key: 'SER1', keyType: 'serial' });
});

test('bestKeyForSave falls back to hostname when there is no serial', () => {
  assert.deepEqual(bestKeyForSave(NO_SERIAL), { key: 'sw3', keyType: 'hostname' });
});

test('bestKeyForSave falls back to ip as a last resort', () => {
  assert.deepEqual(bestKeyForSave(NO_SERIAL_NO_HOSTNAME), { key: '10.0.0.4', keyType: 'ip' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd PS_NetworkMapper_V2/Network_Visualizer && node --test src/test/config-resolve.test.mjs`
Expected: FAIL — `src/config-resolve.js` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```javascript
// PS_NetworkMapper_V2/Network_Visualizer/src/config-resolve.js
//
// Matches a scanned device to its Configuration.json location entry (if any). Keyed by
// chassis serial first (survives IP renumbering/hostname changes/reimaging - only the
// physical unit's own identity), hostname second, DeviceIP only as a last resort for the
// rare device whose chassis hardware never got parsed. See the geo-map-view design spec
// for why DeviceIP alone isn't durable enough for this file specifically (the rest of the
// app still keys by DeviceIP - that's a separate, existing, much larger concern).

function extractDeviceKeys(device) {
  var serial = null;
  (device.StackMembers || []).forEach(function (member) {
    if (member && (member.Role === 'Standalone' || member.Role === 'Master') && member.Serial) {
      serial = member.Serial;
    }
  });
  var hostname = (device.Hostname && device.Hostname !== 'Unknown') ? device.Hostname : null;
  return { serial: serial, hostname: hostname, ip: String(device.DeviceIP) };
}

function resolveDeviceLocation(device, configEntries) {
  var keys = extractDeviceKeys(device);
  var byKeyType = { serial: [], hostname: [], ip: [] };
  configEntries.forEach(function (entry) {
    if (byKeyType[entry.keyType]) byKeyType[entry.keyType].push(entry);
  });

  var tiers = [['serial', keys.serial], ['hostname', keys.hostname], ['ip', keys.ip]];
  for (var i = 0; i < tiers.length; i++) {
    var keyType = tiers[i][0], value = tiers[i][1];
    if (!value) continue;
    var match = byKeyType[keyType].find(function (e) { return e.key === value; });
    if (match) return match;
  }
  return null;
}

function bestKeyForSave(device) {
  var keys = extractDeviceKeys(device);
  if (keys.serial) return { key: keys.serial, keyType: 'serial' };
  if (keys.hostname) return { key: keys.hostname, keyType: 'hostname' };
  return { key: keys.ip, keyType: 'ip' };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { extractDeviceKeys: extractDeviceKeys, resolveDeviceLocation: resolveDeviceLocation, bestKeyForSave: bestKeyForSave };
} else if (typeof window !== 'undefined') {
    window.ConfigResolve = { extractDeviceKeys: extractDeviceKeys, resolveDeviceLocation: resolveDeviceLocation, bestKeyForSave: bestKeyForSave };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd PS_NetworkMapper_V2/Network_Visualizer && node --test src/test/config-resolve.test.mjs`
Expected: PASS, 12 tests.

- [ ] **Step 5: Add the script tag**

In `network_vis.html`, add `<script src="src/config-resolve.js"></script>` next to the
`topology-graph.js` tag added in Task 3 (before `graph.js`; order relative to
`topology-graph.js` doesn't matter, both are independent of each other).

- [ ] **Step 6: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/config-resolve.js PS_NetworkMapper_V2/Network_Visualizer/src/test/config-resolve.test.mjs PS_NetworkMapper_V2/Network_Visualizer/network_vis.html
git commit -m "Add device-location key resolution (serial > hostname > IP priority)"
```

---

### Task 5: Webserver endpoints for `Configuration.json.enc`

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Mapper/lib/Start-WebServer.ps1`
- Modify: `PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1:26-46` (new `-ConfigPath`)
- Modify: `.gitignore` (exclude the real `Configuration.json.enc`, same as `Auth.json`)
- Create: `PS_NetworkMapper/Network_Mapper/lib/Configuration.example.json` (template, mirrors `Auth.example.json`)

**Interfaces:**
- Produces (HTTP): `GET /api/config` → 200 with the raw envelope JSON if
  `Configuration.json.enc` exists, 404 `{"error": "No configuration file yet"}` if not.
- Produces (HTTP): `POST /api/save-config` → CSRF-checked (same `Test-SameOriginRequest`
  pattern as `/api/connect`/`/api/rescan`), body is the **plaintext** config JSON
  (`{"devices": [...]}`, matching `Configuration.json`'s decrypted shape); encrypts with
  `Protect-TopologyPayload -Format "PSNetworkMapper-EncryptedConfig"` using `Auth.json`'s
  `EncryptionPassword`, writes to `$ConfigPath`, responds 200 with `{"status": "saved"}`.

This sandbox has no `pwsh` — every step below is written and structurally verified by
exact pattern-matching against the existing, working `/api/rescan`/`/api/connect`
handlers (same CSRF check, same `Send-WebJson` helper, same body-reading idiom), not
executed here. The commands in Step 7 are for the user to run later, on a machine with
PowerShell, against a real `Auth.json`.

- [ ] **Step 1: Dot-source the shared crypto lib from `Start-WebServer.ps1` itself**

`Invoke-SaveConfigAction` (added in Step 2 below) needs `Get-TopologyKeyMaterial` and
`Protect-TopologyPayload` from Task 1's `TopologyCrypto.ps1`. Relying on
`Start-NetworkMapper.ps1` (the caller) having already dot-sourced it first would make this
file's correctness depend on caller load order — dot-source it directly instead, right
after `Start-WebServer.ps1`'s existing header comment, so the file is self-contained:

```powershell
. (Join-Path $PSScriptRoot "TopologyCrypto.ps1")
```

(`$PSScriptRoot` inside a dot-sourced file resolves to *that file's own* directory, not
the caller's — both files live in `Network_Mapper/lib/`, so this resolves correctly
regardless of how `Start-WebServer.ps1` itself gets loaded.)

- [ ] **Step 2: Add the two action functions**

In `Start-WebServer.ps1`, add these two functions near the existing `Invoke-RescanAction`/
`Invoke-ConnectAction` (same file, same conventions — `Send-WebJson` for all responses,
`[System.IO.StreamReader]` already used by the caller to read `$Body` before dispatch):

```powershell
# Serves the current Configuration.json.enc envelope as-is (still encrypted - the browser
# decrypts client-side with a human-typed password, exactly like NetworkMap files). 404
# with a JSON body (not the generic Invoke-StaticFile 404) so the browser can tell "no
# config yet" (a normal, expected state on a fresh checkout, same as missing Auth.json)
# apart from a real error.
function Invoke-GetConfigAction {
    param($Response, [string]$ConfigPath)

    if (-not (Test-Path $ConfigPath)) {
        Send-WebJson -Response $Response -StatusCode 404 -Object @{ error = "No configuration file yet" }
        return
    }

    try {
        $Envelope = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
        Send-WebJson -Response $Response -StatusCode 200 -Object $Envelope
    } catch {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to read configuration file: $_" }
    }
}

# Encrypts and writes Configuration.json.enc. The browser sends PLAINTEXT edited config
# JSON - the encryption password never crosses the wire in either direction, same as
# topology writes: this reads Auth.json's EncryptionPassword server-side, exactly like
# Start-NetworkMapper.ps1's Write-TopologyOutput does. A fresh salt/IV is generated per
# save (unlike a crawl's session-cached key - saves are rare/interactive, not periodic, so
# there's no repeated-PBKDF2-cost reason to cache keys across calls here).
function Invoke-SaveConfigAction {
    param($Response, [string]$Body, [string]$ConfigPath, [string]$AuthFile)

    if (-not (Test-Path $AuthFile)) {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Auth file missing at $AuthFile" }
        return
    }
    $AuthData = Get-Content $AuthFile -Raw | ConvertFrom-Json
    if (-not $AuthData.EncryptionPassword -or [string]::IsNullOrWhiteSpace($AuthData.EncryptionPassword)) {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Auth.json has no EncryptionPassword set" }
        return
    }

    $Parsed = $null
    try { $Parsed = $Body | ConvertFrom-Json } catch {}
    if (-not $Parsed -or -not $Parsed.devices) {
        Send-WebJson -Response $Response -StatusCode 400 -Object @{ error = "Request body must be JSON with a 'devices' array" }
        return
    }

    try {
        $SaltBytes = [byte[]]::new(16)
        $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $Rng.GetBytes($SaltBytes)
        $Rng.Dispose()

        $Iterations = 600000
        $KeyMaterial = Get-TopologyKeyMaterial -Password $AuthData.EncryptionPassword -Salt $SaltBytes -Iterations $Iterations
        $Envelope = Protect-TopologyPayload -PlainJson $Body -EncKey $KeyMaterial.EncKey -MacKey $KeyMaterial.MacKey -Salt $SaltBytes -Iterations $Iterations -Format "PSNetworkMapper-EncryptedConfig"

        $Envelope | ConvertTo-Json -Depth 10 | Out-File -FilePath $ConfigPath -Encoding utf8
        Send-WebJson -Response $Response -StatusCode 200 -Object @{ status = "saved" }
    } catch {
        Send-WebJson -Response $Response -StatusCode 500 -Object @{ error = "Failed to save configuration: $_" }
    }
}
```

- [ ] **Step 3: Wire the two routes into the accept loop, and thread `-ConfigPath` through**

Add `[Parameter(Mandatory=$true)][string]$ConfigPath` to `Start-MapperWebServer`'s param
block (alongside the existing `$VisualizerRoot`/`$AuthFile`/etc.), and add two branches to
the `if/elseif` chain inside the accept loop, immediately after the existing
`/api/rescan/status` branch and before the final `else` (the `Invoke-StaticFile` catch-all):

```powershell
                } elseif ($Request.HttpMethod -eq "GET" -and $Request.Url.AbsolutePath -eq "/api/config") {
                    Invoke-GetConfigAction -Response $Response -ConfigPath $ConfigPath
                } elseif ($Request.HttpMethod -eq "POST" -and $Request.Url.AbsolutePath -eq "/api/save-config") {
                    if (-not (Test-SameOriginRequest -Request $Request -Port $Port)) {
                        Send-WebJson -Response $Response -StatusCode 403 -Object @{ error = "Cross-origin request refused" }
                    } else {
                        $Reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
                        $Body = $Reader.ReadToEnd()
                        $Reader.Close()
                        Invoke-SaveConfigAction -Response $Response -Body $Body -ConfigPath $ConfigPath -AuthFile $AuthFile
                    }
                } else {
```

(replacing the existing bare `} else {` that currently precedes `Invoke-StaticFile`).

- [ ] **Step 4: Pass `-ConfigPath` from `Start-NetworkMapper.ps1`'s two call sites**

`Start-NetworkMapper.ps1` calls `Start-MapperWebServer` in exactly one place (the
server-only branch, line 45) — add the new argument there:

```powershell
    Start-MapperWebServer -VisualizerRoot $VisualizerRoot -ConnectScriptPath $ConnectScriptPath -AuthFile $AuthFile -WorkerPath $WorkerPath -Port $WebPort -ConfigPath $ConfigPath
```

and define `$ConfigPath` earlier in the file, next to the existing `$AuthFile` default
(around line 11), matching the "next to Auth.json" location from the spec:

```powershell
$ConfigPath = Join-Path (Split-Path $AuthFile -Parent) "Configuration.json.enc"
```

- [ ] **Step 5: Create the example template**

```json
{
  "devices": [
    {
      "key": "JN123ABC0456",
      "keyType": "serial",
      "lat": 47.65335,
      "lng": -122.30687,
      "building": "Example Building",
      "room": "Example Room",
      "notes": "Example notes - delete this entry, it's not real."
    }
  ]
}
```

Save as `PS_NetworkMapper/Network_Mapper/lib/Configuration.example.json` (plaintext, not
encrypted — a schema reference for hand-editing/onboarding, mirroring how
`Auth.example.json` is a plaintext template even though the real `Auth.json` holds a
real secret; unlike `Auth.json`, `Configuration.json.enc` is normally written by the
in-app editor, not hand-authored, but the template still documents the exact shape
`/api/save-config` expects in its request body).

- [ ] **Step 6: Add `Configuration.json.enc` to `.gitignore`**

It holds real building/room location data once written, same sensitivity class as
`Auth.json` (which `.gitignore` already excludes at line 5,
`PS_NetworkMapper/Network_Mapper/Auth.json`) — and this task's own Step 7 manual
verification creates one at exactly this path. Add, immediately after that existing
`Auth.json` line in `.gitignore`:

```
PS_NetworkMapper/Network_Mapper/Configuration.json.enc
```

- [ ] **Step 7: Manual verification (run on a machine with PowerShell — not this sandbox)**

```powershell
# From PS_NetworkMapper_V2/Network_Mapper/, with a real Auth.json present:
.\Start-NetworkMapper.ps1
# Then, in another terminal, with the server running:
curl.exe http://localhost:8787/api/config
# Expected: 404 {"error":"No configuration file yet"} on a fresh checkout.

curl.exe -X POST http://localhost:8787/api/save-config `
  -H "Content-Type: application/json" -H "Origin: http://localhost:8787" `
  -d '{"devices":[{"key":"TEST123","keyType":"serial","lat":47.6,"lng":-122.3,"building":"Test","room":"Test","notes":""}]}'
# Expected: 200 {"status":"saved"}, and Network_Mapper/Configuration.json.enc now exists.

curl.exe http://localhost:8787/api/config
# Expected: 200 with the envelope JSON (format: PSNetworkMapper-EncryptedConfig).

curl.exe -X POST http://localhost:8787/api/save-config -d '{"devices":[]}'
# No Origin/Referer header - expected: 403 {"error":"Cross-origin request refused"}.
```

- [ ] **Step 8: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Mapper/lib/Start-WebServer.ps1 PS_NetworkMapper_V2/Network_Mapper/Start-NetworkMapper.ps1 PS_NetworkMapper/Network_Mapper/lib/Configuration.example.json .gitignore
git commit -m "Add /api/config and /api/save-config endpoints for Configuration.json.enc"
```

---

### Task 6: Vendor Leaflet

**Files:**
- Create: `PS_NetworkMapper_V2/Network_Visualizer/src/vendor/leaflet/leaflet.js`
- Create: `PS_NetworkMapper_V2/Network_Visualizer/src/vendor/leaflet/leaflet.css`
- Create: `PS_NetworkMapper_V2/Network_Visualizer/src/vendor/leaflet/images/` (marker icon assets Leaflet's CSS references)

**Interfaces:**
- Produces: `window.L` (Leaflet's own global, unchanged from upstream) — consumed by `map.js` in Task 8.

Matches the existing vendoring pattern (`vis-network.min.js`, `oui-data.js`) instead of a
CDN `<script>` tag — the spike hit real friction from CDN dependencies (SRI/ORB failures,
tile-provider policy blocks) that a vendored copy sidesteps entirely for the *library*
itself (map tiles still need network access at runtime regardless — see the spec's
"Offline tiles" non-goal).

- [ ] **Step 1: Download Leaflet 1.9.4's distributable files and their marker image assets**

```bash
mkdir -p PS_NetworkMapper_V2/Network_Visualizer/src/vendor/leaflet/images
cd PS_NetworkMapper_V2/Network_Visualizer/src/vendor/leaflet
curl -sL -o leaflet.js https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
curl -sL -o leaflet.css https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
for f in marker-icon.png marker-icon-2x.png marker-shadow.png; do
  curl -sL -o "images/$f" "https://unpkg.com/leaflet@1.9.4/dist/images/$f"
done
```

- [ ] **Step 2: Verify the download landed real content, not an error page**

```bash
file leaflet.js leaflet.css images/*.png
head -c 200 leaflet.js   # expect a minified JS bundle header/comment, not HTML
```
Expected: `leaflet.js`/`leaflet.css` report as JavaScript/CSS text (not HTML), the three
PNGs report as valid PNG image data, `head` shows Leaflet's own license comment banner
(not a 404/error page's HTML).

- [ ] **Step 3: Verify the vendored files actually load in a browser with no console errors**

```bash
cd /home/alexander/Documents/Programming/Networking_Toolbox && (python3 -m http.server 8931 &)
```

Write a throwaway test HTML page (not committed) referencing the vendored paths exactly as
`network_vis.html` will in Task 7 (`src/vendor/leaflet/leaflet.css`,
`src/vendor/leaflet/leaflet.js`, relative to `Network_Visualizer/`), initialize
`L.map(...)` with a `CARTO` tile layer (same provider the spike settled on, see the spike's
README), screenshot it with headless Chromium the same way this session's spike was
verified, and confirm the map tiles render with no console errors referencing missing
marker icon images (Leaflet's CSS references `images/marker-icon.png` etc. by relative
path from `leaflet.css` — a missing icon shows as a broken-image glyph on the default
marker, catchable in the screenshot).

- [ ] **Step 4: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/vendor/leaflet/
git commit -m "Vendor Leaflet 1.9.4"
```

---

### Task 7: `network_vis.html` — view toggle, map container, editor/unplaced-devices markup

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/network_vis.html`

**Interfaces:**
- Produces (DOM elements Task 8+ read/control): `#center-view-toggle` (the Diagram/Map
  tab pair), `#mapview` (Leaflet's container, sibling of `#mynetwork`), `#mapUnplacedList`,
  `#location-editor-modal` (+ its form fields: `#editorBuilding`, `#editorRoom`,
  `#editorNotes`, `#editorSaveBtn`, `#editorCancelBtn`), `#mapStatusNote`.

This task is pure structure/CSS — no behavior yet (Task 8 wires the JS). Verified by
confirming the new elements render and default to the correct visibility, not by any
interaction.

- [ ] **Step 1: Add the view toggle and `#mapview` container**

In `network_vis.html`, replace the `<!-- CENTER PANEL: Map -->` block (lines 500–507)
with:

```html
    <!-- CENTER PANEL: Diagram / Map -->
    <div id="center-panel">
        <div id="center-view-toggle" class="tabs" style="flex:0 0 auto;">
            <div class="tab active" id="btn-center-view-diagram" onclick="window.switchCenterView('diagram')">Diagram</div>
            <div class="tab" id="btn-center-view-map" onclick="window.switchCenterView('map')">Map</div>
        </div>
        <div id="loadingBar">
            <div class="progress-border"><div id="progress-fill" class="progress-fill"></div></div>
            <div id="progress-text" style="margin-top: 10px; font-weight: bold; color: #333;">Initializing Engine...</div>
        </div>
        <div id="mynetwork"></div>
        <div id="mapview" style="display:none; position:absolute; inset:0; top:40px;"></div>
    </div>
```

(the existing `#center-panel` CSS rule at line 36, `position: relative`, already makes
`#mapview`'s `position:absolute` work correctly as a sibling overlay to `#mynetwork` — no
CSS change needed there. `top:40px` reserves the toggle bar's height, matching the
existing `.tabs` row height used elsewhere in this file.)

- [ ] **Step 2: Add the Unplaced Devices list and location editor markup**

Add this immediately after the `#mapview` div from Step 1:

```html
        <div id="mapUnplacedPanel" style="display:none; position:absolute; top:50px; left:10px; z-index:900; background:white; border:1px solid var(--border); border-radius:6px; box-shadow:0 2px 8px rgba(0,0,0,0.15); max-width:320px; max-height:60vh; overflow-y:auto;">
            <div style="padding:8px 12px; font-weight:bold; font-size:0.85rem; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="window.toggleUnplacedPanel()">
                <span id="mapUnplacedCount">0 devices with no location set</span>
                <span id="mapUnplacedToggleIcon">&#9660;</span>
            </div>
            <div id="mapUnplacedList" style="padding:4px 0;"></div>
        </div>
        <div id="mapStatusNote" style="display:none; position:absolute; bottom:16px; left:16px; z-index:900; background:rgba(20,22,26,0.9); color:white; padding:8px 14px; border-radius:6px; font-size:0.82rem;"></div>
    </div>

    <!-- Location Editor (map view - see window.openLocationEditor) -->
    <div id="location-editor-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:9999; justify-content:center; align-items:center;">
        <div style="background:var(--panel-bg); width:360px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3); overflow:hidden;">
            <div class="drawer-header"><h2 id="editorDeviceLabel">Set Location</h2></div>
            <div style="padding:18px;">
                <p style="font-size:0.82rem; color:#666; margin:0 0 12px;">Click a spot on the map to place this device, then fill in the details below.</p>
                <label style="font-size:0.8rem; font-weight:bold;">Building</label>
                <input type="text" id="editorBuilding" placeholder="Building name">
                <label style="font-size:0.8rem; font-weight:bold;">Room</label>
                <input type="text" id="editorRoom" placeholder="Room / closet">
                <label style="font-size:0.8rem; font-weight:bold;">Notes</label>
                <input type="text" id="editorNotes" placeholder="Notes">
                <div style="display:flex; gap:10px; margin-top:4px;">
                    <button type="button" id="editorCancelBtn" style="background:#eee; color:#333;" onclick="window.closeLocationEditor()">Cancel</button>
                    <button type="button" id="editorSaveBtn" onclick="window.commitLocationEdit()">Set Pin</button>
                </div>
            </div>
        </div>
    </div>
```

(placed after `</div>` closing `#center-panel`, as a top-level modal overlay — same
pattern as the existing `#password-modal`/`#fatal-error-modal`, which are also direct
children of `<body>`, not nested inside a panel.)

- [ ] **Step 3: Add the new `<script>` tags in dependency order**

Task 3 and Task 4 already added `topology-graph.js` and `config-resolve.js` before
`graph.js`. Add `map.js` (built in Task 8) after `drawer.js` and before `app.js` (it
calls `window.openRightDrawer`, defined in `drawer.js`, so `drawer.js` must load first;
`app.js` doesn't depend on `map.js`, so exact position relative to `app.js` doesn't
matter beyond "after drawer.js"):

```html
    <script src="src/vendor/leaflet/leaflet.js"></script>
    <script src="src/map.js"></script>
```

placed after `<script src="src/drawer.js"></script>` and before
`<script src="src/app.js"></script>`. Also add
`<link rel="stylesheet" href="src/vendor/leaflet/leaflet.css">` in `<head>`, after the
existing vendored-script comment block.

- [ ] **Step 4: Verify the page still loads with no console errors before `map.js` exists**

This step runs *before* Task 8 creates `map.js` — the new `<script src="src/map.js">` tag
will 404 at this point, which is expected and fine (a missing classic `<script>` tag logs
a console error but doesn't block the rest of the page). Serve the app, screenshot it, and
confirm: the Diagram/Map toggle renders at the top of the center panel, `#mapview` is
present but hidden, the page's *existing* functionality (file upload, search, etc.) is
visually unaffected. The `map.js` 404 in the console is expected here and gets resolved by
Task 8's own verification.

- [ ] **Step 5: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/network_vis.html
git commit -m "Add Diagram/Map view toggle, map container, and location-editor markup"
```

---

### Task 8: `map.js` — Leaflet init, config loading, marker/edge rendering

**Files:**
- Create: `PS_NetworkMapper_V2/Network_Visualizer/src/map.js`
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/src/app.js:55-70` (new `activeCenterView` global)

**Interfaces:**
- Consumes: `window.TopologyGraph.computeDeviceClassification/computeNeighborEdges` (Task 3),
  `window.ConfigResolve.resolveDeviceLocation` (Task 4), `window.TopologyCrypto.decryptEnvelope`
  (Task 2), `window.promptForPassword` (`app.js`, existing), `globalTopologyData`/`deviceByIp`
  (`app.js`, existing globals), `L` (Leaflet, Task 6).
- Produces: `window.switchCenterView(view)` (`'diagram'|'map'`), `window.initMapView()`,
  `window.renderMapMarkers()`, `window.revealDeviceOnMap(ip)` → `boolean` (consumed by
  Task 9), `window.mapConfigEntries` (array, the currently-loaded decrypted config's
  `devices`, consumed by Tasks 11/12).

- [ ] **Step 1: Add the `activeCenterView` global**

In `app.js`, add `var activeCenterView = 'diagram';` next to the existing
`var activeSidebarTab = 'sidebar-tab-load';` (line 60) — same pattern, same file, since
both are cross-cutting UI-mode state `app.js` already owns.

- [ ] **Step 2: Write `map.js`'s init/toggle/config-loading skeleton**

```javascript
// PS_NetworkMapper_V2/Network_Visualizer/src/map.js
//
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

    if (view === 'map' && leafletMap === null) window.initMapView();
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
// a missing Auth.json is handled elsewhere in this app.
window.loadMapConfiguration = async function() {
    var resp = await fetch('/api/config');
    if (resp.status === 404) {
        mapConfigEntries = [];
        mapConfigLoaded = true;
        return;
    }
    if (!resp.ok) {
        window.showMapStatus('Failed to load Configuration.json.enc: HTTP ' + resp.status);
        mapConfigEntries = [];
        mapConfigLoaded = true;
        return;
    }

    var envelope = await resp.json();
    var decryptedText = null;
    var errorMsg = null;
    while (decryptedText === null) {
        var password = await window.promptForPassword(errorMsg);
        try {
            decryptedText = await window.TopologyCrypto.decryptEnvelope(envelope, password, ['PSNetworkMapper-EncryptedConfig']);
        } catch (decErr) {
            errorMsg = decErr.message;
        }
    }
    mapConfigEntries = JSON.parse(decryptedText).devices || [];
    mapConfigLoaded = true;
};

window.showMapStatus = function(message) {
    var el = document.getElementById('mapStatusNote');
    el.textContent = message;
    el.style.display = message ? 'block' : 'none';
};
```

- [ ] **Step 3: Add marker/edge rendering**

```javascript
var MARKER_COLORS = {
    scannedStack: { background: '#D2E5FF', border: '#2B7CE9' },
    scanned: { background: '#97C2FC', border: '#2B7CE9' },
    unscanned: { background: '#E8E8E8', border: '#B0B0B0' },
};

function iconForClassification(meta) {
    var colors = !meta.scanned ? MARKER_COLORS.unscanned : (meta.isStack ? MARKER_COLORS.scannedStack : MARKER_COLORS.scanned);
    var size = 26;
    var label = meta.hostname !== 'Unknown' ? meta.hostname : '';
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
```

(`window.renderUnplacedDevicesList` is defined in Task 11 — referencing it here now with
its real signature so this task's marker rendering and Task 11's list rendering agree on
the exact data already computed, instead of Task 11 recomputing `classification`/
`deviceByIpLocal`/`placedByIp` a second time. Task 11 must add a real, non-empty function
matching this call, not a stub — if Task 11 hasn't run yet, this line is temporarily a
dangling reference; Step 5 below stubs it out for this task's own verification.)

- [ ] **Step 4: Add `revealDeviceOnMap` (consumed by Task 9)**

```javascript
// Pans/zooms to the device's marker if it has a resolved location; returns whether it did,
// so search.js (Task 9) knows whether to show a "no location set" status note instead.
window.revealDeviceOnMap = function(ip) {
    var marker = mapMarkersByIp.get(String(ip));
    if (!marker) return false;
    leafletMap.setView(marker.getLatLng(), Math.max(leafletMap.getZoom(), 17), { animate: true });
    return true;
};
```

- [ ] **Step 5: Temporary stub for `renderUnplacedDevicesList` (removed by Task 11)**

Add a placeholder at the bottom of `map.js` so Step 6's verification doesn't fail on the
dangling reference from Step 3 — Task 11 replaces this stub with the real implementation
(same function name/signature, so no caller needs to change):

```javascript
window.renderUnplacedDevicesList = function(classification, deviceByIpLocal, placedByIp) {
    // Replaced by Task 11 - intentionally empty for now.
};
```

- [ ] **Step 6: Verify marker/edge rendering against a realistic fixture**

Use the repo's own committed sample snapshot
(`PS_NetworkMapper/Network_Maps/NetworkMap_2026-08-13_091500.json`) plus a hand-built
plaintext `Configuration.json`-shaped fixture geo-tagging 3-4 of its real device IPs
(inspect the sample file for real `DeviceIP`/`StackMembers[].Serial` values to key by
serial, matching how the real feature will resolve entries) at real coordinates — same
UW-campus-testing approach as this session's spike. Serve the app, drive it with the CDP
pattern already established this session: upload the sample snapshot via the file input,
switch to Map view (click `#btn-center-view-map`), and when the config `GET /api/config`
call inevitably fails in this fixture (no running webserver backing `/api/config` in a
static `python3 -m http.server` — expected 404 or network error, handled gracefully as
"no config" per Step 2's code), directly set `mapConfigEntries` via a CDP `eval` step
before calling `window.renderMapMarkers()` again, to exercise rendering without needing a
real server round-trip:

```json
[{"eval": "mapConfigEntries = [{key: 'REPLACE-WITH-REAL-SERIAL-FROM-FIXTURE', keyType: 'serial', lat: 47.65335, lng: -122.30687, building: 'Test', room: 'Test', notes: ''}]; window.renderMapMarkers(); 'ok'"}, {"shot": "/tmp/.../map-real-app.png"}]
```

Confirm the screenshot shows the tile basemap, a marker at the expected coordinate, and no
console errors — same verification method (headless Chromium + `cdp.mjs`) already proven
in this session's spike.

- [ ] **Step 7: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/map.js PS_NetworkMapper_V2/Network_Visualizer/src/app.js
git commit -m "Add Leaflet map view: init, config loading, marker/edge rendering"
```

---

### Task 9: Search parity — reveal in whichever view is active

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/src/search.js:177-203` (`goToSearchResult`)

**Interfaces:**
- Produces: `window.revealDeviceInActiveView(ip)` (extracted from `goToSearchResult`'s
  inline diagram-only block).
- Consumes: `window.revealDeviceOnMap(ip)` (Task 8), `activeCenterView` (Task 8's global).

- [ ] **Step 1: Extract the reveal step and branch on the active view**

In `search.js`, replace the `try { network.selectNodes(...) } catch (e) { ... }` block
inside `goToSearchResult` (currently lines 187–199) with a call to a new function:

```javascript
        window.revealDeviceInActiveView(targetIp);
        window.openRightDrawer(targetIp);
```

Add the new function above `goToSearchResult` in the same file:

```javascript
// Reveals a device in whichever center view is currently active - diagram (select+focus
// on the vis-network canvas, today's original behavior) or map (pan/zoom to its marker,
// or a status note if it has no resolved location). Either branch is followed by
// openRightDrawer in the caller - the details drawer is identical regardless of which
// view revealed the device (see the geo-map-view design spec's "Search & details-drawer
// parity").
window.revealDeviceInActiveView = function(ip) {
    if (activeCenterView === 'map') {
        var revealed = window.revealDeviceOnMap(ip);
        if (!revealed) window.showMapStatus('No location set for this device.');
        else window.showMapStatus('');
        return;
    }
    try {
        network.selectNodes([ip]);
        network.focus(ip, { scale: 1.0, animation: { duration: 500 } });
    } catch (e) {
        console.warn(`Could not select/focus "${ip}" on the graph (likely not part of the visible tree):`, e.message);
    }
};
```

- [ ] **Step 2: Regression-check the diagram-view behavior is byte-identical**

`goToSearchResult`'s diagram branch (the `try`/`catch` around `selectNodes`/`.focus()`) is
moved verbatim, not rewritten — confirm by diffing the moved block against the original;
the only change is it now runs conditionally (only when `activeCenterView !== 'map'`,
which is `activeCenterView`'s default and the only value it ever takes until Task 8 exists
in a running session), so today's diagram-only behavior is unaffected for every existing
caller of `goToSearchResult`.

- [ ] **Step 3: Verify the map branch end-to-end**

Using the same fixture/CDP pattern as Task 8 Step 6 (sample snapshot + hand-set
`mapConfigEntries`, one device geo-tagged and one not): switch to Map view, use the search
sidebar to search for the geo-tagged device's hostname/IP, click the result, and confirm
via `eval` that `leafletMap.getCenter()` moved to the expected coordinate and
`document.getElementById('right-panel').style.display` shows the drawer is open. Repeat
for the non-geo-tagged device and confirm `#mapStatusNote` shows the "No location set"
text while the drawer *still* opens (the parity requirement - info access must not depend
on whether a location happens to be set).

- [ ] **Step 4: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/search.js
git commit -m "Search: reveal devices in whichever view (diagram or map) is active"
```

---

### Task 10: Marker click already opens the drawer — close the loop with a direct test

**Files:**
- Test only, no production code change (Task 8 Step 3 already wires
  `marker.on('click', function () { window.openRightDrawer(ip); })`).

This task exists to give marker-click-to-drawer its own explicit verification pass,
independent of the search-driven path Task 9 already exercises indirectly (a marker click
is a different code path — direct Leaflet event, not `goToSearchResult` — and deserves its
own check rather than being assumed correct because Task 9 passed).

- [ ] **Step 1: Verify with a direct click**

Using the same fixture as Task 8/9, drive a click at the geo-tagged marker's known screen
pixel position (computed the same way this session's spike computed marker positions:
`leafletMap.latLngToContainerPoint([lat, lng])`, then adjust for the map container's
on-page offset) via the CDP `{"click": [x, y]}` step, and confirm via `eval` that
`document.getElementById('drawer-title')` (or `currentSelectedNodeData`, the global
`drawer.js` sets) now reflects the clicked device's IP — proving the click reached the
marker and `openRightDrawer` actually ran, not just that the code exists.

- [ ] **Step 2: No commit needed** (no production files changed this task)

---

### Task 11: Unplaced Devices list

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/src/map.js` (replace Task 8's stub)

**Interfaces:**
- Produces: `window.renderUnplacedDevicesList(classification, deviceByIpLocal, placedByIp)`
  (real implementation, same signature Task 8 Step 3 already calls), `window.toggleUnplacedPanel()`.
- Consumes: `window.openLocationEditor(ip)` (Task 12 — referenced here, implemented there;
  Task 12 must match this exact call signature).

- [ ] **Step 1: Temporary stub for `openLocationEditor` (removed by Task 12)**

Task 12 defines the real `window.openLocationEditor`. Add a placeholder now so this
task's own row click handler (Step 2 below) has something to call instead of throwing a
`ReferenceError` — same forward-declaration pattern as Task 8 Step 5's
`renderUnplacedDevicesList` stub:

```javascript
window.openLocationEditor = function(ip) {
    // Replaced by Task 12 - intentionally records the call for this task's own
    // verification instead of opening the real editor.
    window.__lastOpenLocationEditorIp = ip;
};
```

- [ ] **Step 2: Replace the Task 8 stub with the real list renderer**

```javascript
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
        rowEl.innerHTML =
            '<span style="cursor:pointer; color:var(--accent);">' + (row.meta.hostname !== 'Unknown' ? row.meta.hostname : row.ip) + '</span>' +
            '<button type="button" style="width:auto; margin:0; padding:4px 8px; font-size:0.72rem;">Set location</button>';
        rowEl.querySelector('span').addEventListener('click', function () { window.openRightDrawer(row.ip); });
        rowEl.querySelector('button').addEventListener('click', function () { window.openLocationEditor(row.ip); });
        listEl.appendChild(rowEl);
    });
};
```

- [ ] **Step 3: Verify against the Task 8 fixture**

Using the same sample-snapshot fixture (which has more devices than the 1 geo-tagged one
from Task 8's fixture), switch to Map view and confirm via screenshot/`eval` that
`#mapUnplacedCount` reports the correct count (total scanned devices minus the one
geo-tagged one), and that clicking a row's "Set location" button sets
`window.__lastOpenLocationEditorIp` to that row's device IP (proving the click handler is
wired correctly, via Step 1's stub — Task 12 re-verifies the real editor opens once it
replaces this stub).

- [ ] **Step 4: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/map.js
git commit -m "Add Unplaced Devices list to the map view"
```

---

### Task 12: In-app location editor + save flow

**Files:**
- Modify: `PS_NetworkMapper_V2/Network_Visualizer/src/map.js`

**Interfaces:**
- Produces: `window.openLocationEditor(ip)`, `window.closeLocationEditor()`,
  `window.commitLocationEdit()` (click-to-place handler + form-to-pending-edit), `window.saveConfiguration()`
  (POSTs accumulated pending edits to `/api/save-config`).

- [ ] **Step 1: Add editor state and open/close**

```javascript
var editorTargetIp = null;
var editorPendingLatLng = null;
var pendingConfigEdits = new Map(); // key (from bestKeyForSave) -> full entry object, accumulated across edits until Save

window.openLocationEditor = function(ip) {
    editorTargetIp = ip;
    editorPendingLatLng = null;
    var device = deviceByIp.get(String(ip));
    document.getElementById('editorDeviceLabel').textContent = 'Set Location: ' + (device && device.Hostname !== 'Unknown' ? device.Hostname : ip);
    document.getElementById('editorBuilding').value = '';
    document.getElementById('editorRoom').value = '';
    document.getElementById('editorNotes').value = '';
    document.getElementById('location-editor-modal').style.display = 'flex';

    leafletMap.once('click', function (e) {
        editorPendingLatLng = e.latlng;
        window.showMapStatus('Pin placed at ' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) + ' - fill in the form and click Set Pin.');
    });
};

window.closeLocationEditor = function() {
    document.getElementById('location-editor-modal').style.display = 'none';
    editorTargetIp = null;
    editorPendingLatLng = null;
};
```

- [ ] **Step 2: Add the commit-edit and save handlers**

```javascript
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
    // Merge pending edits over the currently-loaded config entries (a pending edit for a
    // device that already had an entry replaces it - keyed the same way the entry itself
    // is keyed, so an edit that upgraded a device from hostname- to serial-keyed correctly
    // replaces its old hostname-keyed entry rather than leaving both).
    var merged = new Map(mapConfigEntries.map(function (e) { return [e.keyType + ':' + e.key, e]; }));
    pendingConfigEdits.forEach(function (entry, k) { merged.set(k, entry); });
    var devices = Array.from(merged.values());

    var resp = await fetch('/api/save-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devices: devices }),
    });
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
```

- [ ] **Step 3: Verify the client-side flow against a stand-in server**

This sandbox has no `pwsh` to run the real `/api/save-config`. Verify the *client* side
(does `map.js` build and send the right request, handle the response, update its own
state) against a throwaway stand-in server instead — not shipped, verification-only, same
spirit as this session's spike using `python3 -m http.server` as a stand-in:

```javascript
// throwaway-save-config-stub.mjs — NOT committed, verification-only
import { createServer } from 'node:http';
createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/save-config') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            console.log('RECEIVED:', body); // inspect this against the expected {"devices":[...]} shape
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'saved' }));
        });
    } else { res.writeHead(404); res.end(); }
}).listen(8787);
```

Run it (`node throwaway-save-config-stub.mjs`) alongside the app (proxied or served on the
same origin/port scheme the real webserver would use, so the browser's same-origin `fetch`
succeeds), drive the editor via CDP (open the editor for an unplaced device, click a map
point, fill the form, click "Set Pin", click "Save Configuration"), and confirm: the
stub's stdout shows a `devices` array containing the new entry with the right
`key`/`keyType` (serial-keyed if the fixture device has one), `#mapSaveConfigBtn`
disappears after a successful save, and the device now appears as a marker (moved out of
the Unplaced list) without a page reload.

- [ ] **Step 4: Commit**

```bash
git add PS_NetworkMapper_V2/Network_Visualizer/src/map.js
git commit -m "Add in-app location editor and Configuration.json.enc save flow"
```

---

### Task 13: Final integration pass and spike cleanup

**Files:**
- Delete: `Spike_GeoMapOverlay/` (throwaway spike — its findings are now implemented; see
  its own `README.md`: "delete this whole folder once its findings have been read")

- [ ] **Step 1: Full regression pass on the pure-logic test suites**

```bash
cd PS_NetworkMapper_V2/Network_Visualizer
rm -rf src/test/*.test.mjs.bak  # no-op safety, in case any editor left a backup file
node --test src/test/*.test.mjs
```
Expected: every test file passes, including the pre-existing `elk-layout.test.mjs` and
`graph-layout.test.mjs` (Task 3's `graph.js` edit must not have broken diagram layout —
this is the regression check for that).

- [ ] **Step 2: End-to-end manual walkthrough**

Using the same sample-snapshot fixture as Tasks 8–11, walk the full flow in one session:
load the snapshot → switch to Map view → confirm markers/edges render → search for a
geo-tagged device from the Search sidebar → confirm the map pans and the drawer opens →
close the drawer, click "Set location" on an Unplaced Devices row → place a pin, fill the
form, save → confirm the device moves out of the Unplaced list and appears as a marker →
switch back to Diagram view → confirm it's completely unaffected (same nodes/edges/styling
as before this plan existed). Screenshot key steps the same way this session's spike was
verified.

- [ ] **Step 3: Delete the throwaway spike**

`Spike_GeoMapOverlay/` was never committed to git (it was throwaway from the start) — if
it's present in this worktree/checkout, remove it directly rather than `git rm` (which
only works on tracked files and would fail here):

```bash
rm -rf Spike_GeoMapOverlay/
```

If it isn't present at all (e.g. it was already cleaned up before this worktree was
created), this step is a no-op — nothing to commit for it either way.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Final integration pass for the geographic map view"
```

- [ ] **Step 5: Note what still needs real-machine verification**

This plan's PowerShell tasks (1, 5) were written and structurally verified but never
executed — this sandbox has no `pwsh`. Before relying on the map view in production, run
Task 5 Step 5's manual `curl` walkthrough on a machine with PowerShell, against a real
`Auth.json`, and confirm a real crawl (`Start-NetworkMapper.ps1` with `-SwitchIP`) still
produces working `NetworkMap_*.json.enc` output — Task 1 changed how that encryption path
is wired together (dot-sourced shared lib instead of an inline function) even though it
shouldn't have changed its behavior.
