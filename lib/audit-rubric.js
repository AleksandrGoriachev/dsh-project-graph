/**
 * Задание 0368: рубрика качества постановки задания — реестр пунктов.
 *
 * Заказчик: качество задания проверяется машиной, а не на глаз. Факт 26.11:
 * задание 0366 обязывало поднять версию пакета, но правка
 * test/release-install.test.mjs (там версия закреплена литералом) не была
 * разрешена в allowedPaths — исполнитель выяснил это через 25 минут, задание
 * отменили и переоформили. Машина видит это сразу.
 *
 * Модуль — один реестр пунктов (RUBRIC): код, название и чистая функция над
 * входом { taskDir, id, risk, allowedPaths, criteria, redResult, baseLog, git }.
 * Чистая здесь значит: никакой сети, никакой записи, никакого git-процесса;
 * всё, что нужно, приходит входом (git — адаптер чтения дерева, см.
 * createGitAdapter). Ошибка разбора артефакта — это fail пункта с доказательством,
 * а не падение команды (инвариант 4 задания).
 *
 * Вердикт без доказательства не считается (инвариант 3): пункт, вернувший
 * пустое evidence, получает fail «пункт не назвал доказательство».
 *
 * Модуль зовут двое, поэтому они говорят одно и то же:
 *   tools/audit-check.mjs — CLI пишет docs/tasks/<id>/audit-evidence.json;
 *   lib/spawn.js — гейт запуска пересчитывает рубрику тем же модулем и
 *   отказывает, если evidence нет у риска medium и выше, рубрика неполная или
 *   вердикт аудитора по пункту расходится с вычисленным.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseTaskMeta } from './contract.js';

/** Версия схемы audit-evidence.json, которую понимает эта рубрика. */
export const RUBRIC_VERSION = 1;

/** Уровни риска: medium и выше требуют машинного доказательства рубрики. */
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 2 };

/** С какого ранга нужен негативный критерий и audit-evidence.json. */
const MEDIUM_RANK = 1;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Ранг риска; неизвестный риск ведёт себя как low (прежнее поведение). */
export function riskRank(risk) {
  const key = text(risk).toLowerCase();
  return Object.prototype.hasOwnProperty.call(RISK_RANK, key) ? RISK_RANK[key] : 0;
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** JSON каталога задания; null — файла нет или он не разбирается (fail пункта). */
function readJsonFile(file) {
  const raw = readTextFile(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw.replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- *
 * allowedPaths: те же правила, что у контракта (lib/contract.js).
 *
 * Шаблон: * — сегмент, ** — любая глубина. Копия нужна потому, что contract.js
 * не экспортирует сопоставление, а менять его задание не разрешает; поведение
 * обязано совпадать, иначе «разрешено» в рубрике и в контракте разойдутся.
 * ------------------------------------------------------------------------- */

function pathPatternKey(value) {
  return String(value || '')
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '')
    .replace(/^\/+/u, '')
    .replace(/\/+$/u, '')
    .toLowerCase();
}

function globMatches(relative, pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
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
    source += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  source += '$';
  try {
    return new RegExp(source, 'u').test(relative);
  } catch {
    return false;
  }
}

/**
 * Входит ли путь в allowedPaths задания.
 *
 * @param allowedPaths - список шаблонов из TASK-META.
 * @param file - путь от корня проекта (прямые или обратные слэши).
 * @returns true, если хоть один шаблон покрывает путь.
 */
export function coversPath(allowedPaths, file) {
  const key = pathPatternKey(file);
  if (!key) return false;
  const list = Array.isArray(allowedPaths) ? allowedPaths : [];
  return list.some((item) => typeof item === 'string' && globMatches(key, pathPatternKey(item)));
}

/* ------------------------------------------------------------------------- *
 * Разбор задания и контракта.
 * ------------------------------------------------------------------------- */

const CRITERIA_BLOCK = /<!--\s*CRITERIA:BEGIN\s*-->([\s\S]*?)<!--\s*CRITERIA:END\s*-->/u;
const ACTION_HEADING = /^##\s+Что сделать\s*$/imu;

function stripBackticks(value) {
  return String(value === undefined || value === null ? '' : value).replace(/`/gu, '').trim();
}

function normalizeCommand(value) {
  return stripBackticks(value).replace(/\s+/gu, ' ').trim();
}

/**
 * Таблица «Критерии приёмки» из задания: id, команда, ожидание.
 *
 * Таблица живёт между <!-- CRITERIA:BEGIN --> и <!-- CRITERIA:END -->; строки
 * заголовка и разделителя пропускаются. Нет блока — пустой список (это fail
 * пункта goal_measured, а не падение).
 *
 * @param taskText - текст task.md.
 * @returns [{ id, command, expectation }]
 */
export function parseCriteriaTable(taskText) {
  const match = CRITERIA_BLOCK.exec(String(taskText || ''));
  const block = match ? match[1] : '';
  const rows = [];
  for (const line of block.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const id = cells[0];
    if (!id || /^id$/iu.test(id) || /^:?-{2,}:?$/u.test(id)) continue;
    const command = normalizeCommand(cells[1]);
    if (!command) continue;
    rows.push({ id, command, expectation: cells[2] || '' });
  }
  return rows;
}

/** Путь в «Что сделать»: обратные кавычки, без пробелов, с каталогом. */
function looksLikeActionPath(token) {
  if (!token || /\s/u.test(token)) return false;
  if (!/^[A-Za-z0-9_.@\-/*]+$/u.test(token)) return false;
  if (token.startsWith('-') || token.startsWith('/')) return false;
  if (!token.includes('/')) return false;
  return /\.[A-Za-z0-9]+$/u.test(token) || /\/\*\*$/u.test(token) || token.includes('/**/');
}

/**
 * Пути, названные в разделе «Что сделать».
 *
 * Раздел ищется по заголовку ## Что сделать и заканчивается следующим ##.
 * Названным путём считается токен в обратных кавычках с каталогом: имена
 * файлов без каталога (audit-evidence.json) — это имена артефактов каталога
 * задания, а не путь от корня проекта, и проверять их покрытие нечем.
 *
 * @param taskText - текст task.md.
 * @returns {string[]|null} пути; null — раздела нет.
 */
export function parseActionPaths(taskText) {
  const source = String(taskText || '');
  const heading = ACTION_HEADING.exec(source);
  if (!heading) return null;
  const rest = source.slice(heading.index + heading[0].length);
  const next = /^##\s+/mu.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  const paths = [];
  for (const match of section.matchAll(/`([^`\n]+)`/gu)) {
    const token = match[1].trim();
    if (!looksLikeActionPath(token)) continue;
    if (!paths.includes(token)) paths.push(token);
  }
  return paths;
}

/** Путь, названный в команде критерия: test/a.test.mjs, checks/x.mjs. */
function looksLikeCriterionPath(token) {
  if (!token) return false;
  if (token.startsWith('-') || token.includes('=') || token.includes('<') || token.includes('>')) return false;
  if (!token.includes('/') && !/\.[A-Za-z0-9]+$/u.test(token)) return false;
  if (token === '.' || token === '..') return false;
  return /^[A-Za-z0-9_.@\-/]+$/u.test(token);
}

function criterionPaths(criteria) {
  const list = criteria && Array.isArray(criteria.criteria) ? criteria.criteria : [];
  const paths = [];
  for (const item of list) {
    const command = normalizeCommand(isPlainObject(item) ? item.command : '');
    for (const token of command.split(/\s+/u)) {
      if (!looksLikeCriterionPath(token)) continue;
      if (!paths.includes(token)) paths.push(token);
    }
  }
  return paths;
}

/* ------------------------------------------------------------------------- *
 * Адаптер чтения дерева: git-процесс в чистую функцию не пускаем.
 *
 * Рубрике нужны три факта о дереве проекта: существует ли файл (для
 * no_degenerate_criterion), какой у пакета текущий version (для
 * required_edits_covered) и какие файлы вообще есть (чтобы найти литерал
 * версии). Всё это передаётся входом; по умолчанию — чтение с диска от корня.
 * ------------------------------------------------------------------------- */

const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'artifacts', 'preview-out', 'coverage', '.dsh']);

function walkFiles(root, rel = '', depth = 0, out = []) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const relPath = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      walkFiles(root, relPath, depth + 1, out);
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

/** Версия пакета из package.json корня; null — файла нет или он не разбирается. */
export function readPackageVersion(root) {
  const raw = readTextFile(path.join(path.resolve(String(root)), 'package.json'));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/u, ''));
    return isPlainObject(parsed) ? text(parsed.version) : null;
  } catch {
    return null;
  }
}

/**
 * Адаптер дерева проекта для рубрики.
 *
 * @param root - абсолютный корень проекта.
 * @returns { root, version, fileExists(rel), readFile(rel), listFiles() }
 */
export function createGitAdapter(root) {
  const base = path.resolve(String(root));
  const version = readPackageVersion(base);
  return {
    root: base,
    version,
    fileExists(rel) {
      try {
        return fs.existsSync(path.resolve(base, String(rel)));
      } catch {
        return false;
      }
    },
    readFile(rel) {
      try {
        return fs.readFileSync(path.resolve(base, String(rel)), 'utf8');
      } catch {
        return null;
      }
    },
    listFiles() {
      return walkFiles(base);
    },
  };
}

/** Корень проекта от каталога задания: вверх до package.json или structure/. */
function findProjectRoot(taskDir) {
  let dir = path.resolve(String(taskDir));
  for (let step = 0; step < 8; step += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'structure'))) return dir;
  }
  return path.resolve(String(taskDir), '..', '..', '..');
}

/**
 * Вход рубрики из каталога задания.
 *
 * Читает task.md, criteria.json, red.json, red.log и дерево проекта. Всё
 * читается снисходительно: отсутствие файла — это null, а не исключение
 * (ловушка 1 задания: красный прогон мог не оставить red.json).
 *
 * @param taskDir - каталог задания (docs/tasks/<id>).
 * @param options - { root?, git? }: корень проекта и адаптер дерева.
 * @returns вход рубрики { taskDir, id, risk, allowedPaths, criteria, redResult, baseLog, git, taskText, meta }
 */
export function readRubricInput(taskDir, options = {}) {
  const dir = path.resolve(String(taskDir));
  const taskText = readTextFile(path.join(dir, 'task.md')) || '';
  const meta = parseTaskMeta(taskText) || {};
  const id = text(meta.id) || path.basename(dir);
  const risk = text(meta.risk).toLowerCase();
  const allowedPaths = Array.isArray(meta.allowedPaths)
    ? meta.allowedPaths.filter((item) => typeof item === 'string')
    : [];
  const criteriaName = text(meta.criteria) || 'criteria.json';
  const criteria = readJsonFile(path.join(dir, criteriaName));
  const redResult = readJsonFile(path.join(dir, 'red.json'));
  const baseLog = readTextFile(path.join(dir, 'red.log')) || '';
  const root = options && options.root ? path.resolve(String(options.root)) : findProjectRoot(dir);
  const git = options && options.git ? options.git : createGitAdapter(root);
  return {
    taskDir: dir,
    id,
    risk,
    allowedPaths,
    criteria,
    redResult,
    baseLog,
    git,
    taskText,
    meta,
  };
}

/* ------------------------------------------------------------------------- *
 * Пункты рубрики.
 *
 * Каждый пункт — функция над входом, возвращающая { verdict, evidence }.
 * verdict: ok — требование выполнено, fail — нарушено, na — пункт к этому
 * заданию не применим (например, риск low и негативный тег не нужен).
 * evidence — доказательство: файл, строка или текст; пустым быть не может.
 * ------------------------------------------------------------------------- */

/** goal_measured: каждая команда таблицы «Критерии приёмки» есть в criteria.json. */
function goalMeasured(input) {
  const rows = parseCriteriaTable(input.taskText);
  if (rows.length === 0) {
    return {
      verdict: 'fail',
      evidence: 'в task.md нет таблицы «Критерии приёмки» (блок <!-- CRITERIA:BEGIN -->): измерять нечего',
    };
  }
  if (!isPlainObject(input.criteria)) {
    return { verdict: 'fail', evidence: 'нет criteria.json (или он не разбирается): командам таблицы не с чем сверяться' };
  }
  const list = Array.isArray(input.criteria.criteria) ? input.criteria.criteria : [];
  const commands = new Set(list.map((item) => normalizeCommand(isPlainObject(item) ? item.command : '')));
  const missing = rows.filter((row) => !commands.has(row.command));
  if (missing.length > 0) {
    return {
      verdict: 'fail',
      evidence: 'команд в таблице ' + rows.length + ', в criteria.json ' + commands.size
        + '; нет в критериях: ' + missing.map((row) => row.id + ' «' + row.command + '»').join(', '),
    };
  }
  return {
    verdict: 'ok',
    evidence: 'все ' + rows.length + ' команд таблицы (' + rows.map((row) => row.id).join(', ')
      + ') есть в criteria.json',
  };
}

/** reason_from_output: причина ожидания красного встречается в выводе базы. */
function reasonFromOutput(input) {
  const redExpect = isPlainObject(input.criteria) && isPlainObject(input.criteria.redExpect)
    ? input.criteria.redExpect
    : null;
  const reasons = redExpect && isPlainObject(redExpect.reasons) ? redExpect.reasons : {};
  const pairs = [];
  for (const [id, value] of Object.entries(reasons)) {
    const reason = typeof value === 'string' ? text(value) : text(value && (value.reason || value.text));
    if (reason) pairs.push({ id, reason });
  }
  if (pairs.length === 0) {
    return { verdict: 'na', evidence: 'criteria.json redExpect.reasons пуст: причин красного не объявлено' };
  }
  const log = String(input.baseLog || '');
  if (!log.trim()) {
    return {
      verdict: 'fail',
      evidence: 'нет вывода базы (docs/tasks/' + input.id + '/red.log): причинам ' + pairs.map((pair) => pair.id).join(', ')
        + ' не с чем сверяться',
    };
  }
  const haystack = log.toLowerCase();
  const missing = pairs.filter((pair) => !haystack.includes(pair.reason.toLowerCase()));
  if (missing.length > 0) {
    return {
      verdict: 'fail',
      evidence: 'в red.log нет причин: ' + missing.map((pair) => pair.id + ' «' + pair.reason + '»').join(', ')
        + '; найдены: ' + pairs.filter((pair) => !missing.includes(pair)).map((pair) => pair.id).join(', '),
    };
  }
  return {
    verdict: 'ok',
    evidence: 'все причины (' + pairs.map((pair) => pair.id + ' «' + pair.reason + '»').join(', ') + ') есть в red.log',
  };
}

/** mustpass_green_on_base: критерии, объявленные зелёными на базе, прошли. */
function mustpassGreenOnBase(input) {
  const redExpect = isPlainObject(input.criteria) && isPlainObject(input.criteria.redExpect)
    ? input.criteria.redExpect
    : null;
  const mustPass = redExpect && Array.isArray(redExpect.mustPass)
    ? redExpect.mustPass.map((item) => text(item)).filter(Boolean)
    : [];
  if (mustPass.length === 0) {
    return { verdict: 'na', evidence: 'criteria.json redExpect.mustPass пуст: зелёных на базе не объявлено' };
  }
  if (!isPlainObject(input.redResult) || !Array.isArray(input.redResult.results)) {
    return {
      verdict: 'fail',
      evidence: 'нет red.json (или он не разбирается): нечем подтвердить, что на базе прошли ' + mustPass.join(', '),
    };
  }
  const results = input.redResult.results;
  const bad = [];
  for (const id of mustPass) {
    const row = results.find((item) => isPlainObject(item) && text(item.id) === id);
    if (!row) {
      bad.push(id + ' (нет результата)');
      continue;
    }
    const green = row.passed === true || (row.exitCode === 0 && row.timedOut !== true);
    if (!green) bad.push(id + ' (exit ' + (row.exitCode === undefined ? '?' : row.exitCode) + ')');
  }
  if (bad.length > 0) {
    return {
      verdict: 'fail',
      evidence: 'на базе не зелёные: ' + bad.join(', ') + ' — mustPass обещает их проход',
    };
  }
  return { verdict: 'ok', evidence: 'на базе зелёные: ' + mustPass.join(', ') + ' (red.json results)' };
}

/** no_degenerate_criterion: критерий не проверяет файл, которого нет и не будет. */
function noDegenerateCriterion(input) {
  if (!isPlainObject(input.criteria)) {
    return { verdict: 'fail', evidence: 'нет criteria.json (или он не разбирается): критериев нет' };
  }
  const paths = criterionPaths(input.criteria);
  if (paths.length === 0) {
    return { verdict: 'na', evidence: 'критерии не называют файлов: вырожденных путей нет' };
  }
  const git = input.git || createGitAdapter(findProjectRoot(input.taskDir));
  const degenerate = [];
  for (const rel of paths) {
    const exists = typeof git.fileExists === 'function' ? git.fileExists(rel) : false;
    if (!exists && !coversPath(input.allowedPaths, rel)) degenerate.push(rel);
  }
  if (degenerate.length > 0) {
    return {
      verdict: 'fail',
      evidence: 'файлов нет ни в базе, ни в allowedPaths: ' + degenerate.join(', ')
        + ' — красный «модуль не найден» законен только для нового артефакта, который разрешён',
    };
  }
  return {
    verdict: 'ok',
    evidence: 'все пути критериев (' + paths.join(', ') + ') есть в базе или разрешены allowedPaths',
  };
}

/** negative_tag_present: у риска medium и выше есть критерий с тегом negative. */
function negativeTagPresent(input) {
  if (riskRank(input.risk) < MEDIUM_RANK) {
    return { verdict: 'na', evidence: 'риск «' + (input.risk || '—') + '» ниже medium: негативный критерий не требуется' };
  }
  const list = isPlainObject(input.criteria) && Array.isArray(input.criteria.criteria) ? input.criteria.criteria : [];
  if (list.length === 0) {
    return { verdict: 'fail', evidence: 'риск «' + input.risk + '», но критериев нет: негативного тега негде взять' };
  }
  const negative = list.filter((item) => isPlainObject(item) && Array.isArray(item.tags)
    && item.tags.some((tag) => String(tag).trim().toLowerCase() === 'negative'));
  if (negative.length === 0) {
    return {
      verdict: 'fail',
      evidence: 'риск «' + input.risk + '», ни у одного критерия нет тега negative (теги: '
        + list.map((item) => text(item && item.id) + ' [' + (Array.isArray(item && item.tags) ? item.tags.join(',') : '') + ']').join('; ')
        + ')',
    };
  }
  return {
    verdict: 'ok',
    evidence: 'риск «' + input.risk + '», негативный тег у: ' + negative.map((item) => text(item.id)).join(', '),
  };
}

/** paths_covered: каждый путь из «Что сделать» входит в allowedPaths. */
function pathsCovered(input) {
  const paths = parseActionPaths(input.taskText);
  if (paths === null) {
    return { verdict: 'fail', evidence: 'в task.md нет раздела «Что сделать»: пути задания не названы' };
  }
  if (paths.length === 0) {
    return { verdict: 'na', evidence: 'раздел «Что сделать» не называет путей в обратных кавычках' };
  }
  const outside = paths.filter((rel) => !coversPath(input.allowedPaths, rel));
  if (outside.length > 0) {
    return {
      verdict: 'fail',
      evidence: 'вне allowedPaths: ' + outside.join(', ') + ' (названы в «Что сделать»: ' + paths.join(', ') + ')',
    };
  }
  return {
    verdict: 'ok',
    evidence: 'все ' + paths.length + ' путей «Что сделать» разрешены: ' + paths.join(', '),
  };
}

/** Файлы, которые несут версию релиза: код, тесты, манифест, документация выпуска. */
const HISTORICAL_PATH = [
  /^docs\/tasks\//u,
  /^docs\/archive\//u,
  /^docs\/critic\//u,
  /^docs\/subagent-workflow\//u,
  /^docs\/analysis\//u,
  /^docs\/HANDOVER/iu,
  /^artifacts\//u,
  /^preview-out\//u,
  /\.tgz$/iu,
];

function isReleaseSurface(rel) {
  const key = pathPatternKey(rel);
  if (!key) return false;
  if (HISTORICAL_PATH.some((pattern) => pattern.test(key))) return false;
  return /\.(?:js|mjs|cjs|json|md|ya?ml|ps1|ts|txt)$/iu.test(key);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** required_edits_covered: поднятие версии покрывает файлы с литералом текущей версии. */
function requiredEditsCovered(input) {
  const git = input.git || createGitAdapter(findProjectRoot(input.taskDir));
  const current = text(git.version);
  if (!current) {
    return { verdict: 'na', evidence: 'в корне нет package.json с version: поднимать нечего' };
  }
  const taskText = String(input.taskText || '');
  const versions = [...taskText.matchAll(/\b\d+\.\d+\.\d+\b/gu)].map((match) => match[0]);
  const mentionsVersion = /верси|release|релиз/iu.test(taskText);
  const target = mentionsVersion ? versions.find((value) => value !== current) || '' : '';
  if (!target) {
    return { verdict: 'na', evidence: 'задание не поднимает версию пакета (package.json: ' + current + ')' };
  }
  const files = typeof git.listFiles === 'function' ? git.listFiles().filter(isReleaseSurface) : [];
  /* Граница версии: не часть более длинной версии (1.0.890, 1.0.89.1), но точка конца фразы — не граница. */
  const literal = new RegExp('(?<![\\d.])' + escapeRegExp(current) + '(?!\\d)(?!\\.\\d)', 'u');
  const pins = files.filter((rel) => {
    const body = typeof git.readFile === 'function' ? git.readFile(rel) : null;
    return typeof body === 'string' && literal.test(body);
  });
  if (pins.length === 0) {
    return {
      verdict: 'fail',
      evidence: 'версия ' + current + ' → ' + target + ', но файлов с литералом текущей версии не нашлось: '
        + 'пересчитать правки нечем (дефект 0366 — непокрытый файл с литералом)',
    };
  }
  const uncovered = pins.filter((rel) => !coversPath(input.allowedPaths, rel));
  if (uncovered.length > 0) {
    return {
      verdict: 'fail',
      evidence: 'версия ' + current + ' → ' + target + '; литерал текущей версии в ' + pins.length + ' файлах ('
        + pins.join(', ') + '); вне allowedPaths: ' + uncovered.join(', ')
        + ' — задание обязано разрешить правку этих файлов (дефект 0366)',
    };
  }
  return {
    verdict: 'ok',
    evidence: 'версия ' + current + ' → ' + target + '; все ' + pins.length + ' файлов с литералом текущей версии ('
      + pins.join(', ') + ') разрешены allowedPaths',
  };
}

/** no_red_justified: если красный не требуется, причина непустая и названа. */
function noRedJustified(input) {
  if (!isPlainObject(input.criteria)) {
    return { verdict: 'fail', evidence: 'нет criteria.json: причину «красный не требуется» негде прочитать' };
  }
  const redExpect = isPlainObject(input.criteria.redExpect) ? input.criteria.redExpect : {};
  const mustFail = Array.isArray(redExpect.mustFail)
    ? redExpect.mustFail.map((item) => text(item)).filter(Boolean)
    : [];
  if (mustFail.length > 0) {
    return { verdict: 'na', evidence: 'красный требуется: mustFail ' + mustFail.join(', ') };
  }
  let reason = '';
  let source = '';
  const noRed = redExpect.noRed;
  if (typeof noRed === 'string') {
    reason = text(noRed);
    source = 'criteria.json redExpect.noRed';
  } else if (isPlainObject(noRed)) {
    reason = text(noRed.reason) || text(noRed.why);
    source = 'criteria.json redExpect.noRed.reason';
  }
  if (!reason) {
    const fromRed = isPlainObject(input.redResult) && isPlainObject(input.redResult.noRed) ? input.redResult.noRed : null;
    if (fromRed) {
      reason = text(fromRed.reason) || text(fromRed.why);
      source = 'red.json noRed.reason';
    }
  }
  if (!reason) {
    return {
      verdict: 'fail',
      evidence: 'красный не требуется (mustFail пуст), но причина пуста: criteria.json redExpect.noRed.reason '
        + 'не заполнен и mustFail не объявлен',
    };
  }
  return { verdict: 'ok', evidence: 'красный не требуется; причина (' + source + '): «' + reason + '»' };
}

/* ------------------------------------------------------------------------- *
 * Реестр пунктов.
 * ------------------------------------------------------------------------- */

/**
 * Реестр рубрики. Порядок — порядок таблицы и audit-evidence.json.
 * risks — к каким уровням риска пункт применим (ниже medium пункт сам даёт na).
 */
export const RUBRIC = Object.freeze([
  { code: 'goal_measured', title: 'каждая команда таблицы критериев есть в criteria.json', risks: ['low', 'medium', 'high'], check: goalMeasured },
  { code: 'reason_from_output', title: 'причина красного есть в выводе базы', risks: ['low', 'medium', 'high'], check: reasonFromOutput },
  { code: 'mustpass_green_on_base', title: 'объявленные зелёными критерии прошли на базе', risks: ['low', 'medium', 'high'], check: mustpassGreenOnBase },
  { code: 'no_degenerate_criterion', title: 'критерий не проверяет файл, которого нет и не будет', risks: ['low', 'medium', 'high'], check: noDegenerateCriterion },
  { code: 'negative_tag_present', title: 'у риска medium+ есть критерий с тегом negative', risks: ['medium', 'high'], check: negativeTagPresent },
  { code: 'paths_covered', title: 'пути «Что сделать» входят в allowedPaths', risks: ['low', 'medium', 'high'], check: pathsCovered },
  { code: 'required_edits_covered', title: 'поднятие версии покрывает файлы с литералом версии', risks: ['low', 'medium', 'high'], check: requiredEditsCovered },
  { code: 'no_red_justified', title: 'отсутствие красного объяснено причиной', risks: ['low', 'medium', 'high'], check: noRedJustified },
]);

/** Коды пунктов рубрики в порядке реестра. */
export const RUBRIC_CODES = Object.freeze(RUBRIC.map((item) => item.code));

/**
 * Посчитать рубрику по входу.
 *
 * Пункт не имеет права уронить команду: исключение пункта становится его
 * fail с доказательством-ошибкой (инвариант 4). Пустое evidence — тоже fail
 * (инвариант 3): вердикт без доказательства не считается.
 *
 * @param input - вход рубрики (см. readRubricInput).
 * @returns {{ version, items, failures, ok, counts }}
 */
export function computeRubric(input) {
  const source = isPlainObject(input) ? input : {};
  const items = RUBRIC.map((item) => {
    let result;
    try {
      result = item.check(source);
    } catch (error) {
      result = {
        verdict: 'fail',
        evidence: 'ошибка разбора артефакта: ' + (error && error.message ? error.message : String(error)),
      };
    }
    const verdict = result && ['ok', 'fail', 'na'].includes(result.verdict) ? result.verdict : 'fail';
    let evidence = text(result && result.evidence);
    if (!evidence) {
      return { code: item.code, title: item.title, verdict: 'fail', evidence: 'пункт не назвал доказательство' };
    }
    return { code: item.code, title: item.title, verdict, evidence };
  });
  const failures = items.filter((item) => item.verdict === 'fail').map((item) => item.code);
  const counts = { ok: 0, fail: 0, na: 0 };
  for (const item of items) counts[item.verdict] += 1;
  return { version: RUBRIC_VERSION, items, failures, ok: failures.length === 0, counts };
}

/** Посчитать рубрику по каталогу задания (CLI и гейт запуска зовут это). */
export function computeRubricFromTask(taskDir, options = {}) {
  return computeRubric(readRubricInput(taskDir, options));
}

/** Короткая сводка вердиктов — для текста отказа. */
export function summarizeRubric(computed) {
  const counts = computed && computed.counts ? computed.counts : { ok: 0, fail: 0, na: 0 };
  const failed = computed && Array.isArray(computed.failures) && computed.failures.length > 0
    ? '; fail: ' + computed.failures.join(', ')
    : '';
  return 'ok ' + counts.ok + ', na ' + counts.na + ', fail ' + counts.fail + failed;
}

/* ------------------------------------------------------------------------- *
 * Сверка заявленного аудитором вердикта с пересчётом (гейт запуска).
 * ------------------------------------------------------------------------- */

function relativeTo(root, file) {
  const base = path.resolve(String(root || process.cwd()));
  return path.relative(base, file).split(path.sep).join('/');
}

/**
 * Расхождения audit-evidence.json с пересчитанной рубрикой.
 *
 * Проверяется три вещи: схема файла (version/task/at/items), полнота рубрики
 * (все пункты на месте, чужих нет) и совпадение вердикта по каждому пункту.
 * Пустое доказательство у заявленного вердикта — тоже расхождение.
 *
 * @param computed - результат computeRubric.
 * @param evidence - разобранный audit-evidence.json (любое значение).
 * @param input - вход рубрики (нужен id задания).
 * @returns {string[]} человеческие причины расхождения; пусто — расхождений нет.
 */
export function compareAuditEvidence(computed, evidence, input = {}) {
  if (!isPlainObject(evidence)) return ['audit-evidence.json: корень — не JSON-объект'];
  const problems = [];
  if (evidence.version === undefined || evidence.version === null || String(evidence.version).trim() === '') {
    problems.push('нет version (ожидается ' + RUBRIC_VERSION + ')');
  }
  if (!text(evidence.task)) {
    problems.push('нет task: непонятно, к какому заданию относится вердикт');
  } else if (text(input.id) && text(evidence.task) !== text(input.id)) {
    problems.push('task «' + text(evidence.task) + '» — это не задание «' + text(input.id) + '»');
  }
  if (!text(evidence.at)) problems.push('нет at: не указано, когда вердикт вынесен');
  const items = Array.isArray(evidence.items) ? evidence.items : [];
  if (items.length === 0) problems.push('items пуст: рубрика неполная');
  const known = new Set((computed && Array.isArray(computed.items) ? computed.items : []).map((item) => item.code));
  for (const item of items) {
    const code = text(item && item.code);
    if (!code) {
      problems.push('item без code');
      continue;
    }
    if (!known.has(code)) problems.push('пункт «' + code + '» неизвестен рубрике');
  }
  for (const computedItem of computed && Array.isArray(computed.items) ? computed.items : []) {
    const claimed = items.find((item) => text(item && item.code) === computedItem.code);
    if (!claimed) {
      problems.push('рубрика неполная: нет пункта «' + computedItem.code + '»');
      continue;
    }
    const verdict = text(claimed.verdict).toLowerCase();
    if (!['ok', 'fail', 'na'].includes(verdict)) {
      problems.push('пункт «' + computedItem.code + '»: вердикт «' + text(claimed.verdict)
        + '» — допустимы ok, fail, na');
      continue;
    }
    if (verdict !== computedItem.verdict) {
      problems.push('пункт «' + computedItem.code + '»: аудитор заявил «' + verdict + '», пересчёт — «'
        + computedItem.verdict + '» (' + computedItem.evidence + ')');
    }
    if (!text(claimed.evidence)) {
      problems.push('пункт «' + computedItem.code + '»: вердикт без доказательства');
    }
  }
  return problems;
}

/**
 * Претензия гейта запуска к audit-evidence.json; null — рубрика сходится.
 *
 * Правила задания 0368:
 *   1. задание с контрактом (criteria.json) и риском medium и выше обязано
 *      иметь audit-evidence.json — иначе запуск не начинается;
 *   2. рубрика в файле должна быть полной (все пункты реестра);
 *   3. вердикт по каждому пункту должен совпасть с пересчётом.
 *
 * Задание без criteria.json — не контракт, пересчитывать нечего: гейт 0177
 * остаётся прежним (инвариант 1: без объявленного аудитора поведение не
 * меняется; здесь то же самое для задания без контракта).
 *
 * @param taskDir - каталог задания.
 * @param options - { root? }.
 * @returns {string|null} текст отказа либо null.
 */
export function auditRubricProblem(taskDir, options = {}) {
  const input = readRubricInput(taskDir, options);
  const contractName = text(input.meta && input.meta.criteria) || 'criteria.json';
  const contractPath = path.join(input.taskDir, contractName);
  if (!fs.existsSync(contractPath)) return null;
  const root = options && options.root ? options.root : input.git.root;
  const evidencePath = path.join(input.taskDir, 'audit-evidence.json');
  const rel = relativeTo(root, evidencePath);
  const computed = computeRubric(input);
  if (!fs.existsSync(evidencePath)) {
    if (riskRank(input.risk) < MEDIUM_RANK) return null;
    return 'рубрика аудита: нужен ' + rel + ' — задание риска «' + input.risk
      + '» без машинного доказательства не стартует. Файл пишет node tools/audit-check.mjs --task <каталог задания>; '
      + 'пересчёт сейчас: ' + summarizeRubric(computed) + '.';
  }
  const evidence = readJsonFile(evidencePath);
  if (evidence === null) {
    return 'рубрика аудита: ' + rel + ' не разбирается как JSON — вердикт без доказательства не годится.';
  }
  const problems = compareAuditEvidence(computed, evidence, input);
  if (problems.length > 0) {
    return 'рубрика аудита: ' + rel + ' расходится с пересчётом — ' + problems.join('; ')
      + '. Пересчёт: ' + summarizeRubric(computed) + '.';
  }
  return null;
}
