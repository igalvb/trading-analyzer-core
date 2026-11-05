/**
 * The macro regime read and Dow Theory confirmation -- pure analysis over
 * cached daily series, ported exactly from macro_fetchers_v0_15.gs:
 *   alignSeries_Macro :403-419         pctChange_Macro :421-424
 *   classifyMacroRegimeAt_Macro :432-448
 *   computeDowTheoryConfirmationV1_ :238-267 (the cache reads lifted out)
 *   testMacroRegimePredictiveValue :454-484 (the fetch lifted out)
 *
 * alignSeries keys days by Date#toDateString(), which Apps Script evaluates
 * in the SCRIPT's zone; dateStringInTz reproduces that string for an
 * explicit zone. The keys only need to identify calendar days consistently,
 * which they do in any zone for these UTC-midnight bars.
 */

import type { MacroSeries } from '../storage/macroCaches.ts';

/** The 9-ticker risk-appetite basket (fullStockAnalysisV10_9.gs:3144 / dataLayerV1.gs:1857). */
export const MACRO_REGIME_TICKERS: readonly string[] = ['SPY', 'TLT', 'GLD', 'XLP', 'XLU', 'XLV', 'XLY', 'XLI', 'XLB'];
/** fullStockAnalysisV10_9.gs:3156 -- the lookback validated in MACRO_REGIME_VALIDATION_RESULTS.md. */
export const MACRO_REGIME_LOOKBACK = 20;
/** macro_fetchers_v0_15.gs:224 -- Industrials and Transports proxies. */
export const DOW_THEORY_TICKERS: readonly string[] = ['DIA', 'IYT'];

export type MacroRegime = 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL';

const dateStringFormatters = new Map<string, Intl.DateTimeFormat>();

/** Date#toDateString() ("Tue Oct 20 2026") as seen in `timeZone`. */
export function dateStringInTz(d: Date, timeZone: string): string {
  if (isNaN(d.getTime())) return 'Invalid Date';
  let f = dateStringFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
    dateStringFormatters.set(timeZone, f);
  }
  const p = f.formatToParts(d);
  const g = (t: Intl.DateTimeFormatPartTypes): string => (p.find((x) => x.type === t) as Intl.DateTimeFormatPart).value;
  return g('weekday') + ' ' + g('month') + ' ' + g('day') + ' ' + g('year').padStart(4, '0');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The calendar day a dateStringInTz string names, as a sortable number (legacy sorts by `new Date(str)`). */
function dayKey(s: string): number {
  const [, mon, day, year] = s.split(' ');
  return Date.UTC(Number(year), MONTHS.indexOf(mon), Number(day));
}

/** Per-ticker closes on the trading days common to every series, plus `_dates`. */
export interface AlignedSeries {
  readonly _dates: string[];
  readonly [ticker: string]: any;
}

/** alignSeries_Macro (:403-419): keeps only the dates present in every series. */
export function alignSeries(seriesMap: Readonly<Record<string, Pick<MacroSeries, 'dates' | 'closes'>>>, timeZone: string): AlignedSeries {
  const dateSets = Object.keys(seriesMap).map((k) => new Set(seriesMap[k].dates.map((d) => dateStringInTz(d, timeZone))));
  let common = dateSets[0];
  for (let i = 1; i < dateSets.length; i++) {
    common = new Set([...common].filter((d) => dateSets[i].has(d)));
  }
  const sortedDates = [...common].sort((a, b) => dayKey(a) - dayKey(b));
  const aligned: Record<string, unknown> = {};
  Object.keys(seriesMap).forEach((k) => {
    const s = seriesMap[k];
    const dateToClose: Record<string, number> = {};
    s.dates.forEach((d, i) => { dateToClose[dateStringInTz(d, timeZone)] = s.closes[i]; });
    aligned[k] = sortedDates.map((d) => dateToClose[d]);
  });
  aligned._dates = sortedDates;
  return aligned as unknown as AlignedSeries;
}

/** pctChange_Macro (:421-424). */
export function pctChange(closes: ReadonlyArray<number | undefined>, idx: number, lookback: number): number | null {
  if (idx < lookback) return null;
  return ((closes[idx] as number) - (closes[idx - lookback] as number)) / (closes[idx - lookback] as number);
}

/**
 * classifyMacroRegimeAt_Macro (:432-448): a 3-vote majority -- bonds vs
 * stocks, gold vs stocks, defensives vs cyclicals -- over `lookback` bars
 * ending at `idx`. Kept: the sector averages add `pctChange` results
 * directly, so a null there counts as 0 rather than making the average NaN.
 * With three binary votes one side always has 2+, so 'NEUTRAL' is never
 * returned (F-44); the branch is kept.
 */
export function classifyMacroRegimeAt(aligned: AlignedSeries, idx: number, lookback: number): MacroRegime | null {
  const spy = pctChange(aligned.SPY, idx, lookback);
  const tlt = pctChange(aligned.TLT, idx, lookback);
  const gld = pctChange(aligned.GLD, idx, lookback);
  const defensive = ((pctChange(aligned.XLP, idx, lookback) as number) + (pctChange(aligned.XLU, idx, lookback) as number) + (pctChange(aligned.XLV, idx, lookback) as number)) / 3;
  const cyclical = ((pctChange(aligned.XLY, idx, lookback) as number) + (pctChange(aligned.XLI, idx, lookback) as number) + (pctChange(aligned.XLB, idx, lookback) as number)) / 3;
  if (spy == null || tlt == null || gld == null || isNaN(defensive) || isNaN(cyclical)) return null;

  let riskOffVotes = 0, riskOnVotes = 0;
  if (tlt > spy) riskOffVotes++; else riskOnVotes++;
  if (gld > spy) riskOffVotes++; else riskOnVotes++;
  if (defensive > cyclical) riskOffVotes++; else riskOnVotes++;

  if (riskOffVotes >= 2) return 'RISK_OFF';
  if (riskOnVotes >= 2) return 'RISK_ON';
  return 'NEUTRAL';
}

export type DowTheoryVerdict = 'BULL_CONFIRMED' | 'BEAR_CONFIRMED' | 'NON_CONFIRMATION_BULL' | 'NON_CONFIRMATION_BEAR' | 'NEUTRAL';

export interface DowTheoryAverage {
  readonly ticker: string;
  readonly newHigh: boolean;
  readonly newLow: boolean;
  readonly close: number;
  readonly extremeHighDate: Date | null;
  readonly extremeLowDate: Date | null;
}

export interface DowTheoryConfirmation {
  verdict: DowTheoryVerdict | null;
  industrials: DowTheoryAverage | null;
  transports: DowTheoryAverage | null;
  asOfDate: Date | null;
  lagTradingDays: number | null;
}

/**
 * computeDowTheoryConfirmationV1_ (:238-267), given the two cached series:
 * a new 252-day CLOSING high or low on any of the last 42 trading days
 * ("a month or two"). Both averages agreeing confirms; only one is a
 * non-confirmation. Needs a full year of each, else every field stays null.
 */
export function computeDowTheoryConfirmation(dia: MacroSeries | null, iyt: MacroSeries | null): DowTheoryConfirmation {
  const out: DowTheoryConfirmation = { verdict: null, industrials: null, transports: null, asOfDate: null, lagTradingDays: null };
  try {
    if (!dia || !iyt || dia.closes.length < 252 || iyt.closes.length < 252) return out;
    const TRADING_DAYS_PER_MONTH = 21;
    const LOOKBACK_WINDOW = 2 * TRADING_DAYS_PER_MONTH;
    const scan = (series: MacroSeries) => {
      const closes = series.closes, n = closes.length;
      let highIdx = -1, lowIdx = -1;
      for (let i = Math.max(251, n - LOOKBACK_WINDOW); i < n; i++) {
        const window = closes.slice(Math.max(0, i - 251), i + 1);
        if (closes[i] >= Math.max(...window)) highIdx = i;
        if (closes[i] <= Math.min(...window)) lowIdx = i;
      }
      return {
        newHigh: highIdx !== -1, newLow: lowIdx !== -1, highIdx, lowIdx, close: closes[n - 1], date: series.dates[n - 1],
        highDate: highIdx !== -1 ? series.dates[highIdx] : null, lowDate: lowIdx !== -1 ? series.dates[lowIdx] : null,
      };
    };
    const ind = scan(dia), trn = scan(iyt);
    out.industrials = { ticker: 'DIA', newHigh: ind.newHigh, newLow: ind.newLow, close: ind.close, extremeHighDate: ind.highDate, extremeLowDate: ind.lowDate };
    out.transports = { ticker: 'IYT', newHigh: trn.newHigh, newLow: trn.newLow, close: trn.close, extremeHighDate: trn.highDate, extremeLowDate: trn.lowDate };
    out.asOfDate = ind.date;
    if (ind.newHigh && trn.newHigh) { out.verdict = 'BULL_CONFIRMED'; out.lagTradingDays = Math.abs(ind.highIdx - trn.highIdx); }
    else if (ind.newLow && trn.newLow) { out.verdict = 'BEAR_CONFIRMED'; out.lagTradingDays = Math.abs(ind.lowIdx - trn.lowIdx); }
    else if (ind.newHigh !== trn.newHigh && (ind.newHigh || trn.newHigh)) out.verdict = 'NON_CONFIRMATION_BULL';
    else if (ind.newLow !== trn.newLow && (ind.newLow || trn.newLow)) out.verdict = 'NON_CONFIRMATION_BEAR';
    else out.verdict = 'NEUTRAL';
  } catch {
    /* non-fatal */
  }
  return out;
}

export interface PredictiveValueResult {
  readonly regime: MacroRegime;
  readonly n: number;
  readonly mean: number;
  readonly hitRate: number;
}

/**
 * testMacroRegimePredictiveValue (:454-484), after the fetch: the regime
 * every 5 bars (20-bar lookback, 30-bar warm-up) against SPY's forward
 * 20-bar return. A diagnostic; returns the per-regime summary and logs it.
 */
export function macroRegimePredictiveValue(seriesMap: Readonly<Record<string, MacroSeries>>, timeZone: string, log: (msg: string) => void): PredictiveValueResult[] {
  const aligned = alignSeries(seriesMap, timeZone);
  log('Aligned to ' + aligned._dates.length + ' common trading days, ' + aligned._dates[0] + ' to ' + aligned._dates[aligned._dates.length - 1]);
  const LOOKBACK = 20, HORIZON = 20, WARMUP = 30, STEP = 5;
  const results: Record<MacroRegime, number[]> = { RISK_ON: [], RISK_OFF: [], NEUTRAL: [] };
  for (let i = WARMUP; i < aligned._dates.length - HORIZON; i += STEP) {
    const regime = classifyMacroRegimeAt(aligned, i, LOOKBACK);
    if (!regime) continue;
    const fwdReturn = (aligned.SPY[i + HORIZON] - aligned.SPY[i]) / aligned.SPY[i];
    results[regime].push(fwdReturn);
  }
  log('\n=== Macro regime -> SPY forward 20-day return ===');
  const out: PredictiveValueResult[] = [];
  (['RISK_ON', 'NEUTRAL', 'RISK_OFF'] as const).forEach((regime) => {
    const arr = results[regime];
    if (!arr.length) { log(regime + ': no observations'); return; }
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const hitRate = arr.filter((r) => r > 0).length / arr.length;
    out.push({ regime, n: arr.length, mean, hitRate });
    log(regime + ': n=' + arr.length + '  mean SPY fwd return=' + (mean * 100).toFixed(2) + '%  hitRate=' + (hitRate * 100).toFixed(0) + '%');
  });
  log('\nHonest check: does RISK_OFF actually precede WORSE SPY returns than RISK_ON? If not, this regime read has no real predictive value as built and should not be trusted, per BIG_PICTURE_ANALYSIS_PLAN.md Section 3b.');
  return out;
}
