/**
 * `npm run long-history` (docs/LONG_HISTORY_PLAN.md): the long price history files the live runs can merge in front of
 * the 2-year cache (storage/longHistory.ts, OFF unless LONG_HISTORY=on). Runs on GitHub (Yahoo is not reachable from
 * every session), from the manual workflow long-history.yml, which commits the folder to the `prices` branch.
 *
 *   npm run long-history -- backfill <dir> [TICKER...]   every ticker in full, 2007 to today (a file is replaced)
 *   npm run long-history -- append <dir> [TICKER...]     a file gets the bars after its last one; a ticker without a file,
 *                                                         or with a split since its file was written, is downloaded in full
 *   npm run long-history -- check <dir>                   offline: what the folder holds (no network)
 *
 * No ticker given: the default set (longHistoryTickers): the profile's lists (core, research core, watchlist seed),
 * the research universe and the context charts every analysis reads (SPY, QQQ, ^VIX, the sector ETFs).
 * One CSV per ticker (`<T>.csv`, '^' stored as '_') plus `_meta.json` (download time and splits per ticker).
 * Exit status: 0 when at least one ticker was written (a ticker Yahoo did not answer is reported, not fatal; the
 * check command: 0 always), 1 when nothing was, 2 on a usage error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { finish } from './core/finish.ts';
import { activeProfile } from './profile/active.ts';
import { SECTOR_ETF } from './fetch/marketContext.ts';
import { RESEARCH_UNIVERSE, fetchOne, type RawSeries } from './research/fetchPrices.ts';
import {
  LONG_HISTORY_META, longHistoryBaseName, seriesFromCsv, seriesToCsv, type LongHistoryMeta, type LongSeries,
} from './storage/longHistory.ts';

export const LONG_HISTORY_USAGE = 'usage: long-history backfill <dir> [TICKER...] | long-history append <dir> [TICKER...] | long-history check <dir>';
/** How far back an append asks for, so the new bars overlap the file (the seam check). */
export const APPEND_LOOKBACK_DAYS = 40;
/** The context charts every analysis reads besides the ticker (fetch/marketContext.ts). */
export const LONG_HISTORY_CONTEXT: readonly string[] = ['SPY', 'QQQ', '^VIX'];

/** The default ticker set, each once, in a stable order. */
export function longHistoryTickers(): string[] {
  const p = activeProfile();
  return [...new Set([...p.lists.core, ...p.lists.researchCore, ...p.lists.watchlistSeed, ...RESEARCH_UNIVERSE, ...LONG_HISTORY_CONTEXT, ...Object.values(SECTOR_ETF)])];
}

export function seriesOfRaw(r: RawSeries): LongSeries {
  return { ticker: r.ticker, dates: r.dates, opens: r.opens, highs: r.highs, lows: r.lows, closes: r.closes, volumes: r.volumes, splits: r.splits };
}

/**
 * The file plus the newer bars of `recent` (a download that starts before the file's last bar). 'refetch' when the
 * two do not agree on the days they share (a split since the file was written, or a Yahoo revision): the caller then
 * downloads the ticker in full.
 */
export function appendRecent(file: LongSeries, recent: LongSeries): { series: LongSeries; added: number } | 'refetch' {
  const at = new Map(file.dates.map((d, i) => [d, i]));
  let shared = 0, agree = 0;
  for (let i = 0; i < recent.dates.length; i++) {
    const j = at.get(recent.dates[i] as string);
    if (j == null) continue;
    shared++;
    if (Math.abs((recent.closes[i] as number) / (file.closes[j] as number) - 1) <= 0.005) agree++;
  }
  if (shared < 3 || agree < shared - 1) return 'refetch';
  const last = file.dates[file.dates.length - 1] as string;
  const k = recent.dates.findIndex((d) => d > last);
  if (k < 0) return { series: file, added: 0 };
  const cat = <T>(a: readonly T[], b: readonly T[]): T[] => a.concat(b.slice(k));
  const known = new Set(file.splits.map((s) => s.date));
  return {
    series: {
      ticker: file.ticker, dates: cat(file.dates, recent.dates), opens: cat(file.opens, recent.opens), highs: cat(file.highs, recent.highs),
      lows: cat(file.lows, recent.lows), closes: cat(file.closes, recent.closes), volumes: cat(file.volumes, recent.volumes),
      splits: [...file.splits, ...recent.splits.filter((s) => !known.has(s.date))],
    },
    added: recent.dates.length - k,
  };
}

export interface LongHistoryIo {
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly log: (m: string) => void;
  /** Pause between tickers (Yahoo's rate). */
  readonly pauseMs?: number;
}

const readMeta = (dir: string): Record<string, LongHistoryMeta> => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, LONG_HISTORY_META), 'utf8')) as Record<string, LongHistoryMeta>; } catch { return {}; }
};

export async function longHistoryMain(argv: readonly string[], io: LongHistoryIo): Promise<number> {
  const [cmd, dir, ...rest] = argv.filter((a) => !a.startsWith('--'));
  if (!dir || !(cmd === 'backfill' || cmd === 'append' || cmd === 'check')) { io.log(LONG_HISTORY_USAGE); return 2; }
  const tickers = rest.length ? [...new Set(rest.map((t) => t.trim().toUpperCase()).filter((t) => /^[A-Z0-9.^=-]{1,12}$/.test(t)))] : longHistoryTickers();
  const meta = readMeta(dir);
  if (cmd === 'check') {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort() : [];
    for (const f of files) {
      const t = f.replace(/\.csv$/, '').replace(/^_/, '^');
      const s = seriesFromCsv(t, fs.readFileSync(path.join(dir, f), 'utf8'));
      io.log(t + ': ' + (s ? s.dates.length + ' days, ' + s.dates[0] + ' to ' + s.dates[s.dates.length - 1] : 'UNREADABLE'));
    }
    io.log(files.length + ' files in ' + dir);
    return 0;
  }
  fs.mkdirSync(dir, { recursive: true });
  const nowMs = io.now();
  let written = 0;
  const failed: string[] = [];
  for (const t of tickers) {
    const file = path.join(dir, longHistoryBaseName(t) + '.csv');
    let out: LongSeries | null = null;
    let how = 'full';
    try {
      const have = cmd === 'append' && fs.existsSync(file) ? seriesFromCsv(t, fs.readFileSync(file, 'utf8'), meta[t]?.splits ?? []) : null;
      if (have) {
        const from = new Date(Date.parse((have.dates[have.dates.length - 1] as string) + 'T00:00:00Z') - APPEND_LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
        const recent = await fetchOne(t, io.fetchImpl, nowMs, from);
        const r = recent ? appendRecent(have, seriesOfRaw(recent)) : null;
        if (r && r !== 'refetch') { out = r.series; how = '+' + r.added; }
        else if (r === 'refetch') how = 'full (the recent bars disagree with the file: a split or a revision)';
        else how = 'not answered';
      }
      if (!out && how !== 'not answered') {
        const full = await fetchOne(t, io.fetchImpl, nowMs);
        out = full ? seriesOfRaw(full) : null;
      }
    } catch { out = null; }
    if (out) {
      fs.writeFileSync(file, seriesToCsv(out));
      meta[t] = { fetchedAt: new Date(nowMs).toISOString(), splits: out.splits };
      written++;
      io.log(t + ': ' + how + ', ' + out.dates.length + ' days, ' + out.dates[0] + ' to ' + out.dates[out.dates.length - 1]);
    } else {
      failed.push(t);
      io.log(t + ': NOT FETCHED');
    }
    if (io.pauseMs) await new Promise((r) => setTimeout(r, io.pauseMs));
  }
  fs.writeFileSync(path.join(dir, LONG_HISTORY_META), JSON.stringify(meta, null, 1) + '\n');
  io.log(cmd + ': ' + written + ' of ' + tickers.length + ' tickers written' + (failed.length ? '; not fetched: ' + failed.join(', ') : ''));
  return written ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  longHistoryMain(process.argv.slice(2), { fetchImpl: globalThis.fetch, now: () => Date.now(), log: (m) => process.stderr.write(m + '\n'), pauseMs: 300 })
    .then((code) => { finish(code); }, (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); finish(1); });
}
