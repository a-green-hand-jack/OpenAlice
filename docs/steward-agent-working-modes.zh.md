# Steward Agent 工作方式与调节旋钮

> 版本：v0.6（2026-07-07）——新增内置 `steward` workspace 模板，常驻 Codex 的启动 prompt 现在包含 wake ACK、事件文件、有限决策循环、UTA-only 执行、decision/journal 审计记录等行为协议。
> 版本：v0.5（2026-07-07）——补上常驻 session 的输入/唤醒控制边：selector/watchdog 可以向 live PTY 投递短 envelope，idle/no-output 条件满足时唤醒 Codex；记录 maintainer 裁决：目标是生产式真实交易模拟，不是离线 prompt 实验；每个交易点不应新开一次 `codex exec`。
> 版本：v0.3（2026-07-07）——回填 v3/policy 复验：bear-smci 修复、bull H1 保住，但 chop-tsla 仍 FAIL；当前 Mode 1 不能宣称行为问题已解决，下一旋钮应针对 chop/unknown 仓位上限。
> 版本：v0.2（2026-07-07）——§4 扩为两层：**系统拓扑**（agent(main) 未必是「人类交易员」，可作 bot 组合器 / agent 编排器 / 分层递归）× 单体决策方式；新增「按资金规模×市场环境选型」原则与「任何深度每笔交易必有记录」不变量。
> 版本：v0.1（2026-07-07）——初稿：当前工作方式 + 调节旋钮 + 单层路线图。
> 地位：**概念/方法论文档**，从属于 [steward-plan.zh.md](steward-plan.zh.md)（I1–I9 不变量）。
> 记录 agent 的「工作方式」——它如何把观察变成交易动作——以及能改变其行为的
> 「调节旋钮」。这是一个**会扩展的设计空间**，不是一次性描述。
> 用法：maintainer 直接批注；新增/改动工作方式或旋钮时同步更新本文件。
>
> 关联：[steward-prompt-anatomy.zh.md](steward-prompt-anatomy.zh.md)（旋钮之一「prompt」的真源）、
> [steward-p3-campaign.zh.md](steward-p3-campaign.zh.md)（历史 campaign 设置：窗口/regime/判据/执行）、
> [steward-production-runtime.zh.md](steward-production-runtime.zh.md)（生产式运行形态裁决）、
> [steward-plan.zh.md](steward-plan.zh.md)（不变量）。

## 0. 为什么单列这份文档

- **工作方式 = agent 如何把「观察」变成「交易动作」。** 它决定参与度、风控、越权与否——是行为的载体，和 prompt 同级重要。
- maintainer 方向（2026-07-07）：**当前工作方式可接受，但后续会有更丰富的工作方式，彼此互补、分别适合不同场景、并在实验中择优。** 更广的含义（同日追加）：工作方式**不止于单体 agent 如何决策，还包括系统拓扑**——agent(main) 未必是「人类交易员」，它可以是统管一群 auto-trading-bot 的组合器、编排一群 agent(sub) 的调度者，甚至分层递归。因此「工作方式」是要显式登记、版本化、可实验比较的对象。
- 本文件回答三件事：现在是**哪种**工作方式（§2）、有**哪些旋钮**能改它的行为（§3）、未来沿**哪些轴**扩展成更丰富的方式（§4）。

## 1. 一句话定性

当前 agent **不是 auto-trading-bot，也不是「列一个 plan 交给 broker 自动执行」**。它是一个 LLM agent，像人类交易员一样现场推理，用 `alice-uta` CLI 亲手下单，经 git-like 审批后由 paper broker 成交。策略即 agent，broker 只负责撮合，git 审批层是可审计脊柱。

重要修正：**生产式 steward 不应等同于「每个决策周期新开一个 headless Codex」**。Codex 可以作为一个常驻 workspace session 维护上下文；market/event selector 决定什么时候把事件送进这个常驻 steward。headless one-shot 仍适合观察报告、复盘、一次性任务，但不再作为每个交易点的默认生产路径。

## 2. 当前工作方式（Mode 1：自主 discretionary steward）

### 2.1 已实测形态：one-shot per-period harness

这是 campaign harness 已经跑过的形态，适合评估 prompt/guards/UTA 行为，不应再被误称为生产默认形态：

1. 每个决策周期，orchestrator 发一次 **headless 任务**（`POST /api/workspaces/:id/headless`）给 workspace 里的 agent（现为 codex），prompt = 到当前为止的 tape + 双目标 mandate。
2. agent **自己读盘**（趋势/动量/波动/量），形成 thesis。
3. agent 用 **`alice-uta` CLI 当手**：查现金/持仓 → 决定 buy/add/trim/sell/set-stop/hold。
4. 下单后 **`alice-uta git commit`** → 走 UTA 的 **git-like 审批状态机**：paper 账户由确定性审批器 `via:auto-push-paper` 自动放行成交；**live 永不自动成交，必须人批**。
5. **周期之间没有任何自动交易循环**——唯一会被动触发的是上一周期挂出的**保护性 stop 单**（broker 持有，价格触及时成交）。
6. 下一周期对**更新后的 tape 重新推理一遍**（不是延续一个长驻进程）。

**关键属性**：无预注册算法、无后台 bot 循环、每周期无状态重推 + 挂单在场；决策与执行之间隔着 git 审批闸。

**当前实证状态**：Mode 1 的形态仍成立（逐周期自主推理 + git 审批 + paper auto-push），但行为门还没全绿。v2 证明牛市 H1 可被拉到≈50%，同时暴露 bear-smci over-participation；v3/policy 把 bear 修到 4/4 PASS 并保住 bull 2/2 PASS，但 `sp-chop-tsla` 仍因震荡假突破中过大仓位 FAIL（见 [campaign §4.8](steward-p3-campaign.zh.md)）。所以「Mode 1 可作为起步工作方式」不等于「当前 prompt/旋钮已可晋级」。

### 2.2 生产式目标形态：persistent steward session

maintainer 裁决后，Mode 1 的生产式落点改为：

```mermaid
flowchart LR
  A[market/event selector] --> B[persistent Codex steward session]
  B --> C[alice-uta stage/commit]
  C --> D[paper policy + guards]
  D --> E[audit / inbox]
```

- Codex 作为**常驻 steward session**，而不是每个交易点重启一次。
- 这个常驻 session 应跑在内置 `steward` 模板里，而不是普通 `chat` workspace：模板指令把 wake 后快速 ACK、读 `.alice/steward/events/`、有限决策循环、UTA-only 执行、decision/journal 记录写进 AGENTS/CLAUDE 真源。
- selector 负责「什么时候值得让 steward 看一眼」；先可用低频 bar close / 持仓风险变化 / pending order 变化，后续再变复杂。投递方式是写事件文件后调用 live session 的 input/wake API，而不是 headless。
- watchdog 负责「Codex 卡住或长期无活动怎么办」：用 `ifIdleForMs` / `ifNoOutputForMs` 条件唤醒原 session；如果 session 不 live，则先 resume，再 wake。
- steward 仍亲手用 `alice-uta` 做交易动作；暂不优先拆 sub-agent 或 mechanical executor。
- UTA 的 authz、paper decision policy、guards、risk state、audit 是硬边界，生产式模拟必须真实经过这些边界。

## 3. 调节旋钮（改变交易行为的杠杆）

分**软旋钮**（引导 agent 的意图/风格）与**硬旋钮**（UTA 层强制上限）。今天真正在拧的几乎只有 prompt。

| 类 | 旋钮 | 当前取值 | 控什么 | 验证状态 |
|---|---|---|---|---|
| 软 | **Prompt 版本** | v3.1（v3 + regime sizing） | 参与度 / 风控 / 越权 / 是否作弊——**主杠杆** | v3 stress 未全绿：bull 2/2 PASS、bear 4/4 PASS、chop 3/4 PASS；v3.1 加 `chop/unknown` 仓位/加仓上限，真源见 [prompt-anatomy §8](steward-prompt-anatomy.zh.md) |
| 软 | **观察模式 + 盲化程度** | paste（OHLCV 内联）；盲但富（给全 OHLCV+量、可自算指标，抹标的/日期/新闻） | agent 拿到多少信息、怎么拿 | tool-native 底座已铺（#64）；盲化的结构性强制靠 #66 seal |
| 软 | **CLI + 模型** | `agents:['codex']` | 换「大脑」——不同推理质量 → 不同判断 | 未系统对比（claude/opencode/pi 可换） |
| 软 | **决策节奏** | 周线（6 周 × 5 日线，6 决策点） | 多久醒来决策一次 | 小时/日内 deferred（#65） |
| 硬 | **Paper decision policy** | 已启用（paper auto-push 内置） | 每笔 paper 自动成交前的准出闸 | `paper-auto-push.ts` 强制风险增加订单：必须带 stopLoss、估算亏损 ≤8%、不得给亏损仓加仓；v3 跑批中 `policyDenied=0`，说明它是兜底，不足以解决合规但过大的 chop 仓位 |
| 硬 | **`guards[]`** | v3.2 scratch：`max-position-size=60%` + `maxOrderPercentOfEquity=20%` | 账户级硬风险闸——无论 agent 想干什么都不许越线 | **决定启用且优先验证 position-size**。`max-drawdown` 触发→READ_ONLY 挡新单/加仓但不强平；`max-position-size` 更直接针对 `sp-chop-tsla` 的过大 exposure。本轮代码补齐 quote 估值，使 qty-based 市价新仓也会被 guard 评估；新增单笔风险增加订单 cap，用于压住震荡市初始仓过大 |
| 硬 | **`maxAuthzLevel` / 授权档** | `paper` | 渐进授权：read-only → paper → small live | 钉死 paper（I9） |
| 硬 | **起始资金** | `START=100000` | 规模基准 | — |
| 硬 | **决策超时** | 260s/次（harness 侧） | agent 能思考多深 | 观察到部分决策卡在 260s 被截断——待调 |

> **要点**：v2 时代唯一认真拧的是 prompt（软）。现在第一道硬准出已经落在 paper auto-push：stop≤8% + 不给亏损仓加仓。账户级 `guards[]` 仍建议启用，它负责组合/账户层面的回撤和敞口；paper decision policy 负责单笔交易纪律。
>
> **更新（2026-07-07）**：压测确认 v2 有 **over-participation** 尾部风险（`sp-bear-smci` 两批皆 FAIL，深熊做多被止损 −17~24%，详见 [campaign §4.7](steward-p3-campaign.zh.md)）。对策拍板「**两者都上**」后，第一刀不是让 prompt 单扛，而是把 ai-berkshire 式 checklist 准出落到 UTA：违反交易纪律的 paper commit 不自动成交。v3/policy 复验显示这刀修掉 bear-smci，但没修完 chop 假突破；第二刀已落在 v3.1 regime-specific sizing + `max-position-size=60%` 复验账户，而不是把 stopLoss 规则再写一遍。

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
