#!/usr/bin/env node
/**
 * Hub обмена: режим check-exchange --box/--me (задание 0327).
 *
 * Набор доказывает обещания режима общей доски: входящий request требует хода
 * (код 1), чужое/своё/report/answer/ack — нет; To сравнивается без регистра;
 * threads читается рекурсивно, без threads — сам каталог; структура и
 * DSH_PROJECT_GRAPH_STORE не нужны и не создаются; один флаг из пары — ошибка
 * с рецептом. Режим только читает: --mark/--gate с --box не совмещаются.
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

/** Письмо dsh-exchange/1 с шапкой; по умолчанию — входящий request для structure. */
function letter(overrides = {}) {
  const fields = {
    from: 'workflow',
    to: 'structure',
    date: '2026-11-21T12:00:00+03:00',
    status: 'request',
    subject: 'тема',
    ...overrides,
  };
  return 'Format: dsh-exchange/1\n'
    + 'From: ' + fields.from + '\n'
    + 'To: ' + fields.to + '\n'
    + 'Date: ' + fields.date + '\n'
    + 'Thread: exchange\n'
    + 'Status: ' + fields.status + '\n'
    + 'Subject: ' + fields.subject + '\n\nтело письма\n';
}

/**
 * Каталог-доска с письмами. По умолчанию письма лежат в <dir>/threads/exchange;
 * options.threads === false — письма в корне каталога (проверка запасного пути).
 */
function makeBox(files, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-hub-0327-'));
  const base = options.threads === false ? dir : path.join(dir, 'threads', 'exchange');
  fs.mkdirSync(base, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(base, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
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

test('входящий request: код 1 и только его путь', () => {
  const dir = makeBox({
    'in.md': letter(),
    'other.md': letter({ to: 'workflow' }),
    'out.md': letter({ from: 'structure', to: 'workflow' }),
    'report.md': letter({ status: 'report' }),
    'answer.md': letter({ status: 'answer' }),
    'ack.md': letter({ status: 'ack' }),
  });
  const result = run(['--box', dir, '--me', 'structure']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stdout, /непрочитано: 1\b/u, result.stdout);
  assert.match(result.stdout, /in\.md/u, result.stdout);
  for (const name of ['other.md', 'out.md', 'report.md', 'answer.md', 'ack.md']) {
    assert.doesNotMatch(result.stdout, new RegExp(name.replace('.', '\\.'), 'u'), name + ': ' + result.stdout);
  }
});

test('вопрос и To без регистра считаются входящими', () => {
  const dir = makeBox({ 'q.md': letter({ to: 'STRUCTURE', status: 'question' }) });
  const result = run(['--box', dir, '--me', 'Structure']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stdout, /непрочитано: 1\b/u, result.stdout);
  assert.match(result.stdout, /q\.md/u, result.stdout);
});

test('чужое, своё, report, answer и ack не считаются: код 0', () => {
  const dir = makeBox({
    'other.md': letter({ to: 'workflow' }),
    'service.md': letter({ from: 'structure' }),
    'report.md': letter({ status: 'report' }),
    'answer.md': letter({ status: 'answer' }),
    'ack.md': letter({ status: 'ack' }),
  });
  const result = run(['--box', dir, '--me', 'structure']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /непрочитано: 0\b/u, result.stdout);
});

test('без store: режим работает и не создаёт хранилище', () => {
  const dir = makeBox({ 'in.md': letter() });
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-hub-store-')), 'store-must-not-appear');
  const result = run(['--box', dir, '--me', 'structure'], { env: { DSH_PROJECT_GRAPH_STORE: store } });
  assert.equal(result.status, 1, result.out);
  assert.match(result.stdout, /непрочитано: 1\b/u, result.stdout);
  assert.equal(fs.existsSync(store), false, 'режим --box не должен трогать хранилище');
});

test('threads читается рекурсивно', () => {
  const dir = makeBox({ 'sub/deep/in.md': letter() });
  const result = run(['--box', dir, '--me', 'structure']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stdout, /непрочитано: 1\b/u, result.stdout);
  assert.match(result.stdout, /in\.md/u, result.stdout);
});

test('без threads сканируется сам каталог', () => {
  const dir = makeBox({ 'in.md': letter() }, { threads: false });
  const result = run(['--box', dir, '--me', 'structure']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.stdout, /непрочитано: 1\b/u, result.stdout);
  assert.match(result.stdout, /in\.md/u, result.stdout);
});

test('один флаг из пары — ошибка с рецептом', () => {
  const dir = makeBox({});
  for (const args of [['--box', dir], ['--me', 'structure']]) {
    const result = run(args);
    assert.notEqual(result.status, 0, 'один флаг не должен выполняться: ' + result.out);
    assert.match(result.stderr, /--box/u, result.stderr);
    assert.match(result.stderr, /--me/u, result.stderr);
    assert.match(result.out, /Что сделать/u, result.out);
  }
});

test('--box только читает: --mark и --gate отклоняются', () => {
  const dir = makeBox({ 'in.md': letter() });
  for (const flag of ['--mark', '--gate']) {
    const result = run(['--box', dir, '--me', 'structure', flag]);
    assert.notEqual(result.status, 0, flag + ' не должен выполняться: ' + result.out);
    assert.match(result.stderr, /только для чтения/u, result.stderr);
  }
});

test('--help показывает оба режима', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.stdout, /--box/u, result.stdout);
  assert.match(result.stdout, /--gate/u, result.stdout);
});

console.log(failures.length === 0
  ? 'EXCHANGE HUB OK: ' + passed + ' проверок — --box/--me без структуры и store'
  : 'EXCHANGE HUB FAILED: ' + failures.length + ' из ' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
