/**
 * Approve mode (3.3, D2). The evening plan gets a hash of exactly what it would send; Telegram's ✅ button carries
 * that hash. An approval counts only if:
 *   - it names the plan waiting now (same decision day: an old plan is refused) and the same hash (a changed plan is
 *     refused);
 *   - it arrives before the open of the day the plan runs (it expires at the open);
 *   - the bot is not halted and the plan is not held by reconciliation.
 * No answer by the open = skip. ❌ Skip is the same as no answer, said out loud.
 */

import { createHash } from 'node:crypto';
import type { Plan } from '../planner.ts';
import { nyMoment, OPEN_MINUTES } from '../marketCalendar.ts';
import type { BotState } from './botState.ts';

/** The hash of what a plan would send: day, account followed and every order (ref, ticker, side, kind, quantity, price). */
export function planHash(plan: Plan): string {
  const canon = {
    day: plan.day, account: plan.account,
    orders: plan.orders.map((o) => [o.ref, o.ticker, o.side, o.kind, Math.round(o.qty * 10_000) / 10_000, Math.round(o.price * 10_000) / 10_000]),
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/** The short form shown on the Telegram button (Telegram callback data is at most 64 bytes). */
export const shortHash = (h: string): string => h.slice(0, 16);

export const openOf = (day: string): number => nyMoment(day, OPEN_MINUTES);

export type Decision = 'approve' | 'skip';
export type ApprovalResult = { readonly ok: true; readonly status: 'approved' | 'skipped'; readonly message: string } | { readonly ok: false; readonly why: string };

/** Applies the owner's answer to the waiting plan (mutates `s` only when accepted). */
export function decide(s: BotState, ask: { readonly day: string; readonly hash: string; readonly decision: Decision; readonly by: string }, now: number): ApprovalResult {
  const p = s.pending;
  if (!p) return { ok: false, why: 'no plan is waiting' };
  if (ask.day !== p.plan.day) return { ok: false, why: 'that is the plan of ' + ask.day + '; the plan waiting is ' + p.plan.day + ' (an old plan cannot be approved)' };
  const h = String(ask.hash || '');
  if (h.length < 16 || !p.hash.startsWith(h)) return { ok: false, why: 'the plan changed since that button was made (hash ' + shortHash(h) + ' ≠ ' + shortHash(p.hash) + '); approve the new one' };
  if (now >= openOf(p.execDay)) return { ok: false, why: 'the approval expired at the open of ' + p.execDay + ' (9:30 New York); the plan is skipped' };
  if (ask.decision === 'skip') {
    p.status = 'skipped'; p.approval = null;
    return { ok: true, status: 'skipped', message: '❌ Plan of ' + p.plan.day + ' skipped: nothing is sent on ' + p.execDay + '.' };
  }
  if (s.halted) return { ok: false, why: 'the bot is halted; /startbot first' };
  if (p.status === 'held') return { ok: false, why: 'the plan is held until the owner confirms the account (' + p.held.join('; ') + ')' };
  if (p.status !== 'awaiting-approval' && p.status !== 'approved') return { ok: false, why: 'the plan is ' + p.status };
  p.status = 'approved';
  p.approval = { at: now, hash: p.hash, by: ask.by };
  return { ok: true, status: 'approved', message: '✅ Plan of ' + p.plan.day + ' approved (' + shortHash(p.hash) + '): it is sent on ' + p.execDay + ' after the open.' };
}

/** Whether the waiting plan may be sent at `now` (re-checked by the executor at every send). */
export function mayExecute(s: BotState, approveMode: boolean, now: number): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  const p = s.pending;
  if (!p) return { ok: false, why: 'no plan' };
  if (s.halted) return { ok: false, why: 'halted (kill switch)' };
  if (p.status === 'held') return { ok: false, why: 'held: ' + p.held.join('; ') };
  if (p.status === 'skipped') return { ok: false, why: 'skipped' };
  if (planHash(p.plan) !== p.hash) return { ok: false, why: 'the stored plan does not match its hash' };
  if (now < openOf(p.execDay)) return { ok: false, why: 'the market is not open yet' };
  if (!approveMode) return p.status === 'ready' || p.status === 'approved' || p.status === 'awaiting-approval' ? { ok: true } : { ok: false, why: p.status };
  const a = p.approval;
  if (p.status !== 'approved' || !a) return { ok: false, why: 'no approval before the open (no answer = skip)' };
  if (a.hash !== p.hash) return { ok: false, why: 'the approval was for another version of the plan' };
  if (a.at >= openOf(p.execDay)) return { ok: false, why: 'the approval came after the open' };
  return { ok: true };
}
