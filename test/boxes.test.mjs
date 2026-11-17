#!/usr/bin/env node
/**
 * Один резолвер ящика (задание 0078).
 *
 * Набор доказывает пять обещаний контракта:
 *   1) shared и workspace в одном воркспейсе — два разных каталога, письма
 *      считаются по одному разу;
 *   2) неоднозначный shared (несколько кандидатов) — явная ошибка с кандидатами;
 *   3) один каталог у двух папок — duplicate-box с обоими id;
 *   4) workspace без shared — root + box.path;
 *   5) папка без paths — общий корень по roots участников.
 *
 * Фикстуры живут во временных каталогах; отметки чтения — в своём хранилище,
 * живой ~/.dsh не трогается.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBox, resolveBoxes } from '../lib/boxes.js';
import { scanExchange } from '../lib/obligations.js';

process.env.DSH_PROJECT_GRAPH_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-boxes-store-'));

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

const LETTER = (to, subject) => 'Format: dsh-exchange/1\nFrom: designer\nTo: ' + to
  + '\nDate: 2026-11-05T09:00:00+03:00\nThread: critic-report\nSession: session-x\n'
  + 'Status: report\nSubject: ' + subject + '\n\nтекст\n';

function put(dir, name, to, subject) {
  const target = path.join(dir, 'threads', 'critic-report');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, name), LETTER(to, subject));
}

/** Общий родитель и два воркспейса участников, как у заказчика. */
function workspacePair() {
  const common = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-boxes-common-')));
  const mine = fs.realpathSync(fs.mkdtempSync(path.join(common, 'ws-a-')));
  const design = fs.realpathSync(fs.mkdtempSync(path.join(common, 'ws-design-')));
  fs.mkdirSync(path.join(mine, 'structure'), { recursive: true });
  return { common, mine, design };
}

function writeGraph(root, folders) {
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор', provider: 'probe', model: 'probe-1' }],
    edges: [],
    folders,
  }, null, 2));
}

const folder = (id, box, extra = {}) => ({ id, box, participants: ['structure', 'designer'], orchestrator: 'coordinator', ...extra });

test('shared и workspace в одном воркспейсе — два разных каталога, письма по одному разу', () => {
  const { common, mine, design } = workspacePair();
  put(path.join(common, 'coordination'), '01.md', 'structure', 'общий портал');
  put(path.join(mine, 'coordination'), '02.md', 'structure', 'свой каталог');
  writeGraph(mine, [
    folder('folder-1', { path: 'coordination', root: 'shared' }, { participants: ['structure', 'designer'], paths: { structure: mine, designer: design } }),
    folder('folder-2', { path: 'coordination', root: 'workspace' }, { participants: ['structure', 'ws-school-app'] }),
  ]);
  const resolved = resolveBoxes({ root: mine });
  assert.equal(resolved.boxes.length, 2);
  const shared = resolved.boxes.find((row) => row.folderId === 'folder-1');
  const own = resolved.boxes.find((row) => row.folderId === 'folder-2');
  assert.equal(shared.status, 'ok');
  assert.equal(own.status, 'ok');
  assert.notEqual(path.resolve(shared.path), path.resolve(own.path), 'shared не склеен с workspace');
  assert.equal(path.resolve(shared.path), path.join(common, 'coordination'));
  assert.equal(path.resolve(own.path), path.join(mine, 'coordination'));
  const scan = scanExchange({ root: mine });
  const paths = scan.unread.map((row) => path.resolve(row.path));
  assert.equal(paths.length, 2, 'по письму из каждого ящика');
  assert.equal(new Set(paths).size, 2, 'одно письмо не посчитано дважды');
});

test('неоднозначный shared — явная ошибка с кандидатами, а не ближайший предок', () => {
  const { common, mine } = workspacePair();
  put(path.join(common, 'coordination'), '01.md', 'structure', 'общий портал');
  put(path.join(mine, 'coordination'), '02.md', 'structure', 'свой каталог');
  writeGraph(mine, [
    folder('folder-1', { path: 'coordination', root: 'shared' }, { participants: ['structure', 'designer'], paths: {} }),
    folder('folder-2', { path: 'coordination', root: 'workspace' }, { participants: ['structure', 'ws-school-app'] }),
  ]);
  const resolved = resolveBoxes({ root: mine });
  const row = resolved.boxes.find((item) => item.folderId === 'folder-1');
  assert.equal(row.status, 'error');
  assert.equal(row.code, 'shared-ambiguous');
  assert.ok(Array.isArray(row.candidates) && row.candidates.length >= 2, 'кандидаты названы: ' + JSON.stringify(row.candidates));
  assert.ok(resolved.problems.some((item) => item.code === 'shared-ambiguous'));
});

test('один каталог у двух папок — duplicate-box с обоими id', () => {
  const { common, mine, design } = workspacePair();
  fs.mkdirSync(path.join(common, 'coordination'), { recursive: true });
  writeGraph(mine, [
    folder('folder-1', { path: 'coordination', root: 'shared' }, { participants: ['structure', 'designer'], paths: { structure: mine, designer: design } }),
    folder('folder-2', { path: 'coordination', root: 'shared' }, { participants: ['structure', 'ws-school-app'] }),
  ]);
  const resolved = resolveBoxes({ root: mine });
  const duplicate = resolved.problems.find((item) => item.code === 'duplicate-box');
  assert.ok(duplicate, 'дубль назван: ' + JSON.stringify(resolved.problems));
  assert.deepEqual([...duplicate.folderIds].sort(), ['folder-1', 'folder-2']);
  assert.equal(resolved.boxes.find((row) => row.folderId === 'folder-2').status, 'error', 'второй ящик — ошибка, а не двойной счёт');
});

test('workspace без shared: ящик внутри своего воркспейса', () => {
  const { mine } = workspacePair();
  writeGraph(mine, [folder('folder-1', { path: 'coordination', root: 'workspace' })]);
  const resolved = resolveBoxes({ root: mine });
  assert.equal(resolved.boxes[0].status, 'ok');
  assert.equal(path.resolve(resolved.boxes[0].path), path.join(mine, 'coordination'));
});

test('папка без paths — общий корень по roots участников', () => {
  const { common, mine, design } = workspacePair();
  fs.mkdirSync(path.join(common, 'coordination'), { recursive: true });
  const result = resolveBox({
    root: mine,
    folder: folder('folder-1', { path: 'coordination', root: 'shared' }, { participants: ['structure', 'designer'], paths: {} }),
    roots: [mine, design],
  });
  assert.equal(result.status, 'ok');
  assert.equal(path.resolve(result.path), path.join(common, 'coordination'));
});

test('shared не выбирает каталог внутри своего воркспейса, когда есть пути участников', () => {
  const { mine } = workspacePair();
  const inside = path.join(mine, 'nested-designer');
  fs.mkdirSync(inside, { recursive: true });
  const result = resolveBox({
    root: mine,
    folder: folder('folder-1', { path: 'coordination', root: 'shared' }, {
      participants: ['structure', 'designer'],
      paths: { structure: mine, designer: inside },
    }),
  });
  assert.equal(result.status, 'error', 'общий предок внутри своего воркспейса — отказ');
  assert.equal(result.code, 'shared-ambiguous');
  assert.match(result.message, /своего воркспейса/u);
});

test('shared без путей не занимает каталог соседней workspace-папки', () => {
  const { mine } = workspacePair();
  fs.mkdirSync(path.join(mine, 'coordination'), { recursive: true });
  writeGraph(mine, [
    folder('folder-1', { path: 'coordination', root: 'shared' }, { participants: ['structure', 'designer'], paths: {} }),
    folder('folder-2', { path: 'coordination', root: 'workspace' }, { participants: ['structure', 'ws-school-app'] }),
  ]);
  const resolved = resolveBoxes({ root: mine });
  const shared = resolved.boxes.find((row) => row.folderId === 'folder-1');
  assert.equal(shared.status, 'error', 'каталог соседней папки не выбран молча');
  assert.equal(shared.code, 'shared-ambiguous');
  assert.ok(shared.candidates.some((item) => path.resolve(item) === path.join(mine, 'coordination')));
});

test('shared с одним корнем — отказ с рецептом (то же правило для панели)', () => {
  const { mine } = workspacePair();
  const result = resolveBox({
    root: mine,
    folder: folder('folder-1', { path: 'coordination', root: 'shared' }, { participants: ['structure', 'designer'] }),
    roots: [mine],
  });
  assert.equal(result.status, 'error');
  assert.match(result.message, /минимум двух участников/u);
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error((failure.error && failure.error.stack) || failure.error);
}
console.log(failures.length === 0
  ? 'BOXES TEST OK: ' + passed + ' проверок — shared/workspace, неоднозначность, дубль, workspace без shared и roots участников'
  : 'BOXES TEST FAILED: ' + failures.length + ' из ' + total);
process.exit(failures.length === 0 ? 0 : 1);
