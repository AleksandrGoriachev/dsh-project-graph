/**
 * Гейт обязанностей (задание 0076).
 *
 * Набор доказывает обещания задания: гейтятся только запуск узла и git
 * commit/push через pwsh; warn ничего не блокирует, но пишет событие в хранилище
 * и один раз добавляет модели контекст с обязанностью и числом непрочитанных;
 * без нарушений гейт молчит; обязанность с enforce = fail отклоняет вызов с
 * причиной; память вызовов ограничена сотней; хост без ctx.on не ломается.
 *
 * Ни один тест не пишет в реальный ~/.dsh: каждый получает свой
 * DSH_PROJECT_GRAPH_STORE во временном каталоге.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GATE_FILE, GATE_MEMORY_MAX, GATE_TARGETS, PRE_EXECUTE_EVENT, POST_EXECUTE_EVENT,
  gateFile, gateTarget, handlePostExecute, handlePreExecute, obligationNotice,
  registerObligationGate, resetGateState,
} from '../lib/obligations-gate.js';
import { createGraphRuntime } from '../lib/api.js';
import { storeDir } from '../lib/store.js';

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

/** Свой каталог хранилища на тест: журналы разных тестов не склеиваются. */
async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-gate-store-'));
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    resetGateState();
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

const LETTER = [
  'Format: dsh-exchange/1',
  'From: workflow',
  'To: structure',
  'Date: 2026-11-05T01:00:00+03:00',
  'Thread: critic-report',
  'Session: session-test',
  'Status: report',
  'Subject: тест',
  '',
  'текст',
  '',
].join('\n');

/** Проект во временном каталоге с объявленной обязанностью. */
function project({ letters = false, enforce = 'warn', command = '' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-gate-root-')));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const check = command ? { kind: 'command', run: command } : { kind: 'exchange-unread', max: 0 };
  const graph = {
    version: 1,
    nodes: [{ id: 'worker', role: 'исполнитель', provider: 'deepseek-official', model: 'deepseek-chat', prompt: 'Роль: исполнитель.' }],
    edges: [],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'shared' },
      exchange: { threads: ['critic-report'] },
      participants: ['structure', 'workflow'],
      orchestrator: 'coordinator',
    }],
    obligations: [{ id: 'exchange-read', title: 'разобрать входящие', check, enforce, on: ['node-spawn', 'commit'] }],
  };
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  if (letters) {
    const dir = path.join(root, 'coordination', 'threads', 'critic-report');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-11-05T01-00+03-00--workflow--01.md'), LETTER);
  }
  return root;
}

/** События журнала гейта проекта. */
function gateEvents(root) {
  const file = gateFile(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function runtimeOf(root) {
  return createGraphRuntime({ roots: [root] });
}

function execOf(name, args = {}, extra = {}) {
  return { name, arguments: args, agent: 'session-test', ...extra };
}

const ALLOW = async () => ({ kind: 'allow' });

await test('GATE_TARGETS: только запуск узла и коммит', () => {
  assert.deepEqual([...GATE_TARGETS].sort(), ['commit', 'node-spawn']);
});

await test('gateTarget: project_graph_spawn и project_graph_run — node-spawn', () => {
  assert.equal(gateTarget(execOf('project_graph_spawn', { node: 'worker' })), 'node-spawn');
  assert.equal(gateTarget(execOf('project_graph_run', { node: 'worker' })), 'node-spawn');
});

await test('gateTarget: pwsh с git commit или git push — commit', () => {
  assert.equal(gateTarget(execOf('pwsh', { command: 'git commit -m "test"' })), 'commit');
  assert.equal(gateTarget(execOf('pwsh', { command: 'git push origin main' })), 'commit');
  assert.equal(gateTarget(execOf('pwsh', { command: 'cd repo; git commit -am "x"' })), 'commit');
});

await test('gateTarget: чужие вызовы не гейтятся', () => {
  assert.equal(gateTarget(execOf('pwsh', { command: 'git status --short' })), null);
  assert.equal(gateTarget(execOf('pwsh', { command: 'node tools/test.mjs' })), null);
  assert.equal(gateTarget(execOf('run_code', { code: 'git commit' })), null);
  assert.equal(gateTarget(execOf('subagent', { prompt: 'x' })), null);
  assert.equal(gateTarget({}), null);
  assert.equal(gateTarget(null), null);
});

await test('warn: вызов пропущен, событие записано, нарушение названо', async () => {
  await withStore(async () => {
    const root = project({ letters: true });
    const runtime = runtimeOf(root);
    const exec = execOf('project_graph_spawn', { node: 'worker' });
    let called = 0;
    const pre = await handlePreExecute({ exec, next: async () => { called += 1; return { kind: 'allow' }; }, runtime, root });
    assert.equal(called, 1, 'downstream вызван: warn не блокирует');
    assert.equal(pre.kind, 'allow');
    const events = gateEvents(root);
    assert.equal(events.length, 1);
    assert.equal(events[0].target, 'node-spawn');
    assert.equal(events[0].mode, 'warn');
    assert.equal(events[0].denied, false);
    assert.deepEqual(events[0].obligations, ['exchange-read']);
    assert.match(events[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u, 'время со смещением');
  });
});

await test('warn: post-execute добавляет контекст один раз', async () => {
  await withStore(async () => {
    const root = project({ letters: true });
    const runtime = runtimeOf(root);
    const exec = execOf('project_graph_spawn', { node: 'worker' });
    await handlePreExecute({ exec, next: ALLOW, runtime, root });
    const downstream = { kind: 'allow', content: [] };
    const post = await handlePostExecute({ exec, result: downstream, next: async () => downstream, runtime, root });
    assert.notEqual(post, downstream, 'результат обёрнут');
    assert.equal(post.additionalContexts.length, 1);
    const notice = post.additionalContexts[0];
    assert.equal(notice.source.form, 'notice');
    assert.match(notice.source.summary, /обязанност/iu);
    const text = notice.content[0].text;
    assert.match(text, /exchange-read/u, 'обязанность названа');
    assert.match(text, /непрочитанных писем: 1/u, 'число непрочитанных');
    assert.match(text, /не заблокирован/u, 'сказано, что это предупреждение');
    const again = await handlePostExecute({ exec, result: downstream, next: async () => downstream, runtime, root });
    assert.equal(again, downstream, 'второй post-execute контекст не дублирует');
  });
});

await test('warn: контекст не стирает чужие additionalContexts', async () => {
  await withStore(async () => {
    const root = project({ letters: true });
    const runtime = runtimeOf(root);
    const exec = execOf('project_graph_run', { node: 'worker' });
    await handlePreExecute({ exec, next: ALLOW, runtime, root });
    const downstream = { kind: 'allow', additionalContexts: [{ content: [], source: { form: 'notice', summary: 'чужое' } }] };
    const post = await handlePostExecute({ exec, result: downstream, next: async () => downstream, runtime, root });
    assert.equal(post.additionalContexts.length, 2);
    assert.equal(post.additionalContexts[0].source.summary, 'чужое');
  });
});

await test('post-execute: notice обязанностей — полный message v4 (role, id, source.kind), порядок и тело сохранены (0086, 0088)', async () => {
  await withStore(async () => {
    const root = project({ letters: true });
    const runtime = runtimeOf(root);
    const exec = execOf('project_graph_spawn', { node: 'worker' });
    await handlePreExecute({ exec, next: ALLOW, runtime, root });
    const foreign = {
      role: 'user',
      content: [{ type: 'text', text: 'чужой контекст' }],
      source: { form: 'notice', summary: 'чужое' },
    };
    const body = [{ type: 'text', text: 'тело результата' }];
    const downstream = { kind: 'allow', content: body, additionalContexts: [foreign] };
    const post = await handlePostExecute({ exec, result: downstream, next: async () => downstream, runtime, root });
    const contexts = post.additionalContexts;
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
    assert.match(notice.source.summary, /обязанност/iu);
    assert.deepEqual(post.content, body, 'тело результата не переписано');
    const freshExec = execOf('project_graph_spawn', { node: 'worker' }, { callId: 'call-0088-fresh' });
    await handlePreExecute({ exec: freshExec, next: ALLOW, runtime, root });
    const freshDownstream = { kind: 'allow', content: [] };
    const fresh = await handlePostExecute({ exec: freshExec, result: freshDownstream, next: async () => freshDownstream, runtime, root });
    const freshNotice = fresh.additionalContexts[fresh.additionalContexts.length - 1];
    assert.equal(freshNotice.source.kind, 'plugin:dsh-project-graph', 'kind у второго notice тот же');
    assert.notEqual(freshNotice.id, notice.id, 'на каждый notice — свежий id (0088)');
  });
});

await test('warn: второй гейтованный вызов по callId не путается с первым', async () => {
  await withStore(async () => {
    const root = project({ letters: true });
    const runtime = runtimeOf(root);
    const first = execOf('project_graph_spawn', { node: 'worker' }, { callId: 'call-1' });
    const second = { name: 'project_graph_spawn', arguments: { node: 'worker' }, callId: 'call-1' };
    await handlePreExecute({ exec: first, next: ALLOW, runtime, root });
    const downstream = { kind: 'allow' };
    const post = await handlePostExecute({ exec: second, result: downstream, next: async () => downstream, runtime, root });
    assert.equal(post.additionalContexts.length, 1, 'память ищется по callId, а не по объекту');
  });
});

await test('без нарушений: ни события, ни контекста', async () => {
  await withStore(async () => {
    const root = project({ letters: false });
    const runtime = runtimeOf(root);
    const exec = execOf('project_graph_spawn', { node: 'worker' });
    const pre = await handlePreExecute({ exec, next: ALLOW, runtime, root });
    assert.equal(pre.kind, 'allow');
    assert.deepEqual(gateEvents(root), [], 'событие не пишется');
    const downstream = { kind: 'allow', content: [] };
    const post = await handlePostExecute({ exec, result: downstream, next: async () => downstream, runtime, root });
    assert.equal(post, downstream, 'результат не меняется');
  });
});

await test('проект без структуры: гейт молчит и не блокирует', async () => {
  await withStore(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-gate-empty-'));
    const runtime = runtimeOf(root);
    const exec = execOf('project_graph_spawn', { node: 'worker' });
    const pre = await handlePreExecute({ exec, next: ALLOW, runtime, root });
    assert.equal(pre.kind, 'allow');
    assert.deepEqual(gateEvents(root), []);
  });
});

await test('enforce=fail: deny с id обязанности и рецептом, событие denied', async () => {
  await withStore(async () => {
    const root = project({ letters: true, enforce: 'fail' });
    const runtime = runtimeOf(root);
    const exec = execOf('project_graph_spawn', { node: 'worker' });
    let called = 0;
    const pre = await handlePreExecute({ exec, next: async () => { called += 1; return { kind: 'allow' }; }, runtime, root });
    assert.equal(called, 0, 'downstream не вызван');
    assert.equal(pre.kind, 'deny');
    assert.match(pre.reason, /exchange-read/u, 'обязанность названа');
    assert.match(pre.reason, /не выполнена/u, 'сказано, что не выполнена');
    assert.match(pre.reason, /Прочитайте/u, 'рецепт назван');
    const events = gateEvents(root);
    assert.equal(events.length, 1);
    assert.equal(events[0].mode, 'fail');
    assert.equal(events[0].denied, true);
  });
});

await test('enforce=fail: отклонённый вызов не получает контекст', async () => {
  await withStore(async () => {
    const root = project({ letters: true, enforce: 'fail' });
    const runtime = runtimeOf(root);
    const exec = execOf('pwsh', { command: 'git commit -m "x"' });
    await handlePreExecute({ exec, next: ALLOW, runtime, root });
    const downstream = { kind: 'allow', content: [] };
    const post = await handlePostExecute({ exec, result: downstream, next: async () => downstream, runtime, root });
    assert.equal(post, downstream);
  });
});

await test('память ограничена: 101-й вызов вытесняет первый', async () => {
  await withStore(async () => {
    const root = project({ letters: true });
    const runtime = runtimeOf(root);
    const total = GATE_MEMORY_MAX + 1;
    for (let index = 0; index < total; index += 1) {
      const exec = { name: 'project_graph_spawn', arguments: { node: 'worker' }, callId: 'call-' + index };
      await handlePreExecute({ exec, next: ALLOW, runtime, root });
    }
    const downstream = { kind: 'allow' };
    const oldest = { name: 'project_graph_spawn', arguments: { node: 'worker' }, callId: 'call-0' };
    const evicted = await handlePostExecute({ exec: oldest, result: downstream, next: async () => downstream, runtime, root });
    assert.equal(evicted, downstream, 'самый старый вызов вытеснен');
    const newest = { name: 'project_graph_spawn', arguments: { node: 'worker' }, callId: 'call-' + (total - 1) };
    const kept = await handlePostExecute({ exec: newest, result: downstream, next: async () => downstream, runtime, root });
    assert.equal(kept.additionalContexts.length, 1, 'последний вызов ещё в памяти');
  });
});

await test('obligationNotice: command-обязанность называет команду', async () => {
  const text = obligationNotice({
    target: 'commit',
    root: os.tmpdir(),
    obligations: [{ id: 'tests-green', title: 'прогнать тесты', detail: 'команда завершилась с кодом 1', enforce: 'warn', kind: 'command', command: 'node tools/test.mjs' }],
  });
  assert.match(text, /tests-green/u);
  assert.match(text, /node tools\/test\.mjs/u, 'рецепт — сама команда');
  assert.match(text, /коммит\/пуш/u, 'цель названа');
});

await test('registerObligationGate: без ctx.on — false, без исключения', () => {
  assert.equal(registerObligationGate({}, runtimeOf(os.tmpdir())), false);
  assert.equal(registerObligationGate(null, null), false);
  assert.equal(registerObligationGate({ on: 'нет' }, null), false);
});

await test('registerObligationGate: подписывает pre и post, обработчики работают', async () => {
  await withStore(async () => {
    const root = project({ letters: true });
    const runtime = runtimeOf(root);
    const handlers = new Map();
    const ctx = { on(event, handler) { handlers.set(event, handler); } };
    assert.equal(registerObligationGate(ctx, runtime), true);
    assert.ok(handlers.has(PRE_EXECUTE_EVENT));
    assert.ok(handlers.has(POST_EXECUTE_EVENT));
    const exec = execOf('project_graph_spawn', { node: 'worker' });
    const pre = await handlers.get(PRE_EXECUTE_EVENT)(exec, ALLOW);
    assert.equal(pre.kind, 'allow');
    const downstream = { kind: 'allow' };
    const post = await handlers.get(POST_EXECUTE_EVENT)(exec, downstream, async () => downstream);
    assert.equal(post.additionalContexts.length, 1);
    assert.equal(gateEvents(root).length, 1);
  });
});

await test('registerObligationGate: сбой подписки логируется, а не бросается', async () => {
  const ctx = { on() { throw new Error('нет службы tools'); } };
  assert.equal(registerObligationGate(ctx, runtimeOf(os.tmpdir())), false);
});

await test('журнал гейта: файл в хранилище, не в репозитории', async () => {
  await withStore(async (store) => {
    const root = project({ letters: true });
    const exec = execOf('project_graph_spawn', { node: 'worker' });
    await handlePreExecute({ exec, next: ALLOW, runtime: runtimeOf(root), root });
    assert.equal(path.basename(gateFile(root)), GATE_FILE);
    assert.equal(path.dirname(gateFile(root)), path.resolve(storeDir(root)));
    assert.equal(fs.existsSync(path.join(root, GATE_FILE)), false, 'в репозиторий не пишется');
    assert.equal(path.resolve(storeDir(root)), path.resolve(store), 'хранилище — DSH_PROJECT_GRAPH_STORE');
  });
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.log('FAIL ' + failure.name + ': ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)));
    if (failure.error && failure.error.stack) console.log(String(failure.error.stack).split('\n').slice(1, 4).join('\n'));
  }
  console.log('TESTS FAILED: ' + failures.length + ', passed ' + passed);
  process.exit(1);
}
console.log('TESTS OK: ' + passed);
