/**
 * 0198: квитанция ревьюера.
 *
 * review.json — обычный файл: его может написать координатор, и гейт приёмки,
 * проверяющий только поля, обходится правкой одного JSON. Квитанция отделяет
 * работу ревьюера от пересказа: её пишет движок, закрывая прогон объявленного
 * ревьюера, и она связывает подпись с дословными байтами review.json
 * (artifactSha256). Квитанции без файла, с разошедшимся хешем или от чужого
 * ревьюера не принимаются.
 *
 * Модуль знает только файлы задания и sha256: ни DSH, ни структуры, ни времени
 * кроме отметки at. Поэтому гейт запуска (lib/spawn.js) и движковая копия для
 * task-accept проверяются на одних и тех же фикстурах.
 */
import fs from 'node:fs';
import path from 'node:path';
/* Хеш считается тем же помощником, что у якорей: ответ проверок — один. */
import { sha256Hex } from './anchors.js';

/* Имя квитанции рядом с review.json — часть контракта задания 0198. */
export const REVIEW_RECEIPT_FILE = 'review.receipt.json';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Голое имя узла: последний сегмент после ':'. «subagent:reviewer-1» и
 * «reviewer-1» — один узел, а «reviewer-2» — другой: сравнение по хвосту не
 * даёт подменить ревьюера префиксом роли.
 */
function bare(value) {
  const name = text(value);
  return name.slice(name.lastIndexOf(':') + 1);
}

/** Путь квитанции задания: рядом с review.json. */
export function reviewReceiptPath(taskDir) {
  return path.join(String(taskDir || ''), REVIEW_RECEIPT_FILE);
}

/**
 * Записать квитанцию о закрытом прогоне ревьюера.
 *
 * Вызывается движком, а не агентом: квитанция — свидетельство того, что прогон
 * ревьюера действительно был. Нет review.json, файл не разбирается или называет
 * другого ревьюера — квитанция не пишется (null): подтверждать нечего.
 *
 * @param {{ taskDir?: string, task?: unknown, reviewer?: string, node?: string,
 *   runId?: string, childId?: string, sessionId?: string }} fields
 * @returns {object|null} записанная квитанция или null.
 */
export function writeReviewReceipt({ taskDir, task, reviewer, node, runId, childId, sessionId } = {}) {
  const dir = text(taskDir);
  if (!dir) return null;
  const artifactPath = path.join(dir, 'review.json');
  let raw;
  try {
    raw = fs.readFileSync(artifactPath);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const named = text(parsed.reviewer) || text(parsed.reviewerNode);
  if (!named || bare(named) !== bare(reviewer)) return null;
  const receipt = {
    version: 1,
    task: String(task || ''),
    reviewer: text(reviewer),
    node: text(node),
    runId: text(runId),
    childId: text(childId),
    sessionId: text(sessionId),
    artifact: 'review.json',
    artifactSha256: sha256Hex(raw.toString('utf8')),
    decision: parsed.decision === undefined ? null : parsed.decision,
    verdict: parsed.verdict === undefined ? null : parsed.verdict,
    at: new Date().toISOString(),
  };
  fs.mkdirSync(dir, { recursive: true });
  const file = reviewReceiptPath(dir);
  const body = JSON.stringify(receipt, null, 2) + '\n';
  /*
   * Атомарная замена: читатель не должен увидеть половину квитанции. Хост может
   * придержать rename — тогда прямая запись: история важнее формы записи.
   */
  const temporary = file + '.' + String(process.pid) + '.tmp';
  try {
    fs.writeFileSync(temporary, body, 'utf8');
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.writeFileSync(file, body, 'utf8');
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* обломок не нужен */ }
    }
  }
  return receipt;
}

/**
 * Проверить, что ревью задания подтверждено квитанцией движка.
 *
 * Три вещи, без которых квитанция ничего не подтверждает: файл существует,
 * разбирается как JSON-объект версии 1; выписан тому же ревьюеру (сравнение по
 * голому имени); artifactSha256 совпадает с текущими байтами review.json.
 * Ошибки называются review-receipt: — по ним гейт и task-accept отказывают.
 *
 * @param {{ taskDir?: string, reviewer?: string }} fields
 * @returns {{ ok: boolean, errors: string[], receipt: object|null }}
 */
export function validateReviewReceipt({ taskDir, reviewer } = {}) {
  const dir = text(taskDir);
  const expected = bare(reviewer);
  if (!dir) return { ok: false, errors: ['review-receipt: не назван каталог задания'], receipt: null };
  if (!expected) return { ok: false, errors: ['review-receipt: не назван ожидаемый ревьюер'], receipt: null };
  const file = reviewReceiptPath(dir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {
      ok: false,
      errors: ['review-receipt: нет квитанции ' + file + ' — её пишет движок при завершении прогона ревьюера'],
      receipt: null,
    };
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      errors: ['review-receipt: квитанция ' + file + ' не разбирается как JSON: '
        + (error && error.message ? error.message : String(error))],
      receipt: null,
    };
  }
  if (!isPlainObject(receipt)) {
    return { ok: false, errors: ['review-receipt: квитанция ' + file + ' — не JSON-объект'], receipt: null };
  }
  const errors = [];
  if (Number(receipt.version) !== 1) {
    errors.push('review-receipt: версия квитанции ' + JSON.stringify(receipt.version) + ', ожидается 1');
  }
  const named = bare(receipt.reviewer);
  if (!named) errors.push('review-receipt: в квитанции не назван ревьюер');
  else if (named !== expected) {
    errors.push('review-receipt: квитанция выдана «' + named + '», а ожидается «' + expected + '»');
  }
  if (text(receipt.artifact) !== 'review.json') {
    errors.push('review-receipt: квитанция покрывает «' + text(receipt.artifact) + '», а не review.json');
  }
  let artifact = null;
  try {
    artifact = fs.readFileSync(path.join(dir, 'review.json'), 'utf8');
  } catch {
    errors.push('review-receipt: нет review.json — квитанции нечего подтверждать');
  }
  if (artifact !== null && text(receipt.artifactSha256) !== sha256Hex(artifact)) {
    errors.push('review-receipt: review.json изменился после квитанции (sha256 не совпадает)');
  }
  return { ok: errors.length === 0, errors, receipt };
}
