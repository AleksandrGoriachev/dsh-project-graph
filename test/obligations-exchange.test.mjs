/**
 * Обмен как обязательство адресата (задание 0280).
 *
 * Набор доказывает шесть обещаний контракта:
 *   1. отметка «разобрал» ставится точечно (--mark <письмо>): соседнее письмо
 *      остаётся непрочитанным, открытая заявка — открытой;
 *   2. заявка (request/question) закрывается только письмом answer/ack с адресом
 *      в Reply-To или Ref; --gate отказывает кодом 3, пока она не закрыта;
 *   3. вид обязанности exchange-open считается в evaluateObligations и держит
 *      запуск узла отказом гейта структуры;
 *   4. память вручений (exchange-delivered.json) не равна памяти прочтения
 *      (exchange-seen.json): доставленное письмо остаётся непрочитанным;
 *   5. ошибка формата принадлежит письму-ответу, а составной Ref (список через
 *      ';') разбирается поэлементно: неразрешённый элемент назван, заявка,
 *      которую назвали, — закрыта;
 *   6. просроченная заявка остаётся в счёте с меткой «просрочено» и держит гейт.
 *
 * Каждый тест получает СВОЙ DSH_PROJECT_GRAPH_STORE во временном каталоге:
 * живое хранилище и живой ящик не трогаются.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  exchangeAttention, evaluateObligations, markExchangeSeen, scanExchange, unreadDebtRows,
} from '../lib/obligations.js';
import { handlePreExecute } from '../lib/obligations-gate.js';
import { createExchangeWatcher, seenPath } from '../lib/exchange-watch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'tools', 'check-exchange.mjs');

/** Все временные каталоги набора: удаляются после прогона (задание 0280, A11). */
const TEMP_DIRS = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* временный каталог мог остаться занятым: best effort, прогон не валим */
    }
  }
});

/** Свой склад на каждый тест: отметки одного случая не влияют на другой. */
async function withStore(body) {
  const previous = process.env.DSH_PROJECT_GRAPH_STORE;
  const store = path.join(tempDir('pg-0280-test-store-'), 'store');
  fs.mkdirSync(store, { recursive: true });
  process.env.DSH_PROJECT_GRAPH_STORE = store;
  try {
    return await body(store);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROJECT_GRAPH_STORE;
    else process.env.DSH_PROJECT_GRAPH_STORE = previous;
  }
}

/** Временный проект: структура с объявлением, ящик обмена рядом с корнем. */
function fixture(obligations = []) {
  const dir = tempDir('pg-0280-test-root-');
  fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
  const graph = {
    version: 1,
    nodes: [{ id: 'worker', role: 'исполнитель', provider: 'opencode', model: 'deepseek-v4.1-flash' }],
    edges: [],
    folders: [{
      id: 'folder-1',
      box: { path: 'coordination', root: 'workspace' },
      participants: ['structure', 'workflow'],
      me: 'structure',
    }],
    obligations,
  };
  fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify(graph, null, 2));
  fs.mkdirSync(path.join(dir, 'coordination', 'threads', 'exchange'), { recursive: true });
  return dir;
}

/** Письмо в ветку exchange; возвращает абсолютный путь. */
function letter(root, name, options = {}) {
  const abs = path.join(root, 'coordination', 'threads', 'exchange', name);
  const head = [
    'Format: dsh-exchange/1',
    'From: ' + (options.from || 'workflow'),
    'To: ' + (options.to || 'structure'),
    'Date: ' + (options.date || new Date(Date.now() - 60 * 1000).toISOString()),
    'Thread: exchange',
    'Status: ' + (options.status || 'report'),
    ...(options.replyTo ? ['Reply-To: ' + options.replyTo] : []),
    ...(options.ref ? ['Ref: ' + options.ref] : []),
    ...(options.subject ? ['Subject: ' + options.subject] : []),
    '',
  ].join('\n');
  fs.writeFileSync(abs, head + 'тело письма\n', 'utf8');
  return abs;
}

function runCli(args, store) {
  const env = { ...process.env, DSH_PROJECT_GRAPH_STORE: store, NO_COLOR: '1' };
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env });
  return {
    code: result.status === null ? 124 : Number(result.status),
    out: String(result.stdout || '') + String(result.stderr || ''),
  };
}

/** Состояние файла для проверки «не тронут»: null — файла нет. */
function fileState(file) {
  try {
    const stat = fs.statSync(file);
    return stat.size + ':' + stat.mtimeMs;
  } catch {
    return null;
  }
}

/** Лежит ли путь внутри каталога. */
function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const OBLIGATIONS = [
  { id: 'exchange-unread', title: 'входящие письма разобраны', check: { kind: 'exchange-unread', max: 0 }, enforce: 'fail' },
  { id: 'exchange-open', title: 'заявки закрыты ответом', check: { kind: 'exchange-open', max: 0 }, enforce: 'fail' },
];

function unreadPaths(root) {
  return (scanExchange({ root }).unread || []).map((row) => path.resolve(row.path));
}

test('0280 C1: --mark <письмо> отмечает одно письмо и не закрывает соседнее', async () => {
  await withStore(async (store) => {
    const dir = fixture(OBLIGATIONS);
    const request = letter(dir, 'req.md', { status: 'request', subject: 'заявка' });
    const report = letter(dir, 'report.md', { status: 'report', subject: 'отчёт' });
    const before = unreadPaths(dir);
    assert.equal(before.length, 2, 'до отметки непрочитаны оба письма');
    const run = runCli(['--root', dir, '--mark', request], store);
    assert.equal(run.code, 0, 'точечная отметка вышла 0: ' + run.out.slice(0, 300));
    const after = unreadPaths(dir);
    assert.equal(after.includes(path.resolve(request)), false, 'отмеченное письмо разобрано');
    assert.equal(after.includes(path.resolve(report)), true, 'соседнее письмо осталось непрочитанным');
    /* Отметка «прочитано» заявку не закрывает: прочтение и закрытие — разные вещи. */
    const open = (evaluateObligations({ root: dir }).obligations || []).find((row) => row.id === 'exchange-open');
    assert.equal(open.ok, false, 'отметка прочтения не закрыла заявку');
  });
});

test('0280 C2: --gate отказывает, пока заявка не закрыта ответом', async () => {
  await withStore(async (store) => {
    const dir = fixture(OBLIGATIONS);
    const request = letter(dir, 'req.md', { status: 'request', subject: 'требование' });
    const first = runCli(['--root', dir, '--gate'], store);
    assert.equal(first.code, 3, 'открытая заявка — отказ гейта: ' + first.out.slice(0, 300));
    assert.match(first.out, /exchange-open/u, 'отказ называет обязанность');
    const mark = runCli(['--root', dir, '--mark', request], store);
    assert.equal(mark.code, 0, 'точечная отметка прошла');
    const second = runCli(['--root', dir, '--gate'], store);
    assert.equal(second.code, 3, 'отметка «прочитано» не снимает отказ');
    letter(dir, 'answer.md', { status: 'answer', replyTo: 'threads/exchange/req.md', subject: 'ответ' });
    const third = runCli(['--root', dir, '--gate'], store);
    assert.equal(third.code, 0, 'ответ закрыл заявку и открыл гейт: ' + third.out.slice(0, 300));
  });
});

test('0280 C3: вид exchange-open считается и держит запуск узла', async () => {
  await withStore(async () => {
    const dir = fixture([OBLIGATIONS[1]]);
    letter(dir, 'req.md', { status: 'request', subject: 'требование' });
    const row = (evaluateObligations({ root: dir }).obligations || []).find((item) => item.id === 'exchange-open');
    assert.ok(row, 'строка exchange-open есть в оценке');
    assert.match(String(row.detail), /заявк/u, 'detail называет заявку: ' + row.detail);
    assert.equal(row.ok, false, 'открытая заявка делает обязанность провальной');
    const gate = await handlePreExecute({
      exec: { name: 'project_graph_spawn', arguments: { node: 'worker', prompt: 'проверка' } },
      root: dir,
    });
    assert.equal(gate && gate.kind, 'deny', 'гейт отказал в запуске узла');
    assert.match(String(gate.reason), /exchange-open/u, 'отказ называет обязанность: ' + gate.reason);
  });
});

test('0280 C4: составной Ref разбирается поэлементно, ошибка принадлежит ответу', async () => {
  await withStore(async () => {
    const dir = fixture();
    letter(dir, 'req.md', { status: 'request', subject: 'заявка' });
    const answer = letter(dir, 'answer.md', {
      status: 'answer',
      ref: 'threads/exchange/req.md; threads/exchange/nowhere.md',
      subject: 'ответ',
    });
    const attention = exchangeAttention({ root: dir });
    const open = (attention.items || []).map((item) => path.basename(String(item.path || '')));
    assert.equal(open.includes('req.md'), false, 'названный элемент закрыл заявку');
    const errors = attention.formatErrors || [];
    assert.equal(errors.length, 1, 'неразрешённый элемент назван ровно один');
    assert.match(String(errors[0].ref), /nowhere\.md/u, 'в ошибке — неразрешённый элемент');
    assert.equal(errors[0].letter, answer, 'ошибка принадлежит письму-ответу');
    /* Второй случай: заявка не закрыта, но чужое предупреждение ей не приписано. */
    const dir2 = fixture();
    letter(dir2, 'req.md', { status: 'request', subject: 'заявка' });
    const answer2 = letter(dir2, 'answer.md', { status: 'answer', ref: 'threads/exchange/nowhere.md', subject: 'ответ' });
    const attention2 = exchangeAttention({ root: dir2 });
    const item = (attention2.items || []).find((row) => path.basename(String(row.path || '')) === 'req.md');
    assert.ok(item, 'незакрытая заявка осталась в счёте');
    assert.equal(item.formatError, undefined, 'ошибка формата не приписана чужой заявке');
    assert.ok((attention2.formatErrors || []).some((row) => row.letter === answer2), 'ошибка названа у письма-ответа');
  });
});

test('0280 C5: память вручений отделена от памяти прочтения', async () => {
  await withStore(async (store) => {
    const dir = fixture();
    /* Сторож берёт склад прогонов из runtime.runsDir: фикстура, а не живой ~/.dsh. */
    const runsDir = path.join(dir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const runtime = {
      runsDir,
      allowedRoots: () => [],
      exchange: [],
      participants: {},
      runs: new Map(),
    };
    const abs = letter(dir, 'req.md', { status: 'request', subject: 'заявка' });
    const deliveredFile = seenPath(runtime);
    /* Путь, который тест НЕ имеет права трогать: живая память вручений хоста. */
    const liveMemory = seenPath({});
    const liveBefore = fileState(liveMemory);
    assert.equal(path.basename(deliveredFile), 'exchange-delivered.json', 'сторож пишет память вручений в свой файл');
    assert.equal(isInside(dir, deliveredFile), true, 'память вручений — во временном каталоге фикстуры: ' + deliveredFile);
    assert.notEqual(path.resolve(deliveredFile), path.resolve(liveMemory), 'фикстура не совпадает с живой памятью вручений');
    assert.notEqual(path.resolve(deliveredFile), path.resolve(path.join(store, 'exchange-seen.json')), 'память вручений ≠ память прочтения');
    fs.writeFileSync(deliveredFile, JSON.stringify({ [abs]: Date.now() }, null, 1));
    assert.equal(unreadPaths(dir).includes(path.resolve(abs)), true, 'вручённое письмо не считается прочитанным');
    const marked = markExchangeSeen({ root: dir, path: abs });
    assert.equal(marked.marked, 1, 'явная отметка отметила письмо');
    assert.equal(unreadPaths(dir).includes(path.resolve(abs)), false, 'явная отметка сняла письмо из непрочитанных');
    const delivered = JSON.parse(fs.readFileSync(deliveredFile, 'utf8'));
    assert.equal(typeof delivered[abs], 'number', 'память вручений не переписана хешем прочтения');
    const seen = JSON.parse(fs.readFileSync(path.join(store, 'exchange-seen.json'), 'utf8'));
    assert.match(String(seen[abs]), /^[0-9a-f]{64}$/u, 'в памяти прочтения — sha256 письма');
    assert.equal(fileState(liveMemory), liveBefore, 'живая память вручений не тронута: ' + liveMemory);
  });
});

test('0280: миграция памяти вручений — нет нового файла, есть старый', async () => {
  await withStore(async () => {
    const dir = fixture();
    const runsDir = path.join(dir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    /* Прежняя память вручений: 690 числовых отметок, как в живом складе прогонов. */
    const legacyFile = path.join(runsDir, ['exchange', 'seen.json'].join('-'));
    const rows = {};
    for (let index = 0; index < 690; index += 1) {
      rows['threads/exchange/' + String(index).padStart(3, '0') + '.md'] = 1000 + index;
    }
    fs.writeFileSync(legacyFile, JSON.stringify(rows));
    const legacyBefore = fs.readFileSync(legacyFile, 'utf8');
    const runtime = {
      runsDir,
      allowedRoots: () => [],
      exchange: [],
      participants: {},
      runs: new Map(),
    };
    const deliveredFile = seenPath(runtime);
    assert.equal(fs.existsSync(deliveredFile), false, 'нового файла памяти ещё нет');
    const watcher = createExchangeWatcher({ runtime, heartbeat: false });
    watcher.loadSeen();
    assert.equal(watcher.seen.size, 690, 'память вручений прочитана из старого файла без потерь');
    assert.equal(watcher.seen.get('threads/exchange/000.md'), 1000, 'значение отметки сохранено');
    const persisted = JSON.parse(fs.readFileSync(deliveredFile, 'utf8'));
    assert.equal(Object.keys(persisted).length, 690, 'миграция сразу персистит объединённую память в новый файл');
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacyBefore, 'старый файл не переписан');
    assert.equal(fs.existsSync(path.join(runsDir, 'exchange-delivered.migrated.json')), true, 'миграция отмечена маркером');
  });
});

test('0280 M-A: пустой новый файл не теряет прежнюю память — объединение и персист', async () => {
  await withStore(async () => {
    const dir = fixture();
    const runsDir = path.join(dir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const legacyFile = path.join(runsDir, ['exchange', 'seen.json'].join('-'));
    const rows = {};
    for (let index = 0; index < 690; index += 1) {
      rows['threads/exchange/' + String(index).padStart(3, '0') + '.md'] = 1000 + index;
    }
    fs.writeFileSync(legacyFile, JSON.stringify(rows));
    const legacyBefore = fs.readFileSync(legacyFile, 'utf8');
    const runtime = { runsDir, allowedRoots: () => [], exchange: [], participants: {}, runs: new Map() };
    const deliveredFile = seenPath(runtime);
    /* Новый файл существует и валиден, но пуст: прежние 690 не должны пропасть. */
    fs.writeFileSync(deliveredFile, '{}');
    const watcher = createExchangeWatcher({ runtime, heartbeat: false });
    watcher.loadSeen();
    assert.equal(watcher.seen.size, 690, 'память объединена: пустой новый файл не спрятал прежнюю');
    const persisted = JSON.parse(fs.readFileSync(deliveredFile, 'utf8'));
    assert.equal(Object.keys(persisted).length, 690, 'объединённая память персистится сразу');
    assert.equal(persisted['threads/exchange/000.md'], 1000, 'более старая запись прежней памяти сохранена');
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacyBefore, 'старый файл не переписан');
  });
});

test('0280 M-B: удаление нового файла не воскрешает снятую отметку', async () => {
  await withStore(async () => {
    const dir = fixture();
    const runsDir = path.join(dir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const legacyFile = path.join(runsDir, ['exchange', 'seen.json'].join('-'));
    const rows = {
      'threads/exchange/000.md': 1000,
      'threads/exchange/001.md': 1001,
      'threads/exchange/002.md': 1002,
    };
    fs.writeFileSync(legacyFile, JSON.stringify(rows));
    const runtime = { runsDir, allowedRoots: () => [], exchange: [], participants: {}, runs: new Map() };
    const deliveredFile = seenPath(runtime);
    const watcher = createExchangeWatcher({ runtime, heartbeat: false });
    watcher.loadSeen();
    /* Имитируем снятие отметки recover: её больше нет в памяти вручений. */
    const current = JSON.parse(fs.readFileSync(deliveredFile, 'utf8'));
    delete current['threads/exchange/001.md'];
    fs.writeFileSync(deliveredFile, JSON.stringify(current));
    /* Новый файл удалён: прежняя память НЕ должна вернуть снятую отметку. */
    fs.rmSync(deliveredFile);
    const second = createExchangeWatcher({ runtime, heartbeat: false });
    second.loadSeen();
    assert.equal(second.seen.has('threads/exchange/001.md'), false, 'снятая отметка не воскресла из прежней памяти');
  });
});

test('0280: exchange-recover работает с памятью вручений и не трогает sha256-отметки прочтения', async () => {
  await withStore(async () => {
    const dir = tempDir('pg-0280-recover-');
    const delivered = path.join(dir, 'exchange-delivered.json');
    const readMemory = path.join(dir, 'exchange-seen.json');
    const journal = path.join(dir, 'exchange-decisions.jsonl');
    /* Числовая отметка без вручения — законная ложная; sha256 — память прочтения. */
    const letterA = path.join(dir, 'letters', 'a.md');
    const letterB = path.join(dir, 'letters', 'b.md');
    fs.mkdirSync(path.dirname(letterA), { recursive: true });
    fs.writeFileSync(letterA, 'From: workflow\nTo: structure\nDate: 2026-11-03T10:00+03:00\nStatus: report\n\nтело\n');
    fs.writeFileSync(letterB, 'From: workflow\nTo: structure\nDate: 2026-11-03T10:00+03:00\nStatus: report\n\nтело\n');
    const sha = 'a'.repeat(64);
    fs.writeFileSync(delivered, JSON.stringify({ [letterA]: 1000 }, null, 1));
    fs.writeFileSync(readMemory, JSON.stringify({ [letterB]: sha }, null, 1));
    fs.writeFileSync(journal, '');
    const readMemoryBefore = fs.readFileSync(readMemory, 'utf8');
    const runRecover = (args) => {
      const env = { ...process.env, DSH_PROJECT_GRAPH_STORE: dir };
      const result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'exchange-recover.mjs'), ...args], {
        cwd: ROOT, encoding: 'utf8', env,
      });
      return {
        code: result.status === null ? 124 : Number(result.status),
        out: String(result.stdout || ''),
        err: String(result.stderr || ''),
      };
    };
    const dry = runRecover(['--store', dir, '--dry-run', '--json']);
    assert.equal(dry.code, 0, 'dry-run вышел 0: ' + dry.out.slice(0, 300));
    const dryBody = JSON.parse(dry.out);
    assert.deepEqual(dryBody.falseSeen, [letterA], 'ложной признана только числовая отметка вручения');
    assert.equal(dryBody.falseSeen.includes(letterB), false, 'sha256-отметка прочтения не признана ложной');
    assert.equal(dryBody.seenKind, 'delivered', 'CLI читает память вручений, а не память прочтения');
    const apply = runRecover(['--store', dir, '--apply', '--json']);
    assert.equal(apply.code, 0, 'apply вышел 0: ' + apply.out.slice(0, 300));
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(delivered, 'utf8'))), [], 'ложная отметка снята');
    assert.equal(fs.readFileSync(readMemory, 'utf8'), readMemoryBefore, 'память прочтения не переписана');
    /* Задание 0280 (M-C): файл с sha256 — память прочтения, перезапись запрещена. */
    const explicit = runRecover(['--seen', readMemory, '--decisions', journal, '--dry-run', '--json']);
    assert.equal(explicit.code, 2, 'память прочтения — отказ кодом 2: ' + (explicit.err || explicit.out).slice(0, 300));
    assert.match(explicit.err, /память прочтения/u, 'причина названа');
    assert.equal(fs.readFileSync(readMemory, 'utf8'), readMemoryBefore, 'память прочтения не тронута и после отказа');
  });
});

test('0280 C6: просроченная заявка остаётся в счёте с меткой «просрочено»', async () => {
  await withStore(async (store) => {
    const dir = fixture([OBLIGATIONS[1]]);
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    letter(dir, 'req.md', { status: 'request', date: old, subject: 'старая заявка' });
    const row = (evaluateObligations({ root: dir }).obligations || []).find((item) => item.id === 'exchange-open');
    assert.match(String(row.detail), /просроч/u, 'detail называет просрочку: ' + row.detail);
    assert.equal(row.ok, false, 'просроченная заявка — провал, а не тишина');
    const attention = exchangeAttention({ root: dir });
    assert.equal(attention.stale, 1, 'просроченная заявка видна отдельным числом');
    const run = runCli(['--root', dir, '--gate'], store);
    assert.equal(run.code, 3, 'просроченная заявка держит гейт');
  });
});

test('0280: пустой ящик проходит гейт — объявленные обязанности не мешают работе', async () => {
  await withStore(async (store) => {
    const dir = fixture(OBLIGATIONS);
    const rows = evaluateObligations({ root: dir }).obligations || [];
    assert.equal(rows.length, 2, 'обе обязанности посчитаны');
    assert.ok(rows.every((row) => row.ok === true), 'на пустом ящике обе выполнены');
    const run = runCli(['--root', dir, '--gate'], store);
    assert.equal(run.code, 0, 'гейт открыт: ' + run.out.slice(0, 300));
  });
});

test('0280 A4: неразрешаемая объявленная папка валит обе обязанности и держит гейт', async () => {
  await withStore(async () => {
    const dir = tempDir('pg-0280-broken-box-');
    fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), JSON.stringify({
      version: 1,
      nodes: [{ id: 'worker', role: 'исполнитель' }],
      edges: [],
      folders: [{
        id: 'folder-broken',
        box: { path: 'no-such-box', root: 'workspace' },
        participants: ['structure', 'workflow'],
        me: 'structure',
      }],
      obligations: OBLIGATIONS,
    }, null, 2));
    const rows = evaluateObligations({ root: dir }).obligations || [];
    assert.equal(rows.length, 2, 'обе обязанности посчитаны');
    for (const row of rows) {
      assert.equal(row.ok, false, row.id + ': сломанная объявленная папка — провал, а не ok:true');
      assert.match(String(row.detail), /folder-broken/u, row.id + ': detail называет папку: ' + row.detail);
    }
    const gate = await handlePreExecute({
      exec: { name: 'project_graph_spawn', arguments: { node: 'worker', prompt: 'проверка' } },
      root: dir,
    });
    assert.equal(gate && gate.kind, 'deny', 'гейт отказал при сломанной папке');
    assert.match(String(gate.reason), /folder-broken/u, 'отказ называет папку: ' + String(gate.reason));
  });
});

test('0280 A5: долг прочтения считает одна функция — answer/ack не создают долга', () => {
  const rows = [
    { path: 'req', status: 'request' },
    { path: 'question', status: 'question' },
    { path: 'report', status: 'report' },
    { path: 'answer', status: 'answer' },
    { path: 'ack', status: 'ACK' },
    { path: 'no-status', status: '' },
  ];
  assert.deepEqual(unreadDebtRows(rows).map((row) => row.path), ['req', 'question', 'report', 'no-status'],
    'закрывающие письма не создают долга прочтения');
  assert.deepEqual(unreadDebtRows(null), [], 'пустой вход — пустой долг');
});

test('0280 A11: --mark вместе с --gate отклоняется кодом 2', async () => {
  await withStore(async (store) => {
    const dir = fixture(OBLIGATIONS);
    const run = runCli(['--root', dir, '--gate', '--mark', 'req.md'], store);
    assert.equal(run.code, 2, 'сочетание режимов — отказ, а не молчаливая отметка: ' + run.out.slice(0, 300));
    assert.match(run.out, /вместе/u, 'причина названа');
  });
});

test('0280 A6: --gate fail-closed при нечитаемой структуре', async () => {
  await withStore(async (store) => {
    const dir = tempDir('pg-0280-broken-structure-');
    fs.mkdirSync(path.join(dir, 'structure'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'structure', 'graph.json'), '{ битый');
    const run = runCli(['--root', dir, '--gate'], store);
    assert.equal(run.code, 2, 'нечитаемая структура — отказ кодом 2: ' + run.out.slice(0, 300));
    assert.match(run.out, /структура не прочитана/u, 'причина названа');
  });
});

test('0280 B4: единственное непрочитанное Status: answer — не долг прочтения, но письмо непрочитано', async () => {
  await withStore(async () => {
    const dir = fixture(OBLIGATIONS);
    letter(dir, 'answer-only.md', { status: 'answer', subject: 'ответ' });
    /* Счётчик сканера отвечает «адресовано и не отмечено» — письмо непрочитано. */
    assert.equal(scanExchange({ root: dir }).unread.length, 1, 'answer адресован и не отмечен — он непрочитан');
    const rows = evaluateObligations({ root: dir }).obligations || [];
    const unreadRow = rows.find((row) => row.id === 'exchange-unread');
    assert.equal(unreadRow.ok, true, 'закрывающее письмо — реакция, а не долг прочтения');
    assert.match(String(unreadRow.detail), /непрочитано 0/u, 'в долге прочтения 0: ' + unreadRow.detail);
    const openRow = rows.find((row) => row.id === 'exchange-open');
    assert.equal(openRow.ok, true, 'answer без адреса не создаёт заявки');
    assert.deepEqual(unreadDebtRows(scanExchange({ root: dir }).unread), [], 'общая функция долга тоже исключает answer');
  });
});

test('0280 T2: exchange-recover --store берёт прежнюю память, если нового файла нет', async () => {
  await withStore(async () => {
    const dir = tempDir('pg-0280-legacy-cli-');
    const legacyFile = path.join(dir, ['exchange', 'seen.json'].join('-'));
    const journal = path.join(dir, 'exchange-decisions.jsonl');
    const letterPath = path.join(dir, 'letters', 'a.md');
    fs.mkdirSync(path.dirname(letterPath), { recursive: true });
    fs.writeFileSync(letterPath, 'From: workflow\nTo: structure\nDate: 2026-11-03T10:00+03:00\nStatus: report\n\nтело\n');
    fs.writeFileSync(legacyFile, JSON.stringify({ [letterPath]: 1000 }, null, 1));
    fs.writeFileSync(journal, '');
    const result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'exchange-recover.mjs'),
      '--store', dir, '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, 'CLI вышел 0: ' + String(result.stderr || result.stdout).slice(0, 300));
    const body = JSON.parse(String(result.stdout));
    assert.equal(body.seenKind, 'legacy', 'нового файла нет — CLI читает прежнюю память как миграцию');
    assert.deepEqual(body.falseSeen, [letterPath], 'числовая отметка вручения без решения — ложная');
  });
});
