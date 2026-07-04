# Steward P0 — S1–S12 Mock Baseline (2026-07-04)

> Environment: isolated worktree sandbox (`OPENALICE_HOME`/`AQ_LAUNCHER_ROOT`
> pinned inside the worktree, ports remapped to 48331/48332/48333/6173),
> `mock-simulator` preset account, driven entirely from the terminal via the
> `alice-uta` CLI + the human HTTP push route + the `/api/simulator` fixture
> routes, per docs/terminal-runbook.md. Account left flat; stack torn down.
> This document records the baseline honestly, including scenario results the
> mock fixture cannot fully exercise — those gaps are themselves P0 findings.

## Scenario results

| # | Scenario | Result | Evidence / notes |
|---|---|---|---|
| S1 | Read-state agreement | **PASS** | Fresh account: netLiq 100000, unrealizedPnL 0 == empty positions sum; portfolio rows carry `secType`+`aliceId` |
| S2 | Simple lifecycle | **PASS** | LMT BUY staged→committed→human HTTP push→`mark-price` auto-match→`[sync] AAPL filled` commit appeared within one poller pass; `order trades` shows execution (2 @ 100.2, value 200.4); position visible; later sold back |
| S3 | Hanger stability | **PASS** | Deep LMT @90 stayed `Submitted` across 45s (3+ poller passes), no spurious transitions; cancel recorded |
| S4 | Amendment | **PASS** | `order modify` price 90→91 AND qty 1→2 applied under the SAME orderId (`mock-ord-1`) |
| S5 | Attached TP/SL | **FINDING (fixture)** | Mock accepted `--takeProfit/--stopLoss` at stage, push reported success, entry filled — and **no protective leg ever appeared in open orders**: the exact "silent unprotected position" failure S5 exists to catch, exhibited by the mock broker itself. Mock must either implement bracket legs or refuse tpsl loudly |
| S6 | Standalone stop | **PASS** | SELL STP trigger 80 accepted, tracked `Submitted` across passes, cancelled through Alice |
| S7 | External order observation | **PARTIAL (fixture gap)** | Simulator has `external-trade` (instant fill) but no way to inject an external **pending order**, so the `[observed]`-commit path is not rehearsable on mock. External fill did reflect in venue-truth positions; no narrative commit appeared within a 75s window at `observeExternalOrdersEvery=1m` |
| S8 | Restart survival | **PARTIAL (fixture limit + PASS on config)** | Account config + trading git history + tsx-watch restart all survive UTA restart (account reconnected, `utas: 4`). But MockBroker state is in-memory: the venue itself forgets open orders across restart. Alice correctly reported the venue truth (empty list — "never trust the ledger over the venue") and conservatively left history at `submitted` rather than mis-terminaling; cancel of the vanished order was rejected with a clear error |
| S9 | Partial close | **PASS** | `position close --qty 1` on the 2-share STK position left exactly 1; full close flattened; account returned to netLiq 100000 / realized 0 |
| S10 | Notional entry | **FINDING (fixture)** | `--cashQty 300` MKT reported `filled` success but filled **quantity 0**, produced no trade record, cash unchanged — a silent no-op with a success status. Violates the refuse-loudly principle |
| S11 | Error ergonomics | **PASS** | Bad aliceId → "Expected format: accountId\|nativeKey"; unknown `--source` → lists available accounts; modify of nonexistent id staged (git layer is venue-agnostic) and was rejected at push with "Order mock-ord-9999 not found or not pending" — all actionable |
| S12 | Staging undo | **PASS** | stage→commit→`awaitingApproval`→`git reject --reason` → status clean, history shows `[rejected]` with reason, op status `user-rejected` |

Steward-relevant observation: every write path exercised above stopped at
`nextStep: "Awaiting user approval"` until the human HTTP push route was
called — the approval gate held throughout the whole session (the live
counterpart of regression group 1/2 below).

## Regression spec coverage (the other half of P0)

| Group | Status | Where |
|---|---|---|
| 1. AI push gate (`allowAiTrading=false` → tool never pushes) | covered by existing | `src/tool/trading.spec.ts:218-252` (also asserts fail-closed on missing flag getter) |
| 2. Human-only push route | added | `services/uta/src/http/trading-order-entry.spec.ts` — in-process Hono asserts POST `/uta/:id/wallet/push` invokes `push()` and sibling wallet-git routes do not. (One-shot manual routes `place-order`/`close-position`/`cancel-order` intentionally push; already spec'd) |
| 3. readOnly enforcement | partially covered + **gap found** | Stage refusal + keyless⟹readOnly covered in `UnifiedTradingAccount.spec.ts:27-48`. **Gap: commit/push do not call `_assertWritable()` in production code** — needs a production change, out of P0 scope → follow-up issue |
| 4. TradingGit commit persistence | added | `TradingGit.spec.ts:539-604` — JSON round-trip of the persisted export: head/hash/parentHash/thesis/operations/results/stateAfter (incl. rehydrated position quantities)/timestamp |
| 5. Guard pipeline on execute path | added | `UnifiedTradingAccount.spec.ts:1010-1052` — MaxPositionSize and Cooldown rejections at push with no broker `placeOrder()`; SymbolWhitelist push-path wiring pre-existed at `:981-1008` |

## Incidents & environment findings (recorded, with follow-ups)

1. **`.sandbox-home`/`.sandbox-ws` were not gitignored** — an agent tidying
   untracked files (`git clean`) deleted the live sandbox mid-run, including
   `data/config/` and `sealing.key`. Fixed in this PR (.gitignore). The
   drift-checker excludes gained these dirs in PR #8; the ignore file had
   been missed.
2. **Guardian's restart-flag watcher dies silently if `data/control/` is
   deleted while running** — after the wipe, manually recreated flag files
   were never consumed; `POST /uta` config mutations logged "UTA did not
   come back" and the new account was never loaded until a full stack
   restart. Watcher should re-arm (or recreate the dir) → follow-up issue.
3. **Mock fixture gaps** (S5 tpsl legs, S10 cashQty silent no-op, S7 external
   pending-order injection missing) → follow-up issue; these limit how much
   of the catalog is rehearsable offline, which matters for every later
   steward phase that wants pre-live verification.
4. Data-quality nit: `orderState.commissionAndFees` serializes
   `Number.MAX_VALUE` (1.797e308) as an "unset" sentinel in push results.
5. Unexplained (not chased): after overwriting `trading.json` with a minimal
   `{"observeExternalOrdersEvery":"1m"}` and restarting UTA, the mock AAPL
   position row reported `secType: "CRYPTO"` (was `STK`). May be an artifact
   of the crude config overwrite; re-verify before relying on mock secType.

## Reproduction sketch

```bash
cd .worktrees/issue-N && export OPENALICE_HOME=$PWD/.sandbox-home AQ_LAUNCHER_ROOT=$PWD/.sandbox-ws
OPENALICE_WEB_PORT=48331 OPENALICE_MCP_PORT=48332 OPENALICE_UTA_PORT=48333 OPENALICE_UI_PORT=6173 pnpm dev &
curl -X POST :48331/api/trading/config/uta -d '{"presetId":"mock-simulator"}'   # account
curl -X POST :48331/api/workspaces -d '{"tag":"x","template":"chat","agents":["shell"]}'  # WS_ID for CLI
export OPENALICE_TOOL_URL=http://127.0.0.1:48332/cli AQ_WS_ID=<ws> ; node src/workspaces/cli/bin/alice-uta ...
curl -X POST :48331/api/trading/uta/<id>/wallet/push          # the human approval stand-in
curl -X POST :48331/api/simulator/uta/<id>/mark-price ...     # drive fills
```
