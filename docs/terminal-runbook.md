# OpenAlice Terminal Operator Runbook

> Provenance: produced 2026-07-04 by a code-level investigation session —
> every claim was verified against source at that date. Citations are
> file:line snapshots and may drift; the code wins. This is the standing
> verification manual for the fork's per-issue pipeline
> ([fork-workflow.md](fork-workflow.md) step 4: review via runbook
> spot-checks).

This runbook is for a developer or AI coding session that needs to start OpenAlice, drive it, and observe behavior end-to-end without opening the Electron app or a browser. Commands below use a repo checkout at `<repo-root>` — substitute your own path; examples were validated from a real checkout.

Safety default for all examples:

```bash
export REPO=/path/to/your/OpenAlice   # your checkout
cd "$REPO"
export OPENALICE_HOME=/tmp/openalice-cli-home
export AQ_LAUNCHER_ROOT=/tmp/openalice-cli-workspaces
export OA=http://127.0.0.1:47331
export MCP=http://127.0.0.1:47332
export UTA=http://127.0.0.1:47333
export COOKIE=/tmp/openalice.cookies
```

Using a checkout-local `OPENALICE_HOME` keeps `data/` and broker config away from the user's real `~/.openalice` store. The Guardian dev launcher documents this exact local-data mode in `scripts/guardian/dev.ts:33-37`; workspace state is separately controlled by `AQ_LAUNCHER_ROOT` in `src/workspaces/config.ts:107-109`.

## 1. Startup Paths

### 1.1 Development launcher: `pnpm dev`

`pnpm dev` runs `tsx scripts/guardian/dev.ts` (`package.json:7-12`). The dev Guardian resolves ports, spawns UTA first, then Alice, then Vite (`scripts/guardian/dev.ts:1-14`, `56-69`, `81-141`).

Default ports are:

- Alice web/API: `47331`
- MCP or local CLI gateway: `47332`
- UTA: `47333`
- Vite UI: `5173`

The defaults are centralized in `scripts/guardian/shared.ts:54`; env/file/default precedence is implemented in `scripts/guardian/shared.ts:66-71` and `111-126`.

Start a fully isolated dev stack:

```bash
cd "$REPO"          # your OpenAlice checkout
rm -rf /tmp/openalice-cli-home /tmp/openalice-cli-workspaces
mkdir -p /tmp/openalice-cli-home /tmp/openalice-cli-workspaces

OPENALICE_HOME=/tmp/openalice-cli-home \
AQ_LAUNCHER_ROOT=/tmp/openalice-cli-workspaces \
pnpm dev
```

What it actually spawns:

- UTA: `tsx watch services/uta/src/main.ts`, with `OPENALICE_UTA_PORT=47333` (`scripts/guardian/dev.ts:81-99`).
- Alice: `tsx watch src/main.ts`, with `OPENALICE_WEB_PORT=47331`, `OPENALICE_MCP_PORT=47332`, `OPENALICE_TOOL_BASE_URL=http://127.0.0.1:47332/cli`, `OPENALICE_UI_PORT=5173`, and `OPENALICE_UTA_URL=http://127.0.0.1:47333` (`scripts/guardian/dev.ts:101-127`).
- Vite: `pnpm --filter open-alice-ui dev`, with `OPENALICE_BACKEND_PORT=47331` and `OPENALICE_UI_PORT=5173` (`scripts/guardian/dev.ts:129-141`).

The dev launcher also sets `NODE_OPTIONS=--conditions=openalice-source`, which makes local workspace packages resolve their TypeScript source in dev (`scripts/guardian/dev.ts:72-79`; package `openalice-source` export conditions are in `packages/uta-protocol/package.json:6-11`, `packages/ibkr/package.json:6-11`, and `packages/opentypebb/package.json:6-16`).

Health checks:

```bash
curl -sS "$UTA/__uta/health" | jq .
curl -sS "$OA/api/version" | jq .
curl -sS "$OA/api/auth/status" | jq .
```

UTA binds to loopback only (`services/uta/src/main.ts:184-189`) and exposes `GET /__uta/health` (`services/uta/src/main.ts:159-164`). Alice waits for `OPENALICE_UTA_URL` and throws if it is missing (`src/main.ts:116-125`).

### 1.2 Production-ish local run: `pnpm start`

`pnpm start` runs the built Alice bundle only: `node dist/main.js` (`package.json:10-12`). It does not start UTA or Vite. Alice still requires `OPENALICE_UTA_URL` at startup (`src/main.ts:116-125`).

Build and run Alice against a separately running UTA:

```bash
cd "$REPO"          # your OpenAlice checkout
pnpm build

# Terminal 1: run UTA from source for local testing.
OPENALICE_HOME=/tmp/openalice-cli-home \
OPENALICE_UTA_PORT=47333 \
tsx services/uta/src/main.ts

# Terminal 2: run built Alice.
OPENALICE_HOME=/tmp/openalice-cli-home \
OPENALICE_WEB_PORT=47331 \
OPENALICE_MCP_PORT=47332 \
OPENALICE_TOOL_BASE_URL=http://127.0.0.1:47332/cli \
OPENALICE_UTA_URL=http://127.0.0.1:47333 \
node dist/main.js
```

The Docker production Guardian is a separate path in `scripts/guardian/prod.mjs`; it spawns built UTA (`node services/uta/dist/uta.js`) and built Alice (`node dist/main.js`) and watches the same restart flag (`scripts/guardian/prod.mjs:3-22`, `79-83`, `99-135`, `207-251`). That is not what `pnpm start` does.

### 1.3 Enable the MCP HTTP endpoint

In dev, port `47332` always exists, but it may be either the local CLI gateway or MCP depending on configuration. Alice enables MCP when env/config says so; otherwise it exposes only the local CLI gateway on the same port (`src/main.ts:307-337`). The dev launcher prints both the CLI gateway and optional MCP URL (`scripts/guardian/dev.ts:60-68`).

Start with MCP enabled:

```bash
cd "$REPO"          # your OpenAlice checkout
OPENALICE_HOME=/tmp/openalice-cli-home \
AQ_LAUNCHER_ROOT=/tmp/openalice-cli-workspaces \
OPENALICE_MCP_ENABLED=1 \
pnpm dev
```

Probe the port:

```bash
curl -i "$MCP/cli"
curl -i "$MCP/mcp"
```

Expected: `/cli` is the local tool gateway when MCP is disabled; `/mcp` is the streamable HTTP MCP endpoint when MCP is enabled. Both are loopback-only (`src/server/local-tool-gateway.ts:1-9`, `31-54`; `src/server/mcp.ts:184-200`).

## 2. Auth Bootstrap From Terminal

### 2.1 First-run admin token

On first run, Alice generates a 32-byte random admin token, prints the plaintext token once to stdout, and stores only a scrypt hash in `data/config/auth.json` (`src/services/auth/token-store.ts:1-7`, `22-31`, `79-100`, `143-166`). The file is written with mode `0600` where supported (`src/services/auth/token-store.ts:61-72`).

The WebPlugin calls `bootstrapToken` before mounting routes and logs the token plus the warning that it will not be shown again (`src/webui/plugin.ts:94-112`). If the token is lost in a throwaway dev home, delete `data/config/auth.json` and restart; the delete/regenerate path is documented in `src/services/auth/token-store.ts:133-166`.

Capture the token from startup logs:

```bash
# Run pnpm dev in another terminal, then copy the printed token.
export ADMIN_TOKEN='paste-token-from-openalice-startup-log'
```

Regenerate a token for an isolated dev home:

```bash
rm -f /tmp/openalice-cli-home/data/config/auth.json
OPENALICE_HOME=/tmp/openalice-cli-home AQ_LAUNCHER_ROOT=/tmp/openalice-cli-workspaces pnpm dev
```

### 2.2 Login and session cookie

The login route is `POST /api/auth/login` with JSON body `{ "token": "..." }`; it sets the HTTP-only cookie `alice_session` (`src/webui/routes/auth.ts:96-125`; cookie name in `src/webui/middleware/auth.ts:25`). The session store persists file-backed sessions in `data/config/sessions.json` with a 7-day default TTL (`src/services/auth/session-store.ts:1-13`, `22-30`, `88-141`).

Login from curl:

```bash
export OA=http://127.0.0.1:47331
export COOKIE=/tmp/openalice.cookies
export ADMIN_TOKEN='paste-token-from-openalice-startup-log'

curl -sS -c "$COOKIE" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$ADMIN_TOKEN\"}" \
  "$OA/api/auth/login" | jq .

curl -sS -b "$COOKIE" "$OA/api/auth/status" | jq .
curl -sS -b "$COOKIE" "$OA/api/version" | jq .
```

Localhost shortcut: with no `OPENALICE_TRUSTED_PROXIES`, HTTP requests from loopback bypass auth (`src/webui/middleware/auth.ts:75-83`; auth status also reports loopback as authenticated in `src/webui/routes/auth.ts:56-88`). Still use the cookie flow in automation so the same commands work when a trusted proxy or remote bind is configured. Mutating HTTP requests run an Origin/CSRF check, but CLI/curl requests without an `Origin` header are allowed (`src/webui/middleware/auth.ts:96-111`).

Logout:

```bash
curl -sS -b "$COOKIE" -c "$COOKIE" -X POST "$OA/api/auth/logout" | jq .
```

`POST /api/auth/logout` clears the `alice_session` cookie (`src/webui/routes/auth.ts:131-135`).

## 3. HTTP API Surface

Alice mounts API routes in `src/webui/plugin.ts:217-289`. `/api/trading/*` and `/api/simulator/*` are BFF-proxied to UTA (`src/webui/plugin.ts:227-236`; `src/webui/routes/trading-proxy.ts:1-12`, `36-71`). UTA itself mounts trading routes under `/api/trading` and simulator routes under `/api/simulator` (`services/uta/src/main.ts:175-180`).

### 3.1 Main route groups

Route inventory from `src/webui/routes/` and `src/webui/plugin.ts:217-289`:

- `/api/auth`: status, login, logout (`src/webui/routes/auth.ts:56-135`).
- `/api/channels`: channel CRUD (`src/webui/plugin.ts:221`; `src/webui/routes/channels.ts`).
- `/api/media`: dated media fetches (`src/webui/plugin.ts:222`; `src/webui/routes/media.ts`).
- `/api/config`: config, presets, AI credential CRUD/tests, workspace defaults, hub status (`src/webui/plugin.ts:223`; `src/webui/routes/config.ts`).
- `/api/market-data`: market-data config and provider-facing endpoints (`src/webui/plugin.ts:224`; `src/webui/routes/market-data.ts`).
- `/api/events`: webhook ingest, recent events, SSE stream, webhook auth status (`src/webui/plugin.ts:225`; `src/webui/routes/events.ts:16-151`).
- `/api/topology`: app topology (`src/webui/plugin.ts:226`; `src/webui/routes/topology.ts`).
- `/api/trading/config`: Alice-side trading config (`src/webui/plugin.ts:227`; `src/webui/routes/trading-config.ts`).
- `/api/trading`: proxied UTA trading BFF (`src/webui/plugin.ts:228-236`; `src/webui/routes/trading-proxy.ts:1-12`).
- `/api/simulator`: proxied UTA simulator BFF (`src/webui/plugin.ts:228-236`; `services/uta/src/http/routes-simulator.ts:1-10`).
- `/api/tools`: list, disable, inspect, and execute ToolCenter tools (`src/webui/plugin.ts:237`; `src/webui/routes/tools.ts`).
- `/api/agent-status`: recent agent/tool status (`src/webui/plugin.ts:238`; `src/webui/routes/agent-status.ts`).
- `/api/news`: news queries (`src/webui/plugin.ts:239`; `src/webui/routes/news.ts`).
- `/api/market`, `/api/bars`, `/api/reference`: market views, bars, macro/reference routes (`src/webui/plugin.ts:240-242`; `src/webui/routes/market.ts`; `src/webui/routes/bars.ts`; `src/webui/routes/reference.ts`).
- `/api/persona`: legacy persona read/update (`src/webui/plugin.ts:243`; `src/webui/routes/persona.ts`).
- `/api/inbox`: inbox history/read/unread/seed/delete (`src/webui/plugin.ts:244`; `src/webui/routes/inbox.ts:1-106`).
- `/api/version`: version endpoint (`src/webui/plugin.ts:245`; `src/webui/routes/version.ts`).
- `/api/workspaces`: templates, agents, workspace CRUD, files, git, PTY session spawn/resume/probe, credential readiness, and per-workspace headless dispatch (`src/webui/plugin.ts:247-260`; `src/webui/routes/workspaces.ts:315-417`, `1064-1156`).
- `/api/headless`: read-only headless task list/detail/output (`src/webui/plugin.ts:261`; `src/webui/routes/headless.ts:1-8`, `46-84`).
- `/api/schedule`: read-only schedule dashboard (`src/webui/plugin.ts:262`; `src/webui/routes/schedule.ts:1-21`).
- `/api/issues`: workspace issue board/details/comments (`src/webui/plugin.ts:263`; `src/webui/routes/issues.ts`).
- `/api/entities`: entity lookup (`src/webui/plugin.ts:267-270`; `src/webui/routes/entities.ts`).
- `/api/wikilink`: wikilink lookup (`src/webui/plugin.ts:274-277`; `src/webui/routes/wikilink.ts`).
- `/api/market-data-v1`: mounted OpenTypeBB API routes (`src/webui/plugin.ts:279-289`).

UTA trading route count note: the prompt mentions 24 trading routes, but this checkout exposes 36 `routes-trading.ts` endpoints. Key endpoints include account listing, account/positions/orders, quote/historical/contract details, wallet log/status/show/commit/reject/push, stage-place/modify/close/cancel, direct place/close/cancel, snapshots, and equity curve (`services/uta/src/http/routes-trading.ts:124-598`).

### 3.2 List UTA accounts

UTA ships built-in read-only data UTAs for Binance/OKX/Bybit at startup (`services/uta/src/main.ts:68-87`). UTA account listing is `GET /api/trading/uta` (`services/uta/src/http/routes-trading.ts:124-128`).

```bash
export OA=http://127.0.0.1:47331
export COOKIE=/tmp/openalice.cookies

curl -sS -b "$COOKIE" "$OA/api/trading/uta" | tee /tmp/openalice-utas.json | jq .

export UTA_ID="$(jq -r '.utas[0].id // empty' /tmp/openalice-utas.json)"
printf 'UTA_ID=%s\n' "$UTA_ID"
```

If there are no accounts, configure a paper/demo account or use the built-in read-only data UTAs. For any command that stages or pushes orders, use paper/demo accounts only.

### 3.3 Read account, positions, orders, snapshots, and equity curve

Account/positions/orders routes are in `services/uta/src/http/routes-trading.ts:255-288`; snapshots and equity curve are in `services/uta/src/http/routes-trading.ts:573-598`.

```bash
curl -sS -b "$COOKIE" "$OA/api/trading/uta/$UTA_ID/account" | jq .
curl -sS -b "$COOKIE" "$OA/api/trading/uta/$UTA_ID/positions" | jq .
curl -sS -b "$COOKIE" "$OA/api/trading/uta/$UTA_ID/orders" | jq .
curl -sS -b "$COOKIE" "$OA/api/trading/uta/$UTA_ID/snapshots?limit=5" | jq .
curl -sS -b "$COOKIE" "$OA/api/trading/snapshots/equity-curve?limit=50" | jq .
```

### 3.4 Search contracts and read quotes

Contract search, quote, historical, expansion, and details routes are in `services/uta/src/http/routes-trading.ts:142-161` and `298-370`.

```bash
curl -sS -b "$COOKIE" \
  "$OA/api/trading/contracts/search?query=AAPL&assetClass=equity" | jq .

export ALICE_ID='replace-with-real-aliceId-from-contract-search'

curl -sS -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d "{\"aliceId\":\"$ALICE_ID\"}" \
  "$OA/api/trading/uta/$UTA_ID/quote" | jq .

curl -sS -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d "{\"aliceId\":\"$ALICE_ID\"}" \
  "$OA/api/trading/uta/$UTA_ID/contracts/details" | jq .
```

Use the POST quote route for `aliceId` values because broker identifiers can contain `/` or other path-sensitive characters. The route handler also has a path form, but the body form avoids URL encoding mistakes (`services/uta/src/http/routes-trading.ts:298-322`). The contract search route accepts both `pattern` and `query`, then validates `assetClass` before delegating to the UTA search logic (`services/uta/src/http/routes-trading.ts:142-159`).

### 3.5 Stage and commit a trade as the AI would

OpenAlice uses a git-like wallet workflow: AI/tool actions stage and commit; a human approves push. Stage-only order routes are explicitly separated in UTA (`services/uta/src/http/routes-trading.ts:463-481`), and commit/reject/push routes are in `services/uta/src/http/routes-trading.ts:414-461`.

Paper/demo only:

```bash
export ALICE_ID='replace-with-real-paper-contract-aliceId'

curl -sS -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d "{\"aliceId\":\"$ALICE_ID\",\"action\":\"BUY\",\"orderType\":\"LMT\",\"totalQuantity\":\"1\",\"lmtPrice\":\"1\"}" \
  "$OA/api/trading/uta/$UTA_ID/wallet/stage-place-order" | jq .

curl -sS -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d '{"message":"CLI smoke: staged test order; paper/demo only"}' \
  "$OA/api/trading/uta/$UTA_ID/wallet/commit" | jq .

curl -sS -b "$COOKIE" "$OA/api/trading/uta/$UTA_ID/wallet/status" | jq .
```

To clean up without sending anything to the broker:

```bash
curl -sS -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d '{"reason":"CLI smoke cleanup"}' \
  "$OA/api/trading/uta/$UTA_ID/wallet/reject" | jq .
```

The AI-facing `tradingPush` tool refuses execution unless AI trading is explicitly allowed (`src/tool/trading.ts:722-767`). The live-testing guide treats HTTP wallet push as the stand-in for the user's approval button (`docs/uta-live-testing.md:20-26`).

Human-only approval route, paper/demo only:

```bash
curl -sS -b "$COOKIE" \
  -X POST \
  "$OA/api/trading/uta/$UTA_ID/wallet/push" | jq .
```

### 3.6 Workspace list and creation

Workspace templates, agent list, and workspace creation are in `src/webui/routes/workspaces.ts:315-417`.

```bash
curl -sS -b "$COOKIE" "$OA/api/workspaces/templates" | jq .
curl -sS -b "$COOKIE" "$OA/api/workspaces/agents" | jq .
curl -sS -b "$COOKIE" "$OA/api/workspaces" | jq .

export WS_TAG="cli-smoke-$(date +%s)"

curl -sS -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d "{\"tag\":\"$WS_TAG\",\"template\":\"chat\",\"agents\":[\"codex\"]}" \
  "$OA/api/workspaces" | tee /tmp/openalice-workspace.json | jq .

export WS_ID="$(jq -r '.workspace.id' /tmp/openalice-workspace.json)"
printf 'WS_ID=%s\n' "$WS_ID"
```

If `codex` is not available on the host, choose an installed agent from `/api/workspaces/agents`. Shell workspaces are useful for manual terminal checks, but the shell adapter does not provide the same autonomous headless agent behavior as Codex/Claude-style adapters.

### 3.7 Dispatch a headless run over HTTP

The per-workspace HTTP dispatch route is `POST /api/workspaces/:id/headless`; it accepts `prompt`, optional `agent`, optional `timeoutMs`, and optional `wait` (`src/webui/routes/workspaces.ts:1064-1156`). Read-only headless task inspection is under `/api/headless` (`src/webui/routes/headless.ts:1-8`, `46-84`).

Asynchronous run:

```bash
curl -sS -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d '{"agent":"codex","prompt":"Print a one-line OpenAlice terminal smoke status. Do not edit files.","timeoutMs":120000}' \
  "$OA/api/workspaces/$WS_ID/headless" | tee /tmp/openalice-headless.json | jq .

export TASK_ID="$(jq -r '.taskId' /tmp/openalice-headless.json)"

curl -sS -b "$COOKIE" "$OA/api/headless/$TASK_ID" | jq .
curl -sS -b "$COOKIE" "$OA/api/headless/$TASK_ID/output?tailBytes=20000" | jq -r '.stdout.text,.stderr.text'
```

Synchronous wait:

```bash
curl -sS -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d '{"agent":"codex","wait":true,"prompt":"Print hello from OpenAlice headless. Do not edit files.","timeoutMs":120000}' \
  "$OA/api/workspaces/$WS_ID/headless" | jq .
```

Credential readiness is checked before dispatching a headless task (`src/workspaces/service.ts:487-533`). If the selected agent is not installed, not logged in, or not headless-capable, the route returns a 4xx with the reason (`src/webui/routes/workspaces.ts:1102-1122`).

### 3.8 Read and seed Inbox entries

Inbox history/read/unread/delete routes are in `src/webui/routes/inbox.ts:23-44` and `97-106`. The `/seed` endpoint is a dev-only helper for generating fake entries (`src/webui/routes/inbox.ts:1-11`, `46-95`).

```bash
curl -sS -b "$COOKIE" "$OA/api/inbox/history?limit=20" | jq .

curl -sS -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS_ID\",\"workspaceLabel\":\"$WS_TAG\",\"comments\":\"Terminal seed check\"}" \
  "$OA/api/inbox/seed" | jq .

curl -sS -b "$COOKIE" "$OA/api/inbox/history?limit=5" | jq .
```

Production workspace agents should push real entries through the workspace-scoped `inbox_push` tool, not `/api/inbox/seed`. The tool is registered as a workspace tool in `src/main.ts:100-106` and implemented in `src/tool/inbox-push.ts:22`.

### 3.9 POST `/api/events/ingest` webhook

The webhook route accepts `POST /api/events/ingest` and authenticates with either `Authorization: Bearer <token>` or `X-OpenAlice-Token: <token>` (`src/webui/routes/events.ts:31-62`; token extraction in `src/webui/routes/webhook-auth.ts:24-50`). Webhook tokens live in `data/config/webhook.json` (`src/webui/routes/webhook-auth.ts:1-12`; config schema in `src/core/config.ts:390-400`).

Create a webhook token in the isolated dev home before startup, or restart after writing it:

```bash
export OPENALICE_HOME=/tmp/openalice-cli-home
export WEBHOOK_TOKEN="$(openssl rand -hex 24)"
mkdir -p "$OPENALICE_HOME/data/config"
printf '{"tokens":[{"id":"cli","token":"%s"}]}\n' "$WEBHOOK_TOKEN" \
  > "$OPENALICE_HOME/data/config/webhook.json"
```

Ingest a current event shape:

```bash
curl -sS \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"type":"agent.work.requested","payload":{"source":"manual","prompt":"terminal webhook smoke","metadata":{"from":"runbook"}}}' \
  "$OA/api/events/ingest" | jq .

curl -sS -b "$COOKIE" "$OA/api/events/recent?type=agent.work.requested&limit=5" | jq .
```

Ingest the legacy alias:

```bash
curl -sS \
  -H "X-OpenAlice-Token: $WEBHOOK_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"type":"task.requested","payload":{"prompt":"legacy alias smoke"}}' \
  "$OA/api/events/ingest" | jq .
```

Honesty note: `agent.work.requested` currently lands in the event log; the old in-process AI consumer is dormant/removed (`src/core/agent-event.ts:58-63`, `204-208`). Use headless workspace dispatch for actual autonomous work.

## 4. MCP Surfaces

### 4.1 Paths, port, and security model

The MCP server exposes:

- Global MCP: `http://127.0.0.1:47332/mcp`
- Workspace MCP: `http://127.0.0.1:47332/mcp/:wsId`
- Local CLI manifest/invoke gateway: `http://127.0.0.1:47332/cli/...`

The MCP file documents the global `/mcp`, workspace `/mcp/:wsId`, and `/cli/:wsId/:export` surfaces, and states that the gateway is loopback-only and unauthenticated (`src/server/mcp.ts:17-51`). The Hono handlers are mounted at `/mcp` and `/mcp/:wsId` (`src/server/mcp.ts:137-173`), and the server binds to `127.0.0.1` (`src/server/mcp.ts:184-200`). The local CLI gateway has the same loopback-only security model (`src/server/local-tool-gateway.ts:1-9`, `31-54`).

Start with MCP enabled:

```bash
OPENALICE_HOME=/tmp/openalice-cli-home \
AQ_LAUNCHER_ROOT=/tmp/openalice-cli-workspaces \
OPENALICE_MCP_ENABLED=1 \
pnpm dev
```

### 4.2 Call MCP tools from a terminal Node client

This uses the installed `@modelcontextprotocol/sdk` dependency and the streamable HTTP transport.

List global MCP tools:

```bash
cd "$REPO"          # your OpenAlice checkout

MCP_URL=http://127.0.0.1:47332/mcp \
node --input-type=module <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'openalice-runbook', version: '0.1.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL)))
const tools = await client.listTools()
console.log(tools.tools.map((t) => t.name).sort().join('\n'))
await client.close()
NODE
```

Call a global trading read tool:

```bash
cd "$REPO"          # your OpenAlice checkout

MCP_URL=http://127.0.0.1:47332/mcp \
TOOL=listUTAs \
ARGS='{}' \
node --input-type=module <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'openalice-runbook', version: '0.1.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL)))
const result = await client.callTool({
  name: process.env.TOOL,
  arguments: JSON.parse(process.env.ARGS ?? '{}'),
})
console.log(JSON.stringify(result, null, 2))
await client.close()
NODE
```

Call a workspace-scoped MCP tool:

```bash
cd "$REPO"          # your OpenAlice checkout

MCP_URL="http://127.0.0.1:47332/mcp/$WS_ID" \
TOOL=inbox_read \
ARGS='{"limit":5}' \
node --input-type=module <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'openalice-runbook', version: '0.1.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL)))
const result = await client.callTool({
  name: process.env.TOOL,
  arguments: JSON.parse(process.env.ARGS ?? '{}'),
})
console.log(JSON.stringify(result, null, 2))
await client.close()
NODE
```

Global tools are built from `toolCenter.getMcpTools()` (`src/server/mcp.ts:74-86`). Workspace tools are built from `workspaceToolCenter.build(...)` and closed over the workspace id, inbox store, entity store, issue board, and origin metadata (`src/server/mcp.ts:88-126`).

### 4.3 Connect Codex CLI to OpenAlice MCP

The Codex adapter writes MCP server config for interactive sessions, including global `openalice` and workspace `openalice-workspace` URLs (`src/workspaces/adapters/codex.ts:73-79`, `306-334`). Headless Codex intentionally avoids MCP because unattended tool prompts can block/cancel headless runs (`src/workspaces/adapters/codex.ts:93-118`).

Manual Codex example:

```bash
codex \
  -c "mcp_servers.openalice.url=\"http://127.0.0.1:47332/mcp\"" \
  -c "mcp_servers.openalice-workspace.url=\"http://127.0.0.1:47332/mcp/$WS_ID\""
```

Workspace sessions launched by Alice receive `AQ_WS_ID`, `OPENALICE_TOOL_URL`, and optionally `OPENALICE_MCP_URL` in their environment (`src/workspaces/service.ts:370-385`).

### 4.4 Useful tools under `src/tool/*`

Tool registration happens in Alice composition root (`src/main.ts:215-253`). The most useful operator-facing groups are:

- Thinking/sandbox tools: expression evaluator and related thinking helpers (`src/main.ts:217`).
- Trading tools: UTA list/search/read, portfolio, orders, wallet status/log/show, commit/reject/push, order history, sync, and stage/place/modify/close/cancel operations (`src/main.ts:223-226`; `src/tool/trading.ts:198-831`).
- Market tools: market search, vendors, market board, equity, ETF, bars, reference/macro/derivatives/indices/economy tools (`src/main.ts:219-251`).
- News/RSS tools: RSS and news search when enabled (`src/main.ts:235-237`).
- Quant/snapshot/simulation/sector rotation tools (`src/main.ts:232-248`).
- Workspace tools: `inbox_push`, `inbox_read`, `workspace_path`, `entity_upsert`, `entity_search`, and issue tools (`src/main.ts:100-106`; `src/tool/inbox-push.ts:22`; `src/tool/inbox-read.ts:29`; `src/tool/workspace-path.ts:28`; `src/tool/entity-upsert.ts:20`; `src/tool/entity-search.ts:18`; `src/tool/issue-tools.ts:156-434`).

## 5. `alice-uta` CLI

The `alice-uta` executable is a Node script at `src/workspaces/cli/bin/alice-uta`. The file is intentionally generic for all `alice-*` CLI exports; it derives the export key from `argv[1]`, reads `OPENALICE_TOOL_URL` and `AQ_WS_ID`, calls the local gateway, and contains no trading business logic (`src/workspaces/cli/bin/alice-uta:3-24`, `33-77`, `82-131`). It parses flags, JSON object values, and repeatable `--doc` values (`src/workspaces/cli/bin/alice-uta:179-223`).

The `uta` export is declared in `src/server/cli-commands.ts:186-231`, with command groups:

- `account`: `list`, `info`, `portfolio`
- `contract`: `search`, `details`, `quote`, `expand`
- `order`: `list`, `history`, `trades`, `place`, `modify`, `cancel`
- `position`: `close`
- `git`: `status`, `log`, `show`, `commit`, `push`, `reject`, `sync`
- `market`: `clock`
- `sim`: `price-change`

Set up the CLI from any terminal:

```bash
cd "$REPO"          # your OpenAlice checkout
export OPENALICE_TOOL_URL=http://127.0.0.1:47332/cli
export AQ_WS_ID="$WS_ID"
export BIN=$REPO/src/workspaces/cli/bin/alice-uta

node "$BIN"
node "$BIN" account list
node "$BIN" account info --source "$UTA_ID"
node "$BIN" account portfolio --source "$UTA_ID"
node "$BIN" contract search --pattern AAPL --assetClass equity
node "$BIN" order place --help
node "$BIN" git status --source "$UTA_ID"
```

Stage/commit via CLI, paper/demo only:

```bash
export ALICE_ID='replace-with-real-paper-contract-aliceId'

node "$BIN" order place \
  --aliceId "$ALICE_ID" \
  --action BUY \
  --orderType LMT \
  --totalQuantity 1 \
  --lmtPrice 1 \
  --commitMessage "CLI smoke; paper/demo only"

node "$BIN" git status --source "$UTA_ID"
node "$BIN" git reject --source "$UTA_ID" --reason "cleanup"
```

Human approval push, paper/demo only:

```bash
curl -sS -b "$COOKIE" -X POST "$OA/api/trading/uta/$UTA_ID/wallet/push" | jq .
```

The UTA live-testing guide says trading-path changes should be exercised through the `alice-uta` CLI after setup (`docs/uta-live-testing.md:12-16`, `49-62`). It also states the safety rules: demo/paper accounts only, agent surface only, and HTTP wallet push stands in for user approval (`docs/uta-live-testing.md:20-26`).

The scenario catalog S1-S12 is in `docs/uta-live-testing.md:64-139` — read
the source for the full per-scenario procedure and the bug class each one
guards against. Accurate one-line index:

1. S1 — Read-state agreement (account vs positions PnL consistency; rows carry `secType`+`aliceId`).
2. S2 — Simple lifecycle (marketable limit → `[sync]` fill commit → `order trades` → sell back).
3. S3 — Hanger stability (deep limit stays `Submitted` across poller passes; cancel records `cancelled`).
4. S4 — Amendment (`order modify` price AND qty; same full-precision orderId).
5. S5 — Attached TP/SL (unverified ccxt venue must REFUSE loudly; verified/native venues must show BOTH protective legs).
6. S6 — Standalone stop (STP tracked via algo-namespace fallback, not mis-terminaled).
7. S7 — External order observation (`[observed]` commit → takeover → cancel through Alice).
8. S8 — Restart survival (pending order still tracked/cancellable after UTA restart).
9. S9 — Partial close (spot must NOT send reduceOnly; perp must).
10. S10 — Notional entry (`--cashQty`: fill qty ≈ cash/price).
11. S11 — Error ergonomics (every error actionable for an agent, carries the venue's own message).
12. S12 — Staging undo (`git reject` → clean status, `user-rejected` with reason recorded).

Use this skeleton for each scenario:

```bash
export OPENALICE_TOOL_URL=http://127.0.0.1:47332/cli
export AQ_WS_ID="$WS_ID"
export BIN=$REPO/src/workspaces/cli/bin/alice-uta

node "$BIN" account list
node "$BIN" git status --source "$UTA_ID"
node "$BIN" order place --help

# Scenario-specific staged operation here.

node "$BIN" git status --source "$UTA_ID"

# Approval only on paper/demo accounts.
curl -sS -b "$COOKIE" -X POST "$OA/api/trading/uta/$UTA_ID/wallet/push" | jq .

node "$BIN" account portfolio --source "$UTA_ID"
node "$BIN" order list --source "$UTA_ID"
```

Leave accounts flat after every scenario; the live-testing guide calls that out explicitly (`docs/uta-live-testing.md:37-39`).

## 6. Headless Workspace Runs

### 6.1 What the scheduler scans

The scheduler scans every workspace for `.alice/issues/<id>.md`, evaluates frontmatter `when`, and fires due issues through `dispatchHeadlessTask` on roughly a one-minute tick (`src/workspaces/schedule/scanner.ts:1-26`, `43-68`, `90-149`, `151-230`). The issue declaration format, `.alice/issues` directory, frontmatter schema, fireability, and generated prompt are defined in `src/workspaces/issues/declaration.ts:1-31`, `43`, `65-91`, `120-132`, `140-175`, and `200-231`.

The schedule API is read-only; creating/editing scheduled issues is intentionally a coding/workspace task (`src/webui/routes/schedule.ts:1-21`).

Inspect schedule state:

```bash
curl -sS -b "$COOKIE" "$OA/api/schedule" | jq .
```

### 6.2 Manual trigger over HTTP

This is the cleanest terminal trigger. It bypasses schedule files and directly dispatches a headless task:

```bash
curl -sS -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d '{"agent":"codex","wait":true,"prompt":"Run a terminal-only smoke check. Do not edit files. Print what you checked.","timeoutMs":120000}' \
  "$OA/api/workspaces/$WS_ID/headless" | jq .
```

The route resolves the workspace, checks the requested agent, ensures headless support, and either waits synchronously or returns a task id (`src/webui/routes/workspaces.ts:1064-1156`). The service creates and tracks task records, injects `AQ_RUN_ID`, and captures output (`src/workspaces/service.ts:487-638`).

### 6.3 Manual trigger via issue file drop

Use this only inside the target workspace directory, not inside the OpenAlice source repo. Workspace directories are listed by `/api/workspaces` (`src/webui/routes/workspaces.ts:368-417`).

```bash
export WS_DIR="$(
  curl -sS -b "$COOKIE" "$OA/api/workspaces" |
    jq -r --arg id "$WS_ID" '.workspaces[] | select(.id == $id) | .dir'
)"

mkdir -p "$WS_DIR/.alice/issues"

cat > "$WS_DIR/.alice/issues/runbook-smoke.md" <<'EOF'
---
title: Runbook smoke
status: todo
priority: low
when:
  kind: at
  at: "2026-07-04T00:00:00.000Z"
agent: codex
what: "Write a short runbook smoke note and push it to Inbox."
---

Created from a terminal runbook check.
EOF

curl -sS -b "$COOKIE" "$OA/api/schedule" | jq .
```

For `kind: at`, use a current or past ISO timestamp to make the issue due on the next scanner pass. The scanner marks fire attempts and calls `dispatchHeadlessTask` (`src/workspaces/schedule/scanner.ts:188-230`).

### 6.4 Manual trigger via the workspace CLI tools

Workspace templates teach agents to create scheduled issues with `alice-workspace issue create --when ...` (`src/workspaces/templates/chat/files/instruction.md:113-123`). Outside a launched workspace, call the script directly and provide the gateway/env:

```bash
cd "$REPO"          # your OpenAlice checkout
export OPENALICE_TOOL_URL=http://127.0.0.1:47332/cli
export AQ_WS_ID="$WS_ID"

node src/workspaces/cli/bin/alice-workspace issue create \
  --title "Runbook smoke" \
  --priority low \
  --when '{"kind":"at","at":"2026-07-04T00:00:00.000Z"}' \
  --what "Write a short runbook smoke note and push it to Inbox."

curl -sS -b "$COOKIE" "$OA/api/schedule" | jq .
```

## 7. Fast Change-Perception Loops by Layer

### 7.1 UI and Vite HMR

Guardian runs Vite with `pnpm --filter open-alice-ui dev` and proxies `/api` to the Alice backend via `OPENALICE_BACKEND_PORT` (`scripts/guardian/dev.ts:129-141`; `ui/vite.config.ts:7-24`, `80-89`). Vite serves on the strict UI port from `OPENALICE_UI_PORT` (`ui/vite.config.ts:43-60`).

Terminal check:

```bash
curl -sS -I http://127.0.0.1:5173/ | head
curl -sS http://127.0.0.1:5173/ | sed -n '1,20p'
```

Demo mode is a no-broker UI walk using MSW handlers. The script is `vite --mode demo` (`ui/package.json:5-9`); demo startup imports the MSW worker when `VITE_DEMO_MODE` is true (`ui/src/main.tsx:12-18`; `ui/src/demo/index.ts:3-7`; `ui/src/demo/worker.ts:1-4`). Demo handlers include a catch-all that logs `[demo] unmocked ...` for missing endpoints (`ui/src/demo/handlers/index.ts:1-42`; `ui/src/demo/handlers/catchAll.ts:3-11`).

No-broker demo command:

```bash
cd "$REPO"          # your OpenAlice checkout
pnpm -F open-alice-ui dev:demo
```

If an automation harness prints `VITE ... ready` and then ends with `Command failed with signal "SIGTERM"`, that usually means the long-running Vite process was terminated by the harness, not that Vite failed. Verify by checking that the ready line appeared and that `[demo] unmocked` warnings are absent or expected.

The workspace contains 7 package projects in this checkout: the root plus packages matched by `pnpm-workspace.yaml:1-5` (`apps/*`, `packages/*`, `services/*`, `ui`). The install log line `Scope: all 7 workspace projects` is consistent with that layout.

### 7.2 Alice `src/`

In `pnpm dev`, Alice runs under `tsx watch src/main.ts`, so changes under Alice source restart the Alice process (`scripts/guardian/dev.ts:101-127`). The dev launcher waits for `/api/version` after spawning Alice (`scripts/guardian/dev.ts:119-127`).

Observe restart readiness:

```bash
curl -sS "$OA/api/version" | jq .
tail -n 200 logs/workspace-sessions.log 2>/dev/null || true
```

`pnpm start` does not watch source; rebuild first:

```bash
pnpm build
OPENALICE_HOME=/tmp/openalice-cli-home \
OPENALICE_WEB_PORT=47331 \
OPENALICE_MCP_PORT=47332 \
OPENALICE_TOOL_BASE_URL=http://127.0.0.1:47332/cli \
OPENALICE_UTA_URL=http://127.0.0.1:47333 \
node dist/main.js
```

### 7.3 UTA service

In `pnpm dev`, UTA runs under `tsx watch services/uta/src/main.ts` (`scripts/guardian/dev.ts:81-99`). UTA source says startup path is restart path and there is no in-process hot reload for broker config (`services/uta/src/main.ts:1-10`).

Manual restart via Guardian flag:

```bash
export OPENALICE_HOME=/tmp/openalice-cli-home
mkdir -p "$OPENALICE_HOME/data/control"
printf 'manual restart %s\n' "$(date -Is)" \
  > "$OPENALICE_HOME/data/control/restart-uta.flag"

curl -sS "$UTA/__uta/health" | jq .
```

Guardian watches `data/control/restart-uta.flag` and restarts UTA when it appears (`scripts/guardian/dev.ts:9-12`, `154-162`; flag watcher implementation in `scripts/guardian/shared.ts:430-475`; restart function in `scripts/guardian/shared.ts:394-421`).

### 7.4 Workspace packages

In dev, Guardian sets `NODE_OPTIONS=--conditions=openalice-source` (`scripts/guardian/dev.ts:72-79`). The workspace packages expose their TypeScript source under the `openalice-source` condition (`packages/uta-protocol/package.json:6-11`; `packages/ibkr/package.json:6-11`; `packages/opentypebb/package.json:6-16`). TypeScript configs know the same custom condition (`tsconfig.json:17`; `services/uta/tsconfig.json:17`), and the UTA tsup config notes the dev-vs-dist resolver split (`services/uta/tsup.config.ts:11-20`).

Best-effort operator rule:

- During `pnpm dev`, changes to imported workspace package source should be picked up by the `tsx watch` process that imports them, because package resolution points at source.
- During `pnpm start` or packaged/prod flows, rebuild packages/root bundle first, because normal package `import` exports point at `dist`.

Commands:

```bash
# Package-level strict check, example:
pnpm -F @traderalice/uta-protocol typecheck

# Full build before pnpm start / production-like runs:
pnpm build
```

## 8. Test-Side Verification

### 8.1 Unit/integration tests

Root `pnpm test` runs Vitest across Alice `src/`, `packages/`, `services/`, `apps/`, `scripts/`, and UI jsdom specs. The project routing is in `vitest.config.ts:24-46`, with package-source aliases in `vitest.config.ts:7-18`.

Run:

```bash
cd "$REPO"          # your OpenAlice checkout
pnpm test
```

Strict Alice typecheck:

```bash
npx tsc --noEmit
```

UI strict typecheck, only when UI changed:

```bash
cd $REPO/ui
npx tsc -b
cd "$REPO"          # your OpenAlice checkout
```

Package strict typecheck, only for a touched package:

```bash
pnpm -F @traderalice/uta-protocol typecheck
```

### 8.2 E2E tests and live credentials

`pnpm test:e2e` uses `vitest.e2e.config.ts`, includes `src/**/*.e2e.spec.*` and `services/**/*.e2e.spec.*`, runs serially, and has no `vitest.setup.ts` temp-home setup (`vitest.e2e.config.ts:16-38`). That is intentional: unit tests pin `OPENALICE_HOME` to a temp directory if unset, but the setup file comments that e2e tests read real broker credentials from the real store and are not wired to the temp setup (`vitest.setup.ts:1-15`, `20-22`).

Run only when paper/demo credentials are intentionally configured:

```bash
cd "$REPO"          # your OpenAlice checkout
pnpm test:e2e
```

UTA e2e setup loads configured UTAs through the same config path as the app, requires paper/sandbox/demo where applicable, skips disabled/no-credential accounts, and checks IBKR connectivity before use (`services/uta/src/domain/trading/__test__/e2e/setup.ts:1-15`, `25-47`, `50-58`, `97-128`).

Market-data e2e also reads configured provider credentials and mounts web routes the same way the app does (`src/domain/market-data/__test__/e2e/setup.ts:12-18`, `40-55`).

### 8.3 OpenBB provider suite

The OpenBB provider suite is separate and reads configured provider keys (`vitest.bbProvider.config.ts:15-23`; `src/domain/market-data/__tests__/bbProviders/setup.ts:1-5`, `19-25`).

```bash
cd "$REPO"          # your OpenAlice checkout
pnpm test:bbProvider
```

### 8.4 Dev smoke test

`pnpm test:smoke` runs `tsx scripts/guardian/smoke.ts` (`package.json:19-23`). The smoke script boots the full dev stack, checks UTA/Alice/Vite, exercises the restart path, and checks cleanup (`scripts/guardian/smoke.ts:1-28`, `97-114`, `154-211`, `214-235`).

```bash
cd "$REPO"          # your OpenAlice checkout
pnpm test:smoke
```

Use this after changes to Guardian, startup, ports, UTA restart behavior, or Vite proxying.

## 9. GUI-Only Gaps and Terminal Rough Edges

These are the places where terminal operation is incomplete or less ergonomic. The required feature/bug verification loops above do not require Electron, but these gaps are real.

1. No first-party terminal PTY controller exists for interactive workspace sessions.

   Alice does expose the raw PTY WebSocket at `/api/workspaces/pty` (`src/webui/workspaces-ws.ts:1-8`, `21`, `118-165`), and non-browser callers without an `Origin` header are allowed after the same auth check (`src/webui/workspaces-ws.ts:183-206`). Electron has its own IPC PTY bridge (`src/webui/workspaces-ipc.ts:1-8`, `83-155`). However, there is no bundled `alice-workspace attach` or TUI client that gives a polished terminal attach experience. For no-GUI verification, prefer headless runs (`POST /api/workspaces/:id/headless`) or direct `alice-*` CLI commands.

   Raw WebSocket probe if you have `websocat` installed:

   ```bash
   # First create or resume a session through /api/workspaces routes, then attach by session id.
   export SESSION_ID='replace-with-workspace-session-id'
   websocat "ws://127.0.0.1:47331/api/workspaces/pty?session=$SESSION_ID&cols=120&rows=40&kind=cli"
   ```

2. Electron update install UX is desktop-only.

   Packaged-app auto-update shows Electron dialogs and can call `autoUpdater.quitAndInstall` (`apps/desktop/src/auto-update.ts:10-18`, `35-70`). There is no equivalent HTTP/CLI route to accept and install desktop updates. This does not affect source checkout verification.

   Terminal alternative for source checkouts:

   ```bash
   git fetch origin
   git status --short
   pnpm install --filter='!@traderalice/desktop'
   pnpm build
   ```

3. Browser visual verification is not replaced by a terminal-only assertion layer.

   Demo mode can run without a broker via MSW (`ui/src/demo/README.md:1-5`, `21-36`), and terminal logs reveal unmocked endpoints through the catch-all handler (`ui/src/demo/handlers/catchAll.ts:3-11`). But layout regressions, drag/drop behavior, and visual affordances still need a browser automation layer such as Playwright or a human browser session. There is no repository-native CLI that asserts visual correctness from terminal output alone.

   No-broker demo start:

   ```bash
   pnpm -F open-alice-ui dev:demo
   ```

4. The admin token is not retrievable after first display.

   This is by design: plaintext is shown once, while only the hash is stored (`src/services/auth/token-store.ts:1-7`, `79-100`, `143-166`; startup display in `src/webui/plugin.ts:94-112`). Terminal sessions can regenerate it in disposable homes by deleting `data/config/auth.json`, but there is no API to read the token back.

   Regenerate in an isolated dev home:

   ```bash
   rm -f /tmp/openalice-cli-home/data/config/auth.json
   OPENALICE_HOME=/tmp/openalice-cli-home AQ_LAUNCHER_ROOT=/tmp/openalice-cli-workspaces pnpm dev
   ```

5. Schedule creation has HTTP read but not HTTP write.

   `/api/schedule` is explicitly read-only (`src/webui/routes/schedule.ts:1-21`). Creating scheduled headless work is done by editing `.alice/issues/*.md` or by using workspace scoped tools/CLI (`src/workspaces/schedule/scanner.ts:1-26`; `src/workspaces/issues/declaration.ts:1-31`; `src/workspaces/templates/chat/files/instruction.md:113-123`). That is usable from terminal, but there is no direct `POST /api/schedule` create route.

   CLI route:

   ```bash
   export OPENALICE_TOOL_URL=http://127.0.0.1:47332/cli
   export AQ_WS_ID="$WS_ID"
   node src/workspaces/cli/bin/alice-workspace issue create \
     --title "Scheduled terminal check" \
     --when '{"kind":"at","at":"2026-07-04T00:00:00.000Z"}' \
     --what "Run a short scheduled verification and report to Inbox."
   ```

6. Manual trade approval is not GUI-only.

   This is an important non-gap: the human approval action has an HTTP route, `POST /api/trading/uta/:id/wallet/push` (`services/uta/src/http/routes-trading.ts:450-461`), and the UTA live-testing guide explicitly uses that route as the user approval stand-in (`docs/uta-live-testing.md:20-26`). It is still dangerous on live accounts; use paper/demo only.

   Paper/demo approval command:

   ```bash
   curl -sS -b "$COOKIE" -X POST "$OA/api/trading/uta/$UTA_ID/wallet/push" | jq .
   ```
