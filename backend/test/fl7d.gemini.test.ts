/**
 * FL-7D part 1: fetchGeminiReview against fetchGeminiReviewV7
 * (dataLayerV1.gs:119-283). The legacy call and the port get the same
 * generated inputs and the same recorded Gemini response; value, log lines,
 * the exact request (method, URL, body, content type), replay misses and
 * macro-regime calls must be deep-equal. The recorded request body comes
 * from a capture of what the ORACLE sent, so a prompt or payload drift in
 * the port is a replay miss, not a silent difference.
 *
 * Port-only cases (no oracle equivalent) are labelled as such: the no-key
 * branch (GEMINI_API_KEY is a non-writable const in the oracle), the
 * transport timeout, and key scrubbing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import {
  HttpClient, HttpResponse, LiveTransport, ReplayTransport, ExchangeBook, RecordingTransport, assertNoSecrets, scrubUrl,
  type HttpTransport, type RecordedExchange,
} from '../src/net/http.ts';
import { TimeoutError } from '../src/core/errors.ts';
import {
  fetchGeminiReview, geminiKeyFromEnv, stripStrayMarkdown, GEMINI_MODEL, GEMINI_ENDPOINT, type GeminiReviewDeps,
} from '../src/fetch/ai/geminiReview.ts';
import {
  genGeminiCase, GEMINI_SCENARIOS, geminiExchange, geminiBody, markdownFuzz, runOracleGemini, captureOracleGemini, legacyGeminiConst, traceKey, errMessage,
  type GeminiCase, type FetchBehavior, type Outcome,
} from './fl7dFixtures.ts';

const ready = legacyFilesPresent();
const LEGACY_FILE = path.join(LEGACY_DIR, 'dataLayerV1.gs');
const DUMMY_KEY = 'dummy-gemini-key+/=0123456789';

async function runPort(c: GeminiCase, behavior: FetchBehavior, apiKey: string, extra: Partial<GeminiReviewDeps> = {}): Promise<Outcome> {
  const trace: string[] = [];
  const logs: string[] = [];
  let macroCalls = 0;
  const book = new ExchangeBook(behavior.kind === 'replay' ? behavior.exchanges : []);
  const replay = new ReplayTransport(book);
  const transport: HttpTransport = {
    send: async (req) => {
      trace.push(traceKey(req.method, req.url, req.payload, req.contentType, req.muteHttpExceptions));
      if (behavior.kind === 'throw') throw behavior.value;
      return replay.send(req);
    },
  };
  let value: string | null | undefined;
  let threw: string | undefined;
  try {
    value = await fetchGeminiReview({
      http: new HttpClient({ transport }), apiKey,
      getMacroRegime: () => { macroCalls++; if (c.macroThrows) throw new Error(c.macroThrows); return c.macro; },
      log: (m) => { logs.push(m); }, ...extra,
    }, c.inputs);
  } catch (e) {
    threw = errMessage(e);
  }
  return { value, threw, logs, trace, misses: book.misses, macroCalls };
}

async function bothWays(c: GeminiCase, behavior: FetchBehavior): Promise<{ o: Outcome; p: Outcome }> {
  const o = runOracleGemini(c, behavior);
  const p = await runPort(c, behavior, legacyGeminiConst('GEMINI_API_KEY'));
  return { o, p };
}

function kindOf(o: Outcome): string {
  if (o.threw !== undefined) return 'threw';
  const first = o.logs[0] ?? '';
  if (o.value !== null && o.value !== undefined) return 'ok';
  if (first.startsWith('  Gemini HTTP ')) return 'http';
  if (first.startsWith('  Gemini: no candidate (blocked: ')) return 'blocked';
  if (first.startsWith('  Gemini: no candidate')) return 'no-candidate';
  if (first === '  Gemini: empty text') return 'empty';
  if (first.startsWith('  Gemini error: no recorded response')) return 'miss';
  if (first.startsWith('  Gemini error: ')) return 'parse-error';
  return 'other';
}

function reportOf(payload: string): Record<string, any> {
  const text: string = JSON.parse(payload).contents[0].parts[0].text;
  return JSON.parse(text.slice(text.indexOf('REPORT (JSON):\n') + 'REPORT (JSON):\n'.length));
}

async function inZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

describe('FL-7D — Gemini review vs fetchGeminiReviewV7', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('legacy boundaries: :119 opens the function, :283 closes it, :285 opens the next', () => {
    const lines = fs.readFileSync(LEGACY_FILE, 'utf8').split('\n');
    assert.ok(lines[118].startsWith('function fetchGeminiReviewV7(ticker, fundResult, techPlan, decision, ind, gann, confluence, fund, chart, optAnalysis, log, leapsCallArg, shortTermCallArg) {'));
    assert.equal(lines[282].trim(), '}');
    assert.equal(lines[283].trim(), '');
    assert.ok(lines[284].startsWith('function fetchYahooChartRaw_('));
    for (let i = 119; i < 282; i++) assert.ok(!/^function /.test(lines[i]), 'a second top-level function inside :120-:282 at line ' + (i + 1));
    assert.equal(legacyGeminiConst('GEMINI_MODEL'), GEMINI_MODEL);
    assert.match(legacyGeminiConst('GEMINI_API_KEY'), /PLACEHOLDER/, 'the oracle must hold a placeholder, never a real key');
  });

  test('80 generated cases: value, logs, request, misses and macro calls equal the oracle; coverage guards', async () => {
    const KEY = legacyGeminiConst('GEMINI_API_KEY');
    const kinds = new Map<string, number>();
    const presence = new Map<string, { present: number; absent: number }>();
    const mark = (k: string, present: boolean): void => {
      const e = presence.get(k) ?? { present: 0, absent: 0 };
      if (present) e.present++; else e.absent++;
      presence.set(k, e);
    };
    for (let seed = 0; seed < 80; seed++) {
      const c = genGeminiCase(seed);
      const sc = GEMINI_SCENARIOS[(seed * 7 + 3) % GEMINI_SCENARIOS.length];
      const cap = captureOracleGemini(c);
      assert.ok(cap, 'seed ' + seed + ': the legacy function must reach its fetch');
      const ex = sc.body === null ? [] : [geminiExchange(cap.url, cap.payload, sc.status, sc.body)];
      assertNoSecrets(ex, [KEY]);
      assert.ok(ex.every((x) => x.request.url.endsWith('?key=REDACTED')), 'recorded URLs must carry the redacted key');
      const { o, p } = await bothWays(c, { kind: 'replay', exchanges: ex });
      assert.deepStrictEqual(p, o, 'seed ' + seed + ' (' + sc.name + ')');
      assert.deepStrictEqual(p.trace, [traceKey('POST', cap.url, cap.payload, 'application/json', true)], 'the port sent what the oracle sent');
      assert.equal(p.macroCalls, 1);
      assert.ok(!JSON.stringify(p).includes(KEY), 'the key must not appear in any value, log or trace');

      const k = kindOf(p);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      const rep = reportOf(cap.payload);
      for (const key of ['secular', 'sectorStrength', 'macroBackdrop', 'macroRegime', 'insiderActivity', 'rateSensitivity', 'options', 'recommendedContract']) mark(key, key in rep);
      mark('recommendedContract.leaps', !!rep.recommendedContract?.leaps);
      mark('recommendedContract.shortTerm', !!rep.recommendedContract?.shortTerm);
      mark('insider:net buying', rep.insiderActivity === 'net buying');
      mark('insider:net selling', rep.insiderActivity === 'net selling');
      mark('canonicalRevenueGrowthPct', rep.fundamental.canonicalRevenueGrowthPct !== null);
      mark('drivers', rep.fundamental.drivers.length > 0);
      mark('fund-null', c.inputs.fund == null);
    }
    for (const k of ['ok', 'http', 'blocked', 'no-candidate', 'empty', 'miss', 'parse-error']) assert.ok((kinds.get(k) ?? 0) > 0, 'no case exercised outcome ' + k);
    assert.equal(kinds.get('other') ?? 0, 0);
    assert.equal(kinds.get('threw') ?? 0, 0);
    for (const [k, v] of presence) assert.ok(v.present > 0 && v.absent > 0, 'report branch ' + k + ' was not exercised both ways: ' + JSON.stringify(v));
    assert.equal(presence.size, 8 + 2 + 2 + 3);
  });

  test('malformed inputs throw the same error (the report is built outside legacy\'s try/catch) and send nothing', async () => {
    const base = genGeminiCase(3);
    const mk = (over: Record<string, unknown>): GeminiCase => ({ ...base, inputs: { ...base.inputs, ...over } as GeminiCase['inputs'] });
    const rich = genGeminiCase(11);
    const cases: Array<[string, GeminiCase]> = [
      ['chart null', mk({ chart: null })],
      ['fundResult null', mk({ fundResult: null })],
      ['techPlan null', mk({ techPlan: null })],
      ['decision null', mk({ decision: null })],
      ['ind null', mk({ ind: null })],
      ['drivers not an array', mk({ fundResult: { ...base.inputs.fundResult, drivers: 'abc' } })],
      ['a driver is null', mk({ fundResult: { ...base.inputs.fundResult, drivers: [null] } })],
      ['found pick without a contract', mk({ leapsCall: { found: true } })],
      ['short-term pick without a contract', mk({ shortTermCall: { found: true, contract: null } })],
      ['macro regime read throws', { ...base, macroThrows: 'regime cache exploded' }],
      ['unusable expiry does not throw', { ...rich, inputs: { ...rich.inputs, leapsCall: { found: true, contract: { strike: 1, expUnix: 'abc', delta: 0.3 } } } }],
    ];
    let threwCount = 0;
    for (const [name, c] of cases) {
      const { o, p } = await bothWays(c, { kind: 'replay', exchanges: [] });
      assert.deepStrictEqual(p, o, name);
      if (o.threw !== undefined) { threwCount++; assert.deepStrictEqual(p.trace, [], name + ': nothing is sent'); }
    }
    assert.equal(threwCount, 10, 'ten of the eleven cases must throw; the unusable-expiry one must not');
  });

  test('transport throws of every shape: same log, or the same TypeError from e.message', async () => {
    const c = genGeminiCase(5);
    const values: unknown[] = [new Error('socket hang up'), new Error('e'.repeat(200)), {}, null, 'plain string', { message: 'object with message' }];
    for (const value of values) {
      const { o, p } = await bothWays(c, { kind: 'throw', value });
      assert.deepStrictEqual(p, o, 'thrown ' + JSON.stringify(value));
    }
    const long = runOracleGemini(c, { kind: 'throw', value: new Error('e'.repeat(200)) });
    assert.equal(long.logs[0], '  Gemini error: ' + 'e'.repeat(80), 'the message is cut at 80 characters');
  });

  test('Markdown strip: 300 fuzzed texts through the full call, and the F-D3 leftover asterisk', async () => {
    const c = genGeminiCase(1);
    const cap = captureOracleGemini(c);
    assert.ok(cap);
    let changed = 0, leftoverStar = 0, kept = 0;
    for (const s of markdownFuzz(77, 300)) {
      const ex = [geminiExchange(cap.url, cap.payload, 200, geminiBody([{ text: s }]))];
      const { o, p } = await bothWays(c, { kind: 'replay', exchanges: ex });
      assert.deepStrictEqual(p, o, JSON.stringify(s));
      if (typeof p.value === 'string') {
        kept++;
        assert.equal(p.value, stripStrayMarkdown(s.trim()));
        if (p.value !== s.trim()) changed++;
        if (p.value.includes('*')) leftoverStar++;
      }
    }
    assert.ok(kept > 150 && changed > 100, 'kept=' + kept + ' changed=' + changed);
    assert.ok(leftoverStar > 0, 'F-D3: a trailing "x*" survives the strip');
    assert.equal(stripStrayMarkdown('**Hi** *x* `c`\n# H'), 'Hi x* c\nH');
  });

  test('an async macro-regime read gives the same request as a sync one', async () => {
    const c = genGeminiCase(8);
    assert.ok(c.macro && (c.macro as { available?: unknown }).available, 'seed 8 must carry an available regime');
    const cap = captureOracleGemini(c);
    assert.ok(cap);
    const ex = [geminiExchange(cap.url, cap.payload, 200, geminiBody([{ text: 'ok' }]))];
    const sync = await runPort(c, { kind: 'replay', exchanges: ex }, legacyGeminiConst('GEMINI_API_KEY'));
    let calls = 0;
    const asyncRun = await runPort(c, { kind: 'replay', exchanges: ex }, legacyGeminiConst('GEMINI_API_KEY'), { getMacroRegime: async () => { calls++; return c.macro; } });
    assert.equal(calls, 1);
    assert.deepStrictEqual(asyncRun.trace, sync.trace);
    assert.equal(asyncRun.value, 'ok');
  });

  test('F-D2: the expiry date is rendered in the PROCESS time zone, identically by port and oracle', async () => {
    const base = genGeminiCase(1);
    const c: GeminiCase = { ...base, macro: null, inputs: { ...base.inputs, leapsCall: { found: true, contract: { strike: 100, expUnix: Date.UTC(2027, 0, 15) / 1000, delta: 0.4 } }, shortTermCall: null } };
    const seen = new Set<string>();
    for (const tz of ['UTC', 'America/New_York', 'Asia/Jerusalem', 'Pacific/Kiritimati']) {
      await inZone(tz, async () => {
        const cap = captureOracleGemini(c);
        assert.ok(cap);
        const { o, p } = await bothWays(c, { kind: 'replay', exchanges: [geminiExchange(cap.url, cap.payload, 200, geminiBody([{ text: 'ok' }]))] });
        assert.deepStrictEqual(p, o, tz);
        seen.add(reportOf(cap.payload).recommendedContract.leaps.expiry);
      });
    }
    assert.deepStrictEqual([...seen].sort(), ['Thu Jan 14 2027', 'Fri Jan 15 2027'].sort(), 'the same expiry instant prints as two different dates');
    // The injection point: a pinned formatter replaces the process-zone default.
    const pinned = await runPort(c, { kind: 'replay', exchanges: [] }, legacyGeminiConst('GEMINI_API_KEY'), { formatExpiry: () => 'PINNED' });
    assert.ok(JSON.parse(pinned.trace[0].split(' | ')[2]).contents[0].parts[0].text.includes('"expiry":"PINNED"'));
  });

  test('port-only: no key logs "no API key", returns null, reads no input and sends nothing', async () => {
    const broken = { ...genGeminiCase(2), inputs: { ...genGeminiCase(2).inputs, chart: null } } as unknown as GeminiCase;
    for (const key of ['', undefined as unknown as string]) {
      const p = await runPort(broken, { kind: 'replay', exchanges: [] }, key);
      assert.deepStrictEqual(p, { value: null, threw: undefined, logs: ['  Gemini: no API key'], trace: [], misses: [], macroCalls: 0 });
    }
    assert.equal(geminiKeyFromEnv({}), '');
    assert.equal(geminiKeyFromEnv({ GEMINI_API_KEY: 'k-123456' }), 'k-123456');
  });

  test('port-only: an injected dummy key is URL-encoded on the wire and redacted in every recording', async () => {
    const c = genGeminiCase(4);
    const inner: HttpTransport = { send: async () => new HttpResponse(200, new TextEncoder().encode(geminiBody([{ text: 'fine' }]))) };
    const sent: string[] = [];
    const spy: HttpTransport = { send: async (req) => { sent.push(req.url); return inner.send(req); } };
    const rec = new RecordingTransport(spy);
    const logs: string[] = [];
    const value = await fetchGeminiReview({ http: new HttpClient({ transport: rec }), apiKey: DUMMY_KEY, getMacroRegime: () => c.macro, log: (m) => { logs.push(m); } }, c.inputs);
    assert.equal(value, 'fine');
    assert.equal(sent[0], GEMINI_ENDPOINT + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(DUMMY_KEY));
    assert.ok(sent[0].includes('%2B') && sent[0].includes('%2F') && sent[0].includes('%3D'));
    const recorded = rec.exchanges();
    assert.equal(recorded.length, 1);
    assert.ok(recorded[0].request.url.endsWith('?key=REDACTED'));
    assert.equal(recorded[0].request.method, 'POST');
    assert.doesNotThrow(() => assertNoSecrets(recorded, [DUMMY_KEY, encodeURIComponent(DUMMY_KEY)]));
    // Guard against a vacuous check: an unscrubbed copy must be refused.
    const leaky: RecordedExchange[] = [{ request: { method: 'POST', url: sent[0] }, response: recorded[0].response }];
    assert.throws(() => assertNoSecrets(leaky, [encodeURIComponent(DUMMY_KEY)]), /contains a secret/);
    assert.ok(!logs.join('\n').includes(DUMMY_KEY));
  });

  test('scrubUrl redacts key= (Gemini) as well as apikey= and token=, and only whole parameter names', () => {
    assert.equal(scrubUrl('https://g.test/m:generateContent?key=SECRET'), 'https://g.test/m:generateContent?key=REDACTED');
    assert.equal(scrubUrl('https://g.test/m?a=1&KEY=SECRET&b=2'), 'https://g.test/m?a=1&KEY=REDACTED&b=2');
    assert.equal(scrubUrl('https://g.test/m?monkey=banana&hotkey=x'), 'https://g.test/m?monkey=banana&hotkey=x');
    assert.equal(scrubUrl('https://x.test/a?apikey=S1&token=S2'), 'https://x.test/a?apikey=REDACTED&token=REDACTED');
  });

  test('port-only: model override, per-request timeout pass-through, and a real transport timeout', async () => {
    const c = genGeminiCase(6);
    const reqs: Array<{ url: string; timeoutMs?: number }> = [];
    const transport: HttpTransport = { send: async (req) => { reqs.push({ url: req.url, timeoutMs: req.timeoutMs }); return new HttpResponse(500, new TextEncoder().encode('no')); } };
    await fetchGeminiReview({ http: new HttpClient({ transport }), apiKey: 'k-123456', getMacroRegime: () => c.macro, model: 'gemini-test-model', timeoutMs: 1234 }, c.inputs);
    assert.equal(reqs[0].url, GEMINI_ENDPOINT + 'gemini-test-model:generateContent?key=k-123456');
    assert.equal(reqs[0].timeoutMs, 1234);

    const hang = ((_u: unknown, init: { signal: AbortSignal }) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(new Error('aborted'))); })) as unknown as typeof fetch;
    const logs: string[] = [];
    const value = await fetchGeminiReview({ http: new HttpClient({ transport: new LiveTransport(hang) }), apiKey: DUMMY_KEY, getMacroRegime: () => c.macro, timeoutMs: 20, log: (m) => { logs.push(m); } }, c.inputs);
    assert.equal(value, null);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].startsWith('  Gemini error: step "https://generativelanguage.googleapis.com/v1beta/models/'), logs[0]);
    assert.ok(!logs[0].includes(DUMMY_KEY));
    const err = new TimeoutError(20, scrubUrl('https://g.test/m?key=' + DUMMY_KEY));
    assert.ok(!err.message.includes(DUMMY_KEY), 'a timeout message built from the scrubbed URL carries no key');
  });
});
