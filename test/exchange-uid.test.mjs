import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const UID = '11111111-1111-4111-8111-111111111111';

test('0223: buildGraphDocument сохраняет folders и uid', async () => {
  const { buildGraphDocument } = await import(pathToFileURL(path.join(LIB, 'api.js')).href);
  const doc = buildGraphDocument({ nodes: [], edges: [], folders: [{ id: 'folder-1', uid: UID, box: { path: 'coordination' }, participants: ['a', 'b'] }] });
  assert.equal(doc.folders.length, 1);
  assert.equal(doc.folders[0].uid, UID);
  assert.deepEqual(doc.folders[0].participants, ['a', 'b']);
});

test('0223: parseMessage читает Box', async () => {
  const { parseMessage } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  const text = ['Format: dsh-exchange/1', 'From: a', 'To: b', 'Date: 2026-11-12T08:00+03:00', 'Thread: exchange', 'Box: ' + UID, 'Status: request', '', 'тело'].join(String.fromCharCode(10));
  const parsed = parseMessage(text, 'x.md');
  assert.equal(parsed.box, UID);
});

test('0223: миграция идемпотентна и не перегенерирует uid', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uid-mig-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({ version: 1, nodes: [], edges: [], folders: [{ id: 'folder-1', box: { path: 'coordination' } }] }, null, 2));
  const { spawnSync } = await import('node:child_process');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'folders-uid.mjs');
  const first = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
  const uid = afterFirst.folders[0].uid;
  assert.match(uid, /^[0-9a-f-]{36}$/u);
  const second = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const afterSecond = JSON.parse(fs.readFileSync(path.join(root, 'structure', 'graph.json'), 'utf8'));
  assert.equal(afterSecond.folders[0].uid, uid, 'uid не перегенерирован');
  assert.match(second.stdout, /changed=0/u);
});