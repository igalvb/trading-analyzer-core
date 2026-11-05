# Master Lock shim (Google Sheet)

What it does: turns every tab red when the sheet opens and adds a "Master Lock"
menu. A second part ("the guardian") undoes edits made by hand on red tabs.
It is NOT real protection: anyone who can edit the sheet can unlock it.

## Before you start: which case are you in?

- **Case A: your old Apps Script project is still attached to the sheet.**
  It already contains this lock. Do not paste the shim into it (the function
  names would clash). Just do step 4 (check the trigger) and step 5 (test).
- **Case B: fresh start (old script removed or never copied).** Do steps 1-5.
  If the old script is still attached, first open it, copy everything to a
  safe file as a backup, then delete all of its code. Two scripts on one
  sheet would give you two Master Lock menus.

## Steps

1. Open your Google Sheet. Click Extensions > Apps Script.
2. Delete any placeholder code (`function myFunction() {}`). Open
   `masterLock.gs` from this folder, copy everything, and paste it in.
   Click the disk icon (Save).
3. Authorize: in the toolbar choose the function `onOpen` and click Run.
   Google asks for permission: Review permissions > pick your account >
   Advanced > Go to project (unsafe) > Allow. The "unsafe" wording is normal
   for your own script.
4. Turn on the guardian (one time): in the editor click the clock icon
   (Triggers) > Add Trigger. Choose function `sheetGuardian`, deployment
   "Head", event source "From spreadsheet", event type "On edit". Save.
   Without this trigger the tabs turn red but edits are NOT undone.
5. Test:
   a. Reload the sheet. Every tab should be red and a "HARD LOCK ACTIVE"
      message should appear. A "Master Lock" menu should be in the menu bar.
   b. Type something in a cell on any tab. It should snap back and show
      "LOCKED: Use menu to unlock."
   c. Master Lock > Unlock All Sheets. Tab colours disappear. Edit a cell;
      it now stays.
   d. Master Lock > Lock All Sheets. Tabs turn red again.
   Note: unlocking removes every tab's own colour. The nightly run sets its
   own colours again when it rebuilds a tab.

## How the nightly run uses it

The nightly backend does not run any Apps Script. Around its writes it does:
1. Unlock (clears the tab colours; done in code by `withUnlockedSheets`, manual command `unlock-sheets`).
2. Write the data.
3. Lock (turns every tab red; done in code in a `finally`, and again by `lock-sheets` as the last workflow step, which runs even after a crash).

There is no extra permission to set up. The lock uses no real protections, so
the backend only needs normal editor access to the sheet.

Checked 2026-10-27: with the guardian installed, every live run (nightly, AI, My Options,
Analyze, Exit Report) wrote through unlock -> write -> lock without a revert.
Optional check (original note): with the guardian trigger installed and tabs red, ask the
developer to write one test cell from the backend. If it is reverted, the
unlock-first step above is required; if not, it is merely a safe habit.
