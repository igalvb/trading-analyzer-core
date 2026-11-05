# Setup guide: a new user, from zero to the first nightly report

Tables, short lines.
For: a person who does not program, OR a fresh AI coding session with no context.

> Steps marked **"after P7"** (or P5/P6) are built in this copy; where a step names "today's way", either way works.

---

## A. For an AI session (read this first)

| # | Do |
|---|---|
| A1 | Read, in order: this file, `backend/.env.example`, `backend/src/workflows/schedule.ts` (secret names per workflow), `relay/telegram-relay.worker.mjs` (top comment) |
| A2 | Check the phase status: does `backend/src/setupCheck.ts` exist? (yes = after P7). Does every workflow have a `user` input? (yes = after P5). Does the relay read `REPO` from env? (yes = after P6) |
| A3 | Local checks you may run: `cd backend && npm ci && npm run typecheck && npm test` (no keys needed) |
| A4 | Never ask for a key, token, password, sheet ID or chat number in chat. Never print one. Never write one to a file, a sheet, a commit or a log |
| A5 | The human pastes every key ONLY into: GitHub → Settings → Secrets and variables → Actions, or Cloudflare → Worker → Settings → Variables and Secrets |
| A6 | What you MAY ask the human: which step they are on; what a screen shows (with secrets hidden); the ✅/❌ table from Setup Check; the run link of a failed GitHub run |
| A7 | What to ask the human to decide: their ticker list (1-30), tax rate, time zone, which features (paper test, My Options, AI) |
| A8 | Verify each phase with its ✅ check before moving on. On ❌ use the "If it fails" column, then the Setup Check |
| A9 | Do not start the live bot (P-8.3) for a new user. It needs the owner's explicit approval |

---

## B. What you need (FREE vs OPTIONAL PAID)

| # | Item | Cost | Needed for | Without it |
|---|---|---|---|---|
| 1 | GitHub account | FREE | the program runs here | nothing works |
| 2 | Google account (personal Gmail best) | FREE | the 3 sheets + robot key | nothing works |
| 3 | Google Cloud project + robot (service account) | FREE (no billing needed for the Sheets API) | the program reads/writes your sheets | nothing works |
| 4 | Telegram app + a bot (BotFather) | FREE | reports on your phone, /analyze, /exit | reports only in the sheets; no phone commands |
| 5 | Cloudflare account + Worker (relay) | FREE | timers (nightly, My Options) + phone commands | you start every run by hand in GitHub |
| 6 | Gemini key (Google AI Studio) | FREE tier | AI text in reports (only when you ask) | required by the key check today (`ops/apiKeys.ts:14`); AI parts empty |
| 7 | FMP key (financialmodelingprep) | FREE tier (~250 calls/day; check at signup) | fundamentals | required today; fundamentals missing |
| 8 | Alpha Vantage key | FREE tier (~25 calls/day; check at signup) | backup prices / data | required today |
| 9 | Finnhub key | FREE tier (~60 calls/min; check at signup) | quotes, series | required today |
| 10 | SEC contact email | FREE (any email you read) | SEC filings (the SEC asks for a contact) | SEC data refused |
| 11 | Keyless sources: FRED, SEC, FINRA, CBOE, Yahoo, Nasdaq | FREE, no account | prices, options, dark pool, macro | — |
| P1 | Anthropic key (Claude Opus) | PAID (pay per use) | the second AI review | Gemini only. The owner runs without it too |
| P2 | FMP paid plan | PAID | more calls, more fundamentals | some fundamentals skipped on big watchlists |
| P3 | More GitHub minutes (or GitHub Pro) | PAID | more than ~2,000 min/month | runs stop until the 1st of next month |
| P4 | IBKR account | PAID (money in the account; fees per trade) | the $1,000 live bot | the bot only writes practice plans |
| P5 | A server for the IBKR gateway (if IBKR's web API is not used) | PAID (small cloud server) | live bot sending orders | as P4 |

---

## C. Names you will type (copy exactly)

### C1. GitHub secrets (Settings → Secrets and variables → Actions → **Secrets**)

| Secret name | Value | From step |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the WHOLE robot key file (JSON) | P-2.1 |
| `SPREADSHEET_ID` | ID of your **My Portfolio** sheet | P-4 |
| `REPORTS_SPREADSHEET_ID` | ID of your **Reports** sheet (leave unset today: see P-4) | P-4 |
| `DATA_SPREADSHEET_ID` | ID of your **Data** sheet (leave unset today) | P-4 |
| `FMP_API_KEY` | FMP key | P-2.3 |
| `ALPHAVANTAGE_KEY` | Alpha Vantage key | P-2.4 |
| `FINNHUB_KEY` | Finnhub key | P-2.5 |
| `GEMINI_API_KEY` | Gemini key | P-2.2 |
| `SEC_CONTACT_EMAIL` | your email | P-2.6 |
| `TELEGRAM_BOT_TOKEN` | bot key from BotFather | P-2.7 |
| `TELEGRAM_CHAT_ID` | your chat number | P-6.1 |
| `TELEGRAM_WEBHOOK_SECRET` | a random text you make (P-2.8) | P-2.8 |
| `ANTHROPIC_API_KEY` | OPTIONAL, paid | P-8.1 |

### C2. Cloudflare Worker secrets (Worker → Settings → Variables and Secrets, type **Secret**)

| Name | Value | Same as GitHub secret |
|---|---|---|
| `BOT_TOKEN` | bot key | `TELEGRAM_BOT_TOKEN` |
| `ALLOWED_CHAT_ID` | chat number | `TELEGRAM_CHAT_ID` |
| `WEBHOOK_SECRET` | random text | `TELEGRAM_WEBHOOK_SECRET` |
| `GITHUB_TOKEN` | fine-grained GitHub token (P-2.9) | — (Cloudflare only) |
| `TICKERS` (type **Text**, not secret) | your /analyze buttons, e.g. `AAPL,MSFT,KO` | — |
| `REPO` (type **Text**, required) | `yourname/yourrepo` | — |

### C3. Sheet and tab names

| Sheet (your name for it) | Tabs you create | The program creates the rest |
|---|---|---|
| My Portfolio | `Portfolio`, `🎯 Watchlist`, `📒 Transactions` | yes, on the first run |
| Reports | none | yes |
| Data | none | yes |

---

## D. Phases

Each step: **Do** → **You should see** → **✅ Check** → **If it fails**.

### P-1 Accounts (about 30 min, all FREE)

| Step | Do (web) | Phone app difference | You should see | ✅ Check | If it fails |
|---|---|---|---|---|---|
| 1.1 GitHub | github.com → **Sign up** → email, password, username → verify email | GitHub app: sign up works; later steps need the browser | your profile page | you can open github.com/yourname | use another username; check spam for the code |
| 1.2 Your copy of the program | open the core repo you were invited to → **Use this template** → **Create a new repository** → Owner: you → name `TradingAnalyzer` → **Private** → **Create** | not in the app: use the phone browser, "Desktop site" on | your own private repo with folders `backend`, `relay`, `.github` | repo page shows 🔒 Private | no "Use this template" button = the owner has not shared it yet |
| 1.3 Turn on Actions | your repo → **Actions** tab → if asked, **I understand my workflows, go ahead and enable them** | browser | a list of workflows (Nightly, Analyze, CI, ...) | the list is there | Settings → Actions → General → **Allow all actions** → Save |
| 1.4 Google | use your Gmail (a work account may block robot keys) | — | — | you can open sheets.google.com | create a new personal Gmail |
| 1.5 Telegram | install Telegram, sign up with your phone | — | chats list | you can search `@BotFather` | update the app |
| 1.6 Cloudflare | dash.cloudflare.com → **Sign up** → email, password → verify | browser only | the Cloudflare dashboard | you see **Workers & Pages** in the left menu | check spam; the free plan needs no card |

### P-2 Keys (about 40 min)

Keep each key in a safe place on YOUR device only until P-3 (a password manager is best). Never send it in chat or email.

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 2.1 Google robot | a) console.cloud.google.com → top bar project picker → **New Project** → name `trading-analyzer` → **Create** → select it. b) ☰ → **APIs & Services** → **Library** → search `Google Sheets API` → **Enable**. c) ☰ → **IAM & Admin** → **Service Accounts** → **Create service account** → name `trading-robot` → **Create and continue** → skip roles → **Done**. d) click `trading-robot` → **Keys** → **Add key** → **Create new key** → **JSON** → **Create**. A file downloads | a `.json` file; the robot's email like `trading-robot@trading-analyzer.iam.gserviceaccount.com` | the file opens as text and starts with `{"type": "service_account"` | "key creation disabled" = work account policy → use a personal Gmail. Desktop browser strongly advised |
| 2.2 Gemini | aistudio.google.com → **Get API key** → **Create API key** → pick `trading-analyzer` → copy | a key starting `AIza` | it is shown once in the list | region not supported → OPTIONAL: leave it; AI parts stay empty (today the key check still lists it missing) |
| 2.3 FMP | financialmodelingprep.com → **Sign up** (free) → Dashboard → copy **API Key** | a long letters/digits key | shown on the dashboard | verify email first |
| 2.4 Alpha Vantage | alphavantage.co → **Get free API key** → fill form → copy | a short key | shown on the page | write it down at once (the page does not email it) |
| 2.5 Finnhub | finnhub.io → **Get free API key** / Register → Dashboard → copy | a key | shown on the dashboard | verify email |
| 2.6 SEC email | choose a real email you read | — | — | — |
| 2.7 Telegram bot | Telegram → search `@BotFather` → **Start** → send `/newbot` → a name (e.g. `My Trading`) → a username ending in `bot` (e.g. `my_trading_123_bot`) → copy the token | a message "Use this token to access the HTTP API: 123456789:AA..." | the token has a `:` in it | "username taken" → try another |
| 2.8 Webhook secret | make a random text, 32-64 letters and digits only (a password manager "generate", letters+digits, no symbols) | — | only `A-Z a-z 0-9` | symbols may be refused by Telegram |
| 2.9 GitHub token (for the relay) | github.com → your photo → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token** → name `trading-relay` → Expiration: 1 year (put a calendar reminder) → Repository access: **Only select repositories** → your repo → Permissions → Repository → **Actions: Read and write** → **Generate** → copy | a token starting `github_pat_` | shown once | lost it → generate a new one |

### P-3 Save keys in GitHub (about 15 min)

| Step | Do | Phone | You should see | ✅ Check | If it fails |
|---|---|---|---|---|---|
| 3.1 Open the screen | your repo → **Settings** → **Secrets and variables** → **Actions** → tab **Secrets** | the GitHub app cannot do this: phone browser, "Desktop site" | "Repository secrets" list | — | no Settings tab = you are not the repo owner |
| 3.2 Add each secret | **New repository secret** → Name (exact, C1) → Secret (paste) → **Add secret**. Repeat for every C1 row you have so far | — | the name in the list; the value is never shown again | all names from C1 (except chat id and the optional ones) are listed | a typo in a NAME = the program will not find it: delete and add again |
| 3.3 Robot key | for `GOOGLE_SERVICE_ACCOUNT_JSON` open the `.json` file in a text editor → select all → copy → paste the WHOLE thing | phone: open the file in a text app, select all | — | — | pasted only part → delete and paste again |
| 3.4 Clean up | delete the downloaded `.json` from Downloads (keep one copy in your password manager) | — | — | — | — |

**after P5** (one repo, many users): the owner creates a GitHub **Environment** named your user id and you add the same names there instead (Settings → Environments → your id → Add secret).

### P-4 Sheets (about 20 min)

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 4.1 Make the sheet | Google Sheets → **Blank** → name it `My Portfolio`. One sheet is enough: a new user runs in one-sheet mode (the 3-sheet split is optional later, the owner's Migrate workflow) | your sheet in Google Drive | — | — |
| 4.2 Tabs and headers | do 4.4 and 4.6 first. Then: **Terminal / AI session**: `cd backend && npm run init-user-sheets` (with the secrets in `.env`). **GitHub (after P5)**: Actions → **Init user sheets** → Run. It adds `Portfolio` (stock table, options table, CLOSED section, headers only), `🎯 Watchlist` (your profile's starting list) and an empty `💾 Script Properties`. It never touches a tab that exists | "✅ Portfolio: added", "✅ 🎯 Watchlist: added", "✅ 💾 Script Properties: added" | run it again: "Nothing to do" | "could not open the sheet" = not shared with the robot (4.4) or wrong ID (4.5) |
| 4.3 Fill in | `Portfolio`: one row per holding under the stock header (`type` = `stock` or `crypto`; `Purchase Date` = the day you bought, empty = an assumed date); options rows under OPEN positions. `🎯 Watchlist`: one ticker per row from A2. `📒 Transactions` is made by the first run | your rows | `type` is `stock` or `crypto` on each holding row | a missing header = "The Portfolio sheet could not be read" in the report |
| 4.4 Share with the robot | each sheet → **Share** → paste the robot email (P-2.1) → role **Editor** → untick "Notify" → **Share** | the robot listed as Editor | — | "can't share outside organisation" = work account → use personal Gmail |
| 4.5 Copy the IDs | the ID is the part of the address between `/d/` and `/edit` | a ~44-character text | — | do not copy the whole address |
| 4.6 Save the ID | GitHub secret `SPREADSHEET_ID` = My Portfolio ID. Do NOT set `REPORTS_SPREADSHEET_ID` / `DATA_SPREADSHEET_ID` for a new user (empty = everything on My Portfolio) | — | Setup Check: SPREADSHEET_ID ✅ | set by mistake → harmless: without the move flag on My Portfolio everything still goes to My Portfolio (`app/sheetsStorage.ts`) |
| 4.7 Profile | **after P2/P7**: fill the `⚙️ Profile` tab: your list (1-30 tickers), tax rate (e.g. `0.25`), time zone (e.g. `Europe/London`), features on/off | — | Setup Check shows "Profile ✅" | Setup Check names the bad cell |

### P-5 Relay and timers (about 20 min, Cloudflare)

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 5.1 Create the Worker | Cloudflare → **Workers & Pages** → **Create** → **Create Worker** (Hello World) → name `trading-relay` → **Deploy** | an address like `https://trading-relay.yourname.workers.dev` | opening it shows "Hello World" | — |
| 5.2 Paste the code | **Edit code** → delete everything → paste the whole file `relay/telegram-relay.worker.mjs` from your repo → **Deploy** (your repo and buttons are the `REPO` and `TICKERS` settings, P-5.3; both required) | "Deployed" | opening the address shows the relay version (e.g. `2026-10-29.2`) | paste error → paste again, whole file |
| 5.3 Secrets | Worker → **Settings** → **Variables and Secrets** → **Add** → type **Secret** → each C2 secret row. `TICKERS` as type **Text** | names listed | 4 secrets + `TICKERS` | a name typo → delete, add again |
| 5.4 Timers | Worker → **Settings** → **Triggers** (or **Trigger events**) → **Add** → **Cron Triggers** → add each: `23 3 * * *`, `5 21 * * *`, `5 22 * * *` | 3 cron lines | all 3 listed | free-plan limit reached → remove unused triggers on other Workers |
| 5.5 Timer meaning | 03:23 UTC = nightly after the US close; 21:05 / 22:05 UTC = My Options (only one acts, by US summer/winter time) | — | — | a timer at any other time sends "matches no job" to Telegram → fix the cron text |

**after P6** (shared relay): you skip P-5; the owner adds your chat to the relay's `USERS` list.

### P-6 Telegram (about 10 min). ORDER MATTERS: 6.1 before 6.2

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 6.1 Find your chat number | Telegram → open your bot → **Start** → send `hi`. GitHub → repo → **Actions** → **Telegram Check** → **Run workflow** → **Run workflow** | the bot replies with your chat number and "save it as TELEGRAM_CHAT_ID" | — | "no chat found" → send the bot a message again, rerun. If the webhook is already set, the number cannot be found: ask an AI session to clear it, or use the number from an earlier reply |
| 6.1b Save it | GitHub secret `TELEGRAM_CHAT_ID` = the number; Cloudflare secret `ALLOWED_CHAT_ID` = the same number | — | run **Telegram Check** again → bot says "✅ Trading Analyzer is connected" | still finding → the secret name is wrong |
| 6.2 Connect the bot to the relay | GitHub → **Actions** → **Telegram Setup** → **Run workflow** → relay address from P-5.1 (`https://trading-relay.yourname.workers.dev`) → **Run workflow** | green ✅ run | send `/help` to the bot → the list of commands comes back | no reply → `WEBHOOK_SECRET` (Cloudflare) ≠ `TELEGRAM_WEBHOOK_SECRET` (GitHub); fix and rerun 6.2 |

### P-7 First run and Setup Check (about 15 min + one night)

| Step | Do | You should see | ✅ Check | If it fails |
|---|---|---|---|---|
| 7.1 Setup Check | **Terminal / AI session**: `cd backend && npm run setup-check`. **GitHub (after P5)**: Actions → **Setup Check** → Run | a table: one row per key, ✅ / ❌ / ➖ (not needed) + one plain fix. No key values shown | all ✅ (optional items may show ➖) | follow the row's fix, rerun |
| 7.2 One stock | send `/analyze AAPL` to the bot (or Actions → **Analyze** → ticker `AAPL` → Run) | "⏳ Analysing AAPL… about 3 min", then a message + PDF; new tabs in your sheet | the PDF arrives; `📋 Bottom Line` tab exists | red ❌ run → open it → the failed step's last lines name the missing secret or sheet problem |
| 7.3 Exit report | send `/exit` | a PDF of your holdings | your holdings are listed | "could not be read" → headers in P-4.3 |
| 7.4 First nightly | wait for 03:23 UTC, or Actions → **Nightly** → Run (leave "typecheck and tests" off) | next morning: one summary table + Buy PDF + Exit PDF in Telegram | the run is green ✅ | ❌ → send the run link to the owner or an AI session |
| 7.5 Minutes | GitHub → your photo → **Settings** → **Billing and plans** → Actions usage | about 5 min per night | under ~500 a month | near 2,000 → fewer manual runs; never turn CI on automatically |

Setup Check table (after P7), rows it must have:

| Row | Test it makes (no value printed) |
|---|---|
| Google robot | parses the JSON, gets a token |
| My Portfolio / Reports / Data | opens each sheet, reads the tab list, writes+deletes a cell on `⚙️ Smoke Test` (My Portfolio) |
| Portfolio / Watchlist headers | finds the header rows |
| Profile | validates `⚙️ Profile` |
| FMP / Alpha Vantage / Finnhub / Gemini | one cheap request each |
| SEC email | one EDGAR request with it |
| Telegram bot + chat | getMe + a test message |
| Relay | GET the relay address → version |
| Anthropic (optional) | ➖ if absent, ✅ if a 1-token request works |

### P-8 Optional paid items

| Step | Item | Do | What you gain | Without it |
|---|---|---|---|---|
| 8.1 | Anthropic (Opus) | console.anthropic.com → billing → **API keys** → create → GitHub secret `ANTHROPIC_API_KEY` | the second AI review (Opus) in AI Dispatch | Gemini review only |
| 8.2 | FMP paid | upgrade on FMP; same key | fewer skipped fundamentals | free limits |
| 8.3 | IBKR live bot | **owner approval first** (the core owner decides). IBKR account (cash, not margin) + its own account number in `LIVE_IBKR_ACCOUNT` + profile `features.liveBot` | real orders under the long-only rails | practice plans only (`💵 Live Log`) |
| 8.4 | Server for IBKR | only if IBKR's web API cannot run in GitHub (live-broker phase 0) | the gateway the bot talks to | as 8.3 |
| 8.5 | GitHub minutes | Settings → Billing → set a spending limit, or GitHub Pro | more runs a month | runs stop until the 1st |

---

## E. Rules (everyone)

| Rule | Why |
|---|---|
| Keys only in GitHub Secrets and Cloudflare secrets | anything else can leak |
| Never paste a key in chat, email, a sheet, a commit, an issue | same |
| If a key leaks: make a new one at its site, replace the secret, delete the old one | the old one stops working |
| Long-only: long stock and long calls only. No puts, shorts, writing calls, margin | built into the program; no setting changes it |
| AI runs only when you ask (AI Dispatch, or /analyze with AI) | cost and control |
| CI is by hand only | free minutes |
| A report is information, not advice | the program has no proven edge (owner research) |

## F. Common failures

| You see | Cause | Fix |
|---|---|---|
| `sheets mode needs GOOGLE_SERVICE_ACCOUNT_JSON and SPREADSHEET_ID` | secret missing or misnamed | P-3.2 |
| `permission denied (403) on spreadsheet` | sheet not shared with the robot | P-4.4 |
| `spreadsheet not found (404)` | whole address pasted, not the ID | P-4.5 |
| `Missing keys: FMP_API_KEY, ...` | data keys missing | P-2, P-3 |
| Telegram silent after `/help` | webhook secret mismatch or relay not deployed | P-5.2, P-6.2 |
| "⚠️ ... could not be started" in Telegram | relay `GITHUB_TOKEN` expired or wrong repo | P-2.9 new token; P-5.2 `REPO` |
| "spending limit / payments failed" annotation | free minutes used up | wait for the 1st, or P-8.5 |
