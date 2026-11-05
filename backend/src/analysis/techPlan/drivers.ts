/**
 * Tier D: the drivers table and the secular "own for years?" read.
 *
 *   drivers                 inline in computeTechnicalPlanV7  (:2990-3008)
 *   computeSecularReadV7_                                      (:286-308)
 *
 * Both are informational. The end-to-end fingerprint gate measured that:
 * 375 verdicts identical with neither computed. `secular` does reach the
 * decision's rendered output -- it adds the "Secular (own for years?)" line
 * -- which is why the gate had to inject the oracle's value to compare every
 * line. With this module ported, that injection is no longer needed.
 */

import type { Indicators } from '../../types/indicators.ts';
import type { GannRead } from '../gann.ts';
import type { Regime } from './scoring.ts';

export interface Driver {
  readonly label: string;
  readonly value: string;
  readonly note: string;
}

/** The nine trailing-performance windows, in the order legacy renders them. */
const TRAILING_KEYS = [
  'week', 'month', 'quarter', 'halfYear', 'year', 'ytd', 'threeYear', 'fiveYear', 'tenYear',
] as const;

const TRAILING_LABELS: Record<(typeof TRAILING_KEYS)[number], string> = {
  week: '1W', month: '1M', quarter: '3M', halfYear: '6M', year: '1Y',
  ytd: 'YTD', threeYear: '3Y', fiveYear: '5Y', tenYear: '10Y',
};

const MISSING_LONG_RANGE_NOTE =
  '3Y/5Y/10Y (v9.26): dedicated long-range fetch, closes-only, separate from the main 2yr '
  + 'pipeline -- missing values mean either the fetch failed or the ticker has less history '
  + 'than that window (e.g. a recent IPO), not a hard error';

/**
 * The seven-row evidence table shown under the verdict.
 *
 * ══ FLAGGED (F-14): THIS FUNCTION CAN THROW ════════════════════════════
 * The Gann row does `gann.pivot.price.toFixed(2)` with no guard (:3007).
 * computeGannInline builds its pivot from `lows[i]` without checking for a
 * null bar, so `pivot.price` CAN be null -- and when it is, this throws and
 * takes the ENTIRE tech plan with it. Measured: the oracle dies on the _VIX
 * fixture for exactly this reason (182 null bars, pivot lands on one).
 *
 * Reproduced, not fixed. The throw is the legacy behaviour and the pipeline
 * decides what to do about it -- see computeDriversSafe below, which is the
 * port's own addition and changes nothing on the success path.
 *
 * `rsi14` and `adx14` are also dereferenced unguarded. Those are NOT a live
 * risk: measured across fixtures at 20/25/30/40 bars they are always numbers
 * (0, never null), so unlike pivot.price there is no reachable null. Stated
 * because it was checked, not assumed.
 */
export function computeDrivers(ind: Indicators, regime: Regime, gann: GannRead): Driver[] {
  // Hoisted so the null check narrows inside the map callback below --
  // TypeScript loses the narrowing of a property access across a closure.
  const tp = ind.trailingPerf;
  return [
    {
      label: 'RSI(14)',
      value: (ind.rsi14 as number).toFixed(1),
      note: (ind.rsi14 as number) < 30 ? 'oversold' : (ind.rsi14 as number) > 70 ? 'overbought' : 'neutral',
    },
    {
      label: 'ADX(14)',
      value: (ind.adx14 as number).toFixed(1) + (ind.adxBullish ? ' (+DI>-DI)' : ' (-DI>+DI)'),
      note: (ind.adx14 as number) > 25 ? 'trending' : 'weak/sideways',
    },
    {
      label: 'Trend (SMA)',
      value: (ind.above200 ? 'above' : 'below') + ' 200MA, ' + (ind.above50 ? 'above' : 'below') + ' 50MA',
      note: ind.goldenCross ? 'golden cross' : ind.deathCross ? 'death cross' : '',
    },
    {
      label: 'RS vs SPY (3mo)',
      value: ind.rs ? (ind.rs.rs63 >= 0 ? '+' : '') + ind.rs.rs63.toFixed(1) + '%' : 'N/A',
      note: ind.rs
        ? (ind.rs.outperforming ? 'outperforming' : 'underperforming')
        : 'SPY data unavailable',
    },
    {
      label: 'Trailing Performance',
      value: tp
        ? TRAILING_KEYS.map((k) => {
          const v = tp[k];
          // Fractions in, percent out. A null window is dropped entirely
          // rather than rendered as "0%", which would be a lie.
          return v == null ? null : TRAILING_LABELS[k] + ' ' + (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
        }).filter(Boolean).join('  ')
        : 'N/A',
      note: tp && tp.tenYear == null ? MISSING_LONG_RANGE_NOTE : '',
    },
    {
      label: 'Multi-Timeframe',
      value: ind.weeklyTrend ? 'Daily: ' + regime + ' / Weekly: ' + ind.weeklyTrend : 'N/A',
      // Daily-vs-weekly agreement. Nothing checked this before it was added.
      note: (() => {
        if (!ind.weeklyTrend) return 'insufficient history for the 40-week comparison';
        if (regime === 'CHOP') return 'daily is choppy, nothing to compare';
        const dailyDir = regime === 'TREND_UP' ? 'UP' : 'DOWN';
        return dailyDir === ind.weeklyTrend
          ? 'AGREE -- daily move is confirmed by the larger weekly trend'
          : 'DISAGREE -- daily move runs against the larger weekly trend, treat with caution';
      })(),
    },
    {
      label: 'Gann',
      value: gann.score + '/100',
      // F-14 lives on this line. See the function doc.
      note: 'pivot ' + gann.pivot.dateStr + ' @ $' + gann.pivot.price.toFixed(2),
    },
  ];
}

/**
 * computeDrivers, but a thrown F-14 yields null instead of killing the run.
 *
 * NOT a behaviour change on the success path -- it calls the same function
 * and returns the same array. It only decides what happens on the failure
 * path that legacy leaves fatal, and it is the pipeline's choice to use it.
 * The report then shows the verdict without the evidence table rather than
 * showing nothing at all, which is what legacy does for _VIX today.
 */
export function computeDriversSafe(
  ind: Indicators,
  regime: Regime,
  gann: GannRead,
  onError?: (cause: unknown) => void,
): Driver[] | null {
  try {
    return computeDrivers(ind, regime, gann);
  } catch (cause) {
    onError?.(cause);
    return null;
  }
}

export interface SecularRead {
  readonly verdict: string;
  readonly why: string;
  readonly cagr: number | null;
  readonly aboveWk200: boolean;
  readonly pctVsWk200: number;
  readonly yearsAvailable: number;
}

/**
 * The long-term "own for years?" read -- deliberately separate from the
 * tactical BUY-TIMING engine.
 *
 * Two inputs: multi-year CAGR, and price against the 200-WEEK SMA
 * (approximated as the last 1000 trading days, falling back to the whole
 * series when shorter and saying "(limited history)" when it does).
 *
 * ══ TWO THINGS WORTH KNOWING BEFORE READING THE VERDICT ════════════════
 * 1. CAGR IS FIRST-TO-LAST CLOSE. It is not risk-adjusted and not drawdown-
 *    aware, so a stock that round-tripped a 300% run scores on where it
 *    started and ended, nothing in between. That is what the legacy
 *    function computes and it is reproduced exactly.
 * 2. `years` IS DERIVED FROM BAR COUNT (`closes.length / 252`), not from the
 *    actual date range. A series with gaps therefore reports fewer years
 *    than it spans, which inflates CAGR. Reproduced as found.
 *
 * The verdict ladder is checked in order, and `!aboveWk200` short-circuits
 * to NO before the MIXED arm can ever see it -- so MIXED means "above the
 * long-term trend but weak return", never "below it".
 */
export function computeSecularRead(closes: readonly number[] | null | undefined): SecularRead | null {
  if (!Array.isArray(closes) || closes.length < 60) return null;
  const first = closes[0];
  const last = closes[closes.length - 1];
  if (!(first > 0) || !(last > 0)) return null;

  const years = closes.length / 252;
  const cagr = years > 0 ? (Math.pow(last / first, 1 / years) - 1) * 100 : null;

  const wk200Window = closes.slice(-1000);
  const wk200Sma = wk200Window.reduce((a, b) => a + b, 0) / wk200Window.length;
  const aboveWk200 = last >= wk200Sma;
  const pctVsWk200 = wk200Sma > 0 ? ((last - wk200Sma) / wk200Sma) * 100 : 0;

  let verdict: string;
  if (cagr != null && cagr >= 12 && aboveWk200) verdict = 'YES — durable uptrend';
  else if (cagr != null && cagr >= 5 && aboveWk200) verdict = 'MAYBE — modest secular trend';
  else if (!aboveWk200) verdict = 'NO — below long-term trend';
  else verdict = 'MIXED — weak long-term return';

  const why =
    (cagr != null ? cagr.toFixed(1) + '%/yr over ~' + years.toFixed(1) + 'y' : 'CAGR n/a')
    + ', ' + (aboveWk200 ? 'above' : 'below') + ' 200-week SMA by ' + Math.abs(pctVsWk200).toFixed(0) + '%'
    + (closes.length < 1000 ? ' (limited history)' : '');

  return { verdict, why, cagr, aboveWk200, pctVsWk200, yearsAvailable: years };
}
