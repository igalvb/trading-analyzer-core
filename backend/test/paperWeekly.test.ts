/**
 * The paper test's weekly report (owner 2026-11-06; src/reports/paperWeekly.ts): every account in one table, the week %
 * and since-start math, a late joiner, the trades appendix, the bottom line, and the Saturday-only, once-a-week send.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MemoryTabStore, type TabCell } from '../src/storage/tabStore.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { LOG_TAB, VALUES_TAB, LOG_HEADER, VALUES_HEADER } from '../src/paper/paperLog.ts';
import { LABELS } from '../src/profile/labels.ts';
import {
  buildWeekly, parseValues, parseLog, readWeekly, weeklyCaption, weeklyHtml, weeklyText, weeklyCells, maybeSendPaperWeekly, isWeeklyNight,
  lastFullWeek, weekOf, weekLabel, PAPER_WEEKLY_KEY, QQQ_ROW, LIST_ROW, type WeeklyReport,
} from '../src/reports/paperWeekly.ts';
import { CAPTION_MAX_CHARS } from '../src/notify/policy.ts';
import { runPaperNight } from '../src/paper/paperJob.ts';

const TZ = 'America/New_York';
const TOKEN = ['123456', 'ABCdefGhIJKlmnoPQRstuVWxyz_0123456'].join(':');
const W1 = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const W2 = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
const WEEK = { monday: '2026-11-02', friday: '2026-11-06' };

/** Value of each fake account on day i (0..9 over the two weeks); null = no row that day. */
const ACCOUNTS: ReadonlyArray<{ name: string; group: string; v: (i: number) => number | null; holds?: string }> = [
  { name: 'Turtle', group: 'A original', v: (i) => 100_000 + 1_000 * i, holds: 'AAPL, MSFT' },
  { name: 'Schabacker', group: 'A original', v: (i) => 100_000 - 500 * i },
  { name: 'Engine alone', group: 'A original', v: (i) => 100_000 + (i === 3 ? -8_000 : 200 * i) },
  { name: 'Trend 200', group: 'B your list', v: (i) => 100_000 + 300 * i },
  { name: 'LEAPS Trend 200', group: 'C LEAPS', v: (i) => 100_000 + 2_500 * i },
  { name: 'Everything together', group: 'D everything', v: (i) => 100_000 - 100 * i },
  // Joined late: its first row is Wednesday of the week (the join night, cash only).
  { name: 'James — Pair Rotation', group: "J James's models", v: (i) => (i < 7 ? null : 100_000 + 1_000 * (i - 7)) },
  // Stopped writing rows in the week before (still in the report).
  { name: 'Old account', group: "J James's models", v: (i) => (i < 5 ? 100_000 + 10 * i : null), holds: 'cash' },
  { name: QQQ_ROW, group: '📊 yardstick', v: (i) => 100_000 + 400 * i, holds: 'QQQ' },
  { name: LIST_ROW, group: '📊 yardstick', v: (i) => 100_000 + 250 * i },
  { name: LABELS.holdResearchCore, group: '📊 yardstick', v: (i) => 100_000 + 150 * i },
];

function valuesTab(): TabCell[][] {
  const rows: TabCell[][] = [[...VALUES_HEADER]];
  [...W1, ...W2].forEach((day, i) => {
    for (const a of ACCOUNTS) { const v = a.v(i); if (v != null) rows.push([day, a.name, a.group, v, ((v / 100_000 - 1) * 100).toFixed(1) + '%', a.holds ?? '']); }
  });
  return rows;
}

function logTab(): TabCell[][] {
  const r = (day: string, when: string, acc: string, action: string, stock: string, why: string): TabCell[] => [day, when, acc, action, stock, 10, 100.5, 1005, 0, why, 'models'];
  return [[...LOG_HEADER],
    r('2026-10-29', 'filled', 'Turtle', 'BOUGHT', 'AAPL', 'last week buy'),
    r('2026-11-02', 'filled', 'Turtle', 'BOUGHT', 'MSFT', 'week buy 1'),
    r('2026-11-03', 'filled', 'Turtle', 'SOLD', 'NVDA', 'week sell 1'),
    r('2026-11-04', 'decided at the close', 'Schabacker', 'WILL BUY', 'AMD', 'week decision 1'),
    r('2026-11-05', 'filled', 'James — Pair Rotation', 'BOUGHT', 'QQQ', 'week buy 2'),
    r('2026-11-06', 'filled', 'Schabacker', 'SOLD', 'TSLA', 'week sell 2'),
    r('2026-11-09', 'filled', 'Turtle', 'SOLD', 'MSFT', 'next week sell'),
  ];
}

async function store(): Promise<MemoryTabStore> {
  const s = new MemoryTabStore();
  await s.ensure(VALUES_TAB); await s.write(VALUES_TAB, 1, valuesTab());
  await s.ensure(LOG_TAB); await s.write(LOG_TAB, 1, logTab());
  return s;
}

const report = (): WeeklyReport => buildWeekly(parseValues(valuesTab()), parseLog(logTab()), WEEK) as WeeklyReport;
const acc = (r: WeeklyReport, name: string) => { const a = r.accounts.find((x) => x.account === name); assert.ok(a, name + ' is in the report'); return a!; };
const near = (a: number | null, b: number, msg: string): void => { assert.ok(a != null && Math.abs(a - b) < 1e-9, msg + ': ' + a + ' vs ' + b); };

function fakeTelegram() {
  const calls: Array<{ method: string; name?: string; caption?: string }> = [];
  const fetchImpl = (async (url: string, init: { body: unknown }) => {
    const b = init.body;
    calls.push({ method: url.split('/').pop() as string, ...(b instanceof FormData ? { name: (b.get('document') as File).name, caption: String(b.get('caption')) } : {}) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('paper weekly — the report', () => {
  test('every account appears, grouped (yardsticks last), best since start first within a group', () => {
    const r = report();
    assert.deepEqual(new Set(r.accounts.map((a) => a.account)), new Set(ACCOUNTS.map((a) => a.name)), 'no account left out');
    assert.equal(r.accounts.length, ACCOUNTS.length);
    assert.deepEqual(r.groups, ['A original', 'B your list', 'C LEAPS', 'D everything', "J James's models", '📊 yardstick']);
    assert.deepEqual(r.accounts.filter((a) => a.group === 'A original').map((a) => a.account), ['Turtle', 'Engine alone', 'Schabacker']);
    assert.deepEqual(r.days, W2);
    assert.equal(r.label, '2-6 Nov');
    const text = weeklyText(r);
    if (process.env.SHOW_WEEKLY) console.log(text + '\n' + weeklyCaption(r));
    for (const a of ACCOUNTS) assert.ok(text.includes(a.name), a.name + ' printed');
    const html = weeklyHtml(r);
    for (const a of ACCOUNTS) assert.ok(html.includes(a.name.replace(/'/g, '&#39;')) || html.includes(a.name), a.name + ' in the PDF page');
  });

  test('this week % and since-start %, points against both yardsticks, deepest fall, trades, holds', () => {
    const r = report();
    const t = acc(r, 'Turtle');
    near(t.weekPct, (109_000 / 104_000 - 1) * 100, 'week = last Friday close to this Friday');
    near(t.sincePct, 9, 'since start = against the starting $100,000');
    near(t.vsQqq, 9 - 3.6, 'vs Hold QQQ since start (points)');
    near(t.vsList, 9 - 2.25, 'vs the whole-list yardstick (points)');
    assert.equal(t.value, 109_000);
    assert.equal(t.holds, 'AAPL, MSFT');
    assert.deepEqual([t.buys, t.sells], [1, 1], 'filled buys / sells of the week only');
    const e = acc(r, 'Engine alone');
    near(e.deepestFall, (1 - 92_000 / 100_400) * 100, 'deepest fall from the high');
    const q = acc(r, QQQ_ROW);
    assert.equal(q.yardstick, true);
    assert.equal(q.vsQqq, null, 'a yardstick is not compared with itself');
    assert.equal(weeklyCells(q)[0], '📊 ' + QQQ_ROW);
    assert.equal(r.qqq?.account, QQQ_ROW);
    assert.equal(r.list?.account, LIST_ROW);
    const beat = r.accounts.filter((a) => !a.yardstick && (a.vsQqq ?? -1) > 0 && (a.vsList ?? -1) > 0).map((a) => a.account).sort();
    assert.equal(r.beatBoth.n, beat.length);
    assert.equal(r.beatBoth.m, ACCOUNTS.filter((a) => !a.group.startsWith('📊')).length);
    assert.deepEqual(r.best.map((a) => a.account)[0], 'LEAPS Trend 200');
    assert.equal(r.best.length, 5);
    assert.equal(r.worst.length, 5);
    assert.ok(r.best.every((a) => !a.yardstick) && r.worst.every((a) => !a.yardstick), 'yardsticks are not ranked');
  });

  test('a late joiner: since start from its first row, the yardsticks from its join day', () => {
    const r = report();
    const p = acc(r, 'James — Pair Rotation');
    assert.equal(p.joined, '2026-11-04');
    near(p.sincePct, 2, 'since its start');
    near(p.weekPct, 2, 'joined in the week: against the cash it started with');
    const qqqFromJoin = ((100_000 + 400 * 9) / (100_000 + 400 * 7) - 1) * 100;
    near(p.vsQqq, 2 - qqqFromJoin, 'Hold QQQ over the same days');
    const listFromJoin = ((100_000 + 250 * 9) / (100_000 + 250 * 7) - 1) * 100;
    near(p.vsList, 2 - listFromJoin, 'the list yardstick over the same days');
    const old = acc(r, 'Old account');
    near(old.weekPct, 0, 'no row in the week: unchanged');
    assert.ok(weeklyHtml(r).includes('(from 2026-11-04)'), 'the PDF says when a late account started');
  });

  test('the trades appendix lists every Paper Log row of the week (and none of the weeks around it)', () => {
    const r = report();
    const inWeek = logTab().slice(1).filter((x) => String(x[0]) >= WEEK.monday && String(x[0]) <= WEEK.friday);
    assert.equal(r.trades.length, inWeek.length);
    assert.deepEqual(r.trades.map((t) => t.why), inWeek.map((x) => x[9]));
    const html = weeklyHtml(r);
    for (const x of inWeek) assert.ok(html.includes(String(x[9])), 'appendix row: ' + x[9]);
    assert.ok(!html.includes('next week sell') && !html.includes('last week buy'));
  });

  test('the bottom line: at most 2 lines and CAPTION_MAX_CHARS, with the best, Hold QQQ and the beat-both count', () => {
    const r = report();
    const c = weeklyCaption(r);
    assert.ok(c.startsWith('Paper week 2-6 Nov: best LEAPS Trend 200 +'), c);
    assert.ok(c.includes(QQQ_ROW + ' +'), c);
    assert.ok(c.includes(r.beatBoth.n + ' of ' + r.beatBoth.m + ' beat both'), c);
    const long = { ...r, best: [{ ...r.best[0]!, account: 'A very long account name '.repeat(12) }] };
    for (const x of [c, weeklyCaption(long)]) {
      assert.ok(x.split('\n').length <= 2, 'at most 2 lines');
      assert.ok(x.length <= CAPTION_MAX_CHARS, 'at most ' + CAPTION_MAX_CHARS + ' characters: ' + x.length);
    }
  });

  test('the week: Mon-Fri just ended; labels across a month end; a week with no day is null', () => {
    assert.deepEqual(lastFullWeek('2026-11-07'), WEEK, 'Saturday: the week just ended');
    assert.deepEqual(lastFullWeek('2026-11-08'), WEEK, 'Sunday');
    assert.deepEqual(lastFullWeek('2026-11-09'), WEEK, 'Monday');
    assert.deepEqual(lastFullWeek('2026-11-06'), weekOf('2026-10-30'), 'Friday: the week before (this one is not over)');
    assert.deepEqual(weekOf('2026-11-04'), WEEK);
    assert.equal(weekLabel('2026-10-29', '2026-11-02'), '29 Oct-2 Nov');
    assert.equal(buildWeekly(parseValues(valuesTab()), [], { monday: '2026-11-16', friday: '2026-11-20' }), null);
    const w1 = buildWeekly(parseValues(valuesTab()), parseLog(logTab()), weekOf('2026-10-28'))!;
    assert.ok(!w1.accounts.some((a) => a.account === 'James — Pair Rotation'), 'an account that joined after the week is not in it');
  });
});

describe('paper weekly — on the tabs the paper night writes', () => {
  test('two real paper nights: every account of 📈 Paper Values is in the report, both yardsticks are found', async () => {
    const tabs = new MemoryTabStore();
    const days: string[] = [];
    for (const d = new Date('2025-09-01T12:00:00Z'); days.length < 330; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10));
    let upTo = '2026-10-28';
    const chart = (t: string) => {
      const ds = days.filter((d) => d <= upTo);
      const px = ds.map((_, i) => (t === 'QQQ' ? 500 + i * 0.1 : 50 + i * 0.3));
      return { dates: ds.map((d) => new Date(d + 'T20:00:00Z')), opens: px, highs: px, lows: px, closes: px, volumes: px.map(() => 1e6), splits: [] } as never;
    };
    const analysis = async (t: string) => ({ ticker: t, result: undefined, status: {}, dataQuality: [], reports: {}, texts: {} }) as never;
    const deps = { store: tabs, timeZone: TZ, watchlist: [], log: () => {}, now: () => Date.parse(upTo + 'T23:00:00Z'), fetchChart: async (t: string) => chart(t), analysis };
    await runPaperNight(deps);
    upTo = '2026-10-29';
    await runPaperNight(deps);
    const names = new Set(parseValues((await tabs.read(VALUES_TAB, 6))!).map((r) => r.account));
    assert.ok(names.size > 10, 'the paper night wrote its accounts: ' + names.size);
    const r = (await readWeekly(tabs, weekOf('2026-10-29')))!;
    assert.deepEqual(new Set(r.accounts.map((a) => a.account)), names, 'no account left out');
    assert.ok(r.qqq && r.list, 'both yardsticks found by the names the paper log writes');
    assert.ok(r.accounts.filter((a) => !a.yardstick).every((a) => a.vsQqq != null && a.vsList != null));
    assert.ok(weeklyCaption(r).length <= CAPTION_MAX_CHARS);
  });
});

describe('paper weekly — sending', () => {
  const SAT_NIGHT = Date.parse('2026-11-08T03:23:00Z'); // the relay timer: Saturday 22:23 in New York

  test('Saturday only (the New York date)', () => {
    assert.equal(isWeeklyNight(SAT_NIGHT, TZ), true);
    assert.equal(isWeeklyNight(SAT_NIGHT, 'Asia/Jerusalem'), false, 'already Sunday there');
    assert.equal(isWeeklyNight(Date.parse('2026-11-07T03:23:00Z'), TZ), false, 'Friday night in New York');
    assert.equal(isWeeklyNight(Date.parse('2026-11-09T03:23:00Z'), TZ), false, 'Sunday night in New York');
  });

  test('sent once: one PDF with the caption, the week recorded; the second Saturday run sends nothing', async () => {
    const tabs = await store(), kv = new MemoryPropertyStore(), tg = fakeTelegram();
    const pdfs: string[] = [];
    const deps = { store: tabs, kv, telegram: { deps: { token: TOKEN, fetchImpl: tg.fetchImpl }, chatId: '42' }, log: () => {}, timeZone: TZ,
      toPdf: async (html: string, p: string) => { pdfs.push(html); fs.writeFileSync(p, '%PDF'); } };
    assert.equal(await maybeSendPaperWeekly({ ...deps, now: Date.parse('2026-11-07T03:23:00Z') }), 'not-saturday');
    assert.equal(tg.calls.length, 0);
    assert.equal(await maybeSendPaperWeekly({ ...deps, now: SAT_NIGHT }), 'sent');
    assert.deepEqual(tg.calls.map((c) => c.method), ['sendDocument'], 'a PDF only, no message');
    assert.equal(tg.calls[0]!.name, 'paper-week-2026-11-02.pdf');
    assert.equal(tg.calls[0]!.caption, weeklyCaption((await readWeekly(tabs, WEEK))!));
    assert.equal(await kv.get(PAPER_WEEKLY_KEY), '2026-11-02');
    assert.equal(await maybeSendPaperWeekly({ ...deps, now: SAT_NIGHT + 3_600_000 }), 'already-sent');
    assert.equal(tg.calls.length, 1, 'no double send');
    assert.equal(pdfs.length, 1);
    // By hand: always sends.
    assert.equal(await maybeSendPaperWeekly({ ...deps, now: SAT_NIGHT, force: true }), 'sent');
    assert.equal(tg.calls.length, 2);
  });

  test('no browser or Telegram refusing: nothing recorded, so the week can still go', async () => {
    const tabs = await store(), kv = new MemoryPropertyStore(), tg = fakeTelegram();
    const base = { store: tabs, kv, telegram: { deps: { token: TOKEN, fetchImpl: tg.fetchImpl }, chatId: '42' }, log: () => {}, timeZone: TZ, now: SAT_NIGHT };
    assert.equal(await maybeSendPaperWeekly({ ...base, toPdf: null }), 'no-browser');
    assert.equal(await maybeSendPaperWeekly({ ...base, toPdf: async () => { throw new Error('chrome crashed'); } }), 'failed');
    const refuse = (async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status: 400 })) as unknown as typeof fetch;
    assert.equal(await maybeSendPaperWeekly({ ...base, telegram: { deps: { token: TOKEN, fetchImpl: refuse }, chatId: '42' }, toPdf: async (_h, p) => { fs.writeFileSync(p, '%PDF'); } }), 'failed');
    assert.equal(await kv.get(PAPER_WEEKLY_KEY), null);
    assert.equal(tg.calls.length, 0);
    assert.equal(await maybeSendPaperWeekly({ ...base, store: new MemoryTabStore(), toPdf: async () => {} }), 'no-data', 'no paper tabs yet');
  });
});
