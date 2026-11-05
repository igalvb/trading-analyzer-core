/**
 * G1, the layer engine of James — LILO v2 (docs/models/plans/01-lilo-v2-original-layers.md, master plan section 4).
 *
 * James's IA-LILO-Model [1.2] (InvestAnswers) draws 11 fixed levels above an anchor, recovered exactly from six of his
 * screenshots (docs/models/sources/A-lilo-profit-taking.md):
 *
 *   L_k = L0 + u * m_k,  k = 0..10,  m = golden-ratio multiples (LAYER_MULTIPLIERS)
 *   L0  = the close of the anchor bar: a day the close crosses up through the 200-day simple average (S1)
 *   u   = the layer unit (L0 -> L4). Proprietary: estimated by the surrogates U1-U4 (plan P2, owner default D1)
 *
 * Layers 0-5 are the layer-in zone, 6-10 the layer-out zone. Pure and causal: the layers on bar i use bars up to i
 * only (U4 measures u on the 63 bars after the anchor, so it needs an anchor at least 63 bars old). Used by the
 * research book (research/liloV2Book.ts), the profit-taking overlay (models/profitTaking.ts), the report pages and the
 * paper test. Display and research only: nothing here feeds a score.
 */

const PHI = (1 + Math.sqrt(5)) / 2;

/** m_k: 0, 1 - 1/phi, 1/phi, (1 + 1/phi)/2, 1, sqrt(phi), phi, phi^2, phi^3, phi^3 + phi, phi^3 + phi + 1. */
export const LAYER_MULTIPLIERS: readonly number[] = [0, 1 - 1 / PHI, 1 / PHI, (1 + 1 / PHI) / 2, 1, Math.sqrt(PHI), PHI, PHI ** 2, PHI ** 3, PHI ** 3 + PHI, PHI ** 3 + PHI + 1];
/** Layers 0-5: the layer-in (buy) zone; 6-10: the layer-out (sell) zone (S3). */
export const BUY_ZONE_TOP = 5;
export const SMA_DAYS = 200;
/** U4 measures u on this many bars after the anchor (a member's "approx 3 months of data"). */
export const U4_BARS = 63;

/**
 * P1 anchor rules. A1 (default): the latest up-cross at least `minAge` bars old (else the one before). A2: the latest
 * up-cross, adopted by a held position only once it is flat (the book's reading of "latest up-cross, no age rule").
 * A3: the latest up-cross, adopted at once by held shares too ("re-anchor at every new up-cross").
 */
export type AnchorRule = 'A1' | 'A2' | 'A3';
/** P2 unit surrogates: U1 k x population SD of the last 50 closes at the anchor; U2 k x L0; U3 k x the 20-day average true range at the anchor; U4 k x the SD of the 63 closes after it. */
export type UnitRule = 'U1' | 'U2' | 'U3' | 'U4';

export interface LayerOptions {
  readonly anchor: AnchorRule;
  /** A1's minimum anchor age in bars (63; 42 and 84 tested). */
  readonly minAge: number;
  readonly unit: UnitRule;
  /** The surrogate's multiple (U1 5, U2 c = 0.30, U3 7.5, U4 5). */
  readonly k: number;
}

/** The pre-registered default (plan 01 section 6): A1-63, U1 k = 5. */
export const DEFAULT_LAYER_OPTIONS: LayerOptions = { anchor: 'A1', minAge: 63, unit: 'U1', k: 5 };

export interface LayerBars {
  readonly closes: readonly number[];
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly dates?: readonly string[];
}

export interface LayerSet {
  readonly anchorIndex: number;
  readonly anchorDate: string | null;
  readonly L0: number;
  readonly u: number;
  /** The 11 layer prices, L0 .. L10. */
  readonly levels: readonly number[];
}

/** Levels from L0 and u (S2). */
export function layerPrices(L0: number, u: number): number[] {
  return LAYER_MULTIPLIERS.map((m) => L0 + u * m);
}

/** The simple average of the last `n` closes at each bar (null before bar n - 1). */
export function smaSeries(closes: readonly number[], n: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i] as number;
    if (i >= n) sum -= closes[i - n] as number;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

const crossCache = new WeakMap<readonly number[], Map<number, number[]>>();
/** Bars whose close is above the n-day simple average while the previous close was at or under its own (S1). */
export function upCrosses(closes: readonly number[], n = SMA_DAYS): number[] {
  let byN = crossCache.get(closes);
  if (!byN) { byN = new Map(); crossCache.set(closes, byN); }
  const hit = byN.get(n);
  if (hit) return hit;
  const s = smaSeries(closes, n), out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = s[i], b = s[i - 1];
    if (a != null && b != null && (closes[i] as number) > a && (closes[i - 1] as number) <= b) out.push(i);
  }
  byN.set(n, out);
  return out;
}

/** The anchor used on bar i, or -1. U4 needs the anchor at least U4_BARS old whatever the rule (A2/A3: no layers until then). */
export function pickAnchor(crosses: readonly number[], i: number, rule: AnchorRule, minAge: number, unit: UnitRule = 'U1'): number {
  let k = -1;
  for (let lo = 0, hi = crosses.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if ((crosses[m] as number) <= i) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return -1;
  if (rule === 'A1') {
    const age = Math.max(minAge, unit === 'U4' ? U4_BARS : 0);
    while (k >= 0 && i - (crosses[k] as number) < age) k--;
    return k < 0 ? -1 : (crosses[k] as number);
  }
  const c = crosses[k] as number;
  return unit === 'U4' && i - c < U4_BARS ? -1 : c;
}

const pstdev = (xs: readonly number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

/** The layer unit u for an anchor bar (null when the bars are too few). */
export function layerUnit(b: LayerBars, anchor: number, unit: UnitRule, k: number): number | null {
  const c = b.closes;
  if (unit === 'U1') return anchor >= 49 ? k * pstdev(c.slice(anchor - 49, anchor + 1)) : null;
  if (unit === 'U2') return k * (c[anchor] as number);
  if (unit === 'U3') {
    if (anchor < 20) return null;
    let s = 0;
    for (let j = anchor - 19; j <= anchor; j++) {
      const h = b.highs[j] as number, l = b.lows[j] as number, pc = c[j - 1] as number;
      s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    return k * (s / 20);
  }
  return anchor + U4_BARS < c.length ? k * pstdev(c.slice(anchor + 1, anchor + 1 + U4_BARS)) : null;
}

function setFor(b: LayerBars, anchor: number, o: LayerOptions): LayerSet | null {
  const u = layerUnit(b, anchor, o.unit, o.k);
  if (u == null || !(u > 0)) return null;
  const L0 = b.closes[anchor] as number;
  return { anchorIndex: anchor, anchorDate: b.dates ? (b.dates[anchor] as string) : null, L0, u, levels: layerPrices(L0, u) };
}

/** The layers in force on bar i (from bars 0..i only), or null when there is no usable anchor. */
export function layersAt(b: LayerBars, i: number, o: LayerOptions = DEFAULT_LAYER_OPTIONS): LayerSet | null {
  if (i < 0 || i >= b.closes.length) return null;
  const a = pickAnchor(upCrosses(b.closes), i, o.anchor, o.minAge, o.unit);
  return a < 0 ? null : setFor(b, a, o);
}

const timelineCache = new WeakMap<readonly number[], Map<string, Array<LayerSet | null>>>();
/** layersAt for every bar, one shared object per anchor (computed once per series and options). */
export function layerTimeline(b: LayerBars, o: LayerOptions = DEFAULT_LAYER_OPTIONS): ReadonlyArray<LayerSet | null> {
  let m = timelineCache.get(b.closes);
  if (!m) { m = new Map(); timelineCache.set(b.closes, m); }
  const key = o.anchor + '|' + o.minAge + '|' + o.unit + '|' + o.k;
  const hit = m.get(key);
  if (hit) return hit;
  const crosses = upCrosses(b.closes), out: Array<LayerSet | null> = [];
  const byAnchor = new Map<number, LayerSet | null>();
  for (let i = 0; i < b.closes.length; i++) {
    const a = pickAnchor(crosses, i, o.anchor, o.minAge, o.unit);
    if (a < 0) { out.push(null); continue; }
    if (!byAnchor.has(a)) byAnchor.set(a, setFor(b, a, o));
    out.push(byAnchor.get(a) ?? null);
  }
  m.set(key, out);
  return out;
}

/** The layer band a price is in: -1 under L0, k when L_k <= price < L_k+1, 10 at or above L10. */
export function layerOf(price: number, levels: readonly number[]): number {
  if (!(price >= (levels[0] as number))) return -1;
  let k = 0;
  while (k < levels.length - 1 && price >= (levels[k + 1] as number)) k++;
  return k;
}

/** S4 snipe layers: the `depth` highest layers under the close, at most `maxBuyLayer`, not already `bought` at this anchor. */
export function snipeLayers(levels: readonly number[], close: number, bought: readonly number[], o: { readonly depth: number; readonly maxBuyLayer: number }): number[] {
  const out: number[] = [];
  for (let k = Math.min(o.maxBuyLayer, levels.length - 1); k >= 0 && out.length < o.depth; k--) if ((levels[k] as number) < close && !bought.includes(k)) out.push(k);
  return out;
}

/** "between layer 2 and 3 (buy zone)" etc., for the report and the paper reads. */
export function bandWords(band: number): string {
  if (band < 0) return 'under layer 0 (below the anchor)';
  if (band >= 10) return 'above layer 10 (sell zone)';
  return 'between layer ' + band + ' and ' + (band + 1) + ' (' + (band + 1 <= BUY_ZONE_TOP ? 'buy zone' : band >= 6 ? 'sell zone' : 'top of the buy zone') + ')';
}

/** Plain name of a setting, e.g. "A1-63, U1 k=5". */
export function layerOptionsName(o: LayerOptions): string {
  return (o.anchor === 'A1' ? 'A1-' + o.minAge : o.anchor) + ', ' + o.unit + ' ' + (o.unit === 'U2' ? 'c' : 'k') + '=' + o.k;
}
