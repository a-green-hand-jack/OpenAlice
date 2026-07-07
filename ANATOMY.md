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
  Workspace Codex has two distinct runtime shapes: interactive PTY sessions
  are persistent/resumable via `src/workspaces/adapters/codex.ts:78`, while
  headless automation is one-shot `codex exec` via
  `src/workspaces/adapters/codex.ts:105` and
  `src/webui/routes/workspaces.ts:1339`. Production-like steward trading should
  route market/event triggers into a persistent steward session, not open a
  fresh headless Codex process per trade point; see
  `docs/steward-production-runtime.zh.md:1`.
  The first control edge for that shape is live PTY input/wake:
  `src/workspaces/persistent-session.ts:425`,
  `src/workspaces/session-pool.ts:166`, and
  `src/webui/routes/workspaces.ts:1061`. The agent-side behavior contract for
  this production-like shape now lives in the built-in `steward` template at
  `src/workspaces/templates/steward/files/instruction.md:1`, with its
  cross-platform bootstrap at `src/workspaces/templates/steward/bootstrap.mjs:1`.

- UTA is the co-located broker carrier under `services/uta/`. Its process entry
  is `services/uta/src/main.ts:40`, its account manager starts at
  `services/uta/src/domain/trading/uta-manager.ts:37`, and the trading HTTP
  surface is mounted from `services/uta/src/http/routes-trading.ts:121`. Its
  trade/risk lifecycle events cross into Alice through the best-effort sink at
  `services/uta/src/domain/trading/events.ts:47`. Paper auto-push, including
  the deterministic paper decision policy gate for stop-loss and loser-add
  checks, lives at `services/uta/src/domain/trading/paper-auto-push.ts:1`.
  Trading guards run through `services/uta/src/domain/trading/guards/guard-pipeline.ts:13`;
  the position-size guard estimates qty-based orders from quotes and can enforce
  both total-position and single-order caps at
  `services/uta/src/domain/trading/guards/max-position-size.ts:64`.

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
| `services/uta/` | Broker connections, trading git state, snapshots, FX, trading guards, policy-gated paper auto-push, and UTA HTTP routes. | `services/uta/src/main.ts:40`, `services/uta/src/domain/trading/guards/guard-pipeline.ts:13`, `services/uta/src/domain/trading/paper-auto-push.ts:1` |
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

- Paper auto-push does not add persisted state; it evaluates pending trading
  commits against guards, risk state, and the paper decision policy before
  pushing them. Rejected commits remain pending in UTA git state.

- Workspace launcher state is sibling user state under the launcher root:
  registry (including launcher-owned workspace `authzLevel` changed through
  Alice's audited workspace route), session records, scrollback, headless tasks,
  and workspace repos. The default root is `src/workspaces/config.ts:107-109`.
  A `steward` workspace repo carries its own durable event/decision/journal
  folders (`.alice/steward/events/`, `decisions/`, `journal/`) created by
  `src/workspaces/templates/steward/bootstrap.mjs:30`.
  Live session activity (`lastInputAt`, `lastOutputAt`, `lastActivityAt`) is
  in-memory PTY state surfaced for watchdog decisions, not persisted history;
  see `src/workspaces/persistent-session.ts:267`.
  Headless task records are automation/task history, not a production trading
  session pool; the one-shot runner waits for process exit at
  `src/workspaces/headless-task.ts:4`.

- Secrets are not stored in plaintext data files after sealing. The machine key
  is outside portable `data/`, at `src/core/sealing.ts:49-50`.

## Drift Rule

When a change moves files, shifts ownership, changes lifecycle, alters routes,
or changes persisted state, update the relevant ANATOMY.md files **in the same
commit/PR as the code change** — never as a follow-up — and run:

`pnpm exec tsx tools/check-anatomy-drift.ts --check`
