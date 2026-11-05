/**
 * Wyckoff -- the original Wyckoff method as a model of its own (owner 2026-10-28). NEW logic, not a legacy
 * port: the standard Wyckoff accumulation and distribution schematics, phases A to E, with every event made
 * measurable on daily bars. The rules and their numbers are written out in docs/WYCKOFF_MODEL_SPEC.md.
 *
 * Causal by construction: one forward pass; what the model says on day i uses bars 0..i only, so the same
 * function serves the nightly read (its last day) and the simulation (every day).
 *
 * Accumulation (after a decline):  SC selling climax -> AR automatic rally (sets the range top) -> ST secondary
 *   test -> (phase B) -> Spring below the range low that closes back inside -> Test on lower volume (phase C)
 *   -> SOS sign of strength, a high-volume close above the range top (phase D) -> LPS last point of support /
 *   back-up near the old top on light volume -> markup (phase E).
 * Distribution (after an advance): BC buying climax -> AR down -> ST -> UTAD upthrust after distribution ->
 *   SOW sign of weakness, a high-volume close below the range low -> LPSY last point of supply -> markdown.
 */

export type WyckoffDirection = 'bullish' | 'mixed' | 'cautionary';
export type WyckoffEvent = 'SC' | 'AR' | 'ST' | 'SPRING' | 'TEST' | 'SOS' | 'LPS' | 'BC' | 'AR-D' | 'ST-D' | 'UTAD' | 'SOW' | 'LPSY' | 'FAILED';
export type WyckoffPhase = 'A' | 'B' | 'C' | 'D' | 'E';

export interface WyckoffBars {
  readonly opens: readonly number[]; readonly highs: readonly number[]; readonly lows: readonly number[];
  readonly closes: readonly number[]; readonly volumes: readonly number[];
}

export interface WyckoffDay {
  readonly direction: WyckoffDirection;
  /** 'accumulation' | 'markup' | 'distribution' | 'markdown' | null */
  readonly context: 'accumulation' | 'markup' | 'distribution' | 'markdown' | null;
  readonly phase: WyckoffPhase | null;
  /** The event that happened on this very day, if any. */
  readonly event: WyckoffEvent | null;
  /** The trading range (support = climax low / high side, resistance = AR), when one is open. */
  readonly support: number | null;
  readonly resistance: number | null;
}

/** The numbers of the spec (docs/WYCKOFF_MODEL_SPEC.md). */
export const WY = {
  trendBars: 60, trendMove: 0.15,       // a prior decline / advance of 15% over 60 bars
  volAvgBars: 50, spreadAvgBars: 20,
  climaxVol: 2.0, climaxSpread: 1.5,    // climax bar: volume >= 2x, range >= 1.5x average, extreme of 60 bars
  arMinBars: 3, arPullback: 0.03,       // AR is confirmed once price backs off 3% from its peak, 3+ bars after the climax
  stNear: 0.03,                         // ST: within 3% of the climax extreme, on less volume than the climax
  breakVol: 1.5,                        // SOS / SOW: close beyond the range on volume >= 1.5x average
  testBars: 15,                         // a spring's (or UTAD's) test must come within 15 bars
  lpsNear: 0.03,                        // LPS / LPSY: back to within 3% of the broken level, on below-average volume
  failBelow: 0.03,                      // a range is broken the wrong way: close 3% beyond it on average-or-more volume
  maxRangeBars: 300,                    // a range that resolves nowhere in 300 bars is dropped
  // markdown ends on a new 60-bar high (the decline is over without a new climax)
  exitBelowLps: 0.05,                   // markup ends on a close 5% under the LPS / old range top
} as const;

function sma(xs: readonly number[], n: number, i: number): number {
  const from = Math.max(0, i - n + 1);
  let s = 0;
  for (let k = from; k <= i; k++) s += xs[k] as number;
  return s / (i - from + 1);
}

interface Range {
  kind: 'acc' | 'dis';
  start: number; climaxIdx: number; climaxPrice: number; climaxVol: number;
  peak: number; peakIdx: number;
  /** acc: AR high (top); dis: AR low (bottom). Null until the AR is confirmed. */
  ar: number | null;
  st: boolean;
  /** The bar of the secondary test (a spring must come on a later bar: phase B lies between them). */
  stIdx: number;
  probeIdx: number | null; probePrice: number | null; probeVol: number;  // spring / UTAD
  tested: boolean;
  broke: boolean;  // SOS / SOW done
}

/** The model's read for every day, from one causal pass. */
export function wyckoffClassicSeries(b: WyckoffBars): WyckoffDay[] {
  const { opens: O, highs: H, lows: L, closes: C, volumes: V } = b;
  const n = C.length;
  const out: WyckoffDay[] = [];
  let acc: Range | null = null, dis: Range | null = null;
  let trend: 'markup' | 'markdown' | null = null, trendRef = 0;
  const S = H.map((x, k) => x - (L[k] as number));
  for (let i = 0; i < n; i++) {
    const c = C[i] as number, h = H[i] as number, l = L[i] as number, v = V[i] as number, o = O[i] as number;
    const avgV = sma(V, WY.volAvgBars, i), avgS = i > 0 ? sma(S, WY.spreadAvgBars, i - 1) : h - l;
    const spread = h - l;
    let event: WyckoffEvent | null = null;
    const back = i >= WY.trendBars ? (C[i - WY.trendBars] as number) : null;
    let low60 = Infinity, high60 = -Infinity;
    for (let k = Math.max(0, i - WY.trendBars + 1); k <= i; k++) { low60 = Math.min(low60, L[k] as number); high60 = Math.max(high60, H[k] as number); }
    const climaxBar = v >= WY.climaxVol * avgV && spread >= WY.climaxSpread * avgS;

    // ── new ranges start at a climax ──
    if (!acc && back != null && c <= back * (1 - WY.trendMove) && l <= low60 && climaxBar) {
      acc = { kind: 'acc', start: i, climaxIdx: i, climaxPrice: l, climaxVol: v, peak: h, peakIdx: i, ar: null, st: false, stIdx: -1, probeIdx: null, probePrice: null, probeVol: 0, tested: false, broke: false };
      event = 'SC'; if (trend === 'markdown') trend = null;
    } else if (!dis && back != null && c >= back * (1 + WY.trendMove) && h >= high60 && climaxBar) {
      dis = { kind: 'dis', start: i, climaxIdx: i, climaxPrice: h, climaxVol: v, peak: l, peakIdx: i, ar: null, st: false, stIdx: -1, probeIdx: null, probePrice: null, probeVol: 0, tested: false, broke: false };
      event = 'BC';
    }

    // ── accumulation range ──
    if (acc && acc.start < i) {
      const r = acc;
      if (r.ar == null) {
        if (h > r.peak) { r.peak = h; r.peakIdx = i; }
        if (i - r.climaxIdx >= WY.arMinBars && c <= r.peak * (1 - WY.arPullback) && r.peak > r.climaxPrice * 1.03) { r.ar = r.peak; event ??= 'AR'; }
      } else if (!r.broke) {
        const support = r.climaxPrice, top = r.ar;
        if (!r.st && l <= support * (1 + WY.stNear) && l >= support * (1 - WY.stNear) && v < r.climaxVol) { r.st = true; r.stIdx = i; event ??= 'ST'; }
        if (r.st && i > r.stIdx && r.probeIdx == null && l < support && c >= support) { r.probeIdx = i; r.probePrice = l; r.probeVol = v; event ??= 'SPRING'; }
        else if (r.probeIdx != null && !r.tested && i - r.probeIdx <= WY.testBars && i > r.probeIdx && l > (r.probePrice as number) && l <= support * (1 + WY.stNear) && v < r.probeVol) { r.tested = true; event ??= 'TEST'; }
        if (c > top && v >= WY.breakVol * avgV) { r.broke = true; event = 'SOS'; trend = 'markup'; trendRef = top; }
        else if (c < support * (1 - WY.failBelow) && v >= avgV && !(r.probeIdx != null && i - r.probeIdx <= 2)) { event = 'FAILED'; acc = null; trend = 'markdown'; }
        else if (i - r.start > WY.maxRangeBars) acc = null;
      } else {
        // after the SOS: an LPS / back-up near the old top on light volume, an up close
        if (l <= (r.ar as number) * (1 + WY.lpsNear) && l >= r.climaxPrice && v < avgV && c > o) { event ??= 'LPS'; trendRef = Math.max(trendRef, l); }
        if (c > (r.ar as number) * 1.1 || i - r.start > WY.maxRangeBars) acc = null;
      }
    }

    // ── distribution range ──
    if (dis && dis.start < i) {
      const r = dis;
      if (r.ar == null) {
        if (l < r.peak) { r.peak = l; r.peakIdx = i; }
        if (i - r.climaxIdx >= WY.arMinBars && c >= r.peak * (1 + WY.arPullback) && r.peak < r.climaxPrice * 0.97) { r.ar = r.peak; event ??= 'AR-D'; }
      } else if (!r.broke) {
        const top = r.climaxPrice, bottom = r.ar;
        if (!r.st && h >= top * (1 - WY.stNear) && h <= top * (1 + WY.stNear) && v < r.climaxVol) { r.st = true; r.stIdx = i; event ??= 'ST-D'; }
        if (r.st && i > r.stIdx && r.probeIdx == null && h > top && c <= top) { r.probeIdx = i; r.probePrice = h; r.probeVol = v; event = 'UTAD'; }
        if (c < bottom && v >= WY.breakVol * avgV) { r.broke = true; event = 'SOW'; trend = 'markdown'; }
        else if (c > top * (1 + WY.failBelow) && v >= avgV) { dis = null; }
        else if (i - r.start > WY.maxRangeBars) dis = null;
      } else {
        if (h >= (r.ar as number) * (1 - WY.lpsNear) && h <= r.climaxPrice && v < avgV && c < o) event ??= 'LPSY';
        if (c < (r.ar as number) * 0.9 || i - r.start > WY.maxRangeBars) dis = null;
      }
    }

    // ── markup ends on a close well under the LPS / old top; markdown ends when price makes a new 60-bar high ──
    if (trend === 'markup' && c < trendRef * (1 - WY.exitBelowLps)) trend = null;
    if (trend === 'markdown' && h >= high60 && event == null) trend = null;

    // ── the day's read ──
    const bearishEvent = event === 'UTAD' || event === 'SOW' || event === 'LPSY' || event === 'FAILED';
    const accSetup = acc && !acc.broke && acc.probeIdx != null && acc.tested; // spring + test: phase C done
    let direction: WyckoffDirection = 'mixed';
    if (bearishEvent || trend === 'markdown' || (dis && dis.probeIdx != null)) direction = 'cautionary';
    else if (trend === 'markup' || accSetup) direction = 'bullish';
    const context = trend === 'markup' ? 'markup' : trend === 'markdown' ? 'markdown' : acc ? 'accumulation' : dis ? 'distribution' : null;
    const rng = acc ?? dis;
    const phase: WyckoffPhase | null = trend === 'markup' && !acc ? 'E'
      : rng == null ? null
      : rng.broke ? 'D' : rng.probeIdx != null ? 'C' : rng.ar != null && rng.st ? 'B' : 'A';
    out.push({
      direction, context, phase, event,
      support: rng ? (rng.kind === 'acc' ? rng.climaxPrice : rng.ar) : null,
      resistance: rng ? (rng.kind === 'acc' ? rng.ar : rng.climaxPrice) : null,
    });
  }
  return out;
}

/** The last day's read, in plain words, for the report tab. */
export function wyckoffClassicRead(b: WyckoffBars, dates: readonly string[]): { day: WyckoffDay | null; lines: string[] } {
  const s = wyckoffClassicSeries(b);
  const day = s[s.length - 1] ?? null;
  const events: string[] = [];
  for (let i = Math.max(0, s.length - 260); i < s.length; i++) if (s[i]!.event) events.push(dates[i] + ' ' + s[i]!.event);
  const lines = day ? [
    'Direction: ' + day.direction + (day.context ? ' (' + day.context + (day.phase ? ', phase ' + day.phase : '') + ')' : ' (no Wyckoff range found)'),
    day.support != null && day.resistance != null ? 'Trading range: $' + day.support.toFixed(2) + ' to $' + day.resistance.toFixed(2) : 'No open trading range',
    'Events in the last year: ' + (events.length ? events.slice(-8).join(', ') : 'none'),
  ] : ['Not enough price history.'];
  return { day, lines };
}
