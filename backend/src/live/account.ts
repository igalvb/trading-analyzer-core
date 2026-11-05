/**
 * The REAL account as the planner sees it (phase 1: a fake; phase 3: IBKR), and its money after tax
 * (docs/live-broker/MASTER_PLAN.md section 5).
 *
 * Two fakes behind one interface, so phase 3 only adds the broker's:
 *   file   LIVE_ACCOUNT_FILE, a JSON file the owner keeps by hand (format: `parseRealAccount`);
 *   log    the dry run's own record: the start money plus every 'planned (dry run)' order of the 💵 Live Log, as if it
 *          had filled at its evening price with its estimated fee (what the real account would hold had it traded).
 *
 * Tax (section 5; 25% = EXIT_TAX_RATE, as the paper test): IBKR takes no tax; the owner pays it from the bank at year
 * end, so the IBKR money is never touched. Every report still counts it:
 *   account value         what IBKR shows (cash + holdings at tonight's prices), before tax;
 *   tax owed this year    25% of the realised gains minus losses since 1 January (never below 0);
 *   value after tax       account value - tax owed - 25% of each holding's unrealised gain (the paper test's basis:
 *                         per holding, a loss does not offset another holding's gain) - money added for tax;
 *   money added for tax   the tax of past years already paid from the bank (so returns are never overstated).
 */

import fs from 'node:fs';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import type { TabStore, TabCell } from '../storage/tabStore.ts';

export type HoldingKind = 'share' | 'call' | 'put';
export interface RealPosition {
  readonly ticker: string;
  readonly shares: number;
  /** Total cost basis in dollars (fees included). */
  readonly cost: number;
  /** 'share' when absent; options are counted per contract. */
  readonly kind?: HoldingKind;
}
export interface RealisedGain { readonly day: string; readonly ticker: string; readonly gain: number }
export interface RealAccount {
  /** The day the numbers are from, when known. */
  readonly asOf: string | null;
  readonly cash: number;
  /** Cash that has settled (a cash account buys only with it). */
  readonly settledCash: number;
  readonly positions: readonly RealPosition[];
  /** Every realised gain (negative = loss), for the year's tax and the year-end list. */
  readonly realised: readonly RealisedGain[];
  /** Past years' tax already paid from the owner's bank. */
  readonly taxPaidFromBank: number;
  /** Fees paid so far (for the record). */
  readonly feesPaid: number;
  readonly start: { readonly day: string; readonly value: number };
  /** The owner's kill switch, when the file carries one. */
  readonly halted?: boolean;
}

export interface RealAccountSource {
  readonly name: string;
  read(): Promise<RealAccount>;
}

const n = (v: unknown, what: string): number => { const x = Number(v); if (!Number.isFinite(x)) throw new Error('the real account file: ' + what + ' is not a number'); return x; };

/**
 * The account file:
 *   { "asOf": "2026-11-02", "cash": 1000, "settledCash": 1000, "positions": [{ "ticker": "QQQ", "shares": 1.2, "cost": 700 }],
 *     "realised": [{ "day": "2026-03-01", "ticker": "NVDA", "gain": 12.5 }], "taxPaidFromBank": 0, "feesPaid": 0,
 *     "start": { "day": "2026-11-02", "value": 1000 }, "halted": false }
 */
export function parseRealAccount(json: unknown): RealAccount {
  const o = (json ?? {}) as Record<string, any>;
  if (typeof o !== 'object') throw new Error('the real account file is not a JSON object');
  const cash = n(o.cash, 'cash');
  const positions = (Array.isArray(o.positions) ? o.positions : []).map((p: any, i: number): RealPosition => {
    const ticker = String(p?.ticker ?? '').trim().toUpperCase();
    if (!ticker) throw new Error('the real account file: position ' + (i + 1) + ' has no ticker');
    const kind = p.kind == null ? 'share' : String(p.kind);
    if (!['share', 'call', 'put'].includes(kind)) throw new Error('the real account file: ' + ticker + ' has an unknown kind "' + kind + '"');
    return { ticker, shares: n(p.shares, ticker + ' shares'), cost: n(p.cost, ticker + ' cost'), kind: kind as HoldingKind };
  }).filter((p: RealPosition) => p.shares !== 0);
  const realised = (Array.isArray(o.realised) ? o.realised : []).map((r: any): RealisedGain => ({ day: String(r.day), ticker: String(r.ticker ?? ''), gain: n(r.gain, 'a realised gain') }));
  const start = o.start && typeof o.start === 'object' ? { day: String(o.start.day), value: n(o.start.value, 'start value') } : null;
  if (!start) throw new Error('the real account file has no start { day, value }');
  return {
    asOf: o.asOf ? String(o.asOf) : null, cash, settledCash: o.settledCash == null ? cash : n(o.settledCash, 'settledCash'), positions, realised,
    taxPaidFromBank: o.taxPaidFromBank == null ? 0 : n(o.taxPaidFromBank, 'taxPaidFromBank'), feesPaid: o.feesPaid == null ? 0 : n(o.feesPaid, 'feesPaid'), start,
    ...(o.halted != null ? { halted: o.halted === true || o.halted === 'true' || o.halted === 1 } : {}),
  };
}

export function fileAccountSource(file: string, read: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')): RealAccountSource {
  return { name: 'the account file ' + file, read: async () => parseRealAccount(JSON.parse(read(file))) };
}

/** The 💵 Live Log's columns this module reads (liveLog.ts writes them). */
export const LOG_COL = { day: 0, when: 1, ticker: 2, side: 3, qty: 4, limit: 5, fill: 6, fee: 7 } as const;
export const PLANNED_DRY = 'planned (dry run)';

/** The dry run's account: the start money plus every planned dry-run order of the log, filled at its evening price. */
export function shadowAccount(rows: readonly (readonly TabCell[])[], start: { day: string; value: number }): RealAccount {
  let cash = start.value, fees = 0;
  const pos = new Map<string, { shares: number; cost: number }>();
  const realised: RealisedGain[] = [];
  let asOf: string | null = null;
  for (const r of rows) {
    if (String(r[LOG_COL.when]) !== PLANNED_DRY) continue;
    const day = String(r[LOG_COL.day]), t = String(r[LOG_COL.ticker]), qty = Number(r[LOG_COL.qty]), px = Number(r[LOG_COL.limit]), fee = Number(r[LOG_COL.fee]) || 0;
    if (!t || !(qty > 0) || !(px > 0)) continue;
    asOf = day; fees += fee;
    const p = pos.get(t) ?? { shares: 0, cost: 0 };
    if (String(r[LOG_COL.side]) === 'BUY') { p.shares += qty; p.cost += qty * px + fee; cash -= qty * px + fee; pos.set(t, p); continue; }
    const q = Math.min(qty, p.shares);
    if (!(q > 0)) continue;
    const part = (p.cost * q) / p.shares;
    realised.push({ day, ticker: t, gain: q * px - fee - part });
    p.shares -= q; p.cost -= part; cash += q * px - fee;
    if (p.shares <= 1e-9) pos.delete(t); else pos.set(t, p);
  }
  const positions = [...pos].map(([ticker, p]) => ({ ticker, shares: Math.round(p.shares * 1e6) / 1e6, cost: p.cost, kind: 'share' as const }));
  // A dry-run sale "settles" by the next evening (T+1), so all the cash counts as settled.
  return { asOf, cash, settledCash: cash, positions, realised, taxPaidFromBank: 0, feesPaid: fees, start };
}

export function liveLogAccountSource(store: TabStore, tab: string, nCols: number, start: { day: string; value: number }): RealAccountSource {
  return { name: 'the dry run\'s own record (' + tab + ')', read: async () => shadowAccount(((await store.read(tab, nCols)) ?? []).slice(1), start) };
}

export interface Accounting {
  readonly value: number;
  readonly taxOwed: number;
  readonly unrealisedTax: number;
  readonly moneyAddedForTax: number;
  readonly valueAfterTax: number;
}

/** The account's value before and after tax at `closeOf` prices (a holding without a price counts at its cost). */
export function accountingOf(a: RealAccount, closeOf: (t: string) => number | null, year: string): Accounting {
  let value = a.cash, unrealisedTax = 0;
  for (const p of a.positions) {
    const per = p.kind === 'call' || p.kind === 'put' ? 100 : 1;
    const px = closeOf(p.ticker);
    const v = px == null ? p.cost : p.shares * px * per;
    value += v;
    unrealisedTax += Math.max(0, v - p.cost) * EXIT_TAX_RATE;
  }
  const gains = a.realised.filter((r) => r.day.slice(0, 4) === year).reduce((s, r) => s + r.gain, 0);
  const taxOwed = Math.max(0, gains) * EXIT_TAX_RATE;
  return { value, taxOwed, unrealisedTax, moneyAddedForTax: a.taxPaidFromBank, valueAfterTax: value - taxOwed - unrealisedTax - a.taxPaidFromBank };
}

/** D5 alerts: the account's fall from its start (no automatic stop). */
export function fallAlerts(value: number, startValue: number, levels: readonly number[]): string[] {
  const fall = startValue > 0 ? 1 - value / startValue : 0;
  const hit = [...levels].sort((x, y) => y - x).find((l) => fall >= l - 1e-9);
  return hit == null ? [] : ['⚠️ The live account is ' + (fall * 100).toFixed(1) + '% below its start ($' + Math.round(startValue).toLocaleString('en-US') + '), past the -' + Math.round(hit * 100) + '% alert. No automatic stop (D5): the owner decides.'];
}
