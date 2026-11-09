/**
 * Фид критика: письма критика за окно и следы запусков, по которым видно
 * report/delivered.
 *
 * Заказчик: Critic писал «report'ов от узлов нет с 01.11», хотя их 22. Причина —
 * выборка по одному написанию имени узла: письма лежат как Critic, critic и
 * critic-1. Здесь написания перечислены явно, а report/delivered берутся из
 * записи запуска (совпадение at в окне ±1 ч), а не пересказываются догадкой.
 *
 * Модуль чист по данным: письма и записи запусков приходят аргументами, поэтому
 * правило считается одним и тем же в панели, в CLI и в тестах.
 */

/**
 * Написания подписи критика, которые считаются одним автором.
 *
 * Сравнение — без учёта регистра: Critic, critic и CRITIC — один и тот же узел.
 * Посторонние подписи (critic-2, not-critic) в фид не попадают: «все написания»
 * перечислены контрактом, а не угадываются по префиксу.
 */
export const CRITIC_NAMES = ['critic', 'critic-1'];

/** Окно фида по умолчанию: последние 24 часа до now. */
export const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Окно сверки письма с записью запуска: ±1 час от шапки до старта прогона. */
export const RUN_MATCH_MS = 60 * 60 * 1000;

/**
 * Момент времени из ISO-строки, числа (эпоха, мс) или Date.
 * @returns миллисекунды или null, если значение не время.
 */
function instantOf(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Каноническое имя, если подпись — написание критика, иначе null.
 * Регистр и окружающие пробелы не важны.
 */
function criticName(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CRITIC_NAMES.includes(name) ? name : null;
}

/**
 * Время записи запуска: at, затем since (так пишет стор), затем updatedAt.
 * @returns миллисекунды или null.
 */
function runTimeOf(run) {
  for (const field of ['at', 'since', 'updatedAt', 'finishedAt']) {
    const value = instantOf(run ? run[field] : null);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Запуск, который может быть следом критика.
 *
 * Узел записи обязан быть написанием критика, когда он назван: чужой прогон
 * (worker, judge) не имеет права отдать свой report письму критика. Пустой
 * node не отсекается — запись без узла не выдаёт себя за чужую.
 */
function runBelongsToCritic(run) {
  if (!run || typeof run !== 'object') return false;
  const node = typeof run.node === 'string' ? run.node.trim() : '';
  return node === '' || criticName(node) !== null;
}

/**
 * Собрать фид критика: письма за окно по всем написаниям From + report/delivered
 * из записи запуска.
 *
 * Окно — [since, now]; since по умолчанию now − 24 ч, now по умолчанию текущий
 * момент. Фид не шире 24 часов: более старый since сужает окно до суток, а не
 * раздвигает его. Письмо вне окна не попадает в items и в счётчики.
 *
 * @param {object} input
 * @param {Array<{from, file, at, subject}>} [input.letters] - шапки писем; at —
 *   ISO-строка, эпоха (мс) или Date.
 * @param {Array<object>} [input.runs] - записи запусков; время берётся из at,
 *   затем from since (формат стора), report/delivered — строки записи.
 * @param {string|number|Date} [input.since] - нижняя граница окна.
 * @param {string|number|Date} [input.now] - верхняя граница окна.
 * @returns {{total: number, byFrom: Record<string, number>, items: Array<object>}}
 *   items отсортированы новые первыми; поле report/delivered появляется только
 *   когда оно есть в записи запуска.
 */
export function collectCriticFeed(input = {}) {
  const options = input && typeof input === 'object' ? input : {};
  const nowMs = instantOf(options.now);
  const end = nowMs === null ? Date.now() : nowMs;
  const sinceMs = instantOf(options.since);
  const start = sinceMs === null ? end - FEED_WINDOW_MS : Math.max(sinceMs, end - FEED_WINDOW_MS);

  const runRows = [];
  for (const run of Array.isArray(options.runs) ? options.runs : []) {
    if (!runBelongsToCritic(run)) continue;
    const at = runTimeOf(run);
    if (at === null) continue;
    runRows.push({ at, run });
  }

  const items = [];
  const byFrom = {};
  for (const letter of Array.isArray(options.letters) ? options.letters : []) {
    if (!letter || typeof letter !== 'object') continue;
    const from = typeof letter.from === 'string' ? letter.from.trim() : '';
    if (criticName(from) === null) continue;
    const at = instantOf(letter.at);
    if (at === null || at < start || at > end) continue;
    const item = {
      from,
      file: typeof letter.file === 'string' ? letter.file : '',
      at: new Date(at).toISOString(),
      subject: typeof letter.subject === 'string' ? letter.subject : '',
    };
    /*
     * Ближайшая запись в окне ±1 ч. При равном расстоянии выигрывает запись с
     * report: она доказывает, что прогон собрал файл, а не только стартовал.
     */
    let best = null;
    for (const row of runRows) {
      const distance = Math.abs(row.at - at);
      if (distance > RUN_MATCH_MS) continue;
      if (
        best === null
        || distance < best.distance
        || (distance === best.distance && Boolean(row.run.report) > Boolean(best.run.report))
        || (distance === best.distance && Boolean(row.run.report) === Boolean(best.run.report) && row.at > best.at)
      ) {
        best = { distance, at: row.at, run: row.run };
      }
    }
    if (best) {
      const report = typeof best.run.report === 'string' ? best.run.report.trim() : '';
      const delivered = typeof best.run.delivered === 'string' ? best.run.delivered.trim() : '';
      if (report) item.report = report;
      if (delivered) item.delivered = delivered;
    }
    items.push(item);
    byFrom[from] = (byFrom[from] || 0) + 1;
  }

  items.sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || String(left.file).localeCompare(String(right.file)));
  return { total: items.length, byFrom, items };
}
