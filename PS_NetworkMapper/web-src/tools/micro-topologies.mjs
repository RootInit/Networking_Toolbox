// Section 8.4. Hand-built topologies, small enough to reason about by hand.
//
// The generated fixture is 350 devices of plausible-looking fleet; it is the wrong instrument for
// "does a path computer handle a leg blocked in one VLAN and forwarding in another", because finding
// that case in it depends on the seed. Each topology here is four devices or fewer, states every
// interesting state explicitly, and names the section 7 failure mode it exists for.
//
// Shape, not statistics: node and row keys mirror the worker's initializers in lib/Get-JunosNodeData.ps1
// so a consumer written against a real snapshot reads these unchanged. The parity test asserts that.
//
// Nothing here is random. A micro-topology whose states move between runs cannot be the fixed input a
// regression test needs, so there is no PRNG in this file at all.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const SCAN_TIMESTAMP = '2026-09-08T14:32:07.000Z';
export const ALLOWED_SCOPES = ['10.30.'];

// The worker's collapse of a per-scope state into the single STP field, worst case wins.
export const STP_PRECEDENCE = { BLK: 5, LST: 4, LRN: 3, FWD: 2, DIS: 1 };

// Get-JunosNodeData.ps1's $CAPTURE_SECTIONS order. A truncated capture loses the tail.
export const CAPTURE_SECTIONS = [
    'VERSION', 'VIRTUAL_CHASSIS', 'CHASSIS_HARDWARE', 'ROUTE', 'INTERFACES_TERSE',
    'INTERFACES_DESC', 'STP', 'POE', 'DOT1X', 'LLDP', 'VLANS', 'MAC_TABLE', 'ARP_TABLE',
    'UPTIME', 'ALARMS', 'ROUTING_ENGINE', 'CONFIG', 'INTERFACES_EXT',
];

export function microRow(port, extra = {}) {
    return {
        Port: port, Admin: 'up', Link: 'up', Desc: 'Unknown',
        STP: 'Unknown', PoE: 'Unknown',
        LastFlappedSeconds: 3600, LastFlappedState: 'Parsed',
        LogicalUnits: [{ Parent: port, Unit: 0, Family: 'eth-switch', LocalAddress: null, Remote: null, Admin: 'up', Link: 'up' }],
        StpDetail: {},
        Bundle: null, BundleMembers: [], Vlans: [],
        ...extra,
    };
}

export function microNode(deviceIp, hostname, { ports = [], members = 1, model = 'EX4300-48P', extra = {} } = {}) {
    const stack = [];
    for (let i = 0; i < members; i++) {
        stack.push({
            FPC: String(i), Model: model, Serial: `MICRO${deviceIp.replace(/\./g, '')}${i}`,
            Role: members === 1 ? 'Standalone' : i === 0 ? 'Master' : 'Backup',
            Status: 'Prsnt', MasterPriority: members === 1 ? null : 129, IsMaster: i === 0,
            NeighborList: members === 1 ? [] : [{ MemberId: String((i + 1) % members), Interface: `vcp-255/1/${i}` }],
        });
    }
    return {
        DeviceIP: deviceIp, Hostname: hostname, JunosVersion: '22.4R3.25', Gateway: '10.30.0.1',
        StackMembers: stack, Neighbors: [], Clients: [], ArpEntries: [],
        Interfaces: ports.map(p => (typeof p === 'string' ? microRow(p) : p)),
        Uptime: '2026-06-01 03:14:00 UTC', LastConfigured: '2026-09-01 11:02:00 UTC',
        LastConfiguredBy: 'netops', Alarms: [],
        MasterCpuUtilization: '12%', MasterMemoryUtilization: '48%', MedNeighbors: [],
        Configuration: `set system host-name ${hostname.split('.')[0]}\nset protocols rstp\n`,
        ScanStatus: 'Ok', ScanError: null, Vlans: [],
        SectionsCaptured: CAPTURE_SECTIONS.slice(), CaptureTimestamp: SCAN_TIMESTAMP, MacTable: [],
        DefaultRoute: {
            Table: 'inet.0', Destination: '0.0.0.0/0', Protocol: 'Static', Preference: 5,
            NextHop: '10.30.0.1', EgressInterface: 'irb.100', State: 'Parsed',
        },
        ChassisInventory: stack.map(m => ({
            Item: `FPC ${m.FPC}`, Indent: 0, Level: 0, Version: 'REV 19',
            PartNumber: '650-059857', Serial: m.Serial, Description: m.Model,
        })),
        LogicalUnits: [{ Parent: 'vme', Unit: 0, Family: 'inet', LocalAddress: `${deviceIp}/24`, Remote: null, Admin: 'up', Link: 'up' }],
        ...extra,
    };
}

const rowOf = (node, port) => node.Interfaces.find(r => r.Port === port);

// ConvertFrom-JunosVlanTable's shape: members are objects under Interfaces[], not a list of names, and
// the per-port view the worker derives from them carries the tag rather than only the VLAN name.
export function vlan(name, tag, unitNames, routingInstance = 'default-switch') {
    return {
        RoutingInstance: routingInstance, Name: name, Tag: tag,
        Interfaces: unitNames.map(unit => ({ Port: unit.replace(/\.\d+$/, ''), Unit: unit, Active: true })),
    };
}

// What Get-JunosNodeData.ps1 pushes onto each physical row for every VLAN that names it.
function applyVlanMembership(node) {
    for (const row of node.Interfaces) row.Vlans = [];
    for (const v of node.Vlans) {
        for (const member of v.Interfaces) {
            const row = rowOf(node, member.Port);
            if (row) row.Vlans.push({ Name: v.Name, Tag: v.Tag, Unit: member.Unit, Active: member.Active });
        }
    }
}

// Per-scope spanning-tree state plus the collapsed field the worker derives from it, set together:
// setting one without the other is the class of fixture lie section 8.2 exists to forbid.
export function setStp(node, port, scopes) {
    const row = rowOf(node, port);
    row.StpDetail = {};
    let best = 0;
    row.STP = 'Unknown';
    for (const [scope, detail] of Object.entries(scopes)) {
        row.StpDetail[scope] = {
            State: detail.State, Role: detail.Role,
            Cost: detail.Cost ?? 20000, PortId: detail.PortId ?? '128:1',
            DesignatedPortId: detail.DesignatedPortId ?? '128:1',
            DesignatedBridge: detail.DesignatedBridge ?? '4096.02:ab:00:00:00:01',
        };
        const rank = STP_PRECEDENCE[detail.State] || 0;
        if (rank > best) { best = rank; row.STP = detail.State; }
    }
    return row;
}

const LLDP_COMMON = {
    Reachable: true,
    OrgInfo: [
        { OUI: '00-12-0f', Subtype: 'MAC/PHY Configuration/Status (1)', Info: 'Autonegotiation enabled, 1000BaseTFD' },
        { OUI: '00-12-0f', Subtype: 'Maximum Frame Size (4)', Info: '9216' },
    ],
    AgeoutCount: 0, TimeToLive: 120, TimeMark: null, AgeSeconds: 30,
    Manufacturer: null, ModelName: null, SerialNumber: null,
    HardwareRevision: null, SoftwareRevision: null, FirmwareRevision: null,
};

// Symmetric LLDP, because an asymmetric pair is its own defect and would mask the one under test.
export function link(a, aPort, b, bPort, desc = 'UPLINK') {
    const stamp = (from, to, localPort, remotePort) => {
        from.Neighbors.push({
            LocalPort: localPort, RemotePort: remotePort, Hostname: to.Hostname,
            MacAddress: `02:AB:00:00:00:${String(to.DeviceIP.split('.')[3]).padStart(2, '0')}`,
            ManagementIP: to.DeviceIP,
            Description: `Juniper Networks, Inc. ${to.StackMembers[0].Model.toLowerCase()}`,
            ...structuredClone(LLDP_COMMON),
        });
        const row = rowOf(from, localPort);
        if (row) { row.Desc = `${desc} to ${to.Hostname}`; row.Link = 'up'; row.Admin = 'up'; }
    };
    stamp(a, b, aPort, bPort);
    stamp(b, a, bPort, aPort);
}

export function addClient(node, port, { mac, ip = 'Unknown', tag, vlanName, dot1x = 'Unknown' }) {
    const client = {
        IP: ip, MAC: mac, Port: `${port}.0`, PortDesc: rowOf(node, port).Desc,
        VLAN_Name: vlanName, VLAN_Tag: tag, Type: 'Dynamic',
        Dot1x_User: dot1x === 'Unknown' ? 'Unknown' : 'lab\\user101', Dot1x_State: dot1x,
    };
    node.Clients.push(client);
    node.MacTable.push({
        RoutingInstance: 'default-switch', VlanName: vlanName, MacAddress: mac,
        Flags: 'D', Age: null, Interface: client.Port, PhysicalPort: port,
    });
    return client;
}

const snapshot = (devices) => ({ Topology: devices, ScanTimestamp: SCAN_TIMESTAMP });

// F5. One leg blocked in VLAN 10 and forwarding in VLAN 20. The collapsed STP field reads BLK on that
// leg by precedence, so anything pruning on it alone refuses a hop VLAN 20 traffic genuinely takes -
// which is the whole reason the worker keeps StpDetail beside the collapse.
function triangleVstp() {
    const a = microNode('10.30.0.10', 'micro-a.example.net', { ports: ['xe-0/0/0', 'xe-0/0/1'] });
    const b = microNode('10.30.0.11', 'micro-b.example.net', { ports: ['xe-0/0/0', 'xe-0/0/1'] });
    const c = microNode('10.30.0.12', 'micro-c.example.net', { ports: ['xe-0/0/0', 'xe-0/0/1'] });
    for (const node of [a, b, c]) {
        node.Configuration = node.Configuration.replace('set protocols rstp\n',
            'set protocols vstp vlan 10\nset protocols vstp vlan 20\n');
        node.Vlans = [vlan('DATA', 10, ['xe-0/0/0.0', 'xe-0/0/1.0']), vlan('VOICE', 20, ['xe-0/0/0.0', 'xe-0/0/1.0'])];
        applyVlanMembership(node);
    }
    link(a, 'xe-0/0/0', b, 'xe-0/0/0', 'TRUNK');
    link(a, 'xe-0/0/1', c, 'xe-0/0/0', 'TRUNK');
    link(b, 'xe-0/0/1', c, 'xe-0/0/1', 'TRUNK');

    const D = (State, Role) => ({ State, Role, Cost: 2000 });
    // A is root in VLAN 10, B in VLAN 20, so the leg each instance blocks is a different one.
    setStp(a, 'xe-0/0/0', { 'VLAN 10': D('FWD', 'Designated'), 'VLAN 20': D('FWD', 'Root') });
    setStp(a, 'xe-0/0/1', { 'VLAN 10': D('FWD', 'Designated'), 'VLAN 20': D('FWD', 'Designated') });
    setStp(b, 'xe-0/0/0', { 'VLAN 10': D('FWD', 'Root'), 'VLAN 20': D('FWD', 'Designated') });
    // Each instance blocks a different one of C's two ports, so both read BLK once collapsed while each
    // forwards in one VLAN. The A-C leg is the one VLAN 20 blocks; the B-C leg is VLAN 10's.
    setStp(c, 'xe-0/0/0', { 'VLAN 10': D('FWD', 'Root'), 'VLAN 20': D('BLK', 'Alternate') });
    setStp(b, 'xe-0/0/1', { 'VLAN 10': D('FWD', 'Designated'), 'VLAN 20': D('FWD', 'Designated') });
    setStp(c, 'xe-0/0/1', { 'VLAN 10': D('BLK', 'Alternate'), 'VLAN 20': D('FWD', 'Root') });

    return {
        name: 'triangle-vstp-leg-blocked-in-one-vlan',
        failureModes: ['F5', 'F12'],
        description: 'Three bridges in a triangle under VSTP. The B-C leg is blocked in VLAN 10 and '
            + 'forwarding in VLAN 20, so C\'s collapsed STP field reads BLK on a port VLAN 20 forwards on.',
        blockedLeg: { deviceIp: c.DeviceIP, port: 'xe-0/0/1', blockedIn: 'VLAN 10', forwardingIn: 'VLAN 20' },
        snapshot: snapshot([a, b, c]),
    };
}

// F13. A VLAN with no spanning-tree instance at all. Nothing is blocked in it because nothing runs in
// it, and a hop cannot be pruned on evidence that does not exist - the state is NO_STP_INSTANCE, which
// is not the same answer as "forwarding".
function vlanWithoutStpInstance() {
    const a = microNode('10.30.1.10', 'micro-stpless-a.example.net', { ports: ['xe-0/0/0', 'ge-0/0/1'] });
    const b = microNode('10.30.1.11', 'micro-stpless-b.example.net', { ports: ['xe-0/0/0', 'ge-0/0/1'] });
    for (const node of [a, b]) {
        node.Configuration = node.Configuration.replace('set protocols rstp\n', 'set protocols vstp vlan 10\n');
        node.Vlans = [
            vlan('DATA', 10, ['xe-0/0/0.0', 'ge-0/0/1.0']),
            // Configured, carried on the trunk, and in no spanning-tree instance.
            vlan('LEGACY', 30, ['xe-0/0/0.0', 'ge-0/0/1.0']),
        ];
        applyVlanMembership(node);
    }
    link(a, 'xe-0/0/0', b, 'xe-0/0/0', 'TRUNK');
    setStp(a, 'xe-0/0/0', { 'VLAN 10': { State: 'FWD', Role: 'Designated', Cost: 2000 } });
    setStp(b, 'xe-0/0/0', { 'VLAN 10': { State: 'FWD', Role: 'Root', Cost: 2000 } });
    addClient(b, 'ge-0/0/1', { mac: 'aa:bb:00:00:00:30', ip: '10.30.200.30', tag: 30, vlanName: 'LEGACY' });
    a.ArpEntries.push({ MAC: 'aa:bb:00:00:00:30', IP: '10.30.200.30' });

    return {
        name: 'vlan-with-no-stp-instance',
        failureModes: ['F13'],
        description: 'VLAN 30 is configured and carried on the trunk, but only VLAN 10 has a VSTP '
            + 'instance. A path in VLAN 30 has no per-VLAN state to prune on.',
        unscopedVlanTag: 30,
        snapshot: snapshot([a, b]),
    };
}

// F10. Two paths survive pruning. The access switch is dual-homed and each instance blocks a different
// uplink, so a per-VLAN path computer finds one path per VLAN, a computer ignoring STP finds two, and
// one pruning on the collapsed field finds none - three different wrong answers from one topology.
function diamondTwoPaths() {
    const root = microNode('10.30.2.10', 'micro-root.example.net', { ports: ['xe-0/0/0', 'xe-0/0/1'], model: 'QFX5120-48Y' });
    const d1 = microNode('10.30.2.11', 'micro-dist1.example.net', { ports: ['xe-0/0/0', 'xe-0/0/1'], model: 'EX4600-40F' });
    const d2 = microNode('10.30.2.12', 'micro-dist2.example.net', { ports: ['xe-0/0/0', 'xe-0/0/1'], model: 'EX4600-40F' });
    const acc = microNode('10.30.2.13', 'micro-access.example.net', { ports: ['xe-0/0/0', 'xe-0/0/1', 'ge-0/0/2'] });
    for (const node of [root, d1, d2, acc]) {
        node.Configuration = node.Configuration.replace('set protocols rstp\n',
            'set protocols vstp vlan 10\nset protocols vstp vlan 20\n');
    }
    link(root, 'xe-0/0/0', d1, 'xe-0/0/0');
    link(root, 'xe-0/0/1', d2, 'xe-0/0/0');
    link(d1, 'xe-0/0/1', acc, 'xe-0/0/0');
    link(d2, 'xe-0/0/1', acc, 'xe-0/0/1');

    const D = (State, Role) => ({ State, Role, Cost: 2000 });
    for (const [node, port, roles] of [
        [root, 'xe-0/0/0', ['Designated', 'Designated']],
        [root, 'xe-0/0/1', ['Designated', 'Designated']],
        [d1, 'xe-0/0/0', ['Root', 'Root']],
        [d2, 'xe-0/0/0', ['Root', 'Root']],
        [d1, 'xe-0/0/1', ['Designated', 'Designated']],
        [d2, 'xe-0/0/1', ['Designated', 'Designated']],
    ]) {
        setStp(node, port, { 'VLAN 10': D('FWD', roles[0]), 'VLAN 20': D('FWD', roles[1]) });
    }
    // The block is one-ended, as RSTP has it: the upstream port stays Designated and forwarding.
    setStp(acc, 'xe-0/0/0', { 'VLAN 10': D('FWD', 'Root'), 'VLAN 20': D('BLK', 'Alternate') });
    setStp(acc, 'xe-0/0/1', { 'VLAN 10': D('BLK', 'Alternate'), 'VLAN 20': D('FWD', 'Root') });
    addClient(acc, 'ge-0/0/2', { mac: 'aa:bb:00:00:02:01', ip: '10.30.202.5', tag: 10, vlanName: 'DATA' });
    root.ArpEntries.push({ MAC: 'aa:bb:00:00:02:01', IP: '10.30.202.5' });

    return {
        name: 'diamond-two-paths-per-vlan',
        failureModes: ['F10', 'F5'],
        description: 'A dual-homed access switch under VSTP: VLAN 10 forwards through dist1, VLAN 20 '
            + 'through dist2. Both paths exist in the unpruned graph and both access uplinks read BLK '
            + 'once collapsed.',
        edgeCount: 4,
        snapshot: snapshot([root, d1, d2, acc]),
    };
}

// A two-member aggregate. LLDP runs on the member links, so the neighbour rows name ge ports while the
// forwarding state lives on ae0: a graph keyed on LLDP alone sees two links where the fleet has one.
function lag(memberDown) {
    const a = microNode('10.30.3.10', 'micro-lag-a.example.net', {
        ports: ['ae0', 'ge-0/0/0', 'ge-0/0/1'].map(p => microRow(p)),
    });
    const b = microNode('10.30.3.11', 'micro-lag-b.example.net', {
        ports: ['ae0', 'ge-0/0/0', 'ge-0/0/1'].map(p => microRow(p)),
    });
    for (const node of [a, b]) {
        rowOf(node, 'ae0').BundleMembers = ['ge-0/0/0', 'ge-0/0/1'];
        for (const member of ['ge-0/0/0', 'ge-0/0/1']) rowOf(node, member).Bundle = 'ae0';
        node.Configuration += 'set interfaces ge-0/0/0 ether-options 802.3ad ae0\n'
            + 'set interfaces ge-0/0/1 ether-options 802.3ad ae0\n';
    }
    link(a, 'ge-0/0/0', b, 'ge-0/0/0', 'LAG');
    link(a, 'ge-0/0/1', b, 'ge-0/0/1', 'LAG');
    for (const node of [a, b]) {
        setStp(node, 'ae0', { 'instance 0': { State: 'FWD', Role: node === a ? 'Designated' : 'Root', Cost: 20000 } });
    }
    if (memberDown) {
        for (const node of [a, b]) {
            const member = rowOf(node, 'ge-0/0/1');
            member.Link = 'down';
            member.LastFlappedSeconds = 900;
            member.LastFlappedState = 'Parsed';
            // A member that is down is not carrying the neighbour it used to; the aggregate still is.
            node.Neighbors = node.Neighbors.filter(n => n.LocalPort !== 'ge-0/0/1');
        }
    }
    return {
        name: memberDown ? 'lag-two-members-one-down' : 'lag-two-members-up',
        // No section 7 row: an aggregate is a shape the graph has to collapse, not a failure mode.
        failureModes: [],
        description: memberDown
            ? 'A two-member aggregate with one member down: the bundle still forwards, and the '
            + 'remaining capacity is half what the configuration implies.'
            : 'A two-member aggregate, both members up. LLDP reports two links; the spanning tree '
            + 'runs on ae0, so the two member rows carry no state of their own.',
        bundle: 'ae0',
        snapshot: snapshot([a, b]),
    };
}

// A virtual chassis is one node with ports on two FPCs. A consumer that keys a port by its number
// alone, rather than by fpc/pic/port, collides ge-0/0/0 with ge-1/0/0.
function virtualChassis() {
    const vc = microNode('10.30.4.10', 'micro-vc.example.net', {
        members: 2, ports: ['ge-0/0/0', 'ge-0/0/1', 'ge-1/0/0', 'ge-1/0/1', 'xe-0/2/0'],
    });
    const upstream = microNode('10.30.4.11', 'micro-vc-up.example.net', { ports: ['xe-0/0/0'], model: 'EX4600-40F' });
    link(vc, 'xe-0/2/0', upstream, 'xe-0/0/0');
    setStp(vc, 'xe-0/2/0', { 'instance 0': { State: 'FWD', Role: 'Root', Cost: 2000 } });
    setStp(upstream, 'xe-0/0/0', { 'instance 0': { State: 'FWD', Role: 'Designated', Cost: 2000 } });
    addClient(vc, 'ge-0/0/0', { mac: 'aa:bb:00:00:04:00', tag: 10, vlanName: 'DATA' });
    addClient(vc, 'ge-1/0/0', { mac: 'aa:bb:00:00:04:01', tag: 10, vlanName: 'DATA' });
    return {
        name: 'virtual-chassis-across-fpcs',
        // No section 7 row: port identity inside one node, not a path failure.
        failureModes: [],
        description: 'One device, two FPCs, a client on the same port number of each. Port identity is '
            + 'fpc/pic/port, never the trailing number.',
        snapshot: snapshot([vc, upstream]),
    };
}

// A waypoint that never answered. Both its neighbours still report it, so the link exists; what is
// missing is any state on its ports, and a path through it cannot be called clean.
function unscannedWaypoint() {
    const a = microNode('10.30.5.10', 'micro-wp-a.example.net', { ports: ['xe-0/0/0'] });
    const c = microNode('10.30.5.12', 'micro-wp-c.example.net', { ports: ['xe-0/0/0'] });
    const b = microNode('10.30.5.11', 'micro-wp-b.example.net', { ports: ['xe-0/0/0', 'xe-0/0/1'] });
    link(a, 'xe-0/0/0', b, 'xe-0/0/0');
    link(c, 'xe-0/0/0', b, 'xe-0/0/1');
    setStp(a, 'xe-0/0/0', { 'instance 0': { State: 'FWD', Role: 'Root', Cost: 2000 } });
    setStp(c, 'xe-0/0/0', { 'instance 0': { State: 'FWD', Role: 'Root', Cost: 2000 } });
    // What New-PlaceholderNodeLocal leaves behind, keeping only the identity the neighbours supplied.
    const placeholder = {
        ...microNode(b.DeviceIP, b.Hostname),
        StackMembers: [], Interfaces: [], Neighbors: [], Clients: [], ArpEntries: [], MedNeighbors: [],
        JunosVersion: 'Unknown', Gateway: 'Unknown', Uptime: 'Unknown', LastConfigured: 'Unknown',
        LastConfiguredBy: 'Unknown', MasterCpuUtilization: 'Unknown', MasterMemoryUtilization: 'Unknown',
        Configuration: 'Unknown', ScanStatus: 'Timeout',
        ScanError: `ssh: connect to host ${b.DeviceIP} port 22: Connection timed out`,
        SectionsCaptured: [], CaptureTimestamp: null, MacTable: [], DefaultRoute: {},
        ChassisInventory: [], LogicalUnits: [], Vlans: [],
    };
    return {
        name: 'unscanned-waypoint',
        failureModes: ['F7', 'F8'],
        description: 'A path whose middle hop is a device that never answered. The link is real - both '
            + 'ends report it over LLDP - but there is no port state on the hop itself.',
        waypointIp: b.DeviceIP,
        snapshot: snapshot([a, placeholder, c]),
    };
}

// F14. A bridge with no management address. It advertises Bridge capability over LLDP and there is no
// node for it, so its two ports are not a link and must not be chained into one.
function addresslessBridge() {
    const a = microNode('10.30.6.10', 'micro-seg-a.example.net', { ports: ['ge-0/0/0'] });
    const b = microNode('10.30.6.11', 'micro-seg-b.example.net', { ports: ['ge-0/0/0'] });
    const bridgeMac = '02:AB:DE:AD:BE:EF';
    for (const [node, remotePort] of [[a, '1'], [b, '2']]) {
        rowOf(node, 'ge-0/0/0').Desc = 'UNMANAGED shared segment';
        setStp(node, 'ge-0/0/0', { 'instance 0': { State: 'FWD', Role: 'Designated', Cost: 20000 } });
        node.Neighbors.push({
            LocalPort: 'ge-0/0/0.0', RemotePort: remotePort, Hostname: 'Unknown',
            MacAddress: bridgeMac, ManagementIP: 'Unknown', Description: 'Unmanaged 8-port switch',
            ...structuredClone(LLDP_COMMON), Reachable: false,
        });
    }
    return {
        name: 'addressless-bridge-shared-segment',
        failureModes: ['F6', 'F14'],
        description: 'Two switches either side of an unmanaged bridge. Both ports read DESG FWD and '
            + 'neither neighbour has an address, so no node exists between them.',
        bridgeMac,
        snapshot: snapshot([a, b]),
    };
}

// A neighbour outside allowedScopes: a real device, correctly never crawled, and it must not be drawn
// as a node nor treated as a missing scan.
function outOfScopeNeighbor() {
    const a = microNode('10.30.7.10', 'micro-scope-a.example.net', { ports: ['xe-0/0/0'] });
    setStp(a, 'xe-0/0/0', { 'instance 0': { State: 'FWD', Role: 'Root', Cost: 2000 } });
    a.Neighbors.push({
        LocalPort: 'xe-0/0/0', RemotePort: 'xe-1/1/1', Hostname: 'partner-core.example.org',
        MacAddress: '02:AB:11:22:33:44', ManagementIP: '172.31.9.1',
        Description: 'Juniper Networks, Inc. mx204',
        ...structuredClone(LLDP_COMMON),
    });
    rowOf(a, 'xe-0/0/0').Desc = 'UPLINK to partner-core';
    return {
        name: 'out-of-scope-neighbor',
        // No section 7 row: a neighbour we were never meant to crawl is not a failure at all.
        failureModes: [],
        description: 'An LLDP neighbour with a management address outside allowedScopes. It has an '
            + 'address and is reachable, and still no node exists for it.',
        outOfScopeIp: '172.31.9.1',
        snapshot: snapshot([a]),
    };
}

// A Partial node: real data, and the section a rule needs is the one that never arrived. The answer is
// NOT_EVALUATED. Reading the empty StpDetail as "nothing blocked" is the false clean the guard exists
// to prevent, and it is indistinguishable from a healthy tree without SectionsCaptured.
function partialNode() {
    const a = microNode('10.30.8.10', 'micro-partial-a.example.net', { ports: ['xe-0/0/0'] });
    const b = microNode('10.30.8.11', 'micro-partial-b.example.net', { ports: ['xe-0/0/0', 'ge-0/0/1'] });
    link(a, 'xe-0/0/0', b, 'xe-0/0/0');
    setStp(a, 'xe-0/0/0', { 'instance 0': { State: 'FWD', Role: 'Designated', Cost: 2000 } });
    b.ScanStatus = 'Partial';
    // Truncated at STP, so everything from there on is absent - the tail order is the worker's.
    b.SectionsCaptured = CAPTURE_SECTIONS.slice(0, CAPTURE_SECTIONS.indexOf('STP'));
    b.ScanError = `session closed after ${b.SectionsCaptured.length} of ${CAPTURE_SECTIONS.length} sections`;
    // Dropping a section has to drop what that section supplies, or the node asserts a state no real
    // switch produces (section 8.2) and a guard-gated rule reads NOT_EVALUATED beside visible data.
    // The one-sided LLDP that leaves is exactly what a session dying mid-capture produces: A still
    // reports B, and B reports nothing.
    for (const row of b.Interfaces) { row.StpDetail = {}; row.STP = 'Unknown'; row.PoE = 'Unknown'; }
    b.Neighbors = [];
    b.MedNeighbors = [];
    b.Clients = [];
    b.MacTable = [];
    b.ArpEntries = [];
    b.Vlans = [];
    // Uptime and both LastConfigured fields all come out of the one UPTIME section.
    b.Uptime = 'Unknown';
    b.LastConfigured = 'Unknown';
    b.LastConfiguredBy = 'Unknown';
    b.Alarms = [];
    b.MasterCpuUtilization = 'Unknown';
    b.MasterMemoryUtilization = 'Unknown';
    b.Configuration = 'Unknown';
    return {
        name: 'partial-node-missing-stp-section',
        // Not a section 7 row: the failure being modelled is the NOT_EVALUATED guarantee of section 3.2.
        failureModes: [],
        description: 'A Partial node whose capture stopped before the spanning-tree section. Its ports '
            + 'carry no state at all, which is not the same as carrying no problem.',
        partialIp: b.DeviceIP,
        missingSection: 'STP',
        snapshot: snapshot([a, b]),
    };
}

export const MICRO_TOPOLOGIES = [
    triangleVstp(), vlanWithoutStpInstance(), diamondTwoPaths(),
    lag(false), lag(true), virtualChassis(), unscannedWaypoint(),
    addresslessBridge(), outOfScopeNeighbor(), partialNode(),
];

export const byName = (name) => MICRO_TOPOLOGIES.find(t => t.name === name);

// Writable so one can be opened in the visualizer by hand; the suite imports the objects directly.
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
    const i = process.argv.indexOf('--out');
    const out = path.resolve(i === -1 ? '.' : process.argv[i + 1]);
    fs.mkdirSync(out, { recursive: true });
    for (const topology of MICRO_TOPOLOGIES) {
        const file = path.join(out, `NetworkMap_micro_${topology.name}.fixture.json`);
        fs.writeFileSync(file, JSON.stringify(topology.snapshot, null, 2));
        process.stderr.write(`${file}\n  ${topology.snapshot.Topology.length} devices, ${topology.failureModes.join('/')}: ${topology.description}\n`);
    }
}
