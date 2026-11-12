import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

test('0232: субагентские сессии исключены, сессия адресата первой', async () => {
  const { deliverableSessions, spawnedSessionIds } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  const spawned = new Set(['session-dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']);
  const peers = new Map([['structure', 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']]);
  assert.deepEqual(deliverableSessions(['session-dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'], spawned, peers, 'structure'), ['session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
  assert.deepEqual(deliverableSessions(['session-dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], spawned, new Map(), 'other'), ['session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
  assert.deepEqual(deliverableSessions(['session-44444444-4444-4444-8444-444444444444', 'session-55555555-5555-4555-8555-555555555555', 'session-66666666-6666-4666-8666-666666666666', 'session-77777777-7777-4777-8777-777777777777'], new Set(), new Map(), 'x'), ['session-44444444-4444-4444-8444-444444444444', 'session-55555555-5555-4555-8555-555555555555', 'session-66666666-6666-4666-8666-666666666666']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launches-'));
  const file = path.join(dir, 'launches.jsonl');
  fs.writeFileSync(file, [JSON.stringify({ childId: 'session-22222222-2222-4222-8222-222222222222', node: 'judge' }), 'битая строка', JSON.stringify({ childId: 'session-33333333-3333-4333-8333-333333333333' })].join(String.fromCharCode(10)));
  const ids = spawnedSessionIds(file);
  assert.equal(ids.has('session-22222222-2222-4222-8222-222222222222'), true);
  assert.equal(ids.has('session-33333333-3333-4333-8333-333333333333'), true);
  assert.equal(ids.size, 2);
});