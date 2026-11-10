/**
 * 0197: обязательства на рёбрах структуры.
 *
 * Ребро — не подсказка маршрутизатору, а обязательный обмен результатом.
 * `report`-ребро требует двух фактов у прогона-источника: файла результата
 * (`report`) и письма адресату ребра (`delivered`). Состояние ребра выводится
 * из этих фактов, а не из текста ответа модели:
 *
 *   failed    — прогон закрылся ошибкой;
 *   delivered — есть и файл, и письмо;
 *   produced  — файл есть, письма нет;
 *   missing   — нет ни файла, ни письма.
 *
 * Модуль чистый: ни fs, ни DSH, ни времени. Поэтому ledger, замыкание и гейт
 * активации проверяются на фикстурах без хоста (C1/C4).
 *
 * Реестр обязательств явный: report — единственный вид ребра, у которого есть
 * обязанность результата. delegate/review/peer в 0197 её не получают; закрытие
 * принудительного запуска (project_graph_run) — отдельный слой (0198+).
 */
import { EDGE_KINDS } from './graph.js';

/**
 * Карта «вид ребра -> обязательство». Пустая запись означает «обязанности нет»;
 * отключить report-обязанность флагом нельзя — её просто нет в реестре иначе.
 */
export const EDGE_OBLIGATIONS = Object.freeze({
  report: Object.freeze({ result: 'report', delivery: 'delivered' }),
  delegate: Object.freeze({}),
  review: Object.freeze({}),
  peer: Object.freeze({}),
});

/** Вид ребра, несущий обязанность результата. */
const REPORT = 'report';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Идентификатор узла: принимается и объявление { id }, и голая строка. */
function nodeId(node) {
  if (typeof node === 'string') return node.trim();
  if (node && typeof node === 'object') return text(node.id);
  return '';
}

function graphNodes(graph) {
  return graph && Array.isArray(graph.nodes) ? graph.nodes : [];
}

function graphEdges(graph) {
  return graph && Array.isArray(graph.edges) ? graph.edges : [];
}

/** Адрес ребра в ошибке: «from → to (kind)», даже если поля битые. */
function edgeAddress(edge, index) {
  const from = text(edge && edge.from) || '?';
  const to = text(edge && edge.to) || '?';
  const kind = text(edge && edge.kind) || '?';
  return 'ребро #' + (index + 1) + ' (' + from + ' → ' + to + ', ' + kind + ')';
}

/**
 * Исходящие report-рёбра узла. Пустой или битый `edges` — не обязательство:
 * список рёбер просто пуст, и закрывать нечего.
 */
export function outgoingReportEdges(graph, node) {
  const id = nodeId(node);
  if (!id) return [];
  return graphEdges(graph).filter((edge) => edge
    && text(edge.from) === id
    && text(edge.kind) === REPORT);
}

/**
 * Контракты рёбер структуры.
 *
 * Каждое ребро обязано назвать from/to/kind, kind — быть из EDGE_KINDS, оба
 * узла — существовать в структуре, а report-ребро — не вести в себя. Ошибка
 * называет адрес ребра: без адреса читатель не найдёт виновника в structure/.
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function edgeContracts(graph) {
  const errors = [];
  const ids = new Set();
  for (const node of graphNodes(graph)) {
    const id = nodeId(node);
    if (id) ids.add(id);
  }
  const edges = graphEdges(graph);
  edges.forEach((edge, index) => {
    if (!edge || typeof edge !== 'object') {
      errors.push('ребро #' + (index + 1) + ': не объект — адрес и вид связи не названы');
      return;
    }
    const address = edgeAddress(edge, index);
    const from = text(edge.from);
    const to = text(edge.to);
    const kind = text(edge.kind);
    let named = true;
    if (!from) {
      errors.push(address + ': не назван узел-источник (from)');
      named = false;
    }
    if (!to) {
      errors.push(address + ': не назван узел-адресат (to)');
      named = false;
    }
    if (!kind) {
      errors.push(address + ': не назван вид связи (kind)');
      named = false;
    } else if (!EDGE_KINDS.includes(kind)) {
      errors.push(address + ': вид связи «' + kind + '» не поддерживается (' + EDGE_KINDS.join(', ') + ')');
    }
    if (from && !ids.has(from)) {
      errors.push(address + ': узла «' + from + '» нет в структуре');
    }
    if (to && !ids.has(to)) {
      errors.push(address + ': узла «' + to + '» нет в структуре');
    }
    if (named && kind === REPORT && from && to && from === to) {
      errors.push(address + ': report-ребро не может вести в себя');
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Ledger обмена: по одному элементу на каждое исходящее report-ребро.
 *
 * facts — факты прогона: { state, report?, delivered? }. Состояние выводится
 * строго из них: `error` сильнее всего, `delivered` требует обоих фактов,
 * `produced` — только файла, иначе `missing`.
 *
 * @returns {Array<{ to: string, kind: 'report', state: string, report?: string, delivered?: string }>}
 */
export function edgeStates(graph, node, facts = {}) {
  const values = facts && typeof facts === 'object' ? facts : {};
  const report = text(values.report);
  const delivered = text(values.delivered);
  const failed = text(values.state).toLowerCase() === 'error';
  const state = failed
    ? 'failed'
    : (report && delivered ? 'delivered' : (report ? 'produced' : 'missing'));
  return outgoingReportEdges(graph, node).map((edge) => ({
    to: text(edge.to),
    kind: REPORT,
    state,
    ...(report ? { report } : {}),
    ...(delivered ? { delivered } : {}),
  }));
}

/**
 * Замыкание прогона: report-ребро закрыто только доставленным результатом.
 * Ошибка называет ребро, слово edge-obligation и недостающие факты.
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateClosure(graph, node, facts = {}) {
  const id = nodeId(node);
  const errors = [];
  for (const edge of edgeStates(graph, node, facts)) {
    if (edge.state === 'delivered') continue;
    errors.push('edge-obligation: ' + id + ' → ' + edge.to
      + ' (report): нет результата report/delivered');
  }
  return { ok: errors.length === 0, errors };
}

/** Момент прогона: since — единственный ключ порядка в сторе прогонов. */
function sinceOf(run) {
  const value = Number(run && run.since);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Гейт активации: незакрытый результат последнего ПЛАНОВОГО done-прогона
 * запрещает новый запуск узла.
 *
 * 0198: смотрится последний по `since` прогон kind:'schedule' В СОСТОЯНИИ
 * done, а не последний прогон вообще. Отказ гейта (error) не снимает запрет:
 * прогон error лишь называет, что запуск не состоялся, а результат прошлого
 * done так и не доставлен. Запрет снимает только новый done, у которого есть
 * и файл результата, и письмо. `running` ничего не доказывает — он ещё не
 * закрыт. Нет done-прогонов — активация разрешена.
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateActivation(runs, graph, node) {
  const id = nodeId(node);
  const errors = [];
  if (!id) return { ok: true, errors };
  const scheduled = (Array.isArray(runs) ? runs : []).filter((run) => run
    && typeof run === 'object'
    && nodeId(run.node) === id
    && text(run.kind) === 'schedule');
  if (scheduled.length === 0) return { ok: true, errors };
  let last = null;
  for (const run of scheduled) {
    if (text(run.state).toLowerCase() !== 'done') continue;
    if (!last || sinceOf(run) >= sinceOf(last)) last = run;
  }
  if (!last) return { ok: true, errors };
  const facts = {
    state: 'done',
    ...(text(last.report) ? { report: last.report } : {}),
    ...(text(last.delivered) ? { delivered: last.delivered } : {}),
  };
  for (const edge of edgeStates(graph, node, facts)) {
    if (edge.state === 'delivered') continue;
    errors.push('edge-obligation: предыдущий прогон ' + id
      + ' закрыл done без результата ' + edge.to + ': нельзя начинать новый');
  }
  return { ok: errors.length === 0, errors };
}
