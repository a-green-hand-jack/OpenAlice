# Steward 方向与实施计划

> 版本：v2.7（2026-07-13）
>
> 地位：**唯一活动路线与授权真源**。Wave 0.5 的 `AUTH-CP-D2` / `AUTH-CP-D3` 与 §5.2 的
> `AUTH-D2` / `AUTH-D3` 均已完成、关闭并消费，任何后续工作不得再援引；D2 / D3 已完成并
> 冻结，当前没有任何 steward implementation 或 run token。§5.2 保留原授权 scope 与完成证据，
> 只作为历史边界，不是可复用授权。本次关闭不签发 D4+ 或任何其他 token，也不授权 prompt
> 行为调优、model/campaign/holdout、mock autonomy、account/broker、paper/live 或相关数据采集、
> 调参和运行行为。§5.2 唯一跨进程隔离场景已作为 D3 证据完成；它不触发阶段自动晋级，也
> 不能被解释为后续 account/UTA/mutation 活动授权。旧 v1.1 及 P2/P3 阶段计划已归档到
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
  失败模式（TUI 未就绪、回车被吞、会话假死、上下文溢出）来自把人机 TUI 当作机器
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
  `generate-json-schema` 快照做契约回归测试；`@anthropic-ai/claude-agent-sdk` 同样处于
  快速演进期，适用同一版本 pin 与契约回归纪律。

本节只固化方向与选型；具体 schema、迁移与留存策略属于 D1 设计，任何 runtime 实现须按 §5
另行授权。

**已落地（issue #146，S0–S6，PR #147–#151）**：本节方向已实现——无人值守默认走机器协议
（codex app-server / claude-agent-sdk），显式 `controlFace: 'pty'` 作为一等逃生舱、交互式
workspace 保留 PTY；无人值守默认翻转（缺省 controlFace ⇒ machine）落在
`src/workspaces/steward/machine-driver/dispatch.ts` `decideStewardControlFace`，实现叙述见
`trading-agent-architecture.zh.md` §1 / §3。本条只登记实现落地，不构成对 §5 后续阶段的新授权。

## 5. 执行阶段

### 5.1 Wave 0.5 契约证明：已完成，授权已关闭

Maintainer 于 2026-07-12 批准以下六项 G0 决定：

1. `confidence` 采用 `low | medium | high` 三档。
2. Ledger v3 采用 portfolio-capable discriminated union，但 D5/D6 初始执行 admission
   只接受 single-target；portfolio intent 在此之前只做 proposal/shadow 证据。
3. Information Snapshot M2 的权威 tool receipt 由工具面产生，supervisor 只聚合与索引。
4. 保护单按 broker capability 运行确定性选择规则；无法证明可保护时必须明确拒绝，
   不得静默退化为裸仓。
5. Risk Envelope 可复用共享 schema 工具，但不与 control-face loader 共用 warn-only
   enforcement；UTA 必须独立 fail closed。
6. Agent-authored Decision Ledger 保持 immutable；确定性 sizing/执行结果写入独立
   Execution Record，以 intent fingerprint 关联对账。

`AUTH-CP-D2` 与 `AUTH-CP-D3` 只曾允许测试专用 schema fixtures、golden vectors、
evaluator examples、pure validators 和 tests。完成证据如下：

- `AUTH-CP-D2`：issue #163、PR #167、merge `0a94b214`；定向 40 tests 通过，完整套件
  3039 passed / 6 skipped，TypeScript 与 diff check 通过。
- `AUTH-CP-D3`：issue #164、PR #168、merge `f968543c`；D2+D3 定向 79 tests 通过，
  完整套件 3078 passed / 6 skipped，TypeScript 与 diff check 通过。
- 两项均经过实现者之外的独立 critic 审查，并按 maintainer 授予的 Wave 0.5 范围合并；
  改动保持在测试 oracle、fixtures 与 specs，没有连入生产 runtime/harness、prompt、account、
  UTA 或 broker 路径。

上述两项 CP token 现已**关闭并消费**，不得用于任何后续代码、proof 扩展或运行工作。它们
从未且仍不授权 D2 production runtime、D3 production harness/integration、prompt 变更、
campaign/model run、holdout、mock autonomy、paper/live、account/UTA 变更、broker/demo
account 连接或任何 broker mutation。§5.2 的新授权由 maintainer 独立签发，不继承、恢复或
扩张这两个已消费 token；Wave 0.5 完成也不触发自动晋级。

### 5.2 已完成并关闭的授权：`AUTH-D2` / `AUTH-D3`

Maintainer 于 2026-07-12 签发两个相互独立、按列举范围解释的实现 token。未列出的工作一律
不在授权内；共享改动若无法明确归属其中一个 token，必须停止并回报 maintainer，不得用
“D2/D3 相关”自行扩张范围。以下 scope 保留为历史授权边界；两个 token 已由 issue #197 的
documentation-only closeout 关闭并消费，当前不可继续使用。

#### `AUTH-D2` 历史允许范围与出口

只允许以下 D2 runtime safety lanes：

1. 实现 ledger v3、Information Snapshot M1，以及保持磁盘原始 `decision` fingerprint 的
   迁移兼容；持久状态变化必须走 migration 框架，禁止先归一化再计算历史 fingerprint。
2. 实现 mandatory Risk Envelope；信封缺失必须 fail closed，并保留可审计的
   `risk_envelope_missing` 语义。
3. 实现单向 revoke，以及 dispatch/execution 时对 Risk Envelope version 的再次读取与比较；
   版本变化必须放弃执行。
4. 让确定性 sizing 成为订单数量的唯一来源；agent 不得写入或覆盖 `totalQuantity`。
5. SizingOutcome / Execution Record 必须记录所读取的账户/风险 source-state version；dispatch
   必须重读并比较，状态变化时拒绝发送。
6. 保持写者分离：agent-authored Decision Ledger 不回写 sizing/执行结果；确定性层单独写
   Execution Record，并用 intent fingerprint 对账。

`AUTH-D2` 的 gate exit 是：上述六条均有 fail-closed 回归证据；lock、revoke、risk 与
state-version 路径通过对抗式并发压力测试；历史 raw fingerprint 兼容性通过；实现者之外的
独立 safety critic 给出 APPROVE。任一项缺失都不得宣称 D2 完成。

#### `AUTH-D3` 历史允许范围与出口

只允许以下 D3 implementation lanes：

1. 实现 protocol reliability / decision quality / execution fidelity 三层分离的 evaluation
   harness；guard containment 不得计为 decision success。
2. 实现逐 wake、as-of、snapshot/hash、publication/corporate-action availability、point-in-time
   universe、split/embargo 与 sampling-audit 的 data-manifest enforcement。
3. 实现 model-cost scheduler 的确定性调度、额度与成本记账代码及测试；本项只授权实现，
   不授权调用模型或运行 model comparison/campaign。
4. 在 D2 versioned admission wire 已实现并审查后，只运行**一项**有界、隔离的跨进程集成测试：
   Alice scheduler → versioned admission wire → UTA reduce-only。该测试是唯一 account/UTA/
   mutation 邻接例外，不得扩成 broker、demo account、mock autonomy 或场景矩阵。

`AUTH-D3` 的 gate exit 是：三层指标与报告归属可机械区分；manifest 对未来数据、缺失 snapshot
和 split leakage fail closed；cost scheduler 在无模型调用下通过确定性测试；上述唯一跨进程
测试通过；实现者之外的独立 critic 给出 APPROVE。它不以 campaign、PnL、holdout 或 broker
结果作为完成证据。

#### 完成证据与关闭 receipt

`AUTH-D2` 的六条 runtime safety lane 已全部实现、独立审查、合并并冻结：

1. ledger v3、Information Snapshot M1 与磁盘原始 decision fingerprint 兼容：issue #174、
   PR #184、merge `59ba44a7`。
2. mandatory Risk Envelope、单向 monotonic revoke、逐 operation versioned admission 与
   accounts-config lock 线性化：issue #185、PR #191、merge `67ffa679`。
3. 确定性 sizing 唯一数量源、全部 source-version barrier、独立 pre-operation Execution Record
   与 concrete UTA mutation capability：issue #186、PR #192、merge `9b4078af`。
4. 经 maintainer 批准的前置修复：issue #176 / PR #178 / merge `81d6a21d`，issue #177 /
   PR #180 / merge `c4e13e50`，issue #181 / PR #182 / merge `6b6a2fd1`，issue #188 /
   PR #190 / merge `f772e941`。

D2 各风险 lane 均由实现者之外的 safety critic 给出 APPROVE。最终 #186 gate 通过 root
TypeScript、`@traderalice/uta-protocol` typecheck 与 ANATOMY drift（2 files、126 citations）；
定向 protocol/manager/HTTP/SDK/integration 为 57 passed，TradingGit/recovery 为 101 passed，
独立 child-process `commit.json` persistence 为 3 passed，完整套件为 3298 passed / 6 skipped
（235 files passed / 1 skipped）。并发与恢复证据覆盖 raw-fingerprint parity、envelope 缺失等
fail-closed guard、lock/revoke/risk concurrency、durable mutation lease、同键并发恰好一次调用、
同键异 payload 冲突、matching protection 持久化、durable-dispatching 崩溃后进入 recovery 且
不 replay、wrong-account 零调用/零 record，以及 account state 推进后的 lost-response dedupe。

`AUTH-D3` 的四条 implementation lane 已全部实现、独立审查、合并并冻结：

1. §5.2 第 1–3 项：三层 evaluation harness、fail-closed manifest enforcement 与不调用模型的
   确定性 cost scheduler；issue #187、PR #189、merge `0ceac856`；28 focused，完整
   3158 passed / 6 skipped。
2. immutable store-backed data provenance 与 relabelling refusal：issue #193、PR #195、merge
   `ccb8b098`；64 focused，完整 3305 passed / 6 skipped。
3. 唯一获准的 Alice `ScheduleScanner` → versioned UTA admission → reduce-only 跨进程场景：
   issue #194、PR #196、merge `e73302e8`；定向 1/1，完整 3306 passed / 6 skipped。

D3 每条 lane 均由实现者之外的 critic 给出 APPROVE；证据未调用 model/agent，未运行 campaign、
holdout、broker/demo account、paper/live，也未修改 prompt 或引入 D4+ 行为。

两项不稳定测试的 review 结论固定如下：

1. 早先 UI renderer 的 localStorage signal 在 fresh isolated 11/11 rerun 与正确串行化的 #186
   完整 gate（3298 passed / 6 skipped）均通过；结论为 invocation/isolation noise，不是回归。
2. 未改动的 128-way concurrent Risk Envelope revoke 测试是既存 timeout-budget flake：baseline
   与两个 D3 branch 在负载下均可能略超 5s default，但在 15/20s timeout 下约 7–8s 完成并给出
   正确 monotonic 结果；D3 改动文件不触及该 subsystem。最终 D3 完整套件统一使用
   `pnpm test --testTimeout=15000` 并全部通过，未为此修改 runtime 或 test code。

D2 关闭时接受两个 non-blocking operational residual；它们不授予运行权，也不得被遗漏：

1. 进程在持有 accounts-config transition gate 时崩溃，会有意留下 fail-closed gate，必须由
   operator 清理。
2. 与未发布的 pre-fix directory-lock 实现进行 live rolling coexistence 不受支持；静态 legacy
   lock directory 仍保持兼容。

据上述 receipt，D2 与 D3 completion gate 均已满足；issue #197 现将 `AUTH-D2` / `AUTH-D3`
正式关闭并消费。两者不可用于 polish、邻接实现、重复扩 scope 或任何运行活动。

#### 历史执行纪律、持续非目标与关闭结论

- 上述工作遵循 fork 纪律：issue → `.worktrees/issue-N` → 独立实现者 → 独立 critic → PR 到
  `jieke/dev` → `--merge` 合并 → 删除 local/remote branch 与 worktree。实现者不得自审替代
  critic；D2 风险路径必须由 safety critic 审查。
- 各 lane 的 worktree app/test 设置 `OPENALICE_HOME=$PWD/.sandbox-home`、
  `AQ_LAUNCHER_ROOT=$PWD/.sandbox-ws`；需要 Node localStorage 时同时设置
  `NODE_OPTIONS=--localstorage-file=$PWD/.sandbox-home/node-localstorage`。每个 PR 至少通过相关
  定向测试、根 `npx tsc --noEmit`、完整 `pnpm test` 与 `git diff --check`。
- D3 harness/manifest/cost-scheduler 曾与 D2 不相交 lanes 并行；D3 的唯一跨进程测试已等待
  D2 versioned admission wire 合并并通过安全审查，不得用测试依赖反向扩张 `AUTH-D2`。
- 新发现且未计划的 bug 或 safety finding 立即停止受影响 lane，单独报告；在 maintainer 明确
  确认范围前不得顺手修复、扩大 PR 或合并。
- 不授权 D4+ proposal-only run、campaign、holdout、model comparison、mock autonomy、真实或
  demo broker/account、paper、live 或其数据采集/调参。除上文单项隔离测试外，不授权任何
  account/broker activity 或 broker mutation。
- ledger v3 所需的 `instruction.md` 机械同步已在 issue #174 / PR #184 下完成，并按
  `steward-prompt-anatomy.zh.md` 登记；这是已消费 `AUTH-D2` 内的历史事实，不是持续授权。
  `AUTH-D2` / `AUTH-D3` 关闭并消费后，未来任何机械或行为性的 `instruction.md` / prompt
  变更都必须**先**取得 maintainer 新签发的明确授权，之后才能进行 anatomy 登记或文件编辑；
  anatomy 登记本身不构成授权。
- `AUTH-D2` 与 `AUTH-D3` 从未互相授权，也不授予 D4+ 或任何后续 token。两项 gate 已通过并
  冻结，issue #197 已完成 mandatory documentation-only closeout 并关闭、消费两个 token；
  closeout 本身不构成下一阶段授权。

### 5.3 阶段表

| 阶段 | 目标                                                           | 当前授权               | 完成门                                                                                      |
| ---- | -------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| D0   | 统一方向、归档旧文档、收口遗留 branch                          | 已授权并完成         | canonical docs 无矛盾；旧 branch 进入 ancestry 且 runtime tree 零变化                       |
| D1   | 设计 Decision Intent、Information Snapshot、Risk Envelope 契约，以及 wake 控制面迁移（app-server / agent-sdk，§4.4）设计 | 契约设计已批准（PR #157，2026-07-11）；控制面迁移已落地（§4.4）；D1 本身不授权 runtime，当前无后续 token | schema、责任边界、失败语义、迁移影响经 maintainer 批准；控制面设计含协议版本 pin 与回退策略 |
| D2   | 补齐 autonomous execution 的确定性安全前置                     | **已完成并冻结；`AUTH-D2` 已由 #197 关闭并消费，当前无 D2 token** | §5.2 六条 safety lane、并发/恢复证据与独立 safety APPROVE 全部通过                         |
| D3   | 建立三层 eval harness                                          | **已完成并冻结；`AUTH-D3` 已由 #197 关闭并消费，当前无 D3 token** | 三层/manifest/cost scheduler + 唯一有界跨进程测试 + 独立 APPROVE 全部通过                  |
| D4   | Proposal-only 决策试点                                         | 未授权运行             | 多资产/事件化 as-of replay；只产 proposal，不 auto-push                                     |
| D5   | 隔离 mock bounded autonomy                                     | 未授权运行             | 强制风险包络、重复执行幂等、撤权、对账与 recovery 全过                                      |
| D6   | 真实 paper broker 候选                                         | 未授权                 | D0–D5 证据审查通过，另行批准 broker 与测试窗口                                              |
| D7   | 小额 live 候选                                                 | **不在当前路线授权内** | 独立安全计划、法律/运营边界与用户显式授权                                                   |

任何阶段都不能因为“前一阶段没有发现 issue”自动进入下一阶段。当前没有任何 D2/D3/D4+
implementation 或 run token；`AUTH-CP-*`、`AUTH-D2` 与 `AUTH-D3` 均不可复用。D4+ 以及任何
model/campaign/holdout/mock autonomy/account/broker/paper/live/prompt 行为仍未授权；超出范围必须
重新取得 maintainer 明确授权，并先在本文登记。

## 6. D0 文档真源

| 文档                                             | 唯一职责                                | 不承担什么                  |
| ------------------------------------------------ | --------------------------------------- | --------------------------- |
| 本文                                             | 活动方向、阶段、授权与停止条件          | 具体实现细节、实验流水账    |
| `steward-decision-contracts.zh.md`               | Decision Intent / Information Snapshot / Risk Envelope 契约 schema 与失败语义（D1 交付物，2026-07-11 批准） | 方向/阶段授权、runtime 实现细节 |
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

- v2.7（2026-07-13）：完成 issue #197 的 mandatory documentation-only closeout。按 issue #172
  integration receipts 登记 D2 主 lane（#174/#184/`59ba44a7`、#185/#191/`67ffa679`、
  #186/#192/`9b4078af`）、四项前置修复、定向/完整测试、lock/revoke/risk concurrency、
  durable recovery/lost-response dedupe 与 independent safety APPROVE；登记 D3 lane
  （#187/#189/`0ceac856`、#193/#195/`ccb8b098`、#194/#196/`e73302e8`）、各 lane 测试与
  independent APPROVE。同步固定 UI localStorage invocation/isolation noise 与 128-way revoke
  既存 5s timeout-budget flake 两项结论，并保留 accounts-config crash gate operator cleanup、
  不支持与未发布 pre-fix directory lock live rolling coexistence 两项 D2 operational residual。
  `AUTH-D2` / `AUTH-D3` 自此关闭并消费，D2 / D3 完成并冻结；不签发 D4+ 或其他 token，不授权
  model/campaign/holdout/mock autonomy/account/broker/paper/live/prompt 行为。
- v2.6（2026-07-12）：maintainer 签发相互独立的 `AUTH-D2` / `AUTH-D3`（issue #172）。D2 仅覆盖 ledger v3 /
  Snapshot M1 / raw fingerprint 兼容、mandatory envelope、单向 revoke、execution-time version
  recheck、确定性 sizing/source-state version 与独立 Execution Record；D3 仅覆盖三层 harness、
  data-manifest enforcement、model-cost scheduler 实现及一项 Alice→versioned admission→UTA
  reduce-only 隔离测试。§5.2 同步冻结 fork/隔离测试/完整验证/独立 critic 纪律、非目标与 gate
  exit；D4+、prompt 调优和任何 campaign/holdout/mock/paper/live/broker 运行仍未授权。
  `AUTH-CP-D2` / `AUTH-CP-D3` 保持已消费；D2/D3 完成后须 documentation-only closeout 消费
  新 token，不自动获得后续授权。
- v2.5（2026-07-12）：Wave 0.5 契约证明完成并经独立审查批准：D2 为 issue #163 / PR #167 /
  merge `0a94b214`（定向 40；完整套件 3039 passed / 6 skipped），D3 为 issue #164 /
  PR #168 / merge `f968543c`（D2+D3 定向 79；完整套件 3078 passed / 6 skipped）；两者
  TypeScript 与 diff check 均通过。`AUTH-CP-D2` / `AUTH-CP-D3` 自此关闭并消费，不得再被
  后续工作援引；D2/D3 production、prompt、run、holdout、mock、paper/live、account、UTA 与
  broker 权限不变，仍须分别取得新的 `AUTH-D2` / `AUTH-D3`，且不自动晋级。
- v2.4（2026-07-12）：maintainer 批准六项 G0 决定，并授予 `AUTH-CP-D2` +
  `AUTH-CP-D3` 用于 Wave 0.5 测试型契约证明（issue #165）。授权只覆盖 schema
  fixtures、golden vectors、evaluator examples、pure validators 和 tests；不授权 D2/D3
  production runtime/harness、prompt、campaign/model run、holdout、mock、paper/live 或 broker
  mutation。Proof 审查通过后仍须分别取得新的 `AUTH-D2` / `AUTH-D3`，不自动晋级。
- v2.3（2026-07-11）：D1 契约设计交付并获 maintainer 批准
  （[steward-decision-contracts.zh.md](steward-decision-contracts.zh.md) v0.2，issue #156，
  PR #157）；该文档登记入 §6 真源表，职责为三契约 schema 与失败语义。D1 的设计部分
  就此完成；**不改变 D2+ 授权语义——runtime 实现仍须另行授权**。
- v2.2（2026-07-11）：§4.4 wake 控制面迁移已落地（issue #146，S0–S6，PR #147–#151）。
  无人值守 wake 的默认控制面从 PTY 文本注入翻转为原生 CLI 机器协议
  （`codex app-server` / `@anthropic-ai/claude-agent-sdk`）；显式 `controlFace: 'pty'` 作为
  一等逃生舱 / 回退杠杆强制 PTY；交互式 workspace 仍保留 PTY。实现真源见
  `trading-agent-architecture.zh.md` §1 / §3，实现参考见
  `steward-persistent-loop-implementation.zh.md` §5。仅登记落地事实，不改本文授权语义。
- v2.1（2026-07-11）：新增 §4.4 wake 控制面路线：无人值守 wake 从 PTY 注入迁移到
  `codex app-server` / `claude-agent-sdk` 机器协议；交换器采用 OpenAlice 内改造形态
  （工作量最小原则）；控制面迁移设计并入 D1；§2 补充 PTY 现状与机器接口事实基线。
- v2.0（2026-07-11）：Ubuntu OpenAlice freeze 后重写。停止 prompt-first participation 调优，
  把 proposal-first、Decision Intent、mandatory Risk Envelope、评测分层和 bounded autonomy
  定为新路线；旧 v1.1 与阶段文档归档。
- v1.1（2026-07-10）：旧 S0–S2 风险优先路线，现存档于
  [archive/steward-2026-07/steward-plan.zh.md](archive/steward-2026-07/steward-plan.zh.md)。
