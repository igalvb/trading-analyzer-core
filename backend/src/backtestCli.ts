/**
 * `npm run backtest -- [A|B|all] [--tradelog-dir <dir>] [--json-dir <dir>] [--cache <file>]`
 *
 * Backlog 9: the portfolio backtest (docs/BIG_PLAN_PORTFOLIO_BACKTEST_SIMULATION.md). Offline only: the price
 * files in legacy/historical_data, no provider keys, no network, no Sheet. Prints the result tables; with
 * --tradelog-dir writes v13-backtest-tradelog-test<A|B>-20261027.csv there (the taxed run's trades).
 *
 * Backlog 37 (simulation v2): A, B and `owner14 [2010-2019|2020-2023|2024-2026] --price-dir <dir>` (the research list,
 * profile lists.researchCore, over the research periods) run WITH the point-in-time macro reads (backtest/macroData.ts; the archive in
 * legacy/historical_data/macro, or --macro-dir). --no-macro gives v1. --price-dir replaces legacy/historical_data for the
 * prices; --list-dir names where the research list is, for the house-rule rows (hold QQQ, hold the list, deepest fall).
 * Trade logs and JSON of a macro run carry '-v2' in the name. per-ticker / per-model stay v1 (no macro).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { followModel, BOOK_MODELS, type BookModel, type FollowResult } from './backtest/perModel.ts';
import { perModelRow, perModelReport, type PerModelRow } from './backtest/perModelReport.ts';
import {
  TEST_A, TEST_B, loadAll, CachedEngineSource, runTest, tradeLogCsv, summaryText, singleTickerSpec, perTickerTable, OWNER_14_SPECS, houseRows, houseTable, loadOwnerList,
  type TestSpec, type TestOutcome,
} from './backtest/run.ts';
import { loadMacroArchive, describeArchive } from './backtest/macroData.ts';
import type { EngineRunOptions } from './backtest/engineRun.ts';
import { EXIT_TAX_PCT } from './portfolio/exitTax.ts';
import { LABELS } from './profile/labels.ts';
import { OWNER_BAG } from './research/portfolioCli.ts';

export interface CliIo { out(s: string): void; err(s: string): void }

export const BACKTEST_USAGE = 'Usage: npm run backtest -- [A|B|all|owner14 [period]|per-ticker|per-model] [--tradelog-dir <dir>] [--json-dir <dir>] [--cache <file>] '
  + '[--no-macro] [--macro-dir <dir>] [--price-dir <dir>] [--list-dir <dir>]';

export async function backtestMain(argv: readonly string[], io: CliIo): Promise<number> {
  const args = [...argv];
  const opt = (k: string): string | null => {
    const i = args.indexOf(k);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    return v ?? '';
  };
  const tradelogDir = opt('--tradelog-dir'), jsonDir = opt('--json-dir'), cache = opt('--cache');
  const macroDir = opt('--macro-dir'), priceDir = opt('--price-dir'), listDir = opt('--list-dir');
  const noMacroAt = args.indexOf('--no-macro');
  const noMacro = noMacroAt >= 0;
  if (noMacro) args.splice(noMacroAt, 1);
  if ([tradelogDir, jsonDir, cache, macroDir, priceDir, listDir].some((v) => v === '')) { io.err(BACKTEST_USAGE + '\n'); return 2; }
  const which = (args[0] ?? 'all').toUpperCase();
  if (which === 'PER-MODEL') {
    const tickers = [...TEST_A.universe, ...TEST_B.universe];
    const series = loadAll(tickers);
    const src = new CachedEngineSource(series, cache);
    const rows: PerModelRow[] = [];
    for (const t of tickers) {
      const spec = { ...singleTickerSpec(t), allIn: true };
      const engine = await runTest({ ...spec, noVeto: true }, series, src);
      const combined = await runTest(spec, series, src);
      const read = async (d: string) => (await src.engineReads(d, [t]))[0];
      const models = {} as Record<BookModel, FollowResult>;
      for (const m of BOOK_MODELS) models[m] = await followModel(series.get(t)!, read, m, spec.start, spec.end, spec.cash);
      rows.push(perModelRow(t, engine, combined, models));
      io.err('done ' + t + '\n');
    }
    src.save();
    io.out(perModelReport(rows) + '\n');
    return 0;
  }
  if (which === 'PER-TICKER') {
    const tickers = [...TEST_A.universe, ...TEST_B.universe];
    const series = loadAll(tickers);
    const src = new CachedEngineSource(series, cache);
    const outs: TestOutcome[] = [];
    const allIn: TestOutcome[] = [];
    for (const t of tickers) {
      outs.push(await runTest(singleTickerSpec(t), series, src));
      allIn.push(await runTest({ ...singleTickerSpec(t), allIn: true }, series, src));
      io.err('done ' + t + '\n');
    }
    src.save();
    io.out('Each stock traded ALONE by the system ($100,000, ' + TEST_A.start + ' to ' + TEST_A.end + ', after the ' + EXIT_TAX_PCT + ' tax), vs just holding it, vs just holding QQQ. ✅ = best.\n\n' + perTickerTable(outs, allIn) + '\n');
    return 0;
  }
  let specs: TestSpec[] = which === 'A' ? [TEST_A] : which === 'B' ? [TEST_B] : which === 'ALL' ? [TEST_A, TEST_B] : [];
  if (which === 'OWNER14') specs = !priceDir || args.length > 2 ? [] : OWNER_14_SPECS.filter((sp) => !args[1] || sp.name === 'owner14 ' + args[1]);
  else if (args.length > 1) specs = [];
  if (!specs.length) { io.err(BACKTEST_USAGE + '\n'); return 2; }
  const runOptions: EngineRunOptions = noMacro ? {} : { macro: loadMacroArchive(macroDir ?? undefined) };
  io.out((runOptions.macro ? 'Simulation v2: point-in-time macro reads ON. ' + describeArchive(runOptions.macro) : 'Macro reads OFF (v1).') + '\n\n');
  const universe = which === 'OWNER14' ? specs.flatMap((sp) => sp.universe) : [...TEST_A.universe, ...TEST_B.universe];
  const series = loadAll([...new Set(universe)], priceDir ?? undefined);
  const list = listDir || priceDir ? loadOwnerList((listDir ?? priceDir) as string) : null;
  const src = new CachedEngineSource(series, cache, runOptions);
  const tag = runOptions.macro ? '-v2' : '';
  for (const spec of specs) {
    let lastPct = -1;
    const t0 = performance.now();
    const o = await runTest(spec, series, src, (d, i, n) => {
      const p = Math.floor((i + 1) * 10 / n);
      if (p !== lastPct) { lastPct = p; io.err('Test ' + spec.name + ': ' + d + ' (' + (i + 1) + '/' + n + ')\n'); }
    });
    src.save();
    io.out(summaryText(o) + '\n');
    const label = runOptions.macro ? 'The system (v2, macro on)' : 'The system (v1, no macro)';
    io.out('\nHouse rule (after the ' + EXIT_TAX_PCT + ' tax; deepest fall from a high on the way):\n' + houseTable(houseRows(o, series, list, label), spec.cash) + '\n');
    if (!list) io.out('(' + LABELS.Research + ' are not loaded: --list-dir <dir> adds the hold-the-' + OWNER_BAG.length + ' rows.)\n');
    io.out('Wall time for Test ' + spec.name + ' (both walks and the benchmarks): ' + ((performance.now() - t0) / 1000).toFixed(0) + ' s.\n');
    if (o.engineMsPerCall != null) io.out('Engine time: ' + o.engineMsPerCall.toFixed(1) + ' ms per ticker run (' + o.engineCallsComputed + ' runs computed this process).\n\n');
    const fileName = spec.name.replace(/\s+/g, '-') + tag;
    if (tradelogDir) fs.writeFileSync(path.join(tradelogDir, 'v13-backtest-tradelog-test' + fileName + '-20261027.csv'), tradeLogCsv(o.taxed, o.vsQqq));
    if (jsonDir) {
      const slim = { spec: o.spec, benchmarks: o.benchmarks, engineMsPerCall: o.engineMsPerCall,
        taxed: { ...o.taxed, marks: undefined }, untaxed: { ...o.untaxed, marks: undefined, trades: undefined } };
      fs.writeFileSync(path.join(jsonDir, 'v13-backtest-result-test' + fileName + '-20261027.json'), JSON.stringify(slim, null, 1));
    }
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  backtestMain(process.argv.slice(2), { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) })
    .then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 1; });
}
