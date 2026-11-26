/**
 * The host-side scheduler: one timer that starts nodes whose declaration carries
 * a daily `schedule`.
 *
 * This is the one deliberate exception to "the panel only reads": a schedule is
 * part of the structure, so the host itself starts the agent at the declared
 * time. The run goes through the same subagent service, the same request shape
 * and the same run store as `project_graph_run`; only the trigger differs.
 *
 * Rules, in order of importance:
 *   1. A missed window is never caught up — neither at boot nor after sleep.
 *   2. Nothing runs that does not declare a schedule.
 *   3. The panel never invents a route: `resolveNodePlan` decides provider/model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readGraph } from './api.js';
import { currentLabel, isoWithOffset, readExchange, writeExchangeMessage } from './exchange.js';
import { listRuns, noteRun } from './runs.js';
/* 0267: форма письма и порядок способов вручения — общий модуль, не локальный вызов. */
import { deliverToHandle, timekeeperNotice } from './agent-message.js';
/* 0344: класс узла — из реестра: таймкипер активируется периодами монитора. */
import { nodeClassOf } from './node-classes.js';
/* 0197: ledger обмена на рёбрах и гейт активации по незакрытому результату. */
import { edgeStates, validateActivation, validateClosure } from './edge-obligations.js';
import {
  monitorEntryForModel,
  monitorStateAt,
  nextRunAt,
  SCHEDULE_GRACE_MS,
  SCHEDULE_TICK_MS,
} from './schedule.js';
import { DEFAULT_MAX_DEPTH, resolveNodePlan } from './spawn.js';
import { ensureCriticSpec, isCriticNode, isTesterNode } from './critic-spec.js';
import { isInsideRoot, labelNamesNode } from './live.js';
import { activityOf, pickLastActive, reconcileRunAck } from './exchange-watch.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Сколько ждём вручения отчёта в живую сессию.
 *
 * Живой случай: вызов с одной формой `{ text }` падал в хосте с TypeError про
 * 'length', а пустой `catch {}` превращал это в «доставлено». Вручение идёт через
 * lib/agent-message.js; здесь — только предел ожидания, чтобы зависший хост не
 * держал тик.
 */
const WAKE_DELIVERY_TIMEOUT_MS = 20 * 1000;

/** Ответ после `ms` с читаемой причиной: зависшая доставка не держит тик. */
function withTimeout(promise, ms, what) {
  let timer = null;
  /*
   * Таймер НЕ unref: с единственным unref-таймером процесс может завершиться
   * раньше, чем ожидание разрешится, и тогда причина отказа теряется.
   */
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(what + ': нет ответа за ' + Math.round(ms / 1000) + ' с')), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    guard,
  ]);
}

/**
 * Сколько раз одно окно расписания вправе запустить узел.
 *
 * Живой случай 2026-11-06: критик на qwen3.8-flash падал за 577 мс без текста, и окно
 * 03:00 пропало на 11 часов. Вторая попытка идёт на другой модели, третьей нет: окно
 * либо отработало, либо это долг, а долг ретраем не догоняется (решение D1 задания 0110).
 */
export const SCHEDULE_MAX_ATTEMPTS = 2;

/** Модель второй попытки, когда у узла нет своей запасной. */
export const DEFAULT_FALLBACK_MODEL = 'glm-5.3-flash';

/**
 * Модель последней надежды — на случай, когда запасная совпала с моделью узла.
 *
 * Повторять ту же модель бессмысленно: она уже доказала, что не отвечает.
 */
const ULTIMATE_FALLBACK_MODEL = 'deepseek-v4.1-flash';

/**
 * Какой моделью идёт попытка окна.
 *
 * Попытка 1 — объявленная модель узла. Начиная со второй — `fallbackModel` узла или
 * DEFAULT_FALLBACK_MODEL; если выбор совпал с моделью узла, он заменяется на
 * ULTIMATE_FALLBACK_MODEL, иначе ретрай повторил бы ту же мёртвую модель.
 *
 * @param node - declaration of the node ({ model, fallbackModel? }).
 * @param attempt - 1-based number of the attempt inside one window.
 * @returns the model id this attempt must use.
 */
export function scheduleAttemptModel(node, attempt) {
  const declaration = node && typeof node === 'object' ? node : {};
  const base = typeof declaration.model === 'string' ? declaration.model.trim() : '';
  const number = Number.isFinite(attempt) ? Math.trunc(attempt) : 1;
  if (number <= 1) return base;
  const declared = typeof declaration.fallbackModel === 'string' ? declaration.fallbackModel.trim() : '';
  const fallback = declared || DEFAULT_FALLBACK_MODEL;
  if (base && fallback === base) return ULTIMATE_FALLBACK_MODEL;
  return fallback;
}

/** Есть ли у окна ещё попытка: потолок — SCHEDULE_MAX_ATTEMPTS, без исключений. */
export function shouldRetrySchedule(attempt) {
  const number = Number.isFinite(attempt) ? Math.trunc(attempt) : 1;
  return number < SCHEDULE_MAX_ATTEMPTS;
}

/**
 * Save a critic's answer as an artifact of the workspace.
 *
 * A `report` edge carries a relation, not bytes: unless the answer lands in a file,
 * the coordinator has nothing to read and an empty answer looks like success. The
 * file is rewritten on a repeated run of the same day instead of piling up duplicates,
 * and the path is relative so the record stays portable.
 *
 * @returns relative path `docs/critic/<YYYY-MM-DD>.md`.
 */
/**
 * Поля шапки письма, которые допустимы перед телом отчёта.
 *
 * Шапка — адрес и связь, а не рассуждение: файл отчёта начинается с неё, и письмо
 * тоже. Любая другая строка до «## Итог дня» — уже не шапка, а преамбула, и тело
 * отчёта с неё не начинается.
 */
const LETTER_HEADER_FIELD = /^(?:From|To|Date|Thread|Status|Subject|Ref|Session|Box|Workspace|Node|Participants):/u;

/**
 * Cut everything above the report heading, and accept nothing else.
 *
 * Models tend to think out loud before answering ("should I deliver via a file?").
 * The live run of 2026-11-10 01:32 showed why "first heading or numbered point
 * anywhere" is not a report: the four sections were present at offset 4833, behind
 * a wall of reasoning, the validator found them "somewhere in the file", and the
 * run closed as done while the letter had already been truncated to 3981 chars
 * without a single section. A report is the answer that starts with the heading,
 * not prose that happens to contain it.
 *
 * Therefore, after leading blank lines and an optional letter header
 * (From:/To:/Date:/…), the first non-empty line must be exactly «## Итог дня»
 * (surrounding spaces allowed). Anything else — reasoning, a numbered point, prose,
 * «# Итог дня» — is an empty body, and the caller records an error.
 *
 * @returns the body from «## Итог дня» to the end, trimmed; '' when there is none.
 */
export function extractReportBody(text) {
  const lines = String(text || '').split(/\r?\n/u);
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (index < lines.length && LETTER_HEADER_FIELD.test(lines[index].trim())) {
    while (index < lines.length && LETTER_HEADER_FIELD.test(lines[index].trim())) index += 1;
    while (index < lines.length && !lines[index].trim()) index += 1;
  }
  if (index >= lines.length) return '';
  if (lines[index].trim() !== '## ' + CRITIC_SECTIONS[0]) return '';
  return lines.slice(index).join('\n').trim();
}

/** How many of the four promised sections the body actually has. */
export function countReportSections(body) {
  const text = String(body || '');
  const wanted = [/итог/iu, /риск/iu, /что делать|делать дальше/iu, /чего не хватило|не хватило/iu];
  return wanted.filter((pattern) => pattern.test(text)).length;
}

/** The four sections a critic report owes, in the only order that means anything. */
export const CRITIC_SECTIONS = ['Итог дня', 'Риски', 'Что делать дальше', 'Чего не хватило'];

/**
 * Validate a critic report by its body, not by the four words happening to appear.
 *
 * Counting the words «итог», «риск», «что делать», «чего не хватило» anywhere in the
 * text accepted a file that carried the report twice: the live docs/critic/2026-11-09.md
 * had two copies of «## Итог дня» and the run still closed as done. A report is its
 * headings and their bodies, so this checks the structure:
 *
 * - every line starting with «## » is a section; exactly four are allowed, in order
 *   «Итог дня», «Риски», «Что делать дальше», «Чего не хватило»;
 * - the first section has to be «Итог дня»;
 * - a repeated section name is a refusal (a report pasted twice is not a report);
 * - a section after the fourth is a refusal (a tail of a second report or an appendix);
 * - an empty report or an empty section body is a refusal.
 *
 * Text above the first heading is preamble (From:/To: of a delivered file) and is not
 * a section. The returned `sections` are the heading names in file order, so a caller
 * can tell "four headings but the wrong ones" from "eight headings".
 *
 * @returns {{ ok: boolean, errors: string[], sections: string[] }}
 */
export function validateCriticReport(text) {
  const source = String(text == null ? '' : text);
  const lines = source.split(/\r?\n/u);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.*)$/u.exec(lines[index]);
    if (!match) continue;
    headings.push({ name: match[1].trim(), line: index });
  }
  const sections = headings.map((item) => item.name);
  const errors = [];
  if (!source.trim()) {
    errors.push('тело отчёта пустое');
  } else if (headings.length === 0) {
    errors.push('в теле нет ни одного раздела (строка «## …»)');
  }
  const seen = new Set();
  for (const heading of headings) {
    if (seen.has(heading.name)) errors.push('дубль раздела «' + heading.name + '»');
    else seen.add(heading.name);
  }
  if (headings.length > 0 && headings[0].name !== CRITIC_SECTIONS[0]) {
    errors.push('первый раздел — «' + headings[0].name + '», а обязан быть «' + CRITIC_SECTIONS[0] + '»');
  }
  for (let index = 0; index < Math.min(headings.length, CRITIC_SECTIONS.length); index += 1) {
    if (headings[index].name !== CRITIC_SECTIONS[index]) {
      errors.push('раздел ' + (index + 1) + ' — «' + headings[index].name
        + '», а ожидается «' + CRITIC_SECTIONS[index] + '»');
    }
  }
  if (headings.length > CRITIC_SECTIONS.length) {
    errors.push('лишний раздел после четвёртого: «' + headings[CRITIC_SECTIONS.length].name + '»');
  }
  if (headings.length > 0 && headings.length < CRITIC_SECTIONS.length) {
    errors.push('разделов ' + headings.length + ', а нужно ровно ' + CRITIC_SECTIONS.length);
  }
  for (let index = 0; index < headings.length; index += 1) {
    const from = headings[index].line + 1;
    const to = index + 1 < headings.length ? headings[index + 1].line : lines.length;
    const body = lines.slice(from, to).join('\n').trim();
    if (!body) errors.push('пустое тело раздела «' + headings[index].name + '»');
  }
  return { ok: errors.length === 0, errors, sections };
}

/** Часовой пояс отчёта узла: расписание узла, иначе московское время. */
function reportTimeZone(node) {
  return node && node.schedule && node.schedule.timeZone ? node.schedule.timeZone : 'Europe/Moscow';
}

/** День отчёта в поясе узла — по нему же строится имя файла. */
export function reportDay(node, at) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: reportTimeZone(node) }).format(at);
}

/**
 * Записать текст узла в docs/<dir>/<YYYY-MM-DD>.md.
 *
 * Шапка письма одна для всех ролей: файл — это отчёт, который читает человек,
 * поэтому From/To/Date/Thread/Status/Subject стоят до тела. Повтор в тот же
 * день перезаписывает файл, а не копит копии.
 */
export function writeNodeReport(root, node, at, text, targets, dirName, thread, fallbackRole) {
  const timeZone = reportTimeZone(node);
  const day = reportDay(node, at);
  const dir = path.join(root, 'docs', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const head = [
    'From: ' + String(node && node.id ? node.id : fallbackRole),
    'To: ' + (targets.length > 0 ? targets.join(', ') : 'coordinator'),
    'Date: ' + isoWithOffset(at, timeZone),
    'Thread: ' + thread,
    'Status: report',
    'Subject: ' + String(node && node.role ? node.role : fallbackRole) + ' за ' + day,
    '',
  ].join('\n');
  const relative = path.join('docs', dirName, day + '.md');
  fs.writeFileSync(path.join(root, relative), head + String(text).trim() + '\n', 'utf8');
  return relative.split(path.sep).join('/');
}

export function writeCriticReport(root, node, at, text, targets = []) {
  return writeNodeReport(root, node, at, text, targets, 'critic', 'critic-report', 'критик');
}

/**
 * Ветка письма планового отчёта (0200).
 *
 * Узел вправе объявить `reportThread` — имя ветки обмена, в которую уходит его
 * report-письмо. Ветка — один сегмент пути: пустое имя, «/» и «..» превратили бы
 * её в путь за пределы ящика или в чужой каталог, поэтому такое объявление не
 * принимается и отчёт уходит в дефолт роли. Пробелы по краям — тоже отказ, а не
 * повод молча обрезать имя: имя ветки сравнивается с каталогом буквально.
 *
 * Дефолт — `tester-report`: без поля поведение 0195 не меняется.
 *
 * @param node - объявление узла ({ reportThread? }).
 * @param fallback - ветка по умолчанию (tester-report).
 * @returns имя ветки: объявленное и валидное либо fallback.
 */
export function reportThreadOf(node, fallback = 'tester-report') {
  const defaultThread = typeof fallback === 'string' && fallback.trim() ? fallback.trim() : 'tester-report';
  const declaration = node && typeof node === 'object' && !Array.isArray(node) ? node : {};
  const declared = typeof declaration.reportThread === 'string' ? declaration.reportThread : '';
  if (!declared || declared !== declared.trim()) return defaultThread;
  if (declared.includes('/') || declared.includes('..')) return defaultThread;
  return declared;
}

/** Отчёт тестировщика (0195): своя папка и своя ветка письма (0200 — настраиваемая). */
export function writeTesterReport(root, node, at, text, targets = [], thread = 'tester-report') {
  const branch = reportThreadOf({ reportThread: thread }, 'tester-report');
  return writeNodeReport(root, node, at, text, targets, 'tester', branch, 'тестировщик');
}
const DEFAULT_PROVIDER = 'spawn';

/**
 * Is the node's declared model route still served by this host?
 *
 * @returns `{ ok: true }` when the route is known or when the question cannot be
 *   answered (a missing llm service is not a failure); `{ ok: false, message }`
 *   with the recipe when the provider or the model is provably absent.
 */
async function checkRoute(runtime, plan) {
  if (!runtime || typeof runtime.getLlm !== 'function' || !plan) return { ok: true };
  let llm;
  try {
    llm = runtime.getLlm();
  } catch {
    return { ok: true };
  }
  if (!llm || typeof llm.listProviders !== 'function') return { ok: true };
  let providers;
  try {
    providers = llm.listProviders() || [];
  } catch {
    return { ok: true };
  }
  const provider = providers.find((item) => item && (item.id === plan.provider || item.name === plan.provider));
  if (!provider) {
    return {
      ok: false,
      message: 'планировщик: провайдера «' + plan.provider + '» нет в DSH — узел не запущен. '
        + 'Доступны: ' + providers.map((item) => item && item.id).filter(Boolean).join(', ')
        + '. Выберите маршрут в панели (Structure → узел «' + plan.node + '» → модель).',
    };
  }
  if (typeof llm.listModels !== 'function') return { ok: true };
  let models;
  try {
    models = (await llm.listModels(provider.id)) || [];
  } catch {
    return { ok: true };
  }
  if (models.length === 0) return { ok: true };
  const known = models.some((item) => item && (item.id === plan.model || item.name === plan.model));
  if (known) return { ok: true };
  return {
    ok: false,
    message: 'планировщик: модели «' + plan.model + '» нет у провайдера «' + provider.id + '» — узел не запущен. '
      + 'Доступны: ' + models.map((item) => item && item.id).filter(Boolean).join(', ')
      + '. Выберите маршрут в панели (Structure → узел «' + plan.node + '» → модель).',
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function iso(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * The prompt of a scheduled run that is not a critic (0195).
 *
 * The tester already has its own role spec in `node.prompt`: it needs no
 * day-spec assembled from facts and owes no four critic sections. Handing the
 * critic prompt to a tester made it write analytics instead of running the
 * suite, so the host names the role, the run time and the node's own spec and
 * stops there.
 */
export function buildNodeSchedulePrompt(input) {
  const node = input.node || {};
  const now = input.now instanceof Date ? input.now : new Date();
  const schedule = input.schedule || node.schedule || {};
  const name = input.name || 'проект';
  const spec = typeof node.prompt === 'string' ? node.prompt.trim() : '';
  const lines = [];
  lines.push('Ты — ' + (node.role || 'узел') + ' «' + node.id + '» в структуре проекта «' + name + '».');
  lines.push('Наступило время ежедневного запуска по расписанию: ' + String(schedule.at || '')
    + ' (' + String(schedule.timeZone || '') + '), ' + iso(now.getTime()) + '.');
  lines.push('');
  lines.push('Выполни работу по собственной спеке узла. Спеки критика и его четырёх разделов здесь нет: у тебя своя задача.');
  lines.push('');
  if (spec) {
    lines.push('Спека узла:');
    lines.push(spec);
  } else {
    lines.push('Спеки у узла нет — действуй по своей роли и верни результат прогона.');
  }
  lines.push('');
  lines.push('Раннер сам запишет твой ответ в файл отчёта и отправит письмо report адресатам — шапку письма и рассуждения о доставке не пиши.');
  lines.push('Верни только результат: команды, exit, время, первая упавшая проверка и вердикт pass|fail.');
  return lines.join('\n');
}

/**
 * The prompt of a scheduled run. The critic writes the spec itself; the host
 * only hands over facts (runs, states, error messages, exchange headers), never
 * the body of an exchange message.
 */
export function buildSchedulePrompt(input) {
  const graph = input.graph || {};
  const node = input.node || {};
  const now = input.now instanceof Date ? input.now : new Date();
  const dayStart = now.getTime() - DAY_MS;
  const runs = (Array.isArray(input.runs) ? input.runs : [])
    .filter((run) => run && run.node && Number(run.since || 0) >= dayStart)
    .sort((left, right) => (right.since || 0) - (left.since || 0))
    .slice(0, 60);
  const exchange = isPlainObject(input.exchange) ? input.exchange : null;
  const facts = exchange && Array.isArray(exchange.facts) ? exchange.facts.slice(0, 40) : [];
  const reportTargets = (Array.isArray(graph.edges) ? graph.edges : [])
    .filter((edge) => edge && edge.from === node.id && edge.kind === 'report')
    .map((edge) => edge.to);
  const schedule = node.schedule || {};
  const name = input.name || 'проект';

  /*
   * 0195: the tester carries the same schedule declaration as the critic, but is
   * a different role. Its prompt is its own node spec; the critic prompt below
   * stays byte for byte, so the critic's four sections are not touched.
   */
  if (!isCriticNode(node)) {
    return buildNodeSchedulePrompt({ node, name, now, schedule });
  }

  const lines = [];
  lines.push('Ты — ' + (node.role || 'узел') + ' «' + node.id + '» в структуре проекта «' + name + '».');
  lines.push('Наступило время ежедневного запуска по расписанию: ' + String(schedule.at || '')
    + ' (' + String(schedule.timeZone || '') + '), ' + iso(now.getTime()) + '.');
  lines.push('');
  lines.push('Собери спеку дня сам — из фактов ниже: что делали узлы, чем закончили, что вернулось '
    + 'в обмене. Тексты сообщений обмена не читай: факт — это направление, время и статус, не содержимое.');
  lines.push('');
  /*
   * The base spec is what makes the critic a critic instead of a fresh improviser:
   * it is read from the workspace, not baked into the prompt, so the customer can
   * change it without touching the panel.
   */
  if (input.baseSpec) {
    lines.push('Постоянная спека (правила, которые не меняются от дня ко дню):');
    lines.push(String(input.baseSpec).trim());
    lines.push('');
  } else {
    lines.push('Постоянной спеки в проекте нет (docs/critic/spec.md не найден) — собери дневную из фактов.');
    lines.push('');
  }
  lines.push('Запуски за последние сутки:');
  if (runs.length === 0) {
    lines.push('- запусков не было');
  } else {
    for (const run of runs) {
      const parts = ['узел «' + run.node + '»: ' + (run.state || 'неизвестно')];
      if (run.kind) parts.push('вид ' + run.kind);
      if (run.since) parts.push('начало ' + iso(run.since));
      if (run.finishedAt) parts.push('конец ' + iso(run.finishedAt));
      if (run.message) parts.push('ошибка: ' + String(run.message).replace(/\s+/gu, ' ').slice(0, 300));
      lines.push('- ' + parts.join(', '));
    }
  }
  lines.push('');
  lines.push('Факты обмена (шапки сообщений, без текстов):');
  if (facts.length === 0) {
    lines.push('- обмена за сутки нет');
  } else {
    for (const fact of facts) {
      lines.push('- ' + String(fact.from || '?') + ' → ' + String(fact.to || '?')
        + ', ' + String(fact.date || iso(fact.at))
        + (fact.status ? ', статус ' + String(fact.status) : ''));
    }
  }
  lines.push('');
  lines.push('Верни готовую аналитику' + (reportTargets.length > 0
    ? ' узлу «' + reportTargets.join('», «') + '» одной исходящей связью report'
    : ' по своей исходящей связи report')
    + ': выводы дня, риски и что делать дальше. Отдельного файла спеки не нужно — текст пиши сам.');
  lines.push('');
  /*
   * The runner writes the header, the file name and the box message. Saying that out
   * loud removes the one thing the model kept reasoning about: whether to deliver.
   */
  lines.push('Ты анализируешь только свой воркспейс: файлы за его пределами не читай и не упоминай как факты.');
  lines.push('Твой ответ — только разделы отчёта, без шапки письма и без рассуждений о доставке: файл и сообщение пишет раннер.');
  lines.push('Не пересказывай список фактов: нужны выводы, а не перечень сообщений.');
  lines.push('');
  lines.push('Структура ответа — ровно эти четыре раздела:');
  lines.push('## Итог дня');
  lines.push('## Риски');
  lines.push('## Что делать дальше');
  lines.push('## Чего не хватило');
  return lines.join('\n');
}

/**
 * Узел класса timekeeper (0344): его активации — периоды монитора, а не работа
 * модели. Класс выводит реестр, а не строка роли: «тайм-менеджер» и «таймкипер»
 * дают один класс.
 */
function isTimekeeperNode(node) {
  const found = nodeClassOf(node);
  return found.ok && found.classId === 'timekeeper';
}

/**
 * Узел-координатор структуры: именно его маршрут сверяется с monitor.
 *
 * Класс берётся из реестра, поэтому неявный координатор чтения (роль
 * «координатор») тоже находится. Нет координатора — таймкиперу некому писать.
 */
function coordinatorNodeOf(graph) {
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const found = nodeClassOf(node);
    if (found.ok && found.classId === 'coordinator') return node;
  }
  return null;
}

/**
 * Build the scheduler. Everything with a side effect is injectable, so the
 * decisions are tested without DSH: `now`, timers, the subagent service and
 * the parent agent.
 *
 * @param options.runtime - graph runtime (roots, structureDir, run store).
 * @param options.getSubagents - lazily returns ctx.subagents.
 * @param options.getParent - lazily returns a live parent Agent handle (the
 *   subagent service refuses an activation without one).
 * @param options.createAgent - optional async ({ cwd, label, reason }) => Agent|null.
 *   Raises a headless session of THIS workspace when no live parent holds it open
 *   (0084). Absent means "wait for a human", with the honest reason in the journal.
 * @param options.getPresets - lazily returns ctx.agentPresets.
 * @param options.now - clock, defaults to the real one.
 * @param options.intervalMs - tick period, defaults to 30 s.
 * @param options.graceMs - how late a run may still start; defaults to 60 s.
 * @param options.logger - optional { warn } sink.
 * @param options.reconcile - сверка ack после закрытия прогона (0132);
 *   по умолчанию reconcileRunAck, подменяется в тестах.
 */
export function createScheduler(options = {}) {
  const runtime = options.runtime;
  if (!runtime) throw new Error('createScheduler: нужен runtime панели');
  const getSubagents = typeof options.getSubagents === 'function' ? options.getSubagents : () => null;
  const getParent = typeof options.getParent === 'function' ? options.getParent : () => null;
  /* Why the parent is missing (names the workspace); the host computes it via pickParent. */
  const getParentReason = typeof options.getParentReason === 'function' ? options.getParentReason : () => '';
  const getPresets = typeof options.getPresets === 'function' ? options.getPresets : () => null;
  const getAgents = typeof options.getAgents === 'function' ? options.getAgents : () => null;
  /* Raises the headless session when no live parent holds the workspace (0084). */
  const createAgent = typeof options.createAgent === 'function' ? options.createAgent : null;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : SCHEDULE_TICK_MS;
  const graceMs = Number.isFinite(options.graceMs) && options.graceMs >= 0
    ? options.graceMs
    : SCHEDULE_GRACE_MS;
  const config = isPlainObject(options.config) ? options.config : {};
  const providerName = typeof config.provider === 'string' && config.provider.trim()
    ? config.provider.trim()
    : DEFAULT_PROVIDER;
  const logger = options.logger || { warn() {} };
  /* Сверка ack: основной путь — reconcileRunAck, тесты подставляют свой. */
  const reconcile = typeof options.reconcile === 'function' ? options.reconcile : reconcileRunAck;
  /* How long to wait for a freed child slot; tests shorten it. */
  const limitRetryMs = Number.isFinite(options.limitRetryMs) && options.limitRetryMs >= 0
    ? options.limitRetryMs
    : 8000;

  /* Node id -> { signature, due }: the armed instant for this declaration. */
  const armed = new Map();
  /*
   * 0344: отправленные активации таймкипера. Ключ — корень, узел, модель и
   * момент активации: сколько бы тиков ни попало внутрь окна, предупреждение
   * 12:30 и начало 13:00 уходят по одному разу. В памяти: дубль живёт в рамках
   * одного процесса, а после перезапуска окно уже названо человеку.
   */
  const sentNotices = new Set();
  let timer = null;
  let ticking = false;
  let stopped = false;

  const keyOf = (root, node) => root + '\u0000' + node;
  const warn = (message) => {
    try {
      logger.warn('[dsh-project-graph] ' + message);
    } catch {
      /* logging must never break a tick */
    }
  };

  /** Arm (or re-arm after a declaration change) one schedule. */
  function arm(root, node, at) {
    const key = keyOf(root, node.id);
    const signature = String(node.schedule.at) + '|' + String(node.schedule.timeZone);
    const seen = armed.get(key);
    if (seen && seen.signature === signature) return seen;
    /*
     * Свежее расписание, чьё окно только что прошло, не должно молча ждать сутки.
     * Если объявление появилось (или изменилось) уже после своего времени, но не
     * дальше окна допуска, оно запускается этим же тиком. Пропуск при закрытом
     * приложении и после сна по-прежнему не догоняется: там due считался заранее.
     */
    let due = nextRunAt(node.schedule, at);
    /*
     * Догоняем только смену объявления, а не старт приложения: если человек только
     * что поменял время и окно прошло не дальше допуска, запускаем этим тиком.
     * После закрытого приложения и сна пропуск по-прежнему не догоняется.
     */
    if (seen) {
      try {
        const previous = nextRunAt(node.schedule, new Date(at.getTime() - DAY_MS));
        if (previous.getTime() <= at.getTime() && at.getTime() - previous.getTime() <= graceMs) {
          due = previous;
        }
      } catch {
        /* no previous occurrence to look at */
      }
    }
    const entry = { signature, due };
    armed.set(key, entry);
    return entry;
  }

  /**
   * Ключ одной активации таймкипера: момент важнее фазы — фаза следует из него.
   */
  function noticeKey(root, node, entry, state) {
    return [root, node.id, entry.provider, entry.model, state.activationAt.toISOString()].join('\u0000');
  }

  /**
   * Живая сессия координатора для письма таймкипера.
   *
   * Приоритет: привязанная сессия узла → сессия этого воркспейса с меткой
   * координатора → любая живая сессия этого воркспейса. Нет ни одной — null, и
   * это честный отказ: письмо не выдумывается и активация не засчитывается.
   */
  function coordinatorHandle(root, coordinator) {
    let list = [];
    try {
      const agents = getAgents();
      const rows = agents
        ? (typeof agents.roots === 'function' ? agents.roots() : (typeof agents.list === 'function' ? agents.list() : []))
        : [];
      list = Array.isArray(rows) ? rows : [];
    } catch {
      list = [];
    }
    if (list.length === 0) return null;
    const idOf = (agent) => String(agent && (agent.sessionId || agent.session || agent.id) || '');
    const bound = typeof coordinator.session === 'string' ? coordinator.session.trim() : '';
    if (bound) {
      const hit = list.find((agent) => idOf(agent) === bound);
      if (hit) return hit;
    }
    let activity = new Set();
    try {
      const seen = activityOf(root);
      if (seen && typeof seen.has === 'function') activity = seen;
    } catch {
      activity = new Set();
    }
    const live = (agent) => Boolean(agent)
      && (isInsideRoot(agent.cwd, root) || activity.has(idOf(agent)));
    const named = list.filter((agent) => live(agent) && labelNamesNode(agent.label || agent.name, coordinator.id));
    if (named.length > 0) return named[named.length - 1];
    const inside = list.filter((agent) => live(agent));
    if (inside.length > 0) return inside[inside.length - 1];
    return null;
  }

  /**
   * Запись факта активации таймкипера в журнал прогонов (задание 0360).
   *
   * Письмо — попытка, запись — факт: панель показывает и удачную доставку, и
   * отказ с причиной, а после перезапуска факт не исчезает. Ключ записи —
   * момент активации (since), поэтому повторный тик того же момента
   * переписывает ту же запись, а не плодит вторую. Сбой журнала — предупреждение:
   * тик важнее истории, и он не падает из-за записи.
   *
   * 0363: канал доставки пишется в каждую запись полем deliveredVia
   * ('session' | 'letter' | 'journal'): панель и разбор видят, дошло ли письмо,
   * даже когда живого получателя нет, а запись остаётся одна на активацию.
   *
   * @param outcome.state - 'done' при доставке, 'error' при отказе.
   * @param outcome.via - канал доставки: 'session' | 'letter' | 'journal'.
   * @param outcome.reason - человекочитаемая причина отказа (в message).
   */
  function recordTimekeeper(root, node, state, text, outcome) {
    const failed = Boolean(outcome && outcome.state === 'error');
    /*
     * Канал называет вызывающий; без него остаётся прежняя семантика (живая
     * сессия/отказ), чтобы запись никогда не теряла поле из-за забытого аргумента.
     */
    const via = outcome && (outcome.via === 'session' || outcome.via === 'letter' || outcome.via === 'journal')
      ? outcome.via
      : (failed ? 'journal' : 'session');
    let since = Date.now();
    let activationAt = '';
    try {
      const moment = state.activationAt instanceof Date ? state.activationAt : new Date(state.activationAt);
      if (Number.isFinite(moment.getTime())) {
        since = moment.getTime();
        activationAt = moment.toISOString();
      }
    } catch {
      /* нечитаемый момент: запись остаётся с текущим временем */
    }
    try {
      noteRun(runtime, {
        root,
        node: node.id,
        kind: 'timekeeper',
        phase: state.state,
        state: failed ? 'error' : 'done',
        since,
        ...(activationAt ? { activationAt } : {}),
        /* Текст уведомления остаётся в записи при любом исходе: это и есть сигнал. */
        text,
        message: failed ? String((outcome && outcome.reason) || 'письмо не доставлено') : text,
        deliveredVia: via,
        finishedAt: Date.now(),
      });
    } catch (error) {
      warn('таймкипер «' + node.id + '»: запись в журнал прогонов не удалась: ' + errorText(error));
    }
  }

  /**
   * Адресат письма таймкипера — ярлык СВОЕГО воркспейса (0365).
   *
   * Поле To называет получателя, а не роль: 'coordinator' — это id узла, и в
   * общем hub письма двух воркспейсов выглядели адресованными одному и тому же
   * получателю. Ярлык берётся из карты участников, а если её нет — имя каталога
   * корня: у воркспейса всегда есть имя, даже когда профиль его не объявил.
   */
  function timekeeperAddressee(root) {
    const participants = runtime.participants && typeof runtime.participants === 'object'
      ? runtime.participants
      : {};
    try {
      const label = currentLabel(root, participants);
      if (typeof label === 'string' && label.trim()) return label.trim();
    } catch {
      /* битая карта участников не должна снимать письмо: остаётся имя каталога */
    }
    return path.basename(path.resolve(String(root)));
  }

  /**
   * Ящик письма: собственный ящик корня идёт первым (0365).
   *
   * writeExchangeMessage берёт первый СУЩЕСТВУЮЩИЙ каталог из paths, поэтому
   * объявленные пути переставляются: каталог внутри корня принадлежит этому
   * воркспейсу, внешний — общему hub. Поведение exchangeDirs не переписывается:
   * меняется только порядок входа, остальное решает он сам.
   */
  function timekeeperBoxPaths(root) {
    const declared = Array.isArray(runtime.exchange) ? runtime.exchange : [];
    const resolvedRoot = path.resolve(String(root));
    const own = [];
    const rest = [];
    for (const item of declared) {
      const raw = typeof item === 'string'
        ? item
        : (item && typeof item === 'object' && typeof item.path === 'string' ? item.path : '');
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const dir = path.resolve(raw.trim());
      const relative = path.relative(resolvedRoot, dir);
      const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
      (inside ? own : rest).push(dir);
    }
    return [...own, ...rest];
  }

  /**
   * Второй канал доставки уведомления таймкипера: письмо в ящик обмена (0363).
   *
   * Живой сессии может не быть вовсе, но ящик воркспейса от этого не исчезает:
   * письмо кладётся в ветку timekeeper и адресуется ярлыку своего воркспейса
   * (0365), статус — request. Свой ящик корня идёт первым, общий hub — вторым.
   * Возвращается факт записи или причина отказа — вызывающий копит её в message
   * журнальной записи, а не глотает.
   *
   * @returns {{ok: boolean, relative?: string, reason?: string}}
   */
  function writeTimekeeperLetter(root, node, state, text) {
    try {
      const message = writeExchangeMessage(root, {
        paths: timekeeperBoxPaths(root),
        participants: runtime.participants,
        to: timekeeperAddressee(root),
        node: node.id,
        thread: 'timekeeper',
        status: 'request',
        subject: state.state === 'warn' ? 'остаток останова' : 'начало останова',
        body: text,
        timeZone: reportTimeZone(node),
      });
      return { ok: true, relative: message && message.relative ? message.relative : '' };
    } catch (error) {
      return { ok: false, reason: 'письмо в ящик обмена не записано: ' + errorText(error) };
    }
  }

  /**
   * Активация таймкипера по монитору (задание 0344).
   *
   * Сверяется текущая модель координатора с записями monitor. Модели нет —
   * молчание и простой до следующего периода: никаких «на всякий случай».
   * Вне окон (inside/idle) активации нет вовсе. Один и тот же момент не
   * уведомляется дважды: ключ содержит момент активации.
   *
   * 0360: отказ доставки больше не молчит. После попытки вручения факт и причина
   * ложатся в журнал прогонов записью kind:'timekeeper', поэтому сигнал виден в
   * панели и переживает перезапуск, а не остаётся строкой в логе процесса.
   *
   * 0363: доставка — лестница каналов. Живая сессия координатора первая, но её
   * отсутствие больше не обрывает уведомление: письмо ложится в ящик обмена
   * воркспейса, а если не вышло и это — остаётся запись в журнале с причиной.
   * Отказ любого канала не роняет тик и не отменяет следующую попытку.
   *
   * @returns запись об отправленном в живую сессию письме или null, если писать
   *   нечего или письмо ушло другим каналом (факт и канал — в журнале).
   */
  async function activateTimekeeper(root, node, graph, at) {
    const monitor = Array.isArray(node.monitor) ? node.monitor : [];
    if (monitor.length === 0) return null;
    const coordinator = coordinatorNodeOf(graph);
    if (!coordinator) return null;
    const entry = monitorEntryForModel(monitor, coordinator.provider, coordinator.model);
    if (!entry) return null;
    const state = monitorStateAt(entry, at);
    if (state.state !== 'warn' && state.state !== 'start') return null;
    const text = timekeeperNotice(state);
    if (!text) return null;
    const key = noticeKey(root, node, entry, state);
    if (sentNotices.has(key)) return null;
    /*
     * Причины отказов копятся, а не заменяют друг друга: в журнале должно быть
     * видно, почему не сработала живая сессия и почему не легло письмо.
     */
    const reasons = [];

    /* Канал 1: живая сессия координатора — как раньше. */
    const handle = coordinatorHandle(root, coordinator);
    if (handle) {
      /*
       * deliverToHandle отказ возвращает, а не бросает; непредвиденный бросок
       * всё равно не должен отменять следующие каналы.
       */
      let attempt;
      try {
        attempt = await deliverToHandle(handle, text, {
          wrap: (promise, what) => withTimeout(promise, WAKE_DELIVERY_TIMEOUT_MS, what),
        });
      } catch (error) {
        attempt = { ok: false, errors: [errorText(error)] };
      }
      if (attempt.ok) {
        sentNotices.add(key);
        recordTimekeeper(root, node, state, text, { state: 'done', via: 'session' });
        return {
          node: node.id,
          kind: 'timekeeper',
          phase: state.state,
          text,
          deliveredVia: 'session',
          activationAt: state.activationAt.toISOString(),
        };
      }
      const reason = attempt.errors.join(' | ') || 'нет способа вручения';
      reasons.push(reason);
      warn('таймкипер «' + node.id + '»: живая сессия координатора письмо не приняла: ' + reason);
    } else {
      reasons.push('нет живой сессии координатора');
      warn('таймкипер «' + node.id + '»: живой сессии координатора нет — письмо кладётся в ящик обмена');
    }

    /* Канал 2: ящик обмена воркспейса. */
    const letter = writeTimekeeperLetter(root, node, state, text);
    if (letter.ok) {
      sentNotices.add(key);
      recordTimekeeper(root, node, state, text, { state: 'done', via: 'letter' });
      return null;
    }
    reasons.push(letter.reason);

    /* Канал 3: доставки нет, но факт активации и причина остаются в журнале. */
    const reason = reasons.join(' | ');
    warn('таймкипер «' + node.id
      + '»: письмо не доставлено ни в сессию, ни в ящик — только запись в журнале: ' + reason);
    recordTimekeeper(root, node, state, text, { state: 'error', via: 'journal', reason });
    return null;
  }

  /**
   * Сверка ack после закрытия прогона (задание 0132).
   *
   * ack — это факт ящика, а не состояние планировщика: прогон закрылся, но
   * письмо-ответ могло лежать в папке всё это время. Сверка не имеет права
   * влиять на исход запуска: её падение только называется в журнале.
   */
  function settleAck(root) {
    const failed = (error) => warn('сверка ack после закрытия прогона «' + root + '» не удалась: ' + errorText(error));
    try {
      const result = reconcile({ runtime, root });
      if (result && typeof result.then === 'function') result.then(() => {}, failed);
    } catch (error) {
      failed(error);
    }
  }

  function record(root, node, since, fields) {
    noteRun(runtime, { root, node, kind: 'schedule', since, ...fields });
    /* Прогон закрыт (done|error) — самое время сверить запись с ящиком. */
    if (fields && (fields.state === 'done' || fields.state === 'error')) settleAck(root);
  }

  /**
   * Start one scheduled node through the same service and request shape as
   * project_graph_run. Returns the accepted activation, or null with the reason
   * already written to the run store.
   */
  async function launch(root, node, payload, at, attempt = 1, after = null) {
    /*
     * Номер попытки и её модель. `since` у каждой попытки свой: журнал хранит и падение
     * первой модели, и успех второй, а не только последнюю строку окна. Повтор получает
     * заведомо более поздний `since`, иначе запись переписала бы ту самую попытку,
     * из-за которой он и случился.
     */
    const attemptNo = Number.isFinite(attempt) && attempt > 1 ? Math.trunc(attempt) : 1;
    const previous = Number.isFinite(after) && after > 0 ? Math.trunc(after) : 0;
    const since = previous > 0 ? Math.max(Date.now(), previous + 1) : Date.now();
    /** Модель этой попытки: известна, как только разрешён маршрут. */
    let runModel = null;
    /*
     * The headless session raised for this run (0084), and the one place that closes it.
     * Closing must never break the run: a host may throw on a session that already
     * stopped, and that error is not the reason the node failed. The promise, when
     * there is one, is settled quietly instead of turning into an unhandled rejection.
     */
    let headless = null;
    const closeHeadless = () => {
      const agent = headless;
      if (!agent) return;
      headless = null;
      for (const method of ['dispose', 'close']) {
        if (typeof agent[method] !== 'function') continue;
        try {
          const result = agent[method]();
          if (result && typeof result.then === 'function') result.then(() => {}, () => {});
        } catch {
          /* closing is best-effort and never changes the run's outcome */
        }
      }
    };
    const fail = (message) => {
      closeHeadless();
      record(root, node.id, since, {
        state: 'error',
        finishedAt: Date.now(),
        attempt: attemptNo,
        ...(runModel ? { model: runModel } : {}),
        message,
      });
      return null;
    };
    const subagents = getSubagents();
    if (!subagents || typeof subagents.startActivation !== 'function') {
      return fail('планировщик: служба ctx.subagents не подключена — проверьте, что в DSH загружен плагин subagent');
    }
    const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : undefined;
    if (!provider) return fail('планировщик: провайдер «' + providerName + '» не зарегистрирован');
    if (!provider.capabilities || provider.capabilities.agentOptions !== true) {
      return fail('планировщик: провайдер «' + providerName + '» не умеет agentOptions');
    }
    const plan = resolveNodePlan(payload.graph, node.id);
    if (!plan.ok) return fail('планировщик: ' + plan.message);
    /*
     * 0197: гейт активации. Незакрытый результат предыдущего планового прогона
     * нельзя перепрыгнуть новым запуском: узел обязан сначала доставить report.
     * Отказ называется edge-obligation и пишется error-прогоном — активации нет.
     */
    const gate = validateActivation(listRuns(runtime, root), payload.graph, node);
    if (!gate.ok) return fail('edge-obligation: ' + gate.errors.join('; '));
    /*
     * Вторая попытка идёт на запасной модели. Сравнение — с разрешённой моделью
     * (`plan.model`), а не с алиасом из structure: именно она попадает в agentOptions
     * и именно она могла оказаться мёртвой.
     */
    const attemptPlan = attemptNo <= 1
      ? plan
      : { ...plan, model: scheduleAttemptModel({ ...node, model: plan.model }, attemptNo) };
    runModel = attemptPlan.model;
    /*
     * The parent decides the session the child is born in, and a session carries its own
     * workspace. Ask for a parent of *this* root: a parent from another workspace makes
     * the critic analyse the wrong folder while the run record says this one. When there
     * is none, the journal gets the reason from pickParent — it names the workspace, where
     * the old general "no parent agent" message left the reader guessing.
     */
    let parent = getParent(root);
    if (!parent || !parent.id) {
      let reason = '';
      try {
        reason = String(getParentReason(root) || '').trim();
      } catch {
        reason = '';
      }
      /*
       * Nobody holds this workspace open — the nightly case (0084): the human session is
       * closed at 03:00, so waiting for it loses the day's report. The host can raise a
       * session itself; ask for one of THIS root (a session carries its own folder) and
       * use the returned agent as the parent of the scheduled run. Without the hook the
       * old honest message stands: we do not pretend a run happened.
       */
      if (!createAgent) {
        return fail('планировщик: ' + (reason
          || 'нет живого агента-родителя для запуска «' + node.id
            + '» — откройте сессию в DSH и дождитесь следующего окна (пропуск не догоняется)'));
      }
      const label = (plan.role ? plan.role + ':' : '') + node.id;
      let created = null;
      try {
        created = await createAgent({ cwd: root, label, reason });
      } catch (error) {
        /*
         * A failed creation has to name its cause: "нет отчёта" would leave the reader
         * guessing whether the schedule, the route or the host refused the session.
         */
        return fail('планировщик: headless-create-failed: ' + errorText(error));
      }
      if (!created) {
        return fail('планировщик: headless-create-failed: хост не вернул агента'
          + (reason ? ' (' + reason + ')' : ''));
      }
      headless = created;
      parent = created;
    }
    if (plan.preset) {
      const presets = getPresets();
      if (!presets || typeof presets.resolve !== 'function') {
        return fail('планировщик: узел «' + node.id + '» требует пресет «' + plan.preset + '», но служба agentPresets не подключена');
      }
      try {
        const resolved = await presets.resolve(plan.preset);
        if (resolved && resolved.broken) {
          return fail('планировщик: пресет «' + plan.preset + '» не активируется: '
            + (typeof resolved.broken === 'string' ? resolved.broken : JSON.stringify(resolved.broken)));
        }
      } catch (error) {
        return fail('планировщик: пресета «' + plan.preset + '» нет в DSH: ' + errorText(error));
      }
    }

    let runs = [];
    try {
      runs = listRuns(runtime, root);
    } catch {
      runs = [];
    }
    let exchange = null;
    try {
      exchange = readExchange(root, {
        paths: runtime.exchange,
        participants: runtime.participants,
        me: runtime.me,
      });
    } catch {
      exchange = null;
    }
    let baseSpec = null;
    try {
      baseSpec = fs.readFileSync(path.join(root, 'docs', 'critic', 'spec.md'), 'utf8').slice(0, 12000);
    } catch {
      baseSpec = null;
    }
    const prompt = buildSchedulePrompt({
      graph: payload.graph,
      node,
      name: payload.name,
      now: at,
      runs,
      exchange,
      baseSpec,
    });
    /*
     * A declared route that the host no longer has is the quietest possible failure:
     * the child is born, the prompt is written, the model is never asked, and the record
     * says only "no report". Say the real reason instead (2026-11-01: every alias pointed
     * at provider "opencode", which this build does not serve).
     */
    const route = await checkRoute(runtime, attemptPlan);
    if (route && route.ok === false) return fail(route.message);
    let maxDepth;
    if (typeof subagents.resolveMaxDepth === 'function') {
      maxDepth = subagents.resolveMaxDepth(config.maxDepth === undefined ? DEFAULT_MAX_DEPTH : config.maxDepth);
    }
    /*
     * The signal belongs to THIS run, not to the scheduler. One shared controller meant
     * that a plugin reload (a `stop()`) aborted every in-flight scheduled run: the child
     * session was created, the prompt was recorded, and the model was never called —
     * "агент завершился без отчёта" after 222 ms. A run that is already born must be
     * able to finish.
     */
    const runController = typeof AbortController === 'function' ? new AbortController() : null;
    const runSignal = runController ? runController.signal : undefined;
    const request = {
      cwd: root,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      agentOptions: { provider: attemptPlan.provider, model: attemptPlan.model },
      ...(plan.preset ? { agentPreset: plan.preset } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(runSignal ? { signal: runSignal } : {}),
    };
    record(root, node.id, since, { state: 'running', attempt: attemptNo, model: attemptPlan.model });
    let activation = null;
    /*
     * The host caps active children per parent. Exchange wakes start agents too, so a
     * scheduled run can meet a full pool: the live signature was "агент завершился без
     * отчёта" after 222 ms with no model call, while the real reason ("subagent limit
     * reached") only appeared in another record. Wait for a slot inside the grace window
     * instead of losing the whole day's report.
     */
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        activation = await subagents.startActivation({
          provider: providerName,
          label: (plan.role ? plan.role + ':' : '') + plan.node,
          request,
          ...(runSignal ? { signal: runSignal } : {}),
          delivery: 'caller',
        });
        break;
      } catch (error) {
        const text = errorText(error);
        const full = /limit reached|active child limit/iu.test(text);
        if (!full || attempt === 3) {
          return fail('планировщик: запуск не удался: ' + text);
        }
        await new Promise((resolve) => setTimeout(resolve, limitRetryMs));
      }
    }
    if (!activation) return fail('планировщик: запуск не удался: нет активации после ожидания места');
    record(root, node.id, since, {
      state: 'running',
      childId: activation && activation.childId,
      attempt: attemptNo,
      model: attemptPlan.model,
    });
    const reportTargets = (Array.isArray(payload.graph.edges) ? payload.graph.edges : [])
      .filter((edge) => edge && edge.from === node.id && edge.kind === 'report')
      .map((edge) => edge.to);
    watch(root, node.id, since, activation, at, node, reportTargets, payload.graph, parent, {
      attempt: attemptNo,
      model: attemptPlan.model,
      payload,
      since,
    });
    /* The child is born; the host session that carried it does not stay open. */
    closeHeadless();
    return {
      root,
      node: node.id,
      childId: activation && activation.childId,
      due: at.toISOString(),
      attempt: attemptNo,
      model: attemptPlan.model,
    };
  }

  /**
   * Wake the addressees: a file in the shared box is a report on a desk, and nobody
   * reads the desk on their own. The handle of a live agent of the target node gets a
   * short message with the path; no handle means no session to wake, and that is said
   * honestly instead of pretending the report was delivered.
   */
  async function wakeAddressees(root, targets, report, summary, graph, parent, from) {
    const awake = [];
    const reasons = [];
    /** One row per delivered addressee: who was woken, why, and how fresh it was. */
    const deliveredRows = [];
    if (!Array.isArray(targets) || targets.length === 0) return { awake, reasons, deliveredRows };
    let list = [];
    const agents = (() => {
      try {
        return getAgents();
      } catch {
        return null;
      }
    })();
    if (agents) {
      try {
        const rows = typeof agents.roots === 'function' ? agents.roots() : (typeof agents.list === 'function' ? agents.list() : []);
        list = Array.isArray(rows) ? rows : [];
      } catch {
        list = [];
      }
    }
    /*
     * 0195 R1: пробуждение называет свой узел, а не критика. Жёсткий текст
     * «Отчёт критика готов» объявлял отчёт тестировщика отчётом критика;
     * роль берётся из графа, поэтому нейтральная формула верна для обеих ролей.
     */
    const sourceNode = graph && Array.isArray(graph.nodes)
      ? graph.nodes.find((item) => item && item.id === from)
      : null;
    const sourceRole = sourceNode && typeof sourceNode.role === 'string' ? sourceNode.role.trim() : '';
    const word = 'Отчёт узла «' + from + '»' + (sourceRole ? ' (' + sourceRole + ')' : '')
      + ' готов: ' + report + '\n\n' + summary;
    /*
     * Idempotency: a repeated wake for the same report must not spawn a second session
     * of the addressee. If a previous run already delivered this file, that delivery
     * stands.
     */
    let prior = [];
    try {
      prior = listRuns(runtime, root);
    } catch {
      prior = [];
    }
    for (const target of targets) {
      const done = prior.some((run) => run && run.report === report
        && Array.isArray(run.awake) && run.awake.includes(target));
      if (done) {
        awake.push(target);
        continue;
      }
      const targetNode = graph && Array.isArray(graph.nodes) ? graph.nodes.find((item) => item && item.id === target) : null;
      /*
       * Explicit binding wins when it is alive: the operator said which session owns the
       * node, and guessing by label would ignore that.
       */
      const bound = targetNode && typeof targetNode.session === 'string' ? targetNode.session : null;
      /*
       * The addressee is the LAST ACTIVE session of the report's workspace, by journal
       * time (the customer's schema), not "the first agent whose cwd fits and whose label
       * mentions the node". A live agent without a cwd is matched through the journal,
       * which is the same source of truth the exchange watcher uses.
       */
      const activity = activityOf(root);
      const named = (list || []).filter((agent) => agent
        && (isInsideRoot(agent.cwd, root) || activity.has(String(agent.sessionId || agent.session || agent.id || '')))
        && labelNamesNode(agent.label || agent.name, target));
      const preferred = named.length > 0 ? named : list;
      const pick = pickLastActive(preferred, root, activity, { binding: bound, now: Date.now() });
      const handle = pick ? pick.agent : null;
      if (handle) {
        /*
         * Живая сессия — не гарантия вручения. Хост DSH принимает объект сообщения
         * (id, role, content[], source), а прежняя форма `{ text }` падала на
         * `state[target].length`; пустой `catch {}` глотал TypeError, и отчёт
         * уходил в spawn без причины. Форму и порядок способов задаёт
         * lib/agent-message.js, отказ обязан попасть в reasons.
         */
        const attempt = await deliverToHandle(handle, word, {
          wrap: (promise, what) => withTimeout(promise, WAKE_DELIVERY_TIMEOUT_MS, what),
        });
        if (attempt.ok) {
          awake.push(target);
          deliveredRows.push({
            node: target,
            target: String(handle.sessionId || handle.session || handle.id || ''),
            reason: pick.reason,
            via: attempt.via,
            ...(pick.activityAt ? { activityAt: new Date(pick.activityAt).toISOString() } : {}),
          });
          continue;
        }
        reasons.push('доставка в живую сессию не удалась: '
          + (attempt.errors.join(' | ') || 'нет подходящего способа'));
      }
      /*
       * No live agent of the addressee does not mean "delivered": the report is a task
       * for that node, so the node is started with the report as its prompt. That is the
       * difference between a letter in a box and a reader who has it.
       */
      const subagents = getSubagents();
      const plan = graph ? resolveNodePlan(graph, target) : { ok: false, message: 'нет структуры под рукой' };
      const provider = subagents && typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : undefined;
      /*
       * The parent at launch time may be gone by delivery time. Ask again, and say the
       * reason out loud: "delivery failed" without it is a dead end for the reader.
       */
      const parentNow = parent || (() => {
        try {
          return getParent(root);
        } catch {
          return null;
        }
      })();
      if (!subagents) {
        reasons.push('служба субагентов недоступна');
        continue;
      }
      if (!plan.ok) {
        reasons.push('маршрут узла «' + target + '» не разрешён: ' + (plan.message || 'нет плана'));
        continue;
      }
      if (!provider) {
        reasons.push('провайдер «' + providerName + '» не зарегистрирован');
        continue;
      }
      if (!parentNow) {
        reasons.push('нет ни одной открытой сессии в воркспейсе: отчёт остался в ящике'
          + (bound ? ' (привязанная сессия ' + bound + ' закрыта)' : ''));
        continue;
      }
      const prompt = [
        'Тебе доставлен отчёт узла «' + from + '»' + (sourceRole ? ' (' + sourceRole + ')' : '')
          + ' за ' + String(report).replace(/^.*\//u, '').replace(/\.md$/u, '') + '.',
        'Файл: ' + report,
        '',
        summary,
        '',
        'Прочитай отчёт и действуй по нему: что принято, что назначено, что осталось без ответа.',
      ].join('\n');
      try {
        /*
         * The host expects an AbortSignal on this call path: without it the activation
         * fails inside the runner with "undefined.throwIfAborted". The scheduled path
         * already passes one, so the wake path must do the same.
         */
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const request = {
          cwd: root,
          prompt: [{ type: 'text', text: prompt }],
          parent: parentNow,
          agentOptions: { provider: plan.provider, model: plan.model },
          ...(plan.preset ? { agentPreset: plan.preset } : {}),
          ...(controller ? { signal: controller.signal } : {}),
        };
        const activation = await subagents.startActivation({
          provider: providerName,
          label: 'доставка:' + target,
          request,
          delivery: 'caller',
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (activation && activation.childId) {
          awake.push(target);
          deliveredRows.push({ node: target, target: String(activation.childId), reason: 'spawn' });
        }
      } catch (error) {
        const stack = error && error.stack ? String(error.stack).split('\n').slice(0, 2).join(' | ') : '';
        reasons.push('запуск узла «' + target + '» не удался: ' + errorText(error) + (stack ? ' [' + stack + ']' : ''));
        warn('расписание: доставка отчёта узлу «' + target + '» не удалась: ' + errorText(error));
      }
    }
    if (awake.length === 0 && reasons.length === 0) reasons.push('адресат не найден');
    return { awake, reasons, deliveredRows };
  }

  /**
   * Положить отчёт в ящик и поднять адресатов.
   *
   * Общий путь критика и тестировщика: файл — отчёт на столе, письмо — связь.
   * Доставка — часть успеха, поэтому причина отказа возвращается, а не глотается.
   */
  async function deliverReport(options) {
    const { root, targets, report, summary, graph, parent, from } = options;
    const answer = { delivered: null, awake: [], wakeNote: null, wakeError: null, wakeRow: null, problem: null };
    try {
      const message = writeExchangeMessage(root, {
        paths: runtime.exchange,
        from,
        to: (targets || []).join(', ') || 'coordinator',
        participants: runtime.participants,
        node: from,
        thread: options.thread,
        status: 'report',
        file: report,
        subject: options.subject,
        body: summary,
        at: options.at,
        timeZone: options.timeZone,
      });
      answer.delivered = message.relative;
      const woke = await wakeAddressees(root, targets || [], report, summary, graph, parent, from);
      if (woke.deliveredRows && woke.deliveredRows.length > 0) answer.wakeRow = woke.deliveredRows[0];
      if (woke.awake.length > 0) {
        answer.awake = woke.awake;
        /*
         * Адресат поднят, но живая сессия его не приняла: прогон остаётся done, а
         * причина отказа остаётся в записи. Иначе отказ живой доставки снова исчезнет,
         * как при пустом catch {}.
         */
        if (Array.isArray(woke.reasons) && woke.reasons.length > 0) {
          answer.wakeError = woke.reasons.join('; ');
        }
      } else if ((targets || []).length > 0) {
        /* A file in a box is not delivery: if nobody was woken, the run failed. */
        answer.problem = 'отчёт записан и положен в ящик, но адресат не поднят: ' + woke.reasons.join('; ');
        answer.wakeError = woke.reasons.join('; ');
      } else {
        answer.wakeNote = 'у узла нет связи report — доставлять некому';
      }
    } catch (error) {
      answer.problem = 'сообщение в ящик не записано: ' + errorText(error);
      warn('расписание: доставка отчёта узла «' + from + '» не удалась: ' + errorText(error));
    }
    return answer;
  }

  /**
   * Тело письма: начало и конец отчёта, а середина — по ссылке на файл.
   *
   * Пять строк и 700 символов резали отчёт на середине и прятали именно те
   * разделы, по которым его судят (0131/0132): письмо обязано назвать обрыв и
   * указать файл, где лежит целый отчёт. Но один хвост резал по живому: у
   * отчёта, где распух именно первый раздел (0274, «слишком длинный отчёт
   * помечается «обрезано»»), за пределом оставались «Риски», «Что делать
   * дальше» и «Чего не хватило» — и адресат получал письмо без трёх разделов
   * из четырёх, а прогон закрывался error «разделы не влезли в предел» (0196).
   *
   * Поэтому режем середину, а не хвост: половина предела — начало отчёта,
   * половина — конец, между ними маркер с путём файла. Так письмо всегда несёт
   * первые разделы и его же вывод, а выпавшая середина названа, а не потеряна
   * молча. Решение согласовано с 0196: проверка четырёх заголовков остаётся, и
   * если после такого реза заголовок всё-таки выпал (длинный отчёт, где разделы
   * разошлись по всей длине — контрольный случай 0196), прогон по-прежнему
   * error «разделы отчёта не влезли в предел письма», а не done с обрывком.
   */
  function reportSummary(text, report) {
    const summaryLimit = 4000;
    const all = String(text).trim();
    if (all.length <= summaryLimit) return all;
    const half = Math.floor(summaryLimit / 2);
    /* Начало — до последнего перевода строки в первой половине. */
    const headLine = all.lastIndexOf('\n', half);
    const headEnd = headLine > 0 ? headLine : half;
    /* Конец — от первого перевода строки во второй половине. */
    const edge = all.indexOf('\n', all.length - half);
    const tailStart = edge === -1 ? all.length - half : edge + 1;
    const marker = '\n\n…обрезано, см. файл: ' + report;
    if (tailStart <= headEnd) {
      /* Строк для реза нет (одна длинная строка) — режем по пределу, как раньше. */
      const lineEdge = all.lastIndexOf('\n', summaryLimit);
      const cutAt = lineEdge > half ? lineEdge : summaryLimit;
      return all.slice(0, cutAt).trimEnd() + marker;
    }
    return all.slice(0, headEnd).trimEnd() + marker + '\n\n' + all.slice(tailStart).trimStart();
  }

  /**
   * Отчёт, перед которым модель думала вслух: тело с «## Итог дня» и без предисловия.
   *
   * 0274: «рассуждения до отчёта отрезаются, разделы остаются» — текст, где перед
   * отчётом идёт «Wait — let me check. Hmm, should I deliver a file?», не должен
   * валить запуск. Строгий `extractReportBody` при этом не ослабляется (0196):
   * проза, нумерация и чужие заголовки до отчёта остаются отказом, и живой
   * артефакт 10.11 01:32 (нумерованное рассуждение на 4 200 знаков, отчёт в
   * конце) по-прежнему не принимается. Спасаем только узнаваемое «думание
   * вслух»: не больше двух непустых строк и 300 знаков, без заголовков и
   * пунктов списка, с маркером самого рассуждения. Всё остальное — пустое тело,
   * и прогон честно закрывается error «в ответе нет отчёта — только рассуждения».
   *
   * @returns тело от «## Итог дня» до конца или '' (нечего спасать).
   */
  function salvageReportBody(text) {
    const lines = String(text || '').split(/\r?\n/u);
    const heading = '## ' + CRITIC_SECTIONS[0];
    let index = -1;
    for (let line = 0; line < lines.length; line += 1) {
      if (lines[line].trim() === heading) { index = line; break; }
    }
    if (index <= 0) return '';
    const preamble = lines.slice(0, index).map((line) => line.trim()).filter(Boolean);
    if (preamble.length === 0 || preamble.length > 2) return '';
    const said = preamble.join('\n');
    if (said.length > 300) return '';
    /* Заголовок или пункт списка — это уже черновик отчёта, а не рассуждение. */
    if (/^\s*#{1,6}\s/u.test(said) || /^\s*(?:\d+[.)]|[-*+])\s/u.test(said)) return '';
    /* Рассуждение узнаётся по самоговорению; обещание «сейчас напишу» — не оно. */
    if (!/(?:^|[^a-zа-яё])(?:wait|hmm+|okay|ok|actually|let me|let's|should i|i should|i'll|i need|i think|maybe|подожди|хм+|итак|пожалуй|думаю)(?![a-zа-яё])/iu.test(said)) return '';
    return lines.slice(index).join('\n').trim();
  }

  /**
   * Повторить окно на другой модели: ровно одна повторная попытка, без задержек,
   * без догона и без нового окна.
   *
   * Расписание уже сдвинуто тиком, поэтому повтор не станет вторым запуском той же
   * минуты: он живёт тем же окном (at) и получает следующий `since`. Модель выбирает
   * scheduleAttemptModel по уже разрешённой модели попытки: алиас structure{} мёртвой
   * быть не может, мёртва конкретная модель провайдера.
   */
  function retryWindow(root, node, run, at) {
    if (!run || !shouldRetrySchedule(run.attempt)) return;
    const next = Math.trunc(run.attempt) + 1;
    if (run.model) {
      warn('расписание: окно узла «' + node.id + '» — попытка ' + run.attempt
        + ' не дала отчёта; повтор на модели '
        + scheduleAttemptModel({ ...node, model: run.model }, next) + ' (попытка ' + next + ')');
    }
    Promise.resolve()
      .then(() => launch(root, node, run.payload, at, next, run.since))
      .catch((error) => warn('расписание: повтор окна узла «' + node.id + '» не удался: ' + errorText(error)));
  }

  /** Record the end of the run the tick did not wait for. */
  function watch(root, node, since, activation, at, declaration, reportTargets, graph, parent, run) {
    const result = activation && activation.result;
    if (!result || typeof result.then !== 'function') return;
    const attempt = run && Number.isFinite(run.attempt) ? Math.trunc(run.attempt) : 1;
    const attemptModel = run && typeof run.model === 'string' && run.model ? run.model : null;
    result.then(
      async (settled) => {
        const output = (() => {
          if (settled === undefined || settled === null) return '';
          if (typeof settled === 'string') return settled;
          const parts = Array.isArray(settled.output) ? settled.output : [];
          return parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
        })();
        /*
         * A scheduled critic that answers with a preamble and stops did not do its job.
         * "ok in two seconds with no text" is a failure, and the record must say so.
         * The same holds for a wall of reasoning: "Wait —" and "Hmm" are the runner's
         * thoughts, not a report, and the peacetime failure looks exactly like success.
         */
        const text = output.trim();
        const stop = settled && typeof settled.stopReason === 'string' ? settled.stopReason.trim() : '';
        const failed = Boolean(settled && settled.stopReason === 'error') || text.length === 0;
        /*
         * A failure has to name its cause: "завершился без отчёта" alone leaves a reader with
         * nothing to do. The stop reason and the absence of any text are the two facts this
         * side actually knows, so they go into the record instead of being dropped.
         */
        const failureNote = text.length === 0
          ? 'агент завершился без отчёта'
            + (stop ? ' (stopReason: ' + stop + ')' : ' (stopReason не сообщён)')
            + '; текста нет — вызова модели не было или агент закрыт до первого шага'
          : (stop ? 'агент завершился с ошибкой (stopReason: ' + stop + '): ' + text.slice(0, 200).replace(/\s+/gu, ' ') : '');
        /*
         * A critic is judged by its four sections; a scheduled non-critic (the
         * tester, 0195) is judged by its own run. Its answer is written as is —
         * only an empty answer is a failure, and that is already in `failed`.
         */
        const critic = Boolean(declaration && isCriticNode(declaration));
        const other = Boolean(declaration && !critic);
        let body = critic ? extractReportBody(text) : text;
        /*
         * 0274: рассуждение перед отчётом отбрасывается, а не валит запуск.
         * Строгий extractReportBody остаётся строгим (0196), поэтому узнанное
         * «думание вслух» спасается здесь, в прогоне: из ответа берётся всё от
         * «## Итог дня», а отброшенное называется в журнале, а не исчезает молча.
         * Проза, нумерация и чужие заголовки до отчёта по-прежнему отказ.
         */
        if (critic && !body) {
          const salvaged = salvageReportBody(text);
          if (salvaged) {
            warn('расписание: у узла «' + declaration.id + '» отброшены рассуждения до отчёта ('
              + (text.length - salvaged.length) + ' знаков), разделы сохранены');
            body = salvaged;
          }
        }
        const formatCheck = validateCriticReport(body);
        const fragment = text.slice(0, 200).replace(/\s+/gu, ' ');
        let report = null;
        let delivered = null;
        let awake = [];
        let wakeNote = null;
        let wakeError = null;
        let wakeRow = null;
        let problem = null;
        if (!failed && critic) {
          if (!body) {
            problem = 'в ответе нет отчёта — только рассуждения: ' + fragment;
          } else if (!formatCheck.ok) {
            problem = 'формат отчёта нарушен: ' + formatCheck.errors.join('; ') + ': ' + fragment;
          }
        }
        if (!failed && !problem && critic) {
          try {
            report = writeCriticReport(root, declaration, at || new Date(), body, reportTargets || []);
          } catch (error) {
            problem = 'отчёт не записан: ' + errorText(error);
            warn('расписание: отчёт узла «' + node + '» не записан: ' + errorText(error));
          }
          if (report) {
            /*
             * Судить надо письмо, а не файл: 10.11 01:32 файл был валиден по четырём
             * разделам, а письмо обрезано до 3981 знака и не содержало ни одного.
             * Усечение — по-прежнему 4000 знаков по границе строки, но перед
             * закрытием прогона проверяется уже усечённый текст. Если раздел не
             * влез, доставка не отправляется, а прогон получает error с причиной;
             * файл отчёта остаётся на диске как свидетельство.
             */
            const summary = reportSummary(body, report);
            const missing = CRITIC_SECTIONS.filter((name) => {
              const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
              return !new RegExp('^##\\s+' + escaped + '\\s*$', 'mu').test(summary);
            });
            if (missing.length > 0) {
              problem = 'разделы отчёта не влезли в предел письма: нет '
                + missing.map((name) => '«' + name + '»').join(', ');
            } else {
              /*
               * A file is a report on a desk; the box is the relation. Delivery is part of
               * success: if the message cannot be written, the run is an error, not "ok".
               */
              const delivery = await deliverReport({
                root,
                targets: reportTargets || [],
                report,
                summary,
                graph,
                parent,
                from: declaration.id,
                thread: 'critic-report',
                subject: 'отчёт ' + declaration.id + ' за ' + String(report).replace(/^.*\//u, '').replace(/\.md$/u, ''),
                at: at || new Date(),
                timeZone: declaration.schedule && declaration.schedule.timeZone,
              });
              delivered = delivery.delivered;
              awake = delivery.awake;
              wakeRow = delivery.wakeRow;
              wakeNote = delivery.wakeNote;
              wakeError = delivery.wakeError;
              problem = delivery.problem;
            }
          }
        }
        /*
         * 0195: the tester's scheduled run. The file is docs/tester/<day>.md with the
         * letter header, a repeated run of the same day overwrites it, and the report
         * letter goes to the report edge addressees or to the coordinator. The run is
         * done only after both the file and the delivery exist.
         */
        if (!failed && !problem && other) {
          const targets = Array.isArray(reportTargets) && reportTargets.length > 0
            ? reportTargets
            : ['coordinator'];
          const reportThread = reportThreadOf(declaration, 'tester-report');
          try {
            report = writeTesterReport(root, declaration, at || new Date(), text, targets, reportThread);
          } catch (error) {
            problem = 'отчёт не записан: ' + errorText(error);
            warn('расписание: отчёт узла «' + node + '» не записан: ' + errorText(error));
          }
          if (report) {
            const delivery = await deliverReport({
              root,
              targets,
              report,
              summary: reportSummary(text, report),
              graph,
              parent,
              from: declaration.id,
              thread: reportThreadOf(declaration, 'tester-report'),
              subject: 'отчёт ' + declaration.id + ' за ' + reportDay(declaration, at || new Date()),
              at: at || new Date(),
              timeZone: declaration.schedule && declaration.schedule.timeZone,
            });
            delivered = delivery.delivered;
            awake = delivery.awake;
            wakeRow = delivery.wakeRow;
            wakeNote = delivery.wakeNote;
            wakeError = delivery.wakeError;
            problem = delivery.problem;
          }
        }
        /*
         * 0197: ledger обмена — состояние на каждое исходящее report-ребро.
         * Прогон, который собирался закрыться done, обязан доказать доставку
         * (report + delivered); иначе он закрывается error с причиной
         * edge-obligation, а не "done по отсутствию ошибки" (кейс 04:00).
         */
        const edgeFacts = {
          state: failed || problem ? 'error' : 'done',
          ...(report ? { report } : {}),
          ...(delivered ? { delivered } : {}),
        };
        const edges = edgeStates(graph, declaration, edgeFacts);
        if (!failed && !problem) {
          const closure = validateClosure(graph, declaration, { ...edgeFacts, state: 'done' });
          if (!closure.ok) problem = closure.errors.join('; ');
        }
        const state = failed || problem ? 'error' : 'done';
        record(root, node, since, {
          state,
          finishedAt: Date.now(),
          childId: activation && activation.childId,
          attempt,
          ...(attemptModel ? { model: attemptModel } : {}),
          ...(report ? { report } : {}),
          ...(delivered ? { delivered } : {}),
          ...(edges.length > 0 ? { edges } : {}),
          ...(awake.length > 0 ? { awake } : {}),
          ...(wakeRow ? { wake: wakeRow } : {}),
          ...(wakeNote ? { wakeNote } : {}),
          ...(wakeError ? { wakeError } : {}),
          /* The schema's slot: filled later by whoever acknowledges the report. */
          ack: null,
          ...(problem ? { message: problem } : (failed ? { message: failureNote || 'агент завершился без отчёта' } : {})),
        });
        /*
         * Другая модель лечит ровно одно: прогон, который не дошёл до отчёта. Отчёт уже
         * записан — значит модель ответила, и повтор звал бы её сызнова без причины;
         * неудача доставки — дело адресата, а не повод жечь второй прогон.
         */
        if (state === 'error' && !report) retryWindow(root, declaration, run, at);
      },
      (error) => {
        record(root, node, since, {
          state: 'error',
          finishedAt: Date.now(),
          childId: activation && activation.childId,
          attempt,
          ...(attemptModel ? { model: attemptModel } : {}),
          message: errorText(error),
        });
        /* Упавший прогон (отказ активации) — тот же случай: модель не ответила. */
        retryWindow(root, declaration, run, at);
      },
    );
  }

  /**
   * One pass over every allowed root. Exposed for tests; the host calls it on a
   * timer. An optional `at` pins the clock.
   */
  async function tick(atInput) {
    if (ticking || stopped) return [];
    ticking = true;
    const launched = [];
    try {
      const at = atInput instanceof Date ? atInput : (atInput === undefined ? now() : new Date(atInput));
      const roots = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
      for (const root of roots) {
        let payload;
        try {
          payload = readGraph(runtime, root);
        } catch (error) {
          warn('расписание: структура «' + root + '» не прочиталась: ' + errorText(error));
          continue;
        }
        if (!payload || payload.errors.length > 0) continue;
        for (const node of payload.graph.nodes || []) {
          /*
           * A critic added by hand to structure/graph.json has no base spec yet: the
           * host lays the template down on its first tick, exactly as creating the
           * node through the panel would. An existing spec is never overwritten.
           */
          if (isCriticNode(node)) {
            try {
              ensureCriticSpec(root);
            } catch {
              /* a file problem must not stop the timer */
            }
          }
          /*
           * 0344: таймкипер активируется таймерами своих периодов (предупреждение
           * и начало). Монитор и schedule.at — разные вещи: первый не заменяет
           * второй. Вне окон тик не делает ничего и прогонов не тратит.
           */
          if (isTimekeeperNode(node)) {
            try {
              const notice = await activateTimekeeper(root, node, payload.graph, at);
              if (notice) launched.push(notice);
            } catch (error) {
              warn('таймкипер: узел «' + node.id + '» не отработал: ' + errorText(error));
            }
          }
          if (!node.schedule) {
            armed.delete(keyOf(root, node.id));
            continue;
          }
          let entry;
          try {
            entry = arm(root, node, at);
          } catch (error) {
            warn('расписание узла «' + node.id + '» не читается: ' + errorText(error));
            continue;
          }
          if (at.getTime() < entry.due.getTime()) continue;
          const late = at.getTime() - entry.due.getTime();
          try {
            entry.due = nextRunAt(node.schedule, at);
          } catch {
            entry.due = new Date(at.getTime() + DAY_MS);
          }
          /*
           * The timer may wake after a sleep or a long block. Anything later
           * than the grace window is a missed window: skip it, keep the next
           * declared time, never replay.
           */
          if (late > graceMs) {
            warn('расписание: окно узла «' + node.id + '» пропущено на ' + late
              + ' мс — запуск не догоняется, следующий по расписанию');
            continue;
          }
          try {
            const started = await launch(root, node, payload, at);
            if (started) launched.push(started);
          } catch (error) {
            warn('расписание: узел «' + node.id + '» не запустился: ' + errorText(error));
          }
        }
      }
      /*
       * The scheduler's timer is the one timer this plugin has ever proven to run in the
       * host. Riding the exchange pass on the same beat means mail is delivered even when
       * the watcher's own interval does not survive activation.
       */
      if (typeof options.onTick === 'function') {
        try {
          /*
           * Fire and forget: the extra pass must never hold the schedule hostage. A
           * wedged exchange pass awaited here stopped the scheduler's next beat entirely
           * (the live host showed a single tick and then silence).
           */
          Promise.resolve(options.onTick()).catch((error) => {
            warn('расписание: дополнительный проход не удался: ' + errorText(error));
          });
        } catch (error) {
          warn('расписание: дополнительный проход не запустился: ' + errorText(error));
        }
      }
    } finally {
      ticking = false;
    }
    return launched;
  }

  /**
   * Start the timer. The first pass only arms schedules: a window already missed
   * at boot is not fired, even when the first tick comes a moment later.
   */
  function start() {
    if (timer) return stop;
    stopped = false;
    Promise.resolve(tick()).catch((error) => warn('расписание: первый проход: ' + errorText(error)));
    timer = setInterval(() => {
      Promise.resolve(tick()).catch((error) => warn('расписание: проход: ' + errorText(error)));
    }, intervalMs);
    /* Never keep the host process alive just for the scheduler. */
    if (timer && typeof timer.unref === 'function') timer.unref();
    return stop;
  }

  /*
   * Stop only the timer. In-flight runs keep their own signal and are not cancelled:
   * a reload must not turn a working critic run into an empty answer.
   */
  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { tick, start, stop, armed };
}