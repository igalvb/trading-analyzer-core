/**
 * Owner-approved build 2026-11-07: business-based exit alerts (jobs/exit/businessAlerts.ts), shadow only.
 * Each trigger's edges, unknown data (never "clear"), the 30-day dedupe, the profile flag modes and the Exit report
 * section. Made-up tickers and numbers only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSINESS_ALERT_RULES as R, BUSINESS_ALERTS_STATE_KEY, EMPTY_STATE, addDays,
  checkMarket, checkMargin, checkRating, checkRevenue, checkSecDilution, checkSecDistress, checkTarget,
  businessAlertsView, businessAlertsLogLines, evaluateBusinessAlerts, historyByTicker, modeOf, parseState, runBusinessAlerts, secHitsOf,
  MARKET_BUY_POINT, markSent, tradingDaysAfter,
  type BusinessAlertState, type FundPoint, type HoldingAlertInput,
} from '../src/jobs/exit/businessAlerts.ts';
import { validateProfile } from '../src/profile/schema.ts';
import { CORE_TEST_PROFILE_INPUT } from './testProfileEnv.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { Logger } from '../src/core/logger.ts';
import { createContext } from '../src/core/context.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../src/sheets/reportSheet.ts';
import { buildExitSheet, EXIT_SHEET_TAB, BUSINESS_ALERTS_HEADER } from '../src/reports/exitSheet/exitSheet.ts';
import { exitReportJob } from '../src/jobs/exit/exitReportStep.ts';
import { toExitReportInput } from '../src/jobs/exit/exitReportAdapter.ts';
import { assertNoReportLeaks } from '../src/reports/messages/leakScan.ts';
import { FUNDAMENTALS_HISTORY_HEADER, fundamentalsRow, type FundamentalsRecord } from '../src/storage/fundamentalsHistory.ts';
import type { ExitPipelineResult } from '../src/jobs/exit/exitPipeline.ts';
import type { PortfolioResult } from '../src/sheets/readers/portfolio.ts';
import type { Chart } from '../src/types/chart.ts';
import type { TickerArtifacts } from '../src/analysis/runTicker.ts';
import { FILING_LAG_DAYS, forward, pointsFromQuarterly, replayFundamentals, replayMarket } from '../src/research/businessAlertsReplayCli.ts';

const TODAY = '2026-11-07';
const P = (date: string, o: Partial<FundPoint> = {}): FundPoint => ({ date, revenueGrowth: null, profitMargin: null, analystTarget: null, ratingScore: null, rating: null, source: 'SRC', ...o });
const H = (history: FundPoint[], latest: Partial<FundPoint> | null, over: Partial<HoldingAlertInput> = {}): HoldingAlertInput =>
  ({ ticker: 'AAA', history, latest: latest ? P(TODAY, latest) : null, sec: null, ...over });
const D90 = addDays(TODAY, -R.lookbackDays);

describe('(1) revenue growth', () => {
  test('below the floor fires on its own; exactly the floor does not', () => {
    assert.equal(checkRevenue(H([], { revenueGrowth: -0.0501 }), TODAY).state, 'TRIGGERED');
    const c = checkRevenue(H([P('2026-10-01', { revenueGrowth: -0.02 })], { revenueGrowth: -0.05 }), TODAY);
    assert.equal(c.state, 'CLEAR', 'exactly -5% and not a turn (already negative)');
  });
  test('a turn from >= 0 to < 0 fires (zero counts as >= 0), dated the night it was first stored', () => {
    const c = checkRevenue(H([P('2026-10-01', { revenueGrowth: 0 })], { revenueGrowth: -0.001 }), TODAY);
    assert.equal(c.state, 'TRIGGERED');
    assert.equal(c.date, TODAY);
    assert.match(c.text, /turned negative/);
    // stored two nights ago, still within the window
    const c2 = checkRevenue(H([P('2026-10-01', { revenueGrowth: 0.03 }), P('2026-11-05', { revenueGrowth: -0.01 })], { revenueGrowth: -0.01 }), TODAY);
    assert.equal(c2.state, 'TRIGGERED');
    assert.equal(c2.date, '2026-11-05');
  });
  test('a turn older than the event window is not new; already negative is clear; zero is clear', () => {
    const old = addDays(TODAY, -(R.eventWindowDays + 1));
    assert.equal(checkRevenue(H([P('2026-08-01', { revenueGrowth: 0.03 }), P(old, { revenueGrowth: -0.01 })], { revenueGrowth: -0.01 }), TODAY).state, 'CLEAR');
    assert.equal(checkRevenue(H([P('2026-10-01', { revenueGrowth: -0.02 })], { revenueGrowth: -0.03 }), TODAY).state, 'CLEAR');
    assert.equal(checkRevenue(H([], { revenueGrowth: 0 }), TODAY).state, 'CLEAR');
  });
  test('unknown: no figure tonight, or negative with nothing stored before', () => {
    assert.equal(checkRevenue(H([P('2026-10-01', { revenueGrowth: 0.2 })], null), TODAY).state, 'UNKNOWN');
    assert.equal(checkRevenue(H([], { revenueGrowth: -0.01 }), TODAY).state, 'UNKNOWN');
  });
  test('tonight\'s raw value compares equal to the stored rounded value', () => {
    const c = checkRevenue(H([P('2026-10-01', { revenueGrowth: 0.01 }), P('2026-11-01', { revenueGrowth: -0.0123 })], { revenueGrowth: -0.012301 }), TODAY);
    assert.equal(c.date, '2026-11-01');
  });
});

describe('(2) net margin vs 90 days ago', () => {
  test('a fall of more than 10 points fires; exactly 10 does not', () => {
    assert.equal(checkMargin(H([P(D90, { profitMargin: 0.30 })], { profitMargin: 0.1999 }), TODAY).state, 'TRIGGERED');
    assert.equal(checkMargin(H([P(D90, { profitMargin: 0.30 })], { profitMargin: 0.20 }), TODAY).state, 'CLEAR');
  });
  test('the baseline is the value in force 90 days ago, not a later one', () => {
    const c = checkMargin(H([P('2026-01-01', { profitMargin: 0.40 }), P(addDays(D90, 1), { profitMargin: 0.15 })], { profitMargin: 0.15 }), TODAY);
    assert.equal(c.state, 'TRIGGERED');
    assert.match(c.text, /40\.0% on 2026-01-01/);
  });
  test('history shorter than 90 days is unknown and says where it starts', () => {
    const c = checkMargin(H([P('2026-11-04', { profitMargin: 0.30 })], { profitMargin: 0.01 }), TODAY);
    assert.equal(c.state, 'UNKNOWN');
    assert.match(c.text, /starts 2026-11-04 \(3 days\)/);
    assert.equal(checkMargin(H([P(D90, { profitMargin: 0.3 })], null), TODAY).state, 'UNKNOWN');
  });
});

describe('(3) rating and target', () => {
  test('score worse by exactly 1 step fires; 0.99 does not', () => {
    assert.equal(checkRating(H([P(D90, { ratingScore: 2.0, rating: 'Buy' })], { ratingScore: 3.0, rating: 'Buy' }), TODAY).state, 'TRIGGERED');
    assert.equal(checkRating(H([P(D90, { ratingScore: 2.0, rating: 'Buy' })], { ratingScore: 2.99, rating: 'Buy' }), TODAY).state, 'CLEAR');
  });
  test('leaving Buy / Strong Buy fires (any spelling); Hold to Sell does not', () => {
    const c = checkRating(H([P(D90, { ratingScore: 2.4, rating: 'strong_buy' }), P('2026-11-06', { ratingScore: 2.6, rating: 'Strong-Buy' })], { ratingScore: 2.6, rating: 'hold' }), TODAY);
    assert.equal(c.state, 'TRIGGERED');
    assert.match(c.text, /left Buy/);
    assert.equal(checkRating(H([P(D90, { ratingScore: 3.0, rating: 'Hold' })], { ratingScore: 3.5, rating: 'Sell' }), TODAY).state, 'CLEAR');
  });
  test('rating unknown without 90 days of history (the leave-Buy part alone cannot clear it)', () => {
    assert.equal(checkRating(H([P('2026-11-04', { ratingScore: 2, rating: 'Buy' })], { ratingScore: 2, rating: 'Buy' }), TODAY).state, 'UNKNOWN');
    assert.equal(checkRating(H([], null), TODAY).state, 'UNKNOWN');
  });
  test('target cut of exactly 20% fires; 19.9% does not; no baseline is unknown', () => {
    assert.equal(checkTarget(H([P(D90, { analystTarget: 100 })], { analystTarget: 80 }), TODAY).state, 'TRIGGERED');
    assert.equal(checkTarget(H([P(D90, { analystTarget: 100 })], { analystTarget: 80.1 }), TODAY).state, 'CLEAR');
    assert.equal(checkTarget(H([P('2026-11-01', { analystTarget: 100 })], { analystTarget: 10 }), TODAY).state, 'UNKNOWN');
    assert.equal(checkTarget(H([P(D90, { analystTarget: 100 })], {}), TODAY).state, 'UNKNOWN');
  });
});

describe('(4) SEC filings', () => {
  const hits = (o: Record<string, number | null>) => ({ hits: { offering: 2, shelf: 1, warrants: 0, convertible: 3, dilution: 0, ...o } });
  const st = (o: Partial<BusinessAlertState> = {}): BusinessAlertState => ({ ...EMPTY_STATE, ...o });
  test('degraded data is unknown, never clean', () => {
    assert.equal(checkSecDilution(H([], {}), TODAY, st()).state, 'UNKNOWN');
    const base = st({ sec: { AAA: { date: '2026-11-06', hits: { offering: 2, convertible: 3, dilution: 0 } } } });
    const c = checkSecDilution(H([], {}, { sec: hits({ dilution: null }) }), TODAY, base);
    assert.equal(c.state, 'UNKNOWN');
    assert.match(c.text, /could not check: dilution/);
    assert.equal(checkSecDilution(H([], {}, { sec: hits({}) }), TODAY, st()).state, 'UNKNOWN', 'first night: no baseline');
  });
  test('a rise in an offering / dilution / convertible count fires; shelf / warrants do not count', () => {
    const base = st({ sec: { AAA: { date: '2026-11-06', hits: { offering: 2, shelf: 1, convertible: 3, dilution: 0 } } } });
    assert.equal(checkSecDilution(H([], {}, { sec: hits({ offering: 3 }) }), TODAY, base).state, 'TRIGGERED');
    assert.equal(checkSecDilution(H([], {}, { sec: hits({ shelf: 5 }) }), TODAY, base).state, 'CLEAR');
    assert.equal(checkSecDilution(H([], {}, { sec: hits({ offering: 1 }) }), TODAY, base).state, 'CLEAR', 'a falling count (old filing left the window)');
  });
  test('a new hit stays up for 30 days', () => {
    const base = { sec: { AAA: { date: '2026-11-06', hits: { offering: 2, convertible: 3, dilution: 0 } } } };
    assert.equal(checkSecDilution(H([], {}, { sec: hits({}) }), TODAY, st({ ...base, secNew: { AAA: addDays(TODAY, -R.secWindowDays) } })).state, 'TRIGGERED');
    assert.equal(checkSecDilution(H([], {}, { sec: hits({}) }), TODAY, st({ ...base, secNew: { AAA: addDays(TODAY, -R.secWindowDays - 1) } })).state, 'CLEAR');
  });
  test('going concern / auditor change is unknown while the nightly search does not look for it; fires when supplied and rising', () => {
    assert.equal(checkSecDistress(H([], {}, { sec: hits({}) }), TODAY, st()).state, 'UNKNOWN');
    const withKw = { hits: { 'going concern': 1, 'certifying accountant': 0 } };
    const base = st({ sec: { AAA: { date: '2026-11-06', hits: { 'going concern': 0, 'certifying accountant': 0 } } } });
    assert.equal(checkSecDistress(H([], {}, { sec: withKw }), TODAY, base).state, 'TRIGGERED');
  });
  test('secHitsOf reads the dilution screen\'s counts; a missing screen is null', () => {
    assert.deepEqual(secHitsOf({ filingKeywordScreen: { hits: { offering: 1, dilution: null } } }), { hits: { offering: 1, dilution: null } });
    assert.equal(secHitsOf({}), null);
    assert.equal(secHitsOf(undefined), null);
  });
});

describe('(5) market shock', () => {
  const q = (lastChange: number) => ({ closes: [100, 100, 100, 100, 100, 100 * (1 + lastChange)], date: TODAY });
  test('VIX 35 fires, 34.9 does not', () => {
    assert.equal(checkMarket({ vix: { close: 35, date: TODAY }, qqq: q(0) }).state, 'TRIGGERED');
    assert.equal(checkMarket({ vix: { close: 34.9, date: TODAY }, qqq: q(0) }).state, 'CLEAR');
  });
  test('QQQ -10% over 5 days fires, -9.9% does not', () => {
    assert.equal(checkMarket({ vix: { close: 20, date: TODAY }, qqq: q(-0.10) }).state, 'TRIGGERED');
    assert.equal(checkMarket({ vix: { close: 20, date: TODAY }, qqq: q(-0.099) }).state, 'CLEAR');
  });
  test('missing VIX or QQQ is unknown unless the other one fired', () => {
    assert.equal(checkMarket({ vix: null, qqq: q(0) }).state, 'UNKNOWN');
    assert.equal(checkMarket({ vix: { close: 20, date: TODAY }, qqq: { closes: [100, 99], date: TODAY } }).state, 'UNKNOWN');
    assert.equal(checkMarket({ vix: null, qqq: q(-0.2) }).state, 'TRIGGERED');
  });
  test('one market alert for the whole book, not one per stock', () => {
    const r = evaluateBusinessAlerts({ mode: 'on', today: TODAY, state: null, market: { vix: { close: 40, date: TODAY }, qqq: q(0) },
      holdings: [H([], { revenueGrowth: 0.1 }), H([], { revenueGrowth: 0.1 }, { ticker: 'BBB' })] });
    assert.equal(r.fresh.filter((f) => f.check.id === 'MARKET').length, 1);
    assert.equal(r.telegram.filter((t) => t.key === 'MARKET|MARKET').length, 1);
    assert.ok(r.holdings.every((h) => h.checks.every((c) => c.id !== 'MARKET')));
  });
  test('a buy point, never an exit: ONE Telegram line even in shadow; the stock alerts stay report-only', () => {
    const r = evaluateBusinessAlerts({ mode: 'shadow', today: TODAY, state: null, market: { vix: { close: 40, date: TODAY }, qqq: q(0) },
      holdings: [H([], { revenueGrowth: -0.2 })] });
    assert.equal(r.holdings[0]!.status, 'ALERT');
    assert.deepEqual(r.telegram.map((t) => t.key), ['MARKET|MARKET'], 'only the market line in shadow');
    const line = r.telegram[0]!.line;
    assert.ok(line.startsWith('🟢 ' + MARKET_BUY_POINT + ': VIX 40.0 >= 35'), line);
    assert.match(line, /27 of 28 since 2008 higher a year later/);
    assert.match(line, /Not an exit\.$/);
    assert.ok(!line.includes('\n'), 'one line');
    const view = businessAlertsView(r);
    assert.ok(view.market.text.startsWith('BUY POINT. ' + MARKET_BUY_POINT + ': VIX 40.0'), view.market.text);
    assert.ok(view.intro[0]!.includes('never an exit') && view.intro[0]!.includes('even in shadow'));
    assert.ok(businessAlertsLogLines(r).some((l) => l.startsWith('market shock (buy point, never an exit): ' + MARKET_BUY_POINT)));
    // mode 'on': the stock line and the market line, each once
    const on = evaluateBusinessAlerts({ mode: 'on', today: TODAY, state: null, market: { vix: { close: 40, date: TODAY }, qqq: q(0) }, holdings: [H([], { revenueGrowth: -0.2 })] });
    assert.deepEqual(on.telegram.map((t) => t.key).sort(), ['AAA|REVENUE', 'MARKET|MARKET']);
    // no shock: no market line, and the neutral wording is unchanged
    const calm = evaluateBusinessAlerts({ mode: 'shadow', today: TODAY, state: null, market: { vix: { close: 20, date: TODAY }, qqq: q(0) }, holdings: [] });
    assert.equal(calm.telegram.length, 0);
    assert.ok(businessAlertsView(calm).market.text.startsWith('No alert. Market shock: VIX 20.0'));
  });
  test('the buy point is sent at most once per 10 trading days (QQQ bars; weekdays without them)', () => {
    const days: string[] = [];
    for (let d = '2026-10-01'; d <= '2026-12-31'; d = addDays(d, 1)) { const w = new Date(d + 'T12:00:00Z').getUTCDay(); if (w !== 0 && w !== 6 && d !== '2026-11-26') days.push(d); }
    const shock = (today: string) => ({ vix: { close: 40, date: today }, qqq: { closes: [100, 100, 100, 100, 100, 100], date: today, dates: days.filter((d) => d <= today) } });
    const st = markSent(EMPTY_STATE, 'MARKET|MARKET', '2026-11-16');
    const nth = (n: number) => days[days.indexOf('2026-11-16') + n]!;
    assert.equal(evaluateBusinessAlerts({ mode: 'shadow', today: nth(9), state: st, market: shock(nth(9)), holdings: [] }).telegram.length, 0, '9 trading days later');
    assert.equal(nth(9), '2026-11-30', 'the Thanksgiving holiday is not a trading day');
    assert.equal(evaluateBusinessAlerts({ mode: 'shadow', today: nth(10), state: st, market: shock(nth(10)), holdings: [] }).telegram.length, 1, '10 trading days later');
    assert.equal(tradingDaysAfter('2026-11-06', '2026-11-20'), 10, 'weekdays without QQQ dates');
    assert.equal(tradingDaysAfter('2026-11-06', '2026-11-08'), 0);
    assert.equal(R.marketDedupeTradingDays, 10);
  });
});

describe('book, dedupe and modes', () => {
  const market = { vix: { close: 20, date: TODAY }, qqq: { closes: [1, 1, 1, 1, 1, 1], date: TODAY } };
  const bad = H([], { revenueGrowth: -0.2, source: 'FMP fresh' });
  test('shadow: no Telegram lines; on: one line per new trigger', () => {
    assert.equal(evaluateBusinessAlerts({ mode: 'shadow', today: TODAY, state: null, market, holdings: [bad] }).telegram.length, 0);
    const on = evaluateBusinessAlerts({ mode: 'on', today: TODAY, state: null, market, holdings: [bad] });
    assert.equal(on.telegram.length, 1);
    assert.ok(!on.telegram[0]!.line.includes('\n'));
    assert.match(on.telegram[0]!.line, /^Business alert AAA: Revenue growth: .*FMP fresh, 2026-11-07\)\. Shadow: no verdict changed\.$/);
  });
  test('dedupe: the same trigger is not new again within 30 days, and is after', () => {
    const n1 = evaluateBusinessAlerts({ mode: 'on', today: TODAY, state: null, market, holdings: [bad] });
    const st = { ...n1.nextState, sent: { 'AAA|REVENUE': TODAY } };
    const n2 = evaluateBusinessAlerts({ mode: 'on', today: addDays(TODAY, 29), state: st, market, holdings: [bad] });
    assert.equal(n2.fresh.length, 0);
    assert.equal(n2.telegram.length, 0);
    assert.equal(n2.holdings[0]!.status, 'ALERT', 'still shown in the report');
    const n3 = evaluateBusinessAlerts({ mode: 'on', today: addDays(TODAY, 30), state: st, market, holdings: [bad] });
    assert.equal(n3.fresh.length, 1);
    assert.equal(n3.telegram.length, 1);
  });
  test('an alert first seen in shadow (or whose line failed) is still sent once the mode is on', () => {
    const sh = evaluateBusinessAlerts({ mode: 'shadow', today: TODAY, state: null, market, holdings: [bad] });
    const on = evaluateBusinessAlerts({ mode: 'on', today: addDays(TODAY, 1), state: sh.nextState, market, holdings: [bad] });
    assert.equal(on.fresh.length, 0, 'not new for the report');
    assert.deepEqual(on.telegram.map((t) => t.key), ['AAA|REVENUE']);
  });
  test('dedupe is per stock and per trigger', () => {
    const st = { ...EMPTY_STATE, seen: { 'AAA|REVENUE': TODAY }, sent: { 'AAA|REVENUE': TODAY } };
    const r = evaluateBusinessAlerts({ mode: 'on', today: TODAY, state: st, market,
      holdings: [H([P(D90, { profitMargin: 0.5 })], { revenueGrowth: -0.2, profitMargin: 0.1 }), H([], { revenueGrowth: -0.2 }, { ticker: 'BBB' })] });
    assert.deepEqual(r.telegram.map((t) => t.key).sort(), ['AAA|MARGIN', 'BBB|REVENUE']);
  });
  test('status: unknown data never reads as clear', () => {
    const r = evaluateBusinessAlerts({ mode: 'shadow', today: TODAY, state: null, market, holdings: [H([], null)] });
    assert.equal(r.holdings[0]!.status, 'UNKNOWN');
    const v = businessAlertsView(r);
    assert.match(v.holdings[0]!.text, /^No alert\. Not known: Revenue growth, Net margin, Analyst rating, Analyst target/);
  });
  test('the SEC baseline is stored after tonight and used tomorrow', () => {
    const sec = { hits: { offering: 1, convertible: 0, dilution: 0 } };
    const n1 = evaluateBusinessAlerts({ mode: 'shadow', today: TODAY, state: null, market, holdings: [H([], {}, { sec })] });
    assert.equal(n1.nextState.sec['AAA']!.hits['offering'], 1);
    const n2 = evaluateBusinessAlerts({ mode: 'shadow', today: addDays(TODAY, 1), state: n1.nextState, market, holdings: [H([], {}, { sec: { hits: { offering: 2, convertible: 0, dilution: 0 } } })] });
    assert.equal(n2.holdings[0]!.checks.find((c) => c.id === 'SEC_DILUTION')!.state, 'TRIGGERED');
    assert.equal(n2.nextState.secNew['AAA'], addDays(TODAY, 1));
  });
  test('log lines: one per triggered holding plus a count line', () => {
    const r = evaluateBusinessAlerts({ mode: 'shadow', today: TODAY, state: null, market, holdings: [bad, H([], { revenueGrowth: 0.1 }, { ticker: 'BBB' })] });
    const lines = businessAlertsLogLines(r);
    assert.equal(lines.filter((l) => l.startsWith('business alert (shadow): AAA:')).length, 1);
    assert.ok(!lines.some((l) => l.includes('BBB:')));
    assert.match(lines.at(-1)!, /1 with an alert, 0 clear, 1 partly not known/);
  });
  test('state parse: missing or another version starts fresh', () => {
    assert.deepEqual(parseState(null), EMPTY_STATE);
    assert.deepEqual(parseState('{"v":2}'), EMPTY_STATE);
    assert.throws(() => parseState('{not json'));
  });
});

describe('profile flag exit.businessAlerts', () => {
  const base = CORE_TEST_PROFILE_INPUT as unknown as Record<string, unknown>;
  const withMode = (m: unknown) => validateProfile({ ...base, exit: { weeklyStops: true, businessAlerts: m } });
  test('default off; shadow and on accepted; anything else refused', () => {
    const d = validateProfile({ ...base, exit: { weeklyStops: true } });
    assert.ok(d.ok && d.profile.exit.businessAlerts === 'off');
    for (const m of ['off', 'shadow', 'on'] as const) { const r = withMode(m); assert.ok(r.ok && r.profile.exit.businessAlerts === m); }
    const bad = withMode('yes');
    assert.ok(!bad.ok && bad.errors.some((e) => e.includes('exit.businessAlerts')));
    assert.equal(modeOf('shadow'), 'shadow');
    assert.equal(modeOf(true), 'off');
  });
});

// ── the runner and the report ─────────────────────────────────────────────

const histRec = (date: string, ticker: string, o: Partial<FundamentalsRecord>): FundamentalsRecord => ({
  date, ticker, revenueGrowth: null, earningsGrowth: null, grossMargin: null, profitMargin: null, returnOnEquity: null, forwardPE: null, trailingPE: null,
  peg: null, priceToBook: null, debtToEquity: null, currentRatio: null, analystTarget: null, analysts: null, ratingScore: null, rating: null,
  shortInterest: null, daysToCover: null, shortPctFloat: null, holders13F: null, shares13F: null, source: 'FMP fresh', ...o,
});
const artifacts = (ticker: string, fund: Record<string, unknown>, ind: unknown = {}): TickerArtifacts =>
  ({ ticker, result: {}, status: {}, dataQuality: [], reports: {}, texts: {}, fund, fundSource: 'FMP fresh 11/7/2026', ind } as unknown as TickerArtifacts);
const chartOf = (closes: number[]): Chart => ({ closes, dates: closes.map((_, i) => new Date(Date.UTC(2026, 10, 1 + i, 21))) } as unknown as Chart);

function quietLog(lines: string[] = []): Logger { return new Logger({ sink: (l) => { lines.push(typeof l === 'string' ? l : JSON.stringify(l)); }, scope: 't', now: () => new Date(0) }); }

describe('runBusinessAlerts (I/O)', () => {
  const rows = [[...FUNDAMENTALS_HISTORY_HEADER], fundamentalsRow(histRec('2026-11-01', 'AAA', { revenueGrowth: 0.04 }))];
  const deps = (mode: 'shadow' | 'on', kv: MemoryPropertyStore, sent: string[], log: Logger) => ({
    mode, today: TODAY, timeZone: 'America/New_York', tickers: ['AAA', 'aaa', 'ETF'],
    analysis: async (t: string) => (t === 'AAA' ? artifacts('AAA', { revenueGrowth: -0.01 }) : null),
    readHistory: async () => rows,
    getChart: async (t: string) => (t === '^VIX' ? chartOf([20, 21]) : chartOf([100, 100, 100, 100, 100, 100])),
    kv, log,
    telegram: { deps: { token: 't', fetchImpl: (async (_u: unknown, init: { body: string }) => { sent.push(JSON.parse(init.body).text); return new Response(JSON.stringify({ ok: true, result: {} })); }) as unknown as typeof fetch }, chatId: 'c' },
  });
  test('history rows parse by ticker', () => {
    assert.equal(historyByTicker(rows).get('AAA')!.length, 1);
  });
  test('shadow: report and log only, nothing sent; state stored', async () => {
    const kv = new MemoryPropertyStore(), sent: string[] = [], lines: string[] = [];
    const r = await runBusinessAlerts(deps('shadow', kv, sent, quietLog(lines)));
    assert.equal(sent.length, 0);
    assert.equal(r.result.holdings.length, 2, 'tickers deduplicated');
    assert.equal(r.result.holdings[0]!.triggered[0]!.id, 'REVENUE');
    assert.equal(r.result.holdings[1]!.status, 'UNKNOWN', 'no analysis = not known');
    assert.ok(lines.some((l) => l.includes('business alert (shadow): AAA')));
    assert.ok(parseState(await kv.get(BUSINESS_ALERTS_STATE_KEY)).seen['AAA|REVENUE']);
  });
  test('on: one Telegram line per new trigger, not repeated the next night', async () => {
    const kv = new MemoryPropertyStore(), sent: string[] = [];
    await runBusinessAlerts(deps('on', kv, sent, quietLog()));
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /^Business alert AAA: Revenue growth: revenue growth turned negative/);
    await runBusinessAlerts(deps('on', kv, sent, quietLog()));
    assert.equal(sent.length, 1);
  });
  test('shadow + a market shock: the buy point goes to Telegram once, the next night is deduped', async () => {
    const kv = new MemoryPropertyStore(), sent: string[] = [];
    const d = { ...deps('shadow', kv, sent, quietLog()), getChart: async (t: string) => (t === '^VIX' ? chartOf([30, 41]) : chartOf([100, 100, 100, 100, 100, 100])) };
    await runBusinessAlerts(d);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.startsWith('🟢 Market shock — historically a buy point'), sent[0]);
    assert.equal(parseState(await kv.get(BUSINESS_ALERTS_STATE_KEY)).sent['MARKET|MARKET'], TODAY);
    await runBusinessAlerts(d);
    assert.equal(sent.length, 1);
  });
  test('a failing state store or history read degrades to "not known", never throws', async () => {
    const kv = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); }, delete: async () => {} } as unknown as MemoryPropertyStore;
    const d = { ...deps('shadow', new MemoryPropertyStore(), [], quietLog()), kv, readHistory: async () => { throw new Error('no tab'); } };
    const r = await runBusinessAlerts(d);
    assert.equal(r.result.holdings[0]!.checks.find((c) => c.id === 'REVENUE')!.state, 'UNKNOWN');
  });
});

describe('Exit report section', () => {
  const NOW = Date.UTC(2026, 10, 7, 21);
  const emptyRun = (): ExitPipelineResult => ({
    startedAtMs: NOW, holdings: [], groups: [], skipped: { crypto: [], other: [], blankRowCount: 0 }, stage0: null, stage0Failed: false, portfolioQuality: [], portfolioQualityLines: [],
    rollup: { holdingCount: 0, stockCount: 0, optionCount: 0, actionCounts: { EXIT: 0, EXPIRED: 0, REVIEW: 0, TRIM: 0, HOLD: 0, UNKNOWN: 0 }, independentSignalCount: 0,
      totals: { costBasisUsd: 0, marketValueUsd: 0, unrealizedUsd: 0, afterTaxGainUsd: 0, taxOwedUsd: 0, holdingsCounted: 0, holdingsLeftOut: 0 } },
  });
  const text = (be: MemoryWorkbookBackend): string[] => be.grid(EXIT_SHEET_TAB).flat().map((v) => String(v ?? ''));
  const view = businessAlertsView(evaluateBusinessAlerts({ mode: 'shadow', today: TODAY, state: null, market: { vix: { close: 36, date: TODAY }, qqq: null },
    holdings: [H([], { revenueGrowth: -0.2, source: 'FMP fresh' })] }));

  test('flag off (no view): no section, the sheet is unchanged', async () => {
    const be1 = new MemoryWorkbookBackend({}), be2 = new MemoryWorkbookBackend({});
    const s1 = await ReportWorkbook.open(be1, ['*']), s2 = await ReportWorkbook.open(be2, ['*']);
    buildExitSheet(s1, toExitReportInput(emptyRun()));
    buildExitSheet(s2, toExitReportInput(emptyRun(), { businessAlerts: null }));
    await s1.flush(); await s2.flush();
    assert.deepEqual(be1.grid(EXIT_SHEET_TAB), be2.grid(EXIT_SHEET_TAB));
    assert.ok(!text(be1).includes(BUSINESS_ALERTS_HEADER));
  });
  test('shadow: the section lists the market and each holding, no leaks', async () => {
    const be = new MemoryWorkbookBackend({});
    const ss = await ReportWorkbook.open(be, ['*']);
    buildExitSheet(ss, toExitReportInput(emptyRun(), { businessAlerts: view }));
    await ss.flush();
    const all = text(be);
    assert.ok(all.includes(BUSINESS_ALERTS_HEADER));
    assert.ok(all.some((t) => t.startsWith('BUY POINT. ' + MARKET_BUY_POINT + ': VIX 36.0 >= 35')));
    assert.ok(all.some((t) => t.startsWith('ALERT. Revenue growth: revenue growth -20.0%')));
    assert.ok(all.some((t) => t.includes('do not change any verdict')));
    assertNoReportLeaks(be.grid(EXIT_SHEET_TAB));
  });
  test('the step: a throwing hook shows "could not be built" and the step outcome is unchanged', async () => {
    const ctx = createContext({ mode: 'test', runId: 'r1', logger: quietLog(), clock: { now: () => NOW }, sleep: async () => {}, random: () => 0 });
    const portfolio: PortfolioResult = { stocks: [], options: [], skippedCrypto: [], skippedOther: [], blankRowCount: 0 };
    const be = new MemoryWorkbookBackend({ Portfolio: [['x']] });
    const out = await exitReportJob({
      ctx, pipeline: { portfolio, getChart: async () => null }, openWorkbook: () => ReportWorkbook.open(be, ['*']),
      businessAlerts: async () => { throw new Error('boom'); },
    })();
    assert.equal(out!.state, 'ok');
    const all = text(be);
    assert.ok(all.includes(BUSINESS_ALERTS_HEADER));
    const at = all.indexOf(BUSINESS_ALERTS_HEADER);
    assert.ok(all.slice(at + 1).some((t) => t.startsWith('Business alerts')), 'the reason line follows the header');
  });
});

describe('history check (research/businessAlertsReplayCli.ts)', () => {
  const quarters = ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31'];
  test('point in time: TTM growth and margin, dated the quarter end + the filing lag', () => {
    const pts = pointsFromQuarterly({ salesPerShare: quarters.map((period, i) => ({ period, v: i < 4 ? 10 : 9 })), netMargin: quarters.map((period) => ({ period, v: 0.1 })) }, 'S');
    assert.equal(pts.length, 2);
    assert.equal(pts[0]!.date, addDays('2025-12-31', FILING_LAG_DAYS));
    assert.ok(Math.abs(pts[0]!.revenueGrowth! - -0.1) < 1e-9);
    assert.ok(Math.abs(pts[0]!.profitMargin! - 0.1) < 1e-9);
  });
  test('forward returns: none before the series starts or past its end', () => {
    const s = { dates: ['2026-01-02', '2026-01-05', '2026-01-06'], closes: [10, 11, 12] };
    assert.equal(forward(s, '2025-12-01', 1), null);
    assert.ok(Math.abs(forward(s, '2026-01-03', 1)! - (12 / 11 - 1)) < 1e-9);
    assert.equal(forward(s, '2026-01-05', 5), null);
  });
  test('no look-ahead: a trigger on day D uses only points dated before or on D', () => {
    const pts = [P('2026-01-01', { revenueGrowth: 0.02 }), P('2026-04-01', { revenueGrowth: -0.01 }), P('2026-07-01', { revenueGrowth: 0.05 })];
    const ev = replayFundamentals('AAA', pts, undefined, { dates: ['2026-01-01'], closes: [1] });
    assert.deepEqual(ev.map((e) => [e.day, e.check.id, e.repeat]), [['2026-04-01', 'REVENUE', false]]);
  });
  test('market replay keeps the 30-day dedupe', () => {
    const dates = Array.from({ length: 40 }, (_, i) => addDays('2026-01-01', i));
    const r = replayMarket({ dates, closes: dates.map(() => 40) }, { dates, closes: dates.map(() => 100) }, new Map());
    assert.deepEqual(r.map((e) => e.day), [dates[5], addDays(dates[5]!, 30)]);
  });
});
