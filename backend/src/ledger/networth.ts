/**
 * The dashboard's NET WORTH screen and GROWTH graph, from the ledger files on the `data` branch (schema.ts is the
 * format; docs/DASHBOARD.md "Net worth, growth graph, editing"). Read-only: nothing here writes a ledger file.
 *
 *   buildNetWorth   every item the owner has (stocks, bitcoin funds, crypto, calls with today's live values; pension,
 *                   other funds, real estate net of its mortgage, cash as he last typed them), group totals and the
 *                   grand total in USD and ILS at the day's USD/ILS rate
 *   netBalance      the same total split as assets (gross: markets, pension and funds, real estate's value, cash) and
 *                   debts (mortgages; other debts = an item whose value is 0 and debt > 0, whatever its group): the
 *                   page's top cards and its separate "Debt" line (the page carries a copy; the test holds them equal)
 *   buildGrowth     the snapshots (one line per day) and the money-in/out flows for the graph and its marks
 *   withoutFlows    "growth without deposits": the value minus the net money put in since the first day shown
 *                   (the page carries a copy of this function; test/dashboard.networth.test.ts holds them equal)
 *   subTypeTotals   the market part by the owner's own sub-types (as written in the ledger / Portfolio tab; by kind
 *                   when none): the allocation pie
 *   ratioCards      each target of ledger/targets.json ("A/B", "A bag/B": a price or a holding's whole value over a
 *                   price) against today's ratio: % of target
 *   readLedgerSources   thin I/O: the ledger folder of a checked-out `data` branch (absent files are null)
 *
 * Holdings take their price from the dashboard's live portfolio rows (tonight's close, else the Exit report's, else
 * the sheet's), matched by ticker (options: ticker, strike, expiry); a price the owner typed (manualPrice) wins, except
 * that the Nightly's own price of a holding (ledger/prices.json, profile ledger.cryptoPrices) wins over manualPrice
 * while that file's date is not older than holdings.json's `updated` (the snapshot and this screen then agree).
 * Names are kept exactly as written (Hebrew included); the page shows them with dir="auto".
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.ts';
import { orElse } from '../core/guard.ts';
import {
  LEDGER_SCHEMA, LEDGER_FILES, LEDGER_GROUPS, groupOfStock,
  type Currency, type LedgerGroup, type LedgerHoldings, type LedgerAssets, type LedgerWatchlist, type LedgerFlow, type LedgerSnapshot,
  type LedgerStock, type LedgerOption, type LedgerAsset, type LedgerTargets, type LedgerPrices,
} from './schema.ts';
import { lotChecks } from './lots.ts';

/** A static value older than this many days is shown amber ("update it"). */
export const STALE_DAYS = 90;

export const NET_GROUP_LABELS: Readonly<Record<LedgerGroup, string>> = {
  stocks: 'Stocks', btcFunds: 'Bitcoin funds', crypto: 'Crypto', calls: 'Calls', pension: 'Pension', funds: 'Other funds', realEstate: 'Real estate', cash: 'Cash',
};

/** The ledger files as read (null = absent or unreadable). */
export type { LedgerTargets };
export interface LedgerSources {
  readonly holdings?: LedgerHoldings | null;
  readonly assets?: LedgerAssets | null;
  readonly watchlist?: LedgerWatchlist | null;
  readonly flows?: readonly LedgerFlow[] | null;
  readonly snapshots?: readonly LedgerSnapshot[] | null;
  readonly targets?: LedgerTargets | null;
  /** ledger/prices.json (additive 2026-11-06): the Nightly's prices by holding id. */
  readonly prices?: LedgerPrices | null;
}

/** ledger/targets.json (schema.ts LedgerTargets): names "A/B" or "A bag/B" become ratio cards. */
export const TARGETS_FILE = LEDGER_FILES.targets;

/** The few fields of a dashboard portfolio row this needs (structural: no import from dashboard/data.ts). */
export interface LiveHolding {
  readonly ticker: string;
  readonly group: string;
  readonly kind: string;
  readonly price: number | null;
  readonly value: number | null;
  readonly priceSource: string | null;
  readonly strike?: number | null;
  readonly expiry?: string | null;
  /** The Portfolio tab's sub-type, as written. */
  readonly subType?: string | null;
}

export interface NetFx { readonly usdIls: number; readonly date: string | null; readonly source: 'snapshot' | 'context' }

export interface NetItem {
  readonly id: string;
  readonly group: LedgerGroup;
  /** As written (Hebrew kept). Holdings: the ticker (options: "TSLA 300C 2027-06-17"). */
  readonly name: string;
  /** Provider / track (assets) or the quantity line (holdings). */
  readonly sub: string | null;
  readonly currency: Currency;
  /** Gross value in `currency` (real estate: the property's value); null = not priced. */
  readonly value: number | null;
  /** Real estate: the mortgage left, in `currency`. */
  readonly debt: number | null;
  /** value - debt, in `currency`. */
  readonly net: number | null;
  readonly usd: number | null;
  readonly ils: number | null;
  /** The day the owner last typed the value (static items); null = live. */
  readonly asOf: string | null;
  readonly ageDays: number | null;
  readonly stale: boolean;
  /** 'live' | 'report' | 'sheet' (the portfolio row's price), 'manual' (typed), 'nightly' (ledger/prices.json), 'static' (asset), null (no price). */
  readonly source: string | null;
  readonly qty: number | null;
  readonly cost: number | null;
  /** Where an edit goes: the ledger file and the item's id; null = not editable here. */
  readonly ref: { readonly file: string; readonly id: string } | null;
  /** The ledger item itself (prefills the edit forms). */
  readonly raw: LedgerStock | LedgerOption | LedgerAsset | null;
  /** Market items: the owner's sub-type as written, else the kind's label (Stocks, Bitcoin funds, Crypto, Options). */
  readonly subType: string | null;
  /** Assets: whose it is, as written (per-person subtotals). */
  readonly person: string | null;
}

export interface NetSubType { readonly name: string; readonly count: number; readonly usd: number; readonly share: number }
export interface NetRatio {
  readonly id: string; readonly name: string; readonly target: number;
  /** Today's ratio; null when a side has no price. */
  readonly current: number | null;
  readonly pctOfTarget: number | null;
}
/** The Portfolio tab's totals block, in USD (ILS beside when the rate is known). */
export interface NetTotals {
  readonly portfolio: number; readonly pension: number; readonly funds: number; readonly realEstate: number; readonly debt: number; readonly total: number;
  readonly ils: { readonly portfolio: number; readonly pension: number; readonly funds: number; readonly realEstate: number; readonly debt: number; readonly total: number } | null;
}
export interface NetPerson { readonly name: string; readonly count: number; readonly usd: number; readonly ils: number | null }

export interface NetGroup {
  readonly id: LedgerGroup; readonly label: string; readonly count: number;
  readonly usd: number; readonly ils: number | null;
  /** Real estate: gross value and debt in USD. */
  readonly grossUsd: number | null; readonly debtUsd: number | null;
  /** Items left out of the USD total (no price, or ILS with no rate). */
  readonly unpriced: number;
  readonly stale: number;
}

/**
 * The net worth as assets minus debts, in USD (debts negative; ILS beside when the rate is known). Display only: the
 * total is the same number as NetWorth.total (assets + debts = total, to the cent).
 */
export interface NetBalance {
  /** Gross: markets + pension and funds + real estate's value + cash (each item's positive part). */
  readonly assetsUsd: number;
  /** Real estate mortgages (negative or 0). */
  readonly mortgagesUsd: number;
  /** Debt items (value 0, debt > 0, any group), any other item's debt, and a negative value typed on an item (negative or 0). */
  readonly otherDebtsUsd: number;
  /** mortgagesUsd + otherDebtsUsd. */
  readonly debtsUsd: number;
  /** assetsUsd + debtsUsd. */
  readonly netUsd: number;
  readonly ils: { readonly assets: number; readonly mortgages: number; readonly otherDebts: number; readonly debts: number; readonly net: number } | null;
}

export interface NetWorth {
  readonly asOf: string;
  readonly fx: NetFx | null;
  readonly groups: readonly NetGroup[];
  readonly items: readonly NetItem[];
  readonly total: { readonly usd: number; readonly ils: number | null; readonly unpriced: number };
  readonly watchlist: readonly string[] | null;
  /** The ledger's own 'updated' days (the migration day at first). */
  readonly ledgerUpdated: string | null;
  readonly subTypes: readonly NetSubType[];
  readonly totals: NetTotals;
  /** The same total as assets minus debts (the page's top cards). */
  readonly balance: NetBalance;
  readonly persons: readonly NetPerson[];
  /** Absent when ledger/targets.json is not there. */
  readonly ratios?: readonly NetRatio[];
  /** Additive 2026-11-07: holdings whose dated lots do not add up (ledger/lots.ts lotChecks), "TICKER: ..."; absent = none. */
  readonly checks?: readonly string[];
}

export interface GrowthFlow {
  readonly id: string; readonly date: string; readonly group: LedgerGroup; readonly itemId: string | null;
  readonly amount: number; readonly currency: Currency; readonly usd: number | null; readonly ils: number | null;
  readonly note: string | null; readonly source: LedgerFlow['source'];
  /** A run's suggestion the owner has not confirmed yet (drawn hollow; not counted in "without deposits"). */
  readonly suggested: boolean;
}

export interface GrowthSnapshot {
  readonly date: string; readonly fx: number | null; readonly usd: Readonly<Partial<Record<LedgerGroup, number>>>; readonly totalUsd: number; readonly totalIls: number | null;
}

export interface Growth {
  readonly snapshots: readonly GrowthSnapshot[];
  readonly flows: readonly GrowthFlow[];
  /** The day the graph starts (the first snapshot, else the ledger's day). */
  readonly start: string | null;
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const r2 = (x: number | null | undefined): number | null => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = (x: number | null | undefined): number | null => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (x: unknown): x is string => typeof x === 'string' && DAY.test(x) && Number.isFinite(Date.parse(x + 'T12:00:00Z'));
/** The New York calendar day of an instant. */
export function nyDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86_400_000);

/** Amount in `currency` -> [usd, ils] at `fx` (USD/ILS); a missing rate leaves the other side null. */
export function convert(amount: number | null, currency: Currency, fx: number | null): [number | null, number | null] {
  if (amount == null) return [null, null];
  const ok = fx != null && fx > 0;
  return currency === 'USD' ? [r2(amount), ok ? r2(amount * fx) : null] : [ok ? r2(amount / fx) : null, r2(amount)];
}

/** The rate on `date` (the last snapshot on or before it, else the first after it); null when no snapshot has one. */
export function fxOn(snapshots: readonly Pick<LedgerSnapshot, 'date' | 'fxUsdIls'>[], date: string): number | null {
  let before: number | null = null, after: number | null = null;
  for (const s of snapshots) {
    if (!fin(s.fxUsdIls) || s.fxUsdIls <= 0) continue;
    if (s.date <= date) before = s.fxUsdIls; else if (after == null) after = s.fxUsdIls;
  }
  return before ?? after;
}

// ── reading (jsonl: one object per line; a later line with the same id replaces an earlier one) ────────────────────

/** The lines of a jsonl text that parse as objects of a known schema; bad lines are skipped (one log line each). */
export function parseJsonl(text: string, log: Logger | null | undefined, what: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const v = orElse<unknown>(log, what + ' line ' + (i + 1), () => JSON.parse(line), null);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    const o = v as Record<string, unknown>;
    if (fin(o.schema) && o.schema > LEDGER_SCHEMA) { log?.warning(what + ' line ' + (i + 1) + ' has a newer format (schema ' + o.schema + '); skipped'); return; }
    out.push(o);
  });
  return out;
}

/** Each flow id once: its LAST line (confirm / dismiss append a new line with the same id). */
export function latestFlows(rows: readonly LedgerFlow[]): LedgerFlow[] {
  const by = new Map<string, LedgerFlow>();
  for (const f of rows) { if (typeof f.id === 'string' && f.id) { by.delete(f.id); by.set(f.id, f); } }
  return [...by.values()];
}

/** Each snapshot day once (the last line of a day wins), oldest first. */
export function latestSnapshots(rows: readonly LedgerSnapshot[]): LedgerSnapshot[] {
  const by = new Map<string, LedgerSnapshot>();
  for (const s of rows) if (isDay(s.date) && fin(s.totalUsd)) by.set(s.date, s);
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** The default `data` branch checkout: <repo>/data-branch (DATA_BRANCH_DIR overrides). */
export const DEFAULT_DATA_BRANCH_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'data-branch');

/**
 * Reads the ledger folder of a checked-out `data` branch. A missing file is null; a file that does not parse, or has a
 * newer schema, is null with one log line. Never throws. Returns null when the folder itself is not there.
 */
export function readLedgerSources(dir: string, log: Logger | null | undefined): LedgerSources | null {
  if (!fs.existsSync(path.join(dir, 'ledger'))) return null;
  const text = (rel: string): string | null => {
    const p = path.join(dir, rel);
    return fs.existsSync(p) ? orElse<string | null>(log, 'ledger read ' + rel, () => fs.readFileSync(p, 'utf8'), null) : null;
  };
  const json = <T>(rel: string): T | null => {
    const t = text(rel);
    if (t == null) return null;
    const v = orElse<unknown>(log, 'ledger parse ' + rel, () => JSON.parse(t), null);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const sch = (v as { schema?: unknown }).schema;
    if (fin(sch) && sch > LEDGER_SCHEMA) { log?.warning(rel + ' has a newer format (schema ' + sch + '); left out'); return null; }
    return v as T;
  };
  const lines = <T>(rel: string): T[] | null => { const t = text(rel); return t == null ? null : (parseJsonl(t, log, rel) as unknown as T[]); };
  return {
    holdings: json<LedgerHoldings>(LEDGER_FILES.holdings), assets: json<LedgerAssets>(LEDGER_FILES.assets), watchlist: json<LedgerWatchlist>(LEDGER_FILES.watchlist),
    flows: lines<LedgerFlow>(LEDGER_FILES.flows), snapshots: lines<LedgerSnapshot>(LEDGER_FILES.snapshots), targets: json<LedgerTargets>(TARGETS_FILE),
    prices: json<LedgerPrices>(LEDGER_FILES.prices),
  };
}

// ── the net worth screen ──────────────────────────────────────────────────────────────────────────────────────────

const PORTFOLIO_GROUP: Readonly<Record<string, LedgerGroup>> = { stocks: 'stocks', btc: 'btcFunds', crypto: 'crypto', calls: 'calls' };

function optionName(o: Pick<LedgerOption, 'ticker' | 'strike' | 'side' | 'expiry'>): string {
  return o.ticker + ' ' + o.strike + (o.side === 'put' ? 'P' : 'C') + ' ' + o.expiry;
}
const qtyText = (q: number, unit: string): string => q.toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' ' + unit;

/** The day's USD/ILS rate: the context's (when given) or the newest snapshot that has one. */
export function currentFx(snapshots: readonly LedgerSnapshot[], given?: { readonly usdIls: number; readonly date?: string | null } | null): NetFx | null {
  if (given && fin(given.usdIls) && given.usdIls > 0) return { usdIls: given.usdIls, date: given.date ?? null, source: 'context' };
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i] as LedgerSnapshot;
    if (fin(s.fxUsdIls) && s.fxUsdIls > 0) return { usdIls: s.fxUsdIls, date: s.date, source: 'snapshot' };
  }
  return null;
}

export interface NetWorthInput {
  readonly ledger: LedgerSources;
  readonly live: readonly LiveHolding[];
  readonly nowMs: number;
  readonly fx?: { readonly usdIls: number; readonly date?: string | null } | null;
  /** Tonight's closes by ticker (the paper reads); the ratio cards use them after the holdings' own prices. */
  readonly prices?: ReadonlyMap<string, number> | null;
}

/** The kind's label when a holding has no sub-type of its own. */
export const KIND_SUBTYPE: Readonly<Record<string, string>> = { stocks: 'Stocks', btcFunds: 'Bitcoin funds', crypto: 'Crypto', calls: 'Options' };
const MARKET_GROUPS: readonly LedgerGroup[] = ['stocks', 'btcFunds', 'crypto', 'calls'];
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null);

/** The market items by sub-type, biggest first; `share` is % of the market total (positive values). */
export function subTypeTotals(items: readonly Pick<NetItem, 'group' | 'subType' | 'usd'>[]): NetSubType[] {
  const by = new Map<string, { count: number; usd: number }>();
  for (const x of items) {
    if (!MARKET_GROUPS.includes(x.group)) continue;
    const k = x.subType ?? KIND_SUBTYPE[x.group] ?? x.group;
    const t = by.get(k) ?? { count: 0, usd: 0 };
    t.count++; t.usd += x.usd ?? 0;
    by.set(k, t);
  }
  const all = [...by.values()].reduce((s, t) => s + Math.max(0, t.usd), 0) || 1;
  return [...by].map(([name, t]) => ({ name, count: t.count, usd: r2(t.usd) as number, share: r2(Math.max(0, t.usd) / all * 100) as number })).sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name));
}

const RATIO_SIDE = /^\s*([A-Za-z0-9.^-]{1,12})(\s+bag)?\s*$/i;
/**
 * Each target "A/B" (a price over a price) or "A bag/B" (the whole value held of A over B's price) against today's
 * ratio. A price: the coin's own price for a coin ticker (a fund with the same ticker comes second), then any holding's
 * price, then tonight's close of the ticker or "<ticker>-USD". A name that is not of this shape keeps current null.
 */
export function ratioCards(targets: LedgerTargets, items: readonly NetItem[], prices: ReadonlyMap<string, number>): NetRatio[] {
  const market = items.filter((x) => MARKET_GROUPS.includes(x.group) && x.group !== 'calls');
  const unit = (x: NetItem): number | null => (x.qty && x.value != null ? x.value / x.qty : null);
  const priceOf = (t: string): number | null => {
    const mine = market.filter((x) => x.name.toUpperCase() === t);
    const coin = mine.find((x) => x.group === 'crypto' && unit(x) != null) ?? mine.find((x) => unit(x) != null);
    return (coin ? unit(coin) : null) ?? prices.get(t) ?? prices.get(t + '-USD') ?? null;
  };
  const side = (s: string): number | null => {
    const m = RATIO_SIDE.exec(s);
    if (!m) return null;
    const t = (m[1] as string).toUpperCase();
    if (!m[2]) return priceOf(t);
    const held = market.filter((x) => x.name.toUpperCase() === t && x.usd != null);
    return held.length ? held.reduce((a, x) => a + (x.usd as number), 0) : null;
  };
  return (targets.items ?? []).filter((t) => t && typeof t.name === 'string' && fin(t.value) && t.value > 0).map((t) => {
    const parts = t.name.split('/');
    const a = parts.length === 2 ? side(parts[0] as string) : null, b = parts.length === 2 ? side(parts[1] as string) : null;
    const current = a != null && b != null && b > 0 ? a / b : null;
    return { id: String(t.id ?? t.name), name: t.name.slice(0, 40), target: t.value, current: current == null ? null : Number(current.toPrecision(6)), pctOfTarget: current == null ? null : r2(current / t.value * 100) };
  });
}

/** A debt line of its own: an item whose value is 0 and whose debt is above 0, whatever its group. */
export function isDebtItem(x: Pick<NetItem, 'value' | 'debt'>): boolean {
  return x.value === 0 && fin(x.debt) && x.debt > 0;
}

/**
 * Assets and debts of the priced items (the same items as the total: an item without a USD value is left out of both).
 * Per item: its value (real estate: the property's value) is an asset, its debt a debt (real estate: a mortgage, any
 * other group: an other debt); a negative value counts as an other debt. So assets + debts = the sum of the items' net.
 */
export function netBalance(items: readonly Pick<NetItem, 'group' | 'value' | 'debt' | 'net' | 'currency' | 'usd'>[], rate: number | null): NetBalance {
  let assets = 0, mortgages = 0, other = 0;
  for (const x of items) {
    if (x.usd == null) continue;
    const hasDebt = fin(x.debt) && x.debt !== 0;
    const gross = hasDebt ? convert(x.value ?? 0, x.currency, rate)[0] ?? 0 : x.usd;
    const debt = hasDebt ? gross - x.usd : 0;
    if (gross >= 0) assets += gross; else other += gross;
    if (x.group === 'realEstate') mortgages -= debt; else other -= debt;
  }
  const a = r2(assets) as number, m = r2(mortgages) as number, o = r2(other) as number, d = r2(m + o) as number, n = r2(assets + mortgages + other) as number;
  const ok = rate != null && rate > 0;
  return {
    assetsUsd: a, mortgagesUsd: m, otherDebtsUsd: o, debtsUsd: d, netUsd: n,
    ils: ok ? { assets: r2(a * rate) as number, mortgages: r2(m * rate) as number, otherDebts: r2(o * rate) as number, debts: r2(d * rate) as number, net: r2(n * rate) as number } : null,
  };
}

export function buildNetWorth(input: NetWorthInput): NetWorth | null {
  const { ledger, live } = input;
  const snaps = latestSnapshots(ledger.snapshots ?? []);
  const fx = currentFx(snaps, input.fx);
  const rate = fx?.usdIls ?? null;
  const today = nyDay(input.nowMs);
  const items: NetItem[] = [];
  const push = (x: Omit<NetItem, 'usd' | 'ils' | 'ageDays' | 'stale'>): void => {
    const [usd, ils] = convert(x.net, x.currency, rate);
    const ageDays = x.asOf && isDay(x.asOf) ? Math.max(0, daysBetween(x.asOf, today)) : null;
    items.push({ ...x, usd, ils, ageDays, stale: ageDays != null && ageDays > STALE_DAYS });
  };

  if (ledger.holdings) {
    const H = ledger.holdings;
    const nonCall = live.filter((h) => h.group !== 'calls');
    const P = ledger.prices;
    const nightly = P && P.prices && typeof P.prices === 'object' && isDay(P.date) && !(typeof H.updated === 'string' && isDay(H.updated) && P.date < H.updated) ? P.prices : null;
    for (const s of H.stocks ?? []) {
      if (!s || typeof s.ticker !== 'string' || !fin(s.qty)) continue;
      const group = groupOfStock(s);
      const same = nonCall.filter((h) => h.ticker === s.ticker);
      const m = same.find((h) => PORTFOLIO_GROUP[h.group] === group) ?? same[0];
      const night = nightly && fin(nightly[s.id]) && (nightly[s.id] as number) > 0 ? nightly[s.id] as number : null;
      const manual = fin(s.manualPrice) ? s.manualPrice : null;
      const price = night ?? manual ?? (m && fin(m.price) ? m.price : null);
      const value = price != null ? price * s.qty : null;
      push({
        id: s.id, group, name: s.ticker, sub: qtyText(s.qty, group === 'crypto' ? 'units' : 'shares') + (price != null ? ' @ ' + r4(price) : ''), currency: s.currency === 'ILS' ? 'ILS' : 'USD',
        value: r2(value), debt: null, net: r2(value), asOf: null, source: night != null ? 'nightly' : manual != null ? 'manual' : m && price != null ? m.priceSource : null,
        qty: s.qty, cost: fin(s.avgCost) ? r2(s.avgCost * s.qty) : null, ref: { file: LEDGER_FILES.holdings, id: s.id }, raw: s,
        subType: text(s.subType) ?? text(m?.subType) ?? KIND_SUBTYPE[group] ?? null, person: null,
      });
    }
    const calls = live.filter((h) => h.group === 'calls');
    for (const o of H.options ?? []) {
      if (!o || typeof o.ticker !== 'string' || !fin(o.contracts)) continue;
      const m = calls.find((h) => h.ticker === o.ticker && h.strike === o.strike && (h.expiry == null || h.expiry === o.expiry) && h.kind === o.side);
      const value = m && fin(m.value) ? m.value : fin(o.currentValue) ? o.currentValue : null;
      push({
        id: o.id, group: 'calls', name: optionName(o), sub: qtyText(o.contracts, o.contracts === 1 ? 'contract' : 'contracts'), currency: 'USD',
        value: r2(value), debt: null, net: r2(value), asOf: null, source: m && fin(m.value) ? m.priceSource ?? 'sheet' : value != null ? 'sheet' : null,
        qty: o.contracts, cost: fin(o.avgPremium) ? r2(o.avgPremium * 100 * o.contracts) : null, ref: { file: LEDGER_FILES.holdings, id: o.id }, raw: o,
        subType: KIND_SUBTYPE.calls as string, person: null,
      });
    }
  } else {
    // No holdings file yet: the live portfolio rows (not editable here).
    for (const h of live) {
      const group = PORTFOLIO_GROUP[h.group];
      if (!group) continue;
      const name = group === 'calls' && h.strike != null ? h.ticker + ' ' + h.strike + (h.kind === 'put' ? 'P' : 'C') + (h.expiry ? ' ' + h.expiry : '') : h.ticker;
      push({ id: 'live:' + items.length, group, name, sub: null, currency: 'USD', value: r2(h.value), debt: null, net: r2(h.value), asOf: null, source: h.priceSource, qty: null, cost: null, ref: null, raw: null, subType: group === 'calls' ? KIND_SUBTYPE.calls as string : text(h.subType) ?? KIND_SUBTYPE[group] ?? null, person: null });
    }
  }

  for (const a of ledger.assets?.items ?? []) {
    if (!a || !LEDGER_GROUPS.includes(a.group) || typeof a.name !== 'string') continue;
    const value = fin(a.value) ? a.value : null, debt = fin(a.debt) ? a.debt : null;
    push({
      id: a.id, group: a.group, name: a.name, sub: a.provider ? a.provider : null, currency: a.currency === 'USD' ? 'USD' : 'ILS',
      value: r2(value), debt: r2(debt), net: value != null ? r2(value - (debt ?? 0)) : null, asOf: isDay(a.asOf) ? a.asOf : null, source: 'static',
      qty: null, cost: null, ref: { file: LEDGER_FILES.assets, id: a.id }, raw: a, subType: null, person: text(a.person),
    });
  }

  if (!items.length && !ledger.holdings && !ledger.assets) return null;
  const groups: NetGroup[] = LEDGER_GROUPS.map((id) => {
    const xs = items.filter((x) => x.group === id);
    const priced = xs.filter((x) => x.usd != null);
    const usd = r2(priced.reduce((s, x) => s + (x.usd as number), 0)) as number;
    const re = id === 'realEstate';
    const gross = re ? r2(xs.reduce((s, x) => s + (convert(x.value, x.currency, rate)[0] ?? 0), 0)) : null;
    const debt = re ? r2(xs.reduce((s, x) => s + (convert(x.debt, x.currency, rate)[0] ?? 0), 0)) : null;
    return { id, label: NET_GROUP_LABELS[id], count: xs.length, usd, ils: rate != null ? r2(usd * rate) : null, grossUsd: gross, debtUsd: debt, unpriced: xs.length - priced.length, stale: xs.filter((x) => x.stale).length };
  }).filter((g) => g.count > 0);
  const totalUsd = r2(groups.reduce((s, g) => s + g.usd, 0)) as number;
  const updated = [ledger.holdings?.updated, ledger.assets?.updated].filter(isDay).sort();
  const gUsd = (ids: readonly LedgerGroup[]): number => r2(groups.filter((g) => ids.includes(g.id)).reduce((s, g) => s + g.usd, 0)) as number;
  const re = groups.find((g) => g.id === 'realEstate');
  const T = { portfolio: gUsd(MARKET_GROUPS), pension: gUsd(['pension']), funds: gUsd(['funds']), realEstate: r2(re?.grossUsd ?? 0) as number, debt: r2(-(re?.debtUsd ?? 0)) as number, total: totalUsd };
  const ilsOf = (o: typeof T): NetTotals['ils'] => rate == null ? null
    : { portfolio: r2(o.portfolio * rate) as number, pension: r2(o.pension * rate) as number, funds: r2(o.funds * rate) as number, realEstate: r2(o.realEstate * rate) as number, debt: r2(o.debt * rate) as number, total: r2(o.total * rate) as number };
  const people = new Map<string, { count: number; usd: number }>();
  for (const x of items) if (x.person && x.usd != null) { const p = people.get(x.person) ?? { count: 0, usd: 0 }; p.count++; p.usd += x.usd; people.set(x.person, p); }
  const checks = lotChecks((ledger.holdings?.stocks ?? []).filter((s) => s && typeof s.ticker === 'string' && fin(s.qty)), today);
  return {
    asOf: today, fx, groups, items, subTypes: subTypeTotals(items), totals: { ...T, ils: ilsOf(T) }, balance: netBalance(items, rate),
    persons: [...people].map(([name, p]) => ({ name, count: p.count, usd: r2(p.usd) as number, ils: rate != null ? r2(p.usd * rate) : null })).sort((a, b) => b.usd - a.usd),
    ...(ledger.targets && Array.isArray(ledger.targets.items) ? { ratios: ratioCards(ledger.targets, items, input.prices ?? new Map()) } : {}),
    total: { usd: totalUsd, ils: rate != null ? r2(totalUsd * rate) : null, unpriced: groups.reduce((s, g) => s + g.unpriced, 0) },
    watchlist: Array.isArray(ledger.watchlist?.tickers) ? ledger.watchlist.tickers.filter((t) => typeof t === 'string') : null,
    ledgerUpdated: updated[updated.length - 1] ?? null,
    ...(checks.length ? { checks } : {}),
  };
}

// ── the growth graph ──────────────────────────────────────────────────────────────────────────────────────────────

export function buildGrowth(ledger: LedgerSources): Growth | null {
  if (!ledger.snapshots && !ledger.flows) return null;
  const snaps = latestSnapshots(ledger.snapshots ?? []);
  const snapshots: GrowthSnapshot[] = snaps.map((s) => {
    const usd: Partial<Record<LedgerGroup, number>> = {};
    for (const g of LEDGER_GROUPS) { const v = s.usd?.[g]; if (fin(v)) usd[g] = r2(v) as number; }
    const fx = fin(s.fxUsdIls) && s.fxUsdIls > 0 ? s.fxUsdIls : null;
    return { date: s.date, fx, usd, totalUsd: r2(s.totalUsd) as number, totalIls: fin(s.totalIls) ? r2(s.totalIls) : fx != null ? r2(s.totalUsd * fx) : null };
  });
  const flows: GrowthFlow[] = latestFlows(ledger.flows ?? [])
    .filter((f) => !f.dismissed && isDay(f.date) && fin(f.amount) && f.amount !== 0 && LEDGER_GROUPS.includes(f.group))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((f) => {
      const currency: Currency = f.currency === 'ILS' ? 'ILS' : 'USD';
      const [usd, ils] = convert(f.amount, currency, fxOn(snaps, f.date));
      return { id: f.id, date: f.date, group: f.group, itemId: typeof f.itemId === 'string' ? f.itemId : null, amount: r2(f.amount) as number, currency, usd, ils, note: typeof f.note === 'string' ? f.note.slice(0, 300) : null, source: f.source, suggested: f.source === 'suggested' };
    });
  const updated = [ledger.holdings?.updated, ledger.assets?.updated].filter(isDay).sort();
  return { snapshots, flows, start: snapshots[0]?.date ?? updated[0] ?? null };
}

/**
 * "Growth without deposits" (value minus net money in): for each day i of the series shown,
 *     out[i] = value[i] - (sum of the flows dated after day 0 and on or before day i)
 * so a deposit lifts the value but not this line, and money taken out does not drop it; only market moves (and value
 * updates) do. Day 0 is the first day shown: flows on or before it are already inside value[0]. A flow is counted on
 * its own day (the night's snapshot already holds it). Days with no value stay null. Suggested flows the owner has not
 * confirmed are left out by the caller.
 */
export function withoutFlows(days: readonly string[], values: readonly (number | null)[], flows: readonly { readonly date: string; readonly amount: number }[]): (number | null)[] {
  const start = days[0];
  const sorted = flows.filter((f) => start != null && f.date > start && Number.isFinite(f.amount)).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: (number | null)[] = [];
  let k = 0, cum = 0;
  for (let i = 0; i < days.length; i++) {
    const d = days[i] as string;
    while (k < sorted.length && (sorted[k] as { date: string }).date <= d) { cum += (sorted[k] as { amount: number }).amount; k++; }
    const v = values[i];
    out.push(v == null || !Number.isFinite(v) ? null : Math.round((v - cum) * 100) / 100);
  }
  return out;
}
