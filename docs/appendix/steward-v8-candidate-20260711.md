# Steward v8 Candidate Canonical Matrix

> Status: canonical legacy/dev evidence snapshot, 2026-07-11.
>
> This records the final issue #126 validation before the Ubuntu OpenAlice
> development freeze. It is evidence for consolidation, not a claim that the
> participation policy solved every performance gap or that holdout/live testing
> is approved.

## Scope And Provenance

- Exact tested HEAD: `e27efdb653e09a19c005d20a867638d146695927` on
  `feat/issue-126-v8-participation-policy`.
- Core agent: Codex, `gpt-5.3-codex-spark`.
- Execution: MockBroker with isolated `OPENALICE_HOME`, `AQ_LAUNCHER_ROOT`,
  and `HOME`; real `~/.openalice` and `~/.codex/config.toml` were not touched.
- Matrix: 10 legacy/dev cells, 6 wakes each, strictly serial. Holdout remained
  sealed.
- Durable report: issue #126 comment
  <https://github.com/a-green-hand-jack/OpenAlice/issues/126#issuecomment-4943203075>.
- Local evidence: `/tmp/openalice-steward-eval-20260711-v8matrix7/`.

The canonical run was the fourth full attempt. The first three attempts were
invalidated by real infrastructure defects rather than reused as model evidence:

| Attempt     | Hard stop                                                                            | Resulting fix             |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------- |
| `v8matrix4` | MockBroker reported `cashQty` orders as executed zero-share fills                    | #137                      |
| `v8matrix5` | A completed decision was bound to a different wakeId while the active wake timed out | #139                      |
| `v8matrix6` | Supervisor sampled a truncate/rewrite window as `entry_missing`                      | #140 plus runtime refresh |
| `v8matrix7` | First complete trustworthy matrix                                                    | Canonical evidence below  |

## Results

All 10 cells were `trustworthy: true` and `audit.valid: true`: 60/60 wakes
completed, ledger wake sets were equal, every v2 self-reference matched, all
finalize gates passed, steward warnings were empty, and per-cell cleanup left
zero workspaces or accounts. Process cleanup was observed by the operator but
was not written into the per-cell result schema, so it is not claimed as a
machine-verifiable matrix field.

| Cell              | Regime | Return | Agent maxDD | Raw verdict                               | v7 baseline              |
| ----------------- | ------ | -----: | ----------: | ----------------------------------------- | ------------------------ |
| `bull-cx`         | bull   | +17.1% |        0.3% | observation only, guard-infeasible target | +15.3%, observation only |
| `bear-eth`        | bear   |   0.0% |        0.0% | pass                                      | pass                     |
| `bear-sol`        | bear   |   0.0% |        0.0% | pass                                      | pass                     |
| `chop-cx`         | chop   |  -2.5% |        2.5% | pass                                      | pass                     |
| `dev-bull-nvda`   | bull   | +20.7% |        0.0% | fail, feasible but below +25%             | +17.7%, same fail class  |
| `dev-bull-0700hk` | bull   |  +2.6% |        1.1% | observation only, guard-infeasible target | observation only         |
| `dev-bull-3690hk` | bull   | +42.9% |        0.0% | pass                                      | +38.5%, pass             |
| `dev-bear-tsla`   | bear   |  -2.9% |        2.9% | pass                                      | pass                     |
| `dev-chop-spy`    | chop   |  -0.6% |        1.3% | pass                                      | pass                     |
| `dev-chop-eurusd` | chop   |   0.0% |        0.0% | pass                                      | pass                     |

Raw verdict was 7/10. Excluding the two bull cells whose +25% target is not
feasible under the configured guard, the gateable result was **7/8**, identical
to v7. `dev-bull-nvda` remained the only gateable failure.

## What The Candidate Changed

The v8 participation levers did not materially change the verdict surface:

- Every cell retained the same pass/fail/observation-only class as v7.
- Final bear/chop verdicts and drawdowns stayed within their gates, but this was
  partly because deterministic guards rejected unsafe intents. At least
  `bull-cx`, `dev-bull-3690hk`, and `dev-chop-spy` attempted roughly 70%
  exposure before the test account's 60% max-position guard denied the add.
- NVDA improved from +17.7% to +20.7% in the canonical row, but four isolated v8
  observations remained below +25%.
- `dev-bull-3690hk` improved from +38.5% to +42.9%, but this did not establish a
  general policy improvement.

The honest conclusion is therefore: the current deterministic guard and audit
regime contained the candidate, but the prompt itself is not safe to generalize
to an account with no max-position guard. It also did **not** close the stable
NVDA under-participation gap.

## Infrastructure Load Acceptance

The clean matrix is strong acceptance evidence for the infrastructure fixes
that preceded it:

- **#134**: zero ledger receipt/integrity violations across 60 wakes.
- **#136**: no wake stuck behind the write-then-validate finalize barrier.
- **#137**: `cashQty` produced genuine non-zero fractional fills and later
  position closes with real PnL effects.
- **#139**: every ledger entry's top-level wakeId matched its own evidence
  self-reference; the prior impersonation pattern did not recur.
- **#140**: no transient `entry_missing` recurrence; draft-to-ledger atomic
  commit and existing-workspace runtime refresh held across the matrix.

These results validate the runtime protocol under this isolated serial load.
They do not validate shared-stack cleanup/restart concurrency, real broker
semantics, news/fundamental context, multi-asset allocation, or live trading.

## Maintainer Decision

On 2026-07-11 the maintainer chose to merge the architecture, experiment record,
and runtime evidence into `jieke/dev` as a consolidation point, then freeze
current Ubuntu OpenAlice development and reconsider the next direction from a
fresh handoff. Independent merge review blocked activating the participation
candidate in the default instruction because accounts may have no
`max-position-size` guard.

This merge means:

- the candidate is preserved on its experiment branch/commit and documented in
  the integration branch, but is not enabled by default;
- issue #126's experiment is complete enough to close;
- the NVDA performance gap remains documented rather than represented as fixed;
- holdout remains sealed and no paper/live promotion follows from this result.
