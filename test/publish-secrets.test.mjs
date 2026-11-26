/**
 * Задание 0359 — публикация не несёт личных путей и внутренних хендоверов.
 *
 * Сборка публикации отказала на сканере секретов: в docs/INSTALL-STORE.md примеры
 * вывода содержали личный путь домашнего каталога Windows, а правило исключения
 * HANDOVER*.md действовало только для корня, поэтому docs/HANDOVER-*.md уходили
 * в публичное дерево.
 *
 * Настоящий репозиторий и staging тест не трогает: сухой прогон идёт на временном
 * git-репозитории, в сеть не ходит. Проверяется три вещи: в инструкции по store
 * нет личных путей и сканер секретов не найдёт в ней шаблон «личный путь»;
 * EXCLUDES отбрасывает хендоверы и в корне, и в docs/, но не обычный документ
 * каталога; сухой прогон завершается успехом и не включает хендоверы.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOOL = path.join(REPO, 'tools', 'publish-public.mjs');
const TEMPLATE_FILE = path.join(REPO, 'tools', 'public-structure.json');
const STORE_DOC = path.join(REPO, 'docs', 'INSTALL-STORE.md');

let passed = 0;
const failures = [];
const scratch = [];

function test(name, body) {
  try {
    body();
    passed += 1;
    console.log('ok ' + passed + ' — ' + name);
  } catch (error) {
    failures.push({ name, error });
  }
}

function spawn(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return {
    code: result.status === null ? 1 : result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    out: String(result.stdout || '') + String(result.stderr || ''),
    error: result.error,
  };
}

function tool(args, cwd) {
  return spawn(process.execPath, [TOOL, ...args], cwd);
}

function git(args, cwd) {
  const result = spawn('git', args, cwd);
  assert.equal(result.code, 0, 'git ' + args.join(' ') + ' упал: ' + result.out.slice(0, 500));
  return result.stdout;
}

function write(root, rel, text) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
}

function tempPath(tag) {
  return path.join(os.tmpdir(), 'pg-0359-' + tag + '-' + process.pid + '-' + Math.random().toString(16).slice(2, 8));
}

/**
 * EXCLUDES из исходника: массив состоит из литералов и функций и не зависит от
 * остального модуля, поэтому его можно разобрать, не запуская публикацию.
 */
function excludesFromSource() {
  const text = fs.readFileSync(TOOL, 'utf8');
  const start = text.indexOf('const EXCLUDES = [');
  assert.ok(start >= 0, 'в tools/publish-public.mjs нет EXCLUDES');
  const from = text.indexOf('[', start);
  let depth = 0;
  let index = from;
  for (; index < text.length; index += 1) {
    if (text[index] === '[') depth += 1;
    else if (text[index] === ']') {
      depth -= 1;
      if (depth === 0) {
        index += 1;
        break;
      }
    }
  }
  assert.equal(depth, 0, 'EXCLUDES в tools/publish-public.mjs не закрыт');
  const value = new Function('return ' + text.slice(from, index))();
  assert.ok(Array.isArray(value) && value.length > 0, 'EXCLUDES не разобран');
  return value;
}

function excludedBy(excludes, rel) {
  for (const item of excludes) if (item.test(rel)) return item;
  return null;
}

/** Пары «метка — число» из раздела вывода сухого прогона. */
function countSection(output, header, stopHeader) {
  const start = output.indexOf(header);
  assert.ok(start >= 0, 'сухой прогон не печатает раздел «' + header + '»');
  const end = stopHeader ? output.indexOf(stopHeader, start) : -1;
  const block = output.slice(start, end < 0 ? undefined : end);
  const counts = new Map();
  for (const line of block.split(/\r?\n/u)) {
    const match = /^\s{2}(.+?) — (\d+) файлов$/u.exec(line);
    if (match) counts.set(match[1], Number(match[2]));
  }
  return counts;
}

/** Временный git-репозиторий с обычными документами и хендоверами в корне и docs/. */
function makeFixture(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0359-' + tag + '-'));
  scratch.push(root);
  write(root, 'package.json', JSON.stringify({
    name: 'dsh-project-graph',
    version: '1.2.3',
    private: true,
    type: 'module',
  }, null, 2) + '\n');
  write(root, 'tools/public-structure.json', fs.readFileSync(TEMPLATE_FILE, 'utf8'));
  write(root, 'README.md', '# dsh-project-graph\n');
  write(root, 'docs/guide.md', '# Руководство\n');
  write(root, 'docs/debts.md', '# Список долгов\n\n1. известный долг\n');
  write(root, 'docs/HANDOVER-0346.md', '# Передача 0346\n');
  write(root, 'docs/HANDOVER-0352.md', '# Передача 0352\n');
  write(root, 'HANDOVER.md', '# Передача\n');
  write(root, 'HANDOVER-NEXT.md', '# Передача\n');
  git(['init', '-b', 'main'], root);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'add', '-A'], root);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], root);
  return root;
}

test('в инструкции по store нет личных путей с именем пользователя', () => {
  const text = fs.readFileSync(STORE_DOC, 'utf8');
  /* Тот же шаблон, что SECRET_PATTERNS в tools/publish-public.mjs: сканер не должен
     находить в инструкции «личный путь». */
  assert.doesNotMatch(text, /C:[\\/]Users[\\/]/iu, 'в инструкции остался личный путь домашнего каталога Windows');
  assert.doesNotMatch(text, /\/home\/[A-Za-z0-9._-]+/u, 'в инструкции остался личный путь /home/<имя>');
  /* Примеры машинно-нейтральны: %USERPROFILE% для Windows, ~/ для остальных. */
  assert.match(text, /%USERPROFILE%\\\.dsh\\project-graph\\/u, 'нет примера с %USERPROFILE%\\.dsh\\project-graph\\…');
  assert.match(text, /~\/\.dsh\/project-graph\//u, 'нет примера с ~/.dsh/project-graph/…');
  const windowsPath = '%USERPROFILE%\\.dsh\\project-graph\\';
  const occurrences = text.split(windowsPath).length - 1;
  assert.ok(occurrences >= 3, 'примеров с %USERPROFILE% меньше трёх: ' + occurrences);
  /* Смысл шагов сохранён: store и режимы по-прежнему объяснены. */
  assert.match(text, /режим: store/u, 'инструкция потеряла режим store');
  assert.match(text, /<store>\/graph\.json/u, 'инструкция потеряла путь <store>/graph.json');
});

test('EXCLUDES отбрасывает хендоверы в корне и в docs/, но не обычный документ', () => {
  const excludes = excludesFromSource();
  const handovers = ['HANDOVER.md', 'HANDOVER-NEXT.md', 'docs/HANDOVER-0340.md', 'docs/HANDOVER-0346.md', 'docs/HANDOVER-0352.md'];
  for (const rel of handovers) {
    assert.ok(excludedBy(excludes, rel), 'хендовер не исключён: ' + rel);
  }
  const rule = excludedBy(excludes, 'docs/HANDOVER-0346.md');
  assert.match(rule.label, /HANDOVER/u, 'метка исключения не называет HANDOVER');
  assert.match(rule.label, /корень/u, 'метка исключения не называет корень');
  assert.match(rule.label, /docs/u, 'метка исключения не называет каталог документации');
  for (const rel of ['docs/debts.md', 'docs/guide.md', 'docs/INSTALL-STORE.md', 'README.md']) {
    assert.equal(excludedBy(excludes, rel), null, 'исключение задело обычный документ: ' + rel);
  }
  /* Прежние исключения не сломаны. */
  for (const rel of ['docs/tasks/0359/task.md', 'docs/critic/x.md', 'docs/subagent-workflow/SPEC.md', 'checks/a.mjs']) {
    assert.ok(excludedBy(excludes, rel), 'прежнее исключение сломано: ' + rel);
  }
});

test('сухой прогон публикации успешен и не включает хендоверы', () => {
  const root = makeFixture('dry');
  const out = tempPath('dry-out');
  const result = tool(['--dry-run', '--out', out], root);
  assert.equal(result.code, 0, '--dry-run упал: ' + result.out.slice(0, 800));
  assert.equal(fs.existsSync(out), false, '--dry-run создал staging: ' + out);

  const groups = countSection(result.out, 'Включённые группы:', 'Исключения (не публикуются):');
  assert.equal(groups.get('docs'), 2, 'в docs включены не только обычные документы: '
    + JSON.stringify([...groups]));

  const excluded = countSection(result.out, 'Исключения (не публикуются):');
  const handoverLabel = [...excluded.keys()].find((label) => /HANDOVER/u.test(label));
  assert.ok(handoverLabel, 'сухой прогон не называет исключение HANDOVER*.md');
  assert.match(handoverLabel, /корень/u, 'метка исключения не называет корень');
  assert.match(handoverLabel, /docs/u, 'метка исключения не называет каталог документации');
  assert.equal(excluded.get(handoverLabel), 4, 'исключены не все хендоверы: ' + excluded.get(handoverLabel));

  for (const rel of ['HANDOVER.md', 'HANDOVER-NEXT.md', 'docs/HANDOVER-0346.md', 'docs/HANDOVER-0352.md']) {
    assert.ok(!result.out.includes(rel), 'хендовер назван среди включённых файлов: ' + rel);
  }
  assert.match(result.out, /файлов/u, 'сухой прогон не считает файлы');
});

for (const item of failures) {
  console.error('FAIL ' + item.name);
  console.error('  ' + (item.error && item.error.message ? item.error.message.split('\n').slice(0, 6).join('\n  ') : String(item.error)));
}
for (const dir of scratch) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* временный каталог не мешает результату */
  }
}
console.log('PUBLISH-SECRETS TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
