#!/usr/bin/env node
/**
 * Задание 0368: рубрика качества задания, CLI audit-check и пересчёт в воротах.
 *
 * Проверяется то, что заказчик потребовал машинно: каждый пункт рубрики даёт
 * ok и fail на подставных данных; дефект 0366 (версия поднимается, файл с
 * литералом версии не разрешён) даёт fail required_edits_covered; расхождение
 * заявленного аудитором вердикта с пересчётом даёт отказ ворот запуска.
 *
 * Все каталоги заданий — временные (os.tmpdir); реальные задания не трогаются.
 *
 *   node test/audit-check.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RUBRIC_CODES,
  compareAuditEvidence,
  computeRubricFromTask,
} from '../lib/audit-rubric.js';
import { createGraphRuntime } from '../lib/api.js';
import { createSpawnTool } from '../lib/spawn.js';
/* Стенд даёт инструменту ту же службу llm, что и DSH: без неё маршрут узла не проверить. */
import { llmStub } from '../checks/support/llm-stub.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'tools', 'audit-check.mjs');
/* Прогон не трогает профиль: история запусков и store — во временных каталогах. */
process.env.PG_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0368-runs-'));
process.env.DSH_PROJECT_GRAPH_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0368-store-'));

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

function write(root, rel, body) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

/* ------------------------------------------------------------------------- *
 * Подставные данные: каталог задания во временном проекте.
 * ------------------------------------------------------------------------- */

function metaBase(over = {}) {
  return {
    id: '9001',
    version: 1,
    title: 'подставное задание',
    risk: 'medium',
    owner: 'заказчик',
    executor: 'subagent:worker',
    acceptor: 'subagent:judge',
    base: 'HEAD',
    criteria: 'criteria.json',
    allowedPaths: ['lib/a.js', 'test/a.test.mjs', 'test/b.test.mjs', 'docs/tasks/9001/**'],
    protectedPaths: [],
    ...over,
  };
}

function criteriaBase(over = {}) {
  return {
    task: '9001',
    setup: [],
    teardown: [],
    redExpect: {
      mustFail: ['C1'],
      mustPass: ['C2'],
      reasonWindow: 60,
      reasons: { C1: 'Cannot find module' },
    },
    criteria: [
      { id: 'C1', title: 'новый тест', command: 'node test/a.test.mjs', cwd: '.', covers: ['test/a.test.mjs'], timeoutMs: 120000, expect: { exitCode: 0 }, tags: ['fast', 'behaviour', 'negative'] },
      { id: 'C2', title: 'существующий тест', command: 'node test/b.test.mjs', cwd: '.', covers: ['test/b.test.mjs'], timeoutMs: 120000, expect: { exitCode: 0 }, tags: ['fast', 'behaviour'] },
    ],
    ...over,
  };
}

function redBase(over = {}) {
  return {
    version: 5,
    task: '9001',
    results: [
      { id: 'C1', exitCode: 1, passed: false, timedOut: false },
      { id: 'C2', exitCode: 0, passed: true, timedOut: false },
    ],
    ...over,
  };
}

const RED_LOG = "Error: Cannot find module 'test/a.test.mjs'\n";

const DEFAULT_FILES = {
  'lib/a.js': 'export const a = 1;\n',
  'test/a.test.mjs': '// новый тест\n',
  'test/b.test.mjs': '// существующий тест\n',
};

function taskDoc({ meta = metaBase(), action = '1. Изменить `lib/a.js`.', rows, goal = 'Цель подставного задания.' } = {}) {
  const tableRows = rows || [['C1', 'node test/a.test.mjs', 'новый тест зелёный'], ['C2', 'node test/b.test.mjs', 'существующий тест зелёный']];
  const table = tableRows.map((row) => '| ' + row.join(' | ') + ' |').join('\n');
  return [
    '# Задание 9001', '',
    '<!-- TASK-META', JSON.stringify(meta, null, 2), '-->', '',
    '## Цель', '', goal, '',
    '## Что сделать', '', action, '',
    '## Критерии приёмки', '',
    '<!-- CRITERIA:BEGIN -->',
    '| ID | Проверка | Ожидание |',
    '| --- | --- | --- |',
    table,
    '<!-- CRITERIA:END -->', '',
  ].join('\n');
}

function project({ meta = metaBase(), task, criteria = criteriaBase(), red = redBase(), redLog = RED_LOG, files = {}, packageVersion = '1.0.90' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0368-ws-'));
  write(root, 'package.json', { name: 'pg-fixture', version: packageVersion, private: true });
  for (const [rel, body] of Object.entries({ ...DEFAULT_FILES, ...files })) write(root, rel, body);
  const taskDir = path.join(root, 'docs', 'tasks', '9001');
  fs.mkdirSync(taskDir, { recursive: true });
  write(taskDir, 'task.md', task === undefined ? taskDoc({ meta }) : task);
  if (criteria !== null) write(taskDir, 'criteria.json', criteria);
  if (red !== null) write(taskDir, 'red.json', red);
  if (redLog !== null) write(taskDir, 'red.log', redLog);
  return { root, taskDir };
}

function itemOf(computed, code) {
  const item = computed.items.find((entry) => entry.code === code);
  assert.ok(item, 'нет пункта рубрики ' + code);
  return item;
}

function verdictOf(computed, code) {
  return itemOf(computed, code).verdict;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

/* ------------------------------------------------------------------------- *
 * Рубрика: каждый пункт даёт ok и fail на подставных данных.
 * ------------------------------------------------------------------------- */

await test('рубрика: исправное задание — все применимые пункты ok, остальные na', () => {
  const p = project();
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(computed.ok, true, 'fail: ' + computed.failures.join(', '));
  assert.deepEqual([...RUBRIC_CODES], [
    'goal_measured', 'reason_from_output', 'mustpass_green_on_base', 'no_degenerate_criterion',
    'negative_tag_present', 'paths_covered', 'required_edits_covered', 'no_red_justified',
  ]);
  for (const code of ['goal_measured', 'reason_from_output', 'mustpass_green_on_base', 'no_degenerate_criterion', 'negative_tag_present', 'paths_covered']) {
    assert.equal(verdictOf(computed, code), 'ok', code + ': ' + itemOf(computed, code).evidence);
  }
  assert.equal(verdictOf(computed, 'required_edits_covered'), 'na');
  assert.equal(verdictOf(computed, 'no_red_justified'), 'na');
  for (const item of computed.items) {
    assert.ok(String(item.evidence).trim(), 'пункт ' + item.code + ' без доказательства');
  }
});

await test('goal_measured: команды таблицы нет в criteria.json — fail с доказательством', () => {
  const p = project({ task: taskDoc({ rows: [['C1', 'node test/ghost.test.mjs', 'ok'], ['C2', 'node test/b.test.mjs', 'ok']] }) });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'goal_measured'), 'fail');
  assert.match(itemOf(computed, 'goal_measured').evidence, /ghost\.test\.mjs/u);
});

await test('goal_measured: без criteria.json сверять не с чем — fail', () => {
  const p = project({ criteria: null });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'goal_measured'), 'fail');
  assert.match(itemOf(computed, 'goal_measured').evidence, /criteria\.json/u);
});

await test('reason_from_output: причины нет в red.log — fail, причина названа', () => {
  const p = project({ redLog: 'Error: boom\n' });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'reason_from_output'), 'fail');
  assert.match(itemOf(computed, 'reason_from_output').evidence, /Cannot find module/u);
});

await test('reason_from_output: red.log нет — fail, а не падение', () => {
  const p = project({ redLog: null });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'reason_from_output'), 'fail');
  assert.match(itemOf(computed, 'reason_from_output').evidence, /red\.log/u);
});

await test('reason_from_output: причин не объявлено — na', () => {
  const criteria = criteriaBase();
  criteria.redExpect.reasons = {};
  const p = project({ criteria });
  assert.equal(verdictOf(computeRubricFromTask(p.taskDir), 'reason_from_output'), 'na');
});

await test('mustpass_green_on_base: mustPass красный на базе — fail', () => {
  const p = project({ red: redBase({ results: [{ id: 'C1', exitCode: 1, passed: false }, { id: 'C2', exitCode: 1, passed: false }] }) });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'mustpass_green_on_base'), 'fail');
  assert.match(itemOf(computed, 'mustpass_green_on_base').evidence, /C2/u);
});

await test('mustpass_green_on_base: red.json нет — fail, а не падение', () => {
  const p = project({ red: null });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'mustpass_green_on_base'), 'fail');
  assert.match(itemOf(computed, 'mustpass_green_on_base').evidence, /red\.json/u);
});

await test('no_degenerate_criterion: критерий проверяет несуществующий файл вне allowedPaths — fail', () => {
  const criteria = criteriaBase();
  criteria.criteria[0].command = 'node test/ghost.test.mjs';
  criteria.criteria[0].covers = ['test/ghost.test.mjs'];
  const p = project({ criteria, task: taskDoc({ rows: [['C1', 'node test/ghost.test.mjs', 'ok'], ['C2', 'node test/b.test.mjs', 'ok']] }) });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'no_degenerate_criterion'), 'fail');
  assert.match(itemOf(computed, 'no_degenerate_criterion').evidence, /test\/ghost\.test\.mjs/u);
  assert.equal(verdictOf(computed, 'goal_measured'), 'ok', 'таблица и критерии согласованы');
});

await test('negative_tag_present: у medium нет тега negative — fail', () => {
  const criteria = criteriaBase();
  criteria.criteria[0].tags = ['fast', 'behaviour'];
  const p = project({ criteria });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'negative_tag_present'), 'fail');
  assert.match(itemOf(computed, 'negative_tag_present').evidence, /negative/u);
});

await test('negative_tag_present: риск low — na (тег не требуется)', () => {
  const p = project({ meta: metaBase({ risk: 'low' }) });
  assert.equal(verdictOf(computeRubricFromTask(p.taskDir), 'negative_tag_present'), 'na');
});

await test('paths_covered: путь из «Что сделать» не разрешён — fail', () => {
  const p = project({ task: taskDoc({ action: '1. Изменить `lib/secret.js`.' }) });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'paths_covered'), 'fail');
  assert.match(itemOf(computed, 'paths_covered').evidence, /lib\/secret\.js/u);
});

await test('paths_covered: путей в разделе нет — na', () => {
  const p = project({ task: taskDoc({ action: '1. Сделать работу без имён файлов.' }) });
  assert.equal(verdictOf(computeRubricFromTask(p.taskDir), 'paths_covered'), 'na');
});

await test('required_edits_covered: версия поднимается, все файлы с литералом разрешены — ok', () => {
  const meta = metaBase({ allowedPaths: ['package.json', 'test/pin.test.mjs', 'docs/tasks/9001/**'] });
  const p = project({
    meta,
    packageVersion: '1.0.89',
    files: { 'test/pin.test.mjs': "const EXPECTED_VERSION = '1.0.89';\n" },
    task: taskDoc({ meta, action: '1. Поднять версию в `package.json` до `1.0.90`.' }),
  });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'required_edits_covered'), 'ok', itemOf(computed, 'required_edits_covered').evidence);
  assert.match(itemOf(computed, 'required_edits_covered').evidence, /test\/pin\.test\.mjs/u);
});

await test('0366: версия поднимается, файл с литералом не разрешён — fail required_edits_covered', () => {
  const meta = metaBase({ allowedPaths: ['package.json', 'docs/tasks/9001/**'] });
  const p = project({
    meta,
    packageVersion: '1.0.89',
    files: { 'test/pin.test.mjs': "const EXPECTED_VERSION = '1.0.89';\n" },
    task: taskDoc({ meta, action: '1. Поднять версию в `package.json` до `1.0.90`.' }),
  });
  const item = itemOf(computeRubricFromTask(p.taskDir), 'required_edits_covered');
  assert.equal(item.verdict, 'fail');
  assert.match(item.evidence, /test\/pin\.test\.mjs/u, 'назван непокрытый файл с литералом');
  assert.match(item.evidence, /0366/u, 'доказательство называет дефект 0366');
});

await test('required_edits_covered: версия не поднимается — na', () => {
  const p = project();
  assert.equal(verdictOf(computeRubricFromTask(p.taskDir), 'required_edits_covered'), 'na');
});

await test('no_red_justified: красный не требуется и причина есть — ok с именем файла', () => {
  const criteria = criteriaBase({ redExpect: { mustFail: [], mustPass: ['C2'], reasonWindow: 60, reasons: {}, noRed: { reason: 'фиксация уже состоявшегося состояния' } } });
  const p = project({ criteria });
  const item = itemOf(computeRubricFromTask(p.taskDir), 'no_red_justified');
  assert.equal(item.verdict, 'ok');
  assert.match(item.evidence, /criteria\.json redExpect\.noRed\.reason/u);
});

await test('no_red_justified: красный не требуется, причина пуста — fail', () => {
  const criteria = criteriaBase({ redExpect: { mustFail: [], mustPass: ['C2'], reasonWindow: 60, reasons: {}, noRed: { reason: '   ' } } });
  const p = project({ criteria });
  const computed = computeRubricFromTask(p.taskDir);
  assert.equal(verdictOf(computed, 'no_red_justified'), 'fail');
  assert.match(itemOf(computed, 'no_red_justified').evidence, /noRed\.reason/u);
});

await test('no_red_justified: красный требуется — na', () => {
  const p = project();
  assert.equal(verdictOf(computeRubricFromTask(p.taskDir), 'no_red_justified'), 'na');
});

/* ------------------------------------------------------------------------- *
 * Сверка заявленного вердикта с пересчётом.
 * ------------------------------------------------------------------------- */

function evidenceOf(computed, over = {}) {
  return {
    version: 1,
    task: '9001',
    at: '2026-11-26T00:00:00.000Z',
    items: computed.items.map((item) => ({ code: item.code, verdict: item.verdict, evidence: item.evidence })),
    ...over,
  };
}

await test('сверка: полный совпадающий вердикт — расхождений нет', () => {
  const p = project();
  const computed = computeRubricFromTask(p.taskDir);
  assert.deepEqual(compareAuditEvidence(computed, evidenceOf(computed), { id: '9001' }), []);
});

await test('сверка: вердикт по пункту расходится — расхождение названо', () => {
  const p = project();
  const computed = computeRubricFromTask(p.taskDir);
  const evidence = evidenceOf(computed);
  evidence.items = evidence.items.map((item) => (item.code === 'goal_measured' ? { ...item, verdict: 'fail' } : item));
  const problems = compareAuditEvidence(computed, evidence, { id: '9001' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /goal_measured/u);
});

await test('сверка: рубрика неполная — расхождение названо', () => {
  const p = project();
  const computed = computeRubricFromTask(p.taskDir);
  const evidence = evidenceOf(computed);
  evidence.items = evidence.items.filter((item) => item.code !== 'paths_covered');
  assert.match(compareAuditEvidence(computed, evidence, { id: '9001' }).join(' '), /неполная/u);
});

await test('сверка: чужой пункт рубрике неизвестен — расхождение', () => {
  const p = project();
  const computed = computeRubricFromTask(p.taskDir);
  const evidence = evidenceOf(computed);
  evidence.items = [...evidence.items, { code: 'extra', verdict: 'ok', evidence: 'x' }];
  assert.match(compareAuditEvidence(computed, evidence, { id: '9001' }).join(' '), /неизвестен/u);
});

/* ------------------------------------------------------------------------- *
 * CLI tools/audit-check.mjs: таблица, файл и коды выхода.
 * ------------------------------------------------------------------------- */

await test('CLI: ok-задание — exit 0, audit-evidence.json с version/task/at/items', () => {
  const p = project();
  const result = runCli(['--task', p.taskDir], p.root);
  assert.equal(result.status, 0, 'stderr: ' + result.stderr);
  const file = path.join(p.taskDir, 'audit-evidence.json');
  assert.ok(fs.existsSync(file), 'audit-evidence.json записан');
  const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(evidence.version, 1);
  assert.equal(evidence.task, '9001');
  assert.ok(evidence.at);
  assert.deepEqual(evidence.items.map((item) => item.code), [...RUBRIC_CODES]);
  for (const item of evidence.items) {
    assert.ok(['ok', 'fail', 'na'].includes(item.verdict));
    assert.ok(String(item.evidence).trim());
  }
  assert.match(result.stdout, /goal_measured/u, 'таблица печатает пункты');
});

await test('CLI: --json печатает тот же вердикт', () => {
  const p = project();
  const result = runCli(['--task', p.taskDir, '--json'], p.root);
  assert.equal(result.status, 0, 'stderr: ' + result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.task, '9001');
  assert.deepEqual(parsed.items.map((item) => item.code), [...RUBRIC_CODES]);
});

await test('CLI: fail рубрики — exit 1, вердикт fail в файле', () => {
  const p = project({ task: taskDoc({ rows: [['C1', 'node test/ghost.test.mjs', 'ok'], ['C2', 'node test/b.test.mjs', 'ok']] }) });
  const result = runCli(['--task', p.taskDir], p.root);
  assert.equal(result.status, 1);
  const evidence = JSON.parse(fs.readFileSync(path.join(p.taskDir, 'audit-evidence.json'), 'utf8'));
  assert.equal(evidence.items.find((item) => item.code === 'goal_measured').verdict, 'fail');
});

await test('CLI: без --task — exit 2', () => {
  const result = runCli([], REPO);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--task/u);
});

await test('CLI: каталога задания нет — exit 2', () => {
  const result = runCli(['--task', path.join(os.tmpdir(), 'pg-0368-missing-dir')], REPO);
  assert.equal(result.status, 2);
});

/* ------------------------------------------------------------------------- *
 * Ворота запуска: пересчёт в lib/spawn.js.
 * ------------------------------------------------------------------------- */

const AUDIT_GRAPH = {
  version: 1,
  models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
  nodes: [
    { id: 'coordinator', role: 'координатор', model: 'ds' },
    { id: 'worker', role: 'исполнитель', model: 'ds' },
    { id: 'auditor', role: 'Аудитор задач', model: 'ds' },
    { id: 'judge', role: 'приёмщик', model: 'ds' },
  ],
  edges: [
    { from: 'coordinator', to: 'worker', kind: 'delegate' },
    { from: 'coordinator', to: 'auditor', kind: 'delegate' },
    { from: 'auditor', to: 'worker', kind: 'delegate' },
    { from: 'worker', to: 'judge', kind: 'review' },
  ],
};

function auditOk(over = {}) {
  return {
    version: 1,
    task: '9001',
    auditor: 'auditor',
    verdict: 'conform',
    anchors: [{ id: 'A1', status: 'confirmed' }],
    reason: 'рубрика сходится с пересчётом',
    at: '2026-11-26T00:00:00.000Z',
    ...over,
  };
}

const GATE_TASK = 'docs/tasks/9001/task.md';
const EXEC = { agent: { id: 'parent' }, signal: { aborted: false } };

function gateProject({ risk = 'medium', evidence = 'computed', audit = auditOk(), metaOver = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0368-gate-'));
  write(root, 'structure/graph.json', AUDIT_GRAPH);
  write(root, 'package.json', { name: 'pg-fixture', version: '1.0.90', private: true });
  for (const [rel, body] of Object.entries(DEFAULT_FILES)) write(root, rel, body);
  const meta = metaBase({ risk, ...metaOver });
  const taskDir = path.join(root, 'docs', 'tasks', '9001');
  write(taskDir, 'task.md', taskDoc({ meta }));
  write(taskDir, 'criteria.json', criteriaBase());
  write(taskDir, 'red.json', redBase());
  write(taskDir, 'red.log', RED_LOG);
  write(taskDir, 'audit.json', audit);
  if (evidence === 'computed') {
    write(taskDir, 'audit-evidence.json', evidenceOf(computeRubricFromTask(taskDir)));
  } else if (evidence === 'broken') {
    write(taskDir, 'audit-evidence.json', '{');
  } else if (evidence && typeof evidence === 'object') {
    write(taskDir, 'audit-evidence.json', evidence);
  }
  return { root, taskDir };
}

function gateTool(root) {
  const runtime = createGraphRuntime({ roots: [root] }, { getLlm: () => llmStub() });
  const calls = [];
  const subagents = {
    getProvider: () => ({ capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 3,
    async startActivation(spec) {
      calls.push(spec);
      return { childId: 'child-1' };
    },
  };
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  return { tool, calls };
}

await test('ворота: evidence сходится с пересчётом — активация', async () => {
  const p = gateProject();
  const { tool, calls } = gateTool(p.root);
  const value = await tool.execute({ node: 'worker', prompt: 'сделай', task: GATE_TASK }, EXEC);
  assert.equal(value.kind, 'activation');
  assert.equal(calls.length, 1);
});

await test('ворота: вердикт аудитора расходится с пересчётом — отказ', async () => {
  const p = gateProject();
  const computed = computeRubricFromTask(p.taskDir);
  const evidence = evidenceOf(computed);
  evidence.items = evidence.items.map((item) => (item.code === 'goal_measured' ? { ...item, verdict: 'fail' } : item));
  write(p.taskDir, 'audit-evidence.json', evidence);
  const { tool, calls } = gateTool(p.root);
  await assert.rejects(
    () => tool.execute({ node: 'worker', prompt: 'сделай', task: GATE_TASK }, EXEC),
    (error) => {
      assert.equal(error.code, 'audit-required');
      assert.match(error.message, /расходится с пересчётом/u);
      assert.match(error.message, /goal_measured/u);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'до активации дело не дошло');
});

await test('ворота: риск medium без audit-evidence.json — отказ', async () => {
  const p = gateProject({ evidence: 'absent' });
  const { tool, calls } = gateTool(p.root);
  await assert.rejects(
    () => tool.execute({ node: 'worker', prompt: 'сделай', task: GATE_TASK }, EXEC),
    (error) => {
      assert.equal(error.code, 'audit-required');
      assert.match(error.message, /audit-evidence\.json/u);
      assert.match(error.message, /medium/u);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

await test('ворота: рубрика неполная — отказ', async () => {
  const p = gateProject();
  const computed = computeRubricFromTask(p.taskDir);
  const evidence = evidenceOf(computed);
  evidence.items = evidence.items.filter((item) => item.code !== 'paths_covered');
  write(p.taskDir, 'audit-evidence.json', evidence);
  const { tool, calls } = gateTool(p.root);
  await assert.rejects(
    () => tool.execute({ node: 'worker', prompt: 'сделай', task: GATE_TASK }, EXEC),
    (error) => {
      assert.equal(error.code, 'audit-required');
      assert.match(error.message, /неполная/u);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

await test('ворота: audit-evidence.json не разбирается — отказ', async () => {
  const p = gateProject({ evidence: 'broken' });
  const { tool } = gateTool(p.root);
  await assert.rejects(
    () => tool.execute({ node: 'worker', prompt: 'сделай', task: GATE_TASK }, EXEC),
    (error) => {
      assert.equal(error.code, 'audit-required');
      assert.match(error.message, /не разбирается как JSON/u);
      return true;
    },
  );
});

await test('ворота: риск low без evidence — прежнее поведение (активация)', async () => {
  const p = gateProject({ risk: 'low', evidence: 'absent' });
  const { tool, calls } = gateTool(p.root);
  const value = await tool.execute({ node: 'worker', prompt: 'сделай', task: GATE_TASK }, EXEC);
  assert.equal(value.kind, 'activation');
  assert.equal(calls.length, 1);
});

/* ------------------------------------------------------------------------- */

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const message = failure.error && failure.error.message ? failure.error.message : String(failure.error);
  console.error('  ' + String(message).split('\n').slice(0, 3).join('\n  '));
}
console.log('AUDIT-CHECK TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
