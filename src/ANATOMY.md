# src/ Anatomy

## What this is

`src/` is the Alice process: it assembles local context, exposes tools and web
routes, launches native agent workspaces, and talks to UTA over the protocol.

## Components

- `core/` - config, state stores, events, sessions, tool registries, sealing,
  and path resolution. Start at `src/core/config.ts:518-555`,
  `src/core/tool-center.ts:17-21`, `src/core/workspace-tool-center.ts:93-104`,
  `src/core/inbox-store.ts:160`, and `src/core/event-log.ts:112-118`.
- `ai-providers/` - credential-vault preset suggestions only, not an execution
  layer. The ordered catalog is `src/ai-providers/preset-catalog.ts:349-372`.
- `domain/` - non-broker domain services: market data, analysis, news, and safe
  expression helpers. Load-bearing entries include
  `src/domain/market-data/bars/bar-service.ts:184`,
  `src/domain/analysis/sector-rotation.ts:181`,
  `src/domain/news/store.ts:43`, and `src/domain/thinking/index.ts:1`.
- `tool/` - AI-facing tool definitions, thin over domain services and the UTA
  SDK. Trading tools start at `src/tool/trading.ts:193-196`; workspace push
  starts at `src/tool/inbox-push.ts:22-24`; registration is in
  `src/main.ts:217-253`.
- `workspaces/` - PTY-backed workspace launcher, templates, adapters, persistent
  session identity, scrollback, headless runs, schedules, and issue files.
  Open `src/workspaces/service.ts:94-104`, `src/workspaces/session-pool.ts:72-84`,
  `src/workspaces/template-registry.ts:106-111`, and
  `src/workspaces/adapters/claude.ts:41-65`.
- `services/` - Alice-owned cross-cutting clients: auth, UTA SDK wrappers, and
  UTA restart/health helpers. Anchors: `src/services/uta-client/UTAManagerSDK.ts:36-40`,
  `src/services/uta-supervisor/health.ts:22-36`,
  `src/services/uta-supervisor/restart-trigger.ts:55-72`, and
  `src/services/auth/token-store.ts:31`.
- `server/` - loopback MCP and CLI gateway servers plus OpenTypeBB HTTP mounting.
  Anchors: `src/server/mcp.ts:52`, `src/server/mcp.ts:137-144`,
  `src/server/local-tool-gateway.ts:35-52`, and `src/server/opentypebb.ts:70-91`.
- `webui/` - Hono web plugin, admin-token middleware, `/api/*` routes, and
  workspace WebSocket/IPCs. `WebPlugin` starts at `src/webui/plugin.ts:73-94`;
  core API routes are `src/webui/plugin.ts:221-245`; workspace routes are
  `src/webui/plugin.ts:250-263`; workspace `authzLevel` changes live at
  `src/webui/routes/workspaces.ts:468-500`; account `maxAuthzLevel` changes are
  audited in `src/webui/routes/trading-config.ts:197-207`; trading proxy is
  `src/webui/routes/trading-proxy.ts:32-41`; event ingest's external/internal
  token gate is `src/webui/routes/events.ts:42-60`.
- `migrations/` - versioned transformations for persisted user state. Registry:
  `src/migrations/registry.ts:27-32`; runner:
  `src/migrations/runner.ts:121-143`.
- `task/` - cron/metrics support code owned by Alice. The current metrics
  listener is `src/task/metrics/listener.ts:31-38`.

## Connections

- `webui` routes keep the browser on Alice while proxying trading to UTA:
  `src/webui/plugin.ts:228-236` -> `src/webui/routes/trading-proxy.ts:32-41`
  -> `services/uta/src/http/routes-trading.ts:121`.
- `tool/` definitions register with `ToolCenter`; global MCP exports the enabled
  catalog with trading trimmed to read-only, while workspace MCP exports a
  Steward-authz-filtered union of global tools plus workspace-scoped tools; proposal
  tools are additionally gated against the target account ceiling/type before
  execution:
  `src/main.ts:217-253` -> `src/core/tool-center.ts:17-21` ->
  `src/core/workspace-tool-center.ts:33-153`,
  `src/core/workspace-tool-center.ts:459-475`, and
  `src/core/workspace-tool-center.ts:500-560` -> `src/server/mcp.ts:74-128`.
- Blind workspaces apply a second catalog seal after authz filtering: real
  market-data groups are removed, explicit `bars` / `searchBars` reads are
  allowlisted by barId source, and trading market-data reads
  (`searchContracts`, `getQuote`, `getContractDetails`, `expandContract`,
  `getMarketClock`) are runtime-gated by `blindAllowBarSources` on both MCP and
  CLI surfaces. Anchors:
  `src/core/workspace-tool-center.ts:155-188`,
  `src/core/workspace-tool-center.ts:290-455`,
  `src/server/mcp.ts:172-181`, and `src/server/cli.ts:192-201`.
- `workspaces/` computes adapter commands, then `SessionPool` owns live PTYs:
  `src/workspaces/service.ts:94-104` -> `src/workspaces/session-pool.ts:72-84`
  -> `src/workspaces/persistent-session.ts:128-150`.
- Alice talks to UTA through `@traderalice/uta-protocol`: `src/main.ts:15-16`,
  `src/services/uta-client/UTAManagerSDK.ts:21-30`, and
  `packages/uta-protocol/src/client/UTAClient.ts:48`.

## Composition

- Parent map: [../ANATOMY.md](../ANATOMY.md). It routes across Alice, UTA,
  packages, UI, Guardian, and data roots.
- `src/main.ts:76` is Alice's composition root; it builds stores, domain
  services, tools, plugins, and the final `EngineContext`.
- `services/uta/` and `packages/` are sibling trees, not children of `src/`.
  Do not import UTA broker internals into Alice; use the UTA SDK/protocol seam.

## State

- `data/config/` is read through `src/core/config.ts:10` and migrated before
  config load by `src/core/config.ts:518-522`; account `maxAuthzLevel` lives in
  the UTA account config and is changed through the audited Settings route at
  `src/webui/routes/trading-config.ts:197-207`; applied migrations journal to
  `_meta.json` through `src/migrations/runner.ts:121-143`.
- Trading commits are UTA-owned at
  `services/uta/src/domain/trading/git-persistence.ts:14-16`.
- Tool calls, inbox entries, and events persist as JSONL through
  `src/core/tool-call-log.ts:83-100`, `src/core/inbox-store.ts:21-29`, and
  `src/core/event-log.ts:112-118`.
- Workspace state is outside `data/`: launcher root comes from
  `src/workspaces/config.ts:107-109`; launcher-owned workspace `authzLevel`
  lives in `workspaces.json` via `src/workspaces/workspace-registry.ts:116-127`,
  with corrupt row values degraded at `src/workspaces/workspace-registry.ts:191-200`;
  session records and scrollback are `src/workspaces/session-registry.ts:81-87`
  and `src/workspaces/scrollback-store.ts:23-35`.
- `sealing.key` lives beside the portable data root, not inside it:
  `src/core/sealing.ts:1-8` and `src/core/sealing.ts:49-50`.

## Notes

- Dev uses `tsx watch` with `--conditions=openalice-source`; prod uses built
  bundles/resources. See `scripts/guardian/dev.ts:72-85`,
  `./tsconfig.json:17`, and `src/core/paths.ts:57-72`.
- UTA config changes restart UTA through a flag file; there is no hot reload.
  See `scripts/guardian/dev.ts:9-12` and
  `src/services/uta-supervisor/restart-trigger.ts:55-72`.
- `/mcp` and `/cli` are unauthenticated loopback surfaces by design:
  `src/server/mcp.ts:40-47` and `src/server/local-tool-gateway.ts:1-9`.
- New persisted-data transformations belong in `src/migrations/`, not startup
  cleanup loops: `src/core/config.ts:518-522` and
  `src/migrations/runner.ts:121-143`.
- Workspace-scoped tools bind identity from `/mcp/:wsId`; agents do not supply
  workspace IDs. See `src/server/mcp.ts:25-32` and `src/tool/inbox-push.ts:4-15`.
