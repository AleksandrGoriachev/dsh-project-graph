#!/usr/bin/env node
/**
 * Задание 0201 — join: id-conflict, force+backup, Folder-Id.
 *
 *   c1  занятый id другой папкой — 409 id-conflict с reason/freeIds и структурой
 *       байт-в-байт; повторный join той же папки — не конфликт, квитанция несёт Reason
 *   c2  force:false при конфликте — 409 без backup; force:true — backup до записи,
 *       запись заменена, путь backup в ответе
 *   c3  письмо-приглашение несёт Folder-Id рядом с Rev/Box
 *
 * Каждый кейс самостоятелен: своя временная структура, свой ящик, свой runtime.
 *   node test/join.test.mjs c1|c2|c3
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime, saveFolder } from '../lib/api.js';

/* Хранилище проекта — в temp: набор не должен трогать реальный ~/.dsh. */
process.env.DSH_PROJECT_GRAPH_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-join-0201-store-'));

const CONTRACT = 'contract-folder-1.md';
const CONTRACT_TEXT = [
  'Format: dsh-exchange/1-contract',
  'Rev: 1',
  'Initiator: structure',
  'Invited: workflow',
  'Created: 2026-11-11T10:00+03:00',
  '',
].join('\n');

function graphFile(root) {
  return path.join(root, 'structure', 'graph.json');
}

function bytesOf(root) {
  return fs.readFileSync(graphFile(root));
}

function backupFiles(root) {
  return fs.readdirSync(path.join(root, 'structure')).filter((name) => /^graph\.json\.bak-/u.test(name));
}

/** Воркспейс с ящиком внутри него: join объявит box { path: 'coordination', root: 'workspace' }. */
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-join-0201-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  const box = path.join(root, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  fs.writeFileSync(path.join(box, CONTRACT), CONTRACT_TEXT);
  return { root, box };
}

function writeFolder(root, folder) {
  const document = {
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders: [folder],
  };
  fs.writeFileSync(graphFile(root), JSON.stringify(document, null, 2) + '\n');
}

function runtimeFor(root) {
  return createGraphRuntime({ roots: [root], participants: { structure: root }, me: 'structure' });
}

/** Запись папки, которую join считает «той же»: box/contract/participants совпадают. */
function sameFolder(over = {}) {
  return {
    id: 'folder-1',
    box: { path: 'coordination', root: 'workspace' },
    exchange: { contract: CONTRACT },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    ...over,
  };
}

function joinBody(root, over = {}) {
  return {
    id: 'folder-1',
    box: path.join(root, 'coordination'),
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    ...over,
  };
}

function join(root, over = {}) {
  return saveFolder(runtimeFor(root), root, 'join', joinBody(root, over));
}

function assertConflict(result, root, before, fields) {
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(result.code, 'id-conflict', 'код отказа — id-conflict');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'отказ объясняет причину');
  for (const field of fields) {
    assert.match(result.reason + ' ' + result.error, new RegExp(field.replace('.', '\\.'), 'u'),
      'причина называет расхождение ' + field);
  }
  assert.ok(Array.isArray(result.freeIds) && result.freeIds.length > 0, 'freeIds названы: ' + JSON.stringify(result));
  for (const id of result.freeIds) {
    assert.match(id, /^[A-Za-z0-9._-]+$/u, 'freeId — допустимый id папки');
  }
  assert.ok(!result.freeIds.includes('folder-1'), 'занятый id не предлагается');
  assert.equal(typeof result.fix, 'string');
  assert.ok(result.fix.length > 0, 'отказ несёт рецепт');
  assert.ok(bytesOf(root).equals(before), 'структура не изменилась байт-в-байт');
  assert.deepEqual(backupFiles(root), [], 'без force backup не создаётся');
}

function c1() {
  /* 1. box.path: id занят папкой с другим ящиком. */
  {
    const { root } = workspace();
    fs.mkdirSync(path.join(root, 'other-box'), { recursive: true });
    writeFolder(root, sameFolder({ box: { path: 'other-box', root: 'workspace' } }));
    const before = bytesOf(root);
    assertConflict(join(root), root, before, ['box.path']);
  }
  /* 2. exchange.contract: join явно просит другое имя контракта. */
  {
    const { root } = workspace();
    writeFolder(root, sameFolder({ exchange: { contract: 'old-contract.md' } }));
    const before = bytesOf(root);
    assertConflict(join(root, { contract: CONTRACT }), root, before, ['exchange.contract']);
  }
  /* 3. participants: id занят папкой с другим списком сторон. */
  {
    const { root } = workspace();
    writeFolder(root, sameFolder({ participants: ['structure', 'ghost'] }));
    const before = bytesOf(root);
    assertConflict(join(root), root, before, ['participants']);
  }
  /* 4. paths: метка та же, а записанный путь стороны другой. */
  {
    const { root } = workspace();
    writeFolder(root, sameFolder({
      participants: ['structure'],
      paths: { structure: path.join(root, 'elsewhere') },
    }));
    const before = bytesOf(root);
    assertConflict(join(root, { participants: ['structure'] }), root, before, ['paths']);
  }
  /* 5. Повторный join той же папки — не конфликт; квитанция объясняет принятие. */
  {
    const { root, box } = workspace();
    writeFolder(root, sameFolder({ paths: { structure: root } }));
    const first = join(root);
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(first.folder.id, 'folder-1');
    assert.equal(first.reason, 'accepted', 'причина принятия в ответе');
    assert.ok(first.receipt, 'квитанция записана');
    const receipt = fs.readFileSync(path.join(box, first.receipt), 'utf8');
    assert.match(receipt, /^Status: accepted$/m);
    assert.match(receipt, /^Reason: accepted$/m, 'квитанция объясняет, почему папка принята');
    const again = join(root);
    assert.equal(again.status, 200, JSON.stringify(again));
    assert.equal(again.folder.id, 'folder-1', 'повторный join не плодит двойника');
  }
}

function c2() {
  const { root, box } = workspace();
  writeFolder(root, sameFolder({ participants: ['structure', 'ghost'] }));
  const before = bytesOf(root);

  /* force:false при конфликте — тот же 409, без backup. */
  const denied = join(root, { force: false });
  assert.equal(denied.status, 409, JSON.stringify(denied));
  assert.equal(denied.code, 'id-conflict');
  assert.ok(bytesOf(root).equals(before), 'force:false структуру не меняет');
  assert.deepEqual(backupFiles(root), [], 'force:false backup не создаёт');

  /* force:true — backup ДО записи, запись заменена, backup назван в ответе. */
  const forced = join(root, { force: true });
  assert.equal(forced.status, 200, JSON.stringify(forced));
  assert.equal(forced.folder.id, 'folder-1');
  assert.deepEqual(forced.folder.participants, ['structure', 'workflow'], 'запись заменена новой');
  assert.equal(typeof forced.backup, 'string');
  assert.match(forced.backup, /^structure\/graph\.json\.bak-/u, 'backup — путь от корня проекта: ' + forced.backup);
  assert.equal(forced.file, 'structure/graph.json');
  const backupPath = path.resolve(root, forced.backup);
  assert.ok(fs.existsSync(backupPath), 'backup существует: ' + backupPath);
  assert.ok(fs.readFileSync(backupPath).equals(before), 'backup — точное состояние ДО записи');
  const after = bytesOf(root);
  assert.ok(!after.equals(before), 'структура заменена');
  const document = JSON.parse(after.toString('utf8'));
  const folder = document.folders.find((item) => item && item.id === 'folder-1');
  assert.ok(folder, 'папка folder-1 в структуре');
  assert.deepEqual(folder.participants, ['structure', 'workflow'], 'в файле новая запись');
  assert.equal(backupFiles(root).length, 1, 'backup пережил запись');
  assert.equal(forced.reason, 'accepted');
  assert.ok(forced.receipt, 'квитанция тоже записана');
  assert.ok(fs.existsSync(path.join(box, forced.receipt)), 'квитанция лежит в ящике');
}

function c3() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-join-0201-inv-'));
  const root = path.join(parent, 'structure-ws');
  const workflow = path.join(parent, 'workflow-ws');
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.mkdirSync(workflow, { recursive: true });
  const box = path.join(root, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  writeFolder(root, sameFolder({
    exchange: { contract: CONTRACT, threads: ['critic-report'] },
  }));

  const runtime = createGraphRuntime({
    roots: [root, workflow],
    participants: { structure: root, workflow },
    me: 'structure',
  });
  const revved = saveFolder(runtime, root, 'contract', { root, id: 'folder-1' });
  assert.equal(revved.status, 200, JSON.stringify(revved));
  assert.equal(revved.contract.rev, 1);
  assert.equal(revved.invitations.length, 1, 'приглашён ровно один участник: ' + JSON.stringify(revved.invitations));
  assert.equal(revved.invitations[0].to, 'workflow');

  const invitationPath = path.join(box, revved.invitations[0].file.split('/').join(path.sep));
  const invitation = fs.readFileSync(invitationPath, 'utf8');
  assert.match(invitation, /^Status: invitation$/m);
  assert.match(invitation, /^Folder-Id: folder-1$/m, 'в шапке — точный id папки');
  assert.match(invitation, /^Rev: 1$/m, 'Rev не сломан');
  const boxLine = /^Box: (.+)$/m.exec(invitation);
  assert.ok(boxLine, 'Box не сломан');
  assert.equal(boxLine[1].trim(), path.resolve(box), 'Box — абсолютный путь ящика');
  assert.match(invitation, /^Ref: contract-folder-1\.md$/m, 'Ref не сломан');
  assert.ok(!/^Folder-Id: .*[\\/]/mu.test(invitation), 'Folder-Id — id, а не путь');
}

const table = { c1, c2, c3 };
const arg = String(process.argv[2] || '').toLowerCase();
if (arg && !table[arg]) {
  console.log('usage: node test/join.test.mjs c1|c2|c3');
  process.exit(2);
}
let failed = 0;
for (const name of arg ? [arg] : Object.keys(table)) {
  try {
    table[name]();
    console.log('OK ' + name);
  } catch (error) {
    failed += 1;
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : String(error)));
  }
}
if (failed > 0) process.exit(1);
console.log('JOIN TEST OK: ' + (arg ? '1/1' : '3/3'));
process.exit(0);
