/**
 * The small helpers of the dashboard writer (FL-7e), from fullStockAnalysisV10_9.gs:
 *   hdrV7 :3438-3440, colorVerdictRow9V7_ :5022-5028, buildNarrativeV7_ :5030-5121,
 *   buildDataStatusBannerV7 :5130-5159, renderAiReviewV7_ :8878-8895,
 *   gapMarketCapContextV7 :8674-8682, scoreBar :8988
 *
 * Dedupe (clusters 2-5): renderAiReview and scoreBar live in reports/bottomLine/helpers.ts;
 * buildDataStatusBanner and colorVerdictRow9 in reports/text/textReports.ts; buildNarrative in
 * reports/text/narrative.ts (each oracle-tested there). This file keeps only what is the dashboard's
 * own (hdr -- its call order differs from the options tabs' hdr, cluster 19 -- and the gap read) and
 * thin adapters with the dashboard's call shapes.
 *
 * classifyGapCauseV7 (:8455-8473) is the existing, oracle-tested classifyEarningsGapV1
 * (analysis/models/brokerCourse/gaps.ts); the dashboard calls it as classifyGapCause.
 */

import { classifyEarningsGapV1 } from '../../analysis/models/brokerCourse/gaps.ts';
import type { DashSheet } from './sheetAdapter.ts';
import type { ReportTextOptions } from '../messages/reportText.ts';
import { renderAiReview as renderAiReviewShared, scoreBar as scoreBarShared } from '../bottomLine/helpers.ts';
import { buildDataStatusBanner as buildDataStatusBannerShared, colorVerdictRow9 as colorVerdictRow9Shared } from '../text/textReports.ts';
import { buildNarrative as buildNarrativeShared } from '../text/narrative.ts';

/** hdrV7 (:3438-3440). */
export function hdr(sh: DashSheet, row: number, text: string, color: string, fontSize?: number, colSpan?: number): void {
  sh.getRange(row, 1, 1, colSpan || 14).merge().setValue(text).setBackground(color).setFontColor('#fff').setFontSize(fontSize || 11).setFontWeight('bold');
}

/** scoreBar (:8988): ten blocks, filled in proportion to a 0-100 score. */
export function scoreBar(score: number): string {
  return scoreBarShared(score);
}

/** colorVerdictRow9V7_ (:5022-5028): the FINAL CONVICTION row's colours, on the dashboard's sheet. */
export function colorVerdictRow9(sh: DashSheet, row: number, conviction: number): void {
  colorVerdictRow9Shared(sh.sheet, row, conviction);
}

/** classifyGapCauseV7 (:8455-8473): same function, tested equal to the oracle. */
export const classifyGapCause = classifyEarningsGapV1;

/** gapMarketCapContextV7 (:8674-8682). */
export function gapMarketCapContext(gap: any, marketCap: any): { tier: string; note: string } | null {
  if (!marketCap) return null;
  const MEGA_CAP_SIGNIFICANT_GAP_PCT = 0.03;
  const tier = marketCap >= 200e9 ? 'Mega' : marketCap >= 10e9 ? 'Large' : marketCap >= 2e9 ? 'Mid' : marketCap >= 300e6 ? 'Small' : 'Micro';
  const note = tier === 'Mega'
    ? (Math.abs(gap.sizePct) >= MEGA_CAP_SIGNIFICANT_GAP_PCT ? tier + '-cap, ≥ 3% — significant' : tier + '-cap, < 3% — likely not significant')
    : tier + '-cap';
  return { tier, note };
}

export interface StyledRow { text: [string]; meta: { merge?: boolean; bold?: boolean; italic?: boolean; wrap?: boolean; bg?: string; color?: string; size?: number } }

/** renderAiReviewV7_ (:8878-8895): the AI text as styled rows (headers, bullets, plain). */
export function renderAiReview(text: unknown): StyledRow[] {
  return renderAiReviewShared(text) as unknown as StyledRow[];
}

/** buildDataStatusBannerV7 (:5130-5159). */
export function buildDataStatusBanner(status: any, opts?: ReportTextOptions): StyledRow[] {
  return buildDataStatusBannerShared(status, opts) as unknown as StyledRow[];
}

/** buildNarrativeV7_ (:5030-5121): the seven plain-English paragraphs. */
export function buildNarrative(ticker: string, chart: any, ind: any, gann: any, confluence: any, scores: any, fund: any, opts: any, techPlan: any, decision: any, fundResult: any, textOpts?: { readonly plainLabels?: boolean }): Array<{ heading: string; body: string }> {
  return buildNarrativeShared(ticker, chart, ind, gann, confluence, scores, fund, opts, techPlan, decision, fundResult, textOpts);
}
