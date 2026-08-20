// Wraps a vendored ELK.js instance to lay out the currently-visible subgraph
// in a Web Worker (never on the main thread), with a deterministic grid
// fallback if the worker errors or takes too long. `ELK` is a browser global
// from vendor/elk.bundled.js, loaded via a classic <script> tag before this
// module - referenced lazily (inside computeLayout, not at module scope) so
// this file still imports cleanly under `node --test`, where computeGridFallback
// is exercised without a browser.

const NODE_WIDTH = 160;
const NODE_HEIGHT = 50;
const LAYOUT_TIMEOUT_MS = 8000;

let elkInstance = null;
function getElk() {
  if (!elkInstance) {
    elkInstance = new ELK({ workerUrl: 'vendor/elk-worker.min.js' });
  }
  return elkInstance;
}

export function computeGridFallback(visibleNodeIds) {
  const positions = new Map();
  const perRow = Math.ceil(Math.sqrt(visibleNodeIds.length)) || 1;
  visibleNodeIds.forEach((id, i) => {
    positions.set(id, {
      x: (i % perRow) * (NODE_WIDTH + 60),
      y: Math.floor(i / perRow) * (NODE_HEIGHT + 80),
    });
  });
  return positions;
}

export async function computeLayout(visibleNodeIds, visibleEdges) {
  if (visibleNodeIds.length === 0) return new Map();

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    },
    children: visibleNodeIds.map(id => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: visibleEdges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('ELK layout timed out')), LAYOUT_TIMEOUT_MS);
  });

  try {
    const laidOut = await Promise.race([getElk().layout(graph), timeout]);
    const positions = new Map();
    laidOut.children.forEach(n => positions.set(n.id, { x: n.x, y: n.y }));
    return positions;
  } catch (err) {
    console.error('ELK layout failed, falling back to a grid:', err);
    return computeGridFallback(visibleNodeIds);
  }
}
