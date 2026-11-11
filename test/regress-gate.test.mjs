/**
 * 0207: регрессионный гейт в приёмке.
 *
 * Поведенческие проверки (с1-с4 задания):
 *   c1  task-accept зовёт task-regress после verify и до accepted; запись
 *       приёмки содержит сводку гейта, журнал ворот — строку accept с regress=;
 *   c2  провал регресса блокирует accepted: acceptance.json не пишется, отказ
 *       называет задачу и критерий (0001/C1);
 *   c3  ночной инструмент tools/test.mjs зовёт task-regress по явному --nightly
 *       или --regress-only; без флага регресса нет; провал пробрасывается;
 *   c4  сломанная старая проверка (checks/old-check.mjs) валит приёмку новой
 *       задачи; allowlist снимает только названные критерии, просроченный —
 *       снова валит; набор с известным провалом (suites[]) не красный.
 *   B3  untrusted валит всегда (SPEC 2.3.2), statuses[] в allowlist не читается.
 *   B4  ночной путь = scheduled-задача с явным --nightly; default не регрессирует.
 *
 * Стенд: временный git-репозиторий с копией docs/subagent-workflow/scripts,
 * принятым заданием 0001 (подпись Ed25519 генерируется тестом) и заданием
 * 0999, которое принимается. Обе задачи покрывают src/green.txt, поэтому
 * --changed-фильтр гейта обязан выбрать 0001.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cleanup = [];
let passed = 0;
const failures = [];

function test(name, body) {
  return Promise.resolve().then(body).then(() => {
    passed += 1;
    console.log('ok ' + name);
  }).catch((error) => {
    failures.push({ name, error });
    console.error('not ok ' + name);
    console.error(error && error.stack ? error.stack : error);
  });
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function git(cwd, args, env) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@local', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@local', ...(env || {}) },
  });
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + (result.stderr || result.stdout));
  return result.stdout.trim();
}

function taskMd(id, extra) {
  const meta = {
    id,
    version: 1,
    title: 'fixture ' + id,
    risk: 'low',
    created: '2026-11-11',
    owner: 'fixture',
    executor: 'subagent:worker',
    acceptor: 'subagent:judge',
    base: 'HEAD',
    allowedPaths: ['src/**'],
    protectedPaths: [],
    redAllowDirty: ['docs/tasks/' + id + '/**'],
    hashExclude: [],
    decisions: [],
    ...(extra || {}),
  };
  return '<!-- TASK-META' + String.fromCharCode(10) + JSON.stringify(meta, null, 2)
    + String.fromCharCode(10) + '-->' + String.fromCharCode(10) + String.fromCharCode(10)
    + '# fixture ' + id + String.fromCharCode(10) + String.fromCharCode(10)
    + '<!-- CRITERIA:BEGIN -->' + String.fromCharCode(10)
    + '## criteria' + String.fromCharCode(10) + String.fromCharCode(10)
    + '| ID |' + String.fromCharCode(10) + '| --- |' + String.fromCharCode(10) + '| C1 |' + String.fromCharCode(10)
    + '<!-- CRITERIA:END -->' + String.fromCharCode(10);
}

function criteriaJson(id, command) {
  return JSON.stringify({
    task: id,
    setup: [],
    teardown: [],
    criteria: [{
      id: 'C1',
      title: 'fixture check ' + id,
      command,
      expect: { exitCode: 0 },
      covers: ['src/green.txt'],
      timeoutMs: 60000,
      tags: ['behaviour'],
    }],
  }, null, 2) + String.fromCharCode(10);
}

function allowlistJson(entries, suites) {
  return JSON.stringify({
    version: 1,
    kind: 'regress-allowlist',
    generatedAt: '2026-11-11',
    note: 'fixture allowlist',
    entries: entries || [],
    suites: suites || [],
  }, null, 2) + String.fromCharCode(10);
}

function copyScripts(fixture) {
  fs.mkdirSync(path.join(fixture, 'docs', 'subagent-workflow'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'docs', 'subagent-workflow', 'scripts'), path.join(fixture, 'docs', 'subagent-workflow', 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'docs', 'subagent-workflow', 'workflow.config.json'), path.join(fixture, 'docs', 'subagent-workflow', 'workflow.config.json'));
}

async function makeFixture(options) {
  const opts = options || {};
  const fixture = tempDir('pg-0207-fixture-');
  copyScripts(fixture);
  write(path.join(fixture, 'docs', 'tasks', '0001', 'task.md'), taskMd('0001'));
  write(path.join(fixture, 'docs', 'tasks', '0001', 'criteria.json'), criteriaJson('0001', 'node checks/old-check.mjs'));
  write(path.join(fixture, 'docs', 'tasks', '0999', 'task.md'), taskMd('0999'));
  write(path.join(fixture, 'docs', 'tasks', '0999', 'criteria.json'), criteriaJson('0999', 'node checks/green.mjs'));
  write(path.join(fixture, 'checks', 'old-check.mjs'), opts.broken === false ? 'console.log("old check ok");' + String.fromCharCode(10) : 'process.exit(1);' + String.fromCharCode(10));
  write(path.join(fixture, 'checks', 'green.mjs'), 'console.log("green");' + String.fromCharCode(10));
  write(path.join(fixture, 'src', 'green.txt'), 'base' + String.fromCharCode(10));
  if (opts.allowlist) write(path.join(fixture, 'docs', 'tasks', '0207', 'regress.allowlist.json'), opts.allowlist);

  const scripts = pathToFileURL(path.join(fixture, 'docs', 'subagent-workflow', 'scripts')).href;
  const { readTask, computeLock } = await import(scripts + '/lib/common.mjs');
  const { generateKeyPair, signRecord } = await import(scripts + '/sign.mjs');
  const keys = generateKeyPair();
  write(path.join(fixture, 'docs', 'subagent-workflow', 'acceptors.json'), JSON.stringify({
    acceptors: [{ keyId: 'fixture-key', kind: 'agent', owner: 'fixture', publicKeyPem: keys.publicKeyPem, createdAt: '2026-11-11T00:00:00Z' }],
  }, null, 2) + String.fromCharCode(10));
  const keyFile = path.join(tempDir('pg-0207-key-'), 'fixture.key.pem');
  write(keyFile, keys.privateKeyPem);

  git(fixture, ['init', '-q', '-b', 'main']);
  git(fixture, ['add', '-A']);
  git(fixture, ['commit', '-q', '-m', 'fixture contract']);
  const base1 = git(fixture, ['rev-parse', 'HEAD']);

  const oldDir = path.join(fixture, 'docs', 'tasks', '0001');
  const oldRecord = signRecord({
    version: 6,
    status: 'accepted',
    task: '0001',
    title: 'old accepted task',
    risk: 'low',
    contractCommit: base1,
    red: { baseSha: base1, contractCommit: base1, failed: 1, failedIds: ['C1'] },
    actor: { kind: 'agent', session: 'fixture-old-session' },
    acceptedAt: '2026-11-11T00:00:00Z',
  }, { privateKeyPem: keys.privateKeyPem, keyId: 'fixture-key' });
  write(path.join(oldDir, 'acceptance.json'), JSON.stringify(oldRecord, null, 2) + String.fromCharCode(10));

  const newDir = path.join(fixture, 'docs', 'tasks', '0999');
  const parsed = readTask(newDir);
  const lock = computeLock(fixture, newDir, parsed.meta, parsed.taskMd, parsed.criteria, base1);
  write(path.join(newDir, 'criteria.lock'), JSON.stringify(lock, null, 2) + String.fromCharCode(10));

  git(fixture, ['add', '-A']);
  git(fixture, ['commit', '-q', '-m', 'fixture acceptance metadata']);
  const base2 = git(fixture, ['rev-parse', 'HEAD']);

  /* Замок 0999 должен смотреть на HEAD, на котором будет приёмка. */
  const parsed2 = readTask(newDir);
  const lock2 = computeLock(fixture, newDir, parsed2.meta, parsed2.taskMd, parsed2.criteria, base2);
  write(path.join(newDir, 'criteria.lock'), JSON.stringify(lock2, null, 2) + String.fromCharCode(10));
  write(path.join(fixture, 'src', 'green.txt'), 'changed' + String.fromCharCode(10));

  return { dir: fixture, keyFile, oldDir, newDir, head: base2, scripts };
}

function accept(fixture) {
  const script = path.join(fixture.dir, 'docs', 'subagent-workflow', 'scripts', 'task-accept.mjs');
  return spawnSync(process.execPath, [
    script,
    '--task', 'docs/tasks/0999',
    '--repo', fixture.dir,
    '--key', fixture.keyFile,
    '--key-id', 'fixture-key',
    '--allow-missing-red',
    '--note', 'fixture: known debt is baselined',
  ], {
    cwd: fixture.dir,
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSION_ID: 'fixture-acceptor-session', DSH_MODEL: 'fixture-model', NO_COLOR: '1' },
  });
}

function combined(result) {
  return String(result.stdout || '') + String.fromCharCode(10) + String(result.stderr || '');
}

function acceptanceOf(fixture) {
  const file = path.join(fixture.newDir, 'acceptance.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gateJournal(fixture) {
  const file = path.join(fixture.newDir, 'gates.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function runRegress(fixture, extra) {
  const script = path.join(fixture.dir, 'docs', 'subagent-workflow', 'scripts', 'task-regress.mjs');
  const out = path.join(tempDir('pg-0207-out-'), 'report.json');
  const result = spawnSync(process.execPath, [script, '--repo', fixture.dir, '--json', '--out', out, ...(extra || [])], {
    cwd: fixture.dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { report = null; }
  return { result, report, text: combined(result) };
}

function nightly(fixture, extra) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'test.mjs'), '--regress-only', '--repo', fixture.dir, ...(extra || [])], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

async function c1() {
  const fixture = await makeFixture({ broken: false });
  const result = accept(fixture);
  assert.equal(result.status, 0, combined(result));
  const record = acceptanceOf(fixture);
  assert.ok(record, 'acceptance.json не записан');
  assert.ok(record.regress && typeof record.regress === 'object', 'в записи нет сводки regress');
  assert.equal(record.regress.failed, 0, JSON.stringify(record.regress));
  assert.equal(record.regress.mode, 'changed');
  assert.ok(record.regress.tasks >= 1, 'гейт не выбрал ни одной принятой задачи: ' + JSON.stringify(record.regress));
  const rows = gateJournal(fixture);
  const acceptRow = rows.find((row) => row.kind === 'accept' && row.verdict === 'accepted');
  assert.ok(acceptRow, 'в gates.jsonl нет строки accept');
  assert.match(String(acceptRow.exitSummary || ''), /regress=/u);
}

async function c2() {
  const fixture = await makeFixture({ broken: true });
  const result = accept(fixture);
  assert.notEqual(result.status, 0, 'провал регресса не заблокировал приёмку');
  assert.equal(acceptanceOf(fixture), null, 'acceptance.json записан при провале регресса');
  const text = combined(result);
  assert.match(text, /0001/u, 'отказ не называет упавшую задачу: ' + text.slice(-3000));
  assert.match(text, /C1/u, 'отказ не называет упавший критерий: ' + text.slice(-3000));
  assert.equal(gateJournal(fixture).filter((row) => row.kind === 'accept' && row.verdict === 'accepted').length, 0);
}

async function c3() {
  const broken = await makeFixture({ broken: true });
  const failed = nightly(broken);
  assert.notEqual(failed.status, 0, 'ночной прогон не пробросил провал регресса');
  assert.match(combined(failed), /0001/u);
  assert.match(combined(failed), /C1/u);

  const allowed = await makeFixture({
    broken: true,
    allowlist: allowlistJson([{ task: '0001', criteria: ['C1'], reason: 'fixture known debt', reviewBy: '2099-01-01' }]),
  });
  const ok = nightly(allowed);
  assert.equal(ok.status, 0, combined(ok));
  assert.match(combined(ok), /REGRESS OK/u);
}

async function c4() {
  const fixture = await makeFixture({ broken: true });
  const direct = runRegress(fixture, []);
  assert.notEqual(direct.result.status, 0, 'task-regress не увидел сломанную старую проверку');
  assert.ok(direct.report, 'task-regress не дал отчёт');
  const old = (direct.report.tasks || []).find((item) => item.task === '0001');
  assert.ok(old, 'в отчёте нет задания 0001');
  assert.deepEqual(old.failedIds, ['C1']);
  assert.equal(old.status, 'regressed');

  const result = accept(fixture);
  assert.notEqual(result.status, 0, 'сломанная старая проверка не заблокировала приёмку');
  assert.equal(acceptanceOf(fixture), null);

  const expired = await makeFixture({
    broken: true,
    allowlist: allowlistJson([{ task: '0001', criteria: ['C1'], reason: 'expired', reviewBy: '2000-01-01' }]),
  });
  const expiredRun = runRegress(expired, []);
  assert.notEqual(expiredRun.result.status, 0, 'просроченный allowlist снял провал');
  const expiredAccept = accept(expired);
  assert.notEqual(expiredAccept.status, 0, 'просроченный allowlist пропустил приёмку');
}

async function untrustedAlwaysFails() {
  const fixture = await makeFixture({
    broken: false,
    allowlist: allowlistJson([{ task: '0001', statuses: ['untrusted'], reason: 'fixture signature debt', reviewBy: '2099-01-01' }]),
  });
  const file = path.join(fixture.oldDir, 'acceptance.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.signature = 'not-a-valid-signature';
  write(file, JSON.stringify(record, null, 2) + String.fromCharCode(10));
  const run = runRegress(fixture, []);
  assert.notEqual(run.result.status, 0, 'untrusted снят allowlist: SPEC 2.3.2 запрещает');
  const old = (run.report.tasks || []).find((item) => item.task === '0001');
  assert.ok(old, 'в отчёте нет задания 0001');
  assert.equal(old.status, 'untrusted');
  assert.ok(!old.allowedStatus, 'statuses[] не должен легализовать untrusted');
}

async function suiteAllowlist() {
  function suiteFixture(withAllowlist) {
    const fixture = tempDir('pg-0207-suite-');
    fs.mkdirSync(path.join(fixture, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'tools', 'test.mjs'), path.join(fixture, 'tools', 'test.mjs'));
    write(path.join(fixture, 'test', 'known.test.mjs'),
      'console.error("FAIL known one");' + String.fromCharCode(10)
      + 'console.log("KNOWN SUITE TEST FAILED: 1 из 1");' + String.fromCharCode(10)
      + 'process.exit(1);' + String.fromCharCode(10));
    if (withAllowlist) {
      write(path.join(fixture, 'docs', 'tasks', '0207', 'regress.allowlist.json'),
        allowlistJson([], [{ file: 'known.test.mjs', tests: ['known one'], reason: 'fixture', reviewBy: '2099-01-01' }]));
    }
    return fixture;
  }
  const strictFixture = suiteFixture(false);
  const strict = spawnSync(process.execPath, [path.join(strictFixture, 'tools', 'test.mjs')], { cwd: strictFixture, encoding: 'utf8' });
  assert.notEqual(strict.status, 0, 'набор с провалом не упал без allowlist');

  const fixture = suiteFixture(true);
  const allowed = spawnSync(process.execPath, [path.join(fixture, 'tools', 'test.mjs')], { cwd: fixture, encoding: 'utf8' });
  assert.equal(allowed.status, 0, combined(allowed));
  assert.match(combined(allowed), /KNOWN known\.test\.mjs/u);
}

async function nightlyExplicit() {
  function installRunner(fixture) {
    fs.mkdirSync(path.join(fixture.dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(fixture.dir, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'tools', 'test.mjs'), path.join(fixture.dir, 'tools', 'test.mjs'));
    write(path.join(fixture.dir, 'test', 'pass.test.mjs'),
      'console.log("PASS TEST OK: 1/1");' + String.fromCharCode(10));
  }

  const broken = await makeFixture({ broken: true });
  installRunner(broken);
  const noFlag = spawnSync(process.execPath, [path.join(broken.dir, 'tools', 'test.mjs')], { cwd: broken.dir, encoding: 'utf8' });
  assert.equal(noFlag.status, 0, combined(noFlag));
  assert.doesNotMatch(combined(noFlag), /REGRESS/u, 'без флага regress не должен запускаться');

  const failed = spawnSync(process.execPath, [path.join(broken.dir, 'tools', 'test.mjs'), '--nightly'], { cwd: broken.dir, encoding: 'utf8' });
  assert.notEqual(failed.status, 0, '--nightly не позвал регресс');
  assert.match(combined(failed), /REGRESS FAILED/u);
  assert.match(combined(failed), /0001: C1/u);

  const green = await makeFixture({ broken: false });
  installRunner(green);
  const ok = spawnSync(process.execPath, [path.join(green.dir, 'tools', 'test.mjs'), '--nightly'], { cwd: green.dir, encoding: 'utf8' });
  assert.equal(ok.status, 0, combined(ok));
  assert.match(combined(ok), /REGRESS OK/u);
  assert.match(combined(ok), /TESTS OK: 1 файлов/u);
}

await test('c1: task-accept вызывает task-regress и пишет сводку', c1);
await test('c2: провал регресса блокирует accepted', c2);
await test('c3: ночной запуск зовёт регресс и пробрасывает провал', c3);
await test('c4: сломанная старая проверка валит приёмку; allowlist точечный и со сроком', c4);
await test('SPEC 2.3.2: untrusted валит всегда, statuses[] не легализует', untrustedAlwaysFails);
await test('B4: ночной путь — явный --nightly, без флага регресса нет', nightlyExplicit);
await test('allowlist: известный провал набора не красит первый прогон', suiteAllowlist);

for (const dir of cleanup) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log('REGRESS-GATE TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
