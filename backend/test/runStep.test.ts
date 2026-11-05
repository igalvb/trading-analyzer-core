import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { Logger, type LogLine } from '../src/core/logger.ts';
import { runStep, skipStep } from '../src/core/runStep.ts';
import { reportSentence } from '../src/core/result.ts';
import { StepState, buildDisclosure } from '../src/core/status.ts';

function testCtx(): { ctx: ReturnType<typeof createContext>; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const ctx = createContext({
    mode: 'test',
    logger: new Logger({ sink: (l) => lines.push(l), scope: 'test' }),
    sleep: async () => {},          // no real waiting
    random: () => 0,                // deterministic jitter
    backoffBaseMs: 1,
  });
  return { ctx, lines };
}

const FAIL_MSG = reportSentence('Test data unavailable.');

test('a successful step returns its value and records OK', async () => {
  const { ctx } = testCtx();
  const r = await runStep(ctx, { key: 'k', label: 'Thing', onFailure: FAIL_MSG }, async () => 42);
  assert.ok(r.ok);
  assert.equal(r.value, 42);
  assert.equal(ctx.status.get('k')?.state, StepState.OK);
});

test('a transient failure is retried', async () => {
  const { ctx } = testCtx();
  let calls = 0;
  const r = await runStep(ctx, { key: 'k', label: 'Flaky', onFailure: FAIL_MSG }, async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
    return 'recovered';
  });
  assert.ok(r.ok);
  assert.equal(calls, 2);
});

test('a permanent failure is NOT retried', async () => {
  const { ctx } = testCtx();
  let calls = 0;
  const r = await runStep(ctx, { key: 'k', label: 'Gone', onFailure: FAIL_MSG }, async () => {
    calls++;
    throw Object.assign(new Error('not found'), { status: 404 });
  });
  assert.ok(!r.ok);
  assert.equal(calls, 1, 'retrying a 404 is pure waste');
  assert.equal(r.error.kind, 'permanent');
});

test("retry: 'never' suppresses retries even for transient failures", async () => {
  const { ctx } = testCtx();
  let calls = 0;
  await runStep(ctx, { key: 'k', label: 'Once', onFailure: FAIL_MSG, retry: 'never' }, async () => {
    calls++;
    throw Object.assign(new Error('boom'), { status: 503 });
  });
  assert.equal(calls, 1);
});

test('an unknown failure retries once (the stated fallback policy)', async () => {
  const { ctx } = testCtx();
  let calls = 0;
  await runStep(ctx, { key: 'k', label: 'Weird', onFailure: FAIL_MSG }, async () => {
    calls++;
    throw new Error('something unclassifiable');
  });
  assert.equal(calls, 2);
});

test('a timeout is enforced and classified transient', async () => {
  const { ctx } = testCtx();
  const r = await runStep(
    ctx,
    { key: 'k', label: 'Hangs', onFailure: FAIL_MSG, timeoutMs: 10, retry: 'never' },
    () => new Promise((resolve) => setTimeout(() => resolve('too late'), 5000)),
  );
  assert.ok(!r.ok);
  assert.equal(r.error.kind, 'transient');
});

test('F-B7-2: retryAfterTimeout false = a timed-out attempt is not run again beside itself; other failures still retry', async () => {
  const { ctx } = testCtx();
  let started = 0;
  const r = await runStep(
    ctx,
    { key: 'k', label: 'Hangs', onFailure: FAIL_MSG, timeoutMs: 10, maxAttempts: 3, retryAfterTimeout: false },
    () => { started++; return new Promise((resolve) => setTimeout(() => resolve('too late'), 200)); },
  );
  assert.ok(!r.ok);
  assert.equal(started, 1, 'one attempt only');
  let tries = 0;
  const r2 = await runStep(
    ctx,
    { key: 'k2', label: 'Flaky', onFailure: FAIL_MSG, timeoutMs: 1000, maxAttempts: 3, retryAfterTimeout: false },
    async () => { tries++; if (tries < 2) throw new Error('ECONNRESET'); return 'ok'; },
  );
  assert.ok(r2.ok);
  assert.equal(tries, 2, 'a non-timeout failure is still retried');
  let again = 0;
  await runStep(
    ctx,
    { key: 'k3', label: 'Hangs by default', onFailure: FAIL_MSG, timeoutMs: 10, maxAttempts: 2 },
    () => { again++; return new Promise((resolve) => setTimeout(() => resolve('x'), 200)); },
  );
  assert.equal(again, 2, 'default unchanged: a timeout is retried');
});

test('failure records the curated sentence, and disclosure never leaks internal detail', async () => {
  const { ctx } = testCtx();
  const r = await runStep(
    ctx,
    { key: 'fundamentals', label: 'Fundamentals', onFailure: FAIL_MSG, retry: 'never' },
    async () => {
      throw new Error('ECONNRESET socket hang up at internal/stream.js:412');
    },
  );
  assert.ok(!r.ok);

  const block = buildDisclosure(ctx.status);
  assert.equal(block.severity, 'partial');
  assert.deepEqual(block.lines, [FAIL_MSG]);
  const rendered = block.lines.join(' ');
  assert.ok(!rendered.includes('ECONNRESET'), 'raw error text must never reach report output');
  assert.ok(!rendered.includes('internal/stream.js'));
});

test('a failure escalates the log and replays the preceding DEBUG lines', async () => {
  const { ctx, lines } = testCtx();
  await runStep(ctx, { key: 'k', label: 'Doomed', onFailure: FAIL_MSG, retry: 'never' }, async () => {
    throw new Error('nope');
  });
  // runStep logs "step start" at DEBUG before calling fn, so that line must
  // have been buffered and then replayed when the error fired.
  assert.ok(lines.some((l) => l.replayed && l.message.includes('step start')));
});

test('disclosure is clean when every step succeeded', async () => {
  const { ctx } = testCtx();
  await runStep(ctx, { key: 'a', label: 'A', onFailure: FAIL_MSG }, async () => 1);
  assert.ok(ctx.status.isClean());
  assert.equal(buildDisclosure(ctx.status).severity, 'ok');
});

test('a late-failing step still appears in disclosure (the legacy ordering bug)', async () => {
  const { ctx } = testCtx();
  await runStep(ctx, { key: 'early', label: 'Early', onFailure: FAIL_MSG }, async () => 1);

  // In the legacy code the banner rendered here, before later statuses were
  // set -- which is why four model failures never reached the dashboard.
  await runStep(ctx, { key: 'late', label: 'Late model', onFailure: reportSentence('Late model unavailable.'), retry: 'never' }, async () => {
    throw new Error('boom');
  });

  const block = buildDisclosure(ctx.status);
  assert.ok(block.lines.some((l) => l.includes('Late model')), 'a step that failed after others must still be disclosed');
});

test('skipStep records a skip with its reason', () => {
  const { ctx } = testCtx();
  skipStep(ctx, { key: 'opt', label: 'Options' }, reportSentence('Options data was not requested for this run.'));
  assert.equal(ctx.status.get('opt')?.state, StepState.SKIPPED);
  assert.equal(buildDisclosure(ctx.status).severity, 'partial');
});

test('forTicker gives an isolated log scope but a SHARED status accumulator', async () => {
  const { ctx } = testCtx();
  const a = ctx.forTicker('AAPL');
  await runStep(a, { key: 'aapl.price', label: 'AAPL price', onFailure: FAIL_MSG }, async () => 1);
  assert.equal(ctx.status.get('aapl.price')?.state, StepState.OK, 'status is run-wide, rendered once at the end');
  assert.equal(a.log.scope, 'test:AAPL');
});
