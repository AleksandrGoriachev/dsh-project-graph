import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

test('0231: сессия адресата ставится первой и не дублируется', async () => {
  const { preferPeerSession } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  const peers = new Map([['structure', 's-peer']]);
  assert.deepEqual(preferPeerSession(['s1', 's2', 's3'], peers, 'structure'), ['s-peer', 's1', 's2']);
  assert.deepEqual(preferPeerSession(['s-peer', 's1'], peers, 'structure'), ['s-peer', 's1']);
  assert.deepEqual(preferPeerSession(['s1'], new Map(), 'structure'), ['s1']);
  assert.deepEqual(preferPeerSession(['a', 'b', 'c', 'd'], peers, 'other'), ['a', 'b', 'c']);
});