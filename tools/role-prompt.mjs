#!/usr/bin/env node
/**
 * tools/role-prompt.mjs — промпт роли одной командой (задание 0369).
 *
 *   node tools/role-prompt.mjs --role worker [--task <каталог>] [--json]
 *
 * Печатает готовый промпт в stdout и ничего не пишет на диск. --task подставляет
 * каталог задания абсолютным путём; без него в промпте пометка, что каталог
 * передаёт координатор. --json отдаёт объект: роль, название, назначение,
 * порядок действий, границы, форма отчёта, каталог задания и готовый промпт.
 *
 * Коды выхода: 0 — промпт напечатан, 2 — ошибка аргументов (неизвестная роль,
 * пустое значение, лишний флаг).
 */
import path from 'node:path';
import { rolePrompt, roleNames, roleSpec } from '../lib/prompts.js';

const USAGE = [
  'usage: node tools/role-prompt.mjs --role <роль> [--task <каталог>] [--json]',
  '',
  '  --role <роль>     роль: ' + roleNames().join(', '),
  '  --task <каталог>   каталог задания; подставляется в промпт абсолютным путём',
  '  --json             объект вместо текста: role, title, purpose, order, bounds, report, task, prompt',
  '  --help, -h         эта справка',
  '',
  'Печатает только промпт: файлы не пишет, проверки не запускает.',
  'Коды выхода: 0 — промпт напечатан, 2 — ошибка аргументов.',
].join('\n');

function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

/** Разбор аргументов: только известные флаги, значение у --role и --task не пустое. */
function parseArgs(argv) {
  const parsed = { role: null, task: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--role' || arg === '--task') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw usageError('флаг ' + arg + ' требует значение');
      }
      if (arg === '--role') parsed.role = value;
      else parsed.task = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--role=')) {
      parsed.role = arg.slice('--role='.length);
      continue;
    }
    if (arg.startsWith('--task=')) {
      parsed.task = arg.slice('--task='.length);
      continue;
    }
    throw usageError('неизвестный аргумент: ' + arg);
  }
  if (!parsed.help && (parsed.role === null || parsed.role.trim() === '')) {
    throw usageError('нужен --role <роль>: ' + roleNames().join(', '));
  }
  if (parsed.task !== null && parsed.task.trim() === '') {
    throw usageError('пустой --task');
  }
  return parsed;
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write('role-prompt: ' + error.message + '\n');
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const task = parsed.task === null ? null : path.resolve(process.cwd(), parsed.task);
  let prompt;
  let spec;
  try {
    prompt = rolePrompt(parsed.role, { task });
    spec = roleSpec(parsed.role);
  } catch (error) {
    process.stderr.write('role-prompt: ' + error.message + '\n');
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  if (parsed.json) {
    const payload = {
      role: spec.role,
      title: spec.title,
      purpose: spec.purpose,
      order: spec.order,
      bounds: spec.bounds,
      report: spec.report,
      task,
      prompt,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(prompt);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
