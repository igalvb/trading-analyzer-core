/**
 * checkApiKeysConfiguredV7 (fullStockAnalysisV10_9.gs:5529-5539).
 *
 * Legacy tested four hard-coded constants (:5311-5314), so it could only
 * ever fail if the file was edited. Here the keys live in the environment
 * (.env locally, repository secrets in CI), so the check is real: a key is
 * present when its variable is a non-empty string, exactly legacy's
 * truthiness test (F-C4: a placeholder or whitespace string also passes).
 * Only the NAMES of missing keys are logged, never a value.
 *
 * legacy alert -> deps.alert (legacy swallowed a missing UI, so does this).
 */

export const REQUIRED_API_KEY_ENV = ['FMP_API_KEY', 'ALPHAVANTAGE_KEY', 'FINNHUB_KEY', 'GEMINI_API_KEY'] as const;

export interface ApiKeyCheckDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (message: string) => void;
  readonly alert: (message: string) => void;
}

export interface ApiKeyCheck {
  readonly missing: readonly string[];
}

export function checkApiKeysConfigured(deps: ApiKeyCheckDeps): ApiKeyCheck {
  const missing = REQUIRED_API_KEY_ENV.filter((k) => !deps.env[k]);
  if (missing.length) {
    const msg = 'Missing keys: ' + missing.join(', ') + '.';
    deps.log('❌ ' + msg);
    try { deps.alert(msg); } catch (e) { /* fine if the host has no way to show it */ }
  } else {
    deps.log('✅ All 4 required API keys are present.');
  }
  return { missing };
}
