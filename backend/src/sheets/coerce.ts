/**
 * Sheets value coercion.
 *
 * THE HAZARD THIS MODULE EXISTS FOR: the Sheets API does NOT return
 * JavaScript Date objects. SpreadsheetApp did. The legacy readPriceCacheV7_
 * guards every row with
 *
 *     if (!(r[0] instanceof Date) || isNaN(r[0].getTime())) return;
 *
 * (fullStockAnalysisV10_9.gs:6003). Ported literally against the Sheets API,
 * `instanceof Date` is NEVER true, every row is skipped, and the function
 * silently returns null for every ticker -- a total failure that looks
 * exactly like an empty cache. No error, no symptom.
 *
 * So: raw cells are typed as the opaque SheetValue, and reading one as a
 * Date or number without passing through a coercer here is a type error.
 *
 * Every coercer returns `T | null`. None throws. None fabricates a value
 * from a malformed cell -- preserving the legacy code's correct instinct of
 * skipping bad rows rather than inventing a bar (:6003, :923).
 */

/**
 * A raw cell as the Sheets API hands it back. Never use directly.
 *
 * `Date` is included even though the Sheets API itself never returns one --
 * it is the defensive branch in toDate() below, kept because a caller could
 * pass through a value from another source (e.g. a JS Date already parsed
 * elsewhere). Without it in the union, `instanceof Date` is unreachable by
 * the type system and TypeScript correctly refuses to compile it.
 */
export type SheetValue = string | number | boolean | Date | null | undefined;

export type SheetRow = SheetValue[];

/**
 * Google Sheets serial-date epoch. Serial 0 is 1899-12-30, which puts
 * 1970-01-01 at serial 25569. Verified by the round-trip test in
 * test/coerce.test.ts rather than trusted.
 */
export const SHEETS_EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 86_400_000;

export function toStringOrNull(v: SheetValue): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function toStringSafe(v: SheetValue): string {
  return toStringOrNull(v) ?? '';
}

export function toUpperTicker(v: SheetValue): string {
  return toStringSafe(v).toUpperCase().trim();
}

export function toBoolean(v: SheetValue): boolean | null {
  if (typeof v === 'boolean') return v;
  const s = toStringOrNull(v);
  if (s === null) return null;
  const l = s.toLowerCase();
  if (l === 'true' || l === 'yes' || l === '1') return true;
  if (l === 'false' || l === 'no' || l === '0') return false;
  return null;
}

/**
 * Parses a number from a real spreadsheet cell.
 *
 * Handles the formats that actually appear in this user's Portfolio sheet:
 * currency symbols, thousands separators, percentages, parenthesised
 * negatives, and stray whitespace. Mirrors the legacy
 * parsePortfolioNumberV1_ behaviour.
 */
export function toNumber(v: SheetValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = toStringOrNull(v);
  if (s === null) return null;

  // Accounting-style negatives: (1,234.56) means -1234.56
  const negParen = /^\((.*)\)$/.exec(s);
  const body = negParen ? negParen[1] : s;
  const sign = negParen ? -1 : 1;

  const isPercent = body.trim().endsWith('%');
  const cleaned = body.replace(/[$€£₪,\s]/g, '').replace(/%$/, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return sign * (isPercent ? n / 100 : n);
}

/**
 * Converts a cell to a Date.
 *
 * Handles all three real shapes, because which one arrives depends on the
 * valueRenderOption used by the caller and on how the cell was written:
 *   - number  -> Sheets serial (UNFORMATTED_VALUE / SERIAL_NUMBER)
 *   - string  -> ISO or locale-formatted text (FORMATTED_VALUE)
 *   - Date    -> only if something upstream already converted it
 */
export function toDate(v: SheetValue): Date | null {
  if (v === null || v === undefined || v === '') return null;

  if (v instanceof Date) return Number.isNaN((v as Date).getTime()) ? null : (v as Date);

  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const ms = Math.round((v - SHEETS_EPOCH_OFFSET_DAYS) * MS_PER_DAY);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const s = String(v).trim();
  if (s === '') return null;

  // ISO first -- unambiguous, and what this system writes.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // US-style M/D/YYYY -- how Google Sheets formats dates in this locale.
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) {
    const d = new Date(Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2])));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** yyyy-mm-dd in UTC. This project's canonical date-string form. */
export function toIsoDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// formatDateInTz lives in core/dates.ts (one copy, dedupe cluster 18).

/**
 * Locates a header row by required column names and returns a name -> index
 * map.
 *
 * Mirrors the legacy myOpt_findTable / findPortfolioStockTableV1_ approach:
 * scan for the header rather than assume a fixed row, so rows inserted above
 * or between tables do not break anything, and column ORDER is irrelevant.
 */
export interface HeaderMatch {
  readonly rowIndex: number;
  readonly columns: Readonly<Record<string, number>>;
}

export function findHeaderRow(rows: SheetRow[], required: readonly string[]): HeaderMatch | null {
  for (let r = 0; r < rows.length; r++) {
    const cells = (rows[r] ?? []).map((c) => toStringSafe(c));
    if (!required.every((name) => cells.includes(name))) continue;

    const columns: Record<string, number> = {};
    cells.forEach((h, i) => {
      if (h !== '' && !(h in columns)) columns[h] = i;
    });
    return { rowIndex: r, columns };
  }
  return null;
}

export function cell(row: SheetRow | undefined, columns: Readonly<Record<string, number>>, name: string): SheetValue {
  if (!row) return null;
  const idx = columns[name];
  if (idx === undefined) return null;
  return row[idx] ?? null;
}
