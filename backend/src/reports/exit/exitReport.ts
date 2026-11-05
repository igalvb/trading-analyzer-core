/**
 * FL-7f: the Exit Strategy report's shared pieces, ported from fullStockAnalysisV10_9.gs:
 *   computePortfolioBullPhaseAdvisoryV1_ :859-906, EXIT_STRATEGY_PURCHASE_DATE_COLUMN_V1 :10138,
 *   formatTargetsV1_ :10157-10161, formatStockSignalsV1_ :10163-10182, formatOptionsSignalsV1_ :10197-10223
 * (the trigger installer :10515-10524 is DATA, see schedule.ts).
 *
 * The writer of the old '📤 Exit Strategy' tab (buildExitStrategyReportV7 :10242-10500 and its menu wrapper
 * :10502-10504) was ported and then removed: owner 2026-11-04 (backlog row 39), the tab is unused. The Exit
 * report (jobs/exit -> reports/exitSheet, the '📤 Exit Report' tab) uses the formatters, the urgency order,
 * the colours and the advisory below. EXIT_STRATEGY_TAB stays for routing and `cleanup-report-tabs --legacy-tabs`.
 */
import type { Chart } from '../../types/chart.ts';
import { EXIT_GENERIC_LOOKBACK_TRADING_DAYS } from '../../analysis/exitRead.ts';
import { computeIndicators } from '../../analysis/indicators/index.ts';
import { computeCompositeLeverage, computeNNormalizedPositionSize } from '../../analysis/techPlan/additive.ts';
import { turtleCorrelatedCaps, type CorrelatedCaps } from '../../analysis/models/turtle.ts';
import { exitSummaryError, type ReportTextOptions } from '../messages/reportText.ts';
import { PURCHASE_DATE_COLUMN } from '../../sheets/readers/portfolio.ts';
export const EXIT_STRATEGY_TAB = '📤 Exit Strategy';
/** The portfolio's purchase-date header, from the profile (sheets.portfolio.headerAliases; GENERIC_PLAN P3). */
export const EXIT_STRATEGY_PURCHASE_DATE_COLUMN: string = PURCHASE_DATE_COLUMN;
export const DIVERSIFICATION_CEILING = 10;
export const PHASE_BOTTOM_MAX_PCT_STRONG = 9;
export const PHASE_TOP_MIN_PCT_STRONG = 90;
export interface StockReadLike { readonly error?: string | null; readonly thesisInvalidated?: boolean; readonly stopBreached?: boolean; readonly chandelierSinceEntry?: number | null; readonly chandelierGeneric?: number | null; readonly t1?: number | null; readonly hitT1?: boolean; readonly t2?: number | null; readonly hitT2?: boolean; readonly entryDateStr?: string; readonly lookbackTradingDays?: number; readonly distanceToT1Pct?: number | null; readonly distanceToT2Pct?: number | null }
export interface OptionsReadLike { readonly error?: string | null; readonly technical?: StockReadLike | null; readonly expiryThreshold?: number; readonly daysToExpiry?: number; readonly expiryWarning?: boolean }
export interface StockSignals { thesis: string; stop: string; targets: string; confidence: string; summary: string; expiry?: string }
export interface OptionsSignals { thesis: string; stop: string; targets: string; expiry: string; confidence: string; summary: string }
export type ExitSignals = StockSignals | OptionsSignals;
const awayShort = (d: number | null | undefined): string => (d == null || d <= 0 ? '' : ' (' + d.toFixed(1) + '% away)');
export function formatTargets(t1: number | null | undefined, hitT1: boolean | undefined, t2: number | null | undefined, hitT2: boolean | undefined, d1?: number | null, d2?: number | null): string {
  const t1Str = t1 != null ? '$' + t1.toFixed(2) + (hitT1 ? ' ✓reached' : awayShort(d1)) : 'N/A';
  const t2Str = t2 != null ? '$' + t2.toFixed(2) + (hitT2 ? ' ✓reached' : awayShort(d2)) : 'N/A';
  return 'T1 ' + t1Str + '  |  T2 ' + t2Str;
}
export function formatStockSignals(r: StockReadLike, hasRealDate: boolean, opts?: ReportTextOptions): StockSignals {
  if (r.error) return { thesis: 'N/A', stop: 'N/A', targets: 'N/A', confidence: 'N/A', summary: exitSummaryError('ERROR: ' + r.error, 'SECTION_UNAVAILABLE', opts) };
  const thesis = r.thesisInvalidated ? 'AVOID' : 'OK';
  const stopLevel = (r.chandelierSinceEntry != null) ? r.chandelierSinceEntry : r.chandelierGeneric;
  const stop = r.stopBreached ? ('BREACHED ($' + (stopLevel as number).toFixed(2) + ')') : 'OK';
  const targets = formatTargets(r.t1, r.hitT1, r.t2, r.hitT2, r.distanceToT1Pct, r.distanceToT2Pct);
  const confidence = hasRealDate
    ? ('REAL (since entry' + (r.entryDateStr ? ' ' + r.entryDateStr : '') + ')')
    : ('GENERIC (' + (r.lookbackTradingDays || EXIT_GENERIC_LOOKBACK_TRADING_DAYS) + 'd lookback, no entry date)');
  let summary: string;
  if (thesis === 'AVOID') summary = 'EXIT — thesis broken (high confidence, full history)';
  else if (r.stopBreached && hasRealDate) summary = 'EXIT — stop hit (high confidence, since real entry)';
  else if (r.stopBreached && !hasRealDate) summary = 'REVIEW — possible stop hit, LOW CONFIDENCE (generic lookback, add entry date to confirm)';
  else if (r.hitT2) summary = 'CONSIDER TRIMMING/PARTIAL — T2 reached';
  else if (r.hitT1) summary = 'CONSIDER TRIMMING/PARTIAL — T1 reached';
  else summary = 'HOLD';
  return { thesis, stop, targets, confidence, summary };
}
export function formatOptionsSignals(r: OptionsReadLike, hasRealDate: boolean, contracts?: number | null, opts?: ReportTextOptions): OptionsSignals {
  if (r.error) return { thesis: 'N/A', stop: 'N/A', targets: 'N/A', expiry: 'N/A', confidence: 'N/A', summary: exitSummaryError('ERROR: ' + r.error, 'SECTION_UNAVAILABLE', opts) };
  const t: StockReadLike = r.technical || {};
  const thesis = t.error ? 'N/A' : (t.thesisInvalidated ? 'AVOID' : 'OK');
  const stopLevel = t.error ? null : ((t.chandelierSinceEntry != null) ? t.chandelierSinceEntry : t.chandelierGeneric);
  const stop = t.error ? 'N/A' : (t.stopBreached ? ('BREACHED (underlying, $' + (stopLevel as number).toFixed(2) + ')') : 'OK');
  const targets = t.error ? 'N/A' : formatTargets(t.t1, t.hitT1, t.t2, t.hitT2, t.distanceToT1Pct, t.distanceToT2Pct);
  const confidence = hasRealDate ? 'REAL (since entry, real LEAPS-vs-short-term split)' : ('GENERIC (' + r.expiryThreshold + 'd floor, no entry date — no LEAPS split possible)');
  const expiry = r.daysToExpiry + 'd' + (r.expiryWarning ? (' — WARNING (≤ ' + r.expiryThreshold + 'd)') : '');
  const canTrim = typeof contracts === 'number' && contracts >= 2;
  let summary: string;
  if ((r.daysToExpiry as number) <= 0) summary = 'EXPIRED — check Portfolio sheet';
  else if (thesis === 'AVOID') summary = 'EXIT — thesis broken (underlying, high confidence)';
  else if (t.stopBreached && hasRealDate) summary = 'EXIT — stop hit (underlying, high confidence, since real entry)';
  else if (t.stopBreached && !hasRealDate) summary = 'REVIEW — possible stop hit (underlying), LOW CONFIDENCE (generic lookback)';
  else if (r.expiryWarning) summary = 'EXIT — expiry approaching (' + r.daysToExpiry + 'd)';
  else if (t.hitT2 || t.hitT1) {
    const label = t.hitT2 ? 'T2 reached' : 'T1 reached';
    summary = canTrim ? ('CONSIDER TRIMMING/PARTIAL — ' + label) : (label + ' — HOLD or EXIT (only 1 contract, no partial exit possible)');
  }
  else summary = 'HOLD';
  return { thesis, stop, targets, expiry, confidence, summary };
}
export interface MacroRead { readonly evaluativeIndex?: { readonly pctStrong?: number | null } | null; readonly dowTheory?: { readonly verdict?: string | null } | null }
export interface Holding { readonly ticker: string; readonly shares: number | null }
export interface AdvisoryDeps {
  readonly getMacroRegime?: () => Promise<MacroRead | null> | MacroRead | null;
  readonly getRelativeStrength?: (ticker: string) => Promise<{ readonly categories: string[] } | null> | { readonly categories: string[] } | null;
  readonly computeIndicators?: (chart: Chart) => { readonly atrRatio?: number | null; readonly turtleN?: number | null };
}
export interface BullPhaseAdvisory {
  distinctStockCount: number; diversificationFlag: boolean; phaseRead: 'NEAR_BOTTOM' | 'NEAR_TOP' | null; evaluativeIndexPctStrong: number | null; dowTheoryVerdict: string | null;
  holdings: Array<{ ticker: string; tier: string | null; note?: string }>;
  correlatedCaps?: CorrelatedCaps | null;
}
export async function computePortfolioBullPhaseAdvisory(
  stockHoldings: readonly Holding[] | null | undefined,
  getChart: (ticker: string) => Promise<Chart | null | undefined> | Chart | null | undefined,
  deps: AdvisoryDeps = {},
): Promise<BullPhaseAdvisory> {
  const out: BullPhaseAdvisory = { distinctStockCount: 0, diversificationFlag: false, phaseRead: null, evaluativeIndexPctStrong: null, dowTheoryVerdict: null, holdings: [] };
  try {
    const holdings = stockHoldings || [];
    const distinctTickers = Array.from(new Set(holdings.map((p) => p.ticker)));
    out.distinctStockCount = distinctTickers.length;
    out.diversificationFlag = distinctTickers.length > DIVERSIFICATION_CEILING;
    const macro = deps.getMacroRegime ? await deps.getMacroRegime() : null;
    const ei = macro && macro.evaluativeIndex;
    const dt = macro && macro.dowTheory;
    if (ei && ei.pctStrong != null) {
      out.evaluativeIndexPctStrong = ei.pctStrong;
      if (ei.pctStrong <= PHASE_BOTTOM_MAX_PCT_STRONG) out.phaseRead = 'NEAR_BOTTOM';
      else if (ei.pctStrong >= PHASE_TOP_MIN_PCT_STRONG) out.phaseRead = 'NEAR_TOP';
    }
    if (dt && dt.verdict) out.dowTheoryVerdict = dt.verdict;
    const indicators = deps.computeIndicators ?? ((c: Chart) => computeIndicators(c) as unknown as { atrRatio?: number | null; turtleN?: number | null });
    const correlatedCapsHoldings: Array<{ ticker: string; categories: string[]; units: number | null }> = [];
    for (const ticker of distinctTickers) {
      try {
        const chart = await getChart(ticker);
        if (!chart || !chart.closes || chart.closes.length < 20) { out.holdings.push({ ticker, tier: null, note: 'insufficient real price history' }); continue; }
        const ind = indicators({ closes: chart.closes, highs: chart.highs, lows: chart.lows, volumes: chart.volumes, dates: chart.dates, opens: chart.opens, splits: chart.splits || [], ipoDate: chart.ipoDate || chart.dates[0] } as unknown as Chart);
        const cl = computeCompositeLeverage(chart.closes[chart.closes.length - 1], ind.atrRatio as number);
        out.holdings.push({ ticker, tier: cl ? cl.tier : null });
        const currentPrice = chart.closes[chart.closes.length - 1];
        const rsr = deps.getRelativeStrength ? await deps.getRelativeStrength(ticker) : null;
        const unitCalc = ind.turtleN ? computeNNormalizedPositionSize(currentPrice, ind.turtleN) : null;
        const pos = holdings.find((p) => p.ticker === ticker);
        const units = (unitCalc && unitCalc.shares && pos && pos.shares) ? pos.shares / unitCalc.shares : null;
        correlatedCapsHoldings.push({ ticker, categories: rsr ? rsr.categories : [], units });
      } catch (e) { out.holdings.push({ ticker, tier: null, note: 'fetch/compute error' }); }
    }
    out.correlatedCaps = turtleCorrelatedCaps(correlatedCapsHoldings);
  } catch (e) { /* non-fatal, as in legacy */ }
  return out;
}
export function urgencyRank(summary: unknown): number {
  const s = String(summary || '');
  if (s.indexOf('EXIT') === 0 || s.indexOf('EXPIRED') === 0) return 0;
  if (s.indexOf('REVIEW') === 0) return 1;
  if (s.indexOf('CONSIDER') === 0) return 2;
  if (s.indexOf('T1') === 0 || s.indexOf('T2') === 0) return 2;
  if (s.indexOf('HOLD') === 0) return 3;
  return 4;
}
export function summaryBackground(summary: string): string {
  return summary.indexOf('ERROR') === 0 ? '#eceff1'
    : summary.indexOf('EXIT') === 0 || summary.indexOf('EXPIRED') === 0 ? '#ffcdd2'
    : summary.indexOf('REVIEW') === 0 ? '#ffe0b2'
    : summary.indexOf('CONSIDER') === 0 ? '#fff9c4'
    : '#c8e6c9';
}
export const PHASE_LABELS: Readonly<Record<string, string>> = {
  NEAR_BOTTOM: "near a real historical BOTTOM-zone read (book's own Ch38 anchor, ~5-9% Strong) — Ch41's own guidance: favor higher-grade/conservative names early in a new Bull phase",
  NEAR_TOP: "near a real historical TOP-zone read (book's own Ch38 anchor, ~90%+ Strong) — Ch41's own guidance: speculative/lower-grade names may be near their own late-cycle peak",
};
