# Prerequisites: everything to have BEFORE you start

Tables, short lines. Checked against the code on 6 Nov 2026.
For: a person who does not program, OR a fresh AI session with no context.
Next: [SETUP_GUIDE.md](SETUP_GUIDE.md) (the setup, step by step), then [USER_MANUAL.md](USER_MANUAL.md) (daily use).

## 1. The short answer: "Can I just give someone the core repo?"

| Question | Answer |
|---|---|
| Is the repo enough? | No. The repo is only the program. It runs in the person's OWN accounts with their OWN keys: GitHub, Google, Telegram, Cloudflare and 4 free data/AI services |
| What do you (the core owner) give? | the template (the separate core repo) or a zip (§6), and these 3 documents (they are in the repo, folder `docs/`). Never access to the private repo you run yourself (§6 "Sharing safely") |
| What does the person do? | make the accounts (§2), collect the keys (§8), follow SETUP_GUIDE (about 3 hours + one night) |
| Does the person see your data? | No. The core repo has no owner data: no sheets, no keys, no lists. Their copy talks only to their own sheets and their own Telegram |
| Does it cost money? | No, if they stay on the free tiers (§5). Optional paid: Claude Opus per use, FMP paid plan, extra GitHub minutes |
| Can an AI session do the setup for them? | It can guide every step and read the screens they describe. It must never receive a key: the person pastes keys into GitHub and Cloudflare themselves |

## 2. Accounts

| # | Account | Cost | What it is for | Sign up at | Card needed? | Notes |
|---|---|---|---|---|---|---|
| 1 | GitHub | FREE | your copy of the program; the runs (GitHub Actions) | github.com | no | email + password + username; an email code |
| 2 | Google (Gmail) | FREE | 3 Google Sheets + the robot key (Google Cloud) | accounts.google.com | no | use a PERSONAL Gmail: work and school accounts often block robot keys and sharing outside the organisation |
| 3 | Google Cloud | FREE | the robot (service account) that edits your sheets | console.cloud.google.com (same Google login) | no | no billing account needed for the Sheets API |
| 4 | Telegram | FREE | the reports on your phone; commands | the Telegram app (phone number) | no | the bot is made inside Telegram with @BotFather |
| 5 | Cloudflare | FREE | the relay: Telegram commands and the timers | dash.cloudflare.com | no | free Workers plan |
| 6 | FMP (Financial Modeling Prep) | FREE tier | fundamentals | financialmodelingprep.com | no | email check |
| 7 | Alpha Vantage | FREE tier | backup prices and data | alphavantage.co | no | the key is shown once on the page, not emailed |
| 8 | Finnhub | FREE tier | quotes and series | finnhub.io | no | email check |
| 9 | Gemini (Google AI Studio) | FREE tier | AI text in /analyze and /exit | aistudio.google.com (same Google login) | no | some countries are not supported: then skip it. Free-tier prompts may be used by Google to improve its products |
| P1 | Anthropic (Claude Opus) | PAID, optional | the "+ Opus" second opinion, `/exit opus`, the /verify diagnosis | console.anthropic.com | yes (prepaid credit) | set a monthly spend limit (§5) |
| P2 | FMP paid plan | PAID, optional | more calls on a big list | financialmodelingprep.com | yes | same key |

Also needed, no account: an email address you read (the SEC asks every program for a contact), and a password manager (strongly advised) to keep the keys.

## 3. Devices

| Step | Phone OK? | Desktop or laptop browser needed? |
|---|---|---|
| Telegram, the bot (BotFather), daily use | yes (the Telegram app) | no |
| GitHub sign-up, "Use this template" | yes, with the phone browser in **Desktop site** mode | easier on desktop |
| GitHub secrets (Settings → Secrets) | hard: the GitHub app cannot do it; phone browser in Desktop site mode | YES, advised |
| Google Cloud robot key (download the JSON, copy it whole) | very hard | YES |
| Google Sheets: make tabs, type headers | possible in the Sheets app | easier on desktop |
| Cloudflare Worker: paste the code, settings, cron triggers | very hard | YES |
| Daily editing of Portfolio, Watchlist, Profile | yes (Sheets app) | — |
| Running a workflow by hand | yes (phone browser) | — |
| Setup Check and Init user sheets | yes (phone browser, GitHub Actions buttons) | — (a terminal is only an alternative) |

## 4. Time per phase

| Phase (SETUP_GUIDE) | What | Time |
|---|---|---|
| P-1 | accounts and your copy of the program | 30-45 min |
| P-2 | the keys (robot, Gemini, FMP, Alpha Vantage, Finnhub, bot, webhook secret, GitHub token) | 40-60 min |
| P-3 | save the keys in GitHub | 15 min |
| P-4 | 3 sheets, sharing, tabs, Profile, your holdings | 30-45 min |
| P-5 | the Cloudflare relay and its 3 timers | 20 min |
| P-6 | connect Telegram | 15 min |
| P-7 | first runs (one stock, one Nightly by hand) | 30 min |
| — | wait for the first automatic night | one night |
| **Total** | | **about 3-4 hours + one night** |

## 5. FREE vs PAID, with numbers

| Item | Free allowance (check the site at sign-up: these change) | What this program uses |
|---|---|---|
| GitHub Actions, PRIVATE repo, Free plan | 2,000 minutes a month; 500 MB storage for run files | Nightly 5-30 min a night (longer for a big list); Watchdog about 1 min a day; Nightly Backup about 1 min, twice a day; My Options 1-3 min a day (+ about 1 min for GitHub's backup timer); /analyze 3-5 min each; /exit 1-4 min; /verify about 2 min; CI 15-25 min (by hand only). Each run is rounded UP to whole minutes |
| Typical month | — | about 600-1,100 minutes: inside the free 2,000 |
| Run files (PDFs, logs) | kept 30 days | a few MB a day; old ones expire by themselves |
| Cloudflare Workers Free | 100,000 requests a day; a few Cron Triggers per ACCOUNT (5 at the time of writing) | a few requests a day; 3 Cron Triggers |
| Telegram | free | — |
| Google Sheets API | free; about 60 requests a minute per robot | the program waits for the limit by itself |
| FMP free | about 250 calls a day | several calls per stock per night: keep the Watchlist + Portfolio under about 15-25 names |
| Alpha Vantage free | about 25 calls a day | backup only |
| Finnhub free | about 60 calls a minute | fine |
| Gemini free | rate limits per minute and per day | only when you ask (/analyze with AI, /exit when its AI part is empty, AI Dispatch). The Nightly uses no AI |
| Claude Opus (PAID) | — | "+ Opus" on /analyze: about $0.15. `/exit opus`: about $0.25. /verify: one Opus call (cents). AI Dispatch with Opus: per name, more with effort "high". Nothing paid runs unless you ask |
| Anthropic monthly cap | — | console.anthropic.com → **Settings** → **Limits** → set a monthly spend limit (e.g. $10). Prepaid credit: you cannot spend more than you loaded |
| FMP paid (optional) | their monthly price | only for a big list |
| GitHub minutes over 2,000 | 0 by default (runs stop until the 1st) | Settings → Billing → a spending limit above $0 to allow paid minutes |

## 6. What the OWNER of the core repo must do first

| # | Do | Why | ✅ Check |
|---|---|---|---|
| O1 | Core repo → **Settings** → **General** → tick **Template repository** | gives the green **Use this template** button | the button shows on the repo page |
| O2 | Only on the separate CORE repo (the clean export made with `npm run export-core`; no keys, no secrets, not the repo you run), and best with role **Read** (O3): invite the person: core repo → **Settings** → **Collaborators** (or **Collaborators and teams**) → **Add people** → their GitHub username. Never on your own private repo: see "Sharing safely" below | they need access to see a private repo and use the template | they accept the email invitation |
| O3 | Know the roles: a repo under a PERSONAL account has no Read-only role: every collaborator can also push. For Read only, put the core repo in a free GitHub **organization** (Settings → Danger Zone → Transfer ownership) and add the person with role **Read** | so nobody changes the core by mistake | the person's role shows **Read** |
| O4 | Send the person the core repo link and point them to `docs/PREREQUISITES.md` | — | — |
| O5 | After they made their copy you may remove their access; their copy keeps working. They need access again to update (USER_MANUAL §12) | least access | — |
| O6 | Mark each release with a branch `release/vX.Y.Z` (plus the `VERSION` file) so people can update to a known version | updates | the branch shows under **Branches** |

The 3 ways the person gets the program:

| Way | How | When |
|---|---|---|
| A. Template (best) | O1 + O2, then SETUP_GUIDE P-1.2 **Use this template** | normal |
| B. Invite, then template | same as A | — |
| C. A zip (no access to the core repo) | Owner: core repo → **Code** → **Download ZIP** → send the file. Person: install **GitHub Desktop** (desktop.github.com) → sign in → **File** → **New repository** → name `TradingAnalyzer` → **Create repository** → unzip the file INTO that folder (the folders `backend`, `relay`, `docs`, `.github` must sit at the top) → GitHub Desktop: summary `Core 1.0` → **Commit to main** → **Publish repository** → keep **Keep this code private** ticked → **Publish** | when the owner does not want to give access. The web "Upload files" page cannot do it (it takes only 100 files at a time and the program has more than 600) |

### Sharing safely

| Do | Do NOT | Why |
|---|---|---|
| Give the **template** (the separate core repo, way A) or a **zip** (way C). The person makes their own private copy and uses their own keys and their own GitHub minutes | invite people as collaborators on YOUR OWN private repo (the one with your secrets and your runs) | a collaborator with write access can start your workflows (on YOUR Actions minutes) and change the code they run with your secrets |
| Each person runs their own copy | use the several-users mode (SETUP_GUIDE G, Cloudflare `USERS`) for other people | every run in it uses the REPO OWNER's GitHub minutes; it is for your own test users only |

## 7. Printable checklist

Before you start:

- [ ] A desktop or laptop with a browser (Chrome, Edge, Firefox or Safari)
- [ ] A phone with Telegram installed
- [ ] A password manager (or a private, offline note) for the keys
- [ ] The core repo link, and the invitation accepted (or the zip)
- [ ] 3-4 free hours, in one or two sittings
- [ ] Decided: my stocks (SETUP_GUIDE P-4S "Choose your stocks"): my list of 3-30 tickers (typically 10-20) for Profile `lists.core` (and `paper.fixedUniverse`), my buy candidates for the `🎯 Watchlist` tab, and the few for the `/analyze` buttons (`TICKERS`)
- [ ] Decided: my capital-gains tax rate as a fraction (e.g. 0.25)
- [ ] Decided: my time zone (e.g. Europe/London) and a short user id for the Profile tab (e.g. jane)
- [ ] Decided: paper test on or off (on = a start date, the next trading day)
- [ ] Decided: weekly-stop exit rules on or off (USER_MANUAL §5)
- [ ] My current holdings at hand: ticker, shares, average cost, purchase date; for calls: contracts, expiry, strike, premium paid, purchase date

Accounts:

- [ ] GitHub
- [ ] Personal Google (Gmail)
- [ ] Google Cloud project `trading-analyzer` with the Google Sheets API enabled
- [ ] Telegram
- [ ] Cloudflare
- [ ] FMP
- [ ] Alpha Vantage
- [ ] Finnhub
- [ ] Gemini (Google AI Studio), or decided to skip it
- [ ] Optional: Anthropic with a monthly limit

Setup milestones (SETUP_GUIDE):

- [ ] P-1 My private copy exists and Actions are on
- [ ] P-2 All keys collected (worksheet below ticked)
- [ ] P-3 GitHub secrets saved (8 now, 4 more later)
- [ ] P-4 3 sheets shared with the robot; 3 sheet IDs saved; Profile tab filled; Init user sheets run (or 3 tabs by hand); holdings typed; P-4S stocks chosen (`lists.core` 3+, Watchlist not empty)
- [ ] P-5 Relay deployed; the page shows the version and no missing settings; 3 cron lines
- [ ] P-6 Chat number saved in GitHub and Cloudflare; `/help` answers
- [ ] P-7 Setup Check is green ("All set."); `/analyze AAPL` gave a PDF; a Nightly by hand gave 2 PDFs
- [ ] The first automatic night gave the PDFs
- [ ] Calendar reminder: renew the GitHub token in 11 months

## 8. Secrets worksheet

NEVER write the values here. Tick "done" only. Keep the values in a password manager.

| Name | Where you get it | Where it goes | Format check | Done |
|---|---|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Cloud → Service Accounts → your robot → Keys → Add key → JSON (a file downloads) | GitHub secret | the WHOLE file text; starts with `{`, has `"type": "service_account"` and `"private_key"`, ends with `}` | [ ] |
| robot email (not a secret) | same robot page | each sheet → Share → Editor | ends with `.iam.gserviceaccount.com` | [ ] |
| `SPREADSHEET_ID` | My Portfolio sheet address, between `/d/` and `/edit` | GitHub secret | about 44 characters; letters, digits, `-`, `_`; no `/` | [ ] |
| `REPORTS_SPREADSHEET_ID` | Reports sheet address, same part | GitHub secret | same; different from the other two | [ ] |
| `DATA_SPREADSHEET_ID` | Data sheet address, same part | GitHub secret | same; different from the other two | [ ] |
| `FMP_API_KEY` | FMP → Dashboard → API Key | GitHub secret | letters and digits, about 32 | [ ] |
| `ALPHAVANTAGE_KEY` | alphavantage.co → free key page | GitHub secret | about 16 capital letters and digits | [ ] |
| `FINNHUB_KEY` | Finnhub → Dashboard | GitHub secret | about 20 lower-case letters and digits | [ ] |
| `GEMINI_API_KEY` | AI Studio → Get API key | GitHub secret | starts `AIza`, 39 characters | [ ] |
| `SEC_CONTACT_EMAIL` | your own email | GitHub secret | has `@` and a dot | [ ] |
| `TELEGRAM_BOT_TOKEN` | Telegram → @BotFather → /newbot | GitHub secret AND Cloudflare `BOT_TOKEN` (Secret) | digits, one `:`, then about 35 characters | [ ] |
| `TELEGRAM_CHAT_ID` | GitHub → Actions → Telegram Check (the bot sends it) | GitHub secret AND Cloudflare `ALLOWED_CHAT_ID` (Secret) | digits only (a group would start with `-`) | [ ] |
| `TELEGRAM_WEBHOOK_SECRET` | you make it (password manager: letters + digits) | GitHub secret AND Cloudflare `WEBHOOK_SECRET` (Secret) | 32-64 letters and digits; no spaces or symbols | [ ] |
| `GITHUB_TOKEN` (relay) | GitHub → Settings → Developer settings → Fine-grained tokens; your repo only; Actions: Read and write; 1 year | Cloudflare only (Secret) | starts `github_pat_` | [ ] |
| `REPO` (not a secret) | your repo's address: `github.com/<this part>` | Cloudflare (Text) | `yourname/TradingAnalyzer`, one `/` | [ ] |
| `TICKERS` (not a secret) | your choice | Cloudflare (Text) | `AAPL,MSFT,KO,JNJ`: capitals, commas, no spaces needed | [ ] |
| `ANTHROPIC_API_KEY` (optional) | console.anthropic.com → API Keys | GitHub secret | starts `sk-ant-` | [ ] |

## 9. Safety rules

| Rule | Why |
|---|---|
| Keys only in GitHub Secrets and Cloudflare secrets | anything else can leak |
| Never send a key in chat (also not to an AI), email, a sheet, a commit or an issue | same |
| Keep your copy of the program Private | its run logs and your sheets show your holdings |
| A leaked key: make a new one at its site, replace the secret, delete the old one | the old one stops working |
| The program is long-only: long stock and long calls. No puts, shorts, writing calls or margin | built in; no setting changes it |
| A report is information, not advice | the program has no proven edge |
