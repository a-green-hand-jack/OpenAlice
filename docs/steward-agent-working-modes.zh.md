# Steward Agent 工作方式与调节旋钮

> 版本：v0.2（2026-07-07）——§4 扩为两层：**系统拓扑**（agent(main) 未必是「人类交易员」，可作 bot 组合器 / agent 编排器 / 分层递归）× 单体决策方式；新增「按资金规模×市场环境选型」原则与「任何深度每笔交易必有记录」不变量。
> 版本：v0.1（2026-07-07）——初稿：当前工作方式 + 调节旋钮 + 单层路线图。
> 地位：**概念/方法论文档**，从属于 [steward-plan.zh.md](steward-plan.zh.md)（I1–I9 不变量）。
> 记录 agent 的「工作方式」——它如何把观察变成交易动作——以及能改变其行为的
> 「调节旋钮」。这是一个**会扩展的设计空间**，不是一次性描述。
> 用法：maintainer 直接批注；新增/改动工作方式或旋钮时同步更新本文件。
>
> 关联：[steward-prompt-anatomy.zh.md](steward-prompt-anatomy.zh.md)（旋钮之一「prompt」的真源）、
> [steward-p3-campaign.zh.md](steward-p3-campaign.zh.md)（实验设置：窗口/regime/判据/执行）、
> [steward-plan.zh.md](steward-plan.zh.md)（不变量）。

## 0. 为什么单列这份文档

- **工作方式 = agent 如何把「观察」变成「交易动作」。** 它决定参与度、风控、越权与否——是行为的载体，和 prompt 同级重要。
- maintainer 方向（2026-07-07）：**当前工作方式可接受，但后续会有更丰富的工作方式，彼此互补、分别适合不同场景、并在实验中择优。** 更广的含义（同日追加）：工作方式**不止于单体 agent 如何决策，还包括系统拓扑**——agent(main) 未必是「人类交易员」，它可以是统管一群 auto-trading-bot 的组合器、编排一群 agent(sub) 的调度者，甚至分层递归。因此「工作方式」是要显式登记、版本化、可实验比较的对象。
- 本文件回答三件事：现在是**哪种**工作方式（§2）、有**哪些旋钮**能改它的行为（§3）、未来沿**哪些轴**扩展成更丰富的方式（§4）。

## 1. 一句话定性

当前 agent **不是 auto-trading-bot，也不是「列一个 plan 交给 broker 自动执行」**。它是一个 LLM agent，**每个决策周期像人类交易员一样现场推理一次**，用 `alice-uta` CLI 亲手下单，经 git-like 审批后由 paper broker 成交。策略即 agent（每次现推、无固定算法），broker 只负责撮合，git 审批层是可审计脊柱。

## 2. 当前工作方式（Mode 1：逐周期自主决策 / discretionary-per-period）

完整链路（对着代码 `campaign/stress.mjs:100-128` + prompt-v2 §ACT）：

1. 每个决策周期，orchestrator 发一次 **headless 任务**（`POST /api/workspaces/:id/headless`）给 workspace 里的 agent（现为 codex），prompt = 到当前为止的 tape + 双目标 mandate。
2. agent **自己读盘**（趋势/动量/波动/量），形成 thesis。
3. agent 用 **`alice-uta` CLI 当手**：查现金/持仓 → 决定 buy/add/trim/sell/set-stop/hold。
4. 下单后 **`alice-uta git commit`** → 走 UTA 的 **git-like 审批状态机**：paper 账户由确定性审批器 `via:auto-push-paper` 自动放行成交；**live 永不自动成交，必须人批**。
5. **周期之间没有任何自动交易循环**——唯一会被动触发的是上一周期挂出的**保护性 stop 单**（broker 持有，价格触及时成交）。
6. 下一周期对**更新后的 tape 重新推理一遍**（不是延续一个长驻进程）。

**关键属性**：无预注册算法、无后台 bot 循环、每周期无状态重推 + 挂单在场；决策与执行之间隔着 git 审批闸。

**「可接受」的实证**：v2 prompt 下，牛市 H1≈50%（NVDA 42% / TSLA 65% / AMD 43%），熊市全程持币、回撤 0%（见 [prompt-anatomy §1](steward-prompt-anatomy.zh.md)）。故 maintainer 判定 Mode 1「当前可接受」。已知弱点：震荡市可能因参与指令而被来回打损（stress 批次首个 chop cell −7.6% FAIL），详见 campaign 结果。

### 2.1 Mode 1b：persistent steward wake loop（基础 seam 已实现）

Mode 1b 的目标是保留 Mode 1 的逐周期审慎决策，但把「每周期 fresh headless
process」替换成「同一个 live steward PTY session 被窄 wake envelope 唤醒」：

1. 人类或未来 scheduler 先确保 workspace 里有一个 live Codex/agent steward session。
2. 事件到来时调用 `POST /api/workspaces/:id/sessions/:sid/wake`，只注入本轮
   `message`（默认把 message 和 terminal Enter / CR 分开写入 PTY），不启动新
   `codex exec`。
3. steward 在同一 transcript 中读取固定 context/event，跑固定 UTA checklist，
   输出 `no_trade | propose_trade | blocked` 之一，并通过文件/Inbox/UTA git
   留痕。

当前状态：**基础 wake seam 已实现，并有 persistent wake-loop harness 覆盖多周期
同 session/pid/transcript 证明；生产 scheduler 接入、目标 session 选择、
heartbeat/idle watchdog、per-account lock、decision ledger schema 仍 TODO。**
这不是新 prompt 版本，也不改变 v2 prompt 真源；它只是改变同一段行为文本/事件如何
进入 agent。

验证资产（2026-07-08）：

- `tools/persistent-wake-loop-backtest.mjs`：复用 campaign 的 6 周窗口/判据，
  每个 cell 启动一个 live shell PTY + 长驻 runner，6 个决策周期全部通过
  `/sessions/:sid/wake` 注入，不走 `/headless`。
- [appendix/persistent-wake-loop-backtest](appendix/persistent-wake-loop-backtest.zh.md)：
  记录 proof 边界。它证明 Mode 1b runtime/wake-loop plumbing（同 session id、
  PTY pid、runner pid、transcript marker），但**不声称证明 Codex interactive
  TUI 的完整自动回测**；Codex 仍缺稳定 per-turn completion boundary。
  本 PR 的完整 shell-proving campaign 已跑完 10 cells：bull 1 PASS / 1 WEAK，
  bear 4 PASS，chop 3 PASS / 1 FAIL；所有 cell 的 wake-loop proof 字段均为 true。

## 3. 调节旋钮（改变交易行为的杠杆）

分**软旋钮**（引导 agent 的意图/风格）与**硬旋钮**（UTA 层强制上限）。今天真正在拧的几乎只有 prompt。

| 类 | 旋钮 | 当前取值 | 控什么 | 验证状态 |
|---|---|---|---|---|
| 软 | **Prompt 版本** | v2（双目标） | 参与度 / 风控 / 越权 / 是否作弊——**主杠杆** | 已验证：v1→v2 把牛市 H1 从 7–16% 拉到 ~50%。子旋钮逐段登记于 [prompt-anatomy §2](steward-prompt-anatomy.zh.md) |
| 软 | **观察模式 + 盲化程度** | paste（OHLCV 内联）；盲但富（给全 OHLCV+量、可自算指标，抹标的/日期/新闻） | agent 拿到多少信息、怎么拿 | tool-native 底座已铺（#64）；盲化的结构性强制靠 #66 seal |
| 软 | **CLI + 模型** | `agents:['codex']` | 换「大脑」——不同推理质量 → 不同判断 | 未系统对比（claude/opencode/pi 可换） |
| 软 | **决策节奏** | 周线（6 周 × 5 日线，6 决策点） | 多久醒来决策一次 | 小时/日内 deferred（#65） |
| 硬 | **`guards[]`** | **空 → 拟启用** | 账户级硬风险闸——无论 agent 想干什么都不许越线 | **决定启用**（2026-07-07，配 prompt v3 一起兜 over-participation）。**地面真相**：`max-drawdown` 触发→**READ_ONLY 挡新单/加仓，但不强平已有仓**（`risk-state.ts` 无清算路径），故 config 闸=限敞口·非强平；真 hard cap 需改代码。拟 `max-drawdown 10%`+`max-position-size 60%` |
| 硬 | **`maxAuthzLevel` / 授权档** | `paper` | 渐进授权：read-only → paper → small live | 钉死 paper（I9） |
| 硬 | **起始资金** | `START=100000` | 规模基准 | — |
| 硬 | **决策超时** | 260s/次（harness 侧） | agent 能思考多深 | 观察到部分决策卡在 260s 被截断——待调 |

> **要点**：当前唯一在认真调的是 **prompt（软）**；硬风控闸 `guards` 还是空的。这也是 chop cell 会 FAIL 的结构原因——没有硬闸兜底时，全靠 prompt 里「别在震荡市乱交易」这句软约束，而它没兜住。**引入硬闸是一个尚未动用的独立杠杆。**
>
> **更新（2026-07-07）**：压测确认 v2 有 **over-participation** 尾部风险（`sp-bear-smci` 两批皆 FAIL，深熊做多被止损 −17~24%，详见 [campaign §4.7](steward-p3-campaign.zh.md)）。对策拍板「**两者都上**」= 启用硬 `guards` + prompt v3。硬闸的机制边界已探明（见上表 `guards[]` 行）：config 级 `max-drawdown` 只降 READ_ONLY、不强平，因此它的作用是**限制敞口 + 阻止给亏损仓加仓**（正是 smci 两次的败因——它一路加仓），而非「严格 X% 强平」。要真·hard cap 得加一条 force-close 风险动作（属代码改动，走 codex）。

## 4. 工作方式路线图（未来更丰富的方式）

**核心洞见：完整的「工作方式」有两层——① 系统拓扑（有几个 agent / bot、如何组合、如何分层）× ② 每个节点的决策方式（单体如何决策）。** Mode 1（§2）只是「拓扑=单节点 × 决策=逐周期 discretionary」这一个特例，绝不是唯一形态。**agent(main) 未必是「人类交易员」那种亲自看盘下单的样子。**

> 因此我们的工作**不是**把一个 agent 打磨成「最强人类交易员」，而是**为用户的资金规模与市场环境，选/组合出最合适的一套工作方式**（§4.3）。

### 4.1 层一：系统拓扑——agent(main) 可以只是「组合者 / 编排者」

agent(main) 可从「亲自下单」升格为**配置器 / 编排层**，本身不碰单笔 tick，而是调度下层执行体；下层执行体可以是确定性 bot，也可以是别的 agent，且**可递归分层**：

| 拓扑 | agent(main) 的角色 | 下层执行体 | 适合场景 |
|---|---|---|---|
| **T1 单体**（现状 Mode 1） | 亲自读盘、亲自下单 | 无 | 小资金、单市场、起步验证 |
| **T2 Bot 组合器** | 配置器 / 风控叠加层——在多个 auto-trading-bot 与策略间做**资金分配、开关、再平衡**，靠组合它们实现盈利 | 一群 auto-trading-bot，各管一个市场、跑不同策略 | 多市场并行、策略可固化、需 7×24 执行 |
| **T3 Agent 编排器** | 派活、汇总、裁决 | 一群 agent(sub)，各做不同任务/市场（研究、择时、风控、执行…） | 判断复杂、需分工与制衡 |
| **T4 分层递归** | 顶层配置 | agent(sub) 本身再管理下层 agent 或 bot，**任意深度** | 大资金、多资产类别、事业部式管理 |

- 这些拓扑**可混搭**（如 main 编排若干 sub，其中一个 sub 本身是 bot 组合器）。
- **每个节点内部**还各自要选一套「层二」决策方式（§4.2）——完整工作方式 = 拓扑 × 各节点决策方式。
- 落地基座已在：workspace 架构本就为「跑很多 workspace（云端可 20 个）」而设，sub-agent ↔ workspace / 卫星仓，auto-trading-bot 是 UTA 下的一类新执行体。这是路线图，不是已建成清单。

### 4.2 层二：单体节点的决策方式（旋钮空间里的一个点）

拓扑里的**每个 agent 节点**（无论 main 还是 sub）都要选一套决策方式，沿以下轴展开（设计空间，非承诺全实现）：

| 轴 | 现在（Mode 1） | 更丰富的方向 | 可能更适合的场景 |
|---|---|---|---|
| 观察→操作耦合度 | 逐周期现场推理 | 先立计划再委托执行 / 事件触发才唤醒 | 长期配置、慢牛长磨用低频计划式 |
| 信息获取 | paste（喂给它） | tool-native（自取，#64 已铺底） | 高频/大信息量场景 |
| 时间粒度 | 周/日线 | 小时/日内（#65）/ 多月长周期 steward | 高频用小时线；真·长期托管用多月周期 |
| 决策结构 | 单 agent | 多 agent 分工/辩论（研究员+风控+执行） | 复杂判断需要制衡时 |
| 策略形态 | 全自主 discretionary | 自写系统化策略 + 自主监督 | 可规则化的稳定场景 |
| 风控形态 | 软（prompt 纪律） | 硬（`guards` 闸）/ 软硬结合 | 震荡市、真金白银的 live |

### 4.3 选择原则：匹配资金规模 × 市场环境

我们要做的**不是**找一个「最强工作方式」，而是**为给定的用户资金规模 + 市场环境挑/拼出最合适的一套**：

- **资金规模**：小资金 → T1 单体够用、协调开销低；大资金 / 多资产 → T2/T4 分层，分散市场与策略。
- **市场环境**：快市 / 急行情 → discretionary 现推反应快；慢牛长磨 / 长期配置 → 低频计划式或 bot 组合；高波动震荡 → 加硬 `guards` 闸。
- **择优方法**：候选（拓扑 × 决策方式）都进同一套 campaign harness，用同一套 regime-aware 判据（[campaign §4](steward-p3-campaign.zh.md)）横向比，**实证选，不靠直觉**。

### 4.4 贯穿不变量（任何拓扑、任何深度都不放松）

- **每一笔交易必有记录**——无论由 main、sub 还是 bot 发出，都走 UTA 的 git-like 审批 + [P2 审计链](steward-plan.zh.md)，可回答「谁 / 为什么 / 经过哪些检查 / 结果如何」。**拓扑越深，审计越是唯一能追责的脊柱**（bot 不会解释自己，记录必须替它解释）。
- **每个执行边界都过 authz 档 + guards + 风险状态机**：sub-agent / bot 拿到的授权**不得超过** main 分给它的档；live 永不自动成交。
- 盲化不泄漏 / paper 优先 / prompt 变更走 [ANATOMY 登记](steward-prompt-anatomy.zh.md)——[I1–I9](steward-plan.zh.md) 全程适用。

## 5. 与其它文档的关系

- 旋钮「prompt」的**真源**在 [prompt-anatomy](steward-prompt-anatomy.zh.md)（含 v2 全文与逐段解剖）。
- **观察面**（回测/live 各看到什么、五类信息、盲化封印）在 [observation-surface](steward-agent-observation-surface.zh.md)——本份是决策侧，那份是输入侧。
- **实验设置**（窗口时长 / regime 定义 / 判据 / 串行执行）在 [p3-campaign §4](steward-p3-campaign.zh.md)。
- **不变量**在 [steward-plan I1–I9](steward-plan.zh.md)。
