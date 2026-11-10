#!/usr/bin/env node
/*
 * Задание 0183 (C3): внести или обновить запись о номере задачи.
 *
 * Реестр docs/tasks/REGISTRY.json — единственное место, где живёт номер.
 * Инструмент добавляет запись { id, subject, status, at? } или обновляет
 * предмет/статус уже выданного номера:
 *
 *   node tools/task-register.mjs --id <NNNN> [--subject <текст>] [--status open|accepted|cancelled]
 *                                [--at ISO] [--repo <корень>]
 *
 * Новая запись получает status "open" (приёмки ещё нет; --status задаёт иной) и
 * at — момент регистрации (или явно переданный --at). При создании --subject
 * обязателен. У существующей записи меняются только переданные поля: subject,
 * status и at, которых нет в аргументах, сохраняются. Записи хранятся по номеру.
 *
 * Выход: 0 — запись внесена/обновлена, 1 — реестр не читается/не пишется,
 * 2 — ошибка аргументов.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO = path.resolve(HERE, '..');
export const REGISTRY_REL = path.join('docs', 'tasks', 'REGISTRY.json');

function usageError(message) {
  const err = new Error(message);
  err.exitCode = 2;
  return err;
}

/* Разбор --ключ значение и --ключ=значение. */
export function parseArgs(argv) {
  const out = { _: [] };
  const takesValue = new Set(['id', 'subject', 'status', 'at', 'repo']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
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

/* Чтение реестра: отсутствующий файл — пустой реестр, битый — ошибка, а не перезапись. */
export function readRegistry(file) {
  if (!fs.existsSync(file)) return { version: 1, tasks: [] };
  const raw = fs.readFileSync(file, 'utf8');
  let doc;
  try { doc = JSON.parse(raw); }
  catch (err) { throw new Error('реестр не читается как JSON: ' + file + ' — ' + err.message); }
  const tasks = Array.isArray(doc) ? doc : (doc && (doc.tasks || doc.entries));
  if (!Array.isArray(tasks)) throw new Error('реестр неверной формы: ожидается { version, tasks: [...] } (' + file + ')');
  for (const entry of tasks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('реестр содержит запись без объекта: ' + JSON.stringify(entry));
    }
    if (String(entry.id === undefined ? '' : entry.id) === '') {
      throw new Error('реестр содержит запись без id: ' + JSON.stringify(entry));
    }
  }
  return { version: 1, tasks };
}

function idOrder(a, b) {
  const left = /^\d+$/u.test(String(a.id)) ? Number(a.id) : Number.MAX_SAFE_INTEGER;
  const right = /^\d+$/u.test(String(b.id)) ? Number(b.id) : Number.MAX_SAFE_INTEGER;
  if (left !== right) return left - right;
  return String(a.id).localeCompare(String(b.id));
}

/** Статусы записи реестра: номер выдан, принят или снят. */
export const STATUSES = ['open', 'accepted', 'cancelled'];

/* Добавить или обновить запись; возвращает { created, entry }. */
export function register({ repo = DEFAULT_REPO, id, subject, at, status, now = new Date() } = {}) {
  const file = path.join(repo, REGISTRY_REL);
  const doc = readRegistry(file);
  const index = doc.tasks.findIndex((entry) => String(entry.id) === String(id));
  const created = index === -1;
  const hasSubject = typeof subject === 'string' && subject !== '';
  const hasStatus = status !== undefined;
  /* Новая запись — это выдача номера: без предмета она не имеет смысла. */
  if (created && !hasSubject) {
    throw usageError('новая запись требует --subject: без предмета номер не выдаётся');
  }
  if (hasStatus && !STATUSES.includes(status)) {
    throw usageError('--status: допустимы ' + STATUSES.join('|') + ', получено ' + JSON.stringify(status));
  }
  let entry;
  if (created) {
    entry = { id: String(id), subject, status: hasStatus ? status : 'open', at: typeof at === 'string' && at !== '' ? at : now.toISOString() };
    doc.tasks.push(entry);
  } else {
    entry = { ...doc.tasks[index] };
    if (hasSubject) entry.subject = subject;
    if (hasStatus) entry.status = status;
    else if (typeof entry.status !== 'string' || entry.status.trim() === '') entry.status = 'open';
    if (typeof at === 'string' && at !== '') entry.at = at;
    doc.tasks[index] = entry;
  }
  doc.tasks.sort(idOrder);
  const text = JSON.stringify({ version: 1, tasks: doc.tasks }, null, 2) + String.fromCharCode(10);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(16).slice(2, 8) + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    fs.writeFileSync(file, text, 'utf8');
  }
  return { created, entry, file };
}

const invokedAsScript = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  try {
    const argv = parseArgs(process.argv.slice(2));
    if (argv.help) {
      console.log('Usage: node tools/task-register.mjs --id <NNNN> [--subject <текст>] [--status open|accepted|cancelled] [--at ISO] [--repo <корень>]');
      process.exit(0);
    }
    if (argv._.length > 0) throw usageError('лишние аргументы: ' + argv._.join(' '));
    if (argv.id === undefined) throw usageError('нужен --id <NNNN>');
    const id = String(argv.id).trim();
    if (!/^\d{4}$/u.test(id)) throw usageError('--id: ожидается четырёхзначный номер, получено ' + JSON.stringify(argv.id));
    if (argv.subject === undefined && argv.status === undefined) {
      throw usageError('нужен --subject <текст> или --status open|accepted|cancelled');
    }
    let subject;
    if (argv.subject !== undefined) {
      subject = String(argv.subject).trim();
      if (subject === '') throw usageError('--subject пуст: предмет задачи обязателен');
      if (subject.includes(String.fromCharCode(10)) || subject.includes(String.fromCharCode(13))) {
        throw usageError('--subject: предмет — одна строка');
      }
    }
    let status;
    if (argv.status !== undefined) {
      status = String(argv.status).trim().toLowerCase();
      if (!STATUSES.includes(status)) {
        throw usageError('--status: допустимы open|accepted|cancelled, получено ' + JSON.stringify(argv.status));
      }
    }
    let at;
    if (argv.at !== undefined) {
      at = String(argv.at).trim();
      if (at === '' || Number.isNaN(Date.parse(at))) throw usageError('--at: ожидается дата ISO, получено ' + JSON.stringify(argv.at));
    }
    const repo = path.resolve(argv.repo || DEFAULT_REPO);
    const result = register({ repo, id, subject, at, status });
    console.log((result.created ? 'registered ' : 'updated ') + id + ': ' + result.entry.subject);
  } catch (err) {
    console.error('task-register: ' + (err && err.message ? err.message : String(err)));
    process.exit(err && err.exitCode ? err.exitCode : 1);
  }
}
