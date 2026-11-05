/**
 * The analysis dashboard tab, ported call for call from
 * fullStockAnalysisV10_9.gs buildDashboardV7 :3442-4559 (FL-7e).
 *
 * Every range call is made in legacy's order on the 📊 Analysis v7 tab, so the
 * recorded call log and the cells equal the oracle's (test/fl7e.dashboard.test.ts).
 *
 * Differences from legacy, all mechanical:
 *   - async: scoreAllSignals and the 13F fetches are async in the port.
 *   - new Date() / Session.getScriptTimeZone() come from deps.nowMs / deps.timeZone;
 *     toLocaleString / toLocaleDateString / toDateString / Number#toLocaleString are
 *     printed in that zone, en-US (F-E7).
 *   - hasTimeBudgetV7_(25000) is deps.hasTimeBudget (default: always true) (F-E6).
 *   - SpreadsheetApp.flush() is the caller's ReportWorkbook.flush().
 *   - The workbook must have loaded '📒 Transactions' and '_OPTIONS_SNAPSHOT'
 *     (open(..., ['*']) or both names; compose.ts TICKER_RUN_PRELOAD does), or the
 *     YOUR POSITION section fails. Legacy hides it without a word (F-E1); plain
 *     mode prints one catalog line and sends the detail to onReportDetail.
 *
 * Plain mode (the default; legacyReportText keeps legacy's exact call log):
 *   - F-82: the "Data quality" box (catalog dataQualityLines) replaces the status
 *     banner. Its items are deps.dataQuality (runTicker: fetch reasons, skipped and
 *     not-run steps, F-H5) or, without it, the status record itself.
 *   - F-E2: the 13F fetch and its status run before the header, so the box shows a
 *     skipped or failed 13F step; the 13F table is still drawn at its legacy place.
 *   - L-1, L-3: with no AI review the AI box says the review was not run (legacy
 *     pointed at Script Properties) and the header does not list Gemini AI.
 *
 * Report text is legacy's, unchanged. Where it leaks a raw error message
 * (the "⚠️ ... error: <message>" rows, the 13F status detail), that is ported as is
 * and listed as F-E3.
 */

import { ENGINE_WYCKOFF_NAME } from '../../analysis/extraModels.ts';
import type { ReportWorkbook } from '../../sheets/reportSheet.ts';
import { scoreAllSignals } from '../../analysis/signals.ts';
import { liveBarFraction } from '../../core/marketSession.ts';
import { assumedAccountText } from '../../analysis/models/modelText.ts';
import { setStatus } from '../../analysis/dataStatus.ts';
import { computeStockEntryLadder, computeStockExitLadder, computeOptionsEntryLadder, computeOptionsExitLadder, ladderDisplayPercents, optionsLadderTimeDecayNote, optionsExpiryFlag } from '../../analysis/ladders.ts';
import { computePortfolioSummary, getHeldPositionsForTicker, TRANSACTIONS_SHEET } from '../../portfolio/transactions.ts';
import { getOrCreate, localeString } from '../options/tabs.ts';
import { fmtExpiry } from '../options/run.ts';
import { formatDateInTz, occExpiryText } from '../../core/dates.ts';
import { pickLabel, LEAPS_RULE, SHORT_TERM_RULE, PUT_CALL_BANDS_TEXT, IV_CHAIN_PCT_LABEL, putCallText } from '../../analysis/options/labels.ts';
import { dateStringInTz } from '../../analysis/macroRegime.ts';
import { DashSheet } from './sheetAdapter.ts';
import { hdr, scoreBar, colorVerdictRow9, classifyGapCause, gapMarketCapContext, renderAiReview, buildDataStatusBanner, buildNarrative } from './helpers.ts';
import { sectionErrorText, notFoundText, detailOf, type ReportTextOptions } from '../messages/reportText.ts';
import { classifyError, dataQualityLines, labelledReason, type QualityItem, type ReasonCode } from '../messages/catalog.ts';
import { statusQualityItems } from '../../core/messages.ts';
import { STATUS_DISPLAY_ORDER } from '../text/textReports.ts';
import { atBuyLimit } from '../../analysis/atBuyLimit.ts';
import { nextResistance, type NextResistance } from '../../analysis/nextResistance.ts';

/** CONFIG_V7.tab, CONFIG_V7.version, GEMINI_MODEL (legacy :10-34, :5315). */
export const DASHBOARD_TAB = '📊 Analysis v7';
export const DASHBOARD_VERSION = 'v10.9';
export const GEMINI_MODEL = 'gemini-flash-lite-latest';

/** The chandelier stop when it is already above the current price (plain mode): no negative distance. */
export const CHANDELIER_ABOVE_PRICE = 'already above price (stop hit if held)';

/**
 * The Chandelier row's "Distance from current price" cell. Legacy prints cp - stop, which goes negative
 * ("$-4.20") once the stop is above the price; plain mode says what that means instead.
 */
export function chandelierDistanceText(cp: number, stop: number, legacyReportText: boolean): string {
  const dist = cp - stop;
  if (!legacyReportText && stop > cp) return CHANDELIER_ABOVE_PRICE;
  return '$' + dist.toFixed(2);
}

export interface DashboardDeps {
  /** new Date() of the run. */
  readonly nowMs: number;
  /** Session.getScriptTimeZone(). */
  readonly timeZone: string;
  /** readBrokerDataCacheV1_ for scoreAllSignals (used when no short-interest value is passed in). */
  readonly readBrokerData: (ticker: string) => Promise<any>;
  /** fetch13FCusipV7 (production: fetch/sec/thirteenF.ts fetch13FCusip). Called with chart.ticker, as legacy. */
  readonly fetch13FCusip: (ticker: string) => Promise<string | null>;
  /** fetchInstitutional13FHoldingsV7 (production: fetchInstitutional13FHoldings). */
  readonly fetchInstitutional13FHoldings: (cusip: string) => Promise<Record<string, any> | null>;
  /** hasTimeBudgetV7_(marginMs); default: always true. Only consulted when no 13F result was passed in. */
  readonly hasTimeBudget?: (marginMs: number) => boolean;
  /** Test hook: replaces scoreAllSignals. */
  readonly scoreAll?: typeof scoreAllSignals;
  /** Passed to the portfolio summary and fmtExpiry (F-B2 / F-E8). Default true. */
  readonly sheetsParsedLabels?: boolean;
  readonly fromSerial?: (serial: number) => Date;
  readonly version?: string;
  readonly tab?: string;
  readonly geminiModel?: string;
  /** FL-9c: true = the old report text, raw error messages included (parity tests only). Default: plain English. */
  readonly legacyReportText?: boolean;
  /** FL-9c: receives the technical detail that plain mode keeps out of the report (wire to the log). */
  readonly onReportDetail?: (line: string) => void;
  /** F-82 (plain mode): the run's data-quality items (runTicker DashboardArgs.dataQuality). Absent: read from `status`. */
  readonly dataQuality?: readonly QualityItem[];
  /** Options sentiment part B (display only, feeds no score): the last stored market options line, under the VIX lines. */
  readonly marketOptionsLine?: string | null;
  /** Owner 2026-11-01 (Analyze only): Claude Opus's second opinion, written right under Gemini's review. Absent: no section. */
  readonly opusReview?: readonly string[] | null;
}

/**
 * buildDashboardV7 (:3442-4559). Writes the whole tab (cleared first) and returns
 * nothing; `status` is updated in place (institutionalHoldings).
 */
export async function buildDashboard(ss: ReportWorkbook, ticker: string, chart: any, ind: any, gann: any, confluence: any, fundResult: any, techPlan: any, decision: any, fund: any, opts: any, fundSource: any, aiReview: any, status: any, ladderStock: any, ladderOptions: any, leapsCallArg: any, shortTermCallArg: any, existingInstitutional13F: any, existingShortInterest: any, deps: DashboardDeps): Promise<void> {
  const tz = deps.timeZone;
  const version = deps.version ?? DASHBOARD_VERSION, geminiModel = deps.geminiModel ?? GEMINI_MODEL;
  const hasTimeBudget = deps.hasTimeBudget ?? (() => true);
  const textOpts: ReportTextOptions = { legacyReportText: deps.legacyReportText, onDetail: deps.onReportDetail };
  const errCell = (label: string, e: any, max: number): string => sectionErrorText(label, e, max, textOpts);
  const rc = (c: ReasonCode): ReasonCode | undefined => (deps.legacyReportText ? undefined : c);
  // lazy on purpose: legacy only touches fundSource where it prints it (a broken value must throw there, not here)
  const fundSrcText = (): any => (deps.legacyReportText ? fundSource : String(fundSource).replace(/^cache \(/, 'saved copy ('));
  const sh = new DashSheet(getOrCreate(ss, deps.tab ?? DASHBOARD_TAB));
  try { sh.getDataRange().breakApart(); } catch (e) {}
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#4a148c');
  let row = 1;
  const cp = chart.currentPrice;

  // v6.1 dual-timeframe scores (SHORT/LONG indicator tables + verdict)
  const scores = await (deps.scoreAll ?? scoreAllSignals)(deps.legacyReportText
    ? { timeZone: tz, readBrokerData: deps.readBrokerData }
    : { timeZone: tz, readBrokerData: deps.readBrokerData, plainText: true, liveBarFraction: liveBarFraction(chart && chart.dates, deps.nowMs) }, ind, fund, gann, chart, techPlan.regime, existingShortInterest);

  // ══ 13F fetch and status ══ legacy runs this at the 13F section; plain mode (F-E2) runs it here, before the
  // header, so the Data quality box can show the 13F step. Same calls, same status values, same order in the step.
  const SKIP_13F_DETAIL = 'time budget — skipped to protect the rest of the report';
  const skip13F = (): boolean => existingInstitutional13F === undefined && !hasTimeBudget(25 * 1000);
  const fetch13F = async (): Promise<any> => {
    const cusip = existingInstitutional13F !== undefined ? null : await deps.fetch13FCusip(chart.ticker);
    if (existingInstitutional13F === undefined && !cusip) {
      setStatus(status, 'institutionalHoldings', 'degraded', 'CUSIP lookup failed', rc('NO_DATA_FOR_TICKER'));
      return null;
    }
    const holdings13F: any = existingInstitutional13F !== undefined ? existingInstitutional13F : await deps.fetchInstitutional13FHoldings(cusip as string);
    if (!holdings13F) {
      setStatus(status, 'institutionalHoldings', 'degraded', 'no institutional 13F data (reused from broker-course model)', rc('NO_DATA_FOR_TICKER'));
      return null;
    }
    const anyReal = Object.values(holdings13F).some((q: any) => (q.latest && q.latest.holdings) || (q.prior && q.prior.holdings));
    setStatus(status, 'institutionalHoldings', anyReal ? 'ok' : 'degraded', anyReal ? '' : 'no matching CUSIP position found in any tracked filer', anyReal ? undefined : rc('NO_DATA_FOR_TICKER'));
    return anyReal ? holdings13F : null;
  };
  // legacy: a real SEC fetch failure is recorded in the status, not thrown (the detail is the raw message, F-E3)
  const fail13F = (e: any): void => setStatus(status, 'institutionalHoldings', 'failed', e && e.message ? e.message : String(e), deps.legacyReportText ? undefined : classifyError(e));
  let pre13F: { holdings: any } | null = null;
  if (!deps.legacyReportText) {
    if (skip13F()) setStatus(status, 'institutionalHoldings', 'skipped', SKIP_13F_DETAIL, rc('NOT_RUN'));
    else { try { pre13F = { holdings: await fetch13F() }; } catch (e) { fail13F(e); } }
  }

  /** F-82: the Data quality box (plain mode): catalog lines only; the 13F step included (F-E2). Returns the next row. */
  const drawQualityBox = (r0: number): number => {
    const nowD = new Date(deps.nowMs);
    const items: QualityItem[] = deps.dataQuality
      ? [...deps.dataQuality]
      : statusQualityItems(status, nowD, { order: STATUS_DISPLAY_ORDER, skip: new Set(['institutionalHoldings']) }).map((q) => q.item);
    items.push(...statusQualityItems(status, nowD, { order: ['institutionalHoldings'] }).map((q) => q.item));
    const clean = items.length === 0;
    let r = r0;
    dataQualityLines(items).forEach((t, i) => {
      try {
        const rng = sh.getRange(r, 1, 1, 14).merge().setValue(t).setFontSize(10).setWrap(true);
        if (i === 0) rng.setFontWeight('bold').setBackground(clean ? '#1b5e20' : '#b71c1c').setFontColor('#fff');
        else rng.setBackground(clean ? '#e8f5e9' : '#fff3e0').setFontColor(clean ? '#1b5e20' : '#b71c1c');
        r++;
      } catch (e) { /* one box row never takes down the header */ }
    });
    return r;
  };

  // ══ HEADER ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📊 '+ticker+' — Investor Briefing '+version+'   |   $'+cp.toFixed(2)+'   |   '+localeString({ nowMs: deps.nowMs, timeZone: tz })).setBackground('#1a237e').setFontColor('#fff').setFontSize(14).setFontWeight('bold');row++;
    sh.getRange(row,1,1,14).merge().setValue('Indicators + Relative Strength + RSI Divergence + Gann (confirmation only) + Confluence + v7 Fundamentals & Options Intelligence'+((deps.legacyReportText||aiReview)?' + Gemini AI':'')+'   |   Source: '+fundSrcText()+(fund&&fund._crossRef?'   ⚠ '+fund._crossRef.length+' cross-source diff(s)':'')).setBackground('#283593').setFontColor('#c5cae9').setFontSize(10).setFontStyle('italic');row++;
    if (!deps.legacyReportText) row = drawQualityBox(row);
    else (buildDataStatusBanner(status, textOpts)||[]).forEach(b=>{ try{ const rng=sh.getRange(row,1,1,14).merge().setValue(String(b.text[0])); const m=b.meta||{}; if(m.bg)rng.setBackground(m.bg); if(m.color)rng.setFontColor(m.color); if(m.bold)rng.setFontWeight('bold'); if(m.italic)rng.setFontStyle('italic'); if(m.wrap)rng.setWrap(true); if(m.size)rng.setFontSize(m.size); row++; }catch(e){} });
    row++;
  }catch(e){row+=3;}

  // ══ AI ANALYST REVIEW (Gemini) — pedagogical, at top ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('🤖  AI ANALYST REVIEW  (Gemini '+geminiModel+')').setBackground('#1b5e20').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
    if (aiReview) {
      renderAiReview(aiReview).forEach(r=>{
        try{
          const rng=sh.getRange(row,1,1,14).merge().setValue(String(r.text[0])).setWrap(true).setVerticalAlignment('top');
          const m=r.meta||{};
          if(m.bg)rng.setBackground(m.bg); else rng.setBackground('#f1f8e9');
          if(m.color)rng.setFontColor(m.color);
          if(m.bold)rng.setFontWeight('bold');
          if(m.italic)rng.setFontStyle('italic');
          rng.setFontSize(m.size||10);
          const lines=Math.max(1,Math.ceil(String(r.text[0]).length/110));
          sh.setRowHeight(row, Math.min(120, 16*lines+6));
        }catch(e){}
        row++;
      });
      row++;
    } else {
      sh.getRange(row,1,1,14).merge().setValue(deps.legacyReportText ? 'AI review unavailable — add GEMINI_API_KEY in Script Properties to enable. Every number below is unaffected.' : 'The AI review was not run for this report. Every number below is unaffected.').setBackground('#fff3e0').setFontColor('#e65100').setFontStyle('italic');row+=2;
    }
    // ══ AI SECOND OPINION (Claude Opus) — Analyze only (owner 2026-11-01), display only, right under Gemini's review ══
    if (deps.opusReview && deps.opusReview.length) {
      sh.getRange(row,1,1,14).merge().setValue('🧠  AI SECOND OPINION  (Claude Opus)').setBackground('#4a148c').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
      for (const line of deps.opusReview.flatMap((l) => String(l).split('\n'))) {
        if (line.trim() === '') continue;
        const rng=sh.getRange(row,1,1,14).merge().setValue(line).setWrap(true).setVerticalAlignment('top').setBackground('#f3e5f5').setFontSize(10);
        if (/^[A-Z][A-Z ()]+$/.test(line)) rng.setFontWeight('bold');
        sh.setRowHeight(row, Math.min(120, 16*Math.max(1,Math.ceil(line.length/110))+6));
        row++;
      }
      row++;
    }
  }catch(e){ sh.getRange(row,1).setValue(errCell('AI review render', e, 60)).setFontColor('#e65100'); row+=2; }

  // ══ YOUR POSITION — read-only surfacing of any held STOCK/OPTION position for this ticker ══
  try {
    const portfolioResult = computePortfolioSummary(ss, { timeZone: tz, nowMs: deps.nowMs, sheetsParsedLabels: deps.sheetsParsedLabels, fromSerial: deps.fromSerial });
    const held: any[] = getHeldPositionsForTicker(portfolioResult, ticker);
    if (held.length) {
      sh.getRange(row,1,1,14).merge().setValue('💼  YOUR POSITION').setBackground('#1a5276').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
      held.forEach(p => {
        try {
          if (p.assetType === 'STOCK') {
            const unrealizedPct = ((cp/p.avgCost)-1)*100;
            const line = 'You hold '+p.shares.toFixed(4).replace(/\.?0+$/,'')+' shares @ avg $'+p.avgCost.toFixed(2)+'  (current: '+(unrealizedPct>=0?'+':'')+unrealizedPct.toFixed(1)+'%)'
              + '   ·   Engine says: '+techPlan.timing+', stop $'+techPlan.stop.toFixed(2);
            sh.getRange(row,1,1,14).merge().setValue(line).setBackground('#d6eaf8').setFontColor('#1a5276').setFontWeight('bold');row++;
          } else {
            const snapText = p.snapshot ? ('as of '+new Date(p.snapshot.snapshotDate).toLocaleDateString('en-US', { timeZone: tz })+', conviction '+p.snapshot.contract.conviction) : 'no recent options snapshot — run Options Analysis on this ticker to refresh';
            const line = 'You hold '+p.contracts+' '+p.ticker+' $'+p.strike+' exp '+p.expiry+' @ avg $'+p.avgPremium.toFixed(2)+' premium   ·   '+snapText;
            sh.getRange(row,1,1,14).merge().setValue(line).setBackground('#fdebd0').setFontColor('#7e5109').setFontWeight('bold').setWrap(true);row++;
          }
        } catch(e2) { row++; }
      });
      if (portfolioResult.warnings && portfolioResult.warnings.length) {
        sh.getRange(row,1,1,14).merge().setValue('⚠ Portfolio data issues (see '+TRANSACTIONS_SHEET+'): '+portfolioResult.warnings.length+' warning(s) — check that sheet for details.').setBackground('#fdecea').setFontColor('#c0392b').setFontStyle('italic').setFontSize(9);row++;
      }
      row++;
    }
  } catch(e) {
    // additive in legacy: a failure here must never take down the rest of the dashboard.
    // F-E1 (plain mode): legacy hides the section without a word; say so in one catalog line, the detail goes to the log.
    if (!deps.legacyReportText) {
      try {
        if (deps.onReportDetail) deps.onReportDetail('YOUR POSITION section failed: ' + detailOf(e));
        sh.getRange(row,1,1,14).merge().setValue('💼  ' + labelledReason('Your position', 'SHEET_UNREADABLE')).setFontStyle('italic').setFontColor('#c0392b').setFontSize(9); row += 2;
      } catch (e2) { /* never fatal */ }
    }
  }

  // ══ PRICE SNAPSHOT ══
  try {
    hdr(sh,row,'📈  PRICE SNAPSHOT','#37474f',11,14);row++;
    const dayChg=cp-chart.prevClose,dayChgPct=chart.prevClose?dayChg/chart.prevClose*100:0;
    sh.getRange(row,1,1,14).setValues([['Price','$'+cp.toFixed(2),'Day Change',(dayChg>=0?'+':'')+dayChg.toFixed(2)+' ('+(dayChgPct>=0?'+':'')+dayChgPct.toFixed(2)+'%)','52wk High','$'+ind.high52.toFixed(2),'52wk Low','$'+ind.low52.toFixed(2),'52wk Pos',ind.range52Pct.toFixed(1)+'%','ATR(14)','$'+ind.atr14.toFixed(2),'Currency',chart.currency]]).setBackground('#eceff1');
    sh.getRange(row,4).setFontColor(dayChg>=0?'#2e7d32':'#c62828').setFontWeight('bold');row++;
    if (fund && fund._nextEarnings) {
      const daysOut = Math.round((new Date(fund._nextEarnings.dateStr+'T00:00:00Z').getTime() - deps.nowMs) / (1000*60*60*24));
      const isSoon = daysOut <= 30;
      sh.getRange(row,1,1,14).merge()
        .setValue((isSoon ? '⚠ ' : '') + 'Next earnings: ' + fund._nextEarnings.dateStr + ' (~' + daysOut + ' days) '
          + (isSoon ? '— within 30 days, real volatility/IV-crush risk if holding an option through this' : ''))
        .setFontSize(10).setFontStyle('italic')
        .setBackground(isSoon ? '#fff3e0' : '#f5f5f5')
        .setFontColor(isSoon ? '#e65100' : '#666');
      row++;
    }
    row++;
  }catch(e){row+=3;}

  // ══ ENTRY / EXIT ZONES ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('🎯  ENTRY & EXIT ZONES — Confluence of Multiple Methods').setBackground('#004d40').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
    sh.getRange(row,1,1,8).setValues([['Zone','Price Range','Midpoint',deps.legacyReportText?'Confidence':'Method agreement','Which methods agree','% vs Now','Suggested Action','Horizon / Basis']]).setFontWeight('bold').setBackground('#00695c').setFontColor('#fff');row++;
    const entryUpside=(confluence.entryCenter/cp-1)*100;
    const entryAligned=(confluence.entryMethods||[]).map((m: any)=>m.name).join(' | ')||'No strong confluence';
    // E1 (option A, label only; not in legacy-report mode): the price is already inside/below the zone, above the stop
    const atLimit = deps.legacyReportText ? null : atBuyLimit({ timing: techPlan.timing, currentPrice: cp, entryLow: techPlan.entryLow, entryHigh: techPlan.entryHigh, entryPrice: techPlan.entryPrice, stop: techPlan.stop });
    const entrySuggestedAction = atLimit ? atLimit.text
      : techPlan.timing==='AVOID' ? 'Plan says AVOID — regime/momentum unsupportive right now'
      : techPlan.timing==='BUY_NOW' ? 'Near current price — plan says buy now'
      : 'Wait for the zone — plan says buy on a dip';
    const entryVsNow = (entryUpside>=0?'+':'')+entryUpside.toFixed(1)+'% from now'+(atLimit ? ' — price is already '+atLimit.where+' the buy zone' : '');
    sh.getRange(row,1,1,8).setValues([['📥 ENTRY (Buy Zone)','$'+confluence.entryLow.toFixed(2)+' – $'+confluence.entryHigh.toFixed(2),'$'+confluence.entryCenter.toFixed(2),confluence.entryConfidence,entryAligned,entryVsNow,entrySuggestedAction,'Short-term entry: dip buy']]).setBackground('#e0f2f1');
    sh.getRange(row,4).setFontColor(confluence.entryCount>=3?'#1b5e20':confluence.entryCount>=2?'#e65100':'#b71c1c').setFontWeight('bold');
    sh.getRange(row,3).setFontWeight('bold').setFontColor('#004d40');row++;
    const exitUpside=(confluence.exitCenter/cp-1)*100;
    const exitAligned=(confluence.exitMethods||[]).map((m: any)=>m.name).join(' | ')||'No strong confluence';
    sh.getRange(row,1,1,8).setValues([['📤 EXIT (Sell Zone)','$'+confluence.exitLow.toFixed(2)+' – $'+confluence.exitHigh.toFixed(2),'$'+confluence.exitCenter.toFixed(2),confluence.exitConfidence,exitAligned,'+'+(exitUpside).toFixed(1)+'% upside',exitUpside>40?'Long-term hold — significant upside':exitUpside>15?'Medium-term target':'Near-term resistance','Long-term exit: scale out at zone']]).setBackground('#fce4ec');
    sh.getRange(row,4).setFontColor(confluence.exitCount>=3?'#1b5e20':confluence.exitCount>=2?'#e65100':'#b71c1c').setFontWeight('bold');
    sh.getRange(row,3).setFontWeight('bold').setFontColor('#880e4f');row++;
    // B1 option B (display only; not in legacy-report mode): the nearest valid resistance 1 ATR above the entry, next to T1
    if (!deps.legacyReportText) {
      let nr: NextResistance | null = null;
      try { nr = nextResistance({ confluence, atr: ind.atr14, entryPrice: techPlan.entryPrice, stop: techPlan.stop, currentPrice: cp, t1Price: techPlan.t1?.price }); } catch { nr = null; }
      if (nr) {
        const t1p = techPlan.t1 && techPlan.t1.price != null ? techPlan.t1.price : null;
        sh.getRange(row,1,1,8).setValues([['🧱 NEXT RESISTANCE','$'+nr.low.toFixed(2)+' – $'+nr.high.toFixed(2),'$'+nr.price.toFixed(2),nr.methods.length+' method'+(nr.methods.length===1?'':'s'),nr.methods.join(' | '),(nr.pctFromPrice>=0?'+':'')+nr.pctFromPrice.toFixed(1)+'% from now',
          nr.text+(t1p!=null?' (T1 $'+t1p.toFixed(2)+' and its R:R '+(techPlan.rrToT1!=null?techPlan.rrToT1.toFixed(2):'—')+' unchanged)':''),'Display only: where selling may start first']]).setBackground('#fff8e1');
        row++;
      }
    }
    row++;
    sh.getRange(row,1,1,14).merge().setValue('📋  ALL PRICE METHODS — Entry (short) & Exit (long)').setBackground('#37474f').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    sh.getRange(row,1,1,6).setValues([['Price Method','Target Price','% vs Now','Horizon','Entry / Exit','Status']]).setFontWeight('bold').setBackground('#546e7a').setFontColor('#fff');row++;
    const rawAll: any[]=[...(confluence.allEntryMethods||[]).map((m: any)=>({...m,tf:'Short'})),...(confluence.allExitMethods||[]).map((m: any)=>({...m,tf:'Long'}))];
    const allMethods = rawAll.filter(m => !m.excluded && m.price != null);
    const excludedMethods = rawAll.filter(m => m.excluded || m.price == null);
    allMethods.sort((a,b)=>a.price-b.price).forEach((m,i)=>{
      try{
        const pct=(m.price/cp-1)*100;
        const isEntry=m.type==='support';
        const isConfluent=(isEntry?confluence.entryMethods:confluence.exitMethods).some((c: any)=>c.name===m.name);
        sh.getRange(row,1,1,6).setValues([[m.name,'$'+m.price.toFixed(2),(pct>=0?'+':'')+pct.toFixed(2)+'%',m.tf,isEntry?'Entry':'Exit','']]).setBackground(isConfluent?(isEntry?'#a5d6a7':'#f48fb1'):i%2===0?'#eceff1':'#f5f5f5');
        sh.getRange(row,3).setFontColor(pct>=0?'#2e7d32':'#c62828');
        if(isConfluent)sh.getRange(row,1,1,6).setFontWeight('bold');
      }catch(e){}
      row++;
    });
    if (excludedMethods.length) {
      sh.getRange(row,1,1,6).merge().setValue('Excluded this run (candidate methods evaluated but not currently qualifying):').setFontStyle('italic').setFontSize(9).setFontColor('#666');row++;
      excludedMethods.forEach(m => {
        const priceStr = m.price != null ? '$'+m.price.toFixed(2) : 'N/A';
        sh.getRange(row,1,1,6).setValues([[m.name, priceStr, '', m.tf, m.type==='support'?'Entry':'Exit', m.exclusionReason||'excluded']]).setBackground('#fafafa').setFontColor('#999').setFontSize(9);
        row++;
      });
    }
    row+=2;
  }catch(e){sh.getRange(row,1).setValue(errCell('Entry/exit zone', e, 80)).setFontColor('#e65100');row+=5;}

  // ══ ATR — Volatility & Risk Sizing (and the stop / sizing / structure reads) ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📏  ATR — Volatility & Risk Sizing').setBackground('#00695c').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
    const atrPctOfPrice = (ind.atr14/cp*100).toFixed(1);
    const atrReadWord = ind.atrRatio>1.3?'expanding':ind.atrRatio<0.7?'contracting':'normal';
    sh.getRange(row,1,1,4).setValues([['ATR(14)','% of price','vs 50d avg','Volatility regime']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
    sh.getRange(row,1,1,4).setValues([['$'+ind.atr14.toFixed(2), atrPctOfPrice+'%', 'x'+ind.atrRatio.toFixed(2), atrReadWord]]).setBackground('#e0f2f1');row++;
    row++;
    const atrEntry = cp - 1.5 * ind.atr14;
    sh.getRange(row,1,1,3).setValues([['ATR-based entry (1.5×ATR pullback)','Price','% vs now']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
    sh.getRange(row,1,1,3).setValues([['', '$'+atrEntry.toFixed(2), ((atrEntry/cp-1)*100).toFixed(1)+'%']]).setBackground('#e0f2f1');row++;
    row++;
    const stopMult = techPlan.regime==='HIGH_VOL'?2.0 : (techPlan.regime==='TREND_UP'||techPlan.regime==='TREND_DOWN')?1.25 : 1.5;
    const riskDollars = techPlan.entryPrice - techPlan.stop;
    sh.getRange(row,1,1,4).setValues([['ATR-based stop','Multiplier used','Regime driving it','Risk ($)']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
    sh.getRange(row,1,1,4).setValues([['$'+techPlan.stop.toFixed(2), stopMult.toFixed(2)+'×ATR', techPlan.regime+' → '+stopMult.toFixed(2)+'×', '$'+riskDollars.toFixed(2)]]).setBackground('#e0f2f1');row++;
    sh.getRange(row,1,1,14).merge().setValue('Stop multiplier adapts to regime: 2.0× in HIGH_VOL (wider, since volatility itself is expanding), 1.25× in a clean TREND_UP/TREND_DOWN (tighter, trend is doing the work), 1.5× otherwise.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;

    if (ind.chandelierStop != null) {
      sh.getRange(row,1,1,4).setValues([['Trailing stop (Chandelier)','22-day high','Multiplier','Distance from current price']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['$'+ind.chandelierStop.toFixed(2), '$'+ind.chandelierHighestHigh.toFixed(2), '3×ATR', chandelierDistanceText(cp, ind.chandelierStop, !!deps.legacyReportText)]]).setBackground('#e0f2f1');row++;
      sh.getRange(row,1,1,14).merge().setValue('Ratchets UP as the 22-day high increases (never down) -- unlike the fixed stop above, this ADAPTS as a position works in your favor, locking in gains rather than staying fixed at entry.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    if (techPlan.classicalStop) {
      const cs = techPlan.classicalStop;
      sh.getRange(row,1,1,4).setValues([['Classical stop (Schabacker)','Basing point','Basing point date','Distance from current price']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['$'+cs.level.toFixed(2), '$'+cs.basingPointPrice.toFixed(2), formatDateInTz(new Date(cs.basingPointDate), tz, 'yyyy-MM-dd'), '$'+(cp-cs.level).toFixed(2)]]).setBackground('#e0f2f1');row++;
      sh.getRange(row,1,1,14).merge().setValue('A real prior swing low, ATR-scaled buffer below it, nudged off round numbers -- distinct from the fixed ATR stop above, which is a pure volatility offset from entry with no connection to actual chart structure.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    if (techPlan.basingPointStop) {
      const bps = techPlan.basingPointStop;
      sh.getRange(row,1,1,4).setValues([['Basing Point stop (Edwards & Magee)','Basing point','Basing point date','Stop % / tier']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['$'+bps.level.toFixed(2), '$'+bps.basingPointPrice.toFixed(2), formatDateInTz(new Date(bps.basingPointDate), tz, 'yyyy-MM-dd'), (bps.stopPct*100).toFixed(0)+'% / '+bps.sensitivityTier]]).setBackground('#ede7f6');row++;
      sh.getRange(row,1,1,14).merge().setValue('A swing point confirmed via the book\'s own real "Three Days Away" rule (3 consecutive days trading entirely outside the swing point\'s own range), stop-distance from the book\'s own real price/sensitivity table -- distinct from the classical stop above, which uses a flat ATR-scaled buffer with no confirmation wait.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    if (techPlan.alternateBasingPointStop) {
      const abps = techPlan.alternateBasingPointStop;
      sh.getRange(row,1,1,4).setValues([['Alternate Basing Point stop (Edwards & Magee, p443)','Basing point','Basing point date','Stop % / tier']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['$'+abps.level.toFixed(2), '$'+abps.basingPointPrice.toFixed(2), formatDateInTz(new Date(abps.basingPointDate), tz, 'yyyy-MM-dd'), (abps.stopPct*100).toFixed(0)+'% / '+abps.sensitivityTier]]).setBackground('#ede7f6');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real 2nd basing-point-creation rule (p443): a >=15% Primary-direction move, retraced >=40% before resuming -- even without a clean sharp reversal. Same real stop-distance table as the Basing Point stop above, just an alternate way to identify the basing point itself.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    if (techPlan.sidewaysBasingPointStop) {
      const sbps = techPlan.sidewaysBasingPointStop;
      sh.getRange(row,1,1,4).setValues([['Sideways Basing Point stop (Edwards & Magee, p443-444)','Basing point','Basing point date','Stop % / tier']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['$'+sbps.level.toFixed(2), '$'+sbps.basingPointPrice.toFixed(2), formatDateInTz(new Date(sbps.basingPointDate), tz, 'yyyy-MM-dd'), (sbps.stopPct*100).toFixed(0)+'% / '+sbps.sensitivityTier]]).setBackground('#ede7f6');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real 3rd, final basing-point-creation rule (p443-444): a <40% retracement that instead "marks time at the same level" for a week or more, with declining volume vs. the primary move ("the volume indications are right"). Same real stop-distance table as the 2 basing-point stops above, just a 3rd way to identify the basing point itself.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    if (ind.progressiveStopFlag) {
      const ps = ind.progressiveStopFlag;
      sh.getRange(row,1,1,4).setValues([['Progressive Stop trigger (Edwards & Magee)','Suggested tight stop (today only)','Volume vs 20d avg','Uptrend maturity']]).setFontWeight('bold').setBackground('#c62828').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['⚠ TRIGGERED', '$'+ps.level.toFixed(2), ps.volumeRatio.toFixed(1)+'x', ps.daysSinceCross+' days since cross']]).setBackground('#ffebee');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real rule: exceptionally heavy volume (>3x avg) on an UP day, after an established uptrend (not the very first breakout day) -- "nine times out of ten" better off tightening to just 1/8 point under today\'s close, "for the day only." Informational only, not a persisted/ratcheting stop -- re-evaluate fresh next time this ticker is analyzed.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    if (techPlan.nNormalizedPositionSize) {
      const nps = techPlan.nNormalizedPositionSize;
      sh.getRange(row,1,1,4).setValues([['N-normalized size (Edwards & Magee, Turtle-style)','Shares','2N stop level','$ risk / % of account']]).setFontWeight('bold').setBackground('#00695c').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['2nd opinion vs "Size:" above', nps.shares, '$'+nps.stopLevel.toFixed(2), '$'+nps.dollarRisk.toFixed(0)+' / '+nps.riskPctOfAccount.toFixed(1)+'%'+(deps.legacyReportText?'':' '+assumedAccountText())]]).setBackground('#e0f2f1');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real Turtle-system rule: size the position so a full 2N move (N=20-day Wilder-smoothed True Range) costs exactly 2% of account equity -- volatility-normalized, distinct from the conviction-scaled "Size:" line above, which uses a fixed stop distance instead. A cross-check, not a replacement.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    if (techPlan.compositeLeverage) {
      const cl = techPlan.compositeLeverage;
      sh.getRange(row,1,1,4).setValues([['Composite Leverage (Edwards & Magee)','Leverage','Normal Range-for-Price','Read']]).setFontWeight('bold').setBackground('#4527a0').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['(S×N)/15.5, cash-only', cl.leverage.toFixed(2)+'x', cl.normalRangeForPrice.toFixed(1), cl.tier]]).setBackground('#ede7f6');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real formula for how much real risk a dollar commitment represents, combining this ticker\'s own volatility (Sensitivity Index, approximated via atrRatio) with its price-level\'s own typical range -- simplified for a cash-only, no-margin strategy (T/C=1). Informational only.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    if (techPlan.fanPrinciple) {
      const fp = techPlan.fanPrinciple;
      sh.getRange(row,1,1,4).setValues([['Fan Principle (Edwards & Magee)','Fan lines broken','Flattening?','Read']]).setFontWeight('bold').setBackground('#00838f').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['Origin $'+fp.originPrice.toFixed(2)+' ('+formatDateInTz(new Date(fp.originDate), tz, 'yyyy-MM-dd')+')', fp.brokenCount+'/3', fp.flattening?'yes':'no', fp.triggered ? '✅ 3rd Fan Line broken — correction likely over' : (fp.brokenCount+'/3 broken — correction may still be in progress')]]).setBackground('#e0f7fa');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real "Three-Fan Rule" (Ch14): as a correction unfolds, price breaks progressively flatter trendlines drawn from the correction\'s own starting extreme -- when the 3rd such line breaks, the book\'s own real claim is the correction is over and the Primary trend resumes ("works in the great majority of cases," not independently backtested here). Informational only.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
    if (techPlan.trendChannel) {
      const tc = techPlan.trendChannel;
      sh.getRange(row,1,1,4).setValues([['Trend Channel (Edwards & Magee)','Basic Trendline (now)','Return Line (now)','Read']]).setFontWeight('bold').setBackground('#5d4037').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([['', '$'+tc.basicTrendline.currentValue.toFixed(2), '$'+tc.returnLine.currentValue.toFixed(2), tc.projectedOvershoot != null ? ('Last swing fell short by $'+tc.projectedOvershoot.toFixed(2)+' — book\'s own rule projects the SAME overshoot on the opposite boundary next') : 'Last swing reached/exceeded its own boundary — no real projection to make']]).setBackground('#efebe9');row++;
      sh.getRange(row,1,1,14).merge().setValue('The book\'s own real symmetric rule (Ch14, Fig.156): a Return Line parallel to the Basic Trendline bounds a real Trend Channel -- if a swing falls short of its own boundary by some margin, the book\'s own claim is the NEXT swing will overshoot the OPPOSITE boundary by that same margin. The $ amount above applies to that opposite boundary\'s own value when the next swing actually occurs (both lines are sloped) -- not a fixed price today. Informational only.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
  } catch(e) { sh.getRange(row,1).setValue(errCell('ATR section', e, 80)).setFontColor('#e65100'); row+=3; }

  // ══ LILO LADDER — opt-in only (renders NOTHING if both toggles are off) ══
  if (ladderStock || ladderOptions) {
    try {
      sh.getRange(row,1,1,14).merge().setValue('🪜  LILO — STAGED ENTRY/EXIT (opt-in)').setBackground('#6a1b9a').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
      if (ladderStock) {
        const entryLadder = computeStockEntryLadder(confluence);
        const exitLadder = computeStockExitLadder(techPlan);
        const entryPct = ladderDisplayPercents(entryLadder), exitPct = ladderDisplayPercents(exitLadder);
        sh.getRange(row,1,1,14).merge().setValue('Stock ladder').setBackground('#8e24aa').setFontColor('#fff').setFontWeight('bold');row++;
        sh.getRange(row,1,1,4).setValues([['Rung','Trigger price','Portion','Side']]).setFontWeight('bold').setBackground('#ce93d8');row++;
        if (!entryLadder.length && !exitLadder.length) {
          sh.getRange(row,1,1,4).merge().setValue('No confluence methods aligned — ladder unavailable for this run.').setFontStyle('italic').setFontColor('#666');row++;
        }
        entryLadder.forEach((r,i) => { sh.getRange(row,1,1,4).setValues([[r.rung, '$'+r.price.toFixed(2), entryPct[i]+'%', 'BUY']]).setBackground('#f3e5f5'); row++; });
        exitLadder.forEach((r,i) => { sh.getRange(row,1,1,4).setValues([[r.rung, '$'+r.price.toFixed(2), exitPct[i]+'%', 'SELL']]).setBackground('#fce4ec'); row++; });
        row++;
      }
      if (ladderOptions && techPlan.options && techPlan.options.available) {
        const entryLadder = computeOptionsEntryLadder(confluence);
        const exitLadder = computeOptionsExitLadder(techPlan);
        const entryPct = ladderDisplayPercents(entryLadder), exitPct = ladderDisplayPercents(exitLadder);
        sh.getRange(row,1,1,14).merge().setValue('Options ladder — same contract, staged into/out of it').setBackground('#8e24aa').setFontColor('#fff').setFontWeight('bold');row++;
        sh.getRange(row,1,1,4).setValues([['Rung','Trigger price (underlying)','Portion','Side']]).setFontWeight('bold').setBackground('#ce93d8');row++;
        if (!entryLadder.length && !exitLadder.length) {
          sh.getRange(row,1,1,4).merge().setValue('No confluence methods aligned — ladder unavailable for this run.').setFontStyle('italic').setFontColor('#666');row++;
        }
        entryLadder.forEach((r,i) => { sh.getRange(row,1,1,4).setValues([[r.rung, '$'+r.price.toFixed(2), entryPct[i]+'%', 'BUY']]).setBackground('#f3e5f5'); row++; });
        exitLadder.forEach((r,i) => { sh.getRange(row,1,1,4).setValues([[r.rung, '$'+r.price.toFixed(2), exitPct[i]+'%', 'SELL']]).setBackground('#fce4ec'); row++; });
        sh.getRange(row,1,1,14).merge().setValue('⏳ '+optionsLadderTimeDecayNote()).setBackground('#fff3e0').setFontColor('#e65100').setFontStyle('italic').setWrap(true);row++;
        const expiryFlag = (techPlan.options.horizon && techPlan.options.horizon.days!=null) ? optionsExpiryFlag(techPlan.options.horizon.days) : null;
        if (expiryFlag) { sh.getRange(row,1,1,14).merge().setValue(expiryFlag).setBackground('#ffebee').setFontColor('#c62828').setFontWeight('bold');row++; }
        row++;
      } else if (ladderOptions) {
        sh.getRange(row,1,1,14).merge().setValue('Options ladder requested, but no usable options data for this ticker — run Options Analysis first.').setBackground('#fff3e0').setFontColor('#e65100').setFontStyle('italic');row+=2;
      }
      sh.getRange(row,1,1,14).merge().setValue('Ladder rungs are suggestions, not exact position sizing. When you act on one, log it as a normal row in '+TRANSACTIONS_SHEET+' (optionally note "LILO rung N" for your own reference).').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    } catch(e) { sh.getRange(row,1).setValue(errCell('LILO ladder', e, 80)).setFontColor('#e65100'); row+=3; }
  }

  // Recommended contract — LEAPS and short-term (only when this run came from Full Ticker Analysis)
  try {
    if (leapsCallArg || shortTermCallArg) {
      sh.getRange(row,1,1,14).merge().setValue('📞  RECOMMENDED CONTRACT — long calls only, single-leg (no puts/hedges/spreads)').setBackground('#4a148c').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
      const writeContractLine = (label: string, pick: any): void => {
        if (!pick) { sh.getRange(row,1,1,14).merge().setValue(label+': not available this run').setFontColor('#999').setFontSize(9);row++; return; }
        if (!pick.found) { sh.getRange(row,1,1,14).merge().setValue(label+': '+notFoundText(pick.reason, textOpts)).setFontColor('#c62828').setFontSize(9);row++; return; }
        const c = pick.contract;
        const expDate = new Date(c.expUnix * 1000);
        sh.getRange(row,1,1,14).merge().setValue(label+': $'+c.strike+' call, exp '+(deps.legacyReportText?dateStringInTz(expDate, tz):occExpiryText(c.expUnix))+'   Delta: '+c.delta.toFixed(2)+'   IV: '+(c.iv?(c.iv*100).toFixed(1)+'%':'N/A')+'   Bid/Ask: $'+c.bid.toFixed(2)+'/$'+c.ask.toFixed(2)).setBackground('#f3e5f5');row++;
      };
      writeContractLine(deps.legacyReportText ? 'LEAPS (>1yr, target delta 0.75)' : pickLabel(true, 0.75), leapsCallArg);
      writeContractLine(deps.legacyReportText ? 'Short-term (<1yr, target delta 0.50)' : pickLabel(false, 0.50), shortTermCallArg);
      sh.getRange(row,1,1,14).merge().setValue(deps.legacyReportText ? 'Full candidate comparison (other strikes considered) is in 🏆 Top 10 Conviction. Expiry choice is a placeholder (furthest/nearest available), not yet tied to real price targets.' : 'Full candidate comparison (other strikes considered) is in 🏆 Top 10 Conviction. Expiry rule: LEAPS = '+LEAPS_RULE+'; short-term = '+SHORT_TERM_RULE+' (so selling 30 days before expiry still leaves at least 30 days of holding). Not yet tied to real price targets.').setFontStyle('italic').setFontColor('#666').setFontSize(9).setWrap(true);row+=2;
    }
  } catch(e) { sh.getRange(row,1).setValue(errCell('Recommended contract', e, 80)).setFontColor('#e65100'); row+=3; }

  // ══ v7 SYNTHESIS ENGINE — PRIMARY decision ══
  try {
    const regimeLine = techPlan.regime==='TREND_UP' ? '📈 REGIME: TREND_UP — entries permitted'
      : techPlan.regime==='TREND_DOWN' ? '📉 REGIME: TREND_DOWN — avoid, no entries'
      : techPlan.regime==='HIGH_VOL' ? '⚡ REGIME: HIGH_VOL — no new entries, wait for clarity'
      : '🌊 REGIME: CHOP — no clear trend, no new entries, wait for clarity';
    const regimeColor = techPlan.regime==='TREND_UP' ? '#1b5e20' : techPlan.regime==='TREND_DOWN' ? '#b71c1c' : '#e65100';
    sh.getRange(row,1,1,14).merge().setValue(regimeLine).setBackground(regimeColor).setFontColor('#fff').setFontWeight('bold').setFontSize(11);row++;
    sh.getRange(row,1,1,14).merge().setValue('🏆  FINAL CONVICTION — PRIMARY (v7 sector-aware engine)').setBackground('#4a148c').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
    if (techPlan.headlineWeights) {
      const hw = techPlan.headlineWeights;
      const hwStr = Object.entries(hw).map(([k,v]: [string, any]) => k+' '+Math.round(v*100)+'%').join(', ');
      const defaultNote = techPlan.headlineUsedDefaultWeights ? ' (default — regime unrecognized)' : '';
      sh.getRange(row,1,1,14).merge().setValue('ℹ️ Headline weights adapted for this run\'s regime (' + techPlan.regime + defaultNote + '): ' + hwStr).setFontStyle('italic').setFontSize(9).setFontColor('#4a148c').setWrap(true);row++;
    }
    sh.getRange(row,1,1,10).setValues([['OWN (business only) /100','Own Verdict','BUY-TIMING (chart only) /100','Timing','Regime','Options Read','Net $ Bias',deps.legacyReportText?'IV %ile':IV_CHAIN_PCT_LABEL,'FINAL CONVICTION /100','Action']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
    const optRead = (opts&&opts.available)?(opts.confirm==='confirm'?'✅ CONFIRM (+8)':opts.confirm==='conflict'?'⚠️ CONFLICT (−10)':'➖ Neutral'):'— no data';
    const nbStr = (opts&&opts.available&&opts.netBiasPct!=null)?((opts.netBiasPct>0?'+':'')+opts.netBiasPct+'%'):'—';
    const ivStr = (opts&&opts.available&&opts.ivRank!=null)?(opts.ivRank+'th'):'—';
    sh.getRange(row,1,1,10).setValues([[fundResult.score!=null?fundResult.score:'N/A',fundResult.verdict||'N/A',techPlan.techScore,techPlan.timing,techPlan.regime,optRead,nbStr,ivStr,decision.finalConviction,decision.action]]);
    sh.getRange(row,1,1,10).setNumberFormat('General');colorVerdictRow9(sh,row,decision.finalConviction);sh.getRange(row,9).setFontWeight('bold').setFontSize(13);row++;
    if (decision.lines&&decision.lines.length){ sh.getRange(row,1,1,14).merge().setValue('   '+decision.lines.join('   ·   ')).setBackground('#ede7f6').setFontColor('#4527a0').setFontStyle('italic').setWrap(true);row++; }
    row+=2;

    // ②  SECOND OPINION — legacy v6.1 dual-timeframe engine (context only, NOT the decision)
    sh.getRange(row,1,1,14).merge().setValue('②  SECOND OPINION — legacy v6.1 dual-timeframe engine (context only, NOT the decision)').setBackground('#78909c').setFontColor('#fff').setFontSize(11).setFontStyle('italic');row++;
    sh.getRange(row,1,1,9).setValues([['Timeframe','Technical /100','Tech Verdict','Gann /100','Gann Signal','Fundamentals /100','Fund Verdict','Legacy Conviction /100','Legacy Action']]).setFontWeight('bold').setBackground('#90a4ae').setFontColor('#fff');row++;
    const gannVerdict=gann.score>=70?'🟢 Bullish':gann.score>=50?'🟡 Neutral':'🔴 Bearish';
    sh.getRange(row,1,1,9).setValues([['SHORT (Days/Weeks)',scores.shortScore,scores.shortVerdict,gann.score,gannVerdict,scores.fundScore!==null?scores.fundScore:'N/A',scores.fundVerdict,scores.shortConviction,scores.shortConviction>=60?'▲ BUY':scores.shortConviction<=40?'▼ SELL':'● HOLD']]).setBackground('#eceff1').setFontColor('#546e7a');row++;
    sh.getRange(row,1,1,9).setValues([['LONG (Months/1-2yr)',scores.longScore,scores.longVerdict,gann.score,gannVerdict,scores.fundScore!==null?scores.fundScore:'N/A',scores.fundVerdict,scores.longConviction,scores.longConviction>=60?'▲ HOLD/BUY MORE':scores.longConviction<=40?'▼ SELL':'● HOLD']]).setBackground('#f5f5f5').setFontColor('#546e7a');row++;

    const legacyShortAction = scores.shortConviction>=60?'BUY':scores.shortConviction<=40?'SELL':'HOLD';
    if (techPlan.timing !== 'BUY_NOW' && legacyShortAction === 'BUY') {
      sh.getRange(row,1,1,14).merge()
        .setValue('ℹ️ Why these disagree: v7\'s technical/fundamental reads are similarly bullish to legacy\'s -- they diverge because v7\'s regime gate ('+techPlan.regime+') holds back full conviction until the setup actually confirms, which legacy\'s formula has no equivalent for. Legacy blends technical+fundamentals only; it never checks whether now is a good time to act on that read.')
        .setFontStyle('italic').setFontSize(9).setFontColor('#5d4037').setBackground('#fff8e1').setWrap(true);
      row++;
    }
    row++;
  }catch(e){sh.getRange(row,1).setValue(errCell('Verdict', e, 80)).setFontColor('#e65100');row+=4;}

  // ══ MACRO RANGE — presentation only ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📏  MACRO RANGE — Where Price Is Expected To Move').setBackground('#00838f').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row++;
    const atrPctOfPrice = (ind.atr14/cp*100).toFixed(1);
    const atrReadWord = ind.atrRatio>1.3?'expanding':ind.atrRatio<0.7?'contracting':'normal';
    sh.getRange(row,1,1,4).setValues([['Daily range (ATR)','Volatility regime','Bollinger channel','Squeeze']]).setFontWeight('bold').setBackground('#0097a7').setFontColor('#fff');row++;
    sh.getRange(row,1,1,4).setValues([['±$'+ind.atr14.toFixed(2)+' ('+atrPctOfPrice+'% of price)','x'+ind.atrRatio.toFixed(2)+' vs 50d avg — '+atrReadWord,'$'+ind.bbLower.toFixed(2)+' – $'+ind.bbUpper.toFixed(2), ind.bbSqueeze?'⚠ TIGHT — often precedes a sharp move':'normal']]).setBackground('#e0f7fa');row++;
    if (ind.keltnerSqueeze) {
      sh.getRange(row,1,1,4).merge().setValue('⚠ Keltner squeeze confirmed — Bollinger bands sitting inside the Keltner Channel, a stronger volatility-compression signal than Bollinger width alone').setBackground('#fff3e0').setFontColor('#e65100').setFontStyle('italic').setWrap(true);row++;
    }
    row++;
    const masterSide = gann.gannMaster ? (gann.gannMaster < cp ? 'support' : 'resistance') : 'N/A';
    sh.getRange(row,1,1,4).setValues([['Structural channel (Gann fan)','Riding between','1×1 master level','Acting as']]).setFontWeight('bold').setBackground('#0097a7').setFontColor('#fff');row++;
    sh.getRange(row,1,1,4).setValues([['weeks–months horizon', gann.lowerAngle+' – '+gann.upperAngle, gann.gannMaster?'$'+gann.gannMaster.toFixed(2):'N/A', masterSide]]).setBackground('#e0f7fa');row++;
    row++;
    const envelopeLine = 'Near-term (days): $'+ind.bbLower.toFixed(2)+'–$'+ind.bbUpper.toFixed(2)+' (Bollinger). '
      + 'Structural (weeks–months): riding between the '+gann.lowerAngle+' and '+gann.upperAngle+' Gann angles'
      + (gann.gannMaster ? ', 1×1 master level $'+gann.gannMaster.toFixed(2)+' acting as '+masterSide+'.' : '.');
    sh.getRange(row,1,1,14).merge().setValue(envelopeLine).setBackground('#b2ebf2').setFontColor('#006064').setFontStyle('italic').setWrap(true);row+=2;
    if (chart.vixContext) {
      const vx = chart.vixContext;
      sh.getRange(row,1,1,4).setValues([['VIX (broad market)','52wk range','Position in range','Read']]).setFontWeight('bold').setBackground('#0097a7').setFontColor('#fff');row++;
      sh.getRange(row,1,1,4).setValues([[vx.level.toFixed(2), vx.low52.toFixed(2)+' – '+vx.high52.toFixed(2), vx.rangePct.toFixed(0)+'%', vx.read]]).setBackground('#e0f7fa');
      sh.getRange(row,4).setFontColor(vx.read==='fear/crisis'?'#c62828':vx.read==='elevated'?'#e65100':'#2e7d32').setFontWeight('bold');
      row++;
      if (vx.courseRead) {
        sh.getRange(row,1,1,4).merge().setValue('Broker-course VIX regime (ep.2 bands): ' + vx.courseRead.regime + (vx.courseRead.regime.indexOf('Normal') === 0 ? ' — real, OOS-confirmed mild underperformance signal (tests/vix_yield_oos_split_test.js)' : '')).setBackground('#e0f7fa').setFontColor('#00695c').setFontSize(9);
        row++;
      }
      if (vx.divergence5d && vx.divergence5d.flagged) {
        sh.getRange(row,1,1,4).merge().setValue(vx.divergence5d.note+'  (VIX 5d slope +'+vx.divergence5d.vixSlope5.toFixed(2)+', S&P 5d '+(vx.divergence5d.spyChange5pct>=0?'+':'')+vx.divergence5d.spyChange5pct.toFixed(2)+'%)').setBackground('#fff3e0').setFontColor('#e65100').setFontWeight('bold');
        row++;
      }
      row++;
    }
    if (deps.marketOptionsLine) {
      sh.getRange(row,1,1,14).merge().setValue(deps.marketOptionsLine).setBackground('#ede7f6').setFontColor('#4a148c').setFontSize(9).setWrap(true);
      row+=2;
    }
  }catch(e){sh.getRange(row,1).setValue(errCell('Macro range', e, 80)).setFontColor('#e65100');row+=3;}

  // ══ SIGNAL CROSS-REFERENCE ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('🧭  SIGNAL CROSS-REFERENCE — Category Agreement').setBackground('#00695c').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    sh.getRange(row,1,1,14).merge().setValue('ℹ️ Category weights adapted for this run\'s regime ('+scores.regimeUsedForWeights+'). Short-term: '+Object.entries(scores.shortW).map(([k,v]: [string, any])=>k+' '+Math.round(v*100)+'%').join(', ')+'. Long-term: '+Object.entries(scores.longW).map(([k,v]: [string, any])=>k+' '+Math.round(v*100)+'%').join(', ')+'.').setFontStyle('italic').setFontSize(9).setFontColor('#00695c').setWrap(true);row++;
    sh.getRange(row,1,1,6).setValues([['Category','Short /100','Short Read','Long /100','Long Read','# signals']]).setFontWeight('bold').setBackground('#00897b').setFontColor('#fff');row++;
    const catList=['Trend','Momentum','Volume','Volatility','Position'];
    const readOf=(s: any)=>s==null?'—':s>=60?'🟢 Bullish':s<=40?'🔴 Bearish':'🟡 Neutral';
    catList.forEach((c,i)=>{
      try{
        const sc=scores.shortCats&&scores.shortCats[c], lc=scores.longCats&&scores.longCats[c];
        if(!sc&&!lc)return;
        const cnt=((sc&&sc.count)||0)+((lc&&lc.count)||0);
        sh.getRange(row,1,1,6).setValues([[c,sc?Math.round(sc.score):'—',readOf(sc?sc.score:null),lc?Math.round(lc.score):'—',readOf(lc?lc.score:null),cnt]]).setBackground(i%2===0?'#e0f2f1':'#f1f8e9');
        sh.getRange(row,2).setNumberFormat('0'); sh.getRange(row,4).setNumberFormat('0'); sh.getRange(row,6).setNumberFormat('0');
        row++;
      }catch(e){}
    });
    const sConf=scores.shortConflict, lConf=scores.longConflict;
    sh.getRange(row,1,1,6).merge().setValue('Short-term: '+((sConf&&sConf.note)||'—')).setBackground(sConf&&sConf.conflict?'#ffe0b2':'#e8f5e9').setFontStyle('italic');row++;
    sh.getRange(row,1,1,6).merge().setValue('Long-term: '+((lConf&&lConf.note)||'—')).setBackground(lConf&&lConf.conflict?'#ffe0b2':'#e8f5e9').setFontStyle('italic');row++;

    // Dynamic per-run decision trace: the biggest |signal| x weight x category-weight contributor
    const biggestDriver = (signalList: any[], catWeights: any): any => {
      let best: any = null, bestContribution = -1;
      signalList.forEach(s => {
        const catW = catWeights[s.cat] != null ? catWeights[s.cat] : 0.1;
        const contribution = Math.abs(s.signal) * s.weight * catW;
        if (contribution > bestContribution) { bestContribution = contribution; best = s; }
      });
      return best;
    };
    const shortDriver = biggestDriver(scores.shortSignals||[], scores.shortW||{});
    const longDriver = biggestDriver(scores.longSignals||[], scores.longW||{});
    const traceLine = (label: string, overallScore: number, driver: any): string | null => {
      if (!driver) return null;
      const pts = Math.round((driver.signal+1)/2*100);
      const driverBullish = pts > 50, overallBullish = overallScore > 50;
      const verb = (driverBullish === overallBullish)
        ? 'driven primarily by'
        : 'held back primarily by (the biggest drag against an otherwise '+(overallBullish?'higher':'lower')+' score)';
      return 'Why '+label+' scored '+overallScore+': '+verb+' '+driver.name+' ('+pts+' points, '+driver.cat+' category) — the single biggest contributor to this run\'s score.';
    };
    const shortLine = traceLine('SHORT-TERM', scores.shortScore, shortDriver);
    const longLine = traceLine('LONG-TERM', scores.longScore, longDriver);
    if (shortLine) { sh.getRange(row,1,1,6).merge().setValue(shortLine).setFontStyle('italic').setFontSize(9).setFontColor('#5d4037').setWrap(true);row++; }
    if (longLine) { sh.getRange(row,1,1,6).merge().setValue(longLine).setFontStyle('italic').setFontSize(9).setFontColor('#5d4037').setWrap(true);row++; }

    const dv: any=scores.divergence, rs: any=scores.rs;
    if(dv){sh.getRange(row,1,1,6).merge().setValue('RSI divergence: '+dv.type.toUpperCase()+' — '+dv.note).setBackground(dv.type==='bullish'?'#c8e6c9':dv.type==='bearish'?'#ffcdd2':'#eceff1');row++;}
    const mdv: any=scores.macdDivergence, odv: any=scores.obvDivergence;
    if(mdv&&mdv.type!=='none'){sh.getRange(row,1,1,6).merge().setValue('MACD divergence: '+mdv.type.toUpperCase()+' — '+mdv.note).setBackground(mdv.type==='bullish'?'#c8e6c9':'#ffcdd2');row++;}
    if(odv&&odv.type!=='none'){sh.getRange(row,1,1,6).merge().setValue('OBV divergence: '+odv.type.toUpperCase()+' — '+odv.note).setBackground(odv.type==='bullish'?'#c8e6c9':'#ffcdd2');row++;}
    if(rs){sh.getRange(row,1,1,6).merge().setValue('Relative strength vs SPY (3mo): '+(rs.rs63>=0?'+':'')+rs.rs63.toFixed(1)+'% — '+(rs.outperforming?'outperforming the market':'lagging the market')).setBackground(rs.outperforming?'#c8e6c9':'#ffcdd2');row++;}
    if(chart.sectorRS){const srs=chart.sectorRS;sh.getRange(row,1,1,6).merge().setValue('Relative strength vs '+srs.etf+' / '+srs.sector+' sector (3mo): '+(srs.rs63>=0?'+':'')+srs.rs63.toFixed(1)+'% — '+(srs.outperforming?'outperforming its sector':'lagging its sector')).setBackground(srs.outperforming?'#c8e6c9':'#ffcdd2');row++;}
    if(chart.relativeSwingPower){const rsp=chart.relativeSwingPower;sh.getRange(row,1,1,6).merge().setValue('Relative swing power vs '+rsp.etf+' / '+rsp.sector+' sector (Schabacker): '+rsp.ratio.toFixed(2)+'x — swings '+(rsp.ratio>=1?((rsp.ratio-1)*100).toFixed(0)+'% wider than':((1-rsp.ratio)*100).toFixed(0)+'% narrower than')+' its sector average (informational, not scored)').setBackground('#eceff1');row++;}
    row+=2;
  }catch(e){sh.getRange(row,1).setValue(errCell('Cross-reference', e, 60)).setFontColor('#e65100');row+=3;}

  // ══ PRICE GAPS ══
  try {
    if (ind.priceGaps && ind.priceGaps.length) {
      hdr(sh,row,'⬜  PRICE GAPS (last ~3 months)','#455a64',11,14);row++;
      sh.getRange(row,1,1,7).setValues([['Date','Type','Level','Status','Class','Cause','Cap Context']]).setFontWeight('bold').setBackground('#546e7a').setFontColor('#fff');row++;
      const GAP_CLASS_LABELS: Record<string, string> = { BREAKAWAY:'🚀 Breakaway', EXHAUSTION:'🥵 Exhaustion', ISLAND:'🏝️ Island', RUNAWAY:'🏃 Runaway', COMMON:'Common' };
      ind.priceGaps.slice(-8).reverse().forEach((g: any,i: number) => { // most recent first, capped at 8
        const bg = !g.filled ? (g.type==='UP'?'#c8e6c9':'#ffcdd2') : (i%2===0?'#eceff1':'#fff');
        const cause: any = classifyGapCause(g, fund && fund._earningsHistory);
        const capNote = gapMarketCapContext(g, fund && fund.marketCap);
        sh.getRange(row,1,1,7).setValues([[
          formatDateInTz(new Date(g.date), tz, 'yyyy-MM-dd'),
          g.type==='UP'?'Gap Up ▲':'Gap Down ▼',
          '$'+g.level.toFixed(2)+' ('+(g.sizePct>=0?'+':'')+(g.sizePct*100).toFixed(1)+'%)',
          g.filled?'Filled':'UNFILLED — real S/R',
          GAP_CLASS_LABELS[g.gapType] || '',
          cause ? ('📊 Earnings' + (cause.epsSurprisePct!=null ? ' (EPS '+(cause.epsSurprisePct>=0?'+':'')+cause.epsSurprisePct.toFixed(1)+'%)' : '')) : '',
          capNote ? capNote.note : ''
        ]]).setBackground(bg);row++;
      });
      row++;
    }
  } catch(e) { /* non-fatal */ }

  // ══ CHART PATTERNS ══
  try {
    if (ind.chartPatterns && ind.chartPatterns.length) {
      hdr(sh,row,'📉  CHART PATTERNS','#4527a0',11,14);row++;
      sh.getRange(row,1,1,5).setValues([['Pattern','First Peak/Trough','Second Peak/Trough','Neckline','Status']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
      const fmtD = (d: any): string => formatDateInTz(new Date(d), tz, 'yyyy-MM-dd');
      const isBearish = (t: string): boolean => t==='DOUBLE_TOP' || t==='HEAD_AND_SHOULDERS' || t==='TRIPLE_TOP';
      const TW_TYPES = ['SYMMETRICAL_TRIANGLE','ASCENDING_TRIANGLE','DESCENDING_TRIANGLE','RISING_WEDGE','FALLING_WEDGE'];
      const FP_TYPES = ['BULL_FLAG','BEAR_FLAG','PENNANT'];
      ind.chartPatterns.forEach((p: any) => {
        const isTW = TW_TYPES.indexOf(p.type) >= 0;
        const isFP = FP_TYPES.indexOf(p.type) >= 0;
        const isRect = p.type === 'RECTANGLE';
        const RND_TYPES = ['ROUNDING_BOTTOM','ROUNDING_TOP','CUP_AND_HANDLE'];
        const isRnd = RND_TYPES.indexOf(p.type) >= 0;
        const isTrap = p.type === 'BULL_TRAP' || p.type === 'BEAR_TRAP';
        const isHM = p.type === 'HALF_MAST';
        const isBT = p.type === 'BROADENING_TOP' || p.type === 'BROADENING_BOTTOM';
        const isDM = p.type === 'DIAMOND_TOP' || p.type === 'DIAMOND_BOTTOM';
        const isCX = p.type === 'COMPLEX_TOP' || p.type === 'COMPLEX_BOTTOM';
        const bg = isTrap
          ? (p.status==='CONFIRMED' ? (p.type==='BULL_TRAP'?'#ffcdd2':'#c8e6c9') : '#fff9c4')
          : (isTW || isFP || isRect || isRnd || isHM || isBT || isDM)
          ? (p.status==='BROKE_UP'?'#c8e6c9':(p.status==='BROKE_DOWN'?'#ffcdd2':'#fff9c4'))
          : (isCX ? (p.confirmed ? (p.type==='COMPLEX_TOP'?'#ffcdd2':'#c8e6c9') : '#fff9c4')
          : (p.confirmed ? (isBearish(p.type)?'#ffcdd2':'#c8e6c9') : '#fff9c4'));
        let row5: any[];
        if (isTrap) {
          const isBull = p.type === 'BULL_TRAP';
          const label = isBull ? 'Bull Trap (avoid/exit — fake breakout)' : 'Bear Trap (buy opportunity — fake breakdown)';
          const levelLabel = isBull ? 'Resistance' : 'Support';
          const statusLabel = p.status==='CONFIRMED'
            ? (isBull ? 'CONFIRMED — broke above then failed back below' : 'CONFIRMED — broke below then reclaimed above')
            : 'WATCHING — broke through, not yet confirmed either way';
          row5 = [
            label,
            levelLabel+': $'+p.level.toFixed(2),
            isBull ? ('Broke '+fmtD(p.breakoutDate)) : ('Broke '+fmtD(p.breakdownDate)),
            p.status==='CONFIRMED' ? (isBull ? ('Failed back below '+fmtD(p.failDate)) : ('Reclaimed above '+fmtD(p.reclaimDate))) : '(within watch window)',
            statusLabel
          ];
        } else if (isRnd) {
          const RND_LABELS: Record<string, string> = { ROUNDING_BOTTOM:'Rounding Bottom (Saucer)', ROUNDING_TOP:'Rounding Top', CUP_AND_HANDLE:'Cup and Handle' };
          const rndBrokeWord = p.type==='ROUNDING_TOP' ? 'below' : 'above';
          const statusLabel = p.status==='BROKE_UP' ? ('BROKE UP — closed '+rndBrokeWord+' rim') : (p.status==='BROKE_DOWN' ? ('BROKE DOWN — closed '+rndBrokeWord+' rim') : 'Forming — rim not yet broken');
          row5 = [
            RND_LABELS[p.type],
            'Rim: $'+p.rim.toFixed(2),
            '(coarse curve-fit proxy, not a true parabola fit)',
            '$'+p.rim.toFixed(2),
            statusLabel
          ];
        } else if (isRect) {
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP — closed above resistance' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN — closed below support' : 'Forming — inside range');
          row5 = [
            'Rectangle',
            'Resistance: $'+p.resistanceLevel.toFixed(2),
            'Support: $'+p.supportLevel.toFixed(2),
            'Range: $'+p.supportLevel.toFixed(2)+' – $'+p.resistanceLevel.toFixed(2),
            statusLabel
          ];
        } else if (isFP) {
          const FP_LABELS: Record<string, string> = { BULL_FLAG:'Bull Flag', BEAR_FLAG:'Bear Flag', PENNANT:'Pennant' };
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP — continuation confirmed' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN — continuation confirmed' : 'Forming — inside consolidation range');
          row5 = [
            FP_LABELS[p.type],
            'Pole: '+fmtD(p.poleStartDate)+' → '+fmtD(p.poleEndDate)+' ('+(p.polePct>=0?'+':'')+(p.polePct*100).toFixed(1)+'%, '+p.poleDir+')',
            'Consolidation range',
            '$'+p.consolLow.toFixed(2)+' – $'+p.consolHigh.toFixed(2),
            statusLabel
          ];
        } else if (isTW) {
          const TW_LABELS: Record<string, string> = { SYMMETRICAL_TRIANGLE:'Symmetrical Triangle', ASCENDING_TRIANGLE:'Ascending Triangle', DESCENDING_TRIANGLE:'Descending Triangle', RISING_WEDGE:'Rising Wedge', FALLING_WEDGE:'Falling Wedge' };
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP — closed above resistance' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN — closed below support' : 'Forming — inside both lines');
          row5 = [
            TW_LABELS[p.type],
            'R: '+fmtD(p.resistanceP1.date)+' @$'+p.resistanceP1.price.toFixed(2)+' → '+fmtD(p.resistanceP2.date)+' @$'+p.resistanceP2.price.toFixed(2),
            'S: '+fmtD(p.supportP1.date)+' @$'+p.supportP1.price.toFixed(2)+' → '+fmtD(p.supportP2.date)+' @$'+p.supportP2.price.toFixed(2),
            'Res @last: $'+p.resistanceAtLast.toFixed(2)+' | Sup @last: $'+p.supportAtLast.toFixed(2),
            statusLabel
          ];
        } else if (p.type==='TRIPLE_TOP' || p.type==='TRIPLE_BOTTOM') {
          const label = p.type==='TRIPLE_TOP' ? 'Triple Top' : 'Triple Bottom';
          const pk = p.type==='TRIPLE_TOP' ? [p.peak1,p.peak2,p.peak3] : [p.trough1,p.trough2,p.trough3];
          const brokeWord = isBearish(p.type) ? 'below' : 'above';
          row5 = [
            label,
            fmtD(pk[0].date)+' @$'+pk[0].price.toFixed(2)+' | '+fmtD(pk[1].date)+' @$'+pk[1].price.toFixed(2),
            fmtD(pk[2].date)+' @$'+pk[2].price.toFixed(2),
            '$'+p.neckline.toFixed(2),
            p.confirmed ? ('CONFIRMED — broke '+brokeWord+' neckline') : 'Forming — neckline not yet broken'
          ];
        } else if (p.type==='HEAD_AND_SHOULDERS' || p.type==='INVERSE_HEAD_AND_SHOULDERS') {
          const label = p.type==='HEAD_AND_SHOULDERS' ? 'Head & Shoulders' : 'Inverse Head & Shoulders';
          const brokeWord = isBearish(p.type) ? 'below' : 'above';
          row5 = [
            label,
            'LS '+fmtD(p.leftShoulder.date)+' @$'+p.leftShoulder.price.toFixed(2)+' | Head '+fmtD(p.head.date)+' @$'+p.head.price.toFixed(2),
            'RS '+fmtD(p.rightShoulder.date)+' @$'+p.rightShoulder.price.toFixed(2),
            '$'+p.necklineAtLast.toFixed(2)+' (sloped, at last close)',
            p.confirmed ? ('CONFIRMED — broke '+brokeWord+' neckline') : 'Forming — neckline not yet broken'
          ];
        } else if (isHM) {
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP — continuation confirmed' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN — continuation confirmed' : 'Forming — inside congestion');
          row5 = [
            'Half-Mast Congestion',
            'Mast: '+fmtD(p.moveStartDate)+' → '+fmtD(p.moveEndDate)+' ('+(p.movePct>=0?'+':'')+(p.movePct*100).toFixed(1)+'%, '+p.moveDir+')',
            'Congestion range',
            '$'+p.consolLow.toFixed(2)+' – $'+p.consolHigh.toFixed(2),
            statusLabel
          ];
        } else if (isBT) {
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN' : 'Forming — rule of five in progress');
          row5 = [
            p.type==='BROADENING_TOP' ? 'Broadening Top' : 'Broadening Bottom',
            'First: '+fmtD(p.points[0].date)+' @$'+p.points[0].price.toFixed(2),
            'Last: '+fmtD(p.points[p.points.length-1].date)+' @$'+p.points[p.points.length-1].price.toFixed(2),
            'Res: $'+p.resistance.toFixed(2)+' / Sup: $'+p.support.toFixed(2),
            statusLabel
          ];
        } else if (isDM) {
          const statusLabel = p.status==='BROKE_UP' ? 'BROKE UP' : (p.status==='BROKE_DOWN' ? 'BROKE DOWN' : 'Forming — widen-then-narrow in progress');
          row5 = [
            p.type==='DIAMOND_TOP' ? 'Diamond Top' : 'Diamond Bottom',
            'First: '+fmtD(p.points[0].date)+' @$'+p.points[0].price.toFixed(2),
            'Last: '+fmtD(p.points[p.points.length-1].date)+' @$'+p.points[p.points.length-1].price.toFixed(2),
            'Res: $'+p.resistance.toFixed(2)+' / Sup: $'+p.support.toFixed(2),
            statusLabel
          ];
        } else if (isCX) {
          row5 = [
            p.type==='COMPLEX_TOP' ? 'Complex Top (double head)' : 'Complex Bottom (double head)',
            'S1 '+fmtD(p.shoulder1.date)+' @$'+p.shoulder1.price.toFixed(2)+' | H1 '+fmtD(p.head1.date)+' @$'+p.head1.price.toFixed(2),
            'H2 '+fmtD(p.head2.date)+' @$'+p.head2.price.toFixed(2)+' | S2 '+fmtD(p.shoulder2.date)+' @$'+p.shoulder2.price.toFixed(2),
            '$'+p.necklineAtLast.toFixed(2)+' (sloped, at last close)',
            p.confirmed ? ('CONFIRMED — broke '+(p.type==='COMPLEX_TOP'?'below':'above')+' neckline') : 'Forming — neckline not yet broken'
          ];
        } else {
          row5 = [
            p.type==='DOUBLE_TOP'?'Double Top':'Double Bottom',
            fmtD(p.date1)+' @ $'+p.level.toFixed(2),
            fmtD(p.date2),
            '$'+p.neckline.toFixed(2),
            p.confirmed ? (p.type==='DOUBLE_TOP'?'CONFIRMED — broke below neckline':'CONFIRMED — broke above neckline') : 'Forming — neckline not yet broken'
          ];
        }
        sh.getRange(row,1,1,5).setValues([row5]).setBackground(bg);row++;
        if (p.measuredTarget != null) {
          sh.getRange(row,1,1,5).merge().setValue('  ↳ Measured objective (Schabacker): $'+p.measuredTarget.toFixed(2)+' — rough, probable target, not a guarantee').setFontStyle('italic').setFontSize(9).setFontColor('#6d4c41');row++;
        }
        if (p.emSpacingCheck) {
          const es = p.emSpacingCheck;
          sh.getRange(row,1,1,5).merge().setValue('  ↳ Edwards & Magee spacing check: '+es.weeksApart+' weeks apart, '+es.magnitudePct+'% intervening move — '+(es.meetsBook ? 'MEETS the book\'s full-confidence bar (≥6 weeks, ≥15%)' : 'below the book\'s full-confidence bar (≥6 weeks, ≥15%) — still a real, detected pattern, just lower book-confidence')).setFontStyle('italic').setFontSize(9).setFontColor('#4527a0');row++;
        }
      });
      row++;
    }
  } catch(e) { /* non-fatal */ }

  // ══ INSTITUTIONAL HOLDINGS (13F) ══ (fetches are injected; the time-budget gate is deps.hasTimeBudget, F-E6)
  // Legacy: the budget check, the fetch and the status run here (fetch13F). Plain mode ran them before the header (F-E2).
  if (deps.legacyReportText && skip13F()) {
    setStatus(status, 'institutionalHoldings', 'skipped', SKIP_13F_DETAIL, rc('NOT_RUN'));
  } else if (deps.legacyReportText || (pre13F && pre13F.holdings)) {
  try {
    const holdings13F: any = deps.legacyReportText ? await fetch13F() : (pre13F as { holdings: any }).holdings;
    if (holdings13F) {
        hdr(sh,row,'🏛️  INSTITUTIONAL HOLDINGS (13F — Berkshire/BlackRock/Vanguard/State Street)','#1a237e',11,14);row++;
        sh.getRange(row,1,1,4).setValues([['Filer','Shares (latest)','Value','Qtr-over-Qtr Change']]).setFontWeight('bold').setBackground('#283593').setFontColor('#fff');row++;
        Object.entries(holdings13F).forEach(([name,q]: [string, any]) => {
          const latestPos = q.latest && q.latest.holdings;
          const priorPos = q.prior && q.prior.holdings;
          if (!latestPos && !priorPos) return;
          let sharesStr, valueStr, changeStr, bg='#e8eaf6';
          if (latestPos && priorPos) {
            const pct = (latestPos.shares-priorPos.shares)/priorPos.shares*100;
            sharesStr = latestPos.shares.toLocaleString('en-US')+' ('+q.latest.date+')';
            valueStr = '$'+(latestPos.value/1e6).toFixed(1)+'M';
            changeStr = (pct>=0?'+':'')+pct.toFixed(1)+'% vs '+q.prior.date;
            bg = pct>0?'#c8e6c9':pct<0?'#ffcdd2':'#e8eaf6';
          } else if (latestPos) {
            sharesStr = latestPos.shares.toLocaleString('en-US')+' ('+q.latest.date+')';
            valueStr = '$'+(latestPos.value/1e6).toFixed(1)+'M';
            changeStr = 'NEW position (no prior-quarter data)';
            bg = '#c8e6c9';
          } else {
            sharesStr = '0 (position closed)';
            valueStr = 'N/A';
            changeStr = 'Held '+priorPos.shares.toLocaleString('en-US')+' as of '+q.prior.date+', now CLOSED';
            bg = '#ffcdd2';
          }
          sh.getRange(row,1,1,4).setValues([[name, sharesStr, valueStr, changeStr]]).setBackground(bg);row++;
        });
        sh.getRange(row,1,1,4).merge().setValue('Real SEC EDGAR 13F-HR data — long equity positions only (no shorts/cash/bonds), filed up to 45 days after quarter-end. Vanguard is summed across its 6 real subsidiary filer CIKs (no single one covers its full position).').setFontStyle('italic').setFontSize(9).setFontColor('#5c6bc0').setWrap(true);row++;
        row++;
    }
  } catch(e) {
    fail13F(e);
  }
  }

  // ══ GANN SUMMARY ══
  try {
    hdr(sh,row,'📐  GANN ANGULAR SUMMARY (20% of long-term score)','#bf360c',11,14);row++;
    sh.getRange(row,1,1,6).setValues([['Pivot','Price Unit','Riding','1×1 Level','Gann Support','Gann Score']]).setFontWeight('bold').setBackground('#d84315').setFontColor('#fff');row++;
    sh.getRange(row,1,1,6).setValues([[gann.pivot.dateStr+' @ $'+gann.pivot.price.toFixed(2),'$'+gann.priceUnit.toFixed(2)+'/day',gann.lowerAngle+' → '+gann.upperAngle,gann.gannMaster?'$'+gann.gannMaster.toFixed(2):'N/A',gann.gannSupport?'$'+gann.gannSupport.toFixed(2):'N/A',gann.score+'/100 '+scoreBar(gann.score)]]).setBackground('#fbe9e7');row++;
    sh.getRange(row,1,1,5).setValues([['Gann Angle','Line Price Today','% vs Now','Support / Resistance','Note']]).setFontWeight('bold').setBackground('#e64a19').setFontColor('#fff');row++;
    (gann.ANGLES||[]).forEach((a: any,i: number)=>{
      const isLower=a.label===gann.lowerAngle,isUpper=a.label===gann.upperAngle,isMaster=a.label==='1×1';
      const f0=gann.fan[a.label];
      if(f0 && !isMaster && !isLower && !isUpper && Math.abs(f0.pct)>150) return;
      try{
        const f=f0;if(!f)return;
        const bg=isMaster?'#ffe082':isLower||isUpper?'#b3e5fc':i%2===0?'#fbe9e7':'#fff3e0';
        sh.getRange(row,1,1,5).setValues([[a.label,'$'+f.level.toFixed(2),(f.pct>=0?'+':'')+f.pct.toFixed(2)+'%',f.above?'Resistance':'Support',isMaster?'★ MASTER':isLower||isUpper?'◀ RIDING':'']]).setBackground(bg);
        sh.getRange(row,4).setFontColor(f.above?'#b71c1c':'#2e7d32').setFontWeight('bold');
      }catch(e){}
      row++;
    });
    row+=2;
  }catch(e){sh.getRange(row,1).setValue('⚠️ Gann section error').setFontColor('#e65100');row+=12;}

  // ══ SHORT INDICATORS ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📊  SHORT-TERM INDICATORS  (Days / Weeks)').setBackground('#1b5e20').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    const shortCatTotals: Record<string, number> = {};
    (scores.shortSignals||[]).forEach((s: any) => { const c=s.cat||'Other'; shortCatTotals[c]=(shortCatTotals[c]||0)+s.weight; });
    sh.getRange(row,1,1,7).setValues([['#','Indicator','Current Reading','Bull / Bear','Points','Weight','What it means']]).setFontWeight('bold').setBackground('#43a047').setFontColor('#fff');row++;
    (scores.shortSignals||[]).forEach((s: any,i: number)=>{
      try{const sig=s.signal>0.3?'🟢 BULLISH':s.signal<-0.3?'🔴 BEARISH':'🟡 NEUTRAL';
        const pts = Math.round((s.signal+1)/2*100);
        const catTotal = shortCatTotals[s.cat||'Other'] || 1;
        const weightShare = Math.round((s.weight/catTotal)*100) + '% of ' + (s.cat||'Other');
        sh.getRange(row,1,1,7).setValues([[i+1,s.name,s.display||'Missing data',sig,pts,weightShare,s.note||'']]).setBackground(i%2===0?'#e8f5e9':'#f1f8e9');
        sh.getRange(row,4).setFontColor(s.signal>0.3?'#1b5e20':s.signal<-0.3?'#b71c1c':'#f57f17').setFontWeight('bold');
      }catch(e){}row++;
    });
    sh.getRange(row,1,1,7).merge().setValue('SHORT-TERM: '+scores.shortScore+'/100  '+scoreBar(scores.shortScore)+'  '+scores.shortVerdict).setBackground(scores.shortScore>=60?'#a5d6a7':scores.shortScore>=45?'#fff9c4':'#ef9a9a').setFontWeight('bold').setFontSize(11);row+=3;
  }catch(e){sh.getRange(row,1).setValue('⚠️ Short indicators error').setFontColor('#e65100');row+=3;}

  // ══ LONG INDICATORS ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📈  LONG-TERM INDICATORS  (Months / 1-2 Years)').setBackground('#0d47a1').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    const longCatTotals: Record<string, number> = {};
    (scores.longSignals||[]).forEach((s: any) => { const c=s.cat||'Other'; longCatTotals[c]=(longCatTotals[c]||0)+s.weight; });
    sh.getRange(row,1,1,7).setValues([['#','Indicator','Current Reading','Bull / Bear','Points','Weight','What it means']]).setFontWeight('bold').setBackground('#1976d2').setFontColor('#fff');row++;
    (scores.longSignals||[]).forEach((s: any,i: number)=>{
      try{const sig=s.signal>0.3?'🟢 BULLISH':s.signal<-0.3?'🔴 BEARISH':'🟡 NEUTRAL';
        const bg=s.name.includes('Gann')?'#fff9c4':i%2===0?'#e3f2fd':'#e8eaf6';
        const pts = Math.round((s.signal+1)/2*100);
        const catTotal = longCatTotals[s.cat||'Other'] || 1;
        const weightShare = Math.round((s.weight/catTotal)*100) + '% of ' + (s.cat||'Other');
        // FL-17b (plain mode): the engine's rectangle-based Wyckoff row is labelled so it is not mistaken for the original-method model.
        const shownName=(!deps.legacyReportText&&s.name==='Wyckoff Schematic')?ENGINE_WYCKOFF_NAME:s.name;
        sh.getRange(row,1,1,7).setValues([[i+1,shownName,s.display||'Missing data',sig,pts,weightShare,s.note||'']]).setBackground(bg);
        sh.getRange(row,4).setFontColor(s.signal>0.3?'#1b5e20':s.signal<-0.3?'#b71c1c':'#f57f17').setFontWeight('bold');
      }catch(e){}row++;
    });
    sh.getRange(row,1,1,7).merge().setValue('LONG-TERM: '+scores.longScore+'/100  '+scoreBar(scores.longScore)+'  '+scores.longVerdict).setBackground(scores.longScore>=60?'#a5d6a7':scores.longScore>=45?'#fff9c4':'#ef9a9a').setFontWeight('bold').setFontSize(11);row+=3;
  }catch(e){sh.getRange(row,1).setValue('⚠️ Long indicators error').setFontColor('#e65100');row+=3;}

  // ══ FUNDAMENTALS (v6.1 detailed table) + v7 improved OWN score ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('💰  FUNDAMENTAL ANALYSIS  ['+fundSrcText()+']').setBackground('#e65100').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    if (fundResult && fundResult.score!=null) {
      sh.getRange(row,1,1,14).merge().setValue('🔮 v7 OWN score (PRIMARY): '+fundResult.score+'/100  '+scoreBar(fundResult.score)+'  '+fundResult.verdict+'   ·   Sector model: '+(fundResult.profile||'DEFAULT')).setBackground('#ede7f6').setFontColor('#4527a0').setFontWeight('bold');row++;
      if (fund && fund._crossRef) {
        sh.getRange(row,1,1,14).merge().setValue('⚠ This OWN score may be less reliable than usual — cross-source data disagreement: '+fund._crossRef.join('  •  ')).setBackground('#fff3e0').setFontColor('#e65100').setFontStyle('italic').setFontSize(9).setWrap(true);row++;
      }
      if (fundResult.drivers && fundResult.drivers.length) {
        sh.getRange(row,1,1,4).setValues([['Driver','Value','Points','Note']]).setFontWeight('bold').setBackground('#7e57c2').setFontColor('#fff');row++;
        fundResult.drivers.forEach((d: any,i: number)=>{
          try{
            sh.getRange(row,1,1,4).setValues([[d.label, d.value, d.points, d.note||'']]).setBackground(i%2===0?'#ede7f6':'#f3e5f5');
          }catch(e){}
          row++;
        });
        row++;
      }
      if (fund && (fund.debtToEquity != null || fund.currentRatio != null || fund.fcfPerShare != null)) {
        sh.getRange(row,1,1,3).setValues([['Balance Sheet Health','Value','Read']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
        if (fund.debtToEquity != null) {
          const d2eRead = fund.debtToEquity < 0.5 ? 'low leverage' : fund.debtToEquity < 1.5 ? 'moderate' : 'high leverage';
          sh.getRange(row,1,1,3).setValues([['Debt/Equity', fund.debtToEquity.toFixed(2)+'x', d2eRead]]).setBackground('#ede7f6');row++;
        }
        if (fund.currentRatio != null) {
          const curRead = fund.currentRatio >= 1.5 ? 'healthy liquidity' : fund.currentRatio >= 1.0 ? 'adequate' : 'tight — current liabilities exceed current assets';
          sh.getRange(row,1,1,3).setValues([['Current Ratio', fund.currentRatio.toFixed(2)+'x', curRead]]).setBackground('#f3e5f5');row++;
        }
        if (fund.quickRatio != null) {
          const quickRead = fund.quickRatio >= 1.0 ? 'can cover short-term liabilities without selling inventory' : 'would need to sell inventory or raise cash to cover short-term liabilities';
          sh.getRange(row,1,1,3).setValues([['Quick Ratio', fund.quickRatio.toFixed(2)+'x', quickRead]]).setBackground('#f3e5f5');row++;
        }
        if (fund.fcfPerShare != null) {
          const fcfRead = fund.fcfPerShare > 0 ? 'generating free cash flow' : 'burning cash';
          sh.getRange(row,1,1,3).setValues([['FCF/Share (TTM)', '$'+fund.fcfPerShare.toFixed(2), fcfRead]]).setBackground('#ede7f6');row++;
        }
        row++;
      }
      if (fund && fund._insiderTrading) {
        const it = fund._insiderTrading;
        sh.getRange(row,1,1,3).setValues([['Insider Trading (recent filings)','Value','Read']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
        const netRead = it.netBuying ? 'net insider BUYING' : it.netShares < 0 ? 'net insider SELLING' : 'neutral';
        sh.getRange(row,1,1,3).setValues([['Net shares (last '+it.transactionsAnalyzed+' filings)', (it.netShares>=0?'+':'')+it.netShares.toLocaleString('en-US'), netRead]]).setBackground(it.netBuying?'#c8e6c9':it.netShares<0?'#ffcdd2':'#eceff1');row++;
        sh.getRange(row,1,1,3).setValues([['Purchases vs sales (count)', it.purchaseCount+' buys / '+it.saleCount+' sells', '']]).setBackground('#f3e5f5');row++;
        row++;
      }
      if (fund && fund._treasuryRate10Y && fund._treasuryRate10Y.year10 != null) {
        const t10y = fund._treasuryRate10Y.year10;
        // forward P/E first, trailing only as fallback (legacy W-fix)
        const pe = fund.forwardPE != null ? fund.forwardPE : fund.trailingPE;
        sh.getRange(row,1,1,3).setValues([['Rate Environment','Value','Read']]).setFontWeight('bold').setBackground('#5e35b1').setFontColor('#fff');row++;
        const yieldRead = t10y > 4.5 ? 'elevated — pressures high-multiple valuations'
                        : t10y > 3.5 ? 'moderate' : 'low — supportive for equities';
        sh.getRange(row,1,1,3).setValues([['10-Year Treasury Yield', t10y.toFixed(2)+'%', yieldRead]]).setBackground('#ede7f6');
        if (fund._treasuryRate10Y.date) sh.getRange(row,3).setNote('As of ' + fund._treasuryRate10Y.date);
        row++;
        if (pe != null) {
          const rateSensRead = pe > 40 ? 'HIGH rate-sensitivity — this multiple is unusually exposed to rate moves' : pe > 25 ? 'moderate rate-sensitivity' : 'low rate-sensitivity';
          sh.getRange(row,1,1,3).setValues([['This stock\'s P/E ('+pe.toFixed(1)+'x) vs. rates', rateSensRead, '']]).setBackground(pe>40?'#fff3e0':'#f3e5f5');
          if (pe > 40) sh.getRange(row,2).setFontColor('#e65100').setFontWeight('bold');
          row++;
        }
        row++;
      }
    }
    if(fund&&scores.fundSignals&&scores.fundSignals.length>0){
      sh.getRange(row,1,1,14).merge().setValue('②  SECOND OPINION — legacy v6.1 engine (context only, NOT the decision)').setBackground('#78909c').setFontColor('#fff').setFontStyle('italic').setFontSize(10);row++;
      sh.getRange(row,1,1,5).setValues([['#','Metric','Current Reading','Bull / Bear','What it means']]).setFontWeight('bold').setBackground('#90a4ae').setFontColor('#fff');row++;
      scores.fundSignals.forEach((s: any,i: number)=>{
        try{const sig=s.signal>0.3?'🟢 BULLISH':s.signal<-0.3?'🔴 BEARISH':s.weight===0?'ℹ️ INFO':'🟡 NEUTRAL';
          sh.getRange(row,1,1,5).setValues([[i+1,s.name,s.display||'Missing data',sig,s.note||'']]).setBackground(i%2===0?'#eceff1':'#f5f5f5').setFontColor('#546e7a');
          sh.getRange(row,4).setFontColor('#78909c').setFontWeight('bold');
        }catch(e){}row++;
      });
      const fs=scores.fundScore;
      const fsLabel=(fs!=null)?(fs+'/100  '+scoreBar(fs)+'  '+scores.fundVerdict):('N/A  '+(scores.fundVerdict||'— insufficient fundamental data'));
      sh.getRange(row,1,1,5).merge().setValue('Second Opinion score (legacy, not authoritative): '+fsLabel).setBackground('#cfd8dc').setFontColor('#455a64').setFontWeight('bold').setFontSize(10);row++;
      if (fundResult && fundResult.score!=null && fs!=null && Math.abs(fundResult.score-fs)>=15) {
        const higher = fundResult.score>fs ? 'Primary' : 'Second Opinion';
        sh.getRange(row,1,1,5).merge().setValue('ℹ These differ by '+Math.abs(fundResult.score-fs)+' points — the '+higher+' score weighs sector-specific factors (growth trajectory, peer valuation) the legacy model does not; the Primary score above is the one used in the decision.').setBackground('#fff9c4').setFontColor('#8d6e00').setFontStyle('italic').setFontSize(9).setWrap(true);row++;
      }
      if(fund&&fund._sources&&fund._sources.length){
        sh.getRange(row,1,1,5).merge().setValue('🔗 Sources: '+fund._sources.join(' + ')+(fund._crossRef?'   ⚠ Cross-source differences noted above':'   ✓ sources agree')).setBackground('#eceff1').setFontStyle('italic').setFontColor('#455a64').setFontSize(9);row++;
      }
      row+=2;
    } else {
      sh.getRange(row,1,1,5).merge().setValue('⚠️ No fundamental signal data — technical & Gann analysis only. See 🔬 Log for the API result.').setBackground('#fff3e0').setFontColor('#e65100');row++;
      sh.getRange(row,1,1,5).merge().setValue('Second Opinion score: N/A — technical signals only').setBackground('#cfd8dc').setFontColor('#455a64').setFontWeight('bold').setFontSize(10);row+=3;
    }
  }catch(e){sh.getRange(row,1).setValue(errCell('Fund', e, 60)).setFontColor('#e65100');row+=3;}

  // ══ OPTIONS INTELLIGENCE (rich v7) ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('⚡  OPTIONS INTELLIGENCE — Smart-Money Positioning  (adjusts BUY-TIMING & Final Conviction, never OWN)').setBackground('#880e4f').setFontColor('#fff').setFontSize(11).setFontWeight('bold');row++;
    const fx = (v: any): string => fmtExpiry(v, tz, deps.sheetsParsedLabels);
    if(opts&&opts.available){
      const dir=opts.dirSig>=0.34?'🟢 Bullish':opts.dirSig<=-0.34?'🔴 Bearish':'🟡 Mixed / neutral';
      const verdict=opts.confirm==='confirm'?'✅ CONFIRM — options agree with the chart  (Final Conviction +8)':opts.confirm==='conflict'?'⚠️ CONFLICT — options lean opposite the chart  (Final Conviction −10)':'➖ NEUTRAL — no strong directional edge';
      const rows5: any[][]=[
        ['Verdict',verdict,'','',''],
        deps.legacyReportText
          ? ['Direction',dir+'   ·   Put/Call OI '+(opts.putCallOI!=null?opts.putCallOI.toFixed(2):'N/A')+'   ·   net $ '+(opts.netBiasPct!=null?((opts.netBiasPct>0?'+':'')+opts.netBiasPct+'% into '+(opts.netBiasPct>=0?'calls':'puts')):'N/A'),'','','Put/Call <0.7 = upside positioning; >1.1 = downside/hedging']
          : ['Direction',dir+'   ·   Put/call OI (whole chain) '+putCallText(opts.putCallOI)+'   ·   net $ '+(opts.netBiasPct!=null?((opts.netBiasPct>0?'+':'')+opts.netBiasPct+'% into '+(opts.netBiasPct>=0?'calls':'puts')):'N/A'),'','','Put/call bands: '+PUT_CALL_BANDS_TEXT],
        ['Long-term (LEAPS 1–2yr)',(opts.leapsLean>0.15?'🟢 Bullish accumulation':opts.leapsLean<-0.15?'🔴 Bearish / hedged':'🟡 Neutral'),'','','Heavy long-dated call buying = real long-term conviction (often institutions)'],
        [deps.legacyReportText?'Volatility (IV %ile)':'Volatility ('+IV_CHAIN_PCT_LABEL+')',(opts.ivRank!=null?opts.ivRank+'th percentile':'N/A')+(opts.ivRank!=null&&opts.ivRank>=80?'  — elevated (event/fear priced in)':opts.ivRank!=null&&opts.ivRank<=20?'  — low / calm':''),'','',deps.legacyReportText?'High IV = options pricing a big move; trims entry confidence':'Near-term IV ranked among today\'s contract IVs (not a history-based IV rank); 80+ = options pricing a big move, trims entry confidence'],
        ['Biggest bets','calls '+(opts.topCall?'$'+opts.topCall.strike+' ('+fx(opts.topCall.expiry)+') conv '+opts.topCall.conv:'N/A')+'   ·   puts '+(opts.topPut?'$'+opts.topPut.strike+' ('+fx(opts.topPut.expiry)+') conv '+opts.topPut.conv:'N/A'),'','','Price levels where the biggest option money sits — informal magnets'],
        ['LEAPS bets','calls '+(opts.leapCall?'$'+opts.leapCall.strike+' ('+fx(opts.leapCall.expiry)+')':'N/A')+'   ·   puts '+(opts.leapPut?'$'+opts.leapPut.strike+' ('+fx(opts.leapPut.expiry)+')':'N/A'),'','','Longest-dated conviction bets']
      ];
      if(opts.horizon) rows5.push(['Near your entry (~'+opts.horizon.days+'d)','call '+(opts.horizon.topCall?'$'+opts.horizon.topCall.strike+' ('+fx(opts.horizon.topCall.expiry)+')':'N/A')+'   ·   put '+(opts.horizon.topPut?'$'+opts.horizon.topPut.strike+' ('+fx(opts.horizon.topPut.expiry)+')':'N/A'),'','','Positioning at the expiries closest to the planned entry timing']);
      sh.getRange(row,1,1,5).setValues([['Signal','Reading','','','What it means']]).setFontWeight('bold').setBackground('#ad1457').setFontColor('#fff');row++;
      rows5.forEach((rr,i)=>{ try{ sh.getRange(row,1,1,5).setValues([rr]).setBackground(i%2===0?'#fce4ec':'#f3e5f5'); sh.getRange(row,1).setFontWeight('bold'); sh.getRange(row,5).setFontStyle('italic').setFontColor('#6a1b9a').setFontSize(9);}catch(e){} row++; });
      row+=2;
    } else {
      sh.getRange(row,1,1,5).merge().setValue('No options snapshot for '+ticker+' — run Options Analysis on this ticker first, then re-run this report to fold in smart-money positioning.').setBackground('#fce4ec').setFontColor('#880e4f').setFontStyle('italic');row+=3;
    }
  }catch(e){sh.getRange(row,1).setValue(errCell('Options', e, 60)).setFontColor('#e65100');row+=3;}

  // ══ KEY LEVELS ══
  try {
    hdr(sh,row,'📐  KEY PRICE LEVELS & MOVING AVERAGES','#37474f',11,14);row++;
    sh.getRange(row,1,1,8).setValues([['Support/Resistance','Level Price','% vs Now','Moving Average','MA Price','% vs Now','Fib / 52wk','Fib Price']]).setFontWeight('bold').setBackground('#546e7a').setFontColor('#fff');row++;
    const levelRows: any[][] = [['SMA20',ind.sma20,'EMA9',ind.ema9,'23.6%',ind.fib236],['SMA50',ind.sma50,'EMA21',ind.ema21,'38.2%',ind.fib382],['SMA150',ind.sma150,'',null,'50.0%',ind.fib500],['SMA200',ind.sma200,'',null,'61.8%',ind.fib618],['Pivot',ind.pivot,'R1',ind.pp_R1,'78.6%',ind.fib786],['S1',ind.pp_S1,'R2',ind.pp_R2,'52wk H',ind.high52],['S2',ind.pp_S2,'',null,'52wk L',ind.low52]];
    levelRows.forEach(([l1,v1,l2,v2,l3,v3],i)=>{
      try{const p1=v1?((v1/cp-1>=0?'+':'')+((v1/cp-1)*100).toFixed(2))+'%':'—',p2=v2?((v2/cp-1>=0?'+':'')+((v2/cp-1)*100).toFixed(2))+'%':'—';
        sh.getRange(row,1,1,8).setValues([[l1,v1?'$'+v1.toFixed(2):'—',p1,l2,v2?'$'+v2.toFixed(2):'—',p2,l3,v3?'$'+v3.toFixed(2):'—']]).setBackground(i%2===0?'#eceff1':'#f5f5f5');
        if(v1)sh.getRange(row,3).setFontColor((v1/cp-1)>=0?'#2e7d32':'#c62828');
        if(v2)sh.getRange(row,6).setFontColor((v2/cp-1)>=0?'#2e7d32':'#c62828');
      }catch(e){}row++;
    });
    row+=2;
  }catch(e){row+=8;}

  // ══ PLAIN-ENGLISH ANALYSIS SUMMARY ══
  try {
    sh.getRange(row,1,1,14).merge().setValue('📝  ANALYSIS SUMMARY — Plain English').setBackground('#263238').setFontColor('#fff').setFontSize(12).setFontWeight('bold');row+=2;
    const paras=buildNarrative(ticker, chart, ind, gann, confluence, scores, fund, opts, techPlan, decision, fundResult, { plainLabels: !deps.legacyReportText });
    paras.forEach(p=>{
      try {
        sh.getRange(row,1,1,14).merge().setValue(p.heading).setFontWeight('bold').setFontSize(11).setFontColor('#0d47a1');row++;
        sh.getRange(row,1,1,14).merge().setValue(p.body).setWrap(true).setVerticalAlignment('top').setFontSize(10).setBackground('#fafafa');
        const lines=Math.max(1,Math.ceil(p.body.length/110));
        sh.setRowHeight(row, Math.min(220, 18*lines+6));
        row+=2;
      } catch(e){ row++; }
    });
  } catch(e){ sh.getRange(row,1).setValue(errCell('Summary', e, 80)).setFontColor('#e65100'); row+=3; }

  sh.setColumnWidth(1,190);sh.setColumnWidth(2,120);sh.setColumnWidth(3,150);
  sh.setColumnWidth(4,170);sh.setColumnWidth(5,300);sh.setColumnWidths(6,9,110);
  sh.setFrozenRows(1);
}
