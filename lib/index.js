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
import { createGraphRuntime, registerGraphWeb } from './api.js';
import { registerSpawnTool, registerRunTool } from './spawn.js';
import { registerBranchTool } from './branch.js';
import { createScheduler } from './scheduler.js';
import { createExchangeWatcher, writeTelemetry } from './exchange-watch.js';
import { isInsideRoot } from './live.js';

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
   * The parent of a host-started run: a live agent of the node's own workspace first,
   * any live root agent second. Both the scheduler and the exchange wake use it.
   */
  const resolveParent = (root) => {
    const agents = resolveAgents(ctx);
    if (!agents) return null;
    try {
      const roots = typeof agents.roots === 'function' ? agents.roots() : [];
      const list = Array.isArray(roots) && roots.length > 0
        ? roots
        : (typeof agents.list === 'function' ? agents.list() : []);
      const all = Array.isArray(list) ? list : [];
      const inside = all.filter((agent) => agent && isInsideRoot(agent.cwd, root));
      return inside[0] || all[0] || null;
    } catch {
      return null;
    }
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
       * carries the folder the agent reads. Prefer a live agent inside that root, and
       * only then fall back to any live root agent.
       */
      getParent: resolveParent,
      /*
       * The exchange pass rides the scheduler's beat: this timer is proven to run in the
       * host, while a separate interval for the watcher may not survive activation.
       */
      onTick: () => (typeof exchangeTick === 'function' ? exchangeTick() : undefined),
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
  ctx.inject(['tools', 'subagents'], (toolCtx) => {
    const subagents = toolCtx.subagents;
    runtime.getSubagents = () => subagents;
    try {
      registerSpawnTool(toolCtx, runtime, config);
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