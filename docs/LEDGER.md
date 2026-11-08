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
| `ledger/journal.jsonl` | LedgerJournalEntry | optional: the advice journal, every advice given, append-only (below) |

Rules (backend/src/ledger/store.ts): JSON files are pretty-printed and written whole; JSONL files are append-only
(a line is never rewritten; a snapshot day already saved is kept). Every file and every line carries `schema`; a reader
refuses a newer schema and a broken file with one plain line naming the file. Money has a `currency` per item;
dates are `YYYY-MM-DD`. Additive fields (2026-11-06): `LedgerAsset.person` (whose item), `LedgerAsset.savingsType`
(the sheet's own word for it).

### The estimated past (dashboard only, additive 2026-11-07)

The growth graph's history before the first snapshot is not stored: each dashboard build estimates it from
`holdings.json` and the long price history (`backend/src/ledger/estimate.ts`, docs/DASHBOARD.md "Estimated history").
So the dates you keep in the ledger matter: a lot's `date`, a holding's `bought`, an option's `bought`, a closed
position's `bought` and `sold` place them in time; with no date a holding counts as held since 2020. Nothing here is
written to the ledger, and nothing a run decides reads it.

### Dated purchase lots (additive 2026-11-07)

`LedgerStock.lots?: {date: string | null; qty; price; note?}[]` (backend/src/ledger/lots.ts): the buys that make up a
holding, as the broker shows them. After a split, the post-split numbers, the old ones in `note` ("pre-split 3 @ 1423").

| Rule | |
|---|---|
| Quantity | the lots hold at most `qty` (the dashboard refuses more) |
| The rest | `qty` minus the lots is ONE implicit undated lot, priced so the total cost stays `qty` x `avgCost`; computed, never stored |
| A check | a negative implied price, one above 10x `avgCost`, lots over `qty`, or lots that hold all of `qty` but cost more than 0.5% off `qty` x `avgCost`: the rest shows no price and the net worth screen lists a "To check" line (`NetWorth.checks`) |
| `bought` | absent / null = the earliest dated lot (`boughtOf`; the dashboard's "Bought") |
| The runs | unchanged: toPortfolio.ts reads `qty`, `avgCost` and `bought` only, so lots never move a verdict, a score or the shadow comparison |
| Edits | dashboard `kind: 'lot'` (add / remove), one commit + a LedgerEdit line (docs/DASHBOARD.md); a change keeps the lots; a sale shrinks the lots that no longer fit, earliest first |

### The advice journal (additive 2026-11-08)

`ledger/journal.jsonl` (LedgerJournalEntry, backend/src/ledger/journal.ts): every piece of advice the system and Claude
give, one line each, append-only, so that a year later we can learn whether it was followed and whether it was right.
Display and record only: no buy / sell rule, score or verdict reads it.

| Field | |
|---|---|
| `id` | `date:source:subject:advice` (subject = an option's holding label, else the ticker, else `MARKET`); a second line with the same id is never written |
| `date` | the New York day of the advice |
| `source` | `exit` · `buy` · `washout` · `marketShock` · `business` · `eventCheck` · `claudeIdea` · `claudeChat` · `top5` |
| `ticker` | null = the whole market |
| `advice` | `BUY` · `ADD` · `HOLD` · `REVIEW` · `EXIT` · `WAIT` · `AVOID` · `BUY_POINT` · `ALERT` |
| `detail`, `horizon` | the short reason and the horizon named, as given |
| `priceAtAdvice`, `qqqAtAdvice` | the prices then (an option: its stock); null = the history's close that day |
| `refs` | where it came from (holding label, entry zone, an alert's signature `sig`, a note) |

Who writes it:

| Writer | When | What |
|---|---|---|
| The Nightly (`ledger/journalNight.ts`) | after the snapshot, only while `storage.ledger` is `shadow` or `on`; never fails the night | Exit report EXIT / REVIEW (TRIM = EXIT, TARGET HIT = REVIEW; HOLD only right after an EXIT / REVIEW), Buy report verdicts (BUY NOW = BUY, or ADD when held; SET A BUY LIMIT = BUY_POINT; WAIT; AVOID), each washout hit (ADD when held, else BUY_POINT), the market shock (BUY_POINT for the market), each business alert with a trigger (ALERT), the event check (ALERT), the 🤖 Claude Ideas rows (SELL = EXIT) |
| Claude | after a chat | `npm run journal-add -- <source> <TICKER or -> <ADVICE> "<detail>" [--date YYYY-MM-DD] [--price N] [--qqq N] [--horizon "<text>"] [--note "<text>"]`, into a checked-out data branch folder (`DATA_BRANCH_DIR`); then commit and push to `data` |

Dedupe: a report row (exit, buy) is written when its advice first appears or changes; an alert when the same subject has
no line with the same signature within 14 days. The Nightly's ledger job commits the file with the snapshot and merges
it line by line (lines already on the branch are kept, tonight's new ones are added), so a chat line pushed during the
night is never lost.

Computed by the dashboard at each build, never stored (docs/DASHBOARD.md "Advice journal"):

| | Rule |
|---|---|
| Acted? | the owner's trades of that ticker in the ledger (dated lots, buy days, closed positions, `edits.jsonl`: a new holding or a quantity up = a buy, a quantity down / a removed holding = a sale) within 5 trading days (weekdays) after the advice; a chat or idea counts its own day. BUY / ADD / BUY_POINT: bought = followed, sold = opposite; EXIT: sold = followed; HOLD / WAIT / AVOID: no trade = followed; REVIEW / ALERT: traded or not |
| Right? | the stock's return vs QQQ's over the same window at +1 week, +1 month, +3 months, +1 year (the long price history plus tonight's closes). BUY / ADD / BUY_POINT right if the stock beat QQQ (the market's BUY_POINT: if QQQ rose); EXIT / AVOID right if it trailed QQQ; HOLD right if it did not trail QQQ by more than 5 points; REVIEW / ALERT / WAIT information only; pending until the horizon has passed |
| $ value | $5,000 per advice (the owner's rule of thumb per buy): following a BUY = $5k in the stock instead of QQQ, following an EXIT = $5k moved from the stock into QQQ; "what you did" counts it when followed, minus it when the opposite was done. Before tax and fees |

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
