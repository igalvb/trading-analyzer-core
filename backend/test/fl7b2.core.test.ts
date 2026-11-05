/**
 * FL-7a-2b: fetchStep on the one report catalog (src/reports/messages/catalog.ts).
 * Replaces test/fl7a2.core.test.ts, whose own catalog (core/messages.ts) was folded
 * into the report catalog.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { LogLevel, type LogLine } from '../src/core/logger.ts';
import { Logger } from '../src/core/logger.ts';
import { TimeoutError } from '../src/core/errors.ts';
import { dataQualityLine, REASON_CODES, EFFECTS, type EffectCode } from '../src/reports/messages/catalog.ts';
import { findReportLeaks } from '../src/reports/messages/leakScan.ts';
import { STATUS_SUBJECTS, qualityFor } from '../src/core/messages.ts';
import { fetchStep, reasonFromSignal } from '../src/core/fetchStep.ts';
import { TappingTransport } from '../src/net/httpTap.ts';
import { HttpClient, HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';

const NOW = new Date('2026-10-24T20:00:00Z');
const quiet = (lines: LogLine[] = []) => createContext({
  mode: 'test', logger: new Logger({ minLevel: LogLevel.DEBUG, sink: (l) => { lines.push(l); } }), backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {},
  clock: { now: () => NOW.getTime() },
});

class Script implements HttpTransport {
  private i = 0;
  private readonly steps: Array<number | Error>;
  constructor(steps: Array<number | Error>) { this.steps = steps; }
  async send(_req: HttpRequest): Promise<HttpResponse> {
    const s = this.steps[Math.min(this.i++, this.steps.length - 1)];
    if (s instanceof Error) throw s;
    return new HttpResponse(s, new TextEncoder().encode(s === 200 ? '{"ok":1}' : 'Limit Reach'));
  }
}

describe('FL-7a-2b — data-quality subjects on the report catalog', () => {
  test('every subject x reason line is clean report text', () => {
    for (const code of REASON_CODES) {
      for (const [key, s] of Object.entries(STATUS_SUBJECTS)) {
        assert.ok(s.effect in EFFECTS, key);
        const line = dataQualityLine(qualityFor(key, code, NOW).item);
        assert.deepStrictEqual(findReportLeaks(line), [], line);
        assert.match(line, /^(Note|Warning): /);
        const saved = dataQualityLine(qualityFor(key, code, NOW, { savedDate: new Date('2026-10-12T15:00:00Z'), effect: 'USES_SAVED_DATA' as EffectCode }).item);
        assert.deepStrictEqual(findReportLeaks(saved), [], saved);
      }
    }
    assert.equal(
      dataQualityLine(qualityFor('fundamentals', 'PROVIDER_NO_RESPONSE', NOW, { savedDate: new Date('2026-10-12T15:00:00Z'), effect: 'USES_SAVED_DATA' }).item),
      'Warning: Fundamentals from Oct 12, 12 days old, used because the data provider did not respond. The score uses the saved data.',
    );
  });

  test('reasonFromSignal', () => {
    const ev = (status: number | null, extra: Partial<{ error: string; timedOut: boolean }> = {}) => ({ method: 'GET', url: 'u', status, error: extra.error ?? null, timedOut: !!extra.timedOut, ms: 1 });
    assert.equal(reasonFromSignal([ev(429)], null), 'RATE_LIMIT');
    assert.equal(reasonFromSignal([ev(503)], null), 'PROVIDER_NO_RESPONSE');
    assert.equal(reasonFromSignal([ev(null, { error: 'x', timedOut: true })], null), 'PROVIDER_NO_RESPONSE');
    assert.equal(reasonFromSignal([ev(404)], null), 'NO_DATA_FOR_TICKER');
    assert.equal(reasonFromSignal([], new TimeoutError(5, 'x')), 'PROVIDER_NO_RESPONSE');
    assert.equal(reasonFromSignal([], new SyntaxError('Unexpected token')), 'RESPONSE_UNREADABLE');
  });
});

describe('FL-7a-2b — fetchStep', () => {
  test('parity: one call, a throw propagates, null stays null', async () => {
    let n = 0;
    const deps = { ctx: quiet(), parity: true };
    assert.deepStrictEqual(await fetchStep(deps, { key: 'price', source: 's' }, async () => { n++; return null; }), { ok: true, value: null, attempts: 1 });
    await assert.rejects(fetchStep(deps, { key: 'price', source: 's' }, async () => { n++; throw new Error('boom'); }), /boom/);
    assert.equal(n, 2);
  });

  test('production: a throw is retried 3 times, every attempt logged with the real error; the item is plain', async () => {
    const lines: LogLine[] = [];
    let n = 0;
    const r = await fetchStep({ ctx: quiet(lines) }, { key: 'spyRS', source: 'Yahoo chart SPY' }, async () => { n++; throw new TimeoutError(100, 'yahoo'); });
    assert.equal(n, 3);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'PROVIDER_NO_RESPONSE');
    assert.equal(dataQualityLine(r.quality.item), 'Warning: S&P 500 comparison: The data provider did not respond. Treat the result with less confidence.');
    const msgs = lines.map((l) => l.message);
    assert.ok(msgs.includes('Yahoo chart SPY failed (attempt 1 of 3): step "yahoo" exceeded its 100ms limit'));
    assert.ok(msgs.some((m) => m.startsWith('Yahoo chart SPY gave up')));
  });

  test('production: a null is retried only when the HTTP tap saw a provider failure; keys are scrubbed in the log', async () => {
    const lines: LogLine[] = [];
    const ctx = quiet(lines);
    const tap = new TappingTransport(new Script([429, 429, 200]), { log: ctx.log });
    const http = new HttpClient({ transport: tap });
    let n = 0;
    const r = await fetchStep({ ctx, tap }, { key: 'fundamentals', source: 'FMP' }, async () => { n++; const res = await http.fetch({ url: 'https://x.test/q?apikey=SECRET', muteHttpExceptions: true }); return res.status === 200 ? 'data' : null; });
    assert.deepStrictEqual([r.ok, r.value, n], [true, 'data', 3]);
    assert.ok(lines.every((l) => !l.message.includes('SECRET')));
    const tap2 = new TappingTransport(new Script([200]));
    const http2 = new HttpClient({ transport: tap2 });
    let m = 0;
    const r2 = await fetchStep({ ctx, tap: tap2 }, { key: 'darkPool', source: 'FINRA' }, async () => { m++; await http2.fetch({ url: 'https://x.test/' }); return null; });
    assert.equal(m, 1);
    assert.equal(r2.ok, false);
    if (!r2.ok) { assert.equal(r2.reason, 'NO_DATA_FOR_TICKER'); assert.equal(r2.attempts, 1); }
    assert.deepStrictEqual(await fetchStep({ ctx }, { key: 'x', source: 'x', onNull: 'accept' }, async () => null), { ok: true, value: null, attempts: 1 });
  });
});
