// Computes positions for the visible subgraph via GraphLayout.computeRecursiveRadialLayout
// (graph-layout.js). Despite the filename, ELK.js is no longer used - it collapsed depth
// levels near the root with a full leaf tier exposed. Kept as `window.ElkLayout`/this
// filename so callers (app.js, network_vis.html) don't need to change.
// computeGridFallback is the last-resort safety net if the layout throws or times out.

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

  const doLayout = async () => {
    // Yield once so the caller's "Computing layout..." text can paint before the
    // synchronous layout crunch blocks the main thread.
    await new Promise(r => setTimeout(r, 0));
    const childrenOf = new Map();
    visibleEdges.forEach(e => {
      if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
      childrenOf.get(e.from).push(e.to);
    });
    return window.GraphLayout.computeRecursiveRadialLayout(visibleNodeIds[0], childrenOf, layoutSettings);
  };

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Layout timed out')), LAYOUT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([doLayout(), timeout]);
  } catch (err) {
    console.error('Layout failed, falling back to a grid:', err);
    if (typeof document !== 'undefined') {
      var textEl = document.getElementById('fatal-error-text');
      var modalEl = document.getElementById('fatal-error-modal');
      if (textEl && modalEl) {
        // Build via textContent, not innerHTML, so err.message can't be interpreted as markup.
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeGridFallback, computeLayout };
} else if (typeof window !== 'undefined') {
    window.ElkLayout = { computeGridFallback, computeLayout };
}
