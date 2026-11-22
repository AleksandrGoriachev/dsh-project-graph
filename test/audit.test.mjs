/**
 * 0177: схема audit.json — вердикт узла «Аудитор задач».
 *
 * Гейт запуска не гадает: conform с непустыми anchors и reason пропускает,
 * rework и любая дыра в обязательных полях — отказ. Эти тесты держат ту же
 * схему, что читает lib/spawn.js, поэтому «валидно» здесь значит «валидно» и
 * для запуска задания.
 */
import assert from 'node:assert/strict';
import { validateAudit } from '../lib/audit.js';

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

const AUDIT = (over = {}) => ({
  version: 1,
  task: '0177',
  auditor: 'auditor',
  verdict: 'conform',
  anchors: [{ id: 'A1', claim: 'палитра содержит аудитора', check: 'checks/0177-auditor.mjs c1', status: 'confirmed' }],
  requiredChecks: [{ id: 'C1', status: 'pass' }],
  reason: 'якоря сходятся с критериями',
  at: '2026-11-09T00:00:00.000Z',
  ...over,
});

/** Все ошибки одной строкой: так проверка видит причину отказа. */
function errorsOf(audit) {
  const result = validateAudit(audit);
  assert.equal(typeof result.ok, 'boolean', 'ok — булево');
  assert.ok(Array.isArray(result.errors), 'errors — массив');
  return result.errors.join(' | ');
}

test('conform с anchors и reason — ok', () => {
  const result = validateAudit(AUDIT());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('conform с якорями claim/check/status/approval — ok', () => {
  const audit = AUDIT({
    anchors: [
      { id: 'A1', claim: 'аудитор в палитре', check: '0177 c1', status: 'confirmed' },
      { id: 'A2', claim: 'audit.json обязателен', check: '0177 c3', status: 'confirmed' },
    ],
  });
  assert.equal(validateAudit(audit).ok, true);
});

test('rework — отказ, даже если файл заполнен полностью', () => {
  const result = validateAudit(AUDIT({ verdict: 'rework' }));
  assert.equal(result.ok, false, 'rework не пропускает запуск');
  assert.match(errorsOf(AUDIT({ verdict: 'rework' })), /rework/u);
});

test('пустые anchors — отказ', () => {
  const result = validateAudit(AUDIT({ anchors: [] }));
  assert.equal(result.ok, false);
  assert.match(errorsOf(AUDIT({ anchors: [] })), /anchors/u);
});

test('anchors не список — отказ', () => {
  assert.equal(validateAudit(AUDIT({ anchors: 'A1' })).ok, false);
  assert.match(errorsOf(AUDIT({ anchors: 'A1' })), /anchors/u);
});

test('якорь-не-объект — отказ', () => {
  assert.equal(validateAudit(AUDIT({ anchors: ['A1'] })).ok, false);
  assert.ok(errorsOf(AUDIT({ anchors: ['A1'] })).includes('anchors[0]'), 'отказ называет индекс якоря');
});

test('пустой reason у conform — отказ', () => {
  assert.equal(validateAudit(AUDIT({ reason: '   ' })).ok, false);
  assert.match(errorsOf(AUDIT({ reason: '   ' })), /reason/u);
});

test('нет version — ошибка', () => {
  const audit = AUDIT();
  delete audit.version;
  assert.equal(validateAudit(audit).ok, false);
  assert.match(errorsOf(audit), /version/u);
});

test('нет task — ошибка', () => {
  const audit = AUDIT();
  delete audit.task;
  assert.equal(validateAudit(audit).ok, false);
  assert.match(errorsOf(audit), /task/u);
});

test('нет at — ошибка', () => {
  const audit = AUDIT();
  delete audit.at;
  assert.equal(validateAudit(audit).ok, false);
  assert.match(errorsOf(audit), /at\b/u);
});

test('нет verdict — ошибка', () => {
  const audit = AUDIT();
  delete audit.verdict;
  assert.equal(validateAudit(audit).ok, false);
  assert.match(errorsOf(audit), /verdict/u);
});

test('неизвестный verdict — ошибка', () => {
  assert.equal(validateAudit(AUDIT({ verdict: 'ok' })).ok, false);
  assert.match(errorsOf(AUDIT({ verdict: 'ok' })), /verdict/u);
});

test('корень не JSON-объект — ошибка', () => {
  for (const value of [null, undefined, [], 'conform', 42]) {
    const result = validateAudit(value);
    assert.equal(result.ok, false, 'значение ' + JSON.stringify(value) + ' не пропущено');
    assert.match(result.errors.join(' | '), /audit\.json/u);
  }
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAIL: ' + failure.name);
    console.error(failure.error && failure.error.stack ? failure.error.stack : failure.error);
  }
  console.error('AUDIT TEST FAILED: ' + failures.length + ' из ' + (passed + failures.length));
  process.exit(1);
}
console.log('AUDIT TEST OK: ' + passed + '/' + passed);
