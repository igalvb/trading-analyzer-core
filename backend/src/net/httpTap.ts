/**
 * A transport wrapper that records every request's outcome and writes the
 * technical detail of each failure to the log: method, scrubbed URL, HTTP
 * status or exception text, duration. The fetch functions themselves keep
 * legacy's behaviour (most swallow a failure into null); this is how the
 * real error still reaches the log, and how a fetch step can tell a
 * provider outage from a ticker that has no data.
 */

import { scrubUrl, type HttpRequest, type HttpResponse, type HttpTransport } from './http.ts';
import { TimeoutError, messageOf } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';

export interface HttpEvent {
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly error: string | null;
  readonly timedOut: boolean;
  readonly ms: number;
}

export class TappingTransport implements HttpTransport {
  readonly events: HttpEvent[] = [];
  private readonly inner: HttpTransport;
  private readonly log: Logger | null;
  private readonly now: () => number;

  constructor(inner: HttpTransport, opts: { readonly log?: Logger | null; readonly now?: () => number } = {}) {
    this.inner = inner;
    this.log = opts.log ?? null;
    this.now = opts.now ?? (() => Date.now());
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const t0 = this.now();
    const method = req.method ?? 'GET';
    const url = scrubUrl(req.url);
    try {
      const res = await this.inner.send(req);
      const ev: HttpEvent = { method, url, status: res.status, error: null, timedOut: false, ms: this.now() - t0 };
      this.events.push(ev);
      if (res.status >= 400 && !isExpectedMiss(res.status, req.url)) this.log?.warning('HTTP ' + res.status + ' ' + method + ' ' + url, { ms: ev.ms, body: res.text().slice(0, 200) });
      else this.log?.debug('HTTP ' + res.status + ' ' + method + ' ' + url, { ms: ev.ms });
      return res;
    } catch (e) {
      const ev: HttpEvent = { method, url, status: null, error: messageOf(e), timedOut: e instanceof TimeoutError, ms: this.now() - t0 };
      this.events.push(ev);
      this.log?.warning('HTTP request failed ' + method + ' ' + url + ': ' + ev.error, { ms: ev.ms, timedOut: ev.timedOut });
      throw e;
    }
  }

  /** A position in the event list; since(mark) is everything after it. */
  mark(): number {
    return this.events.length;
  }

  since(mark: number): HttpEvent[] {
    return this.events.slice(mark);
  }
}

/**
 * A 404 from SEC XBRL companyconcept / companyfacts means "this company does not file that tag" (or has no XBRL
 * facts); fetch/sec/edgar.ts handles it by trying the fallback concepts. Expected, so it logs at DEBUG, not WARNING.
 * Every other host's 404 and every 5xx stay WARNING.
 */
export function isExpectedMiss(status: number, url: string): boolean {
  return status === 404 && /^https:\/\/data\.sec\.gov\/api\/xbrl\/(companyconcept|companyfacts)\//.test(url);
}

/** True when any request since the mark failed at the transport or HTTP level. */
export function anyFailed(events: readonly HttpEvent[]): boolean {
  return events.some((e) => e.error != null || (e.status != null && (e.status === 429 || e.status >= 500)));
}
