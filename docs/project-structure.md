# Project Structure

> Status: lightweight docs router. The authoritative structural maps are
> [../ANATOMY.md](../ANATOMY.md), [../src/ANATOMY.md](../src/ANATOMY.md), and the
> repository root `AGENTS.md` / `CLAUDE.md`. This page intentionally avoids
> duplicating a full tree because OpenAlice has been moving quickly.

OpenAlice is a pnpm monorepo with two local processes supervised by Guardian:

- **Alice** (`src/`) — workspace launcher, tools, MCP/CLI gateway, web API,
  Inbox, market/news/analysis context, workspace scheduling and PTY/headless
  agent execution.
- **UTA** (`services/uta/`) — broker carrier, account state, TradingGit,
  orders, positions, snapshots, guards, risk state, and broker adapters.
- **Shared packages** (`packages/`) — `@traderalice/uta-protocol`,
  `@traderalice/opentypebb`, and `@traderalice/ibkr`.
- **UI** (`ui/`) — Vite/React operator UI.
- **Guardian** (`scripts/guardian/`) — dev/prod process supervisor.

For current ownership and line anchors:

| Topic | Start here |
|---|---|
| Cross-process map, data roots, drift rule | [../ANATOMY.md](../ANATOMY.md) |
| Alice internals under `src/` | [../src/ANATOMY.md](../src/ANATOMY.md) |
| Workspace agent support surface | [openalice-agent-support.zh.md](openalice-agent-support.zh.md) |
| Target steward workspace behavior | [steward-workspace-behavior-contract.zh.md](steward-workspace-behavior-contract.zh.md) |
| Trading-agent runtime and market testing | [trading-agent-runtime-and-market-testing.zh.md](trading-agent-runtime-and-market-testing.zh.md) |
| Event system | [event-system.md](event-system.md) |
| UTA live testing | [uta-live-testing.md](uta-live-testing.md) |

The older in-process AI loop, legacy connectors, and `domain/trading` inside
Alice are retired. The model loop now runs in native workspace CLIs
(`claude`, `codex`, `opencode`, `pi`, `shell`), while broker state and
execution live in UTA.
