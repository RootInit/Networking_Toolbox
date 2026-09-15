// Generates a synthetic but structurally realistic topology snapshot for testing the visualizer at
// fleet scale, plus a matching Configuration file. Not part of the app - run manually:
//   node tools/generate-fixture.mjs                       # 350 devices -> ../Network_Maps/
//   node tools/generate-fixture.mjs --devices 1500 --seed 7 --out /tmp/maps
//   node tools/generate-fixture.mjs --snapshots 6         # six daily crawls of one fleet
//   node tools/generate-fixture.mjs --now                 # stamp it as a scan that just ran
//
// Port lists are scraped from chassis.js's artwork, so a device's Interfaces always match what its
// faceplate draws and art that stops matching its port names fails the fixture's assertions.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Chassis from '../chassis.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i === -1 ? fallback : argv[i + 1];
};
const DEVICE_COUNT = Math.max(4, parseInt(flag('devices', '350'), 10));
const SEED = parseInt(flag('seed', '1'), 10);
// Successive daily crawls of one fleet; the Trends/Diff/New Devices tabs stay empty with only one.
const SNAPSHOT_COUNT = Math.max(1, parseInt(flag('snapshots', '3'), 10));
const DEFAULT_OUT_DIR = path.resolve(path.join(HERE, '..', '..', 'Network_Maps'));
const OUT_DIR = path.resolve(flag('out', DEFAULT_OUT_DIR));

// How many deliberate faults to inject per snapshot. Zero by default: a fault has to be described by a
// manifest to be worth anything, and a consumer that does not read one is better off with a clean fleet.
const FAULT_COUNT = Math.max(0, parseInt(flag('faults', '0'), 10));

// mulberry32: a fixture must be reproducible from --seed alone, so never reach for Math.random().
function makeRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rnd = makeRng(SEED);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const shuffled = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
};

const PORT_RE = /^([a-z]+)-(\d+)\/(\d+)\/(\d+)$/;
const renumber = (name, fpc) => name.replace(PORT_RE, (_, pfx, _f, pic, n) => `${pfx}-${fpc}/${pic}/${n}`);

// A bay draws a blank cover until something is reported, so these candidates reveal what it accepts.
const MODULE_CANDIDATES = [1, 2].flatMap(pic => [
    ...Array.from({ length: 8 }, (_, n) => `xe-0/${pic}/${n}`),
    ...Array.from({ length: 4 }, (_, n) => `et-0/${pic}/${n}`),
]);

const scrape = (interfaces, model) => {
    const member = Chassis.buildMembers({
        StackMembers: [{ FPC: '0', Model: model, Role: 'Master' }],
        Interfaces: interfaces.map(Port => ({ Port })),
    })[0];
    const jacks = [], cages = [];
    // A modular chassis, or a model with no art, carries a note instead of a drawing - no ports to scrape.
    for (const m of (member.html || '').matchAll(/id="(port|uplink)_[^"]*"[^>]*data-port="([^"]+)"/g)) {
        (m[1] === 'port' ? jacks : cages).push(m[2]);
    }
    return { member, jacks, cages };
};

const portCache = new Map();
// jacks are fixed copper (never vary the prefix); cages are pluggable (the fixture varies the optic).
function portsFor(model) {
    if (portCache.has(model)) return portCache.get(model);
    const base = scrape([], model);
    // A modular chassis has no drawing, but the crawler still reports its ports.
    if (!base.member.catalogueKey && base.member.note) {
        const result = {
            jacks: [], cages: Array.from({ length: 32 }, (_, n) => `xe-0/0/${n}`),
            module: [], drawable: false, note: base.member.note,
        };
        portCache.set(model, result);
        return result;
    }
    let module = [];
    if (!base.member.inferred && base.member.catalogueKey) {
        const probe = scrape([...base.jacks, ...base.cages, ...MODULE_CANDIDATES], model);
        if (!probe.member.inferred) {
            const known = new Set([...base.jacks, ...base.cages]);
            module = [...probe.jacks, ...probe.cages].filter(p => !known.has(p) && MODULE_CANDIDATES.includes(p));
        }
    }
    const result = { jacks: base.jacks, cages: base.cages, module, drawable: !!base.member.catalogueKey, note: base.member.note || null };
    portCache.set(model, result);
    return result;
}

const CORE_MODELS = ['QFX5120-32C', 'QFX5200-32C'];
const DIST_MODELS = ['EX4600-40F', 'EX4650-48Y', 'QFX5120-48Y', 'EX4300-32F'];
const ACCESS_MODELS = [
    'EX2300-48P', 'EX2300-24P', 'EX2300-48T', 'EX3400-48P', 'EX3400-24P',
    'EX4300-48P', 'EX4300-48T', 'EX4300-48MP', 'EX4400-48P', 'EX4400-24P',
    'EX4100-48P', 'EX4100-24T', 'EX4000-48P', 'EX2300-C-12P', 'EX4100-F-12P',
    'EX2200-48P', 'EX3300-48P', 'EX4200-48P',
];
// Keeping one undrawable chassis here means that path is never first rendered in production.
const MODULAR_MODEL = 'EX9200-32XS';

// University of Washington, Seattle campus, in the five zones the university itself uses.
//
// lat/lng is each building's pole of inaccessibility - the interior point furthest from any exterior
// wall - from its OpenStreetMap footprint, and `r` is how far a closet may sit from it and still be
// indoors. A plain centroid is not enough: many are L- or U-shaped. Madrona and Willow Hall are
// stood in for by neighbouring halls OSM does carry. `closets` is how many wiring closets a building
// rates; `hub` marks the building whose main distribution frame feeds the zone.
const CAMPUS = [
    {
        name: 'West Campus', short: 'WEST', net: 20, adjacent: ['CENTRAL', 'NORTH'],
        buildings: [
            { abbr: 'UWT', name: 'UW Tower', lat: 47.660741, lng: -122.314667, r: 9, closets: 8, hub: true },
            { abbr: 'CDH', name: 'Condon Hall', lat: 47.656621, lng: -122.316231, r: 11, closets: 3 },
            { abbr: 'FSH', name: 'Fishery Sciences Building', lat: 47.653293, lng: -122.316354, r: 11, closets: 3 },
            { abbr: 'ELM', name: 'Elm Hall', lat: 47.656491, lng: -122.315255, r: 9, closets: 2 },
            { abbr: 'ALD', name: 'Alder Hall', lat: 47.655669, lng: -122.313853, r: 14, closets: 2 },
            { abbr: 'LAN', name: 'Lander Hall', lat: 47.6558, lng: -122.314693, r: 6, closets: 2 },
            { abbr: 'TRY', name: 'Terry Hall', lat: 47.655815, lng: -122.317064, r: 8, closets: 2 },
        ],
    },
    {
        name: 'Central Campus', short: 'CENTRAL', net: 30, adjacent: ['WEST', 'NORTH', 'SOUTH', 'EAST'],
        buildings: [
            { abbr: 'CMU', name: 'Communications Building', lat: 47.657156, lng: -122.305138, r: 7, closets: 6, hub: true },
            { abbr: 'SUZ', name: 'Suzzallo Library', lat: 47.655802, lng: -122.308276, r: 19, closets: 5 },
            { abbr: 'ALB', name: 'Allen Library', lat: 47.655661, lng: -122.307136, r: 12, closets: 4 },
            { abbr: 'ODE', name: 'Odegaard Undergraduate Library', lat: 47.656443, lng: -122.310416, r: 18, closets: 4 },
            { abbr: 'KNE', name: 'Kane Hall', lat: 47.656612, lng: -122.309161, r: 17, closets: 3 },
            { abbr: 'MGH', name: 'Mary Gates Hall', lat: 47.654864, lng: -122.307797, r: 15, closets: 4 },
            { abbr: 'GRB', name: 'Gerberding Hall', lat: 47.655301, lng: -122.309335, r: 9, closets: 2 },
            { abbr: 'SAV', name: 'Savery Hall', lat: 47.657398, lng: -122.308028, r: 7, closets: 3 },
            { abbr: 'SMI', name: 'Smith Hall', lat: 47.656786, lng: -122.306945, r: 7, closets: 2 },
            { abbr: 'MLR', name: 'Miller Hall', lat: 47.657291, lng: -122.30619, r: 6, closets: 2 },
            { abbr: 'DEN', name: 'Denny Hall', lat: 47.658385, lng: -122.308862, r: 8, closets: 2 },
            { abbr: 'BAG', name: 'Bagley Hall', lat: 47.653479, lng: -122.308859, r: 16, closets: 3 },
            { abbr: 'JHN', name: 'Johnson Hall', lat: 47.654762, lng: -122.309007, r: 7, closets: 2 },
            { abbr: 'PAA', name: 'Physics/Astronomy Building', lat: 47.65361, lng: -122.311012, r: 7, closets: 3 },
            { abbr: 'HUB', name: 'Husky Union Building', lat: 47.6553, lng: -122.30512, r: 19, closets: 4 },
            { abbr: 'MEA', name: 'Meany Hall', lat: 47.655693, lng: -122.310611, r: 15, closets: 2 },
            { abbr: 'CSE', name: 'Paul G. Allen Center', lat: 47.653221, lng: -122.305774, r: 12, closets: 5 },
            { abbr: 'EEB', name: 'Electrical & Computer Engineering', lat: 47.653602, lng: -122.306195, r: 9, closets: 3 },
            { abbr: 'GUG', name: 'Guggenheim Hall', lat: 47.654265, lng: -122.306322, r: 10, closets: 2 },
            { abbr: 'MOR', name: 'More Hall', lat: 47.652319, lng: -122.304555, r: 9, closets: 2 },
            { abbr: 'SIG', name: 'Sieg Hall', lat: 47.654876, lng: -122.306542, r: 6, closets: 2 },
        ],
    },
    {
        name: 'South Campus', short: 'SOUTH', net: 40, adjacent: ['CENTRAL', 'EAST'],
        buildings: [
            { abbr: 'HSB', name: 'Health Sciences Building', lat: 47.650778, lng: -122.309282, r: 20, closets: 10, hub: true },
            { abbr: 'UWMC', name: 'UW Medical Center', lat: 47.649062, lng: -122.307241, r: 22, closets: 9 },
            { abbr: 'FOE', name: 'William H. Foege Building', lat: 47.651865, lng: -122.313238, r: 10, closets: 4 },
            { abbr: 'HIT', name: 'Hitchcock Hall', lat: 47.651919, lng: -122.311521, r: 10, closets: 2 },
            { abbr: 'OSB', name: 'Ocean Sciences Building', lat: 47.651258, lng: -122.312714, r: 12, closets: 2 },
            { abbr: 'MSB', name: 'Marine Sciences Building', lat: 47.649886, lng: -122.312902, r: 7, closets: 2 },
            { abbr: 'SOCC', name: 'South Campus Center', lat: 47.649513, lng: -122.310909, r: 12, closets: 2 },
        ],
    },
    {
        name: 'North Campus', short: 'NORTH', net: 50, adjacent: ['CENTRAL', 'WEST'],
        buildings: [
            { abbr: 'MCM', name: 'McMahon Hall', lat: 47.658223, lng: -122.303631, r: 16, closets: 5, hub: true },
            { abbr: 'HGG', name: 'Haggett Hall', lat: 47.65929, lng: -122.30365, r: 10, closets: 3 },
            { abbr: 'MCC', name: 'McCarty Hall', lat: 47.660527, lng: -122.304696, r: 6, closets: 3 },
            { abbr: 'MDR', name: 'Oliver Hall', lat: 47.660003, lng: -122.304191, r: 15, closets: 2 },
            { abbr: 'WIL', name: 'Spratlen Hall', lat: 47.660174, lng: -122.305491, r: 8, closets: 2 },
            { abbr: 'OAK', name: 'Oak Hall', lat: 47.659269, lng: -122.306053, r: 7, closets: 2 },
            { abbr: 'HNS', name: 'Hansee Hall', lat: 47.660834, lng: -122.306763, r: 6, closets: 2 },
            { abbr: 'PDL', name: 'Padelford Hall', lat: 47.656964, lng: -122.30429, r: 6, closets: 4 },
        ],
    },
    {
        name: 'East Campus', short: 'EAST', net: 60, adjacent: ['CENTRAL', 'SOUTH'],
        buildings: [
            { abbr: 'IMA', name: 'Intramural Activities Building', lat: 47.653546, lng: -122.30113, r: 22, closets: 4, hub: true },
            { abbr: 'HEC', name: 'Alaska Airlines Arena at Hec Edmundson Pavilion', lat: 47.652052, lng: -122.302307, r: 22, closets: 3 },
            { abbr: 'HSTD', name: 'Husky Stadium', lat: 47.65037, lng: -122.30184, r: 10, closets: 4 },
            { abbr: 'DEM', name: 'Dempsey Indoor Center', lat: 47.651495, lng: -122.299326, r: 21, closets: 2 },
            { abbr: 'CSH', name: 'Conibear Shellhouse', lat: 47.652952, lng: -122.29972, r: 10, closets: 2 },
        ],
    },
];

const VOICE_TAG = 100;

// C4. Numbers, not strings: Clients[].VLAN_Tag and Vlans[].Tag are both ints in the worker now.
const VLANS = [
    { tag: 10, name: 'VLAN_MGMT' }, { tag: 20, name: 'VLAN_STAFF' },
    { tag: 30, name: 'VLAN_STUDENT' }, { tag: 100, name: 'VLAN_VOICE' },
    { tag: 300, name: 'VLAN_WIFI' }, { tag: 400, name: 'VLAN_PRINTERS' },
    { tag: 500, name: 'VLAN_CAMERAS' }, { tag: 666, name: 'VLAN_QUARANTINE' },
];

// The same values the config text writes as "set protocols rstp bridge-priority 4k|8k|32k".
const BRIDGE_PRIORITY = { CORE: 4096, DIST: 8192, ACC: 32768 };

const JUNOS_VERSIONS = ['21.4R3-S5.4', '22.2R3-S3.8', '22.4R3.25', '23.2R2-S1.5', '20.4R3-S9.2'];
// Everything but Ok is a placeholder node - a device with a status and nothing else. C1 split the old
// catch-all Unreachable into four, and each text here is a shape Get-JunosScanFailureClass classifies
// as that status: the fixture asserted a status its own error text no longer implies otherwise.
const FAILURE_STATUSES = ['Refused', 'NoRoute', 'Timeout', 'DnsFailed', 'AuthFailed', 'Aborted', 'ParseError'];
const FAILURE_TEXT = {
    Refused: 'ssh: connect to host {ip} port 22: Connection refused',
    NoRoute: 'ssh: connect to host {ip} port 22: No route to host',
    Timeout: 'ssh: connect to host {ip} port 22: Connection timed out',
    DnsFailed: 'ssh: Could not resolve hostname {ip}: Name or service not known',
    AuthFailed: 'Permission denied (publickey,password) for user svc-mapper',
    Aborted: 'Crawl aborted by circuit breaker while this job was in flight',
    ParseError: 'Switch returned empty payload [exit=255 elapsed=5.1s timedOut=False]',
};

// Fixed by default so a run is byte-reproducible; --now anchors it to the present instead.
const SCAN_DATE = argv.includes('--now') ? new Date() : new Date('2026-09-08T14:32:07Z');
const iso = (d) => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const daysAgo = (n) => new Date(SCAN_DATE.getTime() - n * 86400000);

const hexByte = () => int(0, 255).toString(16).padStart(2, '0');
const clientMac = () => ['aa', 'bb', hexByte(), hexByte(), hexByte(), hexByte()].join(':');
// A real IEEE assignment to General Dynamics Mission Systems, so the viewer's OUI lookup resolves it
// and the Crypto/INE flag fires; the aa:bb prefix above is deliberately unassigned and never would.
const ineMac = () => ['00', 'a0', '21', hexByte(), hexByte(), hexByte()].join(':');
const switchMac = () => ['02', 'ab', hexByte(), hexByte(), hexByte(), hexByte()].join(':').toUpperCase();

// Straddles the cpu/mem warn and critical thresholds, so every dashboard severity band is populated.
const cpuValue = () => (chance(0.06) ? int(91, 99) : chance(0.14) ? int(71, 89) : int(3, 62)) + '%';
const memValue = () => (chance(0.05) ? int(91, 98) : chance(0.18) ? int(76, 89) : int(28, 71)) + '%';

const CONFIG_USERS = ['svc-automation', 'jchen', 'root', 'netops', 'aparker'];

function configText(host, zone, bldg, vlanTags, extraLines) {
    const lines = [
        `set system host-name ${host}`,
        'set system login user admin class super-user',
        'set system authentication-order [ radius password ]',
        `set system radius-server 10.${zone.net}.0.20 secret "$9$REDACTED"`,
        'set system services ssh protocol-version v2',
        `set system ntp server 10.${zone.net}.0.30`,
        `set snmp community "$9$REDACTED" authorization read-only`,
        `set snmp location "${bldg.name}, ${zone.name}, University of Washington"`,
        'set protocols lldp interface all',
        'set protocols rstp bridge-priority 32k',
        ...vlanTags.map(t => `set vlans ${VLANS.find(v => v.tag === t).name} vlan-id ${t}`),
        ...extraLines,
    ];
    return lines.join('\n');
}

let serialCounter = 10000;
const nextSerial = () => `SYN${++serialCounter}`;

// A /24 per building inside a /16 per zone, so the IP Space tab's subnets mean something.
const ipFor = (bldg, host) => `10.${bldg.zone.net}.${bldg.idx}.${host}`;

// Metres between two buildings, near enough at this latitude, to find the nearest frame.
function metresBetween(a, b) {
    const dLat = (a.lat - b.lat) * 111320;
    const dLng = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
}
const nearest = (bldg, candidates) =>
    candidates.reduce((best, d) => (metresBetween(bldg, d.bldg) < metresBetween(bldg, best.bldg) ? d : best));
// You patch to the nearest frame that still has a port free, however close a full one is.
const nearestWithPort = (bldg, candidates) => {
    const free = candidates.filter(d => freeUplinks(d).length > 0);
    return free.length ? nearest(bldg, free) : null;
};

// The full key set of the crawler's $NodeData initializer; a missing key reaches the UI undefined.
function blankNode(deviceIp) {
    return {
        DeviceIP: deviceIp, Hostname: 'Unknown', JunosVersion: 'Unknown', Gateway: 'Unknown',
        StackMembers: [], Neighbors: [], Clients: [], ArpEntries: [], Interfaces: [],
        Uptime: 'Unknown', LastConfigured: 'Unknown', LastConfiguredBy: 'Unknown', Alarms: [],
        MasterCpuUtilization: 'Unknown', MasterMemoryUtilization: 'Unknown', MedNeighbors: [],
        Configuration: 'Unknown', ScanStatus: 'Ok', ScanError: null, Vlans: [],
        // R15/R12/R3. All empty on a node that never answered, as New-PlaceholderNodeLocal has them.
        SectionsCaptured: [], CaptureTimestamp: null, MacTable: [],
        // Section 4.3. Attempted-but-not-captured is "the command printed nothing"; an entry in
        // SectionErrors is "the CLI refused it"; in neither is "the session never got that far".
        SectionsAttempted: [], SectionErrors: {}, StpBridge: [],
        // R9/R8. A node that never answered has no route and no inventory to report.
        DefaultRoute: {}, ChassisInventory: [], LogicalUnits: [],
        // P1. null, not 0: zero uptime reads as "booted this second", which is a reset against every
        // later snapshot. Uptime above is the raw stamp and is not the same field.
        UptimeSeconds: null, FpcUptimes: [],
    };
}

// The $DataDict keys of Get-JunosNodeData.ps1, in the order the batch issues the commands. The order
// is what makes a truncated capture realistic: a timed-out session loses its TAIL, and the worker
// deliberately asks for "show interfaces extensive" last because it is the largest.
const CAPTURE_SECTIONS = [
    'VERSION', 'VIRTUAL_CHASSIS', 'CHASSIS_HARDWARE', 'ROUTE', 'INTERFACES_TERSE',
    'INTERFACES_DESC', 'STP', 'STP_BRIDGE', 'POE', 'DOT1X', 'LLDP', 'VLANS', 'MAC_TABLE', 'ARP_TABLE',
    'UPTIME', 'ALARMS', 'ROUTING_ENGINE', 'CONFIG', 'INTERFACES_EXT',
];

// Dropping a section has to drop what that section supplies, or the fixture asserts a state no real
// switch can produce (see spec 8.2) and every rule tested against it inherits the contradiction.
const SECTION_SUPPLIES = {
    CONFIG: (node) => { node.Configuration = 'Unknown'; },
    ROUTING_ENGINE: (node) => { node.MasterCpuUtilization = 'Unknown'; node.MasterMemoryUtilization = 'Unknown'; },
    // Now that applyPortDetail fills these, a truncated capture has to lose them: a node carrying
    // extensive values beside a SectionsCaptured that says the section never arrived is the false clean
    // the guard framework (section 3.2) exists to prevent, and it would make every guard decorative.
    INTERFACES_EXT: (node) => {
        for (const row of node.Interfaces) {
            Object.assign(row, {
                Mtu: null, SpeedConfigured: null, SpeedNegotiated: null,
                Duplex: null, DuplexNegotiated: null, AutoNegotiation: null, NegotiationStatus: null,
                MediaType: null, MacAddress: null, LinkLevelType: null, CarrierTransitions: null,
                InputBytes: null, OutputBytes: null, InputBps: null, OutputBps: null,
                InputErrors: {}, OutputErrors: {}, ActiveAlarms: null, ActiveDefects: null,
                StatisticsLastCleared: null, InputPackets: null, OutputPackets: null,
                RemoteFault: null, InterfaceFlags: null, DeviceFlags: null,
                BpduError: null, LoopDetectPduError: null,
                EthernetSwitchingError: null, MacRewriteError: null,
                MacStatistics: {}, PcsStatistics: {}, FecStatistics: {},
                // C5. "Last flapped" is read from the same extensive block as everything above it, not
                // from the terse listing, so it leaves with the section.
                LastFlappedSeconds: null, LastFlappedState: null,
            });
        }
    },
    // Section 4.3's added command, which supplies exactly one field.
    STP_BRIDGE: (node) => { node.StpBridge = []; },
    // The other two sections whose absence has to take their fields with them. Neither is in the tail
    // a truncated capture loses today, so both are guards against a future batch reordering rather
    // than states the generator currently produces.
    POE: (node) => {
        for (const row of node.Interfaces) {
            Object.assign(row, {
                PoE: 'Unknown', PoeAdminStatus: null, PoeOperStatus: null, PoePairMode: null,
                PoeMaxPower: null, PoePriority: null, PoePowerConsumption: null, PoeClass: null,
            });
        }
    },
    DOT1X: (node) => {
        for (const row of node.Interfaces) row.Dot1x = [];
        for (const client of node.Clients) { client.Dot1x_State = 'Unknown'; client.Dot1x_User = 'Unknown'; }
    },
    // Uptime is fifth-from-last in the batch, so a Partial node really can lose it - which is the case
    // G-BASELINE (spec 2.4) exists for: a rule suppressing on "rebooted recently" has to report
    // NOT_EVALUATED rather than assume a long uptime.
    UPTIME: (node) => {
        node.Uptime = 'Unknown';
        node.LastConfigured = 'Unknown';
        node.LastConfiguredBy = 'Unknown';
        // P1 comes from the same command, so it leaves with it. This is the "Unknown on either side"
        // case of port-last-used-spec.md section 4.3: neither a reset nor a continuation.
        node.UptimeSeconds = null;
        node.FpcUptimes = [];
    },
    // A no-op in shape - an empty Alarms list is also what a healthy device reports - and kept anyway so
    // the field's section is declared in one place. What separates the two states is SectionsCaptured,
    // which is why every guard reads that first.
    ALARMS: (node) => { node.Alarms = []; },
    // The three the L2 and L3 rules read. None is in the tail a truncated capture loses today, so like
    // ALARMS they declare where a field comes from rather than describing a state the generator
    // currently produces.
    ROUTE: (node) => { node.DefaultRoute = {}; node.Gateway = 'Unknown'; },
    MAC_TABLE: (node) => { node.MacTable = []; node.Clients = []; },
    ARP_TABLE: (node) => { node.ArpEntries = []; },
};

// R3. Derived from the clients already on the device rather than invented: an empty MacTable beside a
// populated Clients list is a state no switch produces, and every rule tested against it would
// inherit that contradiction (spec 8.2). Clients is the de-duplicated view, so the table is at least
// as long - the interesting extra rows (one MAC on two ports) are added deliberately below.
function buildMacTable(node) {
    const rows = [];
    for (const c of node.Clients || []) {
        rows.push({
            RoutingInstance: 'default-switch',
            VlanName: c.VLAN_Name, MacAddress: c.MAC,
            // 'D' is what a learned entry shows; the raw character is the point of R3.
            Flags: 'D', Age: null,
            // Clients carry the logical unit already; the physical port is that with the unit
            // stripped, exactly as ConvertTo-JunosPhysicalPort does on the worker side.
            Interface: c.Port, PhysicalPort: String(c.Port).replace(/\.\d+$/, ''),
        });
    }
    // One MAC aged-in on a second port is what endpoint resolution has to report as ambiguous, and a
    // fixture without one lets a resolver that never sees the case pass its own test. It has to land in
    // a DIFFERENT VLAN: the table is keyed by (VLAN, MAC), so one MAC twice in one VLAN is a row no
    // switch prints, and a MAC learned in a VLAN the port does not carry is one it cannot learn.
    const carriedBy = new Map((node.Interfaces || []).map(r => [r.Port, (r.Vlans || []).map(v => v.Name)]));
    if (rows.length > 2 && chance(0.2)) {
        const moved = rows[int(0, rows.length - 1)];
        const elsewhere = rows.find(r => r.PhysicalPort !== moved.PhysicalPort
            && (carriedBy.get(r.PhysicalPort) || []).some(name => name !== moved.VlanName));
        if (elsewhere) {
            const vlan = (carriedBy.get(elsewhere.PhysicalPort) || []).find(name => name !== moved.VlanName);
            rows.push({
                ...moved, VlanName: vlan,
                Interface: `${elsewhere.PhysicalPort}.0`, PhysicalPort: elsewhere.PhysicalPort,
            });
        }
    }
    return rows;
}

// R12 + R15, applied per snapshot because both depend on when that snapshot was taken.
// The .1 of the device's own management /24.
function managementGateway(deviceIp) {
    return `${String(deviceIp).split('.').slice(0, 3).join('.')}.1`;
}

function stampCapture(node, scanTime, fpcBooted) {
    // A fleet crawl spans minutes and scanTime is when the snapshot was written, so each device was
    // read somewhere in the window before it. That spread is the whole point of R12: one
    // ScanTimestamp is too coarse to compare counters or last-seen times across devices.
    node.CaptureTimestamp = new Date(scanTime.getTime() - int(0, 14 * 60000)).toISOString();
    // P1. Uptime in SECONDS, per member, measured against this device's own capture instant - which is
    // the only reason R12 exists. A member that rebooted on its own carries a shorter uptime than the
    // master here, and that difference is what port-last-used-spec.md section 4.3 splits segments on.
    const capturedMs = Date.parse(node.CaptureTimestamp);
    node.FpcUptimes = (node.StackMembers || []).map((m) => {
        const bootedMs = (fpcBooted || {})[m.FPC];
        const seconds = isFinite(bootedMs) && isFinite(capturedMs)
            ? Math.max(0, Math.round((capturedMs - bootedMs) / 1000)) : null;
        return { FPC: String(m.FPC), UptimeSeconds: seconds, SystemBooted: isFinite(bootedMs) ? iso(new Date(bootedMs)) : null };
    });
    const master = node.FpcUptimes.find((_, i) => (node.StackMembers || [])[i].IsMaster) || node.FpcUptimes[0] || null;
    node.UptimeSeconds = master ? master.UptimeSeconds : null;
    node.MacTable = buildMacTable(node);
    // R9. Every scanned device reached its gateway, so the route parsed; "Unparsed" is the state a
    // parser bug produces, not something a healthy fixture should claim.
    // The next hop sits on the subnet the device holds its own address on, which is what lets it ARP
    // for the gateway at all - a route to an address on no local subnet is the L3 rule's finding, not
    // the shape of a healthy device.
    node.Gateway = managementGateway(node.DeviceIP);
    node.DefaultRoute = {
        Table: 'inet.0', Destination: '0.0.0.0/0', Protocol: 'Static', Preference: 5,
        NextHop: node.Gateway, EgressInterface: 'vme.0', State: 'Parsed',
    };
    // R8. One PIC per stack member, and a cage with no Xcvr beneath it - the empty-cage case is the
    // whole reason the inventory is worth keeping.
    node.ChassisInventory = (node.StackMembers || []).flatMap((m, i) => {
        const rows = [
            { Item: `FPC ${m.FPC}`, Indent: 0, Level: 0, Version: 'REV 19', PartNumber: '650-059857', Serial: m.Serial, Description: m.Model },
            { Item: 'PIC 0', Indent: 2, Level: 1, Version: 'REV 19', PartNumber: 'BUILTIN', Serial: 'BUILTIN', Description: '48x10/100/1000 Base-T' },
            { Item: 'PIC 1', Indent: 2, Level: 1, Version: 'REV 19', PartNumber: '650-059857', Serial: m.Serial, Description: '4x10G SFP/SFP+' },
        ];
        // Half the uplink cages are populated; the rest are empty, which is what an absent Xcvr means.
        if (i === 0) rows.push({ Item: 'Xcvr 0', Indent: 4, Level: 2, Version: 'REV 01', PartNumber: '740-021309', Serial: `AM${1000 + i}WDF1`, Description: 'SFP-SX' });
        return rows;
    });
    // R1. Every unit on the device, flat with its parent - including the management unit, whose parent
    // has no Interfaces row. The L3 irb units the section 6.4 gateway rule will need are not emitted
    // yet: the fixture's client addressing is not subnet-coherent, so an irb address here would assert
    // a prefix no client actually sits inside. That lands with the rule, in Phase 2.
    node.LogicalUnits = [
        { Parent: 'vme', Unit: 0, Family: 'inet', LocalAddress: `${node.DeviceIP}/24`, Remote: null, Admin: 'up', Link: 'up' },
        ...node.Interfaces.flatMap(r => r.LogicalUnits || []),
    ];

    const dropped = chance(0.07) ? int(1, 3) : 0;
    node.SectionsCaptured = CAPTURE_SECTIONS.slice(0, CAPTURE_SECTIONS.length - dropped);
    // R15's three states. A truncated session never asked for the tail, so attempted == captured there;
    // a chassis with no PoE hardware is asked and REFUSES, which is a fourth thing that used to look
    // like truncation on 48 ports (section 3.5).
    node.SectionsAttempted = node.SectionsCaptured.slice();
    node.SectionErrors = {};
    for (const name of CAPTURE_SECTIONS.slice(CAPTURE_SECTIONS.length - dropped)) {
        if (SECTION_SUPPLIES[name]) SECTION_SUPPLIES[name](node);
    }
    const noPoeHardware = node.StackMembers.every(m => !/-\d+(P|MP)$/i.test(m.Model));
    if (noPoeHardware && node.SectionsCaptured.includes('POE')) {
        // The section arrived and its content is the refusal, so the key stays in SectionsCaptured -
        // that is what the switch did. What changes is that a reader can now tell why it is empty.
        node.SectionErrors.POE = 'error: PoE is not supported on this platform';
        SECTION_SUPPLIES.POE(node);
    }
}

// R13. Fictional vendors: a real model string from a captured network has no business in the repo.
const MED_PHONE = { Manufacturer: 'Contoso Telecom', ModelName: 'CT-4100', SerialNumber: 'CTX000000001', HardwareRevision: 'CT4100-A1', SoftwareRevision: '6.8.5' };
const MED_AP = { Manufacturer: 'Fabrikam Wireless', ModelName: 'FW-AP305', SerialNumber: 'FWX000000001', HardwareRevision: 'AP305-B2', SoftwareRevision: '8.11.2' };

const AP_DESC = n => `AP-${1000 + n}`;
const PHONE_DESC = n => `PHONE-${2000 + n}`;
const INE_DESC = n => `INE-${3000 + n}`;

// One row per port the faceplate draws; uplinks carrying a neighbour are filled in by linkDevices.
function buildInterfaces(device, members) {
    const rows = [];
    for (const m of members) {
        const p = portsFor(m.Model);
        const fpc = parseInt(m.FPC, 10);
        const poe = /-\d+(P|MP)$/i.test(m.Model);
        for (const jack of p.jacks) rows.push(accessRow(renumber(jack, fpc), poe, false));
        for (const cage of p.cages) rows.push(accessRow(renumber(cage, fpc), false, true));
        // An empty bay is the commoner state and draws a cover, which is its own rendering path.
        if (p.module.length && chance(0.55)) {
            const fitted = p.module.filter(x => x.includes(`/${p.module[0].split('/')[1]}/`));
            for (const mod of fitted) rows.push(accessRow(renumber(mod, fpc), false, true));
        }
    }
    device.Interfaces = rows.sort((a, b) => a.Port.localeCompare(b.Port));
}

function accessRow(port, poe, isCage) {
    // A cage names itself after the optic, so the catalogue prefix alone would skip sibling binding.
    if (isCage && chance(0.25)) port = port.replace(PORT_RE, (_, pfx, f2, pic, n) => `${pick(['ge', 'xe', 'et'])}-${f2}/${pic}/${n}`);
    const live = chance(0.42);
    const row = {
        Port: port,
        Admin: live || chance(0.9) ? 'up' : 'down',
        Link: live ? 'up' : 'down',
        Desc: 'Unknown',
        // Overwritten by computeSpanningTree; a port it never reaches is on a device that never
        // answered, and "Unknown" is the honest value there.
        STP: 'Unknown',
        // The worker builds this string as "$oper ($consumption)" from the PoE table's Oper-status and
        // Power-consumption columns (Get-JunosNodeData.ps1:559), and the real Oper-status values are ON
        // and OFF. "Delivering"/"Enabled" was this generator's invention, and a rule matching it would
        // have worked on fixtures only.
        PoE: poe ? (live && chance(0.5) ? `ON (${(rnd() * 12 + 1.4).toFixed(1)}W)` : 'OFF (0.0W)') : 'Unknown',
        // The sort needs a spread across the 72h/6-month bands plus a slice with no value at all.
        LastFlappedSeconds: live ? int(60, 72 * 3600)
            : chance(0.15) ? null
                : chance(0.5) ? int(72 * 3600, 182 * 86400) : int(182 * 86400, 900 * 86400),
        // C5. Why LastFlappedSeconds is null. "Never" is the healthy state - the port has not flapped
        // since boot - and read identically to a duration the parser could not decode.
        LastFlappedState: null,
    };
    setFlap(row, row.LastFlappedSeconds);
    // Every remaining key of the worker's interface initializer, at its unfilled value. The values
    // come from applyPortDetail once links and clients exist; what matters here is that no row is ever
    // missing a key, because an absent key and a $null one are different facts (section 2.5).
    Object.assign(row, {
        Mtu: null, SpeedConfigured: null, SpeedNegotiated: null,
        Duplex: null, DuplexNegotiated: null, AutoNegotiation: null, NegotiationStatus: null,
        MediaType: null, MacAddress: null, LinkLevelType: null, CarrierTransitions: null,
        InputBytes: null, OutputBytes: null, InputBps: null, OutputBps: null,
        InputErrors: {}, OutputErrors: {}, ActiveAlarms: null, ActiveDefects: null,
        StpDetail: {}, Bundle: null, BundleMembers: [], Vlans: [],
        StatisticsLastCleared: null, InputPackets: null, OutputPackets: null,
        RemoteFault: null, InterfaceFlags: null, DeviceFlags: null,
        BpduError: null, LoopDetectPduError: null,
        EthernetSwitchingError: null, MacRewriteError: null,
        MacStatistics: {}, PcsStatistics: {}, FecStatistics: {},
        Dot1x: [],
        PoeAdminStatus: null, PoeOperStatus: null, PoePairMode: null,
        PoeMaxPower: null, PoePriority: null, PoePowerConsumption: null, PoeClass: null,
    });
    if (live && chance(0.35)) row.Desc = chance(0.5) ? AP_DESC(int(1, 400)) : PHONE_DESC(int(1, 900));
    // R1. A configured switch port has one eth-switch unit; a dark port often has none at all, which
    // is what makes an empty LogicalUnits[] a state the UI has to handle rather than an omission.
    row.LogicalUnits = live || chance(0.8)
        ? [{ Parent: port, Unit: 0, Family: 'eth-switch', LocalAddress: null, Remote: null, Admin: row.Admin, Link: row.Link }]
        : [];
    return row;
}

function makeDevice({ deviceIp, bldg, seq, models, role, gateway }) {
    const node = blankNode(deviceIp);
    // Building abbreviation first: the hostname alone tells you which closet to walk to.
    node.Hostname = `uw-${bldg.abbr.toLowerCase()}-${role.toLowerCase()}${String(seq).padStart(2, '0')}.washington.edu`;
    node.JunosVersion = pick(JUNOS_VERSIONS);
    // The device upstream of this one, which is not the same fact as the default route's next hop:
    // stampCapture sets Gateway to the address the device actually routes through.
    node._uplinkIp = gateway;
    node.Gateway = gateway;
    node.StackMembers = models.map((model, i) => ({
        FPC: String(i),
        Model: model,
        Serial: nextSerial(),
        Role: models.length === 1 ? 'Standalone' : i === 0 ? 'Master' : i === 1 ? 'Backup' : 'Linecard',
        // R11. Status is what distinguishes a configured member that is actually there from one that
        // dropped out; without it a degraded stack looked identical to a healthy one.
        Status: 'Prsnt',
        MasterPriority: models.length === 1 ? null : 129,
        IsMaster: i === 0,
        NeighborList: models.length === 1 ? [] : [{ MemberId: String((i + 1) % models.length), Interface: `vcp-255/1/${i}` }],
    }));
    node.MasterCpuUtilization = cpuValue();
    node.MasterMemoryUtilization = memValue();
    // A handful of recent boots so the reboot badge has something to flag; the rest span years.
    node.Uptime = iso(chance(0.04) ? daysAgo(rnd() * 0.02) : daysAgo(int(3, 1100)));
    // Members boot together and finish ifd init a few seconds apart - the measured spread in
    // port-last-used-spec.md section 1.2 is 4 s per member. ageFleet is what makes one of them differ.
    node._fpcBooted = Object.fromEntries(node.StackMembers.map((m, i) => [String(m.FPC), Date.parse(node.Uptime) + i * 4000]));
    // Crosses crawlAgeStaleMin so the "recently changed" and "stale" config views differ.
    node.LastConfigured = iso(daysAgo(chance(0.2) ? rnd() * 0.5 : int(1, 700)));
    node.LastConfiguredBy = pick(CONFIG_USERS);
    if (chance(0.05)) {
        node.Alarms = [pick([
            'Minor  Fan tray 1 failure', 'Major  PEM 0 Not OK', 'Minor  Temperature Warm',
            'Major  Backup RE Active', 'Minor  Host 0 Boot from backup root',
        ])];
    }
    buildInterfaces(node, node.StackMembers);
    node.bldg = bldg;
    node.zone = bldg.zone;
    node.role = role;
    // One chassis MAC per device, not one per link: a real switch advertises the same chassis ID to
    // every neighbour, and it is the tie-break in the bridge ID the spanning-tree pass elects on.
    node.bridgeMac = switchMac();
    node.bridgePriority = BRIDGE_PRIORITY[role];
    return node;
}

// Free uplink cages in the order the art draws them, so links land where a real install would patch.
function freeUplinks(node) {
    if (!node._freeUplinks) {
        const cageSet = new Set();
        for (const m of node.StackMembers) {
            const p = portsFor(m.Model);
            const fpc = parseInt(m.FPC, 10);
            for (const c of [...p.cages, ...p.module]) cageSet.add(renumber(c, fpc));
        }
        // Match against the row actually emitted, whose optic prefix may differ from the art's.
        node._freeUplinks = node.Interfaces
            .filter(r => cageSet.has(r.Port) || cageSet.has(r.Port.replace(/^[a-z]+/, 'xe')) || cageSet.has(r.Port.replace(/^[a-z]+/, 'ge')) || cageSet.has(r.Port.replace(/^[a-z]+/, 'et')))
            .map(r => r.Port);
    }
    return node._freeUplinks;
}

const byPort = (node) => (node._byPort ||= new Map(node.Interfaces.map(r => [r.Port, r])));

// C5. The duration and the reason it is absent are one fact; setting one without the other is how the
// fixture came to hold rows that carried a duration while claiming the parser never read one.
function setFlap(row, seconds) {
    row.LastFlappedSeconds = seconds;
    row.LastFlappedState = seconds !== null ? 'Parsed' : (chance(0.7) ? 'Never' : 'Unparsed');
}

// One draw per ATTACHMENT, not per neighbour entry. Autonegotiation state and frame size are
// properties of the wire: drawing them on each side independently made a quarter of the clean fleet's
// links carry an autoneg mismatch and nearly half an MTU mismatch, which is the F11 trap again - the
// fault the injector is supposed to be the only source of was the fleet's normal state.
// Autonegotiation is a copper property. In the measured capture every fibre port - and every fibre
// port's LLDP advertisement - reports it as NOT SUPPORTED, and the switch prints no `Auto-negotiation`
// field and no negotiation stanza on those ports at all. Drawing "disabled" on a 10G cage would be a
// state no switch produces, and it is the state that would make an autoneg rule fire on every uplink.
// The media is the TRANSCEIVER's, not the cage's: a 10G cage carrying a copper SFP+ reports Copper and
// negotiates, which is why one uplink in five here is copper. Without those, every switch-to-switch link
// in the fleet would be optical and the three rules that compare a wire's two ends would have no subject
// to run on at fixture scale.
function attachment(cage) {
    const fibre = cage ? !chance(0.2) : false;
    const autoneg = fibre ? 'unsupported' : chance(0.25) ? 'disabled' : 'enabled';
    return { autoneg: autoneg, mtu: chance(0.15) ? 9192 : 1514, fibre: fibre };
}

// The Junos wording, verbatim from a real capture's TLVs rather than paraphrased: R2 keeps `Info` as
// the switch printed it, so a rule written against an invented string is a rule that works only here.
// Three forms, and the difference between the last two is the whole point: `not supported` is the field
// being unavailable (every fibre port in the capture, 27 of its 43 LLDP blocks) and `supported, disabled`
// is autonegotiation deliberately off. Conflating them makes an autoneg rule fire on every 10G uplink.
// The (0x1) form is derived from the same TLV's bit layout, which the capture shows in use on the
// neighbouring `Aggregation Status [supported, disabled (0x1)]` line.
const autonegInfo = (state) => (state === 'enabled'
    ? 'Autonegotiation [supported, enabled (0x3)], PMD Autonegotiation Capability (0xc036), MAU Type (0x0)'
    : state === 'disabled'
        ? 'Autonegotiation [supported, disabled (0x1)], PMD Autonegotiation Capability (0xc036), MAU Type (0x0)'
        : 'Autonegotiation [not supported, disabled (0x0)], PMD Autonegotiation Capability (0x0), MAU Type (0x0)');
const frameSizeInfo = (mtu) => `MTU Size (${mtu})`;
// The optical cages, by port name: the generator's jacks are ge and its cages xe/et.
const isFibre = (port) => /^(?:xe|et)/.test(String(port));

// R2/R2b/R13/R5. The fields every LLDP neighbour row carries, switch or endpoint. Omitting them here
// is how the fixture silently stops matching production shape, so both neighbour builders use this.
function lldpCommon({ reachable = true, med = null, link = null } = {}) {
    const wire = link || attachment();
    return {
        Reachable: reachable,
        // R2. 802.3 TLVs. Autoneg disabled on a live link is the defect this exists to expose.
        OrgInfo: [
            { OUI: '00-12-0f', Subtype: 'MAC/PHY Configuration/Status (1)', Info: autonegInfo(wire.autoneg) },
            { OUI: '00-12-0f', Subtype: 'Maximum Frame Size (4)', Info: frameSizeInfo(wire.mtu) },
        ],
        // R2b. Age is bounded by the advertised TTL; a neighbour older than that would have aged out.
        AgeoutCount: chance(0.2) ? int(1, 6) : 0,
        TimeToLive: 120,
        TimeMark: null,
        AgeSeconds: int(0, 119),
        // R13. Only LLDP-MED endpoints report inventory; a switch neighbour leaves all six null.
        Manufacturer: med ? med.Manufacturer : null,
        ModelName: med ? med.ModelName : null,
        SerialNumber: med ? med.SerialNumber : null,
        HardwareRevision: med ? med.HardwareRevision : null,
        SoftwareRevision: med ? med.SoftwareRevision : null,
        FirmwareRevision: null,
    };
}

// LLDP is symmetric; an asymmetric fixture hides every edge-dedup and primary-tree bug.
function linkDevices(a, b, descPrefix) {
    const pa = freeUplinks(a).shift();
    const pb = freeUplinks(b).shift();
    if (!pa || !pb) return false;
    // Both ends of an uplink are the same media, and the uplink cages are optical.
    const wire = attachment(isFibre(pa) || isFibre(pb));
    const stamp = (from, to, localPort, remotePort) => {
        from.Neighbors.push({
            LocalPort: localPort, RemotePort: remotePort, Hostname: to.Hostname,
            MacAddress: to.bridgeMac, ManagementIP: to.DeviceIP,
            Description: `Juniper Networks, Inc. ${to.StackMembers[0].Model.toLowerCase()}`,
            ...lldpCommon({ link: wire }),
        });
        const row = byPort(from).get(localPort);
        // STP is not set here: computeSpanningTree decides it once every link exists.
        if (row) {
            row.Link = 'up'; row.Admin = 'up'; setFlap(row, int(3600, 90 * 86400));
            row.Desc = `${descPrefix} to ${to.Hostname.replace('.local', '')}`;
            // The local view of the same wire, so the two ends' own fields agree with what each
            // advertises: this is what an MTU or autoneg rule compares across the link.
            row._wire = wire;
        }
    };
    stamp(a, b, pa, pb);
    stamp(b, a, pb, pa);
    return true;
}

// The MAC-table half and the ARP half sit on different devices, which is what exercises the backfill.
function addClients(node, gatewayNode, vlanTags) {
    const accessPorts = node.Interfaces.filter(r => r.Link === 'up' && !r.Desc.startsWith('TRUNK') && !r.Desc.startsWith('UPLINK'));
    const dataTags = vlanTags.filter(t => t !== VOICE_TAG);
    for (const row of shuffled(accessPorts).slice(0, Math.min(accessPorts.length, int(2, 14)))) {
        const isPhone = row.Desc.startsWith('PHONE-');
        const isAp = row.Desc.startsWith('AP-');
        const first = addClient(node, gatewayNode, row, isPhone ? VOICE_TAG : pick(vlanTags));
        if (isPhone || isAp) {
            // The endpoint's attachment, drawn once and kept on the port as a switch-to-switch link's
            // is: an endpoint advertises the same wire its switch port sits on.
            const wire = attachment(isFibre(row.Port));
            row._wire = wire;
            node.MedNeighbors.push({
                LocalPort: row.Port, Hostname: row.Desc, MacAddress: first.MAC,
                ManagementIP: first.IP === 'Unknown' ? `10.${node.zone.net}.${int(100, 240)}.${int(2, 250)}` : first.IP,
                Description: isAp ? 'Wireless Access Point' : 'IP Phone',
                Class: isAp ? 'Class III' : 'Class II',
                ...lldpCommon({ med: isAp ? MED_AP : MED_PHONE, link: wire }),
            });
        }
        // Confidence depends on LLDP-MED and a VLAN split; all three verdicts need to occur.
        if (isPhone && dataTags.length && chance(0.7)) addClient(node, gatewayNode, row, pick(dataTags));   // confirmed
        else if (!isPhone && dataTags.length > 1 && chance(0.04)) addClient(node, gatewayNode, row, pick(dataTags)); // likely
        else if (!isPhone && chance(0.03)) addClient(node, gatewayNode, row, first.VLAN_Tag);               // possible
    }

    // Placed after the loop so it lands on a port the loop left alone: an inline network encryptor is
    // one GD-OUI MAC on an otherwise quiet port with no LLDP of any kind, which is exactly the shape
    // the viewer's Crypto/INE flag keys on. Rare on purpose - a flag on every third port says nothing.
    if (chance(0.06)) {
        const free = shuffled(accessPorts).find(r => r.Desc === 'Unknown' && !node.Clients.some(c => c.Port === `${r.Port}.0`));
        if (free) {
            free.Desc = INE_DESC(int(1, 60));
            addClient(node, gatewayNode, free, pick(dataTags.length ? dataTags : vlanTags), ineMac());
        }
    }
}

// Anything but "Unknown"/"Authenticated" counts as a violation, so all three must appear.
const DOT1X_FAILURES = ['Held', 'Connecting', 'Failed', 'Force-Unauthorized'];

function addClient(node, gatewayNode, row, tag, macOverride) {
    const vlan = VLANS.find(v => v.tag === tag);
    const mac = macOverride || clientMac();
    const clientIp = `10.${node.zone.net}.${int(100, 240)}.${int(2, 250)}`;
    const dot1x = chance(0.35);
    const client = {
        // Left unresolved more often than not: the ARP entry usually lives on the L3 gateway.
        IP: chance(0.55) ? 'Unknown' : clientIp,
        MAC: mac,
        Port: `${row.Port}.0`,
        PortDesc: row.Desc,
        VLAN_Name: vlan.name,
        VLAN_Tag: vlan.tag,
        Type: chance(0.85) ? 'Dynamic' : 'Static',
        Dot1x_User: dot1x ? `${pick(['staff', 'lab', 'guest'])}\\user${int(100, 999)}` : 'Unknown',
        Dot1x_State: dot1x ? (chance(0.12) ? pick(DOT1X_FAILURES) : 'Authenticated') : 'Unknown',
    };
    node.Clients.push(client);
    // Keyed by address on a real device, so a second draw landing on an address already in the table
    // would be a duplicate-IP fault the generator never meant to inject.
    if (gatewayNode && !gatewayNode.ArpEntries.some(e => e.IP === clientIp)) {
        // Tte: seconds to expiry, from "show arp no-resolve expiration-time" (section 4.3). Spread
        // across the default 1200 s ARP timer, and derived from the MAC rather than drawn from the
        // shared rng - a new draw here would shift every later random value in the fleet.
        gatewayNode.ArpEntries.push({ MAC: mac, IP: clientIp, Tte: 30 + (detailHash(mac) % 1171) });
    }
    return client;
}

// Back-references, so a building alone is enough to address and place a device.
const ZONES = new Map(CAMPUS.map(z => [z.short, z]));
const ALL_BUILDINGS = [];
for (const zone of CAMPUS) {
    zone.buildings.forEach((b, i) => { b.zone = zone; b.idx = i; b.hostCounter = 10; ALL_BUILDINGS.push(b); });
}
const hubOf = (zone) => zone.buildings.find(b => b.hub);

const topology = [];
const configDevices = [];
const seqIn = new Map();
// Per-building sequence, so uw-hsb-acc01..07 are that building's seven closets.
const nextSeq = (bldg, role) => {
    const key = bldg.abbr + role;
    const n = (seqIn.get(key) || 0) + 1;
    seqIn.set(key, n);
    return n;
};
const place = (bldg, role, models, gateway) => makeDevice({
    deviceIp: ipFor(bldg, bldg.hostCounter++), bldg, seq: nextSeq(bldg, role), models, role, gateway,
});

// Two cores in two buildings on opposite sides of campus, which is the point of having two.
const coreBuildings = [hubOf(ZONES.get('CENTRAL')), hubOf(ZONES.get('WEST'))];
const cores = coreBuildings.map((bldg, i) => place(
    bldg, 'CORE',
    // The second core is the modular chassis, so the undrawable path appears on a device that matters.
    [i === 1 ? MODULAR_MODEL : CORE_MODELS[i % CORE_MODELS.length]],
    ipFor(coreBuildings[0], 1),
));
linkDevices(cores[0], cores[1], 'ICL');

// A frame that runs out of uplink cages leaves the next closet unpatched, so the count follows fleet
// size - well under the ~44 cages on the smallest frame model, leaving trunk/dual-home headroom.
const UPLINKS_PER_FRAME = 20;
const totalClosets = ALL_BUILDINGS.reduce((sum, b) => sum + b.closets, 0);
const zoneShare = (zone) => zone.buildings.reduce((sum, b) => sum + b.closets, 0) / totalClosets;
// Frames displace access switches from the budget, so the split is settled once up front.
const framesFor = (zone) => Math.max(1, Math.ceil((DEVICE_COUNT - cores.length) * zoneShare(zone) / UPLINKS_PER_FRAME));
const frameCount = CAMPUS.reduce((sum, z) => sum + framesFor(z), 0);

const dists = [];
for (const zone of CAMPUS) {
    // Round-robin from the hub outward, because a zone can need more frames than it has buildings.
    const order = [hubOf(zone), ...zone.buildings.filter(b => !b.hub).sort((a, b) => b.closets - a.closets)];
    const want = framesFor(zone);
    const sites = Array.from({ length: want }, (_, i) => order[i % order.length]);
    const inThisZone = [];
    for (const bldg of sites) {
        const models = chance(0.35) ? [pick(DIST_MODELS), pick(DIST_MODELS)] : [pick(DIST_MODELS)];
        const d = place(bldg, 'DIST', models, cores[0].DeviceIP);
        dists.push(d);
        inThisZone.push(d);
        // Two core switches can't terminate every building frame, which is why there is a zone tier.
        if (inThisZone.length === 1) {
            for (const core of cores) linkDevices(d, core, 'TRUNK');
        } else {
            const upstream = nearestWithPort(bldg, inThisZone.slice(0, -1));
            if (!upstream) throw new Error(`No frame left in ${zone.name} to home ${d.Hostname} to - lower UPLINKS_PER_FRAME (currently ${UPLINKS_PER_FRAME}).`);
            linkDevices(d, upstream, 'TRUNK');
        }
    }
}
const distsInZone = (short) => dists.filter(d => d.zone.short === short);

// Access switches in proportion to closet count, so the fleet thickens where the campus does.
const accessBudget = Math.max(1, DEVICE_COUNT - cores.length - frameCount);
const access = [];
const inBuilding = new Map(ALL_BUILDINGS.map(b => [b.abbr, []]));

// Largest-remainder apportionment: independent rounding drifts a dozen devices over 48 buildings.
const quotas = ALL_BUILDINGS.map(b => ({ bldg: b, exact: accessBudget * (b.closets / totalClosets) }));
quotas.forEach(q => { q.n = Math.max(1, Math.floor(q.exact)); });
let shortfall = accessBudget - quotas.reduce((sum, q) => sum + q.n, 0);
for (const q of quotas.slice().sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    if (shortfall <= 0) break;
    q.n++; shortfall--;
}
for (const q of quotas.slice().sort((a, b) => a.exact - b.exact)) {
    if (shortfall >= 0) break;
    if (q.n > 1) { q.n--; shortfall++; }
}

for (const { bldg, n: count } of quotas) {
    for (let i = 0; i < count && access.length < accessBudget; i++) {
        // A multi-member stack is where the faceplate view does its most fragile work.
        const stackSize = chance(0.3) ? int(2, 5) : 1;
        const stackModel = pick(ACCESS_MODELS);
        const models = Array.from({ length: stackSize }, () => (stackSize > 1 && chance(0.15) ? pick(ACCESS_MODELS) : stackModel));
        const parent = nearestWithPort(bldg, distsInZone(bldg.zone.short));
        if (!parent) throw new Error(`Every distribution frame in ${bldg.zone.name} is full - lower UPLINKS_PER_FRAME (currently ${UPLINKS_PER_FRAME}).`);
        const a = place(bldg, 'ACC', models, parent.DeviceIP);
        linkDevices(a, parent, 'UPLINK');
        // Dual-homing goes to a NEIGHBOURING zone; back into the same building is not redundant.
        if (chance(0.08)) {
            const neighbours = bldg.zone.adjacent.flatMap(distsInZone);
            const spare = nearestWithPort(bldg, neighbours);
            if (spare) linkDevices(a, spare, 'UPLINK');
        }
        access.push(a);
        inBuilding.get(bldg.abbr).push(a);
    }
}

// A closet fed from another closet, within one building - where primary-tree depth stops being trivial.
for (const [, switches] of inBuilding) {
    if (switches.length < 3) continue;
    for (const a of shuffled(switches).slice(0, Math.floor(switches.length * 0.2))) {
        const leaf = pick(switches);
        if (leaf !== a && !leaf.Neighbors.some(n => n.ManagementIP === a.DeviceIP)) linkDevices(a, leaf, 'DAISY');
    }
}

// R5. An unmanaged desk switch: it advertises Bridge capability over LLDP but no management address,
// so there is nothing to scan and no node behind it. Reachable = false, and every edge, node-meta and
// diff consumer must skip it on ManagementIP alone - which is what having a few of these here checks.
for (const node of shuffled(access).slice(0, Math.max(2, Math.round(access.length * 0.04)))) {
    const row = node.Interfaces.find(r => r.Link === 'up' && r.Desc === 'Unknown');
    if (!row) continue;
    row.Desc = 'UNMANAGED desk switch';
    node.Neighbors.push({
        LocalPort: `${row.Port}.0`, RemotePort: '1', Hostname: 'Unknown',
        MacAddress: switchMac(), ManagementIP: 'Unknown',
        Description: 'Unmanaged 8-port switch',
        ...lldpCommon({ reachable: false }),
    });
}

for (const node of [...cores, ...dists, ...access]) topology.push(node);

// Item 7. A real spanning tree over the links the generator builds.
//
// The generator creates genuine cycles - the core ICL, every zone's first frame linked to both cores,
// 8% access dual-homing, and daisy chains - and every port was stamped FWD, so the fixture claimed a
// converged spanning tree forwarding on a loop. Nothing path-related can be tested against that.
//
// One RSTP instance, matching the "set protocols rstp" the config text writes. Per-VLAN divergence
// (a port FWD in one VLAN and BLK in another) needs VSTP config generation and is not faked here.
const RSTP_COST = { xe: 2000, et: 2000, ge: 20000, mge: 20000, ae: 20000 };
const portCost = (port) => RSTP_COST[String(port).match(/^[a-z]+/)[0]] ?? 20000;
const bridgeId = (node) => `${node.bridgePriority}.${node.bridgeMac}`;

// RSTP compares (priority, MAC) as one number; comparing the printed string would order 4096 after
// 32768. Returns negative when a sorts before b.
function compareBridges(a, b) {
    return a.bridgePriority - b.bridgePriority || (a.bridgeMac < b.bridgeMac ? -1 : a.bridgeMac > b.bridgeMac ? 1 : 0);
}

function computeSpanningTree(fleet) {
    // Every device is a bridge. A scan failure is a fact about OUR ssh attempt - AuthFailed, Refused and
    // Timeout all describe the connection, not the switch - and a switch we cannot log into is still
    // running RSTP and still sending BPDUs. Excluding one makes its neighbours' ports read Designated
    // and orphans anything behind it as an island root, which is the fixture lying the other way.
    //
    // An R5 neighbour is different and is skipped below: it advertises Bridge capability with no
    // management address, and modelling it as not participating is defensible.
    const bridges = fleet;
    const byIp = new Map(bridges.map(d => [String(d.DeviceIP), d]));

    // Symmetric adjacency from the LLDP the generator already stamped, so the tree is computed over
    // exactly the links the snapshot claims exist.
    const links = new Map();   // deviceIp -> [{ localPort, peer, peerPort }]
    for (const d of bridges) links.set(String(d.DeviceIP), []);
    for (const d of bridges) {
        for (const n of d.Neighbors) {
            if (n.Reachable === false) continue;
            const peer = byIp.get(String(n.ManagementIP));
            if (!peer) continue;
            links.get(String(d.DeviceIP)).push({ localPort: n.LocalPort.replace(/\.\d+$/, ''), peer, peerPort: String(n.RemotePort).replace(/\.\d+$/, '') });
        }
    }

    const root = bridges.reduce((best, d) => (compareBridges(d, best) < 0 ? d : best), bridges[0]);

    // Dijkstra, not BFS by hops: with 1G and 10G uplinks mixed the least-cost tree is not the
    // fewest-hops tree, and the cost charged is that of the RECEIVING port - the downstream end.
    const rootCost = new Map([[String(root.DeviceIP), 0]]);
    const rootPort = new Map();
    const settled = new Set();
    while (settled.size < bridges.length) {
        let cur = null;
        for (const d of bridges) {
            const ip = String(d.DeviceIP);
            if (settled.has(ip) || !rootCost.has(ip)) continue;
            if (cur === null) { cur = d; continue; }
            const better = rootCost.get(ip) - rootCost.get(String(cur.DeviceIP)) || compareBridges(d, cur);
            if (better < 0) cur = d;
        }
        if (cur === null) break;   // a partition: assertNothingOrphaned catches a real one
        const curIp = String(cur.DeviceIP);
        settled.add(curIp);
        for (const l of links.get(curIp)) {
            const peerIp = String(l.peer.DeviceIP);
            if (settled.has(peerIp)) continue;
            const cost = rootCost.get(curIp) + portCost(l.peerPort);
            const known = rootCost.has(peerIp) ? rootCost.get(peerIp) : Infinity;
            // Tie-break on the sender's bridge ID, as RSTP does, so the tree is deterministic.
            const incumbent = rootPort.get(peerIp);
            if (cost < known || (cost === known && incumbent && compareBridges(cur, incumbent.sender) < 0)) {
                rootCost.set(peerIp, cost);
                rootPort.set(peerIp, { port: l.peerPort, sender: cur });
            }
        }
    }

    // Port IDs are Junos's "128:N" over the device's own sorted port list.
    const portIdOf = new Map();
    for (const d of bridges) {
        const ids = new Map();
        d.Interfaces.forEach((r, i) => ids.set(r.Port, `128:${i + 1}`));
        portIdOf.set(String(d.DeviceIP), ids);
    }

    const assigned = new Set();
    const assign = (device, port, role, state, designatedBridge, designatedPortId) => {
        const row = byPort(device)?.get(port);
        if (!row) return;
        assigned.add(`${device.DeviceIP}|${port}`);
        row.STP = state;
        row.StpDetail = {
            'instance 0': {
                State: state,
                Role: role,
                Cost: portCost(port),
                PortId: portIdOf.get(String(device.DeviceIP)).get(port) || null,
                DesignatedPortId: designatedPortId,
                DesignatedBridge: designatedBridge,
            },
        };
    };

    const claimed = new Set();
    for (const d of bridges) {
        const ip = String(d.DeviceIP);
        const mine = rootPort.get(ip);
        for (const l of links.get(ip)) {
            const key = [ip + '|' + l.localPort, String(l.peer.DeviceIP) + '|' + l.peerPort].sort().join('~');
            if (claimed.has(key)) continue;
            claimed.add(key);

            const theirs = rootPort.get(String(l.peer.DeviceIP));
            const iAmDownstream = mine && mine.port === l.localPort && String(mine.sender.DeviceIP) === String(l.peer.DeviceIP);
            const theyAreDownstream = theirs && theirs.port === l.peerPort && String(theirs.sender.DeviceIP) === ip;

            const myPortId = portIdOf.get(ip).get(l.localPort) || null;
            const theirPortId = portIdOf.get(String(l.peer.DeviceIP)).get(l.peerPort) || null;

            if (iAmDownstream) {
                assign(d, l.localPort, 'ROOT', 'FWD', bridgeId(l.peer), theirPortId);
                assign(l.peer, l.peerPort, 'DESG', 'FWD', bridgeId(l.peer), theirPortId);
            } else if (theyAreDownstream) {
                assign(l.peer, l.peerPort, 'ROOT', 'FWD', bridgeId(d), myPortId);
                assign(d, l.localPort, 'DESG', 'FWD', bridgeId(d), myPortId);
            } else {
                // Neither end is on its own least-cost path: this link is the redundant one that has to
                // block, and the better bridge keeps the designated end.
                const myCost = rootCost.has(ip) ? rootCost.get(ip) : Infinity;
                const theirCost = rootCost.has(String(l.peer.DeviceIP)) ? rootCost.get(String(l.peer.DeviceIP)) : Infinity;
                const iWin = (myCost - theirCost || compareBridges(d, l.peer)) < 0;
                const winner = iWin ? d : l.peer;
                const winnerPortId = iWin ? myPortId : theirPortId;
                assign(winner, iWin ? l.localPort : l.peerPort, 'DESG', 'FWD', bridgeId(winner), winnerPortId);
                assign(iWin ? l.peer : d, iWin ? l.peerPort : l.localPort, 'ALT', 'BLK', bridgeId(winner), winnerPortId);
            }
        }
    }

    // Every remaining port faces an endpoint, an unreachable device, or nothing at all. A down port
    // prints State BLK with Role DIS - the disabled ROLE, not a DIS state: the switch is blocking a port
    // it has no link on, and the state column never carries DIS on hardware.
    for (const d of bridges) {
        for (const row of d.Interfaces) {
            // What this pass assigned, not what the row already carries: a row keeps the previous
            // snapshot's detail, and ageFleet takes ports up and down between snapshots. Skipping on
            // "has any detail" left a port that went down still reporting the FWD DESG it held while
            // it was up - a state no switch prints.
            if (assigned.has(`${d.DeviceIP}|${row.Port}`)) continue;
            const up = String(row.Link).toLowerCase() === 'up';
            assign(d, row.Port, up ? 'DESG' : 'DIS', up ? 'FWD' : 'BLK', bridgeId(d),
                portIdOf.get(String(d.DeviceIP)).get(row.Port) || null);
        }
    }
    // Section 4.3's one added command, per device: the same single RSTP instance the per-port view
    // reports, under the same scope string, so the two can be joined. The root's own row has no root
    // port and zero cost - that is what being the root means, and it is the fact the engine currently
    // has to infer from the absence of a ROOT-role port.
    for (const d of bridges) {
        const ip = String(d.DeviceIP);
        const isRoot = ip === String(root.DeviceIP);
        d.StpBridge = [{
            Scope: 'instance 0',
            EnabledProtocol: 'RSTP',
            RootId: bridgeId(root),
            RootCost: isRoot ? 0 : (rootCost.has(ip) ? rootCost.get(ip) : null),
            RootPort: isRoot ? null : (rootPort.has(ip) ? rootPort.get(ip).port : null),
            BridgeId: bridgeId(d),
            // Derived from the device's own identity rather than drawn from the shared rng: a new draw
            // here would shift every later random value and change an otherwise unrelated fixture.
            TopologyChangeCount: detailHash(ip) % 15,
            // G4's field. A converged fleet's last change is old; a churn injector is what would make one
            // recent, so nothing here is closer than an hour.
            TimeSinceLastChangeSeconds: 3600 + (detailHash(ip + '|tc') % 896400),
        }];
    }
    return { rootLabel: `${root.Hostname} (${bridgeId(root)})`, rootCost: rootCost, rootPort: rootPort };
}

// An unlinked switch is just an orphan node beside the diagram, easy to miss - so it is fatal here.
function assertNothingOrphaned(fleet) {
    const orphans = fleet.filter(d => d.Neighbors.length === 0);
    if (!orphans.length) return;
    throw new Error(
        `${orphans.length} device(s) could not be patched to anything (e.g. ${orphans.slice(0, 3).map(d => d.Hostname).join(', ')}).\n` +
        `  ${access.length} access switches over ${dists.length} frames is ${(access.length / dists.length).toFixed(1)} uplinks each; ` +
        `lower UPLINKS_PER_FRAME (currently ${UPLINKS_PER_FRAME}).`
    );
}
// The invariant item 7 exists for, asserted where every generated fixture passes through it rather than
// only in the one the test suite builds: the forwarding subgraph must be a spanning tree.
function assertForwardingIsSpanningTree(fleet) {
    const byIp = new Map(fleet.map(d => [String(d.DeviceIP), d]));
    const stpOf = (d, port) => {
        const row = byPort(d).get(String(port).replace(/\.\d+$/, ''));
        return row ? row.STP : null;
    };
    const fwd = new Set();
    for (const d of fleet) {
        for (const n of d.Neighbors) {
            if (n.Reachable === false) continue;
            const peer = byIp.get(String(n.ManagementIP));
            if (!peer) continue;
            if (stpOf(d, n.LocalPort) === 'FWD' && stpOf(peer, n.RemotePort) === 'FWD') {
                fwd.add([String(d.DeviceIP), String(peer.DeviceIP)].sort().join('~'));
            }
        }
    }
    const adj = new Map(fleet.map(d => [String(d.DeviceIP), []]));
    for (const key of fwd) {
        const [a, b] = key.split('~');
        adj.get(a).push(b);
        adj.get(b).push(a);
    }
    const seen = new Set([String(fleet[0].DeviceIP)]);
    const queue = [String(fleet[0].DeviceIP)];
    for (let head = 0; head < queue.length; head++) {
        for (const next of adj.get(queue[head])) {
            if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
    }
    if (seen.size !== fleet.length || fwd.size !== fleet.length - 1) {
        throw new Error(
            `the forwarding subgraph is not a spanning tree: ${fwd.size} forwarding links and ` +
            `${seen.size} of ${fleet.length} devices reachable, where a tree has ${fleet.length - 1} links ` +
            `and reaches all of them.`
        );
    }
}

// VLAN membership, section 8.2 and the data section 6.2's first filter reads. Two rules, both derived
// rather than invented: a trunk carries exactly the tags of the switches behind it, and an access port
// exactly the tags of the clients standing on it. Anything looser makes F11 - a VLAN missing from one
// end of a trunk - the fixture's normal state, and a rule tested against that learns nothing.
const ALL_VLAN_TAGS = VLANS.map(v => v.tag);

// The voice VLAN is on every closet whether the draw picked it or not: addClients puts phones in it
// unconditionally, and a phone in a VLAN its own switch does not configure is not a state to test on.
const accessTags = (drawn) => (drawn.includes(VOICE_TAG) ? drawn : [...drawn, VOICE_TAG]);

// One entry per switch-to-switch link, deduplicated on the port pair so a symmetric LLDP pair is one
// link and a LAG's members stay separate (each member is its own row and carries its own membership).
function switchLinksOf(fleet) {
    const byIp = new Map(fleet.map(d => [String(d.DeviceIP), d]));
    const links = [];
    const seen = new Set();
    for (const d of fleet) {
        for (const n of d.Neighbors) {
            const peer = byIp.get(String(n.ManagementIP));
            if (!peer || peer === d) continue;
            const aPort = String(n.LocalPort).replace(/\.\d+$/, '');
            const bPort = String(n.RemotePort).replace(/\.\d+$/, '');
            const key = [`${d.DeviceIP}|${aPort}`, `${peer.DeviceIP}|${bPort}`].sort().join('~');
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({ a: d, aPort: aPort, b: peer, bPort: bPort });
        }
    }
    return links;
}

// Sets node.vlanTags (what the device configures) and node._trunkVlans (port -> tags it trunks). No
// rnd(): the tag sets are already drawn, and this only propagates them.
function assignVlanTags(fleet) {
    const links = switchLinksOf(fleet);
    const adj = new Map(fleet.map(d => [d, []]));
    for (const l of links) { adj.get(l.a).push(l); adj.get(l.b).push(l); }

    // Frames and cores carry the whole campus set - that is what makes them frames.
    const tags = new Map(fleet.map(d => [d, new Set(d.role === 'ACC' ? d._ownTags : ALL_VLAN_TAGS)]));

    // The access tree hangs off the frames, so a closet's uplink is the link that first reached it.
    const parentLink = new Map();
    const order = [];
    const queue = fleet.filter(d => d.role !== 'ACC');
    const seen = new Set(queue);
    for (let head = 0; head < queue.length; head++) {
        for (const l of adj.get(queue[head])) {
            const far = l.a === queue[head] ? l.b : l.a;
            if (seen.has(far)) continue;
            seen.add(far);
            parentLink.set(far, l);
            order.push(far);
            queue.push(far);
        }
    }
    // A redundant leg (a dual-home, the second link of a daisy loop) has to carry what its partner does,
    // or moving the tree onto it would strand a VLAN. Both ends learn the union - before the upward
    // propagation below, so a closet that grew this way is still covered by the trunk above it.
    for (const l of links) {
        if (parentLink.get(l.a) === l || parentLink.get(l.b) === l) continue;
        const union = new Set([...tags.get(l.a), ...tags.get(l.b)]);
        for (const end of [l.a, l.b]) for (const tag of union) tags.get(end).add(tag);
    }

    // Deepest closet first, so a chain's tags reach every trunk above it.
    for (const node of order.slice().reverse()) {
        const l = parentLink.get(node);
        const up = l.a === node ? l.b : l.a;
        for (const tag of tags.get(node)) tags.get(up).add(tag);
    }
    for (const d of fleet) d.vlanTags = [...tags.get(d)].sort((x, y) => x - y);
}

// Rebuilt per snapshot, after computeSpanningTree: the "*" that marks a member as currently forwarding
// for a VLAN moves when the tree does. Mirrors Vlans[] onto the port rows exactly as the worker's second
// pass over ConvertFrom-JunosVlanTable output does (Get-JunosNodeData.ps1).
function applyVlanMembership(fleet) {
    // A trunk carries the VLANs both ends configure. Taken as the intersection rather than assigned from
    // one side, so the two ends of a link can never disagree unless something deliberately removes a tag
    // - which is exactly what the F11 injector does.
    const trunkTags = new Map();   // device -> Map(port -> tags[])
    for (const d of fleet) trunkTags.set(d, new Map());
    for (const l of switchLinksOf(fleet)) {
        const carried = l.a.vlanTags.filter(t => l.b.vlanTags.includes(t));
        trunkTags.get(l.a).set(l.aPort, carried);
        trunkTags.get(l.b).set(l.bPort, carried);
    }
    for (const node of fleet) {
        const rows = byPort(node);
        const trunks = trunkTags.get(node);
        for (const row of node.Interfaces) row.Vlans = [];
        const members = new Map(node.vlanTags.map(t => [t, []]));
        // Section 4.3. "show vlans extensive" annotates each member with tagged/untagged and the port
        // mode, and the ONE thing that combination states is the native VLAN: an untagged member of a
        // tagged VLAN on a trunk. Every trunk here carries the device's lowest VLAN untagged, so the
        // field is exercised rather than constant - and so G5's native-VLAN comparison has both ends to
        // compare once a rule for it exists.
        const claim = (tag, row, active, mode, untaggedTag) => {
            if (!members.has(tag)) return;
            if (members.get(tag).some(m => m.Port === row.Port)) return;
            members.get(tag).push({
                Port: row.Port, Unit: `${row.Port}.0`, Active: active,
                Tagged: mode === 'trunk' ? tag !== untaggedTag : false,
                Mode: mode,
            });
        };
        for (const [port, carried] of trunks) {
            const row = rows.get(port);
            if (!row || String(row.Link).toLowerCase() !== 'up') continue;   // a dark trunk has no members
            // Every trunk has exactly one native VLAN - the lowest tag it carries, so the two ends of a
            // link agree on it by construction and a DISagreement can only be injected deliberately
            // (G5's other half). A trunk carries the intersection of both ends' VLANs, so a per-device
            // native could fall outside what a given trunk carries and leave the port with none.
            const native = carried.length ? Math.min(...carried) : null;
            for (const tag of carried) claim(tag, row, row.STP === 'FWD', 'trunk', native);
        }
        for (const client of node.Clients) {
            const port = String(client.Port).replace(/\.\d+$/, '');
            if (trunks.has(port)) continue;
            const row = rows.get(port);
            if (row) claim(client.VLAN_Tag, row, String(row.Link).toLowerCase() === 'up', 'access', null);
        }
        // A configured VLAN with no member port still prints in "show vlans", which is why the list comes
        // from vlanTags and not from the membership.
        node.Vlans = node.vlanTags.map(tag => ({
            RoutingInstance: 'default-switch',
            Name: VLANS.find(v => v.tag === tag).name,
            Tag: tag,
            Interfaces: members.get(tag).slice().sort((a, b) => a.Port.localeCompare(b.Port)),
        }));
        for (const vlan of node.Vlans) {
            for (const m of vlan.Interfaces) {
                rows.get(m.Port).Vlans.push({
                    Name: vlan.Name, Tag: vlan.Tag, Unit: m.Unit, Active: m.Active,
                    Tagged: m.Tagged, Mode: m.Mode,
                });
            }
        }
    }
}

// Section 8.1 / work order item 4, finally filled: the extensive-derived fields the L1 rules read. The
// values and the vocabularies are the ones a real EX prints - "Half-duplex" on every DOWN port,
// "Present Running Down" device flags, "LINK" alarms, "Never" for a counter baseline - because the two
// traps section 3.4 names are only testable if the fixture reproduces the states that spring them.
//
// Derived, never drawn: a deterministic hash of (device, port, snapshot) stands in for a PRNG, so this
// pass cannot move the main stream and the counters are stable for one port across a run.
function detailHash(seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
}
const ERROR_LABELS_IN = ['Errors', 'Drops', 'Framing errors', 'Runts', 'Policed discards',
    'L3 incompletes', 'L2 channel errors', 'L2 mismatch timeouts', 'FIFO errors', 'Resource errors'];
const ERROR_LABELS_OUT = ['Carrier transitions', 'Errors', 'Drops', 'Collisions', 'Aged packets',
    'FIFO errors', 'HS link CRC errors', 'MTU errors', 'Resource errors'];
// R4's table, with the column headers the parser keys on.
const MAC_STAT_LABELS = ['Total octets', 'Total packets', 'Unicast packets', 'Broadcast packets',
    'Multicast packets', 'CRC/Align errors', 'FIFO errors', 'MAC control frames', 'MAC pause frames',
    'Oversized frames', 'Jabber frames', 'Fragment frames', 'VLAN tagged frames', 'Code violations'];

// The FPC a port lives on, which is the scope a counter epoch belongs to: a linecard reboots its own
// ports and nothing else's. An aggregate spans members and has no single one, so it reports the
// chassis master's.
function fpcOfPort(port) {
    const m = /^[a-z]+-(\d+)\//.exec(String(port));
    return m ? m[1] : null;
}

// port-last-used-spec.md section 2.3. Every live port's traffic profile, stable across snapshots so
// the counters derived from it are cumulative rather than re-rolled. The bimodal mean frame size is
// the measured shape: a minority of ports carry ~72 B frames at a fraction of a packet per second -
// EAPOL/ARP/keepalive chatter from a present but unattended NIC - and the rest carry ~300-1400 B.
// Those chatterers are exactly the ports a reclaim view exists to surface, and under a naive
// byte-delta rule they read as the busiest thing on the switch.
function trafficProfile(deviceIp, port) {
    const r = detailHash(`${deviceIp}|${port}|rate`);
    if ((r % 17) === 0) return { pps: 0.07 + (r % 18) / 100, frame: 72 + (r % 5) };
    return { pps: 1 + (r % 4000) / 10, frame: 300 + (r % 1100) };
}

function applyPortDetail(fleet, snapshotIndex, scanTime) {
    for (const node of fleet) {
        const medPorts = new Set(node.MedNeighbors.map(m => String(m.LocalPort).replace(/\.\d+$/, '')));
        const clientsByPort = new Map();
        for (const client of node.Clients) {
            const port = String(client.Port).replace(/\.\d+$/, '');
            if (!clientsByPort.has(port)) clientsByPort.set(port, []);
            clientsByPort.get(port).push(client);
        }
        for (const row of node.Interfaces) {
            const h = detailHash(`${node.DeviceIP}|${row.Port}|${snapshotIndex}`);
            const live = String(row.Link).toLowerCase() === 'up';
            const wire = row._wire || null;
            // The wire knows its own media; a port with no wire falls back to what its cage implies.
            const fibre = wire ? wire.fibre : isFibre(row.Port);

            row.LinkLevelType = 'Ethernet';
            row.MediaType = fibre ? 'Fiber' : 'Copper';
            row.Mtu = wire ? wire.mtu : 1514;
            // A fibre port's link-level line carries no Link-mode, no Auto-negotiation and no Remote
            // fault, and no autonegotiation stanza follows it: on optics these four fields are absent,
            // not zero. Every one of the capture's fibre ports is shaped this way, and a fixture that
            // fills them lets a rule pass here that reports NOT_EVALUATED on real hardware.
            row.AutoNegotiation = fibre ? null : wire && wire.autoneg === 'disabled' ? 'Disabled' : 'Enabled';
            // Section 3.4's second trap, reproduced rather than described: every DOWN copper port prints
            // Half-duplex, so a duplex rule that does not hard-gate on Link fires across the estate.
            row.Duplex = fibre ? null : live ? 'Full-duplex' : 'Half-duplex';
            row.DuplexNegotiated = !fibre && live ? 'Full-duplex' : null;
            // Incomplete is what all 25 of the capture's down ports print; it is the link being down,
            // not a negotiation that failed on a live wire.
            row.NegotiationStatus = fibre ? null : live ? 'Complete' : 'Incomplete';
            // The `Speed:` field the parser reads: "Auto" on copper, the rate itself on optics.
            row.SpeedConfigured = fibre ? '10Gbps' : 'Auto';
            row.SpeedNegotiated = !fibre && live ? (isFibre(row.Port) ? '10 Gbps' : '1000 Mbps') : null;
            row.MacAddress = ['02', 'ab', ((h >>> 24) & 0xff), ((h >>> 16) & 0xff), ((h >>> 8) & 0xff), (h & 0xff)]
                .map(x => (typeof x === 'string' ? x : x.toString(16).padStart(2, '0'))).join(':');
            row.InterfaceFlags = live ? 'SNMP-Traps Internal: 0x4000' : 'Hardware-Down SNMP-Traps Internal: 0x4000';
            row.DeviceFlags = live ? 'Present Running' : 'Present Running Down';
            // The third trap: LINK is a real alarm on a port reporting up, and noise on a down one.
            row.ActiveAlarms = live ? 'None' : 'LINK';
            row.ActiveDefects = live ? 'None' : 'LINK';
            row.StatisticsLastCleared = 'Never';
            row.RemoteFault = fibre ? null : 'Online';
            row.BpduError = 'None';
            row.LoopDetectPduError = 'None';
            row.EthernetSwitchingError = 'None';
            row.MacRewriteError = 'None';
            // Section 4.2: the counter increments on EVERY carrier state change, so its parity tracks
            // the current link state - 48 of 48 up ports odd, 25 of 25 down ports even, no violations.
            // "1 + (h % 7)" made half the live ports even, which is a state no switch reports.
            row.CarrierTransitions = live ? 1 + 2 * (h % 4) : 0;

            // Counters are cumulative since the epoch - here, since the port's own FPC booted - at a
            // rate that does not change between snapshots. They used to be re-rolled per snapshot from
            // a hash that included the snapshot index, so InputBytes moved at random and as often fell
            // as rose: a decrease is a counter reset, so the fixture asserted a fleet resetting its
            // counters on every crawl, and no delta computed across it meant anything.
            const profile = trafficProfile(node.DeviceIP, row.Port);
            const bootedMs = (node._fpcBooted || {})[fpcOfPort(row.Port)];
            const epochSeconds = isFinite(bootedMs) && scanTime
                ? Math.max(0, (scanTime.getTime() - bootedMs) / 1000) : 0;
            const packets = live ? Math.round(profile.pps * epochSeconds) : 0;
            row.InputPackets = packets;
            row.InputBytes = packets * profile.frame;
            // Output exceeds input on most up ports - the switch floods broadcast and multicast out
            // every port in the VLAN whether or not anything is listening (measured median 1.62x), so
            // output climbs on a port whose device is powered off but linked. It corroborates; it is
            // never evidence that the far end did anything.
            const outRatio = live ? 1.1 + (h % 160) / 100 : 0;
            row.OutputPackets = Math.round(packets * outRatio);
            row.OutputBytes = row.OutputPackets * profile.frame;
            row.InputBps = live ? Math.round(profile.pps * profile.frame * 8) : 0;
            row.OutputBps = live ? Math.round(profile.pps * outRatio * profile.frame * 8) : 0;

            row.InputErrors = {};
            row.OutputErrors = {};
            for (const label of ERROR_LABELS_IN) row.InputErrors[label] = 0;
            for (const label of ERROR_LABELS_OUT) row.OutputErrors[label] = 0;
            row.OutputErrors['Carrier transitions'] = row.CarrierTransitions;
            // Section 3.4's first trap: Drops is the output queue's RED mechanism, not an error. The
            // healthiest port in the measured capture carries 14,635 of them against zero errors, so a
            // rule reading Drops as an error flags every busy uplink - and here it would have to.
            if (live && (h % 3) === 0) row.OutputErrors.Drops = 500 + (h % 30000);

            row.MacStatistics = {};
            for (const label of MAC_STAT_LABELS) {
                const stat = { Receive: 0, Transmit: 0 };
                if (label === 'Total packets') { stat.Receive = packets; stat.Transmit = row.OutputPackets; }
                if (label === 'Total octets') { stat.Receive = row.InputBytes; stat.Transmit = row.OutputBytes; }
                if (label === 'Unicast packets') { stat.Receive = Math.floor(packets * 0.95); stat.Transmit = Math.floor(row.OutputPackets * 0.95); }
                // Receive-only rows, as the parser has them: the absent column stays absent.
                if (label === 'Oversized frames' || label === 'Jabber frames') delete stat.Transmit;
                row.MacStatistics[label] = stat;
            }
            // Only the optical ports report these tables at all.
            row.PcsStatistics = fibre ? { 'Bit errors': { Seconds: 0 }, 'Errored blocks': { Seconds: 0 } } : {};
            row.FecStatistics = fibre ? { 'FEC Corrected Errors': { Errors: 0 }, 'FEC Uncorrected Errors': { Errors: 0 } } : {};

            // R7. The PoE row behind the display string, which has to agree with it.
            if (row.PoE === 'Unknown') {
                row.PoeAdminStatus = null; row.PoeOperStatus = null; row.PoePairMode = null;
                row.PoeMaxPower = null; row.PoePriority = null; row.PoePowerConsumption = null; row.PoeClass = null;
            } else {
                // Every value here is a column of the capture's own `show poe interface` table: ON/OFF,
                // 2P/AT, the max power tracking the negotiated class, a bare class digit, and
                // not-applicable where nothing is drawing power.
                const on = row.PoE.startsWith('ON');
                row.PoeAdminStatus = 'Enabled';
                row.PoeOperStatus = on ? 'ON' : 'OFF';
                row.PoePairMode = '2P/AT';
                row.PoeMaxPower = on ? '4.0W' : '15.4W';
                row.PoePriority = medPorts.has(row.Port) ? 'High' : 'Low';
                row.PoePowerConsumption = on ? row.PoE.replace(/^\D+\(|\)$/g, '') : '0.0W';
                row.PoeClass = on ? String(1 + (h % 4)) : 'not-applicable';
            }

            // R6. One row per authenticated client, and an Initialize row for a configured port with
            // nothing on it - the state the MAC-keyed parse structurally could not represent. Derived
            // from Clients so the two cannot disagree about who is authenticated where.
            row.Dot1x = [];
            // Configured on a minority of access ports, as it is in practice - and never on a port
            // with no dot1x at all, which is what makes "$null" mean "not measured here".
            const guestVlanName = (h % 7) === 0 ? 'GUEST' : null;
            const onPort = clientsByPort.get(row.Port) || [];
            const supplicants = onPort.filter(c => c.Dot1x_State !== 'Unknown');
            for (const [i, client] of supplicants.entries()) {
                row.Dot1x.push({
                    Interface: `${row.Port}.0`, Role: i === 0 ? 'Authenticator' : null,
                    State: client.Dot1x_State, MacAddress: client.MAC,
                    User: client.Dot1x_User === 'Unknown' ? null : client.Dot1x_User,
                    // Section 4.3's dot1x upgrade. An authenticated supplicant is put in the VLAN its
                    // port carries; a guest VLAN is configured on some ports and not others, and a
                    // supplicant that is not authenticated has no VLAN at all.
                    AuthenticatedVlan: client.Dot1x_State === 'Authenticated' ? (client.VLAN_Name || null) : null,
                    GuestVlan: guestVlanName,
                });
            }
            if (!supplicants.length && !onPort.length && live && !medPorts.has(row.Port) && (h % 5) === 0) {
                row.Dot1x.push({
                    Interface: `${row.Port}.0`, Role: 'Authenticator', State: 'Initialize',
                    MacAddress: null, User: null, AuthenticatedVlan: null, GuestVlan: guestVlanName,
                });
            }
        }
    }
}

assertNothingOrphaned(topology);

const gatewayFor = (node) => (node.role === 'ACC' ? topology.find(d => d.DeviceIP === node._uplinkIp) : cores[0]);

for (const node of topology) {
    node._ownTags = accessTags(shuffled(VLANS.map(v => v.tag)).slice(0, int(2, 5)));
    if (node.role === 'ACC') addClients(node, gatewayFor(node), node._ownTags);
    const extra = [];
    if (node.role !== 'ACC') extra.push(`set protocols rstp bridge-priority ${node.role === 'CORE' ? '4k' : '8k'}`);
    if (chance(0.3)) extra.push('set system services netconf ssh');
    if (chance(0.2)) extra.push(`set interfaces ${node.Interfaces[0].Port} description "${node.bldg.abbr} patch"`);
    node._extraConfig = extra;
}
// Written after the propagation below, not in the loop above: an access switch that trunks a downstream
// closet's VLANs configures them too, and a config text listing only its own would contradict the
// membership the same run emits.
assignVlanTags(topology);
for (const node of topology) {
    node.Configuration = configText(node.Hostname, node.zone, node.bldg, node.vlanTags, node._extraConfig);
}

const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
// Metres east/north of a building's interior point, back to a coordinate.
const offsetBy = (bldg, east, north) => ({
    lat: +(bldg.lat + north / M_PER_DEG_LAT).toFixed(6),
    lng: +(bldg.lng + east / mPerDegLng(bldg.lat)).toFixed(6),
});

// Concentric rings at `step` metres, or null when `count` won't fit inside `limit`.
function ringSpots(limit, step, count) {
    const spots = [{ east: 0, north: 0 }];
    for (let ring = 1; spots.length < count; ring++) {
        const radius = ring * step;
        if (radius > limit) return null;
        const capacity = Math.max(1, Math.floor(Math.PI / Math.asin(Math.min(1, step / (2 * radius)))));
        for (let i = 0; i < capacity && spots.length < count; i++) {
            // Half-step rotation on alternate rings, so pins do not line up into spokes.
            const angle = (2 * Math.PI * i) / capacity + (ring % 2) * Math.PI / capacity;
            spots.push({ east: radius * Math.cos(angle), north: radius * Math.sin(angle) });
        }
    }
    return spots;
}

// Closets ring inside the building's footprint: jitter wide enough to separate them threw pins onto
// the lawn and could still drop two on one spot. Deterministic, centred on the interior point.
function closetSpots(bldg, count) {
    // The widest spacing that still fits every closet indoors.
    let step = Math.max(4, bldg.r / 2);
    for (let attempt = 0; attempt < 60; attempt++) {
        const spots = ringSpots(bldg.r, step, count);
        if (spots) return { spots, step };
        step *= 0.85;
    }
    // Unreachable for any plausible fleet, but a null here would be a crash rather than a crowded building.
    return { spots: ringSpots(bldg.r, bldg.r / 1e4, count) || [{ east: 0, north: 0 }], step: bldg.r / 1e4 };
}

// The frame takes the building's interior point and the closets ring around it.
const placementRank = (node) => (node.role === 'ACC' ? 1 : 0);
const pinnedByBuilding = new Map();
for (const node of topology) {
    if (!pinnedByBuilding.has(node.bldg)) pinnedByBuilding.set(node.bldg, []);
    pinnedByBuilding.get(node.bldg).push(node);
}

// Serial-keyed so a re-homed device keeps its pin, which is how the real Configuration.json is keyed.
for (const [bldg, nodes] of pinnedByBuilding) {
    const ordered = nodes.slice().sort((a, b) => placementRank(a) - placementRank(b)
        || String(a.DeviceIP).localeCompare(String(b.DeviceIP)));
    const { spots, step } = closetSpots(bldg, ordered.length);
    // Stack members share a closet, ringed apart by a fixed fraction of the closet spacing.
    const rackRadius = Math.min(1.2, step / 3);
    ordered.forEach((node, slot) => {
        const spot = spots[slot];
        const floor = 1 + (slot % 5);
        node.StackMembers.forEach((m, memberIndex) => {
            if (!m.Serial) return;
            const angle = (2 * Math.PI * memberIndex) / Math.max(1, node.StackMembers.length);
            const at = offsetBy(bldg, spot.east + rackRadius * Math.cos(angle), spot.north + rackRadius * Math.sin(angle));
            configDevices.push({
                key: m.Serial, keyType: 'serial',
                lat: at.lat, lng: at.lng,
                building: `${bldg.name} (${bldg.abbr})`,
                room: `${bldg.abbr} ${floor}${String(10 + slot).padStart(2, '0')}${node.role === 'ACC' ? '' : 'A'}`,
                notes: `${node.zone.name} - synthetic fixture device (seed ${SEED})`,
            });
        });
    });
}

// What a fleet does between crawls; every snapshot-diff tab compares exactly this.
function ageFleet(days) {
    for (const node of topology) {
        node.MasterCpuUtilization = cpuValue();
        node.MasterMemoryUtilization = memValue();
    }
    // Reboots are detected from boot timestamps, so a fleet whose Uptime never moves reports none.
    for (const node of shuffled(topology).slice(0, int(2, 5))) {
        node.Uptime = iso(daysAgo(rnd() * days));
        // P1's rows come from the same event, so they move with it: a device whose Uptime says it
        // rebooted while its members' uptimes still span years is a state no chassis can be in.
        const bootedMs = Date.parse(node.Uptime);
        node._fpcBooted = Object.fromEntries(node.StackMembers.map((m, i) => [String(m.FPC), bootedMs + i * 4000]));
    }
    // One linecard reboots on its own - section 4.3's first failure, and the case a device-level
    // uptime cannot see: the master's stamp does not move, so nothing at device level says anything
    // happened, while every counter on that member's ports has restarted from zero.
    const stacked = topology.filter(d => d.StackMembers.length > 1 && d._fpcBooted);
    if (stacked.length > 0) {
        const node = pick(stacked);
        const member = node.StackMembers.filter(m => !m.IsMaster)[0];
        if (member) node._fpcBooted[String(member.FPC)] = daysAgo(rnd() * days).getTime();
    }
    for (const node of shuffled(topology).slice(0, Math.max(2, Math.round(topology.length * 0.04)))) {
        node.Configuration += `\nset system syslog file interactive-commands interactive-commands any\nset snmp trap-group audit targets 10.${node.zone.net}.0.4${days}`;
        node.LastConfigured = iso(daysAgo(rnd() * days));
        node.LastConfiguredBy = pick(CONFIG_USERS);
    }
    for (const node of shuffled(topology).slice(0, Math.round(topology.length * 0.1))) {
        for (const row of shuffled(node.Interfaces).slice(0, int(1, 4))) {
            if (node.Neighbors.some(n => n.LocalPort === row.Port)) continue;   // a trunk that moves would desync LLDP
            row.Link = row.Link === 'up' ? 'down' : 'up';
            setFlap(row, int(60, days * 86400));
        }
    }
    // A retirement and a commissioning, so New Devices has a departure as well as an arrival.
    const retired = pick(topology.filter(d => d.role === 'ACC'));
    topology.splice(topology.indexOf(retired), 1);
    for (const node of topology) node.Neighbors = node.Neighbors.filter(n => n.ManagementIP !== retired.DeviceIP);
    // Only a building whose zone has a spare port - the arrival must end up patched to something.
    const bldg = pick(ALL_BUILDINGS.filter(b => nearestWithPort(b, distsInZone(b.zone.short))));
    const parent = nearestWithPort(bldg, distsInZone(bldg.zone.short));
    const arrival = place(bldg, 'ACC', [pick(ACCESS_MODELS)], parent.DeviceIP);
    arrival._ownTags = accessTags(shuffled(VLANS.map(v => v.tag)).slice(0, 3));
    addClients(arrival, parent, arrival._ownTags);
    linkDevices(arrival, parent, 'UPLINK');
    topology.push(arrival);
    // Patched in rather than re-propagated over the whole fleet: the arrival is a leaf on a frame that
    // already carries every campus VLAN, and rewriting every device's tags here would leave the config
    // text this pass has already appended to describing a different set.
    arrival.vlanTags = arrival._ownTags.slice();
    arrival.Configuration = configText(arrival.Hostname, bldg.zone, bldg, arrival.vlanTags, []);
}

// A placeholder has no serial, so identity falls back to hostname. Re-rolling the failing set each
// snapshot would show most of the fleet as removed-and-re-added, so one device flips per crawl.
const chronicallyFailing = shuffled(topology.filter(d => d.role === 'ACC'))
    .slice(0, Math.max(1, Math.round(topology.length * 0.025))).map(d => d.DeviceIP);

function withFailures(fleet, snapshotIndex, scanTime) {
    const failing = new Set(chronicallyFailing);
    if (snapshotIndex > 0) {
        failing.delete(chronicallyFailing[snapshotIndex % chronicallyFailing.length]);   // recovered
        const stillUp = fleet.filter(d => d.role === 'ACC' && !failing.has(d.DeviceIP));
        failing.add(stillUp[(snapshotIndex * 97) % stillUp.length].DeviceIP);            // newly down
    }
    // Dropped before the clone: bldg.zone.buildings points back at bldg, so a clone would recurse.
    const SCRATCH = ['zone', 'bldg', 'role', 'bridgeMac', 'bridgePriority', '_freeUplinks', '_byPort',
        '_ownTags', '_extraConfig', 'vlanTags', '_wire', '_uplinkIp', '_fpcBooted'];
    return fleet.map(node => {
        const copy = JSON.parse(JSON.stringify(node, (key, value) => (SCRATCH.includes(key) ? undefined : value)));
        if (failing.has(node.DeviceIP)) {
            const status = pick(FAILURE_STATUSES);
            const blank = blankNode(node.DeviceIP);
            blank.ScanStatus = status;
            blank.ScanError = FAILURE_TEXT[status].replace('{ip}', node.DeviceIP);
            blank.Hostname = node.Hostname;
            Object.assign(copy, blank);
            return copy; // a device that never answered captured nothing - blankNode's values stand
        }
        // The boot map comes from the SOURCE node: it is scratch, so the clone above has already
        // dropped it, and a failing device returns before this line and must not keep it either.
        stampCapture(copy, scanTime, node._fpcBooted);
        return copy;
    });
}

// Section 8.3. Deliberate faults, described by a manifest.
//
// Injection runs on the cloned fleet withFailures has already produced, which is one site rather than
// the two section 8.3 asked for, and is what makes both fault families reachable: the clone carries
// Interfaces, Neighbors, Clients, ArpEntries and MacTable together, so a client fault and a structural
// one are injectable in the same pass. It also settles two problems the spec raised. A device that
// never answered is skipped by reading the ScanStatus already on the clone, so no fault can be claimed
// on a placeholder; and because the clone is discarded after the write, nothing leaks into the next
// snapshot, which is what would otherwise make snapshot N's manifest a lie about snapshot N+1.
//
// The price is that an injector owns the whole shape of its fault - a client row implies a MAC-table
// row - because stampCapture has already run and will not derive it. That is the section 8.2 rule
// applied to injection: a fault that contradicts itself teaches a rule to fire on an impossible state.
//
// None of these helpers may reach rnd(): the main stream's position decides every other byte of the
// fixture, and the manifest is only an oracle if --faults 0 and --faults N describe the same fleet.
const fInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const fPick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// One port, one fault. Two injectors that both want a blocked alternate port will otherwise pick the
// same one, and the second overwrites what the first did - leaving the manifest promising a finding
// the snapshot no longer contains, which is the one thing the delta oracle cannot survive. Cleared per
// snapshot, because each snapshot is injected into its own clone.
const CLAIMED_PORTS = new Set();
const portKey = (ip, port) => `${ip}|${port}`;
const portIsFree = (ip, port) => !CLAIMED_PORTS.has(portKey(ip, port));
function claimEntry(entry) {
    if (entry.port) CLAIMED_PORTS.add(portKey(entry.deviceIp, entry.port));
    // Two-ended faults own both ends: the far end is where several of them anchor their finding.
    const p = entry.params || {};
    if (p.peerIp && p.peerPort) CLAIMED_PORTS.add(portKey(p.peerIp, p.peerPort));
    if (p.ownerIp && p.ownerPort) CLAIMED_PORTS.add(portKey(p.ownerIp, p.ownerPort));
}
const fHexByte = (rng) => fInt(rng, 0, 255).toString(16).padStart(2, '0');
const faultClientMac = (rng) => ['aa', 'bb', fHexByte(rng), fHexByte(rng), fHexByte(rng), fHexByte(rng)].join(':');
const faultSwitchMac = (rng) => ['02', 'ab', fHexByte(rng), fHexByte(rng), fHexByte(rng), fHexByte(rng)].join(':').toUpperCase();

// lldpCommon's shape without lldpCommon's reach into the main stream.
function faultLldpCommon(rng, { reachable = true, autoneg = 'enabled' } = {}) {
    return {
        Reachable: reachable,
        OrgInfo: [
            { OUI: '00-12-0f', Subtype: 'MAC/PHY Configuration/Status (1)', Info: `Autonegotiation ${autoneg}, 1000BaseTFD` },
            { OUI: '00-12-0f', Subtype: 'Maximum Frame Size (4)', Info: '1518' },
        ],
        AgeoutCount: 0, TimeToLive: 120, TimeMark: null, AgeSeconds: fInt(rng, 0, 119),
        Manufacturer: null, ModelName: null, SerialNumber: null,
        HardwareRevision: null, SoftwareRevision: null, FirmwareRevision: null,
    };
}

const scanned = (fleet) => fleet.filter(d => d.ScanStatus === 'Ok');
// A live port with no LLDP neighbour on it: where a client hangs, and never where a trunk does.
const clientPorts = (node) => node.Interfaces.filter(r =>
    String(r.Link).toLowerCase() === 'up' &&
    !node.Neighbors.some(n => String(n.LocalPort).replace(/\.\d+$/, '') === r.Port));
// A client on a port implies that port is a member of the client's VLAN: the MAC table row and the
// membership are one fact seen twice, and a fault that adds one without the other asserts a state no
// switch produces (spec 8.2).
const claimMembership = (node, row, tag) => {
    const vlan = (node.Vlans || []).find(v => v.Tag === tag);
    if (!vlan) return;
    const unit = `${row.Port}.0`;
    if (!vlan.Interfaces.some(m => m.Port === row.Port)) vlan.Interfaces.push({ Port: row.Port, Unit: unit, Active: true });
    row.Vlans = row.Vlans || [];
    if (!row.Vlans.some(v => v.Tag === tag)) {
        row.Vlans.push({ Name: vlan.Name, Tag: tag, Unit: unit, Active: true, Tagged: true, Mode: 'trunk' });
    }
};
const macRow = (client, port) => ({
    RoutingInstance: 'default-switch', VlanName: client.VLAN_Name, MacAddress: client.MAC,
    Flags: 'D', Age: null, Interface: client.Port, PhysicalPort: port,
});

// F1/F4. One MAC learned on two access ports of two different switches: either a loop or a spoof, and
// indistinguishable from a host that genuinely moved between crawls without the MAC table's age.
function injectDuplicateMac(rng, fleet) {
    const donors = scanned(fleet).filter(d => d.Clients.length);
    if (!donors.length) return null;
    const donor = fPick(rng, donors);
    // A supplicant in a failed state carries a finding of its own; copying it would put two findings
    // under one manifest entry and blunt the oracle.
    const donorClients = donor.Clients.filter(c => c.Dot1x_State === 'Unknown' || c.Dot1x_State === 'Authenticated');
    if (!donorClients.length) return null;
    const client = fPick(rng, donorClients);
    // The second switch has to configure the same VLAN: one MAC cannot appear twice in a VLAN that only
    // one of the two switches carries.
    const hosts = scanned(fleet).filter(d => d !== donor && clientPorts(d).length
        && d.Vlans.some(v => v.Tag === client.VLAN_Tag));
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const row = fPick(rng, clientPorts(host));
    const copy = { ...client, Port: `${row.Port}.0`, PortDesc: row.Desc };
    host.Clients.push(copy);
    host.MacTable.push(macRow(copy, row.Port));
    claimMembership(host, row, copy.VLAN_Tag);
    return {
        kind: 'duplicate-mac', failureModes: ['F1'], deviceIp: host.DeviceIP, port: row.Port, mac: copy.MAC,
        params: { alsoOn: donor.DeviceIP, alsoOnPort: String(client.Port).replace(/\.\d+$/, '') },
        expected: { finding: 'duplicate-mac-across-devices', deviceIp: host.DeviceIP, port: row.Port },
    };
}

// Two MACs claiming one address. The ARP-to-MAC correlation has to report the ambiguity rather than
// pick a winner, which is the defect C2 fixed in the crawler and has no fixture coverage without this.
function injectDuplicateIp(rng, fleet) {
    const hosts = scanned(fleet).filter(d => d.ArpEntries.length);
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const entry = fPick(rng, host.ArpEntries);
    const mac = faultClientMac(rng);
    host.ArpEntries.push({ MAC: mac, IP: entry.IP, Tte: 30 + (detailHash(mac) % 1171) });
    return {
        // F7: the endpoint becomes findable twice over, which the correlation has to report as
        // ambiguous rather than resolve by picking one.
        kind: 'duplicate-ip', failureModes: ['F7'], deviceIp: host.DeviceIP, port: null, mac: mac,
        params: { ip: entry.IP, alsoClaimedBy: entry.MAC },
        expected: { finding: 'duplicate-ip-two-macs', deviceIp: host.DeviceIP, port: null },
    };
}

// A resolved client address outside every allowedScopes prefix. 192.0.2.0/24 is documentation space and
// is not one of the fleet's 10.<zone>. nets, so it cannot collide with a legitimate client.
function injectOffSubnetClient(rng, fleet) {
    const hosts = scanned(fleet).filter(d => clientPorts(d).length && d.Vlans.length);
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const row = fPick(rng, clientPorts(host));
    // One of the host's own VLANs: a client in a VLAN the switch does not carry is a different fault.
    const vlan = fPick(rng, host.Vlans);
    const client = {
        IP: `192.0.2.${fInt(rng, 2, 250)}`, MAC: faultClientMac(rng), Port: `${row.Port}.0`,
        PortDesc: row.Desc, VLAN_Name: vlan.Name, VLAN_Tag: vlan.Tag, Type: 'Dynamic',
        Dot1x_User: 'Unknown', Dot1x_State: 'Unknown',
    };
    host.Clients.push(client);
    host.MacTable.push(macRow(client, row.Port));
    host.ArpEntries.push({ MAC: client.MAC, IP: client.IP, Tte: 30 + (detailHash(client.MAC) % 1171) });
    claimMembership(host, row, vlan.Tag);
    return {
        // No section 7 row: an address outside every scope is a section 6.4 gateway question.
        kind: 'off-subnet-client', failureModes: [], deviceIp: host.DeviceIP, port: row.Port, mac: client.MAC,
        params: { ip: client.IP, vlanTag: vlan.Tag },
        expected: { finding: 'client-outside-scope', deviceIp: host.DeviceIP, port: row.Port },
    };
}

// R6. A supplicant stuck in Held is a wiring or policy fault the port's own state does not show: the
// link stays up and the client keeps appearing in the MAC table.
// One authenticated supplicant moved into a state that is not authenticated. Which state it lands in is
// the parameter, because the three L1 dot1x rules read three different answers out of the same field.
function injectDot1xState({ state, kind, finding, sole = false }) {
    const injector = (rng, fleet) => {
        // Only a supplicant that was authenticated: moving one that had already failed would put two
        // findings on one manifest entry, and the entry is supposed to be the whole story about that port.
        const movable = (d) => d.Clients.filter(c => {
            if (c.Dot1x_State !== 'Authenticated') return false;
            // For the "nothing authenticated on a port that learns MACs" rule, this supplicant has to be
            // the only one on its port: with a second authenticated client the port is still fine.
            if (!sole) return true;
            const port = physical(c.Port);
            return d.Clients.filter(o => physical(o.Port) === port && o.Dot1x_State !== 'Unknown').length === 1;
        });
        const hosts = scanned(fleet).filter(d => movable(d).length);
        if (!hosts.length) return null;
        const host = fPick(rng, hosts);
        const client = fPick(rng, movable(host));
        const before = client.Dot1x_State;
        client.Dot1x_State = state;
        if (client.Dot1x_User === 'Unknown') client.Dot1x_User = `lab\\user${fInt(rng, 100, 999)}`;
        // R6's per-port view is derived from the client list, so it moves with it.
        const port = physical(client.Port);
        const row = host.Interfaces.find(r => r.Port === port);
        if (row) {
            for (const entry of row.Dot1x || []) {
                if (entry.MacAddress === client.MAC) { entry.State = state; entry.User = client.Dot1x_User; }
            }
        }
        return {
            // No section 7 row: R6 data, and a rule of its own rather than a path failure.
            kind: kind, failureModes: [], deviceIp: host.DeviceIP, port: port, mac: client.MAC,
            params: { previousState: before, state: state, user: client.Dot1x_User },
            expected: { finding: finding, deviceIp: host.DeviceIP, port: port },
        };
    };
    Object.defineProperty(injector, 'name', { value: `injectDot1x${state}` });
    return injector;
}

const injectDot1xHeld = injectDot1xState({ state: 'Held', kind: 'dot1x-held', finding: 'dot1x-held' });

// F9. A port still learning is neither forwarding nor blocking. It is left on a port the tree already
// blocked, so the forwarding subgraph is untouched and stays the spanning tree the assertion checked -
// the fault is that a path computer reading only FWD/BLK has a third state to account for.
function injectStpUnconverged(rng, fleet) {
    // BLK alone is not the port wanted: a down port blocks too, with the disabled ROLE and no link
    // behind it. The fault has to land on the redundant link the tree chose to block, which is the
    // alternate port - anywhere else there is no edge for a path computer to cross.
    const blockedOnLink = (row) => (row.StpDetail || {})['instance 0']
        && row.StpDetail['instance 0'].Role === 'ALT';
    const free = (d) => d.Interfaces.filter(r => blockedOnLink(r) && portIsFree(d.DeviceIP, r.Port));
    const hosts = scanned(fleet).filter(d => free(d).length > 0);
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const row = fPick(rng, free(host));
    row.STP = 'LRN';
    for (const scope of Object.keys(row.StpDetail || {})) row.StpDetail[scope].State = 'LRN';
    return {
        kind: 'stp-unconverged', failureModes: ['F9'], deviceIp: host.DeviceIP, port: row.Port, mac: null,
        params: { previousState: 'BLK' },
        expected: { finding: 'stp-port-not-converged', deviceIp: host.DeviceIP, port: row.Port },
    };
}

// R2. The two ends of one link advertising different autonegotiation state. Neither port alone looks
// wrong, so nothing short of comparing the pair across two devices finds it.
// One link both ends report, resolved down to the two interface rows and the two LLDP entries that
// describe it. Matching the back-entry on the port as well as the address matters once a pair of devices
// is joined by more than one wire: by address alone, a fault meant for one wire lands half on another.
function pickReciprocalLink(rng, fleet, eligible) {
    const byIp = new Map(fleet.map(d => [String(d.DeviceIP), d]));
    const usable = (d) => d.ScanStatus === 'Ok' && d.SectionsCaptured.includes('INTERFACES_EXT');
    const candidates = [];
    for (const device of fleet.filter(usable)) {
        for (const neighbor of device.Neighbors) {
            const peer = byIp.get(String(neighbor.ManagementIP));
            if (!peer || !usable(peer)) continue;
            const nearPort = physical(neighbor.LocalPort);
            const farPort = physical(neighbor.RemotePort);
            const back = peer.Neighbors.find(x => String(x.ManagementIP) === String(device.DeviceIP)
                && physical(x.LocalPort) === farPort && physical(x.RemotePort) === nearPort);
            if (!back) continue;
            const nearRow = device.Interfaces.find(r => r.Port === nearPort);
            const farRow = peer.Interfaces.find(r => r.Port === farPort);
            if (!nearRow || !farRow) continue;
            if (String(nearRow.Link).toLowerCase() !== 'up' || String(farRow.Link).toLowerCase() !== 'up') continue;
            // Neither end may already carry a fault: a second injector writing over the first leaves the
            // first's manifest entry promising a finding that is no longer there.
            if (!portIsFree(device.DeviceIP, nearPort) || !portIsFree(peer.DeviceIP, farPort)) continue;
            const link = { device, peer, neighbor, back, nearPort, farPort, nearRow, farRow };
            // Filtered before the draw, not after: a fault that only lands on a copper trunk and picks
            // blind places about one time in twelve on this fleet, and a kind that usually fails to place
            // is a kind the manifest usually cannot be checked against.
            if (eligible && !eligible(link)) continue;
            candidates.push(link);
        }
    }
    return candidates.length ? fPick(rng, candidates) : null;
}

const physical = (port) => String(port).replace(/\.\d+$/, '');
const tlv = (entry, subtypePrefix) => (entry.OrgInfo || []).find(o => String(o.Subtype).startsWith(subtypePrefix));
// The Junos wording, the same strings lldpCommon emits. A fault written in a paraphrase would only ever
// be findable by a rule written in the same paraphrase.
const AUTONEG_TLV = {
    Enabled: 'Autonegotiation [supported, enabled (0x3)], PMD Autonegotiation Capability (0xc036), MAU Type (0x0)',
    // `supported, disabled` - autonegotiation deliberately off, which is a different fact from the
    // `not supported` an optical port advertises. A fault written in the second form is unreadable: a
    // rule is right to treat "the field is unavailable" as no evidence at all.
    Disabled: 'Autonegotiation [supported, disabled (0x1)], PMD Autonegotiation Capability (0xc036), MAU Type (0x0)',
};

// A wire whose two ends disagree about autonegotiation. What a device ADVERTISES and what its own row
// says are one fact seen twice, so both move together: flipping only the TLV would make the fixture, not
// the network, the thing that is wrong - and a rule could then be written that never works on hardware.
function injectAutonegAsymmetric(rng, fleet) {
    // Copper at both ends: an optical port has no autonegotiation to disagree about and reports the field
    // nowhere, so the fault would be invisible by construction. And both ends negotiating already, so
    // only the FAR end has to change - asserting a value on the near end too would silence an
    // autoneg-disabled finding the clean fleet legitimately reports there, and a fault that takes a
    // finding away is one the delta oracle cannot attribute.
    const link = pickReciprocalLink(rng, fleet, (l) =>
        l.nearRow.AutoNegotiation === 'Enabled' && l.farRow.AutoNegotiation === 'Enabled'
        && tlv(l.neighbor, 'MAC/PHY') && tlv(l.back, 'MAC/PHY'));
    if (!link) return null;
    // `back`'s TLV - what this device advertises to the peer - is left alone: it already says Enabled,
    // which is what the near row says, so the fault is the disagreement rather than a second edit.
    tlv(link.neighbor, 'MAC/PHY').Info = AUTONEG_TLV.Disabled;   // what the peer advertises to us
    link.farRow.AutoNegotiation = 'Disabled';
    return {
        // No section 7 row: the 802.3 TLVs R2 retains are what make it visible at all.
        kind: 'autoneg-asymmetric', failureModes: [], deviceIp: link.device.DeviceIP,
        port: link.nearPort, mac: null,
        params: { peerIp: link.peer.DeviceIP, peerPort: link.farPort },
        expected: { finding: 'autoneg-mismatch', deviceIp: link.device.DeviceIP, port: link.nearPort },
    };
}

// G5. The local MTU against the frame size the far end advertises - the comparison R2 retained the
// Maximum Frame Size TLV for and that nothing in revision 2 named.
function injectMtuMismatch(rng, fleet) {
    const link = pickReciprocalLink(rng, fleet, (l) =>
        typeof l.nearRow.Mtu === 'number' && !!tlv(l.neighbor, 'Maximum Frame Size'));
    if (!link) return null;
    const advertised = tlv(link.neighbor, 'Maximum Frame Size');
    const raised = link.nearRow.Mtu === 1514 ? 9192 : 1514;
    link.farRow.Mtu = raised;
    advertised.Info = `MTU Size (${raised})`;
    return {
        kind: 'mtu-mismatch', failureModes: [], deviceIp: link.device.DeviceIP, port: link.nearPort, mac: null,
        params: { peerIp: link.peer.DeviceIP, peerPort: link.farPort, localMtu: link.nearRow.Mtu, farMtu: raised },
        expected: { finding: 'mtu-mismatch', deviceIp: link.device.DeviceIP, port: link.nearPort },
    };
}

// Half-duplex on one end of a wire whose other end is full. The finding is anchored on the half-duplex
// end, because that is the port an operator has to go and look at.
function injectDuplexMismatch(rng, fleet) {
    // Copper again: optics report no duplex at all.
    const link = pickReciprocalLink(rng, fleet, (l) =>
        l.nearRow.Duplex === 'Full-duplex' && l.farRow.Duplex === 'Full-duplex');
    if (!link) return null;
    link.farRow.Duplex = 'Half-duplex';
    link.farRow.DuplexNegotiated = 'Half-duplex';
    return {
        kind: 'duplex-mismatch', failureModes: [], deviceIp: link.peer.DeviceIP, port: link.farPort, mac: null,
        params: { peerIp: link.device.DeviceIP, peerPort: link.nearPort },
        expected: { finding: 'duplex-mismatch', deviceIp: link.peer.DeviceIP, port: link.farPort },
    };
}

// F14. One unmanaged bridge between two switches. No node exists for it, both ports read DESG FWD, and
// chaining them into a path would invent a link that is not there.
function injectSharedSegment(rng, fleet) {
    const hosts = scanned(fleet).filter(d => clientPorts(d).length);
    if (hosts.length < 2) return null;
    const first = fPick(rng, hosts);
    const others = hosts.filter(d => d !== first);
    if (!others.length) return null;
    const second = fPick(rng, others);
    const mac = faultSwitchMac(rng);
    const ends = [];
    for (const node of [first, second]) {
        const row = fPick(rng, clientPorts(node));
        row.Desc = 'UNMANAGED shared segment';
        node.Neighbors.push({
            LocalPort: `${row.Port}.0`, RemotePort: ends.length === 0 ? '1' : '2', Hostname: 'Unknown',
            MacAddress: mac, ManagementIP: 'Unknown', Description: 'Unmanaged 8-port switch',
            ...faultLldpCommon(rng, { reachable: false }),
        });
        ends.push({ deviceIp: node.DeviceIP, port: row.Port });
    }
    return {
        kind: 'unmanaged-bridge-shared-segment', failureModes: ['F6', 'F14'],
        deviceIp: ends[0].deviceIp, port: ends[0].port, mac: mac,
        params: { otherIp: ends[1].deviceIp, otherPort: ends[1].port },
        expected: { finding: 'shared-segment-not-a-link', deviceIp: ends[0].deviceIp, port: ends[0].port },
    };
}

// F11. One VLAN removed from ONE end of a trunk. The link still carries every other VLAN and both ends
// still forward, so nothing about the port looks wrong; only comparing the two ends' membership finds it,
// and a path computer that skips the VLAN filter reports a route frames in that VLAN cannot take.
function injectVlanMissingFromTrunk(rng, fleet) {
    const byIp = new Map(fleet.map(d => [String(d.DeviceIP), d]));
    const candidates = [];
    for (const d of scanned(fleet)) {
        for (const n of d.Neighbors) {
            const peer = byIp.get(String(n.ManagementIP));
            if (!peer || peer.ScanStatus !== 'Ok') continue;
            const port = String(n.LocalPort).replace(/\.\d+$/, '');
            const peerPort = String(n.RemotePort).replace(/\.\d+$/, '');
            // Both ends must currently agree on the tag, or removing it proves nothing.
            for (const vlan of d.Vlans) {
                if (!vlan.Interfaces.some(m => m.Port === port)) continue;
                const far = peer.Vlans.find(v => v.Tag === vlan.Tag);
                if (!far || !far.Interfaces.some(m => m.Port === peerPort)) continue;
                candidates.push({ device: d, port: port, vlan: vlan, peer: peer, peerPort: peerPort });
            }
        }
    }
    if (!candidates.length) return null;
    const hit = fPick(rng, candidates);
    hit.vlan.Interfaces = hit.vlan.Interfaces.filter(m => m.Port !== hit.port);
    const row = hit.device.Interfaces.find(r => r.Port === hit.port);
    if (row) row.Vlans = (row.Vlans || []).filter(v => v.Tag !== hit.vlan.Tag);
    return {
        kind: 'vlan-missing-from-trunk', failureModes: ['F11'],
        deviceIp: hit.device.DeviceIP, port: hit.port, mac: null,
        params: { vlanTag: hit.vlan.Tag, vlanName: hit.vlan.Name, peerIp: hit.peer.DeviceIP, peerPort: hit.peerPort },
        expected: { finding: 'vlan-absent-on-one-trunk-end', deviceIp: hit.device.DeviceIP, port: hit.port },
    };
}

// One injector per single-ended L1 rule (spec section 3), from a table rather than written out: an entry
// names the rule its fault has to make fire and the smallest mutation that makes it fire.
//
// Two constraints shape every mutation. It lands on a CLIENT port unless the rule needs otherwise,
// because a defect on a trunk is read by the rule at the far end too and a manifest entry is supposed to
// be the whole story about one location. And it keeps the row self-consistent - a PoE string agrees with
// the PoE fields, a duplex change carries the negotiated value with it - because a fault that contradicts
// itself teaches a rule to fire on a state no switch produces (section 8.2).
//
// `lag-member-down` has no entry: the fixture holds no aggregate at all, and an aggregate is ordinary
// topology rather than a fault, so inventing one here would put a normal shape behind a fault manifest.
// It is covered by the `lag-two-members-one-down` micro-topology instead.
const L1_PORT_DEFECTS = [
    {
        finding: 'duplex-half-on-up-link',
        // Copper only, and the same for the three below: on optics the field is absent, and a defect
        // planted in an absent field is a state the fixture would be alone in producing.
        needs: 'Duplex',
        apply: (row) => { row.Duplex = 'Half-duplex'; row.DuplexNegotiated = 'Half-duplex'; },
    },
    { finding: 'negotiation-incomplete', needs: 'NegotiationStatus', where: (row) => row.AutoNegotiation === 'Enabled', apply: (row) => { row.NegotiationStatus = 'Incomplete'; } },
    {
        finding: 'autoneg-disabled',
        // Only a port that was negotiating, so the fault is a change rather than a restatement.
        needs: 'AutoNegotiation',
        where: (row) => row.AutoNegotiation === 'Enabled',
        apply: (row) => { row.AutoNegotiation = 'Disabled'; },
    },
    {
        finding: 'crc-align-errors',
        where: (row) => !!(row.MacStatistics || {})['CRC/Align errors'],
        apply: (row, rng) => { row.MacStatistics['CRC/Align errors'].Receive = fInt(rng, 11, 9000); },
    },
    { finding: 'input-errors-present', apply: (row, rng) => { row.InputErrors.Errors = fInt(rng, 1, 40000); } },
    { finding: 'output-errors-present', apply: (row, rng) => { row.OutputErrors.Errors = fInt(rng, 1, 40000); } },
    { finding: 'framing-errors-present', apply: (row, rng) => { row.InputErrors['Framing errors'] = fInt(rng, 1, 900); } },
    { finding: 'remote-fault', needs: 'RemoteFault', apply: (row) => { row.RemoteFault = 'Offline'; } },
    {
        finding: 'link-alarm-on-up-port',
        apply: (row) => { row.ActiveAlarms = 'LINK'; row.ActiveDefects = 'LINK'; },
    },
    { finding: 'bpdu-error', apply: (row) => { row.BpduError = 'Detected'; } },
    { finding: 'loop-detect-pdu-error', apply: (row) => { row.LoopDetectPduError = 'Detected'; } },
    { finding: 'ethernet-switching-error', apply: (row) => { row.EthernetSwitchingError = 'Detected'; } },
    { finding: 'mac-rewrite-error', apply: (row) => { row.MacRewriteError = 'Detected'; } },
    {
        finding: 'port-flapped-recently',
        // Not on a device that booted within the hour: the rule suppresses there, correctly, and the
        // manifest would be claiming a finding the engine is right to withhold.
        host: (node) => {
            const booted = Date.parse(node.Uptime);
            const seen = Date.parse(node.CaptureTimestamp);
            return isFinite(booted) && isFinite(seen) && (seen - booted) / 1000 > 3600;
        },
        apply: (row, rng) => { row.LastFlappedSeconds = fInt(rng, 30, 3500); row.LastFlappedState = 'Parsed'; },
    },
    {
        // R7's whole point: without AdminStatus, this reads the same as a phone that is not drawing power.
        finding: 'poe-admin-disabled-with-endpoint',
        ports: (node) => {
            const med = new Set(node.MedNeighbors.map(m => physical(m.LocalPort)));
            return node.Interfaces.filter(r => med.has(r.Port) && r.PoeAdminStatus !== null);
        },
        apply: (row) => {
            row.PoeAdminStatus = 'Disabled';
            row.PoeOperStatus = 'OFF';
            row.PoePowerConsumption = '0.0W';
            row.PoeClass = 'not-applicable';
            // The display string the worker builds from the same two columns, so the two agree.
            row.PoE = 'OFF (0.0W)';
        },
    },
    {
        finding: 'poe-denied',
        ports: (node) => node.Interfaces.filter(r => r.PoeOperStatus !== null && String(r.Link).toLowerCase() === 'up'),
        apply: (row) => {
            // The capture's PoE table only ever prints ON and OFF, so the fault vocabulary here is
            // derived rather than observed - see the note on the rule in rules.js. FAULT is the spelling
            // Juniper's published output-field table uses for this column.
            row.PoeOperStatus = 'FAULT';
            row.PoePowerConsumption = '0.0W';
            row.PoeClass = 'not-applicable';
            row.PoE = 'FAULT (0.0W)';
        },
    },
];

// A live port with the extensive section behind it, no LLDP neighbour and no MED endpoint: the defect
// lands somewhere only one rule at one location can see it.
const plainPorts = (node) => {
    if (!node.SectionsCaptured.includes('INTERFACES_EXT')) return [];
    const med = new Set(node.MedNeighbors.map(m => physical(m.LocalPort)));
    return clientPorts(node).filter(r => !med.has(r.Port));
};

function injectPortDefect(defect) {
    const portsOf = (node) => {
        if (!node.SectionsCaptured.includes('INTERFACES_EXT')) return [];
        let rows = defect.ports ? defect.ports(node) : plainPorts(node);
        if (defect.needs) rows = rows.filter(r => r[defect.needs] !== null && r[defect.needs] !== undefined);
        return defect.where ? rows.filter(defect.where) : rows;
    };
    const injector = (rng, fleet) => {
        const hosts = scanned(fleet).filter(d => (!defect.host || defect.host(d)) && portsOf(d).length);
        if (!hosts.length) return null;
        const host = fPick(rng, hosts);
        const row = fPick(rng, portsOf(host));
        defect.apply(row, rng);
        return {
            // No section 7 row: these are single-device L1 defects, not path failure modes.
            kind: `l1-${defect.finding}`, failureModes: [], deviceIp: host.DeviceIP, port: row.Port, mac: null,
            params: {},
            expected: { finding: defect.finding, deviceIp: host.DeviceIP, port: row.Port },
        };
    };
    Object.defineProperty(injector, 'name', { value: `inject_${defect.finding.replace(/-/g, '_')}` });
    return injector;
}

// ---------------------------------------------------------------------------------------------------
// The L2 and L3 faults (spec section 3.6). Same contract as above: one kind per rule the fixture can
// reach, each naming the finding it has to produce, so the delta oracle can hold both sides to it.

// An edge is one finding whichever end the engine reaches first, so both the rule and the manifest
// anchor it on the lower of the two ends.
const lowerEnd = (link) => [`${link.device.DeviceIP}|${link.nearPort}`, `${link.peer.DeviceIP}|${link.farPort}`]
    .sort()[0].split('|');

// A MAC learned in a VLAN the port does not carry. The switch answers both questions and they disagree.
function injectMacInWrongVlan(rng, fleet) {
    const hosts = scanned(fleet).filter(d => d.Vlans.length > 1 && clientPorts(d).length);
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const rows = clientPorts(host).filter(r => (r.Vlans || []).length);
    if (!rows.length) return null;
    const row = fPick(rng, rows);
    const carried = new Set((row.Vlans || []).map(v => v.Name));
    const stray = host.Vlans.filter(v => !carried.has(v.Name));
    if (!stray.length) return null;
    const vlan = fPick(rng, stray);
    const mac = faultClientMac(rng);
    host.MacTable.push({
        RoutingInstance: 'default-switch', VlanName: vlan.Name, MacAddress: mac,
        Flags: 'D', Age: null, Interface: `${row.Port}.0`, PhysicalPort: row.Port,
    });
    return {
        kind: 'mac-in-unconfigured-vlan', failureModes: [], deviceIp: host.DeviceIP, port: row.Port, mac: mac,
        params: { vlanName: vlan.Name, vlanTag: vlan.Tag, portCarries: [...carried] },
        expected: { finding: 'mac-in-vlan-not-on-port', deviceIp: host.DeviceIP, port: row.Port },
    };
}

// Section 6.3. Both ends of one wire holding the same role: a tree that has not converged, or two trees.
function injectStpRoleConflict(rng, fleet) {
    const roleOf = (row) => ((row.StpDetail || {})['instance 0'] || {}).Role || null;
    const link = pickReciprocalLink(rng, fleet, (l) => roleOf(l.nearRow) === 'DESG' && roleOf(l.farRow) === 'ROOT');
    if (!link) return null;
    link.farRow.StpDetail['instance 0'].Role = 'DESG';
    // The rule cannot know which end was changed - both now claim the segment - so it anchors on the
    // lower end of the wire and the manifest has to name the same one.
    const [anchorIp, anchorPort] = lowerEnd(link);
    return {
        kind: 'stp-role-conflict', failureModes: [], deviceIp: link.peer.DeviceIP, port: link.farPort, mac: null,
        params: { scope: 'instance 0', role: 'DESG', peerIp: link.device.DeviceIP, peerPort: link.nearPort },
        expected: { finding: 'stp-both-ends-claim-segment', deviceIp: anchorIp, port: anchorPort },
    };
}

// G2. One end runs an instance for a scope the other does not, so the pruning that decides whether a
// frame may cross happens on one side of the wire only.
function injectStpScopeDrift(rng, fleet) {
    // On a link the tree already blocks, so the forwarding set is untouched and the fault is exactly the
    // drift: a port with no instance beside a peer that has one.
    const link = pickReciprocalLink(rng, fleet,
        (l) => ((l.nearRow.StpDetail || {})['instance 0'] || {}).Role === 'ALT'
            && Object.keys(l.farRow.StpDetail || {}).length);
    if (!link) return null;
    const scopes = Object.keys(link.nearRow.StpDetail);
    link.nearRow.StpDetail = {};
    link.nearRow.STP = 'Unknown';
    return {
        kind: 'stp-scope-drift', failureModes: [], deviceIp: link.device.DeviceIP, port: link.nearPort, mac: null,
        params: { lostScopes: scopes, peerIp: link.peer.DeviceIP, peerPort: link.farPort },
        expected: { finding: 'stp-scope-drift', deviceIp: link.device.DeviceIP, port: link.nearPort },
    };
}

// G5. One end of a trunk moves its native VLAN. Every VLAN is still on both ends and both still forward,
// so only the tagged/untagged annotation differs - untagged frames leaving one end arrive in a different
// broadcast domain at the other.
function injectNativeVlanMismatch(rng, fleet) {
    const trunkMembers = (row) => (row.Vlans || []).filter(v => v.Mode === 'trunk');
    const link = pickReciprocalLink(rng, fleet, (l) => {
        const members = trunkMembers(l.nearRow);
        return members.filter(v => v.Tagged === false).length === 1 && members.length > 1;
    });
    if (!link) return null;
    const members = trunkMembers(link.nearRow);
    const was = members.find(v => v.Tagged === false);
    const now = members.find(v => v.Tagged === true);
    // Both views of the same membership, because a switch prints one table and the crawler splits it:
    // changing the port row alone would leave the device's own VLAN list disagreeing with it.
    const setTagged = (tag, tagged) => {
        for (const v of link.nearRow.Vlans) if (v.Tag === tag) v.Tagged = tagged;
        const vlan = (link.device.Vlans || []).find(v => v.Tag === tag);
        if (vlan) for (const m of vlan.Interfaces) if (m.Port === link.nearPort) m.Tagged = tagged;
    };
    setTagged(was.Tag, true);
    setTagged(now.Tag, false);
    const [anchorIp, anchorPort] = lowerEnd(link);
    return {
        kind: 'native-vlan-mismatch', failureModes: [], deviceIp: link.device.DeviceIP, port: link.nearPort, mac: null,
        params: { wasNative: was.Tag, nowNative: now.Tag, peerIp: link.peer.DeviceIP, peerPort: link.farPort },
        expected: { finding: 'native-vlan-mismatch', deviceIp: anchorIp, port: anchorPort },
    };
}

// G4. One spanning-tree instance reconverged moments before the scan. The baseline's every bridge last
// changed at least an hour ago, so this is the only recent one in the snapshot.
function injectRecentTopologyChange(rng, fleet) {
    const hosts = scanned(fleet).filter(d => (d.StpBridge || []).length);
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const stanza = fPick(rng, host.StpBridge);
    stanza.TimeSinceLastChangeSeconds = 12 + fInt(rng, 0, 120);
    // A change that just happened is a change more than the switch had counted before it.
    if (typeof stanza.TopologyChangeCount === 'number') stanza.TopologyChangeCount += 1;
    return {
        kind: 'stp-recent-topology-change', failureModes: [], deviceIp: host.DeviceIP, port: null, mac: null,
        params: { scope: stanza.Scope, seconds: stanza.TimeSinceLastChangeSeconds },
        expected: { finding: 'stp-topology-change-recent', deviceIp: host.DeviceIP, port: null },
    };
}

// Section 4.3's dot1x upgrade. A supplicant authenticated into the guest VLAN. Modelled by configuring
// the guest VLAN to be the production VLAN the client is already in, so the MAC table, the client list
// and the dot1x rows all still agree - the fault is the fallback landing, not an invented VLAN.
function injectDot1xFallbackVlan(rng, fleet) {
    const candidates = [];
    for (const d of scanned(fleet)) {
        for (const row of d.Interfaces) {
            const hit = (row.Dot1x || []).find(e => e.State === 'Authenticated' && e.AuthenticatedVlan);
            if (hit) candidates.push({ device: d, row: row, entry: hit });
        }
    }
    if (!candidates.length) return null;
    const hit = fPick(rng, candidates);
    for (const entry of hit.row.Dot1x) entry.GuestVlan = hit.entry.AuthenticatedVlan;
    return {
        kind: 'dot1x-fallback-vlan', failureModes: [], deviceIp: hit.device.DeviceIP, port: hit.row.Port,
        mac: hit.entry.MacAddress,
        params: { guestVlan: hit.entry.AuthenticatedVlan },
        expected: { finding: 'dot1x-fallback-vlan', deviceIp: hit.device.DeviceIP, port: hit.row.Port },
    };
}

// G1. A transit sighting moved to the wrong port: the switch's forwarding table says the host is out a
// different interface than the computed path uses. Nothing about either port looks wrong and both ends
// still forward - only comparing the path against the MAC table finds it. Not a rule, so it carries no
// expected finding; the path tests are its oracle.
function injectMacLearnedOffPath(rng, fleet) {
    // The row moved is the sighting of a real client on the switch DIRECTLY ABOVE the one it is plugged
    // into. Anything else is a contradiction no traced path would cross - and a fault the tool meant to
    // find it cannot see is not a test of anything.
    const byIp = new Map(fleet.map(d => [String(d.DeviceIP), d]));
    const candidates = [];
    for (const host of scanned(fleet)) {
        for (const client of host.Clients || []) {
            if (!client.MAC || !client.VLAN_Name) continue;
            for (const n of host.Neighbors) {
                const peer = byIp.get(String(n.ManagementIP));
                if (!peer || peer.ScanStatus !== 'Ok') continue;
                const facing = String(n.RemotePort).replace(/\.\d+$/, '');
                const row = (peer.MacTable || []).find(r => r.VlanName === client.VLAN_Name
                    && String(r.MacAddress).toUpperCase() === String(client.MAC).toUpperCase()
                    && r.PhysicalPort === facing);
                if (!row) continue;
                // Another port of the peer that genuinely carries the VLAN, or the moved row would be one
                // no switch prints.
                const elsewhere = (peer.Interfaces || []).find(r => r.Port !== facing
                    && peer.Neighbors.some(x => String(x.LocalPort).replace(/\.\d+$/, '') === r.Port)
                    && (r.Vlans || []).some(v => v.Name === client.VLAN_Name));
                if (elsewhere) candidates.push({ peer: peer, row: row, to: elsewhere.Port, host: host, client: client });
            }
        }
    }
    if (!candidates.length) return null;
    const hit = fPick(rng, candidates);
    const was = hit.row.PhysicalPort;
    hit.row.PhysicalPort = hit.to;
    hit.row.Interface = `${hit.to}.0`;
    return {
        kind: 'mac-learned-off-path', failureModes: ['F4'],
        deviceIp: hit.peer.DeviceIP, port: hit.to, mac: hit.row.MacAddress,
        params: {
            wasLearnedOn: was, vlanName: hit.row.VlanName,
            ownerIp: hit.host.DeviceIP, ownerPort: String(hit.client.Port).replace(/\.\d+$/, ''),
            vlanTag: hit.client.VLAN_Tag,
        },
        // No rule reads this: G1 is path verification, not a fleet sweep, so the oracle is a computePath
        // call in the path suite rather than a finding in the manifest's delta.
        expected: { finding: null, deviceIp: hit.peer.DeviceIP, port: hit.to },
    };
}

// port-last-used-spec.md section 9.3. Six ports whose counters say one thing each, so every state in
// section 5.3 has a named subject at fleet scale rather than only in the hand-built cases.
//
// None of them is a rule finding - port-last-used is a question asked of one port, not a sweep - so each
// promises `lastUsed` instead, and the oracle is a computeLastUsed call rather than an entry in the
// delta. `finding: null` keeps them out of the delta oracle, the way mac-learned-off-path already is.
//
// Each plants its state on BOTH readable snapshots' worth of counters by writing absolute values: the
// injector runs after stampCapture on a clone, so there is no rate left to advance and the numbers have
// to be the ones the module will read.
function plantLastUsed(kind, state, rng, fleet, pick_, apply) {
    const hosts = scanned(fleet).filter(d => (d.SectionsCaptured || []).includes('INTERFACES_EXT'));
    const candidates = [];
    for (const host of hosts) {
        for (const row of host.Interfaces) {
            if (!portIsFree(host.DeviceIP, row.Port)) continue;
            if (!pick_(row, host)) continue;
            candidates.push({ host, row });
        }
    }
    if (!candidates.length) return null;
    // Chosen by a hash of the port's own NAME rather than from the stream, so every snapshot plants on
    // the same port. These four kinds are sustained properties of a port - idle, chattering, busy - and
    // a property has to hold across the window, or the delta reading it is measuring the injector
    // moving rather than the port. The two event kinds below keep the random draw, because an event
    // belongs to the snapshot it happened in.
    //
    // Which is why the predicates above must not read anything that MOVES. They test port shape - link
    // state is set by the plant itself, not required of it - because a predicate reading a counter
    // makes the candidate set differ between snapshots, the hash then picks a different port, and the
    // port that was planted in one snapshot and not the next reads as a counter reset.
    let hit = candidates[0];
    let bestHash = Infinity;
    for (const c of candidates) {
        const h = detailHash(`${kind}|${c.host.DeviceIP}|${c.row.Port}`);
        if (h < bestHash) { bestHash = h; hit = c; }
    }
    const params = apply(hit.row, hit.host, rng) || {};
    return {
        kind: kind, failureModes: [], deviceIp: hit.host.DeviceIP, port: hit.row.Port, mac: null,
        params: params,
        expected: { finding: null, lastUsed: state, deviceIp: hit.host.DeviceIP, port: hit.row.Port },
    };
}

// A port no LLDP neighbour is seen on. E0 is a direct read that the far end spoke seconds ago, and it
// outranks every counter-derived state - correctly. A kind that promises an IDLE state therefore has to
// land where the counters are the only evidence there is.
// Link state as the plant needs it, parity included: section 4.2's counter increments on every carrier
// state change, so an up port reports an odd count and a down one an even one. A plant that sets the
// link without the parity writes a state no switch reports, and the fixture asserts that parity.
function forceLive(row, up) {
    row.Link = up ? 'up' : 'down';
    row.Admin = 'up';
    row.CarrierTransitions = up ? 1 : 0;
    row.OutputErrors['Carrier transitions'] = row.CarrierTransitions;
    row.ActiveAlarms = up ? 'None' : 'LINK';
    row.ActiveDefects = up ? 'None' : 'LINK';
}

const silentPort = (row, host) => ![...(host.Neighbors || []), ...(host.MedNeighbors || [])]
    .some(n => physical(n.LocalPort) === row.Port);

// A port nothing has ever transmitted on since the epoch - the strongest claim in the model, and the one
// a reset must never be able to produce. Link down, because on the measured fleet zero input and a dark
// port are coextensive: no up port there has zero input bytes.
const injectNeverUsedPort = (rng, fleet) => plantLastUsed('never-used-port', 'NEVER_USED_THIS_EPOCH', rng, fleet,
    // Silent and holding no MAC. applyTransitLearning has already run, and a dynamic MAC on the port is
    // E2 - which outranks E5 and is right to: something down there transmitted within the aging time.
    // A port promised as never used has to be one where no other source has anything to say.
    (row, host) => typeof row.InputBytes === 'number' && !(row.Vlans || []).some(v => v.Mode === 'trunk')
        && silentPort(row, host) && !(host.MacTable || []).some(m => physical(m.PhysicalPort || m.Interface) === row.Port)
        && !(host.Clients || []).some(c => physical(c.Port) === row.Port),
    (row) => { forceLive(row, false); row.InputBytes = 0; row.InputPackets = 0; row.InputBps = 0; return { inputBytes: 0 }; });

// Carried traffic once, carries none now. The bound is the epoch, because a single reading of a
// cumulative counter is a lower bound and nothing more.
const injectIdlePort = (rng, fleet) => plantLastUsed('idle-port', 'IDLE_SINCE', rng, fleet,
    (row, host) => typeof row.InputBytes === 'number' && silentPort(row, host)
        && !(row.Vlans || []).some(v => v.Mode === 'trunk'),
    (row) => {
        forceLive(row, true);
        // Frozen at a constant, so every snapshot reads the same number and the delta is exactly zero -
        // which is what "carried traffic once, carries none now" looks like to a cumulative counter.
        row.InputBps = 0;
        row.InputBytes = 4e9;
        row.InputPackets = 6e6;
        return { frozenAt: row.InputBytes };
    });

// Section 2.3's case, planted rather than hoped for: ~64 B frames at a tenth of a packet per second, for
// as long as anyone has been watching. Under a naive byte-delta rule this is the busiest port on the
// switch, and it is the one an operator is trying to find.
const injectChatteringPort = (rng, fleet) => plantLastUsed('chattering-port', 'TRANSMITTER_PRESENT', rng, fleet,
    (row, host) => typeof row.InputBytes === 'number' && silentPort(row, host)
        && !(row.Vlans || []).some(v => v.Mode === 'trunk'),
    (row, host) => {
        forceLive(row, true);
        // Cumulative at 0.1 pps since this device booted, so the delta across the window is real and
        // below the floor on both halves - 64 B frames at a tenth of a packet per second.
        const seconds = typeof host.UptimeSeconds === 'number' ? host.UptimeSeconds : 86400;
        row.InputPackets = Math.max(1, Math.round(0.1 * seconds));
        row.InputBytes = row.InputPackets * 64;
        row.InputBps = 40;
        return { meanFrameBytes: 64, pps: 0.1 };
    });

// Busy, and demonstrably so across the gap: a frame size and a rate that clear the floor on both halves.
const injectActivePort = (rng, fleet) => plantLastUsed('active-port', 'ACTIVE_NOW', rng, fleet,
    (row) => typeof row.InputBytes === 'number' && !(row.Vlans || []).some(v => v.Mode === 'trunk'),
    (row, host) => {
        forceLive(row, true);
        const seconds = typeof host.UptimeSeconds === 'number' ? host.UptimeSeconds : 86400;
        row.InputPackets = Math.max(1, Math.round(50 * seconds));
        row.InputBytes = row.InputPackets * 900;
        row.InputBps = 8e7;
        return { meanFrameBytes: 900, pps: 50 };
    });

// The section 5.2 regression case at fleet scale: the device rebooted between the two snapshots, so this
// port's counters restarted. It must read idle since the pre-reboot activity, never "never used".
function injectRebootedDevice(rng, fleet) {
    const hosts = scanned(fleet).filter(d => (d.SectionsCaptured || []).includes('INTERFACES_EXT')
        && typeof d.UptimeSeconds === 'number' && d.UptimeSeconds > 4 * 86400
        && d.Interfaces.some(r => r.Link === 'up' && typeof r.InputBytes === 'number' && r.InputBytes > 0));
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    // A port with no LLDP neighbour on it. E0 is a direct read that the far end spoke seconds ago, and
    // after a reboot that is TRUE - the promise here is about the counters, so the port has to be one
    // where the counters are the only evidence.
    const speaks = new Set([...(host.Neighbors || []), ...(host.MedNeighbors || [])]
        .map(n => physical(n.LocalPort)));
    const rows = host.Interfaces.filter(r => r.Link === 'up' && typeof r.InputBytes === 'number'
        && !speaks.has(r.Port) && portIsFree(host.DeviceIP, r.Port));
    if (!rows.length) return null;
    const row = fPick(rng, rows);
    const wasSeconds = host.UptimeSeconds;
    // Every member, because a chassis reboot is not a linecard reboot - the per-FPC case already has its
    // own subject in ageFleet, and mixing the two here would make neither testable.
    const bootedMs = Date.parse(host.CaptureTimestamp) - 900 * 1000;
    host.UptimeSeconds = 900;
    host.FpcUptimes = (host.FpcUptimes || []).map(r => ({ ...r, UptimeSeconds: 900, SystemBooted: iso(new Date(bootedMs)) }));
    // The boot STAMP moves with the seconds. A chassis that says it booted years ago and fifteen minutes
    // ago at once is the self-contradicting fault this file's own rule forbids - and section 4.2's boot
    // filter reads exactly that pair, so leaving them apart teaches it to fire on an impossible state.
    host.Uptime = iso(new Date(bootedMs));
    for (const r of host.Interfaces) {
        if (typeof r.InputBytes !== 'number') continue;
        r.InputBytes = r.Link === 'up' ? 120000 : 0;
        r.InputPackets = r.Link === 'up' ? 200 : 0;
        r.InputBps = 0;
        // A live port on a box that booted 15 minutes ago came up at boot: its flap IS the boot event,
        // which is what the filter is there to discard. A dark port never transitioned and keeps its own.
        if (String(r.Link).toLowerCase() === 'up') { r.LastFlappedSeconds = 870; r.LastFlappedState = 'Parsed'; }
    }
    return {
        kind: 'rebooted-device', failureModes: [], deviceIp: host.DeviceIP, port: row.Port, mac: null,
        params: { uptimeWasSeconds: wasSeconds, uptimeNowSeconds: 900 },
        expected: { finding: null, lastUsed: 'IDLE_SINCE', deviceIp: host.DeviceIP, port: row.Port },
    };
}

// A counter cleared by hand, with no reboot behind it: uptime is untouched and the bytes AFTER the clear
// are higher than the bytes before, so nothing about the numbers alone says a reset happened. Without P2
// this is indistinguishable from a busy port, and a delta taken across it is fiction.
const injectStatisticsCleared = (rng, fleet) => plantLastUsed('statistics-cleared', 'IDLE_SINCE', rng, fleet,
    (row, host) => typeof row.InputBytes === 'number' && silentPort(row, host)
        && !(row.Vlans || []).some(v => v.Mode === 'trunk'),
    (row, host) => {
        forceLive(row, true);
        // Derived from THIS snapshot's capture instant, so the stamp differs between snapshots. A clear
        // is an event: planting the same string in every snapshot would be a port that has always been
        // in the cleared state, which is not a reset and reads as ordinary growth.
        const clearedMs = Date.parse(host.CaptureTimestamp) - 2 * 86400000;
        row.StatisticsLastCleared = `${iso(new Date(clearedMs))} (2d 00:00 ago)`;
        row.InputBytes = row.InputBytes * 3 + 1e9;
        row.InputPackets = Math.max(1, row.InputPackets) * 3;
        row.InputBps = 0;
        return { clearedAt: row.StatisticsLastCleared };
    });

// Both devices answered and only one of them sees the other: LLDP off at one end, a one-way fibre pair,
// or a neighbour entry that has not aged out.
function injectLldpOneSided(rng, fleet) {
    const link = pickReciprocalLink(rng, fleet);
    if (!link) return null;
    link.peer.Neighbors = link.peer.Neighbors.filter(n => n !== link.back);
    const [anchorIp, anchorPort] = lowerEnd(link);
    return {
        kind: 'lldp-one-sided', failureModes: [], deviceIp: anchorIp, port: anchorPort, mac: null,
        params: { silentIp: String(link.peer.DeviceIP), silentPort: link.farPort,
                  peerIp: String(link.device.DeviceIP), peerPort: link.nearPort },
        expected: { finding: 'lldp-one-sided', deviceIp: anchorIp, port: anchorPort },
    };
}

// R9's sentinel: the switch answered the route query and nothing came out of the parser.
function injectRouteUnparsed(rng, fleet) {
    const hosts = scanned(fleet).filter(d => d.SectionsCaptured.includes('ROUTE') && d.DefaultRoute.NextHop);
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const previous = host.DefaultRoute.NextHop;
    host.DefaultRoute = {
        Table: 'inet.0', Destination: null, Protocol: null, Preference: null,
        NextHop: null, EgressInterface: null, State: 'Unparsed',
    };
    host.Gateway = 'Unparsed';
    return {
        kind: 'route-unparsed', failureModes: [], deviceIp: host.DeviceIP, port: null, mac: null,
        params: { previousNextHop: previous },
        expected: { finding: 'default-route-unreadable', deviceIp: host.DeviceIP, port: null },
    };
}

// A next hop on no subnet this device holds an address on: it cannot ARP for its own gateway. 192.0.2.0/24
// is documentation space and collides with nothing the fleet addresses out of.
function injectGatewayOffSubnet(rng, fleet) {
    const hosts = scanned(fleet).filter(d => d.DefaultRoute.NextHop && d.LogicalUnits.some(u => u.Family === 'inet'));
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const previous = host.DefaultRoute.NextHop;
    host.DefaultRoute.NextHop = `192.0.2.${fInt(rng, 2, 250)}`;
    host.Gateway = host.DefaultRoute.NextHop;
    return {
        kind: 'gateway-off-subnet', failureModes: [], deviceIp: host.DeviceIP, port: null, mac: null,
        params: { previousNextHop: previous, nextHop: host.DefaultRoute.NextHop },
        expected: { finding: 'gateway-not-on-a-local-subnet', deviceIp: host.DeviceIP, port: null },
    };
}

// The device's own L3 presence in a VLAN, enabled and down. No physical port's state says this.
function injectRoutedUnitDown(rng, fleet) {
    const hosts = scanned(fleet).filter(d => d.LogicalUnits.some(u => u.Family === 'inet' && u.Link === 'up'));
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const unit = fPick(rng, host.LogicalUnits.filter(u => u.Family === 'inet' && u.Link === 'up'));
    unit.Link = 'down';
    return {
        kind: 'routed-unit-down', failureModes: [], deviceIp: host.DeviceIP, port: null, mac: null,
        params: { parent: unit.Parent, unit: unit.Unit, address: unit.LocalAddress },
        expected: { finding: 'routed-unit-down', deviceIp: host.DeviceIP, port: null },
    };
}

// A neighbour naming a management address no device in the snapshot carries: a coverage gap, and the
// reason a path stops (F8) rather than crossing.
function injectUnscannedNeighbour(rng, fleet) {
    const known = new Set(fleet.map(d => String(d.DeviceIP)));
    const hosts = scanned(fleet).filter(d => clientPorts(d).length);
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const row = fPick(rng, clientPorts(host));
    let address = null;
    for (let i = 240; i > 200 && address === null; i--) {
        const candidate = `${String(host.DeviceIP).split('.').slice(0, 3).join('.')}.${i}`;
        if (!known.has(candidate)) address = candidate;
    }
    if (address === null) return null;
    host.Neighbors.push({
        LocalPort: `${row.Port}.0`, RemotePort: 'ge-0/0/0', Hostname: 'uw-unscanned-sw01.washington.edu',
        MacAddress: faultSwitchMac(rng), ManagementIP: address,
        Description: 'Juniper Networks, Inc. ex2300-24p',
        ...faultLldpCommon(rng, {}),
    });
    return {
        kind: 'neighbour-never-scanned', failureModes: ['F8'], deviceIp: host.DeviceIP, port: row.Port, mac: null,
        params: { farIp: address },
        expected: { finding: 'neighbour-never-scanned', deviceIp: host.DeviceIP, port: row.Port },
    };
}

// R5/F6. One bridge advertising Bridge capability and no management address - a switch nothing can
// scan. One end only: two ends of the same bridge are the shared segment above.
function injectAddresslessBridge(rng, fleet) {
    const hosts = scanned(fleet).filter(d => clientPorts(d).length);
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const row = fPick(rng, clientPorts(host));
    const mac = faultSwitchMac(rng);
    host.Neighbors.push({
        LocalPort: `${row.Port}.0`, RemotePort: '5', Hostname: 'Unknown',
        MacAddress: mac, ManagementIP: 'Unknown', Description: 'Unmanaged 5-port switch',
        ...faultLldpCommon(rng, { reachable: false }),
    });
    return {
        kind: 'bridge-without-address', failureModes: ['F6'], deviceIp: host.DeviceIP, port: row.Port, mac: mac,
        params: {},
        expected: { finding: 'bridge-without-management-address', deviceIp: host.DeviceIP, port: row.Port },
    };
}

// Section 5.3's fourth fleet edge: several MACs behind a port with no neighbour of any kind.
function injectInferredSegment(rng, fleet) {
    const med = (node) => new Set(node.MedNeighbors.map(m => physical(m.LocalPort)));
    const hosts = scanned(fleet).filter(d => d.Vlans.length && clientPorts(d).some(r => !med(d).has(r.Port)));
    if (!hosts.length) return null;
    const host = fPick(rng, hosts);
    const medPorts = med(host);
    const row = fPick(rng, clientPorts(host).filter(r => !medPorts.has(r.Port)));
    const vlan = (row.Vlans || [])[0] || host.Vlans[0];
    const macs = [];
    for (let i = 0; i < 4; i++) {
        const mac = faultClientMac(rng);
        macs.push(mac);
        host.MacTable.push({
            RoutingInstance: 'default-switch', VlanName: vlan.Name, MacAddress: mac,
            Flags: 'D', Age: null, Interface: `${row.Port}.0`, PhysicalPort: row.Port,
        });
    }
    claimMembership(host, row, vlan.Tag);
    return {
        kind: 'unrecorded-switch-behind-port', failureModes: ['F14'],
        deviceIp: host.DeviceIP, port: row.Port, mac: macs[0],
        params: { macCount: macs.length, vlanTag: vlan.Tag },
        expected: { finding: 'unmanaged-segment-inferred', deviceIp: host.DeviceIP, port: row.Port },
    };
}

const INJECTORS = [
    injectDuplicateMac, injectDuplicateIp, injectOffSubnetClient, injectDot1xHeld,
    injectStpUnconverged, injectAutonegAsymmetric, injectSharedSegment, injectVlanMissingFromTrunk,
    // The L1 rule family. Appended rather than interleaved so a given --faults N keeps injecting the
    // structural faults it injected before this landed.
    injectMtuMismatch, injectDuplexMismatch,
    injectDot1xState({ state: 'Failed', kind: 'dot1x-auth-failed', finding: 'dot1x-auth-failed' }),
    injectDot1xState({ state: 'Connecting', kind: 'dot1x-connecting', finding: 'dot1x-unauthenticated-traffic', sole: true }),
    ...L1_PORT_DEFECTS.map(injectPortDefect),
    // The L2 and L3 family, appended for the same reason.
    injectMacInWrongVlan, injectStpRoleConflict, injectStpScopeDrift, injectLldpOneSided,
    injectRouteUnparsed, injectGatewayOffSubnet, injectRoutedUnitDown,
    injectUnscannedNeighbour, injectAddresslessBridge, injectInferredSegment,
    // The rules the section 4.3 commands unblocked, appended for the same reason.
    injectNativeVlanMismatch, injectRecentTopologyChange, injectDot1xFallbackVlan,
    // G1's fault (item 16). It makes no finding, so it is last: a manifest reader meets the rule-backed
    // kinds first.
    injectMacLearnedOffPath,
    // port-last-used-spec.md section 9.3. Like the one above, these promise no finding - they promise a
    // STATE, checked by computeLastUsed rather than by the rule engine.
    injectNeverUsedPort, injectIdlePort, injectChatteringPort, injectActivePort,
    injectRebootedDevice, injectStatisticsCleared,
];

// G1's evidence, which the fixture did not have. A switch learns every MAC it FORWARDS, so a host three
// closets away is in every uplink's table between it and here - the measured capture holds 1,030 entries
// on one access switch. Without these rows the fixture asserted that a MAC exists only where its owner is
// plugged in, which is the same class of impossible topology as section 8.2's spanning tree: a path
// verifier reading it would find no evidence anywhere and could not be tested at fleet scale.
//
// Two constraints make a row real rather than decorative. It only propagates over a link BOTH ends
// forward on - a blocked leg carries no traffic and learns nothing - and only while both ends carry the
// MAC's VLAN, because a trunk that prunes the VLAN never sees the frame.
function applyTransitLearning(fleet) {
    const byIp = new Map(fleet.map(d => [String(d.DeviceIP), d]));
    const rowsOf = new Map(fleet.map(d => [d, new Map((d.Interfaces || []).map(r => [r.Port, r]))]));
    const learns = (device) => Array.isArray(device.MacTable)
        && (device.SectionsCaptured || []).includes('MAC_TABLE');
    const carries = (device, port, vlanName) => {
        const row = rowsOf.get(device).get(port);
        return !!row && (row.Vlans || []).some(v => v.Name === vlanName);
    };
    const forwarding = (device, port) => {
        const row = rowsOf.get(device).get(port);
        return !!row && row.STP === 'FWD' && String(row.Link).toLowerCase() === 'up';
    };

    // Forwarding adjacency, built once: ip -> [{ peer, localPort, peerPort }] over links both ends forward.
    const adjacency = new Map(fleet.map(d => [String(d.DeviceIP), []]));
    for (const l of switchLinksOf(fleet)) {
        if (!forwarding(l.a, l.aPort) || !forwarding(l.b, l.bPort)) continue;
        adjacency.get(String(l.a.DeviceIP)).push({ peer: l.b, localPort: l.aPort, peerPort: l.bPort });
        adjacency.get(String(l.b.DeviceIP)).push({ peer: l.a, localPort: l.bPort, peerPort: l.aPort });
    }

    // The rows each device already holds, so a MAC that is genuinely learned twice here is not doubled.
    const held = new Map(fleet.map(d => [d, new Set((d.MacTable || []).map(r => `${r.VlanName}|${String(r.MacAddress).toUpperCase()}`))]));
    const added = [];
    for (const origin of fleet) {
        if (!learns(origin)) continue;
        for (const seed of origin.MacTable.slice()) {
            const key = `${seed.VlanName}|${String(seed.MacAddress).toUpperCase()}`;
            // Breadth-first from the switch the host is plugged into, along the forwarding tree, stopping
            // wherever the VLAN stops. The port the row lands on is the one facing back toward the host,
            // which is what makes it evidence about DIRECTION rather than only about presence.
            const queue = [origin];
            const seen = new Set([String(origin.DeviceIP)]);
            while (queue.length) {
                const here = queue.shift();
                for (const step of adjacency.get(String(here.DeviceIP))) {
                    const peerIp = String(step.peer.DeviceIP);
                    if (seen.has(peerIp)) continue;
                    if (!carries(here, step.localPort, seed.VlanName)) continue;
                    if (!carries(step.peer, step.peerPort, seed.VlanName)) continue;
                    seen.add(peerIp);
                    if (!learns(step.peer)) continue;
                    if (!held.get(step.peer).has(key)) {
                        held.get(step.peer).add(key);
                        added.push([step.peer, {
                            RoutingInstance: 'default-switch',
                            VlanName: seed.VlanName, MacAddress: seed.MacAddress,
                            Flags: 'D', Age: null,
                            Interface: `${step.peerPort}.0`, PhysicalPort: step.peerPort,
                        }]);
                    }
                    queue.push(step.peer);
                }
            }
        }
    }
    // Appended after the walk so a row learned this pass cannot seed another: every sighting is derived
    // from a host's own access-port row, never from a transit copy of one.
    for (const [device, row] of added) device.MacTable.push(row);
    return added.length;
}

function injectFaults(fleet, snapshotIndex, count) {
    // Derived from the seed rather than taken from it, so two snapshots of one run do not inject the
    // same faults in the same places.
    const rng = makeRng((Math.imul(SEED, 0x9E3779B9) + snapshotIndex * 0x85EBCA6B) >>> 0);
    const manifest = [];
    CLAIMED_PORTS.clear();
    for (let n = 0; n < count; n++) {
        const injector = INJECTORS[n % INJECTORS.length];
        const entry = injector(rng, fleet);
        // A fleet too small to hold the fault, not an error: a 4-device run has no second host for a
        // duplicate MAC, and a manifest that claims one would be the lie this whole file avoids.
        if (entry) {
            manifest.push({ id: `${snapshotIndex}-${manifest.length + 1}-${entry.kind}`, ...entry });
            claimEntry(entry);
        }
    }
    return manifest;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const written = [];
for (let i = 0; i < SNAPSHOT_COUNT; i++) {
    // Oldest first, so each snapshot is written from the fleet as the previous one left it.
    const daysBack = SNAPSHOT_COUNT - 1 - i;
    if (i > 0) { ageFleet(daysBack + 1); assertNothingOrphaned(topology); }
    const scanTime = new Date(SCAN_DATE.getTime() - daysBack * 86400000);
    const stamp = scanTime.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
    // NetworkMap_* so the loaders pick it up, .fixture.json so it can be gitignored separately.
    const mapPath = path.join(OUT_DIR, `NetworkMap_${stamp}.fixture.json`);
    // Before withFailures, not after: every device is a bridge whether or not our ssh reached it, and
    // the pass mutates the interface rows withFailures is about to clone.
    const tree = computeSpanningTree(topology);
    assertForwardingIsSpanningTree(topology);
    // After the tree, because the "*" marking a member as currently forwarding for a VLAN follows it.
    applyVlanMembership(topology);
    applyPortDetail(topology, i, scanTime);
    const fleet = withFailures(topology, i, scanTime);
    // After withFailures, because it is the pass that blanks a truncated device's MAC table: learning
    // into one and then blanking it would be the same fiction the other way round.
    applyTransitLearning(fleet);
    const manifest = injectFaults(fleet, i, FAULT_COUNT);
    fs.writeFileSync(mapPath, JSON.stringify({ Topology: fleet, ScanTimestamp: scanTime.toISOString() }));
    // Not NetworkMap_*: both loaders match /^NetworkMap_.*\.json$/, so a manifest named after its map
    // would be offered as a snapshot to open.
    // Written on every run, empty at --faults 0: a manifest that describes every snapshot is a
    // contract, and one that appears only sometimes would leave a stale file from an earlier run
    // describing faults this one did not inject.
    const manifestPath = path.join(OUT_DIR, `FaultManifest_${stamp}.fixture.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({
        Map: path.basename(mapPath), ScanTimestamp: scanTime.toISOString(),
        Seed: SEED, Requested: FAULT_COUNT, Faults: manifest,
    }, null, 2));
    written.push({ mapPath, fleet, tree, manifest });
}

const FIXTURE_CONFIG = {
    devices: configDevices,
    credentials: { username: 'fixture-user', password: 'fixture-password' },
    settings: {
        cpuWarnPct: 70, cpuCriticalPct: 90, memWarnPct: 75, memCriticalPct: 90,
        crawlAgeFreshMin: 60, crawlAgeStaleMin: 1440, recentRebootMin: 60,
        clusterThreshold: 50, nodeSpacing: 350, leafSpacing: 250, minRadius: 250,
        // The fleet's own prefixes, so a fresh clone can crawl and rescan the fixture immediately.
        allowedScopes: CAMPUS.map(z => `10.${z.net}.`),
    },
};

// Kept as the canonical record of what this run placed, and as the source the refresh below copies
// from. Named .fixture.json so it can be gitignored separately from a real config.
const configPath = path.join(OUT_DIR, 'Configuration.fixture.json');
fs.writeFileSync(configPath, JSON.stringify(FIXTURE_CONFIG, null, 2));

for (const { mapPath, fleet, tree, manifest } of written) {
    const c = fleet.reduce((a, d) => {
        a.interfaces += d.Interfaces.length; a.clients += d.Clients.length;
        a.arp += d.ArpEntries.length; a.neighbors += d.Neighbors.length;
        a.members += d.StackMembers.length; a.med += d.MedNeighbors.length;
        if (d.ScanStatus !== 'Ok') a.failed++;
        if (d.StackMembers.length > 1) a.stacks++;
        for (const r of d.Interfaces) {
            if (r.STP === 'FWD') a.fwd++; else if (r.STP === 'BLK') a.blk++;
        }
        return a;
    }, { interfaces: 0, clients: 0, arp: 0, neighbors: 0, members: 0, med: 0, failed: 0, stacks: 0, fwd: 0, blk: 0 });
    process.stderr.write(
        `${mapPath}\n  ${fleet.length} devices (${c.stacks} virtual chassis, ${c.members} members, ${c.failed} failed scans)\n` +
        `  ${c.interfaces} interfaces, ${c.neighbors} LLDP neighbours, ${c.clients} clients, ${c.arp} ARP entries, ${c.med} MED endpoints\n` +
        `  spanning tree: root ${tree.rootLabel}, ${c.fwd} FWD / ${c.blk} BLK ports\n` +
        (FAULT_COUNT ? `  injected faults: ${manifest.length} of ${FAULT_COUNT} requested (${manifest.map(f => f.kind).join(', ') || 'none placeable'})\n` : '') +
        `  ${(fs.statSync(mapPath).size / 1048576).toFixed(1)} MiB\n`
    );
}
process.stderr.write(
    `${configPath}\n  ${configDevices.length} placed devices in ${ALL_BUILDINGS.length} buildings ` +
    `across ${CAMPUS.length} campus zones, seed ${SEED}\n`
);

// The visualizer reads Configuration.json, not the .fixture.json beside the maps, so a fixture whose
// placements aren't copied over resolves every serial against the PREVIOUS fleet's buildings and
// every pin lands on the wrong building. Refreshed here rather than left to the operator.
//
// Only ever this path: Start-NetworkMapper reads Configuration.json under -NoEncryption alone, so a
// real encrypted Configuration.json.enc is never touched or shadowed by what is written here.
const serverConfigPath = path.join(OUT_DIR, '..', 'Configuration.json');
const isFixtureKey = d => /^SYN\d+$/.test(String(d && d.key));

// Keyed on the directory name rather than the default path, so a test harness or a second checkout
// laid out the same way still gets the refresh: it is the "Network_Maps beside a Configuration.json"
// shape that makes the sibling ours to write. A bare --out /tmp/maps does not, and its parent has no
// business gaining a Configuration.json.
if (path.basename(OUT_DIR) !== path.basename(DEFAULT_OUT_DIR)) {
    process.stderr.write(`\nNOTE: --out is not a Network_Maps directory, so no Configuration.json was written.\n  Placements for this fleet are in ${configPath}.\n`);
} else if (!fs.existsSync(serverConfigPath)) {
    fs.writeFileSync(serverConfigPath, JSON.stringify(FIXTURE_CONFIG, null, 2));
    process.stderr.write(`\n${serverConfigPath}\n  written: fixture credentials, scopes and ${configDevices.length} placements\n`);
} else {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(serverConfigPath, 'utf8')); } catch (err) { /* not ours to read */ }
    const placed = existing && Array.isArray(existing.devices) ? existing.devices : null;
    // A real operator's placements and credentials are never ours to overwrite, so the refresh is
    // gated on the file holding nothing but fixture output: all-SYN keys, or no placements at all
    // under a login we recognize as the fixture's own.
    const onlyFixture = placed !== null && (
        (placed.length > 0 && placed.every(isFixtureKey)) ||
        (placed.length === 0 && (!existing.credentials || !existing.credentials.username || existing.credentials.username === FIXTURE_CONFIG.credentials.username))
    );

    if (onlyFixture) {
        // Only .devices: an operator testing against the fixture may have set their own thresholds,
        // scopes or login in the viewer, and regenerating a fleet is no reason to discard them.
        existing.devices = configDevices;
        fs.writeFileSync(serverConfigPath, JSON.stringify(existing, null, 2));
        process.stderr.write(`\n${serverConfigPath}\n  refreshed: ${configDevices.length} placements (credentials and settings left alone)\n`);
    } else {
        process.stderr.write(
            `\nNOTE: ${serverConfigPath} holds placements that are not this generator's, so it was left\n` +
            `  untouched. The app reads that file, so fixture pins will show on the wrong building until\n` +
            `  its .devices are replaced with those in ${configPath}.\n`
        );
    }
}
