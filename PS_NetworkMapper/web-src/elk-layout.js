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

  // Absolute deadline, computed from "now" rather than from whenever doLayout's yield below
  // resolves, so it reflects the same budget the (now-vestigial, see below) race timer used.
  const deadline = Date.now() + LAYOUT_TIMEOUT_MS;

  const doLayout = async () => {
    // Yield once so the caller's "Computing layout..." text can paint before the
    // synchronous layout crunch blocks the main thread.
    await new Promise(r => setTimeout(r, 0));
    const childrenOf = new Map();
    visibleEdges.forEach(e => {
      if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
      childrenOf.get(e.from).push(e.to);
    });
    return window.GraphLayout.computeRecursiveRadialLayout(visibleNodeIds[0], childrenOf, { ...layoutSettings, deadline });
  };

  // This race is kept as a backstop (e.g. an infinite loop/bug outside computeRecursiveRadialLayout's
  // own deadline checks) but can no longer be the primary enforcement: JS is single-threaded,
  // so a pending setTimeout here cannot preempt doLayout()'s synchronous work - by the time
  // control returns to the event loop for this timer to even run, doLayout() has already
  // settled, whether that took 1 second or 100. computeRecursiveRadialLayout's own `deadline`
  // check above is what actually bounds a slow layout now; see its comment for why.
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Layout timed out')), LAYOUT_TIMEOUT_MS + 1000);
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
