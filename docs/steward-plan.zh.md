# Steward 方向与实施计划

> 版本：v2.1（2026-07-11）
>
> 地位：**唯一活动路线与授权真源**。当前只授权 D0 文档与分支收口；不授权 runtime、
> prompt、campaign、paper/live 或 broker mutation 行为变更。旧 v1.1 及 P2/P3 阶段计划已归档到
> [archive/steward-2026-07/](archive/steward-2026-07/README.md)。
>
> 当前实现真源见 [trading-agent-architecture.zh.md](trading-agent-architecture.zh.md)，目标行为见
> [steward-workspace-behavior-contract.zh.md](steward-workspace-behavior-contract.zh.md)，评测边界见
> [trading-agent-runtime-and-market-testing.zh.md](trading-agent-runtime-and-market-testing.zh.md)。

## 1. 方向决定

OpenAlice 继续把 trading agent 运行成 persistent workspace 中的原生 agent session，但产品目标
不再是“通过 prompt 让通用 agent 更积极地下单”。Steward 的首要职责调整为：在可追溯的信息集
上形成高质量组合判断，输出结构化交易意图，并让 UTA 的确定性风险边界决定实际允许执行什么。

一句话：

> **Agent 负责判断与解释；UTA 负责授权、风险预算、数量约束和 broker mutation；自主性只能在
> 明确、强制、可撤销的风险包络内逐步开放。**

这保留 persistent workspace、native CLI、Alice/UTA 分离、外部 supervisor 和文件化审计的
既有价值，同时停止把 runtime 可靠性、交易表现和风险安全混成一条 prompt 调参流水线。

## 2. 当前事实基线

- OpenAlice 不拥有模型推理循环。Core-agent 运行在 Codex / Claude 等原生 CLI 中。
- Workspace 默认不注入 MCP 配置；agent 通过 `alice*` / `traderhub` CLI 访问 OpenAlice 工具。
- Steward 无人值守 wake 当前通过 PTY 注入 `<STEWARD_WAKE>` 文本 + 回车实现。控制面的主要
  失败模式（TUI 未就绪、回车被吞、会话假死、finalize marker 错配）来自把人机 TUI 当作机器
  接口使用，不是"借用原生 CLI"这一策略本身的必然成本。
- 原生 CLI 均提供一等机器接口：Codex 有 `codex app-server`（JSON-RPC daemon、thread/turn
  生命周期事件、`generate-ts` / `generate-json-schema` 类型化契约）与 `codex exec --json` /
  `exec resume`；Claude 有 `@anthropic-ai/claude-agent-sdk` 与
  `claude -p --output-format stream-json --resume`。订阅 OAuth 凭据在这些模式下同样有效；
  外部 supervisor（Paseo）以 app-server + agent-sdk 驱动同款 CLI 长会话（thread resume、
  协议内 compaction）已在本地得到验证。OpenAlice 自己的 headless dispatch adapter 也已使用
  结构化模式，仅 persistent wake 路径仍依赖 PTY。
- Alice 是 workspace lifecycle、wake、工具授权和 supervisor 控制面；UTA 是账户、guard、
  mutation、broker 与执行事实的权威边界。
- Paper/mock 可以在有效授权和 policy/guard 通过时 auto-push；live 不由当前 steward 自动执行。
- Canonical `v8matrix7` 证明 isolated serial runtime 能完成 60/60 wakes 且审计链干净，但没有
  证明 participation policy 安全或产生稳定 alpha。
- Issue #126 的 70–85% exposure candidate 因无 `max-position-size` guard 的账户可能承受过大
  暴露而未启用；它只作为实验历史保留。
- 旧路线的 S0 containment 与 S1 mutation durability 已落地；没有证据表明旧 S2 revoke epoch
  已完成。S2 不再作为自动续跑阶段，而是未来任何真实自主 broker mutation 前的安全门候选。

## 3. 不变量

1. **Proposal first**：新的 agent 能力先产生 decision/proposal，不默认获得执行权。
2. **风险确定性**：限额、guard、状态机、kill switch、撤权和数量上限必须由 UTA 普通代码执行，
   LLM 不进入风险信任链。
3. **风险包络必填**：没有明确 max position、daily loss、drawdown、symbol/asset scope 和 revoke
   语义的账户，不具备 autonomous execution 资格。缺失配置必须 fail closed，不能把“没有 guard”
   解释为“没有限制”。
4. **判断与订单分离**：agent 输出方向、信心、目标暴露范围、最大可接受损失、失效条件和证据；
   实际数量由确定性 sizing/risk 层约束。自由文本 prompt 不能成为仓位上限。
5. **权限单向性**：agent 和系统只能自动收紧权限；放宽权限必须由人明确批准。
6. **真相分层**：venue/broker > UTA mutation/account state > validated decision ledger > Inbox/PTY
   prose。Ledger 是决策记录，不是账户真相。
7. **低频定位**：PTY/persistent session 适合研究、组合判断和日/周级协作，不承担低延迟、
   强实时 broker control。及时触发、风险动作和执行状态机属于确定性控制面。
8. **评测分层**：protocol reliability、decision quality、execution fidelity 分开验收。Guard 拒绝
   不得被计为 agent 策略成功。
9. **Paper first**：任何 autonomy 先在隔离 mock，再到真实 paper broker；holdout、真实 paper
   和 live 都需要独立授权。
10. **可审计与可迁移**：重要状态转换可回答五问；持久用户状态变更继续走 migration 框架。

## 4. 目标产品契约

### 4.1 Agent 输入

每次决策应绑定一个可追溯的 as-of information snapshot，至少区分：

- market：价格、成交、波动、市场状态和 freshness；
- portfolio：现金、持仓、订单、敞口和可用资金；
- risk：风险状态、强制包络、剩余预算和 revoke version；
- events：新闻、财报、宏观或明确声明“本轮未提供”；
- history：最近决策、未失效 thesis、执行结果和 outcome。

当前 `context-manifest.json` 只记录行为资产版本，不等于上述信息快照。两者未来应明确分开。

### 4.2 Agent 输出

Steward 的核心输出应从“直接拼装任意订单”收敛为结构化 Decision Intent：

```text
decision: no_trade | propose_change | reduce_risk
direction / target allocation range
confidence and evidence
maximum acceptable loss
invalidation condition
time horizon
snapshot identity
```

UTA 或独立确定性 sizing 层再根据账户风险包络，把 intent 转为允许的 order proposal。Agent 可以
解释 sizing 偏好，但不能以 prompt 文本覆盖硬上限。

### 4.3 执行资格

Proposal、paper bounded autonomy、真实 paper broker 和 live 是四个不同资格，不因为前一层
runtime 跑通而自动晋升。每层都有独立的进入门、撤权路径和证据要求。

### 4.4 Wake 与会话控制面（2026-07-11 maintainer 决定）

Steward 的无人值守 wake 路径从 PTY 文本注入迁移到原生 CLI 的机器协议：

- **Codex 走 `codex app-server`**（thread/turn 生命周期事件、结构化 approval/sandbox、
  类型化 bindings），**Claude 走 `@anthropic-ai/claude-agent-sdk`**。这是已被外部 supervisor
  实践验证的组合（"Paseo 路线"）。
- **交换器形态选择"OpenAlice 内改造"**：per-provider machine driver + thread registry + wake
  dispatcher 三件事，落在现有 adapter / supervisor 结构内。不引入外部 supervisor 进程作为
  运行依赖——选型标准是开发工作量最小（headless adapter、supervisor、ledger、授权、工具
  注入均已存在，增量只是 wake 分发方式），同时避免把交易凭据边界托付给第三方应用。
- **PTY / scrollback 保留给人机交互 workspace**。同一 thread 事后可用 `codex resume <id>` /
  `claude --resume <id>` 人工接管，人可观察性不因迁移丢失。
- **工具面与状态面不变**：`alice*` / `traderhub` CLI 和 `.alice/steward/` 文件契约保持。
  finalize barrier 是否可由 turn 生命周期事件替代，属于 D1 设计输出，本节不预设。
- **风险注记**：`codex app-server` 标记为 experimental，采用时必须版本 pin，并以
  `generate-json-schema` 快照做契约回归测试。

本节只固化方向与选型；具体 schema、迁移与留存策略属于 D1 设计，任何 runtime 实现须按 §5
另行授权。

## 5. 执行阶段

| 阶段 | 目标                                                           | 当前授权               | 完成门                                                                                      |
| ---- | -------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| D0   | 统一方向、归档旧文档、收口遗留 branch                          | **已授权，当前阶段**   | canonical docs 无矛盾；旧 branch 进入 ancestry 且 runtime tree 零变化                       |
| D1   | 设计 Decision Intent、Information Snapshot、Risk Envelope 契约，以及 wake 控制面迁移（app-server / agent-sdk，§4.4）设计 | D0 后只允许文档/设计   | schema、责任边界、失败语义、迁移影响经 maintainer 批准；控制面设计含协议版本 pin 与回退策略 |
| D2   | 补齐 autonomous execution 的确定性安全前置                     | 未授权实现             | mandatory envelope、sizing、revoke/admission、外部 ledger commit point 的范围经独立安全审查 |
| D3   | 建立三层 eval harness                                          | 未授权实现             | protocol/decision/execution 指标分离，guard containment 不计入策略得分                      |
| D4   | Proposal-only 决策试点                                         | 未授权运行             | 多资产/事件化 as-of replay；只产 proposal，不 auto-push                                     |
| D5   | 隔离 mock bounded autonomy                                     | 未授权运行             | 强制风险包络、重复执行幂等、撤权、对账与 recovery 全过                                      |
| D6   | 真实 paper broker 候选                                         | 未授权                 | D0–D5 证据审查通过，另行批准 broker 与测试窗口                                              |
| D7   | 小额 live 候选                                                 | **不在当前路线授权内** | 独立安全计划、法律/运营边界与用户显式授权                                                   |

任何阶段都不能因为“前一阶段没有发现 issue”自动进入下一阶段。D2 以后涉及代码或运行的工作，
必须重新取得 maintainer 明确授权。

## 6. D0 文档真源

| 文档                                             | 唯一职责                                | 不承担什么                  |
| ------------------------------------------------ | --------------------------------------- | --------------------------- |
| 本文                                             | 活动方向、阶段、授权与停止条件          | 具体实现细节、实验流水账    |
| `trading-agent-architecture.zh.md`               | 当前 Alice/Agent/UTA 结构和 IN/OUT 真相 | 未来路线授权                |
| `steward-workspace-behavior-contract.zh.md`      | steward 应怎样判断、记录和交付          | broker/UTA 实现说明         |
| `trading-agent-runtime-and-market-testing.zh.md` | protocol/decision/execution 评测方法    | 活动产品路线                |
| `steward-persistent-loop-implementation.zh.md`   | persistent wake/runtime 实现参考        | 产品方向                    |
| `steward-prompt-anatomy.zh.md`                   | prompt registry、版本和历史实验         | 宣布某个 candidate 获准上线 |
| `docs/appendix/steward-*`                        | 原始实验和阶段证据                      | 当前状态或继续执行授权      |

发生冲突时，先按职责判断真源；同一职责内以日期更新且明确标为 current/canonical 的文档为准。
归档文档只解释历史决策，不得被实现会话当作当前授权。

## 7. D0 分支收口规则

以下遗留分支的安全文档成果已经由 PR #141 重新整理进入 `jieke/dev`，但其 tip 尚未成为
`jieke/dev` ancestry：

- `docs/trading-agent-architecture`
- `feat/issue-126-v8-consolidation`
- `feat/issue-126-v8-participation-policy`

收口必须使用保持当前 tree 的 ancestry reconciliation，不得普通合并旧内容。尤其
`feat/issue-126-v8-participation-policy` 含未获准的 70–85% exposure candidate。验收要求：

1. 收口前记录三个精确 tip；
2. merge 后 `instruction.md` 与收口前完全一致；
3. 除明确的文档归档/plan v2 变更外，runtime tree 零变化；
4. 保留 candidate annotated tag 作为证据；
5. 推送 `jieke/dev` 后删除旧 local/remote branch，避免再次被误当活动工作线。

## 8. 停止条件

出现以下任一情况，立即停止当前阶段并回到方向/安全审查：

- 需要通过增加 prompt 压力才能让 agent 承担本应由风险代码保证的约束；
- 评测结果依赖 guard 拒绝才能满足策略 gate；
- runtime、decision、execution 的失败无法分开归因；
- account 没有强制风险包络却准备获得 auto-push；
- 同主机 agent 可以绕过 Alice/UTA 认证或撤权边界；
- 需要打开 holdout、真实 paper 或 live 才能继续调参；
- 新阶段开始前没有明确验收门和退出条件。

## 9. 变更记录

- v2.1（2026-07-11）：新增 §4.4 wake 控制面路线：无人值守 wake 从 PTY 注入迁移到
  `codex app-server` / `claude-agent-sdk` 机器协议；交换器采用 OpenAlice 内改造形态
  （工作量最小原则）；控制面迁移设计并入 D1；§2 补充 PTY 现状与机器接口事实基线。
- v2.0（2026-07-11）：Ubuntu OpenAlice freeze 后重写。停止 prompt-first participation 调优，
  把 proposal-first、Decision Intent、mandatory Risk Envelope、评测分层和 bounded autonomy
  定为新路线；旧 v1.1 与阶段文档归档。
- v1.1（2026-07-10）：旧 S0–S2 风险优先路线，现存档于
  [archive/steward-2026-07/steward-plan.zh.md](archive/steward-2026-07/steward-plan.zh.md)。
