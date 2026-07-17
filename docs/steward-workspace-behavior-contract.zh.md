# Steward Workspace 行为契约

> 版本：v0.5（2026-07-17）
>
> 地位：issue [#264](https://github.com/a-green-hand-jack/OpenAlice/issues/264) 后的当前行为契约。
> 操作入口见 [Trading Agent Operator Guide](trading-agent-operator-guide.zh.md)，能力复用证据见
> [Trading Agent Capability Reuse Audit](trading-agent-capability-reuse-audit.zh.md)。旧 D4/v9
> prompt、阶段授权和实验记录均为历史冻结证据，不是当前 runtime、策略或授权真源。

## 1. 范围与术语

**受任单元（entrusted unit）**不是 LLM 的同义词。它是满足委任契约的任意决策者：接受
资本或额度、Risk Envelope、scope、有效期和身份；只消费获准观察流；发出带身份戳的
Trade Intent；并按期心跳。实现可以是模型、规则系统或其他决策程序。

v1 只支持一条最小链路：

```text
root mandate -> 一个 Team 提供的交易受任单元 -> Trade Intent
```

v1 不实现多级指挥、Delegation Intent runtime、动态资本分配、委任 UI、任意深度树、
新工作流引擎、新 runner、新 adapter 或新 sizing 层。当前 v1 实验实例使用 Codex，
但 Codex 不是契约定义。

## 2. 责任边界

| 所有者 | 当前职责 |
| --- | --- |
| Trading Team | 受任单元实现、policy/prompt/config/角色和评测配置；所有策略、参与偏置与 sizing 偏好 |
| OpenAlice | workspace、production Guardian、ScheduleScanner、persistent steward、recovery、观察/工具注入、Evaluation Harness 和通用审计机制 |
| UTA | TradingGit、mandatory Risk Envelope、guards、账户/执行/broker adapter、venue reconciliation 和 broker mutation |

OpenAlice 的 steward instruction 只定义 mechanics：workspace 世界边界、wake/mandate/
Trade Intent schema、UTA checklist、受控 `alice-uta` 使用、ledger/finalization/recovery 和
safety。没有外部 Team policy 明确授权时，平台默认 proposal-only 并 fail closed。
OpenAlice instruction 不定义交易判断、benchmark、参与率、仓位目标或 Team 策略。

## 3. 两个既有生命周期

不存在统一 mode selector，也不存在第三套 runtime：

| 场景 | 唯一现有路径 | 生命周期 |
| --- | --- | --- |
| finite isolated evaluation | `lab -> run-cell` | 一次实验完成后退出并清理 isolated mock stack |
| long-running paper/live | `production Guardian -> ScheduleScanner -> persistent steward` | 由现有生产监督面长期运行和恢复 |

paper 与 live 只由现有持久化 account/broker adapter 配置选择。两条路径共享同一受任单元
契约、Team policy、观察/Trade Intent、UTA/TradingGit/Risk Envelope 和审计路径；切换
生命周期或 adapter 不得复制策略或改变委任契约。

## 4. Wake 契约

每个 wake 必须由持久化 wake envelope 携带并绑定：

- `wakeId`、原因、deadline 和获准观察范围；
- 同一 root mandate 的 `mandateId` 与 `entrustedUnitId`；
- account、capital/limit、scope、validity、heartbeat 和 Risk Envelope 约束；
- 只读 market/account/risk/history 观察引用。

受任单元每轮必须完成真实 UTA checklist：account、positions、orders、risk、market、history。
读取失败、未知或不可用时必须 `blocked`，不得伪装成 `no_trade`。`no_trade` 仅在观察读取
成功且确实没有 Trade Intent 时有效。

非空 Trade Intent 必须复制本 wake 的 `mandateId` 和 `entrustedUnitId`，并保持 proposal
语义；授权、guards、Risk Envelope、adapter 与 venue truth 始终由 UTA 判定。受任单元不直接
拥有 broker mutation 权限。

## 5. Ledger v3 与完成边界

当前决策账本是 ledger v3。每个 wake 只允许一个终态记录：`no_trade`、
`propose_change`、`reduce_risk` 或 `blocked`。受任单元写 draft，既有 validator 负责 schema
校验、原子 ledger 提交和 finalize marker；ScheduleScanner/supervisor 只在 ledger 与 marker
指纹一致时承认本 wake 完成。

一次 wake 完成不代表长期 steward 生命周期结束。Guardian 或 UTA 重启后，现有 recovery
必须从持久化 wake、ledger、finalize 和 session 状态恢复，不得靠 coding agent 或保持终端
连接守护。

## 6. 安全与变更规则

- 缺失或过期 mandate、身份不匹配、heartbeat 逾期、scope/account 不匹配、Risk Envelope
  缺失、authz 不足、checklist 失败、guard 拒绝或 reconciliation 失败，一律 fail closed。
- 默认禁止真实资金。paper/live 需要既有 account adapter 配置和独立升级授权；#264 验收
  只允许 isolated mock。
- 盈利、参与率、交易次数不是基础设施验收条件；基础设施错误导致的 `blocked` 必须使验收失败。
- prompt/model/strategy/role/participation/profitability 只改 Team repo 或 experiment config。
  OpenAlice 只在通用 lifecycle/schedule/recovery/security/audit 缺陷、真实 adapter 兼容缺陷、
  安全/数据损坏，或复用审计证明现有能力无法表达时重开。
