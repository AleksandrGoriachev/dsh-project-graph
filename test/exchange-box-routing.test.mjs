import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

test('0230: resolveBoxByUid — известный uid, неизвестный, пустой', async () => {
  const { resolveBoxByUid } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  const uid = '3d181cf2-467f-4f0e-a819-09f3f62f34be';
  const index = new Map([[uid, 'C:/box']]);
  assert.equal(resolveBoxByUid(uid, index), 'C:/box');
  assert.equal(resolveBoxByUid('unknown', index), null);
  assert.equal(resolveBoxByUid('', index), null);
  assert.equal(resolveBoxByUid(uid, null), null);
  assert.equal(resolveBoxByUid(uid, { [uid]: 'D:/box' }), 'D:/box');
});