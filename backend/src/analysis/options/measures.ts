/**
 * Options weights due diligence (docs/OPTIONS_WEIGHTS_DUE_DILIGENCE_2026-11-06.md, owner yes 2026-11-06): the new
 * per-stock measures, read nightly from each Cboe chain and stored per ticker (📐 Options Measures), and the capped
 * points they may give once each has 60 nights of the stock's own history.
 *
 *   smirk          OTM put IV (K/S 0.80-0.95, nearest 0.95) − ATM call IV (K/S 0.95-1.05, nearest 1), the ~30-day
 *                  expiry (Xing, Zhang & Zhao 2010). Conviction -2 when steep (top fifth of own history AND above
 *                  tonight's universe median); +1 when flat (bottom fifth of own history AND of tonight's universe).
 *   IV change      21-night change of the ~30-day ATM put IV and call IV, as a z-score against the stock's own past
 *                  21-night changes (An, Ang, Bali & Cakici 2014). Put z >= 1.5 with call z < 0.5 → -1; call z >= 1.5
 *                  with put z < 0.5 → +1; both rising = a volatility event → 0.
 *   IV spread      call IV − put IV at matched strikes (K/S 0.90-1.10, 20-60 days), averaged (Cremers & Weinbaum
 *                  2010). TIMING only: bottom fifth of own history (puts rich) → entry confidence -3.
 *   O/S            option volume (contracts) ÷ stock volume (shares) (Johnson & So 2012). TIMING only: top fifth of own
 *                  history → entry confidence -2, in SHADOW while the chain shows no volume (P0: 0 at the 05:40 run)
 *                  or fewer than half of the stored nights had volume.
 *   ΔOI P/C        5-night change of the put/call OI ratio (Fodor, Krieger & Doran 2011): top fifth → shadow flag, 0.
 *   LEAPS cost     LEAPS IV (calls > 365 days, K/S 0.8-1.2) ÷ 1-year realised vol: a NOTE on the LEAPS contract
 *                  (Goyal & Saretto 2009), expensive = top fifth of its own history. 0 points.
 *
 * Hard caps (doc 4.2 / 4.3): conviction total within -3 / +2; tech score 0; timing only delays (entry confidence -5 at
 * most, never positive; the BUY_NOW delay is computed in shadow only until the 6-month review); exits 0. Every rule
 * scores 0 until the stock has OPTIONS_MEASURES_MIN_NIGHTS stored nights. Pure; no I/O.
 */

import { parseOcc, type CboeChainJson } from '../../fetch/cboe.ts';

export const OPTIONS_MEASURES_MIN_NIGHTS = 60;
export const CONVICTION_CAP_UP = 2;
export const CONVICTION_CAP_DOWN = -3;
export const ENTRY_CONFIDENCE_CAP = -5;
const IV_CHANGE_NIGHTS = 21;
const OI_CHANGE_NIGHTS = 5;
const DAY_MS = 86_400_000;

/** One stock's measures for one night (📐 Options Measures). IVs in vol points (Cboe's decimal × 100). */
export interface OptionsMeasures {
  readonly day: string;
  readonly ticker: string;
  readonly spot: number | null;
  /** Days to the ~30-day expiry used for the smirk and the ATM IVs. */
  readonly expDays: number | null;
  readonly smirk: number | null;
  readonly atmCallIv: number | null;
  readonly atmPutIv: number | null;
  readonly ivSpread: number | null;
  readonly optVolume: number;
  readonly stockVolume: number | null;
  readonly osRatio: number | null;
  readonly callOi: number;
  readonly putOi: number;
  readonly pcOi: number | null;
  readonly leapsIv: number | null;
  readonly rv1y: number | null;
}

interface Leg { readonly side: 'call' | 'put'; readonly k: number; readonly days: number; readonly iv: number; readonly oi: number; readonly vol: number }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const r4 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10_000) / 10_000);

function legsOf(json: CboeChainJson | null, nowMs: number): Leg[] {
  const out: Leg[] = [];
  for (const o of json?.data?.options ?? []) {
    if (!o.option) continue;
    const p = parseOcc(String(o.option));
    if (!(p.strike > 0)) continue;
    out.push({ side: p.side === 'put' ? 'put' : 'call', k: p.strike, days: (p.expUnix * 1000 - nowMs) / DAY_MS, iv: (num(o.iv) ?? 0) * 100, oi: num(o.open_interest) ?? 0, vol: num(o.volume) ?? 0 });
  }
  return out;
}

/** The leg nearest `target` moneyness within [lo, hi] with an IV, on the given expiry. */
function nearest(legs: readonly Leg[], side: Leg['side'], spot: number, lo: number, hi: number, target: number): Leg | null {
  let best: Leg | null = null;
  for (const l of legs) {
    const m = l.k / spot;
    if (l.side !== side || l.iv <= 0 || m < lo || m > hi) continue;
    if (!best || Math.abs(m - target) < Math.abs(best.k / spot - target)) best = l;
  }
  return best;
}

/** 1-year realised volatility (vol points) of the last 252 closes; null with fewer than 60. */
export function realisedVol1y(closes: readonly number[]): number | null {
  const c = closes.filter((x) => x > 0).slice(-253);
  if (c.length < 61) return null;
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) r.push(Math.log((c[i] as number) / (c[i - 1] as number)));
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252) * 100;
}

/** Tonight's measures of one chain. `stockVolume` = the last session's share volume; `closes` for the 1-year RV. */
export function measuresOf(
  json: CboeChainJson | null, ticker: string, day: string, nowMs: number, stockVolume: number | null, closes: readonly number[] = [],
): OptionsMeasures {
  const spot = num(json?.data?.current_price);
  const legs = legsOf(json, nowMs);
  let callOi = 0, putOi = 0, optVolume = 0;
  for (const l of legs) { if (l.side === 'call') callOi += l.oi; else putOi += l.oi; optVolume += l.vol; }
  // the ~30-day expiry: days in 20-60 nearest 30, else 7-90 nearest 30
  const days = [...new Set(legs.map((l) => Math.round(l.days)))];
  const pick = (lo: number, hi: number): number | null => days.filter((d) => d >= lo && d <= hi).sort((a, b) => Math.abs(a - 30) - Math.abs(b - 30) || a - b)[0] ?? null;
  const expDays = pick(20, 60) ?? pick(7, 90);
  let atmCallIv: number | null = null, atmPutIv: number | null = null, smirk: number | null = null, ivSpread: number | null = null, leapsIv: number | null = null;
  if (spot != null && spot > 0) {
    if (expDays != null) {
      const exp = legs.filter((l) => Math.round(l.days) === expDays);
      atmCallIv = nearest(exp, 'call', spot, 0.95, 1.05, 1)?.iv ?? null;
      atmPutIv = nearest(exp, 'put', spot, 0.95, 1.05, 1)?.iv ?? null;
      const otmPut = nearest(exp, 'put', spot, 0.80, 0.95, 0.95)?.iv ?? null;
      smirk = otmPut != null && atmCallIv != null ? otmPut - atmCallIv : null;
    }
    // IV spread: matched strikes and expiries, K/S 0.90-1.10, 20-60 days
    const calls = new Map<string, number>();
    for (const l of legs) if (l.side === 'call' && l.iv > 0 && l.days >= 20 && l.days <= 60 && l.k / spot >= 0.9 && l.k / spot <= 1.1) calls.set(l.k + '|' + Math.round(l.days), l.iv);
    const diffs: number[] = [];
    for (const l of legs) {
      if (l.side !== 'put' || l.iv <= 0) continue;
      const c = calls.get(l.k + '|' + Math.round(l.days));
      if (c != null) diffs.push(c - l.iv);
    }
    ivSpread = diffs.length ? diffs.reduce((s, x) => s + x, 0) / diffs.length : null;
    const lc = legs.filter((l) => l.side === 'call' && l.iv > 0 && l.days > 365 && l.k / spot >= 0.8 && l.k / spot <= 1.2);
    leapsIv = lc.length ? lc.reduce((s, l) => s + l.iv, 0) / lc.length : null;
  }
  const sv = stockVolume != null && stockVolume > 0 ? stockVolume : null;
  return {
    day, ticker: ticker.toUpperCase(), spot, expDays,
    smirk: r4(smirk), atmCallIv: r4(atmCallIv), atmPutIv: r4(atmPutIv), ivSpread: r4(ivSpread),
    optVolume, stockVolume: sv, osRatio: sv != null ? r4(optVolume / sv) : null,
    callOi, putOi, pcOi: callOi > 0 ? r4(putOi / callOi) : null,
    leapsIv: r4(leapsIv), rv1y: r4(realisedVol1y(closes)),
  };
}

// ───────────────────────── scoring ─────────────────────────

/** The value at quantile q (0-1) of `xs` (linear interpolation); null when empty. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}
const topFifth = (x: number, xs: readonly number[]): boolean => { const q = quantile(xs, 0.8); return q != null && x >= q; };
const bottomFifth = (x: number, xs: readonly number[]): boolean => { const q = quantile(xs, 0.2); return q != null && x <= q; };
const vals = (h: readonly OptionsMeasures[], f: (m: OptionsMeasures) => number | null): number[] => h.map(f).filter((x): x is number => x != null);

function zOf(x: number, xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? (x - m) / sd : null;
}

/** The n-night changes of a series (oldest first): v[i] − v[i−n]. */
function changes(series: readonly (number | null)[], n: number): number[] {
  const out: number[] = [];
  for (let i = n; i < series.length; i++) { const a = series[i], b = series[i - n]; if (a != null && b != null) out.push(a - b); }
  return out;
}

export type MeasureState = 'not enough history' | 'no data' | 'steep' | 'flat' | 'put IV rising' | 'call IV rising' | 'puts rich' | 'high' | 'normal' | 'shadow: no volume';

export interface MeasureRule {
  readonly state: MeasureState;
  /** Points applied (conviction for smirk / IV change; entry confidence for IV spread / O/S); 0 in shadow. */
  readonly pts: number;
  /** What it would give if live (shadow rules and history-gated rules). */
  readonly wouldBe: number;
}

export interface MeasuresScore {
  readonly nights: number;
  readonly smirk: MeasureRule;
  readonly ivChange: MeasureRule;
  readonly ivSpread: MeasureRule;
  readonly os: MeasureRule;
  /** ΔOI P/C over 5 nights in the top fifth (shadow; scores 0). */
  readonly oiBuild: boolean;
  /** Capped conviction points (-3..+2). */
  readonly convictionPts: number;
  /** Entry-confidence points (-5..0). Timing is never upgraded, AVOID never flipped. */
  readonly entryConfidencePts: number;
  /** BUY_NOW delay flag (2+ bearish timing signals): SHADOW until the 6-month review, never applied. */
  readonly delayShadow: boolean;
  /** "LEAPS IV x% vs 1-year realised vol y%: expensive / normal / cheap" (0 points); null without the inputs. */
  readonly leapsCostNote: string | null;
  readonly notes: readonly string[];
}

const NONE: MeasureRule = { state: 'not enough history', pts: 0, wouldBe: 0 };

/** Clamp to the doc's hard caps. */
export const capConviction = (pts: number): number => Math.max(CONVICTION_CAP_DOWN, Math.min(CONVICTION_CAP_UP, pts));
export const capEntryConfidence = (pts: number): number => Math.max(ENTRY_CONFIDENCE_CAP, Math.min(0, pts));

/**
 * Tonight's points for one stock. `history` = the stock's own PRIOR stored nights (oldest first, tonight excluded);
 * `universe` = tonight's measures of every nightly stock (for the smirk's cross-sectional check).
 */
export function scoreMeasures(today: OptionsMeasures, history: readonly OptionsMeasures[], universe: readonly OptionsMeasures[], minNights = OPTIONS_MEASURES_MIN_NIGHTS): MeasuresScore {
  const n = history.length;
  const enough = n >= minNights;
  // smirk
  let smirk: MeasureRule = NONE;
  if (today.smirk == null) smirk = { state: 'no data', pts: 0, wouldBe: 0 };
  else {
    const own = vals(history, (m) => m.smirk), uni = vals(universe, (m) => m.smirk);
    const med = quantile(uni, 0.5);
    const steep = own.length > 0 && topFifth(today.smirk, own) && med != null && today.smirk > med;
    const flat = own.length > 0 && bottomFifth(today.smirk, own) && bottomFifth(today.smirk, uni);
    const w = steep ? -2 : flat ? 1 : 0;
    smirk = { state: !enough || own.length < minNights ? 'not enough history' : steep ? 'steep' : flat ? 'flat' : 'normal', pts: enough && own.length >= minNights ? w : 0, wouldBe: w };
  }
  // IV change (21 nights), z against own past changes
  let ivChange: MeasureRule = NONE;
  const putSeries = [...history.map((m) => m.atmPutIv), today.atmPutIv], callSeries = [...history.map((m) => m.atmCallIv), today.atmCallIv];
  if (today.atmPutIv == null || today.atmCallIv == null) ivChange = { state: 'no data', pts: 0, wouldBe: 0 };
  else if (putSeries.length > IV_CHANGE_NIGHTS) {
    const pc = changes(putSeries, IV_CHANGE_NIGHTS), cc = changes(callSeries, IV_CHANGE_NIGHTS);
    const pNow = pc[pc.length - 1], cNow = cc[cc.length - 1];
    const pz = pNow != null ? zOf(pNow, pc.slice(0, -1)) : null, cz = cNow != null ? zOf(cNow, cc.slice(0, -1)) : null;
    const w = pz != null && cz != null ? (pz >= 1.5 && cz < 0.5 ? -1 : cz >= 1.5 && pz < 0.5 ? 1 : 0) : 0;
    ivChange = { state: !enough ? 'not enough history' : w < 0 ? 'put IV rising' : w > 0 ? 'call IV rising' : 'normal', pts: enough ? w : 0, wouldBe: w };
  }
  // IV spread (timing)
  let ivSpread: MeasureRule = NONE;
  if (today.ivSpread == null) ivSpread = { state: 'no data', pts: 0, wouldBe: 0 };
  else {
    const own = vals(history, (m) => m.ivSpread);
    const w = own.length && bottomFifth(today.ivSpread, own) ? -3 : 0;
    ivSpread = { state: !enough || own.length < minNights ? 'not enough history' : w ? 'puts rich' : 'normal', pts: enough && own.length >= minNights ? w : 0, wouldBe: w };
  }
  // O/S (timing; shadow while there is no volume)
  let os: MeasureRule = NONE;
  if (today.osRatio == null) os = { state: 'no data', pts: 0, wouldBe: 0 };
  else {
    const own = vals(history, (m) => m.osRatio);
    const w = own.length && topFifth(today.osRatio, own) ? -2 : 0;
    const withVolume = history.filter((m) => m.optVolume > 0).length;
    const volumeOk = today.optVolume > 0 && withVolume * 2 >= Math.max(1, n);
    const live = enough && own.length >= minNights && volumeOk;
    os = { state: !volumeOk ? 'shadow: no volume' : !live ? 'not enough history' : w ? 'high' : 'normal', pts: live ? w : 0, wouldBe: w };
  }
  // ΔOI P/C (5 nights): shadow only
  const pcSeries = [...history.map((m) => m.pcOi), today.pcOi];
  const oc = changes(pcSeries, OI_CHANGE_NIGHTS);
  const oNow = oc[oc.length - 1];
  const oiBuild = oNow != null && oc.length > 1 && topFifth(oNow, oc.slice(0, -1));

  const convictionPts = capConviction(smirk.pts + ivChange.pts);
  const entryConfidencePts = capEntryConfidence(ivSpread.pts + os.pts);
  const bearishTiming = [ivSpread.wouldBe < 0, os.wouldBe < 0, oiBuild].filter(Boolean).length;
  // LEAPS cost note
  let leapsCostNote: string | null = null;
  if (today.leapsIv != null && today.rv1y != null && today.rv1y > 0) {
    const ratio = today.leapsIv / today.rv1y;
    const own = history.filter((m) => m.leapsIv != null && m.rv1y != null && (m.rv1y as number) > 0).map((m) => (m.leapsIv as number) / (m.rv1y as number));
    const label = own.length < minNights ? 'history building (' + own.length + ' of ' + minNights + ' nights)' : topFifth(ratio, own) ? 'expensive' : bottomFifth(ratio, own) ? 'cheap' : 'normal';
    leapsCostNote = 'LEAPS IV ' + today.leapsIv.toFixed(0) + '% vs 1-year realised vol ' + today.rv1y.toFixed(0) + '%: ' + label;
  }
  const notes: string[] = [];
  if (!enough) notes.push('Options measures: not enough history (' + n + ' of ' + minNights + ' nights); they score 0');
  else {
    if (smirk.pts) notes.push('options smirk ' + smirk.state + ' ' + (smirk.pts > 0 ? '+' : '') + smirk.pts);
    if (ivChange.pts) notes.push('options ' + ivChange.state + ' ' + (ivChange.pts > 0 ? '+' : '') + ivChange.pts);
    if (smirk.pts + ivChange.pts !== convictionPts) notes.push('options points capped at ' + convictionPts);
  }
  return { nights: n, smirk, ivChange, ivSpread, os, oiBuild, convictionPts, entryConfidencePts, delayShadow: bearishTiming >= 2, leapsCostNote, notes };
}
