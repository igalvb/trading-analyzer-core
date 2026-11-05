/**
 * Owner decision 2026-11-01: Analyze (one stock, analyze.yml / Telegram /analyze) asks Claude Opus for a second
 * opinion after Gemini, the same way AI Dispatch does for Buy / Exit (aiDispatch.ts Opus leg): REVIEW of Gemini's text
 * when Gemini answered, STANDALONE otherwise; the same reviewWithClaude (claudeReview.ts) and model, under runStep.
 *
 * Never fails the run (the leg runs under runStep, which never throws). A missing key makes no call and gives one plain line (ANALYZE_OPUS_NO_KEY).
 * The result is display only: it is shown beside Gemini's review on the Analysis page (so in the PDF and the Sheet)
 * and as one line in the Telegram message. No score, conviction or decision reads it.
 */

import type { RunContext } from '../core/context.ts';
import { runStep } from '../core/runStep.ts';
import { reportSentence } from '../core/result.ts';
import { EFFECTS, labelledReason } from '../reports/messages/catalog.ts';
import type { FormatExpiry, GeminiReviewInputs, GetMacroRegime } from '../fetch/ai/geminiReview.ts';
import { reviewWithClaude, type ClaudeEffort, type ClaudeRetryPolicy, type ClaudeSdk, type GeminiOutcome } from './claudeReview.ts';
import { renderLines, type OpusLeg } from './aiDispatch.ts';

export const ANALYZE_OPUS_NO_KEY = 'Opus second opinion: off (no Anthropic key saved)';
export const ANALYZE_OPUS_FAILED = 'Opus second opinion: not available this time (every number is unaffected)';
export const ANALYZE_OPUS_AI_OFF = 'Opus second opinion: off (the AI review was turned off for this run)';
/** The AI Dispatch default effort (schedule.ts AI_INPUTS). */
export const ANALYZE_OPUS_EFFORT: ClaudeEffort = 'medium';

export interface AnalyzeOpusDeps {
  readonly ctx: RunContext;
  readonly apiKey: string;
  readonly sdk: ClaudeSdk;
  readonly getMacroRegime: GetMacroRegime;
  readonly formatExpiry?: FormatExpiry;
  readonly plainLabels?: boolean;
  readonly effort?: ClaudeEffort;
  readonly model?: string;
  readonly retry?: Partial<ClaudeRetryPolicy>;
  readonly stepTimeoutMs?: number;
}

export interface AnalyzeOpusResult {
  readonly state: 'ok' | 'off' | 'failed';
  /** For the Analysis page, under Gemini's review: the header, the disclosure line and Opus's text, or one plain line. */
  readonly lines: readonly string[];
  /** One line for the Telegram message and the run log. */
  readonly summary: string;
}

/** Opus's VERDICT line (REVIEW mode: AGREE / AGREE WITH CAVEATS / DISAGREE), when it wrote one. */
export function opusVerdict(body: string): string | null {
  const m = /VERDICT\s*\n+\s*(?:-\s*)?(AGREE WITH CAVEATS|AGREE|DISAGREE)\b/i.exec(body);
  return m ? (m[1] as string).toUpperCase() : null;
}

export function offResult(line: string): AnalyzeOpusResult {
  return { state: 'off', lines: [line], summary: line };
}

export async function analyzeOpusReview(deps: AnalyzeOpusDeps, inputs: GeminiReviewInputs, geminiText: string | null): Promise<AnalyzeOpusResult> {
  if (!deps.apiKey) {
    deps.ctx.log.info(ANALYZE_OPUS_NO_KEY);
    return offResult(ANALYZE_OPUS_NO_KEY);
  }
  const T = inputs.ticker;
  const ctx = deps.ctx.forTicker(T);
  const label = 'Claude Opus review for ' + T;
  const failLine = labelledReason(label, 'AI_REVIEW_UNAVAILABLE') + ' ' + EFFECTS.SCORE_UNCHANGED;
  const outcome: GeminiOutcome = geminiText && geminiText.trim() ? { status: 'ok', text: geminiText } : { status: 'unavailable' };
  // runStep never throws: a thrown leg comes back as { ok: false } (technical detail in the log only).
  const r = await runStep(ctx, {
    key: 'ai.opus.' + T, label, retry: 'never', maxAttempts: 1, timeoutMs: deps.stepTimeoutMs ?? 420_000,
    onFailure: reportSentence(failLine),
  }, async () => {
    const res = await reviewWithClaude({
      apiKey: deps.apiKey, sdk: deps.sdk, getMacroRegime: deps.getMacroRegime, formatExpiry: deps.formatExpiry, plainLabels: deps.plainLabels,
      log: (lvl, m) => (lvl === 'info' ? ctx.log.info(m) : lvl === 'warn' ? ctx.log.warning(m) : ctx.log.error(m)),
      sleep: ctx.sleep, random: ctx.random,
    }, inputs, outcome, { effort: deps.effort ?? ANALYZE_OPUS_EFFORT, frame: 'buy', model: deps.model, retry: deps.retry });
    if (!res.ok) throw new Error('Opus ' + res.reason + ' (' + res.mode + ') ' + String(res.detail));
    return res;
  });
  if (!r.ok) return { state: 'failed', lines: [failLine], summary: ANALYZE_OPUS_FAILED };
  const v = r.value;
  const leg: OpusLeg = { state: 'ok', mode: v.mode, disclosureLine: v.disclosureLine, body: v.body, truncated: v.truncated, model: v.model, usage: v.usage };
  const verdict = v.mode === 'REVIEW' ? opusVerdict(v.body) : null;
  const summary = v.mode === 'REVIEW'
    ? 'Opus second opinion: ' + (verdict ? verdict + ' with Gemini' : 'reviewed Gemini') + ' (details on the Analysis page)'
    : 'Opus second opinion: its own analysis, Gemini was unavailable (details on the Analysis page)';
  return { state: 'ok', lines: renderLines({ state: 'off' }, leg), summary };
}
