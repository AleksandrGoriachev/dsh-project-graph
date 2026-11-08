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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FINDING_CODES, ensureCoordinator, loadValidatorSettings, saveValidatorSettings, validateStructure,
  validationReport, validatorSettingsPath, watchStructure,
} from '../lib/structure-validator.js';
import { buildGraph } from '../lib/graph.js';

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

await test('нет координатора — info no-coordinator с безопасной правкой, запуск не блокируется (0175)', () => {
  const graph = graphOf({ nodes: [{ id: 'worker', role: 'исполнитель', provider: 'p', model: 'm' }] });
  const result = validateStructure(graph, {});
  const item = withCode(result, 'no-coordinator');
  assert.ok(item, 'код no-coordinator');
  assert.equal(item.severity, 'info', 'координатор есть всегда: это подсказка, а не блок');
  assert.deepEqual(errorsOf(result).filter((finding) => finding.code === 'no-coordinator'), [],
    'координатор больше не блокирует запуск');
  assert.equal(item.fix && item.fix.kind, 'safe', 'правка механическая');
  assert.equal(item.fix && item.fix.code, 'add-coordinator');
});

await test('граф, прочитанный без координатора, валидатор не блокирует (0175)', () => {
  const built = buildGraph([{ name: 'graph.json', text: JSON.stringify({ version: 1, nodes: [{ id: 'worker', role: 'исполнитель' }], edges: [] }) }]);
  const result = validateStructure(built.graph, {});
  assert.equal(withCode(result, 'no-coordinator'), undefined,
    'координатор уже пришёл из чтения — подсказки нет');
  assert.deepEqual(errorsOf(result).filter((item) => item.code === 'no-coordinator'), []);
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
 * Задание 0170: координатор есть всегда, пустой граф — начало, а не тупик
 * ------------------------------------------------------------------------- */

await test('ensureCoordinator: пустой граф получает узел coordinator', () => {
  const graph = { version: 1, nodes: [], folders: [], edges: [] };
  const seeded = ensureCoordinator(graph);
  assert.notEqual(seeded, graph, 'возвращается копия графа, а не тот же объект');
  assert.deepEqual(graph.nodes, [], 'исходный граф не меняется');
  assert.equal(seeded.nodes.length, 1);
  assert.equal(seeded.nodes[0].id, 'coordinator');
  assert.equal(seeded.nodes[0].role, 'координатор');
  const result = validateStructure(seeded, {});
  assert.deepEqual(result.findings, [], 'seed-граф проходит без находок');
  assert.equal(result.ok, true);
});

await test('ensureCoordinator: существующий координатор не трогается', () => {
  const graph = good();
  const before = JSON.stringify(graph.nodes[0]);
  const seeded = ensureCoordinator(graph);
  assert.equal(seeded.nodes.length, 3, 'второй координатор не добавлен');
  assert.equal(JSON.stringify(seeded.nodes[0]), before, 'роль и маршрут прежние');
  assert.equal(seeded.nodes.filter((node) => node.id === 'coordinator').length, 1);
  const byRole = ensureCoordinator({ nodes: [{ id: 'lead', role: 'координатор структуры' }] });
  assert.equal(byRole.nodes.length, 1, 'координатор по роли тоже считается объявленным');
});

await test('ensureCoordinator: маршрут по умолчанию — defaults или алиас work', () => {
  const direct = ensureCoordinator({ nodes: [] }, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
  assert.equal(direct.nodes[0].provider, 'opencode-go');
  assert.equal(direct.nodes[0].model, 'deepseek-v4.1-flash');
  const aliased = ensureCoordinator({ nodes: [], models: { work: { provider: 'p', model: 'm' } } });
  assert.equal(aliased.nodes[0].model, 'work', 'маршрут через алиас, как в стартовой структуре');
  assert.equal(aliased.nodes[0].provider, undefined, 'provider не выдумывается: его разворачивает models');
  const bare = ensureCoordinator({ nodes: [] });
  assert.equal(bare.nodes[0].provider, undefined);
  assert.equal(bare.nodes[0].model, undefined, 'чужой маршрут не выдумывается: модель назовёт человек');
});

await test('пустой граф — info empty-graph и ok:true, а не error', () => {
  const result = validateStructure({ version: 1, nodes: [], folders: [], edges: [] }, {});
  assert.equal(result.ok, true, 'пустой граф не блокирует запуск');
  assert.deepEqual(errorsOf(result), [], 'ни одной error-находки');
  assert.equal(result.findings.length, 1, 'пустой граф — одна находка, а не букет');
  const item = withCode(result, 'empty-graph');
  assert.ok(item, 'код empty-graph');
  assert.equal(item.severity, 'info');
  assert.equal(item.fix && item.fix.kind, 'safe', 'правка механическая, без выбора человека');
  assert.equal(item.fix && item.fix.code, 'add-coordinator');
  assert.ok(item.message.length > 0, 'находка объясняет человеку, что случилось');
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

/*
 * Граф без объявленного списка узлов — это не «пустая структура» 0170, а
 * отсутствие структуры: доказать, что граф только создан, тут нельзя.
 * Явные 0 узлов (nodes: []) — отдельный случай: info empty-graph и ok:true.
 */
await test('граф без списка узлов не бросает: no-coordinator, но это не error (0175)', () => {
  /*
   * 0175: координатор — инвариант чтения и записи, а не приговор валидатора.
   * Битый граф ловит buildGraph (error empty-graph), а валидатор лишь называет
   * отсутствие координатора подсказкой с механической правкой.
   */
  for (const value of [null, undefined, {}, { nodes: 'нет' }, { nodes: [{ role: 'исполнитель' }] }]) {
    const result = validateStructure(value, {});
    const item = withCode(result, 'no-coordinator');
    assert.ok(item, 'код no-coordinator есть: ' + JSON.stringify(value));
    assert.equal(item.severity, 'info', 'это подсказка, а не error');
    assert.equal(result.ok, true);
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


/* ------------------------------------------------------------------------- *
 * Настройки валидатора, отчёт и листенер (задание 0167)
 * ------------------------------------------------------------------------- */

/** Проект с папкой структуры и исправным графом; настройки пишутся отдельно. */
function workspace(graph = good()) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-validator-0167-')));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  return root;
}

await test('loadValidatorSettings: без файла проверка включена по умолчанию', () => {
  const root = workspace();
  const settings = loadValidatorSettings(root);
  assert.equal(settings.forceModelCheck, true, 'D1: дефолт true');
  assert.deepEqual(settings.allowUnknownModel, []);
  assert.equal(settings.updatedAt, undefined);
});

await test('loadValidatorSettings: файл главнее дефолта и несёт аудит', () => {
  const root = workspace();
  fs.writeFileSync(validatorSettingsPath(root), JSON.stringify({
    forceModelCheck: false,
    allowUnknownModel: ['worker', '  judge  ', 'worker'],
    updatedAt: '2026-11-08T21:00:00.000Z',
    updatedBy: 'заказчик',
  }, null, 2));
  const settings = loadValidatorSettings(root);
  assert.equal(settings.forceModelCheck, false);
  assert.deepEqual(settings.allowUnknownModel, ['worker', 'judge'], 'пустые и повторы убраны');
  assert.equal(settings.updatedAt, '2026-11-08T21:00:00.000Z');
  assert.equal(settings.updatedBy, 'заказчик');
});

await test('loadValidatorSettings: битый файл — дефолт, без исключения', () => {
  const root = workspace();
  for (const text of ['{', '[]', 'null', '{"forceModelCheck":"нет"}']) {
    fs.writeFileSync(validatorSettingsPath(root), text);
    const settings = loadValidatorSettings(root);
    assert.equal(settings.forceModelCheck, true, 'битый/непонятный файл = дефолт');
    assert.deepEqual(settings.allowUnknownModel, []);
  }
});

await test('saveValidatorSettings: запись, аудит и сохранение соседних полей', () => {
  const root = workspace();
  const first = saveValidatorSettings(root, { forceModelCheck: false, updatedBy: 'заказчик' });
  assert.equal(first.forceModelCheck, false);
  assert.ok(first.updatedAt, 'updatedAt ставит валидатор');
  assert.equal(first.updatedBy, 'заказчик');
  const file = validatorSettingsPath(root);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.forceModelCheck, false);
  assert.ok(parsed.updatedAt && parsed.updatedBy, 'аудит в файле');
  const second = saveValidatorSettings(root, { allowUnknownModel: ['worker'] });
  assert.equal(second.forceModelCheck, false, 'патч разрешений не сбрасывает флаг');
  assert.deepEqual(second.allowUnknownModel, ['worker']);
  assert.equal(second.updatedBy, 'заказчик', 'прежний автор сохраняется');
  const leftovers = fs.readdirSync(path.join(root, 'structure')).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'временных файлов после атомарной записи нет');
});

await test('validateStructure: модели вне каталога — error model-missing', () => {
  const graph = good();
  graph.nodes[1].model = 'нэт';
  const result = validateStructure(graph, {
    forceModelCheck: true,
    knownProviders: ['opencode-go'],
    models: { 'opencode-go': ['m'] },
  });
  const item = result.findings.find((finding) => finding.code === 'model-missing' && finding.node === 'worker');
  assert.ok(item, 'код model-missing у изменённого узла');
  assert.equal(item.severity, 'error');
  assert.equal(item.node, 'worker');
  assert.match(item.message, /opencode-go/u);
  assert.equal(result.ok, false);
});

await test('allowUnknownModel: model-missing остаётся, но warning и не блокирует', () => {
  const graph = good();
  graph.nodes[1].model = 'нэт';
  const result = validateStructure(graph, {
    forceModelCheck: true,
    knownProviders: ['opencode-go'],
    models: { 'opencode-go': ['m'] },
    allowUnknownModel: ['worker'],
  });
  const item = result.findings.find((finding) => finding.code === 'model-missing' && finding.node === 'worker');
  assert.ok(item, 'находка остаётся');
  assert.equal(item.severity, 'warning');
  assert.equal(result.ok, true, 'warning не блокирует запуск');
  assert.match(item.message, /allowUnknownModel/u);
});

await test('каталог принимает записи llm {id} и не судит чужого провайдера', () => {
  const graph = good();
  const okCatalog = validateStructure(graph, {
    forceModelCheck: true,
    knownProviders: ['opencode-go'],
    models: { 'opencode-go': [{ id: 'm' }] },
  });
  assert.equal(okCatalog.findings.some((item) => item.code === 'model-missing'), false, 'модель из каталога');
  const foreign = good();
  foreign.nodes[1].provider = 'other';
  const foreignResult = validateStructure(foreign, {
    forceModelCheck: true,
    knownProviders: ['opencode-go', 'other'],
    models: { 'opencode-go': ['m'] },
  });
  assert.equal(foreignResult.findings.some((item) => item.code === 'model-missing'), false,
    'провайдера нет в каталоге — сверять модель не с чем');
});

await test('каталог без списка провайдеров всё равно сверяет модель (C4)', () => {
  const graph = good();
  graph.nodes[1].model = 'нэт';
  const result = validateStructure(graph, {
    forceModelCheck: true,
    models: { 'opencode-go': ['m'] },
  });
  const item = result.findings.find((finding) => finding.code === 'model-missing' && finding.node === 'worker');
  assert.ok(item, 'каталог сам доказывает, что провайдер известен');
  assert.equal(item.severity, 'error');
  assert.equal(result.findings.some((finding) => finding.code === 'provider-missing'), false);
});

await test('validationReport: исправная структура — ok, настройки по умолчанию', () => {
  const root = workspace();
  const report = validationReport(root, {
    knownProviders: ['opencode-go'],
    models: { 'opencode-go': ['m'] },
  });
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.deepEqual(report.findings, []);
  assert.equal(report.forceModelCheck, true);
  assert.match(report.settingsPath, /structure[\\/]validator\.json$/u);
  assert.equal(report.structure.nodes, 3);
});

await test('validationReport: файл выключает проверку моделей, инварианты остаются', () => {
  const root = workspace();
  const graph = good();
  graph.nodes[1].model = 'нэт';
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  saveValidatorSettings(root, { forceModelCheck: false, updatedBy: 'заказчик' });
  const report = validationReport(root, {
    knownProviders: ['opencode-go'],
    models: { 'opencode-go': ['m1'] },
  });
  assert.equal(report.forceModelCheck, false);
  assert.equal(report.findings.some((item) => item.code === 'model-missing'), false);
  assert.equal(report.ok, true);
});

await test('validationReport: allowUnknownModel из файла делает находку warning', () => {
  const root = workspace();
  const graph = good();
  graph.nodes[1].model = 'нэт';
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  saveValidatorSettings(root, { allowUnknownModel: ['worker'], updatedBy: 'заказчик' });
  const report = validationReport(root, {
    knownProviders: ['opencode-go'],
    models: { 'opencode-go': ['m'] },
  });
  const item = report.findings.find((finding) => finding.code === 'model-missing' && finding.node === 'worker');
  assert.ok(item, 'находка на месте');
  assert.equal(item.severity, 'warning');
  assert.equal(report.ok, true);
});

await test('validationReport: недоступный каталог — warning, не блокировка (D1)', () => {
  const root = workspace();
  const report = validationReport(root, {
    catalog: { ok: false, reason: 'служба llm не подключена' },
  });
  const item = report.findings.find((finding) => finding.code === 'catalog-unavailable');
  assert.ok(item, 'предупреждение названо');
  assert.equal(item.severity, 'warning');
  assert.equal(report.ok, true, 'каталог не блокирует структуру');
});

await test('validationReport: битый граф — ok:false с ошибкой чтения, а не исключение', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), '{ битый');
  const report = validationReport(root, {});
  assert.equal(report.ok, false);
  assert.ok(report.findings.length > 0, 'находки есть');
});

await test('watchStructure: изменение графа вызывает отчёт, stop останавливает', async () => {
  const root = workspace();
  const calls = [];
  const stop = watchStructure(root, {
    debounceMs: 30,
    onChange: (report) => calls.push(report),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const file = path.join(root, 'structure', 'graph.json');
    const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
    graph.nodes.pop();
    fs.writeFileSync(file, JSON.stringify(graph, null, 2));
    for (let attempt = 0; attempt < 40 && calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(calls.length > 0, 'листенер пересчитал структуру');
    assert.ok(calls[0].findings.some((item) => item.code === 'no-acceptor' || item.code === 'no-coordinator'),
      JSON.stringify(calls[0].findings));
  } finally {
    stop();
  }
  const before = calls.length;
  const file = path.join(root, 'structure', 'graph.json');
  const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
  graph.nodes.push({ id: 'judge2', role: 'приёмщик', provider: 'opencode-go', model: 'm' });
  fs.writeFileSync(file, JSON.stringify(graph, null, 2));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(calls.length, before, 'после stop пересчёта нет');
});

await test('watchStructure: недоступная папка — noop вместо исключения', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-validator-missing-'));
  let stop = null;
  assert.doesNotThrow(() => { stop = watchStructure(root, { onChange: () => {} }); });
  assert.equal(typeof stop, 'function');
  stop();
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
