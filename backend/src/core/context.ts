/**
 * RunContext -- threaded explicitly through every function that does real
 * work, as the first parameter.
 *
 * Explicit rather than a module singleton: slightly more verbose, but every
 * function's real dependencies are visible in its signature, and tests can
 * construct an isolated context without mutating global state.
 *
 * The clock, sleep, and random are injectable so that retry/backoff logic is
 * testable deterministically and instantly, rather than by waiting.
 */

import { Logger } from './logger.ts';
import { runLogSink } from './logFile.ts';
import type { LogLevelValue } from './logger.ts';
import { StatusAccumulator } from './status.ts';
import { sleep as realSleep } from './errors.ts';

export type RunMode = 'nightly' | 'ai' | 'ticker' | 'smoke' | 'lock' | 'migrate' | 'test';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface RunContext {
  readonly runId: string;
  readonly mode: RunMode;
  readonly log: Logger;
  readonly status: StatusAccumulator;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** Scoped copy for one ticker. Gets its own logger scope and escalation state. */
  forTicker(ticker: string): RunContext;
}

export interface CreateContextOptions {
  readonly mode: RunMode;
  readonly runId?: string;
  readonly minLevel?: LogLevelValue;
  readonly logger?: Logger;
  readonly status?: StatusAccumulator;
  readonly clock?: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
}

export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export function createContext(opts: CreateContextOptions): RunContext {
  // No logger given (the maintenance CLIs): the console sink, plus the run's full log file when RUN_LOG_FILE is set.
  const log = opts.logger ?? (() => { const fullSink = runLogSink(); return new Logger({ minLevel: opts.minLevel, scope: opts.mode, ...(fullSink ? { fullSink } : {}) }); })();

  // Status is SHARED across ticker scopes on purpose. Logging is per-ticker
  // (so one ticker's noise stays local), but data health is a property of the
  // whole run and must be rendered once, at the end, in one place.
  const status = opts.status ?? new StatusAccumulator();

  const base: Omit<RunContext, 'forTicker'> = {
    runId: opts.runId ?? newRunId(),
    mode: opts.mode,
    log,
    status,
    clock: opts.clock ?? systemClock,
    sleep: opts.sleep ?? realSleep,
    random: opts.random ?? Math.random,
    backoffBaseMs: opts.backoffBaseMs ?? 1000,
    backoffMaxMs: opts.backoffMaxMs ?? 32_000,
  };

  const make = (self: Omit<RunContext, 'forTicker'>): RunContext => ({
    ...self,
    forTicker(ticker: string): RunContext {
      return make({ ...self, log: self.log.child(ticker) });
    },
  });

  return make(base);
}
