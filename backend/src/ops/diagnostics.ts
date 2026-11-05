/**
 * Two diagnostics from fullStockAnalysisV10_9.gs:
 *   testFMPStablePointInTimeFields_ :9695-9726 -- a one-off probe of FMP's
 *     /stable/income-statement for a filing date distinct from the fiscal
 *     period end. The key is injected (deps.fmpKey), the fetch is the
 *     injected HttpClient (muted, as legacy). Every log line is legacy's.
 *   backtestEngineV7_SKELETON :9728-9740 -- an intentional stub that throws;
 *     ported as is.
 * The key is only ever in the request URL, never in a log line this adds
 * (F-C8: legacy also logs the first 200/300 characters of FMP's response).
 */

export const FMP_INCOME_STATEMENT_URL = 'https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&limit=1&apikey=';

export interface FmpProbeDeps {
  readonly http: { fetch(req: { readonly url: string; readonly muteHttpExceptions: boolean }): Promise<{ readonly status: number; text(): string }> };
  readonly fmpKey: string;
  readonly log: (message: string) => void;
}

export async function testFMPStablePointInTimeFields(deps: FmpProbeDeps): Promise<void> {
  const url = FMP_INCOME_STATEMENT_URL + deps.fmpKey;
  try {
    const resp = await deps.http.fetch({ url, muteHttpExceptions: true });
    const code = resp.status;
    if (code !== 200) {
      deps.log('HTTP ' + code + ' -- could not reach the endpoint to check. Response: ' + resp.text().substring(0, 200));
      return;
    }
    const body = resp.text();
    const list = JSON.parse(body);
    if (!Array.isArray(list) || !list.length) {
      deps.log('Got a 200 but no usable data back. Raw response: ' + body.substring(0, 300));
      return;
    }
    const row = list[0];
    const hasFilingDate = row.fillingDate !== undefined;
    const hasAcceptedDate = row.acceptedDate !== undefined;
    deps.log('=== /stable/income-statement point-in-time field check ===');
    deps.log('Fiscal period end (date): ' + row.date);
    deps.log('fillingDate present: ' + hasFilingDate + (hasFilingDate ? ' (value: ' + row.fillingDate + ')' : ''));
    deps.log('acceptedDate present: ' + hasAcceptedDate + (hasAcceptedDate ? ' (value: ' + row.acceptedDate + ')' : ''));
    if (hasFilingDate || hasAcceptedDate) {
      deps.log('RESULT: CONFIRMED -- the stable endpoint carries a real filing date, distinct from the fiscal period-end date. Tier 2 can proceed on this data source.');
    } else {
      deps.log('RESULT: NOT CONFIRMED -- no filing/acceptance date field found. All fields present: ' + Object.keys(row).join(', '));
      deps.log('This means Tier 2 needs a different point-in-time source (e.g. pairing this endpoint with SEC EDGARs own filing index) -- see CHARACTERIZATION_PLAN.md Section 1, Tier 2.');
    }
  } catch (e) {
    deps.log('Error: ' + (e && e.message ? e.message : e));
  }
}

export interface BacktestOptions {
  readonly horizonBars?: number;
  readonly warmupBars?: number;
}

export function backtestEngineSkeleton(ticker: string, opts?: BacktestOptions | null): never {
  const o = opts || {};
  const HORIZON = o.horizonBars || 20; // ~1 trading month
  const WARMUP = o.warmupBars || 220;  // enough for SMA200 + ADX warmup
  throw new Error(
    'backtestEngineV7_SKELETON is an intentional, documented stub. To implement: ' +
    '(1) fetch full daily history for ' + ticker + '; ' +
    '(2) walk i=' + WARMUP + '..n-' + HORIZON + '-1 rebuilding indicators from bars [0..i] with NO lookahead; ' +
    '(3) record the decision at each i; ' +
    '(4) score forward-return over ' + HORIZON + ' bars and aggregate hit-rate/avg-return by decision & conviction decile. ' +
    'Requires a historical data feed + Apps Script runtime — not runnable in the authoring environment.',
  );
}
