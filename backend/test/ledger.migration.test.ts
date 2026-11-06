/**
 * docs/LEDGER.md phase 1: the Portfolio tab -> ledger files (ledger/fromSheet.ts), the reconciliation
 * (ledger/reconcile.ts) and the migration CLI (src/ledgerMigrate.ts). Made-up rows only (the layout of a real tab,
 * none of its data); the sheet's words above the stock table come from a test layout in another language.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromSheet, parsePropertyNote, formulaSource, closedProceeds, dayFirstDate, slug, columnName } from '../src/ledger/fromSheet.ts';
import { reconcile, reconciliationTable } from '../src/ledger/reconcile.ts';
import type { SheetLayout } from '../src/ledger/layout.ts';
import { TEST_LAYOUT, grid } from './ledgerFixtures.ts';
import { ledgerMigrate } from '../src/ledgerMigrate.ts';
import { parsePortfolio } from '../src/sheets/readers/portfolio.ts';
import { compareHoldings, toPortfolio } from '../src/ledger/toPortfolio.ts';
import { readLedgerJson } from '../src/ledger/store.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';

const ETH_ROW = 21, DOGE_ROW = 24;
function formulas(): SheetRow[] {
  const f: SheetRow[] = grid().map(() => []);
  (f[ETH_ROW] as SheetRow)[4] = '=IFERROR(Portfolio!J2, 0)';
  (f[DOGE_ROW] as SheetRow)[4] = '=IFERROR(GoogleFinance("DOGEUSD"), 0)';
  return f;
}
const WATCH: SheetRow[] = [['Ticker'], ['MSFT'], ['ko'], ['MSFT'], ['']];
const run = (o: { pension?: number; layout?: SheetLayout } = {}) => fromSheet({ portfolio: grid(o), watchlist: WATCH, today: '2026-11-06', layout: o.layout ?? TEST_LAYOUT, formulas: formulas() });

describe('fromSheet: the stock table, options and closed positions', () => {
  const m = run();
  test('stocks, bitcoin funds and crypto (the sheet price as manualPrice); "*" and TOTAL rows are not migrated', () => {
    assert.deepEqual(m.holdings.stocks.map((s) => [s.id, s.kind, s.qty, s.avgCost, s.manualPrice ?? null, s.bought]), [
      ['stock:aapl', 'stock', 10, 150, null, null],
      ['btcFund:fbtc', 'btcFund', 5, 50, null, null],
      ['crypto:eth', 'crypto', 2, 1000, 3000, null],
      ['crypto:doge', 'crypto', 100, 0, 0.1, null],
    ]);
    assert.ok(m.holdings.stocks.every((s) => s.currency === 'USD'));
    assert.equal(m.holdings.stocks.find((s) => s.ticker === 'ETH')?.note, 'https://x.test/ETH/');
    const star = m.needsOwnerCheck.find((c) => c.item.startsWith('AAPL***'));
    assert.ok(star && star.where === 'Portfolio!A23' && /NOT migrated/.test(star.why) && star.why.includes('temp'));
    assert.ok(!m.needsOwnerCheck.some((c) => c.item.startsWith('TOTAL')));
    assert.ok(m.needsOwnerCheck.some((c) => c.item === 'DOGE' && /average cost 0/.test(c.why)));
  });
  test('the same stocks and options as the runs read from the sheet (toPortfolio vs parsePortfolio: no difference)', () => {
    assert.deepEqual(compareHoldings(parsePortfolio(grid()), toPortfolio(m.holdings)), []);
  });
  test('open options, with the expiry as a day and a stable id', () => {
    assert.deepEqual(m.holdings.options, [{ id: 'call:ko:60:2027-06-17', ticker: 'KO', side: 'call', contracts: 2, strike: 60, expiry: '2027-06-17', avgPremium: 3.5, bought: '2026-03-19', currentValue: 900 }]);
  });
  test('closed: Sell Price per contract when 10x the premium (parseClosed rule), else per share; a text sell date is flagged', () => {
    assert.deepEqual(m.holdings.closed.map((c) => [c.id, c.cost, c.proceeds, c.sold]), [
      ['closed:call:msft:400:2027-03-19:2026-10-09', 2000, 4500, '2026-10-09'],
      ['closed:call:ko:50:2027-12-17:' + m.holdings.closed[1]!.sold, 200, 300, m.holdings.closed[1]!.sold],
    ]);
    assert.ok(m.needsOwnerCheck.some((c) => c.item === 'MSFT' && /sell date is text/.test(c.why)));
    assert.equal(closedProceeds(2, 5, 4, true), 1000);
    assert.equal(closedProceeds(1, 400, 4, true), 400);
    assert.equal(closedProceeds(3, 10, null, false), 30);
  });
  test('watchlist: upper case, deduplicated', () => {
    assert.deepEqual(m.watchlist.tickers, ['MSFT', 'KO']);
  });
  test('crypto price cells: the cell, its source and the symbol the sheet script fetches; unused script cells listed', () => {
    assert.deepEqual(m.cryptoPriceCells.map((c) => [c.ticker, c.cell, c.source, c.apiSymbol]), [['ETH', 'Portfolio!E22', 'Portfolio!J2', 'ETH'], ['DOGE', 'Portfolio!E25', 'GOOGLEFINANCE("DOGEUSD")', null]]);
    assert.deepEqual(m.unusedCryptoApiCells, { J3: 'XRP' });
  });
});

describe('fromSheet: the block above the tables', () => {
  const m = run();
  test('pension and funds rows: names, provider, holder and type kept exactly; ILS; the block date', () => {
    const [a, b] = m.assets.items;
    assert.deepEqual(a, { id: 'funds:fondo-ñ-general-ana', group: 'funds', name: 'Fondo Ñ - general', provider: 'Fondo Ñ', value: 100_000, currency: 'ILS', asOf: '2025-02-01', person: 'Ana', savingsType: 'fondo de estudio' });
    assert.equal(b!.group, 'pension');
    assert.equal(b!.name, 'Fondo B');
  });
  test('a property note "value X million but Y mortgage" that agrees with the amount: value and debt', () => {
    const p = m.assets.items.find((x) => x.name === 'Piso A')!;
    assert.deepEqual([p.group, p.value, p.debt, p.note], ['realEstate', 1_500_000, 500_000, 'valor 1.5 millones pero 0.5 hipoteca']);
  });
  test('a range note: the amount, the note kept, flagged; the sheet debt line becomes that property\'s mortgage (flagged)', () => {
    const p = m.assets.items.find((x) => x.name === 'Piso B')!;
    assert.equal(p.value, 500_000);
    assert.equal(p.debt, 100_000);
    assert.match(p.note ?? '', /0\.4-0\.6.*DEBT in NIS 100000/);
    assert.ok(m.needsOwnerCheck.some((c) => c.item === 'Piso B' && /range/.test(c.why)));
    assert.ok(m.needsOwnerCheck.some((c) => /DEBT in NIS/.test(c.item) && /confirm/.test(c.why)));
    assert.deepEqual(m.sheetDebt, { amount: 100_000, attachedTo: p.id, added: 'DEBT in NIS 100000 (until 2030)', cellNote: '(until 2030)' });
  });
  test('debtTo cash: the debt line is a negative cash item', () => {
    const c = run({ layout: { ...TEST_LAYOUT, debtTo: 'cash' } });
    const d = c.assets.items.find((x) => x.group === 'cash')!;
    assert.deepEqual([d.value, d.note], [-100_000, '(until 2030)']);
    assert.deepEqual(c.sheetDebt, { amount: 100_000, attachedTo: null, cashItem: d.id, cellNote: '(until 2030)' });
    assert.equal(reconcile(c).flagged, 0);
  });
  test('typed targets are found by label (not address), one name per number below it', () => {
    assert.deepEqual(m.targets.items.map((t) => [t.id, t.value]), [['target:ratio-high', 1.5], ['target:price-ratio-high', 0.01]]);
    assert.match(m.targets.items[0]!.note ?? '', /Portfolio!H14/);
  });
  test('the default (English) layout finds no Hebrew block and still converts the tables', () => {
    const d = fromSheet({ portfolio: grid(), watchlist: WATCH, today: '2026-11-06' });
    assert.equal(d.holdings.stocks.length, 4);
    assert.deepEqual(d.assets.items.map((a) => a.group), ['cash']);
  });
});

describe('reconciliation', () => {
  test('a sheet whose rows add up: every line ok', () => {
    const r = reconcile(run());
    assert.equal(r.flagged, 0, reconciliationTable(r).join('\n'));
    assert.deepEqual(r.groups.filter((g) => g.count).map((g) => [g.group, g.count, g.total]), [
      ['stocks', 1, 2000], ['btcFunds', 1, 300], ['crypto', 2, 6010], ['calls', 1, 900], ['pension', 1, 200_000], ['funds', 1, 100_000], ['realEstate', 2, 1_400_000],
    ]);
  });
  test('a total that differs by more than 0.5% is flagged, with the difference', () => {
    const r = reconcile(run({ pension: 310_000 }));
    const l = r.lines.find((x) => x.check.startsWith('Pension'))!;
    assert.equal(l.flagged, true);
    assert.equal(l.diffPct, -3.23);
    assert.ok(reconciliationTable(r).some((x) => x.includes('FLAG')));
  });
});

describe('helpers', () => {
  test('property notes, formula sources, dates, slugs, columns', () => {
    assert.deepEqual(parsePropertyNote('value 3.3 million but 1.3 mortgage'), { value: 3_300_000, debt: 1_300_000, range: false });
    assert.deepEqual(parsePropertyNote('worth 900k, mortgage 200k'), { value: 900_000, debt: 200_000, range: false });
    assert.equal(parsePropertyNote('(maybe 2.6-3.0)').range, true);
    assert.equal(formulaSource("=IFERROR('My tab'!$J$7, 0)", 'Portfolio'), 'My tab!J7');
    assert.equal(formulaSource('=J9*2', 'Portfolio'), 'Portfolio!J9');
    assert.equal(dayFirstDate('as of 1.3.2024'), '2024-03-01');
    assert.equal(dayFirstDate('13.13.2024'), null);
    assert.equal(slug('  Our Flat / B '), 'our-flat-b');
    assert.equal(columnName(0) + columnName(25) + columnName(26), 'AZAA');
  });
});

describe('npm run ledger-migrate', () => {
  const layoutFile = (dir: string): string => { const f = path.join(dir, 'layout.json'); fs.writeFileSync(f, JSON.stringify(TEST_LAYOUT)); return f; };
  const grids = (o: { pension?: number } = {}) => async () => ({ portfolio: grid(o), watchlist: WATCH, formulas: formulas() });
  test('writes the ledger files and the migration reports; prints counts and the table', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-mig-'));
    const out: string[] = [];
    const code = await ledgerMigrate({ env: { LEDGER_LAYOUT_FILE: layoutFile(dir) }, argv: ['--out', dir], out: (l) => out.push(l), readGrids: grids(), now: () => Date.parse('2026-11-06T20:00:00Z') });
    assert.equal(code, 0);
    assert.equal(readLedgerJson(dir, 'holdings')!.stocks.length, 4);
    assert.equal(readLedgerJson(dir, 'assets')!.items.length, 4);
    assert.deepEqual(readLedgerJson(dir, 'watchlist')!.tickers, ['MSFT', 'KO']);
    assert.equal(readLedgerJson(dir, 'targets')!.items.length, 2);
    assert.ok(!fs.existsSync(path.join(dir, 'ledger', 'snapshots.jsonl')), 'snapshots start fresh (the Nightly writes them)');
    for (const f of ['needs-owner-check.json', 'reconciliation.md', 'crypto-price-cells.json']) assert.ok(fs.existsSync(path.join(dir, 'migration', f)), f);
    assert.ok(out.some((l) => /holdings: 4 stock-table item\(s\) \(1 stocks, 1 bitcoin funds, 2 crypto\), 1 open option\(s\), 2 closed/.test(l)));
    assert.ok(out.some((l) => l.startsWith('| Total Portfolio Sum $ |') && l.endsWith('| ok |')));
    assert.ok(out.some((l) => /J3 XRP/.test(l)));
  });
  test('--check: writes nothing; exit 1 when a total is flagged, 0 when none', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-chk-'));
    const env = { LEDGER_LAYOUT_FILE: layoutFile(dir) };
    assert.equal(await ledgerMigrate({ env, argv: ['--check'], out: () => {}, readGrids: grids() }), 0);
    const out: string[] = [];
    assert.equal(await ledgerMigrate({ env, argv: ['--check'], out: (l) => out.push(l), readGrids: grids({ pension: 400_000 }) }), 1);
    assert.ok(out.some((l) => /^ {2}- reconciliation Pension/.test(l)));
    assert.ok(!fs.existsSync(path.join(dir, 'ledger')));
  });
  test('configuration: no folder = exit 2; no Google settings = exit 2, naming them but no value', async () => {
    const out: string[] = [];
    assert.equal(await ledgerMigrate({ env: {}, argv: [], out: (l) => out.push(l) }), 2);
    assert.equal(await ledgerMigrate({ env: {}, argv: ['--check'], out: (l) => out.push(l) }), 2);
    assert.match(out.join('\n'), /missing GOOGLE_SERVICE_ACCOUNT_JSON, SPREADSHEET_ID/);
  });
});
