import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildConnections, visibleConnections, layoutConnections, labelLines, CARD } from '../public/connections-model.js';
import { readConnectionData } from '../public/connections-viewer.js';
const captureId = '11111111-1111-4111-8111-111111111111';
const index = {
  themes: [
    { id: 'root', question: '社会はどう変わる？', state: 'active', integration_count: 3, content: 'AIと仕事' },
    { id: 'middle', question: '仕事はどう変わる？', state: 'active', integration_count: 1 },
    { id: 'leaf', question: '人に残る仕事は？', state: 'active' },
    { id: 'seed', question: '学び方はどう変わる？', state: 'active' },
  ],
  branches: [{ parent_id: 'root', child_id: 'middle' }, { parent_id: 'middle', child_id: 'leaf' }, { parent_id: 'root', child_id: 'seed' }],
};
const detail = (id, version = 1) => ({ theme: { id }, stale: false,
  children: [{ child_kind: 'capture', child_id: captureId, child_version: version, title: '元の記録' }],
  materials: [{ capture_id: captureId, capture_version: 1, reason: '関連する事例' }] });

test('saved hierarchy: unequal-depth inputs are not flattened', () => {
  const graph = buildConnections(index), layout = layoutConnections(graph);
  assert.equal(graph.nodes.length, 4); assert.equal(graph.edges.length, 3);
  const at = id => layout.positions.get(`theme:${id}`);
  assert.ok(at('root').y < at('middle').y); assert.ok(at('middle').y < at('leaf').y);
  assert.equal(at('leaf').y, at('seed').y);
});
test('one shared record, two saved edges, no inferred theme edge', () => {
  const graph = buildConnections(index, new Map([['leaf', detail('leaf')], ['seed', detail('seed')]]));
  assert.equal(graph.nodes.filter(n => n.kind === 'capture').length, 1);
  assert.equal(graph.edges.filter(e => e.to === `capture:${captureId}`).length, 2);
  assert.equal(graph.edges.filter(e => e.from === 'theme:leaf' && e.to === 'theme:seed').length, 0);
});
test('input snapshots must match the current membership version', () => {
  const graph = buildConnections(index, new Map([['root', detail('root', 2)]]));
  const edge = graph.edges.find(e => e.to.startsWith('capture:'));
  assert.equal(edge.kind, 'material');
  assert.equal(graph.nodes.find(n => n.kind === 'capture').title, '記録');
});
test('historical children cannot resurrect removed material', () => {
  const data = detail('root'); data.materials = [];
  assert.equal(buildConnections(index, new Map([['root', data]])).nodes.length, 4);
});
test('hidden and merged themes and dangling edges stay absent', () => {
  const graph = buildConnections({ themes: [...index.themes, { id: 'hidden', hidden: true }, { id: 'merged', state: 'merged' }],
    branches: [...index.branches, { parent_id: 'hidden', child_id: 'root' }, { parent_id: 'root', child_id: 'missing' }] },
    new Map([['hidden', detail('hidden')]]));
  assert.equal(graph.nodes.length, 4); assert.equal(graph.edges.length, 3);
});
test('duplicate edges and self-edges do not duplicate rendered data', () => {
  const graph = buildConnections({ ...index, branches: [...index.branches, ...index.branches, { parent_id: 'root', child_id: 'root' }] });
  assert.equal(graph.edges.length, 3);
});
test('a fetched newer/deleted record removes obsolete current-material edges', () => {
  const details = new Map([['root', detail('root')]]);
  for (const capture of [{ version: 2 }, { unavailable: true }, { hidden: true }]) {
    const graph = buildConnections(index, details, new Map([[captureId, capture]]));
    assert.equal(graph.nodes.filter(n => n.kind === 'capture').length, 0);
  }
});
test('IDs remain namespaced for themes and records', () => {
  const graph = buildConnections({ themes: [{ id: captureId, question: '問い' }], branches: [] }, new Map([[captureId, detail(captureId)]]));
  assert.equal(new Set(graph.nodes.map(n => n.id)).size, 2);
});
test('stale results are signalled rather than represented as verified', () => {
  const data = detail('root'); data.stale = true;
  const graph = buildConnections(index, new Map([['root', data]]));
  assert.equal(graph.nodes.find(n => n.entityId === 'root').stale, true);
  assert.equal(graph.edges.find(e => e.to.startsWith('capture:')).stale, true);
});
test('local search includes optional content and direct saved neighbours', () => {
  const graph = buildConnections(index), shown = visibleConnections(graph, 'ａｉ');
  assert.deepEqual([...shown.matched], ['theme:root']);
  assert.equal(shown.nodes.length, 3); assert.equal(shown.edges.length, 2);
  assert.equal(visibleConnections(graph, '存在しない').nodes.length, 0);
});
test('large graphs give explicit clipping metadata and prioritise search matches', () => {
  const graph = buildConnections({ themes: Array.from({ length: 450 }, (_, i) => ({ id: `t${i}`, question: `問い${i}` })), branches: [] });
  const shown = visibleConnections(graph, '', 'theme:t449');
  assert.equal(shown.total, 450); assert.equal(shown.nodes.length, 300); assert.equal(shown.truncated, true);
  assert.equal(shown.nodes[0].id, 'theme:t449');
  assert.equal(visibleConnections(graph, '問い449').nodes[0].id, 'theme:t449');
});
test('empty and disconnected graphs have finite non-overlapping cards', () => {
  const empty = layoutConnections({ nodes: [], edges: [] }); assert.ok(empty.width > 0);
  const graph = buildConnections({ themes: [...index.themes, { id: 'alone', question: '独立' }], branches: index.branches });
  const layout = layoutConnections(graph), boxes = [...layout.positions.values()];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(a.x + CARD.width <= b.x || b.x + CARD.width <= a.x || a.y + CARD.height <= b.y || b.y + CARD.height <= a.y);
  }
});
test('cycles terminate and are reported; 2000-level histories do not recurse', () => {
  const cyclic = layoutConnections(buildConnections({ themes: index.themes,
    branches: [...index.branches, { parent_id: 'leaf', child_id: 'root' }] }));
  assert.ok(cyclic.cyclic.size > 0); assert.equal(cyclic.positions.size, 4);
  const themes = Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, question: `問い${i}` }));
  const branches = themes.slice(1).map((t, i) => ({ parent_id: `n${i}`, child_id: t.id }));
  const deep = layoutConnections(buildConnections({ themes, branches }));
  assert.equal(deep.positions.size, 2000); assert.equal(deep.cyclic.size, 0);
});
test('Japanese and emoji labels have bounded readable lines', () => {
  assert.equal(labelLines('👨仕事の変化を理解する問い'.repeat(5)).length, 2);
  assert.ok(labelLines('非常に長い主題です'.repeat(8))[1].endsWith('…'));
  assert.equal(labelLines('短い問い').join(''), '短い問い');
});
test('all requests are GET, same-origin, no-store and cancellable', async () => {
  const controller = new AbortController(), calls = [];
  for (const path of ['/api/themes', '/api/themes/candidate%3Aabc', `/api/captures/${captureId}`]) {
    const result = await readConnectionData(path, controller.signal, async (path, options) => {
      calls.push({ path, options }); return Response.json({ ok: true });
    });
    assert.deepEqual(result, { ok: true });
  }
  for (const { options } of calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store'); assert.equal(options.signal, controller.signal); assert.equal(options.body, undefined);
  }
});
test('write actions and external URLs cannot be requested by the viewer', async () => {
  for (const path of ['/api/book/discover', '/api/themes/x/rebuild', '/api/graph/rebuild', 'https://example.com', '/api/themes?q=AI']) {
    await assert.rejects(readConnectionData(path, undefined, () => { throw new Error('must not fetch'); }), /表示対象/);
  }
});
test('authentication HTML and denied responses are not rendered as data', async () => {
  for (const response of [new Response('', { status: 401 }), new Response('', { status: 403 }), new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })]) {
    await assert.rejects(readConnectionData('/api/themes', undefined, async () => response), e => e.auth === true);
  }
  await assert.rejects(readConnectionData('/api/themes', undefined, async () => new Response('', { status: 404 })), e => e.missing === true);
});
test('viewer renders untrusted text without HTML and has no persistent data store', async () => {
  const source = await readFile(new URL('../public/connections-viewer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|eval\(/);
  assert.match(source, /controller\.abort\(\)/); assert.match(source, /serial !== requestNumber/);
});

test('an untyped index link is a parent/child relation, not assumed integration', () => {
  assert.ok(buildConnections(index).edges.every(e => e.kind === 'hierarchy'));
});
test('detail distinguishes integration from drilldown in either direction', () => {
  const root = { theme: { id: 'root' }, children: [{ child_kind: 'theme', child_id: 'middle' }],
    drilldown_children: [{ id: 'seed' }], materials: [] };
  const graph = buildConnections(index, new Map([['root', root]]));
  assert.equal(graph.edges.find(e => e.to === 'theme:middle').kind, 'input');
  assert.equal(graph.edges.find(e => e.to === 'theme:seed').kind, 'drilldown');
  const child = { theme: { id: 'seed' }, drilldown_parents: [{ id: 'root' }] };
  assert.equal(buildConnections(index, new Map([['seed', child]])).edges.find(e => e.to === 'theme:seed').kind, 'drilldown');
});
