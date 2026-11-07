/**
 * dsh-project-graph host half.
 *
 * Two surfaces and one exception. The `/project-graph` prefix route reads the
 * structure and edits edges: it shows the structure a project declares in
 * `structure/`. The `project_graph_spawn`/`project_graph_run` tools start one
 * agent for one node, on the model the declaration assigns. The exception is the
 * scheduler: a node that declares `schedule` is started by the host at its
 * declared time, through the same subagent service and the same run store. No
 * route is ever invented: the node declaration decides provider and model.
 */
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime, registerGraphWeb } from './api.js';
import { registerSpawnTool, registerRunTool } from './spawn.js';
import { registerBranchTool } from './branch.js';
import { createScheduler } from './scheduler.js';
import { createExchangeWatcher, readSessionCwd, writeTelemetry } from './exchange-watch.js';
import { deliverExchangeDigest, sendDigestToSession } from './digest.js';
import { pickParent } from './parent.js';
import { recordPolicyHealth, registerStructurePolicy } from './structure-policy.js';
import { registerObligationGate } from './obligations-gate.js';

export const name = 'dsh-project-graph';

/** Resolve `ctx.workspaceRegistry` without requiring it to be injected. */
function resolveWorkspaceRegistry(ctx) {
  const candidates = [
    () => ctx.workspaceRegistry,
    () => (ctx.get ? ctx.get('workspaceRegistry') : undefined),
    () => (ctx.reflect && ctx.reflect.get ? ctx.reflect.get('workspaceRegistry', false) : undefined),
  ];
  for (const read of candidates) {
    try {
      const registry = read();
      if (registry && typeof registry.list === 'function') return registry;
    } catch {
      /* try the next resolution path */
    }
  }
  return null;
}

function resolveService(ctx, name) {
  try {
    return ctx.get ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the session journals live.
 *
 * A live agent does not always carry its folder: the cwd lives in the session and
 * in its journal under this folder (0083). The runtime or the profile may point at
 * it explicitly; otherwise DSH's own default is used. Read on every pick, because
 * a host build or a test may set runtime.sessionsDir after the plugin loaded.
 */
function sessionsDirOf(config, runtime) {
  const fromRuntime = runtime && typeof runtime.sessionsDir === 'string' ? runtime.sessionsDir.trim() : '';
  if (fromRuntime) return fromRuntime;
  const fromConfig = config && typeof config.sessionsDir === 'string' ? config.sessionsDir.trim() : '';
  if (fromConfig) return fromConfig;
  return path.join(os.homedir(), '.dsh', 'sessions');
}

/** Live agents service: the scheduler needs a parent for a host-started run. */
function resolveAgents(ctx) {
  try {
    if (ctx && ctx.agents) return ctx.agents;
  } catch {
    /* a scoped context may refuse the read; fall through */
  }
  return resolveService(ctx, 'agents') || null;
}

export function apply(ctx, config = {}) {
  const runtime = createGraphRuntime(config, {
    getWorkspaceRegistry: () => resolveWorkspaceRegistry(ctx),
    getLlm: () => resolveService(ctx, 'llm'),
    getSubagents: () => resolveService(ctx, 'subagents'),
    getPresets: () => resolveService(ctx, 'agentPresets'),
    /* Live agents of the host: the panel maps them onto its nodes, not only its own children. */
    getAgents: () => resolveAgents(ctx),
    providerName: typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : 'spawn',
  });
  /*
   * 0139: провайдеры рантайма — запасное доказательство для плана, когда каталог
   * llm недоступен. Тогда узел с provider, которого нет у хоста, отказывает до
   * запуска (provider-missing со списком и подсказкой), а не рождается и падает
   * NO_ADAPTER в сессии. Служба отвечает списком или промисом; нет службы/ошибка —
   * undefined, и план работает как раньше (доказательства нет).
   */
  const knownProvidersOf = async () => {
    let llm;
    try {
      llm = typeof runtime.getLlm === 'function' ? runtime.getLlm() : null;
    } catch {
      return undefined;
    }
    if (!llm || typeof llm.listProviders !== 'function') return undefined;
    let providers;
    try {
      providers = await llm.listProviders();
    } catch {
      return undefined;
    }
    if (!Array.isArray(providers)) return undefined;
    const ids = [];
    for (const row of providers) {
      if (!row) continue;
      const id = typeof row === 'string'
        ? row.trim()
        : (typeof row.id === 'string' && row.id.trim() ? row.id.trim()
          : (typeof row.name === 'string' ? row.name.trim() : ''));
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids.length > 0 ? ids : undefined;
  };
  /*
   * 0138: проба фактического cwd ребёнка — кэш сессий хоста, где DSH держит
   * рабочий каталог сессии. Живой случай ws-school-app --05: spawn вернул
   * childId, а сессия легла в воркспейс родителя; проба говорит, где она на
   * самом деле, и запуск не выглядит успешным.
   *
   * Это НЕ sessionsDir журналов (~/.dsh/sessions): журналы — не кэш, и подстановка
   * их сюда сделала бы пробу всегда пустой, то есть отключила бы проверку ровно
   * там, где она нужна. Каталог кэша берётся из runtime/config, если хост его
   * назвал; иначе действует умолчание readSessionCwd
   * (~/.dsh/storages/session_projcache/sessions).
   */
  const sessionCacheDirOf = () => {
    const fromRuntime = runtime && typeof runtime.sessionCacheDir === 'string' ? runtime.sessionCacheDir.trim() : '';
    if (fromRuntime) return fromRuntime;
    const fromConfig = config && typeof config.sessionCacheDir === 'string' ? config.sessionCacheDir.trim() : '';
    return fromConfig;
  };
  const probeCwdOf = () => {
    const dir = sessionCacheDirOf();
    return (sessionId) => readSessionCwd(sessionId, dir ? { sessionCacheDir: dir } : {});
  };
  /*
   * Declared before the scheduler: its tick may run synchronously on start and calls
   * this on every beat, so the binding must already exist (a TDZ error would swallow
   * the first exchange pass silently).
   */
  let exchangeTick = null;
  /*
   * The feasibility check needs the LLM route table, the subagent provider and
   * the preset registry. They are optional services: inject lazily and keep the
   * runtime getters pointed at the scoped instances when they arrive.
   */
  try {
    /*
     * Capture the service instance, not the injection scope: a scope can become
     * inactive (hot reload, effect cleanup), and reading scope.llm afterwards
     * throws "cannot get required service ... in inactive context".
     */
    ctx.inject(['llm'], (scope) => { const service = scope.llm; runtime.getLlm = () => service; });
    ctx.inject(['agentPresets'], (scope) => { const service = scope.agentPresets; runtime.getPresets = () => service; });
    ctx.inject(['subagents'], (scope) => { const service = scope.subagents; runtime.getSubagents = () => service; });
    /*
     * Installing the workflow plugin is the host's job: the panel only hands the
     * configured spec to pluginManager. The service is optional, so a host
     * without it keeps refusing with a recipe instead of failing to load.
     */
    ctx.inject(['pluginManager'], (scope) => { const service = scope.pluginManager; runtime.getPluginManager = () => service; });
  } catch {
    /* the panel still reads the structure without those services */
  }
  /*
   * The scheduler is the one place where the panel acts instead of reading: a
   * node with `schedule` is started by the host at its declared time. The run
   * goes through ctx.subagents exactly like project_graph_run, with the first
   * live root agent as parent; without one the tick writes an error run and
   * waits for the next window (a missed window is never caught up).
   */
  /*
   * The parent of a host-started run: a live agent of the node's OWN workspace, never
   * a stranger. A session of another workspace carries that workspace's folder, so a
   * borrowed parent makes the child read the wrong folder and the activation die with
   * "the agent finished without a report". No own agent = no run, with the reason.
   * Both the scheduler and the exchange wake use it.
   *
   * The cwd is not always on the agent (0083): pickParent receives the sessions
   * folder, so an agent whose folder lives only in its session or journal is still
   * proven to be "own". Without that the nightly critic stopped at "no live agent"
   * while its session was alive. An agent without a session is not an error.
   */
  const chooseParent = (root) => {
    const sessionsDir = sessionsDirOf(config, runtime);
    const agents = resolveAgents(ctx);
    if (!agents) return pickParent({ agents: [], root, sessionsDir });
    try {
      const roots = typeof agents.roots === 'function' ? agents.roots() : [];
      const list = Array.isArray(roots) && roots.length > 0
        ? roots
        : (typeof agents.list === 'function' ? agents.list() : []);
      return pickParent({ agents: Array.isArray(list) ? list : [], root, sessionsDir });
    } catch {
      return pickParent({ agents: [], root, sessionsDir });
    }
  };
  /* Agent handle or null: the exchange watcher expects the handle itself. */
  const resolveParent = (root) => chooseParent(root).parent;
  /** Журнал плагина: сообщение хост-логу, и никогда — исключение. */
  const warn = (message) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[dsh-project-graph] ' + message);
      else console.warn('[dsh-project-graph] ' + message);
    } catch {
      /* журнал не имеет права ломать хост */
    }
  };
  /*
   * Headless session (0084). A schedule must run even when nobody holds the workspace
   * open (03:00, the human session closed). ctx.agents.create raises a session in that
   * folder; the scheduler uses it as the run's parent and closes it afterwards. The
   * hook is offered only when the host has it: without create the scheduler keeps its
   * honest "no live agent" message instead of inventing a run.
   */
  const headlessAvailable = (() => {
    try {
      const agents = resolveAgents(ctx);
      return Boolean(agents && typeof agents.create === 'function');
    } catch {
      return false;
    }
  })();
  const createHeadlessAgent = async (options) => {
    const agents = resolveAgents(ctx);
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('служба ctx.agents не умеет create');
    }
    const cwd = options && typeof options.cwd === 'string' && options.cwd ? options.cwd : undefined;
    return agents.create(cwd ? { cwd } : {});
  };
  /*
   * Дайджест входящих (0104). Тик планировщика — единственный таймер, который
   * доказанно работает в хосте, поэтому строка «требуют хода N» едет его битом.
   * Доставка — в СУЩЕСТВУЮЩУЮ сессию корня: контроллер сессий (mode 'queue'),
   * запасной путь — handle.sendMessage живой сессии. Спавна нет: дайджест не
   * повод поднимать двойника, а «некому» — не ошибка, новость останется до
   * следующего бита.
   *
   * Ошибка доставки — строка в журнале, а не остановка цикла и не повтор с
   * частотой тика: одна и та же причина пишется не чаще раза в 5 минут.
   */
  let digestBusy = false;
  const digestWarnAt = new Map();
  const digestTick = async () => {
    if (digestBusy) return;
    digestBusy = true;
    try {
      const roots = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
      for (const root of roots) {
        try {
          const result = await deliverExchangeDigest({
            runtime,
            root,
            send: (text) => sendDigestToSession({
              root,
              text,
              sessionsDir: sessionsDirOf(config, runtime),
              getSessionController: () => resolveService(ctx, 'sessionController') || null,
              getAgents: () => resolveAgents(ctx),
            }),
          });
          if (result && result.error) digestWarn(root, String(result.error));
          /* Отказ доставки — журнал; «некому» (no-session) — штатная тишина. */
          else if (result && result.reason === 'refused') {
            digestWarn(root, 'доставка не удалась: '
              + (Array.isArray(result.reasons) && result.reasons.length > 0
                ? result.reasons.join('; ')
                : 'причина не сообщена'));
          }
        } catch (error) {
          digestWarn(root, error && error.message ? error.message : String(error));
        }
      }
    } finally {
      digestBusy = false;
    }
  };
  /*
   * Повестка бита: проход обмена, затем дайджест по каждому корню. Один упавший
   * проход не отменяет другой — иначе вечер с тяжёлым ящиком молчал бы о заявках.
   */
  const beat = async () => {
    if (typeof exchangeTick === 'function') {
      try {
        await exchangeTick();
      } catch (error) {
        warn('обмен: проход в тике не удался: ' + (error && error.message ? error.message : String(error)));
      }
    }
    await digestTick();
  };
  try {
    const scheduler = createScheduler({
      runtime,
      config,
      getSubagents: () => (typeof runtime.getSubagents === 'function' ? runtime.getSubagents() : null),
      getPresets: () => (typeof runtime.getPresets === 'function' ? runtime.getPresets() : null),
      /* Live agents let the scheduler wake the addressee of a report. */
      getAgents: () => resolveAgents(ctx),
      /*
       * A scheduled node must be born in a session of its own workspace: the session
       * carries the folder the agent reads. An agent of another root is never borrowed;
       * the scheduler writes the reason (it names the workspace) into the run journal.
       */
      getParent: resolveParent,
      getParentReason: (root) => chooseParent(root).reason,
      ...(headlessAvailable ? { createAgent: createHeadlessAgent } : {}),
      /*
       * The exchange pass rides the scheduler's beat: this timer is proven to run in the
       * host, while a separate interval for the watcher may not survive activation.
       */
      onTick: () => beat(),
      logger: {
        warn(message) {
          try {
            if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message);
            else console.warn(message);
          } catch {
            /* a logger must not break the host */
          }
        },
      },
    });
    const disposeSchedule = config.schedule === false ? () => {} : scheduler.start();
    if (typeof ctx.effect === 'function') ctx.effect(() => disposeSchedule);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('scheduler was not started: ' + message);
      else console.warn('[dsh-project-graph] scheduler was not started: ' + message);
    } catch {
      /* keep loading the panel even if the scheduler cannot start */
    }
  }
  /*
   * The exchange box is listened to, not only read: a message written into
   * `coordination/threads` must wake the addressee's last active session, otherwise
   * an answer stays a file nobody opens. Off with `exchangeWatch: false`.
   */
  writeTelemetry({ event: 'apply', exchangeWatch: config.exchangeWatch, roots: runtime.allowedRoots().length });
  try {
    const watcher = createExchangeWatcher({
      runtime,
      config,
      getAgents: () => resolveAgents(ctx),
      getSubagents: () => (typeof runtime.getSubagents === 'function' ? runtime.getSubagents() : null),
      /*
       * DSH's first-party session bridge: resolve a session (resuming it when cold) and
       * admit a prompt into it. Same API the GUI uses; no third-party plugin.
       */
      getSessionController: () => resolveService(ctx, 'sessionController') || null,
      getParent: resolveParent,
      logger: {
        warn(message) {
          try {
            if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message);
            else console.warn(message);
          } catch {
            /* a logger must not break the host */
          }
        },
      },
    });
    /*
     * What the profile brake means now.
     *
     * `exchangeWatch: false` was written into ~/.dsh/profiles/desktop/cordis.patch.yml as
     * an emergency stop while the wake loop was broken (every delivered letter started an
     * answer, the answer started the next wake). That loop is closed in code: delivered
     * memory survives restarts, acks never wake, one reader per workspace, a 90 s cooldown,
     * and a wake resumes the addressee's own session instead of creating a twin. So the
     * old flag now means only "no fast 4 s timer"; delivery rides the scheduler's beat,
     * which is the mechanism proven to run in this host.
     *
     * A hard stop is explicit and cannot be confused with the stale flag:
     * set PG_EXCHANGE_WATCH=0 in the environment.
     */
    const hardStop = typeof process !== 'undefined' && process.env
      && String(process.env.PG_EXCHANGE_WATCH || '').trim() === '0';
    const watchEnabled = !hardStop;
    exchangeTick = watchEnabled ? () => watcher.tick() : null;
    writeTelemetry({
      event: 'constructed',
      ownTimer: watchEnabled && config.exchangeWatch !== false,
      beat: watchEnabled,
      profileBrake: config.exchangeWatch === false,
    });
    const disposeWatch = watchEnabled && config.exchangeWatch !== false ? watcher.start() : () => {};
    writeTelemetry({ event: 'started', disposer: typeof disposeWatch, beat: watchEnabled });
    if (typeof ctx.effect === 'function') ctx.effect(() => disposeWatch);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    writeTelemetry({ event: 'apply-error', message, stack: String(error && error.stack || '').split('\n').slice(0, 4) });
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('exchange watcher was not started: ' + message);
      else console.warn('[dsh-project-graph] exchange watcher was not started: ' + message);
    } catch {
      /* the panel still works without the watcher */
    }
  }
  ctx.inject(['webServer'], (webCtx) => registerGraphWeb(webCtx, runtime));
  /*
   * Политика альтернативного пути: нативный `subagent`/`subagent_fork` в проекте
   * с объявленной структурой не блокируется, но модель получает предупреждение с
   * перечнем узлов и рецептом `project_graph_spawn`, а событие уходит в журнал
   * хранилища. Хост без `tools/post-execute` подписку не получает и работает как
   * раньше; любой сбой политики логируется и не мешает загрузке плагина.
   */
  try {
    registerStructurePolicy(ctx, runtime);
    /*
     * 0101: health.json в сторе — доказательство того, что структура включена:
     * режим enforcement.structurePolicy и состоявшаяся подписка на
     * tools/pre-execute (без неё fail не удерживается). Пишется при apply;
     * смена режима дописывается из pre-execute. Ошибка записи не роняет плагин.
     */
    const healthRoots = typeof runtime.allowedRoots === 'function' ? runtime.allowedRoots() : [];
    for (const root of healthRoots) {
      recordPolicyHealth({ root, runtime, force: true });
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('structure policy was not registered: ' + message);
      else console.warn('[dsh-project-graph] structure policy was not registered: ' + message);
    } catch {
      /* панель работает и без политики */
    }
  }
  /*
   * Гейт обязанностей (0076): перед запуском узла и перед git commit/push через
   * pwsh считаются нарушенные обязанности структуры. По выбору заказчика режим
   * warn: вызов проходит, а модель получает контекст с обязанностью и числом
   * непрочитанных; deny — только для обязанности с enforce = fail. События
   * пишутся в хранилище (gate.jsonl), в репозиторий ничего не попадает. Хост без
   * tools/pre-execute подписку не получает и работает как раньше.
   */
  try {
    registerObligationGate(ctx, runtime);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('obligations gate was not registered: ' + message);
      else console.warn('[dsh-project-graph] obligations gate was not registered: ' + message);
    } catch {
      /* панель работает и без гейта */
    }
  }
  ctx.inject(['tools', 'subagents'], (toolCtx) => {
    const subagents = toolCtx.subagents;
    runtime.getSubagents = () => subagents;
    try {
      registerSpawnTool(toolCtx, runtime, config, {
        getKnownProviders: knownProvidersOf,
        /* 0138: проба фактического cwd ребёнка — кэш сессий хоста. */
        probeCwd: probeCwdOf(),
      });
      registerRunTool(toolCtx, runtime, config);
      registerBranchTool(toolCtx, runtime, config);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (toolCtx.logger && typeof toolCtx.logger.warn === 'function') {
        toolCtx.logger.warn('project_graph_spawn was not registered: ' + message);
      } else {
        console.warn('[dsh-project-graph] project_graph_spawn was not registered: ' + message);
      }
    }
  });
}