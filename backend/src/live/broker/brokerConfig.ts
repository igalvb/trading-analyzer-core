/**
 * The broker connector's settings (phase 3), read from the environment of the bot's server (never from GitHub
 * Actions, the repo or a Sheet: R2):
 *
 *   LIVE_IBKR_ACCOUNT          the bot's OWN IBKR account number (R0); required; every other number is refused
 *   LIVE_LIMIT_BAND            limit = last trade ± this share (default 0.005 = 0.5%): buys at last × 1.005,
 *                              sells at last × 0.995; never a market order
 *   LIVE_SEND_AFTER_OPEN_MIN   minutes after the 9:30 open before the first send (default 5: not in the opening auction)
 *   LIVE_SEND_WINDOW_MIN       minutes the window stays open after that (default 30); anything unfilled at its end is
 *                              cancelled and reappears in tomorrow's plan
 *   LIVE_APPROVE               '1' (default, D2) = each plan needs the owner's ✅ before the open; '0' = auto mode
 *   LIVE_MAX_QUOTE_AGE_SEC     a last trade older than this is stale (R4): the order waits (default 120)
 *   LIVE_ALLOW_CALLS           '1' (default, D4) = long calls allowed; '0' = shares and ETFs only
 *   LIVE_CONTROL_SKEW_SEC      a signed control call older or newer than this is refused (default 300)
 *   LIVE_AUTO_ACCEPT_CREDIT_USD  cash credits under this (USD) with no position change (a dividend or interest) are
 *                              accepted by reconciliation and logged 'credit accepted' (default 5; 0 = always hold)
 */

import { AUTO_ACCEPT_CREDIT_USD } from './reconcile.ts';

export interface BrokerConfig {
  readonly botAccount: string;
  readonly limitBand: number;
  readonly sendAfterOpenMin: number;
  readonly windowMin: number;
  readonly approveMode: boolean;
  readonly maxQuoteAgeSec: number;
  readonly allowCalls: boolean;
  readonly controlSkewSec: number;
  /** Owner 2026-10-30: reconciliation accepts cash credits under this with no position change (reconcile.ts). */
  readonly autoAcceptCreditUsd: number;
}

export const BROKER_DEFAULTS: Omit<BrokerConfig, 'botAccount'> = {
  limitBand: 0.005, sendAfterOpenMin: 5, windowMin: 30, approveMode: true, maxQuoteAgeSec: 120, allowCalls: true, controlSkewSec: 300, autoAcceptCreditUsd: AUTO_ACCEPT_CREDIT_USD,
};

const num = (v: string | undefined, d: number, max = Infinity): number => { const n = Number(v); return v != null && v.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= max ? n : d; };
const flag = (v: string | undefined, d: boolean): boolean => (v == null || v.trim() === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));

export function brokerConfigFromEnv(env: Readonly<Record<string, string | undefined>>): BrokerConfig {
  const botAccount = (env.LIVE_IBKR_ACCOUNT ?? '').trim().toUpperCase();
  if (!botAccount) throw new Error('LIVE_IBKR_ACCOUNT is not set: the bot does not know its own account, so it trades nothing');
  return {
    botAccount,
    // A band above 5% would be close to a market order: refused, the default is kept.
    limitBand: num(env.LIVE_LIMIT_BAND, BROKER_DEFAULTS.limitBand, 0.05),
    sendAfterOpenMin: num(env.LIVE_SEND_AFTER_OPEN_MIN, BROKER_DEFAULTS.sendAfterOpenMin, 120),
    windowMin: num(env.LIVE_SEND_WINDOW_MIN, BROKER_DEFAULTS.windowMin, 300) || BROKER_DEFAULTS.windowMin,
    approveMode: flag(env.LIVE_APPROVE, BROKER_DEFAULTS.approveMode),
    maxQuoteAgeSec: num(env.LIVE_MAX_QUOTE_AGE_SEC, BROKER_DEFAULTS.maxQuoteAgeSec) || BROKER_DEFAULTS.maxQuoteAgeSec,
    allowCalls: flag(env.LIVE_ALLOW_CALLS, BROKER_DEFAULTS.allowCalls),
    controlSkewSec: num(env.LIVE_CONTROL_SKEW_SEC, BROKER_DEFAULTS.controlSkewSec, 3600) || BROKER_DEFAULTS.controlSkewSec,
    // Above $100 a "credit" is not a small dividend: refused, the default is kept.
    autoAcceptCreditUsd: num(env.LIVE_AUTO_ACCEPT_CREDIT_USD, BROKER_DEFAULTS.autoAcceptCreditUsd, 100),
  };
}

/** Limit price: last ± band, rounded to the cent (sub-dollar prices to 0.0001) toward the last price, so never more than the band away. */
export function limitPrice(last: number, side: 'BUY' | 'SELL', band: number): number {
  const raw = side === 'BUY' ? last * (1 + band) : last * (1 - band);
  const step = last < 1 ? 10_000 : 100;
  return side === 'BUY' ? Math.floor(raw * step + 1e-9) / step : Math.ceil(raw * step - 1e-9) / step;
}
