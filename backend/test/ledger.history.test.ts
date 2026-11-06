/**
 * docs/LEDGER.md phase 4: the system's own history tabs -> files on the data branch (ledger/history.ts), the
 * file-backed TabStore / PropertyStore (not used by any run yet) and `npm run ledger-history`. Made-up rows; the fake
 * key is built from parts so no key-shaped text sits in this file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyHistory, FilePropertyStore, FileTabStore, HISTORY_MANIFEST, jsonlToRows, kvFromGrid, looksSecret, rowsToJsonl, slugTab } from '../src/ledger/history.ts';
import { ledgerHistory } from '../src/ledgerHistory.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-hist-'));
const FAKE_KEY = 'AI' + 'za' + 'X'.repeat(35);
const TABS: Record<string, unknown[][]> = {
  '📒 Paper Log': [['Date', 'Account', 'Ticker', 'Shares'], [46_000, 'A', 'KO', 3], [46_001, 'A', 'KO', -1, '']],
  '💾 Script Properties': [['Key', 'Value', 'UpdatedAt'], ['CACHE_A', '{"x":1}', '2026-11-01T00:00:00Z'], ['LEAKY', 'https://x.test/q?apikey=' + 'abc' + 'def123', ''], ['GKEY', FAKE_KEY, '']],
};
const reader = async (tab: string): Promise<unknown[][] | null> => TABS[tab] ?? null;

describe('history copy', () => {
  test('the manifest covers the stores named in the plan, each to its own file', () => {
    const tabs = HISTORY_MANIFEST.map((e) => e.tab);
    for (const t of ['📝 Paper State', '📒 Paper Log', '📈 Paper Values', '🔎 Paper Reads', '🤖 Claude Picks', '🤖 Claude Ideas', '📈 Decision History', 'Exit Target History', '🩺 Run Health', '💾 Script Properties', '📈 Options Reads', '📦 Option Chain Snapshots']) assert.ok(tabs.includes(t), t);
    assert.equal(new Set(HISTORY_MANIFEST.map((e) => e.file)).size, HISTORY_MANIFEST.length);
    assert.ok(!tabs.includes('Portfolio') && !tabs.includes('🎯 Watchlist'), 'the Portfolio and Watchlist are the ledger, not history');
    assert.equal(slugTab('📈 Options Reads'), 'options-reads');
  });
  test('rows tabs: one JSON array per row, lossless (numbers stay numbers, trailing blanks dropped)', () => {
    const text = rowsToJsonl([['a', 1, true, null, ''], [new Date('2026-01-02T00:00:00Z')]]);
    assert.equal(text, '["a",1,true]\n["2026-01-02T00:00:00.000Z"]\n');
    assert.deepEqual(jsonlToRows(text), [['a', 1, true], ['2026-01-02T00:00:00.000Z']]);
  });
  test('Script Properties: values copied, secret-shaped ones left out (only the key reported)', () => {
    assert.ok(looksSecret(FAKE_KEY) && looksSecret('-----BEGIN ' + 'PRIVATE KEY-----') && !looksSecret('{"price":12.5}'));
    const kv = kvFromGrid(TABS['💾 Script Properties']!);
    assert.deepEqual(Object.keys(kv.entries), ['CACHE_A']);
    assert.deepEqual(kv.withheld, ['LEAKY', 'GKEY']);
  });
  test('copyHistory writes the files and a manifest without any cell value; a missing tab is listed, not an error', async () => {
    const root = tmp();
    const r = await copyHistory(reader, root, '2026-11-06T00:00:00.000Z');
    const log = r.find((x) => x.tab === '📒 Paper Log')!;
    assert.deepEqual([log.file, log.rows, log.missing], ['history/paper-log.jsonl', 3, false]);
    assert.ok(r.find((x) => x.tab === '📝 Paper State')!.missing);
    const kvText = fs.readFileSync(path.join(root, 'history', 'script-properties.json'), 'utf8');
    assert.ok(kvText.includes('CACHE_A') && !kvText.includes(FAKE_KEY) && !kvText.includes('apikey'));
    const manifest = fs.readFileSync(path.join(root, 'history', 'manifest.json'), 'utf8');
    assert.ok(!manifest.includes('KO') && !manifest.includes('CACHE_A') && /"sha256": "[0-9a-f]{64}"/.test(manifest));
  });
});

describe('file-backed stores (for later; no run uses them)', () => {
  test('FileTabStore reads what was copied (dates on request), and writes like the Sheet store', async () => {
    const root = tmp();
    await copyHistory(reader, root, '2026-11-06T00:00:00.000Z');
    const store = new FileTabStore(root, 'UTC');
    const rows = await store.read('📒 Paper Log', 4, [0]);
    assert.equal(rows!.length, 3);
    assert.ok(rows![1]![0] instanceof Date);
    assert.equal((rows![1]![0] as Date).toISOString().slice(0, 10), '2025-12-09');
    assert.deepEqual(rows![2], [rows![2]![0], 'A', 'KO', -1]);
    assert.equal(await store.read('📈 Paper Values', 2), null);
    assert.equal(await store.ensure('📈 Paper Values'), true);
    await store.write('📈 Paper Values', 2, [['day', 5]]);
    assert.deepEqual(await store.read('📈 Paper Values', 2), [['', ''], ['day', 5]]);
    await store.clear('📈 Paper Values');
    assert.deepEqual(await store.read('📈 Paper Values', 2), []);
  });
  test('FilePropertyStore: get / set / delete, flushed to the same file format', async () => {
    const root = tmp();
    await copyHistory(reader, root, '2026-11-06T00:00:00.000Z');
    const file = path.join(root, 'history', 'script-properties.json');
    const kv = new FilePropertyStore(file, () => Date.parse('2026-11-07T00:00:00Z'));
    assert.equal(await kv.get('CACHE_A'), '{"x":1}');
    await kv.set('NEW', 'v');
    await kv.delete('CACHE_A');
    kv.flush();
    const again = new FilePropertyStore(file);
    assert.equal(await again.get('NEW'), 'v');
    assert.equal(await again.get('CACHE_A'), null);
  });
});

describe('npm run ledger-history', () => {
  test('prints counts per tab, never a value; secret-shaped keys named', async () => {
    const root = tmp(), out: string[] = [];
    assert.equal(await ledgerHistory({ env: {}, argv: ['--out', root], out: (l) => out.push(l), readTab: reader, now: () => 0 }), 0);
    const text = out.join('\n');
    assert.match(text, /📒 Paper Log -> history\/paper-log\.jsonl: 3 row\(s\)/);
    assert.match(text, /💾 Script Properties -> history\/script-properties\.json: 1 key\(s\), \d+ bytes; 2 secret-shaped value\(s\) left out, keys: LEAKY, GKEY/);
    assert.ok(!text.includes('{"x":1}') && !text.includes(FAKE_KEY));
  });
  test('configuration missing: exit 2', async () => {
    const out: string[] = [];
    assert.equal(await ledgerHistory({ env: {}, argv: [], out: (l) => out.push(l) }), 2);
    assert.equal(await ledgerHistory({ env: {}, argv: ['--out', tmp()], out: (l) => out.push(l) }), 2);
    assert.match(out.join('\n'), /missing GOOGLE_SERVICE_ACCOUNT_JSON, SPREADSHEET_ID/);
  });
});
