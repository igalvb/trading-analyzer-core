/**
 * Row 29 (owner 2026-10-27/31), clean policy 2026-11-05 (notify/policy.ts, docs/TELEGRAM_POLICY.md): the nightly to
 * Telegram is the Buy report and the Exit report as two PDFs and nothing else. The first PDF's caption is the bottom
 * line (nightlyCaption); its cover holds tonight's summary table (market regime, Buy Tier 1, Exit actions, the
 * paper-test leaders against QQQ and the research list held equally, data problems, the GitHub minutes line).
 * Nothing here computes a number: every value is read from what tonight's steps built.
 *
 * Never breaks the nightly: digestOf only reads, and sendNightlyDigest logs every failure (each page, each PDF);
 * it returns what was sent. With no PDF at all, one plain line says so.
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
import type { TelegramDeps } from '../../notify/telegram.ts';
import { bottomLine, notifyIfNeeded, sendPdfs, type PdfDoc } from '../../notify/policy.ts';
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

/** Action -> count over the Exit report's holdings, in the report's order (zero counts left out). */
export function exitActionCounts(input: ExitReportInput): Array<readonly [string, number]> {
  const counts = new Map<string, number>();
  for (const h of input.holdings) { const a = exitActionOf(h); counts.set(a, (counts.get(a) ?? 0) + 1); }
  return EXIT_ACTION_ORDER.filter((a) => counts.get(a)).map((a) => [a, counts.get(a) as number] as const);
}

/** "1 EXIT, 13 HOLD" (or "no holdings"). */
export const exitCountsText = (counts: ReadonlyArray<readonly [string, number]>): string => (counts.length ? counts.map(([a, n]) => n + ' ' + a).join(', ') : 'no holdings');

export function digestOf(o: { readonly day: string; readonly regime?: string | null; readonly capture: DigestCapture; readonly paper: PaperState | null; readonly summary: RunSummary | null }): DigestData {
  const exit = o.capture.exit;
  const exitActions: DigestData['exitActions'] = exit ? exitActionCounts(exit.input) : null;
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

/** The digest table (fixed width; on the first PDF's cover). `footer` lines go under it as they are (row 38: the GitHub minutes line). */
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
  /** HTML to PDF (headless Chrome); null = no browser: no PDF, one plain line says so. */
  readonly toPdf: ((html: string, pdfPath: string) => Promise<void>) | null;
  readonly log: (m: string) => void;
  readonly timeZone: string;
  readonly now: number;
  /** Where the PDFs are written (default: a new temp folder). */
  readonly outDir?: string;
  /** Plain lines under the summary on the first PDF's cover (row 38: the GitHub minutes line). */
  readonly footer?: readonly string[];
}

/** `message` = a plain line had to be sent instead (no PDF could be made); `pdfs` = the PDFs Telegram took. */
export interface DigestSent { readonly message: boolean; readonly pdfs: readonly string[] }

const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

/** The report's PDF page: a cover (with `lines`, e.g. tonight's summary) and the tab as drawn on the Sheet. Null when the tab is empty. */
export function reportPdfHtml(title: string, sheet: ReportSheet | null, timeZone: string, when: string, lines: readonly string[] = []): string | null {
  const section = sheet ? tabHtml(sheet, timeZone) : null;
  return section ? reportDocument({ title, subtitle: when + ' (New York time)', facts: [], lines }, [section], null) : null;
}

/** "5 Nov 2026" -> "5 Nov" (the caption is short; the year is on the PDF). */
const shortDay = (day: string): string => day.replace(/\s+\d{4}$/, '');

/**
 * The nightly's bottom line (the first PDF's caption, docs/TELEGRAM_POLICY.md):
 * "Nightly 5 Nov: 2 BUY · 1 EXIT, 13 HOLD · paper +1.2% (QQQ +0.8%)", and a second line only for data problems.
 */
export function nightlyCaption(d: DigestData): string {
  const buy = d.buyTier1 == null ? 'Buy not built' : d.buyTier1.length + ' BUY';
  const exit = d.exitActions == null ? 'Exit not built' : exitCountsText(d.exitActions);
  const best = d.paper?.leaders[0];
  const paper = best ? 'paper ' + best.ret + (d.paper?.qqq ? ' (QQQ ' + d.paper.qqq + ')' : '') : null;
  const problems = d.problems.length ? '⚠️ ' + d.problems.length + ' data problem(s): ' + d.problems.join('; ') : null;
  return bottomLine('Nightly ' + shortDay(d.day), [buy, exit, paper], problems);
}

/** The cover lines of the first PDF: tonight's summary table (what used to be the Telegram table) and the footer. */
export function digestCoverLines(d: DigestData, footer: readonly string[] = []): string[] {
  return ['Tonight', digestTable(d), ...(footer.length ? ['', ...footer] : [])];
}

/**
 * Sends the Buy and Exit PDFs; the first carries the bottom line as its caption and tonight's summary on its cover.
 * No text message. When no PDF can be made, ONE plain line (the bottom line and why). Every failure is logged; nothing throws.
 */
export async function sendNightlyDigest(d: DigestSendDeps, data: DigestData, capture: DigestCapture): Promise<DigestSent> {
  const tg = d.telegram;
  const when = new Date(d.now).toLocaleString('en-GB', { timeZone: d.timeZone, dateStyle: 'medium', timeStyle: 'short' });
  const caption = nightlyCaption(data);
  const cover = digestCoverLines(data, d.footer ?? []);
  const pages: Array<{ name: string; title: string; sheet: ReportSheet | null }> = [
    { name: 'v13-nightly-buy-' + stamp(d.now) + '.pdf', title: 'Buy Report', sheet: capture.buy?.sheet ?? null },
    { name: 'v13-nightly-exit-' + stamp(d.now) + '.pdf', title: 'Exit Strategy Report', sheet: capture.exit?.sheet ?? null },
  ];
  const docs: Array<{ name: string; title: string; html: string }> = [];
  for (const pg of pages) {
    const html = await Promise.resolve().then(() => reportPdfHtml(pg.title, pg.sheet, d.timeZone, when, docs.length ? [] : cover))
      .catch((e: unknown) => { d.log('nightly digest: the ' + pg.title + ' page could not be drawn: ' + String(e)); return null; });
    if (html) docs.push({ name: pg.name, title: pg.title, html });
  }
  const fallback = async (why: string): Promise<DigestSent> => {
    const message = await notifyIfNeeded(tg, caption.replace('\n', ' · ') + ' · ⚠️ ' + why, d.log);
    return { message, pdfs: [] };
  };
  if (!docs.length) return fallback('no report PDF tonight (the reports were not built)');
  if (!d.toPdf) return fallback('PDFs not made (no browser)');
  const toPdf = d.toPdf;
  const dir = await Promise.resolve().then(() => { if (d.outDir) { fs.mkdirSync(d.outDir, { recursive: true }); return d.outDir; } return fs.mkdtempSync(path.join(os.tmpdir(), 'digest-')); })
    .catch((e: unknown) => { d.log('nightly digest: no folder for the PDFs: ' + String(e)); return null; });
  if (!dir) return fallback('PDFs not made (no folder)');
  const made: PdfDoc[] = [];
  for (const doc of docs) {
    const p = path.join(dir, doc.name);
    const bytes = await toPdf(doc.html, p).then(() => new Uint8Array(fs.readFileSync(p)), (e: unknown) => { d.log('nightly digest: ' + doc.title + ' PDF not made: ' + String(e)); return null; });
    if (bytes) made.push({ name: doc.name, bytes });
  }
  if (!made.length) return fallback('the report PDFs could not be made');
  const sent = await sendPdfs(tg, made, caption, (m) => d.log('nightly digest: ' + m + ' (PDF not sent)'));
  return { message: false, pdfs: sent };
}
