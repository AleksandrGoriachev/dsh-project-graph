/**
 * 0181 — карта ежедневных запусков как производная графов.
 *
 * Раньше docs/daily-runs-map.json правился руками и отставал от структуры: у
 * default-workspace в графе уже был reviewer-1, а в карте его не было. Здесь
 * карта целиком строится из входных графов: функция ничего не читает с диска и
 * не знает путей, поэтому «узла нет в карте» больше не бывает.
 *
 * Форма результата: { [workspace]: { nodes: [{ id, role, at? }], schedule? } }.
 * Порядок узлов — порядок объявления в графе: он стабилен между запусками.
 * Узел попадает в расписание, если у него объявлено время запуска — `at` в
 * самом узле или `schedule.at` (обе формы встречаются в structure/graph.json).
 */

/** Непустая строка без краевых пробелов; иначе пустая строка. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Время запуска узла: `at` узла или `schedule.at`; пустая строка, если нет. */
function runAt(node) {
  const direct = text(node.at);
  if (direct) return direct;
  const schedule = node.schedule;
  if (schedule && typeof schedule === 'object' && !Array.isArray(schedule)) {
    return text(schedule.at);
  }
  return '';
}

/** Сравнение расписания: по времени, при равенстве — по id (без locale). */
function byTimeThenId(left, right) {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * Карта ежедневных запусков из графов.
 *
 * @param {Record<string, {nodes?: unknown}>} graphs — воркспейс → граф.
 * @returns {Record<string, {nodes: {id: string, role: string, at?: string}[], schedule?: {id: string, at: string}[]}>}
 */
export function buildDailyRunsMap(graphs) {
  if (!graphs || typeof graphs !== 'object' || Array.isArray(graphs)) return {};
  const entries = [];
  for (const [workspace, graph] of Object.entries(graphs)) {
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) continue;
    const declared = Array.isArray(graph.nodes) ? graph.nodes : [];
    const nodes = [];
    for (const raw of declared) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const id = text(raw.id);
      if (!id) continue;
      const node = { id, role: text(raw.role) };
      const at = runAt(raw);
      if (at) node.at = at;
      nodes.push(node);
    }
    const entry = { nodes };
    const schedule = nodes
      .filter((node) => node.at)
      .map((node) => ({ id: node.id, at: node.at }))
      .sort(byTimeThenId);
    if (schedule.length > 0) entry.schedule = schedule;
    entries.push([workspace, entry]);
  }
  return Object.fromEntries(entries);
}
