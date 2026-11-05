/**
 * GENERIC_PLAN P4: the history numbers live in a per-profile results pack, not in the core. This file runs in its own
 * process with PROFILE_JSON = the EXAMPLE profile (no `results`), so every analysis page prints NO_HISTORY instead of
 * figures. The owner's pages (pack owner-2026-10) are pinned by the goldens and the fl17e / fl19* tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';

process.env.PROFILE_JSON = JSON.stringify(EXAMPLE_PROFILE_INPUT);
delete process.env.PROFILE_FILE;

/** A history figure: three signed percents ("+1% / +2% / -3%") or a "+12% vs +34%" comparison. */
const FIGURES = /[+-]\d+% \/ [+-]\d+%|[+-]\d{2,}% vs [+-]\d+%/;

/** 2,600 rising, wavy daily bars (enough for every page's longest average). */
function bars(): { dates: string[]; opens: number[]; closes: number[]; highs: number[]; lows: number[]; volumes: number[] } {
  const dates: string[] = [], closes: number[] = [];
  const d0 = Date.UTC(2016, 0, 4);
  for (let i = 0; i < 2600; i++) {
    dates.push(new Date(d0 + i * 86_400_000).toISOString().slice(0, 10));
    closes.push(100 * Math.exp(i * 0.0006) * (1 + 0.25 * Math.sin(i / 60)));
  }
  return { dates, opens: closes.map((c) => c * 0.999), closes, highs: closes.map((c) => c * 1.01), lows: closes.map((c) => c * 0.99), volumes: closes.map(() => 1e6) };
}

describe('P4 — results pack (example profile: none)', async () => {
  const results = await import('../src/profile/results.ts');
  const rp = await import('../src/analysis/reportPages.ts');
  const j1 = await import('../src/analysis/jamesPages.ts');
  const j2 = await import('../src/analysis/jamesPhase2Pages.ts');
  const j3 = await import('../src/analysis/jamesPhase3Pages.ts');
  const j4 = await import('../src/analysis/jamesPhase4Pages.ts');
  const j5 = await import('../src/analysis/jamesPhase5Pages.ts');

  test('no pack: no history anywhere, the note says so', () => {
    assert.equal(results.RESULTS, null);
    for (const h of [j1.JAMES_HISTORY, j2.JAMES2_HISTORY, j3.JAMES3_HISTORY, j4.JAMES4_HISTORY, j5.JAMES5_HISTORY]) assert.equal(h, null);
    assert.ok(Object.values(rp.MODEL_SIMULATION).every((m) => m.history === '—'));
    assert.equal(rp.SIMULATION_NOTE, results.NO_HISTORY);
    assert.deepEqual(rp.REFERENCE_ROWS, []);
    const page = rp.formatAllModelsPage('AAPL', rp.allModelsRows({ decision: null, techPlan: null, fund: null, comparison: null, extra: null, lilo: null }));
    assert.ok(page.includes(results.NO_HISTORY) && !FIGURES.test(page), page);
  });

  test('every James page prints the placeholder, never a figure', () => {
    const b = bars();
    const layers = j1.buildJamesReads(b, '10y');
    const pages = [
      j1.formatLiloV2Page('AAPL', layers.liloV2), j1.formatProfitTakingPage('AAPL', layers.profitTaking),
      j2.formatMeanRevPage('AAPL', j2.buildMeanRevRead(b)),
      j2.formatPairPage('AAPL', j2.buildPairRead('AAPL', b, () => b)),
      j2.formatWinnersPage('AAPL', j2.buildWinnersRead('AAPL', b, null)),
      j3.formatCyclePage('AAPL', j3.buildCycleRead(b, '10y', b, null)), j3.formatMmPage('AAPL', j3.buildMmRead(b)),
      j5.formatQualityGatePage('AAPL', j5.buildQualityRead('AAPL', b, null)),
    ];
    for (const p of pages) assert.ok(!FIGURES.test(p), p);
    const withHistory = pages.filter((p) => p.includes(results.NO_HISTORY)).length;
    assert.ok(withHistory >= 6, 'pages that reached their history section: ' + withHistory);
  });

  test('a named pack loads from RESULTS_DIR; a missing or bad one refuses with one plain line', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'p4-'));
    assert.throws(() => results.loadResultsPack('nope', dir), /could not be read/);
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ name: 'bad', basis: { list: 'x', holdList: 'y', tax: 1 } }));
    assert.throws(() => results.loadResultsPack('bad', dir), /is not valid: .*section models is missing.*every value must be text/);
    assert.throws(() => results.loadResultsPack('../x', dir), /not valid/);
  });

  test('the core holds no history figure (src/analysis, src/reports)', () => {
    const root = path.resolve(import.meta.dirname, '..', 'src');
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith('.ts')) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (FIGURES.test(l)) hits.push(path.relative(root, f) + ':' + (i + 1)); });
      }
    };
    walk(path.join(root, 'analysis'));
    walk(path.join(root, 'reports'));
    assert.deepEqual(hits, []);
  });
});
