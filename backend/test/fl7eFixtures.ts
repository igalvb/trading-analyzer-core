/**
 * Fixtures for the FL-7e dashboard tests: the legacy-side workbook adapter, the
 * real-ticker pipelines (oracle indicators, Gann, confluence, tech plan) and the
 * scenario list that drives every branch of buildDashboardV7.
 *
 * A scenario builds its inputs from a real pipeline plus a patch, so legacy and
 * port get independently built, identical inputs (build() is called twice).
 */

import type { TabCell } from '../src/storage/tabStore.ts';

export const TZ = 'America/New_York';
export const NOW = Date.parse('2026-10-23T15:00:00Z');
const d = (iso: string): Date => new Date(iso);

export interface Pipeline { ticker: string; chart: any; ind: any; gann: any; conf: any; plan: any }
export interface Fakes { cusip: string | null; holdings: any; budget: boolean; cusipThrows?: string; holdingsThrows?: string }
export interface Inputs {
  ticker: string; chart: any; ind: any; gann: any; confluence: any; fundResult: any; techPlan: any; decision: any; fund: any; opts: any; fundSource: any; aiReview: any;
  status: any; ladderStock: boolean; ladderOptions: boolean; leaps: any; shortTerm: any; existing13F: any; existingShortInterest: any;
}
export interface Scenario {
  name: string;
  build: () => Inputs;
  initial?: Record<string, unknown[][]>;
  preload?: string[];
  fakes?: Partial<Fakes>;
  /** Patches the REAL scores the oracle computes for the inputs; both sides then use this object. */
  scores?: (s: any, i: Inputs) => void;
  /** Applied to both sides' inputs after the scores were computed (breaks inputs the scoring would choke on). */
  post?: (i: Inputs) => void;
  sheetsParsedLabels?: boolean;
  /** Port-only: the port is not expected to equal legacy here (F-B2 echo, F-E8). */
  portDiffers?: boolean;
}
export const DEFAULT_FAKES: Fakes = { cusip: null, holdings: null, budget: true };

/** The legacy side's view of a ReportWorkbook: ReportRange has no setVerticalAlignment / setNote, so a sticky proxy records them. Written independently of src/reports/dashboard/sheetAdapter.ts. */
const sheetProxy = (sh: any): any => new Proxy(sh, { get(t, p) { if (p === 'getRange' || p === 'getDataRange') return (...a: any[]) => rangeProxy(t[p](...a)); const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; } });
const rangeProxy = (r: any): any => {
  const px: any = new Proxy(r, { get(t, p) {
    if (p === 'setVerticalAlignment' || p === 'setNote') return (a: any) => { t.sheet.calls.push(['range:' + String(p), t.row, t.col, t.numRows, t.numCols, a]); return px; };
    const v = Reflect.get(t, p, t);
    return typeof v === 'function' ? (...a: any[]) => { const res = v.apply(t, a); return res === t ? px : res; } : v;
  } });
  return px;
};
export const legacyBook = (b: any): any => ({
  getSheetByName: (n: string) => { const s = b.getSheetByName(n); return s && sheetProxy(s); },
  insertSheet: (n: string) => sheetProxy(b.insertSheet(n)),
  getSheets: () => b.getSheets().map(sheetProxy),
});
export const legacySheet = sheetProxy;

export function pipelines(o: any, fx: { listFixtures: () => string[]; loadRawFixture: (t: string) => any; buildChart: (r: any, n?: number) => any }, n: number): Pipeline[] {
  const out: Pipeline[] = [];
  for (const ticker of fx.listFixtures()) {
    if (out.length >= n) break;
    let raw; try { raw = fx.loadRawFixture(ticker); } catch { continue; }
    if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
    const chart = fx.buildChart(raw, raw.closes.length);
    const ind = o.callNormalized('computeAllIndicators', chart);
    const gann = o.callNormalized('computeGannInline', chart, ind);
    const conf = o.callNormalized('computeConfluenceTargets', ind, gann, null, chart);
    let plan; try { plan = o.callNormalized('computeTechnicalPlanV7', ind, gann, conf, chart, null); } catch { continue; }
    out.push({ ticker, chart, ind, gann, conf, plan });
  }
  return out;
}

const EARN = [
  { date: d('2026-08-04T00:00:00Z'), epsActual: 1.0, epsEstimated: 1.0, revenueActual: 10, revenueEstimated: 10 },
  { date: d('2026-08-05T00:00:00Z'), epsActual: 1.1, epsEstimated: 1.0, revenueActual: 11, revenueEstimated: 10 },
  { date: d('2026-09-10T00:00:00Z'), epsActual: null, epsEstimated: null, revenueActual: null, revenueEstimated: null },
  { date: d('2026-09-30T00:00:00Z'), epsActual: -0.5, epsEstimated: -1, revenueActual: 1, revenueEstimated: 0 },
  { date: d('2026-10-12T00:00:00Z'), epsActual: 0.5, epsEstimated: 1, revenueActual: 1, revenueEstimated: 2 },
];
const GAPS = [
  { date: d('2026-07-01T00:00:00Z'), type: 'UP', level: 90, sizePct: 0.02, filled: true, gapType: 'COMMON' },
  { date: d('2026-07-08T00:00:00Z'), type: 'DOWN', level: 91, sizePct: -0.02, filled: false, gapType: 'COMMON' },
  { date: d('2026-08-05T00:00:00Z'), type: 'UP', level: 100.5, sizePct: 0.052, filled: false, gapType: 'BREAKAWAY' },
  { date: d('2026-08-12T00:00:00Z'), type: 'DOWN', level: 99, sizePct: -0.012, filled: true, gapType: 'EXHAUSTION' },
  { date: d('2026-09-10T00:00:00Z'), type: 'UP', level: 101, sizePct: 0.031, filled: false, gapType: 'ISLAND' },
  { date: d('2026-09-15T00:00:00Z'), type: 'DOWN', level: 98, sizePct: -0.04, filled: false, gapType: 'RUNAWAY' },
  { date: d('2026-09-30T00:00:00Z'), type: 'UP', level: 97, sizePct: 0.01, filled: true, gapType: 'WEIRD' },
  { date: d('2026-10-05T00:00:00Z'), type: 'UP', level: 102, sizePct: 0.0, filled: true },
  { date: d('2026-10-12T00:00:00Z'), type: 'DOWN', level: 96, sizePct: -0.03, filled: false, gapType: 'COMMON' },
  { date: d('2026-10-20T00:00:00Z'), type: 'UP', level: 103, sizePct: 0.04, filled: true, gapType: 'BREAKAWAY' },
];
const pt = (iso: string, price: number) => ({ date: d(iso), price });
const PATTERNS: any[] = [
  { type: 'DOUBLE_TOP', date1: d('2026-06-01'), date2: d('2026-07-15'), level: 110, neckline: 100, confirmed: true, emSpacingCheck: { weeksApart: 6, magnitudePct: 16, meetsBook: true }, measuredTarget: 90 },
  { type: 'DOUBLE_TOP', date1: d('2026-06-01'), date2: d('2026-07-15'), level: 110, neckline: 100, confirmed: false, emSpacingCheck: { weeksApart: 3, magnitudePct: 8, meetsBook: false } },
  { type: 'DOUBLE_BOTTOM', date1: d('2026-06-01'), date2: d('2026-07-15'), level: 80, neckline: 90, confirmed: true },
  { type: 'DOUBLE_BOTTOM', date1: d('2026-06-01'), date2: d('2026-07-15'), level: 80, neckline: 90, confirmed: false },
  { type: 'TRIPLE_TOP', peak1: pt('2026-05-01', 110), peak2: pt('2026-06-01', 111), peak3: pt('2026-07-01', 109), neckline: 100, confirmed: true },
  { type: 'TRIPLE_BOTTOM', trough1: pt('2026-05-01', 80), trough2: pt('2026-06-01', 81), trough3: pt('2026-07-01', 79), neckline: 90, confirmed: false },
  { type: 'HEAD_AND_SHOULDERS', leftShoulder: pt('2026-05-01', 100), head: pt('2026-06-01', 110), rightShoulder: pt('2026-07-01', 101), necklineAtLast: 95, confirmed: true, measuredTarget: 80 },
  { type: 'INVERSE_HEAD_AND_SHOULDERS', leftShoulder: pt('2026-05-01', 80), head: pt('2026-06-01', 70), rightShoulder: pt('2026-07-01', 81), necklineAtLast: 88, confirmed: false },
  { type: 'COMPLEX_TOP', shoulder1: pt('2026-05-01', 100), head1: pt('2026-05-20', 110), head2: pt('2026-06-20', 111), shoulder2: pt('2026-07-10', 100), necklineAtLast: 95, confirmed: true },
  { type: 'COMPLEX_BOTTOM', shoulder1: pt('2026-05-01', 80), head1: pt('2026-05-20', 70), head2: pt('2026-06-20', 69), shoulder2: pt('2026-07-10', 80), necklineAtLast: 88, confirmed: false },
  { type: 'COMPLEX_TOP', shoulder1: pt('2026-05-01', 100), head1: pt('2026-05-20', 110), head2: pt('2026-06-20', 111), shoulder2: pt('2026-07-10', 100), necklineAtLast: 95, confirmed: false },
  { type: 'COMPLEX_BOTTOM', shoulder1: pt('2026-05-01', 80), head1: pt('2026-05-20', 70), head2: pt('2026-06-20', 69), shoulder2: pt('2026-07-10', 80), necklineAtLast: 88, confirmed: true },
  { type: 'BULL_TRAP', level: 105, breakoutDate: d('2026-08-01'), failDate: d('2026-08-05'), status: 'CONFIRMED' },
  { type: 'BULL_TRAP', level: 105, breakoutDate: d('2026-08-01'), status: 'WATCHING' },
  { type: 'BEAR_TRAP', level: 85, breakdownDate: d('2026-08-01'), reclaimDate: d('2026-08-06'), status: 'CONFIRMED' },
  { type: 'BEAR_TRAP', level: 85, breakdownDate: d('2026-08-01'), status: 'WATCHING' },
  { type: 'HALF_MAST', moveStartDate: d('2026-05-01'), moveEndDate: d('2026-05-20'), movePct: 0.2, moveDir: 'UP', consolLow: 100, consolHigh: 108, status: 'BROKE_UP' },
];
for (const status of ['BROKE_UP', 'BROKE_DOWN', 'FORMING']) {
  for (const type of ['ROUNDING_BOTTOM', 'ROUNDING_TOP', 'CUP_AND_HANDLE']) PATTERNS.push({ type, rim: 100, status });
  PATTERNS.push({ type: 'RECTANGLE', resistanceLevel: 110, supportLevel: 100, status });
  for (const type of ['BULL_FLAG', 'BEAR_FLAG', 'PENNANT']) PATTERNS.push({ type, poleStartDate: d('2026-05-01'), poleEndDate: d('2026-05-20'), polePct: status === 'BROKE_DOWN' ? -0.1 : 0.2, poleDir: 'UP', consolLow: 100, consolHigh: 108, status, measuredTarget: status === 'FORMING' ? 130 : null });
  for (const type of ['SYMMETRICAL_TRIANGLE', 'ASCENDING_TRIANGLE', 'DESCENDING_TRIANGLE', 'RISING_WEDGE', 'FALLING_WEDGE']) PATTERNS.push({ type, resistanceP1: pt('2026-05-01', 110), resistanceP2: pt('2026-06-01', 108), supportP1: pt('2026-05-01', 90), supportP2: pt('2026-06-01', 95), resistanceAtLast: 107, supportAtLast: 96, status });
  PATTERNS.push({ type: 'HALF_MAST', moveStartDate: d('2026-05-01'), moveEndDate: d('2026-05-20'), movePct: -0.15, moveDir: 'DOWN', consolLow: 100, consolHigh: 108, status });
  for (const type of ['BROADENING_TOP', 'BROADENING_BOTTOM', 'DIAMOND_TOP', 'DIAMOND_BOTTOM']) PATTERNS.push({ type, points: [pt('2026-05-01', 100), pt('2026-05-10', 105), pt('2026-05-20', 98)], resistance: 108, support: 95, status });
}
const stopBlock = (level: number) => ({ level, basingPointPrice: level - 4, basingPointDate: d('2026-09-01T12:00:00Z'), stopPct: 0.08, sensitivityTier: 'MEDIUM' });
const R = { latest: { date: '2026-06-30', holdings: { shares: 10, value: 1e6 } }, prior: { date: '2026-03-31', holdings: { shares: 10, value: 1e6 } } };
const F_HOLD = (shares: number) => ({ latest: { date: '2026-06-30', holdings: { shares, value: 1e6 } }, prior: null });

export interface ScenarioKit {
  scenarios: Scenario[];
  pipes: Pipeline[];
  /** The tabs a run starts with: Transactions + the options snapshot (a PLTR book). */
  txInitial: Record<string, unknown[][]>;
}

/** Every dashboard scenario. `o` is the oracle; `tx` supplies the Transactions and snapshot tab grids. */
export function makeScenarios(o: any, pipes: Pipeline[], tx: { TX_SHEET: string; SNAPSHOT_TAB: string; transactionsGrid: () => TabCell[][]; snapshotGrid: () => TabCell[][] }): ScenarioKit {
  const TX_INITIAL = { [tx.TX_SHEET]: tx.transactionsGrid(), [tx.SNAPSHOT_TAB]: tx.snapshotGrid() };
  const OLD_TAB = { '📊 Analysis v7': [['stale', 'row'], ['x', 'y']] };
  const bare = (p: Pipeline): Inputs => structuredClone({
    ticker: 'PLTR', chart: p.chart, ind: p.ind, gann: p.gann, confluence: p.conf, fundResult: { score: null }, techPlan: p.plan,
    decision: { finalConviction: 50, action: 'HOLD', lines: [] }, fund: null, opts: null, fundSource: 'Yahoo', aiReview: null, status: o.callNormalized('newDataStatusV7'),
    ladderStock: false, ladderOptions: false, leaps: null, shortTerm: null, existing13F: undefined, existingShortInterest: { shortInterest: null },
  });
  const full = (p: Pipeline): Inputs => {
    const i = bare(p);
    const cp = i.chart.currentPrice;
    i.fundResult = { score: 72, verdict: '🟢 STRONG', profile: 'TECH', drivers: [{ label: 'Growth', value: '31%', points: 1.5, note: 'strong' }, { label: 'Margins', value: '12%', points: -0.5 }, { label: 'P/E', value: '45x', points: 0, note: '' }] };
    i.decision = { finalConviction: 72, action: 'BUY', lines: ['OWN 72', 'TIMING 60'] };
    i.fund = {
      forwardPE: 45, trailingPE: 60, pegRatio: 1.5, revenueGrowth: 0.3, earningsGrowth: 0.25, profitMargins: 0.12, returnOnEquity: 0.2, targetMean: cp * 1.2, targetHigh: cp * 1.5, targetLow: cp * 0.8, numAnalysts: 30, recMean: 2, recKey: 'buy',
      beta: 1.4, marketCap: 250e9, shareFloat: 2e9, dividend: 0, price: cp, grossMargins: 0.6, sector: 'Tech', industry: 'Software',
      debtToEquity: 0.4, currentRatio: 1.2, quickRatio: 0.8, fcfPerShare: 1.5, _crossRef: ['price: 100 vs 101', 'beta: 1.4 vs 1.6'],
      _nextEarnings: { dateStr: '2026-11-10' }, _insiderTrading: { netBuying: false, netShares: -12345, transactionsAnalyzed: 10, purchaseCount: 2, saleCount: 8 },
      _treasuryRate10Y: { year10: 4.6, date: '2026-10-22' }, _sources: ['Yahoo', 'FMP'], _earningsHistory: EARN,
    };
    i.opts = {
      available: true, dirSig: 0.5, confirm: 'confirm', putCallOI: 0.65, netBiasPct: 12, ivRank: 85, leapsLean: 0.3,
      topCall: { strike: 30, conv: 80, expiry: d('2027-01-15T12:00:00Z'), days: 90 }, topPut: { strike: 20, conv: 60, expiry: 'Jan 15, 2027', days: 90 },
      leapCall: { strike: 25, conv: 70, expiry: d('2028-01-21T12:00:00Z') }, leapPut: null,
      horizon: { days: 30, topCall: { strike: 31, conv: 50, expiry: d('2026-12-18T12:00:00Z') }, topPut: null },
    };
    i.aiReview = '**BOTTOM LINE**\nThe stock looks `strong`.\n### Risks:\n- one risk\n• another risk\n* third risk\n\nPlain closing sentence that runs on.\nok';
    i.ladderStock = true; i.ladderOptions = true;
    i.leaps = { found: true, contract: { strike: 20, expUnix: Date.UTC(2028, 0, 21, 12) / 1000, delta: 0.76, iv: 0.62, bid: 10.1, ask: 10.4 } };
    i.shortTerm = { found: false, reason: 'no expiry under a year with open interest' };
    i.existing13F = {
      Berkshire: { latest: { date: '2026-06-30', holdings: { shares: 1234567, value: 5.5e7 } }, prior: { date: '2026-03-31', holdings: { shares: 1000000, value: 4e7 } } },
      BlackRock: { latest: { date: '2026-06-30', holdings: { shares: 900, value: 1e6 } }, prior: { date: '2026-03-31', holdings: { shares: 1000, value: 1e6 } } },
      Vanguard: { latest: { date: '2026-06-30', holdings: { shares: 500, value: 2e6 } }, prior: { date: '2026-03-31', holdings: { shares: 500, value: 2e6 } } },
      'State Street': { latest: { date: '2026-06-30', holdings: { shares: 42, value: 3e5 } }, prior: null },
      Citadel: { latest: null, prior: { date: '2026-03-31', holdings: { shares: 77, value: 1e5 } } },
      Nobody: { latest: { date: '2026-06-30', holdings: null }, prior: null },
    };
    i.ind.priceGaps = GAPS; i.ind.chartPatterns = PATTERNS;
    i.ind.chandelierStop = cp * 0.9; i.ind.chandelierHighestHigh = cp * 1.05; i.ind.progressiveStopFlag = { level: cp * 0.99, volumeRatio: 3.4, daysSinceCross: 40 };
    i.ind.keltnerSqueeze = true; i.ind.bbSqueeze = true;
    const tp = i.techPlan;
    tp.classicalStop = { level: cp * 0.92, basingPointPrice: cp * 0.95, basingPointDate: d('2026-09-01T12:00:00Z') };
    tp.basingPointStop = stopBlock(cp * 0.9); tp.alternateBasingPointStop = stopBlock(cp * 0.88); tp.sidewaysBasingPointStop = stopBlock(cp * 0.86);
    tp.nNormalizedPositionSize = { shares: 55, stopLevel: cp * 0.91, dollarRisk: 200.4, riskPctOfAccount: 2 };
    tp.compositeLeverage = { leverage: 1.25, normalRangeForPrice: 3.14, tier: 'MODERATE' };
    tp.fanPrinciple = { originPrice: cp * 1.1, originDate: d('2026-08-10T12:00:00Z'), brokenCount: 2, flattening: true, triggered: false };
    tp.trendChannel = { basicTrendline: { currentValue: cp * 0.97 }, returnLine: { currentValue: cp * 1.08 }, projectedOvershoot: 2.5 };
    tp.options = { available: true, horizon: { days: 30 } };
    tp.headlineWeights = { own: 0.5, timing: 0.5 }; tp.headlineUsedDefaultWeights = true;
    i.chart.vixContext = { level: 21.5, low52: 12, high52: 40, rangePct: 33, read: 'elevated', courseRead: { regime: 'Normal (13-25)' }, divergence5d: { flagged: true, note: 'VIX rising while price rises', vixSlope5: 1.2, spyChange5pct: 0.8 } };
    i.chart.sectorRS = { etf: 'XLK', sector: 'Tech', rs63: 4.2, outperforming: true };
    i.chart.relativeSwingPower = { etf: 'XLK', sector: 'Tech', ratio: 1.25 };
    i.confluence.allEntryMethods = [...(i.confluence.allEntryMethods || []), { name: 'Excluded A', price: null, type: 'support', excluded: true, exclusionReason: 'not enough bars' }, { name: 'Excluded B', price: cp * 0.9, type: 'support', excluded: true }];
    i.confluence.allExitMethods = [...(i.confluence.allExitMethods || []), { name: 'Excluded C', price: null, type: 'resistance' }];
    const st = i.status;
    st.fundamentals.state = 'degraded'; st.fundamentals.detail = 'Fundamentals came from one source only';
    st.options.state = 'failed'; st.options.detail = 'Options data missing';
    st.peers.state = 'skipped'; st.peers.detail = 'Peers skipped';
    st.price.state = 'ok';
    return i;
  };

  const scenarios: Scenario[] = [];
  const S = (name: string, patch: (i: Inputs) => void, extra: Partial<Scenario> = {}, base = 0): void => {
    scenarios.push({ name, build: () => { const i = full(pipes[base]); patch(i); return i; }, ...extra });
  };
  pipes.forEach((p, k) => {
    scenarios.push({ name: 'bare ' + p.ticker, build: () => bare(p) });
    scenarios.push({ name: 'full ' + p.ticker, build: () => full(p), initial: k === 0 ? { ...OLD_TAB, ...TX_INITIAL } : TX_INITIAL, fakes: { cusip: '037833100', holdings: { Berkshire: F_HOLD(5) } } });
  });
  for (const regime of ['TREND_UP', 'TREND_DOWN', 'HIGH_VOL', 'CHOP', 'WEIRD']) for (const timing of ['BUY_NOW', 'AVOID', 'WAIT_PULLBACK']) {
    S('regime ' + regime + ' ' + timing, (i) => { i.techPlan.regime = regime; i.techPlan.timing = timing; if (regime === 'WEIRD') delete i.techPlan.headlineWeights; });
  }
  for (const key of ['classicalStop', 'basingPointStop', 'alternateBasingPointStop', 'sidewaysBasingPointStop', 'nNormalizedPositionSize', 'compositeLeverage', 'fanPrinciple', 'trendChannel', 'headlineWeights']) {
    S('plan without ' + key, (i) => { delete i.techPlan[key]; });
  }
  S('plan: no ATR extras', (i) => { delete i.ind.chandelierStop; delete i.ind.progressiveStopFlag; i.ind.keltnerSqueeze = false; i.ind.bbSqueeze = false; i.ind.atrRatio = 0.5; });
  S('plan: atrRatio expanding, channel no overshoot', (i) => { i.ind.atrRatio = 1.6; i.techPlan.trendChannel.projectedOvershoot = null; i.techPlan.fanPrinciple.triggered = true; i.techPlan.fanPrinciple.flattening = false; });
  S('atrRatio normal', (i) => { i.ind.atrRatio = 1.0; });
  S('ladder stock only, empty ladders', (i) => { i.ladderOptions = false; i.confluence.entryCount = 0; i.techPlan.t1 = null; i.techPlan.t2 = null; });
  S('ladder stock+options, empty ladders', (i) => { i.confluence.entryCount = 0; i.techPlan.t1 = null; i.techPlan.t2 = null; });
  S('ladder options only, expiry far', (i) => { i.ladderStock = false; i.techPlan.options.horizon.days = 90; });
  S('ladder options only, horizon days null', (i) => { i.ladderStock = false; i.techPlan.options.horizon = { days: null }; });
  S('ladder options only, no horizon', (i) => { i.ladderStock = false; delete i.techPlan.options.horizon; });
  S('ladder options requested, no options data', (i) => { i.ladderStock = false; i.techPlan.options = { available: false }; });
  S('ladder options requested, techPlan.options missing', (i) => { i.ladderStock = false; delete i.techPlan.options; });
  S('ladder entry count 3, t1 only', (i) => { i.confluence.entryCount = 3; i.techPlan.t2 = null; });
  S('no ladders', (i) => { i.ladderStock = false; i.ladderOptions = false; });
  S('contracts: both found, iv missing', (i) => { i.shortTerm = { found: true, contract: { strike: 30, expUnix: Date.UTC(2027, 3, 16, 12) / 1000, delta: 0.5, iv: 0, bid: 3, ask: 3.2 } }; });
  S('contracts: only short term missing leaps', (i) => { i.leaps = null; });
  S('contracts: neither', (i) => { i.leaps = null; i.shortTerm = null; });
  S('contracts: broken contract', (i) => { i.leaps = { found: true, contract: { strike: 20, expUnix: 1, bid: 1, ask: 2 } }; });
  S('opts: absent', (i) => { i.opts = null; });
  S('opts: unavailable', (i) => { i.opts = { available: false }; });
  S('opts: conflict, puts', (i) => { Object.assign(i.opts, { dirSig: -0.5, confirm: 'conflict', netBiasPct: -20, putCallOI: null, ivRank: 10, leapsLean: -0.3, topCall: null, topPut: { strike: 20, conv: 60, expiry: d('2027-01-15T12:00:00Z') }, leapCall: null, leapPut: { strike: 18, expiry: 'Mar 19, 2027' }, horizon: null }); });
  S('opts: neutral, nothing set', (i) => { i.opts = { available: true, dirSig: 0, confirm: 'neutral', putCallOI: 0.9, netBiasPct: 0, ivRank: 50, leapsLean: 0, topCall: null, topPut: null, leapCall: null, leapPut: null, horizon: { days: 10, topCall: null, topPut: { strike: 5, expiry: 'plain text' } } }; });
  S('opts: null bias and iv', (i) => { Object.assign(i.opts, { netBiasPct: null, ivRank: null, confirm: 'weird' }); });
  S('opts: broken expiry', (i) => { i.opts.topCall.expiry = Object.create(null); });
  const FUND: Array<[string, (f: any, i: Inputs) => void]> = [
    ['fund: null', (f, i) => { i.fund = null; }],
    ['fund: only trailing PE low, peg low', (f) => { f.forwardPE = null; f.trailingPE = 10; f.pegRatio = 0.5; f.revenueGrowth = -0.1; f.profitMargins = -0.05; f.returnOnEquity = -0.1; }],
    ['fund: PE mid, peg high, no target', (f) => { f.forwardPE = 30; f.pegRatio = 3; f.targetMean = null; f.recKey = null; }],
    ['fund: nothing for narrative', (f) => { f.forwardPE = null; f.trailingPE = null; f.pegRatio = null; f.revenueGrowth = null; f.profitMargins = null; f.returnOnEquity = null; f.targetMean = null; }],
    ['fund: target without rating, peg between', (f) => { f.recKey = ''; f.pegRatio = 1.5; }],
    ['fund: balance sheet high leverage/adequate/burning', (f) => { f.debtToEquity = 2; f.currentRatio = 1.1; f.quickRatio = 1.2; f.fcfPerShare = -1; }],
    ['fund: balance sheet moderate/tight', (f) => { f.debtToEquity = 1; f.currentRatio = 0.7; f.quickRatio = null; f.fcfPerShare = null; }],
    ['fund: healthy current ratio', (f) => { f.currentRatio = 2; }],
    ['fund: balance sheet only fcf', (f) => { f.debtToEquity = null; f.currentRatio = null; f.quickRatio = null; }],
    ['fund: no balance sheet', (f) => { f.debtToEquity = null; f.currentRatio = null; f.quickRatio = null; f.fcfPerShare = null; }],
    ['fund: insider buying', (f) => { f._insiderTrading = { netBuying: true, netShares: 5000, transactionsAnalyzed: 4, purchaseCount: 4, saleCount: 0 }; }],
    ['fund: insider neutral', (f) => { f._insiderTrading = { netBuying: false, netShares: 0, transactionsAnalyzed: 4, purchaseCount: 1, saleCount: 1 }; }],
    ['fund: no insider, no crossRef, no sources', (f) => { delete f._insiderTrading; delete f._crossRef; delete f._sources; }],
    ['fund: sources agree', (f) => { delete f._crossRef; }],
    ['fund: treasury moderate, PE 30, no date', (f) => { f._treasuryRate10Y = { year10: 4.0 }; f.forwardPE = 30; }],
    ['fund: treasury low, PE 10', (f) => { f._treasuryRate10Y = { year10: 3.0, date: '2026-10-01' }; f.forwardPE = 10; }],
    ['fund: treasury no PE', (f) => { f.forwardPE = null; f.trailingPE = null; }],
    ['fund: treasury absent', (f) => { delete f._treasuryRate10Y; }],
    ['fund: treasury null year', (f) => { f._treasuryRate10Y = { year10: null }; }],
    ['fund: earnings far', (f) => { f._nextEarnings = { dateStr: '2027-03-01' }; }],
    ['fund: earnings bad date', (f) => { f._nextEarnings = { dateStr: 'soon' }; }],
    ['fund: earnings absent', (f) => { delete f._nextEarnings; }],
    ['fund: no earnings history, large cap', (f) => { delete f._earningsHistory; f.marketCap = 50e9; }],
    ['fund: mid cap', (f) => { f.marketCap = 5e9; }],
    ['fund: small cap', (f) => { f.marketCap = 5e8; }],
    ['fund: micro cap', (f) => { f.marketCap = 1e8; }],
    ['fund: no market cap', (f) => { f.marketCap = null; }],
  ];
  for (const [name, patch] of FUND) S(name, (i) => { if (i.fund) patch(i.fund, i); });
  S('fundResult: score null but fund present', (i) => { i.fundResult = { score: null }; });
  S('fundResult: no drivers, no profile, low score', (i) => { i.fundResult = { score: 30, verdict: '🔴 WEAK', drivers: [] }; });
  S('fundResult: mid score no verdict', (i) => { i.fundResult = { score: 50, drivers: undefined }; });
  S('fundResult: far from legacy (higher)', (i) => { i.fundResult.score = 99; });
  S('fundResult: far from legacy (lower)', (i) => { i.fundResult.score = 1; });
  S('fund null with fundResult score', (i) => { i.fund = null; });
  S('decision: low conviction', (i) => { i.decision.finalConviction = 30; });
  S('decision: middling conviction', (i) => { i.decision.finalConviction = 55; });
  const SWEEP: Array<[string, any[]]> = [['rsi14', [25, 40, 50, 60, 75]], ['range52Pct', [10, 50, 90]], ['volRatio', [0.5, 1, 2]], ['adx14', [15, 30, 45]], ['rsiWeekly', [30, 50, 70]], ['stochK', [10, 50, 90]],
    ['bbPctB', [0.01, 0.5, 0.99]], ['histogram', [-1, 1]], ['above200', [true, false]], ['above50', [true, false]], ['goldenCross', [true]], ['deathCross', [true]], ['adxBullish', [true, false]], ['bbSqueeze', [false]]];
  for (const [key, vals] of SWEEP) for (const v of vals) S('ind.' + key + '=' + v, (i) => { i.ind[key] = v; if (key === 'deathCross') i.ind.goldenCross = false; });
  S('narrative: no squeeze, mid band', (i) => { i.ind.bbSqueeze = false; i.ind.bbPctB = 0.5; });
  S('narrative: no squeeze, upper band', (i) => { i.ind.bbSqueeze = false; i.ind.bbPctB = 0.99; });
  S('narrative: no squeeze, lower band', (i) => { i.ind.bbSqueeze = false; i.ind.bbPctB = 0.01; });
  S('ind: price levels missing', (i) => { i.ind.sma150 = null; i.ind.sma200 = null; i.ind.pctFromSma200 = null; i.ind.pp_R2 = 0; i.ind.fib786 = 0; });
  S('levels: above and below price', (i) => { const cp = i.chart.currentPrice; i.ind.pivot = cp * 2; i.ind.pp_S1 = cp * 0.5; i.ind.pp_R1 = cp * 1.1; i.ind.pp_R2 = cp * 0.9; i.ind.ema21 = cp * 0.95; });
  S('levels: a non-number breaks one row', (i) => { i.ind.pp_R2 = 'x'; });
  for (const sc of [95, 60, 40]) S('gann score ' + sc, (i) => { i.gann.score = sc; });
  S('gann: no master, no support, far angles', (i) => { i.gann.gannMaster = null; i.gann.gannSupport = null; });
  S('gann: master above price', (i) => { i.gann.gannMaster = i.chart.currentPrice * 1.5; });
  S('gann: master below price, support set', (i) => { i.gann.gannMaster = i.chart.currentPrice * 0.5; i.gann.gannSupport = i.chart.currentPrice * 0.9; });
  S('gann: no ANGLES', (i) => { i.gann.ANGLES = undefined; });
  S('gann: a fan entry missing, a far one kept as riding', (i) => { const a = i.gann.ANGLES; delete i.gann.fan[a[0].label]; i.gann.lowerAngle = a[1].label; i.gann.fan[a[1].label].pct = 400; if (a[2]) i.gann.fan[a[2].label].pct = -400; });
  S('gann: master row, flipped sides, a broken row', (i) => {
    const g = i.gann, cp = i.chart.currentPrice;
    g.ANGLES = [...g.ANGLES, { label: '1×1' }, { label: 'BAD' }];
    g.fan['1×1'] = { level: cp, pct: 0.5, above: false }; g.fan['BAD'] = { level: undefined, pct: 1, above: true };
    for (const a of g.ANGLES.slice(0, 3)) if (g.fan[a.label]) g.fan[a.label].above = !g.fan[a.label].above;
  });
  S('chart: vix absent', (i) => { delete i.chart.vixContext; });
  S('chart: vix fear, non-normal course regime, no divergence', (i) => { Object.assign(i.chart.vixContext, { read: 'fear/crisis', courseRead: { regime: 'Elevated (25+)' }, divergence5d: { flagged: false } }); });
  S('chart: vix calm no course read, negative divergence', (i) => { Object.assign(i.chart.vixContext, { read: 'calm', courseRead: null, divergence5d: { flagged: true, note: 'n', vixSlope5: 0.1, spyChange5pct: -0.5 } }); });
  S('chart: vix no divergence object', (i) => { delete i.chart.vixContext.divergence5d; });
  S('chart: sector lagging, swing narrower, down day', (i) => { i.chart.sectorRS = { etf: 'XLK', sector: 'Tech', rs63: -3, outperforming: false }; i.chart.relativeSwingPower = { etf: 'XLK', sector: 'Tech', ratio: 0.6 }; i.chart.prevClose = i.chart.currentPrice * 1.05; });
  S('chart: no sector, no swing, prevClose 0', (i) => { delete i.chart.sectorRS; delete i.chart.relativeSwingPower; i.chart.prevClose = 0; });
  S('confluence: nothing aligned', (i) => { Object.assign(i.confluence, { entryMethods: [], exitMethods: [], allEntryMethods: [], allExitMethods: [], entryCount: 0, exitCount: 1 }); });
  S('confluence: no all-method lists', (i) => { delete i.confluence.allEntryMethods; delete i.confluence.allExitMethods; });
  S('confluence: strong counts, no method lists', (i) => { Object.assign(i.confluence, { entryMethods: undefined, exitMethods: undefined, entryCount: 4, exitCount: 3 }); });
  S('confluence: exit far above, counts 2', (i) => { i.confluence.exitCenter = i.chart.currentPrice * 1.6; i.confluence.exitCount = 2; i.confluence.entryCount = 2; });
  S('confluence: exit medium', (i) => { i.confluence.exitCenter = i.chart.currentPrice * 1.2; });
  S('confluence: entry above price', (i) => { i.confluence.entryCenter = i.chart.currentPrice * 1.05; });
  S('confluence: broken', (i) => { delete i.confluence.entryLow; });
  S('gaps: none', (i) => { i.ind.priceGaps = []; });
  S('gaps: absent and no patterns', (i) => { delete i.ind.priceGaps; i.ind.chartPatterns = []; });
  S('gaps: broken row', (i) => { i.ind.priceGaps = [{ date: d('2026-10-01'), type: 'UP', filled: false }, ...GAPS.slice(0, 2)].reverse(); });
  S('gaps: invalid date', (i) => { i.ind.priceGaps = [{ date: 'junk', type: 'UP', level: 1, sizePct: 0.1, filled: true }]; });
  S('patterns: broken pattern', (i) => { i.ind.chartPatterns = [{ type: 'DOUBLE_TOP', confirmed: true }]; });
  S('patterns: absent', (i) => { delete i.ind.chartPatterns; });
  S('status: all ok', (i) => { i.status = o.callNormalized('newDataStatusV7'); });
  S('status: absent', (i) => { i.status = null; });
  S('status: failed only, no detail', (i) => { i.status = o.callNormalized('newDataStatusV7'); i.status.gann.state = 'failed'; });
  S('status: degraded only', (i) => { i.status = o.callNormalized('newDataStatusV7'); i.status.darkPool.state = 'degraded'; i.status.darkPool.detail = 'x'; });
  S('status: unknown entry is ignored', (i) => { i.status = { price: { label: 'Price', state: 'weird', detail: '' }, bogus: { label: 'b', state: 'failed', detail: 'ignored' } }; });
  S('ai: empty string text', (i) => { i.aiReview = '```'; });
  S('ai: only headers', (i) => { i.aiReview = 'SUMMARY\nRisks:\n# Title\n'; });
  S('ai: long line', (i) => { i.aiReview = 'word '.repeat(400); });
  S('ai: broken render', (i) => { i.aiReview = Object.create(null); });
  S('ai: absent', (i) => { i.aiReview = null; });
  S('header: broken fund source', (i) => { i.fundSource = Object.create(null); });
  S('header: no cross ref', (i) => { delete i.fund._crossRef; i.fundSource = 'FMP'; });
  S('break: price snapshot', (i) => { i.fund._nextEarnings = { dateStr: Object.create(null) }; });
  S('break: stop missing (position row + ATR)', (i) => { delete i.techPlan.stop; }, { initial: TX_INITIAL });
  S('break: macro range', (i) => { i.chart.vixContext = { level: undefined }; });
  S('break: cross-reference', (i) => { i.chart.sectorRS = { etf: 'X', sector: 'Y', outperforming: true }; });
  S('break: ladder', (i) => { i.techPlan.t1 = { price: undefined }; });
  S('break: verdict', (i) => { i.decision.lines = 'not an array'; });
  S('break: gann pivot (section + summary)', () => undefined, { scores: () => undefined, post: (i) => { i.gann.pivot = null; } });
  S('break: gann price unit', () => undefined, { scores: () => undefined, post: (i) => { i.gann.priceUnit = undefined; } });
  S('break: options', (i) => { i.opts.horizon = { days: 3, topCall: { strike: 1, expiry: Object.create(null) } }; });
  S('break: fund drivers', (i) => { i.fundResult.drivers = [{ label: 'a', value: 1, points: 1 }, null, { label: 'b', value: 2, points: 2 }]; });
  S('position: stock + options with and without snapshot, warnings', () => undefined, { initial: TX_INITIAL });
  S('position: price far below cost', (i) => { i.chart.currentPrice = 5; }, { initial: TX_INITIAL });
  S('position: none for this ticker', (i) => { i.ticker = 'ZZZZ'; }, { initial: TX_INITIAL });
  S('position: tabs not loaded -> silently absent', () => undefined, { initial: TX_INITIAL, preload: [] });
  S('position: dashboard tab present but not loaded', () => undefined, { initial: { ...OLD_TAB, ...TX_INITIAL }, preload: [] });
  S('position: no transactions tab', () => undefined, { initial: {} });
  S('position: only the transactions tab', () => undefined, { initial: { [tx.TX_SHEET]: tx.transactionsGrid() } });
  S('position: sheets-parsed labels (F-B2 echo, port differs by design)', () => undefined, { initial: TX_INITIAL, sheetsParsedLabels: true, portDiffers: true });
  S('13F: reuse null', (i) => { i.existing13F = null; });
  S('13F: reuse object', (i) => { i.existing13F = { A: R }; });
  S('13F: reuse none matching', (i) => { i.existing13F = { A: { latest: { date: 'd', holdings: null }, prior: null } }; });
  S('13F: closed positions only', (i) => { i.existing13F = { X: { latest: null, prior: { date: 'p', holdings: { shares: 5, value: 1e6 } } } }; });
  S('13F: latest empty, prior held', (i) => { i.existing13F = { X: { latest: { date: 'l', holdings: null }, prior: { date: 'p', holdings: { shares: 3, value: 1e6 } } } }; });
  S('13F: fetch, time budget exhausted', (i) => { i.existing13F = undefined; }, { fakes: { budget: false } });
  S('13F: fetch, cusip lookup fails', (i) => { i.existing13F = undefined; });
  S('13F: fetch, cusip ok, holdings null', (i) => { i.existing13F = undefined; }, { fakes: { cusip: '1', holdings: null } });
  S('13F: fetch, holdings real', (i) => { i.existing13F = undefined; }, { fakes: { cusip: '1', holdings: { A: R, B: F_HOLD(7) } } });
  S('13F: fetch, none matching', (i) => { i.existing13F = undefined; }, { fakes: { cusip: '1', holdings: { A: { latest: { date: 'd', holdings: null }, prior: null } } } });
  S('13F: holdings fetch throws', (i) => { i.existing13F = undefined; }, { fakes: { cusip: '1', holdingsThrows: 'SEC EDGAR returned 503' } });
  S('13F: cusip fetch throws', (i) => { i.existing13F = undefined; }, { fakes: { cusipThrows: 'FMP profile timed out' } });
  S('13F: throws a non-error', (i) => { i.existing13F = undefined; }, { fakes: { cusip: '1', holdingsThrows: '' } });
  S('short interest: not passed (cache read)', (i) => { i.existingShortInterest = undefined; });
  S('short interest: passed with values', (i) => { i.existingShortInterest = { shortInterest: 5e8, daysToCover: 3, settlementDate: '2026-10-15' }; });
  const sc = (name: string, patch: (s: any, i: Inputs) => void): void => S('scores: ' + name, () => undefined, { scores: patch });
  sc('categories missing / read bands', (s) => { s.shortCats.Trend.score = 65; s.shortCats.Momentum.score = 30; s.shortCats.Volume.score = 50; delete s.shortCats.Volatility; delete s.longCats.Volatility; delete s.shortCats.Position; s.longCats.Position = { signal: 0, score: 41, count: 2 }; });
  sc('categories present on one side only, count missing', (s) => { delete s.shortCats.Volume; s.longCats.Volume = { signal: 0, score: 55 }; delete s.longCats.Momentum; s.shortCats.Momentum = { signal: 0, score: 45 }; });
  sc('category score getter breaks', (s) => { Object.defineProperty(s.shortCats.Trend, 'score', { get() { throw new Error('x'); } }); });
  sc('no cats at all', (s) => { s.shortCats = undefined; s.longCats = undefined; });
  sc('conflicts', (s) => { s.shortConflict = { conflict: true, note: 'trend vs momentum' }; s.longConflict = undefined; });
  sc('conflict without note', (s) => { s.shortConflict = { conflict: false }; s.longConflict = { conflict: true, note: 'c' }; });
  sc('driver held back (bearish driver, bullish score)', (s) => { s.shortScore = 80; s.longScore = 20; s.shortSignals = [{ name: 'Z', signal: -0.9, weight: 5, cat: 'Other', display: '', note: '' }]; s.longSignals = [{ name: 'Gann Y', signal: 0.9, weight: 5, cat: 'Trend', display: 'd' }]; });
  sc('driver ties and empty lists', (s) => { s.shortSignals = []; s.longSignals = [{ name: 'a', signal: 0, weight: 1, cat: 'Trend' }, { name: 'b', signal: 0, weight: 2, cat: undefined }]; });
  sc('zero-weight signals', (s) => { s.shortSignals = [{ name: 'Z', signal: 0.5, weight: 0, cat: 'Trend', display: 'd' }]; s.longSignals = [{ name: 'Y', signal: -0.5, weight: 0, cat: 'Other' }]; });
  sc('divergences', (s) => { s.divergence = { type: 'bullish', note: 'n' }; s.macdDivergence = { type: 'bearish', note: 'm' }; s.obvDivergence = { type: 'bullish', note: 'o' }; s.rs = { rs63: 3.3, outperforming: true }; });
  sc('divergences 2', (s) => { s.divergence = { type: 'bearish', note: 'n' }; s.macdDivergence = { type: 'bullish', note: 'm' }; s.obvDivergence = { type: 'bearish', note: 'o' }; s.rs = { rs63: -3.3, outperforming: false }; });
  sc('divergences 3', (s) => { s.divergence = { type: 'none', note: 'n' }; s.macdDivergence = { type: 'none' }; s.obvDivergence = null; s.rs = null; });
  sc('verdict bands high', (s) => { s.shortScore = 70; s.longScore = 70; s.shortConviction = 65; s.longConviction = 65; });
  sc('verdict bands mid', (s) => { s.shortScore = 50; s.longScore = 50; s.shortConviction = 50; s.longConviction = 50; });
  sc('verdict bands low', (s) => { s.shortScore = 30; s.longScore = 30; s.shortConviction = 30; s.longConviction = 30; });
  sc('signals odd', (s) => { s.shortSignals = [{ name: 'S1', signal: 0.5, weight: 2, cat: 'Trend', display: '', note: undefined }, { name: 'S2', signal: -0.5, weight: 2, cat: 'Trend', display: 'x', note: 'n' }, { name: 'S3', signal: 0.2, weight: 2, display: 'x' }]; s.longSignals = [{ name: 'L1', signal: 0.5, weight: 1, cat: 'Trend', display: '' }, null]; });
  sc('fund signals', (s) => { s.fundSignals = [{ name: 'a', signal: 0.5, weight: 1, display: '', note: undefined }, { name: 'b', signal: -0.5, weight: 1, display: 'd', note: 'n' }, { name: 'c', signal: 0, weight: 0, display: 'd' }, { name: 'd', signal: 0, weight: 1, display: 'd' }]; s.fundScore = 40; });
  sc('fund signal row null', (s) => { s.fundSignals = [null, { name: 'a', signal: 0.1, weight: 1, display: 'd' }]; s.fundScore = 40; });
  sc('fund score null with verdict', (s) => { s.fundScore = null; s.fundVerdict = 'N/A'; });
  sc('fund score null, no verdict', (s) => { s.fundScore = null; s.fundVerdict = undefined; });
  sc('no fund signals', (s) => { s.fundSignals = []; s.fundScore = null; });
  sc('fund score close to own', (s, i) => { s.fundScore = i.fundResult.score - 5; });
  sc('short signal row breaks', (s) => { s.shortSignals = [{ name: 'S1', signal: 0.5, weight: 2, cat: 'Trend' }, { get name(): string { throw new Error('bad name'); }, signal: 0.1, weight: 1, cat: 'Trend' }]; s.longSignals = [{ name: 'L', signal: 0.1, weight: 1, cat: 'Trend' }]; });
  sc('long signal name missing', (s) => { s.longSignals = [{ signal: 0.1, weight: 1, cat: 'Trend' }]; });
  sc('signals not arrays', (s) => { s.shortSignals = null; s.longSignals = null; s.fundSignals = undefined; });
  sc('weights missing (the cross-reference section stops, the rest runs)', (s) => { s.shortW = undefined; s.regimeUsedForWeights = 'x'; });
  sc('verdict section breaks on a getter', (s) => { Object.defineProperty(s, 'shortScore', { get() { throw new Error('no score'); } }); });
  return { scenarios, pipes, txInitial: TX_INITIAL };
}
