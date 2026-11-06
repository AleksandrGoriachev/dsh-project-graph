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

const GRAPH = {
  version: 1,
  models: {
    ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' },
    glm: { provider: 'opencode', model: 'glm-5.3-flash', family: 'zhipu' },
  },
  nodes: [
    { id: 'lead', role: 'lead', model: 'ds' },
    { id: 'critic', role: 'acceptor', model: 'glm' },
    { id: 'idea', role: 'analyst' },
  ],
  edges: [{ from: 'lead', to: 'critic', kind: 'review' }],
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
  const runtime = createGraphRuntime({ roots: [project] });
  const subagents = makeSubagents();
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  await tool.execute({ node: 'critic', prompt: 'проверь' }, makeExec());
  assert.equal(subagents.calls[0].request.maxDepth, 3, 'хозяйский потолок 1 не должен отменять структуру');
});

await test('spawn: модель узла уходит в agentOptions, роль — в label', async () => {
  const runtime = createGraphRuntime({ roots: [project] });
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
  assert.deepEqual(spec.request.prompt[0], { type: 'text', text: 'проверь работу' });
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
  const runtime = createGraphRuntime({ roots: [project] });
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

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(failure.error && failure.error.stack ? failure.error.stack : failure.error);
  }
  console.error('SPAWN TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('SPAWN TEST OK: ' + passed + '/' + passed);