/**
 * Owner complaint 2026-11-05 (EXIT on 13 of 15 holdings) and the owner rules of the same day, behind the profile flag
 * exit.weeklyStops (default OFF): stale daily breach = old signal, weekly chandelier stop on a weekly close, EXIT only
 * with all of rule A (weekly trend broken, 30%+ to the next major weekly support, fundamentals not strong) and rule B
 * (the fall beats the 25% tax cost + 10 points), coherent targets, trims only at +25% after tax, "How many to sell"
 * follows the action, options follow the underlying's weekly stop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chart } from '../src/types/chart.ts';
import {
  oldStopBreach, weeklyRead, weeklyOhlc, coherentTargets, decideWeekly, afterTaxGainPct, WEEKLY_STOPS,
  type WeeklyRead, type WeeklyDecisionInput,
} from '../src/analysis/weeklyStops.ts';
import { weeklyOverlay, optionOverlayDecision, type WeeklyOverlay } from '../src/jobs/exit/weeklyOverlay.ts';
import { weeklyPlan } from '../src/jobs/exit/sellPlans.ts';
import { exitVotes, voteSummary, type ModelVote } from '../src/analysis/exitVote.ts';
import { planAmounts } from '../src/portfolio/sellPlan.ts';
import { runExitPipeline, type ExitHoldingResult } from '../src/jobs/exit/exitPipeline.ts';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import { validateProfile } from '../src/profile/schema.ts';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';

/** Business-day bars from Monday 2019-01-07; high/low = close +/- 1. */
function chartOf(closes: number[]): Chart {
  const dates: Date[] = [];
  const d = new Date('2019-01-07T14:30:00Z');
  while (dates.length < closes.length) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const last = closes[closes.length - 1]!;
  return {
    ticker: 'TST', dates, opens: closes.slice(), highs: closes.map((c) => c + 1), lows: closes.map((c) => c - 1), closes, volumes: closes.map(() => 1e6),
    splits: [], ipoDate: null, currentPrice: last, prevClose: last, currency: 'USD',
  } as unknown as Chart;
}
const ramp = (from: number, to: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);
const wobble = (level: number, n: number): number[] => Array.from({ length: n }, (_, i) => level + (i % 2 ? 0.5 : -0.5));
const dayOf = (c: Chart, i: number): string => c.dates[i]!.toISOString().slice(0, 10);

const wr = (o: Partial<WeeklyRead>): WeeklyRead => ({
  weekClose: 100, weekDay: '2026-10-30', stop: 120, anchorClose: 150, weeklyAtr: 10, breached: true, ma40: 130, belowMa40: true, trendBroken: true,
  support: 60, supportWeek: '2025-04-07', downsidePct: 40, ...o,
});
const dIn = (o: Partial<WeeklyDecisionInput>): WeeklyDecisionInput => ({
  price: 100, weekly: wr({}), stale: null, dailyNegative: false, fundScore: 50, cost: 120, taxRate: 0.25, reachedTarget: null,
  targets: { t1: 130, t2: 160, note: null }, ...o,
});

// ── rule 1: stale breach ───────────────────────────────────────────────

test('rule 1: a daily stop broken long ago and never recovered is a stale (old) signal with its date and the move since', () => {
  const c = chartOf([...wobble(100, 30), ...ramp(100, 400, 300), ...ramp(400, 200, 50), ...wobble(200, 250)]);
  const b = oldStopBreach(c, 0)!;
  assert.equal(b.breached, true);
  assert.equal(b.stale, true);
  assert.ok((b.tradingDaysSince as number) > 250, String(b.tradingDaysSince));
  const firstIdx = c.closes.length - 1 - (b.tradingDaysSince as number);
  assert.equal(b.firstBrokenDay, dayOf(c, firstIdx));
  assert.ok(firstIdx > 330 && firstIdx < 345, 'broken early in the fall: ' + firstIdx);
  assert.ok((b.changeSincePct as number) < -40);
});

test('rule 1: a break of 10 trading days or less is fresh, not stale', () => {
  const c = chartOf([...wobble(100, 30), ...ramp(100, 400, 300), ...ramp(400, 330, 5)]);
  const b = oldStopBreach(c, 0)!;
  assert.equal(b.breached, true);
  assert.equal(b.stale, false);
  assert.ok((b.tradingDaysSince as number) <= WEEKLY_STOPS.staleTradingDays);
});

test('rule 1: price back above the stop = not breached', () => {
  const c = chartOf([...wobble(100, 30), ...ramp(100, 400, 300)]);
  assert.equal(oldStopBreach(c, 0)!.breached, false);
});

// ── rule 2: the weekly chandelier ──────────────────────────────────────

test('rule 2: weekly stop = highest weekly close of the last 26 weeks - 3 x weekly ATR(14), judged on the weekly close', () => {
  const closes = [...wobble(100, 30), ...ramp(100, 400, 300), ...ramp(400, 200, 50), ...wobble(200, 250)];
  const c = chartOf(closes);
  const w = weeklyRead(c)!;
  const { bars } = weeklyOhlc(c);
  const anchor = Math.max(...bars.slice(-26).map((b) => b.close));
  assert.equal(w.anchorClose, anchor);
  assert.ok(Math.abs(w.stop - (anchor - 3 * w.weeklyAtr)) < 1e-9);
  assert.equal(w.weekClose, bars[bars.length - 1]!.close);
  // Flat for a year after the fall: the weekly stop sits under the base, so the position is held (not the old peak stop).
  assert.equal(w.breached, false);
  assert.ok(w.stop < 200 && w.stop > 180, String(w.stop));
});

test('rule 2: the anchor is since entry when the entry is more recent than 26 weeks', () => {
  const c = chartOf([...wobble(100, 30), ...ramp(100, 400, 300), ...ramp(400, 200, 50), ...wobble(200, 50)]);
  const entryDay = dayOf(c, c.closes.length - 20);
  const w = weeklyRead(c, { entryDay })!;
  assert.ok(w.anchorClose <= 201, String(w.anchorClose));
  assert.ok(weeklyRead(c)!.anchorClose > 300);
});

test('rule 2: the unfinished current week is not used for the weekly close', () => {
  const c = chartOf([...wobble(100, 30), ...ramp(100, 400, 300), ...wobble(400, 2)]);
  const lastDay = c.dates[c.dates.length - 1]!;
  const nowMs = lastDay.getTime() + 3_600_000;
  const { bars, lastPartial } = weeklyOhlc(c, nowMs);
  const dow = lastDay.getUTCDay();
  assert.equal(lastPartial, dow !== 5);
  if (lastPartial) assert.ok(bars[bars.length - 1]!.lastDay < lastDay.toISOString().slice(0, 10));
});

test('rule A2: the next major weekly support is the nearest confirmed weekly swing low below the price', () => {
  const c = chartOf([...wobble(50, 150), ...ramp(50, 200, 250), ...ramp(200, 100, 100)]);
  const w = weeklyRead(c)!;
  assert.equal(w.support, 48.5);
  assert.ok(Math.abs((w.downsidePct as number) - ((c.closes.at(-1)! - 48.5) / c.closes.at(-1)!) * 100) < 1e-9);
  assert.equal(w.trendBroken, true);
});

// ── rule 4: coherent targets ───────────────────────────────────────────

test('targets: T1 above the price and the stop, T2 above T1, nothing above 3x the price, else "no valid target"', () => {
  // MSTR-like: T1 below the stop, T2 fine.
  const a = coherentTargets(142.5, 150, 145.08, 258.21, []);
  assert.equal(a.t1, 258.21); assert.equal(a.t2, null);
  assert.match(a.note!, /T1 \$145\.08 is below the stop/);
  // TSLA-like: T2 more than 3x the price falls back to the next resistance.
  const b = coherentTargets(385.19, 338, 610.06, 2544.38, [700, 450.5]);
  assert.equal(b.t1, 610.06); assert.equal(b.t2, 700);
  assert.match(b.note!, /T2 \$2,544\.38 is more than 3x the price/);
  // A T1 at or under the price is not a forward target.
  const c = coherentTargets(100, 80, 99, 130, [150]);
  assert.equal(c.t1, 130); assert.equal(c.t2, 150);
  // Nothing valid.
  const d = coherentTargets(100, 80, 90, 500, []);
  assert.equal(d.t1, null); assert.equal(d.t2, null);
  assert.match(d.note!, /no valid target/);
  // HQZA-like: T1 under the weekly stop, the engine's T2 becomes T1.
  const h = coherentTargets(59.4, 73.54, 66.06, 140.801, []);
  assert.equal(h.t1, 140.801); assert.equal(h.t2, null);
  assert.match(h.note!, /T1 \$66\.06 is below the stop; engine T2 \$140\.80 is used as T1/);
  // Good engine targets are kept, no note.
  assert.deepEqual(coherentTargets(100, 80, 120, 150, [130]), { t1: 120, t2: 150, note: null });
});

// ── rules A / B / C ────────────────────────────────────────────────────

test('rule A: EXIT only when the weekly trend is broken AND 30%+ to support AND fundamentals not strong', () => {
  assert.equal(decideWeekly(dIn({})).action, 'EXIT');
  const noSupport = decideWeekly(dIn({ weekly: wr({ downsidePct: 12, support: 88 }) }));
  assert.equal(noSupport.action, 'REVIEW');
  assert.match(noSupport.headline, /only 12\.0% lower \(an exit needs 30%\+\)/);
  const strong = decideWeekly(dIn({ fundScore: 75 }));
  assert.equal(strong.action, 'REVIEW');
  assert.match(strong.headline, /fundamentals are strong \(score 75\)/);
  const unknown = decideWeekly(dIn({ fundScore: null }));
  assert.equal(unknown.action, 'REVIEW');
  assert.match(unknown.headline, /cannot be confirmed weak/);
  const notBelowMa = decideWeekly(dIn({ weekly: wr({ belowMa40: false, trendBroken: false }) }));
  assert.notEqual(notBelowMa.action, 'EXIT');
});

test('rule B: a profitable position exits only when the fall beats the tax cost + 10 points; the tax cost is shown', () => {
  // cost 20, price 100: tax = 0.25 x 80 = $20 per share = 20% of the position; needs > 30% downside.
  const tight = decideWeekly(dIn({ cost: 20, weekly: wr({ downsidePct: 30 }) }));
  assert.equal(tight.action, 'REVIEW');
  assert.match(tight.headline, /does not beat the tax cost \(20\.0%\) \+ 10 points/);
  assert.ok(tight.lines.some((l) => l === 'Tax cost if sold now: $20.00 per share (20.0% of the position, 25% of the gain).'));
  assert.equal(decideWeekly(dIn({ cost: 20, weekly: wr({ downsidePct: 31 }) })).action, 'EXIT');
  // A loss: no tax cost, the tax-loss note, rule A still applies.
  const loss = decideWeekly(dIn({ cost: 120 }));
  assert.ok(loss.lines.some((l) => /no tax cost if sold; the loss may offset other gains/.test(l)));
  assert.equal(loss.taxCostPct, 0);
});

test('rule C: a reached target is a TRIM only at +25% over the cost after tax', () => {
  const noTrend = wr({ breached: false, belowMa40: false, trendBroken: false, stop: 80 });
  assert.equal(afterTaxGainPct(150, 100, 0.25), 37.5);
  const ok = decideWeekly(dIn({ weekly: noTrend, cost: 100, price: 150, reachedTarget: 150 }));
  assert.equal(ok.action, 'TRIM');
  const thin = decideWeekly(dIn({ weekly: noTrend, cost: 100, price: 120, reachedTarget: 120 }));
  assert.equal(thin.action, 'HOLD');
  assert.match(thin.headline, /only \+15\.0% over your cost after tax \(a trim needs \+25%\)/);
  const t1Thin = decideWeekly(dIn({ weekly: noTrend, cost: 100, price: 105, targets: { t1: 110, t2: 160, note: null } }));
  assert.equal(t1Thin.t1WorthTrimming, false);
});

test('rule 1 + 5: a stale breach with an intact weekly trend is HOLD with the old-signal note; a daily AVOID alone never exits', () => {
  const stale = { oldStop: 514.74, breached: true, firstBrokenDay: '2024-11-25', tradingDaysSince: 240, changeSincePct: -72.3, stale: true };
  const intact = wr({ breached: false, belowMa40: false, trendBroken: false, stop: 120, weekClose: 142.5 });
  const d = decideWeekly(dIn({ price: 142.5, stale, weekly: intact, dailyNegative: true }));
  assert.equal(d.action, 'HOLD');
  assert.match(d.headline, /old stop \$514\.74 broken on Nov 25, 2024, −72\.3% since \(old signal\)/);
  assert.match(d.headline, /daily technical read is negative, but the weekly trend is intact/);
  const fresh = decideWeekly(dIn({ price: 142.5, stale: { ...stale, tradingDaysSince: 4, stale: false }, weekly: intact }));
  assert.equal(fresh.action, 'REVIEW');
});

// ── rule 3: How many to sell follows the action ────────────────────────

function holding(actionClass: ExitHoldingResult['actionClass'], o: Partial<Record<string, unknown>> = {}): ExitHoldingResult {
  return {
    kind: 'STOCK', ticker: 'TST', rowNumber: 5, status: 'OK', actionClass, headline: '', confidence: 'ASSUMED', entryDateFallback: null, price: 100,
    stopLevel: 90, t1: 130, t2: 160, hitT1: false, hitT2: false, thesisInvalidated: false, stopBreached: false, read: {}, tax: {} as never, taxLines: [],
    sharedThesis: null, dataQuality: [], dataQualityLines: [], notes: [], shares: 30, avgCost: 50, entryDate: '2020-01-01', analysis: null,
    weeklyStops: { lines: [], t1WorthTrimming: true, reachedTarget: null, votes: [], voteText: '' }, ...o,
  } as unknown as ExitHoldingResult;
}
test('rule 3: EXIT = sell all; REVIEW = nothing until reviewed; TRIM = a third now; HOLD with no valid target = no sale', () => {
  const am = planAmounts('STOCK', undefined, 30);
  assert.deepEqual(weeklyPlan(holding('EXIT'), 30, am)!.lines, ['Sell all 30 shares: this is an exit, not a staged plan.']);
  assert.equal(weeklyPlan(holding('EXIT'), 30, am)!.sellNow, 30);
  assert.match(weeklyPlan(holding('REVIEW'), 30, am)!.lines[0]!, /^No sale planned until you review/);
  const trim = weeklyPlan(holding('TRIM', { weeklyStops: { lines: [], t1WorthTrimming: true, reachedTarget: 150, votes: [], voteText: '' } }), 30, am)!;
  assert.equal(trim.sellNow, 10);
  assert.match(trim.lines[0]!, /Sell 10 shares now \(the target \$150\.00 was reached\)/);
  assert.match(weeklyPlan(holding('HOLD', { t1: null }), 30, am)!.lines[0]!, /no valid target/);
  assert.match(weeklyPlan(holding('HOLD', { weeklyStops: { lines: [], t1WorthTrimming: false, reachedTarget: null, votes: [], voteText: '' } }), 30, am)!.lines[0]!, /under \+25% over your cost after tax/);
  assert.equal(weeklyPlan(holding('HOLD'), 30, am), null, 'a worthwhile T1: the usual staged plan');
});

// ── rule 4: options ────────────────────────────────────────────────────

const ov = (action: WeeklyOverlay['action'], stale: WeeklyOverlay['stale'], reachedTarget: number | null = null, majority = true): WeeklyOverlay =>
  ({ action, headline: action === 'HOLD' ? 'Hold: the weekly trend is intact.' : action === 'REVIEW' ? 'Review: x.' : 'Exit: y.', lines: [], weekly: null, stale, targets: { t1: null, t2: null, note: null }, reachedTarget, decision: {} as never, votes: [], vote: { majority, text: '9 of 12 models say sell' } as never });
test('rule 4: a call never exits on a stale underlying stop; > 180 days follows the weekly stop; a short call exits on a fresh break', () => {
  const stale = { oldStop: 500, breached: true, firstBrokenDay: '2024-11-25', tradingDaysSince: 240, changeSincePct: -70, stale: true };
  const fresh = { ...stale, tradingDaysSince: 3, stale: false };
  assert.equal(optionOverlayDecision(ov('HOLD', stale), 400, true, 2).actionClass, 'HOLD');
  assert.equal(optionOverlayDecision(ov('HOLD', stale), 90, true, 2).actionClass, 'HOLD', 'LEAPS with 90 days, stale break: not an exit');
  assert.equal(optionOverlayDecision(ov('REVIEW', fresh), 400, false, 2).actionClass, 'REVIEW', '> 180 days: the weekly stop decides');
  assert.equal(optionOverlayDecision(ov('REVIEW', fresh), 120, false, 2).actionClass, 'EXIT', 'short call, fresh break, the models agree');
  assert.equal(optionOverlayDecision(ov('REVIEW', fresh, null, false), 120, false, 2).actionClass, 'REVIEW', 'short call, fresh break, the models do not agree');
  assert.equal(optionOverlayDecision(ov('EXIT', null), 400, true, 2).actionClass, 'EXIT');
  assert.equal(optionOverlayDecision(ov('HOLD', null, 150), 400, true, 2).actionClass, 'TRIM');
  assert.match(optionOverlayDecision(ov('HOLD', stale), 400, true, 2).headline, /^Hold: Long-dated call \(400 days\), follows the underlying's weekly stop/);
});

test('overlay: the old stop anchored at a multi-year peak is re-anchored to the weekly chart (HOLD, not EXIT)', () => {
  const c = chartOf([...wobble(100, 30), ...ramp(100, 400, 300), ...ramp(400, 200, 50), ...wobble(200, 250)]);
  const o = weeklyOverlay({ chart: c, read: { t1: 210, t2: 900, thesisInvalidated: true, exitCandidates: [260] }, entryDay: null, realEntry: false, price: c.closes.at(-1)!, fundScore: 40, cost: 50, taxRate: 0.25, nowMs: Date.parse('2030-01-01') });
  assert.equal(o.action, 'HOLD');
  assert.equal(o.stale!.stale, true);
  assert.equal(o.targets.t1, 210); assert.equal(o.targets.t2, 260);
});

test('fix 2026-11-06: two calls on one stock bought on different days show the same weekly stop (realEntry false)', () => {
  const c = chartOf([...wobble(100, 30), ...ramp(100, 400, 300), ...ramp(400, 200, 50), ...wobble(200, 50)]);
  const at = (k: number) => weeklyOverlay({ chart: c, read: { t1: 210, t2: 900, thesisInvalidated: false, exitCandidates: [] }, entryDay: dayOf(c, c.closes.length - k), realEntry: false, price: c.closes.at(-1)!, fundScore: 60, cost: null, taxRate: 0.25, nowMs: Date.parse('2030-01-01') });
  assert.equal(at(20).weekly?.stop, at(200).weekly?.stop);
});
// the pipeline passes realEntry: false for every option row (exitPipeline.ts)
test('fix 2026-11-06: the pipeline anchors an option on the underlying, not on its purchase date', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/jobs/exit/exitPipeline.ts', import.meta.url), 'utf8');
  assert.match(src, /read: tw, entryDay: [^\n]*, realEntry: false, price: underPrice/);
});

// ── pipeline + flag ────────────────────────────────────────────────────

test('flag: profile exit.weeklyStops defaults to false and accepts true', () => {
  const off = validateProfile(EXAMPLE_PROFILE_INPUT);
  assert.ok(off.ok); if (off.ok) assert.equal(off.profile.exit.weeklyStops, false);
  const on = validateProfile({ ...EXAMPLE_PROFILE_INPUT, exit: { weeklyStops: true } });
  assert.ok(on.ok); if (on.ok) assert.equal(on.profile.exit.weeklyStops, true);
});

test('pipeline: flag off keeps the old EXIT; flag on re-decides from the weekly chart and adds the rule lines', async () => {
  const c = chartOf([...wobble(100, 30), ...ramp(100, 400, 300), ...ramp(400, 200, 50), ...wobble(200, 250)]);
  const now = c.dates.at(-1)!.getTime() + 86_400_000 * 3;
  const mk = () => createContext({ mode: 'test', runId: 'w', logger: new Logger({ sink: () => {}, scope: 'exit', now: () => new Date(0) }), clock: { now: () => now }, sleep: async () => {}, random: () => 0 });
  const portfolio = { stocks: [{ ticker: 'TST', shares: 30, avgCost: 50, entryDate: new Date('2019-01-01T00:00:00Z'), rowNumber: 5, entryDateAssumed: true }], options: [], skippedCrypto: [], skippedOther: [], blankRowCount: 0 };
  const deps = { portfolio, getChart: async () => c };
  const off = (await runExitPipeline(mk(), deps)).holdings[0]!;
  assert.equal(off.actionClass, 'EXIT');
  assert.equal(off.weeklyStops, undefined);
  const on = (await runExitPipeline(mk(), deps, { weeklyStops: true })).holdings[0]!;
  assert.equal(on.actionClass, 'HOLD');
  assert.ok(on.weeklyStops && on.weeklyStops.lines.some((l) => /^Old daily stop: old stop \$[\d,.]+ broken on .*\(old signal\)/.test(l)));
  assert.ok((on.stopLevel as number) < 200 && (on.stopLevel as number) > 180);
  assert.equal(on.stopBreached, false);
});

test('report: under the flag an EXIT says "sell all" (never "sell N at T1"), shows the weekly stop basis and every rule checked', async () => {
  const { exitReportJob } = await import('../src/jobs/exit/exitReportStep.ts');
  const { ReportWorkbook, MemoryWorkbookBackend } = await import('../src/sheets/reportSheet.ts');
  const { EXIT_SHEET_TAB } = await import('../src/reports/exitSheet/exitSheet.ts');
  const c = chartOf([...wobble(50, 150), ...ramp(50, 200, 250), ...ramp(200, 100, 100)]);
  const now = c.dates.at(-1)!.getTime() + 86_400_000 * 3;
  const ctx = createContext({ mode: 'test', runId: 'w', logger: new Logger({ sink: () => {}, scope: 'exit', now: () => new Date(0) }), clock: { now: () => now }, sleep: async () => {}, random: () => 0 });
  const portfolio = { stocks: [{ ticker: 'TST', shares: 30, avgCost: 120, entryDate: new Date('2019-01-01T00:00:00Z'), rowNumber: 5, entryDateAssumed: true }], options: [], skippedCrypto: [], skippedOther: [], blankRowCount: 0 };
  const comparison = { existingDirection: 'cautionary', schabackerDirection: 'cautionary', edwardsMageeDirection: 'cautionary', newDirection: 'cautionary', turtleDirection: 'cautionary' };
  const pipeline = { portfolio, getChart: async () => c, getAnalysis: async () => ({ fundResult: { score: 40, verdict: 'Weak' }, comparison }) };
  const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({} as never), ['*']);
  await exitReportJob({ ctx, pipeline, openWorkbook: () => wb, rememberTargets: false, options: { weeklyStops: true } })();
  const text = wb.getSheetByName(EXIT_SHEET_TAB)!.grid().flat().map(String).join('\n');
  assert.match(text, /EXIT — the weekly trend is broken/);
  assert.match(text, /Sell all 30 shares: this is an exit, not a staged plan\./);
  assert.doesNotMatch(text, /Sell \d+ shares at T1/);
  assert.match(text, /weekly stop: the highest weekly close of the last 26 weeks minus 3 weekly ATR/);
  assert.match(text, /Exit rule check/);
  assert.match(text, /Next major weekly support \$48\.50/);
  assert.match(text, /Fundamental score 40 — below the own-worthy bar of 70\./);
  assert.match(text, /no tax cost if sold/);
  assert.match(text, /MODEL VOTE — every model's read on this holding/);
});

// ── the model vote (owner 2026-11-05: "take into account ALL the models") ──

const sellAll = { engine: 'cautionary', schabacker: 'cautionary', edwardsMagee: 'cautionary', broker: 'cautionary', turtle: 'cautionary', wyckoff: 'cautionary' } as const;
const t = (strength: number) => ({ direction: strength < -0.03 ? 'cautionary' : strength > 0 ? 'bullish' : 'mixed', sma: 100, strength } as const);
test('vote: every model gives SELL / HOLD / BUY / no read with a why; the bar is 2/3 of the reads incl. the engine and a trend model', () => {
  const v = exitVotes({ ...sellAll, trend150: t(-0.2), trend200: t(-0.2), price: 80, liloT2: 200, weekly: wr({}), fundScore: 30 });
  assert.deepEqual(v.map((x) => x.model), ['Engine', 'Schabacker', 'Edwards & Magee', 'Broker Course', 'Turtle', 'Combo 2-of-3', 'Wyckoff', 'Trend 150', 'Trend 200', 'LILO v2', 'LILO', 'Weekly chart', 'Fundamentals']);
  const s = voteSummary(v);
  assert.equal(s.sells, 12); assert.equal(s.reads, 13); assert.equal(s.majority, true);
  assert.equal(s.text, '12 of 13 models say sell (0 buy, 1 hold)');
  // Engine not selling: no exit, however many others do.
  assert.equal(voteSummary(exitVotes({ ...sellAll, engine: 'mixed', trend150: t(-0.2), trend200: t(-0.2), price: 80, weekly: wr({}), fundScore: 30 })).majority, false);
  // No trend model selling: no exit.
  const noTrend = voteSummary(exitVotes({ ...sellAll, trend150: t(0.1), trend200: t(0.1), price: 80, weekly: wr({ trendBroken: false }), fundScore: 30 }));
  assert.equal(noTrend.majority, false);
  // Missing reads are not counted against; fewer than 5 reads = no exit.
  const few = voteSummary(exitVotes({ engine: 'cautionary', price: 80, weekly: wr({}), fundScore: 30 }));
  assert.equal(few.reads, 3); assert.equal(few.majority, false);
});

test('vote + rules: rules A-C met but the models do not agree = REVIEW with the count; agreement = EXIT; a sell vote alone never exits', () => {
  const sum = (o: Partial<Parameters<typeof exitVotes>[0]>) => voteSummary(exitVotes({ ...sellAll, trend150: t(-0.2), trend200: t(-0.2), price: 100, weekly: wr({}), fundScore: 30, ...o }));
  const exit = decideWeekly(dIn({ vote: sum({}) }));
  assert.equal(exit.action, 'EXIT');
  assert.match(exit.headline, /Model vote: 12 of 12 models say sell/);
  const split = sum({ engine: 'bullish', schabacker: 'bullish', edwardsMagee: 'bullish', turtle: 'bullish', broker: 'mixed', wyckoff: 'mixed' });
  const r = decideWeekly(dIn({ vote: split }));
  assert.equal(r.action, 'REVIEW');
  assert.match(r.headline, /the models do not agree: \d+ of \d+ models say sell .*the engine does not say sell/);
  assert.ok(r.lines[0]!.startsWith('Model vote: '));
  const intact = wr({ breached: false, belowMa40: false, trendBroken: false, stop: 80 });
  const strongSell = decideWeekly(dIn({ weekly: intact, vote: sum({ weekly: intact }) }));
  assert.equal(strongSell.action, 'REVIEW');
  assert.match(strongSell.headline, /^Review: most models say sell/);
});

test('overlay: the comparison directions from the stored analysis feed the vote; chart-only models are always read', () => {
  const c = chartOf([...wobble(100, 30), ...ramp(100, 400, 300), ...ramp(400, 200, 50), ...wobble(200, 250)]);
  const o = weeklyOverlay({ chart: c, read: { t1: 210, t2: 900 }, entryDay: null, realEntry: false, price: c.closes.at(-1)!, fundScore: 40, cost: 50, taxRate: 0.25, nowMs: Date.parse('2030-01-01'),
    directions: { engine: 'cautionary', schabacker: 'mixed', edwardsMagee: null, broker: 'bullish', turtle: 'cautionary' } });
  const by = (m: string): ModelVote => o.votes.find((v) => v.model === m)!;
  assert.equal(by('Engine').read, 'SELL');
  assert.equal(by('Edwards & Magee').read, 'NA');
  assert.equal(by('Broker Course').read, 'BUY');
  assert.notEqual(by('Trend 200').read, 'NA');
  assert.notEqual(by('Wyckoff').read, 'NA');
  assert.match(o.headline, /Model vote: \d+ of \d+ models say sell/);
});
