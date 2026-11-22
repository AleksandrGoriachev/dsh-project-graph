import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { assertRouteAvailable, captureChildError, promptWithRunId } from '../lib/spawn.js';

/*
 * 0288: маршрут узла разрешается инфраструктурой DSH до активации.
 * Объявленный provider/model — предпочтение; доступ даёт DSH, и его отказ
 * превращается в чистый model-unavailable, а не в мёртвого ребёнка.
 */
const llmWith = (impl, providers = [{ id: 'provider-a' }]) => ({
  listProviders: () => providers,
  resolveCallConfig: impl,
});

test('0288: пригодный маршрут уходит в llm и возвращается резолвом', async () => {
  const calls = [];
  const llm = llmWith(async (config) => {
    calls.push(config);
    return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort };
  });
  const got = await assertRouteAvailable(llm, { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' });
  assert.deepEqual(got, { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'provider-a');
  assert.equal(calls[0].model, 'model-a');
  assert.equal(calls[0].reasoningEffort, 'low');
});

test('0288: DSH может вернуть другой маршрут — он и принимается', async () => {
  const llm = llmWith(async () => ({ provider: 'provider-b', model: 'model-b' }));
  const got = await assertRouteAvailable(llm, { provider: 'provider-a', model: 'model-a' });
  assert.deepEqual(got, { provider: 'provider-b', model: 'model-b' });
});

test('0288: отказ DSH — model-unavailable с его текстом и списком провайдеров', async () => {
  const llm = llmWith(async () => { throw new Error('LLM provider "provider-x" is not allowed for this Session'); });
  await assert.rejects(
    () => assertRouteAvailable(llm, { provider: 'provider-x', model: 'model-x' }),
    (error) => {
      assert.equal(error.code, 'model-unavailable');
      assert.match(error.message, /not allowed/u);
      assert.match(error.message, /provider-a/u);
      return true;
    },
  );
});

test('0288: без службы llm запуск не начинается', async () => {
  await assert.rejects(
    () => assertRouteAvailable(null, { provider: 'p', model: 'm' }),
    (error) => error.code === 'model-unavailable',
  );
  await assert.rejects(
    () => assertRouteAvailable({}, { provider: 'p', model: 'm' }),
    (error) => error.code === 'model-unavailable',
  );
});

test('0288: неполный маршрут — model-unavailable, llm не спрашивается', async () => {
  let asked = 0;
  const llm = llmWith(async () => { asked += 1; return {}; });
  await assert.rejects(
    () => assertRouteAvailable(llm, { provider: 'p' }),
    (error) => error.code === 'model-unavailable',
  );
  assert.equal(asked, 0);
});

test('0288: captureChildError берёт ребёнка из службы agents по childId', () => {
  let handler = null;
  const agent = { ctx: { on: (name, fn) => { assert.equal(name, 'agent/error'); handler = fn; } } };
  const runtime = { getAgents: () => ({ get: (id) => (id === 'child-1' ? agent : undefined) }) };
  const get = captureChildError({ childId: 'child-1' }, runtime);
  assert.equal(get(), '');
  assert.ok(handler, 'подписка на agent/error не состоялась');
  handler({ error: new Error('LLM route rejected') });
  assert.equal(get(), 'LLM route rejected');
});

test('0288: captureChildError оставляет handle запасным путём', () => {
  let handler = null;
  const activation = { childId: 'child-2', handle: { agent: { ctx: { on: (name, fn) => { assert.equal(name, 'agent/error'); handler = fn; } } } } };
  const runtime = { getAgents: () => ({ get: () => undefined }) };
  const get = captureChildError(activation, runtime);
  assert.ok(handler, 'handle-путь не подписался');
  handler({ message: 'провайдер недоступен' });
  assert.equal(get(), 'провайдер недоступен');
});

test('0288: без живого агента captureChildError отдаёт пустую строку', () => {
  assert.equal(captureChildError(null)(), '');
  assert.equal(captureChildError({})(), '');
  assert.equal(captureChildError({ childId: 'x' }, { getAgents: () => ({ get: () => undefined }) })(), '');
});

test('0288: promptWithRunId — массив блоков, text у каждого строка', () => {
  const blocks = promptWithRunId('Задача: ping', 'run-1', { node: 'worker', role: 'исполнитель' });
  assert.ok(Array.isArray(blocks), 'промпт должен быть массивом блоков');
  for (const block of blocks) {
    assert.equal(block.type, 'text');
    assert.equal(typeof block.text, 'string', 'block.text обязан быть строкой, иначе block.text.matchAll падает в хосте');
  }
  assert.ok(blocks.some((b) => b.text.includes('ping')));
  assert.ok(blocks.some((b) => b.text.includes('runId: run-1')));
});
test('0288: место вызова передаёт promptWithRunId без обёртки', () => {
  const source = fs.readFileSync(new URL('../lib/spawn.js', import.meta.url), 'utf8');
  assert.ok(!/text:\s*promptWithRunId/u.test(source), 'промпт нельзя оборачивать в { text: promptWithRunId(...) } — block.text перестанет быть строкой');
  const direct = (source.match(/prompt:\s*promptWithRunId\(/gu) || []).length;
  assert.ok(direct >= 2, 'оба инструмента (spawn и run) должны передавать promptWithRunId напрямую, найдено: ' + direct);
});