/**
 * FL-8w: the workflow YAML files against the schedule DATA (src/workflows/schedule.ts).
 * Files are read from the repository root (.github/workflows, one level above backend/)
 * or, if backend/ is its own repository, backend/.github/workflows.
 */

import { describe, test } from 'node:test';
import { NIGHTLY_ORDER } from '../src/jobs/nightly/steps.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_DISPATCH, AI_EFFORT_OPTIONS, AI_INPUTS, ANALYZE_INPUTS, SEND_EXIT_INPUTS, ALLOWED_ACTIONS, ISRAEL_ZONE, ET_ZONE, MY_OPTIONS, MY_OPTIONS_CRON_EDT,
  MY_OPTIONS_CRON_EST, MY_OPTIONS_ET_HOUR, NIGHTLY, NIGHTLY_STEP_ORDER, WORKFLOWS, WORKFLOW_DIR_CANDIDATES,
  cronInstant, cronsThatPassGuard, etHourOf, findSecretLikeText, localClock, parseCron, renderScheduleBlock,
  shouldRunNow, yamlSubsetProblems, MIGRATE_DATA_TABS, MIGRATION_STEPS, MIGRATION_BLOCKED_WINDOWS_UTC, SHEET_WRITER_WORKFLOWS, migrationBlockedWindow,
  OWNER_USER, PER_USER_ENV, PROFILE_STEP_IF, USER_INPUT, groupFor, perUserGroup, perUserSecretLine, secretNameFor,
  SETUP_CHECK, INIT_USER_SHEETS,
  WATCHDOG, WATCHDOG_CRON, VERIFY, NIGHTLY_BACKUP, NIGHTLY_BACKUP_CRONS, NIGHTLY_BACKUP_SINCE_UTC, NIGHTLY_BACKUP_CUTOFF_UTC_HOUR, myOptionsScheduledShouldRun, nightlyBackupAction,
} from '../src/workflows/schedule.ts';
import { DARK_POOL_DAILY_JOBS } from '../src/jobs/darkPool.ts';
import { MY_OPTIONS_DAILY_JOB } from '../src/jobs/myOptions.ts';

const BACKEND_DIR = path.resolve(import.meta.dirname, '..');

// BEGIN-IO
function workflowDir(): string | null {
  for (const rel of WORKFLOW_DIR_CANDIDATES) {
    const dir = path.resolve(BACKEND_DIR, rel);
    if (fs.existsSync(path.join(dir, 'nightly.yml'))) return dir;
  }
  return null;
}
function readWorkflow(file: string): string {
  const dir = workflowDir();
  assert.ok(dir, 'nightly.yml not found in any of: ' + WORKFLOW_DIR_CANDIDATES.join(', ') + ' (relative to backend/)');
  return fs.readFileSync(path.join(dir, file), 'utf8');
}
// END-IO

function envExampleNames(): Set<string> {
  const text = fs.readFileSync(path.join(BACKEND_DIR, '.env.example'), 'utf8');
  return new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string));
}
function cronsIn(text: string): string[] {
  return [...text.matchAll(/^\s*- cron: '([^']+)'\s*$/gm)].map((m) => m[1] as string);
}
function secretRefs(text: string): string[] {
  // `secrets.NAME` (owner-only files) and `secrets[format('{0}NAME', env.SECRET_PREFIX)]` (per-user files, P5).
  return [...text.matchAll(/secrets(?:\.|\[format\('\{0\})([A-Z][A-Z0-9_]*)/g)].map((m) => m[1] as string);
}
/** True when `step` passes the secret `name` (either form). */
function passesSecret(step: string, name: string): boolean {
  return secretRefs(step).includes(name);
}
function jobTimeout(text: string): number | null {
  const m = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(text);
  return m ? Number(m[1]) : null;
}
function stepsOf(text: string): string[] {
  return text.split(/^ {6}- name:/m).slice(1);
}
function stepWith(text: string, needle: string): string {
  const s = stepsOf(text).find((x) => x.includes(needle));
  assert.ok(s, 'no step contains: ' + needle);
  return s;
}
function parseInputs(text: string): Array<{ name: string; type: string; default: string }> {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === '    inputs:');
  assert.ok(start >= 0, 'no inputs: block');
  const out: Array<{ name: string; type: string; default: string }> = [];
  let cur: { name: string; type: string; default: string } | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.trim() !== '' && l.length - l.trimStart().length <= 4) break;
    const head = /^ {6}([a-z_]+):\s*$/.exec(l);
    if (head) { cur = { name: head[1] as string, type: '', default: '' }; out.push(cur); continue; }
    const ty = /^ {8}type:\s*(\S+)/.exec(l);
    if (ty && cur) cur.type = ty[1] as string;
    const df = /^ {8}default:\s*(\S+)/.exec(l);
    if (df && cur) cur.default = df[1] as string;
  }
  return out;
}

describe('FL-8w (a) every workflow file has a sane YAML shape', () => {
  for (const w of WORKFLOWS) {
    test(w.file, () => {
      const text = readWorkflow(w.file);
      assert.deepEqual(yamlSubsetProblems(text), []);
      assert.ok(text.endsWith('\n'), 'file ends with a newline');
      assert.equal(/^ {2}workflow_dispatch:/m.test(text), w.dispatch);
      // record.yml, fetch-files.yml and long-history.yml alone may write: each pushes to its own separate branch (`recordings`, `files`, `prices`), never main.
      const writes = w.file === 'record.yml' || w.file === 'fetch-files.yml' || w.file === 'long-history.yml';
      assert.match(text, writes ? /^permissions:\n {2}contents: write$/m : /^permissions:\n {2}contents: read$/m, 'least-privilege permissions');
      // Row 38: `actions: read` only where the spec says so (nightly: the GitHub minutes line; migration: running writers).
      // Owner 2026-11-04: my-options reads its own runs with the gh CLI (GH_TOKEN); nightly-backup alone may start a workflow (actions: write).
      assert.equal(/^permissions:\n {2}contents: (read|write)\n {2}actions: read$/m.test(text), w.actionsRead === true || w.ghActionsRead === true, 'actions: read only where listed');
      assert.equal(/^permissions:\n {2}contents: read\n {2}actions: write$/m.test(text), w.actionsWrite === true, 'actions: write only where listed');
      assert.equal(/\bactions: write\b/.test(text), w.actionsWrite === true, 'actions: write nowhere else');
      assert.equal(text.includes('GITHUB_TOKEN: ${{ github.token }}'), w.actionsRead === true, 'GITHUB_TOKEN only where actions: read is listed');
      assert.equal(text.includes('GH_TOKEN: ${{ github.token }}'), w.actionsWrite === true || w.ghActionsRead === true, 'GH_TOKEN only where listed');
      if (w.file === 'fetch-files.yml') {
        assert.ok(text.includes('git push -q origin files'), 'pushes to the files branch');
        assert.equal(text.split('\n').filter((l) => /\bgit\b.*\bpush\b/.test(l)).length, 1, 'exactly one git push');
      }
      if (w.file === 'long-history.yml') {
        assert.ok(text.includes('git push -q origin HEAD:prices'), 'pushes to the prices branch');
        assert.equal(text.split('\n').filter((l) => /\bgit\b.*\bpush\b/.test(l)).length, 1, 'exactly one git push');
        assert.ok(!/origin (HEAD:)?main\b/.test(text), 'never main');
      }
      if (w.file === 'record.yml') {
        assert.ok(text.includes('push -q origin HEAD:recordings'), 'pushes to the recordings branch');
        assert.equal(text.split('\n').filter((l) => /\bgit\b.*\bpush\b/.test(l)).length, 1, 'exactly one git push');
        assert.ok(!/origin (HEAD:)?main\b/.test(text), 'never main');
        assert.ok(text.indexOf('Check the files for leaked keys') < text.indexOf('Save the recording to the recordings branch'), 'leak check runs first');
      }
    });
  }
  test('ci.yml is manual only (owner 2026-10-30: free Actions minutes; the suite runs locally before every push)', () => {
    const t = readWorkflow('ci.yml');
    assert.match(t, /^ {2}workflow_dispatch:/m);
    assert.doesNotMatch(t, /^ {2}push:/m);
    assert.doesNotMatch(t, /^ {2}pull_request:/m);
  });
  test('long-history.yml is manual only (docs/LONG_HISTORY_PLAN.md: no schedule, no push trigger)', () => {
    const t = readWorkflow('long-history.yml');
    assert.match(t, /^ {2}workflow_dispatch:/m);
    assert.doesNotMatch(t, /^ {2}(push|pull_request|schedule):/m);
    assert.deepEqual(parseInputs(t).map((i) => [i.name, i.default]), [['mode', 'backfill'], ['tickers', "''"]]);
  });
  test('negative controls: the checker does flag broken YAML', () => {
    assert.notDeepEqual(yamlSubsetProblems('name: x\non:\n\tpush:\npermissions:\njobs:\n'), []);
    assert.notDeepEqual(yamlSubsetProblems('name: a: b\non:\npermissions:\njobs:\n'), []);
    assert.notDeepEqual(yamlSubsetProblems('name: x\non:\npermissions:\n'), []);
    assert.notDeepEqual(yamlSubsetProblems('name: x\non:\npermissions:\njobs:\n  a: ${{ b\n'), []);
  });
});

describe('FL-8w (b) no secret value or literal key in any workflow', () => {
  for (const w of WORKFLOWS) {
    test(w.file, () => {
      assert.deepEqual(findSecretLikeText(readWorkflow(w.file)), []);
    });
  }
  test('negative controls: the scanner does flag keys', () => {
    assert.ok(findSecretLikeText('https://x.test/q?apikey=abc').length > 0);
    assert.ok(findSecretLikeText('KEY: AIza' + 'SyA1234567890abcdefghijklmnopqrstuv').length > 0);
    assert.ok(findSecretLikeText('KEY: sk-ant-abcdefgh').length > 0);
    assert.ok(findSecretLikeText('H: ' + 'a1b2c3d4'.repeat(4)).length > 0);
    assert.ok(findSecretLikeText('run: set -x').length > 0);
    assert.deepEqual(findSecretLikeText('uses: actions/checkout@v5\nrun: npm ci\ntask-name: disk-usage'), []);
  });
  test('secrets are only passed as NAME: ${{ secrets.NAME }}, or in a per-user file NAME: ${{ secrets[format(\'{0}NAME\', env.SECRET_PREFIX)] }} (same name both sides)', () => {
    for (const w of WORKFLOWS) {
      for (const line of readWorkflow(w.file).split('\n').filter((l) => /\bsecrets[.[]/.test(l))) {
        if (w.perUser) {
          const name = /^\s*([A-Z][A-Z0-9_]*):/.exec(line)?.[1] ?? '?';
          assert.equal(line.trim(), perUserSecretLine(name), w.file + ': ' + line);
        } else {
          assert.match(line, /^\s*([A-Z][A-Z0-9_]*): \$\{\{ secrets\.\1 \}\}\s*$/, w.file + ': ' + line);
        }
      }
    }
  });
});

describe('FL-8w (c) every secret referenced exists in .env.example, and matches the DATA', () => {
  const known = envExampleNames();
  for (const w of WORKFLOWS) {
    test(w.file, () => {
      const refs = [...new Set(secretRefs(readWorkflow(w.file)))].sort();
      for (const r of refs) assert.ok(known.has(r), w.file + ' references ' + r + ' which .env.example does not list');
      assert.deepEqual(refs, [...w.secrets].sort());
    });
  }
  test('F-B10-1: every workflow that runs the program (compose.ts) passes SEC_CONTACT_EMAIL, which compose requires', () => {
    for (const w of WORKFLOWS) {
      const runsProgram = w.commands.some((c) => /npm run (nightly|my-options|ai|record)\b/.test(c));
      if (runsProgram) assert.ok(w.secrets.includes('SEC_CONTACT_EMAIL'), w.file + ' runs the program but does not pass SEC_CONTACT_EMAIL');
    }
  });
  test('nightly passes no AI key (zero AI calls); only ai-dispatch passes GEMINI/ANTHROPIC', () => {
    assert.ok(!readWorkflow('nightly.yml').includes('ANTHROPIC') && !readWorkflow('nightly.yml').includes('GEMINI'));
    assert.ok(secretRefs(readWorkflow('ai-dispatch.yml')).includes('ANTHROPIC_API_KEY'));
  });
});

describe('FL-8w (d) cron lines, timeouts, actions, concurrency equal the DATA', () => {
  for (const w of WORKFLOWS) {
    test(w.file, () => {
      const text = readWorkflow(w.file);
      assert.deepEqual(cronsIn(text), [...w.crons]);
      if (w.crons.length > 0) assert.ok(text.includes(renderScheduleBlock(w.crons)), 'schedule block matches the generator');
      assert.equal(jobTimeout(text), w.timeoutMinutes);
      assert.match(text, /^ {2}group: (.+)$/m);
      assert.equal((/^ {2}group: (.+)$/m.exec(text) as RegExpExecArray)[1], w.concurrencyGroup);
      for (const m of text.matchAll(/uses:\s*(\S+)/g)) assert.ok(ALLOWED_ACTIONS.includes(m[1] as string), 'unlisted action ' + m[1]);
      for (const c of w.commands) assert.ok(text.includes(c), w.file + ' must call: ' + c);
      assert.ok(!text.includes('github.event.inputs'), 'use the typed inputs context, never github.event.inputs');
    });
  }
  test('every cron line parses and is daily', () => {
    for (const w of WORKFLOWS) for (const c of w.crons) assert.equal(parseCron(c).dow, '*');
  });
  test('nightly uses the exact process environment from the decision', () => {
    const t = readWorkflow('nightly.yml');
    assert.match(t, /^ {2}TZ: America\/New_York$/m);
    assert.match(t, /^ {2}LANG: en_US\.UTF-8$/m);
    assert.match(t, /^ {2}SCRIPT_TIME_ZONE: America\/New_York$/m);
  });
});

describe('FL-8w (e) the DST guard picks the right arm', () => {
  // [UTC day, which cron line passes]. 2026: US clocks change Mar 8 and Nov 1; Israel Mar 27 and Oct 25.
  const samples: Array<[string, string]> = [
    ['2026-01-15', MY_OPTIONS_CRON_EST], ['2026-03-07', MY_OPTIONS_CRON_EST], ['2026-03-08', MY_OPTIONS_CRON_EDT],
    ['2026-03-15', MY_OPTIONS_CRON_EDT], ['2026-07-15', MY_OPTIONS_CRON_EDT], ['2026-10-24', MY_OPTIONS_CRON_EDT],
    ['2026-10-31', MY_OPTIONS_CRON_EDT], ['2026-11-01', MY_OPTIONS_CRON_EST], ['2026-12-15', MY_OPTIONS_CRON_EST],
  ];
  for (const [day, want] of samples) {
    test(day + ' -> ' + want, () => {
      assert.deepEqual(cronsThatPassGuard(day), [want]);
    });
  }
  test('exactly one arm passes on every day of 2026 and 2027', () => {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      assert.equal(cronsThatPassGuard(day).length, 1, day);
    }
  });
  test('shouldRunNow(etHour, now) basics', () => {
    assert.equal(etHourOf(new Date('2026-07-15T21:05:00Z')), 17);
    assert.equal(etHourOf(new Date('2026-12-15T21:05:00Z')), 16);
    assert.equal(shouldRunNow(17, new Date('2026-07-15T21:59:00Z')), true);
    assert.equal(shouldRunNow(17, new Date('2026-07-15T22:00:00Z')), false);
    assert.equal(shouldRunNow(17, new Date('2026-12-15T22:00:00Z')), true);
  });
  test('my-options.yml carries the same hour and the same bash check', () => {
    const t = readWorkflow('my-options.yml');
    assert.match(t, new RegExp("^ {2}TARGET_ET_HOUR: '" + MY_OPTIONS_ET_HOUR + "'$", 'm'));
    assert.ok(t.includes('TZ=America/New_York date +%H'));
    assert.ok(t.includes('"$GITHUB_EVENT_NAME" != "schedule"'), 'manual runs skip the guard');
    const afterGuard = t.slice(t.indexOf('id: guard') + 1).split(/^ {6}- name:/m).slice(1);
    for (const s of afterGuard.filter((x) => !x.includes('Failure notice'))) assert.ok(s.includes("steps.guard.outputs.run == 'true'"), 'step not gated by the guard: ' + s.slice(0, 40));
  });
});

describe('FL-8w nightly timing arithmetic (US and Israel change clocks on different dates)', () => {
  // [UTC day, expected ET, expected Israel]
  const cases: Array<[string, string, string]> = [
    ['2026-01-15', '22:23', '05:23'], // both winter
    ['2026-03-15', '23:23', '05:23'], // US summer, Israel still winter
    ['2026-07-15', '23:23', '06:23'], // both summer
    ['2026-10-28', '23:23', '05:23'], // Israel back to winter, US still summer
    ['2026-12-15', '22:23', '05:23'],
  ];
  for (const [day, et, il] of cases) {
    test(day, () => {
      const at = cronInstant(day, (NIGHTLY.relayCrons ?? [])[0] as string);
      const e = localClock(at, ET_ZONE);
      const i = localClock(at, ISRAEL_ZONE);
      assert.equal(e.hhmm, et);
      assert.equal(i.hhmm, il);
      assert.ok(e.hour >= 20 && e.hour <= 23, 'at least 4 hours after the 16:00 ET close and before midnight ET');
      const prevUtcDay = new Date(at.getTime() - 86_400_000).toISOString().slice(0, 10);
      assert.equal(e.date, prevUtcDay, 'the New York date is the trading day (the previous UTC day)');
      // Israel time is informational only: the owner fixed the start at 03:00 UTC (03:23 since 2026-10-28, off the full hour).
    });
  }
  test('timeout 120 minutes: still inside the 6 hour GitHub job limit, about 4x the conservative estimate', () => {
    assert.ok(NIGHTLY.timeoutMinutes <= 360);
    assert.ok(NIGHTLY.timeoutMinutes >= 4 * 25);
  });
});

describe('FL-8w structure that protects the sheet and the bill', () => {
  for (const w of [NIGHTLY, MY_OPTIONS, AI_DISPATCH]) {
    test(w.file + ': lock-sheets runs under always() and after the main command', () => {
      const t = readWorkflow(w.file);
      const lock = stepWith(t, 'npm run lock-sheets');
      assert.match(lock, /if: always\(\)/);
      assert.ok(t.indexOf('npm run lock-sheets') > t.indexOf(w.commands[0] as string), 'relock comes after the main run');
      assert.ok(!t.includes('unlock-tabs') && !t.includes('unlock-sheets'), 'unlocking is done in code (try/finally), never in YAML');
    });
    test(w.file + ': the run log is uploaded under always() and a failure notice exists', () => {
      const t = readWorkflow(w.file);
      assert.match(stepWith(t, 'actions/upload-artifact@v5'), /if: always\(\)/);
      assert.match(stepWith(t, 'Failure notice'), /if: failure\(\) \|\| cancelled\(\)/);
    });
  }
  test('nightly: typecheck and test gate is optional and driven by the typed input', () => {
    const t = readWorkflow('nightly.yml');
    assert.match(t, /^ {6}run_checks:\n {8}description: .*\n {8}type: boolean\n {8}default: false$/m);
    assert.match(stepWith(t, 'npm run typecheck'), /if: \$\{\{ inputs\.run_checks \}\}/);
    assert.match(stepWith(t, 'npm test'), /if: \$\{\{ inputs\.run_checks \}\}/);
  });
  test('ai-dispatch: the 7 inputs equal the DATA; no step branches on an AI checkbox', () => {
    const t = readWorkflow('ai-dispatch.yml');
    assert.deepEqual(parseInputs(t), [...AI_INPUTS, USER_INPUT].map((x) => ({ name: x.name, type: x.type, default: x.default })));
    for (const o of AI_EFFORT_OPTIONS) assert.match(t, new RegExp('^ {10}- ' + o + '$', 'm'));
    assert.ok(!/^\s*if:.*(BUY|EXIT|inputs\.(buy|exit))/m.test(t), 'no if: on AI inputs anywhere (the fail-fast step uses shell tests, not if:)');
    for (const n of ['BUY', 'BUY_GEMINI', 'BUY_OPUS', 'EXIT', 'EXIT_GEMINI', 'EXIT_OPUS', 'EFFORT']) assert.ok(t.includes('      ' + n + ': ${{ inputs.'), n);
    assert.ok(stepsOf(t)[0]?.includes('Refuse a run that would do nothing'), 'the no-op guard runs before checkout');
  });
  test('ai-dispatch (plan #47): the run step gets Telegram for the portfolio view; the bot token is leak-checked; no new input', () => {
    const t = readWorkflow('ai-dispatch.yml');
    const run = stepWith(t, 'npm run ai 2>&1');
    for (const n of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ANTHROPIC_API_KEY']) assert.ok(secretRefs(run).includes(n), n);
    assert.match(stepWith(t, 'Check the log for leaked keys'), /for name in .*TELEGRAM_BOT_TOKEN/);
    assert.ok(!AI_INPUTS.some((i) => i.name === 'portfolio_opus'), 'the Exit Opus box drives it');
  });
  test('analyze: the inputs equal the DATA (opus defaults to false, owner 2026-11-05); Opus is skipped only when opus is false; the key is leak-checked', () => {
    const t = readWorkflow('analyze.yml');
    assert.deepEqual(parseInputs(t), [...ANALYZE_INPUTS, USER_INPUT].map((x) => ({ name: x.name, type: x.type, default: x.default })));
    assert.ok(t.includes('      WITH_OPUS: ${{ inputs.opus }}'));
    assert.match(t, /\[ "\$WITH_OPUS" = "false" \] && args\+=\(--no-opus\)/);
    assert.ok(!/^\s*if:.*opus/im.test(t), 'no step is switched on or off by the opus input');
    assert.match(stepWith(t, 'Check the log for leaked keys'), /for name in .*ANTHROPIC_API_KEY/);
  });
  test('send-exit (owner 2026-11-05): input opus (default false) re-runs the Exit AI with Opus; the key is leak-checked', () => {
    const t = readWorkflow('send-exit.yml');
    assert.deepEqual(parseInputs(t), [...SEND_EXIT_INPUTS, USER_INPUT].map((x) => ({ name: x.name, type: x.type, default: x.default })));
    assert.ok(t.includes('          WITH_OPUS: ${{ inputs.opus }}'));
    assert.match(t, /if \[ "\$WITH_OPUS" = "true" \]; then\n\s+BUY=false EXIT=true EXIT_GEMINI=true EXIT_OPUS=true /);
    assert.ok(!/^\s*if:.*opus/im.test(t), 'no step is switched on or off by the opus input');
    assert.match(stepWith(t, 'Check the log for leaked keys'), /for name in .*ANTHROPIC_API_KEY/);
  });
  test('nightly leak check runs before the upload', () => {
    const t = readWorkflow('nightly.yml');
    assert.ok(t.indexOf('Check the log for leaked keys') < t.indexOf('actions/upload-artifact@v5'));
  });
});

describe('FL-8w three spreadsheets (docs/SHEETS_CLEANUP_PLAN.md (d), (e))', () => {
  test('the six writer workflows pass both new secrets to the run step and the lock step', () => {
    assert.deepEqual(SHEET_WRITER_WORKFLOWS.map((w) => w.file).sort(), ['ai-dispatch.yml', 'analyze.yml', 'exit-report.yml', 'my-options.yml', 'nightly.yml', 'send-exit.yml']);
    for (const w of [...SHEET_WRITER_WORKFLOWS, MIGRATE_DATA_TABS]) {
      const t = readWorkflow(w.file);
      for (const name of ['REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID']) {
        assert.ok(w.secrets.includes(name), w.file + ' DATA lists ' + name);
        assert.ok(passesSecret(stepWith(t, w.commands[0] as string), name), w.file + ': run step gets ' + name);
        assert.ok(passesSecret(stepWith(t, 'npm run lock-sheets'), name), w.file + ': lock step gets ' + name);
      }
    }
  });
  test('migrate-data-tabs.yml: its own group, actions: read, the step choice, the pause cleared and the lock under always()', () => {
    const t = readWorkflow(MIGRATE_DATA_TABS.file);
    assert.equal(MIGRATE_DATA_TABS.concurrencyGroup, 'sheet-migration');
    assert.notEqual(MIGRATE_DATA_TABS.concurrencyGroup, NIGHTLY.concurrencyGroup);
    assert.match(t, /^permissions:\n {2}contents: read\n {2}actions: read$/m);
    assert.match(t, /^ {2}cancel-in-progress: false$/m);
    assert.equal(MIGRATE_DATA_TABS.crons.length, 0, 'manual only');
    const inputs = parseInputs(t);
    assert.deepEqual(inputs.map((i) => i.name), ['step', 'confirm_delete', 'accept_references']);
    assert.deepEqual(inputs.map((i) => i.default), ['check', 'false', 'false']);
    for (const s of MIGRATION_STEPS) assert.match(t, new RegExp('^ {10}- ' + s + '$', 'm'), s);
    assert.match(stepWith(t, 'migrate-data-tabs -- unpause'), /if: always\(\)/);
    assert.match(stepWith(t, 'npm run lock-sheets'), /if: always\(\)/);
    assert.ok(t.indexOf('-- unpause') > t.indexOf('npm run migrate-data-tabs -- "${args[@]}"'), 'the pause is cleared after the step');
    assert.match(stepWith(t, 'actions/upload-artifact@v5'), /if: always\(\)/);
    assert.match(stepWith(t, 'Failure notice'), /if: failure\(\) \|\| cancelled\(\)/);
    assert.ok(stepWith(t, 'Run the migration step').includes('GITHUB_TOKEN: ${{ github.token }}'), 'the pre-check sees running writer runs');
  });
  test('the time windows: 20:30-23:00 UTC (My Options 21:05/22:05) and 03:00-05:30 UTC (Nightly 03:23 + 120 min)', () => {
    assert.deepEqual(MIGRATION_BLOCKED_WINDOWS_UTC.map((w) => [w.from, w.to]), [['20:30', '23:00'], ['03:00', '05:30']]);
    for (const c of [...MY_OPTIONS.crons, ...(NIGHTLY.relayCrons ?? [])]) {
      assert.ok(migrationBlockedWindow(cronInstant('2026-11-02', c)), c + ' falls in a window');
    }
    const nightlyEnd = new Date(cronInstant('2026-11-02', NIGHTLY.relayCrons?.[0] as string).getTime() + NIGHTLY.timeoutMinutes * 60_000 - 60_000);
    assert.ok(migrationBlockedWindow(nightlyEnd), 'the whole Nightly timeout is covered');
    assert.equal(migrationBlockedWindow(new Date('2026-11-02T12:00:00Z')), null);
  });
});

describe('FL-8w the DATA agrees with the job modules', () => {
  test('nightly order starts with the three dark-pool jobs in legacy order', () => {
    assert.deepEqual(NIGHTLY_STEP_ORDER.slice(0, 3), DARK_POOL_DAILY_JOBS.map((j) => j.key));
    assert.deepEqual(NIGHTLY_STEP_ORDER.slice(3), ['macro.refresh', 'options.chains', 'analysis.tickers', 'analysis.summary', 'buy.report', 'exit.report', 'options.reads', 'fundamentals.history', 'paper.trade', 'live.dryRun']);
    assert.deepEqual([...NIGHTLY_STEP_ORDER], [...NIGHTLY_ORDER]);
  });
  test('my-options guard hour equals the legacy trigger hour', () => {
    assert.equal(MY_OPTIONS_ET_HOUR, MY_OPTIONS_DAILY_JOB.atHour);
  });
});

describe('GENERIC_PLAN P5: per-user workflows (the owner runs exactly as before)', () => {
  const PER_USER = ['ai-dispatch.yml', 'analyze.yml', 'exit-report.yml', 'init-user-sheets.yml', 'my-options.yml', 'nightly.yml', 'send-exit.yml', 'setup-check.yml', 'telegram-check.yml', 'telegram-setup.yml', 'verify.yml', 'watchdog.yml'];
  /** Owner 2026-11-06: the two set-up buttons read the Profile tab too (setup-check only reads; init-user-sheets adds missing tabs). */
  const SETUP_FILES = ['init-user-sheets.yml', 'setup-check.yml'];
  const baseOf = (w: { file: string }): string => (w.file === 'my-options.yml' ? 'my-options' : w.file === 'watchdog.yml' ? 'watchdog' : w.file === 'verify.yml' ? 'verify' : w.file.startsWith('telegram-') ? 'telegram' : SETUP_FILES.includes(w.file) ? 'setup' : 'sheet-report-writers');
  /** The GitHub expressions used here, run as JavaScript (`&&` / `||` return operands in both; inputs are lower case). */
  const evalExpr = (expr: string, user: string | null): string => {
    const m = /^\$\{\{ (.*) \}\}$/.exec(expr);
    assert.ok(m, 'an expression: ' + expr);
    const js = (m[1] as string)
      .replace(/format\('([^']*)\{0\}([^']*)', inputs\.user\)/g, "('$1' + u + '$2')")
      .replace(/inputs\.user/g, 'u').replace(/ == /g, ' === ').replace(/ != /g, ' !== ');
    assert.doesNotMatch(js, /inputs|format|secrets|env\./, 'only the forms this mirror knows: ' + js);
    return String(new Function('u', 'return ' + js)(user));
  };

  test('exactly the twelve files that use per-user secrets take the user input; CI, record, fetch-files and the migration do not', () => {
    assert.deepEqual(WORKFLOWS.filter((w) => w.perUser).map((w) => w.file).sort(), PER_USER);
    assert.deepEqual(WORKFLOWS.filter((w) => w.readsProfile).map((w) => w.file).sort(), [...SHEET_WRITER_WORKFLOWS.map((w) => w.file), ...SETUP_FILES].sort());
    for (const w of WORKFLOWS.filter((x) => !x.perUser)) {
      const t = readWorkflow(w.file);
      assert.ok(!t.includes('inputs.user') && !t.includes('SECRET_PREFIX'), w.file);
    }
  });
  for (const w of WORKFLOWS.filter((x) => x.perUser)) {
    test(w.file + ': `user` input (last, default owner), the three env lines, per-user group, no environment, no new trigger', () => {
      const t = readWorkflow(w.file);
      const inputs = parseInputs(t);
      assert.deepEqual(inputs[inputs.length - 1], { name: USER_INPUT.name, type: USER_INPUT.type, default: USER_INPUT.default });
      const envBlock = (/^env:\n((?: {2}.*\n)+)/m.exec(t) as RegExpExecArray)[1] as string;
      for (const [k, v] of PER_USER_ENV) assert.ok(envBlock.includes('  ' + k + ': ' + v + '\n'), w.file + ' env ' + k);
      assert.equal(w.concurrencyGroup, perUserGroup(baseOf(w)));
      assert.doesNotMatch(t, /^\s*environment:/m, 'no GitHub Environment (not verifiable on this plan); prefixed secrets instead');
      assert.doesNotMatch(t, /^ {2}(push|pull_request|pull_request_target|workflow_run|repository_dispatch):/m);
      assert.equal(/^ {2}schedule:/m.test(t), w.crons.length > 0, 'a schedule only where there was one (my-options, watchdog)');
      assert.ok(secretRefs(t).length > 0 && !/secrets\.[A-Z]/.test(t), 'every secret goes through SECRET_PREFIX');
    });
  }
  for (const w of WORKFLOWS.filter((x) => x.readsProfile)) {
    test(w.file + ': other users read their Profile tab first; the default user only when the copy has no built-in profile', () => {
      const t = readWorkflow(w.file);
      const step = stepWith(t, 'npm run profile-fetch');
      const cond = w.file === 'my-options.yml' ? '(' + PROFILE_STEP_IF + ") && steps.guard.outputs.run == 'true'" : PROFILE_STEP_IF;
      assert.ok(step.includes('\n        if: ' + cond + '\n'), 'gated: ' + step.slice(0, 160));
      assert.ok(step.includes('npm run profile-fetch -- --out "$PWD/out/profile.json"'));
      assert.ok(step.includes('echo "PROFILE_FILE=$PWD/out/profile.json" >> "$GITHUB_ENV"'));
      const tg = w.secrets.includes('TELEGRAM_CHAT_ID') ? ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] : [];
      assert.deepEqual(secretRefs(step), ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', ...tg], 'least privilege');
      assert.ok(t.indexOf('npm run profile-fetch') < t.indexOf(w.commands[0] as string), 'before the main command');
    });
  }
  test('the expressions: empty / missing / owner = today (plain secret names, the old group, no profile read); u2 = U2_ secrets, its own group, its Profile tab', () => {
    const env = Object.fromEntries(PER_USER_ENV);
    for (const u of [null, '', OWNER_USER]) {
      assert.equal(evalExpr(env.RUN_USER as string, u), OWNER_USER);
      assert.equal(evalExpr(env.SECRET_PREFIX as string, u), '');
      assert.equal(evalExpr(env.PROFILE_SOURCE as string, u), '');
      assert.equal(evalExpr(perUserGroup('sheet-report-writers'), u), 'sheet-report-writers');
      assert.equal(groupFor(u, 'sheet-report-writers'), 'sheet-report-writers');
      assert.equal(secretNameFor(u, 'SPREADSHEET_ID'), 'SPREADSHEET_ID');
    }
    assert.equal(evalExpr(env.RUN_USER as string, 'u2'), 'u2');
    assert.equal(evalExpr(env.SECRET_PREFIX as string, 'u2'), 'u2_');
    assert.equal(evalExpr(env.PROFILE_SOURCE as string, 'u2'), 'sheet');
    assert.equal(evalExpr(perUserGroup('sheet-report-writers'), 'u2'), groupFor('u2', 'sheet-report-writers'));
    assert.equal(groupFor('u2', 'sheet-report-writers'), 'sheet-report-writers-u2');
    assert.equal(secretNameFor('u2', 'SPREADSHEET_ID'), 'U2_SPREADSHEET_ID');
    assert.equal(secretNameFor('Owner', 'SPREADSHEET_ID'), 'SPREADSHEET_ID', 'GitHub compares the input without case');
    assert.equal(perUserSecretLine('FMP_API_KEY'), "FMP_API_KEY: ${{ secrets[format('{0}FMP_API_KEY', env.SECRET_PREFIX)] }}");
  });
  test('nightly: the optional test suite runs as the owner, and before the profile step (PROFILE_FILE is not set yet)', () => {
    const t = readWorkflow('nightly.yml');
    const step = stepWith(t, 'run: npm test');
    assert.ok(step.includes("          RUN_USER: owner\n          PROFILE_SOURCE: ''\n"));
    assert.ok(t.indexOf('run: npm test') < t.indexOf('npm run profile-fetch'));
  });
  test('package.json has the profile-fetch command the workflows call', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts['profile-fetch'], 'node --env-file-if-exists=.env src/profileFetch.ts');
  });
});

describe('Row 38: the nightly digest reads the GitHub minutes with the workflow token', () => {
  test('nightly.yml: actions: read, and the run step gets GITHUB_TOKEN + GITHUB_REPOSITORY (the lock step does not); still no push or schedule trigger', () => {
    const t = readWorkflow(NIGHTLY.file);
    assert.equal(NIGHTLY.actionsRead, true);
    assert.match(t, /^permissions:\n {2}contents: read\n {2}actions: read$/m);
    const run = stepWith(t, 'npm run nightly');
    assert.ok(run.includes('GITHUB_TOKEN: ${{ github.token }}'));
    assert.ok(run.includes('GITHUB_REPOSITORY: ${{ github.repository }}'));
    assert.ok(!stepWith(t, 'npm run lock-sheets').includes('GITHUB_TOKEN'));
    assert.doesNotMatch(t, /^ {2}(push|schedule):/m);
    assert.equal(NIGHTLY.crons.length, 0);
  });
});

describe('Owner 2026-11-04: GitHub backup timer for the Nightly, late-firing guard for My Options', () => {
  test('nightly-backup.yml: two crons (03:23 and 05:23 UTC), actions: write, own group, 5 minutes, no checkout and no npm', () => {
    const t = readWorkflow(NIGHTLY_BACKUP.file);
    assert.deepEqual([...NIGHTLY_BACKUP_CRONS], ['23 3 * * *', '23 5 * * *']);
    assert.deepEqual(cronsIn(t), [...NIGHTLY_BACKUP_CRONS]);
    assert.equal(NIGHTLY_BACKUP_CRONS[0], NIGHTLY.relayCrons?.[0], 'the first check is the relay time itself');
    assert.match(t, /^permissions:\n {2}contents: read\n {2}actions: write$/m);
    assert.match(t, /^ {2}group: nightly-backup\n {2}cancel-in-progress: false$/m);
    assert.equal(NIGHTLY_BACKUP.timeoutMinutes, 5);
    assert.doesNotMatch(t, /uses:|\bnpm (ci|run|install)\b/, 'no action, no npm (10-20 s of free minutes)');
    assert.equal(stepsOf(t).length, 1, 'one bash step');
    const step = stepsOf(t)[0] as string;
    assert.ok(step.includes('GH_TOKEN: ${{ github.token }}') && step.includes('GH_REPO: ${{ github.repository }}'));
  });
  test('nightly-backup.yml: the 03:00 UTC window (any status), the 13 UTC cut-off, the start command and the Telegram texts', () => {
    const t = readWorkflow(NIGHTLY_BACKUP.file);
    assert.equal(NIGHTLY_BACKUP_SINCE_UTC, '03:00');
    assert.equal(NIGHTLY_BACKUP_CUTOFF_UTC_HOUR, 13);
    assert.ok(t.includes('since="$(date -u +%Y-%m-%d)T' + NIGHTLY_BACKUP_SINCE_UTC + ':00Z"'));
    const query = /gh api "repos\/\$GH_REPO\/actions\/workflows\/nightly\.yml\/runs\?([^"]*)"/.exec(t);
    assert.ok(query, 'reads the Nightly runs');
    assert.ok((query[1] as string).includes('created=%3E%3D${since}'));
    assert.ok(!(query[1] as string).includes('status='), 'any status counts (a running or failed Nightly is not restarted)');
    assert.ok(t.includes("CUTOFF_UTC_HOUR: '" + NIGHTLY_BACKUP_CUTOFF_UTC_HOUR + "'"));
    assert.ok(t.includes('if [ "$hour" -ge "$CUTOFF_UTC_HOUR" ]; then'));
    assert.ok(t.indexOf('"$count" -gt 0') < t.indexOf('"$CUTOFF_UTC_HOUR" ]') && t.indexOf('"$CUTOFF_UTC_HOUR" ]') < t.indexOf('gh workflow run'), 'check, then cut-off, then start');
    assert.equal(t.split('gh workflow run').length - 1, 1);
    assert.ok(t.includes('gh workflow run nightly.yml --ref main -f run_checks=false'));
    assert.ok(t.includes('⚠️ The Nightly did not run tonight and the GitHub backup came too late (market hours). Start it by hand: Actions → Nightly → Run workflow.'));
    assert.ok(t.includes('⏰ The Nightly was started by the GitHub backup timer (the Cloudflare timer did not start it).'));
    assert.ok(t.includes('https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage') && t.includes('-o /dev/null'), 'the token is never printed');
  });
  test('nightlyBackupAction mirrors the file', () => {
    assert.equal(nightlyBackupAction(new Date('2026-11-04T03:23:00Z'), true), 'already-ran');
    assert.equal(nightlyBackupAction(new Date('2026-11-04T10:30:00Z'), false), 'start');
    assert.equal(nightlyBackupAction(new Date('2026-11-04T12:59:00Z'), false), 'start');
    assert.equal(nightlyBackupAction(new Date('2026-11-04T13:00:00Z'), false), 'too-late');
    assert.equal(nightlyBackupAction(new Date('2026-11-04T15:00:00Z'), true), 'already-ran');
  });
  test('nightly.yml still has no schedule; ci.yml stays dispatch-only', () => {
    assert.doesNotMatch(readWorkflow('nightly.yml'), /^ {2}schedule:/m);
    assert.doesNotMatch(readWorkflow('ci.yml'), /^ {2}(schedule|push|pull_request):/m);
  });
  test('my-options.yml: scheduled runs go at New York hour >= 17 when no successful run was created since 17:00 New York today', () => {
    const t = readWorkflow(MY_OPTIONS.file);
    assert.deepEqual(cronsIn(t), [MY_OPTIONS_CRON_EDT, MY_OPTIONS_CRON_EST], 'both crons kept');
    assert.match(t, /^permissions:\n {2}contents: read\n {2}actions: read$/m);
    const guard = stepWith(t, 'id: guard');
    assert.ok(guard.includes('GH_TOKEN: ${{ github.token }}'));
    assert.ok(guard.includes('if [ "$GITHUB_EVENT_NAME" != "schedule" ]; then\n            echo "run=true"'), 'manual / relay runs always run');
    assert.ok(guard.includes('elif [ "$et_hour" -lt "$TARGET_ET_HOUR" ]; then'), 'hour >= 17, not == 17');
    assert.doesNotMatch(guard, /-eq "\$TARGET_ET_HOUR"/);
    assert.ok(guard.includes('date -d "$(TZ=America/New_York date +%F) ${TARGET_ET_HOUR}:00" +%s'), 'since 17:00 New York today');
    assert.ok(guard.includes('actions/workflows/my-options.yml/runs?status=success&created=%3E%3D${since}'), 'only successful runs count');
    assert.ok(guard.includes('if [ "$done_runs" = "0" ] || [ "$done_runs" = "unknown" ]; then'), 'not ran yet, or GitHub unreadable: run');
  });
  test('myOptionsScheduledShouldRun: every late firing seen (00:30-03:26 UTC) runs once, the early arm and a repeat do not', () => {
    // Winter (EST): 21:05 UTC = 16:05 New York -> wrong arm; 22:05 = 17:05 -> run.
    assert.equal(myOptionsScheduledShouldRun(new Date('2026-12-15T21:05:00Z'), false), false);
    assert.equal(myOptionsScheduledShouldRun(new Date('2026-12-15T22:05:00Z'), false), true);
    // Late firings, both seasons: still the same New York day, 17:00 or later.
    for (const at of ['2026-11-05T00:30:00Z', '2026-11-05T03:26:00Z', '2026-07-16T00:30:00Z', '2026-07-16T03:26:00Z']) {
      assert.equal(myOptionsScheduledShouldRun(new Date(at), false), true, at);
      assert.equal(myOptionsScheduledShouldRun(new Date(at), true), false, at + ' after a success');
      assert.equal(myOptionsScheduledShouldRun(new Date(at), null), true, at + ' GitHub unreadable');
    }
    // After New York midnight it is a new day before 17:00: no run.
    assert.equal(myOptionsScheduledShouldRun(new Date('2026-11-05T05:30:00Z'), false), false);
  });
});

describe('Owner 2026-11-04: the daily run watchdog (src/watchdog.ts)', () => {
  test('watchdog.yml: daily 06:07 UTC + manual, actions: read, its own group, lean install, the token on the run step only', () => {
    const t = readWorkflow(WATCHDOG.file);
    assert.equal(WATCHDOG_CRON, '7 6 * * *');
    assert.deepEqual(cronsIn(t), [WATCHDOG_CRON]);
    assert.match(t, /^permissions:\n {2}contents: read\n {2}actions: read$/m);
    assert.equal(groupFor(null, 'watchdog'), 'watchdog');
    assert.ok(t.includes('run: npm ci --omit=dev'), 'no dev tools installed');
    const run = stepWith(t, 'npm run watchdog');
    assert.ok(run.includes('GITHUB_TOKEN: ${{ github.token }}') && run.includes('GITHUB_REPOSITORY: ${{ github.repository }}'));
    assert.ok(!stepWith(t, 'Check the log for leaked keys').includes('GITHUB_TOKEN'));
    assert.ok(t.indexOf('Check the log for leaked keys') < t.indexOf('actions/upload-artifact@v5'), 'leak check before the upload');
    assert.match(stepWith(t, 'Check the log for leaked keys'), /for name in .*TELEGRAM_BOT_TOKEN/);
    assert.match(stepWith(t, 'actions/upload-artifact@v5'), /if: always\(\)/);
    assert.doesNotMatch(t, /npm run lock-sheets|npm test|npm run typecheck/, 'nothing else runs');
  });
  test('verify.yml (layer 2, owner 2026-11-04): manual only, days 3 then user, actions: read, group verify, 10 min, the Anthropic key on the run step, leak check before the upload', () => {
    const t = readWorkflow(VERIFY.file);
    assert.equal(VERIFY.crons.length, 0);
    assert.doesNotMatch(t, /^ {2}schedule:/m);
    assert.deepEqual(parseInputs(t).map((i) => [i.name, i.default]), [['days', "'3'"], ['user', 'owner']]);
    assert.match(t, /^permissions:\n {2}contents: read\n {2}actions: read$/m);
    assert.equal(groupFor(null, 'verify'), 'verify');
    assert.equal(VERIFY.timeoutMinutes, 10);
    const run = stepWith(t, 'npm run ops-verify');
    for (const s of ['GITHUB_TOKEN: ${{ github.token }}', 'GITHUB_REPOSITORY: ${{ github.repository }}', "VERIFY_DAYS: ${{ inputs.days || '3' }}", perUserSecretLine('ANTHROPIC_API_KEY')]) assert.ok(run.includes(s), s);
    const leak = stepWith(t, 'Check the log for leaked keys');
    assert.ok(!leak.includes('GITHUB_TOKEN'));
    assert.match(leak, /for name in TELEGRAM_BOT_TOKEN ANTHROPIC_API_KEY;/);
    assert.ok(t.indexOf('Check the log for leaked keys') < t.indexOf('actions/upload-artifact@v5'), 'leak check before the upload');
    assert.doesNotMatch(t, /npm run (watchdog|lock-sheets|nightly)|npm test|git push|contents: write/, 'read-only, nothing else runs');
  });
  test('package.json: ops-verify, not clashing with the older verify (verifyCli.ts)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts['ops-verify'], 'node --env-file-if-exists=.env src/verify.ts');
    assert.equal(pkg.scripts['verify'], 'node --env-file-if-exists=.env src/verifyCli.ts');
  });
  test('package.json has the watchdog command', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts['watchdog'], 'node --env-file-if-exists=.env src/watchdog.ts');
  });
});

describe('Owner 2026-11-06: the set-up buttons (setup-check.yml, init-user-sheets.yml) for a user without a terminal', () => {
  for (const w of [SETUP_CHECK, INIT_USER_SHEETS]) {
    test(w.file + ': manual only, read permission, group setup, 10 min, Node 24 actions, profile step before the main step, leak check before the run summary', () => {
      const t = readWorkflow(w.file);
      assert.match(t, /^ {2}workflow_dispatch:/m);
      assert.doesNotMatch(t, /^ {2}(push|pull_request|schedule):/m, 'manual only');
      assert.deepEqual(w.crons, []);
      assert.equal(w.timeoutMinutes, 10);
      assert.equal(w.concurrencyGroup, perUserGroup('setup'));
      assert.ok(!SHEET_WRITER_WORKFLOWS.includes(w), 'not one of the six writers the data move waits for');
      for (const a of ['actions/checkout@v5', 'actions/setup-node@v5']) assert.ok(t.includes(a), a);
      assert.ok(t.includes("node-version: '24'"));
      assert.ok(!t.includes('npm run lock-sheets'), 'no sheet writer step to re-lock');
      const leak = stepWith(t, 'Check the log for leaked keys');
      assert.ok(leak.includes('if: always()'));
      assert.match(leak, /for name in .*SPREADSHEET_ID .*TELEGRAM_BOT_TOKEN/);
      assert.ok(t.indexOf('npm run profile-fetch') < t.indexOf(w.commands[0] as string));
      assert.ok(t.indexOf(w.commands[0] as string) < t.indexOf('Check the log for leaked keys'));
      assert.ok(t.indexOf('Check the log for leaked keys') < t.indexOf('$GITHUB_STEP_SUMMARY'), 'the summary is written after the leak check');
    });
  }
  test('setup-check: every key the check tests is passed to it; a bad Profile tab still gives the table (continue-on-error)', () => {
    const t = readWorkflow(SETUP_CHECK.file);
    assert.deepEqual(secretRefs(stepWith(t, 'npm run setup-check')).sort(), [...SETUP_CHECK.secrets].sort());
    assert.ok(stepWith(t, 'npm run profile-fetch').includes('continue-on-error: true'));
    assert.match(stepWith(t, 'Check the log for leaked keys'), /for name in .*ANTHROPIC_API_KEY .*TELEGRAM_WEBHOOK_SECRET;/);
  });
  test('init-user-sheets: only the robot key and My Portfolio go to the main step; a bad Profile tab stops it', () => {
    const t = readWorkflow(INIT_USER_SHEETS.file);
    assert.deepEqual(secretRefs(stepWith(t, 'npm run init-user-sheets')).sort(), ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID']);
    assert.ok(!stepWith(t, 'npm run profile-fetch').includes('continue-on-error'));
  });
  test('package.json has both commands', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts['setup-check'], 'node src/setupCheck.ts');
    assert.equal(pkg.scripts['init-user-sheets'], 'node src/initUserSheets.ts');
  });
});
