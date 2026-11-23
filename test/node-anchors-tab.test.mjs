/**
 * 0302: вкладка «Якоря» в окне узла.
 *
 * Тесты держат инварианты задания:
 *   C1 — anchorTabRows (0299/0302): применимость по роли, код причины,
 *        selected из consumes, узел без роли — no-node-role, нет/пустой
 *        документ — rows: [];
 *   C2 — nodeAnchorsView (GET) и setNodeAnchors (POST): source, consumes,
 *        сохранение produces/прочих полей, 400 на невалидный id, 404 на
 *        неизвестный узел, липкость ручного выбора после resyncAnchorRefs;
 *   C3 — панель: вкладка anchors в окне узла, строки с чекбоксами и причиной,
 *        сохранение POST /api/node-anchors.
 *
 * Файл работает и как обычный node-скрипт (node test/node-anchors-tab.test.mjs),
 * и под node --test: провал выставляет exit-код 1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANCHOR_APPLICABILITY, anchorTabRows, assignAnchorsForNode, resyncAnchorRefs,
} from '../lib/anchors.js';
import {
  API_PREFIX, createGraphRuntime, createWebHandler, nodeAnchorsView, setNodeAnchors,
} from '../lib/api.js';

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
const anchor = (id, roles, claim) => ({
  ...ANCHOR_BASE,
  id,
  claim: claim || 'claim ' + id,
  appliesTo: { roles },
});
const DOC = () => ({
  version: 3,
  anchors: [
    anchor('A1', ['ревьюер']),
    anchor('A2', ['приёмщик']),
    anchor('A3', ['ревьюер'], 'второй якорь ревьюера'),
  ],
});
const rowsById = (result) => new Map((result.rows || []).map((row) => [row.id, row]));

/* ---------- C1: строки вкладки ---------- */

await test('C1: применимость, причина, selected и source', () => {
  const result = anchorTabRows(DOC(), { id: 'r1', role: 'Ревьюер' }, ['A1'], 'coordinator');
  assert.equal(result.source, 'coordinator', 'source привязки проброшен');
  assert.deepEqual(result.rows.map((row) => row.id), ['A1', 'A2', 'A3'], 'порядок документа сохранён');
  const rows = rowsById(result);
  assert.deepEqual(rows.get('A1'), {
    id: 'A1', claim: 'claim A1', status: 'auto', applicable: true, reason: '', selected: true,
  });
  assert.deepEqual(rows.get('A3'), {
    id: 'A3', claim: 'второй якорь ревьюера', status: 'auto', applicable: true, reason: '', selected: false,
  }, 'применимый якорь без выбора — selected: false');
  assert.equal(rows.get('A2').applicable, false, 'чужой роли якорь не применим');
  assert.equal(rows.get('A2').reason, ANCHOR_APPLICABILITY.ROLE_MISMATCH, 'причина названа кодом 0299');
  assert.equal(rows.get('A2').selected, false);
});

await test('C1: selected понимает ссылки { id, stage } и регистр id', () => {
  const doc = { version: 3, anchors: [anchor('A1', ['ревьюер'])] };
  const result = anchorTabRows(doc, { id: 'r1', role: 'ревьюер' }, [{ id: 'a1', stage: 'pre-work' }], 'user');
  assert.equal(result.rows[0].selected, true, 'id сравнивается без регистра, форма { id } — ссылка');
  assert.equal(result.source, 'user');
});

await test('C1: узел без роли — no-node-role у каждого якоря, ничего не выбрано', () => {
  const result = anchorTabRows(DOC(), { id: 'n1' }, [], 'coordinator');
  assert.equal(result.rows.length, 3);
  for (const row of result.rows) {
    assert.equal(row.applicable, false, row.id);
    assert.equal(row.reason, ANCHOR_APPLICABILITY.NO_NODE_ROLE, row.id + ': причина');
    assert.equal(row.selected, false, row.id + ': без роли ничего не выбрано');
  }
});

await test('C1: нет документа и пустой документ — rows: [] (пустое состояние, не отказ)', () => {
  for (const doc of [null, undefined, { version: 3, anchors: [] }]) {
    const result = anchorTabRows(doc, { id: 'r1', role: 'ревьюер' }, ['A1'], 'coordinator');
    assert.deepEqual(result.rows, [], JSON.stringify(doc));
    assert.equal(result.source, 'coordinator');
  }
});

await test('C1: битый документ — fail-closed: rows: [] и errors', () => {
  const broken = { version: 3, anchors: [anchor('', ['ревьюер'])] };
  const result = anchorTabRows(broken, { id: 'r1', role: 'ревьюер' }, [], 'coordinator');
  assert.deepEqual(result.rows, [], 'частичный ответ не выдаётся');
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, 'причина названа');
});

/* ---------- C2: GET/POST ---------- */

/*
 * Хранилище проекта — временное: readGraph/структура не должны трогать
 * реальный ~/.dsh. Отдельный store на тест, как в 0301.
 */
async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-0302-store-'));
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

const DEFAULT_NODES = () => ([
  { id: 'coordinator', role: 'координатор' },
  {
    id: 'r1', role: 'ревьюер',
    anchors: { consumes: ['A1'], produces: ['P1'], source: 'coordinator', note: 'keep' },
  },
  { id: 'n1' },
]);

function makeProject(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0302-'));
  const root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const nodes = options.nodes || DEFAULT_NODES();
  fs.writeFileSync(
    path.join(root, 'structure', 'graph.json'),
    JSON.stringify({ version: 1, nodes, edges: [], folders: [] }, null, 2) + '\n',
  );
  if (options.withDoc !== false) {
    const doc = options.doc || DOC();
    fs.writeFileSync(path.join(root, 'docs', 'anchors.json'), JSON.stringify(doc, null, 2) + '\n');
  }
  return root;
}

const structureFile = (root) => path.join(root, 'structure', 'graph.json');
const readStructureJson = (root) => JSON.parse(fs.readFileSync(structureFile(root), 'utf8'));
const savedNode = (root, id) => (readStructureJson(root).nodes || []).find((node) => node && node.id === id) || null;
const runtimeFor = (root) => createGraphRuntime({ roots: [root], structureDir: 'structure' });

await test('C2: GET — узел с ролью: node, source, consumes, rows', () => {
  const root = makeProject();
  const view = nodeAnchorsView(runtimeFor(root), root, 'r1');
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.deepEqual(view.node, { id: 'r1', role: 'ревьюер' }, 'узел назван id и ролью');
  assert.equal(view.source, 'coordinator', 'source читается из файла, а не из графа');
  assert.deepEqual(view.consumes, ['A1']);
  const rows = rowsById(view);
  assert.equal(rows.get('A1').applicable, true);
  assert.equal(rows.get('A1').selected, true);
  assert.equal(rows.get('A2').reason, ANCHOR_APPLICABILITY.ROLE_MISMATCH);
});

await test('C2: GET — узел без роли: причина no-node-role', () => {
  const root = makeProject();
  const view = nodeAnchorsView(runtimeFor(root), root, 'n1');
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(view.node.role, '');
  assert.equal(view.rows.length, 3);
  assert.ok(view.rows.every((row) => row.reason === ANCHOR_APPLICABILITY.NO_NODE_ROLE));
  assert.ok(view.rows.every((row) => row.selected === false));
});

await test('C2: GET — документа нет: ok: true и rows: []', () => {
  const root = makeProject({ withDoc: false });
  const view = nodeAnchorsView(runtimeFor(root), root, 'r1');
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.consumes, ['A1'], 'объявленный вход узла остаётся виден');
});

await test('C2: GET — неизвестный узел: 404', () => {
  const root = makeProject();
  const view = nodeAnchorsView(runtimeFor(root), root, 'nope');
  assert.equal(view.ok, false);
  assert.equal(view.status, 404);
  assert.match(view.error, /nope/u);
});

await test('C2: POST — source user, consumes записан, produces и note сохранены', () => {
  const root = makeProject();
  const saved = setNodeAnchors(runtimeFor(root), root, 'r1', ['A2']);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.status, 200);
  assert.equal(saved.source, 'user');
  assert.deepEqual(saved.consumes, ['A2']);
  const node = savedNode(root, 'r1');
  assert.deepEqual(node.anchors.consumes, ['A2'], 'consumes записан');
  assert.equal(node.anchors.source, 'user', 'ручной выбор помечен');
  assert.deepEqual(node.anchors.produces, ['P1'], 'объявленный выход сохранён');
  assert.equal(node.anchors.note, 'keep', 'прочие поля привязки сохранены');
  const bytes = fs.readFileSync(structureFile(root), 'utf8');
  assert.ok(bytes.endsWith('\n'), 'файл записан тем же аккуратным видом (атомарная запись)');
  assert.deepEqual(readStructureJson(root).nodes.find((item) => item.id === 'r1').anchors.consumes, ['A2']);
});

await test('C2: POST — пустой список снимает вход, source остаётся user', () => {
  const root = makeProject();
  const saved = setNodeAnchors(runtimeFor(root), root, 'r1', []);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const node = savedNode(root, 'r1');
  assert.deepEqual(node.anchors.consumes, []);
  assert.equal(node.anchors.source, 'user');
  assert.deepEqual(node.anchors.produces, ['P1'], 'выход не потерян');
});

await test('C2: POST — невалидный id: 400 с названием id, файл не тронут', () => {
  const root = makeProject();
  const before = fs.readFileSync(structureFile(root));
  const refused = setNodeAnchors(runtimeFor(root), root, 'r1', ['NOPE']);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 400);
  assert.match(refused.error, /NOPE/u, 'отказ называет невалидный id');
  assert.deepEqual(fs.readFileSync(structureFile(root)), before, 'отказ не переписал структуру');
});

await test('C2: POST — неизвестный узел: 404, файл не тронут', () => {
  const root = makeProject();
  const before = fs.readFileSync(structureFile(root));
  const refused = setNodeAnchors(runtimeFor(root), root, 'nope', []);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 404);
  assert.deepEqual(fs.readFileSync(structureFile(root)), before);
});

await test('C2: липкость — после ручного выбора resync 0301 и назначение 0300 не трогают consumes', () => {
  const root = makeProject();
  setNodeAnchors(runtimeFor(root), root, 'r1', ['A2']);
  const node = savedNode(root, 'r1');
  const resync = resyncAnchorRefs({ nodes: [node], edges: [], folders: [] }, DOC());
  assert.equal(resync.ok, true, JSON.stringify(resync.errors));
  assert.deepEqual(resync.graph.nodes[0].anchors.consumes, ['A2'], 'resync сохранил ручной выбор');
  assert.deepEqual(resync.changes, [], 'ручной узел не меняется');
  assert.equal(resync.skipped[0].reason, 'user', 'узел назван в skipped');
  const assignment = assignAnchorsForNode(DOC(), resync.graph.nodes[0]);
  assert.equal(assignment.skipped, true, 'назначение 0300 пропускает ручной узел');
  assert.deepEqual(assignment.consumes, ['A2']);
  assert.equal(assignment.source, 'user');
});

/* ---------- C2: HTTP-маршруты ---------- */

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

const routeUrl = (root, node) => API_PREFIX + '/api/node-anchors?root=' + encodeURIComponent(root)
  + (node ? '&node=' + encodeURIComponent(node) : '');

await test('C2: GET /api/node-anchors — строки вкладки', async () => {
  await withStore(async () => {
    const root = makeProject();
    const handler = createWebHandler(runtimeFor(root));
    const res = await call(handler, routeUrl(root, 'r1'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.node, { id: 'r1', role: 'ревьюер' });
    assert.equal(res.body.source, 'coordinator');
    assert.deepEqual(res.body.consumes, ['A1']);
    assert.equal(rowsById(res.body).get('A2').reason, ANCHOR_APPLICABILITY.ROLE_MISMATCH);
  });
});

await test('C2: GET /api/node-anchors — нет документа и нет узла', async () => {
  await withStore(async () => {
    const empty = makeProject({ withDoc: false });
    const emptyHandler = createWebHandler(runtimeFor(empty));
    const emptyRes = await call(emptyHandler, routeUrl(empty, 'r1'));
    assert.equal(emptyRes.status, 200, JSON.stringify(emptyRes.body));
    assert.deepEqual(emptyRes.body.rows, [], 'нет документа — rows: [], ok: true');

    const root = makeProject();
    const handler = createWebHandler(runtimeFor(root));
    const missing = await call(handler, routeUrl(root, 'nope'));
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(missing.body.ok, false);
  });
});

await test('C2: POST /api/node-anchors — запись source user и ответ', async () => {
  await withStore(async () => {
    const root = makeProject();
    const handler = createWebHandler(runtimeFor(root));
    const res = await call(handler, API_PREFIX + '/api/node-anchors?root=' + encodeURIComponent(root), {
      method: 'POST',
      body: JSON.stringify({ node: 'r1', consumes: ['A3'] }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.source, 'user');
    assert.deepEqual(res.body.consumes, ['A3']);
    assert.equal(savedNode(root, 'r1').anchors.source, 'user');
    assert.deepEqual(savedNode(root, 'r1').anchors.consumes, ['A3']);
  });
});

await test('C2: POST /api/node-anchors — 400 на невалидный id, 404 на неизвестный узел', async () => {
  await withStore(async () => {
    const root = makeProject();
    const handler = createWebHandler(runtimeFor(root));
    const url = API_PREFIX + '/api/node-anchors?root=' + encodeURIComponent(root);
    const badId = await call(handler, url, {
      method: 'POST',
      body: JSON.stringify({ node: 'r1', consumes: ['NOPE'] }),
    });
    assert.equal(badId.status, 400, JSON.stringify(badId.body));
    assert.match(badId.body.error, /NOPE/u);
    const noNode = await call(handler, url, {
      method: 'POST',
      body: JSON.stringify({ node: 'nope', consumes: [] }),
    });
    assert.equal(noNode.status, 404, JSON.stringify(noNode.body));
  });
});

/* ---------- C3: панель ---------- */

function loadClientBundle() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');
  let registered = null;
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry; } } };
  const sandboxRequire = (id) => {
    if (id === 'react') {
      return {
        createElement: () => null,
        Component: class Component { constructor(props) { this.props = props; this.state = {}; } setState() {} },
      };
    }
    throw new Error('unexpected require: ' + id);
  };
  const run = new Function('window', source);
  run(window);
  assert.ok(registered, 'бандл не зарегистрировался в загрузчике модулей');
  return { source, module: registered.factory(sandboxRequire) };
}

await test('C3: вкладка «Якоря» — id, подпись и присутствие в окне узла', () => {
  const { module } = loadClientBundle();
  const tab = module.__nodeAnchorTab();
  assert.equal(tab.id, 'anchors');
  assert.equal(tab.label, 'Якоря');
  const windowTabs = module.__nodeWindowTabs();
  assert.deepEqual(windowTabs.map((item) => item.id), ['info', 'state', 'settings', 'anchors']);
  assert.equal(windowTabs.find((item) => item.id === 'anchors').label, 'Якоря');
  /* Базовый набор вкладок не раздвоен: 0162/0122 остаются охраняемым фактом. */
  assert.deepEqual(module.__nodeTabs().map((item) => item.id), ['info', 'state', 'settings']);
});

await test('C3: панель рисует строки с чекбоксами и причиной и зовёт POST', () => {
  const { source } = loadClientBundle();
  for (const marker of [
    '/api/node-anchors', 'data-node-anchor-id', 'data-node-anchor-applicable',
    'data-node-anchor-reason', 'data-node-anchors-save', 'renderNodeAnchorsTab',
  ]) {
    assert.ok(source.includes(marker), 'в панели нет: ' + marker);
  }
  const saveBody = source.indexOf('function nodeAnchorSaveBody');
  assert.ok(saveBody > 0, 'тело POST собирается чистой функцией');
  assert.ok(source.slice(saveBody, saveBody + 400).includes('consumes'));
});

await test('C3: модель строк и тела сохранения проверяется исполнением', () => {
  const { module } = loadClientBundle();
  const body = {
    rows: [
      { id: 'A1', claim: 'claim A1', status: 'auto', applicable: true, reason: '', selected: true },
      { id: 'A2', claim: 'claim A2', status: 'auto', applicable: false, reason: 'role-mismatch', selected: false },
    ],
  };
  const rows = module.__nodeAnchorTabRows(body);
  assert.equal(rows[0].reasonText, '');
  assert.match(rows[1].reasonText, /роль узла/u, 'причина переведена словами');
  assert.equal(rows[1].applicable, false);
  const draft = module.__nodeAnchorsDraftFrom(body);
  assert.deepEqual(draft, { A1: true, A2: false });
  assert.equal(module.__nodeAnchorsChanged(body, draft), false, 'черновик из ответа — не изменение');
  const toggled = module.__toggleNodeAnchorDraft(draft, 'A2');
  assert.equal(module.__nodeAnchorsChanged(body, toggled), true, 'включение якоря — изменение');
  assert.deepEqual(module.__nodeAnchorSaveBody('r1', toggled), {
    node: 'r1', consumes: ['A1', 'A2'],
  });
  assert.equal(module.__nodeAnchorReasonText('no-node-role'), 'у узла нет роли — якорь не применяется ни к кому');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const message = failure.error && failure.error.message ? failure.error.message : String(failure.error);
  console.error('  ' + message.split('\n').join('\n  '));
}
console.log('NODE ANCHORS TAB TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exitCode = failures.length === 0 ? 0 : 1;
