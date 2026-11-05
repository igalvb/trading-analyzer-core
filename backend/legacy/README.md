# `legacy/` — the frozen port oracle

**Do not edit anything in this directory. Do not import it from `src/`.**

## What this is

Copies of the ten real Apps Script `.gs` files that constitute the system
being replaced, plus the `historical_data/` fixtures from the original
`tests/` directory.

These are **not** reference documentation. They are an **executable
oracle**: the `.gs` files load into a Node `vm` sandbox with mocked Apps
Script globals and run directly. Verified 2026-09-12 on Node v24.13.1 —
the original project's own tests do exactly this and pass
(`edwards_magee_model_test.js --selftest` → 38/38;
`schabacker_model_test.js --selftest` → 59/59).

That makes parity mechanically checkable rather than a judgement call:
load the original implementation and the TypeScript port into the same
process, feed both the same real inputs, and assert the outputs are
identical.

## Why it must stay frozen

Every parity number this project reports is only meaningful if the thing
being compared against never changed. A checksum of these files is
asserted unchanged in CI.

If a `.gs` file genuinely needs correcting, that is a finding for the
flagged-findings register — not an edit here.

## Contents

Ten `.gs` files (~19,400 lines, 379 functions), of which **291 (77%) are
pure compute** with no Apps Script I/O:

| File | Functions | Pure |
|---|---|---|
| `fullStockAnalysisV10_9.gs` | 146 | 120 |
| `dataLayerV1.gs` | 61 | 19 |
| `brokerCourseModelV1.gs` | 72 | 71 |
| `futuresStockAnalysisV3_3_11.gs` | 35 | 24 |
| `turtleModelV1.gs` | 14 | 14 |
| `darkPoolTrackerV1.gs` | 17 | 12 |
| `schabackerModelV1.gs` | 10 | 10 |
| `edwardsMageeModelV1.gs` | 11 | 11 |
| `macro_fetchers_v0_15.gs` | 7 | 6 |
| `myOptionsValueTracker.gs` | 6 | 4 |

Plus `historical_data/` — real OHLCV fixtures per ticker.

## ⚠️ Before these files are committed (DONE: the committed copies hold placeholders)

**The original `fullStockAnalysisV10_9.gs` contains four real API keys in
plaintext at lines 5311–5314** (FMP, Alpha Vantage, Finnhub, Gemini).

They **must be replaced with placeholders** before any commit. This is the
single most likely way for this migration to leak a credential.

This costs nothing: the oracle never needs real keys. Every parity test
mocks the network (see the original `tests/edwards_magee_model_test.js`
lines 19–30), and the 291 pure functions make no network calls at all.

## Excluded from the build

`legacy/` is listed in `tsconfig.json`'s `exclude`. It is never type-checked,
never compiled, and never imported by `src/`. Only test files reference it.
