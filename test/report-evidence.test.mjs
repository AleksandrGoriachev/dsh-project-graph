/**
 * The report validator is the gate between "я проверил" and a closed step.
 * Each case is one rule of CONTRACT-report-evidence v1: the validator must name
 * the exact code, and the missing list must name the letter, file or field.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateReport, REPORT_CODES, FUTURE_TOLERANCE_MS } from '../lib/report-evidence.js';

let passed = 0;
const failures = [];
async function test(name, body) {
  try {
    await body();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

const NOW = '2026-11-02T22:10:00+03:00';
const BASE = Date.parse(NOW);
const TASK = '0100';
const NODE = 'worker';
const LETTER = 'threads/critic-report/2026-11-02T21-40+03-00--workflow--69.md';

/** ISO time N minutes before the reference instant. */
function at(minutes) {
  return new Date(BASE - minutes * 60 * 1000).toISOString();
}

const TASK_META = {
  id: TASK,
  version: 1,
  title: 'проверочное задание',
  owner: 'заказчик',
  executor: 'subagent:worker',
  acceptor: 'subagent:judge',
  allowedPaths: ['lib/**', 'test/**', 'docs/tasks/' + TASK + '/**'],
  protectedPaths: ['checks/**'],
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-report-'));
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify({
    version: 1,
    models: { work: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
    nodes: [
      { id: 'worker', role: 'исполнитель', model: 'work' },
      { id: 'judge', role: 'приёмщик', model: 'work' },
    ],
    edges: [{ from: 'worker', to: 'judge', kind: 'review' }],
  }, null, 2));
  const taskDir = path.join(root, 'docs', 'tasks', TASK);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), '# Задание\n\n<!-- TASK-META\n'
    + JSON.stringify(TASK_META, null, 2) + '\n-->\n');
  fs.writeFileSync(path.join(taskDir, 'criteria.lock'), JSON.stringify({ version: 3, task: TASK }, null, 2));
  const box = path.join(root, 'coordination');
  const letter = path.join(box, LETTER);
  fs.mkdirSync(path.dirname(letter), { recursive: true });
  fs.writeFileSync(letter, '# письмо\n');
  const letterTime = BASE - 3 * 60 * 1000;
  fs.utimesSync(letter, letterTime / 1000, letterTime / 1000);
  const reportPath = path.join(taskDir, 'report.' + NODE + '.json');
  const report = {
    version: 1,
    task: TASK,
    node: NODE,
    role: 'исполнитель',
    startedAt: at(30),
    completedAt: at(0),
    verdict: 'done',
    inbox: {
      checkedAt: at(1),
      thread: 'critic-report',
      box,
      new: [LETTER],
      unreadAfter: 0,
    },
    commands: [{ cmd: 'node --check lib/report-evidence.js', exit: 0, tail: '', at: at(2) }],
    files: ['lib/report-evidence.js'],
    checks: [],
    openItems: [],
    next: { node: 'judge', reason: 'критерий зелёный' },
  };
  const write = (mutator) => {
    const copy = JSON.parse(JSON.stringify(report));
    if (typeof mutator === 'function') mutator(copy);
    fs.writeFileSync(reportPath, JSON.stringify(copy, null, 2));
    return copy;
  };
  write();
  return { root, taskDir, box, reportPath, report, write, letter };
}

const created = [];
function make() {
  const item = fixture();
  created.push(item.root);
  return item;
}

function validate(item, overrides = {}) {
  return validateReport({ root: item.root, file: item.reportPath, box: item.box, now: NOW, ...overrides });
}

await test('C1: валидный отчёт со свежим ящиком принимается', async () => {
  const item = make();
  const result = validate(item);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.report.node, NODE);
});

await test('C2: done без доказательств -> no-evidence с missing', async () => {
  const item = make();
  item.write((report) => {
    report.commands = [{ cmd: 'node broken.mjs', exit: 1, tail: 'ошибка', at: at(2) }];
    report.checks = [];
  });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-evidence');
  assert.ok(result.missing.length > 0, 'missing не пуст');
  assert.equal(typeof result.message, 'string');
  assert.equal(typeof result.fix, 'string');
});

await test('C3: старый checkedAt при письме новее -> inbox-stale, письмо в missing', async () => {
  const item = make();
  item.write((report) => { report.inbox.checkedAt = at(10); report.inbox.new = []; });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'inbox-stale');
  assert.ok(result.missing.some((row) => row.includes('2026-11-02T21-40+03-00--workflow--69.md')),
    'missing называет письмо: ' + JSON.stringify(result.missing));
});

await test('C4: файл вне allowedPaths -> outside-allowed-paths', async () => {
  const item = make();
  item.write((report) => { report.files = ['lib/report-evidence.js', 'src/secret.js']; });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'outside-allowed-paths');
  assert.ok(result.missing.includes('src/secret.js'), JSON.stringify(result.missing));
});

await test('C5: время в будущем -> time-invalid', async () => {
  const item = make();
  item.write((report) => { report.completedAt = new Date(BASE + 10 * 60 * 1000).toISOString(); });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'time-invalid');
  assert.ok(result.missing.length > 0);
});

await test('C5: completedAt раньше startedAt -> time-invalid', async () => {
  const item = make();
  item.write((report) => { report.completedAt = at(40); });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'time-invalid');
});

await test('C6: узел вне структуры -> node-unknown', async () => {
  const item = make();
  item.write((report) => { report.node = 'ghost'; });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'node-unknown');
  assert.ok(result.missing.some((row) => row.includes('ghost')));
});

await test('отчёта нет -> report-missing', async () => {
  const item = make();
  fs.rmSync(item.reportPath);
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'report-missing');
});

await test('битый JSON -> report-invalid', async () => {
  const item = make();
  fs.writeFileSync(item.reportPath, '{ "version": 1, ');
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'report-invalid');
});

await test('version не 1 -> report-invalid', async () => {
  const item = make();
  item.write((report) => { report.version = 2; });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'report-invalid');
});

await test('§3: отчёт без любого обязательного поля -> report-invalid', async () => {
  for (const name of ['verdict', 'files', 'openItems', 'commands']) {
    const item = make();
    item.write((report) => { delete report[name]; });
    const result = validate(item);
    assert.equal(result.ok, false, name + ' необязателен: ' + JSON.stringify(result));
    assert.equal(result.code, 'report-invalid', name + ': ' + JSON.stringify(result));
    assert.ok(result.missing.some((row) => row.includes(name)),
      name + ' назван в missing: ' + JSON.stringify(result.missing));
  }
});

await test('§3: пустой список обязателен, но отсутствие поля — нет', async () => {
  const item = make();
  item.write((report) => { report.files = []; report.openItems = []; report.commands = []; });
  const result = validate(item);
  assert.equal(result.code, 'no-evidence', 'пустые списки доходят до P-4, а не падают на §3: ' + JSON.stringify(result));
});

await test('§3: неизвестный verdict -> report-invalid', async () => {
  for (const verdict of ['failed', 'partial', 'DONE', '']) {
    const item = make();
    item.write((report) => { report.verdict = verdict; });
    const result = validate(item);
    assert.equal(result.ok, false, 'verdict ' + JSON.stringify(verdict) + ' принят: ' + JSON.stringify(result));
    assert.equal(result.code, 'report-invalid', 'verdict ' + JSON.stringify(verdict) + ': ' + JSON.stringify(result));
    assert.ok(result.missing.some((row) => row.includes('done')), JSON.stringify(result.missing));
  }
});

await test('роль не совпадает -> role-mismatch', async () => {
  const item = make();
  item.write((report) => { report.role = 'приёмщик'; });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'role-mismatch');
});

await test('свежий checkedAt, но письма нет в new[] -> inbox-incomplete', async () => {
  const item = make();
  item.write((report) => { report.inbox.checkedAt = at(0.5); report.inbox.new = []; });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'inbox-incomplete');
  assert.ok(result.missing.some((row) => row.includes('2026-11-02T21-40+03-00--workflow--69.md')));
});

await test('checkedAt не новее предыдущего отчёта -> inbox-stale', async () => {
  const item = make();
  const previous = { version: 1, task: TASK, node: NODE, inbox: { checkedAt: at(2) } };
  fs.writeFileSync(path.join(item.taskDir, 'report.' + NODE + '.old.json'), JSON.stringify(previous));
  item.write((report) => { report.inbox.checkedAt = at(2); });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'inbox-stale');
});

await test('verdict done с падающей командой -> failing-command', async () => {
  const item = make();
  item.write((report) => {
    /* P-12: у команд своё время — одинаковые метки сами по себе отказ. */
    report.commands = [
      { cmd: 'node ok.mjs', exit: 0, tail: '', at: at(3) },
      { cmd: 'node broken.mjs', exit: 1, tail: 'падение', at: at(2) },
    ];
  });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failing-command');
});

await test('ожидаемое падение в checks не блокирует done', async () => {
  const item = make();
  item.write((report) => {
    report.commands = [
      { cmd: 'node ok.mjs', exit: 0, tail: '', at: at(3) },
      { cmd: 'node broken.mjs', exit: 1, tail: 'падение', at: at(2) },
    ];
    report.checks = [{ id: 'c-red', status: 'expected-fail', cmd: 'node broken.mjs', evidence: 'red.log' }];
  });
  const result = validate(item);
  assert.equal(result.ok, true, JSON.stringify(result));
});

await test('checks со статусом pass достаточно без команд', async () => {
  const item = make();
  item.write((report) => {
    report.commands = [];
    report.checks = [{ id: 'c1', status: 'pass', evidence: 'docs/tasks/' + TASK + '/c1.log' }];
  });
  const result = validate(item);
  assert.equal(result.ok, true, JSON.stringify(result));
});

await test('verdict blocked без причины -> blocked-without-reason', async () => {
  const item = make();
  item.write((report) => {
    report.verdict = 'blocked';
    report.commands = [];
    report.openItems = [];
  });
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'blocked-without-reason');
});

await test('verdict blocked с причиной и адресатом принимается', async () => {
  const item = make();
  item.write((report) => {
    report.verdict = 'blocked';
    report.commands = [];
    report.openItems = [{ reason: 'нет доступа к ящику', addressee: 'judge' }];
  });
  const result = validate(item);
  assert.equal(result.ok, true, JSON.stringify(result));
});

await test('задание с acceptance.json -> task-not-active', async () => {
  const item = make();
  fs.writeFileSync(path.join(item.taskDir, 'acceptance.json'), JSON.stringify({ status: 'accepted' }));
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'task-not-active');
});

await test('у задания нет criteria.lock -> task-not-active', async () => {
  const item = make();
  fs.rmSync(path.join(item.taskDir, 'criteria.lock'));
  const result = validate(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'task-not-active');
});

/** Положить в проект конфиг репозитория с одним guard.allow. */
function writeRepoGuard(root, allow) {
  const dir = path.join(root, 'docs', 'subagent-workflow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflow.config.json'), JSON.stringify({ guard: { allow } }, null, 2));
}

await test('P-6: guard.allow из тела отчёта не действует', async () => {
  const item = make();
  fs.writeFileSync(path.join(item.taskDir, 'guard.json'), JSON.stringify({
    allow: [{ path: 'src/secret.js', reason: 'правка по разрешению заказчика' }],
  }));
  item.write((report) => {
    report.files = ['src/secret.js'];
    report.guard = { allow: [{ path: 'src/secret.js', reason: 'отчёт сам себя разрешил' }] };
  });
  const result = validate(item);
  assert.equal(result.ok, false, 'самоподпись отчёта сработала: ' + JSON.stringify(result));
  assert.equal(result.code, 'outside-allowed-paths');
  assert.ok(result.missing.includes('src/secret.js'), JSON.stringify(result.missing));
  assert.ok(/workflow\.config\.json/u.test(result.fix), 'fix называет конфиг: ' + result.fix);
});

await test('P-6: guard.allow репозиторного конфига разрешает файл вне allowedPaths', async () => {
  const item = make();
  writeRepoGuard(item.root, [{ path: 'src/secret.js', reason: 'правка по разрешению заказчика' }]);
  item.write((report) => { report.files = ['src/secret.js']; });
  const result = validate(item);
  assert.equal(result.ok, true, JSON.stringify(result));
});

await test('коды отказа берутся из контракта', async () => {
  assert.deepEqual(REPORT_CODES, [
    'report-missing', 'report-invalid', 'task-not-active', 'node-unknown', 'role-mismatch',
    'no-evidence', 'inbox-stale', 'inbox-incomplete', 'outside-allowed-paths', 'failing-command',
    'blocked-without-reason', 'time-invalid', 'time-implausible', 'backfilled-not-evidence',
  ]);
  assert.equal(FUTURE_TOLERANCE_MS, 5 * 60 * 1000);
});

for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const detail = failure.error && failure.error.message ? failure.error.message : String(failure.error);
  console.error('  ' + detail.split('\n').join('\n  '));
}
for (const dir of created) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
}
const total = passed + failures.length;
console.log('REPORT EVIDENCE TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
