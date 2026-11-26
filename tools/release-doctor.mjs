#!/usr/bin/env node
/*
 * Доктор релиза: показывает, где текущая версия пакета встречается литералом,
 * и отказывает, если версия закреплена в тестах.
 *
 * Текущая версия берётся из package.json — единственного источника истины.
 * Классы находок:
 *   допустимо      — манифест и документация: версия обязана там быть;
 *   запрещено      — тест закрепляет версию (константа или проверка), в том
 *                    числе устаревшую: тест должен брать версию из манифеста;
 *   предупреждение — остальные файлы, а также упоминания в тестах вне
 *                    закрепления (комментарии, фикстуры): решает человек.
 *
 * Режимы:
 *   --check     код 0 — запрещённых мест и расхождений нет;
 *               код 1 — закреплённая версия в тестах или расхождение;
 *               код 2 — неверные аргументы;
 *   --json      отчёт в JSON вместо таблицы;
 *   --root DIR  каталог проекта (по умолчанию — текущий каталог).
 *
 * Версия сравнивается по границам: короткая версия не совпадает внутри
 * длинной, а лишняя цифра спереди или сзади не делает версию текущей.
 * Пример: «1.0.9» не встречается внутри «1.0.9» плюс ещё одна цифра.
 *
 * Инструмент только читает файлы: ничего не пишет и в сеть не ходит.
 */
import fs from 'node:fs';
import path from 'node:path';

const MANIFEST = 'package.json';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/* Служебные каталоги и каталоги процесса: не релизная поверхность проекта. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.tmp',
  '.dsh',
  '.wf-keys',
  'artifacts',
  'preview-out',
  'coverage',
  'dist',
  'build',
]);

/* Каталоги заданий и отчётов проверяющих — процессные артефакты, не документация. */
const SKIP_PREFIXES = ['docs/tasks', 'docs/critic'];

const CLASS_LABEL = {
  allowed: 'допустимо',
  forbidden: 'запрещено',
  warning: 'предупреждение',
};

const CLASS_RANK = { forbidden: 0, warning: 1, allowed: 2 };

class ArgError extends Error {}

function usage() {
  console.error('Использование: node tools/release-doctor.mjs [--check] [--json] [--root DIR]');
  console.error('  --check     вернуть код 0 (в порядке), 1 (запрет/расхождение) или 2 (аргументы)');
  console.error('  --json      отчёт в JSON');
  console.error('  --root DIR  каталог проекта (по умолчанию текущий)');
}

function parseArgs(argv) {
  const args = { check: false, json: false, root: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') args.check = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new ArgError('--root требует каталог');
      args.root = value;
      index += 1;
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (!value) throw new ArgError('--root требует каталог');
      args.root = value;
    } else {
      throw new ArgError('неизвестный аргумент: ' + arg);
    }
  }
  return args;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/* Упоминание ровно этой версии: слева не цифра и не точка, справа не цифра. */
function versionPattern(version) {
  return new RegExp('(^|[^\\d.])(' + escapeRegExp(version) + ')(?![\\d])', 'gu');
}

function isTestPath(relative) {
  if (relative.startsWith('test/')) return true;
  return /(^|\/)[^/]+\.(?:test|spec)\.(?:mjs|cjs|js|ts)$/u.test(relative);
}

function isDocsPath(relative) {
  if (relative.startsWith('docs/')) return true;
  return /\.(?:md|mdx|markdown|txt)$/iu.test(relative);
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function walk(root, relative, files) {
  const directory = relative ? path.join(root, relative) : root;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (SKIP_PREFIXES.some((prefix) => child === prefix || child.startsWith(prefix + '/'))) continue;
      walk(root, child, files);
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
}

function readText(file) {
  let stats;
  try {
    stats = fs.statSync(file);
  } catch {
    return null;
  }
  if (stats.size > MAX_FILE_BYTES) return null;
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buffer.includes(0)) return null; // двоичный файл
  return buffer.toString('utf8');
}

/*
 * Строка закрепляет версию, если это проверка (assert/expect) или
 * объявление константы со значением текущей версии. Фикстура
 * «{ version: '...' }» и комментарий закреплением не считаются.
 */
function isPinLine(line, version) {
  if (/\b(?:assert|expect)\s*(?:\.\s*[\w$]+)?\s*\(/u.test(line)) return true;
  const declaration = /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*['"](\d+\.\d+\.\d+)['"]/u.exec(line);
  return Boolean(declaration) && declaration[1] === version;
}

/* Устаревшая закреплённая константа: тест держит прежнюю версию, манифест уже новее. */
function stalePinValue(line, version) {
  const declaration = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"](\d+\.\d+\.\d+)['"]/u.exec(line);
  if (!declaration) return null;
  if (!/version/iu.test(declaration[1])) return null;
  return declaration[2] === version ? null : declaration[2];
}

function loadVersion(root) {
  const file = path.join(root, MANIFEST);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { error: 'не найден ' + MANIFEST + ' в ' + root };
  }
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (error) {
    return { error: 'не читается ' + MANIFEST + ': ' + error.message };
  }
  const version = String(pkg.version ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    return { error: 'в ' + MANIFEST + ' нет версии вида X.Y.Z: ' + JSON.stringify(pkg.version) };
  }
  return { version };
}

function findingClass(relative, line, version) {
  if (relative === MANIFEST) {
    return { class: 'allowed', action: 'оставить: единственный источник версии' };
  }
  if (isTestPath(relative)) {
    if (isPinLine(line, version)) {
      return { class: 'forbidden', action: 'убрать литерал: тест берёт версию из package.json' };
    }
    return { class: 'warning', action: 'проверить вручную: в тесте, но не закрепление (комментарий или фикстура)' };
  }
  if (isDocsPath(relative)) {
    return { class: 'allowed', action: 'оставить: документация называет выпуск' };
  }
  return { class: 'warning', action: 'проверить вручную: не манифест и не документация' };
}

function collect(root, version) {
  const files = [];
  walk(root, '', files);
  const findings = [];
  const seen = new Set();

  const add = (finding) => {
    const key = finding.file + ':' + finding.line + ':' + finding.class;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const relative of files) {
    const text = readText(path.join(root, relative));
    if (text === null) continue;
    const isTest = isTestPath(relative);
    const lines = text.split(/\r?\n/u);
    const pattern = versionPattern(version);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const number = index + 1;
      if (line.includes(version)) {
        const occurrences = [...line.matchAll(pattern)];
        if (occurrences.length > 0) {
          const classified = findingClass(relative, line, version);
          add({ file: relative, line: number, ...classified });
        }
      }
      if (isTest) {
        const pinned = stalePinValue(line, version);
        if (pinned !== null) {
          add({
            file: relative,
            line: number,
            class: 'forbidden',
            action: 'обновить или убрать: закреплена версия ' + pinned + ', текущая ' + version,
            pinned,
          });
        }
      }
    }
  }

  findings.sort((left, right) => {
    const rank = CLASS_RANK[left.class] - CLASS_RANK[right.class];
    if (rank !== 0) return rank;
    const fileOrder = left.file.localeCompare(right.file);
    return fileOrder !== 0 ? fileOrder : left.line - right.line;
  });

  const problems = [];
  const documented = findings.some((finding) => finding.class === 'allowed' && finding.file !== MANIFEST);
  if (!documented) {
    problems.push('документация не называет текущую версию ' + version);
  }

  return { files, findings, problems };
}

function summarize(findings) {
  const summary = { allowed: 0, forbidden: 0, warning: 0 };
  for (const finding of findings) summary[finding.class] += 1;
  return summary;
}

function printTable(version, findings, problems, summary) {
  console.log('ВЕРСИЯ: ' + version + ' (из ' + MANIFEST + ')');
  if (findings.length === 0) {
    console.log('ЛИТЕРАЛОВ ТЕКУЩЕЙ ВЕРСИИ НЕ НАЙДЕНО');
  } else {
    console.log('ФАЙЛ | СТРОКА | КЛАСС | ЧТО ДЕЛАТЬ');
    for (const finding of findings) {
      console.log(finding.file + ' | ' + finding.line + ' | ' + CLASS_LABEL[finding.class] + ' | ' + finding.action);
    }
  }
  for (const problem of problems) console.log('РАСХОЖДЕНИЕ: ' + problem);
  console.log('ИТОГО: допустимо ' + summary.allowed + ', запрещено ' + summary.forbidden + ', предупреждений ' + summary.warning);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error('ОШИБКА: ' + error.message);
    usage();
    process.exit(2);
    return;
  }
  if (args.help) {
    usage();
    process.exit(0);
    return;
  }
  const root = path.resolve(args.root ?? process.cwd());
  if (!isDirectory(root)) {
    console.error('ОШИБКА: каталог проекта не найден: ' + root);
    process.exit(2);
    return;
  }
  const loaded = loadVersion(root);
  if (loaded.error) {
    console.error('ОШИБКА: ' + loaded.error);
    process.exit(1);
    return;
  }
  const { version } = loaded;
  const { findings, problems } = collect(root, version);
  const summary = summarize(findings);
  const ok = summary.forbidden === 0 && problems.length === 0;

  if (args.json) {
    console.log(JSON.stringify({
      ok,
      version,
      manifest: MANIFEST,
      root,
      findings,
      problems,
      summary,
    }, null, 2));
  } else {
    printTable(version, findings, problems, summary);
    if (args.check) console.log(ok ? 'ИТОГ: проверка пройдена' : 'ИТОГ: есть запрещённые места или расхождения');
  }

  if (args.check) process.exit(ok ? 0 : 1);
  process.exit(0);
}

main();
