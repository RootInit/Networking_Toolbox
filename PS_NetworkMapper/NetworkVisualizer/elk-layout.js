// Wraps a vendored ELK.js instance to lay out the currently-visible subgraph.
// Runs on the main thread (see getElk() below for why - a Web Worker cannot load
// under file://, which this tool must support), with a deterministic grid
// fallback if layout errors or takes too long. `ELK` is a browser global from
// vendor/elk.bundled.js, loaded via a classic <script> tag before this file -
// referenced lazily (inside computeLayout, not at module scope) so this file
// still imports cleanly under `node --test`, where computeGridFallback is
// exercised without a browser.

const NODE_WIDTH = 160;
const NODE_HEIGHT = 50;
const LAYOUT_TIMEOUT_MS = 8000;

let elkInstance = null;
function getElk() {
  if (!elkInstance) {
    // No workerUrl/workerFactory: constructing ELK this way runs layout on the main
    // thread instead of a Web Worker. This is required, not just simpler - a Worker's
    // script fetch is rejected under file:// ("cannot be accessed from origin 'null'",
    // confirmed empirically), which this tool must support with no local web server
    // available. Clustering (graph-layout.js) keeps the typically-visible subgraph to a
    // few dozen nodes, so the main-thread cost here is not noticeable in normal use.
    elkInstance = new ELK();
  }
  return elkInstance;
}

function computeGridFallback(visibleNodeIds) {
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

async function computeLayout(visibleNodeIds, visibleEdges) {
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
    if (typeof document !== 'undefined') {
      var textEl = document.getElementById('fatal-error-text');
      var modalEl = document.getElementById('fatal-error-modal');
      if (textEl && modalEl) {
        // err.message could in principle come from somewhere ELK doesn't fully control
        // (e.g. a malformed graph shape) - build the message via textContent rather than
        // concatenating it into innerHTML, so it can never be interpreted as markup.
        textEl.innerHTML = 'Layout engine failed, showing a basic grid instead of the normal tree view.<br><br>';
        var errMsgEl = document.createElement('span');
        errMsgEl.textContent = (err && err.message) ? err.message : String(err);
        textEl.appendChild(errMsgEl);
        modalEl.style.display = 'block';
      }
    }
    return computeGridFallback(visibleNodeIds);
  }
}

// See graph-layout.js's matching footer for why this isn't `export`/`type="module"`.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeGridFallback, computeLayout };
} else if (typeof window !== 'undefined') {
    window.ElkLayout = { computeGridFallback, computeLayout };
}
