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
| **v3** | steward **模板**唤醒指令实质内容（issue #98） | **`src/workspaces/templates/steward/files/instruction.md`**（仓库内提示词面，见 §3；文件本身即运行副本，无需另存比对拷贝） | 同左（in-repo 模板文件，wake 时逐字读取） | **已实现（本次 PR，2026-07-08）；H1/H2 campaign 复测 pending** | 首次把 v2 substance 移植进**真正被持久化唤醒机制使用**的模板（此前 v2 只活在 orchestrator 侧 `stress.mjs`，checked-in `instruction.md` 从未获得过它）；协议骨架（世界边界/唤醒循环 6 步/ledger JSON 契约）逐字保留，唯一例外是 Wake Loop 第 5 步补了一句工具选择澄清（用 Write/Edit 工具写 ledger，不用 Bash heredoc——issue #101 campaign harness 现场发现 heredoc 会撞上 Claude Code 的"expansion obfuscation"分类器卡死无人值守 wake，配合 #92 的裸 Write/Edit 授权一起解决，步骤数和 ledger JSON 契约本身不变）；新增 dual mandate + evidence-first + risk discipline + campaign §4.7 认可的「反过度参与」方向；stop-loss 风险上限收紧至 ~8%、禁止摊薄亏损仓，与 #97 硬 guards 语义对齐（软镜像，不替代）。逐组件解剖见 §7 |

> **v2 验证结果（2026-07-07，paste 模式，3 个真实牛市匿名窗口）**：H1 = NVDA 42% / TSLA 65% / AMD 43%（均 ~50%），maxDD 全 0%。对比 pilot（v1）H1 仅 7-16%——**v2 把牛市参与度提升 3-5×，同时保住 H2 纪律（回撤 0%）**。即「行情好时参与、行情差时仍不冒大险」。12-cell（含 bear/chop）将复核 v2 是否破坏 H2。

> **v3 落地状态（2026-07-08）**：`docs/steward-p3-campaign.zh.md` §4.7 记录的压测发现——v2 修好了 H1，但带来一个有界的 over-participation 代价（`sp-bear-smci` 深熊误读为可参与，两批皆 FAIL）——maintainer 拍板「硬 guards（#97）+ prompt v3 两者都上」。本次改动落地的是 prompt v3 半边：把 v2 substance + 反过度参与方向一并写入真正的仓库内模板。**尚未用新一轮 campaign 复测**（确认 smci 类场景被兜住、且 bull H1 不回落）——回归验证是下一步，不在本次改动范围内。

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
| Steward 唤醒指令（实质内容，v3 起纳管） | `src/workspaces/templates/steward/files/instruction.md` 全文（178 行）：World Boundary `7-21`、Mandate `23-40`、Evidence-First Reasoning `42-61`、Participation Bias `63-79`、Risk Discipline `81-95`、Wake Loop `97-117`、Decision Ledger Shape `119-168`、Safety `170-177` | steward workspace 唤醒时的完整行为提示。机制段（世界边界/唤醒循环协议/ledger JSON 契约）不变；v3 新增的推理与风控实质见 §7 逐组件解剖 |
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

v3 是首次把 v2 的实验性 substance 移植进**真正被持久化唤醒机制使用**的仓库内模板——此前 `instruction.md` 只有裸协议（世界边界 + 唤醒循环 6 步 + ledger JSON 契约），没有 v2 的任何推理/风控内容。协议骨架本身**逐字保留**（World Boundary、Wake Loop 的 6 步、Decision Ledger Shape 的 JSON 契约不变，`stewardDecisionLedgerEntrySchema` 未改一个字段——唯一改动是 Wake Loop 第 5 步补了"用 Write/Edit 工具、不用 Bash heredoc"的工具选择澄清，见上方状态栏说明，不算协议实质变化）；以下是新增的实质组件。

每段标注：**[组件]** 意图 / 所控行为 / 相对旧 `instruction.md` 的变更 / 关联不变量。

- **[Mandate 双目标]** `instruction.md:23-40`。"two ways to fail … equally real" —— 把「跑输牛市」与「跌市亏损」定为同等失败，直接移植自 v2 §5 的 MANDATE 段（benchmark = 简单 buy-and-hold）。意图：给 Wake Loop 第 4 步的决策提供目标框架。所控：`propose_trade` vs `no_trade` 的整体倾向。变更：旧版无任何目标/benchmark 概念——6 步协议只讲「怎么走流程」,不讲「决策该往哪个方向偏」。关联：[steward-p3-campaign.zh.md](steward-p3-campaign.zh.md) §3 的 H1（顺风参与）/ H2（逆风止损）定义。
- **[Evidence-First 先取证]** `instruction.md:42-61`。"read the tape yourself … thesis from evidence, not vibes"，并把 trend / momentum / volatility / levels / volume 五要素显式与 ledger 的 `thesis`/`invalidation` 字段绑定（"a moving-average cross, a break of a swing level, a stop getting hit"）。意图：让 `thesis`/`invalidation` 不再是任意占位文本，而是有证据锚点的字段。所控：ledger 条目里 `thesis`/`invalidation` 两个字符串字段的写法（不改字段本身，只改怎么填）。变更：旧版 ledger 契约把这两个字段列为纯字符串，无任何写法指引。关联：呼应 v2 §2 同名组件；不涉及不变量（不改 schema、不改风控权威）。
- **[Participation Bias 参与偏置 / v3 方向]** `instruction.md:63-79`。"lean OUT — and default to `no_trade` — when the evidence is unclear, weakening, or downside-leaning"，同时保留 "do not sit out a clear … uptrend"。意图：这是 [steward-p3-campaign.zh.md](steward-p3-campaign.zh.md) §4.7 发现 over-participation（`sp-bear-smci` 深熊误读为可参与、串行/并行两批皆 FAIL）之后 maintainer 拍板的「prompt v3」方向本体——此前从未成文，只存在于 §4.7 的对策记录里。所控：evidence 模糊/走弱/下行时的默认动作。变更：v2 原文只有单向的 "lean IN when evidence supports a trend"；本版补上对称的另一半（证据不清/走弱/下行时默认 `no_trade`），同时刻意**不弱化** v2 已验证的 H1 修复（保留「清晰上涨仍须参与」的偏置，防止退回 v1 式极度保守）。关联：[steward-p3-campaign.zh.md](steward-p3-campaign.zh.md) §4.7 over-participation 发现 + H2 定义的判据语义。
- **[Risk Discipline 风控收紧]** `instruction.md:81-95`。"never size a stop to risk more than roughly 8% … never add to a position that is already losing"，并显式声明 "the guards are the backstop; apply these yourself rather than relying on them to catch it"。意图：把 v2 原有的 "protective stop, trail it up" 风控语言，收紧到与 issue #97 硬 guards（`max-drawdown` / `max-position-size`）同量级的具体数字，同时把 prompt 层风控明确定位为「软镜像」而非风控权威。所控：止损比例、是否允许摊薄亏损仓。变更：v2/旧版都没有具体止损比例数字，也没有「禁止摊薄亏损仓」规则。关联：不变量 **I3**（风险机制是确定性代码，LLM 永远不在风险检查信任链上，见 [steward-plan.zh.md](steward-plan.zh.md)）——本组件不改变、不替代 I3 的分工：guards 仍是唯一权威（`services/uta/src/domain/trading/risk-state.ts`），这里只是让 agent 自身的风控直觉提前向 guards 的阈值对齐，减少被动触发 READ_ONLY 降级的次数。
