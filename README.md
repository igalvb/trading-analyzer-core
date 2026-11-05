# Trading Analyzer (core)

A stock analysis program for one person's list of stocks: it reads your Google Sheet, runs the analysis on GitHub
Actions (Node 24, TypeScript, in `backend/`), writes the report tabs back to your sheets and sends a short message
plus a PDF to your Telegram. Long-only: long stock and long calls; no puts, shorts, writing calls or margin.

A report is information, not advice.

## Start here

| You are | Read |
|---|---|
| A new user (no programming needed) | [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md): accounts, keys, sheets, relay, first run |
| An AI coding session | docs/SETUP_GUIDE.md section A first |

## Map

| Item | One line |
|---|---|
| `backend/` | The program: source (`src/`), tests (`test/`), the frozen Apps Script oracle (`legacy/`) and its price fixtures |
| `backend/src/profile/` | Your settings (the `⚙️ Profile` tab): your list, tax rate, time zone, features. `example.ts` is a made-up user |
| `.github/workflows/` | The GitHub Actions runs (nightly, analyze, exit, My Options, AI, setup checks). All started by hand or by the relay |
| `relay/` | The Cloudflare Worker: Telegram commands and the timers. Settings `REPO` and `TICKERS` are required |

## Local checks (no keys needed)

```
cd backend && npm ci && npm run typecheck && npm test
```

The tests run as a made-up test profile (`backend/test/testProfileEnv.ts`). There is no built-in profile: a run
without a Profile tab (or `PROFILE_FILE` / `PROFILE_JSON`) refuses with one line.

## Rules

| Rule | Why |
|---|---|
| Keys only in GitHub Secrets and Cloudflare secrets | anything else can leak |
| Never paste a key in chat, email, a sheet, a commit or an issue | same |
| AI runs only when you ask | cost and control |
| CI is by hand only | free minutes |
