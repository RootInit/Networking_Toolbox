import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// vis-network redraws the whole canvas synchronously on every DataSet change, so the cost is set by
// how many times the datasets are written. doRenderVisibleGraph is run against stubs to count them.
const src = fs.readFileSync(new URL('../graph.js', import.meta.url), 'utf8');

function makeDataset() {
  const ds = { rows: [], addCalls: 0, clearCalls: 0 };
  ds.add = (rowOrRows) => { ds.addCalls++; ds.rows.push(...(Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows])); };
  ds.clear = () => { ds.clearCalls++; ds.rows.length = 0; };
  return ds;
}

// A star, plus one secondary (non-tree) link between two leaves to exercise that branch.
function fixture(leaves) {
  const ids = ['root', ...Array.from({ length: leaves }, (_, i) => `n${i}`)];
  const visibleEdges = ids.slice(1).map(id => ({ from: 'root', to: id }));
  return {
    visible: {
      visibleNodeIds: ids,
      visibleEdges,
      clusters: new Map(),
      hiddenNodeToCluster: new Map(),
    },
    allNodeMeta: new Map(ids.map(id => [id, { label: id, shape: 'box', isStack: false, scanned: true, vlanCache: [] }])),
    secondaryEdges: leaves >= 2 ? [{ from: 'n0', to: 'n1' }] : [],
  };
}

// doRenderVisibleGraph reads its collaborators as free variables, supplied here as parameters.
// `fitOnNextRender` is a module-level var it writes back to, seeded through a getter/setter.
const BODY = src.match(/var fitOnNextRender = false;/)[0] + '\n' +
  'fitOnNextRender = state.fit;\n' +
  src.match(/async function doRenderVisibleGraph\(\)[\s\S]*?\n\}/)[0] +
  '\nreturn doRenderVisibleGraph().then(() => { state.fit = fitOnNextRender; });';

async function render(leaves, opts) {
  const o = opts || {};
  const fx = fixture(leaves);
  const nodesDataset = makeDataset();
  const edgesDataset = makeDataset();
  const network = { fitCalls: 0, fit() { this.fitCalls++; } };
  const state = { fit: o.fitOnNextRender !== false };
  await new Function(
    'renderGeneration', 'window', 'nextPaint', 'graphRoot', 'primaryTree', 'expandedNodes',
    'getClusterThreshold', 'getLayoutSettings', 'nodesDataset', 'edgesDataset', 'allNodeMeta',
    'document', 'network', 'diagramSizedWhileHidden', 'state', BODY,
  )(
    0,
    {
      showProgress: () => {}, hideProgress: () => {}, applyVlanFilter: () => {},
      GraphLayout: { computeVisibleTree: () => fx.visible },
      ElkLayout: { computeLayout: async (ids) => new Map(ids.map(id => [id, { x: 0, y: 0 }])) },
    },
    async () => {},
    'root',
    { childrenOf: new Map(), extraRoots: [], secondaryEdges: fx.secondaryEdges },
    new Set(),
    () => 999, () => ({}),
    nodesDataset, edgesDataset, fx.allNodeMeta,
    { getElementById: () => null },
    network,
    !!o.sizedWhileHidden,
    state,
  );
  return { nodesDataset, edgesDataset, network, fitStillPending: state.fit };
}

test('the node and edge datasets are each written once, however many items there are', async () => {
  const small = await render(3);
  const large = await render(400);
  assert.equal(small.nodesDataset.addCalls, 1);
  assert.equal(small.edgesDataset.addCalls, 1);
  assert.equal(large.nodesDataset.addCalls, 1, 'a per-item add would cost one full canvas redraw per node');
  assert.equal(large.edgesDataset.addCalls, 1, 'a per-item add would cost one full canvas redraw per edge');
});

test('batching does not change what ends up in the datasets', async () => {
  const { nodesDataset, edgesDataset } = await render(4);
  assert.deepEqual(nodesDataset.rows.map(r => r.id), ['root', 'n0', 'n1', 'n2', 'n3']);
  assert.deepEqual(
    edgesDataset.rows.map(r => r.id),
    ['primary-0', 'primary-1', 'primary-2', 'primary-3', 'secondary-0'],
  );
  assert.equal(nodesDataset.clearCalls, 1);
  assert.equal(edgesDataset.clearCalls, 1);
});

test('the first render of a new network instance fits the camera, later ones do not', async () => {
  const first = await render(50);
  assert.equal(first.network.fitCalls, 1, 'a fresh instance opens at 1:1 on the origin');
  assert.equal(first.fitStillPending, false, 'the fit is consumed, not repeated');

  const rerender = await render(50, { fitOnNextRender: false });
  assert.equal(rerender.network.fitCalls, 0, 'a cluster expand must not discard the user pan/zoom');
});

test('a diagram rendered while hidden defers its fit to resizeDiagram', async () => {
  // fit() against a display:none container measures 0 and produces a degenerate transform.
  const hidden = await render(50, { sizedWhileHidden: true });
  assert.equal(hidden.network.fitCalls, 0);
});
