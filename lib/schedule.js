/**
 * Daily schedules: when a node runs next, and what the panel calls it.
 *
 * A node may declare `schedule: { at: "HH:MM", timeZone: "Europe/Moscow" }`.
 * The one rule that matters: a missed window is never caught up. "Next run"
 * means the next wall-clock occurrence strictly after `now`; if today's time has
 * already come or is coming right now, the answer is tomorrow.
 *
 * Nothing here touches the filesystem: the graph validator and HTTP reader
 * share these functions, and tests can pin them to a fixed `now`.
 */

/** Strict HH:MM, 24-hour: "9:00" and "24:00" are not schedule times. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/u;

/** How often the host asks whether a scheduled node is due. */
export const SCHEDULE_TICK_MS = 30_000;

/**
 * A run may start this long after its time (one tick late, plus slack for a
 * busy event loop). Anything later was a missed window and is skipped, not
 * replayed.
 */
export const SCHEDULE_GRACE_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const FORMATTERS = new Map();

function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/** Is this a time zone `Intl` knows? Empty and garbage are both refused. */
export function isValidTimeZone(timeZone) {
  const zone = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (!zone) return false;
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** Parse "HH:MM" into hour/minute, or null when the field is malformed. */
export function parseTimeOfDay(at) {
  const match = TIME_OF_DAY.exec(typeof at === 'string' ? at.trim() : '');
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Wall-clock parts of one instant in a time zone. */
function partsAt(timeZone, instant) {
  const values = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

/** Offset of a zone at an instant, in milliseconds (wall clock minus UTC). */
function offsetAt(timeZone, instant) {
  const parts = partsAt(timeZone, instant);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock time in a zone to an instant. Two passes settle the
 * offset across a DST change; a local time that does not exist (spring forward)
 * lands on the nearest representable instant instead of throwing.
 */
function zonedTimeToUtc(timeZone, year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = wall;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = wall - offsetAt(timeZone, new Date(instant));
    if (next === instant) break;
    instant = next;
  }
  /*
   * A local time skipped by spring-forward does not exist. Instead of landing
   * before the gap (01:30 for a 02:30 schedule), walk to the first representable
   * wall clock at or after the declared time — the run happens after the jump.
   */
  const actual = partsAt(timeZone, new Date(instant));
  if (actual.hour * 60 + actual.minute !== hour * 60 + minute) {
    const target = hour * 60 + minute;
    for (let step = 1; step <= 180; step += 1) {
      const probe = instant + step * 60_000;
      const local = partsAt(timeZone, new Date(probe));
      if (local.hour * 60 + local.minute >= target) return new Date(probe);
    }
  }
  return new Date(instant);
}

/** One day later in the calendar, regardless of DST. */
function nextCalendarDay(year, month, day, offset) {
  const value = new Date(Date.UTC(year, month - 1, day) + offset * DAY_MS);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

/**
 * The next time this schedule fires, strictly after `now`.
 *
 * @param schedule - `{ at: "HH:MM", timeZone }`.
 * @param now - reference instant, a Date (defaults to the current time).
 * @returns Date of the next run; today when it is still ahead, else tomorrow.
 *   A time that has already arrived counts as missed: no catch-up.
 */
export function nextRunAt(schedule, now = new Date()) {
  const zone = schedule && typeof schedule.timeZone === 'string' ? schedule.timeZone.trim() : '';
  const parsed = parseTimeOfDay(schedule && schedule.at);
  if (!parsed) {
    throw new TypeError('schedule.at должен быть временем HH:MM, например "09:00"');
  }
  if (!isValidTimeZone(zone)) {
    throw new TypeError('schedule.timeZone должен быть часовым поясом Intl, например "Europe/Moscow"');
  }
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new TypeError('nextRunAt: now должен быть корректной датой');

  const today = partsAt(zone, current);
  for (let offset = 0; offset <= 2; offset += 1) {
    const date = nextCalendarDay(today.year, today.month, today.day, offset);
    const candidate = zonedTimeToUtc(zone, date.year, date.month, date.day, parsed.hour, parsed.minute);
    if (candidate.getTime() > current.getTime()) return candidate;
  }
  /* Unreachable for a valid schedule; keep the return type honest. */
  const date = nextCalendarDay(today.year, today.month, today.day, 2);
  return zonedTimeToUtc(zone, date.year, date.month, date.day, parsed.hour, parsed.minute);
}

/* ------------------------------------------------------------------------- *
 * Монитор периодов останова таймкипера (задание 0344)
 * ------------------------------------------------------------------------- */

/**
 * Фазы активации таймкипера: предупреждение, начало останова, останов идёт и
 * простой. Список заморожен: это словарь, на который смотрит планировщик.
 */
export const MONITOR_PHASES = Object.freeze(['warn', 'start', 'inside', 'idle']);

/** Одна минута в миллисекундах: периоды заданы минутами суток. */
const MONITOR_MINUTE_MS = 60_000;

/**
 * Сколько секунд после start момент ещё считается началом останова.
 *
 * Тик планировщика — 30 с и может опоздать; окно допуска то же, что у
 * расписания (SCHEDULE_GRACE_MS), чтобы «ровно в 13:00» не терялось из-за
 * задержки будильника. Позже — это уже inside, и повторного письма нет.
 */
export const MONITOR_START_GRACE_MS = SCHEDULE_GRACE_MS;

/** День локальных часов, сдвинутый на offset суток (месяцы и годы — сам Date). */
function monitorDay(instant, offsetDays) {
  return new Date(instant.getFullYear(), instant.getMonth(), instant.getDate() + offsetDays);
}

/** Момент HH:MM на локальном дне day: ручные периоды живут в часах машины. */
function monitorInstant(day, hour, minute) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
}

/**
 * Один период записи в проверенной форме: часы/минуты и смещение
 * предупреждения. Битое значение — TypeError с названием поля: сюда приходит
 * уже проверенный граф, и молчаливая подмена скрыла бы ошибку.
 */
function readMonitorPeriod(period, index) {
  const start = parseTimeOfDay(period && period.start);
  if (!start) {
    throw new TypeError('monitor.periods[' + index + '].start должен быть временем HH:MM, например "09:00"');
  }
  const end = parseTimeOfDay(period && period.end);
  if (!end) {
    throw new TypeError('monitor.periods[' + index + '].end должен быть временем HH:MM, например "13:00"');
  }
  const lead = period && period.leadMinutes;
  if (!Number.isInteger(lead) || lead < 0 || lead > 720) {
    throw new TypeError('monitor.periods[' + index + '].leadMinutes должен быть целым числом 0..720');
  }
  return {
    period: { start: period.start, end: period.end, leadMinutes: lead },
    startHour: start.hour,
    startMinute: start.minute,
    endHour: end.hour,
    endMinute: end.minute,
    leadMinutes: lead,
  };
}

/**
 * Состояние монитора в момент now — чистая функция без файлов и часов.
 *
 * Периоды читаются как локальное время машины: человек вводит их руками для
 * себя, а не для часового пояса сервера.
 *
 * Фазы: warn — до start не больше leadMinutes и останов ещё не начался;
 * start — момент start наступил (окно допуска — MONITOR_START_GRACE_MS);
 * inside — останов идёт; idle — до ближайшего окна далеко.
 *
 * activationAt — момент, за который отвечает текущая фаза (его и дедуплицирует
 * планировщик), nextActivation — ближайшая активация строго после now:
 * именно её называют, когда узел «отключается до следующего периода».
 *
 * @param entry - запись монитора { provider, model, periods }.
 * @param now - момент времени, Date (по умолчанию текущий).
 * @returns { state, period, periodIndex, startAt, endAt, leadMinutes,
 *   minutesLeft, activationAt, nextActivation }.
 */
export function monitorStateAt(entry, now = new Date()) {
  const record = entry && typeof entry === 'object' ? entry : {};
  const periods = Array.isArray(record.periods) ? record.periods : [];
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new TypeError('monitorStateAt: now должен быть корректной датой');
  const parsed = periods.map(readMonitorPeriod);
  const matches = [];
  const activations = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index];
    /*
     * Смещение -1 нужно предупреждению через полночь (start 00:10, lead 30 —
     * предупреждение в 23:40 прошлого дня), +1 — чтобы в простое называть
     * завтрашнюю активацию. Больше суток период не живёт: end позже start.
     */
    for (const offset of [-1, 0, 1]) {
      const day = monitorDay(current, offset);
      const startAt = monitorInstant(day, item.startHour, item.startMinute);
      const endAt = monitorInstant(day, item.endHour, item.endMinute);
      const leadAt = new Date(startAt.getTime() - item.leadMinutes * MONITOR_MINUTE_MS);
      const base = {
        periodIndex: index,
        period: item.period,
        startAt,
        endAt,
        leadMinutes: item.leadMinutes,
      };
      if (item.leadMinutes > 0) activations.push({ ...base, at: leadAt, state: 'warn' });
      activations.push({ ...base, at: startAt, state: 'start' });
      const finished = current.getTime();
      if (finished >= startAt.getTime() && finished < endAt.getTime()) {
        const beginning = finished - startAt.getTime() <= MONITOR_START_GRACE_MS;
        matches.push({ ...base, state: beginning ? 'start' : 'inside', priority: beginning ? 2 : 0, at: startAt });
      }
      if (item.leadMinutes > 0 && finished >= leadAt.getTime() && finished < startAt.getTime()) {
        matches.push({ ...base, state: 'warn', priority: 1, at: leadAt });
      }
    }
  }
  /*
   * Начало важнее предупреждения, предупреждение — важнее «останов идёт»:
   * вплотную стоящие периоды не должны заглушить предупреждение о следующем.
   */
  matches.sort((left, right) => (right.priority - left.priority) || (left.startAt - right.startAt));
  let next = null;
  for (const candidate of activations) {
    if (candidate.at.getTime() <= current.getTime()) continue;
    if (!next || candidate.at.getTime() < next.getTime()) next = candidate.at;
  }
  const hit = matches.length > 0 ? matches[0] : null;
  const minutesLeft = hit && hit.state === 'warn'
    ? Math.max(0, Math.round((hit.startAt.getTime() - current.getTime()) / MONITOR_MINUTE_MS))
    : null;
  return {
    state: hit ? hit.state : 'idle',
    period: hit ? hit.period : null,
    periodIndex: hit ? hit.periodIndex : null,
    startAt: hit ? hit.startAt : null,
    endAt: hit ? hit.endAt : null,
    leadMinutes: hit ? hit.leadMinutes : null,
    minutesLeft,
    activationAt: hit ? hit.at : null,
    nextActivation: next,
  };
}

/**
 * Запись монитора для модели координатора: пара provider+model сравнивается
 * как есть. Нет пары — возвращается null, и это молчание, а не повод гадать.
 *
 * @param monitor - поле узла monitor (массив записей).
 * @param provider - провайдер координатора.
 * @param model - модель координатора.
 * @returns запись { provider, model, periods } или null.
 */
export function monitorEntryForModel(monitor, provider, model) {
  const list = Array.isArray(monitor) ? monitor : [];
  const wantedProvider = typeof provider === 'string' ? provider.trim() : '';
  const wantedModel = typeof model === 'string' ? model.trim() : '';
  if (!wantedProvider || !wantedModel) return null;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (String(entry.provider || '').trim() !== wantedProvider) continue;
    if (String(entry.model || '').trim() !== wantedModel) continue;
    return entry;
  }
  return null;
}

/** "ежедневно 09:00" — the cadence as a person reads it. */
export function dailyLabel(schedule) {
  const parsed = parseTimeOfDay(schedule && schedule.at);
  if (!parsed) return 'расписание не задано';
  return 'ежедневно ' + String(parsed.hour).padStart(2, '0') + ':' + String(parsed.minute).padStart(2, '0');
}

/**
 * The schedule payload of one graph: node id -> declared time plus the computed
 * next run. Nodes without a schedule are absent, so the client can tell
 * "расписание: выкл" without guessing.
 */
export function scheduleForGraph(graph, now = new Date()) {
  const result = {};
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  for (const node of nodes) {
    if (!node || !node.schedule) continue;
    try {
      const next = nextRunAt(node.schedule, now);
      result[node.id] = {
        at: node.schedule.at,
        timeZone: node.schedule.timeZone,
        daily: dailyLabel(node.schedule),
        nextRun: next.toISOString(),
      };
    } catch {
      /* The validator reports the malformed schedule; the payload stays readable. */
    }
  }
  return result;
}
