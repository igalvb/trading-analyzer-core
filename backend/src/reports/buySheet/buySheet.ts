/**
 * FL-8r (Phase 5, backlog row 11): the ONE combined, tiered, pedagogical Buy report sheet, per
 * docs/CHARACTERIZATION_PLAN_V13_buy_pipeline_and_report.md sections 4-6. It replaces the legacy flat grid
 * buildWatchlistSummarySheetV7 (fullStockAnalysisV10_9.gs :432-452, whose seven columns Ticker / OWN / TIMING /
 * Regime / Final Conviction / Action / Updated are all carried into FULL RANKING) and folds in scanWatchlistV7
 * (:9627-9659; the BUY_NOW-first, conviction-descending order arrives as `rank` from the pipeline and is rendered as
 * given). Legacy wording kept in plain English: LILO entry ladder (:5379-5381), options pick lines (:5398-5410),
 * R:R gate (:5420, :3283) and R:R at today's price (:5432), BLOCKED verdict (:3214).
 *
 * buildBuySheet        : nightly. Rebuilds the whole tab, AI section reset to AI_PLACEHOLDER. One setValues, formatting
 *                        recorded for one batchUpdate (ReportWorkbook.flush -> one applyTab).
 * writeBuyAiSummaries  : manual AI run. Never creates a tab. Finds the single AI_ANCHOR row and replaces everything
 *                        below it (the AI section is the LAST section, so nothing shifts). Idempotent. The workbook
 *                        must have loaded the Buy tab at open().
 *
 * Display only: nothing here scores, ranks or re-decides. LONG-ONLY. No tax content. Every free-text string coming
 * from the pipeline passes the leak scan; a flagged string is replaced by a catalog sentence and the original goes to
 * deps.log (technical detail in the log, plain English on the sheet).
 */
import type { ReportSheet, ReportWorkbook } from '../../sheets/reportSheet.ts';
import { getOrCreate } from '../options/tabs.ts';
import { bottomLine, scoreBar } from '../bottomLine/helpers.ts';
import { readExtraModels, extraModelRows, EXTRA_MODELS_DISCLAIMER, EXTRA_MODELS_HEADER } from '../../analysis/extraModels.ts';
import { dataQualityLines, labelledReason, reasonLine, reasonSentence, REPORT_TIME_ZONE, type ReasonCode } from '../messages/catalog.ts';
import { findReportLeaks } from '../messages/leakScan.ts';
import { validModelReads, validComparisonRead } from '../adapters/modelReads.ts';
import { OWN_BLOCK_FLOOR, OWN_FILTER_THRESHOLD } from '../../types/decision.ts';
import {
  AI_ANCHOR, AI_PLACEHOLDER, BUY_SHEET_TAB, BUY_SHEET_TAB_COLOR, DEFAULT_TIER1_MIN, DEFAULT_TIER2_MIN, MODEL_NAMES, MODEL_ORDER, NCOLS, T, WIDTHS,
  bandLabel, cleanNarrative, estHeight, expiryText, fmtNum, fmtPlainPct, fmtScore, fmtUsd, isModelId, isReasonCode, isStance,
  regimePhrase, regimeShort, stamp, stanceLabel, timingLabel, timingMeaning,
} from './text.ts';
import type {
  BitcoinGroupInput, BuyAiSummariesInput, BuyCandidateInput, BuyReportInput, BuyTier, ComparisonRead, ModelRead, OptionPick, OptionsPicks,
} from './types.ts';

export { BUY_SHEET_TAB, BUY_SHEET_TAB_COLOR, AI_ANCHOR, AI_PLACEHOLDER };

type Anchors = Record<string, number>;
interface Row {
  cells: unknown[];
  /** Merge from this column to the last column. */
  mergeFrom?: number;
  /** Extra merges, 1-based inclusive column spans. */
  merges?: ReadonlyArray<readonly [number, number]>;
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
}

const band = (text: string, bg: string, size = 12): Row => ({ cells: [text], mergeFrom: 1, bg, color: '#ffffff', bold: true, size, height: Math.max(28, estHeight(text, 1)) });
const sub = (text: string): Row => ({ cells: [text], mergeFrom: 1, bg: '#e3f2fd', bold: true, height: 24 });
const line = (text: string, o: Partial<Row> = {}): Row => ({ cells: [text], mergeFrom: 1, height: estHeight(text, 1), ...o });
const kv = (label: string, value: string, o: Partial<Row> = {}): Row => ({ cells: [label, value], mergeFrom: 2, labelCol: true, height: estHeight(value, 2), ...o });
const blank = (): Row => ({ cells: [] });
const grid = (cells: unknown[], o: Partial<Row> = {}): Row => ({ cells, height: 21, ...o });
const sentence = (code: ReasonCode): string => reasonLine(code);
const orReason = (v: string | null, code: ReasonCode = 'FIELD_MISSING'): string => v ?? sentence(code);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const asTier = (x: unknown): BuyTier => (x === 1 || x === 2 ? x : 3);

export interface BuySheetDeps {
  readonly log?: (message: string) => void;
  readonly timeZone?: string;
  /** Parity flag (F-R5): true prints option expiries with toDateString() in the process time zone, as legacy did. */
  readonly legacyExpiryText?: boolean;
}
export interface BuySheetResult {
  readonly written: boolean;
  readonly tab: string;
  readonly rowCount: number;
  /** Anchor key -> 1-based row: 'AI', 'R' (ranking), 'C0'.. (candidate i in report order). */
  readonly anchors: Readonly<Record<string, number>>;
  /** Tickers in report order. */
  readonly order: readonly string[];
  readonly tiers: { readonly 1: readonly string[]; readonly 2: readonly string[]; readonly 3: readonly string[] };
  readonly degraded: ReadonlyArray<{ readonly name: string; readonly reason: ReasonCode }>;
}

interface Ctx {
  readonly runAt: Date;
  readonly tz: string;
  readonly log: (m: string) => void;
  readonly clean: (text: unknown, fallback: string, where: string) => string;
  readonly t1Min: number;
  readonly t2Min: number;
  readonly btcMembers: string;
  readonly legacyExpiry: boolean;
}

// ───────────────────────── defensive parsers (models / comparison / options arrive as unknown) ─────────────────────────

/** The model rows and the comparison count: one parser, reports/adapters/modelReads.ts (dedupe cluster 9). */
export const readModels: (x: unknown) => ModelRead[] = validModelReads;
export const readComparison: (x: unknown) => ComparisonRead | null = validComparisonRead;

function readPick(x: unknown): OptionPick | null {
  if (x === null || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const c = o['contract'];
  const contract = c !== null && typeof c === 'object'
    ? { strike: (c as Record<string, unknown>)['strike'] as number | string, expUnix: (c as Record<string, unknown>)['expUnix'] as number, delta: (c as Record<string, unknown>)['delta'] as number, iv: num((c as Record<string, unknown>)['iv']) }
    : undefined;
  return { found: o['found'] === true, ...(typeof o['reason'] === 'string' ? { reason: o['reason'] } : {}), ...(contract ? { contract } : {}) };
}

export function readOptions(x: unknown): OptionsPicks | null {
  if (x === null || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  return { leaps: readPick(o['leaps']), shortTerm: readPick(o['shortTerm']) };
}

// ───────────────────────── small text builders ─────────────────────────

function zoneText(c: BuyCandidateInput): string | null {
  const z = c.entryZone ?? { low: null, center: null, high: null };
  const lo = fmtUsd(z.low), hi = fmtUsd(z.high), mid = fmtUsd(z.center);
  if (lo && hi) return lo + ' – ' + hi;
  return mid ?? lo ?? hi;
}

function convWordOf(c: BuyCandidateInput): string | null {
  if (c.conviction == null || !Number.isFinite(c.conviction)) return null;
  // Reuses the pedagogical helper's own High/Moderate/Low/Very Low thresholds (bottomLineV7_ :8861-8874); nothing re-derived here.
  return bottomLine(c.ticker, { score: c.ownScore }, { regime: c.regime, timing: c.timing }, { action: c.action ?? '', finalConviction: c.conviction }, null).convWord;
}

function convBg(word: string | null): string {
  return word === 'High' ? '#c8e6c9' : word === 'Moderate' ? '#fff9c4' : '#ffcdd2';
}

function whySentence(c: BuyCandidateInput): string {
  const parts: string[] = [];
  const own = fmtScore(c.ownScore);
  const band = bandLabel(c.ownBand);
  parts.push(own != null ? 'Fundamentals score ' + own + '/100' + (band ? ' (' + band + ').' : '.') : 'No fundamentals score was available, so this read leans on the chart.');
  const rg = regimePhrase(c.regime);
  if (rg) parts.push('The chart is in ' + rg + '.');
  const tm = timingLabel(c.timing);
  if (tm) parts.push('Entry timing: ' + tm.toLowerCase() + '.');
  const cv = fmtScore(c.conviction);
  if (cv != null) parts.push('Conviction is ' + cv + ' out of 100.');
  return parts.join(' ');
}

interface Verdict { readonly text: string; readonly bg: string; readonly ok: boolean }
function verdictOf(c: BuyCandidateInput, ctx: Ctx): Verdict {
  if (c.status === 'failed' || c.action == null || c.action === '') {
    const why = ctx.clean(c.note, sentence('SECTION_UNAVAILABLE'), c.ticker + ' note');
    return { text: 'No verdict. ' + why, bg: c.status === 'failed' ? '#fdecea' : '#fff3e0', ok: false };
  }
  const text = ctx.clean(c.action, 'No verdict. ' + sentence('SECTION_UNAVAILABLE'), c.ticker + ' verdict');
  const bg = c.blocked ? '#ffcdd2' : asTier(c.tier) === 1 ? '#c8e6c9' : asTier(c.tier) === 2 ? '#fff9c4' : '#eceff1';
  return { text, bg, ok: true };
}

const convText = (c: BuyCandidateInput): string => { const s = fmtScore(c.conviction); return s != null ? s + '/100' : '—'; };

// ───────────────────────── sections ─────────────────────────

function verdictRows(c: BuyCandidateInput, ctx: Ctx): Row[] {
  const v = verdictOf(c, ctx);
  const word = convWordOf(c);
  const rows: Row[] = [kv('① VERDICT', v.text + (v.ok && word ? ' — conviction ' + convText(c) + ' (' + word + ')' : ''), { bg: v.ok ? convBg(word) : v.bg, bold: true })];
  if (c.conviction != null && Number.isFinite(c.conviction)) rows.push(kv('Conviction bar', scoreBar(c.conviction) + '  ' + convText(c)));
  rows.push(kv('Why', whySentence(c)));
  if (c.buyNow && (c.ownBand === 'weak' || c.ownBand === 'unknown')) rows.push(line(T.chartOnlyCaution, { italic: true, bg: '#fff3e0' }));
  return rows;
}

function optionLine(label: string, pick: OptionPick | null | undefined, checkConflict: boolean, c: BuyCandidateInput, ctx: Ctx): Row {
  if (!pick) return kv(label, T.optionNotAvailable);
  if (!pick.found) return kv(label, T.optionNotFound(ctx.clean(pick.reason, '', c.ticker + ' option reason')));
  const k = pick.contract;
  const exp = k ? expiryText(k.expUnix, ctx.legacyExpiry) : null;
  const delta = k && Number.isFinite(k.delta) ? k.delta.toFixed(2) : null;
  const iv = k && typeof k.iv === 'number' && k.iv ? (k.iv * 100).toFixed(1) + '%' : T.optionIvNone;
  if (!k || exp == null || delta == null) return kv(label, sentence('FIELD_MISSING'));
  let text = '$' + String(k.strike) + ' call, expires ' + exp + '  ·  delta ' + delta + '  ·  implied volatility ' + iv;
  let bg: string | undefined;
  if (checkConflict && (c.timing === 'WAIT_PULLBACK' || c.timing === 'AVOID')) { text += '  ⚠ ' + T.optionAhead; bg = '#fff3e0'; }
  return kv(label, text, bg ? { bg } : {});
}

function entryRows(c: BuyCandidateInput, ctx: Ctx): Row[] {
  const rows: Row[] = [sub('② ENTRY PLAN')];
  const tm = timingLabel(c.timing), mean = timingMeaning(c.timing);
  rows.push(kv('Timing', tm ? tm + (mean ? ' — ' + mean : '') : sentence('FIELD_MISSING')));
  const zone = zoneText(c);
  const centre = fmtUsd(c.entryZone ? c.entryZone.center : null);
  rows.push(kv('Entry zone', zone ? zone + (centre && c.entryZone.low != null && c.entryZone.high != null ? ' (centre ' + centre + ')' : '') : sentence('FIELD_MISSING')));
  rows.push(kv('Time to entry', c.timeToEntry ? ctx.clean(c.timeToEntry, sentence('FIELD_MISSING'), c.ticker + ' time to entry') : sentence('FIELD_MISSING')));
  const conf = fmtPlainPct(c.entryConfidencePct);
  rows.push(kv('Entry confidence', conf ? conf + ' — ' + T.entryConfNote : sentence('FIELD_MISSING')));
  const rungs = c.entryLadder && Array.isArray(c.entryLadder.rungs) ? c.entryLadder.rungs : [];
  if (!rungs.length) rows.push(kv('Buy-limit ladder', T.ladderNone));
  else rungs.forEach((r, i) => rows.push(kv(i === 0 ? 'Buy-limit ladder' : '', T.ladderRung(r.rung, orReason(fmtUsd(r.price)), c.entryLadder.percents[i] ?? null))));
  const t1 = fmtUsd(c.t1), t2 = fmtUsd(c.t2);
  rows.push(kv('Targets', t1 || t2 ? 'Target 1 ' + orReason(t1) + '  ·  Target 2 ' + orReason(t2) : sentence('FIELD_MISSING')));
  if (c.options == null) rows.push(kv('Call options', T.optionsNone));
  else {
    const o = readOptions(c.options);
    if (!o) rows.push(kv('Call options', T.optionsNone));
    else {
      rows.push(optionLine('Long-dated call (over a year)', o.leaps, false, c, ctx));
      rows.push(optionLine('Shorter-dated call (under a year)', o.shortTerm, true, c, ctx));
    }
  }
  return rows;
}

function riskRows(c: BuyCandidateInput, _ctx: Ctx): Row[] {
  const rows: Row[] = [sub('③ RISK')];
  const stop = fmtUsd(c.stop);
  rows.push(kv('Initial stop', stop ? stop + ' — ' + T.stopExplain : sentence('FIELD_MISSING')));
  const ts = c.sizing ? fmtUsd(c.sizing.stopLevel) : null;
  if (ts) rows.push(kv('Volatility-based stop (Turtle)', T.turtleStop(ts)));
  const r1 = num(c.rrToT1), r2 = num(c.rrToT2);
  rows.push(kv('Reward to risk, target 1', r1 != null ? T.rr(r1) : sentence('FIELD_MISSING'), r1 != null && r1 < 1.0 ? { bg: '#fff3e0' } : {}));
  rows.push(kv('Reward to risk, target 2', r2 != null ? T.rrPlain(r2) : sentence('FIELD_MISSING')));
  const spot = num(c.rrToT1AtSpot);
  if (spot != null) rows.push(kv("Reward to risk at today's price", T.rrSpot(spot, r1 != null ? r1.toFixed(2) : null, fmtUsd(c.entryZone ? c.entryZone.center : null)), spot < 1.0 ? { bg: '#fff3e0' } : {}));
  rows.push(kv('Position size', c.sizingText ? _ctx.clean(c.sizingText, T.sizingMissing, c.ticker + ' sizing') : T.sizingMissing));
  const n = c.sizing ? fmtUsd(c.sizing.n) : null;
  if (n) rows.push(kv('Volatility unit (N)', n + ' — the stock\'s typical daily move'));
  return rows;
}

function modelRows(c: BuyCandidateInput): Row[] {
  const rows: Row[] = [sub('④ THE 5 MODELS — independent reads'), grid([...T.modelsHeader], { bold: true, bg: '#eceff1', merges: [[4, 9]] })];
  const reads = readModels(c.models);
  if (!reads.length) { rows.push(line(labelledReason('Model reads', 'NOT_RUN'), { italic: true })); return rows; }
  for (const id of MODEL_ORDER) {
    const r = reads.find((m) => m.model === id);
    if (!r) { rows.push(grid([MODEL_NAMES[id], stanceLabel('UNAVAILABLE'), '', sentence('NOT_RUN')], { merges: [[4, 9]] })); continue; }
    const note = r.stance === 'UNAVAILABLE' ? sentence(r.reasonCode ?? 'SECTION_UNAVAILABLE') : '';
    rows.push(grid([MODEL_NAMES[id], stanceLabel(r.stance), r.stance === 'UNAVAILABLE' ? '' : (fmtNum(r.score) ?? ''), note], { merges: [[4, 9]] }));
  }
  const cmp = readComparison(c.comparison);
  if (!cmp) rows.push(line(labelledReason('Model comparison', 'NOT_RUN'), { italic: true }));
  else rows.push(line(T.modelsAgreement(cmp.agreeCount, cmp.totalCount, cmp.majority ? stanceLabel(cmp.majority) : null, cmp.dissenters.map((m) => MODEL_NAMES[m]).join(', ')), { bold: true }));
  rows.push(...extraModelSheetRows(c.extraModels));
  return rows;
}

/** FL-17b: the newer models under the 5 (display only; not in the agreement count above). Nothing when the candidate carries none. */
function extraModelSheetRows(x: unknown): Row[] {
  if (x === undefined) return [];
  const r = readExtraModels(x);
  if (!r) return [line(labelledReason('More model reads', 'NOT_RUN'), { italic: true })];
  return [
    line(EXTRA_MODELS_HEADER + ' ' + EXTRA_MODELS_DISCLAIMER, { italic: true, bg: '#f5f5f5' }),
    ...extraModelRows(r).map(([label, text]) => kv(label, text)),
  ];
}

function fundRows(c: BuyCandidateInput): Row[] {
  const rows: Row[] = [sub('⑤ FUNDAMENTALS AND POSITIONING')];
  const f = c.fundamentals;
  if (f && f.unavailable) rows.push(kv('Fundamentals', sentence(f.unavailable)));
  else {
    const score = f ? f.ownScore : c.ownScore;
    const bandTxt = f && f.band ? f.band : bandLabel(c.ownBand);
    rows.push(kv('Fundamentals', fmtScore(score) != null ? 'Score ' + fmtScore(score) + '/100' + (bandTxt ? ' (' + bandTxt + ')' : '') : sentence('FIELD_MISSING')));
  }
  const p = c.positioning;
  if (!p) rows.push(kv('Positioning', sentence('NOT_RUN')));
  else if (p.unavailable) rows.push(kv('Positioning', sentence(p.unavailable)));
  else {
    rows.push(kv('Institutional holders', p.institutionalHolders != null ? String(p.institutionalHolders) : sentence('FIELD_MISSING')));
    rows.push(kv('Dark-pool share', orReason(fmtPlainPct(p.darkPoolPct))));
    rows.push(kv('Short interest', orReason(fmtPlainPct(p.shortInterestPct))));
  }
  return rows;
}

function oppRows(c: BuyCandidateInput, ctx: Ctx): Row[] {
  const rows: Row[] = [sub('⑥ OPPORTUNITY COST — against what you already hold')];
  const items = c.opportunityCost.map((s) => ctx.clean(s, '', c.ticker + ' opportunity cost')).filter((s) => s !== '');
  if (!items.length) rows.push(line(labelledReason('Comparison with your holdings', 'NOT_RUN')));
  else items.forEach((s) => rows.push(line('• ' + s)));
  return rows;
}

function healthRowsFor(c: BuyCandidateInput, ctx: Ctx): Row[] {
  const rows: Row[] = [sub('⑦ DATA HEALTH')];
  const lines = c.dataHealth.map((s) => ctx.clean(s, sentence('SECTION_UNAVAILABLE'), c.ticker + ' data health')).filter((s) => s !== '');
  if (!lines.length) rows.push(line('No data issues.'));
  else lines.forEach((t, k) => rows.push(line(t, k === 0 ? { bold: true } : {})));
  if (c.status !== 'failed' && c.note) rows.push(line(ctx.clean(c.note, sentence('SECTION_UNAVAILABLE'), c.ticker + ' note'), { italic: true }));
  return rows;
}

function tier1Section(c: BuyCandidateInput, i: number, ctx: Ctx): Row[] {
  const rows: Row[] = [{ cells: ['═══ ' + c.ticker + ' ═══'], mergeFrom: 1, bg: '#1b5e20', color: '#ffffff', bold: true, size: 13, height: 28, anchor: 'C' + i }];
  if (c.addToPosition) rows.push(line(T.heldBanner, { bg: '#fff8e1', bold: true }));
  if (c.bitcoinGroup && ctx.btcMembers) rows.push(line(T.btcDisclosure(ctx.btcMembers), { italic: true, bg: '#fff8e1' }));
  rows.push(...verdictRows(c, ctx));
  rows.push(...entryRows(c, ctx));
  rows.push(...riskRows(c, ctx));
  rows.push(...modelRows(c));
  rows.push(...fundRows(c));
  rows.push(...oppRows(c, ctx));
  rows.push(...healthRowsFor(c, ctx));
  rows.push({ cells: [T.aiPointerCandidate(0)], mergeFrom: 1, height: 21, italic: true, late: { col: 1, fn: (a) => T.aiPointerCandidate(a['AI'] ?? 0) } });
  return rows;
}

function tier2Section(c: BuyCandidateInput, i: number, ctx: Ctx): Row[] {
  const rows: Row[] = [{ cells: ['─── ' + c.ticker + ' ───'], mergeFrom: 1, bg: '#f9a825', color: '#000000', bold: true, size: 12, height: 26, anchor: 'C' + i }];
  if (c.addToPosition) rows.push(line(T.heldShort, { bg: '#fff8e1' }));
  if (c.bitcoinGroup && ctx.btcMembers) rows.push(line(T.btcDisclosure(ctx.btcMembers), { italic: true, bg: '#fff8e1' }));
  const v = verdictOf(c, ctx);
  rows.push(kv('Verdict', v.text + (v.ok ? ' — conviction ' + convText(c) : ''), { bg: '#fff9c4', bold: true }));
  rows.push(kv('Why it is not Tier 1', T.tier2Why(ctx.t1Min)));
  const zone = zoneText(c), tm = timingLabel(c.timing), rg = regimeShort(c.regime);
  rows.push(kv('Entry zone and timing', (zone ?? sentence('FIELD_MISSING')) + (tm ? '  ·  ' + tm : '') + (rg ? '  ·  ' + rg : '')));
  const stop = fmtUsd(c.stop), r1 = num(c.rrToT1);
  rows.push(kv('Initial stop and reward to risk', (stop ?? sentence('FIELD_MISSING')) + (r1 != null ? '  ·  target 1: ' + T.rr(r1) : '')));
  const cmp = readComparison(c.comparison);
  if (cmp) rows.push(kv('Models', T.modelsAgreement(cmp.agreeCount, cmp.totalCount, cmp.majority ? stanceLabel(cmp.majority) : null, cmp.dissenters.map((m) => MODEL_NAMES[m]).join(', '))));
  let promo = c.promotion ? ctx.clean(c.promotion, T.promotionFallback, c.ticker + ' promotion') : '';
  if (!promo) { ctx.log('buy sheet: ' + c.ticker + ' is Tier 2 but has no promotion condition; using the generic sentence'); promo = T.promotionFallback; }
  rows.push(kv('To become actionable', promo, { bold: true, bg: '#fffde7' }));
  const issues = c.dataHealth.slice(1).map((s) => ctx.clean(s, '', c.ticker + ' data health')).filter((s) => s !== '' && s !== 'No data issues.');
  issues.forEach((s) => rows.push(line(s, { italic: true })));
  return rows;
}

function tier3Row(c: BuyCandidateInput, i: number, ctx: Ctx): Row[] {
  const v = verdictOf(c, ctx);
  const tm = timingLabel(c.timing);
  let text = v.text;
  if (v.ok) text += (tm ? '  ·  ' + tm : '') + '  ·  conviction ' + convText(c);
  if (c.addToPosition) text += T.tagHeld;
  return [{ cells: ['#' + c.slot + ' ' + c.ticker, text], merges: [[2, 8]], labelCol: true, bg: v.ok ? undefined : v.bg, height: Math.max(21, estHeight(text, 2, 8)), anchor: 'C' + i }];
}

function degradedSection(heading: string, i: number | null): Row[] {
  const head: Row = { cells: [heading], mergeFrom: 1, bg: '#546e7a', color: '#ffffff', bold: true, size: 12, height: 26 };
  if (i != null) head.anchor = 'C' + i;
  return [head, kv('① VERDICT', 'No verdict. ' + sentence('SECTION_UNAVAILABLE'), { bg: '#eceff1', bold: true })];
}

function bannerRows(input: BuyReportInput, sorted: readonly BuyCandidateInput[], ctx: Ctx): Row[] {
  const ok = sorted.filter((c) => c.status === 'ok').length;
  const partial = sorted.filter((c) => c.status === 'degraded').length;
  const failed = sorted.filter((c) => c.status === 'failed').length;
  const rows: Row[] = [
    band(T.title, '#263238', 16),
    line(T.runLabel + stamp(ctx.runAt, ctx.tz), { bold: true }),
    { cells: [''], mergeFrom: 1, height: 21, late: { col: 1, fn: (a) => T.aiPointer(a['AI'] ?? 0) } },
    line(T.bannerCounts(sorted.length, ok, partial, failed), { bold: true }),
  ];
  if (input.seeded) rows.push(line(T.seeded, { bg: '#fff3e0' }));
  if (input.portfolioOk === false) rows.push(line(T.portfolioUnreadable, { bg: '#fff3e0' }));
  const items = dataQualityLines(input.dataHealth ?? []);
  if (!(items.length === 2 && items[1] === 'No data issues.')) rows.push(line(items.join('\n'), { bg: '#fff3e0' }));
  else rows.push(line(T.noRunIssues));
  rows.push(line(T.howToRead, { italic: true }));
  return rows;
}

function shortlistRows(sorted: readonly BuyCandidateInput[], input: BuyReportInput, ctx: Ctx): Row[] {
  const rows: Row[] = [band(T.shortlistHeader, '#188038', 12)];
  const t1 = sorted.map((c, i) => ({ c, i })).filter((x) => asTier(x.c.tier) === 1);
  if (!sorted.length) { rows.push(line(ctx.clean(input.emptyText, T.noCandidates, 'empty text'), { bold: true, bg: '#fff3e0' })); return rows; }
  if (!t1.length) { rows.push(line(ctx.clean(input.emptyText, T.nothingActionable, 'empty text'), { bold: true, bg: '#fff3e0' })); return rows; }
  rows.push(line(T.shortlistIntro, { italic: true }));
  for (const { c, i } of t1) {
    const v = verdictOf(c, ctx);
    const zone = zoneText(c);
    const text = v.text + ' — conviction ' + convText(c) + '. Entry zone ' + (zone ?? '—') + '.' + (c.addToPosition ? T.tagHeld : '');
    rows.push({
      cells: ['#' + c.slot + ' ' + c.ticker, text, '', '', '', '', '', '', ''], merges: [[2, 8]], labelCol: true, bg: v.bg,
      height: Math.max(21, estHeight(text, 2, 8)), late: { col: 9, fn: (a) => 'Go to row ' + (a['C' + i] ?? 0) },
    });
  }
  return rows;
}

function rankingRows(sorted: readonly BuyCandidateInput[], ctx: Ctx): Row[] {
  const rows: Row[] = [band(T.rankingHeader, '#1565c0', 12), line(T.rankingNote, { italic: true }), grid([...T.rankingColumns], { bold: true, bg: '#eceff1', merges: [[6, 7]] })];
  rows[0]!.anchor = 'R';
  const time = new Date(ctx.runAt.getTime()).toLocaleTimeString('en-US', { timeZone: ctx.tz }); // legacy: toLocaleTimeString() per row (:448)
  sorted.forEach((c, i) => {
    const v = verdictOf(c, ctx);
    const fund = fmtScore(c.ownScore);
    const fundTxt = fund != null ? fund + (bandLabel(c.ownBand) ? ' · ' + bandLabel(c.ownBand) : '') : '—';
    const tm = timingLabel(c.timing);
    const ts = fmtScore(c.techScore ?? null);
    const timingTxt = tm ? tm + (ts != null ? ' · ' + ts + '/100' : '') : '—';
    let verdict = v.text;
    if (c.addToPosition) verdict += T.tagHeld;
    if (c.bitcoinGroup && ctx.btcMembers) verdict += T.tagGroup;
    const base = c.status === 'failed' ? '#fdecea' : !v.ok ? '#fff3e0' : (i % 2 === 0 ? '#eaf2f8' : '#ffffff');
    rows.push({
      cells: ['#' + c.slot + ' ' + c.ticker, convText(c), fundTxt, timingTxt, zoneText(c) ?? '—', verdict, '', time, ''],
      merges: [[6, 7]], bg: base, ...(v.ok ? { cellBg: { 6: v.bg } } : {}),
      height: Math.max(21, estHeight(verdict, 6, 7)), labelCol: true,
      late: { col: 9, fn: (a) => 'Go to row ' + (a['C' + i] ?? 0) },
    });
  });
  return rows;
}

function changedRows(sorted: readonly BuyCandidateInput[], ctx: Ctx): Row[] {
  const rows: Row[] = [band(T.changedHeader, '#e65100', 12)];
  const ch = sorted.filter((c) => c.change != null);
  if (!ch.length) rows.push(line(T.noChanges));
  for (const c of ch) {
    const g = c.change!;
    rows.push(kv(c.ticker, T.changeLine(ctx.clean(g.from, '—', c.ticker + ' prior verdict'), ctx.clean(g.to, '—', c.ticker + ' new verdict'), fmtScore(g.fromConviction), fmtScore(c.conviction)), { bg: '#fff3e0' }));
  }
  rows.push(line(T.changeBaselineNote, { italic: true, color: '#666666' }));
  return rows;
}

/** Options sentiment A-8 / A-7: the shadow lines and the stocks without a read; empty without any line. */
function optionsReadsRows(input: BuyReportInput, ctx: Ctx): Row[] {
  const o = input.optionsReads;
  if (!o || !o.lines.length) return [];
  const rows: Row[] = [band(T.optionsReadsHeader(o.applied), '#4a148c', 12)];
  if (!o.applied) rows.push(line(T.optionsReadsNote, { italic: true, color: '#666666' }));
  for (const l of o.lines) rows.push(line(ctx.clean(l, '—', 'options read line')));
  if (o.missing.length) rows.push(line(T.optionsReadsMissing(o.missing.join(', ')), { italic: true }));
  return rows;
}

function bitcoinRows(g: BitcoinGroupInput | null | undefined, sorted: readonly BuyCandidateInput[], ctx: Ctx): Row[] {
  if (!g || !g.members.length) return [];
  const members = g.members;
  const rows: Row[] = [band(T.btcHeader, '#f57c00', 12)];
  if (members.length >= 2) {
    rows.push(line(ctx.clean(g.substitutesText, T.btcDisclosure(members.join(', ')), 'bitcoin substitutes'), { bold: true, bg: '#fff8e1' }));
    rows.push(line(T.btcOneSlot, { italic: true }));
  } else rows.push(line(T.btcSingle(members[0] as string)));
  rows.push(kv('Candidates in this group', members.join(', ')));
  rows.push(grid([...T.btcColumns], { bold: true, bg: '#eceff1' }));
  for (const m of members) {
    const c = sorted.find((x) => x.ticker === m);
    rows.push(grid([m, c ? '#' + c.slot : '—', c ? convText(c) : '—', c ? (zoneText(c) ?? '—') : '—', c ? orReason(fmtUsd(c.stop), 'FIELD_MISSING') : '—']));
  }
  const st = g.sharedThesis;
  if (!st) rows.push(line(T.btcNoSharedThesis, { italic: true }));
  else {
    rows.push(kv('Shared read from', ctx.clean(st.anchorSeries, '—', 'bitcoin anchor')));
    rows.push(kv('Regime', ctx.clean(st.regime, sentence('FIELD_MISSING'), 'bitcoin regime')));
    rows.push(kv('Trend', st.trend ? ctx.clean(st.trend, sentence('FIELD_MISSING'), 'bitcoin trend') + (st.trendMaturity ? ', ' + ctx.clean(st.trendMaturity, '', 'bitcoin maturity') : '') : sentence('FIELD_MISSING')));
    rows.push(kv('RSI / StochRSI', orReason(fmtNum(st.rsi)) + ' / ' + orReason(fmtNum(st.stochRsi))));
    rows.push(kv('Chart pattern', ctx.clean(st.pattern, sentence('FIELD_MISSING'), 'bitcoin pattern')));
    rows.push(kv('Momentum', ctx.clean(st.momentum, sentence('FIELD_MISSING'), 'bitcoin momentum')));
    rows.push(kv('Technical thesis', ctx.clean(st.thesis, sentence('FIELD_MISSING'), 'bitcoin thesis'), { bold: true }));
  }
  const d = g.differentiators;
  if (!d || !d.length) rows.push(line(T.btcNoDifferentiators, { italic: true }));
  else {
    rows.push(grid([...T.btcDiffColumns], { bold: true, bg: '#eceff1' }));
    for (const x of d) rows.push(grid([x.ticker, orReason(fmtPlainPct(x.expenseRatioPct ?? null), 'FIELD_MISSING'), x.avgDailyVolume != null && Number.isFinite(x.avgDailyVolume) ? x.avgDailyVolume.toLocaleString('en-US') : sentence('FIELD_MISSING'), orReason(fmtPlainPct(x.premiumDiscountPct ?? null), 'FIELD_MISSING')]));
  }
  return rows;
}

function footerRows(input: BuyReportInput, ctx: Ctx): Row[] {
  const rows: Row[] = [band(T.footerHeader, '#546e7a', 12)];
  rows.push(line(T.rankKey));
  rows.push(line(T.tierRule(ctx.t1Min, ctx.t2Min)));
  const caveats = input.methodologyCaveats && input.methodologyCaveats.length ? input.methodologyCaveats : [T.floorCaveat(OWN_BLOCK_FLOOR, OWN_FILTER_THRESHOLD)];
  for (const cv of caveats) rows.push(line(ctx.clean(cv, T.floorCaveat(OWN_BLOCK_FLOOR, OWN_FILTER_THRESHOLD), 'methodology caveat'), { bold: true }));
  rows.push(line(T.sizingNote));
  rows.push(line(T.longOnly));
  rows.push(line(T.historyNote));
  rows.push(line(T.aiNote));
  return rows;
}

// ───────────────────────── rendering ─────────────────────────

function render(sh: ReportSheet, rows: Row[], startRow: number): void {
  const matrix = rows.map((r) => { const c = r.cells.slice(0, NCOLS); while (c.length < NCOLS) c.push(''); return c; });
  sh.getRange(startRow, 1, rows.length, NCOLS).setValues(matrix);
  rows.forEach((r, i) => {
    const row = startRow + i;
    if (!r.cells.length) return;
    const full = sh.getRange(row, 1, 1, NCOLS);
    const spans: Array<readonly [number, number]> = [];
    if (r.mergeFrom) spans.push([r.mergeFrom, NCOLS]);
    if (r.merges) spans.push(...r.merges);
    for (const [from, to] of spans) if (to > from) sh.getRange(row, from, 1, to - from + 1).merge();
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
    for (const [from, to] of spans) if (to > from) sh.getRange(row, from, 1, to - from + 1).setWrap(true).setVerticalAlignment('top');
    if (r.height) sh.setRowHeight(row, r.height);
  });
}

// ───────────────────────── the nightly build ─────────────────────────

/** The nightly build: whole tab rebuilt, AI section back to its placeholder. */
export function buildBuySheet(ss: ReportWorkbook, input: BuyReportInput, deps: BuySheetDeps = {}): BuySheetResult {
  const log = deps.log ?? ((): void => {});
  const tz = deps.timeZone ?? REPORT_TIME_ZONE;
  const degraded: Array<{ name: string; reason: ReasonCode }> = [];
  const t1Min = input.tiers ? input.tiers.tier1Min : DEFAULT_TIER1_MIN;
  const t2Min = input.tiers ? input.tiers.tier2Min : DEFAULT_TIER2_MIN;
  const members = input.bitcoin && input.bitcoin.members.length >= 2 ? input.bitcoin.members.join(', ') : '';

  const clean = (text: unknown, fallback: string, where: string): string => {
    const t = text == null ? '' : String(text);
    if (t === '') return fallback;
    const leaks = findReportLeaks(t);
    if (leaks.length) { log('buy sheet: text for ' + where + ' was replaced because the leak scan flagged it: ' + leaks.join('; ')); return fallback; }
    return t;
  };
  const ctx: Ctx = { runAt: input.runAt, tz, log, clean, t1Min, t2Min, btcMembers: members, legacyExpiry: deps.legacyExpiryText === true };

  // Report order is the pipeline's rank (BUY_NOW first, conviction descending, entry confidence, ticker). Rendered as given.
  const sorted = input.candidates.map((c, i) => ({ c, i })).sort((a, b) => (a.c.rank - b.c.rank) || (a.i - b.i)).map((x) => x.c);

  const safe = (name: string, heading: string, i: number | null, fn: () => Row[]): Row[] => {
    try { return fn(); } catch (e) {
      log('buy sheet: section "' + name + '" failed: ' + String((e as Error)?.stack ?? e));
      degraded.push({ name, reason: 'SECTION_UNAVAILABLE' });
      return i == null ? [band(heading, '#546e7a', 12), line(sentence('SECTION_UNAVAILABLE'))] : degradedSection(heading, i);
    }
  };

  const sections: Row[][] = [];
  sections.push(safe('Banner', T.title, null, () => bannerRows(input, sorted, ctx)));
  if (input.marketOptionsLine) sections.push([line(ctx.clean(input.marketOptionsLine, '—', 'market options line'), { italic: true, color: '#4a148c' })]);
  if (input.washoutLines && input.washoutLines.length) sections.push(input.washoutLines.map((w) => line(ctx.clean(w, '—', 'washout line'), { bold: true, color: '#1b5e20' })));
  if (input.eventCheck && input.eventCheck.lines.length) {
    sections.push([band(ctx.clean(input.eventCheck.heading, '—', 'event check heading'), '#e65100', 12), ...input.eventCheck.lines.map((w) => line(ctx.clean(w, '—', 'event check line'), { color: '#bf360c' }))]);
  }
  sections.push(safe('Shortlist', T.shortlistHeader, null, () => shortlistRows(sorted, input, ctx)));
  sections.push(safe('Full ranking', T.rankingHeader, null, () => rankingRows(sorted, ctx)));
  sections.push(safe('Changed since last run', T.changedHeader, null, () => changedRows(sorted, ctx)));
  const optReads = safe('Options reads', T.optionsReadsHeader(!!input.optionsReads?.applied), null, () => optionsReadsRows(input, ctx));
  if (optReads.length) sections.push(optReads);
  const btc = safe('Bitcoin complex', T.btcHeader, null, () => bitcoinRows(input.bitcoin, sorted, ctx));
  if (btc.length) sections.push(btc);

  const idx = sorted.map((c, i) => ({ c, i }));
  const tierList = (t: BuyTier) => idx.filter((x) => asTier(x.c.tier) === t);

  const t1 = tierList(1);
  sections.push([band(T.tier1Header(t1Min), '#1b5e20', 13)]);
  if (!t1.length) sections.push([line(T.tier1None)]);
  for (const { c, i } of t1) sections.push(safe(c.ticker, '═══ ' + c.ticker + ' ═══', i, () => tier1Section(c, i, ctx)));

  const t2 = tierList(2);
  sections.push([band(T.tier2Header(t1Min, t2Min), '#f9a825', 13)]);
  if (!t2.length) sections.push([line(T.tier2None)]);
  for (const { c, i } of t2) sections.push(safe(c.ticker, '─── ' + c.ticker + ' ───', i, () => tier2Section(c, i, ctx)));

  const t3 = tierList(3);
  const t3rows: Row[] = [band(T.tier3Header(t2Min), '#607d8b', 13)];
  if (!t3.length) t3rows.push(line(T.tier3None));
  for (const { c, i } of t3) t3rows.push(...safe(c.ticker, '#' + c.slot + ' ' + c.ticker, i, () => tier3Row(c, i, ctx)));
  sections.push(t3rows);

  sections.push(safe('Methodology', T.footerHeader, null, () => footerRows(input, ctx)));
  sections.push([
    { cells: [AI_ANCHOR], mergeFrom: 1, bg: '#6a1b9a', color: '#ffffff', bold: true, size: 13, height: 28, anchor: 'AI' },
    { cells: [AI_PLACEHOLDER], mergeFrom: 1, height: 21, italic: true },
  ]);

  const rows: Row[] = [];
  sections.forEach((s, i) => { if (i > 0) rows.push(blank()); rows.push(...s); });
  const anchors: Anchors = {};
  rows.forEach((r, i) => { if (r.anchor) anchors[r.anchor] = i + 1; });
  rows.forEach((r) => { if (r.late) r.cells[r.late.col - 1] = r.late.fn(anchors); });

  const sh = getOrCreate(ss, BUY_SHEET_TAB);
  sh.clearContents();
  sh.clearFormats();
  sh.setTabColor(BUY_SHEET_TAB_COLOR);
  WIDTHS.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  render(sh, rows, 1);
  sh.setFrozenRows(1);
  sh.activate();
  return {
    written: true, tab: BUY_SHEET_TAB, rowCount: rows.length, anchors, order: sorted.map((c) => c.ticker),
    tiers: { 1: t1.map((x) => x.c.ticker), 2: t2.map((x) => x.c.ticker), 3: t3.map((x) => x.c.ticker) }, degraded,
  };
}

// ───────────────────────── the manual AI run ─────────────────────────

export interface BuyAiWriteResult {
  readonly written: boolean;
  /** Report-safe sentence when nothing was written; null on success. */
  readonly message: string | null;
  readonly anchorRow: number | null;
  readonly droppedLines: number;
}

/**
 * Replaces the AI SUMMARIES section in place. Never creates a tab. Idempotent. Every row written is merged across
 * the full width, so a leftover merge from the previous AI run is always the same row-wide merge (F-R2: the backend
 * has no unmerge op for a partial clear).
 */
export function writeBuyAiSummaries(ss: ReportWorkbook, ai: BuyAiSummariesInput, deps: BuySheetDeps = {}): BuyAiWriteResult {
  const log = deps.log ?? ((): void => {});
  const tz = deps.timeZone ?? REPORT_TIME_ZONE;
  const sh = ss.getSheetByName(BUY_SHEET_TAB);
  if (!sh) { log('buy sheet AI: the Buy report tab does not exist; nothing written'); return { written: false, message: T.aiRunNightlyFirst, anchorRow: null, droppedLines: 0 }; }
  const anchorRows: number[] = [];
  let lastRow = 0;
  try {
    lastRow = sh.getLastRow();
    if (lastRow > 0) {
      const colA = sh.getRange(1, 1, lastRow, 1).getValues();
      colA.forEach((r, i) => { if (String(r[0] ?? '') === AI_ANCHOR) anchorRows.push(i + 1); });
    }
  } catch (e) {
    log('buy sheet AI: could not read the Buy report tab: ' + String((e as Error)?.stack ?? e));
    return { written: false, message: labelledReason('AI summaries', 'SHEET_UNREADABLE'), anchorRow: null, droppedLines: 0 };
  }
  if (anchorRows.length === 0) { log('buy sheet AI: anchor row not found'); return { written: false, message: T.aiAnchorMissing, anchorRow: null, droppedLines: 0 }; }
  if (anchorRows.length > 1) { log('buy sheet AI: ' + anchorRows.length + ' anchor rows found; refusing to guess'); return { written: false, message: T.aiAnchorDuplicate, anchorRow: null, droppedLines: 0 }; }
  const anchor = anchorRows[0] as number;

  let dropped = 0;
  const rows: Row[] = [];
  const full = (text: string, o: Partial<Row> = {}): Row => ({ cells: [text], mergeFrom: 1, height: estHeight(text, 1), ...o });
  const opusLabel = ai.opusMode === 'OFF' ? 'off' : ai.opusMode;
  rows.push(full(T.aiHeaderStatus(stamp(ai.ranAt, tz), ai.geminiUsed, opusLabel, ai.effort ?? 'not set'), { italic: true }));

  const coveredSet = new Set(ai.entries.map((e) => e.ticker.toUpperCase()));
  const uncovered = ai.candidates.filter((c) => !coveredSet.has(c.ticker.toUpperCase())).map((c) => c.ticker + ' (Tier ' + c.tier + ')');
  rows.push(full(T.aiScope(ai.entries.length, Math.max(ai.candidates.length, ai.entries.length), ai.entries.map((e) => e.ticker).join(', '), uncovered.join(', ')), { bold: true }));

  if (!ai.entries.length) rows.push(full(labelledReason('AI review', 'AI_REVIEW_UNAVAILABLE')));
  for (const e of ai.entries) {
    const tier = ai.candidates.find((c) => c.ticker.toUpperCase() === e.ticker.toUpperCase());
    rows.push(full('▸ ' + e.ticker + (tier ? ' (Tier ' + tier.tier + ')' : ''), { bold: true, bg: '#f3e5f5', height: 24 }));
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
  if (dropped) log('buy sheet AI: ' + dropped + ' narrative line(s) were dropped because the leak scan flagged them');

  const oldRows = lastRow - anchor;
  if (oldRows > 0) {
    const region = sh.getRange(anchor + 1, 1, oldRows, NCOLS);
    region.clearContent();
    region.setBackground('#ffffff').setFontColor('#000000').setFontWeight('normal').setFontStyle('normal').setFontSize(10);
    for (let r = anchor + 1; r <= lastRow; r++) sh.setRowHeight(r, 21);
  }
  render(sh, rows, anchor + 1);
  return { written: true, message: null, anchorRow: anchor, droppedLines: dropped };
}
