/**
 * FL-9m (F5): pure adapters from the AI dispatch result (AiBatchResult) to the two sheet inputs
 * (AiSummariesInput for the Exit tab, BuyAiSummariesInput for the Buy tab).
 *
 *  - Opus ok: the MANDATORY disclosure line comes first, then a blank line, then the body; a truncated answer is
 *    kept and marked with OPUS_TRUNCATED_NOTE.
 *  - A failed provider leg becomes its catalog sentence (leg.line); anything that looks like a leak is replaced by
 *    the fixed AI_REVIEW_UNAVAILABLE sentence. Raw errors, codes and URLs never get here (they live in the log).
 *  - The technical 'AI SUMMARY (GEMINI)' / 'CLAUDE OPUS REVIEW' header lines of AiTickerResult.lines are NOT used:
 *    the sheets draw their own headings.
 *  - opusMode comes from the switches: opus off = OFF, opus on and gemini on = REVIEW, opus on and gemini off = STANDALONE.
 */
import { labelledReason } from '../reports/messages/catalog.ts';
import { findReportLeaks } from '../reports/messages/leakScan.ts';
import type { AiSummariesInput } from '../reports/exitSheet/types.ts';
import type { BuyAiSummariesInput, BuyTier } from '../reports/buySheet/types.ts';
import { OPUS_TRUNCATED_NOTE } from './aiDispatch.ts';
import type { AiBatchResult, AiSideSwitches, AiTickerResult } from './aiDispatch.ts';

export interface AiSheetOptions {
  readonly ranAt: Date;
  /** The same switches that were given to runAiBatch. */
  readonly switches: AiSideSwitches;
  readonly effort?: string | null;
}

export interface AiSheetEntry {
  readonly ticker: string;
  readonly gemini: string | null;
  readonly opus: string | null;
}

function safeLine(line: string, label: string): string {
  return findReportLeaks(line).length > 0 ? labelledReason(label, 'AI_REVIEW_UNAVAILABLE') : line;
}

export function geminiNarrative(r: AiTickerResult): string | null {
  const g = r.gemini;
  if (g.state === 'ok') return g.text.trim() === '' ? null : g.text;
  if (g.state === 'failed') return safeLine(g.line, 'Gemini summary for ' + r.ticker);
  return null;
}

export function opusNarrative(r: AiTickerResult): string | null {
  const o = r.opus;
  if (o.state === 'ok') {
    const parts = [o.disclosureLine, '', o.body];
    if (o.truncated) parts.push('', OPUS_TRUNCATED_NOTE);
    return parts.join('\n');
  }
  if (o.state === 'failed') return safeLine(o.line, 'Claude Opus review for ' + r.ticker);
  return o.note ?? null;
}

export function aiEntriesOf(batch: AiBatchResult): AiSheetEntry[] {
  return batch.results.map((r) => ({ ticker: r.ticker, gemini: geminiNarrative(r), opus: opusNarrative(r) }));
}

function header(o: AiSheetOptions) {
  const opusMode = !o.switches.opus ? ('OFF' as const) : o.switches.gemini ? ('REVIEW' as const) : ('STANDALONE' as const);
  return {
    ranAt: o.ranAt,
    geminiUsed: o.switches.gemini,
    opusMode,
    ...(opusMode === 'STANDALONE' ? { standaloneWhy: 'NOT_RUN' as const } : {}),
    effort: o.effort ?? null,
  };
}

export function toExitAiInput(batch: AiBatchResult, o: AiSheetOptions): AiSummariesInput {
  return { ...header(o), entries: aiEntriesOf(batch) };
}

export function toBuyAiInput(
  batch: AiBatchResult,
  o: AiSheetOptions & { readonly candidates: ReadonlyArray<{ readonly ticker: string; readonly tier: BuyTier }> },
): BuyAiSummariesInput {
  return { ...header(o), entries: aiEntriesOf(batch), candidates: o.candidates };
}
