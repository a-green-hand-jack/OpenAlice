# Steward P2 阶段计划 — 审计链闭环 + LLM-Agent e2e 观测

> 版本：草案 v0.2（2026-07-05）——已内联答复 maintainer 批注（§2）
> 地位：**阶段执行文档**，从属于 [steward-plan.zh.md](steward-plan.zh.md)（v1.0 冻结）。本文不改动冻结计划的任何阶段/顺序/验收标准；e2e 观测演习是 I8/I9（验证门 + paper 优先）范围内的验收强化，不构成计划变更。
> 用途：maintainer 与实现会话通过本文档对齐。maintainer 直接批注/修改本文，确认后按 §5 的顺序开工。

---

## 1. P1 回顾 — 我们刚做完什么

P1（风险脊柱）五个组件全部合并进 fork master（`81237cb1`），2375 个测试全绿，四项 CI 门禁常态运行：

| Issue | PR  | 交付物                                                                                                                                                  |
| ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #15   | #24 | **审批状态持久化**：TradingGit 的 stagingArea / pendingMessage / pendingHash 落盘，进程重启后待审批提案不丢失                                     |
| #18   | #25 | **结构化 guard 判定**：每次 push 逐 guard 记录 `{guard, verdict: pass\|reject\|skipped, reason, metrics}`——通过的检查也入档，为 P2 审计入档打底 |
| #19   | #27 | **组合级 guards**：MaxDrawdown（回撤降级）、DailyLoss（日亏降级）、Concentration（集中度拒加仓）；明确减仓方向的操作永不被组合级 guard 拦截       |
| #20   | #28 | **账户风险状态机**：NORMAL → CAUTIOUS → READ_ONLY → HALT；降级自动、升级只能人工；重启存活；状态文件损坏 → 保守失效到 READ_ONLY 并隔离原文件  |
| #21   | #30 | **Kill switch**：紧急停止（HALT + 撤全部挂单）、人工强制平仓（需精确确认词 FLATTEN）；AI 侧零暴露，只有只读 `riskStatus` 工具                   |

流程沉淀：codex 实现 → 全量门禁（tsc / pnpm test / anatomy-drift / 包 typecheck）→ sonnet 活体审查（**必须实际运行 OpenAlice 全栈**）→ 修复轮 → PR → maintainer 亲测后合并。活体审查在 P1 抓到的真实缺陷：损坏状态锁死平仓、totalQuantity 绕过集中度、并发评估自动放松竞态、失败撤单跟踪丢失——全部是纯读代码抓不到的。

遗留 issue 池（不阻塞 P2）：#12 flag-watcher、#13 mock 夹具、#14 flaky 测试、#17 引用竞态、#22 push 持久化失败窗口、#23 discard-staged、#26 流感知基线、#29 应急操作投影。

---

## 2. 现状：LLM-Agent 现在怎么工作？Loop 转起来了吗？

**结论：单圈链路（观察 → 提案 → 人工批准 → 执行 → 留痕）已经可以手动走通；但"长期循环"没有转起来——调度、复盘、审计闭环三个环节还缺。**

一个 agent 今天的工作方式：

1. 人创建 workspace（模板 bootstrap 出 git checkout），选定 agent CLI（claude / codex / opencode / pi），凭证由 credential-injection 注入。
2. workspace 内的 agent 经 MCP 拿到交易上下文工具面：行情 / 新闻 / 分析 / UTA SDK（`alice-uta` CLI 同面）。
3. **Observe**：读组合、持仓、订单、只读风险状态（`riskStatus`）、行情与新闻。
4. **Propose**：`stage` → `commit`（必须带 thesis）——到此为止。**push 是人类专属 HTTP 路由**，`allowAiTrading` 默认 false，AI 无任何触 broker 路径。
   1. > 这里要怎么理解，是agent给出了一个交易的计划吗
      >
   2. **答（2026-07-05）**：是。stage→commit 就是 agent 产出一份交易计划的结构化形态：`stage` 把一笔笔具体订单意图（标的/方向/数量/价格，可含 TP/SL 保护腿）放进暂存区（类比 git add）；`commit` 把这批订单连同一段书面 thesis（看到了什么、为什么做这笔）打包成一个待审批变更集（类比 git commit）。一个 commit 可以含多笔订单（比如进场单+止盈止损腿）。此刻 broker 侧什么都没发生——计划只是持久化在审批队列里，人 push 才会执行。
5. **Execute**：人工 push 后，UTA 侧确定性 guards 管道（仓位/冷却/白名单 + P1 组合级）+ 风险状态机把关，LLM 不在信任链上（I3）。
   1. > 这里是不是可以这样理解：每次agent 给出的交易计划都需要人类审批
      > 但是agent 给出交易计划是什么频率呢
      > 如果频率很高的话人类能审核的过来吗
      > 如果频率很低的话是不是又不能及时对交易做出调整
      >
   2. **答（2026-07-05）**：理解正确——**今天每一份计划都需要人工 push，无例外**。频率与及时性的矛盾是真问题，冻结计划分三层解它：
      - **频率**：agent 只在被人启动或被 cron 调度时工作，产计划频率 = 调度频率。P4 把 steward 节奏定为**每日一次 observe run**。Steward 的定位是长线资产管理（日/周级、论点驱动），不是日内高频——"人审得过来"是设计出来的属性，不是碰运气。
      - **审核负担**：这正是 P3 渐进授权阶梯存在的理由。`limited_autonomy` 档在人**预先批准的预算内**免逐笔审批（日/会话预算、单笔上限、标的白名单，全部是 UTA 侧硬限制），超预算的计划照旧排队人工审。终局形态：常规小额再平衡自主跑，大动作才占用人的注意力。
      - **及时性**：市场急变不等下一次审批。(a) commit 可带 TP/SL 保护腿——人批准的是"进场+退出规则"整个包，退出规则在场内自动生效；(b) 减仓/平仓方向的操作永不被组合级 guard 拦截（P1 已实现）；(c) 风险状态机自动降级 + 人工 kill switch/flatten 是不经过 agent 的即时刹车。一句话：**加风险要等人，去风险不等人**。
6. **留痕**：order-history、snapshot、guard 判定入档；agent 可经 `inbox_push` 向用户推送报告。

按 Steward 六环拆开看：

| 环节                                    | 状态              | 说明                                                                                                                                                                       |
| --------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observe（市场/组合/风险）               | ✅ 可用           | MCP 工具面齐全，P1 新增只读风险状态                                                                                                                                        |
| Propose（stage→commit+thesis）         | ✅ 可用           | 重启存活（PR#24）                                                                                                                                                          |
| Approve（人工审批门）                   | ✅ 可用           | 人类专属 push；P1 状态机可整体收紧                                                                                                                                         |
| Execute + 风险把关                      | ✅ 可用           | P1 交付的确定性风险脊柱                                                                                                                                                    |
| **Audit（五问可重建）**           | 🟡 缺两问         | 看到什么（tool-call log）✅ / 为什么（thesis）✅ / 什么检查（PR#25 判定）✅ / **谁批准 ❌** / 结果如何 🟡（order results 有但未接统一事件流）——**这就是 P2** |
| **Review（outcome→反思→教训）** | ❌ 未建           | P5 的内容，当前完全没有                                                                                                                                                    |
| **循环调度（长期自主观察）**      | 🟡 机制在、未验证 | cron→headless run→inbox 的机制存在，但没有 steward 模板、没有验证过多周期连续运行——P4 的内容                                                                           |

还有一个诚实的空白：**到目前为止所有端到端验证都是"审查 agent 照 S1–S12 脚本驱动 CLI"**——我们验证过工具面和风险边界，但还从未让一个 LLM agent 以 steward 姿态**自主**工作一整圈并观测它的真实行为。这正是本阶段要补的（§4）。

---

## 3. P2 代码工作 — 审计链闭环（照冻结计划）

目标（steward-plan P2 原文）：补齐五问中的"谁批准"和"跑过哪些检查"，交易生命周期接入统一事件流。

拆成三个 issue（顺序执行，每个走标准流水线：worktree → codex → 门禁 → 活体审查 → PR → maintainer 合并）：

### Issue A — approver 身份入档

- push 路由（`services/uta/src/http/routes-trading.ts` 人类专属路由）记录批准者身份：当前唯一身份是 admin token 会话，记录 session/token 指纹即可（多用户是未来问题）。
- 身份写进 TradingGit commit 记录（持久化）；wire 类型走 `@traderalice/uta-protocol` 加**可选字段**（additive，不破坏旧数据）。
- 同样入档：kill switch / flatten / 风险状态人工恢复的触发者身份（P1 留下的三个人工路由）。
- 历史数据无该字段 → 读取时容忍缺失（不做回填 migration，字段可选即可）。

### Issue B — `trade.*` 事件接入统一事件流

- 新事件类型走 `docs/event-system.md` **完整清单流程**（类型定义 → map → 触发点 → 文档同步），不得半做。
- 建议事件集：`trade.committed`、`trade.pushed`（含 approver + 逐 guard 判定）、`trade.executed`、`trade.rejected`（guard 拒绝）、`risk.state-changed`（P1 状态机转换）、`risk.emergency-stop` / `risk.flatten`（kill switch）。
- guard 结构化判定（PR#25 产物）双写：TradingGit commit（已有）+ event-log（本 issue）。**通过的检查也入档。**
- 事件源在 UTA 进程、event-log 在 Alice 侧——跨进程投递方案由实现会话先勘察（webhook ingest 是现成入口），设计定下后写进 PR 描述。

### Issue C — 审计五问端到端 spec + 文档

- 一个端到端 spec：mock 账户完整流程（stage → commit → 人工 push → 执行），**只从持久化数据**重建五问全部答案并断言。
- `docs/event-system.md` 清单同步；terminal-runbook 补审计查询一节。

**范围外**（冻结计划已排除）：防篡改哈希链（开 Linear 备忘）、独立审计 UI 页面。

---

## 4. e2e 观测演习 — 观测 LLM-Agent 的真实工作情况（本阶段新增的验收强化）

maintainer 要求：e2e 运行并观测 LLM-agent 的工作情况。方案是两次演习，夹住 P2 代码工作：

### 演习一（P2 开工前）：现状行为观测

- **目的**：第一次让真实 LLM agent 以 steward 姿态自主走一圈，观测它实际怎么用工具面——产出行为基线，也为 P4 的 steward 模板设计收集第一手输入。
- **环境**：沙箱 home（`OPENALICE_HOME` / `AQ_LAUNCHER_ROOT` 隔离）+ mock-simulator 账户 + 全栈真实运行（Guardian → UTA → Alice）。
- **做法**：创建 workspace（真实 agent CLI，非脚本），下达 steward 式任务——"观察组合与市场，选一个标的形成交易论点，stage + commit（带 thesis），然后 `inbox_push` 汇报，停在审批门前"。演习中 operator（本次由 orchestrator 代行，走人类专属 HTTP 路由）审批 push，模拟器撮合成交。
- **观测点**：scrollback（agent 逐步行为）、tool-calls 日志（它调了什么、什么顺序）、TradingGit 记录（thesis 质量）、Inbox 产出、guard 判定、以及它在哪里卡壳/误用工具。
- **产出**：`docs/appendix/steward-p2-e2e-observation.md` 观测报告（含五问按当前数据能回答到什么程度的差距记录——正好是 P2 的 before 快照）。
- **边界**：mock 账户 only（I9）；agent 拿不到 push 权限（I1）；发现的产品缺陷开 issue 不就地扩范围。

### 演习二（P2 三个 issue 合并后）：验收演习

- 重复同样的自主流程，这次断言 P2 交付：approver 身份可查、`trade.*` 事件逐条出现在 event-log、五问从持久化数据完整重建。
- 观测报告追加 after 对比，作为 P2 验收证据（对应冻结计划 P2 验收标准第一条的活体版）。

两次演习各消耗一次真实 agent 会话（用 codex CLI，省 token；凭证用 vault 既有配置）。

---

## 5. 执行顺序与确认点

```
[确认点 0] maintainer 批准本文档
    → 演习一（观测现状，出报告）
[确认点 1] maintainer 读观测报告，确认 Issue A/B/C 拆分无调整
    → Issue A → PR → maintainer 合并
    → Issue B → PR → maintainer 合并
    → Issue C → PR → maintainer 合并
    → 演习二（验收，报告追加 after 对比）
[确认点 2] maintainer 确认 P2 验收 → 冻结计划推进到 P3（P3 首步本身就是设计稿过目）
```

每个 PR 照既有规矩：**不自动合并**，创建后通知 maintainer，等提问/亲测/合并指令。

---

## 6. 与冻结计划（v1.0）的关系

- P2 的目标、范围、验收标准**原样执行**，无变更，不升版本号。
- e2e 观测演习是 I8（每阶段验证门）与 I9（paper 优先）范围内的验收方式强化：冻结计划 P2 验收本就要求"mock 账户上的完整流程能重建五问"，演习只是把"完整流程"从脚本驱动升级为真实 LLM agent 自主驱动。
- 演习一若暴露动摇 P2 关键设计决定的问题 → 按冻结计划变更管理节处理：暂停、带证据找 maintainer 裁决。
