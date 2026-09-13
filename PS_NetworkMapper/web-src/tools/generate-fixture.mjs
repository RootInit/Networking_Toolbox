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

// mulberry32: a fixture must be reproducible from --seed alone, so never reach for Math.random().
let seedState = SEED >>> 0;
function rnd() {
    seedState = (seedState + 0x6D2B79F5) >>> 0;
    let t = seedState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
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
        // R9/R8. A node that never answered has no route and no inventory to report.
        DefaultRoute: {}, ChassisInventory: [], LogicalUnits: [],
    };
}

// The $DataDict keys of Get-JunosNodeData.ps1, in the order the batch issues the commands. The order
// is what makes a truncated capture realistic: a timed-out session loses its TAIL, and the worker
// deliberately asks for "show interfaces extensive" last because it is the largest.
const CAPTURE_SECTIONS = [
    'VERSION', 'VIRTUAL_CHASSIS', 'CHASSIS_HARDWARE', 'ROUTE', 'INTERFACES_TERSE',
    'INTERFACES_DESC', 'STP', 'POE', 'DOT1X', 'LLDP', 'VLANS', 'MAC_TABLE', 'ARP_TABLE',
    'UPTIME', 'ALARMS', 'ROUTING_ENGINE', 'CONFIG', 'INTERFACES_EXT',
];

// Dropping a section has to drop what that section supplies, or the fixture asserts a state no real
// switch can produce (see spec 8.2) and every rule tested against it inherits the contradiction.
const SECTION_SUPPLIES = {
    CONFIG: (node) => { node.Configuration = 'Unknown'; },
    ROUTING_ENGINE: (node) => { node.MasterCpuUtilization = 'Unknown'; node.MasterMemoryUtilization = 'Unknown'; },
    // INTERFACES_EXT supplies only fields accessRow does not emit yet (ACCESS_ROW_GAP in
    // test/fixture.test.mjs). When that gap closes, this must blank them here too.
    INTERFACES_EXT: () => {},
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
    // One MAC aged-in on a second port is what duplicate-MAC detection looks for, and a fixture
    // without one lets a rule that never fires pass its own test.
    if (rows.length > 2 && chance(0.2)) {
        const moved = rows[int(0, rows.length - 1)];
        const elsewhere = rows.find(r => r.PhysicalPort !== moved.PhysicalPort);
        if (elsewhere) {
            rows.push({ ...moved, Interface: `${elsewhere.PhysicalPort}.0`, PhysicalPort: elsewhere.PhysicalPort });
        }
    }
    return rows;
}

// R12 + R15, applied per snapshot because both depend on when that snapshot was taken.
function stampCapture(node, scanTime) {
    // A fleet crawl spans minutes and scanTime is when the snapshot was written, so each device was
    // read somewhere in the window before it. That spread is the whole point of R12: one
    // ScanTimestamp is too coarse to compare counters or last-seen times across devices.
    node.CaptureTimestamp = new Date(scanTime.getTime() - int(0, 14 * 60000)).toISOString();
    node.MacTable = buildMacTable(node);
    // R9. Every scanned device reached its gateway, so the route parsed; "Unparsed" is the state a
    // parser bug produces, not something a healthy fixture should claim.
    node.DefaultRoute = {
        Table: 'inet.0', Destination: '0.0.0.0/0', Protocol: 'Static', Preference: 5,
        NextHop: node.Gateway, EgressInterface: 'irb.100', State: 'Parsed',
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
    for (const name of CAPTURE_SECTIONS.slice(CAPTURE_SECTIONS.length - dropped)) {
        if (SECTION_SUPPLIES[name]) SECTION_SUPPLIES[name](node);
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
        PoE: poe ? (live && chance(0.5) ? `Delivering (${(rnd() * 25 + 3).toFixed(1)}W)` : 'Enabled') : 'Unknown',
        // The sort needs a spread across the 72h/6-month bands plus a slice with no value at all.
        LastFlappedSeconds: live ? int(60, 72 * 3600)
            : chance(0.15) ? null
                : chance(0.5) ? int(72 * 3600, 182 * 86400) : int(182 * 86400, 900 * 86400),
        // C5. Why LastFlappedSeconds is null. "Never" is the healthy state - the port has not flapped
        // since boot - and read identically to a duration the parser could not decode.
        LastFlappedState: null,
    };
    setFlap(row, row.LastFlappedSeconds);
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

// R2/R2b/R13/R5. The fields every LLDP neighbour row carries, switch or endpoint. Omitting them here
// is how the fixture silently stops matching production shape, so both neighbour builders use this.
function lldpCommon({ reachable = true, med = null } = {}) {
    return {
        Reachable: reachable,
        // R2. 802.3 TLVs. Autoneg disabled on a live link is the defect this exists to expose.
        OrgInfo: [
            { OUI: '00-12-0f', Subtype: 'MAC/PHY Configuration/Status (1)', Info: chance(0.25) ? 'Autonegotiation disabled, 1000BaseTFD' : 'Autonegotiation enabled, 1000BaseTFD' },
            { OUI: '00-12-0f', Subtype: 'Maximum Frame Size (4)', Info: pick(['1518', '9216']) },
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
    const stamp = (from, to, localPort, remotePort) => {
        from.Neighbors.push({
            LocalPort: localPort, RemotePort: remotePort, Hostname: to.Hostname,
            MacAddress: to.bridgeMac, ManagementIP: to.DeviceIP,
            Description: `Juniper Networks, Inc. ${to.StackMembers[0].Model.toLowerCase()}`,
            ...lldpCommon(),
        });
        const row = byPort(from).get(localPort);
        // STP is not set here: computeSpanningTree decides it once every link exists.
        if (row) { row.Link = 'up'; row.Admin = 'up'; setFlap(row, int(3600, 90 * 86400)); row.Desc = `${descPrefix} to ${to.Hostname.replace('.local', '')}`; }
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
            node.MedNeighbors.push({
                LocalPort: row.Port, Hostname: row.Desc, MacAddress: first.MAC,
                ManagementIP: first.IP === 'Unknown' ? `10.${node.zone.net}.${int(100, 240)}.${int(2, 250)}` : first.IP,
                Description: isAp ? 'Wireless Access Point' : 'IP Phone',
                Class: isAp ? 'Class III' : 'Class II',
                ...lldpCommon({ med: isAp ? MED_AP : MED_PHONE }),
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
    if (gatewayNode) gatewayNode.ArpEntries.push({ MAC: mac, IP: clientIp });
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
    // A device that never answered is not a bridge we can hear BPDUs from, and neither is an R5
    // unmanaged neighbour: ports facing them stay Designated, which is what a real switch shows.
    const bridges = fleet.filter(d => d.ScanStatus === 'Ok');
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

    const assign = (device, port, role, state, designatedBridge, designatedPortId) => {
        const row = byPort(device)?.get(port);
        if (!row) return;
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
                assign(d, l.localPort, 'Root', 'FWD', bridgeId(l.peer), theirPortId);
                assign(l.peer, l.peerPort, 'Designated', 'FWD', bridgeId(l.peer), theirPortId);
            } else if (theyAreDownstream) {
                assign(l.peer, l.peerPort, 'Root', 'FWD', bridgeId(d), myPortId);
                assign(d, l.localPort, 'Designated', 'FWD', bridgeId(d), myPortId);
            } else {
                // Neither end is on its own least-cost path: this link is the redundant one that has to
                // block, and the better bridge keeps the Designated end.
                const myCost = rootCost.has(ip) ? rootCost.get(ip) : Infinity;
                const theirCost = rootCost.has(String(l.peer.DeviceIP)) ? rootCost.get(String(l.peer.DeviceIP)) : Infinity;
                const iWin = (myCost - theirCost || compareBridges(d, l.peer)) < 0;
                const winner = iWin ? d : l.peer;
                const winnerPortId = iWin ? myPortId : theirPortId;
                assign(winner, iWin ? l.localPort : l.peerPort, 'Designated', 'FWD', bridgeId(winner), winnerPortId);
                assign(iWin ? l.peer : d, iWin ? l.peerPort : l.localPort, 'Alternate', 'BLK', bridgeId(winner), winnerPortId);
            }
        }
    }

    // Every remaining port faces an endpoint, an unreachable device, or nothing at all. A down port is
    // Disabled: a switch reports no role for a link it does not have.
    for (const d of bridges) {
        for (const row of d.Interfaces) {
            if (row.StpDetail) continue;
            const up = String(row.Link).toLowerCase() === 'up';
            assign(d, row.Port, up ? 'Designated' : 'Disabled', up ? 'FWD' : 'DIS', bridgeId(d),
                portIdOf.get(String(d.DeviceIP)).get(row.Port) || null);
        }
    }
    const rootLabel = `${root.Hostname} (${bridgeId(root)})`;
    // withFailures hands this function CLONES, which is what gets serialized, so the identity fields the
    // election needs cannot be in withFailures' SCRATCH list - they are dropped here instead. byPort's
    // memo is a Map and would serialize as a stray {} key.
    for (const d of fleet) {
        delete d.bridgeMac;
        delete d.bridgePriority;
        delete d._byPort;
    }
    return { rootLabel: rootLabel, rootCost: rootCost, rootPort: rootPort };
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
assertNothingOrphaned(topology);

const gatewayFor = (node) => (node.role === 'ACC' ? topology.find(d => d.DeviceIP === node.Gateway) : cores[0]);

for (const node of topology) {
    const vlanTags = shuffled(VLANS.map(v => v.tag)).slice(0, int(2, 5));
    if (node.role === 'ACC') addClients(node, gatewayFor(node), vlanTags);
    const extra = [];
    if (node.role !== 'ACC') extra.push(`set protocols rstp bridge-priority ${node.role === 'CORE' ? '4k' : '8k'}`);
    if (chance(0.3)) extra.push('set system services netconf ssh');
    if (chance(0.2)) extra.push(`set interfaces ${node.Interfaces[0].Port} description "${node.bldg.abbr} patch"`);
    node.Configuration = configText(node.Hostname, node.zone, node.bldg, vlanTags, extra);
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
    for (const node of shuffled(topology).slice(0, int(2, 5))) node.Uptime = iso(daysAgo(rnd() * days));
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
    const arrivalVlans = shuffled(VLANS.map(v => v.tag)).slice(0, 3);
    arrival.Configuration = configText(arrival.Hostname, bldg.zone, bldg, arrivalVlans, []);
    addClients(arrival, parent, arrivalVlans);
    linkDevices(arrival, parent, 'UPLINK');
    topology.push(arrival);
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
    const SCRATCH = ['zone', 'bldg', 'role', '_freeUplinks', '_byPort'];
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
        stampCapture(copy, scanTime);
        return copy;
    });
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
    const fleet = withFailures(topology, i, scanTime);
    // After withFailures, so a device that did not answer in THIS snapshot is not a bridge in its tree,
    // and before the write, since the pass mutates the interface rows it is about to serialize.
    const tree = computeSpanningTree(fleet);
    fs.writeFileSync(mapPath, JSON.stringify({ Topology: fleet, ScanTimestamp: scanTime.toISOString() }));
    written.push({ mapPath, fleet, tree });
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

for (const { mapPath, fleet, tree } of written) {
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
