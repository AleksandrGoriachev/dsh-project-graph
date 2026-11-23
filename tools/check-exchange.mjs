#!/usr/bin/env node
/**
 * Сканер обмена (задание 0077; причина ожидания — задание 0153).
 *
 * Отвечает на один вопрос: какие письма этому воркспейсу ещё не разобраны.
 * Источник — объявление структуры (folders[].box) и отметки прочитанного в
 * хранилище проекта (DSH_PROJECT_GRAPH_STORE), то есть тот же учёт, что у панели.
 *
 *   node tools/check-exchange.mjs [--root <путь>] [--journal <файл>] [--mark [<путь>]] [--gate]
 *   node tools/check-exchange.mjs --box <каталог> --me <имя> [--turn]
 *
 * --root <путь>     корень проекта; по умолчанию текущий каталог.
 *                   Печатает «непрочитано» (адресовано и не отмечено прочитанным),
 *                   «требуют хода» (request/question без ответа по Reply-To или Ref)
 *                   и «ошибка формата» (Ref называет несуществующее письмо —
 *                   заявка им не закрыта); закрытие у обоих счётов одно (0164).
 * --journal <файл>  журнал решений сторожа; по умолчанию берётся из его хранилища
 *                   ($PG_RUNS_DIR, иначе ~/.dsh/project-graph/runs).
 * --mark <путь>     отметить ОДНО письмо «разобрал» и выйти 0: соседние письма и
 *                   открытые заявки не трогаются (задание 0280).
 * --mark            без пути — прежняя пакетная отметка всех найденных писем.
 * --gate            проверить объявленные обязанности и отказать кодом 3, если
 *                   обязанность с enforce: fail не выполнена (задание 0280).
 * --box <каталог>   режим общей доски (задание 0327): прочитать каталог как ящик
 *                   без структуры и без DSH_PROJECT_GRAPH_STORE. Сканируется
 *                   <каталог>/threads рекурсивно, иначе сам каталог. Входящими
 *                   считаются только Status: request|question, To == --me (без
 *                   регистра) и From != --me. Печатает «непрочитано: N» и пути;
 *                   код 1 при N > 0, 0 при N == 0.
 * --me <имя>        чьё имя считать адресатом в режиме --box; только вместе с --box.
 * --turn            с --box/--me: считать ОТКРЫТЫЕ заявки, а не непрочитанное
 *                   (задание 0328). Открытая заявка — Status request|question,
 *                   To == --me (без регистра), From != --me, для которой нет
 *                   answer|ack, чей Reply-To или Ref разрешается в это письмо.
 *                   Сканируется тот же ящик, структура и store не нужны. Печатает
 *                   «открытых заявок: N» и пути; код 1 при N > 0, 0 при N == 0.
 *
 * Задание 0153: письмо, которое сторож оставил в ящике (доставка выключена, живой
 * сессии нет), — pending, а не прочитанное. Такое письмо показывается в
 * непрочитанных с причиной, а числовая отметка «доставлено» без решения delivered
 * считается ложной и возвращает письмо в непрочитанные. Отметка-хеш (sha256) —
 * человеческое «разобрал» — остаётся в силе.
 *
 * Задание 0164: рядом с «непрочитано» печатается «требуют хода» — тот же набор,
 * по которому считает панель: answer/ack закрывает заявку, если назвал её в
 * Reply-To ИЛИ в Ref. Два счёта отвечают на разные вопросы (прочитано ли письмо
 * и закрыта ли заявка), но закрытие у них одно, поэтому расхождение видно: у
 * каждой заявки сказано, лежит ли она ещё и в непрочитанных. Неразрешённый Ref
 * печатается словами («ошибка формата»), а не прячется: заявка не закрыта.
 *
 * Коды выхода: 0 — непрочитанных нет (или всё отмечено), 1 — есть непрочитанные,
 * 2 — сканер не смог прочитать обмен (нет структуры, битое объявление),
 * 3 — --gate: обязанность с enforce: fail не выполнена (задание 0280).
 * В репозиторий ничего не пишется: отметки живут в хранилище, вне проекта.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKIP_REASONS, SEEN_FILE, evaluateObligations, exchangeAttention, markExchangeSeen, readDeclaredStructure, scanExchange } from '../lib/obligations.js';
import { recipeOf } from '../lib/obligations-gate.js';
import { letterStates, messageFiles, readDecisionRows, stateOfLetter, waitingReasonText } from '../lib/exchange-watch.js';
import { parseHeader } from '../lib/exchange.js';
import { storeDir } from '../lib/store.js';

const USAGE = [
  'usage: node tools/check-exchange.mjs [--root <путь>] [--journal <файл>] [--mark [<путь>]] [--gate]',
  '       node tools/check-exchange.mjs --box <каталог> --me <имя> [--turn]',
  '',
  '  --root <путь>     корень проекта (по умолчанию текущий каталог)',
  '  --journal <файл>  журнал решений сторожа (exchange-decisions.jsonl)',
  '  --mark <путь>     отметить одно письмо «разобрал» и выйти с кодом 0',
  '  --mark            без пути: отметить все найденные письма (пакетом)',
  '  --gate            отказ кодом 3, если обязанность enforce: fail не выполнена',
  '  --box <каталог>   общая доска: <каталог>/threads рекурсивно (иначе сам каталог)',
  '  --me <имя>        адресат в режиме --box; только вместе с --box',
  '  --turn            с --box/--me: открытые заявки, а не непрочитанное',
  '',
  'Режим --box не читает структуру и не требует DSH_PROJECT_GRAPH_STORE:',
  'входящие — только Status: request|question, To == --me (без регистра), From != --me.',
  '',
  'Режим --turn (вместе с --box и --me) считает ОТКРЫТЫЕ заявки: Status request|question,',
  'To == --me, From != --me, если нет answer|ack, чей Reply-To или Ref разрешается',
  'в это письмо. Адрес: абсолютный путь, путь от <каталог>, путь от каталога письма',
  'или голое имя в каталоге письма; Ref может перечислять несколько адресов через',
  'запятую или точку с запятой. Печатается «открытых заявок: N» и пути.',
  '',
  'Хранилище отметок задаётся переменной DSH_PROJECT_GRAPH_STORE;',
  'без неё отметки лежат в ~/.dsh/project-graph/<проект>-<хеш>/exchange-seen.json.',
  'Память вручений сторожа — отдельный файл exchange-delivered.json (задание 0280):',
  'доставленное письмо не считается прочитанным.',
  'Журнал решений берётся из хранилища сторожа: $PG_RUNS_DIR или',
  '~/.dsh/project-graph/runs/exchange-decisions.jsonl.',
].join('\n');

/**
 * Разбор аргументов: неизвестный флаг — отказ, а не молчаливый пропуск.
 *
 * `--mark <путь>` — точечная отметка ОДНОГО письма (задание 0280): следующий за
 * флагом аргумент, если он не начинается с «--», считается путём письма.
 * `--gate` — проверка объявленных обязанностей с кодом выхода 3 при отказе.
 */
function parseArgs(argv) {
  const options = { root: process.cwd(), journal: '', mark: false, markPath: '', gate: false, box: '', me: '', turn: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mark') {
      options.mark = true;
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        options.markPath = next;
        index += 1;
      }
      continue;
    }
    if (arg === '--gate') { options.gate = true; continue; }
    if (arg === '--turn') { options.turn = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    const take = (name) => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { error: 'у ' + name + ' нет пути' };
      return { value };
    };
    if (arg === '--root' || arg === '--journal' || arg === '--box' || arg === '--me') {
      const taken = take(arg);
      if (taken.error) return { error: taken.error };
      options[arg.slice(2)] = taken.value;
      index += 1;
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals !== -1 && /^--(root|journal|mark|box|me)=/u.test(arg)) {
      const key = arg.slice(2, equals);
      const value = arg.slice(equals + 1);
      if (!value.trim()) return { error: 'у --' + key + ' пустой путь' };
      if (key === 'mark') {
        options.mark = true;
        options.markPath = value;
      } else {
        options[key] = value;
      }
      continue;
    }
    return { error: 'неизвестный аргумент: ' + arg };
  }
  /*
   * Задание 0327: --box/--me — пара. Один флаг не отвечает на вопрос «чей
   * ящик», поэтому это ошибка с рецептом, а не догадка о стороне.
   */
  const hasBox = Boolean(String(options.box).trim());
  const hasMe = Boolean(String(options.me).trim());
  /*
   * Задание 0328: --turn — второй вопрос к тому же ящику (открыта ли заявка), а не
   * другой ящик. Без --box/--me неизвестно, чей ящик считать, а --mark/--gate —
   * режимы записи и структуры: с --turn они не совмещаются.
   */
  if (options.turn && (options.mark || options.gate)) {
    return {
      error: '--turn — режим только для чтения: --mark и --gate с ним не выполняются',
      fix: 'проверка: node tools/check-exchange.mjs --box <каталог> --me <имя> --turn',
    };
  }
  if (options.turn && !(hasBox && hasMe)) {
    return {
      error: '--turn требует --box и --me: по одному флагу неясно, чей ящик считать',
      fix: 'node tools/check-exchange.mjs --box <каталог> --me <имя> --turn',
    };
  }
  if (hasBox !== hasMe) {
    return {
      error: '--box и --me задаются только вместе: по одному флагу неясно, чей ящик считать',
      fix: 'node tools/check-exchange.mjs --box <каталог> --me <имя>',
    };
  }
  /* Режим доски — только чтение (задание 0327): отметка и гейт живут в старом режиме. */
  if (hasBox && (options.mark || options.gate)) {
    return {
      error: '--box — режим только для чтения: --mark и --gate с ним не выполняются',
      fix: 'проверка: node tools/check-exchange.mjs --box <каталог> --me <имя>; отметка/гейт — без --box',
    };
  }
  /*
   * Задание 0280 (A11): отметка и гейт — разные вопросы. Молча проигнорировать
   * отметку нельзя: человек решил бы, что письмо разобрано, а оно не отмечено.
   */
  if (options.mark && options.gate) {
    return { error: '--mark и --gate вместе не выполняются: выберите один режим' };
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

/** sha256 байтов письма — ключ дедупликации и отмены копий (задание 0322). */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
    let content;
    try {
      content = fs.readFileSync(file);
    } catch {
      continue;
    }
    const text = content.toString('utf8');
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
      sha256: sha256(content),
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

/**
 * «Требуют хода» и ошибки формата словами (задание 0164).
 *
 * Печатается тот же набор, по которому считает панель: заявка закрыта, если
 * answer/ack назвал её в Reply-To ИЛИ в Ref. Поэтому у каждой заявки прямо
 * сказано, лежит ли она ещё и в непрочитанных: два счёта отвечают на разные
 * вопросы («письмо прочитано?» и «заявка закрыта?»), но закрытие у них одно, и
 * расхождение больше не молчит.
 *
 * @param attention - ответ exchangeAttention.
 * @param unreadKeys - ключи путей непрочитанных (уже собранных выше).
 * @returns строки для печати; пустой список ошибок печатается как «ошибка формата: 0».
 */
function attentionLines(attention, unreadKeys) {
  const errors = Array.isArray(attention && attention.formatErrors) ? attention.formatErrors : [];
  const lines = [];
  lines.push('ошибка формата: ' + errors.length
    + (errors.length > 0 ? ' (Ref называет письмо, которого нет — заявка не закрыта)' : ''));
  for (const row of errors) {
    const field = row && row.field ? row.field : 'Ref';
    const ref = row && row.ref ? row.ref : '';
    const reason = row && row.reason ? row.reason : 'значение не разрешается в существующее письмо';
    lines.push('  ' + (row && row.letter ? row.letter : '?') + ' — поле ' + field + ' «' + ref + '»: ' + reason);
  }
  const total = Number(attention && attention.total) || 0;
  if (total === 0) {
    lines.push('требуют хода: 0');
    return lines;
  }
  lines.push('требуют хода: ' + total);
  for (const item of Array.isArray(attention.items) ? attention.items : []) {
    const seen = unreadKeys.has(pathKey(item && item.path ? item.path : ''));
    const where = seen ? '  [непрочитано]' : '  [прочитано, заявка не закрыта]';
    const why = item && item.formatError ? '  ' + item.formatError : '';
    lines.push('  ' + (item && item.date ? item.date : '(без даты)') + '  ' + (item && item.path ? item.path : '?') + where + why);
  }
  return lines;
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

/**
 * Режим --gate (задание 0280, инвариант 3).
 *
 * Вопрос у гейта один: можно ли начинать работу. Ответ — код выхода: 0, когда
 * закрыто всё, и 3, когда объявленная обязанность с enforce: fail не выполнена
 * (её ok: false). Напечатаны и обязанность, и что сделать; «требуют хода» без
 * объявленной обязанности — это наблюдение, а не отказ: код гейта от него не
 * зависит.
 *
 * Рецепт берётся из lib/obligations-gate.js — тот же текст получает модель,
 * когда гейт структуры предупреждает или отклоняет запуск узла. Двух разных
 * советов «что делать» быть не должно.
 *
 * Задание 0280 (A6): ошибка чтения объявленной структуры — fail-closed. Гейт,
 * который не смог прочитать декларацию, НЕ отвечает «открыт»: он отказывает
 * кодом 2 с причиной и рецептом. Прежнее поведение (пустая карта объявлений →
 * enforce=warn → 0) было тихим разрешением при сломанном объявлении.
 */
function gateMode(root) {
  let declared;
  try {
    declared = readDeclaredStructure({ root });
  } catch (error) {
    console.error('check-exchange: структура не прочитана — гейт закрыт: '
      + (error && error.message ? error.message : String(error)));
    return 2;
  }
  if (!declared.ok) {
    console.error('check-exchange: структура не прочитана — гейт закрыт: ' + declared.message);
    if (declared.fix) console.error('Что сделать: ' + declared.fix);
    return 2;
  }
  let status;
  try {
    status = evaluateObligations({ root });
  } catch (error) {
    console.error('check-exchange: обязанности не вычислены — гейт закрыт: '
      + (error && error.message ? error.message : String(error)));
    return 2;
  }
  if (status.error) {
    console.error('check-exchange: обязанности не вычислены — гейт закрыт: ' + status.error.error);
    if (status.error.fix) console.error('Что сделать: ' + status.error.fix);
    return 2;
  }
  const duties = new Map();
  for (const duty of declared.obligations) duties.set(duty.id, duty);
  const failing = [];
  for (const row of Array.isArray(status.obligations) ? status.obligations : []) {
    const duty = duties.get(row.id) || {};
    const enforce = typeof duty.enforce === 'string' && duty.enforce.trim() ? duty.enforce.trim() : 'warn';
    const kind = duty.check && typeof duty.check.kind === 'string' ? duty.check.kind : '';
    const command = duty.check && typeof duty.check.run === 'string' ? duty.check.run : '';
    if (row.ok === true) {
      console.log('обязанность ' + row.id + ': выполнена — ' + row.detail);
      continue;
    }
    console.log('обязанность ' + row.id + ' (' + (row.title || row.id) + ') не выполнена: ' + row.detail);
    if (enforce === 'fail') failing.push({ row, duty: { kind, command } });
    else console.log('  режим warn — запуск не блокируется.');
  }
  if (failing.length === 0) {
    console.log('итог: гейт открыт, обязанностей с отказом нет');
    return 0;
  }
  for (const item of failing) {
    console.log('Что сделать: ' + recipeOf(item.duty));
  }
  console.log('итог: гейт закрыт (' + failing.map((item) => item.row.id).join(', ') + ')');
  return 3;
}

/** Статусы, которые в режиме доски требуют хода (задание 0327). */
const BOX_INCOMING_STATUSES = new Set(['request', 'question']);

/**
 * Файлы писем в режиме доски: <dir>/threads рекурсивно, иначе сам каталог.
 *
 * Это ровно правило сканера структуры (lib/obligations.js, scanExchange), но без
 * объявления папок и хранилища: --box называет доску напрямую (задание 0327).
 */
function boxFiles(dir) {
  const threads = path.join(dir, 'threads');
  let scan = dir;
  try {
    if (fs.statSync(threads).isDirectory()) scan = threads;
  } catch {
    scan = dir;
  }
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && /\.md$/iu.test(entry.name)) found.push(full);
    }
  };
  walk(scan);
  return found.sort((left, right) => left.localeCompare(right));
}

/**
 * Поля шапки, нужные доске: From, To, Status.
 *
 * Date не требуется: режим --box отвечает на вопрос «кому адресовано и просит ли
 * хода», а не «является ли письмо фактом обмена». Отсутствие From/To оставляет
 * письмо вне счёта — сторону нельзя угадать (задание 0327, сканеры читают To).
 */
function boxHeader(text) {
  const fields = {};
  for (const line of String(text || '').split(/\r?\n/u)) {
    if (line.trim() === '' && Object.keys(fields).length > 0) break;
    const match = /^([A-Za-z][A-Za-z-]*):\s*(.+?)\s*$/u.exec(line);
    if (match) fields[match[1].toLowerCase()] = match[2];
  }
  return {
    from: fields.from || '',
    to: fields.to || '',
    status: String(fields.status || '').trim().toLowerCase(),
    /* Задание 0328: адреса закрытия заявки; обычный режим --box их не читает. */
    replyTo: fields['reply-to'] || '',
    ref: fields.ref || '',
  };
}

/**
 * Режим --box/--me (задание 0327): ящик как общая доска без структуры и store.
 *
 * Входящее — только Status: request|question, To == me (без регистра) и
 * From != me (своя служебная копия в общей доске не адресована нам). Пути
 * печатаются все, чтобы счёт нельзя было прочитать без адреса. Код выхода —
 * ответ для гейта: 1 при N > 0, 0 при N == 0, 2 при нечитаемом каталоге.
 */
function boxMode(options) {
  const dir = path.resolve(String(options.box));
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    console.error('check-exchange: каталог ящика не найден: ' + dir);
    return 2;
  }
  const me = String(options.me).trim().toLowerCase();
  const incoming = [];
  for (const file of boxFiles(dir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const header = boxHeader(text);
    if (!header.from || !header.to) continue;
    if (header.from.toLowerCase() === me) continue;
    if (header.to.toLowerCase() !== me) continue;
    if (!BOX_INCOMING_STATUSES.has(header.status)) continue;
    incoming.push(path.resolve(file));
  }
  console.log('непрочитано: ' + incoming.length);
  for (const file of incoming) console.log('  ' + file);
  return incoming.length > 0 ? 1 : 0;
}

/** Статусы, которые закрывают заявку в режиме --turn (задание 0328). */
const TURN_CLOSING_STATUSES = new Set(['answer', 'ack']);

/**
 * Элементы Ref в режиме --turn (задание 0328).
 *
 * Поле может перечислять несколько адресов — через запятую ИЛИ точку с запятой:
 * старое письмо несёт ';', живое — ','. Один адрес как один путь: пустые
 * элементы и повторы отбрасываются, иначе лишний разделитель стал бы адресом.
 */
function turnRefElements(value) {
  const list = [];
  const seen = new Set();
  for (const part of String(value || '').split(/[;,]/u)) {
    const element = part.trim();
    if (!element || seen.has(element)) continue;
    seen.add(element);
    list.push(element);
  }
  return list;
}

/** Существующий файл по кандидату: «разрешено в файл» и «файла нет» — разные ответы. */
function turnCandidateFile(candidate) {
  try {
    if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
  } catch {
    /* кандидата нет — пробуется следующий */
  }
  return '';
}

/**
 * Адрес Reply-To/Ref в режиме --turn (задание 0328).
 *
 * Разрешение ровно как у панели, но без структуры: абсолютный путь — как есть;
 * голое имя без разделителей — только каталог САМОГО письма (иначе чужое имя
 * закрыло бы заявку); путь с разделителями — от каталога ящика, затем от
 * каталога письма. Возвращается существующий файл либо пустая строка.
 */
function turnResolveAddress(value, boxPath, letterPath) {
  const text = String(value || '').trim();
  if (!text) return '';
  const candidates = [];
  if (path.isAbsolute(text)) {
    candidates.push(text);
  } else if (!text.includes('/') && !text.includes('\\')) {
    candidates.push(path.join(path.dirname(letterPath), text));
  } else {
    candidates.push(path.resolve(boxPath, text));
    const fromLetter = path.resolve(path.dirname(letterPath), text);
    if (pathKey(fromLetter) !== pathKey(candidates[0])) candidates.push(fromLetter);
  }
  for (const candidate of candidates) {
    const found = turnCandidateFile(candidate);
    if (found) return found;
  }
  return '';
}

/**
 * Режим --box/--me/--turn (задание 0328): открытые заявки без структуры и store.
 *
 * Открытая заявка — Status request|question, To == me (без регистра),
 * From != me, для которой в ящике нет answer|ack, чей Reply-To или Ref
 * разрешается в это самое письмо. Это не «непрочитано»: ответ закрывает
 * заявку, даже если само письмо не отмечено прочитанным.
 *
 * Сканирование то же, что у --box: <каталог>/threads рекурсивно, иначе сам
 * каталог. Код выхода — ответ для гейта: 1 при N > 0, 0 при N == 0, 2 при
 * нечитаемом каталоге.
 */
function boxTurnMode(options) {
  const dir = path.resolve(String(options.box));
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    console.error('check-exchange: каталог ящика не найден: ' + dir);
    return 2;
  }
  const me = String(options.me).trim().toLowerCase();
  const letters = [];
  for (const file of boxFiles(dir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const header = boxHeader(text);
    if (!header.from || !header.to) continue;
    letters.push({ path: path.resolve(file), ...header });
  }
  /*
   * Закрытие собирается по ВСЕМ письмам ящика: ответ и квитанция могут лежать
   * в другой ветке или в корне доски, но адресуют заявку через Reply-To/Ref.
   */
  const answered = new Set();
  for (const letter of letters) {
    if (!TURN_CLOSING_STATUSES.has(letter.status)) continue;
    const byReplyTo = turnResolveAddress(letter.replyTo, dir, letter.path);
    if (byReplyTo) answered.add(pathKey(byReplyTo));
    for (const element of turnRefElements(letter.ref)) {
      const byRef = turnResolveAddress(element, dir, letter.path);
      if (byRef) answered.add(pathKey(byRef));
    }
  }
  const open = [];
  for (const letter of letters) {
    if (!BOX_INCOMING_STATUSES.has(letter.status)) continue;
    if (letter.from.toLowerCase() === me) continue;
    if (letter.to.toLowerCase() !== me) continue;
    if (answered.has(pathKey(letter.path))) continue;
    open.push(letter.path);
  }
  console.log('открытых заявок: ' + open.length);
  for (const file of open) console.log('  ' + file);
  return open.length > 0 ? 1 : 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) {
    console.error('check-exchange: ' + options.error);
    if (options.fix) console.error('Что сделать: ' + options.fix);
    console.error(USAGE);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  /* Задание 0327/0328: доска проверяется до структуры и хранилища — они ей не нужны. */
  if (options.box) process.exit(options.turn ? boxTurnMode(options) : boxMode(options));
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
  if (options.gate) process.exit(gateMode(root));
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
  /*
   * Восстановленные строки дедуплицируются по sha256 (задание 0322): копия,
   * уже показанная непрочитанной в другом ящике, не считается второй раз.
   */
  const knownHashes = new Set(unread
    .map((row) => (typeof row.sha256 === 'string' ? row.sha256 : ''))
    .filter((digest) => digest));
  const recovered = [];
  if (states.size > 0) {
    const seenRows = seenRowsOf(root);
    for (const box of scan.boxes) {
      if (!box.path || box.error) continue;
      for (const row of recoveredLetters(box, seenRows, states)) {
        const key = pathKey(row.path);
        if (known.has(key)) continue;
        const digest = typeof row.sha256 === 'string' ? row.sha256 : '';
        if (digest && knownHashes.has(digest)) continue;
        known.add(key);
        if (digest) knownHashes.add(digest);
        recovered.push(row);
      }
    }
  }
  unread.push(...recovered);
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
   * Задание 0164: «требуют хода» и ошибки формата — из того же набора закрытия,
   * что у панели (answer/ack по Reply-To ИЛИ Ref). Печатаются до отметки, чтобы
   * --mark не мог «разобрать» письмо, о формате которого не сказано ни слова.
   */
  const attention = exchangeAttention({ root });
  for (const line of attentionLines(attention, known)) console.log(line);
  if (options.mark) {
    /*
     * Отметка — последней: человек просил «разобрать», и повторный запуск без
     * --mark уже не должен находить те же письма. Отметка — хеш, поэтому
     * восстановление ложных отметок её не отменяет. Отчёт печатается до неё:
     * что именно разобрано, видно, а не угадывается по числу.
     */
    const batch = !options.markPath;
    const result = markExchangeSeen({
      root,
      path: options.markPath || undefined,
      paths: batch ? unread.map((row) => row.path) : [],
    });
    console.log('отмечено: ' + result.marked);
    if (!batch && result.marked !== 1) {
      console.error('check-exchange: письмо не отмечено: ' + options.markPath);
      process.exit(2);
    }
    if (batch) {
      console.log('итог: непрочитано ' + Math.max(0, unread.length - result.marked)
        + ', ' + skippedText(scan) + ', ящиков ' + scan.boxes.length);
    } else {
      console.log('итог: отмечено одно письмо, соседние письма и открытые заявки не тронуты');
    }
    process.exit(0);
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
    + ', ' + skippedText(scan) + ', ящиков ' + scan.boxes.length
    + ', требуют хода ' + (Number(attention.total) || 0)
    + ', ошибок формата ' + (Array.isArray(attention.formatErrors) ? attention.formatErrors.length : 0));
  process.exit(unread.length > 0 ? 1 : 0);
}

main();
