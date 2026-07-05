# Steward P3 设计稿 — 渐进授权阶梯

> 版本：草案 v0.1（2026-07-05）
> 地位：**设计稿**，从属于 [steward-plan.zh.md](steward-plan.zh.md) v1.0 冻结计划的 P3。
> 冻结计划 P3 明确要求：**"实现前先出一页设计稿给用户过目"**、**"设计稿经用户批准后才动工"**。本文就是那页设计稿。**maintainer 批准前不写任何实现代码。**
> 用法：maintainer 直接在文中批注（`>` 引用块），orchestrator 内联答复并升版本号；§8 的待决问题是本稿的核心，请优先裁决。

---

## 1. 目标与它必须服从的不变量

把今天的**二元开关**（`allowAiTrading` 默认 false，一刀切）升级为 Steward 的**四档授权阶梯**，并能按 workspace 裁剪 agent 实际拿到的工具面。这是全行业无先例的自建部分（调研结论），设计风险最高。

绑死它的不变量（来自冻结计划，任何设计不得违反）：
- **I1 保守默认不可弱化**：新 workspace 默认最低档；keyless⟹readOnly 等既有行为只能加强。
- **I2 授权单向性**：授权只能由人经 UI 显式放宽；系统/agent 侧的自动变化只允许**收紧**（P1 降级、锁定、HALT），永不自动放宽。
- **I3 风险机制是确定性代码，LLM 永不在信任链上**：这条直接决定了 §5 的核心架构决定。
- **I4 全程可审计**：每次授权档变更入 P2 审计链（approver 身份 + 事件）。
- **I7 持久状态走 migrations**；**I9 paper 优先**。

---

## 2. 命名决定（避坑）

代码里 **`tier` 已被占用**：`UTATier = 'data' | 'account' | 'trading'` 是 broker 连接**能力档**（keyless=data / 只读=account / 可写=trading，见 `UnifiedTradingAccount.ts:336`、`packages/uta-protocol/src/types/broker.ts:413`）。

⟹ P3 的授权阶梯**不复用 `tier`**。本稿用**「授权档 / authz level」**，代码里建议命名 `authzLevel`（或 `grant`），四个取值：`read_only` / `paper` / `small_live` / `limited_autonomy`。与 `UTATier` 是正交的两个轴——`UTATier` 是"这个 broker 连接能做到什么"，`authzLevel` 是"我们准许这个 workspace 的 agent 做到什么"。

---

## 3. 四档定义（冻结计划已定四档名，本表定其语义）

| 授权档 | agent 可见的工具面 | 执行方式 | 账户类型 |
|---|---|---|---|
| **read_only** | 行情/新闻/分析/`riskStatus` + 只读交易查询（account/positions/orders）。**无 stage/commit/任何写工具** | 无 | 任意（含实盘，只读） |
| **paper** | 上一档 + `stage`/`commit`（带 thesis） | 人工 push（现有审批门不变） | **仅 paper/mock 账户** |
| **small_live** | 同 paper | 人工 push **逐笔**（审批门不变）+ **UTA 侧硬金额上限**（单笔 + 单日，人批准也拒超限） | 实盘账户 |
| **limited_autonomy** | 同 paper（**agent 工具面与 paper 相同——关键，见 §5**） | **UTA 侧确定性 auto-push**：预算内免逐笔人工审批；P1 降级即刻失效 | 先 paper（I9），达标后实盘 |

读法：授权档从上到下单调放宽，每一档都是前一档的超集加一点新能力。**注意 paper 与 limited_autonomy 的 agent 工具面完全相同**，区别只在 UTA 侧那条 auto-push 通道开不开——这是 §5 的设计核心。

---

## 4. 双维模型：账户上限 × workspace 授权档

冻结计划已定维度是**账户 × workspace**。具体：

- **账户侧**存一个 `maxAuthzLevel`（该账户允许的最高档）——落在 `utaConfig`（每账户，P1 的风险阈值也在这里）。
- **workspace 侧**存一个 `authzLevel`（该 workspace 内 agent 实际拿到的档）。
- **有效档 = min(账户上限, workspace 档)**。二者取严。默认新 workspace = `read_only`（I1）。

举例：账户上限 `small_live`，workspace 档 `paper` → 有效 `paper`；反过来 workspace 想要 `limited_autonomy` 但账户上限只到 `small_live` → 有效被账户钳到 `small_live`，workspace 无法越过账户上限自我放宽。

> **安全要点（已定，非待决）**：workspace 的 `authzLevel` **绝不能存在工作区 git 仓库内的 `.alice/workspace.json`**（`workspace-metadata.ts:13`）——那个文件在 agent 的 checkout 里，agent 能改它，等于能给自己提权，直接违反 I2。workspace 授权档只能存在 **launcher 侧的注册表**（`AQ_LAUNCHER_ROOT/state`，由 Alice 进程控制，不在任何 agent 的 checkout 里）。这条是硬约束。

---

## 5. 核心架构决定 D1 — limited_autonomy 怎么做到"免逐笔审批"而 LLM 不进信任链

这是全稿最重要、也最需要 maintainer 拍板的一条（§8 的 D1）。

**问题**：`limited_autonomy` 要让 agent 的提案在预算内**自动成交、无需人**。但今天 push 是**人类专属 HTTP 路由**，`allowAiTrading` 默认 false，agent 没有任何触 broker 的路径。怎么在不给 agent 一把 push 工具的前提下实现自动执行？

**推荐方案（保持 I3）**：**不给 agent push 工具。** agent 的工具面在 `limited_autonomy` 下与 `paper` 完全相同——仍然只能 `stage`/`commit`。真正的自动执行由 **UTA 侧一个确定性的 auto-push 组件**完成：每当有一笔 commit 落地，auto-push 在 UTA 内部对照**预算信封**（预先由人批准）判定——

- 单笔金额 ≤ 单笔上限？
- 累计（会话/当日）+ 本笔 ≤ 预算？
- 标的 ∈ 白名单？
- 当前 P1 风险状态 = NORMAL（非 CAUTIOUS/READ_ONLY/HALT）？

全部满足 → auto-push 走**与人工 push 完全相同的 guards 管道 + 风险状态机**执行；任一不满足 → 留在审批门排队等人（退回 small_live 行为）。

**为什么这样对**：
- LLM 永不拿 push 能力，永不在信任链上（I3）。它能影响的只有"提议什么"，能不能执行由 UTA 的确定性代码根据人预先批准的预算信封决定——**"bot 不可信,笼子可信"**。
- 预算信封本身是**人经 UI 设定的**（I2 放宽由人），auto-push 只在信封内放行；超信封自动收紧回人工（I2 收紧永远有效）。
- P1 降级立刻让 auto-push 失效(风险状态检查是 auto-push 的前置条件之一)，无需额外接线——这正好满足 P3 验收标准第四条。

**这也顺带回答了 maintainer 在演习一批注里问的矛盾**：常规小额再平衡在预算内自主跑（不占用人的注意力），大动作/超预算才排队人工审——"加风险要等人,去风险不等人"在这一档成为可运行的制度，而不是靠模型自觉。

---

## 6. 落点（enforcement points，供实现参考，非最终行数）

| 关注点 | 落点 | 说明 |
|---|---|---|
| 工具面裁剪 | `core/workspace-tool-center.ts`（每 workspace `/mcp/:wsId` 面已存在）+ `claudeCode.allowedTools/disallowedTools`（`config.ts:225`，已定义未接线）作为 claude 适配器侧的第二道 | 按有效授权档过滤该 workspace 能见的工具集 |
| 账户上限 `maxAuthzLevel` | `utaConfig`（每账户）+ `@traderalice/uta-protocol` 加**可选**字段 | 走 migrations（I7），默认取账户当前等价档 |
| workspace 授权档 | launcher 注册表（`AQ_LAUNCHER_ROOT/state`，**非** `.alice/`） | §4 安全要点 |
| small_live 金额上限 | UTA push 管道内新增一个确定性 gate（单笔 + 单日，人批准也拒超限） | 与 P1 guards 同层，确定性代码 |
| limited_autonomy auto-push + 预算 | UTA 侧新组件（§5），预算花费持久化（重启存活） | 预算重置边界建议复用 DailyLoss 的 UTC 边界 |
| 授权档变更 | 人类专属 HTTP 路由，仿 `/uta/:id/risk-state`（`routes-trading.ts:256`）| 只人工放宽；变更发 P2 `authz.level-changed` 事件入审计链（I4）|

---

## 7. 拆分与验收映射（批准后才开 issue）

初步设想拆 4 个 issue（顺序执行，各走标准流水线）：

1. **P3-1 授权档模型 + 工具面裁剪**：authzLevel 枚举 + 双维 min + workspace-tool-center 裁剪 + read_only/paper 差异。→ 验收标准②（两个 workspace 工具面差异可证明）。
2. **P3-2 授权档变更路由 + 审计**：人工专属变更路由 + `authz.level-changed` 事件（复用 P2 approver 身份）+ migrations + 默认 read_only。→ 验收标准⑤（提升留痕可查）。
3. **P3-3 small_live 硬金额上限**：UTA push 管道单笔/单日上限 gate。→ 验收标准③（超限 push 即使人工批准也拒）。
4. **P3-4 limited_autonomy auto-push + 预算信封**（§5）：UTA 侧确定性 auto-push + 预算持久化 + P1 降级即失效。→ 验收标准④。

（冻结计划 P3 验收标准原文见 steward-plan.zh.md，此处仅映射，不改动。）

**e2e 演习**：仿 P2 的两次演习——真实 agent 在 `read_only` 与 `paper` 两个 workspace 里各跑一遍证明工具面差异；`limited_autonomy` 指向 **paper 账户**（I9）证明预算内自主成交、触发 P1 降级后即刻失效。

---

## 8. 待决问题（请 maintainer 裁决 —— 这是本稿要你过目的核心）

- **D1（最重要）**：§5 的方案——`limited_autonomy` 的自动执行用 **UTA 侧确定性 auto-push，agent 永不拿 push 工具**。批准这个方向吗？（替代方案是给 agent 一把受预算约束的 push 工具，但那会把 LLM 放进信任链，我不推荐，违反 I3。）
- **D2**：`paper` 档的执行——建议**仍走人工 push**（自主性归 `limited_autonomy`；"paper 上测自主"= 用 `limited_autonomy` 指向 paper 账户）。同意，还是希望 paper 档本身就允许 auto-push（因为是虚拟钱）？
- **D3**：`limited_autonomy` 预算的重置边界——建议复用 P1 DailyLoss 的 **UTC 日界**（跨 venue 一致）。同意，还是要"会话预算"（每次 headless run 重置）或两者叠加？
- **D4**：授权档命名——`read_only` / `paper` / `small_live` / `limited_autonomy`（冻结计划已给这四个名）。代码里的字段名用 `authzLevel` 还是别的（`grant` / `autonomyLevel`）？只要不撞 `tier`。
- **D5**：工具面到授权档的精确映射（§3 表是初稿）——比如 `read_only` 到底能不能看 `stage` 的**只读预览**、`riskStatus` 归哪档，等细节。批准后我在 P3-1 里定一张精确的 工具→档 映射表再给你过一眼，还是现在就要逐条定？

---

## 9. 范围外（冻结计划已排除，本稿不碰）

- 多用户/角色分离（单 operator 模型不变）。
- `/mcp` 全局面的认证改造（属安全加固不属阶梯本身，另开 issue）。
- 自动放宽授权档（永久 out，I2）。

---

## 10. 与冻结计划的关系

P3 的四档、双维、落点方向均**遵循**冻结计划 P3 的已定关键设计决定，本稿只是把它们细化到可实现粒度并补齐待决问题。不改动冻结计划任何条目，不升 steward-plan 版本号。若 §8 的裁决动摇了某条已定决定，按变更管理节处理（暂停 + 带证据裁决 + 升版本）。
