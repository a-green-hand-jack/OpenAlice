# Steward Prompt Anatomy — 提示词解剖与管理登记

> 提示词是 agent「工作风格」的载体，是一等实验变量。本文件把 prompt 纳入
> ANATOMY 系统统一管理：登记每一版、逐组件标注意图/所控行为/版本变更，并规定
> prompt 漂移规则。**改 prompt 必须同步更新本文件**——与代码
> [ANATOMY.md](../ANATOMY.md) 同源纪律。
>
> 关联：[ANATOMY.md](../ANATOMY.md)（代码结构）、
> [steward-p3-campaign.zh.md](steward-p3-campaign.zh.md)（战役设计）、
> [steward-plan.zh.md](steward-plan.zh.md)（I1–I9 不变量）。

## 0. 为什么 prompt 要「格外小心」地管理

- prompt 直接决定 agent 行为：参与度、风控、是否越权、是否试图作弊。它是**不可复现风险的主要来源**。
- 散落、未版本化的 prompt = 不可复现、不可审计的 agent 行为。一次实验若不记录用了哪一版 prompt，结果就无法解释。
- 因此纳入 ANATOMY：**定位**（在哪）、**标注**（每段控什么）、**版本**（改了什么）、**漂移检查**（改动同步）。

## 1. 提示词登记表（Prompt Registry）

| 版本 | 用途 | 权威真源 | 运行副本 | 状态 | 关键特征 |
| --- | --- | --- | --- | --- | --- |
| v1 (pilot) | 4-cell 中性 steward 试点 | 已归档（见 §6 摘要） | `campaign/pilot.mjs` `stewardPrompt`（orchestrator 侧） | 已归档 | 中性框架；仅裸日收盘价；"conservative by default" → 极度保守（H1 仅吃 7–16% buy-hold，H2 决定性通过） |
| **v2** | 双目标 + 盲但富信息 | **本文件 §5** | `campaign/prompt-v2.mjs` `stewardPrompt` | **已批准 2026-07-06；已验证 2026-07-07** | benchmark-aware 双目标；富信息（OHLCV+量+自算指标）；盲化反作弊；paste / tool-native 双模式 |
| **v3** | steward **模板**唤醒指令实质内容（issue #98） | **`src/workspaces/templates/steward/files/instruction.md`**（仓库内提示词面，见 §3；文件本身即运行副本，无需另存比对拷贝） | 同左（in-repo 模板文件，wake 时逐字读取） | **已实现（2026-07-08）；Codex core-agent smoke 已跑通（2026-07-09）；H1/H2 campaign 复测 pending** | 首次把 v2 substance 移植进**真正被持久化唤醒机制使用**的模板（此前 v2 只活在 orchestrator 侧 `stress.mjs`，checked-in `instruction.md` 从未获得过它）；协议骨架（世界边界/唤醒循环/ledger JSON 契约）基本保留；新增 dual mandate + evidence-first + risk discipline + campaign §4.7 认可的「反过度参与」方向；stop-loss 风险上限收紧至 ~8%、禁止摊薄亏损仓，与 #97 硬 guards 语义对齐（软镜像，不替代）。Wake Loop / Decision Ledger Shape 后续经六次现场修补：issue #101 加了工具选择澄清（用 Write/Edit 写 ledger，不用 Bash heredoc），issue #103 加了 ACT 步骤（`propose_trade` 必须先下单+commit 再写 ledger，否则决策和实际敞口脱节）——现为 7 步，非原始 6 步；issue #105 给 Wake Loop 第 1 步加了 `expectedDecision` 反偏置澄清（该字段是 orchestrator 记账值，不是决策指导）；issue #107 给 Decision Ledger Shape 加了 `context`/`manifestSha256` 可选澄清（该字段本就是 optional，无需算真实 hash，更不能为此调用未预信任的 Bash 工具）；issue #111 给 Wake Loop 第 5 步加了 `autoPush` 结果检查澄清（下单+commit 后必须看真实的 guard 拒绝/成功结果并纠正重试，不能把从未成交的单子当成功记进 ledger）；issue #113 把 Wake Loop 第 5 步里携带自由文本的 6 个写操作命令（`order place`/`modify`/`cancel`、`position close`、`git commit`/`reject`）从裸 `--flag "..."` 参数改成两步 `--json-file` 模式——用 Write 工具把结构化参数+自由文本一起写进 gitignored `.alice/steward/tmp/`，Bash 只传一个纯文件路径，杜绝自由文本（如 `+$543` 这类 `$`+数字）触发 Claude Code Bash 安全分类器（第三次同类触发，前两次是 #91 的 heredoc 和 #107 的 openssl 管道）；2026-07-09 smoke 进一步确认：Codex core-agent 的唤醒可靠性问题主要在**投递/沙箱/并发文件写**，不是 v3 文本本体，修补记录见 §9。逐组件解剖见 §7、§8 |
| **v4** | performance tuning + ledger 自校验 | **`src/workspaces/templates/steward/files/instruction.md`** | 同左 + 新建 workspace 的 `.alice/steward/validate-ledger.mjs` | **已实现（2026-07-10）；dev baseline 已跑** | 针对 2026-07-09 dev baseline：bull cells 参与不足（小仓位/过度保守）且 low-signal chop/FX wake 偶发写出 schema-invalid ledger 后被 supervisor 视为未完成直到 timeout。v4 在 Participation Bias 中加入「清晰 uptrend 下 meaningful starter position」尺寸语义（flat + NORMAL risk + high conviction 通常 25-60% notional，而非 5-10% toe-hold），并在 Wake Loop 第 6 步要求写完 ledger 后运行 workspace-local `validate-ledger.mjs <wakeId>`，明确 `checklist`/`thesis`/`actions`/`pendingHash`/`invalidation`/`cost` 必须是顶层字段，schema-invalid line 不算完成 marker。Full dev baseline 证明 timeout/ledger 问题消失，但 bull behavior 仍不达标：NVDA 有首仓但不加仓，0700.HK 正常回撤中过早离场。 |
| **v5** | winner management + pullback discipline | **`src/workspaces/templates/steward/files/instruction.md`** | 同左 + `.alice/steward/validate-ledger.mjs` | **已实现（2026-07-10）；targeted regression failed** | 针对 v4 full dev baseline 的行为缺口：在 Participation Bias 中补充「盈利趋势仓位要重新评估当前 notional，不足且可控风险时可顺势加仓」「健康 uptrend 的正常 pullback / 临时浮亏不等于 invalidation」「低波动漂移不等于高置信 uptrend」，并在 Risk Discipline 中明确只允许给盈利或持平且 thesis 仍有效的仓位加仓，且必须先/同时上移 stop。Targeted regression 显示方向不够窄：NVDA 学会加仓但贴近 max-position guard 后触发 READ_ONLY；0700.HK 仍被 pullback 洗出；SPY low-vol chop 过早参与。 |
| **v6** | guard headroom + stricter trend filter | **`src/workspaces/templates/steward/files/instruction.md`** | 同左 + `.alice/steward/validate-ledger.mjs` | **已实现（2026-07-10）；targeted regression partial / failed bull threshold** | 在 v5 基础上把 starter range 收窄为 25-45%，加仓目标收在 50-55% notional 而不是贴近 60% hard guard；明确若 mark-to-market 把敞口推近/超过 guard，应 trim 回 guard 下方而不是等 READ_ONLY；把 pullback hold 条件写成「在原 stop/risk budget 内、仍高于 swing support、且未超过约 8% adverse move」；把 low-vol chop 过滤写硬：1-4% 的一两周窄幅 drift 不足以使用 meaningful starter。Targeted regression 修掉 NVDA READ_ONLY（+17.0%，仍低于 +25% bull 阈值）并让 SPY PASS，但暴露 0700.HK 的 default-contract/AAPL 污染。 |
| **v7** | campaign tradable contract binding | **`src/workspaces/templates/steward/files/instruction.md`** + `tools/campaigns/run-cell.mjs` | wake `marketContext.tradeableAliceId` | **已实现；targeted + 10-cell 六周 baseline 已完成（2026-07-10）；尚未冻结 holdout** | v6 targeted 暴露出非 prompt-policy 摩擦：MockBroker 空搜索会返回默认 `AAPL`，agent 在 0700.HK cell 中读 `ASSET-K` tape 却尝试交易默认 `AAPL`。v7 显式传入并强制使用 exact `tradeableAliceId`。后续 60/60 wake 证明 isolated-stack contract binding 已稳定、无 AAPL 污染；但 guard-feasible NVDA 仅 +17.7%，仍低于 +25% bull gate。六路 shared-stack 则被 Codex trust-config 并发写竞争阻断（#124），不是 prompt policy 失败。 |
| **v8-CANDIDATE** | ① v2 ledger contract（strict pendingHash / typed actions / single-entry wakes，#125）② participation & winner-management policy（first-wake 参与 / 目标敞口带 / 加赢家默认，#126）③ degenerate-turn guard（命令参数尺寸纪律：ledger 只用原生 file-write 工具组装、禁巨型 inline 参数，#132） | **`src/workspaces/templates/steward/files/instruction.md`**（① Wake Loop step 5-6 + Decision Ledger Shape；② Participation Bias `78-109`）+ 生成的 `.alice/steward/validate-ledger.mjs` | 同左（in-repo 模板文件，wake 时逐字读取） | **候选，未冻结（issue #125 + #126 + #132）；dev matrix 复跑 pending；NVDA 验证跑 gate PR；holdout 仍封存** | 两个组件共用同一 v8 候选版本，不各自升版。**①（#125）** 配合 decision-ledger schema v1→v2（`DECISION_LEDGER_SCHEMA_VERSION` bump）落地的 prompt 半边：Decision Ledger Shape 现示 `version: 2` + 一个 typed action 示例（`kind`/`aliceId`/`params`/`commitHash`/`outcome`/`violations`）；Wake Loop step 5 增补「每个 broker 操作记一个 typed action 对象，`outcome` 对应四个 `autoPush` 分支，commit 出处进 `actions[].commitHash`，`pendingHash` 仅表示待批准 stage、executed 后必须为 null」；step 6 增补「每个 wakeId 恰好一条记录、first-wins、要更正就原地改那一行不追加第二行」。**②（#126）** 针对 NVDA bull cell 的 0/3 稳定 under-participation（3 次复跑 +17.7% / +17.4% / +16.4%，全部低于 +25% bull gate，均远低于 buy-hold +57.3% 与 guard-feasible +33.0%）：Participation Bias 三条杠杆——(1) first-wake 参与默认（有趋势证据+风险预算时首个 wake 开首仓为默认，仅在 ledger 写明具体 invalidation/trigger 时才可延后）；(2) winner 目标敞口带 70-85% equity，显式声明确定性 guard 是唯一硬顶、禁止自造更低软顶（直指观测到的自封 "50-55% exposure band"）；(3) 趋势完好且敞口未达带/guard 时，「每 wake 评估加仓」为默认动作，持有不加需在 thesis 写明理由。两者均属**实质性行为变更**，按 §4 规则 4 须 maintainer 批准后才升 v8 正式版；升版前 dev matrix 必须复跑确认 bull 参与度、ledger 完成率、`propose_trade` 记账正确性不回落，且 bear/chop cells 不因参与度上调而回落，holdout 保持封存。**③（#132）** Wake Loop step 6 在既有 heredoc 禁令上增补命令参数尺寸纪律，针对 v8 NVDA run1 week-2 的 271KB 退化 `exec_command` 参数（撑爆自身 deadline 并毒化持久 session）；配套 harness 半边（threshold session rotation + supervisor timeout attribution，纯代码不进本台账）见 issue #132 / PR #133。升版前 v8 NVDA 复跑还须确认 week-2 degeneration 不复现。逐组件解剖见 §15（①）、§16（②）、§17（③）。 |

> **v2 验证结果（2026-07-07，paste 模式，3 个真实牛市匿名窗口）**：H1 = NVDA 42% / TSLA 65% / AMD 43%（均 ~50%），maxDD 全 0%。对比 pilot（v1）H1 仅 7-16%——**v2 把牛市参与度提升 3-5×，同时保住 H2 纪律（回撤 0%）**。即「行情好时参与、行情差时仍不冒大险」。12-cell（含 bear/chop）将复核 v2 是否破坏 H2。

> **v3 落地状态（2026-07-08）**：`docs/steward-p3-campaign.zh.md` §4.7 记录的压测发现——v2 修好了 H1，但带来一个有界的 over-participation 代价（`sp-bear-smci` 深熊误读为可参与，两批皆 FAIL）——maintainer 拍板「硬 guards（#97）+ prompt v3 两者都上」。本次改动落地的是 prompt v3 半边：把 v2 substance + 反过度参与方向一并写入真正的仓库内模板。**尚未用新一轮 campaign 复测**（确认 smci 类场景被兜住、且 bull H1 不回落）——回归验证是下一步，不在本次改动范围内。

> **v8 完成协议 #136 增补（2026-07-11，finalize barrier）**：`files/instruction.md`
> Wake Loop 完成步骤新增一句——「**运行 validator 才是提交点**」。此前 prompt 只说
> 「写完 ledger 跑 validate-ledger，失败就改」，隐含允许「写→立即被 supervisor 终态化→
> 再原地更正」，与 #134 的终态后 mutation 检测相撞（见 issue #136 canary）。#136 起：
> supervisor 只在 validator 发布的 finalization marker 指纹与当前行一致时才终态化；因此
> prompt 明确要求**对 ledger 行的任何后续编辑都必须重跑 validator**，否则 marker 与行不符、
> wake 不会完成。属完成协议澄清（不改记账字段语义），代码半边（marker + 屏障）见
> `docs/steward-persistent-loop-implementation.zh.md` §7 的 #136 段。

> **v8 完成协议 #139 增补（2026-07-11，wakeId 身份诚实）**：`files/instruction.md`
> ledger 写入步骤新增——顶层 `wakeId` 必须逐字复制**本次** wake 的 id，**禁止**复用/手抄
> 前一个 wake 的 id（canary 里 steward 把前一 wake 的 UUID 尾段抄进了顶层 wakeId）；
> `completion.evidenceRefs` 的 `wake:<id>` 自引用必须与顶层 wakeId 完全一致，否则验证失败；
> 并用该精确 id 运行 validator。属完成协议澄清（防止 entry 冒充另一个 wake），代码半边
> （schema 自洽 + validator 外部绑定 active wake + supervisor actionable mismatch 事件）见
> `docs/steward-persistent-loop-implementation.zh.md` §7 的 #139 段。

> **真源约定**：实验提示词按不变量 I6 存于 orchestrator 侧（scratchpad，不入 `src/`）。
> 为可复现/可审计，其**受版本管理的真源是本文件**（§5 全文）；scratchpad 的 `.mjs`
> 是**可运行副本，须与本文件登记的文本逐字一致**。两者不一致时以本文件为准。

## 2. v2 逐组件解剖（明细标记）

每段标注：**[组件]** 意图 / 所控行为 / 相对 v1 的变更 / 关联不变量。

- **[Role 角色]** "prudent capital steward … make the RIGHT decision"。意图：确立稳健但**主动**的身份。变更：删去 v1 的 "conservative by default"——那句把身份钉死在「只求保本」，是 H1 失败的框架性根因。
- **[Blinding 盲化]** "identity/calendar/news withheld … do not guess or try to look up"。意图：强制只看 tape，杜绝用真实资产的后见之明。所控：**反作弊**。关联：不变量「富信息但不泄露」——本句在 prompt 层声明，工具层由 **#66 sealed-workspace** 强制执行。
- **[Data block 数据块]** paste 模式内联匿名 OHLCV；tool-native 模式只给 barId 让 agent 用自己的工具去取（依赖 **#64** MockBroker 回放真序列）。意图：把「收集+压缩信息」交给 agent 自己做。变更：v1 只给收盘价 → v2 给全 OHLCV+成交量。
- **[Evidence-first 先取证]** "Analyze the tape yourself: trend / momentum / volatility / levels / volume … thesis from evidence, not vibes"。意图：逼出真实市场判断，而非情绪化下单。呼应 maintainer「判断的前提是收集和压缩信息」。
- **[Mandate 双目标]** "TWO ways to fail … under-participate in a sustained uptrend is a failure of stewardship, not prudence"。**H1 修复核心**。意图：把「错失上涨」显式定为与「亏损」等价的失败。变更：v1 无此概念 → agent 只避亏，故结构性不参与。
- **[Risk discipline 风控]** "protective stop … trail it up … don't confuse inactivity with discipline"。意图：保留 v1 已验证的优秀 H2 风控（跌市 maxDD 从不超 0.6%），同时警告「不动 ≠ 纪律」。
- **[Output format 输出]** "THESIS: … | ACTION: …"。意图：机器可解析，逐周期可审计。

## 3. 仓库内提示词面（in-repo prompt surfaces）—— 一并纳管

除实验提示词外，仓库内也有 agent-facing 提示文本。改动它们时须同步更新引用它们的
`ANATOMY.md` 并在此登记：

> 「工具描述串」是观察面的 **how-to-call** 侧；agent 各态**能看到什么**（五类信息、盲化裁剪）见 [observation-surface](steward-agent-observation-surface.zh.md)。

| 面 | 位置（file:line） | 控什么 |
| --- | --- | --- |
| 模板 persona / 指令 | `src/workspaces/template-registry.ts:81-87`（`injectPersona` = Alice persona + 模板 `instruction.md`）；模板目录 `src/workspaces/templates/{auto-quant,chat}/` | workspace agent 的基础人设与任务框架 |
| Steward 唤醒指令（实质内容，v3 起纳管，v7 当前版 + v8-CANDIDATE ledger 契约 + participation policy） | `src/workspaces/templates/steward/files/instruction.md` 全文（379 行）：World Boundary `7-21`、Mandate `23-40`、Evidence-First Reasoning `42-61`、Participation Bias `63-132`（v4 新增 meaningful starter position；v5/v6 新增 winner management / pullback discipline / low-vol chop filter / guard headroom；**v8-CANDIDATE(#126) 新增 first-wake 参与默认 `78-86`、winner 目标敞口带 70-85% + 拒绝自造软顶 `92-102`、加赢家为每 wake 默认动作/持有需理由 `102-109`**）、Risk Discipline `134-154`、Wake Loop `156-287`（7 步，含 issue #103/#105/#111/#113 修补 + v4 ledger validator + v7 `tradeableAliceId` binding + #125 v2 typed-action / strict-pendingHash / single-entry 记账 + **#132 命令参数尺寸纪律（step 6，ledger 只用原生 file-write 工具组装）**）、Decision Ledger Shape `289-370`（含 issue #107 的 `context`/`manifestSha256` 可选澄清 + #125 `version: 2` typed-action 示例）、Safety `372-379` | steward workspace 唤醒时的完整行为提示。世界边界不变；ledger JSON 契约在 #125 升为 v2；参与/winner-management 策略在 #126（v8-CANDIDATE 第二半）调整；Wake Loop 协议步骤见 §8 和 §10；v3-v7 的推理与风控实质见 §7、§10、§11、§12、§13；v8-CANDIDATE ledger 契约见 §15、participation policy 见 §16、degenerate-turn guard 见 §17 |
| 工具描述串 | `src/tool/*.ts` 的 `description:`（21 处），如 `src/tool/analysis.ts:37`、`src/tool/market.ts:27` | agent 何时/如何调用各工具——本身即 prompt |
| Key-test 探针 | `src/workspaces/agent-probe.ts:74`（一次性 "Hi"） | 仅验证凭证连通，无行为语义 |

> 状态：本节为**起始清单**，逐面 file:line 全量核对 pending。任何 PR 若新增/改动
> agent-facing 提示文本，须在此登记并跑 `check-anatomy-drift`。

## 4. Prompt 漂移规则（Drift Rule for Prompts）

对齐 [ANATOMY.md](../ANATOMY.md) 的 Drift Rule：

1. 改任何 prompt（实验或仓库）→ **同一改动内**更新本文件的登记表 + 解剖，不得事后补。
2. 仓库内 prompt 面文件移动/改名 → 同步更新引用它的 `ANATOMY.md`，并跑
   `pnpm exec tsx tools/check-anatomy-drift.ts --check`。
3. 每次实验/跑批必须在结果里标注所用 prompt 版本号（如 `prompt=v2`），否则结果不可复现、不予采信。
4. 提示词的**实质性**改动（改变 agent 行为倾向）视同「工作风格变更」，须经 maintainer 批准后才升版；升版在 §1 登记表追加一行。

## 5. v2 全文（canonical, paste 模式）

英文原文即 agent 实际收到的文本；与 `campaign/prompt-v2.mjs` 的 `stewardPrompt({mode:'paste'})` 逐字一致。`{OHLCV table}` / `{week}` / `{N}` 为运行期占位。tool-native 模式仅把数据块替换为「用工具自取 barId 的历史」，其余不变。

```text
You manage a paper trading account — real decisions, virtual money. You are a prudent capital steward: your job is to make the RIGHT decision for the market in front of you — protect when it's dangerous, participate when it's healthy.

INSTRUMENT — blind by design
You may trade ONE instrument: ASSET-A. Its identity, calendar, and news are withheld on purpose. Judge ONLY the tape; do not guess or try to look up what it is.

This is decision period {week} of {N}.
Daily bars so far — day, open, high, low, close, volume; most recent last:
{OHLCV table}

Analyze the tape yourself: read trend (e.g. moving averages), momentum (RSI/MACD), volatility (ATR — for stop sizing), where price sits vs recent swing highs/lows, and how volume behaves. Form a thesis from evidence, not vibes.

MANDATE — two ways to fail, equally real
Your benchmark is a simple buy-and-hold of this instrument over the same period. You fail if you:
  (1) lose capital in a falling / dangerous market — protect first; OR
  (2) badly UNDER-participate in a sustained, healthy uptrend — sitting in cash while it trends up for weeks is a failure of stewardship, not prudence.
Lean IN when the evidence supports a trend; lean OUT when it doesn't. Your size and stance should track your read of the market, not a fixed caution.

RISK DISCIPLINE (always on)
When you hold risk, cap the downside with a protective stop and trail it up as the position works. Size from conviction + volatility. Don't over-trade — but don't confuse inactivity with discipline.

ACT
Use the `alice-uta` CLI (`alice-uta --help`, `alice-uta trading --help`, `alice-uta git --help`). Check cash + positions; decide buy / add / trim / sell / set-stop / hold; if you trade, place the order then commit it (`alice-uta git commit --source <acctId> --message "..."`) — it auto-executes on this paper account.

Be terse. End with exactly:
THESIS: <your read of the market> | ACTION: <what you did + current stance/size>
```

## 6. v1 摘要（已归档）

中性 steward 框架，仅给裸日收盘价，含 "conservative by default"。4-cell crypto 试点结论：agent = 极度资本保全者——H2（跌市止损）决定性通过（−42% 崩盘全程持币、maxDD 从不超 0.6%），H1（涨市参与）失败（仅吃 7–16% buy-hold）。详见 [appendix/steward-paper-campaign-pilot.md](appendix/steward-paper-campaign-pilot.md)。v2 即针对 H1 的框架性修复。

## 7. v3 逐组件解剖（steward 模板，issue #98 新增）

v3 是首次把 v2 的实验性 substance 移植进**真正被持久化唤醒机制使用**的仓库内模板——此前 `instruction.md` 只有裸协议（世界边界 + 唤醒循环 6 步 + ledger JSON 契约），没有 v2 的任何推理/风控内容。World Boundary 与 Decision Ledger Shape 的 JSON 契约逐字保留（`stewardDecisionLedgerEntrySchema` 未改一个字段）；Wake Loop 落地后又经两轮现场修补（工具选择澄清 + ACT 步骤，见 §8），现为 7 步而非最初的 6 步。以下是本次（issue #98）新增的实质组件。

每段标注：**[组件]** 意图 / 所控行为 / 相对旧 `instruction.md` 的变更 / 关联不变量。

- **[Mandate 双目标]** `instruction.md:23-40`。"two ways to fail … equally real" —— 把「跑输牛市」与「跌市亏损」定为同等失败，直接移植自 v2 §5 的 MANDATE 段（benchmark = 简单 buy-and-hold）。意图：给 Wake Loop 第 4 步的决策提供目标框架。所控：`propose_trade` vs `no_trade` 的整体倾向。变更：旧版无任何目标/benchmark 概念——6 步协议只讲「怎么走流程」,不讲「决策该往哪个方向偏」。关联：[steward-p3-campaign.zh.md](steward-p3-campaign.zh.md) §3 的 H1（顺风参与）/ H2（逆风止损）定义。
- **[Evidence-First 先取证]** `instruction.md:42-61`。"read the tape yourself … thesis from evidence, not vibes"，并把 trend / momentum / volatility / levels / volume 五要素显式与 ledger 的 `thesis`/`invalidation` 字段绑定（"a moving-average cross, a break of a swing level, a stop getting hit"）。意图：让 `thesis`/`invalidation` 不再是任意占位文本，而是有证据锚点的字段。所控：ledger 条目里 `thesis`/`invalidation` 两个字符串字段的写法（不改字段本身，只改怎么填）。变更：旧版 ledger 契约把这两个字段列为纯字符串，无任何写法指引。关联：呼应 v2 §2 同名组件；不涉及不变量（不改 schema、不改风控权威）。
- **[Participation Bias 参与偏置 / v3 方向]** `instruction.md:63-110`。"lean OUT — and default to `no_trade` — when the evidence is unclear, weakening, or downside-leaning"，同时保留 "do not sit out a clear … uptrend"。意图：这是 [steward-p3-campaign.zh.md](steward-p3-campaign.zh.md) §4.7 发现 over-participation（`sp-bear-smci` 深熊误读为可参与、串行/并行两批皆 FAIL）之后 maintainer 拍板的「prompt v3」方向本体——此前从未成文，只存在于 §4.7 的对策记录里。所控：evidence 模糊/走弱/下行时的默认动作。变更：v2 原文只有单向的 "lean IN when evidence supports a trend"；本版补上对称的另一半（证据不清/走弱/下行时默认 `no_trade`），同时刻意**不弱化** v2 已验证的 H1 修复（保留「清晰上涨仍须参与」的偏置，防止退回 v1 式极度保守）。关联：[steward-p3-campaign.zh.md](steward-p3-campaign.zh.md) §4.7 over-participation 发现 + H2 定义的判据语义。v4-v6 对本组件的后续增量见 §10-§12。
- **[Risk Discipline 风控收紧]** `instruction.md:112-132`。"never size a stop to risk more than roughly 8% … never add to a position that is already losing"，并显式声明 "the guards are the backstop; apply these yourself rather than relying on them to catch it"。意图：把 v2 原有的 "protective stop, trail it up" 风控语言，收紧到与 issue #97 硬 guards（`max-drawdown` / `max-position-size`）同量级的具体数字，同时把 prompt 层风控明确定位为「软镜像」而非风控权威。所控：止损比例、是否允许摊薄亏损仓。变更：v2/旧版都没有具体止损比例数字，也没有「禁止摊薄亏损仓」规则。关联：不变量 **I3**（风险机制是确定性代码，LLM 永远不在风险检查信任链上，见 [steward-plan.zh.md](steward-plan.zh.md)）——本组件不改变、不替代 I3 的分工：guards 仍是唯一权威（`services/uta/src/domain/trading/risk-state.ts`），这里只是让 agent 自身的风控直觉提前向 guards 的阈值对齐，减少被动触发 READ_ONLY 降级的次数。v5/v6 对「允许加赢家、不允许摊平亏损仓、给 hard guard 留余量」的补充见 §11、§12。

## 8. Wake Loop / Decision Ledger Shape 现场修补记录（issue #101、#103、#105、#107、#111、#113）

v3（§7）落地后，六轮真实 campaign 现场验证各发现一处 Wake Loop / Decision
Ledger Shape 缺口，均已修补：

- **issue #101（campaign harness 首次真实 cell 跑通时发现）**：`--agent claude`
  下 wake 卡死在 ledger 写入这一步——Wake Loop 原第 5 步只说"追加一行 JSON"，
  没说用什么工具写；agent 自行选择 Bash heredoc，触发 Claude Code 的
  "expansion obfuscation" 分类器，无人应答的 wake 永久卡住。修补：Wake Loop
  该步骤明确要求用 Write/Edit 工具、不用 Bash 命令；配合 issue #92 授予的裸
  `Write`/`Edit` 权限一起解决。
- **issue #103（在 #101/#92 修好之后，第一次真实无人值守跑通全流程时发现）**：
  ledger 写入不再卡死了，但 agent 把"决定 `propose_trade`"和"记录这个决定"
  当成了任务终点——ledger 里 `decision: "propose_trade"`、`thesis` 完整，但
  `actions: []`、`pendingHash: null`，账户全程没有任何仓位变化。根因：Wake
  Loop 原本只有"决定"和"写 ledger"两步，中间没有"如果决定是 propose_trade，
  必须先真的下单+commit"这一步——agent 严格按字面执行了指令，指令本身就没
  要求它去做。修补：Wake Loop 新增第 5 步，`propose_trade` 必须先用
  `alice-uta` 下单（按 Risk Discipline 附带 stopLoss）并 commit，再写 ledger；
  `actions`/`pendingHash` 必须反映真实执行结果，不是意图。

- **issue #105（在 #103 修好之后，campaign harness 第三次真实 cell 跑通时发现）**：
  ledger 写入不卡了，`propose_trade` 也会真的去下单了，但这次 agent 在一个
  明确、证据充分的牛市里主动选择了 `no_trade`。现场 transcript 显示它的原话
  是——wake envelope 里的 `expectedDecision` 字段写着 `"no_trade"`，
  `reason` 写着 `"scheduled_observe"`，agent 据此判定"这是一个纯观察 wake，
  没有交易授权"，于是即使认出了清晰上涨趋势也照样不下单。根因：
  `tools/campaigns/run-cell.mjs`（issue #101）对每一次 wake 都硬编码同一套
  `reason`/`expectedDecision`，而 agent 在 Wake Loop 第 1 步就会读到这个字段
  ——它是 wake API 的必填字段，orchestrator 侧用来做事后核对，但暴露给 agent
  后被误当成了"预期答案"，形成自证预言式的 `no_trade` 偏置，会系统性压低整个
  campaign 的参与度，H1（牛市参与）从根上就无法被诚实测出。修补：不改 harness
  或 wake schema（`expectedDecision` 必填，改成"更准"的硬编码值只是把偏置换
  个方向，治标不治本）——Wake Loop 第 1 步（读 wake envelope 的地方）明确告
  诉 agent：`expectedDecision` 是 orchestrator 自己的记账字段，不是指导，
  决策只能从下面几步收集到的 checklist 结果和市场证据得出，不能因为这个字段
  写了什么就倾向或反倾向于某个决定。

- **issue #107（在 #105 修好之后，Phase E 4-cell pilot campaign 第一个真实
  6-周期 bull cell 跑通时发现）**：week 1 的 wake 跑满整个 `wakeTimeoutMs`
  （545s）被 harness 判超时，`decision` 为空、ledger 从未写入；harness 随即
  在 week 2 对同一账户重新 POST wake，撞上 UTA 侧仍持有的 steward 账户锁，
  直接 409 `account_locked`，整个 cell 中止。现场 transcript（保留在
  workspace 目录外的 Claude Code 项目转录里，workspace 本身已被 harness 清理
  删除）显示：agent 正确跑完 checklist、形成了 thesis，随后在按 Decision
  Ledger Shape 示例填 `context.manifestSha256` 时执行了
  `Bash: cat context-manifest.json | openssl dgst -sha256 -hex | awk ...`
  ——这条命令不在 `claude.ts` 的 `PRETRUSTED_BASH_TOOLS` 通配范围内，触发
  Claude Code 交互式权限提示，无人值守场景下无人应答，session 卡死直到
  harness 超时杀掉。根因：`stewardContextRefSchema`
  （`src/workspaces/steward/types.ts:119-123`）在 ledger entry 里整体是
  `.optional()`——`context`/`manifestSha256` 根本不是必填字段，下游也没有
  任何代码校验这个 hash 是否等于文件真实内容——但 Decision Ledger Shape 的
  JSON 示例把它画成扁平的"看起来必填"字段，也没说明"这个值不需要真的算"，
  agent 于是选择了它知道的唯一路径（shell 出去跑 openssl）来"认真"填这个
  字段。修补：不改 schema（本来就是 optional，改了也不解决 agent 不知道这
  件事的问题）——Decision Ledger Shape 的 JSON 示例后面新增一段说明：
  `context` 是可选记账字段，不需要算真的 sha256，直接整段省略即可；尤其明确
  禁止为了算它去调用 `openssl`/`sha256sum` 等 Bash 管道，因为那不在预信任
  工具列表里，会把无人值守的 wake 拖到超时。（harness 侧"超时后未释放账户
  锁导致下一周期连锁失败"是另一处独立的健壮性缺口，已在 issue #107 里一并
  记录，留待需要时单独处理，不阻塞这次 prompt 修补。）

- **issue #111（在 #107 修好、Phase E pilot campaign 恢复重跑时发现）**：
  bull-cx 烟雾测试 6 周全程 gross PnL 0.0%（vs buy-hold +49.2%），但 ledger
  显示 agent 在 week 1、week 5 两次都正确判断出上涨趋势并 `propose_trade`。
  现场追下去发现：agent 先用错误的 `--stopLoss` JSON key（`lmtPrice`/
  `auxPrice`）连试两次，均被 Zod 校验拒绝（真正的 key 是 `price`，见
  `src/tool/trading.ts` 的 `stopLoss` schema）；两次失败后 agent 放弃止损，
  裸下单+commit——`paper-auto-push` 的硬 guard（issue #97 的
  `missing_stop_loss` 检查）正确拒绝了这笔无止损单，从未真正推送到
  broker（I3 不变量：风控本身工作正常）。但 agent 拿到的工具返回值和写进
  ledger 的 `completion.reason`/`actions[].status: "committed"` 都读起来像
  成功——根因是 `placeOrder`/`commit` 工具的响应封装
  （`stageAndMaybeCommit`，`src/tool/trading.ts`）把 UTA 早已算好的
  `autoPush`（`PaperAutoPushResult`：pushed/skipped-with-reason/failed）
  整个丢弃，换成一句与结果无关的固定文案。修补：`stageAndMaybeCommit` 按
  `autoPush.status`/`reason` 分支返回真实结果（成功/因何种 guard 被拒/结构性
  跳过/失败），不再是一句话包打天下；Wake Loop 第 5 步新增：下单+commit 后
  必须检查返回值里的 `autoPush`，若是 guard 拒绝（如缺止损）要在本轮 wake
  内纠正重试，若截止前仍未成功执行，ledger 的 `decision` 必须诚实降级为
  `no_trade`/`blocked`，不能把一笔从未成交的单子记成 `propose_trade`/
  `status: "committed"`。

- **issue #113（在 #111 修好、Phase E pilot campaign 恢复重跑时发现）**：一次
  wake 卡死在 `alice-uta order place --commitMessage "...lock in +$543
  gain..."` 这一步——`+$543`（`$` 紧跟数字，中间无转义）触发了 Claude Code 自身
  的 "expansion obfuscation" 分类器，无人应答的交互式权限提示又一次让
  session 永久挂起。这是同一类 bug 的第三个触发点（前两次是 #91 的 ledger
  heredoc、#107 的 openssl 管道），逐条修补 `instruction.md` 已不可持续——
  free-text 字段（`commitMessage`/`thesis`/rejection reason）本质是开放式
  散文，agent 永远可能写出下一个让分类器发火的 shell 特殊字符组合。修补是结构性
  的，不再是第四次 prompt 补丁：给共享的 `alice*` CLI shim
  （`src/workspaces/cli/bin/alice-uta`，同一份代码以 `alice`/`alice-workspace`/
  `traderhub`/`alice-uta` 四个 byte-identical 副本存在，`shim.spec.ts` 守着不
  漂移）加了 `--json-file <path>` 输入模式：free-text 内容改用 Write 工具写进
  gitignored 的 `.alice/steward/tmp/`，Bash 命令本身只传一个纯文件路径，argv
  里再没有分类器能盯上的东西。Wake Loop 第 5 步同步改写：6 个携带自由文本的写
  操作命令（`order place`/`modify`/`cancel`、`position close`、
  `git commit`/`reject`）全部从裸 `--flag "..."` 改成"Write 工具写 JSON 文件
  → `--json-file <path>` 调用"两步模式；autoPush 结果检查/纠正重试的既有语义
  （issue #111）原样保留，只是把"怎么下单"换成了新的调用方式。

这六处都不改 World Boundary 的世界边界声明，也不改 Decision Ledger Shape 的
JSON 字段契约本身（#107/#111 都只是在契约之后追加使用说明，字段形状不变），也
不改 Mandate / Evidence-First / Participation Bias / Risk Discipline 这四个
§7 组件的文字——前五处纯粹是 Wake Loop 协议步骤 + Decision Ledger Shape 使用
说明的缺口修补，性质更接近"协议 bug 修复"而非"prompt substance 变更"；#113
同样不碰这四个组件和 JSON 契约，但它额外改了共享 CLI shim 的代码本身
（`--json-file` 解析逻辑），是六次里唯一一次 prompt 修补伴随了非 prompt 的代码
变更。按 §4 的漂移规则仍需在此登记，因为六次都改动了 agent 实际收到的唤醒指令
文本。

## 9. Codex core-agent smoke 运行时修补记录（2026-07-09）

本节记录一次**非 prompt substance**但会直接影响 prompt 是否被真实执行的运行时修补。
它不升 v4：`instruction.md` 的 Mandate / Evidence-First / Participation Bias /
Risk Discipline / Wake Loop / Decision Ledger Shape 均未改；变化发生在
「如何把同一份 wake prompt 交给 core-agent」和「smoke harness 如何保持对照条件」。

- **模型名真源**：用户讨论中的显示名 `GPT-5.3-Codex-Spark` /
  `GPT-5.4-Mini` 不能直接传给 Codex CLI；实测可运行 slug 是
  `gpt-5.3-codex-spark` / `gpt-5.4-mini`。`tools/campaigns/run-cell.mjs`
  增加 `--model`，写入 `.alice/steward/core-agent-model.txt`；
  `src/workspaces/adapters/codex.ts` 在每次 compose command 时读取该文件并加
  `-m <slug>`。这使 A/B 模型对照变成 workspace-local 条件，而不是全局 Codex
  配置漂移。
- **Codex 沙箱**：真实 steward 需要通过 `alice*` CLI / MCP 访问本机
  OpenAlice/UTA loopback 服务。Codex 默认沙箱下会把 `127.0.0.1:47332/47331/47333`
  挡掉，agent 会误判为 OpenAlice 不可达并写 `blocked` ledger。Codex adapter
  现在给交互式和 headless 命令都加 `sandbox_mode="workspace-write"` 与
  `sandbox_workspace_write.network_access=true`，保留 workspace 文件边界，同时允许
  loopback 工具面。
- **首次 wake 投递语义**：旧路径是「先 spawn Codex TUI，再立刻通过 PTY 写入
  wake 文本 + 回车」。在 smoke 中首次 wake 长时间停留在 `injected`，没有 ledger；
  这是 TUI 尚未 ready 时 PTY 粘贴的竞态。修补后：如果没有可复用/可 resume 的
  steward session，manual 与 scheduled wake 都把 `formatStewardWakeMessage(record)`
  作为 Codex 原生 `initialPrompt` 启动；只有已有 live/resumed session 才走
  `injectStewardWake` 的两阶段 PTY submit。
- **并发文件写**：3-cell 并行 smoke 暴露三个同型 `*.tmp -> target ENOENT`：
  auth session store、workspace registry、UTA restart flag。修补为唯一临时文件名 +
  进程内写队列；trading account config 读改写也加串行 gate，避免并发创建/编辑
  mock UTA 时互相覆盖。
- **harness restart 容错**：并行 cell 的 cleanup 会触发 UTA restart，另一 cell
  正在读 equity/positions 时可能短暂 502。`run-cell.mjs` 的 account/equity/position
  读取现在按 UTA restart 窗口重试，避免把基础设施抖动误判成 agent 行为失败。

Smoke 结论（只作为「能不能跑通」证据，不作为完整 H1/H2 统计）：Spark 与 Mini
均能完成 bull 单周 ledger；Spark 明显更快（约 50s vs Mini 约 216s）。3-cell
并行 Spark 单周：bear/chop PASS，bull 完成但 `no_trade`，说明核心设施已能支撑
对照实验；行为层是否满意仍要看后续多周、多模型完整 campaign。

## 10. v4 修补记录（2026-07-10）

2026-07-09 的 5-cell dev baseline 给出两个行为事实：第一，bull 两格都能进场但
仓位过小，H1 capture 明显不足（NVDA +3.6% vs buy-hold +57.3%；0700.HK +9.7%
vs +46.8%）；第二，low-signal chop/FX wake 中 Codex 偶发把 ledger 字段嵌错层级
或写出 schema-invalid line，agent 以为完成，supervisor 因找不到 parseable
`wakeId` marker 继续等待，最终表现为 timeout。

v4 的变更分两半：

- **[Participation sizing]** `instruction.md:72-78`：把「清晰 uptrend 必须参与」
  从方向性要求推进到尺寸语义。flat + NORMAL risk + high-conviction trend entry
  不应只是 5-10% toe-hold；在 paper/mock campaign 里通常应接近 25-60% notional，
  除非 stop 距离或证据质量不允许。意图是修 bull under-participation，但不放松
  Risk Discipline，也不允许给亏损仓摊平。
- **[Ledger self-validation]** `instruction.md:232-237` +
  `src/workspaces/templates/steward/bootstrap.mjs:54-131`：新建 steward workspace 会
  带 `.alice/steward/validate-ledger.mjs`，Wake Loop 第 6 步要求写完 ledger 后用
  `node .alice/steward/validate-ledger.mjs <wakeId>` 自检；尤其强调
  `checklist`/`thesis`/`actions`/`pendingHash`/`invalidation`/`cost` 是顶层字段，
  不能塞进 `completion`。这不改变 `stewardDecisionLedgerEntrySchema`，只是让
  core-agent 在停止前用 workspace-local 脚本验证它写出的 completion marker 会被
  supervisor 接受。

v4 full dev baseline（2026-07-10）结果：5 cells 全部完成，无 timeout，无 UTA
leak，说明 ledger marker / wake lifecycle 问题已修复；但 bull performance 仍不
达标。NVDA 从 v3/v4 早期的小仓位改善为 week2 约 35% notional 首仓，但后续强趋势
中只 hold 不 add，最终 +15.8% 仍低于 bull 验收阈值 +25%。0700.HK week2 首仓后在
正常趋势回撤中 week3 离场，最终 -2.8%，说明 agent 把 pullback 误读为 thesis
失效。SPY chop 虽仍 PASS，但 v4 的 starter sizing 让它在低波动漂移中拿了 400 股，
暴露出过度参与风险。因此 v5 不再单纯放大 starter size，而是补「盈利趋势管理 /
pullback discipline / low-vol chop filter」。

## 11. v5 修补记录（2026-07-10）

v5 只改 Participation Bias 和 Risk Discipline，不改 World Boundary、Wake Loop、
ledger shape，也不改变 UTA 硬 guards。它是在 v4 full dev baseline 后的窄幅行为
补丁：

- **[Winner management / pyramiding]** `instruction.md:79-84`：当 agent 已持有
  盈利 long 且 tape 继续确认同一 uptrend 时，不能把「已有仓位」当成完整答案；
  要重新评估当前 notional 与 benchmark / max-position guard 的关系。若当前敞口
  明显低于 guard 且 trailing stop 能控制风险，应考虑顺势加仓，而不是被动持有
  一个过小的赢家。意图：修 NVDA v4 的 week3-week6 no-add。
- **[Pullback discipline]** `instruction.md:85-89`：健康 uptrend 中的正常回撤或
  临时浮亏不等于 thesis 失效；只有预先写明的 swing/stop 被破、higher-high /
  higher-low 结构明确失败、或 risk-state block 出现时，才应 exit/trim/stand down。
  意图：修 0700.HK v4 在正常波动中被洗出。
- **[Low-vol chop filter]** `instruction.md:96-100`：低波动 drift 不等于高置信
  uptrend；使用 25-60% starter range 之前要看到 prior swing reclaim / persistent
  higher lows / range expansion / volume-or-volatility confirmation。没有这些确认时
  应小 probe 或 `no_trade`。意图：保留 v4 对 bull starter 的修复，同时不把 SPY
  这类低波动 chop 推成大仓误判。
- **[Add guard]** `instruction.md:119-121`：只允许给盈利或持平、且 thesis 仍有效
  的仓位加仓；必须先或同时 trail stop，保证合并仓位的 downside defined。意图：
  明确 v5 允许的是加赢家，不是摊平亏损仓。

v5 targeted regression（2026-07-10）失败但提供了清晰诊断：NVDA 学会了 week4
加仓，但仓位贴近 60% max-position hard guard，mark-to-market 后 week6 进入
READ_ONLY，最终 campaign 记为 0%；0700.HK 仍在 week3 pullback 中离场；SPY
low-vol chop week1/week2 过早参与。结论：v5 的方向正确但边界太软，必须显式写
guard headroom、pullback hold 条件和 low-vol drift 排除规则。

## 12. v6 修补记录（2026-07-10）

v6 是 v5 targeted failure 后的收敛补丁，仍只动 Participation Bias 与 Risk
Discipline：

- **[Starter range headroom]** `instruction.md:72-78`：把 high-conviction starter
  从 25-60% 收窄为 25-45%，避免首仓直接贴近 hard guard，为后续加仓和价格上涨留
  空间。
- **[Pyramid ceiling]** `instruction.md:79-87`：保留「盈利趋势要考虑加仓」，
  但明确不要把目标打到 hard max-position guard；60% hard guard 下，adds 通常应在
  50-55% notional 停止。意图：修 NVDA v5 的 READ_ONLY。
- **[Pullback hold threshold]** `instruction.md:88-95`：把「正常 pullback 不等于
  exit」具体化为仍在原 stop/risk budget 内、仍高于 swing support、且 adverse move
  未超过约 8% 时通常 hold/trail，而不是 full exit。意图：继续修 0700.HK。
- **[Low-vol exclusion]** `instruction.md:102-108`：1-4% 的一两周窄幅 drift 不足
  以触发 meaningful starter；需要更强的 breakout/reclaim/range/volume 证据。意图：
  修 SPY v5 的过早参与。
- **[Trim before READ_ONLY]** `instruction.md:130-132`：若浮盈把敞口推近或超过
  max-position guard，应主动 trim 回 guard 下方并保留 core trend position，而不是
  等账户进入 READ_ONLY。意图：把 UTA hard guard 前移成 agent 自己能执行的软纪律。

v6 targeted regression（2026-07-10）：NVDA 不再触发 READ_ONLY，仓位路径为 week2
266 股、week3 加到 416 股，最终 +17.0% / maxDD 0%，但仍低于 bull +25% 阈值；
SPY week1 no_trade、week2 入场，最终 -0.8% / maxDD 0.9%，仍 PASS；0700.HK week2
在识别出趋势后没有成交，原因不是趋势判断本身，而是下到了 mock 默认 `AAPL`
合约，stopLoss 以 `ASSET-K` tape 估算但被 paper policy 以 AAPL/default entry
校验，连续 rejected。后者是 campaign/contract-binding 摩擦，进入 v7。

## 13. v7 修补记录（2026-07-10）

v7 修的是回测基建与 agent 行为面之间的 contract-binding 摩擦，不是市场判断策略：

- **[Campaign wake contract binding]** `tools/campaigns/run-cell.mjs:350-359`：
  `marketContext` 新增 `tradeableAliceId: <acctId>|<codename>` 与
  `tradeableNativeKey: <codename>`，note 明确「本 wake 唯一可交易合约是
  tradeableAliceId，不要使用 blank search 返回的默认/example contracts」。
- **[Wake Loop exact aliceId rule]** `instruction.md:138-148`：Wake Loop 第 1 步
  补充：若 `marketContext.tradeableAliceId` 存在，order/position 命令必须用这个
  exact `aliceId`；除非它本身就是 wake 的 `tradeableAliceId`，否则不得用
  blank search/default/example contract（例如 `AAPL`）。意图：让 agent 的交易对象
  与 blind OHLCV tape、MockBroker injected bars、paper policy entry/stop 估算使用
  同一个 nativeKey，避免「看 ASSET-K、下 AAPL」的错位。

v7 targeted regression 先暴露了另一个并行 harness 摩擦：`run-cell.mjs` 默认在
单格结束时 cleanup workspace/account，删除 mock UTA 会触发 Guardian/UTA restart；
若其它 cell 仍在跑，它们的 MockBroker 内存仓位与 injected bars 会被重置，表现为
equity/qty 突然回到初始值。可信的并行跑法应是每个 cell 加 `--keep`，等所有
`result.json` 落盘后再统一 cleanup。`run-cell.mjs` 文件头已记录这条约束。

按 `--keep` 延迟 cleanup 重跑三格后，contract-binding 已确认修复：0700.HK week2
下到 `mock-simulator-...|ASSET-K` 并成交，不再污染到 `AAPL`。但 behavior 仍未达
bull 验收：NVDA +18.8% / maxDD 0%（仍低于 +25% 阈值），0700.HK +4.1% /
maxDD 1.7%，SPY chop -0.9% / maxDD 1.8% PASS。结论：OpenAlice 基建摩擦已进一步
剥离，下一步是 trading policy 本身的 bull participation / chop false-positive
权衡，而不是 wake/ledger/contract plumbing。

## 14. v7 完整 Spark baseline 与 shared-stack 审计（2026-07-10）

PR #122 合入 `jieke/dev@e32efb84` 后，用明确指定的
`gpt-5.3-codex-spark` 跑完 legacy + dev 共 10 个 cell、每格 6 周。正式结果为
60/60 wake `done`，没有 timeout/stuck/account-lock leak，所有实际交易都使用 wake
绑定的 exact `tradeableAliceId`，ledger/UTA/MockBroker 的 cell-end 状态一致。

行为结果不是全绿：raw verdict 7/10；排除两个在当前 guard 下无法达到 +25% 的
observation-only bull cell 后为 7/8。唯一 gateable failure 是 NVDA +17.7% / maxDD
0%，仍低于 +25% bull gate。因此 v7 **不冻结、不打开 holdout**。这保持了实验纪律：
holdout 没有参与 prompt 调参，也没有被本轮任何 agent 读取或运行。

并行压力测试还给出一个新的确定性基础设施结论：六个 workspace 同时 bootstrap 时，
Codex adapter 对共享 `~/.codex/config.toml` 做无锁、非原子的 read-modify-write，两个
独立尝试都产生 trust block 丢失/畸形 TOML，使六个 fresh session 在 week 1 全部
`stuck`。它属于 OpenAlice workspace launcher contract，跟踪于 #124；修好前不能把
shared-stack campaign 的失败归因给 Spark 或 v7 prompt。

完整矩阵、证据边界和下一 gate 见
[appendix/steward-v7-spark-baseline-20260710.md](appendix/steward-v7-spark-baseline-20260710.md)。

## 15. v8-CANDIDATE 逐组件解剖（v2 ledger contract，issue #125）

> **状态：未冻结的候选**。这是 decision-ledger schema v1→v2 落地的 prompt 半边。属实质性
> 契约变更，按 §4 规则 4 须 maintainer 批准后才升为 v8 正式版；升版前 dev matrix 必须
> 复跑（确认 bull 参与度、ledger 完成率、`propose_trade` 记账正确性不回落），holdout 保持封存。

逐组件（相对 v7）：

- **[Decision Ledger Shape · version]** `version: 1` → `version: 2`。所控：写路径严格 v2；
  读路径对 v1 历史仍宽松（v1 `actions` 保留 `unknown[]`）。关联 D2。
- **[Decision Ledger Shape · actions 类型化]** 新增 typed action 示例块与 `kind`/`aliceId`/
  `params`/`commitHash`/`outcome`/`violations` 字段说明。意图：把此前的自由文本 `actions`
  升级为可判别、可对账的结构；自由文本串在 v2 被拒。关联 D2。
- **[Decision Ledger Shape · pendingHash 严格化]** 明确 `pendingHash` 只表示「待批准 stage
  hash」，executed 后必须为 `null`，commit 出处进 `actions[].commitHash`。意图：让
  ledger↔UTA 对账退化为等值比较。关联 D1。
- **[Wake Loop step 5]** 把「record what you actually did ... and the resulting pendingHash」
  改写为「每个 broker 操作记一个 typed action，`outcome` 对应四个 `autoPush` 分支，
  `policy_denied` 附 `violations`，commit hash 进 action、executed 后 `pendingHash` 置 null」。
  意图：与 step 5 已教的 `autoPush.status` 四分支对齐，杜绝「commit 了就当成交」。关联 D1/D2。
- **[Wake Loop step 6]** 增补「每个 wakeId 恰好一条记录、first-wins、要更正原地改那一行、
  不追加第二行（重复 wakeId 是校验错误）」。意图：让 ledger 成为 tamper-evident 审计面。关联 D3。
- **[生成校验器 validate-ledger.mjs]** 由 `templates/steward/bootstrap.mjs` 生成的 workspace
  本地校验器同步升级：`version === 2`、typed-action 校验、`policy_denied⇒violations`、
  `executed⇒commitHash`、`executed⇒pendingHash===null`、重复 wakeId 报错。它是 agent 在
  wake 结尾实际运行的那一层，与服务端 zod schema（`src/workspaces/steward/types.ts`）语义对齐。

## 16. v8-CANDIDATE 逐组件解剖（participation & winner-management policy，issue #126）

> **状态：未冻结的候选，与 §15 共用同一 v8 候选版本，不各自升版**。这是 v8 候选的第二半
> （第一半是 §15 的 ledger 契约），只动 `instruction.md` 的 Participation Bias 段，不碰
> World Boundary / Mandate / Evidence-First / Wake Loop / Decision Ledger Shape / Safety，
> 也不改任何 TypeScript / UTA 硬 guard / behavior-contract 文档（契约冻结时另行更新）。属
> **实质性行为变更**，按 §4 规则 4 须 maintainer 批准后才升 v8 正式版；升版前 dev matrix 必须
> 复跑，且**任何 PR 前先跑 NVDA 验证跑作为 gate**，holdout 保持封存。

### 证据基线（issue #126，2026-07-10）

`dev-bull-nvda` cell 在 v7 冻结 prompt 下的 3 次复跑（baseline + 2 rerun，同 git/prompt/
model/guards）给出 **0/3 稳定 FAIL**：return +17.7% / +17.4% / +16.4%（spread 仅 1.3pp），
全部低于 +25% bull gate，也远低于 buy-hold +57.3% 与 guard-feasible 最优 +33.0%（week-1
full 591 股）。三处稳定行为缺口（原始证据：
`/tmp/openalice-steward-eval-20260710/nvda-rerun/{run2,run3}/`）：
(a) week-1 恒为 `no_trade`（"mixed tape / no clean trend continuation"，要等确认）；
(b) 首仓仅 24-30% equity（对 60% guard 约半仓）、加仓在 week 3-4 后停滞；
(c) run3 ledger 逐字写出自封 "50-55% exposure guidance / band" 并据此在 weeks 4-6 全程
`no_trade`（run2 类似，plateau 于 ~58%），留 8pp+ guard headroom 未用——binding constraint
是参与度而非 guard。

### 逐组件（相对 v7）

- **[Lever 1 · First-wake 参与默认]** `instruction.md:78-86`（Participation Bias「flat +
  uptrend」bullet 尾部新增）。原文只讲首仓「尺寸」（25-45% notional），不讲首仓「时机」。新增：
  当这是账户 FIRST wake、且 wake context 已显示趋势证据 + 风险预算可用时，本 wake 开首仓为
  **expected default**；延后首仓仅在 ledger thesis 写明**具体 invalidation / entry trigger**
  （某个 level reclaim 或 structure break）时才合法，不接受泛泛 "wait and see"；真无趋势时
  带 stated trigger 的 `no_trade` 仍正确。**所控行为**：week-1 恒 `no_trade` 反射。**目标指标**：
  week-1 participation rate ↑。**保留纪律**：`no_trade` 仍是合法结论（需 stated trigger），
  不与 §Low-vol chop filter（`124-130`）冲突（后者定义什么不算趋势证据）。
- **[Lever 2 · Winner 目标敞口带 + 拒绝自造软顶]** `instruction.md:92-102`（winner-management
  bullet 中段，替换 v6 的「adds 停在 50-55% notional」句）。删去 v6 的 "do not target the hard
  guard exactly ... adds should usually stop around 50-55% notional"——正是 run3 逐字援引的自封
  cap 来源。改为：趋势完好 + stop 在位时，目标 notional 约 **70-85% equity**；**确定性
  max-position guard（UTA 强制）是 exposure 的唯一硬顶**，禁止自造更低软顶（点名 "50-55%
  exposure band" 这类自封 cap 即 Mandate 警示的 under-participation 失败）；若确定性 guard 低于
  该目标带，则以 guard（非自造数字）为限，size up 至 guard。**所控行为**：50-58% 自封 plateau、
  8pp+ headroom 未用。**目标指标**：peak exposure ↑、NVDA cell return vs +25% gate。**一致性**：
  与 Risk Discipline `152-154`（MTM 推近/超 guard 则 trim 回 guard 下）不冲突——本条讲主动
  buy up 至 guard，那条讲 MTM 溢出后 trim；只有趋势完好 + stop 在位才触发，bear/chop 无 intact
  trend 故不触发。
- **[Lever 3 · 加赢家为每-wake 默认 / 持有需理由]** `instruction.md:102-109`（同 bullet 尾部
  新增）。对称化既有 Risk Discipline「禁止给亏损仓加仓」（`147-148`）：趋势完好且敞口未达
  目标带/guard 时，「每 wake 评估加仓」为 **DEFAULT action**、非例外；持有 winner 不加是合法
  决定，但须在 thesis 写明**具体理由**（敞口已达带/guard、此价位 stop 会太宽、真实 momentum
  stall），不接受 "already have a position" / "avoid unnecessary churn"（直接反驳 run2/run3
  weeks 5-6 原话）。**所控行为**：weeks 5-6 零加仓（趋势未破却停手）。**目标指标**：adds in
  weeks 4-6 ↑。**保留纪律**：仍受「只加盈利/持平且 thesis 有效仓」的既有 add guard 约束
  （`147-150`），不放开摊平亏损仓。

### 刻意不改（restraint）

- **25-45% starter range 数字不动**（`76`）：issue 观测到首仓偏小，但三条批准杠杆里没有「放大
  starter %」——首仓时机走 Lever 1、累计敞口走 Lever 2/3 的逐周加仓，starter 尺寸留原值，避免
  越出批准范围。
- **Pullback discipline / low-vol chop filter / Risk Discipline 数字（8% stop、trim-before-
  READ_ONLY）全部不动**：它们守 bear/chop cells 在 v7 的 PASS，本次只修「趋势市未用 guard
  headroom」，不是「处处更激进」。
- **Mandate / Evidence-First / Wake Loop / Decision Ledger Shape / #125 typed-action 契约与
  four-outcome 记账不动**：与 §15 的 ledger 契约、ledger 示例保持不矛盾。

## 17. v8-CANDIDATE 第三组件：degenerate-turn guard（issue #132）

> **状态：未冻结的候选**（与 §15 同批，随 v8-CANDIDATE 一起评估）。这是 #132「wake
> context governance」的 prompt 半边——另外两半（threshold session rotation、supervisor
> timeout attribution）是纯 harness 代码，不进 prompt 台账。属实质性行为约束变更（收紧
> agent 写 ledger 的工具用法），按 §4 规则 4 须 maintainer 批准后才随 v8 正式版落地；升版前
> v8 NVDA 复跑须确认 week-2 degeneration 不复现。

**根因（read-only root-cause pass, 2026-07-10）**：v8 NVDA run1 的 week-2 死于**单个退化模型
回合**——一个 271,810 字节的 `exec_command` 参数（heredoc 组装塌缩成重复循环：`while true;
do :; done` + 44,790 × `true\n`，约 68K tokens）。这一个回合 (a) 以 output-token 速度撑爆了
week-2 自己的 deadline，(b) 永久毒化了持久 session：下一次 wake 开在 `input_tokens 125,765`
vs `model_context_window 121,600`。对照组 v7-shape run2（同架构同模型）跨 6/6 wake 处理 246 万
累计 input tokens 无 timeout——horizon 结构上可survive，是退化回合杀死了这次 run。退化本身是
gpt-5.3-codex-spark 事件，无法在 OpenAlice 内彻底修复；prompt guard 只压缩其爆炸半径。

逐组件（相对 v8-CANDIDATE §15 之上新增）：

- **[Wake Loop step 6 · 命令参数尺寸纪律]** `instruction.md` step 6 在既有「用 Write/Edit 写
  ledger、不用 Bash heredoc」之上增补：ledger 对象**只能**用原生 file-write 工具组装，绝不作为
  inline shell 字符串；禁止手工搭建大参数（无巨型 heredoc body、无千行引号串）；单个 Bash 参数
  务必小——JSON 内容进你写的文件，不上命令行。意图：把「Bash 安全分类器触发」这一既有约束
  （#91 heredoc / #107 openssl / #113 free-text，见 §7 v3 修补史）推广为一条**尺寸纪律**，直接
  针对 #132 的 271KB 退化参数形态。所控：agent 组装 ledger/命令参数的方式。变更：step 6 此前只
  禁 heredoc「因为会触发安全提示」，未涉及**参数尺寸**与**退化回合/session 毒化**的因果。关联：
  不涉及 schema/不变量，属行为提示层；与 harness 侧 rotation（`src/workspaces/steward/
  rotation.ts`）+ timeout attribution（`supervisor.ts` `classifyTimeout`）互补——prompt 减少退化
  发生率，harness 兜住已发生的毒化 session（rotate）并把溢出 timeout 标注出来（attribution）。
- **[adapter 侧参数封顶：调查结论 = 无可行拦截点]** PTY 数据面对 launcher 是**不透明字节流**：
  stdin 是注入的按键、stdout 是终端回显，codex 的 tool-call 参数从不以结构化形式过 launcher。
  因此**没有**真实的 adapter 层拦截点能对单个 codex tool-call 参数尺寸封顶。#132 的 harness
  半边因此落在**回合已发生之后**的治理（rotation + attribution），而非回合内的尺寸拦截。此处
  显式记录「不建假拦截器」这一决定，避免后来者以为漏了一层。

**Harness 半边的可配置项**（供运维查阅，非 prompt 组件，纯代码不进版本台账）：
session rotation 的触发阈值走 workspace 自己的 `.alice/steward/config.json` →
`sessionRotation.threshold`（`(0, 1]` 小数，`input_tokens >= threshold ×
model_context_window` 触发 rotate；window 本身被超过时无条件 rotate）。缺省/越界值回退到
`DEFAULT_ROTATION_THRESHOLD`（当前 0.65，`src/workspaces/steward/rotation.ts`）。完整字段
说明见 [steward-persistent-loop-implementation.zh.md](steward-persistent-loop-implementation.zh.md)
§4.1、§7。PR #133 review 还修了一个发现：token-tail 的 rollout 定位此前借用
`listOnDisk` 的 2-leaf 发现窗口（为「刚 spawn 的 session」优化），对**长期存活**的 steward
session（#132 的实际目标场景）在数周/数月后会静默失效——已改为 rotation/attribution 各自的
`findCodexRolloutById`（按 id 定向、newest-first 跨月/年扫描、`maxLeaves` 兜底），并在遥测
读到 `null`（而非「adapter 压根没实现」）时发出 `steward.rotation_telemetry_unavailable` /
`telemetryWarning` 告警，使静默降级可观测。
