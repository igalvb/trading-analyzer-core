/**
 * The sanctioned way to swallow an error outside src/core (docs/LOGGING_SPEC.md rule: no catch without a log line).
 *
 * orElse / orElseAsync run `fn`; on a throw they log ONE line in the given logger's scope (WARNING by default:
 * a fallback was used and the run goes on) with the raw error text in `detail`, then return the fallback. The raw
 * text stays in the log; the fallback is what the caller's report sees. A null logger (legacy-parity runs, tests
 * without a context) only returns the fallback, exactly like the bare catch it replaces.
 *
 * They also replace raw try/catch blocks, which test/lintRatchet.test.ts counts outside src/core.
 */

import type { Logger } from './logger.ts';
import { messageOf } from './errors.ts';

export type GuardLevel = 'debug' | 'info' | 'warning' | 'error' | 'critical';

function report(log: Logger | null | undefined, level: GuardLevel, what: string, e: unknown, data?: Record<string, unknown>): void {
  if (!log) return;
  log[level](what + ' failed; using the fallback', { ...(data ?? {}), detail: messageOf(e) });
}

/** fn(), or `fallback` (and one log line) when it throws. */
export function orElse<T>(log: Logger | null | undefined, what: string, fn: () => T, fallback: T, level: GuardLevel = 'warning', data?: Record<string, unknown>): T {
  try {
    return fn();
  } catch (e) {
    report(log, level, what, e, data);
    return fallback;
  }
}

/** await fn(), or `fallback` (and one log line) when it throws or rejects. */
export async function orElseAsync<T>(log: Logger | null | undefined, what: string, fn: () => Promise<T>, fallback: T, level: GuardLevel = 'warning', data?: Record<string, unknown>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    report(log, level, what, e, data);
    return fallback;
  }
}
