#!/usr/bin/env node
/**
 * Проверка совместимости dsh-project-graph с установленной (или указанной) версией DSH.
 *
 * Что делает:
 *   1) читает версию DSH и утверждения об API, которые плагин реально использует;
 *   2) при --npm <ver> качает пакеты @deepseek-ai/* этой версии и проверяет то же по ним;
 *   3) прогоняет наши проверки и тесты в репозитории;
 *   4) печатает ручной чек-лист (панель, запуск узла, обмен).
 *
 * Запуск:
 *   node tools/check-dsh-compat.mjs                 # установленный DSH
 *   node tools/check-dsh-compat.mjs --npm 0.2.2-rc.1
 *   node tools/check-dsh-compat.mjs --skip-tests --port 51397
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const repo = process.cwd();
const resources = valueOf('--dsh', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources'));
const npmVersion = valueOf('--npm', '');
const port = Number(valueOf('--port', '0'));

const rows = [];
function row(level, name, detail) { rows.push({ level, name, detail }); }
function pass(name, detail = '') { row('PASS', name, detail); }
function fail(name, detail = '') { row('FAIL', name, detail); }
function info(name, detail = '') { row('INFO', name, detail); }

/* ---------- чтение app.asar без зависимостей ---------- */
function openAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(12);
  const header = Buffer.alloc(headerSize);
  fs.readSync(fd, header, 0, headerSize, 16);
  const json = JSON.parse(header.toString('utf8').replace(/\u0000+$/g, ''));
  const dataOffset = 16 + headerSize;
  const entries = new Map();
  const walk = (node, prefix) => {
    for (const [name, nodeValue] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + name : name;
      if (nodeValue.files) walk(nodeValue, p);
      else entries.set(p, { size: nodeValue.size, offset: Number(nodeValue.offset) });
    }
  };
  walk(json, '');
  return {
    list: () => [...entries.keys()],
    exists: (p) => entries.has(p),
    text(p) {
      const entry = entries.get(p);
      if (!entry) return null;
      const buffer = Buffer.alloc(entry.size);
      fs.readSync(fd, buffer, 0, entry.size, dataOffset + entry.offset);
      return buffer.toString('utf8');
    },
    close: () => fs.closeSync(fd),
  };
}

function versionFromExe() {
  const exe = path.join(path.dirname(resources), 'DeepSeek Harness.exe');
  if (!fs.existsSync(exe)) return '';
  const result = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Item "' + exe + '").VersionInfo.FileVersion'], { encoding: 'utf8' });
  return String(result.stdout || '').trim();
}

/* ---------- утверждения об API ---------- */
const NEEDS = [
  {
    name: 'tools: ctx.tools.register(definition)',
    where: 'dsh/node_modules/@deepseek-ai/dsh-tools',
    match: /register\(definition/,
  },
  {
    name: 'tools: ToolDefinition.output обязателен (наши инструменты его объявляют)',
    where: 'dsh/node_modules/@deepseek-ai/dsh-tools',
    match: /readonly output: ToolOutputDefinition/,
    npmOnly: true,
  },
  {
    name: 'tools: ToolDefinition объявлен (установленная сборка без .d.ts)',
    where: 'dsh/node_modules/@deepseek-ai/dsh-tools',
    match: /ToolDefinition/,
    asarOnly: true,
  },
  {
    name: 'llm: listProviders/listModels',
    where: 'dsh/node_modules/@deepseek-ai/dsh-llm',
    match: /listModels|listProviders/,
  },
  {
    name: 'subagent: getProvider + capabilities',
    where: 'dsh/node_modules/@deepseek-ai/dsh-subagent',
    match: /getProvider/,
  },
  {
    name: 'pluginManager: installBundle/listBundles',
    where: 'dsh/node_modules/@deepseek-ai/dsh-plugin-manager',
    match: /installBundle/,
  },
  {
    name: 'web: префиксные маршруты (prefixes)',
    where: 'dsh/node_modules/@deepseek-ai',
    match: /prefixes/,
  },
  {
    name: 'client: слот conversation.view',
    where: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation',
    match: /conversation\.view/,
  },
];

function checkAgainst(readFile, listFiles, label) {
  info('источник API', label);
  const mode = label.startsWith('npm') ? 'npm' : 'asar';
  for (const need of NEEDS) {
    if (need.npmOnly && mode !== 'npm') continue;
    if (need.asarOnly && mode !== 'asar') continue;
    const files = listFiles(need.where);
    if (files.length === 0) { fail(need.name, 'пакет не найден: ' + need.where); continue; }
    let found = false;
    for (const file of files) {
      const text = readFile(file);
      if (text && need.match.test(text)) { found = true; break; }
    }
    if (found) pass(need.name);
    else fail(need.name, 'шаблон ' + need.match + ' не найден в ' + need.where);
  }
}

function checkInstalled() {
  const asarPath = path.join(resources, 'app.asar');
  if (!fs.existsSync(asarPath)) { fail('app.asar', 'не найден: ' + asarPath); return; }
  const exeVersion = versionFromExe();
  const asar = openAsar(asarPath);
  try {
    const pkgText = asar.text('dsh/package.json');
    const dshVersion = pkgText ? (JSON.parse(pkgText).version || '') : '';
    info('версия DSH', (dshVersion || exeVersion || 'неизвестна') + (exeVersion && exeVersion !== dshVersion ? ' (exe ' + exeVersion + ')' : ''));
    const all = asar.list();
    checkAgainst(
      (file) => asar.text(file),
      (prefix) => all.filter((p) => p.startsWith(prefix + '/') && /\.(d\.ts|js)$/.test(p)),
      'app.asar (установленный DSH)',
    );
  } finally {
    asar.close();
  }
}

async function downloadPackages(version) {
  const dir = path.join(repo, '.tmp', 'compat-' + version);
  fs.mkdirSync(dir, { recursive: true });
  const pkgs = ['dsh-tools', 'dsh-llm', 'dsh-subagent', 'dsh-plugin-manager', 'dsh-web', 'dsh-client-ui-conversation'];
  for (const pkg of pkgs) {
    const target = path.join(dir, pkg);
    if (fs.existsSync(path.join(target, 'package', 'package.json'))) continue;
    const url = 'https://registry.npmjs.org/@deepseek-ai%2F' + pkg + '/-/' + pkg + '-' + version + '.tgz';
    const response = await fetch(url);
    if (!response.ok) { fail('npm ' + pkg + '@' + version, 'HTTP ' + response.status); continue; }
    const tgz = path.join(dir, pkg + '.tgz');
    fs.writeFileSync(tgz, Buffer.from(await response.arrayBuffer()));
    fs.mkdirSync(target, { recursive: true });
    const untar = spawnSync('tar', ['-xzf', tgz, '-C', target], { encoding: 'utf8' });
    if (untar.status !== 0) fail('распаковка ' + pkg, String(untar.stderr || '').slice(0, 120));
  }
  return dir;
}

async function checkNpm(version) {
  const dir = await downloadPackages(version);
  info('проверяемая версия', version + ' (npm-пакеты)');
  checkAgainst(
    (file) => fs.readFileSync(file, 'utf8'),
    (prefix) => {
      const aggregate = prefix.endsWith('@deepseek-ai');
      const rel = prefix.replace(/^dsh\/node_modules\/@deepseek-ai\/?/, '');
      const roots = aggregate
        ? fs.readdirSync(dir).map((name) => path.join(dir, name, 'package')).filter((item) => fs.existsSync(item))
        : [path.join(dir, rel, 'package')];
      const root = roots[0];
      if (!root) return [];
      if (aggregate) {
        const collected = [];
        for (const candidate of roots) {
          const walkAggregate = (current) => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
              const full = path.join(current, entry.name);
              if (entry.isDirectory()) walkAggregate(full);
              else if (/\.(d\.ts|js)$/.test(entry.name)) collected.push(full);
            }
          };
          walkAggregate(candidate);
        }
        return collected;
      }
      if (!fs.existsSync(root)) return [];
      const files = [];
      const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(d\.ts|js)$/.test(entry.name)) files.push(full);
        }
      };
      walk(root);
      return files;
    },
    'npm ' + version,
  );
}

/* ---------- наши проверки ---------- */
const CHECK_SUITE = [
  ['0050-direct-models-write', 4],
  ['0052-exchange-warning', 3],
  ['0059-run-activity', 4],
  ['0061-builder-direct-models', 3],
  ['0065-disconnect-idempotent', 3],
  ['0067-models-migration', 4],
];

function runNode(scriptArgs) {
  return spawnSync(process.execPath, scriptArgs, { cwd: repo, encoding: 'utf8' });
}

function checkRepo() {
  const tests = runNode(['tools/test.mjs']);
  if (tests.status === 0) pass('наши тесты: tools/test.mjs', lastLine(tests.stdout));
  else fail('наши тесты: tools/test.mjs', lastLine(tests.stdout + tests.stderr));
  for (const [name, count] of CHECK_SUITE) {
    const file = path.join(repo, 'checks', name + '.mjs');
    if (!fs.existsSync(file)) { fail('проверка ' + name, 'файла нет'); continue; }
    const failed = [];
    for (let index = 1; index <= count; index += 1) {
      const result = runNode([file, 'c' + index]);
      if (result.status !== 0) failed.push('c' + index);
    }
    if (failed.length === 0) pass('проверка ' + name, 'c1..c' + count);
    else fail('проверка ' + name, 'упали: ' + failed.join(', '));
  }
}

function lastLine(text) {
  const lines = String(text || '').trim().split(/\r?\n/u).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 120) : '';
}

/* ---------- ручной чек-лист ---------- */
function manualList() {
  const items = [
    'Панель: вкладка Structure открывается, схема рисуется, узлы на месте.',
    'Карточка узла: селекторы «Провайдер» и «Модель» заполнены из живого каталога.',
    'Сохранение узла с моделью qwen3.8-flash проходит (не «модель не объявлена»).',
    'Запуск узла: project_graph_run по judge отдаёт status ok|error и пишет состояние в журнал.',
    'Активность: во время запуска узел подсвечен «выполняется».',
    'Обмен: /api/exchange отдаёт папки, у неразрешённого участника — предупреждение.',
    'Миграция: node tools/migrate-models.mjs --dry-run → «изменений нет».',
  ];
  for (const item of items) info('ручное', item);
}

/* ---------- HTTP-проба плагина ---------- */
async function probeHttp() {
  if (!port) return;
  const url = 'http://127.0.0.1:' + port + '/project-graph/api/models';
  try {
    const response = await fetch(url, { redirect: 'manual' });
    if (response.status === 401 || response.status === 403) pass('маршрут плагина зарегистрирован', 'HTTP ' + response.status + ' (нужна авторизация — это ожидаемо)');
    else if (response.ok) pass('маршрут плагина зарегистрирован', 'HTTP ' + response.status);
    else fail('маршрут плагина', 'HTTP ' + response.status + ' — плагин мог не загрузиться');
  } catch (error) {
    fail('маршрут плагина', String(error && error.message ? error.message : error).slice(0, 120));
  }
}

/* ---------- запуск ---------- */
const started = Date.now();
info('репозиторий', repo);
info('node', process.version);

if (npmVersion) await checkNpm(npmVersion);
else checkInstalled();

if (!has('--skip-tests')) checkRepo();
await probeHttp();
manualList();

const width = Math.max(...rows.map((item) => item.name.length));
for (const item of rows) {
  console.log(item.level.padEnd(4) + ' ' + item.name.padEnd(width) + (item.detail ? '  ' + item.detail : ''));
}
const failed = rows.filter((item) => item.level === 'FAIL');
console.log('');
console.log('Итог: ' + (failed.length === 0 ? 'совместимость подтверждена' : 'проблем ' + failed.length) + ', ' + Math.round((Date.now() - started) / 1000) + ' с');
process.exit(failed.length === 0 ? 0 : 1);