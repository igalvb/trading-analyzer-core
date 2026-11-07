/**
 * FL-8q (Phase 4, backlog row 9): the ONE combined, pedagogical Exit report sheet, per
 * docs/CHARACTERIZATION_PLAN_V13_exit_pipeline_and_report.md sections 4-5. New code (no legacy twin); the legacy
 * writer buildExitStrategyReportV7 (fullStockAnalysisV10_9.gs:10242-10500, the old '📤 Exit Strategy' tab) was
 * ported and then removed (owner 2026-11-04). Legacy rules restated in the "what triggers what" lines: the
 * formatters in reports/exit/exitReport.ts. The legacy writer's advisory block is carried into PORTFOLIO-WIDE
 * CHECKS; skip disclosures into DATA HEALTH AND ROWS READ.
 *
 * buildExitSheet   : nightly. Rebuilds the whole tab, AI section reset to AI_PLACEHOLDER. One setValues, formatting
 *                    recorded for one batchUpdate (ReportWorkbook.flush -> one applyTab).
 * writeAiSummaries : manual AI run. Never creates a tab. Finds the single AI_ANCHOR row and replaces everything below
 *                    it (the AI section is the LAST section, so nothing else shifts). Idempotent.
 */
import type { ReportSheet, ReportWorkbook } from '../../sheets/reportSheet.ts';
import { getOrCreate } from '../options/tabs.ts';
import { PHASE_LABELS, summaryBackground, urgencyRank } from '../exit/exitReport.ts';
import { EFFECTS, REPORT_TIME_ZONE, dataQualityLines, labelledReason, reasonLine, reasonSentence, type ReasonCode } from '../messages/catalog.ts';
import { computeExitTax, EXIT_TAX_RATE, OPTION_CONTRACT_MULTIPLIER, type ExitTax } from '../../portfolio/exitTax.ts';

type TaxView = ExitTax;
/** The one tax rule (user, 2026-10-25): the profile's tax.rate of the gain, 0 on a loss. */
function taxOf(h: ExitHoldingInput): ExitTax {
  const p = h.position;
  return computeExitTax({ quantity: p.quantity, unitCost: p.avgCost, unitPrice: p.currentPrice, multiplier: h.kind === 'OPTION' ? OPTION_CONTRACT_MULTIPLIER : 1 });
}

/** 'YYYY-MM-DD' or 'M/D/YYYY', a real calendar day; anything else is unusable (the stop then uses a generic lookback). */
export function hasEntryDate(s: string | null | undefined): boolean {
  if (s == null) return false;
  const t = String(s).trim();
  let y: number, m: number, d: number;
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (mt) { y = Number(mt[1]); m = Number(mt[2]); d = Number(mt[3]); }
  else {
    mt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
    if (!mt) return false;
    m = Number(mt[1]); d = Number(mt[2]); y = Number(mt[3]);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
import {
  AI_ANCHOR, AI_PLACEHOLDER, BITCOIN_ETF_TICKERS, PORTFOLIO_VIEW_TITLE, EXIT_SHEET_TAB, EXIT_SHEET_TAB_COLOR, MODEL_NAMES, MODEL_ORDER, NCOLS, T, WIDTHS,
  cleanNarrative, estHeight, fmtNum, fmtPct, fmtPlainPct, fmtQty, fmtSignedUsd, fmtUsd, stamp, stanceLabel,
} from './text.ts';
import { readExtraModels, extraModelRows, EXTRA_MODELS_DISCLAIMER, EXTRA_MODELS_HEADER } from '../../analysis/extraModels.ts';
import type { AiSummariesInput, ExitHoldingInput, ExitReportInput, ModelId, ModelRead, SellPlanView } from './types.ts';

export { EXIT_SHEET_TAB, EXIT_SHEET_TAB_COLOR, AI_ANCHOR, AI_PLACEHOLDER };

type Anchors = Record<string, number>;
interface Row {
  cells: unknown[];
  mergeFrom?: number;
  bg?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  size?: number;
  height?: number;
  labelCol?: boolean;
  cellBg?: Record<number, string>;
  anchor?: string;
  late?: { col: number; fn: (a: Anchors) => string };
  /** Row 35 (#7): a clickable jump link on cell `col` to the row of `anchor`. */
  link?: { col: number; anchor: string; row?: number };
}

const band = (text: string, bg: string, size = 12): Row => ({ cells: [text], mergeFrom: 1, bg, color: '#ffffff', bold: true, size, height: Math.max(28, estHeight(text, 1)) });
const sub = (text: string): Row => ({ cells: [text], mergeFrom: 1, bg: '#e3f2fd', bold: true, height: 24 });
const line = (text: string, o: Partial<Row> = {}): Row => ({ cells: [text], mergeFrom: 1, height: estHeight(text, 1), ...o });
const kv = (label: string, value: string, o: Partial<Row> = {}): Row => ({ cells: [label, value], mergeFrom: 2, labelCol: true, height: estHeight(value, 2), ...o });
const blank = (): Row => ({ cells: [] });
const grid6 = (cells: unknown[], o: Partial<Row> = {}): Row => ({ cells, height: 21, ...o });
const sentence = (code: ReasonCode): string => reasonLine(code);

interface Ctx {
  readonly now: Date;
  readonly tz: string;
  readonly pct: number;
  readonly sharedMembers: string;
  readonly hasShared: boolean;
  readonly stockAnchorByTicker: Map<string, string>;
}

export interface ExitSheetDeps { readonly log?: (message: string) => void; readonly timeZone?: string }
export interface ExitSheetResult {
  readonly written: boolean;
  readonly tab: string;
  readonly rowCount: number;
  /** Anchor key -> 1-based row: 'AI', 'H0'.., 'T' (table of contents), 'S' (summary). */
  readonly anchors: Readonly<Record<string, number>>;
  /** Tickers/labels of the holdings in report order. */
  readonly order: readonly string[];
  readonly degraded: ReadonlyArray<{ readonly name: string; readonly reason: ReasonCode }>;
}

function holdingLabel(h: ExitHoldingInput): string {
  if (h.kind === 'OPTION' && h.option) return h.ticker + ' ' + h.option.right.toLowerCase() + ' $' + h.option.strike + ' ' + h.option.expiry;
  return h.ticker;
}

interface Verdict { readonly text: string; readonly bg: string; readonly rank: number; readonly failed: boolean; readonly action: string }
function verdictOf(h: ExitHoldingInput): Verdict {
  const s = h.signals ? h.signals.summary : '';
  if (h.failed || !s || s.indexOf('ERROR') === 0) {
    const code: ReasonCode = h.failed ?? 'SECTION_UNAVAILABLE';
    return { text: 'No verdict. ' + sentence(code), bg: '#eceff1', rank: 4, failed: true, action: 'NO VERDICT' };
  }
  const rank = urgencyRank(s);
  const action = rank === 0 ? 'EXIT' : rank === 1 ? 'REVIEW' : rank === 2 ? (s.indexOf('CONSIDER') === 0 ? 'TRIM' : 'TARGET HIT') : rank === 3 ? 'HOLD' : 'NO VERDICT';
  return { text: s, bg: verdictBackground(s), rank, failed: false, action };
}

/** The one-word action the sheet shows for a holding (EXIT, REVIEW, TRIM, TARGET HIT, HOLD, NO VERDICT). */
export function exitActionOf(h: ExitHoldingInput): string { return verdictOf(h).action; }

/** The order the sheet's action rollup uses. */
export const EXIT_ACTION_ORDER: readonly string[] = ['EXIT', 'REVIEW', 'TRIM', 'TARGET HIT', 'HOLD', 'NO VERDICT'];

/** Audit #8: red = stop, YELLOW = a target is hit ("CONSIDER ..." or "T1/T2 reached ..."), green = hold. The legacy colour function (kept for parity) only knew "CONSIDER". */
export function verdictBackground(s: string): string {
  return s.indexOf('T1') === 0 || s.indexOf('T2') === 0 ? '#fff9c4' : summaryBackground(s);
}

const orReason = (v: string | null, code: ReasonCode = 'FIELD_MISSING'): string => v ?? sentence(code);
const awayText = (d: number | null | undefined): string => (d == null || d <= 0 ? '' : ' (' + d.toFixed(1) + '% above the current price)');

function levelsLine(h: ExitHoldingInput): string {
  const l = h.levels;
  if (!l) return sentence('FIELD_MISSING');
  const parts: string[] = [];
  parts.push(l.stopLevel != null ? 'Stop ' + fmtUsd(l.stopLevel) + (l.stopBreached ? ' (breached)' : '') : 'No stop level');
  if (l.t1 != null) parts.push('T1 ' + fmtUsd(l.t1) + (l.hitT1 ? ' reached' : awayText(l.distanceToT1Pct)));
  else if (l.weeklyLines) parts.push('T1 ' + T.noValidTarget);
  if (l.t2 != null) parts.push('T2 ' + fmtUsd(l.t2) + (l.hitT2 ? ' reached' : awayText(l.distanceToT2Pct)));
  else if (l.weeklyLines) parts.push('T2 ' + T.noValidTarget);
  return parts.join(' · ');
}

function modelRows(h: ExitHoldingInput, ctx: Ctx): Row[] {
  const rows: Row[] = [sub('④ THE 5 MODELS — independent reads'), grid6([...T.modelsHeader], { bold: true, bg: '#eceff1' })];
  if (h.kind === 'OPTION' && h.models.length === 0) {
    const stockKey = ctx.stockAnchorByTicker.get(h.ticker);
    if (stockKey) rows.push({ cells: [T.optionModelsSee], mergeFrom: 1, height: 21, late: { col: 1, fn: (a) => T.optionModelsSee + (a[stockKey] ?? 0) + '.' }, link: { col: 1, anchor: stockKey } });
    else rows.push(line(labelledReason('Model reads', 'NOT_RUN')));
    return rows;
  }
  for (const id of MODEL_ORDER) {
    const r: ModelRead | undefined = h.models.find((m) => m.model === id);
    if (!r) { rows.push(grid6([MODEL_NAMES[id], stanceLabel('UNAVAILABLE'), '', sentence('NOT_RUN')])); continue; }
    const note = r.stance === 'UNAVAILABLE' ? sentence(r.reasonCode ?? 'SECTION_UNAVAILABLE') : '';
    rows.push(grid6([MODEL_NAMES[id], stanceLabel(r.stance), r.stance === 'UNAVAILABLE' ? '' : scoreText(r), note]));
  }
  const c = h.comparison;
  if (!c) rows.push(line(labelledReason('Model comparison', 'NOT_RUN'), { italic: true }));
  else {
    const d = c.dissenters.map((m: ModelId) => MODEL_NAMES[m]).join(', ');
    rows.push(line(T.modelsAgreement(c.agreeCount, c.totalCount, c.majority ? stanceLabel(c.majority) : null, d), { bold: true }));
  }
  rows.push(...extraModelSheetRows(h.extraModels));
  return rows;
}

/** Row 35 (#37, G-6): the engine's conviction, a book model's signal count, else the given score. Display only. */
function scoreText(r: ModelRead): string {
  if (r.model === 'ENGINE' && r.conviction != null) return T.engineScore(r.conviction);
  if (r.signals) return T.modelSignals(r.signals.pro, r.signals.con);
  return fmtNum(r.score) ?? '';
}

/** FL-17b: the newer models under the 5 (display only; not in the agreement count above). Nothing when the holding carries none. */
function extraModelSheetRows(x: unknown): Row[] {
  if (x === undefined) return [];
  const r = readExtraModels(x);
  if (!r) return [line(labelledReason('More model reads', 'NOT_RUN'), { italic: true })];
  return [
    line(EXTRA_MODELS_HEADER + ' ' + EXTRA_MODELS_DISCLAIMER, { italic: true, bg: '#f5f5f5' }),
    ...extraModelRows(r).map(([label, text]) => kv(label, text)),
  ];
}

function positionRows(h: ExitHoldingInput, tax: TaxView, ctx: Ctx): Row[] {
  const p = h.position;
  const isOpt = h.kind === 'OPTION';
  const rows: Row[] = [sub('② POSITION')];
  rows.push(kv(isOpt ? 'Contracts' : 'Shares', orReason(fmtQty(p.quantity))));
  rows.push(kv(isOpt ? 'Premium paid (per share)' : 'Average cost', orReason(fmtUsd(p.avgCost))));
  rows.push(kv(isOpt ? 'Current option price' : 'Current price', orReason(fmtUsd(p.currentPrice))));
  if (p.entryDateAssumed && hasEntryDate(p.entryDate)) {
    rows.push(kv('Entry date', T.assumedEntryDate, { bg: '#fff3e0', bold: true }));
  } else if (!hasEntryDate(p.entryDate)) {
    rows.push(kv('Entry date', (p.entryDate ? T.entryDateUnreadable : T.noEntryDate) + ' ' + EFFECTS.LOWER_CONFIDENCE, { bg: '#fff3e0', bold: true }));
  } else {
    rows.push(kv('Entry date', String(p.entryDate)));
  }
  const gain = fmtSignedUsd(tax.unrealizedUsd);
  rows.push(kv('Gain or loss now', gain ? gain + ' (' + orReason(fmtPct(tax.unrealizedPct)) + ')' : sentence('FIELD_MISSING')));
  if (tax.taxOwedUsd == null || tax.afterTaxGainUsd == null) {
    rows.push(kv('After tax', sentence('FIELD_MISSING')));
  } else if (tax.taxOwedUsd > 0) {
    rows.push(kv('After tax', 'About ' + orReason(fmtSignedUsd(tax.afterTaxGainUsd)) + ' gain after tax if sold now, assuming ' + ctx.pct + '% tax on the gain (' + orReason(fmtUsd(tax.taxOwedUsd)) + '). Working assumption, not tax advice.'));
  } else {
    rows.push(kv('After tax', 'No tax is assumed on a loss, so the result after tax is the same: ' + orReason(fmtSignedUsd(tax.afterTaxGainUsd)) + '. Working assumption, not tax advice.'));
  }
  return rows;
}

function moneyness(o: { right: 'CALL' | 'PUT'; strike: number }, under: number | null): string {
  if (under == null || !Number.isFinite(under) || !(o.strike > 0)) return sentence('FIELD_MISSING');
  const dist = (under - o.strike) / o.strike * 100;
  const abs = Math.abs(dist).toFixed(1) + '%';
  if (Math.abs(dist) < 1) return 'Near the strike (underlying ' + fmtUsd(under) + ').';
  const itm = o.right === 'CALL' ? dist > 0 : dist < 0;
  return (itm ? 'In the money by ' : 'Out of the money by ') + abs + ' (underlying ' + fmtUsd(under) + ').';
}

function levelRows(h: ExitHoldingInput, ctx: Ctx): Row[] {
  const rows: Row[] = [sub('③ EXIT LEVELS')];
  const l = h.levels;
  if (h.kind === 'OPTION') {
    const o = h.option;
    if (!o) rows.push(line(labelledReason('Contract details', 'FIELD_MISSING')));
    else {
      rows.push(kv('Contract', o.right + ' $' + o.strike + ' expiring ' + o.expiry));
      rows.push(kv('Days to expiry', o.daysToExpiry != null ? String(o.daysToExpiry) : sentence('FIELD_MISSING'), o.expiryWarning ? { bg: '#ffcdd2', bold: true } : {}));
      if (o.expiryWarning) rows.push(kv('Expiry warning', 'The contract is inside the ' + orReason(fmtQty(o.expiryThreshold)) + '-day exit window.', { bg: '#ffcdd2' }));
      rows.push(kv('Moneyness', moneyness(o, o.underlyingPrice)));
      rows.push(kv('Time decay', T.optionDecay));
    }
  }
  if (!l) rows.push(line(labelledReason('Exit levels', 'FIELD_MISSING')));
  else {
    const basis = l.stopBasis === 'WEEKLY' ? T.stopWeekly : l.stopBasis === 'SINCE_ENTRY' ? T.stopSinceEntry : l.stopBasis === 'SINCE_ASSUMED_ENTRY' ? T.stopSinceAssumedEntry : l.stopBasis === 'GENERIC' ? T.stopGeneric : '';
    const under = h.kind === 'OPTION' ? ' (on the underlying)' : '';
    rows.push(kv('Trailing stop' + under, l.stopLevel != null ? fmtUsd(l.stopLevel) + (basis ? ', ' + basis : '') : sentence('FIELD_MISSING')));
    rows.push(kv('Stop check', l.stopBreached ? 'Breached: the price is below the stop.' : 'Holding: the price is above the stop.', l.stopBreached ? { bg: '#ffcdd2' } : {}));
    const noTarget = l.weeklyLines ? T.noValidTarget : sentence('FIELD_MISSING');
    rows.push(kv('Target 1', l.t1 != null ? fmtUsd(l.t1) + (l.hitT1 ? ' — reached' : ' — not reached' + awayText(l.distanceToT1Pct)) : noTarget, l.hitT1 ? { bg: '#fff9c4' } : {}));
    rows.push(kv('Target 2', l.t2 != null ? fmtUsd(l.t2) + (l.hitT2 ? ' — reached' : ' — not reached' + awayText(l.distanceToT2Pct)) : noTarget, l.hitT2 ? { bg: '#fff9c4' } : {}));
    rows.push(kv('Thesis', l.thesisInvalidated ? 'Broken: the original reason to hold no longer stands.' : 'Intact.', l.thesisInvalidated ? { bg: '#ffcdd2' } : {}));
    if (l.weeklyLines) for (const w of l.weeklyLines) rows.push(kv('Exit rule check', w));
    if (l.weeklyVotes && l.weeklyVotes.length) {
      rows.push(sub('MODEL VOTE — every model\'s read on this holding'));
      for (const v of l.weeklyVotes) rows.push(kv(v.model, (v.read === 'NA' ? 'no read' : v.read) + ' — ' + v.why, v.read === 'SELL' ? { bg: '#ffcdd2' } : {}));
    }
    if (l.highestHighSinceEntry != null) rows.push(kv(l.distanceToT1Pct !== undefined ? 'Highest price since you bought (information only)' : 'Highest price since entry', orReason(fmtUsd(l.highestHighSinceEntry))));
  }
  rows.push(sub(T.triggersHeader));
  const trig = [...T.triggerStock];
  if (h.kind === 'OPTION') trig.push(...T.triggerOptionExtra(h.option ? h.option.expiryThreshold : null));
  for (const t of trig) rows.push(line('• ' + t));
  return rows;
}

/** F-X2: how many shares or contracts to sell at each target, and the remembered-targets line. */
function sellRows(p: SellPlanView): Row[] {
  const rows: Row[] = [sub('HOW MANY TO SELL')];
  p.lines.forEach((t, k) => rows.push(line(t, k === 0 ? { bold: true } : {})));
  if (p.memoryLine) rows.push(line(p.memoryLine, { italic: true, color: '#555555' }));
  return rows;
}

function fundRows(h: ExitHoldingInput): Row[] {
  const rows: Row[] = [sub('⑤ FUNDAMENTALS AND POSITIONING')];
  const f = h.fundamentals;
  if (!f) rows.push(kv('Fundamentals', sentence('NOT_RUN')));
  else if (f.unavailable) rows.push(kv('Fundamentals', sentence(f.unavailable)));
  else rows.push(kv('Fundamentals', (f.ownScore != null ? 'Score ' + fmtNum(f.ownScore) : sentence('FIELD_MISSING')) + (f.band ? ' (' + f.band + ')' : '')));
  const p = h.positioning;
  if (!p) rows.push(kv('Positioning', sentence('NOT_RUN')));
  else if (p.unavailable) rows.push(kv('Positioning', sentence(p.unavailable)));
  else {
    rows.push(kv('Institutional holders', p.institutionalHolders != null ? String(p.institutionalHolders) : sentence('FIELD_MISSING')));
    rows.push(kv('Dark-pool share', orReason(fmtPlainPct(p.darkPoolPct))));
    rows.push(kv('Short interest', orReason(fmtPlainPct(p.shortInterestPct))));
  }
  return rows;
}

function holdingSection(h: ExitHoldingInput, i: number, tax: TaxView, ctx: Ctx): Row[] {
  const v = verdictOf(h);
  const rows: Row[] = [{ cells: ['═══ ' + holdingLabel(h) + ' ═══'], mergeFrom: 1, bg: '#1a73e8', color: '#ffffff', bold: true, size: 13, height: 28, anchor: 'H' + i }];
  if (h.correlatedGroup && ctx.hasShared) rows.push(line(T.btcDisclosure(ctx.sharedMembers), { italic: true, bg: '#fff8e1' }));
  rows.push(kv('① VERDICT', v.text, { bg: v.bg, bold: true }));
  if (v.failed) {
    rows.push(...positionRows(h, tax, ctx));
    rows.push(line(labelledReason('Exit levels, models, fundamentals', 'SECTION_UNAVAILABLE'), { italic: true }));
  } else {
    rows.push(...positionRows(h, tax, ctx));
    rows.push(...levelRows(h, ctx));
    if (h.sellPlan && h.sellPlan.lines.length) rows.push(...sellRows(h.sellPlan));
    rows.push(...modelRows(h, ctx));
    rows.push(...fundRows(h));
  }
  rows.push(sub('⑥ DATA HEALTH'));
  dataQualityLines(h.dataHealth).forEach((t, k) => rows.push(line(t, k === 0 ? { bold: true } : {})));
  rows.push({ cells: [T.aiPointerHolding(0)], mergeFrom: 1, height: 21, italic: true, late: { col: 1, fn: (a) => T.aiPointerHolding(a['AI'] ?? 0) }, link: { col: 1, anchor: 'AI' } });
  return rows;
}

function degradedSection(name: string, i: number | null): Row[] {
  const head: Row = { cells: ['═══ ' + name + ' ═══'], mergeFrom: 1, bg: '#1a73e8', color: '#ffffff', bold: true, size: 13, height: 28 };
  if (i != null) head.anchor = 'H' + i;
  return [head, kv('① VERDICT', 'No verdict. ' + sentence('SECTION_UNAVAILABLE'), { bg: '#eceff1', bold: true })];
}

function render(sh: ReportSheet, rows: Row[], startRow: number): void {
  const matrix = rows.map((r) => { const c = r.cells.slice(0, NCOLS); while (c.length < NCOLS) c.push(''); return c; });
  sh.getRange(startRow, 1, rows.length, NCOLS).setValues(matrix);
  rows.forEach((r, i) => {
    const row = startRow + i;
    if (!r.cells.length) return;
    const full = sh.getRange(row, 1, 1, NCOLS);
    if (r.mergeFrom) sh.getRange(row, r.mergeFrom, 1, NCOLS - r.mergeFrom + 1).merge();
    if (r.bg) full.setBackground(r.bg);
    if (r.color) full.setFontColor(r.color);
    if (r.bold) full.setFontWeight('bold');
    if (r.italic) full.setFontStyle('italic');
    if (r.size) full.setFontSize(r.size);
    if (r.labelCol) {
      const lc = sh.getRange(row, 1, 1, 1).setFontWeight('bold');
      if (!r.bg) lc.setBackground('#eceff1');
    }
    if (r.cellBg) for (const [c, bg] of Object.entries(r.cellBg)) sh.getRange(row, Number(c), 1, 1).setBackground(bg);
    if (r.link && r.link.row) sh.getRange(row, r.link.col, 1, 1).setLinkToRow(r.link.row);
    const wrapFrom = r.mergeFrom ?? 1;
    if (r.mergeFrom) sh.getRange(row, wrapFrom, 1, NCOLS - wrapFrom + 1).setWrap(true).setVerticalAlignment('top');
    if (r.height) sh.setRowHeight(row, r.height);
  });
}

function summaryRows(sorted: ReadonlyArray<{ h: ExitHoldingInput; v: Verdict; tax: TaxView | null }>, input: ExitReportInput, pct: number): Row[] {
  const rows: Row[] = [band(T.summaryHeader, '#37474f', 13)];
  rows[0]!.anchor = 'S';
  const nStock = input.holdings.filter((h) => h.kind === 'STOCK').length;
  const nOpt = input.holdings.length - nStock;
  rows.push(kv('Holdings', input.holdings.length + ' (' + nStock + ' stock/ETF, ' + nOpt + ' option)'));
  let mv = 0, gain = 0, at = 0, nMv = 0, nGain = 0, nAt = 0, missing = 0;
  for (const s of sorted) {
    if (!s.tax) { missing++; continue; }
    if (s.tax.marketValueUsd != null) { mv += s.tax.marketValueUsd; nMv++; } else missing++;
    if (s.tax.unrealizedUsd != null) { gain += s.tax.unrealizedUsd; nGain++; }
    if (s.tax.afterTaxGainUsd != null) { at += s.tax.afterTaxGainUsd; nAt++; }
  }
  rows.push(kv('Total market value', nMv ? orReason(fmtUsd(mv)) : sentence('FIELD_MISSING')));
  rows.push(kv('Gain or loss now', nGain ? orReason(fmtSignedUsd(gain)) : sentence('FIELD_MISSING')));
  rows.push(kv('Gain after tax', nAt ? orReason(fmtSignedUsd(at)) + ' (' + T.taxBaseline(pct) + ')' : sentence('FIELD_MISSING')));
  const order = EXIT_ACTION_ORDER;
  const counts = new Map<string, number>();
  sorted.forEach((s) => counts.set(s.v.action, (counts.get(s.v.action) ?? 0) + 1));
  const roll = order.filter((a) => counts.get(a)).map((a) => counts.get(a) + ' ' + a).join(' · ');
  rows.push(kv('Action rollup', roll || T.noHoldings, { bold: true }));
  if (missing) rows.push(line(missing + ' holding(s) are left out of the totals because a price or quantity is missing.', { italic: true }));
  return rows;
}

function healthRows(input: ExitReportInput, sorted: ReadonlyArray<{ h: ExitHoldingInput; v: Verdict; tax: TaxView | null }>): Row[] {
  const rows: Row[] = [band(T.dataHealthHeader, '#546e7a', 12)];
  const items = dataQualityLines(input.dataHealth);
  rows.push(line(items[0] === 'Data quality' && items.length === 2 && items[1] === 'No data issues.' ? T.noRunIssues : items.join('\n')));
  const s = input.skipped;
  if (s.stockTableUnreadable) rows.push(line(labelledReason('Portfolio stock table', 'SHEET_UNREADABLE'), { bg: '#fff3e0' }));
  if (s.optionsTableUnreadable) rows.push(line(labelledReason('Portfolio options table', 'SHEET_UNREADABLE'), { bg: '#fff3e0' }));
  if (s.stockTableEmpty) rows.push(line(labelledReason('Portfolio stock table', 'TABLE_EMPTY')));
  const noDate = sorted.filter((x) => !x.v.failed && !hasEntryDate(x.h.position.entryDate));
  const assumedDate = sorted.filter((x) => !x.v.failed && x.h.position.entryDateAssumed === true && hasEntryDate(x.h.position.entryDate));
  if (assumedDate.length) rows.push(line(T.assumedEntryDates(assumedDate.length, assumedDate.map((x) => holdingLabel(x.h)).join(', ')), { bg: '#fff3e0', bold: true }));
  if (noDate.length || !assumedDate.length) rows.push(line(noDate.length ? T.noEntryDates(noDate.length, noDate.map((x) => holdingLabel(x.h)).join(', ')) : T.allHaveEntryDates, noDate.length ? { bg: '#fff3e0', bold: true } : {}));
  if (s.crypto.length) {
    rows.push(line(T.cryptoSkipped(s.crypto.length, s.crypto.join(', '))));
    // F-B8-1: no warning when the same ticker is also held as a stock row (the owner's BTC: real bitcoin typed crypto, the Mini Trust ETF typed stock).
    const heldAsStock = new Set(sorted.filter((x) => x.h.kind === 'STOCK').map((x) => x.h.ticker.toUpperCase()));
    for (const t of s.crypto) if (BITCOIN_ETF_TICKERS.includes(t.toUpperCase()) && !heldAsStock.has(t.toUpperCase())) rows.push(line(T.btcEtfTypedCrypto(t), { bg: '#fff3e0', bold: true }));
  }
  if (s.otherStock.length) rows.push(line(T.otherSkipped(s.otherStockCount ?? s.otherStock.length, s.otherStock.join('; '))));
  if (s.blankTickerRowCount) rows.push(line(T.blankSkipped(s.blankTickerRowCount)));
  return rows;
}

function tocRows(sorted: ReadonlyArray<{ h: ExitHoldingInput; v: Verdict; tax: TaxView | null }>): Row[] {
  const rows: Row[] = [band(T.tocHeader, '#1565c0', 12), grid6([...T.tocColumns], { bold: true, bg: '#eceff1' })];
  rows[0]!.anchor = 'T';
  sorted.forEach((s, i) => {
    const l = s.h.levels;
    const stop = !l ? 'no levels' : l.stopBreached ? '⚠ stop breached' : l.hitT2 ? '✓ T2 hit' : l.hitT1 ? '✓ T1 hit' : l.stopLevel != null ? 'stop ' + fmtUsd(l.stopLevel) : 'no stop level';
    const flags: string[] = [];
    if (s.h.correlatedGroup) flags.push('shared thesis');
    if (!s.v.failed && !hasEntryDate(s.h.position.entryDate)) flags.push('no entry date');
    else if (!s.v.failed && s.h.position.entryDateAssumed) flags.push('assumed entry date');
    rows.push({ cells: [holdingLabel(s.h), s.v.action, s.tax && s.tax.unrealizedPct != null ? (fmtPct(s.tax.unrealizedPct) as string) : 'price missing', stop, flags.join(', '), ''], height: 21, cellBg: { 2: s.v.bg }, late: { col: 6, fn: (a) => 'Go to row ' + (a['H' + i] ?? 0) }, link: { col: 6, anchor: 'H' + i } });
  });
  return rows;
}

function attentionRows(sorted: ReadonlyArray<{ h: ExitHoldingInput; v: Verdict; tax: TaxView | null }>): Row[] {
  const rows: Row[] = [band(T.attentionHeader, '#e65100', 12)];
  const hot = sorted.filter((s) => s.v.rank <= 2);
  if (!hot.length) { rows.push(line(T.nothingNeedsAttention)); return rows; }
  for (const s of hot) {
    rows.push(kv(holdingLabel(s.h), s.v.text, { bg: s.v.bg, bold: true }));
    rows.push(kv('Levels', levelsLine(s.h)));
    if (s.h.sellPlan && s.h.sellPlan.lines[0]) rows.push(kv('How many to sell', s.h.sellPlan.lines[0]));
  }
  return rows;
}

/** "A, A, A, B" -> "A (x3), B": a repeated pattern name is shown once with its count. */
export function compactList(list: string): string {
  const counts = new Map<string, number>();
  for (const p of list.split(',').map((x) => x.trim()).filter(Boolean)) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts].map(([p, n]) => (n > 1 ? p + ' (x' + n + ')' : p)).join(', ');
}

function bitcoinRows(input: ExitReportInput): Row[] {
  const st = input.sharedThesis;
  if (!st || st.members.length < 2) return [];
  const rows: Row[] = [band(T.btcHeader, '#f57c00', 12), line(T.btcWhy, { italic: true })];
  rows.push(kv('Holdings covered', st.members.join(', ')));
  rows.push(kv('Read from', st.anchorSeries));
  rows.push(kv('Regime', st.regime ?? sentence('FIELD_MISSING')));
  rows.push(kv('Trend', st.trend ? st.trend + (st.trendMaturity ? ', ' + st.trendMaturity : '') : sentence('FIELD_MISSING')));
  rows.push(kv('RSI / StochRSI', st.rsi == null && st.stochRsi == null ? sentence('FIELD_MISSING') : (fmtNum(st.rsi) ?? 'not available') + ' / ' + (fmtNum(st.stochRsi) ?? 'not available')));
  rows.push(kv('Chart pattern', st.pattern ? compactList(st.pattern) : sentence('FIELD_MISSING')));
  rows.push(kv('Momentum', st.momentum ?? sentence('FIELD_MISSING')));
  rows.push(kv('Technical thesis', st.thesis ?? sentence('FIELD_MISSING'), { bold: true }));
  rows.push(line(T.btcDisclosure(st.members.join(', ')), { italic: true }));
  return rows;
}

function checksRows(input: ExitReportInput): Row[] {
  const rows: Row[] = [band(T.checksHeader, '#6c3483', 12)];
  const a = input.advisory;
  if (!a) { rows.push(line(input.advisoryUnavailable ? labelledReason('Diversification and market-phase check', input.advisoryUnavailable) : labelledReason('Diversification and market-phase check', 'NOT_RUN'))); return rows; }
  rows.push(line(T.advisoryDistinct(a.distinctStockCount, a.diversificationFlag), a.diversificationFlag ? { bg: '#fff3e0' } : {}));
  const phase = a.phaseRead ? (PHASE_LABELS[a.phaseRead] ?? T.advisoryNoPhase) : T.advisoryNoPhase;
  rows.push(line('Market phase: ' + phase + (a.evaluativeIndexPctStrong != null ? ' — Evaluative Index ' + a.evaluativeIndexPctStrong.toFixed(1) + '% Strong' : '') + (a.dowTheoryVerdict ? ', Dow Theory ' + a.dowTheoryVerdict : '')));
  if (a.holdings.length) {
    rows.push(grid6([...T.advisoryTierColumns], { bold: true, bg: '#d2b4de' }));
    a.holdings.forEach((x, i) => rows.push(grid6([x.ticker, x.tier ?? sentence('FIELD_MISSING'), x.note ?? ''], { bg: i % 2 === 0 ? '#f4ecf7' : '#ffffff' })));
  }
  rows.push(line(T.advisoryInfoOnly, { italic: true, color: '#666666' }));
  if (a.correlatedCaps) {
    const cc = a.correlatedCaps;
    rows.push(sub(T.capsHeader));
    rows.push(line(T.capsTotal(cc.totalUnits.toFixed(1), cc.totalFlagged), cc.totalFlagged ? { bg: '#fff3e0' } : {}));
    if (cc.categoryFlags.length) {
      rows.push(grid6([...T.capsColumns], { bold: true, bg: '#aed6f1' }));
      cc.categoryFlags.forEach((cf, i) => rows.push(grid6([cf.category + (cf.flagged ? ' ⚠' : ''), cf.units.toFixed(1)], { bg: i % 2 === 0 ? '#eaf2f8' : '#ffffff' })));
    } else rows.push(line(T.capsNone, { italic: true }));
    rows.push(line(T.capsInfoOnly, { italic: true, color: '#666666' }));
  }
  return rows;
}

/** Owner 2026-11-07 (exit.businessAlerts shadow / on): the business-based alerts. Display only; absent = no section. */
export const BUSINESS_ALERTS_HEADER = 'Business alerts (shadow)';
function businessAlertsRows(input: ExitReportInput): Row[] {
  const b = input.businessAlerts;
  if (!b) return [];
  const rows: Row[] = [band(BUSINESS_ALERTS_HEADER, '#4e342e', 12)];
  if (b.unavailable) { rows.push(line(labelledReason('Business alerts', 'SECTION_UNAVAILABLE'))); return rows; }
  for (const t of b.intro) rows.push(line(t, { italic: true, color: '#666666' }));
  // A market shock is a buy point, never an exit (owner 2026-11-07): green, not the alert red.
  rows.push(kv('Market', b.market.text, b.market.alert ? { bg: '#e8f5e9', bold: true } : {}));
  for (const h of b.holdings) rows.push(kv(h.ticker, h.text, h.alert ? { bg: '#fdecea', bold: true } : {}));
  return rows;
}

function footerRows(input: ExitReportInput, pct: number, hasShared: boolean): Row[] {
  const rows: Row[] = [band(T.footerHeader, '#546e7a', 12)];
  rows.push(line(T.taxBaseline(pct)));
  rows.push(line(T.entryFallbackNote));
  if (hasShared) rows.push(line(T.btcWhy));
  rows.push(line(T.longOnly));
  rows.push(line(T.aiNote));
  return rows;
}

/** The nightly build: whole tab rebuilt, AI section back to its placeholder. */
export function buildExitSheet(ss: ReportWorkbook, input: ExitReportInput, deps: ExitSheetDeps = {}): ExitSheetResult {
  const log = deps.log ?? ((): void => {});
  const tz = deps.timeZone ?? REPORT_TIME_ZONE;
  const degraded: Array<{ name: string; reason: ReasonCode }> = [];
  const pct = Math.round(EXIT_TAX_RATE * 100);
  const members = input.sharedThesis && input.sharedThesis.members.length >= 2 ? input.sharedThesis.members.join(', ') : '';
  const stockAnchorByTicker = new Map<string, string>();

  const sorted = input.holdings.map((h, i) => ({ h, i, v: verdictOf(h), tax: null as TaxView | null }))
    .sort((a, b) => a.v.rank - b.v.rank || a.i - b.i);
  sorted.forEach((s, k) => {
    try { s.tax = taxOf(s.h); } catch (e) { log('exit sheet: tax view failed for ' + s.h.ticker + ': ' + String((e as Error)?.stack ?? e)); }
    if (s.h.kind === 'STOCK' && !stockAnchorByTicker.has(s.h.ticker)) stockAnchorByTicker.set(s.h.ticker, 'H' + k);
  });
  const ctx: Ctx = { now: input.runAt, tz, pct, sharedMembers: members, hasShared: members !== '', stockAnchorByTicker };

  const safe = (name: string, i: number | null, fn: () => Row[]): Row[] => {
    try { return fn(); } catch (e) {
      log('exit sheet: section "' + name + '" failed: ' + String((e as Error)?.stack ?? e));
      degraded.push({ name, reason: 'SECTION_UNAVAILABLE' });
      return degradedSection(name, i);
    }
  };

  const banner: Row[] = [
    band(T.title, '#263238', 16),
    line(T.runLabel + stamp(input.runAt, tz), { bold: true }),
    { cells: [''], mergeFrom: 1, height: 21, late: { col: 1, fn: (a) => T.aiStatusPending(a['AI'] ?? 0) }, link: { col: 1, anchor: 'AI' } },
    line(T.howToRead, { italic: true }),
    ...(input.marketOptionsLine ? [line(input.marketOptionsLine, { italic: true, color: '#4a148c' })] : []),
  ];
  const sections: Row[][] = [
    banner,
    safe('Data health', null, () => healthRows(input, sorted)),
    safe('Portfolio summary', null, () => summaryRows(sorted, input, pct)),
    safe('Table of contents', null, () => tocRows(sorted)),
    safe('Needs attention', null, () => attentionRows(sorted)),
  ];
  const btc = safe('Bitcoin shared thesis', null, () => bitcoinRows(input));
  if (btc.length) sections.push(btc);
  if (!sorted.length) sections.push([line(T.noHoldings)]);
  sorted.forEach((s, i) => {
    sections.push(safe(holdingLabel(s.h), i, () => holdingSection(s.h, i, s.tax ?? taxOf(s.h), ctx)));
  });
  sections.push(safe('Portfolio-wide checks', null, () => checksRows(input)));
  const biz = safe(BUSINESS_ALERTS_HEADER, null, () => businessAlertsRows(input));
  if (biz.length) sections.push(biz);
  sections.push(footerRows(input, pct, ctx.hasShared));
  const ai: Row[] = [
    { cells: [AI_ANCHOR], mergeFrom: 1, bg: '#6a1b9a', color: '#ffffff', bold: true, size: 13, height: 28, anchor: 'AI' },
    { cells: [AI_PLACEHOLDER], mergeFrom: 1, height: 21, italic: true },
  ];
  sections.push(ai);

  const rows: Row[] = [];
  sections.forEach((s, i) => { if (i > 0) rows.push(blank()); rows.push(...s); });
  const anchors: Anchors = {};
  rows.forEach((r, i) => { if (r.anchor) anchors[r.anchor] = i + 1; });
  rows.forEach((r) => { if (r.late) { r.cells[r.late.col - 1] = r.late.fn(anchors); } if (r.link) r.link.row = anchors[r.link.anchor]; });

  const sh = getOrCreate(ss, EXIT_SHEET_TAB);
  sh.clearContents();
  sh.clearFormats();
  sh.setTabColor(EXIT_SHEET_TAB_COLOR);
  WIDTHS.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  render(sh, rows, 1);
  sh.setFrozenRows(1);
  sh.activate();
  return { written: true, tab: EXIT_SHEET_TAB, rowCount: rows.length, anchors, order: sorted.map((s) => holdingLabel(s.h)), degraded };
}

export interface AiWriteResult {
  readonly written: boolean;
  /** Report-safe sentence when nothing was written; null on success. */
  readonly message: string | null;
  readonly anchorRow: number | null;
  readonly droppedLines: number;
}

/**
 * Plan #47: the Exit report as the nightly wrote it, every row above the AI SUMMARIES anchor (all holdings, options,
 * summary and portfolio-wide checks), without the banner's AI status line. Null when the tab or the anchor is missing.
 */
export function readExitReportRows(ss: ReportWorkbook): unknown[][] | null {
  const sh = ss.getSheetByName(EXIT_SHEET_TAB);
  if (!sh) return null;
  const last = sh.getLastRow();
  if (last < 1) return null;
  const all = sh.getRange(1, 1, last, NCOLS).getValues() as unknown[][];
  const anchor = all.findIndex((r) => String(r[0] ?? '') === AI_ANCHOR);
  if (anchor < 0) return null;
  return all.slice(0, anchor).filter((r) => !String(r[0] ?? '').startsWith(T.aiStatusPrefix));
}

/** The manual AI run: replace the AI SUMMARIES section in place. Never creates a tab. Idempotent. */
export function writeAiSummaries(ss: ReportWorkbook, ai: AiSummariesInput, deps: ExitSheetDeps = {}): AiWriteResult {
  const log = deps.log ?? ((): void => {});
  const tz = deps.timeZone ?? REPORT_TIME_ZONE;
  const sh = ss.getSheetByName(EXIT_SHEET_TAB);
  if (!sh) { log('exit sheet AI: the Exit report tab does not exist; nothing written'); return { written: false, message: T.aiRunNightlyFirst, anchorRow: null, droppedLines: 0 }; }
  let anchorRows: number[] = [];
  let lastRow = 0;
  let statusRow = 0;
  try {
    lastRow = sh.getLastRow();
    if (lastRow > 0) {
      const colA = sh.getRange(1, 1, lastRow, 1).getValues();
      colA.forEach((r, i) => { if (String(r[0] ?? '') === AI_ANCHOR) anchorRows.push(i + 1); });
      // Row 35 (#4): the banner's AI status line (within the first rows, before any section).
      const k = colA.slice(0, 6).findIndex((r) => String(r[0] ?? '').startsWith(T.aiStatusPrefix));
      if (k >= 0) statusRow = k + 1;
    }
  } catch (e) {
    log('exit sheet AI: could not read the Exit report tab: ' + String((e as Error)?.stack ?? e));
    return { written: false, message: labelledReason('AI summaries', 'SHEET_UNREADABLE'), anchorRow: null, droppedLines: 0 };
  }
  if (anchorRows.length === 0) { log('exit sheet AI: anchor row not found'); return { written: false, message: T.aiAnchorMissing, anchorRow: null, droppedLines: 0 }; }
  if (anchorRows.length > 1) { log('exit sheet AI: ' + anchorRows.length + ' anchor rows found; refusing to guess'); return { written: false, message: T.aiAnchorDuplicate, anchorRow: null, droppedLines: 0 }; }
  const anchor = anchorRows[0] as number;

  let dropped = 0;
  const rows: Row[] = [];
  const full = (text: string, o: Partial<Row> = {}): Row => ({ cells: [text], mergeFrom: 1, height: estHeight(text, 1), ...o });
  const opusLabel = ai.opusMode === 'OFF' ? 'off' : ai.opusMode;
  rows.push(full(T.aiHeaderStatus(stamp(ai.ranAt, tz), ai.geminiUsed, opusLabel, ai.effort ?? 'not set'), { italic: true }));
  let headline: string | null = null;
  if (ai.portfolioView) {
    const pv = cleanNarrative(ai.portfolioView.paragraphs.join('\n'));
    dropped += pv.dropped;
    rows.push(full('▣ ' + PORTFOLIO_VIEW_TITLE, { bold: true, bg: '#ede7f6', height: 24 }));
    pv.paragraphs.forEach((p, i) => rows.push(full(p, i === 0 ? { italic: true } : {})));
    if (!pv.paragraphs.length) rows.push(full(labelledReason(PORTFOLIO_VIEW_TITLE, 'AI_REVIEW_UNAVAILABLE')));
    const h = ai.portfolioView.headline ? cleanNarrative(ai.portfolioView.headline).paragraphs[0] : undefined;
    headline = h ?? null;
  }
  if (!ai.entries.length) rows.push(full(labelledReason('AI review', 'AI_REVIEW_UNAVAILABLE')));
  for (const e of ai.entries) {
    rows.push(full('▸ ' + e.ticker, { bold: true, bg: '#f3e5f5', height: 24 }));
    const g = cleanNarrative(e.gemini);
    const o = cleanNarrative(e.opus);
    dropped += g.dropped + o.dropped;
    if (ai.geminiUsed) {
      rows.push(full(T.aiGemini, { bold: true }));
      if (g.paragraphs.length) g.paragraphs.forEach((p) => rows.push(full(p)));
      else rows.push(full(labelledReason('Gemini narrative', 'AI_REVIEW_UNAVAILABLE')));
    }
    if (ai.opusMode === 'OFF') rows.push(full(labelledReason(T.aiOpus, 'NOT_RUN'), { italic: true }));
    else {
      rows.push(full(T.aiOpus, { bold: true }));
      rows.push(full(ai.opusMode === 'REVIEW' ? T.opusReviewLine : T.opusStandalone(ai.standaloneWhy ? reasonSentence(ai.standaloneWhy) : null), { italic: true }));
      if (o.paragraphs.length) o.paragraphs.forEach((p) => rows.push(full(p)));
      else rows.push(full(labelledReason(T.aiOpus, 'AI_REVIEW_UNAVAILABLE')));
    }
    if (g.dropped + o.dropped > 0) rows.push(full(T.aiDropped, { italic: true, color: '#666666' }));
  }
  if (dropped) log('exit sheet AI: ' + dropped + ' narrative line(s) were dropped because the leak scan flagged them');

  const oldRows = lastRow - anchor;
  if (oldRows > 0) {
    const region = sh.getRange(anchor + 1, 1, oldRows, NCOLS);
    region.clearContent();
    region.setBackground('#ffffff').setFontColor('#000000').setFontWeight('normal').setFontStyle('normal').setFontSize(10);
    for (let r = anchor + 1; r <= lastRow; r++) sh.setRowHeight(r, 21);
  }
  render(sh, rows, anchor + 1);
  if (statusRow) {
    const status = T.aiStatusDone(stamp(ai.ranAt, tz), ai.geminiUsed, opusLabel, anchor) + (headline ? T.aiStatusPortfolio(headline) : '');
    sh.getRange(statusRow, 1, 1, 1).setValues([[status]]);
    if (headline) sh.setRowHeight(statusRow, estHeight(status, 1));
  }
  return { written: true, message: null, anchorRow: anchor, droppedLines: dropped };
}
