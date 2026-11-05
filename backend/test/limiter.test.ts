import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyLimiter, RateLimiter, HOST_CONCURRENCY } from '../src/sheets/limiter.ts';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test('ConcurrencyLimiter never exceeds its global ceiling', async () => {
  const limiter = new ConcurrencyLimiter(3);
  let inFlight = 0;
  let observedMax = 0;

  await limiter.map(Array.from({ length: 20 }, (_, i) => i), 'host', async () => {
    inFlight++;
    observedMax = Math.max(observedMax, inFlight);
    await tick();
    inFlight--;
  });

  assert.ok(observedMax <= 3, `expected <= 3 concurrent, saw ${observedMax}`);
  assert.equal(limiter.peakConcurrency(), observedMax);
});

test('a per-host ceiling is tighter than the global one', async () => {
  // The real case: SEC throttled this project under 18 concurrent large
  // downloads (dataLayerV1.gs:819-825).
  const limiter = new ConcurrencyLimiter(10, { 'data.sec.gov': 3 });
  let secInFlight = 0;
  let secMax = 0;

  await limiter.map(Array.from({ length: 18 }, (_, i) => i), 'data.sec.gov', async () => {
    secInFlight++;
    secMax = Math.max(secMax, secInFlight);
    await tick();
    secInFlight--;
  });

  assert.ok(secMax <= 3, `SEC ceiling breached: ${secMax} concurrent`);
  assert.equal(limiter.peakFor('data.sec.gov'), secMax);
});

test('a tight host does not throttle unrelated hosts', async () => {
  const limiter = new ConcurrencyLimiter(8, { 'data.sec.gov': 1 });
  let otherMax = 0;
  let otherInFlight = 0;

  await Promise.all([
    limiter.map([1, 2, 3], 'data.sec.gov', async () => { await tick(); }),
    limiter.map([1, 2, 3, 4], 'finnhub.io', async () => {
      otherInFlight++;
      otherMax = Math.max(otherMax, otherInFlight);
      await tick();
      otherInFlight--;
    }),
  ]);

  assert.ok(otherMax > 1, 'an unrelated host should still run in parallel');
});

test('a rejection does not leak a concurrency slot', async () => {
  const limiter = new ConcurrencyLimiter(2);
  await Promise.allSettled([
    limiter.run('h', async () => { throw new Error('fail'); }),
    limiter.run('h', async () => { throw new Error('fail'); }),
    limiter.run('h', async () => { throw new Error('fail'); }),
  ]);
  // If the finally block did not release, this would hang rather than resolve.
  const done = await limiter.run('h', async () => 'ok');
  assert.equal(done, 'ok');
});

test('RateLimiter hands out its initial burst then makes callers wait', async () => {
  let now = 0;
  let slept = 0;
  const rl = new RateLimiter(3, 3 / 60_000, () => now, async (ms) => { slept += ms; now += ms; });

  await rl.acquire();
  await rl.acquire();
  await rl.acquire();
  assert.equal(slept, 0, 'the initial burst is free');

  await rl.acquire();
  assert.ok(slept > 0, 'the fourth call must wait for a refill');
});

test('per-minute helper is configured for the real binding quota', () => {
  // Sheets allows 300/min/project but only 60/min/user/project. A service
  // account is one user, so 60 is what binds -- 50 leaves headroom.
  const rl = RateLimiter.perMinute(50, () => 0);
  assert.equal(rl.availableTokens(), 50);
  assert.equal(HOST_CONCURRENCY['data.sec.gov'], 3);
});
