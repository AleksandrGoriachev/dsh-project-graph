/**
 * 0346: сохранение узла не блокируется, когда вход объявить нечем.
 *
 * Живой случай: в docs/anchors.json проекта есть якоря, но ни один не применим
 * к роли узла, auto-якорей нет. Требование «ревьюер обязан объявить непустой
 * anchors.consumes» невыполнимо, и запись структуры не должна из-за него падать.
 * Тесты держат инварианты задания:
 *   C1 (а) — ревьюер без входа сохраняется, ответ несёт anchorsWarning с
 *            причиной и рецептом; это верно и для записи, и для правки узла;
 *   C1 (б) — отказ остаётся, когда привязка выполнима: применимый якорь (или
 *            auto-якорь) есть, значит вход объявить есть чем;
 *   C1 (в) — неизвестный id в consumes остаётся ошибкой и не превращается в
 *            предупреждение, даже если применимых и auto-якорей нет;
 *   C1 (г) — ручной выбор (anchors.source === 'user') не «невыполнимо»: это
 *            решение человека, отказ 0186 остаётся.
 *
 * Файл работает и как обычный node-скрипт (node test/node-save-anchors.test.mjs),
 * и под node --test: провал выставляет exit-код 1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anchorsBindingFeasible } from '../lib/anchors.js';
import {
  API_PREFIX, addNode, createGraphRuntime, createWebHandler, updateNode,
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
  status: 'active',
  layer: 'project',
  sides: 'project',
  enforcedBy: 'nodes',
};
const anchor = (id, roles, status) => ({
  ...ANCHOR_BASE,
  id,
  claim: 'claim ' + id,
  status: status || ANCHOR_BASE.status,
  appliesTo: { roles },
});
const v3 = (anchors) => ({ version: 3, anchors });
/** Якоря есть, но ни один не применим к ревьюеру и ни один не auto. */
const NO_APPLICABLE = () => v3([anchor('A1', ['координатор']), anchor('A2', ['исполнитель'])]);
/** Применимый к ревьюеру якорь есть (но не auto). */
const APPLICABLE = () => v3([anchor('A1', ['ревьюер']), anchor('A2', ['приёмщик'])]);
/** Auto-якорь есть: вход ревьюера задаётся политикой роли. */
const AUTO = () => v3([anchor('A3', ['координатор'], 'auto')]);
/** Живой случай канбана: P1 известен, но ревьюеру не применим. */
const LIVE = () => v3([anchor('A1', ['координатор']), anchor('P1', ['исполнитель'])]);
/** Манифест 0192 без appliesTo: применимость по роли не вычисляется. */
const V2_NO_ROLES = () => ({
  version: 2,
  anchors: [{ ...ANCHOR_BASE, id: 'P1', claim: 'claim P1' }],
});
const COORDINATOR = { id: 'coordinator', role: 'координатор' };

function makeProject(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0346-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const nodes = options.nodes || [COORDINATOR];
  fs.writeFileSync(
    path.join(root, 'structure', 'graph.json'),
    JSON.stringify({ version: 1, nodes, edges: [], folders: [] }, null, 2) + '\n',
  );
  if (options.anchors !== undefined) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'anchors.json'), JSON.stringify(options.anchors, null, 2) + '\n');
  }
  return root;
}

const runtimeFor = (root) => createGraphRuntime({ roots: [root], structureDir: 'structure' });
const structureFile = (root) => path.join(root, 'structure', 'graph.json');
const savedNode = (root, id) => {
  const document = JSON.parse(fs.readFileSync(structureFile(root), 'utf8'));
  return (Array.isArray(document.nodes) ? document.nodes : []).find((item) => item && item.id === id) || null;
};

/* Доступ к хранилищу — временный: тест не должен писать в реальный ~/.dsh. */
async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-0346-store-'));
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

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

/* ---------- C1 (а): невыполнимая привязка — узел сохраняется ---------- */

await test('C1 (а): ревьюер без входа сохраняется с предупреждением, применимых и auto-якорей нет', () => {
  const document = NO_APPLICABLE();
  assert.equal(
    anchorsBindingFeasible(document, { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [] } }),
    false,
    'выполнимости нет: ни применимого, ни auto-якоря',
  );
  const root = makeProject({ anchors: document });
  const created = addNode(runtimeFor(root), root, { id: 'reviewer-1', role: 'ревьюер' });

  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(created.ok, true, 'ответ остался успешным');
  assert.equal(created.file, 'structure/graph.json', 'прежнее поле файла не пропало');
  assert.equal(created.node.id, 'reviewer-1', 'прежнее поле узла не пропало');
  assert.equal(created.error, undefined, 'предупреждение не возвращает отказ');
  assert.equal(typeof created.anchorsWarning, 'string', 'предупреждение — поле ответа');
  assert.match(created.anchorsWarning, /вход не задан/u, 'названа причина');
  assert.match(created.anchorsWarning, /«ревьюер»/u, 'названа роль узла');
  assert.match(created.anchorsWarning, /auto-якорей/u, 'сказано, чего именно нет');
  assert.match(created.anchorsWarning, /назначьте якоря или создайте применимый/u, 'есть рецепт');

  const saved = savedNode(root, 'reviewer-1');
  assert.ok(saved, 'узел записан в файл структуры');
  assert.deepEqual(saved.anchors.consumes, [], 'вход остался пустым: объявлять нечего');
});

await test('C1 (а): правка узла тоже сохраняется с предупреждением', () => {
  const root = makeProject({
    anchors: NO_APPLICABLE(),
    nodes: [COORDINATOR, { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [], source: 'coordinator' } }],
  });
  const edited = updateNode(runtimeFor(root), root, { id: 'reviewer-1', brief: 'судит результат' });

  assert.equal(edited.status, 200, JSON.stringify(edited));
  assert.equal(edited.ok, true);
  assert.equal(edited.error, undefined, 'правка не блокируется невыполнимой привязкой');
  assert.equal(typeof edited.anchorsWarning, 'string', 'предупреждение попадает в ответ правки');
  assert.match(edited.anchorsWarning, /вход не задан/u);
  assert.match(edited.anchorsWarning, /«ревьюер»/u);
  assert.equal(savedNode(root, 'reviewer-1').brief, 'судит результат', 'правка записана');
  assert.deepEqual(savedNode(root, 'reviewer-1').anchors.consumes, [], 'вход не выдуман');
});

/* ---------- C1 (б): выполнимая привязка — прежний отказ ---------- */

await test('C1 (б): отказ остаётся, когда применимый якорь есть', () => {
  const document = APPLICABLE();
  assert.equal(
    anchorsBindingFeasible(document, { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [], source: 'coordinator' } }),
    true,
    'применимый по роли якорь делает привязку выполнимой',
  );
  /*
   * Ручной выбор здесь держит пустой вход: без source 'user' координатор
   * назначил бы применимый A1 и отказа бы не было. Проверяется отказ, а не
   * отсутствие назначения.
   */
  const root = makeProject({
    anchors: document,
    nodes: [COORDINATOR, { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [], source: 'user' } }],
  });
  const refused = updateNode(runtimeFor(root), root, { id: 'reviewer-1', brief: 'судит' });

  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.match(refused.error, /обязан объявить непустой anchors\.consumes/u, 'текст отказа прежний');
  assert.equal(refused.anchorsWarning, undefined, 'выполнимая привязка — отказ, а не предупреждение');
  assert.equal(savedNode(root, 'reviewer-1').brief, undefined, 'отказ не изменил файл');
});

await test('C1 (б): auto-якорь делает привязку выполнимой', () => {
  assert.equal(
    anchorsBindingFeasible(AUTO(), { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [] } }),
    true,
    'вход задаётся политикой роли — объявлять есть что',
  );
});

/* ---------- C1 (в): неизвестный id — ошибка в любом случае ---------- */

await test('C1 (в): неизвестный id остаётся ошибкой, даже когда привязка невыполнима', () => {
  const root = makeProject({ anchors: V2_NO_ROLES() });
  const refused = addNode(runtimeFor(root), root, {
    id: 'reviewer-1',
    role: 'ревьюер',
    anchors: { consumes: ['NOPE'] },
  });

  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.match(refused.error, /NOPE/u, 'отказ называет неизвестный id');
  assert.match(refused.error, /не объявлен/u, 'отказ называет нарушение');
  assert.equal(refused.anchorsWarning, undefined, 'неизвестный id не смягчается предупреждением');
  assert.equal(savedNode(root, 'reviewer-1'), null, 'узел не записан');
});

/* ---------- C1 (г): ручной выбор — не «невыполнимо» ---------- */

await test('C1 (г): source user не считается невыполнимым', () => {
  const document = NO_APPLICABLE();
  const node = { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [], source: 'user' } };
  assert.equal(anchorsBindingFeasible(document, node), true, 'решение человека, а не нехватка якорей');
  const root = makeProject({ anchors: document, nodes: [COORDINATOR, node] });
  const refused = updateNode(runtimeFor(root), root, { id: 'reviewer-1', brief: 'судит' });

  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.match(refused.error, /обязан объявить непустой anchors\.consumes/u, 'отказ 0186 прежний');
  assert.equal(refused.anchorsWarning, undefined, 'ручной выбор не превращается в предупреждение');
  assert.deepEqual(
    savedNode(root, 'reviewer-1').anchors,
    { consumes: [], source: 'user' },
    'привязка пользователя не переписана',
  );
});

/* ---------- C1 B1: явный непустой вход не теряется ---------- */

await test('C1 B1: правка узла с ручным входом не теряет привязку', () => {
  const document = LIVE();
  const root = makeProject({
    anchors: document,
    nodes: [COORDINATOR, { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: ['P1'], source: 'user' } }],
  });
  const edited = updateNode(runtimeFor(root), root, {
    id: 'reviewer-1',
    brief: 'new',
    anchors: { consumes: ['P1'] },
  });

  assert.equal(edited.status, 200, JSON.stringify(edited));
  assert.equal(edited.anchorsWarning, undefined, 'вход известен — предупреждать не о чем');
  assert.deepEqual(
    savedNode(root, 'reviewer-1').anchors,
    { consumes: ['P1'], source: 'user' },
    'ручной вход пережил правку: P1 на месте, source user сохранён',
  );
  assert.equal(savedNode(root, 'reviewer-1').brief, 'new', 'правка применена');
  assert.deepEqual(edited.node.anchors, { consumes: ['P1'], source: 'user' }, 'ответ называет ту же привязку');
});

await test('C1 B1: явный consumes из запроса не затирается пустым назначением', () => {
  const document = LIVE();
  const root = makeProject({
    anchors: document,
    nodes: [COORDINATOR, { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: ['A1'], source: 'coordinator' } }],
  });
  const edited = updateNode(runtimeFor(root), root, {
    id: 'reviewer-1',
    brief: 'new',
    anchors: { consumes: ['P1'] },
  });

  assert.equal(edited.status, 200, JSON.stringify(edited));
  assert.deepEqual(
    savedNode(root, 'reviewer-1').anchors,
    { consumes: ['P1'], source: 'user' },
    'явный выбор человека не исчез: P1 записан и помечен user',
  );
});

/* ---------- C1 B2: неизвестный id — отказ до назначения координатора ---------- */

await test('C1 B2: неизвестный id в запросе — отказ, даже когда привязка выполнима', () => {
  const root = makeProject({ anchors: APPLICABLE() });
  const refused = addNode(runtimeFor(root), root, {
    id: 'reviewer-1',
    role: 'ревьюер',
    anchors: { consumes: ['NOPE'] },
  });

  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.match(refused.error, /NOPE/u, 'отказ называет неизвестный id из запроса');
  assert.match(refused.error, /не объявлен/u, 'отказ называет нарушение');
  assert.equal(refused.anchorsWarning, undefined, 'неизвестный id не смягчается');
  assert.equal(savedNode(root, 'reviewer-1'), null, 'узел не записан');
});

/* ---------- C1 B3: битый документ якорей — отказ, не предупреждение ---------- */

await test('C1 B3: битый документ якорей даёт отказ с находкой validateAnchorsDoc', () => {
  const cases = [
    {
      doc: v3([anchor('A1', ['координатор']), anchor('A1', ['исполнитель'])]),
      pattern: /повторяется/u,
      label: 'повтор id',
    },
    {
      doc: v3([{ ...anchor('A1', ['координатор']), claim: '  ' }]),
      pattern: /claim пуст/u,
      label: 'пустой claim',
    },
  ];
  for (const item of cases) {
    const root = makeProject({
      anchors: item.doc,
      nodes: [COORDINATOR, { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [], source: 'coordinator' } }],
    });
    const file = structureFile(root);
    const before = fs.readFileSync(file, 'utf8');
    const refused = updateNode(runtimeFor(root), root, { id: 'reviewer-1', brief: 'new' });

    assert.equal(refused.status, 409, item.label + ': ' + JSON.stringify(refused));
    assert.match(refused.error, item.pattern, item.label + ': отказ называет находку документа');
    assert.equal(refused.anchorsWarning, undefined, item.label + ': не предупреждение');
    assert.equal(fs.readFileSync(file, 'utf8'), before, item.label + ': файл не тронут');
  }
});

/* ---------- C1: HTTP-ответ сохранения несёт anchorsWarning ---------- */

await test('C1: /api/node — ответы записи и правки несут anchorsWarning, прежние поля целы', async () => {
  await withStore(async () => {
    const root = makeProject({
      anchors: NO_APPLICABLE(),
      nodes: [COORDINATOR, { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [], source: 'coordinator' } }],
    });
    const handler = createWebHandler(runtimeFor(root));
    const url = API_PREFIX + '/api/node?root=' + encodeURIComponent(root);

    const created = await call(handler, url, {
      method: 'POST',
      body: JSON.stringify({ id: 'reviewer-2', role: 'ревьюер' }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.ok, true);
    assert.equal(created.body.node.id, 'reviewer-2', 'прежнее поле узла не пропало');
    assert.equal(created.body.file, 'structure/graph.json', 'прежнее поле файла не пропало');
    assert.match(String(created.body.anchorsWarning), /вход не задан/u, 'запись несёт предупреждение');

    const edited = await call(handler, url + '&action=update', {
      method: 'POST',
      body: JSON.stringify({ id: 'reviewer-1', brief: 'судит' }),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.ok, true);
    assert.equal(edited.body.node.id, 'reviewer-1');
    assert.equal(edited.body.error, undefined);
    assert.match(String(edited.body.anchorsWarning), /вход не задан/u, 'правка несёт предупреждение');
  });
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const message = failure.error && failure.error.message ? failure.error.message.split('\n') : [String(failure.error)];
  console.error('  ' + message.join('\n  '));
}
console.log('NODE SAVE ANCHORS TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exitCode = failures.length === 0 ? 0 : 1;
