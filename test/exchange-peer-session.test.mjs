import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

test('0231: сессия адресата ставится первой и не дублируется', async () => {
  const { preferPeerSession } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  const peers = new Map([['structure', 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']]);
  assert.deepEqual(preferPeerSession(['session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'session-ffffffff-ffff-4fff-8fff-ffffffffffff'], peers, 'structure'), ['session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
  assert.deepEqual(preferPeerSession(['session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], peers, 'structure'), ['session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
  assert.deepEqual(preferPeerSession(['session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], new Map(), 'structure'), ['session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
  assert.deepEqual(preferPeerSession(['session-44444444-4444-4444-8444-444444444444', 'session-55555555-5555-4555-8555-555555555555', 'session-66666666-6666-4666-8666-666666666666', 'session-77777777-7777-4777-8777-777777777777'], peers, 'other'), ['session-44444444-4444-4444-8444-444444444444', 'session-55555555-5555-4555-8555-555555555555', 'session-66666666-6666-4666-8666-666666666666']);
});