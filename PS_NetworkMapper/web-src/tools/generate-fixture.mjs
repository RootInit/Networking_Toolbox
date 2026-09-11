// Generates a synthetic but structurally realistic topology snapshot for testing the
// visualizer at fleet scale, plus a matching Configuration file so the geographic Map and the
// dashboard thresholds have something to show. Not part of the app - run manually:
//   node tools/generate-fixture.mjs                       # 350 devices -> ../Network_Maps/
//   node tools/generate-fixture.mjs --devices 1500 --seed 7 --out /tmp/maps
//   node tools/generate-fixture.mjs --snapshots 6         # six daily crawls of one fleet
//   node tools/generate-fixture.mjs --now                 # stamp it as a scan that just ran
//
// Port lists are scraped from chassis.js's own artwork rather than written out here, so a
// device's Interfaces always match what its faceplate draws. That keeps the fixture honest as
// the catalogue grows: a new model is covered the moment it is added, and a model whose art
// stops matching its port names fails the fixture's own assertions instead of silently
// rendering as an inferred panel.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Chassis from '../chassis.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- CLI ---------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i === -1 ? fallback : argv[i + 1];
};
const DEVICE_COUNT = Math.max(4, parseInt(flag('devices', '350'), 10));
const SEED = parseInt(flag('seed', '1'), 10);
// Successive daily crawls of the same fleet. The dashboard's Trends, Topology Diff, New Devices
// and Config Changed tabs all read differences between snapshots and stay empty with only one.
const SNAPSHOT_COUNT = Math.max(1, parseInt(flag('snapshots', '3'), 10));
const OUT_DIR = path.resolve(flag('out', path.join(HERE, '..', '..', 'Network_Maps')));

/* ---------------- deterministic randomness ---------------- */

// mulberry32: a whole fixture has to be reproducible from --seed alone, so nothing may reach
// for Math.random(). Any run with the same flags must produce a byte-identical file, or a
// visual regression can't be told apart from a different roll of the dice.
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

/* ---------------- port lists, scraped from the catalogue art ---------------- */

const PORT_RE = /^([a-z]+)-(\d+)\/(\d+)\/(\d+)$/;
const renumber = (name, fpc) => name.replace(PORT_RE, (_, pfx, _f, pic, n) => `${pfx}-${fpc}/${pic}/${n}`);

// An uplink module bay draws a blank cover until the switch reports something in it, so a face
// scraped from an empty device hides its module ports. Offering these candidates reveals which
// ones the bay actually accepts; a model with no bay simply binds none of them.
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
    // A modular chassis, or a model the catalogue has no art for, carries a note instead of a
    // drawing - and so has no ports to scrape.
    for (const m of (member.html || '').matchAll(/id="(port|uplink)_[^"]*"[^>]*data-port="([^"]+)"/g)) {
        (m[1] === 'port' ? jacks : cages).push(m[2]);
    }
    return { member, jacks, cages };
};

const portCache = new Map();
// { jacks, cages, module } for one model: jacks are fixed copper (their prefix is evidence, so
// the fixture must never vary it), cages are pluggable (the fixture varies the optic there on
// purpose, which is exactly what the binding logic exists to survive).
function portsFor(model) {
    if (portCache.has(model)) return portCache.get(model);
    const base = scrape([], model);
    // A modular chassis has no drawing, but the crawler still reports its ports - the missing
    // art is a rendering decision, not missing scan data, and a device with no interfaces at all
    // would exercise the wrong empty-state.
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

/* ---------------- fleet shape ---------------- */

const CORE_MODELS = ['QFX5120-32C', 'QFX5200-32C'];
const DIST_MODELS = ['EX4600-40F', 'EX4650-48Y', 'QFX5120-48Y', 'EX4300-32F'];
const ACCESS_MODELS = [
    'EX2300-48P', 'EX2300-24P', 'EX2300-48T', 'EX3400-48P', 'EX3400-24P',
    'EX4300-48P', 'EX4300-48T', 'EX4300-48MP', 'EX4400-48P', 'EX4400-24P',
    'EX4100-48P', 'EX4100-24T', 'EX4000-48P', 'EX2300-C-12P', 'EX4100-F-12P',
    'EX2200-48P', 'EX3300-48P', 'EX4200-48P',
];
// A real fleet has a chassis or two the drawing code deliberately refuses to draw. Keeping one
// in the fixture means the "no front-panel drawing" path is never rendered for the first time
// in production.
const MODULAR_MODEL = 'EX9200-32XS';

// University of Washington, Seattle campus, in the five zones the university itself uses.
//
// lat/lng is each building's pole of inaccessibility - the interior point furthest from any
// exterior wall - taken from its OpenStreetMap footprint, and `r` is how far a closet may sit
// from it and still be indoors. A plain centroid is not good enough: many of these are L- or
// U-shaped and their centroid falls in a courtyard or on the lawn. Madrona and Willow Hall are
// real North Campus halls that OSM does not carry, so two neighbouring halls it does carry
// stand in for them; every name here resolves to a footprint you can see on the tiles.
//
// `closets` is how many wiring closets a building rates, which is what makes a medical centre
// carry more switches than a residence hall. `hub` marks the building whose main distribution
// frame feeds the zone.
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

const VLANS = [
    { tag: '10', name: 'VLAN_MGMT' }, { tag: '20', name: 'VLAN_STAFF' },
    { tag: '30', name: 'VLAN_STUDENT' }, { tag: '100', name: 'VLAN_VOICE' },
    { tag: '300', name: 'VLAN_WIFI' }, { tag: '400', name: 'VLAN_PRINTERS' },
    { tag: '500', name: 'VLAN_CAMERAS' }, { tag: '666', name: 'VLAN_QUARANTINE' },
];

const JUNOS_VERSIONS = ['21.4R3-S5.4', '22.2R3-S3.8', '22.4R3.25', '23.2R2-S1.5', '20.4R3-S9.2'];
// Everything but Ok is a placeholder node: FleetCrawl records the device it could not read, so
// the visualizer must cope with a device that has a status and nothing else.
const FAILURE_STATUSES = ['Unreachable', 'AuthFailed', 'Timeout', 'Aborted', 'ParseError'];
const FAILURE_TEXT = {
    Unreachable: 'ssh: connect to host {ip} port 22: Connection timed out',
    AuthFailed: 'Permission denied (publickey,password) for user svc-mapper',
    Timeout: 'TIMEOUT on interactive batch after 120s; partial payload discarded',
    Aborted: 'Crawl aborted by circuit breaker while this job was in flight',
    ParseError: 'Switch returned empty payload [exit=255 elapsed=5.1s timedOut=False]',
};

/* ---------------- value generators ---------------- */

// Fixed by default so a run is reproducible byte for byte; --now anchors the snapshot to the
// present instead, which is what the crawl-age badge and the activity lens's elapsed-time
// correction need in order to read as fresh.
const SCAN_DATE = argv.includes('--now') ? new Date() : new Date('2026-09-08T14:32:07Z');
const iso = (d) => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const daysAgo = (n) => new Date(SCAN_DATE.getTime() - n * 86400000);

const hexByte = () => int(0, 255).toString(16).padStart(2, '0');
const clientMac = () => ['aa', 'bb', hexByte(), hexByte(), hexByte(), hexByte()].join(':');
const switchMac = () => ['02', 'ab', hexByte(), hexByte(), hexByte(), hexByte()].join(':').toUpperCase();

// Straddles cpuWarnPct/cpuCriticalPct (70/90) and memWarnPct/memCriticalPct (75/90) from
// Configuration.example.json, so every dashboard severity band is populated.
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

/* ---------------- device construction ---------------- */

let serialCounter = 10000;
const nextSerial = () => `SYN${++serialCounter}`;

// A /24 per building inside a /16 per zone, which is how a campus of this size is actually
// addressed - and it gives the IP Space tab subnets that mean something geographically.
const ipFor = (bldg, host) => `10.${bldg.zone.net}.${bldg.idx}.${host}`;

// Metres between two campus buildings, near enough at this latitude. Used to attach a closet to
// the distribution frame it would really be patched to - the nearest one - rather than to
// whichever switch came next in a loop.
function metresBetween(a, b) {
    const dLat = (a.lat - b.lat) * 111320;
    const dLng = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
}
const nearest = (bldg, candidates) =>
    candidates.reduce((best, d) => (metresBetween(bldg, d.bldg) < metresBetween(bldg, best.bldg) ? d : best));
// You patch to the nearest frame that still has a port free; a full one is simply not a
// candidate, however close it is.
const nearestWithPort = (bldg, candidates) => {
    const free = candidates.filter(d => freeUplinks(d).length > 0);
    return free.length ? nearest(bldg, free) : null;
};

// The full key set of Get-JunosNodeData.ps1's $NodeData initializer. A device missing one of
// these reaches the UI as `undefined` rather than as the "Unknown" the crawler would have
// written, so the two must stay in step - test/fixture.test.mjs pins this against the
// PowerShell source.
function blankNode(deviceIp) {
    return {
        DeviceIP: deviceIp, Hostname: 'Unknown', JunosVersion: 'Unknown', Gateway: 'Unknown',
        StackMembers: [], Neighbors: [], Clients: [], ArpEntries: [], Interfaces: [],
        Uptime: 'Unknown', LastConfigured: 'Unknown', LastConfiguredBy: 'Unknown', Alarms: [],
        MasterCpuUtilization: 'Unknown', MasterMemoryUtilization: 'Unknown', MedNeighbors: [],
        Configuration: 'Unknown', ScanStatus: 'Ok', ScanError: null,
    };
}

const AP_DESC = n => `AP-${1000 + n}`;
const PHONE_DESC = n => `PHONE-${2000 + n}`;

// One interface row per port the faceplate draws. Uplinks that carry a neighbour are filled in
// later by linkDevices, which needs both endpoints' port lists to exist first.
function buildInterfaces(device, members) {
    const rows = [];
    for (const m of members) {
        const p = portsFor(m.Model);
        const fpc = parseInt(m.FPC, 10);
        const poe = /-\d+(P|MP)$/i.test(m.Model);
        for (const jack of p.jacks) rows.push(accessRow(renumber(jack, fpc), poe, false));
        for (const cage of p.cages) rows.push(accessRow(renumber(cage, fpc), false, true));
        // Only some chassis have a module fitted; an empty bay is the commoner state and draws
        // a cover, which is its own rendering path.
        if (p.module.length && chance(0.55)) {
            const fitted = p.module.filter(x => x.includes(`/${p.module[0].split('/')[1]}/`));
            for (const mod of fitted) rows.push(accessRow(renumber(mod, fpc), false, true));
        }
    }
    device.Interfaces = rows.sort((a, b) => a.Port.localeCompare(b.Port));
}

function accessRow(port, poe, isCage) {
    // A cage names itself after the optic fitted, not the cage type, so a fixture that always
    // emitted the catalogue's own prefix would never exercise the sibling-binding path.
    if (isCage && chance(0.25)) port = port.replace(PORT_RE, (_, pfx, f2, pic, n) => `${pick(['ge', 'xe', 'et'])}-${f2}/${pic}/${n}`);
    const live = chance(0.42);
    const row = {
        Port: port,
        Admin: live || chance(0.9) ? 'up' : 'down',
        Link: live ? 'up' : 'down',
        Desc: 'Unknown',
        STP: live ? (chance(0.9) ? 'FWD' : 'BLK') : 'Unknown',
        PoE: poe ? (live && chance(0.5) ? `Delivering (${(rnd() * 25 + 3).toFixed(1)}W)` : 'Enabled') : 'Unknown',
        // The "longest inactive" sort needs a spread that crosses the activity lens's 72h and
        // 6-month thresholds, and a slice with no value at all - an unparseable "Last flapped"
        // leaves this null and must drop out of the sort rather than sort as zero.
        LastFlappedSeconds: live ? int(60, 72 * 3600)
            : chance(0.15) ? null
                : chance(0.5) ? int(72 * 3600, 182 * 86400) : int(182 * 86400, 900 * 86400),
    };
    if (live && chance(0.35)) row.Desc = chance(0.5) ? AP_DESC(int(1, 400)) : PHONE_DESC(int(1, 900));
    return row;
}

function makeDevice({ deviceIp, bldg, seq, models, role, gateway }) {
    const node = blankNode(deviceIp);
    // Building abbreviation first, the way campus network gear is normally named: the hostname
    // alone tells you which closet to walk to.
    node.Hostname = `uw-${bldg.abbr.toLowerCase()}-${role.toLowerCase()}${String(seq).padStart(2, '0')}.washington.edu`;
    node.JunosVersion = pick(JUNOS_VERSIONS);
    node.Gateway = gateway;
    node.StackMembers = models.map((model, i) => ({
        FPC: String(i),
        Model: model,
        Serial: nextSerial(),
        Role: models.length === 1 ? 'Standalone' : i === 0 ? 'Master' : i === 1 ? 'Backup' : 'Linecard',
    }));
    node.MasterCpuUtilization = cpuValue();
    node.MasterMemoryUtilization = memValue();
    // A handful of recent boots so the reboot badge has something to flag; the rest span years,
    // which is what a real fleet's uptime distribution looks like.
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
    return node;
}

/* ---------------- linking ---------------- */

// Free uplink cages, in the order the art draws them, so links land on ports a real
// installation would patch first.
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

// LLDP is symmetric: both ends report the link, from their own side. An asymmetric fixture
// hides every bug in the edge-deduplication and primary-tree code, which is most of what the
// diagram does.
function linkDevices(a, b, descPrefix) {
    const pa = freeUplinks(a).shift();
    const pb = freeUplinks(b).shift();
    if (!pa || !pb) return false;
    const stamp = (from, to, localPort, remotePort) => {
        from.Neighbors.push({
            LocalPort: localPort, RemotePort: remotePort, Hostname: to.Hostname,
            MacAddress: switchMac(), ManagementIP: to.DeviceIP,
            Description: `Juniper Networks, Inc. ${to.StackMembers[0].Model.toLowerCase()}`,
        });
        const row = byPort(from).get(localPort);
        if (row) { row.Link = 'up'; row.Admin = 'up'; row.STP = 'FWD'; row.LastFlappedSeconds = int(3600, 90 * 86400); row.Desc = `${descPrefix} to ${to.Hostname.replace('.local', '')}`; }
    };
    stamp(a, b, pa, pb);
    stamp(b, a, pb, pa);
    return true;
}

/* ---------------- endpoints ---------------- */

// A client's MAC-table entry usually sits on the access switch while its ARP entry sits on the
// L3 gateway, so the crawler backfills IP from a fleet-wide MAC->IP map. Emitting the halves on
// different devices is the only way that correlation is exercised at all.
function addClients(node, gatewayNode, vlanTags) {
    const accessPorts = node.Interfaces.filter(r => r.Link === 'up' && !r.Desc.startsWith('TRUNK') && !r.Desc.startsWith('UPLINK'));
    const dataTags = vlanTags.filter(t => t !== '100');
    for (const row of shuffled(accessPorts).slice(0, Math.min(accessPorts.length, int(2, 14)))) {
        const isPhone = row.Desc.startsWith('PHONE-');
        const isAp = row.Desc.startsWith('AP-');
        const first = addClient(node, gatewayNode, row, isPhone ? '100' : pick(vlanTags));
        if (isPhone || isAp) {
            node.MedNeighbors.push({
                LocalPort: row.Port, Hostname: row.Desc, MacAddress: first.MAC,
                ManagementIP: first.IP === 'Unknown' ? `10.${node.zone.net}.${int(100, 240)}.${int(2, 250)}` : first.IP,
                Description: isAp ? 'Wireless Access Point' : 'IP Phone',
                Class: isAp ? 'Class III' : 'Class II',
            });
        }
        // Daisy chains are detected from two MACs on one physical port, and the confidence the
        // badge shows depends on whether LLDP-MED saw a phone there and on whether the two sit
        // in different VLANs. All three verdicts need to occur, or two thirds of that code is
        // only ever exercised by unit tests.
        if (isPhone && dataTags.length && chance(0.7)) addClient(node, gatewayNode, row, pick(dataTags));   // confirmed
        else if (!isPhone && dataTags.length > 1 && chance(0.04)) addClient(node, gatewayNode, row, pick(dataTags)); // likely
        else if (!isPhone && chance(0.03)) addClient(node, gatewayNode, row, first.VLAN_Tag);               // possible
    }
}

// Dot1x_State is read three ways: "Unknown" means dot1x was never observed, "Authenticated"
// means it passed, and anything else counts as a violation on the dashboard. A fixture with
// only the first two leaves that tile permanently at zero.
const DOT1X_FAILURES = ['Held', 'Connecting', 'Failed', 'Force-Unauthorized'];

function addClient(node, gatewayNode, row, tag) {
    const vlan = VLANS.find(v => v.tag === tag);
    const mac = clientMac();
    const clientIp = `10.${node.zone.net}.${int(100, 240)}.${int(2, 250)}`;
    const dot1x = chance(0.35);
    const client = {
        // Left unresolved more often than not: a client's ARP entry usually lives on the L3
        // gateway rather than on the access switch that learned its MAC, and the crawler's
        // fleet-wide MAC->IP backfill is what closes the gap.
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

/* ---------------- assemble the fleet ---------------- */

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
// Per-building sequence, so uw-hsb-acc01..07 are the seven closets in that one building rather
// than an arbitrary slice of a fleet-wide counter.
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
    // The second core is the modular chassis, so both the drawn and the undrawable paths appear
    // on a device that matters rather than on an obscure leaf.
    [i === 1 ? MODULAR_MODEL : CORE_MODELS[i % CORE_MODELS.length]],
    ipFor(coreBuildings[0], 1),
));
linkDevices(cores[0], cores[1], 'ICL');

// A distribution switch has a finite number of uplink cages, and a frame that runs out simply
// leaves the next closet unpatched - so the frame count has to follow the fleet size. Well under
// the ~44 cages on the smallest frame model, leaving headroom for the two core trunks, the
// dual-homed closets from the zone next door, and a stack member's share of the pool.
const UPLINKS_PER_FRAME = 20;
const totalClosets = ALL_BUILDINGS.reduce((sum, b) => sum + b.closets, 0);
const zoneShare = (zone) => zone.buildings.reduce((sum, b) => sum + b.closets, 0) / totalClosets;
// Frames displace access switches from the budget, so the split is settled once up front rather
// than left to depend on itself.
const framesFor = (zone) => Math.max(1, Math.ceil((DEVICE_COUNT - cores.length) * zoneShare(zone) / UPLINKS_PER_FRAME));
const frameCount = CAMPUS.reduce((sum, z) => sum + framesFor(z), 0);

const dists = [];
for (const zone of CAMPUS) {
    // The hub takes the first frame; the rest go to the biggest buildings. Dealt round-robin
    // rather than one-per-building, because a zone can need more frames than it has buildings -
    // a medical centre runs several, and capping at one would leave closets unpatched.
    const order = [hubOf(zone), ...zone.buildings.filter(b => !b.hub).sort((a, b) => b.closets - a.closets)];
    const want = framesFor(zone);
    const sites = Array.from({ length: want }, (_, i) => order[i % order.length]);
    const inThisZone = [];
    for (const bldg of sites) {
        const models = chance(0.35) ? [pick(DIST_MODELS), pick(DIST_MODELS)] : [pick(DIST_MODELS)];
        const d = place(bldg, 'DIST', models, cores[0].DeviceIP);
        dists.push(d);
        inThisZone.push(d);
        // Only the zone's own frame homes to the core. The rest hang off it, because two core
        // switches do not have enough cages to terminate every building frame on campus - which
        // is exactly why a campus this size has a zone tier in the first place.
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

// Access switches are handed out in proportion to each building's closet count, so the fleet
// thickens where the campus actually does.
const accessBudget = Math.max(1, DEVICE_COUNT - cores.length - frameCount);
const access = [];
const inBuilding = new Map(ALL_BUILDINGS.map(b => [b.abbr, []]));

// Largest-remainder apportionment: rounding each building's share independently drifts by a
// dozen devices over 48 buildings, and --devices 500 has to mean 500.
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
        // Virtual Chassis is the norm on access floors, and a multi-member stack is where the
        // faceplate view does its most fragile work (per-member FPC numbering, master/backup LEDs).
        const stackSize = chance(0.3) ? int(2, 5) : 1;
        const stackModel = pick(ACCESS_MODELS);
        const models = Array.from({ length: stackSize }, () => (stackSize > 1 && chance(0.15) ? pick(ACCESS_MODELS) : stackModel));
        const parent = nearestWithPort(bldg, distsInZone(bldg.zone.short));
        if (!parent) throw new Error(`Every distribution frame in ${bldg.zone.name} is full - lower UPLINKS_PER_FRAME (currently ${UPLINKS_PER_FRAME}).`);
        const a = place(bldg, 'ACC', models, parent.DeviceIP);
        linkDevices(a, parent, 'UPLINK');
        // A closet dual-homed for resilience goes to the nearest frame in a NEIGHBOURING zone -
        // there is no fibre to the far side of campus, and a redundant path back into the same
        // building it already depends on would not be redundant.
        if (chance(0.08)) {
            const neighbours = bldg.zone.adjacent.flatMap(distsInZone);
            const spare = nearestWithPort(bldg, neighbours);
            if (spare) linkDevices(a, spare, 'UPLINK');
        }
        access.push(a);
        inBuilding.get(bldg.abbr).push(a);
    }
}

// A closet fed from another closet rather than from the frame - common in an older building,
// and where the primary-tree depth calculation stops being trivial. Always within one building:
// this is a patch between floors, not a campus link.
for (const [, switches] of inBuilding) {
    if (switches.length < 3) continue;
    for (const a of shuffled(switches).slice(0, Math.floor(switches.length * 0.2))) {
        const leaf = pick(switches);
        if (leaf !== a && !leaf.Neighbors.some(n => n.ManagementIP === a.DeviceIP)) linkDevices(a, leaf, 'DAISY');
    }
}

for (const node of [...cores, ...dists, ...access]) topology.push(node);

// linkDevices returns false when either end has run out of uplink cages, and an unlinked switch
// is invisible in the fixture: it just becomes an orphan node in a row off to one side of the
// diagram. Silent for one run and easy to mistake for a layout quirk, so it is fatal here.
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

/* ---------------- endpoints, configuration, failures ---------------- */

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

/* ---------------- map placement ---------------- */

const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
// Metres east/north of a building's interior point, back to a coordinate.
const offsetBy = (bldg, east, north) => ({
    lat: +(bldg.lat + north / M_PER_DEG_LAT).toFixed(6),
    lng: +(bldg.lng + east / mPerDegLng(bldg.lat)).toFixed(6),
});

// Concentric rings at `step` metres, centre outwards, or null when `count` of them will not fit
// inside `limit`. Ring gap is `step` and the in-ring chord is held at or above it, so `step` is
// the minimum distance between any two spots.
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

// Closets are dealt around their building on rings inside its footprint rather than scattered
// randomly: jitter wide enough to separate them also threw pins onto the lawn, and could still
// drop two on one spot. The centre is the building's interior point, where its main frame
// belongs. Deterministic, so the same fleet always draws the same map.
function closetSpots(bldg, count) {
    // The widest spacing that still fits every closet indoors: a quiet building spreads its
    // pins out, a crowded one packs tighter rather than spilling outside the walls.
    let step = Math.max(4, bldg.r / 2);
    for (let attempt = 0; attempt < 60; attempt++) {
        const spots = ringSpots(bldg.r, step, count);
        if (spots) return { spots, step };
        step *= 0.85;
    }
    // Unreachable for any plausible fleet - 60 reductions is a spacing of millimetres - but a
    // null here would be a crash rather than a crowded building.
    return { spots: ringSpots(bldg.r, bldg.r / 1e4, count) || [{ east: 0, north: 0 }], step: bldg.r / 1e4 };
}

// The frame is the building's main distribution frame, so it takes the interior point and the
// closets ring around it.
const placementRank = (node) => (node.role === 'ACC' ? 1 : 0);
const pinnedByBuilding = new Map();
for (const node of topology) {
    if (!pinnedByBuilding.has(node.bldg)) pinnedByBuilding.set(node.bldg, []);
    pinnedByBuilding.get(node.bldg).push(node);
}

// Serial-keyed so a device that is re-homed or renumbered keeps its map pin, which is how the
// real Configuration.json is keyed.
for (const [bldg, nodes] of pinnedByBuilding) {
    const ordered = nodes.slice().sort((a, b) => placementRank(a) - placementRank(b)
        || String(a.DeviceIP).localeCompare(String(b.DeviceIP)));
    const { spots, step } = closetSpots(bldg, ordered.length);
    // Stack members share a rack, so they share a closet - ringed slightly apart so they are
    // separate pins rather than one unclickable dot. A fraction of the closet spacing, not a
    // radius that grows with the member index: a widening spread walks the far members of a
    // long virtual chassis off their own closet and onto the next one.
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

/* ---------------- snapshots over time ---------------- */

// What a fleet does between two crawls: a few configs are edited, a few closets are cut over
// to another distribution switch, ports move, and load is re-measured. Everything the
// dashboard's Trends, Topology Diff, New Devices and Config Changed tabs compare is a
// difference between snapshots, so a single-snapshot fixture leaves all four blank.
function ageFleet(days) {
    for (const node of topology) {
        node.MasterCpuUtilization = cpuValue();
        node.MasterMemoryUtilization = memValue();
    }
    // Reboots are detected by comparing a device's boot timestamp against the previous
    // snapshot's, so a fleet whose Uptime never moves reports none - and the trend charts'
    // reboot markers stay empty however many snapshots are loaded.
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
            row.LastFlappedSeconds = int(60, days * 86400);
        }
    }
    // A closet retired and a closet commissioned, so New Devices has both a departure and an
    // arrival to report rather than only ever growing.
    const retired = pick(topology.filter(d => d.role === 'ACC'));
    topology.splice(topology.indexOf(retired), 1);
    for (const node of topology) node.Neighbors = node.Neighbors.filter(n => n.ManagementIP !== retired.DeviceIP);
    // Only a building whose zone still has a spare port can take a new closet - the arrival must
    // end up patched to something, or the snapshot gains a device that is invisible in the graph.
    const bldg = pick(ALL_BUILDINGS.filter(b => nearestWithPort(b, distsInZone(b.zone.short))));
    const parent = nearestWithPort(bldg, distsInZone(bldg.zone.short));
    const arrival = place(bldg, 'ACC', [pick(ACCESS_MODELS)], parent.DeviceIP);
    const arrivalVlans = shuffled(VLANS.map(v => v.tag)).slice(0, 3);
    arrival.Configuration = configText(arrival.Hostname, bldg.zone, bldg, arrivalVlans, []);
    addClients(arrival, parent, arrivalVlans);
    linkDevices(arrival, parent, 'UPLINK');
    topology.push(arrival);
}

// A crawler that could not read a device has no serial for it, so a placeholder falls back to
// hostname for its cross-snapshot identity. Re-rolling the failing set each snapshot would
// therefore show most of the fleet as removed-and-re-added in the Topology Diff, drowning the
// genuine arrivals. A device that is down stays down, and one flips per crawl - which is the
// churn the Reliability tab is there to surface.
const chronicallyFailing = shuffled(topology.filter(d => d.role === 'ACC'))
    .slice(0, Math.max(1, Math.round(topology.length * 0.025))).map(d => d.DeviceIP);

function withFailures(fleet, snapshotIndex) {
    const failing = new Set(chronicallyFailing);
    if (snapshotIndex > 0) {
        failing.delete(chronicallyFailing[snapshotIndex % chronicallyFailing.length]);   // recovered
        const stillUp = fleet.filter(d => d.role === 'ACC' && !failing.has(d.DeviceIP));
        failing.add(stillUp[(snapshotIndex * 97) % stillUp.length].DeviceIP);            // newly down
    }
    // Dropped before the clone, not after: bldg.zone.buildings points back at bldg, and a
    // structuredClone/JSON round-trip of a node still carrying those would recurse.
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
        }
        return copy;
    });
}

/* ---------------- write ---------------- */

fs.mkdirSync(OUT_DIR, { recursive: true });
const written = [];
for (let i = 0; i < SNAPSHOT_COUNT; i++) {
    // Oldest first, so each snapshot is written from the fleet as the previous one left it.
    const daysBack = SNAPSHOT_COUNT - 1 - i;
    if (i > 0) { ageFleet(daysBack + 1); assertNothingOrphaned(topology); }
    const scanTime = new Date(SCAN_DATE.getTime() - daysBack * 86400000);
    const stamp = scanTime.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
    // NetworkMap_* so the server and the folder loader pick it up, .fixture.json so a generated
    // map can be gitignored without also ignoring a real crawl's output sitting beside it.
    const mapPath = path.join(OUT_DIR, `NetworkMap_${stamp}.fixture.json`);
    const fleet = withFailures(topology, i);
    fs.writeFileSync(mapPath, JSON.stringify({ Topology: fleet, ScanTimestamp: scanTime.toISOString() }));
    written.push({ mapPath, fleet });
}

// Never named Configuration.json: the generator must not be able to overwrite the real
// credentials file that sits beside the maps.
const configPath = path.join(OUT_DIR, 'Configuration.fixture.json');
fs.writeFileSync(configPath, JSON.stringify({
    devices: configDevices,
    credentials: { username: 'fixture-user', password: 'fixture-password' },
    settings: {
        cpuWarnPct: 70, cpuCriticalPct: 90, memWarnPct: 75, memCriticalPct: 90,
        crawlAgeFreshMin: 60, crawlAgeStaleMin: 1440, recentRebootMin: 60,
        clusterThreshold: 50, nodeSpacing: 350, leafSpacing: 250, minRadius: 250,
    },
}, null, 2));

for (const { mapPath, fleet } of written) {
    const c = fleet.reduce((a, d) => {
        a.interfaces += d.Interfaces.length; a.clients += d.Clients.length;
        a.arp += d.ArpEntries.length; a.neighbors += d.Neighbors.length;
        a.members += d.StackMembers.length; a.med += d.MedNeighbors.length;
        if (d.ScanStatus !== 'Ok') a.failed++;
        if (d.StackMembers.length > 1) a.stacks++;
        return a;
    }, { interfaces: 0, clients: 0, arp: 0, neighbors: 0, members: 0, med: 0, failed: 0, stacks: 0 });
    process.stderr.write(
        `${mapPath}\n  ${fleet.length} devices (${c.stacks} virtual chassis, ${c.members} members, ${c.failed} failed scans)\n` +
        `  ${c.interfaces} interfaces, ${c.neighbors} LLDP neighbours, ${c.clients} clients, ${c.arp} ARP entries, ${c.med} MED endpoints\n` +
        `  ${(fs.statSync(mapPath).size / 1048576).toFixed(1)} MiB\n`
    );
}
process.stderr.write(
    `${configPath}\n  ${configDevices.length} placed devices in ${ALL_BUILDINGS.length} buildings ` +
    `across ${CAMPUS.length} campus zones, seed ${SEED}\n`
);
