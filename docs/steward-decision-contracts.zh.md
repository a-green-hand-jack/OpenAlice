# Steward 决策契约设计：Decision Intent / Information Snapshot / Risk Envelope

> 版本：v0.2（2026-07-11）
> 地位：**D1 设计稿，等待 maintainer 批准**（steward-plan v2.2 §5 D1 完成门）。
> 本文只定义契约：schema、责任边界、失败语义、迁移影响。它**不授权任何 runtime 实现**；
> 实现须按 [steward-plan.zh.md](steward-plan.zh.md) §5 另行授权（D2+）。
> 从属于 [steward-plan.zh.md](steward-plan.zh.md)（方向与授权）与
> [steward-workspace-behavior-contract.zh.md](steward-workspace-behavior-contract.zh.md)（行为契约）。
> 现状事实基于 `jieke/dev@93cff812` 的代码勘察（2026-07-11）。

## 0. 三份契约解决什么问题

Plan v2 的一句话方向是：agent 负责判断与解释，UTA 负责授权、风险预算、数量约束和
broker mutation。要让这句话可执行、可评测，缺三个契约：

| 契约 | 回答的问题 | 今天的缺口 |
| --- | --- | --- |
| **Decision Intent** | agent 的判断长什么样、怎么写下来 | ledger v2 只有 `decision` 枚举 + 自由文本 `thesis`/`invalidation`，方向、目标暴露、信心、最大可接受损失都没有结构，无法喂给确定性 sizing，也无法公平评分 |
| **Information Snapshot** | agent 决策时知道什么、怎么证明 | `context-manifest.json` 只记录行为资产版本（模板/prompt/skills 的 hash），不记录行情/账户/风险/事件的 as-of 身份；决策质量评测无法回答"给定它当时知道的" |
| **Risk Envelope** | 账户允许 agent 的判断造成多大伤害 | guard 是**可选的**（`guards` 默认 `[]`，src/core/config.ts:459），没有 guard 的账户等于没有限制——违反 plan §3 不变量 3 的 fail-closed 要求 |

## 1. 设计原则

1. **演进，不推倒**。ledger v2 的严格契约（#125 三条硬规则：pendingHash 严格待批语义、
   actions 判别联合、first-wins）是刚性资产，全部保留；Intent 作为 ledger **v3** 的新增
   结构块进入，`decisions.jsonl` 仍是决策唯一真相（不变量 6 的真相分层不变）。
2. **validator 是唯一权威**。draft → `validate-ledger.mjs` → 原子提交 + finalize marker
   的写路径（#140）不变。协议层结构化输出（codex `outputSchema` / claude SDK
   `outputFormat`）只做**辅助约束和遥测**，不替代 validator——两个 driver 的能力不对称
   （字段名不同，claude 面尚未接线），权威不能建立在不对称的能力上。
3. **信封编译成 guard，复用现有执行层**。Risk Envelope 是声明式配置；UTA 把它确定性地
   编译为现有 guard 集合（max-position-size / daily-loss / max-drawdown /
   symbol-whitelist，services/uta/src/domain/trading/guards/registry.ts）。不新建第二套
   执行机制，只是把"有没有 guard"从可选变成由信封强制派生。
4. **引用与哈希，不复制数据**。Snapshot 记录输入的身份（ref + sha256 + as-of 时间 +
   freshness），不内嵌行情或账户数据本体——成本可控，且事后可验证。
5. **Fail closed**。缺 Intent 的 propose 决策、缺 Snapshot 的 Intent、缺 Envelope 的
   autonomous execution，一律拒绝并显式记录原因，绝不解释为"没有限制"。

## 2. 契约一：Decision Intent（ledger v3）

### 2.1 decision 枚举变更

```
v2:  no_trade | propose_trade | blocked
v3:  no_trade | propose_change | reduce_risk | blocked
```

- `propose_trade` 更名 `propose_change`：覆盖开仓、调仓、换仓——提案的对象是**目标暴露**，
  不是单笔订单。
- 新增 `reduce_risk`：主动降风险决策（触发失效条件、风险状态恶化时的正确输出），
  评测时与 `no_trade` 区分——"忍住不动"和"认错退出"是两种不同的纪律。
- `blocked` 保留（运行期障碍，归 protocol 层，不进决策评分）。

### 2.2 intent 结构块

v3 entry 在 v2 全部字段基础上新增 `intent` 与 `thesisDispositions` 两个顶层字段。
`intent` 在 `decision` 为 `propose_change | reduce_risk` 时 **required**，为
`no_trade | blocked` 时必须为 `null`（no_trade 的判断理由继续放 `thesis` +
`completion.reason`）；`thesisDispositions` 对所有 decision 值均可携带（§2.3 规则）：

```jsonc
{
  "version": 3,
  // ... v2 全部既有字段（wakeId, at, accountId, decision, status, completion,
  //     checklist, thesis, actions, pendingHash, invalidation, cost）...
  "intent": {
    "direction": "long",                    // long | short | flat
    "instrument": "mock-simulator-…/ASSET-A", // aliceId（回放中为匿名 codename 对应账户内标的）
    "targetExposure": { "minPct": 10, "maxPct": 15 },
                                            // 占账户 equity 的百分比区间，agent 只给区间
    "confidence": "medium",                 // low | medium | high（枚举，不给伪精度小数）
    "maxAcceptableLossPct": 2,              // 相对账户 equity；sizing 层据此反推止损与数量
    "invalidation": [                       // 至少一条；decision=propose_change 时必须
                                            //   至少含一条 price 类（sizing 反推止损的输入，§5）
      { "kind": "price_below", "value": "94.2", "note": "跌破 20 日低点则趋势论证失效" },
      { "kind": "time_expiry", "note": "两周内未突破则放弃" }
    ],
    "timeHorizon": { "unit": "week", "value": 2 },
    "evidence": [                           // 复用 completion.evidenceRefs 的 ref 语法
      { "ref": "tool:quant:rsi-sma", "note": "动量与均线多头排列" },
      { "ref": "snapshot:…#market", "note": "决策依据的行情快照分片" }
    ],
    "snapshotId": "snap:2026-07-11T14:00:00Z:…"   // 契约二的身份，required
  },
  "thesisDispositions": [                   // v3 顶层新增字段（所有 decision 值都可携带）：
                                            //   对 snapshot.history.openTheses 逐条结构化表态
                                            //   disposition: supersede | invalidate | expire | keep
    { "wakeId": "…", "disposition": "supersede", "note": "以本轮 intent 取代" }
  ]
}
```

字段语义要点：

- **agent 永远不写数量**。`targetExposure` 区间 + `maxAcceptableLossPct` 是 sizing 层的
  输入；实际 `totalQuantity` 由确定性代码算出（§5）。prompt 文本不能成为仓位上限
  （plan §3 不变量 4）。
- **`invalidation` 从自由文本升级为结构化数组**，同时保留 v2 顶层 `invalidation` 字符串
  （一句话人读版）。`price_below | price_above` 类由确定性层编译为保护单/告警（§7）；
  `thesis` 类自由文本，只能由下次 wake 的 agent 判断。**`decision = propose_change` 时
  schema 强制至少一条 price 类**——这是 sizing 层反推止损与数量的必要输入（§5），也与
  既有 paper policy 的 `missing_stop_loss` 硬检查（paper-auto-push.ts:331-338）对齐；
  `reduce_risk` 无此要求。
- **`thesisDispositions` 是 open thesis 纪律的结构化载体**（§2.3）：validator 只校验
  这个字段的覆盖性，不解析自由文本——completion 里的散文解释是给人读的，不是给
  validator 判的。
- **`confidence` 用于校准评测**（信心分桶 vs 实际结果），不是 sizing 输入的主项——
  避免"喊高信心换大仓位"的激励。sizing 层最多允许信封内的保守折减。

### 2.3 有效期与取代语义（open thesis 生命周期）

**Open thesis 的身份键是 `(accountId, instrument)`**：一个 `propose_change` intent 被
ledger 记录后，成为该账户**该标的**上的 open thesis；不同标的的 open theses 互不阻塞
（对 ASSET-B 的新提案不需要对 ASSET-A 的旧论证表态，除非本轮触碰了它）。关闭事件：

1. **被取代**：后续 entry 的 `thesisDispositions` 以 `disposition: supersede` 指向它，
   且同一 entry 携带同标的的新 intent；
2. **被失效**：后续 entry 以 `disposition: invalidate` 指向它（典型伴随 `reduce_risk`）；
3. **过期**：`at + timeHorizon` 已过。过期本身不自动关闭——**下一次 wake 必须对它给出
   disposition**（`supersede` 续期为新 intent / `invalidate` 放弃 / `expire` 确认过期
   离场），validator 强制。

**Validator 的校验是纯结构的**（不解析自由文本）：snapshot `history.openTheses` 中每个
过期的（`expiresAt` 已过）、或本轮 intent 同标的（`instrument` 相等）的 thesis，必须在
`thesisDispositions` 中恰好出现一次；`disposition: keep` 用于显式保持（未过期、非同标的
的 thesis 可省略，视为隐式 keep）；`disposition: supersede` 要求本 entry 同时携带同标的
的新 intent（结构可查）。判定所需字段（`instrument`/`expiresAt`）由 snapshot 的
openTheses 条目直接提供（§3.1），validator 不需要回扫 ledger。散文解释留在 completion，
属人读辅助，不进 validator 信任链。

**这回答了"提案对一天，后面这一天怎么调整"**：盘中保护由确定性层执行（§7），
判断层面的调整发生在下一次 wake，且 agent 被强制面对自己的旧论证，不能装失忆。

### 2.4 协议层结构化输出（辅助，非权威）

- Intent 的 JSON Schema 作为版本化工件放入 workspace
  （`.alice/steward/schemas/decision-ledger.v3.json`），context-manifest 记录其 hash。
- codex 机器面 **可以** 把它传入 `turn/start.outputSchema`
  （fixtures/schema/ClientRequest.json §TurnStartParams），claude 面对应
  `outputFormat: { type: 'json_schema', schema }`（SDK 支持但当前 driver 未接线）。
  两者都只是**减少格式重试的辅助**；draft 文件 + validator 仍是唯一完成判定。
- PTY 面（人机交互 workspace）没有协议层约束——这正是权威必须留在 validator 的原因。

## 3. 契约二：Information Snapshot

### 3.1 组成与身份

每次 wake 绑定一个 snapshot 文件 `.alice/steward/snapshots/<wakeId>.json`，
`snapshotId = "snap:" + wakeId`，整体 sha256 进入 ledger `intent.snapshotId` 可验证。
五个分类各自独立声明，**未提供必须显式说明，不能缺席**：

```jsonc
{
  "version": 1,
  "snapshotId": "snap:…",
  "wakeId": "…",
  "asOf": "2026-07-11T14:00:00Z",
  "market": {
    "provided": true,
    "refs": [ { "ref": "bar:…", "sha256": "…", "asOf": "…", "freshness": "delayed_15m" } ]
  },
  "portfolio": {
    "provided": true,
    "refs": [ { "ref": "uta:account-info:…", "sha256": "…", "asOf": "…" } ]
  },
  "risk": {
    "provided": true,
    "envelopeVersion": 3,                   // 契约三的单调版本，required（缺信封时为 null + provided:false）
    "refs": [ { "ref": "uta:risk-state:…", "sha256": "…", "asOf": "…" } ]
  },
  "events": { "provided": false, "note": "本轮未提供新闻/财报/宏观" },
  "history": {
    "provided": true,
    "openTheses": [
      { "wakeId": "…", "fingerprint": "…",
        "instrument": "…/ASSET-A",              // §2.3 同标的判定的直接输入
        "expiresAt": "2026-07-25T14:00:00Z" }   // 由 at + timeHorizon 派生，snapshot 写入者计算
    ],
    "refs": [ { "ref": "ledger:last-5", "sha256": "…" } ]
  }
}
```

### 3.2 写入者与时机（分两个最小阶段）

- **M1（快照核心）**：wake 分发器（确定性侧）在注入前写入——portfolio/risk/history 来自
  UTA 与 ledger 的即时读取，market/events 来自 selector 或回放 harness 提供的 refs。
  agent 只读。回放评测（L0–L2）天然完整：harness 就是 snapshot 的作者。
- **M2（工具回执）**：wake 期间 agent 的 checklist 工具调用由工具面追加带 as-of 戳的
  回执 ref。M2 依赖工具面改造，不阻塞 M1；M1 已足够支撑 D4 proposal-only 回放评测。

### 3.3 与 context-manifest 的分工

| 文件 | 记录什么 | 回答什么 |
| --- | --- | --- |
| `context-manifest.json` | 行为资产版本（模板/wrapper/instruction/skills/schema hash） | "它被怎样设定" |
| `snapshots/<wakeId>.json` | 本轮信息输入身份（五分类 ref+hash+freshness） | "它当时知道什么" |

两者在 ledger v3 中都被引用：既有 `context`（manifest ref）+ 新增 `intent.snapshotId`。

**顺带修正一个现存 bug**：context-manifest 的 `schemas.decisionLedger` 被硬编码为 `1`
（src/workspaces/context-injector.ts:123），而实际写入 schema 已是 v2
（src/workspaces/steward/types.ts:8）。v3 落地时该字段必须改为引用
`DECISION_LEDGER_SCHEMA_VERSION` 常量，禁止再次硬编码。

## 4. 契约三：Risk Envelope

### 4.1 schema

信封是**账户级、必填、版本化**的配置块（落点：UTA 账户配置，与 `guards` 并列；
guards 保留为高级自定义面，信封是强制底线）：

```jsonc
{
  "riskEnvelope": {
    "version": 3,                        // 单调递增；任何修改 +1
    "maxPositionPctOfEquity": 25,        // 单标的持仓上限
    "maxSingleOrderPctOfEquity": 10,     // 单笔订单上限
    "maxDailyLossPct": 5,
    "maxDrawdownPct": 10,
    "scope": { "kind": "whitelist", "symbols": ["…"] },   // 或 { "kind": "asset_class", … }
    "autonomyCeiling": "paper",          // read_only | paper | small_live | limited_autonomy
                                         //   与既有 maxAuthzLevel 合并取低
    "revoked": false,
    "revokedReason": null
  }
}
```

### 4.2 Fail-closed 语义

- **没有 `riskEnvelope` 块的账户没有 autonomous execution 资格**。paper auto-push 在
  既有 skip reasons（packages/uta-protocol/src/types/git.ts:210-219）上新增
  `risk_envelope_missing`——现状"guards 默认空数组 = 无限制"被终结。
- 信封字段全部 required；部分缺失 = 无信封。
- 回放/评测账户同样必须配信封——v8 的教训（70% exposure intent 靠测试账户碰巧有 60%
  guard 才被拦）不允许再发生。

### 4.3 编译为 guard（复用执行层）

UTA 在账户装载时把信封确定性编译为 guard 实例：
`maxPositionPctOfEquity → max-position-size (maxPercentOfEquity)`、
`maxSingleOrderPctOfEquity → max-position-size (maxOrderPercentOfEquity 选项，
guards/max-position-size.ts:16 既有能力)`、`maxDailyLossPct → daily-loss`、
`maxDrawdownPct → max-drawdown`、`scope.whitelist → symbol-whitelist`。
每个 required 字段都有既有编译目标——用户自定义 `guards` 与信封派生 guard
**并集生效、取严**（guard 管线追加不去重，registry.ts:29-50）。执行路径零新机制。

### 4.4 Revoke 语义（现状无此原语，本节新设）

勘察确认 UTA 今天没有 revoke 原语（只有 `git reject` / `human_reject` /
`discard-never-dispatched`）。设计为：

- `revoked: true` 是**单向开关**：立即把该账户 autonomous 路径的有效 authz 压到
  `read_only`（提案照常，执行冻结），并使 `envelopeVersion` +1。**压制层是共享的
  `resolveEffectiveAuthzLevel`**（packages/uta-protocol/src/types/authz.ts:53-58）——
  `min` 语义下 `read_only` 是吸收元，天然单向；且工具面裁剪同样经由有效 authz
  （config.ts:481-484），revoke 因此对执行与工具两个面统一生效。只在 auto-push 单点
  压制是不合格实现。
- **写路径不对称**：置 `true` 的合法写者是人（配置面）与 UTA 内部确定性风控路径
  （经认证的进程内转换，如连续 guard 触发策略）；置 `false` 的唯一合法写者是人，
  通过配置面。agent 的工具面没有触达该字段的任何路由（行为契约 §8 既有禁令的延伸），
  信封所在配置文件对 workspace 不可见。
- sizing 层与 auto-push 在每次执行前重读 `envelopeVersion`；版本不一致 = 世界已变，
  放弃执行并记 `envelope_version_changed`（吸收 #146 遗留的锁 TOCTOU 同类竞态语义，
  与 issue #154 的原子锁修复互补）。

## 5. 确定性 sizing 层（契约接口，不含实现）

```
输入:  Decision Intent（v3 intent 块） + Risk Envelope + 账户即时状态（equity/持仓/剩余日损预算）
输出:  SizingOutcome =
       | { kind: 'proposal', operations: Operation[], appliedCaps: […], stopLossPlan: … }
       | { kind: 'clipped',  同上 + clippedFrom: … }          // 区间被上限剪裁
       | { kind: 'rejected', code: envelope_missing | scope_violation | budget_exhausted
                                   | envelope_version_changed | reduce_only
                                   | no_priceable_invalidation, violations: […] }
```

- 数量算法要点：取 `targetExposure` 区间与信封上限的交集；用 `maxAcceptableLossPct` 与
  invalidation 的 price 类价位反推止损距离与最大数量（自然满足既有 paper policy 的
  `missing_stop_loss` / `stop_loss_too_wide` 检查，paper-auto-push.ts:306-384）；交集为空
  即 `rejected`，绝不取近似值。price 类 invalidation 由 §2.2 的 schema 规则保证存在；
  sizing 层仍作防御性检查，缺失时以 `no_priceable_invalidation` 拒绝（分层防御，
  不依赖上游校验）。
- D4 proposal-only 阶段 SizingOutcome 只入库与呈现（Inbox），不 stage 到 UTA——此阶段
  `propose_change` entry 的 `actions` 恒为空数组。D5 起才允许 stage + auto-push（各自
  另行授权）；届时 SizingOutcome 与 ledger `actions` 的回写衔接是未决问题（§10.6），
  D5 授权前必须裁决。
- agent 可以在 thesis 中解释 sizing 偏好；sizing 层对其**只读不信**。

## 6. 责任边界总表

| 步骤 | 谁写 | 权威边界 |
| --- | --- | --- |
| Snapshot 核心 | wake 分发器（确定性侧） | agent 只读；harness 在回放中充当作者 |
| Intent（draft） | agent（native Write） | 无副作用，直到 validator 通过 |
| Ledger v3 提交 + marker | `validate-ledger.mjs`（唯一 writer，#140 不变） | 决策记录的唯一真相 |
| Envelope 配置 | 人（配置面/文件），migration 框架管理演进 | agent 禁改（行为契约 §8 既有禁令） |
| Envelope→guard 编译 | UTA 装载时 | 执行期强制，LLM 不在信任链 |
| Sizing | UTA / 独立确定性模块 | 数量的唯一来源 |
| 执行与对账 | UTA（既有 mutation/durability 机制） | venue > UTA > ledger（不变量 6） |
| 终态判定 | supervisor（既有 marker 协议，#136） | 不变 |

## 7. 失败语义总表

| 失败 | 行为 | 记录 |
| --- | --- | --- |
| intent schema 不合法 | validator 拒绝 draft，wake 不能 finalize | 既有 stuck/error 路径 |
| `propose_change` 缺 intent / intent 缺 snapshotId | 同上（结构性拒绝） | 同上 |
| `propose_change` 无 price 类 invalidation | validator 结构性拒绝（§2.2 schema 规则）；漏网时 sizing 以 `no_priceable_invalidation` 拒绝 | 同上 |
| open thesis 未按 §2.3 规则表态 | validator 结构性拒绝（只查 `thesisDispositions` 覆盖，不解析散文） | 同上 |
| snapshot 文件缺失或 hash 不符 | validator 拒绝 | 同上 |
| 账户无信封 | 提案照常入 ledger；执行路径 skip | `risk_envelope_missing`（containment 证据，不是策略失败） |
| 目标区间与信封交集为空 | sizing `rejected` | `scope_violation` 等 code + violations |
| 执行前信封版本变化 | 放弃执行 | `envelope_version_changed` |
| invalidation（price 类）盘中命中 | 确定性保护单/风控执行，**不唤醒 agent 不算 agent 功过** | UTA 事件 + 下次 wake 的 history 输入 |
| open thesis 过期未处理 | validator 强制下次 wake 在 `thesisDispositions` 中显式处置 | 结构化 disposition + completion.reason 人读说明 |
| guard/policy 拒绝 | 既有 `policy_denied` 语义不变 | 评测记 containment，不给决策加分（评测真源 §6） |

## 8. 盘中与事件语义（maintainer 2026-07-11 三问的正式归宿）

1. **盘中调整**：agent 不盯盘。持仓保护 = intent 反推的止损单（既有 paper policy 已强制
   stop）+ 信封编译的账户级 guard（daily-loss / max-drawdown）。判断层调整发生在下次
   wake（§2.3 open thesis 纪律）。
2. **提案有效期**：`timeHorizon` + 三种关闭事件（supersede / invalidate / expire），
   全部 ledger 可推导（§2.3）。
3. **事件触发唤醒**：wake reason 枚举已有 `market_event | risk_event`（types.ts:31-37），
   契约层面 snapshot 必须记录触发源；**event-selector 的实现不在本设计范围**，留待
   D4 之后按需立项——契约先行，机制后置。

## 9. 迁移影响

下表是**若 v3 获批后的影响分析**，不构成任何实现工作的授权（实现按 plan §5 走 D2+ 门）。

| 面 | 变更 | 备注 |
| --- | --- | --- |
| ledger schema | v3 新增 `intent`、`thesisDispositions`、decision 枚举变更；写严格 v3，读宽松 v1/v2/v3 | `propose_trade → propose_change` 的归一化**只发生在评测/报表层**；不回写历史 |
| **完整性 fingerprint** | **必须对磁盘原始 `decision` 值计算**，禁止先归一化再投影 | `LEDGER_SEMANTIC_KEYS` 含 `decision`（ledger-receipt.ts:45）；若归一化先于投影，全部历史 v2 wake 会在 v3 上线首个 supervisor tick 触发假 `entry_mutated`（#134 误报洪水） |
| fingerprint 语义投影扩展 | `intent`/`thesisDispositions` 进入语义键需**三处同步**：ledger-receipt.ts 的 `LEDGER_SEMANTIC_KEYS`、生成式 validator 内的逐字节拷贝、golden-vector SHA（ledger-receipt.ts:30-39） | 三处不同步 = 假 corruption |
| validator（bootstrap.mjs 生成） | v3 校验 + `thesisDispositions` 覆盖性校验（纯结构，§2.3）+ snapshot 存在性/hash 校验 | 模板 refresh 机制既有；ledger 为 workspace 内小型 JSONL，扫描成本可忽略 |
| instruction.md / prompt | draft 契约段落改为 v3 | 进 prompt ANATOMY 版本台账 |
| context-manifest | `schemas.decisionLedger` 改引用常量（修硬编码 bug，context-injector.ts:123）+ 记录 intent schema 工件 hash | |
| wake envelope | v2：新增 `snapshotRef`；`expectedDecision` 枚举同步 | envelope 是 `.passthrough()`，加字段低风险 |
| 账户配置（Alice `utaConfigSchema`，src/core/config.ts，与 `guards`/`maxAuthzLevel` 并列；Alice 编写、UTA 消费） | 新增 `riskEnvelope` 块 + `risk_envelope_missing` skip reason + 信封→guard 编译器 | **持久用户状态 → 必须走 src/migrations/ 框架** |
| sizing 模块 | 新建（UTA 侧） | D2 授权后实现 |
| campaign harness / 报告 | 三栏呈现（protocol/decision/execution）；cell 账户强制信封 | 评测真源 §6/§9 已要求 |
| machine driver | （可选）outputSchema/outputFormat 接线 | 辅助性质，可后置 |
| steward-plan §6 真源表 | 本文获批后登记为"决策契约"真源（职责：三契约 schema 与失败语义；不承担：方向授权、实现细节） | 与批准动作同一 PR 处理 |

## 10. 未决问题（不阻塞批准，实现前需逐条裁决）

1. `confidence` 三档是否够校准评测用，还是需要五档。
2. `targetExposure` 是否需要支持组合级（多标的）表达，还是 D4 先限单标的。
3. M2 工具回执的实现落点（工具面 vs supervisor 采样）。
4. price 类 invalidation 编译为保护单时，MKT/STP/STP LMT 的选择规则。
5. 信封配置面与 #153（controlFace 校验配置面）是否合并为一个受校验配置加载器。
6. **SizingOutcome 与 ledger 的回写衔接**（D5 前必须裁决）：D4 阶段 `propose_change` 的
   `actions` 恒空、SizingOutcome 只入 Inbox/评测报告；D5 起确定性层的 stage/执行结果
   如何进入决策记录——写回 agent 署名的 entry 违背"validator 是唯一 writer"，另设执行
   记录面则新增一层对账。两个方向都有代价，需要 maintainer 裁决。

## 11. 变更记录

- v0.2（2026-07-11）：落实独立 critic 审查（REQUEST_CHANGES → 修订）：fingerprint 对
  原始 decision 值计算的迁移约束 + 三处同步锁（M1）；`maxSingleOrderPctOfEquity` 的
  guard 编译目标补齐（M2）；open thesis 身份键定为 `(accountId, instrument)`、
  `supersedes` 字段以顶层 `thesisDispositions` 结构化表态取代（M3）；validator 职责
  收窄为纯结构校验（M4）；`propose_change` 强制 price 类 invalidation +
  `no_priceable_invalidation` 防御码（M5）；revoke 压制层定为
  `resolveEffectiveAuthzLevel`、写路径不对称明文化；§9 明示为条件性影响分析；
  新增未决问题 §10.6（SizingOutcome↔ledger 回写衔接）。
- v0.1（2026-07-11）：首稿。基于 jieke/dev@93cff812 代码勘察 + steward-plan v2.2 +
  行为契约 v0.4 + 评测真源。等待 maintainer 批准（issue #156）。
