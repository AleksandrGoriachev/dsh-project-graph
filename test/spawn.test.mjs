/**
 * MVP-1: the spawn tool, exercised without DSH.
 *
 * The tool is a definition over a mock tools registry and a mock subagent
 * service; the structure comes from a real temporary folder, because reading
 * and validating it is part of the contract. Every refusal asserts its stable
 * code, and no refusal may reach startActivation().
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime } from '../lib/api.js';
import { apply } from '../lib/index.js';
import {
  createRunTool,
  createSpawnTool,
  registerSpawnTool,
  resolveNodePlan,
  resolveRoot,
  queueFilePath,
  spawnError,
  RUN_TOOL_NAME,
  SPAWN_TOOL_NAME,
} from '../lib/spawn.js';
import { launchFilePath, listRuns } from '../lib/runs.js';
import { BRANCH_TOOL_NAME } from '../lib/branch.js';

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

/*
 * 0161/0163: фикстура обязана быть исправной по инвариантам валидатора
 * структуры — иначе гейт запуска (lib/index.js передаёт validateStructure)
 * отказывает тестам, которые проверяют проводку cwd/createAgent, а не граф.
 * Поэтому здесь есть координатор, у каждого узла ровно одна связь
 * review/report, а цепочка ациклична. Идентификаторы и модели прежние:
 * тесты спавна называют именно их.
 */
const GRAPH = {
  version: 1,
  models: {
    ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' },
    glm: { provider: 'opencode', model: 'glm-5.3-flash', family: 'zhipu' },
  },
  nodes: [
    { id: 'coordinator', role: 'координатор', model: 'ds' },
    { id: 'lead', role: 'lead', model: 'ds' },
    { id: 'critic', role: 'acceptor', model: 'glm' },
    { id: 'idea', role: 'analyst' },
  ],
  edges: [
    { from: 'coordinator', to: 'lead', kind: 'delegate' },
    { from: 'lead', to: 'critic', kind: 'review' },
    { from: 'critic', to: 'coordinator', kind: 'report' },
    { from: 'idea', to: 'coordinator', kind: 'report' },
  ],
};

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'structure', name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return dir;
}

function makeSubagents(overrides = {}) {
  const calls = [];
  const subagents = {
    calls,
    getProvider(name) {
      if (overrides.provider === null) return undefined;
      return overrides.provider || { name, capabilities: { agentOptions: true } };
    },
    resolveMaxDepth(configured) {
      return configured === undefined ? 1 : configured;
    },
    async startActivation(spec) {
      calls.push(spec);
      return { childId: 'child-1' };
    },
  };
  if (overrides.noStart) delete subagents.startActivation;
  return subagents;
}

function makeExec() {
  const parent = { id: 'agent-parent' };
  return { agent: parent, signal: { aborted: false } };
}

/** Строки launches.jsonl одного корня: одна строка — один переход (0101). */
function readLaunches(runsDir, root) {
  const file = launchFilePath({ runsDir }, root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** Каталог запусков одного корня: 12 hex sha256 абсолютного пути (0101). */
function launchFolderName(root) {
  return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
}

const project = makeProject({ 'graph.json': GRAPH });
const broken = makeProject({ 'graph.json': '{' });
const presetProject = makeProject({
  'graph.json': {
    version: 1,
    models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [
      { id: 'lead', role: 'lead', model: 'ds', agentPreset: 'standard' },
      { id: 'ghost-preset', role: 'lead', model: 'ds', agentPreset: 'missing' },
    ],
    edges: [{ from: 'lead', to: 'ghost-preset', kind: 'peer' }],
  },
});

function makePresets(ids = ['standard', 'ptc']) {
  return {
    async resolve(id) {
      if (!ids.includes(id)) {
        const error = new Error('Unknown agent preset: ' + id);
        error.code = 'agent-preset/not-found';
        throw error;
      }
      return { id };
    },
    async list() {
      return ids.map((id) => ({ id }));
    },
  };
}

await test('resolveNodePlan: узел -> алиас -> provider/model и роль', () => {
  const plan = resolveNodePlan(GRAPH, 'critic');
  assert.equal(plan.ok, true);
  assert.equal(plan.node, 'critic');
  assert.equal(plan.role, 'acceptor');
  assert.equal(plan.provider, 'opencode');
  assert.equal(plan.model, 'glm-5.3-flash');
});

await test('resolveNodePlan: неизвестный узел — unknown-node', () => {
  const plan = resolveNodePlan(GRAPH, 'ghost');
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'unknown-node');
});

await test('resolveNodePlan: узел без модели — node-without-model', () => {
  const plan = resolveNodePlan(GRAPH, 'idea');
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'node-without-model');
});

await test('resolveNodePlan: прямой маршрут узла работает без алиасов', () => {
  const graph = {
    version: 1,
    models: {},
    nodes: [{ id: 'judge', role: 'acceptor', provider: 'p2', model: 'm2', family: 'f2' }],
    edges: [],
  };
  const plan = resolveNodePlan(graph, 'judge');
  assert.equal(plan.ok, true);
  assert.equal(plan.provider, 'p2');
  assert.equal(plan.model, 'm2');
  assert.equal(plan.family, 'f2');
  assert.equal(plan.modelAlias, null, 'у прямого маршрута нет алиаса');
});

await test('resolveNodePlan: мигрированный узел отдаёт прямые поля и modelAlias', () => {
  const graph = {
    version: 1,
    models: { 'рабочая': { provider: 'p1', model: 'm1' } },
    nodes: [{ id: 'work', role: 'исполнитель', provider: 'p1', model: 'm1', modelAlias: 'рабочая' }],
    edges: [],
  };
  const plan = resolveNodePlan(graph, 'work');
  assert.equal(plan.ok, true);
  assert.equal(plan.provider, 'p1');
  assert.equal(plan.model, 'm1');
  assert.equal(plan.modelAlias, 'рабочая', 'имя алиаса остаётся для панели');
});

await test('resolveNodePlan с каталогом: неизвестный провайдер — provider-missing с именами', () => {
  const graph = {
    version: 1,
    models: {},
    nodes: [{ id: 'critic', role: 'acceptor', provider: 'opencode', model: 'glm-5.3-flash' }],
    edges: [],
  };
  const catalog = {
    providers: [
      { id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] },
      { id: 'opencode-go', models: [{ id: 'deepseek-v4.1-flash' }] },
    ],
  };
  const plan = resolveNodePlan(graph, 'critic', { catalog });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'provider-missing');
  assert.match(plan.message, /opencode/u, 'в отказе есть имя провайдера');
  assert.match(plan.message, /opencode-go/u, 'в отказе есть список каталога');
});

await test('resolveNodePlan с каталогом: неизвестная модель — model-missing с именем', () => {
  const graph = {
    version: 1,
    models: {},
    nodes: [{ id: 'critic', role: 'acceptor', provider: 'opencode-go', model: 'нет-такой' }],
    edges: [],
  };
  const catalog = { providers: [{ id: 'opencode-go', models: [{ id: 'deepseek-v4.1-flash' }] }] };
  const plan = resolveNodePlan(graph, 'critic', { catalog });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'model-missing');
  assert.match(plan.message, /нет-такой/u, 'в отказе есть имя модели');
  assert.match(plan.message, /deepseek-v4\.1-flash/u, 'в отказе есть доступные модели');
});

await test('resolveNodePlan с каталогом: известный маршрут проходит проверку', () => {
  const graph = {
    version: 1,
    models: {},
    nodes: [{ id: 'critic', role: 'acceptor', provider: 'opencode-go', model: 'deepseek-v4.1-flash' }],
    edges: [],
  };
  const catalog = {
    providers: [{ id: 'opencode-go', models: [{ id: 'deepseek-v4.1-flash', family: 'deepseek' }] }],
  };
  const plan = resolveNodePlan(graph, 'critic', { catalog });
  assert.equal(plan.ok, true);
  assert.equal(plan.provider, 'opencode-go');
  assert.equal(plan.model, 'deepseek-v4.1-flash');
  assert.equal(plan.family, 'deepseek', 'семейство из каталога дополняет маршрут');
});

await test('resolveNodePlan без каталога: маршрут не проверяется, как раньше', () => {
  const graph = {
    version: 1,
    models: {},
    nodes: [{ id: 'critic', role: 'acceptor', provider: 'nowhere', model: 'nothing' }],
    edges: [],
  };
  const plan = resolveNodePlan(graph, 'critic');
  assert.equal(plan.ok, true, 'без каталога доказывать нечего — план строится по объявлению');
  assert.equal(plan.provider, 'nowhere');
});

/** Узел с прямым маршрутом: provider+model в объявлении, без models{}. */
function directGraph(provider, model = 'deepseek-v4.1-flash') {
  return {
    version: 1,
    models: {},
    nodes: [{ id: 'coordinator', role: 'координатор', provider, model }],
    edges: [],
  };
}

await test('resolveNodePlan без каталога: провайдер вне knownProviders — provider-missing с перечнем и подсказкой', () => {
  const plan = resolveNodePlan(directGraph('opencode'), 'coordinator', {
    knownProviders: ['opencode-go', 'deepseek-official'],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'provider-missing');
  assert.match(plan.message, /opencode-go/u, 'в отказе есть доступные провайдеры');
  assert.match(plan.message, /deepseek-official/u, 'перечень полный, а не первый');
  assert.match(plan.message, /имелся в виду «opencode-go»/u, 'подсказка ближайшего по имени');
});

await test('resolveNodePlan без каталога: провайдер из knownProviders проходит', () => {
  const plan = resolveNodePlan(directGraph('opencode-go'), 'coordinator', { knownProviders: ['opencode-go'] });
  assert.equal(plan.ok, true);
  assert.equal(plan.provider, 'opencode-go');
});

await test('resolveNodePlan без каталога: пустой или отсутствующий knownProviders — прежнее поведение', () => {
  for (const options of [{}, { knownProviders: undefined }, { knownProviders: [] }, { knownProviders: null }]) {
    const plan = resolveNodePlan(directGraph('opencode'), 'coordinator', options);
    assert.equal(plan.ok, true, 'список не передан — доказывать нечего');
    assert.equal(plan.provider, 'opencode');
  }
});

await test('resolveNodePlan: каталог главнее knownProviders', () => {
  const catalog = { providers: [{ id: 'opencode', models: [{ id: 'deepseek-v4.1-flash' }] }] };
  const plan = resolveNodePlan(directGraph('opencode'), 'coordinator', {
    catalog,
    knownProviders: ['opencode-go'],
  });
  assert.equal(plan.ok, true, 'каталог прочитан — список рантайма его не перебивает');
  assert.equal(plan.provider, 'opencode');
});

await test('resolveNodePlan без каталога: далёкое имя не даёт ложной подсказки', () => {
  const plan = resolveNodePlan(directGraph('zzz'), 'coordinator', { knownProviders: ['opencode-go'] });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'provider-missing');
  assert.match(plan.message, /opencode-go/u, 'перечень всё равно назван');
  assert.doesNotMatch(plan.message, /имелся в виду/u, 'похожего имени нет — подсказки нет');
});

await test('resolveRoot: единственный корень выбирается без аргумента', () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const selection = resolveRoot(runtime, '');
  assert.equal(selection.ok, true);
  assert.equal(selection.root, project);
});

await test('resolveRoot: несколько корней требуют явного root', () => {
  const runtime = createGraphRuntime({ roots: [project, broken] });
  const selection = resolveRoot(runtime, '');
  assert.equal(selection.ok, false);
  assert.equal(selection.code, 'root-required');
});

await test('resolveRoot: чужой корень — root-not-allowed', () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const selection = resolveRoot(runtime, path.join(os.tmpdir(), 'elsewhere'));
  assert.equal(selection.ok, false);
  assert.equal(selection.code, 'root-not-allowed');
});

await test('run: ждёт результат и пишет состояние done', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const calls = [];
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } }),
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      calls.push(spec);
      return {
        childId: 'run-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'готово' }], stopReason: 'stop' }),
        dispose: async () => {},
      };
    },
  };
  const tool = createRunTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  assert.equal(value.status, 'ok');
  assert.equal(value.output, 'готово');
  assert.equal(value.childId, 'run-1');
  assert.equal(calls[0].delivery, 'caller');
  assert.equal(listRuns(runtime, project)[0].state, 'done');
});

await test('run: ребёнок работает в каталоге своего воркспейса, а не вызывающей сессии', async () => {
  /* Two workspaces: the node is declared in the second, the test process runs in the first. */
  const own = makeProject({ 'graph.json': GRAPH });
  const other = makeProject({ 'graph.json': GRAPH });
  const runtime = createGraphRuntime({ roots: [own, other] });
  const calls = [];
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } }),
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      calls.push(spec);
      return {
        childId: 'run-x',
        result: Promise.resolve({ output: [{ type: 'text', text: 'готово' }], stopReason: 'stop' }),
        dispose: async () => {},
      };
    },
  };
  const tool = createRunTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь', root: other }, makeExec());
  assert.equal(value.status, 'ok');
  assert.equal(calls[0].request.cwd, path.resolve(other), 'cwd ребёнка — корень объявления, а не cwd сессии');
});

await test('run: контракт задания, противоречащий структуре, не запускается', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  fs.mkdirSync(path.join(fresh, 'docs', 'tasks', '0001'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'docs', 'tasks', '0001', 'task.md'),
    '<!-- TASK-META\n' + JSON.stringify({ executor: 'subagent:critic', acceptor: 'subagent:lead' }) + '\n-->\n');
  const runtime = createGraphRuntime({ roots: [fresh] });
  const subagents = makeSubagents();
  const tool = createRunTool({ runtime, config: {}, getSubagents: () => subagents });
  await assert.rejects(
    () => tool.execute({ node: 'critic', prompt: 'проверь', task: 'docs/tasks/0001' }, makeExec()),
    (error) => {
      assert.equal(error.code, 'task-contradicts-structure', 'иначе структуру можно обойти контрактом');
      assert.match(error.message, /acceptor/);
      return true;
    },
  );
  assert.equal(subagents.calls.length, 0, 'до запуска агента дело дойти не должно');
});

await test('run: ошибка ребёнка становится status error', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() {
      return {
        childId: 'run-2',
        result: Promise.resolve({ output: [{ type: 'text', text: 'сломалось' }], stopReason: 'error' }),
        dispose: async () => {},
      };
    },
  };
  const tool = createRunTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'lead', prompt: 'сделай' }, makeExec());
  assert.equal(value.status, 'error');
  assert.equal(value.error, 'сломалось');
  assert.equal(listRuns(runtime, project)[0].state, 'error');
});

await test('spawn: запуск виден в activity как running, затем done', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  let settle;
  const result = new Promise((resolve) => { settle = resolve; });
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() {
      return { childId: 'spawn-1', result, dispose: async () => {} };
    },
  };
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  assert.equal(value.kind, 'activation');
  const running = listRuns(runtime, project)[0];
  assert.equal(running.state, 'running');
  assert.equal(running.node, 'critic');
  assert.equal(running.childId, 'spawn-1');
  settle({ output: [{ type: 'text', text: 'сделано' }], stopReason: 'stop' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const done = listRuns(runtime, project)[0];
  assert.equal(done.state, 'done');
  assert.equal(done.childId, 'spawn-1');
  assert.equal(done.since, running.since, 'срок запуска не должен съезжать на момент завершения');
});

await test('spawn: отказ ребёнка после возврата управления пишется как error', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  let reject;
  const result = new Promise((_resolve, fail) => { reject = fail; });
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() {
      return { childId: 'spawn-2', result, dispose: async () => {} };
    },
  };
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await tool.execute({ node: 'lead', prompt: 'сделай' }, makeExec());
  reject(new Error('сломалось'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failed = listRuns(runtime, project)[0];
  assert.equal(failed.state, 'error');
  assert.equal(failed.message, 'сломалось');
});

await test('spawn: отказ запуска пишется как error и не остаётся running', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() {
      throw new Error('активация не удалась');
    },
  };
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await assert.rejects(tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec()));
  const failed = listRuns(runtime, project)[0];
  assert.equal(failed.state, 'error');
  assert.equal(failed.message, 'активация не удалась');
});

await test('launches: started несёт runId/childId/provider/model/depth, task=null (0101)', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-launch-'));
  const runtime = createGraphRuntime({ roots: [project], runsDir });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  const rows = readLaunches(runsDir, project);
  assert.equal(rows.length, 1, 'один запуск — одна started-запись');
  const row = rows[0];
  assert.equal(row.v, 1);
  assert.equal(row.state, 'started');
  assert.equal(row.node, 'critic');
  assert.equal(row.childId, 'child-1');
  assert.equal(row.provider, 'opencode');
  assert.equal(row.model, 'glm-5.3-flash');
  assert.equal(row.depth, 1);
  assert.equal(row.task, null, 'без задания task=null');
  assert.equal(row.root, path.resolve(project));
  assert.match(row.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/u);
  /* Путь: <runsDir>/<12-hex sha256 абсолютного корня>/launches.jsonl. */
  const file = launchFilePath({ runsDir }, project);
  assert.equal(path.basename(file), 'launches.jsonl');
  assert.equal(path.basename(path.dirname(file)), launchFolderName(project));
  assert.equal(fs.existsSync(path.join(runsDir, 'runs.json')), false, 'launches — в подкаталоге, не в корне стора');
});

await test('launches: settled ok=true с тем же runId после завершения (0101)', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-launch-'));
  const runtime = createGraphRuntime({ roots: [project], runsDir });
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() {
      return {
        childId: 'child-settled',
        result: Promise.resolve({ output: [{ type: 'text', text: 'готово' }], stopReason: 'stop' }),
        dispose: async () => {},
      };
    },
  };
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  assert.equal(value.kind, 'activation');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const rows = readLaunches(runsDir, project);
  const started = rows.find((row) => row.state === 'started');
  const settled = rows.find((row) => row.state === 'settled');
  assert.ok(started, 'started есть');
  assert.ok(settled, 'settled есть после завершения');
  assert.equal(settled.runId, started.runId, 'тот же runId связывает переходы');
  assert.equal(settled.ok, true);
  assert.equal(settled.v, 1);
  assert.match(settled.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u);
});

await test('launches: runId из started уходит ребёнку в prompt (0101)', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-launch-'));
  const runtime = createGraphRuntime({ roots: [project], runsDir });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  const started = readLaunches(runsDir, project).find((row) => row.state === 'started');
  const prompt = subagents.calls[0].request.prompt;
  assert.equal(prompt.length, 2, 'отдельный блок runId');
  assert.match(prompt[0].text, /проверь/u, 'промпт вызывающего остаётся в первом блоке');
  assert.equal(prompt[1].text, 'runId: ' + started.runId);
  assert.match(prompt[1].text, /^runId: /u);
});

await test('launches: задание из аргумента попадает в started.task (0101)', async () => {
  const fresh = makeProject({ 'graph.json': GRAPH });
  fs.mkdirSync(path.join(fresh, 'docs', 'tasks', '0001'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'docs', 'tasks', '0001', 'task.md'),
    '<!-- TASK-META\n' + JSON.stringify({ executor: 'subagent:lead', acceptor: 'subagent:critic' }) + '\n-->\n');
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-launch-'));
  const runtime = createGraphRuntime({ roots: [fresh], runsDir });
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => makeSubagents() });
  await tool.execute({ node: 'lead', prompt: 'сделай', task: 'docs/tasks/0001/task.md' }, makeExec());
  const row = readLaunches(runsDir, fresh).find((item) => item.state === 'started');
  assert.equal(row.task, 'docs/tasks/0001/task.md');
  assert.equal(row.node, 'lead');
});

await test('launches: сбой старта — started с пустым childId и settled ok=false (0101)', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-launch-'));
  const runtime = createGraphRuntime({ roots: [project], runsDir });
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() {
      throw new Error('активация не удалась');
    },
  };
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await assert.rejects(() => tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec()));
  const rows = readLaunches(runsDir, project);
  const started = rows.find((row) => row.state === 'started');
  const settled = rows.find((row) => row.state === 'settled');
  assert.ok(started, 'started пишется и при отказе старта');
  assert.equal(started.childId, '', 'childId неизвестен — пустой');
  assert.ok(settled, 'settled фиксирует отказ');
  assert.equal(settled.runId, started.runId);
  assert.equal(settled.ok, false);
  assert.equal(settled.errorCode, 'activation-error');
});

await test('launches: project_graph_run пишет started и settled в одном вызове (0101)', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-launch-'));
  const runtime = createGraphRuntime({ roots: [project], runsDir });
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() {
      return { childId: 'run-child', result: Promise.resolve({ output: [], stopReason: 'stop' }), dispose: async () => {} };
    },
  };
  const tool = createRunTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  assert.equal(value.status, 'ok');
  const rows = readLaunches(runsDir, project);
  const started = rows.find((row) => row.state === 'started');
  const settled = rows.find((row) => row.state === 'settled');
  assert.ok(started && settled, 'оба перехода записаны до возврата');
  assert.equal(started.childId, 'run-child');
  assert.equal(settled.runId, started.runId);
  assert.equal(settled.ok, true);
});

await test('launches: plan не пишет свидетельства запуска (0101)', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-launch-'));
  const runtime = createGraphRuntime({ roots: [project], runsDir });
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => makeSubagents() });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь', plan: true }, makeExec());
  assert.equal(value.kind, 'plan');
  assert.deepEqual(readLaunches(runsDir, project), [], 'план — не запуск');
});

await test('launches: сбой записи свидетельства не отменяет запуск (0101)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-launch-blocked-'));
  const blocked = path.join(dir, 'runs-is-a-file');
  fs.writeFileSync(blocked, 'not a directory');
  const runtime = createGraphRuntime({ roots: [project], runsDir: blocked });
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => makeSubagents() });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  assert.equal(value.kind, 'activation', 'свидетельство — наблюдение, а не условие запуска');
});

await test('plan: маршрут возвращается, агент не порождается', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь', plan: true }, makeExec());
  assert.deepEqual(value, {
    kind: 'plan',
    node: 'critic',
    role: 'acceptor',
    provider: 'opencode',
    model: 'glm-5.3-flash',
  });
  assert.equal(subagents.calls.length, 0);
});

await test('preset: узел с agentPreset отдаёт его в plan и в запрос', async () => {
  const runtime = createGraphRuntime({ roots: [presetProject] });
  const subagents = makeSubagents({ provider: { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } } });
  const presets = makePresets();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents, getAgentPresets: () => presets });
  const plan = await tool.execute({ node: 'lead', prompt: 'x', plan: true }, makeExec());
  assert.equal(plan.kind, 'plan');
  assert.equal(plan.preset, 'standard');
  assert.equal(subagents.calls.length, 0);
  await tool.execute({ node: 'lead', prompt: 'x' }, makeExec());
  assert.equal(subagents.calls[0].request.agentPreset, 'standard');
});

await test('preset: неизвестный пресет — unknown-preset, без порождения', async () => {
  const runtime = createGraphRuntime({ roots: [presetProject] });
  const subagents = makeSubagents({ provider: { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } } });
  const presets = makePresets(['standard']);
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents, getAgentPresets: () => presets });
  await assert.rejects(
    tool.execute({ node: 'ghost-preset', prompt: 'x' }, makeExec()),
    (error) => error.code === 'unknown-preset' && /standard/.test(error.message),
  );
  assert.equal(subagents.calls.length, 0);
});

await test('preset: служба agentPresets недоступна — preset-unavailable', async () => {
  const runtime = createGraphRuntime({ roots: [presetProject] });
  const subagents = makeSubagents({ provider: { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } } });
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await assert.rejects(
    tool.execute({ node: 'lead', prompt: 'x' }, makeExec()),
    (error) => error.code === 'preset-unavailable',
  );
  assert.equal(subagents.calls.length, 0);
});

await test('preset: провайдер без agentPreset — spawn-unavailable', async () => {
  const runtime = createGraphRuntime({ roots: [presetProject] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents, getAgentPresets: () => makePresets() });
  await assert.rejects(
    tool.execute({ node: 'lead', prompt: 'x' }, makeExec()),
    (error) => error.code === 'spawn-unavailable' && /agentPreset/.test(error.message),
  );
  assert.equal(subagents.calls.length, 0);
});

await test('spawn: без maxDepth в конфиге уходит дефолт 3, а не хозяйский 1', async () => {
  /* Свой корень: прогон этого теста остаётся running и не должен запирать соседей. */
  const runtime = createGraphRuntime({ roots: [makeProject({ 'graph.json': GRAPH })] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  assert.equal(subagents.calls[0].request.maxDepth, 3, 'хозяйский потолок 1 не должен отменять структуру');
});

await test('spawn: модель узла уходит в agentOptions, роль — в label', async () => {
  const runtime = createGraphRuntime({ roots: [makeProject({ 'graph.json': GRAPH })] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  const exec = makeExec();
  const value = await tool.execute({ node: 'critic', prompt: 'проверь работу' }, exec);
  assert.equal(value.kind, 'activation');
  assert.equal(value.childId, 'child-1');
  assert.equal(subagents.calls.length, 1);
  const spec = subagents.calls[0];
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.delivery, 'parent');
  assert.equal(spec.label, 'acceptor:critic');
  assert.equal(spec.signal, exec.signal);
  assert.equal(spec.request.parent, exec.agent);
  assert.deepEqual(spec.request.agentOptions, { provider: 'opencode', model: 'glm-5.3-flash' });
  assert.equal('agentPreset' in spec.request, false);
  /* Без явного maxDepth пакет несёт свой дефолт 3: структуре нужна глубина 2. */
  assert.equal(spec.request.maxDepth, 3);
  /* 0137: блок идентичности узла идёт первым — без него ребёнок не знает роли. */
  assert.deepEqual(spec.request.prompt[0], {
    type: 'text',
    text: 'Ты — узел critic, роль acceptor.\n\nпроверь работу',
  });
  /* 0101: runId — отдельным блоком, чтобы ребёнок знал свой запуск. */
  assert.equal(spec.request.prompt.length, 2);
  assert.match(spec.request.prompt[1].text, /^runId: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
});

await test('spawn: узел без роли не оставляет двоеточия в label', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  const graph = makeProject({
    'graph.json': { version: 1, models: { ds: { provider: 'p', model: 'm' } }, nodes: [{ id: 'solo', model: 'ds' }] },
  });
  const runtime2 = createGraphRuntime({ roots: [graph] });
  const tool2 = createSpawnTool({ runtime: runtime2, config: {}, getSubagents: () => subagents });
  assert.equal(tool.name, SPAWN_TOOL_NAME);
  await tool2.execute({ node: 'solo', prompt: 'x' }, makeExec());
  assert.equal(subagents.calls[0].label, 'solo');
});

await test('spawn: недействительная структура — structure-invalid, без порождения', async () => {
  const runtime = createGraphRuntime({ roots: [broken] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await assert.rejects(
    tool.execute({ node: 'critic', prompt: 'x' }, makeExec()),
    (error) => error.code === 'structure-invalid',
  );
  assert.equal(subagents.calls.length, 0);
});

await test('spawn: неизвестный узел — unknown-node, без порождения', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await assert.rejects(
    tool.execute({ node: 'ghost', prompt: 'x' }, makeExec()),
    (error) => error.code === 'unknown-node',
  );
  assert.equal(subagents.calls.length, 0);
});

await test('spawn: узел без модели — node-without-model, без порождения', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await assert.rejects(
    tool.execute({ node: 'idea', prompt: 'x' }, makeExec()),
    (error) => error.code === 'node-without-model',
  );
  assert.equal(subagents.calls.length, 0);
});

await test('spawn: каталог службы llm проверяется до запуска агента', async () => {
  const direct = { version: 1, models: {}, nodes: [{ id: 'critic', role: 'acceptor', provider: 'opencode-go', model: 'нет-такой' }], edges: [] };
  const own = makeProject({ 'graph.json': direct });
  const runtime = createGraphRuntime({ roots: [own] }, {
    getLlm: () => ({
      listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }],
      listModels: async () => [{ id: 'deepseek-v4.1-flash' }],
    }),
  });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await assert.rejects(
    tool.execute({ node: 'critic', prompt: 'x' }, makeExec()),
    (error) => error.code === 'model-missing' && /нет-такой/.test(error.message),
  );
  assert.equal(subagents.calls.length, 0, 'неизвестная модель не должна доходить до запуска');
});

await test('spawn: провайдер вне knownProviders — provider-missing до запуска', async () => {
  const own = makeProject({ 'graph.json': directGraph('opencode') });
  const runtime = createGraphRuntime({ roots: [own] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => subagents,
    getKnownProviders: async () => ['opencode-go'],
  });
  await assert.rejects(
    tool.execute({ node: 'coordinator', prompt: 'x' }, makeExec()),
    (error) => error.code === 'provider-missing'
      && /opencode-go/.test(error.message)
      && /имелся в виду/.test(error.message),
  );
  assert.equal(subagents.calls.length, 0, 'провайдер без адаптера не доходит до запуска');
});

await test('spawn: провайдер из getKnownProviders запускается', async () => {
  const own = makeProject({ 'graph.json': directGraph('opencode-go') });
  const runtime = createGraphRuntime({ roots: [own] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => subagents,
    getKnownProviders: () => ['opencode-go', 'deepseek-official'],
  });
  const result = await tool.execute({ node: 'coordinator', prompt: 'x' }, makeExec());
  assert.equal(result.kind, 'activation');
  assert.equal(subagents.calls.length, 1);
  assert.equal(subagents.calls[0].label, 'координатор:coordinator');
});

await test('spawn: getKnownProviders недоступен или упал — прежнее поведение', async () => {
  const variants = [
    undefined,
    () => { throw new Error('llm unavailable'); },
    async () => undefined,
  ];
  for (const getKnownProviders of variants) {
    const own = makeProject({ 'graph.json': directGraph('opencode') });
    const runtime = createGraphRuntime({ roots: [own] });
    const subagents = makeSubagents();
    const tool = createSpawnTool({
      runtime,
      config: {},
      getSubagents: () => subagents,
      getKnownProviders,
    });
    await tool.execute({ node: 'coordinator', prompt: 'x' }, makeExec());
    assert.equal(subagents.calls.length, 1, 'без списка узел запускается как раньше');
  }
});

await test('spawn: каталог llm главнее getKnownProviders', async () => {
  const own = makeProject({ 'graph.json': directGraph('opencode') });
  const runtime = createGraphRuntime({ roots: [own] }, {
    getLlm: () => ({
      listProviders: () => [{ id: 'opencode', name: 'OpenCode' }],
      listModels: async () => [{ id: 'deepseek-v4.1-flash' }],
    }),
  });
  const subagents = makeSubagents();
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => subagents,
    getKnownProviders: () => ['opencode-go'],
  });
  await tool.execute({ node: 'coordinator', prompt: 'x' }, makeExec());
  assert.equal(subagents.calls.length, 1, 'каталог прочитан — список рантайма не перебивает');
});

await test('spawn: провайдер без agentOptions — spawn-unavailable', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const subagents = makeSubagents({ provider: { name: 'spawn', capabilities: { agentOptions: false } } });
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await assert.rejects(
    tool.execute({ node: 'critic', prompt: 'x' }, makeExec()),
    (error) => error.code === 'spawn-unavailable',
  );
  assert.equal(subagents.calls.length, 0);
});

await test('spawn: нет службы subagents — spawn-unavailable', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => null });
  await assert.rejects(
    tool.execute({ node: 'critic', prompt: 'x' }, makeExec()),
    (error) => error.code === 'spawn-unavailable',
  );
});

await test('spawn: конфигурация provider и maxDepth доходит до вызова', async () => {
  const runtime = createGraphRuntime({ roots: [makeProject({ 'graph.json': GRAPH })] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({
    runtime,
    config: { provider: 'spawn', maxDepth: 2 },
    getSubagents: () => subagents,
  });
  await tool.execute({ node: 'lead', prompt: 'x' }, makeExec());
  assert.equal(subagents.calls[0].provider, 'spawn');
  assert.equal(subagents.calls[0].request.maxDepth, 2);
});

await test('render: plan и activation читаются по-разному', () => {
  const tool = createSpawnTool({
    runtime: createGraphRuntime({ roots: [project] }),
    config: {},
    getSubagents: () => makeSubagents(),
  });
  const planText = tool.output.render({}, { kind: 'plan', node: 'critic', provider: 'p', model: 'm' })[0].text;
  const runText = tool.output.render({}, { kind: 'activation', childId: 'c1', node: 'critic', provider: 'p', model: 'm' })[0].text;
  assert.match(planText, /plan only/);
  assert.match(runText, /subagent c1/);
});

await test('registerSpawnTool: регистрирует ровно один инструмент', () => {
  const runtime = createGraphRuntime({ roots: [project] });
  const registered = [];
  const ctx = {
    tools: { register(definition) { registered.push(definition); return () => {}; } },
    subagents: makeSubagents(),
  };
  registerSpawnTool(ctx, runtime, {});
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, SPAWN_TOOL_NAME);
  assert.deepEqual(registered[0].parameters.required, ['node', 'prompt']);
});

await test('spawnError: код виден и в message, и в свойстве', () => {
  const error = spawnError('unknown-node', 'нет такого узла');
  assert.equal(error.code, 'unknown-node');
  assert.match(error.message, /^project_graph_spawn: unknown-node: /);
});

await test('apply: инструмент регистрируется через ctx.inject', () => {
  const registered = [];
  /* 0101: apply пишет health.json — набор не должен трогать реальный ~/.dsh. */
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-apply-store-'));
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  const ctx = {
    inject(names, callback) {
      if (names.every((name) => name in ctx)) callback(ctx);
    },
    tools: { register(definition) { registered.push(definition); return () => {}; } },
    subagents: makeSubagents(),
    webServer: { register() { return () => {}; } },
    effect(fn) { return fn(); },
    logger: { warn() {} },
  };
  try {
    apply(ctx, { roots: [project] });
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
  assert.equal(registered.length, 3, 'три инструмента проекта зарегистрированы');
  assert.deepEqual(
    registered.map((item) => item.name).sort(),
    [BRANCH_TOOL_NAME, RUN_TOOL_NAME, SPAWN_TOOL_NAME].sort(),
  );
});

/* ------------------------------------------------------------------------- *
 * 0136: дисциплина узла — refuse по умолчанию, parallel: N, очередь стора.
 * ------------------------------------------------------------------------- */

function nodeGraph(concurrency) {
  return {
    version: 1,
    models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [{ id: 'worker', role: 'исполнитель', model: 'ds', ...(concurrency ? { concurrency } : {}) }],
    edges: [],
  };
}

function concurrencyFixture(concurrency, runsDir) {
  const root = makeProject({ 'graph.json': nodeGraph(concurrency) });
  const runtime = createGraphRuntime({ roots: [root], ...(runsDir ? { runsDir } : {}) });
  const calls = [];
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      calls.push(spec);
      return { childId: 'worker-' + calls.length };
    },
  };
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  return { root, runtime, tool, calls };
}

await test('0136 spawn: без concurrency узел занят — node-busy с рекомендацией queue/parallel', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0136-'));
  const { root, runtime, tool, calls } = concurrencyFixture(undefined, runsDir);
  const first = await tool.execute({ node: 'worker', prompt: 'сделай' }, makeExec());
  assert.equal(first.kind, 'activation');
  await assert.rejects(
    () => tool.execute({ node: 'worker', prompt: 'ещё' }, makeExec()),
    (error) => {
      assert.equal(error.code, 'node-busy');
      assert.match(error.message, /занят/u, 'отказ говорит, что узел занят');
      assert.match(error.message, /queue/u, 'есть рекомендация очереди');
      assert.match(error.message, /parallel/u, 'есть рекомендация параллели');
      return true;
    },
  );
  assert.equal(calls.length, 1, 'отказ не поднимает вторую сессию');
  const running = listRuns(runtime, root).filter((row) => row.state === 'running');
  assert.equal(running.length, 1, 'отказ не пишет вторую running-запись');
});

await test('0136 spawn: parallel: 2 — второй спавн разрешён, третий node-busy', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0136-'));
  const { root, runtime, tool, calls } = concurrencyFixture({ mode: 'parallel', max: 2 }, runsDir);
  await tool.execute({ node: 'worker', prompt: 'первая' }, makeExec());
  await tool.execute({ node: 'worker', prompt: 'вторая' }, makeExec());
  assert.equal(calls.length, 2, 'parallel: 2 пускает две сессии');
  assert.equal(listRuns(runtime, root).filter((row) => row.state === 'running').length, 2);
  await assert.rejects(
    () => tool.execute({ node: 'worker', prompt: 'третья' }, makeExec()),
    (error) => {
      assert.equal(error.code, 'node-busy');
      assert.match(error.message, /parallel: 2/u, 'отказ называет предел');
      return true;
    },
  );
  assert.equal(calls.length, 2, 'сверх лимита сессия не поднимается');
});

await test('0136 spawn: queue — занятый узел отдаёт kind queued, позицию и запись queue.json', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0136-'));
  const project0136 = makeProject({ 'graph.json': {
    version: 1,
    models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [
      { id: 'worker', role: 'исполнитель', model: 'ds', concurrency: { mode: 'queue' } },
      { id: 'judge', role: 'приёмщик', model: 'ds' },
    ],
    edges: [{ from: 'worker', to: 'judge', kind: 'review' }],
  } });
  fs.mkdirSync(path.join(project0136, 'docs', 'tasks', '0136'), { recursive: true });
  fs.writeFileSync(path.join(project0136, 'docs', 'tasks', '0136', 'task.md'),
    '<!-- TASK-META\n' + JSON.stringify({ executor: 'subagent:worker', acceptor: 'subagent:judge' }) + '\n-->\n');
  const runtime = createGraphRuntime({ roots: [project0136], runsDir });
  const calls = [];
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      calls.push(spec);
      return { childId: 'worker-' + calls.length };
    },
  };
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });

  await tool.execute({ node: 'worker', prompt: 'первая' }, makeExec());
  const second = await tool.execute({ node: 'worker', prompt: 'вторая', task: 'docs/tasks/0136/task.md' }, makeExec());
  assert.equal(second.kind, 'queued');
  assert.equal(second.node, 'worker');
  assert.equal(second.position, 1);
  assert.equal(second.childId, undefined, 'очередь не поднимает сессию');
  assert.equal(calls.length, 1, 'до активации дело не дошло');

  const file = queueFilePath({ runsDir }, project0136);
  assert.equal(fs.existsSync(file), true, 'очередь лежит в сторе');
  assert.equal(path.basename(file), 'queue.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.node, 'worker');
  assert.equal(row.prompt, 'вторая');
  assert.equal(row.task, 'docs/tasks/0136/task.md');
  assert.equal(row.root, path.resolve(project0136));
  assert.equal(row.position, 1);
  assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/u);

  const queuedRun = listRuns(runtime, project0136).find((item) => item.state === 'queued');
  assert.ok(queuedRun, 'запись прогона state queued');
  assert.equal(queuedRun.node, 'worker');

  const third = await tool.execute({ node: 'worker', prompt: 'третья' }, makeExec());
  assert.equal(third.position, 2, 'позиция растёт по длине очереди этого узла');
  assert.equal(calls.length, 1);
});

await test('0136 spawn: queue на свободном узле стартует и очередь не пишет', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0136-'));
  const { root, tool, calls } = concurrencyFixture({ mode: 'queue' }, runsDir);
  const value = await tool.execute({ node: 'worker', prompt: 'сделай' }, makeExec());
  assert.equal(value.kind, 'activation');
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(queueFilePath({ runsDir }, root)), false, 'свободный узел не встаёт в очередь');
});

await test('0136 spawn: plan занятого узла возвращает маршрут и не считается занятостью', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0136-'));
  const { tool, calls } = concurrencyFixture(undefined, runsDir);
  await tool.execute({ node: 'worker', prompt: 'сделай' }, makeExec());
  const plan = await tool.execute({ node: 'worker', prompt: 'проверь', plan: true }, makeExec());
  assert.equal(plan.kind, 'plan');
  assert.equal(plan.provider, 'opencode');
  assert.equal(plan.model, 'deepseek-v4.1-flash');
  assert.equal(calls.length, 1, 'план не поднимает сессию');
});

await test('0136 run: занятый узел отказывает, свободный — работает как раньше', async () => {
  const noStart = () => ({
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() { throw new Error('занятый узел не должен активироваться'); },
  });

  const busy = concurrencyFixture(undefined, fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0136-')));
  await busy.tool.execute({ node: 'worker', prompt: 'сделай' }, makeExec());
  const runTool = createRunTool({ runtime: busy.runtime, config: {}, getSubagents: noStart });
  await assert.rejects(
    () => runTool.execute({ node: 'worker', prompt: 'ждёт', root: busy.root }, makeExec()),
    (error) => {
      assert.equal(error.code, 'node-busy', 'ожидающий вызов тоже подчинён дисциплине узла');
      assert.match(error.message, /queue|parallel/u, 'и получает совет');
      return true;
    },
  );

  /* Контроль: тот же инструмент на свободном узле запускает агента, как раньше. */
  const free = concurrencyFixture(undefined, fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0136-')));
  const freeRunTool = createRunTool({
    runtime: free.runtime,
    config: {},
    getSubagents: () => ({
      getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
      resolveMaxDepth: () => 1,
      async startActivation() {
        return { childId: 'run-free', result: Promise.resolve({ output: [{ type: 'text', text: 'готово' }], stopReason: 'stop' }), dispose: async () => {} };
      },
    }),
  });
  const value = await freeRunTool.execute({ node: 'worker', prompt: 'x', root: free.root }, makeExec());
  assert.equal(value.status, 'ok');
  assert.equal(value.childId, 'run-free');
});

/* ------------------------------------------------------------------------- *
 * 0137: узел знает, что он узел — id, роль, назначение и спека в промпте.
 * ------------------------------------------------------------------------- */

const IDENTITY_SPEC = 'Роль: координатор — ведёт план. Definition of Done: план обновлён.';

/** Проект с одним узлом: маршрут алиасом, чтобы не повторять provider/model. */
function identityProject(node) {
  return makeProject({
    'graph.json': {
      version: 1,
      models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
      nodes: [{ model: 'ds', ...node }],
      edges: [],
    },
  });
}

function promptParts(call) {
  return (call.request.prompt || []).map((part) => (part && typeof part.text === 'string' ? part.text : ''));
}

await test('0137 spawn: блок идентичности — узел, роль, назначение и спека', async () => {
  const root = identityProject({
    id: 'coordinator', role: 'координатор', brief: 'ведёт план и раздаёт работу', prompt: IDENTITY_SPEC,
  });
  const runtime = createGraphRuntime({ roots: [root] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await tool.execute({ node: 'coordinator', prompt: 'СДЕЛАЙ: проверь отчёт' }, makeExec());
  const prompt = subagents.calls[0].request.prompt;
  assert.equal(prompt.length, 2, 'задача с блоком идентичности и отдельный runId');
  assert.equal(prompt[0].text, [
    'Ты — узел coordinator, роль координатор.',
    'Назначение: ведёт план и раздаёт работу.',
    'Спека: ' + IDENTITY_SPEC,
    '',
    'СДЕЛАЙ: проверь отчёт',
  ].join('\n'), 'блок идентичности первым, промпт вызывающего — дословно после него');
  assert.match(prompt[1].text, /^runId: /u);
  assert.equal(/undefined/u.test(promptParts(subagents.calls[0]).join('\n')), false, 'undefined в промпт не протекает');
});

await test('0137 spawn: узел без brief и спеки — остаются id и роль, без undefined', async () => {
  const root = identityProject({ id: 'worker', role: 'исполнитель' });
  const runtime = createGraphRuntime({ roots: [root] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await tool.execute({ node: 'worker', prompt: 'сделай' }, makeExec());
  const prompt = subagents.calls[0].request.prompt;
  assert.equal(prompt[0].text, 'Ты — узел worker, роль исполнитель.\n\nсделай',
    'пустые «Назначение» и «Спека» не печатаются');
  assert.equal(prompt.length, 2, 'структура промпта не зависит от полноты узла');
  assert.equal(/undefined/u.test(promptParts(subagents.calls[0]).join('\n')), false);
});

await test('0137 spawn: узел без роли не печатает пустую роль', async () => {
  const root = identityProject({ id: 'solo' });
  const runtime = createGraphRuntime({ roots: [root] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await tool.execute({ node: 'solo', prompt: 'x' }, makeExec());
  assert.equal(subagents.calls[0].request.prompt[0].text, 'Ты — узел solo.\n\nx', 'нет запятой и слова «undefined»');
  assert.equal(/undefined/u.test(promptParts(subagents.calls[0]).join('\n')), false);
});

await test('0137 run: тот же построитель — run-ветка тоже знает роль', async () => {
  const root = identityProject({
    id: 'judge', role: 'приёмщик', brief: 'проверяет работу', prompt: IDENTITY_SPEC,
  });
  const runtime = createGraphRuntime({ roots: [root] });
  const calls = [];
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      calls.push(spec);
      return { childId: 'run-identity', result: Promise.resolve({ output: [], stopReason: 'stop' }), dispose: async () => {} };
    },
  };
  const tool = createRunTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'judge', prompt: 'проверь' }, makeExec());
  assert.equal(value.status, 'ok');
  const prompt = calls[0].request.prompt;
  assert.equal(prompt[0].text, [
    'Ты — узел judge, роль приёмщик.',
    'Назначение: проверяет работу.',
    'Спека: ' + IDENTITY_SPEC,
    '',
    'проверь',
  ].join('\n'), 'run собирает промпт тем же построителем');
  assert.match(prompt[1].text, /^runId: /u);
});

/* ------------------------------------------------------------------------- *
 * 0138: сессия узла в root, а не в воркспейсе родителя.
 *
 * Живой случай ws-school-app --05: spawn({root}) вернул childId, а сессия легла
 * в воркспейс родителя. После активации cwd ребёнка сверяется с корнем узла:
 * не совпал — отказ root-mismatch, прогон error, успешного childId нет; проба
 * недоступна — активация проходит, запись говорит cwdSource:'unknown'.
 * ------------------------------------------------------------------------- */

/** Факт хоста: кэш сессий, откуда readSessionCwd читает рабочий каталог. */
function writeSessionCache(dir, sessionId, cwd) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.json'), JSON.stringify({
    record: { rows: { workingDirectory: { ver: 1, seq: 1, val: cwd } } },
  }));
}

function cwdFixture(options = {}) {
  const own = makeProject({ 'graph.json': GRAPH });
  const other = makeProject({ 'graph.json': GRAPH });
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0138-'));
  const runtime = createGraphRuntime({ roots: options.roots || [own], runsDir });
  return { own, other, runsDir, runtime };
}

await test('0138 spawn: проба cwd != root — root-mismatch, прогон error, успешного childId нет', async () => {
  const { own, other, runsDir, runtime } = cwdFixture();
  let disposed = 0;
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() {
      return { childId: 'child-0138-wrong', dispose: async () => { disposed += 1; } };
    },
  };
  /*
   * 0142: проба родителя отвечает «неизвестно» — cwd задаёт не вызывающий, а хост,
   * поэтому после активации сверяется cwd ребёнка. Это и есть живой случай 0138:
   * хост создал ребёнка в воркспейсе родителя, хотя попросили корень узла.
   */
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => subagents,
    probeCwd: (sessionId) => (sessionId === 'agent-parent' ? undefined : other),
  });
  await assert.rejects(
    () => tool.execute({ node: 'critic', prompt: 'проверь', root: own }, makeExec()),
    (error) => {
      assert.equal(error.code, 'root-mismatch', 'отказ называет причину, а не «активация не удалась»');
      assert.match(error.message, /другом воркспейсе/u);
      assert.ok(error.message.includes(other), 'в отказе фактический каталог ребёнка: ' + error.message);
      assert.ok(error.message.includes(path.resolve(own)), 'в отказе корень узла: ' + error.message);
      return true;
    },
  );
  const record = listRuns(runtime, own)[0];
  assert.equal(record.state, 'error', 'запуск не в том воркспейсе не выглядит успешным');
  assert.match(record.message, /другом воркспейсе/u);
  assert.equal(record.childId, 'child-0138-wrong', 'запись называет настоящую сессию');
  assert.equal(record.cwdSource, 'session', 'источник факта — кэш сессий хоста');
  assert.equal(record.agentCwd, other);
  assert.equal(record.cwd, path.resolve(own), 'cwd — что попросили у хоста');
  assert.equal(record.cwdMismatch, true, 'расхождение вычислено, а не предположено');
  assert.equal(disposed, 1, 'ребёнок в чужом воркспейсе остановлен');
  const rows = readLaunches(runsDir, own);
  const started = rows.find((row) => row.state === 'started');
  assert.equal(started.childId, 'child-0138-wrong', 'свидетельство называет поднятую сессию');
  const settled = rows.find((row) => row.state === 'settled');
  assert.equal(settled.ok, false, 'свидетельство запуска — отказ');
  assert.equal(settled.errorCode, 'root-mismatch');
  assert.equal(rows.filter((row) => row.state === 'started').length, 1, 'одна started-запись, как и было');
});

await test('0138 spawn: проба cwd == root — активация проходит, факт остаётся в записи', async () => {
  const { own, runtime } = cwdFixture();
  let settle;
  const result = new Promise((resolve) => { settle = resolve; });
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() {
      return { childId: 'child-0138-ok', result, dispose: async () => {} };
    },
  };
  const probes = [];
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => subagents,
    probeCwd: (sessionId) => { probes.push(sessionId); return path.resolve(own); },
  });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  assert.equal(value.kind, 'activation');
  assert.equal(value.childId, 'child-0138-ok');
  assert.deepEqual(probes, ['agent-parent', 'child-0138-ok'],
    '0142: cwd родителя спрашивается до активации, затем cwd ребёнка — до ответа вызывающему');
  const running = listRuns(runtime, own)[0];
  assert.equal(running.state, 'running');
  assert.equal(running.cwdSource, 'session');
  assert.equal(running.agentCwd, path.resolve(own));
  assert.equal(running.cwdMismatch, false, 'совпадение записано фактом');
  settle({ output: [{ type: 'text', text: 'готово' }], stopReason: 'stop' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const done = listRuns(runtime, own)[0];
  assert.equal(done.state, 'done');
  assert.equal(done.cwdSource, 'session', 'факт не теряется на переходе running → done');
  assert.equal(done.agentCwd, path.resolve(own));
});

await test('0138 spawn: проба недоступна — активация проходит, cwdSource unknown', async () => {
  const variants = [
    ['undefined', () => undefined],
    ['null', () => null],
    ['пустая строка', () => '   '],
    ['ошибка пробы', () => { throw new Error('кэш сессий недоступен'); }],
  ];
  for (const [name, probe] of variants) {
    const { own, runtime } = cwdFixture();
    const subagents = {
      getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
      resolveMaxDepth: () => 1,
      async startActivation() {
        return { childId: 'child-0138-unknown', dispose: async () => {} };
      },
    };
    const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents, probeCwd: probe });
    const value = await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
    assert.equal(value.kind, 'activation', name + ': отказ по догадке запрещён (D1)');
    assert.equal(value.childId, 'child-0138-unknown');
    const record = listRuns(runtime, own)[0];
    assert.equal(record.cwdSource, 'unknown', name + ': запись говорит, что факта нет');
    assert.equal(record.agentCwd, undefined, name + ': чужой cwd не выдуман');
    assert.equal(record.cwdMismatch, undefined, name + ': совпадение не предположено');
  }
});

await test('0138 spawn: без опции пробы — readSessionCwd, неизвестный cwd не отказ', async () => {
  /* Настоящий хост называет сессии uuid; у тестового child-1 записи в кэше нет. */
  const { own, runtime } = cwdFixture();
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  assert.equal(value.kind, 'activation', 'умолчание пробы не блокирует запуск');
  assert.equal(value.childId, 'child-1');
  assert.equal(listRuns(runtime, own)[0].cwdSource, 'unknown');
});

await test('0138 spawn: план не спрашивает cwd — запуска нет', async () => {
  const { own, runtime } = cwdFixture();
  let probed = 0;
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => makeSubagents(),
    probeCwd: () => { probed += 1; return own; },
  });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь', plan: true }, makeExec());
  assert.equal(value.kind, 'plan');
  assert.equal(probed, 0, 'план ничего не поднимает и cwd не спрашивает');
});

await test('0138 apply: проба подключена — cwd ребёнка читается из кэша сессий хоста', async () => {
  const own = makeProject({ 'graph.json': GRAPH });
  const other = makeProject({ 'graph.json': GRAPH });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0138-cache-'));
  writeSessionCache(cacheDir, 'child-apply-0138', other);
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0138-store-'));
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  const registered = [];
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation() {
      return { childId: 'child-apply-0138', dispose: async () => {} };
    },
  };
  const ctx = {
    inject(names, callback) {
      if (names.every((name) => name in ctx)) callback(ctx);
    },
    tools: { register(definition) { registered.push(definition); return () => {}; } },
    subagents,
    webServer: { register() { return () => {}; } },
    effect(fn) { return fn(); },
    logger: { warn() {} },
  };
  try {
    apply(ctx, { roots: [own], sessionCacheDir: cacheDir, schedule: false, exchangeWatch: false });
    const spawnTool = registered.find((item) => item.name === SPAWN_TOOL_NAME);
    assert.ok(spawnTool, 'project_graph_spawn зарегистрирован');
    await assert.rejects(
      () => spawnTool.execute({ node: 'critic', prompt: 'проверь' }, makeExec()),
      (error) => {
        assert.equal(error.code, 'root-mismatch', 'проводка index.js: проба видит чужой cwd из кэша');
        assert.ok(error.message.includes(other), 'в отказе каталог из кэша сессий');
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
});


/* ------------------------------------------------------------------------- *
 * 0142: сессия узла открывается в root узла.
 *
 * Хост берёт cwd ребёнка от сессии-родителя (0138). Если cwd вызывающего известен
 * и чужой, в корне узла создаётся служебная сессия (createAgent) и ребёнок идёт от
 * неё; нет службы или создание упало — честный отказ root-mismatch до активации, а
 * не молчаливый запуск в чужом воркспейсе. Неизвестный cwd — прежнее поведение.
 * ------------------------------------------------------------------------- */

function sessionRootFixture() {
  const own = makeProject({ 'graph.json': GRAPH });
  const other = makeProject({ 'graph.json': GRAPH });
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0142-'));
  const runtime = createGraphRuntime({ roots: [own], runsDir });
  return { own, other, runsDir, runtime };
}

function recordingSubagents(calls = []) {
  return {
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      calls.push(spec);
      return { childId: 'child-0142' };
    },
  };
}

await test('0142 spawn: чужой cwd родителя — служебная сессия в root становится родителем', async () => {
  const { own, other, runtime } = sessionRootFixture();
  const calls = [];
  const created = [];
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => recordingSubagents(calls),
    probeCwd: () => other,
    createAgent: async (input) => { created.push(input); return { id: 'session-0142', cwd: input.cwd }; },
  });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь', root: own }, makeExec());
  assert.equal(value.kind, 'activation');
  assert.equal(value.childId, 'child-0142');
  assert.equal(created.length, 1, 'служебная сессия создаётся один раз');
  assert.equal(created[0].cwd, path.resolve(own), 'cwd служебной сессии — корень узла');
  assert.equal(created[0].label, 'acceptor:critic', 'метка служебной сессии — роль:узел');
  assert.match(created[0].reason, /сессия родителя/u, 'причина создания названа');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.parent.id, 'session-0142', 'ребёнок идёт от созданной сессии, а не от вызывающего');
  assert.equal(calls[0].request.cwd, path.resolve(own));
  const record = listRuns(runtime, own)[0];
  assert.equal(record.state, 'running');
  assert.equal(record.sessionSource, 'created', 'запись говорит, откуда родитель активации');
  assert.equal(record.cwdSource, 'created');
  assert.equal(record.cwd, path.resolve(own));
});

await test('0142 spawn: cwd родителя совпал с root — служебная сессия не создаётся', async () => {
  const { own, runtime } = sessionRootFixture();
  let createdCount = 0;
  const calls = [];
  const exec = makeExec();
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => recordingSubagents(calls),
    probeCwd: () => path.resolve(own),
    createAgent: async () => { createdCount += 1; return { id: 'should-not-be-used' }; },
  });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь', root: own }, exec);
  assert.equal(value.kind, 'activation');
  assert.equal(createdCount, 0, 'свой воркспейс не требует служебной сессии');
  assert.equal(calls[0].request.parent, exec.agent, 'родитель остался вызывающей сессией');
});

await test('0142 spawn: cwd родителя неизвестен — прежнее поведение, создания нет', async () => {
  const variants = [
    ['undefined', () => undefined],
    ['ошибка пробы', () => { throw new Error('кэш сессий недоступен'); }],
  ];
  for (const [name, probe] of variants) {
    const { own, runtime } = sessionRootFixture();
    let createdCount = 0;
    const tool = createSpawnTool({
      runtime,
      config: {},
      getSubagents: () => recordingSubagents(),
      probeCwd: probe,
      createAgent: async () => { createdCount += 1; return { id: 'should-not-be-used' }; },
    });
    const value = await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
    assert.equal(value.kind, 'activation', name + ': отказ по догадке запрещён (D1)');
    assert.equal(createdCount, 0, name + ': неизвестный cwd не повод создавать сессию');
    assert.equal(listRuns(runtime, own)[0].cwdSource, 'unknown');
  }
});

await test('0142 spawn: чужой cwd родителя без createAgent — отказ до активации', async () => {
  const { own, other, runtime } = sessionRootFixture();
  const calls = [];
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => recordingSubagents(calls),
    probeCwd: () => other,
  });
  await assert.rejects(
    () => tool.execute({ node: 'critic', prompt: 'проверь', root: own }, makeExec()),
    (error) => {
      assert.equal(error.code, 'root-mismatch', 'код отказа — как у 0138');
      assert.match(error.message, /другом воркспейсе/u);
      assert.ok(error.message.includes(other), 'в отказе чужой каталог родителя');
      assert.ok(error.message.includes(path.resolve(own)), 'в отказе корень узла');
      assert.match(error.message, /agents\.create/u, 'отказ объясняет, чего не хватает');
      return true;
    },
  );
  assert.equal(calls.length, 0, 'ребёнок не поднимается в чужом воркспейсе');
  const record = listRuns(runtime, own)[0];
  assert.equal(record.state, 'error');
  assert.equal(record.childId, undefined, 'успешного childId у вызывающего нет');
  assert.match(record.message, /другом воркспейсе/u);
});

await test('0142 spawn: падение createAgent — root-mismatch с причиной, без активации', async () => {
  const { own, other, runtime } = sessionRootFixture();
  const calls = [];
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => recordingSubagents(calls),
    probeCwd: () => other,
    createAgent: async () => { throw new Error('нет службы'); },
  });
  await assert.rejects(
    () => tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec()),
    (error) => {
      assert.equal(error.code, 'root-mismatch');
      assert.match(error.message, /нет службы/u, 'причина создания названа');
      return true;
    },
  );
  assert.equal(calls.length, 0, 'сбой создания не становится запуском в чужом воркспейсе');
  assert.equal(listRuns(runtime, own)[0].state, 'error');
});

await test('0142 spawn: createAgent вернул пусто — отказ, а не родитель undefined', async () => {
  const { own, other, runtime } = sessionRootFixture();
  const calls = [];
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => recordingSubagents(calls),
    probeCwd: () => other,
    createAgent: async () => null,
  });
  await assert.rejects(
    () => tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec()),
    (error) => error.code === 'root-mismatch' && /не вернула сессию/u.test(error.message),
  );
  assert.equal(calls.length, 0);
});

await test('0142 spawn: созданная сессия легла в чужой каталог — отказ и остановка', async () => {
  const { own, other, runtime } = sessionRootFixture();
  const calls = [];
  let disposed = 0;
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => recordingSubagents(calls),
    probeCwd: () => other,
    createAgent: async () => ({ id: 'session-wrong', cwd: other, dispose: async () => { disposed += 1; } }),
  });
  await assert.rejects(
    () => tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec()),
    (error) => error.code === 'root-mismatch' && error.message.includes(other),
  );
  assert.equal(calls.length, 0, 'сессия не в корне не становится родителем');
  assert.equal(disposed, 1, 'сессия в чужой папке остановлена');
});

await test('0142 spawn: план не спрашивает cwd родителя и не создаёт сессию', async () => {
  const { own, other, runtime } = sessionRootFixture();
  let probed = 0;
  let created = 0;
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => recordingSubagents(),
    probeCwd: () => { probed += 1; return other; },
    createAgent: async () => { created += 1; return { id: 'x' }; },
  });
  const value = await tool.execute({ node: 'critic', prompt: 'проверь', plan: true }, makeExec());
  assert.equal(value.kind, 'plan');
  assert.equal(probed, 0, 'план ничего не поднимает и cwd не спрашивает');
  assert.equal(created, 0);
});

await test('0142 apply: index передаёт createAgent и пробу — сессия из ctx.agents.create', async () => {
  const own = makeProject({ 'graph.json': GRAPH });
  const other = makeProject({ 'graph.json': GRAPH });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0142-cache-'));
  writeSessionCache(cacheDir, 'agent-parent', other);
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-0142-store-'));
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  const created = [];
  const registered = [];
  const calls = [];
  const ctx = {
    inject(names, callback) {
      if (names.every((name) => name in ctx)) callback(ctx);
    },
    tools: { register(definition) { registered.push(definition); return () => {}; } },
    subagents: recordingSubagents(calls),
    agents: { async create(options) { created.push(options); return { id: 'session-from-host' }; } },
    webServer: { register() { return () => {}; } },
    effect(fn) { return fn(); },
    logger: { warn() {} },
  };
  try {
    apply(ctx, { roots: [own], sessionCacheDir: cacheDir, schedule: false, exchangeWatch: false });
    const spawnTool = registered.find((item) => item.name === SPAWN_TOOL_NAME);
    assert.ok(spawnTool, 'project_graph_spawn зарегистрирован');
    const value = await spawnTool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
    assert.equal(value.kind, 'activation');
    assert.equal(created.length, 1, 'ctx.agents.create вызван через проводку index.js');
    assert.equal(created[0].cwd, path.resolve(own), 'хосту передан cwd корня узла');
    assert.equal(calls[0].request.parent.id, 'session-from-host', 'родитель — созданная хостом сессия');
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
});

/* ------------------------------------------------------------------------- *
 * 0151: ответ службы создания сессий разной формы.
 *
 * Хост возвращает запись сессии, а не агента: живой случай — «agent id
 * "undefined" does not match session id "session-1"». Поэтому id узнаётся по
 * любому штатному полю (id, sessionId, session.id, agentId), cwd берётся из
 * ответа, иначе из запроса; пустой ответ и ошибка хоста — понятный отказ
 * root-mismatch с причиной, а не падение «undefined».
 * ------------------------------------------------------------------------- */

function createdSessionTool(createAgent) {
  const { own, other, runtime } = sessionRootFixture();
  const calls = [];
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => recordingSubagents(calls),
    probeCwd: () => other,
    createAgent,
  });
  return { own, other, runtime, calls, tool };
}

const NORMALIZED_VARIANTS = [
  ['id', { id: 'agent-1' }, 'agent-1'],
  ['sessionId', { sessionId: 'session-9' }, 'session-9'],
  ['session.id', { session: { id: 's-7' } }, 's-7'],
  ['agentId', { agentId: 'agent-42' }, 'agent-42'],
];

await test('0151 spawn: id созданной сессии — из любого штатного поля ответа', async () => {
  for (const [name, answer, expected] of NORMALIZED_VARIANTS) {
    const p = createdSessionTool(async (input) => ({ ...answer, cwd: input.cwd }));
    const value = await p.tool.execute({ node: 'critic', prompt: 'проверь', root: p.own }, makeExec());
    assert.equal(value.kind, 'activation', name + ': сессия узнана, запуск принят');
    assert.equal(value.childId, 'child-0142');
    assert.equal(p.calls.length, 1, name + ': активация одна');
    assert.equal(p.calls[0].request.parent.id, expected, name + ': родитель — id из ответа');
    const record = listRuns(p.runtime, p.own)[0];
    assert.equal(record.sessionSource, 'created', name + ': запись говорит, откуда родитель');
    assert.equal(record.cwdSource, 'created');
  }
});

await test('0151 spawn: id из ответа важнее sessionId, поля ответа не теряются', async () => {
  const p = createdSessionTool(async (input) => ({ id: 'agent-1', sessionId: 'session-9', marker: 'keep', cwd: input.cwd }));
  const value = await p.tool.execute({ node: 'critic', prompt: 'проверь', root: p.own }, makeExec());
  assert.equal(value.kind, 'activation');
  const parent = p.calls[0].request.parent;
  assert.equal(parent.id, 'agent-1', 'явный id не перекрыт sessionId');
  assert.equal(parent.sessionId, 'session-9', 'остальные поля ответа остались');
  assert.equal(parent.marker, 'keep');
});

await test('0151 spawn: cwd нет в ответе — берётся из запроса, сессия не чужая', async () => {
  const p = createdSessionTool(async () => ({ session: { id: 's-7' } }));
  const value = await p.tool.execute({ node: 'critic', prompt: 'проверь', root: p.own }, makeExec());
  assert.equal(value.kind, 'activation', 'молчание службы о cwd — не отказ по догадке');
  assert.equal(p.calls[0].request.parent.id, 's-7');
  const record = listRuns(p.runtime, p.own)[0];
  assert.equal(record.cwd, path.resolve(p.own), 'cwd факта — запрошенный корень узла');
  assert.equal(record.cwdSource, 'created');
});

await test('0151 spawn: замороженный ответ — родителю копия с id, без падения', async () => {
  const p = createdSessionTool(async (input) => Object.freeze({ sessionId: 'frozen-1', cwd: input.cwd }));
  const value = await p.tool.execute({ node: 'critic', prompt: 'проверь', root: p.own }, makeExec());
  assert.equal(value.kind, 'activation');
  assert.equal(p.calls[0].request.parent.id, 'frozen-1', 'id нормализован и для неизменяемого ответа');
});

await test('0151 spawn: пустой ответ — root-mismatch с советом, активации нет', async () => {
  const p = createdSessionTool(async () => ({}));
  await assert.rejects(
    () => p.tool.execute({ node: 'critic', prompt: 'проверь', root: p.own }, makeExec()),
    (error) => {
      assert.equal(error.code, 'root-mismatch', 'пустой ответ — не «успех с дырой»');
      assert.match(error.message, /служба создания сессий не вернула сессию/iu);
      assert.match(error.message, /ctx\.agents\.create/u, 'совет называет службу');
      assert.match(error.message, /id|sessionId|agentId/u, 'совет говорит, где искать id');
      return true;
    },
  );
  assert.equal(p.calls.length, 0, 'ребёнок не поднят без сессии-родителя');
  const record = listRuns(p.runtime, p.own)[0];
  assert.equal(record.state, 'error');
  assert.match(record.message, /не вернула сессию/iu, 'причина в журнале');
});

await test('0151 spawn: ошибка хоста передана с исходной причиной, не проглочена', async () => {
  const cause = 'agent id "undefined" does not match session id "session-1"';
  const p = createdSessionTool(async () => { throw new Error(cause); });
  await assert.rejects(
    () => p.tool.execute({ node: 'critic', prompt: 'проверь', root: p.own }, makeExec()),
    (error) => {
      assert.equal(error.code, 'root-mismatch');
      assert.ok(error.message.includes(cause), 'исходный текст хоста в отказе: ' + error.message);
      return true;
    },
  );
  assert.equal(p.calls.length, 0);
  assert.ok(listRuns(p.runtime, p.own)[0].message.includes(cause), 'исходная причина и в журнале');
});

await test('0151 spawn: cwd в ответе чужой — по-прежнему отказ 0142 и остановка', async () => {
  const { own, other, runtime } = sessionRootFixture();
  const calls = [];
  let disposed = 0;
  const tool = createSpawnTool({
    runtime,
    config: {},
    getSubagents: () => recordingSubagents(calls),
    probeCwd: () => other,
    createAgent: async () => ({ sessionId: 'session-wrong', cwd: other, dispose: async () => { disposed += 1; } }),
  });
  await assert.rejects(
    () => tool.execute({ node: 'critic', prompt: 'проверь', root: own }, makeExec()),
    (error) => error.code === 'root-mismatch' && error.message.includes(other),
  );
  assert.equal(calls.length, 0, 'сессия не в корне не становится родителем');
  assert.equal(disposed, 1, 'чужая сессия остановлена');
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(failure.error && failure.error.stack ? failure.error.stack : failure.error);
  }
  console.error('SPAWN TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('SPAWN TEST OK: ' + passed + '/' + passed);