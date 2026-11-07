# User manual: daily use after setup

Tables, short lines. Checked against the code on 6 Nov 2026 (relay `2026-11-05.2`).
For: a person who does not program, OR a fresh AI session with no context.
First do [SETUP_GUIDE.md](SETUP_GUIDE.md) (and [PREREQUISITES.md](PREREQUISITES.md) before it).
Examples use made-up holdings (AAPL, MSFT, KO, JNJ). A report is information, not advice.

Procedures use the same 4 columns as the setup guide: **Do** → **You should see** → **✅ Check** → **If it fails**.

| § | Topic |
|---|---|
| 1 | What runs when |
| 2 | What arrives in Telegram |
| 3 | Telegram commands |
| 4 | The Buy report, section by section |
| 5 | The Exit report, section by section |
| 6 | Your stocks; the Portfolio and Watchlist tabs |
| 7 | The Profile tab: every key |
| 8 | The paper test |
| 9 | Running things by hand from GitHub (phone and desktop) |
| 10 | Costs |
| 11 | When something fails |
| 12 | Updating to a new core version |
| 13 | Optional: the data move to 3 sheets |

---

## 1. What runs when

All times are UTC first, then New York (NY). NY summer time (EDT) runs from March to early November; winter time (EST) the rest.

| Job | Started by | UTC | NY summer / winter | What it does | Telegram |
|---|---|---|---|---|---|
| **Nightly** | the Cloudflare relay timer `23 3 * * *` | 03:23 | 23:23 / 22:23 (the evening before, after the US close) | fresh data for every stock on your Portfolio and Watchlist, every model, the Buy report, the Exit report, the paper test | 2 PDFs: Buy (caption = bottom line) and Exit |
| **Nightly Backup** | GitHub's own timer | 03:23 and 05:23 (GitHub often fires hours late) | — | a 10-20 second check: did a Nightly start since 03:00 UTC today? If not, and it is before 13:00 UTC, it starts the Nightly | "⏰ The Nightly was started by the GitHub backup timer ..." only when it had to start it; "⚠️ The Nightly did not run tonight and the GitHub backup came too late (market hours) ..." when it was too late |
| **My Options** | the relay timers `5 21 * * *` and `5 22 * * *` (+ GitHub's timer as a backup) | 21:05 or 22:05 | 17:05 / 17:05 | the current market value of each option row, written into `current market value` on the Portfolio tab | nothing |
| **Watchdog** | GitHub's own timer `7 6 * * *` (may be late) | about 06:07 | about 02:07 / 01:07 | checks every run of the last 24 hours, the expected Nightly and My Options, the minutes; adds rows to `🩺 Run Health` (Reports sheet) | nothing when all is ✅; else ONE line (§11) |
| Everything else | you (Telegram or GitHub) | — | — | §3, §9 | §3 |

Runs that write the sheets (Nightly, Analyze, Exit Report, Send Exit Report, AI Dispatch, My Options) wait for each other: one at a time. GitHub keeps only the NEWEST waiting run: if you send `/analyze AAPL` and then `/analyze KO` while the Nightly is running, the AAPL request is dropped. Wait for one PDF before asking for the next.

## 2. What arrives in Telegram (the clean policy)

| Rule | Detail |
|---|---|
| A report run sends only its PDF(s) | the first PDF has a short caption: the bottom line, at most 2 lines (about 200 characters). Example: `Nightly 5 Nov: 2 BUY · 1 EXIT, 13 HOLD · paper +1.2% (QQQ +0.8%)` |
| No separate text messages | tables, summaries, the minutes line and AI notes are inside the PDF or stay in the Sheet |
| A run without a PDF is silent when fine | it sends ONE line only when you are needed: a failure, a run that did not happen, a watchdog ⚠️ or ❌ |
| You asked, so it answers | the relay confirms each command at once (⏳ ...); /verify always answers |
| Failure notices | one line each: a crash, the maintenance pause, a refused Profile, the backup timer |

| Job | What you get |
|---|---|
| Nightly | Buy PDF (caption = bottom line; tonight's table and the minutes line on its cover) + Exit PDF. Paper test on: a paper PDF too (caption = standings). No PDF possible: 1 line |
| /analyze | 1 PDF, caption like `AAPL — ✅ BUY NOW · 72/100 · Buy now · $250.00 · held: HOLD` (the `held:` part only when you own it), second line = the headline |
| /exit | 1 PDF, caption = the run time of the saved report and the first line of the Opus portfolio view (when there is one) |
| Exit Report (GitHub) | 1 PDF, caption = the action counts |
| /verify | 1 PDF with a caption; without a browser on the runner: 1 message |
| My Options, Watchdog all ✅, AI Dispatch | nothing (AI Dispatch: 1 line only if off or failed) |

## 3. Telegram commands

Tap the **Menu** button for /exit, /analyze, /help. /verify and /check work when typed (they are not in the menu). Anything else gets the help text.

| Command | Example | Reply at once | Then | How long | Cost |
|---|---|---|---|---|---|
| `/analyze` | `/analyze` | "📊 Which stock?" + your `TICKERS` buttons (4 a row) + "✏️ Other ticker" | tap a stock → "📊 AAPL: free, or with Claude Opus (paid)?" → **🆓 Free (Gemini)** or **💎 + Opus (~$0.15)** → "⏳ Analysing AAPL… about 3 min." → PDF | about 3 min (+ queue) | Free: $0. + Opus: about $0.15 |
| Other ticker | tap **✏️ Other ticker** | "✏️ Type the ticker to analyse ..." | reply `KO` (free) or `KO opus` (with Opus) | same | same |
| `/analyze TICKER` | `/analyze KO` | "⏳ Analysing KO… about 3 min." | PDF, Gemini AI on, Sheet updated | about 3 min | $0 |
| `/analyze TICKER opus` | `/analyze KO opus` | "⏳ Analysing KO with Opus… about 3 min." | PDF with the Opus second opinion on the cover and the Analysis page | about 3-4 min | about $0.15 |
| `/exit` | `/exit` | "⏳ Getting the Exit Report…" | the SAVED Exit report (as last night left it) as a PDF. If its AI part is empty, Gemini fills it first | about 1 min; about 4 with the AI part | $0 |
| `/exit opus` | `/exit opus` | "⏳ Exit Report with Opus… about 4 min." | Claude Opus reads every holding + one portfolio-wide view first, then the PDF | about 4 min | about $0.25 |
| `/verify` (or `/check`) | `/verify` | "🩺 Verifying the last 3 days… about 2 min." | every run of the last 3 days: what failed, what was slow, the Run Health rows; Claude Opus says what went wrong and how to fix it. No Anthropic key: the table only, "Opus diagnosis off (no Anthropic key saved)" | about 2 min | one Opus call (cents); $0 without a key |
| `/help` | `/help` | the command list | — | seconds | $0 |

| Bad input | Reply |
|---|---|
| `/analyze !!` | "That does not look like a ticker. Tap /analyze to pick one, or type for example: /analyze AAPL" |
| A refused start | "⚠️ Could not start it. GitHub said 401 ..." (meaning in §11) |
| A chat the relay does not know | nothing (it ignores strangers) |

## 4. The Buy report, section by section

Tab `🛒 Buy Report` in My Portfolio, and the Buy PDF. It covers every ticker on your `🎯 Watchlist` tab.

| Section | What it tells you |
|---|---|
| Title, run time, how to read | when the numbers were made; the AI section's row |
| Banner | how many candidates were analysed, partial, failed tonight; run-level data issues |
| ⭐ THE SHORTLIST | the names you could act on: can be bought now, or the highest conviction |
| FULL RANKING | every candidate, nothing left out. Columns: Rank and ticker · Conviction · Fundamentals · Timing · Entry zone · Verdict · Updated · Jump. Order: "can be bought now" first, then higher conviction, then higher entry confidence. Bitcoin-tracking funds share one rank (one idea) |
| ⚠ CHANGED SINCE LAST RUN | verdict changes vs the last run from an earlier day: `from → to (conviction a → b)` |
| 📈 OPTIONS READS | each stock's options read and what it would change; shown, not yet applied to the scores |
| ₿ BITCOIN COMPLEX | only when the Watchlist holds Bitcoin-tracking funds: one shared chart read, the per-fund entry, stop and costs |
| TIER 1 — FULL DEPTH | can be bought now, or conviction 70 or higher: the full write-up |
| TIER 2 — CONDENSED | near misses: conviction 45 to 69, and "To become actionable" |
| TIER 3 — ONE LINE EACH | conviction below 45, blocked, or no verdict |
| AI SUMMARIES | empty after each Nightly; filled by /analyze, AI Dispatch. States when it was written and which names it covered |
| HOW THIS REPORT WAS BUILT | the ranking key, tier rules, the fundamentals floor, sizing, long-only |

### The words in a Tier 1 write-up

| Item | Meaning |
|---|---|
| Verdict | the engine's answer, from fundamentals × timing (table below). `⚠ PARTIAL DATA` = some data was missing tonight |
| Conviction | 0-100. The chart score, cut on a curve when fundamentals are below 43, +8 when options confirm, -10 when they conflict, ±5 for LEAPS buying or hedging, cut again when the reward-to-risk is below 1 |
| Fundamentals | the own score 0-100: **Strong** 57+, **Mixed** 43-56, **Weak** below 43, **Not rated** (no data). 20 or below = **🚫 BLOCKED** whatever the chart |
| Timing | **Buy now** (trend up, price near the entry zone) · **Wait for a pullback** (good idea, price too high) · **Avoid for now** (no good entry) |
| Regime | Uptrend · Downtrend · Sideways · Volatile |
| Entry zone | the price range to buy in. "Entry confidence" = how many independent entry methods agree |
| Buy-limit ladder | rungs: a price and a share of the position for each limit order |
| Initial stop | the price at which the idea is wrong, measured from the planned entry (Turtle: 2 × N below the entry; N = the typical daily move) |
| Sizing | relative to your account: a first unit risks a stated % of the account if the stop is hit. No dollar amounts |
| R:R | reward-to-risk to target 1 (and at today's price). Below 1.0 = "marginal structure"; 1.0-1.5 = "thin, size accordingly" |
| Option picks | a long call to consider (strike, expiry, IV), or why none was found. "The chart says to wait" warns when buying the call now would run ahead of the plan |
| Models table | Engine, Schabacker, Edwards & Magee, Broker Course, Turtle, Combo 2-of-3, Wyckoff, Trend 150, Trend 200, LILO, ... each Bullish / Neutral / Bearish, and "N of M models agree" |
| "YOU ALREADY HOLD THIS" | the question is adding to a position, not opening one |

| Fundamentals ↓ / Timing → | Buy now | Wait for a pullback | Avoid for now |
|---|---|---|---|
| Strong | ✅ BUY NOW | ⏳ GREAT COMPANY — SET A BUY LIMIT | ⚠️ GOOD COMPANY, BAD TAPE |
| Mixed | ➖ Tradeable, not a conviction owner | ➖ Only-if-it-dips trade | 🚫 Stand aside |
| Weak | 🩳 Technical bounce only (not own-worthy) | 🚫 Skip — weak fundamentals, no entry edge | 🔴 Avoid entirely |
| Not rated | ❔ No fundamentals — technical-only bounce | ❔ No fundamentals — technical-only, wait for entry | ❔ No fundamentals — avoid, weak tape |

## 5. The Exit report, section by section

The Exit report tab in My Portfolio, and the Exit PDF. It covers every open row of your `Portfolio` tab (stocks and calls).

| Section | What it tells you |
|---|---|
| Title, run time, AI status line | "AI review: not run yet" after the Nightly; written by /exit (Gemini) or `/exit opus` |
| DATA HEALTH AND ROWS READ | rows read, rows skipped and why (crypto rows, blank rows, a ticker with a space), holdings with no purchase date |
| PORTFOLIO SUMMARY | how many holdings get each action, and the totals |
| TABLE OF CONTENTS | one line per holding, most urgent first: Holding · Action · Gain/loss · Stop and targets · Flags · Jump |
| ⚠ NEEDS ATTENTION | every EXIT, REVIEW and TRIM, or "Nothing needs attention right now" |
| ₿ BITCOIN COMPLEX — SHARED THESIS | one chart read for Bitcoin-tracking funds |
| One section per holding | the verdict, the reason, the stop and how it was measured, targets T1 and T2, the after-tax gain, "How many to sell", the models table, data quality |
| PORTFOLIO-WIDE CHECKS | information only: the number of distinct stocks, the market phase, exposure caps |
| AI SUMMARIES | the Gemini and Opus text; the Opus portfolio view first (after `/exit opus`) |
| HOW THIS REPORT WAS BUILT | "What triggers what", the tax assumption, long-only |

| Action | Meaning |
|---|---|
| **EXIT** | sell: the thesis is broken, or the price closed below the stop (the stop measured from your real purchase date, or the assumed one). Options also: near expiry (30 days; 60 for a LEAPS bought with 365+ days) |
| **EXPIRED** | the option is past its expiry date: update the Portfolio tab |
| **REVIEW** | a warning, low confidence: look at the reason, then decide yourself. "No sale planned until you review the reason above" |
| **TRIM** | a target was reached: consider selling part (T1 = partial profits; T2 = trim the rest, trail the remainder) |
| **TARGET HIT** | a target was reached without a trim advice |
| **HOLD** | nothing to do |
| **NO VERDICT** | no data for this holding tonight |

### Weekly stops (Profile `exit.weeklyStops` = `TRUE`; default `FALSE`)

For swing trades held weeks to years. The Exit report then reads the WEEKLY chart and your tax:

| Rule | Detail |
|---|---|
| Old signal | a daily-stop break more than 10 trading days ago (price never back above) is shown as "old stop $X broken on <date>, −Y% since (old signal)", not as a fresh EXIT |
| Weekly stop | highest weekly CLOSE of the last 26 complete weeks (or since your entry week) − 3 × weekly ATR(14). Broken only by a complete weekly close below it |
| EXIT needs ALL of | (1) weekly close below the weekly stop AND below the 40-week average; (2) the next major weekly support is 30%+ below the price; (3) fundamentals not strong (own score below 70; unknown = not confirmed); (4) tax: for a position in profit the expected fall must beat the tax cost (as % of the position, at your `tax.rate`) + 10 points; (5) the model vote: at least 2/3 of the models with a read (5+ reads) say sell, including the engine and a trend model (Trend 150, Trend 200 or Weekly chart) |
| Otherwise | REVIEW (trend broken but not an exit, with the missing condition named) or HOLD |
| Targets | T1 above the price (+2%), T2 above T1 (+5%), both above the weekly stop, never above 3 × the price; else the next resistance; else "no valid target" |
| TRIM | only at a reached target worth +25% or more over your cost AFTER tax |
| Calls | a call with more than 180 days left follows its underlying's weekly stop; a shorter call keeps the daily rules and needs the model vote to sell |
| Every holding shows | "Model vote: N of M models say sell (b buy, h hold; k with no read)" and a rule-check table |

Tax figures use your `tax.rate` as a working assumption, not your real tax and not tax advice.

## 6. Your stocks; the Portfolio and Watchlist tabs

### Your stocks: which list drives what (first time: SETUP_GUIDE P-4S "Choose your stocks")

| Where you type it | Paper accounts | Buy report | Exit report | Analyze buttons |
|---|---|---|---|---|
| Profile `lists.core` | **B your list** accounts (+ the "hold your list" yardstick): only these | — | — | — |
| Profile `paper.fixedUniverse` (no row = `lists.core`) | **A original** accounts: these + the Watchlist; the "Hold N + watchlist" yardstick: these + the Watchlist on the start day | — | — | — |
| `🎯 Watchlist` tab | added to the A original accounts each night | the candidates (only these) | — | — |
| `Portfolio` tab | — | — | = your Portfolio tab | — |
| Cloudflare relay `TICKERS` | — | — | — | the `/analyze` buttons |

| Do | You should see | ✅ Check | If it fails |
|---|---|---|---|
| change a list (at least 3 in `lists.core`, typically 10-20 in each) | the next run uses it. A changed `paper.fixedUniverse` or `lists.core` changes the paper accounts' stocks from the next night; the yardstick bought on the start day keeps its stocks until a restart (§8) | GitHub → Actions → **Setup Check**: rows `Profile lists.core`, `Profile paper.fixedUniverse`, `🎯 Watchlist tab` ✅ with a count | ❌ "Empty." / "Only N ticker(s)." / "No tickers." → the row's fix |

The program finds each table by its header row (exact words), so you may add rows above or notes to the right. All tabs turn red after each run: that is the lock colour, normal, and you can still edit (unless you installed the optional Apps Script lock in `backend/apps-script-shim/`). Edit when no run is going (not around 03:23 or 21:05-22:05 UTC).

### Stock table (header row: `Ticker` · `type` · `sub-type` · `amount` · `price per item` · `value of inverstment` · `cost avg per stock` · `Purchase Date` · `URLS / comments`)

| Column | Fill in | Example |
|---|---|---|
| `Ticker` | the market symbol, no spaces | `AAPL` |
| `type` | `stock` (stocks and ETFs) or `crypto` (skipped by design). Anything else = not a position | `stock` |
| `sub-type` | free text | `tech` |
| `amount` | number of shares | `30` |
| `price per item` | optional, your note | `250` |
| `value of inverstment` | optional, your note | `7500` |
| `cost avg per stock` | your average cost per share (REQUIRED header) | `180.50` |
| `Purchase Date` | the day you bought, as a date the sheet recognises (it aligns right), e.g. `2024-03-15`. Empty = the assumed date (Profile `sheets.portfolio.assumedPurchaseDate`, default 1 Jan 2020); the report then says the stop is measured from an assumed date | `2024-03-15` |
| `URLS / comments` | free text | — |

A row with `*` in the ticker or a ticker starting `TOTAL` is ignored. A spot-Bitcoin ETF must be typed `stock`, not `crypto`.

### Options table (a row `OPEN positions`, then the header: `Ticker` · `type` · `positions` · `last trade Date` · `strike` · `PUT/CALL` · `avg price - Premium paid` · `cost basis` · `current market value` · `URLS / comments` · `Purchase Date`)

| Column | Fill in | Example |
|---|---|---|
| `Ticker` | the UNDERLYING stock | `KO` |
| `type` | free text | `option` |
| `positions` | number of contracts | `2` |
| `last trade Date` | the expiry date | `2027-06-17` |
| `strike` | the strike price | `65` |
| `PUT/CALL` | `CALL` (long calls only) | `CALL` |
| `avg price - Premium paid` | the premium per share you paid, as the broker shows it | `5.20` |
| `cost basis` | what you paid in total | `1040` |
| `current market value` | leave it: My Options writes it (mid × 100 × contracts) | — |
| `Purchase Date` | the day you bought the contract | `2026-01-10` |

| Rule | Why |
|---|---|
| No empty row between two option rows | My Options stops at the first blank ticker |
| End the open options with a row `CLOSED positions` in column A | everything below it is history (sold), never read as held |
| Closed section header (your history): `Ticker` · `type` · `positions` · `last trade Date` · `strike` · `PUT/CALL` · `avg price - Premium paid` · `cost basis` · `Sell Price` · `Sell Date` | for you; the reports do not read it |
| Sold a stock | delete its row (or move it under your own notes) |
| Sold a call | move the row below `CLOSED positions`, add Sell Price and Sell Date |

### Watchlist (`🎯 Watchlist`)

| Do | You should see | ✅ Check | If it fails |
|---|---|---|---|
| A1 = `Ticker`; one ticker per row from A2; duplicates are ignored | next Buy report covers them | the Buy report banner counts them | "The watchlist has no tickers" → you deleted A2 onwards. "The Watchlist tab was empty, so a starter list was written" → it was empty; Profile `lists.watchlistSeed` was used |

Keep the Watchlist short on the free plans (about 10-25 names): each name costs FMP calls (250 a day free) and run minutes.

## 7. The Profile tab: every key

Tab `⚙️ Profile`, column A = Key, column B = Value. Format column B as **Format → Number → Plain text** so dates are not changed. Lists: comma-separated (`AAPL, MSFT, KO`). True/false: `TRUE` / `FALSE` (or a checkbox). A percent like `25%` is read as 0.25. An unknown key refuses the run (so a typo never passes silently). Every run reads the tab first: a change counts from the next run.

| Key | Default | Meaning |
|---|---|---|
| `version` | `1` | the format version; leave it out |
| `user.id` | REQUIRED | a short id for you: a-z first, then a-z, 0-9 or `_`, at most 20 (e.g. `jane`). In your own copy any valid id works. Only an extra user on a shared repo (SETUP_GUIDE G) must use the id the runs are started with |
| `user.timeZone` | REQUIRED | your zone, e.g. `Europe/London`, `America/New_York` (display only; the engine runs on New York time) |
| `lists.core` | REQUIRED | your list, 1-30 tickers (3+ advised; the Setup Check shows ❌ below 3); the first one is the default ticker. The paper **B your list** accounts trade only these; also the research tools and the defaults below (§6) |
| `lists.researchCore` | = `lists.core` | the list the research tools test |
| `lists.pickers.stockMenu`, `lists.pickers.runDialog`, `lists.pickers.callDialog` | = `lists.core` | lists of the old sheet dialogs; leave them out |
| `lists.watchlistSeed` | empty | written into a brand-new or empty `🎯 Watchlist` tab once |
| `tax.rate` | REQUIRED, no default | capital-gains tax as a fraction, 0 to 0.6, e.g. `0.25`. Used for after-tax figures and the weekly-stop tax rule |
| `benchmarks.index` | `QQQ` | the index the reports and the paper test compare with |
| `features.paper` | `TRUE` | the 1-year paper test (§8). TRUE needs `paper.start` |
| `features.myOptions` | `TRUE` | My Options (option values at 17:05 NY). FALSE = it does nothing |
| `features.ai` | `FALSE` | TRUE = you use the Gemini AI parts; the Setup Check then requires `GEMINI_API_KEY`. The AI parts run only when asked either way |
| `features.liveBot` | `FALSE` | the live broker bot; not for new users. Leave FALSE |
| `exit.weeklyStops` | `FALSE` | TRUE = the weekly-stop exit rules (§5) |
| `exit.businessAlerts` | `off` | `shadow` = a "Business alerts (shadow)" section in the Exit report and lines in the run log (revenue growth turning negative, net margin, analyst rating / target, new SEC dilution filings, market shock); `on` = also ONE Telegram line per new alert (once per 30 days per stock and alert). Information only: never changes a verdict |
| `alerts.eventCheck` | `off` | `on` = the event check: on a sharp fall (QQQ −5% in 5 days or −3% in a day; a held / watchlist stock −8% in a day or a washout) the fall's type (market-wide / sector / company-specific), the long-fall signs (cut forecasts, credit stress HYG vs IEF, rates TLT / 10-year, 5+ lower weeks) as yes / no / not known, a one-line verdict and the sizing hint, next to each washout line and in an "Event check" block of the Buy report; nothing on quiet nights. With `features.ai` and a Gemini key in the run, one "AI, unverified" sentence on the news cause. Display only: never changes a verdict |
| `paper.start` | none | first day of the paper test, `YYYY-MM-DD`, a trading day (the next one is a good choice) |
| `paper.end` | start + 1 year | last day of the paper test |
| `paper.fixedUniverse` | = `lists.core` | stocks the paper **A original** accounts may buy (the Watchlist is added each night; §6) |
| `research.testAUniverse`, `research.universe`, `research.extraTickers` | your list (+ index, SPY, ^VIX); crypto for `extraTickers` | research tools only; leave them out |
| `models.pairs` | none | pairs for the pair models, as `[["KO","PEP"]]`; leave it out |
| `labels.listName` | `your list` | how the reports name your list |
| `labels.holdCore`, `labels.holdResearchCore`, `labels.researchName` | from `listName` | names of the "hold the list equally" rows; leave them out |
| `sheets.protectedTabs` | none | tab names the robot never writes or deletes, e.g. `My notes, Taxes 2026` |
| `sheets.portfolio.headerAliases` | none | other spellings of a header, as `{"Purchase Date": ["Bought on"]}` |
| `sheets.portfolio.endMarkers.exact` / `.contains` | none / `CLOSED` | the ticker cell text that ends the open options table |
| `sheets.portfolio.assumedPurchaseDate` | `2020-01-01` | the purchase date used for a stock row with no date |
| `live.*` (`follow`, `startValue`, `fractional`, `minTrade`, `maxOrders`, `capSlack`, `targetMode`, `alertFalls`, `allowList`) | none | live bot settings; leave them out |
| `results` | none | the name of a research results pack; leave it out |

| Do | You should see | ✅ Check | If it fails |
|---|---|---|---|
| change a value in column B | — | send `/analyze KO`: a PDF arrives | "⚠️ Run refused for user owner: the ⚙️ Profile tab is not valid: <key> ..." → fix that key; nothing was changed in your sheets |

## 8. The paper test

A practice run with play money, decided from the real nightly analysis. Nothing is bought for real.

| Item | Detail |
|---|---|
| Turn on | Profile `features.paper` = `TRUE` and `paper.start` = the next trading day (`YYYY-MM-DD`) |
| Accounts | $100,000 each: the Buy report's tier 1 ("current"), the engine alone, each book model (Schabacker, Edwards & Magee, Broker Course, Turtle) and research accounts; at most 6 stocks, each buy 1/6 of the account |
| Benchmarks | all-in `benchmarks.index` (QQQ) and your list held equally, bought at the first open and held |
| Rules | decided at each close, filled at the next day's open, your `tax.rate` on each sale's gain; values shown after the tax on what is still held |
| Where | tabs `📝 Paper State` (data, do not edit), `📒 Paper Log` (every trade), `📈 Paper Values` (the daily values); a paper PDF after each Nightly |
| Restart | set a new `paper.start`: the next Nightly starts the test again from that day (the old results are replaced) |
| End | `paper.end` (default one year after the start); after it the accounts stop trading |
| Turn off | `features.paper` = `FALSE`: the Nightly skips it |

## 9. Running things by hand from GitHub

| Device | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| Desktop | github.com → your repo → **Actions** → pick the workflow in the left list → **Run workflow** (right side) → set the inputs → green **Run workflow** | a new run at the top, yellow, then green ✅ or red ❌ | the run is green | red → open it → the red step → the last lines say why (§11) |
| Phone | the GitHub app may not show **Run workflow**: use the phone browser → github.com → your repo → **Actions** → workflow → **Run workflow** (if missing: browser menu → **Desktop site**) | same | same | same |
| Rerun | open a finished run → **Re-run jobs** → **Re-run all jobs** | a new attempt | green | the same error twice → fix the cause first |

| Workflow | Inputs (default) | Use it for |
|---|---|---|
| **Nightly** | `run_checks` (off: leave off), `user` (`owner`) | the full nightly by hand, e.g. after a missed night. Best after 16:00 NY (the day's bars are final) |
| **Analyze** | `ticker`, `ai` (on: Gemini), `update_sheet` (on), `opus` (off; paid, needs `ai` on and an Anthropic key), `user` | one stock = Telegram `/analyze` |
| **Exit Report** | `user` | rebuilds the Exit report now, from fresh data, + the PDF |
| **Send Exit Report** | `opus` (off; paid), `user` | sends the SAVED Exit report = Telegram `/exit` |
| **AI Dispatch** | `buy` (off), `buy_gemini` (on), `buy_opus` (off), `exit` (off), `exit_gemini` (on), `exit_opus` (off; also the portfolio view), `effort` (`medium`; low / medium / high, higher costs more), `user` | AI text for the WHOLE Buy and/or Exit report (tick `buy` and/or `exit`). Opus here is paid per name |
| **My Options** | `user` | option values now |
| **Watchdog** | `user` | the run check now (silent when all ✅) |
| **Verify** | `days` (`3`, 1-7), `user` | = `/verify` with more or fewer days |
| **Setup Check** | `user` | every key and setting ✅ / ❌ / ➖ with one fix each, on the run's **Summary** page (names only, never values). Run it after any change of a secret or the Profile tab |
| **Dashboard** | `user` | builds and uploads the phone dashboard now (first publish, or a refresh). The five report runs also do it at their end once it is set up: docs/DASHBOARD.md |
| **Init user sheets** | `user` | adds a missing `Portfolio`, `🎯 Watchlist` or `💾 Script Properties` tab with its headers; never touches a tab that exists |
| **Telegram Check** | `user` | find your chat number; test the bot |
| **Telegram Setup** | `relay_url`, `user` | connect the bot to the relay again (after a new bot token or webhook secret, or a new relay address) |
| **CI** | — | the test suite (15-25 min of minutes); only after an update, if you want |
| **Long History** | `mode` (`backfill` first, then `append`), `tickers` | optional: daily prices from 2007 on a separate `prices` branch |
| **Nightly Backup** | — | nothing to do: it runs by itself |
| Record, Fetch Files, Migrate data tabs | — | advanced; Migrate: §13 |

## 10. Costs

| Item | Typical month | Notes |
|---|---|---|
| GitHub Actions (private repo) | 600-1,100 of the free 2,000 minutes | Nightly 5-30 min × 30; Watchdog and Nightly Backup about 1 billed minute each run (90 a month); My Options 1-3 min a day; each /analyze 3-5 min. Every run is rounded UP to whole minutes |
| Cloudflare, Telegram, Google Sheets, FRED/SEC/Yahoo | $0 | free plans |
| FMP, Alpha Vantage, Finnhub, Gemini | $0 | free tiers; limits in §11 |
| Claude Opus (optional) | your choice | /analyze + Opus about $0.15; `/exit opus` about $0.25; /verify one call; AI Dispatch with Opus per name, more with `effort` high. Set a monthly limit in the Anthropic console |
| FMP paid (optional) | their monthly price | only for a big list |

Check minutes: github.com → your photo → **Settings** → **Billing and licensing** → **Usage**.

## 11. When something fails

| You see | What it means | Do |
|---|---|---|
| No PDFs in the morning | the Nightly did not run or failed | GitHub → Actions → **Nightly**. No run today → Cloudflare → Worker → Settings → Trigger Events: are the 3 cron lines there? (they can vanish after a re-deploy) → add them again (SETUP_GUIDE P-5.5) → run the Nightly by hand. A red run → the row below |
| A red ❌ run | a step failed | open the run → the red step → read the last lines. Network or data blips: **Re-run all jobs**. The same error again → `/verify` |
| `🩺 ⚠️ Nightly: took 48 min (normal 15) — /verify for details <link>` | the Watchdog found a problem: ❌ = failed or did not run; ⚠️ = slow, still running, not yet run, or error lines in the log | send `/verify`; follow its advice; rerun the job if it failed |
| "⏰ The Nightly was started by the GitHub backup timer" | the relay timer did not start it; the backup did | check the 3 Cloudflare cron lines |
| "⚠️ The Nightly did not run tonight and the GitHub backup came too late (market hours)" | nothing started it in time | run **Nightly** by hand after 16:00 NY; fix the Cloudflare timers |
| "⚠️ Could not start it. GitHub said 401 (...). The GitHub token in the relay is wrong or expired." | the fine-grained token expired (1 year) or was revoked | SETUP_GUIDE P-2.9: a new token → Cloudflare `GITHUB_TOKEN` → **Deploy** → check the 3 cron lines → `/help` → `/exit` |
| "... GitHub said 403/404 (...) cannot start runs on this repo" | the token is for another repo or lacks Actions write, or `REPO` is wrong | new token for this repo; check `REPO` |
| "⚠️ The Nightly run could not be started. ..." | a relay TIMER start was refused | same as the 401/403 rows |
| Bot silent after a command | relay down, webhook secret mismatch, or the bot was reconnected elsewhere | open the relay address: it must show `ok relay <version>`. Then run **Telegram Setup** again |
| AI part says "not available"; Gemini 503 / "overloaded" in the log | Google's free Gemini was busy | try again in 10-30 min (`/analyze KO`, or `/exit` while the AI part is empty). The numbers are not affected |
| `⚠ PARTIAL DATA`, "No fundamentals", 429 or "limit" in the log | FMP free limit (about 250 calls a day) or Alpha Vantage (25 a day) used up | wait for tomorrow (the limits reset daily); shorten the Watchlist; avoid many /analyze on the same day; or an FMP paid plan |
| "⚠️ Run refused for user owner: the ⚙️ Profile tab ..." | the Profile tab is missing or has a bad value | fix the key it names (§7); run **Setup Check**; send the command again |
| "... paused, send it again after HH:MM UTC" | a maintenance pause (the data move) | wait, then send again |
| A run with a "spending limit / payments failed" note | the free minutes are used up | wait for the 1st, or allow paid minutes |
| PDF missing but the run is green | the PDF could not be made or sent; a 1-line note says so | the tab in the Sheet has everything; the PDF is also kept 30 days on the run page under **Artifacts** |
| `/verify` table without the Opus answer | no Anthropic key, or Opus failed | add `ANTHROPIC_API_KEY` (optional), or read the table yourself |
| "Opus ... no key" line in an /analyze PDF | "+ Opus" without an Anthropic key | add the key, or use Free |
| Tabs are red | the lock colour after every run | normal |
| You changed a key at its site | the old secret is dead | replace the GitHub secret (same name) and, for the bot token or webhook secret, the Cloudflare one too; then run **Telegram Setup** and **Setup Check** |

## 12. Updating to a new core version

The core owner publishes versions as release branches (`release/v1.0.0`, `release/v1.1.0`, ...) in the core repo; `main` is always the latest one. Your data lives in your sheets and secrets, not in the code, so an update never loses it.

### Way A: with a terminal or an AI coding session (keeps your repo)

| Do | You should see | ✅ Check | If it fails |
|---|---|---|---|
| `git clone https://github.com/YOU/TradingAnalyzer.git` → `cd TradingAnalyzer` | your files | — | sign in to GitHub when asked |
| `git remote add core https://github.com/CORE-OWNER/trading-analyzer-core.git` (once) → `git fetch core` | the new branches | `git branch -r` lists `core/release/vX.Y.Z` | no access → ask the core owner to invite you again |
| first update only: `git merge core/release/vX.Y.Z --allow-unrelated-histories -X theirs -m "Update to core vX.Y.Z"`. Later updates: `git merge core/release/vX.Y.Z -m "Update to core vX.Y.Z"` | "Merge made" | no conflict markers left (`git status` clean) | conflicts on a file you never edited → take the core's: `git checkout --theirs <file>` → `git add <file>` → `git commit` |
| `cd backend && npm ci && npm run typecheck && npm test` | 0 errors; 0 failing tests | — | do not push; ask the core owner |
| `git push` | — | your repo shows the merge commit | — |
| After the push: Telegram `/help` and Actions → **Watchdog** → Run | answers; green | — | §11 |

### Way B: no terminal (a fresh copy)

| Do | You should see | ✅ Check | If it fails |
|---|---|---|---|
| Open the core repo → **Use this template** → a NEW private repo (e.g. `TradingAnalyzer-2`) | your new copy | **Private** | no button → ask the core owner for access |
| Add every secret again (C1 of the setup guide) from your password manager | the 13 names (or 12 without Anthropic) | names match exactly | — |
| New fine-grained token for the NEW repo (or edit the old token: Repository access → add the new repo) → Cloudflare `GITHUB_TOKEN`; Cloudflare `REPO` = `you/TradingAnalyzer-2` → **Deploy** | the relay page shows no missing settings | `/analyze KO` gives a PDF | 401/403 → the token |
| Old repo: Settings → General → **Archive this repository** (it then runs nothing). Do not delete it until the new one ran a week | — | only the new repo runs | two Nightlies a night = the old repo still runs: archive it |

### After either way

| Do | You should see | ✅ Check | If it fails |
|---|---|---|---|
| Compare the relay version: the relay address shows `ok relay <version>`; your repo's `relay/telegram-relay.worker.mjs` has `RELAY_VERSION = '<version>'` | the two versions | the same → nothing to do | different → paste the new relay code (SETUP_GUIDE P-5.2), then CHECK THE 3 CRON LINES (P-5.7) |
| Read the new `docs/USER_MANUAL.md` and `docs/SETUP_GUIDE.md` for new secrets, Profile keys or tabs | — | — | a run refuses with "unknown key" → a Profile key was renamed: see §7 of the new manual |
| If the bot menu changed: Actions → **Telegram Setup** | the new menu | — | — |

## 13. Optional: the data move to 3 sheets

Until you choose it, everything is written to My Portfolio (only `🩺 Run Health` goes to Reports). The move puts the machine data into the Data sheet and the report tabs into the Reports sheet, so My Portfolio keeps your own tabs. It is optional and advanced: an AI coding session can guide you through it.

| Do | You should see | ✅ Check | If it fails |
|---|---|---|---|
| Actions → **Migrate data tabs** → `step` = `check` → **Run workflow** | the log lists what would move and any problem | the log ends without an error | follow the line the log gives; nothing was changed |
| The writing steps (`plan`, `rehearse`, `rehearse-cleanup`, `migrate`, `delete`, `copy-back`, `abort`) refuse to start 20:30-23:00 and 03:00-05:30 UTC (My Options and the Nightly). During `migrate` the other runs pause and say "send it again after HH:MM UTC" | each step green | after `migrate`, the next Nightly writes to all 3 sheets | a run refuses with "The spreadsheets are marked as moved, but ..." → the line names the missing part; nothing was changed. `abort` undoes the move |
