#!/usr/bin/env node
/*
 * Задание 0376: отмена задания одной командой.
 *
 *   node tools/task-cancel.mjs --id <NNNN> [--repo <корень>] [--dry-run]
 *
 * Отмена делает две вещи: помечает запись задания в docs/tasks/REGISTRY.json
 * статусом cancelled (через register() из tools/task-register.mjs — формат
 * реестра не дублируется) и убирает артефакты ворот ЭТОГО задания из
 * docs/tasks/<NNNN>/.
 *
 * Убираются только известные артефакты прогонов (список ARTIFACTS): замок
 * критериев, журнал ворот с цепочкой, результаты красного и проверки с логами,
 * отчёт ревьюера с квитанцией, запись приёмки и артефакты аудита. Контракт
 * задания — task.md и criteria.json — остаётся: отмена не стирает историю
 * постановки. Неизвестные файлы каталога не трогаются.
 *
 * Отказы: задание не найдено — код 2; задание уже принято — код 1, принятое не
 * отменяется (его артефакты — доказательства); нет реестра — код 1 с путём.
 * --dry-run печатает план и ничего не меняет.
 *
 * Выход: 0 — задание отменено (или план показан), 1 — отказ, 2 — ошибка
 * аргументов или неизвестное задание.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO, REGISTRY_REL, readRegistry, register } from './task-register.mjs';

export { DEFAULT_REPO, REGISTRY_REL };

const HERE = path.dirname(fileURLToPath(import.meta.url));

/*
 * Артефакты ворот в каталоге задания. Порядок — порядок появления в прогонах.
 * task.md и criteria.json сюда не входят намеренно: контракт остаётся.
 */
export const ARTIFACTS = [
  'criteria.lock',
  'gates.jsonl',
  'gates.jsonl.tip',
  'red.json',
  'red.log',
  'verify.json',
  'verify.executor.json',
  'verify.log',
  'review.json',
  'review.receipt.json',
  'acceptance.json',
  'audit-evidence.json',
  'report.md',
  'report.json',
  'report.worker.json',
];

const USAGE = 'Usage: node tools/task-cancel.mjs --id <NNNN> [--repo <корень>] [--dry-run]';

function refusal(message, exitCode) {
  const err = new Error(message);
  err.exitCode = exitCode;
  return err;
}

function usageError(message) {
  return refusal(message, 2);
}

/* Разбор --ключ значение и --ключ=значение; --dry-run — флаг. */
export function parseArgs(argv) {
  const out = { _: [], dryRun: false };
  const takesValue = new Set(['id', 'repo']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--dry-run') { out.dryRun = true; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!takesValue.has(key)) throw usageError('неизвестный ключ --' + key);
      let value;
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw usageError('--' + key + ' требует значение');
        value = next;
        i += 1;
      }
      out[key] = value;
      continue;
    }
    out._.push(arg);
  }
  return out;
}

/* Остаётся ли каталог задания прямым потомком docs/tasks: иначе не удаляем. */
function assertTaskDir(repo, taskDir) {
  const root = path.resolve(repo, 'docs', 'tasks');
  const resolved = path.resolve(taskDir);
  if (path.dirname(resolved) !== root) {
    throw refusal('каталог задания вне docs/tasks: ' + resolved, 1);
  }
}

/*
 * План отмены: читает реестр и перечисляет артефакты задания. Ничего не пишет.
 * Возвращает { registryFile, entry, statusBefore, taskDir, toDelete, missing }.
 */
export function planCancel({ repo = DEFAULT_REPO, id } = {}) {
  const registryFile = path.join(repo, REGISTRY_REL);
  if (!fs.existsSync(registryFile)) {
    throw refusal('нет реестра: ' + registryFile, 1);
  }
  const doc = readRegistry(registryFile);
  const entry = doc.tasks.find((item) => String(item.id) === String(id));
  if (!entry) {
    throw refusal('задание ' + id + ' не найдено в реестре ' + registryFile, 2);
  }
  const statusBefore = typeof entry.status === 'string' && entry.status.trim() !== ''
    ? entry.status
    : 'open';
  if (statusBefore === 'accepted') {
    throw refusal('задание ' + id + ' уже принято: принятое не отменяется (артефакты — доказательства)', 1);
  }
  const taskDir = path.join(repo, 'docs', 'tasks', String(id));
  assertTaskDir(repo, taskDir);
  const toDelete = [];
  const missing = [];
  for (const rel of ARTIFACTS) {
    const file = path.join(taskDir, rel);
    let isFile = false;
    try { isFile = fs.statSync(file).isFile(); } catch { isFile = false; }
    if (isFile) toDelete.push({ rel, file });
    else missing.push(rel);
  }
  return { registryFile, entry, statusBefore, taskDir, toDelete, missing };
}

/*
 * Отмена: удаляет артефакты и затем пишет статус cancelled. Сначала файлы,
 * затем реестр: сбой записи реестра оставляет задание открытым, и повторный
 * запуск просто дочищает остатки. При --dry-run не меняется ничего.
 */
export function cancelTask({ repo = DEFAULT_REPO, id, dryRun = false } = {}) {
  const plan = planCancel({ repo, id });
  const deleted = [];
  if (!dryRun) {
    for (const item of plan.toDelete) {
      fs.rmSync(item.file, { force: true });
      deleted.push(item.rel);
    }
    const result = register({ repo, id: String(id), status: 'cancelled' });
    return { ...plan, deleted, statusAfter: result.entry.status, dryRun: false };
  }
  return { ...plan, deleted: [], statusAfter: 'cancelled', dryRun: true };
}

/* Таблица «задание — статус реестра — файлы» без внешних зависимостей. */
export function renderTable(rows) {
  const width = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
  return rows
    .map((row) => row.map((cell, column) => String(cell).padEnd(width[column])).join(' | ').trimEnd())
    .join(String.fromCharCode(10));
}

export function report(result) {
  const files = result.dryRun ? result.toDelete.map((item) => item.rel) : result.deleted;
  const status = result.dryRun
    ? result.statusBefore + ' → ' + result.statusAfter
    : result.statusAfter;
  const rows = [
    ['Задание', 'Статус реестра', result.dryRun ? 'Будет удалено' : 'Удалено'],
    [String(result.entry.id), status, files.length > 0 ? files.join(', ') : '—'],
  ];
  const lines = [];
  if (result.dryRun) lines.push('План --dry-run: изменения не вносятся');
  lines.push(renderTable(rows));
  const tail = result.dryRun
    ? 'task-cancel: ' + String(result.entry.id) + ' — план, файлов к удалению: ' + String(result.toDelete.length)
    : 'task-cancel: ' + String(result.entry.id) + ' — ' + result.statusAfter + ', удалено файлов: ' + String(result.deleted.length);
  lines.push(tail);
  return lines.join(String.fromCharCode(10));
}

const invokedAsScript = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  try {
    const argv = parseArgs(process.argv.slice(2));
    if (argv.help) {
      console.log(USAGE);
      process.exit(0);
    }
    if (argv._.length > 0) throw usageError('лишние аргументы: ' + argv._.join(' '));
    if (argv.id === undefined) throw usageError('нужен --id <NNNN>');
    const id = String(argv.id).trim();
    if (!/^\d{4}$/u.test(id)) {
      throw usageError('--id: ожидается четырёхзначный номер, получено ' + JSON.stringify(argv.id));
    }
    const repo = path.resolve(argv.repo || DEFAULT_REPO);
    const result = cancelTask({ repo, id, dryRun: Boolean(argv.dryRun) });
    console.log(report(result));
  } catch (err) {
    console.error('task-cancel: ' + (err && err.message ? err.message : String(err)));
    process.exit(err && err.exitCode ? err.exitCode : 1);
  }
}
