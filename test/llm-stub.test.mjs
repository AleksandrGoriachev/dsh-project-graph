/**
 * 0288: стаб службы llm — стенд проверок.
 *
 * Стенд обязан дать инструменту службу llm, иначе маршрут узла не проверить и
 * запуск честно отказывает model-unavailable. Стаб изображает ТОЛЬКО
 * resolveCallConfig: каталог (listProviders/listModels) не выдаётся, чтобы
 * проверки каталога не получали выдуманных данных.
 *
 *   node --test test/llm-stub.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { llmStub } from '../checks/support/llm-stub.mjs';
import { assertRouteAvailable } from '../lib/spawn.js';

test('стаб резолвит объявленный маршрут и фиксирует вызов', async () => {
  const llm = llmStub();
  const route = await llm.resolveCallConfig({ provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' });
  assert.deepEqual(route, { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' });
  assert.equal(llm.calls.length, 1, 'вызов не записан');
  assert.deepEqual(llm.calls[0], { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' });
});

test('стаб отдаёт ответ onResolve и не теряет запись вызова', async () => {
  const llm = llmStub((config) => ({ ...config, model: 'model-b' }));
  const route = await llm.resolveCallConfig({ provider: 'provider-a', model: 'model-a' });
  assert.equal(route.model, 'model-b', 'ответ onResolve не применён');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].model, 'model-a', 'в calls должен лежать запрос, а не ответ');
});

test('стаб не выдаёт каталог провайдеров и моделей', async () => {
  const llm = llmStub();
  assert.equal(typeof llm.listProviders, 'undefined', 'стаб не должен изображать каталог');
  assert.equal(typeof llm.listModels, 'undefined', 'стаб не должен изображать каталог');
});

test('assertRouteAvailable берёт маршрут из ответа службы', async () => {
  const calls = [];
  const llm = {
    calls,
    async resolveCallConfig(config) {
      calls.push(config);
      return { provider: config.provider, model: 'resolved-model', reasoningEffort: 'high' };
    },
  };
  const route = await assertRouteAvailable(llm, { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' });
  assert.deepEqual(route, { provider: 'provider-a', model: 'resolved-model', reasoningEffort: 'high' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' });
});

test('без службы llm отказ model-unavailable остаётся', async () => {
  for (const llm of [null, undefined, {}, { resolveCallConfig: null }]) {
    await assert.rejects(
      () => assertRouteAvailable(llm, { provider: 'provider-a', model: 'model-a' }),
      (error) => error && error.code === 'model-unavailable',
      'ожидался model-unavailable для ' + JSON.stringify(llm),
    );
  }
});

test('отказ службы llm даёт model-unavailable с её текстом', async () => {
  const llm = llmStub(() => { throw new Error('LLM provider "provider-x" is not allowed for this Session'); });
  await assert.rejects(
    () => assertRouteAvailable(llm, { provider: 'provider-x', model: 'model-x' }),
    (error) => error && error.code === 'model-unavailable' && /not allowed/u.test(error.message),
  );
});
