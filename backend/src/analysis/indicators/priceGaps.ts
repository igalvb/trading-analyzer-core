/**
 * Price gaps and their classical taxonomy.
 *
 * TWO STAGES, mirroring the legacy structure, which runs them ~1,170 lines
 * apart (detection at 6405, classification at 7576) under SEPARATE try blocks:
 *
 *   1. Detect gaps and resolve their fill status.
 *   2. Enrich each with a `gapType`.
 *
 * The separate guards matter: if stage 2 throws, the gaps still exist with fill
 * status but WITHOUT gapType. That partial shape is real and must be preserved
 * -- merging the two into one guard would change what a failure produces.
 *
 * Verified 2026-09-21: 144/144 charts exact, 712 gap instances, all five
 * gapType values exercised (ISLAND 329, BREAKAWAY 221, COMMON 116, RUNAWAY 43,
 * EXHAUSTION 3), both filled states, plus both optional flags.
 */

import type { Chart } from '../../types/chart.ts';

export type GapInput = Pick<Chart, 'closes' | 'highs' | 'lows' | 'volumes' | 'dates'>;

export type GapType = 'BREAKAWAY' | 'EXHAUSTION' | 'ISLAND' | 'RUNAWAY' | 'COMMON';

export interface PriceGap {
  idx: number;
  date: Date;
  type: 'UP' | 'DOWN';
  /** The level that must be retraced to fill the gap: prior bar's high (UP) or low (DOWN). */
  level: number;
  sizePct: number;
  filled?: boolean;
  gapType?: GapType;
  /** Set only for EXHAUSTION and ISLAND, which cannot be known at gap time. */
  gapTypeHindsightDependent?: boolean;
  /** Set only for ISLAND. */
  meetsStrictValidity?: boolean;
}

/** About three trading months -- keeps the list relevant rather than exhaustive. */
const GAP_LOOKBACK = 60;

const GT_SWING_WINDOW = 5;
const GT_LEVEL_TOLERANCE = 0.03;
const GT_MIN_TOUCHES = 2;
const GT_LOOKBACK = 60;
const GT_ISLAND_WINDOW = 10;

/**
 * Detects gaps in the trailing window and classifies each one.
 *
 * A gap is a true void: an UP gap needs today's LOW above yesterday's HIGH, not
 * merely a higher open. Note the asymmetry in what defines the level -- UP uses
 * the prior high, DOWN the prior low -- because the level is what price must
 * retrace to in order to fill it.
 *
 * Classification order is load-bearing; each branch returns, so earlier tests
 * win. Priority, highest first:
 *
 *   BREAKAWAY  -- the level was previously touched at least twice, so the gap
 *                 escapes an established level. Tested FIRST because a
 *                 breakaway is the most consequential reading.
 *   EXHAUSTION -- highest volume in the window AND the next bar reverses back
 *                 through the level.
 *   ISLAND     -- an opposite-direction gap within 10 bars, isolating a cluster.
 *   RUNAWAY    -- direction-aware trend context: an UP gap near a 52-week high,
 *                 or a DOWN gap in a long-term downtrend.
 *   COMMON     -- everything else.
 *
 * EXHAUSTION and ISLAND are flagged `gapTypeHindsightDependent` because both
 * depend on bars AFTER the gap. They could not have been called at the time and
 * saying so is the honest disclosure -- the flag is not decoration.
 */
export function computePriceGaps(c: GapInput): PriceGap[] {
  const { closes, highs, lows, volumes, dates } = c;
  const n = closes.length;
  const priceGaps: PriceGap[] = [];

  // ── Stage 1: detection and fill status ──────────────────────────────
  try {
    const startIdx = Math.max(1, n - GAP_LOOKBACK);
    for (let i = startIdx; i < n; i++) {
      if ((lows[i] as number) > (highs[i - 1] as number)) {
        priceGaps.push({
          idx: i,
          date: dates[i] as Date,
          type: 'UP',
          level: highs[i - 1] as number,
          sizePct: ((lows[i] as number) - (highs[i - 1] as number)) / (highs[i - 1] as number),
        });
      } else if ((highs[i] as number) < (lows[i - 1] as number)) {
        priceGaps.push({
          idx: i,
          date: dates[i] as Date,
          type: 'DOWN',
          level: lows[i - 1] as number,
          sizePct: ((highs[i] as number) - (lows[i - 1] as number)) / (lows[i - 1] as number),
        });
      }
    }

    // A gap is filled once price trades back THROUGH its level. Uses the
    // intraday extreme, not the close -- touching the level counts.
    priceGaps.forEach((g) => {
      let filled = false;
      for (let j = g.idx + 1; j < n; j++) {
        if (g.type === 'UP' && (lows[j] as number) <= g.level) {
          filled = true;
          break;
        }
        if (g.type === 'DOWN' && (highs[j] as number) >= g.level) {
          filled = true;
          break;
        }
      }
      g.filled = filled;
    });
  } catch {
    /* non-fatal, separate guard -- see the header note */
  }

  // ── Stage 2: gapType classification ────────────────────────────────
  try {
    // Its OWN swing detection, independent of the pattern module's, even though
    // the window size matches. Kept separate so tuning one cannot affect the
    // other -- same isolation the legacy code maintains.
    const gtSwingHighs: Array<{ idx: number; price: number }> = [];
    const gtSwingLows: Array<{ idx: number; price: number }> = [];
    for (let i = GT_SWING_WINDOW; i < n - GT_SWING_WINDOW; i++) {
      const hSlice = highs.slice(i - GT_SWING_WINDOW, i + GT_SWING_WINDOW + 1);
      const lSlice = lows.slice(i - GT_SWING_WINDOW, i + GT_SWING_WINDOW + 1);
      if (highs[i] === Math.max(...hSlice)) gtSwingHighs.push({ idx: i, price: highs[i] as number });
      if (lows[i] === Math.min(...lSlice)) gtSwingLows.push({ idx: i, price: lows[i] as number });
    }

    // Counts only swings strictly BEFORE the bar preceding the gap (idx-1), so
    // the gap's own formation cannot count as a touch of its own level.
    const touchCount = (level: number, swings: Array<{ idx: number; price: number }>, beforeIdx: number): number =>
      swings.filter((s) => s.idx < beforeIdx - 1 && Math.abs(s.price - level) / level <= GT_LEVEL_TOLERANCE).length;

    priceGaps.forEach((g) => {
      // BREAKAWAY: gapping away from a level price has respected before.
      const relevantSwings = g.type === 'UP' ? gtSwingHighs : gtSwingLows;
      if (touchCount(g.level, relevantSwings, g.idx) >= GT_MIN_TOUCHES) {
        g.gapType = 'BREAKAWAY';
        return;
      }

      // EXHAUSTION: climactic volume immediately rejected.
      const windowStart = Math.max(0, g.idx - GT_LOOKBACK);
      const isHighestVol = volumes[g.idx] === Math.max(...volumes.slice(windowStart, g.idx + 1));
      const nextIdx = g.idx + 1;
      const reversedNext =
        nextIdx < n && (g.type === 'UP' ? (closes[nextIdx] as number) < g.level : (closes[nextIdx] as number) > g.level);
      if (isHighestVol && reversedNext) {
        g.gapType = 'EXHAUSTION';
        g.gapTypeHindsightDependent = true;
        return;
      }

      // ISLAND: an opposite-direction gap nearby, isolating the bars between.
      if (
        priceGaps.some((other) => other !== g && other.type !== g.type && Math.abs(other.idx - g.idx) <= GT_ISLAND_WINDOW)
      ) {
        g.gapType = 'ISLAND';
        g.gapTypeHindsightDependent = true;

        // Strict validity is a SEPARATE, stricter bar than detection: both gaps
        // at the same level AND the island never breached in between. Reported
        // alongside, never used to reject the classification.
        const gtOther = priceGaps.find(
          (other) => other !== g && other.type !== g.type && Math.abs(other.idx - g.idx) <= GT_ISLAND_WINDOW,
        );
        if (gtOther) {
          const sameLevel = Math.abs(gtOther.level - g.level) / g.level <= GT_LEVEL_TOLERANCE;
          const between = closes.slice(Math.min(g.idx, gtOther.idx) + 1, Math.max(g.idx, gtOther.idx));
          // An up-gap stays "open" while price never falls back through its level.
          const stayedOpen = g.type === 'UP' ? between.every((v) => v >= g.level) : between.every((v) => v <= g.level);
          g.meetsStrictValidity = sameLevel && stayedOpen;
        }
        return;
      }

      // RUNAWAY: direction-aware trend context, mirroring breakoutContext's own
      // 3% / -30% thresholds but evaluated AT THE GAP rather than today.
      const gapHigh52Start = Math.max(0, g.idx - 251);
      const gapHigh52 = Math.max(...highs.slice(gapHigh52Start, g.idx + 1));
      const gapRoc252 = g.idx >= 252 ? ((closes[g.idx] as number) / (closes[g.idx - 252] as number) - 1) * 100 : null;
      const nearATHAtGap = (closes[g.idx] as number) >= gapHigh52 * 0.97;
      const longTermDowntrendAtGap = !nearATHAtGap && gapRoc252 != null && gapRoc252 < -30;
      if (g.type === 'UP' ? nearATHAtGap : longTermDowntrendAtGap) {
        g.gapType = 'RUNAWAY';
        return;
      }

      g.gapType = 'COMMON';
    });
  } catch {
    /*
     * Separate guard. If this throws, stage 1's gaps survive WITH fill status
     * but WITHOUT gapType -- a real partial shape that callers must tolerate.
     */
  }

  return priceGaps;
}
