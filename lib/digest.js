/**
 * Дайджест входящих в живую сессию (задание 0104).
 *
 * Почему: письмо с заявкой пролежало 3,5 часа, пока заказчик сам не спросил
 * «а входящих нет?». Бейдж панели в чат не виден, а сессия узнаёт о заявке
 * только если её кто-то спросит. Дайджест закрывает ровно этот разрыв: одну
 * строку «требуют хода N» сессия получает сама.
 *
 * Правила, в порядке важности:
 *   1. При нуле — молчать и не трогать состояние: иначе после каждого ответа в
 *      чат приходит «0 требуют хода».
 *   2. Не спамить: тот же счёт в пределах троттлинга (5 минут) не доставляется,
 *      а рост — доставляется сразу: новая заявка важнее тишины.
 *   3. Состояние — в сторе корня (`digest.json`: `{ total, at }`), а не в
 *      репозитории: это наблюдение хоста, и git его пачкать не должен.
 *   4. Доставка — одна строка: сколько папок и заявок, видно из неё, а
 *      подробности читает `node tools/check-exchange.mjs`.
 *
 * Модуль не знает про DSH: счёт внимания приходит из lib/obligations.js,
 * доставка — инъекцией `send`, поэтому решения проверяются без хоста.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deliverToHandle } from './agent-message.js';
import { activityOf, pickLastActive } from './exchange-watch.js';
import { exchangeAttention } from './obligations.js';
import { storeDir } from './store.js';

/** Троттлинг по умолчанию: тот же счёт не чаще раза в 5 минут. */
export const DIGEST_THROTTLE_MS = 5 * 60 * 1000;

/** Файл состояния в сторе корня. */
export const DIGEST_FILE = 'digest.json';

/** Потолок строки дайджеста: сообщение в чат, а не отчёт. */
export const DIGEST_MAX_LENGTH = 300;

/** Команда, которой сессия читает подробности. */
export const DIGEST_CHECK_COMMAND = 'node tools/check-exchange.mjs';

/** Сколько ждём ответа службы доставки, прежде чем назвать это ошибкой. */
export const DIGEST_DELIVERY_TIMEOUT_MS = 15 * 1000;

/** Имя папки в строке: длинное имя обрезается, чтобы не съесть весь бюджет. */
const MAX_FOLDER_NAME = 40;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Неотрицательное целое или null: «3», 3 и 3.0 — одно и то же число. */
function countOf(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  return Math.max(0, Math.trunc(number));
}

/** Момент времени в epoch-ms: число, Date или ISO-строка; null — не время. */
function instantOf(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function rootOf(root) {
  const text = typeof root === 'string' && root.trim() ? root.trim() : process.cwd();
  return path.resolve(text);
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

/** Абсолютный путь состояния: `<store>/digest.json` корня. */
export function digestFile(root) {
  return path.join(storeDir(rootOf(root)), DIGEST_FILE);
}

/**
 * Счёт внимания в одну форму.
 *
 * Счётчик может прийти от `exchangeAttention` (folders с полем `attention`) или
 * от панели/теста (folders с `unread`); total/stale считаются числами, а имя
 * папки приводится к одной строке — перевод строки в дайджесте запрещён
 * контрактом, и он не должен просочиться из объявления структуры.
 *
 * @returns `{ total, stale, folders: [{ id, attention }] }`; total без числа —
 *   сумма папок, чтобы реализация не зависела от того, кто собрал внимание.
 */
export function normalizeAttention(input) {
  const source = isObject(input) ? input : {};
  const folders = [];
  for (const row of Array.isArray(source.folders) ? source.folders : []) {
    if (!isObject(row)) continue;
    const raw = row.id !== undefined ? row.id : (row.folderId !== undefined ? row.folderId : row.folder);
    const id = String(raw === undefined || raw === null ? '?' : raw)
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, MAX_FOLDER_NAME) || '?';
    const attention = countOf(row.attention !== undefined ? row.attention : row.unread) || 0;
    folders.push({ id, attention });
  }
  const declaredTotal = countOf(source.total);
  const total = declaredTotal === null
    ? folders.reduce((sum, row) => sum + row.attention, 0)
    : declaredTotal;
  return { total, stale: countOf(source.stale) || 0, folders };
}

/**
 * Доставлять ли дайджест сейчас.
 *
 * Контракт (D1): total > 0 и (состояния нет, ИЛИ счёт вырос, ИЛИ прошёл
 * троттлинг). Первое появление заявки — новость; рост — новость сразу; тот же
 * счёт — не новость, но раз в 5 минут напоминание уместно: сессия могла
 * закрыться и открыться, а заявка всё ещё ждёт хода.
 *
 * @param options.previous - прошлое состояние `{ total, at }` или null.
 * @param options.current - текущее внимание (`{ total, ... }`).
 * @param options.now - момент решения (Date, epoch-ms или ISO).
 * @param options.throttleMs - окно тишины для того же счёта, по умолчанию 5 минут.
 */
export function shouldDeliver(options = {}) {
  const input = isObject(options) ? options : {};
  const current = normalizeAttention(input.current);
  if (!(current.total > 0)) return false;
  const previous = isObject(input.previous) ? input.previous : null;
  if (!previous) return true;
  const previousTotal = countOf(previous.total);
  /* Состояние без числа — не состояние: считаем, что сессии ещё не говорили. */
  if (previousTotal === null) return true;
  if (current.total > previousTotal) return true;
  const throttle = Number.isFinite(input.throttleMs) && input.throttleMs >= 0
    ? input.throttleMs
    : DIGEST_THROTTLE_MS;
  const at = instantOf(previous.at);
  /* Время состояния нечитаемо — нечего вычитать, и тишина скрыла бы заявку. */
  if (at === null) return true;
  const now = instantOf(input.now);
  return (now === null ? Date.now() : now) - at >= throttle;
}

/**
 * Одна строка для сессии: «требуют хода N (папки: …)» и команда проверки.
 *
 * Просроченные (старше окна внимания) называются отдельно: они видны, но в
 * счётчик не входят, и путать их с «требуют хода» нельзя. Длина ограничена
 * 300 символами: лишние папки отбрасываются с многоточием, а хвост с командой
 * не режется никогда — иначе строка станет бесполезной.
 */
export function digestText(input = {}) {
  const attention = normalizeAttention(input);
  const head = 'требуют хода ' + attention.total;
  const tail = (attention.stale > 0 ? '; просрочено ' + attention.stale : '')
    + '; проверка: ' + DIGEST_CHECK_COMMAND;
  const entries = attention.folders
    .filter((row) => row.attention > 0)
    .map((row) => row.id + ' ' + row.attention);
  const open = ' (папки: ';
  const close = ')';
  /* Два символа резервируются под многоточие: усечение обязано быть названо. */
  const budget = DIGEST_MAX_LENGTH - head.length - tail.length - open.length - close.length - 2;
  let shown = '';
  let used = 0;
  for (const entry of entries) {
    const next = shown ? shown + ', ' + entry : entry;
    if (next.length > budget) break;
    shown = next;
    used += 1;
  }
  if (shown && used < entries.length && shown.length + 2 <= budget) shown += ' …';
  if (!shown && entries.length > 0) shown = '…';
  /* Заявки есть, а разбивки по папкам нет — «папки: —» честнее пропуска. */
  if (!shown && attention.total > 0) shown = '—';
  const text = head + (shown ? open + shown + close : '') + tail;
  /* Страховка: ни одна ветка не имеет права вернуть перевод строки или длинную строку. */
  const oneLine = text.replace(/[\r\n]+/gu, ' ');
  return oneLine.length > DIGEST_MAX_LENGTH ? oneLine.slice(0, DIGEST_MAX_LENGTH) : oneLine;
}

/**
 * Прошлое состояние из стора корня.
 *
 * Битая или отсутствующая запись — это «сессии ещё не говорили»: молча
 * возвращать null честнее, чем падать на собственном файле состояния.
 */
export function readDigestState(root) {
  const file = digestFile(root);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!isObject(parsed)) return null;
    const total = countOf(parsed.total);
    if (total === null) return null;
    return { total, at: instantOf(parsed.at) };
  } catch {
    return null;
  }
}

/**
 * Записать состояние `{ total, at }`.
 *
 * Через временный брат и rename: читатель не должен увидеть половину JSON.
 * Если rename не удался (антивирус/лок Windows, уже случалось в 0101), пишем
 * напрямую — состояние переживёт это, а потерять доставку хуже.
 */
export function writeDigestState(root, state) {
  const file = digestFile(root);
  const current = isObject(state) ? state : {};
  const body = JSON.stringify({
    total: countOf(current.total) === null ? 0 : countOf(current.total),
    at: instantOf(current.at) === null ? Date.now() : instantOf(current.at),
  }) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, body, 'utf8');
    fs.renameSync(temporary, file);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* исходная ошибка важнее */ }
    fs.writeFileSync(file, body, 'utf8');
  }
  return file;
}

/**
 * Дайджест входящих: посчитать внимание, сравнить с прошлым, сказать сессии.
 *
 * Порядок важен: состояние пишется только после того, как сессия получила
 * строку. Упавшая доставка не съедает новость — следующий тик попробует снова,
 * а дедуп продолжит работать от прошлого состояния.
 *
 * @param options.runtime - граф-рантайм хоста (внимание считается по корню).
 * @param options.root - корень проекта; по нему же находится стор.
 * @param options.attention - готовое внимание (тесты и панель); без него
 *   считается `exchangeAttention` этого корня.
 * @param options.send - `async (text) => ({ sent: false, reason }?)`: доставка в
 *   живую сессию. Возврат `{ sent: false }` — «доставить некому»: состояние не
 *   двигается, новость не теряется, а вход в журнал решает вызывающий.
 * @param options.now - точка отсчёта (Date, epoch-ms или ISO).
 * @returns `{ delivered, text, reason?, error? }`.
 */
export async function deliverExchangeDigest(options = {}) {
  const input = isObject(options) ? options : {};
  const root = rootOf(input.root);
  const at = instantOf(input.now) === null ? Date.now() : instantOf(input.now);
  let attention;
  if (input.attention !== undefined && input.attention !== null) {
    attention = normalizeAttention(input.attention);
  } else {
    try {
      attention = normalizeAttention(exchangeAttention({ root, now: at }));
    } catch (error) {
      return { delivered: false, text: '', error: errorText(error) };
    }
  }
  const text = digestText(attention);
  /* D2: при нуле молчим и НЕ трогаем состояние — иначе после каждого ответа «0». */
  if (!(attention.total > 0)) return { delivered: false, text: '' };
  const previous = readDigestState(root) || saidAt.get(root) || null;
  const throttleMs = Number.isFinite(input.throttleMs) && input.throttleMs >= 0
    ? input.throttleMs
    : DIGEST_THROTTLE_MS;
  if (!shouldDeliver({ previous, current: attention, now: at, throttleMs })) {
    return { delivered: false, text };
  }
  if (typeof input.send !== 'function') return { delivered: false, text, reason: 'no-send' };
  const outcome = await input.send(text);
  if (isObject(outcome) && outcome.sent === false) {
    return {
      delivered: false,
      text,
      reason: typeof outcome.reason === 'string' && outcome.reason ? outcome.reason : 'not-sent',
      ...(Array.isArray(outcome.reasons) ? { reasons: outcome.reasons } : {}),
    };
  }
  /* Сказанное запоминаем до записи: сбой стора не должен превращаться в поток повторов. */
  const state = { total: attention.total, at };
  saidAt.set(root, state);
  try {
    writeDigestState(root, state);
  } catch (error) {
    return { delivered: true, text, error: 'состояние не записано: ' + errorText(error) };
  }
  return { delivered: true, text };
}

/**
 * Что этот процесс уже сказал по корню: страховка на случай недоступного стора.
 *
 * Файл состояния — главный источник, но запись может не удаться (стор на диске
 * только для чтения). Без памяти троттлинг держался бы только файлом, и сессия
 * получала бы ту же строку каждый тик; память ограничивает поток и переживает
 * сбой записи, а после перезапуска хоста честно начинается заново.
 */
const saidAt = new Map();

/** Свежесть сессий корня по журналу; ошибка чтения — «сессий не видно». */
function sessionsOf(root, options = {}) {
  try {
    return activityOf(root, {
      ...(typeof options.sessionsDir === 'string' && options.sessionsDir.trim()
        ? { sessionsDir: options.sessionsDir }
        : {}),
      ...(Number.isFinite(options.now) ? { now: options.now } : {}),
    });
  } catch {
    return new Map();
  }
}

/** Живой агент корня, если служба агентов его отдаёт. */
function liveHandleOf(input, root, sessions, now) {
  let list = [];
  try {
    const service = typeof input.getAgents === 'function' ? input.getAgents() : null;
    const rows = Array.isArray(service)
      ? service
      : (service && typeof service.roots === 'function'
        ? service.roots()
        : (service && typeof service.list === 'function' ? service.list() : []));
    list = Array.isArray(rows) ? rows : [];
  } catch {
    list = [];
  }
  if (list.length === 0) return null;
  const pick = pickLastActive(list, root, sessions, { now });
  return pick && pick.agent ? pick.agent : null;
}

/** Ответ после `ms` с читаемой причиной: зависшая доставка не держит тик. */
function withTimeout(promise, ms, what) {
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(what + ': нет ответа за ' + Math.round(ms / 1000) + ' с')), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    guard,
  ]);
}

/**
 * Доставить строку в живую сессию корня (проводка задания 0104).
 *
 * Два пути, в этом порядке:
 *   1. `sessionController.prompt` с mode 'queue' — первый партийный мост DSH:
 *      он оживляет собственную сессию корня (если она холодная) и кладёт строку
 *      реальным сообщением пользователя. Без спавна и без двойника.
 *   2. Запасной путь — живая сессия через `deliverToHandle` (followup → send
 *      next-turn → sendMessage; задание 0262), когда контроллера нет или сессия
 *      занята маршрутизацией субагентов (её прямой prompt отклоняется).
 *
 * Отсутствие сессии — не ошибка: `{ sent: false, reason: 'no-session' }`.
 * Ошибка доставки возвращается с причинами, а журнал пишет вызывающий.
 */
export async function sendDigestToSession(options = {}) {
  const input = isObject(options) ? options : {};
  const text = String(input.text === undefined || input.text === null ? '' : input.text);
  if (!text.trim()) return { sent: false, reason: 'empty' };
  const root = rootOf(input.root);
  const now = instantOf(input.now) === null ? Date.now() : instantOf(input.now);
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? input.timeoutMs
    : DIGEST_DELIVERY_TIMEOUT_MS;
  const sessions = input.sessions instanceof Map ? input.sessions : sessionsOf(root, {
    sessionsDir: input.sessionsDir,
    now,
  });
  const refused = [];
  const controller = typeof input.getSessionController === 'function'
    ? (() => {
      try { return input.getSessionController(); } catch { return null; }
    })()
    : null;
  /*
   * Свежесть — по журналу: свежайшая сессия корня и есть та, что видит человек.
   * Не одна, а три: сессию под маршрутизацией субагентов прямой prompt
   * отклоняет, а следующая по свежести обычно и есть сессия оператора.
   */
  const candidates = [...sessions.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => id)
    .slice(0, 3);
  if (controller && typeof controller.prompt === 'function' && candidates.length > 0) {
    /* Идентификатор повторной доставки той же строки: queue-путь дедуплицирует сам. */
    const requestId = 'digest:' + path.basename(root) + ':'
      + crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
    for (const sessionId of candidates) {
      try {
        const bridge = typeof AbortController === 'function' ? new AbortController() : null;
        await withTimeout(
          controller.prompt(
            { sessionId, content: [{ type: 'text', text }], mode: 'queue', requestId },
            bridge ? bridge.signal : undefined,
          ),
          timeoutMs,
          'дайджест в сессию «' + sessionId + '»',
        );
        return { sent: true, via: 'session', sessionId };
      } catch (error) {
        const why = errorText(error);
        refused.push(sessionId + ': ' + why);
        /* Только отказ по владению заслуживает следующего кандидата. */
        if (!/owned by subagent/iu.test(why)) break;
      }
    }
  }
  const handle = liveHandleOf(input, root, sessions, now);
  if (handle) {
    /*
     * 0262: живой агент принимает объект DSH-сообщения (send(message, target, wakeup),
     * followup или sendMessage), а не { text }: прежний вызов падал на state[target].length,
     * и дайджест молчал. Таймаут тот же — через options.wrap.
     */
    const attempt = await deliverToHandle(handle, text, {
      wrap: (promise, what) => withTimeout(promise, timeoutMs, what),
    });
    if (attempt.ok) {
      return {
        sent: true,
        via: 'agent',
        sessionId: String(handle.sessionId || handle.session || handle.id || ''),
      };
    }
    refused.push('живая сессия: '
      + (attempt.errors.length > 0 ? attempt.errors.join(' | ') : 'нет подходящего способа'));
  }
  if (refused.length > 0) return { sent: false, reason: 'refused', reasons: refused };
  return { sent: false, reason: 'no-session' };
}
