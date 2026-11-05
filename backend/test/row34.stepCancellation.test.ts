/**
 * Backlog row 34 (rest of F-B7-2): a step that hits its time limit is really cancelled. After the
 * timeout no new HTTP or Sheets request starts, and a request in flight is aborted. Steps that do
 * not time out behave as before.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { sheets_v4 } from 'googleapis';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import { reportSentence } from '../src/core/result.ts';
import { runStep } from '../src/core/runStep.ts';
import { CancelledError, currentSignal } from '../src/core/cancel.ts';
import { TimeoutError } from '../src/core/errors.ts';
import { HttpClient, HttpResponse, LiveTransport, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { SheetsClient } from '../src/sheets/client.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';
import { StepState } from '../src/core/status.ts';

const ctxOf = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const spec = (timeoutMs: number, extra: object = {}) => ({ key: 'slow', label: 'Slow step', onFailure: reportSentence('Slow step failed.'), retry: 'never' as const, timeoutMs, ...extra });

class CountingTransport implements HttpTransport {
  readonly sent: string[] = [];
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.sent.push(req.url);
    return new HttpResponse(200, new TextEncoder().encode('ok'));
  }
}

/** A Sheets API stand-in: counts calls, keeps the options, and can hold a call open until aborted. */
function fakeApi(holdMs = 0) {
  const calls: Array<{ signal?: AbortSignal }> = [];
  const batchGet = (_p: unknown, o: { signal?: AbortSignal } = {}) => {
    calls.push(o);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ data: { valueRanges: [{ values: [[1]] }] } }), holdMs);
      o.signal?.addEventListener('abort', () => { clearTimeout(t); reject(o.signal!.reason); });
    });
  };
  return { calls, api: { spreadsheets: { values: { batchGet } } } as unknown as sheets_v4.Sheets };
}

describe('row 34: a timed-out step is cancelled', () => {
  test('HTTP: no request starts after the timeout', async () => {
    const ctx = ctxOf();
    const transport = new CountingTransport();
    const http = new HttpClient({ transport });
    let late: unknown;
    const r = await runStep(ctx, spec(30), async () => {
      await http.fetch({ url: 'https://example.com/a' });
      await wait(80);
      try { await http.fetch({ url: 'https://example.com/b' }); } catch (e) { late = e; throw e; }
    });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.cause instanceof TimeoutError);
    await wait(100);
    assert.deepEqual(transport.sent, ['https://example.com/a']);
    assert.ok(late instanceof CancelledError);
  });

  test('HTTP: a live request in flight is aborted', async () => {
    const ctx = ctxOf();
    let seen: AbortSignal | undefined;
    const fetchImpl = ((_url: string, init: RequestInit) => new Promise((_res, reject) => {
      seen = init.signal ?? undefined;
      seen?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
    const http = new HttpClient({ transport: new LiveTransport(fetchImpl) });
    let thrown: unknown;
    const r = await runStep(ctx, spec(30), async () => {
      try { await http.fetch({ url: 'https://example.com/slow' }); } catch (e) { thrown = e; }
    });
    assert.equal(r.ok, false);
    await wait(10);
    assert.equal(seen?.aborted, true);
    assert.ok(thrown instanceof CancelledError, 'the work sees the cancellation, not the per-request timeout');
  });

  test('Sheets: no call starts after the timeout; the leftover inner step records no status', async () => {
    const ctx = ctxOf();
    const { calls, api } = fakeApi();
    const sheets = new SheetsClient({ spreadsheetId: 's', api });
    let second: unknown;
    const r = await runStep(ctx, spec(30), async () => {
      assert.equal((await sheets.batchGet(ctx, ['A1'])).ok, true);
      await wait(80);
      second = await sheets.batchGet(ctx, ['A2']);
    });
    assert.equal(r.ok, false);
    await wait(100);
    assert.equal(calls.length, 1);
    assert.equal(sheets.callCount(), 1);
    assert.equal((second as { ok: boolean }).ok, false);
    assert.equal(ctx.status.get('sheets.batchGet')?.state, StepState.OK, 'the cancelled read did not overwrite the status');
    assert.equal(ctx.status.get('slow')?.state, StepState.FAILED);
  });

  test('Sheets: a call in flight gets the step signal and is aborted', async () => {
    const ctx = ctxOf();
    const { calls, api } = fakeApi(10_000);
    const sheets = new SheetsClient({ spreadsheetId: 's', api });
    const r = await runStep(ctx, spec(30), async () => { await sheets.batchGet(ctx, ['A1']); });
    assert.equal(r.ok, false);
    await wait(20);
    assert.equal(calls.length, 1, 'the inner step did not retry the aborted call');
    assert.equal(calls[0].signal?.aborted, true);
  });

  test('Sheets: a limiter wait ends without taking a token or starting a call', async () => {
    const ctx = ctxOf();
    const { calls, api } = fakeApi();
    const limiter = new RateLimiter(1, 1 / 60, Date.now, (ms) => wait(Math.min(ms, 20)));
    const sheets = new SheetsClient({ spreadsheetId: 's', api, limiter });
    const r = await runStep(ctx, spec(50), async () => {
      await sheets.batchGet(ctx, ['A1']);
      await sheets.batchGet(ctx, ['A2']); // waits for a token past the time limit
    });
    assert.equal(r.ok, false);
    await wait(100);
    assert.equal(calls.length, 1);
    assert.equal(sheets.callCount(), 1);
  });

  test('a retry after a timeout runs alone: the first attempt is cancelled', async () => {
    const ctx = ctxOf();
    const transport = new CountingTransport();
    const http = new HttpClient({ transport });
    let attempt = 0;
    const r = await runStep(ctx, { ...spec(30), retry: 'always', maxAttempts: 2 }, async () => {
      const n = ++attempt;
      if (n === 1) await wait(80);
      await http.fetch({ url: 'https://example.com/' + n });
      return n;
    });
    assert.deepEqual(r, { ok: true, value: 2 });
    await wait(100);
    assert.deepEqual(transport.sent, ['https://example.com/2']);
  });
});

describe('row 34: steps that do not time out are unchanged', () => {
  test('requests run, the signal is never aborted, and outside a step there is no signal', async () => {
    const ctx = ctxOf();
    const transport = new CountingTransport();
    const http = new HttpClient({ transport });
    const { calls, api } = fakeApi();
    const sheets = new SheetsClient({ spreadsheetId: 's', api });
    assert.equal(currentSignal(), undefined);
    let inner: AbortSignal | undefined;
    const r = await runStep(ctx, spec(5_000), async (signal) => {
      inner = currentSignal();
      assert.equal(inner, signal);
      await http.fetch({ url: 'https://example.com/a' });
      const g = await sheets.batchGet(ctx, ['A1']);
      assert.ok(g.ok);
      return g.value;
    });
    assert.deepEqual(r, { ok: true, value: [[[1]]] });
    assert.equal(inner?.aborted, false);
    assert.equal(calls[0].signal?.aborted, false);
    assert.deepEqual(transport.sent, ['https://example.com/a']);
    // Work outside a step is never cancelled.
    await http.fetch({ url: 'https://example.com/b' });
    assert.equal(transport.sent.length, 2);
  });

  test('a failing step still retries as before', async () => {
    const ctx = ctxOf();
    let n = 0;
    const r = await runStep(ctx, { ...spec(5_000), retry: 'always', maxAttempts: 3 }, async () => {
      if (++n < 3) throw new Error('flaky');
      return n;
    });
    assert.deepEqual(r, { ok: true, value: 3 });
  });
});
