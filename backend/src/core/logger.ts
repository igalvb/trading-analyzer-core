/**
 * Leveled logger with WARNING/ERROR-triggered escalation and RETROACTIVE
 * flush of the pre-warning DEBUG buffer.
 *
 * The requirement: a clean run logs INFO and above (cheap). The moment
 * anything goes wrong, that scope switches to full DEBUG *and replays the
 * DEBUG lines it had been silently holding* -- so the lines immediately
 * preceding a failure, which are the ones that actually explain it, are
 * never lost. Cheap when healthy, maximally detailed exactly when it isn't.
 *
 * Output goes to the run's console sink (stderr in the CLI entries, the GitHub Actions run log). Not to the
 * Sheet -- that was an Apps Script constraint (per-line write cost) that no longer applies.
 *
 * Levels (docs/LOGGING_SPEC.md has the per-step table):
 *   DEBUG     detail; held back while a scope is healthy, replayed when it escalates
 *   INFO      start / end of a step, with counts and ms
 *   WARNING   something degraded (a fallback was used, a piece is missing); the run goes on
 *   ERROR     a piece failed (a step, a ticker, a write); the run goes on
 *   CRITICAL  the run cannot do its job (sheet unreachable, startup refused, profile invalid, a whole step the
 *             report depends on failed). Escalates like ERROR; counted run-wide (runCounts) for the run summary
 *             and the workflows' failure notice.
 *
 * fullSink (optional) receives EVERY line at every level as it is made, before any filtering: the run's full
 * log file (core/logFile.ts, backend/out/<job>.log). The console sink keeps INFO+ with escalation.
 */

import type { LogDetail } from './result.ts';

export const LogLevel = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
} as const;

export type LogLevelName = keyof typeof LogLevel;
export type LogLevelValue = (typeof LogLevel)[LogLevelName];

const LEVEL_NAME: Record<number, LogLevelName> = {
  10: 'DEBUG',
  20: 'INFO',
  30: 'WARNING',
  40: 'ERROR',
  50: 'CRITICAL',
};

export interface LogLine {
  readonly ts: string;
  readonly level: LogLevelValue;
  readonly scope: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
  /** True when this line was held in the pre-buffer and replayed on escalation. */
  readonly replayed?: boolean;
}

export type LogSink = (line: LogLine) => void;

export interface LogCounts { readonly debug: number; readonly info: number; readonly warning: number; readonly error: number; readonly critical: number }

const zeroCounts = (): { debug: number; info: number; warning: number; error: number; critical: number } => ({ debug: 0, info: 0, warning: 0, error: 0, critical: 0 });

/**
 * How many DEBUG lines each scope holds in reserve. Bounded so memory
 * cannot grow without limit; in practice the lines just before a failure
 * are the ones that matter, so a modest window is sufficient.
 */
const PRE_BUFFER_SIZE = 200;

export function formatLine(line: LogLine): string {
  const lvl = LEVEL_NAME[line.level] ?? String(line.level);
  const scope = line.scope ? ` [${line.scope}]` : '';
  const replay = line.replayed ? ' (replayed)' : '';
  const data = line.data && Object.keys(line.data).length > 0 ? ` ${JSON.stringify(line.data)}` : '';
  return `${line.ts} ${lvl.padEnd(7)}${scope}${replay} ${line.message}${data}`;
}

export const consoleSink: LogSink = (line) => {
  const text = formatLine(line);
  if (line.level >= LogLevel.ERROR) console.error(text);
  else console.log(text);
};

export interface LoggerOptions {
  /** Minimum level emitted before any escalation. Defaults to INFO. */
  readonly minLevel?: LogLevelValue;
  readonly sink?: LogSink;
  readonly scope?: string;
  /** Injectable for deterministic tests. */
  readonly now?: () => Date;
  /** Every line, every level, unfiltered (the run's full log file). Inherited by children. */
  readonly fullSink?: LogSink;
}

export class Logger {
  readonly scope: string;
  private readonly minLevel: LogLevelValue;
  private readonly sink: LogSink;
  private readonly now: () => Date;
  private readonly fullSink: LogSink | undefined;

  /** DEBUG lines held back while this scope is healthy. */
  private preBuffer: LogLine[] = [];

  /** Sticky and one-way: once escalated, a scope stays verbose for its life. */
  private escalated = false;

  /** Counters, so an end-of-run summary can report without re-scanning output. */
  private counts = zeroCounts();

  /** Run-wide counts: shared by this logger and every child made from it (the run summary reads them). */
  private tally = zeroCounts();

  constructor(opts: LoggerOptions = {}) {
    this.minLevel = opts.minLevel ?? LogLevel.INFO;
    this.sink = opts.sink ?? consoleSink;
    this.scope = opts.scope ?? '';
    this.now = opts.now ?? (() => new Date());
    this.fullSink = opts.fullSink;
  }

  /**
   * Creates a scoped child with its OWN pre-buffer and escalation state.
   *
   * This is what makes per-ticker escalation precise: a WARNING while
   * analysing AAPL makes AAPL verbose and replays AAPL's buffered lines,
   * while every other ticker stays at INFO. Clean tickers stay cheap.
   *
   * A child created after its parent already escalated starts escalated --
   * if the run as a whole is in trouble, new work inherits the verbosity.
   */
  child(scope: string): Logger {
    const full = this.scope ? `${this.scope}:${scope}` : scope;
    const c = new Logger({ minLevel: this.minLevel, sink: this.sink, scope: full, now: this.now, ...(this.fullSink ? { fullSink: this.fullSink } : {}) });
    c.tally = this.tally;
    if (this.escalated) c.escalated = true;
    return c;
  }

  isEscalated(): boolean {
    return this.escalated;
  }

  /** This scope's own counts. */
  getCounts(): LogCounts {
    return { ...this.counts };
  }

  /** The whole run's counts: this logger, its parent chain's root and every child of it (one shared tally). */
  runCounts(): LogCounts {
    return { ...this.tally };
  }

  /** Number of lines currently held back. Exposed for tests and assertions. */
  pendingBufferSize(): number {
    return this.preBuffer.length;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.count('debug');
    const line = this.build(LogLevel.DEBUG, message, data);
    this.full(line);
    if (this.escalated || this.minLevel <= LogLevel.DEBUG) {
      this.sink(line);
      return;
    }
    // Held in reserve. If this scope later hits a WARNING/ERROR, this line
    // is replayed -- that is the whole point of the pre-buffer.
    this.preBuffer.push(line);
    if (this.preBuffer.length > PRE_BUFFER_SIZE) this.preBuffer.shift();
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.count('info');
    this.emitAtLeast(LogLevel.INFO, message, data);
  }

  warning(message: string, data?: Record<string, unknown>): void {
    this.count('warning');
    this.escalate('WARNING');
    this.emitAtLeast(LogLevel.WARNING, message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.count('error');
    this.escalate('ERROR');
    this.emitAtLeast(LogLevel.ERROR, message, data);
  }

  /** The run cannot do its job (see the header). Escalates like ERROR. */
  critical(message: string, data?: Record<string, unknown>): void {
    this.count('critical');
    this.escalate('CRITICAL');
    this.emitAtLeast(LogLevel.CRITICAL, message, data);
  }

  /**
   * Convenience for logging a technical detail string. Typed to LogDetail so
   * a value intended for the report cannot be passed here by accident, and
   * vice versa.
   */
  detail(level: 'warning' | 'error' | 'critical', message: string, detail: LogDetail): void {
    this[level](message, { detail: String(detail) });
  }

  private emitAtLeast(level: LogLevelValue, message: string, data?: Record<string, unknown>): void {
    const line = this.build(level, message, data);
    this.full(line);
    if (level < this.minLevel && !this.escalated) return;
    this.sink(line);
  }

  private count(k: keyof LogCounts): void {
    this.counts[k]++;
    this.tally[k]++;
  }

  /** The full log never fails the run: a sink that throws loses that one line; the console sink still gets it. */
  private full(line: LogLine): void {
    if (!this.fullSink) return;
    try { this.fullSink(line); } catch { /* the console sink still has the line */ }
  }

  private build(level: LogLevelValue, message: string, data?: Record<string, unknown>): LogLine {
    return { ts: this.now().toISOString(), level, scope: this.scope, message, data };
  }

  /**
   * Switch this scope to full DEBUG and replay everything it was holding.
   *
   * The replay is the non-obvious half. Going verbose from this point
   * forward tells you what happened AFTER the problem; replaying the buffer
   * tells you what led UP to it, which is usually the part that explains it.
   */
  private escalate(trigger: 'WARNING' | 'ERROR' | 'CRITICAL'): void {
    if (this.escalated) return;
    this.escalated = true;

    if (this.preBuffer.length === 0) return;

    const held = this.preBuffer;
    this.preBuffer = [];

    this.sink(
      this.build(LogLevel.INFO, `--- ${trigger} raised: escalating to DEBUG, replaying ${held.length} buffered line(s) ---`),
    );
    for (const line of held) {
      this.sink({ ...line, replayed: true });
    }
  }
}

/**
 * The run logger of this process (composeServices registers it), so the entry wrapper (app/sheetGuardExit.ts
 * runEntryMain) can log the run's totals as the last line: "run finished" with the exit code and the run-wide
 * WARNING / ERROR / CRITICAL counts. One per process; the last registered wins.
 */
let processRunLogger: Logger | null = null;

export function registerRunLogger(log: Logger): void { processRunLogger = log; }

/** Logs the run's totals on the registered run logger (no-op when none). */
export function logRunTotals(exitCode: number): LogCounts | null {
  const log = processRunLogger;
  if (!log) return null;
  const c = log.runCounts();
  log.info('run finished', { exit: exitCode, warning: c.warning, error: c.error, critical: c.critical });
  return c;
}

const ERROR_MARK = /❌/;
const WARNING_MARK = /^\s*(?:⚠️|⚠|🚫)/;
const FAILURE_WORDS = /\b(?:failed|could not|cannot be|not sent)\b/i;
const ZERO_FAILURES = /\b0 failed\b|\bfailed[=:]\s*0\b/i;

/** The level a legacy-style plain message implies: '❌' = ERROR; a leading '⚠️' or a failure phrase = WARNING; else INFO. */
export function levelOfText(m: string): 'info' | 'warning' | 'error' {
  if (ERROR_MARK.test(m)) return 'error';
  if (WARNING_MARK.test(m) || (FAILURE_WORDS.test(m) && !ZERO_FAILURES.test(m))) return 'warning';
  return 'info';
}

/**
 * docs/LOGGING_SPEC.md: the `log: (message) => void` callback the ported jobs take (macro, dark pool, options, paper,
 * live, My Options, the report builders), leveled by the message itself, so their failure lines are WARNING / ERROR
 * in the run log (and escalate the scope) instead of INFO.
 */
export function textLog(log: Logger): (m: string) => void {
  return (m: string) => { log[levelOfText(String(m))](String(m)); };
}
