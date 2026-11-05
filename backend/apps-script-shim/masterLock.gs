// ══════════════════════════════════════════════════════════════
//  MASTER LOCK SHIM -- standalone, paste into the Sheet's Apps Script editor.
//  lockAllSheets / unlockAllSheets / sheetGuardian are copied VERBATIM from
//  legacy/futuresStockAnalysisV3_3_11.gs lines 1573-1605. Only onOpen below
//  is new: it keeps just the Master Lock menu (legacy :87-91) and the
//  lock-on-open call (legacy :93-94). The two stock-analyzer menus were left
//  out because they call functions that do not exist in this shim.
//  Use in a project that does NOT already contain the legacy script
//  (duplicate function names would clash). See README.md.
//  The guardian also needs a one-time manual "On edit" trigger: see README.md.
// ══════════════════════════════════════════════════════════════
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  // MENU 3: Master Lock
  ui.createMenu('🔒 Master Lock')
    .addItem('🔓 Unlock All Sheets (Deep Clean)', 'unlockAllSheets')
    .addItem('🔒 Lock All Sheets', 'lockAllSheets')
    .addToUi();

  // DEFAULT BEHAVIOR: Lock everything on refresh
  lockAllSheets();
}

function lockAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // Loop through EVERY tab (even those without scripts) and turn them Red
  ss.getSheets().forEach(sh => sh.setTabColor("#d50000"));
  ss.toast("🔒 HARD LOCK ACTIVE", "Security");
}

function unlockAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // Clear the color to stand down the Guardian
  ss.getSheets().forEach(sh => sh.setTabColor(null));
  ss.toast("🔓 UNLOCKED", "Security");
}

/**
 * THE GUARDIAN
 * This is the only function that can stop an OWNER.
 * It is called by the Google Server, not by your code.
 */
function sheetGuardian(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  // If the tab color is Red, we revert the edit immediately
  if (sheet.getTabColor() === "#d50000") {
    if (e.oldValue === undefined) {
      e.range.clearContent(); 
    } else {
      e.range.setValue(e.oldValue);
    }
    SpreadsheetApp.getActiveSpreadsheet().toast("🛑 LOCKED: Use menu to unlock.", "Security", 2);
  }
}
