/**
 * 0202: пресеты узлов — схема, замок, гейт до активации.
 *
 * Тест берёт временный корень и настоящий граф из structure/graph.json: гейт
 * обязан работать на том, что прочитает spawn, а не на подставленном объекте.
 * Отрицательные проверки утверждают и код отказа, и calls=0 у startActivation:
 * отказ, после которого агент всё-таки поднялся, — не отказ.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime } from '../lib/api.js';
import { createRunTool, createSpawnTool } from '../lib/spawn.js';
import { hash, presetGate, readPresets, validatePreset } from '../lib/presets.js';

let passed = 0;
const failures = [];
const cleanupDirs = [];

async function test(name, body) {
  try {
    await body();
    passed += 1;
    console.log('ok ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.error('not ok ' + name);
    console.error(error && error.stack ? error.stack : error);
  }
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function makeProject(graph) {
  const dir = tempDir('dsh-presets-');
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  return dir;
}

function writePreset(root, id, data) {
  fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(path.join(root, 'presets', id + '.json'), text, 'utf8');
  return text;
}

function writeRawPreset(root, id, text) {
  fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'presets', id + '.json'), text, 'utf8');
  return text;
}

function writeLock(root, presets, version = 1) {
  fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
  const text = JSON.stringify({ version, presets }, null, 2);
  fs.writeFileSync(path.join(root, 'presets', 'lock.json'), text, 'utf8');
  return text;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function releasePreset() {
  return {
    node: 'release-1',
    version: 1,
    immutable: true,
    pipeline: 'tools/release.mjs',
    requires: {
      acceptance: 'строка accept в docs/tasks/<id>/gates.jsonl до bump',
      preflight: ['check-version', 'release-receipt --online'],
      evidence: ['tag', 'release URL', 'asset size', 'HTTP 200', 'SMOKE-<tag>.json'],
      guard: {
        enabled: true,
        scope: 'session',
        reason: 'коммит вне контракта задачи не должен проходить',
      },
    },
    deny: ['git push', 'git push --tags', 'gh release create', 'publish-public', 'npm publish'],
    secrets: 'не печатать; токен только из окружения/credential fill',
  };
}

function workerPreset() {
  return {
    node: 'worker',
    version: 1,
    immutable: true,
    pipeline: 'tools/worker.mjs',
    requires: {
      acceptance: 'отчёт исполнителя в docs/tasks/<id>/report.worker.json',
      preflight: ['check-worker'],
      evidence: ['report'],
      guard: { enabled: false, scope: 'task', reason: 'у исполнителя нет релизного гейта' },
    },
    deny: ['git push', 'publish-public'],
    secrets: 'не печатать; токен только из окружения',
  };
}

function graphWith(nodes) {
  return {
    version: 1,
    models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes,
    edges: [],
  };
}

function node(id, extra = {}) {
  return { id, role: 'исполнитель', model: 'ds', prompt: 'Роль: исполнитель.', ...extra };
}

function releaseNode(extra = {}) {
  return node('release-1', {
    role: 'выпускающий',
    prompt: 'Роль: выпускающий. Релиз после приёмки по пайплайну.',
    ...extra,
  });
}

function codeList(list) {
  return list.map((item) => item.code);
}

function hasCode(list, code) {
  return list.some((item) => item.code === code);
}

function makeRuntime(root) {
  const runsDir = tempDir('dsh-presets-runs-');
  return createGraphRuntime({ roots: [root], runsDir });
}

function makeSubagents() {
  const calls = [];
  return {
    calls,
    getProvider(name) {
      return { name, capabilities: { agentOptions: true } };
    },
    resolveMaxDepth(configured) {
      return configured === undefined ? 1 : configured;
    },
    async startActivation(spec) {
      calls.push(spec);
      return {
        childId: 'child-1',
        result: Promise.resolve({
          output: [{ type: 'text', text: 'ok' }],
          stopReason: 'end',
        }),
      };
    },
  };
}

function makeExec() {
  return { agent: { id: 'agent-parent' }, signal: { aborted: false } };
}

async function rejectsWith(promise, code) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'ожидался отказ ' + code);
  assert.equal(error.code, code, error.message);
}

/* ------------------------------------------------------------------------- *
 * c1: схема и замок.
 * ------------------------------------------------------------------------- */
async function c1() {
  await test('c1: валидный release-1 проходит схему, замок и гейт', () => {
    const graph = graphWith([releaseNode()]);
    const root = makeProject(graph);
    const presetText = writePreset(root, 'release-1', releasePreset());
    writeLock(root, { 'release-1': hash(presetText) });

    const loaded = readPresets(root);
    assert.equal(loaded.presets.length, 1);
    assert.equal(loaded.presets[0].id, 'release-1');
    assert.equal(loaded.presets[0].hash, hash(presetText));
    assert.equal(loaded.presets[0].pinned, hash(presetText));
    assert.equal(validatePreset(JSON.parse(presetText), 'release-1').ok, true);

    const gate = presetGate(graph, root, { argv: [] });
    assert.deepEqual(gate.errors, [], 'валидный пресет не должен давать ошибок');
    assert.deepEqual(gate.warnings, []);
  });

  await test('c1: битый хеш замка — preset-hash-mismatch', () => {
    const graph = graphWith([releaseNode()]);
    const root = makeProject(graph);
    writePreset(root, 'release-1', releasePreset());
    writeLock(root, { 'release-1': '0'.repeat(64) });

    const gate = presetGate(graph, root, { argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-hash-mismatch'), codeList(gate.errors).join(','));
  });

  await test('c1: хеш — по байтам файла, хвостовой перевод строки ломает замок', () => {
    const graph = graphWith([releaseNode()]);
    const root = makeProject(graph);
    const presetText = writePreset(root, 'release-1', releasePreset());
    writeLock(root, { 'release-1': hash(presetText) });
    fs.appendFileSync(path.join(root, 'presets', 'release-1.json'), '\n', 'utf8');

    const gate = presetGate(graph, root, { argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-hash-mismatch'), codeList(gate.errors).join(','));
  });

  await test('c1: лишнее поле пресета запрещено — preset-schema', () => {
    const graph = graphWith([releaseNode()]);
    const root = makeProject(graph);
    const preset = releasePreset();
    preset.extra = true;
    const presetText = writePreset(root, 'release-1', preset);
    writeLock(root, { 'release-1': hash(presetText) });

    const gate = presetGate(graph, root, { argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-schema'), codeList(gate.errors).join(','));
    assert.ok(gate.errors.some((item) => String(item.message).includes('extra')), 'поле extra названо');
  });

  await test('c1: неизвестное поле requires тоже ошибка схемы', () => {
    const preset = releasePreset();
    preset.requires.extra = 'лишнее';
    const checked = validatePreset(preset, 'release-1');
    assert.equal(checked.ok, false);
    assert.ok(checked.errors.some((item) => item.code === 'preset-schema' && item.field === 'requires'));
  });

  await test('c1: node пресета не совпал с узлом — preset-schema', () => {
    const preset = releasePreset();
    preset.node = 'other';
    const checked = validatePreset(preset, 'release-1');
    assert.equal(checked.ok, false);
    assert.ok(checked.errors.some((item) => item.code === 'preset-schema' && item.field === 'node'));
  });

  await test('c1: immutable:false — preset-not-immutable', () => {
    const preset = releasePreset();
    preset.immutable = false;
    const checked = validatePreset(preset, 'release-1');
    assert.equal(checked.ok, false);
    assert.ok(checked.errors.some((item) => item.code === 'preset-not-immutable'));
  });

  await test('c1: release-1 без предполёта/запретов — preset-release-requirements', () => {
    const preset = releasePreset();
    preset.requires.preflight = ['check-version'];
    preset.deny = ['npm publish'];
    const checked = validatePreset(preset, 'release-1');
    assert.equal(checked.ok, false);
    const codes = checked.errors.filter((item) => item.code === 'preset-release-requirements');
    assert.ok(codes.some((item) => /release-receipt --online/u.test(item.message)), 'назван release-receipt --online');
    assert.ok(codes.some((item) => /publish-public/u.test(item.message)), 'назван publish-public');
  });

  await test('c1: битый JSON — preset-broken, а не падение', () => {
    const graph = graphWith([releaseNode()]);
    const root = makeProject(graph);
    const text = writeRawPreset(root, 'release-1', '{');
    writeLock(root, { 'release-1': hash(text) });

    const gate = presetGate(graph, root, { argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-broken'), codeList(gate.errors).join(','));
  });

  await test('c1: нет хеша в замке — preset-unpinned', () => {
    const graph = graphWith([releaseNode()]);
    const root = makeProject(graph);
    writePreset(root, 'release-1', releasePreset());
    writeLock(root, {});

    const gate = presetGate(graph, root, { argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-unpinned'), codeList(gate.errors).join(','));
  });

  await test('c1: version замка не 1 — preset-lock', () => {
    const graph = graphWith([releaseNode()]);
    const root = makeProject(graph);
    const text = writePreset(root, 'release-1', releasePreset());
    writeLock(root, { 'release-1': hash(text) }, 2);

    const gate = presetGate(graph, root, { argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-lock'), codeList(gate.errors).join(','));
  });

  await test('c1: пресет есть, замка нет — preset-lock', () => {
    const graph = graphWith([releaseNode()]);
    const root = makeProject(graph);
    writePreset(root, 'release-1', releasePreset());

    const gate = presetGate(graph, root, { argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-lock'), codeList(gate.errors).join(','));
  });

  await test('c1: пресет без узла — preset-unknown', () => {
    const graph = graphWith([node('worker')]);
    const root = makeProject(graph);
    const text = writePreset(root, 'release-1', releasePreset());
    writeLock(root, { 'release-1': hash(text) });

    const gate = presetGate(graph, root, { argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-unknown'), codeList(gate.errors).join(','));
  });
}

/* ------------------------------------------------------------------------- *
 * c2: release-1 обязателен, другой узел — только warning, calls=0.
 * ------------------------------------------------------------------------- */
async function c2() {
  await test('c2: без target release-1 без пресета — error preset-required, другой узел — warning preset-missing', () => {
    const graph = graphWith([releaseNode(), node('worker')]);
    const root = makeProject(graph);

    const gate = presetGate(graph, root, { argv: [] });
    assert.deepEqual(codeList(gate.errors), ['preset-required']);
    assert.equal(gate.errors[0].node, 'release-1');
    assert.deepEqual(codeList(gate.warnings), ['preset-missing']);
    assert.equal(gate.warnings[0].node, 'worker');
  });

  await test('c2: target reviewer-1 проходит, ошибка release-1 уходит в warning preset-other-node', async () => {
    const graph = graphWith([releaseNode(), node('reviewer-1', { role: 'ревьюер', prompt: 'Роль: ревьюер.' })]);
    const root = makeProject(graph);

    const gate = presetGate(graph, root, { target: 'reviewer-1', argv: [] });
    assert.deepEqual(gate.errors, [], 'чужой preset-required не должен блокировать reviewer');
    assert.ok(gate.warnings.some((item) => item.code === 'preset-missing' && item.node === 'reviewer-1'));
    assert.ok(gate.warnings.some((item) => item.code === 'preset-other-node'
      && item.node === 'release-1' && item.originalCode === 'preset-required'));

    const subagents = makeSubagents();
    const tool = createSpawnTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => subagents,
    });
    const result = await tool.execute({ node: 'reviewer-1', prompt: 'проверь диф' }, makeExec());
    assert.equal(result.kind, 'activation');
    assert.equal(subagents.calls.length, 1, 'reviewer должен запускаться при warning у release-1');
  });

  await test('c2: target release-1 с publish-public в prompt — deny, target reviewer-1 — проходит', async () => {
    const graph = graphWith([
      releaseNode({ prompt: 'Роль: выпускающий. Выполни publish-public --build --push.' }),
      node('reviewer-1', { role: 'ревьюер', prompt: 'Роль: ревьюер.' }),
    ]);
    const root = makeProject(graph);
    const presetText = writePreset(root, 'release-1', releasePreset());
    writeLock(root, { 'release-1': hash(presetText) });

    const reviewerGate = presetGate(graph, root, { target: 'reviewer-1', argv: [] });
    assert.deepEqual(reviewerGate.errors, [], 'prompt release-1 не должен блокировать reviewer');
    assert.ok(reviewerGate.warnings.some((item) => item.code === 'preset-other-node'
      && item.node === 'release-1' && item.originalCode === 'preset-denied-command'));

    const releaseGate = presetGate(graph, root, { target: 'release-1', argv: [] });
    assert.ok(hasCode(releaseGate.errors, 'preset-denied-command'), codeList(releaseGate.errors).join(','));

    const reviewerSubagents = makeSubagents();
    const reviewerTool = createSpawnTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => reviewerSubagents,
    });
    const result = await reviewerTool.execute({ node: 'reviewer-1', prompt: 'проверь диф' }, makeExec());
    assert.equal(result.kind, 'activation');
    assert.equal(reviewerSubagents.calls.length, 1);

    const releaseSubagents = makeSubagents();
    const releaseTool = createSpawnTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => releaseSubagents,
    });
    await rejectsWith(releaseTool.execute({ node: 'release-1', prompt: 'подготовь релиз' }, makeExec()), 'preset-denied-command');
    assert.equal(releaseSubagents.calls.length, 0);
  });

  await test('c2: глобальная ошибка замка блокирует и target reviewer-1', async () => {
    const graph = graphWith([releaseNode(), node('reviewer-1', { role: 'ревьюер', prompt: 'Роль: ревьюер.' })]);
    const root = makeProject(graph);
    const presetText = writePreset(root, 'release-1', releasePreset());
    writeLock(root, { 'release-1': hash(presetText) }, 2);

    const gate = presetGate(graph, root, { target: 'reviewer-1', argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-lock'), codeList(gate.errors).join(','));

    const subagents = makeSubagents();
    const tool = createSpawnTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => subagents,
    });
    await rejectsWith(tool.execute({ node: 'reviewer-1', prompt: 'проверь диф' }, makeExec()), 'preset-lock');
    assert.equal(subagents.calls.length, 0);
  });

  await test('c2: глобальный argv-запрет блокирует и target reviewer-1', async () => {
    const graph = graphWith([releaseNode(), node('reviewer-1', { role: 'ревьюер', prompt: 'Роль: ревьюер.' })]);
    const root = makeProject(graph);
    const presetText = writePreset(root, 'release-1', releasePreset());
    writeLock(root, { 'release-1': hash(presetText) });

    const subagents = makeSubagents();
    const tool = createSpawnTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => subagents,
    });
    await rejectsWith(tool.execute({ node: 'reviewer-1', prompt: 'сделай git push --tags' }, makeExec()), 'preset-denied-command');
    assert.equal(subagents.calls.length, 0);
  });

  await test('c2: spawn release-1 без пресета отказывает до startActivation (calls=0)', async () => {
    const graph = graphWith([releaseNode(), node('worker')]);
    const root = makeProject(graph);
    const subagents = makeSubagents();
    const tool = createSpawnTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => subagents,
    });

    await rejectsWith(tool.execute({ node: 'release-1', prompt: 'подготовь релиз' }, makeExec()), 'preset-required');
    assert.equal(subagents.calls.length, 0, 'startActivation не должен вызываться');
  });

  await test('c2: run release-1 без пресета тоже отказывает до startActivation', async () => {
    const graph = graphWith([releaseNode()]);
    const root = makeProject(graph);
    const subagents = makeSubagents();
    const tool = createRunTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => subagents,
    });

    await rejectsWith(tool.execute({ node: 'release-1', prompt: 'подготовь релиз' }, makeExec()), 'preset-required');
    assert.equal(subagents.calls.length, 0);
  });

  await test('c2: warning preset-missing не блокирует запуск другого узла', async () => {
    const graph = graphWith([node('worker')]);
    const root = makeProject(graph);
    const subagents = makeSubagents();
    const tool = createSpawnTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => subagents,
    });

    const result = await tool.execute({ node: 'worker', prompt: 'обычная задача' }, makeExec());
    assert.equal(result.kind, 'activation');
    assert.equal(subagents.calls.length, 1, 'warning не должен отменять активацию');
  });
}

/* ------------------------------------------------------------------------- *
 * c3: deny в node.prompt и argv — preset-denied-command без активации.
 * ------------------------------------------------------------------------- */
async function c3() {
  await test('c3: запрещённая команда в node.prompt — preset-denied-command, spawn отказывает', async () => {
    const graph = graphWith([node('worker', { prompt: 'Роль: исполнитель. Сделай git push origin main и отчитайся.' })]);
    const root = makeProject(graph);
    const presetText = writePreset(root, 'worker', workerPreset());
    writeLock(root, { worker: hash(presetText) });

    const gate = presetGate(graph, root, { argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-denied-command'), codeList(gate.errors).join(','));

    const subagents = makeSubagents();
    const tool = createSpawnTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => subagents,
    });
    await rejectsWith(tool.execute({ node: 'worker', prompt: 'задача' }, makeExec()), 'preset-denied-command');
    assert.equal(subagents.calls.length, 0);
  });

  await test('c3: запрещённая команда в argv вызова — preset-denied-command, spawn отказывает', async () => {
    const graph = graphWith([node('worker')]);
    const root = makeProject(graph);
    const presetText = writePreset(root, 'worker', workerPreset());
    writeLock(root, { worker: hash(presetText) });

    const direct = presetGate(graph, root, { argv: ['node', 'tools/worker.mjs', 'git', 'push', '--tags'] });
    assert.ok(hasCode(direct.errors, 'preset-denied-command'), codeList(direct.errors).join(','));

    const subagents = makeSubagents();
    const tool = createSpawnTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => subagents,
    });
    await rejectsWith(
      tool.execute({ node: 'worker', prompt: 'сделай git push --tags' }, makeExec()),
      'preset-denied-command',
    );
    assert.equal(subagents.calls.length, 0);
  });

  await test('c3: путь перед запрещённой командой — не обход', () => {
    const graph = graphWith([node('worker', { prompt: 'Роль: исполнитель. Запусти ./publish-public --build.' })]);
    const root = makeProject(graph);
    const presetText = writePreset(root, 'worker', workerPreset());
    writeLock(root, { worker: hash(presetText) });

    const gate = presetGate(graph, root, { argv: [] });
    assert.ok(hasCode(gate.errors, 'preset-denied-command'), codeList(gate.errors).join(','));
  });

  await test('c3: чистая команда не блокируется, токены не путаются с подстрокой', async () => {
    const graph = graphWith([node('worker', { prompt: 'Роль: исполнитель. Проверь git-push-политику и publish-publication.' })]);
    const root = makeProject(graph);
    const preset = workerPreset();
    preset.deny = ['git push', '-f'];
    const presetText = writePreset(root, 'worker', preset);
    writeLock(root, { worker: hash(presetText) });

    /* git-push — другой токен, --ff-only — не -f. */
    const ffOnly = presetGate(graph, root, { argv: ['git', 'commit', '--ff-only'] });
    assert.equal(hasCode(ffOnly.errors, 'preset-denied-command'), false, codeList(ffOnly.errors).join(','));
    assert.equal(hasCode(ffOnly.errors, 'preset-hash-mismatch'), false, codeList(ffOnly.errors).join(','));

    /* Настоящая команда в argv ловится. */
    const force = presetGate(graph, root, { argv: ['git', 'commit', '-f'] });
    assert.ok(hasCode(force.errors, 'preset-denied-command'), codeList(force.errors).join(','));

    /* И чистый запуск проходит. */
    const subagents = makeSubagents();
    const tool = createSpawnTool({
      runtime: makeRuntime(root),
      config: {},
      getSubagents: () => subagents,
    });
    const result = await tool.execute({ node: 'worker', prompt: 'проверь политику' }, makeExec());
    assert.equal(result.kind, 'activation');
    assert.equal(subagents.calls.length, 1);
  });
}

const suites = { c1: [c1], c2: [c2], c3: [c3] };
const order = ['c1', 'c2', 'c3'];
const arg = String(process.argv[2] || '').toLowerCase();
if (arg && !suites[arg]) {
  console.log('usage: node test/presets.test.mjs c1|c2|c3');
  process.exitCode = 2;
} else {
  const selected = arg ? [arg] : order;
  for (const name of selected) {
    for (const suite of suites[name]) await suite();
  }
  for (const dir of cleanupDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* уборка не повод падать */ }
  }
  const label = arg || 'all';
  if (failures.length > 0) {
    console.error('PRESETS ' + label + ' FAILED: ' + failures.length + ' из ' + (passed + failures.length));
    process.exitCode = 1;
  } else {
    console.log('PRESETS ' + label + ' OK: ' + passed + '/' + passed);
  }
}
