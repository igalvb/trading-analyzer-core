/**
 * The broker as the live bot sees it (docs/live-broker/phases/3-broker-connector.md). One interface, three makers:
 *   fakeBroker.ts   the tests' broker (fills, partial fills, rejects, disconnects, splits, dividends, a second account);
 *   ibkrBroker.ts   the real IBKR adapter: a placeholder until phase 0 picks the API (OAuth Web API or IB Gateway);
 *   guard.ts        wraps either one so that ONLY the bot's own account number can be read or traded (R0).
 *
 * Every call that touches an account names the account; the guard refuses any other number before the call reaches
 * the broker. Orders are limit DAY orders only (there is no market order in this interface) and carry a fixed
 * `orderRef` (R5: the executor checks open orders, today's orders and today's fills for it before every send).
 */

export type ConnectionState = 'connected' | 'disconnected' | 'unknown';
export type InstrumentKind = 'share' | 'call' | 'put';
export type Side = 'BUY' | 'SELL';
export type AccountType = 'cash' | 'margin';

export interface BrokerPosition {
  readonly account: string;
  /** The symbol (an option: the contract's own symbol, e.g. 'NVDA 20270115 150 C'). */
  readonly ticker: string;
  readonly kind: InstrumentKind;
  /** Shares, or contracts for an option; never negative in a long-only cash account. */
  readonly qty: number;
  /** Average cost per share (per contract for an option), fees included. */
  readonly avgCost: number;
}

export type OrderStatus = 'submitted' | 'partial' | 'filled' | 'cancelled' | 'rejected';
export const OPEN_STATUSES: ReadonlySet<OrderStatus> = new Set(['submitted', 'partial']);

export interface LimitOrderRequest {
  readonly account: string;
  /** The fixed reference (planner.ts orderRef): one ref = at most one order a day. */
  readonly orderRef: string;
  readonly ticker: string;
  readonly kind: InstrumentKind;
  readonly side: Side;
  readonly qty: number;
  readonly limit: number;
  readonly tif: 'DAY';
}

export interface BrokerOrder extends LimitOrderRequest {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly filledQty: number;
  /** Why a reject happened, when the broker says. */
  readonly reason?: string;
}

export interface BrokerFill {
  /** The broker's execution id: unique, so a fill is counted once. */
  readonly execId: string;
  readonly orderId: string;
  readonly orderRef: string;
  readonly account: string;
  readonly ticker: string;
  readonly kind: InstrumentKind;
  readonly side: Side;
  readonly qty: number;
  readonly price: number;
  readonly fee: number;
  /** ms */
  readonly at: number;
}

export interface Quote {
  readonly ticker: string;
  readonly last: number;
  /** ms of the last trade. */
  readonly at: number;
}

export interface Broker {
  readonly name: string;
  /** What the link to the broker is now; 'unknown' = no answer yet (e.g. during a reconnect). */
  connectionState(): ConnectionState;
  /** The account numbers the login can see (the bot's must be among them). */
  accounts(): Promise<readonly string[]>;
  accountType(account: string): Promise<AccountType>;
  positions(account: string): Promise<readonly BrokerPosition[]>;
  cash(account: string): Promise<number>;
  /** Cash that has settled (a cash account buys only with it). */
  settledCash(account: string): Promise<number>;
  openOrders(account: string): Promise<readonly BrokerOrder[]>;
  /** Every order of today in any status (open, filled, cancelled, rejected). */
  todaysOrders(account: string): Promise<readonly BrokerOrder[]>;
  todaysFills(account: string): Promise<readonly BrokerFill[]>;
  quote(ticker: string, kind: InstrumentKind): Promise<Quote | null>;
  placeLimitOrder(req: LimitOrderRequest): Promise<BrokerOrder>;
  cancelOrder(account: string, orderId: string): Promise<void>;
}

/** The key of an instrument in a ledger or a position list: the ticker for shares, 'TICKER|call' for an option. */
export const instrumentKey = (ticker: string, kind: InstrumentKind = 'share'): string => (kind === 'share' ? ticker : ticker + '|' + kind);

/** Everything the bot reads of its account before planning or sending (3.1). */
export interface AccountSnapshot {
  readonly account: string;
  readonly accountType: AccountType;
  readonly positions: readonly BrokerPosition[];
  readonly cash: number;
  readonly settledCash: number;
  readonly openOrders: readonly BrokerOrder[];
  readonly todaysOrders: readonly BrokerOrder[];
  readonly todaysFills: readonly BrokerFill[];
}

export async function readSnapshot(b: Broker, account: string): Promise<AccountSnapshot> {
  const [accountType, positions, cash, settledCash, openOrders, todaysOrders, todaysFills] = await Promise.all([
    b.accountType(account), b.positions(account), b.cash(account), b.settledCash(account), b.openOrders(account), b.todaysOrders(account), b.todaysFills(account),
  ]);
  return { account, accountType, positions, cash, settledCash, openOrders, todaysOrders, todaysFills };
}

/** Held quantity of an instrument in a snapshot. */
export function heldQty(s: Pick<AccountSnapshot, 'positions'>, ticker: string, kind: InstrumentKind = 'share'): number {
  return s.positions.filter((p) => p.ticker === ticker && p.kind === kind).reduce((x, p) => x + p.qty, 0);
}
