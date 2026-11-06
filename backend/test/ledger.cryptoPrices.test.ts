/**
 * docs/LEDGER.md "Crypto prices": ledger/cryptoPrices.ts (cryptoprices.cc, parse, timeout, retry, symbol map), the
 * migration's priceSymbol, the Nightly's ledger part with profile ledger.cryptoPrices on / off, and the flag itself.
 * A fake fetch only (no network); made-up holdings.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cryptoPriceSymbol, fetchCryptoPrices, parseCryptoPrice, type CryptoPricesDeps } from '../src/ledger/cryptoPrices.ts';
import { runLedgerNight, type LedgerNightDeps } from '../src/ledger/night.ts';
import { readLedgerJson, readLedgerJsonl, writeLedgerJson } from '../src/ledger/store.ts';
import { fromSheet } from '../src/ledger/fromSheet.ts';
import { LEDGER_SCHEMA, type LedgerHoldings } from '../src/ledger/schema.ts';
import { validateProfile } from '../src/profile/schema.ts';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';
import { TEST_LAYOUT, grid } from './ledgerFixtures.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-crypto-'));

/** A fake fetch: url -> list of answers in order (a function = called; 'hang' = never answers; Error = throws). */
function fakeFetch(answers: Record<string, Array<string | number | Error | 'hang'>>, calls: string[]): CryptoPricesDeps['fetch'] {
  return async (url) => {
    calls.push(url);
    const a = answers[url]?.shift();
    if (a === undefined) return { status: 404, text: 'Not Found' };
    if (a === 'hang') return new Promise(() => {});
    if (a instanceof Error) throw a;
    if (typeof a === 'number') return { status: a, text: '' };
    return { status: 200, text: a };
  };
}
const U = (s: string): string => 'https://cryptoprices.cc/' + s + '/';

describe('parseCryptoPrice', () => {
  test('a plain positive number, whitespace allowed', () => {
    assert.equal(parseCryptoPrice('152.34\n'), 152.34);
    assert.equal(parseCryptoPrice('  0.00042 '), 0.00042);
    assert.equal(parseCryptoPrice('7'), 7);
    assert.equal(parseCryptoPrice('1.5e-7'), 1.5e-7);
  });
  test('bad bodies: null', () => {
    for (const b of ['', '0', '-3', 'NaN', 'Infinity', '1e999', '$152', '152,3', '1.2.3', '<html>152</html>', 'abc', '12 34', '.5', '0x10']) assert.equal(parseCryptoPrice(b), null, b);
  });
});

describe('cryptoPriceSymbol', () => {
  test('priceSymbol wins; else the ticker without trailing dots', () => {
    assert.equal(cryptoPriceSymbol({ ticker: 'COINA.', priceSymbol: 'CNA' }), 'CNA');
    assert.equal(cryptoPriceSymbol({ ticker: 'COINB..' }), 'COINB');
    assert.equal(cryptoPriceSymbol({ ticker: 'ETH', priceSymbol: ' ' }), 'ETH');
  });
});

describe('fetchCryptoPrices', () => {
  test('prices; one retry; a failure is absent and named in ONE warning', async () => {
    const calls: string[] = [], warns: string[] = [];
    const f = fakeFetch({ [U('ETH')]: ['3100.5\n'], [U('SOL')]: [503, '150'], [U('BAD')]: ['oops', 'oops'], [U('ERR')]: [new Error('reset'), new Error('reset')] }, calls);
    const m = await fetchCryptoPrices(['ETH', 'SOL', 'BAD', 'ERR', 'NONE', 'ETH'], { fetch: f, log: { warn: (w) => warns.push(w) } });
    assert.deepEqual([...m.entries()].sort(), [['ETH', 3100.5], ['SOL', 150]]);
    assert.equal(calls.filter((c) => c === U('ETH')).length, 1);
    assert.equal(calls.filter((c) => c === U('SOL')).length, 2);
    assert.equal(calls.filter((c) => c === U('NONE')).length, 2);
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /^crypto prices: no price from cryptoprices\.cc for BAD \(not a price: "oops"\), ERR \(reset\), NONE \(HTTP 404\); their manual price is kept$/);
  });
  test('a request that hangs is cut off at the timeout (and retried once)', async () => {
    const calls: string[] = [], warns: string[] = [];
    const m = await fetchCryptoPrices(['SLOW', 'OK'], { fetch: fakeFetch({ [U('SLOW')]: ['hang', 'hang'], [U('OK')]: ['2'] }, calls), log: { warn: (w) => warns.push(w) }, timeoutMs: 20 });
    assert.deepEqual([...m.entries()], [['OK', 2]]);
    assert.equal(calls.filter((c) => c === U('SLOW')).length, 2);
    assert.match(warns[0]!, /SLOW \(timed out after 20 ms\)/);
  });
  test('no symbols: no request, no line', async () => {
    const calls: string[] = [], warns: string[] = [];
    assert.equal((await fetchCryptoPrices([], { fetch: fakeFetch({}, calls), log: { warn: (w) => warns.push(w) } })).size, 0);
    assert.deepEqual([calls, warns], [[], []]);
  });
  test('never throws, even when the logger does', async () => {
    const m = await fetchCryptoPrices(['X'], { fetch: async () => { throw new Error('down'); }, log: { warn: () => { throw new Error('log down'); } } });
    assert.equal(m.size, 0);
  });
});

describe('the migration: priceSymbol from the sheet\'s price-script cells', () => {
  test('kept when the script symbol differs from the ticker; absent when it is the ticker', () => {
    const f: SheetRow[] = grid().map(() => []);
    (f[21] as SheetRow)[4] = '=IFERROR(Portfolio!J2, 0)';
    const run = (cells: Record<string, string>) => fromSheet({ portfolio: grid(), watchlist: [['Ticker']], today: '2026-11-06', layout: { ...TEST_LAYOUT, cryptoApiCells: cells }, formulas: f });
    const eth = (cells: Record<string, string>) => run(cells).holdings.stocks.find((s) => s.ticker === 'ETH')!;
    assert.equal(eth({ J2: 'WETH' }).priceSymbol, 'WETH');
    assert.ok(!('priceSymbol' in eth({ J2: 'ETH' })));
    assert.ok(!('priceSymbol' in run({ J2: 'WETH' }).holdings.stocks.find((s) => s.ticker === 'DOGE')!));
  });
});

const HOLDINGS: LedgerHoldings = {
  schema: LEDGER_SCHEMA, updated: '2026-11-06',
  stocks: [
    { id: 'stock:aapl', ticker: 'AAPL', kind: 'stock', qty: 10, avgCost: 150, currency: 'USD', bought: null },
    { id: 'crypto:eth', ticker: 'ETH', kind: 'crypto', qty: 2, avgCost: 1000, currency: 'USD', bought: null, manualPrice: 3000 },
    { id: 'crypto:coina', ticker: 'COINA.', kind: 'crypto', qty: 100, avgCost: 0, currency: 'USD', bought: null, manualPrice: 1, priceSymbol: 'CNA' },
  ],
  options: [], closed: [],
};

describe('the Nightly: profile ledger.cryptoPrices', () => {
  const deps = (root: string, o: Partial<LedgerNightDeps>, lines: string[], asked: string[][]): LedgerNightDeps => ({
    mode: 'on', root, today: '2026-11-06', sheetPortfolio: null,
    close: async (t) => (t === 'AAPL' ? 200 : null), fxUsdIls: async () => 4,
    fetchCrypto: async (symbols) => { asked.push([...symbols]); return new Map([['ETH', 3500]]); },
    info: (m) => lines.push('INFO ' + m), warn: (m) => lines.push('WARN ' + m),
    ...o,
  });
  test('off (and absent): no fetch at all; the snapshot uses manualPrice', async () => {
    for (const o of [{ cryptoPrices: 'off' as const }, {}]) {
      const root = tmp(), lines: string[] = [], asked: string[][] = [];
      writeLedgerJson(root, 'holdings', HOLDINGS);
      await runLedgerNight(deps(root, o, lines, asked));
      assert.deepEqual(asked, []);
      assert.equal(readLedgerJsonl(root, 'snapshots')[0]!.usd.crypto, 6100);
      assert.equal(readLedgerJson(root, 'prices'), null, 'no prices.json');
    }
  });
  test('on: the fetched price wins over manualPrice for the snapshot; a coin not fetched keeps manualPrice; holdings.json unchanged', async () => {
    const root = tmp(), lines: string[] = [], asked: string[][] = [];
    writeLedgerJson(root, 'holdings', HOLDINGS);
    const before = fs.readFileSync(path.join(root, 'ledger', 'holdings.json'), 'utf8');
    const r = await runLedgerNight(deps(root, { cryptoPrices: 'on' }, lines, asked));
    assert.equal(r.snapshot, 'added');
    assert.deepEqual(asked, [['ETH', 'CNA']]);
    const snap = readLedgerJsonl(root, 'snapshots')[0]!;
    assert.equal(snap.usd.crypto, 2 * 3500 + 100 * 1);
    assert.equal(snap.usd.stocks, 2000);
    assert.ok(lines.includes('INFO ledger crypto prices: 1 of 2 coin(s) priced tonight (BTC from Yahoo, the rest from cryptoprices.cc); the others at their manual price; saved to ledger/prices.json'), lines.join('\n'));
    assert.equal(fs.readFileSync(path.join(root, 'ledger', 'holdings.json'), 'utf8'), before);
    assert.deepEqual(readLedgerJson(root, 'holdings'), HOLDINGS);
    assert.deepEqual(readLedgerJson(root, 'prices'), { schema: LEDGER_SCHEMA, date: '2026-11-06', prices: { 'crypto:eth': 3500 } });
  });
  test('on: BTC from Yahoo BTC-USD (not cryptoprices.cc), else its manualPrice', async () => {
    const withBtc: LedgerHoldings = { ...HOLDINGS, stocks: [...HOLDINGS.stocks, { id: 'crypto:btc', ticker: 'BTC', kind: 'crypto', qty: 0.5, avgCost: 30000, currency: 'USD', bought: null, manualPrice: 70000 }] };
    for (const [yahoo, crypto, saved] of [[80000, 2 * 3500 + 100 + 0.5 * 80000, { 'crypto:eth': 3500, 'crypto:btc': 80000 }], [null, 2 * 3500 + 100 + 0.5 * 70000, { 'crypto:eth': 3500 }]] as const) {
      const root = tmp(), lines: string[] = [], asked: string[][] = [], closes: string[] = [];
      writeLedgerJson(root, 'holdings', withBtc);
      await runLedgerNight(deps(root, { cryptoPrices: 'on', close: async (t) => { closes.push(t); return t === 'BTC-USD' ? yahoo : t === 'AAPL' ? 200 : null; } }, lines, asked));
      assert.deepEqual(asked, [['ETH', 'CNA']]);
      assert.ok(closes.includes('BTC-USD'));
      assert.equal(readLedgerJsonl(root, 'snapshots')[0]!.usd.crypto, crypto);
      assert.deepEqual(readLedgerJson(root, 'prices')!.prices, saved);
    }
  });
  test('on with storage.ledger off: nothing at all', async () => {
    const root = tmp(), lines: string[] = [], asked: string[][] = [];
    writeLedgerJson(root, 'holdings', HOLDINGS);
    await runLedgerNight(deps(root, { mode: 'off', cryptoPrices: 'on' }, lines, asked));
    assert.deepEqual([asked, lines], [[], []]);
  });
});

describe('profile ledger.cryptoPrices', () => {
  test('default off; on accepted; anything else refused', () => {
    const p = validateProfile(EXAMPLE_PROFILE_INPUT);
    assert.ok(p.ok && p.profile.ledger.cryptoPrices === 'off');
    const on = validateProfile({ ...EXAMPLE_PROFILE_INPUT, ledger: { cryptoPrices: 'on' } });
    assert.ok(on.ok && on.profile.ledger.cryptoPrices === 'on');
    const bad = validateProfile({ ...EXAMPLE_PROFILE_INPUT, ledger: { cryptoPrices: 'yes' } });
    assert.ok(!bad.ok && bad.errors.includes('ledger.cryptoPrices must be one of off, on'));
  });
});
