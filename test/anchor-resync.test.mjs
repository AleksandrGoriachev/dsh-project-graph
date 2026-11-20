/**
 * 0301: пересинхронизация якорей при добавлении/удалении якоря.
 *
 * Тесты держат инварианты задания:
 *   C1 — добавленный якорь доходит до агентских узлов, к роли которых он
 *        применим (0299), удалённый уходит из consumes; ручной выбор
 *        (anchors.source === 'user') не меняется;
 *   C2 — повторный проход на том же входе даёт changes: [], папки обмена целы,
 *        битый и безролевой документ — ok:false без единого изменения;
 *   запись — lib/api.js приводит структуру к документу только при непустых
 *   changes и только существующим атомарным путём; PUT /api/anchors сообщает
 *   changes/skipped в ответе, а fail-closed документ оставляет структуру как была.
 *
 * Файл работает и как обычный node-скрипт (node test/anchor-resync.test.mjs),
 * и под node --test: провал выставляет exit-код 1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANCHOR_RESYNC_SKIP, resyncAnchorRefs } from '../lib/anchors.js';
import { createGraphRuntime, createWebHandler, resyncStructureAnchors, API_PREFIX } from '../lib/api.js';
import { readAnchorsDoc } from '../lib/anchors-editor.js';

let passed = 0;
const failures = [];
async function test(name, body) {
  try {
    await body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

const ANCHOR_BASE = {
  claim: 'утверждение',
  check: 'node checks/x.mjs c1',
  status: 'auto',
  layer: 'project',
  sides: 'project',
  enforcedBy: 'nodes',
};
const v3anchor = (id, roles) => ({ ...ANCHOR_BASE, id, appliesTo: { roles } });
const v2anchor = (id) => ({ ...ANCHOR_BASE, id });
const v3doc = (...anchors) => ({ version: 3, anchors });
const v2doc = (...anchors) => ({ version: 2, anchors });
const ids = (items) => (items || []).map((item) => item.id);
const nodeOf = (graph, id) => (graph.nodes || []).find((node) => node && node.id === id);
const changeOf = (result, id) => (result.changes || []).find((item) => item.nodeId === id);
const skipOf = (result, id) => (result.skipped || []).find((item) => item.nodeId === id);

const FOLDER = {
  id: 'folder-1',
  box: { path: 'coordination', root: 'workspace' },
  participants: ['structure', 'workflow'],
  orchestrator: 'coordinator',
};

/* Тот же расклад, что у приёмки: координаторский узел, ручной и без якорей. */
function graphWith() {
  return {
    nodes: [
      { id: 'r1', role: 'Ревьюер', anchors: { consumes: ['A1'], source: 'coordinator' } },
      { id: 'u1', role: 'Ревьюер', anchors: { consumes: ['A1'], source: 'user' } },
      { id: 'c1', role: 'координатор' },
    ],
    edges: [{ from: 'c1', to: 'r1', kind: 'review' }],
    folders: [FOLDER],
  };
}

/* ---------- C1: добавление и удаление якоря ---------- */

await test('добавленный якорь доходит до узла по роли, ручной выбор не тронут', () => {
  const doc = v3doc(v3anchor('A1', ['ревьюер']), v3anchor('A2', ['приёмщик']), v3anchor('A3', ['ревьюер']));
  const result = resyncAnchorRefs(graphWith(), doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(nodeOf(result.graph, 'r1').anchors.consumes, ['A1', 'A3'],
    'применимый якорь A3 добавлен к прежнему A1');
  assert.deepEqual(nodeOf(result.graph, 'u1').anchors, { consumes: ['A1'], source: 'user' },
    'ручной выбор неприкосновенен');
  assert.equal(changeOf(result, 'u1'), undefined, 'ручной узел не в changes');
  assert.equal(skipOf(result, 'u1').reason, ANCHOR_RESYNC_SKIP.USER, 'ручной узел назван в skipped');
  assert.equal(changeOf(result, 'c1'), undefined, 'роли координатора якоря не применимы — изменений нет');
});

await test('узел без привязки получает применимые якоря и source coordinator', () => {
  const graph = graphWith();
  graph.nodes.push({ id: 'p1', role: 'ревьюер' });
  const doc = v3doc(v3anchor('A1', ['ревьюер']));
  const result = resyncAnchorRefs(graph, doc);
  assert.equal(result.ok, true);
  assert.deepEqual(nodeOf(result.graph, 'p1').anchors, { consumes: ['A1'], source: 'coordinator' },
    'пересинхронизация проходит по всем агентским узлам, а не только по уже привязанным');
  assert.deepEqual(changeOf(result, 'p1').added, ['A1']);
});

await test('удалённый якорь уходит из consumes; роль без применимых — пустой вход', () => {
  const result = resyncAnchorRefs(graphWith(), v3doc(v3anchor('A2', ['приёмщик'])));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const after = nodeOf(result.graph, 'r1');
  assert.deepEqual(after.anchors.consumes, [], 'удалённый якорь не остаётся «как было» (инвариант 4)');
  assert.deepEqual(changeOf(result, 'r1').removed, ['A1']);
  assert.deepEqual(nodeOf(result.graph, 'u1').anchors.consumes, ['A1'], 'ручной узел сохраняет удалённый якорь');
});

await test('пустой документ якорей снимает все ссылки, узлы без привязки не трогает', () => {
  const result = resyncAnchorRefs(graphWith(), v3doc());
  assert.equal(result.ok, true, 'пустой список — законный документ, а не безролевой');
  assert.deepEqual(nodeOf(result.graph, 'r1').anchors.consumes, []);
  assert.equal(nodeOf(result.graph, 'c1').anchors, undefined, 'узлу без применимых якорей привязка не выдумывается');
});

/* ---------- C2: идемпотентность, папки, битый документ ---------- */

await test('повтор на результате первого прохода даёт changes: []', () => {
  const doc = v3doc(v3anchor('A1', ['ревьюер']), v3anchor('A3', ['ревьюер']));
  const first = resyncAnchorRefs(graphWith(), doc);
  const second = resyncAnchorRefs(first.graph, doc);
  assert.equal(second.ok, true);
  assert.deepEqual(second.changes, [], 'повтор идемпотентен');
  assert.equal(JSON.stringify(second.graph), JSON.stringify(first.graph), 'граф не «дрожит»');
});

await test('папки и рёбра не меняются; узел-папка в nodes не трогается', () => {
  const graph = graphWith();
  graph.nodes.push({ id: 'folder-node', role: 'обмен', box: { path: 'exchange' } });
  const doc = v3doc(v3anchor('A1', ['ревьюер']));
  const result = resyncAnchorRefs(graph, doc);
  assert.equal(result.ok, true);
  assert.deepEqual(result.graph.folders, [FOLDER], 'список папок цел');
  assert.deepEqual(result.graph.edges, graph.edges, 'рёбра целы');
  assert.deepEqual(nodeOf(result.graph, 'folder-node'), { id: 'folder-node', role: 'обмен', box: { path: 'exchange' } },
    'папка семантической нагрузки не несёт');
  assert.equal(skipOf(result, 'folder-node').reason, ANCHOR_RESYNC_SKIP.FOLDER);
});

await test('битый документ: ok:false, changes: [], граф байт в байт', () => {
  const broken = [
    null,
    undefined,
    42,
    'anchors',
    {},
    { version: 3 },
    { version: 3, anchors: 'nope' },
    { version: 3, anchors: [1, 2] },
    v3doc(v3anchor('', ['ревьюер'])),
    v3doc(v3anchor('A1', ['ревьюер']), v3anchor('a1', ['ревьюер'])),
  ];
  for (const doc of broken) {
    const graph = graphWith();
    const before = JSON.stringify(graph);
    let result;
    assert.doesNotThrow(() => { result = resyncAnchorRefs(graph, doc); }, JSON.stringify(doc) + ' — исключение');
    assert.equal(result.ok, false, JSON.stringify(doc) + ': ' + JSON.stringify(result));
    assert.deepEqual(result.changes, [], JSON.stringify(doc));
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0, JSON.stringify(doc));
    assert.equal(JSON.stringify(result.graph), before, JSON.stringify(doc) + ': граф не изменился');
    assert.equal(JSON.stringify(graph), before, JSON.stringify(doc) + ': вход не мутирован');
  }
});

await test('безролевой документ (v2) — fail-closed: ok:false, ничего не меняется', () => {
  const doc = v2doc(v2anchor('A1'), v2anchor('A2'));
  const graph = graphWith();
  const result = resyncAnchorRefs(graph, doc);
  assert.equal(result.ok, false, 'ролей в документе нет — приводить не к чему (как в 0300)');
  assert.deepEqual(result.changes, []);
  assert.match(result.errors.join(' '), /appliesTo\.roles|рол/i);
  assert.equal(JSON.stringify(result.graph), JSON.stringify(graph));
});

await test('чистая функция: входной граф не мутируется', () => {
  const graph = graphWith();
  const before = JSON.stringify(graph);
  resyncAnchorRefs(graph, v3doc(v3anchor('A1', ['ревьюер']), v3anchor('A3', ['ревьюер'])));
  assert.equal(JSON.stringify(graph), before, 'граф на входе не изменён');
});

await test('привязка сохраняет produces, note и объявленный stage у оставшегося якоря', () => {
  const graph = {
    nodes: [{
      id: 'r2',
      role: 'ревьюер',
      anchors: {
        consumes: [{ id: 'A1', stage: 'pre-work' }],
        produces: ['P1'],
        source: 'coordinator',
        note: 'keep-me',
      },
    }],
    edges: [],
    folders: [],
  };
  const doc = v3doc(v3anchor('A1', ['ревьюер']), v3anchor('A3', ['ревьюер']));
  const result = resyncAnchorRefs(graph, doc);
  const anchors = nodeOf(result.graph, 'r2').anchors;
  assert.deepEqual(anchors.consumes, [{ id: 'A1', stage: 'pre-work' }, 'A3'],
    'stage сохранён, новый якорь дописан id');
  assert.deepEqual(anchors.produces, ['P1']);
  assert.equal(anchors.note, 'keep-me');
  assert.equal(anchors.source, 'coordinator');
});

/* ---------- lib/api.js: запись структуры после сохранения якорей ---------- */

/*
 * Хранилище проекта — временное: журнал аудита записи якорей лежит в
 * lib/store.js, и тест не должен трогать реальный ~/.dsh.
 */
async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-0301-store-'));
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

function makeProject(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0301-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const graph = {
    version: 1,
    nodes: options.nodes || [
      { id: 'coordinator', role: 'координатор' },
      { id: 'r1', role: 'ревьюер', anchors: { consumes: ['A1'], source: 'coordinator' } },
    ],
    edges: options.edges || [],
    ...(options.folders ? { folders: options.folders } : {}),
  };
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
  if (options.anchors !== undefined || options.rawAnchors !== undefined) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    const file = path.join(root, 'docs', 'anchors.json');
    if (options.rawAnchors !== undefined) fs.writeFileSync(file, options.rawAnchors);
    else fs.writeFileSync(file, JSON.stringify(options.anchors, null, 2) + '\n');
  }
  return root;
}

const structureFile = (root) => path.join(root, 'structure', 'graph.json');
const readStructureJson = (root) => JSON.parse(fs.readFileSync(structureFile(root), 'utf8'));
const savedNode = (root, id) => (readStructureJson(root).nodes || []).find((node) => node && node.id === id) || null;

await test('api: добавленный якорь записан в файл структуры; ручной узел и папки целы', () => {
  const root = makeProject({
    nodes: [
      { id: 'coordinator', role: 'координатор' },
      { id: 'r1', role: 'ревьюер', anchors: { consumes: ['A1'], source: 'coordinator' } },
      { id: 'u1', role: 'ревьюер', anchors: { consumes: ['A1'], source: 'user' } },
    ],
    folders: [FOLDER],
  });
  const runtime = createGraphRuntime({ roots: [root] });
  const doc = v3doc(v3anchor('A1', ['ревьюер']), v3anchor('A2', ['приёмщик']), v3anchor('A3', ['ревьюер']));
  const resync = resyncStructureAnchors(runtime, root, doc);
  assert.equal(resync.ok, true, JSON.stringify(resync.errors));
  assert.equal(resync.saved, true, 'структура переписана');
  assert.deepEqual(resync.files, ['structure/graph.json']);
  assert.deepEqual(changeOf(resync, 'r1').added, ['A3']);
  assert.equal(changeOf(resync, 'u1'), undefined);
  assert.deepEqual(savedNode(root, 'r1').anchors.consumes, ['A1', 'A3'], 'файл хранит добавленный якорь');
  assert.deepEqual(savedNode(root, 'u1').anchors, { consumes: ['A1'], source: 'user' },
    'ручной выбор не переписан');
  assert.deepEqual(readStructureJson(root).folders, [FOLDER], 'папки целы');
});

await test('api: повторная пересинхронизация не пишет структуру (пустые changes)', () => {
  const root = makeProject();
  const runtime = createGraphRuntime({ roots: [root] });
  const doc = v3doc(v3anchor('A1', ['ревьюер']), v3anchor('A3', ['ревьюер']));
  const first = resyncStructureAnchors(runtime, root, doc);
  assert.equal(first.saved, true, JSON.stringify(first));
  const bytesAfterFirst = fs.readFileSync(structureFile(root));
  const second = resyncStructureAnchors(runtime, root, doc);
  assert.equal(second.ok, true);
  assert.deepEqual(second.changes, [], 'идемпотентность');
  assert.equal(second.saved, false, 'пустые changes — структура не переписывается');
  assert.deepEqual(fs.readFileSync(structureFile(root)), bytesAfterFirst, 'файл не тронут ни байтом');
});

await test('api: удалённый якорь уходит из файла структуры', () => {
  const root = makeProject();
  const runtime = createGraphRuntime({ roots: [root] });
  const resync = resyncStructureAnchors(runtime, root, v3doc(v3anchor('A2', ['приёмщик'])));
  assert.equal(resync.ok, true, JSON.stringify(resync.errors));
  assert.deepEqual(changeOf(resync, 'r1').removed, ['A1']);
  assert.deepEqual(savedNode(root, 'r1').anchors.consumes, [], 'удалённый якорь снят');
});

await test('api: узел с битым объявлением anchors не «чинится» молча', () => {
  const root = makeProject({
    nodes: [
      { id: 'coordinator', role: 'координатор' },
      { id: 'broken', role: 'ревьюер', anchors: 'nope' },
      { id: 'r1', role: 'ревьюер', anchors: { consumes: [], source: 'coordinator' } },
    ],
  });
  const runtime = createGraphRuntime({ roots: [root] });
  const resync = resyncStructureAnchors(runtime, root, v3doc(v3anchor('A1', ['ревьюер'])));
  assert.equal(resync.ok, true, JSON.stringify(resync.errors));
  assert.equal(changeOf(resync, 'broken'), undefined, 'битое объявление в пересинхронизацию не идёт');
  assert.deepEqual(changeOf(resync, 'r1').added, ['A1'], 'остальные узлы обработаны');
  assert.equal(savedNode(root, 'broken').anchors, 'nope', 'битое значение осталось как было');
});

await test('api: битый и безролевой документ — структура не меняется', () => {
  const runtimeProject = (options) => {
    const root = makeProject(options);
    return { root, runtime: createGraphRuntime({ roots: [root] }) };
  };
  const brokenCases = [
    ['{ "version": 3, "anchors": [ { "id": "A1" ', 'битый JSON'],
    ['{"version":3,"anchors":"nope"}', 'нет списка якорей'],
  ];
  for (const [raw, label] of brokenCases) {
    const { root, runtime } = runtimeProject({ rawAnchors: raw });
    const before = fs.readFileSync(structureFile(root));
    /* Документ берётся тем же читателем, что и у маршрута: битый JSON — doc:null. */
    const resync = resyncStructureAnchors(runtime, root, readAnchorsDoc(root).doc);
    assert.equal(resync.ok, false, label);
    assert.deepEqual(resync.changes, [], label);
    assert.deepEqual(fs.readFileSync(structureFile(root)), before, label + ': структура цела');
  }
  const v2 = makeProject({ anchors: v2doc(v2anchor('A1')) });
  const before = fs.readFileSync(structureFile(v2));
  const resync = resyncStructureAnchors(createGraphRuntime({ roots: [v2] }), v2, readAnchorsDoc(v2).doc);
  assert.equal(resync.ok, false, 'безролевой документ — fail-closed');
  assert.deepEqual(resync.changes, []);
  assert.deepEqual(fs.readFileSync(structureFile(v2)), before, 'структура не тронута');
});

/* ---------- PUT /api/anchors: изменения и отказ — в ответе ---------- */

function call(handler, url, options = {}) {
  const res = {
    status: 0,
    body: null,
    writableEnded: false,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(String(body)); this.writableEnded = true; },
  };
  const req = {
    method: options.method || 'GET',
    url,
    socket: { remoteAddress: options.remote || '127.0.0.1' },
    on(event, fn) {
      if (event === 'data' && options.body !== undefined) fn(Buffer.from(String(options.body)));
      if (event === 'end') fn();
    },
  };
  return Promise.resolve(handler(req, res)).then(() => res);
}

const ANCHOR_DOC = () => v2doc(v2anchor('P1'), v2anchor('P2'));

await test('PUT /api/anchors: документ записан, пересинхронизация fail-closed — в ответе', async () => {
  await withStore(async () => {
    const root = makeProject();
    const handler = createWebHandler(createGraphRuntime({ roots: [root] }));
    const before = fs.readFileSync(structureFile(root));
    const res = await call(handler, API_PREFIX + '/api/anchors?root=' + encodeURIComponent(root), {
      method: 'PUT',
      body: JSON.stringify({ root, doc: ANCHOR_DOC() }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true, 'якоря записаны');
    assert.equal(res.body.exists, true);
    assert.deepEqual(res.body.changes, [], 'v2 без ролей — пересинхронизация ничего не меняет');
    assert.deepEqual(res.body.skipped, []);
    assert.equal(res.body.resync.ok, false, 'fail-closed назван в ответе, а не проглочен');
    assert.match(res.body.resync.error, /рол/i);
    assert.deepEqual(fs.readFileSync(structureFile(root)), before, 'структура не тронута');
  });
});

await test('PUT /api/anchors: невалидный документ 409, структура не тронута', async () => {
  await withStore(async () => {
    const root = makeProject();
    const handler = createWebHandler(createGraphRuntime({ roots: [root] }));
    const before = fs.readFileSync(structureFile(root));
    const doc = ANCHOR_DOC();
    doc.anchors[0].claim = '  ';
    const res = await call(handler, API_PREFIX + '/api/anchors?root=' + encodeURIComponent(root), {
      method: 'PUT',
      body: JSON.stringify({ root, doc }),
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.ok, false);
    assert.deepEqual(fs.readFileSync(structureFile(root)), before, 'структура не тронута отказом');
  });
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const message = failure.error && failure.error.message ? failure.error.message : String(failure.error);
  console.error('  ' + message.split('\n').join('\n  '));
}
console.log('ANCHOR RESYNC TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exitCode = failures.length === 0 ? 0 : 1;
