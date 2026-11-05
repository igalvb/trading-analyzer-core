import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadResearchFees } from '../src/live/researchFees.ts';

test('no results pack or no fees file = null (the fee report has no research run)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fees-'));
  assert.equal(loadResearchFees(null, dir), null);
  assert.equal(loadResearchFees('someone', dir), null);
});

test('a fees file next to the pack is read; a file without rows is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fees-'));
  fs.writeFileSync(path.join(dir, 'u2.fees.json'), JSON.stringify({ generatedOn: '2026-01-01', startValue: 1000, note: 'n', rows: [] }));
  assert.equal(loadResearchFees('u2', dir)?.generatedOn, '2026-01-01');
  fs.writeFileSync(path.join(dir, 'bad.fees.json'), '{}');
  assert.throws(() => loadResearchFees('bad', dir), /not valid/);
});
