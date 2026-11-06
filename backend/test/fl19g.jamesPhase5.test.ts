/**
 * FL-19g (James's models, phase 5): James — Quality Gate (plan 10). The SEC company facts read point-in-time (a
 * restatement is invisible before its own filing date), the revenue tag fallback and gross profit from revenue minus
 * cost, trailing-4-quarter sums from mixed 10-Q / 10-K data, each item at its threshold and "unknown" when data is
 * missing, the score out of 8 live / 7 on history, the strict and scaled gates and the size scale, the CEO table on a
 * past day, the gate in runPortfolio (absent = unchanged; blocks below the mark; a held stock is never sold for a score
 * drop), the level-choice rule, the report page / All Models row / Bottom Line line (display only), the tab order and
 * the paper account james.trend200.q6.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PriceSeries } from '../src/backtest/data.ts';
import { factsAsOf, parseCompanyFacts, quartersOf, fundamentalsAsOf, type CompanyFacts, type FactEntry } from '../src/fetch/sec/companyFacts.ts';
import { qualityScore, priceItemsSeries, passesGate, gateSizeScale, teamItem, fundInputsFromPit, QUALITY_DEFAULTS, GATE_PREREGISTERED, CEO_TABLE, loadCeoTable, type FundInputs, type CeoTable } from '../src/analysis/models/qualityGate.ts';
import { runPortfolio, type PortfolioInput } from '../src/research/portfolioLab.ts';
import { scoreBook, gateOf, chooseLevel, QG_CHOSEN, QG_HOSTS, GATE_LEVELS, GATE_SCALED_DEFAULT } from '../src/research/qualityGateCli.ts';
import { buildQualityRead, formatQualityGatePage, james5AllModelsRows, james5BottomLines, readJames5Reads, QG_PAGE_RULE, JAMES5_HISTORY } from '../src/analysis/jamesPhase5Pages.ts';
import { allModelsRows, MODEL_SIMULATION } from '../src/analysis/reportPages.ts';
import { readExtraModels } from '../src/analysis/extraModels.ts';
import { reportTabOrder } from '../src/analyzeReport.ts';
import { MODEL_TABS } from '../src/analysis/runTicker.ts';
import { FIXED_ANALYSIS_TABS } from '../src/reports/fixedTabs.ts';
import { newPaperState, paperDay, accountIds, standings, type PaperDayInput } from '../src/paper/paperTrading.ts';
import { PAPER_OWNER_LIST, LAB_LABEL, JAMES_IDS, JAMES_QG_ID, JAMES_QG_RULE, JAMES_GROUP, labHeld } from '../src/paper/paperLab.ts';
import { logRows, valuesRows } from '../src/paper/paperLog.ts';
import type { EngineRead, ExitReadResult } from '../src/backtest/engineRun.ts';
import { RESULTS } from '../src/profile/results.ts';
/** Cases that read a results pack (profile `results`): skipped under a profile that names none (the test profile);
 *  a copy with its own pack runs them with its profile (npm test does not). */
const NEEDS_PACK = RESULTS ? false : 'needs a results pack (the profile names none)';

function datesTo(last: string, n: number): string[] {
  const out: string[] = []; const d = new Date(last + 'T12:00:00Z');
  while (out.length < n) { if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}
const mk = (t: string, dates: readonly string[], closes: readonly number[], volumes?: readonly number[]): PriceSeries =>
  ({ ticker: t, dates, opens: closes, highs: closes, lows: closes, closes, volumes: volumes ?? closes.map(() => 2e6), splits: [] } as unknown as PriceSeries);
const q = (start: string, end: string, val: number, filed: string, form = '10-Q'): FactEntry => ({ start, end, val, filed, form });

// ─────────────────────────────── SEC facts, point-in-time ───────────────────────────────

describe('FL-19g — SEC company facts, point-in-time', () => {
  test('factsAsOf: a restated value is invisible before its own filing; the first filing is used up to then', () => {
    const es = [q('2023-01-01', '2023-03-31', 100, '2023-05-01'), q('2023-01-01', '2023-03-31', 90, '2024-05-01'), q('2023-04-01', '2023-06-30', 110, '2023-08-01')];
    assert.deepEqual(factsAsOf(es, '2023-04-30'), []);
    assert.deepEqual(factsAsOf(es, '2023-05-01').map((e) => e.val), [100]);
    assert.deepEqual(factsAsOf(es, '2025-01-01').map((e) => e.val), [100, 110], 'the restatement (filed 2024) never replaces the first filing');
  });
  test('parseCompanyFacts keeps the gate\'s concepts and drops entries without a filing date', () => {
    const raw = { facts: { 'us-gaap': { Revenues: { units: { USD: [{ start: '2023-01-01', end: '2023-03-31', val: 5, filed: '2023-05-01', form: '10-Q' }, { start: '2023-01-01', end: '2023-03-31', val: 6 }] } }, NetIncomeLoss: { units: { USD: [{ end: '2023-03-31', val: 1, filed: '2023-05-01' }] } } }, dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2023-04-20', val: 1000, filed: '2023-05-01' }] } } } } };
    const f = parseCompanyFacts(raw);
    assert.deepEqual(Object.keys(f).sort(), ['EntityCommonStockSharesOutstanding', 'Revenues']);
    assert.equal(f['Revenues']!.length, 1);
  });
  test('quarters from mixed 10-Q / 10-K: Q4 = the year minus Q1..Q3; trailing 4 quarters, growth, gross margin from revenue minus cost, the revenue tag fallback, dilution', () => {
    // FY2022 by old tag SalesRevenueNet (10-Q x3 + 10-K), FY2023 by the ASC 606 tag
    const rev22 = [q('2022-01-01', '2022-03-31', 100, '2022-05-01'), q('2022-04-01', '2022-06-30', 100, '2022-08-01'), q('2022-07-01', '2022-09-30', 100, '2022-11-01'), q('2022-01-01', '2022-12-31', 400, '2023-02-15', '10-K')];
    const rev23 = [q('2023-01-01', '2023-03-31', 120, '2023-05-01'), q('2023-04-01', '2023-06-30', 125, '2023-08-01'), q('2023-07-01', '2023-09-30', 130, '2023-11-01'), q('2023-01-01', '2023-12-31', 500, '2024-02-15', '10-K')];
    const cost = [...rev22, ...rev23].map((e) => ({ ...e, val: e.val * 0.4 }));
    const shares = [q('2022-10-01', '2022-12-31', 1000, '2023-02-15'), q('2023-10-01', '2023-12-31', 1050, '2024-02-15')];
    const facts: CompanyFacts = { SalesRevenueNet: rev22, RevenueFromContractWithCustomerExcludingAssessedTax: rev23, CostOfRevenue: cost, WeightedAverageNumberOfDilutedSharesOutstanding: shares };
    const qs = quartersOf([...rev22, ...rev23]);
    assert.deepEqual(qs.map((x) => x.val), [100, 100, 100, 100, 120, 125, 130, 125], 'Q4s derived: 400 - 300 and 500 - 375');
    const before = fundamentalsAsOf(facts, '2024-02-14'), after = fundamentalsAsOf(facts, '2024-02-15');
    assert.equal(before.revenueTtm, 100 + 120 + 125 + 130, 'before the 10-K: Q4 2022 + Q1-Q3 2023');
    assert.equal(after.revenueTtm, 500);
    assert.ok(Math.abs(after.revenueGrowth! - 0.25) < 1e-9);
    assert.ok(Math.abs(after.grossMargin! - 0.6) < 1e-9, 'gross profit = revenue - cost of revenue');
    assert.ok(Math.abs(after.dilution! - 0.05) < 1e-9);
    assert.equal(before.dilution, null, 'a year-earlier quarter is not public yet');
    assert.equal(after.periodEnd, '2023-12-31');
  });
});

// ─────────────────────────────── the score and the gate ───────────────────────────────

describe('FL-19g — the score', () => {
  const D = datesTo('2026-10-27', 260);
  const up = mk('NVDA', D, D.map((_, i) => 100 + i));
  const fund = (o: Partial<FundInputs>): FundInputs => ({ revenueGrowth: null, grossMargin: null, dilution: null, ps: null, peerMedianPs: null, source: 'SEC', pit: true, missing: 'no SEC data', ...o });
  test('each item at its threshold (just in / just out); unknown = no point and says "unknown", not "fails"', () => {
    const ceo: CeoTable = { source: 'made-up table', terms: { NVDA: [{ from: '1993-04-05', name: 'A Founder', founder: true }] } };
    const p = priceItemsSeries(up), i = D.length - 1;
    const at = fund({ revenueGrowth: 0.20, dilution: 0.03, grossMargin: 0.40, ps: 1.5, peerMedianPs: 1 });
    const out = fund({ revenueGrowth: 0.1999, dilution: 0.0301, grossMargin: 0.3999, ps: 1.5001, peerMedianPs: 1 });
    const a = qualityScore({ ticker: 'NVDA', day: D[i]!, prices: p, i, fund: at, history: true, ceo });
    const b = qualityScore({ ticker: 'NVDA', day: D[i]!, prices: p, i, fund: out, history: true, ceo });
    assert.deepEqual(a.items.map((x) => x.state), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    assert.deepEqual(b.items.filter((x) => [2, 3, 4, 6].includes(x.n)).map((x) => x.state), ['fail', 'fail', 'fail', 'fail']);
    const c = qualityScore({ ticker: 'NVDA', day: D[i]!, prices: p, i, fund: fund({}), history: true, ceo });
    assert.equal(c.outOf, 7); assert.equal(c.known, 3); assert.equal(c.points, 3);
    assert.ok(c.items.filter((x) => x.state === 'unknown').every((x) => x.value === 'no SEC data'));
    const live = qualityScore({ ticker: 'NVDA', day: D[i]!, prices: p, i, fund: fund({}), history: false, ceo });
    assert.equal(live.outOf, 8); assert.equal(live.items.find((x) => x.n === 5)!.state, 'unknown');
  });
  test('tradability: the 20-day average dollar volume against $50M; the chart: Trend 200 up; under 200 bars unknown', () => {
    const thin = mk('X', D, D.map(() => 10), D.map(() => 4_999_999)), fat = mk('X', D, D.map(() => 10), D.map(() => 5_000_000));
    assert.equal(priceItemsSeries(thin).dollarVolume.at(-1)! < 50e6, true);
    assert.equal(priceItemsSeries(fat).dollarVolume.at(-1), 50e6);
    assert.equal(priceItemsSeries(up).trendUp.at(-1), true);
    assert.equal(priceItemsSeries(up).trendUp[150], null);
  });
  test('the Team item on a past day from a given CEO table: founder; tenure 5+ years; an interim gap fails; no entry = unknown', () => {
    const t: CeoTable = { source: 'made-up table', terms: {
      FNDR: [{ from: '1993-04-05', name: 'A Founder', founder: true }],
      HIRE: [{ from: '2000-01-13', to: '2014-02-04', name: 'B Old', founder: false }, { from: '2014-02-04', name: 'C New', founder: false }],
      GAPX: [{ from: '1995-02-01', to: '2016-04-01', name: 'D One', founder: true }, { from: '2016-07-11', name: 'E Two', founder: false }],
    } };
    assert.equal(teamItem('FNDR', '2010-01-04', QUALITY_DEFAULTS, t).state, 'pass');
    assert.equal(teamItem('fndr', '2010-01-04', QUALITY_DEFAULTS, t).source, 'made-up table');
    assert.equal(teamItem('HIRE', '2018-01-02', QUALITY_DEFAULTS, t).state, 'fail', '3.9 years');
    assert.equal(teamItem('HIRE', '2019-02-05', QUALITY_DEFAULTS, t).state, 'pass');
    assert.equal(teamItem('GAPX', '2016-05-02', QUALITY_DEFAULTS, t).state, 'fail', 'no CEO in the gap');
    assert.equal(teamItem('NONE', '2016-05-02', QUALITY_DEFAULTS, t).state, 'unknown');
  });
  test('the CEO file next to the results pack: none = empty table (Team unknown); a bad file is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-'));
    assert.deepEqual(loadCeoTable(null, dir).terms, {});
    const none = loadCeoTable('someone', dir);
    assert.deepEqual(none.terms, {});
    assert.equal(teamItem('FNDR', '2010-01-04', QUALITY_DEFAULTS, none).state, 'unknown');
    fs.writeFileSync(path.join(dir, 'u2.ceo.json'), JSON.stringify({ source: 's', terms: { FNDR: [{ from: '1993-04-05', name: 'A', founder: true }] } }));
    assert.equal(teamItem('FNDR', '2010-01-04', QUALITY_DEFAULTS, loadCeoTable('u2', dir)).state, 'pass');
    fs.writeFileSync(path.join(dir, 'bad.ceo.json'), JSON.stringify({ terms: { X: [{ from: 1 }] } }));
    assert.throws(() => loadCeoTable('bad', dir), /not valid/);
  });
  test('the CEO table on a past day: founder; tenure 5+ years; an interim gap fails; no entry = unknown', { skip: NEEDS_PACK }, () => {
    assert.equal(teamItem('NVDA', '2010-01-04').state, 'pass');
    assert.equal(teamItem('MSFT', '2018-01-02').state, 'fail', 'Nadella from 2014-02: 3.9 years');
    assert.equal(teamItem('MSFT', '2019-02-05').state, 'pass');
    assert.equal(teamItem('AMZN', '2021-07-04').state, 'pass', 'Bezos, founder');
    assert.equal(teamItem('AMZN', '2021-07-06').state, 'fail', 'Jassy, new');
    assert.equal(teamItem('MRVL', '2016-05-02').state, 'fail', 'no CEO between Sutardja and Murphy');
    assert.equal(teamItem('MELI', '2016-05-02').state, 'unknown');
    assert.equal(Object.keys(CEO_TABLE).length, 14, 'the owner file: one entry per researched stock');
    for (const [t, terms] of Object.entries(CEO_TABLE)) for (let k = 1; k < terms.length; k++) assert.ok(terms[k - 1]!.to! <= terms[k]!.from, t + ': terms in order');
  });
  test('the gates: strict counts unknown as no point; scaled uses the pass share over the known items; the size scale', () => {
    assert.equal(passesGate({ points: 3, known: 3 }, GATE_PREREGISTERED), false, '5 of 7 as written: 3 known points never pass');
    assert.equal(passesGate({ points: 5, known: 7 }, GATE_PREREGISTERED), true);
    assert.equal(passesGate({ points: 3, known: 3 }, GATE_SCALED_DEFAULT), true);
    assert.equal(passesGate({ points: 2, known: 3 }, GATE_SCALED_DEFAULT), false, '2/3 = 0.67 < 5/7');
    assert.equal(passesGate({ points: 2, known: 3 }, GATE_LEVELS[0]!), true, '2/3 >= 4/7');
    assert.equal(passesGate({ points: 0, known: 0 }, GATE_LEVELS[0]!), false);
    assert.equal(gateSizeScale({ points: 3, known: 3 }, GATE_SCALED_DEFAULT), 1);
    assert.ok(Math.abs(gateSizeScale({ points: 1, known: 2 }, GATE_SCALED_DEFAULT) - 0.7) < 1e-9);
  });
  test('price-to-sales vs the peer median (item 6) from the filings; a missing peer median is unknown', () => {
    const f = { revenueTtm: 1000, revenueGrowth: 0.3, grossMargin: 0.5, dilutedShares: 10, dilution: 0.01, periodEnd: '2023-12-31', filed: '2024-02-15' };
    const x = fundInputsFromPit(f, 150, 1.0, 'none');
    assert.equal(x.ps, 1.5);
    const p = priceItemsSeries(up), i = D.length - 1;
    assert.equal(qualityScore({ ticker: 'NVDA', day: D[i]!, prices: p, i, fund: x, history: true }).items.find((y) => y.n === 6)!.state, 'pass');
    const y = fundInputsFromPit(f, 150, null, 'none');
    assert.equal(qualityScore({ ticker: 'NVDA', day: D[i]!, prices: p, i, fund: y, history: true }).items.find((z) => z.n === 6)!.value, 'no peer median that day');
  });
  test('scoreBook without facts: items 2, 3, 4 and 6 unknown on every day (the data this phase has)', () => {
    const b = scoreBook(new Map([['NVDA', up]]));
    const s = b.get('NVDA')!.get(D.at(-1)!)!;
    assert.deepEqual(s.items.filter((x) => x.state === 'unknown').map((x) => x.n), [...(CEO_TABLE['NVDA'] ? [] : [1]), 2, 3, 4, 6], 'item 1 too when the CEO table has no entry (the core: no table)');
  });
});

// ─────────────────────────────── the gate in runPortfolio ───────────────────────────────

describe('FL-19g — the gate on a host model', () => {
  const D = datesTo('2021-12-31', 420);
  const A = mk('AAA', D, D.map((_, i) => 50 + i * 0.5)), B = mk('BBB', D, D.map((_, i) => 40 + i * 0.3));
  const Q = mk('QQQ', D, D.map((_, i) => 100 + i * 0.1));
  const inp: PortfolioInput = { series: new Map([['AAA', A], ['BBB', B]]), reads: new Map(), qqq: Q };
  const start = D[260]!, end = D.at(-1)!;
  const o = { slots: 1, cash: 100_000, trendDays: 200 } as const;
  test('absent = unchanged; an always-true gate = the same run; the result carries gate stats only with a gate', () => {
    const a = runPortfolio('trend', ['AAA', 'BBB'], inp, start, end, o), b = runPortfolio('trend', ['AAA', 'BBB'], inp, start, end, { ...o, gate: () => true });
    assert.equal(a.finalTaxed, b.finalTaxed); assert.equal(a.trades, b.trades);
    assert.equal(a.gateStats, undefined); assert.ok(b.gateStats);
    assert.deepEqual([...a.buysByTicker.keys()], ['AAA'], 'AAA ranks first (stronger trend)');
  });
  test('the gate blocks a buy below the mark (the slot goes to the next stock) and counts it', () => {
    const r = runPortfolio('trend', ['AAA', 'BBB'], inp, start, end, { ...o, gate: (t) => t !== 'AAA' });
    assert.deepEqual([...r.buysByTicker.keys()], ['BBB']);
    assert.ok(r.gateStats!.blockedByTicker.get('AAA')! > 0);
    assert.equal(r.gateStats!.blockedByTicker.get('BBB') ?? 0, 0);
  });
  test('a held stock is not sold when its score drops (buys only)', () => {
    const r = runPortfolio('trend', ['AAA', 'BBB'], inp, start, end, { ...o, gate: (_, d) => d <= D[262]! });
    assert.equal(r.buysByTicker.get('AAA'), 1);
    assert.equal(r.trades, 1, 'bought once, never sold');
  });
  test('the size variant scales the slot; the rest stays in QQQ', () => {
    const full = runPortfolio('trend', ['AAA'], inp, start, end, { ...o }), half = runPortfolio('trend', ['AAA'], inp, start, end, { ...o, gate: () => true, sizeScale: () => 0.5 });
    assert.ok(half.qqqShare > full.qqqShare + 20);
  });
  test('the level-choice rule (plan 10 section 6): the default stays unless another level beats it and its neighbours agree in sign', () => {
    assert.equal(chooseLevel([100, 90, 90], 120, 1), 0, 'all three under the ungated host: same sign, the best is taken');
    assert.equal(chooseLevel([130, 110, 90], 120, 1), 1, '4/7 beats the default but its neighbour 5/7 is on the other side of the ungated host');
    assert.equal(chooseLevel([100, 110, 90], 120, 1), 1);
  });
  test('the chosen levels are the ones the page and the paper account use', () => {
    assert.deepEqual(QG_CHOSEN.trend200, QG_PAGE_RULE);
    assert.deepEqual(QG_CHOSEN.trend200, JAMES_QG_RULE);
    assert.deepEqual(QG_HOSTS.map((h) => h.key), ['combo', 'trend200', 'engine', 'best']);
    const book = scoreBook(new Map([['NVDA', mk('NVDA', D, D.map((_, i) => 100 + i))]]));
    assert.equal(gateOf(book, QG_CHOSEN.trend200)('NVDA', D.at(-1)!), true);
  });
});

// ─────────────────────────────── the report ───────────────────────────────

describe('FL-19g — the report page, All Models, Bottom Line (display only)', () => {
  const D = datesTo('2026-10-27', 260);
  const chart = { dates: D, closes: D.map((_, i) => 100 + i), volumes: D.map(() => 2e6) };
  test('the page renders every item with its source; item 5 is "your call"; the disclaimer; history lines', { skip: NEEDS_PACK }, () => {
    const r = buildQualityRead('MU', chart, { revenueGrowth: 0.38, grossMargins: 0.41 });
    assert.equal(r.status, 'ok'); assert.equal(r.outOf, 8);
    assert.equal(r.points, 5, 'team (Mehrotra 2017), adoption, product-market fit, chart, tradability');
    assert.equal(r.known, 5, "dilution, relative value and the use case unknown");
    assert.equal(r.passesStrict, false); assert.equal(r.passesChosen, true);
    const p = formatQualityGatePage('MU', r);
    for (const n of ['Team / People', 'Adoption', 'Dilution', 'Product-market fit', 'Use-case analog', 'Relative value', 'Chart', 'Tradability']) assert.ok(p.includes(n), n);
    assert.ok(p.includes('your call')); assert.ok(p.includes('not part of the OWN fundamentals score'));
    assert.ok(p.includes('current fundamentals (not point-in-time)'));
    assert.ok(p.includes(JAMES5_HISTORY!.trend200.gated));
    assert.ok(formatQualityGatePage('MU', buildQualityRead('MU', null, null)).includes('No price data'));
  });
  test('All Models row, Bottom Line line, the defensive reader, MODEL_SIMULATION', () => {
    const j = { quality: buildQualityRead('MU', chart, null) };
    const rows = allModelsRows({ decision: null, techPlan: null, fund: null, comparison: null, extra: null, lilo: null, james5: j });
    const row = rows.find((x) => x.key === 'QUALITY_GATE')!;
    assert.match(row.read, /^\d \/ 8 — (passes|would block)$/);
    assert.equal(row.history, MODEL_SIMULATION.QUALITY_GATE!.history);
    assert.equal(james5AllModelsRows(null)[0]!.read, 'Not available');
    assert.match(james5BottomLines(j)[0]![0], /^✅ James — Quality Gate$/);
    assert.equal(readJames5Reads({ quality: { status: 'x' } }), null);
    assert.ok(readJames5Reads(JSON.parse(JSON.stringify(j))));
    assert.ok(readExtraModels({ ticker: 'MU', models: [], engineWyckoff: { found: false, summary: '' }, james5: j })?.james5);
  });
  test('the tab follows the Multi-Year Cycle page, before the Model Comparison, in the report order and the fixed tabs', () => {
    assert.equal(MODEL_TABS.qualityGate, '✅ James — Quality Gate');
    for (const order of [reportTabOrder(), [...FIXED_ANALYSIS_TABS]]) assert.equal(order.indexOf(MODEL_TABS.qualityGate), order.indexOf(MODEL_TABS.cycle) + 1);
    assert.equal(reportTabOrder().indexOf(MODEL_TABS.comparison), reportTabOrder().indexOf(MODEL_TABS.qualityGate) + 1);
  });
});

// ─────────────────────────────── the paper account ───────────────────────────────

describe('FL-19g — the paper account james.trend200.q6', () => {
  const D = datesTo('2026-11-04', 600);
  const tickers = [...PAPER_OWNER_LIST, 'QQQ'];
  // every stock rises (Trend 200 says buy); SQZB trades thinly: no CEO entry (unknown) and under $50M a day -> 1 of 2 known -> blocked
  const series = new Map(tickers.map((t, k) => [t, mk(t, D, D.map((_, i) => 50 + i * 0.1 * (1 + (k % 4) * 0.2)), D.map(() => (t === 'SQZB' ? 1000 : 2e6)))]));
  const PD = D.slice(-3);
  const noExit = (t: string): ExitReadResult => ({ ticker: t, day: '', ok: true, actionClass: 'HOLD' as never, recommendation: 'HOLD', stopBreached: false, thesisInvalidated: false, hitT1: false, hitT2: false, t1: null, t2: null, stopLevel: null, close: null });
  const read = (ticker: string): EngineRead => ({ ticker, day: '', ok: true, finalConviction: 50, action: null, timing: 'WAIT_PULLBACK', regime: 'CHOP', entryPrice: 100, entryHigh: 101, entryConfidencePct: 50, stop: 90, ownScore: 60, blocked: false, verdict: 'MAJORITY', directions: {}, close: 100 });
  const input = (n: number): PaperDayInput => {
    const d = PD[n]!, i = D.indexOf(d);
    return { day: d, reads: [], exitRead: noExit, bars: Object.fromEntries(tickers.map((t) => [t, { open: series.get(t)!.opens[i]!, close: series.get(t)!.closes[i]! }])), lab: { reads: PAPER_OWNER_LIST.map(read), series, long: series } };
  };
  test('joins on the first night, group J, "James — " label; the gate blocks SQZB and the 📒 Paper Log says why; trades from the next open', () => {
    let s = newPaperState(['TSLA']);
    const t0 = paperDay(s, input(0));
    assert.ok(JAMES_IDS.includes(JAMES_QG_ID)); assert.ok(LAB_LABEL[JAMES_QG_ID]!.startsWith('James — Quality Gate on Trend 200'));
    assert.ok(accountIds(s).includes(JAMES_QG_ID)); assert.ok(s.joins![JAMES_QG_ID]);
    const a = s.lab!.james![JAMES_QG_ID]!;
    assert.equal(a.gate!['SQZB']!.pass, false);
    assert.match(a.gate!['SQZB']!.line, /^quality 1\/2 known of 7: fails tradability/);
    assert.ok(!a.toBuy.includes('SQZB'));
    assert.equal(a.toBuy.length, 3);
    for (const t of a.toBuy) assert.equal(a.gate![t]!.pass, true);
    const log = logRows(s, PD[0]!, t0, new Map());
    assert.ok(log.some((r) => r[2] === LAB_LABEL[JAMES_QG_ID] && r[3] === 'NOT BOUGHT' && r[4] === 'SQZB' && String(r[9]).includes('James — Quality Gate blocks it')));
    assert.ok(log.some((r) => r[2] === LAB_LABEL[JAMES_QG_ID] && r[3] === 'WILL BUY' && String(r[9]).includes('lets it through')));
    s = JSON.parse(JSON.stringify(s));
    const t1 = paperDay(s, input(1));
    assert.ok(t1.some((x) => x.strategy === JAMES_QG_ID && x.side === 'BUY' && x.ticker !== 'QQQ'));
    paperDay(s, input(2));
    assert.equal(labHeld(s.lab!, JAMES_QG_ID).filter((t) => t !== 'QQQ').length, 3);
    const st = standings(s).find((r) => r.name === LAB_LABEL[JAMES_QG_ID]);
    assert.ok(st && st.qqqSinceJoined != null, 'judged against QQQ since it joined');
    assert.ok(valuesRows(s, PD[2]!).some((r) => r[1] === LAB_LABEL[JAMES_QG_ID] && r[2] === JAMES_GROUP));
  });
});
