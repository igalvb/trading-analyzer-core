/**
 * docs/LEDGER.md "Corrections": the migration's generic corrections hook (ledger/corrections.ts) on the made-up sheet
 * of ledgerFixtures.ts: fixes before the reconciliation, updates after it, answered checks removed, unknown ids kept as
 * checks; the loader (file / overlay only with the overlay layout / none); and the migration CLI with a corrections file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromSheet } from '../src/ledger/fromSheet.ts';
import { reconcile } from '../src/ledger/reconcile.ts';
import { applyCorrections, applyUpdates, loadLedgerCorrections, withoutAnswered, NOT_ITEMIZED, NO_CORRECTIONS, type LedgerCorrections } from '../src/ledger/corrections.ts';
import { ledgerMigrate } from '../src/ledgerMigrate.ts';
import { readLedgerJson } from '../src/ledger/store.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';
import { TEST_LAYOUT, grid } from './ledgerFixtures.ts';

const WATCH: SheetRow[] = [['Ticker'], ['MSFT']];
/** The fixture sheet with a typed pension total for Ana in J13 (250,000: 50,000 more than her pension row). */
function sheet(pension = 350_000): SheetRow[] {
  const g = grid({ pension });
  const row = [...(g[12] as SheetRow)];
  while (row.length < 10) row.push('');
  row[9] = 250_000;
  g[12] = row;
  return g;
}
const read = (g = sheet()) => fromSheet({ portfolio: g, watchlist: WATCH, today: '2026-11-06', layout: TEST_LAYOUT });

const C: LedgerCorrections = {
  label: 'test answers',
  stocks: { 'crypto:doge': { totalCost: 50 }, 'stock:aapl': { set: { subType: 'core' } } },
  typedTotals: [{ cell: 'J13', group: 'pension', person: 'Ana' }, { cell: 'B13', group: 'funds', person: 'Ana' }],
  separateDebt: { name: 'Loan', id: 'cash:loan' },
  answered: [{ itemPattern: '\\*\\*\\* x ' }, { item: 'DOGE' }, { itemPattern: '^DEBT in NIS' }, { item: 'Piso B' }],
  updates: { asOf: '2026-11-06', assets: { 'realEstate:piso-b': { set: { value: 450_000, note: 'today' } } } },
};

describe('applyCorrections (fixes, before the reconciliation)', () => {
  const before = read();
  const { result: m, applied } = applyCorrections(before, C, sheet());
  test('without corrections the typed total is a flag; with them every line is 0%', () => {
    assert.ok(reconcile(before).lines.some((l) => /^Pension/.test(l.check) && l.flagged));
    const r = reconcile(m);
    assert.equal(r.flagged, 0, JSON.stringify(r.lines));
    assert.ok(r.lines.every((l) => l.diffPct === 0));
  });
  test('a typed total over its rows: one "not itemized" item for the difference, same group / person, the block date', () => {
    const n = m.assets.items.find((a) => a.id === 'pension:not-itemized-ana')!;
    assert.deepEqual([n.group, n.name, n.value, n.currency, n.asOf, n.person], ['pension', NOT_ITEMIZED, 50_000, 'ILS', '2025-02-01', 'Ana']);
    assert.match(n.note ?? '', /Portfolio!J13 \(250,000\) less the itemized rows \(200,000\)/);
    assert.ok(applied.includes('pension:not-itemized-ana: 50,000 = typed total Portfolio!J13 250,000 - rows 200,000'));
  });
  test('a cell that is not a number: a check, nothing added', () => {
    assert.ok(!m.assets.items.some((a) => a.id === 'funds:not-itemized-ana'));
    assert.ok(m.needsOwnerCheck.some((c) => c.where === 'corrections' && c.item === 'Portfolio!B13' && /no number/.test(c.why)));
  });
  test('the separate debt line: its own item (value 0, debt = the amount), the property gets its note and no debt back', () => {
    const p = m.assets.items.find((a) => a.id === 'realEstate:piso-b')!;
    assert.equal(p.debt, undefined);
    assert.equal(p.note, '(quizá 0.4-0.6)');
    const d = m.assets.items.find((a) => a.id === 'cash:loan')!;
    assert.deepEqual([d.group, d.name, d.value, d.debt, d.currency, d.note], ['cash', 'Loan', 0, 100_000, 'ILS', '(until 2030)']);
    assert.deepEqual(m.sheetDebt, { amount: 100_000, attachedTo: null, cashItem: 'cash:loan', cellNote: '(until 2030)' });
  });
  test('the debt line made a negative cash item (debtTo cash) is replaced the same way', () => {
    const c = fromSheet({ portfolio: sheet(), watchlist: WATCH, today: '2026-11-06', layout: { ...TEST_LAYOUT, debtTo: 'cash' } });
    const r = applyCorrections(c, C, sheet()).result;
    assert.deepEqual(r.assets.items.filter((a) => a.group === 'cash').map((a) => [a.id, a.value, a.debt]), [['cash:loan', 0, 100_000]]);
    assert.equal(reconcile(r).flagged, 0);
  });
  test('stocks: a total cost sets avgCost = cost / qty; a field is set', () => {
    assert.equal(m.holdings.stocks.find((s) => s.id === 'crypto:doge')!.avgCost, 0.5);
    assert.equal(m.holdings.stocks.find((s) => s.id === 'stock:aapl')!.subType, 'core');
  });
  test('answered checks leave the list; the unanswered stay', () => {
    assert.ok(!m.needsOwnerCheck.some((c) => /\*\*\*/.test(c.item) || c.item === 'DOGE' || /^DEBT in NIS/.test(c.item) || c.item === 'Piso B'));
    assert.ok(m.needsOwnerCheck.some((c) => c.item === 'MSFT' && /sell date is text/.test(c.why)));
    assert.ok(applied.some((l) => /^\d+ check\(s\) answered/.test(l)));
  });
  test('an id the migration does not have: a check of its own, nothing else changes', () => {
    const r = applyCorrections(before, { label: 'x', stocks: { 'stock:nope': { set: { subType: 'a' } } }, assets: { 'pension:nope': { set: { value: 1 } } } }, sheet()).result;
    assert.deepEqual(r.needsOwnerCheck.filter((c) => c.where === 'corrections').map((c) => c.item), ['stock:nope', 'pension:nope']);
    assert.deepEqual(r.holdings, before.holdings);
    assert.deepEqual(r.assets, before.assets);
  });
  test('no corrections: the migration unchanged', () => {
    const r = applyCorrections(before, NO_CORRECTIONS, sheet());
    assert.deepEqual(r.result, before);
    assert.deepEqual(r.applied, []);
  });
});

describe('applyUpdates (after the reconciliation)', () => {
  test('new values with their asOf; listed', () => {
    const fixed = applyCorrections(read(), C, sheet()).result;
    const { result, applied } = applyUpdates(fixed, C);
    const p = result.assets.items.find((a) => a.id === 'realEstate:piso-b')!;
    assert.deepEqual([p.value, p.note, p.asOf], [450_000, 'today', '2026-11-06']);
    assert.deepEqual(applied, ['realEstate:piso-b: value 450,000, note "today" (as of 2026-11-06)']);
    assert.ok(reconcile(result).flagged > 0, 'the sheet\'s totals do not know the update');
  });
});

describe('withoutAnswered', () => {
  test('every condition must match; an empty answer matches nothing', () => {
    const checks = [{ where: 'P!A1', item: 'X', why: '', raw: '' }, { where: 'P!A2', item: 'X', why: '', raw: '' }];
    assert.equal(withoutAnswered(checks, [{ where: 'P!A2', item: 'X' }]).kept.length, 1);
    assert.equal(withoutAnswered(checks, [{}]).kept.length, 2);
    assert.equal(withoutAnswered(checks, [{ itemPattern: '^X$' }]).answered, 2);
  });
});

describe('loadLedgerCorrections and the migration CLI', () => {
  test('none unless a file is named or the overlay layout is used', async () => {
    assert.equal((await loadLedgerCorrections({}, 'file')).source, 'none');
    assert.equal((await loadLedgerCorrections({}, 'default')).source, 'none');
  });
  test('LEDGER_CORRECTIONS_FILE: applied by the CLI, listed under the reconciliation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-corr-'));
    const layout = path.join(dir, 'layout.json'), corr = path.join(dir, 'corrections.json');
    fs.writeFileSync(layout, JSON.stringify(TEST_LAYOUT));
    fs.writeFileSync(corr, JSON.stringify(C));
    const out: string[] = [];
    const code = await ledgerMigrate({
      env: { LEDGER_LAYOUT_FILE: layout, LEDGER_CORRECTIONS_FILE: corr }, argv: ['--out', dir], out: (l) => out.push(l),
      readGrids: async () => ({ portfolio: sheet(), watchlist: WATCH, formulas: null }), now: () => Date.parse('2026-11-06T20:00:00Z'),
    });
    assert.equal(code, 0);
    const text = out.join('\n');
    assert.match(text, /Corrections \(test answers, file\), applied before the reconciliation:\n- crypto:doge: total cost 50 \(avg cost 0\.5\)/);
    assert.match(text, /Updates after the sheet .*\n- realEstate:piso-b: value 450,000/);
    assert.ok(!/\| FLAG \|/.test(text), text);
    const assets = readLedgerJson(dir, 'assets')!;
    assert.equal(assets.items.find((a) => a.id === 'realEstate:piso-b')!.value, 450_000);
    assert.ok(assets.items.some((a) => a.id === 'pension:not-itemized-ana'));
    assert.match(fs.readFileSync(path.join(dir, 'migration', 'reconciliation.md'), 'utf8'), /Corrections \(test answers, file\)/);
  });
});
