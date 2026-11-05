/**
 * runStep() -- the single chokepoint every real step passes through.
 *
 * Why a chokepoint rather than a convention: a convention gets forgotten
 * under pressure, and its absence is invisible in review. Here, NOT using
 * runStep is visibly anomalous, and a lint rule forbids raw try/catch
 * outside src/core/. This directly addresses gaps found in the legacy code
 * -- steps with no try/catch at all, statuses recorded on some branches but
 * not others, and Logger.log used where structured output belonged.
 *
 * The wrapper owns, so no individual module can forget:
 *   1. timing
 *   2. try/catch
 *   3. a per-call timeout
 *   4. failure classification and retry
 *   5. logging at the right level (which triggers escalation)
 *   6. status recording
 */

import type { RunContext } from './context.ts';
import type { StepResult, ReportSentence, FailureKind } from './result.ts';
import { ok, err, logDetail } from './result.ts';
import { StepState } from './status.ts';
import { classify, messageOf, backoffMs, TimeoutError } from './errors.ts';
import { CancelledError, currentSignal, runWithSignal } from './cancel.ts';

export type RetryPolicy = 'auto' | 'always' | 'never';

export interface StepSpec {
  /** Stable key used for status lookup. */
  readonly key: string;
  /** Human label used in logs and disclosure. */
  readonly label: string;
  /**
   * The curated sentence shown to the user if this step fails.
   *
   * REQUIRED on purpose. Forcing it here means the sentence is written by
   * whoever knows what the failure actually means, at the moment the step is
   * written -- rather than retrofitted later by someone guessing.
   */
  readonly onFailure: ReportSentence;
  readonly retry?: RetryPolicy;
  readonly timeoutMs?: number;
  /** Max attempts when retrying. Default 2 (one retry). */
  readonly maxAttempts?: number;
  /**
   * F-B7-2: false = an attempt that hit the time limit is not retried. Before row 34 the timed-out
   * work was not cancelled, so a retry ran beside it; the first real nightly ran 3 copies of the
   * relative-strength refresh at once, all calling the Sheets API. Default true.
   */
  readonly retryAfterTimeout?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 2;

function shouldRetry(policy: RetryPolicy, kind: FailureKind): boolean {
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  // 'auto': retry unless we can show retrying is pointless.
  return kind !== 'permanent';
}

/**
 * Races a promise against a timer.
 *
 * Row 34: when the timer wins, `ac` is aborted. The work runs under that signal (see cancel.ts),
 * so the HTTP layer and the Sheets client start no new request and abort the ones in flight.
 * Plain computation is not interrupted; it fails at its next request.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string, ac: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError(ms, label));
          ac.abort(new CancelledError(label, ms));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runStep<T>(ctx: RunContext, spec: StepSpec, fn: (signal: AbortSignal) => Promise<T>): Promise<StepResult<T>> {
  const log = ctx.log;
  // Row 34: the signal of the enclosing step, if any. Once it fires, this step starts no attempt.
  const parent = currentSignal();
  const policy = spec.retry ?? 'auto';
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const started = ctx.clock.now();

  let attempt = 0;
  let lastErr: unknown;
  let kind: FailureKind = 'unknown';

  while (attempt < maxAttempts) {
    if (parent?.aborted) break;
    attempt++;
    log.debug(`step start: ${spec.label}`, { key: spec.key, attempt });

    const ac = new AbortController();
    const signal = parent ? AbortSignal.any([parent, ac.signal]) : ac.signal;
    try {
      const value = await withTimeout(runWithSignal(signal, () => fn(signal)), timeoutMs, spec.label, ac);
      const elapsedMs = ctx.clock.now() - started;

      ctx.status.set({
        key: spec.key,
        label: spec.label,
        state: StepState.OK,
        elapsedMs,
        attempts: attempt,
      });
      log.info(`${spec.label} OK`, { key: spec.key, ms: elapsedMs, attempt });
      return ok(value);
    } catch (e) {
      lastErr = e;
      kind = classify(e);
      const msg = messageOf(e);

      const timedOutNoRetry = spec.retryAfterTimeout === false && e instanceof TimeoutError;
      const canRetry = attempt < maxAttempts && shouldRetry(policy, kind) && !timedOutNoRetry && !parent?.aborted;
      if (canRetry) {
        const wait = backoffMs(attempt, ctx.backoffBaseMs, ctx.backoffMaxMs, ctx.random);
        // WARNING escalates this scope to DEBUG and replays its pre-buffer,
        // so the lines leading up to this failure become visible.
        log.warning(`${spec.label} failed (${kind}) — retrying in ${wait}ms`, {
          key: spec.key,
          attempt,
          detail: msg,
        });
        await ctx.sleep(wait);
        continue;
      }
      break;
    }
  }

  const elapsedMs = ctx.clock.now() - started;
  if (parent?.aborted) {
    // Row 34: the enclosing step hit its time limit and has already been reported failed. This
    // leftover work records no status of its own, so nothing new reaches the report after the run.
    const reason: unknown = parent.reason;
    log.info(`${spec.label} cancelled (enclosing step timed out)`, { key: spec.key, ms: elapsedMs, attempt });
    return err({ kind: 'unknown', detail: logDetail(messageOf(reason)), disclosure: spec.onFailure, attempts: attempt, cause: reason });
  }
  const detail = logDetail(messageOf(lastErr));

  ctx.status.set({
    key: spec.key,
    label: spec.label,
    state: StepState.FAILED,
    disclosure: spec.onFailure,
    detail,
    elapsedMs,
    attempts: attempt,
  });

  log.error(`${spec.label} failed after ${attempt} attempt(s) (${kind})`, {
    key: spec.key,
    ms: elapsedMs,
    detail: String(detail),
  });

  return err({ kind, detail, disclosure: spec.onFailure, attempts: attempt, cause: lastErr });
}

/** Records a step that was deliberately not run. */
export function skipStep(ctx: RunContext, spec: Pick<StepSpec, 'key' | 'label'>, why: ReportSentence): void {
  ctx.status.set({ key: spec.key, label: spec.label, state: StepState.SKIPPED, disclosure: why });
  ctx.log.info(`${spec.label} skipped`, { key: spec.key });
}

/** Records a step that produced usable but incomplete output. */
export function degradeStep(ctx: RunContext, spec: Pick<StepSpec, 'key' | 'label'>, why: ReportSentence): void {
  ctx.status.set({ key: spec.key, label: spec.label, state: StepState.DEGRADED, disclosure: why });
  ctx.log.warning(`${spec.label} degraded`, { key: spec.key });
}
