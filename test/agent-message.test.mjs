import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserMessage, deliverToHandle } from '../lib/agent-message.js';

/**
 * Фейковый живой агент с семантикой хоста DSH 0.2.2.
 *
 * send(message, target, wakeup) кладёт сообщение в inbox[target]; неизвестный
 * target — тот самый TypeError про 'length', что и в host: state[target].length.
 */
function hostAgent() {
  return {
    inbox: { 'next-turn': [], 'next-step': [] },
    woken: false,
    send(message, target, wakeup) {
      const box = this.inbox[target];
      if (!box) throw new TypeError("Cannot read properties of undefined (reading 'length')");
      box.push(message);
      this.woken = Boolean(wakeup);
    },
    followup(message) {
      this.send(message, 'next-turn', true);
    },
  };
}

test('(a) buildUserMessage: id/role/content/source, каждый вызов — новый id', () => {
  const first = buildUserMessage('письмо');
  assert.equal(typeof first.id, 'string');
  assert.ok(first.id.length > 0, 'id не пустой');
  assert.equal(first.role, 'user');
  assert.deepEqual(first.content, [{ type: 'text', text: 'письмо' }]);
  assert.deepEqual(first.source, { kind: 'user' });

  const second = buildUserMessage('письмо');
  assert.notEqual(first.id, second.id, 'id разный у двух сообщений');

  assert.equal(buildUserMessage(undefined).content[0].text, '', 'undefined — пустая строка');
  assert.equal(buildUserMessage(null).content[0].text, '', 'null — пустая строка');
  assert.equal(buildUserMessage(42).content[0].text, '42', 'не строка приводится к строке');
});

test('(b) deliverToHandle: followup первым, письмо в next-turn и сессия разбужена', async () => {
  const agent = hostAgent();
  const result = await deliverToHandle(agent, 'требую хода');
  assert.equal(result.ok, true);
  assert.equal(result.via, 'followup');
  assert.deepEqual(result.errors, []);
  assert.equal(agent.inbox['next-turn'].length, 1, 'сообщение в next-turn');
  assert.equal(agent.inbox['next-step'].length, 0, 'next-step не тронут');
  assert.equal(agent.inbox['next-turn'][0].content[0].text, 'требую хода');
  assert.equal(agent.woken, true, 'wakeup=true');
});

test('(c) контроль: старый одиночный send({ text }) падает на length', () => {
  const agent = hostAgent();
  assert.throws(
    () => agent.send({ text: 'x' }),
    { name: 'TypeError', message: /reading 'length'/ },
    'форма { text } одним аргументом — тот самый отказ хоста',
  );
});

test('(d) только send: сообщение в next-turn, wakeup=true', async () => {
  const box = { 'next-turn': [], 'next-step': [] };
  let woken = false;
  const agent = {
    send(message, target, wakeup) {
      const targetBox = box[target];
      if (!targetBox) throw new TypeError("Cannot read properties of undefined (reading 'length')");
      targetBox.push(message);
      woken = Boolean(wakeup);
    },
  };
  const result = await deliverToHandle(agent, 'письмо');
  assert.equal(result.ok, true);
  assert.equal(result.via, 'send');
  assert.equal(box['next-turn'].length, 1, 'target next-turn');
  assert.equal(box['next-turn'][0].content[0].text, 'письмо');
  assert.equal(woken, true);
});

test('(e) только sendMessage: delivered через sendMessage', async () => {
  const seen = [];
  const agent = {
    async sendMessage(message) { seen.push(message); },
  };
  const result = await deliverToHandle(agent, 'письмо');
  assert.equal(result.ok, true);
  assert.equal(result.via, 'sendMessage');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].content[0].text, 'письмо');
  assert.equal(seen[0].role, 'user');
});

test('(f) все способы отвергнуты: ok=false и три ошибки', async () => {
  const agent = {
    followup() { throw new Error('нет followup'); },
    send() { throw new Error('нет send'); },
    async sendMessage() { throw new Error('нет sendMessage'); },
  };
  const result = await deliverToHandle(agent, 'письмо');
  assert.equal(result.ok, false);
  assert.equal(result.via, '');
  assert.equal(result.errors.length, 3, 'каждая попытка записана');
  assert.match(result.errors[0], /followup/u);
  assert.match(result.errors[1], /send/u);
  assert.match(result.errors[2], /sendMessage/u);
});

test('options.wrap оборачивает каждую попытку', async () => {
  const agent = {
    followup() { throw new Error('нет followup'); },
    send() { throw new Error('нет send'); },
    async sendMessage() { return { ok: true }; },
  };
  const wrapped = [];
  const result = await deliverToHandle(agent, 'письмо', {
    wrap: (promise, what) => { wrapped.push(what); return promise; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'sendMessage');
  assert.equal(wrapped.length, 3, 'обёрнуты все три попытки');
});

test('нет ни одного способа: ok=false без ошибок', async () => {
  const result = await deliverToHandle({ id: 's' }, 'письмо');
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.via, '');
});
