# Persistent Steward 最小实现方案

> 版本：v0.8（2026-07-10）——PR #122 合入后的 v7 Spark baseline 已完成：
> isolated-stack 10 cells × 6 weeks 共 60/60 wake `done`，exact contract、三方对账、
> cleanup 均通过；但 NVDA 仍低于 bull gate，prompt 不冻结、holdout 不打开。
> shared-stack 六路测试两次被 Codex adapter 对共享 trust config 的并发写竞争阻断，
> 记录为 #124；ledger 语义和 restart amplification 分别记录为 #125/#127。
> 此结果把剩余工作明确拆为 launcher 基础设施、ledger 语义契约和
> trading policy performance 三类；不得再用 prompt 调参掩盖确定性基础设施缺陷。
> 证据摘要见
> [appendix/steward-v7-spark-baseline-20260710.md](appendix/steward-v7-spark-baseline-20260710.md)。
> 版本：v0.7（2026-07-09）——issue #109：`StewardSupervisor.tick()` 此前只能被
> `POST /:id/steward/supervisor/tick` 手动触发，全仓库唯一真实调用者是
> `tools/campaigns/run-cell.mjs` 自己的外部轮询，进程内没有任何定时器/cron/UI
> 会自动调用它——这正是 §7 下面这行长期标注"生产中 supervisor 自己定时 tick"
> 却从未落地的缺口，也是 #107 事故中卡死 wake 的账户锁一直未释放的直接原因之一。
> 新增 `StewardSupervisorScanner`（`src/workspaces/steward/supervisor-scanner.ts`，
> 镜像 `ScheduleScanner` 的自计时 pattern，默认 30s 间隔）在 `service.ts` 里随进程
> 常驻启动，按 `template === 'steward'` 过滤自动 tick 每个 steward workspace；
> 手动路由与自动路径共享同一个提取出来的 `runStewardSupervisorTick`，避免行为分叉。
> §7 该行随后同步更新为已落地状态。
> 版本：v0.6（2026-07-09）——审计 + 补救轮，记录在 PR A-F（本节所指，见上）全部落地
> 之后一次单独会话的复核结果。核心 agent 因 codex 配额耗尽切换为
> `claude-haiku-4-5-20251001`。复核发现的缺口经 maintainer 批准的补救计划（六阶段
> A-F，不同于本文档自己的 PR A-F 编号）处理：补 ANATOMY 引用漂移；从已关闭的
> PR#69 移植硬 guards 进 `paper-auto-push.ts`（止损必填、风险≤8%、禁止摊薄亏损
> 仓）；把 steward 模板 `instruction.md` 升到 v3 caliber prompt（登记见
> [steward-prompt-anatomy.zh.md](steward-prompt-anatomy.zh.md)）；把回测 harness
> 建成真实 checked-in 基础设施 `tools/campaigns/`（取代此前仅活在 scratchpad 的
> 一次性 `stress.mjs`）。真实 wake 现场测试额外发现并修补了本设计文档未预见的
> 5 处行为缺口（issue #91/#92/#93/#98/#101/#103/#105/#107，逐条见
> [steward-prompt-anatomy.zh.md](steward-prompt-anatomy.zh.md) §8）。**截至本版本**：
> issue #105 已合并；issue #107（PR #108）已开出待合并；§11 的 4-cell pilot
> campaign（1 bull/2 bear/1 chop）已备好真实历史数据 cell，首次真实 6-周期跑测在
> issue #107 上中止，待 #108 合并后重跑；§0.1 的交易行为验收 + 成本验收仍未完成。
> 版本：v0.5（2026-07-08）——记录 PR F 已落地范围：scheduled issue
> `kind: steward-wake` 走 persistent wake dispatch，不再走 headless；普通 issue
> schedule 仍保持 headless 行为。
> 版本：v0.4（2026-07-08）——记录 PR E 已落地范围：per-account wake lock、
> manual supervisor tick、ledger completion/timeout/stuck 状态推进、cost state
> 和 supervisor audit log。当时 schedule integration 仍在后续 PR；v0.5 已处理。
> 版本：v0.3（2026-07-08）——记录 PR A-D 已落地范围：steward template、
> context manifest、wake/ledger stores、PTY input seam、manual wake API 和 injector。
> 当时 supervisor / lock / cost / schedule integration 仍在后续 PR；v0.4 已处理前三项。
> 版本：v0.2（2026-07-08）——吸收 maintainer 批注：前置总体验收标准；
> 明确第一版接受 PTY stdin wake 但后续要替换为稳定 seam；`.alice/steward/`
> 的 git 跟踪策略；开发期成本只记录不阻断；第一版先手动 wake、必须建立 steward
> template；补 trading-agent input context 版本管理。
> 版本：v0.1（2026-07-08）
> 地位：**实现前设计稿**，从属于
> [steward-workspace-behavior-contract.zh.md](steward-workspace-behavior-contract.zh.md)
> v0.3。本文把行为契约翻译成最小源码改动路径，供 jieke 继续批注后再进入代码实现。

## 0. 一句话

先不做复杂 trading-agent 编排。第一版只实现一个**单体 persistent steward 最小闭环**：
同一个 workspace interactive session 被结构化 wake envelope 唤醒，agent 完成固定 UTA
checklist 后写 decision ledger，外部 supervisor 通过 ledger 判断本轮完成、记录成本和
轨迹，并在卡死时标记 stuck / timeout。

### 0.1 总体验收标准

工程 smoke 只证明链路跑通，不是最终验收。persistent steward 的总体验收按两层看：

1. **交易行为验收**：trading-agent 必须在丰富回测任务上表现出 regime-aware 的交易
   纪律。牛市应能扩大盈利能力；熊市应能止损、降敞口或持币避险；震荡市应能灵活操作、
   避免过度参与。所有行为都必须经过 UTA checklist、decision ledger 和成本记录。
2. **成本验收**：收益实验必须同时报告 gross PnL 和 net-after-cost PnL。成本至少包括
   Codex/core-agent token、服务器/沙箱租赁、手续费、佣金、交易所费用、滑点等交易摩擦。

参考 [xbtlin/ai-berkshire](https://github.com/xbtlin/ai-berkshire) 的方向：它把投资研究
做成结构化 skill/checklist、强制结论、可复现流程、反偏见机制和精确计算。OpenAlice
这一轮不照搬它的复杂多 agent 编排，但应吸收这些原则来设计 steward template、ledger
schema、回测验收和行为纪律。

## 1. 非目标

这一轮先不做：

- hook / workflow / custom sub-agent / multi-agent 编排。
- 自动寻找交易机会的复杂 market selector。
- live 自动 push；agent 仍只允许 proposal / commit，push 继续由 UTA policy 和人类边界控制。
- 重写 headless 系统；headless 保留为 campaign / 短任务 / fallback。
- 精确 token 计费适配所有模型；拿不到精确 token 时先保留 `null` / estimate 字段。
- 直接追求实盘收益。第一批源码改动先让 persistent steward 工作方式可验证；总体验收
  仍以后续丰富回测和成本控制为准。

## 2. 当前可复用基座

OpenAlice 已有这些能力，可以直接承接实现：

| 能力 | 现状 | 关键代码 |
|---|---|---|
| persistent PTY session | `SessionRegistry` 保存 session record，`SessionPool` 管 live PTY，支持 pause/resume/scrollback | `src/workspaces/session-registry.ts`、`src/workspaces/session-pool.ts`、`src/workspaces/persistent-session.ts` |
| interactive spawn | `POST /api/workspaces/:id/sessions/spawn` 可启动 Codex/Claude/opencode/pi/shell session | `src/webui/routes/workspaces.ts`、`src/workspaces/service.ts` |
| headless fallback | `POST /api/workspaces/:id/headless` 已有一次性自动任务 | `src/webui/routes/workspaces.ts`、`src/workspaces/headless-task.ts` |
| issue schedule | `.alice/issues/*.md` 到期后会 dispatch headless run | `src/workspaces/schedule/scanner.ts` |
| UTA tools | workspace agent 可通过 `alice-uta` 查账户、风险、订单、commit proposal | `src/server/cli.ts`、`src/core/workspace-tool-center.ts` |
| Inbox/audit | agent 可推 Inbox，UTA trade/risk event 会进入 event log | `src/tool/inbox-push.ts`、`src/webui/routes/events.ts` |

关键缺口也很明确：

1. 没有把 wake envelope 注入**已有 interactive PTY session** 的 API。
2. 没有 steward-specific wake store / decision ledger schema。
3. 没有 supervisor 监控 deadline、ledger marker、成本和 stuck 状态。
4. schedule scanner 目前只会发新的 headless run，不会唤醒同一个 session。
5. 没有 per-workspace / per-account trading wake lock。

## 3. 最小新增模块

建议新增一个小而独立的 workspace 子域：

```text
src/workspaces/steward/
├── types.ts              # WakeEnvelope / DecisionLedgerEntry / status schemas
├── wake-store.ts         # file-backed wake records + status updates
├── ledger-store.ts       # read/append/validate workspace decision ledger
├── supervisor.ts         # in-process watchdog: deadlines, liveness, stuck
├── injector.ts           # format wake message and write it to a PTY session
└── cost.ts               # cost field normalization / budget helpers
```

不把这套东西放进 UTA。UTA 仍只负责 broker/account/risk/trading-git；steward 是
workspace runtime 行为层。

## 4. Workspace 文件布局

所有 steward 状态优先写在 workspace repo 内，便于 agent 自己读取、git diff、回测复现。
launcher 侧可以保留运行索引，但业务真相以 workspace 文件为主。

```text
.alice/steward/
├── README.md
├── config.json
├── context-manifest.json
├── state.json
├── wakes/
│   └── <wakeId>.json
├── ledger/
│   └── decisions.jsonl
├── supervisor.jsonl
└── locks/
    └── <accountId>.json
```

### 4.1 `config.json`

```json
{
  "version": 1,
  "agent": "codex",
  "sessionId": null,
  "accountId": "mock-simulator-...",
  "monthlyBudget": {
    "modelUsd": 200,
    "serverUsd": 50
  },
  "costPolicy": {
    "warnAtPct": 80,
    "blockAtPct": 100
  }
}
```

### 4.2 `context-manifest.json`

trading-agent 的 input context 必须版本化。第一版 steward template 就要写入
`context-manifest.json`，让每次 wake / ledger 都能指向当时的行为输入版本：

```json
{
  "version": 1,
  "template": { "name": "steward", "version": "0.1.0" },
  "coreAgent": { "id": "codex", "model": null },
  "wrapperPrompt": { "path": ".alice/steward/README.md", "sha256": "..." },
  "instructions": [
    { "path": "AGENTS.md", "sha256": "..." },
    { "path": "CLAUDE.md", "sha256": "..." }
  ],
  "skills": [],
  "schemas": {
    "wake": 1,
    "decisionLedger": 1
  }
}
```

后续如果 system prompt、skills、template instruction、wake schema、ledger schema 变化，
必须更新 manifest。否则回测结果无法归因。

### 4.3 `wakes/<wakeId>.json`

服务端写入；agent 可读。

```json
{
  "version": 1,
  "wakeId": "2026-07-08T14:00:00Z:aapl-risk-check",
  "status": "queued | injected | done | blocked | error | stuck | timeout",
  "createdAt": "2026-07-08T14:00:00Z",
  "injectedAt": null,
  "deadline": "2026-07-08T14:03:00Z",
  "sessionId": null,
  "envelope": {
    "reason": "scheduled_observe",
    "accountId": "mock-simulator-...",
    "authzLevel": "paper",
    "expectedDecision": "no_trade | propose_trade | blocked"
  }
}
```

### 4.4 `ledger/decisions.jsonl`

agent 写入；supervisor 读取并验证。最小 entry 沿用行为契约：

```json
{
  "version": 1,
  "wakeId": "...",
  "at": "2026-07-08T14:01:23Z",
  "accountId": "...",
  "decision": "no_trade",
  "status": "done",
  "completion": {
    "reason": "checklist complete; no entry signal",
    "evidenceRefs": ["wake:...", "tool:risk", "tool:quote"]
  },
  "checklist": {
    "account": "ok",
    "positions": "ok",
    "orders": "ok",
    "risk": "NORMAL",
    "market": "open",
    "history": "checked"
  },
  "thesis": "...",
  "actions": [],
  "pendingHash": null,
  "invalidation": "...",
  "cost": {
    "model": "codex",
    "inputTokens": null,
    "outputTokens": null,
    "modelCostUsd": null,
    "allocatedServerCostUsd": null,
    "tradingFeesUsd": null,
    "estimatedSlippageUsd": null,
    "totalEstimatedCostUsd": null
  }
}
```

### 4.5 Git 跟踪策略

第一版采用以下策略：

- 进入 workspace git：`.alice/steward/README.md`、`config.json`、
  `context-manifest.json`、`ledger/decisions.jsonl`。
- 不进入 workspace git，或默认写入 `.git/info/exclude`：`state.json`、`locks/`、
  supervisor runtime status。
- wake records 是 input context。开发/回测阶段可以跟踪 `wakes/` 以便复现；如果生产期
  过于嘈杂，至少要把 wake hash/ref 写入 ledger 和 supervisor log。

## 5. PTY wake 注入 seam

当前浏览器 WebSocket 可以向 PTY 写 stdin，但服务端没有一个明确的“把一条 wake message
写入已有 session”的公共 API。最小代码改动：

1. 给 `PersistentSession` 增加公开方法：

```ts
writeInput(input: string | Buffer, opts: { source: 'steward-supervisor' | 'operator' }): void
```

内部复用现有 `term.write`，并写结构化日志。不要通过伪造 WebSocket 消息绕路。

2. 给 `SessionPool` 增加：

```ts
writeToSession(recordId: string, input: string, opts: WriteInputOptions): boolean
```

3. steward injector 只负责格式化 wake message：

```text
<STEWARD_WAKE id="..." deadline="...">
Read .alice/steward/wakes/<wakeId>.json.
Run the fixed UTA checklist.
Append exactly one JSON object to .alice/steward/ledger/decisions.jsonl.
Do not inspect OpenAlice source. Do not call push.
</STEWARD_WAKE>
```

第一版用普通 PTY stdin + Enter 唤醒 Codex interactive session。以后如果 Codex 提供更好
的 session input API，再替换 injector，不改 wake / ledger / supervisor。

这是一条 **v1 seam**，maintainer 已接受用于第一版 smoke。它不是长期最优形态；实现时
必须把 injector 封装清楚，后续可以替换为更稳定的 Codex session input / native API，
而不影响 wake store、ledger store 或 supervisor。

已落地：`PersistentSession.writeInput()` / `SessionPool.writeToSession()` 提供
server-side PTY stdin seam；`src/workspaces/steward/injector.ts` 只格式化
`<STEWARD_WAKE>` message 并通过 `source: 'steward-supervisor'` 写入现有 session。

## 6. HTTP / service API

第一版建议只做 workspace-scoped API：

| Method | Route | 作用 |
|---|---|---|
| `POST` | `/api/workspaces/:id/steward/wakes` | 创建 wake、确保/选择 session、写 wake 文件、注入 PTY |
| `GET` | `/api/workspaces/:id/steward/wakes/:wakeId` | 查看 wake status、deadline、sessionId、ledger entry |
| `GET` | `/api/workspaces/:id/steward/ledger?limit=N` | 查看最近 decision ledger |
| `POST` | `/api/workspaces/:id/steward/supervisor/tick` | 手动 tick（测试/campaign harness 用）；生产中 `StewardSupervisorScanner` 自己定时 tick（issue #109，v0.7） |

已落地：前三个 route 已经在 `src/webui/routes/workspaces.ts` 中实现为手动 wake API。
`supervisor/tick` 在 PR E 落地手动路径；issue #109（v0.7）补上进程内自动定时 tick，
两者共享同一个 `runStewardSupervisorTick`，行为不会分叉。

`POST /wakes` body 就是行为契约里的 `WakeEnvelope` 加少量控制字段：

```json
{
  "reason": "scheduled_observe",
  "accountId": "mock-simulator-...",
  "authzLevel": "paper",
  "deadlineMs": 180000,
  "marketContext": { "symbols": ["AAPL"] },
  "riskContext": { "riskState": "NORMAL", "guards": [] },
  "expectedDecision": "no_trade | propose_trade | blocked",
  "session": {
    "mode": "reuse_or_spawn",
    "agent": "codex"
  }
}
```

### 6.1 Session 选择规则

最小规则：

1. 优先使用 `.alice/steward/config.json.sessionId` 指向的 running session。
2. 如果 session 不存在但 registry 中有 paused record，resume。
3. 如果没有 steward session，spawn 一个新的 interactive session，并用最短 initial prompt
   建立 steward 角色。
4. sessionId 写回 config 和 wake record。

这保持 persistent steward 的目标，同时允许重启后恢复。

已落地规则：PR D 会优先复用 `.alice/steward/config.json.sessionId` 指向的 live session；
如果 registry 中有对应 paused record，则按 adapter resume 能力恢复同一个 launcher
record；否则才 spawn 新的 interactive session，并把 sessionId 写回 config。API 响应中的
`session.reused` / `session.resumed` 用于 smoke 判断是否误开了新的工作流。

## 7. Supervisor 行为

supervisor 是 core-agent 外部的小控制器。第一版只做四件事：

1. **deadline 检查**：到期没有 ledger entry，就把 wake 标成 `timeout`。
2. **ledger 检查**：出现 matching `wakeId` 的 ledger entry，就校验 schema 和
   `completion.reason`，把 wake 标成 `done` / `blocked` / `error`。
3. **liveness 检查**：session 不存在或反复 respawn circuit open，就标 `stuck` 并推 Inbox。
4. **成本记录**：汇总 ledger cost 字段，记录月度 model/server/trading cost estimate。

第一版 supervisor 可以是 Alice 进程里的 interval；不需要新进程。以后如果要硬隔离，再抽
成单独 worker。**已落地（issue #109，v0.7）**：`StewardSupervisorScanner`
（`src/workspaces/steward/supervisor-scanner.ts`）就是这个进程内 interval，镜像
`ScheduleScanner` 的自计时 pattern，默认 30s，随 `service.ts` 启动/关闭。

开发阶段成本策略是**记录和告警，不阻止新 wake**。超过预算时可以标 `warn`、推 Inbox
或写 supervisor log，但不要直接阻断；现阶段记录成本是为了优化，而不是生产限流。

已落地：`src/workspaces/steward/supervisor.ts` 提供 manual tick。它读取 active wake、
匹配 decision ledger、推进 `done` / `blocked` / `error` / `timeout` / `stuck`，释放
account lock，写 `.alice/steward/supervisor.jsonl`，并把聚合成本写入
`.alice/steward/state.json`。第一版成本策略只输出 `warnings`，不阻断新 wake。

## 8. Lock 策略

交易 wake 必须有 per-account lock，避免两个 wake 同时处理同一账户。

第一版：

- `POST /wakes` 时，如果同一 `accountId` 已有 `queued` / `injected` wake，则返回 `409`。
- lock 写到 `.alice/steward/locks/<accountId>.json`，并带 `expiresAt`。
- ledger done / blocked / error 或 timeout 后释放 lock。

这不是 broker lock；broker 安全仍由 UTA guard/risk/authz 负责。这里的 lock 只是避免
agent 行为层重叠。

已落地：`src/workspaces/steward/lock-store.ts` 用 accountId 的 encoded JSON 文件实现
active lock；manual wake API 在写 wake 前 acquire，在 session/inject 失败时释放；supervisor
在 terminal transition 后释放。过期 lock 可被新的 wake 替换，用于恢复 missed tick。

## 9. 与 schedule 的关系

第一版先通过手动 API 做 smoke；之后 schedule scanner 增加 steward-wake 分支：

```text
POST /api/workspaces/:id/steward/wakes
  -> same session receives wake
  -> agent writes ledger
  -> supervisor marks done
```

scheduled issue 支持一种新 frontmatter：

```yaml
kind: steward-wake
accountId: mock-simulator-...
expectedDecision: no_trade
```

后续再让 scanner 遇到 `kind: steward-wake` 时走 `/steward/wakes` 的内部 service seam，
而不是 `dispatchHeadlessTask`。普通 issue 仍走 headless，不回归现有自动化。

已落地：`src/workspaces/issues/declaration.ts` 验证 `kind: steward-wake` 所需的
`accountId` / `authzLevel` / `expectedDecision`；`src/workspaces/schedule/scanner.ts`
遇到该 kind 会调用 `dispatchStewardWake`，用 issue id + fire timestamp 生成 wakeId，
并只在 wake 成功注入后写 schedule marker。`src/workspaces/service.ts` 提供内部
dispatch seam，复用 steward wake store、account lock、session reuse/resume/spawn 和
PTY injector。普通 scheduled issue 仍走 `dispatchHeadlessTask`。

## 10. Smoke 验收

第一轮实现完成后，先跑 smoke，不跑收益实验：

1. 创建/选择一个 steward workspace，使用第一版 `steward` template，启用 Codex。
2. 配置 mock/paper UTA account，authz 为 `paper` 或 `read_only`。
3. `POST /steward/wakes` 注入一个 `expectedDecision: no_trade` 的 wake。
4. 验证同一个 interactive session 被唤醒，而不是新建 headless run。
5. 验证 workspace 里出现：
   - `.alice/steward/wakes/<wakeId>.json`
   - `.alice/steward/ledger/decisions.jsonl`
   - `.alice/steward/supervisor.jsonl`
6. 验证 ledger entry 包含：
   - fixed UTA checklist 摘要
   - `decision`
   - `completion.reason`
   - cost fields
   - context manifest refs / hashes
7. 验证没有 broker push，最多 staged proposal / commit。
8. 验证若 agent 不写 ledger，supervisor 会标 `timeout`。

## 11. 完整回测 / 行为验收

smoke 通过后，再做行为实验。这里开始进入总体验收，而不只是工程 smoke：

- 多个 wake 进入同一个 persistent session。
- 每个 wake 都有 ledger entry 和 completion reason。
- session 不把 OpenAlice source tree 当作日常交易上下文。
- supervisor 可以重建 input -> tool refs -> decision -> cost -> outcome。
- 成本输出能区分 model token、server、交易摩擦。
- per-account lock 能阻止重叠 wake。
- 牛市格子能扩大盈利能力，至少不能因为过度保守系统性错过主要上行。
- 熊市格子能止损、降敞口或持币避险，避免一路加仓亏损仓。
- 震荡格子能控制 over-participation，不因交易频率和止损来回磨损。
- 最终报告必须同时给出 gross PnL、model/server/trading cost、net-after-cost PnL。

## 12. 实现顺序

建议按这个顺序拆 PR：

1. **PR A：steward template + context manifest**
   - built-in `steward` template、最小 wrapper prompt、ledger instructions、
     `context-manifest.json` 生成/更新规则。
   - 落地位置：`src/workspaces/templates/steward/` 负责 workspace 初始文件布局；
     `src/workspaces/context-injector.ts` 在 persona/skills 注入后生成
     `.alice/steward/context-manifest.json`，把 wrapper prompt、root instructions、
     injected skills 和 schema version 固化到 workspace 首次提交。
2. **PR B：schema + workspace file stores**
   - `types.ts`、`wake-store.ts`、`ledger-store.ts`、单元测试。
   - 落地位置：`src/workspaces/steward/`。这一层只定义 schema 和 workspace
     文件读写，不选择 session、不注入 PTY、不做 supervisor；后续 PR 通过这些 store
     操作 `.alice/steward/wakes/<wakeId>.json` 和
     `.alice/steward/ledger/decisions.jsonl`。
3. **PR C：PTY input seam**
   - `PersistentSession.writeInput`、`SessionPool.writeToSession`、测试。
   - 落地位置：`src/workspaces/persistent-session.ts` 和
     `src/workspaces/session-pool.ts`。这一层只提供 server-side PTY stdin
     写入 seam，并记录 `source` provenance；wake message 格式化和 HTTP API
     仍留给 PR D。
4. **PR D：steward wake API + injector**
   - `POST /steward/wakes`、session reuse/spawn、wake file、manual smoke。
   - 落地位置：`src/webui/routes/workspaces.ts` 暴露 manual wake / wake read /
     ledger read route；`src/workspaces/steward/injector.ts` 封装 PTY wake message；
     route 只做手动 wake、session 选择、wake status 更新和注入，不做 supervisor
     deadline / lock / cost aggregation。
5. **PR E：supervisor + lock + cost**
   - timeout/stuck/done detection、lock file、cost summary。
   - 落地位置：`src/workspaces/steward/lock-store.ts`、`cost.ts`、
     `supervisor.ts`；`src/webui/routes/workspaces.ts` 的 manual wake route acquire
     account lock，`POST /steward/supervisor/tick` 执行一轮检测和成本聚合。
6. **PR F：schedule integration**
   - scheduled issue `kind: steward-wake` 走 persistent wake，不走 headless。
   - 落地位置：`src/workspaces/issues/declaration.ts` 扩展 issue frontmatter；
     `src/workspaces/schedule/scanner.ts` 按 `kind` 分流；`src/workspaces/service.ts`
     提供 schedule -> steward wake 的内部 dispatch。

## 13. 已裁决问题

1. 第一版接受“普通 PTY stdin + Enter”作为 Codex interactive wake 注入 seam，但 injector
   必须封装好，后续替换为更稳定形式。
2. `.alice/steward/` 的 git 策略：ledger / config / README / context manifest 跟踪；
   lock / runtime status 不跟踪或 exclude。
3. 开发阶段成本只记录和告警，不因预算超过而阻止新 wake。
4. 第一版 schedule integration 先不做；smoke 先保留手动 API。
5. steward template 第一版必须建立，不能只复用 chat template。
6. trading-agent input context 必须版本管理，包括 system/wrapper prompt、skills、
   workspace instructions、schema 和 template 版本。
7. **Claude Code Bash 权限预授权（issue #92，2026-07-08 裁决）**：`claude` adapter 的
   `AUTOTRUST_SETTINGS`（`src/workspaces/adapters/claude.ts`）追加
   `permissions.allow`，为 `CLI_TOOLS_SKILLS`（`context-injector.ts`）里教给 agent 的
   5 个 CLI 二进制各配一条 `Bash(<tool> *)` 规则（`alice` / `alice-analysis` /
   `alice-uta` / `alice-workspace` / `traderhub`）。**范围选择：全局生效于所有
   `claude` spawn（interactive + headless），不区分 template**——原因：
   `SpawnContext`（`cli-adapter.ts`）不携带 template 身份，要把这条规则限定到只在
   steward 生效，需要把 template 标识穿透 adapter 接口和所有调用点，属实质性重构；
   而 chat / steward 这两个当前唯一的 `injectTools: true` template 本来就无条件教
   agent 用这 5 个 CLI，预授权 Bash 调用并不构成新增能力（能力早已通过 skill 教
   给 agent），因此选全局是"够用且改动最小"的一侧，不是偷懒 — 这与
   `AUTOTRUST_SETTINGS` 里原有的 `enableAllProjectMcpServers` 先例（同样全局生效）
   一致。经真实 PTY 探测验证（claude 2.1.202）：`Bash(<tool> *)` 通配写法一条规则
   即可覆盖该 CLI 的所有 subcommand family（`account` / `order` / `market` /
   `git` / ...），不再逐个 family 弹一次审批。
   **未解决部分**：ledger 写入用的 `cat >> decisions.jsonl <<'EOF' ... EOF`
   heredoc，一旦 body 里出现 JSON 花括号+引号，会命中 Claude Code 一个独立的
   "Contains brace with quote character (expansion obfuscation)" 静态分类 ——
   这是命令解析阶段的 too-complex 判定，发生在任何 `permissions.allow` 规则匹配
   **之前**，经验证即使已有匹配的 `Bash(cat *)` 规则也仍然弹窗，且只给
   Yes/No（没有"不再询问"选项）。改用 `printf` 单行写法可以避开这个分类器，
   但会撞上另一个独立的、看起来同样绕不过 `permissions.allow` / `additionalDirectories`
   的"Output redirection to '...' blocked"（本 session 首次向该目录写文件）确认框。
   唯一在真实探测里彻底不弹窗的路径是**完全不走 Bash**——改用 Claude Code 原生
   `Write`/`Edit` 工具（对已存在的 ledger 文件走 Read→Edit 或 Read→Write 拼接新行），
   同时在 `permissions.allow` 里加裸的 `"Write"` / `"Edit"`（无路径参数；
   `Write(decisions.jsonl)` / `Write(**)` 这类带路径的写法在这个版本里未生效）。
   这个动作本身是安全的（steward 已经被要求必须写 ledger），但 `"Write"` /
   `"Edit"` 裸授权的影响面比 5 条 Bash CLI 规则更宽——会连带免除该 session 里
   *任何*文件的首次创建/编辑确认，不只是 ledger 一个文件——所以这次改动没有
   顺带把它写进 `AUTOTRUST_SETTINGS`，也没有去改 `steward/files/instruction.md`
   第 5 步的写法（把"改用 Write 工具"这个决定留给下一次改动，连同这条记录一起
   交给 maintainer 裁决）。

8. **裸 Write/Edit 授权（issue #101 campaign harness 现场触发，2026-07-09
   maintainer 裁决：直接授权）**：第 7 点标记为"留给 maintainer 裁决"的问题
   在 issue #101 的 campaign harness 真实跑格子时现场复现——`--agent claude`
   的 wake 卡在 ledger 写入这一步，没有人应答那个批准提示。maintainer 明确
   选择"直接授权更宽的 Write/Edit 权限"这条路（而非改用 codex 或新增专用 CLI
   子命令）。`AUTOTRUST_SETTINGS` 追加裸 `"Write"`、`"Edit"`（`PRETRUSTED_FILE_TOOLS`
   常量，`src/workspaces/adapters/claude.ts`）。**仅授权本身不够**——steward
   `instruction.md` 第 5 步（ledger 写入）必须明确指示 agent 用 Write/Edit
   工具而不是 Bash heredoc，否则这条授权形同虚设；该指令更新在 issue #98 一并
   处理。
