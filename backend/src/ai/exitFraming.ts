/**
 * Exit/Buy framing for the AI layer -- NEW (no legacy counterpart for the
 * Exit side; the Buy side is the legacy prompt, unchanged).
 * Plan: CHARACTERIZATION_PLAN_V13_dual_ai_gemini_opus s1.2 and s2.1.
 * Legacy buy prompt: dataLayerV1.gs:195-231 (ported in fetch/ai/geminiReview.ts).
 *
 * Buy and Exit need genuinely different prompts, not one prompt with a
 * swapped noun. Both reuse GEMINI_PROMPT_RULES by import so the earned
 * defensive constraints (OWN/TIMING separation, "use ONLY the numbers
 * provided", canonicalRevenueGrowthPct) are never re-typed or tidied away.
 *
 * Long-only: the Exit prompt forbids recommending a purchase and forbids
 * suggesting shorts, puts or sold options.
 */

import { EXIT_TAX_PCT } from '../portfolio/exitTax.ts';
import { GEMINI_PROMPT_RULES, buildGeminiPrompt, type GeminiReport } from '../fetch/ai/geminiReview.ts';

export type AiFrame = 'buy' | 'exit';

/** The investor's own position, already distilled. The AI layer never computes these. */
export interface ExitPositionFacts {
  readonly entryPrice: number | null;
  readonly currentPrice: number | null;
  readonly unrealizedPct: number | null;
  readonly trailingStop: number | null;
  readonly afterTaxPct: number | null;
  /** The flat baseline tax rate used for afterTaxPct (a baseline, not advice). */
  readonly taxRatePct: number | null;
  /** True for spot Bitcoin ETFs that share one thesis with other holdings. */
  readonly bitcoinEtfSharedThesis?: boolean;
  /** Row 36: set only when the stop is measured from the assumed purchase date (a plain sentence, shown as is). */
  readonly trailingStopBasis?: string;
}

const r2 = (v: number | null | undefined): number | null => (v == null || !isFinite(v) ? null : Number(v.toFixed(2)));

/**
 * Buy: the report as-is (parity with legacy). Exit: the same distilled report
 * plus a `position` block. Throws if Exit has no facts (callers treat that as
 * a per-ticker prompt-build failure).
 */
export function framedReport(frame: AiFrame, report: GeminiReport, facts?: ExitPositionFacts): GeminiReport {
  if (frame === 'buy') return report;
  if (!facts) throw new Error('exit frame needs position facts');
  return {
    ...report,
    position: {
      entryPrice: r2(facts.entryPrice), currentPrice: r2(facts.currentPrice), unrealizedPct: r2(facts.unrealizedPct),
      trailingStop: r2(facts.trailingStop), afterTaxPct: r2(facts.afterTaxPct), taxRatePct: r2(facts.taxRatePct),

      bitcoinEtfSharedThesis: facts.bitcoinEtfSharedThesis === true,
      ...(facts.trailingStopBasis ? { trailingStopBasis: facts.trailingStopBasis } : {}),
    },
  };
}

/** Shared by every Exit prompt (Gemini and both Opus modes). */
export const EXIT_FRAMING =
  'This investor ALREADY HOLDS this stock (long only: they never short, never sell options and never buy puts). ' +
  'The question is what to do with the existing position: hold, trim, or exit. You MUST NOT recommend buying more or opening a new position, ' +
  'and you must not suggest shorting, put options or selling options. ' +
  'The report\'s "position" block holds the investor\'s own entry price, current price, unrealized gain, trailing stop and after-tax figure. ' +
  'The technical entry price, entry zone and entry ETA in the report describe a NEW purchase, not this investor\'s position — never present them as the investor\'s entry. ' +
  'Read the BUY-TIMING score only as the technical health of the trend, never as an invitation to buy. ' +
  'The after-tax figure uses a flat baseline tax rate (position.taxRatePct): say plainly that it is a baseline, not tax advice. ' +
  'If position.bitcoinEtfSharedThesis is true, say that this is a spot Bitcoin ETF that shares one underlying thesis with the investor\'s other Bitcoin ETF holdings, so they are not independent positions. ';

/** Section list for the Exit briefing (plan s2.1 table). */
export const EXIT_FORMAT =
  'AUDIENCE: a NON-EXPERT investor. Write a clear, pedagogical briefing (≤320 words). Explain any jargon in a few words the first time you use it. ' +
  'FORMAT RULES (important): do NOT use any Markdown symbols — no asterisks, no "#", no backticks, no bold markup. ' +
  'Use these EXACT section headers, each on its own line in UPPERCASE, followed by 1–3 short sentences or lines that start with "- ":\n\n' +
  'AT A GLANCE\n' +
  '- one plain sentence: is this still a company worth owning, and is the action hold, trim or exit.\n\n' +
  'WHAT\'S CHANGED SINCE ENTRY\n' +
  '- compare position.entryPrice with position.currentPrice and position.unrealizedPct, and say whether the trend and the scores have improved or weakened.\n\n' +
  'THE EXIT CASE\n' +
  '- the reasons to sell or trim, using position.trailingStop and the technical read; and the reasons to keep holding. Give both sides honestly.\n\n' +
  'THE COMPANY (STILL WORTH OWNING?)\n' +
  '- reference the OWN score/verdict and the 2–3 biggest positive and negative drivers in plain words. If balance-sheet fields (debtToEquity/currentRatio/fcfPerShare) are present, add a one-line financial-health read. If insiderActivity is present, mention it briefly as a supporting signal.\n\n' +
  'TAX\n' +
  '- the after-tax figure: tax is assumed at ' + EXIT_TAX_PCT + ' of the gain and none on a loss; say it is a working assumption, not tax advice.\n\n' +
  'REAL-WORLD EXPOSURE (STRUCTURAL, NOT A NEW SCORE)\n' +
  '- Using what you know about this specific company (not the report data), name ONE real, concrete exposure that could matter (a key input cost, a supply-chain dependency, or 2-3 real named competitors). Keep it to 2-3 sentences, labeled as general reasoning. Skip this section entirely rather than force a generic statement.\n\n' +
  'KEY NUMBERS\n' +
  '- a compact list, one per line as "Label: value", covering Entry price, Current price, Unrealized gain, Trailing stop, After-tax figure, OWN score, Final Conviction.\n\n' +
  'BOTTOM LINE\n' +
  '- the decision action, the Final Conviction, and one plain sentence on what a non-expert should do with this position (hold, trim or exit).\n\n';

export function buildGeminiBuyPrompt(ticker: string, report: GeminiReport): string {
  return buildGeminiPrompt(ticker, report);
}

export function buildGeminiExitPrompt(ticker: string, report: GeminiReport): string {
  return 'You are a professional equity analyst reviewing an automated v7 report for ' + ticker + ', a stock the investor already owns. ' +
    EXIT_FRAMING + GEMINI_PROMPT_RULES + EXIT_FORMAT + 'REPORT (JSON):\n' + JSON.stringify(report);
}

export function buildGeminiPromptFor(frame: AiFrame, ticker: string, report: GeminiReport): string {
  return frame === 'exit' ? buildGeminiExitPrompt(ticker, report) : buildGeminiBuyPrompt(ticker, report);
}
