# Steward Workspace 行为契约

> 版本：v0.4（2026-07-11）——对齐 Steward Plan v2：明确 proposal-first、Decision Intent、
> mandatory Risk Envelope、低频定位，以及判断与实际订单 sizing/execution 的责任分离。
> 版本：v0.3（2026-07-08）——吸收 maintainer 第二轮批注：明确现阶段先做单体
> persistent steward 的最小闭环，不展开复杂编排；把每次完成的原因/证据纳入
> ledger；把 token、服务器和交易成本作为一开始就要记录的成本边界。
> 版本：v0.2（2026-07-08）——吸收 maintainer 批注：补术语约定、版本化输入、
> decision point 定义、per-wake / whole-run 完成边界、外部监督设备与
> trading-agent input/output 轨迹管理。
> 版本：v0.1（2026-07-08）
> 地位：**当前目标行为契约**，从属于 [steward-plan.zh.md](steward-plan.zh.md)。本文定义
> workspace 内 trading agent 应如何观察、判断、提案、记录和交付；它不授权 paper/live
> 运行，也不定义 UTA 的 broker mutation 实现。旧工作方式文档已归档。

## 0. 术语约定

本文用以下词汇区分「开发 OpenAlice」和「在 OpenAlice 里交易」这两件事：

1. **OpenAlice**：TraderAlice 开发的 repo，也是我们当前项目的基座。jieke 说
   OpenAlice 时，可能指 repo、launcher、workspace、UTA、工具面、UI、Guardian，
   或这些能力组成的整体。
2. **jieke / human**：既是开发者也是用户。他会从两个方向指导系统：developer
   方向关注架构、代码、文档、测试与安全边界；user 方向关注产品体验、交易行为、
   成本、延迟与可控性。
3. **code-agent**：与 jieke 协作开发 OpenAlice 的开发助手，包括 Codex、Claude Code
   等。code-agent 的世界是源码 repo、issue、PR、测试、文档和实现细节。
4. **trading-agent**：运行在 OpenAlice workspace 里的交易 agent。它接收 workspace
   提供的结构化交易上下文，决定 `no_trade` / `propose_change` / `reduce_risk` / `blocked`，
   再把结构化 Decision Intent 交回 OpenAlice / UTA 的授权、risk envelope、sizing、审计和
   执行链。它是对 core-agent 的交易工作包装，不是一个裸的 general coding agent。
5. **core-agent**：trading-agent 的内核，可以是任何 general agent；当前目标内核是
   Codex。但 core-agent 不能裸跑：必须用 Codex 原生支持的 instruction、skill、
   workspace、session、tool 和 prompt 方式包装，让它在 workspace 中表现为
   trading-agent。
6. **steward**：本文中的目标 trading-agent 角色。它像一个长期值守的交易台成员：
   持续存在、被事件唤醒、按固定检查表行动、记录每次输入/输出/决策，而不是像
   code-agent 一样把每次 wake 当作新的源码任务。

### 0.1 现阶段范围

本文当前只收敛**单体 persistent steward 的最小决策闭环**：一个 core-agent，被
trading-agent wrapper 包装，在一个 workspace session 里持续工作，被 wake envelope
唤醒，跑固定 UTA checklist，写 decision ledger，并由外部 supervisor 监控。复杂 agent/bot
拓扑不是当前方向；任何 autonomy 必须先通过 Plan v2 的独立安全门。

## 1. 一句话

Steward agent 醒来时，应该感受到的世界是**它所在的交易 workspace**：已经整理好的
账户、风险、市场、事件、历史决策和可用工具，而不是 OpenAlice 源码仓库、launcher
实现细节、端口拓扑，或一次新的泛化 coding task。

## 2. Workspace 是 agent 的世界

agent 的工作根目录是一个 steward workspace repo。这个 repo 应该像一个小型交易台，
而不是 OpenAlice 的源码镜像。

agent 可依赖的世界由四类输入组成：

| 层                 | 形式                                                                     | 作用                                               |
| ------------------ | ------------------------------------------------------------------------ | -------------------------------------------------- |
| 静态操作手册       | workspace 内 `AGENTS.md` / `CLAUDE.md` / skills / 模板说明               | 告诉 agent 它是谁、能用哪些工具、禁止哪些越界行为  |
| 结构化状态         | workspace 内的账户绑定、授权档、风险策略、观察报告、历史 decision ledger | 让 agent 不必重新探索环境，也不必读 OpenAlice 源码 |
| 本次 wake envelope | 外部 selector 注入的事件、市场快照引用、账户快照引用、deadline、wakeId   | 告诉 agent 这次为什么醒来、只需处理哪件事          |
| 实时工具结果       | `alice-uta` / `alice-workspace` / `traderhub` / `alice` CLI              | 获取最新账户、订单、行情、风险、审计状态           |

反过来，以下内容不应成为 steward 的日常上下文：

- OpenAlice 源码目录、`src/` 实现、web/UTA 端口、内部 token、human-only HTTP route。
- 未经整理的大段仓库文档和历史对话。
- 让 agent 自己猜测「现在该看什么」的大而泛任务描述。
- 直接要求它“搜索整个世界”或“理解 OpenAlice 是怎么实现的”。

如果 agent 需要知道某个交易事实，应由 workspace 文件或工具结果给出；如果它需要知道
某个产品实现事实，通常说明这次 wake 不是交易 steward wake，而是 coding task。

### 2.1 版本化行为输入

这些 workspace 输入不是一次性脚手架，而是 trading-agent 行为的一部分。它们会频繁
变化，必须被版本化、可回溯、可实验比较：

| 输入                                   | 版本化原因                                              |
| -------------------------------------- | ------------------------------------------------------- |
| workspace `AGENTS.md` / `CLAUDE.md`    | 定义 agent 身份、工具习惯、禁止动作和工作边界           |
| skills / 模板说明                      | 定义如何使用工具、如何读取结构化上下文、如何产出 ledger |
| trading-agent system / wrapper prompt  | 把 core-agent 包装成 trading-agent，是最强软行为旋钮    |
| wake envelope schema                   | 决定每次醒来看到的结构化事件和任务边界                  |
| UTA checklist / decision ledger schema | 决定安全检查和行为分析能否稳定复现                      |

每次调整这些输入，都应留下版本号或 hash、变更原因、预期行为影响，以及关联的
smoke/campaign/生产观察结果。否则我们无法判断交易行为变化来自模型、行情、prompt、
workspace instruction，还是工具返回。

## 3. 目标工作形态：常驻 steward

生产目标是一个长期存在的 workspace session：

```text
market/event selector + supervisor
  -> persistent steward session
  -> wake envelope
  -> fixed UTA checklist
  -> structured Decision Intent
  -> optional proposal stage/commit
  -> deterministic risk envelope + sizing
  -> inbox/audit
```

这和过去的 headless campaign 模式不同：

| 维度         | Headless campaign / Mode 1          | Persistent steward / 目标                                                                                                                                            |
| ------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进程         | 每个决策点启动一次 agent            | 一个 session 长期存在，可被唤醒                                                                                                                                      |
| 上下文       | fresh run 读 prompt / skills / 文件 | 保留 core-agent 原生 system/developer prompt、workspace instructions/skills、trading-agent wrapper prompt、transcript、workspace state，只把本次 envelope 当作窄输入 |
| 单次完成边界 | 进程退出                            | decision ledger marker                                                                                                                                               |
| 整体运行边界 | harness 跑完预设区间 / 决策点       | proposal-first 持续观察；只有另行授权的 bounded paper 才可执行                                                                                                       |
| 适用场景     | 回测、短任务、可重复 campaign       | 日/周级研究、组合判断、提案与经批准的 bounded paper                                                                                                                  |
| 主要风险     | 每次像 coding task 重新探索         | 需要 supervisor/watchdog/ledger/锁来约束常驻状态                                                                                                                     |

headless 仍可作为评估、回放、短任务和 fallback 使用；persistent session 也不等于实时交易
引擎。PTY 适合日/周级研究和组合判断，低延迟触发、撤权、risk action 和 broker control 必须
留在确定性控制面。

### 3.1 Decision point 怎么定义

在 headless campaign / 回测里，decision point 由 harness / schedule / 回测切片定义，
不是 agent 自己决定。典型形式是：给定标的、时间区间、bar 粒度和窗口长度后，harness
在每个预设切片边界唤醒 agent 一次，并把截至当时的 tape / 结构化观察传入。agent
只在这些点上决策。

在 persistent steward 里，decision point 改名为 **wake** 更准确：它可以来自 schedule、
market event、risk event、user request 或 supervisor recovery。selector 决定何时唤醒；
agent 决定本次 wake 的交易意图或 `no_trade`。

### 3.2 判断与执行必须分开

Steward 首先产出 Decision Intent，而不是把 prompt 中的仓位偏好直接翻译成任意数量的订单。
Intent 至少应表达方向、目标暴露范围、信心、最大可接受损失、失效条件、期限和证据快照。

这是 D1 的目标契约，不是假装当前 schema 已经完成迁移。当前 ledger v2 仍使用
`no_trade | propose_trade | blocked` 并可记录实际 order action；在新 schema 获批前，现有
runtime 继续按当前严格契约记账，不自行发明字段。

UTA 或未来独立的确定性 sizing 层负责把 intent 约束为实际 proposal：

- 读取账户 mandatory Risk Envelope；
- 计算 max position、daily loss、drawdown、symbol/asset scope 和剩余预算；
- 缺失关键风险配置时 fail closed；
- 输出允许的数量、拒绝原因或只允许减风险的动作；
- 在任何 broker mutation 前再次检查授权、risk state 和 revoke/admission 状态。

因此“agent 想买 70%”不是执行规格，也不是风险许可。Guard 拒绝只能证明 containment 生效，
不能把该决策记成策略成功。

### 3.3 Context window 包含什么

persistent steward 不是没有 system prompt / skills。相反，它的 context stack 更明确：

1. core-agent 原生的 system/developer prompt（例如 Codex 自身的工作规则）。
2. trading-agent wrapper prompt（把 core-agent 包装成交易工作者）。
3. workspace `AGENTS.md` / `CLAUDE.md` / skills / 模板说明。
4. 持续 session 的 transcript / resume state。
5. workspace 文件状态：账户绑定、授权档、策略、ledger、观察报告。
6. 本次 wake envelope。
7. 本次实时工具结果。

目标不是让它不读 instruction，而是让 instruction 版本化、稳定、短而强；每次 wake
只新增窄 envelope 和必要工具结果，不让 agent 重新把 OpenAlice 源码当作世界来探索。

### 3.4 完成边界有两层

**单次 wake 的完成边界**是 decision ledger marker：本轮完成、阻塞、报错或 no-trade，
都必须写成结构化 ledger。

> **写路径（issue #140）**：steward **不直接**写 `decisions.jsonl`。它只把本次决策对象
> 写到 `.alice/steward/drafts/<wakeId>.json`（native Write/Edit），再运行
> `validate-ledger.mjs <wakeId>`——validator 是 ledger 的唯一受支持 writer，负责严格校验并
> **原子**提交（append 或同 wake 原位 replace）+ 发布 finalize marker。原因：agent 直接
> truncate+rewrite decisions.jsonl 的半写窗口会被 supervisor 采样成假 corruption。直接手改
> ledger 仍按 corruption 论处（#134 检测不削弱）。

**整体运行边界**按场景区分：

- 回测 / campaign：跑完预设回测区间、decision points 和最终报告后自然结束。
- proposal-first steward：长期观察，但每次只交付 decision/proposal，直到 jieke 打断、账户进入
  禁止状态，或 supervisor 判断必须停机。
- bounded paper：仅在独立授权后运行；Risk Envelope 缺失、撤权、风险状态变化或对账失败都
  立即停止后续风险增加。

因此 `decision ledger marker` 不是整个 steward 生命周期的结束，只是一次 wake 的
可观测完成信号。

每次写出完成 marker 时，trading-agent 也必须说明**为什么它认为本次 wake 已完成**：
是因为已完成 checklist 后判定 `no_trade`，还是已经生成 staged proposal，还是遇到
明确阻塞/错误。这个完成理由和证据必须进入 decision ledger，而不是只留在屏幕文本里。

### 3.5 外部监督设备

persistent steward 需要一个在 core-agent 外部的 supervisor / watchdog。它不替 agent
交易，也不绕过 UTA 授权；它负责观察、唤醒和保护运行边界：

- 记录每次 wake 的输入、版本、工具调用、输出、ledger、耗时和成本，用作行为优化轨迹。
- 监控 session liveness、最后一次 ledger marker、deadline、连续错误和异常空转。
- 在假死、超时或无 ledger marker 时标记 `stuck` / `timeout`，并按策略唤醒、重试、
  暂停或推 Inbox 给 jieke。
- 维护 per-workspace / per-account lock，避免两个 wake 同时管理同一账户风险。

### 3.6 成本边界

成本不是事后优化项，必须从第一天进入记录与评估。否则交易收益可能被 agent
推理成本、基础设施成本或交易摩擦吞掉。

初始预算假设：

- Codex / core-agent 交易推理 token 成本：约 `200 USD / month`。
- 服务器 / sandbox / 托管资源租赁成本：约 `50 USD / month`。
- 交易成本：从一开始记录手续费、佣金、交易所费用、滑点和借贷/融资等可得摩擦。

supervisor 和 ledger 都要保留成本字段。拿不到精确值时可以填 `null` 或估算字段，但
schema 不能缺失；后续收益实验必须能同时回答 PnL 和 net-after-cost PnL。

## 4. Wake envelope

每次唤醒必须是窄输入，而不是自然语言大任务。envelope 至少包含：

```json
{
  "wakeId": "2026-07-08T14:00:00Z:aapl-risk-check",
  "reason": "scheduled_observe | market_event | risk_event | user_request",
  "accountId": "mock-simulator-...",
  "authzLevel": "read_only | paper | small_live | limited_autonomy",
  "deadline": "2026-07-08T14:03:00Z",
  "marketContext": {
    "symbols": ["AAPL"],
    "snapshotRef": "workspace path or tool ref",
    "barRefs": ["..."]
  },
  "riskContext": {
    "riskState": "NORMAL",
    "guards": ["max-drawdown", "max-position-size"]
  },
  "expectedDecision": "no_trade | propose_trade | blocked"
}
```

实现可以调整字段名，但语义不能丢：**为什么醒来、看哪个账户、看哪些处理好的交易信息、
权限是什么、何时结束、结果写到哪里**。

## 5. 固定 UTA checklist

每个交易 wake 都先跑同一套最小检查，除非 envelope 明确是纯研究/复盘任务：

1. 账户：`alice-uta account info` / cash / net liquidation。
2. 持仓：portfolio / current exposure / pending staged status。
3. 订单：open orders / pending commits / recent fills。
4. 风险：`risk status` / guards / HALT or READ_ONLY state。
5. 市场：market clock / tradable contract / quote or approved bar refs。
6. 历史：最近 decision ledger、相关 open thesis、last action/outcome。

checklist 的目的不是制造长搜索，而是防止 agent 在不知道账户和风险状态时交易。检查结果
应被摘要进 decision ledger，而不是只留在屏幕滚动里。

## 6. Input / output 轨迹

trading-agent 的输入和输出都必须被稳定记录和管理；这是我们分析、优化、复盘其行为的
关键。一次 wake 至少应形成一条可追溯链：

```text
runId / wakeId
  -> versioned inputs
  -> structured market/account/risk refs
  -> tool call transcript refs
  -> decision ledger
  -> optional staged commit / broker outcome
  -> inbox/audit refs
```

最小记录范围：

| 类别 | 记录内容                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------- |
| 版本 | core-agent/model、trading-agent prompt、workspace instruction/skills、wake schema、ledger schema                    |
| 输入 | wake envelope、market/account/risk snapshot refs、历史 ledger refs、human/user request                              |
| 过程 | UTA checklist 结果、关键工具调用 refs、错误/重试/超时                                                               |
| 输出 | `no_trade` / `propose_trade` / `blocked`、thesis、invalidation、actions、pendingHash、completion reason             |
| 结果 | push/filled/rejected/risk transition/outcome refs；若无交易，也记录 `no_trade` 的理由                               |
| 成本 | latency、model/token/cost、server cost、trading fees/commission/slippage；拿不到精确值时也要留空字段，不能丢 schema |

这些轨迹属于 supervisor 和 ledger 的共同职责：ledger 给出交易决策真相，supervisor
给出运行与成本真相。

## 7. Decision ledger 是单次 wake 的完成边界

常驻 session 不能靠「屏幕看起来没动了」判断一轮完成。每个 wake 必须追加一条结构化
decision ledger（`version: 2`，issue #125）。最小字段：

```json
{
  "version": 2,
  "wakeId": "...",
  "at": "2026-07-08T14:01:23Z",
  "accountId": "...",
  "decision": "no_trade | propose_trade | blocked",
  "status": "done | blocked | error",
  "completion": {
    "reason": "why the agent believes this wake is complete",
    "evidenceRefs": ["checklist:risk", "tool:quote", "ledger:previous"]
  },
  "checklist": {
    "account": "ok",
    "positions": "ok",
    "orders": "ok",
    "risk": "NORMAL",
    "market": "open",
    "history": "checked"
  },
  "thesis": "short, evidence-backed rationale",
  "actions": [
    {
      "kind": "order_place",
      "aliceId": "mock-simulator-.../ASSET-A",
      "params": { "action": "BUY", "orderType": "MKT", "totalQuantity": "50" },
      "commitHash": "deadbeef",
      "outcome": "executed"
    }
  ],
  "pendingHash": null,
  "invalidation": "what would make this wrong",
  "cost": {
    "model": "if available",
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

`no_trade` 是正式决策，不是空结果。没有 thesis、entry signal、invalidation、risk budget
时，正确输出就是 `no_trade` 并写明原因。`no_trade`/`blocked` 的 `actions` 为空数组。

### v2 ledger 契约（issue #125，三条硬规则）

1. **`pendingHash` 严格「待批准」语义（D1）**：`pendingHash` 只表示「当前正在等待批准
   的 stage hash」。一旦有 action `outcome` 为 `executed`（auto-push 成功即终态），
   `pendingHash` **必须为 `null`**——commit 出处放进 `actions[].commitHash`，不放
   `pendingHash`。这样 ledger↔UTA 对账退化为一次等值比较。

2. **`actions` 是版本化的判别联合（D2）**：每个 action 是一个对象，不是自由文本串（v2
   拒绝自由文本串）。`kind` ∈ {`order_place`, `order_commit`, `order_modify`,
   `order_cancel`, `position_close`, `git_reject`}；记录精确 `aliceId`（`git_reject`
   除外）、`params` 摘要、可用时的 `commitHash`，以及真实 guard/broker `outcome` ∈
   {`executed`, `awaiting_approval`, `policy_denied`, `failed`}（对应 prompt 已教的
   四个 `autoPush.status` 分支），`policy_denied` 时附非空 `violations`。读路径对 v1
   历史保持宽松（v1 的 `actions` 保留为 `unknown[]`），写路径严格 v2。

3. **每个 wakeId 恰好一条终态记录，first-wins（D3）**：重复 wakeId 是校验错误；reader
   取**第一条**（从此前未文档化的 last-wins 改为 first-wins），后续重复条目作为
   violation 上报给 supervisor/报表。没有修订机制——事后追加永远不能改变已记录的决策
   （tamper-evident 审计面）。要更正就原地改那一行，不要追加第二行。

`completion.reason` 是本轮完成判定的最短解释；`completion.evidenceRefs` 指向它依据的
checklist 项、工具结果、ledger 记录或 staged commit。supervisor 可以用它判断 agent
是不是只写了 marker，还是确实完成了本次 wake 的闭环。

如果超时没有 ledger marker，外部 supervisor 应把 wake 标成 `stuck` 或 `timeout`，而不是
从 Codex/Cli 屏幕文本里猜结论。

## 8. 允许和禁止的行动

允许：

- 读取 workspace 内的操作手册、历史报告、decision ledger、结构化输入。
- 通过 `alice-uta` / `traderhub` / `alice-workspace` / `alice` CLI 取信息。
- 在授权档允许时 stage proposal 并 commit，带清楚 thesis、risk intent 和 invalidation。
- 把报告或需要人看的事项推 Inbox。

禁止：

- 直接 curl Alice/UTA 的 human-only API 或扫本机端口绕过工具面。
- 读取或修改 OpenAlice 源码来完成交易 wake。
- 自己给自己提高 `authzLevel`、改账户上限、改 guard 配置。
- 调用或寻找 `push` 能力。agent 永远不拿 broker push。
- 把 prompt 中的 exposure 目标当成硬风险许可，或在账户缺少 mandatory Risk Envelope 时
  请求 autonomous execution。
- 在没有 checklist 和 ledger 的情况下结束一轮。
- 用叙述替代证据；声称某个操作做不到时，必须有实际命令退出码/报错支撑。

这些禁止项来自已归档的 [steward-security-uta-auth.zh.md](steward-security-uta-auth.zh.md) 和
[appendix/steward-p2-e2e-observation.md](appendix/steward-p2-e2e-observation.md) 的
真实行为教训。

## 9. 与既有文档的关系

- [openalice-agent-support.zh.md](openalice-agent-support.zh.md)：平台已有能力与缺口。
- [steward-persistent-loop-implementation.zh.md](steward-persistent-loop-implementation.zh.md)：
  把本文契约翻译成最小源码改动路径、API、文件布局、supervisor 与验收 smoke。
- [steward-agent-working-modes.zh.md](steward-agent-working-modes.zh.md)：已归档的旧工作方式/拓扑/旋钮记录。
- [steward-agent-observation-surface.zh.md](steward-agent-observation-surface.zh.md)：已归档的 blind replay 观察面记录。
- [steward-prompt-anatomy.zh.md](steward-prompt-anatomy.zh.md)：prompt 版本与行为影响；本文规定 wake/prompt 应服务于窄循环，而不是泛化 coding task。
- [steward-plan.zh.md](steward-plan.zh.md)：当前方向、不变量、阶段授权与停止条件。
