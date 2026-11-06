# The phone dashboard (optional, free)

A private web page for your phone (and desktop) that shows what the runs wrote to your sheets: Overview, Portfolio
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
in its list, only from the site itself, only for an email in `ALLOWED_EMAILS`, and never shows the GitHub token. The
page sends `no-store` for `data/*` so a phone never shows yesterday's numbers from its cache.

## Locally (optional)

```bash
cd backend
npm run dashboard-build -- --out out/dashboard                 # reads your sheets (needs the .env of SETUP_GUIDE)
npm run dashboard-build -- --out out/dashboard --data fake.json # or any JSON file, to look at the page
npx --yes http-server out/dashboard -p 8080                     # then open http://localhost:8080 (buttons need Cloudflare)
```
