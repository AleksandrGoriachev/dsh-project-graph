#!/usr/bin/env node
/**
 * 0292 — действие «Разобрать»: mark точечно, wake живой сессии, видимость по unread.
 *
 * Набор проверяет поведение, а не текст:
 *   - unreadResolveActions(0) не показывает действие, unread > 0 — показывает ДВА
 *     явных действия mark/wake, ни одно не выполняется само;
 *   - POST /api/exchange/mark {letters:[...]} отмечает РОВНО перечисленные письма,
 *     соседние остаются непрочитанными;
 *   - POST /api/exchange/wake будит сессию из свежего presence (reason: presence);
 *   - без сессии/служб wake честно отвечает woken:false, а не выдумывает цель.
 *
 *   node test/exchange-unread-actions.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/*
 * Дом подменяется до импорта: следы стенда не имеют права попадать в живой ~/.dsh.
 * Импорт api.js и exchange-watch.js идёт ниже, после подмены.
 */
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-actions-home-'));
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;
process.env.DSH_PROFILE_DIR = path.join(isolatedHome, 'profile');
delete process.env.DSH_PROFILE;

const { createGraphRuntime, createWebHandler, API_PREFIX } = await import('../lib/api.js');
const { writeSessionPresence } = await import('../lib/exchange-watch.js');
const { exchangeAttention } = await import('../lib/obligations.js');

let passed = 0;
const failures = [];
async function test(name, body) {
  try {
    await body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : error));
  }
}

/** Ответ обмена с одним счётом unread — так его отдаёт /api/exchange. */
function exchangeBody(total) {
  return { unread: { total, stale: 0 } };
}

/** Классический браузерный бандл грузится тем же загрузчиком, что у DSH. */
function loadClientBundle() {
  const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');
  let registered = null;
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry; } } };
  const sandboxRequire = (id) => {
    if (id === 'react') {
      return {
        createElement: () => null,
        Component: class Component { constructor(props) { this.props = props; this.state = {}; } setState() {} },
      };
    }
    throw new Error('unexpected require: ' + id);
  };
  new Function('window', source)(window);
  assert.ok(registered, 'бандл зарегистрировался в загрузчике модулей');
  return registered.factory(sandboxRequire);
}

async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-actions-store-')), 'store');
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

/*
 * Стенд R2: хранилище прочтения — per-root (lib/store.js:71-77). Общий store из
 * DSH_PROJECT_GRAPH_STORE скрыл бы дефект, поэтому переменная снимается, а корни
 * получают каждый свой store под изолированным домом.
 */
async function withPerRootStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  delete process.env.DSH_PROJECT_GRAPH_STORE;
  try {
    return await body();
  } finally {
    if (previous !== undefined) process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

/** Временный проект с объявленной папкой обмена (как в test/exchange-scan.test.mjs). */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-actions-root-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'coordination'), { recursive: true });
  const graph = {
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      exchange: { threads: ['critic-report'] },
      participants: ['structure', 'workflow'],
      orchestrator: 'coordinator',
    }],
    obligations: [{ id: 'exchange-read', title: 'разобрать входящие', check: { kind: 'exchange-unread', max: 0 }, enforce: 'warn' }],
  };
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
  return dir;
}

/**
 * Проект с двумя ящиками и побайтовой копией одного письма в каждом (задание
 * 0322): так письмо задваивалось после принятия folder-2.
 */
function twinProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0292-actions-twin-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  const folder = (id, box) => ({
    id,
    box: { path: box, root: 'workspace' },
    exchange: { threads: ['critic-report'] },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
  });
  const graph = {
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [folder('folder-1', 'coordination'), folder('folder-2', 'coordination2')],
    obligations: [{ id: 'exchange-read', title: 'разобрать входящие', check: { kind: 'exchange-unread', max: 0 }, enforce: 'warn' }],
  };
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
  for (const box of ['coordination', 'coordination2']) {
    const file = path.join(dir, box, 'threads', 'critic-report', 'letter-01.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, LETTER('одно письмо в двух ящиках'));
  }
  return dir;
}

/* Задание 0325: внимание считает заявки (request/question), а не отчёты. */
const REQUEST_DATE = new Date().toISOString();
const REQUEST_LETTER = (subject = 'заявка', body = 'тело заявки') => 'Format: dsh-exchange/1\n'
  + 'From: workflow\nTo: structure\nDate: ' + REQUEST_DATE + '\nThread: critic-report\nStatus: request\n'
  + 'Subject: ' + subject + '\n\n' + body + '\n';

const LETTER = (subject) => 'Format: dsh-exchange/1\n'
  + 'From: workflow\nTo: structure\nDate: 2026-11-05T01:00:00+03:00\nThread: critic-report\nStatus: report\n'
  + 'Subject: ' + subject + '\n\nтело письма\n';

function writeLetter(root, name) {
  const file = path.join(root, 'coordination', 'threads', 'critic-report', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, LETTER(name));
  return file;
}

/** Вызов маршрута теми же моками, что test/api.test.mjs. */
function call(handler, url, options = {}) {
  const res = {
    status: 0,
    body: null,
    writableEnded: false,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(String(body)); this.writableEnded = true; },
  };
  const req = {
    method: options.method || 'GET',
    url,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) {
      if (event === 'data' && options.body !== undefined) fn(Buffer.from(String(options.body)));
      if (event === 'end') fn();
    },
  };
  return Promise.resolve(handler(req, res)).then(() => res);
}

const handlerFor = (runtime) => createWebHandler(runtime);

/* ------------------------------------------------------------------ */
/* C3: «Разобрать» только при unread > 0, два явных действия           */
/* ------------------------------------------------------------------ */
await test('0292 c3: unreadResolveActions — visible только при unread > 0, действия mark/wake', async () => {
  const module = loadClientBundle();
  assert.equal(typeof module.unreadResolveActions, 'function', 'функция экспортируется из панели');
  const none = module.unreadResolveActions(0);
  assert.equal(none.visible, false, 'при 0 «Разобрать» недоступно');
  assert.ok(Array.isArray(none.actions), 'состав действий не теряется');
  const some = module.unreadResolveActions(3);
  assert.equal(some.visible, true, 'при unread > 0 «Разобрать» доступно');
  const ids = some.actions.map((item) => item && item.id);
  assert.deepEqual(ids.slice().sort(), ['mark', 'wake'], 'ровно два действия: mark и wake');
  for (const item of some.actions) {
    assert.match(item.path, /^\/api\/exchange\/(mark|wake)$/u, 'путь действия ' + item.id + ' — свой маршрут exchange');
  }
});

await test('0292 c3: панель показывает «Разобрать» и зовёт оба маршрута после скана', async () => {
  const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');
  assert.match(source, /unreadResolveActions/u, 'панель рисует по модели действий');
  assert.match(source, /Разобрать/u, 'подпись «Разобрать» есть');
  assert.match(source, /\/api\/exchange\/mark/u, 'кнопка отметки зовёт mark');
  assert.match(source, /\/api\/exchange\/wake/u, 'кнопка пробуждения зовёт wake');
  assert.match(source, /exchangeScanUnread\.length > 0/u, 'показ привязан к unread > 0');
  assert.match(source, /scanExchangeBoxes\(\)/u, 'после действия скан повторяется');
});

/* ------------------------------------------------------------------ */
/* C3: mark отмечает ровно перечисленные письма                        */
/* ------------------------------------------------------------------ */
await test('0292 c3: POST /api/exchange/mark {letters} снимает только указанное письмо', async () => {
  await withStore(async () => {
    const root = project();
    const handler = handlerFor(createGraphRuntime({ roots: [root] }));
    const first = writeLetter(root, 'letter-1.md');
    const second = writeLetter(root, 'letter-2.md');
    const before = await call(handler, API_PREFIX + '/api/exchange/scan');
    assert.equal(before.status, 200);
    assert.equal(before.body.unread.length, 2, 'скан видит два письма');

    const marked = await call(handler, API_PREFIX + '/api/exchange/mark?root=' + encodeURIComponent(root), {
      method: 'POST',
      body: JSON.stringify({ letters: [first] }),
    });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.ok, true);
    assert.equal(marked.body.marked, 1, 'отмечено ровно одно письмо');
    assert.equal(marked.body.skipped, 0, 'пропущенных нет');

    const after = await call(handler, API_PREFIX + '/api/exchange/scan');
    assert.equal(after.body.unread.length, 1, 'соседнее письмо осталось непрочитанным');
    assert.equal(after.body.unread[0].path, second, 'непрочитанным осталось ИМЕННО соседнее');

    const unknown = await call(handler, API_PREFIX + '/api/exchange/mark?root=' + encodeURIComponent(root), {
      method: 'POST',
      body: JSON.stringify({ letters: [path.join(root, 'нет-такого.md')] }),
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.marked, 0, 'несуществующее письмо не отмечено');
    assert.equal(unknown.body.skipped, 1, 'оно названо пропущенным');
  });
});

await test('0292 c3: POST /api/exchange/mark с пустым letters — 400 с рецептом', async () => {
  await withStore(async () => {
    const root = project();
    const handler = handlerFor(createGraphRuntime({ roots: [root] }));
    const res = await call(handler, API_PREFIX + '/api/exchange/mark', {
      method: 'POST',
      body: JSON.stringify({ letters: [] }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'bad-request');
    assert.ok(res.body.error && res.body.fix, 'есть причина и рецепт');
  });
});

/* ------------------------------------------------------------------ */
/* R2: mark пишет в хранилище СВОЕГО проекта, а не в roots[0]          */
/* ------------------------------------------------------------------ */
await test('0292 R2: mark с root проекта B меняет store B, store A не трогает', async () => {
  await withPerRootStore(async () => {
    const rootA = project();
    const rootB = project();
    const handler = handlerFor(createGraphRuntime({ roots: [rootA, rootB] }));
    const letterA = writeLetter(rootA, 'a-1.md');
    const letterB = writeLetter(rootB, 'b-1.md');
    const scanA = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootA));
    const scanB = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootB));
    assert.equal(scanA.body.unread.length, 1, 'скан A видит письмо A');
    assert.equal(scanB.body.unread.length, 1, 'скан B видит письмо B');

    const marked = await call(handler, API_PREFIX + '/api/exchange/mark?root=' + encodeURIComponent(rootB), {
      method: 'POST',
      body: JSON.stringify({ letters: [letterB] }),
    });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.ok, true);
    assert.equal(marked.body.marked, 1, 'отмечено письмо проекта B');

    const afterB = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootB));
    assert.deepEqual(afterB.body.unread, [], 'store B изменился: письмо B прочитано');
    const afterA = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootA));
    assert.equal(afterA.body.unread.length, 1, 'store A не изменился: письмо A непрочитано');
    assert.equal(afterA.body.unread[0].path, letterA, 'непрочитанным осталось именно письмо A');
  });
});

await test('0292 R2: mark принимает root из тела (как wake), store B меняется', async () => {
  await withPerRootStore(async () => {
    const rootA = project();
    const rootB = project();
    const handler = handlerFor(createGraphRuntime({ roots: [rootA, rootB] }));
    writeLetter(rootA, 'a-1.md');
    const letterB = writeLetter(rootB, 'b-1.md');
    const marked = await call(handler, API_PREFIX + '/api/exchange/mark', {
      method: 'POST',
      body: JSON.stringify({ root: rootB, letters: [letterB] }),
    });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.marked, 1);
    const afterB = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootB));
    assert.deepEqual(afterB.body.unread, [], 'письмо B отмечено в своём store');
    const afterA = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootA));
    assert.equal(afterA.body.unread.length, 1, 'store A не тронут');
  });
});

await test('0292 R2: mark {letters} без root — 400 no-root, чужой store не угадывается', async () => {
  await withPerRootStore(async () => {
    const rootA = project();
    const rootB = project();
    const handler = handlerFor(createGraphRuntime({ roots: [rootA, rootB] }));
    writeLetter(rootA, 'a-1.md');
    const letterB = writeLetter(rootB, 'b-1.md');
    const res = await call(handler, API_PREFIX + '/api/exchange/mark', {
      method: 'POST',
      body: JSON.stringify({ letters: [letterB] }),
    });
    assert.equal(res.status, 400, 'без корня адрес хранилища неизвестен');
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'no-root');
    assert.ok(res.body.error && res.body.fix, 'есть причина и рецепт');
    const afterB = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootB));
    assert.equal(afterB.body.unread.length, 1, 'письмо B не отмечено ни в store A, ни в store B');
  });
});

await test('0292 R2: прежняя форма {paths} без root находит свой проект по путям (0077)', async () => {
  await withPerRootStore(async () => {
    const rootA = project();
    const rootB = project();
    const handler = handlerFor(createGraphRuntime({ roots: [rootA, rootB] }));
    writeLetter(rootA, 'a-1.md');
    const letterB = writeLetter(rootB, 'b-1.md');
    const marked = await call(handler, API_PREFIX + '/api/exchange/mark', {
      method: 'POST',
      body: JSON.stringify({ paths: [letterB] }),
    });
    assert.equal(marked.status, 200, 'обратная совместимость с панелью 0077 сохранена');
    assert.equal(marked.body.marked, 1);
    const afterB = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootB));
    assert.deepEqual(afterB.body.unread, [], 'путь сам указывает на store B');
    const afterA = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootA));
    assert.equal(afterA.body.unread.length, 1, 'store A не тронут');
  });
});

/* ------------------------------------------------------------------ */
/* R7: явный root сверяется с письмами, чужой store не трогается       */
/* ------------------------------------------------------------------ */
await test('0292 R7: mark?root=B с письмом проекта A — 400, store A/B не меняются', async () => {
  await withPerRootStore(async () => {
    const rootA = project();
    const rootB = project();
    const handler = handlerFor(createGraphRuntime({ roots: [rootA, rootB] }));
    const letterA = writeLetter(rootA, 'a-1.md');
    const letterB = writeLetter(rootB, 'b-1.md');
    const beforeA = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootA));
    const beforeB = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootB));
    assert.equal(beforeA.body.unread.length, 1, 'скан A видит письмо A');
    assert.equal(beforeB.body.unread.length, 1, 'скан B видит письмо B');

    const marked = await call(handler, API_PREFIX + '/api/exchange/mark?root=' + encodeURIComponent(rootB), {
      method: 'POST',
      body: JSON.stringify({ letters: [letterA] }),
    });
    assert.equal(marked.status, 400, 'письмо чужого проекта не отмечается');
    assert.equal(marked.body.ok, false, 'ложного успеха нет');
    assert.equal(marked.body.code, 'root-mismatch', 'причина — письмо вне названного корня');
    assert.equal(marked.body.marked, 0, 'ни одно письмо не отмечено');
    assert.equal(marked.body.skipped, 1, 'чужое письмо названо пропущенным');
    assert.ok(marked.body.error && marked.body.fix, 'есть причина и рецепт');

    const viaBody = await call(handler, API_PREFIX + '/api/exchange/mark', {
      method: 'POST',
      body: JSON.stringify({ root: rootB, letters: [letterA] }),
    });
    assert.equal(viaBody.status, 400, 'root из тела сверяется с письмами так же, как query');
    assert.equal(viaBody.body.code, 'root-mismatch');

    const mixed = await call(handler, API_PREFIX + '/api/exchange/mark?root=' + encodeURIComponent(rootB), {
      method: 'POST',
      body: JSON.stringify({ letters: [letterB, letterA] }),
    });
    assert.equal(mixed.status, 400, 'смешанный набор отклоняется целиком, а не наполовину');
    assert.equal(mixed.body.marked, 0, 'частичной записи в store B нет');

    const afterA = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootA));
    assert.equal(afterA.body.unread.length, 1, 'store A не изменился');
    assert.equal(afterA.body.unread[0].path, letterA, 'письмо A по-прежнему непрочитано');
    const afterB = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(rootB));
    assert.equal(afterB.body.unread.length, 1, 'store B не изменился');
    assert.equal(afterB.body.unread[0].path, letterB, 'письмо B не отмечено чужим запросом');

    const correct = await call(handler, API_PREFIX + '/api/exchange/mark?root=' + encodeURIComponent(rootB), {
      method: 'POST',
      body: JSON.stringify({ letters: [letterB] }),
    });
    assert.equal(correct.status, 200, 'согласованный вызов по-прежнему работает');
    assert.equal(correct.body.marked, 1);
  });
});

/* ------------------------------------------------------------------ */
/* 0322: отметка одной копии снимает все побайтовые копии              */
/* ------------------------------------------------------------------ */
await test('0322: check-exchange видит одну копию, --mark одной снимает все — 0', async () => {
  await withStore(async () => {
    const root = twinProject();
    const cli = path.join(path.resolve(here, '..'), 'tools', 'check-exchange.mjs');
    const run = (args) => spawnSync(process.execPath, [cli, '--root', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    const first = run([]);
    assert.equal(first.status, 1, 'копии — одно непрочитанное, код 1: ' + first.stdout);
    assert.match(first.stdout, /непрочитано: 1\b/u, 'копии считаются одним письмом: ' + first.stdout);

    const scan = await call(handlerFor(createGraphRuntime({ roots: [root] })), API_PREFIX + '/api/exchange/scan');
    assert.equal(scan.status, 200);
    assert.equal(scan.body.unread.length, 1, 'скан отдаёт единственный путь для отметки');

    const marked = run(['--mark', scan.body.unread[0].path]);
    assert.equal(marked.status, 0, 'отметка одной копии прошла: ' + marked.stdout + marked.stderr);

    const again = run([]);
    assert.equal(again.status, 0, 'после отметки непрочитанных нет: ' + again.stdout);
    assert.match(again.stdout, /непрочитано: 0\b/u, 'все копии сняты одной отметкой: ' + again.stdout);
  });
});

/* ------------------------------------------------------------------ */
/* 0325: внимание дедуплицирует копии, answer снимает все копии        */
/* ------------------------------------------------------------------ */
await test('0325: внимание считает побайтовые копии один раз; answer на одну снимает все', async () => {
  await withStore(async () => {
    const root = twinProject();
    const box1 = path.join(root, 'coordination', 'threads', 'critic-report', 'letter-01.md');
    const box2 = path.join(root, 'coordination2', 'threads', 'critic-report', 'letter-01.md');
    const request = REQUEST_LETTER();
    fs.writeFileSync(box1, request);
    fs.writeFileSync(box2, request);
    let attention = exchangeAttention({ root });
    assert.equal(attention.total, 1, 'две копии одной заявки — одна: ' + JSON.stringify(attention.items));
    assert.equal(attention.items.length, 1, 'items тоже называет одну заявку');
    assert.equal(attention.items[0].path, box1, 'строка называет первую копию (тот же ящик, что folder-1)');
    assert.deepEqual(attention.folders.map((row) => [row.id, row.attention]), [['folder-1', 1], ['folder-2', 0]],
      'копия впервые попала в folder-1, сумма папок равна total');
    const scan = await call(handlerFor(createGraphRuntime({ roots: [root] })), API_PREFIX + '/api/exchange/scan');
    assert.equal(scan.body.unread.length, attention.total, 'unread и attention на одном наборе совпадают');

    const otherBody = path.join(root, 'coordination2', 'threads', 'critic-report', 'letter-02.md');
    fs.writeFileSync(otherBody, REQUEST_LETTER('заявка', 'другое тело'));
    attention = exchangeAttention({ root });
    assert.equal(attention.total, 2, 'разные тела — разные заявки: ' + JSON.stringify(attention.items));

    fs.rmSync(otherBody, { force: true });
    const answer = 'Format: dsh-exchange/1\nFrom: structure\nTo: workflow\nDate: 2026-11-05T02:00:00+03:00\nThread: critic-report\nStatus: answer\nReply-To: letter-01.md\nSubject: Re: заявка\n\nответ\n';
    fs.writeFileSync(path.join(root, 'coordination', 'threads', 'critic-report', 'answer.md'), answer);
    attention = exchangeAttention({ root });
    assert.equal(attention.total, 0, 'answer на одну копию закрыл все: ' + JSON.stringify(attention.items));
    assert.deepEqual(attention.items, [], 'открытых заявок не осталось');
  });
});

/* ------------------------------------------------------------------ */
/* C3: wake будит сессию из presence; без сессии — честный отказ       */
/* ------------------------------------------------------------------ */
await test('0292 c3: POST /api/exchange/wake будит сессию presence', async () => {
  const root = project();
  writeSessionPresence({ root, workspace: path.basename(root), sessionId: 'session-panel-wake' });
  const prompted = [];
  const runtime = createGraphRuntime({ roots: [root] }, {
    getAgents: () => ({ list: () => [] }),
    getSessionController: () => ({
      async prompt(request) { prompted.push(request.sessionId); return { ok: true }; },
    }),
  });
  const res = await call(handlerFor(runtime), API_PREFIX + '/api/exchange/wake', {
    method: 'POST',
    body: JSON.stringify({ root }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.woken, true, 'сессия разбужена');
  assert.equal(res.body.reason, 'presence', 'цель названа presence');
  assert.equal(res.body.target, 'session-panel-wake');
  assert.deepEqual(prompted, ['session-panel-wake'], 'пробуждение ушло именно той сессии');
});

await test('0292 c3: POST /api/exchange/wake без сессии отвечает woken:false', async () => {
  const root = project();
  const runtime = createGraphRuntime({ roots: [root] });
  const res = await call(handlerFor(runtime), API_PREFIX + '/api/exchange/wake', {
    method: 'POST',
    body: JSON.stringify({ root }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.woken, false, 'цель не выдумана');
  assert.equal(res.body.reason, 'no-session', 'названа честная причина');
});

console.log(failures.length === 0
  ? 'EXCHANGE UNREAD ACTIONS OK: ' + passed + ' проверок — «Разобрать», mark точечно, wake presence'
  : 'EXCHANGE UNREAD ACTIONS FAILED: ' + failures.length + ' из ' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
