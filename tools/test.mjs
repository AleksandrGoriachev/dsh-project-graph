#!/usr/bin/env node
/**
 * Runs every *.test.mjs in test/ in one process each and reports the totals.
 *
 * The suites are plain node scripts that print their own summary and exit
 * non-zero on failure; this runner only collects and aggregates them.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(here, '..', 'test');
const files = fs.readdirSync(testDir).filter((name) => name.endsWith('.test.mjs')).sort();
/*
 * The run store writes each project's records to disk. A suite must never touch
 * the real profile directory, so every child gets a scratch store.
 */
let failed = 0;
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
  const result = spawnSync(process.execPath, [path.join(testDir, name)], { encoding: 'utf8', env: { ...process.env, PG_RUNS_DIR: runsDir } });
  const output = ((result.stdout || '') + (result.stderr || '')).trim();
  if (output) console.log(output);
  if (result.status !== 0) failed += 1;
}
console.log(failed === 0 ? 'TESTS OK: ' + files.length + ' файлов' : 'TESTS FAILED: ' + failed + ' из ' + files.length);
process.exit(failed === 0 ? 0 : 1);
