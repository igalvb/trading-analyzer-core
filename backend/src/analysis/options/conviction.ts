/**
 * The options conviction engine of futuresStockAnalysisV3_3_11.gs, ported
 * exactly:
 *   selectRecommendedCallV7 :459-529, computeOiPersistence :691-708,
 *   isLeaps :712, parseAndScore :714-950, computeChainContext :961-1003,
 *   interpretSignal :1008-1041, and the OPTIONS_OVERLAY write of
 *   runFullAnalysis :346-376 (buildOptionsOverlay / saveOptionsOverlay).
 * cacheSet / cacheGet (:669-689) are storage/kv.ts (FL-0).
 *
 * Conviction per contract (0-100):
 *   Near/Mid, market open:   50% $ + 20% holding + 15% urgency + 10% time + 5% IV
 *   Near/Mid, market closed: 70% $ + 20% time + 10% IV
 *   LEAPS (~1yr, ~2yr):      45% $ + 30% holding + 15% OI persistence + 10% IV
 * OI persistence compares each LEAPS contract's open interest with the last
 * run's ('OI_HIST_' + TICKER, kept 30 days); no history scores a neutral 50.
 *
 * expiryStr is Date#toLocaleDateString('en-US', {year, month:'short', day})
 * in the script's zone, as Apps Script printed it. F-62: the expiry instant
 * is 00:00 UTC, so anywhere west of UTC (America/New_York included) every
 * label reads the day BEFORE the real expiry ('Jan 14, 2027' for a
 * 2027-01-15 contract).
 *
 * F-62 FIXED (the user's decision, one-time OI-history reset accepted): the
 * label is printed in UTC, the zone the expiry instant is defined in, so it
 * names the real expiry day. The label is also the OI-persistence history
 * key, so the fixed labels use their own history key ('OI_HIST_V2_'): the
 * first run after the fix starts clean (every LEAPS contract scores the
 * neutral first-run 50, once) instead of matching old, day-early labels.
 * `legacyExpiryLabel: true` restores legacy's label and key (oracle tests).
 */

import type { Clock } from '../../core/context.ts';
import { cacheGet, cacheSet, OPTIONS_OVERLAY_KEY, type PropertyStore } from '../../storage/kv.ts';
import { fetchCboeRaw, parseOcc, type CboeDeps, type ChainColumns } from '../../fetch/cboe.ts';
import { SHORT_TERM_MIN_DAYS } from './labels.ts';

export type OptionSide = 'call' | 'put';
export type ExpiryBucket = 'Near (0–3m)' | 'Mid (3–12m)' | 'LEAPS ~1yr' | 'LEAPS ~2yr';
export type OptionsLog = (message: string) => void;

export interface OptionsScoringDeps {
  readonly kv: PropertyStore;
  /** The script's zone (the overlay's date; the expiry labels only with legacyExpiryLabel). */
  readonly timeZone: string;
  readonly clock?: Clock;
  /** F-62 parity flag: true = legacy labels (script zone, one day early west of UTC) and the legacy OI-history key. */
  readonly legacyExpiryLabel?: boolean;
}

const nowOf = (d: { readonly clock?: Clock }): number => (d.clock ? d.clock.now() : Date.now());

/** One contract as parsed from the chain (parseAndScore step 1). */
export interface RawContract {
  side: OptionSide;
  strike: number;
  vol: number;
  oi: number;
  iv: number;
  dollarsCommitted: number;
  holdingRaw: number;
  urgencyRaw: number;
  daysToExpiry: number;
  expiryStr: string;
  bucket: ExpiryBucket;
  expiry: Date | null;
}

/** A contract that passed the strike band and $ floor, with its scores. */
export interface ScoredContract extends RawContract {
  ivPremium: number;
  dollarScore: number;
  holdingScore: number;
  urgencyScore: number;
  timeScore: number;
  ivScore: number;
  oiPersistenceScore: number | null;
  oiPersistenceIsFirstRun: boolean | null;
  conviction: number;
}

/** parseAndScore's result: sorted by conviction, with legacy's two extra array properties. */
export type ScoredContracts = ScoredContract[] & { dollarFloor?: number; fullChain?: RawContract[] };

/** isLeaps (:712). */
export function isLeaps(bucket: unknown): boolean {
  return bucket === 'LEAPS ~1yr' || bucket === 'LEAPS ~2yr';
}

export interface OiPersistence {
  readonly score: number;
  readonly isFirstRun: boolean;
}

export const OI_HISTORY_KEY_PREFIX = 'OI_HIST_';
/** F-62: the history key of the fixed (UTC) expiry labels. */
export const OI_HISTORY_KEY_PREFIX_V2 = 'OI_HIST_V2_';
export const OI_HISTORY_TTL_HOURS = 24 * 30;

/**
 * computeOiPersistence (:691-708): each LEAPS contract's OI change since the
 * ticker's last run -- >=+10% 100, >=+2% 75, within 2% 50, >=-10% 25, else 0;
 * no history 50 (isFirstRun). Saves this run's OI as the new history.
 */
export async function computeOiPersistence(
  deps: OptionsScoringDeps, ticker: string | null | undefined, leapsContracts: readonly RawContract[],
): Promise<Record<string, OiPersistence>> {
  const cacheKey = (deps.legacyExpiryLabel ? OI_HISTORY_KEY_PREFIX : OI_HISTORY_KEY_PREFIX_V2) + String(ticker || 'UNKNOWN').toUpperCase();
  const prev = await cacheGet<{ contracts?: Record<string, number> }>(deps.kv, cacheKey, nowOf(deps));
  const prevMap: Record<string, number> = (prev && prev.contracts) || {};
  const nowMap: Record<string, number> = {}, scores: Record<string, OiPersistence> = {};
  leapsContracts.forEach((c) => {
    const key = c.side + '_' + c.strike + '@' + c.expiryStr;
    nowMap[key] = c.oi;
    const prevOi = prevMap[key];
    if (prevOi == null || prevOi <= 0) { scores[key] = { score: 50, isFirstRun: true }; return; }
    const chg = (c.oi - prevOi) / prevOi;
    const score = chg >= 0.10 ? 100 : chg >= 0.02 ? 75 : chg >= -0.02 ? 50 : chg >= -0.10 ? 25 : 0;
    scores[key] = { score, isFirstRun: false };
  });
  await cacheSet(deps.kv, cacheKey, { date: new Date(nowOf(deps)).toISOString(), contracts: nowMap }, OI_HISTORY_TTL_HOURS, nowOf(deps));
  return scores;
}

/**
 * parseAndScore (:714-950): parse the chain, keep strikes within 50-200% of
 * the OI-weighted median strike and at least the adaptive $ floor ($100M,
 * halved down to $1M until ~10 contracts qualify), score, sort by conviction.
 */
export async function parseAndScore(deps: OptionsScoringDeps, r: ChainColumns | null | undefined, log: OptionsLog | null, ticker?: string | null): Promise<ScoredContracts> {
  const today = new Date(nowOf(deps));
  if (!r || !Array.isArray(r.strike)) {
    if (log) log('  ⚠ malformed chain (no strike array) — skipped');
    return [] as ScoredContracts;
  }
  const R = r as unknown as Record<string, any>;
  const n = r.strike.length;
  const raw: any[] = [];

  const oiKey = R.openInterest ? 'openInterest' : R.openinterest ? 'openinterest' : null;
  const volKey = R.volume ? 'volume' : R.vol ? 'vol' : null;
  const ivKey = R.iv ? 'iv' : R.impliedVolatility ? 'impliedVolatility' : null;
  const sideKey = R.side ? 'side' : R.optionType ? 'optionType' : null;
  const expKey = R.expiration ? 'expiration' : R.expirationDate ? 'expirationDate' : null;

  for (let i = 0; i < n; i++) {
    const side = sideKey ? R[sideKey][i] : '';
    const sideNorm = side === 'C' ? 'call' : side === 'P' ? 'put' : side;
    if (sideNorm !== 'call' && sideNorm !== 'put') continue;

    const expTs = expKey ? R[expKey][i] : null;
    const expiry = expTs ? new Date(expTs * 1000) : null;
    const daysToExpiry = expiry ? Math.max(1, Math.round((expiry.getTime() - today.getTime()) / 86400000)) : 730;

    const strike = Number(r.strike[i]);
    const vol = volKey ? (Number(R[volKey][i]) || 0) : 0;
    const oi = oiKey ? (Number(R[oiKey][i]) || 0) : 0;
    const iv = ivKey ? (Number(R[ivKey][i]) || 0) : 0;

    if (!Number.isFinite(strike) || strike <= 0) continue;
    if (oi === 0) continue;

    const expiryStr = expiry
      ? expiry.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: deps.legacyExpiryLabel ? deps.timeZone : 'UTC' })
      : 'N/A';
    const bucket: ExpiryBucket = daysToExpiry <= 90 ? 'Near (0–3m)'
      : daysToExpiry <= 365 ? 'Mid (3–12m)'
      : daysToExpiry <= 730 ? 'LEAPS ~1yr'
      : 'LEAPS ~2yr';

    raw.push({
      side: sideNorm, strike, vol, oi, iv,
      dollarsCommitted: strike * oi * 100,
      holdingRaw: vol > 0 ? Math.min(oi / vol, 100) : 100,
      urgencyRaw: oi > 0 ? Math.min(vol / oi, 20) : 0,
      daysToExpiry, expiryStr, bucket, expiry,
    });
  }

  if (raw.length === 0) return [] as ScoredContracts;

  const sortedByStrike = raw.slice().sort((a, b) => a.strike - b.strike);
  const totalOI = sortedByStrike.reduce((s, c) => s + c.oi, 0);
  let cumOI = 0;
  let atmEstimate = sortedByStrike[Math.floor(sortedByStrike.length / 2)].strike;
  for (const c of sortedByStrike) {
    cumOI += c.oi;
    if (cumOI >= totalOI * 0.50) { atmEstimate = c.strike; break; }
  }

  const minStrike = atmEstimate * 0.50;
  const maxStrike = atmEstimate * 2.00;
  const inBand = raw.filter((c) => c.strike >= minStrike && c.strike <= maxStrike);

  let dollarFloor = 100e6;
  let filtered = inBand.filter((c) => c.dollarsCommitted >= dollarFloor);
  while (filtered.length < 10 && dollarFloor > 1e6) {
    dollarFloor = Math.max(1e6, dollarFloor / 2);
    filtered = inBand.filter((c) => c.dollarsCommitted >= dollarFloor);
  }
  if (log) {
    const floorStr = dollarFloor >= 1e9 ? (dollarFloor / 1e9) + 'B' : Math.round(dollarFloor / 1e6) + 'M';
    log('   Filter: ' + filtered.length + ' contracts ≥ $' + floorStr +
        ' committed, strikes $' + Math.round(minStrike) + '–$' + Math.round(maxStrike));
  }
  if (filtered.length === 0) return [] as ScoredContracts;

  const ivVals = filtered.filter((c) => c.iv > 0).map((c) => c.iv);
  const ivAvg = ivVals.length > 0 ? ivVals.reduce((a: number, b: number) => a + b, 0) / ivVals.length : 0;
  filtered.forEach((c) => {
    c.ivPremium = (ivAvg > 0 && c.iv > 0) ? (c.iv / ivAvg) : 1.0;
  });

  // $ score: relative to this chain's largest position (log2-spaced), damped for thin chains.
  const dollarMax = Math.max(1, ...filtered.map((c) => Number(c.dollarsCommitted) || 0));
  const MEANINGFUL_DOLLAR_THRESHOLD = 300e6;
  const chainSizeDampening = Math.min(1, dollarMax / MEANINGFUL_DOLLAR_THRESHOLD);
  const dollarScore = (d: number): number => {
    if (!Number.isFinite(d) || d <= 0) return 0;
    const frac = d / dollarMax;
    const relativeScore = Math.max(0, Math.min(100, Math.round(100 + 20 * Math.log2(frac))));
    return Math.round(relativeScore * (0.5 + 0.5 * chainSizeDampening));
  };

  // Holding score: the OI/volume ratio's percentile within this chain.
  const holdRatios = filtered.map((c) => Number(c.holdingRaw)).filter(Number.isFinite).sort((a, b) => a - b);
  const holdingScore = (ratio: number): number => {
    if (!Number.isFinite(ratio) || holdRatios.length === 0) return 0;
    const atOrBelow = holdRatios.filter((x) => x <= ratio).length;
    return Math.max(0, Math.min(100, Math.round((atOrBelow / holdRatios.length) * 100)));
  };

  const urgencyScore = (ratio: number): number => {
    if (ratio >= 5.0) return 100;
    if (ratio >= 2.0) return 70 + Math.round(((ratio - 2.0) / 3.0) * 30);
    if (ratio >= 0.5) return 30 + Math.round(((ratio - 0.5) / 1.5) * 40);
    if (ratio > 0) return Math.round((ratio / 0.5) * 30);
    return 0;
  };

  const timeScore = (days: number): number => {
    if (days <= 30) return 100;
    if (days <= 90) return 70 + Math.round(((90 - days) / 60) * 30);
    if (days <= 180) return 50 + Math.round(((180 - days) / 90) * 20);
    if (days <= 365) return 25 + Math.round(((365 - days) / 185) * 25);
    if (days <= 730) return Math.round(((730 - days) / 365) * 25);
    if (days <= 1095) return Math.max(0, Math.round(((1095 - days) / 365) * 5));
    return 0;
  };

  const ivScore = (premium: number): number => {
    if (premium >= 1.5) return 100;
    if (premium >= 1.35) return 70 + Math.round(((premium - 1.35) / 0.15) * 30);
    if (premium >= 1.2) return 40 + Math.round(((premium - 1.2) / 0.15) * 30);
    if (premium >= 1.0) return Math.round(((premium - 1.0) / 0.2) * 40);
    return 0;
  };

  const totalVol = filtered.reduce((s, c) => s + c.vol, 0);
  const marketClosed = totalVol === 0;

  const leapsContracts = filtered.filter((c) => isLeaps(c.bucket));
  const oiPersistenceMap = leapsContracts.length ? await computeOiPersistence(deps, ticker || 'UNKNOWN', leapsContracts) : {};

  filtered.forEach((c) => {
    c.dollarScore = Math.min(dollarScore(c.dollarsCommitted), 100);
    c.holdingScore = marketClosed ? 0 : Math.min(holdingScore(c.holdingRaw), 100);
    c.urgencyScore = marketClosed ? 0 : Math.min(urgencyScore(c.urgencyRaw), 100);
    c.timeScore = Math.min(timeScore(c.daysToExpiry), 100);
    c.ivScore = Math.min(ivScore(c.ivPremium), 100);

    if (isLeaps(c.bucket)) {
      const key = c.side + '_' + c.strike + '@' + c.expiryStr;
      const oiPers = (oiPersistenceMap as Record<string, OiPersistence>)[key];
      c.oiPersistenceScore = oiPers != null ? oiPers.score : 50;
      c.oiPersistenceIsFirstRun = oiPers != null ? oiPers.isFirstRun : true;
      c.conviction = Math.round(c.dollarScore * 0.45 + c.holdingScore * 0.30 + c.oiPersistenceScore * 0.15 + c.ivScore * 0.10);
    } else {
      c.oiPersistenceScore = null;
      c.oiPersistenceIsFirstRun = null;
      c.conviction = marketClosed
        ? Math.round(c.dollarScore * 0.70 + c.timeScore * 0.20 + c.ivScore * 0.10)
        : Math.round(c.dollarScore * 0.50 + c.holdingScore * 0.20 + c.urgencyScore * 0.15 + c.timeScore * 0.10 + c.ivScore * 0.05);
    }
  });

  filtered.sort((a, b) => b.conviction - a.conviction);
  const out = filtered as ScoredContracts;
  out.dollarFloor = dollarFloor;
  out.fullChain = raw as RawContract[];
  return out;
}

export interface ChainContext {
  readonly putCallRatioOI: number | null;
  readonly putCallRatioVol: number | null;
  readonly frontIV: number | null;
  readonly backIV: number | null;
  readonly ivRankPct: number | null;
  readonly termNote: string;
  readonly netBiasPct: number | null;
  readonly netBiasNote: string;
}

/**
 * computeChainContext (:961-1003): whole-chain put/call ratios, front
 * (<=90d) vs back (>365d) IV, the front IV's percentile among today's IVs
 * (cross-sectional -- no history), term structure, and the net $ bias.
 *
 * D5 (fix plan 2026-10-30): `minIvDays` (production: MIN_DAYS_FOR_IV_CONTEXT = 7)
 * leaves contracts with fewer days to expiry out of the front IV, the back IV,
 * the term structure and the IV percentile (both the front IV and the chain it
 * is ranked in) -- 0-2 day options print IVs of 170-220% and distorted all
 * three. The put/call ratios and the $ bias still use the whole chain.
 * Default 0 = legacy exactly (oracle tests).
 */
export function computeChainContext(raw: unknown, opts: { readonly minIvDays?: number } = {}): ChainContext {
  const all: RawContract[] = Array.isArray(raw) ? raw : [];
  const calls = all.filter((c) => c.side === 'call');
  const puts = all.filter((c) => c.side === 'put');
  const callOI = calls.reduce((s, c) => s + c.oi, 0), putOI = puts.reduce((s, c) => s + c.oi, 0);
  const callVol = calls.reduce((s, c) => s + c.vol, 0), putVol = puts.reduce((s, c) => s + c.vol, 0);
  const putCallRatioOI = callOI > 0 ? putOI / callOI : null;
  const putCallRatioVol = callVol > 0 ? putVol / callVol : null;

  const minIvDays = opts.minIvDays ?? 0;
  const ivSet = minIvDays > 0 ? all.filter((c) => c.daysToExpiry >= minIvDays) : all;
  const allIVs = ivSet.filter((c) => c.iv > 0).map((c) => c.iv).sort((a, b) => a - b);
  const avg = (arr: number[]): number | null => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const frontIV = avg(ivSet.filter((c) => c.iv > 0 && c.daysToExpiry <= 90).map((c) => c.iv));
  const backIV = avg(ivSet.filter((c) => c.iv > 0 && c.daysToExpiry > 365).map((c) => c.iv));

  let ivRankPct: number | null = null;
  if (frontIV != null && allIVs.length > 0) {
    ivRankPct = Math.round((allIVs.filter((v) => v <= frontIV).length / allIVs.length) * 100);
  }

  let termNote = 'N/A (insufficient front/back IV data)';
  if (frontIV != null && backIV != null && backIV > 0) {
    const diffPct = ((frontIV - backIV) / backIV) * 100;
    termNote = diffPct > 5 ? 'Inverted — front IV ' + diffPct.toFixed(1) + '% above back (near-term event/fear priced in)'
      : diffPct < -5 ? 'Normal/contango — back IV ' + Math.abs(diffPct).toFixed(1) + '% above front'
      : 'Flat (front ≈ back, ' + diffPct.toFixed(1) + '%)';
  }

  const callDollars = calls.reduce((s, c) => s + c.strike * c.oi * 100, 0);
  const putDollars = puts.reduce((s, c) => s + c.strike * c.oi * 100, 0);
  const totalDollars = callDollars + putDollars;
  const netBiasPct = totalDollars > 0 ? Math.round(((callDollars - putDollars) / totalDollars) * 100) : null;
  const netBiasNote = netBiasPct == null ? 'N/A'
    : netBiasPct > 15 ? 'Call-heavy (net +' + netBiasPct + '%) — bullish skew'
    : netBiasPct < -15 ? 'Put-heavy (net ' + netBiasPct + '%) — bearish/hedging skew'
    : 'Balanced (net ' + (netBiasPct > 0 ? '+' : '') + netBiasPct + '%)';

  return { putCallRatioOI, putCallRatioVol, frontIV, backIV, ivRankPct, termNote, netBiasPct, netBiasNote };
}

/** interpretSignal (:1008-1041): one contract's plain-English read. */
export function interpretSignal(c: Pick<ScoredContract, 'side' | 'daysToExpiry' | 'dollarScore' | 'holdingScore' | 'urgencyScore' | 'ivScore'>): string {
  const isCall = c.side === 'call';
  const near = c.daysToExpiry <= 90;
  const far = c.daysToExpiry > 365;
  const massiveDollars = c.dollarScore >= 65;
  const strongDollars = c.dollarScore >= 40;
  const institutional = c.holdingScore >= 70;
  const urgencySpike = c.urgencyScore >= 70;
  const highIV = c.ivScore >= 60;
  if (isCall) {
    if (massiveDollars && near) return 'Major call wall — massive near-term positioning';
    if (massiveDollars && far) return 'Institutional LEAPS target — major upside level';
    if (strongDollars && institutional && far) return 'Institutional upside target (LEAPS)';
    if (urgencySpike && near) return 'Near-term call spike — possible informed entry';
    if (urgencySpike) return 'Unusual call activity — new position building';
    if (strongDollars && institutional) return 'Major resistance / call wall';
    if (near && highIV) return 'Near-term call — elevated IV premium';
    if (near) return 'Near-term bullish positioning';
    return 'Bullish bet / upside target';
  }
  if (massiveDollars && near) return 'Major put wall — large near-term hedge';
  if (massiveDollars && far) return 'Long-dated crash hedge — institutional tail risk';
  if (strongDollars && institutional && far) return 'Long-dated crash hedge';
  if (urgencySpike && near) return 'Near-term put spike — possible informed exit';
  if (urgencySpike) return 'Unusual put activity — new hedge building';
  if (strongDollars && institutional) return 'Strong support / institutional hedge';
  if (near && highIV) return 'Near-term put — elevated IV premium';
  if (near) return 'Near-term downside protection';
  return 'Bearish bet / downside hedge';
}

export interface CallCandidate {
  readonly strike: number;
  readonly expUnix: number;
  readonly symbol: string;
  readonly delta: number;
  readonly theta: number;
  readonly gamma: number;
  readonly bid: number;
  readonly ask: number;
  readonly iv: number;
}

export type RecommendedCall =
  | { readonly found: false; readonly reason: string }
  | {
    readonly found: true; readonly contract: CallCandidate; readonly expUnix: number; readonly deltaFieldSeen: boolean;
    readonly allCandidates: Array<CallCandidate & { readonly deltaDistance: number }>;
  };

/**
 * selectRecommendedCallV7 (:459-529): long calls only. LEAPS: the furthest
 * expiry >=180 days out (else the furthest); short-term: the nearest expiry
 * between 14 and 180 days (else the nearest). At that expiry, the call whose
 * delta is closest to the target, with every candidate ranked by distance.
 *
 * D3 (fix plan 2026-10-30), outside parity runs (`legacyExpiryLabel` unset): the
 * short-term pick is the nearest expiry with SHORT_TERM_MIN_DAYS (60) to 180
 * days left, and when there is none it is "no contract" -- legacy's nearest
 * (14+ days, else the nearest of all) handed out a ~3-week call that its own
 * 30-days-before-expiry exit sells on the day it is bought.
 */
export async function selectRecommendedCall(
  deps: CboeDeps & { readonly clock?: Clock; readonly legacyExpiryLabel?: boolean }, ticker: string, targetDelta: number, leaps: boolean, log: OptionsLog | null = null,
): Promise<RecommendedCall> {
  const json = await fetchCboeRaw(deps, ticker, log);
  if (!json || !json.data || !json.data.options) return { found: false, reason: 'no chain data returned for ' + ticker };

  const nowSec = nowOf(deps) / 1000;
  const opts = json.data.options;
  const byExpiry: Record<string, CallCandidate[]> = {};
  let deltaFieldSeen = false;
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    if (!o.option) continue;
    const p = parseOcc(o.option);
    if (p.side !== 'call') continue;
    if (o.delta !== undefined && o.delta !== null) deltaFieldSeen = true;
    if (!byExpiry[p.expUnix]) byExpiry[p.expUnix] = [];
    byExpiry[p.expUnix].push({
      strike: p.strike, expUnix: p.expUnix, symbol: o.option,
      delta: Number(o.delta), theta: Number(o.theta), gamma: Number(o.gamma),
      bid: Number(o.bid) || 0, ask: Number(o.ask) || 0, iv: Number(o.iv) || 0,
    });
  }
  if (!deltaFieldSeen && log) {
    log('⚠ WARNING: delta field not found in CBOE response for ' + ticker + ' -- greek-based contract selection cannot work correctly. This needs investigating -- the assumption that delta is in this feed (based on secondary evidence, never independently confirmed) may be wrong.');
  }

  const expiries = Object.keys(byExpiry).map(Number).sort((a, b) => a - b);
  if (!expiries.length) return { found: false, reason: 'no call contracts found for ' + ticker };

  const SECONDS_180D = 180 * 24 * 3600;
  const SECONDS_14D = 14 * 24 * 3600;
  let targetExpUnix: number;
  if (leaps) {
    const leapsExpiries = expiries.filter((e) => (e - nowSec) >= SECONDS_180D);
    targetExpUnix = leapsExpiries.length ? leapsExpiries[leapsExpiries.length - 1] : expiries[expiries.length - 1];
  } else if (deps.legacyExpiryLabel) {
    const shortExpiries = expiries.filter((e) => (e - nowSec) < SECONDS_180D && (e - nowSec) > SECONDS_14D);
    targetExpUnix = shortExpiries.length ? shortExpiries[0] : expiries[0];
  } else {
    const minSec = SHORT_TERM_MIN_DAYS * 24 * 3600;
    const shortExpiries = expiries.filter((e) => (e - nowSec) < SECONDS_180D && (e - nowSec) >= minSec);
    if (!shortExpiries.length) return { found: false, reason: 'no expiry with ' + SHORT_TERM_MIN_DAYS + ' to 180 days left for ' + ticker };
    targetExpUnix = shortExpiries[0];
  }

  const candidates = byExpiry[targetExpUnix] || [];
  let best: CallCandidate | null = null, bestDiff = Infinity;
  candidates.forEach((c) => {
    if (isNaN(c.delta)) return;
    const diff = Math.abs(c.delta - targetDelta);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  });
  if (!best) {
    return {
      found: false,
      reason: deltaFieldSeen
        ? 'no candidate with a usable delta at the selected expiry for ' + ticker
        : 'delta field appears missing from this feed -- cannot select by delta',
    };
  }
  const allCandidatesRanked = candidates
    .filter((c) => !isNaN(c.delta))
    .map((c) => Object.assign({}, c, { deltaDistance: Math.abs(c.delta - targetDelta) }))
    .sort((a, b) => a.deltaDistance - b.deltaDistance);
  return { found: true, contract: best, expUnix: targetExpUnix, deltaFieldSeen, allCandidates: allCandidatesRanked };
}

/** The 'OPTIONS_OVERLAY' property the stock analysis reads (getCachedOptions, storage/kv.ts). */
export interface OptionsOverlay {
  readonly ticker: string;
  readonly topCallStrike: string | null;
  readonly topCallConv: number | null;
  readonly topPutStrike: string | null;
  readonly topPutConv: number | null;
  readonly leapCallStrike: string | null;
  readonly leapCallConv: number | null;
  readonly leapPutStrike: string | null;
  readonly leapPutConv: number | null;
  readonly leap2CallStrike: string | null;
  readonly leap2CallConv: number | null;
  readonly leap2PutStrike: string | null;
  readonly leap2PutConv: number | null;
  readonly putCallRatio: number | null;
  readonly ivRank: number | null;
  readonly netBias: string;
  readonly _date: string;
}

/** runFullAnalysis :347-374: the top call/put overall and per LEAPS bucket, and the chain context. */
export function buildOptionsOverlay(ticker: string, contracts: readonly ScoredContract[], chainContext: ChainContext, now: Date, timeZone: string): OptionsOverlay {
  const byConv = (arr: ScoredContract[]): ScoredContract[] => arr.slice().sort((a, b) => b.conviction - a.conviction);
  const tc = byConv(contracts.filter((c) => c.side === 'call'))[0];
  const tp = byConv(contracts.filter((c) => c.side === 'put'))[0];
  const leaps1Calls = byConv(contracts.filter((c) => c.side === 'call' && c.bucket === 'LEAPS ~1yr'));
  const leaps1Puts = byConv(contracts.filter((c) => c.side === 'put' && c.bucket === 'LEAPS ~1yr'));
  const leaps2Calls = byConv(contracts.filter((c) => c.side === 'call' && c.bucket === 'LEAPS ~2yr'));
  const leaps2Puts = byConv(contracts.filter((c) => c.side === 'put' && c.bucket === 'LEAPS ~2yr'));
  const lc = leaps1Calls[0], lp = leaps1Puts[0];
  const l2c = leaps2Calls[0], l2p = leaps2Puts[0];
  return {
    ticker,
    topCallStrike: tc ? '$' + tc.strike : null,
    topCallConv: tc ? tc.conviction : null,
    topPutStrike: tp ? '$' + tp.strike : null,
    topPutConv: tp ? tp.conviction : null,
    leapCallStrike: lc ? '$' + lc.strike : null,
    leapCallConv: lc ? lc.conviction : null,
    leapPutStrike: lp ? '$' + lp.strike : null,
    leapPutConv: lp ? lp.conviction : null,
    leap2CallStrike: l2c ? '$' + l2c.strike : null,
    leap2CallConv: l2c ? l2c.conviction : null,
    leap2PutStrike: l2p ? '$' + l2p.strike : null,
    leap2PutConv: l2p ? l2p.conviction : null,
    putCallRatio: chainContext.putCallRatioOI,
    ivRank: chainContext.ivRankPct,
    netBias: chainContext.netBiasNote,
    _date: now.toLocaleDateString('en-US', { timeZone }),
  };
}

/** runFullAnalysis :346-376: write OPTIONS_OVERLAY (raw JSON, no TTL); a failure is logged, never thrown. */
export async function saveOptionsOverlay(
  deps: OptionsScoringDeps, ticker: string, contracts: readonly ScoredContract[], chainContext: ChainContext | null | undefined, log: OptionsLog,
): Promise<void> {
  try {
    const overlay = buildOptionsOverlay(ticker, contracts, chainContext as ChainContext, new Date(nowOf(deps)), deps.timeZone);
    await deps.kv.set(OPTIONS_OVERLAY_KEY, JSON.stringify(overlay));
    log('💾 Options overlay saved for ' + ticker);
  } catch (e) {
    log('⚠️ Overlay save skipped: ' + (e as Error).message);
  }
}
