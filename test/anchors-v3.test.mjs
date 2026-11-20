/**
 * 0298: якоря v3 — appliesTo.roles по роли узла, политика срока в структуре,
 * миграция v2 -> v3 только по подтверждённой карте.
 *
 * Тесты держат ровно те инварианты, по которым принимается задача:
 *   C1 — v3-схема строгая (appliesTo.roles), v2 остаётся совместимым;
 *   C2 — anchorsPolicy.maxAgeDays: 45, по умолчанию 30, некорректное — ошибка;
 *   C3 — миграция без подтверждённой роли отказывает и называет id, автовывода
 *        из consumes нет.
 *
 * Файл работает и как обычный node-скрипт (node test/anchors-v3.test.mjs), и
 * под node --test: провал выставляет exit-код 1.
 */
import assert from 'node:assert/strict';
import {
  ANCHORS_VERSION_V3,
  migrateAnchorsV3,
  validateAnchorsDoc,
} from '../lib/anchors.js';
import { buildGraph } from '../lib/graph.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try {
    body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

const BASE = {
  id: 'A1',
  claim: 'утверждение',
  check: 'node checks/x.mjs c1',
  status: 'auto',
  layer: 'project',
  sides: 'project',
  enforcedBy: 'nodes',
};

const v3anchor = (over = {}) => ({ ...BASE, appliesTo: { roles: ['ревьюер'] }, ...over });
const v2doc = (...anchors) => ({ version: 2, anchors });
const v3doc = (...anchors) => ({ version: 3, anchors });

test('константа версии: ANCHORS_VERSION_V3 === 3', () => {
  assert.equal(ANCHORS_VERSION_V3, 3);
});

test('v3: валидный якорь с appliesTo.roles проходит', () => {
  const result = validateAnchorsDoc(v3doc(v3anchor()));
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('v3: несколько ролей и несколько якорей — валидно', () => {
  const doc = v3doc(
    v3anchor({ id: 'A1', appliesTo: { roles: ['ревьюер', 'приёмщик'] } }),
    v3anchor({ id: 'A2', appliesTo: { roles: ['аудитор'] } }),
  );
  assert.equal(validateAnchorsDoc(doc).ok, true);
});

test('v3: без appliesTo — отказ', () => {
  const result = validateAnchorsDoc(v3doc({ ...BASE }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' | '), /appliesTo/u);
});

test('v3: пустые roles — отказ', () => {
  const result = validateAnchorsDoc(v3doc(v3anchor({ appliesTo: { roles: [] } })));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' | '), /appliesTo\.roles/u);
});

test('v3: roles — не массив, пустая или нестроковая роль — отказ', () => {
  for (const roles of ['ревьюер', null, 42, [''], ['  '], [7], ['ревьюер', '']]) {
    const result = validateAnchorsDoc(v3doc(v3anchor({ appliesTo: { roles } })));
    assert.equal(result.ok, false, JSON.stringify(roles) + ' — не список непустых ролей');
  }
});

test('v3: пустые id/claim/check — отказ, как и в v2', () => {
  for (const field of ['id', 'claim', 'check', 'status']) {
    const anchor = v3anchor({ [field]: '' });
    const result = validateAnchorsDoc(v3doc(anchor));
    assert.equal(result.ok, false, field + ' пуст — якорь невалиден');
    assert.match(result.errors.join(' | '), new RegExp(field, 'u'));
  }
});

test('v3: повторяющийся id — отказ', () => {
  const result = validateAnchorsDoc(v3doc(v3anchor(), v3anchor()));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' | '), /повторяется/u);
});

test('v3: статус не из прежнего набора — отказ', () => {
  const result = validateAnchorsDoc(v3doc(v3anchor({ status: 'draft' })));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' | '), /status/u);
  for (const status of ['auto', 'semi', 'inWork', 'retired', 'active']) {
    assert.equal(validateAnchorsDoc(v3doc(v3anchor({ status }))).ok, true, status + ' — прежний статус');
  }
});

test('v2: документ без appliesTo читается по-прежнему', () => {
  const result = validateAnchorsDoc(v2doc({ ...BASE }));
  assert.deepEqual(result, { ok: true, errors: [] });
  /* v2 с уже заполненным appliesTo не отвергается: поле просто не требуется. */
  assert.equal(validateAnchorsDoc(v2doc(v3anchor())).ok, true);
});

test('v2: version 1 и неизвестная версия — отказ с названием версии', () => {
  for (const version of [1, 4, 'три', undefined]) {
    const result = validateAnchorsDoc({ version, anchors: [{ ...BASE }] });
    assert.equal(result.ok, false, String(version) + ' — не v2 и не v3');
    assert.match(result.errors.join(' | '), /version/u);
  }
});

test('корень не объект или anchors не массив — отказ', () => {
  for (const doc of [null, undefined, [], 'anchors', 42]) {
    assert.equal(validateAnchorsDoc(doc).ok, false);
  }
  assert.equal(validateAnchorsDoc({ version: 3 }).ok, false);
});

const policyOf = (extra) => {
  const built = buildGraph([{
    name: 'structure/graph.json',
    text: JSON.stringify({ version: 1, nodes: [], edges: [], folders: [], ...extra }),
  }]);
  return built;
};

test('anchorsPolicy: 45 дней доходит до графа', () => {
  const built = policyOf({ anchorsPolicy: { maxAgeDays: 45 } });
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.graph.anchorsPolicy, { maxAgeDays: 45 });
});

test('anchorsPolicy: отсутствие поля — по умолчанию 30', () => {
  const built = policyOf({});
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.graph.anchorsPolicy, { maxAgeDays: 30 });
  /* Пустой объект политики тоже означает «по умолчанию», а не ошибку. */
  assert.deepEqual(policyOf({ anchorsPolicy: {} }).graph.anchorsPolicy, { maxAgeDays: 30 });
});

test('anchorsPolicy: 0/3660/не-число — ошибка структуры с названием поля', () => {
  for (const maxAgeDays of [0, 3660, -1, 1.5, '45', null, true]) {
    const built = policyOf({ anchorsPolicy: { maxAgeDays } });
    assert.ok(built.errors.length > 0, JSON.stringify(maxAgeDays) + ' — некорректный срок');
    assert.match(built.errors.map((item) => item.message).join(' | '), /anchorsPolicy\.maxAgeDays/u);
  }
  assert.match(policyOf({ anchorsPolicy: 45 }).errors.map((item) => item.message).join(' | '), /anchorsPolicy/u);
});

test('anchorsPolicy: границы 1 и 3650 допустимы', () => {
  for (const maxAgeDays of [1, 3650]) {
    const built = policyOf({ anchorsPolicy: { maxAgeDays } });
    assert.deepEqual(built.errors, []);
    assert.equal(built.graph.anchorsPolicy.maxAgeDays, maxAgeDays);
  }
});

test('anchorsPolicy: разные значения в фрагментах — ошибка', () => {
  const built = buildGraph([
    { name: 'structure/a.json', text: JSON.stringify({ version: 1, nodes: [], folders: [], edges: [], anchorsPolicy: { maxAgeDays: 20 } }) },
    { name: 'structure/b.json', text: JSON.stringify({ version: 1, anchorsPolicy: { maxAgeDays: 40 } }) },
  ]);
  assert.ok(built.errors.some((item) => item.code === 'anchors-policy-conflict'));
});

test('миграция: подтверждённая карта — v3 и роли перенесены', () => {
  const doc = v2doc(
    { ...BASE, id: 'A1' },
    { ...BASE, id: 'A2' },
  );
  const result = migrateAnchorsV3(doc, {
    A1: ['ревьюер', 'приёмщик'],
    A2: ['аудитор'],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.missingRoles, []);
  assert.equal(result.doc.version, 3);
  assert.deepEqual(result.doc.anchors[0].appliesTo, { roles: ['ревьюер', 'приёмщик'] });
  assert.deepEqual(result.doc.anchors[1].appliesTo, { roles: ['аудитор'] });
  /* Чистая функция: вход не переписан. */
  assert.equal(doc.version, 2);
  assert.equal(doc.anchors[0].appliesTo, undefined);
});

test('миграция: роль не подтверждена — отказ с id, автовывода нет', () => {
  const doc = v2doc({ ...BASE, id: 'A1' }, { ...BASE, id: 'A2' });
  for (const mapping of [{}, { A1: ['ревьюер'] }, { A1: [] }, { A1: 'ревьюер' }, null]) {
    const result = migrateAnchorsV3(doc, mapping);
    assert.equal(result.ok, false, JSON.stringify(mapping) + ' — без ролей A2');
    assert.ok(result.missingRoles.includes('A2'), 'отказ называет A2: ' + JSON.stringify(result.missingRoles));
  }
  const none = migrateAnchorsV3(doc, {});
  assert.deepEqual(none.missingRoles, ['A1', 'A2']);
  /* Поле consumes в якоре не участвует: миграция его не читает. */
  const withConsumes = migrateAnchorsV3(
    v2doc({ ...BASE, id: 'A1', consumes: ['A2'], appliesToKinds: ['reviewer'] }),
    {},
  );
  assert.equal(withConsumes.ok, false);
  assert.deepEqual(withConsumes.missingRoles, ['A1']);
});

test('миграция: мигрированный документ проходит строгую v3-схему и уже v3 не мигрируется заново', () => {
  const once = migrateAnchorsV3(v2doc({ ...BASE, id: 'A1' }), { A1: ['ревьюер'] });
  assert.equal(validateAnchorsDoc(once.doc).ok, true);
  const twice = migrateAnchorsV3(once.doc, {});
  assert.equal(twice.ok, true, 'повторная миграция не переписывает подтверждённые роли');
  assert.deepEqual(twice.doc.anchors[0].appliesTo, { roles: ['ревьюер'] });
});

test('миграция: битые входные данные — отказ, не исключение', () => {
  for (const doc of [null, undefined, [], 42, { version: 3 }, { version: 2, anchors: 'нет' }]) {
    const result = migrateAnchorsV3(doc, {});
    assert.equal(result.ok, false, JSON.stringify(doc) + ' — не мигрируется');
    assert.ok(Array.isArray(result.errors));
  }
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('ANCHORS V3 TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exitCode = failures.length === 0 ? 0 : 1;
