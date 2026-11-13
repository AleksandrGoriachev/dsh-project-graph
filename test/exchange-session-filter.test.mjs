import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

test('0232: субагентские сессии исключены, сессия адресата первой', async () => {
  const { deliverableSessions, spawnedSessionIds } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  const spawned = new Set(['s-judge-1', 's-judge-2']);
  const peers = new Map([['structure', 's-peer']]);
  assert.deepEqual(deliverableSessions(['s-judge-1', 's1', 's-judge-2', 's2'], spawned, peers, 'structure'), ['s-peer', 's1', 's2']);
  assert.deepEqual(deliverableSessions(['s-judge-1', 's1'], spawned, new Map(), 'other'), ['s1']);
  assert.deepEqual(deliverableSessions(['a', 'b', 'c', 'd'], new Set(), new Map(), 'x'), ['a', 'b', 'c']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launches-'));
  const file = path.join(dir, 'launches.jsonl');
  fs.writeFileSync(file, [JSON.stringify({ childId: 'x1', node: 'judge' }), 'битая строка', JSON.stringify({ childId: 'x2' })].join(String.fromCharCode(10)));
  const ids = spawnedSessionIds(file);
  assert.equal(ids.has('x1'), true);
  assert.equal(ids.has('x2'), true);
  assert.equal(ids.size, 2);
});