/**
 * One set of words for the options numbers every page shows (fix plan 2026-10-30).
 * Display only: nothing here changes a score, the conviction or a weight.
 *
 *   D4  the put/call open-interest ratio: always the WHOLE chain (computeChainContext's putCallRatioOI), labelled with
 *       the bands the options scoring uses (analyzeOptionsForScoring pcSig). The Options Dashboard tab's old ratio over
 *       only the contracts above the $ floor is kept, but labelled as exactly that.
 *   B3  the "IV rank" / "IV percentile" is where the near-term IV sits among today's contract IVs -- not a history-based
 *       IV rank (that will come from the 📉 IV History tab once it has about a year of nights).
 *   D5  contracts expiring in under MIN_DAYS_FOR_IV_CONTEXT days are left out of the front IV, the term structure and
 *       that percentile (today's 0-day options print IVs of 170-220%).
 *   D6  the LEAPS and short-term pick rules, worded from what selectRecommendedCall does.
 */

/** D4: the words for the scoring bands (scoring.ts pcSig: 0.6 / 0.8 / 1.1 / 1.4 -- the score itself is unchanged). */
export function putCallBand(pc: number | null | undefined): string {
  if (pc == null || !Number.isFinite(pc)) return 'not available';
  if (pc <= 0.6) return 'calls dominate (bullish)';
  if (pc <= 0.8) return 'more calls than puts (mildly bullish)';
  if (pc <= 1.1) return 'balanced (neutral)';
  if (pc <= 1.4) return 'more puts than calls (mildly bearish)';
  return 'puts dominate (bearish)';
}

/** D4: the label every page uses for the whole-chain ratio. */
export const PUT_CALL_LABEL = 'Put/call ratio (open interest, whole chain)';
/** D4: the bands, as one line. */
export const PUT_CALL_BANDS_TEXT = 'up to 0.60 bullish · up to 0.80 mildly bullish · up to 1.10 neutral · up to 1.40 mildly bearish · above 1.40 bearish';
/** D4: the Options Dashboard tab's ratio over the scored (filtered) contracts only. */
export const PUT_CALL_FLOOR_LABEL = 'P/C of the contracts above the $ floor';

/** "0.92 — balanced (neutral)" (or "not available"). */
export function putCallText(pc: number | null | undefined): string {
  if (pc == null || !Number.isFinite(pc)) return 'not available';
  return pc.toFixed(2) + ' — ' + putCallBand(pc);
}

/** B3: the user-facing name of chainContext.ivRankPct / optAnalysis.ivRank. */
export const IV_CHAIN_PCT_LABEL = 'IV vs this chain (percentile)';
/** B3: what it is, in one sentence. */
export const IV_CHAIN_PCT_MEANING = 'where the near-term IV sits among all of today\'s contract IVs for this stock (not a history-based IV rank)';

/** D5: contracts with fewer days to expiry than this stay out of the front IV, term structure and IV percentile. */
export const MIN_DAYS_FOR_IV_CONTEXT = 7;

/** D3: the short-term pick needs at least this many days left (the 30-day exit then leaves >= 30 days of holding). */
export const SHORT_TERM_MIN_DAYS = 60;
/** The pick windows (selectRecommendedCall). */
export const LEAPS_MIN_DAYS = 180;
export const SHORT_TERM_MAX_DAYS = 180;

/** D6: the LEAPS pick rule (selectRecommendedCall), the same words on every page. */
export const LEAPS_RULE = 'the furthest expiry at least ' + LEAPS_MIN_DAYS + ' days out';
/** D3/D6: the short-term pick rule (outside parity runs). */
export const SHORT_TERM_RULE = 'the nearest expiry with ' + SHORT_TERM_MIN_DAYS + ' to ' + SHORT_TERM_MAX_DAYS + ' days left';

/** "LEAPS (the furthest expiry at least 180 days out, target delta 0.75)". */
export function pickLabel(leaps: boolean, delta: number, opts: { readonly upper?: boolean; readonly deltaWords?: string } = {}): string {
  const name = leaps ? 'LEAPS' : opts.upper ? 'SHORT-TERM' : 'Short-term';
  return name + ' (' + (leaps ? LEAPS_RULE : SHORT_TERM_RULE) + ', ' + (opts.deltaWords ?? 'target delta') + ' ' + delta.toFixed(2) + ')';
}

