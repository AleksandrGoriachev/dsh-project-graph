/**
 * Фид критика (задание 0180): счёт по шапкам писем и записям запусков, а не по
 * одному написанию имени узла. Каждый случай — правило контракта: все написания
 * From, report/delivered из записи запуска, since отсекает старое, окно 24 часа.
 */
import assert from 'node:assert/strict';
import {
  collectCriticFeed, CRITIC_NAMES, FEED_WINDOW_MS, RUN_MATCH_MS,
} from '../lib/critic-feed.js';

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

const NOW = Date.parse('2026-11-09T20:00:00+03:00');
const SINCE = '2026-11-09T00:00:00+03:00';

/** ISO-момент за указанное число минут до NOW (отрицательное — после NOW). */
function ago(minutes) {
  return new Date(NOW - minutes * 60 * 1000).toISOString();
}

function letter(from, at, file, subject) {
  return {
    from,
    at,
    file,
    ...(subject === undefined ? {} : { subject }),
  };
}

await test('0180: все написания From считаются одним автором', async () => {
  const letters = [
    letter('Critic', ago(180), 'threads/critic-report/a.md', 'итог A'),
    letter('critic', ago(120), 'threads/critic-report/b.md', 'итог B'),
    letter('critic-1', ago(60), 'threads/critic-report/c.md', 'итог C'),
    letter('worker', ago(60), 'threads/critic-report/w.md', 'чужое'),
    letter('Critic', ago(30 * 60), 'threads/critic-report/old.md', 'старое'),
  ];
  const feed = collectCriticFeed({ letters, runs: [], since: SINCE, now: NOW });
  assert.equal(feed.total, 3, 'три написания — три письма в окне');
  assert.deepEqual(feed.byFrom, { Critic: 1, critic: 1, 'critic-1': 1 });
  assert.deepEqual(feed.items.map((item) => item.from), ['critic-1', 'critic', 'Critic'], 'новые первыми');
  assert.equal(feed.items[0].at, ago(60), 'at нормализован в ISO');
  assert.equal(feed.items[0].subject, 'итог C');
  assert.equal(feed.items.some((item) => item.from === 'worker'), false, 'чужая подпись не в фиде');
});

await test('0180: регистр не важен, byFrom хранит исходное написание', async () => {
  const letters = [letter('CRITIC-1', ago(60), 'threads/critic-report/upper.md', 'итог')];
  const feed = collectCriticFeed({ letters, runs: [], since: SINCE, now: NOW });
  assert.equal(feed.total, 1);
  assert.deepEqual(feed.byFrom, { 'CRITIC-1': 1 }, 'ключ — как написано в письме');
});

await test('0180: похожие, но не объявленные подписи не считаются критиком', async () => {
  const letters = [
    letter('critic-2', ago(60), 'threads/critic-report/2.md', 'не тот'),
    letter('not-critic', ago(60), 'threads/critic-report/n.md', 'не тот'),
    letter('критик', ago(60), 'threads/critic-report/k.md', 'не тот'),
  ];
  const feed = collectCriticFeed({ letters, runs: [], since: SINCE, now: NOW });
  assert.equal(feed.total, 0);
  assert.deepEqual(feed.items, []);
  assert.deepEqual(CRITIC_NAMES, ['critic', 'critic-1'], 'объявленные написания');
});

await test('0180: report и delivered берутся из записи запуска', async () => {
  const letters = [
    letter('Critic', ago(300), 'threads/critic-report/a.md', 'A'),
    letter('critic', ago(180), 'threads/critic-report/b.md', 'B'),
  ];
  const runs = [
    {
      node: 'critic',
      at: ago(290),
      report: 'docs/critic/2026-11-09-a.md',
      delivered: 'threads/critic-report/a.md',
      state: 'done',
    },
    { node: 'critic', at: ago(175), report: 'docs/critic/2026-11-09-b.md', state: 'done' },
  ];
  const feed = collectCriticFeed({ letters, runs, since: SINCE, now: NOW });
  const [newest, older] = feed.items;
  assert.equal(newest.file, 'threads/critic-report/b.md');
  assert.equal(newest.report, 'docs/critic/2026-11-09-b.md');
  assert.equal(Object.hasOwn(newest, 'delivered'), false, 'нет delivered — нет поля');
  assert.equal(older.report, 'docs/critic/2026-11-09-a.md');
  assert.equal(older.delivered, 'threads/critic-report/a.md', 'доставка — путь из записи');
});

await test('0180: из двух записей в окне берётся ближайшая по времени', async () => {
  const letters = [letter('Critic', ago(300), 'threads/critic-report/a.md', 'A')];
  const runs = [
    { node: 'critic', at: ago(350), report: 'docs/critic/дальше.md' },
    { node: 'critic', at: ago(290), report: 'docs/critic/ближе.md' },
  ];
  const feed = collectCriticFeed({ letters, runs, since: SINCE, now: NOW });
  assert.equal(feed.items[0].report, 'docs/critic/ближе.md');
});

await test('0180: запись за пределами часа report не даёт', async () => {
  const letters = [letter('Critic', ago(300), 'threads/critic-report/a.md', 'A')];
  const before = collectCriticFeed({
    letters,
    runs: [{ node: 'critic', at: ago(300 + 61), report: 'docs/critic/рано.md' }],
    since: SINCE,
    now: NOW,
  });
  assert.equal(Object.hasOwn(before.items[0], 'report'), false, 'за 61 минуту до письма — мимо');
  const after = collectCriticFeed({
    letters,
    runs: [{ node: 'critic', at: ago(300 - 61), report: 'docs/critic/поздно.md' }],
    since: SINCE,
    now: NOW,
  });
  assert.equal(Object.hasOwn(after.items[0], 'report'), false, 'через 61 минуту после — мимо');
  assert.equal(RUN_MATCH_MS, 60 * 60 * 1000, 'окно сверки — час');
});

await test('0180: запуск чужого узла не отдаёт свой report письму критика', async () => {
  const letters = [letter('critic', ago(120), 'threads/critic-report/a.md', 'A')];
  const runs = [{ node: 'worker', at: ago(115), report: 'docs/worker/report.json' }];
  const feed = collectCriticFeed({ letters, runs, since: SINCE, now: NOW });
  assert.equal(Object.hasOwn(feed.items[0], 'report'), false);
});

await test('0180: since отсекает старые письма', async () => {
  const letters = [
    letter('Critic', '2026-11-08T23:00:00+03:00', 'threads/critic-report/old.md', 'старое'),
    letter('Critic', '2026-11-09T01:00:00+03:00', 'threads/critic-report/new.md', 'новое'),
  ];
  const feed = collectCriticFeed({ letters, runs: [], since: SINCE, now: NOW });
  assert.equal(feed.total, 1);
  assert.equal(feed.items[0].file, 'threads/critic-report/new.md');
  assert.deepEqual(feed.byFrom, { Critic: 1 });
});

await test('0180: без since окно — 24 часа, фид не шире суток', async () => {
  const letters = [
    letter('critic', ago(23 * 60), 'threads/critic-report/fresh.md', 'свежее'),
    letter('critic', ago(25 * 60), 'threads/critic-report/stale.md', 'старое'),
  ];
  const feed = collectCriticFeed({ letters, runs: [], now: NOW });
  assert.equal(feed.total, 1);
  assert.equal(feed.items[0].file, 'threads/critic-report/fresh.md');
  assert.equal(FEED_WINDOW_MS, 24 * 60 * 60 * 1000);
  /* since старше суток не раздвигает окно: фид по-прежнему за 24 часа. */
  const wide = collectCriticFeed({
    letters,
    runs: [],
    since: '2025-01-01T00:00:00+03:00',
    now: NOW,
  });
  assert.equal(wide.total, 1, 'since только сужает окно');
});

await test('0180: now — верхняя граница окна', async () => {
  const letters = [letter('critic', ago(-1), 'threads/critic-report/future.md', 'будущее')];
  const feed = collectCriticFeed({ letters, runs: [], since: SINCE, now: NOW });
  assert.equal(feed.total, 0);
  const withDate = collectCriticFeed({
    letters: [letter('critic', ago(60), 'threads/critic-report/a.md', 'A')],
    runs: [],
    since: SINCE,
    now: new Date(NOW),
  });
  assert.equal(withDate.total, 1, 'Date вместо ISO тоже принимается');
});

await test('0180: запись стора (since, без at) тоже сверяется по времени', async () => {
  const letters = [letter('Critic', ago(300), 'threads/critic-report/a.md', 'A')];
  const runs = [{
    node: 'critic',
    since: NOW - 295 * 60 * 1000,
    state: 'done',
    report: 'docs/critic/2026-11-09.md',
    delivered: 'threads/critic-report/a.md',
  }];
  const feed = collectCriticFeed({ letters, runs, since: SINCE, now: NOW });
  assert.equal(feed.items[0].report, 'docs/critic/2026-11-09.md');
  assert.equal(feed.items[0].delivered, 'threads/critic-report/a.md');
});

await test('0180: пустые и битые входы не ломают фид', async () => {
  const empty = collectCriticFeed();
  assert.deepEqual(empty, { total: 0, byFrom: {}, items: [] });
  const broken = collectCriticFeed({
    letters: [
      null,
      { from: 'critic' },
      letter('critic', 'не время', 'threads/critic-report/bad.md', 'битое'),
      letter('critic', ago(60), 'threads/critic-report/ok.md', 'целое'),
    ],
    runs: [null, { node: 'critic' }, { node: 'critic', at: 'не время', report: 'x' }],
    since: SINCE,
    now: NOW,
  });
  assert.equal(broken.total, 1, 'без времени письмо не считается');
  assert.equal(broken.items[0].file, 'threads/critic-report/ok.md');
  assert.equal(Object.hasOwn(broken.items[0], 'report'), false, 'битая запись не даёт report');
});

await test('0180: одно расстояние — выигрывает запись с report', async () => {
  const letters = [letter('critic', ago(300), 'threads/critic-report/a.md', 'A')];
  const runs = [
    { node: 'critic', at: ago(290), state: 'running' },
    { node: 'critic', at: ago(310), report: 'docs/critic/итог.md' },
  ];
  const feed = collectCriticFeed({ letters, runs, since: SINCE, now: NOW });
  assert.equal(feed.items[0].report, 'docs/critic/итог.md');
});

const total = passed + failures.length;
for (const failure of failures) {
  console.error('FAIL ' + failure.name);
  const detail = failure.error && failure.error.message ? failure.error.message : String(failure.error);
  console.error('  ' + detail.split(String.fromCharCode(10)).join(String.fromCharCode(10) + '  '));
}
console.log('CRITIC-FEED TEST ' + (failures.length === 0 ? 'OK' : 'FAILED') + ': ' + passed + '/' + total);
process.exit(failures.length === 0 ? 0 : 1);
