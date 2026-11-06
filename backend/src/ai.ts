/**
 * `npm run ai`: the manual AI run (.github/workflows/ai-dispatch.yml). Inputs come from the
 * workflow as env BUY, BUY_GEMINI, BUY_OPUS, EXIT, EXIT_GEMINI, EXIT_OPUS, EFFORT.
 *
 *   Buy side   every watchlist ticker: one fresh analysis (no AI inside it), then Gemini and/or
 *              Opus (Opus only for Tier 1, the plan's default), written into the Buy report's
 *              AI SUMMARIES section in place.
 *   Exit side  every stock held on the Portfolio sheet, Exit-framed, with the position facts
 *              (entry, current price, gain, the profile's working tax assumption on a gain -- the
 *              user's rule), written into the Exit report's AI SUMMARIES section.
 *              Plan #47 (owner 2026-11-04): when the Exit Opus box is ticked, one extra Opus call reads the whole Exit
 *              report (every stock and option) and writes a short portfolio view (ai/portfolioOpus.ts) at the top of
 *              the AI SUMMARIES section (its headline in the report's top status line); it reaches Telegram inside the
 *              Exit PDFs only (a view that is off or failed sends one plain line). Display only.
 * The nightly must have built both report tabs first; otherwise a plain message says so.
 * Exit status: 0 done (even with failed legs), 1 bad inputs or a crash.
 */

import { orElse } from './core/guard.ts';
import { finish } from './core/finish.ts';
import { runEntryMain } from './app/sheetGuardExit.ts';
import { composeServices, tickerDeps, type Services } from './compose.ts';
import { createContext } from './core/context.ts';
import { formatLine, LogLevel, textLog } from './core/logger.ts';
import type { CliIo } from './cli.ts';
import { STD_IO } from './cli.ts';
import { parseAiInputs, runAiBatch, type AiDispatchDeps, type AiRunPlan, type AiTickerRequest } from './ai/aiDispatch.ts';
import { createGeminiHttpTransport, type GeminiTransport } from './ai/geminiTransport.ts';
import { createAnthropicSdk } from './ai/claudeSdk.ts';
import type { ClaudeSdk } from './ai/claudeReview.ts';
import type { ExitPositionFacts } from './ai/exitFraming.ts';
import { toBuyAiInput, toExitAiInput } from './ai/aiToSheet.ts';
import { createAnalysisCache } from './app/analysisCache.ts';
import { loadPortfolio, loadWatchlist, scratchFactory } from './app/nightlyApp.ts';
import { runTickerAnalysisDetailed } from './analysis/runTicker.ts';
import { tierOf } from './jobs/buy/buyPipeline.ts';
import { OWN_BLOCK_FLOOR } from './types/decision.ts';
import { writeBuyAiSummaries } from './reports/buySheet/buySheet.ts';
import { BUY_SHEET_TAB } from './reports/buySheet/text.ts';
import { writeAiSummaries, readExitReportRows, EXIT_SHEET_TAB } from './reports/exitSheet/exitSheet.ts';
import { portfolioOpusView, exitReadText, type PortfolioView } from './ai/portfolioOpus.ts';
import { notifyIfNeeded } from './notify/policy.ts';
import { dateStringInTz } from './analysis/macroRegime.ts';
import { occExpiryText } from './core/dates.ts';
import type { BuyTier } from './reports/buySheet/types.ts';
import type { EntryOverrides } from './ticker.ts';
import { withSheetWrites, isUnlockFailure, UNLOCK_FAILED_LINE } from './app/sheetWrites.ts';

import { EXIT_TAX_RATE } from './portfolio/exitTax.ts';
import { stockTrailingStop } from './jobs/exit/exitPipeline.ts';
import { BITCOIN_ETF_TICKERS } from './reports/exitSheet/text.ts';
import { toAnalysisChart } from './analysis/runTicker.ts';
import type { StockHolding } from './sheets/readers/portfolio.ts';
import { ASSUMED_ENTRY_BASIS } from './sheets/readers/portfolio.ts';

/**
 * Row 35 (#44): the Exit AI's position facts. The trailing stop is the one the Exit report shows (same read on the
 * same chart); the Bitcoin flag is set when two or more spot Bitcoin ETFs are held (they share one thesis).
 */
export function exitFactsFor(h: StockHolding, currentPrice: number, stop: number | null, held: readonly string[]): ExitPositionFacts {
  const entry = h.avgCost;
  const gainPct = entry && entry > 0 ? (currentPrice / entry - 1) * 100 : null;
  const btc = new Set(held.map((t) => t.toUpperCase()).filter((t) => (BITCOIN_ETF_TICKERS as readonly string[]).includes(t)));
  return {
    entryPrice: entry, currentPrice, unrealizedPct: gainPct,
    trailingStop: stop,
    afterTaxPct: gainPct == null ? null : gainPct > 0 ? gainPct * (1 - EXIT_TAX_RATE) : gainPct,
    taxRatePct: EXIT_TAX_RATE * 100,
    bitcoinEtfSharedThesis: btc.size >= 2 && btc.has(h.ticker.toUpperCase()),
    ...(h.entryDateAssumed ? { trailingStopBasis: ASSUMED_ENTRY_BASIS } : {}),
  };
}

export interface AiOverrides extends EntryOverrides {
  readonly geminiTransport?: GeminiTransport;
  readonly claudeSdk?: ClaudeSdk;
  /** Tests: the Telegram fetch for the portfolio view message. */
  readonly telegramFetch?: typeof fetch;
}

export function aiInputsFromEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return { buy: env.BUY, buy_gemini: env.BUY_GEMINI, buy_opus: env.BUY_OPUS, exit: env.EXIT, exit_gemini: env.EXIT_GEMINI, exit_opus: env.EXIT_OPUS, effort: env.EFFORT };
}

export interface AiRunReport {
  readonly buy: string | null; readonly exit: string | null;
  /** Plan #47: the portfolio view, when the Exit Opus box was ticked; null otherwise. */
  readonly portfolio?: PortfolioView | null;
}

export async function runAiApp(s: Services, plan: AiRunPlan, over: AiOverrides = {}): Promise<AiRunReport> {
  // A2: the expiry's own (UTC) date; parity runs keep legacy's New York date.
  const nyExpiry = s.opts.legacyParity
    ? (expUnix: unknown): string => dateStringInTz(new Date((expUnix as number) * 1000), 'America/New_York')
    : occExpiryText;
  // The dispatch layer refuses to run in a nightly-mode context (nightly runs make no AI calls); this is the AI run.
  const ctx = s.ctx.mode === 'ai' ? s.ctx : createContext({ mode: 'ai', runId: s.ctx.runId, logger: s.ctx.log, status: s.ctx.status, clock: s.clock, sleep: s.ctx.sleep, random: s.ctx.random });
  const deps: AiDispatchDeps = {
    ctx,
    geminiTransport: over.geminiTransport ?? createGeminiHttpTransport(s.http, s.geminiKey),
    claudeSdk: over.claudeSdk ?? createAnthropicSdk(s.claudeKey),
    claudeApiKey: s.claudeKey,
    getMacroRegime: () => s.getMacro() as never,
    formatExpiry: nyExpiry,
    plainLabels: !s.opts.legacyParity,
  };
  const scratch = await scratchFactory(s);
  const cache = createAnalysisCache(async (t) => runTickerAnalysisDetailed(tickerDeps(s, await scratch(), { noAi: true }), t));
  const ranAt = new Date(s.clock.now());
  const ss = await s.openWorkbook([BUY_SHEET_TAB, EXIT_SHEET_TAB]);
  let buyMsg: string | null = null, exitMsg: string | null = null, portfolio: PortfolioView | null = null;

  if (plan.buy) {
    const wl = await loadWatchlist(s);
    const requests: AiTickerRequest[] = [];
    const candidates: Array<{ ticker: string; tier: BuyTier }> = [];
    for (const t of wl.tickers) {
      const art = await cache.get(t);
      const inputs = await cache.gemini(t);
      const r = art.result;
      const own = r ? (r.fundResult.score ?? null) : null;
      const tier = tierOf({ decision: !!r, blocked: own != null && own <= OWN_BLOCK_FLOOR, buyNow: !!r && r.techPlan.timing === 'BUY_NOW', conviction: r ? r.decision.finalConviction : null });
      candidates.push({ ticker: t, tier });
      if (inputs) requests.push({ ticker: t, inputs });
    }
    const tierOfTicker = new Map(candidates.map((c) => [c.ticker, c.tier]));
    const batch = await runAiBatch(deps, 'buy', requests, plan.buy, plan.effort, { opusFilter: (t) => tierOfTicker.get(t) === 1 });
    const res = writeBuyAiSummaries(ss, toBuyAiInput(batch, { ranAt, switches: plan.buy, effort: plan.effort, candidates }), { log: textLog(s.ctx.log) });
    buyMsg = res.written ? 'Buy report: AI summaries written for ' + batch.results.length + ' stocks.' : String(res.message);
  }

  if (plan.exit) {
    const p = await loadPortfolio(s);
    const requests: AiTickerRequest[] = [];
    for (const h of p.stocks) {
      const art = await cache.get(h.ticker);
      const inputs = await cache.gemini(h.ticker);
      if (!inputs || !art.chart) continue;
      const cp = art.chart.currentPrice;
      let stop: number | null = null;
      if (h.avgCost != null && h.avgCost > 0) {
        const tlog = s.ctx.log.child(h.ticker);
        const fc = await s.fetchChart(h.ticker).catch((e: unknown) => { tlog.warning('exit AI: chart fetch failed, no trailing stop in the facts', { detail: String(e) }); return null; });
        const avgCost = h.avgCost;
        stop = fc ? orElse(tlog, 'exit AI: trailing stop', () => stockTrailingStop(h.ticker, avgCost, h.entryDate, toAnalysisChart(fc as never), {}, h.entryDateAssumed === true), null) : null;
      }
      const facts: ExitPositionFacts = exitFactsFor(h, cp, stop, p.stocks.map((x) => x.ticker));
      requests.push({ ticker: h.ticker, inputs, exitFacts: facts });
    }
    const batch = await runAiBatch(deps, 'exit', requests, plan.exit, plan.effort);
    if (plan.exit.opus) {
      // Plan #47: one Opus call over the whole Exit report as the nightly wrote it (read before the AI section is rewritten).
      const rows = await Promise.resolve().then(() => readExitReportRows(ss))
        .catch((e: unknown) => { s.ctx.log.warning('portfolio view: the Exit report could not be read', { detail: String(e) }); return null; });
      portfolio = await portfolioOpusView({ ctx, apiKey: s.claudeKey, sdk: deps.claudeSdk }, rows ? exitReadText(rows) : null, plan.effort);
    }
    const res = writeAiSummaries(ss, {
      ...toExitAiInput(batch, { ranAt, switches: plan.exit, effort: plan.effort }),
      ...(portfolio ? { portfolioView: { paragraphs: portfolio.paragraphs, headline: portfolio.headline } } : {}),
    }, { log: textLog(s.ctx.log) });
    exitMsg = res.written ? 'Exit report: AI summaries written for ' + batch.results.length + ' holdings.' : String(res.message);
  }

  await ss.flush();
  await s.flushStores();
  return { buy: buyMsg, exit: exitMsg, portfolio };
}

export async function aiMain(argv: readonly string[], io: CliIo = STD_IO, over: AiOverrides = {}): Promise<number> {
  const flags = new Set(argv);
  const env = io.env ?? process.env;
  const parsed = parseAiInputs(aiInputsFromEnv(env));
  if (!parsed.ok) { io.err(parsed.message + '\n'); io.err(formatLine({ ts: new Date().toISOString(), level: LogLevel.CRITICAL, scope: 'ai', message: 'AI run refused: ' + parsed.detail }) + '\n'); return 1; }
  const s = await composeServices({
    storage: flags.has('--memory') ? 'memory' : 'sheets', env, mode: 'ai', noAi: true,
    logLevel: flags.has('--debug') ? LogLevel.DEBUG : LogLevel.INFO, logSink: (l) => io.err(formatLine(l) + '\n'),
    ...(over.transport ? { transport: over.transport } : {}), ...(over.clock ? { clock: over.clock } : {}), ...(over.initialTabs ? { initialTabs: over.initialTabs } : {}),
  });
  let r: AiRunReport;
  let lockLines: readonly string[] = [];
  try {
    const run = await withSheetWrites(s, () => runAiApp(s, parsed.plan, over));
    r = run.value; lockLines = run.reportLines;
  } catch (e) {
    if (isUnlockFailure(e)) { io.out(UNLOCK_FAILED_LINE + '\n'); return 1; }
    throw e;
  }
  const pv = r.portfolio ?? null;
  const pvLine = pv ? (pv.state === 'ok' ? 'Exit report: portfolio view by Claude Opus written at the top of the AI summaries.' : pv.telegram) : null;
  io.out([r.buy, r.exit, pvLine, ...lockLines].filter(Boolean).join('\n') + '\n');
  if (pv) await sendPortfolioView(pv, env, io, over.telegramFetch);
  return 0;
}

/**
 * Plan #47 under the clean policy (notify/policy.ts): a written view is NOT sent (it is in the Exit report, so in the
 * /exit and Exit Report PDFs); only a view that is off or failed sends its ONE plain line. Never fails the run.
 * Returns true when a line was sent.
 */
export async function sendPortfolioView(pv: PortfolioView, env: Readonly<Record<string, string | undefined>>, io: CliIo, fetchImpl?: typeof fetch): Promise<boolean> {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim(), chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
  if (!token || !chatId || pv.state === 'ok') return false;
  return notifyIfNeeded({ deps: { token, ...(fetchImpl ? { fetchImpl } : {}) }, chatId }, '📊 ' + pv.telegram, () => { io.err('Telegram: the portfolio view line could not be sent.\n'); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Three spreadsheets: a maintenance pause ends cleanly (exit 0), a guard refusal with exit 2 (app/sheetGuardExit.ts).
  runEntryMain(() => aiMain(process.argv.slice(2)), STD_IO, { notify: true }, finish);
}
