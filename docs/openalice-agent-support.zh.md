# OpenAlice Agent 支持面全图

> 版本：v0.1（2026-07-07）
> 地位：架构调查文档。它回答「OpenAlice 已经支持 agent 怎样在 workspace
> 里工作、拿工具、被调度、恢复上下文、触达 UTA 交易」；交易行为方法论仍以
> [steward-agent-working-modes.zh.md](steward-agent-working-modes.zh.md)、
> [steward-agent-observation-surface.zh.md](steward-agent-observation-surface.zh.md)、
> [steward-prompt-anatomy.zh.md](steward-prompt-anatomy.zh.md) 为准。

## 0. 结论先行

OpenAlice 本身不是一个「每次任务都只会开 `codex exec`」的简陋壳子。它已经有
完整的 workspace agent 基座：

1. **交互会话面**：workspace 内运行原生 agent CLI 的 PTY 会话，可暂停、恢复、
   复用 agent 自己的 transcript。Codex 交互态走 `codex` / `codex resume`，不是
   每个交易点都必须 `codex exec`。
2. **自动任务面**：scheduled issue / 手动 headless 任务走 one-shot headless CLI。
   Codex 在这里确实是 `codex exec --json -- <prompt>`，因为 headless 要以「进程退出」
   作为任务完成边界。
3. **工具面**：agent 的主工具入口是 workspace PATH 上的 `alice*` / `traderhub`
   CLI shim；它们只是 `/cli/:wsId/:export` 的薄前端。MCP 也存在，但当前 headless
   Codex 明确不用 MCP，因为 `codex exec` 会取消无人批准的 MCP tool call。
4. **交易面**：UTA 是单独 broker carrier。Agent 通过 `alice-uta` 看到账户、订单、
   risk、trading-as-git staging/commit；可见性再由 workspace `authzLevel` 与账户
   `maxAuthzLevel` 裁剪。Live 自动成交不是现有行为。
5. **缺口**：jieke/dev 现状没有「唤醒同一个常驻 steward session 并注入 wake
   envelope」的生产循环；schedule scanner 只能发新的 headless run。要做预期中的
   常驻 steward，需要在现有交互会话/PTY 基座上补 wake/input/heartbeat/policy 层。

所以问题不在于 OpenAlice 完全不支持 agent 在 workspace 里用工具做事；问题在于
**现有自动化触发面默认是 fresh headless run，而我们想要的交易 steward 是窄循环、
常驻、可唤醒、可观测的工作方式**。

## 1. 两条执行平面

### 1.1 Interactive Session：常驻/可恢复的 PTY

这是「一个 workspace 里开一个 agent，让它持续工作」的主路径。

链路：

1. UI / API 调 `POST /api/workspaces/:id/sessions/spawn`，或 quick-chat 调
   `POST /api/workspaces/quick-chat`。
2. `spawnInteractiveSession` 解析 agent、credential、初始 prompt、resume 意图，
   预分配 `SessionRecord`，再交给 `SessionPool`。
3. `SessionPool` 用 adapter 生成命令，启动 PTY 子进程，工作目录就是 workspace
   repo。
4. Launcher 注入 `AQ_WS_ID`、`OPENALICE_TOOL_URL`、`AQ_SESSION_ID` 等环境变量。
   Agent 只看到普通 shell 命令；identity 由 shim header 传回服务端。
5. 暂停/恢复走 session registry。Agent 自己的 transcript id 若可发现，会作为
   `resumeHint` 保存；恢复时 adapter 转成 `--resume` / `resume <id>` / `--session`。

代码锚点：

- `src/webui/routes/workspaces.ts:163-230`：交互 spawn 的共享入口。
- `src/webui/routes/workspaces.ts:652-693`：workspace session spawn route。
- `src/webui/routes/workspaces.ts:696-760`：quick-chat route。
- `src/workspaces/service.ts:820-903`：真正组成 PTY spawn command/env。
- `src/workspaces/session-registry.ts:7-64`：持久 session record。
- `src/workspaces/scrollback-store.ts:9-22`：shell scrollback；agent transcript
  由 agent CLI 自己保存。

这条平面适合：人类正在看着的长期研究、手动 trading desk、需要复用同一段
Codex/Claude 对话上下文的工作。

### 1.2 Headless Task：一次性自动任务

这是「scheduler / automation fire 一次，agent 做完退出」的路径。它不是 PTY，不进
`SessionPool`，也不 respawn。

链路：

1. 手动 API `POST /api/workspaces/:id/headless`，或 schedule scanner 从
   `.alice/issues/<id>.md` 的 `when` 触发。
2. `dispatchHeadlessTask` 在 `HeadlessTaskRegistry` 记录 run，注入 `AQ_RUN_ID`。
3. `runHeadlessTask` 用 `child_process.spawn` 启动 adapter 的 headless 命令。
4. 进程退出就是任务边界。Launcher 不解析 agent 结论，只保存 stdout/stderr tail
   和日志；agent 应通过 `alice-workspace inbox push` 把结果推给用户。
5. 如果 adapter 能从 stdout 抓到 agent session id，run 结束后可以 reopened as
   interactive session，但下一次 schedule fire 仍是新的 headless run。

代码锚点：

- `src/webui/routes/workspaces.ts:1163-1266`：headless API。
- `src/workspaces/service.ts:139-167`：headless service contract。
- `src/workspaces/service.ts:490-533`：同步 one-shot run。
- `src/workspaces/service.ts:543-584`：异步 dispatch + registry record。
- `src/workspaces/headless-task.ts:1-21`：为什么不用 PTY/SessionPool。
- `src/workspaces/headless-task-registry.ts:1-15`：run 管理面与重启 reconcile。
- `src/workspaces/schedule/scanner.ts:1-25`：scheduled issue scanner。

这条平面适合：定时报表、周期性 research、短任务、无人在场时的后台跑批。它现在
**不适合**直接表达「同一个交易 steward 常驻醒来、读 event、继续上一轮状态」。

## 2. Adapter 能力矩阵

| Adapter | 交互命令 | Resume | Headless | 工具路径 |
|---|---|---|---|---|
| Claude | `claude --settings ... [-- <prompt>]` | by-id；不用 `--continue` | `claude -p --output-format stream-json --verbose -- <prompt>` | `alice*` CLI；MCP server 存在但新 workspace 不写 `.mcp.json` |
| Codex | `codex ...` / `codex resume --last` / `codex resume <id>` | last + by-id | `codex -c approval_policy="never" -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true exec --json -- <prompt>` | 交互可带 MCP flags；headless 走 `alice*` CLI |
| opencode | `opencode` / `--continue` / `--session <id>` | last + by-id | `opencode run --format json -- <prompt>` | `alice*` CLI |
| Pi | `pi` / `--continue` / `--session-id <id>` | launcher 可分配 id | `pi -p --mode json <prompt>` | `alice*` CLI + `.pi/skills` |
| shell | `$SHELL --login` | 无 | 无 | 人类 shell |

代码锚点：

- `src/workspaces/adapters/claude.ts:41-101`
- `src/workspaces/adapters/codex.ts:55-118`
- `src/workspaces/adapters/opencode.ts:69-123`
- `src/workspaces/adapters/pi.ts:66-126`
- `src/workspaces/adapters/shell.ts:13-28`

关键点：**adapter 决定 CLI 行为，不决定交易权限**。交易权限在工具目录/UTA/authz
层，不在 Claude/Codex/Pi 的模型层。

## 3. Workspace Context 怎么注入

Workspace 是一个真实 repo。模板负责 materialize 文件，launcher 负责把 agent
需要的上下文写进去：

- 内置模板位于 `src/workspaces/templates/`。当前官方模板是 `chat` 与
  `auto-quant`。
- `template.json` 声明 default agents、是否注入 persona、是否注入 tool skills。
- `bootstrap.mjs` 是跨平台 Node bootstrap；git 通过 `_common.mjs` 里的 `dugite`
  helper，避免系统 git/bash 依赖。
- `context-injector.ts` 把 persona + template instruction 写到 `CLAUDE.md` 与
  `AGENTS.md`，并复制 skills 到 `.claude/skills`、`.agents/skills`、`.pi/skills`。
- `chat` 模板默认告诉 agent 使用四个 CLI：`alice`、`alice-uta`、
  `alice-workspace`、`traderhub`。
- `workspace-creator.ts` 在 bootstrap 之后做 context injection、初始 git commit、
  adapter bootstrap 与 credential injection。密钥类配置在初始 commit 之后写，且被
  `_common.mjs` 加入 `.git/info/exclude`。

代码锚点：

- `src/workspaces/workspace-creator.ts:137-143`
- `src/workspaces/workspace-creator.ts:165-181`
- `src/workspaces/workspace-creator.ts:206-248`
- `src/workspaces/workspace-creator.ts:250-278`
- `src/workspaces/template-registry.ts:72-95`
- `src/workspaces/template-registry.ts:111-160`
- `src/workspaces/context-injector.ts:23-38`
- `src/workspaces/context-injector.ts:47-88`
- `src/workspaces/templates/chat/files/instruction.md`

这意味着 prompt 不是唯一上下文。Agent 每次醒来看到的 context 由四层组成：

1. agent CLI 自己的全局/项目 instruction 读取逻辑；
2. workspace 内 `CLAUDE.md` / `AGENTS.md` / skills / README / issue files；
3. 本次用户 prompt 或 headless prompt；
4. 工具调用实时返回的数据。

## 4. 工具入口：MCP 与 CLI

### 4.1 MCP surface

MCP server 绑定 `127.0.0.1`，是本机 workspace subprocess 的本地工具面：

- `/mcp`：workspace-independent catalog，trading 保守裁成 read-only。
- `/mcp/:wsId`：workspace-scoped union catalog。URL path 是 workspace identity；
  `inbox_push` / `workspace_path` / `issue_*` 等工具由 factory closure 绑定 wsId。
- `/cli/:wsId/:export/*` 与 MCP 同端口同 Hono app。

代码锚点：

- `src/server/mcp.ts:28-61`
- `src/server/mcp.ts:115-129`
- `src/server/mcp.ts:132-193`
- `src/server/mcp.ts:204-250`
- `src/server/mcp.ts:252-268`

### 4.2 CLI shim surface

`alice*` CLI 是 agent headless/交互都能稳定使用的主路径。shim 本身没有业务逻辑：

1. 从 argv0 判断 export：`alice` -> `data`，`alice-uta` -> `uta` 等。
2. 从 `AQ_WS_ID` 与 `OPENALICE_TOOL_URL` 拼出 `/cli/:wsId/:export`。
3. `--help` 读取 manifest；真正执行走 `/invoke`。
4. `AQ_RUN_ID` / `AQ_SESSION_ID` 以 header 形式传给服务端，用于 Inbox origin。

四个 export：

| Binary | Export | Scope | 用途 |
|---|---|---|---|
| `alice` | `data` | global ToolCenter | RSS、symbol search、bars、quant、snapshot、simulate、calculator |
| `traderhub` | `traderhub` | global ToolCenter | boards、fundamentals、macro、ETF、Fed、shipping、crypto、index |
| `alice-workspace` | `workspace` | WorkspaceToolCenter | Inbox、peer path、tracked entity、issue board |
| `alice-uta` | `uta` | global ToolCenter + authz filter | UTA account/portfolio/order/contract/risk/trading-as-git |

代码锚点：

- `src/workspaces/cli/bin/alice:1-24`
- `src/workspaces/cli/bin/alice:30-52`
- `src/workspaces/cli/bin/alice:103-119`
- `src/server/cli-commands.ts:1-33`
- `src/server/cli-commands.ts:45-239`
- `src/server/cli.ts:137-208`
- `src/server/cli.ts:228-322`

### 4.3 Local gateway 与环境注入

Launcher 给每个 spawn 注入工具地址与 workspace identity：

- `AQ_WS_ID`：workspace identity，拼到 `/cli/:wsId/:export`。
- `OPENALICE_TOOL_URL` / `OPENALICE_TOOL_SOCKET`：CLI shim 的本地 gateway。
- `OPENALICE_MCP_URL`：可选 MCP base URL，主要供支持 MCP 的 adapter 使用。
- `AQ_SESSION_ID` 或 `AQ_RUN_ID`：二选一，作为 out-of-band header 让 Inbox / audit
  能区分交互 session 与 headless run。

同时 `spawn-env.ts` 会剥掉 inherited stale OpenAlice/IDE/env 变量，避免 workspace
子进程继承 web port、UTA token、旧 tool URL 等脏状态。`LocalToolGatewayPlugin`
可在单独 loopback 端口挂 `/cli`，而 MCP plugin 也会在同一 loopback app 挂 CLI
gateway；这两种拓扑服务的是同一组 CLI shim。

代码锚点：

- `src/workspaces/service.ts:351-386`
- `src/workspaces/service.ts:507-520`
- `src/workspaces/service.ts:843-861`
- `src/workspaces/spawn-env.ts:23-39`
- `src/workspaces/spawn-env.ts:76-113`
- `src/server/local-tool-gateway.ts:1-9`
- `src/server/local-tool-gateway.ts:46-56`

## 5. Trading / UTA 支持

OpenAlice 的 trading 能力不在 agent CLI 内部，而在 UTA process：

- Alice 负责 workspace agent runtime、工具注册、web BFF。
- UTA 负责 broker 连接、账户状态、orders、positions、risk、trading-as-git。
- `@traderalice/uta-protocol` 是跨进程 wire shape。
- `alice-uta` 暴露 read/proposal/trading-as-git surface，但不暴露 broker push。
- Paper commit 可以由 UTA policy 自动成交；live 不应自动成交。

权限裁剪有两层：

1. **Workspace authz**：`WorkspaceMeta.authzLevel` 存在 launcher-owned
   `workspaces.json`，不是 agent 可编辑文件。
2. **Account ceiling**：UTA account config 的 `maxAuthzLevel` 是账户上限。

`resolveWorkspaceToolAuthzLevel` 取二者有效值，`filterWorkspaceToolCatalog` 对
trading tools deny-by-default；proposal tools 在执行前还会按目标账户二次校验。

代码锚点：

- `src/workspaces/workspace-registry.ts:29-44`
- `src/core/workspace-tool-center.ts:47-105`
- `src/core/workspace-tool-center.ts:116-153`
- `src/server/mcp.ts:141-183`
- `src/server/cli.ts:125-203`
- `src/server/cli-commands.ts:187-239`

## 6. Inbox / Issue / Schedule 支持

OpenAlice 已有 agent 到用户、agent 到未来自己的协作通道：

- **Inbox**：agent 用 `alice-workspace inbox push` 推文件和 comment。服务端注入
  workspace/run/session origin，agent 不自己声明身份。
- **Issue board**：workspace 内 `.alice/issues/<id>.md` 是持久 work item。读是全局
  board，写默认本 workspace。
- **Schedule**：issue 带 `when` 后，scanner 每分钟扫描 due issue 并发 headless run。
- **Headless run history**：registry 保存 taskId、wsId、agent、prompt、status、日志、
  captured agentSessionId。

代码锚点：

- `src/tool/inbox-push.ts:1-16`
- `src/core/inbox-store.ts`
- `src/server/inbox-origin.ts`
- `src/workspaces/issues/declaration.ts`
- `src/workspaces/schedule/scanner.ts:130-231`
- `src/workspaces/headless-task-registry.ts:24-54`

重要边界：schedule 是「fire prompt」，不是「维护一个永远在线 agent」。它会把 issue
的 `what` 交给 headless adapter。要做 wake envelope，应把 schedule/event selector
接到一个可恢复/常驻 session 的 input seam，而不是继续把每次交易点都变成新
headless task。

## 7. Agent 实际行为模型

在当前 OpenAlice 中，agent 的行为不是 Alice 的 in-process planner 决定的；Alice
只提供工作目录、工具、身份、记录、调度。真正的模型循环在 native CLI 内。

一次交互 session 中，agent 通常会：

1. 读取 CLI 自己支持的 repo instructions（如 `AGENTS.md` / `CLAUDE.md` / skills）。
2. 读取 workspace 文件、issue、README、之前 transcript。
3. 用 shell 调 `alice*` / `traderhub` 或 adapter 的 MCP 工具。
4. 写文件、git commit、推 Inbox。
5. 在同一 PTY/transcript 中继续下一轮对话，直到人类暂停或 session 退出。

一次 headless run 中，agent 通常会：

1. 以本次 prompt 作为任务输入启动；
2. 读取同一套 workspace 文件与 skills；
3. 用 CLI 工具取数据/交易/推 Inbox；
4. 进程退出；launcher 只记录运行状态，不把结论解释成业务状态。

这解释了为什么之前行为实验看起来「每次醒来先大搜索」：从 headless Codex 的视角，
它就是一个 fresh coding-agent turn。除非 prompt/skills 明确规定窄循环，并且系统
有常驻 session wake seam，否则它会自然执行 coding-agent 的默认取向：读上下文、
确认工具、探索环境、再行动。

## 8. UI / API 管理面

浏览器 UI 和 REST API 已经能覆盖大部分 workspace 生命周期：

- 创建 workspace、选择模板与默认 agents。
- spawn / quick-chat / pause / resume / delete interactive sessions。
- 列出 agent availability、读写每个 workspace 的 agent provider config、检查
  credential readiness。
- 调度 headless run、查看跨 workspace 的 headless run 列表与 stdout/stderr tail。
- 打开 Inbox、issue board、workspace terminal。

代码锚点：

- `ui/src/components/workspace/api.ts`
- `ui/src/contexts/WorkspacesContext.tsx`
- `src/webui/routes/workspaces.ts:650-807`
- `src/webui/routes/workspaces.ts:810-976`
- `src/webui/routes/workspaces.ts:1163-1266`
- `src/webui/routes/workspaces.ts:1295-1450`
- `src/webui/routes/headless.ts:1-87`

## 9. 与目标交易 steward 的差距

目标中的流程是：

`market/event selector -> 常驻 steward session -> wake envelope -> 固定 UTA checklist -> decision(no_trade/propose_trade/blocked) -> trade/audit -> inbox`

jieke/dev 的已有支撑与缺口：

| 环节 | 当前支撑 | 缺口 |
|---|---|---|
| market/event selector | issue schedule、headless API、market data tools | 没有专门的 trading event selector / wake queue |
| 常驻 steward session | interactive PTY + resume + SessionRegistry | 没有对现有 session 注入 wake envelope 的 API |
| 固定 checklist | prompt/skills/doc 可规定；UTA CLI 可查 | 没有系统级强制 checklist runner |
| 决策输出 | Inbox、files、git commit、tool logs | 没有结构化 decision ledger schema |
| 交易执行 | `alice-uta` + UTA authz + trading-as-git | paper 可自动 commit；live 人批。缺 steward-specific policy guard |
| 卡死唤醒 | headless watchdog、session resume diagnostics | 没有 interactive session heartbeat/idle wake watchdog；headless task 重启后只会标 interrupted |
| 并发约束 | 全局 headless capacity cap | 没有 per-workspace / per-account lock，交易型 schedule 可能重叠 |
| 成本控制 | 无专门 token budget 面 | 需要按 run/session 记录 model/token/cost |

因此下一步不应再把核心精力放在「能不能用工具」上；这已经有了。应补的是
**常驻行为层**：固定 prompt anatomy、wake envelope、session input、heartbeat、
decision ledger、成本/延迟观测，以及 trading steward 专用的窄工具习惯。

## 10. 文档关系

- 本文：OpenAlice 平台已经怎样支持 workspace agent。
- [steward-agent-working-modes.zh.md](steward-agent-working-modes.zh.md)：交易 agent
  的工作方式/拓扑/旋钮。
- [steward-agent-observation-surface.zh.md](steward-agent-observation-surface.zh.md)：
  agent 在 blind/paper/live 下能看到什么。
- [steward-prompt-anatomy.zh.md](steward-prompt-anatomy.zh.md)：prompt 组成与行为
  影响。
- [managed-workspace-runtime.md](managed-workspace-runtime.md)：packaged app 如何
  内置 runtime，让 workspace agent 可在新机器上启动。
