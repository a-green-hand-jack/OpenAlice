# Steward 实施计划

> 版本：v1.0（2026-07-04）
> 地位：**稳定文档**。本计划在一段时间内保持不变，作为在 OpenAlice 基础上实现 Steward 的唯一顺序依据。调整计划（增删阶段、改变顺序、修改验收标准）是 director 决定，需要用户明确批准并升版本号；实现会话不得自行改动本文档。
> 依据：[steward-direction-research.zh.md](steward-direction-research.zh.md)（版图调研 + OpenAlice 盘点 + 选型结论）及其附录。
> 目标定义：[Steward Vision v0.3](https://gist.github.com/a-green-hand-jack/be25ea9deafce31355110e8924bd7757)——长期运行、Observe→Operate、默认保守、可审计、风险优先、有记忆复盘的资产管理 agent。

---

## 如何使用本计划（每个实现会话必读）

1. **按 P0→P6 顺序执行，不跳段、不并行开段。** 一个阶段的验收标准全部满足、用户确认后，才开始下一阶段。阶段内部可以拆成多个 PR。
2. 每个 PR 走仓库标准流程：feat 分支 → PR to master（或按用户指示走 `local`），PR body 带 Summary / Test plan / **Boundary touch**（本计划几乎每个阶段都触及 trading/auth，必须标注）。
3. 动手前先读的仓库文档：`CLAUDE.md`（全部）、`docs/event-system.md`（P2 触及事件类型时）、`docs/uta-live-testing.md`（每个触及交易路径的阶段）。
4. 阶段中发现的界外问题 → 按 CLAUDE.md 规则开 Linear issue（`Angelkawaii` / `TODO from AI Code`），不扩大当前阶段范围。
5. 本文档给的 file:line 锚点是 2026-07-03 盘点时的事实。代码会漂移——锚点用于定位，以当时代码为准，不要因为行号对不上而怀疑任务本身。

## 全局不变量（任何阶段、任何 PR 都不得违反）

- **I1 保守默认不可弱化**：`agent.allowAiTrading` 默认 false、keyless⟹readOnly、AI 的 push 工具在未授权时不触 broker——这些既有行为只能加强不能放松。
- **I2 授权单向性**：授权只能由人经 UI 显式放宽；系统/agent 侧的自动变化只允许**收紧**（降级、锁定、halt），永不允许自动放宽。
- **I3 风险机制是确定性代码**：所有风险边界（guard、状态机、kill switch、限额）实现在 UTA 侧的普通代码里，独立于 LLM，不依赖任何模型判断。LLM 永远不在风险检查的信任链上。
- **I4 全程可审计**：每个新增的重要动作（风险状态变化、授权变更、审批、执行）都要能回答五问：看到什么/为什么/谁批准/什么检查/结果如何。
- **I5 License 纪律**：freqtrade、lumibot 是 GPL——**只参考设计，严禁复制代码**；hummingbot（Apache-2.0）、TradingAgents（Apache-2.0）可移植代码需保留出处注释；OpenBB（AGPL）只能进程外经 MCP/HTTP 使用。
- **I6 边界纪律**：broker/凭证/交易状态只在 UTA；agent 能力扩展走 workspace template + 卫星仓库，不进 `src/` 新模块；跨进程 shape 只走 `@traderalice/uta-protocol`。
- **I7 持久状态变更走 migrations**：任何 `data/` 下用户状态的 schema 演进必须走 `src/migrations/` 框架（含幂等自检 + spec），禁止启动时 ad-hoc 清理。
- **I8 每阶段验证门**：`npx tsc --noEmit` + `pnpm test` 干净；触及交易路径则在 mock/paper 账户跑相关 UTA live-testing 场景（S1–S12 中适用者 + 本阶段新增场景）；每个修的 bug 配一个回归 spec。
- **I9 paper 优先**：任何新机制先在 mock/paper 账户端到端验证，实盘账户永远最后、且只在用户明确要求时触碰。

---

## 阶段总览

| 阶段 | 名称 | 补的空白 | 为什么在这个位置 |
|---|---|---|---|
| P0 | 基线冻结 | — | 给既有安全机制上回归测试，防止后续阶段无意弱化 |
| P1 | 风险状态机（风险脊柱） | 空白④（kill switch/回撤/去风险） | 没有它，任何授权放宽都不安全；后续所有阶段依赖它 |
| P2 | 审计链闭环 | 空白③的两个缺环 | 小改动快速闭环；P3 的授权变更需要它来留痕 |
| P3 | 渐进授权阶梯 | 空白①② | 依赖 P1（限额和状态机是阶梯的执行基础）和 P2（变更留痕） |
| P4 | Steward workspace 模板 | Observe→Operate 循环 | 依赖 P3（模板要按 tier 拿到正确的工具面） |
| P5 | 记忆→规则复盘管道 | 空白⑥ | 依赖 P4（复盘的输入是观察循环的产出） |
| P6 | paper→live 晋升制度 | 空白⑧ | 收尾：把前面所有机制组装成正式的运行制度 |

---

## P0 — 基线冻结

**目标**：把 OpenAlice 现有的三项独有安全资产（审批门、审计面、账户只读）用回归测试钉死，成为后续所有阶段的安全网。

**范围（in）**：
- 为以下既有行为补齐缺失的 spec（已有的不重复写）：
  - `allowAiTrading=false` 时 `tradingPush` 工具不触 broker、返回 awaiting-approval（锚点 `src/tool/trading.ts:748`）
  - 真 push 只能走人类 HTTP 路由（`services/uta/src/http/routes-trading.ts:450`）
  - `readOnly` 账户拒绝 stage/commit/push；keyless⟹readOnly（`src/core/config.ts:447-450`）
  - TradingGit commit 持久化含 thesis/operations/results/stateAfter（`TradingGit.ts:122-131`）
  - 三个既有 guard（MaxPositionSize/Cooldown/SymbolWhitelist）在 execute 路径生效
- 在 mock 账户跑一遍 S1–S12 场景目录，记录基线结果（存 `docs/appendix/steward-p0-baseline.md`）

**范围（out）**：不改任何产品行为；发现的 bug 只修阻断级的，其余开 Linear。

**验收标准**：
- [ ] 上述五组行为各有至少一个直接断言它的 spec，`pnpm test` 通过
- [ ] S1–S12 基线记录入库
- [ ] 无产品行为变化（diff 只含测试与文档）

---

## P1 — 风险状态机（风险脊柱）

**目标**：在 UTA 侧建成确定性的风险安全层：组合级 guard、账户风险状态机、紧急停止。这是全仓库目前完全缺失的支柱（盘点 grep 零命中）。

**关键设计决定（已定，不再讨论）**：
- 位置：全部在 `services/uta/src/domain/trading/`，作为现有 `guards/` pipeline 的扩展 + 一个新的账户级状态机。
- 状态机四态：`NORMAL → CAUTIOUS → READ_ONLY → HALT`。降级自动（guard 触发），**升级只能人工**（I2）。
- 状态持久化在 `data/trading/<accountId>/` 下（重启存活），进程重启后恢复到持久化的状态，绝不重置回 NORMAL。
- guard 判定结果结构化（`{guard, verdict: pass|reject|degrade, reason, metrics}`），不再只是 error string——这是 P2 审计入档的前置。
- 设计参考：hummingbot `ActiveKillSwitch` / `BudgetChecker`（Apache，可移植）；freqtrade `ProtectionManager` / `MaxDrawdown` / `StoplossGuard`（GPL，只参考设计）。

**范围（in）**：
1. 组合级 guards（数据源用现有 snapshot/持仓）：
   - `MaxDrawdownGuard`：净值自高点回撤超阈值 → 账户降级 CAUTIOUS/READ_ONLY
   - `DailyLossGuard`：单日亏损超阈值 → 降级
   - `ConcentrationGuard`：单标的/单类资产敞口超阈值 → 拒绝加仓方向的新单
2. 账户风险状态机：状态影响行为——CAUTIOUS 只允许减仓方向操作；READ_ONLY 拒绝一切 stage/commit/push；HALT 同 READ_ONLY 且 UI 顶部横幅告警。
3. 紧急停止：一个人工触发的 kill switch API + UI 按钮（HALT + 可选撤全部挂单）；强制平仓（flatten）作为独立的人工触发操作，本阶段**不做自动平仓**。
4. 阈值配置进 `utaConfigSchema`（每账户），走 migrations（I7）；默认值取保守档。

**范围（out）**：自动 flatten/自动减仓（推 P6 再议）；LLM 参与任何风险判断（永久 out，I3）；per-workspace 维度（P3 的事）。

**验收标准**：
- [ ] mock 账户上演示：制造回撤超限 → 账户自动降 READ_ONLY，agent 的 stage 被拒绝，UI 可见状态与原因
- [ ] kill switch 一键 HALT，重启后状态仍是 HALT，人工恢复 NORMAL 有效且留痕
- [ ] 每个 guard、每个状态转换各有 spec；`pnpm test` + tsc 干净
- [ ] 新增风险场景补进 live-testing 目录（作为 S13+ 场景文档化），mock/paper 跑通

---

## P2 — 审计链闭环

**目标**：补齐审计五问中缺失的两问："谁批准"和"跑过哪些检查"，并把交易生命周期接入统一事件流。

**关键设计决定**：
- push 路由记录 approver 身份（当前唯一身份是 admin token 会话；记录 session/token 指纹即可，多用户是未来问题）。
- guard 结构化结果（P1 产物）写进两处：TradingGit commit（执行时的检查快照）+ event-log（`trade.*` 事件）。**通过的检查也入档**，不只记拒绝。
- 新增 `trade.*` 事件类型走 `docs/event-system.md` 的完整清单流程（事件类型定义 → map → 触发点 → 文档），不得半做。
- 风险状态变化（P1）与授权变更（P3 预留）同样入 event-log。

**范围（out）**：防篡改哈希链（现有 append-only JSONL + git 版本化已够第一阶段；加密链路开 Linear 备忘）；审计 UI 页面（有 Inbox/现有 UI 面即可，独立审计视图推后）。

**验收标准**：
- [ ] 任取一笔 mock 账户上的完整流程（stage→commit→人工 push），能从持久化数据重建五问全部答案，写一个端到端 spec 证明
- [ ] guard 通过/拒绝在 commit 与 event-log 双处可查
- [ ] `docs/event-system.md` 清单同步更新

---

## P3 — 渐进授权阶梯

**目标**：把二元开关升级为 Steward 的四档授权阶梯，且能按 workspace 裁剪 agent 的工具面。全行业无先例（调研结论），这是自建部分中设计风险最高的阶段——**实现前先出一页设计稿给用户过目**。

**关键设计决定（已定）**：
- 四档：`read_only → paper → small_live → limited_autonomy`。
- 维度：**账户 × workspace**。账户侧 tier 决定该账户允许的最高档；workspace 侧绑定决定该 workspace 内 agent 实际拿到的档（不得高于账户上限）。
- 工具面裁剪落点：`core/workspace-tool-center.ts`（每 workspace MCP 面已存在，天然的裁剪点）；`claudeCode.allowedTools/disallowedTools`（`config.ts:220-238`，已定义未接线）接线为实现手段之一。
- `small_live`：保留逐笔人工 push（现有审批门不变），叠加金额上限（单笔 + 单日，UTA 侧强制）。
- `limited_autonomy`：预算限额内免逐笔审批（Coinbase spend-permissions 模式作为硬护栏：session/日预算、单笔上限、标的白名单），但 P1 风险状态机可随时把它收回到 READ_ONLY——自动收紧永远有效（I2）。
- tier 变更只能人工经 UI，变更本身入 P2 审计链。
- 配置 schema 变更走 migrations；默认一切新 workspace = `read_only`。

**范围（out）**：多用户/角色分离（单 operator 模型不变）；`/mcp` 全局面的认证改造（开 Linear，属安全加固不属阶梯本身）。

**验收标准**：
- [ ] 设计稿经用户批准后才动工
- [ ] 演示：同一账户下两个 workspace，一个 read_only（无写工具可见）、一个 paper（可 stage/commit paper 账户），工具面差异可证明
- [ ] `small_live` 超单日限额的 push 被 UTA 拒绝（即使人工批准也拒绝——限额是硬的）
- [ ] `limited_autonomy` 在预算内免审批执行成功；触发 P1 降级后立即失效
- [ ] tier 提升留痕可查；migration + spec 齐全

---

## P4 — Steward workspace 模板（Observe→Operate 循环）

**目标**：把"长期观察循环"做成一个内置 workspace 模板 `steward`，六类对象的观察结构化，产出走 Inbox，提案走 TradingGit 停在审批门前。

**关键设计决定**：
- 交付形态是**模板 + prompt/skill 资产**，不是 `src/` 新模块（I6）。`src/workspaces/templates/steward/bootstrap.mjs`（跨平台规则：ESM、`_common.mjs` 的 `git()`，禁止 `spawn('git')` 和新 `.sh`）。
- 调度用现成机制：`.alice/issues/*.md` 的 cron 声明 → ScheduleScanner → headless run。核心节奏：每日一次 observe run（读组合/风险状态/市场/近期 commit 历史/上次观察报告 → 写结构化观察文档 → `inbox_push`）；提案性动作 stage+commit 后停住（awaiting approval）。
- 观察报告的六对象结构固定为模板内的文档骨架（用户目标授权/组合/风险/市场/策略工具/历史轨迹各一节），报告本身落在 workspace git 里（版本化=历史轨迹）。
- prompt 结构参考 TradingAgents 的角色分工（分析→多空辩论→风控辩论→组合经理），作为模板 skill 文本的设计蓝本（Apache-2.0）。

**范围（out）**：多 workspace 协同、策略研究模板（qlib/FinRL 卫星仓库，独立可选项）；任何绕过审批门的执行路径。

**验收标准**：
- [ ] 从模板创建 workspace，零人工干预连续运行 ≥5 个调度周期：每周期 Inbox 收到结构化观察报告
- [ ] 期间产生的交易提案全部停在 awaiting approval，无一触 broker
- [ ] 模板在 bare 环境（无系统 git/bash）可 bootstrap（跨平台不变量）

---

## P5 — 记忆→规则复盘管道

**目标**：把"记录"升级为"规则"：决策结果回流 → 反思生成教训 → 教训经人批准后变成可执行约束。

**关键设计决定**：
- 三段管道：
  1. **outcome 回流**：push 后 T+N（默认 T+5 交易日）自动生成 outcome 记录（基于 snapshot/order-history 对比 commit 时的 thesis），确定性代码实现，挂在现有 snapshot/scheduler 机制上。
  2. **reflection**：steward workspace 的一个定期 headless run 读 outcome + 原 thesis，生成 lesson 文档（TradingAgents 的 decision→outcome→reflection 模式，Apache-2.0 可抄结构）。lesson 持久化在 workspace git + 摘要进 EntityStore。
  3. **晋升**：lesson 可以被**人工批准**晋升为机器可执行约束（新的 SymbolWhitelist 条目、更严的限额、guard 阈值调整）。晋升动作走 UI、入审计链。**LLM 生成的 lesson 永远不自动改风控配置**（I2/I3）。
- lesson 的存储 schema 参考 lumibot MemoryStore 的字段设计（lessons/theses，GPL——只参考字段设计）。

**范围（out）**：自动晋升（永久 out）；跨账户 lesson 共享（推后）。

**验收标准**：
- [ ] mock 账户上一笔亏损交易在 T+N 后自动产生 outcome 记录，复盘 run 产出引用该 outcome 的 lesson
- [ ] 用户在 UI 批准该 lesson 晋升为一条约束后，后续同类 stage 被 guard 拒绝且拒绝理由引用该 lesson
- [ ] 未批准的 lesson 只存在于记忆层，对执行无任何影响（spec 证明）

---

## P6 — paper→live 晋升制度

**目标**：把 P1–P5 组装成正式的运行制度：每档授权的晋升标准、要求的评审工件、风险触发的自动降级路径。

**关键设计决定**：
- 晋升标准文档化为 `docs/steward-graduation.zh.md`（本阶段产出）：每档最低运行时长、表现要求（如 paper 档 ≥30 天无 guard 拒绝事故）、需人工评审的工件清单（观察报告样本、审计链抽查、lesson 记录）。
- 自动降级规则接入 P1 状态机：live 档账户触发 HALT/READ_ONLY 后，恢复默认落回上一档（live→small_live→paper），重新晋升需再走标准——降级自动、恢复人工（I2）。
- 可选扩展（不阻塞主线，做不做由用户当时决定）：Alpaca MCP 作为外部轨道互操作验证；OpenBB MCP 数据补强（AGPL 进程外）；qlib/RD-Agent/FinRL 研究模板卫星仓库。

**验收标准**：
- [ ] 晋升制度文档入库并经用户批准
- [ ] 自动降级路径在 mock 上演示：limited_autonomy 账户触发回撤 → 降 READ_ONLY → 人工恢复只能回到 small_live
- [ ] 全链路演习：从新账户 read_only 起步，按制度走完 paper→small_live 的完整晋升（mock/paper 环境），全程审计链可查

---

## 变更管理

- 本计划 v1.0 冻结。执行中发现的设计问题：能在阶段验收标准内解决的就地解决；动摇关键设计决定的，暂停该阶段、带着具体证据找用户裁决，裁决后升版本号（v1.1、v2.0）并在此节记录变更日志。
- 变更日志：
  - v1.0（2026-07-04）：初版，依据 2026-07-03 三路调研。
