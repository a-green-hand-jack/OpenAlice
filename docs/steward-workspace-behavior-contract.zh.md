# Steward Workspace 行为契约

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

## 0. 一句话

Steward agent 醒来时，应该感受到的世界是**它所在的交易 workspace**：已经整理好的
账户、风险、市场、事件、历史决策和可用工具，而不是 OpenAlice 源码仓库、launcher
实现细节、端口拓扑，或一次新的泛化 coding task。

## 1. Workspace 是 agent 的世界

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

## 2. 目标工作形态：常驻 steward

生产目标是一个长期存在的 workspace session：

```text
market/event selector
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
| 上下文 | fresh run 读 prompt / skills / 文件 | 保留 transcript + workspace state，只处理本次 envelope |
| 完成边界 | 进程退出 | decision ledger marker |
| 适用场景 | 回测、短任务、可重复 campaign | 真实 paper/live-like 交易工作方式 |
| 主要风险 | 每次像 coding task 重新探索 | 需要 watchdog/ledger/锁来约束常驻状态 |

headless 仍可作为评估、回放、短任务和 fallback 使用；它不再是目标 production steward
行为的默认解释。

## 3. Wake envelope

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

## 4. 固定 UTA checklist

每个交易 wake 都先跑同一套最小检查，除非 envelope 明确是纯研究/复盘任务：

1. 账户：`alice-uta account info` / cash / net liquidation。
2. 持仓：portfolio / current exposure / pending staged status。
3. 订单：open orders / pending commits / recent fills。
4. 风险：`risk status` / guards / HALT or READ_ONLY state。
5. 市场：market clock / tradable contract / quote or approved bar refs。
6. 历史：最近 decision ledger、相关 open thesis、last action/outcome。

checklist 的目的不是制造长搜索，而是防止 agent 在不知道账户和风险状态时交易。检查结果
应被摘要进 decision ledger，而不是只留在屏幕滚动里。

## 5. Decision ledger 是完成边界

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

如果超时没有 ledger marker，外部 watchdog 应把 wake 标成 `stuck` 或 `timeout`，而不是
从 Codex/Cli 屏幕文本里猜结论。

## 6. 允许和禁止的行动

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

## 7. 与既有文档的关系

- [openalice-agent-support.zh.md](openalice-agent-support.zh.md)：平台已有能力与缺口。
- [steward-agent-working-modes.zh.md](steward-agent-working-modes.zh.md)：工作方式/拓扑/旋钮；本文细化目标单体 steward 行为。
- [steward-agent-observation-surface.zh.md](steward-agent-observation-surface.zh.md)：agent 在不同状态下看到什么。
- [steward-prompt-anatomy.zh.md](steward-prompt-anatomy.zh.md)：prompt 版本与行为影响；本文规定 wake/prompt 应服务于窄循环，而不是泛化 coding task。
- [steward-plan.zh.md](steward-plan.zh.md)：I1-I9 不变量仍是最高约束。
