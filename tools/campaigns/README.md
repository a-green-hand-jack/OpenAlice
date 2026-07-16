# Campaign tooling — steward persistent-wake backtests

Orchestrator-side eval tooling (not product code — lives outside `src/`
per the steward-plan I6 invariant). Three layers, each reusable on its own:

- **`run-cell.mjs`** — drives ONE cell through ONE arm end-to-end against a
  running dev stack (mock UTA + blind steward workspace + weekly wake
  cycles). See `cells/README.md` for the cell catalog and a standalone
  `run-cell.mjs` invocation example.
- **`report.mjs`** — renders a markdown matrix report from one or more
  completed `runs/<runId>/result.json` files.
- **`lab.mjs`** — one-command experiment matrix runner (issue #259). Owns
  the loop and the stack lifecycle; it does not reimplement `run-cell.mjs`
  or `report.mjs`, it shells out to them.

## `lab.mjs` — one-command experiment matrix

```bash
pnpm lab run experiments/<name>.json
```

(A leading `--` — `pnpm lab -- run experiments/<name>.json` — is also
tolerated: pnpm 11 passes it through to `lab.mjs`'s argv, and `parseLabArgs`
strips one leading `--` before parsing.)

Runs an unattended `arms × cells × rounds` matrix, serially:

1. **Per arm** (fresh `pnpm dev` sandbox): its own `OPENALICE_HOME` +
   `AQ_LAUNCHER_ROOT` + port block (derived from `basePort`), optional
   `AQ_TEMPLATE_OVERLAY_DIR`, `OPENALICE_TRADING_MODE=pro`. One arm = one
   stack, because template overlays are a startup snapshot
   (`TemplateRegistry.load` runs once at boot) — an overlay-variant arm
   cannot share a stack with another arm.
2. **Per cell × round within an arm** (strictly serial — deleting a mock
   UTA restarts Guardian/UTA and would reset a concurrently-running cell's
   in-memory `MockBroker` state): spawn `run-cell.mjs --keep` and record
   its exit status.
3. **After the arm's runs**: batch-delete the workspace + mock account of
   every run that succeeded via the same HTTP APIs `run-cell.mjs` uses.
   Failed runs keep everything for forensics; `summary.json` records what
   was left behind.
4. **Tear down** the stack (see below), then move to the next arm.

A `run-cell.mjs` failure marks that run failed and the arm continues to the
next round/cell. A stack-boot failure marks the WHOLE arm failed (its
planned runs are recorded `skipped`) and the experiment continues to the
next arm. After every arm, all runs that produced a `result.json` are
aggregated through the existing `report.mjs` into
`tools/campaigns/runs/<name>-report.md`, and a machine-readable
`tools/campaigns/runs/<name>/summary.json` is written.

Exit codes: `0` every run succeeded · `2` the matrix completed but at least
one run/arm failed or was skipped · `1` a runner-level fatal error (bad
config, budget exceeded, missing cell, unrecoverable stack teardown, an
operator SIGINT/SIGTERM) — `1` can happen either before any run was
attempted or mid-experiment.

### Stack teardown

Every arm's `pnpm dev` sandbox is spawned `detached: true` (its own POSIX
process group) and torn down by signaling that whole group —
`process.kill(-pid, 'SIGTERM')`, a grace period, then
`process.kill(-pid, 'SIGKILL')` — not just the top-level `pnpm` pid. This
matters because pnpm does **not** forward SIGTERM to the `tsx`/Guardian
process it spawns, so a plain `child.kill()` only killed `pnpm` itself and
orphaned the whole Guardian/UTA/Alice/Vite tree still holding the port
block (empirically reproduced against pnpm 11.9.0). "Torn down" is gated on
the arm's web port actually freeing (polled up to 30s after the SIGKILL),
never on a child `exit` event — because every arm in one experiment reuses
the *same* port block (`derivePortBlock(config.basePort)` is derived once
per experiment, not per arm), a port that never frees would silently break
every subsequent arm's boot. If the port is still bound after
SIGTERM+SIGKILL+timeout, `lab.mjs` treats that as a runner-fatal error
(exit `1`) rather than continuing into a corrupted next arm.

Stack boot itself races readiness (log markers + a live `/api/version`)
against the boot child exiting early (e.g. a port conflict) — a dead child
fails the arm immediately instead of polling for the full 240s readiness
timeout, and the failure reason recorded in `summary.json` includes the
last ~20 lines of that arm's `stack.log`.

`lab.mjs` also installs `SIGINT`/`SIGTERM` handlers: an operator
Ctrl-C'ing (or otherwise signaling) an unattended run tears down the
currently-active stack via the same group-kill path, writes a partial
`summary.json` (with an `interrupted: "SIGINT" | "SIGTERM"` field), and
exits `1`.

### experiment.json (v1 shape)

```json
{
  "name": "e-opt1-participation",
  "weeks": 5,
  "rounds": 3,
  "cells": ["bull-cx", "chop-cx"],
  "arms": [
    { "id": "v1", "agent": "codex", "model": "gpt-5.6-sol", "overlayDir": "/abs/path/openalice-template-overlays" },
    { "id": "v2", "agent": "codex", "model": "gpt-5.6-sol", "overlayDir": "/abs/path/overlays-v2" }
  ],
  "maxRuns": 12,
  "basePort": 49631,
  "allowHoldout": false
}
```

- `cells` entries resolve to `tools/campaigns/cells/<cell>.json` and must
  exist. `holdout-*` cells are refused unless `"allowHoldout": true`
  (default `false`) — holdout discipline.
- `maxRuns` is a hard budget guard: `arms.length × cells.length × rounds`
  above it refuses to start.
- `basePort` (default `49631`) derives the arm's port block: `web =
  basePort`, `mcp = basePort + 1`, `uta = basePort + 2`, `ui = basePort +
  4`. Change it to avoid colliding with another concurrently-running lab
  experiment or a manual dev stack.
- v1 only supports `agent: "codex"` arms — there is no per-workspace write
  surface yet for pinning a Claude model per arm.
- run-id format: `<name>-<armId>-<cell>-r<round>`.

See `experiments/example-smoke.json` for a runnable 2-arm × 1-cell × 1-round
smoke config.

### What lab.mjs deliberately does not do (v1)

No parallel stacks or parallel cells; no changes to `run-cell.mjs` /
`report.mjs` semantics; no UI; no product-level auth/token injection (log
scraping via the existing `tokenFromLog` is internal to the runner). See
issue #259 for the full non-goals list and the capability-reuse audit.
