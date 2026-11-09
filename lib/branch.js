/**
 * A branch of the structure: one node, then its delegate neighbours, level by level.
 *
 * The panel runs one node today. A branch is the next step the customer asked
 * for: start at a node, follow `delegate` edges down to a depth, run the nodes
 * of one level side by side up to a cap, and hand each level's results to the
 * next. `review` edges are deliberately not followed: acceptance is always a
 * separate step, never a side effect of the delegation pass.
 *
 * The tool reuses the single-node runner, so a branch step is validated and
 * recorded exactly like a lone `project_graph_run`: same refusals, same
 * running → done/error records, plus a branchId that ties them together.
 */
import { readGraph } from './api.js';
import { createRunTool, resolveNodePlan, resolveRoot, spawnError } from './spawn.js';

export const BRANCH_TOOL_NAME = 'project_graph_branch';
export const DEFAULT_PARALLELISM = 2;
export const DEFAULT_DEPTH = 2;
export const MAX_DEPTH = 5;
export const MAX_PARALLELISM = 16;

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

/**
 * Work out the levels of a branch without touching DSH.
 *
 * @param graph - merged structure (`nodes`, `models`, `edges`).
 * @param startId - node the branch starts at.
 * @param options.depth - how many levels to build, 1 means the start node only.
 * @returns `{ ok, start, levels, incoming, depth }` or `{ ok: false, code, message }`.
 */
export function planBranch(graph, startId, options = {}) {
  const depth = clampInt(options.depth, DEFAULT_DEPTH, 1, MAX_DEPTH);
  const start = resolveNodePlan(graph, startId);
  if (!start.ok) return { ok: false, code: start.code, message: start.message };
  const edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
  const levels = [[start.node]];
  const incoming = {};
  const seen = new Set([start.node]);
  let frontier = [start.node];
  for (let level = 2; level <= depth; level += 1) {
    const next = [];
    for (const parent of frontier) {
      for (const edge of edges) {
        if (!edge || edge.kind !== 'delegate' || edge.from !== parent) continue;
        const child = typeof edge.to === 'string' ? edge.to : '';
        if (!child || seen.has(child)) continue;
        const route = resolveNodePlan(graph, child);
        if (!route.ok) {
          return {
            ok: false,
            code: 'branch-node-unroutable',
            message: 'узел «' + child + '» (уровень ' + level + ', от «' + parent + '») не запускается: '
              + route.message,
          };
        }
        if (!incoming[child]) {
          incoming[child] = [];
          next.push(child);
          seen.add(child);
        }
        if (!incoming[child].includes(parent)) incoming[child].push(parent);
      }
    }
    if (next.length === 0) break;
    levels.push(next);
    frontier = next;
  }
  return { ok: true, start: start.node, levels, incoming, depth: levels.length };
}

/**
 * The task a child receives. The node's own declaration is always prepended:
 * the same structure file that decided the route also explains the role.
 */
export function buildNodePrompt(node, input, parents) {
  const head = 'Ты — узел «' + node.id + '» структуры проекта.'
    + (node.role ? ' Роль: ' + node.role + '.' : '')
    + (node.brief ? ' Назначение: ' + node.brief + '.' : '');
  const from = Array.isArray(parents) && parents.length > 0
    ? 'Задача пришла от ' + parents.map((id) => '«' + id + '»').join(', ') + ':'
    : 'Задача:';
  return head + '\n\n' + from + '\n' + String(input || '').trim();
}

/** The text one finished step contributes to the next level. */
function stepResult(step) {
  const head = '[' + step.node + (step.role ? ' (' + step.role + ')' : '') + ']';
  return head + '\n' + String(step.output || step.error || 'результат пуст').trim();
}

export function createBranchTool(options) {
  const runtime = options.runtime;
  const config = options.config && typeof options.config === 'object' ? options.config : {};
  const getSubagents = options.getSubagents;
  const getAgentPresets = options.getAgentPresets;
  const runner = createRunTool({ runtime, config, getSubagents, getAgentPresets });
  const defaultParallelism = clampInt(config.branchParallelism, DEFAULT_PARALLELISM, 1, MAX_PARALLELISM);
  const defaultDepth = clampInt(config.branchDepth, DEFAULT_DEPTH, 1, MAX_DEPTH);

  return {
    name: BRANCH_TOOL_NAME,
    description:
      'Run a branch of the structure: the start node, then its delegate neighbours level by level, '
      + 'each level side by side up to a parallelism cap. Review edges are not followed — acceptance is a separate step. '
      + 'The node decides provider, model and preset; the caller gets the steps and the failure, if any.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', description: 'Start node id from structure/*.json.' },
        prompt: { type: 'string', description: 'The task for the first node; later levels receive the results above.' },
        root: { type: 'string', description: 'Absolute project root; optional when exactly one root is configured.' },
        depth: { type: 'number', description: 'Levels to build, 1..5. 1 means the start node only. Default 2.' },
        parallelism: { type: 'number', description: 'Nodes of one level running at once, 1..16. Default 2.' },
        timeoutMs: { type: 'number', description: 'Per-node wait, 1s..30min. Default 10min.' },
      },
      required: ['node', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          branchId: { type: 'string' },
          node: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'error', 'timeout'] },
          depth: { type: 'number' },
          parallelism: { type: 'number' },
          durationMs: { type: 'number' },
          error: { type: 'string' },
          failedNode: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                node: { type: 'string' },
                level: { type: 'number' },
                status: { type: 'string', enum: ['ok', 'error', 'timeout'] },
                provider: { type: 'string' },
                model: { type: 'string' },
                childId: { type: 'string' },
                durationMs: { type: 'number' },
                output: { type: 'string' },
                error: { type: 'string' },
              },
              required: ['node', 'level', 'status'],
            },
          },
        },
        required: ['branchId', 'node', 'status', 'steps'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'ветка ' + value.node + ' [' + value.branchId + ']: ' + value.status
          + ' — шагов: ' + value.steps.length
          + (value.error ? '; ошибка: ' + value.error : ''),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const rootSelection = resolveRoot(runtime, args && args.root);
      if (!rootSelection.ok) throw spawnError(rootSelection.code, rootSelection.message);
      const payload = readGraph(runtime, rootSelection.root);
      if (payload.errors.length > 0) {
        const first = payload.errors[0];
        throw spawnError('structure-invalid',
          'структура недействительна: ' + first.message + (first.fix ? ' Что сделать: ' + first.fix : ''));
      }
      const plan = planBranch(payload.graph, args && args.node, { depth: args && args.depth });
      if (!plan.ok) throw spawnError(plan.code, plan.message);

      const parallelism = clampInt(args && args.parallelism, defaultParallelism, 1, MAX_PARALLELISM);
      const branchId = 'br-' + Date.now().toString(36) + '-' + String(Math.random()).slice(2, 6);
      const started = Date.now();
      const steps = [];
      let input = String((args && args.prompt) || '');
      let failure = null;

      for (let index = 0; index < plan.levels.length; index += 1) {
        const level = index + 1;
        const levelNodes = plan.levels[index];
        const finished = [];
        let cursor = 0;
        let stop = false;
        const workers = Array.from({ length: Math.min(parallelism, levelNodes.length) }, async () => {
          while (!stop) {
            const at = cursor;
            cursor += 1;
            if (at >= levelNodes.length) return;
            const id = levelNodes[at];
            const node = payload.graph.nodes.find((item) => item && item.id === id) || { id };
            const prompt = buildNodePrompt(node, input, index === 0 ? [] : plan.incoming[id]);
            const value = await runner.execute(
              { node: id, prompt, root: rootSelection.root, timeoutMs: args && args.timeoutMs },
              { ...(exec || {}), branchId },
            );
            const step = {
              node: id,
              level,
              status: value.status,
              provider: value.provider,
              model: value.model,
              ...(value.childId ? { childId: value.childId } : {}),
              ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
              ...(value.output ? { output: value.output } : {}),
              ...(value.error ? { error: value.error } : {}),
            };
            finished.push(step);
            if (value.status !== 'ok') {
              stop = true;
              failure = step;
            }
          }
        });
        await Promise.all(workers);
        finished.sort((left, right) => levelNodes.indexOf(left.node) - levelNodes.indexOf(right.node));
        steps.push(...finished);
        if (failure) break;
        input = steps.map((step) => stepResult(step)).join('\n\n');
      }

      const status = failure ? (failure.status === 'timeout' ? 'timeout' : 'error') : 'ok';
      return {
        branchId,
        node: plan.start,
        status,
        depth: plan.levels.length,
        parallelism,
        durationMs: Date.now() - started,
        steps,
        ...(failure ? { failedNode: failure.node, error: failure.error || 'узел завершился с ошибкой' } : {}),
      };
    },
  };
}

/** Register the tool on a context that already carries `tools` and `subagents`. */
export function registerBranchTool(ctx, runtime, config) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error(BRANCH_TOOL_NAME + ': tools service is not available');
  }
  return ctx.tools.register(createBranchTool({
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
  }));
}
