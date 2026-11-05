/**
 * GENERIC_PLAN P2: the constants that moved onto the profile follow PROFILE_JSON. This file runs in its own process
 * (node --test isolates files) and sets PROFILE_JSON to the EXAMPLE profile before importing anything, so every
 * module below sees a made-up user and no owner value.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';

process.env.PROFILE_JSON = JSON.stringify(EXAMPLE_PROFILE_INPUT);
delete process.env.PROFILE_FILE;

const core = [...EXAMPLE_PROFILE_INPUT.lists.core];

describe('P2 — constants read the profile (example profile)', async () => {
  const { activeProfile, activeProfileSource } = await import('../src/profile/active.ts');
  const lab = await import('../src/paper/paperLab.ts');
  const paper = await import('../src/paper/paperTrading.ts');
  const job = await import('../src/paper/paperJob.ts');
  const bag = await import('../src/research/portfolioCli.ts');
  const run = await import('../src/backtest/run.ts');
  const pairs = await import('../src/analysis/models/pairRotation.ts');
  const picker = await import('../src/jobs/automation/tickerRuns.ts');
  const ui = await import('../src/reports/options/ui.ts');
  const chart = await import('../src/ops/priceChart.ts');
  const tabs = await import('../src/reports/options/tabs.ts');
  const watch = await import('../src/sheets/readers/watchlist.ts');
  const prices = await import('../src/research/fetchPrices.ts');

  test('the run uses PROFILE_JSON', () => {
    assert.equal(activeProfileSource(), 'PROFILE_JSON');
    assert.equal(activeProfile().user.id, 'example');
  });
  test('lists: the list, the researched list (= the list) and nothing added', () => {
    assert.deepEqual(lab.PAPER_OWNER_LIST, core);
    assert.deepEqual(lab.PAPER_RESEARCH_14, core);
    assert.deepEqual(lab.PAPER_ADDED, []);
    assert.deepEqual(bag.OWNER_BAG, core);
    assert.deepEqual(run.TEST_A_UNIVERSE, core);
    assert.deepEqual(paper.PAPER_FIXED_UNIVERSE, core);
  });
  test('no pairs set = the pair model has none', () => {
    assert.deepEqual(pairs.PAIRS, []);
    assert.deepEqual(pairs.pairsOf('AAPL'), []);
  });
  test('dialogs and the default ticker come from the list', () => {
    assert.deepEqual(picker.TICKER_PICKER_CHOICES, [...core, 'OTHER']);
    assert.deepEqual(ui.RUN_DIALOG_CHOICES, [...core, 'OTHER']);
    assert.deepEqual(ui.CALL_DIALOG_CHOICES, [...core, 'OTHER']);
    assert.equal(chart.CHART_DEFAULT_TICKER, 'AAPL');
    assert.equal(tabs.DEFAULT_TICKER, 'AAPL');
  });
  test('a new user\'s watchlist seed is empty; the research universe is the list + QQQ, SPY, ^VIX', () => {
    assert.deepEqual(watch.WATCHLIST_SEED, []);
    assert.deepEqual(prices.RESEARCH_UNIVERSE, [...core, 'QQQ', 'SPY', '^VIX']);
    assert.deepEqual(prices.JAMES_EXTRA_TICKERS, ['BTC-USD', 'ETH-USD', 'SOL-USD']);
  });
  test('tax: the profile\'s rate, in the math and in the assumption line', async () => {
    const tax = await import('../src/portfolio/exitTax.ts');
    assert.equal(tax.EXIT_TAX_RATE, 0.2);
    assert.match(tax.EXIT_TAX_ASSUMPTION, /^20% of the gain/);
    const r = tax.computeExitTax({ quantity: 10, unitCost: 100, unitPrice: 150 });
    assert.equal(r.rate, 0.2);
    assert.equal(r.taxOwedUsd, 100);
  });
  test('tabs and portfolio layout: no personal tabs, the template header, CLOSED ends the options, the default assumed date', async () => {
    const t = await import('../src/sheets/tabs.ts');
    const pf = await import('../src/sheets/readers/portfolio.ts');
    assert.deepEqual(t.PERSONAL_TABS, []);
    assert.equal(t.isPersonalTab('DASHBOARD'), false);
    assert.deepEqual(pf.PURCHASE_DATE_COLUMNS, ['Purchase Date']);
    assert.equal(pf.endsOpenOptions('CLOSED positions'), true);
    assert.equal(pf.endsOpenOptions('TICKER'), false);
    assert.equal(pf.ASSUMED_STOCK_PURCHASE_DATE_ISO, '2020-01-01');
  });
  test('live: no live settings = the engine defaults and an allow-list of the list plus the index', async () => {
    const cfg = await import('../src/live/liveConfig.ts');
    const rails = await import('../src/live/rails.ts');
    assert.equal(cfg.LIVE_DEFAULTS.startValue, 1_000);
    assert.equal(cfg.LIVE_DEFAULTS.follow, 'auto');
    assert.deepEqual([...rails.ALLOW_LIST], [...core, 'QQQ']);
  });
  test('features: live bot off skips only the live dry run; paper off drops the paper step and live loses that dependency', async () => {
    const st = await import('../src/jobs/nightly/steps.ts');
    const all = st.ALL_NIGHTLY_STEPS.map((s) => s.id);
    assert.deepEqual(st.NIGHTLY_ORDER, all.filter((id) => id !== 'live.dryRun'));
    assert.deepEqual(st.nightlyStepsFor({ paper: true, liveBot: true }), st.ALL_NIGHTLY_STEPS);
    const noPaper = st.nightlyStepsFor({ paper: false, liveBot: true });
    assert.deepEqual(noPaper.map((s) => s.id), all.filter((id) => id !== 'paper.trade'));
    assert.deepEqual(noPaper.find((s) => s.id === 'live.dryRun')?.dependsOn, []);
    for (const s of st.nightlyStepsFor({ paper: true, liveBot: false })) assert.deepEqual(s, st.stepDef(s.id));
  });
  test('zones: the user zone is the profile\'s (display only); the market clock and the workflow step list stay engine', async () => {
    const ws = await import('../src/workflows/schedule.ts');
    const st = await import('../src/jobs/nightly/steps.ts');
    assert.equal(ws.USER_ZONE, 'Europe/London');
    assert.equal(ws.ET_ZONE, 'America/New_York');
    assert.deepEqual(ws.NIGHTLY_STEP_ORDER, st.ALL_NIGHTLY_STEPS.map((s) => s.id));
  });
  test('no paper start date = the paper step refuses with a plain line and touches nothing', async () => {
    assert.equal(paper.PAPER_START, '');
    let touched = false;
    const deps = new Proxy({ watchlist: [] }, { get: (t, k) => { if (k !== 'watchlist' && k !== 'then') touched = true; return (t as Record<string | symbol, unknown>)[k]; } });
    const line = await job.runPaperNight(deps as never);
    assert.match(line, /no start date in the profile/);
    assert.equal(touched, false);
  });
});
