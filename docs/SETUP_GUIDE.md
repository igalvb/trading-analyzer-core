# Setup guide: a new user, from zero to the first nightly report

Tables, short lines. Checked against the code on 6 Nov 2026 (relay `2026-11-05.2`).
For: a person who does not program, OR a fresh AI coding session with no context.

| Read | When |
|---|---|
| [PREREQUISITES.md](PREREQUISITES.md) | BEFORE you start: accounts, devices, time, costs, the checklist, the secrets worksheet |
| This file | the setup itself, step by step (about 3 hours + one night) |
| [USER_MANUAL.md](USER_MANUAL.md) | AFTER setup: daily use, reports, Telegram commands, fixing problems, updates |

---

## A. For an AI session (read this first)

| # | Do |
|---|---|
| A1 | Read, in order: `docs/PREREQUISITES.md`, this file, `backend/.env.example`, `backend/src/workflows/schedule.ts` (the secret names each workflow reads), the top comment of `relay/telegram-relay.worker.mjs`, `backend/src/profile/schema.ts` (the Profile keys), `docs/USER_MANUAL.md` |
| A2 | Facts you can rely on: every per-user workflow reads the `⚙️ Profile` tab first (`npm run profile-fetch`) and refuses without it; the run user is `owner` unless the `user` input says otherwise; the relay needs `REPO` and `TICKERS`; Telegram gets PDFs with a one-line caption, and one-line alerts only (USER_MANUAL §2; the code: `backend/src/notify/policy.ts`) |
| A3 | Local checks you may run: `cd backend && npm ci && npm run typecheck && npm test` (no keys needed) |
| A4 | Never ask for a key, token, password, sheet ID or chat number in chat. Never print one. Never write one to a file, a sheet, a commit or a log |
| A5 | The human pastes every key ONLY into: GitHub → Settings → Secrets and variables → Actions, or Cloudflare → Worker → Settings → Variables and Secrets |
| A6 | What you MAY ask the human: which step they are on; what a screen shows (with secrets hidden); the ✅/❌ table of the Setup Check; the link of a failed GitHub run |
| A7 | What to ask the human to decide: their stocks (P-4S: `lists.core`, `paper.fixedUniverse`, the `🎯 Watchlist` tab, relay `TICKERS`; at least 3, typically 10-20), tax rate, time zone, features (paper test, My Options, AI, weekly stops) |
| A8 | Verify each phase with its ✅ check before moving on. On ❌ use the "If it fails" column |
| A9 | The live broker bot is not part of this setup. Leave `features.liveBot` off |
| A10 | The Setup Check and the sheet filler are GitHub Actions buttons: **Setup Check** and **Init user sheets** (P-4.5, P-7.1). Ask the human for the ✅/❌ table from the run summary (names only, never values). The terminal way (local `backend/.env`) is for the HUMAN on their own computer; you never hold the keys |

---

## B. What you need (summary; details and prices in PREREQUISITES.md)

| # | Item | Cost | Needed for | Without it |
|---|---|---|---|---|
| 1 | GitHub account | FREE | the program runs here | nothing works |
| 2 | Google account (personal Gmail best) | FREE | the 3 sheets + the robot key | nothing works |
| 3 | Google Cloud project + robot (service account) | FREE (no billing needed for the Sheets API) | the program reads and writes your sheets | nothing works |
| 4 | Telegram app + a bot (BotFather) | FREE | PDFs on your phone; /analyze, /exit, /verify | reports only in the sheets |
| 5 | Cloudflare account + Worker (the relay) | FREE | the timers (Nightly, My Options) + phone commands | you start every run by hand in GitHub |
| 6 | FMP key | FREE tier (about 250 calls a day) | fundamentals | fundamentals missing; verdicts say "No fundamentals" |
| 7 | Alpha Vantage key | FREE tier (about 25 calls a day) | backup prices and data | gaps in some data |
| 8 | Finnhub key | FREE tier (about 60 calls a minute) | quotes and series | gaps in some data |
| 9 | Gemini key (Google AI Studio) | FREE tier | the AI text in /analyze and /exit | AI parts say "not available"; the numbers are unchanged |
| 10 | SEC contact email | FREE (any email you read) | SEC filings (the SEC asks for a contact). Every data run needs it | runs stop at the start |
| 11 | Keyless sources: FRED, SEC, FINRA, CBOE, Yahoo, Nasdaq | FREE, no account | prices, options, dark pool, macro | — |
| P1 | Anthropic key (Claude Opus) | PAID per use | "+ Opus" on /analyze (about $0.15), `/exit opus` (about $0.25), the /verify diagnosis, Opus in AI Dispatch | Gemini only; /verify sends its table without the Opus answer |
| P2 | FMP paid plan | PAID monthly | more calls on a big list | some fundamentals skipped |
| P3 | More GitHub minutes | PAID | more than 2,000 minutes a month (private repo) | runs stop until the 1st of next month |

---

## C. Names you will type (copy exactly)

### C1. GitHub secrets (your repo → Settings → Secrets and variables → Actions → tab **Secrets**)

| Secret name | Value | From step | Read by |
|---|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the WHOLE robot key file (JSON) | P-2.1 | every workflow that reads a sheet |
| `SPREADSHEET_ID` | ID of your **My Portfolio** sheet | P-4.3 | same |
| `REPORTS_SPREADSHEET_ID` | ID of your **Reports** sheet | P-4.3 | same (the Setup Check wants it) |
| `DATA_SPREADSHEET_ID` | ID of your **Data** sheet | P-4.3 | same (the Setup Check wants it) |
| `FMP_API_KEY` | FMP key | P-2.3 | Nightly, Analyze, Exit Report, Send Exit Report, AI Dispatch, Record |
| `ALPHAVANTAGE_KEY` | Alpha Vantage key | P-2.4 | same |
| `FINNHUB_KEY` | Finnhub key | P-2.5 | same |
| `SEC_CONTACT_EMAIL` | your email | P-2.6 | same + My Options |
| `GEMINI_API_KEY` | Gemini key | P-2.2 | Analyze, Send Exit Report, AI Dispatch, Record |
| `TELEGRAM_BOT_TOKEN` | bot key from BotFather | P-2.7 | every workflow that talks to Telegram |
| `TELEGRAM_CHAT_ID` | your chat number | P-6.2 | same |
| `TELEGRAM_WEBHOOK_SECRET` | a random text you make | P-2.8 | Telegram Setup only |
| `ANTHROPIC_API_KEY` | OPTIONAL, paid | P-8.1 | Analyze, Send Exit Report, AI Dispatch, Verify |

Not secrets, never typed: `GITHUB_TOKEN` inside the workflows is made by GitHub for each run.

### C2. Cloudflare Worker settings (Worker → Settings → Variables and Secrets)

| Name | Type | Value | Same as |
|---|---|---|---|
| `BOT_TOKEN` | **Secret** | bot key | GitHub `TELEGRAM_BOT_TOKEN` |
| `ALLOWED_CHAT_ID` | **Secret** | chat number | GitHub `TELEGRAM_CHAT_ID` |
| `WEBHOOK_SECRET` | **Secret** | random text | GitHub `TELEGRAM_WEBHOOK_SECRET` |
| `GITHUB_TOKEN` | **Secret** | fine-grained GitHub token (P-2.9) | — (Cloudflare only) |
| `REPO` | **Text**, REQUIRED | `yourname/yourrepo` (for example `jane-doe/TradingAnalyzer`) | — |
| `TICKERS` | **Text**, REQUIRED | your /analyze buttons (P-4S), for example `AQZA,BQZA,CQZA,MQZA` (made-up) | — |
| `USERS` | Text, optional | only for several people on one repo (section G) | — |

### C3. Sheets and tabs

| Sheet (your name for it) | Tabs YOU create | Made by the runs |
|---|---|---|
| My Portfolio | `Portfolio`, `🎯 Watchlist`, `💾 Script Properties`, `⚙️ Profile` | every report and history tab (`🛒 Buy Report`, the Exit report tab, `📒 Transactions`, paper tabs, ...) |
| Reports | none | `🩺 Run Health` (the Watchdog) |
| Data | none | nothing until you choose the optional data move (Migrate data tabs) |

Copy the tab names exactly, emoji included (copy them from this page). A name with a different space or emoji is a different tab.

---

## D. Phases

Each step: **Do** → **You should see** → **✅ Check** → **If it fails**.

### P-1 Accounts and your copy (about 30-45 min, all FREE)

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 1.1 GitHub | github.com → **Sign up** → email, password, username → verify the email code | your profile page | you can open github.com/yourname | use another username; check spam for the code |
| 1.2 Your copy | Open the core repo link the owner sent you (accept the invitation email first) → green **Use this template** → **Create a new repository** → Owner: you → name `TradingAnalyzer` → **Private** → leave "Include all branches" OFF → **Create repository**. Got a zip instead: PREREQUISITES §6 way C | your own private repo with folders `backend`, `relay`, `docs`, `.github` | the repo page shows **Private** next to the name | no **Use this template** button = the owner has not ticked "Template repository" yet, or you have not accepted the invitation. Phone: use the browser, menu → **Desktop site** |
| 1.3 Turn on Actions | your repo → **Actions** tab → if asked, **I understand my workflows, go ahead and enable them** | the list: AI Dispatch, Analyze, CI, Exit Report, Fetch Files, Init user sheets, Long History, Migrate data tabs, My Options, Nightly, Nightly Backup, Record, Send Exit Report, Setup Check, Telegram Check, Telegram Setup, Verify, Watchdog | the list is there | Settings → Actions → General → **Allow all actions and reusable workflows** → **Save** |
| 1.4 Google | use a personal Gmail (a work or school account often blocks robot keys) | — | you can open sheets.google.com | make a new personal Gmail |
| 1.5 Telegram | install Telegram on your phone, sign up with your phone number | the chats list | you can search `@BotFather` | update the app |
| 1.6 Cloudflare | dash.cloudflare.com → **Sign up** → email, password → verify the email | the Cloudflare dashboard | the left menu has **Workers & Pages** (under Compute) | check spam; the free plan needs no card |

### P-2 Keys (about 40-60 min)

Keep each key in a password manager on YOUR device until P-3. Never send it in chat or email. Fill the worksheet in PREREQUISITES §8 as you go (names and "done" ticks only, never the values).

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 2.1 Google robot | DESKTOP browser. a) console.cloud.google.com → project picker (top bar) → **New Project** → name `trading-analyzer` → **Create** → select it. b) ☰ → **APIs & Services** → **Library** → search `Google Sheets API` → **Enable**. c) ☰ → **IAM & Admin** → **Service Accounts** → **Create service account** → name `trading-robot` → **Create and continue** → skip roles → **Done**. d) click `trading-robot` → tab **Keys** → **Add key** → **Create new key** → **JSON** → **Create**. A file downloads | a `.json` file; the robot email, like `trading-robot@trading-analyzer.iam.gserviceaccount.com` (copy it: you need it in P-4.2) | the file opens as text and starts with `{` and has `"type": "service_account"` | "key creation is disabled" = a work-account policy → use a personal Gmail |
| 2.2 Gemini | aistudio.google.com → **Get API key** → **Create API key** → pick project `trading-analyzer` → copy | a key that starts `AIza` | it shows in the keys list | region not supported → skip it; the AI parts say "not available" |
| 2.3 FMP | financialmodelingprep.com → **Sign up** (free) → verify the email → **Dashboard** → copy **API Key** | a long key of letters and digits | it shows on the dashboard | verify the email first |
| 2.4 Alpha Vantage | alphavantage.co → **Get your free API key** → fill the form → copy | a short key | it shows on the page | copy it at once: the page does not email it |
| 2.5 Finnhub | finnhub.io → **Get free API key** → register → **Dashboard** → copy | a key | it shows on the dashboard | verify the email |
| 2.6 SEC email | choose a real email you read | — | it has an `@` and a dot | — |
| 2.7 Telegram bot | Telegram → search `@BotFather` (blue tick) → **Start** → send `/newbot` → a name (e.g. `My Trading`) → a username ending in `bot` (e.g. `jane_trading_123_bot`) → copy the token | "Use this token to access the HTTP API:" and a token like `123456789:AA...` | the token has one `:` in it | "username taken" → try another |
| 2.8 Webhook secret | make a random text of 32-64 characters, letters and digits only (password manager → generate → letters + digits, no symbols) | — | only `A-Z a-z 0-9` (`_` and `-` are allowed too); at least 16 characters | Telegram Setup says "16+ letters, digits, _ or -" → make a new one |
| 2.9 GitHub token (for the relay) | github.com → your photo → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token** → name `trading-relay` → Expiration: **1 year** (put a calendar reminder 11 months from today) → Repository access: **Only select repositories** → your `TradingAnalyzer` → **Permissions** → Repository permissions → **Actions: Read and write** (Metadata: Read is added by itself) → **Generate token** → copy | a token that starts `github_pat_` | it is shown once | lost it → generate a new one and replace it in Cloudflare |

### P-3 Save keys in GitHub (about 15 min)

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 3.1 Open the screen | your repo → **Settings** → **Secrets and variables** → **Actions** → tab **Secrets** | "Repository secrets" | — | no **Settings** tab = you are not the owner of this repo (you opened the core repo, not your copy). Phone: browser, **Desktop site** |
| 3.2 Add each secret | **New repository secret** → Name (exact, from C1) → Secret (paste) → **Add secret**. Do it now for: `GOOGLE_SERVICE_ACCOUNT_JSON`, `FMP_API_KEY`, `ALPHAVANTAGE_KEY`, `FINNHUB_KEY`, `GEMINI_API_KEY`, `SEC_CONTACT_EMAIL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`. The 3 sheet IDs come in P-4.3, the chat number in P-6.2 | the name in the list; the value is never shown again | 8 names listed | a typo in a NAME = the program does not find it: delete it, add it again |
| 3.3 Robot key | for `GOOGLE_SERVICE_ACCOUNT_JSON` open the `.json` file in a text editor → select all → copy → paste the WHOLE text, from the first `{` to the last `}` | — | — | pasted only part → delete the secret, paste again |
| 3.4 Clean up | delete the downloaded `.json` from Downloads (keep one copy in your password manager) | — | — | — |

### P-4 Sheets (about 30 min)

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 4.1 Make 3 sheets | sheets.google.com → **Blank spreadsheet** → name it `My Portfolio`. Again for `Reports` and `Data` | 3 sheets in your Google Drive | — | — |
| 4.2 Share with the robot | in EACH sheet → **Share** → paste the robot email (P-2.1) → role **Editor** → untick **Notify people** → **Share** (or **Share anyway**) | the robot listed as Editor | all 3 sheets | "can't share outside your organisation" = work account → use a personal Gmail |
| 4.3 Copy the IDs | the ID is the part of the sheet's address between `/d/` and `/edit`. Save it as the GitHub secret: My Portfolio → `SPREADSHEET_ID`, Reports → `REPORTS_SPREADSHEET_ID`, Data → `DATA_SPREADSHEET_ID` | a text of about 44 letters, digits, `-` and `_` | 3 secrets added; no `/` inside a value | you pasted the whole address → delete the secret, paste only the ID |
| 4.4 Why 3 sheets | until you choose the optional data move (USER_MANUAL §13), everything is written to My Portfolio. Only the Watchdog's `🩺 Run Health` tab goes to Reports. Data stays empty | — | — | — |
| 4.5 Input tabs | First make the `⚙️ Profile` tab and fill it (4.6): every run reads it first. Then EITHER way A (button): GitHub → **Actions** → **Init user sheets** → **Run workflow** → leave `user` as `owner` → **Run workflow**. It adds `Portfolio` (stock and options headers, the CLOSED marker), `🎯 Watchlist` and `💾 Script Properties`; it never touches a tab that exists. OR way B (by hand): make the 3 tabs (the **+** at the bottom left; double-click a tab to rename it) and type the rows in the table below | the run summary: "✅ Portfolio: added with the template headers." (one line per tab) and "Done. Fill in your holdings and watchlist, then run the Setup check." | run it again: "Nothing to do: the input tabs are already there." | red run "Run refused ... the ⚙️ Profile tab ..." → 4.6 first. "could not open the sheet" → 4.2 (sharing) or 4.3 (ID). A run later says "The spreadsheet has no "💾 Script Properties" tab" → run this button, or make the tab by hand |
| 4.6 Profile tab | fill `⚙️ Profile`: column A = Key, column B = Value. Start with the rows of the minimal example below; your stocks: P-4S. Every key, its default and its meaning: USER_MANUAL §7 | your rows | `user.id` is filled (any short id: a-z first, then a-z, 0-9 or _); `tax.rate` is filled; `lists.core` has 3-30 tickers (P-4S) | a run says "⚠️ Run refused for user owner: the ⚙️ Profile tab is not valid: ..." → fix the key it names |
| 4.7 Fill Portfolio and Watchlist | `Portfolio`: one row per stock under the stock header; options under `OPEN positions`; columns and examples: USER_MANUAL §6. `🎯 Watchlist`: one ticker per row from A2 (the Buy report covers these; P-4S) | your rows | `type` is `stock` or `crypto` on each stock row; no empty row between two option rows | the Exit report says "No open positions were found on the Portfolio sheet" → the header row is misspelled |

Tabs by hand (way B of 4.5), row 1 of each (`⚙️ Profile` is always made by hand):

| Tab | Row 1 (one word per cell, A, B, C, ...) |
|---|---|
| `Portfolio` | row 1: `Stocks` (a label). Row 2: `Ticker` · `type` · `sub-type` · `amount` · `price per item` · `value of inverstment` · `cost avg per stock` · `Purchase Date` · `URLS / comments`. Leave rows 3-9 for stocks. Then a row `OPEN positions`, then the options header: `Ticker` · `type` · `positions` · `last trade Date` · `strike` · `PUT/CALL` · `avg price - Premium paid` · `cost basis` · `current market value` · `URLS / comments` · `Purchase Date`. Below your options: a row with `CLOSED positions` in column A (the end marker) |
| `🎯 Watchlist` | `Ticker` (A1), then one ticker per row |
| `💾 Script Properties` | `Key` · `Value` · `UpdatedAt` (the runs fill it; do not edit it) |
| `⚙️ Profile` | `Key` · `Value` |

Copy the header words exactly, spelling included (`value of inverstment` is spelled that way on purpose). The program finds each table by its header words, so extra rows above a table are fine.

Minimal `⚙️ Profile` (your values; format column B as **Format → Number → Plain text** first, so dates stay as typed):

| Key | Value |
|---|---|
| `user.id` | a short id for you: a-z first, then a-z, 0-9 or `_`, at most 20, for example `jane` (any valid id works in your own copy; `owner` is fine too) |
| `user.timeZone` | your zone, for example `Europe/London` or `America/New_York` |
| `lists.core` | your list, 3-30 tickers (P-4S), for example `AQZA, BQZA, CQZA, DQZA, EQZA` (made-up: use your own) |
| `tax.rate` | your capital-gains tax as a fraction, for example `0.25` (25%) |
| `features.paper` | `FALSE` (or `TRUE` and also the next row) |
| `paper.start` | only with the paper test on: the next trading day, `YYYY-MM-DD` |
| `features.ai` | `TRUE` if you saved a Gemini key (the Setup Check then tests it), else `FALSE` |

### P-4S Choose your stocks (about 15 min). Do not skip: with no stocks most of the program sits idle

The program has no stock list of its own. You give it 4 lists, each in its own place. Empty or tiny lists = an empty Buy report and paper accounts that never buy.

Where each list lives and what it drives:

| Where you type it | Paper accounts | Buy report | Exit report | Analyze buttons |
|---|---|---|---|---|
| `⚙️ Profile` → `lists.core` (your list) | the **B your list** accounts (and the "hold your list" yardstick) trade ONLY these. Also the default for the next row and for the research tools | — | — | — |
| `⚙️ Profile` → `paper.fixedUniverse` (leave the row out = same as `lists.core`) | the **A original** accounts (Buy report tier 1, the engine, the book models) trade these + the Watchlist. The "Hold N + watchlist" yardstick = these + the Watchlist on the start day | — | — | — |
| `🎯 Watchlist` tab, column A from A2 | added to the **A original** accounts' stocks every night | the candidates it ranks (ONLY these) | — | — |
| `Portfolio` tab (what you really hold; USER_MANUAL §6) | — | — | = your Portfolio tab (every open holding) | — |
| Cloudflare Worker → `TICKERS` (Text, P-5.3) | — | — | — | the buttons of `/analyze` (any other ticker: the "Other ticker" button) |

How many:

| List | Minimum | Typical | Most |
|---|---|---|---|
| `lists.core` | 3 (the Setup Check shows ❌ below 3) | 10-20 | 30 |
| `paper.fixedUniverse` | 1 when the paper test is on (or leave the row out) | the same as `lists.core` | — |
| `🎯 Watchlist` | 1 (the Setup Check shows ❌ when empty) | 10-20 (each name costs FMP calls: 250 a day free) | about 25 on the free plans |
| `TICKERS` | 1 | 5-15 (buttons on a phone screen) | — |

Example (made-up tickers: type your own). Profile rows:

| Key | Value |
|---|---|
| `lists.core` | `AQZA, BQZA, CQZA, DQZA, EQZA, FQZA, GQZA, HQZA, JQZA, KQZA` |
| `paper.fixedUniverse` | leave the row out (= `lists.core`), or for example `AQZA, BQZA, CQZA, DQZA` |

`🎯 Watchlist`: A1 `Ticker`, A2 `AQZA`, A3 `BQZA`, A4 `MQZA`, A5 `NQZA` (stocks you might buy; may overlap your list). Cloudflare `TICKERS` = `AQZA,BQZA,CQZA,MQZA`.

| Step | Do | ✅ Check | If it fails |
|---|---|---|---|
| 4S.1 | type the lists above (Profile rows, the Watchlist tab; `TICKERS` in P-5.3) | — | — |
| 4S.2 | run **Setup Check** (P-7.1) | the rows `Profile lists.core`, `Profile paper.fixedUniverse` (➖ with the paper test off) and `🎯 Watchlist tab` are ✅ with a count | ❌ "Empty." / "Only N ticker(s)." / "No tickers." → follow the row's fix. The check shows counts only, never your tickers |

### P-5 Relay and timers (about 20 min, Cloudflare, DESKTOP browser)

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 5.1 Create the Worker | Cloudflare → **Workers & Pages** → **Create** (or **Create application**) → **Start with Hello World!** → name `trading-relay` → **Deploy**. First time only: Cloudflare asks you to pick your `workers.dev` subdomain | an address like `https://trading-relay.yourname.workers.dev` | opening it shows "Hello World!" | — |
| 5.2 Paste the code | **Edit code** → select all in the editor → delete → open `relay/telegram-relay.worker.mjs` in YOUR repo on GitHub → **Raw** → select all → copy → paste into the editor → **Deploy** | "Deployed" / "Version saved" | — | a red error line → you pasted part of the file: paste the whole file again |
| 5.3 Settings | Worker → **Settings** → **Variables and Secrets** → **+ Add**: `BOT_TOKEN`, `WEBHOOK_SECRET`, `GITHUB_TOKEN` as type **Secret**; `REPO` and `TICKERS` as type **Text** (C2). `ALLOWED_CHAT_ID` comes after P-6.1 → **Deploy** (or **Save and deploy**) | the names listed | 3 secrets + 2 text values | a name typo → delete, add again |
| 5.4 Check the relay | open the relay address in a browser | `ok relay 2026-11-05.2` (or a newer version) | NO `(missing settings: ...)` at the end | `(missing settings: REPO)` or `TICKERS` → 5.3; a malformed `REPO` (not `name/repo`) counts as missing |
| 5.5 Timers | Worker → **Settings** → **Trigger Events** (older screens: **Triggers**) → **+ Add** → **Cron Triggers** → add each, one at a time: `23 3 * * *`, `5 21 * * *`, `5 22 * * *` | 3 cron lines | all 3 listed | "limit reached": the free plan allows only a few Cron Triggers per ACCOUNT (5 at the time of writing) → remove unused ones on other Workers |
| 5.6 Timer meaning | 03:23 UTC = the Nightly (23:23 New York in summer, 22:23 in winter). 21:05 and 22:05 UTC = My Options at 17:05 New York (only the one in the 17:00 New York hour acts; the other does nothing) | — | — | a timer at any other time sends "⚠️ A relay timer fired at ... that matches no job" to Telegram → fix the cron text |
| 5.7 WARNING | Cron Triggers have vanished before after a code paste or a re-deploy. After EVERY paste of new relay code or change of settings: open Trigger Events again and check the 3 lines | — | 3 lines still there | missing → add them again (5.5) |

### P-6 Telegram (about 15 min). ORDER MATTERS: 6.1 before 6.4

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 6.1 Find your chat number | Telegram → open your bot → **Start** → send `hi`. GitHub → your repo → **Actions** → **Telegram Check** → **Run workflow** → leave `user` as `owner` → **Run workflow** | the bot writes "✅ Trading Analyzer found you. Last step: in GitHub add a secret named TELEGRAM_CHAT_ID with this number:" and a number | the run is green ✅ | "no chat found" → send the bot a message again, rerun. If the bot is already connected to the relay (6.4 done), Telegram does not give the number: run Telegram Setup later again after you have the number |
| 6.2 Save it | GitHub secret `TELEGRAM_CHAT_ID` = the number. Cloudflare Worker setting `ALLOWED_CHAT_ID` (type **Secret**) = the same number → **Deploy** | — | — | — |
| 6.3 Test | run **Telegram Check** again | the bot writes "✅ Trading Analyzer is connected. Reports will arrive in this chat." | — | still "found you" → the GitHub secret name is wrong |
| 6.4 Connect the bot to the relay | GitHub → **Actions** → **Telegram Setup** → **Run workflow** → `relay_url` = the relay address from P-5.1 (with `https://`) → **Run workflow** | green ✅ run; the bot's **Menu** button now lists /exit, /analyze, /help | — | red ❌ "16+ letters, digits, _ or -" → the webhook secret is too short or has symbols (P-2.8) |
| 6.5 First command | send `/help` to the bot | the list of commands | it answers within a few seconds | silent → `WEBHOOK_SECRET` (Cloudflare) ≠ `TELEGRAM_WEBHOOK_SECRET` (GitHub), or `ALLOWED_CHAT_ID` ≠ your chat number; fix, deploy, rerun 6.4 |

### P-7 First runs (about 30 min + one night)

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 7.1 Setup Check (also checks your stocks, P-4S) | GitHub → **Actions** → **Setup Check** → **Run workflow** → leave `user` as `owner` → **Run workflow** → open the finished run → its **Summary** page. (Terminal alternative, on YOUR computer with Node 24 and git: clone your repo → `cd backend` → `npm ci` → copy `.env.example` to `.env` and fill it; git ignores it → `npm run profile-fetch -- --out out/profile.json` → `PROFILE_FILE=out/profile.json node --env-file=.env src/setupCheck.ts`) | the **Setup check** table: one row per key, ✅ / ❌ / ➖ (not needed) + one fix. No values shown. Last line "All set." | green run; no ❌ (`ANTHROPIC_API_KEY` may show ➖) | red run = at least one ❌: follow the row's fix, run it again. A ❌ Profile row repeats why the Profile tab was refused |
| 7.2 One stock | send `/analyze` → tap a button → **🆓 Free (Gemini)**. Or type `/analyze AAPL` | "⏳ Analysing AAPL… about 3 min.", then a PDF with a one-line caption | the PDF arrives; your sheet has new tabs | "⚠️ Could not start it. GitHub said 401" → `GITHUB_TOKEN` in Cloudflare (P-2.9). No PDF after 10 min → Actions → **Analyze** → open the red run → the last lines of the failed step name the problem |
| 7.3 First Nightly by hand | GitHub → **Actions** → **Nightly** → **Run workflow** → leave "Also run typecheck..." OFF → **Run workflow** | a yellow run, then green ✅ (5-30 min, longer for a big list); 2 PDFs in Telegram: Buy report (caption = the bottom line) and Exit report | both PDFs; tabs `🛒 Buy Report` and the Exit report in My Portfolio | ❌ → USER_MANUAL §11 |
| 7.4 Exit report | send `/exit` | "⏳ Getting the Exit Report…", then the Exit PDF (about 1 min; about 4 if the AI part is added first) | your holdings are listed | "No open positions were found" → the Portfolio headers (P-4.5) |
| 7.5 Other workflows once | Actions → **Watchdog** → Run workflow. If you hold options: Actions → **My Options** → Run workflow | green runs. Watchdog: silent in Telegram when all is fine; a `🩺 Run Health` tab in Reports | — | My Options writes only the `current market value` cells of your option rows; with no options it has nothing to do. Later, GitHub's own My Options timer often ends early with "ending early on purpose": that is normal |
| 7.6 The first night | do nothing. Tonight the relay timer starts the Nightly; the GitHub backup timer starts it if the relay did not | next morning: Buy PDF + Exit PDF in Telegram | Actions → Nightly: a green run with today's date | no PDFs → USER_MANUAL §11 "No PDFs in the morning" |
| 7.7 Minutes | github.com → your photo → **Settings** → **Billing and licensing** (or **Billing and plans**) → Usage → Actions | the minutes used this month | on track to stay under 2,000 a month (estimate: PREREQUISITES §5) | high → fewer manual runs; never switch CI to run on every push |

### P-8 Optional paid items

| Step | Item | Do | What you gain | Without it |
|---|---|---|---|---|
| 8.1 | Anthropic (Claude Opus) | console.anthropic.com → sign up → **Billing** → add credit (prepaid) → **Settings** → **Limits** → set a monthly spend limit (e.g. $10) → **API Keys** → **Create Key** → GitHub secret `ANTHROPIC_API_KEY` | "+ Opus" on /analyze, `/exit opus`, the Opus answer of /verify, Opus in AI Dispatch | Gemini only; nothing breaks |
| 8.2 | FMP paid | upgrade on the FMP site; the key stays the same | fewer skipped fundamentals on a big list | free limits |
| 8.3 | GitHub minutes | Settings → Billing → set a spending limit above $0, or a paid plan | more than 2,000 minutes a month | runs stop until the 1st |

---

## E. Rules (everyone)

| Rule | Why |
|---|---|
| Keys only in GitHub Secrets and Cloudflare secrets (and, only for the optional terminal way, a local `backend/.env` that git ignores) | anything else can leak |
| Never paste a key in chat, email, a sheet, a commit, an issue | same |
| If a key leaks: make a new one at its site, replace the secret, delete the old one | the old one stops working |
| Long-only: long stock and long calls only. No puts, shorts, writing calls, margin | built into the program; no setting changes it |
| Paid AI (Opus) runs only when you ask (+ Opus button, the word `opus`, AI Dispatch) | cost and control |
| CI is by hand only | free minutes |
| Keep your copy Private | run logs and sheets hold your holdings |
| A report is information, not advice | the program has no proven edge |

## F. Common failures during setup

| You see | Cause | Fix |
|---|---|---|
| `sheets mode needs GOOGLE_SERVICE_ACCOUNT_JSON and SPREADSHEET_ID` | secret missing or misnamed | P-3.2, P-4.3 |
| "⚠️ Run refused for user owner: the ⚙️ Profile tab is missing or empty" | no `⚙️ Profile` tab, or a different name | P-4.5, P-4.6 (copy the name from C3) |
| "... the ⚙️ Profile tab is not valid: user.id is not valid" | `user.id` has capitals or a space, or starts with a digit | a-z first, then a-z, 0-9 or `_`, e.g. `jane` |
| "... is not valid: tax.rate is required (no default)" (or another key) | a missing or bad value | the key it names; USER_MANUAL §7 |
| "The spreadsheet has no "💾 Script Properties" tab" | the tab is missing | P-4.5 |
| `permission denied (403)` on a spreadsheet | sheet not shared with the robot | P-4.2 |
| `spreadsheet not found (404)` | whole address pasted, not the ID | P-4.3 |
| Telegram silent after `/help` | webhook secret mismatch, wrong `ALLOWED_CHAT_ID`, or relay not deployed | P-5.2, P-5.3, P-6.4 |
| "⚠️ Could not start it. The relay has no REPO setting" | `REPO` missing in Cloudflare | P-5.3 |
| "⚠️ Could not start it. GitHub said 401 ... wrong or expired" | relay `GITHUB_TOKEN` wrong or expired | P-2.9 new token → Cloudflare |
| "GitHub said 403/404 ... cannot start runs on this repo" | the token is for another repo, lacks **Actions: Read and write**, or `REPO` is misspelled | P-2.9, P-5.3 |
| "/analyze: 📊 No TICKERS setting in the relay yet" | `TICKERS` missing | P-5.3 (the "Other ticker" button still works) |
| A "spending limit / payments failed" note on a run | free minutes used up | wait for the 1st, or P-8.3 |

## G. Several people on one repo (optional, advanced)

Simplest: each person makes their OWN copy (P-1.2). Every run here uses the minutes of the REPO OWNER's GitHub account, so this mode is for one household or test users of your own, NOT for other people (give them the template or a zip: PREREQUISITES §6 "Sharing safely"). Only if one repo must serve several of your own users:

| # | Do |
|---|---|
| G1 | Pick a user id per extra person: `a-z` first, then `a-z`, `0-9` or `_`, at most 20 (e.g. `u2`) |
| G2 | Add their secrets with the id as prefix, upper case: `U2_SPREADSHEET_ID`, `U2_TELEGRAM_CHAT_ID`, ... (every C1 name). A missing `U2_` secret is empty, never the owner's |
| G3 | Their `⚙️ Profile` tab has `user.id` = their id (`u2`): for an extra user it must match |
| G4 | Cloudflare `USERS` (Text) = `{"<their chat number>": {"user": "u2", "tickers": ["AAPL", "KO"], "timers": true}}` → Deploy. The timers then start each run once per user, the owner first |
| G5 | By hand in GitHub: type their id in the `user` box of **Run workflow** |
