/**
 * PLACEHOLDER — the real Interactive Brokers adapter is NOT built (phase 3 scope: code against FakeBroker only).
 * Phase 0 decides the API (F1): IBKR's OAuth Web API (no gateway; the bot could then run in GitHub Actions) or the
 * Client Portal / TWS API through IB Gateway + IBC on the bot's server (phase 2). Until then every call throws
 * "not configured", so nothing can ever reach IBKR by accident.
 *
 * What the adapter must implement (the `Broker` interface of broker.ts), and the IBKR facts each one depends on:
 *   connectionState()   'connected' only when the session is logged in AND authenticated for trading; 'unknown'
 *                       while (re)connecting; 'disconnected' otherwise (Gateway down, 2FA pending, logged out)
 *   accounts()          the account numbers the bot's IBKR user sees (must include LIVE_IBKR_ACCOUNT; R0)
 *   accountType(a)      'cash' or 'margin' (the bot refuses to trade a margin account)
 *   positions(a)        shares, ETFs and option contracts with quantity and average cost, for account `a` only
 *   cash(a)             total cash; settledCash(a): settled cash (phase 0 F5: IBKR's "settled cash" field)
 *   openOrders(a)       working orders WITH their orderRef (IBKR "order reference" / cOID must round-trip)
 *   todaysOrders(a)     every order of today in any status (including cancelled and rejected) with orderRef
 *   todaysFills(a)      today's executions with execId, orderRef, price, commission (commission reports)
 *   quote(t, kind)      last trade price and its time (phase 0 F7: market-data subscription or delayed data —
 *                       delayed data must be refused by the R4 freshness check)
 *   placeLimitOrder(r)  LMT, TIF DAY, outsideRTH false, account = r.account, orderRef = r.orderRef; fractional
 *                       quantities only if phase 0 F2/F3 allow them for that ticker; answer the IBKR order id;
 *                       the Web API's order "reply" confirmations (precautionary warnings) must be answered
 *                       explicitly and logged, never auto-confirmed blindly
 *   cancelOrder(a, id)  cancel one working order
 * Also: never call any endpoint that transfers money or changes account settings; the bot's IBKR user has trading
 * permission on the bot account only (phase 0 O4).
 */

import type { AccountType, Broker, BrokerFill, BrokerOrder, BrokerPosition, ConnectionState, InstrumentKind, LimitOrderRequest, Quote } from './broker.ts';

export const IBKR_NOT_CONFIGURED = 'the IBKR adapter is not configured: phase 0 has not chosen the API (OAuth Web API or IB Gateway), so no call can reach IBKR';

export class IbkrBrokerNotConfigured implements Broker {
  readonly name = 'IBKR (not configured)';
  private fail(): never { throw new Error(IBKR_NOT_CONFIGURED); }
  connectionState(): ConnectionState { return 'disconnected'; }
  async accounts(): Promise<readonly string[]> { return this.fail(); }
  async accountType(_a: string): Promise<AccountType> { return this.fail(); }
  async positions(_a: string): Promise<readonly BrokerPosition[]> { return this.fail(); }
  async cash(_a: string): Promise<number> { return this.fail(); }
  async settledCash(_a: string): Promise<number> { return this.fail(); }
  async openOrders(_a: string): Promise<readonly BrokerOrder[]> { return this.fail(); }
  async todaysOrders(_a: string): Promise<readonly BrokerOrder[]> { return this.fail(); }
  async todaysFills(_a: string): Promise<readonly BrokerFill[]> { return this.fail(); }
  async quote(_t: string, _k: InstrumentKind): Promise<Quote | null> { return this.fail(); }
  async placeLimitOrder(_r: LimitOrderRequest): Promise<BrokerOrder> { return this.fail(); }
  async cancelOrder(_a: string, _id: string): Promise<void> { return this.fail(); }
}

export function ibkrBroker(): Broker { throw new Error(IBKR_NOT_CONFIGURED); }
