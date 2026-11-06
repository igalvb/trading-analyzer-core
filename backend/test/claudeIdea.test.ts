/**
 * 🤖 Claude Ideas (owner approved 2026-11-06): the recommendations list with no money — the checks
 * (paper/claudeIdeas.ts), `npm run claude-idea` (src/claudeIdea.ts, a fake writer: nothing touches a sheet), and the
 * tab's place in the registry (protected, in the reports sheet).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_IDEAS_TAB, CLAUDE_IDEAS_HEADER, checkClaudeIdea, parseIdeaZone, ideaStatusOf, type IdeaFields } from '../src/paper/claudeIdeas.ts';
import { runClaudeIdea, parseIdeaArgs, CLAUDE_IDEA_USAGE } from '../src/claudeIdea.ts';
import { PROTECTED_TABS, sheetFor, isAllowListedName, isReportRegistryName } from '../src/sheets/tabs.ts';

// 2026-11-06 14:05 New York (19:05Z, EST).
const NOW = Date.parse('2026-11-06T19:05:00Z');
const base: IdeaFields = { date: '2026-11-06 14:05', ticker: 'nvda', kind: 'stock', idea: 'buy', zone: '$120 – $130', stop: '108', target: '165', horizon: '3-6 months', reason: 'a pullback into support' };

async function run(args: string[]): Promise<{ code: number; lines: string[]; rows: (readonly string[])[] }> {
  const lines: string[] = [], rows: (readonly string[])[] = [];
  const code = await runClaudeIdea(args, { env: {}, now: NOW, out: (l) => lines.push(l), append: async (_e, r) => { rows.push(r); } });
  return { code, lines, rows };
}

describe('🤖 Claude Ideas', () => {
  test('the tab: header, protected, in the reports sheet, allow-listed', () => {
    assert.deepEqual(CLAUDE_IDEAS_HEADER, ['Date', 'Ticker', 'Kind', 'Idea', 'Entry zone', 'Stop', 'Target', 'Horizon', 'Reason', 'Status']);
    assert.ok(PROTECTED_TABS.includes(CLAUDE_IDEAS_TAB));
    assert.equal(sheetFor(CLAUDE_IDEAS_TAB), 'reports');
    assert.ok(isReportRegistryName(CLAUDE_IDEAS_TAB) && isAllowListedName(CLAUDE_IDEAS_TAB));
  });

  test('a good idea becomes one row, normalised, Status open', () => {
    const c = checkClaudeIdea(base);
    assert.ok(c.ok);
    assert.deepEqual(c.row, ['2026-11-06 14:05', 'NVDA', 'stock', 'BUY', '$120 - $130', '108', '165', '3-6 months', 'a pullback into support', 'open']);
    const avoid = checkClaudeIdea({ ...base, idea: 'AVOID', zone: '-', stop: '-', target: '-' });
    assert.ok(avoid.ok);
    assert.deepEqual(avoid.row.slice(3, 7), ['AVOID', '-', '-', '-']);
  });

  test('bad input is refused with one sentence', () => {
    const why = (f: Partial<IdeaFields>): string => { const c = checkClaudeIdea({ ...base, ...f }); return c.ok ? 'ok' : c.why; };
    assert.match(why({ ticker: 'NOT A TICKER' }), /not a ticker/);
    assert.match(why({ idea: 'HOLD' }), /BUY, WAIT, AVOID or SELL/);
    assert.match(why({ kind: 'put' }), /stock or call/);
    assert.match(why({ zone: 'soon' }), /holds no price/);
    assert.match(why({ stop: 'abc' }), /stop "abc" is not a price/);
    assert.match(why({ stop: '125' }), /below the entry zone/);
    assert.match(why({ target: '128' }), /above the entry zone/);
    assert.match(why({ stop: '-' }), /a BUY needs an entry zone, a stop and a target/);
    assert.match(why({ horizon: ' ' }), /horizon is missing/);
    assert.match(why({ reason: '' }), /reason is missing/);
    assert.match(why({ reason: 'x'.repeat(700) }), /longer than 600/);
  });

  test('helpers: zones and status', () => {
    assert.deepEqual(parseIdeaZone('$1,200 - $1,150'), [1150, 1200]);
    assert.deepEqual(parseIdeaZone('125'), [125, 125]);
    assert.equal(parseIdeaZone('-'), null);
    assert.deepEqual(ideaStatusOf('open'), { open: true, outcome: '' });
    assert.deepEqual(ideaStatusOf(''), { open: true, outcome: '' });
    assert.deepEqual(ideaStatusOf('closed: target hit +12%'), { open: false, outcome: 'target hit +12%' });
    assert.deepEqual(ideaStatusOf('Closed — stopped out'), { open: false, outcome: 'stopped out' });
  });

  test('npm run claude-idea: appends one checked row, dated now in New York', async () => {
    const r = await run(['NVDA', 'BUY', '$120 - $130', '108', '165', '3-6 months', 'a', 'pullback']);
    assert.equal(r.code, 0);
    assert.deepEqual(r.rows, [['2026-11-06 14:05', 'NVDA', 'stock', 'BUY', '$120 - $130', '108', '165', '3-6 months', 'a pullback', 'open']]);
    assert.equal(r.lines.length, 1);
    assert.match(r.lines[0]!, /^appended to 🤖 Claude Ideas: BUY NVDA, zone \$120 - \$130, stop 108, target 165/);
    const call = await run(['MU', 'call', 'WAIT', '570-598', '520', '700', '6-12 months', 'wait for the zone']);
    assert.equal(call.code, 0);
    assert.equal(call.rows[0]![2], 'call');
  });

  test('refusals write nothing and print one line', async () => {
    for (const args of [[], ['NVDA', 'BUY'], ['NVDA', 'BUY', '$120 - $130', '140', '165', '3 months', 'stop above the zone'], ['NVDA', 'MAYBE', '-', '-', '-', '1 month', 'x']]) {
      const r = await run(args);
      assert.equal(r.code, 1, args.join(' '));
      assert.equal(r.rows.length, 0);
      assert.equal(r.lines.length, 1);
      assert.match(r.lines[0]!, /^refused: /);
    }
    assert.equal(parseIdeaArgs(['NVDA']), CLAUDE_IDEA_USAGE);
  });

  test('a writer failure is one "not written" line, exit 1', async () => {
    const lines: string[] = [];
    const code = await runClaudeIdea(['NVDA', 'AVOID', '-', '-', '-', '1 month', 'too extended'], { env: {}, now: NOW, out: (l) => lines.push(l), append: async () => { throw new Error('quota'); } });
    assert.equal(code, 1);
    assert.deepEqual(lines, ['not written: quota']);
    const none: string[] = [];
    assert.equal(await runClaudeIdea(['NVDA', 'AVOID', '-', '-', '-', '1 month', 'x'], { env: {}, now: NOW, out: (l) => none.push(l) }), 1, 'no key, no sheet id');
    assert.match(none[0]!, /^not written: GOOGLE_SERVICE_ACCOUNT_JSON/);
  });
});
