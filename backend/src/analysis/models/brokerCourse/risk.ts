/**
 * Broker Course Phase 8 -- risk-management overlay (:1465-1628,
 * 6 functions + the SPDR ticker list; episode 7). A hard rule layer, not a
 * scored category.
 *
 * ══ THE ONE STRUCTURAL CHANGE: THE TWO ETF FETCHES ARE LIFTED OUT ═════
 * Legacy riskOverlayReadV1(marketCap, atrPct, ticker) fetched State
 * Street's XLSX holdings (fetchSpdrEtfTopHoldingsV1, :1611, guarded by
 * hasTimeBudgetV7_) and, failing that for QQQ, SEC NPORT-P
 * (fetchQqqTopHoldingsV1, :1615). The port takes both results as
 * parameters. The fetch rules the caller must apply, verbatim from legacy:
 * SPDR is fetched when `ticker` is truthy and the time budget allows; QQQ
 * only when no SPDR result came back AND ticker === 'QQQ'.
 *
 * The three XML parsers are pure and live here because the legacy file
 * holds them, but their only real consumer is the fetcher
 * (dataLayerV1.gs:1328-1329); the fetch layer should import them from
 * here. Legacy names end in `_` (private by convention); dropped here.
 *
 * ══ FLAGGED (F-25): WHAT THOSE FETCHES PRODUCE IS NEVER SHOWN ═════════
 * The fetches' only product is `etfPositionSizing`. Across all ten legacy
 * files that field appears exactly twice, both inside riskOverlayReadV1;
 * the formatter renders only `report.risk.evidence` (:2211) and no
 * synthesis rule reads it. So up to two real network calls per SPY/XL-sector/QQQ
 * report -- one of them given its own hang guard -- produce text no user
 * sees. Reproduced, not fixed.
 */

export interface PositionSizeRange {
  readonly tier: 'Blue-chip/mega-cap' | 'Speculative/small-cap' | 'Mid-range';
  readonly note: string;
  readonly volatilityNote: string | null;
}

/**
 * The course's two sizing numbers (ep.7): up to 20% for >$30B, down to 5%
 * for speculative names -- "speculative" taken as Phase 1's <$2B Small-Cap
 * boundary because the course gives no second number. Both boundaries are
 * strict, so exactly $2B and exactly $30B are Mid-range. ATR% > 10%
 * (strict) adds a lean-low note.
 */
export function positionSizeRangeV1(
  marketCap: number | null | undefined, atrPct: number | null | undefined,
): PositionSizeRange | null {
  if (marketCap == null) return null;
  const BLUE_CHIP_MIN_MARKET_CAP = 30e9;
  const SPECULATIVE_MAX_MARKET_CAP = 2e9;
  let tier: PositionSizeRange['tier'];
  let note: string;
  if (marketCap > BLUE_CHIP_MIN_MARKET_CAP) {
    tier = 'Blue-chip/mega-cap';
    note = 'Up to 20% of portfolio for a blue-chip/mega-cap (>$30B) — course\'s own explicit ceiling (ep.7)';
  } else if (marketCap < SPECULATIVE_MAX_MARKET_CAP) {
    tier = 'Speculative/small-cap';
    note = 'Down to a 5% floor for a speculative/small-cap name — course\'s own explicit floor (ep.7); <$2B cutoff reuses this file\'s own Phase 1 market-cap tier boundary since the course gives no second exact number';
  } else {
    tier = 'Mid-range';
    note = 'Between the course\'s 5% floor and 20% ceiling — course gives no exact number for this range; scale down as market cap drops and volatility rises (ep.7)';
  }
  const volatilityFlag = atrPct != null && atrPct > 0.10;
  return {
    tier, note,
    volatilityNote: volatilityFlag
      ? 'ATR% flagged very-high volatility — argues for the LOWER end of whatever range applies (ep.7)'
      : null,
  };
}

/** The breakeven-lock rule (ep.7), as a standing reminder: the report holds no position state. */
export function breakevenLockNoteV1(): string {
  return 'Once a position\'s unrealized profit crosses 1R (R:R = 1:1), move the stop up to at least breakeven — never let a winning trade round-trip back into a loss (ep.7). This report can\'t track whether you\'re already in a position or your entry price, so this is a standing reminder, not a computed trigger.';
}

/** State Street equity ETFs with a known holdings file. A legacy `var`, also read by dataLayerV1.gs:1318. */
export const SPDR_ETF_TICKERS: readonly string[] = [
  'SPY', 'XLK', 'XLF', 'XLE', 'XLV', 'XLP', 'XLY', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC',
];

/** XLSX sharedStrings: concatenates rich-text runs, decodes the five basic entities. */
export function parseSpdrSharedStringsV1(xml: string): string[] {
  const sis = xml.match(/<si>[\s\S]*?<\/si>/g) || [];
  return sis.map((si) => {
    const ts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    return ts.map((t) => t.replace(/<[^>]*>/g, '')).join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'');
  });
}

export type SpdrCellValue = string | number | null | undefined;

/**
 * One cell: shared-string lookup when `t="s"`, else parseFloat. No `<v>`
 * gives null; an out-of-range string index gives undefined.
 */
export function spdrCellValueV1(cellXml: string, sharedStrings: readonly string[]): SpdrCellValue {
  const isString = /t="s"/.test(cellXml);
  const vMatch = cellXml.match(/<v>([^<]*)<\/v>/);
  if (!vMatch) return null;
  return isString ? sharedStrings[parseInt(vMatch[1], 10)] : parseFloat(vMatch[1]);
}

export interface SpdrParsedHolding {
  readonly name: SpdrCellValue;
  readonly ticker: SpdrCellValue;
  readonly weightPct: SpdrCellValue;
}

/**
 * Holdings rows from sheet1: data starts at row 6 (header is row 5), A =
 * name, B = ticker, E = weight; a row missing A or B is skipped; stops at
 * topN.
 *
 * ══ LATENT: A SELF-CLOSING CELL SWALLOWS ITS NEIGHBOUR ════════════════
 * The cell regex ends in an OPTIONAL `(?:[\s\S]*?<\/c>)?`, so a self-
 * closing `<c r="D6" .../>` extends through the NEXT cell's `</c>`. When
 * the swallowed cell is E (Weight), `weightPct` comes back undefined, and
 * riskOverlayReadV1's `h.weightPct.toFixed(1)` would throw. Demonstrated on
 * synthetic XML; whether State Street's real files contain self-closing
 * cells is unknown (no fixture), so not registered.
 */
export function parseSpdrHoldingsV1(
  sheetXml: string, sharedStrings: readonly string[], topN: number,
): SpdrParsedHolding[] {
  const rows = sheetXml.match(/<row r="\d+"[^>]*>[\s\S]*?<\/row>/g) || [];
  const holdings: SpdrParsedHolding[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNum = parseInt((rows[i].match(/<row r="(\d+)"/) || [])[1] as string, 10);
    if (rowNum < 6) continue;
    const cells = rows[i].match(/<c r="[A-Z]+\d+"[^>]*\/?>(?:[\s\S]*?<\/c>)?/g) || [];
    const byCol: Record<string, SpdrCellValue> = {};
    cells.forEach((c) => {
      const col = (c.match(/<c r="([A-Z]+)\d+"/) || [])[1] as string;
      byCol[col] = spdrCellValueV1(c, sharedStrings);
    });
    if (byCol.A == null || byCol.B == null) continue;
    holdings.push({ name: byCol.A, ticker: byCol.B, weightPct: byCol.E });
    if (holdings.length >= topN) break;
  }
  return holdings;
}

/** Shape returned by the fetch layer's fetchSpdrEtfTopHoldingsV1. */
export interface SpdrHoldings {
  readonly holdings: ReadonlyArray<{ readonly ticker: string; readonly weightPct: number }>;
  readonly top10ConcentrationPct: number;
}

/** Shape returned by the fetch layer's fetchQqqTopHoldingsV1 (by NAME: NPORT-P has no tickers). */
export interface QqqHoldings {
  readonly holdings: ReadonlyArray<{ readonly name: string; readonly weightPct: number }>;
  readonly top10ConcentrationPct: number;
  readonly filingDate: string;
}

export interface RiskOverlay {
  readonly positionSizeTier: PositionSizeRange['tier'] | null;
  readonly evidence: string[];
  /** F-25: never rendered or read anywhere in legacy. */
  readonly etfPositionSizing: string;
}

/**
 * Evidence = the sizing note, the volatility note if any, and the
 * breakeven reminder (always). The ETF text has four arms: SPDR holdings,
 * QQQ holdings, out-of-scope ticker, and "fetch/parse failed" -- the last
 * also covers a fetch skipped for time budget and a missing ticker, where
 * nothing was fetched at all.
 */
export function riskOverlayReadV1(
  marketCap: number | null | undefined,
  atrPct: number | null | undefined,
  ticker: string | null | undefined,
  spdrHoldings: SpdrHoldings | null,
  qqqHoldings: QqqHoldings | null,
): RiskOverlay {
  const positionSize = positionSizeRangeV1(marketCap, atrPct);
  const evidence: string[] = [];
  if (positionSize) {
    evidence.push(positionSize.note);
    if (positionSize.volatilityNote) evidence.push(positionSize.volatilityNote);
  }
  evidence.push(breakevenLockNoteV1());
  const etfPositionSizing = spdrHoldings
    ? 'Top-10 holdings: ' + spdrHoldings.holdings.map((h) => h.ticker + ' ' + h.weightPct.toFixed(1) + '%').join(', ') + ' — ' + spdrHoldings.top10ConcentrationPct.toFixed(1) + '% concentration in top 10'
    : qqqHoldings
      ? 'Top-10 holdings (by name, SEC NPORT-P, filed ' + qqqHoldings.filingDate + '): ' + qqqHoldings.holdings.map((h) => h.name + ' ' + h.weightPct.toFixed(1) + '%').join(', ') + ' — ' + qqqHoldings.top10ConcentrationPct.toFixed(1) + '% concentration in top 10'
      : (ticker && SPDR_ETF_TICKERS.indexOf(ticker) < 0 && ticker !== 'QQQ'
        ? 'Not available for ' + ticker + ' — real source found (State Street) only covers SPY + the 11 sector SPDRs; QQQ covered via SEC NPORT-P; SMH/etc need a different issuer-specific source, real future work'
        : 'Not available — real fetch/parse failed for this real-time run (non-fatal, see log)');
  return {
    positionSizeTier: positionSize ? positionSize.tier : null,
    evidence,
    etfPositionSizing,
  };
}
