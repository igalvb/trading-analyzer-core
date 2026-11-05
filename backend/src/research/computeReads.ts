/**
 * Strategy research: the engine's daily read (engine + the 4 models + the comparison, the REAL code, offline,
 * point in time) for each ticker over many years, saved as one compact JSON file per ticker. Run several of these in
 * parallel (one per CPU), each with its own tickers:
 *   node src/research/computeReads.ts [--nearest-targets] [--fixed-t2] [--full-history] <priceDir> <outDir> <from YYYY-MM-DD> <to YYYY-MM-DD> TICKER...
 * A ticker whose file already exists is skipped (resume after a stop). No model or score code is changed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, priceFileName, type PriceSeries } from '../backtest/data.ts';
import { runEngineDay } from '../backtest/engineRun.ts';
import { CONTEXT_SYMBOLS } from '../backtest/run.ts';

/** One day's read, short keys to keep the files small. */
export interface CompactRead {
  d: string; ok: 0 | 1; c: number | null; tm: string | null; ep: number | null; st: number | null; ec: number | null; v: string | null;
  /** directions: engine, broker, schabacker, edwardsMagee, turtle (first letter: b(ullish) / m(ixed) / c(autionary) / -). */
  dir: string;
  /** Wyckoff: 'A:<stage>' (accumulation) or 'D:<stage>' (distribution); null when no schematic. */
  wy: string | null;
  /** LILO: entry zone low/high, entry method count, T1, T2. */
  lz: [number | null, number | null, number | null, number | null, number | null] | null;
  /** The day's close. */
  cl: number | null;
  /** Fix plan B1/D2 targets test (reads computed after 2026-10-30): R:R to T1 at the entry, and the T1 time estimate in days. */
  rr?: number | null;
  t1d?: number | null;
}

const letter = (x: string | null | undefined): string => (x === 'bullish' ? 'b' : x === 'mixed' ? 'm' : x === 'cautionary' ? 'c' : '-');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // --nearest-targets: the fix plan B1/D2 variant (T1 = nearest valid cluster 1 ATR above the entry). Default: production.
  const nearestTargets = args.includes('--nearest-targets');
  // --fixed-t2: fix plan B1 option B part 2 (T2 skips the methods the confluence excluded).
  const fixedT2 = args.includes('--fixed-t2');
  // --full-history (docs/LONG_HISTORY_PLAN.md A/B): each chart holds every bar on or before the day, not the last 2 years.
  const chartBars = args.includes('--full-history') ? Infinity : undefined;
  const [priceDir, outDir, from, to, ...tickers] = args.filter((a) => a !== '--nearest-targets' && a !== '--fixed-t2' && a !== '--full-history');
  if (!priceDir || !outDir || !from || !to || !tickers.length) throw new Error('usage: computeReads [--nearest-targets] [--fixed-t2] <priceDir> <outDir> <from> <to> TICKER...');
  fs.mkdirSync(outDir, { recursive: true });
  const series = new Map<string, PriceSeries>();
  for (const s of new Set([...CONTEXT_SYMBOLS, ...tickers])) if (fs.existsSync(path.join(priceDir, priceFileName(s)))) series.set(s, loadSeries(s, priceDir));
  const cal = series.get('SPY') as PriceSeries;
  const days = cal.dates.filter((d) => d >= from && d <= to);
  for (const t of tickers) {
    const file = path.join(outDir, t.replace(/^\^/, '_') + '.reads.json');
    if (fs.existsSync(file) || !series.has(t)) continue;
    const own = new Set(series.get(t)!.dates);
    const out: CompactRead[] = [];
    const t0 = Date.now();
    for (const d of days) {
      if (!own.has(d)) continue;
      const [r] = await runEngineDay(series, d, [t], { nearestTargets, fixedT2, ...(chartBars ? { chartBars } : {}) });
      if (!r) continue;
      const dr = r.directions ?? {};
      out.push({ d, ok: r.ok ? 1 : 0, c: r.finalConviction, tm: r.timing, ep: r.entryPrice, st: r.stop, ec: r.entryConfidencePct, v: r.verdict,
        dir: letter(dr.engine) + letter(dr.broker) + letter(dr.schabacker) + letter(dr.edwardsMagee) + letter(dr.turtle),
        wy: r.wyckoff ? (r.wyckoff.phase === 'ACCUMULATION' ? 'A:' : 'D:') + r.wyckoff.stage : null,
        lz: r.lilo ? [r.lilo.entryLow, r.lilo.entryHigh, r.lilo.entryCount, r.lilo.t1, r.lilo.t2] : null, cl: r.close, rr: r.rrToT1 ?? null, t1d: r.t1Days ?? null });
    }
    fs.writeFileSync(file, JSON.stringify(out));
    process.stderr.write(t + ': ' + out.length + ' days in ' + Math.round((Date.now() - t0) / 1000) + ' s\n');
  }
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
