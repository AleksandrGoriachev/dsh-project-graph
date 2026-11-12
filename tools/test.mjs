#!/usr/bin/env node
/**
 * Runs every *.test.mjs in test/ in one process each and reports the totals.
 *
 * The suites are plain node scripts that print their own summary and exit
 * non-zero on failure; this runner only collects and aggregates them.
 *
 * Ночной регресс (0207): ночной путь вызывается ЯВНЫМ флагом извне; без флага
 * регресс не запускается. Расписание/ночную задачу этот инструмент не создаёт
 * (B4: решение и создание — у владельца по согласованию с workflow):
 *   node tools/test.mjs --nightly        # наборы + task-regress (ночной путь)
 *   node tools/test.mjs --regress        # то же, явный алиас
 *   node tools/test.mjs --regress-only   # только task-regress
 *   --repo <dir> / --regress-dir <dir>   корень репозитория (по умолчанию cwd)
 *
 * Известный долг — docs/tasks/0207/regress.allowlist.json:
 *   entries[]  задача+критерии для task-regress;
 *   suites[]   файл набора + имена известных падающих тестов.
 * Провал вне allowlist валит прогон; просроченный reviewBy тоже валит.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node tools/test.mjs [--nightly|--regress] [--regress-only] [--repo <dir>] [--timeout <ms>]');
  console.log('  (без флага)     только наборы; регресс не запускается');
  console.log('  --nightly       ночной путь: наборы + task-regress (явный флаг)');
  console.log('  --regress       то же, явный алиас');
  console.log('  --regress-only  только task-regress, без наборов');
  process.exit(0);
}
function argValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
}
const regressOnly = args.includes('--regress-only');
/* B4 (0207): ночной путь — только явный флаг; без флага regress не зовётся. */
const withRegress = regressOnly || args.includes('--regress') || args.includes('--nightly');
const repoRoot = path.resolve(argValue('--repo') || argValue('--regress-dir') || process.cwd());
const criterionTimeout = Number(argValue('--timeout')) || 300000;

function findAllowlistPath(root) {
  const fromEnv = typeof process.env.TASK_REGRESS_ALLOWLIST === 'string' ? process.env.TASK_REGRESS_ALLOWLIST.trim() : '';
  if (fromEnv !== '') return path.resolve(root, fromEnv);
  const tasksDir = path.join(root, 'docs', 'tasks');
  const preferred = path.join(tasksDir, '0207', 'regress.allowlist.json');
  if (fs.existsSync(preferred)) return preferred;
  let names = [];
  try {
    names = fs.readdirSync(tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch { names = []; }
  for (const name of names) {
    const file = path.join(tasksDir, name, 'regress.allowlist.json');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function readAllowlist(root) {
  const file = findAllowlistPath(root);
  if (!file || !fs.existsSync(file)) return { file: null, entries: [], suites: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
    return {
      file,
      entries: Array.isArray(raw && raw.entries) ? raw.entries : [],
      suites: Array.isArray(raw && raw.suites) ? raw.suites : [],
    };
  } catch (error) {
    console.error('ALLOWLIST: не читается ' + file + ': ' + error.message);
    return { file: null, entries: [], suites: [] };
  }
}

const allowlist = readAllowlist(repoRoot);

function failureNames(output) {
  const names = [];
  for (const line of String(output || '').split(/\r?\n/u)) {
    const match = line.match(/^(?:not ok|FAIL)(?::[ \t]*|[ \t]+)(.+?)\s*$/u);
    if (match && match[1]) names.push(match[1]);
  }
  return names;
}

function suiteRule(fileName, names) {
  if (!allowlist.file || names.length === 0) return null;
  const entry = allowlist.suites.find((item) => item && String(item.file) === fileName);
  if (!entry) return null;
  const tests = Array.isArray(entry.tests) ? entry.tests.map(String) : [];
  if (tests.length === 0) return null;
  const reviewBy = entry.reviewBy || entry.until || null;
  const expired = Boolean(reviewBy) && !Number.isNaN(Date.parse(reviewBy)) && Date.parse(reviewBy) < Date.now();
  if (expired) return { expired: true, reviewBy };
  const unknown = names.filter((name) => !tests.some((allowed) => name === allowed || name.startsWith(allowed)));
  if (unknown.length > 0) return { unknown, reviewBy };
  return { allowed: names, reviewBy, reason: entry.reason || '' };
}

/*
 * The run store writes each project's records to disk. A suite must never touch
 * the real profile directory, so every child gets a scratch store.
 */
let failed = 0;
let knownDebts = 0;
const files = regressOnly ? [] : fs.readdirSync(path.join(here, '..', 'test')).filter((name) => name.endsWith('.test.mjs')).sort();

if (!regressOnly) {
  /*
   * Синтаксис библиотек проверяется до наборов: сломанный lib/*.js гасит панель целиком,
   * а наборы этого не видят — они вытаскивают функции из исходника по кускам.
   */
  const libDir = path.join(here, '..', 'lib');
  for (const name of fs.readdirSync(libDir).filter((entry) => entry.endsWith('.js')).sort()) {
    const check = spawnSync(process.execPath, ['--check', path.join(libDir, name)], { encoding: 'utf8' });
    if (check.status !== 0) {
      const line = ((check.stderr || '').split('\n').find((text) => text.trim()) || '').trim();
      console.error('SYNTAX ' + name + ': ' + line);
      failed += 1;
    }
  }
  for (const name of files) {
    /*
     * One scratch run store per suite. A shared folder made suites collide: RUNS creates a
     * 'blocked' directory there and an unrelated suite then reads a half-written record —
     * the intermittent API/LIVE failures of 2026-11-01 that were impossible to reproduce.
     */
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-runs-'));
    const result = spawnSync(process.execPath, [path.join(here, '..', 'test', name)], { encoding: 'utf8', env: { ...process.env, PG_RUNS_DIR: runsDir } });
    const output = ((result.stdout || '') + (result.stderr || '')).trim();
    if (output) console.log(output);
    if (result.status !== 0) {
      const names = failureNames(output);
      const rule = suiteRule(name, names);
      if (rule && rule.allowed) {
        knownDebts += rule.allowed.length;
        console.log('KNOWN ' + name + ': ' + rule.allowed.length + ' известных провалов (allowlist до ' + (rule.reviewBy || '—') + ')');
      } else {
        if (rule && rule.expired) console.error('ALLOWLIST EXPIRED ' + name + ': reviewBy ' + rule.reviewBy);
        if (rule && rule.unknown) console.error('UNKNOWN FAILURE ' + name + ': ' + rule.unknown.join('; '));
        failed += 1;
      }
    }
  }
  console.log(failed === 0
    ? 'TESTS OK: ' + files.length + ' файлов' + (knownDebts > 0 ? ' (' + knownDebts + ' известных провалов по allowlist)' : '')
    : 'TESTS FAILED: ' + failed + ' из ' + files.length);
}

function runRegress() {
  const script = path.join(repoRoot, 'docs', 'subagent-workflow', 'scripts', 'task-regress.mjs');
  if (!fs.existsSync(script)) {
    console.error('REGRESS FAILED: нет ' + script);
    return 1;
  }
  const outFile = path.join(os.tmpdir(), 'pg-nightly-regress-' + process.pid + '-' + Date.now() + '.json');
  const result = spawnSync(process.execPath, [
    script, '--repo', repoRoot, '--out', outFile, '--timeout', String(criterionTimeout),
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, TASK_RUN: 'nightly' },
  });
  let report = null;
  try { if (fs.existsSync(outFile)) report = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { report = null; }
  try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
  if (!report) {
    const tail = ((result.stderr || '') + '\n' + (result.stdout || '')).trim().slice(-2000);
    console.error('REGRESS FAILED: task-regress не дал отчёт (exit=' + result.status + '): ' + tail);
    return 1;
  }
  const tasks = Array.isArray(report.tasks) ? report.tasks : [];
  const failing = tasks.filter((item) => {
    const status = String(item.status);
    if (status === 'allowed' || status === 'baselined') return false;
    return (Array.isArray(item.failedIds) && item.failedIds.length > 0)
      || ['regressed', 'error', 'untrusted', 'unproven-violation'].includes(status);
  });
  const executed = tasks.reduce((sum, item) => sum + Number(item.executed || 0), 0);
  const allowed = tasks.reduce((sum, item) => sum + (Array.isArray(item.allowedIds) ? item.allowedIds.length : 0), 0);
  if (result.status === 0 && failing.length === 0) {
    console.log('REGRESS OK: ' + tasks.length + ' задач, ' + executed + ' критериев'
      + (allowed > 0 ? ' (' + allowed + ' известных провалов по allowlist)' : ''));
    return 0;
  }
  const criteria = failing.reduce((sum, item) => sum + (Array.isArray(item.failedIds) ? item.failedIds.length : 0), 0);
  console.error('REGRESS FAILED: ' + failing.length + ' задач(и), ' + criteria + ' критериев');
  for (const item of failing) {
    const ids = Array.isArray(item.failedIds) ? item.failedIds.join(', ') : '';
    console.error('  ' + item.task + ': ' + (ids || item.reason || item.status));
  }
  if (report.allowlist) console.error('  allowlist: ' + report.allowlist.file + ' (записей ' + report.allowlist.entries + ')');
  return 1;
}

let regressCode = 0;
if (withRegress) regressCode = runRegress();
if (regressOnly) process.exit(regressCode);
process.exit(failed === 0 && regressCode === 0 ? 0 : 1);
