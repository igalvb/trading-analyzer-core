/** FL-16a: the Wyckoff model (original method) on a textbook accumulation and a textbook distribution. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { wyckoffClassicSeries, type WyckoffBars } from '../src/analysis/models/wyckoffClassic.ts';

/** Builds bars from [open, high, low, close, volume] rows. */
function bars(rows: Array<[number, number, number, number, number]>): WyckoffBars {
  return { opens: rows.map((r) => r[0]), highs: rows.map((r) => r[1]), lows: rows.map((r) => r[2]), closes: rows.map((r) => r[3]), volumes: rows.map((r) => r[4]) };
}
const flat = (n: number, p: number, vol = 1000): Array<[number, number, number, number, number]> => Array.from({ length: n }, () => [p, p + 0.5, p - 0.5, p, vol]);

describe('FL-16a — Wyckoff (original method)', () => {
  test('accumulation: SC, AR, ST, spring, test (bullish), SOS (markup), then an LPS', () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 70; i++) { const p = 100 - i * 0.5; rows.push([p + 0.2, p + 0.5, p - 0.5, p, 1000]); } // decline 100 -> 65.5
    rows.push([65, 65.5, 58, 60, 3500]);                       // SC: wide, 3.5x volume, lowest low
    rows.push([60, 63, 59.5, 62.5, 1500], [62.5, 66, 62, 65.5, 1200], [65.5, 68, 65, 67.5, 1100], [67.5, 70, 67, 69.5, 1000]); // rally to 70
    rows.push([69, 69.5, 67, 67.5, 900]);                       // backs off 3.6% from 70: AR = 70
    rows.push(...flat(5, 64, 900));
    rows.push([61, 62, 59, 60.5, 800]);                         // ST: within 3% of 58, less volume than the SC
    rows.push(...flat(10, 63, 900));
    rows.push([59, 60, 56.5, 58.5, 900]);                       // spring: under 58, closes back above
    rows.push([58.5, 60, 58.2, 59.5, 500]);                     // test: holds above the spring low, near support, lighter volume
    rows.push(...flat(5, 64, 900));
    rows.push([66, 72, 65.5, 71.5, 3000]);                      // SOS: close above 70 on 3x volume
    rows.push([71, 71.5, 70.2, 71.2, 600]);                     // LPS: back near 70 on light volume, up close
    const out = wyckoffClassicSeries(bars(rows));
    const ev = out.map((d) => d.event).filter(Boolean);
    assert.deepEqual(ev, ['SC', 'AR', 'ST', 'SPRING', 'TEST', 'SOS', 'LPS']);
    const iTest = out.findIndex((d) => d.event === 'TEST');
    assert.equal(out[iTest]!.direction, 'bullish', 'spring + test = phase C done');
    assert.equal(out[iTest]!.phase, 'C');
    const iSos = out.findIndex((d) => d.event === 'SOS');
    assert.equal(out[iSos]!.context, 'markup');
    assert.equal(out[out.length - 1]!.direction, 'bullish');
  });

  test('distribution: BC, AR, ST, UTAD (cautionary), SOW', () => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 70; i++) { const p = 50 + i * 0.5; rows.push([p - 0.2, p + 0.5, p - 0.5, p, 1000]); } // advance 50 -> 84.5
    rows.push([85, 92, 84.5, 90, 3500]);                       // BC
    rows.push([90, 90.5, 87, 87.5, 1500], [87.5, 88, 84, 84.5, 1200], [84.5, 85, 82, 82.5, 1100]);
    rows.push([83, 85.5, 82.8, 85, 900]);                       // bounces 3%+ off 82: AR = 82
    rows.push(...flat(5, 86, 900));
    rows.push([89, 91, 88, 90, 800]);                           // ST near 92, less volume
    rows.push(...flat(5, 87, 900));
    rows.push([90, 93, 89, 91.5, 900]);                         // UTAD: above 92, closes back under
    rows.push(...flat(5, 86, 900));
    rows.push([84, 84.5, 79, 79.5, 3000]);                      // SOW: close under 82 on 3x volume
    const out = wyckoffClassicSeries(bars(rows));
    assert.deepEqual(out.map((d) => d.event).filter(Boolean), ['BC', 'AR-D', 'ST-D', 'UTAD', 'SOW']);
    assert.equal(out.find((d) => d.event === 'UTAD')!.direction, 'cautionary');
    assert.equal(out[out.length - 1]!.context, 'markdown');
  });

  test('causal: the read for a day never changes when later bars are added', () => {
    const rows = flat(200, 50).map((r, i) => [r[0] + Math.sin(i / 7) * 5, r[1] + Math.sin(i / 7) * 5, r[2] + Math.sin(i / 7) * 5, r[3] + Math.sin(i / 7) * 5, 1000 + (i % 13) * 300] as [number, number, number, number, number]);
    const full = wyckoffClassicSeries(bars(rows));
    const part = wyckoffClassicSeries(bars(rows.slice(0, 120)));
    assert.deepEqual(part, full.slice(0, 120));
  });
});
