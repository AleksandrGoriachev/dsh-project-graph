import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSessionId, pickLiveParent, requireLiveParent } from '../lib/spawn.js';

/*
 * 0287: родитель активации. Хост требует точный живой объект реестра, поэтому
 * плагин обязан либо отдать его, либо отказать кодом no-parent — не undefined.
 */
const agent = (id) => ({ id, session: { id } });
const runtimeWith = (roots, list) => ({ getAgents: () => ({ roots: () => roots, list: () => list }) });

test('0287: идентификатор агента берётся из id, sessionId или session.id', () => {
  assert.equal(agentSessionId({ id: 'a' }), 'a');
  assert.equal(agentSessionId({ sessionId: 'b' }), 'b');
  assert.equal(agentSessionId({ session: { id: 'c' } }), 'c');
  assert.equal(agentSessionId({ agentId: 'd' }), 'd');
  assert.equal(agentSessionId({}), '');
  assert.equal(agentSessionId(null), '');
});

test('0287: pickLiveParent берёт roots, запись без id пропускает', () => {
  const good = agent('session-a');
  assert.equal(pickLiveParent(runtimeWith([{ broken: true }, good], [])), good);
});

test('0287: pickLiveParent падает на list, когда roots пуст', () => {
  const fromList = agent('session-b');
  assert.equal(pickLiveParent(runtimeWith([], [fromList])), fromList);
});

test('0287: пустая служба и отсутствие службы — null, а не догадка', () => {
  assert.equal(pickLiveParent(runtimeWith([], [])), null);
  assert.equal(pickLiveParent(null), null);
  assert.equal(pickLiveParent({}), null);
});

test('0287: живой exec.agent сохраняется без подмены', () => {
  const own = agent('session-own');
  assert.equal(requireLiveParent(own, runtimeWith([agent('session-x')], [])), own);
});

test('0287: пустой exec.agent поднимается из службы', () => {
  const service = agent('session-service');
  assert.equal(requireLiveParent(undefined, runtimeWith([service], [])), service);
});

test('0287: без живого родителя — отказ no-parent до активации', () => {
  let code = '';
  try {
    requireLiveParent(undefined, runtimeWith([], []));
  } catch (error) {
    code = error && error.code ? error.code : '';
  }
  assert.equal(code, 'no-parent');
});
