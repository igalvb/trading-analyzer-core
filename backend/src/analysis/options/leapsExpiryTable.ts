/**
 * Owner 2026-10-30: the LEAPS expiry comparison on the 📞 Options Decision page (and so in the PDF). Display only:
 * built from the full Cboe chain the options run already fetched; no score, pick or verdict reads it.
 *
 * For every call expiry 9 to 36 calendar months out, one row: the strike whose delta is closest to the aim (same rule
 * as selectRecommendedCall: the first strike in chain order with the smallest |delta - aim|), its bid/ask, the cost of
 * one contract (ask x 100), the breakeven (strike + ask), the rise the stock needs to reach it, that rise per year
 * ((1 + rise)^(365 / days) - 1), the open interest, the sell-by date (expiry - 60 days) and James's break-even gate
 * (per year <= 12%). The engine's pick and James's pick (the January expiry nearest 19 months, within 13-26 months)
 * are marked.
 */

import { parseOcc, type CboeChainJson } from '../../fetch/cboe.ts';
import { formatDateInTz, occExpiryText } from '../../core/dates.ts';
import { EXPIRY_WARNING_DAYS_LEAPS } from '../optionsExitRead.ts';

export const LEAPS_TABLE_MIN_MONTHS = 9;
export const LEAPS_TABLE_MAX_MONTHS = 36;
/** James's break-even gate: the stock must not need more than this rise per year. */
export const JAMES_PER_YEAR_GATE = 0.12;
export const JAMES_TARGET_MONTHS = 19;
export const JAMES_MIN_MONTHS = 13;
export const JAMES_MAX_MONTHS = 26;
export const LEAPS_TABLE_DELTAS: readonly number[] = [0.75, 0.80];

export interface LeapsExpiryRow {
  readonly expUnix: number;
  readonly days: number;
  readonly strike: number;
  readonly delta: number;
  readonly bid: number;
  readonly ask: number;
  readonly openInterest: number;
  /** ask x 100; null with no ask. */
  readonly cost: number | null;
  readonly breakeven: number | null;
  /** breakeven / price - 1. */
  readonly rise: number | null;
  readonly perYear: number | null;
  readonly sellByUnix: number;
  readonly passesGate: boolean;
}

export interface LeapsExpiryBlock {
  readonly targetDelta: number;
  readonly rows: readonly LeapsExpiryRow[];
}

export interface LeapsExpiryComparison {
  readonly price: number | null;
  readonly blocks: readonly LeapsExpiryBlock[];
  /** James's pick: the January expiry nearest 19 months, within 13-26 months; null when none. */
  readonly jamesExpUnix: number | null;
  /** Expiries skipped because no strike there had a usable delta. */
  readonly noDelta: readonly number[];
}

const DAY_SEC = 86_400;

/** `ymd` (yyyy-MM-dd) plus `months` calendar months, at 00:00 UTC in Unix seconds (day clamped to the month's end). */
function addMonthsSec(ymd: string, months: number): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)) / 1000;
}

interface Cand { readonly strike: number; readonly delta: number; readonly bid: number; readonly ask: number; readonly oi: number }

export function buildLeapsExpiryComparison(json: CboeChainJson | null | undefined, nowMs: number, timeZone: string, deltas: readonly number[] = LEAPS_TABLE_DELTAS): LeapsExpiryComparison | null {
  const opts = json?.data?.options;
  if (!opts || !opts.length) return null;
  const priceRaw = Number(json?.data?.current_price);
  const price = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null;
  const today = formatDateInTz(new Date(nowMs), timeZone, 'yyyy-MM-dd');
  const todaySec = Date.parse(today + 'T00:00:00Z') / 1000;
  const lo = addMonthsSec(today, LEAPS_TABLE_MIN_MONTHS), hi = addMonthsSec(today, LEAPS_TABLE_MAX_MONTHS);

  const byExpiry = new Map<number, Cand[]>();
  for (const o of opts) {
    if (!o || !o.option) continue;
    const p = parseOcc(o.option);
    if (p.side !== 'call' || p.expUnix < lo || p.expUnix > hi) continue;
    const list = byExpiry.get(p.expUnix) ?? [];
    list.push({ strike: p.strike, delta: o.delta == null ? NaN : Number(o.delta), bid: Number(o.bid) || 0, ask: Number(o.ask) || 0, oi: Number(o.open_interest) || 0 });
    byExpiry.set(p.expUnix, list);
  }
  const expiries = [...byExpiry.keys()].sort((a, b) => a - b);

  const noDelta = expiries.filter((e) => !(byExpiry.get(e) as Cand[]).some((c) => !isNaN(c.delta)));
  const blocks = deltas.map((target): LeapsExpiryBlock => {
    const rows: LeapsExpiryRow[] = [];
    for (const e of expiries) {
      let best: Cand | null = null, bestDiff = Infinity;
      for (const c of byExpiry.get(e) as Cand[]) {
        if (isNaN(c.delta)) continue;
        const diff = Math.abs(c.delta - target);
        if (diff < bestDiff) { bestDiff = diff; best = c; }
      }
      if (!best) continue;
      const days = Math.round((e - todaySec) / DAY_SEC);
      const hasAsk = best.ask > 0;
      const breakeven = hasAsk ? best.strike + best.ask : null;
      const rise = breakeven != null && price != null ? breakeven / price - 1 : null;
      const perYear = rise != null && days > 0 && 1 + rise > 0 ? Math.pow(1 + rise, 365 / days) - 1 : null;
      rows.push({
        expUnix: e, days, strike: best.strike, delta: best.delta, bid: best.bid, ask: best.ask, openInterest: best.oi,
        cost: hasAsk ? best.ask * 100 : null, breakeven, rise, perYear,
        sellByUnix: e - EXPIRY_WARNING_DAYS_LEAPS * DAY_SEC, passesGate: perYear != null && perYear <= JAMES_PER_YEAR_GATE,
      });
    }
    return { targetDelta: target, rows };
  });

  // James: January expiries within 13-26 months; the one nearest 19 months (the earlier on a tie).
  const jLo = addMonthsSec(today, JAMES_MIN_MONTHS), jHi = addMonthsSec(today, JAMES_MAX_MONTHS), jT = addMonthsSec(today, JAMES_TARGET_MONTHS);
  let jamesExpUnix: number | null = null;
  for (const e of expiries) {
    if (new Date(e * 1000).getUTCMonth() !== 0 || e < jLo || e > jHi || noDelta.includes(e)) continue;
    if (jamesExpUnix == null || Math.abs(e - jT) < Math.abs(jamesExpUnix - jT)) jamesExpUnix = e;
  }
  return { price, blocks, jamesExpUnix, noDelta };
}

/** Attached to the LEAPS pick by the options run (non-enumerable: nothing that copies or serialises the pick changes). */
export const EXPIRY_COMPARISON_KEY = 'expiryComparison';

export function attachLeapsExpiryComparison<T extends object>(pick: T, table: LeapsExpiryComparison | null): T {
  if (table) Object.defineProperty(pick, EXPIRY_COMPARISON_KEY, { value: table, enumerable: false, configurable: true });
  return pick;
}

export function leapsExpiryComparisonOf(pick: unknown): LeapsExpiryComparison | null {
  return pick && typeof pick === 'object' ? ((pick as Record<string, unknown>)[EXPIRY_COMPARISON_KEY] as LeapsExpiryComparison | undefined) ?? null : null;
}

const money = (n: number): string => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number | null): string => (n == null ? '—' : (n * 100).toFixed(1) + '%');
const isoDay = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);

/** The page lines. `enginePick` marks the engine's current LEAPS contract (expiry, and strike when it matches). */
export function leapsExpiryComparisonLines(t: LeapsExpiryComparison, enginePick: { readonly strike: number; readonly expUnix: number } | null): string[] {
  const out = ['LEAPS EXPIRY COMPARISON (every call expiry ' + LEAPS_TABLE_MIN_MONTHS + ' to ' + LEAPS_TABLE_MAX_MONTHS + ' months out, from the full Cboe chain)',
    '  Rise = breakeven (strike + ask) vs the stock' + (t.price != null ? ' at ' + money(t.price) : ' (price not available)')
      + '; per year = (1 + rise)^(365 / days) − 1; ✅ = per year ≤ ' + (JAMES_PER_YEAR_GATE * 100) + '% (James\'s break-even gate); sell by = expiry − ' + EXPIRY_WARNING_DAYS_LEAPS + ' days.',
    '  ◀ ENGINE = the engine\'s current LEAPS pick; ◀ JAMES = James\'s pick (the January expiry nearest ' + JAMES_TARGET_MONTHS + ' months, within ' + JAMES_MIN_MONTHS + '–' + JAMES_MAX_MONTHS + ' months).'];
  for (const b of t.blocks) {
    out.push('', '  Strike with delta closest to ' + b.targetDelta.toFixed(2) + ':');
    if (!b.rows.length) { out.push('    No call expiry with a usable delta in this window.'); continue; }
    out.push('    Expiry · strike · delta · bid/ask · cost · breakeven · rise · per year · OI · sell by · gate');
    for (const r of b.rows) {
      const marks = [
        enginePick && enginePick.expUnix === r.expUnix ? '◀ ENGINE' + (enginePick.strike !== r.strike ? ' (its strike $' + enginePick.strike + ')' : '') : '',
        t.jamesExpUnix === r.expUnix ? '◀ JAMES' : '',
      ].filter(Boolean).join(' ');
      out.push('    ' + [
        occExpiryText(r.expUnix) + ' (' + r.days + 'd)', '$' + r.strike, r.delta.toFixed(2), money(r.bid) + '/' + money(r.ask),
        r.cost != null ? money(r.cost) : '—', r.breakeven != null ? money(r.breakeven) : '—', pct(r.rise), pct(r.perYear),
        String(r.openInterest), isoDay(r.sellByUnix), r.perYear == null ? '—' : r.passesGate ? '✅' : '✗',
      ].join(' · ') + (marks ? '  ' + marks : ''));
    }
  }
  if (t.noDelta.length) out.push('  No usable delta (left out): ' + t.noDelta.map(occExpiryText).join(', ') + '.');
  if (enginePick && !t.blocks.some((b) => b.rows.some((r) => r.expUnix === enginePick.expUnix))) {
    out.push('  The engine\'s pick (' + occExpiryText(enginePick.expUnix) + ', $' + enginePick.strike + ') is outside this window.');
  }
  if (t.jamesExpUnix == null) out.push('  James\'s pick: no January expiry ' + JAMES_MIN_MONTHS + '–' + JAMES_MAX_MONTHS + ' months out in this chain.');
  return out;
}
