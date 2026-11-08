#!/usr/bin/env node
/**
 * Пульт наблюдения: состояния узлов графа и стадия задачи workflow.
 *
 *   node tools/watch-states.mjs --origin http://127.0.0.1:63357 --root <проект> [--once] [--interval 4000]
 *
 * Печатает по строке на узел (состояние, ветка, длительность) и строку на задачу
 * workflow (стадия, флаги). Ничего не меняет: только два GET-запроса, которые
 * делает и сама панель.
 */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const at = args.indexOf('--' + name);
  return at !== -1 && args[at + 1] ? args[at + 1] : fallback;
}
const origin = arg('origin', process.env.DSH_WEB_URL || 'http://127.0.0.1:63357');
const root = arg('root', process.cwd());
const once = args.includes('--once');
const interval = Number(arg('interval', '4000'));

async function get(path) {
  const response = await fetch(origin + path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(path + ' → HTTP ' + response.status);
  return response.json();
}

function clock(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function sample() {
  const encoded = encodeURIComponent(root);
  const [activity, tasks] = await Promise.all([
    get('/project-graph/api/activity?root=' + encoded).catch((error) => ({ runs: [], error: error.message })),
    get('/workflow/api/tasks').catch((error) => ({ tasks: [], error: error.message })),
  ]);
  const stamp = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const runs = (activity.runs || []).slice(0, 12);
  console.log('[' + stamp + '] узлы: ' + (runs.length === 0 ? 'запусков нет' : ''));
  for (const run of runs) {
    const ended = run.finishedAt ? ' → ' + clock(run.finishedAt) : '';
    console.log('  ' + String(run.node).padEnd(14) + String(run.state).padEnd(8)
      + (run.branchId ? ' ветка ' + String(run.branchId).slice(-8) : '')
      + '  ' + clock(run.since) + ended
      + (run.message ? '  «' + run.message + '»' : ''));
  }
  const list = tasks.tasks || [];
  if (tasks.error) console.log('  workflow: ' + tasks.error);
  for (const task of list.slice(0, 6)) {
    console.log('  задача ' + task.id + ': ' + (task.stageLabel || task.stage || '?')
      + (task.flags && task.flags.length > 0 ? '  флагов: ' + task.flags.length : '')
      + (task.releaseReady ? '  releaseReady' : ''));
  }
}

if (once) {
  await sample();
} else {
  await sample();
  setInterval(() => { sample().catch((error) => console.error('ошибка наблюдения: ' + error.message)); }, interval);
}
