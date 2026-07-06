# Paper multi-market campaign — 4-cell pilot results (confirmation point B)

> 2026-07-06. Pilot per [steward-p3-campaign.zh.md](../steward-p3-campaign.zh.md) §4.2/§4.4.
> Purpose: validate the harness + get a behavioral preview before scaling to the full 12 cells.
> Status: **harness validated; awaiting maintainer decision (confirmation point B) on H1 framing + equity-data sourcing.**

## Setup

- **Foundation** (all merged this session): #51/#52 (UTA-port auth), #55/#58 (Alice web-port session gate), P3-4a/#61 (paper auto-push), #62/#63 (MockBroker multi-instrument). The agent surface is the closed-both-doors, auto-push-enabled paper stack.
- **Framing**: neutral steward (maintainer's choice) — the agent is told only that it manages a conservative paper portfolio; it sees its account state + an anonymized daily-close series; NO hint whether the market is favorable.
- **Data**: real crypto history (Binance daily klines), anonymized per §4.3 — neutral symbol `ASSET-A`, prices normalized so day-0 = 100, fictional day index. (Equity markets US/HK/SG are NOT fetchable in the sandbox — Yahoo/Stooq blocked — so the pilot is crypto-only; see Decisions.)
- **Cadence**: 6 decision periods/cell, 5 daily bars each (30 bars). Start cash 100,000. Auto-push executes agent commits on the paper account. Each cell: fresh account + workspace, torn down after.

## Results

| Cell | Regime | Agent return | Buy-hold | Agent maxDD | Buy-hold maxDD | H1 (ret/BH) | H2 (DD/BH-DD) |
|---|---|---|---|---|---|---|---|
| 1 | bull (ETH) | **+10.7%** | +68.9% | **0.0%** | 3.8% | 16% | 0% |
| 2 | bear (ETH) | **0.0%** | −41.6% | **0.0%** | 45.5% | n/a | 0% |
| 3 | chop (BTC) | −0.6% | −0.2% | 0.6% | 8.4% | n/a | 7% |
| 4 | bull (BTC) | **+3.6%** | +50.4% | **0.1%** | 6.6% | 7% | 1% |

(H1 target ≥50%; H2 target ≤60%. Lower H2 = better capital protection.)

## Behavioral read

**One consistent profile: an extreme capital-preserver.**

- **H2 (protect capital in bad markets) — decisive PASS.** In the −42% crash the agent read the downtrend ("violent drawdown… failed bounce… capital protection wins") and **held cash the entire way down → 0% loss, 0% drawdown** vs −41.6% / 45.5% benchmark. Across all four cells its drawdown never exceeded 0.6% — it essentially never took a loss. This is exactly the "行情不好的时候实现止损" behavior the campaign was built to test.
- **H1 (participate in good markets) — FAILS.** In the two bull windows it captured only 16% and 7% of buy-hold. It does make money (+10.7%, +3.6%) but under-participates massively: cautious/late entry, small size (~15–25% deployed), tight trailing stops that cap upside.

**Craft quality is high and consistent**: coherent theses (trend, momentum, breakout, extension), always a protective stop, stops trailed up to lock gains, and zero unauthorized-execution attempts (every trade went through the paper auto-push path). Run-to-run entry timing varies (bull entries at wk1/wk3/wk4 across runs) but the conservative character is stable.

**Interpretation**: with pure neutral framing + "conservative by default," the agent's genuine disposition is capital preservation over participation. That's not a bug — it's the cleanest read of its discipline, which is what neutral framing was chosen to expose. But it means **H1 as currently defined is structurally unreachable** for this agent/framing.

## §4.3 residual-risk declaration

Symbols/prices/dates were anonymized. Residual risk (acknowledged in §4.3): the price *shape* of a famous window could still be recognized. The pilot is therefore a **behavioral-discipline** evaluation (does it stop-loss, size prudently, stay out of crashes), NOT an alpha evaluation — consistent with how H1/H2 are defined (relative to buy-hold, not absolute prediction skill).

## Decisions for maintainer (confirmation point B)

1. **H1 framing/threshold.** The neutral-steward agent is a near-pure capital-preserver (great H2, weak H1). Options: (a) accept the profile and keep H1 as-is (it will "fail" by design — that's a finding, not an error); (b) lower H1's threshold to match a conservative mandate; (c) shift to "steward + explicit mandate" framing (adds "grow in favorable conditions") to test whether it *can* participate more when told to. This shapes what the full 12-cell run measures.
2. **Equity data for the full run.** US/HK/SG history isn't reachable in the sandbox. To honor the market-diversity goal, the full run needs a working equity provider (a keyed source like Alpha Vantage, or fixing OpenBB config). Until then the campaign can only cover crypto.
3. **Scale to 12?** Given (1)+(2), decide whether to scale now (crypto-only, 12 crypto windows) or resolve framing + equity data first.

Harness scripts: `scratchpad/campaign/{data,pilot}.mjs` (orchestrator-side, not in `src/` per I6). Raw results: `pilot-results.json`.
