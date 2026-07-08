# Steward Workspace 行为契约

> 版本：v0.2（2026-07-08）——吸收 maintainer 批注：补术语约定、版本化输入、
> decision point 定义、per-wake / whole-run 完成边界、外部监督设备与
> trading-agent input/output 轨迹管理。
> 版本：v0.1（2026-07-08）
> 地位：**目标行为契约**，从属于 [steward-plan.zh.md](steward-plan.zh.md) 的 I1-I9
> 不变量，并细化 [steward-agent-working-modes.zh.md](steward-agent-working-modes.zh.md)
> 的「单体 steward」工作方式。本文记录 maintainer 对 workspace 内交易 agent 行为的
> 最新裁决：生产形态应是**常驻 workspace steward**，不是每个交易点重新启动一次
> coding-agent headless run。
>
> 本文不直接修改冻结计划 P4 的验收标准；若后续实现把 P4 从 headless observe run
> 改成常驻 steward loop，需要按 [steward-plan.zh.md](steward-plan.zh.md) 的变更管理
> 升版。本文先作为实现前的行为真源。

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
   提供的结构化交易上下文，决定 `no_trade` / `propose_trade` / `blocked` 或交易计划，
   再把计划交回 OpenAlice / UTA 的授权、guard、审计和执行链。它是对 core-agent 的
   交易工作包装，不是一个裸的 general coding agent。
5. **core-agent**：trading-agent 的内核，可以是任何 general agent；当前目标内核是
   Codex。但 core-agent 不能裸跑：必须用 Codex 原生支持的 instruction、skill、
   workspace、session、tool 和 prompt 方式包装，让它在 workspace 中表现为
   trading-agent。
6. **steward**：本文中的目标 trading-agent 角色。它像一个长期值守的交易台成员：
   持续存在、被事件唤醒、按固定检查表行动、记录每次输入/输出/决策，而不是像
   code-agent 一样把每次 wake 当作新的源码任务。

## 1. 一句话

Steward agent 醒来时，应该感受到的世界是**它所在的交易 workspace**：已经整理好的
账户、风险、市场、事件、历史决策和可用工具，而不是 OpenAlice 源码仓库、launcher
实现细节、端口拓扑，或一次新的泛化 coding task。

## 2. Workspace 是 agent 的世界

agent 的工作根目录是一个 steward workspace repo。这个 repo 应该像一个小型交易台，
而不是 OpenAlice 的源码镜像。

agent 可依赖的世界由四类输入组成：

| 层 | 形式 | 作用 |
|---|---|---|
| 静态操作手册 | workspace 内 `AGENTS.md` / `CLAUDE.md` / skills / 模板说明 | 告诉 agent 它是谁、能用哪些工具、禁止哪些越界行为 |
| 结构化状态 | workspace 内的账户绑定、授权档、风险策略、观察报告、历史 decision ledger | 让 agent 不必重新探索环境，也不必读 OpenAlice 源码 |
| 本次 wake envelope | 外部 selector 注入的事件、市场快照引用、账户快照引用、deadline、wakeId | 告诉 agent 这次为什么醒来、只需处理哪件事 |
| 实时工具结果 | `alice-uta` / `alice-workspace` / `traderhub` / `alice` 或 workspace MCP | 获取最新账户、订单、行情、风险、审计状态 |

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

| 输入 | 版本化原因 |
|---|---|
| workspace `AGENTS.md` / `CLAUDE.md` | 定义 agent 身份、工具习惯、禁止动作和工作边界 |
| skills / 模板说明 | 定义如何使用工具、如何读取结构化上下文、如何产出 ledger |
| trading-agent system / wrapper prompt | 把 core-agent 包装成 trading-agent，是最强软行为旋钮 |
| wake envelope schema | 决定每次醒来看到的结构化事件和任务边界 |
| UTA checklist / decision ledger schema | 决定安全检查和行为分析能否稳定复现 |

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
  -> decision ledger entry
  -> optional stage/commit
  -> inbox/audit
```

这和过去的 headless campaign 模式不同：

| 维度 | Headless campaign / Mode 1 | Persistent steward / 目标 |
|---|---|---|
| 进程 | 每个决策点启动一次 agent | 一个 session 长期存在，可被唤醒 |
| 上下文 | fresh run 读 prompt / skills / 文件 | 保留 core-agent 原生 system/developer prompt、workspace instructions/skills、trading-agent wrapper prompt、transcript、workspace state，只把本次 envelope 当作窄输入 |
| 单次完成边界 | 进程退出 | decision ledger marker |
| 整体运行边界 | harness 跑完预设区间 / 决策点 | paper/live-like 持续运行，直到 jieke 手动停止、人类风险动作要求停止、或 supervisor 停机 |
| 适用场景 | 回测、短任务、可重复 campaign | 真实 paper/live-like 交易工作方式 |
| 主要风险 | 每次像 coding task 重新探索 | 需要 supervisor/watchdog/ledger/锁来约束常驻状态 |

headless 仍可作为评估、回放、短任务和 fallback 使用；它不再是目标 production steward
行为的默认解释。

### 3.1 Decision point 怎么定义

在 headless campaign / 回测里，decision point 由 harness / schedule / 回测切片定义，
不是 agent 自己决定。典型形式是：给定标的、时间区间、bar 粒度和窗口长度后，harness
在每个预设切片边界唤醒 agent 一次，并把截至当时的 tape / 结构化观察传入。agent
只在这些点上决策。

在 persistent steward 里，decision point 改名为 **wake** 更准确：它可以来自 schedule、
market event、risk event、user request 或 supervisor recovery。selector 决定何时唤醒；
agent 决定本次 wake 的交易动作或 `no_trade`。

### 3.2 Context window 包含什么

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

### 3.3 完成边界有两层

**单次 wake 的完成边界**是 decision ledger marker：本轮完成、阻塞、报错或 no-trade，
都必须写成结构化 ledger。

**整体运行边界**按场景区分：

- 回测 / campaign：跑完预设回测区间、decision points 和最终报告后自然结束。
- paper / 小额实盘：长期运行，直到 jieke 打断、人类风险动作要求停止、账户进入禁止
  状态，或 supervisor 判断必须停机。

因此 `decision ledger marker` 不是整个 steward 生命周期的结束，只是一次 wake 的
可观测完成信号。

### 3.4 外部监督设备

persistent steward 需要一个在 core-agent 外部的 supervisor / watchdog。它不替 agent
交易，也不绕过 UTA 授权；它负责观察、唤醒和保护运行边界：

- 记录每次 wake 的输入、版本、工具调用、输出、ledger、耗时和成本，用作行为优化轨迹。
- 监控 session liveness、最后一次 ledger marker、deadline、连续错误和异常空转。
- 在假死、超时或无 ledger marker 时标记 `stuck` / `timeout`，并按策略唤醒、重试、
  暂停或推 Inbox 给 jieke。
- 维护 per-workspace / per-account lock，避免两个 wake 同时管理同一账户风险。

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

| 类别 | 记录内容 |
|---|---|
| 版本 | core-agent/model、trading-agent prompt、workspace instruction/skills、wake schema、ledger schema |
| 输入 | wake envelope、market/account/risk snapshot refs、历史 ledger refs、human/user request |
| 过程 | UTA checklist 结果、关键工具调用 refs、错误/重试/超时 |
| 输出 | `no_trade` / `propose_trade` / `blocked`、thesis、invalidation、actions、pendingHash |
| 结果 | push/filled/rejected/risk transition/outcome refs；若无交易，也记录 `no_trade` 的理由 |
| 成本 | latency、model/token/cost；拿不到 token 时也要留空字段，不能丢 schema |

这些轨迹属于 supervisor 和 ledger 的共同职责：ledger 给出交易决策真相，supervisor
给出运行与成本真相。

## 7. Decision ledger 是单次 wake 的完成边界

常驻 session 不能靠「屏幕看起来没动了」判断一轮完成。每个 wake 必须追加一条结构化
decision ledger。最小字段：

```json
{
  "wakeId": "...",
  "at": "2026-07-08T14:01:23Z",
  "accountId": "...",
  "decision": "no_trade | propose_trade | blocked",
  "status": "done | blocked | error",
  "checklist": {
    "account": "ok",
    "positions": "ok",
    "orders": "ok",
    "risk": "NORMAL",
    "market": "open",
    "history": "checked"
  },
  "thesis": "short, evidence-backed rationale",
  "actions": [],
  "pendingHash": null,
  "invalidation": "what would make this wrong",
  "cost": {
    "model": "if available",
    "inputTokens": null,
    "outputTokens": null
  }
}
```

`no_trade` 是正式决策，不是空结果。没有 thesis、entry signal、invalidation、risk budget
时，正确输出就是 `no_trade` 并写明原因。

如果超时没有 ledger marker，外部 supervisor 应把 wake 标成 `stuck` 或 `timeout`，而不是
从 Codex/Cli 屏幕文本里猜结论。

## 8. 允许和禁止的行动

允许：

- 读取 workspace 内的操作手册、历史报告、decision ledger、结构化输入。
- 通过 `alice-uta` / `traderhub` / `alice-workspace` / `alice` 或 workspace MCP 取信息。
- 在授权档允许时 stage proposal 并 `tradingCommit`，带清楚 thesis。
- 把报告或需要人看的事项推 Inbox。

禁止：

- 直接 curl Alice/UTA 的 human-only API 或扫本机端口绕过工具面。
- 读取或修改 OpenAlice 源码来完成交易 wake。
- 自己给自己提高 `authzLevel`、改账户上限、改 guard 配置。
- 调用或寻找 `push` 能力。agent 永远不拿 broker push。
- 在没有 checklist 和 ledger 的情况下结束一轮。
- 用叙述替代证据；声称某个操作做不到时，必须有实际命令退出码/报错支撑。

这些禁止项来自 [steward-security-uta-auth.zh.md](steward-security-uta-auth.zh.md) 和
[appendix/steward-p2-e2e-observation.md](appendix/steward-p2-e2e-observation.md) 的
真实行为教训。

## 9. 与既有文档的关系

- [openalice-agent-support.zh.md](openalice-agent-support.zh.md)：平台已有能力与缺口。
- [steward-agent-working-modes.zh.md](steward-agent-working-modes.zh.md)：工作方式/拓扑/旋钮；本文细化目标单体 steward 行为。
- [steward-agent-observation-surface.zh.md](steward-agent-observation-surface.zh.md)：agent 在不同状态下看到什么。
- [steward-prompt-anatomy.zh.md](steward-prompt-anatomy.zh.md)：prompt 版本与行为影响；本文规定 wake/prompt 应服务于窄循环，而不是泛化 coding task。
- [steward-plan.zh.md](steward-plan.zh.md)：I1-I9 不变量仍是最高约束。
