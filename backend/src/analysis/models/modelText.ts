/**
 * Plain-text options shared by the model-tab formatters (Schabacker, Edwards & Magee, Turtle, Broker Course).
 * Unset (the default) = legacy's exact text, which the parity tests pin; production passes plainText: true.
 */

import { ACCOUNT } from '../decision.ts';

export interface ModelTextOptions {
  /** D12-D15/D19/D20 fixes: plain words, readable dates, no repeated lines, stated account size. */
  readonly plainText?: boolean;
  /** The zone dates are printed in (default America/New_York). */
  readonly timeZone?: string;
}

/** D13: 'Sep 15, 2026' in `timeZone` (legacy printed Date#toString: 'Tue Sep 15 2026 16:30:00 GMT-0400 (...)'). */
export function shortDate(d: Date | number | string, timeZone = 'America/New_York'): string {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

/** D20: the account every sizing line assumes (decision.ts ACCOUNT.size, a fixed setting -- not the portfolio). */
export function assumedAccountText(): string {
  return 'of an assumed $' + ACCOUNT.size.toLocaleString('en-US') + ' account';
}

/** D14: the distinct items in first-seen order, each with how many times it appeared. */
export function countDistinct<T>(items: readonly T[], keyOf: (t: T) => string): Array<{ item: T; count: number }> {
  const out: Array<{ item: T; count: number }> = [];
  const at = new Map<string, number>();
  for (const it of items) {
    const k = keyOf(it);
    const i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push({ item: it, count: 1 }); } else out[i]!.count++;
  }
  return out;
}

/** D12: Schabacker's round-number read in words ({nearest, increment, distPct, near}). */
export function roundNumberText(r: unknown): string {
  const o = (r && typeof r === 'object' ? r : {}) as { nearest?: unknown; increment?: unknown; distPct?: unknown; near?: unknown };
  const nearest = typeof o.nearest === 'number' ? o.nearest : null;
  const dist = typeof o.distPct === 'number' ? o.distPct : null;
  if (nearest == null) return 'no round-number read';
  const inc = typeof o.increment === 'number' ? ' (a multiple of $' + o.increment.toLocaleString('en-US') + ')' : '';
  const away = dist != null ? ', ' + (Math.abs(dist) * 100).toFixed(1) + '% away' : '';
  return 'the nearest round number is $' + nearest.toLocaleString('en-US') + inc + away
    + (o.near ? ' -- close enough to act as support/resistance' : ' -- too far to act as a level now');
}
