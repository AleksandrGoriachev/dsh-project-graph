/**
 * Политика «альтернативного пути» (задания 0073, 0091).
 *
 * Работа мимо объявленной структуры видна всегда, но режим её удержания задаётся
 * общим блоком движка workflow: `<root>/docs/subagent-workflow/workflow.config.json`,
 * `enforcement.structurePolicy` ∈ `off|warn|fail` (письмо workflow imperative --01,
 * императив заказчика: структура — гарантия невозможности её обойти).
 *
 *   - `fail` — нативный `subagent`/`subagent_fork` отклоняется ДО исполнения:
 *     `tools/pre-execute` возвращает `{ kind: 'deny', reason }`, downstream не
 *     вызывается, а reason называет инструмент, режим, узлы и точный рецепт
 *     `project_graph_spawn`;
 *   - `warn` — пилот: вызов проходит, после него модель получает предупреждение
 *     с перечнем узлов и рецептом (форма notice — `lib/notice-message.js`, 0088);
 *   - `off` — осознанно ослабленный режим: ни отказа, ни предупреждения, но
 *     решение всё равно пишется в журнал.
 *
 * Нет файла, нет ключа, битый JSON или неверное значение — `warn` с причиной в
 * `readStructurePolicy` (обратная совместимость: чтение никогда не бросает).
 *
 * Журнал живёт в хранилище (правила `lib/store.js`, вне репозитория), как и
 * журналы обмена: `$DSH_PROJECT_GRAPH_STORE`, иначе
 * `~/.dsh/project-graph/<basename>-<sha1[0..8]>/`. В репозиторий не пишется
 * ничего. Модуль не импортирует пакеты DSH: только `node:*` и наш код, поэтому
 * его можно проверять без хоста. Подписки `tools/pre-execute` и
 * `tools/post-execute` — единственная точка входа в хост; без события плагин
 * работает как раньше.
 *
 * 0100: тот же блок несёт `enforcement.processPolicy` — гейт процесса оболочки.
 * `pwsh/shell/bash/exec` с командой `git commit|push|merge|rebase` при `fail`
 * отклоняются ДО исполнения, если в той же команде нет `tools/commit.ps1`
 * (штатная обёртка сама зовёт гейт движка, покрытие путей проверяет task-guard).
 * `warn` — пропуск с записью в тот же журнал, `off` и отсутствие ключа — не
 * проверять: гейт процесса включает только его собственный ключ, а не режим
 * удержания структуры.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildGraph } from './graph.js';
import { readStructure } from './load.js';
import { noticeMessage } from './notice-message.js';
import { storeDir } from './store.js';

/** Инструменты, которые ведут работу мимо объявленной структуры. */
export const ALTERNATIVE_TOOL_NAMES = new Set(['subagent', 'subagent_fork']);

/** Имя журнала в каталоге хранилища. */
export const ALTERNATIVES_FILE = 'alternatives.jsonl';

/** Сколько последних событий отдают чтение и `GET /api/alternatives`. */
export const MAX_ALTERNATIVES = 50;

/** События хоста, на которые подписывается политика. */
export const PRE_EXECUTE_EVENT = 'tools/pre-execute';
export const POST_EXECUTE_EVENT = 'tools/post-execute';

/** Допустимые режимы `enforcement.structurePolicy` и режим по умолчанию. */
export const STRUCTURE_POLICY_MODES = Object.freeze(['off', 'warn', 'fail']);
export const DEFAULT_STRUCTURE_POLICY = 'warn';

/** Допустимые режимы `enforcement.processPolicy`; нет ключа — `off` (0100). */
export const PROCESS_POLICY_MODES = Object.freeze(['off', 'warn', 'fail']);
export const DEFAULT_PROCESS_POLICY = 'off';

/** Инструменты, чью команду проверяет гейт процесса (имя без учёта регистра). */
export const PROCESS_TOOL_NAMES = new Set(['pwsh', 'shell', 'bash', 'exec']);

/** Подкоманды git, которые меняют историю и обходят структуру. */
export const PROCESS_DENY_SUBCOMMANDS = Object.freeze(['commit', 'push', 'merge', 'rebase']);

/** Штатная обёртка коммита — единственный разрешённый путь (0100). */
export const COMMIT_WRAPPER_PATTERN = /tools[\\/]+commit\.ps1$/iu;

/** Позиции, после которых токен — вызов программы, а не текст аргумента. */
const COMMAND_POSITION_PREFIXES = new Set([
  '&', ';', '|', 'pwsh', 'powershell', 'node', 'bash', 'sh', 'cmd', 'exec', 'call', 'start',
  '-file', '-f', '/c', '-c',
]);

/** Опции git, забирающие следующий аргумент: подкоманда идёт после них. */
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env',
]);

/** Общий блок движка workflow относительно корня проекта. */
export const WORKFLOW_CONFIG_RELATIVE = path.join('docs', 'subagent-workflow', 'workflow.config.json');

/** Память решений ограничена: старые вызовы вытесняются, а не копятся. */
export const POLICY_MEMORY_MAX = 100;

/** Короткий префикс журнала в stderr: молчать о сбое политики нельзя. */
const LOG_PREFIX = '[dsh-project-graph] structure-policy: ';

/** Записать предупреждение, не роняя хост (логгер политики — только консоль). */
function warn(message) {
  try {
    console.warn(LOG_PREFIX + message);
  } catch {
    /* консоль может быть закрыта: предупреждение не стоит падения */
  }
}

/** Текст ошибки без исключения наружу. */
function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

/** Абсолютный файл журнала одного проекта (в хранилище, не в репозитории). */
export function alternativesFile(root) {
  return path.join(storeDir(root), ALTERNATIVES_FILE);
}

/**
 * Блок `enforcement` общего конфига движка workflow.
 *
 * Читается только `<root>/docs/subagent-workflow/workflow.config.json`; чужой файл
 * не меняется. Ошибка чтения или разбора возвращается причиной, а не бросается:
 * политика не имеет права падать или блокировать работу из-за конфига.
 *
 * @param root - корень проекта.
 * @returns `{ enforcement: { … } | null, error? }`; `null` — блок не прочитан.
 */
function readEnforcement(root) {
  let base;
  try {
    base = root ? path.resolve(String(root)) : process.cwd();
  } catch {
    base = process.cwd();
  }
  const file = path.join(base, WORKFLOW_CONFIG_RELATIVE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // Файла нет — это штатный откат; причина всё равно нужна: по ней видно,
    // что режим взят по умолчанию, а не объявлен движком.
    return {
      enforcement: null,
      error: 'конфиг workflow не прочитан (' + WORKFLOW_CONFIG_RELATIVE + '): ' + messageOf(error),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      enforcement: null,
      error: 'битый JSON в ' + WORKFLOW_CONFIG_RELATIVE + ': ' + messageOf(error),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { enforcement: null, error: 'конфиг workflow — не объект' };
  }
  const enforcement = parsed.enforcement;
  if (enforcement === undefined || enforcement === null) return { enforcement: {} };
  if (typeof enforcement !== 'object' || Array.isArray(enforcement)) {
    return { enforcement: null, error: 'enforcement — не объект' };
  }
  return { enforcement };
}

/**
 * Режим удержания структуры из общего блока движка workflow.
 *
 * @param root - корень проекта.
 * @returns `{ mode: 'off'|'warn'|'fail', source: 'config'|'default', error? }`.
 */
export function readStructurePolicy(root) {
  const { enforcement, error } = readEnforcement(root);
  if (!enforcement) {
    return error === undefined || error === null
      ? { mode: DEFAULT_STRUCTURE_POLICY, source: 'default' }
      : { mode: DEFAULT_STRUCTURE_POLICY, source: 'default', error };
  }
  const value = enforcement.structurePolicy;
  if (value === undefined || value === null) {
    return { mode: DEFAULT_STRUCTURE_POLICY, source: 'default' };
  }
  if (typeof value !== 'string' || !STRUCTURE_POLICY_MODES.includes(value)) {
    return {
      mode: DEFAULT_STRUCTURE_POLICY,
      source: 'default',
      error: 'неверное значение enforcement.structurePolicy: ' + JSON.stringify(value)
        + ' (допустимо ' + STRUCTURE_POLICY_MODES.join('|') + ')',
    };
  }
  return { mode: value, source: 'config' };
}

/* ------------------------------------------------------------------ */
/* 0100: гейт процесса — прямой git-коммит в обход структуры           */
/* ------------------------------------------------------------------ */

/**
 * Режим гейта процесса из того же блока движка workflow.
 *
 * `off` (и отсутствие ключа `enforcement.processPolicy`) — не проверять; `warn` —
 * пропустить и записать решение; `fail` — отказ до исполнения. Ошибка чтения
 * конфига не блокирует вызов: `fail` — только осознанный режим.
 *
 * @param root - корень проекта.
 * @returns `{ mode: 'off'|'warn'|'fail', source: 'config'|'default', error? }`.
 */
export function readProcessPolicy(root) {
  const { enforcement, error } = readEnforcement(root);
  if (!enforcement) {
    return error === undefined || error === null
      ? { mode: DEFAULT_PROCESS_POLICY, source: 'default' }
      : { mode: DEFAULT_PROCESS_POLICY, source: 'default', error };
  }
  const value = enforcement.processPolicy;
  if (value === undefined || value === null) {
    return { mode: DEFAULT_PROCESS_POLICY, source: 'default' };
  }
  if (typeof value !== 'string' || !PROCESS_POLICY_MODES.includes(value)) {
    return {
      mode: DEFAULT_PROCESS_POLICY,
      source: 'default',
      error: 'неверное значение enforcement.processPolicy: ' + JSON.stringify(value)
        + ' (допустимо ' + PROCESS_POLICY_MODES.join('|') + ')',
    };
  }
  return { mode: value, source: 'config' };
}

/** Инструмент гейтится по процессу (имя без учёта регистра)? */
export function isProcessTool(name) {
  return typeof name === 'string' && PROCESS_TOOL_NAMES.has(name.trim().toLowerCase());
}

/** Команда оболочки из аргументов вызова; пустая строка — проверять нечего. */
export function processCommandOf(exec) {
  const args = exec && exec.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  for (const key of ['command', 'cmd', 'script', 'commandLine']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** Опции оболочки, забирающие команду строкой: `pwsh -Command "git commit"`. */
const SHELL_COMMAND_OPTIONS = new Set(['-command', '-c', '/c', '--command', '--eval', '-e', 'exec']);

/**
 * Токены команды оболочки: кавычки снимаются, разделители цепочки (`;`, `&`,
 * `|`, скобки) делят команду. Строка в кавычках остаётся одним токеном, поэтому
 * `echo "git commit"` не выглядит коммитом.
 */
function shellTokens(command) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let quote = '';
  const flush = () => {
    if (current) tokens.push({ value: current, quoted });
    current = '';
    quoted = false;
  };
  for (const char of String(command || '')) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      continue;
    }
    if (/\s/u.test(char) || ';&|()'.includes(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

/** Имя исполняемого файла из токена: `C:\Program Files\Git\bin\git.exe` → `git.exe`. */
function executableName(token) {
  const normalized = String(token || '').replace(/\\/gu, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base.toLowerCase();
}

/** Запрещённая подкоманда git в готовом списке токенов — или пустая строка. */
function scanTokens(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const name = executableName(tokens[index].value);
    if (name !== 'git' && name !== 'git.exe') continue;
    let next = index + 1;
    while (next < tokens.length) {
      const token = tokens[next].value;
      if (token.startsWith('-')) {
        const equals = token.indexOf('=');
        const key = equals >= 0 ? token.slice(0, equals) : token;
        next += equals < 0 && GIT_OPTIONS_WITH_VALUE.has(key) ? 2 : 1;
        continue;
      }
      const subcommand = token.toLowerCase();
      if (PROCESS_DENY_SUBCOMMANDS.includes(subcommand)) return subcommand;
      break;
    }
  }
  return '';
}

/**
 * Запрещённая подкоманда git в команде оболочки — или пустая строка.
 *
 * Разбор по токенам, а не по подстроке: `git log --grep commit` — чтение, а не
 * коммит. Глобальные опции между `git` и подкомандой (`-C repo`, `-c key=val`,
 * `--git-dir=…`) пропускаются: `git -C repo commit` — всё равно прямой коммит.
 * Команда, переданная строкой (`pwsh -Command "git commit"`, `bash -c "git push"`),
 * разбирается вложенно: иначе кавычки спрятали бы коммит от гейта.
 *
 * @param command - текст команды инструмента.
 * @returns `commit|push|merge|rebase` или пустая строка.
 */
export function detectProcessSubcommand(command) {
  const tokens = shellTokens(command);
  const direct = scanTokens(tokens);
  if (direct) return direct;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.quoted) continue;
    const previous = index > 0 ? tokens[index - 1].value.toLowerCase() : '';
    if (!SHELL_COMMAND_OPTIONS.has(previous)) continue;
    const nested = scanTokens(shellTokens(token.value));
    if (nested) return nested;
  }
  return '';
}

/** Токен обёртки стоит в позиции команды (начало, после программы или `-File`). */
function isCommandPosition(previous) {
  if (!previous) return true;
  return COMMAND_POSITION_PREFIXES.has(executableName(previous));
}

/**
 * В команде вызывается штатная обёртка коммита.
 *
 * Считается именно вызов: токен пути в позиции команды (`pwsh -File tools/commit.ps1`,
 * `& .\tools\commit.ps1`, `node tools/commit.ps1`). Упоминание пути в тексте
 * (`git commit -m "смотри tools/commit.ps1"`) запрет не снимает: иначе гейт
 * обходился бы одной строкой сообщения. Регистр любой, слэш прямой или обратный.
 */
export function hasCommitWrapper(command) {
  const tokens = shellTokens(command);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!COMMIT_WRAPPER_PATTERN.test(tokens[index].value)) continue;
    const previous = index > 0 ? tokens[index - 1].value : '';
    if (isCommandPosition(previous)) return true;
  }
  return false;
}

/** Короткое описание решения для журнала: подкоманда и сама команда. */
export function processDetail(exec, subcommand) {
  const command = processCommandOf(exec).replace(/\s+/gu, ' ').trim();
  const text = 'git ' + String(subcommand || '') + ': ' + command;
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

/**
 * Причина отказа гейта процесса: одна строка, по-русски, без стека.
 *
 * Называет структуру, процесс, запрещённую подкоманду, штатный путь
 * `tools/commit.ps1` и task-guard: покрытие путей проверяет движок, а не оболочка.
 */
export function processDenyReason(tool, subcommand) {
  return 'Отказ: структура запрещает прямой git ' + String(subcommand || 'commit')
    + ' в инструменте ' + String(tool || 'pwsh') + ' — это обход процесса (enforcement.processPolicy=fail).'
    + ' Коммит только через tools/commit.ps1: покрытие путей проверяет task-guard.';
}

/**
 * Проверка процесса до исполнения: решение режима или `null` (пропустить).
 *
 * `off` (и отсутствие ключа) не проверяет и не пишет журнал; `warn` пишет
 * `denied: false` и пропускает; `fail` пишет `denied: true` и отказывает.
 * Штатная обёртка `tools/commit.ps1` в той же команде снимает запрет.
 */
function adjudicateProcess({ exec, name, root }) {
  const command = processCommandOf(exec);
  if (!command) return null;
  if (hasCommitWrapper(command)) return null;
  const subcommand = detectProcessSubcommand(command);
  if (!subcommand) return null;
  const policy = readProcessPolicy(root);
  if (policy.mode === 'off') return null;
  const denied = policy.mode === 'fail';
  recordAlternative({
    root,
    tool: name,
    detail: processDetail(exec, subcommand),
    mode: policy.mode,
    denied,
  });
  if (!denied) return null;
  return { kind: 'deny', reason: processDenyReason(name, subcommand) };
}

/**
 * Объявленные узлы проекта; пустой список — структура не объявлена.
 *
 * Читается тот же резолвер, что и у панели (`lib/store.js`): легаси-проект
 * берёт структуру из репозитория, свежий — из хранилища. Ошибки чтения и
 * разбора означают «структуры нет»: политика не имеет права падать.
 */
function declaredNodes(root, runtime) {
  const dirName = runtime && typeof runtime.structureDir === 'string' && runtime.structureDir.trim()
    ? runtime.structureDir.trim()
    : 'structure';
  try {
    const read = readStructure(root, dirName);
    if (!read || read.exists !== true || !Array.isArray(read.files) || read.files.length === 0) return [];
    const built = buildGraph(read.files, { dirName: read.dirName || dirName });
    const nodes = built && built.graph && Array.isArray(built.graph.nodes) ? built.graph.nodes : [];
    const out = [];
    for (const node of nodes) {
      const id = node && typeof node.id === 'string' ? node.id.trim() : '';
      if (!id) continue;
      const role = node && typeof node.role === 'string' ? node.role.trim() : '';
      out.push({ id, role });
    }
    return out;
  } catch (error) {
    warn('структура не прочитана: ' + messageOf(error));
    return [];
  }
}

/** Узел одной строкой: `id` и роль, если она объявлена. */
function nodeLine(node) {
  const id = node && node.id ? String(node.id) : '';
  const role = node && node.role ? String(node.role) : '';
  return role ? id + ' (' + role + ')' : id;
}

/** Короткое описание вызова для журнала: промпт, если он есть, иначе аргументы. */
export function alternativeDetail(exec) {
  const args = exec && exec.arguments;
  try {
    if (args && typeof args === 'object' && typeof args.prompt === 'string' && args.prompt.trim()) {
      const prompt = args.prompt.trim();
      return 'prompt: ' + (prompt.length > 200 ? prompt.slice(0, 200) + '…' : prompt);
    }
    const text = args === undefined ? '' : JSON.stringify(args);
    if (text && text !== '{}' && text !== 'null' && text !== 'undefined') {
      return text.length > 300 ? text.slice(0, 300) + '…' : text;
    }
  } catch {
    /* аргументы не сериализуются — событие всё равно нужно */
  }
  return '';
}

/**
 * Текст предупреждения для модели (режим warn).
 *
 * Короткий, с перечнем узлов и точным рецептом: модель должна увидеть, какие
 * узлы объявлены и как продолжить через структуру. Последняя строка говорит
 * прямо, что вызов не заблокирован: это предупреждение, а не запрет.
 *
 * @param nodes - объявленные узлы (`[{ id, role }]`); хотя бы один.
 * @returns Текст для `additionalContexts`.
 */
export function alternativeNotice(nodes) {
  const declared = (Array.isArray(nodes) ? nodes : []).filter((node) => node && node.id);
  const list = declared.map(nodeLine);
  const first = declared.length > 0 ? String(declared[0].id) : '<id>';
  return [
    'Альтернативный путь: вызван нативный инструмент в проекте, который объявил структуру.',
    'Объявленные узлы: ' + (list.length > 0 ? list.join(', ') : '(нет)') + '.',
    'Чтобы работа шла через структуру, вызывайте project_graph_spawn с полем node: '
      + 'project_graph_spawn({ node: "' + first + '", prompt: "<задание>" }).',
    'Вызов не заблокирован: это предупреждение, а не запрет.',
  ].join('\n');
}

/**
 * Причина отказа для модели (режим fail): инструмент, режим, узлы и рецепт.
 *
 * Отказ возвращается до исполнения, поэтому текст обязан быть достаточным,
 * чтобы модель сразу пошла через структуру, а не повторяла нативный вызов.
 *
 * @param tool - имя отклонённого инструмента.
 * @param nodes - объявленные узлы (`[{ id, role }]`); хотя бы один.
 * @returns Текст для `{ kind: 'deny', reason }`.
 */
export function alternativeDenyReason(tool, nodes) {
  const declared = (Array.isArray(nodes) ? nodes : []).filter((node) => node && node.id);
  const list = declared.map(nodeLine);
  const first = declared.length > 0 ? String(declared[0].id) : '<id>';
  return [
    'Отказ: нативный инструмент ' + String(tool || 'subagent') + ' отклонён до исполнения.'
      + ' В проекте объявлена структура, а enforcement.structurePolicy=fail запрещает обход.',
    'Объявленные узлы: ' + (list.length > 0 ? list.join(', ') : '(нет)') + '.',
    'Работа идёт только через структуру: project_graph_spawn({ node: "' + first + '", prompt: "<задание>" }).',
  ].join('\n');
}

/**
 * Дописать одно событие в журнал.
 *
 * Поля `at/tool/detail` остаются прежними (0073); решение политики добавляет
 * `mode` и `denied` (0091), чтобы режим и отказ были видны в журнале.
 *
 * @param options.root - корень проекта (журнал — в хранилище этого корня).
 * @param options.tool - имя вызванного инструмента.
 * @param options.detail - короткое описание вызова.
 * @param options.mode - режим политики (`off|warn|fail`), если решение записано.
 * @param options.denied - был ли вызов отклонён.
 * @returns Записанное событие или `null`, если запись не удалась.
 */
export function recordAlternative({ root, tool, detail, mode, denied } = {}) {
  const row = {
    at: new Date().toISOString(),
    tool: typeof tool === 'string' ? tool : String(tool === undefined || tool === null ? '' : tool),
    detail: typeof detail === 'string' ? detail : (detail === undefined || detail === null ? '' : String(detail)),
  };
  if (typeof mode === 'string' && mode.trim()) row.mode = mode.trim();
  if (denied !== undefined) row.denied = denied === true;
  try {
    const file = alternativesFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    return row;
  } catch (error) {
    warn('событие не записано: ' + messageOf(error));
    return null;
  }
}

/**
 * Прочитать последние события журнала: не больше {@link MAX_ALTERNATIVES},
 * новые первыми.
 *
 * Битая строка пропускается: журнал — наблюдение, а не контракт, и один
 * недописанный хвост не должен прятать остальные события. Ошибка чтения тоже
 * не бросается — возвращается пустой список.
 *
 * @param options.root - корень проекта.
 * @returns Строки `{ at, tool, mode?, denied?, detail }`, новые первыми.
 */
export function readAlternatives({ root } = {}) {
  let text = '';
  try {
    text = fs.readFileSync(alternativesFile(root), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch {
      /* недописанная или чужая строка — пропускаем */
    }
  }
  return rows.reverse().slice(0, MAX_ALTERNATIVES);
}

/* ------------------------------------------------------------------ */
/* Память решений по вызову                                             */
/* ------------------------------------------------------------------ */

/**
 * Решение pre-execute на вызов: post-execute не пишет событие второй раз и не
 * добавляет notice для отказа или ослабленного режима. Ключ — callId, иначе
 * тождество объекта вызова (тест, старый хост).
 */
const decisions = new Map();
const identities = new WeakMap();
let sequence = 0;

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

/** Запомнить решение, вытесняя самое старое: память не растёт бесконечно. */
function rememberDecision(key, value) {
  if (!key) return;
  decisions.delete(key);
  decisions.set(key, value);
  while (decisions.size > POLICY_MEMORY_MAX) {
    const oldest = decisions.keys().next().value;
    if (oldest === undefined) break;
    decisions.delete(oldest);
  }
}

/** Сброс памяти между проверками: тесты не наследуют чужие вызовы. */
export function resetStructurePolicyState() {
  decisions.clear();
  sequence = 0;
}

/** Корень по умолчанию: выбранный в рантайме, иначе первый объявленный. */
function rootOf(runtime) {
  try {
    if (runtime && typeof runtime.currentRoot === 'function') {
      const current = runtime.currentRoot();
      if (current) return path.resolve(String(current));
    }
    if (runtime && Array.isArray(runtime.roots) && runtime.roots.length > 0) return path.resolve(String(runtime.roots[0]));
    if (runtime && runtime.defaultRoot) return path.resolve(String(runtime.defaultRoot));
  } catch {
    /* резолвер корня может отказать: ниже — cwd */
  }
  return process.cwd();
}

/**
 * Контекст предупреждения в форме, которую понимает `tools/post-execute`.
 *
 * Собирается единым помощником `lib/notice-message.js`: notice обязан быть
 * полным message формата v4 — `role: 'user'` (0086), свежий непустой `id` и
 * producer-owned `source.kind` (0088). Харнесс сохраняет `additionalContexts`
 * как user/message; без kind читатель v4 отказывает всему журналу, без id не
 * восстанавливает сессию. Текст, summary и порядок контекстов не меняются:
 * content — массив текстовых блоков, source.form — 'notice'.
 */
function noticeContext(text) {
  return noticeMessage({ text, summary: 'структура: альтернативный путь' });
}

/** Добавить notice к результату downstream, сохранив чужие контексты и тело. */
function withNotice(downstream, nodes) {
  const notice = alternativeNotice(nodes);
  const contexts = downstream && Array.isArray(downstream.additionalContexts) ? downstream.additionalContexts : [];
  return { ...downstream, additionalContexts: [...contexts, noticeContext(notice)] };
}

/**
 * Обработчик `tools/pre-execute`.
 *
 * Сначала гейт процесса (0100): `pwsh/shell/bash/exec` с `git commit|push|merge|rebase`
 * при `processPolicy=fail` отклоняются до исполнения, если в команде нет
 * `tools/commit.ps1`; `warn` пишет решение в журнал и пропускает; `off` молчит.
 * Затем — нативный `subagent`/`subagent_fork` в проекте с объявленной структурой:
 * режим `structurePolicy` и запись решения в журнал. `fail` — отказ до исполнения:
 * downstream не вызывается, reason называет инструмент, режим и рецепт.
 * `warn`/`off` — вызов проходит. Любая ошибка самой политики логируется и не
 * блокирует вызов: отказ — только осознанное решение режима fail.
 *
 * @param options.exec - вызов инструмента (`{ name, arguments }`).
 * @param options.next - downstream-цепочка `() => Promise<результат>`.
 * @param options.runtime - рантайм плагина (корень и каталог структуры).
 * @param options.root - корень проекта; по умолчанию — из рантайма.
 * @returns Результат downstream или `{ kind: 'deny', reason }`.
 */
export async function handlePreExecute({ exec, next, runtime, root } = {}) {
  const continueNext = typeof next === 'function' ? next : async () => ({ kind: 'allow' });
  const name = exec && typeof exec.name === 'string' ? exec.name.trim() : '';
  if (isProcessTool(name)) {
    // Гейт процесса не зависит от объявленных узлов: его включает только
    // собственный ключ enforcement.processPolicy. Ошибка чтения конфига и сбой
    // самой проверки вызов не блокируют — fail только по осознанному режиму.
    try {
      const projectRoot = root ? path.resolve(String(root)) : rootOf(runtime);
      const processDecision = adjudicateProcess({ exec, name, root: projectRoot });
      if (processDecision) return processDecision;
    } catch (error) {
      warn('гейт процесса не сработал: ' + messageOf(error));
    }
    return continueNext();
  }
  if (!ALTERNATIVE_TOOL_NAMES.has(name)) return continueNext();
  try {
    const projectRoot = root ? path.resolve(String(root)) : rootOf(runtime);
    const nodes = declaredNodes(projectRoot, runtime);
    if (nodes.length === 0) return continueNext();
    const policy = readStructurePolicy(projectRoot);
    const denied = policy.mode === 'fail';
    recordAlternative({
      root: projectRoot,
      tool: name,
      detail: alternativeDetail(exec),
      mode: policy.mode,
      denied,
    });
    rememberDecision(keyOf(exec), { mode: policy.mode, denied, noticed: false });
    if (!denied) return continueNext();
    return { kind: 'deny', reason: alternativeDenyReason(name, nodes) };
  } catch (error) {
    warn('проверка перед вызовом не удалась: ' + messageOf(error));
    return continueNext();
  }
}

/**
 * Обработчик `tools/post-execute`.
 *
 * Вызывает downstream и, если проект объявил структуру, добавляет к результату
 * предупреждение только в режиме `warn`. Решение pre-execute уже записано в
 * журнал и не дублируется; для `fail` заметка не нужна (отказ уже в deny), для
 * `off` режим осознанно молчит. Самостоятельный post-execute (хост без
 * pre-execute, проверки 0073/0086/0088) пишет событие сам, как раньше. Любая
 * ошибка политики логируется и не меняет результат инструмента.
 *
 * @param options.exec - вызов инструмента (`{ name, arguments }`).
 * @param options.result - результат, если downstream не передан.
 * @param options.next - downstream-цепочка `() => Promise<результат>`.
 * @param options.runtime - рантайм плагина (корень и каталог структуры).
 * @param options.root - корень проекта; по умолчанию — из рантайма.
 * @returns Результат downstream, в режиме warn — с `additionalContexts`.
 */
export async function handleToolResult({ exec, result, next, runtime, root } = {}) {
  const downstream = typeof next === 'function' ? await next() : result;
  try {
    const name = exec && typeof exec.name === 'string' ? exec.name.trim() : '';
    if (!ALTERNATIVE_TOOL_NAMES.has(name)) return downstream;
    const projectRoot = root ? path.resolve(String(root)) : rootOf(runtime);
    const nodes = declaredNodes(projectRoot, runtime);
    if (nodes.length === 0) return downstream;
    const key = keyOf(exec);
    const remembered = key ? decisions.get(key) : null;
    if (remembered) {
      decisions.delete(key);
      return remembered.mode === 'warn' ? withNotice(downstream, nodes) : downstream;
    }
    const policy = readStructurePolicy(projectRoot);
    if (policy.mode === 'fail') return downstream;
    recordAlternative({
      root: projectRoot,
      tool: name,
      detail: alternativeDetail(exec),
      mode: policy.mode,
      denied: false,
    });
    return policy.mode === 'warn' ? withNotice(downstream, nodes) : downstream;
  } catch (error) {
    warn('предупреждение не добавлено: ' + messageOf(error));
    return downstream;
  }
}

/**
 * Подписать политику на `tools/pre-execute` и `tools/post-execute`.
 *
 * Без `ctx.on` (тест, старый хост) — тихо ничего не делать: плагин обязан
 * загружаться и без события. Ошибка каждой подписки логируется и не бросается.
 *
 * @returns `true`, если подписка сделана хотя бы на одно событие.
 */
export function registerStructurePolicy(ctx, runtime) {
  if (!ctx || typeof ctx.on !== 'function') return false;
  const root = rootOf(runtime);
  let subscribed = false;
  try {
    ctx.on(PRE_EXECUTE_EVENT, (exec, next) => handlePreExecute({ exec, next, runtime, root }));
    subscribed = true;
  } catch (error) {
    warn('подписка ' + PRE_EXECUTE_EVENT + ' не сделана: ' + messageOf(error));
  }
  try {
    ctx.on(POST_EXECUTE_EVENT, (exec, result, next) => handleToolResult({ exec, result, next, runtime, root }));
    subscribed = true;
  } catch (error) {
    warn('подписка ' + POST_EXECUTE_EVENT + ' не сделана: ' + messageOf(error));
  }
  return subscribed;
}
