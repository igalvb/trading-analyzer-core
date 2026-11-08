/**
 * `npm run journal-add`: Claude logs one piece of advice it gave in a chat to the advice journal (ledger/journal.ts),
 * ledger/journal.jsonl in a checked-out `data` branch folder (DATA_BRANCH_DIR, default ../data-branch, like the other
 * ledger tools). The line is checked first; a bad one is refused with one line and nothing is written. Commit and push
 * the file to the `data` branch afterwards (never main).
 *
 *   npm run journal-add -- claudeChat PLTR BUY "buy part now, add in the zone" --price 154.99
 *   npm run journal-add -- claudeChat MRVL WAIT "wait for Friday's weekly close" --date 2026-11-05
 *   npm run journal-add -- claudeChat - WAIT "the market: no new money until the weekly close"     (- = the market)
 *
 * Flags: --date YYYY-MM-DD (default today, New York), --price N (the stock's price then), --qqq N (QQQ's price then),
 * --horizon "<text>", --note "<text>" (kept in refs.note). Exit: 0 written, 1 refused (one line says why).
 */

import { pathToFileURL } from 'node:url';
import { finish } from './core/finish.ts';
import { dataBranchDir, appendLedgerJsonl, readLedgerJsonl } from './ledger/store.ts';
import { makeJournalEntry } from './ledger/journal.ts';
import { JOURNAL_ADVICE, JOURNAL_SOURCES, LEDGER_FILES } from './ledger/schema.ts';

export const JOURNAL_ADD_USAGE = 'usage: npm run journal-add -- <' + JOURNAL_SOURCES.join('|') + '> <TICKER|-> <' + JOURNAL_ADVICE.join('|') + '> "<detail>" [--date YYYY-MM-DD] [--price N] [--qqq N] [--horizon "<text>"] [--note "<text>"]';

const FLAGS = ['--date', '--price', '--qqq', '--horizon', '--note'] as const;

export interface JournalAddArgs {
  readonly source: string; readonly ticker: string; readonly advice: string; readonly detail: string;
  readonly date: string | null; readonly price: string | null; readonly qqq: string | null; readonly horizon: string; readonly note: string | null;
}

/** The command line as fields; a string = why it cannot be read. */
export function parseJournalArgs(args: readonly string[]): JournalAddArgs | string {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if ((FLAGS as readonly string[]).includes(a)) {
      const v = args[i + 1];
      if (v == null) return a + ' needs a value. ' + JOURNAL_ADD_USAGE;
      flags[a] = v; i++;
    } else if (a.startsWith('--')) return 'unknown flag ' + a + '. ' + JOURNAL_ADD_USAGE;
    else pos.push(a);
  }
  const [source, ticker, advice, ...rest] = pos;
  if (!source || !ticker || !advice || !rest.length) return JOURNAL_ADD_USAGE;
  return { source, ticker, advice, detail: rest.join(' '), date: flags['--date'] ?? null, price: flags['--price'] ?? null, qqq: flags['--qqq'] ?? null, horizon: flags['--horizon'] ?? '', note: flags['--note'] ?? null };
}

const nyToday = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const priceOf = (t: string | null): number | null | 'bad' => {
  if (t == null) return null;
  const v = Number(t.replace(/[$,\s]/g, ''));
  return Number.isFinite(v) && v > 0 ? v : 'bad';
};

export interface JournalAddDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: number;
  readonly out: (line: string) => void;
  readonly cwd?: string;
}

/** Checks and appends one line; 0 = written, 1 = refused. */
export function runJournalAdd(args: readonly string[], d: JournalAddDeps): number {
  const p = parseJournalArgs(args);
  if (typeof p === 'string') { d.out('refused: ' + p); return 1; }
  const price = priceOf(p.price), qqq = priceOf(p.qqq);
  if (price === 'bad' || qqq === 'bad') { d.out('refused: --price and --qqq must be positive numbers'); return 1; }
  const m = makeJournalEntry({
    date: p.date ?? nyToday(d.now), source: p.source, ticker: p.ticker, advice: p.advice, detail: p.detail, priceAtAdvice: price, qqqAtAdvice: qqq,
    horizon: p.horizon, ...(p.note ? { refs: { note: p.note.slice(0, 200) } } : {}),
  }, new Date(d.now).toISOString());
  if (!m.ok) { d.out('refused: ' + m.why); return 1; }
  const root = dataBranchDir(d.env, d.cwd);
  const had = readLedgerJsonl(root, 'journal');
  if (had.some((e) => e.id === m.entry.id)) { d.out('refused: already in the journal (' + m.entry.id + '); nothing written'); return 1; }
  appendLedgerJsonl(root, 'journal', [m.entry]);
  const e = m.entry;
  d.out('appended to ' + LEDGER_FILES.journal + ' (' + root + '): ' + e.date + ' ' + e.source + ' ' + (e.ticker ?? 'market') + ' ' + e.advice + ' — ' + e.detail
    + (e.priceAtAdvice != null ? ' (price ' + e.priceAtAdvice + ')' : '') + '. Commit it to the data branch.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  finish(runJournalAdd(process.argv.slice(2), { env: process.env, now: Date.now(), out: (l) => process.stdout.write(l + '\n') }));
}
