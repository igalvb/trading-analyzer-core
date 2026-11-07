# The phone dashboard (optional, free)

A private web page for your phone (and desktop) that shows what the runs wrote to your sheets: Net worth (from your
ledger: see "Net worth, growth graph, editing" below), Overview, Portfolio
(every holding, crypto included), Exit, Buy, Paper test, History (sold and closed positions), Analyze, Options,
Models, Runs, Actions and Settings, with search and filters. It is hosted on **your own Cloudflare Pages** (free),
behind a **Cloudflare Access** sign-in (only your email gets in), and refreshed at the end of every Nightly,
Analyze, Exit Report, Send Exit and My Options run. Its buttons start GitHub runs (Analyze, Exit report, Nightly,
My Options, Setup Check); Claude's paper orders are not a button (Claude places those).

The Paper tab also lists **🤖 Claude ideas**: Claude's recommendations with no money (BUY / WAIT / AVOID / SELL, entry
zone, stop, target, horizon, reason, open or closed), from the reports tab `🤖 Claude Ideas`. Claude adds a row with
`npm run claude-idea -- <TICKER> [stock|call] <BUY|WAIT|AVOID|SELL> "<zone>" <stop> <target> "<horizon>" "<reason>"`
(`-` = none; a bad row is refused with one line). The Status cell starts `open`; edit it to `closed: <outcome>` by
hand. When tonight's close is known the dashboard shows where the price is against the zone.

Nothing here is needed for the reports: without the two Cloudflare secrets the runs skip the dashboard step silently.

| Part | Where | What it does |
|---|---|---|
| Data | `backend/src/dashboard/data.ts` | builds ONE file, `data/dashboard.json`, by READING the tabs (no fetch, no sheet write). No key, no sheet id in it |
| App | `backend/dashboard/index.html` | the page (copied as it is); loads `./data/dashboard.json` from the same site |
| Run buttons | `backend/dashboard/functions/api/run.js` | a Cloudflare Pages Function: checks your Access email, a strict list of runs, then asks GitHub to start the run |
| Ledger edits | `backend/dashboard/functions/api/edit.js` | a Cloudflare Pages Function: checks your Access email and every field, then commits the change to your ledger on the private `data` branch |
| Build | `npm run dashboard-build -- --out out/dashboard` | writes the site folder |
| Upload | the step "Publish the dashboard" (5 workflows) and the **Dashboard** workflow | `wrangler pages deploy` (pinned version) |

Cost: $0 (Cloudflare Pages and Access free plans). Each publishing run uses about 1 more GitHub minute (the
upload tool is downloaded each time), about 40-60 minutes a month with a daily Nightly. Without the secrets the
step takes about a second.

## One-time setup (about 20 minutes, desktop browser)

Do the steps in this order: the Pages project must exist before its settings (C) and its Access app (D).

### A. Cloudflare account

You already have one if you made the Telegram relay (SETUP_GUIDE P-6). Otherwise: dash.cloudflare.com → **Sign up**
(free). Then copy your **Account ID**: dash.cloudflare.com → **Workers & Pages** → the right column shows
**Account ID** → **Copy** (or: any page → the account menu → **Account home** → the `⋯` next to your account → **Copy
account ID**).

The Pages project itself: **let the Dashboard workflow make it** (step E does it on its first run, named
`trading-dashboard`). If you prefer to make it by hand: **Workers & Pages** → **Create** → **Pages** tab →
**Use direct upload** (or "Upload assets") → Project name `trading-dashboard` → **Create project** → close the upload
page without uploading (the workflow uploads). A different name: set the repository variable `DASHBOARD_PROJECT`
(GitHub → your repo → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository
variable**).

### B. The Cloudflare API token, and two GitHub secrets

1. dash.cloudflare.com → top right person icon → **My Profile** → **API Tokens** → **Create Token** → **Custom token**
   → **Get started**.
2. Token name: `trading-dashboard upload`. **Permissions**: `Account` · `Cloudflare Pages` · `Edit`. **Account
   Resources**: `Include` · your account. Leave the rest. **Continue to summary** → **Create Token** → **Copy** (shown
   once).
3. GitHub → your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = the token you just copied
   - `CLOUDFLARE_ACCOUNT_ID` = the Account ID from A

### C. The Run buttons: three settings on the Pages project

The buttons need a GitHub token that may start runs. Use the **same fine-grained token as the Telegram relay**
(SETUP_GUIDE P-6: repository access = only this repo; permission **Actions: Read and write**). Or make a new one:
github.com → your photo → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained
tokens** → **Generate new token** → Repository access **Only select repositories** → this repo → Permissions →
Repository permissions → **Actions: Read and write** → **Generate token** → copy.

Cloudflare → **Workers & Pages** → `trading-dashboard` → **Settings** → **Variables and Secrets** (Production) →
**Add**:

| Type | Name | Value |
|---|---|---|
| Secret | `GITHUB_TOKEN` | the fine-grained token |
| Text | `REPO` | `your-github-name/your-repo-name` |
| Text | `ALLOWED_EMAILS` | the email you sign in with in step D (several: comma between) |

**The edit screens** (Net worth → Add / edit) use the same `GITHUB_TOKEN` and need ONE more permission on the same
token: github.com → your photo → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained
tokens** → the token → **Edit** → Repository permissions → **Contents: Read and write** (keep **Actions: Read and
write**) → **Update**. The repository stays the only one the token can reach. Without it the edit screens answer "the
token was refused (check GITHUB_TOKEN: Contents read and write on this repository)"; the rest of the page works.

**Save**. A setting takes effect on the NEXT upload: run the Dashboard workflow again after this step (E).
Without these the page still works; the buttons answer "not set up".

### D. The sign-in: Cloudflare Access (only you get in)

1. dash.cloudflare.com → **Zero Trust** (left menu). The first time: pick a team name (any) and the **Free** plan
   (up to 50 users). Cloudflare may ask for a card for the free plan; it is not charged.
2. **Access** → **Applications** → **Add an application** → **Self-hosted**.
3. Application name `Trading dashboard`. Session duration `1 month` (fewer sign-ins on the phone).
4. **Public hostname** / Application domain: `trading-dashboard.pages.dev` (your project name + `.pages.dev`). Add a
   second hostname `*.trading-dashboard.pages.dev` (the per-upload preview addresses).
5. **Policies** → **Add a policy**: name `Only me`, Action **Allow**, Include → **Emails** → your email. Save.
6. **Login methods**: **One-time PIN** (a code to your email; nothing to set up) and/or **Google** (Settings →
   Authentication → Login methods → Add new → Google, follow its steps). Save the application.

Shortcut that protects the preview addresses only: Pages project → **Settings** → **General** → **Access policy** →
**Enable**. That does NOT cover `trading-dashboard.pages.dev` itself, so step D above is still needed.

### E. First publish, then the phone

1. GitHub → **Actions** → **Dashboard** → **Run workflow** → green **Run workflow**. About 2 minutes. The run's
   **Summary** shows the address. Run it again after step C (settings take effect on the next upload).
2. On the phone: open `https://trading-dashboard.pages.dev` → sign in (email code or Google) → you see the Overview.
3. iPhone (Safari): **Share** → **Add to Home Screen** → **Add**. Android (Chrome): menu `⋮` → **Add to Home screen**
   (or **Install app**). It opens full screen, like an app.
4. ✅ Check: the top line says "Data as of <day, time> NY"; Settings → Data → "Sections missing" lists only tabs you
   do not have yet (for example `history` with no closed positions).

From now on the five report runs refresh it at their end. A failed upload never fails a run (the step is
`continue-on-error`); the run log shows why.

## Net worth, growth graph, editing

Your holdings and assets live in a **ledger** on the repository's private `data` branch (format:
`backend/src/ledger/schema.ts`): `ledger/holdings.json` (stocks, bitcoin funds, crypto, calls, closed positions),
`ledger/assets.json` (pension, other funds, real estate with its mortgage, cash), `ledger/watchlist.json`,
`ledger/flows.jsonl` (money in / out), `ledger/snapshots.jsonl` (one line per night), `ledger/edits.jsonl` (every
dashboard edit) and, when present, `ledger/targets.json` (your ratio targets). The dashboard build reads it from a
checked-out `data` branch (`DATA_BRANCH_DIR`, default `<repo>/data-branch`); without it the two sections `networth` and
`growth` are left out (Settings → Data → "Sections missing") and the page opens on the Overview.

**Net worth** (the first tab): everything you own, by group (Stocks · Bitcoin funds · Crypto · Calls · Pension · Other
funds · Real estate · Cash) with a bar each, the group totals and the grand total, in **$ or ₪** (the toggle; the rate
is the day's USD/ILS of the newest snapshot). Stocks, crypto and calls are priced live from the Portfolio section
(tonight's close, else the Exit report's, else the sheet's); a price you typed (`manualPrice`) wins. Names are shown
exactly as you wrote them (Hebrew too, right-to-left). Pension, funds, real estate and cash show the date you last
typed the value: **amber when older than 90 days**. Real estate counts net (value − mortgage); each property row shows
value · mortgage · net. **Debt is shown apart**: the top cards are **Net worth = Assets − Debts**, Assets (gross:
markets + pension & funds + real estate's value + cash) and Debts (mortgages + other debts, negative); an item whose
value is 0 and debt above 0 (a loan line, whatever its group) is a **Debt** line of its own in "Everything you own",
not part of Cash. Display only: the net worth and the group totals of the snapshots are the same numbers
(`netBalance` in `backend/src/ledger/networth.ts`; the page carries a copy, a test holds them equal). A debt line's
amount is changed in `assets.json` for now (the edit screens change property mortgages only). Also on the screen: a
pie of what you own by group (real estate net; debt lines left out) and a pie of the market part by your own sub-types (tap a slice or a row: only
that one), the totals block in $ and ₪ (portfolio, pension, study and savings funds, real estate, debt, total savings
with assets; per person when an asset has a `person`), and the ratio cards from `ledger/targets.json` (a name `A/B` is
a price over a price, `A bag/B` your whole holding of A over B's price; the card shows today's ratio as a % of your
target; no file, no cards).

**Growth graph**: one line per night from `ledger/snapshots.jsonl`, starting on the migration day (no older history;
with fewer than two nights it says "the graph starts filling from <day>"). Filter chips per group (tap to add or take
away; **only** or a long press: only that group), Stacked or Lines, ranges 1M · 3M · YTD · 1Y · 5Y · All, two sliders
for any window, $ or ₪. **Money in / out** marks: ▲ in, ▼ out on the day, hollow while a run only suggests it; tap a
mark (or its chip under the graph) for the date, amount, group and note, and to confirm or dismiss a suggestion.

**Growth without deposits** (the dashed line): the value minus the net money put in since the first day shown:

    without deposits (day) = value (day) − sum of money in / out dated after the first day shown, up to that day

So a deposit lifts the value but not this line, and a withdrawal does not pull it down; only the markets (and your
value updates) move it. A flow counts on its own day (that night's snapshot holds it); a weekend flow counts on the
next night shown. Suggested flows count only once confirmed. A dollar flow is turned into shekels at the rate of its
day. Picked over a time-weighted index because it stays in money (the same scale as the value) and is easy to check by
hand; `withoutFlows` in `backend/src/ledger/networth.ts` is the definition, tested, and the page carries an identical
copy (a test holds the two equal).

**Editing from the phone** (Net worth → **+ Add / edit**, or tap any item): add, change, sell or remove a stock, coin
or call; update a pension, fund or property value (and the mortgage) with its date; add money in / out; confirm or
dismiss a suggested flow; edit the Buy watchlist. Each edit: a form (checked as you go) → a confirm sheet ("This saves
to your ledger: …") → **Save**. The page POSTs `{kind, file, item}` to `/api/edit`; the function:

1. refuses anything but a same-site POST of JSON (8 KB at most) from an email in `ALLOWED_EMAILS` (Cloudflare
   Access's header), like the Run buttons;
2. checks every field per kind (tickers, numbers and their bounds, dates, the group, text length; unknown fields
   refused); only `holdings.json` (add / change / sell / remove / lot), `assets.json` (add / change / remove), `flows.jsonl`
   (add, confirm, dismiss: a new line with the same id) and `watchlist.json` can be edited;
3. reads the head of `data`, applies the change, and writes the file AND a line in `ledger/edits.jsonl` in ONE commit
   ("ledger: <kind> <id> by dashboard"; git data API: blobs, tree, commit, then the branch moves only if no one else
   moved it; if a run committed in between, it starts again once from the new head).

The page then says "Saved ✓ — the dashboard updates after the next run" and shows the change at once. A sale moves the
sold part to the CLOSED positions with its cost and proceeds. **Lots** (additive 2026-11-07): a stock, bitcoin fund or coin's detail
shows its dated purchase lots (date, quantity, price, gain per lot, days held) and the undated rest (priced so the
total cost stays quantity x average cost); **Add a lot** / ✕ send `kind: 'lot'` with `{op: 'add', id, date, qty,
price, note?}` (the lots may not hold more than the quantity) or `{op: 'remove', id, index, date, qty, price}` (the
lot's place AND its numbers, so a stale page is refused). A change keeps the lots (and refuses a quantity below them);
a sale shrinks the lots that no longer fit, earliest first. A rest whose implied price is negative or absurd shows no
price and a "To check" line (docs/LEDGER.md "Dated purchase lots"). Settings needed: `GITHUB_TOKEN` with **Contents: Read
and write** (step C), `REPO`, `ALLOWED_EMAILS`; optional `TIME_ZONE` (the day written in `updated`, default New York).

## What was not verified here, and the fallback

These could not be tried from the build machine (no Cloudflare account there); they follow Cloudflare's documented
behaviour:

| Item | If it does not work |
|---|---|
| Access on `<project>.pages.dev` (step D) | put the site on your own domain: Pages project → **Custom domains** → **Set up a domain** (a domain already on Cloudflare), make the Access application for that domain, and keep `ALLOWED_EMAILS` set: the Run buttons refuse any request without Access's email header, so an unprotected address can show the page but never start a run |
| Access passing `Cf-Access-Authenticated-User-Email` to the Pages Function | the buttons answer "Not allowed." Check the Access application covers the exact address you open; sign out and in again |
| `wrangler pages project create` making the project on the first run | make it by hand (A, "Use direct upload"), then run Dashboard again |
| The phone's home-screen icon | it is drawn by the build (`apple-touch-icon.png`); an old icon can stay cached by the phone: remove and add again |

Security notes: the data file and the page carry no key and no sheet id; the Run function accepts only the six runs
in its list, only from the site itself, only for an email in `ALLOWED_EMAILS`, and never shows the GitHub token; the
Edit function writes only the four ledger files above, after the same checks, and never shows the token either. The
page sends `no-store` for `data/*` so a phone never shows yesterday's numbers from its cache.

## Locally (optional)

```bash
cd backend
npm run dashboard-build -- --out out/dashboard                 # reads your sheets (needs the .env of SETUP_GUIDE)
npm run dashboard-build -- --out out/dashboard --data fake.json # or any JSON file, to look at the page
npx --yes http-server out/dashboard -p 8080                     # then open http://localhost:8080 (buttons need Cloudflare)
```
