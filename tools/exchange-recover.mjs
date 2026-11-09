#!/usr/bin/env node
/**
 * Аудит и восстановление памяти вручений (задание 0153, D3).
 *
 * «Прочитано» значит «вручено». Историческая отметка seen без вручения (ветка
 * box-only: доставка выключена или живой сессии нет) скрывала письмо из
 * непрочитанных — так ws-school-app не увидел два своих письма. Команда находит
 * такие отметки, показывает причину и (по --apply) снимает их, оставляя запись
 * в журнале аудита.
 *
 *   node tools/exchange-recover.mjs --store <каталог> --dry-run
 *   node tools/exchange-recover.mjs --store <каталог> --apply
 *
 * --store <каталог>  хранилище сторожа: exchange-seen.json + exchange-decisions.jsonl
 * --seen <файл>      прямой путь к памяти вручений (сильнее --store)
 * --decisions <файл> прямой путь к журналу решений (сильнее --store)
 * --dry-run          показать найденное и ничего не писать (режим по умолчанию)
 * --apply            снять ложные отметки и дописать журнал аудита
 * --json             машинный вывод вместо строк
 * --help, -h         эта справка
 *
 * Письмо с ответом/ack не переотправляется: оно показывается как закрытое —
 * сторож такие письма и не будит, снятие отметки не делает их заданием.
 *
 * Коды выхода: 0 — работа сделана, 1 — память вручений не переписана,
 * 2 — ошибка аргументов или нет файлов для аудита.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseHeader } from '../lib/exchange.js';
import { readDecisionRows, recoverFalseSeen, waitingReasonText } from '../lib/exchange-watch.js';

const USAGE = [
  'usage: node tools/exchange-recover.mjs (--store <каталог> | --seen <файл> --decisions <файл>)',
  '                                      [--dry-run | --apply] [--json]',
  '',
  '  --store <каталог>  хранилище сторожа: exchange-seen.json и exchange-decisions.jsonl',
  '  --seen <файл>      прямой путь к памяти вручений; сильнее --store',
  '  --decisions <файл> прямой путь к журналу решений; сильнее --store',
  '  --dry-run          показать найденное, ничего не писать (по умолчанию)',
  '  --apply            снять ложные отметки и дописать журнал аудита',
  '  --json             машинный вывод',
  '  --help, -h         эта справка',
  '',
  'Ложная отметка — seen без решения delivered/rescan:delivered. Письмо с ответом',
  'или ack показывается закрытым: переотправка ему не нужна.',
].join('\n');

const CLOSED_STATUSES = new Set(['answer', 'ack', 'answered', 'agreed', 'rejected', 'declined']);

/** Разбор аргументов: неизвестный флаг — отказ с кодом 2, а не молчаливый пропуск. */
function parseArgs(argv) {
  const options = { store: '', seen: '', decisions: '', dryRun: true, apply: false, json: false, help: false };
  const modes = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--dry-run') { modes.push('dry-run'); continue; }
    if (arg === '--apply') { modes.push('apply'); continue; }
    if (arg === '--json') { options.json = true; continue; }
    const take = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { error: 'у ' + name + ' нет значения' };
      if (!value.trim()) return { error: 'у ' + name + ' пустое значение' };
      return { value };
    };
    if (arg === '--store' || arg === '--seen' || arg === '--decisions') {
      const taken = take(arg);
      if (taken.error) return { error: taken.error };
      options[arg.slice(2)] = taken.value;
      index += 1;
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals !== -1 && /^--(store|seen|decisions)=/u.test(arg)) {
      const key = arg.slice(2, equals);
      const value = arg.slice(equals + 1);
      if (!value.trim()) return { error: 'у --' + key + ' пустое значение' };
      options[key] = value;
      continue;
    }
    return { error: 'неизвестный аргумент: ' + arg };
  }
  if (new Set(modes).size > 1) return { error: '--dry-run и --apply взаимоисключающие' };
  options.apply = modes.includes('apply');
  options.dryRun = !options.apply;
  return options;
}

/** Статус письма по шапке: по нему видно, закрыто ли письмо и нужна ли переотправка. */
function statusOf(file) {
  try {
    const parsed = parseHeader(fs.readFileSync(file, 'utf8'));
    return parsed ? String(parsed.status || '').trim().toLowerCase() : '';
  } catch {
    return '';
  }
}



function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) {
    console.error('exchange-recover: ' + options.error);
    console.error(USAGE);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const store = options.store ? path.resolve(options.store) : '';
  const seenFile = options.seen
    ? path.resolve(options.seen)
    : (store ? path.join(store, 'exchange-seen.json') : '');
  const journalFile = options.decisions
    ? path.resolve(options.decisions)
    : (store ? path.join(store, 'exchange-decisions.jsonl') : '');
  if (!seenFile) {
    console.error('exchange-recover: нужен --store <каталог> или --seen <файл>');
    console.error(USAGE);
    process.exit(2);
  }
  if (!fs.existsSync(seenFile)) {
    console.error('exchange-recover: нет памяти вручений: ' + seenFile);
    process.exit(2);
  }
  if (!journalFile || !fs.existsSync(journalFile)) {
    /*
     * Без журнала нельзя доказать, что отметка ложная: любая seen стала бы
     * «ложной», и команда снесла бы память всех вручений. Это отказ, а не догадка.
     */
    console.error('exchange-recover: нет журнала решений: ' + (journalFile || '(не задан)'));
    console.error('Что сделать: укажите --decisions <файл> или --store с журналом сторожа.');
    process.exit(2);
  }
  const decisions = readDecisionRows(journalFile);
  const result = recoverFalseSeen({ seenPath: seenFile, decisions, dryRun: options.dryRun });
  const closed = [];
  const redeliver = [];
  for (const file of result.falseSeen) {
    const status = statusOf(file);
    const row = { path: file, status, branch: result.reasons[file] || '' };
    if (CLOSED_STATUSES.has(status)) closed.push(row);
    else redeliver.push(row);
  }
  if (options.json) {
    console.log(JSON.stringify({
      store: store || null,
      seen: seenFile,
      decisions: journalFile,
      decisionsRows: decisions.length,
      dryRun: result.dryRun,
      falseSeen: result.falseSeen,
      kept: result.kept,
      reasons: result.reasons,
      closed,
      redeliver,
      applied: result.applied,
      log: options.dryRun ? null : path.join(path.dirname(seenFile), 'exchange-recover.jsonl'),
    }, null, 2));
  } else {
    console.log('память вручений: ' + seenFile);
    console.log('журнал решений: ' + journalFile + ' (' + decisions.length + ' строк)');
    console.log('ложных отметок: ' + result.falseSeen.length);
    for (const row of redeliver) {
      console.log('  ' + row.path + ' — ждёт вручения (' + waitingReasonText(row.branch) + ')');
    }
    for (const row of closed) {
      console.log('  ' + row.path + ' — закрыто (' + (row.status || 'статус не записан')
        + '), переотправка не нужна');
    }
    console.log('оставлено отметок вручения: ' + result.kept.length);
  }
  if (options.dryRun) {
    if (!options.json) console.log('режим: dry-run — файл не изменён');
    process.exit(0);
  }
  if (!result.applied && result.falseSeen.length > 0) {
    console.error('exchange-recover: память вручений не переписана: ' + seenFile);
    process.exit(1);
  }
  const logFile = path.join(path.dirname(seenFile), 'exchange-recover.jsonl');
  try {
    fs.appendFileSync(logFile, JSON.stringify({
      at: new Date().toISOString(),
      mode: 'apply',
      seen: seenFile,
      decisions: journalFile,
      falseSeen: result.falseSeen,
      kept: result.kept,
      closed: closed.map((row) => row.path),
      redeliver: redeliver.map((row) => row.path),
      applied: result.applied,
    }) + '\n', 'utf8');
  } catch (error) {
    console.error('exchange-recover: журнал аудита не записан: ' + logFile
      + ' (' + (error && error.message ? error.message : error) + ')');
    process.exit(1);
  }
  if (!options.json) {
    console.log('снято отметок: ' + result.falseSeen.length + ', записано: ' + seenFile);
    console.log('журнал аудита: ' + logFile);
  }
  process.exit(0);
}

main();
