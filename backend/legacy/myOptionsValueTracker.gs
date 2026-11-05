// ══════════════════════════════════════════════════════════════════
//  MY OPTIONS VALUE TRACKER — Standalone Google Apps Script
//  Auto-locates table on 'Portfolio' sheet by header row content.
// ══════════════════════════════════════════════════════════════════

// Version tracking, same discipline as every other tracked file --
// first real version marker for this file (previously edited in place
// with no marker at all).
const MY_OPTIONS_TRACKER_VERSION = 'v1.2'; // v1.1 (2026-09-07): Pass 6 of the fetch/analyze separation refactor (docs/BIG_PLAN_FETCH_ANALYZE_SEPARATION.md) -- this file's own real fetch-owning function (myOpt_fetchCurrentPrice, CBOE delayed quotes for the user's own options portfolio marks) + its 2 fetch-only helpers (myOpt_buildUrl, myOpt_parseOcc) MOVED VERBATIM to dataLayerV1.gs. myOpt_parseDate/myOpt_findTable stay here -- general-purpose (used outside the fetch path too, e.g. reading the Portfolio sheet's expiry column). User's own explicit words on why this file is in scope at all: "you need to know the portfolio I have and its status." Real Apps Script shared global scope means zero call-site changes.
// v1.2 (2026-09-08): user's own direct correction -- "why the hell would i
// create another sheets for that ???? all the data is in the file i
// provided there is a portfolio sheets" -- the 📤 Exit Strategy report
// (fullStockAnalysisV10_2.gs) now reads THIS real, already-populated
// Portfolio sheet directly instead of a new Transactions ledger. Added
// findPortfolioStockTableV1_ + parsePortfolioNumberV1_ below, same
// header-search-by-name discipline as the existing myOpt_findTable (order-
// independent, survives rows inserted above the table). Real, confirmed
// gap: neither this sheet's stock/crypto table nor its options table has
// an entry/buy DATE column (only a blended average PRICE across multiple
// real buys -- user's own words, "cost avg per stock", "i ad many
// entries") -- user's own explicit plan is to add one later ("i will add
// avrage buy"), not built yet. Until then the Exit Strategy report's stop
// calc uses a disclosed generic lookback, not a real since-entry window
// -- see EXIT_STRATEGY_GENERIC_LOOKBACK_TRADING_DAYS_V1 in the engine file.

const MYOPT_PORTFOLIO_SHEET_NAME = 'Portfolio';

/**
 * Robustly parses date inputs whether they are JS Date objects, ISO strings,
 * or formats like "Mar19'27", "JUN17'27", "17-Jun-2027", "2027-06-17".
 */
function myOpt_parseDate(val) {
  if (val instanceof Date && !isNaN(val.getTime())) {
    return { year: val.getFullYear(), month: val.getMonth() + 1, day: val.getDate() };
  }
  const str = String(val || '').trim();
  if (!str) return null;

  // Match formats like "Mar19'27", "JUN17'27", "Dec17'27"
  const mShort = str.match(/^([A-Za-z]{3})\s*(\d{1,2})['\s]*(\d{2,4})$/);
  if (mShort) {
    const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
    const mm = months[mShort[1].toLowerCase()];
    const dd = parseInt(mShort[2], 10);
    let yy = parseInt(mShort[3], 10);
    if (yy < 100) yy += 2000;
    if (mm && dd && yy) return { year: yy, month: mm, day: dd };
  }

  // Fallback standard JS Date parse
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  return null;
}

/**
 * Parses an OCC option symbol string (e.g. PLTR270319C00120000).
 */


/**
 * Scans the 'Portfolio' sheet for the header row (contains 'last trade Date'
 * and 'positions'), so inserting rows above the table doesn't break it.
 * Column positions are read by name — order-independent too.
 */
function myOpt_findTable(ss) {
  const sh = ss.getSheetByName(MYOPT_PORTFOLIO_SHEET_NAME);
  if (!sh) return { error: 'No sheet named "' + MYOPT_PORTFOLIO_SHEET_NAME + '" found.' };

  const data = sh.getDataRange().getValues();
  for (let r = 0; r < data.length; r++) {
    const row = data[r].map(c => String(c || '').trim());
    if (row.indexOf('last trade Date') === -1 || row.indexOf('positions') === -1) continue;

    const col = {};
    row.forEach((h, i) => { if (h) col[h] = i; });

    const required = ['Ticker', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'current market value'];
    const missing = required.filter(k => col[k] == null);
    if (missing.length) return { error: 'Found options table, but missing column(s): ' + missing.join(', ') };

    return { sheet: sh, headerRow: r + 1, col: col }; // r is 0-based; headerRow is 1-based sheet row
  }
  return { error: 'Could not find options table header row containing "last trade Date" and "positions".' };
}

/**
 * Scans the same 'Portfolio' sheet for the REAL, SEPARATE stock/crypto
 * table's header row (contains 'cost avg per stock' and 'Ticker') -- same
 * order-independent, search-by-name discipline as myOpt_findTable above,
 * so rows inserted above the table (or between the 2 real tables on this
 * sheet) don't break it. Real, confirmed header, 2026-09-08: Ticker | type
 * | sub-type | amount | price per item | value of investment | Allocation
 * % | cost avg per stock | total revenue in % bruto | total rev. in %
 * after tax | total rev. in $ after tax | URLS / comments.
 */
function findPortfolioStockTableV1_(ss) {
  const sh = ss.getSheetByName(MYOPT_PORTFOLIO_SHEET_NAME);
  if (!sh) return { error: 'No sheet named "' + MYOPT_PORTFOLIO_SHEET_NAME + '" found.' };

  const data = sh.getDataRange().getValues();
  for (let r = 0; r < data.length; r++) {
    const row = data[r].map(c => String(c || '').trim());
    if (row.indexOf('cost avg per stock') === -1 || row.indexOf('Ticker') === -1) continue;

    const col = {};
    row.forEach((h, i) => { if (h) col[h] = i; });

    const required = ['Ticker', 'type', 'amount', 'cost avg per stock'];
    const missing = required.filter(k => col[k] == null);
    if (missing.length) return { error: 'Found stock/crypto table, but missing column(s): ' + missing.join(', ') };

    return { sheet: sh, headerRow: r + 1, col: col }; // r is 0-based; headerRow is 1-based sheet row
  }
  return { error: 'Could not find stock/crypto table header row containing "cost avg per stock" and "Ticker".' };
}

/**
 * Real, shared number parser for both Portfolio sub-tables -- cells here
 * can carry $ / % / , formatting (Google Sheets number formatting doesn't
 * change the underlying value normally, but a manually-typed cell can be a
 * literal string like "$48.10"); strips anything that isn't a digit, dot,
 * or leading minus before parsing. Returns null (not NaN) on a real,
 * unparseable cell so callers can distinguish "no value" from "zero".
 */
function parsePortfolioNumberV1_(v) {
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}


function refreshMyOptionsValue() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const loc = myOpt_findTable(ss);

  if (loc.error) {
    Logger.log('❌ refreshMyOptionsValue: ' + loc.error);
    try { SpreadsheetApp.getUi().alert(loc.error); } catch (e) {}
    return;
  }

  const sh = loc.sheet, col = loc.col;
  const lastCol = sh.getLastColumn();
  const data = sh.getRange(loc.headerRow + 1, 1, sh.getLastRow() - loc.headerRow, lastCol).getValues();
  let updated = 0, skipped = 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const r = loc.headerRow + 1 + i; // 1-based sheet row

    const ticker = String(row[col['Ticker']] || '').toUpperCase().trim();
    if (!ticker) break; // end of table

    const strike = parseFloat(row[col['strike']]);
    const sideRaw = String(row[col['PUT/CALL']] || '').toLowerCase().trim();
    const side = sideRaw === 'put' ? 'put' : 'call';
    const contracts = parseFloat(row[col['positions']]);
    const expiryCell = row[col['last trade Date']];

    const parsedDate = myOpt_parseDate(expiryCell);

    if (isNaN(strike) || isNaN(contracts) || !parsedDate) {
      Logger.log('⚠️ Skipping row ' + r + ': invalid strike/positions/date (' + expiryCell + ')');
      skipped++;
      continue;
    }

    const result = myOpt_fetchCurrentPrice(ticker, strike, parsedDate, side);
    const targetCell = sh.getRange(r, col['current market value'] + 1);

    if (!result.found || result.mid == null) {
      targetCell.setValue('N/A — ' + result.reason);
      skipped++;
    } else {
      const currentValueTotal = result.mid * 100 * contracts;
      targetCell.setValue(currentValueTotal);
      targetCell.setNumberFormat('$#,##0.00');
      updated++;
    }
  }
  Logger.log('✅ refreshMyOptionsValue: ' + updated + ' updated, ' + skipped + ' skipped.');
}

function installMyOptionsEndOfDayTrigger() {
  const HANDLER = 'refreshMyOptionsValue';
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === HANDLER);
  if (existing.length > 0) {
    Logger.log('Trigger already installed.');
    return;
  }
  ScriptApp.newTrigger(HANDLER).timeBased().everyDays(1).atHour(17).create();
  Logger.log('✅ Daily trigger installed for refreshMyOptionsValue (~5:00 PM).');
}
