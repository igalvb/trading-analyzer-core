/**
 * fetchStep(): the reusable retry + log + plain-message plumbing every
 * fetch step of the analysis run goes through (F-34, the user's decision).
 *
 * PARITY MODE (`parity: true`, the oracle tests): exactly one call; a throw
 * propagates and a null comes back as null -- legacy's behaviour, so the
 * oracle comparisons stay exact.
 *
 * PRODUCTION: up to `attempts` tries (default 3) with jittered exponential
 * backoff. A throw is retried; a null is retried only when the HTTP tap saw
 * a provider failure behind it (a ticker that simply has no data is not
 * hammered). Every failed attempt is logged at WARNING with the real error
 * and "attempt n of N"; the final failure at ERROR. The step never throws:
 * the caller gets `ok: false`, a catalog reason code and a QualityItem
 * (src/reports/messages/catalog.ts) -- plain words only, no raw error.
 */

import type { RunContext } from './context.ts';
import { backoffMs, messageOf } from './errors.ts';
import { qualityFor, type KeyedQuality } from './messages.ts';
import { classifyError, type EffectCode, type ReasonCode } from '../reports/messages/catalog.ts';
import type { TappingTransport, HttpEvent } from '../net/httpTap.ts';
import { anyFailed } from '../net/httpTap.ts';

export interface FetchStepSpec {
  /** Stable key; a STATUS_SUBJECTS key gives the default label/effect. */
  readonly key: string;
  /** For the log: 'Yahoo chart SPY', 'SEC EDGAR CIK', 'Gemini'. */
  readonly source: string;
  readonly label?: string;
  readonly effect?: EffectCode;
  /** What a null result means: 'retry' (always retry), 'tap' (retry only if the tap saw a failure; default), 'accept' (null is a valid answer). */
  readonly onNull?: 'retry' | 'tap' | 'accept';
  /**
   * Fix 2026-11-04: a source that may simply have nothing for some tickers (no provider failure seen). When set, a
   * plain "no data" end is ONE WARNING (`<source> found no data [NO_DATA_FOR_TICKER]: <note>`) instead of a
   * per-attempt WARNING plus an ERROR; INFO when every request was a 404 (fix 2026-11-05). A throw or a provider
   * failure is still logged as before.
   */
  readonly noDataNote?: string;
}

export interface FetchStepDeps {
  readonly ctx: RunContext;
  readonly parity?: boolean;
  readonly attempts?: number;
  readonly tap?: TappingTransport | null;
}

export type FetchStepResult<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | { readonly ok: false; readonly value: null; readonly attempts: number; readonly reason: ReasonCode; readonly quality: KeyedQuality };

export const DEFAULT_FETCH_ATTEMPTS = 3;

/** The plain reason behind a failed step: the thrown value if any, else what the HTTP tap saw. */
export function reasonFromSignal(events: readonly HttpEvent[], thrown: unknown): ReasonCode {
  if (thrown != null) return classifyError(thrown);
  if (events.some((e) => e.status === 429)) return 'RATE_LIMIT';
  if (events.some((e) => e.timedOut || e.error != null || (e.status != null && e.status >= 500))) return 'PROVIDER_NO_RESPONSE';
  return 'NO_DATA_FOR_TICKER';
}

export async function fetchStep<T>(deps: FetchStepDeps, spec: FetchStepSpec, fn: () => Promise<T>): Promise<FetchStepResult<T>> {
  if (deps.parity) return { ok: true, value: await fn(), attempts: 1 };
  const { ctx } = deps;
  const max = Math.max(1, deps.attempts ?? DEFAULT_FETCH_ATTEMPTS);
  const onNull = spec.onNull ?? 'tap';
  let lastEvents: HttpEvent[] = [];
  let lastThrown: unknown = null;
  let tried = 0;
  for (let attempt = 1; attempt <= max; attempt++) {
    tried = attempt;
    const mark = deps.tap ? deps.tap.mark() : 0;
    const t0 = ctx.clock.now();
    let retryable = false;
    try {
      const value = await fn();
      const events = deps.tap ? deps.tap.since(mark) : [];
      if (value != null) {
        if (attempt > 1) ctx.log.info(spec.source + ' succeeded on attempt ' + attempt + ' of ' + max, { key: spec.key, ms: ctx.clock.now() - t0 });
        return { ok: true, value, attempts: attempt };
      }
      lastEvents = events; lastThrown = null;
      if (onNull === 'accept') return { ok: true, value, attempts: attempt };
      retryable = onNull === 'retry' || (onNull === 'tap' && (deps.tap ? anyFailed(events) : true));
      if (spec.noDataNote && !anyFailed(events) && (!retryable || attempt === max)) break; // one WARNING below, not two
      ctx.log.warning(spec.source + ' returned no data (attempt ' + attempt + ' of ' + max + ')', {
        key: spec.key, ms: ctx.clock.now() - t0, http: events.map((e) => (e.status ?? e.error) + ' ' + e.method + ' ' + e.url),
      });
    } catch (e) {
      lastThrown = e; lastEvents = deps.tap ? deps.tap.since(mark) : [];
      retryable = true;
      ctx.log.warning(spec.source + ' failed (attempt ' + attempt + ' of ' + max + '): ' + messageOf(e), {
        key: spec.key, ms: ctx.clock.now() - t0, http: lastEvents.map((ev) => (ev.status ?? ev.error) + ' ' + ev.method + ' ' + ev.url),
      });
    }
    if (!retryable || attempt === max) break;
    await ctx.sleep(backoffMs(attempt, ctx.backoffBaseMs, ctx.backoffMaxMs, ctx.random));
  }
  const reason = reasonFromSignal(lastEvents, lastThrown);
  if (spec.noDataNote && lastThrown == null && reason === 'NO_DATA_FOR_TICKER') {
    // Fix 2026-11-05: when EVERY request was answered 404 (e.g. a new issuer SEC has no concept for yet), the source
    // said plainly "nothing here": INFO. Anything else behind the null (no HTTP seen, another status) stays a WARNING;
    // a throw or a provider failure never reaches this branch.
    const all404 = lastEvents.length > 0 && lastEvents.every((e) => e.status === 404);
    ctx.log[all404 ? 'info' : 'warning'](spec.source + ' found no data [' + reason + ']: ' + spec.noDataNote, { key: spec.key });
  } else ctx.log.error(spec.source + ' gave up: ' + (lastThrown != null ? messageOf(lastThrown) : 'no data') + ' [' + reason + ']', { key: spec.key });
  return { ok: false, value: null, attempts: tried, reason, quality: qualityFor(spec.key, reason, new Date(ctx.clock.now()), { label: spec.label, effect: spec.effect }) };
}
