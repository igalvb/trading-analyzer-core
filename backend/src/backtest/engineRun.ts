/**
 * Backlog 9: run the REAL engine for one simulated day, offline.
 *
 * The full per-ticker analysis (runTickerAnalysisDetailed: engine + Broker Course + Schabacker + Edwards & Magee
 * + Turtle + the 5-voice comparison) through composeServices/tickerDeps in memory mode, the clock at the
 * simulated day 23:00 UTC (after the close, before New York midnight, like the nightly), the network replaced by
 * PointInTimeTransport. Nothing here computes a score: it only reads what the engine produced.
 *
 * And the engine's own exit read for a held position (analysis/exitRead.ts computePositionExitRead, classified by
 * the Exit pipeline's own classifyStockAction), given the real simulated entry date and price.
 */

import { composeServices, tickerDeps, type Services } from '../compose.ts';
import { refreshMacroRegimeCache, refreshMacroSnapshot } from '../fetch/macro/refresh.ts';
import { macroResponder, type MacroArchive } from './macroData.ts';
import { LogLevel } from '../core/logger.ts';
import { OWN_BLOCK_FLOOR } from '../types/decision.ts';
import { computePositionExitRead } from '../analysis/exitRead.ts';
import { classifyStockAction, type ActionClass } from '../jobs/exit/exitPipeline.ts';
import { runTickerAnalysisDetailed, type TickerAnalysisDeps, type TickerArtifacts } from '../analysis/runTicker.ts';
import { PointInTimeTransport, chartFromBars, lastIndexOnOrBefore, TWO_YEAR_BARS, type PriceSeries } from './data.ts';

/** The same non-secret settings the offline tests use. No provider key is ever passed, so nothing can go live. */
export const BACKTEST_ENV: Readonly<Record<string, string>> = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York' };

/** What the policy needs from one engine run. */
export interface EngineRead {
  readonly ticker: string;
  readonly day: string;
  /** False when the run aborted (e.g. fewer than 60 bars after a listing) or produced no decision. */
  readonly ok: boolean;
  readonly aborted?: string;
  readonly finalConviction: number | null;
  readonly action: string | null;
  readonly timing: string | null;
  readonly regime: string | null;
  readonly entryPrice: number | null;
  readonly entryHigh: number | null;
  readonly entryConfidencePct: number | null;
  readonly stop: number | null;
  /** The fundamentals score (null here: fundamentals are excluded) and the Buy report's block rule on it. */
  readonly ownScore: number | null;
  readonly blocked: boolean;
  /** The 5-voice comparison verdict; null when the comparison report was not built. */
  readonly verdict: string | null;
  readonly directions: Readonly<Record<string, string | null>>;
  readonly close: number | null;
  /** Research extras (owner 2026-10-28: Wyckoff and LILO as models of their own). */
  readonly wyckoff?: { readonly phase: string; readonly stage: string } | null;
  /** LILO inputs: the confluence entry zone and count, and the plan's T1/T2. */
  readonly lilo?: { readonly entryLow: number | null; readonly entryHigh: number | null; readonly entryCount: number | null; readonly t1: number | null; readonly t2: number | null } | null;
  /** Research extras (fix plan B1/D2 targets test): the plan's R:R to T1 at the entry and the T1 time estimate in days. */
  readonly rrToT1?: number | null;
  readonly t1Days?: number | null;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** What the policy needs, read from one finished analysis (shared by the backtest and the live paper trading). */
export function engineReadOf(art: TickerArtifacts, t: string, day: string, close: number | null): EngineRead {
  const r = art.result;
  const cmp = art.reports.comparison ?? null;
  const own = r ? num(r.fundResult.score) : null;
  return {
    ticker: t, day, ok: !!r, ...(art.aborted ? { aborted: art.aborted } : {}),
    finalConviction: r ? num(r.decision.finalConviction) : null,
    action: r ? r.decision.action : null,
    timing: r ? (r.techPlan.timing ?? null) : null,
    regime: r ? (r.techPlan.regime ?? null) : null,
    entryPrice: r ? num(r.techPlan.entryPrice) : null,
    entryHigh: r ? num(r.techPlan.entryHigh) : null,
    entryConfidencePct: r ? num(r.techPlan.entryConfidencePct) : null,
    stop: r ? num(r.techPlan.stop) : null,
    ownScore: own,
    blocked: own != null && own <= OWN_BLOCK_FLOOR,
    verdict: cmp && cmp.verdict ? cmp.verdict : null,
    directions: cmp ? {
      engine: cmp.existingDirection ?? null, broker: cmp.newDirection ?? null, schabacker: cmp.schabackerDirection ?? null,
      edwardsMagee: cmp.edwardsMageeDirection ?? null, turtle: cmp.turtleDirection ?? null,
    } : {},
    close,
    wyckoff: wyckoffOf(art),
    lilo: r ? {
      entryLow: num(art.confluence?.entryLow), entryHigh: num(art.confluence?.entryHigh), entryCount: num(art.confluence?.entryCount),
      t1: num((r.techPlan.t1 as { price?: unknown } | null | undefined)?.price), t2: num((r.techPlan.t2 as { price?: unknown } | null | undefined)?.price),
    } : null,
    rrToT1: r ? num(r.techPlan.rrToT1) : null,
    t1Days: r ? num((r.techPlan.t1Time as { baseDays?: unknown } | null | undefined)?.baseDays) : null,
  };
}

function wyckoffOf(art: TickerArtifacts): { phase: string; stage: string } | null {
  const w = (art.ind as { wyckoffSchematic?: { phase?: unknown; stage?: unknown } | null } | undefined)?.wyckoffSchematic;
  return w && typeof w.phase === 'string' && typeof w.stage === 'string' ? { phase: w.phase, stage: w.stage } : null;
}

/** Research options of a simulated run. Default: production exactly. */
export interface EngineRunOptions {
  /** Fix plan B1/D2: the nearest-cluster T1/T2 rule (techPlan/entryPlan.ts ExitTargetOptions). Default off. */
  readonly nearestTargets?: boolean;
  /** Fix plan B1 option B part 2: T2 skips excluded methods (ExitTargetOptions.fixedT2). */
  readonly fixedT2?: boolean;
  /**
   * Backlog 37 (simulation v2): the macro archive. Given, each simulated day first runs the nightly's own macro
   * refresh (refreshMacroRegimeCache + refreshMacroSnapshot) against it, cut at that day, so the engine reads the
   * regime, M2 / yield curve / GDP, Dow Theory and the DGS10 / FEDFUNDS / GDP snapshot as of the day. Absent: v1 (no macro).
   */
  readonly macro?: MacroArchive | null;
  /**
   * LONG_HISTORY_PLAN A/B: the bars each chart holds. Default TWO_YEAR_BARS (production today: the '2y' cache);
   * Infinity = the full history on or before the day (the long-history store merged in front of the cache).
   */
  readonly chartBars?: number;
}

/** Backlog 37: fill the day's in-memory macro caches through the production refresh (the nightly's step), as of the clock's day. */
export async function seedMacroCaches(s: Services): Promise<void> {
  await refreshMacroRegimeCache(s.macroDeps);
  await refreshMacroSnapshot(s.macroDeps);
}

/** One simulated day: a fresh in-memory composition per day (like one nightly), every listed ticker analysed in order. */
export async function runEngineDay(
  series: ReadonlyMap<string, PriceSeries>, day: string, tickers: readonly string[], o: EngineRunOptions = {},
): Promise<EngineRead[]> {
  const transport = new PointInTimeTransport(series, day, o.macro ? macroResponder(o.macro) : null, o.chartBars ?? TWO_YEAR_BARS);
  const nowMs = Date.parse(day + 'T23:00:00Z');
  const s = await composeServices({
    storage: 'memory', env: BACKTEST_ENV, transport, clock: { now: () => nowMs }, noAi: true,
    logSink: () => {}, logLevel: LogLevel.ERROR, sleep: async () => {}, mode: 'ticker',
  });
  if (o.macro) await seedMacroCaches(s);
  const wb = await s.openWorkbook();
  // The real renderers stay in (they only write in-memory report tabs): the run is the production one, unchanged.
  const base: TickerAnalysisDeps = tickerDeps(s, wb, { noAi: true });
  const deps: TickerAnalysisDeps = o.nearestTargets || o.fixedT2 ? { ...base, ...(o.nearestTargets ? { nearestTargets: true } : {}), ...(o.fixedT2 ? { fixedT2: true } : {}) } : base;
  const out: EngineRead[] = [];
  for (const t of tickers) {
    const sr = series.get(t);
    const ci = sr ? lastIndexOnOrBefore(sr, day) : -1;
    const close = sr && ci >= 0 && sr.dates[ci] === day ? (sr.closes[ci] as number) : null;
    out.push(engineReadOf(await runTickerAnalysisDetailed(deps, t), t, day, close));
  }
  return out;
}

/** The engine's exit read for a held position, and the Exit pipeline's class for it. */
export interface ExitReadResult {
  readonly ticker: string;
  readonly day: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly actionClass: ActionClass | null;
  readonly recommendation: string | null;
  readonly stopBreached: boolean;
  readonly thesisInvalidated: boolean;
  readonly hitT1: boolean;
  readonly hitT2: boolean;
  readonly t1: number | null;
  readonly t2: number | null;
  readonly stopLevel: number | null;
  readonly close: number | null;
}

/**
 * The live Exit step reads a plain chart from the price store, which keeps growing night after night. Here: the
 * last TWO_YEAR_BARS bars on or before `day`, reaching further back when needed so the entry bar and 20 bars
 * before it (the Turtle N) are inside the chart -- otherwise the read refuses an entry older than its window.
 */
export function exitReadFor(s: PriceSeries, day: string, entryDate: string, entryPrice: number, o: EngineRunOptions = {}): ExitReadResult {
  const to = lastIndexOnOrBefore(s, day);
  const entryIdx = lastIndexOnOrBefore(s, entryDate);
  const base = { ticker: s.ticker, day, actionClass: null, recommendation: null, stopBreached: false, thesisInvalidated: false, hitT1: false, hitT2: false, t1: null, t2: null, stopLevel: null, close: to >= 0 ? (s.closes[to] as number) : null };
  if (to < 0) return { ...base, ok: false, error: 'no bars' };
  const from = Math.max(0, Math.min(to - (o.chartBars ?? TWO_YEAR_BARS) + 1, entryIdx - 20));
  const chart = chartFromBars(s, from, to);
  if (!chart) return { ...base, ok: false, error: 'no chart' };
  const r = (o.nearestTargets || o.fixedT2
    ? computePositionExitRead(s.ticker, entryPrice, entryDate, chart, { ...(o.nearestTargets ? { nearestTargets: true } : {}), ...(o.fixedT2 ? { fixedT2: true } : {}) })
    : computePositionExitRead(s.ticker, entryPrice, entryDate, chart)) as any;
  if (r.error) return { ...base, ok: false, error: String(r.error) };
  const cls = classifyStockAction(r, true);
  return {
    ticker: s.ticker, day, ok: true, actionClass: cls.actionClass, recommendation: r.recommendation,
    stopBreached: !!r.stopBreached, thesisInvalidated: !!r.thesisInvalidated, hitT1: !!r.hitT1, hitT2: !!r.hitT2,
    t1: num(r.t1), t2: num(r.t2), stopLevel: num(r.chandelierSinceEntry), close: num(r.cp),
  };
}
