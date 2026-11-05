/**
 * FL-9b: command line for the verification tools. Entry point: src/verifyCli.ts.
 *
 *   parity   [--full]                                   the parity gate; exit 1 on any failure
 *   parallel --legacy-dir D --backend-dir D [--config F] [--earnings d1,d2] [--rollback-date d] [--reviewed-date d]
 *            [--show-values] [--out F]                  per-night comparison + Phase 8 run verdict; exit 1 on NO-GO
 *   triggers [--legacy-dir D --backend-dir D ...parallel options] [--commands a,b] [--approved-on d] [--live-count n]
 *            [--blocking F-1,F-2] [--out F]             trigger-removal checklist; exit 1 on NO-GO
 *
 * PRIVACY: the directories hold a private export of the real sheet. They are taken only as arguments, must be
 * outside the repository (assertPrivatePath), and nothing from them is written unless --show-values is given.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { buildParityReport, renderParityTable } from './parityGate.ts';
import { PARITY_ALIASES, PARITY_WAIVERS } from './parityWaivers.ts';
import { assertPrivatePath, listSnapshotDates, loadCliSubcommands, loadLegacySources, loadPackageScripts, loadPortSources, loadTestSources, loadWorkflowFiles, readSnapshot } from './parityLoad.ts';
import { compareNight, emptyRuleUse, evaluateRun, renderRunReport } from './parallelRun.ts';
import type { CompareConfig, NightPair, NightResult, NightSnapshot, RunEvaluation, RunFacts, RuleUse } from './parallelRun.ts';
import { decideRemoval, renderChecklist } from './triggerChecklist.ts';

export const OPTIONS = {
  full: { type: 'boolean' },
  'legacy-dir': { type: 'string' },
  'backend-dir': { type: 'string' },
  config: { type: 'string' },
  earnings: { type: 'string' },
  'rollback-date': { type: 'string' },
  'reviewed-date': { type: 'string' },
  'show-values': { type: 'boolean' },
  out: { type: 'string' },
  commands: { type: 'string' },
  'approved-on': { type: 'string' },
  'live-count': { type: 'string' },
  blocking: { type: 'string' },
} as const;

export interface CliValues {
  full?: boolean;
  'legacy-dir'?: string;
  'backend-dir'?: string;
  config?: string;
  earnings?: string;
  'rollback-date'?: string;
  'reviewed-date'?: string;
  'show-values'?: boolean;
  out?: string;
  commands?: string;
  'approved-on'?: string;
  'live-count'?: string;
  blocking?: string;
}

const list = (s: string | undefined): string[] => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

export function parityCommand(full: boolean): { readonly text: string; readonly exitCode: number } {
  const report = buildParityReport({ legacy: loadLegacySources(), src: loadPortSources(), tests: loadTestSources(), waivers: PARITY_WAIVERS, aliases: PARITY_ALIASES });
  return { text: renderParityTable(report, { full }), exitCode: report.pass ? 0 : 1 };
}

interface ParallelOutcome { readonly nights: NightResult[]; readonly evaluation: RunEvaluation; readonly cfg: CompareConfig; readonly use: RuleUse }

export function runParallel(v: CliValues): ParallelOutcome {
  const legacyDir = assertPrivatePath(String(v['legacy-dir'] ?? ''));
  const backendDir = assertPrivatePath(String(v['backend-dir'] ?? ''));
  const cfg: CompareConfig = v.config ? (JSON.parse(fs.readFileSync(assertPrivatePath(v.config), 'utf8')) as CompareConfig) : {};
  const use = emptyRuleUse();
  const dates = [...new Set([...listSnapshotDates(legacyDir), ...listSnapshotDates(backendDir)])].sort();
  const nights = dates.map((date) => {
    const pair: NightPair = { date, legacy: readSnapshot(legacyDir, date) as unknown as NightSnapshot | null, backend: readSnapshot(backendDir, date) as unknown as NightSnapshot | null };
    return compareNight(pair, cfg, use);
  });
  const facts: RunFacts = { earningsDates: list(v.earnings), rollbackTestedOn: v['rollback-date'] ?? null, reviewedWithUserOn: v['reviewed-date'] ?? null };
  return { nights, evaluation: evaluateRun(nights, facts), cfg, use };
}

export function parallelCommand(v: CliValues): { readonly text: string; readonly exitCode: number } {
  const r = runParallel(v);
  return { text: renderRunReport(r.nights, r.evaluation, r.cfg, r.use, { showValues: !!v['show-values'] }), exitCode: r.evaluation.verdict === 'GO' ? 0 : 1 };
}

export function triggersCommand(v: CliValues): { readonly text: string; readonly exitCode: number } {
  const run = v['legacy-dir'] && v['backend-dir'] ? runParallel(v).evaluation : null;
  const inp = {
    workflowFiles: loadWorkflowFiles(),
    availableCommands: [...loadPackageScripts().available, ...loadCliSubcommands(), ...list(v.commands)],
    run,
    rollbackTestedOn: v['rollback-date'] ?? null,
    userApprovedRemovalOn: v['approved-on'] ?? null,
    openBlockingFindings: list(v.blocking),
    liveTriggerCountAfterRemoval: v['live-count'] === undefined ? null : Number(v['live-count']),
  };
  const d = decideRemoval(inp);
  return { text: renderChecklist(d, inp), exitCode: d.removal === 'GO' && d.cutover !== 'FAILED' ? 0 : 1 };
}

export function main(argv: readonly string[]): number {
  const parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  const values = parsed.values as CliValues;
  const positionals = parsed.positionals;
  const cmd = positionals[0];
  let res: { readonly text: string; readonly exitCode: number };
  if (cmd === 'parity') res = parityCommand(!!values.full);
  else if (cmd === 'parallel') res = parallelCommand(values);
  else if (cmd === 'triggers') res = triggersCommand(values);
  else { console.error('usage: verifyCli.ts parity | parallel | triggers (see src/verify/cli.ts)'); return 2; }
  if (values.out) fs.writeFileSync(values.out, res.text);
  else process.stdout.write(res.text);
  return res.exitCode;
}
