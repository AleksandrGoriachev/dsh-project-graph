import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

test('0214: служба принимает только parts — форма перебирается', async () => {
  const { sendViaHandle } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  const strict = {
    sendMessage(payload) {
      if (!Array.isArray(payload.parts)) {
        const error = new Error("Cannot read properties of undefined (reading 'length')");
        return Promise.reject(error);
      }
      return Promise.resolve({ ok: true });
    },
  };
  const result = await sendViaHandle(strict, 'письмо');
  assert.equal(result.ok, true);
  assert.equal(result.shape, 'text+parts');
  assert.equal(result.errors.length, 1, 'первая форма отвергнута и записана');
});

test('0214: всегда падающий handle — три ошибки, ok=false', async () => {
  const { sendViaHandle } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  const broken = { sendMessage: () => Promise.reject(new Error('boom')) };
  const result = await sendViaHandle(broken, 'письмо');
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
});