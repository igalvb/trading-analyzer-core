import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, backoffMs, TimeoutError, statusOf, messageOf } from '../src/core/errors.ts';

test('HTTP statuses classify correctly', () => {
  for (const s of [429, 500, 502, 503, 504, 408]) {
    assert.equal(classify(Object.assign(new Error('x'), { status: s })), 'transient', `status ${s}`);
  }
  for (const s of [400, 401, 403, 404, 422]) {
    assert.equal(classify(Object.assign(new Error('x'), { status: s })), 'permanent', `status ${s}`);
  }
});

test('network error codes are transient', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']) {
    assert.equal(classify(Object.assign(new Error('net'), { code })), 'transient', code);
  }
});

test('rate limiting is detected from the body when the status does not say so', () => {
  // Real case: FMP signals throttling with "Limit Reach" in the body
  // (dataLayerV1.gs:1134), not always a 429.
  assert.equal(classify(new Error('Limit Reach - upgrade your plan')), 'transient');
  assert.equal(classify(new Error('Quota exceeded for this project')), 'transient');
});

test('unrecognised failures default to unknown (which retries once)', () => {
  assert.equal(classify(new Error('something strange happened')), 'unknown');
});

test('a timeout is always transient', () => {
  assert.equal(classify(new TimeoutError(100, 'step')), 'transient');
});

test('statusOf reads the shapes googleapis actually produces', () => {
  assert.equal(statusOf({ status: 429 }), 429);
  assert.equal(statusOf({ code: 404 }), 404);
  assert.equal(statusOf({ response: { status: 503 } }), 503);
  assert.equal(statusOf(new Error('no status')), null);
  assert.equal(statusOf({ code: 'ECONNRESET' }), null, 'a string code is not a status');
});

test('backoff grows exponentially, is jittered, and is capped', () => {
  const noJitter = (): number => 0;
  assert.equal(backoffMs(1, 1000, 32_000, noJitter), 1000);
  assert.equal(backoffMs(2, 1000, 32_000, noJitter), 2000);
  assert.equal(backoffMs(3, 1000, 32_000, noJitter), 4000);
  assert.equal(backoffMs(20, 1000, 32_000, noJitter), 32_000, 'capped');
  assert.ok(backoffMs(1, 1000, 32_000, () => 0.5) > backoffMs(1, 1000, 32_000, noJitter), 'jitter applied');
});

test('messageOf never throws on odd inputs', () => {
  assert.equal(messageOf(new Error('hi')), 'hi');
  assert.equal(messageOf('plain'), 'plain');
  assert.equal(messageOf({ message: 'obj' }), 'obj');
  assert.equal(messageOf(null), 'null');
});
