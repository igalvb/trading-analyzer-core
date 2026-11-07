# Changelog

The shared core's releases. Version numbers are MAJOR.MINOR.PATCH (the `VERSION` file):

| Part | When | What a user does |
|---|---|---|
| PATCH (1.0.x) | a bug fix, no new setting | nothing: take the update |
| MINOR (1.x.0) | a new feature or report; old settings keep working | nothing required; the note says what is new |
| MAJOR (x.0.0) | something a user MUST do (a new required secret or setting, a sheet change, a relay re-paste) | the steps, in order, in the release note below |

Each release: a section `## vX.Y.Z (date)` with Added / Changed / Fixed / Action needed (MAJOR only).

## v2.0.1 (2026-11-07)

PATCH: a bug fix. Nothing to do.

### Fixed

- Live bot: the night's report text is logged at INFO. Its ❌ marks a strategy that does not beat both yardsticks;
  it was logged as 8 ERROR lines a night, so the run's error count was wrong.

## v2.0.0 (2026-11-06)

MAJOR: one command was removed from the Telegram relay, so the relay must be re-pasted. Everything new is optional and
off by default.

### Action needed

1. Re-paste the relay: Cloudflare → Workers & Pages → your relay worker → **Edit code** → paste
   `relay/telegram-relay.worker.mjs` (your own copy if you build one) → **Deploy**. Open the worker's address: it must
   answer `ok relay 2026-11-06.2`.

### Removed

- Telegram `/verify` and `/check` (the Opus check of the last 3 days). They now get the help text. The workflow
  `verify.yml` stays and can still be run by hand.

### Added

- The ledger (docs/LEDGER.md): holdings, other assets (pension, funds, real estate with its mortgage, cash), watchlist,
  money in / out, daily snapshots and typed targets as plain JSON files on the repository's private `data` branch.
  `npm run ledger-migrate` converts the Portfolio tab (read-only, with a reconciliation against the sheet's own totals
  and a "needs owner check" list; answers applied through an optional corrections file); `npm run ledger-history`
  copies the system's own tabs. Profile `storage.ledger: off | shadow | on` (default off): shadow compares and writes
  the day's snapshot; on reads the holdings from the ledger. Nightly: a separate job (the only one with write access,
  and only to the `data` branch) commits the snapshot.
- Crypto prices for the ledger from cryptoprices.cc (profile `ledger.cryptoPrices`, default off; BTC from Yahoo).
- Dashboard: Net worth screen (every group, $ / ₪ at today's rate, pies by group and by sub-type, ratio cards against
  typed targets, totals per person), the growth graph (group filters, money in / out marks, growth without deposits),
  edit screens (add / sell / change holdings, fund and property values, money in / out, watchlist) through the new Pages
  Function `/api/edit` (needs the dashboard token's extra permission **Contents: Read and write**). Installable as a
  phone app (Chrome "Install app"). Every dashboard-publishing workflow checks out the `data` branch read-only.

### Changed

- The dashboard is named "My Assets" and opens on Net worth.

## v1.1.0 (2026-11-06)

MINOR: a new, optional feature. Nothing to do unless you want it.

### Added

- The phone dashboard (docs/DASHBOARD.md): a private page on your own Cloudflare Pages (free), behind a Cloudflare
  Access sign-in. Overview, Portfolio (every holding, crypto included, grouped with totals), Exit, Buy, Paper test
  (every account, its holdings and full trade log, the weekly reports, top 5 against the yardsticks), History (sold
  and closed positions, totals and tax per year), Analyze, Options, Models, Runs, Actions, Settings; one search over
  everything; filters and sorting that are remembered. Buttons start Analyze (free or + Opus), Exit report (+ Opus),
  Nightly, My Options and Setup Check. Add it to the phone's home screen to open it like an app.
- `npm run dashboard-build` (`backend/src/dashboard/`, `backend/dashboard/`): reads the tabs the runs wrote, writes
  the site folder. No fetch, no sheet write, no key or sheet id in the data.
- Workflow **Dashboard** (manual) and a final step "Publish the dashboard" in Nightly, Analyze, Exit Report, Send Exit
  and My Options. It runs only when the new optional secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are
  set (skipped otherwise) and never fails a run. No new schedule or push trigger.

### Action needed

- None. To use the dashboard: docs/DASHBOARD.md (about 20 minutes, once).

## v1.0.0 (2026-11-06)

The first versioned core. Everything below is in it.

### What it is

- A stock analysis program for one person's list of stocks: it reads your Google Sheet, runs on GitHub Actions
  (Node 24, TypeScript in `backend/`, no build step), writes the report tabs back to your sheets and sends a short
  message plus a PDF to your Telegram. Long-only: long stock and long calls; no puts, shorts, writing calls or margin.
- Your settings are the `⚙️ Profile` tab (`backend/src/profile/`): your list, tax rate, time zone, features.
  `backend/src/profile/example.ts` is a made-up user. Without a profile a run refuses with one plain line.

### Runs (`.github/workflows/`, all started by hand or by the relay)

- Nightly (the full run), Analyze one ticker, Exit Report, Send Exit, My Options, AI summaries (Gemini; Claude Opus
  only when asked), Verify (an Opus check of the last 3 days of runs), Watchdog, Setup Check, Init User Sheets,
  Telegram check and setup, CI, Record, Long history, Fetch files, Migrate data tabs, Nightly backup.
- Several users of one copy: the `user` input; another user's secrets are named `ID_NAME` and its Profile tab is read
  first.

### Relay (`relay/telegram-relay.worker.mjs`, Cloudflare Worker)

- Telegram commands `/exit`, `/analyze` (button menu or a ticker; `opus` for Claude Opus), `/verify`, `/help`.
- The timed jobs (the nightly run, My Options) start from the relay's Cron Triggers.
- Settings `REPO` and `TICKERS` are required (no defaults); the status page lists any that are missing.

### Analysis and reports

- The engine ported from the original Apps Script (379 functions, checked against the frozen oracle in
  `backend/legacy/` by the parity tests), the course models (Broker Course, Turtle, Schabacker, Edwards & Magee,
  Wyckoff, trend, LILO, James phases 1-5: LEAPS, fair value, quality gate), the dark-pool and macro reads.
- Buy report, Exit report, Options decision and options tabs, Bottom Line, All Models, PDFs.
- Paper trading accounts and the weekly paper report; the live-broker planner (dry run) with its safety rails.
- A results pack per profile (`profile.results`; folder `RESULTS_DIR`, else `backend/results/`) for the history
  figures; none ships with the core.

### Checks

- `cd backend && npm ci && npm run typecheck && npm test`: the suite runs as a made-up test profile
  (`backend/test/testProfileEnv.ts`); no keys needed.
- The guard (`backend/test/genericGuard.test.ts`, strict: every count 0) and the lint ratchet.

### Core and overlay

- `core-manifest.json` lists the core files. A copy may keep private files next to them (an overlay: a built-in
  profile in `backend/src/owner/profile.ts`, its results in `backend/src/owner/results/`, its own tests in
  `backend/test/overlay/`); the core files stay byte-identical.
- `npm run export-core` copies the core out of a copy (no file changed, then a scan for private data);
  `npm run import-core -- <core checkout>` brings a release in (overlay never touched).
