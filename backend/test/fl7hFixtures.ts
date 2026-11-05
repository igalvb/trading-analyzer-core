/**
 * Fixtures for the FL-7h tests: narrative scenarios that reach every branch of buildNarrativeV7_, and run-status
 * records that reach every state of the banner, the run summary and the failure sheet.
 */

import { newDataStatus } from '../src/analysis/dataStatus.ts';
import type { RunStatus } from '../src/reports/text/textReports.ts';

export const TZ = 'America/New_York';
export const NOW = Date.parse('2026-10-23T15:00:00Z');

type Over = Record<string, any>;

const BASE: Over = {
  ticker: 'PLTR',
  chart: { currentPrice: 100, prevClose: 98 },
  ind: {
    above200: true, above50: true, range52Pct: 50, low52: 60, high52: 120, goldenCross: false, deathCross: false, atr14: 2.5, rsi14: 50,
    histogram: 0.3, bbSqueeze: false, bbPctB: 0.5, volRatio: 1, stochK: 50, willR: -50, adx14: 30, adxBullish: true, pctFromSma200: 10,
    pctFromSma50: 3, rsiWeekly: 50, roc52: 8,
  },
  gann: { score: 75, pivot: { dateStr: '2026-03-02', price: 80 }, priceUnit: 0.5, lowerAngle: '2x1', upperAngle: '1x1', gannMaster: 95 },
  confluence: {
    entryCenter: 95, entryLow: 92, entryHigh: 97, entryConfidence: 'high confidence',
    exitCenter: 130, exitLow: 125, exitHigh: 135, exitConfidence: 'moderate confidence',
  },
  scores: { shortScore: 60, longScore: 55, shortVerdict: '🟢 BUY', longVerdict: 'HOLD', shortConviction: 62, longConviction: 58 },
  fund: { forwardPE: 20, trailingPE: 25, pegRatio: 1.5, revenueGrowth: 0.12, profitMargins: 0.2, returnOnEquity: 0.25, targetMean: 120, recKey: 'buy' },
  opts: { available: true, confirm: 'confirm', putCallOI: 0.85, netBiasPct: 12, ivRank: 40 },
  techPlan: { techScore: 66, regime: 'TRENDING', timing: 'GOOD' },
  decision: { finalConviction: 70, action: 'BUY' },
  fundResult: { score: 62, verdict: '🟢 OWN' },
};
const ARG_ORDER = ['ticker', 'chart', 'ind', 'gann', 'confluence', 'scores', 'fund', 'opts', 'techPlan', 'decision', 'fundResult'] as const;

/** The 11 arguments of buildNarrativeV7_: the base with `over` applied (an object merges into the base's; null or a scalar replaces it). */
export function narrativeArgs(over: Over = {}): unknown[] {
  return ARG_ORDER.map((k) => {
    const o = over[k];
    if (o === undefined) return structuredClone(BASE[k]);
    if (o === null || typeof o !== 'object') return o;
    return { ...structuredClone(BASE[k]), ...o };
  });
}

export const NARRATIVE_SCENARIOS: ReadonlyArray<readonly [string, Over]> = [
  ['base', {}],
  ['bearish, squeeze, conflict, low PEG, headwind, deep entry', {
    chart: { prevClose: 0 },
    ind: { above200: false, above50: false, range52Pct: 90, goldenCross: true, rsi14: 25, histogram: -0.2, bbSqueeze: true, volRatio: 2, stochK: 10, willR: -90, adx14: 45, adxBullish: false, rsiWeekly: 30 },
    scores: { shortScore: 40 }, gann: { score: 40, gannMaster: 120 },
    fund: { forwardPE: null, trailingPE: 50, pegRatio: 0.5, recKey: undefined }, fundResult: { score: 40 }, confluence: { entryCenter: 80 },
    opts: { confirm: 'conflict', putCallOI: null, netBiasPct: -5, ivRank: null },
  }],
  ['death cross, bottom of range, weak RSI, upper band, light volume, thin fundamentals', {
    ind: { deathCross: true, range52Pct: 10, rsi14: 40, bbPctB: 0.97, volRatio: 0.5, stochK: 85, adx14: 20, rsiWeekly: 70, low52: null, pctFromSma200: null, roc52: null },
    scores: { shortScore: 50 }, gann: { score: 60, gannMaster: null },
    fund: { forwardPE: undefined, trailingPE: 10, pegRatio: 3, revenueGrowth: null, profitMargins: null, returnOnEquity: null, targetMean: 0 },
    fundResult: { score: 50, verdict: undefined }, opts: { available: false },
  }],
  ['firm RSI, lower band, no fundamentals bits, no options, entry close', {
    ind: { rsi14: 60, bbPctB: 0.02, histogram: 0 }, scores: { shortScore: 57, longScore: 43 }, gann: { score: 50, gannMaster: 99 },
    fund: { forwardPE: null, trailingPE: null, pegRatio: null, revenueGrowth: null, profitMargins: null, returnOnEquity: null, targetMean: null },
    fundResult: { score: 57, verdict: '🟢 OWN!' }, confluence: { entryCenter: 99 }, opts: null,
  }],
  ['overbought RSI, no fundamentals at all, neutral options with zero values and a long float', {
    ind: { rsi14: 75, stochK: 50 }, fund: null, fundResult: null, opts: { confirm: 'neutral', putCallOI: 0, netBiasPct: 12.3456789, ivRank: 0 }, confluence: { entryCenter: 100 },
  }],
  ['fundamentals present but the OWN score is null, an unknown options confirm, net bias zero', { fundResult: { score: null }, opts: { confirm: 'x', netBiasPct: 0 } }],
  ['options with every figure missing', { opts: { putCallOI: null, netBiasPct: null, ivRank: null } }],
  ['PEG exactly 1, P/E exactly 15', { fund: { pegRatio: 1, forwardPE: 15, recKey: 'hold' } }],
  ['forward P/E zero hides the trailing one; PEG exactly 2', { fund: { forwardPE: 0, trailingPE: 30, pegRatio: 2 } }],
  ['upper boundaries', { ind: { rsi14: 70, stochK: 20, adx14: 40, volRatio: 1.5, range52Pct: 80, bbPctB: 0.95, rsiWeekly: 65 } }],
  ['lower boundaries', { ind: { rsi14: 45, stochK: 80, adx14: 25, volRatio: 0.7, range52Pct: 20, bbPctB: 0.05, rsiWeekly: 40 } }],
  ['RSI 30', { ind: { rsi14: 30 } }],
  ['RSI 55', { ind: { rsi14: 55, rsiWeekly: 39.9 } }],
  ['empty ticker, missing gann fields', { ticker: '', gann: { gannMaster: undefined, priceUnit: null, pivot: { dateStr: '', price: null } } }],
  ['price NaN', { chart: { currentPrice: NaN } }],
  ['entry just inside -2 percent', { confluence: { entryCenter: 98.1 } }],
  ['entry just outside -2 percent', { confluence: { entryCenter: 97.9 } }],
];

/** Scenarios that make legacy throw (a null where it calls a method). */
export const NARRATIVE_THROWS: ReadonlyArray<readonly [string, Over]> = [
  ['52-week position missing', { ind: { range52Pct: null } }],
  ['RSI missing', { ind: { rsi14: null } }],
  ['no tech plan', { techPlan: null }],
  ['no chart', { chart: null }],
];

type S = Record<string, { label?: string; state?: string; detail?: string } | undefined | null>;
const ALL_KEYS = ['price', 'fundamentals', 'series', 'peers', 'spyRS', 'indicators', 'gann', 'confluence', 'options', 'macroRegime', 'institutionalHoldings', 'aiReview', 'brokerModel', 'schabackerModel', 'edwardsMageeModel', 'turtleModel', 'darkPool', 'playerMapping', 'zombieCompanyScreen', 'dilutionScreen', 'comparisonReport'];

function allWith(state: string): S {
  const out: S = {};
  for (const k of ALL_KEYS) out[k] = { label: 'Label ' + k, state, detail: '' };
  return out;
}

/** Run statuses for the banner and the run summary (index 12 is the mixed one). */
export function bannerStatuses(): Array<readonly [string, RunStatus | null | undefined]> {
  const mixed: S = {
    price: { label: 'Price (OHLCV)', state: 'failed', detail: 'HTTP 429 from https://query1.finance.yahoo.com/v8/finance/chart/PLTR' },
    fundamentals: { label: 'Fundamentals', state: 'degraded', detail: 'no PEG ratio' },
    series: { label: 'Finnhub series', state: 'skipped', detail: '' },
    peers: { label: 'Peer comparison', state: 'failed' },
    spyRS: { label: 'SPY / Relative Str.', state: 'ok', detail: 'fine' },
    indicators: { state: 'degraded' },
    gann: { label: 'Gann levels', state: 'pending', detail: 'not reached' },
    confluence: { label: 'Entry/exit zones', state: 'weird', detail: 'unknown state' },
    options: null,
    macroRegime: { label: 'Macro regime', state: 'skipped', detail: 'no snapshot' },
    bogus: { label: 'Not a tracked source', state: 'failed', detail: 'ignored' },
    comparisonReport: { label: 'Model comparison report', state: 'degraded', detail: 'one model missing' },
  };
  return [
    ['undefined', undefined], ['null', null], ['empty', {}],
    ['all ok', allWith('ok')], ['all pending', allWith('pending')],
    ['unknown states and untracked keys only', { price: { label: 'P', state: 'weird' }, bogus: { label: 'B', state: 'failed' } }],
    ['one degraded', { gann: { label: 'Gann levels', state: 'degraded', detail: 'few pivots' } }],
    ['one failed', { price: { label: 'Price (OHLCV)', state: 'failed', detail: 'no bars' } }],
    ['one skipped', { darkPool: { label: 'Dark pool share (FINRA)', state: 'skipped', detail: 'not a US ticker' } }],
    ['all failed', allWith('failed')],
    ['label only, no detail', { price: { label: 'Price (OHLCV)', state: 'failed' } }],
    ['neither label nor detail', { price: { state: 'failed' }, gann: { label: 'Gann levels', state: 'degraded', detail: 'x' } }],
    ['mixed', mixed],
  ];
}

/** Run statuses for the failure sheet, built on the real newDataStatus record: null, empty, all pending, mixed. */
export function failureStatuses(): Array<readonly [string, RunStatus | null | undefined]> {
  const s = newDataStatus() as unknown as Record<string, any>;
  s.price.state = 'ok'; s.price.detail = '250 bars';
  s.fundamentals.state = 'degraded'; s.fundamentals.detail = 'FMP: HTTP 429 rate limited';
  s.series.state = 'failed'; s.series.detail = 'Finnhub 500';
  s.spyRS.state = 'skipped'; s.spyRS.detail = 'SPY has no data';
  s.indicators.state = 'weird';
  s.gann.label = ''; s.gann.state = 'ok';
  delete s.macroRegime;
  s.options = null;
  s.aiReview.detail = undefined; s.aiReview.state = 'degraded';
  return [['null', null], ['empty', {}], ['all pending', newDataStatus() as unknown as RunStatus], ['mixed', s as RunStatus]];
}
