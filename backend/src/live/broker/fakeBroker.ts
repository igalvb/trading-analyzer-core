/**
 * A broker in memory for the tests (phase 3) and for rehearsals without IBKR. It behaves like a cash account:
 *   - limit DAY orders; a buy needs settled cash (an unsettled buy is rejected and recorded as a violation), a sell
 *     needs the shares (a short sale is rejected and recorded as a violation); sale money settles at `settle()` (T+1);
 *   - fills follow a rule per ticker: 'full' (fills at once at the limit or better), 'partial' (a share of the order,
 *     the rest stays open), 'none' (stays open until `fill()` or the end of the day), 'reject' (with a reason);
 *   - `disconnect()` makes every call fail and the state 'disconnected'; `loseNextReply()` accepts the next order but
 *     loses the answer (the case that makes duplicate orders: the sender does not know it was received);
 *   - corporate actions: `split`, `dividend`, `rename`; and `manualTrade` (the owner trading by hand in the account);
 *   - any number of accounts: the tests keep a second one (the owner's own) that must never be touched.
 * `requests` keeps every order request that reached the broker, whatever the account, so a test can prove none named
 * another account.
 */

import { orderFee, IBKR_PRO_FIXED, type FeeSchedule } from '../liveConfig.ts';
import { OPEN_STATUSES, type AccountType, type Broker, type BrokerFill, type BrokerOrder, type BrokerPosition, type ConnectionState, type InstrumentKind, type LimitOrderRequest, type Quote } from './broker.ts';

export type FillRule = { readonly mode: 'full' } | { readonly mode: 'partial'; readonly share: number } | { readonly mode: 'none' } | { readonly mode: 'reject'; readonly reason: string };

export class BrokerDisconnectedError extends Error {
  constructor(message = 'the broker is not connected') { super(message); this.name = 'BrokerDisconnectedError'; }
}

interface Pos { qty: number; cost: number }
interface Acct { type: AccountType; cash: number; settled: number; pos: Map<string, Pos> }
type MutOrder = { -readonly [K in keyof BrokerOrder]: BrokerOrder[K] };

const key = (t: string, k: InstrumentKind): string => t + '|' + k;
const mult = (k: InstrumentKind): number => (k === 'share' ? 1 : 100);
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export class FakeBroker implements Broker {
  readonly name = 'fake broker';
  readonly requests: LimitOrderRequest[] = [];
  readonly violations: string[] = [];
  readonly cancels: string[] = [];
  private readonly accts = new Map<string, Acct>();
  private orders: MutOrder[] = [];
  private fills: BrokerFill[] = [];
  private readonly quotes = new Map<string, Quote>();
  private readonly rules = new Map<string, FillRule>();
  private state: ConnectionState = 'connected';
  private loseReply = false;
  private seq = 0;
  private clock: () => number;
  private readonly fees: FeeSchedule;

  constructor(opts: { now?: () => number; fees?: FeeSchedule } = {}) {
    this.clock = opts.now ?? Date.now;
    this.fees = opts.fees ?? IBKR_PRO_FIXED;
  }

  // ---- set-up and simulation (tests) ----
  setClock(now: () => number): void { this.clock = now; }
  addAccount(id: string, cash: number, positions: Readonly<Record<string, { qty: number; avgCost: number; kind?: InstrumentKind }>> = {}, type: AccountType = 'cash'): this {
    const pos = new Map<string, Pos>();
    for (const [t, p] of Object.entries(positions)) pos.set(key(t, p.kind ?? 'share'), { qty: p.qty, cost: p.qty * p.avgCost * mult(p.kind ?? 'share') });
    this.accts.set(id, { type, cash, settled: cash, pos });
    return this;
  }
  setQuote(ticker: string, last: number, at?: number): void { this.quotes.set(ticker, { ticker, last, at: at ?? this.clock() }); }
  setRule(ticker: string, rule: FillRule): void { this.rules.set(ticker, rule); }
  disconnect(state: ConnectionState = 'disconnected'): void { this.state = state; }
  reconnect(): void { this.state = 'connected'; }
  /** The next order is accepted by the broker but its answer never arrives (the sender sees an error). */
  loseNextReply(): void { this.loseReply = true; }
  /** Sale money becomes settled (T+1). */
  settle(): void { for (const a of this.accts.values()) a.settled = a.cash; }
  /** A new trading day: open DAY orders expire, today's lists empty, money settles. */
  newDay(): void {
    for (const o of this.orders) if (OPEN_STATUSES.has(o.status)) o.status = 'cancelled';
    this.orders = []; this.fills = []; this.settle();
  }
  split(ticker: string, ratio: number): void {
    for (const a of this.accts.values()) { const p = a.pos.get(key(ticker, 'share')); if (p) p.qty = r6(p.qty * ratio); }
  }
  dividend(ticker: string, perShare: number): void {
    for (const a of this.accts.values()) { const p = a.pos.get(key(ticker, 'share')); if (p) { const d = Math.round(p.qty * perShare * 100) / 100; a.cash += d; a.settled += d; } }
  }
  rename(from: string, to: string): void {
    for (const a of this.accts.values()) { const p = a.pos.get(key(from, 'share')); if (p) { a.pos.delete(key(from, 'share')); a.pos.set(key(to, 'share'), p); } }
    const q = this.quotes.get(from); if (q) this.quotes.set(to, { ...q, ticker: to });
  }
  /** The owner trades by hand in an account (outside the bot): +qty buys, -qty sells. */
  manualTrade(account: string, ticker: string, qty: number, price: number): void {
    const a = this.acct(account), k = key(ticker, 'share'), p = a.pos.get(k) ?? { qty: 0, cost: 0 };
    if (qty > 0) { p.qty += qty; p.cost += qty * price; a.cash -= qty * price; a.settled -= qty * price; } else { const per = p.qty > 0 ? p.cost / p.qty : 0; p.qty += qty; p.cost += qty * per; a.cash -= qty * price; }
    if (p.qty <= 1e-9) a.pos.delete(k); else a.pos.set(k, p);
  }
  /** Fills `qty` (default: all that is left) of an open order at `price` (default: its limit). */
  fill(orderId: string, qty?: number, price?: number): void {
    const o = this.orders.find((x) => x.orderId === orderId);
    if (!o || !OPEN_STATUSES.has(o.status)) throw new Error('fake broker: order ' + orderId + ' is not open');
    this.execute(o, qty ?? o.qty - o.filledQty, price ?? o.limit);
  }
  /** Fills every open order of `ticker` (all accounts) whose limit the price reaches. */
  trade(ticker: string, price: number): void {
    for (const o of this.orders.filter((x) => x.ticker === ticker && OPEN_STATUSES.has(x.status))) {
      if (o.side === 'BUY' ? price <= o.limit : price >= o.limit) this.execute(o, o.qty - o.filledQty, price);
    }
  }
  /** Read without the connection check (tests). */
  peek(account: string): { cash: number; settled: number; positions: Record<string, number> } {
    const a = this.acct(account);
    return { cash: Math.round(a.cash * 100) / 100, settled: Math.round(a.settled * 100) / 100, positions: Object.fromEntries([...a.pos].map(([k, p]) => [k.endsWith('|share') ? k.slice(0, -6) : k, p.qty])) };
  }
  allOrders(): readonly BrokerOrder[] { return this.orders.map((o) => ({ ...o })); }

  // ---- the Broker interface ----
  connectionState(): ConnectionState { return this.state; }
  async accounts(): Promise<readonly string[]> { this.up(); return [...this.accts.keys()]; }
  async accountType(account: string): Promise<AccountType> { this.up(); return this.acct(account).type; }
  async positions(account: string): Promise<readonly BrokerPosition[]> {
    this.up();
    return [...this.acct(account).pos].map(([k, p]) => { const [ticker, kind] = k.split('|') as [string, InstrumentKind]; return { account, ticker, kind, qty: p.qty, avgCost: p.qty > 0 ? p.cost / p.qty / mult(kind) : 0 }; });
  }
  async cash(account: string): Promise<number> { this.up(); return Math.round(this.acct(account).cash * 100) / 100; }
  async settledCash(account: string): Promise<number> { this.up(); return Math.round(this.acct(account).settled * 100) / 100; }
  async openOrders(account: string): Promise<readonly BrokerOrder[]> { this.up(); return this.orders.filter((o) => o.account === account && OPEN_STATUSES.has(o.status)).map((o) => ({ ...o })); }
  async todaysOrders(account: string): Promise<readonly BrokerOrder[]> { this.up(); return this.orders.filter((o) => o.account === account).map((o) => ({ ...o })); }
  async todaysFills(account: string): Promise<readonly BrokerFill[]> { this.up(); return this.fills.filter((f) => f.account === account); }
  async quote(ticker: string): Promise<Quote | null> { this.up(); return this.quotes.get(ticker) ?? null; }

  async placeLimitOrder(req: LimitOrderRequest): Promise<BrokerOrder> {
    this.up();
    this.requests.push(req);
    const a = this.acct(req.account);
    const o: MutOrder = { ...req, orderId: 'O' + ++this.seq, status: 'submitted', filledQty: 0 };
    this.orders.push(o);
    const reject = (why: string, violation = false): void => { o.status = 'rejected'; o.reason = why; if (violation) this.violations.push(req.account + ' ' + req.orderRef + ': ' + why); };
    const held = a.pos.get(key(req.ticker, req.kind))?.qty ?? 0;
    const cost = req.qty * req.limit * mult(req.kind) + orderFee(req.qty, req.limit * mult(req.kind), this.fees);
    if (req.kind === 'put') reject('puts refused', true);
    else if (req.side === 'SELL' && req.qty > held + 1e-9) reject('short sale / writing refused', true);
    else if (req.side === 'BUY' && cost > a.settled + 1e-6) reject('not enough settled cash ($' + a.settled.toFixed(2) + ' for $' + cost.toFixed(2) + ')', true);
    else {
      const rule = this.rules.get(req.ticker) ?? { mode: 'none' };
      if (rule.mode === 'reject') reject(rule.reason);
      else if (rule.mode === 'full') this.execute(o, req.qty, req.limit);
      else if (rule.mode === 'partial') this.execute(o, r6(Math.max(0, Math.floor(req.qty * rule.share * 10_000) / 10_000)), req.limit);
    }
    if (this.loseReply) { this.loseReply = false; this.state = 'unknown'; throw new BrokerDisconnectedError('the connection dropped while sending ' + req.orderRef + ' (the broker may have received it)'); }
    return { ...o };
  }

  async cancelOrder(account: string, orderId: string): Promise<void> {
    this.up();
    const o = this.orders.find((x) => x.orderId === orderId && x.account === account);
    if (!o) throw new Error('fake broker: no order ' + orderId + ' in ' + account);
    this.cancels.push(orderId);
    if (OPEN_STATUSES.has(o.status)) o.status = 'cancelled';
  }

  // ---- inside ----
  private up(): void { if (this.state !== 'connected') throw new BrokerDisconnectedError(); }
  private acct(id: string): Acct { const a = this.accts.get(id); if (!a) throw new Error('fake broker: no account ' + id); return a; }
  private execute(o: MutOrder, qty: number, price: number): void {
    qty = r6(Math.min(qty, o.qty - o.filledQty));
    if (!(qty > 0)) return;
    const a = this.acct(o.account), k = key(o.ticker, o.kind), m = mult(o.kind);
    const fee = orderFee(qty, price * m, this.fees);
    const p = a.pos.get(k) ?? { qty: 0, cost: 0 };
    if (o.side === 'BUY') { p.qty = r6(p.qty + qty); p.cost += qty * price * m + fee; a.cash -= qty * price * m + fee; a.settled -= qty * price * m + fee; } else {
      const per = p.qty > 0 ? p.cost / p.qty : 0; p.qty = r6(p.qty - qty); p.cost -= qty * per; a.cash += qty * price * m - fee; // settles at settle()
    }
    if (p.qty <= 1e-9) a.pos.delete(k); else a.pos.set(k, p);
    o.filledQty = r6(o.filledQty + qty);
    o.status = o.filledQty >= o.qty - 1e-9 ? 'filled' : 'partial';
    this.fills.push({ execId: 'E' + ++this.seq, orderId: o.orderId, orderRef: o.orderRef, account: o.account, ticker: o.ticker, kind: o.kind, side: o.side, qty, price, fee, at: this.clock() });
  }
}

