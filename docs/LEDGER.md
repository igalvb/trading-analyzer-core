# The ledger: leaving Google Sheets for the holdings

Owner decision, 6 Nov 2026: the system leaves Google Sheets. Only the **Portfolio** tab (holdings, the static
values above the stock table) and the **🎯 Watchlist** move, plus the system's own history. They become plain JSON
files on the repository's private `data` branch, next to the `prices` branch the long price history already uses.
Google stays untouched (read-only) until the owner approves each switch below; going back is always one setting.

## The format (backend/src/ledger/schema.ts)

One shared format for the migration, the runs, the dashboard and the dashboard's edit screens.

| File on the `data` branch | Type | What it holds |
|---|---|---|
| `ledger/holdings.json` | LedgerHoldings | stocks (kind `stock`, `btcFund` = a spot bitcoin ETF, `crypto`), open options, closed positions |
| `ledger/assets.json` | LedgerAssets | pension, other savings funds, real estate (value + mortgage `debt`), cash: static values in ILS |
| `ledger/watchlist.json` | LedgerWatchlist | the Buy report's candidates |
| `ledger/targets.json` | LedgerTargets | optional: numbers the owner typed for himself (e.g. an all-time-high ratio he watches) |
| `ledger/prices.json` | LedgerPrices | optional: the Nightly's crypto prices of the night by holding id (profile `ledger.cryptoPrices`) |
| `ledger/flows.jsonl` | LedgerFlow | money in / out, one JSON object per line, append-only |
| `ledger/snapshots.jsonl` | LedgerSnapshot | one line per day: value per group in USD, total USD / ILS, the USD/ILS rate |
| `ledger/edits.jsonl` | LedgerEdit | every dashboard edit (audit trail), append-only |

Rules (backend/src/ledger/store.ts): JSON files are pretty-printed and written whole; JSONL files are append-only
(a line is never rewritten; a snapshot day already saved is kept). Every file and every line carries `schema`; a reader
refuses a newer schema and a broken file with one plain line naming the file. Money has a `currency` per item;
dates are `YYYY-MM-DD`. Additive fields (2026-11-06): `LedgerAsset.person` (whose item), `LedgerAsset.savingsType`
(the sheet's own word for it).

The runs find the branch's folder through `DATA_BRANCH_DIR` (default `../data-branch` from `backend/`, which is where
the Nightly checks the branch out).

## The phases

| Phase | What | Command / setting | Google |
|---|---|---|---|
| 1 | Convert the two tabs into the ledger files, with a reconciliation and a "needs owner check" list | `npm run ledger-migrate -- --out <dir> [--check]` | read only |
| 2 | The owner checks the files and the list, fixes what is wrong (in the files), commits them to the `data` branch | by hand / the dashboard's edit screens | untouched |
| 3a | Shadow: the Nightly reads the holdings from the sheet AND the ledger, logs one comparison line, appends the day's snapshot | profile `storage.ledger: 'shadow'` | read as today |
| 3b | On: the runs read the holdings from the ledger only | profile `storage.ledger: 'on'` | not read for holdings |
| 4 | Copy the system's own history tabs to files (nothing reads them yet) | `npm run ledger-history -- --out <dir>` | read only |

### Phase 1: the migration

`npm run ledger-migrate -- --out <dir>` reads the Portfolio tab and the Watchlist with a read-only Google scope and
writes, laid out like the `data` branch:

- `<dir>/ledger/holdings.json`, `assets.json`, `watchlist.json` (and `targets.json` when the layout names targets)
- `<dir>/migration/needs-owner-check.json`: every row it could not map with certainty, and every flagged total
- `<dir>/migration/reconciliation.md`: the table below
- `<dir>/migration/crypto-price-cells.json`: where each coin's price comes from today (the cell, the cell or function
  its formula reads, the coin symbol a sheet script fetches into it): the input for a later crypto price job

How each part is read (backend/src/ledger/fromSheet.ts):

- **Stock table**: exactly the rows the runs hold today (sheets/readers/portfolio.ts parsePortfolio), plus the crypto
  rows the runs skip (kind `crypto`, the sheet's price as `manualPrice`); the spot bitcoin ETFs (types/bitcoinEtfs.ts)
  become kind `btcFund`. Rows marked with `*` and TOTAL rows are left out by the runs and by the sheet's totals: they are
  NOT migrated, and each such row with a quantity is listed for the owner. USD.
- **Options**: the OPEN section as the runs read it. **CLOSED** section: one closed position per row; `Sell Price` 10x
  or more above the per-share premium is the contract's total, else a per-share price (the rule of the dashboard's
  history). A sell date written as text is read month/day/year and listed.
- **Above the stock table**: the totals, the sub-type block and the pension / savings / property block are found by
  their words, not their addresses. The words are the sheet's own language: the core carries an English default
  (backend/src/ledger/layout.ts); a user keeps his own in a private overlay (`src/owner/ledgerLayout.ts`) or a JSON file
  named by `LEDGER_LAYOUT_FILE`. Names are kept exactly as written. A property's note "value X million but Y mortgage"
  becomes `value` and `debt` only when X - Y equals the amount in the sheet; a range or any other note keeps the amount,
  keeps the note in `note`, and is listed. The sheet's separate debt line becomes the mortgage of the one property that
  has none (layout `debtTo: 'realEstate'`), or a negative cash item (`debtTo: 'cash'`); either way it is listed. ILS.
- **Ids** are stable across runs: kind + ticker (+ strike + expiry), or group + a slug of the name as written; repeats
  get `-2`, `-3` in sheet order.

`--check` reconciles only (nothing is written; exit 1 when a line is flagged).

Snapshots start fresh: the migration writes none. The sheet's own daily total sampler is replaced by the Nightly's
snapshot (phase 3); its old tab is not imported (owner 2026-11-06).

### Phase 3: shadow, then on

Profile key `storage.ledger` (backend/src/profile/schema.ts), default `'off'`:

- `'off'`: today. The runs read the Portfolio sheet; nothing reads or writes the ledger; the Nightly's ledger job is
  skipped (the run never touches `data-branch/`, so there is nothing to commit).
- `'shadow'`: the runs still read the sheet. After the run the Nightly also reads `ledger/holdings.json`, compares it
  with the sheet's holdings (same stocks, quantities, costs, purchase dates; same options; same crypto list) and logs
  ONE line: `ledger shadow: the ledger holds the same holdings as the sheet (...)` (INFO) or
  `ledger shadow: N difference(s) between the sheet and the ledger: ...` (WARNING, each difference named). Then it
  appends today's snapshot: stocks / bitcoin funds at tonight's close, crypto at `manualPrice` (else `<TICKER>-USD`),
  calls at their `currentValue`, pension / funds / real estate (net of debt) / cash from `assets.json` at tonight's
  USD/ILS (Yahoo `ILS=X`). A value with no price is left out and named, never counted as 0.
- `'on'`: the runs (Nightly, Exit, Buy, paper, AI) read the holdings from `ledger/holdings.json` (ledger/toPortfolio.ts:
  the same shape the sheet reader gives, so no pipeline changes). The Portfolio sheet is not read for holdings. A
  missing file stops the run with one plain line. The snapshot is still appended.

The Nightly workflow checks the `data` branch out read-only into `data-branch/` (a missing branch is skipped). When
the run changed `ledger/snapshots.jsonl`, a second job, the only one with write access, commits that one file to the
`data` branch (never main). No new trigger.

### Crypto prices (replaces the sheet's crypto price scripts)

Profile key `ledger.cryptoPrices` (backend/src/profile/schema.ts), default `'off'`: no fetch at all, the snapshot
prices crypto as above. `'on'` (only acts while `storage.ledger` is `'shadow'` or `'on'`): before the snapshot the
Nightly asks `https://cryptoprices.cc/<SYMBOL>/` (plain-text USD price) for every crypto holding
(backend/src/ledger/cryptoPrices.ts: 10 s timeout, one retry, the body must be a plain positive number). A fetched
price wins over `manualPrice`; a coin with no answer keeps `manualPrice` (else `<TICKER>-USD`), and ONE warning names
the coins not fetched. Bitcoin is not asked there: it takes Yahoo `BTC-USD` (night.ts `MARKET_COINS`). The symbol is
the holding's optional `priceSymbol` (the migration fills it from the sheet's script cells when it differs from the
ticker), else the ticker without trailing dots. `holdings.json` is not rewritten: the prices used are written to
`ledger/prices.json` (`{schema, date, prices: {holdingId: usd}}`), committed by the Nightly's ledger job with the
snapshot, and the net worth screen prefers them over `manualPrice` while that file's `date` is not older than
`holdings.json`'s `updated` (a price typed since wins). No key, no new trigger. The owner profile has it `'on'`
(owner 2026-11-06); it acts once `storage.ledger` is shadow or on. Revert = set it back to `'off'`.

### Corrections (the owner's answers, applied by every migration)

`backend/src/ledger/corrections.ts` is a generic hook: the answers to the "needs owner check" list, by the migration's
stable ids (or a cell of the tab), so a fresh migration gives the corrected files every time. The core carries none; a
user keeps them in the private overlay `src/owner/ledgerAnswers.ts` (read only with the overlay layout) or a JSON file
named by `LEDGER_CORRECTIONS_FILE`.

- Fixes, applied BEFORE the reconciliation (which then checks them against the sheet's totals): `stocks` (set fields;
  `totalCost` = avgCost x qty), `assets` (set / unset fields), `typedTotals` (a total typed in a cell for a group and a
  person that is more than its rows: one "Not itemized (sheet total)" item for the difference, the block's date),
  `separateDebt` (the sheet's debt line as an item of its own: value 0, debt = the amount, not a property's mortgage).
- Updates, applied AFTER the reconciliation and listed under it: new values given after the sheet (a property's value
  today), with their `asOf`.
- `answered`: checks removed from the list (by `where`, `item` or `itemPattern`). A correction naming an id the
  migration does not have becomes a check of its own.

### Phase 4: the system's own history

`npm run ledger-history -- --out <dir>` copies, read-only, each tab of the manifest (backend/src/ledger/history.ts) to
`<dir>/history/`: 📝 Paper State, 📒 Paper Log, 📈 Paper Values, 🔎 Paper Reads, 🤖 Claude Picks, 🤖 Claude Ideas,
📈 Decision History, Exit Target History, 🩺 Run Health, the options reads and snapshots, 📉 IV History as JSONL (one
JSON array per row, values exactly as Sheets returns them: lossless), and 💾 Script Properties as
`script-properties.json`. Script Properties values are copied but never printed; a value shaped like a secret is
left out and only its key is reported. `history/manifest.json` lists rows, bytes and a checksum per tab (no values).
`FileTabStore` / `FilePropertyStore` read and write these files with the same interfaces as the Sheet stores, so a
later step can switch a store to files. Today no run reads them.

## How to approve each switch

1. **Migration**: run `npm run ledger-migrate -- --out <dir>`; read the reconciliation and the needs-owner-check list;
   fix the files; commit `ledger/*.json` to the `data` branch (create it as an orphan branch the first time, as the
   `prices` branch was).
2. **Shadow**: set `storage: { ledger: 'shadow' }` in the profile. Watch the Nightly's `ledger shadow:` line for a few
   nights; it must say "the same holdings". While in shadow the owner keeps both the sheet and the ledger up to date.
3. **On**: set `storage: { ledger: 'on' }`. From then on the holdings are edited in the ledger (the dashboard), not
   in the sheet.

## How to revert

Set `storage.ledger` back (`'on'` -> `'shadow'` -> `'off'`). The sheet was never written, so `'off'` is exactly
today's behaviour. The `data` branch keeps its files; nothing else changes.

## The reconciliation result (template)

Filled by the migration (`migration/reconciliation.md`); each line is ledger vs the sheet's own cell, flagged when the
difference is over 0.5% or a side is missing. The ledger side is valued at the sheet's own prices, so a flag means a
row was left out, read twice or read wrong -- not a price move.

| group | items | total |
|---|---:|---:|
| stocks | | USD |
| btcFunds | | USD |
| crypto | | USD |
| calls | | USD |
| pension | | ILS |
| funds | | ILS |
| realEstate (net) | | ILS |
| cash | | ILS |

| check | ledger | sheet | diff | |
|---|---:|---:|---:|---|
| Stock table (stocks + bitcoin funds + crypto) vs the sub-type rows | | | | ok / FLAG |
| Open calls vs the sub-type "options" row | | | | |
| Total Portfolio Sum $ | | | | |
| Total Portfolio Sum NIS (at the sheet's USD/ILS) | | | | |
| Pension + savings funds vs Total pension NIS | | | | |
| Real estate, net of mortgage | | | | |
| Debt | | | | |
| Total Savings NIS (portfolio + pension - debt) | | | | |
| Total savings with assets (+ real estate) | | | | |

Then: the needs-owner-check list (cell, item, why), and the crypto price cells (cell <- source [symbol]).
