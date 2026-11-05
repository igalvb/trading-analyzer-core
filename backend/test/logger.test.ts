import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, LogLevel, type LogLine } from '../src/core/logger.ts';

function capture(): { lines: LogLine[]; sink: (l: LogLine) => void } {
  const lines: LogLine[] = [];
  return { lines, sink: (l) => lines.push(l) };
}

const fixedNow = (): Date => new Date('2026-09-13T00:00:00.000Z');

test('DEBUG is suppressed on a clean run at INFO level', () => {
  const { lines, sink } = capture();
  const log = new Logger({ sink, now: fixedNow });
  log.debug('quiet 1');
  log.debug('quiet 2');
  log.info('visible');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.message, 'visible');
});

test('WARNING retroactively flushes the buffered DEBUG lines', () => {
  const { lines, sink } = capture();
  const log = new Logger({ sink, now: fixedNow });
  log.debug('lead-up A');
  log.debug('lead-up B');
  assert.equal(log.pendingBufferSize(), 2, 'lines should be held, not dropped');

  log.warning('something went wrong');

  const messages = lines.map((l) => l.message);
  assert.ok(messages.some((m) => m.includes('lead-up A')), 'pre-warning DEBUG must be replayed');
  assert.ok(messages.some((m) => m.includes('lead-up B')), 'pre-warning DEBUG must be replayed');
  assert.ok(messages.some((m) => m.includes('something went wrong')));
  assert.equal(log.pendingBufferSize(), 0);
  assert.ok(lines.filter((l) => l.replayed).length === 2, 'replayed lines must be marked');
});

test('escalation is sticky: DEBUG stays visible afterwards', () => {
  const { lines, sink } = capture();
  const log = new Logger({ sink, now: fixedNow });
  log.warning('trigger');
  const before = lines.length;
  log.debug('now visible');
  assert.equal(lines.length, before + 1);
  assert.equal(lines[lines.length - 1]?.level, LogLevel.DEBUG);
});

test('escalation is per-scope: one ticker does not make others verbose', () => {
  const { lines, sink } = capture();
  const root = new Logger({ sink, now: fixedNow });
  const aapl = root.child('AAPL');
  const msft = root.child('MSFT');

  aapl.debug('aapl detail');
  msft.debug('msft detail');

  aapl.warning('aapl problem');

  const replayed = lines.filter((l) => l.replayed).map((l) => l.message);
  assert.deepEqual(replayed, ['aapl detail'], 'only the failing scope replays');
  assert.ok(aapl.isEscalated());
  assert.ok(!msft.isEscalated(), 'sibling scope must stay at INFO');
  assert.ok(!root.isEscalated(), 'child failure must not escalate the root');
  assert.equal(msft.pendingBufferSize(), 1, "sibling's buffer is untouched");
});

test('a child created after escalation inherits it', () => {
  const { sink } = capture();
  const root = new Logger({ sink, now: fixedNow });
  root.error('run-level failure');
  const late = root.child('LATE');
  assert.ok(late.isEscalated());
});

test('scope names nest', () => {
  const { lines, sink } = capture();
  const log = new Logger({ sink, now: fixedNow, scope: 'nightly' }).child('AAPL');
  log.info('hi');
  assert.equal(lines[0]?.scope, 'nightly:AAPL');
});

test('counts are tracked', () => {
  const { sink } = capture();
  const log = new Logger({ sink, now: fixedNow });
  log.debug('a');
  log.info('b');
  log.warning('c');
  log.error('d');
  assert.deepEqual(log.getCounts(), { debug: 1, info: 1, warning: 1, error: 1, critical: 0 });
});
