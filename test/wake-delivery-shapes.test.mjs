import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');

/**
 * 0263: форма письма — объект DSH-сообщения (id, role, content[], source), а не
 * `{ text }`. Прежний тест 0214 кодировал перебор форм `{text}`/`{text,parts}`/
 * `{text,content}`; контракт удалён вместе с перебором, поэтому проверяется
 * порядок способов вручения и сам объект.
 */
function assertMessage(message) {
  assert.equal(typeof message, 'object');
  assert.ok(message, 'сообщение передано');
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0, 'id не пустой');
  assert.ok(Array.isArray(message.content) && message.content.length > 0, 'content — массив частей');
  assert.equal(message.content[0].type, 'text');
  assert.deepEqual(message.source, { kind: 'user' });
}

async function sendViaHandleOf() {
  const { sendViaHandle } = await import(pathToFileURL(path.join(LIB, 'exchange-watch.js')).href);
  return sendViaHandle;
}

test('0263 (а): followup вызывается первым и получает объект id/content/source', async () => {
  const sendViaHandle = await sendViaHandleOf();
  const seen = [];
  const handle = {
    followup(message) {
      assertMessage(message);
      seen.push(['followup', message]);
      return Promise.resolve({ ok: true });
    },
    send(message) { seen.push(['send', message]); },
    sendMessage(message) { seen.push(['sendMessage', message]); },
  };
  const result = await sendViaHandle(handle, 'письмо');
  assert.equal(result.ok, true);
  assert.equal(result.shape, 'followup');
  assert.deepEqual(result.errors, []);
  assert.equal(seen.length, 1, 'первого способа достаточно, остальные не тронуты');
  assert.equal(seen[0][0], 'followup');
  assert.equal(seen[0][1].content[0].text, 'письмо');
});

test('0263 (б): без followup вызывается send(msg, "next-turn", true)', async () => {
  const sendViaHandle = await sendViaHandleOf();
  const calls = [];
  const handle = {
    send(message, target, wakeup) {
      assertMessage(message);
      calls.push({ message, target, wakeup });
      return Promise.resolve();
    },
    sendMessage() { calls.push({ via: 'sendMessage' }); },
  };
  const result = await sendViaHandle(handle, 'письмо');
  assert.equal(result.ok, true);
  assert.equal(result.shape, 'send');
  assert.equal(calls.length, 1, 'sendMessage после удачного send не вызывается');
  assert.equal(calls[0].target, 'next-turn');
  assert.equal(calls[0].wakeup, true);
  assert.equal(calls[0].message.content[0].text, 'письмо');
});

test('0263 (в): без followup и send вызывается sendMessage(msg)', async () => {
  const sendViaHandle = await sendViaHandleOf();
  const seen = [];
  const handle = {
    async sendMessage(message) {
      assertMessage(message);
      seen.push(message);
    },
  };
  const result = await sendViaHandle(handle, 'письмо');
  assert.equal(result.ok, true);
  assert.equal(result.shape, 'sendMessage');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].content[0].text, 'письмо');
});

test('0263 (г): отказ всех трёх способов — ok=false и три ошибки', async () => {
  const sendViaHandle = await sendViaHandleOf();
  const handle = {
    followup() { return Promise.reject(new Error('нет followup')); },
    send() { return Promise.reject(new Error('нет send')); },
    sendMessage() { return Promise.reject(new Error('нет sendMessage')); },
  };
  const result = await sendViaHandle(handle, 'письмо');
  assert.equal(result.ok, false);
  assert.equal(result.shape, null);
  assert.equal(result.errors.length, 3, 'каждый способ записан');
  assert.match(result.errors[0], /followup/u);
  assert.match(result.errors[1], /send/u);
  assert.match(result.errors[2], /sendMessage/u);
});
