/**
 * Per-step status accumulation and user-facing disclosure.
 *
 * Ports the semantics of the legacy setStatusV7 / buildDataStatusBannerV7 /
 * logDataStatusSummaryV7 trio, which were sound, while structurally
 * eliminating two real defects found in them:
 *
 *  1. ORDERING. In the legacy code the banner rendered inside
 *     buildDashboardV7 (called at fullStockAnalysisV10_9.gs:1498) BEFORE four
 *     model statuses were set (:1514, :1536, :1563, :1586). Those four steps'
 *     failures therefore never once reached the dashboard -- only the log.
 *     Here, status is accumulated throughout the run and rendered ONLY at the
 *     end, once every status is known. Not a fix: a shape in which the bug
 *     cannot occur.
 *
 *  2. RAW ERROR TEXT IN REPORTS. Technical detail and the user-facing
 *     sentence are different branded types (see result.ts), so handing an
 *     internal detail string to a report renderer is a compile error.
 */

import type { ReportSentence, LogDetail } from './result.ts';

export const StepState = {
  PENDING: 'pending',
  OK: 'ok',
  DEGRADED: 'degraded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const;

export type StepStateValue = (typeof StepState)[keyof typeof StepState];

export interface StatusEntry {
  readonly key: string;
  readonly label: string;
  readonly state: StepStateValue;
  /** Shown to the user. One clean sentence. */
  readonly disclosure?: ReportSentence;
  /** Technical. Logs only -- never rendered. */
  readonly detail?: LogDetail;
  readonly elapsedMs?: number;
  readonly attempts?: number;
}

export class StatusAccumulator {
  private readonly entries = new Map<string, StatusEntry>();

  set(entry: StatusEntry): void {
    this.entries.set(entry.key, entry);
  }

  get(key: string): StatusEntry | undefined {
    return this.entries.get(key);
  }

  all(): StatusEntry[] {
    return [...this.entries.values()];
  }

  byState(state: StepStateValue): StatusEntry[] {
    return this.all().filter((e) => e.state === state);
  }

  /** True when nothing failed, degraded, or was skipped. */
  isClean(): boolean {
    return this.all().every((e) => e.state === StepState.OK || e.state === StepState.PENDING);
  }
}

export interface DisclosureBlock {
  readonly headline: string;
  /** One curated sentence per problem. Safe to render verbatim. */
  readonly lines: ReportSentence[];
  readonly severity: 'ok' | 'partial';
}

/**
 * Builds the user-facing data-health block.
 *
 * Call this ONLY after the run is complete. Calling it mid-run reintroduces
 * the exact ordering bug described at the top of this file.
 */
export function buildDisclosure(status: StatusAccumulator): DisclosureBlock {
  const failed = status.byState(StepState.FAILED);
  const skipped = status.byState(StepState.SKIPPED);
  const degraded = status.byState(StepState.DEGRADED);

  if (failed.length === 0 && skipped.length === 0 && degraded.length === 0) {
    return { headline: 'All data sources OK — full-confidence report.', lines: [], severity: 'ok' };
  }

  const parts: string[] = [];
  if (failed.length) parts.push(`${failed.length} failed`);
  if (skipped.length) parts.push(`${skipped.length} skipped`);
  if (degraded.length) parts.push(`${degraded.length} degraded`);

  // Only `disclosure` is ever read here. `detail` is deliberately not
  // reachable from this function -- the types make that a compile error.
  const lines = [...failed, ...skipped, ...degraded]
    .map((e) => e.disclosure)
    .filter((s): s is ReportSentence => typeof s === 'string' && s.length > 0);

  return {
    headline: `PARTIAL DATA — this report relies on incomplete inputs. ${parts.join(', ')}.`,
    lines,
    severity: 'partial',
  };
}

/** End-of-run log summary. Technical detail is allowed here, unlike reports. */
export function summariseForLog(status: StatusAccumulator): string[] {
  const out: string[] = [];
  for (const e of status.all()) {
    if (e.state === StepState.OK || e.state === StepState.PENDING) continue;
    const detail = e.detail ? ` — ${String(e.detail)}` : '';
    const timing = e.elapsedMs != null ? ` [${(e.elapsedMs / 1000).toFixed(1)}s]` : '';
    out.push(`${e.state.toUpperCase()}: ${e.label}${detail}${timing}`);
  }
  return out;
}
