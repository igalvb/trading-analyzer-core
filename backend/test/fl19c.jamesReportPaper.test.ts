/**
 * FL-19c (James's models, phase 1): the report pages "🪜 James — LILO v2" and "💰 James — Profit-Taking", their rows in
 * 🧮 All Models, their Bottom Line lines (display only, never in the Buy / Exit report rows), and the paper accounts
 * "James — ..." (shares, group J), which join with the G8 join-night QQQ yardstick, log in the paper tabs and leave
 * every other account unchanged.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildJamesReads, buildJamesLayersRead, formatLiloV2Page, formatProfitTakingPage, jamesAllModelsRows, jamesBottomLines, readJamesReads, nextSellStep, LILO_V2_PAGE, PT_PAGE, type JamesLayersRead } from '../src/analysis/jamesPages.ts';
import { allModelsRows, MODEL_SIMULATION } from '../src/analysis/reportPages.ts';
import { buildExtraModelsReport, readExtraModels, extraModelRows } from '../src/analysis/extraModels.ts';
import { reportTabOrder } from '../src/analyzeReport.ts';
import { MODEL_TABS } from '../src/analysis/runTicker.ts';
import { buildBottomLineSummary, bottomLineTabName } from '../src/reports/bottomLine/summarySheet.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { layerPrices, layersAt, DEFAULT_LAYER_OPTIONS } from '../src/analysis/models/liloLayers.ts';
import { newPaperState, paperDay, standings, accountIds, PAPER_CASH, type PaperDayInput } from '../src/paper/paperTrading.ts';
import { PAPER_OWNER_LIST, PAPER_RESEARCH_14, LAB_SETUPS, LAB_LABEL, JAMES_IDS, JAMES_LILO_V2_ID, JAMES_PT_LIST14_ID, JAMES_GROUP, labHeld } from '../src/paper/paperLab.ts';
import { bagsOf } from '../src/paper/paperReport.ts';
import { valuesRows, logRows, readsRows, stockNight, READS_HEADER, appendNight } from '../src/paper/paperLog.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import type { EngineRead, ExitReadResult } from '../src/backtest/engineRun.ts';
import type { PriceSeries } from '../src/backtest/data.ts';

const TZ = 'America/New_York';

/** Dates (weekdays) ending on `last`. */
function datesTo(last: string, n: number): string[] {
  const out: string[] = []; const d = new Date(last + 'T12:00:00Z');
  while (out.length < n) { if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}
/** Falls for 300 bars, then rises: one 200-day up-cross, then the price climbs through the layers. */
const D = datesTo('2026-11-04', 600);
const CLOSES = D.map((_, i) => (i < 300 ? 100 - i * 0.15 : 55 + (i - 300) * 0.4));
const ser = (t: string, closes = CLOSES, highs = closes): PriceSeries => ({ ticker: t, dates: D, opens: closes, highs, lows: closes, closes, volumes: closes.map(() => 1e6), splits: [] });

describe('FL-19c — the James report pages', () => {
  const bars = { dates: D, closes: CLOSES, highs: CLOSES, lows: CLOSES };
  const j = buildJamesReads(bars, '10y', TZ);

  test('the LILO v2 page: today, the anchor and the estimated u, the 11 layers with today marked, tonight\'s orders, the stop, how it differs, the history', () => {
    assert.equal(j.liloV2.status, 'ok');
    const p = formatLiloV2Page('TEST', j.liloV2);
    assert.ok(p.startsWith('── TEST — James — LILO v2 (the original layers) ──'));
    for (const s of ['1. TODAY: IN THE', '2. THE ANCHOR', 'estimated: the original indicator\'s unit is not public', 'Built on 10 years of daily bars.', '3. THE 11 LAYERS', '◀ today',
      '4. ORDERS IT WOULD HAVE TONIGHT', 'Snipe buys', '5. STOP', '6. HOW IT DIFFERS FROM 🪜 LILO MODEL', '7. HISTORY', MODEL_SIMULATION.LILO_V2!.history.split(' (')[0]!, 'Shown for information only']) assert.ok(p.includes(s), s);
    for (let k = 0; k <= 10; k++) assert.ok(p.includes('  Layer ' + k + ': $' + j.liloV2.levels[k]!.toFixed(2)), 'layer ' + k);
  });

  test('no anchor, no data, above layer 10, and the 2-year fallback say so', () => {
    const flat = buildJamesLayersRead({ dates: D.slice(0, 150), closes: CLOSES.slice(0, 150), highs: CLOSES.slice(0, 150), lows: CLOSES.slice(0, 150) }, LILO_V2_PAGE.layers, '10y');
    assert.equal(flat.status, 'noAnchor');
    assert.ok(formatLiloV2Page('T', flat).includes('1. TODAY: NO ANCHOR'));
    assert.ok(formatProfitTakingPage('T', flat).includes('so there are no sell layers today'));
    const none = buildJamesLayersRead(null, LILO_V2_PAGE.layers, '2y');
    assert.equal(none.status, 'noData');
    assert.ok(formatLiloV2Page('T', none).includes('NOT AVAILABLE') && formatLiloV2Page('T', none).includes('the 10-year fetch failed'));
    const high: JamesLayersRead = { ...j.liloV2, close: j.liloV2.levels[10]! * 1.5, band: 10 };
    assert.ok(formatLiloV2Page('T', high).includes('IN THE SELL ZONE (ABOVE LAYER 10)'));
    assert.deepEqual(jamesBottomLines({ liloV2: high, profitTaking: { ...j.profitTaking, close: 1e9 } })[1], ['💰 James — Profit-Taking', 'Above every sell step of schedule ' + PT_PAGE.schedule]);
  });

  test('the Profit-Taking page and the next sell step use the G1 default layers and the chosen schedule', () => {
    const want = layersAt({ closes: CLOSES, highs: CLOSES, lows: CLOSES }, CLOSES.length - 1, DEFAULT_LAYER_OPTIONS)!;
    assert.deepEqual(j.profitTaking.levels, want.levels);
    const ns = nextSellStep(j.profitTaking);
    if (ns) assert.ok(ns.price > CLOSES.at(-1)!);
    const p = formatProfitTakingPage('TEST', j.profitTaking);
    for (const s of ['1. THE SELL LAYERS TODAY', '2. THE FIVE SCHEDULES', '3. WHICH SCHEDULE WAS CHOSEN', 'A20 — Incremental 20%', 'B10 — Fixed 10%', 'C — Staggered']) assert.ok(p.includes(s), s);
  });

  test('🧮 All Models: two James rows after LILO when the run built them (a "did not run" pair for null); none when absent', () => {
    const base = { decision: { finalConviction: 50 }, techPlan: null, fund: null, comparison: null, extra: null, lilo: null };
    assert.equal(allModelsRows(base).length, 13, 'unchanged without James');
    const rows = allModelsRows({ ...base, james: j });
    assert.deepEqual(rows.slice(-2).map((r) => r.model), ['James — LILO v2', 'James — Profit-Taking (layers 6-10)']);
    assert.equal(rows.at(-3)!.key, 'LILO');
    assert.equal(rows.at(-2)!.history, MODEL_SIMULATION.LILO_V2!.history);
    assert.ok(['In buy zone', 'In sell zone'].includes(rows.at(-2)!.read));
    assert.deepEqual(allModelsRows({ ...base, james: null }).slice(-2).map((r) => r.read), ['Not available', 'Not available']);
    assert.deepEqual(jamesAllModelsRows(null).map((r) => r.key), ['LILO_V2', 'PROFIT_TAKING']);
  });

  test('the read travels with the run\'s ExtraModelsReport; the Bottom Line prints the two lines right after the LILO line; the Buy / Exit rows never show them', async () => {
    const ex = { ...buildExtraModelsReport('TEST', { dates: D.map((d) => new Date(d + 'T20:00:00Z')), opens: CLOSES, highs: CLOSES, lows: CLOSES, closes: CLOSES, volumes: CLOSES.map(() => 1e6) }, null, {}, TZ), james: j };
    const back = readExtraModels(JSON.parse(JSON.stringify(ex)))!;
    assert.deepEqual(back.james, j);
    assert.deepEqual(readJamesReads(JSON.parse(JSON.stringify(j))), j);
    assert.ok(!extraModelRows(back).some(([l]) => l.includes('James')) && !extraModelRows(back, { withEverything: true }).some(([l]) => l.includes('James')), 'decision 8: not in the Buy / Exit rows');
    const run = async (extra: unknown): Promise<string[][]> => {
      const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
      buildBottomLineSummary(wb, 'TEST', { score: 70, verdict: 'Good' }, { techScore: 60, timing: 'BUY_NOW', regime: 'TREND_UP', entryCount: 0, entryLow: 1, entryHigh: 2 } as never, { action: 'BUY', finalConviction: 70 } as never, null, null, {
        clock: { now: () => Date.UTC(2026, 9, 30, 15) }, timeZone: TZ, extraModels: extra,
      });
      return wb.getSheetByName(bottomLineTabName('TEST', false))!.grid().map((r) => r.map((v) => String(v ?? '')));
    };
    const g = await run(ex);
    const labels = g.map((r) => r[0]);
    const lilo = labels.indexOf('🪜 LILO Ladder');
    assert.deepEqual(labels.slice(lilo + 1, lilo + 3), ['🪜 James — LILO v2', '💰 James — Profit-Taking']);
    assert.ok(g[lilo + 1]![1]!.includes('anchor ') && g[lilo + 2]![1]!.length > 10);
    const without = await run({ ...ex, james: undefined });
    assert.equal(without.length, g.length - 2);
  });

  test('the PDF order and the run: the James pages come right after LILO', () => {
    const o = reportTabOrder();
    assert.deepEqual(o.slice(o.indexOf(MODEL_TABS.lilo), o.indexOf(MODEL_TABS.lilo) + 3), ['🪜 LILO Model', '🪜 James — LILO v2', '💰 James — Profit-Taking']);
    assert.ok(MODEL_TABS.liloV2.includes('James — ') && MODEL_TABS.profitTaking.includes('James — '));
  });
});

// ─────────────────────────────── the paper test ───────────────────────────────

const noExit = (t: string): ExitReadResult => ({ ticker: t, day: '', ok: true, actionClass: 'HOLD' as never, recommendation: 'HOLD', stopBreached: false, thesisInvalidated: false, hitT1: false, hitT2: false, t1: null, t2: null, stopLevel: null, close: null });
const read = (ticker: string, dirs: Record<string, string>): EngineRead => ({
  ticker, day: '', ok: true, finalConviction: 50, action: null, timing: 'WAIT_PULLBACK', regime: 'CHOP', entryPrice: 100, entryHigh: 101, entryConfidencePct: 50, stop: 90,
  ownScore: 60, blocked: false, verdict: 'MAJORITY', directions: dirs, close: 100,
});
const PDAYS = D.slice(-6); // 2026-10-28 .. 2026-11-04

describe('FL-19c — the James paper accounts', () => {
  // On 11-02 every stock's high reaches the next G1 default sell layer above the price (the Profit-Taking accounts sell
  // a step; the layers under the cost are skipped) and its low its LILO v2 snipe layer (James — LILO v2 buys).
  const pt = layersAt({ closes: CLOSES, highs: CLOSES, lows: CLOSES }, D.indexOf('2026-10-30'), DEFAULT_LAYER_OPTIONS)!.levels;
  const v2 = layersAt({ closes: CLOSES, highs: CLOSES, lows: CLOSES }, D.indexOf('2026-10-30'), LILO_V2_PAGE.layers)!;
  const k = D.indexOf('2026-11-02');
  const nextSell = pt.slice(6).find((p) => p > CLOSES[k]!)!;
  const highs = CLOSES.map((c, i) => (i === k ? nextSell + 1 : c));
  const lows = CLOSES.map((c) => c);
  const snipe = v2.levels.filter((p) => p < CLOSES[k - 1]!).at(-1)!;
  lows[k] = Math.min(lows[k]!, snipe - 0.01);
  const S = (t: string): PriceSeries => ({ ...ser(t, CLOSES, highs), lows });
  const series = new Map([...PAPER_OWNER_LIST, 'QQQ'].map((t) => [t, S(t)]));
  const input = (n: number, withLong = true): PaperDayInput => {
    const d = PDAYS[n]!, i = D.indexOf(d);
    return {
      day: d, reads: [], exitRead: noExit,
      bars: Object.fromEntries([...PAPER_OWNER_LIST, 'QQQ'].map((t) => [t, { open: CLOSES[i]!, close: CLOSES[i]! }])),
      lab: { reads: PAPER_OWNER_LIST.map((t) => read(t, t === 'NVDA' ? { turtle: 'bullish', schabacker: 'bullish' } : {})), series, ...(withLong ? { long: series } : {}) },
    };
  };

  test('they join on the first night (decisions only), are labelled "James — ", and trade from the next open; the other accounts are unchanged by them', () => {
    const s = newPaperState(['TSLA']);
    paperDay(s, input(0));
    assert.ok(s.lab!.liloV2 && s.lab!.james);
    for (const id of JAMES_IDS) { assert.ok(LAB_LABEL[id]!.startsWith('James — '), id); assert.ok(accountIds(s).includes(id), id); assert.deepEqual(s.joins![id], { day: PDAYS[0], qqqClose: CLOSES[D.indexOf(PDAYS[0]!)] }); }
    assert.equal(Object.keys(s.lab!.accounts).length, LAB_SETUPS.length + 1, 'the lab accounts are untouched');
    const t1 = paperDay(s, input(1));
    const list14 = t1.filter((x) => x.strategy === JAMES_PT_LIST14_ID && x.ticker !== 'QQQ');
    assert.deepEqual(list14.map((x) => x.ticker).sort(), [...PAPER_RESEARCH_14].sort(), 'the 14 bought equally at the first open');
    assert.ok(t1.some((x) => x.strategy === 'james.pt.combo' && x.ticker === 'NVDA' && x.side === 'BUY'), 'the combo entries');
    assert.ok(s.lab!.james!['james.pt.combo']!.pos.NVDA!.pt, 'the schedule frozen with the position');
    paperDay(s, input(2));
    const t3 = paperDay(s, input(3));
    const step = t3.find((x) => x.strategy === JAMES_PT_LIST14_ID && x.side === 'SELL' && x.ticker === 'NVDA')!;
    assert.match(step.why, /^profit taking: layer \d+ \$[\d.]+, 20% of current \(A20\)$/);
    assert.equal(step.price, nextSell); assert.ok(step.tax > 0, 'each step pays its own tax');
    assert.ok(t3.some((x) => x.strategy === JAMES_LILO_V2_ID && x.side === 'BUY' && x.why.startsWith('James — LILO v2 snipe L')), 'a snipe buy at a layer');
    // the same nights without James's accounts give the same trades for every other account
    const strip = (id: string): boolean => !id.startsWith('james.');
    const s2 = newPaperState(['TSLA']);
    const others: string[] = [];
    for (let n = 0; n < 4; n++) others.push(...paperDay(s2, input(n)).filter((x) => strip(x.strategy)).map((x) => JSON.stringify(x)));
    const s3 = newPaperState(['TSLA']);
    const mine: string[] = [];
    for (let n = 0; n < 4; n++) { mine.push(...paperDay(s3, input(n, false)).filter((x) => strip(x.strategy)).map((x) => JSON.stringify(x))); }
    assert.deepEqual(mine, others, 'the 10-year bars (James only) change nothing for the others');
  });

  test('an old saved state without them: they join tonight and are judged against "📊 QQQ since this account joined"', () => {
    const s = newPaperState(['TSLA']);
    paperDay(s, input(0)); paperDay(s, input(1));
    delete s.lab!.liloV2; delete s.lab!.james;
    for (const id of JAMES_IDS) delete s.joins![id];
    const saved = JSON.parse(JSON.stringify(s));
    paperDay(saved, input(2));
    for (const id of JAMES_IDS) assert.deepEqual(saved.joins[id], { day: PDAYS[2], qqqClose: CLOSES[D.indexOf(PDAYS[2]!)] }, id);
    paperDay(saved, input(3));
    const st = standings(saved);
    const james = st.filter((r) => r.name.startsWith('James — '));
    assert.equal(james.length, JAMES_IDS.length);
    assert.ok(james.every((r) => r.qqqSinceJoined != null && !r.bench));
    assert.ok(st.filter((r) => !r.name.startsWith('James — ') && !r.bench).every((r) => r.qqqSinceJoined == null), 'the others joined at the start');
    assert.ok(Math.abs(saved.marks.at(-1).values[JAMES_PT_LIST14_ID] - PAPER_CASH) < PAPER_CASH, 'marked');
  });

  test('logged in the paper tabs and the daily report: group J in the values and the bags, resting orders in the log, the layer in the reads', async () => {
    const s = newPaperState(['TSLA']);
    for (let n = 0; n < 3; n++) paperDay(s, input(n));
    const day = PDAYS[2]!;
    const v = valuesRows(s, day).filter((r) => r[2] === JAMES_GROUP);
    assert.deepEqual(v.map((r) => r[1]), JAMES_IDS.map((id) => LAB_LABEL[id]));
    const bags = bagsOf(s, (t) => CLOSES[D.indexOf(day)] ?? (t === 'QQQ' ? 1 : null));
    assert.deepEqual(bags.filter((b) => b.group === JAMES_GROUP).map((b) => b.id), JAMES_IDS);
    const nights = new Map(PAPER_OWNER_LIST.map((t) => [t, stockNight(day, null, series.get(t), series.get(t))]));
    const log = logRows(s, day, [], nights);
    assert.ok(log.some((r) => r[2] === LAB_LABEL[JAMES_LILO_V2_ID] && r[3] === 'RESTING ORDERS' && String(r[9]).startsWith('snipe buys L')));
    const reads = readsRows(day, nights);
    assert.equal(reads[0]!.length, READS_HEADER.length);
    assert.match(String(reads[0]!.at(-1)), /^anchor \d{4}-\d\d-\d\d, L0 \$[\d.]+, u \$[\d.]+, /);
    assert.ok(labHeld(s.lab!, JAMES_PT_LIST14_ID).length >= 14);
    // the reads tab's header gains the new column in place
    const store = new MemoryTabStore();
    await appendNight(store, 'R', READS_HEADER.slice(0, -1), '2026-10-01', [['2026-10-01']]);
    await appendNight(store, 'R', READS_HEADER, day, reads, true);
    assert.deepEqual((await store.read('R', READS_HEADER.length))![0], [...READS_HEADER]);
  });

  test('the layers of the paper account are the layers of the report page (same setup)', () => {
    assert.deepEqual(layerPrices(v2.L0, v2.u), v2.levels);
    assert.equal(LILO_V2_PAGE.layers.unit, 'U2');
  });
});
