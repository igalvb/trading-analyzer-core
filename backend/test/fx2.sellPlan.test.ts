/**
 * F-X2: sell quantities, the staged plan and the remembered targets (Exit Target History), direct tests plus a
 * four-night dry run of the Exit report job on one in-memory workbook.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planAmounts, buildSellPlan, reachFit, type SellPlanInput, type StageMemory } from '../src/portfolio/sellPlan.ts';
import {
  decideAnchor, readLatestAnchors, appendAnchors, holdingKey, dayOf, EXIT_TARGET_HISTORY_SHEET, EXIT_TARGET_HISTORY_HEADERS,
  type TargetAnchor, type CurrentForAnchor,
} from '../src/stores/exitTargetHistory.ts';
import { buildSellPlans } from '../src/jobs/exit/sellPlans.ts';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../src/sheets/reportSheet.ts';
import { findReportLeaks, assertNoReportLeaks } from '../src/reports/messages/leakScan.ts';
import { exitReportJob } from '../src/jobs/exit/exitReportStep.ts';
import { EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';
import { daysToReach, type ExitPipelineDeps } from '../src/jobs/exit/exitPipeline.ts';
import { computeExitTax } from '../src/portfolio/exitTax.ts';
import type { Chart } from '../src/types/chart.ts';
import type { PortfolioResult, StockHolding, OptionHolding } from '../src/sheets/readers/portfolio.ts';

const am = (kind: 'STOCK' | 'OPTION', cls: 'LEAPS' | 'SHORT_TERM' | 'UNCLASSIFIED' | undefined, q: number | null) => {
  const a = planAmounts(kind, cls, q);
  return a ? [a.rule, a.atT1, a.atT2, a.runner] : null;
};
const S = (over: Partial<SellPlanInput> = {}): SellPlanInput => ({ kind: 'STOCK', quantity: 10, t1: 120, t2: 140, stop: 90, ...over });
const O = (over: Partial<SellPlanInput> = {}): SellPlanInput => ({ kind: 'OPTION', quantity: 2, optionClass: 'SHORT_TERM', daysToExpiry: 40, expiryThreshold: 30, t1: 120, t2: 140, ...over });
const plain = (lines: readonly string[]): void => {
  for (const l of lines) { assert.deepEqual(findReportLeaks(l), [], l); assert.ok(!/%|probab\w* of|\bcache\b/i.test(l.replace('No probability is shown', '')), 'no percentage / probability figure / cache word: ' + l); }
};

describe('F-X2 -- the split (owner rules 1-4)', () => {
  test('stocks and LEAPS: a third, a third, a runner; rounded down, at least 1; short-dated: half and half', () => {
    assert.equal(am('STOCK', undefined, null), null);
    assert.equal(am('STOCK', undefined, 0), null);
    assert.equal(am('STOCK', undefined, -3), null);
    assert.deepEqual(am('STOCK', undefined, 1), ['THIRDS_RUNNER', 1, 0, 0], '1 share: the whole position at one target (a choice)');
    assert.deepEqual(am('STOCK', undefined, 2), ['THIRDS_RUNNER', 1, 1, 0]);
    assert.deepEqual(am('STOCK', undefined, 3), ['THIRDS_RUNNER', 1, 1, 1]);
    assert.deepEqual(am('STOCK', undefined, 4), ['THIRDS_RUNNER', 1, 1, 2]);
    assert.deepEqual(am('STOCK', undefined, 5), ['THIRDS_RUNNER', 1, 1, 3]);
    assert.deepEqual(am('STOCK', undefined, 7), ['THIRDS_RUNNER', 2, 2, 3]);
    assert.deepEqual(am('STOCK', undefined, 10), ['THIRDS_RUNNER', 3, 3, 4]);
    assert.deepEqual(am('STOCK', undefined, 10.5), ['THIRDS_RUNNER', 3, 3, 4.5], 'fractional shares stay with the runner');
    assert.deepEqual(am('OPTION', 'LEAPS', 5), ['THIRDS_RUNNER', 1, 1, 3]);
    assert.deepEqual(am('OPTION', 'SHORT_TERM', 1), ['HALVES_FULL_EXIT', 1, 0, 0]);
    assert.deepEqual(am('OPTION', 'SHORT_TERM', 2), ['HALVES_FULL_EXIT', 1, 1, 0]);
    assert.deepEqual(am('OPTION', 'SHORT_TERM', 3), ['HALVES_FULL_EXIT', 1, 2, 0]);
    assert.deepEqual(am('OPTION', 'SHORT_TERM', 5), ['HALVES_FULL_EXIT', 2, 3, 0]);
    assert.deepEqual(am('OPTION', 'UNCLASSIFIED', 4), ['HALVES_FULL_EXIT', 2, 2, 0], 'unknown class: the expiry-safe rule');
  });

  test('stock plan lines: how many at each target and how many remain', () => {
    const p = buildSellPlan(S());
    assert.equal(p.kind, 'THIRDS_RUNNER'); assert.equal(p.stage, 1);
    assert.deepEqual([p.sellAtT1, p.sellAtT2, p.runner], [3, 3, 4]);
    assert.equal(p.lines[0], 'Sell 3 shares at T1 and 3 at T2, keep 4 on the trailing stop (10 shares now).');
    assert.ok(p.lines.some((l) => l.includes('At T1 ($120.00)') && l.endsWith('sell 3 shares, 7 left.')), p.lines.join(' | '));
    assert.ok(p.lines.some((l) => l.includes('At T2 ($140.00)') && l.endsWith('sell 3 shares, 4 left on the trailing stop ($90.00).')), p.lines.join(' | '));
    plain(p.lines);
    const two = buildSellPlan(S({ quantity: 2 }));
    assert.equal(two.lines[0], 'Sell 1 share at T1 and 1 at T2, a full exit (2 shares now).', 'no "keep 0" wording');
    assert.ok(two.lines[3]!.endsWith('nothing left.'));
    const hit = buildSellPlan(S({ hitT1: true }));
    assert.ok(hit.lines[2]!.includes('already reached') && hit.lines[2]!.includes('sell 3 shares now'));
  });

  test('short-dated option: half and half, a full exit; any option inside its expiry window: sell all now; expired: nothing to sell', () => {
    const p = buildSellPlan(O({ quantity: 3 }));
    assert.equal(p.lines[0], 'Sell 1 contract at T1 and 2 at T2, a full exit (3 contracts now).');
    assert.equal(p.runner, 0);
    for (const [cls, thr] of [['SHORT_TERM', 30], ['LEAPS', 60]] as const) {
      const w = buildSellPlan(O({ quantity: 5, optionClass: cls, daysToExpiry: thr - 1, expiryThreshold: thr }));
      assert.equal(w.kind, 'EXIT_ALL_EXPIRY'); assert.equal(w.sellNow, 5);
      assert.equal(w.lines[0], 'Sell all 5 contracts now: the contract is ' + (thr - 1) + ' days from expiry, inside its ' + thr + '-day exit window.');
    }
    const edge = buildSellPlan(O({ quantity: 4, daysToExpiry: 30, expiryThreshold: 30 }));
    assert.equal(edge.kind, 'EXIT_ALL_EXPIRY', 'the threshold day itself is inside the window');
    const one = buildSellPlan(O({ quantity: 1, daysToExpiry: 10, expiryThreshold: 30 }));
    assert.equal(one.kind, 'EXIT_ALL_EXPIRY', 'expiry outranks the single-contract choice');
    const ex = buildSellPlan(O({ daysToExpiry: 0 }));
    assert.equal(ex.kind, 'EXPIRED'); assert.equal(ex.sellNow, 0);
    assert.equal(buildSellPlan(O({ daysToExpiry: -5 })).kind, 'EXPIRED');
    assert.equal(buildSellPlan(S({ quantity: null })).kind, 'NO_QUANTITY');
    plain([...p.lines, ...ex.lines, ...edge.lines]);
  });
});

describe('F-X2 -- a single unit: T1 and T2 as alternatives (owner rule 5)', () => {
  test('days to reach against days to expiry, a plain fit word, never a probability percentage', () => {
    assert.equal(reachFit(10, 40), 'COMFORTABLE'); // 14 calendar days <= 20
    assert.equal(reachFit(20, 40), 'TIGHT');       // 28 <= 40
    assert.equal(reachFit(40, 40), 'UNLIKELY');    // 56 > 40
    assert.equal(reachFit(null, 40), null);
    assert.equal(reachFit(10, 0), null);
    const p = buildSellPlan(O({ quantity: 1, daysToExpiry: 40, daysToT1: 10, daysToT2: 40 }));
    assert.equal(p.kind, 'SINGLE_UNIT_CHOICE');
    assert.equal(p.lines[0], 'With 1 contract the position cannot be split: sell all of it at T1, or hold all of it for T2.');
    assert.equal(p.lines[1], '• Choice 1: sell at T1 ($120.00, about 10 trading days away at the usual pace, an estimate), 40 days to expiry: comfortably before expiry.');
    assert.equal(p.lines[2], '• Choice 2: hold for T2 ($140.00, about 40 trading days away at the usual pace, an estimate), 40 days to expiry: probably after expiry at the usual pace.');
    assert.match(p.lines[3]!, /No probability is shown/);
    plain(p.lines);
    const stock1 = buildSellPlan(S({ quantity: 1, daysToT1: 3 }));
    assert.equal(stock1.kind, 'SINGLE_UNIT_CHOICE');
    assert.ok(!stock1.lines.some((l) => /expiry|probability/.test(l)), 'a stock has no expiry line');
    assert.equal(buildSellPlan(S({ quantity: 0.5 })).lines[0], 'With 0.5 shares the position cannot be split: sell all of it at T1, or hold all of it for T2.');
    assert.ok(buildSellPlan(S({ quantity: 1, t2: null })).lines[2]!.includes('T2 (no target this run)'));
  });
});

describe('F-X2 -- the staged plan (owner rule 6)', () => {
  const st = (o: number, a1: number, a2: number, rule: StageMemory['rule'] = 'THIRDS_RUNNER'): StageMemory => ({ originalQuantity: o, plannedAtT1: a1, plannedAtT2: a2, since: '2026-02-12', rule });
  test('after the first sale the rest is stage 2, not re-split; after both sales the runner only; quantity up is a new plan', () => {
    const s2 = buildSellPlan(S({ quantity: 7, stage: st(10, 3, 3) }));
    assert.equal(s2.stage, 2);
    assert.deepEqual([s2.sellAtT1, s2.runner], [3, 4]);
    assert.equal(s2.lines[0], 'Stage 2: sell 3 shares at the next target, keep 4 on the trailing stop (7 shares now).');
    assert.equal(s2.lines[1], 'The plan from Feb 12, 2026 continues: 3 shares already sold of 10. It is not split again.');
    const partial = buildSellPlan(S({ quantity: 8, stage: st(10, 3, 3) }));
    assert.deepEqual([partial.stage, partial.sellAtT1, partial.runner], [2, 4, 4], 'sold 2 of the planned 3: the rest of the target sales come next');
    const s3 = buildSellPlan(S({ quantity: 4, stage: st(10, 3, 3) }));
    assert.equal(s3.kind, 'RUNNER_ONLY'); assert.equal(s3.stage, 3);
    assert.equal(s3.lines[0], 'Both target sales are done: keep all 4 shares on the trailing stop ($90.00).');
    const up = buildSellPlan(S({ quantity: 12, stage: st(10, 3, 3) }));
    assert.deepEqual([up.stage, up.sellAtT1, up.sellAtT2, up.runner], [1, 4, 4, 4], 'quantity up: a fresh plan for the whole position');
    const halves = buildSellPlan(O({ quantity: 1, stage: st(2, 1, 1, 'HALVES_FULL_EXIT') }));
    assert.equal(halves.kind, 'SINGLE_UNIT_CHOICE', 'one contract left: the choice view');
    const h2 = buildSellPlan(O({ quantity: 3, stage: st(6, 3, 3, 'HALVES_FULL_EXIT') }));
    assert.equal(h2.lines[0], 'Stage 2: sell 3 contracts at the next target, a full exit (3 contracts now).');
    const other = buildSellPlan(S({ quantity: 7, stage: st(10, 5, 5, 'HALVES_FULL_EXIT') }));
    assert.equal(other.stage, 1, 'a remembered plan of another rule is not continued');
    plain([...s2.lines, ...s3.lines, ...h2.lines]);
  });
});

const anchor = (over: Partial<TargetAnchor> = {}): TargetAnchor => ({
  date: '2026-02-12', key: 'TSLA', ticker: 'TSLA', quantity: 10, avgCost: 80, price: 100, t1: 120, t2: 140, entryDate: '2025-03-04',
  plan: 'THIRDS_RUNNER', planStarted: '2026-02-12', planQuantity: 10, plannedAtT1: 3, plannedAtT2: 3, why: 'NEW', ...over,
});
const cur = (over: Partial<CurrentForAnchor> = {}): CurrentForAnchor => {
  const q = over.quantity ?? 10;
  return { key: 'TSLA', ticker: 'TSLA', kind: 'STOCK', quantity: q, avgCost: 80, price: 101, t1: 121, t2: 141, entryDate: '2025-03-04', amounts: planAmounts('STOCK', undefined, q)!, splitDays: [], ...over };
};

describe('F-X2 -- remembered targets (owner rule 7)', () => {
  test('re-anchor on: first sight, target reached, 90 days, a split, quantity or average cost changed; otherwise one short line', () => {
    const n = decideAnchor(null, cur(), '2026-02-12');
    assert.equal(n.why, 'NEW'); assert.equal(n.append?.planQuantity, 10);
    assert.equal(n.line, 'Exit targets saved today for later runs: T1 $121.00, T2 $141.00.');
    const same = decideAnchor(anchor(), cur(), '2026-03-01');
    assert.equal(same.append, null);
    assert.equal(same.line, 'Targets saved on Feb 12, 2026: T1 $120.00, T2 $140.00, not reached yet.');
    assert.deepEqual([same.stage.originalQuantity, same.stage.since], [10, '2026-02-12']);
    const down = decideAnchor(anchor(), cur({ quantity: 7 }), '2026-03-01');
    assert.equal(down.why, 'QUANTITY_DOWN');
    assert.deepEqual([down.stage.originalQuantity, down.stage.plannedAtT1, down.append?.planQuantity, down.append?.quantity], [10, 3, 10, 7], 'the plan is carried forward');
    const up = decideAnchor(anchor(), cur({ quantity: 12 }), '2026-03-01');
    assert.equal(up.why, 'QUANTITY_UP'); assert.equal(up.stage.originalQuantity, 12); assert.equal(up.stage.since, '2026-03-01');
    const split = decideAnchor(anchor(), cur({ quantity: 20, avgCost: 40, splitDays: ['2026-02-20'] }), '2026-03-01');
    assert.equal(split.why, 'SPLIT', 'a split wins over the quantity jump it causes');
    assert.equal(decideAnchor(anchor(), cur({ splitDays: ['2026-01-01'] }), '2026-03-01').why, null, 'a split before the anchor is old news');
    assert.equal(decideAnchor(anchor(), cur({ avgCost: 85 }), '2026-03-01').why, 'COST_CHANGED');
    assert.equal(decideAnchor(anchor(), cur({ avgCost: 80.2 }), '2026-03-01').why, null, 'a rounding-size cost change is not a new plan');
    const reached = decideAnchor(anchor(), cur({ price: 125 }), '2026-03-01');
    assert.equal(reached.why, 'TARGET_REACHED');
    assert.equal(reached.line, 'The first target saved on Feb 12, 2026 ($120.00) has been reached; the targets were saved again today.');
    assert.match(decideAnchor(anchor(), cur({ price: 150 }), '2026-03-01').line, /second target saved on Feb 12, 2026 \(\$140\.00\)/);
    assert.equal(decideAnchor(anchor(), cur(), '2026-05-12').why, null, 'Feb 12 -> May 12 is 89 days: still fresh');
    assert.equal(decideAnchor(anchor(), cur(), '2026-05-13').why, 'AGED_90_DAYS', '90 days: saved again');
    for (const d of [n, same, down, up, split, reached]) plain([d.line]);
  });

  test('the tab: append-only rows, read back from a Date, a Sheets serial number or a text date; bad rows skipped', async () => {
    assert.equal(holdingKey('OPTION', 'AAPL', 200, '2027-01-15'), 'AAPL CALL 200 2027-01-15');
    assert.equal(dayOf(new Date('2026-02-12T15:00:00Z')), '2026-02-12');
    assert.equal(dayOf(46065), '2026-02-12');
    assert.equal(dayOf('2026-02-12'), '2026-02-12');
    assert.equal(dayOf('nonsense'), null);
    const be = new MemoryWorkbookBackend({});
    let ss = await ReportWorkbook.open(be, ['*']);
    assert.equal(readLatestAnchors(ss).size, 0, 'no tab: first run');
    appendAnchors(ss, [anchor(), anchor({ key: 'AAPL', ticker: 'AAPL' })]);
    await ss.flush();
    ss = await ReportWorkbook.open(be, ['*']);
    appendAnchors(ss, [anchor({ date: '2026-03-01', quantity: 7, why: 'QUANTITY_DOWN' })]);
    await ss.flush();
    const grid = be.grid(EXIT_TARGET_HISTORY_SHEET);
    assert.deepEqual(grid[0], [...EXIT_TARGET_HISTORY_HEADERS]);
    assert.equal(grid.length, 4, 'header + 3 appended rows, none rewritten');
    assert.equal(grid[1]![14], 'NEW');
    const raw = { [EXIT_TARGET_HISTORY_SHEET]: [[...EXIT_TARGET_HISTORY_HEADERS], [46065, 'TSLA', 'TSLA', 10, 80, 100, 120, 140, '', 'THIRDS_RUNNER', new Date('2026-02-12T12:00:00Z'), 10, 3, 3, 'NEW'], ['garbage', 'X'], ['2026-02-13', 'Y', 'Y', 'ten', 1, 1, 1, 1, '', 'THIRDS_RUNNER', '', 1, 1, 1, 'NEW']] };
    const r = readLatestAnchors(await ReportWorkbook.open(new MemoryWorkbookBackend(raw as never), ['*']));
    assert.deepEqual([...r.keys()], ['TSLA']);
    assert.equal(r.get('TSLA')!.date, '2026-02-12');
    const latest = readLatestAnchors(await ReportWorkbook.open(be, ['*']));
    assert.equal(latest.get('TSLA')!.quantity, 7, 'the latest row per holding wins');
  });

  test('buildSellPlans: no plan without a verdict, an expired contract is not remembered, one row per holding key', () => {
    const base = { rowNumber: 1, status: 'OK', actionClass: 'HOLD', headline: 'Hold: x.', confidence: 'REAL', entryDateFallback: null, price: 100, stopLevel: 90, t1: 120, t2: 140, hitT1: false, hitT2: false,
      thesisInvalidated: false, stopBreached: false, read: {}, tax: computeExitTax({ quantity: 1, unitCost: 1, unitPrice: 1 }), taxLines: [], sharedThesis: null, dataQuality: [], dataQualityLines: [], notes: [] } as const;
    const st = { ...base, kind: 'STOCK', ticker: 'TSLA', shares: 10, avgCost: 80, entryDate: '2025-03-04', analysis: null } as never;
    const failed = { ...base, kind: 'STOCK', ticker: 'BAD', status: 'FAILED', actionClass: 'UNKNOWN', shares: 5, avgCost: 1, entryDate: null, analysis: null } as never;
    const expired = { ...base, kind: 'OPTION', ticker: 'MSFT', contracts: 2, strike: 300, expiry: '2026-01-16', side: 'call', avgPremium: 3, entryDate: null, underlyingHeldAsStock: false,
      expiryTrigger: { daysToExpiry: -3, threshold: 30, kind: 'SHORT_TERM', triggered: false, expired: true } } as never;
    const r = buildSellPlans([st, failed, expired], new Map(), '2026-02-12');
    assert.equal(r.byHolding.size, 2);
    assert.equal(r.byHolding.get(failed), undefined);
    assert.equal(r.byHolding.get(expired)!.plan.kind, 'EXPIRED');
    assert.deepEqual(r.append.map((a) => a.key + ':' + a.why), ['TSLA:NEW']);
    const off = buildSellPlans([st], null, '2026-02-12');
    assert.equal(off.byHolding.get(st)!.memoryLine, null);
    assert.equal(off.append.length, 0);
  });

  test('days to reach: null when reached, below the price or unknown; a number from the entry-plan estimator otherwise', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
    const chart = { ticker: 'T', dates: closes.map((_, i) => new Date(Date.UTC(2026, 0, 1 + i))), opens: closes, highs: closes.map((c) => c + 1), lows: closes.map((c) => c - 1), closes, volumes: closes.map(() => 1), splits: [], ipoDate: null, currentPrice: closes[59], prevClose: closes[58], currency: 'USD' } as unknown as Chart;
    const p = closes[59] as number;
    assert.equal(daysToReach(chart, p, p + 10, true), null);
    assert.equal(daysToReach(chart, p, p - 1, false), null);
    assert.equal(daysToReach(chart, null, 120, false), null);
    const d = daysToReach(chart, p, p + 10, false);
    assert.ok(typeof d === 'number' && d > 0, String(d));
  });
});

describe('F-X2 -- four nights, one workbook (dry run of the Exit report job)', () => {
  const day = (iso: string): number => Date.parse(iso + 'T22:00:00Z');
  const chartOf = (ticker: string, price: number): Chart => ({ ticker, dates: [new Date(0)], opens: [price], highs: [price], lows: [price], closes: [price], volumes: [1], splits: [], ipoDate: null, currentPrice: price, prevClose: price, currency: 'USD' }) as unknown as Chart;
  const sr = (cp: number) => ({ error: null, cp, unrealizedPct: 0.1, daysHeld: 50, chandelierSinceEntry: 90, stopBreached: false, t1: 120, t2: 140, hitT1: false, hitT2: false, thesisInvalidated: false, recommendation: 'HOLD', reason: 'x' });
  const stockRow = (shares: number): StockHolding => ({ ticker: 'TSLA', shares, avgCost: 80, entryDate: new Date('2025-03-04T00:00:00Z'), rowNumber: 5 });
  const optRow = (): OptionHolding => ({ ticker: 'NVDA', contracts: 1, strike: 150, expiry: new Date('2026-06-19T00:00:00Z'), side: 'call', avgPremium: 3, entryDate: new Date('2025-12-01T00:00:00Z'), rowNumber: 20 });
  const pf = (shares: number): PortfolioResult => ({ stocks: [stockRow(shares)], options: [optRow()], skippedCrypto: [], skippedOther: [], blankRowCount: 0 });
  const deps = (shares: number): ExitPipelineDeps => ({
    portfolio: pf(shares),
    getChart: async (_c, t) => chartOf(t, 100),
    analyzers: {
      stockSinceEntry: () => sr(100),
      stockFixedLookback: () => sr(100),
      optionsSinceEntry: () => ({ error: null, daysToExpiry: 90, isLeapsAtEntry: false, expiryThreshold: 30, expiryWarning: false, technical: sr(100), recommendation: 'HOLD', reason: 'x' }),
    },
  });
  const night = async (be: MemoryWorkbookBackend, iso: string, shares: number): Promise<string[]> => {
    const log = new Logger({ sink: () => {}, scope: 'fx2', now: () => new Date(0) });
    const ctx = createContext({ mode: 'test', runId: 'r', logger: log, clock: { now: () => day(iso) }, sleep: async () => {}, random: () => 0 });
    const job = exitReportJob({ ctx, pipeline: deps(shares), openWorkbook: () => ReportWorkbook.open(be, ['*']) });
    await job();
    const g = be.grid(EXIT_SHEET_TAB);
    assertNoReportLeaks(g as never);
    return g.map((r) => r.filter((v) => typeof v === 'string' && v !== '').join(' | '));
  };

  test('sell 3, then stage 2, then the runner only, then a new plan after buying more; the history tab grows by one row per change', async () => {
    const be = new MemoryWorkbookBackend({});
    const t1 = (await night(be, '2026-02-12', 10)).join('\n');
    assert.match(t1, /HOW MANY TO SELL/);
    assert.ok(t1.includes('Sell 3 shares at T1 and 3 at T2, keep 4 on the trailing stop (10 shares now).'), t1);
    assert.ok(t1.includes('Exit targets saved today for later runs: T1 $120.00, T2 $140.00.'));
    assert.ok(t1.includes('With 1 contract the position cannot be split'), 'the single contract shows T1 and T2 as alternatives');
    assert.ok(t1.indexOf('HOW MANY TO SELL') > t1.indexOf('EXIT LEVELS'), 'the block sits after the exit levels');

    const t2 = (await night(be, '2026-02-26', 7)).join('\n');
    assert.ok(t2.includes('Stage 2: sell 3 shares at the next target, keep 4 on the trailing stop (7 shares now).'), t2);
    assert.ok(t2.includes('Since Feb 12, 2026 the position went from 10 to 7; the plan continues and the targets were saved again today.'));
    assert.ok(t2.includes('Targets saved on Feb 12, 2026: T1 $120.00, T2 $140.00, not reached yet.'), 'the unchanged option holding gets one short line');

    const t3 = (await night(be, '2026-03-12', 4)).join('\n');
    assert.ok(t3.includes('Both target sales are done: keep all 4 shares on the trailing stop ($90.00).'), t3);

    const t4 = (await night(be, '2026-03-26', 12)).join('\n');
    assert.ok(t4.includes('Sell 4 shares at T1 and 4 at T2, keep 4 on the trailing stop (12 shares now).'), t4);
    assert.ok(t4.includes('You added to this position after Mar 12, 2026 (4 to 12), so this is a new plan for the whole position.'));

    const hist = be.grid(EXIT_TARGET_HISTORY_SHEET);
    assert.deepEqual(hist.slice(1).map((r) => r[1] + ':' + r[3] + ':' + r[14]), [
      'TSLA:10:NEW', 'NVDA CALL 150 2026-06-19:1:NEW', 'TSLA:7:QUANTITY_DOWN', 'TSLA:4:QUANTITY_DOWN', 'TSLA:12:QUANTITY_UP',
    ]);
    // the tax rule is untouched: 25% of the gain, shown as before
    assert.ok(t4.includes('assuming 25% tax on the gain'));
  });

  test('the history tab cannot be read: plans still shown (fresh), the report says the saved targets were not available', async () => {
    const be = new MemoryWorkbookBackend({ [EXIT_TARGET_HISTORY_SHEET]: [['Date']] });
    const log = new Logger({ sink: () => {}, scope: 'fx2', now: () => new Date(0) });
    const ctx = createContext({ mode: 'test', runId: 'r', logger: log, clock: { now: () => day('2026-02-12') }, sleep: async () => {}, random: () => 0 });
    const job = exitReportJob({ ctx, pipeline: deps(10), openWorkbook: async () => {
      const ss = await ReportWorkbook.open(be, ['*']);
      const sh = ss.getSheetByName(EXIT_TARGET_HISTORY_SHEET)!;
      (sh as unknown as { getDataRange: () => never }).getDataRange = () => { throw new Error('HTTP 500 at https://sheets.example/x'); };
      return ss;
    } });
    await job();
    const text = be.grid(EXIT_SHEET_TAB).flat().filter((v) => typeof v === 'string').join('\n');
    assert.ok(text.includes('Sell 3 shares at T1 and 3 at T2'));
    assert.ok(text.includes('Saved exit targets: The sheet could not be read.'), text.slice(0, 800));
    assert.ok(!text.includes('500') && !text.includes('https'));
  });
});
