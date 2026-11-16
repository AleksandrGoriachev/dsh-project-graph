#!/usr/bin/env node
/**
 * Команда «дошло ли письмо» (задание 0099).
 *
 * Аудит reach-proxy (--19 п.3): на вопрос «дошло ли письмо N» не было штатного
 * ответа, и вторая сторона тратила полчаса на разбор журнала. Здесь ответ в одну
 * строку: время, адресат и сессия вручения — или причина, по которой письмо в
 * сессию не ушло (skip:no-wake, skip:delivery-off, skip:cooldown, stale:backlog,
 * gate:*, error:*).
 *
 *   node tools/check-delivery.mjs --root <проект> --letter <подстрока>
 *   node tools/check-delivery.mjs --journal <файл>  --letter <подстрока>
 *
 * --root <проект>    корень проекта; журнал ищется в хранилище проекта
 *                    ($PG_RUNS_DIR, иначе ~/.dsh/project-graph/runs)
 * --journal <файл>   прямой путь к журналу решений (exchange-decisions.jsonl);
 *                    сильнее --root
 * --letter <строка>  фильтр по полю letter (подстрока, без учёта регистра)
 * --help, -h         эта справка
 *
 * Коды выхода: 0 — запись найдена, 1 — записей нет, 2 — ошибка аргументов.
 * В репозиторий ничего не пишется: команда только читает журнал.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE = [
  'usage: node tools/check-delivery.mjs (--root <проект> | --journal <файл>) [--letter <подстрока>]',
  '',
  '  --root <проект>    корень проекта; журнал решений берётся из хранилища проекта',
  '                     ($PG_RUNS_DIR, иначе ~/.dsh/project-graph/runs/exchange-decisions.jsonl)',
  '  --journal <файл>   прямой путь к журналу решений; сильнее --root',
  '  --letter <строка>  фильтр по полю letter (подстрока, без учёта регистра)',
  '  --help, -h         эта справка',
  '',
  'Ответ в одну строку:',
  '  доставлено <at> · адресат <to> · сессия <session>   — ветка delivered/rescan:delivered',
  '  не доставлено: <branch> · <to>                     — любая другая ветка, с причиной',
  '  нет записей по «<letter>»                          — письма в журнале нет',
  '',
  'Коды выхода: 0 — запись найдена, 1 — записей нет, 2 — ошибка аргументов.',
].join('\n');

/** Каталог журнала решений: та же переменная и то же место, что у сторожа обмена. */
function journalDir() {
  const envDir = String(process.env.PG_RUNS_DIR || '').trim();
  if (envDir) return path.resolve(envDir);
  return path.join(os.homedir(), '.dsh', 'project-graph', 'runs');
}

/** Разбор аргументов: неизвестный флаг — отказ с кодом 2, а не молчаливый пропуск. */
function parseArgs(argv) {
  const options = { root: '', journal: '', letter: '', help: false };
  const take = (name, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { error: 'у ' + name + ' нет значения' };
    return { value };
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--root' || arg === '--journal' || arg === '--letter') {
      const taken = take(arg, index);
      if (taken.error) return { error: taken.error };
      const key = arg.slice(2);
      if (!taken.value.trim()) return { error: 'у ' + arg + ' пустое значение' };
      options[key] = taken.value;
      index += 1;
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals !== -1 && /^--(root|journal|letter)=/u.test(arg)) {
      const key = arg.slice(2, equals);
      const value = arg.slice(equals + 1);
      if (!value.trim()) return { error: 'у --' + key + ' пустое значение' };
      options[key] = value;
      continue;
    }
    return { error: 'неизвестный аргумент: ' + arg };
  }
  return options;
}

/** Строки журнала: одна JSON-строка — одно решение; порванная строка не прячет остальные. */
function readJournal(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { rows: [], found: false };
  }
  const rows = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      /* порванная строка дописываемого журнала — не повод не отвечать по целым */
    }
  }
  return { rows, found: true };
}

/** Ответ по последней записи: доставлено с временем и сессией, иначе причина. */
function answerFor(row) {
  const branch = String(row.branch || '').trim();
  const to = String(row.to || '').trim() || '—';
  if (branch === 'delivered' || branch === 'rescan:delivered') {
    const at = String(row.at || row.deliveredAt || '').trim() || '—';
    const session = String(row.session || '').trim() || 'сессия не записана';
    return 'доставлено ' + at + ' · адресат ' + to + ' · сессия ' + session;
  }
  return 'не доставлено: ' + (branch || 'ветка не записана') + ' · ' + to;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) {
    console.error('check-delivery: ' + options.error);
    console.error(USAGE);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!options.journal && !options.root) {
    console.error('check-delivery: нужен --root <проект> или --journal <файл>');
    console.error(USAGE);
    process.exit(2);
  }
  let journal = '';
  if (options.journal) {
    journal = path.resolve(options.journal);
  } else {
    const root = path.resolve(options.root);
    let stat = null;
    try {
      stat = fs.statSync(root);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) {
      console.error('check-delivery: корень не найден: ' + root);
      process.exit(2);
    }
    journal = path.join(journalDir(), 'exchange-decisions.jsonl');
  }
  const { rows } = readJournal(journal);
  const needle = String(options.letter || '').trim().toLowerCase();
  const matching = rows.filter((row) => !needle
    || String(row.letter || '').toLowerCase().includes(needle));
  if (matching.length === 0) {
    console.log(needle ? 'нет записей по «' + options.letter.trim() + '»' : 'нет записей в журнале');
    process.exit(1);
  }
  /* Последняя запись: журнал только дописывается, поэтому порядок строк — порядок времени. */
  console.log(answerFor(matching[matching.length - 1]));
  process.exit(0);
}

main();
