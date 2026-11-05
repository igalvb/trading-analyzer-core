/**
 * Gann fan angles, Square-of-9 levels, and the Gann structure score.
 *
 * Verified 2026-09-21: 144/144 charts exact. Branch coverage: 5 of 6 score
 * tiers (35/45/55/68/85), 8 distinct lowerAngle and upperAngle labels including
 * both "below all" and "above all", both pivot volOk states, and 54
 * fallback-pivot cases.
 *
 * The missing score tier is F-09 below -- not a coverage gap in the tests but a
 * branch that cannot fire on self-consistent data.
 */

import type { Chart } from '../types/chart.ts';

export type GannInput = Pick<Chart, 'closes' | 'highs' | 'lows' | 'volumes' | 'dates' | 'currentPrice'>;

export interface GannAngle {
  label: string;
  ratio: number;
}

export interface GannFanLevel {
  level: number;
  above: boolean;
  pct: number;
  ratio: number;
}

export interface GannPivot {
  idx: number;
  price: number;
  date: Date;
  daysAgo: number;
  volOk: boolean;
  swing: number;
  dateStr: string;
}

export interface GannRead {
  pivot: GannPivot;
  priceUnit: number;
  fan: Record<string, GannFanLevel>;
  lowerAngle: string;
  upperAngle: string;
  gannSupport: number | null;
  gannResistance: number | null;
  gannMaster: number | null;
  sq9above: number | null;
  sq9below: number | null;
  score: number;
  ANGLES: GannAngle[];
}

/**
 * The nine classical Gann fan ratios, steepest to shallowest.
 *
 * Labels use the MULTIPLICATION SIGN (U+00D7), not the letter x. They are
 * object keys in `fan` and are returned verbatim, so substituting an ASCII x
 * breaks parity.
 */
const ANGLES: readonly GannAngle[] = [
  { label: '8×1', ratio: 8 },
  { label: '4×1', ratio: 4 },
  { label: '3×1', ratio: 3 },
  { label: '2×1', ratio: 2 },
  { label: '1×1', ratio: 1 },
  { label: '1×2', ratio: 0.5 },
  { label: '1×3', ratio: 1 / 3 },
  { label: '1×4', ratio: 0.25 },
  { label: '1×8', ratio: 0.125 },
];

/**
 * Computes the Gann read from a chart.
 *
 * NOTE ON THE SIGNATURE: the legacy function is computeGannInline(chart, ind)
 * but `ind` is never referenced in its body -- verified by direct grep, it
 * appears only in the parameter list. The port drops it rather than carrying a
 * parameter that does nothing. Callers passing it will simply have the argument
 * ignored, exactly as before.
 *
 * THE PRICE UNIT is the scale of the whole fan: half the 20-bar ATR, then
 * rounded to a "nice" increment on a sliding scale (nearest 5 above $10,
 * nearest 1 above $2, nearest quarter above $0.50, nearest cent below that).
 * The rounding bands mean two stocks with similar volatility but different
 * absolute prices get differently-grained fans -- deliberate, since Gann angles
 * are meant to be drawn on a readable grid.
 *
 * PIVOT SELECTION scores candidates by swing size, with a 1.3x bonus for
 * above-average volume at the pivot. Candidates must be a local minimum over a
 * +/-10 bar window AND at least 12% below current price. When nothing
 * qualifies, it falls back to the absolute lowest low in the window -- which
 * happened on 54 of 144 test charts, so the fallback is a normal path, not an
 * edge case.
 *
 * ══ FLAGGED FINDING F-09 — reproduced, not fixed ════════════════════════
 * The gannScore=18 tier ("falling since the pivot") is effectively unreachable.
 * It needs velocityRatio < 0, i.e. currentPrice < pivot.price. But the main
 * search requires the pivot be >=12% BELOW current price, and the fallback
 * takes the minimum low over a range INCLUDING the final bar -- and any bar's
 * low is <= its close. So with self-consistent data velocityRatio >= 0 always.
 *
 * Unlike F-07 this is CONDITIONALLY reachable: in production chart.currentPrice
 * is a live quote while `lows` comes from a possibly-staler bar array, and a
 * quote below the stored lows would reach it. Confirmed dead across 144 fixture
 * charts. Reproduced to hold parity.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function computeGann(chart: GannInput): GannRead {
  const { closes, highs, lows, volumes, dates } = chart;
  const n = closes.length;
  const cp = chart.currentPrice;

  // True Range, then ATR(20). Note the divisor is min(20, length) so a short
  // series averages over what exists rather than under-reporting.
  const trArr: number[] = [];
  for (let i = 1; i < n; i++) {
    trArr.push(
      Math.max(
        (highs[i] as number) - (lows[i] as number),
        Math.abs((highs[i] as number) - (closes[i - 1] as number)),
        Math.abs((lows[i] as number) - (closes[i - 1] as number)),
      ),
    );
  }
  const atr20 = trArr.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, trArr.length);

  // Sliding-scale rounding -- coarser grid at higher prices.
  let priceUnit = atr20 / 2;
  if (priceUnit >= 10) priceUnit = Math.round(priceUnit / 5) * 5;
  else if (priceUnit >= 2) priceUnit = Math.round(priceUnit);
  else if (priceUnit >= 0.5) priceUnit = Math.round(priceUnit * 4) / 4;
  else priceUnit = Math.round(priceUnit * 100) / 100;
  if (priceUnit === 0) priceUnit = 1; // a zero unit would collapse the entire fan

  const lookback = Math.min(252, n - 20);
  const start = n - lookback;
  // Volume baseline from the FIRST 20 bars of the window, not the last -- so the
  // pivot's volume is judged against conditions around when it formed.
  const vol20avg = volumes.slice(start, start + 20).reduce((a, b) => a + b, 0) / 20 || 1;

  const window = 10;
  let pivot: Omit<GannPivot, 'dateStr'> | null = null;
  let bestScore = 0;

  for (let i = start + window; i < n - window; i++) {
    const low = lows[i] as number;
    // Local minimum over +/-10 bars. Non-strict (>=), so a tie still qualifies.
    const isMin = Array.from({ length: window * 2 }, (_, k) => k - window + i)
      .filter((j) => j !== i && j >= 0 && j < n)
      .every((j) => (lows[j] as number) >= low);
    if (!isMin) continue;

    const swing = (cp - low) / low;
    if (swing < 0.12) continue; // must be a meaningful advance off the pivot

    const volOk = (volumes[i] as number) > vol20avg * 0.8;
    const sc = swing * (volOk ? 1.3 : 1.0); // volume confirmation is a 30% bonus
    if (sc > bestScore) {
      bestScore = sc;
      pivot = { idx: i, price: low, date: dates[i] as Date, daysAgo: n - 1 - i, volOk, swing };
    }
  }

  if (!pivot) {
    // Fallback: the absolute lowest low. A normal path, not an edge case --
    // 54 of 144 verification charts took it.
    let minIdx = Math.min(start, n - 1);
    let minVal = lows[minIdx] as number;
    for (let i = minIdx + 1; i < n; i++) {
      if ((lows[i] as number) < minVal) {
        minVal = lows[i] as number;
        minIdx = i;
      }
    }
    pivot = {
      idx: minIdx,
      price: lows[minIdx] as number,
      date: dates[minIdx] as Date,
      daysAgo: n - 1 - minIdx,
      volOk: false, // never volume-confirmed on the fallback path
      swing: (cp - (lows[minIdx] as number)) / (lows[minIdx] as number),
    };
  }

  /**
   * LOCALE-DEPENDENT FORMATTING, flagged. toLocaleDateString depends on the
   * runtime's ICU data, so this string could differ across Node builds or a
   * small-icu build. Parity holds here because port and oracle share one
   * process -- but this is the only indicator-layer output whose exact value
   * depends on the ICU build rather than on arithmetic. If a report ever shows
   * an unexpected date format, this is the reason.
   */
  const dateStr = pivot.date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const fullPivot: GannPivot = { ...pivot, dateStr };

  // Each angle projects from the pivot at ratio x priceUnit per elapsed day.
  const fan: Record<string, GannFanLevel> = {};
  ANGLES.forEach((a) => {
    const level = fullPivot.price + a.ratio * priceUnit * fullPivot.daysAgo;
    fan[a.label] = { level, above: level > cp, pct: ((level - cp) / cp) * 100, ratio: a.ratio };
  });

  // Nearest angle on each side: below sorted descending, above ascending.
  const below = ANGLES.filter((a) => !(fan[a.label] as GannFanLevel).above).sort(
    (a, b) => (fan[b.label] as GannFanLevel).level - (fan[a.label] as GannFanLevel).level,
  );
  const above = ANGLES.filter((a) => (fan[a.label] as GannFanLevel).above).sort(
    (a, b) => (fan[a.label] as GannFanLevel).level - (fan[b.label] as GannFanLevel).level,
  );
  const lowerAngle = below.length > 0 ? (below[0] as GannAngle).label : 'below all';
  const upperAngle = above.length > 0 ? (above[0] as GannAngle).label : 'above all';

  const master = fan['1×1'];

  /**
   * The score compares REALIZED advance per day against the 1x1 angle's pace.
   * A velocityRatio of 1.0 means price has tracked the 1x1 exactly -- Gann's
   * balance line between time and price.
   */
  const realizedPerDay = fullPivot.daysAgo > 0 ? (cp - fullPivot.price) / fullPivot.daysAgo : 0;
  const velocityRatio = priceUnit > 0 ? realizedPerDay / priceUnit : 0;

  let score: number;
  if (velocityRatio >= 1.2) score = 85; // outpacing the 1x1
  else if (velocityRatio >= 0.9) score = 68; // tracking it
  else if (velocityRatio >= 0.6) score = 55; // advancing, slower
  else if (velocityRatio >= 0.3) score = 45; // slow advance
  else if (velocityRatio >= 0) score = 35; // flat since pivot
  else score = 18; // see F-09 -- effectively unreachable

  /**
   * Square of 9: levels at squared half-step increments of the pivot's square
   * root. Asymmetric range (-8 to +16) so more levels sit above the pivot than
   * below, which suits an advance off a low. k=0 is skipped -- that would be the
   * pivot itself.
   */
  const root = Math.sqrt(fullPivot.price);
  const step = 0.5;
  const sq9levels: number[] = [];
  for (let k = -8; k <= 16; k++) {
    if (k === 0) continue;
    const v = Math.pow(root + k * step, 2);
    if (v > 0) sq9levels.push(Math.round(v * 100) / 100);
  }
  sq9levels.sort((a, b) => a - b);

  return {
    pivot: fullPivot,
    priceUnit,
    fan,
    lowerAngle,
    upperAngle,
    gannSupport: below.length > 0 ? (fan[(below[0] as GannAngle).label] as GannFanLevel).level : null,
    gannResistance: above.length > 0 ? (fan[(above[0] as GannAngle).label] as GannFanLevel).level : null,
    gannMaster: master ? master.level : null,
    sq9above: sq9levels.filter((v) => v > cp)[0] ?? null,
    sq9below: sq9levels.filter((v) => v < cp).slice(-1)[0] ?? null,
    score,
    // Returned so callers can iterate the fan in canonical steepest-first order
    // rather than relying on object key order.
    ANGLES: [...ANGLES],
  };
}
