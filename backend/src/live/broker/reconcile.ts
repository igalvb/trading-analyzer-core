/**
 * Reconciliation (3.5): the bot's own ledger (what its fills say it holds) against what the broker says it holds.
 * Any difference holds the plan and alerts the owner; the owner confirms (/confirm), and the broker's view becomes
 * the ledger. The kind of each difference is named so the owner knows what happened:
 *   split     same ticker, the quantity changed by a split ratio (2-for-1, 3-for-2, 1-for-10 ...);
 *   rename    a ticker vanished and a new one appeared with the same quantity (a ticker change);
 *   dividend  cash went up with no trade of the bot (a dividend, interest or a deposit);
 *   cash      cash went down with no trade of the bot (a charge, a withdrawal, a fee not from a fill);
 *   manual    any other quantity change (the owner trading by hand in the bot's account);
 *   new       no ledger yet (the first run): the owner confirms the starting account once.
 * Owner 2026-10-30: a small cash credit (under LIVE_AUTO_ACCEPT_CREDIT_USD, default $5) with no position change is a
 * dividend or interest: it is accepted automatically (`credit`, ok stays true), the caller adds it to the ledger
 * (acceptCredit) and logs it in 💵 Live Log as 'credit accepted'. Anything else still holds the plan.
 */

import { instrumentKey, type BrokerFill, type BrokerPosition } from './broker.ts';
import type { Ledger } from './botState.ts';
import { IBKR_APP_STOP } from './killSwitch.ts';

export type MismatchKind = 'split' | 'rename' | 'dividend' | 'cash' | 'manual' | 'new';
export interface Mismatch { readonly kind: MismatchKind; readonly ticker: string; readonly detail: string }
/** A small cash credit accepted without the owner (owner 2026-10-30). */
export interface AcceptedCredit { readonly amount: number; readonly cash: number; readonly detail: string }
export interface Reconciliation {
  readonly ok: boolean;
  /** A cash credit under the auto-accept limit with no position change: accepted, not a mismatch. */
  readonly credit: AcceptedCredit | null;
  readonly mismatches: readonly Mismatch[];
  /** The Telegram alert, or null when everything matches. */
  readonly alert: string | null;
}

export const CASH_TOLERANCE = 0.05;
/** Owner 2026-10-30: cash credits strictly under this (USD) with no position change are accepted automatically. */
export const AUTO_ACCEPT_CREDIT_USD = 5;
export interface ReconcileOptions {
  /** Credits strictly under this are accepted (dividend or interest); 0 turns it off. Default AUTO_ACCEPT_CREDIT_USD. */
  readonly autoAcceptCreditUsd?: number;
}
const EPS = 1e-6;
const fmtQ = (q: number): string => String(Math.round(q * 10_000) / 10_000);

/** The broker's positions as a ledger map. */
export const positionMap = (ps: readonly BrokerPosition[]): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const p of ps) if (Math.abs(p.qty) > EPS) m[instrumentKey(p.ticker, p.kind)] = (m[instrumentKey(p.ticker, p.kind)] ?? 0) + p.qty;
  return m;
};

export const ledgerFromBroker = (positions: readonly BrokerPosition[], cash: number, now: number): Ledger => ({ positions: positionMap(positions), cash, confirmedAt: now });

/** Adds the bot's own new fills to the ledger (each execId once). Returns how many were new. */
export function applyFills(ledger: Ledger, fills: readonly BrokerFill[], applied: string[]): number {
  let n = 0;
  for (const f of fills) {
    if (applied.includes(f.execId)) continue;
    applied.push(f.execId); n++;
    const k = instrumentKey(f.ticker, f.kind), m = f.kind === 'share' ? 1 : 100;
    const q = (ledger.positions[k] ?? 0) + (f.side === 'BUY' ? f.qty : -f.qty);
    if (Math.abs(q) <= EPS) delete ledger.positions[k]; else ledger.positions[k] = Math.round(q * 1e6) / 1e6;
    ledger.cash = Math.round((ledger.cash + (f.side === 'BUY' ? -(f.qty * f.price * m) - f.fee : f.qty * f.price * m - f.fee)) * 100) / 100;
  }
  return n;
}

/** A split ratio name when `r` is one (2-for-1 ... 20-for-1, 3-for-2, 5-for-4, and the reverse ones), else null. */
export function splitName(r: number): string | null {
  const cands: Array<[number, number]> = [[3, 2], [5, 4], [2, 3], [4, 5]];
  for (let k = 2; k <= 50; k++) cands.push([k, 1], [1, k]);
  for (const [a, b] of cands) if (Math.abs(r - a / b) <= 1e-4 * (a / b)) return a > b ? a + '-for-' + b + ' split' : 'reverse split ' + a + '-for-' + b;
  return null;
}

export function reconcile(ledger: Ledger | null, positions: readonly BrokerPosition[], cash: number, opts: ReconcileOptions = {}): Reconciliation {
  if (!ledger) {
    const m: Mismatch = { kind: 'new', ticker: '', detail: 'no ledger yet: the bot has never confirmed this account (cash $' + cash.toFixed(2) + ', ' + positions.length + ' position(s))' };
    return { ok: false, credit: null, mismatches: [m], alert: alertText([m]) };
  }
  const L = { ...ledger.positions }, B = positionMap(positions);
  const out: Mismatch[] = [];
  const gone = Object.keys(L).filter((k) => !(k in B)).sort(), fresh = Object.keys(B).filter((k) => !(k in L)).sort();
  // renames: one gone, one new, the same quantity
  for (const g of [...gone]) {
    const n = fresh.find((x) => Math.abs(B[x]! - L[g]!) <= EPS * Math.max(1, L[g]!));
    if (!n) continue;
    out.push({ kind: 'rename', ticker: g, detail: g + ' is now ' + n + ' (' + fmtQ(L[g]!) + ' held; a ticker change?)' });
    gone.splice(gone.indexOf(g), 1); fresh.splice(fresh.indexOf(n), 1);
  }
  for (const k of Object.keys(L).filter((x) => x in B).sort()) {
    const l = L[k]!, b = B[k]!;
    if (Math.abs(b - l) <= EPS * Math.max(1, l)) continue;
    const sp = l > 0 ? splitName(b / l) : null;
    out.push(sp ? { kind: 'split', ticker: k, detail: k + ': ' + sp + ' (' + fmtQ(l) + ' → ' + fmtQ(b) + ')' }
      : { kind: 'manual', ticker: k, detail: k + ': the bot holds ' + fmtQ(l) + ', the broker shows ' + fmtQ(b) + ' (' + (b > l ? '+' : '') + fmtQ(b - l) + ', not by the bot)' });
  }
  for (const g of gone) out.push({ kind: 'manual', ticker: g, detail: g + ': the bot holds ' + fmtQ(L[g]!) + ', the broker shows none (sold by hand, or a ticker change)' });
  for (const n of fresh) out.push({ kind: 'manual', ticker: n, detail: n + ': ' + fmtQ(B[n]!) + ' held that the bot never bought' });
  const d = Math.round((cash - ledger.cash) * 100) / 100;
  const limit = opts.autoAcceptCreditUsd ?? AUTO_ACCEPT_CREDIT_USD;
  let credit: AcceptedCredit | null = null;
  if (d > CASH_TOLERANCE && d < limit && !out.length) {
    credit = { amount: d, cash, detail: 'cash +$' + d.toFixed(2) + ' with no position change (a dividend or interest), under the $' + limit.toFixed(2) + ' auto-accept limit; cash now $' + cash.toFixed(2) };
  } else if (Math.abs(d) > CASH_TOLERANCE) {
    out.push(d > 0 ? { kind: 'dividend', ticker: '', detail: 'cash is $' + d.toFixed(2) + ' more than the bot\'s record (a dividend, interest or a deposit)' }
      : { kind: 'cash', ticker: '', detail: 'cash is $' + (-d).toFixed(2) + ' less than the bot\'s record (a charge, a withdrawal or a trade by hand)' });
  }
  return { ok: !out.length, credit, mismatches: out, alert: out.length ? alertText(out) : null };
}

/** Adds an accepted credit to the ledger (the ledger's cash becomes the broker's). Returns true when it changed it. */
export function acceptCredit(ledger: Ledger | null, rec: Reconciliation): boolean {
  if (!ledger || !rec.ok || !rec.credit) return false;
  ledger.cash = Math.round((ledger.cash + rec.credit.amount) * 100) / 100;
  return true;
}

function alertText(ms: readonly Mismatch[]): string {
  return ['⚠️ Live bot: the IBKR account does not match the bot\'s record:', ...ms.map((m) => '• ' + m.detail),
    'The plan is held: nothing is sent until you check the account and confirm (/confirm).', IBKR_APP_STOP].join('\n');
}
