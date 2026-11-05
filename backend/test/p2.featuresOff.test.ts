/**
 * GENERIC_PLAN P2 (C20-C22): a profile with the paper test and My Options switched off. Own process (node --test
 * isolates files): PROFILE_JSON is set before anything is imported.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';

process.env.PROFILE_JSON = JSON.stringify({ ...EXAMPLE_PROFILE_INPUT, features: { paper: false, liveBot: false, myOptions: false } });
delete process.env.PROFILE_FILE;

describe('P2 — features off', async () => {
  const st = await import('../src/jobs/nightly/steps.ts');
  const { myOptionsMain } = await import('../src/myOptions.ts');

  test('the nightly keeps every step but the paper test and the live dry run', () => {
    assert.deepEqual(st.NIGHTLY_ORDER, st.ALL_NIGHTLY_STEPS.map((s) => s.id).filter((id) => id !== 'paper.trade' && id !== 'live.dryRun'));
  });
  test('My Options off: one plain line, exit 0, nothing composed', async () => {
    const out: string[] = [];
    const code = await myOptionsMain(['--memory'], { out: (s: string) => { out.push(s); }, err: () => { throw new Error('nothing should log'); }, env: {} } as never);
    assert.equal(code, 0);
    assert.deepEqual(out, ['My Options is off in the profile (features.myOptions); nothing done.\n']);
  });
});
