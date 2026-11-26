/**
 * Задание 0370 — режим --release инструмента публикации.
 *
 * Проверяются чистые функции (разбор токена из окружения и хранилища git,
 * имя ассета по версии, сверка размера, тело запроса релиза, разбор удалённого
 * репозитория) и поведение режима целиком на стабе сети: настоящий GitHub не
 * вызывается, настоящий pnpm pack не запускается. Отдельно проверяется CLI:
 * без подготовленного staging — отказ с причиной, неизвестный флаг — код 2.
 * Настоящая публикация не запускается, в сеть тест не ходит.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as publish from '../tools/publish-public.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOOL = path.join(REPO, 'tools', 'publish-public.mjs');
const REMOTE = 'https://github.com/example-owner/example-repo';
/* Токен собирается из частей: исходник не должен читаться как настоящий секрет. */
const TOKEN = 'ghp_' + 'a'.repeat(30);
const ARCHIVE_SIZE = 1234;
const RELEASE_ID = 777;

const scratch = [];
const tests = [];
let passed = 0;
const failures = [];

function test(name, body) {
  tests.push({ name, body });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Собранный staging: .git с отметкой сборки и package.json публикуемого пакета. */
function stagingFixture(version = '1.2.3', packageName = 'dsh-project-graph') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0370-stage-'));
  scratch.push(root);
  writeJson(path.join(root, 'package.json'), { name: packageName, version });
  writeJson(path.join(root, '.git', 'publish-public.json'), {
    tool: 'tools/publish-public.mjs',
    version,
    remote: REMOTE,
    builtAt: '2026-11-26T20:00:00+03:00',
  });
  return { root, version, packageName };
}

/** Архив-ассет известного размера: сверка идёт с фактическим файлом. */
function archiveFixture(name, size = ARCHIVE_SIZE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-0370-asset-'));
  scratch.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  return { file, name, size, dir: null };
}

/**
 * Стаб сети: API релиза, загрузка ассета и скачивание. Запросы записываются,
 * тело релиза и тело ассета сохраняются для проверок.
 */
function networkStub(options = {}) {
  const calls = [];
  const state = { releaseBody: null, uploadBody: null, uploadUrl: null };
  const downloadBytes = options.downloadBytes === undefined ? ARCHIVE_SIZE : options.downloadBytes;
  const downloadStatus = options.downloadStatus === undefined ? 200 : options.downloadStatus;
  const request = async (method, url, requestOptions = {}) => {
    calls.push({ method, url, options: requestOptions });
    if (method === 'GET' && url.includes('/releases/tags/')) {
      if (options.release) return { status: 200, text: JSON.stringify(options.release), byteLength: NaN };
      return { status: 404, text: JSON.stringify({ message: 'Not Found' }), byteLength: NaN };
    }
    if (method === 'POST' && /\/releases$/u.test(url)) {
      state.releaseBody = JSON.parse(String(requestOptions.body));
      return { status: 201, text: JSON.stringify({ id: RELEASE_ID, assets: [] }), byteLength: NaN };
    }
    if (method === 'POST' && url.includes('/assets?name=')) {
      state.uploadBody = requestOptions.body;
      state.uploadUrl = url;
      const name = decodeURIComponent(url.split('name=')[1]);
      return {
        status: 201,
        text: JSON.stringify({
          id: 55,
          name,
          size: options.uploadSize === undefined ? ARCHIVE_SIZE : options.uploadSize,
          browser_download_url: 'https://example.test/download/' + name,
        }),
        byteLength: NaN,
      };
    }
    if (method === 'GET' && url.startsWith('https://example.test/')) {
      return { status: downloadStatus, text: '', byteLength: downloadBytes };
    }
    throw new Error('стаб сети не ждал запроса: ' + method + ' ' + url);
  };
  return { request, calls, state };
}

/** Прогон publishRelease со стабами; отказ возвращается, а не валит тест. */
async function runRelease(fixture, network, options = {}) {
  const log = [];
  const archive = options.archive || archiveFixture(publish.assetNameFor(fixture.version, fixture.packageName));
  const settings = { out: fixture.root, remote: options.remote || REMOTE, yes: options.yes !== false };
  const packCalls = [];
  const deps = {
    env: options.env === undefined ? { GH_TOKEN: TOKEN } : options.env,
    credentialsText: options.credentialsText === undefined ? '' : options.credentialsText,
    pack: async (requested) => {
      packCalls.push(requested);
      return archive;
    },
    request: network.request,
    log: (line) => log.push(line),
  };
  let result = null;
  let error = null;
  try {
    result = await publish.publishRelease(settings, deps);
  } catch (caught) {
    error = caught;
  }
  return { result, error, log, text: log.join('\n'), calls: network.calls, network, packCalls, archive, settings };
}

/** Ожидаемый отказ: иначе тест падает с понятным сообщением. */
async function refusalOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'ожидался отказ, а вызов завершился успехом' });
}

function spawnTool(args, cwd = REPO) {
  const result = spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    code: result.status === null ? 1 : result.status,
    out: String(result.stdout || '') + String(result.stderr || ''),
  };
}

function missingStaging() {
  return path.join(os.tmpdir(), 'pg-0370-missing-' + process.pid + '-' + Math.random().toString(16).slice(2, 8));
}

/* ---------- чистые функции ---------- */

test('токен из окружения: GH_TOKEN главнее GITHUB_TOKEN, пустое не считается', () => {
  assert.deepEqual(publish.tokenFromEnvironment({ GH_TOKEN: 'one', GITHUB_TOKEN: 'two' }), { token: 'one', source: 'GH_TOKEN' });
  assert.deepEqual(publish.tokenFromEnvironment({ GITHUB_TOKEN: ' two ' }), { token: 'two', source: 'GITHUB_TOKEN' });
  assert.deepEqual(publish.tokenFromEnvironment({ GH_TOKEN: '   ', GITHUB_TOKEN: 'two' }), { token: 'two', source: 'GITHUB_TOKEN' });
  assert.equal(publish.tokenFromEnvironment({ GH_TOKEN: '  ', GITHUB_TOKEN: '' }), null);
  assert.equal(publish.tokenFromEnvironment({}), null);
});

test('токен из хранилища git: строка с портом, слэшем и чужим хостом', () => {
  const store = [
    '# комментарий',
    'https://gitlab-user:gitlab-token@gitlab.com',
    'https://octocat:' + TOKEN + '@github.com',
    '',
  ].join('\n');
  const found = publish.tokenFromStore(store);
  assert.ok(found, 'токен GitHub из хранилища не разобран');
  assert.equal(found.token, TOKEN);
  assert.equal(found.user, 'octocat');
  assert.equal(found.source, 'store');
  const port = publish.tokenFromStore('https://u:' + TOKEN + '@github.com:443/');
  assert.equal(port && port.token, TOKEN, 'строка с портом и слэшем не разобрана');
  const encoded = publish.tokenFromStore('https://u:tok%2Fen@github.com');
  assert.equal(encoded && encoded.token, 'tok/en', 'токен не URL-декодирован');
  assert.equal(publish.tokenFromStore('https://gitlab-user:secret@gitlab.com'), null);
  assert.equal(publish.tokenFromStore(''), null);
});

test('resolveToken: окружение выигрывает у хранилища, пустое даёт null', () => {
  assert.equal(publish.resolveToken({ GH_TOKEN: 'env-token' }, 'https://u:store-token@github.com').source, 'GH_TOKEN');
  assert.equal(publish.resolveToken({ GH_TOKEN: 'env-token' }, 'https://u:store-token@github.com').token, 'env-token');
  assert.equal(publish.resolveToken({}, 'https://u:store-token@github.com').token, 'store-token');
  assert.equal(publish.resolveToken({}, ''), null);
});

test('имя ассета по версии', () => {
  assert.equal(publish.assetNameFor('1.2.3'), 'dsh-project-graph-1.2.3.tgz');
  assert.equal(publish.assetNameFor('1.2.3', 'dsh-project-graph'), 'dsh-project-graph-1.2.3.tgz');
  assert.equal(publish.assetNameFor('1.2.3', '@scope/pkg'), 'scope-pkg-1.2.3.tgz', 'scoped-пакет не развёрнут');
  assert.match(publish.assetNameFor('1.2.3'), /\.tgz$/u);
});

test('сверка размера', () => {
  assert.equal(publish.sameSize(ARCHIVE_SIZE, ARCHIVE_SIZE), true);
  assert.equal(publish.sameSize(ARCHIVE_SIZE, ARCHIVE_SIZE + 1), false);
  assert.equal(publish.sameSize(ARCHIVE_SIZE + 1, ARCHIVE_SIZE), false);
  assert.equal(publish.sameSize(0, 0), false, 'нулевой размер не доказательство');
  assert.equal(publish.sameSize(NaN, ARCHIVE_SIZE), false);
  assert.equal(publish.sameSize(undefined, ARCHIVE_SIZE), false);
  assert.equal(publish.sameSize(String(ARCHIVE_SIZE), ARCHIVE_SIZE), true, 'числовая строка не сравнена');
});

test('тело релиза и тег', () => {
  const body = publish.releaseBody('1.2.3');
  assert.equal(body.tag_name, 'v1.2.3');
  assert.equal(body.name, 'v1.2.3');
  assert.equal(body.draft, false);
  assert.equal(body.prerelease, false);
  assert.equal(typeof body.body, 'string');
  assert.ok(body.body.includes('1.2.3'), 'в заметках нет версии');
  assert.equal(publish.releaseTag('1.2.3'), 'v1.2.3');
  const withTarget = publish.releaseBody('1.2.3', { target: 'main', notes: 'свои заметки' });
  assert.equal(withTarget.target_commitish, 'main');
  assert.equal(withTarget.body, 'свои заметки');
});

test('owner/repo из удалённого репозитория', () => {
  assert.deepEqual(publish.repositoryFromRemote(REMOTE + '.git'), { owner: 'example-owner', repo: 'example-repo' });
  assert.deepEqual(publish.repositoryFromRemote('git@github.com:example-owner/example-repo.git'), { owner: 'example-owner', repo: 'example-repo' });
  assert.equal(publish.repositoryFromRemote('не URL'), null);
});

test('строка таблицы итога несёт все пять полей', () => {
  const row = publish.releaseTableRow({ tag: 'v1.2.3', releaseId: RELEASE_ID, assetName: 'a.tgz', size: ARCHIVE_SIZE, httpStatus: 200 });
  for (const part of ['v1.2.3', String(RELEASE_ID), 'a.tgz', String(ARCHIVE_SIZE), '200']) {
    assert.ok(row.includes(part), 'в строке таблицы нет ' + part + ': ' + row);
  }
});

/* ---------- поведение режима на стабе сети ---------- */

test('релиз создаётся, ассет загружается, скачивание проверяется', async () => {
  const fixture = stagingFixture();
  const network = networkStub({});
  const run = await runRelease(fixture, network);
  assert.equal(run.error, null, 'релиз отказал: ' + (run.error && run.error.message));
  assert.equal(run.result, 0);
  assert.equal(run.packCalls.length, 1, 'архив пакета не собирался');
  assert.equal(run.packCalls[0].version, '1.2.3');
  assert.equal(run.packCalls[0].out, fixture.root);
  const body = network.state.releaseBody;
  assert.equal(body.tag_name, 'v1.2.3');
  assert.equal(body.name, 'v1.2.3');
  assert.equal(body.draft, false);
  assert.equal(body.prerelease, false);
  assert.ok(Buffer.isBuffer(network.state.uploadBody), 'тело ассета не прочитано');
  assert.equal(network.state.uploadBody.length, ARCHIVE_SIZE);
  assert.match(network.state.uploadUrl, /assets\?name=dsh-project-graph-1\.2\.3\.tgz$/u);
  const uploadCall = run.calls.find((call) => call.method === 'POST' && call.url.includes('/assets?name='));
  assert.equal(uploadCall.options.headers['content-type'], 'application/gzip');
  const download = run.calls.find((call) => call.method === 'GET' && call.url.startsWith('https://example.test/'));
  assert.ok(download, 'скачивание ассета не проверялось');
  assert.equal(download.options.auth, false, 'токен отправлен на скачивание');
  assert.ok(run.text.includes('Итог релиза'), 'итог таблицей не напечатан');
  for (const part of ['v1.2.3', String(RELEASE_ID), 'dsh-project-graph-1.2.3.tgz', String(ARCHIVE_SIZE), '200']) {
    assert.ok(run.text.includes(part), 'в итоге нет ' + part);
  }
  assert.ok(!run.text.includes(TOKEN), 'токен напечатан в выводе');
});

test('существующий релиз с совпадающим ассетом — успех без повторной загрузки', async () => {
  const fixture = stagingFixture();
  const assetName = publish.assetNameFor(fixture.version, fixture.packageName);
  const network = networkStub({
    release: { id: 555, assets: [{ id: 9, name: assetName, size: ARCHIVE_SIZE, browser_download_url: 'https://example.test/download/' + assetName }] },
  });
  const run = await runRelease(fixture, network);
  assert.equal(run.error, null, 'идемпотентный прогон отказал: ' + (run.error && run.error.message));
  assert.equal(run.result, 0);
  assert.equal(run.calls.filter((call) => call.method === 'POST').length, 0, 'ассет загружен повторно');
  assert.ok(run.text.includes('уже существует'), 'не сказано, что релиз уже есть');
  assert.ok(run.text.includes('уже загружен'), 'не сказано, что ассет уже загружен');
  assert.ok(run.text.includes('555'), 'в итоге нет id существующего релиза');
  assert.ok(!run.text.includes(TOKEN), 'токен напечатан в выводе');
});

test('существующий релиз без нужного ассета — дозагружается только он', async () => {
  const fixture = stagingFixture();
  const network = networkStub({ release: { id: 555, assets: [{ id: 3, name: 'other.tgz', size: 5 }] } });
  const run = await runRelease(fixture, network);
  assert.equal(run.error, null, 'дозагрузка отказала: ' + (run.error && run.error.message));
  assert.equal(run.result, 0);
  const posts = run.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1, 'ожидалась ровно одна загрузка ассета');
  assert.ok(posts[0].url.includes('/assets?name='), 'загружен не ассет');
  assert.ok(run.text.includes('Ассет загружен'), 'загрузка не объявлена');
});

test('ассет в релизе с другим размером — отказ с причиной, без загрузки', async () => {
  const fixture = stagingFixture();
  const assetName = publish.assetNameFor(fixture.version, fixture.packageName);
  const network = networkStub({
    release: { id: 555, assets: [{ id: 9, name: assetName, size: 999, browser_download_url: 'https://example.test/download/' + assetName }] },
  });
  const run = await runRelease(fixture, network);
  assert.ok(run.error, 'несовпадение размера не отвергнуто');
  assert.equal(run.error.exitCode, 1);
  assert.match(run.error.message, /размер/u, 'причина не называет размер: ' + run.error.message);
  assert.equal(run.calls.filter((call) => call.method === 'POST').length, 0, 'ассет загружен при несовпадении размера');
});

test('скачивание не 200 — отказ, а не «готово»', async () => {
  const fixture = stagingFixture();
  const network = networkStub({ downloadStatus: 404, downloadBytes: 0 });
  const run = await runRelease(fixture, network);
  assert.ok(run.error, 'HTTP 404 при проверке не отвергнут');
  assert.equal(run.error.exitCode, 1);
  assert.match(run.error.message, /HTTP 404/u, 'код ответа не назван: ' + run.error.message);
  assert.ok(!run.text.includes('Итог релиза'), 'отказ напечатал итог как успех');
});

test('скачанный размер не совпал — отказ с причиной', async () => {
  const fixture = stagingFixture();
  const network = networkStub({ downloadBytes: ARCHIVE_SIZE - 1 });
  const run = await runRelease(fixture, network);
  assert.ok(run.error, 'несовпадение скачанного размера не отвергнуто');
  assert.equal(run.error.exitCode, 1);
  assert.match(run.error.message, /не совпал/u, 'причина не называет расхождение: ' + run.error.message);
});

test('нет токена — отказ с понятным текстом, до сети и сборки', async () => {
  const fixture = stagingFixture();
  const network = networkStub({});
  const run = await runRelease(fixture, network, { env: {}, credentialsText: '' });
  assert.ok(run.error, 'отсутствие токена не отвергнуто');
  assert.equal(run.error.exitCode, 1);
  assert.match(run.error.message, /GH_TOKEN/u, 'отказ не называет GH_TOKEN: ' + run.error.message);
  assert.match(run.error.message, /токен/iu, 'отказ не объясняет, что нужен токен');
  assert.equal(run.calls.length, 0, 'при отсутствии токена был сетевой запрос');
  assert.equal(run.packCalls.length, 0, 'при отсутствии токена собирался архив');
});

test('токен берётся из хранилища git, когда окружение пусто', async () => {
  const fixture = stagingFixture();
  const network = networkStub({});
  const store = 'https://octocat:' + TOKEN + '@github.com' + String.fromCharCode(10);
  const run = await runRelease(fixture, network, { env: {}, credentialsText: store });
  assert.equal(run.error, null, 'токен из хранилища не использован: ' + (run.error && run.error.message));
  assert.equal(run.result, 0);
  assert.ok(run.text.includes('хранилище git'), 'источник токена не назван');
  assert.ok(!run.text.includes(TOKEN), 'токен напечатан в выводе');
});

test('без --yes релиз не создаётся', async () => {
  const fixture = stagingFixture();
  const network = networkStub({});
  const run = await runRelease(fixture, network, { yes: false });
  assert.ok(run.error, 'релиз без --yes прошёл');
  assert.equal(run.error.exitCode, 1);
  assert.match(run.error.message, /--yes/u, 'отказ не требует --yes: ' + run.error.message);
  assert.equal(run.calls.length, 0, 'без подтверждения был сетевой запрос');
  assert.equal(run.packCalls.length, 0, 'без подтверждения собирался архив');
});

test('без собранного staging — отказ с причиной', async () => {
  const missing = missingStaging();
  const error = await refusalOf(publish.publishRelease(
    { out: missing, remote: REMOTE, yes: true },
    { env: { GH_TOKEN: TOKEN }, credentialsText: '', log: () => {} },
  ));
  assert.equal(error.exitCode, 1);
  assert.match(error.message, /--build/u, 'отказ не объясняет, что нужен --build: ' + error.message);
  assert.equal(fs.existsSync(missing), false, 'отказ создал staging');
});

/* ---------- CLI без сети ---------- */

test('CLI: без staging отказывает с причиной', () => {
  const result = spawnTool(['--release', '--yes', '--out', missingStaging()]);
  assert.equal(result.code, 1, 'режим без staging не отвергнут: ' + result.out.slice(0, 400));
  assert.match(result.out, /--build/u, 'причина не называет --build');
});

test('CLI: неизвестный флаг даёт код 2', () => {
  const result = spawnTool(['--release', '--wat']);
  assert.equal(result.code, 2, 'неизвестный флаг не отвергнут кодом 2: ' + result.out.slice(0, 400));
});

test('CLI: --release несовместим с --build', () => {
  const result = spawnTool(['--release', '--build']);
  assert.equal(result.code, 2, 'несовместимость режимов не отвергнута: ' + result.out.slice(0, 400));
});

test('CLI: без --yes на собранном staging отказывает, в сеть не идёт', () => {
  const fixture = stagingFixture();
  const result = spawnTool(['--release', '--out', fixture.root]);
  assert.equal(result.code, 1, 'релиз без --yes прошёл: ' + result.out.slice(0, 400));
  assert.match(result.out, /--yes/u, 'отказ не требует --yes');
});

for (const item of tests) {
  try {
    await item.body();
    passed += 1;
    console.log('ok ' + passed + ' — ' + item.name);
  } catch (error) {
    failures.push({ name: item.name, error });
  }
}

for (const item of failures) {
  console.error('FAIL ' + item.name);
  console.error('  ' + (item.error && item.error.message ? item.error.message.split('\n').slice(0, 6).join('\n  ') : String(item.error)));
}
for (const dir of scratch) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* временный каталог не мешает результату */
  }
}
console.log('PUBLISH-RELEASE TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + (passed + failures.length));
process.exit(failures.length === 0 ? 0 : 1);
