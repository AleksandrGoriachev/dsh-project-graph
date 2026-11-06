/**
 * Политика «альтернативного пути» (задание 0073).
 *
 * Набор доказывает четыре обещания задания: текст называет узлы и рецепт,
 * предупреждение доходит до модели через `additionalContexts` вместе с записью
 * в журнал, проект без структуры остаётся в тишине, а журнал читается
 * устойчиво (порядок, лимит, битая строка).
 *
 * Задание 0100 добавляет вторую половину того же блока — `enforcement.processPolicy`:
 * прямой `git commit|push|merge|rebase` в `pwsh/shell/bash/exec` отклоняется до
 * исполнения, штатный путь — `tools/commit.ps1`; решение пишется в тот же журнал.
 *
 * Ни один тест не пишет в реальный `~/.dsh`: журнал живёт по правилам
 * `lib/store.js`, поэтому каждый тест получает свой `DSH_PROJECT_GRAPH_STORE`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALTERNATIVE_TOOL_NAMES, ALTERNATIVES_FILE, DEFAULT_PROCESS_POLICY, DEFAULT_STRUCTURE_POLICY,
  HEALTH_FILE, MAX_ALTERNATIVES, POST_EXECUTE_EVENT, PRE_EXECUTE_EVENT, PROCESS_DENY_SUBCOMMANDS,
  PROCESS_POLICY_MODES, PROCESS_TOOL_NAMES, alternativeDetail, alternativeNotice, alternativesFile,
  detectProcessSubcommand, handlePreExecute, handleToolResult, hasCommitWrapper, isProcessTool,
  readAlternatives, readProcessPolicy, readStructurePolicy, recordAlternative, recordPolicyHealth,
  registerStructurePolicy, resetPolicyHealthState, resetStructurePolicyState, writePolicyHealth,
} from '../lib/structure-policy.js';
import { createGraphRuntime } from '../lib/api.js';
import { apply } from '../lib/index.js';
import { storeDir } from '../lib/store.js';

/** Свой каталог хранилища на тест: журналы разных тестов не склеиваются. */
async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-policy-store-'));
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

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
  nodes: [
    { id: 'worker', role: 'исполнитель', provider: 'opencode', model: 'deepseek-v4.1-flash' },
    { id: 'judge', role: 'приёмщик', provider: 'opencode', model: 'glm-5.3-flash' },
  ],
  edges: [{ from: 'worker', to: 'judge', kind: 'review' }],
};

/** Проект во временном каталоге; `contents` = null — структуры нет. */
function project(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-policy-root-'));
  if (contents !== null) {
    fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
    for (const [name, value] of Object.entries(contents)) {
      fs.writeFileSync(path.join(dir, 'structure', name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }
  }
  return dir;
}

/** Записать общий блок движка workflow: `enforcement.structurePolicy`. */
function writeWorkflowConfig(root, body) {
  fs.mkdirSync(path.join(root, 'docs', 'subagent-workflow'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'subagent-workflow', 'workflow.config.json'), body);
  return root;
}

/** Конфиг с объявленным режимом (0091). */
function withPolicy(root, mode) {
  return writeWorkflowConfig(root, JSON.stringify({ version: 1, enforcement: { structurePolicy: mode } }, null, 2));
}

/** Вызов нативного инструмента в форме `tools/post-execute`. */
function execOf(name, args = { prompt: 'сделай что-нибудь' }) {
  return { name, arguments: args, agent: 'session-test' };
}

/** Пустой downstream, каким его отдаёт хост. */
function downstreamOf() {
  return { kind: 'allow', content: [{ type: 'text', text: 'ребёнок запущен' }] };
}

await test('ALTERNATIVE_TOOL_NAMES: только нативные subagent и subagent_fork', async () => {
  assert.ok(ALTERNATIVE_TOOL_NAMES.has('subagent'));
  assert.ok(ALTERNATIVE_TOOL_NAMES.has('subagent_fork'));
  assert.equal(ALTERNATIVE_TOOL_NAMES.has('run_code'), false, 'run_code не перехватывается');
  assert.equal(ALTERNATIVE_TOOL_NAMES.has('project_graph_spawn'), false);
});

await test('alternativeNotice: узлы с ролями, рецепт project_graph_spawn, «не заблокирован»', async () => {
  const notice = alternativeNotice([{ id: 'worker', role: 'исполнитель' }, { id: 'judge', role: 'приёмщик' }]);
  assert.match(notice, /альтернатив/iu, 'текст называет альтернативный путь');
  assert.match(notice, /worker \(исполнитель\)/u, 'узел с ролью');
  assert.match(notice, /judge \(приёмщик\)/u, 'второй узел с ролью');
  assert.match(notice, /project_graph_spawn/u, 'рецепт назван');
  assert.match(notice, /node: "worker"/u, 'рецепт называет поле node с первым узлом');
  assert.match(notice, /не заблокирован/u, 'сказано, что вызов не заблокирован');
  assert.ok(notice.split('\n').length <= 6, 'текст короткий: не больше шести строк');
  assert.match(alternativeNotice([{ id: 'solo' }]), /solo/u, 'узел без роли тоже назван');
});

await test('alternativeDetail: промпт в журнале, длинный промпт усечён', async () => {
  assert.equal(alternativeDetail(execOf('subagent', { prompt: 'проверь' })), 'prompt: проверь');
  const long = alternativeDetail(execOf('subagent', { prompt: 'я'.repeat(500) }));
  assert.ok(long.length <= 210, 'длинный промпт усечён: ' + long.length);
  assert.match(alternativeDetail(execOf('subagent', { other: 1 })), /other/u, 'без промпта — аргументы');
  assert.equal(alternativeDetail(null), '');
});

await test('handleToolResult: структура — контекст добавлен, событие записано', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': GRAPH });
    const runtime = createGraphRuntime({ roots: [root] });
    let called = 0;
    const downstream = downstreamOf();
    const decision = await handleToolResult({
      exec: execOf('subagent'),
      result: downstream,
      next: async () => { called += 1; return downstream; },
      runtime,
      root,
    });
    assert.equal(called, 1, 'downstream вызван ровно один раз');
    assert.equal(decision.kind, 'allow', 'результат downstream сохранён');
    assert.deepEqual(decision.content, downstream.content, 'содержимое ответа не подменено');
    assert.equal(decision.additionalContexts.length, 1, 'один контекст предупреждения');
    const context = decision.additionalContexts[0];
    assert.equal(context.source.form, 'notice');
    assert.match(context.source.summary, /структура/iu);
    assert.match(context.source.summary, /альтернативн/iu);
    assert.equal(context.content[0].type, 'text');
    assert.match(context.content[0].text, /worker/u);
    assert.match(context.content[0].text, /judge/u);
    assert.match(context.content[0].text, /project_graph_spawn/u);
    const events = readAlternatives({ root });
    assert.equal(events.length, 1, 'событие записано');
    assert.equal(events[0].tool, 'subagent');
    assert.match(events[0].detail, /prompt: сделай/u);
    assert.match(String(events[0].at), /^\d{4}-\d{2}-\d{2}T/u, 'at — ISO');
    assert.equal(alternativesFile(root), path.join(storeDir(root), ALTERNATIVES_FILE));
    assert.equal(fs.existsSync(path.join(root, 'structure', ALTERNATIVES_FILE)), false,
      'в репозитории журнала нет: он живёт в хранилище, как требует C2');
  });
});

await test('handleToolResult: существующие additionalContexts сохранены', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': GRAPH });
    const runtime = createGraphRuntime({ roots: [root] });
    const previous = { content: [{ type: 'text', text: 'прежний контекст' }], source: { form: 'notice', summary: 'прежний' } };
    const decision = await handleToolResult({
      exec: execOf('subagent_fork'),
      result: { kind: 'allow', additionalContexts: [previous] },
      next: async () => ({ kind: 'allow', additionalContexts: [previous] }),
      runtime,
      root,
    });
    assert.equal(decision.additionalContexts.length, 2, 'прежний контекст не вытеснен');
    assert.equal(decision.additionalContexts[0], previous);
    assert.match(decision.additionalContexts[1].source.summary, /альтернативн/iu);
    assert.equal(readAlternatives({ root })[0].tool, 'subagent_fork');
  });
});

await test('handleToolResult: notice — полный message v4 (role, id, source.kind), чужие контексты впереди, тело не переписано (0086, 0088)', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': GRAPH });
    const runtime = createGraphRuntime({ roots: [root] });
    const foreign = {
      role: 'user',
      content: [{ type: 'text', text: 'чужой контекст' }],
      source: { form: 'notice', summary: 'чужое' },
    };
    const downstream = { kind: 'allow', content: [{ type: 'text', text: 'тело результата' }], additionalContexts: [foreign] };
    const decision = await handleToolResult({
      exec: execOf('subagent'),
      result: downstream,
      next: async () => downstream,
      runtime,
      root,
    });
    const contexts = decision.additionalContexts;
    assert.equal(contexts.length, 2, 'чужой контекст не потерян');
    assert.equal(contexts[0], foreign, 'чужие (downstream) контексты идут первыми');
    const notice = contexts[contexts.length - 1];
    assert.equal(notice.role, 'user', 'role: user обязателен — без него запрос к модели отклоняется целиком');
    assert.equal(typeof notice.id, 'string', 'id — строка: без него читатель v4 не восстанавливает сессию (0088)');
    assert.ok(notice.id.trim() !== '', 'id непустой');
    assert.equal(notice.source.kind, 'plugin:dsh-project-graph', 'source.kind — producer-owned, иначе журнал v4 не читается (0088)');
    assert.ok(Array.isArray(notice.content) && notice.content.length > 0, 'content — массив блоков');
    assert.ok(notice.content.every((block) => block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()),
      'каждый блок — непустой text');
    assert.equal(notice.source.form, 'notice', 'source.form остаётся notice');
    assert.match(notice.source.summary, /альтернативн/iu);
    assert.deepEqual(decision.content, downstream.content, 'тело результата не переписано');
    const again = await handleToolResult({
      exec: execOf('subagent'),
      result: downstream,
      next: async () => downstream,
      runtime,
      root,
    });
    const againNotice = again.additionalContexts[again.additionalContexts.length - 1];
    assert.equal(againNotice.source.kind, 'plugin:dsh-project-graph', 'kind у второго notice тот же');
    assert.notEqual(againNotice.id, notice.id, 'на каждый notice — свежий id (0088): две записи журнала не склеиваются');
  });
});

await test('handleToolResult: без явного root берёт корень из рантайма', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': GRAPH });
    const runtime = createGraphRuntime({ roots: [root] });
    const decision = await handleToolResult({
      exec: execOf('subagent'),
      result: downstreamOf(),
      next: async () => downstreamOf(),
      runtime,
    });
    assert.equal(decision.additionalContexts.length, 1, 'структура найдена по runtime.roots[0]');
    assert.equal(readAlternatives({ root }).length, 1);
  });
});

await test('handleToolResult: чужой инструмент — downstream без изменений и без записи', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': GRAPH });
    const runtime = createGraphRuntime({ roots: [root] });
    const downstream = downstreamOf();
    const decision = await handleToolResult({
      exec: execOf('run_code', { code: '1' }),
      result: downstream,
      next: async () => downstream,
      runtime,
      root,
    });
    assert.equal(decision, downstream, 'вернулся тот же объект downstream');
    assert.deepEqual(readAlternatives({ root }), [], 'событие не записано');
  });
});

await test('handleToolResult: без структуры — downstream без изменений и без записи (контроль C3)', async () => {
  await withStore(async () => {
    const root = project(null);
    const runtime = createGraphRuntime({ roots: [root] });
    const downstream = downstreamOf();
    const decision = await handleToolResult({
      exec: execOf('subagent'),
      result: downstream,
      next: async () => downstream,
      runtime,
      root,
    });
    assert.equal(decision, downstream, 'вернулся тот же объект downstream');
    assert.equal(decision.additionalContexts, undefined, 'контекст не добавлен');
    assert.deepEqual(readAlternatives({ root }), [], 'событие не записано');
    assert.equal(fs.existsSync(alternativesFile(root)), false, 'журнал не создан');
  });
});

await test('handleToolResult: пустая структура — тоже тишина', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': { version: 1, nodes: [], edges: [] } });
    const runtime = createGraphRuntime({ roots: [root] });
    const downstream = downstreamOf();
    const decision = await handleToolResult({
      exec: execOf('subagent'),
      result: downstream,
      next: async () => downstream,
      runtime,
      root,
    });
    assert.equal(decision.additionalContexts, undefined, 'узлов нет — предупреждения нет');
    assert.deepEqual(readAlternatives({ root }), []);
  });
});

await test('журнал: легаси-проект (структура в репозитории) не пачкает git status', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': GRAPH });
    const runtime = createGraphRuntime({ roots: [root] });
    const structureDir = path.join(root, 'structure');
    const before = fs.readdirSync(structureDir).sort();
    const downstream = downstreamOf();
    await handleToolResult({ exec: execOf('subagent'), result: downstream, next: async () => downstream, runtime, root });
    assert.deepEqual(fs.readdirSync(structureDir).sort(), before, 'в папке структуры новых файлов нет');
    assert.equal(fs.existsSync(path.join(structureDir, ALTERNATIVES_FILE)), false,
      'журнал не пишется в репозиторий даже в легаси-режиме');
    assert.equal(readAlternatives({ root }).length, 1, 'событие записано в хранилище');
  });
});

await test('журнал: новые первыми, поля at/tool/detail, каталог создаётся', async () => {
  await withStore(async () => {
    const root = project(null);
    recordAlternative({ root, tool: 'subagent', detail: 'первое' });
    recordAlternative({ root, tool: 'subagent_fork', detail: 'второе' });
    recordAlternative({ root, tool: 'subagent', detail: 'третье' });
    const events = readAlternatives({ root });
    assert.deepEqual(events.map((row) => row.detail), ['третье', 'второе', 'первое'], 'новые первыми');
    assert.deepEqual(events.map((row) => row.tool), ['subagent', 'subagent_fork', 'subagent']);
    for (const row of events) assert.match(String(row.at), /^\d{4}-\d{2}-\d{2}T/u);
    const raw = fs.readFileSync(alternativesFile(root), 'utf8').trim().split('\n');
    assert.equal(raw.length, 3, 'по строке JSON на событие');
    for (const line of raw) assert.doesNotThrow(() => JSON.parse(line));
  });
});

await test('журнал: чтение отдаёт не больше ' + MAX_ALTERNATIVES + ' событий, новые первыми', async () => {
  await withStore(async () => {
    const root = project(null);
    for (let index = 0; index < 55; index += 1) {
      recordAlternative({ root, tool: 'subagent', detail: 'событие-' + index });
    }
    const events = readAlternatives({ root });
    assert.equal(events.length, MAX_ALTERNATIVES, 'лимит соблюдён');
    assert.equal(events[0].detail, 'событие-54', 'самое новое первым');
    assert.equal(events[events.length - 1].detail, 'событие-5', 'в хвост уходят старые');
  });
});

await test('журнал: битая строка не ломает чтение', async () => {
  await withStore(async () => {
    const root = project(null);
    recordAlternative({ root, tool: 'subagent', detail: 'целое' });
    fs.appendFileSync(alternativesFile(root), '{"at":"2026-11-05T00:00:00.000Z","tool":"subagent"\n', 'utf8');
    fs.appendFileSync(alternativesFile(root), 'не json\n', 'utf8');
    recordAlternative({ root, tool: 'subagent_fork', detail: 'после мусора' });
    const events = readAlternatives({ root });
    assert.deepEqual(events.map((row) => row.detail), ['после мусора', 'целое'], 'мусор пропущен');
  });
});

await test('журнал: нет файла — пустой список, а не исключение', async () => {
  await withStore(async () => {
    const root = project(null);
    assert.deepEqual(readAlternatives({ root }), []);
    assert.deepEqual(readAlternatives({}), []);
  });
});

await test('registerStructurePolicy: без ctx.on — тихо, false', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': GRAPH });
    const runtime = createGraphRuntime({ roots: [root] });
    assert.equal(registerStructurePolicy({}, runtime), false);
    assert.equal(registerStructurePolicy(null, runtime), false);
    assert.equal(registerStructurePolicy({ on: 'не функция' }, runtime), false);
    assert.deepEqual(readAlternatives({ root }), [], 'подписки нет — записей нет');
  });
});

await test('registerStructurePolicy: подписка на tools/pre-execute и tools/post-execute работает', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': GRAPH });
    const runtime = createGraphRuntime({ roots: [root] });
    const subscribed = [];
    const ctx = { on(event, handler) { subscribed.push({ event, handler }); } };
    assert.equal(registerStructurePolicy(ctx, runtime), true);
    assert.equal(subscribed.length, 2, 'подписаны оба события (0091)');
    assert.deepEqual(subscribed.map((row) => row.event), [PRE_EXECUTE_EVENT, POST_EXECUTE_EVENT]);
    const handler = subscribed[1].handler;
    const downstream = downstreamOf();
    const decision = await handler(execOf('subagent'), downstream, async () => downstream);
    assert.equal(decision.additionalContexts.length, 1, 'обработчик добавил предупреждение');
    assert.equal(readAlternatives({ root })[0].tool, 'subagent');
    const untouched = await handler(execOf('run_code'), downstream, async () => downstream);
    assert.equal(untouched, downstream, 'чужой инструмент не тронут');
  });
});

await test('registerStructurePolicy: исключение подписки не бросается наружу', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': GRAPH });
    const runtime = createGraphRuntime({ roots: [root] });
    const ctx = { on() { throw new Error('хост не принимает подписку'); } };
    assert.equal(registerStructurePolicy(ctx, runtime), false);
  });
});

/* ------------------------------------------------------------------ */
/* 0091: enforcement.structurePolicy = off|warn|fail                    */
/* ------------------------------------------------------------------ */

await test('readStructurePolicy: fail/warn/off из config, source=config', async () => {
  for (const mode of ['off', 'warn', 'fail']) {
    const root = withPolicy(project(null), mode);
    assert.deepEqual(readStructurePolicy(root), { mode, source: 'config' });
  }
});

await test('readStructurePolicy: нет файла и нет ключа — warn по умолчанию, без исключения', async () => {
  const missing = readStructurePolicy(project(null));
  assert.equal(missing.mode, DEFAULT_STRUCTURE_POLICY);
  assert.equal(missing.source, 'default');
  const noKey = writeWorkflowConfig(project(null), JSON.stringify({ version: 1, enforcement: {} }, null, 2));
  const state = readStructurePolicy(noKey);
  assert.equal(state.mode, 'warn');
  assert.equal(state.source, 'default');
  const noBlock = writeWorkflowConfig(project(null), JSON.stringify({ version: 1 }, null, 2));
  assert.equal(readStructurePolicy(noBlock).mode, 'warn');
});

await test('readStructurePolicy: неверное значение и битый JSON — warn с причиной', async () => {
  const invalid = withPolicy(project(null), 'strict');
  const invalidState = readStructurePolicy(invalid);
  assert.equal(invalidState.mode, 'warn');
  assert.equal(invalidState.source, 'default');
  assert.match(invalidState.error, /structurePolicy/u, 'причина называет ключ');
  const broken = writeWorkflowConfig(project(null), '{ "enforcement": { "structurePolicy": ');
  const brokenState = readStructurePolicy(broken);
  assert.equal(brokenState.mode, 'warn');
  assert.equal(brokenState.source, 'default');
  assert.match(brokenState.error, /JSON/u, 'причина называет разбор');
  const notObject = writeWorkflowConfig(project(null), '[]');
  assert.equal(readStructurePolicy(notObject).mode, 'warn');
  assert.ok(readStructurePolicy(notObject).error, 'не объект — тоже причина');
});

await test('handlePreExecute: fail отклоняет до исполнения, next не вызван, журнал denied=true', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withPolicy(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    let called = 0;
    const decision = await handlePreExecute({
      exec: execOf('subagent'),
      next: async () => { called += 1; return { kind: 'allow' }; },
      runtime,
      root,
    });
    assert.equal(called, 0, 'downstream не вызван');
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /subagent/u, 'причина называет инструмент');
    assert.match(decision.reason, /structurePolicy=fail/u, 'причина называет режим');
    assert.match(decision.reason, /worker/u, 'причина называет объявленные узлы');
    assert.match(decision.reason, /project_graph_spawn/u, 'причина называет рецепт');
    assert.match(decision.reason, /node: "worker"/u, 'рецепт с полем node');
    const events = readAlternatives({ root });
    assert.equal(events.length, 1, 'решение записано один раз');
    assert.equal(events[0].tool, 'subagent');
    assert.equal(events[0].mode, 'fail');
    assert.equal(events[0].denied, true);
    assert.match(events[0].detail, /prompt: /u);
    assert.match(String(events[0].at), /^\d{4}-\d{2}-\d{2}T/u, 'at — ISO');
  });
});

await test('handlePreExecute: warn пропускает вызов, журнал mode=warn; notice в post-execute без дубля', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withPolicy(project({ 'graph.json': GRAPH }), 'warn');
    const runtime = createGraphRuntime({ roots: [root] });
    let called = 0;
    const exec = execOf('subagent');
    const pre = await handlePreExecute({
      exec,
      next: async () => { called += 1; return { kind: 'allow' }; },
      runtime,
      root,
    });
    assert.equal(called, 1, 'warn не блокирует вызов');
    assert.equal(pre.kind, 'allow');
    let events = readAlternatives({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].mode, 'warn');
    assert.equal(events[0].denied, false);
    const downstream = downstreamOf();
    const post = await handleToolResult({ exec, result: downstream, next: async () => downstream, runtime, root });
    const notice = (post.additionalContexts || []).slice(-1)[0] || {};
    assert.equal(notice.role, 'user');
    assert.match(notice.content[0].text, /project_graph_spawn/u);
    assert.deepEqual(post.content, downstream.content, 'тело не переписано');
    events = readAlternatives({ root });
    assert.equal(events.length, 1, 'журнал не дублирован');
  });
});

await test('handlePreExecute: off не блокирует и не предупреждает, но решение в журнале', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withPolicy(project({ 'graph.json': GRAPH }), 'off');
    const runtime = createGraphRuntime({ roots: [root] });
    let called = 0;
    const exec = execOf('subagent_fork');
    const pre = await handlePreExecute({
      exec,
      next: async () => { called += 1; return { kind: 'allow' }; },
      runtime,
      root,
    });
    assert.equal(called, 1, 'off не блокирует');
    assert.equal(pre.kind, 'allow');
    const events = readAlternatives({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].mode, 'off');
    assert.equal(events[0].denied, false);
    const downstream = downstreamOf();
    const post = await handleToolResult({ exec, result: downstream, next: async () => downstream, runtime, root });
    assert.equal(post.additionalContexts, undefined, 'off не добавляет notice');
    assert.equal(readAlternatives({ root }).length, 1, 'журнал не дублирован');
  });
});

await test('handleToolResult: fail не добавляет notice и не пишет журнал второй раз', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withPolicy(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    const downstream = downstreamOf();
    const post = await handleToolResult({
      exec: execOf('subagent'),
      result: downstream,
      next: async () => downstream,
      runtime,
      root,
    });
    assert.equal(post.additionalContexts, undefined, 'заметка не нужна: отказ уже в deny');
    assert.deepEqual(readAlternatives({ root }), [], 'журнал не пишется в post-execute');
  });
});

await test('handlePreExecute: проект без структуры — режим не действует даже при fail', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withPolicy(project(null), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    let called = 0;
    const pre = await handlePreExecute({
      exec: execOf('subagent'),
      next: async () => { called += 1; return { kind: 'allow' }; },
      runtime,
      root,
    });
    assert.equal(called, 1, 'без структуры отказа нет');
    assert.equal(pre.kind, 'allow');
    const downstream = downstreamOf();
    const post = await handleToolResult({ exec: execOf('subagent'), result: downstream, next: async () => downstream, runtime, root });
    assert.equal(post.additionalContexts, undefined);
    assert.deepEqual(readAlternatives({ root }), []);
  });
});

await test('registerStructurePolicy: подписанный pre-execute отклоняет вызов при fail', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withPolicy(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    const handlers = new Map();
    const ctx = { on(event, handler) { handlers.set(event, handler); } };
    assert.equal(registerStructurePolicy(ctx, runtime), true);
    let called = 0;
    const decision = await handlers.get(PRE_EXECUTE_EVENT)(execOf('subagent'), async () => { called += 1; return { kind: 'allow' }; });
    assert.equal(called, 0);
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /project_graph_spawn/u);
    assert.equal(readAlternatives({ root })[0].denied, true);
  });
});

/* ------------------------------------------------------------------ */
/* 0100: enforcement.processPolicy — гейт процесса оболочки            */
/* ------------------------------------------------------------------ */

/** Конфиг с режимом процесса (0100); структура объявляется отдельным ключом. */
function withProcess(root, mode, structureMode = 'warn') {
  const enforcement = { structurePolicy: structureMode };
  if (mode !== undefined) enforcement.processPolicy = mode;
  return writeWorkflowConfig(root, JSON.stringify({ version: 1, enforcement }, null, 2));
}

/** Вызов оболочки в форме tools/pre-execute. */
function shellExec(name, command) {
  return execOf(name, { command });
}

/** Обратный слэш: пути собираются fromCharCode, без escape-последовательностей в наборе. */
const BS = String.fromCharCode(92);

await test('PROCESS_TOOL_NAMES: pwsh/shell/bash/exec без учёта регистра, чужое — нет', async () => {
  assert.deepEqual([...PROCESS_TOOL_NAMES].sort(), ['bash', 'exec', 'pwsh', 'shell']);
  assert.deepEqual([...PROCESS_DENY_SUBCOMMANDS], ['commit', 'push', 'merge', 'rebase']);
  for (const name of ['pwsh', 'shell', 'bash', 'exec', 'PWSh', 'Bash', 'EXEC', ' shell ']) {
    assert.equal(isProcessTool(name), true, 'гейтится: ' + name);
  }
  for (const name of ['run_code', 'subagent', 'project_graph_spawn', '', null, 42]) {
    assert.equal(isProcessTool(name), false, 'не гейтится: ' + String(name));
  }
});

await test('readProcessPolicy: fail/warn/off из config, source=config', async () => {
  assert.equal(DEFAULT_PROCESS_POLICY, 'off', 'нет ключа — гейт процесса выключен');
  assert.deepEqual([...PROCESS_POLICY_MODES], ['off', 'warn', 'fail']);
  for (const mode of ['off', 'warn', 'fail']) {
    const root = withProcess(project(null), mode);
    assert.deepEqual(readProcessPolicy(root), { mode, source: 'config' });
  }
});

await test('readProcessPolicy: нет файла/ключа — off; битый JSON и неверное значение — off с причиной', async () => {
  const missing = readProcessPolicy(project(null));
  assert.equal(missing.mode, 'off', 'нет конфига — гейт выключен');
  assert.equal(missing.source, 'default');
  const noKey = readProcessPolicy(writeWorkflowConfig(project(null),
    JSON.stringify({ version: 1, enforcement: { structurePolicy: 'fail' } }, null, 2)));
  assert.equal(noKey.mode, 'off', 'нет ключа processPolicy — off');
  assert.equal(noKey.source, 'default');
  const invalid = readProcessPolicy(withProcess(project(null), 'strict'));
  assert.equal(invalid.mode, 'off', 'неверное значение не блокирует');
  assert.equal(invalid.source, 'default');
  assert.match(invalid.error, /processPolicy/u, 'причина называет ключ');
  const broken = readProcessPolicy(writeWorkflowConfig(project(null), '{ "enforcement": { "processPolicy": '));
  assert.equal(broken.mode, 'off');
  assert.match(broken.error, /JSON/u, 'причина называет разбор');
});

await test('readProcessPolicy и readStructurePolicy читают один блок независимо', async () => {
  const first = writeWorkflowConfig(project(null),
    JSON.stringify({ version: 1, enforcement: { structurePolicy: 'fail', processPolicy: 'off' } }, null, 2));
  assert.equal(readStructurePolicy(first).mode, 'fail');
  assert.equal(readProcessPolicy(first).mode, 'off');
  const second = writeWorkflowConfig(project(null),
    JSON.stringify({ version: 1, enforcement: { structurePolicy: 'off', processPolicy: 'warn' } }, null, 2));
  assert.equal(readStructurePolicy(second).mode, 'off');
  assert.equal(readProcessPolicy(second).mode, 'warn');
  assert.equal(readProcessPolicy(project(null)).mode, 'off', 'нет файла — processPolicy off');
  assert.equal(readStructurePolicy(project(null)).mode, 'warn', 'нет файла — structurePolicy warn');
});

await test('detectProcessSubcommand: commit/push/merge/rebase, опции и регистр', async () => {
  const table = [
    ['git commit -m "feat: всё сразу"', 'commit'],
    ['git commit --no-verify -m x', 'commit'],
    ['git commit -m x --no-verify', 'commit'],
    ['git push --force origin master', 'push'],
    ['git push', 'push'],
    ['git merge feature', 'merge'],
    ['git rebase main', 'rebase'],
    ['GIT COMMIT -m x', 'commit'],
    ['git -C repo commit -m x', 'commit'],
    ['git -c user.name=x commit -m x', 'commit'],
    ['git --no-pager commit -m x', 'commit'],
    ['git.exe commit -m x', 'commit'],
    ['& "C:/Program Files/Git/cmd/git.exe" push origin master', 'push'],
    ['git add -A && git commit -m x', 'commit'],
    ['pwsh -Command "git push --force"', 'push'],
  ];
  for (const [command, expected] of table) {
    assert.equal(detectProcessSubcommand(command), expected, command);
  }
});

await test('detectProcessSubcommand: чтение и обычные команды — пусто', async () => {
  const table = [
    'git status',
    'git diff --stat',
    'git log --oneline -5',
    'git log --grep commit',
    'git fetch origin',
    'git add -A',
    'node tools/test.mjs',
    'echo "git commit"',
    '',
  ];
  for (const command of table) {
    assert.equal(detectProcessSubcommand(command), '', 'не коммит: ' + command);
  }
});

await test('hasCommitWrapper: tools/commit.ps1 в любом регистре и с обоими слэшами', async () => {
  for (const command of [
    "pwsh -File tools/commit.ps1 'task 0100: правка'",
    'pwsh -File .' + BS + 'tools' + BS + 'commit.ps1 -Message x',
    'pwsh -File TOOLS' + BS + 'COMMIT.PS1',
    '& "C:' + BS + 'repo' + BS + 'tools' + BS + 'commit.ps1" -Message x',
    'node tools/commit.ps1 --help',
    '.' + BS + 'tools' + BS + 'commit.ps1 -Message x',
  ]) {
    assert.equal(hasCommitWrapper(command), true, 'обёртка найдена: ' + command);
  }
  for (const command of [
    'git commit -m x',
    'node tools/test.mjs',
    'tools/other.ps1',
    'git commit -m "смотри tools/commit.ps1"',
    'git commit -m tools/commit.ps1',
  ]) {
    assert.equal(hasCommitWrapper(command), false, 'обёртки нет: ' + command);
  }
});

await test('handlePreExecute: упоминание tools/commit.ps1 в сообщении запрет не снимает', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withProcess(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    let called = 0;
    const decision = await handlePreExecute({
      exec: shellExec('pwsh', 'git commit -m "смотри tools/commit.ps1"'),
      next: async () => { called += 1; return { kind: 'allow' }; },
      runtime,
      root,
    });
    assert.equal(called, 0, 'путь в тексте сообщения — не вызов обёртки');
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /tools\/commit\.ps1/u);
    assert.equal(readAlternatives({ root }).length, 1);
  });
});

await test('handlePreExecute: processPolicy=fail отклоняет git commit, next не вызван, журнал denied=true', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withProcess(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    let called = 0;
    const decision = await handlePreExecute({
      exec: shellExec('pwsh', 'git commit -m "feat: всё сразу"'),
      next: async () => { called += 1; return { kind: 'allow' }; },
      runtime,
      root,
    });
    assert.equal(called, 0, 'downstream не вызван: отказ до исполнения');
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /структура/u, 'причина называет структуру');
    assert.match(decision.reason, /процесс/u, 'причина называет процесс');
    assert.match(decision.reason, /git commit/u, 'причина называет подкоманду');
    assert.match(decision.reason, /tools\/commit\.ps1/u, 'причина называет штатный путь');
    assert.match(decision.reason, /task-guard/u, 'причина называет проверку покрытия');
    assert.equal(decision.reason.includes('\n'), false, 'reason — одна строка, без стека');
    const events = readAlternatives({ root });
    assert.equal(events.length, 1, 'решение записано один раз');
    assert.deepEqual(Object.keys(events[0]).sort(), ['at', 'denied', 'detail', 'mode', 'tool'],
      'поля те же, что у structurePolicy');
    assert.equal(events[0].tool, 'pwsh');
    assert.equal(events[0].mode, 'fail');
    assert.equal(events[0].denied, true);
    assert.match(events[0].detail, /git commit/u);
    assert.match(events[0].detail, /feat: всё сразу/u);
    assert.match(String(events[0].at), /^\d{4}-\d{2}-\d{2}T/u, 'at — ISO');
  });
});

await test('handlePreExecute: --no-verify, push, merge, rebase и верхний регистр — тоже deny', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withProcess(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    const commands = [
      'git commit --no-verify -m x',
      'git push --force origin master',
      'git merge feature',
      'git rebase main',
      'GIT COMMIT -m x',
      'git -C repo commit -m x',
    ];
    for (const command of commands) {
      const decision = await handlePreExecute({
        exec: shellExec('pwsh', command),
        next: async () => ({ kind: 'allow' }),
        runtime,
        root,
      });
      assert.equal(decision.kind, 'deny', 'ожидался deny: ' + command);
      assert.match(decision.reason, /tools\/commit\.ps1/u);
    }
    assert.equal(readAlternatives({ root }).length, commands.length, 'каждое решение в журнале');
  });
});

await test('handlePreExecute: tools/commit.ps1 в той же команде снимает запрет, журнал пуст', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withProcess(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    const commands = [
      "pwsh -File tools/commit.ps1 'task 0100: правка'",
      'pwsh -File .' + BS + 'tools' + BS + 'commit.ps1 -Message x',
      'pwsh -File TOOLS' + BS + 'COMMIT.PS1',
      'git commit -m x; pwsh tools/commit.ps1 -Message x',
    ];
    for (const command of commands) {
      let called = 0;
      const decision = await handlePreExecute({
        exec: shellExec('pwsh', command),
        next: async () => { called += 1; return { kind: 'allow' }; },
        runtime,
        root,
      });
      assert.equal(called, 1, 'штатный путь проходит: ' + command);
      assert.equal(decision.kind, 'allow');
    }
    assert.deepEqual(readAlternatives({ root }), [], 'разрешённый путь в журнал не пишется');
  });
});

await test('handlePreExecute: warn пропускает и пишет mode=warn denied=false; post не дублирует и не шумит', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withProcess(project({ 'graph.json': GRAPH }), 'warn');
    const runtime = createGraphRuntime({ roots: [root] });
    const exec = shellExec('pwsh', 'git commit -m x');
    let called = 0;
    const pre = await handlePreExecute({
      exec,
      next: async () => { called += 1; return { kind: 'allow' }; },
      runtime,
      root,
    });
    assert.equal(called, 1, 'warn не блокирует');
    assert.equal(pre.kind, 'allow');
    const events = readAlternatives({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].mode, 'warn');
    assert.equal(events[0].denied, false);
    const downstream = downstreamOf();
    const post = await handleToolResult({ exec, result: downstream, next: async () => downstream, runtime, root });
    assert.equal(post, downstream, 'гейт процесса не меняет результат оболочки');
    assert.equal(post.additionalContexts, undefined, 'warn процесса не добавляет notice');
    assert.equal(readAlternatives({ root }).length, 1, 'журнал не дублирован');
  });
});

await test('handlePreExecute: processPolicy=off и отсутствие ключа — пропуск без записи', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const offRoot = withProcess(project({ 'graph.json': GRAPH }), 'off');
    const missingRoot = writeWorkflowConfig(project({ 'graph.json': GRAPH }),
      JSON.stringify({ version: 1, enforcement: { structurePolicy: 'fail' } }, null, 2));
    for (const root of [offRoot, missingRoot]) {
      const runtime = createGraphRuntime({ roots: [root] });
      let called = 0;
      const decision = await handlePreExecute({
        exec: shellExec('pwsh', 'git commit -m x'),
        next: async () => { called += 1; return { kind: 'allow' }; },
        runtime,
        root,
      });
      assert.equal(called, 1, 'гейт выключен: ' + root);
      assert.equal(decision.kind, 'allow');
      assert.deepEqual(readAlternatives({ root }), [], 'off не пишет журнал');
    }
  });
});

await test('handlePreExecute: чтение git не блокируется даже при fail', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withProcess(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    const commands = [
      'git status', 'git diff --stat', 'git log --oneline -5', 'git fetch origin',
      'git add -A', 'git log --grep commit', 'node tools/test.mjs',
    ];
    for (const command of commands) {
      let called = 0;
      const decision = await handlePreExecute({
        exec: shellExec('pwsh', command),
        next: async () => { called += 1; return { kind: 'allow' }; },
        runtime,
        root,
      });
      assert.equal(called, 1, 'не коммит — не блокируется: ' + command);
      assert.equal(decision.kind, 'allow');
    }
    assert.deepEqual(readAlternatives({ root }), [], 'чтение не пишет журнал');
  });
});

await test('handlePreExecute: shell/bash/exec гейтятся, run_code — нет', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withProcess(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    for (const name of ['shell', 'BASH', 'Exec']) {
      const decision = await handlePreExecute({
        exec: shellExec(name, 'git push origin master'),
        next: async () => ({ kind: 'allow' }),
        runtime,
        root,
      });
      assert.equal(decision.kind, 'deny', 'гейтится по процессу: ' + name);
    }
    let called = 0;
    const decision = await handlePreExecute({
      exec: execOf('run_code', { command: 'git commit -m x' }),
      next: async () => { called += 1; return { kind: 'allow' }; },
      runtime,
      root,
    });
    assert.equal(called, 1, 'run_code вне гейта процесса');
    assert.equal(decision.kind, 'allow');
    assert.equal(readAlternatives({ root }).length, 3, 'решение по run_code не пишется');
  });
});

await test('handlePreExecute: неверное значение processPolicy не блокирует вызов', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withProcess(project({ 'graph.json': GRAPH }), 'strict');
    const runtime = createGraphRuntime({ roots: [root] });
    let called = 0;
    const decision = await handlePreExecute({
      exec: shellExec('pwsh', 'git commit -m x'),
      next: async () => { called += 1; return { kind: 'allow' }; },
      runtime,
      root,
    });
    assert.equal(called, 1, 'fail только по осознанному режиму');
    assert.equal(decision.kind, 'allow');
    assert.deepEqual(readAlternatives({ root }), []);
  });
});

await test('handlePreExecute: processPolicy независим от structurePolicy; subagent при fail отклонён', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withProcess(project({ 'graph.json': GRAPH }), 'fail', 'off');
    const runtime = createGraphRuntime({ roots: [root] });
    const commit = await handlePreExecute({
      exec: shellExec('pwsh', 'git commit -m x'),
      next: async () => ({ kind: 'allow' }),
      runtime,
      root,
    });
    assert.equal(commit.kind, 'deny', 'гейт процесса включает его собственный ключ, а не structurePolicy');
    const strictRoot = withProcess(project({ 'graph.json': GRAPH }), 'fail', 'fail');
    const strictRuntime = createGraphRuntime({ roots: [strictRoot] });
    const native = await handlePreExecute({
      exec: execOf('subagent'),
      next: async () => ({ kind: 'allow' }),
      runtime: strictRuntime,
      root: strictRoot,
    });
    assert.equal(native.kind, 'deny', 'нативный subagent по-прежнему отклонён');
    assert.match(native.reason, /subagent/u);
    const read = await handlePreExecute({
      exec: shellExec('pwsh', 'git status'),
      next: async () => ({ kind: 'allow' }),
      runtime: strictRuntime,
      root: strictRoot,
    });
    assert.equal(read.kind, 'allow', 'structurePolicy=fail не трогает чтение');
  });
});

await test('registerStructurePolicy: подписанный pre-execute гейтит процесс при fail', async () => {
  await withStore(async () => {
    resetStructurePolicyState();
    const root = withProcess(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    const handlers = new Map();
    const ctx = { on(event, handler) { handlers.set(event, handler); } };
    assert.equal(registerStructurePolicy(ctx, runtime), true);
    let called = 0;
    const decision = await handlers.get(PRE_EXECUTE_EVENT)(
      shellExec('pwsh', 'git commit -m x'),
      async () => { called += 1; return { kind: 'allow' }; },
    );
    assert.equal(called, 0, 'отказ до исполнения через подписку');
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /tools\/commit\.ps1/u);
    assert.equal(readAlternatives({ root })[0].denied, true);
  });
});

/* ------------------------------------------------------------------ */
/* 0101: health.json — доказательство, что структура включена            */
/* ------------------------------------------------------------------ */

await test('writePolicyHealth: health.json с root/structurePolicy/подпиской/at (0101)', async () => {
  await withStore(async () => {
    const root = withPolicy(project({ 'graph.json': GRAPH }), 'fail');
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-policy-health-'));
    const body = writePolicyHealth({ root, store, preExecuteSubscribed: true });
    assert.ok(body, 'запись вернула тело');
    const file = path.join(store, HEALTH_FILE);
    assert.ok(fs.existsSync(file), 'health.json создан в переданном сторе');
    const health = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(health.root, path.resolve(root));
    assert.equal(health.structurePolicy, 'fail', 'режим — из workflow.config.json');
    assert.equal(health.preExecuteSubscribed, true);
    assert.equal(health.error, null);
    assert.match(health.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/u);
    /* Индекс рядом с каталогами хранилищ: движку нужен один адрес. */
    const indexFile = path.join(path.dirname(store), HEALTH_FILE);
    assert.ok(fs.existsSync(indexFile), 'сводный health.json не записан');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    assert.equal(index.roots[path.resolve(root)].structurePolicy, 'fail');
  });
});

await test('writePolicyHealth: без конфига — warn, причина в error (0101)', async () => {
  await withStore(async () => {
    const root = project(null);
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-policy-health-'));
    writePolicyHealth({ root, store, preExecuteSubscribed: false, error: 'подписка не сделана' });
    const health = JSON.parse(fs.readFileSync(path.join(store, HEALTH_FILE), 'utf8'));
    assert.equal(health.structurePolicy, 'warn');
    assert.equal(health.preExecuteSubscribed, false);
    assert.equal(health.error, 'подписка не сделана');
  });
});

await test('writePolicyHealth: сбой записи не бросается и не роняет плагин (0101)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-policy-health-bad-'));
  const store = path.join(dir, 'store-as-file');
  fs.writeFileSync(store, 'not a directory');
  const root = project({ 'graph.json': GRAPH });
  let body;
  assert.doesNotThrow(() => { body = writePolicyHealth({ root, store, preExecuteSubscribed: true }); });
  assert.equal(body, null, 'сбой записи — null, а не исключение');
});

await test('recordPolicyHealth: пишет при apply и переписывает только при смене режима (0101)', async () => {
  await withStore(async (store) => {
    resetPolicyHealthState();
    const root = withPolicy(project({ 'graph.json': GRAPH }), 'fail');
    const runtime = createGraphRuntime({ roots: [root] });
    const first = recordPolicyHealth({ root, runtime, preExecuteSubscribed: true, force: true });
    assert.ok(first, 'принудительная запись при apply');
    const file = path.join(store, HEALTH_FILE);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).structurePolicy, 'fail');
    assert.equal(recordPolicyHealth({ root, runtime, preExecuteSubscribed: true }), null,
      'без изменений файл не переписывается');
    withPolicy(root, 'off');
    const changed = recordPolicyHealth({ root, runtime, preExecuteSubscribed: true });
    assert.ok(changed, 'смена режима переписала health.json');
    const health = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(health.structurePolicy, 'off');
    assert.equal(health.preExecuteSubscribed, true);
  });
});

await test('apply: health.json появляется при старте, подписка на pre-execute видна (0101)', async () => {
  await withStore(async (store) => {
    resetPolicyHealthState();
    const root = withPolicy(project({ 'graph.json': GRAPH }), 'fail');
    const handlers = new Map();
    const ctx = {
      inject(names, callback) {
        if (names.every((name) => name in ctx)) callback(ctx);
      },
      tools: { register() { return () => {}; } },
      subagents: {
        getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
        async startActivation() { return { childId: 'child-health' }; },
      },
      webServer: { register() { return () => {}; } },
      on(event, handler) {
        const list = handlers.get(event) || [];
        list.push(handler);
        handlers.set(event, list);
      },
      effect(fn) { return fn(); },
      logger: { warn() {} },
    };
    apply(ctx, { roots: [root] });
    const file = path.join(store, HEALTH_FILE);
    assert.ok(fs.existsSync(file), 'apply пишет health.json');
    const health = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(health.root, path.resolve(root));
    assert.equal(health.structurePolicy, 'fail');
    assert.equal(health.preExecuteSubscribed, true, 'подписка на tools/pre-execute состоялась');
    assert.equal(typeof health.at, 'string');
    /* Смена режима: следующий pre-execute переписывает свидетельство. */
    withPolicy(root, 'warn');
    /* Первый обработчик pre-execute — политика структуры (второй — гейт обязанностей). */
    await handlers.get(PRE_EXECUTE_EVENT)[0](execOf('subagent'), async () => ({ kind: 'allow' }));
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.structurePolicy, 'warn', 'смена режима видна в health.json');
    assert.equal(after.preExecuteSubscribed, true);
  });
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const detail = failure.error && failure.error.message ? failure.error.message : String(failure.error);
  console.error('  ' + detail.split('\n').join('\n  '));
}
console.log('STRUCTURE POLICY TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
