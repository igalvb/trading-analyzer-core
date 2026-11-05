/**
 * FL-17b: the four newer models in the per-ticker reports (owner 2026-10-28), DISPLAY ONLY.
 *
 *   Wyckoff (original method)              models/wyckoffClassic.ts, the last day of wyckoffClassicSeries
 *   Trend 150 / Trend 200                  models/trendFollow.ts trendSeries(closes, 150 | 200), last day
 *   Turtle + Schabacker + E&M, 2 of 3      from the comparison's own turtle / schabacker / edwardsMagee directions
 *
 * plus the older engine Wyckoff read (indicators/wyckoff.ts, rectangle-based), labelled as such so the two are
 * never confused. Nothing here feeds a score, the conviction, the verdict or a Buy report tier: the reads are
 * computed after the analysis, from the price chart it already fetched (price only, causal: the last bar's read
 * uses bars up to that bar) and the comparison it already built. No model logic is changed or re-implemented.
 */

import { wyckoffClassicSeries, type WyckoffEvent } from './models/wyckoffClassic.ts';
import { trendSeries, TREND } from './models/trendFollow.ts';
import { formatDateInTz } from '../core/dates.ts';
import { readJamesReads, type JamesReads } from './jamesPages.ts';
import { readJames2Reads, type James2Reads } from './jamesPhase2Pages.ts';
import { readJames3Reads, type James3Reads } from './jamesPhase3Pages.ts';
import { readJames4Reads, type James4Reads } from './jamesPhase4Pages.ts';
import { readJames5Reads, type James5Reads } from './jamesPhase5Pages.ts';

export type ExtraDirection = 'bullish' | 'mixed' | 'cautionary';
export type ExtraModelId = 'WYCKOFF_CLASSIC' | 'TREND_150' | 'TREND_200' | 'COMBO_TSE';

export interface ExtraModelRead {
  readonly id: ExtraModelId;
  /** Plain label, e.g. 'Wyckoff (original method)'. */
  readonly name: string;
  /** Null when the model could not be read (not enough history, inputs missing). */
  readonly direction: ExtraDirection | null;
  /** One line for the summary rows (Bottom Line, Buy and Exit reports). */
  readonly summary: string;
  /** The model tab's detail lines. */
  readonly detail: readonly string[];
}

export interface EngineWyckoffRead {
  readonly found: boolean;
  /** One plain line. */
  readonly summary: string;
}

export interface ExtraModelsReport {
  readonly ticker: string;
  readonly models: readonly ExtraModelRead[];
  /** The older engine Wyckoff read (rectangle-based), kept and labelled; not one of the four. */
  readonly engineWyckoff: EngineWyckoffRead;
  /**
   * FL-17e: "Everything together" (engine says buy OR the combo is bullish; sell 3% under the 200-day average).
   * Present only when the run passed the engine's read (Bottom Line line and the Combo Models tab; not in the Buy/Exit rows).
   */
  readonly everything?: EverythingRead;
  /**
   * James's models, phase 1 (analysis/jamesPages.ts): the LILO v2 and Profit-Taking layers of the run, for the
   * Bottom Line's two "James — " lines. Never printed in the Buy and Exit reports (extraModelRows leaves it out).
   */
  readonly james?: JamesReads;
  /** James's models, phase 2 (analysis/jamesPhase2Pages.ts): the Bottom Line's three lines; never in the Buy / Exit reports. */
  readonly james2?: James2Reads;
  /** James's models, phase 3 (analysis/jamesPhase3Pages.ts): the Bottom Line's two lines; never in the Buy / Exit reports. */
  readonly james3?: James3Reads;
  /** James's models, phase 4 (analysis/jamesPhase4Pages.ts): the Bottom Line's lines; never in the Buy / Exit reports. */
  readonly james4?: James4Reads;
  /** James's models, phase 5 (analysis/jamesPhase5Pages.ts): the Bottom Line's line; never in the Buy / Exit reports. */
  readonly james5?: James5Reads;
}

/** FL-17e: what the engine said, for "Everything together" (decision.finalConviction, techPlan.timing). */
export interface EngineBuyInputs {
  readonly finalConviction?: number | null;
  readonly timing?: string | null;
}

export interface EverythingRead {
  /** null = neither the engine read nor the combo was available. */
  readonly buy: boolean | null;
  readonly summary: string;
  readonly detail: readonly string[];
}

export const EVERYTHING_NAME = 'Everything together (engine or combo)';
/** The engine's tier-1 buy read (paper/paperLab.ts says, research/lab.ts tier1): conviction >= 70 or timing BUY_NOW. */
export const ENGINE_BUY_MIN_CONVICTION = 70;
export function engineSaysBuy(e: EngineBuyInputs | null | undefined): boolean | null {
  if (!e || typeof e.finalConviction !== 'number' || !Number.isFinite(e.finalConviction)) return null;
  return e.timing === 'BUY_NOW' || e.finalConviction >= ENGINE_BUY_MIN_CONVICTION;
}
const TIMING_WORDS: Readonly<Record<string, string>> = { BUY_NOW: 'buy now', WAIT_PULLBACK: 'wait for a pullback', AVOID: 'avoid' };
export const timingWords = (t: string | null | undefined): string => (t ? TIMING_WORDS[t] ?? t : 'not available');

export const EXTRA_MODEL_NAMES: Readonly<Record<ExtraModelId, string>> = {
  WYCKOFF_CLASSIC: 'Wyckoff (original method)',
  TREND_150: 'Trend 150 (150-day average)',
  TREND_200: 'Trend 200 (200-day average)',
  COMBO_TSE: 'Turtle + Schabacker + E&M (2 of 3)',
};
export const EXTRA_MODEL_ORDER: readonly ExtraModelId[] = ['WYCKOFF_CLASSIC', 'TREND_150', 'TREND_200', 'COMBO_TSE'];
export const ENGINE_WYCKOFF_NAME = 'Wyckoff (older engine read, rectangle-based)';
export const EXTRA_MODELS_HEADER = 'More model reads (Wyckoff, trend, combo).';
export const EXTRA_MODELS_DISCLAIMER = 'Shown for information only: these reads do not change any score, the conviction, the verdict or the Buy report tiers.';

const WORD: Readonly<Record<ExtraDirection, string>> = { bullish: 'Bullish', mixed: 'Mixed', cautionary: 'Cautionary' };
export const directionWord = (d: ExtraDirection | null): string => (d ? WORD[d] : 'Not available');

const EVENT_WORDS: Readonly<Record<WyckoffEvent, string>> = {
  SC: 'selling climax', AR: 'automatic rally', ST: 'secondary test', SPRING: 'spring (dip under the range that closed back inside)',
  TEST: 'test of the spring', SOS: 'sign of strength (high-volume close above the range)', LPS: 'last point of support',
  BC: 'buying climax', 'AR-D': 'automatic reaction', 'ST-D': 'secondary test', UTAD: 'upthrust after distribution',
  SOW: 'sign of weakness (high-volume close below the range)', LPSY: 'last point of supply', FAILED: 'range broke down',
};
const CONTEXT_WORDS: Readonly<Record<string, string>> = {
  accumulation: 'accumulation range', markup: 'markup (uptrend after accumulation)', distribution: 'distribution range', markdown: 'markdown (downtrend)',
};

const usd = (n: number): string => '$' + n.toFixed(2);
const pctAway = (s: number): string => Math.abs(s * 100).toFixed(1) + '% ' + (s >= 0 ? 'above' : 'below');

export interface ExtraModelsChart {
  readonly dates: readonly Date[];
  readonly opens: readonly number[];
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly closes: readonly number[];
  readonly volumes: readonly number[];
}

/** The three comparison directions the combo reads (ComparisonReport fields; absent = that model did not run). */
export interface ComboInputs {
  readonly turtleDirection?: string | null;
  readonly schabackerDirection?: string | null;
  readonly edwardsMageeDirection?: string | null;
}

const isDir = (x: unknown): x is ExtraDirection => x === 'bullish' || x === 'mixed' || x === 'cautionary';

export function wyckoffClassicModel(chart: ExtraModelsChart, timeZone = 'America/New_York'): ExtraModelRead {
  const name = EXTRA_MODEL_NAMES.WYCKOFF_CLASSIC;
  const series = chart.closes.length ? wyckoffClassicSeries(chart) : [];
  const day = series[series.length - 1];
  if (!day) return { id: 'WYCKOFF_CLASSIC', name, direction: null, summary: 'Not enough price history.', detail: ['Not enough price history.'] };
  const dateOf = (i: number): string => { const d = chart.dates[i]; return d ? formatDateInTz(d, timeZone, 'yyyy-MM-dd') : '?'; };
  const events: string[] = [];
  for (let i = Math.max(0, series.length - 260); i < series.length; i++) {
    const e = series[i]!.event;
    if (e) events.push(dateOf(i) + ' ' + EVENT_WORDS[e]);
  }
  const where = day.context ? CONTEXT_WORDS[day.context] + (day.phase ? ', phase ' + day.phase : '') : 'no Wyckoff trading range found';
  const range = day.support != null && day.resistance != null ? 'Trading range ' + usd(day.support) + ' to ' + usd(day.resistance) : 'No open trading range';
  const latest = events.length ? 'latest event: ' + events[events.length - 1] : 'no events in the last year';
  return {
    id: 'WYCKOFF_CLASSIC', name, direction: day.direction,
    summary: WORD[day.direction] + ' — ' + where + '. ' + range + '; ' + latest + '.',
    detail: [
      'Direction: ' + WORD[day.direction] + ' (' + where + ')',
      range,
      'Events in the last year: ' + (events.length ? events.slice(-8).join(', ') : 'none'),
      'Reads accumulation (selling climax, spring, sign of strength) and distribution (buying climax, upthrust, sign of weakness) on daily price and volume.',
    ],
  };
}

/** D9: 'price' while today's bar is still live (market open), 'close' otherwise. */
export type LastPriceWord = 'close' | 'price';

export function trendModel(closes: readonly number[], days: 150 | 200, priceWord: LastPriceWord = 'close'): ExtraModelRead {
  const id: ExtraModelId = days === 150 ? 'TREND_150' : 'TREND_200';
  const name = EXTRA_MODEL_NAMES[id];
  const s = trendSeries(closes, days);
  const last = s[s.length - 1];
  if (!last || last.sma == null || last.strength == null) {
    const why = 'Not enough price history (needs ' + days + ' trading days).';
    return { id, name, direction: null, summary: why, detail: [why] };
  }
  const close = closes[closes.length - 1] as number;
  const prev = s.length > TREND.slopeDays ? s[s.length - 1 - TREND.slopeDays]!.sma : null;
  const slope = prev == null ? null : last.sma > prev ? 'rising' : last.sma < prev ? 'falling' : 'flat';
  const where = priceWord + ' ' + usd(close) + ' is ' + pctAway(last.strength) + ' the ' + days + '-day average (' + usd(last.sma) + ')';
  return {
    id, name, direction: last.direction,
    summary: WORD[last.direction] + ' — ' + where + (slope ? ', average ' + slope : '') + '.',
    detail: [
      'Direction: ' + WORD[last.direction],
      days + '-day average: ' + usd(last.sma) + '; ' + priceWord + ' ' + usd(close) + ' is ' + pctAway(last.strength) + ' it',
      slope ? 'The average is ' + slope + ' against ' + TREND.slopeDays + ' trading days ago' : 'Not enough history to tell the average\'s slope',
      'Rule: bullish when the close is above the average and the average is higher than ' + TREND.slopeDays + ' days ago; cautionary when the close is more than '
        + (TREND.band * 100).toFixed(0) + '% under it; mixed otherwise.',
    ],
  };
}

export function comboModel(cmp: ComboInputs | null | undefined): ExtraModelRead {
  const id: ExtraModelId = 'COMBO_TSE';
  const name = EXTRA_MODEL_NAMES[id];
  const parts: Array<[string, unknown]> = [
    ['Turtle', cmp?.turtleDirection], ['Schabacker', cmp?.schabackerDirection], ['Edwards & Magee', cmp?.edwardsMageeDirection],
  ];
  const listed = parts.map(([n, d]) => n + ' ' + (isDir(d) ? d : 'not available')).join(', ');
  const avail = parts.map(([, d]) => d).filter(isDir);
  const rule = 'Rule: bullish when at least 2 of the 3 are bullish, cautionary when at least 2 are cautionary, mixed otherwise.';
  if (avail.length < 2) {
    const why = 'Not available — fewer than 2 of the 3 models ran (' + listed + ').';
    return { id, name, direction: null, summary: why, detail: [why, rule] };
  }
  const bull = avail.filter((d) => d === 'bullish').length;
  const caut = avail.filter((d) => d === 'cautionary').length;
  const direction: ExtraDirection = bull >= 2 ? 'bullish' : caut >= 2 ? 'cautionary' : 'mixed';
  const count = direction === 'bullish' ? bull + ' of 3 bullish' : direction === 'cautionary' ? caut + ' of 3 cautionary' : 'no 2 agree';
  return {
    id, name, direction,
    summary: WORD[direction] + ' — ' + count + ' (' + listed + ').',
    detail: ['Direction: ' + WORD[direction] + ' (' + count + ')', listed.charAt(0).toUpperCase() + listed.slice(1), rule],
  };
}

/**
 * FL-17e: "Everything together" -- BUY when the engine says buy (engineSaysBuy) OR the 2-of-3 combo is bullish;
 * a holder sells when the close is more than 3% under the 200-day average (Trend 200 turns cautionary). Display
 * only: the paper test's own rule (paperLab.ts model 'best', sell 'trend200'), shown, not re-scored.
 */
export function everythingModel(engine: EngineBuyInputs | null | undefined, combo: ExtraModelRead | null | undefined, closes: readonly number[], priceWord: LastPriceWord = 'close'): EverythingRead {
  const eng = engineSaysBuy(engine);
  const comboDir = combo ? combo.direction : null;
  const comboBull = comboDir === 'bullish';
  const engineText = eng == null ? 'not available'
    : (eng ? 'says buy' : 'does not say buy') + ' (conviction ' + engine!.finalConviction + ', timing: ' + timingWords(engine!.timing) + ')';
  const comboText = comboDir ? directionWord(comboDir).toLowerCase() : 'not available';
  const buy = eng == null && comboDir == null ? null : (eng === true || comboBull);
  const why = buy == null ? 'Not available — neither the engine read nor the combo was available.'
    : buy ? (eng && comboBull ? 'the engine says buy and the combo is bullish' : eng ? 'the engine says buy' : 'the 2-of-3 combo is bullish')
      : 'the engine does not say buy and the combo is ' + comboText;
  const s = trendSeries(closes, 200);
  const last = s[s.length - 1];
  let sell: string;
  if (!last || last.sma == null || last.strength == null) sell = 'Sell check: not enough price history for the 200-day average.';
  else {
    const out = last.direction === 'cautionary';
    sell = 'Sell check: ' + priceWord + ' ' + usd(closes[closes.length - 1] as number) + ' is ' + pctAway(last.strength) + ' the 200-day average (' + usd(last.sma) + ') — '
      + (out ? 'more than 3% under it, so a holder would sell.' : 'not 3% under it, so a holder keeps it.');
  }
  const summary = buy == null ? why : (buy ? 'Buy' : 'No buy') + ' — ' + why + '.';
  return {
    buy, summary,
    detail: [
      'Result: ' + (buy == null ? 'Not available' : buy ? 'BUY' : 'NO BUY') + (buy == null ? '' : ' (' + why + ')'),
      'Input 1, the engine: ' + engineText + '. The engine says buy when conviction is ' + ENGINE_BUY_MIN_CONVICTION + ' or more, or timing is buy now.',
      'Input 2, the Turtle + Schabacker + E&M combo: ' + comboText + '.',
      'Rule: buy when the engine says buy OR the combo is bullish; sell when the close is more than 3% under the 200-day average.',
      sell,
    ],
  };
}

export function engineWyckoffRead(ind: unknown): EngineWyckoffRead {
  const w = (ind as { wyckoffSchematic?: { phase?: unknown; stage?: unknown; read?: unknown } | null } | null | undefined)?.wyckoffSchematic;
  if (!w || typeof w.phase !== 'string' || typeof w.stage !== 'string') {
    return { found: false, summary: 'No schematic this run (it needs a rectangle chart pattern and a volume climax).' };
  }
  const phase = w.phase.charAt(0) + w.phase.slice(1).toLowerCase();
  return { found: true, summary: phase + ', stage ' + w.stage + (typeof w.read === 'string' && w.read ? ' — ' + w.read : '') };
}

/** All four reads plus the labelled older engine read. Each model is guarded on its own: one failing never hides another. */
export function buildExtraModelsReport(
  ticker: string, chart: ExtraModelsChart, comparison: ComboInputs | null | undefined, ind: unknown, timeZone = 'America/New_York',
  engineIn?: EngineBuyInputs | null,
  priceWord: LastPriceWord = 'close',
): ExtraModelsReport {
  const safe = (id: ExtraModelId, f: () => ExtraModelRead): ExtraModelRead => {
    try { return f(); } catch { return { id, name: EXTRA_MODEL_NAMES[id], direction: null, summary: 'This read could not be built this run.', detail: ['This read could not be built this run.'] }; }
  };
  let engine: EngineWyckoffRead;
  try { engine = engineWyckoffRead(ind); } catch { engine = { found: false, summary: 'Not available this run.' }; }
  const models = [
    safe('WYCKOFF_CLASSIC', () => wyckoffClassicModel(chart, timeZone)),
    safe('TREND_150', () => trendModel(chart.closes, 150, priceWord)),
    safe('TREND_200', () => trendModel(chart.closes, 200, priceWord)),
    safe('COMBO_TSE', () => comboModel(comparison)),
  ];
  if (engineIn === undefined) return { ticker, models, engineWyckoff: engine };
  let everything: EverythingRead;
  try { everything = everythingModel(engineIn, models[3], chart.closes, priceWord); } catch { everything = { buy: null, summary: 'This read could not be built this run.', detail: ['This read could not be built this run.'] }; }
  return { ticker, models, engineWyckoff: engine, everything };
}

/** The model tab text, in the style of the other model tabs. */
export function formatExtraModelsReport(r: ExtraModelsReport | null): string {
  if (!r) return 'No reads — the price data was not available.';
  const out: string[] = ['── ' + r.ticker + ' — Wyckoff, Trend and Combo Models ──', '', EXTRA_MODELS_DISCLAIMER];
  for (const m of r.models) {
    out.push('', m.name.toUpperCase() + ': ' + directionWord(m.direction));
    for (const d of m.detail) out.push('  - ' + d);
  }
  out.push('', ENGINE_WYCKOFF_NAME.toUpperCase() + ': ' + r.engineWyckoff.summary);
  out.push('  - The older Wyckoff read of the main engine, kept for reference; it is not the original method above and is not scored.');
  return out.join('\n');
}

/** Defensive reader for the reports (the report arrives as `unknown` through the pipelines). */
export function readExtraModels(x: unknown): ExtraModelsReport | null {
  if (x === null || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o['models'])) return null;
  const models: ExtraModelRead[] = [];
  for (const m of o['models'] as unknown[]) {
    if (m === null || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || !(r['id'] in EXTRA_MODEL_NAMES) || typeof r['summary'] !== 'string') continue;
    models.push({
      id: r['id'] as ExtraModelId, name: EXTRA_MODEL_NAMES[r['id'] as ExtraModelId], direction: isDir(r['direction']) ? r['direction'] : null,
      summary: r['summary'], detail: Array.isArray(r['detail']) ? (r['detail'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    });
  }
  const e = o['engineWyckoff'] as Record<string, unknown> | null | undefined;
  const engineWyckoff: EngineWyckoffRead = e && typeof e === 'object' && typeof e['summary'] === 'string'
    ? { found: e['found'] === true, summary: e['summary'] } : { found: false, summary: 'Not available this run.' };
  const ev = o['everything'] as Record<string, unknown> | null | undefined;
  const everything: EverythingRead | undefined = ev && typeof ev === 'object' && typeof ev['summary'] === 'string'
    ? { buy: typeof ev['buy'] === 'boolean' ? ev['buy'] : null, summary: ev['summary'], detail: Array.isArray(ev['detail']) ? (ev['detail'] as unknown[]).filter((s): s is string => typeof s === 'string') : [] }
    : undefined;
  const james = readJamesReads(o['james']), james2 = readJames2Reads(o['james2']), james3 = readJames3Reads(o['james3']), james4 = readJames4Reads(o['james4']), james5 = readJames5Reads(o['james5']);
  return { ticker: typeof o['ticker'] === 'string' ? o['ticker'] : '', models, engineWyckoff, ...(everything ? { everything } : {}), ...(james ? { james } : {}), ...(james2 ? { james2 } : {}), ...(james3 ? { james3 } : {}), ...(james4 ? { james4 } : {}), ...(james5 ? { james5 } : {}) };
}

/** Summary rows ([label, text]) for the Bottom Line, Buy and Exit reports, the four models in order, then the older engine read. */
export function extraModelRows(r: ExtraModelsReport, opts: { readonly withEverything?: boolean } = {}): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const id of EXTRA_MODEL_ORDER) {
    const m = r.models.find((x) => x.id === id);
    rows.push([EXTRA_MODEL_NAMES[id], m ? m.summary : 'Not available this run.']);
    // FL-17e: the Bottom Line shows "Everything together" right after the combo line (not the Buy/Exit rows).
    if (id === 'COMBO_TSE' && opts.withEverything && r.everything) rows.push([EVERYTHING_NAME, r.everything.summary]);
  }
  rows.push([ENGINE_WYCKOFF_NAME, r.engineWyckoff.summary]);
  return rows;
}
