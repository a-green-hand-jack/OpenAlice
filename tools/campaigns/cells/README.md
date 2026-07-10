# Steward Campaign Cells

These cells are checked-in, anonymized historical-market windows for
`tools/campaigns/run-cell.mjs`. They are not synthetic random walks: each cell
comes from a real historical OHLCV window, then gets rebased to day-0 close =
100 and stripped of real dates before the agent sees it.

The real symbol/date provenance remains under each cell's `_provenance` field
for orchestrator audit only. `run-cell.mjs` passes only the anonymized codename,
visible-to-date bars, and a coarse `assetClassHint` into the blind steward wake.

## Splits

- `dev-*`: use for prompt / behavior iteration.
- `holdout-*`: keep out of tuning loops; run only after a candidate behavior
  change is frozen.
- Legacy `bull-cx` / `bear-*` / `chop-cx`: original crypto smoke set kept for
  continuity with prior reports.

## Current Matrix

| Split | Regime | Cell | Source audit | Why it exists |
| --- | --- | --- | --- | --- |
| legacy | bull | `bull-cx.json` | BTCUSDT, 2024-02-05..2024-03-05 | Original crypto bull under-participation benchmark |
| legacy | bear | `bear-eth.json` | ETHUSDT, 2026-01-26..2026-02-24 | Original crypto bear defense benchmark |
| legacy | bear | `bear-sol.json` | SOLUSDT, 2025-01-26..2025-02-24 | Second crypto bear defense benchmark |
| legacy | chop | `chop-cx.json` | BTCUSDT, 2024-11-27..2024-12-26 | Original crypto chop over-trading benchmark |
| dev | bull | `dev-bull-nvda.json` | NVDA, 2022-12-27..2023-02-08 | US single-name trend participation |
| dev | bull | `dev-bull-0700hk.json` | 0700.HK, 2022-11-03..2022-12-14 | HK equity trend observation; +25% target is infeasible under 60% max-position guard |
| dev | bull | `dev-bull-3690hk.json` | 3690.HK, 2024-08-22..2024-10-07 | Guard-feasible HK equity trend participation |
| dev | bear | `dev-bear-tsla.json` | TSLA, 2022-11-18..2023-01-03 | US single-name crash defense |
| dev | chop | `dev-chop-spy.json` | SPY, 2023-07-06..2023-08-16 | Broad US market low-volatility chop |
| dev | chop | `dev-chop-eurusd.json` | EURUSD=X, 2024-05-31..2024-07-11 | FX range discipline; data/research first |
| holdout | bull | `holdout-bull-amd.json` | AMD, 2026-03-30..2026-05-11 | High-beta US single-name trend holdout |
| holdout | bull | `holdout-bull-2330tw.json` | 2330.TW, 2022-10-25..2022-12-05 | Taiwan equity trend holdout |
| holdout | bear | `holdout-bear-tqqq.json` | TQQQ, 2025-02-24..2025-04-04 | Leveraged ETF drawdown holdout |
| holdout | bear | `holdout-bear-crude.json` | CL=F, 2026-05-19..2026-07-01 | Commodity proxy drawdown holdout |
| holdout | chop | `holdout-chop-gld.json` | GLD, 2024-01-10..2024-02-22 | Gold proxy chop holdout |
| holdout | chop | `holdout-chop-usdjpy.json` | USDJPY=X, 2024-06-07..2024-07-18 | FX range holdout |

## Use

Run one cell:

```bash
PATH=/home/user/.nvm/versions/node/v22.23.1/bin:$PATH \
node tools/campaigns/run-cell.mjs \
  --base http://127.0.0.1:49731 \
  --cookie 'alice_session=...' \
  --cell tools/campaigns/cells/dev-bull-nvda.json \
  --agent codex \
  --model gpt-5.3-codex-spark \
  --run-id perf-dev-bull-nvda
```

For tuning, run the `dev-*` cells first and keep the `holdout-*` set untouched
until the proposed behavior change is frozen.

Bull cells should also be checked against `maxGuardedLongReturn` in the report.
If the +25% bull target is infeasible under the configured max-position guard,
use that cell for behavior observation only, not as a hard PASS/FAIL gate.
