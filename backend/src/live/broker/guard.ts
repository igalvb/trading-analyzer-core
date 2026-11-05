/**
 * R0: the bot never touches the owner's own portfolio. `guardBroker` wraps a broker so that every call naming an
 * account other than the bot's own is refused BEFORE it reaches the broker, and every answer that carries another
 * account's data is refused too (a broker bug cannot leak the owner's positions into a plan). The executor and the
 * control handler only ever hold the guarded broker, built from the one configured account number.
 *
 * Long-only (R1) at the last step: `longOnlyRefusal` checks one order against what the account holds right now:
 * no puts, no short sale, no selling an option not held (writing), no market order (a limit is required), and no
 * margin (the account must be a cash account).
 */

import type { AccountType, Broker, BrokerOrder, BrokerPosition, BrokerFill, LimitOrderRequest, InstrumentKind } from './broker.ts';

export class AccountRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'AccountRefusedError'; }
}

/** IBKR account numbers: letters and digits (e.g. U1234567, DU1234567 for a paper account). */
export const ACCOUNT_RE = /^[A-Z]{1,3}\d{4,10}$/;

export function guardBroker(inner: Broker, botAccount: string): Broker {
  if (!ACCOUNT_RE.test(botAccount)) throw new AccountRefusedError('the bot account number "' + botAccount + '" is not an IBKR account number (LIVE_IBKR_ACCOUNT)');
  const only = (account: string, what: string): void => {
    if (account !== botAccount) throw new AccountRefusedError('R0: ' + what + ' for account ' + account + ' refused: the bot trades only its own account ' + botAccount);
  };
  const mine = <T extends { readonly account: string }>(rows: readonly T[], what: string): readonly T[] => {
    const other = rows.find((r) => r.account !== botAccount);
    if (other) throw new AccountRefusedError('R0: the broker answered ' + what + ' with data of account ' + other.account + '; refused');
    return rows;
  };
  return {
    name: inner.name + ' (only ' + botAccount + ')',
    connectionState: () => inner.connectionState(),
    accounts: async () => {
      const list = await inner.accounts();
      if (!list.includes(botAccount)) throw new AccountRefusedError('R0: the login cannot see the bot account ' + botAccount + ' (it sees ' + list.length + ' other account(s))');
      return [botAccount];
    },
    accountType: async (a): Promise<AccountType> => { only(a, 'reading the account type'); return inner.accountType(a); },
    positions: async (a): Promise<readonly BrokerPosition[]> => { only(a, 'reading positions'); return mine(await inner.positions(a), 'positions'); },
    cash: async (a) => { only(a, 'reading cash'); return inner.cash(a); },
    settledCash: async (a) => { only(a, 'reading settled cash'); return inner.settledCash(a); },
    openOrders: async (a): Promise<readonly BrokerOrder[]> => { only(a, 'reading open orders'); return mine(await inner.openOrders(a), 'open orders'); },
    todaysOrders: async (a): Promise<readonly BrokerOrder[]> => { only(a, 'reading orders'); return mine(await inner.todaysOrders(a), 'orders'); },
    todaysFills: async (a): Promise<readonly BrokerFill[]> => { only(a, 'reading fills'); return mine(await inner.todaysFills(a), 'fills'); },
    quote: (t, k) => inner.quote(t, k),
    placeLimitOrder: async (req: LimitOrderRequest): Promise<BrokerOrder> => {
      only(req.account, 'an order');
      const o = await inner.placeLimitOrder(req);
      mine([o], 'the order');
      return o;
    },
    cancelOrder: async (a, id) => { only(a, 'a cancel'); return inner.cancelOrder(a, id); },
  };
}

export interface LongOnlyInput {
  readonly side: 'BUY' | 'SELL';
  readonly kind: InstrumentKind;
  readonly ticker: string;
  readonly qty: number;
  readonly limit: number;
  readonly held: number;
  readonly accountType: AccountType;
  /** D4: long calls allowed (default yes). */
  readonly allowCalls: boolean;
}

/** Why an order breaks long-only / cash-only at send time, or null. */
export function longOnlyRefusal(o: LongOnlyInput): string | null {
  if (o.accountType !== 'cash') return 'the account is a ' + o.accountType + ' account; the bot trades only in a cash account (no margin)';
  if (o.kind === 'put') return 'puts are not allowed (long-only: shares, ETFs and call options)';
  if (o.kind === 'call' && o.side === 'BUY' && !o.allowCalls) return 'call options are switched off (D4)';
  if (!(o.qty > 0) || !Number.isFinite(o.qty)) return 'the quantity ' + o.qty + ' is not a positive number';
  if (!(o.limit > 0) || !Number.isFinite(o.limit)) return 'no limit price: the bot never sends a market order';
  if (o.side === 'SELL' && o.qty > o.held + 1e-9) {
    return o.kind === 'call' ? 'selling ' + o.qty + ' ' + o.ticker + ' calls with ' + o.held + ' held would write options (not allowed)'
      : 'selling ' + o.qty + ' ' + o.ticker + ' with ' + o.held + ' held would be a short sale (not allowed)';
  }
  return null;
}
