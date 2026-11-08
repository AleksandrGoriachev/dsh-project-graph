/**
 * Валидатор структуры (0161): инварианты графа как предусловие работы.
 *
 * Структура — императив: пока граф неисправен, задание не стартует. Здесь
 * собраны проверки, которые не зависят от панели и DSH: их зовёт
 * project_graph_spawn до запуска узла (через опцию validateStructure) и, позже,
 * панель валидатора. Модуль ничего не правит и ничего не читает с диска —
 * на вход граф, на выход находки.
 *
 * Находка: { code, severity: 'error'|'warning', message, node?, edge?,
 *   fix?: { kind: 'safe'|'choice', description } }.
 * «safe» — правка механическая, «choice» — решение человека (какую модель
 * поставить, какую связь оставить). Автопочинки здесь нет: валидатор только
 * называет рецепт.
 *
 * Инварианты (решение D3 задания 0161):
 *   1) в структуре есть координатор;
 *   2) у каждого исполнителя ровно один приёмщик — одна связь review/report;
 *   3) цепочка review/report ациклична;
 *   4) роли непустые;
 *   5) рёбра не ведут в несуществующие узлы;
 *   6) провайдер и модель узла — по настройке forceModelCheck (решение D2):
 *      включена и известен список провайдеров — провайдер вне списка это
 *      ошибка с ближайшим именем; выключена — та же находка остаётся
 *      предупреждением и запуск не блокирует (0139 откажет при запуске).
 *
 * Проверка связей и ролей runs на собранном графе (lib/graph.js): алиасы
 * models{} к этому моменту уже развёрнуты в provider/model узла, поэтому
 * валидатор не повторяет миграцию, а читает объявленный маршрут.
 */

/** Коды находок: словарь задания 0161, расширять только контрактом. */
export const FINDING_CODES = Object.freeze([
  'no-coordinator',
  'no-acceptor',
  'multi-acceptor',
  'cycle',
  'empty-role',
  'dangling-edge',
  'provider-missing',
  'model-missing',
]);

/** Связи, которые назначают приёмщика работы узла. */
const ACCEPT_KINDS = Object.freeze(['review', 'report']);

/** Слова роли координатора: id coordinator и роль «координатор». */
const COORDINATOR_WORDS = Object.freeze(['координатор', 'coordinator']);

/** Слова роли приёмщика: он принимает чужую работу, но отчитывается сам. */
const ACCEPTOR_WORDS = Object.freeze(['приёмщик', 'приемщик', 'судья', 'judge', 'acceptor']);

/** Роль узла обмена (общая папка воркспейсов): это не исполнитель задания. */
const EXCHANGE_WORD = 'обмен';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Роль для сравнения: регистр, «ё» и лишние пробелы не важны (как
 * normalizeRoleName в structure-policy). Пустая роль остаётся пустой.
 */
function normalizeRole(value) {
  return text(value).toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
}

function roleHasWord(role, words) {
  if (!role) return false;
  return words.some((word) => role === word || role.includes(word));
}

/** Узел — координатор: id coordinator или роль со словом «координатор». */
function isCoordinator(node) {
  const id = text(node && node.id).toLowerCase();
  if (id === 'coordinator' || id === 'координатор') return true;
  return roleHasWord(normalizeRole(node && node.role), COORDINATOR_WORDS);
}

/** Узел — приёмщик: принимает работу, сам отчитывается координатору. */
function isAcceptor(node) {
  return roleHasWord(normalizeRole(node && node.role), ACCEPTOR_WORDS);
}

/** Узел обмена (папка воркспейсов): участник обмена, а не исполнитель. */
function isExchangeNode(node) {
  const role = normalizeRole(node && node.role);
  return role.includes(EXCHANGE_WORD) || role.includes('exchange');
}

/** Находка в форме контракта: обязательные поля плюс адрес узла/связи. */
function finding(code, severity, message, extra = {}) {
  const item = { code, severity, message };
  if (extra.node !== undefined && extra.node !== null && extra.node !== '') item.node = extra.node;
  if (extra.edge) item.edge = extra.edge;
  if (extra.fix) item.fix = extra.fix;
  return item;
}

/** Исправление-решение человека: валидатор называет выбор, а не делает его. */
function choice(description) {
  return { kind: 'choice', description };
}

/** Адрес связи для находки: from -> to (kind). */
function edgeLabel(edge) {
  const kind = text(edge && edge.kind) || 'delegate';
  return '«' + text(edge && edge.from) + '» -> «' + text(edge && edge.to) + '» (' + kind + ')';
}

/** Ближайший известный провайдер по написанию: opencode -> opencode-go. */
function nearestProvider(name, ids) {
  const lower = text(name).toLowerCase();
  let best = '';
  let bestDistance = Infinity;
  for (const id of ids) {
    const distance = editDistance(lower, text(id).toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = id;
    }
  }
  if (!best) return '';
  const limit = Math.max(2, Math.ceil(Math.max(lower.length, best.length) / 3));
  return bestDistance <= limit ? best : '';
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

/** Список известных провайдеров: массив непустых строк иначе null. */
function knownProviderList(value) {
  if (!Array.isArray(value)) return null;
  const ids = [];
  for (const item of value) {
    const id = text(item);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * Маршрут узла для проверки моделей.
 *
 * Собранный граф уже развернул алиасы (lib/graph.js), но валидатор зовут и на
 * сыром графе (панель, тесты): поэтому модель-алиас разворачивается здесь по
 * graph.models, если provider у узла не объявлен. Чужой маршрут не выдумывается:
 * чего нет в объявлении, того нет и в ответе.
 */
function routeOf(graph, node) {
  const provider = text(node && node.provider);
  const model = text(node && node.model);
  if (provider || !model) return { provider, model };
  const models = isPlainObject(graph && graph.models) ? graph.models : {};
  const alias = Object.hasOwn(models, model) ? models[model] : null;
  if (!isPlainObject(alias)) return { provider, model };
  return { provider: text(alias.provider), model: text(alias.model) || model };
}

/** Цепочка review/report: смежность по известным узлам. */
function acceptEdgesOf(edges, ids, nodeId) {
  return edges.filter((edge) => edge.from === nodeId
    && ACCEPT_KINDS.includes(text(edge.kind) || 'delegate')
    && ids.has(edge.to));
}

/**
 * Циклы в цепочке review/report.
 *
 * Обход в глубину с цветами: серый узел на пути — обратное ребро, то есть цикл.
 * Возвращается по одному циклу на кольцо (канонический сдвиг пути), чтобы
 * кольцо из трёх узлов не дало три находки об одном и том же.
 */
function findAcceptCycles(nodes, edges) {
  const ids = new Set(nodes.map((node) => node.id));
  const adjacency = new Map();
  for (const node of nodes) adjacency.set(node.id, acceptEdgesOf(edges, ids, node.id).map((edge) => edge.to));
  const color = new Map();
  const path = [];
  const cycles = [];
  const seen = new Set();
  const visit = (id) => {
    color.set(id, 1);
    path.push(id);
    for (const next of adjacency.get(id) || []) {
      const state = color.get(next) || 0;
      if (state === 0) {
        visit(next);
      } else if (state === 1) {
        const start = path.indexOf(next);
        if (start >= 0) {
          const ring = path.slice(start);
          const key = canonicalCycle(ring);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(ring.concat([next]));
          }
        }
      }
    }
    path.pop();
    color.set(id, 2);
  };
  for (const node of nodes) {
    if ((color.get(node.id) || 0) === 0) visit(node.id);
  }
  return cycles;
}

/** Каноническая запись кольца: сдвиг на лексикографически меньший узел. */
function canonicalCycle(ring) {
  if (ring.length === 0) return '';
  let best = 0;
  for (let index = 1; index < ring.length; index += 1) {
    if (ring[index] < ring[best]) best = index;
  }
  const rotated = ring.slice(best).concat(ring.slice(0, best));
  return rotated.join('\u0000');
}

/** Находки по провайдерам и моделям (решение D2 задания 0161). */
function modelFindings(graph, nodes, options) {
  const findings = [];
  const known = knownProviderList(options && options.knownProviders);
  if (!known) return findings;
  const strict = options && options.forceModelCheck === true;
  for (const node of nodes) {
    const route = routeOf(graph, node);
    if (!route.provider) {
      findings.push(finding('provider-missing', strict ? 'error' : 'warning',
        'у узла «' + node.id + '» не объявлен провайдер: маршрут модели неполон. Укажите provider в узле или алиас models{}',
        { node: node.id, fix: choice('Выберите провайдера из доступных и запишите его в provider узла') }));
      continue;
    }
    if (!route.model) {
      if (!strict) continue;
      findings.push(finding('model-missing', 'error',
        'у узла «' + node.id + '» не объявлена модель: провайдер «' + route.provider + '» есть, но порождать агента не на чем',
        { node: node.id, fix: choice('Укажите model узла из моделей провайдера «' + route.provider + '»') }));
      continue;
    }
    if (known.includes(route.provider)) continue;
    const hint = nearestProvider(route.provider, known);
    const severity = strict ? 'error' : 'warning';
    const tail = strict
      ? '. Принудительная проверка включена: запуск узла заблокирован, пока провайдер не исправлен'
      : '. Принудительная проверка выключена: запуск не блокируется, но провайдер без адаптера упадёт в сессии';
    findings.push(finding('provider-missing', severity,
      'провайдера «' + route.provider + '» нет среди известных DSH; доступны: ' + known.join(', ')
        + (hint ? '. Возможно, имелся в виду «' + hint + '»' : '') + tail,
      { node: node.id, fix: choice('Замените provider узла на одного из известных: ' + known.join(', ')) }));
  }
  return findings;
}

/**
 * Проверить структуру по инвариантам и вернуть находки.
 *
 * @param graph - собранный (или сырой) граф: { nodes, edges, models? }.
 * @param options - { forceModelCheck?: boolean, knownProviders?: string[] }:
 *   принудительная проверка моделей (решение D2). Выключена или список
 *   провайдеров неизвестен — провайдер/модель запуск не блокируют.
 * @returns { ok, findings }: ok — правда, только если нет error-находок.
 */
export function validateStructure(graph, options = {}) {
  const input = isPlainObject(options) ? options : {};
  const findings = [];
  const nodes = (Array.isArray(graph && graph.nodes) ? graph.nodes : [])
    .filter((node) => isPlainObject(node) && text(node.id));
  const edges = (Array.isArray(graph && graph.edges) ? graph.edges : [])
    .filter((edge) => isPlainObject(edge));
  const ids = new Set(nodes.map((node) => node.id));

  /* 4) Роли непустые: роль — единственное, что ребёнок получает о себе. */
  for (const node of nodes) {
    if (text(node.role)) continue;
    findings.push(finding('empty-role', 'error',
      'у узла «' + node.id + '» не задана роль: структура не говорит, что этот узел делает',
      { node: node.id, fix: choice('Впишите role узла: «координатор», «исполнитель», «приёмщик» или свою роль словами') }));
  }

  /* 5) Рёбра не ведут в несуществующие узлы. */
  for (const edge of edges) {
    const from = text(edge.from);
    const to = text(edge.to);
    const missing = [];
    if (!ids.has(from)) missing.push('откуда «' + from + '»');
    if (!ids.has(to)) missing.push('куда «' + to + '»');
    if (missing.length === 0) continue;
    findings.push(finding('dangling-edge', 'error',
      'связь ' + edgeLabel(edge) + ' ведёт в несуществующий узел: ' + missing.join(', ')
        + '. Такой связи некуда деть работу',
      {
        edge: { from, to, kind: text(edge.kind) || 'delegate' },
        fix: choice('Удалите связь или объявите названный узел в structure/*.json'),
      }));
  }

  /* 1) Координатор: без него некому раздавать задания и собирать результат. */
  const coordinators = nodes.filter((node) => isCoordinator(node));
  if (coordinators.length === 0) {
    findings.push(finding('no-coordinator', 'error',
      'в структуре нет координатора: некому раздавать задания и собирать результат. '
        + 'Назовите узел id «coordinator» или задайте роль со словом «координатор»',
      { fix: choice('Назначьте координатора: id coordinator либо role «координатор»') }));
  }

  /* 2) У каждого исполнителя ровно один приёмщик (review/report). */
  for (const node of nodes) {
    if (isCoordinator(node) || isExchangeNode(node)) continue;
    const accept = acceptEdgesOf(edges, ids, node.id);
    const targets = [];
    for (const edge of accept) if (!targets.includes(edge.to)) targets.push(edge.to);
    if (targets.length === 0) {
      findings.push(finding('no-acceptor', 'error',
        'у узла «' + node.id + '» нет приёмщика: ни одна связь review/report не говорит, кто принимает его работу'
          + ' (роль узла: ' + (text(node.role) || 'не задана') + ')',
        { node: node.id, fix: choice('Добавьте связь review или report от узла «' + node.id + '» к приёмщику') }));
      continue;
    }
    if (targets.length > 1) {
      findings.push(finding('multi-acceptor', 'error',
        'у узла «' + node.id + '» больше одного приёмщика: ' + targets.join(', ')
          + '. Работа не может приниматься двумя — структура должна назвать одного',
        {
          node: node.id,
          fix: choice('Оставьте одну связь review/report у узла «' + node.id + '»: принимает один приёмщик'),
        }));
    }
  }

  /* 3) Цепочка review/report ациклична: иначе итог некому закрыть. */
  for (const ring of findAcceptCycles(nodes, edges)) {
    findings.push(finding('cycle', 'error',
      'цепочка review/report зациклена: ' + ring.join(' -> ')
        + '. Приёмка не может вернуться туда, откуда пришла',
      {
        node: ring[0],
        fix: choice('Разорвите кольцо: уберите или переведите в другую связь одно из рёбер цепочки ' + ring.join(' -> ')),
      }));
  }

  /* 6) Провайдер и модель — по настройке forceModelCheck (D2). */
  findings.push(...modelFindings(graph, nodes, input));

  return { ok: findings.every((item) => item.severity !== 'error'), findings };
}
