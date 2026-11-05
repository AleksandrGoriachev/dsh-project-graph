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
import { isoWithOffset, readExchange, writeExchangeMessage } from './exchange.js';
import { listRuns, noteRun } from './runs.js';
import { nextRunAt, SCHEDULE_GRACE_MS, SCHEDULE_TICK_MS } from './schedule.js';
import { resolveNodePlan } from './spawn.js';
import { ensureCriticSpec, isCriticNode } from './critic-spec.js';
import { isInsideRoot, labelNamesNode } from './live.js';
import { activityOf, pickLastActive } from './exchange-watch.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * Cut everything above the first report line.
 *
 * Models tend to think out loud before answering ("should I deliver via a file?").
 * That thinking is not a report, and rejecting the whole answer because of it made
 * good analysis look like a failure. The body starts at the first header or section
 * line; an answer with no such line has no report at all.
 */
export function extractReportBody(text) {
  const lines = String(text || '').split(/\r?\n/u);
  const sectionWord = /(итог|риск|что делать|делать дальше|чего не хватило|не хватило|ошибк|простой|связ|обмен)/iu;
  const reasoning = /^(Wait|Hmm|Let me|Let's|Okay|Alright|Actually|I'll|Now)\b/u;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^From:\s/iu.test(line) || /^#{1,6}\s/u.test(line)) return lines.slice(index).join('\n').trim();
    if (/^(\*{1,2})?[0-9]+[.)]\s/u.test(line) && !reasoning.test(line)) return lines.slice(index).join('\n').trim();
    if (line.length <= 90 && sectionWord.test(line) && !reasoning.test(line)) return lines.slice(index).join('\n').trim();
  }
  return '';
}

/** How many of the four promised sections the body actually has. */
export function countReportSections(body) {
  const text = String(body || '');
  const wanted = [/итог/iu, /риск/iu, /что делать|делать дальше/iu, /чего не хватило|не хватило/iu];
  return wanted.filter((pattern) => pattern.test(text)).length;
}

export function writeCriticReport(root, node, at, text, targets = []) {
  const timeZone = node && node.schedule && node.schedule.timeZone ? node.schedule.timeZone : 'Europe/Moscow';
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone }).format(at);
  const dir = path.join(root, 'docs', 'critic');
  fs.mkdirSync(dir, { recursive: true });
  const head = [
    'From: ' + String(node && node.id ? node.id : 'critic'),
    'To: ' + (targets.length > 0 ? targets.join(', ') : 'coordinator'),
    'Date: ' + isoWithOffset(at, timeZone),
    'Thread: critic-report',
    'Status: report',
    'Subject: ' + String(node && node.role ? node.role : 'критик') + ' за ' + day,
    '',
  ].join('\n');
  const relative = path.join('docs', 'critic', day + '.md');
  fs.writeFileSync(path.join(root, relative), head + String(text).trim() + '\n', 'utf8');
  return relative.split(path.sep).join('/');
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
  /* How long to wait for a freed child slot; tests shorten it. */
  const limitRetryMs = Number.isFinite(options.limitRetryMs) && options.limitRetryMs >= 0
    ? options.limitRetryMs
    : 8000;

  /* Node id -> { signature, due }: the armed instant for this declaration. */
  const armed = new Map();
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

  function record(root, node, since, fields) {
    noteRun(runtime, { root, node, kind: 'schedule', since, ...fields });
  }

  /**
   * Start one scheduled node through the same service and request shape as
   * project_graph_run. Returns the accepted activation, or null with the reason
   * already written to the run store.
   */
  async function launch(root, node, payload, at) {
    const since = Date.now();
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
      record(root, node.id, since, { state: 'error', finishedAt: Date.now(), message });
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
    const route = await checkRoute(runtime, plan);
    if (route && route.ok === false) return fail(route.message);
    let maxDepth;
    if (typeof subagents.resolveMaxDepth === 'function') {
      maxDepth = subagents.resolveMaxDepth(config.maxDepth);
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
      agentOptions: { provider: plan.provider, model: plan.model },
      ...(plan.preset ? { agentPreset: plan.preset } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(runSignal ? { signal: runSignal } : {}),
    };
    record(root, node.id, since, { state: 'running' });
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
    record(root, node.id, since, { state: 'running', childId: activation && activation.childId });
    const reportTargets = (Array.isArray(payload.graph.edges) ? payload.graph.edges : [])
      .filter((edge) => edge && edge.from === node.id && edge.kind === 'report')
      .map((edge) => edge.to);
    watch(root, node.id, since, activation, at, node, reportTargets, payload.graph, parent);
    /* The child is born; the host session that carried it does not stay open. */
    closeHeadless();
    return { root, node: node.id, childId: activation && activation.childId, due: at.toISOString() };
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
    const word = 'Отчёт критика готов: ' + report + '\n\n' + summary;
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
        try {
          if (typeof handle.sendMessage === 'function') {
            await handle.sendMessage({ text: word });
            awake.push(target);
            deliveredRows.push({
              node: target,
              target: String(handle.sessionId || handle.session || handle.id || ''),
              reason: pick.reason,
              ...(pick.activityAt ? { activityAt: new Date(pick.activityAt).toISOString() } : {}),
            });
            continue;
          }
          if (typeof handle.send === 'function') {
            await handle.send({ text: word });
            awake.push(target);
            deliveredRows.push({
              node: target,
              target: String(handle.sessionId || handle.session || handle.id || ''),
              reason: pick.reason,
              ...(pick.activityAt ? { activityAt: new Date(pick.activityAt).toISOString() } : {}),
            });
            continue;
          }
        } catch {
          /* fall through to the activation path */
        }
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
        'Тебе доставлен отчёт узла «' + from + '» за ' + String(report).replace(/^.*\//u, '').replace(/\.md$/u, '') + '.',
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

  /** Record the end of the run the tick did not wait for. */
  function watch(root, node, since, activation, at, declaration, reportTargets, graph, parent) {
    const result = activation && activation.result;
    if (!result || typeof result.then !== 'function') return;
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
         * Validate by structure, not by vocabulary: the body starts at the first header
         * or section line, so a model thinking out loud about delivery is not a failure
         * by itself. What is a failure: no body at all, or a body without the sections
         * the spec promises.
         */
        const body = extractReportBody(text);
        const sections = countReportSections(body);
        const fragment = text.slice(0, 200).replace(/\s+/gu, ' ');
        let report = null;
        let delivered = null;
        let awake = [];
        let wakeNote = null;
        let wakeError = null;
        let wakeRow = null;
        let problem = null;
        if (!failed && declaration && isCriticNode(declaration)) {
          if (!body) {
            problem = 'в ответе нет отчёта — только рассуждения: ' + fragment;
          } else if (sections < 4) {
            problem = 'в отчёте нет всех четырёх разделов (итог дня, риски, что делать дальше, чего не хватило): ' + fragment;
          }
        }
        if (!failed && !problem && declaration && isCriticNode(declaration)) {
          try {
            report = writeCriticReport(root, declaration, at || new Date(), body, reportTargets || []);
          } catch (error) {
            problem = 'отчёт не записан: ' + errorText(error);
            warn('расписание: отчёт узла «' + node + '» не записан: ' + errorText(error));
          }
          if (report) {
            /*
             * A file is a report on a desk; the box is the relation. Delivery is part of
             * success: if the message cannot be written, the run is an error, not "ok".
             */
            try {
              /*
               * The addressee has to see the report, not its first paragraph. A summary
               * cut to five lines and 700 characters used to end mid-sentence and hide the
               * very sections the report is judged by, so a reader could not tell a full
               * report from a truncated one. Cut only what does not fit, at a line edge,
               * and say so in the message instead of truncating silently.
               */
              const summaryLimit = 4000;
              let summary = body.trim();
              if (summary.length > summaryLimit) {
                const edge = summary.lastIndexOf('\n', summaryLimit);
                const cutAt = edge > summaryLimit / 2 ? edge : summaryLimit;
                summary = summary.slice(0, cutAt).trimEnd()
                  + '\n\n…обрезано, см. файл: ' + report;
              }
              const message = writeExchangeMessage(root, {
                paths: runtime.exchange,
                from: declaration.id,
                to: (reportTargets || []).join(', ') || 'coordinator',
                participants: runtime.participants,
                node: declaration.id,
                thread: 'critic-report',
                status: 'report',
                file: report,
                subject: 'отчёт ' + declaration.id + ' за ' + String(report).replace(/^.*\//u, '').replace(/\.md$/u, ''),
                body: summary,
                at: at || new Date(),
                timeZone: declaration.schedule && declaration.schedule.timeZone,
              });
              delivered = message.relative;
              const woke = await wakeAddressees(root, reportTargets || [], report, summary, graph, parent, declaration.id);
              if (woke.deliveredRows && woke.deliveredRows.length > 0) wakeRow = woke.deliveredRows[0];
              if (woke.awake.length > 0) awake = woke.awake;
              else if ((reportTargets || []).length > 0) {
                /* A file in a box is not delivery: if nobody was woken, the run failed. */
                problem = 'отчёт записан и положен в ящик, но адресат не поднят: '
                  + woke.reasons.join('; ');
                wakeError = woke.reasons.join('; ');
              } else {
                wakeNote = 'у узла нет связи report — доставлять некому';
              }
            } catch (error) {
              problem = 'сообщение в ящик не записано: ' + errorText(error);
              warn('расписание: доставка отчёта узла «' + node + '» не удалась: ' + errorText(error));
            }
          }
        }
        const state = failed || problem ? 'error' : 'done';
        record(root, node, since, {
          state,
          finishedAt: Date.now(),
          childId: activation && activation.childId,
          ...(report ? { report } : {}),
          ...(delivered ? { delivered } : {}),
          ...(awake.length > 0 ? { awake } : {}),
          ...(wakeRow ? { wake: wakeRow } : {}),
          ...(wakeNote ? { wakeNote } : {}),
          ...(wakeError ? { wakeError } : {}),
          /* The schema's slot: filled later by whoever acknowledges the report. */
          ack: null,
          ...(problem ? { message: problem } : (failed ? { message: failureNote || 'агент завершился без отчёта' } : {})),
        });
      },
      (error) => {
        record(root, node, since, {
          state: 'error',
          finishedAt: Date.now(),
          childId: activation && activation.childId,
          message: errorText(error),
        });
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
