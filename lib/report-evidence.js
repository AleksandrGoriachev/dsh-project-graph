/**
 * Evidence report validator: a structure step is closed by an artefact, not by a
 * sentence in the chat.
 *
 * The contract is coordination/CONTRACT-report-evidence.md (v1). A step writes
 * docs/tasks/<id>/report.<node>.json and this module checks it before the step is
 * allowed to close: required fields (P-1), an active task (P-2), a declared node
 * and role (P-3), evidence of work (P-4, P-7), a fresh exchange box (P-5), files
 * inside the task's allowed paths (P-6), a reason when blocked (P-8) and honest
 * times (P-10).
 *
 * Every refusal carries a stable code, a human-readable message, the list of what
 * is missing and the one action that fixes it. The same function is used by the
 * acceptance check and by the panel route POST /api/report-check, so the runtime
 * cannot accept what the check would reject.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseTaskMeta } from './contract.js';

/** Failure codes defined by the contract; nothing outside this set is returned. */
export const REPORT_CODES = [
  'report-missing',
  'report-invalid',
  'task-not-active',
  'node-unknown',
  'role-mismatch',
  'no-evidence',
  'inbox-stale',
  'inbox-incomplete',
  'outside-allowed-paths',
  'failing-command',
  'blocked-without-reason',
  'time-invalid',
  'time-implausible',
  'backfilled-not-evidence',
];

/** A report may be up to five minutes ahead of the machine clock (P-10). */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** ISO 8601 with an explicit offset; a local time without one is not evidence. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/u;

/** Build a contract-shaped refusal. */
function failure(code, message, missing = [], fix = '') {
  const list = [];
  for (const item of Array.isArray(missing) ? missing : [missing]) {
    const text = String(item === undefined || item === null ? '' : item).trim();
    if (text && !list.includes(text)) list.push(text);
  }
  return {
    ok: false,
    code,
    message: String(message || 'отчёт не принят'),
    missing: list,
    fix: String(fix || 'Исправьте отчёт и повторите проверку.'),
  };
}

/** Normalize a path for comparison: forward slashes, no leading ./ or slash. */
function normalizedPath(value) {
  return String(value || '').replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/^\/+/, '').replace(/\/+$/u, '');
}

/** Compare paths the way the running platform does. */
function pathKey(value) {
  const text = normalizedPath(value);
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/** Parse an ISO timestamp that carries an offset, or null. */
function zonedTime(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!ISO_WITH_OFFSET.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** Render an instant as ISO 8601 with the machine's offset, for messages. */
function stamp(ms) {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const local = new Date(date.getTime() + offset * 60 * 1000).toISOString().slice(0, 19);
  return local + sign + hours + ':' + minutes;
}

/** Read the report path: absolute or relative to the project root. */
function resolveReportFile(root, file) {
  const text = typeof file === 'string' ? file.trim() : '';
  if (!text) return null;
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text);
}

/**
 * Collect node declarations from every structure fragment.
 *
 * The graph may be split over several files; a node declared in any of them is
 * declared. A missing or broken structure simply yields no nodes, which P-3 then
 * reports as node-unknown.
 */
function structureNodes(root, structureDir) {
  const nodes = [];
  const dir = path.resolve(root, structureDir || 'structure');
  const walk = (current, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.json$/iu.test(entry.name)) continue;
      try {
        const document = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!document || typeof document !== 'object' || !Array.isArray(document.nodes)) continue;
        for (const node of document.nodes) {
          if (!node || typeof node !== 'object' || typeof node.id !== 'string') continue;
          nodes.push({ ...node, file: path.relative(root, full).split(path.sep).join('/') });
        }
      } catch {
        /* a broken fragment is not this validator's subject */
      }
    }
  };
  walk(dir, 0);
  return nodes;
}

/**
 * Every letter in the exchange box (*.md under the box and its threads/).
 * Returns [{ file, relative, mtimeMs }], oldest first.
 */
function boxLetters(box) {
  if (!box) return [];
  const found = [];
  const roots = [path.join(box, 'threads'), box];
  const walk = (current, depth, base) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) walk(full, depth + 1, base);
        continue;
      }
      if (!entry.isFile() || !/\.md$/iu.test(entry.name)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      found.push({
        file: full,
        relative: path.relative(base, full).split(path.sep).join('/'),
        mtimeMs: stat.mtimeMs,
      });
    }
  };
  for (const base of roots) {
    /* threads/ is walked first; the box root afterwards. A file inside threads/
       would otherwise be listed twice under different relative names. */
    walk(base, 0, base);
  }
  const unique = new Map();
  for (const item of found) unique.set(path.resolve(item.file), item);
  return [...unique.values()].sort((left, right) => left.mtimeMs - right.mtimeMs);
}

/** Absolute box path from a declaration, resolved against its root. */
function boxPathOf(root, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text);
}

/**
 * The exchange box the project declares in its structure, or null.
 *
 * The route hands this value to the validator, so P-5 is checked against the
 * project's box. The box must not come from the request: a caller able to name
 * the box could point the freshness check at an empty folder.
 *
 * @param root - project root.
 * @param structureDir - structure folder name (default "structure").
 */
export function projectBox(root, structureDir = 'structure') {
  const dir = path.resolve(String(root || process.cwd()));
  try {
    const document = JSON.parse(fs.readFileSync(path.join(dir, structureDir || 'structure', 'graph.json'), 'utf8'));
    const folders = Array.isArray(document && document.folders) ? document.folders : [];
    for (const folder of folders) {
      const box = folder && folder.box;
      const value = typeof box === 'string' ? box : box && typeof box.path === 'string' ? box.path : '';
      if (!value) continue;
      const shared = box && box.root === 'shared';
      return boxPathOf(shared ? path.dirname(dir) : dir, value);
    }
  } catch {
    /* no declaration: P-5 has no box to compare against */
  }
  return null;
}

/** Resolve the box used for the freshness check, or null when it is unknown. */
function resolveBox(root, explicit, report) {
  const supplied = boxPathOf(root, explicit);
  if (supplied) return supplied;
  const declared = report && report.inbox ? boxPathOf(root, report.inbox.box) : null;
  if (declared) return declared;
  return projectBox(root);
}

/**
 * Previous report of the same node for the same task.
 *
 * A corrected report is a new file, so the current one is excluded by resolved
 * path. Only reports of this node are considered, and the newest checkedAt wins.
 */
function previousReport(root, taskDir, node, currentFile) {
  const candidates = [];
  const pushDir = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.json$/iu.test(entry.name)) continue;
      if (!/^report\./iu.test(entry.name)) continue;
      const name = entry.name.replace(/^report\./iu, '').replace(/\.json$/iu, '');
      if (name !== node && !name.startsWith(node + '.') && !name.startsWith(node + '-')) continue;
      candidates.push(path.join(dir, entry.name));
    }
  };
  pushDir(taskDir);
  pushDir(path.join(root, 'structure', 'reports'));
  let best = null;
  for (const candidate of candidates) {
    if (path.resolve(candidate) === path.resolve(currentFile)) continue;
    let document;
    try { document = JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch { continue; }
    const checked = document && document.inbox ? zonedTime(document.inbox.checkedAt) : null;
    if (checked === null) continue;
    if (!best || checked > best.checkedAt) {
      best = { file: candidate, checkedAt: checked, checkedText: String(document.inbox.checkedAt) };
    }
  }
  return best;
}

/** Does a relative path match one allowedPaths entry (exact, *, **)? */
function matchesPattern(relative, pattern) {
  const target = pathKey(relative);
  const raw = pathKey(pattern);
  if (!raw) return false;
  if (!raw.includes('*') && !raw.includes('?')) return target === raw || target.startsWith(raw + '/');
  let source = '^';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '*' && raw[index + 1] === '*') {
      if (raw[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
      continue;
    }
    if (char === '*') { source += '[^/]*'; continue; }
    if (char === '?') { source += '[^/]'; continue; }
    source += char.replace(/[.*+?^\${}()|[\]\\]/gu, '\\$&');
  }
  source += '$';
  return new RegExp(source, 'u').test(target);
}

/** Path of the repository configuration that owns P-6 exceptions. */
export const REPO_CONFIG = 'docs/subagent-workflow/workflow.config.json';

/**
 * guard.allow of the repository config — the only source of a P-6 exception.
 *
 * The report is the subject of the check, so it cannot also be the authority
 * that forgives it: a guard.allow inside the report body would let a step sign
 * its own permission and the same body would pass both the acceptance check and
 * the route. The task file is written by the same step as well, so it is data,
 * not authority. Only docs/subagent-workflow/workflow.config.json grants a file
 * outside allowedPaths, and only with an audit mark.
 */
function guardAllows(root) {
  const rows = [];
  try {
    const document = JSON.parse(fs.readFileSync(path.join(root, REPO_CONFIG), 'utf8'));
    const guard = document && typeof document === 'object' ? document.guard : null;
    if (guard && typeof guard === 'object' && !Array.isArray(guard) && Array.isArray(guard.allow)) rows.push(...guard.allow);
  } catch {
    /* no repository config is the normal case: allowedPaths is the whole rule */
  }
  const allowed = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      allowed.push({ pattern: row, audit: true });
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const pattern = typeof row.path === 'string' ? row.path : typeof row.file === 'string' ? row.file : '';
    if (!pattern) continue;
    const audit = [row.audit, row.reason, row.by, row.note, row.why]
      .some((value) => typeof value === 'string' && value.trim() !== '');
    if (audit) allowed.push({ pattern, audit: true });
  }
  return allowed;
}

/** A check may mark a command's failure as expected. */
function expectedFailure(check) {
  if (!check || typeof check !== 'object') return false;
  const status = String(check.status || '').toLowerCase();
  if (status === 'expected-fail' || status === 'expected-failure' || status === 'fail-expected' || status === 'expected') return true;
  return check.expectedFailure === true || check.expectedFail === true || check.expected === true;
}

/** Non-empty string from the first present field. */
function field(item, names) {
  for (const name of names) {
    if (typeof item[name] === 'string' && item[name].trim()) return item[name].trim();
  }
  return '';
}

/**
 * Validate one report artefact.
 *
 * @param options.root - project root (absolute, or resolved against cwd).
 * @param options.file - report path, absolute or relative to root.
 * @param options.box - exchange box path, absolute or relative to root.
 * @param options.now - reference instant for the future check (Date, ISO or ms).
 * @returns { ok: true, report } or { ok: false, code, message, missing, fix }.
 */
export function validateReport(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const root = path.resolve(String(input.root || process.cwd()));
  const file = resolveReportFile(root, input.file);
  const nowMs = (() => {
    const supplied = input.now;
    if (supplied instanceof Date) return Number.isFinite(supplied.getTime()) ? supplied.getTime() : Date.now();
    if (typeof supplied === 'number' && Number.isFinite(supplied)) return supplied;
    const parsed = zonedTime(supplied) ?? (typeof supplied === 'string' ? Date.parse(supplied) : null);
    return Number.isFinite(parsed) ? parsed : Date.now();
  })();

  /* P-1: the artefact exists and parses. */
  if (!file) {
    return failure('report-missing', 'отчёт не указан: шаг закрывается только файлом report.<node>.json',
      ['file'], 'Передайте path к docs/tasks/<id>/report.<node>.json.');
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return failure('report-missing', 'отчёта нет: ' + file,
      [path.relative(root, file).split(path.sep).join('/')],
      'Запишите report.<node>.json: version, node, время, команды, файлы, openItems.');
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    return failure('report-invalid', 'отчёт не разбирается как JSON: ' + (error && error.message ? error.message : 'ошибка'),
      ['валидный JSON'], 'Исправьте кавычки и запятые в ' + file + '.');
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return failure('report-invalid', 'отчёт должен быть JSON-объектом', ['объект { … }'], 'Перепишите отчёт как объект.');
  }
  if (report.version !== 1) {
    return failure('report-invalid', 'version отчёта должен быть 1, получено ' + JSON.stringify(report.version),
      ['version: 1'], 'Поставьте "version": 1 — иначе схема отчёта неизвестна.');
  }
  /*
   * §3: the skeleton of the report is mandatory and is checked before anything
   * else, whatever the verdict claims. "Nothing to report" is said by an empty
   * array, not by an absent field — an absent field only hides what was omitted,
   * and the same report is read by the acceptance check and by the route.
   */
  const MANDATORY = [
    ['verdict', 'verdict — done или blocked'],
    ['files', 'files[] — что изменено'],
    ['openItems', 'openItems[] — что осталось открытым'],
    ['commands', 'commands[] — что выполнено'],
  ];
  const absent = MANDATORY
    .filter(([key]) => report[key] === undefined || report[key] === null)
    .map(([, text]) => text);
  if (absent.length > 0) {
    return failure('report-invalid', 'в отчёте нет обязательных полей: ' + absent.join('; '),
      absent,
      'Допишите обязательные поля отчёта: пустой список — это [], а не отсутствие поля.');
  }
  if (typeof report.verdict !== 'string' || !['done', 'blocked'].includes(report.verdict.trim())) {
    return failure('report-invalid', 'verdict отчёта должен быть done или blocked, получено ' + JSON.stringify(report.verdict),
      ['verdict: done|blocked'],
      'Поставьте verdict: "done" (шаг закрыт с доказательствами) или "blocked" (нужна разблокировка).');
  }
  /*
   * §7 (v1.4): a report assembled after the fact is a record of history, not
   * evidence of a step. It must say where its times came from, and its verdict
   * cannot close the acceptance — otherwise a step is "aged" by retyping times.
   * Checked right after the skeleton and the verdict, before P-2: a closed task
   * must not be able to hide this refusal behind task-not-active.
   */
  if (report.backfilled === true) {
    const source = typeof report.timesSource === 'string' ? report.timesSource.trim().toLowerCase() : '';
    if (!['git', 'chat', 'memory'].includes(source)) {
      return failure('report-invalid', 'backfilled-отчёт не указал, откуда взяты времена: timesSource обязателен',
        ['timesSource: git|chat|memory'],
        'Добавьте timesSource: "git", "chat" или "memory" — источник, из которого восстановлены времена шага.');
    }
    if (report.verdict.trim() === 'done') {
      return failure('backfilled-not-evidence', 'backfilled-отчёт с verdict done приёмку не закрывает: это запись истории',
        ['verdict: blocked', 'новый отчёт по живым временам без backfilled'],
        'Снимите backfilled и запишите шаг по живым временам или поставьте verdict blocked с адресатом разблокировки.');
    }
  }

  const node = typeof report.node === 'string' ? report.node.trim() : '';
  const task = typeof report.task === 'string' ? report.task.trim() : '';
  const context = typeof report.context === 'string' ? report.context.trim() : '';
  if (!node) {
    return failure('report-invalid', 'в отчёте нет node', ['node'], 'Укажите id узла, который выполнил шаг.');
  }
  if (!task && !context) {
    return failure('report-invalid', 'в отчёте нет ни task, ни context', ['task|context'],
      'Укажите id задания (task) или контекст шага вне задания (context).');
  }
  if (!Array.isArray(report.commands)) {
    return failure('report-invalid', 'commands должен быть массивом', ['commands[]'], 'Перечислите команды: [{ cmd, exit, tail, at }].');
  }
  if (!Array.isArray(report.files)) {
    return failure('report-invalid', 'files должен быть массивом', ['files[]'], 'Перечислите файлы, которые изменены.');
  }
  if (!Array.isArray(report.openItems)) {
    return failure('report-invalid', 'openItems должен быть массивом', ['openItems[]'], 'Перечислите открытые пункты объектами.');
  }
  if (report.inbox !== undefined && (report.inbox === null || typeof report.inbox !== 'object' || Array.isArray(report.inbox))) {
    return failure('report-invalid', 'inbox должен быть объектом', ['inbox { checkedAt, new[] }'], 'Опишите проверку ящика объектом.');
  }

  const commands = Array.isArray(report.commands) ? report.commands : [];
  const files = Array.isArray(report.files) ? report.files : [];
  const openItems = Array.isArray(report.openItems) ? report.openItems : [];
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const inbox = report.inbox && typeof report.inbox === 'object' && !Array.isArray(report.inbox) ? report.inbox : null;
  const verdict = report.verdict.trim();

  /* P-10: honest, zoned times. */
  const startedAt = zonedTime(report.startedAt);
  const completedAt = zonedTime(report.completedAt);
  const timeMissing = [];
  if (startedAt === null) timeMissing.push('startedAt — ISO 8601 со смещением');
  if (completedAt === null) timeMissing.push('completedAt — ISO 8601 со смещением');
  if (startedAt !== null && startedAt > nowMs + FUTURE_TOLERANCE_MS) {
    timeMissing.push('startedAt не в будущем больше 5 минут');
  }
  if (completedAt !== null && completedAt > nowMs + FUTURE_TOLERANCE_MS) {
    timeMissing.push('completedAt не в будущем больше 5 минут');
  }
  if (startedAt !== null && completedAt !== null && completedAt < startedAt) {
    timeMissing.push('completedAt ≥ startedAt');
  }
  if (inbox) {
    const checkedAt = zonedTime(inbox.checkedAt);
    if (checkedAt === null) timeMissing.push('inbox.checkedAt — ISO 8601 со смещением');
    else if (checkedAt > nowMs + FUTURE_TOLERANCE_MS) timeMissing.push('inbox.checkedAt не в будущем больше 5 минут');
  }
  for (const [index, command] of commands.entries()) {
    if (command && typeof command === 'object' && command.at !== undefined && zonedTime(command.at) === null) {
      timeMissing.push('commands[' + index + '].at — ISO 8601 со смещением');
    }
  }
  if (timeMissing.length > 0) {
    return failure('time-invalid', 'время отчёта не по контракту: ' + timeMissing.join('; '),
      timeMissing, 'Поставьте ISO 8601 со смещением (+03:00), completedAt не раньше startedAt и не в будущем.');
  }

  /*
   * P-12: plausible times of one step. Every event of the step — each command and
   * the box check — lies inside [startedAt, completedAt], and commands do not all
   * share one timestamp: a copied time is the mark of a report written from a
   * template instead of from the run. Runs before P-2 and P-5: an implausible
   * report is a forged one, whatever its task state and whatever the box says.
   */
  const implausible = [];
  const withinStep = (name, value) => {
    if (value === null) return;
    if (value < startedAt) implausible.push(name + ' = ' + stamp(value) + ' раньше startedAt ' + stamp(startedAt));
    else if (value > completedAt) implausible.push(name + ' = ' + stamp(value) + ' позже completedAt ' + stamp(completedAt));
  };
  const commandTimes = [];
  for (const [index, command] of commands.entries()) {
    if (!command || typeof command !== 'object') continue;
    const at = zonedTime(command.at);
    if (at === null) continue;
    commandTimes.push(at);
    withinStep('commands[' + index + '].at', at);
  }
  if (inbox) withinStep('inbox.checkedAt', zonedTime(inbox.checkedAt));
  if (commandTimes.length > 1 && new Set(commandTimes).size === 1) {
    implausible.push('все ' + commandTimes.length + ' команд помечены одним временем ' + stamp(commandTimes[0])
      + ' — признак копирования времён');
  }
  if (implausible.length > 0) {
    return failure('time-implausible', 'времена отчёта неправдоподобны: события шага не помещаются в его границы',
      implausible,
      'Проставьте каждой команде её собственное время из системных часов; checkedAt — момент проверки ящика, не позже completedAt.');
  }

  /* P-2: the task exists, is locked and is not accepted yet. */
  let taskDir = null;
  let meta = null;
  if (task) {
    if (task.includes('/') || task.includes('\\') || task === '.' || task === '..') {
      return failure('report-invalid', 'id задания не может быть путём: ' + task, ['task'], 'Укажите id каталога из docs/tasks/.');
    }
    taskDir = path.join(root, 'docs', 'tasks', task);
    const taskFile = path.join(taskDir, 'task.md');
    if (!fs.existsSync(taskFile)) {
      return failure('task-not-active', 'задания ' + task + ' нет: ' + path.relative(root, taskDir).split(path.sep).join('/'),
        [path.relative(root, taskFile).split(path.sep).join('/')],
        'Проверьте id задания в отчёте или заведите docs/tasks/' + task + '/task.md.');
    }
    if (!fs.existsSync(path.join(taskDir, 'criteria.lock'))) {
      return failure('task-not-active', 'у задания ' + task + ' нет criteria.lock',
        ['docs/tasks/' + task + '/criteria.lock'],
        'Задание должно быть заперто (criteria.lock) до выполнения шага.');
    }
    if (fs.existsSync(path.join(taskDir, 'acceptance.json'))) {
      return failure('task-not-active', 'задание ' + task + ' уже принято: отчёт после приёмки неизменяем',
        ['docs/tasks/' + task + '/acceptance.json отсутствует'],
        'Новый отчёт оформляется как новый шаг с supersedes; принятое задание не переписывается.');
    }
    try { meta = parseTaskMeta(fs.readFileSync(taskFile, 'utf8')); } catch { meta = null; }
  }

  /* P-3: the node is declared by the structure and the role matches. */
  const nodes = structureNodes(root, input.structureDir || 'structure');
  const declared = nodes.find((item) => String(item.id).toLowerCase() === node.toLowerCase());
  if (!declared) {
    return failure('node-unknown', 'узла «' + node + '» нет в structure/graph.json',
      ['node: ' + node + ' объявлен в структуре'],
      'Возьмите id узла из structure/graph.json; отчёт не создаёт узлы.');
  }
  const declaredRole = typeof declared.role === 'string' ? declared.role.trim() : '';
  const reportRole = typeof report.role === 'string' ? report.role.trim() : '';
  if (declaredRole && reportRole && declaredRole.toLowerCase() !== reportRole.toLowerCase()) {
    return failure('role-mismatch', 'роль отчёта «' + reportRole + '» не совпадает с ролью узла «' + declaredRole + '»',
      ['role: ' + declaredRole],
      'Поставьте role: ' + JSON.stringify(declaredRole) + ', как объявлено в структуре.');
  }

  /* P-4: verdict done needs evidence, P-7: no unexplained failing command. */
  if (verdict === 'done') {
    const passing = commands.filter((command) => command && typeof command === 'object' && command.exit === 0);
    const checksPass = checks.length > 0 && checks.every((check) => {
      const status = String(check && check.status ? check.status : '').toLowerCase();
      return status === 'pass' || status === 'passed';
    });
    if (passing.length === 0 && !checksPass) {
      return failure('no-evidence', 'verdict done без доказательств: нет команды с exit 0 и нет checks со статусом pass',
        ['commands[].exit: 0', 'или checks[].status: pass'],
        'Добавьте выполненную команду с exit 0 (cmd, tail, at) или проверки checks с evidence.');
    }
    const expected = new Set();
    for (const check of checks) {
      if (!expectedFailure(check)) continue;
      const command = field(check, ['cmd', 'command', 'cmdline']);
      if (command) expected.add(pathKey(command));
    }
    const failing = commands.filter((command) => {
      if (!command || typeof command !== 'object') return false;
      if (command.exit === 0 || command.exit === undefined || command.exit === null || command.exit === false) return false;
      if (command.expectedFailure === true || command.expectedFail === true) return false;
      return !expected.has(pathKey(field(command, ['cmd', 'command', 'cmdline'])));
    });
    if (failing.length > 0) {
      return failure('failing-command', 'verdict done, но команды падали: ' + failing.length,
        failing.map((command) => 'commands[] exit ' + command.exit + ': ' + field(command, ['cmd', 'command', 'cmdline'])),
        'Уберите падающие команды, исправьте их или пометьте ожидаемое падение в checks (expectedFailure: true).');
    }
  }

  /* P-5: the exchange box was checked after every letter that arrived. */
  if (inbox) {
    const box = resolveBox(root, input.box, report);
    const checkedAt = zonedTime(inbox.checkedAt);
    const declaredNew = Array.isArray(inbox.new) ? inbox.new.map((item) => pathKey(String(item))) : [];
    const listed = (relative) => {
      const key = pathKey(relative);
      const base = key.split('/').pop();
      return declaredNew.some((entry) => entry === key || entry.endsWith('/' + key) || (base && (entry === base || entry.endsWith('/' + base))));
    };
    const previous = taskDir ? previousReport(root, taskDir, node, file) : null;
    const threshold = previous ? previous.checkedAt : startedAt;
    const stale = [];
    if (previous && checkedAt <= previous.checkedAt) {
      stale.push('inbox.checkedAt новее ' + stamp(previous.checkedAt));
    }
    /*
     * The window of this report is (previous check, completedAt]: letters that
     * arrived while the step ran. A letter newer than completedAt belongs to the
     * next step — it cannot be read by this report and must not age it, so a new
     * letter neither enters new[] nor produces inbox-stale.
     */
    const letters = boxLetters(box)
      .filter((letter) => letter.mtimeMs > threshold && letter.mtimeMs <= completedAt);
    const incomplete = [];
    for (const letter of letters) {
      /*
       * Listed letters are acknowledged: the report saw them, whatever the second
       * resolution of the timestamps. Only an unlisted letter is a failure; one
       * that arrived after checkedAt makes the check stale, one that arrived
       * before it but is absent from new[] makes the list incomplete.
       */
      if (listed(letter.relative)) continue;
      if (letter.mtimeMs > checkedAt) stale.push(letter.relative);
      else incomplete.push(letter.relative);
    }
    if (stale.length > 0) {
      const newest = letters.reduce((max, letter) => Math.max(max, letter.mtimeMs), threshold);
      stale.push('inbox.checkedAt новее ' + stamp(newest));
      return failure('inbox-stale', 'ящик не проверялся: письма пришли позже inbox.checkedAt',
        stale,
        'Перечитайте папку обмена, обновите inbox.checkedAt после последнего письма и повторите отчёт.');
    }
    if (incomplete.length > 0) {
      return failure('inbox-incomplete', 'в inbox.new[] нет писем, которые пришли после прошлой проверки',
        incomplete,
        'Перечислите эти письма в inbox.new[] (относительно ящика) и обновите checkedAt.');
    }
  }

  /* P-6: touched files stay inside the task's allowed paths or an audited guard. */
  if (meta && Array.isArray(meta.allowedPaths) && meta.allowedPaths.length > 0) {
    const guard = guardAllows(root);
    const outside = [];
    for (const entry of files) {
      const value = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : '';
      if (!value.trim()) continue;
      const relative = normalizedPath(value);
      const allowed = meta.allowedPaths.some((pattern) => matchesPattern(relative, pattern))
        || guard.some((item) => matchesPattern(relative, item.pattern));
      if (!allowed) outside.push(value);
    }
    if (outside.length > 0) {
      return failure('outside-allowed-paths', 'отчёт трогает файлы вне allowedPaths задания',
        outside,
        'Уберите эти файлы из files[] или внесите разрешение с меткой аудита в guard.allow файла '
        + REPO_CONFIG + ': разрешение из тела отчёта не действует.');
    }
  }

  /* P-8: blocked is a claim with an addressee, not a mood. */
  if (verdict === 'blocked') {
    const missing = [];
    if (openItems.length === 0) {
      missing.push('openItems[] с причиной и адресатом разблокировки');
    } else {
      openItems.forEach((item, index) => {
        const reason = item && typeof item === 'object' ? field(item, ['reason', 'why', 'text', 'description', 'item', 'title']) : '';
        const addressee = item && typeof item === 'object'
          ? field(item, ['addressee', 'to', 'owner', 'assignee', 'unblockedBy', 'by'])
          : '';
        if (!reason) missing.push('openItems[' + index + '].reason');
        if (!addressee) missing.push('openItems[' + index + '].addressee');
      });
    }
    if (missing.length > 0) {
      return failure('blocked-without-reason', 'verdict blocked без причины и адресата разблокировки',
        missing,
        'Опишите каждый открытый пункт: { reason, addressee } — кого просить разблокировать шаг.');
    }
  }

  return { ok: true, report };
}

/** Alias kept for callers written against the check's fallback name. */
export const checkReport = validateReport;
