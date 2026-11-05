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
