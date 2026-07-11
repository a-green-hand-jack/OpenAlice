# Steward 2026-07 历史文档归档

> 状态：历史证据，只读。这里记录 2026-07-03 至 2026-07-11 从方向调研、P1/P2/P3、
> persistent steward 到 v8 experiment 的演进过程。它们不再构成当前实现或继续开发授权。
> 当前唯一活动路线是 [../../steward-plan.zh.md](../../steward-plan.zh.md)。

## 为什么归档

这批文档形成于高速迭代期间，分别描述不同时间切片。后来已经发生的变化包括：

- workspace 工具入口从“以 MCP 描述”为主收敛为 CLI-only gateway；
- paper/mock 从人工 push 演进为有授权和 policy/guard 约束的 auto-push；
- steward template 与 persistent wake loop 已从未来计划变成当前实现；
- guard、ledger、finalize、mutation durability 已多轮加强；
- canonical v8 runtime 通过 60/60 wakes，但 participation candidate 因无 guard 账户风险而未启用。

继续把这些历史计划放在 `docs/` 顶层，会让“当时的决定”“现在的实现”和“下一步授权”互相
覆盖。因此保留全文和 git 历史，但移出 canonical 文档面。

## 文件地图

| 历史文档                                                                           | 当时用途                                | 当前替代                                                                |
| ---------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| [steward-plan.zh.md](steward-plan.zh.md)                                           | v1.1，S0–S2 与 P0–P6 路线               | [plan v2](../../steward-plan.zh.md)                                     |
| [steward-direction-research.zh.md](steward-direction-research.zh.md)               | 2026-07-03 外部版图与早期选型           | [architecture](../../trading-agent-architecture.zh.md) + plan v2        |
| [steward-p2-plan.zh.md](steward-p2-plan.zh.md)                                     | P2 审计链阶段执行稿                     | [architecture](../../trading-agent-architecture.zh.md)                  |
| [steward-p3-design.zh.md](steward-p3-design.zh.md)                                 | 渐进授权阶梯设计                        | plan v2 的 bounded autonomy gates                                       |
| [steward-p3-campaign.zh.md](steward-p3-campaign.zh.md)                             | paper campaign 计划与实况               | [runtime/testing](../../trading-agent-runtime-and-market-testing.zh.md) |
| [steward-agent-working-modes.zh.md](steward-agent-working-modes.zh.md)             | 旧工作方式与 prompt 旋钮空间            | [behavior contract](../../steward-workspace-behavior-contract.zh.md)    |
| [steward-agent-observation-surface.zh.md](steward-agent-observation-surface.zh.md) | blind replay 观察面                     | [runtime/testing](../../trading-agent-runtime-and-market-testing.zh.md) |
| [steward-security-uta-auth.zh.md](steward-security-uta-auth.zh.md)                 | 同主机认证事故与决策过程                | [architecture](../../trading-agent-architecture.zh.md) 的权限边界       |
| [openalice-agent-support.zh.md](openalice-agent-support.zh.md)                     | persistent steward 落地前的平台能力盘点 | [architecture](../../trading-agent-architecture.zh.md)                  |

## 仍然有效的历史决定

- Broker、凭证、mutation 和账户真相属于 UTA。
- 风险机制必须是确定性代码，LLM 不进入风险信任链。
- 权限只能由人放宽，系统和 agent 只能自动收紧。
- Agent 不持有 `push` 工具或 broker credential。
- Paper first、全程审计、持久状态变更走 migration。

这些决定已经提升到 plan v2 或当前架构文档，不需要从归档文件反向推导。

## 已撤回或被取代的决定

- “当前阶段是 S0”已经过时。
- “workspace 日常工具通过 MCP 注入”已被 CLI-only 当前实现取代。
- “paper 每笔必须人工 push”已被 deterministic paper auto-push 当前语义取代。
- “guards 为空、当前只应调 prompt”不再成立。
- “提高 participation prompt 就能解决表现缺口”被 v8 evidence 否定。
- Issue #126 的 70–85% exposure candidate 未获准进入默认 instruction。

## 实验证据

实验和 baseline 仍保留在 `docs/appendix/`。Issue #126 的精确 candidate commit 为
`e27efdb653e09a19c005d20a867638d146695927`，annotated tag 为
`dev-steward-v8matrix7-candidate-20260711`。Tag 是证据定位，不是上线许可。
