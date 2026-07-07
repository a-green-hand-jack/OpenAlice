# Steward Agent 工作方式与调节旋钮

> 版本：v0.1（2026-07-07）
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
- maintainer 方向（2026-07-07）：**当前工作方式可接受，但后续会有更丰富的工作方式，彼此互补、分别适合不同场景、并在实验中择优。** 因此「工作方式」本身是一个要显式登记、版本化、可实验比较的对象。
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

## 3. 调节旋钮（改变交易行为的杠杆）

分**软旋钮**（引导 agent 的意图/风格）与**硬旋钮**（UTA 层强制上限）。今天真正在拧的几乎只有 prompt。

| 类 | 旋钮 | 当前取值 | 控什么 | 验证状态 |
|---|---|---|---|---|
| 软 | **Prompt 版本** | v2（双目标） | 参与度 / 风控 / 越权 / 是否作弊——**主杠杆** | 已验证：v1→v2 把牛市 H1 从 7–16% 拉到 ~50%。子旋钮逐段登记于 [prompt-anatomy §2](steward-prompt-anatomy.zh.md) |
| 软 | **观察模式 + 盲化程度** | paste（OHLCV 内联）；盲但富（给全 OHLCV+量、可自算指标，抹标的/日期/新闻） | agent 拿到多少信息、怎么拿 | tool-native 底座已铺（#64）；盲化的结构性强制靠 #66 seal |
| 软 | **CLI + 模型** | `agents:['codex']` | 换「大脑」——不同推理质量 → 不同判断 | 未系统对比（claude/opencode/pi 可换） |
| 软 | **决策节奏** | 周线（6 周 × 5 日线，6 决策点） | 多久醒来决策一次 | 小时/日内 deferred（#65） |
| 硬 | **`guards[]`** | **空** | 账户级硬风险闸——无论 agent 想干什么都不许越线 | **未启用**（与 prompt 软引导互补，尚未测） |
| 硬 | **`maxAuthzLevel` / 授权档** | `paper` | 渐进授权：read-only → paper → small live | 钉死 paper（I9） |
| 硬 | **起始资金** | `START=100000` | 规模基准 | — |
| 硬 | **决策超时** | 260s/次（harness 侧） | agent 能思考多深 | 观察到部分决策卡在 260s 被截断——待调 |

> **要点**：当前唯一在认真调的是 **prompt（软）**；硬风控闸 `guards` 还是空的。这也是 chop cell 会 FAIL 的结构原因——没有硬闸兜底时，全靠 prompt 里「别在震荡市乱交易」这句软约束，而它没兜住。**引入硬闸是一个尚未动用的独立杠杆。**

## 4. 工作方式路线图（未来更丰富的方式）

**核心洞见：一种「工作方式」= 旋钮空间里的一个点。** 不同场景（行情类型 / 持有周期 / 资产类别）可能要不同的点；campaign 就是**为每个场景找最佳点**的方法。Mode 1 是当前这个点，不是唯一点。

未来方式沿以下**轴**展开（这是设计空间，不是承诺全实现）：

| 轴 | 现在（Mode 1） | 更丰富的方向 | 可能更适合的场景 |
|---|---|---|---|
| 观察→操作耦合度 | 逐周期现场推理 | 先立计划再委托执行 / 事件触发才唤醒 | 长期配置、慢牛长磨用低频计划式 |
| 信息获取 | paste（喂给它） | tool-native（自取，#64 已铺底） | 高频/大信息量场景 |
| 时间粒度 | 周/日线 | 小时/日内（#65）/ 多月长周期 steward | 高频用小时线；真·长期托管用多月周期 |
| 决策结构 | 单 agent | 多 agent 分工/辩论（研究员+风控+执行） | 复杂判断需要制衡时 |
| 策略形态 | 全自主 discretionary | 自写系统化策略 + 自主监督 | 可规则化的稳定场景 |
| 风控形态 | 软（prompt 纪律） | 硬（`guards` 闸）/ 软硬结合 | 震荡市、真金白银的 live |

**互补性**：这些方式不是互相取代，而是**分别适合不同场景**（快市用逐周期 discretionary；慢牛/长期配置用低频计划式；高频用小时线 tool-native；震荡市加硬闸）。**择优方法**：候选方式都进同一套 campaign harness，用**同一套 regime-aware 判据**（见 campaign §4）横向比，用实证而非直觉选。

**纪律**：任何新工作方式都受 [I1–I9](steward-plan.zh.md) 约束——尤其「富信息但不泄漏/不作弊」、paper 优先、全程可审计；涉及 prompt 的变更走 [ANATOMY 登记](steward-prompt-anatomy.zh.md)。

## 5. 与其它文档的关系

- 旋钮「prompt」的**真源**在 [prompt-anatomy](steward-prompt-anatomy.zh.md)（含 v2 全文与逐段解剖）。
- **实验设置**（窗口时长 / regime 定义 / 判据 / 串行执行）在 [p3-campaign §4](steward-p3-campaign.zh.md)。
- **不变量**在 [steward-plan I1–I9](steward-plan.zh.md)。
