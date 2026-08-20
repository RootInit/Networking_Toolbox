// Computes positions for the currently-visible subgraph via
// GraphLayout.computeRecursiveRadialLayout (graph-layout.js) - despite the filename, ELK
// is no longer used for the primary path. It was originally: this file wrapped a vendored
// ELK.js instance, and computeRecursiveRadialLayout was a post-process applied on top of
// ELK's own output. ELK's structural placement was replaced entirely once it was confirmed
// (via headless-browser screenshot, not just reasoning) to collapse whole depth levels
// near the root when the network's full leaf tier was exposed at once - see
// graph-layout.js's header comment on computeRecursiveRadialLayout for the full history.
// The file keeps its name so callers (app.js, network_vis.html's <script> tag) don't need
// to change; `window.ElkLayout` is what's actually referenced elsewhere.
//
// computeGridFallback remains as the last-resort safety net if computeRecursiveRadialLayout
// ever throws or the visible set is pathologically large enough to hit the timeout below -
// it needs no browser globals, so it (and this file generally) still imports cleanly under
// `node --test`, unlike the vendored ELK bundle this file used to depend on.

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
        // err.message could in principle come from somewhere not fully in this app's
        // control - build the message via textContent rather than concatenating it into
        // innerHTML, so it can never be interpreted as markup.
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
