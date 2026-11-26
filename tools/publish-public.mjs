#!/usr/bin/env node
/**
 * Воспроизводимая публикация dsh-project-graph на GitHub.
 *
 * Ручная публикация 1.0.0 состояла из пяти шагов: git archive HEAD, удаление
 * внутренних путей, публичный package.json, нейтральный structure/graph.json и
 * один коммит, затем push --force main и тег v<version>. Скрипт повторяет этот
 * путь целиком и не даёт опубликовать лишнее:
 *
 *   --dry-run  показывает, что уйдёт в репозиторий, и НИЧЕГО не пишет;
 *   --build    собирает staging из HEAD, чистит внутренние пути, правит
 *              package.json, ставит нейтральный граф, проверяет секреты и
 *              делает один коммит в staging;
 *   --push     только вместе с уже собранным staging и явным --yes: force-push
 *              main и тег v<version>;
 *   --release  объект релиза для текущей версии, архив пакета вложенным
 *              пакетным менеджером рантайма, загрузка ассета и проверка
 *              скачивания (HTTP 200 и совпадение размера). Сам не пушит:
 *              идёт после --push либо когда тег уже отправлен; вместе с --push
 *              выполняется сразу после него.
 *
 * Коды выхода: 0 — успех, 1 — отказ с причиной, 2 — неверные аргументы.
 *
 *   node tools/publish-public.mjs --dry-run
 *   node tools/publish-public.mjs --build --out .tmp/public
 *   node tools/publish-public.mjs --push --release --yes
 *   node tools/publish-public.mjs --release --yes
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Репозиторий — тот, из которого запущен скрипт. */
const REPO = process.cwd();
/** Публичный репозиторий по умолчанию. */
const DEFAULT_REMOTE = 'https://github.com/AleksandrGoriachev/dsh-project-graph';
/** Staging по умолчанию: .tmp/ в .gitignore, в публикацию не попадает. */
const DEFAULT_OUT = '.tmp/public';
/**
 * Собственные файлы шага публикации. Они появляются в рабочем дереве раньше,
 * чем в HEAD, и в git archive HEAD их нет, поэтому публикуемое дерево они не
 * меняют. Без этого исключения --build не мог бы пройти до коммита задания.
 */
const SELF_ALLOWED = ['tools/publish-public.mjs', 'test/publish-public.test.mjs', 'test/publish-release.test.mjs'];
/** Сообщение единственного коммита staging. */
const COMMIT_SUBJECT = (version) => 'dsh-project-graph ' + version + ' — структура проекта и панель для DeepSeek Harness';
/** Файл-отметка сборки: лежит в .git staging и потому не публикуется. */
const MARKER = 'publish-public.json';
/** GitHub API: объект релиза и загрузка ассета живут на разных хостах. */
const RELEASE_API = 'https://api.github.com';
const RELEASE_UPLOAD_API = 'https://uploads.github.com';
/**
 * Вложенный пакетный менеджер рантайма, по известному расположению. Обычный
 * npm на этой машине не запускается политикой исполнения, поэтому путь не
 * берётся из переменной окружения и не подменяется.
 */
const DEFAULT_PNPM = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime',
  'dependencies', 'pnpm', 'bin', 'pnpm.cjs');
/** Хранилище учётных данных git: строки вида https://<пользователь>:<токен>@github.com. */
const GIT_CREDENTIALS_FILE = path.join(os.homedir(), '.git-credentials');
/** Переменные окружения с токеном GitHub, в порядке приоритета. */
const TOKEN_ENV = ['GH_TOKEN', 'GITHUB_TOKEN'];
/** Имя пакета по умолчанию: совпадает с package.json публикуемого дерева. */
const DEFAULT_PACKAGE_NAME = 'dsh-project-graph';
/** Тип содержимого архива-ассета. */
const ASSET_CONTENT_TYPE = 'application/gzip';

const USAGE = [
  'Использование:',
  '  node tools/publish-public.mjs --dry-run [--out <dir>] [--remote <url>]',
  '  node tools/publish-public.mjs --build   [--out <dir>] [--remote <url>]',
  '  node tools/publish-public.mjs --push --yes [--release] [--out <dir>] [--remote <url>]',
  '  node tools/publish-public.mjs --release --yes [--out <dir>] [--remote <url>]',
  '',
  '  --dry-run  сухой прогон: что публикуется и что исключено; ничего не пишет, в сеть не ходит',
  '  --build    собрать staging из git archive HEAD и закоммитить один раз',
  '  --push     force-push main и тег v<version> (нужен staging после --build и --yes)',
  '  --release  объект релиза v<version>, архив пакета вложенным pnpm, ассет и проверка скачивания;',
  '             вместе с --push выполняется сразу после пуша, отдельно — по уже отправленному тегу',
  '  --out      каталог staging (по умолчанию .tmp/public)',
  '  --remote   URL удалённого репозитория (по умолчанию ' + DEFAULT_REMOTE + ')',
  '  --yes      явное подтверждение пуша и создания релиза',
].join('\n');

/**
 * Исключения публикации. Ключ — то, что печатается и проверяется, predicate —
 * совпадение с путём внутри архива. Один список служит и сухому прогону, и
 * удалению, поэтому показанное и сделанное не расходятся.
 */
const EXCLUDES = [
  { label: 'docs/tasks/**', test: (rel) => rel === 'docs/tasks' || rel.startsWith('docs/tasks/') },
  { label: 'docs/subagent-workflow/**', test: (rel) => rel === 'docs/subagent-workflow' || rel.startsWith('docs/subagent-workflow/') },
  { label: 'docs/critic/**', test: (rel) => rel === 'docs/critic' || rel.startsWith('docs/critic/') },
  { label: 'checks/**', test: (rel) => rel === 'checks' || rel.startsWith('checks/') },
  {
    label: 'HANDOVER*.md (корень и docs/)',
    test: (rel) => {
      const cut = rel.lastIndexOf('/');
      const dir = cut < 0 ? '' : rel.slice(0, cut);
      const base = cut < 0 ? rel : rel.slice(cut + 1);
      return (dir === '' || dir === 'docs') && /^HANDOVER.*\.md$/iu.test(base);
    },
  },
  { label: '.wf-keys', test: (rel) => rel === '.wf-keys' || rel.startsWith('.wf-keys/') },
  { label: 'tools/commit.ps1', test: (rel) => rel === 'tools/commit.ps1' },
  { label: 'tools/restart-dsh.ps1', test: (rel) => rel === 'tools/restart-dsh.ps1' },
  { label: 'docs/self-control.baseline.json', test: (rel) => rel === 'docs/self-control.baseline.json' },
  {
    label: 'docs/workflow-install-*.md',
    test: (rel) => {
      const cut = rel.lastIndexOf('/');
      const dir = cut < 0 ? '' : rel.slice(0, cut);
      const base = cut < 0 ? rel : rel.slice(cut + 1);
      return dir === 'docs' && /^workflow-install-.*\.md$/iu.test(base);
    },
  },
];

/** Внутренние пути, которые staging игнорирует на будущее. */
const GITIGNORE_BLOCK = [
  '# внутренний процесс разработки (не публикуется)',
  'docs/tasks/',
  'docs/subagent-workflow/',
  'docs/critic/',
  'HANDOVER*.md',
  '.wf-keys/',
  'check-report.json',
];

/** Группы публикуемого дерева для сухого прогона. */
const GROUPS = [
  { label: 'lib', prefix: 'lib/' },
  { label: 'test', prefix: 'test/' },
  { label: 'tools', prefix: 'tools/' },
  { label: 'examples', prefix: 'examples/' },
  { label: 'docs', prefix: 'docs/' },
  { label: 'structure', prefix: 'structure/' },
];
const ROOT_GROUP = 'корневые файлы';

/** Ошибка с кодом выхода: 1 — отказ, 2 — неверные аргументы. */
function refusal(exitCode, message) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

/** Последние строки вывода команды — для причины отказа. */
function tailText(text, lines = 8) {
  const all = String(text || '').trim().split(/\r?\n/u);
  return all.slice(Math.max(0, all.length - lines)).join(' | ');
}

/** Запуск команды; stdout и stderr сохраняются раздельно. */
function run(command, args, options = {}) {
  const cwd = options.cwd || REPO;
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return {
    code: result.status === null ? 1 : result.status,
    stdout,
    stderr,
    out: stdout + stderr,
    error: result.error,
  };
}

/** Путь к репозиторию: git status/ls-tree без выдумок. */
function requireRepository() {
  const probe = run('git', ['rev-parse', '--is-inside-work-tree']);
  if (probe.code !== 0 || probe.stdout.trim() !== 'true') {
    throw refusal(1, 'текущий каталог не git-репозиторий: ' + REPO);
  }
}

/** package.json текущего репозитория: версия публикации берётся оттуда. */
function currentPackage() {
  const file = path.join(REPO, 'package.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw refusal(1, 'нет package.json: ' + file);
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw refusal(1, 'package.json не разбирается: ' + (error && error.message ? error.message : 'ошибка'));
  }
  if (!document || typeof document !== 'object' || typeof document.version !== 'string' || !document.version.trim()) {
    throw refusal(1, 'в package.json нет version: публикация без версии невозможна');
  }
  return document;
}

/** Файлы HEAD: дерево архива, без обращений к сети. */
function trackedFiles() {
  const result = run('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
  if (result.code !== 0) {
    throw refusal(1, 'git ls-tree HEAD не отвечает: ' + tailText(result.out));
  }
  return result.stdout
    .split('\u0000')
    .filter(Boolean)
    .map((name) => name.replace(/\\/gu, '/'));
}

/** Совпавшее исключение или null. */
function excludedBy(rel) {
  for (const item of EXCLUDES) {
    if (item.test(rel)) return item;
  }
  return null;
}

/** Группа файла по первому сегменту пути. */
function groupOf(rel) {
  for (const group of GROUPS) {
    if (rel.startsWith(group.prefix)) return group.label;
  }
  return ROOT_GROUP;
}

/** Путь out относительно репозитория, если он внутри; иначе null. */
function outInsideRepo(out) {
  const rel = path.relative(REPO, out);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Слишком широкий --out опасен: --build удаляет staging перед сборкой.
 * Отказываем корню диска, домашнему каталогу, самому репозиторию, его предкам
 * и служебному .git.
 */
function assertSafeOut(out) {
  const resolved = path.resolve(out);
  const root = path.parse(resolved).root;
  const relToRepo = path.relative(resolved, REPO);
  if (resolved === root) throw refusal(2, '--out не может быть корнем диска: ' + resolved);
  if (resolved === path.resolve(os.homedir())) throw refusal(2, '--out не может быть домашним каталогом: ' + resolved);
  if (resolved === REPO) throw refusal(2, '--out не может быть корнем репозитория: ' + resolved);
  if (relToRepo && !relToRepo.startsWith('..') && !path.isAbsolute(relToRepo)) {
    throw refusal(2, '--out не может быть предком репозитория: ' + resolved);
  }
  const inside = outInsideRepo(resolved);
  if (inside && (inside === '.git' || inside.startsWith('.git/'))) {
    throw refusal(2, '--out не может быть внутри .git: ' + resolved);
  }
  return resolved;
}

/** Разбор аргументов; режимы взаимоисключающие. */
function parseArgs(argv) {
  const options = { mode: null, out: null, remote: null, yes: false, release: false, help: false };
  const modes = new Set(['dry', 'build', 'push']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run' || arg === '--build' || arg === '--push') {
      const mode = arg === '--dry-run' ? 'dry' : arg.replace(/^--/u, '');
      if (options.mode) throw refusal(2, 'режимы взаимоисключающие: уже задан ' + options.mode + ', получен ' + arg);
      options.mode = mode;
      continue;
    }
    if (arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw refusal(2, '--out требует каталог');
      options.out = value;
      index += 1;
      continue;
    }
    if (arg === '--remote') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw refusal(2, '--remote требует URL');
      options.remote = value;
      index += 1;
      continue;
    }
    if (arg === '--yes') {
      options.yes = true;
      continue;
    }
    if (arg === '--release') {
      options.release = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw refusal(2, 'неизвестный аргумент: ' + arg);
  }
  if (options.help) return options;
  if (!options.mode && !options.release) throw refusal(2, 'нужен режим: --dry-run, --build, --push или --release');
  if (options.mode && !modes.has(options.mode)) throw refusal(2, 'неизвестный режим: ' + options.mode);
  if (options.release && (options.mode === 'dry' || options.mode === 'build')) {
    throw refusal(2, '--release несовместим с --dry-run и --build: релиз идёт после --push или по уже собранному staging');
  }
  return options;
}

/** Строка git status без XY и кавычек. */
function statusPath(line) {
  let rel = line.slice(3).trim();
  if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
  const arrow = rel.indexOf(' -> ');
  if (arrow >= 0) rel = rel.slice(arrow + 4);
  return rel.replace(/\\/gu, '/');
}

/**
 * Чистота рабочего дерева. Допустимы docs/tasks/** (контракт и отчёт шага),
 * staging и собственные файлы инструмента: в git archive HEAD их нет, поэтому
 * публикуемое дерево они не меняют. Любой другой путь — отказ.
 */
function dirtyWorktree(out) {
  const result = run('git', ['status', '--porcelain']);
  if (result.code !== 0) throw refusal(1, 'git status не отвечает: ' + tailText(result.out));
  const staging = outInsideRepo(out);
  const allowed = [];
  const blocked = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const rel = statusPath(line);
    const untracked = line.slice(0, 2).trim() === '??';
    const isAllowed = rel.startsWith('docs/tasks/')
      || (staging && (rel === staging || rel.startsWith(staging + '/')))
      /* Новые файлы шага ещё не в HEAD: git archive их не берёт, публикуемое
         дерево они не меняют. Изменённый (не новый) такой файл — уже отказ. */
      || (untracked && SELF_ALLOWED.includes(rel));
    (isAllowed ? allowed : blocked).push(rel);
  }
  return { allowed, blocked };
}

/** Рекурсивный обход staging без .git. */
function walkFiles(root) {
  const files = [];
  const visit = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files;
}

/** Относительный путь staging с прямыми слэшами. */
function relativeTo(root, full) {
  return path.relative(root, full).split(path.sep).join('/');
}

/** Удаление исключений из распакованного дерева; возвращает число путей. */
function removeExcluded(root) {
  let removed = 0;
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = relativeTo(root, full);
      if (excludedBy(rel)) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  return removed;
}

/** Публичный package.json: без private, с репозиторием и списком files. */
function writePublicPackage(root, version, remote) {
  const file = path.join(root, 'package.json');
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw refusal(1, 'staging package.json не разбирается: ' + (error && error.message ? error.message : 'ошибка'));
  }
  delete document.private;
  const base = String(remote).replace(/\.git$/u, '').replace(/\/+$/u, '');
  document.version = version;
  document.repository = { type: 'git', url: base + '.git' };
  document.homepage = base + '#readme';
  document.bugs = { url: base + '/issues' };
  document.files = ['lib', 'cordis.patch.yml', 'README.md', 'structure', 'examples'];
  fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n', 'utf8');
}

/** Нейтральный граф: байт-в-байт из tools/public-structure.json. */
function writePublicStructure(root, templateFile) {
  const target = path.join(root, 'structure', 'graph.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(templateFile, target);
}

/** Дописать внутренние пути в .gitignore staging (идемпотентно). */
function appendGitignore(root) {
  const file = path.join(root, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  if (text.includes(GITIGNORE_BLOCK[0])) return;
  if (text && !text.endsWith('\n')) text += '\n';
  fs.writeFileSync(file, text + GITIGNORE_BLOCK.join('\n') + '\n', 'utf8');
}

/** Шаблоны секретов. Токены собираются из частей, чтобы исходник не читался как секрет. */
const SECRET_PATTERNS = [
  { kind: 'личный путь', test: (text) => /C:\\Users\\/u.test(text) },
  { kind: 'токен GitHub', test: (text) => /ghp_[A-Za-z0-9]{20,}/u.test(text) },
  { kind: 'токен GitHub', test: (text) => new RegExp('github' + '_pat_', 'u').test(text) },
  { kind: 'приватный ключ', test: (text) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text) },
  { kind: 'приватный ключ', test: (text) => new RegExp('BEGIN' + ' PRIVATE KEY', 'u').test(text) },
];

/** Поиск секретов в собранном дереве: отказ с именем файла. */
function scanSecrets(root) {
  const hits = [];
  for (const file of walkFiles(root)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        hits.push({ file: relativeTo(root, file), kind: pattern.kind });
        break;
      }
    }
  }
  return hits;
}

/** Отметка сборки в .git staging: по ней --push отличает свой staging. */
function writeMarker(root, version, remote) {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: root });
  const marker = {
    tool: 'tools/publish-public.mjs',
    version,
    remote,
    head: head.code === 0 ? head.stdout.trim() : null,
    builtAt: mskNow(),
  };
  fs.writeFileSync(path.join(root, '.git', MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf8');
  return marker;
}

/** Текущее время в MSK со смещением: отчёт и отметка читаются людьми. */
function mskNow() {
  const date = new Date();
  const offset = 3 * 60;
  const local = new Date(date.getTime() + offset * 60 * 1000);
  return local.toISOString().slice(0, 19) + '+03:00';
}

/** Инициализация staging и один коммит. */
function initAndCommit(root, version) {
  const init = run('git', ['init', '-b', 'main'], { cwd: root });
  if (init.code !== 0) {
    const fallback = run('git', ['init'], { cwd: root });
    if (fallback.code !== 0) throw refusal(1, 'git init staging упал: ' + tailText(fallback.out));
    const branch = run('git', ['branch', '-M', 'main'], { cwd: root });
    if (branch.code !== 0) throw refusal(1, 'git branch -M main упал: ' + tailText(branch.out));
  }
  const add = run('git', ['add', '-A'], { cwd: root });
  if (add.code !== 0) throw refusal(1, 'git add staging упал: ' + tailText(add.out));
  const name = (run('git', ['config', 'user.name'], { cwd: root }).stdout || '').trim() || 'dsh-project-graph';
  const email = (run('git', ['config', 'user.email'], { cwd: root }).stdout || '').trim() || 'dsh-project-graph@localhost';
  const messageFile = path.join(root, '.git', 'PUBLISH_COMMIT_MSG.txt');
  fs.writeFileSync(messageFile, COMMIT_SUBJECT(version) + '\n', 'utf8');
  const commit = run('git', [
    '-c', 'user.name=' + name,
    '-c', 'user.email=' + email,
    '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=',
    'commit', '-F', messageFile,
  ], { cwd: root });
  fs.rmSync(messageFile, { force: true });
  if (commit.code !== 0) throw refusal(1, 'git commit staging упал: ' + tailText(commit.out));
  const sha = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
  return sha.code === 0 ? sha.stdout.trim() : '?';
}

/** Сухой прогон: показать, что уйдёт, и ничего не писать. */
function dryRun(options) {
  requireRepository();
  const version = currentPackage().version.trim();
  assertSafeOut(options.out);
  const tracked = trackedFiles();
  const published = [];
  const excluded = new Map(EXCLUDES.map((item) => [item.label, 0]));
  for (const rel of tracked) {
    const hit = excludedBy(rel);
    if (hit) {
      excluded.set(hit.label, excluded.get(hit.label) + 1);
      continue;
    }
    published.push(rel);
  }
  const byGroup = new Map([...GROUPS.map((group) => [group.label, 0]), [ROOT_GROUP, 0]]);
  for (const rel of published) byGroup.set(groupOf(rel), byGroup.get(groupOf(rel)) + 1);
  console.log('Сухой прогон публикации dsh-project-graph.');
  console.log('Ничего не пишется, staging не создаётся, в сеть не ходим.');
  console.log('Версия из package.json: ' + version);
  console.log('Удалённый репозиторий: ' + options.remote);
  console.log('Целевой staging (не создаётся): ' + options.out);
  console.log('');
  console.log('Включённые группы:');
  for (const group of GROUPS) console.log('  ' + group.label + ' — ' + byGroup.get(group.label) + ' файлов');
  console.log('  ' + ROOT_GROUP + ' — ' + byGroup.get(ROOT_GROUP) + ' файлов');
  console.log('Всего файлов: ' + published.length);
  console.log('');
  console.log('Исключения (не публикуются):');
  for (const item of EXCLUDES) console.log('  ' + item.label + ' — ' + excluded.get(item.label) + ' файлов');
  console.log('');
  console.log('При --build дерево соберётся из git archive HEAD, исключения удалятся,');
  console.log('package.json станет публичным, structure/graph.json — нейтральным шаблоном.');
  return 0;
}

/** Сборка публичного staging. */
function build(options) {
  requireRepository();
  const templateFile = path.join(REPO, 'tools', 'public-structure.json');
  if (!fs.existsSync(templateFile)) {
    throw refusal(1, 'нет шаблона публичной структуры: ' + templateFile);
  }
  const version = currentPackage().version.trim();
  const out = assertSafeOut(options.out);
  const dirty = dirtyWorktree(out);
  if (dirty.blocked.length > 0) {
    throw refusal(1, 'грязное рабочее дерево: публикация только из закоммиченного состояния. '
      + 'Мешают: ' + dirty.blocked.join(', ')
      + '. Допустимы только docs/tasks/** и staging; закоммитьте или уберите остальное.');
  }
  if (dirty.allowed.length > 0) {
    console.log('Допустимые незакоммиченные пути: ' + dirty.allowed.join(', '));
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const archive = path.join(os.tmpdir(), 'pg-public-' + process.pid + '-' + Date.now() + '.tar');
  try {
    const pack = run('git', ['archive', '--format=tar', '-o', archive, 'HEAD']);
    if (pack.code !== 0) throw refusal(1, 'git archive HEAD упал: ' + tailText(pack.out));
    const unpack = run('tar', ['-xf', archive, '-C', out]);
    if (unpack.code !== 0) throw refusal(1, 'распаковка tar упала: ' + tailText(unpack.out));
  } finally {
    fs.rmSync(archive, { force: true });
  }
  const removed = removeExcluded(out);
  writePublicPackage(out, version, options.remote);
  writePublicStructure(out, templateFile);
  appendGitignore(out);
  const secrets = scanSecrets(out);
  if (secrets.length > 0) {
    throw refusal(1, 'в публичном дереве секреты: '
      + secrets.map((hit) => hit.file + ' (' + hit.kind + ')').join('; ')
      + '. Уберите их из HEAD или добавьте путь в исключения.');
  }
  const sha = initAndCommit(out, version);
  writeMarker(out, version, options.remote);
  const files = walkFiles(out).length;
  console.log('Публичное дерево собрано: ' + out);
  console.log('Файлов: ' + files);
  console.log('Версия: ' + version);
  console.log('Исключено путей: ' + removed);
  console.log('Коммит: ' + sha + ' (main) — ' + COMMIT_SUBJECT(version));
  console.log('Секреты: не найдены.');
  return 0;
}

/** Отметка собранного staging: без неё не начинается ни пуш, ни релиз. */
function stagingMarker(out, options) {
  if (!fs.existsSync(out) || !fs.existsSync(path.join(out, '.git'))) {
    throw refusal(1, 'staging не найден: ' + out + '. Нужен --build: сначала соберите дерево '
      + 'командой node tools/publish-public.mjs --build --out ' + options.out);
  }
  const markerFile = path.join(out, '.git', MARKER);
  if (!fs.existsSync(markerFile)) {
    throw refusal(1, 'staging не собран tools/publish-public.mjs (нет отметки ' + MARKER + '). Нужен --build.');
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  } catch {
    marker = null;
  }
  if (!marker || typeof marker.version !== 'string' || !marker.version.trim()) {
    throw refusal(1, 'отметка сборки staging испорчена. Нужен --build.');
  }
  return marker;
}

/** Пуш: только из собранного staging и только с --yes. */
async function push(options) {
  const out = assertSafeOut(options.out);
  const marker = stagingMarker(out, options);
  if (!options.yes) {
    throw refusal(1, 'пуш без подтверждения запрещён. Нужен --yes: это force-push main и тега v'
      + marker.version.trim() + ' в ' + (options.remote || marker.remote) + '.');
  }
  const version = marker.version.trim();
  const remote = options.remote || marker.remote || DEFAULT_REMOTE;
  const tag = 'v' + version;
  const hooks = ['-c', 'core.hooksPath='];
  const credential = ['-c', 'credential.helper=store'];
  const remoteEnv = { GIT_TERMINAL_PROMPT: '0' };
  console.log('Пуш в ' + remote + ': main и тег ' + tag + ' с --force.');
  console.log('Хуки отключены осознанно (-c core.hooksPath=): гейт движка не пропускает чужие диапазоны.');
  console.log('Учётные данные: credential.helper=store, без интерактивного запроса.');
  const existing = run('git', ['tag', '--list', tag], { cwd: out });
  if (!existing.stdout.trim()) {
    const created = run('git', ['tag', tag], { cwd: out });
    if (created.code !== 0) throw refusal(1, 'git tag ' + tag + ' упал: ' + tailText(created.out));
    console.log('Тег ' + tag + ' создан в staging.');
  } else {
    console.log('Тег ' + tag + ' уже есть в staging.');
  }
  const main = run('git', [...hooks, ...credential, 'push', '--force', remote, 'main'], { cwd: out, env: remoteEnv });
  console.log('--- git push --force ' + remote + ' main ---');
  console.log((main.stdout + main.stderr).trim());
  if (main.code !== 0) {
    throw refusal(1, 'пуш main не удался (exit ' + main.code + '): ' + tailText(main.out));
  }
  const tagPush = run('git', [...hooks, ...credential, 'push', '--force', remote, tag], { cwd: out, env: remoteEnv });
  console.log('--- git push --force ' + remote + ' ' + tag + ' ---');
  console.log((tagPush.stdout + tagPush.stderr).trim());
  if (tagPush.code !== 0) {
    throw refusal(1, 'пуш тега ' + tag + ' не удался (exit ' + tagPush.code + '): ' + tailText(tagPush.out));
  }
  console.log('Итог: main и тег ' + tag + ' отправлены в ' + remote + '.');
  if (options.release) {
    /* Одна команда: пуш, затем объект релиза, ассет и проверка скачивания. */
    return publishRelease({ ...options, out, remote });
  }
  return 0;
}

/**
 * GitHub-релиз: токен, объект релиза, архив-ассет и проверка скачивания.
 *
 * Чистые функции (разбор токена, имя ассета, сверка размера, тело релиза)
 * экспортируются ради test/publish-release.test.mjs: сеть там подменяется
 * стабом, настоящая публикация не запускается.
 */

/** Токен из окружения: GH_TOKEN главнее GITHUB_TOKEN. */
export function tokenFromEnvironment(env) {
  const source = env || {};
  for (const name of TOKEN_ENV) {
    const value = source[name];
    if (typeof value === 'string' && value.trim()) return { token: value.trim(), source: name };
  }
  return null;
}

/** URL-декодирование без падения на кривой строке. */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Токен из хранилища git: строки вида
 * https://<пользователь>:<токен>@github.com (допустимы порт и хвостовой слэш).
 * Чужие хосты пропускаются: релиз публикуется только на GitHub.
 */
export function tokenFromStore(text) {
  for (const raw of String(text || '').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^https?:\/\/([^/\s]+)@([^/\s]+)\/?$/iu.exec(line);
    if (!match) continue;
    const host = match[2].split(':')[0].toLowerCase();
    if (host !== 'github.com') continue;
    const userinfo = match[1];
    const cut = userinfo.indexOf(':');
    const user = safeDecode(cut < 0 ? '' : userinfo.slice(0, cut));
    const token = safeDecode(cut < 0 ? userinfo : userinfo.slice(cut + 1)).trim();
    if (token) return { token, user: user || null, source: 'store' };
  }
  return null;
}

/** Токен: сначала окружение, затем хранилище; null — токена нет. */
export function resolveToken(env, storeText) {
  return tokenFromEnvironment(env) || tokenFromStore(storeText);
}

/** Тег релиза: v + версия. */
export function releaseTag(version) {
  return 'v' + String(version || '').trim();
}

/** Имя ассета: <имя пакета>-<версия>.tgz — так же, как называет архив pnpm pack. */
export function assetNameFor(version, packageName = DEFAULT_PACKAGE_NAME) {
  const name = String(packageName || DEFAULT_PACKAGE_NAME).trim()
    .replace(/^@/u, '')
    .replace(/[\\/]+/gu, '-');
  const versionText = String(version || '').trim().replace(/[\\/]+/gu, '-');
  return name + '-' + versionText + '.tgz';
}

/** Сверка размера: оба числа положительные и равны байт-в-байт. */
export function sameSize(expected, actual) {
  const left = Number(expected);
  const right = Number(actual);
  return Number.isFinite(left) && Number.isFinite(right) && left > 0 && left === right;
}

/** Тело запроса релиза: тег, имя, заметки; не черновик и не предрелиз. */
export function releaseBody(version, extra = {}) {
  const versionText = String(version || '').trim();
  const tag = releaseTag(versionText);
  const notes = typeof extra.notes === 'string' && extra.notes.trim()
    ? extra.notes.trim()
    : 'Релиз dsh-project-graph ' + versionText + ': структура проекта и панель для DeepSeek Harness.';
  const document = { tag_name: tag, name: tag, body: notes, draft: false, prerelease: false };
  const target = typeof extra.target === 'string' && extra.target.trim() ? extra.target.trim() : '';
  if (target) document.target_commitish = target;
  return document;
}

/** owner/repo из URL удалённого репозитория; null — разобрать не удалось. */
export function repositoryFromRemote(remote) {
  const value = String(remote || '').trim().replace(/\/+$/u, '').replace(/\.git$/u, '');
  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)$/u.exec(value);
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = /^(?:ssh:\/\/)?[^@/]+@[^:/]+:([^/]+)\/([^/]+)$/u.exec(value);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
}

/** Строка таблицы итога: тег, id релиза, имя ассета, размер, код ответа. */
export function releaseTableRow(row) {
  const item = row || {};
  const size = Number(item.size);
  return [
    String(item.tag || '?'),
    item.releaseId === undefined || item.releaseId === null ? '?' : String(item.releaseId),
    String(item.assetName || '?'),
    Number.isFinite(size) ? String(size) : '?',
    item.httpStatus === undefined || item.httpStatus === null ? '?' : String(item.httpStatus),
  ].join(' | ');
}

/** Строка удалённого репозитория без учётных данных — её можно печатать. */
function displayRemote(remote) {
  return String(remote || '').replace(/\/\/[^/@\s]+@/u, '//…@');
}

/** Содержимое хранилища: тест подменяет его, не трогая домашний каталог. */
function credentialsText(deps) {
  if (typeof deps.credentialsText === 'string') return deps.credentialsText;
  const file = deps.credentialsFile || GIT_CREDENTIALS_FILE;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Причина отказа из ответа API: сообщение GitHub, иначе хвост тела. */
function apiMessage(response) {
  try {
    const document = JSON.parse(response.text);
    if (document && typeof document.message === 'string' && document.message.trim()) return tailText(document.message, 3);
  } catch {
    /* тело не JSON — печатаем как есть */
  }
  return tailText(response.text, 3) || 'пустой ответ';
}

/** Разбор JSON-ответа API с отказом вместо падения. */
function jsonResponse(response, what) {
  try {
    return JSON.parse(response.text);
  } catch {
    throw refusal(1, what + ': ответ не JSON (HTTP ' + response.status + '): ' + tailText(response.text, 2));
  }
}

/**
 * Клиент GitHub API. fetch подменяется стабом в тестах; токен уходит только
 * в заголовок Authorization и никогда не печатается.
 */
function githubClient(token, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw refusal(1, 'в этом Node.js нет fetch: релиз без сети невозможен, обновите рантайм');
  }
  return async function request(method, url, options = {}) {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-project-graph-publish',
      'x-github-api-version': '2022-11-28',
      ...(options.headers || {}),
    };
    if (options.auth !== false) headers.authorization = 'Bearer ' + token;
    const init = { method, headers, redirect: 'follow' };
    if (options.body !== undefined) init.body = options.body;
    const response = await doFetch(url, init);
    const status = Number(response.status);
    if (options.as === 'bytes') {
      const buffer = await response.arrayBuffer();
      return { status, text: '', byteLength: buffer.byteLength };
    }
    const text = await response.text();
    const header = response.headers && typeof response.headers.get === 'function'
      ? Number(response.headers.get('content-length'))
      : NaN;
    return { status, text, byteLength: Number.isFinite(header) ? header : NaN };
  };
}

/**
 * Архив пакета вложенным pnpm рантайма: --pack-destination держит tgz вне
 * staging, чтобы повторная сборка не увидела лишний файл.
 */
function packArchive(out, deps = {}) {
  const exec = deps.exec || ((command, args, options) => run(command, args, options));
  const pnpm = deps.pnpmPath || DEFAULT_PNPM;
  if (!fs.existsSync(pnpm)) {
    throw refusal(1, 'нет вложенного пакетного менеджера рантайма: ' + pnpm
      + '. Обычный npm на этой машине не запускается политикой исполнения.');
  }
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-release-' + process.pid + '-'));
  const cleanup = () => fs.rmSync(destination, { recursive: true, force: true });
  const result = exec(process.execPath, [pnpm, 'pack', '--pack-destination', destination], {
    cwd: out,
    env: { CI: '1', NO_COLOR: '1' },
  });
  if (result.code !== 0) {
    cleanup();
    throw refusal(1, 'сборка архива пакета не удалась (вложенный pnpm pack, exit ' + result.code + '): ' + tailText(result.out));
  }
  const packed = fs.readdirSync(destination).filter((name) => name.toLowerCase().endsWith('.tgz'));
  if (packed.length === 0) {
    cleanup();
    throw refusal(1, 'вложенный pnpm pack не создал архив в ' + destination + ': ' + tailText(result.out));
  }
  const file = path.join(destination, packed[0]);
  return { file, name: packed[0], size: fs.statSync(file).size, dir: destination };
}

/** Имя пакета из staging: по нему называется ассет. */
function stagingPackageName(out) {
  try {
    const document = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    if (document && typeof document.name === 'string' && document.name.trim()) return document.name.trim();
  } catch {
    /* имя по умолчанию */
  }
  return DEFAULT_PACKAGE_NAME;
}

/** Таблица итога: тег, id релиза, имя ассета, размер, код проверки скачивания. */
function printReleaseTable(row, log) {
  log('');
  log('Итог релиза:');
  log('  тег | id релиза | имя ассета | размер, байт | код ответа');
  log('  ' + releaseTableRow(row));
}

/**
 * Режим --release: объект релиза, архив-ассет, проверка скачивания.
 *
 * Идемпотентность: существующий релиз используется повторно; уже загруженный
 * ассет с тем же размером не загружается заново. Сеть, сборка архива, окружение
 * и журнал подменяются через deps — этим пользуется test/publish-release.test.mjs.
 */
export async function publishRelease(settings, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : (line) => console.log(line);
  const out = assertSafeOut(settings.out);
  const marker = stagingMarker(out, settings);
  if (!settings.yes) {
    throw refusal(1, 'создание релиза без подтверждения запрещено. Нужен --yes: это объект релиза '
      + releaseTag(marker.version) + ' и загрузка ассета в '
      + displayRemote(settings.remote || marker.remote || DEFAULT_REMOTE) + '.');
  }
  const version = marker.version.trim();
  const remote = settings.remote || marker.remote || DEFAULT_REMOTE;
  const repository = repositoryFromRemote(remote);
  if (!repository) {
    throw refusal(1, 'удалённый репозиторий не разобран как GitHub: ' + displayRemote(remote)
      + '. Нужен URL вида https://github.com/<владелец>/<repo> или git@github.com:<владелец>/<repo>.');
  }
  const tokenInfo = resolveToken(deps.env || process.env, credentialsText(deps));
  if (!tokenInfo) {
    throw refusal(1, 'нет токена GitHub: задайте GH_TOKEN или GITHUB_TOKEN либо строку '
      + 'https://<пользователь>:<токен>@github.com в ' + GIT_CREDENTIALS_FILE
      + '. Без токена релиз не создаётся.');
  }
  const sourceLabel = tokenInfo.source === 'store'
    ? 'хранилище git (' + GIT_CREDENTIALS_FILE + ')'
    : 'окружение ' + tokenInfo.source;
  log('Релиз ' + releaseTag(version) + ' в ' + repository.owner + '/' + repository.repo + '.');
  log('Токен: ' + sourceLabel + '.');
  const archive = deps.pack ? await deps.pack({ out, version }) : packArchive(out, deps);
  try {
    if (!archive || !archive.file || !fs.existsSync(archive.file)) {
      throw refusal(1, 'архив пакета не найден: ' + (archive && archive.file ? archive.file : String(archive))
        + '. Релиз не создаётся.');
    }
    const size = Number(archive.size) > 0 ? Number(archive.size) : fs.statSync(archive.file).size;
    const assetName = archive.name || assetNameFor(version, stagingPackageName(out));
    const request = deps.request || githubClient(tokenInfo.token, deps.fetch);
    const api = RELEASE_API + '/repos/' + repository.owner + '/' + repository.repo;
    const uploadApi = RELEASE_UPLOAD_API + '/repos/' + repository.owner + '/' + repository.repo;
    const tag = releaseTag(version);
    log('Архив пакета: ' + assetName + ' (' + size + ' байт).');
    const lookup = await request('GET', api + '/releases/tags/' + encodeURIComponent(tag));
    let release;
    if (lookup.status === 200) {
      release = jsonResponse(lookup, 'поиск релиза ' + tag);
      log('Релиз уже существует: id ' + release.id + '.');
    } else if (lookup.status === 404) {
      const created = await request('POST', api + '/releases', {
        body: JSON.stringify(releaseBody(version, { target: deps.target || 'main' })),
        headers: { 'content-type': 'application/json' },
      });
      if (created.status !== 201) {
        throw refusal(1, 'создание релиза ' + tag + ' не удалось (HTTP ' + created.status + '): ' + apiMessage(created));
      }
      release = jsonResponse(created, 'создание релиза ' + tag);
      log('Релиз создан: id ' + release.id + '.');
    } else {
      throw refusal(1, 'запрос релиза ' + tag + ' не удался (HTTP ' + lookup.status + '): ' + apiMessage(lookup));
    }
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const present = assets.find((asset) => asset && asset.name === assetName) || null;
    let uploaded = present;
    if (present) {
      if (!sameSize(size, present.size)) {
        throw refusal(1, 'ассет ' + assetName + ' уже есть в релизе, но размер не совпал: в релизе '
          + present.size + ' байт, локально ' + size + ' байт. Удалите ассет вручную и повторите.');
      }
      log('Ассет уже загружен: ' + assetName + ' (' + size + ' байт), повторная загрузка не нужна.');
    } else {
      const upload = await request('POST', uploadApi + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(assetName), {
        body: fs.readFileSync(archive.file),
        headers: { 'content-type': ASSET_CONTENT_TYPE, 'content-length': String(size) },
      });
      if (upload.status !== 201 && upload.status !== 200) {
        throw refusal(1, 'загрузка ассета ' + assetName + ' не удалась (HTTP ' + upload.status + '): ' + apiMessage(upload));
      }
      uploaded = jsonResponse(upload, 'загрузка ассета ' + assetName);
      log('Ассет загружен: ' + assetName + ' (' + size + ' байт).');
    }
    const downloadUrl = uploaded && typeof uploaded.browser_download_url === 'string' && uploaded.browser_download_url
      ? uploaded.browser_download_url
      : 'https://github.com/' + repository.owner + '/' + repository.repo + '/releases/download/' + tag + '/' + encodeURIComponent(assetName);
    const download = await request('GET', downloadUrl, { as: 'bytes', auth: false });
    if (download.status !== 200) {
      throw refusal(1, 'скачивание ассета ' + assetName + ' не удалось (HTTP ' + download.status + '): релиз '
        + tag + ' создан, но ссылка установки не проверена.');
    }
    const downloadedSize = Number.isFinite(download.byteLength)
      ? download.byteLength
      : Number(uploaded && uploaded.size);
    if (!sameSize(size, downloadedSize)) {
      throw refusal(1, 'размер скачанного ассета ' + assetName + ' не совпал: скачано ' + downloadedSize
        + ' байт, локально ' + size + ' байт.');
    }
    printReleaseTable({ tag, releaseId: release.id, assetName, size, httpStatus: download.status }, log);
    return 0;
  } finally {
    if (archive && archive.dir) fs.rmSync(archive.dir, { recursive: true, force: true });
  }
}

/** Точка входа: режим, отказ с кодом, печать причины. */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error('ОШИБКА АРГУМЕНТОВ: ' + error.message);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const out = path.resolve(REPO, options.out || DEFAULT_OUT);
  const remote = options.remote || DEFAULT_REMOTE;
  const settings = { out, remote, yes: options.yes, release: options.release };
  try {
    if (options.mode === 'dry') return dryRun(settings);
    if (options.mode === 'build') return build(settings);
    if (options.mode === 'push') return await push(settings);
    if (options.release) return await publishRelease(settings);
    throw refusal(2, 'нужен режим: --dry-run, --build, --push или --release');
  } catch (error) {
    const code = error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
    console.error('ОТКАЗ: ' + (error && error.message ? error.message : String(error)));
    return code;
  }
}

/*
 * Модуль импортируется test/publish-release.test.mjs ради чистых функций;
 * CLI запускается только когда файл — точка входа, а не импорт.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
