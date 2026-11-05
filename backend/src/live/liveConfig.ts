/**
 * The live broker bot's settings (docs/live-broker/MASTER_PLAN.md, phase 1: planner and dry run, NO broker).
 * Every number the owner may want to change lives here, read from the environment with a plain default:
 *
 *   LIVE_FOLLOW_ACCOUNT   the paper account to follow (e.g. 'lab.turtle'); 'auto' (default) = the best one of the fee
 *                         report among those that beat Hold QQQ and Hold the research list after fees and tax; 'none' = nobody
 *   LIVE_START_VALUE      the real account's money at the start (default $1,000)
 *   LIVE_FRACTIONAL       '1' (default) = fractional shares (to confirm in phase 0, F2-F4); '0' = whole shares, rounded down
 *   LIVE_MIN_TRADE        the fee filter: a trade under this many dollars is skipped (default $50)
 *   LIVE_MAX_ORDERS       at most this many orders a day (default 10)
 *   LIVE_TARGET_MODE      'mirror' (default) = held stocks at the twin's own weight tonight, new buys at 1/slots (what
 *                         the paper account does); 'equal' = every stock at 1/slots (rebalances every night)
 *   LIVE_HALTED           '1' = the kill switch: no plan at all
 *   LIVE_ACCOUNT_FILE     a JSON file with the real account (account.ts); without it the dry run's own record (the
 *                         💵 Live Log's planned orders, as if filled at the evening price) is the account
 *   LIVE_FEE_MIN / LIVE_FEE_PER_SHARE / LIVE_FEE_MAX_PCT   the IBKR Pro estimate ($1 / $0.005 / 1%)
 *
 * GENERIC_PLAN P2: the plain defaults are the profile's `live.*` (the owner's: the values above); a profile with no
 * live settings (no live bot) gets the same engine defaults. The environment still wins over both.
 */

import { activeProfile } from '../profile/active.ts';

export interface FeeSchedule {
  /** Dollars, the least an order costs. */
  readonly perOrderMin: number;
  /** Dollars per share. */
  readonly perShare: number;
  /** The most an order costs, as a share of its value (0.01 = 1%); it wins over the minimum. */
  readonly maxPctOfValue: number;
}

/** IBKR Pro, fixed pricing (to confirm in phase 0): $0.005 a share, at least $1, at most 1% of the order. */
export const IBKR_PRO_FIXED: FeeSchedule = { perOrderMin: 1, perShare: 0.005, maxPctOfValue: 0.01 };

export type TargetMode = 'mirror' | 'equal';

export interface LiveConfig {
  readonly follow: string;
  readonly startValue: number;
  readonly fractional: boolean;
  readonly minTrade: number;
  readonly maxOrders: number;
  /** The per-order cap above the slot size: 0.10 = a 3-stock account may buy at most 1/3 + 10% of the account at once. */
  readonly capSlack: number;
  readonly halted: boolean;
  readonly targetMode: TargetMode;
  readonly fees: FeeSchedule;
  /** Falls from the start that send an alert (D5: no automatic stop). */
  readonly alertFalls: readonly number[];
  readonly accountFile: string | null;
}

const PROFILE_LIVE = activeProfile().live;
export const LIVE_DEFAULTS: LiveConfig = {
  follow: PROFILE_LIVE?.follow ?? 'auto', startValue: PROFILE_LIVE?.startValue ?? 1_000, fractional: PROFILE_LIVE?.fractional ?? true,
  minTrade: PROFILE_LIVE?.minTrade ?? 50, maxOrders: PROFILE_LIVE?.maxOrders ?? 10, capSlack: PROFILE_LIVE?.capSlack ?? 0.10, halted: false,
  targetMode: PROFILE_LIVE?.targetMode ?? 'mirror', fees: IBKR_PRO_FIXED, alertFalls: PROFILE_LIVE?.alertFalls ?? [0.20, 0.35], accountFile: null,
};

const num = (v: string | undefined, d: number): number => { const n = Number(v); return v != null && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : d; };
const flag = (v: string | undefined, d: boolean): boolean => (v == null || v.trim() === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));

export function liveConfigFromEnv(env: Readonly<Record<string, string | undefined>>): LiveConfig {
  const mode = (env.LIVE_TARGET_MODE ?? '').trim().toLowerCase();
  return {
    follow: (env.LIVE_FOLLOW_ACCOUNT ?? '').trim() || LIVE_DEFAULTS.follow,
    startValue: num(env.LIVE_START_VALUE, LIVE_DEFAULTS.startValue) || LIVE_DEFAULTS.startValue,
    fractional: flag(env.LIVE_FRACTIONAL, LIVE_DEFAULTS.fractional),
    minTrade: num(env.LIVE_MIN_TRADE, LIVE_DEFAULTS.minTrade),
    maxOrders: num(env.LIVE_MAX_ORDERS, LIVE_DEFAULTS.maxOrders),
    capSlack: LIVE_DEFAULTS.capSlack,
    halted: flag(env.LIVE_HALTED, false),
    targetMode: mode === 'equal' ? 'equal' : 'mirror',
    fees: { perOrderMin: num(env.LIVE_FEE_MIN, IBKR_PRO_FIXED.perOrderMin), perShare: num(env.LIVE_FEE_PER_SHARE, IBKR_PRO_FIXED.perShare), maxPctOfValue: num(env.LIVE_FEE_MAX_PCT, IBKR_PRO_FIXED.maxPctOfValue) },
    alertFalls: LIVE_DEFAULTS.alertFalls,
    accountFile: (env.LIVE_ACCOUNT_FILE ?? '').trim() || null,
  };
}

/** The estimated IBKR fee of one order: per share, at least the minimum, at most the share of its value. */
export function orderFee(shares: number, price: number, f: FeeSchedule = IBKR_PRO_FIXED): number {
  if (!(shares > 0) || !(price > 0)) return 0;
  const raw = Math.max(f.perOrderMin, f.perShare * shares), cap = f.maxPctOfValue * shares * price;
  return Math.round(Math.min(raw, cap) * 100) / 100;
}
