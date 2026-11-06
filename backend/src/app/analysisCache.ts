/**
 * F3: ONE full analysis per ticker per run. The nightly ticker phase, the Buy
 * pipeline, the Exit pipeline and the AI run all read the same memoised
 * runTickerAnalysisDetailed artifacts; what each of them needs is a
 * projection of it. Nothing is re-scored or re-decided here.
 */

import type { TickerArtifacts } from '../analysis/runTicker.ts';
import type { DailyAnalysisResult } from '../jobs/automation/dailyAutomation.ts';
import type { BuyAnalysis } from '../jobs/buy/buyPipeline.ts';
import type { ExitAnalysisBundle } from '../jobs/exit/exitPipeline.ts';
import type { GeminiReviewInputs } from '../fetch/ai/geminiReview.ts';

export interface AnalysisCache {
  /** The artifacts (computed once; a rejected run is remembered too). */
  get(ticker: string): Promise<TickerArtifacts>;
  /** The legacy-shaped result for the nightly phase (null when the run aborted). */
  daily(ticker: string): Promise<DailyAnalysisResult | null>;
  /** The Buy pipeline's input. Throws when the run aborted, so the pipeline lists the ticker as failed. */
  buy(ticker: string): Promise<BuyAnalysis>;
  /** The Exit pipeline's bundle (null when the run aborted). */
  exit(ticker: string): Promise<ExitAnalysisBundle | null>;
  /** The AI review inputs (null when the run aborted). */
  gemini(ticker: string): Promise<GeminiReviewInputs | null>;
  /** Tickers analysed so far. */
  readonly size: number;
  /** Drops a ticker's memo, so the next get() runs it again (a timed-out attempt, F-N8). */
  forget(ticker: string): void;
}

export function createAnalysisCache(run: (ticker: string) => Promise<TickerArtifacts>): AnalysisCache {
  const memo = new Map<string, Promise<TickerArtifacts>>();
  const get = (t: string): Promise<TickerArtifacts> => {
    const key = String(t).toUpperCase().trim();
    let p = memo.get(key);
    if (!p) { p = run(key); memo.set(key, p); }
    return p;
  };
  return {
    get,
    async daily(t) { const a = await get(t); return (a.result as unknown as DailyAnalysisResult | undefined) ?? null; },
    async buy(t) {
      const a = await get(t);
      if (!a.result) throw new Error('analysis for ' + a.ticker + ' did not complete: ' + (a.aborted ?? 'no result'));
      return toBuyAnalysis(a);
    },
    async exit(t) { const a = await get(t); return a.result ? toExitBundle(a) : null; },
    async gemini(t) { const a = await get(t); return a.result ? toGeminiInputs(a) : null; },
    get size() { return memo.size; },
    forget(t) { memo.delete(String(t).toUpperCase().trim()); },
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function toBuyAnalysis(a: TickerArtifacts): BuyAnalysis {
  const r = a.result!;
  const conf = a.confluence;
  const sizing = (a.reports.turtle as { sizing?: BuyAnalysis['sizing'] } | null | undefined)?.sizing ?? null;
  return {
    fundResult: r.fundResult as never,
    techPlan: r.techPlan as never,
    decision: r.decision as never,
    confluence: conf ? { entryCount: conf.entryCount, entryLow: conf.entryLow, entryHigh: conf.entryHigh } : null,
    sizing,
    comparison: a.reports.comparison ?? null,
    ...(a.reports.extraModels ? { extraModels: a.reports.extraModels } : {}),
    options: (a.leapsCall || a.shortTermCall) ? { leapsCall: a.leapsCall ?? null, shortTermCall: a.shortTermCall ?? null } : null,
    dataQuality: a.dataQuality,
    ...(a.optionsHistory ? { optionsHistory: a.optionsHistory } : {}),
  };
}

/** The Exit adapter's `positioning` fields (exitReportAdapter.ts positioningOf), all percentages as 0-100. */
export function positioningOf(a: TickerArtifacts): { institutionalHolders: number | null; darkPoolPct: number | null; shortInterestPct: number | null } {
  const broker = a.reports.broker as { institutional13F?: Record<string, { latest?: { holdings?: unknown } | null }> | null; news?: { shortPctOfFloat?: unknown } } | null | undefined;
  // 13F holdings are stored as { issuer, shares, value } (fetch/sec/thirteenF.ts); a plain number is accepted too.
  // Before 2026-11-04 only a plain number was read, so every filer counted as 0 and the Exit report showed 0 holders.
  const sharesOf = (h: unknown): number | null => (h != null && typeof h === 'object' ? num((h as { shares?: unknown }).shares) : num(h));
  const filers = broker && broker.institutional13F ? Object.values(broker.institutional13F).filter((q) => q && q.latest && (sharesOf((q.latest as { holdings?: unknown }).holdings) ?? 0) > 0).length : null;
  const dp = num((a.ind as { darkPoolShare?: { darkPoolSharePct?: unknown } } | undefined)?.darkPoolShare?.darkPoolSharePct);
  const si = num(broker?.news?.shortPctOfFloat);
  return { institutionalHolders: filers, darkPoolPct: dp == null ? null : dp * 100, shortInterestPct: si == null ? null : si * 100 };
}

/** Row 35 (#37): the book models count signals (synthesis bullish / cautionary); the counts, keyed by the sheet's model id. */
export function modelSignalsOf(a: TickerArtifacts): Record<string, { pro: number; con: number }> {
  const out: Record<string, { pro: number; con: number }> = {};
  const from: ReadonlyArray<[string, unknown]> = [['BROKER_COURSE', a.reports.broker], ['SCHABACKER', a.reports.schabacker], ['EDWARDS_MAGEE', a.reports.edwardsMagee], ['TURTLE', a.reports.turtle]];
  for (const [id, rep] of from) {
    const syn = (rep as { synthesis?: { bullish?: unknown; cautionary?: unknown } } | null | undefined)?.synthesis;
    if (syn && Array.isArray(syn.bullish) && Array.isArray(syn.cautionary)) out[id] = { pro: syn.bullish.length, con: syn.cautionary.length };
  }
  return out;
}

export function toExitBundle(a: TickerArtifacts): ExitAnalysisBundle {
  const r = a.result!;
  const signals = modelSignalsOf(a);
  return {
    fundResult: r.fundResult, techPlan: r.techPlan, decision: r.decision, comparison: a.reports.comparison ?? null, positioning: positioningOf(a),
    ...(a.reports.extraModels ? { extraModels: a.reports.extraModels } : {}),
    ...(Object.keys(signals).length ? { modelSignals: signals } : {}),
  };
}

/** The same object runTicker hands Gemini (GeminiArgs), for the manual AI run. */
export function toGeminiInputs(a: TickerArtifacts): GeminiReviewInputs {
  const r = a.result!;
  return {
    ticker: a.ticker, fundResult: r.fundResult, techPlan: r.techPlan, decision: r.decision, ind: a.ind, gann: a.gann, confluence: a.confluence,
    fund: a.fund ?? null, chart: a.chart, optAnalysis: a.optAnalysis ?? null, leapsCall: a.leapsCall as never, shortTermCall: a.shortTermCall as never,
    ...(a.atBuyLimit ? { atBuyLimit: a.atBuyLimit.text } : {}),
    ...(a.nextResistance ? { nextResistance: a.nextResistance.text } : {}),
    ...(a.fixedT2 ? { fixedT2: a.fixedT2.text } : {}),
  } as unknown as GeminiReviewInputs;
}
