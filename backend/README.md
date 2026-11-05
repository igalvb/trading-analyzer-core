# backend

The program. Node 24, TypeScript run directly (`node file.ts`), no build step.

| Command | Does |
|---|---|
| `npm run typecheck` | type check |
| `npm test` | the test suite, as the made-up test profile (`test/testProfileEnv.ts`) |
| `npm run setup-check` | checks your keys, sheets, profile and bot (no value printed) |
| `npm run init-user-sheets` | adds the starting tabs to your My Portfolio sheet |

`legacy/` is the frozen Apps Script oracle the parity tests run against: do not edit it. Its price fixtures are
real daily bars; the stocks are named with made-up tickers (`ZQ..`) except the market references (SPY, QQQ,
SMH, IBIT, the VIX and the spot-bitcoin ETFs).

Secrets: `.env.example` lists the names. Local runs read `.env` (git-ignored); GitHub runs read repository secrets.
