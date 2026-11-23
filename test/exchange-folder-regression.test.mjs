#!/usr/bin/env node
/**
 * 0335 — регрессия папки обмена: box.path round-trip, uid join, сессия квитанции.
 *
 *   C1  box.path писателя и читателя дают ОДИН каталог на разных деревьях
 *       (участники на двух разных деревьях, C:\inetpub\…, ящик у одного); расхождение —
 *       400 без записи.
 *   C1  uid: новые папки получают uuid, join ищет папку по uid, при занятом
 *       локальном id берёт свободный и хранит uid/requestedId; письмо несёт
 *       Folder-Uid, старые письма без него работают.
 *   C1  сессия: без session в шапке — Session-Source: absent, с session — её id.
 *
 * Временные каталоги только в os.tmpdir; структура проекта не трогается.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGraphRuntime, saveFolder } from '../lib/api.js';
import { resolveBox } from '../lib/boxes.js';

/* Хранилище проекта — в temp: набор не должен трогать реальный ~/.dsh. */
process.env.DSH_PROJECT_GRAPH_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0335-store-'));

const UID = '11111111-1111-4111-8111-111111111111';
const OTHER_UID = '22222222-2222-4222-8222-222222222222';
const SESSION = 'session-9a8b7c6d-1234-4abc-8def-0123456789ab';
const CONTRACT = 'contract-folder-1.md';

function contractText() {
  return [
    'Format: dsh-exchange/1-contract',
    'Rev: 1',
    'Initiator: workflow',
    'Invited: structure',
    'Created: 2026-11-23T10:00+03:00',
    '',
  ].join('\n');
}

function graphDocument(folders, nodes = [{ id: 'coordinator', role: 'координатор' }]) {
  return { version: 1, nodes, edges: [], ...(folders ? { folders } : {}) };
}

function writeGraph(root, document) {
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(document, null, 2) + '\n');
}

function readGraph(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
}

/** Воркспейс с узлом-оркестратором и (необязательно) папками. */
function workspace(parent, name, folders) {
  const root = path.join(parent, name);
  writeGraph(root, graphDocument(folders));
  return root;
}

/** Ящик рядом с воркспейсами: контракт и каталоги threads создаёт сам join. */
function makeBox(parent) {
  const box = path.join(parent, 'coordination');
  fs.mkdirSync(box, { recursive: true });
  fs.writeFileSync(path.join(box, CONTRACT), contractText());
  return box;
}

function runtimeOf(roots, participants, me) {
  return createGraphRuntime({ roots, participants, exchange: [], me }, { providerName: 'spawn' });
}

function joinBody(box, over = {}) {
  return {
    id: 'folder-1',
    box,
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    contract: CONTRACT,
    ...over,
  };
}

function letters(box) {
  const dir = path.join(box, 'threads');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.md$/iu.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function receiptText(result) {
  const file = path.join(result.box || '', result.receipt || '');
  assert.ok(fs.existsSync(file), 'квитанция записана: ' + file);
  return fs.readFileSync(file, 'utf8');
}

function nowSession() {
  return { session: process.env.DSH_SESSION_ID, present: Object.prototype.hasOwnProperty.call(process.env, 'DSH_SESSION_ID') };
}

function restoreSession(saved) {
  if (saved.present) process.env.DSH_SESSION_ID = saved.session;
  else delete process.env.DSH_SESSION_ID;
}

test('0335 C1: box.path round-trip на деревьях C:\\Users и C:\\inetpub', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0335-box-'));
  const local = workspace(parent, 'structure-ws');
  const box = makeBox(parent);
  /*
   * Второй участник — на другом дереве (C:\inetpub). Старый писатель считал базу
   * по allowedRoots (только свой корень) и объявлял «coordination» от родителя,
   * а читатель от commonParent участников получал C:\coordination — другой путь.
   */
  const peer = 'C:\\inetpub\\fake-workspace';
  const runtime = runtimeOf([local], { structure: local, workflow: peer }, 'structure');
  const result = saveFolder(runtime, local, 'join', joinBody(box));
  assert.equal(result.status, 200, JSON.stringify(result));

  const graph = readGraph(local);
  const folder = graph.folders.find((item) => item.id === 'folder-1');
  assert.ok(folder, 'папка записана');
  assert.equal(folder.box.root, 'shared', 'ящик вне воркспейса объявлен общим');
  assert.notEqual(folder.box.path, 'coordination', 'база — не allowedRoots и не родитель воркспейса');

  const readBack = resolveBox({ root: local, folder, folders: graph.folders });
  assert.equal(readBack.status, 'ok', JSON.stringify(readBack));
  assert.ok(readBack.path, 'round-trip вернул путь');
  assert.equal(
    path.resolve(readBack.path).toLowerCase(),
    path.resolve(box).toLowerCase(),
    'box.path писателя и читателя — один каталог',
  );
});

test('0335 C1: расхождение box.path — 400 без записи', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0335-neg-'));
  const local = workspace(parent, 'structure-ws');
  const peer = workspace(parent, 'peer-ws');
  /* Ящик ВНЕ общего каталога участников: объявление не выразить переносимо. */
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0335-out-')), 'coordination');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, CONTRACT), contractText());
  const before = fs.readFileSync(path.join(local, 'structure', 'graph.json'), 'utf8');
  const runtime = runtimeOf([local], { structure: local, workflow: peer }, 'structure');
  const result = saveFolder(runtime, local, 'join', joinBody(outside));
  assert.equal(result.status, 400, JSON.stringify(result));
  assert.equal(result.code, 'box-roundtrip', 'негатив — тот же код, что расхождение round-trip: ' + JSON.stringify(result));
  assert.match(result.error, /вне общего каталога участников/u);
  assert.equal(fs.readFileSync(path.join(local, 'structure', 'graph.json'), 'utf8'), before, 'структура не изменена');
});

test('0335 C1 F1/F2: paths второй папки у читателя — 400 box-roundtrip из resolveBox', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0335-paths-'));
  /*
   * Соседняя папка несёт paths участника, которого НЕТ в runtime. Читатель
   * (readDeclaredStructure) видит этот путь и считает общий предок C:\, писатель
   * без него — родителя воркспейса. Объявление проходит, расхождение ловит
   * resolveBoxes, а не boxDeclarationFor.
   */
  const local = workspace(parent, 'structure-ws', [{
    id: 'folder-2',
    box: { path: 'elsewhere', root: 'workspace' },
    exchange: { contract: 'contract-folder-2.md' },
    participants: ['structure', 'workflow'],
    paths: { workflow: 'C:\\inetpub\\fake-workspace' },
    orchestrator: 'coordinator',
  }]);
  const box = makeBox(parent);
  const before = fs.readFileSync(path.join(local, 'structure', 'graph.json'), 'utf8');
  /* runtime без метки workflow: joinPaths знает только structure. */
  const runtime = runtimeOf([local], { structure: local }, 'structure');
  const result = saveFolder(runtime, local, 'join', joinBody(box));
  assert.equal(result.status, 400, JSON.stringify(result));
  assert.equal(result.code, 'box-roundtrip', JSON.stringify(result));
  assert.match(result.error, /читается как/u, 'отказ пришёл из resolveBox, а не из объявления: ' + JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(local, 'structure', 'graph.json'), 'utf8'), before, 'структура не изменена');
});

test('0335 C1: uid — письмо Folder-Uid, поиск по uid, свободный локальный id', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0335-uid-'));
  const wsA = workspace(parent, 'initiator-ws', [{
    id: 'folder-1',
    uid: UID,
    box: { path: 'coordination', root: 'shared' },
    exchange: { contract: CONTRACT },
    participants: ['workflow', 'structure'],
    orchestrator: 'coordinator',
  }]);
  const wsB = workspace(parent, 'structure-ws', [{
    id: 'folder-1',
    box: { path: 'old-box', root: 'workspace' },
    exchange: { contract: CONTRACT, threads: ['alien-thread'] },
    participants: ['structure'],
    orchestrator: 'coordinator',
  }]);
  fs.mkdirSync(path.join(wsB, 'old-box'), { recursive: true });
  const box = makeBox(parent);

  /* Приглашение инициатора несёт Folder-Uid рядом с Folder-Id. */
  const runtimeA = runtimeOf([wsA, wsB], { workflow: wsA, structure: wsB }, 'workflow');
  const invited = saveFolder(runtimeA, wsA, 'contract', { id: 'folder-1' });
  assert.equal(invited.status, 200, JSON.stringify(invited));
  assert.equal(invited.invitations.length, 1, JSON.stringify(invited.invitations));
  const invitation = fs.readFileSync(path.join(box, invited.invitations[0].file.split('/').join(path.sep)), 'utf8');
  assert.match(invitation, new RegExp('^Folder-Uid: ' + UID + '$', 'mu'), invitation);
  assert.match(invitation, /^Folder-Id: folder-1$/mu, 'прежнее поле сохранено');

  /* Локальный id занят другой папкой: uid называет ту же папку — id свободный. */
  const runtimeB = runtimeOf([wsB, wsA], { structure: wsB, workflow: wsA }, 'structure');
  const joined = saveFolder(runtimeB, wsB, 'join', joinBody(box, { uid: UID }));
  assert.equal(joined.status, 200, JSON.stringify(joined));
  assert.notEqual(joined.folder.id, 'folder-1', 'занятый id не перезаписан');
  assert.equal(joined.folder.uid, UID, 'uid из письма сохранён');
  assert.equal(joined.folder.requestedId, 'folder-1', 'запрошенный id сохранён рядом');
  const graphB = readGraph(wsB);
  assert.equal(graphB.folders.length, 2, 'прежняя папка цела, новая добавлена');
  const legacyFolder = graphB.folders.find((item) => item.id === 'folder-1');
  assert.ok(legacyFolder, 'занявшая id папка сохранена');
  assert.equal(legacyFolder.uid, undefined, 'чужой (легаси) записи uid не приписан');
  const saved = graphB.folders.find((item) => item.uid === UID);
  assert.ok(saved, 'папка найдена по uid');
  assert.equal(saved.requestedId, 'folder-1');
  assert.ok(!(saved.exchange && (saved.exchange.threads || []).includes('alien-thread')),
    'exchange.threads чужой папки не унаследованы: ' + JSON.stringify(saved.exchange));

  /* Повторный join по одному uid находит уже записанную папку, двойника нет. */
  const again = saveFolder(runtimeB, wsB, 'join', joinBody(box, { id: '', uid: UID }));
  assert.equal(again.status, 200, JSON.stringify(again));
  assert.equal(again.folder.id, saved.id, 'uid нашёл локальную папку');
  assert.equal(readGraph(wsB).folders.length, 2, 'двойник не создан');

  /* F3: повторный join того же uid с НОВЫМ box — 409 по полям, не двойник. */
  const boxNew = path.join(parent, 'coordination2');
  fs.mkdirSync(boxNew, { recursive: true });
  fs.writeFileSync(path.join(boxNew, CONTRACT), contractText());
  const bytesBeforeNewBox = fs.readFileSync(path.join(wsB, 'structure', 'graph.json'), 'utf8');
  const changedBox = saveFolder(runtimeB, wsB, 'join', joinBody(boxNew, { id: saved.id, uid: UID }));
  assert.equal(changedBox.status, 409, JSON.stringify(changedBox));
  assert.equal(changedBox.code, 'id-conflict', JSON.stringify(changedBox));
  assert.equal(changedBox.sameUid, true, 'uid подтвердил ту же папку: ' + JSON.stringify(changedBox));
  assert.match(changedBox.reason, /box\.path/u, 'причина называет расходящееся поле: ' + changedBox.reason);
  assert.ok(Array.isArray(changedBox.freeIds), 'свободные id не предлагаются как решение');
  const graphAfterChangedBox = readGraph(wsB);
  assert.equal(graphAfterChangedBox.folders.length, 2, 'двойник с тем же uid не создан');
  assert.equal(graphAfterChangedBox.folders.filter((item) => item.uid === UID).length, 1, 'uid уникален');
  assert.equal(fs.readFileSync(path.join(wsB, 'structure', 'graph.json'), 'utf8'), bytesBeforeNewBox,
    'отказ по box.path не трогает структуру');

  /* R1: локальный id занят папкой с ДРУГИМ uid — отказ, uid не перезаписан. */
  const parent3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0335-uid-conflict-'));
  const wsE = workspace(parent3, 'structure-ws', [{
    id: 'folder-1',
    uid: OTHER_UID,
    box: { path: 'old-box', root: 'workspace' },
    exchange: { contract: CONTRACT, threads: ['alien-thread'] },
    participants: ['structure'],
    orchestrator: 'coordinator',
  }]);
  fs.mkdirSync(path.join(wsE, 'old-box'), { recursive: true });
  const box3 = makeBox(parent3);
  const bytesBefore = fs.readFileSync(path.join(wsE, 'structure', 'graph.json'), 'utf8');
  const runtimeE = runtimeOf([wsE, wsA], { structure: wsE, workflow: wsA }, 'structure');
  const denied = saveFolder(runtimeE, wsE, 'join', joinBody(box3, { uid: UID }));
  assert.equal(denied.status, 409, JSON.stringify(denied));
  assert.equal(denied.code, 'uid-conflict', JSON.stringify(denied));
  assert.equal(denied.existingUid, OTHER_UID);
  assert.equal(denied.requestedUid, UID);
  assert.equal(fs.readFileSync(path.join(wsE, 'structure', 'graph.json'), 'utf8'), bytesBefore,
    'uid-конфликт не трогает структуру');

  /* Старое письмо без Folder-Uid: join по id работает, uid выдаётся новый. */
  const parent2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0335-old-'));
  const legacy = workspace(parent2, 'legacy-ws');
  const peer2 = workspace(parent2, 'peer-ws');
  const box2 = makeBox(parent2);
  const runtimeC = runtimeOf([legacy], { structure: legacy, workflow: peer2 }, 'structure');
  const oldStyle = saveFolder(runtimeC, legacy, 'join', joinBody(box2));
  assert.equal(oldStyle.status, 200, JSON.stringify(oldStyle));
  assert.match(oldStyle.folder.uid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    'новая папка получает uid: ' + oldStyle.folder.uid);
});

test('0335 C1: сессия квитанции — реальная или Session-Source: absent', () => {
  const saved = nowSession();
  try {
    delete process.env.DSH_SESSION_ID;

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0335-sess-'));
    const local = workspace(parent, 'structure-ws');
    const peer = workspace(parent, 'peer-ws');
    const box = makeBox(parent);
    const runtime = runtimeOf([local], { structure: local, workflow: peer }, 'structure');

    const absent = saveFolder(runtime, local, 'join', joinBody(box));
    assert.equal(absent.status, 200, JSON.stringify(absent));
    assert.equal(absent.sessionSource, 'absent', 'отсутствие сессии названо');
    const absentLetter = receiptText(absent);
    assert.match(absentLetter, /^Session-Source: absent$/mu, absentLetter);
    assert.match(absentLetter, /^Session: session-unknown$/mu, 'обязательное поле формата осталось');

    process.env.DSH_SESSION_ID = SESSION.slice('session-'.length);
    const parent2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0335-sess2-'));
    const local2 = workspace(parent2, 'structure-ws');
    const peer2 = workspace(parent2, 'peer-ws');
    const box2 = makeBox(parent2);
    const runtime2 = runtimeOf([local2], { structure: local2, workflow: peer2 }, 'structure');
    const present = saveFolder(runtime2, local2, 'join', joinBody(box2));
    assert.equal(present.status, 200, JSON.stringify(present));
    assert.equal(present.session, SESSION, 'реальная сессия из env');
    assert.notEqual(present.sessionSource, 'absent', 'честная метка не ставится');
    const letter = receiptText(present);
    assert.match(letter, new RegExp('^Session: ' + SESSION + '$', 'mu'), letter);
    assert.doesNotMatch(letter, /^Session-Source:/mu, 'с реальной сессией метки нет');
  } finally {
    restoreSession(saved);
  }
});
