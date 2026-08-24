// Generic helpers with no feature-specific state of their own - string escaping, status
// text, the progress bar, MAC vendor lookup, daisy-chain detection. Used by every other
// file in this app. Classic script (not a module) like everything else here - see
// graph-layout.js's footer comment for why - so everything below is a plain global,
// reachable by bare name (or window.<name>) from any other <script> tag on the page.

// Escape device-supplied strings (hostnames, LLDP descriptions, etc. come from other
// network devices, not from this app, before they're interpolated into innerHTML.
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

// UI Helpers
//
// #status-text lives inside #sidebar-tab-load (network_vis.html) and is display:none
// whenever any other sidebar tab is active (.sidebar-tab-content only shows the one with
// .active - see app.js's switchSidebarTab). Plenty of setStatus callers are NOT gated by
// that tab: every drawer action (rescan, SSH launch, config export/print - drawer.js) is
// reachable from the drawer regardless of which sidebar tab is open, and the Settings
// tab's own Save/Reset (persistence.js) is *guaranteed* to fire while sidebar-tab-load is
// hidden, since Settings has to be the active tab for the user to click Save at all - so
// every one of those messages was silently invisible. Mirror through #mapStatusNote
// (map.js's window.showMapStatus) whenever #status-text itself isn't currently visible -
// that element is a sibling of both center-view panes, not gated by sidebar tab or
// diagram/map view (see map.js's switchCenterView comment). Skipped when #status-text IS
// visible so the common case (Load File tab already showing it) doesn't also flash a
// duplicate toast over the map/diagram.
//
// noMirror: true opts out for a caller that already wrote a MORE detailed message straight
// to showMapStatus itself and is now only writing a generic local pointer to #status-text
// (see persistence.js's saveSettingsPanel) - without it, this generic echo would win the
// race and overwrite the detailed reason the earlier call already put in #mapStatusNote.
window.setStatus = function(msg, color="blue", opts) {
    var el = document.getElementById('status-text');
    if(el) { el.innerText = msg; el.style.color = color; }
    if (!(opts && opts.noMirror) && (!el || el.offsetParent === null) && typeof window.showMapStatus === 'function') {
        window.showMapStatus(msg);
    }
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

// Surfaces how old the loaded scan is (ScanTimestamp, written once per crawl by
// Start-NetworkMapper.ps1) so a NOC tech can tell at a glance whether to trust what's
// on screen. Keeps updating live via setInterval so "3 minutes ago" doesn't go stale
// while the tab stays open. Files predating this field just show "unknown" - it isn't
// a parse error, ScanTimestamp is a new optional field, not a schema change. Reads
// window.loadSettings (persistence.js) for the fresh/stale cutoffs.
window.renderCrawlAge = function(scanTimestampIso) {
    var badge = document.getElementById('crawl-age-badge');
    if (crawlAgeInterval) { clearInterval(crawlAgeInterval); crawlAgeInterval = null; }
    if (!badge) return;

    var scanDate = scanTimestampIso ? new Date(scanTimestampIso) : null;
    if (!scanDate || isNaN(scanDate.getTime())) {
        badge.className = 'crawl-age unknown';
        badge.textContent = 'Capture time unknown (file predates this field)';
        badge.style.display = 'block';
        return;
    }

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
// ../Update-OuiDatabase.ps1 from the full IEEE OUI registry - ~40k entries as of
// writing). Best-effort string-matching against registered vendor names, not a
// certified device inventory - there is no separate "DoD device" OUI registry;
// government/GFE fleets buy the same COTS hardware under the same public OUIs as
// everyone else, so this is brand recognition, not a compliance data source.
var VENDOR_CATEGORY_RULES = [
    // Checked first: vendors that make both switches/APs AND phones/endpoints. In a MAC
    // table full of "clients" behind an access switch, a Cisco/Aruba/Juniper device is
    // far more likely to be an AP or another switch than a desk phone - this ordering
    // resolves that ambiguity toward the more common case rather than whichever rule
    // happens to be checked first.
    { category: 'Network-Infra', keywords: ['cisco', 'juniper', 'aruba', 'hewlett packard enterprise', 'hpe ', 'arista', 'ubiquiti', 'extreme networks', 'netgear', 'fortinet', 'palo alto'] },
    { category: 'Phone', keywords: ['poly', 'yealink', 'avaya', 'grandstream', 'mitel', 'snom', 'shoretel', 'aastra'] },
    { category: 'Laptop-OEM', keywords: ['dell', 'hewlett packard', 'hewlett-packard', 'lenovo', 'panasonic', 'getac', 'apple', 'microsoft'] },
    // Identifies the Ethernet chipset vendor, not the dock's outer brand - a Dell- or
    // Lenovo-branded dock very commonly contains a third-party Realtek/ASIX chip inside,
    // so this tag most likely means "laptop dock or USB adapter", not a literal
    // Realtek/ASIX-branded product.
    { category: 'Dock/Adapter-Chipset', keywords: ['realtek', 'asix electronics'] },
];

// Returns {vendor, category}. `vendor` is the raw IEEE-registered name or null if the
// prefix isn't in the database at all (not registered, or a locally-administered/
// randomized MAC - itself sometimes worth noticing). `category` is 'Unknown' only for
// that no-match case; a registered vendor that doesn't hit any keyword rule above comes
// back as 'Other' - deliberately a different bucket, since "real vendor we just haven't
// categorized" and "no vendor match at all" mean different things to someone scanning
// for anomalies.
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

// Client.Port and MedNeighbor.LocalPort can carry a logical-unit suffix ("ge-0/0/5.0"),
// while the Interfaces table's Port values are already bare physical ports (renderInterfaces
// filters out anything containing "." before it ever gets here) - normalize the same way
// Get-JunosNodeData.ps1 already does for its own PortDesc lookup so all three line up on
// one grouping key.
window.normalizePort = function(port) {
    return String(port || '').replace(/\.\d+$/, '');
};

// Daisy-chain detection: groups a device's clients by physical port to find a phone with
// a PC plugged into its own built-in switch port. The MAC table already shows two
// distinct MACs on one physical port with different VLANs (voice vs. data) in exactly
// this scenario - no new data collection, see Get-JunosNodeData.ps1's MAC-table parsing,
// which never dedups by port. LLDP-MED (MedNeighbors, captured instead of discarded as of
// this feature) upgrades confidence from a generic "multiple devices" guess to a
// confirmed phone ID when a MED phone/AP block exists on the same port.
//
// Returns Map<normalizedPort, {confidence: 'confirmed'|'possible', medDescription, clients}>.
window.detectDaisyChains = function(device) {
    var medByPort = new Map();
    window.asArray(device.MedNeighbors).forEach(m => {
        medByPort.set(window.normalizePort(m.LocalPort), m);
    });

    var byPort = new Map();
    (device.TrueClients || []).forEach(c => {
        var port = window.normalizePort(c.Port);
        if (!byPort.has(port)) byPort.set(port, []);
        byPort.get(port).push(c);
    });

    var result = new Map();
    byPort.forEach((clients, port) => {
        var distinctMacs = new Set(clients.map(c => String(c.MAC).toLowerCase()));
        var distinctVlans = new Set(clients.map(c => String(c.VLAN_Tag)));
        if (distinctMacs.size < 2 || distinctVlans.size < 2) return;

        var med = medByPort.get(port);
        result.set(port, {
            confidence: med ? 'confirmed' : 'possible',
            medDescription: med ? med.Description : null,
            clients: clients,
        });
    });
    return result;
};

// Shared badge markup for a daisy-chain hit, used by both renderInterfaces (once per
// port) and renderClients (once per client sharing a flagged port).
window.renderDaisyChainBadge = function(chain) {
    if (chain.confidence === 'confirmed') {
        return `<span class="daisy-badge confirmed" title="LLDP-MED identified: ${esc(chain.medDescription)}">Phone + PC (confirmed)</span>`;
    }
    return `<span class="daisy-badge possible" title="${chain.clients.length} devices on different VLANs share this port - likely a daisy-chained phone, but could be an unmanaged hub. No LLDP-MED confirmation seen.">Multiple devices (possible daisy-chain)</span>`;
};

// `indeterminate` marks a phase that can't report real fractional progress (an index
// rebuild, the layout algorithm) - those run as one uninterrupted synchronous block with
// no opportunity to update `percent` partway through, so without this the bar would just
// sit static for however long that block takes and look identical to a frozen page. The
// stripe animation it turns on (see .progress-fill.indeterminate in network_vis.html)
// only animates `transform`, which Chromium keeps compositing on its own thread even
// while the main thread is blocked - so it keeps visibly moving through exactly the
// stretch a plain width/text update can't cover.
window.showProgress = function(text, percent, indeterminate) {
    document.getElementById('loadingBar').style.display = 'flex';
    document.getElementById('progress-text').innerText = text;
    var fill = document.getElementById('progress-fill');
    fill.style.width = percent + '%';
    fill.classList.toggle('indeterminate', !!indeterminate);
};

// Yields one tick back to the browser so a just-set showProgress() text/width actually
// paints before the caller starts a long synchronous block - without this the DOM
// mutation is queued but never rendered until that block finishes, so the bar would
// appear to jump straight from the previous message to "done".
function nextPaint() {
    return new Promise(r => setTimeout(r, 0));
}

window.hideProgress = function() {
    document.getElementById('loadingBar').style.display = 'none';
};
