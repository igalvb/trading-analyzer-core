/**
 * The Nightly's advice-journal step (ledger/journal.ts; docs/LEDGER.md "The advice journal"), next to the ledger
 * snapshot (ledger/night.ts) and by the same profile key `storage.ledger`: 'off' = nothing at all; 'shadow' / 'on' =
 * tonight's advice is appended to ledger/journal.jsonl on the data branch folder (the workflow commits it with the
 * snapshot). Never throws: the caller wraps it (a journal problem never fails the night).
 *
 * Tonight's candidates, each turned into one journal line (selectNewEntries keeps only the new or changed ones):
 *   exit        the Exit report's table of contents (📤 Exit Report tab, dashboard/data.ts parseExitReport): EXIT, REVIEW
 *               (TRIM = EXIT, TARGET HIT = REVIEW), HOLD (written only right after an EXIT / REVIEW); NO VERDICT is left out
 *   buy         the Buy report's full ranking (🛒 Buy Report tab, parseBuyReport): BUY NOW = BUY (ADD when held),
 *               SET A BUY LIMIT = BUY_POINT, WAIT / WATCH = WAIT, AVOID, HOLD
 *   washout     tonight's Washout ADD alert hits (shown in the Buy report): ADD when held, else BUY_POINT
 *   marketShock the business alerts' market check when it fired: BUY_POINT for the market (never an exit)
 *   business    the business alerts' holdings with a trigger: ALERT
 *   eventCheck  tonight's event check (market and stocks): ALERT
 *   claudeIdea  the 🤖 Claude Ideas rows (BUY / WAIT / AVOID; SELL = EXIT), each once
 * Prices: tonight's close of the stock (an option: its underlying; the Exit report's own price for a stock) and of QQQ.
 */

import type { LedgerMode } from '../profile/schema.ts';
import type { TabCell } from '../storage/tabStore.ts';
import type { WashoutNight } from '../jobs/washout/washoutAlert.ts';
import type { EventNight } from '../jobs/washout/eventCheck.ts';
import type { BusinessAlertsResult } from '../jobs/exit/businessAlerts.ts';
import { TRIGGER_LABELS, MARKET_KEY } from '../jobs/exit/businessAlerts.ts';
import { parseExitReport, parseBuyReport, parseIdeas, reportRunTime, type DashExitItem, type DashBuyItem, type DashIdea } from '../dashboard/data.ts';
import { EXIT_SHEET_TAB, T as EXIT_TEXT } from '../reports/exitSheet/text.ts';
import { BUY_SHEET_TAB, T as BUY_TEXT } from '../reports/buySheet/text.ts';
import { CLAUDE_IDEAS_TAB, CLAUDE_IDEAS_HEADER } from '../paper/claudeIdeas.ts';
import { appendLedgerJsonl, readLedgerJsonl } from './store.ts';
import { LEDGER_FILES, type JournalAdvice, type LedgerJournalEntry } from './schema.ts';
import { JOURNAL_INDEX, makeJournalEntry, selectNewEntries, type JournalFields } from './journal.ts';
import fs from 'node:fs';
import path from 'node:path';

type Grid = readonly (readonly TabCell[])[];

export interface JournalNightDeps {
  readonly mode: LedgerMode;
  /** The data branch folder (ledger/store.ts dataBranchDir). */
  readonly root: string;
  /** 'YYYY-MM-DD', New York. */
  readonly today: string;
  /** ISO time of the run (each line's `at`). */
  readonly nowIso: string;
  /** A report tab's rows (null = missing). */
  readonly readTab: (tab: string, cols: number) => Promise<Grid | null>;
  /** Tonight's close of a ticker; null when unknown. */
  readonly close: (ticker: string) => Promise<number | null>;
  readonly washout?: () => Promise<WashoutNight | null>;
  readonly eventCheck?: () => Promise<EventNight | null>;
  /** Tonight's business alerts (null = off or not built). */
  readonly business?: () => BusinessAlertsResult | null;
  readonly info: (m: string) => void;
  readonly warn: (m: string) => void;
}

export interface JournalNightResult { readonly candidates: number; readonly added: number; readonly skipped: boolean }

/** The Exit report action as journal advice; null = not logged. */
export function exitAdviceOf(action: string): JournalAdvice | null {
  const a = action.toUpperCase().trim();
  if (a.startsWith('EXIT') || a.startsWith('TRIM')) return 'EXIT';
  if (a.startsWith('REVIEW') || a.startsWith('TARGET HIT')) return 'REVIEW';
  if (a.startsWith('HOLD')) return 'HOLD';
  return null;
}

/** The Buy report verdict (dashboard/data.ts verdictKeyOf) as journal advice; null = not logged. */
export function buyAdviceOf(item: Pick<DashBuyItem, 'verdict' | 'verdictKey'>): JournalAdvice | null {
  const held = /you hold this/i.test(item.verdict);
  switch (item.verdictKey) {
    case 'BUY NOW': return held ? 'ADD' : 'BUY';
    case 'SET A BUY LIMIT': case 'BUY LIMIT': return 'BUY_POINT';
    case 'WAIT': case 'WATCH': return 'WAIT';
    case 'AVOID': return 'AVOID';
    case 'HOLD': return 'HOLD';
    default: return null;
  }
}

const IDEA_ADVICE: Readonly<Record<string, JournalAdvice>> = { BUY: 'BUY', WAIT: 'WAIT', AVOID: 'AVOID', SELL: 'EXIT' };
const short = (s: string, n = 200): string => s.replace(/\s+/g, ' ').trim().slice(0, n);

export interface CandidateInput {
  readonly today: string;
  readonly exit: readonly DashExitItem[];
  readonly exitDay: string | null;
  readonly buy: readonly DashBuyItem[];
  readonly buyDay: string | null;
  readonly ideas: readonly DashIdea[];
  readonly washout: WashoutNight | null;
  readonly event: EventNight | null;
  readonly business: BusinessAlertsResult | null;
  /** Tonight's close by ticker (QQQ included). */
  readonly closes: ReadonlyMap<string, number>;
}

/** Tonight's journal candidates (pure), before the dedupe. A field that does not check out is left out. */
export function journalCandidates(c: CandidateInput, at: string): LedgerJournalEntry[] {
  const qqq = c.closes.get(JOURNAL_INDEX) ?? null;
  const px = (t: string | null): number | null => (t ? c.closes.get(t) ?? null : null);
  const out: LedgerJournalEntry[] = [];
  const push = (f: JournalFields): void => { const m = makeJournalEntry(f, at); if (m.ok) out.push(m.entry); };
  const exitDay = c.exitDay ?? c.today, buyDay = c.buyDay ?? c.today;
  for (const x of c.exit) {
    const advice = exitAdviceOf(x.action);
    if (!advice) continue;
    const option = x.kind === 'OPTION';
    const price = option ? px(x.ticker) : (x.detail?.price ?? px(x.ticker));
    push({
      date: exitDay, source: 'exit', ticker: x.ticker, advice, detail: short(x.action + (x.why ? ': ' + x.why.replace(/^\S+\s+—\s+/, '') : x.stopText ? ' · ' + x.stopText : '')),
      priceAtAdvice: price, qqqAtAdvice: qqq, horizon: '', refs: { ...(option ? { holding: x.holding } : {}), action: x.action, gain: x.gainText || null },
    });
  }
  for (const b of c.buy) {
    const advice = buyAdviceOf(b);
    if (!advice) continue;
    push({
      date: buyDay, source: 'buy', ticker: b.ticker, advice, detail: short(b.verdict + (b.zoneText ? ' · zone ' + b.zoneText : '') + (b.convictionText ? ' · conviction ' + b.convictionText : '')),
      priceAtAdvice: px(b.ticker), qqqAtAdvice: qqq, horizon: '', refs: { zone: b.zoneText || null, rank: b.rank },
    });
  }
  for (const h of c.washout?.hits ?? []) {
    push({ date: c.today, source: 'washout', ticker: h.ticker, advice: h.held ? 'ADD' : 'BUY_POINT', detail: short(h.line.replace(/^🟢\s*/, '')), priceAtAdvice: px(h.ticker), qqqAtAdvice: qqq, horizon: 'long-term', refs: { sig: 'W1', telegram: h.deduped ? 'not sent (sent within 10 trading days)' : 'sent' } });
  }
  const biz = c.business;
  if (biz) {
    if (biz.market.state === 'TRIGGERED') push({ date: c.today, source: 'marketShock', ticker: null, advice: 'BUY_POINT', detail: short('Market shock, a buy point (not an exit): ' + biz.market.text), priceAtAdvice: null, qqqAtAdvice: qqq, horizon: 'a year', refs: { sig: 'MARKET' } });
    for (const h of biz.holdings) {
      if (!h.triggered.length || h.ticker === MARKET_KEY) continue;
      const ids = h.triggered.map((t) => t.id).sort();
      push({ date: c.today, source: 'business', ticker: h.ticker, advice: 'ALERT', detail: short('Business alert (' + biz.mode + '): ' + h.triggered.map((t) => TRIGGER_LABELS[t.id] + ': ' + t.text).join('; ')), priceAtAdvice: px(h.ticker), qqqAtAdvice: qqq, horizon: '', refs: { sig: ids.join('+') } });
    }
  }
  const ev = c.event;
  if (ev) {
    const line = (x: { trigger: string; typeText: string; verdict: string; sizing: string }): string => short(x.trigger + ': ' + x.typeText + '; ' + x.verdict + '; ' + x.sizing);
    if (ev.market) push({ date: c.today, source: 'eventCheck', ticker: null, advice: 'ALERT', detail: line(ev.market), priceAtAdvice: null, qqqAtAdvice: qqq, horizon: '', refs: { sig: 'event' } });
    for (const s of ev.stocks) push({ date: c.today, source: 'eventCheck', ticker: s.subject, advice: 'ALERT', detail: line(s), priceAtAdvice: px(s.subject), qqqAtAdvice: qqq, horizon: '', refs: { sig: 'event' } });
  }
  for (const i of c.ideas) {
    const advice = IDEA_ADVICE[i.idea];
    if (!advice || !i.day) continue;
    const tonight = i.day === c.today;
    push({
      date: i.day, source: 'claudeIdea', ticker: i.ticker, advice, detail: short((i.zoneText ? 'zone ' + i.zoneText + '; ' : '') + i.reason), priceAtAdvice: tonight ? px(i.ticker) : null,
      qqqAtAdvice: tonight ? qqq : null, horizon: i.horizon, refs: { zone: i.zoneText || null, stop: i.stop, target: i.target, kind: i.kind },
    });
  }
  return out;
}

/** Appends tonight's new advice to ledger/journal.jsonl. */
export async function runJournalNight(d: JournalNightDeps): Promise<JournalNightResult> {
  if (d.mode === 'off') return { candidates: 0, added: 0, skipped: true };
  if (!fs.existsSync(path.join(d.root, 'ledger'))) {
    d.warn('advice journal (' + d.mode + '): no ledger folder on the data branch folder; nothing written');
    return { candidates: 0, added: 0, skipped: true };
  }
  const tab = async (name: string, cols: number): Promise<Grid | null> => d.readTab(name, cols).catch((e: unknown) => { d.warn('advice journal: the tab ' + name + ' could not be read (' + String(e instanceof Error ? e.message : e).slice(0, 120) + '); left out tonight'); return null; });
  const exitGrid = await tab(EXIT_SHEET_TAB, 12), buyGrid = await tab(BUY_SHEET_TAB, 12), ideasGrid = await tab(CLAUDE_IDEAS_TAB, CLAUDE_IDEAS_HEADER.length);
  const exit = parseExitReport(exitGrid), buy = parseBuyReport(buyGrid, new Map()), ideas = parseIdeas(ideasGrid, new Map());
  const washout = d.washout ? await d.washout().catch(() => null) : null;
  const event = d.eventCheck ? await d.eventCheck().catch(() => null) : null;
  const business = d.business ? d.business() : null;
  const tickers = new Set<string>([JOURNAL_INDEX, ...exit.map((x) => x.ticker), ...buy.map((b) => b.ticker), ...(washout?.hits ?? []).map((h) => h.ticker),
    ...(business?.holdings ?? []).filter((h) => h.triggered.length).map((h) => h.ticker), ...(event?.stocks ?? []).map((s) => s.subject), ...ideas.filter((i) => i.day === d.today).map((i) => i.ticker)]);
  const closes = new Map<string, number>();
  for (const t of tickers) { const p = await d.close(t).catch(() => null); if (p != null && Number.isFinite(p) && p > 0) closes.set(t, p); }
  const candidates = journalCandidates({
    today: d.today, exit, exitDay: reportRunTime(exitGrid, EXIT_TEXT.runLabel)?.day ?? null, buy, buyDay: reportRunTime(buyGrid, BUY_TEXT.runLabel)?.day ?? null,
    ideas, washout, event, business, closes,
  }, d.nowIso);
  const fresh = selectNewEntries(readLedgerJsonl(d.root, 'journal'), candidates);
  appendLedgerJsonl(d.root, 'journal', fresh);
  const by = new Map<string, number>();
  for (const e of fresh) by.set(e.source, (by.get(e.source) ?? 0) + 1);
  d.info('advice journal: ' + fresh.length + ' new line(s) of ' + candidates.length + ' advice tonight' + (fresh.length ? ' (' + [...by].map(([s, n]) => s + ' ' + n).join(', ') + ')' : '') + '; ' + LEDGER_FILES.journal);
  return { candidates: candidates.length, added: fresh.length, skipped: false };
}
