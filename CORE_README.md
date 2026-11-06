# Trading Analyzer (core)

A stock analysis program for one person's list of stocks: it reads your Google Sheet, runs the analysis on GitHub
Actions (Node 24, TypeScript, in `backend/`), writes the report tabs back to your sheets and sends a short message
plus a PDF to your Telegram. Long-only: long stock and long calls; no puts, shorts, writing calls or margin.

A report is information, not advice.

Version: see [VERSION](VERSION) and [CHANGELOG.md](CHANGELOG.md).

## Start here

| You are | Read |
|---|---|
| Anyone, before starting | [docs/PREREQUISITES.md](docs/PREREQUISITES.md): accounts, devices, time, free vs paid, checklist, secrets worksheet |
| A new user (no programming needed) | [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md): accounts, keys, sheets, relay, first run, step by step |
| A user after setup | [docs/USER_MANUAL.md](docs/USER_MANUAL.md): what runs when, Telegram commands, the reports, fixing problems, updates |
| An AI coding session | docs/SETUP_GUIDE.md section A first, then the two files above |

## Map

| Item | One line |
|---|---|
| `backend/` | The program: source (`src/`), tests (`test/`), the frozen Apps Script oracle (`legacy/`) and its price fixtures |
| `backend/src/profile/` | Your settings (the `⚙️ Profile` tab): your list, tax rate, time zone, features. `example.ts` is a made-up user |
| `.github/workflows/` | The GitHub Actions runs (nightly, analyze, exit, My Options, AI, setup checks). All started by hand or by the relay |
| `relay/` | The Cloudflare Worker: Telegram commands and the timers. Settings `REPO` and `TICKERS` are required |
| `VERSION`, `CHANGELOG.md` | The core's version (MAJOR.MINOR.PATCH) and what each release changed |
| `core-manifest.json` | Which files are the core (see "Core and overlay" below) |

## The program (`backend/`)

Node 24, TypeScript run directly (`node file.ts`), no build step.

| Command | Does |
|---|---|
| `npm run typecheck` | type check |
| `npm test` | the test suite, as the made-up test profile (`test/testProfileEnv.ts`); no keys needed |
| `npm run setup-check` | checks your keys, sheets, profile and bot (no value printed) |
| `npm run init-user-sheets` | adds the starting tabs to your My Portfolio sheet |

```
cd backend && npm ci && npm run typecheck && npm test
```

There is no built-in profile: a run without a Profile tab (or `PROFILE_FILE` / `PROFILE_JSON`) refuses with one line.

`legacy/` is the frozen Apps Script oracle the parity tests run against: do not edit it. Its price fixtures are real
daily bars; some stocks carry made-up tickers (`AQZA` ...), the market references keep their names (SPY, QQQ, SMH,
IBIT, the VIX and the spot-bitcoin ETFs).

Secrets: `backend/.env.example` lists the names. Local runs read `.env` (git-ignored); GitHub runs read repository
secrets.

## Core and overlay

The core is the files `core-manifest.json` marks core. A copy may keep private files next to them (an overlay); the
core files stay the same, byte for byte, in every copy, so an update is a plain copy:

| Overlay item (optional) | Effect |
|---|---|
| `backend/src/owner/profile.ts` (exports `OWNER_PROFILE_INPUT`) | a built-in profile: used when a run sets no `PROFILE_JSON` / `PROFILE_FILE`; the workflows then skip the default user's Profile tab read |
| `backend/src/owner/results/` | the default results folder (`RESULTS_DIR` wins) |
| `backend/test/overlay/` | the copy's own tests; they run with the built-in profile, not the test profile |

| Command | Does |
|---|---|
| `npm run export-core -- --out DIR` | copies the core files out (nothing changed on the way), then scans the copy for keys and private data |
| `npm run import-core -- <core checkout> [--dry-run]` | brings a core release in: new and changed core files written, removed ones deleted, overlay never touched; prints the version change |

## Rules

| Rule | Why |
|---|---|
| Keys only in GitHub Secrets and Cloudflare secrets | anything else can leak |
| Never paste a key in chat, email, a sheet, a commit or an issue | same |
| AI runs only when you ask | cost and control |
| CI is by hand only | free minutes |
