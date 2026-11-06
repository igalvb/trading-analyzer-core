/**
 * Options sentiment plan (docs/OPTIONS_SENTIMENT_PLAN.md) P0, P1 and P3, the two nightly steps:
 *
 *   options.chains  (before the analysis)  one Cboe fetch per ticker of the union (nightly stocks, the paper list, SPY,
 *                   QQQ) into the run-wide memo the paper step reuses (its fetches become memo hits); the P0 checks
 *                   logged; one read per stock (A-2) and the A-5 gate; the market read (part B, display only) written to
 *                   🌐 Market Options Read; SPY / QQQ chains then dropped from the memo unless a stock list holds them.
 *   options.reads   (after the analysis)   📈 Options Reads (one row per stock, with the shadow columns the analysis
 *                   computed) and 📦 Options Read Snapshots; the latest read per stock saved for tomorrow's A-5 fallback.
 *
 * Neither step ever fails the night for a missing chain. While OPTIONS_READ_APPLIED (profile `options.applied`) is false
 * (shadow, A-8), nothing here changes a score, a tier, a timing or a paper trade. With it on (P2), the gated reads seed
 * each stock's analysis (app/nightlyApp.ts optionsSeedFor), the 📈 row's "now" columns hold the scores with options OFF
 * and the "if applied" columns the decision as run, and a stock without a read is a gap in the run (A-7).
 */

import { fetchCboeRaw, type CboeDeps } from '../../fetch/cboe.ts';
import type { FetchedChart } from '../../types/chart.ts';
import type { TabCell, TabStore } from '../../storage/tabStore.ts';
import type { PropertyStore } from '../../storage/kv.ts';
import type { SnapshotRead } from '../../reports/options/run.ts';
import {
  gateRead, optionsMarketHours, optionsNightDay, readOfChain, snapshotReadOf, OPTIONS_READ_APPLIED,
  type GatedRead, type OptionsRead, type OptionsShadow,
} from '../../analysis/options/nightlyRead.ts';
import { marketReadLine, marketReadOf, MARKET_OPTIONS_ETFS, type MarketOptionsRead } from '../../analysis/options/marketRead.ts';
import {
  loadLatestRead, optionsMeasuresRow, optionsReadRow, readOptionsMeasures, recordOptionsMeasures, readMarketOptions, readOptionsSnapshotRows, recordMarketOptions, recordOptionsReads, saveLatestRead,
  OPTIONS_READ_SNAPSHOTS_HEADER, OPTIONS_READ_SNAPSHOTS_TAB,
} from '../../storage/optionsReadsTab.ts';
import { mapLimit } from '../nightly/nightly.ts';
import { measuresOf, scoreMeasures, OPTIONS_MEASURES_MIN_NIGHTS, type MeasuresScore, type OptionsMeasures } from '../../analysis/options/measures.ts';
import type { OptionsReadsSummary } from '../nightly/summary.ts';

export const OPTIONS_FETCH_CONCURRENCY = 4;
/** After this long the step stops starting new fetches (the rest read "no chain"): bounds the GitHub minutes. */
export const OPTIONS_FETCH_BUDGET_MS = 3 * 60_000;

export interface OptionsNightDeps {
  /** The run-wide memo (and the P0 size / parse-time stats). */
  readonly cboe: CboeDeps & { readonly stats: NonNullable<CboeDeps['stats']> };
  readonly store: TabStore;
  readonly kv: PropertyStore;
  readonly timeZone: string;
  readonly now: () => number;
  readonly log: (m: string) => void;
  /** Daily bars (the ETFs' RV20 and VIX); only called for an ETF whose chain came back. */
  readonly fetchChart: (t: string) => Promise<FetchedChart | null>;
  readonly budgetMs?: number;
}

/** Tonight's options, kept by the nightly composition for the analysis, the reports and the options.reads step. */
export interface OptionsNight {
  readonly day: string;
  /** The nightly stocks (portfolio + watchlist), upper case. */
  readonly stocks: readonly string[];
  /** Every stock read tonight (nightly stocks and the paper list; "no chain" included). */
  readonly reads: ReadonlyMap<string, OptionsRead>;
  readonly gated: ReadonlyMap<string, GatedRead>;
  /** The gated read in the _OPTIONS_SNAPSHOT format (fresh reads only). */
  readonly snaps: ReadonlyMap<string, SnapshotRead>;
  readonly market: readonly MarketOptionsRead[];
  readonly marketLine: string | null;
  /**
   * Options weights due diligence 2026-11-06: tonight's measures per stock (smirk, ATM IVs, IV spread, O/S, OI) and their
   * points against the stock's own 📐 history (0 until 60 nights). Optional: absent in older callers / tests.
   */
  readonly measures?: ReadonlyMap<string, { readonly m: OptionsMeasures; readonly score: MeasuresScore }>;
}

const up = (t: string): string => String(t ?? '').toUpperCase().trim();
const mb = (n: number | null): string => (n == null ? 'size n/a' : (n / 1e6).toFixed(2) + ' MB');

/** options.chains: fetch, check (P0), read (A-2), gate (A-5), market read (B). Never throws for a missing chain. */
export async function runOptionsChains(d: OptionsNightDeps, nightlyStocks: readonly string[], paperList: readonly string[]): Promise<OptionsNight> {
  const nowMs = d.now();
  const day = optionsNightDay(nowMs, d.timeZone);
  const stocks = [...new Set(nightlyStocks.map(up).filter(Boolean))];
  const readTickers = [...new Set([...stocks, ...paperList.map(up).filter(Boolean)])];
  const union = [...new Set([...readTickers, ...MARKET_OPTIONS_ETFS])];
  const started = d.now(), budget = d.budgetMs ?? OPTIONS_FETCH_BUDGET_MS;
  const skipped: string[] = [];
  await mapLimit(union, OPTIONS_FETCH_CONCURRENCY, async (t) => {
    if (d.cboe.memo.has(t)) return;
    if (d.now() - started > budget) { skipped.push(t); return; }
    try { await fetchCboeRaw(d.cboe, t); } catch (e) { d.log('options: ' + t + ' chain fetch failed: ' + String(e)); }
  });
  if (skipped.length) d.log('options: fetch time budget used up; not fetched: ' + skipped.join(', '));

  // A-2 + P0, per stock
  const reads = new Map<string, OptionsRead>();
  for (const t of readTickers) {
    const json = d.cboe.memo.get(t) ?? null;
    let r: OptionsRead;
    try { r = await readOfChain(json, t, day, nowMs, d.timeZone, d.cboe.stats.get(t) ?? null); }
    catch (e) { d.log('options: ' + t + ' read failed: ' + String(e)); r = await readOfChain(null, t, day, nowMs, d.timeZone); }
    reads.set(t, r);
    const ch = r.checks;
    d.log('options P0 ' + t + ': ' + r.status + ', ' + ch.contracts + ' contracts, total volume ' + ch.totalVolume
      + (r.status === 'ok' ? (r.marketClosed ? ' (market-closed formula used)' : ' (market-open formula)') : '')
      + ', delta on ' + ch.withDelta + ', iv on ' + ch.withIv + ', ' + mb(ch.bytes) + (ch.parseMs == null ? '' : ', parse ' + ch.parseMs + ' ms')
      + (r.status === 'ok' ? ', ' + r.rows.length + ' scored' : ''));
  }
  const all = [...reads.values()], ok = all.filter((r) => r.status === 'ok');
  d.log('options P0 summary: ' + ok.length + ' of ' + all.length + ' stock chains read for ' + day
    + '; total volume 0 on ' + all.filter((r) => r.checks.contracts > 0 && r.checks.totalVolume === 0).length
    + '; market-closed formula on ' + ok.filter((r) => r.marketClosed).length
    + '; no delta on ' + all.filter((r) => r.checks.contracts > 0 && r.checks.withDelta === 0).length
    + '; no iv on ' + all.filter((r) => r.checks.contracts > 0 && r.checks.withIv === 0).length);

  // Options weights due diligence: the new measures, scored against each stock's own stored nights (display / data until 60).
  const measures = await measuresNight(d, reads, stocks, day, nowMs);

  // A-5: tonight, else the stored read (<= 2 trading days), else not applied
  const gated = new Map<string, GatedRead>(), snaps = new Map<string, SnapshotRead>();
  for (const t of readTickers) {
    const tonight = reads.get(t) ?? null;
    const stored = tonight && tonight.status === 'ok' ? null : await loadLatestRead(d.kv, t, nowMs).catch((e: unknown) => { d.log('⚠️ options: ' + t + ' stored read could not be loaded (treated as none): ' + String(e)); return null; });
    const g = gateRead(tonight, stored, day);
    gated.set(t, g);
    if (g.fresh && g.read) {
      const snap = await snapshotReadOf(g.read, nowMs, d.timeZone).catch((e: unknown) => { d.log('⚠️ options: ' + t + ' snapshot could not be built (no shadow input): ' + String(e)); return null; });
      if (snap) snaps.set(t, snap);
    }
    if (g.source === 'stored') d.log('options: ' + t + ' uses the stored read of ' + g.read?.day + (g.fresh ? '' : ' — ' + g.note + ', not applied'));
  }

  // Part B: the market read (display only)
  const market: MarketOptionsRead[] = [];
  try {
    const hist = await readMarketOptions(d.store).catch((e: unknown) => { d.log('⚠️ market options: the stored IV history could not be read (empty history used): ' + String(e)); return { ivHistory: new Map<string, number[]>(), latest: [] }; });
    let vix: { level: number; closes: readonly number[] } | null | undefined;
    for (const etf of MARKET_OPTIONS_ETFS) {
      const json = d.cboe.memo.get(etf) ?? null;
      const has = !!json?.data?.options?.length;
      const chart = has ? await d.fetchChart(etf).catch((e: unknown) => { d.log('⚠️ market options: ' + etf + ' chart fetch failed: ' + String(e)); return null; }) : null;
      if (has && vix === undefined) {
        const v = await d.fetchChart('^VIX').catch((e: unknown) => { d.log('⚠️ market options: ^VIX chart fetch failed (no VIX gap check): ' + String(e)); return null; });
        vix = v && v.closes.length ? { level: v.currentPrice, closes: v.closes } : null;
      }
      const r = marketReadOf({ day, etf, json, nowMs, closes: chart ? chart.closes : [], ivHistory: hist.ivHistory.get(etf) ?? [], vix: vix ?? null, stats: d.cboe.stats.get(etf) ?? null });
      market.push(r);
      d.log('options P0 ' + etf + ': ' + r.status + ', ' + mb(r.bytes) + (r.parseMs == null ? '' : ', parse ' + r.parseMs + ' ms') + ', total volume ' + r.totalVolume
        + (r.vixGapPts == null ? '' : ', ATM 30d IV vs VIX ' + (r.vixGapPts >= 0 ? '+' : '') + r.vixGapPts.toFixed(1) + ' pts' + (r.check === 'check' ? ' — CHECK: gap above 5 points, possible parse problem' : '')));
    }
    const intraday = optionsMarketHours(nowMs, d.timeZone);
    const wrote = intraday ? 0 : await recordMarketOptions(d.store, day, market);
    d.log('market options read: ' + (marketReadLine(market) ?? 'no SPY / QQQ chain tonight') + (wrote ? '' : intraday ? ' (not stored: read during market hours; the after-close run stores ' + day + ')' : ' (not stored: no chain, or already stored for ' + day + ')'));
  } catch (e) { d.log('❌ market options read failed (display only; the night goes on): ' + String(e)); }
  // The ETF chains are the largest Cboe serves: dropped once read, unless a stock list needs them.
  for (const etf of MARKET_OPTIONS_ETFS) if (!readTickers.includes(etf)) d.cboe.memo.delete(etf);

  return { day, stocks, reads, gated, snaps, market, marketLine: marketReadLine(market), measures };
}

/** Tonight's measures of every read with a chain, scored against the 📐 history (prior nights only) and tonight's nightly stocks. */
async function measuresNight(
  d: OptionsNightDeps, reads: ReadonlyMap<string, OptionsRead>, stocks: readonly string[], day: string, nowMs: number,
): Promise<Map<string, { m: OptionsMeasures; score: MeasuresScore }>> {
  const tonight = new Map<string, OptionsMeasures>();
  for (const [t, r] of reads) {
    const json = d.cboe.memo.get(t) ?? null;
    if (r.status !== 'ok' || !json) continue;
    const chart = await d.fetchChart(t).catch((e: unknown) => { d.log('⚠️ options measures: ' + t + ' chart fetch failed (no O/S, no realised vol tonight): ' + String(e)); return null; });
    const vols = chart?.volumes ?? [];
    tonight.set(t, measuresOf(json, t, day, nowMs, vols.length ? (vols[vols.length - 1] as number) : null, chart?.closes ?? []));
  }
  const hist = await readOptionsMeasures(d.store).catch((e: unknown) => { d.log('⚠️ options measures: the stored history could not be read (they score 0 tonight): ' + String(e)); return null; });
  const universe = stocks.map((t) => tonight.get(t)).filter((m): m is OptionsMeasures => !!m);
  const out = new Map<string, { m: OptionsMeasures; score: MeasuresScore }>();
  for (const [t, m] of tonight) {
    const own = hist ? (hist.get(t) ?? []).filter((x) => x.day < day) : [];
    out.set(t, { m, score: scoreMeasures(m, hist ? own : [], universe) });
  }
  const live = [...out.values()].filter((x) => x.score.nights >= OPTIONS_MEASURES_MIN_NIGHTS).length;
  d.log('options measures: ' + out.size + ' stock(s) measured for ' + day + '; ' + live + ' with ' + OPTIONS_MEASURES_MIN_NIGHTS + '+ nights of history (the rest score 0)');
  return out;
}

/** The scored measures of one stock tonight (null without a chain). */
export function measuresOfNight(n: OptionsNight | null, ticker: string): MeasuresScore | null {
  return n?.measures?.get(up(ticker))?.score ?? null;
}

/** The analysis' shadow input for one stock (A-8): the gated read and its snapshot; null without a fresh read. */
export function shadowInputOf(n: OptionsNight | null, ticker: string): { gated: GatedRead; snap: SnapshotRead } | null {
  if (!n) return null;
  const t = up(ticker), g = n.gated.get(t), snap = n.snaps.get(t);
  return g && snap ? { gated: g, snap } : null;
}

/** options.reads: the light rows with the shadow columns, the snapshots, and the latest read per stock. Returns a log line. */
export async function recordOptionsNight(
  d: Pick<OptionsNightDeps, 'store' | 'kv' | 'now' | 'log'> & { readonly timeZone?: string }, n: OptionsNight, shadowOf: (t: string) => Promise<OptionsShadow | null>,
): Promise<string> {
  // Owner 2026-11-05: a market-hours run stores nothing (it would take the night's slot from the after-close read).
  if (d.timeZone && optionsMarketHours(d.now(), d.timeZone)) return 'options reads: not stored for ' + n.day + ' (read during market hours; the after-close run stores this day)';
  const rows: TabCell[][] = [];
  const tonight: OptionsRead[] = [];
  for (const [t, r] of n.reads) {
    const g = n.gated.get(t) ?? gateRead(r, null, n.day);
    const sh = n.stocks.includes(t) ? await shadowOf(t).catch((e: unknown) => { d.log('⚠️ options reads: ' + t + ' shadow columns left empty (its analysis failed): ' + String(e)); return null; }) : null;
    rows.push(optionsReadRow(r, g, sh));
    if (r.status === 'ok') tonight.push(r);
  }
  const written = await recordOptionsReads(d.store, n.day, rows, tonight);
  const mRows = [...(n.measures ?? new Map()).values()].map((x) => optionsMeasuresRow(x.m, x.score));
  const mWritten = await recordOptionsMeasures(d.store, n.day, mRows);
  if (mRows.length) d.log('options measures: ' + (mWritten ? mWritten + ' row(s) stored for ' + n.day : 'already stored for ' + n.day));
  let saved = 0;
  for (const r of tonight) if (await saveLatestRead(d.kv, r, d.now())) saved++;
  return 'options reads: ' + (written ? written + ' row(s) stored for ' + n.day : 'already stored for ' + n.day) + ', ' + tonight.length + ' with contracts'
    + ', ' + saved + ' kept for the stale-read fallback' + (OPTIONS_READ_APPLIED ? ' (applied: shown; only the capped new measures can score)' : ' (shadow: not applied to any score)');
}

/**
 * A-6 (AI dispatch, applied only): the latest stored read per ticker from 📦 Options Read Snapshots, through the A-5
 * gate against today (<= 2 trading days old, else not applied). Read once per AI run (an on-demand run, not the nightly).
 * A ticker absent from the tab gets a "no read" gate.
 */
export async function storedOptionsGates(store: TabStore, nowMs: number, timeZone: string): Promise<Pick<OptionsNight, 'gated'>> {
  const rows = (await store.read(OPTIONS_READ_SNAPSHOTS_TAB, OPTIONS_READ_SNAPSHOTS_HEADER.length)) ?? [];
  const byTicker = readOptionsSnapshotRows(rows.slice(1));
  const today = optionsNightDay(nowMs, timeZone);
  const gated = new Map<string, GatedRead>();
  for (const [t, days] of byTicker) {
    const latest = [...days.keys()].filter((d) => d <= today).sort().pop();
    gated.set(up(t), gateRead(null, latest ? days.get(latest) ?? null : null, today));
  }
  return { gated };
}

/** The gate of one ticker from storedOptionsGates ("no read" when the tab has none). */
export function storedGateOf(g: Pick<OptionsNight, 'gated'>, ticker: string): GatedRead {
  return g.gated.get(up(ticker)) ?? { read: null, source: 'none', ageTradingDays: null, fresh: false, note: 'No stored options read for ' + up(ticker) };
}

/** A-7: tonight's per-stock options status for the run summary. */
export function optionsRunReport(n: OptionsNight | null): OptionsReadsSummary | null {
  if (!n || !n.stocks.length) return null;
  const g = (t: string): GatedRead | undefined => n.gated.get(t);
  return {
    day: n.day, stocks: n.stocks.length, applied: OPTIONS_READ_APPLIED,
    readTonight: n.stocks.filter((t) => g(t)?.source === 'tonight').length,
    stored: n.stocks.filter((t) => g(t)?.source === 'stored' && g(t)?.fresh),
    missing: n.stocks.filter((t) => !g(t)?.fresh),
  };
}
