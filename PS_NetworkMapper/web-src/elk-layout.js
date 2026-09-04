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
  // resolves, so it reflects the same budget the vestigial race timer below uses.
  const deadline = Date.now() + LAYOUT_TIMEOUT_MS;

  const doLayout = async () => {
    // Yield once so the caller's "Computing layout..." text can paint before the
    // synchronous layout crunch blocks the main thread.
    await new Promise(r => setTimeout(r, 0));
    const childrenOf = new Map();
    const hasIncomingEdge = new Set();
    visibleEdges.forEach(e => {
      if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
      childrenOf.get(e.from).push(e.to);
      hasIncomingEdge.add(e.to);
    });

    // Normally there's exactly one such node - the primary graph root. But a
    // disconnected fabric island (graph-layout.js's buildPrimaryTree attaches those as
    // extra top-level entries in visible.visibleNodeIds/visibleEdges rather than
    // dropping them) surfaces here too: it has no incoming visible edge either, since
    // nothing connects it to the main tree. Laying out only visibleNodeIds[0]'s subtree
    // would leave every other component with no computed position at all (graph.js
    // would then default them all to the same (0, 0), stacking them on top of each
    // other) - so each root gets its own independent layout pass, offset along x so the
    // components render as separate, non-overlapping trees.
    const roots = visibleNodeIds.filter(id => !hasIncomingEdge.has(id));
    const positions = new Map();
    // cursorX tracks where the NEXT component's own center should land, computed from
    // the true extent of the component just placed (not a fixed/one-sided guess) - a
    // fixed offset derived only from the previous component's extent broke down whenever
    // a later component (e.g. an unbalanced island, laid out with a much larger radius
    // than a big-but-round main tree) was wider than the one before it: the two could
    // still overlap. Each component is centered at cursorX and pushes cursorX out by its
    // own extent afterward, so the gap between any two components' bounding circles is
    // always at least NODE_WIDTH*3, regardless of ordering or relative size.
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

  // This race is kept as a backstop (e.g. an infinite loop/bug outside computeRecursiveRadialLayout's
  // own deadline checks) but can no longer be the primary enforcement: JS is single-threaded,
  // so a pending setTimeout here cannot preempt doLayout()'s synchronous work - by the time
  // control returns to the event loop for this timer to even run, doLayout() has already
  // settled, whether that took 1 second or 100. computeRecursiveRadialLayout's own `deadline`
  // check above is what actually bounds a slow layout now; see its comment for why.
  // Tracked so it can be cleared once doLayout() wins the race (the normal case) -
  // otherwise this timer keeps a Node process (e.g. `node --test`) alive for another
  // ~9s after every call, waiting to fire a rejection nothing will ever see.
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
        // Static wrapper markup is a fixed literal, so innerHTML here is safe; the untrusted
        // part (err.message) is appended below via textContent, not interpreted as markup.
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
