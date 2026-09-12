// Computes positions for the visible subgraph via GraphLayout.computeRecursiveRadialLayout. ELK.js
// is not used despite the filename; the `window.ElkLayout` name is kept so callers don't change.

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

  // Absolute deadline from "now", so it shares the race timer's budget.
  const deadline = Date.now() + LAYOUT_TIMEOUT_MS;

  const doLayout = async () => {
    // Yield once so "Computing layout..." can paint before the synchronous crunch.
    await new Promise(r => setTimeout(r, 0));
    const childrenOf = new Map();
    const hasIncomingEdge = new Set();
    visibleEdges.forEach(e => {
      if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
      childrenOf.get(e.from).push(e.to);
      hasIncomingEdge.add(e.to);
    });

    // Besides the primary root, disconnected islands also have no incoming edge. Each needs its own
    // pass, or graph.js defaults every unpositioned node to (0, 0) and stacks the components.
    const roots = visibleNodeIds.filter(id => !hasIncomingEdge.has(id));
    const positions = new Map();
    // Each component is centred at cursorX and pushes it out by its own extent; an offset derived
    // only from the previous component's extent lets a wider later one overlap.
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

  // Backstop only: JS is single-threaded, so this timer cannot preempt doLayout()'s synchronous
  // work - `deadline` is what bounds it. timeoutId is cleared, or `node --test` idles ~9s per call.
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
        // innerHTML is safe only because the markup is a fixed literal; err.message goes via textContent.
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
