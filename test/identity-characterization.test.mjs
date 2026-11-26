#!/usr/bin/env node
/**
 * Задание 0372 — характеризация адресации и доставки: зафиксировать как было.
 *
 * Поведение записано ДО правок 0373–0375. Тест описывает то, что система делает
 * сегодня, включая известные дефекты, чтобы следующая задача меняла поведение
 * осознанно: падение этого файла — сигнал, что срез сдвинулся.
 *
 *   A. Область обмена — declaredExchangeWorkspaces видит участников-метки,
 *      участников-абсолютные пути и объявленные пути папки (0374).
 *   B. Состав папки — участие воркспейса сопоставляется со строками participants
 *      и с объявленными путями папки (0374), без учёта регистра.
 *   C. База ящика — без путей запись (presence) и чтение дают одну базу, круговая
 *      сверка проходит; с путями (0375) базы тоже совпадают — чтение несёт
 *      объявленные пути папки.
 *   D. Повтор письма — письмо в окне повтора получает причину пропуска, остаётся
 *      в очереди и рассматривается снова на следующем проходе.
 *
 * Только временные каталоги, без сети и реальных ящиков. Время не течёт: проход
 * вызывается дважды с явными метками, реального ожидания нет.
 *
 *   node test/identity-characterization.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGraph } from '../lib/api.js';
import {
  createExchangeWatcher, declaredExchangeScope, declaredExchangeWorkspaces, decisionsPath,
  readExchangeFolders,
} from '../lib/exchange-watch.js';
import { announcePresence, presenceBoxes } from '../lib/index.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}
async function atest(name, body) {
  try { await body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

/** Один общий временный корень; участники — A и B, ящик — общий каталог рядом. */
function host(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-char-' + tag + '-'));
  const project = path.join(base, 'project');
  const structure = path.join(project, 'ws-structure');
  const workflow = path.join(project, 'ws-workflow');
  fs.mkdirSync(path.join(structure, 'structure'), { recursive: true });
  fs.mkdirSync(workflow, { recursive: true });
  const box = path.join(project, 'coordination');
  fs.mkdirSync(path.join(box, 'threads', 'critic-report'), { recursive: true });
  return { base, project, structure, workflow, box, thread: path.join(box, 'threads', 'critic-report') };
}

/** Структура объявлена в structure/graph.json — как её читает и панель, и сторож. */
function writeGraph(h, folders) {
  fs.writeFileSync(path.join(h.structure, 'structure', 'graph.json'), JSON.stringify({
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    folders,
    edges: [],
  }, null, 2));
}

/** Стенд сторожа: те же поля, что даёт плагин; store — во временном каталоге. */
function runtimeOf(roots, extra = {}) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-char-runs-'));
  return {
    allowedRoots: () => roots,
    exchange: [],
    participants: {},
    me: null,
    runs: new Map(),
    runsDir,
    structureDir: 'structure',
    ...extra,
  };
}

/** Решения сторожа: одна JSON-строка журнала — одно решение. */
function decisionsOf(runtime) {
  const file = decisionsPath(runtime);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Сравнение каталогов без зависимости от регистра и коротких имён 8.3. */
function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* временный каталог */ }
}

/* ==========================================================================
 * A. Область обмена: declaredExchangeWorkspaces
 * ==========================================================================
 * Функция собирает участников из folder.participants (метка — через карту
 * профиля, абсолютный путь — как есть). С 0374 читаются и объявленные пути папки
 * (folder.paths): объявленный только путями воркспейс в область попадает.
 */
test('A1: участники-метки разрешаются в воркспейсы', () => {
  const h = host('a1');
  try {
    writeGraph(h, [{
      id: 'folder-1', box: { path: 'coordination', root: 'shared' },
      participants: ['structure', 'workflow'], orchestrator: 'coordinator',
    }]);
    const runtime = runtimeOf([h.structure, h.workflow], {
      participants: { structure: h.structure, workflow: h.workflow },
    });
    const scope = declaredExchangeWorkspaces(runtime, [h.structure, h.workflow]);
    assert.deepEqual(scope, [h.structure, h.workflow], 'метки структура/воркспейс дают оба корня');
  } finally { rmrf(h.base); }
});

test('A2: участники-абсолютные пути принимаются как есть', () => {
  const h = host('a2');
  try {
    writeGraph(h, [{
      id: 'folder-1', box: { path: 'coordination', root: 'shared' },
      participants: [h.structure, h.workflow], orchestrator: 'coordinator',
    }]);
    const runtime = runtimeOf([h.structure, h.workflow]);
    const scope = declaredExchangeWorkspaces(runtime, [h.structure, h.workflow]);
    assert.deepEqual(scope, [h.structure, h.workflow], 'абсолютные пути участников видны');
  } finally { rmrf(h.base); }
});

test('A3: folder.paths входит в область обмена (0374)', () => {
  const h = host('a3');
  try {
    /*
     * Заказчик: обмен идёт между воркспейсами, названными в графе. Папка несёт
     * paths участников; с 0374 область обмена читает и participants, и объявленные
     * пути папки — второй участник, объявленный лишь путём, в область попадает.
     */
    writeGraph(h, [{
      id: 'folder-1', box: { path: 'coordination', root: 'shared' },
      participants: ['structure'],
      paths: { structure: h.structure, workflow: h.workflow },
      orchestrator: 'coordinator',
    }]);
    const runtime = runtimeOf([h.structure, h.workflow], {
      participants: { structure: h.structure },
    });
    const scope = declaredExchangeWorkspaces(runtime, [h.structure, h.workflow]);
    assert.deepEqual(scope, [h.structure, h.workflow],
      'в область попали и метка участника, и объявленный путь папки');
    assert.equal(scope.some((root) => samePath(root, h.workflow)), true,
      'воркспейс, объявленный только в folder.paths, виден (0374)');
    const info = declaredExchangeScope(runtime, [h.structure, h.workflow]);
    assert.deepEqual(info.roots, [h.structure, h.workflow], 'источники сопровождают те же корни');
    assert.deepEqual(info.sources.map((item) => item.source), ['participants', 'folders.paths'],
      'у каждого корня назван сработавший источник — для журнала');
  } finally { rmrf(h.base); }
});

/* ==========================================================================
 * B. Состав папки: folderHasParticipant
 * ==========================================================================
 * lib/index.js сопоставляет имя воркспейса со строками participants (без учёта
 * регистра) и, с 0374, с объявленными путями папки через lib/identity.js —
 * поэтому воркспейс, названный лишь путём, тоже считается участником.
 */
test('B1: воркспейс из participants — участник папки', () => {
  const h = host('b1');
  try {
    const graph = {
      nodes: [], edges: [],
      folders: [{
        id: 'by-label', box: { path: 'coordination', root: 'workspace' },
        participants: ['structure', 'workflow'],
      }],
    };
    const boxes = presenceBoxes({
      graph, root: h.structure, roots: [h.structure, h.workflow],
      workspace: 'workflow', participants: { structure: h.structure, workflow: h.workflow },
    });
    assert.equal(boxes.length, 1, 'участник по метке получает ящик');
    assert.ok(samePath(boxes[0].box, path.join(h.structure, 'coordination')),
      'ящик workspace-режима лежит в объявившем воркспейсе');
  } finally { rmrf(h.base); }
});

test('B2: воркспейс только в folder.paths — участник папки (0374)', () => {
  const h = host('b2');
  try {
    /*
     * Та же папка объявляет путь workflow, но в participants его нет: с 0374 проверка
     * участия читает и объявленные пути папки (через lib/identity.js), поэтому
     * воркспейс, названный лишь путём, получает ящик наравне с участником по метке.
     */
    const graph = {
      nodes: [], edges: [],
      folders: [{
        id: 'paths-only', box: { path: 'coordination', root: 'workspace' },
        participants: ['structure', 'other'],
        paths: { structure: h.structure, workflow: h.workflow },
      }],
    };
    const byPath = presenceBoxes({
      graph, root: h.structure, roots: [h.structure, h.workflow],
      workspace: 'workflow', participants: { structure: h.structure, workflow: h.workflow },
    });
    assert.equal(byPath.length, 1, 'объявленный путём воркспейс — участник папки');
    assert.ok(samePath(byPath[0].box, path.join(h.structure, 'coordination')),
      'ящик workspace-режима лежит в объявившем воркспейсе');
    const byLabel = presenceBoxes({
      graph, root: h.structure, roots: [h.structure, h.workflow],
      workspace: 'other', participants: { structure: h.structure, workflow: h.workflow },
    });
    assert.equal(byLabel.length, 1, 'участник из participants ящик получает');
  } finally { rmrf(h.base); }
});

test('B3: регистр строки участника не важен — так сопоставляет текущая проверка', () => {
  const h = host('b3');
  try {
    const graph = {
      nodes: [], edges: [],
      folders: [{
        id: 'by-label', box: { path: 'coordination', root: 'workspace' },
        participants: ['structure', 'workflow'],
      }],
    };
    const boxes = presenceBoxes({
      graph, root: h.structure, roots: [h.structure, h.workflow],
      workspace: 'WorkFlow', participants: { structure: h.structure, workflow: h.workflow },
    });
    assert.equal(boxes.length, 1, 'строка участника сравнивается без учёта регистра');
  } finally { rmrf(h.base); }
});

/* ==========================================================================
 * C. База ящика: запись (presence) и чтение
 * ==========================================================================
 * «Запись» — announcePresence: панель кладёт presence в разрешённый ящик.
 * «Чтение» — readExchangeFolders: сторож и панель читают ящик по объявлению.
 * Без путей обе стороны считают базу от корней участников и сходятся.
 * С путями (0375) — тоже сходятся: чтение получает folder.paths через readGraph,
 * и обе стороны считают базу от общего каталога объявленных путей.
 */
test('C1: без путей запись и чтение дают одну базу — круговая сверка проходит', () => {
  const h = host('c1');
  try {
    const folders = [{
      id: 'folder-1', box: { path: 'coordination', root: 'shared' },
      participants: ['structure', 'workflow'], orchestrator: 'coordinator',
    }];
    writeGraph(h, folders);
    const graph = { nodes: [], edges: [], folders };
    const runtime = runtimeOf([h.structure, h.workflow], {
      participants: { structure: h.structure, workflow: h.workflow },
    });
    const written = announcePresence({
      graph, root: h.structure, roots: [h.structure, h.workflow],
      workspace: 'structure', sessionId: 'session-char', participants: runtime.participants,
    });
    assert.equal(written.written.length, 1, 'presence записан в объявленный ящик');
    const read = readExchangeFolders(runtime, h.structure);
    assert.equal(read.length, 1, 'папка прочитана');
    assert.equal(read[0].error, undefined, 'у папки нет ошибки чтения');
    assert.ok(samePath(written.written[0].box, h.box), 'база записи — общий каталог участников');
    assert.ok(samePath(read[0].box, written.written[0].box),
      'чтение вернуло ту же базу: круговая сверка проходит');
    assert.equal(fs.existsSync(written.written[0].file), true, 'presence лежит в прочитанном ящике');
  } finally { rmrf(h.base); }
});

test('C2: с путями база записи и база чтения совпадают (0375)', () => {
  const h = host('c2');
  try {
    /*
     * Участник объявлен и путём: paths ведут к копии воркспейса в другом профиле.
     * Запись (announcePresence) читает folder.paths и поднимает базу до общего
     * каталога объявленных копий. С 0375 чтение (readExchangeFolders) получает тот
     * же folder.paths через readGraph, поэтому база считается по тому же правилу:
     * круговая сверка проходит, и presence оказывается в прочитанном ящике.
     */
    const portal = path.join(h.base, 'portal');
    const copy = path.join(portal, 'ws-workflow');
    fs.mkdirSync(copy, { recursive: true });
    const folders = [{
      id: 'folder-1', box: { path: 'coordination', root: 'shared' },
      participants: ['structure', 'workflow'],
      paths: { structure: h.structure, workflow: copy },
      orchestrator: 'coordinator',
    }];
    writeGraph(h, folders);
    const graph = { nodes: [], edges: [], folders };
    const runtime = runtimeOf([h.structure, h.workflow], {
      participants: { structure: h.structure, workflow: h.workflow },
    });
    const writeBoxes = presenceBoxes({
      graph, root: h.structure, roots: [h.structure, h.workflow],
      workspace: 'structure', participants: runtime.participants,
    });
    assert.equal(writeBoxes.length, 1, 'запись нашла ящик по объявленным путям');
    const written = announcePresence({
      graph, root: h.structure, roots: [h.structure, h.workflow],
      workspace: 'structure', sessionId: 'session-char', participants: runtime.participants,
    });
    assert.deepEqual(written.skipped, [], 'запись отказа не получила');
    const read = readExchangeFolders(runtime, h.structure);
    assert.equal(read.length, 1, 'папка прочитана');
    assert.equal(read[0].error, undefined, 'чтение не отказало');
    assert.ok(samePath(written.written[0].box, path.join(h.base, 'coordination')),
      'запись подняла базу до общего каталога объявленных путей');
    assert.ok(samePath(read[0].box, path.join(h.base, 'coordination')),
      'чтение считает ту же базу — общий каталог объявленных путей');
    assert.equal(samePath(written.written[0].box, read[0].box), true, 'базы совпадают (0375)');
    assert.equal(fs.existsSync(written.written[0].file), true, 'presence лежит в прочитанном ящике');
    /*
     * Механизм совпадения виден публично: граф, который читает readExchangeFolders,
     * несёт объявленные пути папки.
     */
    const payload = readGraph(runtime, h.structure);
    assert.deepEqual(payload.graph.folders[0].paths, folders[0].paths,
      'чтение получает folder.paths — поэтому база та же (0375)');
  } finally { rmrf(h.base); }
});

/* ==========================================================================
 * D. Повтор письма: окно повтора
 * ==========================================================================
 * Письмо в окне повтора не теряется и не считается доставленным: в журнале
 * появляется причина пропуска (skip:cooldown) с временем ожидания, а на
 * следующем проходе после окна письмо рассматривается снова и доставляется.
 * Проход вызывается с явными метками — реального времени тест не ждёт.
 */

/** Канал с таблицей «кто есть кто»: по ней сторож разрешает метку в воркспейс. */
function channelHost(tag) {
  const h = host(tag);
  fs.writeFileSync(path.join(h.project, 'README.md'), '');
  fs.writeFileSync(path.join(h.box, 'README.md'), [
    '# Канал',
    '',
    '| Сторона | Пространство | Что делает |',
    '| --- | --- | --- |',
    '| `structure` | `' + h.structure.replace(/\\/gu, '/') + '` | панель |',
    '| `workflow` | `' + h.workflow.replace(/\\/gu, '/') + '` | спека |',
    '',
  ].join('\n'));
  return h;
}

const LETTER = (subject) => 'From: structure\nTo: workflow\nDate: 2026-11-01T09:00:00+03:00'
  + '\nThread: critic-report\nStatus: request\nSubject: ' + subject + '\n\nтекст\n';

function liveAgent(id, cwd, label) {
  const inbox = [];
  return {
    id, sessionId: id, cwd, label,
    sendMessage: async (input) => { inbox.push(input.content?.[0]?.text); },
    inbox,
  };
}

await atest('D1: письмо в окне ветки получает причину пропуска и уходит следующим проходом', async () => {
  const h = channelHost('d1');
  try {
    const target = liveAgent('s-workflow', h.workflow, 'workflow');
    const runtime = runtimeOf([h.structure, h.workflow]);
    const watcher = createExchangeWatcher({
      runtime,
      seenPath: path.join(os.tmpdir(), 'pg-char-seen-d1-' + Date.now() + '.json'),
      getAgents: () => ({ list: () => [target] }),
      activityOf: () => new Map([['s-workflow', 1793528000000]]),
    });
    const start = new Date();
    fs.writeFileSync(path.join(h.thread, 'd1-a.md'), LETTER('первое'));
    assert.equal((await watcher.tick(start)).length, 1, 'первое письмо доставлено');
    /* Второе письмо той же ветки попадает в окно повтора (ветка только что будила). */
    fs.writeFileSync(path.join(h.thread, 'd1-b.md'), LETTER('второе'));
    const second = await watcher.tick(new Date(start.getTime() + 500));
    assert.equal(second.length, 0, 'в окне повтора письмо не доставляется');
    assert.equal(target.inbox.length, 1, 'второго сообщения нет');
    const blocked = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('d1-b.md'));
    assert.equal(blocked.length, 1, 'пропуск назван в журнале решений');
    assert.equal(blocked[0].branch, 'skip:cooldown', 'причина — окно повтора');
    assert.equal(blocked[0].limit, 'branch', 'держит окно ветки');
    assert.ok(Number(blocked[0].waitMs) > 0, 'сказано, сколько ждать');
    assert.equal(fs.existsSync(path.join(h.thread, 'd1-b.md')), true, 'письмо осталось в очереди');
    /* Следующий проход ПОСЛЕ окна: то же письмо рассматривается снова. */
    const third = await watcher.tick(new Date(start.getTime() + 125_000));
    assert.equal(third.length, 1, 'после окна письмо доставлено тем же проходом');
    assert.equal(target.inbox.length, 2, 'адресат получил второе сообщение');
    assert.match(String(target.inbox[1]), /d1-b\.md/u, 'доставлено именно отложенное письмо');
    const after = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('d1-b.md'));
    assert.deepEqual(after.map((row) => row.branch), ['skip:cooldown', 'delivered'],
      'одно письмо: пропуск, затем вручение — не потеряно');
  } finally { rmrf(h.base); }
});

await atest('D2: неудачная отправка открывает окно повтора — письмо ждёт и уходит повторно', async () => {
  const h = channelHost('d2');
  try {
    /*
     * Первая отправка падает — это не «письмо решено», а «попытка была»: окно
     * повтора. На проходе внутри окна журнал называет причину с waitMs, письмо
     * остаётся в очереди; на проходе после окна доставка повторяется.
     */
    const inbox = [];
    let attempts = 0;
    const flaky = {
      id: 's-workflow', sessionId: 's-workflow', cwd: h.workflow, label: 'workflow',
      sendMessage: async (input) => {
        attempts += 1;
        if (attempts === 1) throw new Error('служба не приняла сообщение');
        inbox.push(input.content?.[0]?.text);
      },
    };
    const runtime = runtimeOf([h.structure, h.workflow]);
    const watcher = createExchangeWatcher({
      runtime,
      seenPath: path.join(os.tmpdir(), 'pg-char-seen-d2-' + Date.now() + '.json'),
      getAgents: () => ({ list: () => [flaky] }),
      activityOf: () => new Map([['s-workflow', 1793528000000]]),
    });
    const start = new Date();
    fs.writeFileSync(path.join(h.thread, 'd2.md'), LETTER('с повтором'));
    assert.equal((await watcher.tick(start)).length, 0, 'первая отправка не удалась');
    const failed = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('d2.md'));
    assert.equal(failed.length, 1, 'отказ отправки назван');
    assert.match(String(failed[0].branch || ''), /^error:/u, 'ветка отказа');
    assert.equal(inbox.length, 0, 'адресат ничего не получил');
    /* Проход внутри окна: причина пропуска, письмо не вручено и не потеряно. */
    assert.equal((await watcher.tick(new Date(start.getTime() + 5000))).length, 0,
      'в окне повтора повторной отправки нет');
    const waiting = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('d2.md'));
    assert.equal(waiting.length, 2, 'второе решение — о пропуске');
    assert.equal(waiting[1].branch, 'skip:cooldown', 'причина — окно повтора');
    assert.ok(Number(waiting[1].waitMs) > 0, 'сказано, сколько ждать');
    assert.equal(fs.existsSync(path.join(h.thread, 'd2.md')), true, 'письмо осталось в очереди');
    /* Проход после окна: письмо рассматривается снова и доставляется. */
    assert.equal((await watcher.tick(new Date(start.getTime() + 125_000))).length, 1,
      'после окна повторная отправка состоялась');
    assert.equal(inbox.length, 1, 'адресат получил письмо');
    assert.match(String(inbox[0]), /d2\.md/u, 'доставлено именно отложенное письмо');
    assert.equal(attempts, 2, 'письмо рассмотрено дважды: попытка, затем повтор');
    const after = decisionsOf(runtime).filter((row) => String(row.letter || '').endsWith('d2.md'));
    assert.deepEqual(after.map((row) => row.branch).slice(0, 2).map((branch) => /^error:/u.test(branch) ? 'error' : branch),
      ['error', 'skip:cooldown'], 'журнал: отказ, затем причина ожидания');
    assert.equal(after[after.length - 1].branch, 'delivered', 'и вручение последним решением');
  } finally { rmrf(h.base); }
});

if (failures.length > 0) {
  for (const item of failures) {
    console.log('FAIL ' + item.name + ': ' + (item.error && item.error.message ? item.error.message : item.error));
  }
  console.log('IDENTITY CHARACTERIZATION FAIL: ' + passed + '/' + (passed + failures.length));
  process.exit(1);
}
console.log('IDENTITY CHARACTERIZATION OK: ' + passed + '/' + passed);
console.log('A: declaredExchangeWorkspaces — метки, абсолютные пути и объявленные пути папки видны (0374)');
console.log('B: folderHasParticipant — строки participants и объявленные пути папки (0374)');
console.log('C: база ящика — без путей и с путями круговая сверка проходит, базы совпадают (0375)');
console.log('D: окно повтора — причина пропуска, письмо остаётся в очереди и уходит следующим проходом');
