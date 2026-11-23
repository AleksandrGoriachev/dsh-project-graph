#!/usr/bin/env node
/**
 * Задание 0296 — каскадное удаление декларации папки обмена (вариант «а»).
 *
 *   c1  две структуры с одной папкой (общий ящик, общая метка): удаление в B
 *       снимает декларацию в A; каталог ящика, контракт и письма целы
 *   c2  папка с другим ящиком не тронута; недоступная структура — warning,
 *       остальные структуры обработаны
 *   c3  ответ panel-маршрута несёт removedIn/warnings, повторный каскад
 *       идемпотентен
 *
 * Каждый кейс — своя временная пара структур и свой runtime.
 *   node --test test/folder-cascade.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cascadeFolderRemoval, createGraphRuntime, saveFolder } from '../lib/api.js';

/* Хранилище проекта — в temp: набор не должен трогать реальный ~/.dsh. */
process.env.DSH_PROJECT_GRAPH_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cascade-0296-store-'));

const CONTRACT = 'contract.md';
const CONTRACT_TEXT = [
  'Format: dsh-exchange/1-contract',
  'Rev: 1',
  'Initiator: b',
  'Invited: a',
  'Created: 2026-11-18T12:00+03:00',
  '',
].join('\n');

function graphFile(root) {
  return path.join(root, 'structure', 'graph.json');
}

function readFolders(root) {
  return JSON.parse(fs.readFileSync(graphFile(root), 'utf8')).folders || [];
}

/**
 * Воркспейс с валидной структурой: узел-оркестратор объявлен, папки — списком.
 * Структура валидна и до, и после удаления папки, иначе каскад откатил бы запись.
 */
function workspace(base, name, folders) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(graphFile(root), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders,
  }, null, 2) + '\n');
  return root;
}

/** Ящик одного участника: каталог, контракт и письмо — всё, что каскад НЕ трогает. */
function mailBox(root) {
  const box = path.join(root, 'coordination');
  fs.mkdirSync(path.join(box, 'threads', 'exchange'), { recursive: true });
  fs.writeFileSync(path.join(box, CONTRACT), CONTRACT_TEXT);
  fs.writeFileSync(path.join(box, 'threads', 'exchange', 'letter.md'), [
    'Format: dsh-exchange/1',
    'Status: info',
    '',
    'письмо должно остаться',
    '',
  ].join('\n'));
  return box;
}

function folderDeclaration(over = {}) {
  return {
    id: 'folder-1',
    box: { path: 'coordination', root: 'workspace' },
    participants: ['b', 'a'],
    orchestrator: 'coordinator',
    exchange: { contract: CONTRACT, threads: ['exchange'] },
    ...over,
  };
}

/**
 * Пара участников, объявивших ОДИН ящик по-разному: A — общим (shared от общего
 * предка), B — своим (workspace). Канонический путь у обеих папок один.
 */
function pairedFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cascade-0296-'));
  const a = workspace(base, 'ws-a', [
    folderDeclaration({
      id: 'folder-a',
      box: { path: 'ws-b/coordination', root: 'shared' },
      participants: ['a', 'b'],
    }),
  ]);
  const b = workspace(base, 'ws-b', [
    folderDeclaration({ id: 'folder-b', box: { path: 'coordination', root: 'workspace' }, participants: ['b', 'a'] }),
  ]);
  const box = mailBox(b);
  const runtime = createGraphRuntime({ roots: [a, b], structureDir: 'structure', participants: { a, b } });
  return { base, a, b, box, runtime };
}

await test('c1: удаление в B снимает декларацию в A; ящик и файлы целы', () => {
  const { a, b, box, runtime } = pairedFixture();
  const folder = readFolders(b)[0];
  const res = cascadeFolderRemoval(runtime, b, folder);

  assert.deepEqual(res.warnings, [], 'обе структуры читаются, предупреждений нет');
  const removedA = res.removed.find((row) => row.root === a);
  assert.ok(removedA, 'декларация в A названа в removed: ' + JSON.stringify(res));
  assert.equal(removedA.id, 'folder-a', 'id чужой папки может отличаться от удаляемой');
  assert.equal(removedA.file, 'structure/graph.json', 'файл декларации назван логическим именем');

  assert.deepEqual(readFolders(a), [], 'в структуре A папки больше нет');
  assert.deepEqual(readFolders(b).map((item) => item.id), ['folder-b'], 'своя структура каскадом не правится');

  assert.ok(fs.existsSync(path.join(box, CONTRACT)), 'контракт ящика не удалён');
  assert.ok(fs.existsSync(path.join(box, 'threads', 'exchange', 'letter.md')), 'письмо ящика не удалено');

  const again = cascadeFolderRemoval(runtime, b, folder);
  assert.deepEqual(again.removed, [], 'повторный каскад идемпотентен: удалять нечего');
  assert.deepEqual(again.warnings, [], 'идемпотентный повтор — не ошибка');
});

await test('c2: папка с другим ящиком не тронута; битая структура — warning', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cascade-0296-neg-'));
  const a = workspace(base, 'ws-a', [
    folderDeclaration({
      id: 'folder-a',
      box: { path: 'ws-b/coordination', root: 'shared' },
      participants: ['a', 'b'],
    }),
  ]);
  const b = workspace(base, 'ws-b', [
    folderDeclaration({ id: 'folder-b', box: { path: 'coordination', root: 'workspace' }, participants: ['b', 'a'] }),
    folderDeclaration({ id: 'other', box: { path: 'other-coordination', root: 'workspace' }, participants: ['b', 'a'] }),
  ]);
  const box = mailBox(b);
  fs.mkdirSync(path.join(b, 'other-coordination'), { recursive: true });

  const broken = path.join(base, 'ws-broken');
  fs.mkdirSync(path.join(broken, 'structure'), { recursive: true });
  fs.writeFileSync(graphFile(broken), '{ broken json', 'utf8');

  const runtime = createGraphRuntime({
    roots: [a, b, broken],
    structureDir: 'structure',
    participants: { a, b, broken },
  });
  const res = cascadeFolderRemoval(runtime, a, readFolders(a)[0]);

  assert.ok(res.removed.some((row) => row.root === b && row.id === 'folder-b'), 'папка с тем же ящиком удалена: ' + JSON.stringify(res));
  assert.ok(!res.removed.some((row) => row.id === 'other'), 'папка с другим ящиком не удалена');
  assert.deepEqual(readFolders(b).map((item) => item.id).sort(), ['other'], 'в B осталась только папка другого ящика');
  assert.ok(fs.existsSync(path.join(box, CONTRACT)), 'ящик не тронут');
  assert.ok(res.warnings.some((row) => row.root === broken), 'битая структура названа в warnings: ' + JSON.stringify(res.warnings));
});

await test('c3: панель удаляет папку и отдаёт removedIn/warnings', () => {
  const { a, b, box, runtime } = pairedFixture();
  const res = saveFolder(runtime, b, 'remove', { id: 'folder-b' });

  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(res.removed, 'folder-b');
  assert.ok(Array.isArray(res.removedIn), 'ответ называет, где декларация снята');
  assert.ok(res.removedIn.some((row) => row.root === a && row.id === 'folder-a'), 'декларация A снята: ' + JSON.stringify(res.removedIn));
  assert.deepEqual(res.warnings, [], 'сбойных структур нет');
  assert.deepEqual(readFolders(a), [], 'A освобождена от висячей декларации');
  assert.deepEqual(readFolders(b), [], 'своя структура тоже пуста');
  assert.ok(fs.existsSync(path.join(box, 'threads', 'exchange', 'letter.md')), 'письма ящика целы после удаления через панель');
});
