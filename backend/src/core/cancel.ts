/**
 * Backlog row 34 (rest of F-B7-2): real cancellation of a step that hit its time limit.
 *
 * runStep gives every attempt an AbortSignal and runs the work inside it (AsyncLocalStorage, so the
 * signal reaches the HTTP layer and the Sheets client without threading a parameter through every
 * function). A nested step's signal also fires when any enclosing step's does. When an attempt hits
 * its time limit, its signal is aborted: the HTTP client and the Sheets client start no new request,
 * and requests in flight are aborted. Work outside any step has no signal and is never cancelled.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<AbortSignal>();

/** Raised inside a step's work once the step has been cancelled (it hit its time limit). */
export class CancelledError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`step "${label}" was cancelled after its ${timeoutMs}ms limit`);
    this.name = 'CancelledError';
  }
}

/** The cancellation signal of the step this code runs in, or undefined outside any step. */
export function currentSignal(): AbortSignal | undefined {
  return store.getStore();
}

/** Runs fn with `signal` as the current step signal (for runStep). */
export function runWithSignal<T>(signal: AbortSignal, fn: () => T): T {
  return store.run(signal, fn);
}

/** Throws the cancellation reason when the current step has been cancelled. */
export function throwIfCancelled(signal: AbortSignal | undefined = currentSignal()): void {
  if (signal?.aborted) throw signal.reason;
}
