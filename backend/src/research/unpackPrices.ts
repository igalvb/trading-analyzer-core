/**
 * `node src/research/unpackPrices.ts <v13-recording-prices-*.json[.gz]> <outDir>`: turns one `record prices`
 * recording (fetchPrices.ts) into the research price folder: one `<TICKER>.json` per series in the
 * legacy/historical_data shape (named by backtest/data.ts `priceFileName`, so spot bitcoin lands in `BTC-USD.json`
 * and never overwrites `BTC.json`, the Grayscale Mini Trust fund), and one `<id>.csv` per FRED series (`dgs1.csv`).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { priceFileName } from '../backtest/data.ts';
import type { RawSeries } from './fetchPrices.ts';

export interface PricesRecording { readonly name: 'prices'; readonly series: readonly RawSeries[]; readonly fred?: Readonly<Record<string, string>> }

/** The files a recording unpacks into: file name -> content. */
export function priceFiles(rec: PricesRecording): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of rec.series) out.set(priceFileName(s.ticker), JSON.stringify({ ...s, barCount: s.dates.length }));
  for (const [id, csv] of Object.entries(rec.fred ?? {})) out.set(id.toLowerCase() + '.csv', csv);
  return out;
}

function main(): void {
  const [file, outDir] = process.argv.slice(2) as [string, string];
  if (!file || !outDir) { process.stderr.write('usage: unpackPrices.ts <recording.json[.gz]> <outDir>\n'); process.exitCode = 2; return; }
  const raw = fs.readFileSync(file);
  const rec = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8')) as PricesRecording;
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, text] of priceFiles(rec)) { fs.writeFileSync(path.join(outDir, name), text); process.stderr.write(name + '\n'); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
