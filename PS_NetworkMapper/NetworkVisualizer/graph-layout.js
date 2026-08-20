// Pure graph algorithms for the topology layout: no DOM, no vis-network,
// no browser globals. Importable from both the browser and node:test.

// Splits a dotted-quad-shaped ID into comparable numeric octets; IDs that
// aren't dotted-quads (e.g. "cluster:10.55.2.2") fall back to string compare.
export function compareIpIds(a, b) {
  const partsA = String(a).split('.');
  const partsB = String(b).split('.');
  if (partsA.length === 4 && partsB.length === 4 && partsA.every(p => /^\d+$/.test(p)) && partsB.every(p => /^\d+$/.test(p))) {
    for (let i = 0; i < 4; i++) {
      const diff = Number(partsA[i]) - Number(partsB[i]);
      if (diff !== 0) return diff;
    }
    return 0;
  }
  return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
}

function buildAdjacency(nodeIds, edges) {
  const adj = new Map();
  nodeIds.forEach(id => adj.set(id, new Set()));
  edges.forEach(e => {
    if (!adj.has(e.from) || !adj.has(e.to)) return;
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  });
  return adj;
}

// BFS distances from `startId` to every reachable node.
function bfsDistances(adj, startId) {
  const dist = new Map([[startId, 0]]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = Array.from(adj.get(current) || []).sort(compareIpIds);
    for (const next of neighbors) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(current) + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

export function computeGraphRoot(nodeIds, edges) {
  if (nodeIds.length === 0) return null;
  if (nodeIds.length === 1) return nodeIds[0];

  const adj = buildAdjacency(nodeIds, edges);
  let bestId = null;
  let bestEccentricity = Infinity;

  const sortedIds = Array.from(nodeIds).sort(compareIpIds);
  for (const id of sortedIds) {
    const dist = bfsDistances(adj, id);
    let eccentricity = 0;
    for (const d of dist.values()) eccentricity = Math.max(eccentricity, d);
    if (eccentricity < bestEccentricity) {
      bestEccentricity = eccentricity;
      bestId = id;
    }
  }
  return bestId;
}

export function buildPrimaryTree(nodeIds, edges, rootId) {
  const adj = buildAdjacency(nodeIds, edges);
  const parentOf = new Map([[rootId, null]]);
  const childrenOf = new Map([[rootId, []]]);
  const treeEdgeKeys = new Set();

  const edgeKey = (a, b) => [a, b].sort(compareIpIds).join('|');

  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = Array.from(adj.get(current) || []).sort(compareIpIds);
    for (const next of neighbors) {
      if (!parentOf.has(next)) {
        parentOf.set(next, current);
        childrenOf.set(next, []);
        childrenOf.get(current).push(next);
        treeEdgeKeys.add(edgeKey(current, next));
        queue.push(next);
      }
    }
  }

  const secondaryEdges = edges.filter(e => !treeEdgeKeys.has(edgeKey(e.from, e.to)));

  return { parentOf, childrenOf, secondaryEdges };
}
