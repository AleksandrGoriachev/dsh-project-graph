#!/usr/bin/env node
/*
 * Задание 0183 (C2): следующий свободный номер задачи.
 *
 * Номер выдаёт система, а не память агента. Занятыми считаются:
 *  - каталоги docs/tasks/<NNNN>/ (включая docs/tasks/archive/<NNNN>/),
 *  - все записи реестра docs/tasks/REGISTRY.json.
 * Печатается ровно одна строка — четырёхзначный номер, больший всех занятых.
 *
 *   node tools/task-next-id.mjs [--repo <корень>]
 *
 * Выход: 0 — номер напечатан, 1 — реестр/каталоги не читаются или номера кончились,
 * 2 — ошибка аргументов.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO = path.resolve(HERE, '..');
export const REGISTRY_REL = path.join('docs', 'tasks', 'REGISTRY.json');
export const ID_WIDTH = 4;
export const MAX_ID = 10 ** ID_WIDTH - 1;

function usageError(message) {
  const err = new Error(message);
  err.exitCode = 2;
  return err;
}

/* Разбор --ключ значение и --ключ=значение; позиционных аргументов у инструмента нет. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (key !== 'repo') throw usageError('неизвестный ключ --' + key);
      if (eq !== -1) out.repo = arg.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw usageError('--repo требует значение');
        out.repo = next;
        i += 1;
      }
      continue;
    }
    out._.push(arg);
  }
  return out;
}

function readRegistryIds(repo, ids) {
  const file = path.join(repo, REGISTRY_REL);
  if (!fs.existsSync(file)) return;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(doc) ? doc : (doc && (doc.tasks || doc.entries));
  if (!Array.isArray(list)) throw new Error('docs/tasks/REGISTRY.json: ожидается { version, tasks: [...] }');
  for (const item of list) {
    const id = String(item && item.id !== undefined ? item.id : '');
    if (/^\d{4}$/u.test(id)) ids.add(id);
  }
}

/* Все занятые четырёхзначные номера: каталоги заданий и реестр. */
export function occupiedIds(repo = DEFAULT_REPO) {
  const ids = new Set();
  const tasksRoot = path.join(repo, 'docs', 'tasks');
  const scan = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d{4}$/u.test(entry.name)) ids.add(entry.name);
    }
  };
  scan(tasksRoot);
  scan(path.join(tasksRoot, 'archive'));
  readRegistryIds(repo, ids);
  return ids;
}

/* Следующий свободный номер, дополненный нулями до четырёх знаков. */
export function nextTaskId(repo = DEFAULT_REPO) {
  const ids = occupiedIds(repo);
  let max = 0;
  for (const id of ids) max = Math.max(max, Number(id));
  if (max >= MAX_ID) throw new Error('свободных четырёхзначных номеров нет: занято до ' + max);
  return String(max + 1).padStart(ID_WIDTH, '0');
}

const invokedAsScript = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  try {
    const argv = parseArgs(process.argv.slice(2));
    if (argv.help) {
      console.log('Usage: node tools/task-next-id.mjs [--repo <корень>]');
      process.exit(0);
    }
    if (argv._.length > 0) throw usageError('лишние аргументы: ' + argv._.join(' '));
    const repo = path.resolve(argv.repo || DEFAULT_REPO);
    process.stdout.write(nextTaskId(repo) + String.fromCharCode(10));
  } catch (err) {
    console.error('task-next-id: ' + (err && err.message ? err.message : String(err)));
    process.exit(err && err.exitCode ? err.exitCode : 1);
  }
}
