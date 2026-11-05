/**
 * The options run, its diagnostics and the readers of what it writes,
 * ported from futuresStockAnalysisV3_3_11.gs:
 *   runFullAnalysis :235-385, diagnose :168-230,
 *   showRecommendedCallV7Continued :570-632 (recommendedCallReport)
 * and from fullStockAnalysisV10_9.gs:
 *   readOptionsOverlay :8741-8760, readOptionsSnapshotV7 :8788-8812, fmtExpiryV7_ :8817-8823
 *
 * The run log goes to the '🔬 Log' tab exactly as legacy wrote it (cleared,
 * one line per row, "h:mm:ss AM  message" in the script's zone). Legacy's
 * SpreadsheetApp.flush() every third line has no equivalent: the workbook
 * is flushed once, by the caller, after the run.
 *
 * fetchEarningsCalendarV7(ticker, log).next is the injected
 * `fetchNextEarnings` (production: fetch/fundamentals/providers.ts
 * fetchEarningsCalendar(...).then(c => c.next)); a throw is ignored, as in
 * legacy.
 */

import type { Clock } from '../../core/context.ts';
import { wallClockInTz, occExpiryText } from '../../core/dates.ts';
import { dateStringInTz } from '../../analysis/macroRegime.ts';
import { cboeUrl, fetchChain, fetchCboeRaw, parseOcc, type CboeDeps } from '../../fetch/cboe.ts';
import { attachLeapsExpiryComparison, buildLeapsExpiryComparison } from '../../analysis/options/leapsExpiryTable.ts';
import { attachJamesCalls, jamesCallsOf } from '../../analysis/options/leapsPick.ts';
import {
  computeChainContext, isLeaps, parseAndScore, saveOptionsOverlay, selectRecommendedCall,
  type OptionsScoringDeps, type RecommendedCall,
} from '../../analysis/options/conviction.ts';
import { elapsed } from '../../analysis/options/futuresHelpers.ts';
import { MIN_DAYS_FOR_IV_CONTEXT, pickLabel } from '../../analysis/options/labels.ts';
import type { OptionsSnapshot, SnapshotContract } from '../../analysis/options/scoring.ts';
import type { ReportWorkbook } from '../../sheets/reportSheet.ts';
import type { TabCell } from '../../storage/tabStore.ts';
import {
  buildBucketBreakdown, buildCallTable, buildDashboard, buildGammaWall, buildPutTable, buildTop10, getOrCreate, saveOptionsSnapshot,
  DEFAULT_TICKER, OPTIONS_SNAPSHOT_SHEET, OptionsTabs, localeString, type NextEarnings, type ReportTime,
} from './tabs.ts';

export type OptionsRunLog = (message: string) => void;

export interface OptionsReportDeps extends CboeDeps, OptionsScoringDeps {
  readonly workbook: ReportWorkbook;
  readonly clock?: Clock;
  /** fetchEarningsCalendarV7(ticker, log).next. */
  readonly fetchNextEarnings: (ticker: string, log: OptionsRunLog | null) => Promise<NextEarnings | null | undefined>;
  /** SpreadsheetApp.getUi().alert (CLI: print). */
  readonly alert?: (text: string) => void;
  /** Legacy's exact tab layout (parity tests). Unset = the fixes (D16: the strike list written once, merged). */
  readonly legacyReportText?: boolean;
}

const nowOf = (d: { readonly clock?: Clock }): number => (d.clock ? d.clock.now() : Date.now());
const timeOf = (d: OptionsReportDeps): ReportTime => ({ nowMs: nowOf(d), timeZone: d.timeZone, legacyText: !!d.legacyExpiryLabel });

export interface OptionsRunResult {
  readonly leapsCall: RecommendedCall;
  readonly shortTermCall: RecommendedCall;
}

/** runFullAnalysis (:235-385): fetch, score, the six report tabs, the snapshot and the overlay. */
export async function runFullAnalysis(deps: OptionsReportDeps, targetTicker?: unknown): Promise<OptionsRunResult | undefined> {
  const ticker = (typeof targetTicker === 'string' && targetTicker.length > 0) ? targetTicker : DEFAULT_TICKER;
  const ss = deps.workbook;
  const start = nowOf(deps);
  const logSh = getOrCreate(ss, OptionsTabs.LOG);
  logSh.clearContents();
  let logRow = 1;
  const log = (msg: string): void => {
    logSh.getRange(logRow++, 1).setValue(new Date(nowOf(deps)).toLocaleTimeString('en-US', { timeZone: deps.timeZone }) + '  ' + msg);
  };

  log('▶ Started — ' + ticker + ' full chain via CBOE  [v3.1]');

  const raw = await fetchChain(deps, 730, ticker, log);
  if (!raw) { log('❌ CBOE fetch failed — run 🔬 Diagnose (check the ticker symbol / network)'); return undefined; }
  log('✅ ' + raw.strike.length + ' contracts returned' +
      (raw.underlying ? ' (underlying $' + raw.underlying + ')' : '') + '  [' + elapsed(start, nowOf(deps)) + ']');

  log('⚙️  Scoring...');
  const contracts = await parseAndScore(deps, raw, log, ticker);
  log('Scored ' + contracts.length + ' valid contracts  [' + elapsed(start, nowOf(deps)) + ']');

  if (contracts.length === 0) {
    log('❌ Zero scored. Possible: all OI=0, ATM filter too tight, or API fields changed.');
    return undefined;
  }

  const totalVol = contracts.reduce((s, c) => s + c.vol, 0);
  const mktClosed = totalVol === 0;
  log('Market ' + (mktClosed ? 'CLOSED (vol=0 — holding/urgency disabled)' : 'OPEN'));

  log('── Conviction verification (top 5 calls) ──');
  contracts.filter((c) => c.side === 'call').slice(0, 5).forEach((c, i) => {
    const expected = isLeaps(c.bucket)
      ? Math.round(c.dollarScore * 0.45 + c.holdingScore * 0.30 + (c.oiPersistenceScore as number) * 0.15 + c.ivScore * 0.10)
      : mktClosed
        ? Math.round(c.dollarScore * 0.70 + c.timeScore * 0.20 + c.ivScore * 0.10)
        : Math.round(c.dollarScore * 0.50 + c.holdingScore * 0.20 + c.urgencyScore * 0.15 + c.timeScore * 0.10 + c.ivScore * 0.05);
    const match = expected === c.conviction ? '✅' : '⚠️ MISMATCH';
    log((i + 1) + '. $' + c.strike + ' | $Score=' + c.dollarScore + ' Hold=' + c.holdingScore +
        ' Urg=' + c.urgencyScore + ' Time=' + c.timeScore + ' IV=' + c.ivScore +
        (isLeaps(c.bucket) ? ' OIPers=' + c.oiPersistenceScore + (c.oiPersistenceIsFirstRun ? ' (first run, no history)' : '') : '') +
        ' | stored=' + c.conviction + ' computed=' + expected + ' ' + match);
  });

  const topC = contracts.filter((c) => c.side === 'call').slice(0, 3);
  const topP = contracts.filter((c) => c.side === 'put').slice(0, 3);
  log('Top calls: ' + topC.map((c) => '$' + c.strike + ' $' + Math.round(c.dollarsCommitted / 1e6) + 'M conv=' + c.conviction).join(' | '));
  log('Top puts:  ' + topP.map((c) => '$' + c.strike + ' $' + Math.round(c.dollarsCommitted / 1e6) + 'M conv=' + c.conviction).join(' | '));

  log('🏆 Building Top 10...');
  const leapsCall = await selectRecommendedCall(deps, ticker, 0.75, true, log);
  const shortTermCall = await selectRecommendedCall(deps, ticker, 0.50, false, log);
  // Owner 2026-10-30: the LEAPS expiry comparison for the 📞 Options Decision page (display only; the memoised chain). Not in parity runs.
  if (!deps.legacyExpiryLabel) {
    try { attachLeapsExpiryComparison(leapsCall, buildLeapsExpiryComparison(await fetchCboeRaw(deps, ticker), nowOf(deps), deps.timeZone)); }
    catch (e) { log('⚠️ LEAPS expiry comparison skipped: ' + (e as Error).message); }
    // James — LEAPS / Option Fair Value (phase 4, display only): the chain's calls for the 🎯 and ⚖️ pages (the memoised chain)
    try { const raw = await fetchCboeRaw(deps, ticker); const sp = Number(raw?.data?.current_price); attachJamesCalls(leapsCall, jamesCallsOf(raw), Number.isFinite(sp) && sp > 0 ? sp : null); }
    catch (e) { log('⚠️ James — LEAPS chain skipped: ' + (e as Error).message); }
  }
  let nextEarnings: NextEarnings | null = null;
  try { nextEarnings = (await deps.fetchNextEarnings(ticker, log)) ?? null; } catch { /* non-fatal */ }
  const t = timeOf(deps);
  buildTop10(ss, contracts, ticker, leapsCall, shortTermCall, nextEarnings, t, { mergeTextRows: deps.legacyReportText === false });
  // D5: outside parity runs, contracts with < 7 days left stay out of the front IV / term structure / IV percentile.
  const chainContext = computeChainContext(contracts.fullChain || contracts, { minIvDays: deps.legacyExpiryLabel ? 0 : MIN_DAYS_FOR_IV_CONTEXT });
  log('📋 Building Dashboard...'); buildDashboard(ss, contracts, ticker, timeOf(deps), chainContext.putCallRatioOI);
  log('📞 Building CALL Table...'); buildCallTable(ss, contracts, ticker);
  log('📉 Building PUT Table...'); buildPutTable(ss, contracts, ticker);
  log('🧱 Building Gamma Wall...'); buildGammaWall(ss, contracts, ticker);

  log('📆 Building Near/Mid/LEAPS Breakdown...'); buildBucketBreakdown(ss, contracts, ticker, chainContext, timeOf(deps));
  log('Chain context — Put/Call OI=' + (chainContext.putCallRatioOI != null ? chainContext.putCallRatioOI.toFixed(2) : 'N/A') +
      (deps.legacyExpiryLabel ? '  IV%ile=' : '  IV vs this chain (percentile)=') + (chainContext.ivRankPct != null ? chainContext.ivRankPct : 'N/A') +
      '  ' + chainContext.termNote + '  ' + chainContext.netBiasNote);

  try { saveOptionsSnapshot(ss, ticker, contracts, chainContext, raw.underlying || null, timeOf(deps)); log('💾 Full options snapshot saved (' + contracts.length + ' contracts)'); }
  catch (e) { log('⚠️ Snapshot save skipped: ' + (e as Error).message); }

  await saveOptionsOverlay(deps, ticker, contracts, chainContext, log);

  log('✅ Done in ' + elapsed(start, nowOf(deps)));

  (ss.getSheetByName(OptionsTabs.TOP10) as NonNullable<ReturnType<ReportWorkbook['getSheetByName']>>).activate();
  return { leapsCall, shortTermCall };
}

/** diagnose (:168-230): one Cboe call for DEFAULT_TICKER, reported on the '🔬 Log' tab. */
export async function diagnose(deps: OptionsReportDeps): Promise<void> {
  const ss = deps.workbook;
  let sh = ss.getSheetByName(OptionsTabs.LOG);
  if (!sh) sh = ss.insertSheet(OptionsTabs.LOG);
  sh.clearContents();
  sh.activate();
  const target = sh;
  const w = (row: number, label: string, value: unknown): void => {
    target.getRange(row, 1).setValue(label);
    target.getRange(row, 2).setValue(String(value));
  };

  w(1, 'OPTIONS DIAGNOSTIC v3.1 (CBOE)', localeString(timeOf(deps)));
  w(2, 'Ticker Tested', DEFAULT_TICKER);
  w(3, 'Source', 'CBOE delayed quotes — keyless, full chain');

  const url = cboeUrl(DEFAULT_TICKER);
  w(4, 'URL', url);
  w(5, 'Status', 'Calling CBOE...');

  try {
    const resp = await deps.http.fetch({ url, muteHttpExceptions: true });
    const code = resp.status;
    const body = resp.text();
    w(6, 'HTTP code', code);
    w(7, 'Response size (bytes)', body.length);
    if (code === 200) {
      const json = JSON.parse(body);
      const opts = (json.data && json.data.options) || [];
      w(8, 'Underlying price', json.data ? json.data.current_price : 'N/A');
      w(9, 'Contracts returned', opts.length);
      if (opts.length > 0) {
        const p = parseOcc(opts[0].option);
        w(10, 'Sample contract 1', [
          opts[0].option,
          'strike=' + p.strike,
          'side=' + p.side,
          'exp=' + (deps.legacyExpiryLabel ? new Date(p.expUnix * 1000).toLocaleDateString('en-US', { timeZone: deps.timeZone }) : occExpiryText(p.expUnix)),
          'vol=' + opts[0].volume,
          'OI=' + opts[0].open_interest,
          'iv=' + opts[0].iv,
        ].join(' | '));
        w(11, 'RESULT', '✅ CBOE working — run Full Analysis');
      } else {
        w(11, 'RESULT', '❌ No contracts — check the ticker symbol');
      }
    } else {
      w(8, 'First 300 chars', body.substring(0, 300));
      w(9, 'RESULT', '❌ HTTP ' + code + ' — bad ticker or CBOE unreachable');
    }
  } catch (e) {
    w(6, 'EXCEPTION', (e as Error).message);
    w(7, 'RESULT', '❌ API call failed — timeout or network blocked');
  }

  target.setColumnWidth(1, 240);
  target.setColumnWidth(2, 620);
}

/** showRecommendedCallV7Continued (:570-632): the LEAPS and short-term picks as text; shown via `alert`. */
export async function recommendedCallReport(deps: OptionsReportDeps, tickerIn: unknown): Promise<string> {
  const ticker = String(tickerIn).toUpperCase().trim();
  const lines = ['📞 Recommended Call — ' + ticker, ''];

  let nextEarnings: NextEarnings | null = null;
  try { nextEarnings = (await deps.fetchNextEarnings(ticker, null)) ?? null; } catch { /* non-fatal */ }

  const describeResult = (label: string, result: RecommendedCall, targetDelta: number): void => {
    lines.push(label + ':');
    if (!result.found) { lines.push('  Not found: ' + result.reason); lines.push(''); return; }
    const c = result.contract;
    const expDate = new Date(c.expUnix * 1000);
    lines.push('  ✅ PICKED: $' + c.strike + ' call, exp ' + (deps.legacyExpiryLabel ? dateStringInTz(expDate, deps.timeZone) : occExpiryText(c.expUnix)));
    lines.push('  Delta: ' + c.delta.toFixed(2) + ' (target ' + targetDelta.toFixed(2) + ')   IV: ' + (c.iv ? (c.iv * 100).toFixed(1) + '%' : 'N/A') + '   Bid/Ask: $' + c.bid.toFixed(2) + '/$' + c.ask.toFixed(2));
    const nextEarningsDate = nextEarnings ? new Date(nextEarnings.dateStr + 'T00:00:00Z') : null;
    if (nextEarningsDate && nextEarningsDate < expDate) {
      const daysToEarnings = Math.round((nextEarningsDate.getTime() - nowOf(deps)) / (1000 * 60 * 60 * 24));
      lines.push('  ⚠ Next earnings (' + (nextEarnings as NextEarnings).dateStr + ', ~' + daysToEarnings + ' days) falls BEFORE this expiry -- holding through an earnings event, real IV-crush/gap risk.');
    }
    lines.push('');
    lines.push('  Other strikes considered at this same expiry, closest by delta first:');
    const shown = result.allCandidates.slice(0, 6);
    shown.forEach((c2) => {
      const marker = (c2.strike === c.strike) ? ' ← PICKED' : '';
      lines.push('    $' + c2.strike + '  delta ' + c2.delta.toFixed(2) + '  (Δ' + c2.deltaDistance.toFixed(2) + ' from target)  bid/ask $' + c2.bid.toFixed(2) + '/$' + c2.ask.toFixed(2) + marker);
    });
    if (result.allCandidates.length > 6) lines.push('    ...and ' + (result.allCandidates.length - 6) + ' more strikes at this expiry, not shown here.');
    lines.push('');
  };

  const leaps = await selectRecommendedCall(deps, ticker, 0.75, true, null);
  describeResult(deps.legacyExpiryLabel ? 'LEAPS (target delta 0.75)' : pickLabel(true, 0.75), leaps, 0.75);
  const shortTerm = await selectRecommendedCall(deps, ticker, 0.50, false, null);
  describeResult(deps.legacyExpiryLabel ? 'Short-term (target delta 0.50)' : pickLabel(false, 0.50), shortTerm, 0.50);
  lines.push('');
  lines.push('⚠ Note: delta field assumed present based on secondary evidence, never independently confirmed firsthand.');
  const seen = (r: RecommendedCall): boolean => (r as { deltaFieldSeen?: boolean }).deltaFieldSeen === true;
  lines.push('Delta field actually seen in this response: ' + (seen(leaps) || seen(shortTerm) ? 'YES — assumption confirmed' : 'NO — assumption was WRONG, needs investigating'));
  lines.push('');
  lines.push('This is contract SELECTION only (Section 2a). Expiry choice is a simple placeholder (furthest/nearest available), not yet tied to real price targets (Section 2b). IV-based conviction adjustment (2c) not wired in yet.');

  const text = lines.join('\n');
  if (deps.alert) deps.alert(text);
  return text;
}

const SHEETS_DATE_LABEL = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * fmtExpiryV7_ (:8817-8823): a Date as "Aug 21 '26" (local fields, the
 * script's zone); anything else as a string. F-68: legacy's snapshot cells
 * held labels like 'Aug 21, 2026' that Sheets had parsed into Dates on
 * write; the port writes RAW, so such a label is read back as text --
 * `sheetsParsedLabels` (default true) renders it exactly as the parsed Date
 * would have been.
 */
export function fmtExpiry(v: unknown, timeZone: string, sheetsParsedLabels = true): string {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const w = wallClockInTz(v.getTime(), timeZone);
    return MONTHS[w.month - 1] + ' ' + w.day + " '" + String(w.year).slice(-2);
  }
  if (sheetsParsedLabels && typeof v === 'string') {
    const m = SHEETS_DATE_LABEL.exec(v);
    if (m) return m[1] + ' ' + Number(m[2]) + " '" + m[3].slice(-2);
  }
  return (v == null) ? '' : String(v);
}

export interface SnapshotRead extends OptionsSnapshot {
  readonly ticker?: string;
  readonly priceAtRun?: number | null;
  readonly timestamp?: string;
  readonly ageDays?: number | null;
}

/** readOptionsSnapshotV7 (:8788-8812). The workbook must have loaded '_OPTIONS_SNAPSHOT'. */
export function readOptionsSnapshot(ss: ReportWorkbook, ticker: string | null | undefined, nowMs: number, timeZone: string): SnapshotRead | null {
  try {
    const sh = ss.getSheetByName(OPTIONS_SNAPSHOT_SHEET);
    if (!sh) return null;
    const data = sh.getDataRange().getValues();
    if (!data || data.length < 3 || String(data[0][0]) !== 'META') return null;
    let meta: any;
    try { meta = JSON.parse(data[0][1] as string); } catch { return null; }
    if (!meta) return null;
    if (ticker && meta.ticker && meta.ticker !== String(ticker).toUpperCase()) return { mismatch: true, ticker: meta.ticker };
    const headers = data[1];
    const numFields = ['strike', 'daysToExpiry', 'oi', 'vol', 'iv', 'dollarsCommitted', 'dollarScore', 'holdingScore', 'urgencyScore', 'timeScore', 'ivScore', 'oiPersistenceScore', 'conviction'];
    const contracts: Array<Record<string, unknown>> = [];
    for (let r = 2; r < data.length; r++) {
      const row = data[r];
      if (row[0] === '' || row[0] == null) continue;
      const c: Record<string, unknown> = {};
      for (let k = 0; k < headers.length; k++) c[headers[k] as string] = row[k];
      numFields.forEach((f) => { if (c[f] !== '' && c[f] != null && !isNaN(c[f] as number)) c[f] = Number(c[f]); });
      c.expiryStr = fmtExpiry(c.expiryStr, timeZone);
      contracts.push(c);
    }
    const ageDays = meta.timestamp ? (nowMs - new Date(meta.timestamp).getTime()) / 86400000 : null;
    return { ticker: meta.ticker, priceAtRun: meta.priceAtRun, timestamp: meta.timestamp, ageDays, context: meta.context || {}, contracts: contracts as SnapshotContract[] };
  } catch {
    return null;
  }
}

export interface OverlayRead {
  readonly ticker: string | null | undefined;
  readonly topCallStrike: TabCell | null;
  readonly topCallConv: TabCell | null;
  readonly topPutStrike: TabCell | null;
  readonly topPutConv: TabCell | null;
}

/**
 * readOptionsOverlay (:8741-8760): the top call/put scraped from the 🏆 tab (same ticker only).
 *
 * F-70 (fixed, the user's decision): legacy finds a contract row by its
 * strike cell starting with '$'. Legacy wrote '$400' through Apps Script,
 * which parses it into the NUMBER 400 -- so on a real sheet legacy's test
 * never matched and the overlay was always null. A strike is now accepted
 * as a positive number or as '$'-text (the port writes RAW, so its own
 * tabs keep the text). `legacyStrikeText: true` restores legacy's test for
 * the oracle comparisons. Nothing in legacy calls this reader (it is dead
 * code there); it is kept for the dashboard's options overlay.
 */
export function readOptionsOverlay(ss: ReportWorkbook, ticker: string | null | undefined, opts: { readonly legacyStrikeText?: boolean } = {}): OverlayRead | null {
  const isStrike = (v: TabCell): boolean => (opts.legacyStrikeText
    ? !!v && String(v).startsWith('$')
    : (typeof v === 'number' ? Number.isFinite(v) && v > 0 : !!v && String(v).startsWith('$')));
  try {
    const sh = ss.getSheetByName(OptionsTabs.TOP10); if (!sh) return null;
    const data = sh.getDataRange().getValues();
    const title = String((data[0] && data[0][0]) || '');
    const tabTicker = (title.split(' ')[0] || '').toUpperCase();
    if (ticker && tabTicker && tabTicker !== ticker.toUpperCase()) return null;
    let tCS: TabCell | null = null, tCC: TabCell | null = null, tPS: TabCell | null = null, tPC: TabCell | null = null, inC = false, inP = false, cc = 0, pc = 0;
    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      if (String(row[0]).includes('TOP 10 CALL')) { inC = true; inP = false; cc = 0; continue; }
      if (String(row[0]).includes('TOP 10 PUT')) { inP = true; inC = false; pc = 0; continue; }
      if (inC && isStrike(row[1]) && row[11]) { cc++; if (cc === 1) { tCS = row[1]; tCC = row[11]; } }
      if (inP && isStrike(row[1]) && row[11]) { pc++; if (pc === 1) { tPS = row[1]; tPC = row[11]; } }
    }
    return (tCS || tPS) ? { ticker, topCallStrike: tCS, topCallConv: tCC, topPutStrike: tPS, topPutConv: tPC } : null;
  } catch {
    return null;
  }
}
