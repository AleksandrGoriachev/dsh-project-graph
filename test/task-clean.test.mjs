import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/* 0272: task-clean переносит шум в .tmp/hold и не трогает задание и tracked. */

function moduleDirUrl(url) {
  let p = decodeURIComponent(url.pathname);
  if (process.platform === 'win32' && /^\/[A-Za-z]:/u.test(p)) p = p.slice(1);
  return p;
}

const TEST_DIR = path.dirname(moduleDirUrl(new URL(import.meta.url)));
const ROOT = path.resolve(TEST_DIR, '..');
const SCRIPT = path.join(ROOT, 'docs', 'subagent-workflow', 'scripts', 'task-clean.mjs');

function abs(root, rel) {
  return path.join(root, ...rel.split('/'));
}

function writeFile(root, rel, text = '') {
  const target = abs(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-clean-'));
  writeFile(root, 'docs/tasks/9001/task.md', '# 9001\n');
  writeFile(root, 'docs/tasks/9001/criteria.json', JSON.stringify({ task: '9001' }));
  writeFile(root, 'docs/tasks/9002/criteria.lock', 'lock\n');
  writeFile(root, 'docs/tasks/9002/gates.jsonl', '{}\n');
  writeFile(root, 'docs/tasks/9002/verify.json', '{}\n');
  writeFile(root, 'artifacts/probe.tap', 'TAP version 13\n');
  writeFile(root, '%SystemDrive%/x.db', 'db\n');
  writeFile(root, 'docs/critic/2026-11-12.md', '# critic\n');
  writeFile(root, 'root-noise.tap', 'TAP version 13\n');
  return root;
}

function runClean(root, extra = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--task', 'docs/tasks/9001', '--repo', root, ...extra],
    { encoding: 'utf8', timeout: 60000 },
  );
}

function tree(root) {
  const out = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const target = path.join(dir, ent.name);
      const rel = path.relative(root, target).split(path.sep).join('/');
      out.push((ent.isDirectory() ? 'd:' : 'f:') + rel);
      if (ent.isDirectory() && !ent.isSymbolicLink()) walk(target);
    }
  };
  walk(root);
  return out;
}

const MOVED = [
  'docs/tasks/9002/criteria.lock',
  'docs/tasks/9002/gates.jsonl',
  'docs/tasks/9002/verify.json',
  'artifacts/probe.tap',
  '%SystemDrive%/x.db',
  'docs/critic/2026-11-12.md',
  'root-noise.tap',
];

/* В --json каталоги называются целиком; файлы внутри проверяются в hold. */
const MOVED_REPORT = [
  '%SystemDrive%',
  'artifacts',
  'docs/critic/2026-11-12.md',
  'docs/tasks/9002/criteria.lock',
  'docs/tasks/9002/gates.jsonl',
  'docs/tasks/9002/verify.json',
  'root-noise.tap',
];

test('0272: шум перенесён в .tmp/hold, задание цело', (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const r = runClean(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /перенесено 7 из 7/u);

  for (const rel of ['docs/tasks/9001/task.md', 'docs/tasks/9001/criteria.json']) {
    assert.ok(fs.existsSync(abs(root, rel)), 'задание должно остаться: ' + rel);
  }
  for (const rel of MOVED) {
    assert.ok(!fs.existsSync(abs(root, rel)), 'шум не должен остаться: ' + rel);
  }

  const holdRoot = abs(root, '.tmp/hold');
  const holds = fs.readdirSync(holdRoot);
  assert.equal(holds.length, 1, 'ожидался ровно один каталог переноса');
  assert.match(holds[0], /^9001-\d{8}-\d{6}$/u);
  for (const rel of MOVED) {
    assert.ok(fs.existsSync(abs(root, '.tmp/hold/' + holds[0] + '/' + rel)), 'в переносе нет ' + rel);
  }
});

test('0272: --dry-run на чистом дереве ничего не создаёт и не двигает', (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = runClean(root, ['--json']);
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.dryRun, false);
  assert.equal(report.moved.length, 7);
  assert.deepEqual([...report.moved].sort(), [...MOVED_REPORT].sort());
  assert.deepEqual(report.remainingDirty, []);
  const hold = abs(root, '.tmp/hold/' + fs.readdirSync(abs(root, '.tmp/hold'))[0]);
  for (const rel of MOVED) {
    assert.ok(fs.existsSync(path.join(hold, ...rel.split('/'))), 'в переносе нет ' + rel);
  }

  const before = tree(root);
  const second = runClean(root, ['--dry-run']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /dry-run/u);
  assert.deepEqual(tree(root), before, 'dry-run изменил дерево');
});

test('0272: tracked-файлы шума не переносятся', (t) => {
  const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitCheck.status !== 0) {
    t.skip('git недоступен');
    return;
  }
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync('git', ['add', 'docs/tasks/9002/criteria.lock', 'docs/critic/2026-11-12.md'], { cwd: root, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);

  const r = runClean(root);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(abs(root, 'docs/tasks/9002/criteria.lock')), 'tracked criteria.lock не должен переноситься');
  assert.ok(fs.existsSync(abs(root, 'docs/critic/2026-11-12.md')), 'tracked critic не должен переноситься');
  assert.ok(!fs.existsSync(abs(root, 'docs/tasks/9002/gates.jsonl')), 'untracked gates.jsonl должен переноситься');
  assert.ok(!fs.existsSync(abs(root, 'artifacts/probe.tap')), 'untracked artifacts не должны оставаться в корне');
  const hold = abs(root, '.tmp/hold/' + fs.readdirSync(abs(root, '.tmp/hold'))[0]);
  assert.ok(fs.existsSync(path.join(hold, 'artifacts', 'probe.tap')), 'untracked artifacts должны переноситься в hold');
  assert.match(r.stdout, /tracked, оставлены на месте: 2/u);
});
