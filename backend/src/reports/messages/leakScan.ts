/**
 * Report leak scanner. Report text (anything written to a sheet) must be plain English: no URLs, HTTP codes,
 * exception text, stack lines, file paths or API keys. Technical detail belongs in the log only.
 */

interface LeakRule { readonly name: string; readonly re: RegExp; readonly keep?: (match: string) => boolean }

const STATUS_WORDS = '(?:status|code|error|returned|response|http)';

const RULES: readonly LeakRule[] = [
  { name: 'url', re: /https?:\/\/\S*/gi },
  { name: 'http-status', re: /\bHTTP[\s/]*\d{3}\b/gi },
  // A bare 3-digit status code (100-599) next to status/code/error words, in either order. Money and decimals are excluded.
  { name: 'status-code', re: new RegExp('\\b' + STATUS_WORDS + '\\b[^\\d$\\n]{0,12}\\b[1-5]\\d{2}\\b(?![\\d.,%/])', 'gi') },
  { name: 'status-code', re: new RegExp('(?<![\\d$.,/])\\b[1-5]\\d{2}\\b(?![\\d.,%/])\\s*(?:status|error)\\b', 'gi') },
  { name: 'error-label', re: /\berror\s*:/gi },
  { name: 'exception', re: /\b(?:Type|Reference|Range|Syntax|Eval|URI|Http\w*|Timeout)Error\b/g },
  { name: 'exception', re: /\bCannot read propert(?:y|ies)\b|\bis not a function\b|\bis not defined\b|\bunexpected token\b/gi },
  { name: 'placeholder', re: /\bundefined\b|\bNaN\b|\[object Object\]/g },
  { name: 'stack-line', re: /\bat\s+(?:[\w$.<>[\]]+\s+)?\(?[^\s()]*:\d+:\d+\)?/g },
  { name: 'key-param', re: /\b(?:apikey|api_key|key|token|access_token|secret)=/gi },
  { name: 'key-label', re: /\b(?:apikey|api_key|secret|password|bearer)\s*[:=]?\s*\S{6,}/gi, keep: (m) => /[0-9]/.test(m) },
  { name: 'hex-token', re: /\b[0-9a-f]{32,}\b/gi },
  { name: 'long-token', re: /[A-Za-z0-9+/_-]{32,}={0,2}/g, keep: (m) => /\d/.test(m) && /[A-Za-z]/.test(m) },
  { name: 'file-path', re: /(?:^|[\s(])\/(?:Users|home|var|tmp|etc|usr|opt|private|app)\/\S*/g },
  { name: 'file-path', re: /\b[A-Za-z]:\\[^\s]+/g },
  { name: 'file-path', re: /(?:^|[\s(])\.{1,2}\/[\w./-]+/g },
  { name: 'file-path', re: /\b(?:src|test|dist|node_modules)\/[\w./-]+/g },
  { name: 'file-path', re: /\b[\w-]+\.(?:ts|js|mjs|cjs|json|gs|env)(?::\d+)?\b/g },
];

/** Every leak found in one piece of report text, as 'rule: "matched text"'. An empty array means the text is clean. */
export function findReportLeaks(text: string): string[] {
  const out: string[] = [];
  const s = String(text);
  for (const rule of RULES) {
    for (const m of s.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
      const hit = m[0].trim();
      if (rule.keep && !rule.keep(hit)) continue;
      const entry = rule.name + ': "' + hit.slice(0, 60) + '"';
      if (!out.includes(entry)) out.push(entry);
    }
  }
  return out;
}

/**
 * For tests: scan every string cell of a ReportWorkbook-style grid (rows of cells). Throws one Error listing
 * every leaking cell (1-based row and column). Non-string cells are ignored, except Error objects, which always leak.
 */
export function assertNoReportLeaks(cells: readonly (readonly unknown[])[]): void {
  const problems: string[] = [];
  cells.forEach((row, r) => {
    row.forEach((cell, c) => {
      const where = 'R' + (r + 1) + 'C' + (c + 1);
      if (cell instanceof Error) { problems.push(where + ': an Error object was written to the report'); return; }
      if (typeof cell !== 'string') return;
      const leaks = findReportLeaks(cell);
      if (leaks.length) problems.push(where + ' ' + JSON.stringify(cell.slice(0, 80)) + ' -> ' + leaks.join('; '));
    });
  });
  if (problems.length) throw new Error('Report text leaks technical detail:\n' + problems.join('\n'));
}
