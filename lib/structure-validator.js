/**
 * Валидатор структуры (0161): инварианты графа как предусловие работы.
 *
 * Структура — императив: пока граф неисправен, задание не стартует. Здесь
 * собраны проверки, которые не зависят от панели и DSH: их зовёт
 * project_graph_spawn до запуска узла (через опцию validateStructure) и панель
 * валидатора через /api/validation. Проверка графа остаётся чистой функцией
 * (на вход граф, на выход находки); настройки (structure/validator.json), отчёт
 * по файлам проекта и листенер structure/ — отдельные функции этого модуля
 * (задание 0167), и только они трогают диск.
 *
 * Находка: { code, severity: 'error'|'warning'|'info', message, node?, edge?,
 *   fix?: { kind: 'safe'|'choice', code?, description } }.
 * «safe» — правка механическая, «choice» — решение человека (какую модель
 * поставить, какую связь оставить). Автопочинки здесь нет: валидатор только
 * называет рецепт.
 *
 * Инварианты (решение D3 задания 0161):
 *   1) в структуре есть координатор; пустой граф — info empty-graph, а не
 *      error: координатор есть всегда (0175) — его добавляет чтение
 *      (buildGraph), а запись узла сохраняет в файл (ensureCoordinator);
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
 *
 * Задание 0167 добавляет к чистому валидатору проектную настройку:
 *   - loadValidatorSettings(root) / saveValidatorSettings(root, patch) —
 *     structure/validator.json {forceModelCheck, allowUnknownModel, updatedAt,
 *     updatedBy}; нет файла или файл битый — дефолт forceModelCheck: true;
 *   - каталог моделей в validateStructure: модели узла нет у провайдера —
 *     model-missing (error), узел в allowUnknownModel — та же находка warning;
 *   - validationReport(root, options) — отчёт для GET /api/validation;
 *   - watchStructure(root, {onChange, debounceMs}) — пересчёт при изменении
 *     structure/*.json; ошибки слежения логируются и не валят вызывающего.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildGraph, isCoordinatorNode } from './graph.js';
import { readStructure } from './load.js';
import { resolveStructure } from './store.js';

/*
 * ensureCoordinator живёт в lib/graph.js — рядом с buildGraph, который тем же
 * правилом добавляет координатора при чтении (0175). Экспорт оставлен здесь,
 * потому что его читают 0170 и панель: копии поведения быть не должно.
 */
export { ensureCoordinator } from './graph.js';

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

/** Настройки валидатора живут рядом с графом: <structure>/validator.json (0167). */
export const VALIDATOR_SETTINGS_FILE = 'validator.json';

/** Дефолт принудительной проверки моделей (решение D1 задания 0167): включена. */
export const DEFAULT_FORCE_MODEL_CHECK = true;

/** Связи, которые назначают приёмщика работы узла. */
const ACCEPT_KINDS = Object.freeze(['review', 'report']);

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
 * Папка структуры одного проекта, без обращения к хранилищу.
 *
 * Настройка живёт по контракту в <root>/<structureDir>/validator.json: это
 * предсказуемое место, которое человек может открыть и поправить руками, и его
 * не надо искать по режиму хранения графа.
 */
function structureFolder(root, structureDir) {
  const raw = text(structureDir) || 'structure';
  const dir = raw.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '') || 'structure';
  const base = root === undefined || root === null || String(root).trim() === ''
    ? process.cwd()
    : String(root);
  return path.join(path.resolve(base), dir);
}

/** Абсолютный путь файла настроек валидатора. */
export function validatorSettingsPath(root, structureDir = 'structure') {
  return path.join(structureFolder(root, structureDir), VALIDATOR_SETTINGS_FILE);
}

/**
 * Список разрешённых узлов из allowUnknownModel: только непустые строки.
 * Порядок объявления сохраняется, повторы убираются.
 */
function allowUnknownList(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = text(item);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Каталог моделей в форме «провайдер -> [id модели]».
 *
 * Принимаются и строки, и записи каталога llm ({ id, name, family }): панель
 * передаёт готовый список /api/models, проверки — простые строки. Провайдер
 * без единой модели остаётся в карте с пустым списком: «каталог ничего не
 * знает» — не то же самое, что «модели нет».
 */
function modelCatalog(value) {
  if (!isPlainObject(value)) return null;
  const catalog = new Map();
  for (const [rawProvider, list] of Object.entries(value)) {
    const provider = text(rawProvider);
    if (!provider || !Array.isArray(list)) continue;
    const models = [];
    for (const item of list) {
      const model = text(typeof item === 'string' ? item : (isPlainObject(item) ? item.id : ''));
      if (model && !models.includes(model)) models.push(model);
    }
    catalog.set(provider, models);
  }
  return catalog.size > 0 ? catalog : null;
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
  /*
   * 0167: каталог моделей приходит отдельной картой «провайдер -> [модели]».
   * Список провайдеров без каталога оставляет прежнюю проверку: модель узла
   * сверять не с чем, и находка не выдумывается.
   */
  const catalog = modelCatalog(options && options.models);
  const allowed = allowUnknownList(options && options.allowUnknownModel);
  const strict = options && options.forceModelCheck === true;
  for (const node of nodes) {
    const route = routeOf(graph, node);
    /*
     * Разрешение узла (D2 задания 0167): находка о модели остаётся, но её
     * severity — warning: узел осознанно оставлен живым, пока модель не
     * появится в каталоге. Разрешение не отменяет проверку провайдера.
     */
    const tolerated = allowed.includes('*') || allowed.includes(node.id);
    const tolerance = tolerated
      ? '. Узел «' + node.id + '» разрешён в allowUnknownModel: запуск не блокируется'
      : '';
    if (!route.provider) {
      /* Без списка провайдеров проверка не выдумывается (решение D2 0161). */
      if (!known) continue;
      findings.push(finding('provider-missing', strict ? 'error' : 'warning',
        'у узла «' + node.id + '» не объявлен провайдер: маршрут модели неполон. Укажите provider в узле или алиас models{}',
        { node: node.id, fix: choice('Выберите провайдера из доступных и запишите его в provider узла') }));
      continue;
    }
    if (!route.model) {
      if (!strict || (!known && !catalog)) continue;
      findings.push(finding('model-missing', tolerated ? 'warning' : 'error',
        'у узла «' + node.id + '» не объявлена модель: провайдер «' + route.provider + '» есть, но порождать агента не на чем' + tolerance,
        { node: node.id, fix: choice('Укажите model узла из моделей провайдера «' + route.provider + '»') }));
      continue;
    }
    /*
     * Каталог моделей сам доказывает, что провайдер известен: если он передан,
     * модель узла сверяется с ним и без списка knownProviders (C4 задания 0167).
     * Список провайдеров остаётся нужен там, где каталога нет: provider вне
     * списка — provider-missing, как в 0161.
     */
    if (known && !known.includes(route.provider)) {
      const hint = nearestProvider(route.provider, known);
      const severity = strict ? 'error' : 'warning';
      const tail = strict
        ? '. Принудительная проверка включена: запуск узла заблокирован, пока провайдер не исправлен'
        : '. Принудительная проверка выключена: запуск не блокируется, но провайдер без адаптера упадёт в сессии';
      findings.push(finding('provider-missing', severity,
        'провайдера «' + route.provider + '» нет среди известных DSH; доступны: ' + known.join(', ')
          + (hint ? '. Возможно, имелся в виду «' + hint + '»' : '') + tail,
        { node: node.id, fix: choice('Замените provider узла на одного из известных: ' + known.join(', ')) }));
      continue;
    }
    const knownModels = catalog ? catalog.get(route.provider) : null;
    if (!strict || !knownModels || knownModels.length === 0) continue;
    if (knownModels.includes(route.model)) continue;
    const hint = nearestProvider(route.model, knownModels);
    findings.push(finding('model-missing', tolerated ? 'warning' : 'error',
      'модели «' + route.model + '» нет у провайдера «' + route.provider + '» в каталоге DSH; доступны: '
        + knownModels.join(', ')
        + (hint ? '. Возможно, имелась в виду «' + hint + '»' : '')
        + (tolerated
          ? tolerance
          : '. Принудительная проверка включена: запуск узла заблокирован, пока модель не исправлена'),
      {
        node: node.id,
        fix: choice('Укажите model узла из моделей провайдера «' + route.provider + '»: ' + knownModels.join(', ')),
      }));
  }
  return findings;
}

/**
 * Проверить структуру по инвариантам и вернуть находки.
 *
 * @param graph - собранный (или сырой) граф: { nodes, edges, models? }.
 * @param options - { forceModelCheck?: boolean, knownProviders?: string[],
 *   models?: Record<string, string[]>, allowUnknownModel?: string[] }:
 *   принудительная проверка моделей (решения D2 заданий 0161/0167). Выключена
 *   или список провайдеров неизвестен — провайдер/модель запуск не блокируют;
 *   models — каталог моделей провайдера (0167), узел из allowUnknownModel
 *   получает model-missing предупреждением, а не ошибкой.
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

  /*
   * 0) Пустой граф — не ошибка, а начало (задание 0170, решение D1).
   *
   * Только что созданная структура содержит 0 узлов. Раньше это было error
   * no-coordinator — тупик: координатора нет в палитре, добавить его человек не
   * мог. Теперь пустой граф — info empty-graph с безопасной правкой
   * add-coordinator: координатор есть всегда (0175 — его добавляет чтение,
   * buildGraph), а запускать в пустой структуре всё равно нечего.
   */
  if (isPlainObject(graph) && Array.isArray(graph.nodes) && graph.nodes.length === 0) {
    findings.push(finding('empty-graph', 'info',
      'структура только создана: узлов в ней пока нет. Начните с координатора — он отправная точка воркспейса',
      {
        fix: {
          kind: 'safe',
          code: 'add-coordinator',
          description: 'Добавьте узел coordinator с ролью «координатор»: он раздаёт задания и собирает результат',
        },
      }));
    return { ok: true, findings };
  }

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

  /*
   * 1) Координатор: он есть всегда (0175), поэтому отсутствие — не ошибка, а
   * напоминание с механической правкой. Непустой граф без объявленного
   * координатора читается с implicit-узлом: запуск не блокируется, а запись
   * узла сохранит координатора в файл (ensureCoordinator).
   */
  const coordinators = nodes.filter((node) => isCoordinatorNode(node));
  if (coordinators.length === 0) {
    findings.push(finding('no-coordinator', 'info',
      'в структуре нет объявленного координатора: чтение добавляет его само — '
        + 'запись узла сохранит coordinator в файл',
      {
        fix: {
          kind: 'safe',
          code: 'add-coordinator',
          description: 'Добавьте узел coordinator с ролью «координатор»: он раздаёт задания и собирает результат',
        },
      }));
  }

  /* 2) У каждого исполнителя ровно один приёмщик (review/report). */
  for (const node of nodes) {
    if (isCoordinatorNode(node) || isExchangeNode(node)) continue;
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
/* ------------------------------------------------------------------------- *
 * Настройки валидатора и отчёт для панели (задание 0167)
 * ------------------------------------------------------------------------- */

/**
 * Прочитать настройки проверки моделей из structure/validator.json.
 *
 * Приоритет источников: файл проекта → (у вызывающего) конфиг плагина →
 * дефолт. Здесь решается только первый шаг: нет файла, файл не читается или не
 * разбирается — возвращается дефолт forceModelCheck: true (решение D1 задания
 * 0167). Битый файл не бросает: панель должна открыться и сказать, что
 * проверка включена по умолчанию, а не упасть на чужой запятой.
 *
 * @param root - корень проекта.
 * @param structureDir - логическая папка структуры (по умолчанию "structure").
 * @returns { forceModelCheck, allowUnknownModel, updatedAt?, updatedBy? }.
 */
export function loadValidatorSettings(root, structureDir = 'structure') {
  const file = validatorSettingsPath(root, structureDir);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  if (!isPlainObject(parsed)) {
    return { forceModelCheck: DEFAULT_FORCE_MODEL_CHECK, allowUnknownModel: [] };
  }
  const settings = {
    forceModelCheck: typeof parsed.forceModelCheck === 'boolean'
      ? parsed.forceModelCheck
      : DEFAULT_FORCE_MODEL_CHECK,
    allowUnknownModel: allowUnknownList(parsed.allowUnknownModel),
  };
  if (typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()) settings.updatedAt = parsed.updatedAt.trim();
  if (typeof parsed.updatedBy === 'string' && parsed.updatedBy.trim()) settings.updatedBy = parsed.updatedBy.trim();
  return settings;
}

/** Счётчик временных имён: две записи в одном процессе не совпадут. */
let settingsWriteCounter = 0;

/**
 * Атомарная запись файла: временный сосед + rename.
 *
 * Оборванная запись оставляет либо прежний файл целиком, либо новый целиком —
 * половины JSON в structure/ не бывает. Временный файл убирается при любой
 * ошибке, чтобы папка структуры не засорялась.
 */
function writeSettingsAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  settingsWriteCounter += 1;
  const temp = path.join(
    dir,
    '.' + path.basename(file) + '.tmp-' + process.pid + '-' + settingsWriteCounter + '-'
      + Math.random().toString(36).slice(2, 10),
  );
  try {
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* important is the write error */ }
    throw error;
  }
}

/**
 * Записать настройки валидатора с аудитом.
 *
 * Патч накладывается на текущий файл, а не заменяет его: переключатель панели
 * не должен стирать allowUnknownModel, а разрешение узла — forceModelCheck.
 * updatedAt ставит валидатор (время записи), updatedBy — вызывающий; без него
 * сохраняется прежний автор, иначе пишется "dsh-project-graph". Некорректный
 * тип forceModelCheck игнорируется: файл не получает значения, которого
 * валидатор не поймёт.
 *
 * @param root - корень проекта.
 * @param patch - { forceModelCheck?, allowUnknownModel?, updatedBy? }.
 * @param structureDir - логическая папка структуры (по умолчанию "structure").
 * @returns записанные настройки вместе с updatedAt/updatedBy.
 */
export function saveValidatorSettings(root, patch = {}, structureDir = 'structure') {
  const input = isPlainObject(patch) ? patch : {};
  const current = loadValidatorSettings(root, structureDir);
  const next = {
    forceModelCheck: current.forceModelCheck,
    allowUnknownModel: [...current.allowUnknownModel],
  };
  if (typeof input.forceModelCheck === 'boolean') next.forceModelCheck = input.forceModelCheck;
  if (Object.hasOwn(input, 'allowUnknownModel') && Array.isArray(input.allowUnknownModel)) {
    next.allowUnknownModel = allowUnknownList(input.allowUnknownModel);
  }
  const updatedBy = typeof input.updatedBy === 'string' && input.updatedBy.trim()
    ? input.updatedBy.trim()
    : (current.updatedBy || 'dsh-project-graph');
  const saved = {
    ...next,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  writeSettingsAtomic(validatorSettingsPath(root, structureDir), JSON.stringify(saved, null, 2) + '\n');
  return saved;
}

/** Находка из ошибки чтения/сборки графа: тот же вид, что у валидатора. */
function readFinding(error) {
  const code = text(error && error.code) || 'read-problem';
  const message = text(error && error.message) || 'структура не прочитана';
  return finding(code, 'error', message, {
    ...(error && error.node ? { node: error.node } : {}),
    ...(error && error.file ? { fix: choice('Исправьте ' + error.file + ' в папке структуры') } : {}),
  });
}

/**
 * Отчёт о структуре проекта для GET /api/validation.
 *
 * Читает граф из папки структуры (репозиторий или хранилище — решает
 * lib/store.js), настройки — из structure/validator.json, и проверяет
 * инварианты вместе с каталогом моделей, если вызывающий его передал.
 * Ошибки чтения и сборки входят в findings: отчёт не имеет права сказать
 * "ok" о структуре, которую не смог прочитать.
 *
 * @param root - корень проекта.
 * @param options - { forceModelCheck?, knownProviders?, models?,
 *   allowUnknownModel?, structureDir? }; явный forceModelCheck сильнее файла.
 * @returns { ok, findings, forceModelCheck, settingsPath, ... }.
 */
export function validationReport(root, options = {}) {
  const input = isPlainObject(options) ? options : {};
  const structureDir = text(input.structureDir) || 'structure';
  const settingsPath = validatorSettingsPath(root, structureDir);
  const settings = loadValidatorSettings(root, structureDir);
  const forceModelCheck = typeof input.forceModelCheck === 'boolean'
    ? input.forceModelCheck
    : settings.forceModelCheck;
  const allowUnknownModel = Array.isArray(input.allowUnknownModel)
    ? allowUnknownList(input.allowUnknownModel)
    : [...settings.allowUnknownModel];

  let read;
  try {
    read = readStructure(root, structureDir);
  } catch (error) {
    read = {
      exists: false,
      files: [],
      count: 0,
      dirName: structureDir,
      problems: [{ file: structureDir, message: 'структура не читается: ' + (error && error.message ? error.message : 'ошибка') }],
    };
  }
  let built;
  try {
    built = buildGraph(read.files, { dirName: read.dirName || structureDir });
  } catch (error) {
    built = {
      graph: { version: 1, models: {}, nodes: [], folders: [], edges: [] },
      errors: [{ code: 'read-problem', message: 'граф не собран: ' + (error && error.message ? error.message : 'ошибка') }],
      warnings: [],
    };
  }

  const checked = validateStructure(built.graph, {
    forceModelCheck,
    ...(input.knownProviders !== undefined ? { knownProviders: input.knownProviders } : {}),
    ...(input.models !== undefined ? { models: input.models } : {}),
    allowUnknownModel,
  });
  const readErrors = [
    ...(Array.isArray(read.problems) ? read.problems : []),
    ...(Array.isArray(built.errors) ? built.errors : []),
  ];
  const findings = [...checked.findings, ...readErrors.map(readFinding)];
  /*
   * Решение D1: недоступный каталог моделей — предупреждение, а не блокировка.
   * Вызывающий говорит об этом явно (catalog: {ok:false, reason}), поэтому
   * отсутствие каталога не выдумывается и не смешивается с «модели нет».
   */
  const catalogReason = input.catalogUnavailable === true
    ? 'каталог моделей недоступен'
    : (isPlainObject(input.catalog) && input.catalog.ok === false
      ? (text(input.catalog.reason) || 'каталог моделей недоступен')
      : '');
  if (catalogReason) {
    findings.push(finding('catalog-unavailable', 'warning',
      'каталог моделей недоступен: ' + catalogReason
        + '. Проверка моделей не блокирует запуск — сверять модель узла не с чем',
      { fix: choice('Проверьте службу llm и обновите панель: инварианты структуры проверены без каталога') }));
  }
  return {
    ok: checked.ok && readErrors.length === 0,
    findings,
    forceModelCheck,
    settingsPath,
    allowUnknownModel,
    settings,
    errors: Array.isArray(built.errors) ? built.errors : [],
    warnings: Array.isArray(built.warnings) ? built.warnings : [],
    structure: {
      dir: read.dir,
      mode: read.mode,
      exists: read.exists === true,
      files: typeof read.count === 'number' ? read.count : (Array.isArray(read.files) ? read.files.length : 0),
      nodes: Array.isArray(built.graph.nodes) ? built.graph.nodes.length : 0,
      edges: Array.isArray(built.graph.edges) ? built.graph.edges.length : 0,
    },
  };
}

/** Журнал листенера: ошибка слежения — строка в консоль, не исключение. */
function watchLog(message) {
  try {
    console.warn('[dsh-project-graph] листенер структуры: ' + message);
  } catch {
    /* журнал не имеет права ломать вызывающего */
  }
}

/**
 * Следить за папкой структуры и пересчитывать отчёт при изменении графа.
 *
 * fs.watch на папке (в хранилище — на его папке) с дебаунсом: сохранение
 * графа редактором даёт несколько событий подряд, а отчёт должен собраться
 * один. onChange получает validationReport — тот же ответ, что у
 * /api/validation, поэтому панель и листенер не расходятся.
 *
 * Ошибки слежения (папки нет, событие ОС) логируются и не бросают: структура
 * без листенера остаётся читаемой по запросу. Возвращённая stop() идемпотентна.
 *
 * @param root - корень проекта.
 * @param options - { onChange(report), debounceMs? (30), ...опции отчёта }.
 * @returns stop() — остановить слежение.
 */
export function watchStructure(root, options = {}) {
  const input = isPlainObject(options) ? options : {};
  const debounceMs = Number.isFinite(Number(input.debounceMs))
    ? Math.max(0, Number(input.debounceMs))
    : 30;
  const onChange = typeof input.onChange === 'function' ? input.onChange : null;
  const reportOptions = { ...input };
  delete reportOptions.onChange;
  delete reportOptions.debounceMs;

  let target;
  try {
    target = resolveStructure(root, reportOptions.structureDir).dir;
  } catch {
    target = path.join(path.resolve(String(root || process.cwd())), text(reportOptions.structureDir) || 'structure');
  }

  let watcher = null;
  let timer = null;
  let stopped = false;
  /**
   * Отпечаток *.json папки структуры.
   *
   * fs.watch — основной механизм, но он молчит на части путей Windows
   * (короткие имена %TEMP%, сетевые тома, некоторые антивирусные фильтры):
   * проверка 0167 c6 пишет граф именно в такой временный каталог. Поэтому
   * рядом с fs.watch идёт дешёвая сверка отпечатка (имена + mtime + размер):
   * событие ОС приходит быстрее, а сверка гарантирует пересчёт там, где
   * событий нет. Это не второй источник истины: оба пути ведут в один
   * validationReport и один дебаунс.
   */
  const fingerprint = () => {
    const parts = [];
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 3) walk(full, depth + 1);
          continue;
        }
        if (!entry.name.toLowerCase().endsWith('.json')) continue;
        try {
          const stat = fs.statSync(full);
          parts.push(full + ':' + stat.mtimeMs + ':' + stat.size);
        } catch {
          /* файл исчез между readdir и stat: отпечаток просто короче */
        }
      }
    };
    walk(target, 0);
    return parts.sort().join('|');
  };
  let seen = fingerprint();
  let poller = null;
  const run = () => {
    if (stopped || !onChange) return;
    seen = fingerprint();
    let report;
    try {
      report = validationReport(root, reportOptions);
    } catch (error) {
      watchLog('пересчёт не удался: ' + (error && error.message ? error.message : 'ошибка'));
      return;
    }
    try {
      onChange(report);
    } catch (error) {
      watchLog('onChange упал: ' + (error && error.message ? error.message : 'ошибка'));
    }
  };
  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  try {
    watcher = fs.watch(target, { persistent: false }, (_event, filename) => {
      const name = filename === null || filename === undefined ? '' : String(filename);
      if (name && !name.toLowerCase().endsWith('.json')) return;
      schedule();
    });
    watcher.on('error', (error) => watchLog('событие слежения: ' + (error && error.message ? error.message : 'ошибка')));
  } catch (error) {
    watchLog('fs.watch не поднялся на ' + target + ': ' + (error && error.message ? error.message : 'ошибка') + '; остаётся сверка отпечатка');
  }
  const pollMs = (() => {
    try {
      return fs.statSync(target).isDirectory() ? 250 : 1000;
    } catch {
      return 1000;
    }
  })();
  try {
    poller = setInterval(() => {
      if (stopped) return;
      if (fingerprint() !== seen) schedule();
    }, pollMs);
    if (poller && typeof poller.unref === 'function') poller.unref();
  } catch (error) {
    watchLog('сверка отпечатка не поднялась: ' + (error && error.message ? error.message : 'ошибка'));
  }
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* уже закрыт — это и есть цель stop */
      }
    }
  };
}
