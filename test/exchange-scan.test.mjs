#!/usr/bin/env node
/**
 * Сканер обмена: HTTP-маршруты и отметка прочитанного (задание 0077).
 *
 * Набор доказывает обещания контракта: GET /api/exchange/scan отдаёт
 * непрочитанные письма выбранного корня и обязанности структуры; POST
 * /api/exchange/mark снимает ровно перечисленные письма; пустой или битый
 * список путей — отказ 400 с рецептом, а не «ok: true, marked: 0»; отметки
 * живут в хранилище, а в репозиторий ничего не пишется.
 *
 * Каждый тест получает свой DSH_PROJECT_GRAPH_STORE: следы одного набора не
 * должны влиять на другой и на живой ~/.dsh.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphRuntime, createWebHandler, API_PREFIX } from '../lib/api.js';
import { exchangeAttention } from '../lib/obligations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(path.resolve(here, '..'), 'tools', 'check-exchange.mjs');

async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  /* Каталог хранилища не создаётся заранее: проект без отметок — обычный случай. */
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-exchange-scan-store-')), 'store');
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
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : error));
  }
}

/**
 * Временный проект со структурой и папкой обмена. `folderExtra` — объект
 * полей папки или функция от корня (нужна, когда paths ссылаются на сам корень).
 */
function project(folderExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-exchange-scan-root-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  /*
   * Задание 0280 (A4): объявленная папка, которой НЕТ на диске, — сломанное
   * объявление, и обязанность обязана провалиться. Пустой ящик — это
   * существующий каталог без писем: фикстура создаёт его, чтобы тест «без
   * писем» проверял пустоту, а не отсутствие папки.
   */
  fs.mkdirSync(path.join(dir, 'coordination'), { recursive: true });
  const folder = {
    id: 'folder-1',
    box: { path: 'coordination', root: 'workspace' },
    exchange: { threads: ['critic-report'] },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    ...(typeof folderExtra === 'function' ? folderExtra(dir) : folderExtra),
  };
  const graph = {
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор', provider: 'probe', model: 'probe-1' }],
    edges: [],
    folders: [folder],
    obligations: [{ id: 'exchange-read', title: 'разобрать входящие', check: { kind: 'exchange-unread', max: 0 }, enforce: 'warn' }],
  };
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
  return dir;
}

const LETTER = (to, subject = 'тема', from = 'workflow', date = '2026-11-05T01:00:00+03:00') => 'Format: dsh-exchange/1\n'
  + 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nThread: critic-report\nStatus: report\n'
  + 'Subject: ' + subject + '\n\nтело письма, которое сканер не читает\n';

/** Задание 0325: заявка — то, что попадает в счёт внимания (request/question). */
const REQUEST_DATE = new Date().toISOString();
const REQUEST_LETTER = (subject = 'заявка', body = 'тело заявки') => 'Format: dsh-exchange/1\n'
  + 'From: workflow\nTo: structure\nDate: ' + REQUEST_DATE + '\nThread: critic-report\nStatus: request\n'
  + 'Subject: ' + subject + '\n\n' + body + '\n';

/** Положить письмо в ящик папки; возвращает абсолютный путь. */
function writeLetter(root, name, text) {
  const file = path.join(root, 'coordination', 'threads', 'critic-report', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** Положить письмо в названный ящик: у twin-проекта их два (задание 0322). */
function writeLetterAt(root, box, name, text) {
  const file = path.join(root, box, 'threads', 'critic-report', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/**
 * Проект с ДВУМЯ ящиками и побайтовой копией одного письма в каждом (0322).
 * Так выглядит общий ящик хаба и папка воркспейса, куда письмо продублировалось.
 */
function twinProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-exchange-scan-twin-'));
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
    nodes: [{ id: 'coordinator', role: 'координатор', provider: 'probe', model: 'probe-1' }],
    edges: [],
    folders: [folder('folder-1', 'coordination'), folder('folder-2', 'coordination2')],
    obligations: [{ id: 'exchange-read', title: 'разобрать входящие', check: { kind: 'exchange-unread', max: 0 }, enforce: 'warn' }],
  };
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
  for (const box of ['coordination', 'coordination2']) {
    writeLetterAt(dir, box, 'letter-01.md', LETTER('structure', 'одно письмо в двух ящиках'));
  }
  return dir;
}

/** Вызов маршрута теми же моками, что test/api.test.mjs и test/obligations.test.mjs. */
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

function handlerFor(root) {
  return createWebHandler(createGraphRuntime({ roots: [root] }));
}

function scan(handler) {
  return call(handler, API_PREFIX + '/api/exchange/scan');
}

function mark(handler, body) {
  return call(handler, API_PREFIX + '/api/exchange/mark', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
}

/** Все файлы проекта — доказательство того, что репозиторий не тронут. */
function repoFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out;
}

await test('GET /api/exchange/scan: без писем — ok:true, unread пуст, обязанность выполнена', async () => {
  await withStore(async () => {
    const root = project();
    const res = await scan(handlerFor(root));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.unread, []);
    assert.equal(res.body.seen, 0);
    assert.deepEqual(res.body.skipped, []);
    assert.equal(res.body.boxes.length, 1);
    assert.equal(res.body.boxes[0].id, 'folder-1');
    /* Своя метка — первый участник папки, как и в сканере lib/obligations.js. */
    assert.equal(res.body.boxes[0].me, 'structure');
    assert.ok(Array.isArray(res.body.obligations), 'obligations — массив');
    const duty = res.body.obligations.find((row) => row.id === 'exchange-read');
    assert.ok(duty, 'обязанность exchange-read в ответе');
    assert.equal(duty.ok, true);
    assert.match(duty.detail, /непрочитано 0/u);
  });
});

await test('GET /api/exchange/scan: письмо этому воркспейсу — unread с датой, темой и путём', async () => {
  await withStore(async () => {
    const root = project();
    const letter = writeLetter(root, '2026-11-05T01-00+03-00--workflow--01.md', LETTER('structure', 'наше письмо'));
    writeLetter(root, '2026-11-05T01-05+03-00--workflow--02.md', LETTER('workflow', 'чужое письмо'));
    const res = await scan(handlerFor(root));
    assert.equal(res.status, 200);
    assert.equal(res.body.unread.length, 1);
    assert.equal(res.body.unread[0].path, letter);
    assert.equal(res.body.unread[0].to, 'structure');
    assert.equal(res.body.unread[0].date, '2026-11-05T01:00:00+03:00');
    assert.equal(res.body.unread[0].subject, 'наше письмо');
    assert.equal(res.body.skipped.length, 1, 'чужое письмо не считается непрочитанным, а названо в skipped');
    const duty = res.body.obligations.find((row) => row.id === 'exchange-read');
    assert.equal(duty.ok, false, 'непрочитанное письмо делает обязанность невыполненной');
    assert.match(duty.detail, /непрочитано 1/u);
  });
});

await test('0322: побайтовые копии в разных ящиках — одно непрочитанное с sha256, разные письма — два', async () => {
  await withStore(async () => {
    const root = twinProject();
    const handler = handlerFor(root);
    const first = await scan(handler);
    assert.equal(first.status, 200);
    assert.equal(first.body.unread.length, 1, 'копии одного письма — одно непрочитанное');
    assert.match(String(first.body.unread[0].sha256 || ''), /^[0-9a-f]{64}$/u,
      'строка unread называет sha256 содержимого');
    assert.equal(first.body.boxes.length, 2, 'оба ящика в ответе');
    assert.equal(first.body.boxes[0].unread, 1, 'счётчик ящика считает своё письмо');
    assert.equal(first.body.boxes[1].unread, 1, 'второй ящик тоже считает своё письмо');

    /* Та же тема и дата, но другое тело — другое письмо, а не копия. */
    writeLetterAt(root, 'coordination2', 'letter-02.md', LETTER('structure', 'одно письмо в двух ящиках') + '\nдругое тело\n');
    const second = await scan(handler);
    assert.equal(second.body.unread.length, 2, 'разные письма не склеиваются');
    assert.notEqual(second.body.unread[0].sha256, second.body.unread[1].sha256,
      'у разных писем разные хэши');
  });
});

/*
 * 0325: внимание и unread — один счёт по содержимому. Две побайтовые копии
 * одной заявки в разных ящиках дают 1, разные тела — 2, answer на копию
 * закрывает заявку целиком.
 */
await test('0325: attention дедуплицирует копии, сходится с unread и закрывается answer', async () => {
  await withStore(async () => {
    const root = twinProject();
    const first = path.join(root, 'coordination', 'threads', 'critic-report', 'letter-01.md');
    const second = path.join(root, 'coordination2', 'threads', 'critic-report', 'letter-01.md');
    const request = REQUEST_LETTER();
    fs.writeFileSync(first, request);
    fs.writeFileSync(second, request);
    const scan1 = await scan(handlerFor(root));
    let attention = exchangeAttention({ root });
    assert.equal(attention.total, 1, 'две копии заявки — одна');
    assert.equal(scan1.body.unread.length, attention.total, 'unread и attention совпадают');
    assert.match(String(scan1.body.unread[0].sha256 || ''), /^[0-9a-f]{64}$/u, 'сканер называет sha256 содержимого');
    assert.equal(attention.folders.reduce((sum, row) => sum + row.attention, 0), attention.total,
      'сумма папок равна total');
    assert.deepEqual(attention.folders.map((row) => [row.id, row.attention]), [['folder-1', 1], ['folder-2', 0]],
      'уникальное письмо попало в первый ящик');

    writeLetterAt(root, 'coordination2', 'letter-02.md', REQUEST_LETTER('заявка', 'другое тело'));
    attention = exchangeAttention({ root });
    assert.equal(attention.total, 2, 'другое тело — вторая заявка');

    fs.rmSync(path.join(root, 'coordination2', 'threads', 'critic-report', 'letter-02.md'), { force: true });
    const answer = 'Format: dsh-exchange/1\nFrom: structure\nTo: workflow\nDate: 2026-11-05T02:00:00+03:00\nThread: critic-report\nStatus: answer\nReply-To: letter-01.md\nSubject: Re: заявка\n\nответ\n';
    writeLetterAt(root, 'coordination', 'answer.md', answer);
    attention = exchangeAttention({ root });
    assert.equal(attention.total, 0, 'answer на одну копию снял все: ' + JSON.stringify(attention.items));
  });
});

await test('POST /api/exchange/mark: снимает ровно перечисленные письма, следующий скан пуст', async () => {
  await withStore(async () => {
    const root = project();
    const handler = handlerFor(root);
    const letter = writeLetter(root, '2026-11-05T01-00+03-00--workflow--01.md', LETTER('structure', 'первое'));
    const before = await scan(handler);
    assert.equal(before.body.unread.length, 1);
    const marked = await mark(handler, { paths: before.body.unread.map((row) => row.path) });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.ok, true);
    assert.equal(marked.body.marked, 1);
    const after = await scan(handler);
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.unread, [], 'отметка снимает непрочитанные');
    assert.equal(after.body.seen, 1);
    const duty = after.body.obligations.find((row) => row.id === 'exchange-read');
    assert.equal(duty.ok, true);
    const repo = repoFiles(root);
    assert.deepEqual(repo.filter((file) => /exchange-seen|evidence/iu.test(file)), [], 'в репозиторий ничего не записано');
    assert.ok(letter, 'письмо не удалено, только отмечено');
    assert.ok(fs.existsSync(letter));
  });
});

await test('POST /api/exchange/mark: пустой список — 400 bad-request с рецептом', async () => {
  await withStore(async () => {
    const root = project();
    const res = await mark(handlerFor(root), { paths: [] });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'bad-request');
    assert.ok(res.body.error, 'есть текст отказа');
    assert.ok(res.body.fix, 'есть рецепт');
    const files = repoFiles(root);
    assert.deepEqual(files.filter((file) => /exchange-seen/iu.test(file)), [], 'отказ ничего не записал');
  });
});

await test('POST /api/exchange/mark: битый список и неразбираемый JSON — 400 bad-request', async () => {
  await withStore(async () => {
    const handler = handlerFor(project());
    for (const body of [{ paths: 'C:/one.md' }, { paths: [42, null, '  '] }, {}, '{не json']) {
      const res = await mark(handler, body);
      assert.equal(res.status, 400, 'тело ' + JSON.stringify(body) + ' должно дать 400');
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, 'bad-request');
      assert.ok(res.body.error && res.body.fix, 'у отказа есть error и fix');
    }
  });
});

await test('GET /api/exchange/scan: метка из paths и причина service (0080)', async () => {
  await withStore(async () => {
    const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-exchange-peer-'));
    /* Живой folder-3: paths на оба корня, чужой участник первым. */
    const root = project((dir) => ({ participants: ['workflow', 'structure'], paths: { workflow: peer, structure: dir } }));
    writeLetter(root, 'to-me.md', LETTER('structure', 'наше'));
    writeLetter(root, 'to-peer.md', LETTER('workflow', 'чужое'));
    writeLetter(root, 'own.md', LETTER('workflow', 'наш ответ', 'structure'));
    const res = await scan(handlerFor(root));
    assert.equal(res.status, 200);
    assert.equal(res.body.boxes[0].me, 'structure', 'своя метка берётся из paths');
    assert.equal(res.body.unread.length, 1);
    assert.equal(res.body.unread[0].to, 'structure');
    const reasons = {};
    for (const row of res.body.skipped) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
    assert.deepEqual(reasons, { 'not-addressee': 1, service: 1 });
    assert.deepEqual(res.body.boxes[0].reasons, { 'not-addressee': 1, 'no-header': 0, service: 1, unreadable: 0 });
  });
});

await test('tools/check-exchange.mjs: печатает разбивку пропущенных по причинам (0080)', async () => {
  await withStore(async (store) => {
    const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-exchange-peer-cli-'));
    const root = project((dir) => ({ participants: ['workflow', 'structure'], paths: { workflow: peer, structure: dir } }));
    writeLetter(root, 'to-me.md', LETTER('structure', 'наше'));
    writeLetter(root, 'to-peer.md', LETTER('workflow', 'чужое'));
    writeLetter(root, 'own.md', LETTER('workflow', 'наш ответ', 'structure'));
    writeLetter(root, 'no-head.md', 'нет шапки\n');
    const run = spawnSync(process.execPath, [CLI, '--root', root], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DSH_PROJECT_GRAPH_STORE: store },
    });
    const out = String(run.stdout || '') + String(run.stderr || '');
    assert.equal(run.status, 1, 'непрочитанное письмо — код 1: ' + out);
    assert.match(out, /пропущено: 3 \(not-addressee 1, no-header 1, service 1\)/u, out);
    assert.match(out, /итог: непрочитано 1, прочитано 0/u, out);
  });
});

await test('GET /api/exchange/scan: корень вне списка — отказ 400 с кодом no-root', async () => {
  await withStore(async () => {
    const root = project();
    const handler = handlerFor(root);
    const res = await call(handler, API_PREFIX + '/api/exchange/scan?root=' + encodeURIComponent(path.join(root, 'другой')));
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'no-root');
  });
});

console.log(failures.length === 0
  ? 'EXCHANGE SCAN OK: ' + passed + ' проверок — скан, отметка, отказы 400 и обязанности в ответе'
  : 'EXCHANGE SCAN FAILED: ' + failures.length + ' из ' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
