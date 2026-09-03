// Generic helpers (string escaping, status text, progress bar, MAC vendor lookup,
// daisy-chain detection) used by every other file. Classic script, not a module - see
// graph-layout.js's footer comment - so everything below is a plain global.

// Escape device-supplied strings (hostnames, LLDP descriptions, etc. from other network
// devices, not this app) before they're interpolated into innerHTML.
var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
window.esc = function(val) {
    if (val === null || val === undefined) return "";
    return String(val).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
};

// PowerShell's ConvertTo-Json serializes a single-element array as a bare object,
// not a 1-element array - so a field with exactly one entry (one alarm, one stack
// member) arrives as {..} instead of [{..}]. Normalize before using .length/.forEach.
window.asArray = function(val) {
    if (Array.isArray(val)) return val;
    if (val === null || val === undefined) return [];
    return [val];
};

// Lets a non-native interactive element (a <div>/<span> tab or close button, kept off
// <button> for existing styling) respond to keyboard activation the same as a click -
// used together with tabindex="0" + role="tab"/"button" in index.html.
window.activateOnKey = function(event, fn) {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        fn();
    }
};

// Mirrors a client-side error into the server's log (Mapper_Debug.log - see WebServer.ps1's
// Write-MapperDebugLog/Invoke-ClientErrorAction) since the browser console alone is easy
// to lose after the fact. Fire-and-forget: failed POSTs are swallowed so error reporting
// can't itself raise a second error.
var reportedClientErrors = new Set();
window.reportClientError = function(message, opts) {
    opts = opts || {};
    // Log each (source, message) pair only once per page load, so a repeatedly-firing
    // error (e.g. a poll loop) doesn't flood the log.
    var key = (opts.source || '') + '|' + message;
    if (reportedClientErrors.has(key)) return;
    reportedClientErrors.add(key);

    try {
        fetch('/api/client-error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: String(message),
                source: opts.source || 'status',
                url: window.location.href,
                stack: opts.stack || (opts.error && opts.error.stack) || '',
            }),
        }).catch(() => {});
    } catch (e) { /* fetch itself unavailable/throwing - nothing else to do */ }
};

// Catches errors that never reach a try/catch calling setStatus(..., "red") - otherwise
// visible only in the devtools console.
window.addEventListener('error', function(e) {
    window.reportClientError(e.message || 'Uncaught error', {
        source: 'window.onerror', stack: e.error && e.error.stack,
    });
});
window.addEventListener('unhandledrejection', function(e) {
    var reason = e.reason;
    window.reportClientError((reason && reason.message) || String(reason), {
        source: 'unhandledrejection', stack: reason && reason.stack,
    });
});

// UI Helpers
//
// #status-text is hidden (display:none) unless the Load sidebar tab is active, but many
// callers (drawer actions, Settings Save) fire while it's hidden. Mirror to #mapStatusNote
// (map.js's showMapStatus) whenever #status-text isn't visible, so those messages aren't
// silently dropped; skipped when #status-text IS visible to avoid a duplicate toast.
//
// noMirror: true lets a caller that already wrote a more detailed message straight to
// showMapStatus (persistence.js's saveSettingsPanel) avoid this generic echo overwriting it.
window.setStatus = function(msg, color="blue", opts) {
    var el = document.getElementById('status-text');
    if(el) { el.innerText = msg; el.style.color = color; }
    if (!(opts && opts.noMirror) && (!el || el.offsetParent === null) && typeof window.showMapStatus === 'function') {
        window.showMapStatus(msg);
    }
    // "red" is this app's convention for an error message - piggyback on it to log every
    // user-visible error without instrumenting each individual catch block.
    if (color === "red") { window.reportClientError(msg, { source: 'status' }); }
};

window.formatAge = function(ms) {
    var sec = Math.floor(ms / 1000);
    if (sec < 60) return 'just now';
    var min = Math.floor(sec / 60);
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
    var hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
    var day = Math.floor(hr / 24);
    return `${day} day${day === 1 ? '' : 's'} ago`;
};

var crawlAgeInterval = null;

// Shared "is this actually a valid timestamp" check, used everywhere a *Timestamp field
// (scanTimestamp, etc - operator-controlled JSON, not guaranteed well-formed) gets sorted,
// diffed, or plotted. A truthy-but-unparseable string (e.g. "" survives a `!x` check as
// falsy, but a garbage non-date string doesn't) must never be treated as a valid date -
// that produces NaN sort comparators (silently "no swap" in some engines), NaN chart
// x-values, or literal "Invalid Date" text. Returns a finite epoch-ms number, or null.
window.parseTimestampMs = function(ts) {
    if (!ts) return null;
    var ms = new Date(ts).getTime();
    return isNaN(ms) ? null : ms;
};

// Shows how old the loaded scan is (ScanTimestamp, written once per crawl by
// Start-NetworkMapper.ps1), updating live so it doesn't go stale while the tab stays
// open. Files predating this optional field show "unknown", not an error. Reads
// window.loadSettings for the fresh/stale cutoffs.
window.renderCrawlAge = function(scanTimestampIso) {
    var badge = document.getElementById('crawl-age-badge');
    if (crawlAgeInterval) { clearInterval(crawlAgeInterval); crawlAgeInterval = null; }
    if (!badge) return;

    var scanMs = window.parseTimestampMs(scanTimestampIso);
    if (scanMs === null) {
        badge.className = 'crawl-age unknown';
        badge.textContent = 'Capture time unknown (file predates this field)';
        badge.style.display = 'block';
        return;
    }
    var scanDate = new Date(scanMs);

    function update() {
        var settings = window.loadSettings();
        var ageMs = Math.max(0, Date.now() - scanDate.getTime());
        var ageMin = ageMs / 60000;
        var freshness = ageMin < settings.crawlAgeFreshMin ? 'fresh' : (ageMin < settings.crawlAgeStaleMin ? 'stale' : 'old');
        badge.className = 'crawl-age ' + freshness;
        badge.textContent = `Captured ${scanDate.toLocaleString()} (${window.formatAge(ageMs)})`;
        badge.style.display = 'block';
    }
    update();
    crawlAgeInterval = setInterval(update, 30000);
};

// MAC vendor/category fingerprinting (see vendor/oui-data.js, generated by
// ../Update-OuiDatabase.ps1 from the IEEE OUI registry). Best-effort string-matching
// against vendor names, not a certified inventory.
var VENDOR_CATEGORY_RULES = [
    // Checked first: vendors making both switches/APs and phones - in client MAC tables,
    // a Cisco/Aruba/Juniper device is more likely an AP/switch than a desk phone.
    { category: 'Network-Infra', keywords: ['cisco', 'juniper', 'aruba', 'hewlett packard enterprise', 'hpe ', 'arista', 'ubiquiti', 'extreme networks', 'netgear', 'fortinet', 'palo alto'] },
    { category: 'Phone', keywords: ['poly', 'yealink', 'avaya', 'grandstream', 'mitel', 'snom', 'shoretel', 'aastra'] },
    { category: 'Laptop-OEM', keywords: ['dell', 'hewlett packard', 'hewlett-packard', 'lenovo', 'panasonic', 'getac', 'apple', 'microsoft'] },
    // Identifies the Ethernet chipset, not the outer brand - a Dell/Lenovo dock commonly
    // contains a third-party Realtek/ASIX chip, so this means "dock or USB adapter".
    { category: 'Dock/Adapter-Chipset', keywords: ['realtek', 'asix electronics'] },
];

// Returns {vendor, category}. vendor is null if the OUI prefix isn't registered (or is
// locally-administered/randomized). category is 'Unknown' only for that no-match case;
// a registered vendor matching no keyword rule is 'Other' (a different bucket, since
// "uncategorized real vendor" and "no vendor match" mean different things when scanning
// for anomalies).
window.lookupVendor = function(mac) {
    if (!mac || typeof mac !== 'string') return { vendor: null, category: 'Unknown' };
    var prefix = mac.replace(/[:\-.]/g, '').toUpperCase().slice(0, 6);
    if (prefix.length !== 6 || typeof window.OUI_DATABASE === 'undefined') return { vendor: null, category: 'Unknown' };

    var vendor = window.OUI_DATABASE[prefix];
    if (!vendor) return { vendor: null, category: 'Unknown' };

    var vendorLower = vendor.toLowerCase();
    for (var i = 0; i < VENDOR_CATEGORY_RULES.length; i++) {
        var rule = VENDOR_CATEGORY_RULES[i];
        if (rule.keywords.some(kw => vendorLower.indexOf(kw) !== -1)) {
            return { vendor: vendor, category: rule.category };
        }
    }
    return { vendor: vendor, category: 'Other' };
};

// Client.Port and MedNeighbor.LocalPort can carry a logical-unit suffix ("ge-0/0/5.0");
// Interfaces table Ports are already bare. Strip it, matching Get-JunosNodeData.ps1's own
// PortDesc normalization, so all three line up on one grouping key.
window.normalizePort = function(port) {
    return String(port || '').replace(/\.\d+$/, '');
};

// Daisy-chain detection: groups a device's clients by physical port to find a phone with
// a PC plugged into its own built-in switch port. LLDP-MED (MedNeighbors) upgrades
// confidence to a confirmed phone ID when a MED block exists on the same port.
//
// Returns Map<normalizedPort, {confidence: 'confirmed'|'likely'|'possible', medDescription, clients}>.
//
// Confidence tiers, most to least certain:
//   confirmed - LLDP-MED identified an actual phone/AP on this port.
//   likely    - 2+ MACs on this port span 2+ VLANs (phone tagging voice VLAN while
//               passing an untagged PC through on data VLAN), no MED confirmation.
//   possible  - 2+ MACs, all same VLAN - more likely an unmanaged hub/PC+printer, but
//               also more likely a stale mac-table entry from a device that moved ports
//               (which VLAN diversity would rule out), hence the weaker tier.
window.detectDaisyChains = function(device) {
    var medByPort = new Map();
    window.asArray(device.MedNeighbors).forEach(m => {
        medByPort.set(window.normalizePort(m.LocalPort), m);
    });

    var byPort = new Map();
    window.asArray(device.TrueClients).forEach(c => {
        var port = window.normalizePort(c.Port);
        if (!byPort.has(port)) byPort.set(port, []);
        byPort.get(port).push(c);
    });

    var result = new Map();
    byPort.forEach((clients, port) => {
        var distinctMacs = new Set(clients.map(c => String(c.MAC).toLowerCase()));
        if (distinctMacs.size < 2) return;
        var distinctVlans = new Set(clients.map(c => String(c.VLAN_Tag)));

        var med = medByPort.get(port);
        var confidence = med ? 'confirmed' : (distinctVlans.size >= 2 ? 'likely' : 'possible');
        result.set(port, {
            confidence: confidence,
            medDescription: med ? med.Description : null,
            clients: clients,
        });
    });
    return result;
};

// Stable cross-snapshot device identity (Topology Diff, Trends, Reliability heatmap,
// Config-Changed card, Config tab's device picker). DeviceIP alone breaks across
// snapshots on DHCP renewal/renumbering. Reuses window.ConfigResolve.bestKeyForSave's
// serial > hostname > IP priority (same one the geo-map location feature uses) instead of
// a second notion of identity that could drift. Returns "keyType:key", usable as a
// Map/object key or <select> option value.
window.resolveDeviceIdentity = function(device) {
    var k = window.ConfigResolve.bestKeyForSave(device);
    return k.keyType + ':' + k.key;
};

// Shared badge markup for a daisy-chain hit - renderInterfaces (drawer.js) calls this once
// per port row and once per nested client sub-row sharing a flagged port.
window.renderDaisyChainBadge = function(chain) {
    if (chain.confidence === 'confirmed') {
        return `<span class="daisy-badge confirmed" title="LLDP-MED identified: ${esc(chain.medDescription)}">Phone + PC (confirmed)</span>`;
    }
    if (chain.confidence === 'likely') {
        return `<span class="daisy-badge possible" title="${chain.clients.length} devices on different VLANs share this port - likely a daisy-chained phone, but could be an unmanaged hub. No LLDP-MED confirmation seen.">Multiple devices (likely daisy-chain)</span>`;
    }
    return `<span class="daisy-badge possible" title="${chain.clients.length} devices share this port, all on the same VLAN - likely an unmanaged hub/switch. Weaker signal than different-VLAN sharing: could also be a stale mac-table entry from a device that recently moved ports.">Multiple devices (possible daisy-chain)</span>`;
};

// `indeterminate` marks a phase with no fractional progress to report (index rebuild,
// layout algorithm - one uninterrupted sync block). Its stripe animation (see
// .progress-fill.indeterminate in network_vis.html) only animates `transform`, which
// Chromium composites on its own thread even while the main thread is blocked, so it
// keeps moving when a plain width/text update can't.
window.showProgress = function(text, percent, indeterminate) {
    document.getElementById('loadingBar').style.display = 'flex';
    document.getElementById('progress-text').innerText = text;
    var fill = document.getElementById('progress-fill');
    fill.style.width = percent + '%';
    fill.classList.toggle('indeterminate', !!indeterminate);
};

// Yields one tick so a just-set showProgress() text/width actually paints before the
// caller starts a long synchronous block, instead of the DOM mutation staying queued
// until that block finishes.
function nextPaint() {
    return new Promise(r => setTimeout(r, 0));
}

window.hideProgress = function() {
    document.getElementById('loadingBar').style.display = 'none';
};
