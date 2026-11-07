import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PriceSeries } from '../src/backtest/data.ts';
import { indicators, washoutAt, exitCAt, exitX1At, bottomThirdRet, run, stepTargets, tiersAt, normalise, closeForZ, WASHOUTS, MAX_STEP, X1_FALL_BARS, type Rule } from '../src/research/washoutRotationLab.ts';

function weekdays(from: string, n: number): string[] {
  const out: string[] = []; let t = Date.parse(from + 'T00:00:00Z');
  while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10)); t += 86_400_000; }
  return out;
}
function mk(ticker: string, closes: number[], dates = weekdays('2014-01-01', closes.length)): PriceSeries {
  return { ticker, dates, opens: closes.map((c, i) => (i ? (c + closes[i - 1]!) / 2 : c)), highs: closes, lows: closes, closes, volumes: closes.map(() => 1), splits: [] };
}
function walk(seed: number, n: number, drift = 0.0005, vol = 0.025): number[] {
  let s = seed, p = 100; const out: number[] = [];
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) % 2147483648; const u = s / 2147483648 - 0.5; p *= 1 + drift + vol * u * 2; out.push(p); }
  return out;
}
const cut = (s: PriceSeries, k: number): PriceSeries => ({ ...s, dates: s.dates.slice(0, k + 1), opens: s.opens.slice(0, k + 1), highs: s.highs.slice(0, k + 1), lows: s.lows.slice(0, k + 1), closes: s.closes.slice(0, k + 1), volumes: s.volumes.slice(0, k + 1) });

/** 300 bars of a steady rise (150-day average rising), then a 30% fall over 6 bars, then a recovery. */
function washoutShape(): number[] {
  const c: number[] = [];
  for (let i = 0; i < 300; i++) c.push(100 * 1.002 ** i + (i % 2 ? 0.3 : -0.3));
  const top = c[c.length - 1]!;
  for (let k = 1; k <= 6; k++) c.push(top * (1 - 0.05 * k));
  const low = c[c.length - 1]!;
  for (let k = 1; k <= 40; k++) c.push(low * (1 + 0.01 * k));
  return c;
}

test('W1 fires on a sharp fall in a rising stock; W3 also fires in a falling stock where W1 does not', () => {
  const s = mk('AAA', washoutShape()), ind = indicators(s);
  const fired = s.dates.map((_, i) => washoutAt(ind, i, WASHOUTS.W1));
  const first = fired.indexOf(true);
  assert.ok(first >= 300 && first <= 305, 'W1 fires during the fall, at bar ' + first);
  assert.ok(ind.z[first]! <= -2.5 && s.closes[first]! <= 0.8 * ind.hi252[first]! && ind.dir150[first] === 1);
  assert.equal(fired.slice(0, 300).some(Boolean), false, 'no signal in the steady rise');
  // a long decline then a sharp fall: the 150-day average falls, so W1 is off and W3 is on
  const d: number[] = []; for (let i = 0; i < 300; i++) d.push(200 * 0.998 ** i + (i % 2 ? 0.2 : -0.2));
  const t = d[d.length - 1]!; for (let k = 1; k <= 6; k++) d.push(t * (1 - 0.05 * k));
  const i2 = indicators(mk('BBB', d)), last = d.length - 1;
  assert.equal(washoutAt(i2, last, WASHOUTS.W1), false);
  assert.equal(washoutAt(i2, last, WASHOUTS.W3), true);
  assert.equal(i2.dir150[last], -1);
});

test('no look-ahead: every daily value at bar k is the same when the history is cut at k', () => {
  const s = mk('AAA', walk(7, 700, 0.0003, 0.04)), full = indicators(s);
  for (let k = 170; k < 700; k += 13) {
    const c = indicators(cut(s, k));
    for (const key of ['W1', 'W2', 'W3'] as const) assert.equal(washoutAt(c, k, WASHOUTS[key]), washoutAt(full, k, WASHOUTS[key]), key + ' at ' + k);
    assert.equal(c.z[k], full.z[k]); assert.equal(c.dir150[k], full.dir150[k]); assert.equal(c.hi252[k], full.hi252[k]); assert.equal(c.fallRun[k], full.fallRun[k]);
    if (full.weekEnd[k] && c.weekEnd[k]) assert.equal(exitCAt(c, k), exitCAt(full, k));
  }
});

test('no look-ahead in the accounts: changing every bar after day X leaves every trade up to the open after X unchanged', () => {
  const n = 900, names = ['AAA', 'BBB', 'CCC', 'DDD'];
  const base = new Map(names.map((t, j) => [t, mk(t, walk(11 + j * 7, n, 0.0004 * (j + 1), 0.03 + 0.01 * j))]));
  const qqq = mk('QQQ', walk(99, n, 0.0004, 0.015));
  const X = 700, dX = qqq.dates[X]!, dNext = qqq.dates[X + 1]!;
  const scramble = (s: PriceSeries): PriceSeries => { const c = s.closes.map((v, i) => (i > X ? v * (i % 3 ? 0.6 : 1.7) : v)); return { ...s, closes: c, opens: s.opens.map((v, i) => (i > X + 1 ? c[i]! : v)), highs: c, lows: c }; };
  const other = new Map([...base].map(([t, s]) => [t, scramble(s)]));
  const rules: Rule[] = [
    { kind: 'washout', signal: 'W2', exit: 'C' }, { kind: 'washout', signal: 'W3', exit: 'D' },
    { kind: 'rotation', speed: 'R', trims: false, washout: false }, { kind: 'rotation', speed: 'RS', trims: true, washout: true },
    { kind: 'rotation', speed: 'RB', trims: false, washout: true }, { kind: 'rotation', speed: 'RSw', trims: true, washout: false },
  ];
  let diff = 0;
  for (const r of rules) {
    const a = run(r, { series: base, qqq, bag: names }, qqq.dates[300]!, qqq.dates[n - 1]!);
    const b = run(r, { series: other, qqq: scramble(qqq), bag: names }, qqq.dates[300]!, qqq.dates[n - 1]!);
    const upTo = (log: string[]): string[] => log.filter((l) => l.slice(0, 10) <= dNext);
    assert.ok(a.log.length > 0, r.kind + ' trades');
    assert.deepEqual(upTo(a.log), upTo(b.log), JSON.stringify(r));
    if (JSON.stringify(a.log) !== JSON.stringify(b.log)) diff++;
    assert.ok(dX < dNext);
  }
  assert.ok(diff >= 4, 'the changed future does change later trades (' + diff + ' of ' + rules.length + ' rules)');
});

test('W1 buys in 3 slices: at the signal, back above -2 SD, back above the 20-day average; D never sells', () => {
  const s = mk('AAA', washoutShape()), ind = indicators(s);
  const qqq = mk('QQQ', s.closes.map((_, i) => 100 + i * 0.01));
  const r = run({ kind: 'washout', signal: 'W1', exit: 'D' }, { series: new Map([['AAA', s]]), qqq, bag: ['AAA'] }, s.dates[200]!, s.dates[s.dates.length - 1]!);
  const buys = r.log.filter((l) => l.includes(' B AAA'));
  assert.equal(buys.length, 3, buys.join('\n'));
  const sig = s.dates.findIndex((_, i) => washoutAt(ind, i, WASHOUTS.W1));
  assert.equal(buys[0]!.slice(0, 10), s.dates[sig + 1]);
  const i2 = s.dates.findIndex((_, i) => i > sig && ind.z[i]! > -2);
  const i3 = s.dates.findIndex((_, i) => i >= i2 && s.closes[i]! > ind.sma20[i]!);
  assert.equal(buys[1]!.slice(0, 10), s.dates[i2 + 1]);
  assert.equal(buys[2]!.slice(0, 10), s.dates[i3 + 1]);
  assert.equal(r.log.filter((l) => l.includes(' S AAA')).length, 0);
  // each slice is 1/15 of the account
  const amt = Number(buys[0]!.split(' ')[3]);
  assert.ok(amt > 100_000 / 15 * 0.9 && amt < 100_000 / 15 * 1.2, String(amt));
});

test('targets move at most 5 points per rebalance; tiers 2x / 1x / 0.5x by thirds', () => {
  const prev = new Map([['A', 0.5], ['B', 0.5]]), raw = new Map([['A', 0.0], ['B', 0.2], ['C', 0.8]]);
  const t = stepTargets(prev, raw);
  const sum = [...t.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
  // before renormalising: A 0.45, B 0.45, C 0.05
  assert.ok(Math.abs(t.get('A')! - 0.45 / 0.95) < 1e-12 && Math.abs(t.get('C')! - 0.05 / 0.95) < 1e-12);
  assert.ok(MAX_STEP === 0.05);
  const n = 400, names = ['A', 'B', 'C', 'D', 'E', 'F'];
  const ss = names.map((x, j) => mk(x, walk(3 + j, n, 0.0002 * j, 0.01)));
  const q = indicators(mk('QQQ', walk(1, n)));
  const tg = tiersAt('R', names, (x) => ({ ind: indicators(ss[names.indexOf(x)]!), i: n - 1 }), q);
  const counts = [2, 1, 0.5].map((v) => [...tg.tier.values()].filter((x) => x === v).length);
  assert.deepEqual(counts, [2, 2, 2]);
  const w = normalise(tg.tier); assert.ok(Math.abs([...w.values()].reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test('closeForZ: the close that puts the next bar exactly k SD under its 20-day average', () => {
  const s = mk('AAA', walk(5, 60));
  const x = closeForZ(s, 59, 2.5);
  const ind = indicators(mk('AAA', [...s.closes, x]));
  assert.ok(Math.abs(ind.z[60]! + 2.5) < 1e-6, String(ind.z[60]));
});

// ---- Rarer exits (2026-11-07 b) -----------------------------------------------------------------------------------

/** 260 bars rising, then a steady decline for `down` bars to `floor` x the top, then flat. */
function riseThenFall(down: number, floor: number, n = 900): number[] {
  const c: number[] = [];
  for (let i = 0; i < 260; i++) c.push(100 * 1.003 ** i + (i % 2 ? 0.2 : -0.2));
  const top = c[c.length - 1]!, g = floor ** (1 / down);
  for (let k = 1; k <= down; k++) c.push(top * g ** k + (k % 2 ? 0.2 : -0.2));
  while (c.length < n) c.push(c[c.length - 1]! * (c.length % 2 ? 1.001 : 0.999));
  return c;
}

test('X1 fires only at a weekly close, after 126 bars of a falling 150-day average, under the 40-week average', () => {
  const s = mk('AAA', riseThenFall(500, 0.4)), ind = indicators(s);
  const hits = s.dates.map((_, i) => exitX1At(ind, i));
  const first = hits.indexOf(true);
  assert.ok(first > 0, 'X1 fires in the long decline');
  let n = 0;
  for (let i = 0; i < s.dates.length; i++) {
    const want = ind.weekEnd[i]! && ind.fallRun[i]! >= X1_FALL_BARS && ind.w40[ind.weeksDone[i]! - 1] != null && s.closes[i]! < ind.w40[ind.weeksDone[i]! - 1]!;
    assert.equal(hits[i], want, 'bar ' + i); if (want) n++;
  }
  assert.ok(ind.fallRun[first]! >= X1_FALL_BARS && ind.fallRun[first]! < X1_FALL_BARS + 5, 'fires within a week of the 126th falling bar');
  assert.ok(n > 10);
  for (let k = 300; k < 899; k += 17) { const c = indicators(cut(s, k)); if (c.weekEnd[k] && ind.weekEnd[k]) assert.equal(exitX1At(c, k), exitX1At(ind, k), 'cut at ' + k); }
});

test('bottomThirdRet: the round(n/3) lowest 252-bar returns, only stocks with 252 bars', () => {
  const n = 300, names = ['A', 'B', 'C', 'D', 'E', 'F'];
  const ss = new Map(names.map((x, j) => [x, indicators(mk(x, Array.from({ length: n }, (_, i) => 100 * (1 + 0.001 * (j - 2)) ** i)))]));
  assert.deepEqual([...bottomThirdRet(names, (x) => ({ ind: ss.get(x)!, i: n - 1 }))].sort(), ['A', 'B']);
  assert.equal(bottomThirdRet(names, (x) => ({ ind: ss.get(x)!, i: 200 })).size, 0, 'no stock has 252 bars yet');
});

test('X1 sells a stock in a long decline; X2 never sells it under its cost; X3 never sells', () => {
  const qqq = mk('QQQ', Array.from({ length: 900 }, (_, i) => 100 + i * 0.05));
  const go = (closes: number[], exit: 'X1' | 'X2' | 'X3') => {
    const s = mk('AAA', closes, [...qqq.dates]);
    return run({ kind: 'rotation', speed: 'R', trims: false, washout: false, exit }, { series: new Map([['AAA', s]]), qqq, bag: ['AAA'] }, qqq.dates[220]!, qqq.dates[899]!);
  };
  const below = riseThenFall(500, 0.4), cost = below[221]!;
  const a1 = go(below, 'X1'), a2 = go(below, 'X2'), a3 = go(below, 'X3');
  assert.ok(a1.exits.length >= 1, 'X1 exits');
  assert.ok(a1.exits[0]!.price < cost, 'X1 sold under the buy price');
  assert.equal(a2.exits.length, 0, 'X2 keeps a lot at a loss');
  assert.equal(a2.log.filter((l) => l.includes(' S ')).length, 0);
  assert.equal(a3.log.filter((l) => l.includes(' S ')).length, 0, 'X3 never sells');
  // a decline that stays above the cost: X2 sells on the same day as X1, at a gain
  const above = riseThenFall(500, 0.92), b1 = go(above, 'X1'), b2 = go(above, 'X2');
  assert.ok(b1.exits.length >= 1, 'X1 exits in the mild decline too');
  assert.equal(b2.exits[0]!.date, b1.exits[0]!.date);
  assert.ok(b2.exits[0]!.price > above[221]! && !b2.exits[0]!.partial);
});

test('X2 never realises a loss on a stock, sells only the lots in profit (some exits partial); X1 does sell at a loss', () => {
  const n = 1600, names = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  const qqq = mk('QQQ', walk(99, n, 0.0004, 0.015));
  const series = new Map(names.map((t, j) => [t, mk(t, walk(1 + j * 7, n, 0.0012 - 0.0005 * j, 0.035), [...qqq.dates])]));
  const go = (exit: 'X1' | 'X2') => run({ kind: 'rotation', speed: 'R', trims: false, washout: true, exit }, { series, qqq, bag: names }, qqq.dates[300]!, qqq.dates[n - 1]!);
  const x1 = go('X1'), x2 = go('X2');
  assert.ok(x1.exits.length >= 1 && x1.lossSales >= 1, 'X1 sells at a loss here (' + x1.lossSales + ')');
  assert.ok(x2.exits.length >= 1, 'X2 exits');
  assert.equal(x2.lossSales, 0, 'X2 never sells a stock under its cost');
  assert.ok(x2.exits.some((e) => e.partial), 'some X2 exit kept lots at a loss');
});

test('X4 exits only at quarter ends, after 4 quarters in the bottom third of 12-month returns, with the 150-day falling', () => {
  const n = 1600, names = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  const qqq = mk('QQQ', walk(99, n, 0.0004, 0.015));
  const series = new Map(names.map((t, j) => [t, mk(t, walk(21 + j * 5, n, 0.0012 - 0.0005 * j, 0.02), [...qqq.dates])]));
  const r = run({ kind: 'rotation', speed: 'R', trims: false, washout: false, exit: 'X4' }, { series, qqq, bag: names }, qqq.dates[300]!, qqq.dates[n - 1]!);
  assert.ok(r.exits.length >= 1, 'some X4 exit in the test set');
  const inds = new Map([...series].map(([t, s]) => [t, indicators(s)]));
  const qEnds = qqq.dates.filter((d, i) => i >= 299 && i < n - 1 && qqq.dates[i + 1]!.slice(0, 7) !== d.slice(0, 7) && ['03', '06', '09', '12'].includes(d.slice(5, 7)));
  for (const e of r.exits) {
    const di = qqq.dates.indexOf(e.date) - 1, d = qqq.dates[di]!;
    assert.ok(qEnds.includes(d), 'decided at a quarter end: ' + d);
    assert.equal(inds.get(e.t)!.dir150[di], -1);
    const k = qEnds.indexOf(d);
    assert.ok(k >= 3);
    for (const qd of qEnds.slice(k - 3, k + 1)) assert.ok(bottomThirdRet(names, (t) => ({ ind: inds.get(t)!, i: qqq.dates.indexOf(qd) })).has(e.t), e.t + ' bottom third at ' + qd);
  }
});

test('no look-ahead with the rarer exits: changing every bar after day X leaves every trade up to the open after X unchanged', () => {
  const n = 1300, names = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  const qqq = mk('QQQ', walk(99, n, 0.0004, 0.015));
  const base = new Map(names.map((t, j) => [t, mk(t, walk(21 + j * 5, n, 0.0012 - 0.0005 * j, 0.03), [...qqq.dates])]));
  const X = 1000, dNext = qqq.dates[X + 1]!;
  const scramble = (s: PriceSeries): PriceSeries => { const c = s.closes.map((v, i) => (i > X ? v * (i % 3 ? 0.6 : 1.7) : v)); return { ...s, closes: c, opens: s.opens.map((v, i) => (i > X + 1 ? c[i]! : v)), highs: c, lows: c }; };
  const other = new Map([...base].map(([t, s]) => [t, scramble(s)]));
  let diff = 0, exits = 0;
  for (const exit of ['X1', 'X2', 'X3', 'X4'] as const) for (const washout of [false, true]) {
    const rule: Rule = { kind: 'rotation', speed: 'R', trims: false, washout, exit };
    const a = run(rule, { series: base, qqq, bag: names }, qqq.dates[300]!, qqq.dates[n - 1]!);
    const b = run(rule, { series: other, qqq: scramble(qqq), bag: names }, qqq.dates[300]!, qqq.dates[n - 1]!);
    const upTo = (log: string[]): string[] => log.filter((l) => l.slice(0, 10) <= dNext);
    assert.deepEqual(upTo(a.log), upTo(b.log), JSON.stringify(rule));
    if (JSON.stringify(a.log) !== JSON.stringify(b.log)) diff++;
    exits += a.exits.filter((e) => e.date <= dNext).length;
  }
  assert.ok(diff >= 4, 'the changed future changes later trades (' + diff + ' of 8)');
  assert.ok(exits >= 1, 'some exit happens before X, so exits are covered');
});
