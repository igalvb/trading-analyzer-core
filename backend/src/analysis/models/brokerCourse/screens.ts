/**
 * Broker Course Phase 13 -- the four "closing gaps" screens
 * (:2651-2793, 4 functions + 1 keyword table).
 *
 * Numbered 13 but a FOUNDATION: P6 calls sharesOutstandingTrendRead and
 * filingKeywordRead, and P9 calls businessCyclePhaseRead and
 * zombieCompanyScreen. Phase numbering here reflects when these were
 * built, not what depends on what -- which is why this file is in the
 * first checkpoint rather than the last.
 *
 * All four are pure transforms of already-fetched data. The fetching
 * (SEC EDGAR full-text search, FRED GDP, FMP ratios-ttm) lives in P11 and
 * the fetch layer.
 */

export interface SharesOutstandingPoint {
  readonly date: string;
  readonly value: number;
}

export interface SharesOutstandingTrend {
  readonly steadilyRising: boolean;
  readonly pctChange: number;
  readonly periodsChecked: number;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly read: string;
}

/**
 * Dilution check: is the share count rising in EVERY recent filed period?
 *
 * ══ "STEADILY" IS READ STRICTLY, ON PURPOSE ════════════════════════════
 * The course says "red flag if steadily increasing (= repeated dilution)"
 * and gives no percentage. Rather than invent a threshold, this requires
 * every one of the last N periods to be strictly higher than the one
 * before -- so a single flat or down quarter clears the flag entirely.
 * That is a deliberately conservative reading: it under-flags rather than
 * fabricating a cutoff.
 *
 * Consequence worth knowing: `pctChange` is still reported even when
 * `steadilyRising` is false, so a company that diluted 40% with one flat
 * quarter in the middle shows a large pctChange and no flag. Both numbers
 * are in the output; the report shows the flag.
 *
 * `<=` on the comparison means a perfectly flat period breaks the streak.
 */
export function sharesOutstandingTrendReadV1(
  history: readonly SharesOutstandingPoint[] | null | undefined,
  lookbackPeriods?: number | null,
): SharesOutstandingTrend | null {
  if (!history || history.length < 2) return null;
  const lookback = lookbackPeriods == null ? 4 : lookbackPeriods;
  const recent = history.slice(-Math.min(lookback, history.length));
  let steadilyRising = recent.length >= 2;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].value <= recent[i - 1].value) {
      steadilyRising = false;
      break;
    }
  }
  const first = recent[0].value;
  const last = recent[recent.length - 1].value;
  const pctChange = (last - first) / first;
  return {
    steadilyRising, pctChange, periodsChecked: recent.length,
    firstDate: recent[0].date, lastDate: recent[recent.length - 1].date,
    read: steadilyRising
      ? 'Shares outstanding steadily rising over the last ' + recent.length
        + ' real reported periods (' + (pctChange * 100).toFixed(1) + '%, ' + recent[0].date
        + ' -> ' + recent[recent.length - 1].date
        + ') — repeated dilution red flag (ep.12 checklist item 2)'
      : 'Shares outstanding not steadily rising over the available reported history — no dilution red flag on this check',
  };
}

/**
 * The course's own literal red-flag keyword list (ep.12).
 *
 * Declared `var` in legacy, not `const` -- the only binding in this file
 * that is, though nothing reassigns it.
 */
export const SEC_DILUTION_KEYWORDS: readonly string[] = [
  'offering', 'shelf', 'warrants', 'convertible', 'dilution',
];

export interface FilingKeywordRead {
  readonly anyFound: boolean;
  readonly hits: Record<string, number | null>;
  readonly foundKeywords: readonly string[];
  readonly read: string;
}

/**
 * Reports which red-flag keywords appear in recent filings.
 *
 * ══ THE LIMITATION IS STATED IN THE OUTPUT, NOT JUST THE COMMENT ═══════
 * A real-data check found AAPL's filings genuinely mention "convertible"
 * and "warrants" in routine benign contexts -- existing convertible-note
 * disclosures, standard stock-plan boilerplate. So word PRESENCE is not
 * the course's intent, which is an analyst reading the actual sentence.
 *
 * The read text therefore says "word presence only, not context — worth a
 * manual read, not a proven flag on its own" every time it fires. That
 * wording is load-bearing: without it this screen would present
 * boilerplate as a dilution warning.
 *
 * Counts of exactly 0 do not count as found (`> 0`), and a null count is
 * skipped rather than treated as zero.
 */
export function filingKeywordReadV1(
  hits: Record<string, number | null> | null | undefined,
): FilingKeywordRead | null {
  if (!hits) return null;
  const foundKeywords = Object.keys(hits).filter((k) => hits[k] != null && (hits[k] as number) > 0);
  const anyFound = foundKeywords.length > 0;
  return {
    anyFound, hits, foundKeywords,
    read: anyFound
      ? 'Recent filings mention: ' + foundKeywords.join(', ')
        + ' — course\'s own red-flag keyword list (ep.12 checklist item 3). Word presence only, not context — worth a manual read, not a proven flag on its own.'
      : 'No recent filings match the course\'s red-flag keyword list',
  };
}

export interface CheckedFilingKeywordRead extends FilingKeywordRead {
  /** Keywords whose search failed (null count): present, and non-empty, only when at least one did. */
  readonly uncheckedKeywords?: readonly string[];
}

/**
 * Fix 2026-11-05 (the false clean): filingKeywordReadV1 skips a null count, so when SEC's full-text search
 * failed for some keyword (HTTP 500 after retries) the read still said "No recent filings match the course's
 * red-flag keyword list" -- a claim about keywords nobody checked. This read names the unchecked keywords
 * ("could not check: offering, shelf") and limits any "no match" claim to the keywords that answered.
 *
 * When every keyword answered (no null count) the result is filingKeywordReadV1's, unchanged (no extra field).
 * Callers mark their section degraded when `uncheckedKeywords` is present.
 */
export function filingKeywordRead(
  hits: Record<string, number | null> | null | undefined,
): CheckedFilingKeywordRead | null {
  const base = filingKeywordReadV1(hits);
  if (!base || !hits) return base;
  const keys = Object.keys(hits);
  const uncheckedKeywords = keys.filter((k) => hits[k] == null);
  if (!uncheckedKeywords.length) return base;
  const checked = keys.filter((k) => hits[k] != null);
  const couldNot = 'could not check: ' + uncheckedKeywords.join(', ') + ' (SEC full-text search failed)';
  let read: string;
  if (base.anyFound) read = base.read + ' Also ' + couldNot + '.';
  else if (checked.length) read = 'No recent filings match the checked red-flag keywords (' + checked.join(', ') + '); ' + couldNot;
  else read = 'Filing keyword search incomplete — ' + couldNot;
  return { ...base, read, uncheckedKeywords };
}

export interface BusinessCyclePhase {
  readonly phase: string;
  readonly latestQGrowth: number;
  readonly priorQGrowth: number;
  readonly read: string;
}

/**
 * Business-cycle phase from a real-GDP series.
 *
 * ══ THE RULE IS TEXTBOOK, NOT FROM THE COURSE ══════════════════════════
 * The course names four phases and gives no detection rule, so this uses
 * the standard recession definition -- two consecutive quarters of
 * negative real GDP growth -- which is an independent convention, not
 * something fitted here.
 *
 * ══ THE LADDER HAS TWO DIFFERENT "PEAK"S ═══════════════════════════════
 *   q1<0 && q2<0        Contraction
 *   q1<0                Peak (growth just turned negative)
 *   q2<0                Trough (growth resumed after a contraction)
 *   q1 >= q2            Expansion
 *   else                Peak (growth decelerating, still positive)
 *
 * So "Peak" is reported both for a single negative quarter and for
 * positive-but-decelerating growth -- two genuinely different states
 * sharing a label, distinguished only by the parenthetical. Reproduced as
 * written; a reader scanning for the word "Peak" alone would conflate them.
 *
 * Needs 3 points to compute two quarter-over-quarter deltas.
 */
export function businessCyclePhaseReadV1(
  gdpSeries: readonly number[] | null | undefined,
): BusinessCyclePhase | null {
  if (!gdpSeries || gdpSeries.length < 3) return null;
  const n = gdpSeries.length;
  const q1 = (gdpSeries[n - 1] - gdpSeries[n - 2]) / gdpSeries[n - 2];
  const q2 = (gdpSeries[n - 2] - gdpSeries[n - 3]) / gdpSeries[n - 3];
  let phase: string;
  if (q1 < 0 && q2 < 0) phase = 'Contraction';
  else if (q1 < 0) phase = 'Peak (growth just turned negative)';
  else if (q2 < 0) phase = 'Trough (growth resumed after a contraction)';
  else if (q1 >= q2) phase = 'Expansion';
  else phase = 'Peak (growth decelerating, still positive)';
  return {
    phase, latestQGrowth: q1, priorQGrowth: q2,
    read: 'Business-cycle phase: ' + phase + ' (real GDP growth ' + (q1 * 100).toFixed(1)
      + '% latest quarter vs. ' + (q2 * 100).toFixed(1)
      + '% prior — standard 2-consecutive-negative-quarters recession definition, ep.13\'s own named phases)',
  };
}

export interface ZombieScreen {
  readonly isZombie: boolean;
  readonly interestCoverageRatio: number;
  readonly read: string;
}

/**
 * The "zombie company" screen: interest coverage below 1.0.
 *
 * Threshold is the standard academic definition (BIS/Fed research), not
 * invented here.
 *
 * ══ EXACTLY ZERO IS EXCLUDED, AND THAT IS A REAL FIX ═══════════════════
 * A coverage ratio of exactly 0 is a confirmed real AAPL value, and it
 * means near-zero NET interest expense -- a company with enough cash to
 * roughly offset its own interest cost. That is the OPPOSITE of distress,
 * so `!== 0` excludes it from the flag. The "no data" case is already
 * caught by the null guard above, so the two cannot be confused.
 *
 * A NEGATIVE ratio still flows through the `< 1.0` test and flags, because
 * negative EBIT genuinely is distress.
 *
 * The read has three arms, not two: zombie, the exact-zero explanation,
 * and healthy coverage.
 */
export function zombieCompanyScreenV1(
  interestCoverageRatio: number | null | undefined,
): ZombieScreen | null {
  if (interestCoverageRatio == null) return null;
  const isZombie = interestCoverageRatio !== 0 && interestCoverageRatio < 1.0;
  return {
    isZombie, interestCoverageRatio,
    read: isZombie
      ? 'Interest coverage ratio ' + interestCoverageRatio.toFixed(2)
        + ' — below 1.0, earnings don\'t cover interest expense — the standard academic "zombie company" definition (ep.13, real threshold, not invented)'
      : interestCoverageRatio === 0
        ? 'Interest coverage ratio 0.00 — near-zero net interest expense (e.g. large cash reserves offsetting debt), not a zombie-company profile'
        : 'Interest coverage ratio ' + interestCoverageRatio.toFixed(2)
          + ' — earnings cover interest expense, not a zombie-company profile',
  };
}
