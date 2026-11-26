#!/usr/bin/env node
/**
 * Задание 0375 — ящик папки: объявленные пути доходят до чтения и записи.
 *
 *   1. пути папки доходят до чтения структуры как есть (формат не меняется);
 *   2. сохранение папки без правок сохраняет пути и адресацию: круг
 *      «прочитал — сохранил — прочитал» не меняет ни участников, ни пути;
 *   3. база ящика записи (presence) равна базе чтения (сторож) для папки с путями;
 *   4. папка без объявленных путей не изменилась: чтение поле paths не выдумывает,
 *      сохранение пишет путь из реестра (прежнее поведение 0024) и база та же;
 *   5. путь с буквой диска и без неё приводится к одному значению, и в файле не
 *      появляется путь без буквы диска.
 *
 * Только временные каталоги: временная структура, временный ящик, без сети.
 *
 *   node test/folder-paths.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGraph, saveFolder } from '../lib/api.js';
import { readExchangeFolders } from '../lib/exchange-watch.js';
import { presenceBoxes } from '../lib/index.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* временный каталог */ }
}

/** Сравнение каталогов без регистра и коротких имён 8.3 — правило проекта. */
function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

/**
 * Та же папка, записанная без буквы диска: на Windows это корневой путь текущего
 * диска («\\...» вместо «C:\\...»); на POSIX буквы диска нет — путь тот же.
 */
function driveLess(value) {
  const resolved = path.resolve(value);
  if (process.platform !== 'win32') return resolved;
  const without = resolved.slice(2);
  return path.resolve(without) === resolved ? without : resolved;
}

/**
 * Стенд папки с объявленными путями: второй участник объявлен копией в другом
 * профиле, поэтому база ящика — общий каталог объявленных путей (base), а не
 * каталог реальных корней (project).
 */
function hostPaths(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-folder-paths-' + tag + '-'));
  const project = path.join(base, 'project');
  const structure = path.join(project, 'ws-structure');
  const workflow = path.join(project, 'ws-workflow');
  const copy = path.join(base, 'portal', 'ws-workflow');
  for (const dir of [path.join(structure, 'structure'), workflow, copy]) fs.mkdirSync(dir, { recursive: true });
  const box = path.join(base, 'coordination');
  fs.mkdirSync(path.join(box, 'threads', 'critic-report'), { recursive: true });
  return { base, project, structure, workflow, copy, box };
}

/** Стенд папки без объявленных путей: база — общий каталог реальных корней. */
function hostPlain(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-folder-paths-' + tag + '-'));
  const project = path.join(base, 'project');
  const structure = path.join(project, 'ws-structure');
  const workflow = path.join(project, 'ws-workflow');
  for (const dir of [path.join(structure, 'structure'), workflow]) fs.mkdirSync(dir, { recursive: true });
  const box = path.join(project, 'coordination');
  fs.mkdirSync(path.join(box, 'threads', 'critic-report'), { recursive: true });
  return { base, project, structure, workflow, box };
}

/** Структура объявлена в structure/graph.json — как её читают панель и сторож. */
function writeStructure(h, folders) {
  fs.writeFileSync(path.join(h.structure, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    folders,
    edges: [],
  }, null, 2) + '\n');
}

function readFolderRecord(h) {
  const document = JSON.parse(fs.readFileSync(path.join(h.structure, 'structure', 'graph.json'), 'utf8'));
  return document.folders.find((item) => item && item.id === 'folder-1') || document.folders[0];
}

/** Стенд записи: те же поля, что даёт плагин; store — во временном каталоге. */
function runtimeOf(h, extra = {}) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-folder-paths-runs-'));
  return {
    allowedRoots: () => [h.structure, h.workflow],
    exchange: [],
    participants: { structure: h.structure, workflow: h.workflow },
    me: 'structure',
    runs: new Map(),
    runsDir,
    structureDir: 'structure',
    ...extra,
  };
}

/** Папка с участниками объявленными путями; обмен выключен — тест не пишет контракт. */
function folderWithPaths(h, paths) {
  return {
    id: 'folder-1',
    box: { path: 'coordination', root: 'shared' },
    participants: ['structure', 'workflow'],
    paths,
    orchestrator: 'coordinator',
    exchange: false,
  };
}

/** Папка без объявленных путей — прежняя форма объявления. */
function folderPlain() {
  return {
    id: 'folder-1',
    box: { path: 'coordination', root: 'shared' },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    exchange: false,
  };
}

/** Тело сохранения панели: ровно поля прочитанной папки, без paths. */
function panelBody(folder) {
  return {
    id: folder.id,
    box: folder.box,
    participants: folder.participants,
    orchestrator: folder.orchestrator,
    exchange: folder.exchange === undefined ? false : folder.exchange,
  };
}

/* ==========================================================================
 * 1. Пути доходят до чтения структуры как есть
 * ========================================================================== */
test('1: чтение структуры несёт объявленные пути папки', () => {
  const h = hostPaths('read');
  try {
    const declared = { structure: h.structure, workflow: h.copy };
    writeStructure(h, [folderWithPaths(h, declared)]);
    const payload = readGraph(runtimeOf(h), h.structure);
    assert.deepEqual(payload.errors, [], 'структура без ошибок');
    const folder = payload.graph.folders.find((item) => item.id === 'folder-1');
    assert.ok(folder, 'папка прочитана');
    assert.deepEqual(folder.paths, declared, 'объявленные пути дошли до чтения как есть');
    assert.deepEqual(folder.participants, ['structure', 'workflow'], 'участники остались подписями');
    assert.deepEqual(folder.box, { path: 'coordination', root: 'shared' }, 'формат объявления не изменился');
  } finally { rmrf(h.base); }
});

/* ==========================================================================
 * 2. Сохранение без правок сохраняет пути и адресацию
 * ========================================================================== */
test('2: сохранение без правок сохраняет пути, участников и адресацию', () => {
  const h = hostPaths('save');
  try {
    const declared = { structure: h.structure, workflow: h.copy };
    writeStructure(h, [folderWithPaths(h, declared)]);
    const runtime = runtimeOf(h);
    const folder = readGraph(runtime, h.structure).graph.folders[0];
    const saved = saveFolder(runtime, h.structure, 'update', { folder: panelBody(folder) });
    assert.equal(saved.status, 200, JSON.stringify(saved));

    const record = readFolderRecord(h);
    assert.deepEqual(record.paths, declared, 'пути сохранены, а не подменены метками');
    assert.deepEqual(record.participants, ['structure', 'workflow'], 'участники — прежний список меток');
    assert.deepEqual(record.box, folder.box, 'адресация та же');
    assert.deepEqual(saved.folder.paths, declared, 'ответ сохранения несёт те же пути');

    const after = readGraph(runtime, h.structure);
    assert.deepEqual(after.errors, [], 'после сохранения структура валидна');
    assert.deepEqual(after.graph.folders[0].paths, declared, 'круг «прочитал — сохранил — прочитал»');

    /* Повторное сохранение без правок не меняет ни участников, ни пути. */
    const again = saveFolder(runtime, h.structure, 'update', { folder: panelBody(after.graph.folders[0]) });
    assert.equal(again.status, 200, JSON.stringify(again));
    const second = readFolderRecord(h);
    assert.deepEqual(second.paths, record.paths, 'повторное сохранение не изменило пути');
    assert.deepEqual(second.participants, record.participants, 'повторное сохранение не изменило участников');
  } finally { rmrf(h.base); }
});

/* ==========================================================================
 * 3. База записи равна базе чтения для папки с путями
 * ========================================================================== */
test('3: база ящика записи (presence) равна базе чтения (сторож) для папки с путями', () => {
  const h = hostPaths('base');
  try {
    writeStructure(h, [folderWithPaths(h, { structure: h.structure, workflow: h.copy })]);
    const runtime = runtimeOf(h);
    const graph = readGraph(runtime, h.structure).graph;
    const expected = path.join(h.base, 'coordination');

    const write = presenceBoxes({
      graph, root: h.structure, roots: [h.structure, h.workflow],
      workspace: 'structure', participants: runtime.participants,
    });
    assert.equal(write.length, 1, 'запись нашла ящик по объявленным путям');
    assert.ok(samePath(write[0].box, expected), 'запись: база — общий каталог объявленных путей');

    const readRows = readExchangeFolders(runtime, h.structure);
    assert.equal(readRows.length, 1, 'папка прочитана сторожем');
    assert.equal(readRows[0].error, undefined, 'чтение не отказало');
    assert.ok(samePath(readRows[0].box, write[0].box), 'чтение указывает ту же папку, что и запись');
  } finally { rmrf(h.base); }
});

/* ==========================================================================
 * 4. Папка без путей: поведение прежнее
 * ========================================================================== */
test('4: папка без путей не изменилась', () => {
  const h = hostPlain('plain');
  try {
    writeStructure(h, [folderPlain()]);
    const runtime = runtimeOf(h);
    const folder = readGraph(runtime, h.structure).graph.folders[0];
    assert.equal('paths' in folder, false, 'чтение не выдумывает поле paths');

    const before = readExchangeFolders(runtime, h.structure);
    assert.equal(before.length, 1, 'папка прочитана');
    assert.ok(samePath(before[0].box, h.box), 'база чтения — общий каталог реальных корней');

    const saved = saveFolder(runtime, h.structure, 'update', { folder: panelBody(folder) });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    const record = readFolderRecord(h);
    assert.deepEqual(record.participants, ['structure', 'workflow'], 'участники не изменились');
    /* Прежнее поведение 0024: у папки без paths путь пишется из реестра. */
    assert.deepEqual(record.paths, { structure: path.resolve(h.structure), workflow: path.resolve(h.workflow) },
      'путь метки по-прежнему берётся из реестра');

    const after = readExchangeFolders(runtime, h.structure);
    assert.ok(samePath(after[0].box, before[0].box), 'база ящика та же: папка без путей не сдвинулась');
  } finally { rmrf(h.base); }
});

/* ==========================================================================
 * 5. Путь с буквой диска и без неё — одно значение
 * ========================================================================== */
test('5: путь с буквой диска и без приводится к одному значению', () => {
  const h = hostPaths('drive');
  try {
    const withDrive = path.resolve(h.copy);
    const withoutDrive = driveLess(h.copy);
    writeStructure(h, [folderWithPaths(h, { structure: h.structure, workflow: withoutDrive })]);
    const runtime = runtimeOf(h);

    const folder = readGraph(runtime, h.structure).graph.folders[0];
    assert.equal(folder.paths.workflow, withoutDrive, 'чтение несёт объявленный путь как есть');

    /* База ящика считается тем же значением, что и у пути с буквой диска. */
    const write = presenceBoxes({
      graph: { nodes: [], edges: [], folders: [folder] }, root: h.structure,
      roots: [h.structure, h.workflow], workspace: 'structure', participants: runtime.participants,
    });
    assert.equal(write.length, 1, 'ящик разрешился');
    assert.ok(samePath(write[0].box, path.join(h.base, 'coordination')),
      'база ящика — общий каталог путей, буква диска не решает');

    const saved = saveFolder(runtime, h.structure, 'update', { folder: panelBody(folder) });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    const record = readFolderRecord(h);
    assert.ok(samePath(record.paths.workflow, withDrive), 'сохранённый путь — тот же каталог');
    assert.ok(samePath(record.paths.workflow, withoutDrive), 'приведён к одному значению');
    assert.equal(record.paths.workflow, path.resolve(withoutDrive),
      'в файле записан канонический путь (path.resolve исходного)');
    if (process.platform === 'win32' && withoutDrive !== withDrive) {
      assert.match(record.paths.workflow, /^[A-Za-z]:[\\/]/u, 'в файле не появился путь без буквы диска');
    }
  } finally { rmrf(h.base); }
});

if (failures.length > 0) {
  for (const item of failures) {
    console.log('FAIL ' + item.name + ': ' + (item.error && item.error.message ? item.error.message : item.error));
  }
  console.log('FOLDER PATHS FAIL: ' + passed + '/' + (passed + failures.length));
  process.exit(1);
}
console.log('FOLDER PATHS OK: ' + passed + '/' + passed);
console.log('1 пути доходят до чтения; 2 сохранение без правок сохраняет пути; 3 база записи = база чтения; '
  + '4 папка без путей не изменилась; 5 путь с буквой диска и без — одно значение');
