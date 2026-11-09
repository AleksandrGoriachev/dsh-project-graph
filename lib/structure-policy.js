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
 * 0102: тот же блок несёт `enforcement.writePolicy` — гейт записи. Продуктовый
 * код (lib/**, test/**, tools/**, vendor/**, package.json, pnpm-lock.yaml)
 * при `fail` правится только внутри `allowedPaths` активного задания
 * (`docs/tasks/<id>/task.md` с TASK-META без `acceptance.json`). Документы и
 * данные (docs/**, structure/**, coordination/**, artifacts/**, README.md,
 * HANDOVER-NEXT.md) не гейтятся: иначе координатор не вёл бы структуру, а движок —
 * отчёты. Инструменты `write/edit/multi_edit/apply_patch` отклоняются ДО исполнения
 * (`{ kind: 'deny', reason }`), `warn` пишет решение в тот же журнал и пропускает,
 * `off` — молчит; ошибка политики вызов не блокирует.
 *
 * 0114: `checks/**` исключён из продуктовых путей. Проверку пишет координатор ДО
 * задания, когда активного `allowedPaths` ещё нет; при `fail` гейт записи делал бы
 * авторство проверок невозможным. Защита проверок уже есть и не ослаблена:
 * `criteria.lock` (контракт заморожен) и приёмка (правка после красного запрещена
 * движком). Гейт остаётся на lib/**, test/**, tools/**, vendor/**, package.json,
 * pnpm-lock.yaml; если checks-путь входит в `allowedPaths` активного задания,
 * решение по-прежнему `allow` и называет задание.
 *
 * 0117: корень гейта записи выбирается по ПУТИ записи, а не по первому корню
 * хоста: `rootForPath(runtime, target)` берёт самый длинный корень
 * `runtime.allowedRoots()`, содержащий путь (на Windows — без учёта регистра).
 * Живой случай plugin 1.0.16: в мультикорневом хосте хук взял первый корень
 * (default-workspace, где `writePolicy` не задан), и запись в `lib/api.js`
 * прошла мимо `fail` проекта. `writeDecision` без явного `root` и обработчик
 * `tools/pre-execute` для write/edit/multi_edit/apply_patch берут корень из
 * первого целевого пути; правила 0102/0114 при этом не меняются.
 *
 * 0118: гейт записи знает РОЛЬ вызывающей сессии. `handlePreExecute` принимает
 * необязательный `sessionId`; хост кладёт вызвавшего в `exec.agent` (`id` —
 * id сессии), поэтому подписка передаёт сессию в обработчик. Роль ищется по
 * журналу прогонов (`runs`: запись с `childId == sessionId` даёт узел) и по
 * узлу `structure/graph.json` (`role`). Приёмщик/судья и координатор не пишут
 * продуктовый код даже внутри `allowedPaths` активного задания — они подписывают
 * отчётом и распределяют; документы, `checks/**` и данные структуры им по-прежнему
 * доступны. Неизвестная сессия (нет записи или нет узла) — прежнее поведение с
 * причиной `unknown-session`: гейт не блокирует работу по догадке.
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
import { parseTaskMeta } from './contract.js';
import { buildGraph } from './graph.js';
import { readStructure } from './load.js';
import { noticeMessage } from './notice-message.js';
import { storeDir } from './store.js';
import { listRuns, localIso } from './runs.js';

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
/* 0101: health.json — доказательство, что структура включена           */
/* ------------------------------------------------------------------ */

/** Имя свидетельства о подписке политики в каталоге хранилища проекта. */
export const HEALTH_FILE = 'health.json';

/** Что уже записано в health.json этого корня (режим, подписка, причина). */
const healthSignatures = new Map();

/** Сбросить память здоровья политики: тесты и перезагрузка хоста. */
export function resetPolicyHealthState() {
  healthSignatures.clear();
}

/**
 * Записать `health.json`: доказательство того, что структура включена.
 *
 * Движок workflow читает файл в task-accept и workspace-imperative: при
 * `structurePolicy=fail` и `preExecuteSubscribed=false` структура объявлена, но
 * не удерживается — тогда отметка policy-not-enforced. Поэтому файл несёт
 * режим, факт подписки на `tools/pre-execute` и причину отказа, если она была.
 *
 * Ошибка записи не роняет плагин и не бросается наружу: свидетельство — это
 * наблюдение, а не условие работы узла.
 *
 * @param options.root - корень проекта.
 * @param options.store - каталог хранилища; по умолчанию — `storeDir(root)`.
 * @param options.preExecuteSubscribed - подписка на `tools/pre-execute` сделана.
 * @param options.error - причина, если режим прочитан с ошибкой.
 * @returns записанный объект или `null`, если запись не удалась.
 */
export function writePolicyHealth({ root, store, preExecuteSubscribed, error } = {}) {
  let resolvedRoot;
  try {
    resolvedRoot = path.resolve(String(root || process.cwd()));
  } catch {
    resolvedRoot = String(root || '');
  }
  const state = readStructurePolicy(resolvedRoot);
  const body = {
    at: localIso(),
    root: resolvedRoot,
    structurePolicy: state.mode,
    preExecuteSubscribed: preExecuteSubscribed === true,
    error: error === undefined || error === null || error === '' ? null : String(error),
  };
  try {
    const dir = path.resolve(String(store || storeDir(resolvedRoot)));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, HEALTH_FILE);
    const text = JSON.stringify(body, null, 2) + '\n';
    /* Атомарная замена: движок не должен прочитать половину файла. */
    const temporary = file + '.' + String(process.pid) + '.tmp';
    try {
      fs.writeFileSync(temporary, text, 'utf8');
      fs.renameSync(temporary, file);
    } catch {
      fs.writeFileSync(file, text, 'utf8');
      try { fs.rmSync(temporary, { force: true }); } catch { /* хвост не важен */ }
    }
    /*
     * Сводный индекс рядом с каталогами хранилищ: движку нужен один адрес
     * (~/.dsh/project-graph/health.json), а не формула имени каталога.
     * per-root health.json остаётся главным; индекс — удобство и не условие.
     */
    try {
      const indexFile = path.join(path.dirname(dir), HEALTH_FILE);
      let index = { at: body.at, roots: {} };
      try {
        const previous = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        if (previous && typeof previous.roots === 'object' && previous.roots && !Array.isArray(previous.roots)) {
          index.roots = previous.roots;
        }
      } catch { /* первый запуск или битый индекс — начинаем заново */ }
      index.at = body.at;
      index.roots[resolvedRoot] = body;
      const indexText = JSON.stringify(index, null, 2) + String.fromCharCode(10);
      const indexTemporary = indexFile + '.' + String(process.pid) + '.tmp';
      try {
        fs.writeFileSync(indexTemporary, indexText, 'utf8');
        fs.renameSync(indexTemporary, indexFile);
      } catch {
        fs.writeFileSync(indexFile, indexText, 'utf8');
        try { fs.rmSync(indexTemporary, { force: true }); } catch { /* хвост не важен */ }
      }
    } catch (failure) {
      warn('сводный ' + HEALTH_FILE + ' не записан: ' + messageOf(failure));
    }
    return body;
  } catch (failure) {
    warn(HEALTH_FILE + ' не записан: ' + messageOf(failure));
    return null;
  }
}

/**
 * Записать `health.json` при apply и при смене режима.
 *
 * `apply` вызывает с `force: true`; `tools/pre-execute` — без force, и файл
 * переписывается только когда режим, подписка или причина изменились. Так смена
 * `enforcement.structurePolicy` попадает в свидетельство на первом же вызове, а
 * каждый вызов инструмента не переписывает файл.
 *
 * @param options.root - корень проекта.
 * @param options.runtime - рантайм плагина (подписка и каталог структуры).
 * @param options.preExecuteSubscribed - подписка; по умолчанию — из рантайма.
 * @param options.error - причина, если есть.
 * @param options.force - записать, даже если ничего не изменилось.
 * @returns записанный объект, `null` — записи не было или она не удалась.
 */
export function recordPolicyHealth({ root, runtime, preExecuteSubscribed, error, force } = {}) {
  let resolvedRoot;
  try {
    resolvedRoot = path.resolve(String(root || process.cwd()));
  } catch {
    resolvedRoot = String(root || '');
  }
  const state = readStructurePolicy(resolvedRoot);
  const subscription = runtime && runtime.structurePolicySubscription;
  const subscribed = preExecuteSubscribed === undefined
    ? Boolean(subscription && subscription.preExecute === true)
    : preExecuteSubscribed === true;
  const reason = error === undefined || error === null ? (state.error || '') : String(error);
  const signature = [state.mode, subscribed ? '1' : '0', reason].join('\u0000');
  if (!force && healthSignatures.get(resolvedRoot) === signature) return null;
  const body = writePolicyHealth({
    root: resolvedRoot,
    store: storeDir(resolvedRoot),
    preExecuteSubscribed: subscribed,
    error: reason,
  });
  if (body) healthSignatures.set(resolvedRoot, signature);
  return body;
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

/* ------------------------------------------------------------------ */
/* 0102: гейт записи — продуктовый код только в allowedPaths задания    */
/* ------------------------------------------------------------------ */

/**
 * Допустимые режимы enforcement.writePolicy и режим по умолчанию.
 *
 * Нет ключа (и ошибка чтения конфига) — off: гейт записи включается только
 * осознанно, как и гейт процесса. Обратная совместимость важнее строгости по
 * умолчанию: инсталляция, не объявившая ключ, работает как раньше.
 */
export const WRITE_POLICY_MODES = Object.freeze(['off', 'warn', 'fail']);
export const DEFAULT_WRITE_POLICY = 'off';

/** Инструменты, которые пишут файлы (имена без учёта регистра). */
export const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'multi_edit', 'apply_patch']);

/**
 * Продуктовые пути: код и зависимости. Только они гейтятся — всё остальное
 * (документы, структура, обмен, артефакты) координатор и движок пишут свободно.
 *
 * `checks/**` здесь нет (0114): проверки пишутся до задания, их защита —
 * `criteria.lock` и приёмка, а не гейт записи.
 */
export const PRODUCT_PATH_PATTERNS = Object.freeze([
  'lib/**', 'test/**', 'tools/**', 'vendor/**', 'package.json', 'pnpm-lock.yaml',
]);

/**
 * Роли, которым структура не даёт писать продуктовый код (0118).
 *
 * Сравнение нормализованное (`normalizeRoleName`): регистр, лишние пробелы и
 * «ё» не важны, поэтому «Приёмщик», «приемщик» и «judge» — одна роль.
 */
export const BLOCKED_WRITE_ROLES = Object.freeze([
  'приёмщик', 'судья', 'judge', 'координатор', 'coordinator',
]);

/**
 * Проверки задания (0114). Не продукт и не гейтятся: координатор пишет проверку
 * до создания задания, когда активного `allowedPaths` ещё нет.
 */
export const CHECKS_PATH_PATTERNS = Object.freeze(['checks/**']);

/** Документы и данные, которые гейт записи не трогает никогда. */
export const FREE_PATH_PATTERNS = Object.freeze([
  'docs/**', 'structure/**', 'coordination/**', 'artifacts/**', 'README.md', 'HANDOVER-NEXT.md',
]);

/** Каталог заданий относительно корня проекта. */
export const TASKS_DIR_RELATIVE = path.join('docs', 'tasks');

/** Каталог задания считается заданием, только если имя — номер. */
const TASK_ID_PATTERN = /^\d{4,}$/u;

/** Аргументы инструмента, где лежит один путь записи. */
const WRITE_PATH_KEYS = Object.freeze(['file_path', 'filePath', 'filepath', 'path', 'file', 'filename', 'target', 'targetPath']);

/** Аргументы, где лежит список путей (multi_edit: edits[] с file_path внутри). */
const WRITE_PATH_LIST_KEYS = Object.freeze(['paths', 'files', 'edits', 'targets']);

/** Аргументы apply_patch с текстом патча: из него берутся пути заголовков. */
const WRITE_PATCH_KEYS = Object.freeze(['patch', 'input', 'text', 'diff']);

/**
 * Режим гейта записи из общего блока движка workflow.
 *
 * off (и отсутствие ключа enforcement.writePolicy) — не проверять; warn —
 * пропустить и записать решение; fail — отказ до исполнения. Ошибка чтения
 * конфига не блокирует запись: fail — только осознанный режим.
 *
 * @param root - корень проекта.
 * @returns { mode: 'off'|'warn'|'fail', source: 'config'|'default', error? }.
 */
export function readWritePolicy(root) {
  const { enforcement, error } = readEnforcement(root);
  if (!enforcement) {
    return error === undefined || error === null
      ? { mode: DEFAULT_WRITE_POLICY, source: 'default' }
      : { mode: DEFAULT_WRITE_POLICY, source: 'default', error };
  }
  const value = enforcement.writePolicy;
  if (value === undefined || value === null) {
    return { mode: DEFAULT_WRITE_POLICY, source: 'default' };
  }
  if (typeof value !== 'string' || !WRITE_POLICY_MODES.includes(value)) {
    return {
      mode: DEFAULT_WRITE_POLICY,
      source: 'default',
      error: 'неверное значение enforcement.writePolicy: ' + JSON.stringify(value)
        + ' (допустимо ' + WRITE_POLICY_MODES.join('|') + ')',
    };
  }
  return { mode: value, source: 'config' };
}

/** Инструмент гейтится по записи (имя без учёта регистра)? */
export function isWriteTool(name) {
  return typeof name === 'string' && WRITE_TOOL_NAMES.has(name.trim().toLowerCase());
}

/** Абсолютный корень проекта; пустое значение — текущий каталог. */
function projectRootOf(root) {
  try {
    return path.resolve(String(root || process.cwd()));
  } catch {
    return path.resolve(process.cwd());
  }
}

/**
 * Путь для сравнения: прямые слэши, без ведущего ./; на Windows — нижний
 * регистр (как pathKey в отчётах: файловая система регистр не различает).
 */
function pathKeyOf(value) {
  const text = String(value || '').replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/^\/+/u, '').replace(/\/+$/u, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/** Путь для человека: прямые слэши, без ведущего ./. */
function displayPathOf(value) {
  return String(value || '').replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/^\/+/u, '').replace(/\/+$/u, '');
}

/**
 * Совпадает ли относительный путь с шаблоном allowedPaths.
 *
 * Те же правила, что в отчётах (lib/report-evidence.js): точное имя (и каталог с
 * этим префиксом), * — сегмент, ** — любая глубина, ** вместе с завершающим
 * слэшем — ноль или больше каталогов. Абсолютных путей не бывает: вызывающий
 * передаёт путь от корня.
 *
 * @param relative - путь от корня проекта.
 * @param pattern - шаблон из TASK-META.allowedPaths.
 * @returns true, если путь покрыт шаблоном.
 */
export function matchesGlob(relative, pattern) {
  const target = pathKeyOf(relative);
  const raw = pathKeyOf(pattern);
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
    source += char.replace(/[.*+?^$\{}()|[\]\\]/gu, '\\$&');
  }
  source += '$';
  return new RegExp(source, 'u').test(target);
}

/** Путь продуктовый (код или зависимости) — только он гейтится. */
export function isProductPath(relative) {
  return PRODUCT_PATH_PATTERNS.some((pattern) => matchesGlob(relative, pattern));
}

/**
 * Путь — проверка задания (`checks/**`), которую гейт записи не держит (0114).
 *
 * Отдельная функция нужна не гейту, а решению: причина «проверка … вне гейта
 * записи: checks/** пишется до задания» точнее, чем «документы и данные».
 */
export function isChecksPath(relative) {
  return CHECKS_PATH_PATTERNS.some((pattern) => matchesGlob(relative, pattern));
}

/**
 * Активные задания проекта: docs/tasks/<id>/task.md с TASK-META и без
 * acceptance.json.
 *
 * Принятое задание (acceptance.json) активным не считается: иначе закрытое
 * задание навсегда разрешало бы правку своих путей. Задание без TASK-META или с
 * битым JSON тоже не активно — разрешать по нему нечего. Список отсортирован от
 * новых к старым (mtime task.md): причина отказа называет ближайшее задание.
 *
 * @param root - корень проекта.
 * @returns [{ id, dir, allowedPaths, meta }], новые первыми.
 */
export function readActiveTasks(root) {
  const base = projectRootOf(root);
  const dir = path.join(base, TASKS_DIR_RELATIVE);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TASK_ID_PATTERN.test(entry.name)) continue;
    const taskDir = path.join(dir, entry.name);
    const taskFile = path.join(taskDir, 'task.md');
    let stat;
    try {
      stat = fs.statSync(taskFile);
    } catch {
      continue;
    }
    if (fs.existsSync(path.join(taskDir, 'acceptance.json'))) continue;
    let meta = null;
    try {
      meta = parseTaskMeta(fs.readFileSync(taskFile, 'utf8'));
    } catch {
      meta = null;
    }
    if (!meta || typeof meta !== 'object') continue;
    const allowedPaths = Array.isArray(meta.allowedPaths)
      ? meta.allowedPaths.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [];
    tasks.push({ id: entry.name, dir: taskDir, allowedPaths, meta, mtimeMs: stat.mtimeMs });
  }
  tasks.sort((left, right) => (right.mtimeMs - left.mtimeMs) || (left.id < right.id ? 1 : (left.id > right.id ? -1 : 0)));
  return tasks;
}

/** Абсолютный путь записи; null — проверять нечего. */
function absoluteTargetOf(root, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  try {
    return path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text);
  } catch {
    return null;
  }
}

/** Путь от корня; null — цель вне корня проекта. */
function relativeTargetOf(root, target) {
  const relative = path.relative(root, target);
  if (!relative) return '';
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) return null;
  return displayPathOf(relative);
}

/**
 * Решение гейта записи по пути, без режима: allow/deny и причина.
 *
 * Продуктовый путь разрешён, только если его покрывает allowedPaths активного
 * задания; документы и данные разрешены всегда. Причина отказа называет путь и
 * задание (или говорит, что активного задания нет), чтобы модель сразу видела,
 * чего не хватает, а не повторяла запись.
 */
function adjudicateWrite(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const root = projectRootOf(input.root);
  const target = absoluteTargetOf(root, input.path);
  if (!target) return { allow: true, reason: 'путь записи не указан: гейт записи не применяется' };
  const relative = relativeTargetOf(root, target);
  if (relative === null) {
    return { allow: true, reason: 'путь вне корня проекта: гейт записи не применяется' };
  }
  const display = relative || '.';
  if (!isProductPath(relative)) {
    if (isChecksPath(relative)) {
      /* 0114: проверки вне гейта; задание называем, если оно их покрывает. */
      const tasks = readActiveTasks(root);
      const covering = tasks.find((task) => task.allowedPaths.some((pattern) => matchesGlob(relative, pattern)));
      if (covering) {
        return {
          allow: true,
          reason: 'проверка ' + display + ' входит в allowedPaths задания ' + covering.id,
          task: covering.id,
          path: display,
        };
      }
      return {
        allow: true,
        reason: 'проверка ' + display + ' вне гейта записи: checks/** пишется до задания,'
          + ' защита — criteria.lock и приёмка',
        path: display,
      };
    }
    return {
      allow: true,
      reason: 'путь ' + display + ' вне гейта записи: документы и данные не ограничены',
      path: display,
    };
  }
  const tasks = readActiveTasks(root);
  const matched = tasks.find((task) => task.allowedPaths.some((pattern) => matchesGlob(relative, pattern)));
  if (matched) {
    /*
     * 0118: путь разрешён заданием, но не всякой роли. Приёмщик и координатор
     * подписывают отчётом и распределяют — код пишет исполнитель; неизвестная
     * сессия остаётся прежним поведением (allow с причиной unknown-session),
     * потому что блокировать работу по догадке нельзя.
     */
    const role = sessionRoleOf({ root, runtime: input.runtime, sessionId: input.sessionId });
    if (role.known === true && isBlockedWriteRole(role.role)) {
      return {
        allow: false,
        path: display,
        task: matched.id,
        role: role.role,
        node: role.node,
        session: role.session,
        reason: 'роль «' + role.role + '» (узел ' + role.node + ') не пишет продуктовый код:'
          + ' путь ' + display + ' разрешён заданием ' + matched.id + ', но запрещён роли',
      };
    }
    return {
      allow: true,
      reason: 'путь ' + display + ' входит в allowedPaths задания ' + matched.id
        + (role.known === true
          ? ''
          : ' (unknown-session: роль сессии не определена, гейт по роли не применяется)'),
      task: matched.id,
      path: display,
    };
  }
  if (tasks.length === 0) {
    return {
      allow: false,
      reason: 'нет активного задания: запись в продуктовый путь ' + display + ' запрещена',
      path: display,
    };
  }
  const named = tasks.map((task) => task.id).join(', ');
  const label = tasks.length === 1 ? 'активного задания ' : 'активных заданий ';
  return {
    allow: false,
    reason: 'путь ' + display + ' вне allowedPaths ' + label + named,
    task: tasks[0].id,
    path: display,
  };
}

/**
 * Решение гейта записи по пути.
 *
 * off — allow; warn — allow, но причина говорит, что запись была бы отклонена
 * (решение пишет tools/pre-execute); fail — allow только внутри allowedPaths
 * активного задания. Ошибка самой политики не блокирует запись: функция
 * возвращает allow с причиной, а не бросает (гейт — наблюдение, а не условие
 * работы узла).
 *
 * 0117: без явного `root` и с рантаймом корень выбирается по пути записи
 * (`rootForPath`): конфиг читается у того корня, куда идёт запись, а не у первого
 * корня хоста. Правила самих решений (0102/0114) не меняются.
 *
 * @param options.root - корень проекта; нет — из `runtime` по `path`, затем cwd.
 * @param options.runtime - рантайм плагина (`allowedRoots()` — корни хоста).
 * @param options.path - абсолютный или относительный (от корня) путь записи.
 * @param options.tool - инструмент, если решение пишется в журнал вызывающим.
 * @returns { allow, reason, mode, task? }.
 */
export function writeDecision(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const root = writeRootOf(input);
  const policy = readWritePolicy(root);
  if (policy.mode === 'off') {
    return { allow: true, reason: 'writePolicy=off: гейт записи выключен', mode: 'off' };
  }
  let verdict;
  try {
    verdict = adjudicateWrite({
      root,
      path: input.path,
      runtime: input.runtime,
      sessionId: input.sessionId,
    });
  } catch (error) {
    return {
      allow: true,
      reason: 'ошибка политики записи не блокирует запись: ' + messageOf(error),
      mode: policy.mode,
    };
  }
  if (policy.mode === 'warn' && verdict.allow !== true) {
    const decision = { allow: true, reason: 'writePolicy=warn: ' + verdict.reason, mode: 'warn' };
    return copyVerdictFields(verdict, decision);
  }
  const decision = { allow: verdict.allow === true, reason: verdict.reason, mode: policy.mode };
  return copyVerdictFields(verdict, decision);
}

/** Поля решения (задание, роль, узел, сессия), которые видны вызывающему. */
function copyVerdictFields(verdict, decision) {
  for (const key of ['task', 'role', 'node', 'session']) {
    if (verdict && verdict[key] !== undefined) decision[key] = verdict[key];
  }
  return decision;
}

/**
 * Пути записи из аргументов инструмента.
 *
 * Имена полей разных инструментов различаются (file_path, path, edits[], патч
 * apply_patch), поэтому путь собирается из известных полей, а не из одного. Для
 * apply_patch пути берутся из заголовков патча (*** Update File:, +++ b/…):
 * инструмент не называет файл полем.
 *
 * @param exec - вызов инструмента ({ name, arguments }).
 * @returns Список путей без повторов; пустой — путей не найти.
 */
export function writeTargets(exec) {
  const args = exec && exec.arguments;
  const out = [];
  if (!args || typeof args !== 'object' || Array.isArray(args)) return out;
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
  };
  for (const key of WRITE_PATH_KEYS) push(args[key]);
  for (const key of WRITE_PATH_LIST_KEYS) {
    const value = args[key];
    if (typeof value === 'string') {
      push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string') {
        push(item);
        continue;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      for (const inner of WRITE_PATH_KEYS) {
        if (typeof item[inner] === 'string' && item[inner].trim()) {
          push(item[inner]);
          break;
        }
      }
    }
  }
  const name = exec && typeof exec.name === 'string' ? exec.name.trim().toLowerCase() : '';
  if (name === 'apply_patch') {
    for (const key of WRITE_PATCH_KEYS) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) {
        for (const target of patchTargets(value)) out.push(target);
        break;
      }
    }
  }
  const seen = new Set();
  const unique = [];
  for (const value of out) {
    const key = pathKeyOf(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

/**
 * Пути из заголовков патча apply_patch.
 *
 * Патч — текст, а не поле пути: файл называют строки *** Add|Update|Delete File:,
 * *** Move to:, +++ b/… и rename from|to. Список — данные, а не приказ: его
 * проверяет тот же writeDecision.
 */
function patchTargets(text) {
  const targets = [];
  for (const line of String(text || '').split(/\r?\n/u)) {
    const strong = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/u.exec(line);
    if (strong) { targets.push(strong[1].trim()); continue; }
    const move = /^\*\*\*\s+Move to:\s*(.+)$/u.exec(line);
    if (move) { targets.push(move[1].trim()); continue; }
    const plus = /^\+\+\+\s+(?:b\/)?(.+)$/u.exec(line);
    if (plus) { targets.push(plus[1].split('\t')[0].trim()); continue; }
    const rename = /^rename\s+(?:from|to)\s+(.+)$/u.exec(line);
    if (rename) targets.push(rename[1].trim());
  }
  return targets.filter((value) => value && value !== '/dev/null');
}

/**
 * Причина отказа гейта записи: инструмент, путь, задание и режим.
 *
 * Отказ возвращается до исполнения, поэтому текст обязан быть достаточным, чтобы
 * модель поняла границу задания и не повторяла запись.
 */
export function writeDenyReason(tool, decision) {
  const target = decision && decision.path ? decision.path : 'путь';
  const reason = decision && decision.reason ? decision.reason : '';
  return 'Отказ: структура запрещает запись в ' + target + ' инструментом ' + String(tool || 'write')
    + ' — ' + reason + ' (enforcement.writePolicy=fail).'
    + ' Продуктовый код правится только в рамках активного задания: allowedPaths из docs/tasks/<id>/task.md.';
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

/* ------------------------------------------------------------------ */
/* 0118: роль сессии — приёмщик и координатор не пишут продуктовый код */
/* ------------------------------------------------------------------ */

/** Имя роли для сравнения: регистр, пробелы и «ё» не важны. */
export function normalizeRoleName(role) {
  return String(role === undefined || role === null ? '' : role)
    .trim()
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ');
}

/** Роль не пишет продуктовый код (0118)? */
export function isBlockedWriteRole(role) {
  const value = normalizeRoleName(role);
  if (!value) return false;
  return BLOCKED_WRITE_ROLES.some((blocked) => normalizeRoleName(blocked) === value);
}

/**
 * Идентификатор сессии из вызова инструмента (0118).
 *
 * Хост отдаёт вызвавшего в `exec.agent`: по контракту `ToolExecution.agent` —
 * это `Agent` с полем `id` (SessionId); живые версии кладут и `session`
 * (строка или объект с `id`). Поля проверяются по очереди, пустое значение —
 * «сессии нет»: гейт по роли тогда молчит, а не догадывается.
 */
export function sessionIdOfExec(exec) {
  if (!exec || typeof exec !== 'object') return '';
  const agent = exec.agent;
  const candidates = [
    exec.sessionId,
    exec.session,
    exec.agentId,
    agent,
    agent && typeof agent === 'object' ? agent.sessionId : undefined,
    agent && typeof agent === 'object' ? agent.session : undefined,
    agent && typeof agent === 'object' ? agent.id : undefined,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && typeof value.id === 'string' && value.id.trim()) return value.id.trim();
  }
  return '';
}

/**
 * Идентификатор сессии из контекста подписки (0118).
 *
 * Хост может подписать обработчик в scoped-контексте агента; проверяются только
 * явные поля сессии. Пустое значение — «контекст сессии недоступен»: поведение
 * пункта «неизвестная сессия» (allow), иначе гейт ломал бы работу.
 */
export function sessionIdOfContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const candidates = [
    ctx.sessionId,
    ctx.session,
    ctx.agent,
    ctx.agent && typeof ctx.agent === 'object' ? ctx.agent.sessionId : undefined,
    ctx.agent && typeof ctx.agent === 'object' ? ctx.agent.session : undefined,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      for (const field of ['id', 'sessionId', 'session']) {
        const inner = value[field];
        if (typeof inner === 'string' && inner.trim()) return inner.trim();
        if (inner && typeof inner === 'object' && typeof inner.id === 'string' && inner.id.trim()) return inner.id.trim();
      }
    }
  }
  return '';
}

/**
 * Роль вызывающей сессии по журналу прогонов (0118).
 *
 * Запись `runs` с `childId == sessionId` даёт узел, узел из структуры проекта —
 * роль строкой. Нет сессии, записи, узла или роли в структуре — `known: false`
 * с причиной, начинающейся словом `unknown-session`: это не отказ, а честное
 * «роль неизвестна». Ошибка чтения журнала или структуры не бросается.
 *
 * @param options.root - корень проекта.
 * @param options.runtime - рантайм плагина (журнал прогонов и каталог структуры).
 * @param options.sessionId - идентификатор вызывающей сессии.
 * @returns `{ known, session, node, role, reason }`.
 */
export function sessionRoleOf({ root, runtime, sessionId } = {}) {
  const session = typeof sessionId === 'string' ? sessionId.trim() : '';
  const base = projectRootOf(root);
  if (!session) {
    return {
      known: false, session: '', node: '', role: '',
      reason: 'unknown-session: вызывающая сессия не названа',
    };
  }
  let record = null;
  try {
    const rows = listRuns(runtime, base);
    const all = Array.isArray(rows) && rows.length > 0 ? rows : listRuns(runtime);
    record = (Array.isArray(all) ? all : []).find((row) => row
      && String(row.childId === undefined || row.childId === null ? '' : row.childId).trim() === session
      && (!row.root || comparePathOf(row.root) === comparePathOf(base))) || null;
  } catch {
    record = null;
  }
  if (!record) {
    return {
      known: false, session, node: '', role: '',
      reason: 'unknown-session: нет записи прогона для сессии ' + session,
    };
  }
  const node = typeof record.node === 'string' ? record.node.trim() : '';
  if (!node) {
    return {
      known: false, session, node: '', role: '',
      reason: 'unknown-session: запись сессии ' + session + ' не называет узел',
    };
  }
  const declared = declaredNodes(base, runtime);
  const found = declared.find((item) => item.id === node);
  if (!found) {
    return {
      known: false, session, node, role: '',
      reason: 'unknown-session: узел ' + node + ' сессии ' + session + ' не объявлен в структуре',
    };
  }
  const role = typeof found.role === 'string' ? found.role.trim() : '';
  return { known: true, session, node, role };
}

/**
 * Причина отказа гейта по роли (0118): путь, роль и рецепт структуры.
 *
 * Отказ возвращается до исполнения, поэтому текст называет и границу задания, и
 * то, что делать вместо правки кода: код пишет исполнитель, приёмщик подписывает
 * отчётом.
 */
export function roleDenyReason(tool, decision) {
  const target = decision && decision.path ? decision.path : 'путь';
  const role = decision && decision.role ? decision.role : 'приёмщик';
  return 'Отказ: структура запрещает запись в ' + target + ' инструментом ' + String(tool || 'write')
    + ' — роль «' + role + '» не пишет продуктовый код (enforcement.writePolicy=fail);'
    + ' код пишет исполнитель; приёмщик подписывает отчётом. Отчёт — документ в docs/tasks/<id>/,'
    + ' документы и данные структуры доступны роли без ограничений.';
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
 * Объявленные корни хоста (`runtime.allowedRoots()`) — абсолютными путями.
 *
 * Функция не бросает: реестр воркспейсов может отказать, а политика не имеет
 * права падать из-за выбора корня. Пустые и нестроковые значения пропускаются,
 * повторы схлопываются по пути файловой системы.
 *
 * @param runtime - рантайм плагина.
 * @returns Список абсолютных корней; пустой — корней не объявлено.
 */
function allowedRootsOf(runtime) {
  const out = [];
  let listed = null;
  try {
    if (runtime && typeof runtime.allowedRoots === 'function') listed = runtime.allowedRoots();
  } catch {
    return out;
  }
  if (!Array.isArray(listed)) return out;
  const seen = new Set();
  for (const item of listed) {
    if (typeof item !== 'string' || !item.trim()) continue;
    let absolute;
    try {
      absolute = path.resolve(item);
    } catch {
      continue;
    }
    const key = comparePathOf(absolute);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(absolute);
  }
  return out;
}

/**
 * Путь для сравнения корней: прямые слэши, без хвостового разделителя; на
 * Windows — нижний регистр, потому что файловая система регистр не различает.
 */
function comparePathOf(value) {
  let text = String(value || '').replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (process.platform === 'win32') text = text.toLowerCase();
  return text;
}

/** Корень содержит путь (на границе сегмента, а не по префиксу строки). */
function containsPath(root, target) {
  const base = comparePathOf(root);
  const targetKey = comparePathOf(target);
  if (!base || !targetKey) return false;
  if (targetKey === base) return true;
  return targetKey.startsWith(base + '/');
}

/**
 * Корень проекта, которому принадлежит путь (`0117`).
 *
 * Из `runtime.allowedRoots()` выбирается САМЫЙ ДЛИННЫЙ корень, содержащий
 * `target` (на Windows — без учёта регистра): конфиг читается у того корня, куда
 * идёт запись, а не у первого корня хоста. Путь вне всех корней (и корни, которых
 * нет) не превращаются в корень: возвращается корень рантайма (currentRoot,
 * первый объявленный, defaultRoot), затем cwd. Сама функция не бросает.
 *
 * @param runtime - рантайм плагина (`allowedRoots()` — список воркспейсов).
 * @param target - путь записи (абсолютный или относительный — от корня по умолчанию).
 * @returns Абсолютный корень проекта.
 */
export function rootForPath(runtime, target) {
  const fallback = rootOf(runtime);
  const roots = allowedRootsOf(runtime);
  if (roots.length === 0) return fallback;
  const absolute = absoluteTargetOf(fallback, target);
  if (!absolute) return fallback;
  let best = null;
  for (const candidate of roots) {
    if (!containsPath(candidate, absolute)) continue;
    if (best === null || candidate.length > best.length) best = candidate;
  }
  return best === null ? fallback : best;
}

/**
 * Корень решения о записи: явный `root` — приказ вызывающего, иначе корень по
 * пути (`rootForPath`), иначе корень проекта по умолчанию.
 *
 * @param input - `{ runtime?, root?, path }`.
 * @returns Абсолютный корень проекта.
 */
function writeRootOf(input) {
  const options = input && typeof input === 'object' ? input : {};
  if (typeof options.root === 'string' && options.root.trim()) return projectRootOf(options.root);
  if (options.runtime && typeof options.runtime === 'object') return rootForPath(options.runtime, options.path);
  return projectRootOf(undefined);
}

/**
 * Корень гейта записи для `tools/pre-execute`: путь записи решает, чей конфиг
 * читать (`0117`). Явный `root` остаётся запасным путём для тестов и старого
 * хоста; рантайм с объявленными корнями важнее, потому что при мультикорневом
 * хосте переданный корень — всего лишь currentRoot (живой случай 1.0.16).
 *
 * @param options.root - корень от вызывающего, если есть.
 * @param options.runtime - рантайм плагина.
 * @param options.target - первый целевой путь записи.
 * @returns Абсолютный корень проекта.
 */
function writeGateRoot({ root, runtime, target } = {}) {
  if (target && allowedRootsOf(runtime).length > 0) return rootForPath(runtime, target);
  return typeof root === 'string' && root.trim() ? projectRootOf(root) : rootOf(runtime);
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
 * Затем гейт записи (0102): `write/edit/multi_edit/apply_patch` по продуктовым
 * путям при `writePolicy=fail` — отказ до исполнения вне `allowedPaths` активного
 * задания; `warn` пишет решение в журнал и пропускает; `off` молчит. Корень
 * гейта записи (0117) — по ПЕРВОМУ целевому пути (`rootForPath`), этот же корень
 * идёт в журнал; при мультикорневом хосте переданный `root` не решает.
 * Роль вызывающей сессии (0118) проверяется для того же продуктового пути: если
 * журнал прогонов связал сессию с узлом приёмщика/судьи или координатора, запись
 * кода запрещена даже внутри `allowedPaths` (отказ называет путь, роль и рецепт),
 * а при неизвестной сессии решение остаётся прежним.
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
 * @param options.sessionId - вызывающая сессия (0118); нет — из `exec.agent`.
 * @returns Результат downstream или `{ kind: 'deny', reason }`.
 */
export async function handlePreExecute({ exec, next, runtime, root, sessionId } = {}) {
  const continueNext = typeof next === 'function' ? next : async () => ({ kind: 'allow' });
  const name = exec && typeof exec.name === 'string' ? exec.name.trim() : '';
  /*
   * 0118: роль вызывающей сессии. Хост отдаёт вызвавшего в `exec.agent`
   * (`id` — id сессии); тест и старый хост могут передать `sessionId` явно.
   * Нет сессии — role-гейт молчит: неизвестная сессия не блокируется.
   */
  const session = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : sessionIdOfExec(exec);
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
  if (isWriteTool(name)) {
    // Гейт записи не зависит от объявленных узлов: его включает только
    // собственный ключ enforcement.writePolicy. Решение принимается по путям из
    // аргументов; ошибка чтения конфига, разбора задания или самой проверки
    // вызов не блокирует — fail только по осознанному режиму.
    try {
      const targets = writeTargets(exec);
      /*
       * 0117: конфиг читается у корня ПЕРВОГО целевого пути (rootForPath), а не у
       * корня, который передал хост: в мультикорневом хосте переданный корень —
       * currentRoot, и writePolicy=fail проекта не удерживался (случай 1.0.16).
       * Этот же корень идёт в журнал: решение пишется в хранилище того проекта.
       */
      const projectRoot = writeGateRoot({ root, runtime, target: targets[0] });
      const policy = readWritePolicy(projectRoot);
      if (policy.mode !== 'off') {
        for (const target of targets) {
          // Сырое решение, без режима: warn должен увидеть запрет, чтобы
          // записать его в журнал, хотя сам вызов он пропускает.
          const verdict = adjudicateWrite({
            root: projectRoot,
            path: target,
            runtime,
            sessionId: session,
          });
          if (verdict.allow === true) continue;
          const denied = policy.mode === 'fail';
          recordAlternative({
            root: projectRoot,
            tool: name,
            detail: verdict.reason,
            mode: policy.mode,
            denied,
          });
          if (denied) {
            return {
              kind: 'deny',
              reason: verdict.role ? roleDenyReason(name, verdict) : writeDenyReason(name, verdict),
            };
          }
        }
      }
    } catch (error) {
      warn('гейт записи не сработал: ' + messageOf(error));
    }
    return continueNext();
  }
  if (!ALTERNATIVE_TOOL_NAMES.has(name)) return continueNext();
  try {
    const projectRoot = root ? path.resolve(String(root)) : rootOf(runtime);
    const nodes = declaredNodes(projectRoot, runtime);
    if (nodes.length === 0) return continueNext();
    const policy = readStructurePolicy(projectRoot);
    /* 0101: режим и подписка — в health.json; файл переписывается при смене. */
    recordPolicyHealth({ root: projectRoot, runtime, error: policy.error });
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
    recordPolicyHealth({ root: projectRoot, runtime, error: policy.error });
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
  let preExecute = false;
  let postExecute = false;
  try {
    /*
     * 0118: подписка передаёт сессию вызывающего. Она приходит в `exec.agent`
     * (id сессии); контекст подписки и собственный scoped-контекст — запасные
     * источники для хостов, которые кладут сессию только туда. Нет сессии —
     * обработчик работает как раньше (unknown-session, allow).
     */
    ctx.on(PRE_EXECUTE_EVENT, function (exec, next) {
      /*
       * Извлечение сессии — наблюдение, а не условие вызова: сбой чтения полей
       * контекста не должен ломать инструмент, поэтому он гасится в пустую
       * строку (неизвестная сессия, allow).
       */
      let sessionId = '';
      try {
        sessionId = sessionIdOfExec(exec) || sessionIdOfContext(ctx) || sessionIdOfContext(this);
      } catch {
        sessionId = '';
      }
      return handlePreExecute({ exec, next, runtime, root, sessionId });
    });
    subscribed = true;
    preExecute = true;
  } catch (error) {
    warn('подписка ' + PRE_EXECUTE_EVENT + ' не сделана: ' + messageOf(error));
  }
  try {
    ctx.on(POST_EXECUTE_EVENT, (exec, result, next) => handleToolResult({ exec, result, next, runtime, root }));
    subscribed = true;
    postExecute = true;
  } catch (error) {
    warn('подписка ' + POST_EXECUTE_EVENT + ' не сделана: ' + messageOf(error));
  }
  /*
   * 0101: apply пишет health.json, а факт подписки именно на pre-execute —
   * то, без чего fail не удерживается. Значение на рантайме, потому что
   * registerStructurePolicy по контракту возвращает boolean.
   */
  try {
    if (runtime && typeof runtime === 'object') {
      runtime.structurePolicySubscription = { preExecute, postExecute };
    }
  } catch {
    /* рантайм может быть заморожен: свидетельство просто не узнает подписку */
  }
  return subscribed;
}