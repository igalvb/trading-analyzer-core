/**
 * The run's FULL log file (owner 2026-11-04: "everything with proper logs"): every line at every level,
 * DEBUG included, unfiltered by escalation, so the uploaded artifact has everything. The console (stderr,
 * the live Actions log) stays INFO+ with escalation as before.
 *
 *   RUN_LOG_FILE=out/nightly.log   set by each workflow; unset = no file (tests, local runs)
 *
 * The file is appended to, never truncated: one workflow step may run several processes into the same file
 * (send-exit.yml: --ai-status, ai, send-exit), and several loggers in one process share one descriptor. Each
 * workflow starts on a fresh runner, so the file holds that run only. Known secret values and key=... query parameters are replaced by
 * *** before a line is written. Writing never fails the run: a file that cannot be opened is reported once on
 * stderr and the run goes on without it.
 *
 * processLine(): one formatted line for the places that have no Logger yet or any more (the entry wrapper's
 * crash handler, the profile check at import): stderr plus the run log file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { formatLine, LogLevel, type LogLine, type LogSink } from './logger.ts';

export const RUN_LOG_FILE_ENV = 'RUN_LOG_FILE';

type Env = Readonly<Record<string, string | undefined>>;

const fds = new Map<string, number>();
const failedPaths = new Set<string>();

/** The full-log path from the environment (absolute), or null when RUN_LOG_FILE is not set. */
export function runLogFilePath(env: Env = process.env): string | null {
  const p = (env[RUN_LOG_FILE_ENV] ?? '').trim();
  return p ? path.resolve(p) : null;
}

/** Secrets and key-like query parameters out of one log line. */
export function redactLine(text: string, secrets: readonly string[] = []): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 6) t = t.split(s).join('***');
  return t
    .replace(/([?&](?:api_?key|apikey|token|access_token|key|secret|auth)=)[^&\s"']+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
}

function fdFor(file: string): number | null {
  const known = fds.get(file);
  if (known !== undefined) return known;
  if (failedPaths.has(file)) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    fds.set(file, fd);
    return fd;
  } catch (e) {
    failedPaths.add(file);
    process.stderr.write(formatLine({ ts: new Date().toISOString(), level: LogLevel.WARNING, scope: 'log', message: 'the full run log file could not be opened; the console log is still complete for INFO and above', data: { file, detail: String(e) } }) + '\n');
    return null;
  }
}

/** A sink appending every line it gets to `file` (formatLine, one per line), secrets redacted. Null when the file cannot be opened. */
export function fileSink(file: string, secrets: readonly string[] = []): LogSink | null {
  const fd = fdFor(path.resolve(file));
  if (fd === null) return null;
  return (line: LogLine) => { fs.writeSync(fd, redactLine(formatLine(line), secrets) + '\n'); };
}

/** The run's full-log sink (RUN_LOG_FILE), or undefined when none is configured or it cannot be opened. */
export function runLogSink(env: Env = process.env, secrets: readonly string[] = []): LogSink | undefined {
  const file = runLogFilePath(env);
  return file ? (fileSink(file, secrets) ?? undefined) : undefined;
}

/**
 * One line outside any Logger: stderr (INFO and above) and the run log file. Used where no run logger exists:
 * the entry wrapper's crash handler, the profile check at import time, the maintenance CLIs' crash handlers.
 */
export function processLine(level: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL', scope: string, message: string, data?: Record<string, unknown>, env: Env = process.env, write: (text: string) => void = (t) => { process.stderr.write(t); }): void {
  const line: LogLine = { ts: new Date().toISOString(), level: LogLevel[level], scope, message, ...(data ? { data } : {}) };
  write(redactLine(formatLine(line)) + '\n');
  const sink = runLogSink(env);
  if (sink) {
    try { sink(line); } catch { /* the stderr copy above is the record */ }
  }
}
