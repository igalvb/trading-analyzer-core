/**
 * FL-8q: every fixed sentence and formatter of the Exit report sheet. The shared catalog (messages/catalog.ts) owns
 * reason and effect sentences and is used for every N/A reason and every degradation; this file holds the fixed
 * labels and explanations of this one report. No sentence here contains data; data is passed in as numbers.
 * Words the leak scanner reacts to near digits (status, error, response, returned, http) are avoided on purpose.
 */
import { findReportLeaks } from '../messages/leakScan.ts';
import type { ModelId, Stance } from './types.ts';
import { ASSUMED_ENTRY_BASIS, ASSUMED_STOCK_PURCHASE_DATE_LABEL } from '../../sheets/readers/portfolio.ts';

export const EXIT_SHEET_TAB = '📤 Exit Report';
export const EXIT_SHEET_TAB_COLOR = '#1a73e8';
export const AI_ANCHOR = '🤖 AI SUMMARIES';
/** Plan #47: the portfolio-wide Opus view's title (ai/portfolioOpus.ts); its sheet row is '▣ ' + this. */
export const PORTFOLIO_VIEW_TITLE = 'Portfolio view (Claude Opus)';
export const AI_PLACEHOLDER = 'AI narrative pending — run Run AI Analysis to add it.';
export { BITCOIN_ETF_TICKERS } from '../../types/bitcoinEtfs.ts';
export const NCOLS = 6;
export const WIDTHS: readonly number[] = [150, 130, 120, 120, 120, 200];

export const MODEL_ORDER: readonly ModelId[] = ['ENGINE', 'SCHABACKER', 'EDWARDS_MAGEE', 'BROKER_COURSE', 'TURTLE'];
export const MODEL_NAMES: Readonly<Record<ModelId, string>> = {
  ENGINE: 'Main engine', SCHABACKER: 'Schabacker', EDWARDS_MAGEE: 'Edwards & Magee', BROKER_COURSE: 'Broker Course', TURTLE: 'Turtle',
};
const STANCES: Readonly<Record<Stance, string>> = { BULLISH: 'Leans bullish', NEUTRAL: 'Neutral', BEARISH: 'Leans bearish', UNAVAILABLE: 'Not available' };
export const stanceLabel = (s: Stance): string => STANCES[s];

export function fmtUsd(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtSignedUsd(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return (n < 0 ? '-' : '+') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtPct(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return (n < 0 ? '-' : '+') + Math.abs(n).toFixed(1) + '%';
}
export function fmtPlainPct(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toFixed(1) + '%';
}
export function fmtQty(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
export function fmtNum(n: number | null | undefined, digits = 1): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toFixed(digits);
}
export function stamp(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}

/** Row height estimate for wrapped text across columns [fromCol..NCOLS] (1-based). */
export function estHeight(text: string, fromCol: number): number {
  const width = WIDTHS.slice(fromCol - 1).reduce((a, b) => a + b, 0);
  const cpl = Math.max(20, Math.floor(width / 6.5));
  const lines = String(text).split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cpl)), 0);
  return Math.max(21, lines * 15 + 6);
}

export function chunkText(t: string, max = 1200): string[] {
  if (t.length <= max) return [t];
  const out: string[] = [];
  let cur = '';
  for (const w of t.split(/\s+/)) {
    if (cur && cur.length + 1 + w.length > max) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

/** AI narrative -> report-safe paragraphs. Any line the leak scanner flags is dropped and counted (detail goes to the log). */
export function cleanNarrative(text: string | null | undefined): { paragraphs: string[]; dropped: number } {
  const paragraphs: string[] = [];
  let dropped = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    if (findReportLeaks(t).length) { dropped++; continue; }
    paragraphs.push(...chunkText(t));
  }
  return { paragraphs, dropped };
}

export const T = {
  title: '📤 EXIT REPORT — every holding you own, in one place',
  howToRead: 'How to read this: the summary and the list of holdings that need attention come first. Each holding then has a one-line verdict, followed by the evidence behind it. This report reads current conditions and reacts to confirmed signals; it does not predict.',
  aiPointer: (row: number): string => 'AI narrative: see the AI SUMMARIES section at row ' + row + '. It states when it was last written.',
  /** Row 35 (#4): the banner's AI status line. The nightly writes "not run yet"; the AI run rewrites it in place. */
  aiStatusPrefix: 'AI review: ',
  aiStatusPending: (row: number): string => 'AI review: not run yet for this report (the AI SUMMARIES section at row ' + row + ' is empty).',
  /** Plan #47: appended to the status line when the portfolio view has a headline. */
  aiStatusPortfolio: (headline: string): string => ' Portfolio view (Claude Opus), first in that section: ' + headline,
  aiStatusDone: (when: string, gemini: boolean, opus: string, row: number): string => 'AI review: written ' + when + ' · Gemini ' + (gemini ? 'used' : 'not used') + ' · Opus ' + opus + '. See the AI SUMMARIES section at row ' + row + '.',
  /** Row 35 (#37): the Score column. The engine's own conviction; each book model counts its signals (count, not a score). */
  engineScore: (conviction: number): string => conviction + '/100 conviction',
  modelSignals: (pro: number, con: number): string => pro + ' for · ' + con + ' against',
  runLabel: 'Run time: ',
  dataHealthHeader: 'DATA HEALTH AND ROWS READ',
  noRunIssues: 'No run-level data issues.',
  noEntryDates: (n: number, names: string): string => n + ' holding(s) have no purchase date on file (' + names + '). Their stop is measured from a generic lookback instead of your real entry.',
  allHaveEntryDates: 'Every holding with data has a purchase date on file.',
  /** Row 36 (owner 2026-10-31): stock rows without a purchase date use the assumed date. */
  assumedEntryDates: (n: number, names: string): string => n + ' stock holding(s) have no purchase date on file (' + names + '). Their stop is ' + ASSUMED_ENTRY_BASIS + '.',
  cryptoSkipped: (n: number, names: string): string => 'Skipped ' + n + ' row(s) typed crypto on the Portfolio sheet (' + names + '). This report analyses stocks, ETFs and options only.',
  btcEtfTypedCrypto: (t: string): string => '⚠ ' + t + ' is a spot Bitcoin ETF but is typed crypto on the sheet. Change its type to stock to get the full analysis.',
  otherSkipped: (n: number, names: string): string => 'Excluded ' + n + ' non-position row(s) from the stock table: ' + names,
  blankSkipped: (n: number): string => 'Skipped ' + n + ' genuinely empty row(s) in the stock table (no ticker, no other content).',
  summaryHeader: 'PORTFOLIO SUMMARY',
  tocHeader: 'TABLE OF CONTENTS — one line per holding, most urgent first',
  tocColumns: ['Holding', 'Action', 'Gain/loss', 'Stop and targets', 'Flags', 'Jump'],
  attentionHeader: '⚠ NEEDS ATTENTION',
  nothingNeedsAttention: 'Nothing needs attention right now: no holding has an exit, review or trim signal.',
  noHoldings: 'No open positions were found on the Portfolio sheet.',
  btcHeader: '₿ BITCOIN COMPLEX — SHARED THESIS',
  btcWhy: 'These holdings track the same underlying asset, so the technical read is shown once instead of as several look-alike analyses. Counting five near-identical reads would look like five sources agreeing when it is one signal. The tracking is close but not identical: expense ratios make the funds drift apart slowly, and GBTC in particular has its own history of trading above or below its net asset value.',
  btcDisclosure: (members: string): string => 'Technical read shared across Bitcoin-tracking ETFs (' + members + '), since they track the same underlying asset. Your stop, targets, fundamentals, and position details below are specific to this holding.',
  checksHeader: 'PORTFOLIO-WIDE CHECKS (informational, not a vote)',
  footerHeader: 'HOW THIS REPORT WAS BUILT',
  noEntryDate: 'No purchase date is on file for this holding. Its stop is measured from a generic lookback instead of your real entry, so the exit read is less certain. Add the date on the Portfolio sheet to fix this.',
  entryDateUnreadable: 'The purchase date on the sheet could not be read as a date, so a generic lookback is used instead of your real entry.',
  assumedEntryDate: ASSUMED_STOCK_PURCHASE_DATE_LABEL + ', an assumed date: no real purchase date is on file for this holding. Its stop is ' + ASSUMED_ENTRY_BASIS + '. When the price history on file starts later, the highest price in the whole history is used. Add the real date on the Portfolio sheet to replace it.',

  taxBaseline: (pct: number): string => 'After-tax figures use a working assumption of ' + pct + '% capital-gains tax. It is not your real computed tax rate and it is not tax advice.',

  entryFallbackNote: 'A stock holding without a purchase date is ' + ASSUMED_ENTRY_BASIS + '. An option without a usable purchase date uses a generic lookback instead. Each holding says which one it used.',
  longOnly: 'Only long stock and long option positions are covered.',
  aiNote: 'AI narrative is written only by the manual AI run, into the AI SUMMARIES section below. The nightly run clears that section, so old commentary never sits beside new numbers.',
  triggersHeader: 'What triggers what',
  triggerStock: [
    'EXIT if the thesis is broken.',
    'EXIT if the price is below the stop and the stop is measured from your real entry date, or from the assumed ' + ASSUMED_STOCK_PURCHASE_DATE_LABEL + ' when no date is on file.',
    'REVIEW (low confidence) if the stop is breached but only a generic lookback could be used.',
    'CONSIDER TRIMMING if target 1 or target 2 has been reached.',
    'Otherwise HOLD.',
  ] as readonly string[],
  triggerOptionExtra: (days: number | null): string[] => [
    days != null ? 'EXIT if the option is within ' + days + ' days of expiry.' : 'EXIT if the option gets close to expiry.',
    'EXPIRED means the contract is past its expiry date: check the Portfolio sheet.',
    'With a single contract a partial exit is not possible.',
  ],
  optionDecay: 'An option loses time value every day, and the loss speeds up as expiry gets closer. Time works against a long option position.',
  stopSinceEntry: 'measured from the highest price since your real entry date',
  stopGeneric: 'measured from a generic lookback because there is no entry date on file',
  stopSinceAssumedEntry: ASSUMED_ENTRY_BASIS,
  stopWeekly: 'weekly stop: the highest weekly close of the last 26 weeks minus 3 weekly ATR, checked on a weekly close',
  noValidTarget: 'no valid target',
  modelsHeader: ['Model', 'Read', 'Score', 'Note'],
  modelsAgreement: (agree: number, total: number, majority: string | null, dissenters: string): string =>
    agree + ' of ' + total + ' models agree' + (majority ? ' (' + majority + ')' : '') + (dissenters ? '. Disagreeing: ' + dissenters + '.' : '. No model disagrees.'),
  optionModelsSee: 'The model reads for the underlying are in the stock section for the same ticker, at row ',
  aiPointerHolding: (row: number): string => '→ AI review for this holding: see the AI SUMMARIES section at row ' + row + '.',
  dataQualityHeader: 'Data quality',
  advisoryDistinct: (n: number, flagged: boolean): string => 'Distinct stocks held: ' + n + (flagged ? ' — above the ' + 10 + '-stock ceiling suggested for an actively managed account (Edwards & Magee, p468).' : ' — within the 8-10 stock guidance for an actively managed account (Edwards & Magee, p468).'),
  advisoryNoPhase: "No strong market-phase read right now (the Evaluative Index is not near either of the book's cited extremes).",
  advisoryTierColumns: ['Ticker', 'Sensitivity-Index tier', 'Note'],
  advisoryInfoOnly: "Informational only, not a scored vote. The phase read describes the market's current phase; it does not predict what comes next.",
  capsHeader: 'Correlated-market exposure caps (Original Turtle Trading System, Appendix E)',
  capsTotal: (units: string, flagged: boolean): string => "Total portfolio Units (real shares held divided by each ticker's own Unit size): " + units + (flagged ? " — above the book's 12-Unit total-direction cap (p690)." : " — within the book's 12-Unit total-direction cap (p690)."),
  capsNone: 'No held tickers currently map to a correlated category.',
  capsColumns: ['Correlated category', 'Units held'],
  capsInfoOnly: "Informational only, not a scored vote. The per-category cap uses the book's 10-Unit loosely-correlated tier. The Unit count is a proxy (current shares divided by the Unit-size formula), not a literal historical Unit count.",
  aiHeaderStatus: (when: string, gemini: boolean, opus: string, effort: string): string => 'Written ' + when + ' · Gemini: ' + (gemini ? 'used' : 'not used') + ' · Opus: ' + opus + ' · effort: ' + effort,
  aiGemini: 'Gemini narrative',
  aiOpus: 'Opus review',
  opusReviewLine: 'Mode: Opus REVIEW — Opus checked the Gemini narrative above.',
  opusStandalone: (why: string | null): string => 'Mode: Opus STANDALONE — Opus wrote this without a Gemini narrative to check' + (why ? ' because ' + why : '') + '.',
  aiDropped: 'Some lines of this narrative were left out because they contained technical detail.',
  aiRunNightlyFirst: 'The Exit report has not been built yet. Build the Exit report first, then run the AI analysis.',
  aiAnchorMissing: 'The AI SUMMARIES section could not be found in the Exit report. Rebuild the Exit report, then run the AI analysis again.',
  aiAnchorDuplicate: 'The Exit report has more than one AI SUMMARIES section, so nothing was changed. Rebuild the Exit report first.',
};
