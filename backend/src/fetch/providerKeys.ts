/**
 * API keys for the fundamentals providers -- injected configuration, never
 * part of the repository.
 *
 * Legacy hard-coded them as top-level constants
 * (fullStockAnalysisV10_9.gs:5311-5313; the frozen copy holds placeholders).
 * Here they come from the environment: `.env` locally, repository secrets in
 * CI, under the names `.env.example` already documents.
 *
 * An unset key is the empty string. Each call site keeps legacy's own guard
 * exactly: Alpha Vantage and Finnhub are skipped when their key is empty;
 * FMP has NO guard in legacy and is called with an empty `apikey=` (F-40).
 */

export interface ProviderKeys {
  readonly fmp: string;
  readonly alphaVantage: string;
  readonly finnhub: string;
}

export const PROVIDER_KEY_ENV = {
  fmp: 'FMP_API_KEY',
  alphaVantage: 'ALPHAVANTAGE_KEY',
  finnhub: 'FINNHUB_KEY',
} as const;

export function providerKeysFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ProviderKeys {
  return {
    fmp: env[PROVIDER_KEY_ENV.fmp] ?? '',
    alphaVantage: env[PROVIDER_KEY_ENV.alphaVantage] ?? '',
    finnhub: env[PROVIDER_KEY_ENV.finnhub] ?? '',
  };
}

/** The non-empty key values -- the list to hand assertNoSecrets before saving a recording. */
export function providerKeyValues(keys: ProviderKeys): string[] {
  return [keys.fmp, keys.alphaVantage, keys.finnhub].filter((k) => k !== '');
}
