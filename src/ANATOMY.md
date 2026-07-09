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
  The behavior/support map is
  [../docs/openalice-agent-support.zh.md](../docs/openalice-agent-support.zh.md);
  the target trading-steward workspace behavior contract is
  [../docs/steward-workspace-behavior-contract.zh.md](../docs/steward-workspace-behavior-contract.zh.md);
  the current minimal persistent-steward implementation design is
  [../docs/steward-persistent-loop-implementation.zh.md](../docs/steward-persistent-loop-implementation.zh.md).
  The first persistent steward scaffold lives in
  `src/workspaces/templates/steward/`; its context manifest is written by
  `src/workspaces/context-injector.ts:91-127` after instructions and skills land.
  Steward wake/ledger schemas and workspace-local file stores live in
  `src/workspaces/steward/`; the v1 wake injector formats the
  `<STEWARD_WAKE>` message at `src/workspaces/steward/injector.ts:5-28`.
  Per-account wake locks are in `src/workspaces/steward/lock-store.ts:25-88`;
  supervisor tick and cost state are in
  `src/workspaces/steward/supervisor.ts:37-161` and
  `src/workspaces/steward/cost.ts:14-57`. Scheduled steward wake routing starts
  at `src/workspaces/issues/declaration.ts:84-117`, branches in
  `src/workspaces/schedule/scanner.ts:203-220` and
  `src/workspaces/schedule/scanner.ts:259-301`, then lands in
  `src/workspaces/service.ts:651-915` (shifted 1 line by issue #109's new
  `StewardSupervisorScanner`/`steward/config.ts` imports above this
  function — the `readStewardConfig` extraction below happened in
  `routes/workspaces.ts`, not here; `service.ts`'s own separate, untouched
  local `readStewardConfig` copy for `dispatchStewardWakeMethod` still
  lives at `service.ts:737-750`).
  `StewardSupervisor.tick()` itself only runs when something calls it; issue
  #109 added the self-arming `StewardSupervisorScanner`
  (`src/workspaces/steward/supervisor-scanner.ts:131-209`, `.scan()` at
  `:179-194`) so a hung/stuck wake's lock releases without external polling.
  Its shared tick-runner (`runStewardSupervisorTick`, `:67-109`) is the SAME
  function `POST /:id/steward/supervisor/tick` calls, so the manual route and
  the scanner can't drift; `readStewardConfig` (moved out of
  `src/webui/routes/workspaces.ts` into `src/workspaces/steward/config.ts`) is
  the other piece both share. The scanner is wired into
  `src/workspaces/service.ts:928-934` (instantiate + `.start()`, next to
  `scheduleScanner` above it) and `src/workspaces/service.ts:1269` (`.stop()`
  in `dispose()`).
  Open `src/workspaces/service.ts:94-104`, `src/workspaces/session-pool.ts:72-84`,
  `src/workspaces/template-registry.ts:106-111`, and
  `src/workspaces/adapters/claude.ts:89-113` (shifted from `:41-65` by the
  issue #92 permission-preseed block inserted above it — see
  `src/workspaces/adapters/claude.ts:12-60` for the pre-approved-Bash-tools
  rationale that now occupies the file's opening lines).
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
  `src/webui/routes/workspaces.ts:702-734`; manual steward wake routes live at
  `src/webui/routes/workspaces.ts:736-929` (both shifted from issue #88's
  stuck-wake Inbox push addition, then again by issue #109 pulling the
  supervisor/tick handler's `readStewardConfig` read and tick-plus-push logic
  out into `src/workspaces/steward/{config,supervisor-scanner}.ts` so the
  route and the new self-ticking scanner share it);
  account `maxAuthzLevel` changes are
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
  -> `src/workspaces/persistent-session.ts:128-150`. Server-side PTY input for
  future steward wakes goes through `SessionPool.writeToSession()` and
  `PersistentSession.writeInput()`, not through fabricated WebSocket frames.
- Manual steward wake dispatch is workspace-scoped: `src/webui/routes/workspaces.ts:751-970`
  acquires `.alice/steward/locks/*.json`, writes `.alice/steward/wakes/*.json`,
  reuses or resumes the configured interactive session via
  `src/webui/routes/workspaces.ts:352-507`, then calls
  `src/workspaces/steward/injector.ts:50-65` (shifted from `:19-28`, and now
  async: issue #91 found the message write landing in one PTY burst never
  actually submits in an interactive TUI — see the two-phase write + submit
  gap documented at `src/workspaces/steward/injector.ts:19-47`). Manual
  supervisor tick at
  `src/webui/routes/workspaces.ts:871-906` advances completed, stuck, or timed-out
  wakes and writes cost state/audit log.
- Scheduled steward wakes follow the same workspace-local files and PTY injector:
  issue frontmatter declares `kind: steward-wake`, scanner routes it away from
  headless at `src/workspaces/schedule/scanner.ts:203-220`, and the service
  dispatch seam at `src/workspaces/service.ts:650-913` creates the wake, lock,
  session, and injection.
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
