import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initUserSheets, portfolioTemplateRows, templateCoversReaders } from '../src/initUserSheets.ts';
import { parsePortfolio } from '../src/sheets/readers/portfolio.ts';
import { parseWatchlistRows } from '../src/sheets/readers/watchlist.ts';
import { Tabs } from '../src/sheets/tabs.ts';

function fakeSheet(existing: string[]) {
  const tabs = [...existing];
  const written: Record<string, string[][]> = {};
  const lines: string[] = [];
  return {
    tabs, written, lines,
    deps: {
      listTabs: async () => [...tabs],
      addTab: async (t: string) => { tabs.push(t); },
      write: async (t: string, rows: string[][]) => { written[t] = rows; },
      watchlistSeed: ['AAPL', 'KO'],
      out: (l: string) => { lines.push(l); },
    },
  };
}

test('blank sheet: adds Portfolio and Watchlist with template headers', async () => {
  const s = fakeSheet(['Sheet1']);
  assert.equal(await initUserSheets(s.deps), 0);
  assert.deepEqual(Object.keys(s.written).sort(), [Tabs.PORTFOLIO, Tabs.WATCHLIST, Tabs.SCRIPT_PROPERTIES].sort());
  assert.deepEqual(s.written[Tabs.SCRIPT_PROPERTIES], [['Key', 'Value', 'UpdatedAt']]);
  assert.deepEqual(parseWatchlistRows(s.written[Tabs.WATCHLIST] ?? []), ['AAPL', 'KO']);
});

test('existing tabs are never written (safe on the owner sheet)', async () => {
  const s = fakeSheet([Tabs.PORTFOLIO, Tabs.WATCHLIST, Tabs.SCRIPT_PROPERTIES]);
  await initUserSheets(s.deps);
  assert.deepEqual(s.written, {});
  assert.match(s.lines.at(-1) ?? '', /Nothing to do/);
});

test('the template has every header the readers need, and parses as an empty portfolio', () => {
  assert.ok(templateCoversReaders());
  const p = parsePortfolio(portfolioTemplateRows());
  assert.equal(p.stocks.length, 0);
  assert.equal(p.options.length, 0);
});

test('a row typed into the template is read back as a holding', () => {
  const rows = portfolioTemplateRows();
  rows.splice(2, 1, ['AAPL', 'stock', '', '10', '', '', '150', '2024-03-01', '']);
  const p = parsePortfolio(rows);
  assert.equal(p.stocks.length, 1);
  assert.equal(p.stocks[0]?.ticker, 'AAPL');
  assert.equal(p.stocks[0]?.avgCost, 150);
  assert.equal(p.stocks[0]?.entryDateAssumed, undefined);
});

test('fix 2026-11-06: a sheet moved to three spreadsheets gets no Script Properties copy', async () => {
  const s = fakeSheet([Tabs.PORTFOLIO, Tabs.WATCHLIST]);
  await initUserSheets({ ...s.deps, migrated: async () => true });
  assert.deepEqual(s.written, {});
  assert.ok(s.lines.some((l) => l.includes('kept in your data spreadsheet')));
});
