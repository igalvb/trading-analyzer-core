/**
 * FL-18a (James's models, phase 0, G2): James's Black-Scholes sheet as code. Every vector below is a cached value of
 * the sheets (plan 04 section 2.1: "BS OPM - Generic" JETS cases C/G/K/O, the 2023 covered-call file's r = 2/3/4/5%
 * row, and the Spin example), matched to 1e-4 or to the sheet's shown precision.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bsCall, bsGreeks, bsPutCheck, bsSheet, impliedVol, normCdf, realizedVol, yearsFromDays } from '../src/analysis/options/blackScholes.ts';

const near = (got: number, want: number, tol: number, what: string): void => assert.ok(Math.abs(got - want) <= tol, what + ': got ' + got + ', want ' + want + ' ±' + tol);

// [case, days, K, S, sigma, r, call, delta, gamma, theta per year, vega per 1.00, rho per 1.00]
const JETS: Array<[string, number, number, number, number, number, number, number, number, number, number, number]> = [
  ['C', 90, 22, 22, 0.39, 0.01, 1.7222, 0.5436, 0.0931, -3.528, 4.332, 2.524],
  ['G', 90, 23, 22, 0.28, 0.02, 0.8503, 0.4150, 0.1275, -2.584, 4.259, 2.042],
  ['K', 120, 21, 22, 0.50, 0.03, 3.0886, 0.6331, 0.0597, -3.937, 4.750, 3.564],
  ['O', 120, 24, 22, 0.50, 0.03, 1.8191, 0.4500, 0.0628, -4.039, 4.993, 2.656],
];

describe('FL-18a — G2 Black-Scholes, the sheet port', () => {
  test('JETS cases C, G, K, O: call and every greek in the sheet units', () => {
    for (const [c, days, K, S, sigma, r, call, delta, gamma, theta, vega, rho] of JETS) {
      const p = { T: yearsFromDays(days), K, S, sigma, r };
      const g = bsGreeks(p);
      near(bsCall(p), call, 1e-4, c + ' call');
      near(g.delta, delta, 1e-4, c + ' delta');
      near(g.gamma, gamma, 1e-4, c + ' gamma');
      near(g.thetaPerYear, theta, 1e-3, c + ' theta/yr');
      near(g.vegaPer1, vega, 1e-3, c + ' vega/1.00');
      near(g.rhoPer1, rho, 1e-3, c + ' rho/1.00');
    }
  });

  test('the 2023 file: the same four cases at r = 2 / 3 / 4 / 5%', () => {
    const want = [1.7475, 0.8709, 3.1243, 1.8727];
    JETS.forEach(([c, days, K, S, sigma], i) => near(bsCall({ T: days / 365, K, S, sigma, r: [0.02, 0.03, 0.04, 0.05][i]! }), want[i]!, 1e-4, c));
  });

  test('the Spin example: call, intrinsic, speculative premium (% of price, per day) and greeks in both unit sets', () => {
    const x = bsSheet({ T: 26 / 365, K: 280, S: 283.40, sigma: 0.387, r: 0.021 }, 26);
    near(x.call, 13.603, 1e-3, 'call');
    near(x.intrinsic, 3.40, 1e-9, 'intrinsic');
    near(x.specPremium, 10.203, 1e-3, 'spec premium');
    near(x.specPctOfPrice * 100, 3.60, 5e-3, 'spec % of price');
    near(x.specPerDay!, 0.392, 1e-3, 'spec per day');
    near(x.delta, 0.5726, 1e-4, 'delta');
    near(x.gamma, 0.01340, 1e-5, 'gamma');
    near(x.thetaPerYear, -83.73, 1e-2, 'theta/yr');
    near(x.thetaPerDay, -0.229, 1e-3, 'theta/day');
    near(x.vegaPer1, 29.67, 1e-2, 'vega/1.00');
    near(x.vegaPerPoint, 0.297, 1e-3, 'vega/point');
    near(x.rhoPer1, 10.59, 1e-2, 'rho/1.00');
    near(x.callPerContract, 1360.3, 0.05, 'per contract');
  });

  test('units are labelled and consistent: per day = per year / 365, per point = per 1.00 / 100', () => {
    const g = bsGreeks({ T: 0.5, K: 100, S: 110, sigma: 0.4, r: 0.03 });
    assert.equal(g.thetaPerDay, g.thetaPerYear / 365);
    assert.equal(g.vegaPerPoint, g.vegaPer1 / 100);
    assert.equal(g.rhoPerPoint, g.rhoPer1 / 100);
    assert.deepEqual(Object.keys(g).sort(), ['delta', 'gamma', 'rhoPer1', 'rhoPerPoint', 'thetaPerDay', 'thetaPerYear', 'vegaPer1', 'vegaPerPoint']);
  });

  test('put-call parity holds on every case (the put is a check only)', () => {
    for (const [, days, K, S, sigma, r] of JETS) {
      const p = { T: days / 365, K, S, sigma, r };
      near(bsPutCheck(p).put - bsCall(p), K * Math.exp(-r * p.T) - S, 1e-12, 'parity');
      near(bsPutCheck(p).delta, bsGreeks(p).delta - 1, 1e-12, 'put delta');
    }
  });

  test('normCdf against reference values, tails included', () => {
    const ref: Array<[number, number]> = [[0, 0.5], [1, 0.8413447460685429], [-1, 0.15865525393145707], [1.96, 0.9750021048517795], [-3, 0.0013498980316301], [3.5, 0.9997673709209645], [-6, 9.865876450376946e-10], [-8, 6.22096057427178e-16]];
    for (const [x, p] of ref) near(normCdf(x), p, Math.max(1e-7 * p, 1e-15), 'N(' + x + ')');
    assert.equal(normCdf(40), 1);
    assert.equal(normCdf(-40), 0);
  });

  test('impliedVol: round trip on a grid; GOOG Jan 2022 $1000 call at $190 is 34.0%; impossible prices give null', () => {
    for (const S of [50, 100, 250]) for (const K of [0.8, 1, 1.25]) for (const T of [0.1, 1, 2]) for (const sigma of [0.15, 0.45, 1.2]) {
      const p = { T, K: K * S, S, r: 0.02 };
      const price = bsCall({ ...p, sigma });
      if (price < 1e-6) continue;
      near(impliedVol(price, p)!, sigma, 1e-4, 'S ' + S + ' K ' + K * S + ' T ' + T + ' sigma ' + sigma);
    }
    near(impliedVol(190, { T: 672 / 365, K: 1000, S: 1000, r: 0.01 })!, 0.340, 0.001, 'GOOG');
    assert.equal(impliedVol(5, { T: 0.5, K: 100, S: 110, r: 0.02 }), null, 'below intrinsic');
    assert.equal(impliedVol(120, { T: 0.5, K: 100, S: 110, r: 0.02 }), null, 'above the stock');
    assert.equal(impliedVol(0, { T: 0.5, K: 100, S: 110, r: 0.02 }), null);
  });

  test('realizedVol: a constant series is 0; a known series matches the hand calculation; too short is null', () => {
    assert.equal(realizedVol(Array(30).fill(100), 20), 0);
    // log returns +ln(1.1), -ln(1.1) alternating: mean 0, sample SD = ln(1.1) * sqrt(n/(n-1))
    const closes = [100, 110, 100, 110, 100];
    near(realizedVol(closes, 4)!, Math.log(1.1) * Math.sqrt(4 / 3) * Math.sqrt(252), 1e-12, 'hand');
    assert.equal(realizedVol(closes, 5), null);
    // only the last n + 1 closes count
    assert.equal(realizedVol([1, 1000, 100, 100, 100], 2), 0);
  });
});
