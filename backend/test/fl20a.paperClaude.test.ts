/**
 * FL-20a: the paper account "🤖 Claude, free choice" (paper/paperClaude.ts; request of 2026-11-06). Orders come from the
 * '🤖 Claude Picks' tab; same rules as every account ($100,000, long-only, no margin, 25% tax on gains, the fill at the
 * next open after the Decided day), never filled twice, rejected with the reason when they cannot be priced. It joins
 * on its first fill. The other accounts are byte-identical with and without it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_ID, CLAUDE_LABEL, CLAUDE_GROUP, CLAUDE_PICKS_TAB, CLAUDE_PICKS_HEADER, CLAUDE_QUOTE_NIGHTS, checkClaudeOrder, claudeRows, claudeFillDay, claudeDay, claudeValue, newClaudeBook,
  type ClaudeFields, type ClaudeNight,
} from '../src/paper/paperClaude.ts';
import { parseClaudeArgs, runClaudeOrder, claudeRowOf } from '../src/claudeOrder.ts';
import { runPaperNight, loadPaper, paperTabRows, callQuoteIn, PAPER_TAB, type PaperJobDeps } from '../src/paper/paperJob.ts';
import { LOG_TAB, VALUES_TAB } from '../src/paper/paperLog.ts';
import { PAPER_DECIDE_FROM, standings, accountIds } from '../src/paper/paperTrading.ts';
import { bagsOf } from '../src/paper/paperReport.ts';
import { engineReadOf } from '../src/backtest/engineRun.ts';
import { MemoryTabStore, type TabCell } from '../src/storage/tabStore.ts';
import { isTradingDay, nextTradingDay } from '../src/live/marketCalendar.ts';
import { sheetFor, isAllowListedName, PROTECTED_TABS } from '../src/sheets/tabs.ts';
import type { FetchedChart } from '../src/types/chart.ts';
import type { TickerArtifacts } from '../src/analysis/runTicker.ts';
import type { CboeChainJson } from '../src/fetch/cboe.ts';
import { occ } from './cboeFixtures.ts';

const f = (o: Partial<ClaudeFields>): ClaudeFields => ({ decided: '2026-11-06', action: 'BUY', ticker: 'NVDA', kind: 'stock', strike: '', expiry: '', amount: '20000', qty: '', reason: 'why', ...o });
const rowsOf = (...rs: Array<Partial<ClaudeFields> & { status?: string }>): ReturnType<typeof claudeRows> =>
  claudeRows([CLAUDE_PICKS_HEADER, ...rs.map((r) => { const x = f(r); return [x.decided, x.action, x.ticker, x.kind, x.strike, x.expiry, x.amount, x.qty, x.reason, r.status ?? '']; })]);
const DAYS7 = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10'];
const night = (day: string, rows: ClaudeNight['rows'], bars: Record<string, [number, number]>, quote: ClaudeNight['quote'] = () => null): ClaudeNight => ({
  day, rows, tradingDays: DAYS7, fill: true, quote, bar: (t) => (bars[t] ? { open: bars[t]![0], close: bars[t]![1] } : null),
});

describe('FL-20a — the order checks (the CLI and the job share them)', () => {
  test('long-only and well-formed: short, put, negative, margin-shaped, bad date, missing parts are refused with one line', () => {
    assert.ok(checkClaudeOrder(f({})).ok);
    assert.ok(checkClaudeOrder(f({ kind: 'call', strike: '150', expiry: '2027-01-15' }), '2026-11-06').ok);
    const why = (o: Partial<ClaudeFields>, today?: string): string => { const c = checkClaudeOrder(f(o), today); assert.ok(!c.ok); return c.why; };
    assert.match(why({ action: 'SHORT' }), /short selling is not allowed/);
    assert.match(why({ kind: 'put', strike: '150', expiry: '2027-01-15' }), /puts are not allowed/);
    assert.match(why({ kind: 'future' }), /Kind must be stock or call/);
    assert.match(why({ amount: '-5000' }), /long-only/);
    assert.match(why({ action: 'SELL', amount: '', qty: '-3' }), /long-only/);
    assert.match(why({ decided: '2026-13-01' }), /bad Decided date/);
    assert.match(why({ decided: '6/11/2026' }), /bad Decided date/);
    assert.match(why({ ticker: 'BTC-USD' }), /not a stock or ETF ticker/);
    assert.match(why({ kind: 'call', strike: '', expiry: '2027-01-15' }), /Strike/);
    assert.match(why({ kind: 'call', strike: '150', expiry: '2026-11-06' }, '2026-11-06'), /expires/);
    assert.match(why({ reason: ' ' }), /Reason/);
    assert.match(why({ action: 'SELL ALL', amount: '', qty: '4' }), /SELL ALL takes no/);
  });

  test('the fill day: the first trading day after Decided; decided before the 09:30 open of a trading day = that day', () => {
    const o = (decided: string): { decided: string; preOpen: boolean } => { const c = checkClaudeOrder(f({ decided })); assert.ok(c.ok); return c.order; };
    assert.equal(claudeFillDay(o('2026-11-02'), DAYS7), '2026-11-03', 'a date alone: decided during or after that day');
    assert.equal(claudeFillDay(o('2026-11-02 16:30'), DAYS7), '2026-11-03');
    assert.equal(claudeFillDay(o('2026-11-02 09:29'), DAYS7), '2026-11-02', 'before the open: data up to the previous close, so the open of that day');
    assert.equal(claudeFillDay(o('2026-11-02 09:30'), DAYS7), '2026-11-03');
    assert.equal(claudeFillDay(o('2026-11-07 08:00'), DAYS7), '2026-11-09', 'a Saturday: the Monday open');
    assert.equal(claudeFillDay(o('2026-11-10'), DAYS7), null, 'not yet known: waits');
  });

  test('the CLI: BUY / SELL / SELL ALL for shares and calls; refuses an invalid order with one line and writes nothing', async () => {
    assert.deepEqual(parseClaudeArgs(['BUY', 'NVDA', 'stock', '20000', 'AI', 'demand']), { action: 'BUY', ticker: 'NVDA', kind: 'stock', strike: '', expiry: '', amount: '20000', qty: '', reason: 'AI demand' });
    assert.deepEqual(parseClaudeArgs(['BUY', 'NVDA', 'call', '150', '2027-01-15', '20000', 'r']), { action: 'BUY', ticker: 'NVDA', kind: 'call', strike: '150', expiry: '2027-01-15', amount: '20000', qty: '', reason: 'r' });
    assert.equal((parseClaudeArgs(['SELL', 'NVDA', 'stock', 'r']) as ClaudeFields).qty, '', 'no number = all');
    assert.equal((parseClaudeArgs(['SELL', 'NVDA', 'stock', '50', 'r']) as ClaudeFields).qty, '50');
    assert.equal((parseClaudeArgs(['SELL', 'ALL', 'NVDA', 'stock', 'r']) as ClaudeFields).action, 'SELL ALL');
    assert.deepEqual(parseClaudeArgs(['SELL', 'ALL', 'stock', 'r']), { action: 'SELL', ticker: 'ALL', kind: 'stock', strike: '', expiry: '', amount: '', qty: '', reason: 'r' }, 'the ticker ALL');
    const rows: (readonly string[])[] = [], out: string[] = [];
    const deps = { env: {}, now: Date.parse('2026-11-06T13:05:00Z'), out: (l: string) => out.push(l), append: async (_e: unknown, r: readonly string[]) => { rows.push(r); } };
    assert.equal(await runClaudeOrder(['BUY', 'NVDA', 'stock', '20000', 'reason', 'here'], deps), 0);
    assert.deepEqual(rows[0], ['2026-11-06 08:05', 'BUY', 'NVDA', 'stock', '', '', '20000', '', 'reason here', '']);
    assert.match(out[0]!, /fills at the open of 2026-11-06/);
    for (const bad of [['BUY', 'NVDA', 'put', '150', '2027-01-15', '1000', 'r'], ['SHORT', 'NVDA', 'stock', '1000', 'r'], ['BUY', 'NVDA', 'stock', 'x'], ['BUY'], ['BUY', 'NVDA', 'call', '150', '2026-11-01', '1000', 'r']]) {
      out.length = 0;
      assert.equal(await runClaudeOrder(bad, deps), 1, bad.join(' '));
      assert.equal(out.length, 1);
      assert.match(out[0]!, /^refused: /);
    }
    assert.equal(rows.length, 1, 'nothing written for a refused order');
    out.length = 0;
    assert.equal(await runClaudeOrder(['SELL', 'NVDA', 'stock', 'r'], { ...deps, append: async () => { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON / REPORTS_SPREADSHEET_ID not set'); } }), 1);
    assert.deepEqual(out, ['not written: GOOGLE_SERVICE_ACCOUNT_JSON / REPORTS_SPREADSHEET_ID not set']);
    assert.deepEqual(claudeRowOf({ ...f({ amount: '$20,000' }), decided: 'd' }).slice(6, 7), ['20000']);
  });

  test('the tab is a protected report tab in the reports sheet', () => {
    assert.equal(sheetFor(CLAUDE_PICKS_TAB), 'reports');
    assert.ok(isAllowListedName(CLAUDE_PICKS_TAB));
    assert.ok(PROTECTED_TABS.includes(CLAUDE_PICKS_TAB));
  });
});

describe('FL-20a — the book', () => {
  test('fills at the fill day\'s open, 25% tax on the sale\'s gain, never twice', () => {
    const b = newClaudeBook(100_000);
    const rows = rowsOf({ decided: '2026-11-02', amount: '10000', reason: 'buy it' }, { decided: '2026-11-03', action: 'SELL ALL', amount: '', reason: 'take profit' });
    assert.deepEqual(claudeDay(b, night('2026-11-02', rows, { NVDA: [90, 95] })), [], 'decided 11-02: not at that day\'s open');
    assert.equal(b.joined, null);
    const t1 = claudeDay(b, night('2026-11-03', rows, { NVDA: [100, 110] }));
    assert.deepEqual(t1, [{ side: 'BUY', ticker: 'NVDA', shares: 100, price: 100, value: 10_000, tax: 0, why: 'buy it' }]);
    assert.equal(b.joined, '2026-11-03');
    assert.equal(b.cash, 90_000);
    assert.equal(claudeValue(b, () => 110), 90_000 + 11_000 - 1_000 * 0.25, 'after the tax on what is held');
    const t2 = claudeDay(b, night('2026-11-04', rows, { NVDA: [150, 150] }));
    assert.deepEqual(t2, [{ side: 'SELL', ticker: 'NVDA', shares: 100, price: 150, value: 15_000, tax: 1_250, why: 'take profit' }]);
    assert.equal(b.cash, 90_000 + 15_000 - 1_250);
    assert.equal(b.taxPaid, 1_250);
    assert.match(b.done[rows[0]!.key]!, /^FILLED 2026-11-03 at \$100\.00 \(100 shares\)$/);
    assert.match(b.done[rows[1]!.key]!, /^FILLED 2026-11-04 at \$150\.00 \(100 shares, tax \$1,250\.00\)$/);
    // never twice: the same rows again, and a fresh book that only has the tab's Status
    for (const d of ['2026-11-05', '2026-11-06']) assert.deepEqual(claudeDay(b, night(d, rows, { NVDA: [150, 150] })), []);
    const fresh = newClaudeBook(100_000);
    const withStatus = rowsOf({ decided: '2026-11-02', amount: '10000', reason: 'buy it', status: b.done[rows[0]!.key] });
    assert.deepEqual(claudeDay(fresh, night('2026-11-03', withStatus, { NVDA: [100, 100] })), []);
    assert.equal(fresh.cash, 100_000);
  });

  test('rejected with the reason: a short, a sale of more than held, margin, no price, a put, a bad date, a late order', () => {
    const b = newClaudeBook(100_000);
    const rows = rowsOf(
      { decided: '2026-11-02', action: 'SELL', amount: '', qty: '5', reason: 'short it' },
      { decided: '2026-11-02', amount: '100001', reason: 'too big' },
      { decided: '2026-11-02', ticker: 'NOPE', amount: '1000', reason: 'no chart' },
      { decided: '2026-11-02', kind: 'put', strike: '100', expiry: '2027-01-15', reason: 'a put' },
      { decided: '2026-11-31', reason: 'bad date' },
      { decided: '2026-11-02', amount: '50', reason: 'too small' },
      { decided: '2026-11-02', ticker: 'AMD', amount: '1000', reason: 'ok' },
    );
    const t = claudeDay(b, night('2026-11-03', rows, { NVDA: [100, 100], AMD: [100, 100] }));
    assert.deepEqual(t.map((x) => x.ticker), ['AMD']);
    const st = rows.map((r) => b.done[r.key]);
    assert.match(st[0]!, /^REJECTED: NVDA is not held: selling it would be a short \(long-only\)/);
    assert.match(st[1]!, /^REJECTED: no margin: \$100,001\.00 is more than the cash \$100,000\.00/);
    assert.match(st[2]!, /^REJECTED: no price for NOPE at the open of 2026-11-03 \(cannot be priced\)/);
    assert.match(st[3]!, /^REJECTED: puts are not allowed/);
    assert.match(st[4]!, /^REJECTED: bad Decided date/);
    assert.match(st[5]!, /^REJECTED: \$50\.00 buys no share at \$100\.00/);
    assert.match(st[6]!, /^FILLED/);
    assert.ok(b.notes.some((n) => n.action === 'REJECTED' && /short it$/.test(n.why)), 'the reason goes with the note');
    const more = rowsOf({ decided: '2026-11-03', ticker: 'AMD', action: 'SELL', amount: '', qty: '11', reason: 'too many' });
    claudeDay(b, night('2026-11-04', more, { AMD: [100, 100] }));
    assert.match(b.done[more[0]!.key]!, /^REJECTED: selling 11 of AMD but 10 held/);
    // typed in after its fill day was handled: never back-filled
    const late = rowsOf({ decided: '2026-11-02', ticker: 'AMD', amount: '1000', reason: 'hindsight' });
    claudeDay(b, night('2026-11-05', late, { AMD: [100, 100] }));
    assert.match(b.done[late[0]!.key]!, /^REJECTED: its fill day 2026-11-03 was handled before the order was there/);
  });

  test('calls: buy at the ask of the fill night, marked at the middle, wait for a missing chain, unpriceable contract rejected, settled at expiry', () => {
    const b = newClaudeBook(100_000);
    const rows = rowsOf(
      { decided: '2026-11-02', kind: 'call', strike: '150', expiry: '2026-11-06', amount: '10000', reason: 'call it' },
      { decided: '2026-11-02', kind: 'call', strike: '999', expiry: '2026-11-06', amount: '1000', reason: 'no such' },
    );
    const quote: ClaudeNight['quote'] = (_t, strike) => (strike === 150 ? { bid: 4, ask: 5 } : 'missing');
    // 11-03: a night without the chain (a missed night): the call order waits
    assert.deepEqual(claudeDay(b, night('2026-11-03', rows, { NVDA: [150, 150] }, () => null)), []);
    assert.equal(b.waits[rows[0]!.key], 1);
    const t = claudeDay(b, night('2026-11-04', rows, { NVDA: [150, 152] }, quote));
    assert.deepEqual(t, [{ side: 'BUY', ticker: 'NVDA $150 call 2026-11-06', shares: 20, price: 5, value: 10_000, tax: 0, why: 'call it' }]);
    assert.match(b.done[rows[1]!.key]!, /^REJECTED: no such contract in Cboe's chain/);
    assert.equal(claudeValue(b, () => 152), 90_000 + 20 * 100 * 4.5, 'a loss: no tax');
    const exp = claudeDay(b, night('2026-11-06', rows, { NVDA: [160, 158] }, () => null));
    assert.deepEqual(exp.map((x) => [x.side, x.shares, x.price, x.value, x.tax]), [['SELL', 20, 8, 16_000, 1_500]]);
    assert.deepEqual(b.pos, {});
    // a call order that never gets a quote is rejected after CLAUDE_QUOTE_NIGHTS nights
    const c = newClaudeBook(100_000), r2 = rowsOf({ decided: '2026-11-02', kind: 'call', strike: '150', expiry: '2027-01-15', amount: '1000', reason: 'r' });
    for (const d of DAYS7.slice(1, 1 + CLAUDE_QUOTE_NIGHTS)) claudeDay(c, night(d, r2, {}, () => null));
    assert.match(c.done[r2[0]!.key]!, /^REJECTED: no option quote for NVDA \$150 call 2027-01-15 in 5 nights/);
  });

  test('callQuoteIn reads a call out of a Cboe chain (calls only, strike and expiry exact)', () => {
    const exp = Date.parse('2027-01-15T00:00:00Z');
    const chain = { data: { options: [{ option: occ('NVDA', exp, 'P', 150), bid: 1, ask: 2 }, { option: occ('NVDA', exp, 'C', 150), bid: 30, ask: 31 }] } } as CboeChainJson;
    assert.deepEqual(callQuoteIn(chain, 150, '2027-01-15'), { bid: 30, ask: 31 });
    assert.equal(callQuoteIn(chain, 155, '2027-01-15'), 'missing');
    assert.equal(callQuoteIn(chain, 150, '2027-01-22'), 'missing');
    assert.equal(callQuoteIn(null, 150, '2027-01-15'), null);
  });
});

// ---- the paper night, end to end ------------------------------------------------------------------------------------

const TZ = 'America/New_York';
const DAYS: string[] = [];
for (let d = '2025-06-02'; d <= '2026-11-30'; d = nextTradingDay(d)) if (isTradingDay(d)) DAYS.push(d);
const hash = (s: string): number => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
const rnd = (s: string): number => (hash(s) % 100_000) / 100_000;
const BARS = new Map<string, { opens: number[]; closes: number[] }>();
function barsOf(t: string): { opens: number[]; closes: number[] } {
  let b = BARS.get(t);
  if (b) return b;
  b = { opens: [], closes: [] };
  let px = 50 + (hash(t) % 400);
  for (const d of DAYS) { const open = px * (1 + (rnd(t + d + 'o') - 0.5) * 0.02), close = open * (1 + (rnd(t + d + 'c') - 0.48) * 0.05); b.opens.push(open); b.closes.push(close); px = close; }
  BARS.set(t, b);
  return b;
}
function chartUpTo(t: string, day: string): FetchedChart {
  const n = DAYS.filter((d) => d <= day).length, b = barsOf(t), c = b.closes.slice(0, n);
  return { ticker: t, dates: DAYS.slice(0, n).map((d) => new Date(d + 'T20:00:00Z')), opens: b.opens.slice(0, n), highs: c.map((x) => x * 1.01), lows: c.map((x) => x * 0.99), closes: c, volumes: c.map(() => 1e6), splits: [], ipoDate: null, currentPrice: c[n - 1]!, prevClose: c[n - 2], currency: 'USD' } as FetchedChart;
}
const DIRS = ['bullish', 'mixed', 'cautionary'] as const;
function artOf(t: string, day: string): TickerArtifacts {
  const close = barsOf(t).closes[DAYS.indexOf(day)]!, conv = Math.round(40 + rnd(t + day + 'conv') * 50), dir = (k: string): string => DIRS[hash(t + day + k) % 3]!;
  return {
    result: { fundResult: { score: 60 }, decision: { finalConviction: conv, action: conv >= 70 ? 'BUY' : 'WATCH' },
      techPlan: { timing: conv >= 70 ? 'BUY_NOW' : 'WAIT_PULLBACK', regime: 'UPTREND', entryPrice: close, entryHigh: close * 1.01, entryConfidencePct: 60, stop: close * 0.9, t1: { price: close * 1.1 }, t2: { price: close * 1.2 }, rrToT1: 2, t1Time: { baseDays: 20 } } },
    reports: { comparison: { verdict: 'MAJORITY', existingDirection: dir('e'), newDirection: dir('n'), schabackerDirection: dir('s'), edwardsMageeDirection: dir('m'), turtleDirection: dir('t') } },
    confluence: { entryLow: close * 0.97, entryHigh: close * 1.01, entryCount: 3 }, ind: {},
  } as unknown as TickerArtifacts;
}
const jobDeps = (store: MemoryTabStore, n: string): PaperJobDeps => ({
  store, timeZone: TZ, watchlist: [], log: () => {}, now: () => Date.parse(n + 'T23:30:00Z'),
  fetchChart: async (t) => (t === 'NOPE' ? null : chartUpTo(t, n)), analysis: async (t) => artOf(t, n),
  readsAt: async (series, day, tickers) => tickers.map((t) => engineReadOf(artOf(t, day), t, day, series.get(t)?.closes[series.get(t)!.dates.lastIndexOf(day)] ?? null)),
});
const nightsTo = (to: string): string[] => DAYS.filter((d) => d >= PAPER_DECIDE_FROM && d <= to);
const pickRow = (r: string[]): TabCell[] => [...r, ''];
const PICKS: string[][] = [
  ['2026-11-02', 'BUY', 'ZZZ', 'stock', '', '', '20000', '', 'a stock off the list'],
  ['2026-11-03 08:15', 'SELL', 'ZZZ', 'stock', '', '', '', '50', 'before the open, but not held yet'],
  ['2026-11-04', 'SELL ALL', 'ZZZ', 'stock', '', '', '', '', 'take it off'],
  ['2026-11-04', 'BUY', 'YYY', 'stock', '', '', '500000', '', 'margin'],
  ['2026-11-04', 'BUY', 'NOPE', 'stock', '', '', '1000', '', 'no chart'],
  ['2026-11-04', 'BUY', 'YYY', 'put', '100', '2027-01-15', '1000', '', 'a put'],
];

describe('FL-20a — in the paper night', () => {
  test('fills, the log with the reason, the values (group Claude), QQQ since it joined, the Status column; the other accounts are byte-identical', async () => {
    const a = new MemoryTabStore(), b = new MemoryTabStore();
    await b.ensure(CLAUDE_PICKS_TAB);
    await b.write(CLAUDE_PICKS_TAB, 1, [CLAUDE_PICKS_HEADER, ...PICKS.map(pickRow)]);
    for (const n of nightsTo('2026-11-02')) { await runPaperNight(jobDeps(a, n)); await runPaperNight(jobDeps(b, n)); }
    assert.equal((await loadPaper(b))!.state.lab!.claude!.joined, null, 'no fill yet: not in the test');
    assert.ok(!accountIds((await loadPaper(b))!.state).includes(CLAUDE_ID));
    // the 11-03 and 11-04 nights are missed and caught up on 11-05 (shares fill on a missed day from its own open)
    await runPaperNight(jobDeps(a, '2026-11-05')); await runPaperNight(jobDeps(b, '2026-11-05'));
    // typed in late: decided 11-02 (fill day 11-03, already handled) -> rejected, never back-filled
    const now = (await b.read(CLAUDE_PICKS_TAB, 10))!;
    await b.write(CLAUDE_PICKS_TAB, now.length + 1, [pickRow(['2026-11-02', 'BUY', 'XXX', 'stock', '', '', '1000', '', 'hindsight'])]);
    for (const n of nightsTo('2026-11-10').filter((x) => x > '2026-11-05')) { await runPaperNight(jobDeps(a, n)); await runPaperNight(jobDeps(b, n)); }

    const sb = (await loadPaper(b))!, sa = (await loadPaper(a))!;
    const k = DAYS.indexOf('2026-11-03'), px = barsOf('ZZZ').opens[k]!, n = Math.floor(20_000 / px);
    const mine = sb.trades.filter((t) => t.strategy === CLAUDE_ID);
    assert.deepEqual(mine.map((t) => [t.day, t.side, t.ticker, t.shares, t.why]), [['2026-11-03', 'BUY', 'ZZZ', n, 'a stock off the list'], ['2026-11-05', 'SELL', 'ZZZ', n, 'take it off']]);
    assert.equal(mine[0]!.price, px, 'the open of the first trading day after Decided');
    const sellPx = barsOf('ZZZ').opens[DAYS.indexOf('2026-11-05')]!;
    assert.equal(mine[1]!.tax, Math.max(0, n * sellPx - n * px) * 0.25, '25% of the gain');
    assert.deepEqual(sb.state.joins![CLAUDE_ID], { day: '2026-11-03', qqqClose: barsOf('QQQ').closes[k]! });
    assert.equal(sb.state.marks.find((m) => m.day === '2026-11-02')!.values[CLAUDE_ID], undefined, 'no values before it joined');
    const row = standings(sb.state).find((r) => r.key === CLAUDE_ID)!;
    assert.equal(row.name, CLAUDE_LABEL);
    assert.ok(row.qqqSinceJoined != null, '📊 QQQ since this account joined');
    assert.ok(bagsOf(sb.state, () => 100).some((x) => x.id === CLAUDE_ID && x.group === CLAUDE_GROUP));
    assert.ok(paperTabRows(sb).some((r) => r[0] === CLAUDE_LABEL), 'its holdings line in 📝 Paper Trading');

    const log = (await b.read(LOG_TAB, 11))!;
    const filled = log.filter((r) => r[2] === CLAUDE_LABEL && r[1] === 'filled');
    assert.deepEqual(filled.map((r) => [r[0], r[3], r[4], r[9]]), [['2026-11-03', 'BOUGHT', 'ZZZ', 'a stock off the list'], ['2026-11-05', 'SOLD', 'ZZZ', 'take it off']]);
    assert.ok(log.some((r) => r[2] === CLAUDE_LABEL && r[3] === 'REJECTED' && /no margin/.test(String(r[9]))));
    const values = (await b.read(VALUES_TAB, 6))!.filter((r) => r[1] === CLAUDE_LABEL);
    assert.equal(values[0]![0], '2026-11-03');
    assert.ok(values.every((r) => r[2] === CLAUDE_GROUP));

    const status = (await b.read(CLAUDE_PICKS_TAB, 10))!.slice(1).map((r) => String(r[9]));
    assert.match(status[0]!, /^FILLED 2026-11-03 at \$/);
    assert.match(status[1]!, /^REJECTED: ZZZ is not held: selling it would be a short/);
    assert.match(status[2]!, /^FILLED 2026-11-05 at \$.*tax/);
    assert.match(status[3]!, /^REJECTED: no margin/);
    assert.match(status[4]!, /^REJECTED: no price for NOPE/);
    assert.match(status[5]!, /^REJECTED: puts are not allowed/);
    assert.match(status[6]!, /^REJECTED: its fill day 2026-11-03 was handled before/);
    assert.equal((await b.read(CLAUDE_PICKS_TAB, 10))![1]![8], 'a stock off the list', 'the row itself is kept');

    // the other accounts: byte-identical with and without the Claude account
    const strip = <T>(x: T): T => JSON.parse(JSON.stringify(x, (key, v) => (key === 'claude' || key === CLAUDE_ID ? undefined : v)));
    assert.deepEqual(strip(sb.state), strip(sa.state));
    assert.equal(JSON.stringify(sb.trades.filter((t) => t.strategy !== CLAUDE_ID)), JSON.stringify(sa.trades));
    const without = async (s: MemoryTabStore, tab: string): Promise<string> => JSON.stringify(((await s.read(tab, 11)) ?? []).filter((r) => !r.includes(CLAUDE_LABEL)));
    for (const tab of [LOG_TAB, VALUES_TAB, PAPER_TAB]) assert.equal(await without(b, tab), await without(a, tab), tab);
    assert.equal(sa.state.lab!.claude, undefined, 'no rows: no book at all');
  });

  test('a Status wiped from the tab: never filled again (the state keeps it) and written back', async () => {
    const b = new MemoryTabStore();
    await b.ensure(CLAUDE_PICKS_TAB);
    await b.write(CLAUDE_PICKS_TAB, 1, [CLAUDE_PICKS_HEADER, pickRow(PICKS[0]!)]);
    for (const n of nightsTo('2026-11-04')) await runPaperNight(jobDeps(b, n));
    assert.match(String((await b.read(CLAUDE_PICKS_TAB, 10))![1]![9]), /^FILLED 2026-11-03/);
    await b.write(CLAUDE_PICKS_TAB, 2, [pickRow(PICKS[0]!)]);
    await runPaperNight(jobDeps(b, '2026-11-05'));
    const s = (await loadPaper(b))!;
    assert.equal(s.trades.filter((t) => t.strategy === CLAUDE_ID).length, 1);
    assert.match(String((await b.read(CLAUDE_PICKS_TAB, 10))![1]![9]), /^FILLED 2026-11-03/);
  });

  test('a call on a stock off the list: its chain is fetched that night, bought at the ask, held at the middle', async () => {
    const exp = Date.parse('2027-01-15T00:00:00Z'), urls: string[] = [];
    const http = { fetch: async (req: { url: string }) => {
      urls.push(req.url);
      const t = decodeURIComponent(req.url.split('/').pop()!.replace('.json', ''));
      return { status: 200, text: () => JSON.stringify({ data: { current_price: 100, options: [{ option: occ(t, exp, 'C', 100), bid: 9, ask: 10 }] } }) };
    } };
    const b = new MemoryTabStore();
    await b.ensure(CLAUDE_PICKS_TAB);
    await b.write(CLAUDE_PICKS_TAB, 1, [CLAUDE_PICKS_HEADER, pickRow(['2026-11-04', 'BUY', 'ZZZ', 'call', '100', '2027-01-15', '5000', '', 'a call'])]);
    for (const n of nightsTo('2026-11-05')) await runPaperNight({ ...jobDeps(b, n), cboe: { http: http as never, memo: new Map() } });
    const s = (await loadPaper(b))!;
    assert.deepEqual(s.trades.filter((t) => t.strategy === CLAUDE_ID).map((t) => [t.day, t.ticker, t.shares, t.price, t.value]), [['2026-11-05', 'ZZZ $100 call 2027-01-15', 5, 10, 5000]]);
    assert.ok(urls.some((u) => u.endsWith('/ZZZ.json')));
    assert.equal(s.state.marks.at(-1)!.values[CLAUDE_ID], 95_000 + 5 * 100 * 9.5);
  });

  test('the tab is made with its header when missing', async () => {
    const s = new MemoryTabStore();
    await runPaperNight(jobDeps(s, PAPER_DECIDE_FROM));
    assert.deepEqual((await s.read(CLAUDE_PICKS_TAB, 10))![0], CLAUDE_PICKS_HEADER);
  });
});
