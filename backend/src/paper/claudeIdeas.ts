/**
 * "🤖 Claude Ideas" (owner approved 2026-11-06): Claude's recommendations list, with NO money. Unlike '🤖 Claude Picks'
 * (paper/paperClaude.ts, real paper orders of the account "🤖 Claude, free choice"), an idea is never filled, sized or
 * scored: it is one dated row of what Claude would do with a ticker (BUY / WAIT / AVOID / SELL), where (entry zone),
 * the stop and target that make the idea wrong or done, the horizon and the reason. Rows are appended by
 * `npm run claude-idea` (src/claudeIdea.ts) to the protected reports tab CLAUDE_IDEAS_TAB; the Status cell starts as
 * "open" and is edited by hand to "closed: <outcome>" (e.g. "closed: target hit +12%"). The dashboard lists them in
 * the Paper tab (dashboard/data.ts parseIdeas), with tonight's close against the zone when one is known.
 *
 * Pure: the checks and the row; no I/O here.
 */

export const CLAUDE_IDEAS_TAB = '🤖 Claude Ideas';
export const CLAUDE_IDEAS_HEADER: readonly string[] = ['Date', 'Ticker', 'Kind', 'Idea', 'Entry zone', 'Stop', 'Target', 'Horizon', 'Reason', 'Status'];
export const IDEA_TYPES: readonly string[] = ['BUY', 'WAIT', 'AVOID', 'SELL'];
export type IdeaType = 'BUY' | 'WAIT' | 'AVOID' | 'SELL';
export const IDEA_KINDS: readonly string[] = ['stock', 'call'];
/** The Status a new row gets. */
export const IDEA_OPEN = 'open';
/** Longest Reason kept (one sentence or a short paragraph). */
export const IDEA_REASON_MAX = 600;

/** The idea as typed (strings), before the checks; date = "YYYY-MM-DD HH:MM" New York, added by the caller. */
export interface IdeaFields {
  readonly date: string; readonly ticker: string; readonly kind: string; readonly idea: string; readonly zone: string;
  readonly stop: string; readonly target: string; readonly horizon: string; readonly reason: string;
}

const TICKER = /^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z])?$/;
const NONE = /^(-|—|none|n\/a)?$/i;
const num = (x: string): number | null => { const t = x.trim().replace(/[$,\s]/g, ''); return t !== '' && /^\d+(\.\d+)?$/.test(t) ? Number(t) : null; };

/** "$120 – $130", "120-130", "120 to 130" or one price "125": [low, high]; null when it holds no price. */
export function parseIdeaZone(text: string): readonly [number, number] | null {
  const xs = [...String(text ?? '').replace(/,/g, '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((v) => Number.isFinite(v) && v > 0);
  if (!xs.length) return null;
  const a = xs[0] as number, b = (xs[1] ?? a) as number;
  return [Math.min(a, b), Math.max(a, b)];
}

/** The Status cell: open (empty or "open...") or closed, and the outcome after "closed". */
export function ideaStatusOf(text: string): { readonly open: boolean; readonly outcome: string } {
  const t = String(text ?? '').trim();
  const m = /^closed\b[\s:—–-]*(.*)$/i.exec(t);
  if (m) return { open: false, outcome: (m[1] as string).trim() };
  return { open: true, outcome: /^open\b/i.test(t) ? t.replace(/^open\b[\s:—–-]*/i, '') : t };
}

/** Checks one idea; ok = the tab row (CLAUDE_IDEAS_HEADER order, Status "open"), else one sentence why not. */
export function checkClaudeIdea(f: IdeaFields): { readonly ok: true; readonly row: readonly string[] } | { readonly ok: false; readonly why: string } {
  const ticker = f.ticker.trim().toUpperCase(), kind = f.kind.trim().toLowerCase() || 'stock', idea = f.idea.trim().toUpperCase();
  if (!TICKER.test(ticker)) return { ok: false, why: 'the ticker "' + f.ticker.trim() + '" is not a ticker (letters, up to 6, e.g. NVDA or BRK.B)' };
  if (!IDEA_KINDS.includes(kind)) return { ok: false, why: 'the kind must be stock or call, not "' + f.kind.trim() + '"' };
  if (!IDEA_TYPES.includes(idea)) return { ok: false, why: 'the idea must be BUY, WAIT, AVOID or SELL, not "' + f.idea.trim() + '"' };
  const zoneText = f.zone.trim(), zone = NONE.test(zoneText) ? null : parseIdeaZone(zoneText);
  if (!NONE.test(zoneText) && !zone) return { ok: false, why: 'the entry zone "' + zoneText + '" holds no price (e.g. "$120 - $130", or - for none)' };
  const stopText = f.stop.trim(), targetText = f.target.trim();
  const stop = NONE.test(stopText) ? null : num(stopText), target = NONE.test(targetText) ? null : num(targetText);
  if (!NONE.test(stopText) && (stop == null || stop <= 0)) return { ok: false, why: 'the stop "' + stopText + '" is not a price (a number, or - for none)' };
  if (!NONE.test(targetText) && (target == null || target <= 0)) return { ok: false, why: 'the target "' + targetText + '" is not a price (a number, or - for none)' };
  if (idea === 'BUY' && (!zone || stop == null || target == null)) return { ok: false, why: 'a BUY needs an entry zone, a stop and a target' };
  if ((idea === 'BUY' || idea === 'WAIT') && zone && stop != null && !(stop < zone[0])) return { ok: false, why: 'the stop $' + stop + ' must be below the entry zone ($' + zone[0] + ' - $' + zone[1] + ')' };
  if ((idea === 'BUY' || idea === 'WAIT') && zone && target != null && !(target > zone[1])) return { ok: false, why: 'the target $' + target + ' must be above the entry zone ($' + zone[0] + ' - $' + zone[1] + ')' };
  const horizon = f.horizon.trim(), reason = f.reason.trim().replace(/\s+/g, ' ');
  if (!horizon) return { ok: false, why: 'the horizon is missing (e.g. "3-6 months")' };
  if (horizon.length > 60) return { ok: false, why: 'the horizon is longer than 60 characters' };
  if (!reason) return { ok: false, why: 'the reason is missing' };
  if (reason.length > IDEA_REASON_MAX) return { ok: false, why: 'the reason is longer than ' + IDEA_REASON_MAX + ' characters' };
  const zoneCell = zone ? (zone[0] === zone[1] ? '$' + zone[0] : '$' + zone[0] + ' - $' + zone[1]) : '-';
  return { ok: true, row: [f.date, ticker, kind, idea, zoneCell, stop == null ? '-' : String(stop), target == null ? '-' : String(target), horizon, reason, IDEA_OPEN] };
}
