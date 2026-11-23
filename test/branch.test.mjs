/**
 * A branch follows delegate edges level by level. These tests pin the plan
 * (who runs, in which order, on which depth), the prompt hand-off between
 * levels, and the refusal to start a node the declaration cannot route.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime } from '../lib/api.js';
import { listRuns } from '../lib/runs.js';
import { buildNodePrompt, createBranchTool, planBranch, DEFAULT_DEPTH } from '../lib/branch.js';

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
async function testAsync(name, body) {
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
    glm: { provider: 'opencode', model: 'glm-5.3-flash' },
  },
  nodes: [
    { id: 'coordinator', role: 'координатор', model: 'ds', brief: 'ведёт план и раздаёт работу' },
    { id: 'worker', role: 'исполнитель', model: 'ds', brief: 'делает основную работу' },
    { id: 'designer', role: 'исполнитель', model: 'ds', brief: 'делает графику' },
    { id: 'judge', role: 'приёмщик', model: 'glm', brief: 'проверяет работу' },
    { id: 'idea', role: 'аналитик' },
  ],
  edges: [
    { from: 'coordinator', to: 'worker', kind: 'delegate' },
    { from: 'coordinator', to: 'designer', kind: 'delegate' },
    { from: 'worker', to: 'judge', kind: 'review' },
    { from: 'worker', to: 'idea', kind: 'delegate' },
  ],
};

/* Drop a node together with the edges that mention it. */
function withoutNode(graph, id) {
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== id),
    edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
  };
}

function makeProject(graph = GRAPH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-branch-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph));
  return dir;
}

function makeRuntime(project, overrides = {}) {
  return createGraphRuntime({ roots: [project], runsDir: overrides.runsDir }, {
    providerName: 'spawn',
    getSubagents: () => overrides.subagents || makeSubagents(),
  });
}

function makeSubagents(behaviour = {}) {
  const calls = [];
  return {
    calls,
    getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } }),
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      calls.push(spec);
      /* project_graph_spawn writes "role: node", with a space after the colon. */
      const node = String(spec.label || '').split(':').pop().trim();
      const answer = behaviour[node];
      if (answer instanceof Error) {
        return { childId: 'child-' + node, result: Promise.reject(answer), dispose: async () => {} };
      }
      return {
        childId: 'child-' + node,
        result: Promise.resolve({ output: [{ type: 'text', text: answer === undefined ? 'результат ' + node : answer }], stopReason: 'stop' }),
        dispose: async () => {},
      };
    },
  };
}

function makeExec() {
  return { agent: { id: 'parent' }, signal: { aborted: false } };
}

test('план: два уровня по delegate, review не идёт', () => {
  const plan = planBranch(GRAPH, 'coordinator', { depth: 2 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.levels, [['coordinator'], ['worker', 'designer']]);
  assert.deepEqual(plan.incoming.worker, ['coordinator']);
  assert.deepEqual(plan.incoming.designer, ['coordinator']);
  assert.equal(plan.depth, 2);
});

test('план: глубина 1 — только стартовый узел', () => {
  const plan = planBranch(GRAPH, 'coordinator', { depth: 1 });
  assert.deepEqual(plan.levels, [['coordinator']]);
  assert.equal(plan.depth, 1);
});

test('план: по умолчанию два уровня', () => {
  assert.equal(planBranch(GRAPH, 'coordinator').depth, DEFAULT_DEPTH);
});

test('план: узел без модели на ветке — отказ с местом', () => {
  const plan = planBranch(GRAPH, 'coordinator', { depth: 3 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'branch-node-unroutable');
  assert.match(plan.message, /idea/);
  assert.match(plan.message, /уровень 3/);
  assert.match(plan.message, /model/);
});

test('план: цикл delegate не зацикливает построение', () => {
  const cyclic = {
    ...GRAPH,
    nodes: GRAPH.nodes.filter((node) => node.id !== 'idea'),
    edges: [
      { from: 'coordinator', to: 'worker', kind: 'delegate' },
      { from: 'worker', to: 'coordinator', kind: 'delegate' },
      { from: 'coordinator', to: 'designer', kind: 'delegate' },
    ],
  };
  const plan = planBranch(cyclic, 'coordinator', { depth: 5 });
  assert.equal(plan.ok, true);
  /* Уровень 2 собирается целиком, обратное ребро на пройденный узел отбрасывается. */
  assert.deepEqual(plan.levels, [['coordinator'], ['worker', 'designer']]);
});

test('план: неизвестный узел объясняет, что делать', () => {
  const plan = planBranch(GRAPH, 'ghost', { depth: 2 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'unknown-node');
  assert.match(plan.message, /structure/);
});

test('подсказка узлу называет роль, назначение и источник', () => {
  const prompt = buildNodePrompt(GRAPH.nodes[1], 'вход', ['coordinator']);
  assert.match(prompt, /узел «worker»/);
  assert.match(prompt, /Роль: исполнитель/);
  assert.match(prompt, /Назначение: делает основную работу/);
  assert.match(prompt, /от «coordinator»/);
  assert.match(prompt, /вход/);
});

await testAsync('ветка: уровень за уровнем, результат уровня уходит вниз', async () => {
  const project = makeProject();
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-branch-runs-'));
  const subagents = makeSubagents({ coordinator: 'план работ' });
  const runtime = makeRuntime(project, { subagents, runsDir });
  const tool = createBranchTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'coordinator', prompt: 'сделай проект', depth: 2, parallelism: 2 }, makeExec());
  assert.equal(value.status, 'ok');
  assert.equal(value.steps.length, 3, 'уровень 2 — это worker и designer; idea сидит глубже');
  assert.deepEqual(value.steps.map((step) => step.node), ['coordinator', 'worker', 'designer']);
  const workerCall = subagents.calls.find((call) => String(call.label).endsWith('worker'));
  assert.match(workerCall.request.prompt[0].text, /Задача пришла от «coordinator»/);
  assert.match(workerCall.request.prompt[0].text, /план работ/);
  const runs = listRuns(runtime, project);
  assert.ok(runs.every((run) => run.branchId === value.branchId), 'шаги должны быть помечены branchId');
  assert.equal(runs.length, 3, 'каждый шаг ветки оставляет запись запуска');
});

await testAsync('ветка: ошибка узла останавливает следующие уровни и называет место', async () => {
  const project = makeProject(withoutNode(GRAPH, 'idea'));
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-branch-runs-'));
  const subagents = makeSubagents({ worker: new Error('провайдер отказал') });
  const runtime = makeRuntime(project, { subagents, runsDir });
  const tool = createBranchTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'coordinator', prompt: 'сделай', depth: 3, parallelism: 1 }, makeExec());
  assert.equal(value.status, 'error');
  assert.equal(value.failedNode, 'worker');
  assert.match(value.error, /провайдер отказал/);
  assert.equal(value.steps.some((step) => step.node === 'designer'), false, 'после ошибки новые узлы не запускаются');
  assert.equal(value.steps.find((step) => step.node === 'worker').level, 2);
  const runs = listRuns(runtime, project);
  assert.equal(runs.find((run) => run.node === 'worker').state, 'error');
});

await testAsync('ветка: параллельность 1 идёт по одному', async () => {
  const project = makeProject(withoutNode(GRAPH, 'idea'));
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-branch-runs-'));
  const subagents = makeSubagents();
  let running = 0;
  let peak = 0;
  const start = subagents.startActivation;
  subagents.startActivation = async (spec) => {
    running += 1;
    peak = Math.max(peak, running);
    try {
      return await start(spec);
    } finally {
      running -= 1;
    }
  };
  const runtime = makeRuntime(project, { subagents, runsDir });
  const tool = createBranchTool({ runtime, config: {}, getSubagents: () => subagents });
  const value = await tool.execute({ node: 'coordinator', prompt: 'сделай', depth: 2, parallelism: 1 }, makeExec());
  assert.equal(value.status, 'ok');
  assert.equal(value.steps.length, 3);
  assert.equal(peak, 1);
});

if (failures.length > 0) {
  console.log('BRANCH TEST FAILED: ' + (passed + failures.length - failures.length) + '/' + (passed + failures.length));
  for (const failure of failures) {
    console.log('FAIL ' + failure.name);
    console.log('  ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)));
  }
  process.exit(1);
}
console.log('BRANCH TEST OK: ' + passed + '/' + passed);