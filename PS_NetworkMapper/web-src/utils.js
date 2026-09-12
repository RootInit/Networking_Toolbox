// Generic helpers used by every other file. Classic script, not a module - see
// graph-layout.js's footer comment - so everything below is a plain global.

// Escapes device-supplied strings (hostnames, LLDP descriptions) before they reach innerHTML.
var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
window.esc = function(val) {
    if (val === null || val === undefined) return "";
    return String(val).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
};

// PowerShell's ConvertTo-Json serializes a single-element array as a bare object, so normalize any
// JSON-sourced collection through this before .length/.forEach/.map.
window.asArray = function(val) {
    if (Array.isArray(val)) return val.filter(item => item !== null && item !== undefined);
    if (val === null || val === undefined) return [];
    return [val];
};

// Keyboard activation for non-native interactive elements; pairs with tabindex="0" in index.html.
window.activateOnKey = function(event, fn) {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        fn();
    }
};

// The bundle is deliberately standalone-openable, but every fetch('/api/...') then resolves against
// file:// and rejects with the same TypeError a vanished server gives. This tells the two apart.
window.isFileOrigin = (window.location.protocol === 'file:');

// The browser's "Failed to fetch" reads identically for a stopped server, a wrong port and file://.
window.describeServerError = function(err) {
    if (window.isFileOrigin) {
        return "This page was opened directly from disk, so it has no server to talk to. " +
               "Scanning, rescans and saved settings need Start-NetworkMapper.ps1 running - " +
               "start it and use the http://localhost:<port>/ address it prints.";
    }
    // Set by callers that timed the attempt: a long wait then a failure means the connection was
    // accepted but never answered - a blocked server, so "is it running?" would misdirect.
    if (err && err.serverUnresponsive) {
        return "The local server accepted the connection but never answered. It is still " +
               "running, but blocked serving another request - check Mapper_Debug.log for a " +
               "SLOW REQUEST line naming what held it up, then try again.";
    }
    var detail = (err && err.message) ? err.message : String(err);
    return "Could not reach the local server at " + window.location.origin + " (" + detail + "). " +
           "Check that the Start-NetworkMapper.ps1 window is still running and that its " +
           "\"Web UI listening on\" address matches this tab's.";
};

// Mirrors a client-side error into Mapper_Debug.log, since the console alone is easy to lose.
// Fire-and-forget: failed POSTs are swallowed so error reporting can't raise a second error.
var reportedClientErrors = new Set();
window.reportClientError = function(message, opts) {
    opts = opts || {};
    // Once per (source, message) per page load, so an error in a poll loop can't flood the log.
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

// Catches errors that never reach a try/catch calling setStatus(..., "red").
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

// #status-text is hidden unless the Load tab is active, yet many callers fire while it is hidden -
// so mirror to showMapStatus when it isn't visible, and skip when it is. opts.noMirror lets a
// caller that already wrote its own detailed showMapStatus suppress this generic echo.
window.setStatus = function(msg, color="blue", opts) {
    var el = document.getElementById('status-text');
    if(el) { el.innerText = msg; el.style.color = color; }
    if (!(opts && opts.noMirror) && (!el || el.offsetParent === null) && typeof window.showMapStatus === 'function') {
        window.showMapStatus(msg);
    }
    // "red" is this app's convention for an error, so every user-visible error gets logged.
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

// Returns finite epoch ms, or null. Use everywhere a *Timestamp field is sorted, diffed or plotted:
// a truthy-but-unparseable string passes a `!x` guard and then yields NaN or "Invalid Date".
window.parseTimestampMs = function(ts) {
    if (!ts) return null;
    var ms = new Date(ts).getTime();
    return isNaN(ms) ? null : ms;
};

// Re-rendered on an interval so it can't go stale. ScanTimestamp is optional: older files show
// "unknown" rather than an error.
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
        badge.textContent = `Captured ${scanDate.toLocaleString('en-US')} (${window.formatAge(ageMs)})`;
        badge.style.display = 'block';
    }
    update();
    crawlAgeInterval = setInterval(update, 30000);
};

// Best-effort string matching on vendor names, not a certified inventory.
var VENDOR_CATEGORY_RULES = [
    // Ordered first: for vendors selling both, a hit in a client MAC table is the AP/switch.
    { category: 'Network-Infra', keywords: ['cisco', 'juniper', 'aruba', 'hewlett packard enterprise', 'hpe ', 'arista', 'ubiquiti', 'extreme networks', 'netgear', 'fortinet', 'palo alto'] },
    { category: 'Phone', keywords: ['poly', 'yealink', 'avaya', 'grandstream', 'mitel', 'snom', 'shoretel', 'aastra'] },
    { category: 'Laptop-OEM', keywords: ['dell', 'hewlett packard', 'hewlett-packard', 'lenovo', 'panasonic', 'getac', 'apple', 'microsoft'] },
    // These OUIs name the Ethernet chipset, not the outer brand - a dock or USB adapter.
    { category: 'Dock/Adapter-Chipset', keywords: ['realtek', 'asix electronics'] },
];

// vendor is null when the OUI is unregistered or randomized; 'Unknown' is reserved for that case
// and a registered-but-uncategorized vendor is 'Other' - the two differ when scanning for anomalies.
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

// Client.Port and MedNeighbor.LocalPort can carry a logical-unit suffix while Interfaces Ports are
// bare. Matches Get-JunosNodeData.ps1's PortDesc normalization so all three share one key.
window.normalizePort = function(port) {
    return String(port || '').replace(/\.\d+$/, '');
};

// Finds a phone with a PC behind its built-in switch port by grouping clients per physical port.
//   confirmed - LLDP-MED identified a phone/AP on this port.
//   likely    - 2+ MACs spanning 2+ VLANs (voice tagged, data untagged), no MED block.
//   possible  - 2+ MACs on one VLAN, which also fits an unmanaged hub or a stale mac-table entry.
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

// Stable cross-snapshot identity as "keyType:key". DeviceIP alone breaks on renumbering, so this
// reuses ConfigResolve.bestKeyForSave's serial > hostname > IP priority, not a second notion.
window.resolveDeviceIdentity = function(device) {
    var k = window.ConfigResolve.bestKeyForSave(device);
    return k.keyType + ':' + k.key;
};

// Shared so drawer.js's port rows and nested client sub-rows render an identical badge.
window.renderDaisyChainBadge = function(chain) {
    if (chain.confidence === 'confirmed') {
        return `<span class="daisy-badge confirmed" title="LLDP-MED identified: ${esc(chain.medDescription)}">Phone + PC (confirmed)</span>`;
    }
    if (chain.confidence === 'likely') {
        return `<span class="daisy-badge possible" title="${chain.clients.length} devices on different VLANs share this port - likely a daisy-chained phone, but could be an unmanaged hub. No LLDP-MED confirmation seen.">Multiple devices (likely daisy-chain)</span>`;
    }
    return `<span class="daisy-badge possible" title="${chain.clients.length} devices share this port, all on the same VLAN - likely an unmanaged hub/switch. Weaker signal than different-VLAN sharing: could also be a stale mac-table entry from a device that recently moved ports.">Multiple devices (possible daisy-chain)</span>`;
};

// `indeterminate` is for phases that run as one sync block. Its stripe animates only `transform`,
// which Chromium composites off the main thread, so it moves while a width update would be frozen.
window.showProgress = function(text, percent, indeterminate) {
    document.getElementById('loadingBar').style.display = 'flex';
    document.getElementById('progress-text').innerText = text;
    var fill = document.getElementById('progress-fill');
    fill.style.width = percent + '%';
    fill.classList.toggle('indeterminate', !!indeterminate);
};

// Yields a tick so a just-set showProgress() paints before the caller's long synchronous block.
function nextPaint() {
    return new Promise(r => setTimeout(r, 0));
}

window.hideProgress = function() {
    document.getElementById('loadingBar').style.display = 'none';
};
