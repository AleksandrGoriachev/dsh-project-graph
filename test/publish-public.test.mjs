/**
 * Задание 0068 — тесты tools/publish-public.mjs на временных репозиториях.
 *
 * Настоящий репозиторий не трогается: каждая фикстура — отдельный git-репозиторий
 * в os.tmpdir(), staging тоже во временном каталоге, в сеть тесты не ходят.
 * Проверяется то, что обещано контрактом: сухой прогон ничего не создаёт, сборка
 * убирает внутренние пути и делает package.json публичным, нейтральный граф
 * совпадает с шаблоном, грязное дерево и --push без --yes/без staging отказывают,
 * секрет в дереве назван по имени файла.
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
const TEMPLATE = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
const REMOTE = 'https://github.com/AleksandrGoriachev/dsh-project-graph';
const FILES = ['lib', 'cordis.patch.yml', 'README.md', 'structure', 'examples'];
const EXCLUDED = [
  'docs/tasks',
  'docs/subagent-workflow',
  'docs/critic',
  'checks',
  'HANDOVER.md',
  'HANDOVER-NEXT.md',
  '.wf-keys',
  'tools/commit.ps1',
  'tools/restart-dsh.ps1',
  'docs/self-control.baseline.json',
  'docs/workflow-install-v1.md',
  'docs/workflow-install-answers.md',
];

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
  return path.join(os.tmpdir(), 'pg-0068-' + tag + '-' + process.pid + '-' + Math.random().toString(16).slice(2, 8));
}

function assertMentions(output, needle) {
  assert.ok(output.includes(needle), 'в выводе нет «' + needle + '»:\n' + output.slice(0, 800));
}

/** Небольшой git-репозиторий, повторяющий расклад настоящего: публичное и внутреннее. */
function makeFixture(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0068-' + tag + '-'));
  scratch.push(root);
  write(root, 'package.json', JSON.stringify({
    name: 'dsh-project-graph',
    version: '1.2.3',
    private: true,
    license: 'MIT',
    type: 'module',
    main: 'lib/index.js',
    files: ['lib'],
  }, null, 2) + '\n');
  write(root, 'tools/public-structure.json', fs.readFileSync(TEMPLATE_FILE, 'utf8'));
  write(root, 'README.md', '# dsh-project-graph\n');
  write(root, 'LICENSE', 'MIT\n');
  write(root, 'cordis.patch.yml', 'name: demo\n');
  write(root, '.gitignore', 'node_modules/\n.tmp/\n');
  write(root, 'lib/index.js', 'export const demo = 1;\n');
  write(root, 'lib/graph.js', 'export const graph = 2;\n');
  write(root, 'test/example.test.mjs', 'console.log("example");\n');
  write(root, 'examples/demo.mjs', 'export default 1;\n');
  write(root, 'tools/keep.mjs', 'export const keep = true;\n');
  write(root, 'tools/commit.ps1', '# внутренний гейт, не публикуется\n');
  write(root, 'tools/restart-dsh.ps1', '# внутренний перезапуск, не публикуется\n');
  write(root, 'checks/check-1.mjs', 'console.log("check");\n');
  write(root, 'docs/guide.md', '# Руководство\n');
  write(root, 'docs/tasks/0001/task.md', '# Задание\n');
  write(root, 'docs/subagent-workflow/SPEC.md', '# SPEC\n');
  write(root, 'docs/critic/2026-11-01.md', '# Критик\n');
  write(root, 'docs/self-control.baseline.json', '{}\n');
  write(root, 'docs/workflow-install-v1.md', '# Установка\n');
  write(root, 'docs/workflow-install-answers.md', '# Ответы\n');
  write(root, 'HANDOVER.md', '# Передача\n');
  write(root, 'HANDOVER-NEXT.md', '# Передача\n');
  write(root, '.wf-keys/key.txt', 'ключ приёмщика\n');
  write(root, 'structure/graph.json', JSON.stringify({
    version: 1,
    nodes: [{ id: 'internal-node', role: 'внутренний', provider: 'x', model: 'y' }],
    edges: [],
  }, null, 2) + '\n');
  git(['init', '-b', 'main'], root);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'add', '-A'], root);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], root);
  return root;
}

function builtFixture() {
  const root = makeFixture('build');
  const out = tempPath('staging');
  const result = tool(['--build', '--out', out], root);
  assert.equal(result.code, 0, '--build упал: ' + result.out.slice(0, 800));
  scratch.push(out);
  return { root, out, result };
}

test('--dry-run называет группы, исключения, версию и remote и не создаёт staging', () => {
  const root = makeFixture('dry');
  const out = tempPath('dry-out');
  const result = tool(['--dry-run', '--out', out], root);
  assert.equal(result.code, 0, '--dry-run упал: ' + result.out.slice(0, 800));
  for (const group of ['lib', 'test', 'tools', 'examples', 'docs', 'structure', 'корневые файлы']) {
    assertMentions(result.out, group);
  }
  for (const label of ['docs/tasks', 'docs/subagent-workflow', 'docs/critic', 'checks']) {
    assertMentions(result.out, label);
  }
  assertMentions(result.out, '1.2.3');
  assertMentions(result.out, REMOTE);
  assert.match(result.out, /файл/u, 'сухой прогон не считает файлы');
  assert.equal(fs.existsSync(out), false, '--dry-run создал staging: ' + out);
});

test('--build собирает публичное дерево без внутренних путей и с публичным package.json', () => {
  const { root, out } = builtFixture();
  assert.equal(fs.existsSync(out), true, 'staging не создан');
  for (const rel of EXCLUDED) {
    assert.equal(fs.existsSync(path.join(out, rel)), false, 'в публичном дереве остался внутренний путь ' + rel);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
  assert.equal(pkg.private, undefined, 'package.json остался private');
  assert.equal(pkg.version, '1.2.3', 'версия не взята из текущего package.json');
  assert.match(String(pkg.repository && pkg.repository.url), /github\.com/u);
  assert.match(String(pkg.homepage), /github\.com/u);
  assert.match(String(pkg.bugs && pkg.bugs.url), /github\.com/u);
  assert.deepEqual(pkg.files, FILES, 'files[] не по контракту публикации');
  const graph = JSON.parse(fs.readFileSync(path.join(out, 'structure', 'graph.json'), 'utf8'));
  assert.deepEqual(graph, TEMPLATE, 'публичный граф не равен нейтральному шаблону');
  const gitignore = fs.readFileSync(path.join(out, '.gitignore'), 'utf8');
  for (const marker of ['docs/tasks/', 'docs/subagent-workflow/', 'docs/critic/', 'HANDOVER*.md', '.wf-keys/']) {
    assert.ok(gitignore.includes(marker), '.gitignore не дописан: ' + marker);
  }
  assert.equal(git(['rev-list', '--count', 'HEAD'], out).trim(), '1', 'в staging больше одного коммита');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], out).trim(), 'main');
  assert.match(git(['log', '-1', '--format=%s'], out), /dsh-project-graph 1\.2\.3 .*структура проекта и панель/u);
  const listed = fs.readdirSync(path.join(out, 'tools')).sort();
  assert.ok(listed.includes('keep.mjs'), 'публичный tools/keep.mjs потерян');
  assert.ok(!listed.includes('commit.ps1'), 'tools/commit.ps1 не исключён');
  assert.equal(fs.existsSync(path.join(out, 'docs', 'guide.md')), true, 'публичный docs/guide.md потерян');
  assert.equal(root.startsWith(os.tmpdir()), true);
});

test('--build на существующем staging пересобирает: один коммит, тот же состав', () => {
  const { root, out } = builtFixture();
  const again = tool(['--build', '--out', out], root);
  assert.equal(again.code, 0, 'повторный --build упал: ' + again.out.slice(0, 800));
  assert.equal(git(['rev-list', '--count', 'HEAD'], out).trim(), '1', 'повторная сборка оставила старые коммиты');
  assert.equal(fs.existsSync(path.join(out, 'docs', 'tasks')), false);
});

test('--build отказывает при грязном рабочем дереве', () => {
  const { root } = builtFixture();
  write(root, 'dirty.tmp', 'случайная правка\n');
  const out = tempPath('dirty-out');
  const result = tool(['--build', '--out', out], root);
  assert.equal(result.code, 1, '--build прошёл на грязном дереве: ' + result.out.slice(0, 500));
  assertMentions(result.out, 'грязн');
  assertMentions(result.out, 'dirty.tmp');
  assert.equal(fs.existsSync(out), false, 'отказ при грязном дереве всё-таки создал staging');
});

test('--build называет файл с секретом и не коммитит его', () => {
  const root = makeFixture('leak');
  write(root, 'docs/leak.md', '# утечка\n' + 'ghp_' + 'a'.repeat(30) + '\n');
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'add', '-A'], root);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'leak'], root);
  const out = tempPath('leak-out');
  const result = tool(['--build', '--out', out], root);
  assert.equal(result.code, 1, '--build не заметил секрет: ' + result.out.slice(0, 500));
  assertMentions(result.out, 'docs/leak.md');
  assert.equal(fs.existsSync(path.join(out, '.git')), false, 'при секрете staging всё-таки закоммичен');
});

test('--push без staging отказывает и объясняет, что нужен --build', () => {
  const missing = tempPath('push-missing');
  const result = tool(['--push', '--yes', '--out', missing], REPO);
  assert.equal(result.code, 1, '--push без staging прошёл');
  assertMentions(result.out, '--build');
});

test('--push без --yes отказывает и требует подтверждение', () => {
  const { root, out } = builtFixture();
  const result = tool(['--push', '--out', out], root);
  assert.equal(result.code, 1, '--push без --yes прошёл');
  assertMentions(result.out, '--yes');
});

test('неверные аргументы дают код 2', () => {
  assert.equal(tool([], REPO).code, 2, 'запуск без режима не отвергнут');
  assert.equal(tool(['--dry-run', '--build'], REPO).code, 2, 'два режима не отвергнуты');
  assert.equal(tool(['--wat'], REPO).code, 2, 'неизвестный аргумент не отвергнут');
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
console.log('PUBLISH-PUBLIC TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
