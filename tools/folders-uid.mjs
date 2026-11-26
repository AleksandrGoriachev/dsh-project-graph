#!/usr/bin/env node
/**
 * 0223: идемпотентная миграция uid папок обмена.
 *
 * Для каждой папки без uid генерирует UUID v4 и пишет обратно в structure/graph.json.
 * Существующий uid НИКОГДА не перегенерируется (повторный запуск ничего не меняет).
 *
 *   node tools/folders-uid.mjs [--root <dir>] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(value('--root') || process.cwd());
const dry = argv.includes('--dry-run');
const file = path.join(root, 'structure', 'graph.json');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

if (!fs.existsSync(file)) { console.error('нет ' + file); process.exit(2); }
const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
const folders = Array.isArray(graph.folders) ? graph.folders : [];
let changed = 0;
const rows = [];
for (const folder of folders) {
  if (!folder || typeof folder !== 'object') continue;
  const uid = typeof folder.uid === 'string' ? folder.uid.trim() : '';
  if (uid !== '' && UUID_V4.test(uid)) { rows.push([folder.id, uid, 'keep']); continue; }
  const next = crypto.randomUUID();
  folder.uid = next;
  changed += 1;
  rows.push([folder.id, next, 'new']);
}
if (!dry && changed > 0) fs.writeFileSync(file, JSON.stringify(graph, null, 2) + '\n', 'utf8');
for (const [id, uid, state] of rows) console.log(state.padEnd(5) + ' ' + String(id).padEnd(10) + ' ' + uid);
console.log('changed=' + changed + (dry ? ' (dry-run)' : ''));