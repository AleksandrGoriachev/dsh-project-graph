/**
 * 0206: политика роли — матрица, legacy-совместимость и default all-auto.
 *
 *   c1  rolePolicy(role): проверяющие роли получают all-auto, релизная —
 *       presetRequired, остальные — none;
 *   c2  legacy: явные consumes у reviewer/judge не меняются, worker без
 *       consumes не ломает привязку; non-audit consumes — warning, не отказ;
 *       без auto-якорей у judge/приёмщика отказа нет (он не bound 0186),
 *       а у reviewer/аудитора сохраняется прежний отказ; spawn с валидной
 *       подписью и judge без consumes проходит;
 *   c3  defaultConsumes: проверяющий узел с пустым consumes получает все auto id,
 *       явные consumes не дополняются; гейт запуска (lib/spawn.js) пропускает
 *       такого аудитора и требует, чтобы вердикт покрыл его default-вход.
 *
 * Тесты — поведенческие: зовут те же функции, что validateBinding и гейт
 * запуска, и не пересказывают реализацию. Стенд спавна подписывает утверждение
 * якорей тестовым Ed25519-ключом: гейт читает .wf-keys/<keyId>.pub.pem.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphRuntime } from '../lib/api.js';
import { createSpawnTool } from '../lib/spawn.js';
import { validateBinding } from '../lib/anchors.js';
import { auditRoleKind, defaultConsumes, normalizeRole, rolePolicy } from '../lib/role-policy.js';

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

/* ------------------------------------------------------------------ */
/* c1: матрица ролей                                                   */
/* ------------------------------------------------------------------ */

const ALL_AUTO = { audit: true, consumesDefault: 'all-auto', presetRequired: false };
const NONE = { audit: false, consumesDefault: 'none', presetRequired: false };
const RELEASE = { audit: false, consumesDefault: 'none', presetRequired: true };

async function c1() {
  await test('c1: аудиторы получают audit + default all-auto', () => {
    for (const role of ['аудитор', 'Аудитор задач', 'auditor', 'AUDITOR', ' auditor ']) {
      assert.deepEqual(rolePolicy(role), ALL_AUTO, role);
    }
  });
  await test('c1: ревьюеры (reviewer/review) получают all-auto', () => {
    for (const role of ['ревьюер', 'Ревьюер', 'reviewer', 'Reviewer 1', 'review']) {
      assert.deepEqual(rolePolicy(role), ALL_AUTO, role);
    }
  });
  await test('c1: судья/judge и приёмщик/acceptor — аудиторы', () => {
    for (const role of ['судья', 'judge', 'Judge', 'приёмщик', 'приемщик', 'acceptor']) {
      assert.deepEqual(rolePolicy(role), ALL_AUTO, role);
    }
  });
  await test('c1: релизная роль требует пресет, но не якоря', () => {
    for (const role of ['выпускающий', 'release', 'release-1', 'релиз', 'релизная']) {
      assert.deepEqual(rolePolicy(role), RELEASE, role);
    }
  });
  await test('c1: остальные роли — none и без обязательного пресета', () => {
    for (const role of ['исполнитель', 'координатор', 'критик', 'тестировщик', 'дизайнер',
      'worker', 'coordinator', 'lead', '', '   ', null, undefined, 42, {}, []]) {
      assert.deepEqual(rolePolicy(role), NONE, JSON.stringify(role));
    }
  });
  await test('c1: нормализация роли — регистр, ё, пробелы; id-строки role тоже читаются', () => {
    assert.equal(normalizeRole('  ПРИЁМЩИК  '), 'приемщик');
    assert.equal(auditRoleKind('  Аудитор   задач '), 'аудитор');
    assert.equal(auditRoleKind('reviewer-1'), 'ревьюер');
    assert.equal(auditRoleKind('preview'), '', 'preview не review');
    assert.equal(rolePolicy('приёмщик').audit, true);
    assert.equal(rolePolicy('выпускающий').presetRequired, true);
  });
}

/* ------------------------------------------------------------------ */
/* c2: legacy-структуры не ломаются                                    */
/* ------------------------------------------------------------------ */

/** Старый корпус: статусы active/inWork — auto-якорей нет (0186 как был). */
const LEGACY_ANCHORS = {
  version: 1,
  anchors: [
    { id: 'A1', claim: 'старый якорь', check: 'checks/0186', status: 'active' },
    { id: 'A2', claim: 'в работе', check: 'checks/0186', status: 'inWork' },
  ],
};

const LEGACY_GRAPH = {
  nodes: [
    { id: 'coordinator', role: 'координатор' },
    { id: 'worker', role: 'исполнитель', anchors: { consumes: [], produces: [] } },
    { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [{ id: 'A1' }], produces: [] } },
    { id: 'judge', role: 'приёмщик', anchors: { consumes: ['A2'], produces: [] } },
  ],
};

async function c2() {
  await test('c2: reviewer и judge с явными consumes проходят; worker с пустым — тоже', () => {
    assert.deepEqual(validateBinding(LEGACY_GRAPH, LEGACY_ANCHORS), { ok: true, errors: [] });
  });
  await test('c2: явные consumes не меняются и не дополняются default-ом', () => {
    const before = JSON.parse(JSON.stringify(LEGACY_GRAPH));
    const result = validateBinding(LEGACY_GRAPH, LEGACY_ANCHORS);
    assert.equal(result.ok, true);
    assert.deepEqual(LEGACY_GRAPH, before, 'validateBinding не пишет в structure');
    assert.deepEqual(defaultConsumes(LEGACY_GRAPH.nodes[2], LEGACY_ANCHORS), [], 'явный consumes не расширяется');
    assert.deepEqual(defaultConsumes(LEGACY_GRAPH.nodes[1], LEGACY_ANCHORS), [], 'worker не аудитор');
  });
  await test('c2: неизвестный id в consumes — ошибка с узлом и id', () => {
    const graph = {
      nodes: [{ id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [{ id: 'ZZ' }] } }],
    };
    const result = validateBinding(graph, LEGACY_ANCHORS);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' | '), /«ZZ»/u);
    assert.match(result.errors.join(' | '), /reviewer-1/u);
  });
  await test('c2: non-audit consumes — warning, не отказ', () => {
    const graph = {
      nodes: [{ id: 'worker', role: 'исполнитель', anchors: { consumes: ['A1'], produces: [] } }],
    };
    const result = validateBinding(graph, LEGACY_ANCHORS);
    assert.equal(result.ok, true, 'отказа нет');
    assert.deepEqual(result.errors, []);
    assert.equal(Array.isArray(result.warnings), true, 'warning назван списком');
    assert.match(result.warnings.join(' | '), /worker/u);
    assert.match(result.warnings.join(' | '), /warning/u);
  });
  await test('c2: judge/приёмщик/судья/acceptor без consumes на legacy-якорях — ok', () => {
    for (const role of ['приёмщик', 'судья', 'judge', 'acceptor']) {
      const graph = {
        nodes: [
          { id: 'worker', role: 'исполнитель' },
          { id: 'judge', role },
        ],
      };
      const result = validateBinding(graph, LEGACY_ANCHORS);
      assert.equal(result.ok, true, role + ' не bound 0186 — отказа нет');
      assert.deepEqual(result.errors, []);
      assert.equal(result.warnings, undefined, role + ' — проверяющая роль, warning не нужен');
      assert.deepEqual(defaultConsumes(graph.nodes[1], LEGACY_ANCHORS), [], 'auto-якорей нет — default пуст');
    }
  });
  await test('c2: без auto-якорей bound-роль без consumes — прежний отказ 0186', () => {
    for (const node of [
      { id: 'auditor', role: 'Аудитор задач' },
      { id: 'reviewer-1', role: 'ревьюер', anchors: { consumes: [] } },
    ]) {
      const result = validateBinding({ nodes: [node] }, LEGACY_ANCHORS);
      assert.equal(result.ok, false, node.id + ' без auto-якорей не получает default');
      assert.match(result.errors.join(' | '), /непустой anchors\.consumes/u);
    }
  });
  await test('c2: spawn с валидной подписью и judge без consumes проходит', async () => {
    const project = makeSignedProject({
      graph: JUDGE_LEGACY_GRAPH,
      taskMeta: JUDGE_META,
      anchorsDoc: LEGACY_ANCHORS,
      auditAnchors: null,
    });
    const { tool, subagents } = spawnToolFor(project.root);
    const value = await tool.execute({ node: 'worker', prompt: 'сделай', task: 'docs/tasks/9003/task.md' }, execOf());
    assert.equal(value.kind, 'activation');
    assert.equal(subagents.calls.length, 1, 'judge без consumes не блокирует активацию legacy-проекта');
  });
  await test('c2: нет списка якорей — ошибка, как раньше', () => {
    for (const value of [null, undefined, {}, { version: 1 }, 'anchors']) {
      assert.equal(validateBinding({ nodes: [] }, value).ok, false);
    }
  });
}

/* ------------------------------------------------------------------ */
/* c3: default all-auto и гейт запуска                                 */
/* ------------------------------------------------------------------ */

const AUTO_ANCHORS = {
  version: 2,
  anchors: [
    { id: 'A1', claim: 'авто-1', check: 'checks/x', status: 'auto' },
    { id: 'A2', claim: 'в работе', check: 'checks/x', status: 'inWork' },
    { id: 'A3', claim: 'авто-2', check: 'checks/x', status: 'AUTO' },
  ],
};

async function c3() {
  await test('c3: defaultConsumes — все auto id, только у проверяющего и только при пустом consumes', () => {
    assert.deepEqual(defaultConsumes({ id: 'reviewer-1', role: 'ревьюер' }, AUTO_ANCHORS), ['A1', 'A3']);
    assert.deepEqual(defaultConsumes({ id: 'auditor', role: 'Аудитор задач' }, AUTO_ANCHORS), ['A1', 'A3']);
    assert.deepEqual(defaultConsumes({ id: 'judge', role: 'приёмщик' }, AUTO_ANCHORS), ['A1', 'A3']);
    assert.deepEqual(defaultConsumes({ id: 'auditor', role: 'проверяющий' }, AUTO_ANCHORS), ['A1', 'A3'], 'legacy id auditor');
    assert.deepEqual(
      defaultConsumes({ id: 'auditor', role: 'Аудитор задач', anchors: { consumes: ['A2'] } }, AUTO_ANCHORS),
      [],
      'явные consumes не меняются',
    );
    assert.deepEqual(defaultConsumes({ id: 'worker', role: 'исполнитель' }, AUTO_ANCHORS), []);
    assert.deepEqual(defaultConsumes({ id: 'release-1', role: 'выпускающий' }, AUTO_ANCHORS), []);
    assert.deepEqual(defaultConsumes({ id: 'reviewer-1', role: 'ревьюер' }, null), []);
  });
  await test('c3: validateBinding пропускает аудитора без consumes и не пишет в structure', () => {
    const graph = {
      nodes: [
        { id: 'worker', role: 'исполнитель', anchors: { consumes: [], produces: [] } },
        { id: 'reviewer-1', role: 'ревьюер' },
        { id: 'judge', role: 'приёмщик' },
        { id: 'auditor', role: 'Аудитор задач', anchors: { consumes: [], produces: [] } },
      ],
    };
    const before = JSON.parse(JSON.stringify(graph));
    assert.deepEqual(validateBinding(graph, AUTO_ANCHORS), { ok: true, errors: [] });
    assert.deepEqual(graph, before, 'default — runtime, структура не переписана');
  });

  await test('c3: гейт запуска пропускает аудитора/ревьюера/приёмщика без consumes', async () => {
    const project = makeAnchorProject({ auditAnchors: ['A1', 'A3'] });
    const { tool, subagents } = spawnToolFor(project.root);
    const value = await tool.execute({ node: 'worker', prompt: 'сделай', task: 'docs/tasks/9003/task.md' }, execOf());
    assert.equal(value.kind, 'activation');
    assert.equal(subagents.calls.length, 1, 'агент активирован при default all-auto');
  });

  await test('c3: default all-auto обязывает вердикт покрыть A1 и A3', async () => {
    const project = makeAnchorProject({ auditAnchors: ['A1'] });
    const { tool, subagents } = spawnToolFor(project.root);
    await assert.rejects(
      () => tool.execute({ node: 'worker', prompt: 'сделай', task: 'docs/tasks/9003/task.md' }, execOf()),
      (error) => {
        assert.equal(error.code, 'audit-required');
        assert.match(error.message, /A3/u, 'вердикт обязан назвать default-якорь A3');
        return true;
      },
    );
    assert.equal(subagents.calls.length, 0, 'неполный вердикт не активирует');
  });
}

/* ------------------------------------------------------------------ */
/* стенд: проект с утверждёнными auto-якорями                          */
/* ------------------------------------------------------------------ */

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const TEST_KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PUBLIC_PEM = TEST_KEYS.publicKey.export({ type: 'spki', format: 'pem' });

/** canonical({hash,by,at}) — та же строка, что подписывает владелец. */
function signingText(approval) {
  const fields = { hash: approval.hash, by: approval.by, at: approval.at };
  return '{' + Object.keys(fields).sort()
    .map((key) => JSON.stringify(key) + ':' + JSON.stringify(fields[key])).join(',') + '}';
}

const GRAPH = {
  version: 1,
  models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
  nodes: [
    { id: 'coordinator', role: 'координатор', model: 'ds' },
    { id: 'worker', role: 'исполнитель', model: 'ds' },
    { id: 'reviewer-1', role: 'ревьюер', model: 'ds', anchors: { consumes: [{ id: 'A1' }], produces: [] } },
    { id: 'judge', role: 'приёмщик', model: 'ds' },
    { id: 'auditor', role: 'Аудитор задач', model: 'ds' },
  ],
  edges: [
    { from: 'coordinator', to: 'worker', kind: 'delegate' },
    { from: 'worker', to: 'reviewer-1', kind: 'report' },
    { from: 'reviewer-1', to: 'judge', kind: 'review' },
    { from: 'judge', to: 'coordinator', kind: 'report' },
    { from: 'coordinator', to: 'auditor', kind: 'delegate' },
  ],
};

const TASK_META = {
  id: '9003',
  version: 1,
  executor: 'subagent:worker',
  acceptor: 'subagent:judge',
  acceptorNode: 'judge',
  auditor: 'subagent:auditor',
};

/*
 * c2: legacy-проект без reviewer/auditor и без auto-якорей. judge (приёмщик)
 * не bound-роль 0186: пустой consumes не должен отказывать ни в binding, ни
 * в гейте запуска. Задание называет его приёмщиком — контракт сходится.
 */
const JUDGE_LEGACY_GRAPH = {
  version: 1,
  models: { ds: { provider: 'opencode', model: 'deepseek-v4.1-flash' } },
  nodes: [
    { id: 'coordinator', role: 'координатор', model: 'ds' },
    { id: 'worker', role: 'исполнитель', model: 'ds' },
    { id: 'judge', role: 'приёмщик', model: 'ds' },
  ],
  edges: [
    { from: 'coordinator', to: 'worker', kind: 'delegate' },
    { from: 'worker', to: 'judge', kind: 'review' },
    { from: 'judge', to: 'coordinator', kind: 'report' },
  ],
};

const JUDGE_META = {
  id: '9003',
  version: 1,
  executor: 'subagent:worker',
  acceptor: 'subagent:judge',
  acceptorNode: 'judge',
};

/**
 * Проект стенда: structure/graph.json, утверждённые docs/anchors.json,
 * ключ .wf-keys/human-test.pub.pem, задание 9003 и (по запросу) audit.json.
 * Подпись настоящая Ed25519: гейт читает .wf-keys/<keyId>.pub.pem.
 */
function makeSignedProject({ graph, taskMeta, anchorsDoc, auditAnchors }) {
  const root = makeTempDir('pg-0206-');
  fs.mkdirSync(path.join(root, 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'structure', 'graph.json'), JSON.stringify(graph, null, 2) + '\n');

  const anchorsText = JSON.stringify(anchorsDoc, null, 2) + '\n';
  const docs = path.join(root, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'anchors.json'), anchorsText);
  const keys = path.join(root, '.wf-keys');
  fs.mkdirSync(keys, { recursive: true });
  fs.writeFileSync(path.join(keys, 'human-test.pub.pem'), TEST_PUBLIC_PEM);
  const hash = crypto.createHash('sha256').update(anchorsText, 'utf8').digest('hex');
  const at = '2026-11-11T00:00:00.000Z';
  const by = ['тест'];
  const value = crypto.sign(null, Buffer.from(signingText({ hash, by, at }), 'utf8'), TEST_KEYS.privateKey)
    .toString('base64');
  const approval = {
    version: 2,
    anchors: 'docs/anchors.json',
    algo: 'sha256',
    hash,
    layer: 'project',
    sides: 'project',
    enforcedBy: 'nodes',
    by,
    at,
    signature: { keyId: 'human-test', algo: 'ed25519', covers: 'hash+by+at', value },
  };
  fs.writeFileSync(path.join(docs, 'anchors.approval.json'), JSON.stringify(approval, null, 2) + '\n');

  const taskDir = path.join(docs, 'tasks', '9003');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'),
    '<!-- TASK-META\n' + JSON.stringify(taskMeta) + '\n-->\n\n# 9003 стенд\n');
  if (Array.isArray(auditAnchors)) {
    const audit = {
      version: 1,
      task: '9003',
      auditor: 'auditor',
      verdict: 'conform',
      anchors: auditAnchors.map((id) => ({ id, status: 'confirmed' })),
      reason: 'стенд 0206',
      at: '2026-11-11T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(taskDir, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
  }
  return { root };
}

/** c3-стенд: рабочая структура, auto-якоря и audit.json аудитора. */
function makeAnchorProject({ auditAnchors }) {
  return makeSignedProject({
    graph: GRAPH,
    taskMeta: TASK_META,
    anchorsDoc: AUTO_ANCHORS,
    auditAnchors,
  });
}

function spawnToolFor(root) {
  const runtime = createGraphRuntime({ roots: [root], runsDir: path.join(root, '.runs') });
  const subagents = {
    calls: [],
    getProvider(name) {
      return { name, capabilities: { agentOptions: true } };
    },
    resolveMaxDepth(configured) {
      return configured === undefined ? 1 : configured;
    },
    async startActivation(spec) {
      this.calls.push(spec);
      return { childId: 'child-1' };
    },
  };
  const tool = createSpawnTool({ runtime, config: {}, getSubagents: () => subagents });
  return { tool, subagents };
}

function execOf() {
  return { agent: { id: 'agent-parent' }, signal: { aborted: false } };
}

/* ------------------------------------------------------------------ */
/* запуск                                                              */
/* ------------------------------------------------------------------ */

const sections = { c1, c2, c3 };
const arg = String(process.argv[2] || '').toLowerCase();

async function main() {
  if (arg && !sections[arg]) {
    console.log('usage: node test/role-policy.test.mjs c1|c2|c3');
    process.exit(2);
  }
  if (arg) {
    await sections[arg]();
  } else {
    for (const name of Object.keys(sections)) await sections[name]();
  }
  const total = passed + failures.length;
  for (const failure of failures) {
    console.error('FAIL ' + failure.name);
    console.error('  ' + (failure.error && failure.error.message
      ? failure.error.message.split('\n')[0]
      : String(failure.error)));
  }
  console.log('ROLE POLICY TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('ROLE POLICY TEST FAILED: ' + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
