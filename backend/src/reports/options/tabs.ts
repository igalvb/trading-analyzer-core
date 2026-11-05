/**
 * The options report tabs of futuresStockAnalysisV3_3_11.gs, ported
 * call-for-call onto ReportWorkbook (sheets/reportSheet.ts):
 *   buildTop10 :1046-1167, writeConvictionTable :1169-1243,
 *   writeBucketMiniTable :1250-1276, buildBucketBreakdown :1278-1332,
 *   buildDashboard :1337-1390, buildCallTable :1395-1419, buildPutTable :1424-1448,
 *   buildGammaWall :1453-1503, OPTIONS_SNAPSHOT_SHEET / _COLS :1521-1523,
 *   saveOptionsSnapshotV7 :1525-1549, getOrCreate :1551, hdr :1552-1555, altRows :1556-1559,
 *   DEFAULT_TICKER :17, OPTIONS_ENGINE_VERSION :21
 *
 * Every `new Date().toLocaleString()` / `.toDateString()` is printed in the
 * script's zone, en-US, as Apps Script did (`ReportTime`).
 */

import { dateStringInTz } from '../../analysis/macroRegime.ts';
import { occExpiryText } from '../../core/dates.ts';
import {
  PUT_CALL_LABEL, PUT_CALL_FLOOR_LABEL, PUT_CALL_BANDS_TEXT, IV_CHAIN_PCT_LABEL, MIN_DAYS_FOR_IV_CONTEXT, LEAPS_RULE, SHORT_TERM_RULE, pickLabel,
  putCallBand, putCallText,
} from '../../analysis/options/labels.ts';
import { interpretSignal, type ChainContext, type RecommendedCall, type ScoredContract, type ScoredContracts } from '../../analysis/options/conviction.ts';
import { scoreColor } from '../../analysis/options/futuresHelpers.ts';
import type { ReportSheet, ReportWorkbook } from '../../sheets/reportSheet.ts';
import { activeProfile } from '../../profile/active.ts';
import { defaultTickerOf } from '../../profile/schema.ts';

/** The first ticker of the profile's list (GENERIC_PLAN P2; legacy :17). */
export const DEFAULT_TICKER: string = defaultTickerOf(activeProfile());
export const OPTIONS_ENGINE_VERSION = 'v3.3.11';
export const OPTIONS_SNAPSHOT_SHEET = '_OPTIONS_SNAPSHOT';
export const OPTIONS_SNAPSHOT_COLS: readonly string[] = ['side', 'strike', 'expiryStr', 'daysToExpiry', 'oi', 'vol', 'iv',
  'dollarsCommitted', 'dollarScore', 'holdingScore', 'urgencyScore', 'timeScore', 'ivScore', 'oiPersistenceScore', 'conviction', 'bucket'];
export const OptionsTabs = {
  TOP10: '🏆 Top 10 Conviction',
  DASHBOARD: '📋 Dashboard',
  CALLS: '📞 CALL Table',
  PUTS: '📉 PUT Table',
  GAMMA: '🧱 Gamma Wall',
  BUCKETS: '📆 Near／Mid／LEAPS',
  LOG: '🔬 Log',
} as const;

/** "Now" for report stamps: the instant and the script's zone. */
export interface ReportTime {
  readonly nowMs: number;
  readonly timeZone: string;
  /** Legacy's exact tab text (parity / oracle runs: the options deps' legacyExpiryLabel). Default: the fixed text (A2, B3, D4, D6). */
  readonly legacyText?: boolean;
}

export const localeString = (t: ReportTime): string => new Date(t.nowMs).toLocaleString('en-US', { timeZone: t.timeZone });

export interface NextEarnings {
  readonly dateStr: string;
}

/** getOrCreate (:1551). */
export function getOrCreate(ss: ReportWorkbook, name: string): ReportSheet {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** hdr (:1552-1555). */
export function hdr(sh: ReportSheet, row: number, text: string, bg: string, size: number, cols: number): void {
  sh.getRange(row, 1, 1, cols).merge().setValue(text)
    .setBackground(bg).setFontSize(size || 11).setFontWeight('bold').setFontColor('#ffffff');
}

/** altRows (:1556-1559). */
export function altRows(sh: ReportSheet, startRow: number, numRows: number, numCols: number, c1: string, c2: string): void {
  for (let i = 0; i < numRows; i++) sh.getRange(startRow + i, 1, 1, numCols).setBackground(i % 2 === 0 ? c1 : c2);
}

const dollarsLabel = (d: number): string => (d >= 1e9 ? '$' + (d / 1e9).toFixed(2) + 'B' : '$' + (d / 1e6).toFixed(0) + 'M');

/**
 * The Top 10 tab's own colour. DELIBERATE DEVIATION from legacy (the user's
 * decision, F-73): legacy painted this tab '#d50000' (:1050), which is the
 * Master Lock's "locked" colour -- sheetGuardian then treated the freshly
 * written tab as locked and the lock state could not be told from the
 * report's own colour. Blue instead; LEGACY_TOP10_TAB_COLOR is kept for the
 * oracle comparisons, which map it to this value.
 */
export const TOP10_TAB_COLOR = '#1a73e8';
export const LEGACY_TOP10_TAB_COLOR = '#d50000';

/** buildTop10 (:1046-1167): the recommended calls, then the top 10 calls and puts by conviction. */
export function buildTop10(
  ss: ReportWorkbook, contracts: ScoredContracts, ticker: string, leapsCall: RecommendedCall | null, shortTermCall: RecommendedCall | null,
  nextEarnings: NextEarnings | null, t: ReportTime, opts: { readonly mergeTextRows?: boolean } = {},
): void {
  const sh = getOrCreate(ss, OptionsTabs.TOP10);
  // D16: legacy setValue'd each strike-list line on an UNMERGED 13-column range, which writes the text into all 13
  // cells (Apps Script semantics) -- the block appeared once per column. Merged, it is written once.
  const textRow = (r: number) => (opts.mergeTextRows ? sh.getRange(r, 1, 1, 13).merge() : sh.getRange(r, 1, 1, 13));
  sh.clearContents();
  sh.clearFormats();
  sh.setTabColor(TOP10_TAB_COLOR);

  const calls = contracts.filter((c) => c.side === 'call');
  const puts = contracts.filter((c) => c.side === 'put');
  const top10calls = calls.slice(0, 10);
  const top10puts = puts.slice(0, 10);
  const marketClosed = contracts.every((c) => c.vol === 0);

  const floorVal = contracts.dollarFloor || 100e6;
  const floorStr = floorVal >= 1e9 ? '$' + (floorVal / 1e9) + 'B' : '$' + Math.round(floorVal / 1e6) + 'M';
  const floorNote = floorVal >= 100e6
    ? 'Min ' + floorStr + ' committed'
    : 'Min ' + floorStr + ' committed (auto-scaled for this ticker — $ Score is relative to it)';

  const scoreNote = marketClosed
    ? '⚠️  Market closed — Holding & Urgency disabled. Conviction = 70% Dollar + 20% Time + 10% IV   |   ' + floorNote + ', strikes within 50–200% of ATM'
    : 'Conviction = 50% Dollar + 20% Holding + 15% Urgency + 10% Time + 5% IV   |   ' + floorNote + ', strikes within 50–200% of ATM';

  hdr(sh, 1, ticker + ' Options ' + OPTIONS_ENGINE_VERSION + ' — Top 10 Calls & Top 10 Puts   |   ' + localeString(t), '#1a237e', 13, 13);
  sh.getRange(2, 1, 1, 13).merge()
    .setValue(scoreNote).setFontSize(10).setFontStyle('italic')
    .setBackground(marketClosed ? '#fff3e0' : '#e8eaf6')
    .setFontColor(marketClosed ? '#e65100' : '#3949ab');

  let row = 4;
  sh.getRange(row, 1, 1, 13).merge()
    .setValue('📞  RECOMMENDED CALL — long calls only, single-leg (no puts/hedges/spreads)')
    .setBackground('#4a148c').setFontColor('#ffffff').setFontSize(12).setFontWeight('bold');
  row++;
  const writeRecCall = (label: string, result: RecommendedCall | null, targetDelta: number): void => {
    sh.getRange(row, 1, 1, 13).merge().setValue(label).setFontWeight('bold').setBackground('#f3e5f5');
    row++;
    if (!result || !result.found) {
      sh.getRange(row, 1, 1, 13).merge().setValue('Not found: ' + (result ? (result as { reason: string }).reason : 'no data')).setFontColor('#c62828');
      row++;
      return;
    }
    const c = result.contract;
    const expDate = new Date(c.expUnix * 1000);
    sh.getRange(row, 1, 1, 13).merge()
      .setValue('✅ $' + c.strike + ' call, exp ' + (t.legacyText ? dateStringInTz(expDate, t.timeZone) : occExpiryText(c.expUnix)) + '   Delta: ' + c.delta.toFixed(2) + ' (target ' + targetDelta.toFixed(2) + ')   IV: ' + (c.iv ? (c.iv * 100).toFixed(1) + '%' : 'N/A') + '   Bid/Ask: $' + c.bid.toFixed(2) + '/$' + c.ask.toFixed(2))
      .setBackground('#e8f5e9');
    row++;
    const nextEarningsDate = nextEarnings ? new Date(nextEarnings.dateStr + 'T00:00:00Z') : null;
    if (nextEarningsDate && nextEarningsDate < expDate) {
      const daysToEarnings = Math.round((nextEarningsDate.getTime() - t.nowMs) / (1000 * 60 * 60 * 24));
      sh.getRange(row, 1, 1, 13).merge()
        .setValue('⚠ Next earnings (' + (nextEarnings as NextEarnings).dateStr + ', ~' + daysToEarnings + ' days) falls BEFORE this expiry -- holding through an earnings event, real IV-crush/gap risk.')
        .setFontColor('#e65100').setFontSize(9);
      row++;
    }
    textRow(row).setValue('Other strikes considered, closest by delta first:').setFontStyle('italic').setFontSize(9).setFontColor('#666');
    row++;
    const shown = result.allCandidates.slice(0, 6);
    shown.forEach((c2) => {
      const marker = (c2.strike === c.strike) ? '  ← PICKED' : '';
      textRow(row).setValue('  $' + c2.strike + '  delta ' + c2.delta.toFixed(2) + '  (Δ' + c2.deltaDistance.toFixed(2) + ' from target)  bid/ask $' + c2.bid.toFixed(2) + '/$' + c2.ask.toFixed(2) + marker).setFontSize(9);
      row++;
    });
    if (result.allCandidates.length > 6) {
      textRow(row).setValue('  ...and ' + (result.allCandidates.length - 6) + ' more strikes at this expiry, not shown here.').setFontSize(9).setFontColor('#999');
      row++;
    }
    row++;
  };
  writeRecCall(t.legacyText ? 'LEAPS (target delta 0.75):' : pickLabel(true, 0.75) + ':', leapsCall, 0.75);
  writeRecCall(t.legacyText ? 'Short-term (target delta 0.50):' : pickLabel(false, 0.50) + ':', shortTermCall, 0.50);
  sh.getRange(row, 1, 1, 13).merge()
    .setValue(t.legacyText
      ? 'Expiry choice is a simple placeholder (furthest/nearest available) -- not yet tied to real price targets. IV-based conviction adjustment not wired in yet.'
      : 'Expiry rule: LEAPS = ' + LEAPS_RULE + '; short-term = ' + SHORT_TERM_RULE + ' (so selling 30 days before expiry still leaves at least 30 days of holding). Not yet tied to real price targets. IV-based conviction adjustment not wired in yet.')
    .setFontSize(9).setFontStyle('italic').setFontColor('#999');
  row += 2;

  const callsHeaderRow = row;
  sh.getRange(callsHeaderRow, 1, 1, 13).merge()
    .setValue('📞  TOP 10 CALL POSITIONS — Bullish bets / Resistance levels  (sorted by Conviction)')
    .setBackground('#1b5e20').setFontColor('#ffffff').setFontSize(12).setFontWeight('bold');
  writeConvictionTable(sh, top10calls, callsHeaderRow + 1, marketClosed, '#e8f5e9', '#f1f8e9', '#43a047', floorVal);

  const putsStartRow = callsHeaderRow + 1 + 2 + top10calls.length + 3;
  sh.getRange(putsStartRow, 1, 1, 13).merge()
    .setValue('📉  TOP 10 PUT POSITIONS — Bearish bets / Support levels  (sorted by Conviction)')
    .setBackground('#b71c1c').setFontColor('#ffffff').setFontSize(12).setFontWeight('bold');
  writeConvictionTable(sh, top10puts, putsStartRow + 1, marketClosed, '#ffebee', '#fce4ec', '#e53935', floorVal);

  const legendRow = putsStartRow + 1 + 2 + top10puts.length + 3;
  hdr(sh, legendRow, 'Conviction Score Guide', '#37474f', 11, 13);
  [
    ['80–100', '🔴 Very High', 'Major level — significant institutional positioning, watch closely'],
    ['60–79', '🟠 High', 'Strong signal — real money, clear directional thesis'],
    ['40–59', '🟡 Moderate', 'Mixed signals — worth monitoring but not conclusive'],
    ['20–39', '🔵 Low', 'Likely day trading or thin positioning — low signal value'],
    ['0–19', '⚪ Noise', 'Ignore — no meaningful positioning here'],
  ].forEach((rowData, i) => {
    sh.getRange(legendRow + 1 + i, 1, 1, 3).setValues([rowData])
      .setBackground(['#ffcdd2', '#ffe0b2', '#fff9c4', '#e3f2fd', '#f5f5f5'][i]);
  });

  sh.setColumnWidth(1, 40); sh.setColumnWidth(2, 80); sh.setColumnWidth(3, 70);
  sh.setColumnWidth(4, 120); sh.setColumnWidth(5, 110); sh.setColumnWidth(6, 115);
  sh.setColumnWidth(7, 72); sh.setColumnWidth(8, 72); sh.setColumnWidth(9, 72);
  sh.setColumnWidth(10, 72); sh.setColumnWidth(11, 65); sh.setColumnWidth(12, 95);
  sh.setColumnWidth(13, 280);
  sh.setFrozenRows(2);
}

/** writeConvictionTable (:1169-1243). */
export function writeConvictionTable(
  sh: ReportSheet, rows: readonly ScoredContract[], startRow: number, marketClosed: boolean, c1: string, c2: string, midColor: string, dollarFloor: number,
): void {
  const dollarLegend = (dollarFloor && dollarFloor < 100e6)
    ? '$' + Math.round(dollarFloor / 1e6) + 'M=20\n(relative: ×2=40 ×8=80)'
    : '$100M=0\n$1B=40, $5B=65';
  sh.getRange(startRow, 1, 1, 13)
    .setValues([['#', 'Strike', 'Side', 'Expiry', 'Bucket', '$ Committed',
      '$ Score', 'Holding\nScore', 'Urgency\nScore', 'Time\nScore', 'IV\nScore', 'CONVICTION', 'Signal']])
    .setFontWeight('bold').setBackground(midColor).setFontColor('#ffffff')
    .setHorizontalAlignment('center').setWrap(true);
  sh.setRowHeight(startRow, 38);

  sh.getRange(startRow + 1, 1, 1, 13)
    .setValues([['', '', '', '', '',
      'Strike × OI × 100',
      dollarLegend,
      marketClosed ? 'N/A\n(mkt closed)' : 'OI ÷ Vol\n>50× = institutional',
      marketClosed ? 'N/A\n(mkt closed)' : 'Vol ÷ OI\n>5× = spike',
      '<30d=100\n1yr=25, 2yr=0',
      'This IV vs\nchain avg',
      'Weighted\n0–100',
      '',
    ]])
    .setFontSize(9).setFontStyle('italic').setBackground('#f5f5f5')
    .setFontColor('#757575').setHorizontalAlignment('center').setWrap(true);
  sh.setRowHeight(startRow + 1, 44);

  if (!rows || rows.length === 0) {
    sh.getRange(startRow + 2, 1).setValue('No data').setFontStyle('italic').setFontColor('#9e9e9e');
    return;
  }

  rows.forEach((c, idx) => {
    const rowNum = startRow + 2 + idx;
    const isCall = c.side === 'call';
    const dollars = c.dollarsCommitted >= 1e9
      ? '$' + (c.dollarsCommitted / 1e9).toFixed(2) + 'B'
      : '$' + (c.dollarsCommitted / 1e6).toFixed(0) + 'M';
    const rowData: Array<string | number> = [
      idx + 1, '$' + c.strike, c.side.toUpperCase(),
      c.expiryStr, c.bucket, dollars,
      c.dollarScore,
      marketClosed ? '—' : c.holdingScore,
      marketClosed ? '—' : c.urgencyScore,
      c.timeScore, c.ivScore, c.conviction,
      interpretSignal(c),
    ];
    sh.getRange(rowNum, 1, 1, 13).setValues([rowData]).setBackground(idx % 2 === 0 ? c1 : c2);
    sh.getRange(rowNum, 1).setFontWeight('bold').setHorizontalAlignment('center');
    sh.getRange(rowNum, 3)
      .setBackground(isCall ? '#1b5e20' : '#b71c1c')
      .setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
    for (let col = 7; col <= 11; col++) {
      const val = rowData[col - 1];
      if (val === '—') {
        sh.getRange(rowNum, col).setBackground('#f5f5f5').setFontColor('#bdbdbd').setHorizontalAlignment('center');
      } else {
        const v = val as number;
        sh.getRange(rowNum, col)
          .setBackground(scoreColor(v))
          .setFontColor(v >= 60 ? '#1b5e20' : v >= 40 ? '#e65100' : '#b71c1c')
          .setHorizontalAlignment('center').setFontWeight('bold');
      }
    }
    sh.getRange(rowNum, 12)
      .setBackground(scoreColor(c.conviction))
      .setFontColor(c.conviction >= 60 ? '#1b5e20' : c.conviction >= 40 ? '#e65100' : '#b71c1c')
      .setFontWeight('bold').setFontSize(13).setHorizontalAlignment('center');
    sh.getRange(rowNum, 6).setFontWeight('bold').setHorizontalAlignment('right');
  });
}

/** writeBucketMiniTable (:1250-1276): returns the rows written (1 for the empty message). */
export function writeBucketMiniTable(
  sh: ReportSheet, rows: readonly ScoredContract[], startRow: number, label: string, midColor: string, showOiPersistence: boolean, emptyMsg?: string,
): number {
  const cols = showOiPersistence ? 9 : 8;
  sh.getRange(startRow, 1, 1, cols)
    .setValues([showOiPersistence
      ? [label, 'Strike', 'Side', 'Expiry', '$ Committed', '$ Score', 'Hold\nScore', 'OI-Pers\nScore', 'CONVICTION']
      : [label, 'Strike', 'Side', 'Expiry', '$ Committed', '$ Score', 'Hold\nScore', 'CONVICTION']])
    .setFontWeight('bold').setBackground(midColor).setFontColor('#ffffff')
    .setHorizontalAlignment('center').setWrap(true);
  sh.setRowHeight(startRow, 30);

  if (!rows || rows.length === 0) {
    sh.getRange(startRow + 1, 1).setValue(emptyMsg || 'No data in this bucket').setFontStyle('italic').setFontColor('#9e9e9e');
    return 1;
  }
  rows.forEach((c, idx) => {
    const rowNum = startRow + 1 + idx;
    const dollars = dollarsLabel(c.dollarsCommitted);
    const oiPersDisplay = c.oiPersistenceIsFirstRun ? c.oiPersistenceScore + ' (no history yet)' : c.oiPersistenceScore;
    const rowData = showOiPersistence
      ? [idx + 1, '$' + c.strike, c.side.toUpperCase(), c.expiryStr, dollars, c.dollarScore, c.holdingScore, oiPersDisplay, c.conviction]
      : [idx + 1, '$' + c.strike, c.side.toUpperCase(), c.expiryStr, dollars, c.dollarScore, c.holdingScore, c.conviction];
    sh.getRange(rowNum, 1, 1, cols).setValues([rowData]);
    sh.getRange(rowNum, 3).setBackground(c.side === 'call' ? '#1b5e20' : '#b71c1c').setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
    sh.getRange(rowNum, cols).setBackground(scoreColor(c.conviction)).setFontWeight('bold').setHorizontalAlignment('center');
  });
  return rows.length;
}

/** buildBucketBreakdown (:1278-1332): chain context, then the top 5 calls/puts per expiry bucket. */
export function buildBucketBreakdown(ss: ReportWorkbook, contracts: readonly ScoredContract[], ticker: string, chainContext: ChainContext, t: ReportTime): void {
  const sh = getOrCreate(ss, OptionsTabs.BUCKETS);
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#6a1b9a');

  hdr(sh, 1, ticker + ' — Near / Mid / LEAPS(~1yr · ~2yr) Breakdown   |   ' + localeString(t), '#4a148c', 13, 9);

  const cc = chainContext;
  const ctxLine = t.legacyText ? [
    'Put/Call OI: ' + (cc.putCallRatioOI != null ? cc.putCallRatioOI.toFixed(2) : 'N/A'),
    'Put/Call Vol: ' + (cc.putCallRatioVol != null ? cc.putCallRatioVol.toFixed(2) : 'N/A'),
    'Front IV: ' + (cc.frontIV != null ? (cc.frontIV * 100).toFixed(1) + '%' : 'N/A'),
    'Back IV: ' + (cc.backIV != null ? (cc.backIV * 100).toFixed(1) + '%' : 'N/A'),
    'IV percentile (vs today\'s chain): ' + (cc.ivRankPct != null ? cc.ivRankPct + 'th' : 'N/A'),
    'Term structure: ' + cc.termNote,
    '$ Bias: ' + cc.netBiasNote,
  ].join('   |   ') : [
    PUT_CALL_LABEL + ': ' + putCallText(cc.putCallRatioOI),
    'Put/Call Vol: ' + (cc.putCallRatioVol != null ? cc.putCallRatioVol.toFixed(2) : 'N/A'),
    'Front IV: ' + (cc.frontIV != null ? (cc.frontIV * 100).toFixed(1) + '%' : 'N/A'),
    'Back IV: ' + (cc.backIV != null ? (cc.backIV * 100).toFixed(1) + '%' : 'N/A'),
    IV_CHAIN_PCT_LABEL + ': ' + (cc.ivRankPct != null ? cc.ivRankPct + 'th' : 'N/A'),
    'Term structure: ' + cc.termNote,
    '$ Bias: ' + cc.netBiasNote,
    'IV figures leave out contracts with under ' + MIN_DAYS_FOR_IV_CONTEXT + ' days to expiry',
  ].join('   |   ');
  sh.getRange(2, 1, 1, 9).merge().setValue(ctxLine).setFontSize(10).setFontStyle('italic')
    .setBackground('#f3e5f5').setFontColor('#4a148c').setWrap(true);
  sh.setRowHeight(2, 40);

  let row = 4;
  const buckets: Array<{ key: string; label: string; color: string; persist: boolean; emptyMsg?: string }> = [
    { key: 'Near (0–3m)', label: '📞 NEAR (≤90d)', color: '#00695c', persist: false },
    { key: 'Mid (3–12m)', label: '📞 MID (90–365d)', color: '#2e7d32', persist: false },
    { key: 'LEAPS ~1yr', label: '📞 LEAPS ~1yr (365–730d)', color: '#6a1b9a', persist: true },
    { key: 'LEAPS ~2yr', label: '📞 LEAPS ~2yr (>730d)', color: '#4a148c', persist: true,
      emptyMsg: 'No contracts — broker lists no expiries beyond ~24 months for this ticker' },
  ];
  buckets.forEach((b) => {
    const calls = contracts.filter((c) => c.bucket === b.key && c.side === 'call').slice(0, 5);
    const puts = contracts.filter((c) => c.bucket === b.key && c.side === 'put').slice(0, 5);
    sh.getRange(row, 1, 1, 9).merge().setValue(b.label + ' — Top 5 Calls').setBackground(b.color).setFontColor('#fff').setFontWeight('bold');
    row++;
    const n1 = writeBucketMiniTable(sh, calls, row, '#', b.color, b.persist, b.emptyMsg);
    row += n1 + 1;
    const putLabel = b.label.replace('📞', '📉') + ' — Top 5 Puts';
    sh.getRange(row, 1, 1, 9).merge().setValue(putLabel).setBackground('#b71c1c').setFontColor('#fff').setFontWeight('bold');
    row++;
    const n2 = writeBucketMiniTable(sh, puts, row, '#', '#b71c1c', b.persist, b.emptyMsg);
    row += n2 + 2;
  });

  if (buckets.some((b) => b.persist)) {
    sh.getRange(row, 1, 1, 9).merge().setValue(
      'OI-Persistence: compares LEAPS open interest to the LAST time this ticker was run — 50=no prior data (first run), ' +
      '100=OI grew ≥10% since last run, 0=OI fell ≥10%. Builds up real signal over repeated runs, not a single-snapshot metric.',
    ).setFontSize(9).setFontStyle('italic').setFontColor('#757575').setWrap(true);
    row++;
  }

  sh.setColumnWidths(1, 9, 90);
  sh.setColumnWidth(1, 60);
  sh.setFrozenRows(2);
}

/**
 * buildDashboard (:1337-1390).
 *
 * D4 (fix plan 2026-10-30), outside legacyText: the headline P/C is the WHOLE chain's (`wholeChainPutCallOI`,
 * computeChainContext -- the number every other page shows) with the scoring bands' words; the ratio over the
 * scored contracts only is kept in its own column, labelled as that.
 */
export function buildDashboard(ss: ReportWorkbook, contracts: readonly ScoredContract[], ticker: string, t: ReportTime, wholeChainPutCallOI?: number | null): void {
  const sh = getOrCreate(ss, OptionsTabs.DASHBOARD);
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#1a73e8');

  const calls = contracts.filter((c) => c.side === 'call');
  const puts = contracts.filter((c) => c.side === 'put');

  hdr(sh, 1, ticker + ' Options Dashboard   |   ' + localeString(t), '#0d47a1', 13, 6);

  const totalCallOI = calls.reduce((s, c) => s + c.oi, 0);
  const totalPutOI = puts.reduce((s, c) => s + c.oi, 0);
  const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI) : null;
  const pcrStr = pcr !== null ? pcr.toFixed(3) : 'N/A';
  const pcrSig = pcr === null ? 'N/A'
    : pcr < 0.7 ? '🐂 Bullish — calls dominate'
    : pcr <= 1.2 ? '😐 Neutral — balanced'
    : '🐻 Bearish — puts dominate';

  hdr(sh, 3, 'Put / Call Ratio', '#37474f', 12, 6);
  if (t.legacyText) {
    sh.getRange(4, 1, 1, 6).setValues([['Total Call OI', 'Total Put OI', 'P/C Ratio', 'Signal', 'Total Calls', 'Total Puts']])
      .setFontWeight('bold').setBackground('#cfd8dc');
    sh.getRange(5, 1, 1, 6).setValues([[totalCallOI, totalPutOI, pcrStr, pcrSig, calls.length, puts.length]])
      .setBackground('#eceff1');
  } else {
    const whole = wholeChainPutCallOI ?? null;
    sh.getRange(4, 1, 1, 6).setValues([[PUT_CALL_LABEL, 'Signal', PUT_CALL_FLOOR_LABEL, 'Call OI above the $ floor', 'Put OI above the $ floor', 'Calls / puts above the $ floor']])
      .setFontWeight('bold').setBackground('#cfd8dc');
    sh.getRange(5, 1, 1, 6).setValues([[whole != null ? whole.toFixed(2) : 'N/A', putCallBand(whole), pcr !== null ? pcr.toFixed(2) : 'N/A', totalCallOI, totalPutOI, calls.length + ' / ' + puts.length]])
      .setBackground('#eceff1');
  }

  if (!t.legacyText) {
    sh.getRange(6, 1, 1, 6).merge().setValue('Signal bands (the options scoring\'s): ' + PUT_CALL_BANDS_TEXT + '. The $-floor ratio counts only the contracts scored below.')
      .setFontSize(9).setFontStyle('italic').setFontColor('#546e7a').setWrap(true);
  }
  const top5calls = calls.sort((a, b) => b.conviction - a.conviction).slice(0, 5);
  hdr(sh, 7, 'Top 5 Call Positions (by Conviction)', '#1b5e20', 12, 6);
  sh.getRange(8, 1, 1, 6).setValues([['Strike', 'Expiry', 'Bucket', '$ Committed', 'Conviction', 'Signal']])
    .setFontWeight('bold').setBackground('#a5d6a7');
  if (top5calls.length) {
    sh.getRange(9, 1, top5calls.length, 6).setValues(top5calls.map((c) => [
      '$' + c.strike, c.expiryStr, c.bucket, dollarsLabel(c.dollarsCommitted), c.conviction, interpretSignal(c),
    ]));
    altRows(sh, 9, top5calls.length, 6, '#e8f5e9', '#f1f8e9');
  }

  const pr = 9 + top5calls.length + 2;
  const top5puts = puts.sort((a, b) => b.conviction - a.conviction).slice(0, 5);
  hdr(sh, pr, 'Top 5 Put Positions (by Conviction)', '#b71c1c', 12, 6);
  sh.getRange(pr + 1, 1, 1, 6).setValues([['Strike', 'Expiry', 'Bucket', '$ Committed', 'Conviction', 'Signal']])
    .setFontWeight('bold').setBackground('#ef9a9a');
  if (top5puts.length) {
    sh.getRange(pr + 2, 1, top5puts.length, 6).setValues(top5puts.map((c) => [
      '$' + c.strike, c.expiryStr, c.bucket, dollarsLabel(c.dollarsCommitted), c.conviction, interpretSignal(c),
    ]));
    altRows(sh, pr + 2, top5puts.length, 6, '#ffebee', '#fce4ec');
  }

  sh.setColumnWidths(1, 6, 160);
  sh.setFrozenRows(1);
}

function buildSideTable(ss: ReportWorkbook, contracts: readonly ScoredContract[], ticker: string, side: 'call' | 'put'): void {
  const isCall = side === 'call';
  const sh = getOrCreate(ss, isCall ? OptionsTabs.CALLS : OptionsTabs.PUTS);
  sh.clearContents(); sh.clearFormats(); sh.setTabColor(isCall ? '#2e7d32' : '#c62828');

  hdr(sh, 1, ticker + (isCall ? ' — All CALL options sorted by Open Interest' : ' — All PUT options sorted by Open Interest'), isCall ? '#1b5e20' : '#b71c1c', 13, 8);
  sh.getRange(2, 1, 1, 8)
    .setValues([['Expiry', 'Bucket', 'Strike', 'Volume', 'Open Interest', 'Impl. Vol', '$ Committed', 'Conviction']])
    .setFontWeight('bold').setBackground(isCall ? '#43a047' : '#e53935').setFontColor('#fff');

  const list = contracts.filter((c) => c.side === side).sort((a, b) => b.oi - a.oi);
  if (list.length) {
    const rows = list.map((c) => [
      c.expiryStr, c.bucket, c.strike, c.vol, c.oi,
      c.iv > 0 ? (c.iv * 100).toFixed(1) + '%' : '-',
      dollarsLabel(c.dollarsCommitted),
      c.conviction,
    ]);
    sh.getRange(3, 1, rows.length, 8).setValues(rows);
    altRows(sh, 3, rows.length, 8, isCall ? '#e8f5e9' : '#ffebee', isCall ? '#f1f8e9' : '#fce4ec');
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      sh.getRange(3 + i, 1, 1, 8).setBackground(isCall ? '#b9f6ca' : '#ff8a80').setFontWeight('bold');
    }
  }
  sh.setColumnWidths(1, 8, 140); sh.setFrozenRows(2);
}

/** buildCallTable (:1395-1419). */
export function buildCallTable(ss: ReportWorkbook, contracts: readonly ScoredContract[], ticker: string): void {
  buildSideTable(ss, contracts, ticker, 'call');
}

/** buildPutTable (:1424-1448). */
export function buildPutTable(ss: ReportWorkbook, contracts: readonly ScoredContract[], ticker: string): void {
  buildSideTable(ss, contracts, ticker, 'put');
}

/** buildGammaWall (:1453-1503): call vs put OI per strike; the top quartile highlighted; the top 5 walls. */
export function buildGammaWall(ss: ReportWorkbook, contractsIn: unknown, ticker: string): void {
  const sh = getOrCreate(ss, OptionsTabs.GAMMA);
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#f57f17');
  const contracts: ScoredContract[] = Array.isArray(contractsIn) ? contractsIn : [];

  hdr(sh, 1, ticker + ' Gamma Wall — Call OI vs Put OI per Strike', '#e65100', 13, 7);
  sh.getRange(2, 1, 1, 7).merge()
    .setValue('Yellow = top 25% combined OI = gamma wall. Price gravitates toward these strikes near expiry.')
    .setBackground('#fff8e1').setFontColor('#5d4037').setFontSize(10).setFontStyle('italic');
  sh.getRange(3, 1, 1, 7)
    .setValues([['Strike', 'Call OI', 'Put OI', 'Call Vol', 'Put Vol', 'P/C OI Ratio', 'Combined OI']])
    .setFontWeight('bold').setBackground('#ff8f00').setFontColor('#fff');

  const strikeMap: Record<string, { callOI: number; putOI: number; callVol: number; putVol: number }> = {};
  contracts.forEach((c) => {
    if (!strikeMap[c.strike]) strikeMap[c.strike] = { callOI: 0, putOI: 0, callVol: 0, putVol: 0 };
    if (c.side === 'call') { strikeMap[c.strike].callOI += c.oi; strikeMap[c.strike].callVol += c.vol; }
    else { strikeMap[c.strike].putOI += c.oi; strikeMap[c.strike].putVol += c.vol; }
  });

  const rows: Array<Array<number | string>> = Object.keys(strikeMap).map(Number).sort((a, b) => a - b).map((s) => {
    const m = strikeMap[s];
    return [s, m.callOI, m.putOI, m.callVol, m.putVol,
      m.callOI > 0 ? parseFloat((m.putOI / m.callOI).toFixed(2)) : 'N/A',
      m.callOI + m.putOI];
  });

  if (rows.length) {
    sh.getRange(4, 1, rows.length, 7).setValues(rows);
    altRows(sh, 4, rows.length, 7, '#fff9c4', '#fffde7');
    const p75 = rows.map((r) => r[6] as number).sort((a, b) => a - b)[Math.floor(rows.length * 0.75)] || 0;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][6] as number) >= p75) sh.getRange(4 + i, 1, 1, 7).setBackground('#ffe082').setFontWeight('bold');
    }
    const top5row = rows.length + 6;
    hdr(sh, top5row, 'Top 5 Gamma Walls (highest combined OI)', '#bf360c', 12, 7);
    sh.getRange(top5row + 1, 1, 1, 7)
      .setValues([['Strike', 'Call OI', 'Put OI', 'Call Vol', 'Put Vol', 'P/C Ratio', 'Combined OI']])
      .setFontWeight('bold').setBackground('#ffb300');
    const top5 = rows.slice().sort((a, b) => (b[6] as number) - (a[6] as number)).slice(0, 5);
    sh.getRange(top5row + 2, 1, top5.length, 7).setValues(top5);
    for (let i = 0; i < top5.length; i++) {
      sh.getRange(top5row + 2 + i, 1, 1, 7).setBackground('#fff176').setFontWeight('bold');
    }
  }
  sh.setColumnWidths(1, 7, 140); sh.setFrozenRows(3);
}

/** saveOptionsSnapshotV7 (:1525-1549): the whole scored set + chain context to the hidden data tab. */
export function saveOptionsSnapshot(
  ss: ReportWorkbook, ticker: string, contracts: readonly ScoredContract[], chainContext: ChainContext | null, underlying: number | null, t: ReportTime,
): number {
  const sh = getOrCreate(ss, OPTIONS_SNAPSHOT_SHEET);
  sh.clear();
  const meta = {
    ticker: String(ticker || '').toUpperCase(),
    priceAtRun: (underlying != null && isFinite(underlying)) ? Number(underlying) : null,
    timestamp: new Date(t.nowMs).toISOString(),
    count: contracts.length,
    context: chainContext || {},
  };
  sh.getRange(1, 1).setValue('META');
  sh.getRange(1, 2).setValue(JSON.stringify(meta));
  sh.getRange(2, 1, 1, OPTIONS_SNAPSHOT_COLS.length).setValues([OPTIONS_SNAPSHOT_COLS]);
  if (contracts.length) {
    const rows = contracts.map((c) => OPTIONS_SNAPSHOT_COLS.map((k) => {
      const v = (c as unknown as Record<string, unknown>)[k];
      return (v === undefined || v === null) ? '' : v;
    }));
    sh.getRange(3, 1, rows.length, OPTIONS_SNAPSHOT_COLS.length).setValues(rows);
  }
  try { sh.hideSheet(); } catch { /* already hidden or not hideable -- non-fatal */ }
  return meta.count;
}
