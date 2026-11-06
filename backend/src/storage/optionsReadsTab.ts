/**
 * Options sentiment plan (docs/OPTIONS_SENTIMENT_PLAN.md) A-3 and part B: the append-only tabs of the nightly options
 * reads, through the TabStore (the data sheet), one block per night, never written twice (paperLog.ts appendNight):
 *
 *   📈 Options Reads              one light row per stock per night: the read, the P0 checks, the A-5 gate and the
 *                                 shadow columns (A-8 "if applied", C-2 delta-dollar net bias, C-3 tech without options)
 *   📦 Options Read Snapshots     the read itself as JSON (scored contracts: side, strike, expiry, OI, vol, iv, $ and
 *                                 scores), split into parts when longer than a cell may hold
 *   🌐 Market Options Read        part B: one row per ETF (SPY, QQQ) per night; display only
 *
 * The A-5 fallback reads the latest read per stock from the property store ('OPTIONS_READ_LAST_' + ticker, written
 * with the night), not from the snapshot tab: that tab grows by ~20 rows a night and is never read back whole.
 */

import type { TabCell, TabStore } from './tabStore.ts';
import { cacheGet, cacheSet, SHEET_CELL_CHAR_LIMIT, type PropertyStore } from './kv.ts';
import { appendNight } from '../paper/paperLog.ts';
import type { GatedRead, OptionsRead, OptionsShadow } from '../analysis/options/nightlyRead.ts';
import { OPTIONS_READ_APPLIED } from '../analysis/options/nightlyRead.ts';
import type { MarketOptionsRead } from '../analysis/options/marketRead.ts';
import type { MeasuresScore, OptionsMeasures } from '../analysis/options/measures.ts';

export const OPTIONS_READS_TAB = '📈 Options Reads';
export const OPTIONS_READ_SNAPSHOTS_TAB = '📦 Options Read Snapshots';
export const MARKET_OPTIONS_TAB = '🌐 Market Options Read';
/** Longest text written to one cell. */
export const OPTIONS_SNAPSHOT_CELL_CHARS = 40_000;
export const OPTIONS_READ_LAST_KEY = 'OPTIONS_READ_LAST_';
export const OPTIONS_READ_LAST_TTL_HOURS = 24 * 10;

export const OPTIONS_READS_HEADER: readonly string[] = [
  'Day', 'Ticker', 'Status', 'As-of UTC', 'Cboe time', 'Spot', 'Total volume (chain)', 'Market-closed formula', 'Contracts in chain', 'Contracts scored',
  'Delta present', 'IV present', 'JSON chars', 'Parse ms', 'P/C OI', 'P/C volume', 'Net $ bias %', 'pcSig', 'domSig', 'nbSig', 'dirSig', 'LEAPS lean',
  'LEAPS sides', 'Chain IV percentile', 'Front IV', 'Back IV', 'Term note',
  'Read used', 'Read day used', 'Age (trading days)', 'Gate', 'Applied',
  'If applied: options', 'Tech now', 'Tech if applied', 'Conviction now', 'Conviction if applied', 'Timing now', 'Timing if applied', 'Action now', 'Action if applied',
  'C-2 net $ bias % (delta $)', 'C-2 basis', 'C-2 nbSig', 'C-2 dirSig', 'C-2 options', 'C-3 tech without options', 'C-3 options',
];
export const OPTIONS_READ_SNAPSHOTS_HEADER: readonly string[] = ['Day', 'Ticker', 'Part', 'Read (JSON)'];
export const MARKET_OPTIONS_HEADER: readonly string[] = [
  'Day', 'ETF', 'Status', 'Spot', 'P/C OI', 'P/C OI ≤60d', 'P/C volume', 'Total volume', 'Skew (vol pts)', 'Skew method', '~30-day expiry',
  'ATM IV ~30d', 'ATM IV ~90d', 'ATM IV ~1y', 'Term 30d ÷ 1y', 'Term', 'RV20', 'IV 30d ÷ RV20', 'IV 30d percentile (stored nights)', 'Nights stored',
  'VIX', 'VIX in 52-week range %', 'SPY IV − VIX (pts)', 'Check', 'Read', 'JSON chars', 'Parse ms',
];

const c = (v: unknown): TabCell => (v == null ? '' : typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 10_000) / 10_000 : '') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

/** One light row (📈 Options Reads). `read` is tonight's (or the "no chain" placeholder); `gated` what the gate chose. */
export function optionsReadRow(read: OptionsRead, gated: GatedRead, shadow: OptionsShadow | null): TabCell[] {
  const ctx = read.context, s = read.signals, ch = read.checks;
  const leapsSides = s ? [s.leapsCalls ? 'calls' : '', s.leapsPuts ? 'puts' : ''].filter(Boolean).join(' + ') || 'none' : '';
  return [
    read.day, read.ticker, read.status, read.asOfUtc, read.cboeTime, read.spot, ch.totalVolume, read.status === 'ok' ? read.marketClosed : '', ch.contracts, read.rows.length,
    ch.withDelta, ch.withIv, ch.bytes, ch.parseMs, ctx?.putCallRatioOI, ctx?.putCallRatioVol, ctx?.netBiasPct, s?.pcSig, s?.domSig, s?.nbSig, s?.dirSig, s?.leapsLean,
    leapsSides, ctx?.ivRankPct, ctx?.frontIV, ctx?.backIV, ctx?.termNote,
    gated.source, gated.read?.day, gated.ageTradingDays, gated.read ? (gated.fresh ? 'ok' : gated.note) : gated.note, OPTIONS_READ_APPLIED ? 'yes' : 'no (shadow)',
    shadow ? shadow.confirm.toUpperCase() : '', shadow?.techNow, shadow?.techIfApplied, shadow?.convictionNow, shadow?.convictionIfApplied,
    shadow?.timingNow, shadow?.timingIfApplied, shadow?.actionNow, shadow?.actionIfApplied,
    read.c2?.netBiasPct, read.c2?.basis, read.c2?.nbSig, read.c2?.dirSig, shadow?.c2Confirm ? shadow.c2Confirm.toUpperCase() : '',
    shadow?.techExOptions, shadow ? shadow.c3Confirm.toUpperCase() : '',
  ].map(c);
}

/** A read as snapshot rows: one row, or several parts when its JSON is longer than a cell may hold. Empty for no contracts. */
export function optionsSnapshotRows(r: OptionsRead): TabCell[][] {
  if (r.status !== 'ok') return [];
  const text = JSON.stringify(r), parts: string[] = [];
  for (let i = 0; i < text.length; i += OPTIONS_SNAPSHOT_CELL_CHARS) parts.push(text.slice(i, i + OPTIONS_SNAPSHOT_CELL_CHARS));
  return parts.map((p, i) => [r.day, r.ticker, (i + 1) + '/' + parts.length, p]);
}

/** Reads snapshot rows back (parts joined): ticker -> day -> read. */
export function readOptionsSnapshotRows(rows: readonly (readonly TabCell[])[]): Map<string, Map<string, OptionsRead>> {
  const parts = new Map<string, string[]>();
  for (const r of rows) {
    const [day, t, part, text] = r.map((x) => String(x ?? '')) as [string, string, string, string];
    const m = /^(\d+)\/(\d+)$/.exec(part);
    if (!m) continue;
    const k = day + '|' + t, xs = parts.get(k) ?? Array<string>(Number(m[2])).fill('');
    xs[Number(m[1]) - 1] = text;
    parts.set(k, xs);
  }
  const out = new Map<string, Map<string, OptionsRead>>();
  for (const [k, xs] of parts) {
    if (xs.some((x) => !x)) continue;
    const [day, t] = k.split('|') as [string, string];
    try { (out.get(t) ?? out.set(t, new Map()).get(t)!).set(day, JSON.parse(xs.join('')) as OptionsRead); } catch { /* a damaged row is skipped */ }
  }
  return out;
}

export function marketOptionsRow(r: MarketOptionsRead): TabCell[] {
  return [
    r.day, r.etf, r.status, r.spot, r.pcOi, r.pcOi60, r.pcVol, r.totalVolume, r.skewPts, r.skewMethod, r.exp30,
    r.iv30, r.iv90, r.iv365, r.termRatio, r.term, r.rv20, r.ivVsRv, r.ivPct, r.nights,
    r.vix, r.vixRangePct, r.vixGapPts, r.check, r.read, r.bytes, r.parseMs,
  ].map(c);
}

/** 📈 + 📦: tonight's block (rows written once per day). Returns the light rows written (0 = already stored). */
export async function recordOptionsReads(store: TabStore, day: string, light: readonly TabCell[][], reads: readonly OptionsRead[]): Promise<number> {
  const written = await appendNight(store, OPTIONS_READS_TAB, OPTIONS_READS_HEADER, day, light);
  const snaps = reads.flatMap(optionsSnapshotRows);
  if (snaps.length) await appendNight(store, OPTIONS_READ_SNAPSHOTS_TAB, OPTIONS_READ_SNAPSHOTS_HEADER, day, snaps);
  return written;
}

/** 🌐: tonight's rows (only ETFs that had a chain); 0 when none or already stored. */
export async function recordMarketOptions(store: TabStore, day: string, reads: readonly MarketOptionsRead[]): Promise<number> {
  const ok = reads.filter((r) => r.status === 'ok');
  if (!ok.length) return 0;
  return appendNight(store, MARKET_OPTIONS_TAB, MARKET_OPTIONS_HEADER, day, ok.map(marketOptionsRow));
}

/** 🌐 history: ETF -> the stored rows' ATM 30d IV (oldest first), and the latest night's rows. */
export async function readMarketOptions(store: TabStore): Promise<{ ivHistory: Map<string, number[]>; latest: MarketOptionsRead[] }> {
  const rows = (await store.read(MARKET_OPTIONS_TAB, MARKET_OPTIONS_HEADER.length)) ?? [];
  const ivHistory = new Map<string, number[]>();
  const body = rows.slice(1).filter((r) => String(r[0] ?? '') !== '');
  const at = (k: string): number => MARKET_OPTIONS_HEADER.indexOf(k);
  for (const r of body) {
    const iv = Number(r[at('ATM IV ~30d')]);
    if (String(r[at('Status')]) === 'ok' && Number.isFinite(iv) && iv > 0 && r[at('ATM IV ~30d')] !== '') (ivHistory.get(String(r[1])) ?? ivHistory.set(String(r[1]), []).get(String(r[1]))!).push(iv);
  }
  const lastDay = body.length ? String(body[body.length - 1]![0]) : null;
  const n = (v: TabCell | undefined): number | null => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const s = (v: TabCell | undefined): string => String(v ?? '');
  const latest = body.filter((r) => String(r[0]) === lastDay).map((r): MarketOptionsRead => ({
    day: s(r[0]), etf: s(r[1]), status: s(r[2]) === 'ok' ? 'ok' : 'no chain', spot: n(r[3]), pcOi: n(r[4]), pcOi60: n(r[5]), pcVol: n(r[6]), totalVolume: n(r[7]) ?? 0,
    skewPts: n(r[8]), skewMethod: (s(r[9]) || 'none') as MarketOptionsRead['skewMethod'], exp30: s(r[10]) || null, iv30: n(r[11]), iv90: n(r[12]), iv365: n(r[13]),
    termRatio: n(r[14]), term: (s(r[15]) || 'n/a') as MarketOptionsRead['term'], rv20: n(r[16]), ivVsRv: n(r[17]), ivPct: n(r[18]), nights: n(r[19]) ?? 0,
    vix: n(r[20]), vixRangePct: n(r[21]), vixGapPts: n(r[22]), check: s(r[23]) as MarketOptionsRead['check'], read: (s(r[24]) || 'n/a') as MarketOptionsRead['read'],
    bytes: n(r[25]), parseMs: n(r[26]),
  }));
  return { ivHistory, latest };
}

/** A-5 fallback store: the latest read per stock (skipped, with false, when its JSON would not fit one cell). */
export async function saveLatestRead(kv: PropertyStore, r: OptionsRead, nowMs: number): Promise<boolean> {
  if (r.status !== 'ok') return false;
  const size = JSON.stringify(r).length;
  if (size > SHEET_CELL_CHAR_LIMIT - 1000) return false;
  return cacheSet(kv, OPTIONS_READ_LAST_KEY + r.ticker.toUpperCase(), r, OPTIONS_READ_LAST_TTL_HOURS, nowMs);
}

export async function loadLatestRead(kv: PropertyStore, ticker: string, nowMs: number): Promise<OptionsRead | null> {
  const r = await cacheGet<OptionsRead>(kv, OPTIONS_READ_LAST_KEY + ticker.toUpperCase(), nowMs);
  return r && r.v === 1 && r.status === 'ok' ? r : null;
}

// ───────────── 📐 Options Measures (options weights due diligence 2026-11-06): one row per stock per night ─────────────

export const OPTIONS_MEASURES_TAB = '📐 Options Measures';
export const OPTIONS_MEASURES_HEADER: readonly string[] = [
  'Day', 'Ticker', 'Spot', '~30d expiry (days)', 'Smirk (vol pts)', 'ATM call IV ~30d', 'ATM put IV ~30d', 'IV spread call−put (vol pts)',
  'Option volume', 'Stock volume', 'O/S', 'Call OI', 'Put OI', 'P/C OI', 'LEAPS IV', '1-year realised vol',
  'Nights of history', 'Smirk', 'Smirk pts', 'IV change', 'IV change pts', 'IV spread', 'IV spread conf pts', 'O/S', 'O/S conf pts', 'ΔOI P/C top fifth (shadow)',
  'Conviction pts (capped)', 'Entry conf pts (capped)', 'BUY_NOW delay (shadow)',
];

const MEASURE_FIELDS = ['day', 'ticker', 'spot', 'expDays', 'smirk', 'atmCallIv', 'atmPutIv', 'ivSpread', 'optVolume', 'stockVolume', 'osRatio', 'callOi', 'putOi', 'pcOi', 'leapsIv', 'rv1y'] as const;

/** One 📐 row: tonight's measures and their points. */
export function optionsMeasuresRow(m: OptionsMeasures, s: MeasuresScore | null): TabCell[] {
  return [
    ...MEASURE_FIELDS.map((k) => m[k]),
    s?.nights, s?.smirk.state, s?.smirk.pts, s?.ivChange.state, s?.ivChange.pts, s?.ivSpread.state, s?.ivSpread.pts, s?.os.state, s?.os.pts, s ? s.oiBuild : '',
    s?.convictionPts, s?.entryConfidencePts, s ? s.delayShadow : '',
  ].map(c);
}

/** 📐 history: ticker -> the stored nights (oldest first). */
export async function readOptionsMeasures(store: TabStore): Promise<Map<string, OptionsMeasures[]>> {
  const rows = (await store.read(OPTIONS_MEASURES_TAB, MEASURE_FIELDS.length)) ?? [];
  const out = new Map<string, OptionsMeasures[]>();
  const n = (v: TabCell | undefined): number | null => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  for (const r of rows.slice(1)) {
    const day = String(r[0] ?? ''), t = String(r[1] ?? '').toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !t) continue;
    const m: OptionsMeasures = {
      day, ticker: t, spot: n(r[2]), expDays: n(r[3]), smirk: n(r[4]), atmCallIv: n(r[5]), atmPutIv: n(r[6]), ivSpread: n(r[7]),
      optVolume: n(r[8]) ?? 0, stockVolume: n(r[9]), osRatio: n(r[10]), callOi: n(r[11]) ?? 0, putOi: n(r[12]) ?? 0, pcOi: n(r[13]), leapsIv: n(r[14]), rv1y: n(r[15]),
    };
    (out.get(t) ?? out.set(t, []).get(t)!).push(m);
  }
  for (const xs of out.values()) xs.sort((a, b) => a.day.localeCompare(b.day));
  return out;
}

/** 📐: tonight's rows (written once per day). Returns the rows written (0 = already stored). */
export async function recordOptionsMeasures(store: TabStore, day: string, rows: readonly TabCell[][]): Promise<number> {
  return rows.length ? appendNight(store, OPTIONS_MEASURES_TAB, OPTIONS_MEASURES_HEADER, day, rows) : 0;
}
