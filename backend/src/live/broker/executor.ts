/**
 * The morning executor (3.1, 3.2): turns the approved plan into limit orders on the bot's own account, safely.
 *
 * `morningTick` is one look at the world; `runMorning` calls it every `pollMs` until the window ends. A tick keeps no
 * memory of its own: it reads the bot state and the broker every time, so a restart, a retry or a reconnect simply
 * continues where things are. In order, a tick:
 *   1. halted (kill switch) → cancels every open order of the account and stops;
 *   2. no plan for today, or before open + LIVE_SEND_AFTER_OPEN_MIN → waits;
 *   3. the gate (approval.ts mayExecute): approved before the open with the same hash (approve mode), not held, not
 *      skipped; a failed gate skips every order of the plan (no answer = skip);
 *   4. the broker must be 'connected' and every read must succeed — otherwise NOTHING is sent (state unknown);
 *      the reads are for the bot's account only (guard.ts, R0) and it must be a cash account (no margin);
 *   5. before the first send of the day the ledger is reconciled with the broker (reconcile.ts): any mismatch holds
 *      the plan, skips it and alerts;
 *   6. after the window's end: every open order of the plan is cancelled (partial fills are kept), the rest skipped;
 *   7. SELLS first: never more than held (no short), at last × (1 - band); a missing or stale last price waits (R4);
 *   8. BUYS only when every sell is finished (filled, cancelled or rejected), and only with SETTLED cash minus what
 *      open buys already reserve; at last × (1 + band); smaller when the cash is short, skipped under LIVE_MIN_TRADE.
 * Idempotency (R5): an order is sent only if its fixed ref appears in none of the broker's open orders, today's
 * orders and today's fills, read again right before that send; one ref = at most one order a day. A send whose answer
 * is lost (disconnect) ends the tick: the next tick, after reconnecting, finds the order by its ref instead of
 * sending it again.
 * 💵 Live Log: every tick re-derives 'sent' / 'filled' / 'cancelled' / 'skipped' rows from the broker and the plan
 * and appends only the new ones (liveLog.ts appendLiveRows).
 */

import type { TabStore, TabCell } from '../../storage/tabStore.ts';
import type { LiveConfig } from '../liveConfig.ts';
import { orderFee } from '../liveConfig.ts';
import { isTradingDay, nyClock } from '../marketCalendar.ts';
import { roundShares, type PlannedOrder } from '../planner.ts';
import { orderRail } from '../rails.ts';
import { appendLiveRows, liveEventRow, type LiveEvent } from '../liveLog.ts';
import { OPEN_STATUSES, heldQty, readSnapshot, type AccountSnapshot, type Broker, type BrokerOrder, type InstrumentKind } from './broker.ts';
import { guardBroker, longOnlyRefusal, AccountRefusedError } from './guard.ts';
import { limitPrice, type BrokerConfig } from './brokerConfig.ts';
import { mayExecute, openOf } from './approval.ts';
import { updateState, type BotState, type BotStateStore, type PendingPlan } from './botState.ts';
import { acceptCredit, applyFills, reconcile, type AcceptedCredit } from './reconcile.ts';
import { cancelAllOpen } from './killSwitch.ts';

export interface ExecutorDeps {
  /** The broker as built; the executor wraps it in the R0 guard itself, with cfg.botAccount. */
  readonly broker: Broker;
  readonly cfg: BrokerConfig;
  readonly live: Pick<LiveConfig, 'fractional' | 'minTrade' | 'fees' | 'capSlack'>;
  readonly state: BotStateStore;
  /** Where 💵 Live Log lives. */
  readonly store: TabStore;
  readonly now: () => number;
  /** Telegram (through the relay); failures are ignored. */
  readonly alert?: (text: string) => Promise<void> | void;
  readonly allow?: ReadonlySet<string>;
}

export type TickPhase = 'idle' | 'halted' | 'waiting' | 'unknown' | 'skipped' | 'selling' | 'buying' | 'done';
export interface TickResult {
  readonly phase: TickPhase;
  /** Order refs sent in this tick. */
  readonly sent: string[];
  /** Order refs cancelled in this tick. */
  readonly cancelled: string[];
  readonly notes: string[];
}

const mult = (k: InstrumentKind): number => (k === 'share' ? 1 : 100);
const errText = (e: unknown): string => String((e as Error)?.message ?? e);
const FINAL = new Set(['filled', 'cancelled', 'rejected']);

/** Rows of 💵 Live Log that the broker's view and the plan's skips imply (appendLiveRows keeps only new ones). */
export function executionRows(p: PendingPlan, orders: readonly BrokerOrder[], fills: AccountSnapshot['todaysFills']): TabCell[][] {
  const refs = new Map(p.plan.orders.map((o) => [o.ref, o]));
  const ev: LiveEvent[] = [];
  const base = { day: p.plan.day, account: p.plan.account };
  for (const o of orders) {
    if (!refs.has(o.orderRef)) continue;
    ev.push({ ...base, when: 'sent', ticker: o.ticker, side: o.side, qty: o.qty, limit: o.limit, why: 'limit DAY order ' + o.orderId + ' (' + refs.get(o.orderRef)!.why + ')', ref: o.orderRef });
    if (o.status === 'rejected') ev.push({ ...base, when: 'skipped', ticker: o.ticker, side: o.side, qty: o.qty, limit: o.limit, why: 'rejected by the broker: ' + (o.reason ?? 'no reason given'), ref: o.orderRef });
    if (o.status === 'cancelled') ev.push({ ...base, when: 'cancelled', ticker: o.ticker, side: o.side, qty: Math.round((o.qty - o.filledQty) * 10_000) / 10_000, limit: o.limit, why: 'unfilled part cancelled (' + o.filledQty + ' of ' + o.qty + ' filled, kept)', ref: o.orderRef });
  }
  for (const f of fills) {
    if (!refs.has(f.orderRef)) continue;
    ev.push({ ...base, when: 'filled', ticker: f.ticker, side: f.side, qty: f.qty, fill: f.price, fee: f.fee, why: 'execution ' + f.execId, ref: f.orderRef });
  }
  for (const [ref, why] of Object.entries(p.skipped)) {
    const o = refs.get(ref);
    if (o && !orders.some((x) => x.orderRef === ref)) ev.push({ ...base, when: 'skipped', ticker: o.ticker, side: o.side, qty: o.qty, limit: null, why, ref });
  }
  return ev.map(liveEventRow);
}

export async function morningTick(d: ExecutorDeps): Promise<TickResult> {
  const now = d.now(), acct = d.cfg.botAccount, b = guardBroker(d.broker, acct);
  const res: TickResult = { phase: 'idle', sent: [], cancelled: [], notes: [] };
  const out = (phase: TickPhase, note?: string): TickResult => ({ ...res, phase, notes: note ? [...res.notes, note] : res.notes });
  const say = async (t: string): Promise<void> => { try { await d.alert?.(t); } catch { /* an alert never stops the executor */ } };
  const s = await d.state.load();
  const today = nyClock(now).day;
  const p = s.pending;
  const refSet = new Set(p?.plan.orders.map((o) => o.ref) ?? []);

  // 1. kill switch
  if (s.halted) {
    if (b.connectionState() === 'connected') {
      const r = await cancelAllOpen(b, acct);
      res.cancelled.push(...r.cancelled.map((c) => c.orderRef));
      if (p && p.execDay === today) await logFromBroker(d, b, p).catch(() => undefined);
    }
    return out('halted', 'halted: ' + (s.haltedWhy ?? ''));
  }

  // 2. a plan for today?
  if (!p || p.execDay !== today || !isTradingDay(today)) {
    if (p && p.execDay < today && ['awaiting-approval', 'approved', 'ready'].includes(p.status)) await updateState(d.state, (x) => { if (x.pending && x.pending.hash === p.hash) { x.pending.status = 'skipped'; x.pending.notes.push('its day ' + p.execDay + ' passed'); } });
    return out('idle', p ? 'the waiting plan runs on ' + p.execDay : 'no plan');
  }
  if (p.status === 'done') return out('done');
  const start = openOf(today) + d.cfg.sendAfterOpenMin * 60_000, end = start + d.cfg.windowMin * 60_000;
  if (now < start) return out('waiting', 'sends start at ' + new Date(start).toISOString());

  // 3. the gate
  const gate = mayExecute(s, d.cfg.approveMode, now);
  if (!gate.ok) return finish(d, b, p, 'not sent: ' + gate.why, 'skipped', res);

  // 4. a known broker state, the bot's account only, a cash account
  if (b.connectionState() !== 'connected') return out('unknown', 'broker ' + b.connectionState() + ': nothing is sent until it is connected and read again');
  let snap: AccountSnapshot;
  try { await b.accounts(); snap = await readSnapshot(b, acct); } catch (e) {
    if (e instanceof AccountRefusedError) { await say('🛑 Live bot: ' + e.message); return finish(d, b, p, 'not sent: ' + e.message, 'skipped', res); }
    return out('unknown', 'broker read failed (' + errText(e) + '): nothing is sent');
  }
  if (snap.accountType !== 'cash') {
    const why = 'not sent: the account ' + acct + ' is a ' + snap.accountType + ' account (the bot trades only a cash account, no margin)';
    await say('🛑 Live bot: ' + why);
    return finish(d, b, p, why, 'skipped', res);
  }
  const botFills = snap.todaysFills.filter((f) => refSet.has(f.orderRef));
  await updateState(d.state, (x) => { if (x.ledger) applyFills(x.ledger, botFills, x.appliedFills); });

  // 5. reconcile before the first send
  const anySent = snap.todaysOrders.some((o) => refSet.has(o.orderRef));
  if (!anySent && !p.sendStarted) {
    const rec = await updateState(d.state, (x) => { const r = reconcile(x.ledger, snap.positions, snap.cash, { autoAcceptCreditUsd: d.cfg.autoAcceptCreditUsd }); acceptCredit(x.ledger, r); return r; });
    if (rec.ok && rec.credit) await writeRows(d, [creditRow(p, rec.credit)]);
    if (!rec.ok) {
      await updateState(d.state, (x) => { if (x.pending?.hash === p.hash) { x.pending.status = 'held'; x.pending.held = rec.mismatches.map((m) => m.detail); } });
      await say(rec.alert!);
      return finish(d, b, { ...p, status: 'held' }, 'held: the account does not match the bot\'s record (reconciliation)', 'skipped', res);
    }
  }
  await writeRows(d, executionRows(p, snap.todaysOrders, snap.todaysFills));

  // 6. the window's end
  if (now >= end) return finish(d, b, p, 'not sent: the send window ended', 'done', res);

  const used = (ref: string, v: Pick<AccountSnapshot, 'openOrders' | 'todaysOrders' | 'todaysFills'>): boolean =>
    v.openOrders.some((o) => o.orderRef === ref) || v.todaysOrders.some((o) => o.orderRef === ref) || v.todaysFills.some((f) => f.orderRef === ref);
  const skip = async (ref: string, why: string): Promise<void> => {
    p.skipped[ref] = why;
    await updateState(d.state, (x) => { if (x.pending?.hash === p.hash) x.pending.skipped[ref] = x.pending.skipped[ref] ?? why; });
    await writeRows(d, executionRows({ ...p, skipped: { [ref]: why } }, [], []));
  };
  const fresh = async (t: string, k: InstrumentKind): Promise<number | null> => {
    const q = await b.quote(t, k).catch(() => null);
    if (!q || !(q.last > 0)) { res.notes.push(t + ': no last price yet (waits)'); return null; }
    if (nyClock(q.at).day !== today || now - q.at > d.cfg.maxQuoteAgeSec * 1000) { res.notes.push(t + ': last price is stale (waits, R4)'); return null; }
    return q.last;
  };
  const held = new Map<string, number>(), heldCalls = new Map<string, number>();
  for (const x of snap.positions) (x.kind === 'call' ? heldCalls : x.kind === 'share' ? held : new Map()).set(x.ticker, x.qty);
  const railFor = (o: PlannedOrder): string | null => orderRail(o, { orders: [], held, heldCalls, slots: p.plan.slots, accountValue: p.plan.accountValue, settledCash: snap.settledCash, maxOrders: Infinity, capSlack: d.live.capSlack, halted: false, decisionDay: p.plan.day, lastTradingDay: p.plan.day, priceDays: new Map(), ...(d.allow ? { allow: d.allow } : {}) });

  /** One send, with the fresh R5 look right before it. 'stop' ends the tick (unknown state or the gate closed). */
  const send = async (o: PlannedOrder, qty: number, limit: number): Promise<'sent' | 'exists' | 'stop'> => {
    const s2 = await d.state.load();
    const g2 = mayExecute(s2, d.cfg.approveMode, d.now());
    if (!g2.ok || s2.pending?.hash !== p.hash) { res.notes.push('stopped before ' + o.ref + ': ' + (g2.ok ? 'the plan changed' : g2.why)); return 'stop'; }
    if (b.connectionState() !== 'connected') { res.notes.push('broker ' + b.connectionState() + ' before ' + o.ref + ': not sent'); return 'stop'; }
    let v: Pick<AccountSnapshot, 'openOrders' | 'todaysOrders' | 'todaysFills'>;
    try { const [openOrders, todaysOrders, todaysFills] = await Promise.all([b.openOrders(acct), b.todaysOrders(acct), b.todaysFills(acct)]); v = { openOrders, todaysOrders, todaysFills }; } catch (e) { res.notes.push('broker read failed before ' + o.ref + ' (' + errText(e) + '): not sent'); return 'stop'; }
    if (used(o.ref, v)) return 'exists';
    await updateState(d.state, (x) => { if (x.pending?.hash === p.hash) x.pending.sendStarted = true; });
    p.sendStarted = true;
    try {
      const placed = await b.placeLimitOrder({ account: acct, orderRef: o.ref, ticker: o.ticker, kind: o.kind, side: o.side, qty, limit, tif: 'DAY' });
      res.sent.push(o.ref);
      await writeRows(d, executionRows(p, [placed], []));
      return 'sent';
    } catch (e) {
      res.notes.push('sending ' + o.ref + ' failed (' + errText(e) + '): the broker may have it; the next tick looks for it by its ref');
      return 'stop';
    }
  };

  // 7. sells
  const sells = p.plan.orders.filter((o) => o.side === 'SELL'), buys = p.plan.orders.filter((o) => o.side === 'BUY');
  for (const o of sells) {
    if (used(o.ref, snap) || p.skipped[o.ref]) continue;
    const have = heldQty(snap, o.ticker, o.kind);
    const qty = o.fullExit ? have : Math.min(o.qty, have);
    if (!(qty > 1e-9)) { await skip(o.ref, 'nothing held to sell'); continue; }
    const last = await fresh(o.ticker, o.kind);
    if (last == null) continue;
    const limit = limitPrice(last, 'SELL', d.cfg.limitBand);
    const why = longOnlyRefusal({ side: 'SELL', kind: o.kind, ticker: o.ticker, qty, limit, held: have, accountType: snap.accountType, allowCalls: d.cfg.allowCalls }) ?? railFor({ ...o, qty, price: limit, value: qty * limit * mult(o.kind) });
    if (why) { await skip(o.ref, 'refused: ' + why); continue; }
    const r = await send(o, qty, limit);
    if (r === 'stop') return out('unknown');
  }
  // every sell finished? (re-read: the sends above may have filled at once)
  let after: Pick<AccountSnapshot, 'todaysOrders' | 'openOrders' | 'settledCash' | 'positions'>;
  try { const [todaysOrders, openOrders, settledCash, positions] = await Promise.all([b.todaysOrders(acct), b.openOrders(acct), b.settledCash(acct), b.positions(acct)]); after = { todaysOrders, openOrders, settledCash, positions }; } catch (e) { return out('unknown', 'broker read failed (' + errText(e) + ')'); }
  const sellDone = (o: PlannedOrder): boolean => !!p.skipped[o.ref] || after.todaysOrders.some((x) => x.orderRef === o.ref && FINAL.has(x.status));
  if (!sells.every(sellDone)) return out('selling', 'buys wait until every sell is finished');

  // 8. buys, settled cash only
  let budget = after.settledCash;
  for (const x of after.openOrders) if (x.side === 'BUY') { const left = x.qty - x.filledQty, m = mult(x.kind); budget -= left * x.limit * m + orderFee(left, x.limit * m, d.live.fees); }
  for (const o of buys) {
    if (used(o.ref, { ...snap, todaysOrders: after.todaysOrders, openOrders: after.openOrders }) || p.skipped[o.ref]) continue;
    const last = await fresh(o.ticker, o.kind);
    if (last == null) continue;
    const limit = limitPrice(last, 'BUY', d.cfg.limitBand), m = mult(o.kind);
    let qty = Math.min(o.qty, o.kind === 'share' ? roundShares(Math.max(0, budget) / limit, d.live.fractional) : Math.floor(Math.max(0, budget) / (limit * m)));
    for (let i = 0; i < 4 && qty > 0 && qty * limit * m + orderFee(qty, limit * m, d.live.fees) > budget + 1e-9; i++) {
      const room = budget - orderFee(qty, limit * m, d.live.fees);
      qty = o.kind === 'share' ? roundShares(room / limit, d.live.fractional) : Math.floor(room / (limit * m));
    }
    if (!(qty > 0) || qty * limit * m < d.live.minTrade) { await skip(o.ref, 'not enough settled cash ($' + Math.max(0, budget).toFixed(2) + ' left; sale money settles T+1, the buy comes back in the next plan)'); continue; }
    const why = longOnlyRefusal({ side: 'BUY', kind: o.kind, ticker: o.ticker, qty, limit, held: heldQty(after, o.ticker, o.kind), accountType: snap.accountType, allowCalls: d.cfg.allowCalls }) ?? railFor({ ...o, qty, price: limit, value: qty * limit * m });
    if (why) { await skip(o.ref, 'refused: ' + why); continue; }
    const r = await send(o, qty, limit);
    if (r === 'stop') return out('unknown');
    if (r === 'sent') budget -= qty * limit * m + orderFee(qty, limit * m, d.live.fees);
  }
  return out('buying');
}

/**
 * Ends the plan for today: cancels its open orders (partial fills kept), marks every order never sent as skipped
 * with `why`, logs it all and saves the status. Without a connection, and once something may have been sent, it
 * waits for the next tick (it must know what the broker holds before it can say what was skipped).
 */
async function finish(d: ExecutorDeps, b: Broker, p: PendingPlan, why: string, status: 'skipped' | 'done', res: TickResult): Promise<TickResult> {
  const acct = d.cfg.botAccount, refs = new Set(p.plan.orders.map((o) => o.ref));
  let orders: readonly BrokerOrder[] = [], fills: AccountSnapshot['todaysFills'] = [];
  if (p.sendStarted || b.connectionState() === 'connected') {
    try {
      for (const o of await b.openOrders(acct)) if (refs.has(o.orderRef) && OPEN_STATUSES.has(o.status)) { await b.cancelOrder(acct, o.orderId); res.cancelled.push(o.orderRef); }
      [orders, fills] = await Promise.all([b.todaysOrders(acct), b.todaysFills(acct)]);
    } catch (e) {
      if (p.sendStarted) return { ...res, phase: 'unknown', notes: [...res.notes, 'could not finish (' + errText(e) + '): tries again'] };
    }
  }
  const sentRefs = new Set(orders.filter((o) => refs.has(o.orderRef)).map((o) => o.orderRef));
  const skipped = { ...p.skipped };
  for (const o of p.plan.orders) if (!sentRefs.has(o.ref) && !skipped[o.ref]) skipped[o.ref] = why;
  let summary = '';
  await updateState(d.state, (x: BotState) => {
    if (x.pending?.hash !== p.hash) return;
    const first = !x.pending.summarySent;
    x.pending.summarySent = true;
    x.pending.status = x.pending.status === 'held' ? 'held' : status;
    x.pending.skipped = { ...skipped, ...x.pending.skipped };
    if (x.ledger) applyFills(x.ledger, fills.filter((f) => refs.has(f.orderRef)), x.appliedFills);
    if (first) summary = summaryLine(p, orders.filter((o) => refs.has(o.orderRef)), fills.filter((f) => refs.has(f.orderRef)), skipped);
  });
  await writeRows(d, executionRows({ ...p, skipped }, orders, fills));
  if (summary) { try { await d.alert?.(summary); } catch { /* ignored */ } }
  return { ...res, phase: status, notes: [...res.notes, why] };
}

function summaryLine(p: PendingPlan, orders: readonly BrokerOrder[], fills: AccountSnapshot['todaysFills'], skipped: Record<string, string>): string {
  const filled = fills.map((f) => f.side + ' ' + (Math.round(f.qty * 10_000) / 10_000) + ' ' + f.ticker + ' @ ' + f.price.toFixed(2)).join(', ');
  const cancelled = orders.filter((o) => o.status === 'cancelled').map((o) => o.ticker + ' (' + o.filledQty + '/' + o.qty + ' filled)').join(', ');
  const sk = Object.entries(skipped).map(([ref, w]) => (p.plan.orders.find((o) => o.ref === ref)?.ticker ?? ref) + ': ' + w);
  return ['💵 Live bot — plan of ' + p.plan.day + ' on ' + p.execDay + ': ' + orders.length + ' sent, ' + fills.length + ' fill(s)' + (filled ? ' (' + filled + ')' : ''),
    ...(cancelled ? ['Cancelled at the window\'s end (partial fills kept): ' + cancelled] : []), ...(sk.length ? ['Skipped: ' + sk.join('; ')] : [])].join('\n');
}

async function logFromBroker(d: ExecutorDeps, b: Broker, p: PendingPlan): Promise<void> {
  const [orders, fills] = await Promise.all([b.todaysOrders(d.cfg.botAccount), b.todaysFills(d.cfg.botAccount)]);
  await writeRows(d, executionRows(p, orders, fills));
}

/** 💵 Live Log: a small credit accepted by reconciliation (owner 2026-10-30), under the plan's day. */
export function creditRow(p: Pick<PendingPlan, 'plan'>, c: AcceptedCredit): TabCell[] {
  return liveEventRow({ day: p.plan.day, account: p.plan.account, when: 'credit accepted', qty: null, fill: c.amount, why: c.detail });
}

async function writeRows(d: ExecutorDeps, rows: TabCell[][]): Promise<void> {
  // The log never stops the trading: a Sheets failure is retried by the next tick (rows are re-derived).
  try { await appendLiveRows(d.store, rows); } catch { /* next tick */ }
}

/** Runs ticks every `pollMs` until the plan is finished or the window has ended. */
export async function runMorning(d: ExecutorDeps, opts: { readonly pollMs?: number; readonly sleep?: (ms: number) => Promise<void>; readonly maxTicks?: number; /** ms: stop looping after this moment whatever the phase (e.g. the close). */ readonly until?: number } = {}): Promise<TickResult[]> {
  const pollMs = opts.pollMs ?? 20_000, sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const all: TickResult[] = [];
  for (let i = 0; i < (opts.maxTicks ?? 10_000); i++) {
    const r = await morningTick(d).catch((e): TickResult => ({ phase: 'unknown', sent: [], cancelled: [], notes: ['tick failed: ' + errText(e)] }));
    all.push(r);
    if (r.phase === 'done' || r.phase === 'skipped' || r.phase === 'halted' || r.phase === 'idle') break;
    if (opts.until != null && d.now() > opts.until) break;
    await sleep(pollMs);
  }
  return all;
}
