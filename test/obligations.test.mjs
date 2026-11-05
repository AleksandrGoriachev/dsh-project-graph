/**
 * Обязанности структуры (задание 0075).
 *
 * Набор доказывает пять обещаний контракта: объявление читается и
 * нормализуется, сканер обмена считает только письма СВОЕМУ участнику (чужие и
 * без шапки попадают в skipped), отметка прочитанного идемпотентна и снимает
 * обязанность, command-проверка различает exit 0/3 и таймаут, evidence лежит в
 * хранилище и никогда в репозитории, а битая структура не роняет оценку.
 *
 * Каждый тест получает свой DSH_PROJECT_GRAPH_STORE: следы одного набора не
 * должны влиять на другой и на живой ~/.dsh.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMMAND_TIMEOUT_MS, EVIDENCE_FIELDS, MAX_OUTPUT_CHARS,
  evaluateObligations, markExchangeSeen, readObligations, scanExchange,
} from '../lib/obligations.js';
import { createGraphRuntime, createWebHandler, API_PREFIX } from '../lib/api.js';
import { storeDir } from '../lib/store.js';

async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  /* Каталог хранилища НЕ создаётся заранее: проект без структуры должен
   * отличаться от проекта с пустым внешним хранилищем. */
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-obligations-store-')), 'store');
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

/** Временный проект; `contents === null` — структуры нет. */
function project(contents = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-obligations-root-'));
  if (contents !== null) {
    fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
    for (const [name, value] of Object.entries(contents)) {
      const file = path.join(dir, 'structure', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }
  }
  return dir;
}

/** Минимальная структура: узлы не нужны, чтобы читать обязанности и папки. */
function graph(extra = {}) {
  return {
    version: 1,
    nodes: [{ id: 'worker', role: 'исполнитель', provider: 'opencode', model: 'deepseek-v4.1-flash' }],
    edges: [],
    ...extra,
  };
}

/** Папка обмена с тем же резолвером, что в объявлении проекта. */
function folder(extra = {}) {
  return {
    id: 'folder-1',
    box: { path: 'coordination', root: 'workspace' },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    ...extra,
  };
}

const LETTER = (to, subject = 'тема', from = 'workflow', date = '2026-11-05T01:00:00+03:00') => 'Format: dsh-exchange/1\n'
  + 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nThread: critic-report\nStatus: report\n'
  + 'Subject: ' + subject + '\n\nтело письма, которое сканер не читает\n';

/** Положить письмо в ящик папки; `rel` — путь относительно ящика. */
function writeLetter(root, rel, text) {
  const file = path.join(root, 'coordination', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
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

/** Вызов HTTP-маршрута теми же моками, что test/api.test.mjs. */
function call(handler, url) {
  const res = {
    status: 0,
    body: null,
    writableEnded: false,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(String(body)); this.writableEnded = true; },
  };
  const req = {
    method: 'GET',
    url,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) { if (event === 'end') fn(); },
  };
  return Promise.resolve(handler(req, res)).then(() => res);
}

await test('readObligations: нормализует id, title, check и enforce', async () => {
  const root = project({ 'graph.json': graph({ obligations: [
    { id: 'exchange-read', title: 'разобрать входящие', check: { kind: 'exchange-unread', max: 2 }, enforce: 'block' },
    { id: 'smoke', check: { kind: 'command', run: 'node -e "process.exit(0)"' } },
  ] }) });
  const rows = readObligations({ root });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: 'exchange-read',
    title: 'разобрать входящие',
    check: { kind: 'exchange-unread', max: 2 },
    enforce: 'block',
  });
  assert.equal(rows[1].title, 'smoke', 'title по умолчанию — id');
  assert.equal(rows[1].enforce, 'warn', 'enforce по умолчанию — warn');
  assert.equal(rows[1].check.kind, 'command');
});

await test('readObligations: собирает обязанности из нескольких фрагментов', async () => {
  const root = project({
    'graph.json': graph(),
    'duties.json': { version: 1, obligations: [{ id: 'b', title: 'вторая', check: { kind: 'command', run: 'node -e "process.exit(0)"' } }] },
    'teams/code.json': { obligations: [{ id: 'a', title: 'первая', check: { kind: 'exchange-unread' } }] },
  });
  const ids = readObligations({ root }).map((row) => row.id);
  assert.deepEqual(ids.sort(), ['a', 'b']);
});

await test('readObligations: без структуры — пустой список, без исключения', async () => {
  const root = project(null);
  assert.deepEqual(readObligations({ root }), []);
});

await test('scanExchange: считает только письма своему участнику, чужие и без шапки — skipped', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder()] }) });
  const ours = writeLetter(root, 'threads/critic-report/01.md', LETTER('structure', 'наше письмо'));
  writeLetter(root, 'threads/critic-report/02.md', LETTER('workflow', 'чужое письмо'));
  writeLetter(root, 'threads/critic-report/03.md', 'просто текст без шапки\n');
  const scan = scanExchange({ root });
  assert.equal(scan.unread.length, 1);
  assert.equal(scan.unread[0].path, ours);
  assert.equal(scan.unread[0].to, 'structure');
  assert.equal(scan.unread[0].subject, 'наше письмо');
  assert.equal(scan.unread[0].date, '2026-11-05T01:00:00+03:00');
  assert.equal(scan.seen, 0);
  assert.equal(scan.skipped.length, 2);
  const reasons = scan.skipped.map((row) => row.reason).sort();
  assert.deepEqual(reasons, ['no-header', 'not-addressee']);
  assert.equal(scan.boxes.length, 1);
  assert.equal(scan.boxes[0].me, 'structure');
  assert.equal(scan.boxes[0].letters, 1);
  assert.equal(scan.boxes[0].skipped, 2);
});

await test('scanExchange: общая папка (shared) находится рядом с воркспейсом', async () => {
  const root = project({ 'graph.json': graph({ folders: [folder({ box: { path: 'shared-box', root: 'shared' } })] }) });
  const outside = path.join(path.dirname(root), 'shared-box', 'threads', 'critic-report');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, '01.md'), LETTER('structure', 'общее письмо'));
  const scan = scanExchange({ root });
  assert.equal(scan.unread.length, 1);
  assert.equal(scan.unread[0].subject, 'общее письмо');
  assert.equal(scan.boxes[0].path, path.join(path.dirname(root), 'shared-box'));
});

await test('markExchangeSeen: идемпотентен, путь -> sha256, чужие записи не стираются', async () => {
  await withStore(async (store) => {
    const root = project({ 'graph.json': graph({ folders: [folder()] }) });
    writeLetter(root, 'threads/critic-report/01.md', LETTER('structure', 'первое'));
    writeLetter(root, 'threads/critic-report/02.md', LETTER('structure', 'второе'));
    const seenFile = path.join(store, 'exchange-seen.json');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify({ 'C:/foreign/letter.md': 1762290000000 }) + '\n');
    const scan = scanExchange({ root });
    assert.equal(scan.unread.length, 2);
    const first = markExchangeSeen({ root, paths: scan.unread.map((row) => row.path) });
    assert.equal(first.marked, 2);
    assert.equal(first.written, true);
    const text = fs.readFileSync(seenFile, 'utf8');
    const rows = JSON.parse(text);
    assert.equal(rows['C:/foreign/letter.md'], 1762290000000, 'числовая отметка другого инструмента сохранена');
    const own = Object.keys(rows).filter((key) => /^[A-Za-z]:[\\/]/u.test(key) && key !== 'C:/foreign/letter.md');
    assert.equal(own.length, 2);
    for (const key of own) assert.match(rows[key], /^[0-9a-f]{64}$/u);
    const second = markExchangeSeen({ root, paths: scan.unread.map((row) => row.path) });
    assert.equal(second.written, false, 'повторная отметка не переписывает файл');
    assert.equal(fs.readFileSync(seenFile, 'utf8'), text, 'содержимое не изменилось');
    const again = scanExchange({ root });
    assert.equal(again.unread.length, 0, 'отметка снимает непрочитанные');
    assert.equal(again.seen, 2);
  });
});

await test('markExchangeSeen: несуществующий путь не попадает в отметку', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({ folders: [folder()] }) });
    const result = markExchangeSeen({ root, paths: [path.join(root, 'coordination', 'threads', 'нет.md')] });
    assert.equal(result.marked, 0);
    assert.equal(scanExchange({ root }).unread.length, 0);
  });
});

await test('evaluateObligations: exchange-unread с непрочитанными — ok:false и evidence в хранилище', async () => {
  await withStore(async (store) => {
    const root = project({ 'graph.json': graph({
      folders: [folder()],
      obligations: [{ id: 'exchange-read', title: 'разобрать входящие', check: { kind: 'exchange-unread', max: 0 }, enforce: 'warn' }],
    }) });
    writeLetter(root, 'threads/critic-report/01.md', LETTER('structure', 'первое'));
    writeLetter(root, 'threads/critic-report/02.md', LETTER('structure', 'второе'));
    const status = evaluateObligations({ root });
    assert.equal(status.workspace, path.basename(root));
    assert.equal(status.obligations.length, 1);
    const row = status.obligations[0];
    assert.equal(row.id, 'exchange-read');
    assert.equal(row.ok, false);
    assert.match(row.detail, /2/u);
    assert.ok(row.evidenceAt, 'evidenceAt заполнен');
    const evidenceFile = path.join(store, 'evidence', 'exchange-read.json');
    assert.ok(fs.existsSync(evidenceFile), 'evidence лежит в хранилище');
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    for (const key of EVIDENCE_FIELDS) assert.ok(Object.hasOwn(evidence, key), 'в evidence есть ' + key);
    assert.equal(evidence.ok, false);
    assert.equal(evidence.counts.unread, 2);
    assert.match(evidence.hash, /^[0-9a-f]{64}$/u);
    assert.match(evidence.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u);
    const repo = repoFiles(root);
    assert.deepEqual(repo.filter((file) => /evidence|exchange-seen/iu.test(file)), [], 'в репозиторий ничего не записано');
  });
});

await test('evaluateObligations: порог check.max разрешает одно непрочитанное', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({
      folders: [folder()],
      obligations: [{ id: 'exchange-read', check: { kind: 'exchange-unread', max: 1 } }],
    }) });
    writeLetter(root, 'threads/critic-report/01.md', LETTER('structure', 'одно'));
    const one = evaluateObligations({ root }).obligations[0];
    assert.equal(one.ok, true);
    assert.match(one.detail, /1/u);
    writeLetter(root, 'threads/critic-report/02.md', LETTER('structure', 'второе'));
    const two = evaluateObligations({ root }).obligations[0];
    assert.equal(two.ok, false, '2 > max 1');
    assert.match(two.detail, /2/u);
  });
});

await test('evaluateObligations: command exit 0 выполнен, exit 3 — нет', async () => {
  await withStore(async (store) => {
    const passRoot = project({ 'graph.json': graph({
      obligations: [{ id: 'smoke', title: 'быстрая проверка', check: { kind: 'command', run: 'node -e "process.exit(0)"' } }],
    }) });
    const failRoot = project({ 'graph.json': graph({
      obligations: [{ id: 'smoke', title: 'быстрая проверка', check: { kind: 'command', run: 'node -e "process.exit(3)"' } }],
    }) });
    assert.equal(COMMAND_TIMEOUT_MS, 120000, 'предел команды по умолчанию — 120 с');
    const pass = evaluateObligations({ root: passRoot }).obligations[0];
    assert.equal(pass.ok, true);
    assert.match(pass.detail, /кодом 0/u);
    const fail = evaluateObligations({ root: failRoot }).obligations[0];
    assert.equal(fail.ok, false);
    assert.match(fail.detail, /3/u);
    assert.match(fail.detail, /ожидался 0/u);
    assert.ok(fs.existsSync(path.join(store, 'evidence', 'smoke.json')), 'evidence последней проверки записан');
  });
});

await test('evaluateObligations: таймаут команды — ok:false с причиной, не исключение', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({
      obligations: [{ id: 'slow', title: 'медленная', check: { kind: 'command', run: 'node -e "setTimeout(()=>{}, 10000)"', timeoutMs: 150 } }],
    }) });
    const row = evaluateObligations({ root }).obligations[0];
    assert.equal(row.ok, false);
    assert.match(row.detail, /таймаут/u);
    assert.match(row.detail, /150/u);
    const evidence = JSON.parse(fs.readFileSync(path.join(storeDir(root), 'evidence', 'slow.json'), 'utf8'));
    assert.equal(evidence.counts.timedOut, true);
    assert.equal(evidence.counts.timeoutMs, 150);
  });
});

await test('evaluateObligations: вывод команды обрезается до MAX_OUTPUT_CHARS', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({
      obligations: [{ id: 'noisy', check: { kind: 'command', run: 'node -e "process.stdout.write(\'x\'.repeat(5000))"' } }],
    }) });
    const row = evaluateObligations({ root }).obligations[0];
    assert.equal(row.ok, true);
    const evidence = JSON.parse(fs.readFileSync(path.join(storeDir(root), 'evidence', 'noisy.json'), 'utf8'));
    assert.equal(evidence.counts.outputChars, 5000);
    assert.equal(evidence.counts.outputTruncated, true);
    assert.equal(evidence.output.length, MAX_OUTPUT_CHARS);
  });
});

await test('evaluateObligations: неизвестный вид проверки — ok:false', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({ obligations: [{ id: 'strange', check: { kind: 'telepathy' } }] }) });
    const row = evaluateObligations({ root }).obligations[0];
    assert.equal(row.ok, false);
    assert.match(row.detail, /telepathy/u);
  });
});

await test('evaluateObligations: битая структура — error, не исключение', async () => {
  await withStore(async (store) => {
    const root = project({ 'graph.json': '{ это не JSON' });
    let status;
    assert.doesNotThrow(() => { status = evaluateObligations({ root }); });
    assert.deepEqual(status.obligations, []);
    assert.equal(status.error.code, 'invalid-structure');
    assert.ok(status.error.error.includes('JSON'));
    assert.ok(status.error.fix);
    assert.deepEqual(readObligations({ root }), []);
    assert.equal(fs.existsSync(path.join(store, 'evidence')), false, 'для битой структуры evidence не пишется');
  });
});

await test('evaluateObligations: без структуры — error no-structure', async () => {
  await withStore(async () => {
    const root = project(null);
    const status = evaluateObligations({ root });
    assert.equal(status.error.code, 'no-structure');
    assert.deepEqual(status.obligations, []);
  });
});

await test('evaluateObligations: хранилище внутри репозитория — evidence не пишется', async () => {
  await withStore(async () => {
    const root = project({ 'graph.json': graph({ obligations: [{ id: 'smoke', check: { kind: 'command', run: 'node -e "process.exit(0)"' } }] }) });
    process.env.DSH_PROJECT_GRAPH_STORE = path.join(root, '.store');
    const row = evaluateObligations({ root }).obligations[0];
    assert.equal(row.ok, true);
    assert.equal(row.evidenceAt, null, 'evidence не подтверждён');
    assert.equal(fs.existsSync(path.join(root, '.store')), false, 'репозиторий не создаёт каталог хранилища');
  });
});

await test('GET /api/obligations: ok:true со статусом и ok:false при битой структуре', async () => {
  await withStore(async () => {
    const good = project({ 'graph.json': graph({
      folders: [folder()],
      obligations: [{ id: 'exchange-read', title: 'разобрать входящие', check: { kind: 'exchange-unread' } }],
    }) });
    writeLetter(good, 'threads/critic-report/01.md', LETTER('structure'));
    const goodHandler = createWebHandler(createGraphRuntime({ roots: [good] }));
    const goodRes = await call(goodHandler, API_PREFIX + '/api/obligations');
    assert.equal(goodRes.status, 200);
    assert.equal(goodRes.body.ok, true);
    assert.equal(goodRes.body.workspace, path.basename(good));
    assert.equal(goodRes.body.obligations[0].ok, false);

    const broken = project({ 'graph.json': '{ битый' });
    const brokenHandler = createWebHandler(createGraphRuntime({ roots: [broken] }));
    const brokenRes = await call(brokenHandler, API_PREFIX + '/api/obligations');
    assert.equal(brokenRes.status, 200);
    assert.equal(brokenRes.body.ok, false);
    assert.equal(brokenRes.body.code, 'invalid-structure');
    assert.ok(brokenRes.body.error);
    assert.ok(brokenRes.body.fix);
  });
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error((failure.error && failure.error.stack) || failure.error);
}
console.log('OBLIGATIONS TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
