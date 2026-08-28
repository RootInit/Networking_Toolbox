// Generates a synthetic ~500-switch topology fixture to verify the layout
// stays readable at real-world scale. Not part of the app - run manually:
//   node generate-fixture.mjs > /tmp/big-fixture.json

function ip(n) {
  return `10.90.${Math.floor(n / 250)}.${(n % 250) + 1}`;
}

const topology = [];
let nextId = 0;
const core = nextId++;

// 6 distribution switches off the core, each with ~80 access switches,
// so the total lands close to 500 (1 core + 6 distribution + ~480 access).
const distributionCount = 6;
const accessPerDistribution = 80;

function makeDevice(id, neighborIds, model) {
  const deviceIp = ip(id);
  return {
    DeviceIP: deviceIp,
    Hostname: `SW-${id}.local`,
    JunosVersion: "22.4R3.25",
    Gateway: ip(core),
    StackMembers: [{ FPC: "0", Model: model, Serial: `SYN${1000000 + id}`, Role: "Standalone" }],
    Neighbors: neighborIds.map(nid => ({
      LocalPort: "xe-0/0/0", RemotePort: "xe-0/0/0",
      Hostname: `SW-${nid}.local`, MacAddress: "02:00:00:00:00:00",
      ManagementIP: ip(nid), Description: "Juniper Networks, Inc.",
    })),
    Clients: [],
    ArpEntries: [],
    Interfaces: [],
  };
}

const distributionIds = Array.from({ length: distributionCount }, () => nextId++);
const accessIdsByDistribution = distributionIds.map(() =>
  Array.from({ length: accessPerDistribution }, () => nextId++)
);

// A handful of redundant/secondary links between distribution switches,
// to exercise the primary-tree/secondary-edge split at scale.
const secondaryLinks = [
  [distributionIds[0], distributionIds[1]],
  [distributionIds[2], distributionIds[3]],
];

topology.push(makeDevice(core, distributionIds, "ex4600-40f"));
distributionIds.forEach((distId, i) => {
  const neighbors = [core, ...accessIdsByDistribution[i]];
  secondaryLinks.forEach(([a, b]) => { if (a === distId) neighbors.push(b); if (b === distId) neighbors.push(a); });
  topology.push(makeDevice(distId, neighbors, "ex3400-48p"));
});
distributionIds.forEach((distId, i) => {
  accessIdsByDistribution[i].forEach(accessId => {
    topology.push(makeDevice(accessId, [distId], "ex2300-24t"));
  });
});

process.stdout.write(JSON.stringify({ Topology: topology }, null, 2));
