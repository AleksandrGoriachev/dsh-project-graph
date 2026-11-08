#!/usr/bin/env node
/**
 * Сканер обмена (задание 0077; причина ожидания — задание 0153).
 *
 * Отвечает на один вопрос: какие письма этому воркспейсу ещё не разобраны.
 * Источник — объявление структуры (folders[].box) и отметки прочитанного в
 * хранилище проекта (DSH_PROJECT_GRAPH_STORE), то есть тот же учёт, что у панели.
 *
 *   node tools/check-exchange.mjs [--root <путь>] [--journal <файл>] [--mark]
 *
 * --root <путь>     корень проекта; по умолчанию текущий каталог.
 * --journal <файл>  журнал решений сторожа; по умолчанию берётся из его хранилища
 *                   ($PG_RUNS_DIR, иначе ~/.dsh/project-graph/runs).
 * --mark            сначала отметить найденные письма прочитанными, потом выйти 0.
 *
 * Задание 0153: письмо, которое сторож оставил в ящике (доставка выключена, живой
 * сессии нет), — pending, а не прочитанное. Такое письмо показывается в
 * непрочитанных с причиной, а числовая отметка «доставлено» без решения delivered
 * считается ложной и возвращает письмо в непрочитанные. Отметка-хеш (sha256) —
 * человеческое «разобрал» — остаётся в силе.
 *
 * Коды выхода: 0 — непрочитанных нет (или всё отмечено), 1 — есть непрочитанные,
 * 2 — сканер не смог прочитать обмен (нет структуры, битое объявление).
 * В репозиторий ничего не пишется: отметки живут в хранилище, вне проекта.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKIP_REASONS, SEEN_FILE, markExchangeSeen, scanExchange } from '../lib/obligations.js';
import { letterStates, messageFiles, readDecisionRows, stateOfLetter, waitingReasonText } from '../lib/exchange-watch.js';
import { parseHeader } from '../lib/exchange.js';
import { storeDir } from '../lib/store.js';

const USAGE = [
  'usage: node tools/check-exchange.mjs [--root <путь>] [--journal <файл>] [--mark]',
  '',
  '  --root <путь>     корень проекта (по умолчанию текущий каталог)',
  '  --journal <файл>  журнал решений сторожа (exchange-decisions.jsonl)',
  '  --mark            отметить непрочитанные прочитанными и выйти с кодом 0',
  '',
  'Хранилище отметок задаётся переменной DSH_PROJECT_GRAPH_STORE;',
  'без неё отметки лежат в ~/.dsh/project-graph/<проект>-<хеш>/exchange-seen.json.',
  'Журнал решений берётся из хранилища сторожа: $PG_RUNS_DIR или',
  '~/.dsh/project-graph/runs/exchange-decisions.jsonl.',
].join('\n');

/** Разбор аргументов: неизвестный флаг — отказ, а не молчаливый пропуск. */
function parseArgs(argv) {
  const options = { root: process.cwd(), journal: '', mark: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mark') { options.mark = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    const take = (name) => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { error: 'у ' + name + ' нет пути' };
      return { value };
    };
    if (arg === '--root' || arg === '--journal') {
      const taken = take(arg);
      if (taken.error) return { error: taken.error };
      options[arg.slice(2)] = taken.value;
      index += 1;
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals !== -1 && /^--(root|journal)=/u.test(arg)) {
      const key = arg.slice(2, equals);
      const value = arg.slice(equals + 1);
      if (!value.trim()) return { error: 'у --' + key + ' пустой путь' };
      options[key] = value;
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

/** Тема письма: нужна строкой списка, а не разбором шапки ради одного поля. */
function subjectOf(text) {
  const match = /^Subject:\s*(.+?)\s*$/imu.exec(String(text || ''));
  return match ? match[1] : '';
}

/** Каталог журнала решений: та же переменная и то же место, что у сторожа. */
function journalDir() {
  const envDir = String(process.env.PG_RUNS_DIR || '').trim();
  if (envDir) return path.resolve(envDir);
  return path.join(os.homedir(), '.dsh', 'project-graph', 'runs');
}

/** Ключ пути: регистр важен только вне Windows. */
function pathKey(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Память прочитанного из хранилища проекта: её пишут обязанности и человек. */
function seenRowsOf(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(storeDir(root), SEEN_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Причина ожидания по журналу: пусто — вручено или записей по письму нет. */
function waitingReason(states, file) {
  const state = stateOfLetter(states, file);
  if (!state || state.delivered) return '';
  return state.waiting || '';
}

/**
 * Письма, которые числовая отметка скрывает как прочитанные, хотя вручения не было.
 *
 * Числовая отметка — память вручений сторожа (mtime); хеш — человеческое
 * «разобрал» (lib/obligations.js, isReadMarker). Ложная отметка возвращается в
 * непрочитанные и называет причину: ровно так ws-school-app потерял два письма.
 */
function recoveredLetters(box, seenRows, states) {
  const me = String(box.me || '').toLowerCase();
  const rows = [];
  const threads = path.join(box.path, 'threads');
  let scanDir = threads;
  try {
    if (!fs.statSync(threads).isDirectory()) scanDir = box.path;
  } catch {
    scanDir = box.path;
  }
  const markerOf = (file) => {
    if (Object.hasOwn(seenRows, file)) return seenRows[file];
    const key = Object.keys(seenRows).find((item) => pathKey(item) === pathKey(file));
    return key === undefined ? undefined : seenRows[key];
  };
  for (const item of messageFiles([scanDir])) {
    const file = item.file;
    /* Только числовая отметка сторожа: хеш — человеческое «разобрал», не трогаем. */
    if (typeof markerOf(file) !== 'number') continue;
    const state = stateOfLetter(states, file);
    if (!state || state.delivered) continue;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseHeader(text);
    if (!parsed) continue;
    const from = String(parsed.from || '');
    if (from && from.toLowerCase() === me) continue;
    if (String(parsed.to || '').toLowerCase() !== me) continue;
    rows.push({
      path: file,
      to: parsed.to,
      date: parsed.date,
      subject: subjectOf(text),
      status: parsed.status,
      from,
      replyTo: parsed.replyTo,
      reason: state.waiting || 'no-delivery-decision',
    });
  }
  return rows;
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

/** Ожидание по причинам: «skip:delivery-off 2, no-session 1» (задание 0153). */
function waitingText(rows) {
  const counts = new Map();
  let total = 0;
  for (const row of rows) {
    if (!row || !row.reason) continue;
    total += 1;
    counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
  }
  return { total, text: [...counts.entries()].map(([branch, count]) => branch + ' ' + count).join(', ') };
}

/** Одна строка письма: дата, от кого, тема, путь и — если ждёт — причина (0153). */
function letterLine(row) {
  const from = senderOf(row.path);
  const subject = row.subject ? ' «' + row.subject + '»' : '';
  const why = row.reason
    ? '  [ждёт вручения: ' + row.reason + ' — ' + waitingReasonText(row.reason) + ']'
    : '';
  return '  ' + (row.date || '(без даты)') + '  от ' + (from || '?') + subject + '  ' + row.path + why;
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
  /*
   * Причина ожидания берётся из журнала решений сторожа (задание 0153):
   * «непрочитано 0» при письме, которое ждёт вручения, — тот же дефект, что
   * исчезнувшие письма ws-school-app.
   */
  const journalFile = options.journal
    ? path.resolve(options.journal)
    : path.join(journalDir(), 'exchange-decisions.jsonl');
  const states = letterStates(readDecisionRows(journalFile));
  const unread = (Array.isArray(scan.unread) ? scan.unread : []).map((row) => ({
    ...row,
    reason: waitingReason(states, row.path),
  }));
  const known = new Set(unread.map((row) => pathKey(row.path)));
  const recovered = [];
  if (states.size > 0) {
    const seenRows = seenRowsOf(root);
    for (const box of scan.boxes) {
      if (!box.path || box.error) continue;
      for (const row of recoveredLetters(box, seenRows, states)) {
        const key = pathKey(row.path);
        if (known.has(key)) continue;
        known.add(key);
        recovered.push(row);
      }
    }
  }
  unread.push(...recovered);
  if (options.mark) {
    /*
     * Отметка идёт первой: человек просил «разобрать», и повторный запуск без
     * --mark уже не должен находить те же письма. Отметка — хеш, поэтому
     * восстановление ложных отметок её не отменяет.
     */
    const result = markExchangeSeen({ root, paths: unread.map((row) => row.path) });
    console.log('отмечено: ' + result.marked);
    console.log('итог: непрочитано ' + Math.max(0, unread.length - result.marked)
      + ', ' + skippedText(scan) + ', ящиков ' + scan.boxes.length);
    process.exit(0);
  }
  if (recovered.length > 0) {
    console.log('возвращено в непрочитанные: ' + recovered.length
      + ' (отметка «доставлено» без решения delivered)');
  }
  if (unread.length > 0) {
    console.log('непрочитано: ' + unread.length + ' (порог 0)');
    for (const row of unread) console.log(letterLine(row));
  } else {
    console.log('непрочитано: 0');
  }
  const waiting = waitingText(unread);
  if (waiting.total > 0) {
    console.log('ожидают вручения: ' + waiting.total + ' (' + waiting.text + ')');
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
  console.log('итог: непрочитано ' + unread.length + ', прочитано ' + scan.seen
    + ', ' + skippedText(scan) + ', ящиков ' + scan.boxes.length);
  process.exit(unread.length > 0 ? 1 : 0);
}

main();
