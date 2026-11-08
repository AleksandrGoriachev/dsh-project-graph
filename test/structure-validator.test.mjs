/**
 * Валидатор структуры (0161): инварианты, коды находок, настройка моделей.
 *
 * Набор проверяет поведение, а не реализацию: исправная структура не даёт
 * error-находок, каждая поломка называется своим кодом, а принудительная
 * проверка провайдеров/моделей включается только настройкой forceModelCheck
 * и известным списком провайдеров.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINDING_CODES, validateStructure } from '../lib/structure-validator.js';

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

/** Граф в той же форме, что собирает lib/graph.js. */
function graphOf({ nodes, edges = [], models }) {
  return {
    version: 1,
    ...(models ? { models } : {}),
    nodes,
    folders: [],
    edges,
  };
}

/** Исправная структура: координатор, исполнитель и приёмщик, связи замкнуты. */
function good() {
  return graphOf({
    nodes: [
      { id: 'coordinator', role: 'координатор', provider: 'opencode-go', model: 'm' },
      { id: 'worker', role: 'исполнитель', provider: 'opencode-go', model: 'm' },
      { id: 'judge', role: 'приёмщик', provider: 'opencode-go', model: 'm' },
    ],
    edges: [
      { from: 'coordinator', to: 'worker', kind: 'delegate' },
      { from: 'worker', to: 'judge', kind: 'review' },
      { from: 'judge', to: 'coordinator', kind: 'report' },
    ],
  });
}

function codes(result) {
  return (result.findings || []).map((item) => item.code);
}

function errorsOf(result) {
  return (result.findings || []).filter((item) => item.severity === 'error');
}

function withCode(result, code) {
  return (result.findings || []).find((item) => item.code === code);
}

/* ------------------------------------------------------------------------- *
 * Инвариант 1: координатор
 * ------------------------------------------------------------------------- */

await test('исправная структура: находок нет, ok', () => {
  const result = validateStructure(good(), {});
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

await test('нет координатора — error no-coordinator', () => {
  const graph = graphOf({ nodes: [{ id: 'worker', role: 'исполнитель', provider: 'p', model: 'm' }] });
  const result = validateStructure(graph, {});
  const item = withCode(result, 'no-coordinator');
  assert.ok(item, 'код no-coordinator');
  assert.equal(item.severity, 'error');
  assert.equal(result.ok, false);
  assert.equal(item.fix && item.fix.kind, 'choice', 'координатора выбирает человек');
});

await test('координатор узнаётся по роли, а не только по id', () => {
  const graph = good();
  graph.nodes[0].id = 'lead';
  graph.nodes[0].role = 'координатор структуры';
  graph.edges[0].from = 'lead';
  graph.edges[2].to = 'lead';
  const result = validateStructure(graph, {});
  assert.deepEqual(result.findings, []);
});

/* ------------------------------------------------------------------------- *
 * Инвариант 2: у исполнителя ровно один приёмщик
 * ------------------------------------------------------------------------- */

await test('у исполнителя нет приёмщика — error no-acceptor', () => {
  const graph = graphOf({
    nodes: [
      { id: 'coordinator', role: 'координатор', provider: 'p', model: 'm' },
      { id: 'worker', role: 'исполнитель', provider: 'p', model: 'm' },
    ],
  });
  const result = validateStructure(graph, {});
  const item = withCode(result, 'no-acceptor');
  assert.ok(item, 'код no-acceptor');
  assert.equal(item.node, 'worker');
  assert.equal(item.severity, 'error');
  assert.equal(result.ok, false);
});

await test('два приёмщика у узла — error multi-acceptor', () => {
  const graph = good();
  graph.edges.push({ from: 'worker', to: 'coordinator', kind: 'report' });
  const result = validateStructure(graph, {});
  const item = withCode(result, 'multi-acceptor');
  assert.ok(item, 'код multi-acceptor');
  assert.equal(item.node, 'worker');
  assert.match(item.message, /judge/u);
  assert.match(item.message, /coordinator/u);
});

await test('координатору приёмщик не нужен', () => {
  const graph = good();
  const result = validateStructure(graph, {});
  assert.equal((result.findings || []).some((item) => item.code === 'no-acceptor' && item.node === 'coordinator'), false);
});

/* ------------------------------------------------------------------------- *
 * Инвариант 3: цепочка review/report ациклична
 * ------------------------------------------------------------------------- */

await test('кольцо review/report — error cycle с путём', () => {
  const graph = graphOf({
    nodes: [
      { id: 'coordinator', role: 'координатор', provider: 'p', model: 'm' },
      { id: 'a', role: 'исполнитель', provider: 'p', model: 'm' },
      { id: 'b', role: 'ревьюер', provider: 'p', model: 'm' },
      { id: 'judge', role: 'приёмщик', provider: 'p', model: 'm' },
    ],
    edges: [
      { from: 'a', to: 'b', kind: 'report' },
      { from: 'b', to: 'a', kind: 'report' },
      { from: 'a', to: 'judge', kind: 'review' },
    ],
  });
  const result = validateStructure(graph, {});
  const item = withCode(result, 'cycle');
  assert.ok(item, 'код cycle');
  assert.equal(item.severity, 'error');
  assert.match(item.message, /a -> b -> a/u);
  assert.equal(result.ok, false);
});

await test('кольцо из трёх узлов — одна находка, не три', () => {
  const graph = graphOf({
    nodes: [
      { id: 'coordinator', role: 'координатор', provider: 'p', model: 'm' },
      { id: 'a', role: 'исполнитель', provider: 'p', model: 'm' },
      { id: 'b', role: 'ревьюер', provider: 'p', model: 'm' },
      { id: 'c', role: 'ревьюер', provider: 'p', model: 'm' },
    ],
    edges: [
      { from: 'a', to: 'b', kind: 'report' },
      { from: 'b', to: 'c', kind: 'report' },
      { from: 'c', to: 'a', kind: 'report' },
    ],
  });
  const result = validateStructure(graph, {});
  assert.equal(codes(result).filter((code) => code === 'cycle').length, 1);
});

await test('связи delegate кольцом — не cycle: кольца delegate запрещает сборщик', () => {
  const graph = good();
  graph.edges.push({ from: 'judge', to: 'worker', kind: 'delegate' });
  const result = validateStructure(graph, {});
  assert.equal((result.findings || []).some((item) => item.code === 'cycle'), false);
});

/* ------------------------------------------------------------------------- *
 * Инвариант 4 и 5: роли непустые, рёбра ведут в существующие узлы
 * ------------------------------------------------------------------------- */

await test('пустая роль — error empty-role', () => {
  const graph = good();
  graph.nodes[1].role = '';
  const result = validateStructure(graph, {});
  const item = withCode(result, 'empty-role');
  assert.ok(item, 'код empty-role');
  assert.equal(item.node, 'worker');
  assert.equal(item.severity, 'error');
});

await test('связь в несуществующий узел — error dangling-edge с адресом связи', () => {
  const graph = good();
  graph.edges.push({ from: 'worker', to: 'ghost', kind: 'report' });
  const result = validateStructure(graph, {});
  const item = withCode(result, 'dangling-edge');
  assert.ok(item, 'код dangling-edge');
  assert.deepEqual(item.edge, { from: 'worker', to: 'ghost', kind: 'report' });
  assert.match(item.message, /ghost/u);
  assert.equal(result.ok, false);
});

await test('связь из несуществующего узла — тоже dangling-edge', () => {
  const graph = good();
  graph.edges.push({ from: 'ghost', to: 'worker', kind: 'delegate' });
  const result = validateStructure(graph, {});
  assert.ok(withCode(result, 'dangling-edge'));
});

/* ------------------------------------------------------------------------- *
 * Инвариант 6: провайдер и модель — по настройке forceModelCheck (D2)
 * ------------------------------------------------------------------------- */

await test('флаг выключен — provider-missing только warning, запуск не блокируется', () => {
  const graph = good();
  graph.nodes[1].provider = 'opencode';
  const result = validateStructure(graph, { forceModelCheck: false, knownProviders: ['opencode-go'] });
  const item = withCode(result, 'provider-missing');
  assert.ok(item, 'находка есть');
  assert.equal(item.severity, 'warning');
  assert.equal(result.ok, true, 'warning не блокирует');
});

await test('флаг включён — provider-missing error с ближайшим именем', () => {
  const graph = good();
  graph.nodes[1].provider = 'opencode';
  const result = validateStructure(graph, { forceModelCheck: true, knownProviders: ['opencode-go'] });
  const item = withCode(result, 'provider-missing');
  assert.ok(item, 'код provider-missing');
  assert.equal(item.severity, 'error');
  assert.equal(item.node, 'worker');
  assert.match(item.message, /opencode-go/u, 'подсказка ближайшего провайдера');
  assert.equal(result.ok, false);
});

await test('флаг включён без списка провайдеров — проверка не выдумывается', () => {
  const graph = good();
  graph.nodes[1].provider = 'opencode';
  const result = validateStructure(graph, { forceModelCheck: true });
  assert.deepEqual(result.findings, []);
});

await test('у узла нет модели — model-missing по флагу', () => {
  const graph = good();
  delete graph.nodes[2].model;
  const result = validateStructure(graph, { forceModelCheck: true, knownProviders: ['opencode-go'] });
  const item = withCode(result, 'model-missing');
  assert.ok(item, 'код model-missing');
  assert.equal(item.node, 'judge');
  assert.equal(item.severity, 'error');
});

await test('модель-алиас разворачивается по graph.models при проверке провайдера', () => {
  const graph = graphOf({
    models: { ds: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
    nodes: [
      { id: 'coordinator', role: 'координатор', provider: 'opencode-go', model: 'm' },
      { id: 'worker', role: 'исполнитель', model: 'ds' },
      { id: 'judge', role: 'приёмщик', provider: 'opencode-go', model: 'm' },
    ],
    edges: [
      { from: 'coordinator', to: 'worker', kind: 'delegate' },
      { from: 'worker', to: 'judge', kind: 'review' },
      { from: 'judge', to: 'coordinator', kind: 'report' },
    ],
  });
  const result = validateStructure(graph, { forceModelCheck: true, knownProviders: ['opencode-go'] });
  assert.equal(errorsOf(result).length, 0, 'алиас ведёт к известному провайдеру');
});

/* ------------------------------------------------------------------------- *
 * Форма результата и словарь кодов
 * ------------------------------------------------------------------------- */

await test('находки несут code/severity/message, fix — safe|choice', () => {
  const graph = good();
  graph.nodes[1].role = '';
  graph.edges.push({ from: 'worker', to: 'ghost', kind: 'report' });
  const result = validateStructure(graph, {});
  assert.ok(result.findings.length > 0);
  for (const item of result.findings) {
    assert.equal(typeof item.code, 'string');
    assert.ok(item.severity === 'error' || item.severity === 'warning');
    assert.equal(typeof item.message, 'string');
    assert.ok(item.message.length > 0);
    if (item.fix) {
      assert.ok(item.fix.kind === 'safe' || item.fix.kind === 'choice');
      assert.equal(typeof item.fix.description, 'string');
    }
  }
});

await test('словарь кодов задания 0161 — все восемь', () => {
  assert.deepEqual([...FINDING_CODES].sort(), [
    'cycle', 'dangling-edge', 'empty-role', 'model-missing',
    'multi-acceptor', 'no-acceptor', 'no-coordinator', 'provider-missing',
  ]);
});

await test('битый/пустой граф не бросает: no-coordinator и ok:false', () => {
  for (const value of [null, undefined, {}, { nodes: 'нет' }]) {
    const result = validateStructure(value, {});
    assert.equal(result.ok, false);
    assert.ok(withCode(result, 'no-coordinator'));
  }
});

await test('исправность проекта: structure/graph.json проходит без error', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, '..', 'structure', 'graph.json');
  const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = validateStructure(graph, {});
  assert.deepEqual(errorsOf(result), []);
  assert.equal(result.ok, true);
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(failure.error && failure.error.stack ? failure.error.stack : failure.error);
  }
  console.error('STRUCTURE-VALIDATOR TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('STRUCTURE-VALIDATOR TEST OK: ' + passed + '/' + passed);
