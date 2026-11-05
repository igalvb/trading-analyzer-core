/**
 * Wyckoff Accumulation / Distribution schematic.
 *
 * Depends on chartPatterns being populated -- specifically on a RECTANGLE,
 * which is why it returned null on every fixture until RECTANGLE was ported.
 * The two gaps were coupled.
 *
 * Verified 2026-09-20 against the oracle on synthetic flat-range charts:
 * 12/12 checks exact, exercising null, ST, and SOS/SOW stages plus RECTANGLE
 * FORMING and BROKE_UP. NOT verified on real fixtures -- none produces a
 * RECTANGLE, so there is no real-data path through this function.
 */

import type { Chart } from '../../types/chart.ts';
import type { ChartPattern } from './chartPatterns.ts';

/** Same threshold as the climaxVolume field -- deliberately not a second number. */
const WY_CLIMAX_VOL_RATIO = 3.0;
/** Same as RECT_LOOKBACK, reusing that convention directly. */
const WY_TR_LOOKBACK = 60;

export type WyckoffPhase = 'ACCUMULATION' | 'DISTRIBUTION';
export type WyckoffStage = 'ST' | 'SPRING/UPTHRUST' | 'SOS/SOW' | 'LPS/LPSY';

export interface WyckoffSchematic {
  phase: WyckoffPhase;
  stage: WyckoffStage;
  climaxDate: Date;
  resistance: number;
  support: number;
  spring: boolean;
  signOfStrength: boolean;
  read: string;
}

export type WyckoffInput = Pick<Chart, 'dates' | 'closes' | 'highs' | 'lows' | 'volumes'>;

/**
 * Classifies a trading range as a Wyckoff schematic.
 *
 * Requires all of: enough history, a RECTANGLE in chartPatterns, and a volume
 * climax. Any missing piece returns null -- an ordinary range is not a
 * schematic, and saying so is the correct answer.
 *
 * Climax classification uses the close's POSITION WITHIN ITS OWN BAR, not just
 * direction:
 *   Selling Climax  -- closes DOWN but in the upper half (recovered off the low)
 *   Buying Climax   -- closes UP but in the lower half (faded off the high)
 * A bar closing exactly mid-range (position 0.5) matches NEITHER, since both
 * tests are strict. That is real behaviour and worth knowing: it is why a
 * synthetic chart with symmetric bars never produces a climax.
 *
 * ══ FLAGGED FINDING F-07 — reproduced, not fixed ════════════════════════
 * The 'LPS/LPSY' stage is UNREACHABLE. `sosConfirmed` requires volRatio > 1.3,
 * and the lps test inside that branch requires volRatio < 1.0 -- on the SAME
 * value. The conjunction is unsatisfiable, so `lps` is always null and both
 * LPS/LPSY read strings are dead code.
 *
 * Confirmed empirically: a synthetic chart engineered for LPS returns ST.
 * The likely intent was to compare the BREAKOUT-bar volume against a CURRENT
 * volume, i.e. two different values. Reproduced faithfully to hold parity.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function wyckoffSchematic(
  c: WyckoffInput,
  volRatio: number,
  chartPatterns: readonly ChartPattern[] | null,
): WyckoffSchematic | null {
  const { dates, closes, highs, lows, volumes } = c;
  try {
    const n = closes.length;
    if (n < WY_TR_LOOKBACK + 20) return null;

    const rect = (chartPatterns || []).find((p) => p.type === 'RECTANGLE');
    if (!rect) return null; // no trading range -- nothing to classify
    const resistance = rect.resistanceLevel as number;
    const support = rect.supportLevel as number;

    const trStart = Math.max(0, n - WY_TR_LOOKBACK);
    // Scan starts BEFORE the range: the climax that created it precedes it.
    const scanStart = Math.max(1, trStart - 40);
    // Volume baseline is the 50 bars before the scan window, so the climax is
    // measured against pre-range volume rather than range volume.
    const volBaseStart = Math.max(0, scanStart - 50);
    const avgVol =
      volumes.slice(volBaseStart, scanStart).reduce((a, b) => a + b, 0) / Math.max(1, scanStart - volBaseStart);

    let climax: { idx: number; type: 'SC' | 'BC'; date: Date } | null = null;
    for (let i = scanStart; i < n; i++) {
      const range = (highs[i] as number) - (lows[i] as number);
      if (range <= 0) continue;
      const vRatio = avgVol > 0 ? (volumes[i] as number) / avgVol : 0;
      if (vRatio < WY_CLIMAX_VOL_RATIO) continue;
      const closePosInRange = ((closes[i] as number) - (lows[i] as number)) / range;
      // Note: both comparisons strict, so exactly 0.5 matches neither.
      if ((closes[i] as number) < (closes[i - 1] as number) && closePosInRange > 0.5) {
        climax = { idx: i, type: 'SC', date: dates[i] as Date };
        break;
      }
      if ((closes[i] as number) > (closes[i - 1] as number) && closePosInRange < 0.5) {
        climax = { idx: i, type: 'BC', date: dates[i] as Date };
        break;
      }
    }
    if (!climax) return null; // ordinary range, not a Wyckoff schematic

    const phase: WyckoffPhase = climax.type === 'SC' ? 'ACCUMULATION' : 'DISTRIBUTION';

    // Automatic Rally window. Only its EMPTINESS is tested -- the legacy code
    // computes it and never reads the values. Preserved as-is.
    const arWindow = closes.slice(climax.idx + 1, Math.min(n, climax.idx + 11));
    if (!arWindow.length) return null;

    // A Spring/Upthrust is a trap at the opposite range boundary.
    const trapType = phase === 'ACCUMULATION' ? 'BEAR_TRAP' : 'BULL_TRAP';
    const trapLevel = phase === 'ACCUMULATION' ? support : resistance;
    const trap = (chartPatterns || []).find(
      (p) => p.type === trapType && p.level != null && Math.abs((p.level as number) - trapLevel) / trapLevel < 0.05,
    );

    const sosDirection = phase === 'ACCUMULATION' ? 'BROKE_UP' : 'BROKE_DOWN';
    const sosConfirmed = rect.status === sosDirection && volRatio > 1.3;

    // See F-07: this branch can never assign lps.
    let lps: { held: boolean } | null = null;
    if (sosConfirmed) {
      const boundary = phase === 'ACCUMULATION' ? resistance : support;
      const held =
        phase === 'ACCUMULATION'
          ? (closes[n - 1] as number) >= boundary * 0.98
          : (closes[n - 1] as number) <= boundary * 1.02;
      if (held && volRatio < 1.0) lps = { held: true };
    }

    const stage: WyckoffStage = lps ? 'LPS/LPSY' : sosConfirmed ? 'SOS/SOW' : trap ? 'SPRING/UPTHRUST' : 'ST';

    return {
      phase,
      stage,
      climaxDate: climax.date,
      resistance,
      support,
      spring: !!trap,
      signOfStrength: sosConfirmed,
      read:
        phase === 'ACCUMULATION'
          ? 'Wyckoff Accumulation schematic, real stage: ' +
            stage +
            ' — ' +
            (stage === 'LPS/LPSY'
              ? 'markup phase confirmed, real Last Point of Support forming'
              : stage === 'SOS/SOW'
                ? 'real Sign of Strength, breakout through range resistance on real rising volume'
                : stage === 'SPRING/UPTHRUST'
                  ? 'real Spring (false breakdown, reclaimed) — classic final accumulation signature'
                  : 'real trading range with a real Selling Climax, still forming')
          : 'Wyckoff Distribution schematic, real stage: ' +
            stage +
            ' — ' +
            (stage === 'LPS/LPSY'
              ? 'markdown phase confirmed, real Last Point of Supply forming'
              : stage === 'SOS/SOW'
                ? 'real Sign of Weakness, breakdown through range support on real rising volume'
                : stage === 'SPRING/UPTHRUST'
                  ? 'real Upthrust (false breakout, failed) — classic final distribution signature'
                  : 'real trading range with a real Buying Climax, still forming'),
    };
  } catch {
    return null;
  }
}
