#!/usr/bin/env node
/**
 * Задание 0373 — адресат письма разрешается при записи.
 *
 * До правки при отсутствии адресата в шапку подставлялся литерал «coordinator»,
 * а переданное значение уходило в файл без проверки: опечатка в ярлыке всплывала
 * только на чтении, как причина пропуска у сторожа. Теперь запись сама разрешает
 * адресата: имя своего воркспейса по умолчанию, ярлык участника, абсолютный путь
 * его корня, устаревшая роль/узел (пишется, но помечается) и отказ до записи для
 * неразрешимого значения с тремя ближайшими ярлыками.
 *
 * Только временные каталоги: ящик и корни — подкаталоги песочницы теста.
 *
 *   node test/addressee-write.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHeader, writeExchangeMessage } from '../lib/exchange.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* временный каталог */ }
}

/** Песочница: три корня-воркспейса и общий ящик рядом с ними. */
function sandbox(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-addressee-' + tag + '-'));
  const structure = path.join(base, 'ws-structure');
  const workflow = path.join(base, 'ws-workflow');
  const analysis = path.join(base, 'ws-analysis');
  for (const dir of [structure, workflow, analysis]) fs.mkdirSync(dir, { recursive: true });
  const thread = path.join(base, 'coordination', 'threads', 'critic-report');
  fs.mkdirSync(thread, { recursive: true });
  return { base, structure, workflow, analysis, thread };
}

function participantsOf(h) {
  return { structure: h.structure, workflow: h.workflow, analysis: h.analysis };
}

/** Письма в ящике песочницы: только временный каталог теста. */
function letters(h) {
  return fs.readdirSync(h.thread)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const file = path.join(h.thread, name);
      return { file, name, text: fs.readFileSync(file, 'utf8') };
    });
}

function write(h, extra = {}) {
  return writeExchangeMessage(h.structure, {
    paths: [path.join(h.base, 'coordination')],
    participants: participantsOf(h),
    thread: 'critic-report',
    body: 'текст письма',
    ...extra,
  });
}

/* ------------------------------------------------------------------------- *
 * 1. Без адресата — ярлык своего воркспейса, литерала «coordinator» нет
 * ------------------------------------------------------------------------- */
test('1: без адресата письмо адресовано своему ярлыку, литерала coordinator нет', () => {
  const h = sandbox('default');
  try {
    const result = write(h);
    assert.deepEqual(result.addressee, { kind: 'label', label: 'structure', resolved: true },
      'умолчание — ярлык своего воркспейса');
    const list = letters(h);
    assert.equal(list.length, 1, 'письмо записано');
    const head = parseHeader(list[0].text);
    assert.equal(head.from, 'structure', 'отправитель по-прежнему свой ярлык');
    assert.equal(head.to, 'structure', 'получатель — свой ярлык');
    assert.equal(list[0].text.includes('coordinator'), false, 'литерала coordinator в письме нет');
    assert.equal(result.relative.endsWith(list[0].name), true, 'прежнее поле relative сохранено');
    assert.equal(typeof result.absolute, 'string', 'прежнее поле absolute сохранено');
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 2. Без карты участников — имя каталога корня
 * ------------------------------------------------------------------------- */
test('2: без карты участников адресат — имя каталога корня', () => {
  const h = sandbox('no-map');
  try {
    const result = writeExchangeMessage(h.structure, {
      paths: [path.join(h.base, 'coordination')],
      thread: 'critic-report',
      body: 'без карты',
    });
    assert.deepEqual(result.addressee, { kind: 'label', label: 'ws-structure', resolved: true });
    const list = letters(h);
    assert.equal(list.length, 1, 'письмо записано');
    assert.equal((parseHeader(list[0].text) || {}).to, 'ws-structure', 'To — имя каталога корня');
    assert.equal(list[0].text.includes('coordinator'), false, 'литерала coordinator нет и здесь');
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 3. Явный ярлык участника — label
 * ------------------------------------------------------------------------- */
test('3: ярлык участника разрешается как label', () => {
  const h = sandbox('label');
  try {
    const result = write(h, { to: 'workflow' });
    assert.deepEqual(result.addressee, { kind: 'label', label: 'workflow', resolved: true });
    const list = letters(h);
    assert.equal(list.length, 1, 'письмо записано');
    assert.equal((parseHeader(list[0].text) || {}).to, 'workflow');
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 4. Абсолютный путь корня — path, в label соответствующий ярлык
 * ------------------------------------------------------------------------- */
test('4: абсолютный путь корня — path с ярлыком', () => {
  const h = sandbox('path');
  try {
    const result = write(h, { to: h.workflow });
    assert.deepEqual(result.addressee, { kind: 'path', label: 'workflow', resolved: true },
      'путь разрешён в ярлык участника');
    const list = letters(h);
    assert.equal(list.length, 1, 'письмо записано');
    assert.equal((parseHeader(list[0].text) || {}).to, 'workflow', 'в шапку пишется разрешённый ярлык');
    assert.equal(list[0].text.includes(h.workflow), false, 'абсолютного пути в письме не осталось');
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 5. Устаревший адрес: роль или id узла — legacy, письмо пишется
 * ------------------------------------------------------------------------- */
test('5: роль узла — legacy, письмо написано', () => {
  const h = sandbox('legacy');
  try {
    const result = write(h, { to: 'reviewer-1' });
    assert.deepEqual(result.addressee, { kind: 'legacy', label: 'reviewer-1', resolved: false },
      'роль/узел — устаревший адрес, не отказ');
    /* Регистр не важен: Critic — тот же id узла, что и critic. */
    const upper = write(h, { to: 'Critic' });
    assert.equal(upper.addressee.kind, 'legacy', 'Critic — тоже устаревший адрес');
    const list = letters(h);
    assert.equal(list.length, 2, 'оба письма записаны');
    const heads = list.map((item) => (parseHeader(item.text) || {}).to).sort();
    assert.deepEqual(heads, ['Critic', 'reviewer-1'], 'устаревший адрес остаётся в шапке как назван');
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 6. Неразрешимый адресат — отказ до записи, подсказка трёх ярлыков
 * ------------------------------------------------------------------------- */
test('6: неизвестный адресат — addressee-unresolved с подсказкой и без файла', () => {
  const h = sandbox('unknown');
  try {
    const participants = {
      structure: h.structure,
      workflow: h.workflow,
      analysis: h.analysis,
      'workspace-a': path.join(h.base, 'ws-a'),
      'workspace-b': path.join(h.base, 'ws-b'),
    };
    let error = null;
    try {
      writeExchangeMessage(h.structure, {
        paths: [path.join(h.base, 'coordination')],
        participants,
        thread: 'critic-report',
        to: 'workspace-typo',
        body: 'не должно записаться',
      });
    } catch (caught) { error = caught; }
    assert.ok(error, 'ошибка выброшена');
    assert.equal(error.code, 'addressee-unresolved', 'код отказа');
    assert.match(String(error.message), /workspace-typo/u, 'назван адресат');
    /* Сначала совпадение начала строки, затем алфавит: workspace-a, workspace-b, workflow. */
    assert.deepEqual(error.suggestions, ['workspace-a', 'workspace-b', 'workflow'],
      'три ближайших ярлыка: начало строки, затем алфавит');
    assert.match(String(error.message), /workspace-a/u, 'подсказка названа в тексте');
    assert.match(String(error.message), /workspace-b/u, 'вторая подсказка в тексте');
    assert.match(String(error.message), /workflow/u, 'третья подсказка в тексте');
    assert.equal(letters(h).length, 0, 'файл не записан');
  } finally { rmrf(h.base); }
});

test('6b: абсолютный путь вне карты — тоже отказ без файла', () => {
  const h = sandbox('unknown-path');
  try {
    let error = null;
    try {
      write(h, { to: path.join(h.base, 'elsewhere') });
    } catch (caught) { error = caught; }
    assert.ok(error, 'ошибка выброшена');
    assert.equal(error.code, 'addressee-unresolved');
    assert.match(String(error.message), /elsewhere/u, 'назван путь');
    assert.equal(letters(h).length, 0, 'файл не записан');
  } finally { rmrf(h.base); }
});

/* ------------------------------------------------------------------------- *
 * 7. Список адресатов прежних вызовов не ломается (сборка через ', ')
 * ------------------------------------------------------------------------- */
test('7: список адресатов пишется, ярлыки разрешены, роли помечены', () => {
  const h = sandbox('list');
  try {
    const result = write(h, { to: 'workflow, reviewer-1' });
    assert.equal(result.addressee.kind, 'legacy', 'в списке есть устаревший адрес');
    assert.equal(result.addressee.resolved, false);
    const list = letters(h);
    assert.equal(list.length, 1, 'письмо записано');
    assert.equal((parseHeader(list[0].text) || {}).to, 'workflow, reviewer-1',
      'ярлык разрешён, роль осталась как названа');
  } finally { rmrf(h.base); }
});

if (failures.length > 0) {
  for (const item of failures) {
    console.log('FAIL ' + item.name + ': ' + (item.error && item.error.message ? item.error.message : item.error));
  }
  console.log('ADDRESSEE WRITE TEST FAIL: ' + passed + '/' + (passed + failures.length));
  process.exit(1);
}
console.log('ADDRESSEE WRITE TEST OK: ' + passed + '/' + passed);
console.log('writer resolves the addressee: own label by default, label/path/legacy, unresolved before the file');
