#!/usr/bin/env node
/**
 * Сканер обмена (задание 0077).
 *
 * Отвечает на один вопрос: какие письма этому воркспейсу ещё не разобраны.
 * Источник — объявление структуры (folders[].box) и отметки прочитанного в
 * хранилище проекта (DSH_PROJECT_GRAPH_STORE), то есть тот же учёт, что у панели.
 *
 *   node tools/check-exchange.mjs [--root <путь>] [--mark]
 *
 * --root <путь>  корень проекта; по умолчанию текущий каталог.
 * --mark         сначала отметить найденные письма прочитанными, потом выйти 0.
 *
 * Коды выхода: 0 — непрочитанных нет (или всё отмечено), 1 — есть непрочитанные,
 * 2 — сканер не смог прочитать обмен (нет структуры, битое объявление).
 * В репозиторий ничего не пишется: отметки живут в хранилище, вне проекта.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SKIP_REASONS, markExchangeSeen, scanExchange } from '../lib/obligations.js';
import { parseHeader } from '../lib/exchange.js';

const USAGE = [
  'usage: node tools/check-exchange.mjs [--root <путь>] [--mark]',
  '',
  '  --root <путь>  корень проекта (по умолчанию текущий каталог)',
  '  --mark         отметить непрочитанные прочитанными и выйти с кодом 0',
  '',
  'Хранилище отметок задаётся переменной DSH_PROJECT_GRAPH_STORE;',
  'без неё отметки лежат в ~/.dsh/project-graph/<проект>-<хеш>/exchange-seen.json.',
].join('\n');

/** Разбор аргументов: неизвестный флаг — отказ, а не молчаливый пропуск. */
function parseArgs(argv) {
  const options = { root: process.cwd(), mark: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mark') { options.mark = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { error: 'у --root нет пути' };
      options.root = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (!value.trim()) return { error: 'у --root пустой путь' };
      options.root = value;
      continue;
    }
    return { error: 'неизвестный аргумент: ' + arg };
  }
  return options;
}

/** Отправитель письма: шапка To/Date уже разобрана сканером, From читается здесь. */
function senderOf(file) {
  try {
    const parsed = parseHeader(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.from ? parsed.from : '';
  } catch {
    return '';
  }
}

/**
 * Разбивка пропущенных по причинам одной строкой (задание 0080):
 * «пропущено: 2 (not-addressee 1, service 1)». Нулевые причины не печатаются:
 * строка отвечает на вопрос «почему письмо пропущено», а не перечисляет словарь.
 */
function skippedText(scan) {
  const rows = Array.isArray(scan.skipped) ? scan.skipped : [];
  const counts = new Map();
  for (const row of rows) {
    if (!row || typeof row.reason !== 'string') continue;
    counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
  }
  const parts = [];
  for (const reason of SKIP_REASONS) {
    const count = counts.get(reason) || 0;
    if (count > 0) parts.push(reason + ' ' + count);
  }
  return 'пропущено: ' + rows.length + (parts.length > 0 ? ' (' + parts.join(', ') + ')' : '');
}

/** Одна строка письма: дата, от кого, тема, путь. */
function letterLine(row) {
  const from = senderOf(row.path);
  const subject = row.subject ? ' «' + row.subject + '»' : '';
  return '  ' + (row.date || '(без даты)') + '  от ' + (from || '?') + subject + '  ' + row.path;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) {
    console.error('check-exchange: ' + options.error);
    console.error(USAGE);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const root = path.resolve(options.root);
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    console.error('check-exchange: корень не найден: ' + root);
    process.exit(2);
  }
  const scan = scanExchange({ root });
  if (scan.error) {
    console.error('check-exchange: обмен не прочитан: ' + scan.error.error);
    if (scan.error.fix) console.error('Что сделать: ' + scan.error.fix);
    process.exit(2);
  }
  if (options.mark) {
    /*
     * Отметка идёт первой: человек просил «разобрать», и повторный запуск без
     * --mark уже не должен находить те же письма.
     */
    const result = markExchangeSeen({ root, paths: scan.unread.map((row) => row.path) });
    console.log('отмечено: ' + result.marked);
    console.log('итог: непрочитано ' + Math.max(0, scan.unread.length - result.marked)
      + ', ' + skippedText(scan) + ', ящиков ' + scan.boxes.length);
    process.exit(0);
  }
  if (scan.unread.length > 0) {
    console.log('непрочитано: ' + scan.unread.length + ' (порог 0)');
    for (const row of scan.unread) console.log(letterLine(row));
  } else {
    console.log('непрочитано: 0');
  }
  /*
   * Ошибки папок печатаются кодом резолвера lib/boxes.js и его кандидатами:
   * «ящик не найден» без причины заставлял искать её в структуре вручную.
   */
  for (const box of scan.boxes) {
    if (!box.error) continue;
    const code = box.code ? ' [' + box.code + ']' : '';
    console.log('ящик «' + box.id + '»:' + code + ' ' + box.error);
    if (Array.isArray(box.candidates) && box.candidates.length > 0) {
      console.log('  кандидаты: ' + box.candidates.join(', '));
    }
  }
  console.log('итог: непрочитано ' + scan.unread.length + ', прочитано ' + scan.seen
    + ', ' + skippedText(scan) + ', ящиков ' + scan.boxes.length);
  process.exit(scan.unread.length > 0 ? 1 : 0);
}

main();
