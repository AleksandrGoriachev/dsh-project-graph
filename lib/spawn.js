/**
 * MVP-1: spawning one agent per structure node.
 *
 * The panel only edits structure files; this module is the only place where the
 * plugin acts. A model calls `project_graph_spawn`, and the node it names
 * decides the route: `nodes[].model` -> `models[alias]` -> provider/model.
 * The model never chooses a model itself, so the declaration reviewed in git is
 * the whole authority.
 *
 * Nothing here talks to DSH directly: the tool is a plain definition over
 * `ctx.tools.register`, and the subagent service is injected. That keeps the
 * resolver and the refusals testable without a harness.
 */
import path from 'node:path';
import { readGraph } from './api.js';
import { validateTaskFile } from './contract.js';
import { appendLaunch, localIso, newRunId, noteRun } from './runs.js';

export const SPAWN_TOOL_NAME = 'project_graph_spawn';
export const DEFAULT_PROVIDER = 'spawn';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function samePath(left, right) {
  const a = path.resolve(String(left)).replace(/[\\/]+$/u, '');
  const b = path.resolve(String(right)).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** A refusal with a stable code: the model sees the code, tests assert it. */
/**
 * Глубина по умолчанию: структуре «координатор → воркер» нужна 2, а если сама
 * сессия-владелец запущена доставкой/панелью — воркер уже на глубине 2. Хозяйский
 * потолок по умолчанию в другом DSH был 1 и отклонял такой запуск
 * («subagent depth 2 exceeds maxDepth 1»). Профиль может переопределить.
 */
export const DEFAULT_MAX_DEPTH = 3;

export function spawnError(code, message) {
  const error = new Error(SPAWN_TOOL_NAME + ': ' + code + ': ' + message);
  error.code = code;
  return error;
}

/**
 * Normalize a catalog into the shape the plan checks. A catalog that is not an
 * object with a providers list is not a catalog: the plan then works as before.
 */
function normalizeCatalog(catalog) {
  if (!isPlainObject(catalog) || !Array.isArray(catalog.providers)) return null;
  const providers = [];
  for (const row of catalog.providers) {
    if (!isPlainObject(row)) continue;
    const id = text(row.id) || text(row.name);
    if (!id) continue;
    const models = [];
    for (const item of Array.isArray(row.models) ? row.models : []) {
      const rawId = typeof item === 'string' ? text(item) : text(isPlainObject(item) ? item.id : '') || text(isPlainObject(item) ? item.name : '');
      if (!rawId) continue;
      const family = isPlainObject(item) ? text(item.family) : '';
      models.push({ id: rawId, name: isPlainObject(item) ? text(item.name) || rawId : rawId, ...(family ? { family } : {}) });
    }
    providers.push({ id, name: text(row.name) || id, models });
  }
  return { providers };
}

/** Ids of catalog rows for a refusal message; a dash when the list is empty. */
function catalogIds(rows) {
  const ids = rows.map((row) => row && row.id).filter(Boolean);
  return ids.length > 0 ? ids.join(', ') : '—';
}

/**
 * Resolve one node into a route without touching DSH.
 *
 * The route lives in the node: provider + model (+ family). A node of an old
 * graph keeps the alias in models{}: it is expanded only while the node has no
 * provider of its own, and the alias name is kept in modelAlias for the panel.
 *
 * @param graph - the merged, already validated structure.
 * @param nodeId - the node the model asked for.
 * @param options - { catalog } checks the route against the llm catalog before a
 *   run: an unknown provider/model is a refusal with names, not a crash after
 *   the spawn. A missing catalog keeps the old behaviour (provider+model enough).
 * @returns { ok, node, role, provider, model, family, modelAlias, preset }
 *   or { ok: false, code, message }.
 */
export function resolveNodePlan(graph, nodeId, options = {}) {
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const models = isPlainObject(graph && graph.models) ? graph.models : {};
  const id = typeof nodeId === 'string' ? nodeId.trim() : '';
  if (!id) return { ok: false, code: 'unknown-node', message: 'не указан узел структуры' };
  const node = nodes.find((item) => item && item.id === id);
  if (!node) {
    return {
      ok: false,
      code: 'unknown-node',
      message: 'узла «' + id + '» нет в структуре проекта: проверьте id или добавьте узел в structure/*.json',
    };
  }
  const declaredProvider = text(node.provider);
  const declaredModel = text(node.model);
  if (!declaredModel) {
    return {
      ok: false,
      code: 'node-without-model',
      message: 'у узла «' + id + '» не задана модель: укажите provider и model прямо в узле, иначе порождать агента не на чем',
    };
  }
  let provider = declaredProvider;
  let model = '';
  let family = text(node.family);
  let modelAlias = text(node.modelAlias) || null;
  /*
   * Прямой маршрут: provider+model узла. Алиас читается только тогда, когда
   * provider не задан, — иначе старый models{} перетёр бы прямое объявление.
   * modelAlias из миграции графа остаётся в ответе для совместимости панели.
   */
  if (declaredProvider) {
    model = declaredModel;
  } else {
    const aliasEntry = Object.hasOwn(models, declaredModel) ? models[declaredModel] : null;
    if (!isPlainObject(aliasEntry) || !text(aliasEntry.provider) || !text(aliasEntry.model)) {
      return {
        ok: false,
        code: 'node-without-model',
        message: 'у узла «' + id + '» model «' + declaredModel + '» задан без provider, и алиаса '
          + '«' + declaredModel + '» нет в models: укажите provider и model прямо в узле',
      };
    }
    modelAlias = modelAlias || declaredModel;
    provider = text(aliasEntry.provider);
    model = text(aliasEntry.model);
    if (!family) family = text(aliasEntry.family);
  }
  if (!provider || !model) {
    return {
      ok: false,
      code: 'node-without-model',
      message: 'у узла «' + id + '» маршрут неполон: нужны provider и model',
    };
  }
  /*
   * Каталог службы llm — проверка ДО запуска: провайдер и модель называются в
   * отказе вместе со списком доступного. Без каталога вопрос не доказан, и
   * план по-прежнему строится по объявлению.
   */
  const catalog = normalizeCatalog(options && options.catalog);
  if (catalog) {
    const providerRow = catalog.providers.find((row) => row.id === provider || row.name === provider);
    if (!providerRow) {
      return {
        ok: false,
        code: 'provider-missing',
        message: 'провайдера «' + provider + '» нет в каталоге моделей службы llm; доступны: '
          + catalogIds(catalog.providers),
      };
    }
    const modelRow = providerRow.models.find((row) => row.id === model || row.name === model);
    if (!modelRow) {
      return {
        ok: false,
        code: 'model-missing',
        message: 'у провайдера «' + providerRow.id + '» нет модели «' + model + '»; в каталоге: '
          + catalogIds(providerRow.models),
      };
    }
    if (!family && modelRow.family) family = modelRow.family;
  }
  return {
    ok: true,
    node: node.id,
    role: node.role || null,
    modelAlias,
    provider,
    model,
    family: family || null,
    preset: node.agentPreset || null,
  };
}

/**
 * Read the llm catalog in the form the plan checks.
 *
 * A missing service, an exception or an asynchronous refusal answers undefined:
 * the route is then taken from the declaration alone, as before. A catalog that
 * is down must not block every run — it only cannot prove the route.
 */
async function readSpawnCatalog(runtime) {
  if (!runtime || typeof runtime.getLlm !== 'function') return undefined;
  let llm;
  try {
    llm = runtime.getLlm();
  } catch {
    return undefined;
  }
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return undefined;
  let providers;
  try {
    providers = await llm.listProviders();
  } catch {
    return undefined;
  }
  if (!Array.isArray(providers)) return undefined;
  const rows = [];
  for (const provider of providers) {
    if (!isPlainObject(provider)) continue;
    const id = text(provider.id) || text(provider.name);
    if (!id) continue;
    let models;
    try {
      models = await llm.listModels(id);
    } catch {
      return undefined;
    }
    const list = [];
    for (const item of Array.isArray(models) ? models : []) {
      const modelId = typeof item === 'string' ? text(item) : text(isPlainObject(item) ? item.id : '') || text(isPlainObject(item) ? item.name : '');
      if (!modelId) continue;
      const family = isPlainObject(item) ? text(item.family) : '';
      list.push({ id: modelId, name: isPlainObject(item) ? text(item.name) || modelId : modelId, ...(family ? { family } : {}) });
    }
    rows.push({ id, name: text(provider.name) || id, models: list });
  }
  return { providers: rows };
}

/** Pick the project root: explicit, or the only allowed one. */
export function resolveRoot(runtime, requested) {
  const allowed = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
  if (allowed.length === 0) {
    return { ok: false, code: 'no-roots', message: 'не задан ни один корень проекта (roots в cordis.patch.yml)' };
  }
  const value = typeof requested === 'string' ? requested.trim() : '';
  if (!value) {
    if (allowed.length === 1) return { ok: true, root: allowed[0] };
    return {
      ok: false,
      code: 'root-required',
      message: 'корней несколько (' + allowed.length + '): укажите root явно',
    };
  }
  if (!path.isAbsolute(value)) {
    return { ok: false, code: 'root-not-allowed', message: 'корень должен быть абсолютным путём: ' + value };
  }
  const resolved = path.resolve(value);
  const match = allowed.find((root) => samePath(root, resolved));
  if (!match) return { ok: false, code: 'root-not-allowed', message: 'корень вне разрешённого списка: ' + resolved };
  return { ok: true, root: match };
}

/** The tool definition: JSON schema in, JSON value out. */
export function createSpawnTool(options) {
  const runtime = options.runtime;
  const config = isPlainObject(options.config) ? options.config : {};
  const getSubagents = options.getSubagents;
  const getAgentPresets = options.getAgentPresets;

  return {
    name: SPAWN_TOOL_NAME,
    description:
      "Start one agent declared in the project's structure/ folder, on the provider and model assigned to that node. "
      + 'The model comes from the declaration, never from this call. Use it to delegate work to a declared role; '
      + 'use plan: true to check the route without starting anything.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', description: 'Node id from structure/*.json (for example "lead-code").' },
        prompt: { type: 'string', description: 'The task for the child agent.' },
        root: { type: 'string', description: 'Absolute project root; optional when exactly one root is configured.' },
        task: { type: 'string', description: 'Task contract (docs/tasks/<id>) this run executes; refused when its executor/acceptor contradict the structure.' },
        plan: { type: 'boolean', description: 'Resolve and return the route without starting an agent.' },
      },
      required: ['node', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['activation', 'plan'] },
          childId: { type: 'string' },
          node: { type: 'string' },
          role: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          preset: { type: 'string' },
        },
        required: ['kind', 'node', 'provider', 'model'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'plan'
          ? 'node ' + value.node + ' -> ' + value.provider + '/' + value.model
            + (value.preset ? ' with preset ' + value.preset : '') + ' (plan only)'
          : 'started ' + value.node + ' as subagent ' + value.childId + ' on ' + value.provider + '/' + value.model
            + (value.preset ? ' with preset ' + value.preset : ''),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec && exec.agent;
      if (!parent) throw spawnError('no-parent', 'инструмент вызван без агента: вызовите его из сессии, у которой есть родитель');
      const subagents = typeof getSubagents === 'function' ? getSubagents() : null;
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw spawnError('spawn-unavailable', 'служба ctx.subagents не подключена: проверьте, что в DSH загружен плагин subagent');
      }
      const providerName = typeof config.provider === 'string' && config.provider.trim()
        ? config.provider.trim()
        : DEFAULT_PROVIDER;
      const provider = subagents.getProvider ? subagents.getProvider(providerName) : undefined;
      if (!provider) {
        throw spawnError('spawn-unavailable', 'провайдер «' + providerName + '» не зарегистрирован: проверьте, что в DSH подключён subagent-spawn-in-process');
      }
      if (!provider.capabilities || provider.capabilities.agentOptions !== true) {
        throw spawnError('spawn-unavailable',
          'провайдер «' + providerName + '» не умеет agentOptions: нужен локальный провайдер spawn, иначе модель узла не передать');
      }

      const rootSelection = resolveRoot(runtime, args && args.root);
      if (!rootSelection.ok) throw spawnError(rootSelection.code, rootSelection.message);
      const payload = readGraph(runtime, rootSelection.root);
      if (payload.errors.length > 0) {
        const first = payload.errors[0];
        throw spawnError('structure-invalid',
          'структура недействительна: ' + first.message + (first.fix ? ' Что сделать: ' + first.fix : ''));
      }
      /*
       * A task contract is checked against the structure before any work starts:
       * the graph decides who accepts whose result, so a contract that names a
       * different acceptor is a bypass and is refused here, not noticed later.
       */
      const taskArg = args && typeof args.task === 'string' ? args.task.trim() : '';
      if (taskArg) {
        const taskRoot = path.resolve(rootSelection.root);
        const taskFile = path.resolve(taskRoot, taskArg);
        if (taskFile !== taskRoot && !taskFile.startsWith(taskRoot + path.sep)) {
          throw spawnError('task-outside-root', 'задание должно лежать внутри корня проекта: ' + taskArg);
        }
        const problems = validateTaskFile(payload.graph, taskFile);
        if (problems.length > 0) {
          throw spawnError('task-contradicts-structure',
            'контракт задания противоречит структуре: ' + problems.join('; ')
            + '. Исправьте acceptor в задании или связь в structure/*.json — обходить структуру нельзя.');
        }
      }
      /*
       * Каталог проверяется в плане, до старта: неизвестный провайдер или модель
       * отказывают с именами, а не всплывают падением уже запущенного агента.
       * Недоступная служба llm каталога не даёт — план работает как раньше.
       */
      const plan = resolveNodePlan(payload.graph, args && args.node, { catalog: await readSpawnCatalog(runtime) });
      if (!plan.ok) throw spawnError(plan.code, plan.message);

      if (plan.preset) {
        if (!provider.capabilities || provider.capabilities.agentPreset !== true) {
          throw spawnError('spawn-unavailable',
            'провайдер «' + providerName + '» не умеет agentPreset: пресет узла не передать');
        }
        const presets = typeof getAgentPresets === 'function' ? getAgentPresets() : null;
        if (!presets || typeof presets.resolve !== 'function') {
          throw spawnError('preset-unavailable',
            'узел «' + plan.node + '» требует пресет «' + plan.preset + '», но служба agentPresets не подключена');
        }
        try {
          const resolved = await presets.resolve(plan.preset);
          if (resolved && resolved.broken) {
            throw spawnError('preset-broken',
              'пресет «' + plan.preset + '» у узла «' + plan.node + '» не активируется: '
                + (typeof resolved.broken === 'string' ? resolved.broken : JSON.stringify(resolved.broken)));
          }
        } catch (error) {
          if (error && (error.code === 'preset-broken' || error.code === 'preset-unavailable' || error.code === 'unknown-preset')) throw error;
          let available = [];
          try {
            const rows = typeof presets.list === 'function' ? await presets.list() : [];
            available = (rows || []).map((row) => row && row.id).filter(Boolean);
          } catch {
            available = [];
          }
          throw spawnError('unknown-preset',
            'пресета «' + plan.preset + '» нет в DSH'
              + (available.length > 0 ? '; доступны: ' + available.join(', ') : '')
              + '. Исправьте agentPreset в structure/*.json или объявите пресет.');
        }
      }

      const value = {
        kind: args && args.plan === true ? 'plan' : 'activation',
        node: plan.node,
        role: plan.role || undefined,
        provider: plan.provider,
        model: plan.model,
        ...(plan.preset ? { preset: plan.preset } : {}),
      };
      if (value.kind === 'plan') return value;

      let maxDepth;
      if (typeof subagents.resolveMaxDepth === 'function') {
        maxDepth = subagents.resolveMaxDepth(config.maxDepth === undefined ? DEFAULT_MAX_DEPTH : config.maxDepth);
      }
      const runId = newRunId();
      const request = {
        /*
         * The child works in the workspace that declares the node, not in the
         * caller's directory: otherwise a structure of project B started from a
         * session of project A would read and write A's files while claiming to
         * run B's node.
         */
        cwd: rootSelection.root,
        prompt: promptWithRunId(String(args.prompt), runId),
        parent,
        agentOptions: { provider: plan.provider, model: plan.model },
        ...(plan.preset ? { agentPreset: plan.preset } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      };
      const since = Date.now();
      noteRun(runtime, { root: rootSelection.root, node: plan.node, state: 'running', since });
      let activation;
      try {
        activation = await subagents.startActivation({
          provider: providerName,
          label: (plan.role ? plan.role + ':' : '') + plan.node,
          request,
          signal: exec.signal,
          delivery: 'parent',
        });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        /*
         * Свидетельство «запуск не состоялся»: активация не вернула childId,
         * поэтому started идёт с пустым childId, а settled — ok=false. Движок
         * видит отказ, а не отсутствие записи.
         */
        startedLaunch(runtime, {
          root: rootSelection.root,
          runId,
          task: taskArg,
          node: plan.node,
          childId: '',
          provider: plan.provider,
          model: plan.model,
        });
        settledLaunch(runtime, {
          root: rootSelection.root,
          runId,
          ok: false,
          errorCode: (error && error.code) || 'activation-error',
        });
        noteRun(runtime, {
          root: rootSelection.root,
          node: plan.node,
          state: 'error',
          since,
          finishedAt: Date.now(),
          message,
        });
        throw error;
      }
      const childId = activation && activation.childId;
      /*
       * started несёт childId, поэтому пишется сразу после активации и до
       * ожидания результата: append-only строку нельзя переписать задним
       * числом, а контроль C1 требует session id в единственной started-записи.
       */
      startedLaunch(runtime, {
        root: rootSelection.root,
        runId,
        task: taskArg,
        node: plan.node,
        childId,
        provider: plan.provider,
        model: plan.model,
      });
      noteRun(runtime, { root: rootSelection.root, node: plan.node, state: 'running', since, childId });
      watchSpawnedRun(runtime, { root: rootSelection.root, node: plan.node, runId, since, activation });
      return { ...value, childId };
    },
  };
}

/** Блок runId: тот же идентификатор, что в started/settled, уходит ребёнку. */
function promptWithRunId(text, runId) {
  return [
    { type: 'text', text },
    { type: 'text', text: 'runId: ' + runId },
  ];
}

/** started: свидетельство того, что узел запущен, а не объявлен (задание 0101). */
function startedLaunch(runtime, { root, runId, task, node, childId, provider, model }) {
  return appendLaunch(runtime, root, {
    v: 1,
    runId,
    at: localIso(),
    root,
    task: task ? String(task) : null,
    node,
    childId: childId || '',
    provider,
    model,
    depth: 1,
    state: 'started',
  });
}

/** settled: переход запуска в конечное состояние, тот же runId. */
function settledLaunch(runtime, { root, runId, ok, errorCode }) {
  return appendLaunch(runtime, root, {
    v: 1,
    runId,
    at: localIso(),
    state: 'settled',
    ok: ok === true,
    endedAt: localIso(),
    ...(errorCode ? { errorCode: String(errorCode) } : {}),
  });
}

/**
 * Record the end of a run the caller did not wait for.
 *
 * project_graph_spawn returns as soon as the child is accepted, so without this
 * the panel would show the catalog child while it lives and then nothing: the
 * card falls back to "no active agent" and the finished work leaves no trace in
 * /api/activity. The activation carries the same result promise
 * project_graph_run awaits; attach to it and write done/error when it settles.
 * A rejection is recorded, never rethrown: the caller is long gone, and an
 * unhandled rejection here would fail the process that hosted the spawn.
 *
 * @param runtime - graph runtime holding the run store.
 * @param record.root - project root the node belongs to.
 * @param record.node - node id that was started.
 * @param record.runId - launch id shared by started, settled and the child prompt.
 * @param record.since - start timestamp, kept so the panel shows the real run.
 * @param record.activation - accepted activation; a missing result is tolerated.
 */
function watchSpawnedRun(runtime, { root, node, runId, since, activation }) {
  const result = activation && activation.result;
  if (!result || typeof result.then !== 'function') return;
  result.then(
    (settled) => {
      const output = resultText(settled);
      const failed = Boolean(settled && settled.stopReason === 'error');
      /* 0101: свидетельство завершения — до записи в историю панели. */
      settledLaunch(runtime, { root, runId, ok: !failed, errorCode: failed ? 'agent-error' : '' });
      noteRun(runtime, {
        root,
        node,
        state: failed ? 'error' : 'done',
        since,
        finishedAt: Date.now(),
        childId: activation && activation.childId,
        ...(failed ? { message: output || 'агент завершился с ошибкой' } : {}),
      });
    },
    (error) => {
      settledLaunch(runtime, { root, runId, ok: false, errorCode: (error && error.code) || 'activation-error' });
      noteRun(runtime, {
        root,
        node,
        state: 'error',
        since,
        finishedAt: Date.now(),
        childId: activation && activation.childId,
        message: error && error.message ? error.message : String(error),
      });
    },
  );
}

export const RUN_TOOL_NAME = 'project_graph_run';

function resultText(result) {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  const parts = Array.isArray(result.output) ? result.output : [];
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    try { return JSON.stringify(part); } catch { return String(part); }
  }).join('\n');
}

function clampTimeout(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.max(Math.round(number), 1000), 30 * 60 * 1000);
}

/**
 * The waiting half of the tool pair: same route as project_graph_spawn, but
 * delivery 'caller' and an awaited result. It also records running/done/error
 * in the runtime store the panel reads through /api/activity.
 */
export function createRunTool(options) {
  const runtime = options.runtime;
  const config = isPlainObject(options.config) ? options.config : {};
  const getSubagents = options.getSubagents;
  const getAgentPresets = options.getAgentPresets;

  return {
    name: RUN_TOOL_NAME,
    description:
      'Run one agent declared in the structure/ folder and wait for its result. '
      + 'The node decides provider, model and preset; the caller gets status, output and duration. '
      + 'Use project_graph_spawn when the caller should not wait.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', description: 'Node id from structure/*.json.' },
        prompt: { type: 'string', description: 'The task for the child agent.' },
        root: { type: 'string', description: 'Absolute project root; optional when exactly one root is configured.' },
        task: { type: 'string', description: 'Task contract (docs/tasks/<id>) this run executes; refused when its executor/acceptor contradict the structure.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the child, 1s..30min. Default 10min.' },
      },
      required: ['node', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: { type: 'string' },
          childId: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'error', 'timeout'] },
          output: { type: 'string' },
          error: { type: 'string' },
          stopReason: { type: 'string' },
          durationMs: { type: 'number' },
          provider: { type: 'string' },
          model: { type: 'string' },
          preset: { type: 'string' },
        },
        required: ['node', 'status', 'provider', 'model'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.node + ' ' + value.status + ' in ' + value.durationMs + 'ms on '
          + value.provider + '/' + value.model
          + (value.preset ? ' with preset ' + value.preset : '')
          + (value.output ? ': ' + value.output : '')
          + (value.error ? ' (' + value.error + ')' : ''),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec && exec.agent;
      if (!parent) throw spawnError('no-parent', 'инструмент вызван без агента: вызовите его из сессии, у которой есть родитель');
      const subagents = typeof getSubagents === 'function' ? getSubagents() : null;
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw spawnError('spawn-unavailable', 'служба ctx.subagents не подключена: проверьте, что в DSH загружен плагин subagent');
      }
      const providerName = typeof config.provider === 'string' && config.provider.trim()
        ? config.provider.trim()
        : DEFAULT_PROVIDER;
      const provider = subagents.getProvider ? subagents.getProvider(providerName) : undefined;
      if (!provider) {
        throw spawnError('spawn-unavailable', 'провайдер «' + providerName + '» не зарегистрирован: проверьте, что в DSH подключён subagent-spawn-in-process');
      }
      if (!provider.capabilities || provider.capabilities.agentOptions !== true) {
        throw spawnError('spawn-unavailable',
          'провайдер «' + providerName + '» не умеет agentOptions: нужен локальный провайдер spawn, иначе модель узла не передать');
      }
      const rootSelection = resolveRoot(runtime, args && args.root);
      if (!rootSelection.ok) throw spawnError(rootSelection.code, rootSelection.message);
      const payload = readGraph(runtime, rootSelection.root);
      if (payload.errors.length > 0) {
        const first = payload.errors[0];
        throw spawnError('structure-invalid',
          'структура недействительна: ' + first.message + (first.fix ? ' Что сделать: ' + first.fix : ''));
      }
      /*
       * A task contract is checked against the structure before any work starts:
       * the graph decides who accepts whose result, so a contract that names a
       * different acceptor is a bypass and is refused here, not noticed later.
       */
      const taskArg = args && typeof args.task === 'string' ? args.task.trim() : '';
      if (taskArg) {
        const taskRoot = path.resolve(rootSelection.root);
        const taskFile = path.resolve(taskRoot, taskArg);
        if (taskFile !== taskRoot && !taskFile.startsWith(taskRoot + path.sep)) {
          throw spawnError('task-outside-root', 'задание должно лежать внутри корня проекта: ' + taskArg);
        }
        const problems = validateTaskFile(payload.graph, taskFile);
        if (problems.length > 0) {
          throw spawnError('task-contradicts-structure',
            'контракт задания противоречит структуре: ' + problems.join('; ')
            + '. Исправьте acceptor в задании или связь в structure/*.json — обходить структуру нельзя.');
        }
      }
      /*
       * Каталог проверяется в плане, до старта: неизвестный провайдер или модель
       * отказывают с именами, а не всплывают падением уже запущенного агента.
       * Недоступная служба llm каталога не даёт — план работает как раньше.
       */
      const plan = resolveNodePlan(payload.graph, args && args.node, { catalog: await readSpawnCatalog(runtime) });
      if (!plan.ok) throw spawnError(plan.code, plan.message);

      if (plan.preset) {
        if (!provider.capabilities || provider.capabilities.agentPreset !== true) {
          throw spawnError('spawn-unavailable',
            'провайдер «' + providerName + '» не умеет agentPreset: пресет узла не передать');
        }
        const presets = typeof getAgentPresets === 'function' ? getAgentPresets() : null;
        if (!presets || typeof presets.resolve !== 'function') {
          throw spawnError('preset-unavailable',
            'узел «' + plan.node + '» требует пресет «' + plan.preset + '», но служба agentPresets не подключена');
        }
        try {
          const resolved = await presets.resolve(plan.preset);
          if (resolved && resolved.broken) {
            throw spawnError('preset-broken',
              'пресет «' + plan.preset + '» у узла «' + plan.node + '» не активируется: '
                + (typeof resolved.broken === 'string' ? resolved.broken : JSON.stringify(resolved.broken)));
          }
        } catch (error) {
          if (error && (error.code === 'preset-broken' || error.code === 'preset-unavailable' || error.code === 'unknown-preset')) throw error;
          throw spawnError('unknown-preset',
            'пресета «' + plan.preset + '» нет в DSH. Исправьте agentPreset в structure/*.json или объявите пресет.');
        }
      }

      let maxDepth;
      if (typeof subagents.resolveMaxDepth === 'function') {
        maxDepth = subagents.resolveMaxDepth(config.maxDepth === undefined ? DEFAULT_MAX_DEPTH : config.maxDepth);
      }
      const runId = newRunId();
      const request = {
        /*
         * The child works in the workspace that declares the node, not in the
         * caller's directory: otherwise a structure of project B started from a
         * session of project A would read and write A's files while claiming to
         * run B's node.
         */
        cwd: rootSelection.root,
        prompt: promptWithRunId(String(args.prompt), runId),
        parent,
        agentOptions: { provider: plan.provider, model: plan.model },
        ...(plan.preset ? { agentPreset: plan.preset } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      };
      const since = Date.now();
      /* A branch tags every step, so the panel can group them later. */
      const branchId = exec && typeof exec.branchId === 'string' ? exec.branchId : undefined;
      const note = (fields) => noteRun(runtime, branchId ? { ...fields, branchId } : fields);
      note({ root: rootSelection.root, node: plan.node, state: 'running', since, childId: undefined });
      let activation;
      try {
        activation = await subagents.startActivation({
          provider: providerName,
          label: (plan.role ? plan.role + ': ' : '') + plan.node,
          request,
          signal: exec.signal,
          delivery: 'caller',
        });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        /* Активация не вернула childId: started пустой, settled — отказ (0101). */
        startedLaunch(runtime, {
          root: rootSelection.root,
          runId,
          task: taskArg,
          node: plan.node,
          childId: '',
          provider: plan.provider,
          model: plan.model,
        });
        settledLaunch(runtime, {
          root: rootSelection.root,
          runId,
          ok: false,
          errorCode: (error && error.code) || 'activation-error',
        });
        note({ root: rootSelection.root, node: plan.node, state: 'error', since, finishedAt: Date.now(), message });
        throw error;
      }
      /*
       * started с childId — сразу после активации, до ожидания результата:
       * append-only строку нельзя переписать, а контроль C1 требует session id.
       */
      startedLaunch(runtime, {
        root: rootSelection.root,
        runId,
        task: taskArg,
        node: plan.node,
        childId: activation && activation.childId,
        provider: plan.provider,
        model: plan.model,
      });
      note({ root: rootSelection.root, node: plan.node, state: 'running', since, childId: activation && activation.childId });
      const timeoutMs = clampTimeout(args && args.timeoutMs, clampTimeout(config.runTimeoutMs, 10 * 60 * 1000));
      const marker = { timeout: true };
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(marker), timeoutMs); });
      try {
        const settled = await Promise.race([
          activation && activation.result ? activation.result : Promise.resolve({ output: [], stopReason: 'error' }),
          timeout,
        ]);
        if (settled === marker) {
          try { await activation.dispose(); } catch { /* cancellation is best effort */ }
          settledLaunch(runtime, { root: rootSelection.root, runId, ok: false, errorCode: 'timeout' });
          note({ root: rootSelection.root, node: plan.node, state: 'error', since, finishedAt: Date.now(), childId: activation && activation.childId, message: 'истекло ожидание ' + timeoutMs + ' мс' });
          return {
            node: plan.node,
            childId: activation && activation.childId,
            status: 'timeout',
            error: 'истекло ожидание ' + timeoutMs + ' мс',
            durationMs: Date.now() - since,
            provider: plan.provider,
            model: plan.model,
            ...(plan.preset ? { preset: plan.preset } : {}),
          };
        }
        const output = resultText(settled);
        const failed = Boolean(settled && settled.stopReason === 'error');
        settledLaunch(runtime, { root: rootSelection.root, runId, ok: !failed, errorCode: failed ? 'agent-error' : '' });
        note({
          root: rootSelection.root,
          node: plan.node,
          state: failed ? 'error' : 'done',
          since,
          finishedAt: Date.now(),
          childId: activation && activation.childId,
          ...(failed ? { message: output || 'агент завершился с ошибкой' } : {}),
        });
        return {
          node: plan.node,
          childId: activation && activation.childId,
          status: failed ? 'error' : 'ok',
          ...(output ? { output } : {}),
          ...(failed ? { error: output || 'агент завершился с ошибкой' } : {}),
          ...(settled && settled.stopReason ? { stopReason: String(settled.stopReason) } : {}),
          durationMs: Date.now() - since,
          provider: plan.provider,
          model: plan.model,
          ...(plan.preset ? { preset: plan.preset } : {}),
        };
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        settledLaunch(runtime, { root: rootSelection.root, runId, ok: false, errorCode: (error && error.code) || 'run-error' });
        note({ root: rootSelection.root, node: plan.node, state: 'error', since, finishedAt: Date.now(), childId: activation && activation.childId, message });
        return {
          node: plan.node,
          childId: activation && activation.childId,
          status: 'error',
          error: message,
          durationMs: Date.now() - since,
          provider: plan.provider,
          model: plan.model,
          ...(plan.preset ? { preset: plan.preset } : {}),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function registerRunTool(ctx, runtime, config) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error(RUN_TOOL_NAME + ': tools service is not available');
  }
  return ctx.tools.register(createRunTool({
    runtime,
    config,
    getSubagents: () => ctx.subagents,
    getAgentPresets: () => {
      try { return ctx.get ? ctx.get('agentPresets') : null; } catch { return null; }
    },
  }));
}

/** Register the tool on a context that already carries `tools` and `subagents`. */
export function registerSpawnTool(ctx, runtime, config) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error(SPAWN_TOOL_NAME + ': tools service is not available');
  }
  const definition = createSpawnTool({
    runtime,
    config,
    getSubagents: () => ctx.subagents,
    getAgentPresets: () => {
      try {
        return ctx.get ? ctx.get('agentPresets') : null;
      } catch {
        return null;
      }
    },
  });
  return ctx.tools.register(definition);
}