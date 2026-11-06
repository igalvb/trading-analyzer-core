/**
 * docs/LEDGER.md phases 2-3: the ledger files on the data branch folder (ledger/store.ts), the holdings the runs read
 * (ledger/toPortfolio.ts), the day's snapshot (ledger/snapshot.ts), the Nightly's part per profile `storage.ledger`
 * (ledger/night.ts, app/nightlyApp.ts loadPortfolio) and the flag itself. Made-up holdings only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendLedgerJsonl, appendSnapshot, appendSnapshots, checkSchema, dataBranchDir, LedgerFormatError, ledgerPath, readLedgerJson, readLedgerJsonl, writeLedgerJson,
} from '../src/ledger/store.ts';
import { compareHoldings, toPortfolio } from '../src/ledger/toPortfolio.ts';
import { buildSnapshot } from '../src/ledger/snapshot.ts';
import { runLedgerNight, type LedgerNightDeps } from '../src/ledger/night.ts';
import { LEDGER_SCHEMA, type LedgerAssets, type LedgerHoldings } from '../src/ledger/schema.ts';
import { validateProfile } from '../src/profile/schema.ts';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';
import { loadPortfolio } from '../src/app/nightlyApp.ts';
import { parsePortfolio } from '../src/sheets/readers/portfolio.ts';
import type { Services } from '../src/compose.ts';
import { grid } from './ledgerFixtures.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-store-'));

export const HOLDINGS: LedgerHoldings = {
  schema: LEDGER_SCHEMA, updated: '2026-11-06',
  stocks: [
    { id: 'stock:aapl', ticker: 'AAPL', kind: 'stock', qty: 10, avgCost: 150, currency: 'USD', bought: null },
    { id: 'btcFund:fbtc', ticker: 'FBTC', kind: 'btcFund', qty: 5, avgCost: 50, currency: 'USD', bought: '2025-04-01' },
    { id: 'crypto:eth', ticker: 'ETH', kind: 'crypto', qty: 2, avgCost: 1000, currency: 'USD', bought: null, manualPrice: 3000 },
    { id: 'crypto:doge', ticker: 'DOGE', kind: 'crypto', qty: 100, avgCost: 0, currency: 'USD', bought: null },
  ],
  options: [{ id: 'call:ko:60:2027-06-17', ticker: 'KO', side: 'call', contracts: 2, strike: 60, expiry: '2027-06-17', avgPremium: 3.5, bought: '2026-03-19', currentValue: 900 }],
  closed: [],
};
const ASSETS: LedgerAssets = {
  schema: LEDGER_SCHEMA, updated: '2026-11-06',
  items: [
    { id: 'pension:a', group: 'pension', name: 'Fund A', value: 70_000, currency: 'ILS', asOf: '2025-02-01' },
    { id: 'realEstate:flat', group: 'realEstate', name: 'Flat', value: 1_500_000, debt: 500_000, currency: 'ILS', asOf: '2025-02-01' },
  ],
};

describe('store: the files on the data branch folder', () => {
  test('DATA_BRANCH_DIR, else ../data-branch from backend/', () => {
    assert.equal(dataBranchDir({}, '/repo/backend'), '/repo/data-branch');
    assert.equal(dataBranchDir({ DATA_BRANCH_DIR: '/x/y' }, '/repo/backend'), '/x/y');
  });
  test('JSON written pretty with a final newline, read back the same; a missing file is null', () => {
    const root = tmp();
    assert.equal(readLedgerJson(root, 'holdings'), null);
    writeLedgerJson(root, 'holdings', HOLDINGS);
    const text = fs.readFileSync(ledgerPath(root, 'holdings'), 'utf8');
    assert.ok(text.startsWith('{\n  "schema": 1,') && text.endsWith('}\n'));
    assert.deepEqual(readLedgerJson(root, 'holdings'), HOLDINGS);
  });
  test('a newer schema, no schema, or broken JSON is refused with the file named', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'ledger'));
    fs.writeFileSync(ledgerPath(root, 'assets'), JSON.stringify({ ...ASSETS, schema: LEDGER_SCHEMA + 1 }));
    assert.throws(() => readLedgerJson(root, 'assets'), (e: unknown) => e instanceof LedgerFormatError && /ledger\/assets\.json: written in ledger format 2, newer/.test(e.message));
    fs.writeFileSync(ledgerPath(root, 'assets'), '{"items":[]}');
    assert.throws(() => readLedgerJson(root, 'assets'), /no ledger schema number/);
    fs.writeFileSync(ledgerPath(root, 'assets'), '{oops');
    assert.throws(() => readLedgerJson(root, 'assets'), /not valid JSON/);
    assert.throws(() => writeLedgerJson(root, 'assets', { ...ASSETS, schema: 99 }), /newer/);
    assert.doesNotThrow(() => checkSchema({ schema: 1 }, 'x'));
  });
  test('jsonl: append-only, one object per line; a bad line is refused with its number', () => {
    const root = tmp();
    const flow = { schema: 1, id: 'f1', date: '2026-11-01', group: 'stocks' as const, amount: 500, currency: 'USD' as const, source: 'owner' as const };
    appendLedgerJsonl(root, 'flows', [flow]);
    appendLedgerJsonl(root, 'flows', [{ ...flow, id: 'f2' }]);
    assert.deepEqual(readLedgerJsonl(root, 'flows').map((f) => f.id), ['f1', 'f2']);
    assert.equal(fs.readFileSync(ledgerPath(root, 'flows'), 'utf8').split('\n').length, 3);
    fs.appendFileSync(ledgerPath(root, 'flows'), '{"schema":7}\n');
    assert.throws(() => readLedgerJsonl(root, 'flows'), /flows\.jsonl line 3: written in ledger format 7/);
  });
  test('snapshots: a day already saved is kept, never overwritten', () => {
    const root = tmp();
    const s = { schema: 1, date: '2026-11-05', fxUsdIls: 3.5, usd: { stocks: 1 }, totalUsd: 1, totalIls: 3.5 };
    assert.equal(appendSnapshot(root, s), 'added');
    assert.equal(appendSnapshot(root, { ...s, totalUsd: 2 }), 'exists');
    assert.deepEqual(appendSnapshots(root, [{ ...s, date: '2026-11-04' }, { ...s, totalUsd: 9 }]), { added: 1, kept: 1 });
    assert.deepEqual(readLedgerJsonl(root, 'snapshots').map((x) => [x.date, x.totalUsd]), [['2026-11-05', 1], ['2026-11-04', 1]]);
  });
});

describe('toPortfolio: the PortfolioResult the runs read', () => {
  test('stocks and bitcoin funds as stocks (no date = the assumed date), crypto skipped, options kept', () => {
    const p = toPortfolio(HOLDINGS);
    assert.deepEqual(p.stocks.map((s) => [s.ticker, s.shares, s.avgCost, s.entryDate?.toISOString().slice(0, 10), s.entryDateAssumed ?? false]), [
      ['AAPL', 10, 150, '2020-01-01', true], ['FBTC', 5, 50, '2025-04-01', false],
    ]);
    assert.deepEqual(p.skippedCrypto, ['ETH', 'DOGE']);
    assert.deepEqual(p.options.map((o) => [o.ticker, o.side, o.contracts, o.strike, o.expiry?.toISOString().slice(0, 10), o.currentValue]), [['KO', 'call', 2, 60, '2027-06-17', 900]]);
  });
  test('the made-up sheet and these holdings compare equal; each kind of difference is named', () => {
    const sheet = parsePortfolio(grid());
    assert.deepEqual(compareHoldings(sheet, toPortfolio({ ...HOLDINGS, stocks: HOLDINGS.stocks.map((s) => (s.ticker === 'FBTC' ? { ...s, bought: null } : s)) })), []);
    const changed: LedgerHoldings = {
      ...HOLDINGS,
      stocks: [{ ...HOLDINGS.stocks[0]!, qty: 11 }, { ...HOLDINGS.stocks[1]!, ticker: 'IBIT', bought: null }, HOLDINGS.stocks[2]!],
      options: [{ ...HOLDINGS.options[0]!, strike: 65 }],
    };
    const d = compareHoldings(sheet, toPortfolio(changed));
    assert.ok(d.includes('stock AAPL: sheet qty 10, cost 150, bought assumed / ledger qty 11, cost 150, bought assumed'), d.join('\n'));
    assert.ok(d.some((x) => /^stock FBTC: in the sheet only/.test(x)) && d.some((x) => /^stock IBIT: in the ledger only/.test(x)));
    assert.ok(d.some((x) => /^option KO call 60 2027-06-17: in the sheet only/.test(x)) && d.some((x) => /^option KO call 65/.test(x)));
    assert.ok(d.includes('crypto: sheet DOGE, ETH / ledger ETH'));
  });
});

describe('snapshot: the value per group', () => {
  test('stocks at tonight\'s close, crypto at manualPrice or <T>-USD, calls at current value, ILS assets at the rate', () => {
    const prices: Record<string, number> = { AAPL: 200, FBTC: 60, 'DOGE-USD': 0.1 };
    const { snapshot, missing } = buildSnapshot({ date: '2026-11-06', holdings: HOLDINGS, assets: ASSETS, price: (t) => prices[t] ?? null, fxUsdIls: 4 });
    assert.deepEqual(missing, []);
    assert.deepEqual(snapshot, { schema: 1, date: '2026-11-06', fxUsdIls: 4, usd: { stocks: 2000, btcFunds: 300, crypto: 6010, calls: 900, pension: 17_500, realEstate: 250_000 }, totalUsd: 276_710, totalIls: 1_106_840 });
  });
  test('no price / no rate: left out and named, never valued at 0', () => {
    const { snapshot, missing } = buildSnapshot({ date: '2026-11-06', holdings: HOLDINGS, assets: ASSETS, price: () => null, fxUsdIls: null });
    assert.deepEqual(Object.keys(snapshot.usd).sort(), ['calls', 'crypto']);
    assert.ok(missing.includes('AAPL (no price)') && missing.includes('Flat (no USD/ILS rate)'));
    assert.equal(snapshot.totalIls, null);
  });
});

describe('the Nightly per storage.ledger', () => {
  const deps = (root: string, mode: LedgerNightDeps['mode'], lines: string[]): LedgerNightDeps => ({
    mode, root, today: '2026-11-06', sheetPortfolio: mode === 'shadow' ? parsePortfolio(grid()) : null,
    close: async (t) => ({ AAPL: 200, FBTC: 60, 'DOGE-USD': 0.1 } as Record<string, number>)[t] ?? null, fxUsdIls: async () => 4,
    info: (m) => lines.push('INFO ' + m), warn: (m) => lines.push('WARN ' + m),
  });
  test('off: nothing read, nothing logged, nothing written', async () => {
    const root = tmp(), lines: string[] = [];
    writeLedgerJson(root, 'holdings', HOLDINGS);
    assert.deepEqual(await runLedgerNight(deps(root, 'off', lines)), { differences: null, snapshot: 'skipped' });
    assert.deepEqual(lines, []);
    assert.ok(!fs.existsSync(ledgerPath(root, 'snapshots')));
  });
  test('shadow: one comparison line (the same holdings), then today\'s snapshot appended once', async () => {
    const root = tmp(), lines: string[] = [];
    writeLedgerJson(root, 'holdings', { ...HOLDINGS, stocks: HOLDINGS.stocks.map((s) => ({ ...s, bought: null })) });
    writeLedgerJson(root, 'assets', ASSETS);
    const r = await runLedgerNight(deps(root, 'shadow', lines));
    assert.deepEqual(r, { differences: [], snapshot: 'added' });
    assert.ok(lines[0]!.startsWith('INFO ledger shadow: the ledger holds the same holdings as the sheet (2 stock(s), 1 option(s), 2 crypto)'));
    assert.match(lines[1]!, /^INFO ledger snapshot 2026-11-06: appended, total \$276,710 at USD\/ILS 4$/);
    assert.equal((await runLedgerNight(deps(root, 'shadow', lines))).snapshot, 'exists');
    assert.equal(readLedgerJsonl(root, 'snapshots').length, 1);
  });
  test('shadow with a difference: a WARNING naming it', async () => {
    const root = tmp(), lines: string[] = [];
    writeLedgerJson(root, 'holdings', { ...HOLDINGS, stocks: [{ ...HOLDINGS.stocks[0]!, qty: 12 }] });
    const r = await runLedgerNight(deps(root, 'shadow', lines));
    assert.ok(r.differences && r.differences.length >= 2);
    assert.ok(lines.some((l) => /^WARN ledger shadow: \d+ difference\(s\) between the sheet and the ledger: stock AAPL/.test(l)));
  });
  test('on: no comparison, only the snapshot; no holdings file: one WARNING, nothing written', async () => {
    const root = tmp(), lines: string[] = [];
    assert.equal((await runLedgerNight(deps(root, 'on', lines))).snapshot, 'skipped');
    assert.match(lines[0]!, /^WARN ledger \(on\): no ledger\/holdings\.json/);
    writeLedgerJson(root, 'holdings', HOLDINGS);
    const r = await runLedgerNight(deps(root, 'on', lines));
    assert.deepEqual(r, { differences: null, snapshot: 'added' });
  });
  test('loadPortfolio: "on" reads the ledger and not the sheet; a missing file stops the run with a plain error', async () => {
    const root = tmp();
    const logged: string[] = [];
    const s = { env: { DATA_BRANCH_DIR: root }, ctx: { log: { info: (m: string) => logged.push(m) } }, sheets: { batchGet: () => { throw new Error('the sheet must not be read'); } } } as unknown as Services;
    await assert.rejects(loadPortfolio(s, 'on'), /no ledger\/holdings\.json in the data branch folder/);
    writeLedgerJson(root, 'holdings', HOLDINGS);
    const p = await loadPortfolio(s, 'on');
    assert.deepEqual(p, toPortfolio(HOLDINGS));
    assert.match(logged[0]!, /^Portfolio \(ledger\): 2 stock holding\(s\), 1 option position\(s\)/);
  });
  test('loadPortfolio: "off" and "shadow" read the sheet exactly as before', async () => {
    const opened: string[][] = [];
    const s = { env: {}, sheets: null, openWorkbook: async (tabs: string[]) => { opened.push(tabs); return { getSheetByName: () => ({ grid: () => grid() }) }; } } as unknown as Services;
    for (const mode of ['off', 'shadow'] as const) assert.deepEqual(await loadPortfolio(s, mode), parsePortfolio(grid()));
    assert.deepEqual(opened, [['Portfolio'], ['Portfolio']]);
  });
});

describe('profile storage.ledger', () => {
  test('default off; shadow and on accepted; anything else refused', () => {
    const p = validateProfile(EXAMPLE_PROFILE_INPUT);
    assert.ok(p.ok && p.profile.storage.ledger === 'off');
    for (const v of ['shadow', 'on']) {
      const r = validateProfile({ ...EXAMPLE_PROFILE_INPUT, storage: { ledger: v } });
      assert.ok(r.ok && r.profile.storage.ledger === v);
    }
    const bad = validateProfile({ ...EXAMPLE_PROFILE_INPUT, storage: { ledger: 'yes' } });
    assert.ok(!bad.ok && bad.errors.includes('storage.ledger must be one of off, shadow, on'));
  });
});
