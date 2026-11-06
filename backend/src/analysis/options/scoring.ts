/**
 * analyzeOptionsForScoringV7 (fullStockAnalysisV10_9.gs:8900-8986), ported
 * exactly: the options snapshot read through analyst conventions --
 *   dirSig    near/mid timing direction: 40% put/call OI, 35% dollar-weighted
 *             call-vs-put conviction (/40), 25% net $ bias (/40), in [-1, 1]
 *   leapsLean the same conviction comparison over >365-day contracts
 *   ivRank    passed through (a risk modifier, not direction)
 *   horizon   the top call/put expiring within max(45, 2 x ETA) days
 *   confirm   'confirm' / 'conflict' against the technical direction
 * `techPlan` may be null (the first pass, before the tech plan exists).
 * The result satisfies DecisionOptions (analysis/decision.ts) and the
 * pipeline's options input.
 *
 * F-63: a null techScore counts as bearish (null <= 45 is true in JS), as in legacy.
 */

import { IV_CHAIN_PCT_LABEL, PUT_CALL_LABEL, putCallText } from './labels.ts';

/** One row of the options snapshot (readOptionsSnapshotV7's contracts). */
export interface SnapshotContract {
  readonly side?: string;
  readonly strike?: number;
  readonly expiryStr?: unknown;
  readonly daysToExpiry?: number;
  readonly dollarsCommitted?: number;
  readonly conviction?: number | null;
  readonly [field: string]: unknown;
}

export interface OptionsSnapshot {
  readonly mismatch?: boolean;
  readonly contracts?: readonly SnapshotContract[];
  readonly context?: { readonly putCallRatioOI?: number | null; readonly netBiasPct?: number | null; readonly ivRankPct?: number | null; readonly [field: string]: unknown };
  readonly [field: string]: unknown;
}

/** The tech-plan fields read here (an entryPlan TechPlan qualifies). */
export interface OptionsHorizonPlan {
  readonly techScore?: number | null;
  readonly timeToEntry?: { readonly baseDays?: number | null } | null;
  readonly t1Time?: { readonly baseDays?: number | null } | null;
}

export interface OptionsPick {
  readonly strike: number | undefined;
  readonly conv: number | null | undefined;
  readonly expiry: unknown;
  readonly days?: number | undefined;
}

export interface OptionsScoring {
  available: boolean;
  dirSig: number;
  leapsLean: number;
  ivRank: number | null;
  confirm: 'neutral' | 'confirm' | 'conflict';
  putCallOI: number | null;
  netBiasPct: number | null;
  topCall: OptionsPick | null;
  topPut: OptionsPick | null;
  leapCall: OptionsPick | null;
  leapPut: OptionsPick | null;
  horizon: { readonly days: number; readonly topCall: OptionsPick | null; readonly topPut: OptionsPick | null } | null;
  notes: string[];
}

/** dollarWeightedAvgConvictionV7_ (:8921-8927): conviction averaged by $ committed; null without dollars. */
export function dollarWeightedAvgConviction(contracts: readonly SnapshotContract[]): number | null {
  const withDollars = contracts.filter((c) => (c.dollarsCommitted as number) > 0 && c.conviction != null);
  if (!withDollars.length) return null;
  const totalDollars = withDollars.reduce((s, c) => s + (c.dollarsCommitted as number), 0);
  if (totalDollars <= 0) return null;
  return withDollars.reduce((s, c) => s + (c.conviction as number) * (c.dollarsCommitted as number), 0) / totalDollars;
}

/** The put/call OI band (pcSig): <= 0.6 -> 1, <= 0.8 -> 0.5, <= 1.1 -> 0, <= 1.4 -> -0.5, else -1; 0 without a ratio. */
export function putCallSignal(pc: number | null): number {
  return pc == null ? 0 : pc <= 0.6 ? 1 : pc <= 0.8 ? 0.5 : pc <= 1.1 ? 0 : pc <= 1.4 ? -0.5 : -1;
}

/** The net $ bias signal (nbSig): the bias % / 40, in [-1, 1]; 0 without a bias. */
export function netBiasSignal(nb: number | null): number {
  return nb == null ? 0 : Math.max(-1, Math.min(1, nb / 40));
}

/** Call minus put $-weighted conviction / 40, in [-1, 1] (domSig, and the LEAPS lean); 0 when either side is missing. */
export function convictionLean(callConv: number | null, putConv: number | null): number {
  return (callConv != null && putConv != null) ? Math.max(-1, Math.min(1, (callConv - putConv) / 40)) : 0;
}

/** dirSig: 40% put/call OI, 35% conviction dominance, 25% net $ bias, in [-1, 1]. */
export function directionSignal(pcSig: number, domSig: number, nbSig: number): number {
  return Math.max(-1, Math.min(1, 0.40 * pcSig + 0.35 * domSig + 0.25 * nbSig));
}

/**
 * `opts.plainLabels` (production; parity runs leave it unset): the two notes use the words every page uses (D4: the
 * whole-chain put/call ratio with the scoring bands' words; B3: "IV vs this chain (percentile)"). Notes are text only.
 */
export function analyzeOptionsForScoring(snap: OptionsSnapshot | null | undefined, techPlan: OptionsHorizonPlan | null | undefined, opts: { readonly plainLabels?: boolean } = {}): OptionsScoring {
  const out: OptionsScoring = {
    available: false, dirSig: 0, leapsLean: 0, ivRank: null, confirm: 'neutral',
    putCallOI: null, netBiasPct: null, topCall: null, topPut: null, leapCall: null, leapPut: null,
    horizon: null, notes: [],
  };
  if (!snap || snap.mismatch || !snap.contracts || !snap.contracts.length) return out;
  out.available = true;
  const cs = snap.contracts;
  const ctx: NonNullable<OptionsSnapshot['context']> = snap.context || {};
  const calls = cs.filter((c) => c.side === 'call'), puts = cs.filter((c) => c.side === 'put');
  const byConv = (a: readonly SnapshotContract[]): SnapshotContract[] => a.slice().sort((x, y) => (y.conviction || 0) - (x.conviction || 0));

  const pc = (ctx.putCallRatioOI != null) ? ctx.putCallRatioOI : null; out.putCallOI = pc;
  const pcSig = putCallSignal(pc);

  const tC = byConv(calls)[0], tP = byConv(puts)[0];
  out.topCall = tC ? { strike: tC.strike, conv: tC.conviction, expiry: tC.expiryStr, days: tC.daysToExpiry } : null;
  out.topPut = tP ? { strike: tP.strike, conv: tP.conviction, expiry: tP.expiryStr, days: tP.daysToExpiry } : null;
  const aggCallConv = dollarWeightedAvgConviction(calls), aggPutConv = dollarWeightedAvgConviction(puts);
  const domSig = convictionLean(aggCallConv, aggPutConv);

  const nb = (ctx.netBiasPct != null) ? ctx.netBiasPct : null; out.netBiasPct = nb;
  const nbSig = netBiasSignal(nb);

  out.dirSig = directionSignal(pcSig, domSig, nbSig);

  const leapsCalls = calls.filter((c) => (c.daysToExpiry as number) > 365), leapsPuts = puts.filter((c) => (c.daysToExpiry as number) > 365);
  const lC = byConv(leapsCalls)[0];
  const lP = byConv(leapsPuts)[0];
  out.leapCall = lC ? { strike: lC.strike, conv: lC.conviction, expiry: lC.expiryStr, days: lC.daysToExpiry } : null;
  out.leapPut = lP ? { strike: lP.strike, conv: lP.conviction, expiry: lP.expiryStr, days: lP.daysToExpiry } : null;
  const aggLeapCallConv = dollarWeightedAvgConviction(leapsCalls), aggLeapPutConv = dollarWeightedAvgConviction(leapsPuts);
  out.leapsLean = convictionLean(aggLeapCallConv, aggLeapPutConv);

  out.ivRank = (ctx.ivRankPct != null) ? ctx.ivRankPct : null;

  const etaDays = techPlan && techPlan.timeToEntry && techPlan.timeToEntry.baseDays != null ? techPlan.timeToEntry.baseDays
    : techPlan && techPlan.t1Time && techPlan.t1Time.baseDays != null ? techPlan.t1Time.baseDays : null;
  if (etaDays != null) {
    const hi = Math.max(45, etaDays * 2);
    const win = cs.filter((c) => (c.daysToExpiry as number) >= 0 && (c.daysToExpiry as number) <= hi);
    const wc = byConv(win.filter((c) => c.side === 'call'))[0], wp = byConv(win.filter((c) => c.side === 'put'))[0];
    out.horizon = {
      days: Math.round(hi),
      topCall: wc ? { strike: wc.strike, conv: wc.conviction, expiry: wc.expiryStr } : null,
      topPut: wp ? { strike: wp.strike, conv: wp.conviction, expiry: wp.expiryStr } : null,
    };
  }

  const techScore = techPlan ? (techPlan.techScore as number) : 0;
  const techDir = techPlan ? (techScore >= 55 ? 1 : techScore <= 45 ? -1 : 0) : 0;
  const optDir = out.dirSig >= 0.34 ? 1 : out.dirSig <= -0.34 ? -1 : 0;
  if (techDir !== 0 && optDir !== 0) out.confirm = (techDir === optDir) ? 'confirm' : 'conflict';

  if (opts.plainLabels) out.notes.push(PUT_CALL_LABEL + ' ' + putCallText(pc));
  else out.notes.push('Put/Call OI ' + (pc != null ? pc.toFixed(2) : 'N/A') + (pcSig > 0 ? ' (call-heavy/bullish)' : pcSig < 0 ? ' (put-heavy/bearish)' : ' (neutral)'));
  if (tC && tP) out.notes.push('Top call conv ' + tC.conviction + ' vs top put conv ' + tP.conviction);
  // Options weights due diligence 2026-11-06 (4.7 item 5): nothing in the data says who holds a contract, so the
  // production label describes the balance only. Parity runs keep legacy's words.
  if (opts.plainLabels) out.notes.push('LEAPS call/put balance ' + (out.leapsLean > 0.15 ? 'call-heavy' : out.leapsLean < -0.15 ? 'put-heavy' : 'even') + ' (not a tested signal)');
  else out.notes.push('LEAPS lean ' + (out.leapsLean > 0.15 ? 'bullish (institutions accumulating)' : out.leapsLean < -0.15 ? 'bearish/hedged' : 'neutral'));
  if (out.ivRank != null) out.notes.push((opts.plainLabels ? IV_CHAIN_PCT_LABEL + ' ' : 'IV %ile ') + out.ivRank + (out.ivRank >= 80 ? ' (elevated — event/fear priced in)' : out.ivRank <= 20 ? ' (low — complacent)' : ''));
  return out;
}
