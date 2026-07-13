# OpenAlice Anatomy

OpenAlice is two local processes supervised by Guardian: Alice is the agent
runtime and workspace launcher, UTA is the broker carrier, and both share
files as state instead of a database.

Use this page as a router. It names the structural areas, what owns them, and
which anchor files to open first when a change touches lifecycle, routing,
state, or ownership.

## Process Map

- Guardian starts the dev stack in dependency order: UTA, Alice, then Vite.
  The dev entry point is `scripts/guardian/dev.ts:33`, with the UTA readiness
  gate at `scripts/guardian/dev.ts:100-108`, the internal UTA→Alice event
  token injection at `scripts/guardian/dev.ts:82-96`, and the restart flag watcher at
  `scripts/guardian/dev.ts:169-174`.

- Alice is the agent runtime under `src/`. Its composition root is
  `src/main.ts:76`, and its assembled `EngineContext` is `src/main.ts:364-376`.
  Start with [src/ANATOMY.md](src/ANATOMY.md) before changing Alice internals.
  For the full workspace-agent support map (interactive PTY, headless runs,
  CLI/MCP tools, schedule, Inbox, and UTA trading surface), start with
  [docs/openalice-agent-support.zh.md](docs/openalice-agent-support.zh.md). For
  the target trading-steward behavior inside a workspace (workspace-as-world,
  persistent session, wake envelope, checklist, and decision ledger), start with
  [docs/steward-workspace-behavior-contract.zh.md](docs/steward-workspace-behavior-contract.zh.md);
  for the current minimal implementation design, continue to
  [docs/steward-persistent-loop-implementation.zh.md](docs/steward-persistent-loop-implementation.zh.md).
  The current architecture and information-flow truth is
  [docs/trading-agent-architecture.zh.md](docs/trading-agent-architecture.zh.md);
  performance-test levels remain in
  [docs/trading-agent-runtime-and-market-testing.zh.md](docs/trading-agent-runtime-and-market-testing.zh.md).
  The current acceptance snapshot is
  [docs/appendix/steward-v8-candidate-20260711.md](docs/appendix/steward-v8-candidate-20260711.md):
  the isolated, serial v8 candidate matrix completed 60/60 wakes and 10/10
  audit-clean cells. Its gateable result remained 7/8, with NVDA still below
  the +25% behavior gate. Merge review also found that the candidate's 70–85%
  target was unsafe to generalize to accounts without a max-position guard, so
  the experiment is documented but not enabled in the default instruction;
  holdout/live remains closed.
  Persistent sessions expose an explicit server-side PTY input seam for future
  steward wake injection; see `src/workspaces/persistent-session.ts` and
  `src/workspaces/session-pool.ts`. The first manual persistent-steward wake
  path is `POST /api/workspaces/:id/steward/wakes`, implemented at
  `src/webui/routes/workspaces.ts:816`, which acquires the account lock,
  writes the workspace-local wake file, and injects a narrow `<STEWARD_WAKE>`
  into the configured interactive session instead of dispatching a new headless
  run. `POST /api/workspaces/:id/steward/supervisor/tick` advances ledger
  completions, timeouts, stuck sessions, lock release, and cost state. Scheduled
  issues with `kind: steward-wake` now route through the same persistent wake
  seam from `src/workspaces/schedule/scanner.ts:203-220` into
  `dispatchStewardWakeMethod` at `src/workspaces/service.ts:663`; ordinary scheduled issues still run
  headless.

- Codex workspace bootstrap registers each cwd in the user-level
  `~/.codex/config.toml`. Issue #124 hardened that shared write with an
  in-process queue, a cross-process `O_EXCL` lock with stale reclaim, and
  temp-file atomic replace (`src/workspaces/adapters/codex.ts:582-781`). That
  removes the proven lost-block/malformed-TOML race, but campaign isolation is
  still broader than config safety: shared UTA cleanup/restart can invalidate
  other cells, so canonical matrices use isolated roots or strict serialization.

- UTA is the co-located broker carrier under `services/uta/`. Its process entry
  is `services/uta/src/main.ts:40`, its account manager starts at
  `services/uta/src/domain/trading/uta-manager.ts:37`, and the trading HTTP
  surface is mounted from `services/uta/src/http/routes-trading.ts:121`. Its
  trade/risk lifecycle events cross into Alice through the best-effort sink at
  `services/uta/src/domain/trading/events.ts:47`.

- Shared packages live under `packages/`. The main process boundary is
  `@traderalice/uta-protocol`, exported from `packages/uta-protocol/src/index.ts:15-17`.
  Market-data portability comes from `packages/opentypebb/src/index.ts:39-44`;
  IBKR wire support is exported from `packages/ibkr/src/index.ts:30-38`.

- The React UI lives under `ui/`. Browser bootstrap is `ui/src/main.tsx:20-31`;
  the shell and workspace provider entry are `ui/src/App.tsx:47-52`.

- Data roots are resolved in code, not by assuming this checkout's `data/`.
  Alice data paths go through `src/core/paths.ts:42-45`; effective homes are
  exported at `src/core/paths.ts:88-96`. Workspace launcher state defaults to
  `src/workspaces/config.ts:107-109`, and the sealing key path is
  `src/core/sealing.ts:49-50`.

## Area Router

| Area | Owns | First anchor |
| --- | --- | --- |
| `src/` | Alice runtime: config, tools, MCP, web API, workspace launcher, market/news/thinking context. | [src/ANATOMY.md](src/ANATOMY.md), `src/main.ts:76` |
| `services/uta/` | Broker connections, trading git state, snapshots, FX, and UTA HTTP routes. | `services/uta/src/main.ts:40` |
| `packages/uta-protocol/` | Wire types, zod schemas, and the low-level UTA HTTP client shared by Alice and UTA. | `packages/uta-protocol/src/index.ts:15-17` |
| `packages/opentypebb/` | In-repo TypeScript OpenBB-style providers and query execution. | `packages/opentypebb/src/index.ts:39-44` |
| `packages/ibkr/` | TypeScript IBKR TWS protocol port consumed by trading integrations. | `packages/ibkr/src/index.ts:30-38` |
| `ui/` | Vite/React operator UI, demo mode, tabs, auth gate, and workspace terminal surfaces. | `ui/src/main.tsx:20-31` |
| `scripts/guardian/` | Local supervisor, port planning, child spawning, cascade shutdown, UTA restart flags. | `scripts/guardian/dev.ts:33` |

## State Router

- Portable user state is under the resolved `data/` root, not necessarily this
  checkout. `src/core/paths.ts:4-18` explains the split between user data and
  app resources.

- Config files live under `data/config/`; account config includes the
  per-account `maxAuthzLevel` ceiling. Migrations journal to
  `data/config/_meta.json` through the runner documented at
  `src/migrations/INDEX.md:6`.

- Trading state lives in UTA-owned files. The primary trading commit path is
  `services/uta/src/domain/trading/git-persistence.ts:14-16`.

- Workspace launcher state is sibling user state under the launcher root:
  registry (including launcher-owned workspace `authzLevel` changed through
  Alice's audited workspace route), session records, scrollback, headless tasks,
  and workspace repos. Steward workspaces additionally carry their template-owned
  `.alice/steward/` context/ledger scaffold inside the workspace repo, including
  per-wake launcher-owned `snapshots/`, agent-authored `drafts/`,
  validator-owned `ledger/decisions.jsonl`, versioned `schemas/`, and matching
  `finalize/` markers; Alice's
  steward file-store helpers under `src/workspaces/steward/` read/write that
  workspace-local source of truth, and the manual wake API writes
  `.alice/steward/wakes/*.json`, `.alice/steward/locks/*.json`,
  `.alice/steward/state.json`, and `.alice/steward/supervisor.jsonl` while
  reading `.alice/steward/ledger/decisions.jsonl`. New decisions use strict v3
  Decision Intent + composite thesis dispositions while historical v1/v2 remain
  read-only; the agent writes only a draft,
  `validate-ledger.mjs` is the supported atomic ledger writer and publishes the
  commit marker, and the supervisor retains receipts to detect later semantic
  deletion or mutation. The versioned D4 smoke stage manifest freezes the
  explicit repo-local runtime dependency closure, D3 dataset identity,
  provider-specific raw quota observations (including exact calibration turns,
  display resolution, and per-window future-turn counts), and model matrix.
  `d4-smoke-runner.ts` reads both subscription controls sequentially through
  one-provider ephemeral credential roots that are source-checked and removed
  before candidate setup; each dispatch then rechecks only the selected provider
  through that execution's selected OAuth copy. The bootstrap moves the ledger
  validator, command shims, and audit append helper into a host runtime outside
  the workspace that is non-writable while the candidate runs. Codex runs inside
  a fail-closed bubblewrap filesystem with a curated executable/library set and
  `/usr/bin/git` overlaid by the audit shim; Claude uses the fail-closed SDK
  sandbox and reports audit append failures as command events. The runner also
  owns deterministic wakes, exact model attestation, proposal-only audit checks,
  and terminal report validation. This is corruption-evident inside one
  agent-writable trust domain, not tamper-proof account truth; UTA and the venue
  stay authoritative.
  The default root is `src/workspaces/config.ts:107-109`.

- Secrets are not stored in plaintext data files after sealing. The machine key
  is outside portable `data/`, at `src/core/sealing.ts:49-50`.

## Drift Rule

When a change moves files, shifts ownership, changes lifecycle, alters routes,
or changes persisted state, update the relevant ANATOMY.md files **in the same
commit/PR as the code change** — never as a follow-up — and run:

`pnpm exec tsx tools/check-anatomy-drift.ts --check`
