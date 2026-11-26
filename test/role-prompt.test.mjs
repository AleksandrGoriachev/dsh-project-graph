/**
 * Задание 0369 — промпты ролей: порядок действий вместо разведки.
 *
 * Проверяется текст шаблонов (без запуска агентов) и CLI tools/role-prompt.mjs:
 * номерной порядок с работой первым пунктом, запрет коммита и пуша, требование
 * абсолютных путей, ограничение разведки у исполнителя, коды 0 и 2.
 * Реальные задания тест не читает: каталог для --task — вымышленный.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rolePrompt, roleNames, roleSpec } from '../lib/prompts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOOL = path.join(REPO, 'tools', 'role-prompt.mjs');
const ROLES = ['worker', 'reviewer-1', 'judge', 'auditor'];

function cli(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: REPO, encoding: 'utf8' });
}

/** Пункты «1. ...» в том виде, как они попали в готовый промпт. */
function numberedSteps(prompt) {
  return prompt
    .split('\n')
    .filter(function (line) { return /^\d+\. /.test(line); })
    .map(function (line) { return line.replace(/^\d+\. /, ''); });
}

test('roleNames: ровно роли структуры, без дублей', function () {
  assert.deepEqual(roleNames(), ROLES);
  assert.equal(new Set(roleNames()).size, ROLES.length, 'дублей нет');
});

test('каждая роль: номерной порядок, первый пункт — работа, а не разведка', function () {
  for (const role of ROLES) {
    const prompt = rolePrompt(role);
    const spec = roleSpec(role);
    assert.ok(prompt.includes('ПОРЯДОК ДЕЙСТВИЙ:'), role + ': нет блока порядка');
    assert.ok(spec.order.length >= 4, role + ': в порядке меньше четырёх пунктов');
    assert.match(spec.order[0], /^Начни работу/, role + ': первый пункт — не работа');
    assert.doesNotMatch(spec.order[0], /^(Прочитай|Изучи|Осмотрись|Сначала прочитай)/i, role + ': первый пункт — чтение');
    const steps = numberedSteps(prompt);
    assert.equal(steps.length, spec.order.length, role + ': номерных пунктов не столько, сколько в шаблоне');
    assert.match(steps[0], /^Начни работу/, role + ': в тексте первым идёт не работа');
    assert.ok(prompt.includes('ФОРМА ОТЧЁТА:'), role + ': нет формы отчёта');
  }
});

test('каждая роль: запрет коммита и пуша, требование абсолютных путей', function () {
  for (const role of ROLES) {
    const prompt = rolePrompt(role);
    assert.match(prompt, /Нельзя коммитить/, role + ': нет запрета коммита');
    assert.match(prompt, /git commit/, role + ': нет git commit');
    assert.match(prompt, /git push/, role + ': нет git push');
    assert.match(prompt, /--no-verify/, role + ': нет запрета --no-verify');
    assert.match(prompt, /вне разрешённых путей/, role + ': нет границы путей');
    assert.match(prompt, /чужие каталоги заданий/, role + ': нет запрета чужих заданий');
    assert.match(prompt, /абсолютные/i, role + ': нет требования абсолютных путей');
    assert.match(prompt, /write\/edit/, role + ': пути не привязаны к write/edit');
  }
});

test('исполнитель: порядок «контракт → файлы → письмо → критерии → отчёт» и лимит разведки', function () {
  const prompt = rolePrompt('worker');
  const spec = roleSpec('worker');
  assert.match(prompt, /не больше трёх/, 'нет лимита разведки');
  assert.match(prompt, /поиском по строкам/, 'нет поиска по строкам');
  assert.ok(spec.order[0].includes('task.md'), 'первый пункт — контракт');
  assert.ok(spec.order[0].includes('criteria.json'), 'первый пункт — критерии');
  assert.match(spec.order[1], /существу/, 'второй пункт — какие файлы уже есть');
  assert.match(spec.order[2], /писать/, 'третий пункт — начать писать');
  assert.match(prompt, /Команды: каждая проверка и её exit код/, 'в отчёте команды и коды');
});

test('шаблоны не зависят от времени и машины', function () {
  assert.equal(rolePrompt('worker'), rolePrompt('worker'), 'текст детерминирован');
  assert.doesNotMatch(rolePrompt('worker'), /20\d\d-\d\d-\d\d/, 'нет дат');
  const task = '/abs/docs/tasks/0000';
  const withTask = rolePrompt('reviewer-1', { task });
  assert.ok(withTask.includes(task), 'каталог задания подставлен');
  assert.equal(withTask, rolePrompt('reviewer-1', { task }), 'с каталогом текст тоже детерминирован');
});

test('неизвестная и пустая роль — ошибка UNKNOWN_ROLE', function () {
  for (const bad of ['nope', 'reviewer', '', '   ', undefined, null, 42]) {
    assert.throws(
      function () { rolePrompt(bad); },
      function (error) {
        assert.equal(error.code, 'UNKNOWN_ROLE');
        assert.match(error.message, /неизвестная роль/);
        assert.ok(error.message.includes('worker'), 'в ошибке перечислены роли');
        return true;
      },
      'роль ' + String(bad) + ' должна падать',
    );
    assert.throws(function () { roleSpec(bad); }, /неизвестная роль/);
  }
});

test('CLI: --role worker печатает промпт, код 0, текст совпадает с rolePrompt', function () {
  const result = cli(['--role', 'worker']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /узел worker/);
  assert.match(result.stdout, /ПОРЯДОК ДЕЙСТВИЙ:/);
  assert.equal(result.stdout, rolePrompt('worker'), 'CLI печатает шаблон без правок');
});

test('CLI: --json отдаёт объект с ролью, порядком и границами', function () {
  const result = cli(['--role', 'judge', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.role, 'judge');
  assert.equal(payload.title, 'приёмщик');
  assert.ok(Array.isArray(payload.order) && payload.order.length >= 4, 'order — непустой массив');
  assert.ok(Array.isArray(payload.bounds) && payload.bounds.length >= 2, 'bounds — непустой массив');
  assert.ok(Array.isArray(payload.report) && payload.report.length >= 2, 'report — непустой массив');
  assert.equal(payload.task, null, 'без --task каталога нет');
  assert.match(payload.prompt, /ПОРЯДОК ДЕЙСТВИЙ:/);
});

test('CLI: --task подставляется абсолютным путём', function () {
  const result = cli(['--role', 'auditor', '--json', '--task', 'docs/tasks/0000']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.task, path.resolve(REPO, 'docs/tasks/0000'));
  assert.ok(path.isAbsolute(payload.task), 'каталог задания абсолютный');
  assert.ok(payload.prompt.includes(payload.task), 'промпт содержит абсолютный путь');
  const text = cli(['--role', 'worker', '--task', 'docs/tasks/0000']);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes(payload.task), 'в тексте тоже абсолютный путь');
});

test('CLI: неизвестная роль, пустой аргумент и лишний флаг — код 2', function () {
  const cases = [
    [['--role', 'nope'], 'неизвестная роль'],
    [['--role', ''], 'пустой --role'],
    [[], 'без аргументов'],
    [['--role'], '--role без значения'],
    [['--json', '--role', 'nope'], '--json и неизвестная роль'],
    [['--role', 'worker', '--nope'], 'лишний флаг'],
    [['--role', 'worker', '--task', ''], 'пустой --task'],
  ];
  for (const [args, label] of cases) {
    const result = cli(args);
    assert.equal(result.status, 2, label + ': ожидался код 2, stderr: ' + result.stderr);
    assert.notEqual(result.stderr, '', label + ': причина в stderr');
  }
});

test('CLI: --help — код 0 и список ролей', function () {
  const result = cli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const role of ROLES) assert.ok(result.stdout.includes(role), 'в справке есть ' + role);
});
