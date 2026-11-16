/**
 * Задание 0020: приглашение в папку обмена.
 *
 * Проверяется вся цепочка «контракт → приглашение → подключение»:
 *  1. action=contract (Rev+1) пишет письмо Status: invitation с To, Ref, Rev и
 *     абсолютным путём ящика (Box);
 *  2. сторож доставляет приглашение не принявшему участнику (исключение из гейта
 *     0015), а обычное письмо до квитанции по-прежнему ждёт в ящике;
 *  3. action=join заводит папку в structure/graph.json приглашённого и пишет
 *     квитанцию accepted с Ref на контракт;
 *  4. action=decline пишет письмо Status: declined с Ref на контракт.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX, createGraphRuntime, createWebHandler } from '../lib/api.js';
import { createExchangeWatcher, readExchangeFolders } from '../lib/exchange-watch.js';

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

function folderCall(handler, action, body) {
  return call(handler, API_PREFIX + '/api/folder?action=' + action, { method: 'POST', body: JSON.stringify(body) });
}

/** Два воркспейса и общий ящик над ними — та же раскладка, что на хосте. */
function host() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-invitation-'));
  const structure = path.join(parent, 'dsh-project-graph');
  const workflow = path.join(parent, 'default-workspace');
  fs.mkdirSync(path.join(structure, 'structure'), { recursive: true });
  fs.mkdirSync(workflow, { recursive: true });
  const box = path.join(parent, 'coordination');
  const thread = path.join(box, 'threads', 'critic-report');
  fs.mkdirSync(thread, { recursive: true });
  return { parent, structure, workflow, box, thread };
}

function writeGraph(root, folders = []) {
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'coordinator', role: 'координатор' }],
    edges: [],
    folders,
  }, null, 2));
}

function readGraph(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
}

function writeContract(box, { rev = 2, initiator = 'structure', invited = 'workflow' } = {}) {
  fs.writeFileSync(path.join(box, 'contract.md'), [
    'Format: dsh-exchange/1-contract',
    'Portal: coordination',
    'Rev: ' + rev,
    'Initiator: ' + initiator,
    'Invited: ' + invited,
    'Created: 2026-11-02T17:00+03:00',
    '',
  ].join('\n'));
}

function declaration(over = {}) {
  return {
    id: 'folder-1',
    box: { path: 'coordination', root: 'shared' },
    exchange: { threads: ['critic-report'], contract: 'contract.md' },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    ...over,
  };
}

/** Все письма ветки: имя -> текст. */
function letters(thread) {
  const result = [];
  for (const name of fs.readdirSync(thread)) {
    if (!/\.md$/u.test(name)) continue;
    result.push({ name, text: fs.readFileSync(path.join(thread, name), 'utf8') });
  }
  return result;
}

function letterWith(thread, status) {
  return letters(thread).find((item) => new RegExp('^Status: ' + status + '$', 'mu').test(item.text)) || null;
}

function runtimeOf(roots, config = {}) {
  const runtime = createGraphRuntime({ roots, ...config });
  runtime.runs = new Map();
  runtime.runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-invitation-runs-'));
  return runtime;
}

/** Живая сессия адресата: письмо доставляется в неё, а не в двойника. */
function agent(id, cwd, label) {
  const inbox = [];
  return {
    id, sessionId: id, cwd, label,
    sendMessage: async (input) => { inbox.push(input.text); },
    inbox,
  };
}

const invitationHead = (box) => [
  'Format: dsh-exchange/1',
  'From: structure',
  'To: workflow',
  'Date: ' + new Date().toISOString(),
  'Thread: critic-report',
  'Status: invitation',
  'Session: session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'Ref: contract.md',
  'Rev: 2',
  'Box: ' + box,
  '',
  'приглашение',
  '',
].join('\n');

const requestHead = () => [
  'Format: dsh-exchange/1',
  'From: structure',
  'To: workflow',
  'Date: ' + new Date().toISOString(),
  'Thread: critic-report',
  'Status: request',
  'Session: session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  '',
  'обычное письмо',
  '',
].join('\n');

/* 1. Rev+1 — приглашение письмом, с To, Ref, Rev и абсолютным Box. */
await test('Rev+1 пишет письмо invitation с To, Ref, Rev и абсолютным Box', async () => {
  const h = host();
  writeGraph(h.structure);
  const runtime = runtimeOf([h.structure, h.workflow], {
    participants: { structure: h.structure, workflow: h.workflow },
    me: 'structure',
  });
  const handler = createWebHandler(runtime);

  const created = await folderCall(handler, 'add', { root: h.structure, folder: declaration() });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.contract.rev, 1);
  assert.deepEqual(letters(h.thread), [], 'создание папки приглашений не пишет: приглашает ревизия');

  const revved = await folderCall(handler, 'contract', { root: h.structure, id: 'folder-1' });
  assert.equal(revved.status, 200, JSON.stringify(revved.body));
  assert.equal(revved.body.contract.rev, 2);
  assert.equal(revved.body.invitations.length, 1, 'приглашён ровно один участник');
  assert.equal(revved.body.invitations[0].to, 'workflow');

  const invitation = letterWith(h.thread, 'invitation');
  assert.ok(invitation, 'приглашение написано письмом');
  assert.match(invitation.text, /^Format: dsh-exchange\/1$/m);
  assert.match(invitation.text, /^From: structure$/m, 'From — инициатор контракта');
  assert.match(invitation.text, /^To: workflow$/m);
  assert.match(invitation.text, /^Date: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/m);
  assert.match(invitation.text, /^Thread: critic-report$/m);
  assert.match(invitation.text, /^Session: session-.+$/m);
  assert.match(invitation.text, /^Ref: contract\.md$/m, 'Ref — имя контракта в ящике');
  assert.match(invitation.text, /^Rev: 2$/m, 'Rev — новая ревизия контракта');
  assert.match(invitation.text, /^Subject: .+$/m);
  const boxLine = /^Box: (.+)$/m.exec(invitation.text)[1];
  assert.equal(boxLine, path.resolve(h.box), 'Box — абсолютный путь ящика, а не метка');
  assert.match(invitation.name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}[+-]\d{2}-\d{2}--structure--\d{2}\.md$/u,
    'имя письма — по nextLetterNumber');
});

/* 2. Исключение из гейта 0015: приглашение доходит до invited, обычное письмо ждёт. */
await test('приглашение доставляется до квитанции, обычное письмо ждёт в ящике', async () => {
  const h = host();
  writeGraph(h.structure, [declaration()]);
  writeContract(h.box);
  const runtime = runtimeOf([h.structure, h.workflow], {
    participants: { structure: h.structure, workflow: h.workflow },
    me: 'structure',
  });
  const target = agent('s-workflow', h.workflow, 'workflow');
  const watcher = createExchangeWatcher({
    runtime,
    seenPath: path.join(os.tmpdir(), 'pg-invitation-seen-' + Date.now() + '.json'),
    getAgents: () => ({ list: () => [target] }),
    activityOf: () => new Map([['s-workflow', Date.now()]]),
  });
  fs.writeFileSync(path.join(h.thread, 'inv.md'), invitationHead(h.box));
  fs.writeFileSync(path.join(h.thread, 'plain.md'), requestHead());

  const delivered = await watcher.tick();
  assert.equal(target.inbox.length, 1, 'приглашение доставлено не принявшему участнику');
  assert.match(target.inbox[0], /inv\.md/u, 'в сессию ушло именно приглашение');
  assert.ok(!target.inbox[0].includes('plain.md'), 'обычное письмо в сессию не попало');
  assert.equal(delivered.length, 1, 'доставлено одно письмо — приглашение');
  assert.equal(delivered[0].file, 'threads/critic-report/inv.md');

  const plainRun = [...runtime.runs.values()].find((row) => row.delivered === 'threads/critic-report/plain.md');
  assert.ok(plainRun, 'обычное письмо записано как ожидающее');
  assert.equal(plainRun.wake.reason, 'box-only', 'до квитанции обычное письмо остаётся в ящике');
});

/* 3. join: папка в структуре приглашённого + квитанция accepted с Ref на контракт. */
await test('join заводит папку у приглашённого и пишет квитанцию accepted', async () => {
  const h = host();
  writeGraph(h.workflow);
  writeContract(h.box, { rev: 2, initiator: 'structure', invited: 'workflow' });
  const runtime = runtimeOf([h.structure, h.workflow], {
    participants: { structure: h.structure, workflow: h.workflow },
    me: 'workflow',
  });
  const handler = createWebHandler(runtime);

  const joined = await folderCall(handler, 'join', {
    root: h.workflow,
    id: 'folder-1',
    box: path.resolve(h.box),
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    session: '11111111-2222-3333-4444-555555555555',
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));

  const folder = readGraph(h.workflow).folders.find((item) => item.id === 'folder-1');
  assert.ok(folder, 'папка записана в structure/graph.json приглашённого');
  assert.deepEqual(folder.box, { path: 'coordination', root: 'shared' },
    'боковой путь относителен: абсолютный путь из письма в структуру не попадает');
  assert.equal(folder.orchestrator, 'coordinator');
  assert.deepEqual(folder.participants, ['structure', 'workflow']);
  assert.deepEqual(folder.exchange, { threads: ['critic-report'], contract: 'contract.md' },
    'join не теряет ветку ящика и имя контракта (задание 0028)');

  const receipt = letterWith(h.thread, 'accepted');
  assert.ok(receipt, 'квитанция accepted написана');
  assert.match(receipt.text, /^From: workflow$/m, 'квитанцию пишет приглашённый');
  assert.match(receipt.text, /^To: structure$/m, 'To — инициатор контракта');
  assert.match(receipt.text, /^Ref: contract\.md$/m, 'Ref — контракт');
  assert.match(receipt.text, /^Session: session-11111111-2222-3333-4444-555555555555$/m);

  const feed = readExchangeFolders(runtime, h.workflow);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].contractRev, 2);
  assert.equal(feed[0].states.workflow, 'accepted', 'после join участник принят');
  assert.equal(feed[0].initiator, 'structure', 'инициатор назван контрактом, а не читателем');
  /*
   * Задание 0049: инициатор accepted у ЛЮБОГО читателя. Копия папки, прочитанная
   * приглашённым (h.workflow), состояния инициатора не понижает: читатель — не
   * его квитанция.
   */
  assert.equal(feed[0].states.structure, 'accepted',
    'инициатор accepted и в копии приглашённой стороны (задание 0049)');
});

/* 3b. Повторный join: exchange существующей записи наследуется, а не затирается. */
await test('повторный join наследует threads и имя контракта существующей папки', async () => {
  const h = host();
  writeGraph(h.workflow, [{
    id: 'folder-1',
    box: { path: 'coordination', root: 'shared' },
    exchange: { threads: ['audit'], contract: 'contract.md' },
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
  }]);
  writeContract(h.box, { rev: 3, initiator: 'structure', invited: 'workflow' });
  const runtime = runtimeOf([h.structure, h.workflow], {
    participants: { structure: h.structure, workflow: h.workflow },
    me: 'workflow',
  });
  const handler = createWebHandler(runtime);

  const joined = await folderCall(handler, 'join', {
    root: h.workflow,
    id: 'folder-1',
    box: path.resolve(h.box),
    participants: ['structure', 'workflow'],
    orchestrator: 'coordinator',
    session: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));

  const folder = readGraph(h.workflow).folders.find((item) => item.id === 'folder-1');
  assert.deepEqual(folder.exchange, { threads: ['audit'], contract: 'contract.md' },
    'exchange прежней записи переживает join: threads и имя контракта');
});

/* 4. decline: письмо Status: declined с Ref на контракт, структура не меняется. */
await test('decline пишет письмо declined с Ref на контракт', async () => {
  const h = host();
  writeGraph(h.workflow);
  writeContract(h.box, { rev: 2, initiator: 'structure', invited: 'workflow' });
  const runtime = runtimeOf([h.structure, h.workflow], {
    participants: { structure: h.structure, workflow: h.workflow },
    me: 'workflow',
  });
  const handler = createWebHandler(runtime);

  /* Папки в структуре ещё нет: путь ящика берётся из письма-приглашения. */
  const declined = await folderCall(handler, 'decline', {
    root: h.workflow,
    id: 'folder-1',
    box: path.resolve(h.box),
    session: '99999999-8888-7777-6666-555555555555',
  });
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  assert.deepEqual(readGraph(h.workflow).folders, [], 'отказ структуру не меняет');

  const letter = letterWith(h.thread, 'declined');
  assert.ok(letter, 'письмо declined написано');
  assert.match(letter.text, /^Format: dsh-exchange\/1$/m);
  assert.match(letter.text, /^From: workflow$/m, 'отказ пишет приглашённый');
  assert.match(letter.text, /^To: structure$/m);
  assert.match(letter.text, /^Ref: contract\.md$/m, 'Ref — контракт');
  assert.match(letter.text, /^Session: session-99999999-8888-7777-6666-555555555555$/m);
  assert.match(letter.name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}[+-]\d{2}-\d{2}--workflow--\d{2}\.md$/u);
});

/* 5. Приглашение не повторяется тому, кто уже ответил квитанцией. */
await test('повторный contract не приглашает принявшего папку', async () => {
  const h = host();
  writeGraph(h.structure);
  const runtime = runtimeOf([h.structure, h.workflow], {
    participants: { structure: h.structure, workflow: h.workflow },
    me: 'structure',
  });
  const handler = createWebHandler(runtime);
  await folderCall(handler, 'add', { root: h.structure, folder: declaration() });
  const first = await folderCall(handler, 'contract', { root: h.structure, id: 'folder-1' });
  assert.equal(first.status, 200);
  assert.equal(letters(h.thread).filter((item) => /^Status: invitation$/mu.test(item.text)).length, 1);

  /* workflow принимает папку: From — автор квитанции, состояние accepted. */
  fs.writeFileSync(path.join(h.thread, 'receipt.md'), [
    'Format: dsh-exchange/1',
    'From: workflow',
    'To: structure',
    'Date: ' + new Date().toISOString(),
    'Thread: critic-report',
    'Status: accepted',
    'Session: session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'Ref: contract.md',
    '',
    'принято',
    '',
  ].join('\n'));

  const second = await folderCall(handler, 'contract', { root: h.structure, id: 'folder-1' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.contract.rev, 3);
  assert.deepEqual(second.body.invitations, [], 'принявший папку больше не приглашается');
  assert.equal(letters(h.thread).filter((item) => /^Status: invitation$/mu.test(item.text)).length, 1,
    'второго приглашения нет');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const detail = failure.error && failure.error.message ? failure.error.message : String(failure.error);
  console.error('  ' + detail.split('\n').join('\n  '));
}
console.log('INVITATION TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
