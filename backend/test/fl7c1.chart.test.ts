/**
 * FL-7c1 (chart part): showPriceChartV7 against the oracle -- the tab it
 * writes (full call log and cells), the chart it builds (spec compared with
 * an independently written recorder), alerts and log lines -- plus the new
 * Chart.js HTML renderer (structure only; legacy has no HTML, F-C1).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { openBook, legacyBook, bars, type Rows, type LegacyChartStore } from './fl7c1Fixtures.ts';
import type { FetchedChart } from '../src/types/chart.ts';
import { showPriceChart, chartWorkbook, SpecChartBuilder, type ChartStore, type PriceChartResult } from '../src/ops/priceChart.ts';
import { renderPriceChartHtml, priceChartFileName } from '../src/ops/priceChartHtml.ts';

const ready = legacyFilesPresent();
const oracle = () => loadOracle();

const PLAN = { entryLow: 95, entryHigh: 99, entryCount: 3, stop: 90, t1: { price: 120 }, t2: { price: 140 }, regime: 'TREND_UP' };
const rec = (strike: number | string) => ({ found: true, contract: { strike } });
const dash = (t: string): Rows => ({ '📊 Analysis v7': [[`📊 ${t} — Full Analysis`]] });

interface Case {
  readonly name: string;
  readonly data: FetchedChart | null;
  readonly args: any;
  readonly initial?: Rows;
  readonly preload?: string[];
  /** Makes the entry-ladder function throw this, on both sides. */
  readonly ladderThrows?: unknown;
}

const CASES: Case[] = [
  { name: 'minimal', data: bars(260), args: { ticker: 'NVDA' } },
  { name: 'short', data: bars(60), args: { ticker: 'NVDA', techPlan: { regime: 'CHOP' } } },
  { name: 'mid (sma200 null)', data: bars(150), args: { ticker: 'AMD', techPlan: PLAN, decision: { action: 'BUY NOW' } } },
  { name: 'ladders', data: bars(260), args: { ticker: 'AMD', techPlan: PLAN, showLadder: true, decision: { action: '' } } },
  { name: 'no entry rungs', data: bars(260), args: { ticker: 'AMD', techPlan: { ...PLAN, entryCount: 0 }, showLadder: true } },
  { name: 'no exit rungs', data: bars(260), args: { ticker: 'AMD', techPlan: { ...PLAN, t1: null, t2: null }, showLadder: true } },
  { name: 'rung colour wrap', data: bars(260), args: { ticker: 'AMD', techPlan: { ...PLAN, entryCount: 11 }, showLadder: true } },
  { name: 'entry low only', data: bars(260), args: { ticker: 'AMD', techPlan: { entryLow: 95, stop: 90 } } },
  { name: 'empty plan', data: bars(260), args: { ticker: 'AMD', techPlan: {} } },
  { name: 'ladder flag, no plan', data: bars(260), args: { ticker: 'AMD', showLadder: true } },
  { name: 't1 without price + ladder', data: bars(260), args: { ticker: 'AMD', techPlan: { ...PLAN, t1: {} }, showLadder: true } },
  { name: 'rec call', data: bars(260), args: { ticker: 'AMD', techPlan: PLAN, recCall: rec(105) } },
  { name: 'rec call text strike', data: bars(260), args: { ticker: 'AMD', techPlan: PLAN, recCall: rec('abc') } },
  { name: 'rec call not found', data: bars(260), args: { ticker: 'AMD', recCall: { found: false, contract: { strike: 1 } } } },
  { name: 'flat prices', data: bars(260, () => 100), args: { ticker: 'AMD' } },
  { name: 'penny clamp', data: bars(260, (i) => (i % 2 ? 100 : 0.5)), args: { ticker: 'AMD' } },
  { name: 'fetch null', data: null, args: { ticker: 'ZZZ' } },
  { name: 'ladder throws', data: bars(260), args: { ticker: 'AMD', techPlan: PLAN, showLadder: true }, ladderThrows: new Error('ladder boom') },
  { name: 'ladder throws text', data: bars(260), args: { ticker: 'AMD', techPlan: PLAN, showLadder: true }, ladderThrows: 'plain' },
  { name: 'existing tab + prior chart', data: bars(260), args: { ticker: 'NVDA', techPlan: PLAN }, initial: { '📊 NVDA Chart': [['old', 'cells'], [1, 2, 3, 4]] } },
  { name: 'ticker from dashboard', data: bars(260), args: {}, initial: dash('AMD') },
  { name: 'dashboard header without match', data: bars(260), args: {}, initial: { '📊 Analysis v7': [['Analysis']] } },
  { name: 'dashboard tab missing', data: bars(260), args: {}, initial: {} },
  { name: 'dashboard tab not loaded (F-C6)', data: bars(260), args: {}, initial: dash('AMD'), preload: [] },
  { name: 'empty bars throws', data: { ...bars(2), dates: [], opens: [], highs: [], lows: [], closes: [], volumes: [] } as FetchedChart, args: { ticker: 'AMD' } },
  { name: 'no currentPrice throws', data: { ...bars(80), currentPrice: undefined } as unknown as FetchedChart, args: { ticker: 'AMD' } },
];

describe('FL-7c1 -- showPriceChartV7', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('tab, chart spec, alerts and logs equal legacy in every case', async () => {
    const o = oracle();
    const seen: Record<string, number> = {};
    const hit = (k: string) => { seen[k] = (seen[k] ?? 0) + 1; };
    for (const c of CASES) {
      const initial = c.initial ?? {};
      const Lb = await openBook(initial, c.preload ?? ['*']), Pb = await openBook(initial, c.preload ?? ['*']);
      const lStore: LegacyChartStore = new Map(), pStore: ChartStore = new Map();
      const prior = { type: 'line', ranges: [], numHeaders: 0, options: { prior: true }, position: null };
      if (initial['📊 NVDA Chart']) { lStore.set('📊 NVDA Chart', [structuredClone(prior)]); pStore.set('📊 NVDA Chart', [structuredClone(prior) as never]); }
      const lAl: string[] = [], pAl: string[] = [], lLog: string[] = [], pLog: string[] = [], lT: string[] = [], pT: string[] = [];
      const entry = (cf: unknown) => o.callNormalized('computeStockEntryLadderV7', cf) as never;
      const exit = (tp: unknown) => o.callNormalized('computeStockExitLadderV7', tp) as never;
      const over: Record<string, unknown> = {
        SpreadsheetApp: { getActiveSpreadsheet: () => legacyBook(Lb, lStore), getUi: () => ({ alert: (m: string) => lAl.push(m) }) },
        Logger: { log: (m: unknown) => lLog.push(String(m)) }, fetchYahooChart: (t: string) => { lT.push(t); return c.data; },
      };
      if (c.ladderThrows !== undefined) over.computeStockEntryLadderV7 = () => { throw c.ladderThrows; };
      let lErr = null as string | null, pErr = null as string | null;
      withOracleGlobals(over, () => {
        try { o.call('showPriceChartV7', c.args.ticker, c.args.techPlan, c.args.decision, c.args.showLadder, c.args.recCall); } catch (e: any) { lErr = e.message; }
      });
      let res: PriceChartResult | null = null;
      try {
        res = await showPriceChart({
          workbook: chartWorkbook(Pb, pStore), fetchChart: async (t) => { pT.push(t); return c.data; },
          entryLadder: c.ladderThrows !== undefined ? () => { throw c.ladderThrows; } : entry, exitLadder: exit,
          alert: (m) => { pAl.push(m); }, log: (m) => { pLog.push(m); }, dailyTickers: ['TSLA', 'MSTR'],
          legacyTabName: true, // phase 1: legacy's '📊 TICKER Chart' name in the oracle comparison
        }, c.args);
      } catch (e: any) { pErr = e.message; }

      assert.equal(pErr, lErr, c.name);
      assert.deepEqual(pAl, lAl, c.name);
      assert.deepEqual(pLog, lLog, c.name);
      assert.deepEqual(pT, lT, c.name);
      assert.deepEqual(Pb.getSheets().map((s) => s.getName()), Lb.getSheets().map((s) => s.getName()), c.name);
      for (const sh of Lb.getSheets()) {
        const ps = Pb.getSheetByName(sh.getName())!;
        assert.deepEqual(ps.calls, sh.calls, c.name + ' calls ' + sh.getName());
        assert.deepEqual(ps.grid(), sh.grid(), c.name + ' cells ' + sh.getName());
      }
      const lCharts = structuredClone([...lStore]); // the legacy side holds oracle-realm objects
      assert.deepEqual([...pStore], lCharts, c.name + ' charts');

      if (lErr) hit('threw');
      if (lAl.length) hit('alert');
      if (lLog.length) hit('log');
      if (initial['📊 NVDA Chart']) hit('existing');
      const spec = lCharts.map(([, v]) => v[0] as any).find((s) => s && !s.options.prior);
      if (spec) {
        const chartTab = Lb.getSheets().find((s) => s.getName().endsWith(' Chart'))!;
        const h = chartTab.grid()[0] as string[];
        for (const k of ['Entry', 'T1', 'Buy rung 1', 'Sell rung 1', 'Sell rung 2', 'Buy rung 10', 'Buy rung 11']) if (h.includes(k)) hit('hdr:' + k);
        if (h.some((x) => String(x).startsWith('Rec. Call'))) hit('reccall');
        const vw = spec.options.vAxis.viewWindow;
        if (vw.min === 0) hit('minClamp');
        if (Number.isNaN(vw.max)) hit('NaNaxis');
        hit(spec.ranges[0].numRows - 1 >= 126 ? 'rows126' : 'rowsShort');
        assert.ok(res && res.spec.options.title === spec.options.title);
        if (c.args.ticker === undefined) hit('tickerFromHeader:' + chartTab.getName());
      } else if (!lErr && !lAl.length) {
        assert.fail(c.name + ' produced nothing');
      }
    }
    // coverage guards: every branch above was really reached
    for (const k of ['threw', 'alert', 'log', 'existing', 'hdr:Entry', 'hdr:T1', 'hdr:Buy rung 1', 'hdr:Sell rung 1', 'hdr:Sell rung 2', 'hdr:Buy rung 10', 'hdr:Buy rung 11',
      'reccall', 'minClamp', 'NaNaxis', 'rows126', 'rowsShort', 'tickerFromHeader:📊 AMD Chart', 'tickerFromHeader:📊 TSLA Chart']) {
      assert.ok(seen[k] > 0, 'coverage: ' + k);
    }
  });

  test('port-only: default ticker without dailyTickers, builder isolation', async () => {
    const tickers: string[] = [];
    const base = { fetchChart: async (t: string) => { tickers.push(t); return null; }, entryLadder: () => [], exitLadder: () => [], alert: () => {}, log: () => {} };
    for (const dailyTickers of [undefined, [], ['NVDA']]) {
      await showPriceChart({ ...base, workbook: chartWorkbook(await openBook({}), new Map()), dailyTickers }, {});
    }
    assert.deepEqual(tickers, ['TSLA', 'TSLA', 'NVDA']); // legacy: dailyTickers[0] || 'TSLA'
    const b = new SpecChartBuilder().setOption('a', { x: 1 });
    const s1 = b.build();
    (s1.options.a as { x: number }).x = 2;
    assert.deepEqual(b.build().options.a, { x: 1 });
  });

  test('HTML renderer: structure, escaping, file name', async () => {
    const rows = [[new Date(Date.UTC(2026, 0, 2)), 10, 11, null, undefined, 9], [new Date(Date.UTC(2026, 0, 3)), 10.5, 11, 9, 8, 10.5]];
    const spec = {
      options: {
        title: 'X — $10.50   BUY',
        series: { 0: { color: '#111', lineWidth: 2 }, 1: { color: '#222', lineWidth: 1, lineDashStyle: [4, 2] }, 2: { color: '#333', lineWidth: 1 }, 3: { color: '#444', lineWidth: 1 }, 4: { color: '#000', lineWidth: 0, pointSize: 10, pointShape: 'diamond' } },
        vAxis: { viewWindow: { min: 5, max: 20 } },
      },
    };
    const label = 'Rec. Call ($</script><script>alert(1)</script>)';
    const html = renderPriceChartHtml({ ticker: 'X', headers: ['Date', 'Close', label, 'B', 'C', 'Today'], rows, spec, entryLabel: 'Entry ~$1 <b>' });
    assert.equal(html.split('</script>').length - 1, 2); // the CDN tag and ours; no label closes it
    const cfg = JSON.parse(html.slice(html.indexOf('const config = ') + 15, html.indexOf(';\nnew Chart')));
    assert.deepEqual(cfg.data.labels, ['2026-01-02', '2026-01-03']);
    assert.deepEqual(cfg.data.datasets.map((d: any) => d.label), ['Close', label, 'B', 'C', 'Today']);
    assert.deepEqual(cfg.data.datasets[0].data, [10, 10.5]);
    assert.deepEqual(cfg.data.datasets[3].data, [null, 8]);
    assert.deepEqual(cfg.data.datasets[1].borderDash, [4, 2]);
    assert.equal(cfg.data.datasets[4].pointStyle, 'rectRot');
    assert.equal(cfg.data.datasets[4].showLine, false);
    assert.equal(cfg.data.datasets[4].pointRadius, 5);
    assert.deepEqual([cfg.options.scales.y.min, cfg.options.scales.y.max], [5, 20]);
    assert.ok(html.includes('<p>Entry ~$1 &lt;b&gt;</p>'));
    assert.ok(html.includes('<title>X — $10.50   BUY</title>'));
    assert.equal(priceChartFileName('BRK.B'), 'BRK.B-chart.html');
    assert.equal(priceChartFileName('../a/b'), '.._a_b-chart.html');
    const lineSep = String.fromCharCode(0x2028);
    const sep = renderPriceChartHtml({ ticker: 'X', headers: ['Date', 'a' + lineSep + 'b'], rows: [[new Date(0), 1]], spec: { options: {} }, entryLabel: '' });
    assert.ok(sep.includes('\\u2028') && !sep.includes(lineSep));

    // end to end: a real showPriceChart result renders 126 points per series
    const o = oracle();
    const result = await showPriceChart({
      workbook: chartWorkbook(await openBook({}), new Map()), fetchChart: async () => bars(260),
      entryLadder: (c) => o.callNormalized('computeStockEntryLadderV7', c) as never, exitLadder: (t) => o.callNormalized('computeStockExitLadderV7', t) as never,
      alert: () => {}, log: () => {},
    }, { ticker: 'AMD', techPlan: PLAN, showLadder: true });
    const full = JSON.parse((() => { const h = renderPriceChartHtml(result!); return h.slice(h.indexOf('const config = ') + 15, h.indexOf(';\nnew Chart')); })());
    assert.deepEqual(full.data.datasets.map((d: any) => d.label), result!.headers.slice(1));
    assert.ok(full.data.datasets.every((d: any) => d.data.length === 126));
  });
});
