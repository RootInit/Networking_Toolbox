// Generates a synthetic but structurally realistic topology snapshot for testing the
// visualizer at fleet scale, plus a matching Configuration file so the geographic Map and the
// dashboard thresholds have something to show. Not part of the app - run manually:
//   node tools/generate-fixture.mjs                       # 500 devices -> ../Network_Maps/
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
const DEVICE_COUNT = Math.max(4, parseInt(flag('devices', '500'), 10));
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

const SITES = [
    { name: 'Harborview Campus', short: 'HBV', lat: 47.65335, lng: -122.30687, buildings: ['Admin', 'Library', 'Science Hall'] },
    { name: 'Ridgeway Plant', short: 'RDG', lat: 47.5301, lng: -122.0326, buildings: ['Fabrication', 'Warehouse'] },
    { name: 'Eastgate Annex', short: 'EGA', lat: 47.5817, lng: -122.1435, buildings: ['Annex North', 'Annex South'] },
    { name: 'Northbend Depot', short: 'NBD', lat: 47.8107, lng: -122.2, buildings: ['Depot'] },
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

function configText(host, site, vlanTags, extraLines) {
    const lines = [
        `set system host-name ${host}`,
        'set system login user admin class super-user',
        'set system authentication-order [ radius password ]',
        `set system radius-server 10.${site.idx}.0.20 secret "$9$REDACTED"`,
        'set system services ssh protocol-version v2',
        `set system ntp server 10.${site.idx}.0.30`,
        `set snmp community "$9$REDACTED" authorization read-only`,
        `set snmp location "${site.name}"`,
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

const ip = (site, host) => `10.${site.idx}.${Math.floor(host / 250)}.${(host % 250) + 1}`;

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

function makeDevice({ deviceIp, host, site, building, models, role, gateway }) {
    const node = blankNode(deviceIp);
    node.Hostname = `${site.short}-${role}-${String(host).padStart(3, '0')}.local`;
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
    node.site = site;
    node.building = building;
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
                ManagementIP: first.IP === 'Unknown' ? `10.${node.site.idx}.${int(100, 240)}.${int(2, 250)}` : first.IP,
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
    const clientIp = `10.${node.site.idx}.${int(100, 240)}.${int(2, 250)}`;
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

SITES.forEach((s, i) => { s.idx = 55 + i; });

const topology = [];
const configDevices = [];
let hostCounter = 0;

const coreCount = 2;
const distCount = Math.max(SITES.length, Math.min(12, Math.round(DEVICE_COUNT / 40)));
const accessCount = Math.max(1, DEVICE_COUNT - coreCount - distCount);

const cores = [];
for (let i = 0; i < coreCount; i++) {
    const site = SITES[0];
    const deviceIp = ip(site, hostCounter);
    cores.push(makeDevice({
        deviceIp, host: hostCounter++, site, building: site.buildings[0],
        // The second core is the modular chassis, so both the drawn and the undrawable paths
        // appear on a device that matters rather than on an obscure leaf.
        models: [i === 1 ? MODULAR_MODEL : CORE_MODELS[i % CORE_MODELS.length]],
        role: 'CORE', gateway: ip(site, 0),
    }));
}
linkDevices(cores[0], cores[1], 'ICL');

const dists = [];
for (let i = 0; i < distCount; i++) {
    const site = SITES[i % SITES.length];
    const deviceIp = ip(site, hostCounter);
    const models = chance(0.35) ? [pick(DIST_MODELS), pick(DIST_MODELS)] : [pick(DIST_MODELS)];
    const d = makeDevice({
        deviceIp, host: hostCounter++, site, building: pick(site.buildings),
        models, role: 'DIST', gateway: cores[0].DeviceIP,
    });
    dists.push(d);
    for (const core of cores) linkDevices(d, core, 'TRUNK');
}

const accessByDist = dists.map(() => []);
for (let i = 0; i < accessCount; i++) {
    const distIdx = i % dists.length;
    const parent = dists[distIdx];
    const site = parent.site;
    const deviceIp = ip(site, hostCounter);
    // Virtual Chassis is the norm on access floors, and a multi-member stack is where the
    // faceplate view does its most fragile work (per-member FPC numbering, master/backup LEDs).
    const stackSize = chance(0.3) ? int(2, 5) : 1;
    const stackModel = pick(ACCESS_MODELS);
    const models = Array.from({ length: stackSize }, () => (stackSize > 1 && chance(0.15) ? pick(ACCESS_MODELS) : stackModel));
    const a = makeDevice({
        deviceIp, host: hostCounter++, site, building: pick(site.buildings),
        models, role: 'ACC', gateway: parent.DeviceIP,
    });
    accessByDist[distIdx].push(a);
    linkDevices(a, parent, 'UPLINK');
    // Some closets are dual-homed to a second distribution switch: without a few of these the
    // graph is a pure tree and the secondary-edge rendering is never reached.
    if (chance(0.08) && dists.length > 1) linkDevices(a, dists[(distIdx + 1) % dists.length], 'UPLINK');
}

const access = accessByDist.flat();
// A daisy-chained closet switch hanging off another access switch, which is where the
// primary-tree depth calculation stops being trivial.
for (const a of shuffled(access).slice(0, Math.floor(access.length * 0.06))) {
    const leaf = pick(access);
    if (leaf !== a && !leaf.Neighbors.some(n => n.ManagementIP === a.DeviceIP)) linkDevices(a, leaf, 'DAISY');
}

for (const node of [...cores, ...dists, ...access]) topology.push(node);

/* ---------------- endpoints, configuration, failures ---------------- */

const gatewayFor = (node) => (node.role === 'ACC' ? topology.find(d => d.DeviceIP === node.Gateway) : cores[0]);

for (const node of topology) {
    const vlanTags = shuffled(VLANS.map(v => v.tag)).slice(0, int(2, 5));
    if (node.role === 'ACC') addClients(node, gatewayFor(node), vlanTags);
    const extra = [];
    if (node.role !== 'ACC') extra.push(`set protocols rstp bridge-priority ${node.role === 'CORE' ? '4k' : '8k'}`);
    if (chance(0.3)) extra.push('set system services netconf ssh');
    if (chance(0.2)) extra.push(`set interfaces ${node.Interfaces[0].Port} description "${node.building} patch"`);
    node.Configuration = configText(node.Hostname, node.site, vlanTags, extra);
}

// Serial-keyed so a device that is re-homed or renumbered keeps its map pin, which is how the
// real Configuration.json is keyed.
for (const node of topology) {
    for (const m of node.StackMembers) {
        if (!m.Serial) continue;
        const site = node.site;
        configDevices.push({
            key: m.Serial, keyType: 'serial',
            // Jittered around the site so pins in one building do not stack into one dot, and
            // so clusterThreshold has clusters to form.
            lat: +(site.lat + (rnd() - 0.5) * 0.004).toFixed(6),
            lng: +(site.lng + (rnd() - 0.5) * 0.004).toFixed(6),
            building: node.building, room: `Rm ${int(100, 480)}`,
            notes: `Synthetic fixture device (seed ${SEED})`,
        });
    }
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
    for (const node of shuffled(topology).slice(0, Math.max(2, Math.round(topology.length * 0.04)))) {
        node.Configuration += `\nset system syslog file interactive-commands interactive-commands any\nset snmp trap-group audit targets 10.${node.site.idx}.0.4${days}`;
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
    const site = SITES[0];
    const arrival = makeDevice({
        deviceIp: ip(site, hostCounter), host: hostCounter++, site, building: pick(site.buildings),
        models: [pick(ACCESS_MODELS)], role: 'ACC', gateway: dists[0].DeviceIP,
    });
    arrival.Configuration = configText(arrival.Hostname, site, shuffled(VLANS.map(v => v.tag)).slice(0, 3), []);
    addClients(arrival, dists[0], shuffled(VLANS.map(v => v.tag)).slice(0, 3));
    linkDevices(arrival, dists[0], 'UPLINK');
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
    return fleet.map(node => {
        const copy = JSON.parse(JSON.stringify(node));
        if (failing.has(node.DeviceIP)) {
            const status = pick(FAILURE_STATUSES);
            const blank = blankNode(node.DeviceIP);
            blank.ScanStatus = status;
            blank.ScanError = FAILURE_TEXT[status].replace('{ip}', node.DeviceIP);
            blank.Hostname = node.Hostname;
            Object.assign(copy, blank);
        }
        for (const key of ['site', 'building', 'role', '_freeUplinks', '_byPort']) delete copy[key];
        return copy;
    });
}

/* ---------------- write ---------------- */

fs.mkdirSync(OUT_DIR, { recursive: true });
const written = [];
for (let i = 0; i < SNAPSHOT_COUNT; i++) {
    // Oldest first, so each snapshot is written from the fleet as the previous one left it.
    const daysBack = SNAPSHOT_COUNT - 1 - i;
    if (i > 0) ageFleet(daysBack + 1);
    const scanTime = new Date(SCAN_DATE.getTime() - daysBack * 86400000);
    const stamp = scanTime.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
    const mapPath = path.join(OUT_DIR, `NetworkMap_${stamp}.json`);
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
process.stderr.write(`${configPath}\n  ${configDevices.length} placed devices across ${SITES.length} sites, seed ${SEED}\n`);
