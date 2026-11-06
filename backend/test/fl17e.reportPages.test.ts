/**
 * FL-17e: every model on its own page, the LILO page, the All Models table and the Options Decision page
 * (owner 2026-10-28). Display only: the pages read what the run decided and never change it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { findReportLeaks } from '../src/reports/messages/leakScan.ts';
import {
  buildExtraModelsReport, everythingModel, comboModel, readExtraModels, extraModelRows, EVERYTHING_NAME, EXTRA_MODEL_NAMES, ENGINE_WYCKOFF_NAME,
  type ExtraModelsChart,
} from '../src/analysis/extraModels.ts';
import {
  formatWyckoffPage, formatTrendPage, formatComboPage, buildLiloRead, formatLiloPage, liloSummary, allModelsRows, formatAllModelsPage, writeAllModelsSheet,
  formatOptionsDecisionPage, optionsVerdict, pickVerdict, engineAloneRead, engineWithModelsRead, daysToExpiry,
  MODEL_SIMULATION, SIMULATION_NOTE, ALL_MODELS_HEADER, LILO_ORDER_DAYS, type OptionsDecisionInput,
} from '../src/analysis/reportPages.ts';
import { computeStockEntryLadder, optionsLadderTimeDecayNote } from '../src/analysis/ladders.ts';
import { trendSeries } from '../src/analysis/models/trendFollow.ts';
import { buildBottomLineSummary, BOTTOM_LINE_TAB } from '../src/reports/bottomLine/summarySheet.ts';
import { reportTabOrder } from '../src/analyzeReport.ts';
import { ANALYSIS_TAB, MODEL_TABS } from '../src/analysis/runTicker.ts';
import { OptionsTabs } from '../src/reports/options/tabs.ts';
import { renderRunText } from '../src/cli.ts';
import { TICKER_RUN_PRELOAD } from '../src/compose.ts';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { compose } from '../src/compose.ts';
import { RESULTS } from '../src/profile/results.ts';
/** Cases that read a results pack (profile `results`): skipped under a profile that names none (the test profile);
 *  a copy with its own pack runs them with its profile (npm test does not). */
const NEEDS_PACK = RESULTS ? false : 'needs a results pack (the profile names none)';

const TZ = 'America/New_York';
const NOW = Date.UTC(2026, 9, 28, 20);

function chartOf(n: number, drift: number, start = 100): ExtraModelsChart {
  const closes: number[] = [], opens: number[] = [], highs: number[] = [], lows: number[] = [], volumes: number[] = [], dates: Date[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c * (1 + drift + (i % 2 ? 0.002 : -0.002));
    opens.push(o); closes.push(c); highs.push(Math.max(o, c) * 1.005); lows.push(Math.min(o, c) * 0.995); volumes.push(1_000_000);
    dates.push(new Date(Date.UTC(2025, 0, 2) + i * 86400000));
  }
  return { dates, opens, highs, lows, closes, volumes };
}

const noLeaks = (text: string): void => { for (const l of text.split('\n')) assert.deepEqual(findReportLeaks(l), [], l); };

const CMP_BULL = { turtleDirection: 'bullish', schabackerDirection: 'bullish', edwardsMageeDirection: 'mixed' };
const CMP_MIX = { turtleDirection: 'bullish', schabackerDirection: 'cautionary', edwardsMageeDirection: 'mixed' };
const exp = (days: number): number => Math.floor(NOW / 86400000 + days) * 86400;
const cand = (strike: number, delta: number, bid: number, ask: number, e: number) => ({ strike, expUnix: e, symbol: 'X', delta, theta: 0, gamma: 0, bid, ask, iv: 0.5 });
const LEAPS = { found: true, contract: cand(100, 0.75, 30, 32, exp(400)), expUnix: exp(400), deltaFieldSeen: true,
  allCandidates: [cand(100, 0.75, 30, 32, exp(400)), cand(105, 0.72, 27, 28.5, exp(400)), cand(95, 0.78, 33, 35, exp(400)), cand(110, 0.69, 24, 25, exp(400)), cand(90, 0.81, 36, 38, exp(400))] };
const SHORT = { found: true, contract: cand(120, 0.5, 5, 5.5, exp(60)), expUnix: exp(60), deltaFieldSeen: true, allCandidates: [cand(120, 0.5, 5, 5.5, exp(60))] };
const TP_BUY = { timing: 'BUY_NOW', regime: 'TREND_UP', stop: 90, entryHigh: 104, entryLow: 98, t1: { price: 130 }, t2: { price: 150 } };
const CONF = { entryLow: 98, entryHigh: 104, entryCount: 3 };

const decisionInput = (over: Partial<OptionsDecisionInput> = {}): OptionsDecisionInput => ({
  ticker: 'TEST', leapsCall: LEAPS, shortTermCall: SHORT, decision: { action: '✅ BUY NOW', finalConviction: 80 }, techPlan: TP_BUY, fund: { score: 70 },
  confluence: CONF, flow: { available: true, leapsLean: 0.6, ivRank: 35, putCallOI: 0.7 }, nowMs: NOW, timeZone: TZ, ...over,
});

describe('FL-17e — report pages, display only', () => {
  test('options verdict: every rule', () => {
    const base = { optionsRun: true, found: true, timing: 'BUY_NOW', regime: 'TREND_UP', isBuy: true, conviction: 80 };
    assert.equal(optionsVerdict(base).verdict, 'BUY NOW');
    assert.equal(optionsVerdict({ ...base, timing: 'WAIT_PULLBACK' }).verdict, 'WAIT');
    assert.equal(optionsVerdict({ ...base, timing: 'AVOID' }).verdict, "DON'T BUY");
    assert.match(optionsVerdict({ ...base, timing: 'AVOID' }).reason, /avoid/);
    assert.equal(optionsVerdict({ ...base, isBuy: false }).verdict, "DON'T BUY");
    assert.match(optionsVerdict({ ...base, isBuy: false, conviction: 55 }).reason, /does not say buy \(conviction 55/);
    assert.equal(optionsVerdict({ ...base, isBuy: false, timing: 'WAIT_PULLBACK' }).verdict, "DON'T BUY", 'a wait on a read that is not a buy is not a wait');
    for (const regime of ['CHOP', 'HIGH_VOL', 'TREND_DOWN']) {
      const v = optionsVerdict({ ...base, timing: 'WAIT_PULLBACK', regime });
      assert.equal(v.verdict, "DON'T BUY", regime);
      assert.match(v.reason, /^No new entries/);
    }
    assert.deepEqual(optionsVerdict({ ...base, found: false }), { verdict: "DON'T BUY", reason: 'No contract was found.' });
    assert.match(optionsVerdict({ ...base, optionsRun: false }).reason, /not run/);
  });

  test('options verdict from the run: the Buy report tier-1 rule (blocked fundamentals and conviction count)', () => {
    const inp = decisionInput();
    assert.equal(pickVerdict(LEAPS, inp, true).verdict, 'BUY NOW');
    assert.equal(pickVerdict(LEAPS, { ...inp, fund: { score: 15 } }, true).verdict, "DON'T BUY", 'blocked by the fundamentals floor');
    assert.equal(pickVerdict(LEAPS, { ...inp, techPlan: { ...TP_BUY, timing: 'WAIT_PULLBACK' }, decision: { finalConviction: 72 } }, true).verdict, 'WAIT');
    assert.equal(pickVerdict(LEAPS, { ...inp, techPlan: { ...TP_BUY, timing: 'WAIT_PULLBACK' }, decision: { finalConviction: 60 } }, true).verdict, "DON'T BUY");
    assert.equal(pickVerdict({ found: false, reason: 'no chain data returned for TEST' }, inp, true).verdict, "DON'T BUY");
    assert.equal(pickVerdict(LEAPS, { ...inp, decision: null }, true).verdict, "DON'T BUY");
  });

  test('Options Decision page: BUY NOW — contract, breakeven, 3 alternatives, both exit plans, the flow', () => {
    const t = formatOptionsDecisionPage(decisionInput());
    assert.ok(t.startsWith('── TEST — Options Decision (long calls only) ──'));
    assert.ok(t.includes('1. LEAPS (the furthest expiry at least 180 days out, aiming at delta 0.75): BUY NOW'));
    assert.ok(t.includes('2. SHORT-TERM (the nearest expiry with 60 to 180 days left, aiming at delta 0.50): BUY NOW'));
    assert.ok(t.includes('  Contract: $100 call, expires ' + new Date(exp(400) * 1000).toISOString().slice(0, 10) + ' (400 days away)'), t);
    assert.ok(t.includes('Delta 0.75  ·  IV 50.0%  ·  Bid/ask $30.00 / $32.00'));
    assert.ok(t.includes('Breakeven at expiry: $132.00 (strike + ask)'));
    assert.ok(t.includes('    - $105 call, delta 0.72, bid/ask $27.00 / $28.50, breakeven $133.50'));
    assert.ok(t.includes('    - $110 call'));
    assert.ok(!t.includes('    - $90 call'), 'only the next best 3');
    assert.ok(!t.includes('    - $100 call'), 'the pick is not its own alternative');
    assert.ok(t.includes('Sell about a third at T1 (stock at $130.00), a third at T2 (stock at $150.00), and keep the rest on the trailing stop (today $90.00 on the stock).'));
    assert.ok(t.includes('Sell everything 60 days before expiry'));
    // Owner 2026-10-30: the short-term call exits on the weekly-chart rule (the D3 +50% plan is gone); 30-day hard limit kept.
    assert.ok(!t.includes('+50%'), t);
    assert.ok(t.includes('or T1 (stock at $130.00) AND weekly momentum is weakening'), t);
    assert.ok(t.includes('4. Hard limit: sell everything 30 days before expiry'));
    assert.ok(t.includes('Long-dated (LEAPS) lean: 0.60 — big money is building long-dated calls'));
    assert.ok(t.includes('IV vs this chain (percentile): 35 — where the near-term IV sits'));
    assert.ok(!/IV rank:/.test(t));
    assert.ok(t.includes('Put/call ratio (open interest, whole chain): 0.70 — more calls than puts (mildly bullish)'));
    assert.ok(!/\bputs? to buy|sell (a )?put/i.test(t));
    assert.ok(!t.includes(optionsLadderTimeDecayNote()), 'the ladder note only on a wait');
    noLeaks(t);
  });

  test('Options Decision page: WAIT shows the stock prices that trigger the options ladder rungs', () => {
    const t = formatOptionsDecisionPage(decisionInput({ techPlan: { ...TP_BUY, timing: 'WAIT_PULLBACK' }, decision: { finalConviction: 75 } }));
    assert.ok(t.includes('1. LEAPS (the furthest expiry at least 180 days out, aiming at delta 0.75): WAIT'));
    assert.ok(t.includes('Buy the same call in steps when the stock reaches:'));
    for (const r of computeStockEntryLadder(CONF)) assert.ok(t.includes('    - $' + r.price.toFixed(2) + ' ('), String(r.price));
    assert.ok(t.includes(optionsLadderTimeDecayNote()));
    noLeaks(t);
  });

  test("Options Decision page: DON'T BUY cases, no contract found, and options not run", () => {
    const avoid = formatOptionsDecisionPage(decisionInput({ techPlan: { ...TP_BUY, timing: 'AVOID', regime: 'TREND_DOWN' } }));
    assert.ok(avoid.includes("1. LEAPS (the furthest expiry at least 180 days out, aiming at delta 0.75): DON'T BUY"));
    assert.ok(avoid.includes('Why: The stock timing says avoid.'));
    const nf = formatOptionsDecisionPage(decisionInput({ shortTermCall: { found: false, reason: 'delta field appears missing from this feed -- cannot select by delta' } }));
    assert.ok(nf.includes("2. SHORT-TERM (the nearest expiry with 60 to 180 days left, aiming at delta 0.50): DON'T BUY\n  Why: No contract was found.\n  What happened: the chain has no usable delta values."), nf);
    noLeaks(nf);
    const none = formatOptionsDecisionPage(decisionInput({ leapsCall: undefined, shortTermCall: undefined, flow: { available: false } }));
    assert.ok(none.includes("VERDICT: DON'T BUY — options data was not run for this report"));
    assert.ok(!none.includes('1. LEAPS'));
    assert.ok(none.includes('No options snapshot this run.'));
    noLeaks(none);
  });

  test('days to expiry: calendar days in the report zone', () => {
    assert.equal(daysToExpiry(Date.UTC(2026, 9, 30) / 1000, Date.UTC(2026, 9, 29, 3), TZ), 2, 'still Oct 28 in New York');
    assert.equal(daysToExpiry(Date.UTC(2026, 9, 30) / 1000, Date.UTC(2026, 9, 29, 15), TZ), 1);
  });

  test('engine reads: engine alone (70+ or buy now) and engine + models (tier 1 and the 5 models agree)', () => {
    assert.equal(engineAloneRead({ finalConviction: 70 }, { timing: 'WAIT_PULLBACK' }).buy, true);
    assert.equal(engineAloneRead({ finalConviction: 40 }, { timing: 'BUY_NOW' }).buy, true);
    assert.equal(engineAloneRead({ finalConviction: 69 }, { timing: 'WAIT_PULLBACK' }).buy, false);
    assert.equal(engineAloneRead(null, null).buy, null);
    const em = (v: string | null, own = 60) => engineWithModelsRead({ finalConviction: 80 }, { timing: 'BUY_NOW' }, { score: own }, { verdict: v });
    assert.equal(em('ALL_AGREE').buy, true);
    assert.equal(em('MAJORITY').buy, true);
    assert.equal(em('SPLIT').buy, false);
    assert.equal(em('NO_CONSENSUS').buy, false);
    assert.equal(em(null).buy, false);
    assert.equal(em('ALL_AGREE', 20).buy, false);
    assert.match(em('ALL_AGREE', 20).why, /^Blocked/);
  });

  test('Everything together: engine OR combo; sell 3% under the 200-day average', () => {
    const up = chartOf(260, 0.003).closes, down = chartOf(260, -0.004).closes;
    const bull = comboModel(CMP_BULL), mix = comboModel(CMP_MIX);
    assert.equal(everythingModel({ finalConviction: 75, timing: 'WAIT_PULLBACK' }, mix, up).buy, true);
    assert.equal(everythingModel({ finalConviction: 40, timing: 'WAIT_PULLBACK' }, bull, up).buy, true);
    const no = everythingModel({ finalConviction: 40, timing: 'WAIT_PULLBACK' }, mix, down);
    assert.equal(no.buy, false);
    assert.equal(no.summary, 'No buy — the engine does not say buy and the combo is mixed.');
    const last = trendSeries(down, 200).at(-1)!;
    assert.ok(no.detail.some((d) => d.startsWith('Sell check: close $') && d.includes('($' + last.sma!.toFixed(2) + ')') && d.endsWith('so a holder would sell.')), no.detail.join('\n'));
    assert.ok(everythingModel({ finalConviction: 75, timing: 'BUY_NOW' }, bull, up).detail.at(-1)!.endsWith('so a holder keeps it.'));
    assert.equal(everythingModel(null, null, up).buy, null);
    assert.ok(no.detail.some((d) => d.startsWith('Input 1, the engine: does not say buy (conviction 40')));
    // absent unless the run passed the engine read; round trip; the Buy/Exit rows never carry it
    const r = buildExtraModelsReport('T', chartOf(260, 0.003), CMP_BULL, {}, TZ, { finalConviction: 40, timing: 'AVOID' });
    assert.equal(r.everything!.buy, true);
    assert.equal(buildExtraModelsReport('T', chartOf(260, 0.003), CMP_BULL, {}, TZ).everything, undefined);
    assert.deepEqual(readExtraModels(JSON.parse(JSON.stringify(r))), r);
    assert.ok(!extraModelRows(r).some(([l]) => l === EVERYTHING_NAME));
    const withE = extraModelRows(r, { withEverything: true }).map(([l]) => l);
    assert.equal(withE.indexOf(EVERYTHING_NAME), withE.indexOf(EXTRA_MODEL_NAMES.COMBO_TSE) + 1);
  });

  test('Bottom Line: the Everything together line right after the combo line', async () => {
    const r = buildExtraModelsReport('TEST', chartOf(260, 0.003), CMP_BULL, {}, TZ, { finalConviction: 50, timing: 'WAIT_PULLBACK' });
    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
    buildBottomLineSummary(wb, 'TEST', { score: 70, verdict: 'Good' }, { techScore: 60, timing: 'WAIT_PULLBACK', regime: 'TREND_UP', entryCount: 0, entryLow: 1, entryHigh: 2 },
      { action: 'x', finalConviction: 50 }, null, null, { clock: { now: () => NOW }, timeZone: TZ, extraModels: r });
    const g = wb.getSheetByName(BOTTOM_LINE_TAB)!.grid().map((row) => row.map((v) => String(v ?? '')));
    const labels = g.map((row) => row[0]);
    const combo = labels.indexOf('🧩 ' + EXTRA_MODEL_NAMES.COMBO_TSE);
    assert.ok(combo > 0);
    assert.equal(labels[combo + 1], '🧩 ' + EVERYTHING_NAME);
    assert.equal(g[combo + 1]![1], 'Buy — the 2-of-3 combo is bullish.');
    assert.equal(labels[combo + 2], '🏛️ ' + ENGINE_WYCKOFF_NAME);
  });

  test('Wyckoff, Trend and Combo pages: each model on its own page', () => {
    const r = buildExtraModelsReport('TEST', chartOf(260, 0.003), CMP_BULL, { wyckoffSchematic: { phase: 'ACCUMULATION', stage: 'SOS/SOW', read: 'Sign of strength' } }, TZ, { finalConviction: 50, timing: 'WAIT_PULLBACK' });
    const w = formatWyckoffPage(r, 'TEST');
    assert.ok(w.startsWith('── TEST — Wyckoff Model ──'));
    assert.ok(w.includes('1. WYCKOFF (ORIGINAL METHOD): '));
    assert.ok(w.includes('2. WYCKOFF (OLDER ENGINE READ, RECTANGLE-BASED) — FOR REFERENCE: Found\n  - Accumulation, stage SOS/SOW — Sign of strength'));
    assert.ok(!w.includes('TREND'));
    const t = formatTrendPage(r, 'TEST');
    assert.ok(t.includes('1. TREND 150 (150-DAY AVERAGE): Bullish'));
    assert.ok(t.includes('2. TREND 200 (200-DAY AVERAGE): Bullish'));
    for (const days of [150, 200]) {
      assert.ok(t.includes('  - ' + days + '-day average: $'), String(days));
    }
    assert.ok(t.includes('The average is rising'));
    assert.ok(t.includes('Rule: bullish when the close is above the average'));
    assert.ok(!t.includes('WYCKOFF'));
    const c = formatComboPage(r, 'TEST');
    assert.ok(c.includes('1. TURTLE + SCHABACKER + E&M (2 OF 3): Bullish'));
    assert.ok(c.includes('2. EVERYTHING TOGETHER (ENGINE OR COMBO): Buy'));
    assert.ok(c.includes('  - Input 2, the Turtle + Schabacker + E&M combo: bullish.'));
    assert.ok(c.includes('  - Result: BUY (the 2-of-3 combo is bullish)'));
    for (const p of [w, t, c]) noLeaks(p);
    assert.equal(formatTrendPage(null, 'X'), 'No reads — the price data was not available.');
  });

  test('LILO page: ladder placed, not a tier-1 read, and no buy zone', () => {
    const placed = buildLiloRead(CONF, TP_BUY, { finalConviction: 80 });
    assert.equal(placed.placed, true);
    assert.deepEqual(placed.entryRungs.map((r) => r.price), [104, 101, 98]);
    assert.deepEqual(placed.entryPercents, [33, 33, 34]);
    assert.deepEqual(placed.exitRungs.map((r) => r.price), [130, 150]);
    const t = formatLiloPage('TEST', placed, { leapsCall: LEAPS, optionsRun: true });
    assert.ok(t.includes('1. TODAY: LADDER PLACED'));
    assert.ok(t.includes('  $98.00 to $104.00 (3 price-level methods agree)'));
    assert.ok(t.includes('  Rung 1: buy 33% of the position at $104.00'));
    assert.ok(t.includes('  Rung 3: buy 34% of the position at $98.00'));
    assert.ok(t.includes('  T1: sell 50% of the position at $130.00'));
    assert.ok(t.includes('  T2: sell 50% of the position at $150.00'));
    assert.ok(t.includes('  $90.00 — if the price falls to it'));
    assert.ok(t.includes('the $100 call'));
    assert.ok(t.includes('  Rung 2: buy 33% of the contracts when the stock reaches $101.00'));
    assert.ok(t.includes(optionsLadderTimeDecayNote()));
    assert.ok(t.includes('wait as limit buys for ' + LILO_ORDER_DAYS + ' trading days'));
    assert.ok(t.includes('LILO only applies on a tier-1 buy read'));
    noLeaks(t);
    const notTier1 = buildLiloRead(CONF, { ...TP_BUY, timing: 'WAIT_PULLBACK' }, { finalConviction: 60 });
    assert.equal(notTier1.placed, false);
    assert.match(liloSummary(notTier1), /^No ladder — Not a tier-1 buy read today \(conviction 60/);
    const noZone = buildLiloRead({ entryLow: 98, entryHigh: 104, entryCount: 0 }, TP_BUY, { finalConviction: 80 });
    assert.equal(noZone.placed, false);
    assert.match(noZone.why, /no price-level methods agreed/);
    assert.ok(formatLiloPage('TEST', noZone, { optionsRun: false }).includes('None — no price-level methods agreed on a buy zone today.'));
    assert.equal(buildLiloRead(null, null, null).placed, null);
  });

  test('All Models: one row per model, in order, with the simulation columns and the reference rows', { skip: NEEDS_PACK }, async () => {
    const extra = buildExtraModelsReport('TEST', chartOf(260, 0.003), CMP_BULL, {}, TZ, { finalConviction: 80, timing: 'BUY_NOW' });
    const cmp = { existingDirection: 'bullish', newDirection: 'cautionary', schabackerDirection: 'bullish', edwardsMageeDirection: 'mixed', turtleDirection: 'bullish',
      newHeadline: 'Net read leans cautionary. More.', schabackerHeadline: 'Net read leans supportive', verdict: 'MAJORITY' };
    const lilo = buildLiloRead(CONF, TP_BUY, { finalConviction: 80 });
    const rows = allModelsRows({ decision: { finalConviction: 80 }, techPlan: TP_BUY, fund: { score: 60 }, comparison: cmp, extra, lilo });
    assert.deepEqual(rows.map((r) => r.model), [
      'Engine alone', 'Engine + models (current Buy report rule)', 'Broker Course', 'Schabacker', 'Edwards & Magee', 'Turtle', 'Wyckoff (original method)',
      'Wyckoff (older engine read)', 'Trend 150', 'Trend 200', 'Combo (Turtle + Schabacker + E&M, 2 of 3)', 'Everything together (engine or combo)', 'LILO (staged ladder)',
    ]);
    const read = Object.fromEntries(rows.map((r) => [r.key, r.read]));
    assert.deepEqual(read, {
      ENGINE: 'Buy', ENGINE_MODELS: 'Buy', BROKER: 'Cautionary', SCHABACKER: 'Bullish', EDWARDS_MAGEE: 'Mixed', TURTLE: 'Bullish', WYCKOFF_CLASSIC: read['WYCKOFF_CLASSIC'],
      WYCKOFF_ENGINE: 'None', TREND_150: 'Bullish', TREND_200: 'Bullish', COMBO_TSE: 'Bullish', EVERYTHING: 'Buy', LILO: 'Ladder placed',
    });
    assert.ok(['Bullish', 'Mixed', 'Cautionary'].includes(read['WYCKOFF_CLASSIC']!));
    assert.equal(rows[2]!.why, 'Net read leans cautionary.');
    assert.equal(rows[4]!.why, 'See the Edwards & Magee Model page.');
    for (const r of rows) { assert.equal(r.trades, MODEL_SIMULATION[r.key]!.trades); assert.equal(r.history, MODEL_SIMULATION[r.key]!.history); }
    assert.equal(MODEL_SIMULATION.TURTLE!.history, '+1245% / +244% / +777%');
    assert.equal(MODEL_SIMULATION.EVERYTHING!.history, '+994% / +136% / +400% (shares half); LEAPS half +104% / -63% / +980% (approximate: synthetic LEAPS, phase 4)');
    // nothing ran: every row says so, nothing throws
    const empty = allModelsRows({ decision: null, techPlan: null, fund: null, comparison: null, extra: null, lilo: null });
    assert.equal(empty.length, 13);
    assert.ok(empty.every((r) => r.read === 'Not available'), JSON.stringify(empty.map((r) => r.read)));
    const text = formatAllModelsPage('TEST', rows);
    assert.ok(text.includes(ALL_MODELS_HEADER.join(' | ')));
    assert.ok(text.includes('📊 Hold QQQ |  |  |  | +269% / +68% / +58%'));
    assert.ok(text.includes("📊 Hold the owner's 14 equally |  |  |  | +470% / +187% / +287%"));
    assert.ok(text.includes(SIMULATION_NOTE));
    noLeaks(text);
    const be = new MemoryWorkbookBackend({});
    const wb = await ReportWorkbook.open(be, ['*']);
    writeAllModelsSheet(wb.insertSheet(MODEL_TABS.allModels), 'TEST', rows, '#1a237e');
    const g = wb.getSheetByName(MODEL_TABS.allModels)!.grid().map((row) => row.map((v) => String(v ?? '')));
    const h = g.findIndex((row) => row[0] === 'Model');
    assert.deepEqual(g[h], [...ALL_MODELS_HEADER]);
    assert.deepEqual(g.slice(h + 1, h + 14).map((row) => row[0]), rows.map((r) => r.model));
    assert.deepEqual(g[h + 1], [rows[0]!.model, rows[0]!.read, rows[0]!.why, rows[0]!.trades, rows[0]!.history]);
    assert.equal(g[h + 14]![0], '📊 Hold QQQ');
    assert.ok(g.some((row) => row[0] === SIMULATION_NOTE));
  });

  test('the Model Comparison tab is unchanged: All Models does not touch the comparison', () => {
    const cmp = Object.freeze({ verdict: 'SPLIT', turtleDirection: 'bullish' });
    const rows = allModelsRows({ decision: { finalConviction: 80 }, techPlan: TP_BUY, fund: { score: 60 }, comparison: cmp, extra: null, lilo: null });
    assert.equal(rows[1]!.read, 'No buy');
    assert.match(rows[1]!.why, /split 2 against 2/);
  });

  test('PDF order: Bottom Line, All Models, Analysis, each model, LILO, comparison, Options Decision, the options tabs', () => {
    assert.deepEqual(reportTabOrder(), [
      BOTTOM_LINE_TAB, '🧮 All Models', ANALYSIS_TAB, '📚 Broker Model', '📜 Schabacker Model', '📖 Edwards & Magee Model', '🐢 Turtle Model',
      '🏛️ Wyckoff Model', '🪤 James — Market Maker Stages', '📈 Trend Model', '🧩 Combo Models', '🪜 LILO Model', '🪜 James — LILO v2', '💰 James — Profit-Taking', '↩️ James — Mean Reversion', '🔁 James — Pair Rotation', '🏆 James — Winners & Layering', '🔄 James — Multi-Year Cycle', '✅ James — Quality Gate', '🔀 Model Comparison', '📞 Options Decision', '🎯 James — LEAPS', '⚖️ James — Option Fair Value',
      OptionsTabs.DASHBOARD, OptionsTabs.TOP10, OptionsTabs.CALLS, OptionsTabs.BUCKETS, OptionsTabs.GAMMA,
    ]);
    for (const t of Object.values(MODEL_TABS)) { assert.ok(reportTabOrder().includes(t), t); assert.ok(TICKER_RUN_PRELOAD.includes(t), t); }
  });

  const B = fixturesPresent() ? fixtureBodies() : {};
  const net: HttpTransport = {
    async send(req: HttpRequest): Promise<HttpResponse> {
      const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(req.url);
      const t = m ? decodeURIComponent(m[1]!) : null;
      if (t && B[t]) return new HttpResponse(200, new TextEncoder().encode(B[t]));
      return new HttpResponse(404, new TextEncoder().encode('not found'));
    },
  };
  const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: TZ };

  test('end to end (offline fixtures): every new page written and printed; the decision unchanged by them', { skip: fixturesPresent() ? false : 'fixtures missing' }, async () => {
    const c = await compose({ storage: 'memory', env: ENV, transport: net, clock: clockAfterFixtures(), logSink: () => {}, sleep: async () => {} });
    const art = await c.analyze('TSLA', false, false, LEAPS, { found: false, reason: 'no call contracts found for TSLA' });
    assert.equal(art.aborted, undefined);
    for (const t of [MODEL_TABS.wyckoff, MODEL_TABS.trend, MODEL_TABS.combo, MODEL_TABS.lilo, MODEL_TABS.allModels, MODEL_TABS.optionsDecision]) {
      assert.ok(c.workbook.getSheetByName(t), t + ' written');
      assert.ok(art.texts[t], t + ' text');
      noLeaks(art.texts[t]!);
    }
    const text = renderRunText(art, c.workbook, c.timeZone);
    for (const t of Object.values(MODEL_TABS)) assert.ok(text.includes('══════ ' + t), t);
    const d = art.result!.decision, tp = art.result!.techPlan;
    const ev = art.reports.extraModels!.everything!;
    assert.equal(ev.buy, (tp.timing === 'BUY_NOW' || d.finalConviction >= 70) || art.reports.extraModels!.models[3]!.direction === 'bullish');
    assert.ok(art.texts[MODEL_TABS.optionsDecision]!.includes('Contract: $100 call'));
    assert.ok(art.texts[MODEL_TABS.optionsDecision]!.includes('What happened: the chain has no calls.'));
    assert.equal(art.texts[MODEL_TABS.lilo], formatLiloPage('TSLA', buildLiloRead(art.confluence, tp, d), { leapsCall: LEAPS, optionsRun: true }));
    // the same run without the picks: the decision is identical (the pages read it, never change it)
    const c2 = await compose({ storage: 'memory', env: ENV, transport: net, clock: clockAfterFixtures(), logSink: () => {}, sleep: async () => {} });
    const art2 = await c2.analyze('TSLA');
    assert.deepEqual(art2.result!.decision, d);
    assert.ok(art2.texts[MODEL_TABS.optionsDecision]!.includes("VERDICT: DON'T BUY — options data was not run"));
  });

  test('legacy-parity mode writes none of the new pages', { skip: fixturesPresent() ? false : 'fixtures missing' }, async () => {
    const c = await compose({ storage: 'memory', env: ENV, transport: net, clock: clockAfterFixtures(), logSink: () => {}, sleep: async () => {}, legacyParity: true });
    const art = await c.analyze('TSLA');
    for (const t of [MODEL_TABS.wyckoff, MODEL_TABS.trend, MODEL_TABS.combo, MODEL_TABS.lilo, MODEL_TABS.allModels, MODEL_TABS.optionsDecision]) {
      assert.equal(art.texts[t], undefined, t);
    }
  });
});

