/**
 * Row 29 (owner 2026-10-27/31): the nightly digest to Telegram. ONE short message, a table only (market regime, Buy
 * Tier 1, Exit actions, the paper-test leaders against QQQ and the research list held equally, data problems), then the Buy report
 * and the Exit report as two PDFs. Nothing here computes a number: every value is read from what tonight's steps built.
 *
 * Never breaks the nightly: digestOf only reads, and sendNightlyDigest catches every failure (message, each PDF) and
 * logs it; it returns what was sent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunSummary } from '../../jobs/nightly/summary.ts';
import type { BuyReportInput } from '../buySheet/types.ts';
import type { BuySheetResult } from '../buySheet/buySheet.ts';
import type { ExitReportInput } from '../exitSheet/types.ts';
import { exitActionOf, EXIT_ACTION_ORDER } from '../exitSheet/exitSheet.ts';
import type { ReportSheet } from '../../sheets/reportSheet.ts';
import { tabHtml, reportDocument } from '../pdf/workbookHtml.ts';
import { sendTable, sendDocument, type TelegramDeps } from '../../notify/telegram.ts';
import { standings, pctOf, type PaperState } from '../../paper/paperTrading.ts';
import { LABELS } from '../../profile/labels.ts';

/** What tonight's steps left for the digest (nightlyApp fills it through the jobs' onBuilt hooks). */
export interface DigestCapture {
  buy?: { readonly input: BuyReportInput; readonly result: BuySheetResult; readonly sheet: ReportSheet | null };
  exit?: { readonly input: ExitReportInput; readonly sheet: ReportSheet | null };
}

export interface DigestData {
  readonly day: string;
  /** RISK_ON / RISK_OFF / NEUTRAL (the market-wide regime), null when not read. */
  readonly regime: string | null;
  readonly eiPctStrong: number | null;
  /** null = the Buy report was not built tonight. */
  readonly buyTier1: readonly string[] | null;
  /** Action -> count, in the Exit report's order; null = the Exit report was not built tonight. */
  readonly exitActions: ReadonlyArray<readonly [string, number]> | null;
  readonly paper: { readonly leaders: ReadonlyArray<{ readonly name: string; readonly ret: string }>; readonly qqq: string | null; readonly list14: string | null } | null;
  /** Plain short items: stocks that did not finish or were partial, steps that failed. Empty = clean. */
  readonly problems: readonly string[];
}

const REGIME: Readonly<Record<string, string>> = { RISK_ON: 'Risk on', RISK_OFF: 'Risk off', NEUTRAL: 'Neutral' };
/** The yardsticks are found by their paper KEY, never by their label (labels come from the profile, GENERIC_PLAN P3). */
const QQQ_KEY = 'qqq';
const LIST14_KEY = 'lab.list14';

/** The paper test's top 3 accounts (benchmarks left out), and the two yardsticks: QQQ and the research list held equally. */
export function paperLine(state: PaperState | null, top = 3): DigestData['paper'] {
  if (!state) return null;
  const rows = standings(state);
  if (!rows.length) return null;
  const find = (k: string): string | null => { const r = rows.find((x) => x.key === k); return r ? pctOf(r.value) : null; };
  return { leaders: rows.filter((r) => !r.bench).slice(0, top).map((r) => ({ name: r.name, ret: pctOf(r.value) })), qqq: find(QQQ_KEY), list14: find(LIST14_KEY) };
}

/** Short problem items from the run summary (names only; the reasons are in the Sheet and the log). */
export function problemsOf(s: RunSummary | null): string[] {
  if (!s) return ['run did not finish'];
  const out: string[] = [];
  const names = (st: string): string[] => s.tickers.filter((t) => t.state === st).map((t) => t.ticker);
  const failed = names('failed'), partial = names('degraded'), skipped = names('skipped');
  if (failed.length) out.push('failed: ' + failed.join(', '));
  if (partial.length) out.push('partial: ' + partial.join(', '));
  if (skipped.length) out.push('not reached: ' + skipped.join(', '));
  for (const st of s.steps) if (st.state === 'failed' || st.state === 'degraded') out.push(st.label + (st.state === 'failed' ? ' failed' : ' partial'));
  return out;
}

export function digestOf(o: { readonly day: string; readonly regime?: string | null; readonly capture: DigestCapture; readonly paper: PaperState | null; readonly summary: RunSummary | null }): DigestData {
  const exit = o.capture.exit;
  let exitActions: DigestData['exitActions'] = null;
  if (exit) {
    const counts = new Map<string, number>();
    for (const h of exit.input.holdings) { const a = exitActionOf(h); counts.set(a, (counts.get(a) ?? 0) + 1); }
    exitActions = EXIT_ACTION_ORDER.filter((a) => counts.get(a)).map((a) => [a, counts.get(a) as number] as const);
  }
  return {
    day: o.day,
    regime: o.regime ?? null,
    eiPctStrong: exit?.input.advisory?.evaluativeIndexPctStrong ?? null,
    buyTier1: o.capture.buy ? [...o.capture.buy.result.tiers[1]] : null,
    exitActions,
    paper: o.paper ? paperLine(o.paper) : null,
    problems: problemsOf(o.summary),
  };
}

const LABEL_W = 9;
const VALUE_W = 26;

/** Value words wrapped to VALUE_W, continuation lines indented under the value column. */
function row(label: string, value: string): string[] {
  const words = value.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > VALUE_W) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  lines.push(cur);
  // A label as wide as the column (a profile's list name) still gets one space before its value.
  return lines.map((l, i) => (i === 0 ? (label.length >= LABEL_W ? label + ' ' : label.padEnd(LABEL_W)) : ' '.repeat(LABEL_W)) + l);
}

/** The digest table (fixed width; sent inside <pre>). `footer` lines go under it as they are (row 38: the GitHub minutes line). */
export function digestTable(d: DigestData, extra: readonly (readonly [string, string])[] = [], footer: readonly string[] = []): string {
  const out: string[] = [];
  const market = [d.regime ? (REGIME[d.regime] ?? d.regime) : 'not read', ...(d.eiPctStrong != null ? ['EI ' + d.eiPctStrong.toFixed(0) + '%'] : [])].join(' · ');
  out.push(...row('Market', market));
  out.push(...row('Buy T1', d.buyTier1 == null ? 'not built' : d.buyTier1.length ? d.buyTier1.join(', ') : 'none'));
  out.push(...row('Exit', d.exitActions == null ? 'not built' : d.exitActions.length ? d.exitActions.map(([a, n]) => n + ' ' + a).join(' · ') : 'no holdings'));
  if (!d.paper) out.push(...row('Paper', 'no data'));
  else {
    d.paper.leaders.forEach((l, i) => out.push(...row(i === 0 ? 'Paper' : '', l.ret + ' ' + l.name)));
    out.push(...row('QQQ', d.paper.qqq ?? '—'));
    out.push(...row(LABELS.List, d.paper.list14 ?? '—'));
  }
  if (!d.problems.length) out.push(...row('Data', 'OK'));
  else d.problems.forEach((p, i) => out.push(...row(i === 0 ? 'Data' : '', p)));
  for (const [k, v] of extra) out.push(...row(k, v));
  out.push(...footer);
  return out.join('\n');
}

export interface DigestSendDeps {
  readonly telegram: { readonly deps: TelegramDeps; readonly chatId: string };
  /** HTML to PDF (headless Chrome); null = no browser, the PDFs are left out (one table row says so). */
  readonly toPdf: ((html: string, pdfPath: string) => Promise<void>) | null;
  readonly log: (m: string) => void;
  readonly timeZone: string;
  readonly now: number;
  /** Where the PDFs are written (default: a new temp folder). */
  readonly outDir?: string;
  /** Plain lines under the table (row 38: the GitHub minutes line). */
  readonly footer?: readonly string[];
}

export interface DigestSent { readonly message: boolean; readonly pdfs: readonly string[] }

const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

/** The report's PDF page: a one-line cover and the tab as drawn on the Sheet. Null when the tab is empty. */
export function reportPdfHtml(title: string, sheet: ReportSheet | null, timeZone: string, when: string): string | null {
  const section = sheet ? tabHtml(sheet, timeZone) : null;
  return section ? reportDocument({ title, subtitle: when + ' (New York time)', facts: [], lines: [] }, [section], null) : null;
}

/** Sends the table, then the Buy and Exit PDFs. Every failure is logged; nothing throws. */
export async function sendNightlyDigest(d: DigestSendDeps, data: DigestData, capture: DigestCapture): Promise<DigestSent> {
  const tg = d.telegram;
  const when = new Date(d.now).toLocaleString('en-GB', { timeZone: d.timeZone, dateStyle: 'medium', timeStyle: 'short' });
  const docs: Array<{ name: string; caption: string; html: string }> = [];
  try {
    const buy = reportPdfHtml('Buy Report', capture.buy?.sheet ?? null, d.timeZone, when);
    if (buy) docs.push({ name: 'v13-nightly-buy-' + stamp(d.now) + '.pdf', caption: 'Buy Report', html: buy });
    const exit = reportPdfHtml('Exit Strategy Report', capture.exit?.sheet ?? null, d.timeZone, when);
    if (exit) docs.push({ name: 'v13-nightly-exit-' + stamp(d.now) + '.pdf', caption: 'Exit Strategy Report', html: exit });
  } catch (e) { d.log('nightly digest: the report pages could not be drawn: ' + String(e)); }
  const extra: Array<[string, string]> = docs.length && !d.toPdf ? [['PDFs', 'not made (no browser)']] : [];
  let message = false;
  try {
    await sendTable(tg.deps, tg.chatId, '🌙 Nightly ' + data.day, digestTable(data, extra, d.footer ?? []));
    message = true;
  } catch (e) { d.log('nightly digest: Telegram refused the message: ' + String(e)); }
  const sent: string[] = [];
  if (!d.toPdf || !docs.length) return { message, pdfs: sent };
  let dir = d.outDir;
  try {
    if (dir) fs.mkdirSync(dir, { recursive: true }); else dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  } catch (e) { d.log('nightly digest: no folder for the PDFs: ' + String(e)); return { message, pdfs: sent }; }
  for (const doc of docs) {
    const p = path.join(dir, doc.name);
    try {
      await d.toPdf(doc.html, p);
      await sendDocument(tg.deps, tg.chatId, doc.name, fs.readFileSync(p), 'application/pdf', doc.caption);
      sent.push(doc.name);
    } catch (e) { d.log('nightly digest: ' + doc.caption + ' PDF not sent: ' + String(e)); }
  }
  return { message, pdfs: sent };
}
