/**
 * F-B7-2: how a command-line entry ends. A step that hits its time limit is reported as failed.
 * Since row 34 its work is cancelled (core/cancel.ts: no new HTTP or Sheets request, requests in
 * flight aborted), but plain computation and other timers can still hold the process open. So,
 * as a backstop, once the run has printed its summary the process ends: after stdout and stderr
 * are flushed.
 */
export function finish(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const done = (): void => { if (--pending === 0) process.exit(code); };
  process.stdout.write('', done);
  process.stderr.write('', done);
}
