/**
 * The bot server's small control endpoint (phases 2.3, 3.3, 3.4), as a plain request → response function so it can
 * be tested without a network; `nodeListener` adapts it to node:http for the server (phase 2 starts it; this module
 * never listens on anything by itself).
 *
 *   GET  /status    halted?, broker connection, the bot account's cash / positions / open orders, the waiting plan
 *   POST /plan      { plan }  the Nightly's plan: checked (fresh, long-only against the real holdings, R0), the account
 *                   reconciled (a mismatch holds it), stored as the one waiting plan; answers its hash and the
 *                   Telegram buttons' data
 *   POST /approve   { day, hash, decision: 'approve' | 'skip', by }  the owner's ✅ / ❌ (approval.ts rules)
 *   POST /halt      { halted: true | false, why }  /stopbot (cancels every open order) and /startbot
 *   POST /confirm   {}  after a reconciliation alert: the owner checked the account; the broker's view becomes the
 *                   ledger and a held plan waits for approval again
 *
 * Every call is signed (HMAC-SHA256 with the shared secret LIVE_CONTROL_SECRET, only on the server and in the relay):
 *   x-lb-ts     unix seconds; refused when more than LIVE_CONTROL_SKEW_SEC (300) away from the server's clock
 *   x-lb-nonce  16-64 letters, digits, '-' or '_'; refused when seen before (replay), remembered until it is too old
 *   x-lb-sig    hex HMAC of `ts.nonce.METHOD.path.sha256hex(body)`
 * A refused call changes nothing and says only why in general terms (401).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TabStore } from '../../storage/tabStore.ts';
import { orderRef, type Plan, type PlannedOrder } from '../planner.ts';
import { lastClosedTradingDay, nextTradingDay } from '../marketCalendar.ts';
import { appendLiveRows, liveEventRow } from '../liveLog.ts';
import { heldQty, readSnapshot, type Broker } from './broker.ts';
import { guardBroker, longOnlyRefusal } from './guard.ts';
import type { BrokerConfig } from './brokerConfig.ts';
import { decide, planHash, shortHash, type Decision } from './approval.ts';
import { updateState, type BotStateStore, type PendingPlan } from './botState.ts';
import { acceptCredit, applyFills, ledgerFromBroker, reconcile, type AcceptedCredit } from './reconcile.ts';
import { creditRow } from './executor.ts';
import { halt, resume, IBKR_APP_STOP } from './killSwitch.ts';

export interface ControlRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}
export interface ControlResponse { readonly status: number; readonly body: Record<string, unknown> }

export interface ControlDeps {
  /** LIVE_CONTROL_SECRET: at least 32 characters. */
  readonly secret: string;
  readonly broker: Broker;
  readonly cfg: BrokerConfig;
  readonly state: BotStateStore;
  readonly store: TabStore;
  readonly now: () => number;
  readonly alert?: (text: string) => Promise<void> | void;
}

export const MIN_SECRET_LENGTH = 32;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const sigOf = (secret: string, ts: string, nonce: string, method: string, path: string, body: string): string =>
  createHmac('sha256', secret).update(ts + '.' + nonce + '.' + method.toUpperCase() + '.' + path + '.' + sha256(body)).digest('hex');

/** The headers a caller (the relay, the Nightly) sends with a call. */
export function signRequest(secret: string, method: string, path: string, body: string, nowMs: number, nonce: string = randomBytes(16).toString('hex')): Record<string, string> {
  const ts = String(Math.floor(nowMs / 1000));
  return { 'x-lb-ts': ts, 'x-lb-nonce': nonce, 'x-lb-sig': sigOf(secret, ts, nonce, method, path, body) };
}

export type SignatureCheck = { readonly ok: true; readonly nonce: string; readonly ts: number } | { readonly ok: false; readonly why: string };

/** Signature and clock only (the nonce's replay check needs the state: `createControlHandler` does it). */
export function checkSignature(req: ControlRequest, secret: string, nowMs: number, skewSec: number): SignatureCheck {
  const h = (k: string): string => String(req.headers[k] ?? req.headers[k.toLowerCase()] ?? '');
  const ts = h('x-lb-ts'), nonce = h('x-lb-nonce'), sig = h('x-lb-sig');
  if (!/^\d{9,11}$/.test(ts) || !NONCE_RE.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, why: 'unsigned or malformed call' };
  if (Math.abs(nowMs / 1000 - Number(ts)) > skewSec) return { ok: false, why: 'the call is too old (or the clock is off)' };
  const want = Buffer.from(sigOf(secret, ts, nonce, req.method, req.path, req.body), 'hex'), got = Buffer.from(sig, 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, why: 'wrong signature' };
  return { ok: true, nonce, ts: Number(ts) };
}

/** A plan from JSON, or why it is not one (puts, a bad ref, a missing number ...). */
export function parsePlan(x: unknown): { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly why: string } {
  const o = x as Plan | null;
  if (!o || typeof o !== 'object') return { ok: false, why: 'no plan' };
  if (typeof o.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.day)) return { ok: false, why: 'the plan has no decision day' };
  if (typeof o.account !== 'string' || !o.account) return { ok: false, why: 'the plan names no paper account' };
  if (!(Number(o.slots) > 0) || !(Number(o.accountValue) > 0) || !Array.isArray(o.orders)) return { ok: false, why: 'the plan lacks slots, account value or orders' };
  const refs = new Set<string>();
  for (const p of o.orders as PlannedOrder[]) {
    if (!p || typeof p.ticker !== 'string' || !/^[A-Z0-9. ^-]{1,32}$/.test(p.ticker)) return { ok: false, why: 'an order has no valid ticker' };
    if (p.side !== 'BUY' && p.side !== 'SELL') return { ok: false, why: p.ticker + ': side must be BUY or SELL' };
    if (p.kind === 'put') return { ok: false, why: p.ticker + ': puts are not allowed (long-only)' };
    if (p.kind !== 'share' && p.kind !== 'call') return { ok: false, why: p.ticker + ': unknown kind ' + String(p.kind) };
    if (!(p.qty > 0) || !(p.price > 0)) return { ok: false, why: p.ticker + ': quantity and price must be positive' };
    if (p.ref !== orderRef(o.day, o.account, p.ticker, p.side)) return { ok: false, why: p.ticker + ': the order ref is not the fixed day-account-ticker-side ref' };
    if (refs.has(p.ref)) return { ok: false, why: p.ticker + ': two orders with the same ref' };
    refs.add(p.ref);
  }
  return { ok: true, plan: o };
}

const pendingView = (p: PendingPlan | null): Record<string, unknown> | null => p && ({
  day: p.plan.day, execDay: p.execDay, account: p.plan.account, hash: p.hash, short: shortHash(p.hash), status: p.status, held: p.held,
  approval: p.approval, skipped: p.skipped, notes: p.notes,
  orders: p.plan.orders.map((o) => ({ ref: o.ref, ticker: o.ticker, side: o.side, kind: o.kind, qty: o.qty, price: o.price })),
});

export function createControlHandler(d: ControlDeps): (req: ControlRequest) => Promise<ControlResponse> {
  if (typeof d.secret !== 'string' || d.secret.length < MIN_SECRET_LENGTH) throw new Error('LIVE_CONTROL_SECRET is not configured (at least ' + MIN_SECRET_LENGTH + ' characters)');
  const acct = d.cfg.botAccount, b = guardBroker(d.broker, acct);
  const say = async (t: string): Promise<void> => { try { await d.alert?.(t); } catch { /* ignored */ } };
  const bad = (status: number, why: string): ControlResponse => ({ status, body: { ok: false, why } });

  return async (req: ControlRequest): Promise<ControlResponse> => {
    const now = d.now();
    const sig = checkSignature(req, d.secret, now, d.cfg.controlSkewSec);
    if (!sig.ok) return bad(401, sig.why);
    // replay: a nonce is accepted once, and remembered until its timestamp is too old to pass anyway
    const fresh = await updateState(d.state, (s) => {
      for (const [n, until] of Object.entries(s.nonces)) if (until < now) delete s.nonces[n];
      if (s.nonces[sig.nonce]) return false;
      s.nonces[sig.nonce] = (sig.ts + d.cfg.controlSkewSec) * 1000 + 1000;
      return true;
    });
    if (!fresh) return bad(401, 'replayed call');
    let body: Record<string, any> = {};
    if (req.method === 'POST') { try { body = req.body ? JSON.parse(req.body) : {}; } catch { return bad(400, 'the body is not JSON'); } }

    const route = req.method.toUpperCase() + ' ' + req.path;
    try {
      if (route === 'GET /status') return { status: 200, body: await status(now) };
      if (route === 'POST /plan') return await postPlan(body.plan, now);
      if (route === 'POST /approve') return await approve(body, now);
      if (route === 'POST /halt') {
        if (body.halted === false) return { status: 200, body: { ok: true, halted: false, message: await resume(d.state) } };
        const r = await halt(d.state, b, acct, String(body.why ?? 'owner /stopbot').slice(0, 200));
        const p = (await d.state.load()).pending;
        if (p && r.cancelled.length) await appendLiveRows(d.store, r.cancelled.map((c) => liveEventRow({ day: p.plan.day, account: p.plan.account, when: 'cancelled', ticker: c.ticker, side: c.side as 'BUY' | 'SELL', qty: c.qty - c.filledQty, why: 'kill switch (' + c.filledQty + ' of ' + c.qty + ' filled, kept)', ref: c.orderRef }))).catch(() => 0);
        return { status: 200, body: { ok: r.failed.length === 0, halted: true, cancelled: r.cancelled, failed: r.failed, message: r.message } };
      }
      if (route === 'POST /confirm') return await confirm(now);
      return bad(404, 'no such call');
    } catch (e) {
      return bad(500, 'failed: ' + String((e as Error)?.message ?? e) + '. ' + IBKR_APP_STOP);
    }
  };

  async function status(now: number): Promise<Record<string, unknown>> {
    const s = await d.state.load();
    const out: Record<string, unknown> = { ok: true, at: new Date(now).toISOString(), account: acct, halted: s.halted, haltedWhy: s.haltedWhy, connection: b.connectionState(), pending: pendingView(s.pending) };
    try {
      await b.accounts();
      const snap = await readSnapshot(b, acct);
      const rec = reconcile(s.ledger, snap.positions, snap.cash, { autoAcceptCreditUsd: d.cfg.autoAcceptCreditUsd });
      Object.assign(out, { ...(rec.credit ? { creditToAccept: rec.credit.detail } : {}), accountType: snap.accountType, cash: snap.cash, settledCash: snap.settledCash, positions: snap.positions.map((p) => ({ ticker: p.ticker, kind: p.kind, qty: p.qty })), openOrders: snap.openOrders.map((o) => ({ ref: o.orderRef, side: o.side, ticker: o.ticker, qty: o.qty, filled: o.filledQty, limit: o.limit })), reconciliation: rec.mismatches });
    } catch (e) { out.broker = 'unknown: ' + String((e as Error)?.message ?? e); }
    return out;
  }

  async function postPlan(raw: unknown, now: number): Promise<ControlResponse> {
    const parsed = parsePlan(raw);
    if (!parsed.ok) return bad(422, parsed.why);
    const plan = parsed.plan, hash = planHash(plan);
    const s0 = await d.state.load();
    if (s0.halted) return bad(409, 'the bot is halted; the plan is not stored (/startbot first)');
    const last = lastClosedTradingDay(now);
    if (plan.day !== last) return bad(422, 'stale plan: decided on ' + plan.day + ' but the last closed trading day is ' + last + ' (R4)');
    if (s0.pending && s0.pending.hash === hash && s0.pending.plan.day === plan.day) return { status: 200, body: { ok: true, unchanged: true, ...answer(s0.pending) } };
    // the real account, now
    const held: string[] = [];
    let alert: string | null = null;
    let credit: AcceptedCredit | null = null;
    try {
      await b.accounts();
      const snap = await readSnapshot(b, acct);
      for (const o of plan.orders) {
        const why = longOnlyRefusal({ side: o.side, kind: o.kind, ticker: o.ticker, qty: o.qty, limit: o.price, held: heldQty(snap, o.ticker, o.kind), accountType: snap.accountType, allowCalls: d.cfg.allowCalls });
        if (why) return bad(422, o.ticker + ': ' + why);
      }
      const rec = await updateState(d.state, (s) => {
        if (s.ledger) applyFills(s.ledger, snap.todaysFills.filter((f) => f.orderRef.startsWith('LB-')), s.appliedFills);
        const r = reconcile(s.ledger, snap.positions, snap.cash, { autoAcceptCreditUsd: d.cfg.autoAcceptCreditUsd });
        acceptCredit(s.ledger, r);
        return r;
      });
      if (!rec.ok) { held.push(...rec.mismatches.map((m) => m.detail)); alert = rec.alert; }
      credit = rec.credit;
    } catch (e) {
      held.push('the broker could not be read at plan time (' + String((e as Error)?.message ?? e) + ')');
      alert = '⚠️ Live bot: the broker could not be read, so tonight\'s plan is held (nothing will be sent). ' + IBKR_APP_STOP;
    }
    const pending: PendingPlan = {
      plan, hash, execDay: nextTradingDay(plan.day), receivedAt: now, status: held.length ? 'held' : d.cfg.approveMode ? 'awaiting-approval' : 'ready',
      approval: null, held, skipped: {}, notes: s0.pending && s0.pending.plan.day === plan.day ? ['replaces an earlier version (' + shortHash(s0.pending.hash) + '); any approval of it is void'] : [],
      sendStarted: false, summarySent: false,
    };
    await updateState(d.state, (s) => { s.pending = pending; });
    if (credit && !held.length) await appendLiveRows(d.store, [creditRow(pending, credit)]).catch(() => 0);
    if (alert) await say(alert);
    return { status: 200, body: { ok: true, ...answer(pending), ...(alert ? { alert } : {}) } };
  }

  function answer(p: PendingPlan): Record<string, unknown> {
    const short = shortHash(p.hash);
    return { day: p.plan.day, execDay: p.execDay, hash: p.hash, short, status: p.status, held: p.held, buttons: { approve: 'lb:ok:' + p.plan.day + ':' + short, skip: 'lb:no:' + p.plan.day + ':' + short } };
  }

  async function approve(body: Record<string, any>, now: number): Promise<ControlResponse> {
    const decision: Decision = body.decision === 'skip' ? 'skip' : 'approve';
    if (body.decision !== 'approve' && body.decision !== 'skip') return bad(400, 'decision must be approve or skip');
    const r = await updateState(d.state, (s) => ({ r: decide(s, { day: String(body.day ?? ''), hash: String(body.hash ?? ''), decision, by: String(body.by ?? 'owner').slice(0, 64) }, now), p: s.pending }));
    if (!r.r.ok) return bad(409, r.r.why);
    const p = r.p!;
    const rows = r.r.status === 'approved'
      ? [liveEventRow({ day: p.plan.day, account: p.plan.account, when: 'approved', why: 'approved by ' + (p.approval?.by ?? 'owner') + ' before the open of ' + p.execDay + ' (plan ' + shortHash(p.hash) + ', ' + p.plan.orders.length + ' order(s))' })]
      : p.plan.orders.map((o) => liveEventRow({ day: p.plan.day, account: p.plan.account, when: 'skipped', ticker: o.ticker, side: o.side, qty: o.qty, why: 'skipped by the owner (❌)', ref: o.ref }));
    await appendLiveRows(d.store, rows).catch(() => 0);
    return { status: 200, body: { ok: true, status: r.r.status, message: r.r.message } };
  }

  async function confirm(now: number): Promise<ControlResponse> {
    await b.accounts();
    const snap = await readSnapshot(b, acct);
    const before = await d.state.load();
    const rec = reconcile(before.ledger, snap.positions, snap.cash);
    await updateState(d.state, (s) => {
      s.ledger = ledgerFromBroker(snap.positions, snap.cash, now);
      // today's fills are in the broker's view already
      for (const f of snap.todaysFills) if (!s.appliedFills.includes(f.execId)) s.appliedFills.push(f.execId);
      if (s.pending && s.pending.status === 'held') { s.pending.status = d.cfg.approveMode ? 'awaiting-approval' : 'ready'; s.pending.notes.push('account confirmed by the owner: ' + (rec.mismatches.map((m) => m.detail).join('; ') || 'no difference')); s.pending.held = []; }
    });
    const p = (await d.state.load()).pending;
    return { status: 200, body: { ok: true, adopted: rec.mismatches.map((m) => m.detail), pending: pendingView(p), message: '✔️ Account confirmed: the bot\'s record now equals IBKR (' + rec.mismatches.length + ' difference(s) accepted).' + (p && p.status !== 'held' && d.cfg.approveMode && p.status === 'awaiting-approval' ? ' The plan of ' + p.plan.day + ' needs approval again.' : '') } };
  }
}

/** node:http adapter for the server (phase 2): `http.createServer(nodeListener(handler))` behind HTTPS. Not started here. */
export function nodeListener(handler: (req: ControlRequest) => Promise<ControlResponse>, maxBody = 256 * 1024): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0, tooBig = false;
    req.on('data', (c: Buffer) => { size += c.length; if (size > maxBody) { tooBig = true; req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      const path = (req.url ?? '/').split('?')[0]!;
      handler({ method: req.method ?? 'GET', path, headers, body: Buffer.concat(chunks).toString('utf8') })
        .then((r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); })
        .catch(() => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"ok":false}'); });
    });
  };
}
