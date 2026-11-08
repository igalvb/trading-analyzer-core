/**
 * `npm run nightly`: the nightly pipeline against the real spreadsheet
 * (.github/workflows/nightly.yml). Prints the plain run summary on stdout;
 * the technical log goes to stderr (the workflow keeps both in its artifact).
 * The run is wrapped in the Master Lock (app/sheetWrites.ts: unlock -> run -> lock again in a finally);
 * the workflow's own `npm run lock-sheets` step stays as the backstop for a killed process.
 *
 *   flags: --memory (no spreadsheet: a dry run on empty caches), --debug
 *   env:   NIGHTLY_TICKER_TIMEOUT_MS (default 10 minutes), NIGHTLY_DIGEST=off (no Telegram digest), plus compose.ts's settings
 * Row 29: after the run, the Telegram digest (the Buy and Exit PDFs only, the bottom line as the caption, tonight's
 * summary on the first PDF's cover; reports/digest/nightlyDigest.ts, notify/policy.ts), only against the real Sheet
 * and when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are set. Row 38: inside GitHub Actions the summary ends with the month's GitHub minutes (reports/digest/actionsMinutes.ts; GITHUB_TOKEN with `actions: read`). A digest failure is logged;
 * it never changes the run's exit status. On a Saturday night (New York) the paper test's weekly PDF goes too, once per
 * week (reports/paperWeekly.ts maybeSendPaperWeekly), right after the run and before the stores are flushed.
 *
 * Exit status: 0 when the run finished (even partly), 1 when every step failed or the run crashed.
 */

import { finish } from './core/finish.ts';
import { runEntryMain } from './app/sheetGuardExit.ts';
import { composeServices } from './compose.ts';
import type { HttpTransport } from './net/http.ts';
import { formatLine, LogLevel, textLog } from './core/logger.ts';
import { buildNightlyApp, type NightlyApp } from './app/nightlyApp.ts';
import { digestOf, sendNightlyDigest, type DigestSent } from './reports/digest/nightlyDigest.ts';
import { actionsMinutesLine, MINUTES_UNREADABLE } from './reports/digest/actionsMinutes.ts';
import { loadPaper } from './paper/paperJob.ts';
import { maybeSendPaperWeekly } from './reports/paperWeekly.ts';
import { findChrome, htmlToPdf } from './reports/pdf/chromePdf.ts';
import type { RunSummary } from './jobs/nightly/summary.ts';
import type { TabStore } from './storage/tabStore.ts';
import type { TelegramDeps } from './notify/telegram.ts';
import { runNightly, buildPlainSummary } from './jobs/nightly/nightly.ts';
import type { CliIo } from './cli.ts';
import { STD_IO } from './cli.ts';
import { withSheetWrites, isUnlockFailure, UNLOCK_FAILED_LINE } from './app/sheetWrites.ts';
import type { Services } from './compose.ts';
import { activeProfile } from './profile/active.ts';
import { orElseAsync } from './core/guard.ts';
import { formatDateInTz } from './core/dates.ts';
import { fetchYahooChartRaw } from './fetch/yahoo.ts';
import { dataBranchDir } from './ledger/store.ts';
import { runLedgerNight, type LedgerNightDeps } from './ledger/night.ts';
import { fetchCryptoPrices } from './ledger/cryptoPrices.ts';
import { runJournalNight, type JournalNightDeps } from './ledger/journalNight.ts';
import { sendWashoutAlerts } from './jobs/washout/washoutAlert.ts';
import { notifyIfNeeded, type TelegramTarget } from './notify/policy.ts';
import type { PropertyStore } from './storage/kv.ts';

export async function nightlyMain(argv: readonly string[], io: CliIo = STD_IO, over: { readonly transport?: HttpTransport; readonly clock?: { now(): number }; readonly initialTabs?: Record<string, unknown[][]> } = {}): Promise<number> {
  const flags = new Set(argv);
  const env = io.env ?? process.env;
  const s = await composeServices({
    storage: flags.has('--memory') ? 'memory' : 'sheets', env, mode: 'nightly', noAi: true,
    logLevel: flags.has('--debug') ? LogLevel.DEBUG : LogLevel.INFO, logSink: (l) => io.err(formatLine(l) + '\n'),
    ...(over.transport ? { transport: over.transport } : {}), ...(over.clock ? { clock: over.clock } : {}), ...(over.initialTabs ? { initialTabs: over.initialTabs } : {}),
  });
  const timeout = Number(env.NIGHTLY_TICKER_TIMEOUT_MS);
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim(), chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
  const digestOn = (env.NIGHTLY_DIGEST ?? '').trim().toLowerCase() !== 'off';
  let run;
  let built: NightlyApp | null = null;
  try {
    run = await withSheetWrites(s, async () => {
      const app = await buildNightlyApp(s, Number.isFinite(timeout) && timeout > 0 ? { tickerTimeoutMs: timeout } : {});
      built = app;
      const result = await runNightly(app.deps, app.options);
      // The paper test's weekly PDF (reports/paperWeekly.ts): Saturday nights only, once per week, after the paper step;
      // inside the Master Lock so the week's key in the property store is flushed with the run's.
      if (s.sheets && token && chatId && digestOn) {
        await maybeSendPaperWeekly({ store: s.tabStore, kv: s.kv, telegram: { deps: { token }, chatId }, toPdf: pdfMaker(env), log: textLog(s.ctx.log), now: s.clock.now(), timeZone: s.timeZone })
          .catch((e: unknown) => s.ctx.log.warning('paper weekly failed (the nightly result is unchanged)', { detail: String(e) }));
      }
      // The Washout ADD alert (profile alerts.washout): one Telegram line per new washout; silent otherwise. Inside the
      // Master Lock so the dedupe days in the property store are flushed with the run's.
      if (s.sheets && token && chatId) await runWashoutAlerts(app, s.kv, { deps: { token }, chatId }, textLog(s.ctx.log));
      await s.flushStores();
      return result;
    });
  } catch (e) {
    if (isUnlockFailure(e)) {
      s.ctx.log.critical('Master Lock: the sheets could not be unlocked, so the nightly did not run', { detail: String(e) });
      io.out(UNLOCK_FAILED_LINE + '\n');
      return 1;
    }
    throw e;
  }
  const summary = run.value;
  // docs/LEDGER.md phase 3: profile storage.ledger shadow / on (off = nothing at all). Never fails the night.
  if (built && activeProfile().storage.ledger !== 'off') {
    const app: NightlyApp = built;
    await orElseAsync(s.ctx.log, 'ledger night', () => runLedgerNight(ledgerNightDeps(s, app)), null);
    // The advice journal (ledger/journal.ts): tonight's new or changed advice, appended next to the snapshot.
    await orElseAsync(s.ctx.log, 'advice journal', () => runJournalNight(journalNightDeps(s, app)), null);
  }
  // F-B7-1: the Sheets quota (about 50 calls a minute) is what sets the run time; log the count every run.
  if (s.sheets) s.ctx.log.info('Sheets API calls this run: ' + [s.sheets, s.reportsSheets, s.dataSheets].reduce((n, c) => n + (c ? c.callCount() : 0), 0));
  io.out([...buildPlainSummary(summary), ...run.reportLines].join('\n') + '\n');
  if (built && s.sheets && token && chatId && digestOn) {
    const app: NightlyApp = built;
    await runNightlyDigest({
      app, summary, store: s.tabStore, timeZone: s.timeZone, now: s.clock.now(), log: textLog(s.ctx.log), warn: (m) => s.ctx.log.warning(m),
      regime: async () => { const m = await s.getMacro(); return m && m.regime ? String(m.regime) : null; },
      telegram: { deps: { token }, chatId },
      // Row 38: the GitHub Actions minutes line, only inside Actions (the workflow passes GITHUB_TOKEN / GITHUB_REPOSITORY).
      ...((env.GITHUB_ACTIONS ?? '') === 'true' || (env.GITHUB_TOKEN ?? '').trim() ? { minutesLine: () => actionsMinutesLine({ env, now: s.clock.now(), log: textLog(s.ctx.log) }) } : {}),
      toPdf: pdfMaker(env),
    });
  }
  return summary.overall === 'failed' ? 1 : 0;
}

/** The ledger night's inputs from the run's services: tonight's (cached) charts for stocks, Yahoo for crypto and USD/ILS. */
export function ledgerNightDeps(s: Services, app: Pick<NightlyApp, 'portfolio'>): LedgerNightDeps {
  const mode = activeProfile().storage.ledger;
  const lastOf = (c: { readonly closes: readonly number[] } | null | undefined): number | null => (c && c.closes.length ? (c.closes[c.closes.length - 1] ?? null) : null);
  return {
    mode, root: dataBranchDir(s.env), sheetPortfolio: mode === 'shadow' ? app.portfolio : null,
    today: formatDateInTz(new Date(s.clock.now()), 'America/New_York'),
    // A stock's chart was fetched (and stored) by tonight's analysis; a crypto pair is read raw, so no price tab is created.
    close: async (t) => lastOf(t.endsWith('-USD') ? await fetchYahooChartRaw(s.http, t, '1mo') : await s.fetchChart(t)),
    fxUsdIls: async () => lastOf(await fetchYahooChartRaw(s.http, 'ILS=X', '1mo')),
    cryptoPrices: activeProfile().ledger.cryptoPrices,
    fetchCrypto: (symbols) => fetchCryptoPrices(symbols, {
      fetch: async (url, timeoutMs) => { const r = await s.http.fetch({ url, muteHttpExceptions: true, timeoutMs }); return { status: r.status, text: r.text() }; },
      log: { warn: (m) => s.ctx.log.warning(m) },
    }),
    info: (m) => s.ctx.log.info(m), warn: (m) => s.ctx.log.warning(m),
  };
}

/** The advice journal's inputs: the report tabs just written, tonight's closes (cached charts), the alerts of the night. */
export function journalNightDeps(s: Services, app: Pick<NightlyApp, 'washout' | 'eventCheck' | 'business'>): JournalNightDeps {
  const lastOf = (c: { readonly closes: readonly number[] } | null | undefined): number | null => (c && c.closes.length ? (c.closes[c.closes.length - 1] ?? null) : null);
  return {
    mode: activeProfile().storage.ledger, root: dataBranchDir(s.env), today: formatDateInTz(new Date(s.clock.now()), 'America/New_York'), nowIso: new Date(s.clock.now()).toISOString(),
    readTab: (tab, cols) => s.tabStore.read(tab, cols),
    close: async (t) => lastOf(await s.fetchChart(t)),
    washout: () => app.washout(), eventCheck: () => app.eventCheck(), business: () => (app.business ? app.business() : null),
    info: (m) => s.ctx.log.info(m), warn: (m) => s.ctx.log.warning(m),
  };
}

/** Tonight's washout lines (null = off): one Telegram line each, deduped per stock (jobs/washout/washoutAlert.ts). Never throws. */
export async function runWashoutAlerts(app: Pick<NightlyApp, 'washout'>, kv: PropertyStore, tg: TelegramTarget, log: (m: string) => void): Promise<string[]> {
  const night = await app.washout().catch(() => null);
  if (!night) return [];
  return sendWashoutAlerts({ kv, send: (line) => notifyIfNeeded(tg, line, log), log }, night).catch((e: unknown) => { log('washout alert: not sent: ' + String(e)); return []; });
}

/** HTML to PDF with the runner's Chrome; null when there is none. */
const pdfMaker = (env: Readonly<Record<string, string | undefined>>): ((html: string, pdf: string) => Promise<void>) | null => {
  const chrome = findChrome(env);
  return chrome ? (html, pdf) => htmlToPdf(html, pdf, chrome) : null;
};

export interface NightlyDigestDeps {
  readonly app: Pick<NightlyApp, 'digest'>;
  readonly summary: RunSummary | null;
  readonly store: TabStore;
  readonly timeZone: string;
  readonly now: number;
  readonly log: (m: string) => void;
  /** A digest piece that failed (WARNING; the nightly result is unchanged). Default: log. */
  readonly warn?: (m: string) => void;
  readonly regime: () => Promise<string | null>;
  readonly telegram: { readonly deps: TelegramDeps; readonly chatId: string };
  readonly toPdf: ((html: string, pdfPath: string) => Promise<void>) | null;
  readonly outDir?: string;
  /** Row 38: the GitHub minutes line (never throws; absent = no line). */
  readonly minutesLine?: () => Promise<string>;
}

/** Row 29: the digest after the nightly. Never throws: each read and each send that fails is logged and left out. */
export async function runNightlyDigest(d: NightlyDigestDeps): Promise<DigestSent> {
  const warn = d.warn ?? d.log;
  try {
    const regime = await d.regime().catch((e) => { warn('nightly digest: market regime not read: ' + String(e)); return null; });
    const paper = await loadPaper(d.store).then((p) => p?.state ?? null).catch((e) => { warn('nightly digest: paper test not read: ' + String(e)); return null; });
    const day = new Date(d.now).toLocaleDateString('en-GB', { timeZone: d.timeZone, day: 'numeric', month: 'short', year: 'numeric' });
    const data = digestOf({ day, regime, capture: d.app.digest, paper, summary: d.summary });
    const minutes = d.minutesLine ? await d.minutesLine().catch((e: unknown) => { warn('nightly digest: GitHub minutes line not read: ' + String(e)); return MINUTES_UNREADABLE; }) : null;
    const sent = await sendNightlyDigest({ telegram: d.telegram, toPdf: d.toPdf, log: d.log, timeZone: d.timeZone, now: d.now, ...(d.outDir ? { outDir: d.outDir } : {}), ...(minutes ? { footer: [minutes] } : {}) }, data, d.app.digest);
    d.log('nightly digest: ' + sent.pdfs.length + ' PDF(s) sent' + (sent.message ? '; no PDF, one plain line sent instead' : ''));
    return sent;
  } catch (e) {
    warn('nightly digest failed (the nightly result is unchanged): ' + String(e));
    return { message: false, pdfs: [] };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Three spreadsheets: a maintenance pause ends cleanly (exit 0), a guard refusal with exit 2 (app/sheetGuardExit.ts).
  runEntryMain(() => nightlyMain(process.argv.slice(2)), STD_IO, { notify: false }, finish);
}
