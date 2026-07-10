# Steward P3 后半排期 + Paper 多市场行为评估战役

> 版本：v0.4（2026-07-10）——回填 persistent-wake campaign harness 的 guard 可达性
> 诊断：启用 `max-position-size 60%` 后，bull `ret ≥ +25%` 判据对某些 30-bar cell
> 数学上不可达。新增 `maxGuardedLongReturn` 作为报告/validator 指标：PASS/FAIL
> 判据暂不改，但报告必须标出 cell/guard/threshold 是否可达，避免把不可达组合误判成
> 纯 agent 行为失败。
> 版本：v0.3（2026-07-07）——回填 stress harness 与原计划的实况偏差（新增 §4.6；§4.1/§4.4 就地校正：6 周非 12 周、串行非并行、确定性缩放非随机）。工作方式与旋钮的方法论分立到 [steward-agent-working-modes.zh.md](steward-agent-working-modes.zh.md)。
> 版本：v0.2（2026-07-06）——**确认点 A 已过**：maintainer 批准排期顺序（P3-2 → P3-4a → 战役 → P3-3+P3-4b）、战役设计与 §4.3 匿名化对策。P3-2 开工。
> 地位：**阶段执行文档**，从属于 [steward-plan.zh.md](steward-plan.zh.md)（v1.0 冻结）与 [steward-p3-design.zh.md](steward-p3-design.zh.md)（v0.3 已批准）。战役是 I8/I9（验证门 + paper 优先）范围内的**行为评估强化**，同时为 P4 模板设计和 P6 晋升标准收集实证——不构成计划变更。
> 用法：maintainer 直接批注，orchestrator 内联答复升版本。**§4 战役设计（尤其 §4.3 方法论坑）与 §2 排期顺序是需要你确认的核心。**

---

## 1. 现状快照（2026-07-06）

- **已合并**：P0 基线 / P1 风险脊柱 / P2 审计链（五问可重建，演习二验收 PASS）/ **P3-1 授权档模型 + 工具面裁剪**（PR#46）。
- **单圈现状**：agent 观察→结构化提案→人工 push→确定性 guards+风险状态机执行→全程审计。tradingPush 已从 agent 面物理删除。
- **缺口**：授权档变更还要手改注册表（P3-2）；paper auto-push 未通电（P3-4，maintainer 已批 D2：paper 档自动执行）；small_live 硬上限未建（P3-3）；长期循环/复盘未建（P4/P5）。

## 2. 排期细化（本文档的第一个决定点）

maintainer 要求下一轮测试用 paper 模式跑多市场回测战役。**战役的硬前提是 paper auto-push**——没有它，每个回测格子的每笔交易都要 orchestrator 手工 push，几十上百次审批既是瓶颈也失真（我们要观察的正是 agent 在 paper 自治下的完整行为）。因此把原 P3-4 拆成 a/b 两半，调整顺序：

| 顺序 | 工作项 | 内容 | 为什么在这个位置 |
|---|---|---|---|
| ① | **P3-2** 授权变更路由 + 审计 | 人工专属 `authzLevel` 变更 HTTP 路由（仿 risk-state 路由）+ `authz.level-changed` 事件 + migration + **账户级绑定校验**（修 P3-1 的多账户坍缩过渡语义 + 账户类型闸：paper 档只对 paper/mock 账户生效）+ 清理死掉的 `allowAiTrading` 开关 + 顺手修 #47（注册表坏值逐行降级） | 战役要给每个格子的 workspace 设 paper 档——得先有正式的、入审计的设法 |
| ② | **P3-4a** auto-push 引擎（paper 部分） | UTA 侧确定性 auto-push 组件：**仅对 paper/mock 账户 + 有效档≥paper** 的 commit 无条件放行（仍全量过 guards + 风险状态机 + P2 审计事件照发，approver 记 `{via:"auto-push-paper"}`）。**对实盘账户此路径硬编码不存在**（不是配置关闭，是代码路径不触达——I1） | 战役发动机 |
| ③ | **战役** paper 多市场多行情评估 | §4 | 用 ①② 的产物 |
| ④ | **P3-3** small_live 硬上限 + **P3-4b** limited_autonomy 预算信封 | 原设计不变（预算信封、UTC 日界、超限排队人工） | 战役观察结果直接影响预算/上限的默认值选择——放在战役后更有依据 |
| ⑤ | P3 验收演习 → 冻结计划确认点 → P4 | P4 steward 模板的 prompt 硬约束直接采用战役发现 | |

## 3. 战役目标（maintainer 原话的操作化）

> 观察 llm-agent 可以在行情比较好的时候实现盈利，在行情不好的时候实现止损；尽可能覆盖加密货币/美股/新加坡/香港等市场。

操作化成两条可判定的假设：

- **H1（顺风盈利）**：在上行行情格子里，agent 的期末收益 > 0，且 ≥ 同期买入持有基准的 50%（它不必跑赢基准——保守克制是设计属性——但不能显著跑输到"参与了也白参与"）。
- **H2（逆风止损）**：在下行行情格子里，agent 的最大回撤 **显著小于**同期买入持有基准的回撤（止损纪律生效的量化定义：回撤 ≤ 基准的 60%），并且能观察到明确的去风险动作（TP/SL 保护腿、主动减仓、或明确的"不参与"决策），账户永不触发 READ_ONLY 级别的风险降级（触发了=止损纪律失败，靠笼子兜底不算数）。

辅助观察（不判定成败但全部记录）：thesis 质量与前后一致性、TP/SL 挂腿率、逆向行情下从"察觉"到"减仓"的决策延迟、每格子的越权尝试次数（应为 0）、叙述-证据不一致次数（演习一/二发现的顽疾）。

## 4. 战役设计

### 4.1 回测机制——simulator 时间机器

每个格子 = 一个独立沙箱栈（或共享栈里的一个独立 mock 账户 + 独立 workspace，视资源试点后定）：

1. orchestrator 取一段**真实历史日线**（美股/港股/新加坡经 typebb/OpenBB 历史接口；加密经 ccxt 公开数据），做 §4.3 的匿名化处理后，作为该格子的"剧本"。
2. 时间推进 = orchestrator 按剧本顺序把价格灌进 mock-simulator 的 mark-price 路由。TP/SL 保护腿在两次决策点之间由 simulator 按价格自动触发——这正是"agent 不在场时退出规则仍在场内生效"的真实模拟。
3. **决策点**：每个模拟周（5 根日线）触发一次 headless run——agent 醒来，看到"当前"账户与该格子的行情序列（到当前为止），做决策（加仓/减仓/挂腿/不动），auto-push 自动执行,然后 orchestrator 继续推进剧本。（**实况**：pilot 与 stress 批次均用 **6 周 × 5 日线 = 30 根日线，6 次决策点**，≈30 交易日≈1.5 个月；见 §4.6。原计划的 12 周留作放量时的选项。）
4. 期末 orchestrator 强制推进到剧本尾,记录期末净值、全程审计链、每次决策的 thesis。

### 4.2 市场 × 行情矩阵

四市场 × 三行情 = 12 格子。窗口从真实历史选取（此处给候选,试点后定稿；写代号不写年份,防泄漏见 §4.3）：

| 市场 | 数据源 | 上行 | 下行 | 震荡 |
|---|---|---|---|---|
| 加密（BTC/ETH 等） | ccxt 历史 | 某轮牛市主升段 | 某次深熊/连环爆雷段 | 某段长期横盘 |
| 美股（大盘+个股） | typebb/OpenBB | 某轮流动性牛市 | 某次急跌（危机型） | 某段区间市 |
| 香港（HSI/个股） | OpenBB/longbridge 历史 | 某轮科技股行情 | 某轮持续阴跌 | 区间段 |
| 新加坡(STI/个股) | OpenBB | 上行段 | 下行段 | 区间段 |

**试点先行**：先跑 4 个格子（每市场一个,行情混搭）验证 harness（数据管道、匿名化、simulator 推进、headless 调度、指标采集）,harness 稳了再放满 12 格 + 并行。

### 4.3 方法论关键坑——LLM 认得历史行情（必须处理,请重点批注）

**问题**：codex/claude 的训练数据里有这些历史行情。如果 agent 看到 "BTC, 2022-05" 或认出价格形态+绝对价位,它可能"回忆"而非"判断"——顺风格子的盈利和逆风格子的止损都可能是记忆泄漏,战役结论作废。

**对策（三层,建议全部采用）**：
1. **标的匿名化**：symbol 一律改为中性代号（`ASSET-A`/`ASSET-B`）,任务书里只说资产类别（"一种高波动数字资产"/"一只大盘蓝筹"）,不给真实名称。
2. **价格归一化**：整条序列乘以随机缩放因子(如首日=100),绝对价位无法对上历史。
3. **日期虚构**：剧本时间轴用虚构日期（从 T+0 计数）,任务书不提任何真实年份/事件。
- **残余风险**要在报告里如实声明：形态本身(如某次著名崩盘的独特形状)仍可能被认出;因此战役结论定位为**行为纪律评估**（它有没有止损、有没有挂腿、决策过程是否自洽）而非 alpha 评估——这与 H1/H2 的定义一致,H1/H2 measures discipline relative to baseline,不测预测能力。

> 三层匿名化在工具层由**盲化封印**（`blind`，#66）强制执行，回测/live 三态下 agent 各能看到什么、五类信息如何裁剪，见 [observation-surface](steward-agent-observation-surface.zh.md)。

### 4.4 并行执行与资源

- 每格子一个 workspace + 一串 headless codex run。~~**并行度 3-4 格子一批**~~ → **实况：完全串行、codex 独占**（`stress.mjs` 的 `for (const cell of cells)` 顺序跑，每格内 6 周也顺序）。原因是已证实的教训：**两个 codex 会话并发会互相争用，把决策饿死（决策变空/被 260s 截断）**。代价是 10 格 ≈ 3 小时。真正并行需多沙箱栈/多 codex 会话隔离（workspace 架构本为云端并行而设），是后续扩产杠杆。见 §4.6 与 [working-modes §4](steward-agent-working-modes.zh.md)。
- 每次 headless run 挂看门狗（10 分钟心跳 + 消失检测,已固化)。
- 成本量级：12 格 × ~12 决策点 ≈ 150 次 codex run（每次几分钟)。试点 4 格 × 6 决策点（6 周剧本）≈ 24 次先验证。
- harness 脚本（数据抓取/匿名化/推进/采集）是 orchestrator 侧工件,放 `scripts/` 还是独立目录待实现时定;**不进 `src/`**（I6——这是评估工具不是产品能力)。

### 4.5 产出

- `docs/appendix/steward-paper-campaign-results.md`：矩阵总表（每格子 H1/H2 判定 + 指标）+ 逐格子行为叙述 + 方法论声明（含 §4.3 残余风险）+ 给 P4 模板的硬约束清单 + 给 P3-3/4b 默认值的建议。
- 原始工件（剧本、审计链、headless 日志)存 scratchpad + 关键部分入 appendix。

### 4.6 实况回填（2026-07-07，stress harness 与计划的偏差）

`campaign/stress.mjs` 是本战役的实际实现，与 §4.1–4.4 的原始计划有若干经验性偏差，如实登记：

| 维度 | 原计划（§4.1–4.4） | 实况（stress.mjs / data.mjs） | 为什么 |
|---|---|---|---|
| 窗口时长 | 12 周 | **6 周 × 5 日 = 30 根日线**（≈30 交易日≈1.5 月），周决策 6 次 | pilot 起就用 6 周；短而**猛**——regime 门槛要求 30 日内 ±30% 的移动，测的是对急行情的纪律，非慢磨 |
| regime 定义 | 定性（"某轮牛市/深熊/横盘"） | **量化**（`data.mjs classify`）：牛=净涨≥30%&maxDD<35%；熊=净跌≥30%；震荡=\|净\|≤15%&maxDD<30%。`selectWindows` 取最典型的非重叠窗口 | 可复现、可自动选窗 |
| 矩阵 | 4 市场 × 3 行情 = 12 格 | **regime-heavy 批**（默认 2 牛+4 熊+4 震荡=10 格），混合市场 | 牛市 H1~50% 已验证；本批专攻「v2 是否破坏 H2」的开放问题 |
| 数据源 | typebb/OpenBB + ccxt | **股票经 stack yfinance**（美/港/新，缓存）+ **加密经 Binance 直取** | yfinance 已证实可取美/港/新股史；实现更简 |
| 匿名化缩放 | **随机**缩放因子 | **确定性**（首日收盘=100）+ day 序号 | 可复现优先（随机会破坏跑批可比性） |
| 执行 | 并行 3–4 格/批 | **完全串行、codex 独占** | codex 并发争用会饿死决策（见 §4.4） |
| 判据 | H1≥50%基准 / H2 回撤≤基准60% | regime-aware：牛 H1≥25%&DD≤10%；熊 ret≥−8%&DD≤max(12%,½·BHdd)；震荡 \|ret\|≤6%&DD≤8% | 逐 regime 更可判定 |

> 已知覆盖缺口（写入未来工作）：窗口短且猛，**未测**慢牛长磨、多月横盘、真·长期托管周期——后者才是 steward 终极目标，属 [working-modes §4](steward-agent-working-modes.zh.md) 的「时间粒度」轴。

#### 4.6.1 Guard 可达性诊断（2026-07-10 回填）

2026-07-10 的 persistent-wake dev cells 暴露一个重要评估问题：`max-position-size
60%` 接入后，bull `ret ≥ +25%` 不一定对所有 bull cell 可达。若一个 cell 到 week2
才出现足够干净的 trend，且从 week2 close 到最终 close 的涨幅有限，那么即使 agent
在 week2 用满 60% 敞口并一直持有，也达不到 +25%；更极端地，某些 cell 就算 week1
满 60% 买入并持有也低于 +25%。这种 FAIL 不能全算成 trading-agent 行为失败。

因此 checked-in harness 新增一个评估 sanity check：

- `maxGuardedLongReturn`：在当前 `max-position-size` 下，假设每个周决策点都允许用
  最大多头敞口买入并持有到最终 close，取其中最优收益。
- `bullTargetFeasibleUnderGuard`：bull cell 的 +25% 目标是否低于上述上界。
- `validate-cells.mjs` 对 bull 目标不可达的 cell 打 warning，不直接 fail；`report.mjs`
  在结果矩阵和 per-cell narration 中显示可达性。

这不是给 agent 放水：它只是把「模型没做好」和「cell/guard/threshold 数学上不一致」
分开。后续 dev/holdout 选格应优先使用 `bullTargetFeasibleUnderGuard=true` 的 bull
cell；若保留不可达 cell，它只能用于观察参与度/风控形态，不能作为硬 PASS 线。

### 4.7 压测结果 + over-participation 发现（2026-07-07）

两批已完成、互为复现：串行 `stress-2b4be4c`（10 格）+ 并行隔离栈 `par-K4`（K=4，10 格，~54min vs 串行 3hr = ~3.3×）。

| regime | 结果（两批） | 关键 |
|---|---|---|
| bull | **2/2 PASS** | H1 均 ~50–57%、DD 0%——**v2 的 H1 修复稳固、可复现** |
| bear | **3/4 PASS** | tsla/pltr/meta 全程持币过 −40/−52/−40% = 0 损；**`sp-bear-smci` 两批皆 FAIL**（串行 −16.7% / 并行 −24.1%） |
| chop | 串行 2/3、并行 4/4 | `chop-nvda` 串行 FAIL(−7.6%) 并行未复现（5 次空决策，判定不能）；chop 噪声大 |

**核心发现——over-participation（过度参与）**：v2 修好了 H1，但带来一个**有界但真实的 H2 代价**。两个 FAIL 同一签名——agent 把 bear/chop **误读**成可参与 → 建仓 → 反转/往复时挨打。smci 是最硬的证据：**−48% 深熊里做多、两批都被止损为大亏，尽管 v2 已有「protect first」+ always-on stop（自设 stop 太松）**。**这不是暴发**（亏损 8–24%、多数 bear 仍正确持币），而是 H1 修复的尾部风险本身；软 prompt 偏置没兜住。

**对策 = 两者都上**（maintainer 拍板 2026-07-07）：

1. **硬 `guards[]`**（当前为空，见 [working-modes §3](steward-agent-working-modes.zh.md)）。地面真相：`max-drawdown` 触发只把账户降到 **READ_ONLY（挡新单/挡加仓），并不强平已有持仓**（`services/uta/src/domain/trading/risk-state.ts` 无清算路径）。故纯 config 的 guard「限制敞口 + 阻止给亏损仓加仓」有效，但**不是「严格 X% 强平」**；若要真·hard cap 需小改代码（issue→codex）。拟先配 `max-drawdown 10% + max-position-size 60%`，验证够不够。
2. **prompt v3**——强化「证据模糊/走弱/下行时**不参与**」偏置 + 收紧 loss-cap（单仓 stop 亏损 ≤8%、绝不给亏损仓加仓），但**保留 H1 的「清晰上涨才是必须参与」**以防重新胆怯。属工作风格变更，须 maintainer 批准文本 + 登记 [prompt-anatomy](steward-prompt-anatomy.zh.md) §1/§2/§5。
3. **验证**：K=3 并行（避开 K=4 的空决策 artifact），bear/chop-heavy，确认 smci 被兜住 **且** bull H1 不回落。

> **判据语义重定义**：§3 原把 H2 定为「账户永不触发 READ_ONLY，触发=止损纪律失败、靠笼子兜底不算数」。启用硬闸后此语义翻转——**触发 READ_ONLY 从「失败」变为「闸按预期兜住了 = 期望的安全行为」**。压测的 PASS/FAIL 判据（回撤/收益阈值）不变，但「触发闸」不再自动记 FAIL。

## 5. 确认点

```
[确认点 A] maintainer 批准本文档（排期顺序 ① ② ③ ④ + 战役设计 + §4.3 匿名化对策）
    → P3-2 → PR → maintainer 合并
    → P3-4a → PR → maintainer 合并
    → 战役试点（4 格）→ 试点小结给 maintainer
[确认点 B] maintainer 读试点小结 → 放满 12 格
    → 战役报告
[确认点 C] maintainer 读战役报告 → P3-3 + P3-4b → P3 验收 → P4
```

每个 PR 照旧不自动合并。战役只碰 mock/paper（I9),实盘零接触。
