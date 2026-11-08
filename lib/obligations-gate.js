/**
 * Гейт обязанностей (задание 0076).
 *
 * 0075 научил структуру СЧИТАТЬ обязанности: непрочитанные письма и команды.
 * Этот модуль удерживает их на двух действиях, после которых работу уже не
 * откатить дёшево: запуск узла (project_graph_spawn / project_graph_run) и
 * коммит/пуш через pwsh. Заказчик выбрал warn: вызов проходит, модель получает
 * предупреждение с обязанностью и числом непрочитанных; deny возвращается только
 * для обязанности с enforce = fail.
 *
 * Журнал гейта живёт в хранилище (правила lib/store.js), а не в репозитории:
 * структура — декларация, хранилище — наблюдение. Никаких импортов DSH: только
 * node:* и наш код, поэтому гейт проверяется без хоста. Подписки
 * tools/pre-execute и tools/post-execute — единственная точка входа в хост;
 * без события плагин работает как раньше. Форма notice-контекста берётся из
 * lib/notice-message.js (задание 0088): полный message формата v4 с id и
 * producer-owned source.kind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { noticeMessage } from './notice-message.js';
import { evaluateObligations, readObligations, scanExchange } from './obligations.js';
import { storeDir } from './store.js';

/** Цели гейта: запуск узла и коммит/пуш. Другие инструменты не трогаются. */
export const GATE_TARGETS = Object.freeze(['node-spawn', 'commit']);

/** Инструменты, которыми запускается узел структуры. */
export const NODE_SPAWN_TOOLS = Object.freeze(['project_graph_spawn', 'project_graph_run']);

/** Имя журнала гейта в каталоге хранилища. */
export const GATE_FILE = 'gate.jsonl';

/** Память гейта ограничена: старые вызовы вытесняются, а не копятся. */
export const GATE_MEMORY_MAX = 100;

/** События хоста, на которые подписывается гейт. */
export const PRE_EXECUTE_EVENT = 'tools/pre-execute';
export const POST_EXECUTE_EVENT = 'tools/post-execute';

/** Короткий префикс лога: молчать о сбое гейта нельзя. */
const LOG_PREFIX = '[dsh-project-graph] obligations-gate: ';

/** Предупреждение в консоль, не роняя хост. */
function warn(message) {
  try {
    console.warn(LOG_PREFIX + message);
  } catch {
    /* консоль может быть закрыта: предупреждение не стоит падения */
  }
}

/** ISO 8601 со смещением машины: читатель отчёта не должен угадывать зону. */
function nowIso(date = new Date()) {
  const value = date instanceof Date ? date : new Date();
  const offset = -value.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const local = new Date(value.getTime() + offset * 60 * 1000).toISOString().slice(0, 19);
  return local + sign + hours + ':' + minutes;
}

/**
 * Корень по умолчанию: выбранный в рантайме, иначе первый объявленный.
 * Тот же резолвер, что у политики структуры: поведение не расходится.
 */
function rootOf(runtime) {
  try {
    if (runtime && typeof runtime.currentRoot === 'function') {
      const current = runtime.currentRoot();
      if (current) return path.resolve(String(current));
    }
    if (runtime && Array.isArray(runtime.roots) && runtime.roots.length > 0) return path.resolve(String(runtime.roots[0]));
  } catch {
    /* резолвер корня может отказать: ниже — cwd */
  }
  return process.cwd();
}

/**
 * Цель гейта для вызова: node-spawn, commit или null.
 *
 * Коммит — только через pwsh: другие инструменты git не запускают, и расширять
 * гейт «на всякий случай» задание запрещает (git commit или git push в команде).
 *
 * @param exec - вызов инструмента ({ name, arguments }).
 * @returns Имя цели или null, если вызов не гейтится.
 */
export function gateTarget(exec) {
  const name = exec && typeof exec.name === 'string' ? exec.name.trim() : '';
  if (!name) return null;
  if (NODE_SPAWN_TOOLS.includes(name)) return 'node-spawn';
  if (name !== 'pwsh') return null;
  const args = exec && exec.arguments;
  const command = args && typeof args === 'object' && typeof args.command === 'string' ? args.command : '';
  if (!command.trim()) return null;
  return /\bgit\s+(?:commit|push)\b/iu.test(command) ? 'commit' : null;
}

/** Человеческое имя цели для текста предупреждения и причины отказа. */
function targetLabel(target) {
  if (target === 'commit') return 'коммит/пуш';
  if (target === 'node-spawn') return 'запуск узла';
  return String(target || 'действие');
}

/** Файл журнала гейта одного проекта: хранилище, не репозиторий. */
export function gateFile(root) {
  return path.join(storeDir(root), GATE_FILE);
}

/** Одна строка журнала; сбой записи журнала не отменяет гейт. */
function recordGateEvent({ root, tool, target, obligations, mode, denied }) {
  const row = {
    at: nowIso(),
    tool: typeof tool === 'string' ? tool : String(tool === undefined || tool === null ? '' : tool),
    target,
    obligations: obligations.slice(),
    mode,
    denied: denied === true,
  };
  try {
    const file = gateFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch (error) {
    warn('событие не записано: ' + (error && error.message ? error.message : String(error)));
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* Память по callId                                                     */
/* ------------------------------------------------------------------ */

/** Последние гейтованные вызовы: ключ -> { target, obligations, denied, delivered }. */
const memory = new Map();

/** Один вызов может прийти без callId (тест, старый хост): ключ по тождеству. */
const identities = new WeakMap();

/** Счётчик синтетических ключей: без него два безымянных вызова склеятся. */
let sequence = 0;

/** Ключ памяти: callId, иначе — тождество объекта вызова. */
function keyOf(exec) {
  const callId = exec && typeof exec.callId === 'string' ? exec.callId.trim() : '';
  if (callId) return 'call:' + callId;
  if (exec && typeof exec === 'object') {
    let key = identities.get(exec);
    if (!key) {
      sequence += 1;
      key = 'object:' + sequence;
      identities.set(exec, key);
    }
    return key;
  }
  return null;
}

/** Запомнить вызов, вытесняя самый старый: память не растёт бесконечно. */
function remember(key, value) {
  if (!key) return;
  memory.delete(key);
  memory.set(key, value);
  while (memory.size > GATE_MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/** Забыть вызов: post-execute забрал предупреждение. */
function forget(key) {
  if (key) memory.delete(key);
}

/** Сброс памяти между проверками: тесты не наследуют чужие вызовы. */
export function resetGateState() {
  memory.clear();
  sequence = 0;
}

/* ------------------------------------------------------------------ */
/* Нарушенные обязанности                                               */
/* ------------------------------------------------------------------ */

/** Сколько писем непрочитано — из одного скана, без второго прохода по диску. */
function unreadCount(root) {
  try {
    const scan = scanExchange({ root });
    return Array.isArray(scan.unread) ? scan.unread.length : 0;
  } catch {
    return null;
  }
}

/**
 * Нарушенные обязанности проекта: строки evaluateObligations с ok === false,
 * обогащённые enforce и видом проверки из декларации.
 *
 * Ряд evaluateObligations не несёт enforce (это свойство декларации, а не
 * наблюдения), поэтому карта обязанностей читается тем же резолвером. Отказ
 * чтения структуры — это не нарушение: гейту нечего удерживать, и он молчит.
 */
function brokenObligations(root) {
  let status;
  try {
    status = evaluateObligations({ root });
  } catch (error) {
    warn('обязанности не вычислены: ' + (error && error.message ? error.message : String(error)));
    return [];
  }
  const rows = status && Array.isArray(status.obligations) ? status.obligations : [];
  const broken = rows.filter((row) => row && row.ok !== true);
  if (broken.length === 0) return [];
  let declared = [];
  try {
    declared = readObligations({ root });
  } catch {
    declared = [];
  }
  const duties = new Map();
  for (const duty of Array.isArray(declared) ? declared : []) {
    if (duty && typeof duty.id === 'string') duties.set(duty.id, duty);
  }
  return broken.map((row) => {
    const duty = duties.get(row.id) || null;
    return {
      id: String(row.id),
      title: String(row.title || row.id),
      detail: String(row.detail || ''),
      enforce: duty && typeof duty.enforce === 'string' && duty.enforce ? duty.enforce : 'warn',
      kind: duty && duty.check && typeof duty.check.kind === 'string' ? duty.check.kind : '',
      command: duty && duty.check && typeof duty.check.run === 'string' ? duty.check.run : '',
    };
  });
}

/** Рецепт по виду проверки: что именно сделать, чтобы обязанность закрылась. */
function recipeOf(duty) {
  if (duty.kind === 'command') {
    return 'Выполните команду проверки и добейтесь exit 0'
      + (duty.command ? ': ' + duty.command : ' (check.run в structure/graph.json)') + '.';
  }
  if (duty.kind === 'exchange-unread') {
    return 'Прочитайте входящие письма в папке обмена и отметьте их прочитанными.';
  }
  return 'Закройте обязанность по её проверке в structure/graph.json.';
}

/**
 * Текст предупреждения для модели: обязанность, число непрочитанных, действие.
 *
 * Модель должна увидеть не только факт, но и что делать; последняя строка прямо
 * говорит, что вызов не заблокирован, — иначе предупреждение читается как отказ.
 */
export function obligationNotice({ target, obligations, root }) {
  const rows = Array.isArray(obligations) ? obligations.filter((row) => row && row.id) : [];
  const count = rows.some((row) => row.kind === 'exchange-unread') ? unreadCount(root) : null;
  const lines = ['Структура: перед действием «' + targetLabel(target) + '» не выполнены обязанности.'];
  for (const row of rows) {
    const head = 'Обязанность «' + row.id + '»' + (row.title && row.title !== row.id ? ' (' + row.title + ')' : '') + ': ';
    const number = row.kind === 'exchange-unread' && count !== null ? 'непрочитанных писем: ' + count + '. ' : '';
    lines.push(head + number + row.detail);
    lines.push('Что сделать: ' + recipeOf(row) + (row.enforce === 'fail' ? ' Режим fail — вызов будет отклонён.' : ''));
  }
  lines.push('Вызов не заблокирован: это предупреждение, а не запрет.');
  return lines.join('\n');
}

/**
 * Контекст предупреждения в форме, которую понимает tools/post-execute.
 *
 * Собирается единым помощником lib/notice-message.js: notice обязан быть полным
 * message формата v4 — role: 'user' (0086), свежий непустой id и producer-owned
 * source.kind (0088). Харнесс сохраняет additionalContexts как user/message; без
 * kind читатель v4 отказывает всему журналу, без id не восстанавливает сессию.
 * Текст, summary и порядок контекстов не меняются: content — массив текстовых
 * блоков, source.form — 'notice'.
 */
function noticeContext(text) {
  return noticeMessage({ text, summary: 'структура: обязанности' });
}

/* ------------------------------------------------------------------ */
/* Обработчики                                                          */
/* ------------------------------------------------------------------ */

/**
 * tools/pre-execute: вычислить нарушения, записать событие, пропустить или
 * отклонить вызов.
 *
 * warn не блокирует: возвращается downstream. deny возвращается только при
 * обязанности с enforce = fail и называет обязанность, деталь и рецепт.
 *
 * @param options.exec - вызов инструмента.
 * @param options.next - downstream-цепочка, возвращающая результат.
 * @param options.runtime - рантайм плагина (корень проекта).
 * @param options.root - корень проекта; по умолчанию — из рантайма.
 * @returns Результат downstream или { kind: 'deny', reason }.
 */
export async function handlePreExecute({ exec, next, runtime, root } = {}) {
  const continueNext = typeof next === 'function' ? next : async () => ({ kind: 'allow' });
  const target = gateTarget(exec);
  if (!target) return continueNext();
  try {
    const projectRoot = root ? path.resolve(String(root)) : rootOf(runtime);
    const broken = brokenObligations(projectRoot);
    if (broken.length === 0) return continueNext();
    const failing = broken.filter((row) => row.enforce === 'fail');
    const denied = failing.length > 0;
    recordGateEvent({
      root: projectRoot,
      tool: exec && exec.name,
      target,
      obligations: broken.map((row) => row.id),
      mode: denied ? 'fail' : 'warn',
      denied,
    });
    if (!denied) {
      remember(keyOf(exec), { target, obligations: broken, denied: false, delivered: false });
      return continueNext();
    }
    const first = failing[0];
    const reason = 'обязанность ' + first.id + ' не выполнена: ' + first.detail + '. ' + recipeOf(first);
    return { kind: 'deny', reason };
  } catch (error) {
    warn('проверка перед вызовом не удалась: ' + (error && error.message ? error.message : String(error)));
    return continueNext();
  }
}

/**
 * tools/post-execute: добавить модели предупреждение гейтованного вызова.
 *
 * Предупреждение отдаётся один раз на вызов: повторный post-execute того же
 * callId не дублирует контекст. Отклонённый вызов контекста не получает —
 * модель уже увидела причину отказа.
 *
 * @param options.exec - вызов инструмента.
 * @param options.result - результат, если downstream не передан.
 * @param options.next - downstream-цепочка.
 * @param options.runtime - рантайм плагина.
 * @param options.root - корень проекта; по умолчанию — из рантайма.
 * @returns Результат downstream, при гейтованном вызове — с additionalContexts.
 */
export async function handlePostExecute({ exec, result, next, runtime, root } = {}) {
  const downstream = typeof next === 'function' ? await next() : result;
  try {
    const key = keyOf(exec);
    const entry = key ? memory.get(key) : null;
    if (!entry || entry.denied || entry.delivered) return downstream;
    entry.delivered = true;
    forget(key);
    const projectRoot = root ? path.resolve(String(root)) : rootOf(runtime);
    const notice = obligationNotice({ target: entry.target, obligations: entry.obligations, root: projectRoot });
    const contexts = downstream && Array.isArray(downstream.additionalContexts) ? downstream.additionalContexts : [];
    return { ...downstream, additionalContexts: [...contexts, noticeContext(notice)] };
  } catch (error) {
    warn('предупреждение не добавлено: ' + (error && error.message ? error.message : String(error)));
    return downstream;
  }
}

/**
 * Подписать гейт на tools/pre-execute и tools/post-execute.
 *
 * Без ctx.on (тест, старый хост) — тихо false: плагин обязан загружаться и без
 * события. Ошибка каждой подписки логируется и не бросается.
 *
 * @returns true, если подписка сделана хотя бы на одно событие.
 */
export function registerObligationGate(ctx, runtime) {
  if (!ctx || typeof ctx.on !== 'function') return false;
  const root = rootOf(runtime);
  let subscribed = false;
  try {
    ctx.on(PRE_EXECUTE_EVENT, (exec, next) => handlePreExecute({ exec, next, runtime, root }));
    subscribed = true;
  } catch (error) {
    warn('подписка ' + PRE_EXECUTE_EVENT + ' не сделана: ' + (error && error.message ? error.message : String(error)));
  }
  try {
    ctx.on(POST_EXECUTE_EVENT, (exec, result, next) => handlePostExecute({ exec, result, next, runtime, root }));
    subscribed = true;
  } catch (error) {
    warn('подписка ' + POST_EXECUTE_EVENT + ' не сделана: ' + (error && error.message ? error.message : String(error)));
  }
  return subscribed;
}
