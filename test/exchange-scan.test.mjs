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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime, createWebHandler, API_PREFIX } from '../lib/api.js';

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

/** Временный проект со структурой и папкой обмена. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-exchange-scan-root-'));
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  const graph = {
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор', provider: 'probe', model: 'probe-1' }],
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

const LETTER = (to, subject = 'тема', from = 'workflow', date = '2026-11-05T01:00:00+03:00') => 'Format: dsh-exchange/1\n'
  + 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nThread: critic-report\nStatus: report\n'
  + 'Subject: ' + subject + '\n\nтело письма, которое сканер не читает\n';

/** Положить письмо в ящик папки; возвращает абсолютный путь. */
function writeLetter(root, name, text) {
  const file = path.join(root, 'coordination', 'threads', 'critic-report', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
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
