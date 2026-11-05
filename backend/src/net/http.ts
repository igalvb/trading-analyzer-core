/**
 * The ONLY place in this codebase that calls fetch(). Replaces Apps
 * Script's UrlFetchApp (60 references in the legacy files).
 *
 * ══ WHAT IS KEPT FROM URLFETCHAPP, ON PURPOSE ════════════════════════
 * `muteHttpExceptions` keeps its Apps Script default: unmuted, a 4xx/5xx
 * THROWS (HttpStatusError). Legacy code's try/catch control flow depends on
 * exactly which calls throw, so the default is not "improved". Network
 * errors throw too; redirects are followed (UrlFetchApp's default).
 *
 * ══ WHAT IS ADDED ═══════════════════════════════════════════════════
 * - A per-request timeout (default 60 s). Apps Script could not bound an
 *   in-flight fetch at all -- the legacy code's hasTimeBudgetV7_ gates
 *   existed only to avoid STARTING one late. Per the user's decision those
 *   budget checks are replaced by this; every gated branch keeps its logic.
 * - Bounded concurrency per host, via the existing ConcurrencyLimiter
 *   (SEC hosts capped at 3 -- the documented 18-concurrent throttling
 *   failure at dataLayerV1.gs:819-825).
 * - A per-host User-Agent override. SEC requires a real contact; the
 *   legacy placeholders ('Mozilla/5.0 research@example.com',
 *   'BrokerCourseModelV1 research contact@example.com') become
 *   secUserAgent(SEC_CONTACT_EMAIL), per the user's explicit approval.
 * - Row 34: inside a step that hit its time limit (cancel.ts), no new
 *   request starts and a live request in flight is aborted.
 * - Pluggable transports: live, recording, replay. Replay is how the fetch
 *   layer is verified (sub-plan tier 3): real responses recorded once,
 *   API keys scrubbed, replayed byte-identically into BOTH the port and
 *   the oracle (test/gasFakes.ts replayUrlFetchApp shares ExchangeBook).
 */

import { ConcurrencyLimiter, HOST_CONCURRENCY, DEFAULT_MAX_CONCURRENCY } from '../sheets/limiter.ts';
import { TimeoutError } from '../core/errors.ts';
import { currentSignal, throwIfCancelled } from '../core/cancel.ts';

export interface HttpRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly payload?: string;
  readonly contentType?: string;
  /** Apps Script's flag, with its default: false means a 4xx/5xx throws. */
  readonly muteHttpExceptions?: boolean;
  readonly timeoutMs?: number;
}

/** getResponseCode() -> status; getContentText() -> text(); getBlob().getBytes() -> bytes(). */
export class HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  private readonly body: Uint8Array;

  constructor(status: number, body: Uint8Array, headers: Readonly<Record<string, string>> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }

  text(): string {
    return new TextDecoder('utf-8').decode(this.body);
  }

  bytes(): Uint8Array {
    return this.body.slice();
  }
}

/** Thrown for an unmuted 4xx/5xx, as UrlFetchApp does. The URL is scrubbed. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string) {
    super(`Request failed for ${url} returned code ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.url = url;
  }
}

export interface HttpTransport {
  send(req: HttpRequest): Promise<HttpResponse>;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

export class LiveTransport implements HttpTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const step = currentSignal();
    const signal = step ? AbortSignal.any([ac.signal, step]) : ac.signal;
    try {
      const headers: Record<string, string> = { ...(req.headers ?? {}) };
      if (req.contentType) headers['Content-Type'] = req.contentType;
      const res = await this.fetchImpl(req.url, {
        method: req.method ?? 'GET', headers, body: req.payload, signal, redirect: 'follow',
      });
      // The body read is inside the timeout too: a server that sends
      // headers and then stalls is still cut off.
      const body = new Uint8Array(await res.arrayBuffer());
      const h: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        h[k] = v;
      });
      return new HttpResponse(res.status, body, h);
    } catch (e) {
      if (step?.aborted) throw step.reason;
      if (ac.signal.aborted) throw new TimeoutError(timeoutMs, scrubUrl(req.url));
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Replaces API-key values in a URL. The legacy code passes keys only as
 * `apikey=` (FMP, AlphaVantage -- either case), `token=` (Finnhub) and
 * `key=` (Gemini, which carries its key in the query string).
 * String-level on purpose: re-serialising through URL would re-encode
 * characters and change the replay key.
 */
export function scrubUrl(url: string): string {
  // Telegram puts the bot key in the path: /bot<key>/method.
  return url.replace(/([?&](?:apikey|token|key)=)[^&#]*/gi, '$1REDACTED').replace(/(\/bot)\d+:[A-Za-z0-9_-]+/g, '$1REDACTED');
}

export interface RecordedResponse {
  readonly status: number;
  readonly bodyBase64: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RecordedExchange {
  /** `payload`: the request body, for POSTs (FINRA's queries differ only in their bodies). */
  readonly request: { readonly method: string; readonly url: string; readonly payload?: string };
  readonly response: RecordedResponse;
}

export function exchangeKey(method: string | undefined, url: string, payload?: string): string {
  return (method ?? 'GET').toUpperCase() + ' ' + scrubUrl(url) + (payload ? ' ' + payload : '');
}

export class ReplayMissError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`no recorded response for ${key}`);
    this.name = 'ReplayMissError';
    this.key = key;
  }
}

/**
 * A set of recorded exchanges, looked up by method + scrubbed URL (+ the
 * request body, when there is one). Repeat
 * requests for one URL replay in recorded order, the last one repeating.
 * An unrecorded request throws -- a replay must never silently fall back.
 *
 * Each consumer needs its OWN book (cursors are per book): construct one
 * for the port's ReplayTransport and another for the oracle's
 * replayUrlFetchApp from the same exchanges.
 */
export class ExchangeBook {
  private readonly byKey = new Map<string, RecordedResponse[]>();
  private readonly cursor = new Map<string, number>();
  readonly misses: string[] = [];

  constructor(exchanges: readonly RecordedExchange[]) {
    for (const x of exchanges) {
      const key = exchangeKey(x.request.method, x.request.url, x.request.payload);
      const list = this.byKey.get(key) ?? [];
      list.push(x.response);
      this.byKey.set(key, list);
    }
  }

  next(method: string | undefined, url: string, payload?: string): RecordedResponse {
    const key = exchangeKey(method, url, payload);
    const list = this.byKey.get(key);
    if (!list) {
      this.misses.push(key);
      throw new ReplayMissError(key);
    }
    const i = this.cursor.get(key) ?? 0;
    this.cursor.set(key, i + 1);
    return list[Math.min(i, list.length - 1)];
  }
}

export function decodeBody(r: RecordedResponse): Uint8Array {
  return new Uint8Array(Buffer.from(r.bodyBase64, 'base64'));
}

export class ReplayTransport implements HttpTransport {
  private readonly book: ExchangeBook;
  constructor(book: ExchangeBook) {
    this.book = book;
  }
  async send(req: HttpRequest): Promise<HttpResponse> {
    const r = this.book.next(req.method, req.url, req.payload);
    return new HttpResponse(r.status, decodeBody(r), r.headers ?? {});
  }
}

/** Wraps a live transport and records every exchange, URL scrubbed as it goes. */
export class RecordingTransport implements HttpTransport {
  private readonly inner: HttpTransport;
  private readonly recorded: RecordedExchange[] = [];

  constructor(inner: HttpTransport) {
    this.inner = inner;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.inner.send(req);
    this.recorded.push({
      request: { method: (req.method ?? 'GET').toUpperCase(), url: scrubUrl(req.url), ...(req.payload ? { payload: req.payload } : {}) },
      response: { status: res.status, bodyBase64: Buffer.from(res.bytes()).toString('base64'), headers: res.headers },
    });
    return res;
  }

  exchanges(): readonly RecordedExchange[] {
    return this.recorded;
  }
}

/**
 * Refuses to let a recording that contains a secret be saved. URL scrubbing
 * is not enough on its own: some providers echo the key back in an error
 * body. Pass the real key values; anything shorter than 6 characters is
 * ignored as too generic to search for.
 */
export function assertNoSecrets(exchanges: readonly RecordedExchange[], secrets: readonly string[]): void {
  const live = secrets.filter((s) => s && s.length >= 6);
  for (const x of exchanges) {
    const haystack = x.request.url + '\n' + (x.request.payload ?? '') + '\n' + Buffer.from(x.response.bodyBase64, 'base64').toString('utf8');
    for (const s of live) {
      if (haystack.includes(s)) throw new Error(`recording for ${x.request.method} ${x.request.url} contains a secret; refusing to save it`);
    }
  }
}

export const SEC_HOSTS: readonly string[] = ['www.sec.gov', 'data.sec.gov', 'efts.sec.gov'];

/** Phase 1's ceilings plus EDGAR full-text search, which shares SEC's limits. */
export const FETCH_HOST_CONCURRENCY: Readonly<Record<string, number>> = { ...HOST_CONCURRENCY, 'efts.sec.gov': 3 };

export const SEC_CONTACT_EMAIL_ENV = 'SEC_CONTACT_EMAIL';

/** The legacy 'Mozilla/5.0 <contact>' format, with a real contact. */
export function secUserAgent(contactEmail: string): string {
  return 'Mozilla/5.0 ' + contactEmail;
}

export function secUserAgents(contactEmail: string): Readonly<Record<string, string>> {
  const ua = secUserAgent(contactEmail);
  return Object.fromEntries(SEC_HOSTS.map((h) => [h, ua]));
}

function withHeader(headers: Readonly<Record<string, string>> | undefined, name: string, value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() !== name.toLowerCase()) out[k] = v;
  out[name] = value;
  return out;
}

export interface HttpClientOptions {
  readonly transport: HttpTransport;
  readonly limiter?: ConcurrencyLimiter;
  readonly userAgentByHost?: Readonly<Record<string, string>>;
}

export class HttpClient {
  private readonly transport: HttpTransport;
  readonly limiter: ConcurrencyLimiter;
  private readonly userAgentByHost: Readonly<Record<string, string>>;

  constructor(opts: HttpClientOptions) {
    this.transport = opts.transport;
    this.limiter = opts.limiter ?? new ConcurrencyLimiter(DEFAULT_MAX_CONCURRENCY, FETCH_HOST_CONCURRENCY);
    this.userAgentByHost = opts.userAgentByHost ?? {};
  }

  /** UrlFetchApp.fetch, under the per-host limiter and User-Agent policy. */
  async fetch(req: HttpRequest): Promise<HttpResponse> {
    const host = new URL(req.url).hostname;
    const ua = this.userAgentByHost[host];
    const sent: HttpRequest = ua ? { ...req, headers: withHeader(req.headers, 'User-Agent', ua) } : req;
    throwIfCancelled();
    const res = await this.limiter.run(host, () => {
      throwIfCancelled(); // the step may have been cancelled while this waited for a slot
      return this.transport.send(sent);
    });
    if (!req.muteHttpExceptions && res.status >= 400) throw new HttpStatusError(res.status, scrubUrl(req.url));
    return res;
  }

  /**
   * fetchAllOrSequentialV1_ (dataLayerV1.gs:735-741). Legacy tried
   * UrlFetchApp.fetchAll, and if ANY request threw, re-ran all of them one
   * by one, mapping each throw to null. The observable result -- a
   * response or null per request, in order -- is what this returns, with
   * the requests run concurrently under the limiter instead of in a
   * single unbounded batch. Verified against the oracle on the same
   * recordings, muted and unmuted.
   */
  async fetchAll(requests: readonly HttpRequest[]): Promise<Array<HttpResponse | null>> {
    if (!requests.length) return [];
    return Promise.all(requests.map(async (req) => {
      try {
        return await this.fetch(req);
      } catch {
        return null;
      }
    }));
  }
}
