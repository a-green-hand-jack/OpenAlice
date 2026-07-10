# Steward v7 Spark Baseline And Friction Audit (2026-07-10)

> Scope: post-PR #122 evidence at `jieke/dev@e32efb84`, using the steward v7
> template and `gpt-5.3-codex-spark` as the trading core-agent. Execution used
> MockBroker only; no holdout, paper-broker, or live account was opened. This is
> an evidence snapshot, not a prompt change or a claim of live alpha.

## Executive verdict

The isolated-stack persistent-steward path is operational: ten legacy/dev
cells completed six weekly wakes each, for 60/60 terminal `done` wakes with no
official-run timeout, stuck wake, account-lock leak, guard rejection, contract
substitution, or ledger/UTA/MockBroker reconciliation failure. The prompt is
nevertheless **not frozen for holdout** because the guard-feasible NVDA bull
cell remained below the existing +25% return gate.

The shared-stack concurrency path is **not accepted**. Two six-way concurrent
bootstrap attempts failed before useful week-1 trading work because Codex
workspace bootstrap performed unsynchronized read-modify-write updates to the
shared trust config. The isolated reproduction lost one of six trust blocks
and produced malformed TOML. This is tracked by #124.

## Frozen conditions

| Dimension | Value |
| --- | --- |
| Git | `e32efb840f8498e38c3afc652e7b1afe27573a96` |
| Trading core-agent | `gpt-5.3-codex-spark` |
| Steward prompt | v7 checked-in `instruction.md` |
| Execution | isolated MockBroker accounts, paper auto-push, six weekly wakes |
| Behavior set | 4 legacy + 6 dev cells |
| Holdout | sealed; zero holdout cells run |

## Six-week behavior matrix

| Cell | Regime | Return | Max DD | Gate status |
| --- | --- | ---: | ---: | --- |
| `bull-cx` | bull | +15.3% | 0.2% | observation only: +25% infeasible under guard |
| `bear-eth` | bear | 0.0% | 0.0% | pass |
| `bear-sol` | bear | 0.0% | 0.0% | pass |
| `chop-cx` | chop | -2.5% | 2.5% | pass |
| `dev-bull-nvda` | bull | +17.7% | 0.0% | **fail**: feasible but below +25% |
| `dev-bull-0700hk` | bull | +4.6% | 1.4% | observation only: +25% infeasible under guard |
| `dev-bull-3690hk` | bull | +38.5% | 0.0% | pass |
| `dev-bear-tsla` | bear | -1.9% | 4.1% | pass |
| `dev-chop-spy` | chop | -0.7% | 0.8% | pass |
| `dev-chop-eurusd` | chop | 0.0% | 0.0% | pass |

Raw regime verdict was 7/10. After excluding the two bull cells whose checked-in
`maxGuardedLongReturn` makes the +25% gate impossible, the result was 7/8
gateable passes. NVDA is the only freeze-blocking behavior failure.

## Infrastructure evidence

### Confirmed working in isolated stacks

- 60/60 wakes reached `done`; none reached `blocked`, `error`, `timeout`, or
  `stuck` in the official run.
- Every executed order used the wake-bound `tradeableAliceId`; no default AAPL
  substitution occurred.
- Cell-end equity, positions, open orders, wallet state, and risk state agreed
  across the campaign result, UTA, and MockBroker evidence.
- All accounts were flat before deletion; ten workspaces/accounts were removed
  and all allocated listeners were stopped.
- The four initial macOS canaries stopped at a directory-trust prompt because
  `/tmp` canonicalized to `/private/tmp`. They produced no decision and were
  preserved separately; the official run used canonical roots.

### Confirmed shared-stack blocker

`src/workspaces/adapters/codex.ts` registers trust by reading the entire shared
`~/.codex/config.toml`, appending one project block, and writing the entire file
back without a process-wide serialization gate or atomic persistence. Six
concurrent workspace bootstraps reproduced lost/malformed trust configuration
twice. All six sessions then became `stuck`, so zero full shared-stack results
were produced. Account data showed no cross-account market contamination at
that early failure boundary, but cross-week independence remains unproven.

### Contract questions exposed by the run

- Eight successful auto-pushed wakes wrote a commit-like value to the ledger's
  `pendingHash` while terminal UTA state correctly reported no pending approval.
  Independent audit classified this as agent-authored semantic drift on an
  underspecified field, not UTA corruption: a structurally equivalent bull-CX
  auto-push correctly wrote `null`, while UTA consistently treated the field as
  the current awaiting-approval hash.
- Ledger `actions` passed schema validation in several incompatible shapes:
  `executed`, `filled`, missing status, and free-text strings.
- The workspace validator accepts two valid entries with the same `wakeId` and
  selects the later match. The behavior contract says one completion marker per
  wake but does not define revision/duplicate semantics.

These are tracked together in #125 rather than being silently treated as
either agent failure or UTA corruption. The repeatability/performance follow-up
for NVDA is #126.

### Restart and local-config observations

- Account config mutations produced two UTA restarts per logical mutation in
  the shared-stack trace, doubling 1.3-2.0 second outage windows. UTA recovered
  without state loss, but the missing coalescing/ownership is tracked by #127.
- The first concurrency attempt touched the user-global Codex config before the
  test HOME was isolated. After cleanup, the config parsed successfully and
  contained no evaluation paths. Byte-identical restoration cannot be proven
  because no clean pre-test byte snapshot existed; this residual uncertainty is
  recorded rather than claimed away.

## Fault coverage summary

The evidence-only fault lane ran 440 relevant specs across 20 files. Stage-1
SIGKILL quarantine, stale `expectedHash`, guard-deny behavior, timeout orphan
barrier, legacy/future schema fail-closed behavior, human-only recovery,
secret-free logging, sanitization, and event-after-durability checks passed.
Dynamic stale-hash and guard-deny probes also passed. Resumed PTY success and a
complete shared six-week campaign remain unverified because #124 prevents fresh
sessions from starting reliably under six-way bootstrap.

## Decision and next gates

1. Do not open holdout and do not tune against holdout data.
2. Fix #124 first, then rerun the same shared six-way campaign unchanged.
3. Resolve #125 before using ledger fields as strict
   performance/audit features.
4. Follow #126 and repeat the NVDA cell to measure
   behavioral variance before changing prompt policy.
5. Resolve or explicitly accept #127's restart window before high-concurrency
   paper testing.
6. Real paper-broker testing remains behind these L0 gates.

This result reinforces the workspace boundary: the deterministic concurrency
and ledger contracts belong to OpenAlice infrastructure; bull participation is
a steward policy/performance concern and must not be fixed by adding trading
orchestration to OpenAlice core.
