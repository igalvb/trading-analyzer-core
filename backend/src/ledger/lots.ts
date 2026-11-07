/**
 * Dated purchase lots of a holding (schema.ts LedgerStock.lots, additive 2026-11-07). Display and checks only: the
 * runs keep reading qty / avgCost (toPortfolio.ts is unchanged), so a lot never moves a verdict, a score or a run.
 *
 *   The rule   the dated lots hold at most `qty`; what is left is ONE implicit undated lot, priced so the total cost
 *              stays qty x avgCost. That implied price is computed, never stored. When it comes out negative or
 *              absurd (more than IMPLIED_MAX_RATIO x avgCost), the lot shows no price and lotsOf names the problem
 *              (a check for the owner) instead of showing nonsense. When the dated lots hold all of qty, their cost
 *              must match qty x avgCost within COST_TOLERANCE, else that is a check too.
 *   bought     boughtOf: the holding's own `bought`, else its earliest dated lot (null = none).
 *
 * The dashboard page carries a copy of lotsOf and boughtOf (dashboard/index.html, between the lots-math markers);
 * test/ledger.lots.test.ts holds the two equal.
 */

import type { LedgerLot, LedgerStock } from './schema.ts';

/** An implied undated price above this multiple of avgCost is "absurd" (flagged, not shown). */
export const IMPLIED_MAX_RATIO = 10;
/** Dated lots that hold all of qty: their cost may differ from qty x avgCost by this fraction (rounding). */
export const COST_TOLERANCE = 0.005;
const EPS = 1e-9;

export interface LotRow {
  /** 'YYYY-MM-DD'; null = undated (an explicit undated lot, or the implied rest). */
  readonly date: string | null;
  readonly qty: number;
  /** Price per unit paid; null = the implied rest has no sensible price (see `problem`). */
  readonly price: number | null;
  readonly note: string | null;
  /** true = the implicit rest (qty - the lots), not a lot the owner typed. */
  readonly implied: boolean;
  /** The lot's place in LedgerStock.lots (the dashboard's remove button); null for the implied rest. */
  readonly index: number | null;
  /** qty x price; null when no price. */
  readonly cost: number | null;
  /** qty x priceNow; null when no price now. */
  readonly value: number | null;
  readonly gain: number | null;
  /** gain / cost x 100. */
  readonly gainPct: number | null;
  /** Calendar days from `date` to `today`; null when undated. */
  readonly heldDays: number | null;
}

export interface LotsView {
  readonly rows: readonly LotRow[];
  /** A plain sentence for the owner when the lots do not add up; null = fine. */
  readonly problem: string | null;
}

/**
 * The lots of a holding with the implied undated rest, priced at `priceNow` (null = no price tonight) on `today`
 * ('YYYY-MM-DD'). A holding without lots gives no rows.
 */
export function lotsOf(s: Pick<LedgerStock, 'qty' | 'avgCost' | 'lots'>, priceNow: number | null, today: string): LotsView {
  const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const r2 = (x: number): number => Math.round(x * 100) / 100;
  const r4 = (x: number): number => Math.round(x * 10000) / 10000;
  const dayMs = (d: string): number => Date.parse(d + 'T12:00:00Z');
  const lots = (Array.isArray(s.lots) ? s.lots : []).map((l, index) => ({ ...l, index })).filter((l) => fin(l.qty) && l.qty > 0 && fin(l.price) && l.price >= 0);
  if (!lots.length) return { rows: [], problem: null };
  const now = fin(priceNow) && priceNow > 0 ? priceNow : null;
  const row = (date: string | null, qty: number, price: number | null, note: string | null, index: number | null): LotRow => {
    const cost = price != null ? r2(qty * price) : null, value = now != null ? r2(qty * now) : null;
    const gain = cost != null && value != null ? r2(value - cost) : null;
    const held = date && Number.isFinite(dayMs(date)) && Number.isFinite(dayMs(today)) ? Math.max(0, Math.round((dayMs(today) - dayMs(date)) / 86400000)) : null;
    return { date, qty, price, note, implied: index == null, index, cost, value, gain, gainPct: gain != null && cost ? r2((gain / cost) * 100) : null, heldDays: held };
  };
  const sorted = lots.slice().sort((a, b) => (a.date == null ? 1 : b.date == null ? -1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rows = sorted.map((l) => row(l.date ?? null, l.qty, l.price, typeof l.note === 'string' && l.note ? l.note : null, l.index));
  const held = lots.reduce((a, l) => a + l.qty, 0), paid = lots.reduce((a, l) => a + l.qty * l.price, 0);
  const qty = fin(s.qty) ? s.qty : 0, avg = fin(s.avgCost) ? s.avgCost : null;
  const rest = Math.round((qty - held) * 1e8) / 1e8;
  let problem: string | null = null;
  if (rest < -EPS) problem = 'The dated lots hold ' + r4(held) + ', more than the ' + r4(qty) + ' you hold: remove or fix a lot.';
  else if (rest > EPS) {
    if (avg == null) { problem = 'No average cost: the ' + r4(rest) + ' not in a dated lot have no price.'; rows.push(row(null, rest, null, null, null)); }
    else {
      const implied = (qty * avg - paid) / rest;
      const bad = implied < -EPS || (avg > 0 && implied > avg * IMPLIED_MAX_RATIO);
      if (bad) problem = 'The ' + r4(rest) + ' not in a dated lot would have cost ' + r4(implied) + ' each to keep the average cost ' + r4(avg) + ': check the lots or the average cost.';
      rows.push(row(null, rest, bad ? null : r4(Math.max(0, implied)), null, null));
    }
  } else if (avg != null && qty > 0 && Math.abs(paid - qty * avg) > Math.abs(qty * avg) * COST_TOLERANCE) {
    problem = 'The dated lots cost ' + r2(paid) + ', not ' + r2(qty * avg) + ' (quantity x average cost): check the lots or the average cost.';
  }
  return { rows, problem };
}

/** The purchase date: the holding's own `bought`, else its earliest dated lot; null = unknown. */
export function boughtOf(s: Pick<LedgerStock, 'bought' | 'lots'>): string | null {
  if (typeof s.bought === 'string' && s.bought) return s.bought;
  const days = (Array.isArray(s.lots) ? s.lots : []).map((l) => l && l.date).filter((d): d is string => typeof d === 'string' && d !== '').sort();
  return days[0] ?? null;
}

/** Every holding whose lots do not add up, as "TICKER: problem" lines (the net worth screen's checks). */
export function lotChecks(stocks: readonly Pick<LedgerStock, 'ticker' | 'qty' | 'avgCost' | 'lots'>[], today: string): string[] {
  const out: string[] = [];
  for (const s of stocks) {
    if (!s || !Array.isArray(s.lots) || !s.lots.length) continue;
    const p = lotsOf(s, null, today).problem;
    if (p) out.push(s.ticker + ': ' + p);
  }
  return out;
}

export type { LedgerLot };
