/**
 * Письмо в живую сессию DSH: форма сообщения и порядок доставки (задание 0262).
 *
 * Хост DSH 0.2.2 принимает `send(message, target, wakeup)`: message — объект с
 * уникальным `id`, `role`, `content: [{ type: 'text', text }]` и
 * `source: { kind: 'user' }`, а target — 'next-turn' или 'next-step'. Внутри
 * сообщение кладётся в inbox по имени target, поэтому старые формы (`{ text }`
 * одним аргументом) падают на `state[target].length` с TypeError про 'length',
 * а письмо остаётся невручённым.
 *
 * Модуль не знает про сундук обмена и транспорт: он только собирает сообщение и
 * перебирает способы вручения, которые предоставляет handle. Таймаут — снаружи,
 * через options.wrap, чтобы поведение по времени задавал вызывающий.
 */
import crypto from 'node:crypto';

/**
 * Сообщение пользователя для живой сессии: ровно та форма, которую читает хост.
 *
 * @param {unknown} text тело письма; null/undefined дают пустую строку.
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: 'user'}}}
 */
export function buildUserMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text === undefined || text === null ? '' : text) }],
    /*
     * Текст продублирован полем `text` намеренно: прежние читатели (журнал решений,
     * проверки 0081/0214) смотрят на `payload.text` и без него видят undefined.
     * Каноническая форма — `content`; `text` — совместимость, а не второй источник.
     */
    text: String(text === undefined || text === null ? '' : text),
    source: { kind: 'user' },
  };
}

/**
 * Текст письма таймкипера координатору (задание 0344).
 *
 * Ровно две фразы, по фазе активации: перед остановом — сколько минут
 * осталось, в момент начала — что останов включён. Вне окон (inside/idle)
 * письма нет: пустая строка означает «молчим», а не «письмо без текста».
 *
 * @param state - результат monitorStateAt: { state, period: { start, end }, minutesLeft }.
 * @returns строка письма или '' для фаз, о которых не уведомляют.
 */
export function timekeeperNotice(state) {
  if (!state || typeof state !== 'object') return '';
  const period = state.period && typeof state.period === 'object' ? state.period : {};
  const start = typeof period.start === 'string' ? period.start : '';
  const end = typeof period.end === 'string' ? period.end : '';
  if (!start || !end) return '';
  if (state.state === 'warn') {
    const minutes = Number.isFinite(state.minutesLeft) ? state.minutesLeft : 0;
    return 'останов с ' + start + ' до ' + end + ', осталось ' + minutes + ' минут';
  }
  if (state.state === 'start') return 'останов включён с ' + start + ' до ' + end;
  return '';
}

/** Текст отказа для журнала: сообщение ошибки важнее её типа. */
function errorText(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/**
 * Вручить письмо в живую сессию: followup → send(next-turn) → sendMessage.
 *
 * Первое сообщение одно на все попытки: повторная сборка дала бы новый id, и
 * дедупликация хоста перестала бы видеть одно и то же письмо.
 *
 * @param {object} handle живая сессия: followup/send/sendMessage — любые из них.
 * @param {unknown} text тело письма.
 * @param {{wrap?: (promise: Promise<unknown>, what: string) => Promise<unknown>}} [options]
 *   wrap — обёртка ожидания (таймаут) вокруг каждой попытки.
 * @returns {Promise<{ok: boolean, via: 'followup'|'send'|'sendMessage'|'', errors: string[]}>}
 */
export async function deliverToHandle(handle, text, options = {}) {
  const errors = [];
  if (!handle || typeof handle !== 'object') {
    return { ok: false, via: '', errors: ['нет живого агента'] };
  }
  const wrap = typeof options.wrap === 'function' ? options.wrap : null;
  const message = buildUserMessage(text);
  const attempts = [
    ['followup', () => handle.followup(message)],
    ['send', () => handle.send(message, 'next-turn', true)],
    ['sendMessage', () => handle.sendMessage(message)],
  ];
  for (const [via, call] of attempts) {
    if (typeof handle[via] !== 'function') continue;
    try {
      /* Синхронный бросок способа — такой же отказ: превращаем его в rejection до wrap. */
      const started = Promise.resolve().then(call);
      await (wrap ? wrap(started, 'вручение письма в живую сессию (' + via + ')') : started);
      return { ok: true, via, errors };
    } catch (error) {
      errors.push(via + ': ' + errorText(error));
    }
  }
  return { ok: false, via: '', errors };
}
