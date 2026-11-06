/**
 * The nightly step 'paper.trade': runs one day of the 1-year paper test (paper/paperTrading.ts) from tonight's
 * analysis, stores the state in the '📝 Paper State' tab (JSON in chunks), rewrites the '📝 Paper Trading' tab
 * and sends the daily PDF to Telegram with its bottom line as the caption (no message; notify/policy.ts).
 * The engine reads come from the nightly's shared analysis cache, so a stock is analysed once per night.
 * Missed nights (2026-11-04: no nightly ran 2-4 Nov) are caught up first, oldest first, each on the bars up to its
 * own close with the engine run point in time (runEngineDay; no fundamentals, AI or macro archive, as in the
 * backtest) and no option chains (the LEAPS accounts wait that day); at most PAPER_CATCH_UP_DAYS per run.
 */

import type { TabStore, TabCell } from '../storage/tabStore.ts';
import type { FetchedChart } from '../types/chart.ts';
import type { TickerArtifacts } from '../analysis/runTicker.ts';
import { engineReadOf, exitReadFor, runEngineDay, type EngineRead } from '../backtest/engineRun.ts';
import type { PriceSeries } from '../backtest/data.ts';
import {
  newPaperState, paperDay, standings, heldList, pctOf, STRATEGIES, STRATEGY_LABEL, PAPER_FIXED_UNIVERSE, PAPER_START, PAPER_END, PAPER_DECIDE_FROM,
  type PaperState, type PaperTrade,
} from './paperTrading.ts';
import { PAPER_OWNER_LIST, LAB_SETUPS, LAB_LABEL, LILO_ID, LEAPS_IDS, ALL_ID, JAMES_IDS, JAMES_LEAPS_IDS, labHeld, type LabDayInput, type JamesNightPick } from './paperLab.ts';
import type { LeapsPick, LeapsQuote } from './paperLeaps.ts';
import { stockNight, logRows, readsRows, valuesRows, appendNight, LOG_TAB, READS_TAB, VALUES_TAB, LOG_HEADER, READS_HEADER, VALUES_HEADER, type StockNight } from './paperLog.ts';
import { fetchCboeRaw, type CboeDeps, type CboeChainJson } from '../fetch/cboe.ts';
import { barTimeZone } from '../backtest/data.ts';
import { recordChainNight } from './chainSnapshot.ts';
import { selectRecommendedCall } from '../analysis/options/conviction.ts';
import { jamesCallsOf, selectJamesLeaps, type JamesCall } from '../analysis/options/leapsPick.ts';
import type { TelegramDeps } from '../notify/telegram.ts';
import { bottomLine, sendPdfs } from '../notify/policy.ts';
import { dailyReportHtml } from './paperReport.ts';
import { EXIT_TAX_PCT } from '../portfolio/exitTax.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PAPER_STATE_TAB = '📝 Paper State';
export const PAPER_TAB = '📝 Paper Trading';
/** Characters per row of the saved state (a Sheets cell holds at most 50,000). */
export const PAPER_STATE_CHUNK = 40_000;
const CHUNK = PAPER_STATE_CHUNK;

export interface PaperJobDeps {
  readonly store: TabStore;
  readonly timeZone: string;
  readonly watchlist: readonly string[];
  readonly fetchChart: (t: string) => Promise<FetchedChart | null>;
  readonly analysis: (t: string) => Promise<TickerArtifacts>;
  readonly log: (m: string) => void;
  /** Tests: the clock. */
  readonly now?: () => number;
  /** Telegram, when set up. */
  readonly telegram?: { readonly deps: TelegramDeps; readonly chatId: string } | null;
  /** HTML to PDF (headless Chrome) for the daily report; without it nothing is sent (the tab holds it all). */
  readonly toPdf?: ((html: string, pdfPath: string) => Promise<void>) | null;
  /** Cboe's option chains, for the LEAPS accounts; without it they wait. */
  readonly cboe?: CboeDeps | null;
  /**
   * G0b: the dated 10-year daily bars (fetch/yahoo.ts fetchYahooChartLongRangeBars), fetched for the list and BTC-USD
   * (LONG_BAR_TICKERS) and handed to the research accounts as `long`; without it nothing is fetched.
   */
  readonly fetchLongBars?: ((t: string) => Promise<FetchedChart | null>) | null;
  /**
   * The engine reads of a missed trading day (catch-up): the real engine run point in time on the bars up to that
   * day (backtest/engineRun.ts runEngineDay, the default). Tests: a stub.
   */
  readonly readsAt?: ((series: ReadonlyMap<string, PriceSeries>, day: string, tickers: readonly string[]) => Promise<EngineRead[]>) | null;
}

/**
 * The most trading days one run handles (missed nights plus tonight). Missed days are handled in order, oldest first,
 * exactly as if the nightly had run each night; the days past the cap wait for the next run.
 */
export const PAPER_CATCH_UP_DAYS = 10;

/** G0b: the tickers whose 10-year bars the paper night fetches (the list, and spot bitcoin for James's BTC rules). */
export const LONG_BAR_TICKERS: readonly string[] = [...PAPER_OWNER_LIST, 'BTC-USD'];

/** Tonight's options: the LEAPS quotes and picks, and every chain fetched (null when Cboe failed), for the G3 snapshot. */
export type OptionsTonight = NonNullable<LabDayInput['options']> & { readonly chains: ReadonlyMap<string, CboeChainJson | null>; readonly picks: ReadonlyMap<string, LeapsPick> };

/** Tonight's LEAPS picks (the engine's: furthest expiry 180+ days out, delta closest to 0.75) and every quote of the list's chains. */
export async function optionsTonight(cboe: CboeDeps, tickers: readonly string[], nowMs: number, log: (m: string) => void, timeZone = 'America/New_York'): Promise<OptionsTonight> {
  const quotes = new Map<string, LeapsQuote>(), picks = new Map<string, LeapsPick>(), chains = new Map<string, CboeChainJson | null>();
  for (const t of tickers) {
    try {
      const json = await fetchCboeRaw(cboe, t);
      chains.set(t, json);
      for (const o of json?.data?.options ?? []) if (o.option) quotes.set(String(o.option), { bid: Number(o.bid) || 0, ask: Number(o.ask) || 0 });
      const r = await selectRecommendedCall({ ...cboe, clock: { now: () => nowMs } as never }, t, 0.75, true);
      if (r.found) picks.set(t, { symbol: r.contract.symbol, strike: r.contract.strike, expUnix: r.expUnix, bid: r.contract.bid, ask: r.contract.ask });
    } catch (e) { log('⚠️ paper test: no option chain for ' + t + ': ' + String(e)); if (!chains.has(t)) chains.set(t, null); }
  }
  // James — LEAPS (phase 4): James's pick from the same chains (no extra Cboe call), per stock and delta, memoised
  const nowUnix = Math.floor(nowMs / 1000), today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone });
  const calls = new Map<string, JamesCall[]>(), jp = new Map<string, JamesNightPick | null>();
  const jamesPick = (t: string, delta: number): JamesNightPick | null => {
    const key = t + '|' + delta;
    if (jp.has(key)) return jp.get(key) ?? null;
    let out: JamesNightPick | null = null;
    const json = chains.get(t);
    if (json) {
      if (!calls.has(t)) calls.set(t, jamesCallsOf(json));
      const spot = Number(json.data?.current_price);
      const r = selectJamesLeaps(calls.get(t)!, Number.isFinite(spot) && spot > 0 ? spot : null, nowUnix, today, delta);
      const c = r.contract;
      if (c && c.symbol) out = { symbol: c.symbol, strike: c.strike, expUnix: c.expUnix, bid: c.bid, ask: c.ask, delta: c.delta, iv: c.iv,
        why: 'Jan-' + new Date(c.expUnix * 1000).getUTCFullYear() + ' $' + c.strike + ' call, delta ' + c.delta.toFixed(2) + ', break-even ' + (c.bemYear == null ? '—' : (c.bemYear >= 0 ? '+' : '') + (c.bemYear * 100).toFixed(1) + '%/yr') + ', spread ' + (c.spread == null ? '—' : (c.spread * 100).toFixed(1) + '%') + ', OI ' + (c.oi ?? 0) };
    }
    jp.set(key, out);
    return out;
  };
  return { quote: (s) => quotes.get(s) ?? null, pick: (t) => picks.get(t) ?? null, nowUnix, chains, picks, jamesPick };
}

/** The whole state plus every trade so far (for the tab). */
export interface StoredPaper { state: PaperState; trades: PaperTrade[] }

export async function loadPaper(store: TabStore): Promise<StoredPaper | null> {
  const rows = await store.read(PAPER_STATE_TAB, 1);
  const text = (rows ?? []).map((r) => String(r[0] ?? '')).join('');
  return text ? (JSON.parse(text) as StoredPaper) : null;
}

export async function savePaper(store: TabStore, p: StoredPaper): Promise<void> {
  const text = JSON.stringify(p);
  const rows: TabCell[][] = [];
  for (let i = 0; i < text.length; i += CHUNK) rows.push([text.slice(i, i + CHUNK)]);
  await store.ensure(PAPER_STATE_TAB);
  await store.clear(PAPER_STATE_TAB);
  await store.write(PAPER_STATE_TAB, 1, rows);
}

const nyDay = (d: Date, tz: string): string => d.toLocaleDateString('en-CA', { timeZone: tz });

/** A chart as a dated series; crypto bars are dated in UTC (backtest/data.ts barTimeZone), everything else in `tz`. */
export function seriesFromChart(t: string, c: FetchedChart, tz: string): PriceSeries {
  const zone = barTimeZone(t, tz);
  return {
    ticker: t, dates: c.dates.map((d) => nyDay(d, zone)), opens: [...c.opens], highs: [...c.highs], lows: [...c.lows], closes: [...c.closes], volumes: [...c.volumes],
    splits: (c.splits ?? []).map((x) => ({ date: Math.floor(x.date.getTime() / 1000), numerator: x.numerator, denominator: x.denominator })),
  };
}

/** The series as a nightly on `day` saw it: the bars up to and including that day. */
export function seriesUpTo(s: PriceSeries, day: string): PriceSeries {
  let n = s.dates.length;
  while (n > 0 && (s.dates[n - 1] as string) > day) n--;
  if (n === s.dates.length) return s;
  return {
    ticker: s.ticker, dates: s.dates.slice(0, n), opens: s.opens.slice(0, n), highs: s.highs.slice(0, n), lows: s.lows.slice(0, n), closes: s.closes.slice(0, n), volumes: s.volumes.slice(0, n),
    splits: s.splits.filter((x) => new Date(x.date * 1000).toISOString().slice(0, 10) <= day),
  };
}

const cutMap = (m: ReadonlyMap<string, PriceSeries>, day: string): Map<string, PriceSeries> => new Map([...m].map(([t, s]) => [t, seriesUpTo(s, day)]));

export function paperTabRows(p: StoredPaper): TabCell[][] {
  const s = p.state;
  const rows: TabCell[][] = [
    ['📝 PAPER TRADING — 1-year forward test, $100,000 per strategy, ' + s.start + ' to ' + s.end],
    ['Decided at each close from the live nightly analysis, filled at the next open, ' + EXIT_TAX_PCT + ' tax on gains. Values below are after the tax on what is still held. Last day: ' + (s.lastDay ?? 'not started')],
    [],
    ['Strategy (📊 = what we compare against)', 'Value', 'Return', 'Deepest fall', 'Stocks held', '📊 QQQ since this account joined (accounts that joined late)'],
    ...standings(s).map((r) => [(r.bench ? '📊 ' : '') + r.name, Math.round(r.value), pctOf(r.value), '-' + r.maxDrawdownPct.toFixed(1) + '%', r.positions, r.qqqSinceJoined == null ? '' : pctOf(r.qqqSinceJoined)] as TabCell[]),
    [],
    ['Holdings now'],
    ...STRATEGIES.map((id) => [STRATEGY_LABEL[id], heldList(s, id).join(', ') || 'cash'] as TabCell[]),
    ...(s.lab ? [...LAB_SETUPS.map((st) => st.id), LILO_ID, ...LEAPS_IDS, ALL_ID, ...JAMES_IDS, ...JAMES_LEAPS_IDS].map((id) => [LAB_LABEL[id], labHeld(s.lab!, id).join(', ') || 'cash'] as TabCell[]) : []),
    [],
    ['Trades, newest first', '', '', '', '', '', '', ''],
    ['Day', 'Strategy', 'Side', 'Ticker', 'Shares', 'Price', 'Tax', 'Why'],
    ...[...p.trades].reverse().slice(0, 300).map((t) => [t.day, STRATEGY_LABEL[t.strategy as keyof typeof STRATEGY_LABEL] ?? LAB_LABEL[t.strategy] ?? t.strategy, t.side, t.ticker, t.shares, Math.round(t.price * 100) / 100, Math.round(t.tax), t.why] as TabCell[]),
  ];
  return rows;
}

export function telegramText(p: StoredPaper, today: readonly PaperTrade[]): string {
  const lines = ['📝 Paper test — ' + p.state.lastDay, ...standings(p.state).map((r) => (r.bench ? '📊 ' : '') + r.name + ': ' + pctOf(r.value) + ' (fall -' + r.maxDrawdownPct.toFixed(0) + '%)')];
  if (today.length) lines.push('', 'Today:', ...today.filter((t) => t.ticker !== 'QQQ').map((t) => (STRATEGY_LABEL[t.strategy as keyof typeof STRATEGY_LABEL] ?? LAB_LABEL[t.strategy] ?? t.strategy) + ' ' + (t.side === 'BUY' ? 'bought ' : 'sold ') + t.shares + ' ' + t.ticker + ' at $' + t.price.toFixed(2)));
  return lines.join('\n');
}

/**
 * The bottom line of the daily PDF (its caption; notify/policy.ts): "Paper test 2026-11-05: best Turtle +7.5% · QQQ
 * +1.8% · 3 trade(s)".
 */
export function paperCaption(state: PaperState, stockTrades: number): string {
  const st = standings(state);
  const best = st.find((r) => !r.bench);
  const qqq = st.find((r) => r.key === 'qqq');
  return bottomLine('Paper test ' + state.lastDay, [best ? 'best ' + best.name + ' ' + pctOf(best.value) : null, qqq ? 'QQQ ' + pctOf(qqq.value) : null, stockTrades ? stockTrades + ' trade(s)' : null]);
}

/** The daily PDF with its bottom line as the caption, no message. No browser or no PDF: nothing is sent (logged). */
async function sendDailyReport(d: PaperJobDeps, state: PaperState, closeOf: (t: string) => number | null, trades: readonly PaperTrade[]): Promise<void> {
  const tg = d.telegram!;
  const name = 'paper-test-' + state.lastDay;
  if (!d.toPdf) { d.log('paper test: no browser, so no PDF tonight (the 📝 Paper Trading tab has it all)'); return; }
  const html = dailyReportHtml(state, closeOf);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-'));
  const pdf = path.join(dir, name + '.pdf');
  const made = await d.toPdf(html, pdf).then(() => true, (e: unknown) => { d.log('paper test: the PDF could not be made (nothing sent): ' + String(e)); return false; });
  if (!made) return;
  const stockTrades = trades.filter((t) => t.ticker !== 'QQQ').length;
  await sendPdfs(tg, [{ name: name + '.pdf', bytes: new Uint8Array(fs.readFileSync(pdf)) }], paperCaption(state, stockTrades), (m) => d.log('paper test: ' + m));
}

/** One night. Returns a plain outcome line. */
export async function runPaperNight(d: PaperJobDeps): Promise<string> {
  if (!PAPER_START) return 'Paper test: no start date in the profile (paper.start); nothing to do.';
  const universe = [...new Set([...PAPER_FIXED_UNIVERSE, ...d.watchlist.map((t) => t.toUpperCase().trim()).filter(Boolean)])].sort();
  let stored = (await loadPaper(d.store)) ?? { state: newPaperState(universe), trades: [] };
  // A saved test with another start (the first run, restarted 2026-10-28 so every account starts together) is
  // replaced by a new one, and its tabs are cleared.
  if (stored.state.start !== PAPER_START) {
    d.log('paper test: the saved test started ' + stored.state.start + '; starting again from ' + PAPER_START);
    stored = { state: newPaperState(universe), trades: [] };
    for (const tab of [LOG_TAB, READS_TAB, VALUES_TAB, PAPER_TAB]) { await d.store.ensure(tab); await d.store.clear(tab); }
  }
  const qqq = await d.fetchChart('QQQ');
  if (!qqq || !qqq.dates.length) throw new Error('paper test: no QQQ prices tonight');
  // A late run during market hours must not decide on a half day: today's bar counts only after the close.
  const nowMs = (d.now ?? Date.now)();
  const todayNy = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: d.timeZone });
  const nyMinutes = Number(new Date(nowMs).toLocaleTimeString('en-GB', { timeZone: d.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(':', '.')) ;
  const lastDay = nyDay(qqq.dates[qqq.dates.length - 1] as Date, d.timeZone);
  const closed = lastDay < todayNy || nyMinutes >= 16.3;
  const day = closed ? lastDay : nyDay(qqq.dates[qqq.dates.length - 2] as Date, d.timeZone);
  if (day < PAPER_DECIDE_FROM) return 'Paper test starts ' + PAPER_START + '; nothing to do for ' + day + '.';
  if (stored.state.lastDay && day <= stored.state.lastDay) return 'Paper test: no new trading day (last ' + stored.state.lastDay + ').';
  if (stored.state.lastDay && stored.state.lastDay >= PAPER_END) return 'Paper test finished on ' + stored.state.lastDay + '.';

  // Catch-up (owner 2026-11-04): every trading day since the last one handled, in order (QQQ's bars are the NYSE
  // days), each decided at its close and filled at the next open as if the nightly had run that night. The first
  // run handles tonight only.
  const qqqSeries = seriesFromChart('QQQ', qqq, d.timeZone);
  const since = stored.state.lastDay;
  let todo = since ? qqqSeries.dates.filter((x) => x > since && x < day && x >= PAPER_DECIDE_FROM) : [];
  todo = [...new Set([...todo, day])].sort();
  if (todo.length > PAPER_CATCH_UP_DAYS) {
    d.log('paper test: ' + todo.length + ' trading days to handle; ' + PAPER_CATCH_UP_DAYS + ' now (' + todo[0] + ' to ' + todo[PAPER_CATCH_UP_DAYS - 1] + '), the rest on the next run');
    todo = todo.slice(0, PAPER_CATCH_UP_DAYS);
  }
  const missed = todo.filter((x) => x !== day);
  if (missed.length) d.log('paper test: catching up ' + missed.length + ' missed trading day(s): ' + missed.join(', '));

  const series = new Map<string, PriceSeries>();
  const held = new Set(STRATEGIES.flatMap((id) => heldList(stored.state, id)));
  for (const t of [...new Set([...universe, ...stored.state.basketUniverse, ...held, ...PAPER_OWNER_LIST, 'QQQ'])]) {
    const c = t === 'QQQ' ? qqq : await d.fetchChart(t);
    if (!c) continue;
    series.set(t, t === 'QQQ' ? qqqSeries : seriesFromChart(t, c, d.timeZone));
  }
  // G0b: the 10-year bars for James's models (their layers; phase 1); a failure only logs and the 2-year series is used.
  const long = new Map<string, PriceSeries>();
  if (d.fetchLongBars) {
    for (const t of LONG_BAR_TICKERS) {
      const c = await d.fetchLongBars(t).catch((e: unknown) => { d.log('⚠️ paper test: 10-year bars fetch failed for ' + t + ' (the 2-year series is used): ' + String(e)); return null; });
      if (c && c.dates.length) long.set(t, seriesFromChart(t, c, d.timeZone));
    }
    d.log('paper test: 10-year bars for ' + long.size + ' of ' + LONG_BAR_TICKERS.length + ' tickers');
  }
  const readsAt = d.readsAt ?? ((s: ReadonlyMap<string, PriceSeries>, x: string, ts: readonly string[]) => runEngineDay(s, x, ts));
  const allTickers = [...new Set([...universe, ...PAPER_OWNER_LIST])];
  const allTrades: PaperTrade[] = [];
  let bars: Record<string, { open: number; close: number }> = {};
  let options: OptionsTonight | null = null;
  const filled: string[] = [], skipped: string[] = [];
  for (const x of todo) {
    const tonight = x === day;
    // A missed day sees only the bars up to its own close, like the nightly that night.
    const sx = tonight ? series : cutMap(series, x);
    const lx = tonight ? long : cutMap(long, x);
    const bx: Record<string, { open: number; close: number }> = {};
    for (const [t, s] of sx) { const i = s.dates.lastIndexOf(x); if (i >= 0) bx[t] = { open: s.opens[i] as number, close: s.closes[i] as number }; }
    let reads: EngineRead[], listReads: EngineRead[];
    if (tonight) {
      reads = [];
      for (const t of universe) reads.push(engineReadOf(await d.analysis(t), t, x, bx[t]?.close ?? null));
      listReads = [];
      for (const t of PAPER_OWNER_LIST) listReads.push(reads.find((r) => r.ticker === t) ?? engineReadOf(await d.analysis(t), t, x, bx[t]?.close ?? null));
      // The option chains are tonight's only: on a missed day the LEAPS accounts wait, as on a night Cboe fails.
      options = d.cboe ? await optionsTonight(d.cboe, PAPER_OWNER_LIST, nowMs, d.log, d.timeZone) : null;
    } else {
      const got = await readsAt(sx, x, allTickers).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
      if (!got.ok) { d.log('paper test: no engine reads for the missed day ' + x + ', skipped: ' + String(got.e)); skipped.push(x); continue; }
      const all: EngineRead[] = got.r;
      const by = new Map(all.map((r) => [r.ticker, r]));
      reads = universe.map((t) => by.get(t)).filter((r): r is EngineRead => !!r);
      listReads = PAPER_OWNER_LIST.map((t) => by.get(t)).filter((r): r is EngineRead => !!r);
    }
    const trades = paperDay(stored.state, {
      day: x, bars: bx, reads,
      exitRead: (t, entryDate, entryPrice) => exitReadFor(sx.get(t) as PriceSeries, x, entryDate, entryPrice),
      lab: { reads: listReads, series: sx, options: tonight ? options : null, ...(lx.size ? { long: lx } : {}) },
    });
    stored.trades.push(...trades);
    allTrades.push(...trades);
    bars = bx;
    // The year's record (paperLog.ts), written before the state so a failed save re-runs the night without losing it.
    const nights = new Map<string, StockNight>();
    for (const t of allTickers) nights.set(t, stockNight(x, listReads.find((r) => r.ticker === t) ?? reads.find((r) => r.ticker === t) ?? null, sx.get(t), lx.get(t)));
    const logged = await appendNight(d.store, LOG_TAB, LOG_HEADER, x, logRows(stored.state, x, trades, nights));
    await appendNight(d.store, READS_TAB, READS_HEADER, x, readsRows(x, nights), true);
    await appendNight(d.store, VALUES_TAB, VALUES_HEADER, x, valuesRows(stored.state, x));
    d.log('paper test: ' + logged + ' action(s) logged for ' + x + (tonight ? '' : ' (missed night, filled now)'));
    if (!tonight) filled.push(x);
  }
  if (filled.length || skipped.length) d.log('paper test: catch-up filled ' + (filled.join(', ') || 'nothing') + (skipped.length ? '; skipped ' + skipped.join(', ') : ''));
  // G3: tonight's option-chain snapshot from the chains already fetched (no extra Cboe call); never stops the night.
  const opt = options as OptionsTonight | null;
  if (opt) {
    try {
      const snap = await recordChainNight(d.store, day, PAPER_OWNER_LIST.map((t) => ({ ticker: t, chain: opt.chains.get(t) ?? null, pick: opt.picks.get(t) ?? null, series: series.get(t) })), opt.nowUnix);
      d.log('option snapshot: ' + snap.withChain + ' of ' + PAPER_OWNER_LIST.length + ' chains stored for ' + day + (snap.rows ? '' : ' (already stored)'));
    } catch (e) { d.log('option snapshot failed (the paper night goes on): ' + String(e)); }
  }
  await savePaper(d.store, stored);
  await d.store.ensure(PAPER_TAB);
  await d.store.clear(PAPER_TAB);
  await d.store.write(PAPER_TAB, 1, paperTabRows(stored));
  // The daily report (owner 2026-10-28; clean policy 2026-11-05): every trading night, the PDF only.
  if (d.telegram && stored.state.marks.length) {
    const closeOf = (t: string): number | null => bars[t]?.close ?? null;
    await sendDailyReport(d, stored.state, closeOf, allTrades).catch((e) => d.log('paper test: Telegram failed: ' + String(e)));
  }
  const last = stored.state.lastDay ?? day;
  const caught = filled.length ? ' (caught up ' + filled.length + ' missed day(s): ' + filled.join(', ') + ')' : '';
  if (!stored.state.marks.length) return 'Paper test: decisions made at the ' + last + ' close; the first trades fill at the ' + PAPER_START + ' open.' + caught;
  return 'Paper test ' + last + ': ' + allTrades.length + ' trade(s)' + caught + '; ' + standings(stored.state).map((r) => r.name + ' ' + pctOf(r.value)).join(', ');
}
