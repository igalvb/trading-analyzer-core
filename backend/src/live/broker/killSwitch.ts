/**
 * The kill switch (3.4, R6). `/stopbot` → `halt`: sets `halted` FIRST (so no new order can start, even if the
 * cancels fail), then cancels every open order of the bot's account and says what happened. `/startbot` → `resume`.
 * The bot cannot help when the relay or the server is down, so every alert carries IBKR_APP_STOP.
 */

import type { Broker } from './broker.ts';
import { updateState, type BotStateStore } from './botState.ts';

export const IBKR_APP_STOP = 'If the bot or the relay is down: IBKR app → Trade → Orders → Cancel All (the bot\'s account) stops everything.';

export interface HaltResult {
  readonly cancelled: readonly { readonly orderId: string; readonly orderRef: string; readonly ticker: string; readonly side: string; readonly qty: number; readonly filledQty: number }[];
  readonly failed: readonly string[];
  readonly message: string;
}

/** Cancels every open order of the (guarded) account. Never throws: a failure is reported in `failed`. */
export async function cancelAllOpen(broker: Broker, account: string): Promise<Omit<HaltResult, 'message'>> {
  const cancelled: Array<HaltResult['cancelled'][number]> = [], failed: string[] = [];
  let open;
  try { open = await broker.openOrders(account); } catch (e) { return { cancelled, failed: ['could not read the open orders: ' + String((e as Error)?.message ?? e)] }; }
  for (const o of open) {
    try { await broker.cancelOrder(account, o.orderId); cancelled.push({ orderId: o.orderId, orderRef: o.orderRef, ticker: o.ticker, side: o.side, qty: o.qty, filledQty: o.filledQty }); } catch (e) { failed.push(o.orderRef + ': ' + String((e as Error)?.message ?? e)); }
  }
  return { cancelled, failed };
}

export async function halt(store: BotStateStore, broker: Broker, account: string, why: string): Promise<HaltResult> {
  await updateState(store, (s) => {
    s.halted = true; s.haltedWhy = why;
    // The waiting plan dies with the halt: /startbot does not bring it back mid-morning.
    if (s.pending && s.pending.status !== 'done') { s.pending.status = 'skipped'; s.pending.notes.push('halted: ' + why); }
  });
  const r = await cancelAllOpen(broker, account);
  const message = ['🛑 Live bot halted (' + why + '). ' + (r.cancelled.length ? 'Cancelled ' + r.cancelled.length + ' open order(s): ' + r.cancelled.map((c) => c.side + ' ' + c.ticker).join(', ') + '.' : 'No open order to cancel.'),
    ...(r.failed.length ? ['⚠️ Could not cancel: ' + r.failed.join('; ') + '. ' + IBKR_APP_STOP] : []), 'Nothing is sent until /startbot.'].join('\n');
  return { ...r, message };
}

export async function resume(store: BotStateStore): Promise<string> {
  await updateState(store, (s) => { s.halted = false; s.haltedWhy = null; });
  return '▶️ Live bot running again. A plan made while it was halted is not sent; the next nightly plan is.';
}
