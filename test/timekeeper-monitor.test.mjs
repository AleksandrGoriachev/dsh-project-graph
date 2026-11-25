/**
 * 0355: монитор периодов таймкипера принимается и сохраняется.
 *
 * Тест держит инварианты задания:
 *   C1 — addNode принимает monitor (МАССИВ записей { provider, model, periods[] })
 *        и пишет его в узел структуры; ответ называет записанный монитор;
 *        updateNode меняет монитор, пустой массив очищает, отсутствие ключа
 *        оставляет прежнее значение;
 *   кривой период (end <= start, leadMinutes вне 0..720, неверный формат),
 *   не массив и неизвестная каталогу пара provider/model — 400 { error, fix },
 *   а файл структуры не изменён;
 *   узел без монитора пишется как раньше: поля monitor нет ни в ответе, ни в файле.
 *
 * Проект — временный каталог, хранилище — временный DSH_PROJECT_GRAPH_STORE
 * (образец test/api.test.mjs): прогон не трогает ни репозиторий, ни ~/.dsh.
 * Файл работает и как обычный node-скрипт, и под node --test: провал даёт exit 1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addNode, createGraphRuntime, readGraph, updateNode } from '../lib/api.js';

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

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-store-0355-'));
process.env.DSH_PROJECT_GRAPH_STORE = STORE;

/* Каталог-стенд службы llm: маршрут узла и маршрут монитора проверяются им же. */
function catalogDeps() {
  return {
    getLlm: () => ({
      listProviders: () => [{ id: 'opencode', name: 'OpenCode' }, { id: 'standby', name: 'Standby' }],
      listModels: (provider) => (provider === 'opencode'
        ? [{ id: 'deepseek-v4.1-flash' }, { id: 'glm-5.3-flash' }]
        : [{ id: 'only-model' }]),
    }),
  };
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0355-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [
      { id: 'coordinator', role: 'координатор', provider: 'opencode', model: 'deepseek-v4.1-flash' },
      { id: 'worker-1', role: 'исполнитель', brief: 'делает работу' },
    ],
    edges: [],
  }, null, 2) + '\n');
  return root;
}

function makeRuntime(root) {
  return createGraphRuntime({ roots: [root] }, catalogDeps());
}

function graphFile(root) {
  return path.join(root, 'structure', 'graph.json');
}

function fileText(root) {
  return fs.readFileSync(graphFile(root), 'utf8');
}

function savedNode(root, id) {
  const document = JSON.parse(fileText(root));
  return document.nodes.find((node) => node && node.id === id) || null;
}

function nodeWithMonitor(periods, extra = {}) {
  return [{ provider: 'opencode', model: 'deepseek-v4.1-flash', periods, ...extra }];
}

const PERIOD = { start: '09:00', end: '11:30', leadMinutes: 30 };
const MONITOR = nodeWithMonitor([PERIOD]);

/* ---------- монитор сохраняется ---------- */

test('addNode: монитор записан в узел и виден в файле', () => {
  const root = makeProject();
  const runtime = makeRuntime(root);
  const created = addNode(runtime, root, { id: 'keeper-1', role: 'тайм-менеджер', monitor: MONITOR });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.deepEqual(created.node.monitor, MONITOR, 'ответ сохранения называет записанный монитор');
  assert.deepEqual(savedNode(root, 'keeper-1').monitor, MONITOR, 'файл структуры хранит монитор');
  const read = readGraph(runtime, root);
  assert.deepEqual(read.errors, [], 'монитор не ломает чтение структуры');
  assert.deepEqual(read.graph.nodes.find((node) => node.id === 'keeper-1').monitor, MONITOR,
    'прочитанная структура отдаёт тот же монитор');
});

test('addNode: каждая запись монитора несёт свой маршрут и свои периоды', () => {
  const root = makeProject();
  const runtime = makeRuntime(root);
  const monitor = [
    { provider: 'opencode', model: 'deepseek-v4.1-flash', periods: [{ start: '09:00', end: '11:30', leadMinutes: 30 }] },
    { provider: 'opencode', model: 'glm-5.3-flash', periods: [{ start: '14:00', end: '15:00', leadMinutes: 0 }] },
    { provider: 'standby', model: 'only-model', periods: [] },
  ];
  const created = addNode(runtime, root, { id: 'keeper-2', role: 'тайм-менеджер', monitor });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.deepEqual(created.node.monitor, monitor, 'массив записей сохранён целиком');
  assert.deepEqual(savedNode(root, 'keeper-2').monitor, monitor, 'файл хранит все записи монитора');
});

test('узел без монитора пишется как раньше: поля нет', () => {
  const root = makeProject();
  const runtime = makeRuntime(root);
  const created = addNode(runtime, root, { id: 'plain-1', role: 'исполнитель' });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(Object.hasOwn(created.node, 'monitor'), false, 'в ответе поля нет');
  assert.equal(Object.hasOwn(savedNode(root, 'plain-1'), 'monitor'), false, 'в файле поля нет');
});

/* ---------- кривой монитор: 400 и файл не тронут ---------- */

test('кривые периоды: 400 { error, fix }, файл не изменён', () => {
  const root = makeProject();
  const runtime = makeRuntime(root);
  const before = fileText(root);
  const cases = [
    { title: 'end раньше start', periods: [{ start: '11:30', end: '09:00', leadMinutes: 30 }] },
    { title: 'end равен start', periods: [{ start: '09:00', end: '09:00', leadMinutes: 30 }] },
    { title: 'leadMinutes = 900', periods: [{ start: '09:00', end: '11:30', leadMinutes: 900 }] },
    { title: 'leadMinutes отрицательный', periods: [{ start: '09:00', end: '11:30', leadMinutes: -1 }] },
    { title: 'leadMinutes не целый', periods: [{ start: '09:00', end: '11:30', leadMinutes: 1.5 }] },
    { title: 'start без ведущего нуля', periods: [{ start: '9:00', end: '11:30', leadMinutes: 30 }] },
    { title: 'end = 24:00', periods: [{ start: '09:00', end: '24:00', leadMinutes: 30 }] },
    { title: 'start не время', periods: [{ start: 'утро', end: '11:30', leadMinutes: 30 }] },
    {
      title: 'периоды пересекаются',
      periods: [{ start: '09:00', end: '11:30', leadMinutes: 30 }, { start: '11:00', end: '12:00', leadMinutes: 0 }],
    },
  ];
  for (const item of cases) {
    const refused = addNode(runtime, root, {
      id: 'keeper-x',
      role: 'тайм-менеджер',
      monitor: nodeWithMonitor(item.periods),
    });
    assert.equal(refused.status, 400, item.title + ': ' + JSON.stringify(refused));
    assert.ok(refused.error, item.title + ': отказ называет ошибку');
    assert.ok(refused.fix, item.title + ': отказ даёт рецепт');
    assert.match(refused.error, /monitor\[0\]\.periods/u, item.title + ': отказ называет поле правки');
    assert.equal(fileText(root), before, item.title + ': файл не тронут');
  }
  assert.equal(savedNode(root, 'keeper-x'), null, 'отказы не записали узел');
});

test('monitor не массив, пустой объект записи и запись без periods: 400, файл не изменён', () => {
  const root = makeProject();
  const runtime = makeRuntime(root);
  const before = fileText(root);
  const raws = [
    { title: 'объект вместо массива', value: MONITOR[0] },
    { title: 'null', value: null },
    { title: 'строка', value: 'monitor' },
    { title: 'запись без periods', value: [{ provider: 'opencode', model: 'deepseek-v4.1-flash' }] },
    { title: 'запись не объект', value: [null] },
    { title: 'periods не массив', value: nodeWithMonitor(undefined) },
    { title: 'period не объект', value: nodeWithMonitor([PERIOD.start]) },
    { title: 'нет провайдера', value: [{ model: 'deepseek-v4.1-flash', periods: [PERIOD] }] },
    { title: 'нет модели', value: [{ provider: 'opencode', periods: [PERIOD] }] },
    { title: 'пара объявлена дважды', value: [MONITOR[0], MONITOR[0]] },
  ];
  for (const item of raws) {
    const refused = addNode(runtime, root, { id: 'keeper-y', role: 'тайм-менеджер', monitor: item.value });
    assert.equal(refused.status, 400, item.title + ': ' + JSON.stringify(refused));
    assert.ok(refused.error && refused.fix, item.title + ': отказ с рецептом');
    /* nodeWithMonitor(undefined) кладёт periods: undefined — это не массив. */
    assert.equal(fileText(root), before, item.title + ': файл не тронут');
  }
});

test('неизвестная каталогу пара provider/model: 400 с перечнем доступных, файл не изменён', () => {
  const root = makeProject();
  const runtime = makeRuntime(root);
  const before = fileText(root);
  const unknownModel = addNode(runtime, root, {
    id: 'keeper-z',
    role: 'тайм-менеджер',
    monitor: [{ provider: 'opencode', model: 'no-such-model', periods: [PERIOD] }],
  });
  assert.equal(unknownModel.status, 400, JSON.stringify(unknownModel));
  assert.equal(unknownModel.code, 'model-missing', 'код отказа называет пропавшую модель');
  assert.match(unknownModel.fix, /deepseek-v4\.1-flash/u, 'рецепт перечисляет доступные модели провайдера');
  assert.equal(fileText(root), before, 'файл не тронут');
  const unknownProvider = addNode(runtime, root, {
    id: 'keeper-z',
    role: 'тайм-менеджер',
    monitor: [{ provider: 'no-such-provider', model: 'deepseek-v4.1-flash', periods: [PERIOD] }],
  });
  assert.equal(unknownProvider.status, 400, JSON.stringify(unknownProvider));
  assert.equal(unknownProvider.code, 'provider-missing', 'код отказа называет пропавшего провайдера');
  assert.match(unknownProvider.fix, /opencode/u, 'рецепт перечисляет доступных провайдеров');
  assert.match(unknownProvider.error, /monitor\[0\]/u, 'отказ адресует запись монитора');
  assert.equal(fileText(root), before, 'файл не тронут');
  assert.equal(savedNode(root, 'keeper-z'), null, 'неизвестная пара не записана');
});

/* ---------- updateNode: замена, очистка, отсутствие ключа ---------- */

test('updateNode: монитор меняется, пустой массив очищает, отсутствие ключа оставляет', () => {
  const root = makeProject();
  const runtime = makeRuntime(root);
  const next = [{ provider: 'opencode', model: 'glm-5.3-flash', periods: [{ start: '14:00', end: '16:00', leadMinutes: 15 }] }];
  /* Узел без монитора получает его правкой — одного monitor достаточно. */
  const added = updateNode(runtime, root, { id: 'worker-1', monitor: next });
  assert.equal(added.status, 200, JSON.stringify(added));
  assert.deepEqual(added.node.monitor, next, 'ответ правки называет записанный монитор');
  assert.deepEqual(savedNode(root, 'worker-1').monitor, next, 'файл хранит новый монитор');
  /* Правка другого поля ключ monitor не передаёт — прежнее значение остаётся. */
  const untouched = updateNode(runtime, root, { id: 'worker-1', brief: 'новый бриф' });
  assert.equal(untouched.status, 200, JSON.stringify(untouched));
  assert.deepEqual(untouched.node.monitor, next, 'отсутствие ключа оставляет монитор');
  assert.deepEqual(savedNode(root, 'worker-1').monitor, next, 'файл не потерял монитор');
  /* Пустой массив — осознанная очистка: поля нет ни в ответе, ни в файле. */
  const cleared = updateNode(runtime, root, { id: 'worker-1', monitor: [] });
  assert.equal(cleared.status, 200, JSON.stringify(cleared));
  assert.equal(Object.hasOwn(cleared.node, 'monitor'), false, 'ответ не выдумывает пустой монитор');
  assert.equal(Object.hasOwn(savedNode(root, 'worker-1'), 'monitor'), false, 'поле убрано из файла');
});

test('updateNode: кривой монитор — 400, файл не изменён', () => {
  const root = makeProject();
  const runtime = makeRuntime(root);
  const created = addNode(runtime, root, { id: 'keeper-3', role: 'тайм-менеджер', monitor: MONITOR });
  assert.equal(created.status, 200, JSON.stringify(created));
  const before = fileText(root);
  const cases = [
    { title: 'end раньше start', monitor: nodeWithMonitor([{ start: '11:30', end: '09:00', leadMinutes: 30 }]) },
    { title: 'leadMinutes = 900', monitor: nodeWithMonitor([{ start: '09:00', end: '11:30', leadMinutes: 900 }]) },
    { title: 'неверный формат', monitor: nodeWithMonitor([{ start: '9', end: '11:30', leadMinutes: 30 }]) },
    { title: 'неизвестная модель', monitor: [{ provider: 'opencode', model: 'ghost-model', periods: [PERIOD] }] },
    { title: 'не массив', monitor: { provider: 'opencode' } },
  ];
  for (const item of cases) {
    const refused = updateNode(runtime, root, { id: 'keeper-3', monitor: item.monitor });
    assert.equal(refused.status, 400, item.title + ': ' + JSON.stringify(refused));
    assert.ok(refused.error && refused.fix, item.title + ': отказ с рецептом');
    assert.equal(fileText(root), before, item.title + ': файл не тронут');
  }
  assert.deepEqual(savedNode(root, 'keeper-3').monitor, MONITOR, 'прежний монитор остался как был');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const message = failure.error && failure.error.message ? failure.error.message.split('\n') : [String(failure.error)];
  console.error('  ' + message.join('\n  '));
}
console.log('TIMEKEEPER MONITOR TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exitCode = failures.length === 0 ? 0 : 1;
