// Computes positions for the visible subgraph via GraphLayout.computeRecursiveRadialLayout
// (graph-layout.js). ELK.js is not used despite the filename; the `window.ElkLayout` name is
// kept so callers don't need to change.

const NODE_WIDTH = 160;
const NODE_HEIGHT = 50;
const LAYOUT_TIMEOUT_MS = 8000;

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

async function computeLayout(visibleNodeIds, visibleEdges, layoutSettings) {
  if (visibleNodeIds.length === 0) return new Map();

  // Absolute deadline from "now", not from when doLayout's yield resolves, so it shares the
  // race timer's budget.
  const deadline = Date.now() + LAYOUT_TIMEOUT_MS;

  const doLayout = async () => {
    // Yield once so "Computing layout..." can paint before the synchronous crunch blocks
    // the main thread.
    await new Promise(r => setTimeout(r, 0));
    const childrenOf = new Map();
    const hasIncomingEdge = new Set();
    visibleEdges.forEach(e => {
      if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
      childrenOf.get(e.from).push(e.to);
      hasIncomingEdge.add(e.to);
    });

    // Besides the primary root, disconnected fabric islands (kept by buildPrimaryTree) also
    // have no incoming edge. Each needs its own layout pass, or graph.js defaults every
    // unpositioned node to (0, 0) and stacks the components on top of each other.
    const roots = visibleNodeIds.filter(id => !hasIncomingEdge.has(id));
    const positions = new Map();
    // Each component is centred at cursorX and pushes cursorX out by its own extent, so
    // bounding circles stay NODE_WIDTH*3 apart whatever the relative sizes. A fixed offset
    // derived only from the previous component's extent lets a wider later one overlap it.
    let cursorX = null;
    for (const root of roots) {
      const sub = window.GraphLayout.computeRecursiveRadialLayout(root, childrenOf, { ...layoutSettings, deadline });
      let extent = 0;
      sub.forEach(pos => {
        extent = Math.max(extent, Math.abs(pos.x), Math.abs(pos.y));
      });
      const centerX = (cursorX === null) ? 0 : cursorX + extent;
      sub.forEach((pos, id) => positions.set(id, { x: pos.x + centerX, y: pos.y }));
      cursorX = centerX + extent + NODE_WIDTH * 3;
    }
    return positions;
  };

  // Backstop only: JS is single-threaded, so this timer cannot preempt doLayout()'s
  // synchronous work - by the time the event loop runs it, doLayout() has already settled.
  // The `deadline` above is what actually bounds a slow layout. timeoutId is tracked so the
  // winning path can clear it; otherwise it keeps `node --test` alive ~9s per call.
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Layout timed out')), LAYOUT_TIMEOUT_MS + 1000);
  });

  try {
    return await Promise.race([doLayout(), timeout]);
  } catch (err) {
    console.error('Layout failed, falling back to a grid:', err);
    if (typeof document !== 'undefined') {
      var textEl = document.getElementById('fatal-error-text');
      var modalEl = document.getElementById('fatal-error-modal');
      if (textEl && modalEl) {
        // innerHTML is safe here only because the markup is a fixed literal; err.message is
        // appended via textContent below so it can never be interpreted as markup.
        textEl.innerHTML = 'Layout engine failed, showing a basic grid instead of the normal tree view.<br><br>';
        var errMsgEl = document.createElement('span');
        errMsgEl.textContent = (err && err.message) ? err.message : String(err);
        textEl.appendChild(errMsgEl);
        modalEl.style.display = 'block';
      }
    }
    return computeGridFallback(visibleNodeIds);
  } finally {
    clearTimeout(timeoutId);
  }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeGridFallback, computeLayout };
} else if (typeof window !== 'undefined') {
    window.ElkLayout = { computeGridFallback, computeLayout };
}
