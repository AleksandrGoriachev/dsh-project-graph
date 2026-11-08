/**
 * Дайджест входящих (задание 0104).
 *
 * Набор доказывает четыре обещания контракта на чистых решениях и один факт
 * проводки на хосте:
 *   - shouldDeliver: первый раз, рост, троттлинг того же счёта, молчание при 0;
 *   - digestText: одна строка, папки с числами, команда проверки, просроченные
 *     отдельно, потолок 300 символов;
 *   - deliverExchangeDigest: доставка один раз, дедуп, рост снова доставляет,
 *     состояние в сторе, упавшая доставка новость не съедает;
 *   - sendDigestToSession: prompt mode 'queue' первым путём, handle.sendMessage —
 *     запасным, «некому» — не ошибка;
 *   - apply: тик планировщика сам зовёт дайджест по корню и доставляет строку в
 *     живую сессию (handle.sendMessage), состояние ложится в стор.
 *
 * Каждый тест получает свой DSH_PROJECT_GRAPH_STORE: следы одного набора не
 * должны влиять на другой и на живой ~/.dsh.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DIGEST_FILE, DIGEST_MAX_LENGTH, DIGEST_THROTTLE_MS,
  deliverExchangeDigest, digestFile, digestText, readDigestState, sendDigestToSession,
  shouldDeliver, writeDigestState,
} from '../lib/digest.js';
import { apply } from '../lib/index.js';
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

async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-digest-store-')), 'store');
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

/** Временный проект; структура объявляется, только если она передана. */
function project(contents = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-digest-root-'));
  if (contents !== null) {
    fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
    for (const [name, value] of Object.entries(contents)) {
      fs.writeFileSync(path.join(dir, 'structure', name),
        typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }
  }
  return dir;
}

/** Минимальная структура: узлы нужны панели, папка — счётчику внимания. */
function graph() {
  return {
    version: 1,
    nodes: [{ id: 'worker', role: 'исполнитель', provider: 'opencode', model: 'deepseek-v4.1-flash' }],
    edges: [],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      participants: ['structure', 'workflow'],
      orchestrator: 'coordinator',
    }],
  };
}

/** Письмо-заявка: только request/question требуют хода (0113). */
const REQUEST = (to = 'structure', from = 'workflow') => 'Format: dsh-exchange/1\n'
  + 'From: ' + from + '\nTo: ' + to + '\nDate: ' + new Date().toISOString()
  + '\nThread: critic-report\nStatus: request\nSubject: нужен ход\n\nтело\n';

function writeLetter(root, rel, text) {
  const file = path.join(root, 'coordination', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/* ------------------------------------------------------------------ */
/* shouldDeliver                                                       */
/* ------------------------------------------------------------------ */

await test('0104 shouldDeliver: ноль не доставляется никогда', () => {
  assert.equal(shouldDeliver({ previous: null, current: { total: 0 }, now: 1000000 }), false);
  assert.equal(
    shouldDeliver({ previous: { total: 5, at: 0 }, current: { total: 0 }, now: 1000000 }),
    false,
    'обнуление счёта — не новость, а тишина',
  );
  assert.equal(shouldDeliver({ previous: null, current: {}, now: 1000000 }), false, 'пустое внимание — тоже ноль');
});

await test('0104 shouldDeliver: первое появление и рост доставляются сразу', () => {
  const now = 1000000;
  assert.equal(shouldDeliver({ previous: null, current: { total: 2 }, now }), true);
  assert.equal(shouldDeliver({ previous: { total: 2, at: now - 1000 }, current: { total: 3 }, now }), true);
  assert.equal(shouldDeliver({ previous: { total: 0, at: now - 1000 }, current: { total: 1 }, now }), true);
});

await test('0104 shouldDeliver: тот же счёт — тишина в троттлинге и напоминание после', () => {
  const now = 10 * 60 * 1000;
  const previous = { total: 3, at: now - 1000 };
  assert.equal(shouldDeliver({ previous, current: { total: 3 }, now }), false);
  assert.equal(shouldDeliver({ previous, current: { total: 3 }, now, throttleMs: 500 }), true,
    'окно троттлинга параметризовано');
  assert.equal(shouldDeliver({ previous: { total: 3, at: now - DIGEST_THROTTLE_MS }, current: { total: 3 }, now }), true,
    'ровно на границе окна — уже новость');
  assert.equal(shouldDeliver({ previous: { total: 3, at: now - 10 * 60 * 1000 }, current: { total: 3 }, now }), true);
});

await test('0104 shouldDeliver: время состояния во Date и ISO, битое — доставляем', () => {
  const now = 2000000;
  assert.equal(shouldDeliver({ previous: { total: 1, at: new Date(now - 1000) }, current: { total: 1 }, now }), false);
  assert.equal(shouldDeliver({ previous: { total: 1, at: new Date(now - 600000).toISOString() }, current: { total: 1 }, now }), true);
  assert.equal(shouldDeliver({ previous: { total: 1, at: 'не время' }, current: { total: 1 }, now }), true,
    'нечитаемое время не должно прятать заявку');
});

/* ------------------------------------------------------------------ */
/* digestText                                                          */
/* ------------------------------------------------------------------ */

await test('0104 digestText: строка со счётом, папками и командой, без переводов строк', () => {
  const text = digestText({
    total: 3,
    stale: 1,
    folders: [{ id: 'folder-1', attention: 2 }, { id: 'folder-2', attention: 1 }],
  });
  assert.match(text, /требуют хода 3/u);
  assert.match(text, /папки/u);
  assert.match(text, /folder-1 2/u);
  assert.match(text, /folder-2 1/u);
  assert.match(text, /node tools\/check-exchange\.mjs/u);
  assert.match(text, /просрочено 1/u);
  assert.doesNotMatch(text, /[\r\n]/u, 'дайджест — одна строка');
  assert.ok(text.length <= DIGEST_MAX_LENGTH, 'длина ' + text.length);
});

await test('0104 digestText: просроченные только когда они есть', () => {
  const quiet = digestText({ total: 1, stale: 0, folders: [{ id: 'folder-1', attention: 1 }] });
  assert.doesNotMatch(quiet, /просрочено/u);
  assert.match(digestText({ total: 1, stale: 2, folders: [] }), /просрочено 2/u);
});

await test('0104 digestText: длинный список папок обрезается, хвост с командой цел', () => {
  const folders = Array.from({ length: 60 }, (unused, index) => ({ id: 'folder-' + index, attention: index + 1 }));
  const text = digestText({ total: 1830, stale: 0, folders });
  assert.ok(text.length <= DIGEST_MAX_LENGTH, 'длина ' + text.length);
  assert.match(text, /check-exchange/u, 'команда проверки не режется');
  assert.match(text, /требуют хода 1830/u);
  assert.match(text, /…/u, 'усечение названо, а не спрятано');
});

await test('0104 digestText: имя папки не тащит перевод строки в сообщение', () => {
  const text = digestText({ total: 1, folders: [{ id: 'folder\n-1\r\n', attention: 1 }] });
  assert.doesNotMatch(text, /[\r\n]/u);
  assert.match(text, /folder -1/u);
});

await test('0104 digestText: папки без внимания не шумят', () => {
  const text = digestText({ total: 2, folders: [{ id: 'folder-0', attention: 0 }, { id: 'folder-1', attention: 2 }] });
  assert.doesNotMatch(text, /folder-0/u);
  assert.match(text, /folder-1 2/u);
});

/* ------------------------------------------------------------------ */
/* deliverExchangeDigest                                               */
/* ------------------------------------------------------------------ */

await test('0104 deliverExchangeDigest: первая доставка, дедуп и рост', async () => {
  await withStore(async () => {
    const root = project();
    const sent = [];
    const send = async (text) => { sent.push(text); };
    const attention = { total: 2, stale: 0, folders: [{ id: 'folder-1', attention: 2 }] };
    const first = await deliverExchangeDigest({ runtime: null, root, send, attention, now: 1000000 });
    assert.equal(first.delivered, true);
    assert.match(first.text, /требуют хода 2/u);
    assert.equal(sent.length, 1, 'одна отправка на доставку');
    assert.deepEqual(readDigestState(root), { total: 2, at: 1000000 }, 'состояние в сторе корня');
    assert.ok(fs.existsSync(path.join(storeDir(root), DIGEST_FILE)));
    const state = JSON.parse(fs.readFileSync(digestFile(root), 'utf8'));
    assert.deepEqual(Object.keys(state).sort(), ['at', 'total'], 'состояние — ровно { total, at }');
    const second = await deliverExchangeDigest({ runtime: null, root, send, attention, now: 1001000 });
    assert.equal(second.delivered, false, 'тот же счёт в троттлинге не доставлен');
    assert.equal(sent.length, 1);
    const third = await deliverExchangeDigest({
      runtime: null,
      root,
      send,
      attention: { total: 3, stale: 0, folders: [{ id: 'folder-1', attention: 3 }] },
      now: 1002000,
    });
    assert.equal(third.delivered, true, 'рост доставлен сразу');
    assert.equal(sent.length, 2);
    assert.deepEqual(readDigestState(root), { total: 3, at: 1002000 });
  });
});

await test('0104 deliverExchangeDigest: тот же счёт после троттлинга — напоминание', async () => {
  await withStore(async () => {
    const root = project();
    const sent = [];
    const attention = { total: 1, folders: [{ id: 'folder-1', attention: 1 }] };
    const send = async (text) => { sent.push(text); };
    await deliverExchangeDigest({ runtime: null, root, send, attention, now: 1000000 });
    const later = await deliverExchangeDigest({
      runtime: null, root, send, attention, now: 1000000 + DIGEST_THROTTLE_MS,
    });
    assert.equal(later.delivered, true);
    assert.equal(sent.length, 2);
  });
});

await test('0104 deliverExchangeDigest: при нуле молчит и состояние не трогает', async () => {
  await withStore(async () => {
    const root = project();
    let called = 0;
    const result = await deliverExchangeDigest({
      runtime: null, root, send: async () => { called += 1; },
      attention: { total: 0, stale: 0, folders: [] }, now: 1000000,
    });
    assert.equal(result.delivered, false);
    assert.equal(called, 0, 'send не вызван при 0');
    assert.equal(fs.existsSync(digestFile(root)), false, 'состояния при 0 нет');
    /* Уже сказанное не стирается нулём: состояние остаётся прежним (D2). */
    writeDigestState(root, { total: 2, at: 1000000 });
    await deliverExchangeDigest({ runtime: null, root, send: async () => { called += 1; }, attention: { total: 0 }, now: 1005000 });
    assert.deepEqual(readDigestState(root), { total: 2, at: 1000000 });
    assert.equal(called, 0);
  });
});

await test('0104 deliverExchangeDigest: упавшая доставка состояние не двигает', async () => {
  await withStore(async () => {
    const root = project();
    const attention = { total: 2, folders: [{ id: 'folder-1', attention: 2 }] };
    await assert.rejects(
      deliverExchangeDigest({ runtime: null, root, send: async () => { throw new Error('нет сессии'); }, attention, now: 1000000 }),
      /нет сессии/u,
    );
    assert.equal(fs.existsSync(digestFile(root)), false, 'новость не съедена: состояния нет');
    const retry = await deliverExchangeDigest({ runtime: null, root, send: async () => {}, attention, now: 1001000 });
    assert.equal(retry.delivered, true, 'следующая попытка доставляет');
  });
});

await test('0104 deliverExchangeDigest: сбой записи стора не превращается в поток повторов', async () => {
  const previousStore = process.env.DSH_PROJECT_GRAPH_STORE;
  /* Стор — файл, а не каталог: запись состояния обязана упасть, доставка — нет. */
  const storeAsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-digest-store-bad-')), 'store-file');
  fs.writeFileSync(storeAsFile, 'не каталог');
  process.env.DSH_PROJECT_GRAPH_STORE = storeAsFile;
  try {
    const root = project();
    const attention = { total: 2, folders: [{ id: 'folder-1', attention: 2 }] };
    const sent = [];
    const first = await deliverExchangeDigest({
      runtime: null, root, send: async (text) => { sent.push(text); }, attention, now: 1000000,
    });
    assert.equal(first.delivered, true, 'доставка состоялась');
    assert.match(String(first.error), /состояние не записано/u, 'сбой записи назван');
    const second = await deliverExchangeDigest({
      runtime: null, root, send: async (text) => { sent.push(text); }, attention, now: 1001000,
    });
    assert.equal(second.delivered, false, 'память процесса держит троттлинг без файла');
    assert.equal(sent.length, 1);
    const growth = await deliverExchangeDigest({
      runtime: null,
      root,
      send: async (text) => { sent.push(text); },
      attention: { total: 3, folders: [{ id: 'folder-1', attention: 3 }] },
      now: 1002000,
    });
    assert.equal(growth.delivered, true, 'рост доставляется и при недоступном сторе');
    assert.equal(sent.length, 2);
  } finally {
    if (previousStore === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previousStore;
  }
});

await test('0104 deliverExchangeDigest: send {sent:false} — «некому», состояние не двигается', async () => {
  await withStore(async () => {
    const root = project();
    const attention = { total: 2, folders: [{ id: 'folder-1', attention: 2 }] };
    const skipped = await deliverExchangeDigest({
      runtime: null, root, send: async () => ({ sent: false, reason: 'no-session' }), attention, now: 1000000,
    });
    assert.equal(skipped.delivered, false);
    assert.equal(skipped.reason, 'no-session');
    assert.equal(fs.existsSync(digestFile(root)), false);
    /* Причины отказа доезжают до журнала: «не доставлено» без причины — тупик. */
    const refused = await deliverExchangeDigest({
      runtime: null,
      root,
      send: async () => ({ sent: false, reason: 'refused', reasons: ['session-live: owned by subagent routing'] }),
      attention,
      now: 1000000,
    });
    assert.equal(refused.reason, 'refused');
    assert.deepEqual(refused.reasons, ['session-live: owned by subagent routing']);
    assert.equal(fs.existsSync(digestFile(root)), false);
  });
});

await test('0104 deliverExchangeDigest: внимание считается по ящику, когда не передано', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph() });
    writeLetter(root, 'threads/critic-report/01.md', REQUEST());
    const sent = [];
    const result = await deliverExchangeDigest({ runtime: null, root, send: async (text) => { sent.push(text); } });
    assert.equal(result.delivered, true, 'заявка в ящике — повод сказать');
    assert.match(result.text, /требуют хода 1/u);
    assert.match(result.text, /folder-1 1/u);
    assert.equal(sent.length, 1);
    assert.deepEqual(readDigestState(root), { total: 1, at: readDigestState(root).at });
  });
});

await test('0104 deliverExchangeDigest: без структуры — тишина, а не падение', async () => {
  await withStore(async () => {
    const root = project();
    const result = await deliverExchangeDigest({ runtime: null, root, send: async () => { throw new Error('не должно вызываться'); } });
    assert.equal(result.delivered, false);
  });
});

/* ------------------------------------------------------------------ */
/* sendDigestToSession: доставка в живую сессию                        */
/* ------------------------------------------------------------------ */

await test('0104 sendDigestToSession: sessionController.prompt с mode queue — первый путь', async () => {
  const root = project();
  const calls = [];
  const controller = { async prompt(request) { calls.push(request); } };
  const sessions = new Map([['session-old', 100], ['session-live', 200]]);
  const result = await sendDigestToSession({
    root,
    text: 'требуют хода 1; проверка: node tools/check-exchange.mjs',
    sessions,
    now: 300,
    getSessionController: () => controller,
    getAgents: () => [],
  });
  assert.equal(result.sent, true);
  assert.equal(result.via, 'session');
  assert.equal(result.sessionId, 'session-live', 'свежайшая сессия корня');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'session-live');
  assert.equal(calls[0].mode, 'queue', 'сообщение в очередь сессии, не новый запуск');
  assert.deepEqual(calls[0].content, [{ type: 'text', text: 'требуют хода 1; проверка: node tools/check-exchange.mjs' }]);
  assert.match(String(calls[0].requestId), /^digest:/u);
});

await test('0104 sendDigestToSession: отказ «owned by subagent» передаёт ход следующей сессии', async () => {
  const root = project();
  const tried = [];
  const controller = {
    async prompt(request) {
      tried.push(request.sessionId);
      if (request.sessionId === 'session-live') throw new Error('session is owned by subagent routing');
    },
  };
  const result = await sendDigestToSession({
    root,
    text: 'требуют хода 1',
    sessions: new Map([['session-live', 200], ['session-operator', 100]]),
    now: 300,
    getSessionController: () => controller,
    getAgents: () => [],
  });
  assert.equal(result.sent, true);
  assert.equal(result.sessionId, 'session-operator');
  assert.deepEqual(tried, ['session-live', 'session-operator']);
});

await test('0104 sendDigestToSession: запасной путь — handle.sendMessage живого агента', async () => {
  const root = project();
  const received = [];
  const handle = { cwd: root, sessionId: 'session-live', async sendMessage({ text }) { received.push(text); } };
  const result = await sendDigestToSession({
    root,
    text: 'требуют хода 2',
    sessions: new Map(),
    now: 300,
    getSessionController: () => null,
    getAgents: () => ({ roots: () => [handle] }),
  });
  assert.equal(result.sent, true);
  assert.equal(result.via, 'agent');
  assert.deepEqual(received, ['требуют хода 2']);
});

await test('0104 sendDigestToSession: некому — { sent:false, reason:no-session }', async () => {
  const root = project();
  const result = await sendDigestToSession({
    root,
    text: 'требуют хода 1',
    sessions: new Map(),
    now: 300,
    getSessionController: () => null,
    getAgents: () => [],
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'no-session');
});

await test('0104 sendDigestToSession: пустая строка не будит сессию', async () => {
  const result = await sendDigestToSession({ root: project(), text: '   ', getSessionController: () => null });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'empty');
});

/* ------------------------------------------------------------------ */
/* Проводка: тик планировщика зовёт дайджест                           */
/* ------------------------------------------------------------------ */

await test('0104 apply: тик планировщика доставляет дайджест в живую сессию корня', async () => {
  await withStore(async (store) => {
    const root = project({ 'graph.json': graph() });
    writeLetter(root, 'threads/critic-report/01.md', REQUEST());
    const received = [];
    const handle = {
      cwd: root,
      sessionId: 'session-live',
      async sendMessage({ text }) { received.push(text); },
    };
    const ctx = {
      inject(names, callback) {
        if (names.every((name) => name in ctx)) callback(ctx);
      },
      tools: { register() { return () => {}; } },
      subagents: {
        getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true } }),
        async startActivation() { return { childId: 'child-digest' }; },
      },
      agents: { roots: () => [handle], list: () => [handle] },
      webServer: { register() { return () => {}; } },
      on() {},
      effect(fn) { return fn(); },
      logger: { warn() {} },
    };
    apply(ctx, { roots: [root], exchangeWatch: false });
    const file = path.join(store, DIGEST_FILE);
    /* Первый тик стартует сразу при apply; ждём факт, а не сон на угад. */
    for (let attempt = 0; attempt < 300 && !fs.existsSync(file); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(file), 'тик планировщика записал состояние дайджеста');
    const digestLines = received.filter((text) => /требуют хода/u.test(text));
    assert.equal(digestLines.length, 1, 'доставка одна: ' + JSON.stringify(received));
    assert.match(digestLines[0], /требуют хода 1/u);
    assert.match(digestLines[0], /check-exchange/u);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(state.total, 1);
    assert.equal(typeof state.at, 'number');
  });
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(String(failure.error && failure.error.stack ? failure.error.stack : failure.error));
  }
  console.error('DIGEST TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('DIGEST TEST OK: ' + passed + '/' + passed);
