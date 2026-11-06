/**
 * Options sentiment plan (docs/OPTIONS_SENTIMENT_PLAN.md), part A: the nightly per-stock options read.
 *
 *   A-2  readOfChain       one Cboe chain -> parseAndScore + computeChainContext (the same code as Analyze,
 *                          reports/options/run.ts), with the LEAPS OI persistence FROZEN at its neutral 50 (a kv stub that
 *                          neither reads nor writes OI_HIST_V2_), so the nightly adds no score input Analyze lacks.
 *        snapshotReadOf    the read in the existing _OPTIONS_SNAPSHOT format (saveOptionsSnapshot into a memory
 *                          workbook, read back with readOptionsSnapshot): what the analysis would see, byte for byte.
 *                          daysToExpiry is re-computed from the stored expiry date against the as-of time.
 *   A-5  gateRead          tonight's read; else the latest stored one when it is at most 2 trading days old; else not
 *                          applied. Trading days = weekdays (no holiday calendar: a holiday makes a read stale one day
 *                          early, the safe side).
 *   A-8  computeOptionsShadow   the "if applied" tech score, conviction, timing and action, while the real decision
 *                          runs as before (options not applied). Also the shadow columns for C-2 (net $ bias weighted
 *                          by delta-dollars) and C-3 (CONFIRM / CONFLICT against the tech score without options).
 *   P0   checksOf          total volume at the nightly hour (the market-closed formula?), delta / iv present, the
 *                          chain's JSON size and parse time: logged every night.
 *
 * Nothing here changes a score, a tier or a decision while the read is in shadow (OPTIONS_READ_APPLIED false).
 */

import { chainColumnsOf, parseOcc, type CboeChainJson } from '../../fetch/cboe.ts';
import { computeChainContext, parseAndScore, type ChainContext, type ScoredContract } from './conviction.ts';
import { MIN_DAYS_FOR_IV_CONTEXT } from './labels.ts';
import {
  analyzeOptionsForScoring, convictionLean, directionSignal, dollarWeightedAvgConviction, netBiasSignal, putCallSignal,
  type OptionsScoring, type OptionsSnapshot, type SnapshotContract,
} from './scoring.ts';
import type { PropertyStore } from '../../storage/kv.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../../sheets/reportSheet.ts';
import { saveOptionsSnapshot } from '../../reports/options/tabs.ts';
import { readOptionsSnapshot, type SnapshotRead } from '../../reports/options/run.ts';

/**
 * A-8 / A-9: false = shadow phase. The per-stock read is stored and shown "not yet applied"; the decision runs with
 * options as before. Go-live (P2) needs 10 shadow nights and the owner's yes.
 */
export const OPTIONS_READ_APPLIED = false;
/** A-5: a stored read older than this many trading days is not applied. */
export const OPTIONS_READ_MAX_AGE_TRADING_DAYS = 2;

/** A-2: the OI-persistence history stub (reads nothing, writes nothing): every LEAPS contract scores the neutral 50. */
export const FROZEN_OI_KV: PropertyStore = { get: async () => null, set: async () => {}, delete: async () => {} };

/** The fields stored per scored contract (📦 Options Read Snapshots), in this order. */
export const OPTIONS_READ_FIELDS: readonly string[] = [
  'side', 'strike', 'expiry', 'oi', 'vol', 'iv', 'dollarsCommitted', 'dollarScore', 'holdingScore', 'urgencyScore', 'timeScore', 'ivScore',
  'oiPersistenceScore', 'conviction', 'bucket',
];

export type OptionsReadStatus = 'ok' | 'no chain' | 'no contracts';

/** P0: what the raw chain looked like at the nightly hour. */
export interface OptionsReadChecks {
  /** Contracts in the raw chain. */
  readonly contracts: number;
  /** Sum of every contract's volume in the raw chain (0 = Cboe reports no volume at this hour). */
  readonly totalVolume: number;
  /** Contracts carrying a numeric delta / an iv above 0. */
  readonly withDelta: number;
  readonly withIv: number;
  /** The chain's JSON size (characters) and parse time, when measured. */
  readonly bytes: number | null;
  readonly parseMs: number | null;
}

export interface OptionsSignals {
  readonly pcSig: number;
  readonly domSig: number;
  readonly nbSig: number;
  readonly dirSig: number;
  readonly leapsLean: number;
  readonly leapsCalls: boolean;
  readonly leapsPuts: boolean;
}

/** C-2 shadow: the net $ bias weighted by delta-dollars (abs(delta) x spot x OI x 100; premium when delta is missing). */
export interface C2Shadow {
  readonly netBiasPct: number | null;
  readonly basis: 'delta' | 'premium' | 'mixed' | 'none';
  readonly nbSig: number;
  readonly dirSig: number;
}

/** One stock's read for one night. */
export interface OptionsRead {
  readonly v: 1;
  readonly day: string;
  readonly ticker: string;
  readonly status: OptionsReadStatus;
  /** The run time the read was taken (ISO, UTC). */
  readonly asOfUtc: string;
  /** Cboe's own timestamp, when the JSON carries one. */
  readonly cboeTime: string | null;
  readonly spot: number | null;
  /** The scorer's market-closed formula was used (scored contracts' volume 0). */
  readonly marketClosed: boolean;
  readonly checks: OptionsReadChecks;
  readonly context: ChainContext | null;
  readonly signals: OptionsSignals | null;
  readonly c2: C2Shadow | null;
  readonly fields: readonly string[];
  readonly rows: ReadonlyArray<ReadonlyArray<string | number | null>>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const DAY_MS = 86_400_000;

/** P0: the raw chain's size, volume and greeks. */
export function checksOf(json: CboeChainJson | null, stats?: { readonly bytes: number; readonly parseMs: number } | null): OptionsReadChecks {
  const opts = json?.data?.options ?? [];
  let totalVolume = 0, withDelta = 0, withIv = 0;
  for (const o of opts) {
    totalVolume += Number(o.volume) || 0;
    if (num(o.delta) != null) withDelta++;
    if ((num(o.iv) ?? 0) > 0) withIv++;
  }
  return { contracts: opts.length, totalVolume, withDelta, withIv, bytes: stats ? stats.bytes : null, parseMs: stats ? Math.round(stats.parseMs) : null };
}

/** Cboe's timestamp, as given (the delayed-quotes JSON has a top-level `timestamp`); null when absent. */
function cboeTimeOf(json: CboeChainJson | null): string | null {
  const t = json?.['timestamp'] ?? json?.data?.['last_trade_time'];
  return typeof t === 'string' && t ? t : null;
}

const expiryDayOf = (c: ScoredContract): string | null => (c.expiry ? new Date(c.expiry.getTime()).toISOString().slice(0, 10) : null);

/** C-2: delta-dollar net bias over the whole chain (the same contracts computeChainContext reads: strike > 0, OI > 0). */
export function deltaDollarBias(json: CboeChainJson | null, spot: number | null): { netBiasPct: number | null; basis: C2Shadow['basis'] } {
  let call = 0, put = 0, withDelta = 0, withPremium = 0;
  for (const o of json?.data?.options ?? []) {
    if (!o.option) continue;
    const p = parseOcc(String(o.option));
    const oi = Number(o.open_interest) || 0;
    if (!(p.strike > 0) || oi === 0) continue;
    const d = num(o.delta);
    let w: number;
    if (d != null && spot != null && spot > 0) { w = Math.abs(d) * spot * oi * 100; withDelta++; }
    else {
      const bid = Number(o.bid) || 0, ask = Number(o.ask) || 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (Number(o.last_trade_price) || Number(o.close) || 0);
      w = mid * oi * 100; withPremium++;
    }
    if (p.side === 'call') call += w; else put += w;
  }
  const total = call + put;
  const basis: C2Shadow['basis'] = withDelta && withPremium ? 'mixed' : withDelta ? 'delta' : withPremium ? 'premium' : 'none';
  return { netBiasPct: total > 0 ? Math.round(((call - put) / total) * 100) : null, basis };
}

/** A-2: tonight's read of one chain (null chain = "no chain"). Never throws for a malformed chain: it reads "no contracts". */
export async function readOfChain(
  json: CboeChainJson | null, ticker: string, day: string, nowMs: number, timeZone: string,
  stats?: { readonly bytes: number; readonly parseMs: number } | null,
): Promise<OptionsRead> {
  const t = ticker.toUpperCase();
  const checks = checksOf(json, stats);
  const base = { v: 1 as const, day, ticker: t, asOfUtc: new Date(nowMs).toISOString(), cboeTime: cboeTimeOf(json), checks, fields: OPTIONS_READ_FIELDS };
  const cols = chainColumnsOf(json);
  const spot = num(json?.data?.current_price);
  if (!json || !cols || !cols.strike.length) {
    return { ...base, status: 'no chain', spot, marketClosed: false, context: null, signals: null, c2: null, rows: [] };
  }
  const contracts = await parseAndScore({ kv: FROZEN_OI_KV, timeZone, clock: { now: () => nowMs } as never }, cols, null, t);
  if (!contracts.length) {
    return { ...base, status: 'no contracts', spot, marketClosed: false, context: null, signals: null, c2: null, rows: [] };
  }
  const context = computeChainContext(contracts.fullChain || contracts, { minIvDays: MIN_DAYS_FOR_IV_CONTEXT });
  const rows = contracts.map((c) => [
    c.side, c.strike, expiryDayOf(c), c.oi, c.vol, c.iv, c.dollarsCommitted, c.dollarScore, c.holdingScore, c.urgencyScore, c.timeScore, c.ivScore,
    c.oiPersistenceScore, c.conviction, c.bucket,
  ]);
  const marketClosed = contracts.reduce((s, c) => s + c.vol, 0) === 0;
  const partial: OptionsRead = { ...base, status: 'ok', spot, marketClosed, context, signals: null, c2: null, rows };
  const snap = await snapshotReadOf(partial, nowMs, timeZone);
  const signals = signalsOf(snap);
  const dd = deltaDollarBias(json, spot);
  const c2nb = netBiasSignal(dd.netBiasPct);
  const c2: C2Shadow = { netBiasPct: dd.netBiasPct, basis: dd.basis, nbSig: c2nb, dirSig: signals ? directionSignal(signals.pcSig, signals.domSig, c2nb) : 0 };
  return { ...partial, signals, c2 };
}

/** The read's contracts as the scorer's objects (expiry label and days re-computed against `asOfMs`). */
function contractsOf(r: OptionsRead, asOfMs: number): Array<Record<string, unknown>> {
  const at = (k: string): number => r.fields.indexOf(k);
  return r.rows.map((row) => {
    const o: Record<string, unknown> = {};
    for (const k of r.fields) o[k] = row[at(k)];
    const exp = typeof o['expiry'] === 'string' ? Date.parse(String(o['expiry']) + 'T00:00:00Z') : NaN;
    o['expiryStr'] = Number.isFinite(exp) ? new Date(exp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'N/A';
    o['daysToExpiry'] = Number.isFinite(exp) ? Math.max(1, Math.round((exp - asOfMs) / DAY_MS)) : 730;
    return o;
  });
}

/**
 * A-4: the read in the _OPTIONS_SNAPSHOT format, written into a memory workbook and read back exactly as the analysis
 * reads it (readOptionsSnapshot). `nowMs` sets ageDays. Null for a read without contracts.
 */
export async function snapshotReadOf(r: OptionsRead, nowMs: number, timeZone: string): Promise<SnapshotRead | null> {
  const wb = await seedOptionsWorkbook(r);
  return wb ? readOptionsSnapshot(wb, r.ticker, nowMs, timeZone) : null;
}

/** A memory workbook holding only this read's _OPTIONS_SNAPSHOT tab (null for a read without contracts). */
export async function seedOptionsWorkbook(r: OptionsRead): Promise<ReportWorkbook | null> {
  if (r.status !== 'ok' || !r.rows.length) return null;
  const asOfMs = Date.parse(r.asOfUtc);
  const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
  saveOptionsSnapshot(wb, r.ticker, contractsOf(r, asOfMs) as unknown as ScoredContract[], r.context, r.spot, { nowMs: asOfMs, timeZone: 'UTC', legacyText: false });
  return wb;
}

/** pcSig, domSig, nbSig, dirSig and the LEAPS lean of a snapshot, the same arithmetic as analyzeOptionsForScoring. */
export function signalsOf(snap: OptionsSnapshot | null): OptionsSignals | null {
  if (!snap || snap.mismatch || !snap.contracts || !snap.contracts.length) return null;
  const cs = snap.contracts, ctx = snap.context || {};
  const side = (s: string, f: (c: SnapshotContract) => boolean = () => true): SnapshotContract[] => cs.filter((c) => c.side === s && f(c));
  const pcSig = putCallSignal(ctx.putCallRatioOI ?? null);
  const domSig = convictionLean(dollarWeightedAvgConviction(side('call')), dollarWeightedAvgConviction(side('put')));
  const nbSig = netBiasSignal(ctx.netBiasPct ?? null);
  const far = (c: SnapshotContract): boolean => (c.daysToExpiry as number) > 365;
  const leapsLean = convictionLean(dollarWeightedAvgConviction(side('call', far)), dollarWeightedAvgConviction(side('put', far)));
  return { pcSig, domSig, nbSig, dirSig: directionSignal(pcSig, domSig, nbSig), leapsLean, leapsCalls: side('call', far).length > 0, leapsPuts: side('put', far).length > 0 };
}

// ───────────────────────── A-5: dates and the staleness gate ─────────────────────────

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const weekday = (day: string): number => new Date(day + 'T12:00:00Z').getUTCDay();

/**
 * The trading day tonight's chains describe: the date in `timeZone`; before 09:30 there (a run after midnight) the day
 * before; a Saturday or Sunday rolls back to Friday. No holiday calendar.
 */
export function optionsNightDay(nowMs: number, timeZone: string): string {
  const d = new Date(nowMs).toLocaleDateString('en-CA', { timeZone });
  const hm = new Date(nowMs).toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let ms = Date.parse(d + 'T12:00:00Z');
  if (hm < '09:30') ms -= DAY_MS;
  while ([0, 6].includes(new Date(ms).getUTCDay())) ms -= DAY_MS;
  return ymd(ms);
}

/**
 * Owner 2026-11-05 (bug seen 4 Nov): true while the US market is open (weekday 09:30-16:15 in `timeZone`, the
 * script's New York zone). A run then (a manual daytime run) reads an intraday chain under today's label; storing
 * it would take the night's slot (rows are written once per day) and block the proper after-close read.
 */
export function optionsMarketHours(nowMs: number, timeZone: string): boolean {
  const day = new Date(nowMs).toLocaleDateString('en-US', { timeZone, weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return false;
  const hm = new Date(nowMs).toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return hm >= '09:30' && hm < '16:15';
}

/** Weekdays d with from < d <= to (0 when to <= from). */
export function tradingDaysBetween(from: string, to: string): number {
  let n = 0;
  for (let ms = Date.parse(from + 'T12:00:00Z') + DAY_MS, end = Date.parse(to + 'T12:00:00Z'); ms <= end; ms += DAY_MS) {
    if (![0, 6].includes(weekday(ymd(ms)))) n++;
  }
  return n;
}

export interface GatedRead {
  readonly read: OptionsRead | null;
  readonly source: 'tonight' | 'stored' | 'none';
  readonly ageTradingDays: number | null;
  /** True when the read may be applied (fresh enough and has contracts). */
  readonly fresh: boolean;
  /** Plain reason when not fresh. */
  readonly note: string;
}

/** A-5: tonight's read if it worked; else the stored one if <= 2 trading days old; else not applied. */
export function gateRead(tonight: OptionsRead | null, stored: OptionsRead | null, today: string, maxAge = OPTIONS_READ_MAX_AGE_TRADING_DAYS): GatedRead {
  if (tonight && tonight.status === 'ok') return { read: tonight, source: 'tonight', ageTradingDays: 0, fresh: true, note: '' };
  if (stored && stored.status === 'ok') {
    const age = tradingDaysBetween(stored.day, today);
    return age <= maxAge
      ? { read: stored, source: 'stored', ageTradingDays: age, fresh: true, note: '' }
      : { read: stored, source: 'stored', ageTradingDays: age, fresh: false, note: 'Options read is ' + age + ' trading days old' };
  }
  const t = tonight?.ticker ?? stored?.ticker ?? '';
  return { read: null, source: 'none', ageTradingDays: null, fresh: false, note: 'No options read for ' + t + ' tonight' };
}

// ───────────────────────── A-8: the shadow ("if applied") ─────────────────────────

type Dir = 'confirm' | 'conflict' | 'neutral';

export interface OptionsShadow {
  readonly ticker: string;
  readonly readDay: string;
  readonly source: GatedRead['source'];
  readonly ageTradingDays: number | null;
  readonly confirm: Dir;
  readonly dirSig: number;
  readonly leapsLean: number;
  readonly techNow: number;
  readonly techIfApplied: number;
  readonly convictionNow: number;
  readonly convictionIfApplied: number;
  readonly timingNow: string;
  readonly timingIfApplied: string;
  readonly actionNow: string;
  readonly actionIfApplied: string;
  /** C-3: the tech score without the Options category, and CONFIRM / CONFLICT against it. */
  readonly techExOptions: number;
  readonly c3Confirm: Dir;
  /** C-2: dirSig with the delta-dollar net bias, and CONFIRM / CONFLICT from it (against the tech score if applied). */
  readonly c2DirSig: number | null;
  readonly c2Confirm: Dir | null;
}

/** The legacy direction rule (scoring.ts): tech >= 55 up, <= 45 down; options dirSig >= 0.34 up, <= -0.34 down. */
export function confirmOf(techScore: number | null, dirSig: number): Dir {
  const t = techScore ?? 0;
  const techDir = t >= 55 ? 1 : t <= 45 ? -1 : 0;
  const optDir = dirSig >= 0.34 ? 1 : dirSig <= -0.34 ? -1 : 0;
  return techDir !== 0 && optDir !== 0 ? (techDir === optDir ? 'confirm' : 'conflict') : 'neutral';
}

/** What the analysis ran tonight, and how to re-run its scoring with another options read. */
export interface ShadowInputs<T extends { techScore: number; timing: string }, D extends { finalConviction: number; action: string }> {
  readonly gated: GatedRead;
  readonly snap: SnapshotRead | null;
  readonly techPlan: T;
  readonly decision: D;
  /** Tonight's options read as the analysis used it (usually not available). */
  readonly optAnalysis: OptionsScoring;
  /** computeTechnicalPlan with the given options read (the run's own inputs). */
  readonly plan: (opt: OptionsScoring) => T;
  /** synthesizeDecision with the given plan and options read. */
  readonly decide: (tech: T, opt: OptionsScoring) => D;
}

/**
 * A-8: the "if applied" numbers. Null when there is no read with contracts, or the read is too old to be applied (A-5:
 * then "if applied" equals tonight). Pure apart from the injected plan / decide.
 */
export function computeOptionsShadow<T extends { techScore: number; timing: string; options?: unknown }, D extends { finalConviction: number; action: string }>(
  ticker: string, x: ShadowInputs<T, D>,
): OptionsShadow | null {
  const r = x.gated.read;
  if (!r || !x.snap || !x.gated.fresh) return null;
  const opt0 = analyzeOptionsForScoring(x.snap, null, { plainLabels: true });
  if (!opt0.available) return null;
  const tech = x.plan(opt0);
  const opt = analyzeOptionsForScoring(x.snap, tech, { plainLabels: true });
  tech.options = opt;
  const dec = x.decide(tech, opt);
  const techEx = x.optAnalysis.available ? x.plan(analyzeOptionsForScoring(null, null)).techScore : x.techPlan.techScore;
  const c2DirSig = r.c2 ? r.c2.dirSig : null;
  return {
    ticker, readDay: r.day, source: x.gated.source, ageTradingDays: x.gated.ageTradingDays,
    confirm: opt.confirm, dirSig: opt.dirSig, leapsLean: opt.leapsLean,
    techNow: x.techPlan.techScore, techIfApplied: tech.techScore,
    convictionNow: x.decision.finalConviction, convictionIfApplied: dec.finalConviction,
    timingNow: x.techPlan.timing, timingIfApplied: tech.timing,
    actionNow: x.decision.action, actionIfApplied: dec.action,
    techExOptions: techEx, c3Confirm: confirmOf(techEx, opt.dirSig),
    c2DirSig, c2Confirm: c2DirSig == null ? null : confirmOf(tech.techScore, c2DirSig),
  };
}

const signed = (n: number): string => (n > 0 ? '+' : '') + n;

/** The owner-facing shadow line (Buy report, A-8): "options read 2026-10-30, not yet applied: CONFIRM, +8 if applied ...". */
export function shadowLine(s: OptionsShadow): string {
  const d = s.convictionIfApplied - s.convictionNow;
  const bits = [s.confirm.toUpperCase(), signed(d) + ' conviction if applied (' + s.convictionNow + ' → ' + s.convictionIfApplied + ')'];
  if (s.techIfApplied !== s.techNow) bits.push('tech ' + s.techNow + ' → ' + s.techIfApplied);
  if (s.timingIfApplied !== s.timingNow) bits.push('timing ' + s.timingNow + ' → ' + s.timingIfApplied);
  const when = s.source === 'stored' ? ' (stored read, ' + s.ageTradingDays + ' trading day' + (s.ageTradingDays === 1 ? '' : 's') + ' old)' : '';
  return s.ticker + ' — options read ' + s.readDay + when + ', not yet applied: ' + bits.join(', ') + '.';
}
