/**
 * "🤖 Claude, free choice" (request of 2026-11-06): one more $100,000 paper account where the AI assistant picks any
 * stock, ETF or LONG call. Its orders are rows of the '🤖 Claude Picks' tab in the reports sheet (appended by
 * `npm run claude-order`, src/claudeOrder.ts); the paper night (paperJob.ts) reads them and fills them here with the
 * same rules as every account:
 *   - long-only: stocks, ETFs and long calls; a sale of more than is held (a short), a put or any other kind is rejected;
 *   - no margin: a BUY over the cash is rejected (never cut down);
 *   - 25% tax on every sale's gain (average cost), as the others;
 *   - the information rule: an order decided on day D fills at the first open after D (decided before the open of a
 *     trading day = that day's open), so it only ever saw the closes before its fill. Shares fill at the open of the
 *     price chart the other accounts use; calls at the night's Cboe quote of the fill day (the LEAPS accounts' source:
 *     buy at the ask, sell at the bid), waiting at most CLAUDE_QUOTE_NIGHTS nights when no chain came that night;
 *   - an order that cannot be priced is REJECTED with the reason; an order is never filled twice (the state keeps every
 *     order's outcome by its key; a Status already FILLED / REJECTED in the tab is never acted on again);
 *   - an order whose fill day was handled before the order was there (typed in late) is REJECTED: never back-filled.
 * Idle money stays in cash. A call still held on its expiry day is settled at its intrinsic value at that close. The
 * account joins the test on its first filled order (no values before) and is judged against "📊 QQQ since this account
 * joined". Nothing here computes a score.
 */

import crypto from 'node:crypto';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { CONTRACT, type LeapsQuote } from './paperLeaps.ts';

export const CLAUDE_ID = 'claude.free';
export const CLAUDE_LABEL = '🤖 Claude, free choice';
export const CLAUDE_GROUP = 'Claude';
export const CLAUDE_PICKS_TAB = '🤖 Claude Picks';
export const CLAUDE_PICKS_HEADER: readonly string[] = [
  'Decided (YYYY-MM-DD, New York)', 'Action (BUY / SELL / SELL ALL)', 'Ticker', 'Kind (stock / call)', 'Strike', 'Expiry (YYYY-MM-DD)',
  'Amount ($, BUY only)', 'Shares/contracts (SELL only; empty = all)', 'Reason', 'Status (written by the job: FILLED date+price / REJECTED reason)',
];
/** A call order waits at most this many nights for a quote (a night without Cboe's chain: a missed night, an outage). */
export const CLAUDE_QUOTE_NIGHTS = 5;
/** The open (New York): an order decided before it, on a trading day, fills at that day's open. */
export const CLAUDE_OPEN_HHMM = '09:30';

export type ClaudeAction = 'BUY' | 'SELL' | 'SELL ALL';
export type ClaudeKind = 'stock' | 'call';

/** The order's fields as typed (strings), before the checks. */
export interface ClaudeFields {
  readonly decided: string; readonly action: string; readonly ticker: string; readonly kind: string; readonly strike: string;
  readonly expiry: string; readonly amount: string; readonly qty: string; readonly reason: string;
}
export interface ClaudeOrder {
  readonly decided: string; readonly preOpen: boolean; readonly action: ClaudeAction; readonly ticker: string; readonly kind: ClaudeKind;
  readonly strike: number | null; readonly expiry: string | null; readonly amount: number | null; readonly qty: number | null; readonly reason: string;
}
/** One row of the tab: its key (never filled twice), its 1-based sheet row, the order or why it is invalid, and the Status cell. */
export interface ClaudeRow {
  readonly key: string; readonly row: number; readonly cells: readonly string[]; readonly status: string;
  readonly order: ClaudeOrder | null; readonly invalid: string | null;
}

const TICKER = /^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z])?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/;

/** 'YYYY-MM-DD' (optionally ' HH:MM') that is a real calendar day, else null. */
export function claudeDate(x: string): { day: string; hhmm: string | null } | null {
  const m = DATE.exec(x.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  if (m[4] != null && (Number(m[4]) > 23 || Number(m[5]) > 59)) return null;
  return { day: m[1] + '-' + m[2] + '-' + m[3], hhmm: m[4] != null ? m[4] + ':' + m[5] : null };
}

const num = (x: string): number | null => {
  const s = x.trim().replace(/[$,]/g, '');
  if (!s) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
};

/**
 * The checks every order passes (the CLI before it appends, the job before it fills): the order, or one line saying
 * why it is refused. `today` (YYYY-MM-DD): a call must expire after it (the CLI's check; the job checks the fill day).
 */
export function checkClaudeOrder(f: ClaudeFields, today?: string): { ok: true; order: ClaudeOrder } | { ok: false; why: string } {
  const bad = (why: string): { ok: false; why: string } => ({ ok: false, why });
  const dt = claudeDate(f.decided);
  if (!dt) return bad('bad Decided date "' + f.decided.trim() + '" (YYYY-MM-DD, New York)');
  const action = f.action.trim().toUpperCase().replace(/[\s_-]+/g, ' ');
  if (action === 'SHORT' || action === 'SELL SHORT' || action === 'SHORT SELL') return bad('short selling is not allowed (long-only)');
  if (action !== 'BUY' && action !== 'SELL' && action !== 'SELL ALL') return bad('Action must be BUY, SELL or SELL ALL, not "' + f.action.trim() + '"');
  const ticker = f.ticker.trim().toUpperCase();
  if (!TICKER.test(ticker)) return bad('"' + f.ticker.trim() + '" is not a stock or ETF ticker');
  const k = f.kind.trim().toLowerCase();
  if (k === 'put' || k === 'puts') return bad('puts are not allowed (long calls only)');
  if (k !== 'stock' && k !== 'etf' && k !== 'call') return bad('Kind must be stock or call, not "' + f.kind.trim() + '"');
  const kind: ClaudeKind = k === 'call' ? 'call' : 'stock';
  let strike: number | null = null, expiry: string | null = null;
  if (kind === 'call') {
    strike = num(f.strike);
    if (strike == null || !(strike > 0)) return bad('a call needs a Strike above 0');
    const e = claudeDate(f.expiry);
    if (!e || e.hhmm) return bad('a call needs an Expiry date (YYYY-MM-DD)');
    expiry = e.day;
    if (today && expiry <= today) return bad('the call expires on ' + expiry + ', not after today (' + today + ')');
  } else if (f.strike.trim() || f.expiry.trim()) return bad('Strike and Expiry are for calls only');
  const amount = num(f.amount), qty = num(f.qty);
  if (Number.isNaN(amount) || Number.isNaN(qty)) return bad('Amount and Shares/contracts must be numbers');
  if (action === 'BUY') {
    if (amount == null || !(amount > 0)) return bad('a BUY needs an Amount above $0' + (amount != null && amount < 0 ? ' (long-only)' : ''));
    if (qty != null) return bad('a BUY takes an Amount, not Shares/contracts');
  } else {
    if (amount != null) return bad('a SELL takes Shares/contracts (or none = all), not an Amount');
    if (qty != null && (!(qty > 0) || !Number.isInteger(qty))) return bad('Shares/contracts must be a whole number above 0' + (qty < 0 ? ' (long-only)' : ''));
    if (action === 'SELL ALL' && qty != null) return bad('SELL ALL takes no Shares/contracts');
  }
  const reason = f.reason.trim();
  if (!reason) return bad('a Reason is needed');
  return {
    ok: true,
    order: { decided: dt.day, preOpen: dt.hhmm != null && dt.hhmm < CLAUDE_OPEN_HHMM, action, ticker, kind, strike, expiry, amount: action === 'BUY' ? amount : null, qty: action === 'SELL' ? qty : null, reason },
  };
}

/** A sheet cell as text; a date serial (a date typed by hand) as YYYY-MM-DD (HH:MM when it has a time). */
function cellText(v: unknown, dateCol: boolean): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && dateCol && v > 20_000 && v < 80_000) {
    const ms = Math.round((v - 25_569) * 86_400_000), d = new Date(ms).toISOString();
    return d.slice(0, 10) + (v % 1 ? ' ' + d.slice(11, 16) : '');
  }
  return v == null ? '' : String(v).trim();
}

/** The tab's rows (header first, as read) as orders with their keys; rows with nothing in A-I are skipped. */
export function claudeRows(rows: readonly (readonly unknown[])[]): ClaudeRow[] {
  const out: ClaudeRow[] = [];
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    if (i === 0) return;
    const cells = Array.from({ length: 10 }, (_, c) => cellText(r[c], c === 0 || c === 5));
    if (cells.slice(0, 9).every((c) => !c)) return;
    const f: ClaudeFields = { decided: cells[0]!, action: cells[1]!, ticker: cells[2]!, kind: cells[3]!, strike: cells[4]!, expiry: cells[5]!, amount: cells[6]!, qty: cells[7]!, reason: cells[8]! };
    const base = crypto.createHash('sha256').update(cells.slice(0, 9).join('\u001f'), 'utf8').digest('hex').slice(0, 16);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const c = checkClaudeOrder(f);
    out.push({ key: base + '#' + n, row: i + 1, cells, status: cells[9]!, order: c.ok ? c.order : null, invalid: c.ok ? null : c.why });
  });
  return out;
}

/** The first trading day the order fills on: the first in `days` after D (on D when decided before D's open); null = not yet known. */
export function claudeFillDay(o: Pick<ClaudeOrder, 'decided' | 'preOpen'>, days: readonly string[]): string | null {
  for (const x of days) if (o.preOpen ? x >= o.decided : x > o.decided) return x;
  return null;
}

export interface ClaudePos { readonly kind: ClaudeKind; readonly ticker: string; readonly strike?: number; readonly expiry?: string; qty: number; cost: number; mark: number | null }
/** Tonight's lines for the 📒 Paper Log besides the fills: rejections and orders waiting for a quote. */
export interface ClaudeNote { readonly day: string; readonly action: string; readonly ticker: string; readonly qty: string | number; readonly why: string }
export interface ClaudeBook {
  cash: number; taxPaid: number;
  /** By position name: the ticker for shares, "NVDA $150 call 2027-01-15" for a call. */
  pos: Record<string, ClaudePos>;
  /** Every order handled, by key: its Status ("FILLED ..." / "REJECTED: ..."). */
  done: Record<string, string>;
  /** Call orders waiting for a quote: nights waited. */
  waits: Record<string, number>;
  /** The first fill's day (the account joined then); null before. */
  joined: string | null;
  notes: ClaudeNote[];
}
export const newClaudeBook = (cash: number): ClaudeBook => ({ cash, taxPaid: 0, pos: {}, done: {}, waits: {}, joined: null, notes: [] });

export const claudePosName = (o: { ticker: string; kind: ClaudeKind; strike?: number | null; expiry?: string | null }): string =>
  o.kind === 'call' ? o.ticker + ' $' + o.strike + ' call ' + o.expiry : o.ticker;

export interface ClaudeNight {
  readonly day: string;
  readonly rows: readonly ClaudeRow[];
  /** The trading days known tonight (QQQ's bars), for the fill day. */
  readonly tradingDays: readonly string[];
  /** Tonight's bar of any ticker (the price charts the other accounts use). */
  readonly bar: (t: string) => { readonly open: number; readonly close: number } | null;
  /** Tonight's Cboe quote for a call: null = no chain for that stock tonight, 'missing' = the chain has no such contract. */
  readonly quote: (ticker: string, strike: number, expiry: string) => LeapsQuote | 'missing' | null;
  /** Fill tonight (false before the test's start). */
  readonly fill: boolean;
}
export interface ClaudeTrade { readonly side: 'BUY' | 'SELL'; readonly ticker: string; readonly shares: number; readonly price: number; readonly value: number; readonly tax: number; readonly why: string }

const money = (v: number): string => '$' + (Math.round(v * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One closed trading day: tonight's fills (sells first, then buys, each in row order), the call marks, expiries. */
export function claudeDay(b: ClaudeBook, n: ClaudeNight): ClaudeTrade[] {
  const d = n.day, out: ClaudeTrade[] = [];
  b.notes = [];
  if (!n.fill) return out;
  const note = (o: ClaudeRow, action: string, why: string): void => {
    const x = o.order;
    b.notes.push({ day: d, action, ticker: x ? claudePosName(x) : o.cells[2] || '?', qty: x?.action === 'BUY' ? money(x.amount ?? 0) : x?.qty ?? (x ? 'all' : ''), why: why + (x ? ' — ' + x.reason : '') });
  };
  const reject = (o: ClaudeRow, why: string): void => { b.done[o.key] = 'REJECTED: ' + why; delete b.waits[o.key]; note(o, 'REJECTED', why); };
  const due: ClaudeRow[] = [];
  for (const o of n.rows) {
    if (b.done[o.key]) continue;
    // a Status the tab already has (a state that lost it): never acted on again
    if (/^(FILLED|REJECTED)/i.test(o.status)) { b.done[o.key] = o.status; continue; }
    if (!o.order) { reject(o, o.invalid ?? 'invalid'); continue; }
    const fd = claudeFillDay(o.order, n.tradingDays);
    if (!fd || fd > d) continue;
    if (fd < d && b.waits[o.key] == null) { reject(o, 'its fill day ' + fd + ' was handled before the order was there (orders are never back-filled)'); continue; }
    due.push(o);
  }
  const sells = due.filter((o) => o.order!.action !== 'BUY'), buys = due.filter((o) => o.order!.action === 'BUY');
  for (const o of [...sells, ...buys]) {
    const x = o.order!, name = claudePosName(x), call = x.kind === 'call', unit = call ? CONTRACT : 1;
    if (call && (x.expiry as string) <= d) { reject(o, 'the call expires on ' + x.expiry + ', not after the fill day ' + d); continue; }
    // the price: shares at tonight's open, a call at tonight's quote (the ask to buy, the bid to sell)
    let px: number;
    if (call) {
      const q = n.quote(x.ticker, x.strike as number, x.expiry as string);
      if (q == null) {
        const w = (b.waits[o.key] ?? 0) + 1;
        if (w >= CLAUDE_QUOTE_NIGHTS) { reject(o, 'no option quote for ' + name + ' in ' + w + ' nights'); continue; }
        b.waits[o.key] = w;
        note(o, 'WAITING', 'no Cboe chain for ' + x.ticker + ' tonight (night ' + w + ' of ' + CLAUDE_QUOTE_NIGHTS + ')');
        continue;
      }
      if (q === 'missing') { reject(o, 'no such contract in Cboe\'s chain: ' + name); continue; }
      const p = x.action === 'BUY' ? q.ask : q.bid;
      if (!(p > 0)) { reject(o, 'no ' + (x.action === 'BUY' ? 'ask' : 'bid') + ' quote for ' + name + ' tonight (cannot be priced)'); continue; }
      px = p;
    } else {
      const bar = n.bar(x.ticker);
      if (!bar || !(bar.open > 0)) { reject(o, 'no price for ' + x.ticker + ' at the open of ' + d + ' (cannot be priced)'); continue; }
      px = bar.open;
    }
    if (x.action === 'BUY') {
      const amount = x.amount as number;
      if (amount > b.cash + 1e-9) { reject(o, 'no margin: ' + money(amount) + ' is more than the cash ' + money(b.cash)); continue; }
      const k = Math.floor(amount / (px * unit) + 1e-9);
      if (k <= 0) { reject(o, money(amount) + ' buys no ' + (call ? 'contract' : 'share') + ' at ' + money(px)); continue; }
      b.cash -= k * px * unit;
      const p = b.pos[name] ??= { kind: x.kind, ticker: x.ticker, ...(call ? { strike: x.strike as number, expiry: x.expiry as string } : {}), qty: 0, cost: 0, mark: null };
      p.qty += k; p.cost += k * px * unit;
      if (call) { const q = n.quote(x.ticker, x.strike as number, x.expiry as string); p.mark = q && q !== 'missing' && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : px; } else p.mark = n.bar(x.ticker)?.close ?? px;
      out.push({ side: 'BUY', ticker: name, shares: k, price: px, value: k * px * unit, tax: 0, why: x.reason });
      b.done[o.key] = 'FILLED ' + d + ' at ' + money(px) + ' (' + k + (call ? ' contract' : ' share') + (k === 1 ? '' : 's') + ')';
    } else {
      const p = b.pos[name];
      if (!p) { reject(o, name + ' is not held: selling it would be a short (long-only)'); continue; }
      const k = x.qty ?? p.qty;
      if (k > p.qty) { reject(o, 'selling ' + k + ' of ' + name + ' but ' + p.qty + ' held: the rest would be a short (long-only)'); continue; }
      const part = (p.cost * k) / p.qty, value = k * px * unit, tax = Math.max(0, value - part) * EXIT_TAX_RATE;
      b.cash += value - tax; b.taxPaid += tax; p.qty -= k; p.cost -= part;
      if (p.qty <= 0) delete b.pos[name];
      out.push({ side: 'SELL', ticker: name, shares: k, price: px, value, tax, why: x.reason });
      b.done[o.key] = 'FILLED ' + d + ' at ' + money(px) + ' (' + k + (call ? ' contract' : ' share') + (k === 1 ? '' : 's') + (tax > 0 ? ', tax ' + money(tax) : '') + ')';
    }
    delete b.waits[o.key];
    b.joined ??= d;
  }
  // tonight's marks; a call on its expiry day (or after) is settled at its intrinsic value at the stock's close
  for (const [name, p] of Object.entries(b.pos)) {
    const bar = n.bar(p.ticker);
    if (p.kind === 'stock') { if (bar) p.mark = bar.close; continue; }
    const q = n.quote(p.ticker, p.strike as number, p.expiry as string);
    if (q && q !== 'missing' && q.bid > 0 && q.ask > 0) p.mark = (q.bid + q.ask) / 2;
    if ((p.expiry as string) <= d && bar) {
      const px = Math.max(0, bar.close - (p.strike as number)), value = p.qty * px * CONTRACT, tax = Math.max(0, value - p.cost) * EXIT_TAX_RATE;
      b.cash += value - tax; b.taxPaid += tax; delete b.pos[name];
      out.push({ side: 'SELL', ticker: name, shares: p.qty, price: px, value, tax, why: px > 0 ? 'expired ' + p.expiry + ': settled at the intrinsic value (close ' + money(bar.close) + ')' : 'expired worthless ' + p.expiry + ' (close ' + money(bar.close) + ')' });
    }
  }
  return out;
}

/** Value after the tax on what is still held: shares at `closeOf` (else the last mark), calls at the last middle of bid and ask. */
export function claudeValue(b: ClaudeBook, closeOf: (t: string) => number | null): number {
  let v = b.cash;
  for (const p of Object.values(b.pos)) {
    const val = p.kind === 'stock' ? p.qty * (closeOf(p.ticker) ?? p.mark ?? p.cost / p.qty) : p.qty * CONTRACT * (p.mark ?? p.cost / p.qty / CONTRACT);
    v += val - Math.max(0, val - p.cost) * EXIT_TAX_RATE;
  }
  return v;
}

export const claudeHeld = (b: ClaudeBook): string[] => Object.keys(b.pos).sort();
