import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHeader, readExchange, currentLabel } from '../lib/exchange.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

const HEAD = (from, to, date, extra = '') => 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nThread: t1\nStatus: info\n' + extra + '\n';

function workspace() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-exchange-'));
  const root = path.join(parent, 'dsh-project-graph');
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(parent, 'coordination');
  fs.mkdirSync(path.join(dir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'threads', 'a--01.md'), HEAD('structure', 'workflow', '2026-10-28T17:26+03:00'));
  fs.writeFileSync(path.join(dir, 'threads', 'b--01.md'), HEAD('workflow', 'structure', '2026-10-28T17:25+03:00'));
  fs.writeFileSync(path.join(dir, 'threads', 'c--01.md'), HEAD('workflow', 'structure', '2026-10-28T19:05+03:00'));
  fs.writeFileSync(path.join(dir, 'threads', 'broken.md'), 'просто текст без шапки');
  return { parent, root, dir };
}

test('шапка разбирается, без From/To/Date факта нет', () => {
  const parsed = parseHeader(HEAD('a', 'b', '2026-10-28T10:00Z', 'Subject: x\n'));
  assert.equal(parsed.from, 'a');
  assert.equal(parsed.to, 'b');
  assert.equal(parsed.at, Date.parse('2026-10-28T10:00Z'));
  assert.equal(parseHeader('From: a\nTo: b\n'), null);
});

test('шапка отдаёт Workspace, Node и Reply-To, а не только From/To', () => {
  const parsed = parseHeader(HEAD('Critic', 'coordinator', '2026-11-01T13:01:14+03:00',
    'Node: Critic\nWorkspace: workflow\nReply-To: threads/critic-report/x--01.md\n'));
  assert.equal(parsed.workspace, 'workflow');
  assert.equal(parsed.node, 'Critic');
  assert.equal(parsed.replyTo, 'threads/critic-report/x--01.md');
});

test('письмо между двумя узлами своей работы остаётся фактом по полю Workspace', () => {
  const { root, dir } = workspace();
  /* Critic -> coordinator: ни From, ни To не называют воркспейс, только Workspace. */
  fs.writeFileSync(path.join(dir, 'threads', 'report.md'),
    HEAD('Critic', 'coordinator', '2026-11-01T13:01:14+03:00', 'Node: Critic\nWorkspace: structure\nFile: docs/critic/2026-11-01.md\n'));
  const result = readExchange(root, { paths: [dir], participants: { structure: root, workflow: '/elsewhere' } });
  assert.ok(result.facts.some((fact) => fact.from === 'Critic'),
    'собственный отчёт критика не должен выпадать из фактов');
});

test('одно сообщение — односторонняя связь с направлением', () => {
  const { root, parent } = workspace();
  const single = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-single-'));
  fs.mkdirSync(path.join(single, 'coordination', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(single, 'coordination', 'threads', 'x.md'), HEAD('workflow', 'structure', '2026-10-28T17:25+03:00'));
  const project = path.join(single, 'proj');
  fs.mkdirSync(project);
  const result = readExchange(project, {
    paths: [path.join(single, 'coordination')],
    participants: { structure: project, workflow: '/elsewhere' },
  });
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].kind, 'incoming');
  assert.equal(result.links[0].incoming, 1);
  assert.equal(result.links[0].outgoing, 0);
});

test('обмен в обе стороны — двусторонняя, группировка по адресату', () => {
  const { root, dir } = workspace();
  const result = readExchange(root, { paths: [dir], participants: { structure: root, workflow: '/elsewhere' } });
  assert.equal(result.label, 'structure');
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].kind, 'two-way');
  assert.equal(result.links[0].outgoing, 1);
  assert.equal(result.links[0].incoming, 2);
  assert.equal(result.unparsed, 1, 'файл без шапки считается, а не выдумывается');
  assert.ok(result.links[0].facts[0].at >= result.links[0].facts[1].at, 'свежее первым');
});

test('чужие сообщения не становятся нашей связью', () => {
  const { root, dir } = workspace();
  fs.writeFileSync(path.join(dir, 'threads', 'foreign.md'), HEAD('alpha', 'beta', '2026-10-28T20:00+03:00'));
  const result = readExchange(root, { paths: [dir], participants: { structure: root, workflow: '/elsewhere' } });
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].counterpart, 'workflow');
});

test('без объявленного имени воркспейса классификация честно отказывается', () => {
  const { root, dir } = workspace();
  const result = readExchange(root, { paths: [dir], participants: { other: '/x' } });
  assert.equal(result.label, null);
  assert.equal(result.links.length, 0);
  assert.match(result.reason, /exchange.me|participants/);
});

test('чужую переписку воркспейс не читает: только свои участники', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-privacy-'));
  const root = path.join(parent, 'dsh-project-graph');
  fs.mkdirSync(root, { recursive: true });
  const threads = path.join(parent, 'coordination', 'threads');
  fs.mkdirSync(threads, { recursive: true });
  fs.writeFileSync(path.join(threads, 'ours-in.md'), HEAD('workflow', 'structure', '2026-10-28T17:25+03:00'));
  fs.writeFileSync(path.join(threads, 'ours-out.md'), HEAD('structure', 'workflow', '2026-10-28T17:26+03:00'));
  fs.writeFileSync(path.join(threads, 'theirs.md'), HEAD('alpha', 'beta', '2026-10-28T18:00+03:00'));
  const result = readExchange(root, {
    paths: [path.join(parent, 'coordination')],
    participants: { structure: root, workflow: path.join(parent, 'workflow') },
    me: 'structure',
  });
  assert.equal(result.total, 2, 'только две свои стороны');
  assert.ok(!result.facts.some((fact) => /theirs/u.test(fact.file)), 'чужое письмо не попадает в факты');
});

test('легаси-портал остаётся, но принадлежит только текущему воркспейсу', () => {
  const { root, dir } = workspace();
  assert.ok(fs.existsSync(path.join(dir, 'threads', 'a--01.md')), 'общий каталог лежит рядом');
  /* Глобальная карта называет воркспейс structure — для легаси-портала это чужое имя. */
  const result = readExchange(root, { participants: { structure: root, workflow: '/elsewhere' } });
  assert.equal(result.sources.length, 1, 'автообнаружение каталога coordination сохраняется');
  assert.equal(result.label, path.basename(root), 'портал говорит именем текущего воркспейса');
  assert.deepEqual(result.participants, [path.basename(root)], 'у легаси-портала ровно один участник');
  assert.deepEqual(result.facts, [], 'чужие письма structure↔workflow не становятся фактами');
  assert.deepEqual(result.links, [], 'чужих связей в новом воркспейсе нет');
  assert.ok(!JSON.stringify(result.facts.concat(result.links)).includes('structure'), 'чужих меток нет');
});

test('currentLabel находит подпись по пути', () => {
  assert.equal(currentLabel('C:/a/b', { structure: 'C:\\a\\b' }), 'structure');
  assert.equal(currentLabel('C:/a/b', { b: 'C:\\x' }), 'b');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('EXCHANGE TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
