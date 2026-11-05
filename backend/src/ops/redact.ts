/**
 * Secret redaction for text that leaves the run (Telegram, prompts): the env's secret values first, then known key shapes.
 * Shared by verify.ts and watchdog.ts.
 */

/** Env names whose values never leave the run (tokens, keys, the service account, the sheet and chat ids). */
export const SECRET_NAME_RE = /TOKEN|KEY|SECRET|PASSWORD|JSON|SPREADSHEET_ID|CHAT_ID|WEBHOOK/i;
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /sk-ant-[A-Za-z0-9_-]+/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token
  /\/bot[^/\s]+\//g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /([?&](api_?key|apikey|token|key|access_token|secret)=)[^&\s"']+/gi,
  /("private_key(_id)?"\s*:\s*)"[^"]*"/g,
];

/** The text with every secret-looking value blanked: the env's secret values first, then the known key shapes. */
export function redactSecrets(text: string, env: Readonly<Record<string, string | undefined>> = {}): string {
  let out = text;
  const values = Object.entries(env)
    .filter(([k, v]) => SECRET_NAME_RE.test(k) && typeof v === 'string' && v.trim().length >= 8)
    .map(([, v]) => (v as string).trim())
    .sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join('[REDACTED]');
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m: string, p1?: string) => (typeof p1 === 'string' && m.startsWith(p1) && /[=:]\s*$/.test(p1) ? p1 + '[REDACTED]' : '[REDACTED]'));
  }
  return out;
}

