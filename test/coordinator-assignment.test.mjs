/**
 * 0300: первичное назначение якорей координатором.
 *
 * Тесты держат инварианты задания:
 *   C1 — assignAnchorsForNode даёт применимые по роли якоря (0299), узел без
 *        роли получает пусто, пустой/отсутствующий документ — пусто;
 *   C2 — ручной выбор (anchors.source === 'user') липкий: назначение
 *        пропускается (skipped), consumes и source не перетираются;
 *   запись — addNode/updateNode применяют назначение всегда, когда роли в
 *   документе объявлены, и пишут его в файл структуры. Явно присланные якоря
 *   назначение не отменяют (R1 ревью), unreadable/безролевой документ не
 *   повод стереть привязку (R2), produces и прочие поля переживают
 *   переназначение (R3).
 *
 * Файл работает и как обычный node-скрипт (node test/coordinator-assignment.test.mjs),
 * и под node --test: провал выставляет exit-код 1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addNode, createGraphRuntime, updateNode } from '../lib/api.js';
import { assignAnchorsForNode } from '../lib/anchors.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try {
    body();
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
const DOC = {
  version: 3,
  anchors: [v3anchor('A1', ['ревьюер']), v3anchor('A2', ['приёмщик'])],
};

/* ---------- чистый резолвер: назначение по роли ---------- */

test('новый узел с ролью получает применимые якоря, source coordinator', () => {
  const result = assignAnchorsForNode(DOC, { id: 'reviewer-9', role: 'Ревьюер' });
  assert.equal(result.skipped, false);
  assert.equal(result.source, 'coordinator');
  assert.deepEqual(result.applies, [{ id: 'A1' }]);
  assert.deepEqual(result.consumes, ['A1']);
});

test('неприменимый по роли якорь не назначается', () => {
  const result = assignAnchorsForNode(DOC, { id: 'reviewer-9', role: 'ревьюер' });
  assert.ok(!result.consumes.includes('A2'), 'A2 — вход приёмщика, не ревьюера');
});

test('узел без роли: пустой consumes, без исключения', () => {
  for (const node of [{ id: 'n1' }, { id: 'n1', role: '' }, { id: 'n1', role: '   ' }, null]) {
    const result = assignAnchorsForNode(DOC, node);
    assert.equal(result.skipped, false, JSON.stringify(node));
    assert.equal(result.source, 'coordinator', JSON.stringify(node));
    assert.deepEqual(result.applies, [], JSON.stringify(node));
    assert.deepEqual(result.consumes, [], JSON.stringify(node));
  }
});

test('пустой и отсутствующий документ: пустой consumes и source coordinator', () => {
  for (const doc of [{ version: 3, anchors: [] }, { version: 2, anchors: [] }, null, undefined, {}]) {
    const result = assignAnchorsForNode(doc, { id: 'reviewer-1', role: 'ревьюер' });
    assert.equal(result.skipped, false, JSON.stringify(doc));
    assert.equal(result.source, 'coordinator', JSON.stringify(doc));
    assert.deepEqual(result.consumes, [], JSON.stringify(doc));
  }
});

test('ручной выбор (source user): skipped, consumes и source как у узла', () => {
  const node = { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: ['A2'], source: 'user' } };
  const result = assignAnchorsForNode(DOC, node);
  assert.equal(result.skipped, true);
  assert.equal(result.source, 'user');
  assert.deepEqual(result.consumes, ['A2']);
  assert.deepEqual(result.applies, []);
});

test('чистая функция: документ и узел не изменяются', () => {
  const node = { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: ['A2'], source: 'user' } };
  const beforeDoc = JSON.stringify(DOC);
  const beforeNode = JSON.stringify(node);
  assignAnchorsForNode(DOC, node);
  assert.equal(JSON.stringify(DOC), beforeDoc, 'документ якорей не мутируется');
  assert.equal(JSON.stringify(node), beforeNode, 'узел не мутируется');
});

/* ---------- запись: addNode / updateNode ---------- */

function makeProject(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0300-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: options.nodes || [{ id: 'coordinator', role: 'координатор' }],
    edges: options.edges || [],
  }, null, 2));
  if (options.anchors !== undefined) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'anchors.json'), JSON.stringify(options.anchors, null, 2) + '\n');
  }
  /* R2: битый файл пишется дословно — JSON.stringify его бы «починил». */
  if (options.rawAnchors !== undefined) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'anchors.json'), options.rawAnchors);
  }
  return root;
}

function savedNode(root, id) {
  const document = JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
  return document.nodes.find((node) => node && node.id === id) || null;
}

test('addNode: новый узел с ролью получает назначение координатора в файл', () => {
  const root = makeProject({ anchors: DOC });
  const runtime = createGraphRuntime({ roots: [root] });
  const created = addNode(runtime, root, { id: 'reviewer-2', role: 'ревьюер' });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.deepEqual(created.node.anchors, { consumes: ['A1'], source: 'coordinator' },
    'ответ сохранения называет назначение');
  assert.deepEqual(savedNode(root, 'reviewer-2').anchors, { consumes: ['A1'], source: 'coordinator' },
    'файл структуры хранит назначение');
});

test('addNode: узел без роли получает пустой consumes и source coordinator', () => {
  const root = makeProject({ anchors: DOC });
  const runtime = createGraphRuntime({ roots: [root] });
  const created = addNode(runtime, root, { id: 'helper-1' });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.deepEqual(savedNode(root, 'helper-1').anchors, { consumes: [], source: 'coordinator' },
    'узла без роли якоря не назначаются');
});

test('addNode: документа якорей нет — пустой consumes без ошибки', () => {
  const root = makeProject();
  const runtime = createGraphRuntime({ roots: [root] });
  const created = addNode(runtime, root, { id: 'reviewer-3', role: 'ревьюер' });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.deepEqual(savedNode(root, 'reviewer-3').anchors, { consumes: [], source: 'coordinator' },
    'назначать нечего — пустой вход, а не отказ');
});

test('addNode: пустой список якорей — пустой consumes и source coordinator (инвариант 4)', () => {
  const root = makeProject({ anchors: { version: 2, anchors: [] } });
  const runtime = createGraphRuntime({ roots: [root] });
  const created = addNode(runtime, root, { id: 'worker-5', role: 'исполнитель' });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.deepEqual(savedNode(root, 'worker-5').anchors, { consumes: [], source: 'coordinator' },
    'пустой документ — назначать нечего, но запись назначения есть');
});

test('addNode: явно присланные якоря без source не отменяют назначение', () => {
  const root = makeProject({ anchors: DOC });
  const runtime = createGraphRuntime({ roots: [root] });
  const created = addNode(runtime, root, {
    id: 'reviewer-4',
    role: 'ревьюер',
    anchors: { consumes: ['A2'], produces: ['A2'] },
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  const saved = savedNode(root, 'reviewer-4');
  assert.deepEqual(saved.anchors.consumes, ['A1'], 'по роли ревьюера назначен A1, а не присланный A2');
  assert.equal(saved.anchors.source, 'coordinator', 'явные якоря без source не липкие');
  assert.deepEqual(saved.anchors.produces, ['A2'], 'объявленный produces сохранён');
});

test('updateNode: смена роли переназначает якоря координатором', () => {
  const root = makeProject({
    anchors: DOC,
    nodes: [{ id: 'coordinator', role: 'координатор' }, { id: 'worker-1', role: 'исполнитель' }],
  });
  const runtime = createGraphRuntime({ roots: [root] });
  const saved = updateNode(runtime, root, { id: 'worker-1', role: 'ревьюер' });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.deepEqual(savedNode(root, 'worker-1').anchors, { consumes: ['A1'], source: 'coordinator' },
    'изменённый узел получает применимые якоря новой роли');
});

test('updateNode: узел с consumes, сменой роли и anchors в теле (форма панели) — назначение применяется', () => {
  const root = makeProject({
    anchors: DOC,
    nodes: [
      { id: 'coordinator', role: 'координатор' },
      { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: ['A1'], source: 'coordinator' } },
    ],
  });
  const runtime = createGraphRuntime({ roots: [root] });
  /* client.js шлёт anchors для любого узла, у которого уже есть consumes. */
  const saved = updateNode(runtime, root, {
    id: 'reviewer-1',
    role: 'приёмщик',
    anchors: { consumes: ['A1'] },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  const written = savedNode(root, 'reviewer-1');
  assert.deepEqual(written.anchors.consumes, ['A2'], 'по новой роли приёмщика назначен A2, а не присланный A1');
  assert.equal(written.anchors.source, 'coordinator', 'источник — координатор');
});

test('updateNode: явно присланные якоря не отменяют назначение', () => {
  const root = makeProject({
    anchors: DOC,
    nodes: [
      { id: 'coordinator', role: 'координатор' },
      { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: ['A1'] } },
    ],
  });
  const runtime = createGraphRuntime({ roots: [root] });
  const saved = updateNode(runtime, root, { id: 'reviewer-1', anchors: { consumes: ['A2'] } });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.deepEqual(savedNode(root, 'reviewer-1').anchors, { consumes: ['A1'], source: 'coordinator' },
    'координатор назначает A1 по роли ревьюера; присланный A2 не становится привязкой');
});

test('updateNode: ручной выбор (source user) не перетирается', () => {
  const root = makeProject({
    anchors: DOC,
    nodes: [
      { id: 'coordinator', role: 'координатор' },
      { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: ['A2'], source: 'user' } },
    ],
  });
  const runtime = createGraphRuntime({ roots: [root] });
  const saved = updateNode(runtime, root, { id: 'reviewer-1', brief: 'судит результат' });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.deepEqual(savedNode(root, 'reviewer-1').anchors, { consumes: ['A2'], source: 'user' },
    'привязка пользователя осталась липкой');
});

test('R2: битый docs/anchors.json не стирает уже объявленную привязку', () => {
  const root = makeProject({
    rawAnchors: '{ "version": 2, "anchors": [ { "id": "A1" ',
    nodes: [
      { id: 'coordinator', role: 'координатор' },
      {
        id: 'reviewer-1',
        role: 'ревьюер',
        anchors: { consumes: ['A1'], produces: ['A2'], source: 'coordinator', note: 'keep-me' },
      },
    ],
  });
  const runtime = createGraphRuntime({ roots: [root] });
  const saved = updateNode(runtime, root, { id: 'reviewer-1', brief: 'правит несвязанное поле' });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.deepEqual(savedNode(root, 'reviewer-1').anchors,
    { consumes: ['A1'], produces: ['A2'], source: 'coordinator', note: 'keep-me' },
    'нечитаемый документ — не повод молча потерять привязку');
});

test('R2: битый docs/anchors.json — новому узлу пустая привязка не выдумывается', () => {
  const root = makeProject({ rawAnchors: '{ broken' });
  const runtime = createGraphRuntime({ roots: [root] });
  const created = addNode(runtime, root, { id: 'reviewer-6', role: 'ревьюер' });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(savedNode(root, 'reviewer-6').anchors, undefined,
    'документ есть, но не читается — назначение не пишется');
});

test('R3: назначение сохраняет produces и прочие поля anchors', () => {
  const root = makeProject({
    anchors: DOC,
    nodes: [
      { id: 'coordinator', role: 'координатор' },
      {
        id: 'reviewer-1',
        role: 'ревьюер',
        anchors: { consumes: ['A1'], produces: ['A2'], source: 'coordinator', note: 'keep-me' },
      },
    ],
  });
  const runtime = createGraphRuntime({ roots: [root] });
  const saved = updateNode(runtime, root, { id: 'reviewer-1', role: 'приёмщик' });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.deepEqual(savedNode(root, 'reviewer-1').anchors,
    { consumes: ['A2'], produces: ['A2'], source: 'coordinator', note: 'keep-me' },
    'назначен новый вход, объявленный produces и прочие поля на месте');
});

/*
 * R2/0192: манифест без appliesTo.roles (version 2, как в этом репозитории)
 * ролей не объявляет — координатор не может решить, что применимо. Стирать
 * присланную привязку в этом случае нельзя: именно так живёт контракт 0192.
 */
test('R2: документ без ролей — назначение не вычислимо, привязка не стирается', () => {
  const V2 = { version: 2, anchors: [{ ...ANCHOR_BASE, id: 'P1' }] };
  const root = makeProject({
    anchors: V2,
    nodes: [
      { id: 'coordinator', role: 'координатор' },
      { id: 'worker-1', role: 'исполнитель' },
    ],
  });
  const runtime = createGraphRuntime({ roots: [root] });
  const saved = updateNode(runtime, root, { id: 'worker-1', anchors: { consumes: ['P1'] } });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.deepEqual(savedNode(root, 'worker-1').anchors, { consumes: ['P1'] },
    'присланная привязка осталась: ролей в документе нет, назначать не по чему');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const message = failure.error && failure.error.message ? failure.error.message.split('\n') : [String(failure.error)];
  console.error('  ' + message.join('\n  '));
}
console.log('COORDINATOR ASSIGNMENT TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exitCode = failures.length === 0 ? 0 : 1;
