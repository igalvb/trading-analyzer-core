/**
 * FL-11a: `record` (backlog recordings R-A1 / R-N1). Offline: the "live" network under
 * the recorder is a fake that serves the saved price fixtures.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, ExchangeBook, ReplayTransport, type HttpRequest, type HttpTransport, type RecordedExchange } from '../src/net/http.ts';
import { recordMain, RECORD_USAGE } from '../src/record.ts';
import { main as cliMain } from '../src/cli.ts';

const ready = fixturesPresent();
const FAKE_KEY = 'fmpkey-0123456789';
const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York', FMP_API_KEY: FAKE_KEY };

/** Serves the chart fixtures; anything else is a 404. `leak` echoes the key in every 404 body. */
class FakeNet implements HttpTransport {
  readonly urls: string[] = [];
  private readonly bodies: Record<string, string>;
  private readonly leak: boolean;
  constructor(bodies: Record<string, string>, leak = false) { this.bodies = bodies; this.leak = leak; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.urls.push(req.url);
    const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(req.url);
    const t = m ? decodeURIComponent(m[1] as string) : null;
    if (t && this.bodies[t]) return new HttpResponse(200, new TextEncoder().encode(this.bodies[t]));
    return new HttpResponse(404, new TextEncoder().encode(this.leak ? 'bad key ' + FAKE_KEY : 'not found'));
  }
}

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'fl11a-record-'));
const quiet = { out: () => {}, err: () => {}, env: ENV };

describe('FL-11a — record (R-A1 / R-N1)', { skip: !ready && 'price fixtures missing' }, () => {
  test('usage errors save nothing', async () => {
    const dir = tmp();
    for (const argv of [[], ['analyze'], ['ai'], ['ticker', 'TSLA'], ['analyze', 'TSLA', '--out']]) {
      const err: string[] = [];
      assert.equal(await recordMain([...argv, ...(argv.includes('--out') ? [] : ['--out', dir])], { out: () => {}, err: (s) => { err.push(s); }, env: ENV }), 2, JSON.stringify(argv));
      assert.match(err.join(''), new RegExp(RECORD_USAGE.replace(/[|[\]]/g, '\\$&')));
    }
    assert.deepEqual(fs.readdirSync(dir), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('analyze: every exchange is saved, keys scrubbed, and the file replays to the same report', async () => {
    const dir = tmp();
    const clock = clockAfterFixtures();
    const net = new FakeNet(fixtureBodies());
    const out: string[] = [];
    assert.equal(await recordMain(['analyze', 'tsla', '--out', dir], { out: (s) => { out.push(s); }, err: () => {}, env: ENV }, { inner: net, clock }), 0);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0] as string, /^v13-recording-analyze-tsla-\d{8}\.json$/);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, files[0] as string), 'utf8')) as { name: string; argv: string[]; recordedAtMs: number; exitCode: number; exchanges: RecordedExchange[] };
    assert.equal(rec.name, 'analyze-tsla');
    assert.deepEqual(rec.argv, ['analyze', 'TSLA', '--no-ai']);
    assert.equal(rec.recordedAtMs, clock.now());
    assert.equal(rec.exitCode, 0);
    assert.equal(rec.exchanges.length, net.urls.length, 'one exchange per request');
    assert.ok(!JSON.stringify(rec).includes(FAKE_KEY), 'no key value anywhere in the file');
    assert.ok(net.urls.some((u) => u.includes(FAKE_KEY)), 'negative control: the live requests did carry the key');

    const replayOut: string[] = [];
    const book = new ExchangeBook(rec.exchanges);
    assert.equal(await cliMain(rec.argv, { out: (s) => { replayOut.push(s); }, err: () => {}, env: ENV }, { transport: new ReplayTransport(book), clock: { now: () => rec.recordedAtMs } }), 0);
    assert.deepEqual(book.misses, [], 'the replay asked for nothing the recording lacks');
    assert.equal(replayOut.join(''), out.join(''), 'replay prints the same report');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a recording that holds a key value is refused and not saved', async () => {
    const dir = tmp();
    const err: string[] = [];
    assert.equal(await recordMain(['analyze', 'TSLA', '--out', dir], { out: () => {}, err: (s) => { err.push(s); }, env: ENV }, { inner: new FakeNet(fixtureBodies(), true), clock: clockAfterFixtures() }), 1);
    assert.match(err.join(''), /Recording refused: .*contains a secret/);
    const refusal = err.join('').split('\n').find((l) => l.startsWith('Recording refused')) ?? '';
    assert.ok(refusal && !refusal.includes(FAKE_KEY), 'the refusal line does not print the key (the run log is scanned by the workflow)');
    assert.deepEqual(fs.readdirSync(dir), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ai (R-AI1): watchlist seeded, Buy report with Gemini only; the Gemini call is recorded with its key scrubbed', async () => {
    const dir = tmp();
    const GEMINI_KEY = 'gemini-fake-key-123456';
    const answer = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Plain summary for TSLA.' }] } }] });
    class GeminiNet extends FakeNet {
      override async send(req: HttpRequest): Promise<HttpResponse> {
        if (/generativelanguage/.test(req.url)) { this.urls.push(req.url); return new HttpResponse(200, new TextEncoder().encode(answer)); }
        return super.send(req);
      }
    }
    const net = new GeminiNet(fixtureBodies());
    assert.equal(await recordMain(['ai', 'TSLA', '--out', dir], { ...quiet, env: { ...ENV, GEMINI_API_KEY: GEMINI_KEY } }, { inner: net, clock: clockAfterFixtures() }), 0);
    const files = fs.readdirSync(dir);
    assert.match(files[0] as string, /^v13-recording-ai-tsla-\d{8}\.json$/);
    const raw = fs.readFileSync(path.join(dir, files[0] as string), 'utf8');
    const rec = JSON.parse(raw) as { seed: Record<string, unknown[][]>; aiEnv: Record<string, string>; exchanges: RecordedExchange[] };
    assert.deepEqual(rec.seed, { '🎯 Watchlist': [['Ticker'], ['TSLA']] });
    assert.equal(rec.aiEnv.BUY_OPUS, 'false');
    assert.ok(rec.exchanges.some((x) => /generativelanguage/.test(x.request.url)), 'the Gemini call is in the recording');
    assert.ok(net.urls.some((u) => u.includes(GEMINI_KEY)), 'negative control: the live call carried the key');
    assert.ok(!raw.includes(GEMINI_KEY) && !raw.includes(FAKE_KEY), 'no key value in the file');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('nightly: runs in memory mode and is saved under its own name', async () => {
    const dir = tmp();
    assert.equal(await recordMain(['nightly', '--out', dir], quiet, { inner: new FakeNet(fixtureBodies()), clock: clockAfterFixtures() }), 0);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0] as string, /^v13-recording-nightly-\d{8}\.json$/);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, files[0] as string), 'utf8')) as { argv: string[]; exchanges: unknown[] };
    assert.deepEqual(rec.argv, ['--memory']);
    assert.ok(rec.exchanges.length > 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
