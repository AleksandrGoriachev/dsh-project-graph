import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { versionsFromTarball, isOutdated, releaseStatus } from '../lib/release.js';

let passed = 0;
const failures = [];
function test(name, body) {
  try { body(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

/** Build a minimal tar with the given files. */
function tar(entries) {
  const blocks = [];
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('000644 ', 100, 'utf8');
    header.write('0000000 ', 108, 'utf8');
    header.write('0000000 ', 116, 'utf8');
    header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 'utf8');
    header.write('00000000000 ', 136, 'utf8');
    header.write('        ', 148, 'utf8');
    header.write('0', 156, 'utf8');
    blocks.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('версии читаются из package.json и vendor/VERSION', () => {
  const gz = tar({
    'package/package.json': JSON.stringify({ name: 'dsh-workflow-console', version: '0.7.1' }),
    'package/vendor/VERSION': '2.6.3\n',
  });
  assert.deepEqual(versionsFromTarball(gz), { plugin: '0.7.1', engine: '2.6.3' });
});

test('отсутствующие файлы дают null, а не выдумку', () => {
  const gz = tar({ 'package/README.md': 'x' });
  assert.deepEqual(versionsFromTarball(gz), { plugin: null, engine: null });
});

test('устаревание сравнивает оба слоя', () => {
  assert.deepEqual(isOutdated({ plugin: '0.7.0', engine: '2.6.2' }, { plugin: '0.7.0', engine: '2.6.2' }), { plugin: false, engine: false });
  assert.deepEqual(isOutdated({ plugin: '0.7.0', engine: '2.6.2' }, { plugin: '0.7.1', engine: '2.6.3' }), { plugin: true, engine: true });
  assert.deepEqual(isOutdated({ plugin: '0.7.0', engine: null }, { plugin: '0.7.0', engine: '2.6.3' }), { plugin: false, engine: false },
    'неизвестная установленная версия не считается устаревшей');
});

test('releaseStatus: package обновляется, когда сборка отстала', () => {
  const status = releaseStatus({ current: '1.0.9', latest: '1.0.10', mode: 'package', publishedAt: '2026-11-06T10:00:00Z' });
  assert.equal(status.current, '1.0.9');
  assert.equal(status.latest, '1.0.10');
  assert.equal(status.outdated, true);
  assert.equal(status.canUpdate, true, 'пакет ставится кнопкой');
  assert.equal(status.publishedAt, '2026-11-06T10:00:00Z');
  assert.equal(status.reason, undefined, 'пакету причина не нужна');
});

test('releaseStatus: актуальная сборка не предлагает обновление', () => {
  const status = releaseStatus({ current: '1.0.10', latest: '1.0.10', mode: 'package' });
  assert.equal(status.outdated, false);
  assert.equal(status.canUpdate, false);
  assert.equal(status.reason, undefined);
});

test('releaseStatus: link не обновляется кнопкой и называет репозиторий', () => {
  const behind = releaseStatus({ current: '1.0.9', latest: '1.0.10', mode: 'link' });
  assert.equal(behind.outdated, true);
  assert.equal(behind.canUpdate, false, 'кнопка не заменяет ссылку на каталог');
  assert.match(behind.reason, /репозитор/u);
  const actual = releaseStatus({ current: '1.0.10', latest: '1.0.10', mode: 'link' });
  assert.equal(actual.outdated, false);
  assert.equal(actual.canUpdate, false);
});

test('releaseStatus: неизвестная версия не считается устаревшей', () => {
  const unknown = releaseStatus({ current: null, latest: '1.0.10', mode: 'package' });
  assert.equal(unknown.outdated, false);
  assert.equal(unknown.canUpdate, false);
  assert.deepEqual(releaseStatus({}), { current: null, latest: null, outdated: false, canUpdate: false });
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  console.error('  ' + (failure.error && failure.error.message ? failure.error.message.split('\n')[0] : String(failure.error)));
}
console.log('RELEASE TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
