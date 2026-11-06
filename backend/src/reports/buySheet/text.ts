/**
 * FL-8r: every fixed sentence and formatter of the Buy report sheet. The shared catalog (messages/catalog.ts) owns
 * reason and effect sentences; this file holds the fixed labels and explanations of this one report. No sentence here
 * contains data; data is passed in as numbers. Words the leak scanner reacts to near digits (status, error,
 * response, returned, http) are avoided on purpose. There is no tax wording anywhere in the Buy report (plan 5.2).
 * The helpers that were byte-identical with src/reports/exitSheet/text.ts are imported from there (dedupe cluster 7).
 */
import { REASON_CODES, type ReasonCode } from '../messages/catalog.ts';
import type { ModelId, Stance } from './types.ts';
import { AI_ANCHOR, AI_PLACEHOLDER, MODEL_ORDER, MODEL_NAMES, stanceLabel, fmtUsd, fmtPlainPct, chunkText, cleanNarrative } from '../exitSheet/text.ts';

export { AI_ANCHOR, AI_PLACEHOLDER, MODEL_ORDER, MODEL_NAMES, stanceLabel, fmtUsd, fmtPlainPct, chunkText, cleanNarrative };
export const BUY_SHEET_TAB = '🛒 Buy Report';
export const BUY_SHEET_TAB_COLOR = '#188038';
export const NCOLS = 9;
export const WIDTHS: readonly number[] = [150, 100, 110, 140, 150, 150, 150, 100, 100];
export const DEFAULT_TIER1_MIN = 70;
export const DEFAULT_TIER2_MIN = 45;

const STANCE_IDS: readonly Stance[] = ['BULLISH', 'NEUTRAL', 'BEARISH', 'UNAVAILABLE'];
export const isModelId = (x: unknown): x is ModelId => typeof x === 'string' && (MODEL_ORDER as readonly string[]).includes(x);
export const isStance = (x: unknown): x is Stance => typeof x === 'string' && (STANCE_IDS as readonly string[]).includes(x);
export const isReasonCode = (x: unknown): x is ReasonCode => typeof x === 'string' && (REASON_CODES as readonly string[]).includes(x);

const TIMING: Readonly<Record<string, string>> = { BUY_NOW: 'Buy now', WAIT_PULLBACK: 'Wait for a pullback', AVOID: 'Avoid for now' };
const TIMING_MEANING: Readonly<Record<string, string>> = {
  BUY_NOW: 'The trend is up and the price is within reach of the entry zone, so the entry can be taken now.',
  WAIT_PULLBACK: 'The idea may be sound but the price is not at a good entry yet. Wait for it to come back into the entry zone.',
  AVOID: 'The chart gives no good entry right now.',
};
const REGIME_PHRASE: Readonly<Record<string, string>> = { TREND_UP: 'an uptrend', TREND_DOWN: 'a downtrend', CHOP: 'a sideways range', HIGH_VOL: 'a volatile, directionless stretch' };
const REGIME_SHORT: Readonly<Record<string, string>> = { TREND_UP: 'Uptrend', TREND_DOWN: 'Downtrend', CHOP: 'Sideways', HIGH_VOL: 'Volatile' };
const BAND: Readonly<Record<string, string>> = { own: 'Strong', mixed: 'Mixed', weak: 'Weak', unknown: 'Not rated' };
export const timingLabel = (t: unknown): string | null => (typeof t === 'string' ? (TIMING[t] ?? null) : null);
export const timingMeaning = (t: unknown): string | null => (typeof t === 'string' ? (TIMING_MEANING[t] ?? null) : null);
export const regimePhrase = (r: unknown): string | null => (typeof r === 'string' ? (REGIME_PHRASE[r] ?? null) : null);
export const regimeShort = (r: unknown): string | null => (typeof r === 'string' ? (REGIME_SHORT[r] ?? null) : null);
export const bandLabel = (b: unknown): string | null => (typeof b === 'string' ? (BAND[b] ?? null) : null);


export function fmtNum(n: number | null | undefined, digits = 1): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toFixed(digits);
}
/** A score as the engine shows it: whole numbers stay whole, anything else gets one decimal. */
export function fmtScore(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function stamp(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * An option expiry (unix seconds) as text. FIXED (F-R5): the default prints the UTC calendar day of the stored
 * timestamp, which is the real expiry date (a 00:00 UTC expiry printed in New York reads one day early, F-62).
 * Parity flag `legacy` restores the legacy toDateString() (process time zone, buildBottomLineSummaryV7 :5405).
 */
export function expiryText(expUnix: unknown, legacy: boolean): string | null {
  if (typeof expUnix !== 'number' || !Number.isFinite(expUnix)) return null;
  const d = new Date(expUnix * 1000);
  if (Number.isNaN(d.getTime())) return null;
  if (legacy) return d.toDateString();
  return MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
}

/** Row height estimate for wrapped text across columns [fromCol..toCol] (1-based). */
export function estHeight(text: string, fromCol: number, toCol: number = NCOLS): number {
  const width = WIDTHS.slice(fromCol - 1, toCol).reduce((a, b) => a + b, 0);
  const cpl = Math.max(20, Math.floor(width / 6.5));
  const lines = String(text).split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cpl)), 0);
  return Math.max(21, lines * 15 + 6);
}



/** AI narrative -> report-safe paragraphs. Any line the leak scanner flags is dropped and counted (detail goes to the log). */


export const T = {
  title: '🛒 BUY REPORT — every candidate on your Watchlist, ranked in one place',
  howToRead: "How to read this: the shortlist comes first, then the full ranking of every candidate so none is skipped. Strong candidates get a full write-up, near misses a short one, and the rest one line. Most days few names can be bought, and saying so plainly is the right answer. This report reads current conditions and reacts to confirmed signals; it does not predict. Position sizes are relative to your account, never in dollars.",
  runLabel: 'Run time: ',
  aiPointer: (row: number): string => 'AI narrative: see the AI SUMMARIES section at row ' + row + '. It states when it was last written and which candidates it covered.',
  bannerCounts: (total: number, ok: number, partial: number, failed: number): string =>
    total + ' candidate(s) on the Watchlist: ' + ok + ' analysed, ' + partial + ' with a partial result, ' + failed + ' that could not be analysed tonight.',
  seeded: 'The Watchlist tab was empty, so a starter list was written to it. Edit that tab to change what this report covers.',
  portfolioUnreadable: 'Your holdings could not be read tonight, so no comparison with them is shown.',
  noRunIssues: 'No run-level data issues.',
  noCandidates: 'The watchlist has no tickers, so there is nothing to rank.',
  nothingActionable: 'Nothing is actionable today. Every candidate is either waiting for a better entry or not worth buying right now.',
  shortlistHeader: '⭐ THE SHORTLIST — candidates you could act on',
  shortlistIntro: 'These are the candidates that can be bought now or that rank highest on conviction. Everyone else on the Watchlist is in the full ranking below.',
  rankingHeader: 'FULL RANKING — every candidate on the Watchlist, nothing left out',
  rankingNote: 'Ranked by: a name that can be bought now first, then higher conviction, then higher entry confidence. Bitcoin-tracking funds share one rank because they are one idea.',
  rankingColumns: ['Rank and ticker', 'Conviction', 'Fundamentals', 'Timing', 'Entry zone', 'Verdict', '', 'Updated', 'Jump'] as readonly string[],
  tagHeld: ' · you hold this: add-to-position decision',
  tagGroup: ' · Bitcoin group (one rank)',
  changedHeader: '⚠ CHANGED SINCE LAST RUN — verdict changes',
  optionsReadsHeader: (applied: boolean): string => '📈 OPTIONS READS — ' + (applied ? 'applied (shown; today\'s options signals score 0, only the capped new measures can score)' : 'not yet applied (shadow)'),
  optionsReadsNote: 'Each stock\'s own options read tonight and what it would change if applied (CONFIRM +8 / CONFLICT -10 on conviction, LEAPS lean ±5, the tech score\'s Options category). The decisions above do not use it yet.',
  optionsReadsMissing: (names: string): string => 'Options read missing for ' + names + '.',
  noChanges: 'No verdict changed since the last run.',
  changeLine: (from: string, to: string, fromConv: string | null, toConv: string | null): string =>
    from + '  →  ' + to + '  (conviction ' + (fromConv ?? '—') + ' → ' + (toConv ?? '—') + ')',
  changeBaselineNote: 'A change compares today with the last run from an earlier day. A ticker with no earlier run shows no change.',
  btcHeader: '₿ BITCOIN COMPLEX — one idea, several vehicles',
  btcSubstitutes: (members: string): string =>
    'Technical read shared across Bitcoin-tracking ETFs (' + members + '), since they track the same underlying asset. These are alternative vehicles for one idea, not separate opportunities. Entry zone, stop, sizing and fund fundamentals below are specific to each ticker.',
  btcOneSlot: 'They occupy one rank in the ranking. Compare them on cost, trading volume and how closely each fund follows the asset, not on the chart alone.',
  btcSingle: (t: string): string => t + ' is the only Bitcoin-tracking fund on the Watchlist, so there is nothing to compare it with. Entry zone, stop and sizing are specific to this ticker.',
  btcDisclosure: (members: string): string =>
    'Technical read shared across Bitcoin-tracking ETFs (' + members + '), since they track the same underlying asset. These are alternative vehicles for one idea, not separate opportunities. Entry zone, stop, sizing, and fund fundamentals below are specific to this ticker.',
  btcColumns: ['Ticker', 'Rank', 'Conviction', 'Entry zone', 'Initial stop'] as readonly string[],
  btcNoSharedThesis: "A shared technical read was not part of tonight's data; each fund's own read is below.",
  btcNoDifferentiators: "Fund-level differences (fees, trading volume, premium or discount to the fund's holdings) are not part of tonight's data.",
  btcDiffColumns: ['Fund', 'Expense ratio', 'Average daily volume', 'Premium or discount'] as readonly string[],
  tier1Header: (t1: number): string => 'TIER 1 — FULL DEPTH (can be bought now, or conviction ' + t1 + ' or higher)',
  tier2Header: (t1: number, t2: number): string => 'TIER 2 — CONDENSED (near misses: conviction ' + t2 + ' to ' + (t1 - 1) + ')',
  tier3Header: (t2: number): string => 'TIER 3 — ONE LINE EACH (conviction below ' + t2 + ', blocked, or no verdict)',
  tier1None: 'No candidate qualifies for full depth today.',
  tier2None: 'No candidates in this tier today.',
  tier3None: 'No candidates in this tier today.',
  heldBanner: 'YOU ALREADY HOLD THIS — the question is whether to ADD to your position, not whether to open one.',
  heldShort: 'You already hold this: the question is whether to add to your position.',
  chartOnlyCaution: 'Caution: fundamentals are weak or not rated, so this is a chart-only idea. The verdict above says so.',
  entryConfNote: 'How closely the independent entry methods line up. Higher means more of them agree on the zone.',
  ladderNone: 'No buy-limit ladder: not enough entry methods line up this run.',
  ladderRung: (k: number, price: string, pct: number | null): string => 'Rung ' + k + ': ' + price + (pct != null ? ' — ' + pct + '% of the position' : ''),
  stopExplain: 'The price at which the idea is wrong. It is measured from the planned entry, not from today.',
  turtleStop: (price: string): string => price + ', two times N below the entry (N is the stock\'s typical daily move)',
  sizingMissing: 'Position size could not be worked out from the data in this run.',
  rr: (rr: number): string => rr.toFixed(2) + ' to 1' + (rr < 1.0 ? ' — marginal structure' : rr < 1.5 ? ' — thin, size accordingly' : ''),
  rrPlain: (rr: number): string => rr.toFixed(2) + ' to 1',
  rrSpot: (rr: number, atEntry: string | null, entry: string | null): string =>
    rr.toFixed(2) + ' to 1' + (atEntry != null && entry != null ? ' (versus ' + atEntry + ' to 1 at the ' + entry + ' ladder entry)' : ''),
  optionsNone: 'No option picks are available for this candidate in this run.',
  optionNotAvailable: 'Not available in this run.',
  optionNotFound: (reason: string): string => 'No suitable call was found' + (reason ? ': ' + reason.replace(/[.\s]+$/, '') : '') + '.',
  optionAhead: 'The chart says to wait for a pullback, so buying this call now would run ahead of that plan.',
  optionIvNone: 'not available',
  modelsHeader: ['Model', 'Read', 'Score', 'Note'] as readonly string[],
  modelsAgreement: (agree: number, total: number, majority: string | null, dissenters: string): string =>
    agree + ' of ' + total + ' models agree' + (majority ? ' (' + majority + ')' : '') + (dissenters ? '. Disagreeing: ' + dissenters + '.' : '. No model disagrees.'),
  aiPointerCandidate: (row: number): string => '→ AI review for this candidate: see the AI SUMMARIES section at row ' + row + '.',
  tier2Why: (t1: number): string => 'A near miss: it cannot be bought now and its conviction is below ' + t1 + '.',
  promotionFallback: 'Would be actionable once the entry timing turns to buy now.',
  footerHeader: 'HOW THIS REPORT WAS BUILT',
  rankKey: 'Ranking key: a name that can be bought now first, then higher conviction, then higher entry confidence. Bitcoin-tracking funds share one rank.',
  tierRule: (t1: number, t2: number): string =>
    'Tier 1 = can be bought now, or conviction ' + t1 + ' or higher. Tier 2 = conviction ' + t2 + ' to ' + (t1 - 1) + '. Tier 3 = below ' + t2 + ', blocked, or no verdict. These cut-offs are reasoned starting points and have not been validated against results.',
  floorCaveat: (floor: number, filter: number): string =>
    'Conviction is the main ranking key. Fundamentals act as a filter: from a score of ' + filter + ' and up they do not change conviction; below that the chart score is reduced on a curve, and at ' + floor + ' or below the candidate is blocked. The floor of ' + floor + ' is a reasoned default and has not been validated against results.',
  sizingNote: 'Position sizes are relative to your account: a first unit risks a stated percent of the account if the initial stop is hit. No dollar amounts or share counts are shown.',
  longOnly: 'Only long stock and long call ideas are considered; there are no short or put ideas.',
  historyNote: 'Verdict changes use the Decision History tab, which is kept in full and only ever added to.',
  aiNote: 'AI narrative is written only by the manual AI run, into the AI SUMMARIES section below. The nightly run clears that section, so old commentary never sits beside new numbers.',
  aiHeaderStatus: (when: string, gemini: boolean, opus: string, effort: string): string => 'Written ' + when + ' · Gemini: ' + (gemini ? 'used' : 'not used') + ' · Opus: ' + opus + ' · effort: ' + effort,
  aiScope: (covered: number, total: number, coveredList: string, uncoveredList: string): string =>
    'AI review covered ' + covered + ' of ' + total + ' candidates' + (coveredList ? ': ' + coveredList : '') + '.' +
    (uncoveredList ? ' Not covered: ' + uncoveredList + '. Candidates outside the AI scope were left out on purpose; their numbers in the sections above are unchanged.' : ' Every candidate was covered.'),
  aiGemini: 'Gemini narrative',
  aiOpus: 'Opus review',
  opusReviewLine: 'Mode: Opus REVIEW — Opus checked the Gemini narrative above.',
  opusStandalone: (why: string | null): string => 'Mode: Opus STANDALONE — Opus wrote this without a Gemini narrative to check' + (why ? ' because ' + why : '') + '.',
  aiDropped: 'Some lines of this narrative were left out because they contained technical detail.',
  aiRunNightlyFirst: 'The Buy report has not been built yet. Build the Buy report first, then run the AI analysis.',
  aiAnchorMissing: 'The AI SUMMARIES section could not be found in the Buy report. Rebuild the Buy report, then run the AI analysis again.',
  aiAnchorDuplicate: 'The Buy report has more than one AI SUMMARIES section, so nothing was changed. Rebuild the Buy report first.',
};
