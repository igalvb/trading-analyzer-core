/**
 * The pre-registered kill rules of the options weights (docs/OPTIONS_WEIGHTS_DUE_DILIGENCE_2026-11-06.md section 5,
 * owner yes 2026-11-06), fixed BEFORE any data. Nothing here runs automatically: the nightly only stores the data
 * (📈 Options Reads, 📐 Options Measures, the paper twin "Engine, options off" from lab.optionsLive). A review reads
 * those tabs, computes the statistics below and applies these rules by hand.
 *
 * The rules can only CUT weights inside 24 months. Changing a threshold after seeing data restarts the review clock.
 */

/** The weights under review and their horizons (trading days) for the forward IC. */
export const OPTIONS_REVIEWED_SIGNALS = [
  { id: 'smirk', kind: 'conviction', points: '-2 / +1', horizons: [20, 60] },
  { id: 'ivChange', kind: 'conviction', points: '-1 / +1', horizons: [20, 60] },
  { id: 'ivSpread', kind: 'timing', points: 'entry confidence -3', horizons: [5, 10] },
  { id: 'os', kind: 'timing', points: 'entry confidence -2 (shadow while no volume)', horizons: [5, 10] },
  { id: 'oiBuild', kind: 'timing', points: '0 (shadow)', horizons: [5, 10] },
  { id: 'delay', kind: 'timing', points: 'BUY_NOW delay (shadow)', horizons: [5, 10] },
] as const;

/** How every review measures (doc 5.2). */
export const OPTIONS_REVIEW_METHOD = {
  sample: 'every nightly stock with a fresh read (A-5 gate), from the night its 60-night history is complete',
  target: 'forward return in excess of QQQ: 5 and 10 trading days (timing), 20 and 60 (conviction)',
  statistic: 'mean nightly cross-sectional Spearman IC, signal sign as proposed; block bootstrap (block = horizon), 5,000 draws, one-sided 80% and 90% intervals',
  groups: 'mean excess return when the rule fires vs when it does not (with counts)',
  twin: '"Engine" vs "Engine, options off" from the go-live date: after-tax return (25%), max fall, differing trades and their win/loss',
} as const;

export interface KillRule { readonly review: string; readonly monthsAfterGoLive: number | null; readonly rule: string; readonly action: string }

/** Doc 5.3, verbatim in substance. */
export const OPTIONS_KILL_RULES: readonly KillRule[] = [
  { review: '3 months', monthsAfterGoLive: 3, rule: "a signal's IC < 0 with the one-sided 90% interval wholly below 0", action: 'weight → 0 (wrong sign or bug); otherwise no change' },
  { review: '6 months', monthsAfterGoLive: 6, rule: 'IC < 0 with the one-sided 80% interval wholly below 0', action: 'weight → 0' },
  { review: '6 months, BUY_NOW delay (shadow)', monthsAfterGoLive: 6, rule: '5-day IC of the "2+ bearish" flag > 0 AND mean 10-day excess return after flagged nights < after unflagged nights', action: 'the delay may go live (owner yes); otherwise it stays shadow' },
  { review: '12 months', monthsAfterGoLive: 12, rule: 'IC point estimate ≤ 0', action: 'weight → 0' },
  { review: '12 months', monthsAfterGoLive: 12, rule: 'IC > 0', action: 'keep the weight unchanged (no increase)' },
  { review: '12 months, twin', monthsAfterGoLive: 12, rule: 'options-on trails options-off by > 2 points after-tax return AND the differing trades lost more than they won (needs ≥ 10 differing trades; fewer = inconclusive)', action: 'all options conviction and timing weights → 0, whatever the IC' },
  { review: '24 months', monthsAfterGoLive: 24, rule: 'IC > 0.05 at its horizon AND the 80% interval wholly above 0 AND the twin is not behind', action: 'may rise, at most to the macro level (-4 / +2 total); owner yes' },
  { review: 'any time', monthsAfterGoLive: null, rule: 'a rule fires on more than 30% of stock-nights', action: 'construction bug: freeze at 0 and investigate (fifths should fire about 20% each)' },
  { review: 'current inputs (pcSig, domSig, nbSig, dirSig, LEAPS lean)', monthsAfterGoLive: null, rule: 'already 0; the plan T1 test continues on the stored values', action: 'reconsider only under the 24-month rule; even then start at 1 point' },
];

/** The review dates (YYYY-MM-DD) from the go-live day (the paper test's lab.optionsLive). */
export function optionsReviewDates(goLive: string): Array<{ readonly review: string; readonly due: string }> {
  const months = [...new Set(OPTIONS_KILL_RULES.map((r) => r.monthsAfterGoLive).filter((m): m is number => m != null))].sort((a, b) => a - b);
  return months.map((m) => {
    const d = new Date(goLive + 'T12:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + m);
    return { review: m + ' months', due: d.toISOString().slice(0, 10) };
  });
}

/** The "any time" rule: true when a rule fired on more than 30% of the stock-nights reviewed. */
export function firesTooOften(fired: number, stockNights: number): boolean {
  return stockNights > 0 && fired / stockNights > 0.3;
}
