/**
 * Plan item #47 (docs/CHARACTERIZATION_PLAN_exit_strategy_deep_report.md s3, "the portfolio-level Opus synthesis";
 * owner decision 2026-11-04: KEEP, build it). One extra Claude Opus call in the AI run (ai-dispatch.yml) when the
 * Exit report's Opus box (exit_opus) is ticked: it reads the whole Exit report as the nightly wrote it (every stock and
 * option, the summary, the Bitcoin shared-thesis block, the portfolio-wide checks) and writes a short portfolio-level
 * view: concentration, correlated bets (e.g. the Bitcoin names, a stock and an option on the same name), the biggest
 * risks, what to trim first.
 *
 * Display only: it is shown at the top of the Exit report's AI SUMMARIES section (its one-line headline also in the
 * report's top status line) and in one Telegram message. No score, stop, action or decision reads it.
 * Never throws (the call runs under runStep). No key: no call, one plain line. Nightly mode: refused, no call.
 * Same model, retry policy and server-side refusal fallback as the per-ticker review (claudeReview.ts, claudeSdk.ts).
 */

import type { RunContext } from '../core/context.ts';
import { runStep } from '../core/runStep.ts';
import { reportSentence } from '../core/result.ts';
import {
  CLAUDE_REVIEW_MODEL, DEFAULT_CLAUDE_RETRY_POLICY, sendClaudeRequest, scrubSecrets,
  type ClaudeEffort, type ClaudeRequest, type ClaudeRetryPolicy, type ClaudeSdk, type ClaudeUsage,
} from './claudeReview.ts';

import { PORTFOLIO_VIEW_TITLE } from '../reports/exitSheet/text.ts';

export { PORTFOLIO_VIEW_TITLE };
export const PORTFOLIO_VIEW_DISCLOSURE = 'Written by Claude Opus, an AI model, from this whole Exit report (every stock and option). Display only: no score, stop or action in this report reads it.';
export const PORTFOLIO_VIEW_NO_KEY = 'Portfolio view (Claude Opus): off, no Anthropic key is saved. Every number in this report is unaffected.';
export const PORTFOLIO_VIEW_FAILED = 'Portfolio view (Claude Opus): not available this time. Every number in this report is unaffected.';
export const PORTFOLIO_VIEW_NO_REPORT = 'Portfolio view (Claude Opus): the Exit report could not be read, so there was nothing to summarise. Every number in this report is unaffected.';
export const PORTFOLIO_VIEW_TRUNCATED = 'Note: Claude Opus was cut off before it finished, so the last part may be incomplete.';
/** Thinking tokens count against it; the answer itself is under ~250 words. */
export const PORTFOLIO_VIEW_MAX_TOKENS = 6000;
/** The Exit report text sent to Opus is capped here (the summary blocks come first, so a cut loses only the tail). */
export const PORTFOLIO_READ_MAX_CHARS = 150_000;

export const PORTFOLIO_SECTIONS = ['IN ONE LINE', 'CONCENTRATION', 'CORRELATED BETS', 'BIGGEST RISKS', 'WHAT TO TRIM FIRST'] as const;

export const PORTFOLIO_SYSTEM_PROMPT = [
  'You review one private investor\'s whole portfolio for exit risk. You get their Exit report exactly as an engine wrote it:',
  'every stock and option they hold, with prices, gains, trailing stops, the engine\'s action for each, the book-model reads,',
  'and the portfolio-wide checks. Write a SHORT portfolio-level view for a non-expert reader.',
  '',
  'Rules:',
  '- Use ONLY the facts and numbers in the report. Never invent a price, target, weight, date or figure. If a number is not in the report, say it in words.',
  '- Do not override the report. Each holding\'s action stays as the report gives it; you add the whole-portfolio view a per-holding report cannot give.',
  '- Plain text only: no Markdown, no #, no *, no tables. Short plain sentences. Under 250 words in total.',
  '- Exactly these five sections, in this order, each header in UPPERCASE on its own line:',
  'IN ONE LINE: one sentence, the single most important thing about this portfolio as a whole.',
  'CONCENTRATION: what the money is really exposed to (largest positions, themes, sectors), using the report\'s own market values.',
  'CORRELATED BETS: holdings that rise and fall together and are really one bet (for example several Bitcoin-linked names: spot Bitcoin ETFs, miners, a company holding Bitcoin), and any stock and option on the same name.',
  'BIGGEST RISKS: the two or three things that would hurt the whole portfolio most, including option expiries and breached stops.',
  'WHAT TO TRIM FIRST: if the investor reduced risk, which positions to look at first and why, in order, consistent with the report\'s own actions.',
].join('\n');

export function portfolioUserMessage(exitReadText: string): string {
  return 'Here is the Exit report, one sheet row per line, cells separated by " | ".\n\n<exit_report>\n' + exitReadText + '\n</exit_report>\n\nWrite the portfolio view now, in the five sections.';
}

/** The Exit report rows as plain text, one row per line; capped at PORTFOLIO_READ_MAX_CHARS. */
export function exitReadText(rows: ReadonlyArray<ReadonlyArray<unknown>>, maxChars = PORTFOLIO_READ_MAX_CHARS): string {
  const lines: string[] = [];
  for (const r of rows) {
    const cells = r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c ?? '')).replace(/\s+/g, ' ').trim()).filter((c) => c !== '');
    if (cells.length) lines.push(cells.join(' | '));
  }
  const text = lines.join('\n');
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n[the rest of the report was cut to keep the request short]';
}

/** The sentence under the IN ONE LINE header (or on its line), else null. */
export function portfolioHeadline(body: string): string | null {
  const m = /IN ONE LINE\s*:?[ \t]*([^\n]*)\n?\s*([^\n]*)/i.exec(body);
  if (!m) return null;
  const h = ((m[1] ?? '').trim() || (m[2] ?? '').trim());
  return h && !(PORTFOLIO_SECTIONS as readonly string[]).some((s) => h.toUpperCase().startsWith(s)) ? h : null;
}

export interface PortfolioOpusDeps {
  readonly ctx: RunContext;
  readonly apiKey: string;
  readonly sdk: ClaudeSdk;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly retry?: Partial<ClaudeRetryPolicy>;
  readonly stepTimeoutMs?: number;
}

export interface PortfolioView {
  readonly state: 'ok' | 'off' | 'failed';
  /** For the sheet, under its title: the disclosure line then Opus's text (ok), or one plain line. */
  readonly paragraphs: readonly string[];
  /** The IN ONE LINE sentence (ok only), for the report's top status line. */
  readonly headline: string | null;
  /** The Telegram message (and stdout line when not ok). */
  readonly telegram: string;
  readonly model?: string;
  readonly usage?: ClaudeUsage;
}

const plain = (state: 'off' | 'failed', line: string): PortfolioView => ({ state, paragraphs: [line], headline: null, telegram: line });

export async function portfolioOpusView(deps: PortfolioOpusDeps, exitRead: string | null, effort: ClaudeEffort): Promise<PortfolioView> {
  const ctx = deps.ctx;
  if (ctx.mode === 'nightly') {
    ctx.log.error('portfolio view: called from a nightly run; refusing (nightly runs make no AI calls)');
    return plain('off', PORTFOLIO_VIEW_FAILED);
  }
  if (!deps.apiKey) { ctx.log.info(PORTFOLIO_VIEW_NO_KEY); return plain('off', PORTFOLIO_VIEW_NO_KEY); }
  if (!exitRead || !exitRead.trim()) { ctx.log.warning('portfolio view: the Exit report text is empty'); return plain('failed', PORTFOLIO_VIEW_NO_REPORT); }
  const model = deps.model ?? CLAUDE_REVIEW_MODEL;
  const request: ClaudeRequest = {
    model,
    max_tokens: deps.maxTokens ?? PORTFOLIO_VIEW_MAX_TOKENS,
    system: [{ type: 'text', text: PORTFOLIO_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: portfolioUserMessage(exitRead) }],
    output_config: { effort },
  };
  const policy: ClaudeRetryPolicy = { ...DEFAULT_CLAUDE_RETRY_POLICY, ...(deps.retry ?? {}) };
  const label = PORTFOLIO_VIEW_TITLE;
  const r = await runStep(ctx, {
    key: 'ai.opus.portfolio', label, retry: 'never', maxAttempts: 1, timeoutMs: deps.stepTimeoutMs ?? 420_000,
    onFailure: reportSentence(PORTFOLIO_VIEW_FAILED),
  }, async () => {
    const emit = (lvl: 'info' | 'warn' | 'error', m: string): void => { if (lvl === 'info') ctx.log.info(m); else if (lvl === 'warn') ctx.log.warning(m); else ctx.log.error(m); };
    const sent = await sendClaudeRequest(deps.sdk, request, policy, { sleep: ctx.sleep, random: ctx.random, apiKey: deps.apiKey, label: 'Claude Opus (portfolio view)', emit });
    if (!sent.ok) throw new Error('Opus portfolio view ' + sent.reason + ' after ' + sent.attempts + ' attempt(s): ' + scrubSecrets(sent.detail, deps.apiKey));
    const u = sent.usage;
    ctx.log.info('  Claude Opus (portfolio view) received (' + sent.parsed.body.length + ' chars, stop=' + sent.parsed.stopReason + ', in=' + u.inputTokens + ' out=' + u.outputTokens + ')');
    const answered = typeof sent.response.model === 'string' && sent.response.model ? sent.response.model : model;
    if (!answered.startsWith(model)) ctx.log.info('  Claude Opus (portfolio view) declined; answered by the fallback model ' + answered);
    return { body: sent.parsed.body, truncated: sent.parsed.truncated, model: answered, usage: u };
  });
  if (!r.ok) return plain('failed', PORTFOLIO_VIEW_FAILED);
  const v = r.value;
  const body = v.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const paragraphs = [PORTFOLIO_VIEW_DISCLOSURE, ...body, ...(v.truncated ? [PORTFOLIO_VIEW_TRUNCATED] : [])];
  const telegram = ['📊 ' + PORTFOLIO_VIEW_TITLE, '', v.body, ...(v.truncated ? ['', PORTFOLIO_VIEW_TRUNCATED] : []), '', PORTFOLIO_VIEW_DISCLOSURE].join('\n');
  return { state: 'ok', paragraphs, headline: portfolioHeadline(v.body), telegram, model: v.model, usage: v.usage };
}
