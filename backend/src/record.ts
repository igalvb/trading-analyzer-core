/**
 * `npm run record`: one live run with every HTTP exchange saved, for replay tests
 * (backlog recordings R-A1, R-N1, R-AI1). Memory mode only: the real spreadsheet is
 * never opened or written.
 *
 *   node --env-file-if-exists=.env src/record.ts analyze TSLA     R-A1: analyze one ticker (--no-ai)
 *   node --env-file-if-exists=.env src/record.ts nightly [TSLA]   R-N1: the nightly pipeline (--memory), watchlist seeded with TSLA if given
 *   node --env-file-if-exists=.env src/record.ts ai TSLA          R-AI1: the AI run (--memory), watchlist = TSLA, Buy report, Gemini only, low effort
 *   flags: --out DIR (default out/), --debug
 *
 * Writes <out>/v13-recording-<name>-<yyyymmdd>.json = { name, argv, seed, aiEnv, recordedAtMs, exitCode, exchanges }.
 * Key values in URLs are scrubbed as they are recorded (net/http.ts scrubUrl); before saving,
 * the whole recording is searched for the real key values and refused if one is found.
 * R-AI1 covers Gemini (it goes through the project's HTTP client). Claude Opus uses its own SDK and is not
 * recorded; the AI recording never selects it.
 *
 * Exit status: 0 when the recording was saved (the run itself may have ended partly),
 * 1 when it was refused or the run crashed, 2 on a usage error.
 */

import { finish } from './core/finish.ts';
import fs from 'node:fs';
import path from 'node:path';
import { LiveTransport, RecordingTransport, assertNoSecrets, type HttpTransport } from './net/http.ts';
import { main as cliMain, STD_IO, type CliIo } from './cli.ts';
import { nightlyMain } from './nightly.ts';
import { aiMain } from './ai.ts';
import { Tabs } from './sheets/tabs.ts';
import { formatDateInTz } from './core/dates.ts';
import { RESEARCH_DOWNLOAD, FRED_SERIES, fetchAll, fetchFredCsv } from './research/fetchPrices.ts';

export const RECORD_USAGE = 'usage: record analyze TICKER | record nightly [TICKER] | record ai TICKER | record prices   [--out DIR] [--debug]';

/** R-AI1's dispatch switches: the Buy report only (memory mode has no portfolio), Gemini only, low effort. */
export const RECORD_AI_ENV: Readonly<Record<string, string>> = { BUY: 'true', BUY_GEMINI: 'true', BUY_OPUS: 'false', EXIT: 'false', EXIT_GEMINI: 'false', EXIT_OPUS: 'false', EFFORT: 'low' };

/** The in-memory starting tabs: a one-ticker watchlist (header row, then the ticker). */
export function watchlistSeed(ticker: string): Record<string, unknown[][]> {
  return { [Tabs.WATCHLIST]: [['Ticker'], [ticker]] };
}

/** The env values that must never appear in a saved recording. */
export const RECORD_SECRET_NAMES: readonly string[] = [
  'FMP_API_KEY', 'ALPHAVANTAGE_KEY', 'FINNHUB_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'SEC_CONTACT_EMAIL',
];

export interface RecordOverrides {
  /** Tests: the transport under the recorder (default: the live network). */
  readonly inner?: HttpTransport;
  readonly clock?: { now(): number };
  /** Tests: the fetch under `record prices`. */
  readonly fetchImpl?: typeof fetch;
}

export async function recordMain(argv: readonly string[], io: CliIo = STD_IO, over: RecordOverrides = {}): Promise<number> {
  const env = io.env ?? process.env;
  const outAt = argv.indexOf('--out');
  const outDir = outAt >= 0 ? argv[outAt + 1] : 'out';
  const rest = outAt >= 0 ? [...argv.slice(0, outAt), ...argv.slice(outAt + 2)] : [...argv];
  const debug = rest.includes('--debug') ? ['--debug'] : [];
  const [cmd, tickerArg] = rest.filter((a) => !a.startsWith('--'));
  const ticker = (tickerArg ?? '').trim().toUpperCase();
  if (cmd === 'prices' && outDir) {
    // Strategy research: daily price history of RESEARCH_UNIVERSE plus James's extras (BTC-USD, ETH-USD, SOL-USD, IBIT,
    // SKHY, ASTS) and the FRED rates (DGS1), saved like a recording (no keys involved). research/unpackPrices.ts turns
    // it into one file per ticker (BTC-USD.json, ...).
    const nowMs = (over.clock ?? { now: () => Date.now() }).now();
    const fetchImpl = over.fetchImpl ?? globalThis.fetch;
    const series = await fetchAll(RESEARCH_DOWNLOAD, fetchImpl, nowMs, (m) => io.err(m + '\n'));
    const fred: Record<string, string> = {};
    for (const id of FRED_SERIES) {
      const csv = await fetchFredCsv(id, fetchImpl);
      io.err(id + ': ' + (csv ? csv.trim().split('\n').length - 1 + ' rows' : 'NOT FETCHED') + '\n');
      if (csv) fred[id] = csv;
    }
    const file = path.join(outDir, 'v13-recording-prices-' + formatDateInTz(new Date(nowMs), 'America/New_York').replace(/-/g, '') + '.json');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name: 'prices', series, fred }) + '\n');
    io.err('Price history saved: ' + file + ' (' + series.length + ' of ' + RESEARCH_DOWNLOAD.length + ' tickers)\n');
    return series.length ? 0 : 1;
  }
  if (!outDir || !(cmd === 'analyze' || cmd === 'nightly' || cmd === 'ai') || (cmd !== 'nightly' && !ticker)) {
    io.err(RECORD_USAGE + '\n');
    return 2;
  }
  const clock = over.clock ?? { now: () => Date.now() };
  const recordedAtMs = clock.now();
  const transport = new RecordingTransport(over.inner ?? new LiveTransport());
  const runArgv = cmd === 'analyze' ? ['analyze', ticker, '--no-ai', ...debug] : ['--memory', ...debug];
  const seed = cmd !== 'analyze' && ticker ? watchlistSeed(ticker) : null;
  const aiEnv = cmd === 'ai' ? RECORD_AI_ENV : null;
  const exitCode = cmd === 'analyze'
    ? await cliMain(runArgv, io, { transport, clock })
    : cmd === 'nightly'
      ? await nightlyMain(runArgv, io, { transport, clock, ...(seed ? { initialTabs: seed } : {}) })
      : await aiMain(runArgv, { ...io, env: { ...env, ...RECORD_AI_ENV } }, { transport, clock, initialTabs: seed ?? {} });
  const exchanges = transport.exchanges();
  try {
    assertNoSecrets(exchanges, RECORD_SECRET_NAMES.map((n) => String(env[n] ?? '')));
  } catch (e) {
    io.err('Recording refused: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    return 1;
  }
  const name = cmd + (ticker ? '-' + ticker.toLowerCase().replace(/[^a-z0-9]+/g, '') : '');
  const file = path.join(outDir, 'v13-recording-' + name + '-' + formatDateInTz(new Date(recordedAtMs), 'America/New_York').replace(/-/g, '') + '.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name, argv: runArgv, seed, aiEnv, recordedAtMs, exitCode, exchanges }) + '\n');
  io.err('Recording saved: ' + file + ' (' + exchanges.length + ' exchanges, run exit ' + exitCode + ')\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  recordMain(process.argv.slice(2)).then((code) => { finish(code); }, (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); finish(1); });
}
