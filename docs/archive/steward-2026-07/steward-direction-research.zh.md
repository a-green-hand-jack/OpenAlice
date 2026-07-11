# Steward 方向调研：版图、选型与 OpenAlice 演进路线

> **归档状态（2026-07-11）**：历史调研快照，不再描述完整当前实现，也不授权继续旧路线。
> 当前方向见 [../../steward-plan.zh.md](../../steward-plan.zh.md)。

> 调研日期：2026-07-03
> 意图文档：[Steward Vision v0.3](https://gist.github.com/a-green-hand-jack/be25ea9deafce31355110e8924bd7757)
> 方法：三路独立证据交叉——①对抗验证式网络深度调研（104 个子 agent：5 路搜索 → 来源抓取 → 每条 claim 3 票对抗验证，≥2/3 证伪即杀）；②Codex 对 10 个候选开源仓库的逐文件代码尽调（本地浅克隆，拒绝营销页，只认代码证据）；③OpenAlice 仓库逐项盘点（file:line 级）。
> 原始证据（本仓库留档）：
> - [appendix/steward-deep-research-findings.json](../../appendix/steward-deep-research-findings.json) — 网络深度调研的 11 条合并 finding，每条含 claim / 置信度 / 一手来源 / 逐字证据 / 对抗验证投票记录，外加 caveats 与 openQuestions
> - [appendix/steward-oss-code-audit.md](../../appendix/steward-oss-code-audit.md) — Codex 对 10 个开源仓库的逐文件代码尽调原始报告（253 行，含全部文件路径证据、逐项判定、ranked shortlist 与 uncovered gaps）

---

## 0. 总结论

**全行业没有任何项目——商业或开源——实现了 Steward 意图（渐进授权 + 可审计 + 长期运行的资产管理 agent）。**

更重要的发现：**OpenAlice 已经实现了全行业 8 个共同空白中的 3 个**（人工盘前审批门、审计链雏形、托管隔离进程），没有任何开源项目比它更接近 Steward 基座。因此推荐路线不是"换到某个开源项目上"，而是**以 OpenAlice 为骨架，自建风险状态机和渐进授权阶梯这两根缺失的脊柱，开源项目按缺口逐个当组件用**。

一个方向性利好：MCP 已被 Robinhood、Alpaca、Coinbase 三家一方支持，成为 broker↔agent 的**事实互操作层**——直接验证了 OpenAlice"原生 agent CLI + MCP 注入"的架构押注。

---

## 1. 判断标准：Steward 是什么

来自 Steward Vision v0.3，与普通 trading bot 的本质区别：

| 支柱 | 要求 |
|---|---|
| 长期性 | 跨周期管理资产/风险/策略/工具，依赖历史轨迹和复盘 |
| 观察驱动 | Observe→Operate；持续观察六类对象：用户目标授权、组合状态、风险状态、市场状态、工具策略状态、历史轨迹 |
| 默认保守 | read-only → paper → small live with approval → limited autonomy；权限只能由用户显式逐步放宽 |
| 可审计 | 每个重要动作可回答：看到什么 / 为什么 / 谁批准 / 经过哪些检查 / 结果如何 |
| 风险优先 | 风险操作优先于收益；不确定时主动降级（谨慎模式 / 紧急停止 / 去风险） |
| 记忆复盘 | 保存关键决策、失败案例、用户反馈，并将错误转化为检查规则 |

明确排除：保证收益、无授权交易、自动提权、状态不明时激进行动、不可解释模型直连资金动作。

---

## 2. 版图分类（判断题 A）

### 2.1 托管产品——闭源，不可作代码基座，只能当产品参照物

| 产品 | 授权模型 | 关键事实（一手来源，均 3-0 通过对抗验证） |
|---|---|---|
| **Public.com AI Agents**（2026-03 上线） | 一次性批准后自动执行 | "You approve every Agent before it goes live"——批准是上线前一次性的，之后按既定工作流循环执行，可编辑/暂停/关闭；无 paper 模式、无分级授权。来源：[public.com/ai-agents](https://public.com/ai-agents)、[PR Newswire](https://www.prnewswire.com/news-releases/public-becomes-the-first-brokerage-to-introduce-ai-agents-for-your-portfolio-302729050.html) |
| **Arta AI**（2025-04） | 建议-only，无执行权 | 三个 agent（Investment Planner / Product Specialist / Research Analyst）只分析和建议；技术栈 agentic systems + function calling + RAG + 凸优化 + 传统 ML；人类监督仅为"可预约真人专家"；无审批流/审计链。来源：[官方博客](https://artafinance.com/global/insights/meet-arta-ai-private-wealth-guided-by-ai-agents) |
| **PortfolioPilot**（Global Predictions，SEC 注册 RIA） | read-only，永不执行 | "We have read-only access to any connected accounts"；其 MCP server 是托管端点不发布源码；两个 GitHub org 零公开仓库。来源：[portfoliopilot.com](https://portfoliopilot.com/)、[SEC IAPD](https://adviserinfo.sec.gov/firm/summary/327520) |

**洞察**：三家各占 Steward 授权光谱上的**一个孤立点**（一次性批准 / 建议 / read-only），没有一家做出"从 read-only 逐步升到 limited autonomy"的**阶梯**。阶梯本身就是行业空白。

### 2.2 agent 交易基础设施——真实可用，但只是薄工具桥

| 项目 | 形态 | 与 Steward 的关系 |
|---|---|---|
| **Alpaca MCP Server**（MIT，官方开源，~857 stars，2026-04 V2 重写） | 65 个 MCP 工具：账户/组合查询、股票·期权·加密下单（含括号单/多腿价差）、历史与实时行情 | paper/live 只是一个环境变量二元开关（`ALPACA_PAPER_TRADE`，默认 paper）；订单直连交易 API，无审批流、无风险状态机、无审计日志（对 repo 全部文档 grep audit/approv/memory 零命中）；官方安全模型只有"人工审阅 AI 建议的订单"警示。`ALPACA_TOOLSETS` 可部署期裁剪工具集（事实上的 read-only 档），但非运行时授权阶梯。来源：[repo](https://github.com/alpacahq/alpaca-mcp-server)、[docs](https://docs.alpaca.markets/us/docs/alpaca-mcp-server) |
| **Coinbase AgentKit + Agentic Wallets**（Apache-2.0；钱包 2026-02-11 发布） | 给 agent 配 crypto 钱包 + 链上动作；一方 MCP / LangChain / Vercel AI SDK / OpenAI Agents SDK 扩展 | 设计哲学与 Steward **明确相反**：官方原话"Your agent detects a better yield opportunity at 3am? It rebalances automatically, no approval needed because you've already set permissions and controls"。session 消费上限/单笔限额/enclave 私钥隔离（私钥永不暴露给 agent 的 prompt/LLM）/内置 KYT 是**事前限额护栏**（ex-ante permission scoping），不是审批链。来源：[repo](https://github.com/coinbase/agentkit)、[发布页](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets)、[CDP docs](https://docs.cdp.coinbase.com/agent-kit/core-concepts/model-context-protocol) |
| **Robinhood Agentic Trading** | 托管 MCP 端点：`https://agent.robinhood.com/mcp/trading`，一条 URL 接入 Claude Code / Cursor / ChatGPT / Codex 等 | **只有 MCP 接入机制通过验证**；其 GA 状态、逐笔审批细节、免责声明措辞三条 claim 均被 0-3 证伪，引用时只能谈 MCP 路线，不能谈其授权/责任模型。已知限定：agent 可跨账户读取，但只能在专用 Agentic 账户内交易。来源：[官方页](https://robinhood.com/us/en/agentic-trading/) |

**洞察**：这一类提供完整的"观察+执行"工具面，但全部把风险审查和审计责任**外推给使用方**——正好是 Steward 要自己扛起来的部分。

### 2.3 开源研究/回测框架——Codex 逐文件读码结论：全是组件，不是骨架

| 项目 | License | 读码判定（含代码证据） |
|---|---|---|
| **TradingAgents**（TauricResearch） | Apache-2.0 | 一次性 LangGraph 分析图：`TradingAgentsGraph.propagate()` 跑一个标的一个日期即结束；无 broker/执行层；风险辩论只是 prompt 层（`risk_mgmt/conservative_debator.py`），`TraderProposal` 的 stop_loss 字段无执行路径。**但 reflection 记忆是全场最好的**：`TradingMemoryLog` 存决策 → 拿到实际收益后 `Reflector.reflect_on_final_decision()` 生成反思 → `get_past_context()` 注入未来 prompt（`tradingagents/agents/utils/memory.py`、`graph/reflection.py`）。判定：**组件**（多 agent 决策结构 + 反思记忆模式） |
| **FinRobot**（AI4Finance） | Apache-2.0 | 最弱：AutoGen 报告生成 demo，`SingleAssistant.chat()` 后即重置；无 live 执行/硬风控/审批/持久交易记忆；维护者明确免责不建议 live trading。判定：**弱组件** |
| **FinRL**（AI4Finance） | MIT | RL 训练/回测为主 + 一个窄的 Alpaca paper 循环（`PaperTradingAlpaca.run()`：等开盘→循环 `trade()`→收盘清仓）；`submitOrder()` 直接下单无审批；风控只有 turbulence 阈值全清仓。判定：**组件**（RL 环境） |
| **Qlib**（Microsoft） | MIT | 纯模拟：`backtest_loop()` + `SimulatorExecutor` 内存撮合；`OnlineManager.routine()` 只管模型生命周期不下单；`Recorder` 是实验工件不是交易审计。判定：**组件**（研究/信号） |
| **RD-Agent**（Microsoft） | MIT | 长期运行的是**研究循环**（假设→写码→实验→反馈，`RDLoop`），trace 基础设施很好（`Trace.hist` + DAG lineage），但完全不碰市场执行。判定：**组件**（自主研究/trace 基础设施） |
| **OpenBB** | **AGPL-3.0** | 数据平台 + REST API + MCP server（`create_mcp_server`，可按类别裁剪工具）；无执行/风控/记忆。判定：**组件**（数据/MCP 面；AGPL 需进程外使用） |

### 2.4 运行时骨架候选——真 daemon，但没有 LLM 也没有审批

| 项目 | License | 有什么真机制 | 缺什么 |
|---|---|---|---|
| **freqtrade** | **GPL-3.0** | 全场最强长期循环（`Worker.run()` 无限循环 + 状态机 RUNNING/PAUSED/STOPPED）；真 dry-run/live 分流（`Exchange.create_order()` 按 config 分支）；**protections 插件带 MaxDrawdown 全局锁仓、StoplossGuard**（`plugins/protections/`）；订单/交易/锁全持久化 | 纯算法 crypto bot：无 LLM、无人工审批、无决策理由留痕；GPL 传染 |
| **hummingbot** | Apache-2.0 | 真 daemon（realtime `Clock`）；**kill switch 真实存在**（`ActiveKillSwitch.check_profitability_loop()` 每 10 秒检查盈利阈值、触发 `trading_core.shutdown()`）；`BudgetChecker` 余额/保证金约束；triple-barrier 仓位执行器（stop loss / take profit / time limit）；paper connector | 仅 crypto 做市场景；无 LLM、无审批；风控是 bot/执行器级不是 steward 策略级 |
| **lumibot**（Lumiwealth） | **GPL-3.0** | 最接近"live 循环 + 多 broker + LLM + 记忆"的单体：APScheduler 实盘循环（`StrategyExecutor`）、Alpaca/IBKR/Schwab/Tradier/CCXT/Tradovate 等 broker、**SQLite `MemoryStore` 已有 decisions/proposals/risk notes/lessons/theses 表结构**、`AgentHandle._write_trace()` agent trace 落盘 | 默认不保守：`submit_order()` 直连 broker 无审批门、无全局回撤守护（max drawdown 只在 tearsheet 报表里）；LLM agent 是可选组件不是受治理核心；GPL |
| **AgentKit**（Coinbase） | Apache-2.0 | 链上 action 库 + 钱包抽象 | 无循环/无调度/无策略约束/无审计——Codex 评语："作为基座很危险" |

### 2.5 全行业共同空白（Codex 确认没有任何仓库覆盖，与 web 调研结论一致）

1. **渐进授权状态机**：observe-only → propose-only → paper → small live → expanded live，含显式人批、可撤销、限额升级
2. **人工盘前审批门**：提案 + 理由 + 确定性风控结果 + broker 订单 payload 绑成一次 approve/reject
3. **Steward 级审计链**：观察 → LLM 理由 → 风控检查 → 审批 → 订单 ID → broker 状态串成一条防篡改 append-only 链
4. **确定性组合策略引擎**：独立于 LLM 的敞口上限/流动性门/相关性风险/回撤状态/强制去风险
5. **安全的 LLM→执行边界**：LLM 决策 + 硬确定性约束下的 live 执行
6. **结果感知的受治理记忆闭环**：live 决策与实际结果回流为受审计、可回滚的未来行为约束
7. **托管/凭证隔离**：独立 broker/custody 进程或硬件钱包式签名边界
8. **正式的 paper→live 晋升标准**：晋升所需评审工件 + 风险触发的 live→paper 自动降级

---

## 3. OpenAlice 现状盘点（file:line 级）

### 3.1 已建成且扎实（对应空白 #2、#3、#7）

**人工盘前审批门（空白 #2）**
- `TradingGit` 三段式 VCS 工作流：`add`（暂存 Operation）→ `commit`（sha256 pendingHash）→ `push`（执行并追加含 thesis/operations/results/stateAfter 的 `GitCommit`），另有 `reject`——`services/uta/src/domain/trading/git/TradingGit.ts:60-180`
- 全局主开关 `agent.allowAiTrading` **默认 false**——`src/core/config.ts:218`
- AI 的 `tradingPush` 工具被刻意挖空：未授权时返回"Push requires manual approval"且不触 broker——`src/tool/trading.ts:722-768`（门在 `:748`）
- 真正的 push 只能从人类 Web-UI 路由执行（"only humans can push"）——`services/uta/src/http/routes-trading.ts:450-461`
- 第二重门：每账户 `readOnly` 直接拒绝 stage/commit/push；keyless ⟹ readOnly——`config.ts:447-450`

**审计链雏形（空白 #3）**
- ToolCallLog：每次 AI 工具调用的完整 input/output/status/duration/sessionId → `data/tool-calls/tool-calls.jsonl`——`src/core/tool-call-log.ts`
- TradingGit 提交历史（thesis + 操作 + 结果 + 执行后状态）→ `data/trading/<id>/commit.json`——`git-persistence.ts`
- UTA 快照（净值/持仓/挂单/health/headCommit，定时 + push 后 + reject 后）——`snapshot/service.ts`
- EventLog：append-only JSONL + `causedBy` 因果链——`src/core/event-log.ts`
- Inbox 溯源：entry→run→issue 链接——`src/core/inbox-store.ts`

**托管隔离（空白 #7）**
- UTA 独立进程持有全部 broker 代码与凭证；Alice 只经 `@traderalice/uta-protocol` HTTP 通信；accounts/auth 落盘密封（`src/core/sealing.ts`），协议设计支持 UTA 外移到独立设备（硬件钱包式）

**自主运行面（观察循环的载体，80% 现成）**
- ScheduleScanner：~60s 控制循环扫描各 workspace 的 `.alice/issues/<id>.md`，SCHEDULED 且到期 → `dispatchHeadlessTask` 发 headless agent run——`src/workspaces/schedule/scanner.ts:204-231`
- 调度语法 `at`/`every`/`cron`——`src/core/schedule-expr.ts`
- **今天零代码即可跑一个周期 observe 循环**：建 workspace + 放一个带 `when:{kind:cron}` + `what:<观察 prompt>` 的 issue 文件即可；agent 有全量读侧交易+行情工具（MCP），经 `inbox_push` 汇报

### 3.2 部分建成

- **渐进授权**：只有二元——全局 `allowAiTrading` + 每账户 `readOnly`/paper-live 之分（alpaca-paper/alpaca-live 是独立账户 ID）。无 read-only→paper→small-live→autonomy 阶梯；无按 workspace/agent 的能力分级——`claudeCode.allowedTools/disallowedTools` 配置存在（`config.ts:220-238`）但**全仓库无消费者，未接线**；`/mcp` 全局工具面对任何本地 workspace 完全开放（loopback-only 无认证，`src/server/mcp.ts:38-46`）
- **风险边界**：每账户 guard pipeline 真实存在（`MaxPositionSizeGuard` 默认 25% 净值 / `CooldownGuard` / `SymbolWhitelistGuard`，`guards/`），但只是静态每单检查，仅在 execute/push 路径运行
- **记忆**：InboxStore / EntityStore / workspace git 文件 / 交易历史都持久且互链，但是"记录不是规则"

### 3.3 完全缺失

- **风险安全脊柱**（空白 #4 的 steward 侧）：全仓库 grep `kill.?switch|emergency|drawdown|de-?risk|circuit.?breaker|flatten|liquidat|panic|halt` **零命中**（仅 IBKR 错误串解析）。无 kill switch、无紧急停止、无最大回撤检查、无组合级/亏损基 guard、无谨慎模式状态机
- **审计缺两环**："谁批准"（push 路由不记录 approver 身份）与"跑过哪些检查"（guard 通过/拒绝不入档，EventLog 无 `trade.*` 事件类型）
- **记忆→规则管道**（空白 #6）：无失败→guard 配置的转化机制，复盘完全依赖 agent 自觉重读文件

---

## 4. 单一起步项目判断（判断题 B）

**诚实的回答：没有一个值得作为起点，因为已经有 OpenAlice。** 假设没有 OpenAlice，排序：

1. **lumibot**——唯一同时有 live 循环、多资产 broker、LLM agent trace、记忆表结构的项目，离 Steward 的"形"最近。但 GPL-3.0 传染整个衍生产品，且保守性要从 submit 路径开始重造。
2. **freqtrade**——最强运行骨架和风控 protections，但 crypto-only、无 LLM；把 LLM 决策和审批链嫁接进 GPL 代码库的工程量 ≈ 重写。
3. **hummingbot**——Apache-2.0 加分，kill switch/BudgetChecker 可直接借代码，但它是做市 bot，离资产管理最远。

三者共同问题：**Steward 的差异化核心（渐进授权、审批链、审计、记忆治理）在哪条路线上都要从零建**——起步项目只省下"循环 + broker 接入"，而这部分 OpenAlice/UTA 已经有，还多了别人都没有的审批门。换基座等于放弃最稀缺的资产。

---

## 5. 组合方案：OpenAlice 为骨架，按缺口配件（判断题 C）

| Steward 缺口 | OpenAlice 现状 | 用什么补 | License 注意 |
|---|---|---|---|
| **① 长期观察循环**（六类对象） | 80% 已有（ScheduleScanner + issue 调度） | **自建 "steward" workspace template**（符合"能力=模板+卫星仓库"边界纪律）：内置六对象观察 prompt 框架 + 快照工具。TradingAgents 的分析师→多空辩论→风控辩论→组合经理结构作为模板内 prompt/skill 设计蓝本 | TradingAgents Apache-2.0，可自由借鉴 |
| **② 风险状态机** | **完全缺失** | **UTA 侧自建**，设计抄两家：freqtrade `ProtectionManager`（MaxDrawdown 锁仓、StoplossGuard）+ hummingbot `ActiveKillSwitch`/`BudgetChecker`。落点 = 现有 `guards/` pipeline 扩展：组合级 guard（回撤/集中度/单日亏损）+ NORMAL→CAUTIOUS→READ-ONLY→HALT 账户风险状态机 + 强制 flatten 操作 | freqtrade **GPL——只参考设计不抄代码**；hummingbot **Apache-2.0——可移植代码** |
| **③ 渐进授权阶梯** | 二元开关（全局 `allowAiTrading` + 每账户 `readOnly`） | **只能自建**（全行业无先例）：tier（read-only/paper/small-live/autonomy）做成每账户 × 每 workspace 字段；接线 `allowedTools` 实现按 workspace 裁剪交易工具面；small-live 档给审批规则附加金额上限。Coinbase spend-permissions 限额模型反向借用为 limited-autonomy 档的最后一道硬护栏 | — |
| **④ 审计链闭环** | 最强项，差两环 | **纯自建小改动**：push 路由记录 approver 身份；guard pipeline 通过/拒绝结果写进 commit 与 event-log（新增 `trade.*` 事件类型）。无先例可抄——OpenAlice 已是最前面的 | — |
| **⑤ 记忆→规则复盘** | 记录充足但被动 | **模式抄 TradingAgents**（decision→outcome→reflection→注入未来决策），**表结构参考 lumibot `MemoryStore`**（lessons/theses）；载体用现有 workspace 文件 + entities；"教训→新 guard 配置"管道自建 | TradingAgents Apache-2.0 可抄；lumibot **GPL 只参考** |
| 数据补强 | typebb + OpenBB API remote 已有 | OpenBB MCP server 按需接入 workspace | **AGPL——保持独立进程、走 MCP/HTTP，勿链接进代码** |
| 策略研究 | 不在 Alice 核心内 | qlib / RD-Agent / FinRL 做成**研究型 workspace template / 卫星仓库**：agent 在 workspace 里跑因子研究/回测，产出走 `inbox_push` 汇报——不进 `src/` | 全 MIT |
| 执行轨道 | UTA 已有 alpaca/ccxt/ibkr/longbridge/mock | 已足够；链上资产可加 AgentKit 作为 UTA 新 broker 适配；Alpaca MCP / Robinhood MCP 可作可插拔外部轨道验证互操作 | AgentKit Apache-2.0 |

---

## 6. 推荐路线（判断题 D）

### 路线一（推荐）：OpenAlice 原地演进为 Steward

按"风险脊柱优先"排序：

1. **② 风险状态机**（hummingbot 代码 + freqtrade 设计）——没有它任何授权放宽都不安全
2. **④ 审计补两环**（approver + guard 结果入档）——小改动，快速闭环
3. **③ 授权阶梯**（接线 `allowedTools` + per-account×per-workspace tier）
4. **① steward 模板**（六对象观察循环结构化）
5. **⑤ 复盘管道**（reflection 模式 + lessons→guard 配置）

理由：保留全行业独有的三项资产；每步都是增量 PR；与"能力=模板+卫星仓库"的架构纪律完全一致。

**主要风险**：③ 和 ⑤ 无任何先例可抄，设计错误成本高——建议每档授权先在 mock/paper 账户跑完 UTA live-testing 的 S1–S12 场景目录再放行；GPL 项目只能参考设计，工程上要自律不复制代码。

### 路线二（不推荐但列出）：lumibot 或 freqtrade 起步再嫁接

仅当想放弃 TS/UTA 栈换 Python 时才考虑；代价 = 丢掉审批门/审计链/托管隔离三项独有资产 + GPL 传染 + 审批授权照样从零建。没有理由这样做。

---

## 7. 证据边界与留白（诚实声明）

- **网络调研对开源研究框架覆盖为零**：FinRL/TradingAgents/FinRobot/Qlib/RD-Agent/OpenBB 等没有产生通过三票验证的 web claim——该空缺由 Codex 代码尽调补齐（两路方法互补，结论一致）。
- **Robinhood 被大幅证伪**：GA 状态、"无逐笔审批"、"平台不监控/不审计"三条 claim 均 0-3 被否，仅 MCP 接入机制存活。其真实授权/审计模型是版图中最大的事实空白。
- **AgentKit 的缺失性 claim（无审批/无审计）以 1-2 被否**——AgentKit 仓库内部护栏可能存在部分机制，对它的缺口描述应比对 Agentic Wallets 的更谨慎。
- **未覆盖**：Magnifi、NexusTrade、Composer 未获有效验证；若重要可定向补一轮。
- **时效性**：Agentic Wallets（2026-02）、Public Agents（2026-03）、Alpaca MCP V2（2026-04）均为近月发布，细节随版本漂移；验证截至 2026-07-03。
- 关于 OpenAlice 自身能力的表述来自仓库盘点（file:line 级），不在外部对抗验证范围内。

## 8. 开放问题

1. Robinhood Agentic Trading 的真实授权与审计模型（是否 GA、专用 Agentic 账户的资金/品种边界、有无逐笔确认或事后审计接口）？
2. Coinbase 的策略引擎原语（session caps、spend permissions、enclave 签名前策略检查）能否反向借用为渐进授权阶梯中 limited-autonomy 档的技术底座？
3. 版图中是否存在 2026 年新出现的、真正实现长期 Observe→Operate + 记忆复盘的 steward 类开源项目（NexusTrade、Composer 自动化层等未验证对象）？

## 9. 主要来源

- Steward Vision v0.3：https://gist.github.com/a-green-hand-jack/be25ea9deafce31355110e8924bd7757
- Public.com AI Agents：https://public.com/ai-agents
- Arta AI：https://artafinance.com/global/insights/meet-arta-ai-private-wealth-guided-by-ai-agents
- PortfolioPilot / Global Predictions：https://portfoliopilot.com/ ・ https://adviserinfo.sec.gov/firm/summary/327520
- Robinhood Agentic Trading：https://robinhood.com/us/en/agentic-trading/
- Alpaca MCP Server：https://github.com/alpacahq/alpaca-mcp-server ・ https://docs.alpaca.markets/us/docs/alpaca-mcp-server
- Coinbase AgentKit / Agentic Wallets：https://github.com/coinbase/agentkit ・ https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets ・ https://docs.cdp.coinbase.com/agent-kit/core-concepts/model-context-protocol
- 代码尽调对象：TauricResearch/TradingAgents ・ AI4Finance-Foundation/FinRobot ・ AI4Finance-Foundation/FinRL ・ microsoft/qlib ・ microsoft/RD-Agent ・ OpenBB-finance/OpenBB ・ hummingbot/hummingbot ・ freqtrade/freqtrade ・ coinbase/agentkit ・ Lumiwealth/lumibot（2026-07-03 浅克隆快照）
