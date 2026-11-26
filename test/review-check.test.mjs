/*
 * Задание 0361: проверка review.json движковым CLI до квитанции.
 *
 * Отказ приёмки 0355 стоил лишнего прогона ревьюера: в review.json не было
 * reviewer/verdict, и об этом узнавали на спавне приёмщика. checkReviewArtifact
 * зовёт движковый check-review.mjs (письмо workflow--246) и возвращает его
 * вердикт, а отсутствие CLI — штатный ответ available: false, не исключение.
 *
 * Настоящий docs/tasks/** тест не трогает: каталог задания создаётся во
 * временном. Движок представлен фикстурой — она повторяет документированный
 * контракт CLI (флаги, коды 0/1/2, JSON {ok, errors, hints, releaseReady,
 * remarks}), потому что в проекте может не быть движкового CLI. Отдельный
 * кейс проверяет, что вердикт фикстуры не подменяется: решение вне схемы даёт
 * отказ с причиной движка, а не нашу.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkReviewArtifact } from '../lib/api.js';

/* Контракт check-review.mjs: --file, --task, --json; 0 ок, 1 отказ, 2 нет файла. */
const FIXTURE_CLI = String.raw`/* Фикстура движкового CLI (контракт check-review.mjs, письмо workflow--246). */
import fs from 'node:fs';
import path from 'node:path';

function arg(name) {
  const at = process.argv.indexOf(name);
  if (at === -1) return '';
  const value = process.argv[at + 1];
  return value === undefined ? '' : String(value);
}

const file = arg('--file');
if (!file) {
  console.log('check-review: нужен --file <review.json>');
  process.exit(2);
}
const reviewFile = path.resolve(file);
if (!fs.existsSync(reviewFile)) {
  console.log('check-review: нет файла ' + reviewFile);
  process.exit(2);
}

let review;
try {
  review = JSON.parse(fs.readFileSync(reviewFile, 'utf8').replace(/^\uFEFF/u, ''));
} catch (error) {
  console.log('check-review: review.json не JSON: ' + String(error && error.message ? error.message : error));
  process.exit(1);
}

const errors = [];
const hints = [];
if (review === null || typeof review !== 'object' || Array.isArray(review)) {
  errors.push('review: ожидается объект');
} else {
  if (review.decision !== 'accepted' && review.decision !== 'rework') errors.push('review.decision: accepted | rework');
  if (review.remarks !== undefined && !Array.isArray(review.remarks)) errors.push('review.remarks: массив');
}

const task = arg('--task');
if (task) {
  const lockFile = path.join(path.resolve(task), 'criteria.lock');
  if (!fs.existsSync(lockFile)) {
    errors.push('нет criteria.lock задания: привязку сверить не с чем (' + lockFile + ')');
  } else {
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { lock = null; }
    if (!lock) {
      errors.push('criteria.lock не читается: ' + lockFile);
    } else {
      const bound = review && review.contractCommit !== undefined && review.contractCommit !== null
        ? String(review.contractCommit)
        : null;
      if (bound === null) {
        errors.push('review без привязки к контракту: нет review.contractCommit и review.taskFileSha256');
        hints.push('привязка: contractCommit = criteria.lock.contractCommit');
      } else if (bound !== String(lock.contractCommit || '')) {
        errors.push('review.contractCommit ' + bound + ' не совпадает с контрактом ' + String(lock.contractCommit || '—'));
      }
    }
  }
}

const remarks = review && Array.isArray(review.remarks) ? review.remarks : [];
const releaseReady = errors.length === 0 && Boolean(review) && review.decision === 'accepted';
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    ok: errors.length === 0,
    errors,
    hints,
    releaseReady,
    remarks: { total: remarks.length, unresolvedBlocking: 0 },
  }, null, 2));
} else if (errors.length === 0) {
  console.log('check-review: ок');
} else {
  console.log('check-review: отказ');
  for (const error of errors) console.log('  ' + error);
}
process.exit(errors.length === 0 ? 0 : 1);
`;

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Движок проекта: <root>/docs/subagent-workflow с фикстурой check-review.mjs. */
function writeEngineCli(workspace) {
  const dir = path.join(workspace, 'docs', 'subagent-workflow');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'VERSION'), '9.9.9\n');
  fs.writeFileSync(path.join(dir, 'workflow.config.json'), JSON.stringify({ version: 1 }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'check-review.mjs'), FIXTURE_CLI);
  return dir;
}

/** Каталог задания во временном проекте: criteria.lock, как у движка. */
function newTask(workspace) {
  const task = path.join(workspace, 'docs', 'tasks', '9001');
  fs.mkdirSync(task, { recursive: true });
  fs.writeFileSync(path.join(task, 'criteria.lock'),
    JSON.stringify({ contractCommit: 'abc123', taskFileSha256: 'def456' }, null, 2) + '\n');
  return task;
}

function putReview(task, review) {
  fs.writeFileSync(path.join(task, 'review.json'), JSON.stringify(review, null, 2) + '\n');
}

const VALID_REVIEW = {
  reviewer: 'reviewer-1',
  verdict: 'accepted',
  decision: 'accepted',
  contractCommit: 'abc123',
  remarks: [],
};

test('валидный review.json проходит: ok, code 0, CLI доступен', () => {
  const root = tempDir('pg-review-ok-');
  writeEngineCli(root);
  const task = newTask(root);
  putReview(task, VALID_REVIEW);
  const result = checkReviewArtifact(root, task);
  assert.equal(result.available, true);
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.deepEqual(result.errors, []);
});

test('review.json без reviewer/verdict — отказ, поле названо', () => {
  const root = tempDir('pg-review-signature-');
  writeEngineCli(root);
  const task = newTask(root);
  putReview(task, { decision: 'accepted', contractCommit: 'abc123', remarks: [] });
  const result = checkReviewArtifact(root, task);
  assert.equal(result.available, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.ok(result.errors.some((row) => /review\.reviewer/u.test(row)),
    'отказ обязан назвать reviewer: ' + JSON.stringify(result.errors));
  assert.ok(result.errors.some((row) => /review\.verdict/u.test(row)),
    'отказ обязан назвать verdict: ' + JSON.stringify(result.errors));
  assert.equal(result.errors.some((row) => /review\.decision/u.test(row)), false,
    'фикстура движка пропустила схему — значит отказ наш, по подписи');
});

test('вердикт CLI не подменяется: решение вне схемы — отказ движка', () => {
  const root = tempDir('pg-review-engine-');
  writeEngineCli(root);
  const task = newTask(root);
  putReview(task, { ...VALID_REVIEW, decision: 'maybe' });
  const result = checkReviewArtifact(root, task);
  assert.equal(result.available, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.ok(result.errors.some((row) => /review\.decision/u.test(row)),
    'причина отказа движка должна дойти до вызывающего: ' + JSON.stringify(result.errors));
});

test('review.json не привязан к контракту — отказ CLI с названной причиной', () => {
  const root = tempDir('pg-review-binding-');
  writeEngineCli(root);
  const task = newTask(root);
  putReview(task, {
    reviewer: 'reviewer-1', verdict: 'accepted', decision: 'accepted', remarks: [],
  });
  const result = checkReviewArtifact(root, task);
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.ok(result.errors.some((row) => /contractCommit/u.test(row)),
    'отказ обязан назвать привязку: ' + JSON.stringify(result.errors));
});

test('нет review.json — код 2 и названный файл', () => {
  const root = tempDir('pg-review-nofile-');
  writeEngineCli(root);
  const task = newTask(root);
  const result = checkReviewArtifact(root, task);
  assert.equal(result.available, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.ok(result.errors.some((row) => /review\.json/u.test(row)),
    'отказ обязан назвать файл: ' + JSON.stringify(result.errors));
});

test('нет движкового CLI — available:false без исключения', () => {
  const root = tempDir('pg-review-noengine-');
  const task = newTask(root);
  putReview(task, VALID_REVIEW);
  let result;
  assert.doesNotThrow(() => { result = checkReviewArtifact(root, task); });
  assert.equal(result.available, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.ok(result.errors.some((row) => /check-review\.mjs/u.test(row)),
    'причина обязана назвать отсутствующий CLI: ' + JSON.stringify(result.errors));
});

test('внешний движок из карты engine-roots.json — CLI найден', () => {
  const root = tempDir('pg-review-mapped-');
  const task = newTask(root);
  putReview(task, VALID_REVIEW);
  const engineRepo = tempDir('pg-review-engine-repo-');
  writeEngineCli(engineRepo);
  const mapFile = path.join(tempDir('pg-review-map-'), 'engine-roots.json');
  fs.writeFileSync(mapFile, JSON.stringify({ [root]: engineRepo }, null, 2) + '\n');
  const previous = process.env.WF_ENGINE_ROOTS;
  process.env.WF_ENGINE_ROOTS = mapFile;
  let result;
  try {
    result = checkReviewArtifact(root, task);
  } finally {
    if (previous === undefined) delete process.env.WF_ENGINE_ROOTS;
    else process.env.WF_ENGINE_ROOTS = previous;
  }
  assert.equal(result.available, true);
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
});

for (const dir of tempDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
}

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('REVIEW CHECK TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
