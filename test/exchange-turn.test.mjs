#!/usr/bin/env node
/**
 * Открытые заявки: режим check-exchange --box/--me/--turn (задание 0328).
 *
 * Набор доказывает обещания --turn: заявка request|question, адресованная --me,
 * открыта, пока answer|ack не назвал её в Reply-To или Ref. Адрес закрытия
 * разрешается абсолютным путём, путём от каталога ящика, путём от каталога
 * самого письма и голым именем в каталоге письма; Ref перечисляет несколько
 * адресов через запятую и точку с запятой. Неверный адрес заявку не закрывает.
 *
 * Отдельно проверено, что режим не читает структуру, не требует и не создаёт
 * DSH_PROJECT_GRAPH_STORE, что --turn без --box/--me и с --mark/--gate — ошибка
 * с рецептом, и что обычный --box/--me (непрочитанное) не изменился.
 *
 * Временные каталоги только в os.tmpdir: в репозиторий набор ничего не пишет.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(path.resolve(here, '..'), 'tools', 'check-exchange.mjs');

/** Письмо dsh-exchange/1; по умолчанию — входящий request для structure. */
function letter(overrides = {}) {
  const fields = {
    from: 'workflow',
    to: 'structure',
    date: '2026-11-21T12:00:00+03:00',
    status: 'request',
    subject: 'тема',
    replyTo: '',
    ref: '',
    ...overrides,
  };
  return 'Format: dsh-exchange/1\n'
    + 'From: ' + fields.from + '\n'
    + 'To: ' + fields.to + '\n'
    + 'Date: ' + fields.date + '\n'
    + 'Thread: exchange\n'
    + 'Status: ' + fields.status + '\n'
    + (fields.replyTo ? 'Reply-To: ' + fields.replyTo + '\n' : '')
    + (fields.ref ? 'Ref: ' + fields.ref + '\n' : '')
    + 'Subject: ' + fields.subject + '\n\nтело письма\n';
}

/**
 * Каталог-доска с письмами. По умолчанию письма лежат в <dir>/threads/exchange;
 * options.threads === false — письма в корне каталога (запасной путь сканера).
 */
function makeBox(files = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-turn-0328-'));
  const box = options.threads === false ? dir : path.join(dir, 'threads', 'exchange');
  fs.mkdirSync(box, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(box, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return { dir, box };
}

/** Дописать письмо в уже созданную доску. */
function write(boxInfo, name, text) {
  const file = path.join(boxInfo.box, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** Вызов CLI с чистым окружением: DSH_PROJECT_GRAPH_STORE удаляется, если не задан. */
function run(args, options = {}) {
  const env = { ...process.env };
  delete env.DSH_PROJECT_GRAPH_STORE;
  Object.assign(env, options.env || {});
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env,
    cwd: options.cwd,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return { status: result.status, stdout, stderr, out: stdout + stderr };
}

/** Имена писем из вывода: строка счёта пропускается, пути сравниваются по имени. */
function listedNames(stdout) {
  return String(stdout).split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(1)
    .map((line) => line.split(/[\\/]/u).pop());
}

let passed = 0;
const failures = [];
function test(name, body) {
  try {
    body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : error));
  }
}

test('заявка без ответа открыта, ответ по Reply-To её закрывает', () => {
  const box = makeBox({
    'unanswered.md': letter({ subject: 'ждёт' }),
    'answered.md': letter({ subject: 'отвечено' }),
    'a.md': letter({ from: 'structure', to: 'workflow', status: 'answer', replyTo: 'threads/exchange/answered.md' }),
  });
  const result = run(['--box', box.dir, '--me', 'structure', '--turn']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stdout, /открытых заявок: 1\b/u, result.stdout);
  const names = listedNames(result.stdout);
  assert.deepEqual(names, ['unanswered.md'], result.stdout);
});

test('ack закрывает по Ref; Ref перечисляет адреса через запятую и точку с запятой', () => {
  const box = makeBox({
    'r-comma.md': letter({ subject: 'comma' }),
    'ack-comma.md': letter({ from: 'structure', to: 'workflow', status: 'ack', ref: 'threads/exchange/r-comma.md, threads/exchange/missing.md' }),
    'r-semicolon.md': letter({ subject: 'semicolon' }),
    'ack-semicolon.md': letter({ from: 'structure', to: 'workflow', status: 'ack', ref: 'threads/exchange/missing.md; threads/exchange/r-semicolon.md' }),
  });
  const result = run(['--box', box.dir, '--me', 'structure', '--turn']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /открытых заявок: 0\b/u, result.stdout);
  assert.deepEqual(listedNames(result.stdout), [], result.stdout);
});

test('голое имя в каталоге письма закрывает и в Reply-To, и в Ref', () => {
  const box = makeBox({
    'bare-reply.md': letter({ subject: 'bare-reply' }),
    'ack-reply.md': letter({ from: 'structure', to: 'workflow', status: 'answer', replyTo: 'bare-reply.md' }),
    'bare-ref.md': letter({ subject: 'bare-ref' }),
    'ack-ref.md': letter({ from: 'structure', to: 'workflow', status: 'ack', ref: 'missing.md, bare-ref.md' }),
  });
  const result = run(['--box', box.dir, '--me', 'structure', '--turn']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /открытых заявок: 0\b/u, result.stdout);
});

test('путь от каталога ящика и путь от каталога письма закрывают', () => {
  const box = makeBox({ 'from-box.md': letter({ subject: 'from-box' }) });
  write(box, 'ack-box.md', letter({ from: 'structure', to: 'workflow', status: 'ack', replyTo: 'threads/exchange/from-box.md' }));
  write(box, 'from-letter.md', letter({ subject: 'from-letter' }));
  write(box, 'nested/ack-letter.md', letter({ from: 'structure', to: 'workflow', status: 'answer', replyTo: '../from-letter.md' }));
  const result = run(['--box', box.dir, '--me', 'structure', '--turn']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /открытых заявок: 0\b/u, result.stdout);
});

test('абсолютный путь в Reply-To закрывает заявку', () => {
  const box = makeBox({ 'absolute.md': letter({ subject: 'absolute' }) });
  const request = path.join(box.box, 'absolute.md');
  write(box, 'ack-abs.md', letter({ from: 'structure', to: 'workflow', status: 'answer', replyTo: request }));
  const result = run(['--box', box.dir, '--me', 'structure', '--turn']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /открытых заявок: 0\b/u, result.stdout);
});

test('неверный Reply-To заявку не закрывает', () => {
  const box = makeBox({
    'wrong.md': letter({ subject: 'wrong' }),
    'a.md': letter({ from: 'structure', to: 'workflow', status: 'answer', replyTo: 'threads/exchange/other.md' }),
  });
  const result = run(['--box', box.dir, '--me', 'structure', '--turn']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stdout, /открытых заявок: 1\b/u, result.stdout);
  assert.deepEqual(listedNames(result.stdout), ['wrong.md'], result.stdout);
});

test('question — заявка, report и своя копия — нет; To без регистра', () => {
  const box = makeBox({
    'q.md': letter({ status: 'question', to: 'STRUCTURE' }),
    'report.md': letter({ status: 'report' }),
    'service.md': letter({ from: 'structure', to: 'workflow' }),
    'other.md': letter({ to: 'workflow' }),
  });
  const result = run(['--box', box.dir, '--me', 'Structure', '--turn']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stdout, /открытых заявок: 1\b/u, result.stdout);
  assert.deepEqual(listedNames(result.stdout), ['q.md'], result.stdout);
});

test('без threads сканируется сам каталог; пустой ящик — 0 и код 0', () => {
  const flat = makeBox({ 'flat.md': letter({ subject: 'flat' }) }, { threads: false });
  const flatResult = run(['--box', flat.dir, '--me', 'structure', '--turn']);
  assert.equal(flatResult.status, 1, flatResult.out);
  assert.deepEqual(listedNames(flatResult.stdout), ['flat.md'], flatResult.out);
  const empty = makeBox({});
  const emptyResult = run(['--box', empty.dir, '--me', 'structure', '--turn']);
  assert.equal(emptyResult.status, 0, emptyResult.out);
  assert.match(emptyResult.stdout, /открытых заявок: 0\b/u, emptyResult.out);
});

test('без структуры и без store: работает из каталога без docs и не создаёт хранилище', () => {
  const box = makeBox({ 'in.md': letter() });
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-turn-store-')), 'store-must-not-appear');
  const result = run(['--box', box.dir, '--me', 'structure', '--turn'], {
    cwd: box.dir,
    env: { DSH_PROJECT_GRAPH_STORE: store },
  });
  assert.equal(result.status, 1, result.out);
  assert.match(result.stdout, /открытых заявок: 1\b/u, result.stdout);
  assert.equal(fs.existsSync(store), false, 'режим --turn не должен создавать хранилище');
});

test('--turn без --box/--me — ошибка с рецептом', () => {
  const box = makeBox({});
  for (const args of [['--turn'], ['--turn', '--box', box.dir], ['--turn', '--me', 'structure']]) {
    const result = run(args);
    assert.notEqual(result.status, 0, 'ожидалась ошибка: ' + args.join(' ') + ' — ' + result.out);
    assert.match(result.stderr, /--turn/u, result.stderr);
    assert.match(result.stderr, /--box/u, result.stderr);
    assert.match(result.stderr, /--me/u, result.stderr);
    assert.match(result.out, /Что сделать/u, result.out);
  }
});

test('--turn с --mark и с --gate — ошибка режима только для чтения', () => {
  const box = makeBox({ 'in.md': letter() });
  for (const flag of ['--mark', '--gate']) {
    const result = run(['--box', box.dir, '--me', 'structure', '--turn', flag]);
    assert.notEqual(result.status, 0, flag + ' не должен выполняться: ' + result.out);
    assert.match(result.stderr, /только для чтения|не выполняются/u, result.stderr);
  }
});

test('обычный --box/--me не изменился: ответ не снимает непрочитанное', () => {
  const box = makeBox({
    'in.md': letter(),
    'a.md': letter({ from: 'structure', to: 'workflow', status: 'answer', replyTo: 'threads/exchange/in.md' }),
  });
  const unread = run(['--box', box.dir, '--me', 'structure']);
  assert.equal(unread.status, 1, unread.out);
  assert.match(unread.stdout, /непрочитано: 1\b/u, unread.stdout);
  assert.doesNotMatch(unread.stdout, /открытых заявок/u, unread.stdout);
  const open = run(['--box', box.dir, '--me', 'structure', '--turn']);
  assert.equal(open.status, 0, open.out);
  assert.match(open.stdout, /открытых заявок: 0\b/u, open.stdout);
});

test('--help показывает --turn', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /--turn/u, result.stdout);
});

console.log(failures.length === 0
  ? 'EXCHANGE TURN OK: ' + passed + ' проверок — открытые заявки без структуры и store'
  : 'EXCHANGE TURN FAILED: ' + failures.length + ' из ' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
