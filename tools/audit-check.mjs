#!/usr/bin/env node
/**
 * Задание 0368: проверка качества постановки задания машиной.
 *
 *   node tools/audit-check.mjs --task docs/tasks/0368 [--json]
 *
 * Считает рубрику (lib/audit-rubric.js) по артефактам каталога задания —
 * task.md, criteria.json, red.json, red.log и дереву проекта — печатает таблицу
 * «пункт — вердикт — доказательство» и пишет docs/tasks/<id>/audit-evidence.json
 * (version, task, at, items[{ code, verdict ok|fail|na, evidence }]).
 *
 * Коды выхода: 0 — все применимые пункты ok; 1 — есть fail; 2 — неверные
 * аргументы (нет --task, лишний аргумент, в каталоге нет task.md).
 *
 * Пишет только внутрь каталога задания (инвариант 2 задания): путь к
 * audit-evidence.json — это taskDir/audit-evidence.json и ничего больше.
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeRubric, readRubricInput, RUBRIC_VERSION } from '../lib/audit-rubric.js';

const USAGE = 'usage: node tools/audit-check.mjs --task <каталог задания> [--json]';

function fail(code, message) {
  if (message) console.error(message);
  process.exit(code);
}

const argv = process.argv.slice(2);
let taskArg = '';
let asJson = false;
let invalid = '';
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--task') {
    taskArg = argv[index + 1] === undefined ? '' : String(argv[index + 1]);
    index += 1;
    if (!taskArg || taskArg.startsWith('--')) invalid = 'после --task нужен каталог задания';
  } else if (arg === '--json') {
    asJson = true;
  } else if (arg === '--help' || arg === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else {
    invalid = 'неизвестный аргумент: ' + arg;
  }
}
if (invalid) fail(2, USAGE + '\n' + invalid);
if (!taskArg) fail(2, USAGE + '\nне указан --task');

const taskDir = path.resolve(taskArg);
let stat = null;
try {
  stat = fs.statSync(taskDir);
} catch {
  stat = null;
}
if (!stat || !stat.isDirectory()) fail(2, 'audit-check: нет каталога задания: ' + taskArg);
if (!fs.existsSync(path.join(taskDir, 'task.md'))) {
  fail(2, 'audit-check: в каталоге нет task.md: ' + taskArg);
}

const input = readRubricInput(taskDir);
const computed = computeRubric(input);
const evidence = {
  version: RUBRIC_VERSION,
  task: input.id,
  at: new Date().toISOString(),
  items: computed.items.map((item) => ({ code: item.code, verdict: item.verdict, evidence: item.evidence })),
};
const evidencePath = path.join(taskDir, 'audit-evidence.json');
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');

if (asJson) {
  console.log(JSON.stringify(evidence, null, 2));
} else {
  const width = Math.max(5, ...computed.items.map((item) => item.code.length));
  const line = (left, mid, right) => left + '  ' + mid.padEnd(7, ' ') + '  ' + right;
  console.log('задание: ' + path.relative(process.cwd(), taskDir).split(path.sep).join('/')
    + ' (id ' + input.id + ', риск ' + (input.risk || '—') + ')');
  console.log('файл: ' + path.relative(process.cwd(), evidencePath).split(path.sep).join('/'));
  console.log('');
  console.log(line('пункт'.padEnd(width, ' '), 'вердикт', 'доказательство'));
  console.log(line('-'.repeat(width), '-------', '--------------'));
  for (const item of computed.items) {
    console.log(line(item.code.padEnd(width, ' '), item.verdict, item.evidence));
  }
  console.log('');
  const counts = computed.counts;
  console.log('итог: ' + (computed.failures.length === 0 ? 'ok' : 'fail')
    + ' — ok ' + counts.ok + ', na ' + counts.na + ', fail ' + counts.fail
    + (computed.failures.length > 0 ? ' (' + computed.failures.join(', ') + ')' : ''));
}

process.exit(computed.failures.length > 0 ? 1 : 0);
