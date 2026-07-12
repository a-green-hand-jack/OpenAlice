# Steward 决策契约设计：Decision Intent / Information Snapshot / Risk Envelope

> 版本：v0.5（2026-07-12）
> 地位：**D1 契约设计 v0.2 已由 maintainer 于 2026-07-11 通过 PR #157 批准；v0.3 的
> issue #181 身份修复、v0.4 的 issue #185 `asset_class` 生产边界均由 maintainer 于
> 2026-07-12 单独裁决并授权；v0.5 的 issue #186 pre-operation Execution Record 采用
> maintainer option A**。
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
    { "wakeId": "…", "instrument": "…/ASSET-A",
      "disposition": "supersede", "note": "以本轮 intent 取代" }
  ]
}
```

`asset_class` 保留为 v3 契约词汇，但 **v3 production runtime 只接受
`scope.kind = "whitelist"`**。生产配置出现 `asset_class` 时必须以独立、可操作的
`risk_envelope_scope_unsupported` 拒绝，提示改用显式 symbol whitelist；不得把它折叠为
`risk_envelope_missing`，也不得编译为空 guard 集。canonical asset-class enum、分类来源与
guard 语义延后到 v4 mandate-matrix 设计。

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
- **`thesisDispositions` 是 open thesis 纪律的结构化载体**（§2.3）：每条必须同时携带
  `wakeId` 与 `instrument`，以免一个 portfolio wake 的多标的 thesis 发生身份碰撞。
  同一 entry 对同一个 `(wakeId, instrument)` 最多只能有一条 disposition，包括原本可省略的
  未过期、未触碰 thesis；不能同时写 `keep` 与 `invalidate` 等矛盾表态。validator 只校验
  这个字段的结构与覆盖性，不解析自由文本——completion 里的散文解释是给人读的，不是给
  validator 判的。
- **`confidence` 用于校准评测**（信心分桶 vs 实际结果），不是 sizing 输入的主项——
  避免"喊高信心换大仓位"的激励。sizing 层最多允许信封内的保守折减。

### 2.3 有效期与取代语义（open thesis 生命周期）

**Open thesis 的业务身份键是 `(accountId, instrument)`**：一个 `propose_change` intent 被
ledger 记录后，成为该账户**该标的**上的 open thesis；不同标的的 open theses 互不阻塞
（对 ASSET-B 的新提案不需要对 ASSET-A 的旧论证表态，除非本轮触碰了它）。在账户已由
ledger entry 与 snapshot 绑定的前提下，snapshot 中某条历史 thesis 的**出处地址**以及
`thesisDispositions` 对它的引用统一使用 `(wakeId, instrument)`：`wakeId` 标识产生该 thesis
的历史决策，`instrument` 区分同一个 portfolio wake 下的多个 sibling thesis。只用
`wakeId` 建索引会静默覆盖 sibling，禁止。Information Snapshot 已绑定单一账户，因此其
`history.openTheses` 对同一 `instrument` 最多只能保留一条 open thesis；既禁止重复的
`(wakeId, instrument)` 地址，也禁止不同 wakeId 同时声称同一 instrument 仍 open。关闭事件：

1. **被取代**：后续 entry 的 `thesisDispositions` 以相同 `(wakeId, instrument)` 和
   `disposition: supersede` 指向它，且同一 entry 携带同标的的新 intent；
2. **被失效**：后续 entry 以相同 `(wakeId, instrument)` 和
   `disposition: invalidate` 指向它（典型伴随 `reduce_risk`）；
3. **过期**：`at + timeHorizon` 已过。过期本身不自动关闭——**下一次 wake 必须对它给出
   disposition**（`supersede` 续期为新 intent / `invalidate` 放弃 / `expire` 确认过期
   离场），validator 强制。

**Validator 的校验是纯结构的**（不解析自由文本）：snapshot `history.openTheses` 中每个
过期的（`expiresAt` 已过）、或本轮 intent 同标的（`instrument` 相等）的 thesis，必须在
`thesisDispositions` 中按相同 `(wakeId, instrument)` **恰好出现一次**；同 wake 的另一个
instrument 不能替代这次覆盖。`disposition: keep` 用于显式保持（未过期、非同标的的 thesis
可省略，视为隐式 keep）；`disposition: supersede` 要求本 entry 同时携带同标的新 intent
（结构可查）。无论某条 thesis 是否需要显式覆盖，整个 disposition 数组都先执行
`(wakeId, instrument)` 全局唯一性检查，再执行 required-coverage 检查。判定所需字段
（`wakeId`/`instrument`/`expiresAt`）由 snapshot 的 openTheses 条目直接提供（§3.1），
validator 不需要回扫 ledger。散文解释留在 completion，属人读辅助，不进 validator 信任链。

**v3 不引入 `thesisId`**。独立稳定 `thesisId` 若未来有跨 wake、拆分/合并或非标的级 thesis
的需求，留到 ledger v4 词汇中另行设计和迁移；v3 不用临时派生 id 绕过上述复合地址。

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

Snapshot 是 account-bound：`history.openTheses` 内 `instrument` 必须唯一。因此同一 wakeId
可以合法出现多个不同 instrument（portfolio sibling），但同一 `(wakeId, instrument)` 不得
重复，同一 instrument 也不得由不同 wakeId 同时声明为 open；这两类歧义都属于 snapshot
schema 错误，不能留给 disposition coverage 猜测。

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
`scope.asset_class` 不参与 v3 production 编译，按 §4.1 的独立错误 fail closed。

信封派生的 `symbol-whitelist` 使用独立 strict 选项：`modifyOrder` 必须由当前 broker order
snapshot 将 `orderId` 绑定到明确 instrument；绑定失败或 instrument 不在 whitelist 时均在
broker dispatch 前拒绝。`cancelOrder` 是明确的保护性/降风险例外，即使 instrument 未知或
位于 scope 外也始终可用（protective operations always available）。既有用户自定义
`symbol-whitelist` 未启用 strict 选项时保持原行为，避免借 mandatory envelope 偷改高级
自定义面的兼容语义。

Strict scope 比较的不是 caller 提供的 display `symbol`，而是**broker 实际交易的身份**：
whitelist 条目在编译时与每次 place/close/modify 请求在 guard 评估前，都必须经过同一个
账户 broker 的 `resolveNativeKey → getNativeKey` 权威解析，归一为 account-bound canonical
aliceId（CCXT unified symbol、IBKR conId 等）。caller `symbol`/`localSymbol`/`conId` 与该
解析结果不一致、请求 aliceId 与最终 dispatch identity 不一致、whitelist 或请求无法解析，
均 fail closed 且零 broker dispatch。通过 guard 后交给 broker 的 Contract 也必须是这次
权威重建的 Contract，禁止检查 A、实际发送 B。

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
- “每次执行前”指**每一个 broker mutation 调用边界**，而不是一整个多操作 commit 只查一次：
  auto-push 在 Alice/UTA 共用的 accounts-config 跨进程锁内重读版本/revoked 状态，并把同一把锁
  持有到该次 broker 调用返回；所有配置 writer 也走该锁。若 dispatch 先取得锁，它可以完成，
  revoke writer 随后持久化；从持久化完成起，commit 内后续每个操作重新取锁时都必须拒绝，
  不得再产生 broker 调用。若 writer 先线性化，则当前及后续操作全部零 dispatch。

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
  `propose_change` entry 的 `actions` 恒为空数组。D5 起才允许 stage + auto-push，且仍须
  各自另行授权；本文与 issue #186 均不自动晋级 D3/D4/D5。
- issue #186 采用 option A：production integration 只把 SizingOutcome 生成的确定性
  `Operation` 交给 UTA-owned mutation capability，不接受 intent 中任何 agent-authored
  quantity。integration 在首次 operation request 前先幂等发布一份独立、不可变的 **pre-operation Execution
  Record**；该记录只保存确定性 sizing/admission 审计材料与 opaque UTA mutation
  reference/idempotency key，不写回 agent 署名的 ledger entry。
- Execution Record **不是执行结果或对账真相**：不得复制 venue outcome、order status、
  mutation lifecycle、reconciliation 或其派生状态。UTA 独占 mutation lifecycle 与执行
  结果；venue 是最终权威，真相顺序始终是 `venue > UTA > ledger`。
- 每个 operation 只能通过一个 account/workspace-bound 的 UTA-owned mutation capability。
  Alice 只可通过带 Guardian internal token 的 `UTAAccountSDK` 创建绑定 capability；SDK 从
  launcher-owned workspace registry 的受信绑定读取 authz，并通过 internal-only header 交给
  UTA。D2 mutation boundary 的 minimum 固定为 `paper`；request body 没有 authz/minimum
  字段，调用方不能降低 minimum 或用自称更高的 workspace level 提权。Alice 侧独立调用
  #185 admission check 不能替代这个边界。
- 每个 UTA operation request 必须携带 Execution Record 中同一个 `accountId`、opaque mutation
  reference、deterministic operation id、全部 expected sizing source versions，以及该 operation
  的保护计划。绑定 capability、SizingOutcome、request body、UTA route 与 response 的账户身份
  必须逐层一致；任一不一致在发布 Execution Record 或进入 fixture 前 fail closed。
  `effect=increase` 必须恰有一个 matching protection；`effect=reduce` 必须没有 entry protection，
  strict wire schema 在 UTA invocation 前再次强制该不变量。
- 锁序固定为 `TradingGit/AccountMutationCoordinator account lease → accounts-config lock →
  #185 admission → durable exact-match dedupe/payload-conflict →（仅新 invocation）fresh source
  comparison → fixture invocation`，且 accounts-config lock 保持到 invocation 返回。反向取锁
  不合法。#185 admission 对每次请求都执行；已经完成的同键同 payload 重试可直接返回
  deduplicated acceptance，即使首次成功已推进 account/risk source version。只有新 invocation
  才比较 account/risk/envelope/broker-capabilities 四个 fresh source versions；任一漂移即拒绝
  当前 operation，且该 operation 不发生 invocation。source producer 缺失或不可读同样 fail
  closed。
- 外部幂等键为 `(utaMutationReference, operationId)`；canonical payload hash 覆盖 operation
  与 protection。dedupe 进入 TradingGit/AccountMutationCoordinator 已有的持久 mutation
  envelope + commit audit，不建 sidecar。相同键 + 相同 hash 返回 deduplicated acceptance；
  相同键 + 不同 hash 拒绝。durable `dispatching` 后崩溃进入既有 recovery，永不自动重放。
  invocation 后 HTTP acknowledgement 丢失时重试复用同一 pair，UTA 不得重复调用。
- D2 concrete capability 的 operation producer 是 UTA manager 注入的 fixture；production 未
  配置 producer 时 fail closed。本项不接实际 broker/demo/paper/live dispatch。这里也不声称
  Alice→UTA 网络往返具有原子性；保证只覆盖上述 UTA-owned lease/lock 边界。
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
| Pre-operation Execution Record | Steward 确定性 integration（幂等、不可变、独立于 decision ledger） | 只作 sizing/admission 审计并保存 opaque UTA reference；每个 UTA request 机械复用该 reference；不承载 mutation lifecycle、venue outcome 或 reconciliation |
| Operation admission + invocation | account/workspace-bound UTA mutation capability | internal-token SDK binding + trusted workspace authz + fixed `paper` minimum；increase request 携带 matching protection；mutation lease 后取 config lock；TradingGit 持久幂等/recovery |
| 执行与对账 | UTA（既有 mutation/durability 机制） | venue > UTA > ledger（不变量 6） |
| 终态判定 | supervisor（既有 marker 协议，#136） | 不变 |

## 7. 失败语义总表

| 失败 | 行为 | 记录 |
| --- | --- | --- |
| intent schema 不合法 | validator 拒绝 draft，wake 不能 finalize | 既有 stuck/error 路径 |
| `propose_change` 缺 intent / intent 缺 snapshotId | 同上（结构性拒绝） | 同上 |
| `propose_change` 无 price 类 invalidation | validator 结构性拒绝（§2.2 schema 规则）；漏网时 sizing 以 `no_priceable_invalidation` 拒绝 | 同上 |
| open thesis 未按 §2.3 规则表态，或 disposition 的 `(wakeId, instrument)` 不匹配 | validator 结构性拒绝（只查 `thesisDispositions` 结构与覆盖，不解析散文） | 同上 |
| snapshot 文件缺失或 hash 不符 | validator 拒绝 | 同上 |
| 账户无信封 | 提案照常入 ledger；执行路径 skip | `risk_envelope_missing`（containment 证据，不是策略失败） |
| 目标区间与信封交集为空 | sizing `rejected` | `scope_violation` 等 code + violations |
| 执行前信封版本变化 | 放弃执行 | `envelope_version_changed` |
| UTA operation boundary 发现任一其他 sizing source version 变化 | 放弃当前 operation，零 invocation | `source_state_changed` + changed source keys |
| UTA fixture/source producer 未配置或 source version 无法读取 | 放弃当前 operation，零 invocation | `mutation_capability_unavailable` / `source_state_invalid` |
| capability / SizingOutcome / request / route 账户身份不一致 | 发布 Execution Record 或 fixture invocation 前拒绝 | `account_identity_mismatch`（HTTP route/body mismatch 为 400） |
| 相同外部幂等键出现不同 operation/protection hash | 拒绝，不覆盖既有记录 | `idempotency_conflict` |
| durable `dispatching`/`uncertain` 或 mutation state 无法确认 | fail closed，不重放 | `mutation_recovery_required`，沿用 TradingGit 人工恢复路径 |
| UTA invocation 后 acknowledgement 丢失 | caller 以相同 `(utaMutationReference, operationId)` 重试；UTA 去重 | Execution Record 不写入或推断 mutation 结果 |
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
| ledger schema | v3 新增 `intent`、`thesisDispositions`、decision 枚举变更；每条 disposition 必填 `(wakeId, instrument)`；写严格 v3，读宽松 v1/v2/v3 | `propose_trade → propose_change` 的归一化**只发生在评测/报表层**；不回写历史 |
| **完整性 fingerprint** | **必须对磁盘原始 `decision` 值计算**，禁止先归一化再投影 | `LEDGER_SEMANTIC_KEYS` 含 `decision`（ledger-receipt.ts:45）；若归一化先于投影，全部历史 v2 wake 会在 v3 上线首个 supervisor tick 触发假 `entry_mutated`（#134 误报洪水） |
| fingerprint 语义投影扩展 | `intent`/`thesisDispositions` 进入语义键需**三处同步**：ledger-receipt.ts 的 `LEDGER_SEMANTIC_KEYS`、生成式 validator 内的逐字节拷贝、golden-vector SHA（ledger-receipt.ts:30-39） | 三处不同步 = 假 corruption |
| validator（bootstrap.mjs 生成） | v3 校验 + `thesisDispositions` 覆盖性校验（纯结构，§2.3）+ snapshot 存在性/hash 校验 | 模板 refresh 机制既有；ledger 为 workspace 内小型 JSONL，扫描成本可忽略 |
| instruction.md / prompt | draft 契约段落改为 v3 | 进 prompt ANATOMY 版本台账 |
| context-manifest | `schemas.decisionLedger` 改引用常量（修硬编码 bug，context-injector.ts:123）+ 记录 intent schema 工件 hash | |
| wake envelope | v2：新增 `snapshotRef`；`expectedDecision` 枚举同步 | envelope 是 `.passthrough()`，加字段低风险 |
| 账户配置（Alice `utaConfigSchema`，src/core/config.ts，与 `guards`/`maxAuthzLevel` 并列；Alice 编写、UTA 消费） | 新增 `riskEnvelope` 块 + `risk_envelope_missing` skip reason + 信封→guard 编译器 | **持久用户状态 → 必须走 src/migrations/ 框架** |
| sizing 模块 | 新建确定性 sizing core | D2 单独授权；agent quantity 不进入 operation |
| sizing integration / Execution Record | 独立幂等发布 pre-operation record；每个 deterministic operation 连同 accountId、matching protection、同一 opaque reference 和 expected source versions 交给 internal-token SDK 绑定的 UTA capability | capability/outcome/request/route 账户必须一致；body 无 authz/minimum；UTA 固定 `paper` minimum；锁序为 mutation lease→config lock→admission→durable dedupe/conflict→仅新调用 source compare→fixture；TradingGit mutation envelope/commit audit 持久 dedupe + recovery；无 fixture producer时 fail closed；record 禁止复制执行结果、生命周期与对账状态 |
| campaign harness / 报告 | 三栏呈现（protocol/decision/execution）；cell 账户强制信封 | 评测真源 §6/§9 已要求 |
| machine driver | （可选）outputSchema/outputFormat 接线 | 辅助性质，可后置 |
| steward-plan §6 真源表 | 本文获批后登记为"决策契约"真源（职责：三契约 schema 与失败语义；不承担：方向授权、实现细节） | 与批准动作同一 PR 处理 |

## 10. 未决问题与已裁决项

1-5 仍是后续对应实现前的授权问题；第 6 项已由 maintainer 在 issue #186 裁决。

1. `confidence` 三档是否够校准评测用，还是需要五档。
2. `targetExposure` 是否需要支持组合级（多标的）表达，还是 D4 先限单标的。
3. M2 工具回执的实现落点（工具面 vs supervisor 采样）。
4. price 类 invalidation 编译为保护单时，MKT/STP/STP LMT 的选择规则。
5. 信封配置面与 #153（controlFace 校验配置面）是否合并为一个受校验配置加载器。
6. **已裁决（v0.5，maintainer option A）：SizingOutcome 与 ledger 的衔接。**
   不回写 agent 署名的 decision entry；另设独立、不可变、幂等的 pre-operation Execution
   Record，只记录确定性 sizing/admission 审计材料与 opaque UTA mutation reference。
   Execution Record 不吸收 stage/dispatch 结果，不复制 UTA mutation lifecycle、venue
   outcome 或 reconciliation。执行与对账仍由 UTA 独占，权威顺序为
   `venue > UTA > ledger`。这项裁决只关闭记录边界问题，不构成 D3/D4/D5、scheduler 或
   实际 dispatch 授权。

## 11. 变更记录

- v0.5（2026-07-12）：记录 issue #186 maintainer option A：SizingOutcome 通过独立、
  不可变、幂等的 pre-operation Execution Record 衔接审计面；record 保存确定性
  sizing/admission 证据与 opaque UTA mutation reference，不回写 agent decision entry，
  不复制 venue outcome、order status、UTA mutation lifecycle 或 reconciliation，保持
  `venue > UTA > ledger`。production integration 仅接受 SizingOutcome 的确定性 operation；
  每个 operation 只交给 account/workspace-bound UTA mutation capability。UTA 从受信绑定
  读取 workspace authz、固定 `paper` minimum；body 没有可调 authz/minimum。increase request
  必须携带 matching protection，reduce request 禁止 entry protection；request 身份新增 required
  `accountId`，并在 capability/outcome/request/route/response 各边界机械核对。锁序固定为
  TradingGit mutation lease→accounts-config lock；UTA 在持锁边界内先执行 #185 admission，再由
  TradingGit mutation envelope/commit audit 持久去重/冲突检查 `(utaMutationReference,
  operationId)`，仅新 invocation 才比较全部 fresh sizing source versions，payload hash 同时覆盖
  operation + protection。已完成的同键同 payload lost-response 重试即使 source 已推进仍可去重；
  跨独立 Node 进程、真实 `data/trading/<account>/commit.json` 的并发/崩溃测试证明该顺序与恢复。
  相同键不同 hash 拒绝；durable dispatching/uncertain 沿既有 recovery 路径且不重放。
  record 与所有 request 机械复用同一 opaque reference；acknowledgement 丢失时以同一 pair
  重试，record 仍不复制 UTA lifecycle/result。D2 operation producer 仅为 manager-injected
  fixture，production 缺失时 fail closed；不接实际 broker。本文不声称 Alice→UTA 往返原子，
  只约束 UTA-owned lease/lock 边界。portfolio 保持 proposal-only，增加
  exposure 的 operation 继续强制结构化保护单。本版不授权 D3/D4/D5、scheduler、实际
  dispatch、prompt、campaign、paper 或 live 行为。
- v0.4（2026-07-12）：记录 issue #185 maintainer option A：v3 contract 继续保留
  `asset_class` scope，但 production admission/guard 编译只接受 whitelist；asset-class
  输入以 `risk_envelope_scope_unsupported` 独立拒绝并保持零 dispatch，禁止静默当作 missing
  或空 guard。补记 envelope-derived whitelist 的 strict operation rule：未知/越界
  `modifyOrder` fail closed，`cancelOrder` 作为保护性操作始终可用；legacy custom guard
  默认不变；strict 比较统一改为 broker 实际交易的 canonical identity，caller alias 漂移与
  检查/dispatch 身份漂移均零 dispatch。补记每个 broker 调用在共享 accounts-config 锁内
  重读版本/revoke 的线性化顺序，多操作 commit 必须逐操作复查。asset-class enforcement
  延后到 v4 mandate-matrix。
- v0.3（2026-07-12）：修复 issue #181 揭示的 portfolio thesis 身份碰撞：保持 open thesis
  业务键 `(accountId, instrument)` 不变，为 `thesisDispositions` 增加 required `instrument`，
  snapshot→disposition 覆盖与查找统一按 `(wakeId, instrument)`，明确禁止 wakeId-only 索引；
  snapshot 同时拒绝重复复合地址与账户内重复 instrument，disposition 在 coverage 前全局拒绝
  重复复合地址（包括 optional thesis 的矛盾表态）。独立 `thesisId` 延后到 ledger v4 词汇，
  v3 不引入临时 id。同步修订 Wave 0.5 proof 的 portfolio sibling 对抗样例；不改变 D2/D3
  授权或任何 runtime/prompt 行为。
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
