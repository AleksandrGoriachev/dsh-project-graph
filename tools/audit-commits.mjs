#!/usr/bin/env node
/**
 * Detector of gate bypasses in a git range.
 *
 * The source of truth is the gate itself: docs/subagent-workflow/scripts/task-guard.mjs
 * is asked for an audit of the range, and its per-commit verdicts are parsed. This
 * tool only turns them into a list "SHA — verdict" and an exit code, so a bypass
 * ("обход по метке") is discoverable without reading the guard's internals.
 *
 * The audited window is marker..HEAD. The marker is .git/audit-commits.seen and is
 * written only by --update-state; on the first run (no marker) the window is
 * HEAD~40..HEAD. --range <a..b> overrides the window for one run.
 *
 * Exit codes: 0 — every commit covered (labelled bypasses included), 1 — at least
 * one commit is not covered, 2 — the tool could not run (not a git repo, no guard,
 * bad arguments).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MARKER_NAME = 'audit-commits.seen';

/** Print one diagnostic line to stderr and stop with a stable code. */
function die(message, code = 2) {
  process.stderr.write('audit-commits: ' + message + '\n');
  process.exit(code);
}

/** Run git in the repository and return its trimmed stdout, or null on failure. */
function git(repo, args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

/** Parse the command line: --range <a..b> | --range=<a..b> | --update-state | --help. */
function parseArgs(argv) {
  const options = { range: '', updateState: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--update-state') {
      options.updateState = true;
      continue;
    }
    if (arg === '--range') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) die('--range требует значение <a..b>');
      options.range = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--range=')) {
      options.range = arg.slice('--range='.length);
      continue;
    }
    die('неизвестный аргумент: ' + arg + ' (см. --help)');
  }
  return options;
}

function usage() {
  return [
    'Usage: node tools/audit-commits.mjs [--range <a..b>] [--update-state]',
    '',
    '  --range <a..b>   проверить указанный диапазон вместо окна от маркера',
    '  --update-state   записать текущий конец окна в .git/audit-commits.seen',
    '',
    'Без --range окно: <маркер>..HEAD; при первом запуске — HEAD~40..HEAD.',
    'Печатает SHA и вердикт каждого коммита: покрыт | обход по метке "…" | не покрыт.',
    'Exit 1 — есть непокрытые коммиты, 0 — все покрыты, 2 — проверка не выполнена',
    '   (в том числе непустой диапазон, из которого не распознан ни один вердикт).',
  ].join('\n');
}

/** Full commit id for an abbreviated id printed by task-guard. */
function expandSha(repo, short) {
  const full = git(repo, ['rev-parse', '--verify', short + '^{commit}']);
  return full && /^[0-9a-f]{40,64}$/iu.test(full) ? full : short;
}

/**
 * One verdict from a task-guard audit line.
 *
 * The guard prints "  <short> <subject> — покрыт (N)", "… — обход по метке "label""
 * or "… — не покрыт". "не покрыт" must be tested before "покрыт": the first
 * contains the second.
 */
function verdictOf(line) {
  if (!/^\s+[0-9a-f]{7,40}\s+/iu.test(line)) return null;
  if (/—\s*обход по метке\s*"([^"]+)"/u.test(line)) {
    const label = /—\s*обход по метке\s*"([^"]+)"/u.exec(line)[1];
    return 'обход по метке "' + label + '"';
  }
  if (/—\s*не покрыт/u.test(line)) return 'не покрыт';
  if (/—\s*покрыт/u.test(line)) return 'покрыт';
  return null;
}

/**
 * Resolve the audit window: explicit range, then the marker, then the first-run
 * fallback. HEAD~40 may not exist in a young repository; the empty tree covers
 * every commit then, and "HEAD~40..HEAD" stays the documented first window.
 */
function resolveRange(repo, gitDir, explicit) {
  if (explicit) {
    const value = String(explicit).trim();
    if (!value.includes('..') || value.startsWith('..') || value.endsWith('..')) {
      die('--range ожидает <a..b>, получено: ' + value);
    }
    const from = value.slice(0, value.indexOf('..'));
    const to = value.slice(value.indexOf('..') + 2);
    if (!to) die('--range ожидает <a..b>, получено: ' + value);
    if (!git(repo, ['rev-parse', '--verify', '--quiet', from + '^{commit}'])) {
      die('начало диапазона не найдено: ' + from);
    }
    if (!git(repo, ['rev-parse', '--verify', '--quiet', to + '^{commit}'])) {
      die('конец диапазона не найден: ' + to);
    }
    return { range: from + '..' + to, end: git(repo, ['rev-parse', '--verify', to + '^{commit}']) };
  }
  const markerFile = path.join(gitDir, MARKER_NAME);
  let marker = '';
  try {
    marker = String(fs.readFileSync(markerFile, 'utf8')).trim().split(/\s+/u)[0] || '';
  } catch {
    marker = '';
  }
  if (marker) {
    const resolved = git(repo, ['rev-parse', '--verify', '--quiet', marker + '^{commit}']);
    if (!resolved) die('маркер ' + markerFile + ' указывает на неизвестный коммит: ' + marker);
    return { range: marker + '..HEAD', end: git(repo, ['rev-parse', 'HEAD']) };
  }
  const head = git(repo, ['rev-parse', '--verify', 'HEAD']);
  if (!head) die('в репозитории нет коммитов (HEAD не разрешается)');
  const parent = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD~40']);
  const from = parent || EMPTY_TREE;
  return { range: from + '..HEAD', end: head };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const repo = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!repo) die('текущий каталог не является git-репозиторием');
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) die('не удалось определить каталог .git');
  const guard = path.join(repo, 'docs', 'subagent-workflow', 'scripts', 'task-guard.mjs');
  if (!fs.existsSync(guard)) {
    die('нет источника проверки: ' + guard);
  }
  const window = resolveRange(repo, gitDir, options.range);
  const result = spawnSync(process.execPath, [guard, '--audit', '--range', window.range], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) die('не удалось запустить task-guard: ' + result.error.message);
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (result.status !== 0 && !stdout.trim()) {
    die('task-guard завершился с кодом ' + result.status + (stderr.trim() ? ': ' + stderr.trim() : ''));
  }

  const rows = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const verdict = verdictOf(line);
    if (!verdict) continue;
    const match = /^\s+([0-9a-f]{7,40})\s+/iu.exec(line);
    if (!match) continue;
    rows.push({ sha: expandSha(repo, match[1]), verdict });
  }

  /*
   * A non-empty range with zero recognized verdicts is not "clean": it means the
   * guard printed something this tool cannot read (its output format changed).
   * Silence would be read as approval, so the run fails instead of reporting 0.
   */
  const commits = Number.parseInt(git(repo, ['rev-list', '--count', window.range]) || '0', 10);

  process.stdout.write('audit-commits: диапазон ' + window.range + ' (коммитов: ' + rows.length + ')\n');
  for (const row of rows) {
    process.stdout.write(row.sha + ' — ' + row.verdict + '\n');
  }
  if (rows.length === 0) {
    if (!Number.isFinite(commits) || commits <= 0) {
      process.stdout.write('итог: диапазон пуст, проверять нечего\n');
      process.exit(0);
    }
    process.stderr.write('audit-commits: в диапазоне ' + commits + ' коммит(ов), но ни одна строка вывода не распознана'
      + ' — формат вывода task-guard изменился, «чисто» не доказано\n');
    process.exit(2);
  }
  const bypass = rows.filter((row) => row.verdict.startsWith('обход по метке')).length;
  const uncovered = rows.filter((row) => row.verdict === 'не покрыт').length;
  process.stdout.write('итог: покрыто ' + (rows.length - uncovered) + ', обходов по метке ' + bypass
    + ', не покрыто ' + uncovered + '\n');

  if (options.updateState) {
    if (uncovered > 0) {
      process.stderr.write('audit-commits: маркер не обновлён — есть непокрытые коммиты\n');
    } else {
      try {
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(path.join(gitDir, MARKER_NAME), window.end + '\n', 'utf8');
        process.stdout.write('маркер обновлён: ' + path.join(gitDir, MARKER_NAME) + ' -> ' + window.end + '\n');
      } catch (error) {
        die('не удалось записать маркер: ' + (error && error.message ? error.message : String(error)));
      }
    }
  }

  process.exit(uncovered > 0 ? 1 : 0);
}

main();
