# Trading Agent 架构与信息流

> 状态：当前实现真源（`jieke/dev`，2026-07-11）。本文解释 trading-agent、
> OpenAlice 与 UTA 的责任边界，以及信息如何流入、动作如何流出、什么才算真实完成。
> 行为规范见 [steward-workspace-behavior-contract.zh.md](steward-workspace-behavior-contract.zh.md)，
> 市场测试分层见
> [trading-agent-runtime-and-market-testing.zh.md](trading-agent-runtime-and-market-testing.zh.md)。

## 1. 最重要的心智模型

Trading agent 不是 OpenAlice 内部一个“传入参数、返回结果”的函数。它是一个住在独立
workspace 中、运行于原生 Codex / Claude CLI 持久会话里的**常驻交易 steward**。

OpenAlice 不拥有模型推理循环。OpenAlice 负责创建和恢复会话、决定何时唤醒、提供工具、
施加权限、观察完成信号；core-agent 自己读取文件、调用 CLI、形成判断并写出决策草稿。

因此系统不是一条 RPC，而是三个相互配合的协议面：

| 协议面       | Agent 看到的形式                                            | 主要用途                                      | 主要失败模式                                         |
| ------------ | ----------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| 控制面       | PTY 中出现一段 `<STEWARD_WAKE>` 文本                        | 唤醒持久会话，告诉它本轮处理哪个 wake         | TUI 未就绪、回车被吞、会话假死、上下文溢出           |
| 工具面       | `alice` / `alice-workspace` / `traderhub` / `alice-uta` CLI | 查询市场与账户、提交交易意图、推送 Inbox      | 参数漂移、自由文本触发 shell 安全分类、返回语义丢失  |
| 状态与提交面 | `.alice/steward/` 下的 JSON / JSONL / marker 文件           | 保存 wake、历史、草稿、完成证明、锁和运行状态 | 半写、并发覆盖、错误 wakeId、历史被改、marker 不匹配 |

Claude Opus 4.8 提出的“steward 是 workspace 的居民，不是被调用的函数”是准确的；把边界
概括为“键盘 + 本地 HTTP”也抓住了主要摩擦。但从当前实现看，文件系统不是附属细节，而是
第三条正式协议面：一次 wake 的提交、完成和审计都由它承载。

## 2. 五个层次，各自负责什么

```mermaid
flowchart TB
  Trigger[Schedule / manual request / campaign<br/>future: market and risk selectors]
  Alice[OpenAlice<br/>workspace lifecycle + supervisor + tool gateway]
  Agent[Persistent native CLI session<br/>Codex or Claude = core-agent]
  Files[Steward workspace files<br/>wake + config + draft + ledger + marker]
  AliceTools[Alice domain tools<br/>market / analysis / news / inbox]
  TradingTools[Trading tools<br/>authz-gated UTA bridge]
  UTA[UTA process<br/>account truth + trading git + guards]
  Broker[Broker / paper venue / MockBroker]

  Trigger --> Alice
  Alice -->|write wake record| Files
  Alice -->|PTY inject and Enter| Agent
  Files <-->|read state; write draft| Agent
  Agent -->|alice* CLI| Alice
  Alice --> AliceTools
  Alice --> TradingTools
  TradingTools --> UTA
  UTA <--> Broker
  UTA --> TradingTools
  AliceTools --> Alice
  TradingTools --> Alice
  Alice -->|structured CLI result| Agent
  Agent -->|run validator| Files
  Files -->|matching finalize marker| Alice
```

### 2.1 Core-agent / trading-agent

- **Core-agent** 是 Codex、Claude 等通用 agent 的原生模型循环、system prompt、工具使用和
  transcript。
- **Trading-agent** 是 core-agent 加上 steward 模板、行为 instruction、skills、wake
  协议、UTA checklist、权限和 ledger 契约后的产品角色。
- 模型负责“看到了什么、如何解释、建议做什么、为什么”；它不拥有账户真相，也不拥有最终
  执行权。

### 2.2 OpenAlice

OpenAlice 是运行与上下文控制平面：

- 创建、恢复、轮换和观察持久 PTY session。
- 写 wake record，并把窄 wake 消息注入会话。
- 给每个 workspace 注入身份、instruction、skills 和 CLI 环境变量。
- 根据 workspace 与账户计算有效授权，裁剪和包裹工具。
- 运行 supervisor，管理 account lock、deadline、stuck/timeout、成本、ledger receipt
  与 finalize barrier。
- 把 agent 的 Inbox 请求写入用户可见的 Inbox。

OpenAlice 不替 agent 做交易判断，也不把 terminal prose 当作完成证明。

### 2.3 UTA

UTA 是账户和交易域的权威边界：

- broker connection、账户、持仓、订单、成交和历史。
- trading-git 的 stage / commit / reject / push 状态。
- 风险状态、paper auto-push 资格与 deterministic policy guards。
- broker mutation 的执行结果与恢复状态。

Alice 中的 `src/tool/trading.ts` 是到 UTA SDK 的薄桥，不是第二套交易领域实现。

### 2.4 Broker / venue

Broker、paper venue 或 MockBroker 是执行事实的最终来源。Ledger 说“已执行”但 broker 没有
对应结果时，ledger 是错的；不能反过来用 ledger 覆盖 venue truth。

### 2.5 Supervisor

Supervisor 是 agent 外部的观察者和生命周期裁判。它负责判断 wake 是否按协议完成、是否
超时、是否发生 ledger integrity drift，但不判断“该不该买”。

## 3. 信息如何流入 trading agent

### 3.1 身份与行为规则

Workspace 创建时，launcher 把同一份 steward instruction 写成 `AGENTS.md` 和
`CLAUDE.md`，并复制 CLI skills。它们规定：

- 你的世界是 steward workspace，不是 OpenAlice 源码树。
- 每次 wake 先跑固定 UTA checklist。
- 不得调用 `push`，不得把 commit 当成成交。
- 自由文本参数必须先用 native Write/Edit 写进 JSON，再用 `--json-file` 调 CLI。
- 决策只能写 draft，由 validator 提交 ledger。

`.alice/steward/context-manifest.json` 是这些行为输入的**版本清单**：它记录模板版本、
wrapper prompt、instruction/skill 的路径与 SHA-256、schema 版本。它目前**不包含行情、指标、
新闻或账户快照**。市场事实来自 wake envelope、campaign 文件或实时工具查询。还要注意一处
当前漂移：manifest 生成器仍声明 `decisionLedger: 1`，而实际写路径已经强制 v2；所以现阶段
instruction/skill 的哈希可用于版本追踪，但 manifest 中的 ledger schema 数字不能单独作为
运行时真相。

### 3.2 持久会话记忆

同一个 native CLI session 会跨 wake 保留 transcript。OpenAlice 优先 resume 既有 session；
当 context 接近上限或会话不可恢复时再轮换。Transcript 能帮助连续理解，但不是权威状态：
账户与成交要重新查 UTA，过去决定要重新读 ledger。

### 3.3 Wake envelope

Selector 或人工请求先让 OpenAlice 写入：

```text
.alice/steward/wakes/<wakeId>.json
```

当前 schema 的核心字段是：

| 字段               | 含义                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `reason`           | `scheduled_observe` / `market_event` / `risk_event` / `user_request` / `supervisor_recovery` |
| `accountId`        | 本轮绑定的账户                                                                               |
| `authzLevel`       | workspace 请求的授权上限                                                                     |
| `expectedDecision` | orchestrator 的评估标签，只用于审计，不是给 agent 的建议                                     |
| `marketContext`    | 本轮已整理的市场上下文；campaign 可在这里放匿名 bars 和唯一可交易合约                        |
| `riskContext`      | 本轮风险上下文                                                                               |
| `humanRequest`     | 可选的人类请求                                                                               |
| record metadata    | `wakeId`、deadline、sessionId、状态、注入与完成时间等                                        |

随后 Injector 分两次写 PTY：先写 `<STEWARD_WAKE>` 正文，等待 3000ms，再单独写 Enter。
这个延迟不是交易逻辑，而是对 native TUI 启动和 paste 识别行为的兼容。

Schema 已容纳 `market_event` 和 `risk_event`，但当前生产实现主要完成的是 schedule、手工
wake、campaign 与 supervisor recovery；自动化 market/risk selector 仍是待扩展控制面。

### 3.4 Workspace 持久文件

Agent 每轮还会主动读取：

- `.alice/steward/config.json`：账户指针、默认配置和成本预算。
- `.alice/steward/context-manifest.json`：本轮行为输入的版本与哈希。
- `.alice/steward/ledger/decisions.jsonl` 尾部：历史决策与未失效 thesis。
- campaign / workspace 额外提供的市场文件：例如 blind replay 的匿名历史 bars。

### 3.5 实时工具结果

固定 checklist 的账户、持仓、订单、风险、市场和历史由 agent 主动调用 `alice-uta` 获取。
更广的市场数据、分析、新闻和协作能力分别通过 `alice`、`traderhub`、`alice-workspace` 等
CLI 获取。稳定背景留在文件里，易变事实临近决策时重新查询。

## 4. CLI 请求实际走到哪里

Workspace 默认**不注入 MCP 配置**。Launcher 把四个 CLI shim 放进 `PATH`，并注入：

- `AQ_WS_ID`
- `OPENALICE_TOOL_URL`，或本机 Unix socket `OPENALICE_TOOL_SOCKET`
- interactive session 的 `AQ_SESSION_ID`，或 headless run 的 `AQ_RUN_ID`

因此端口 `47332` 只是兼容默认值，不是稳定架构边界。Dev/Electron 可以复用 loopback web
listener 的 `/cli`；Docker/public-web 可以使用独立 loopback gateway；本地还可以走 Unix
socket。

一次命令的真实路径是：

```text
agent shell
  -> alice-uta order place --json-file <path>
  -> shim reads JSON and POSTs {tool, args}
  -> /cli/<wsId>/uta/invoke
  -> server resolves authoritative workspace/session identity
  -> server builds authz-filtered scoped tool catalog
  -> strict Zod validation and coercion
  -> trading tool
  -> UTAAccountSDK over HTTP
  -> UTA domain
  -> broker / simulator
  -> structured result returns along the same path
```

所以这条链不是“任意 HTTP BFF 直接透传 UTA”。CLI gateway 会先决定该 workspace 能看见
哪些命令、参数是否合法、目标账户的有效权限是多少，再执行对应 tool。

Inbox 也是同一模式：agent 的主要表面是
`alice-workspace inbox push`，Alice 内部把它映射到 workspace-scoped `inbox_push` tool，并
从 URL、session/run header 绑定来源。Agent 不自行填写可伪造的 workspace identity。

## 5. 权限与执行边界

工具面把 trading tools 分为三类：

| 类别      | 例子                                                  | 规则                                     |
| --------- | ----------------------------------------------------- | ---------------------------------------- |
| Read-only | account、portfolio、orders、quote、risk、log、history | `read_only` 可见                         |
| Proposal  | place/modify/cancel、close、commit、reject            | 有效授权至少为 `paper`，并与账户类型兼容 |
| Removed   | `tradingPush`                                         | 不暴露给 workspace agent                 |

有效授权不是只信 wake 里的字符串，而是由 workspace authz 与 account
`maxAuthzLevel` 共同取保守结果。Paper/mock commit 的 auto-push 还必须满足：

- account type 确实是 paper/mock；
- effective authz 至少为 paper；
- mutation state 可执行，pending hash 没有变化；
- risk state 为 `NORMAL`；
- paper policy 通过，例如风险增加订单有合规 stop、不能给亏损仓加仓。

这意味着“agent 调用了下单命令”只表示它发起了意图，不表示成交。

## 6. 信息如何从 trading agent 流出

### 6.1 交易意图与执行结果

风险增加动作通常经历：

```text
order params JSON
  -> UTA stage
  -> UTA commit
  -> paper auto-push eligibility + guard preflight
  -> broker mutation
  -> autoPush result
```

`autoPush` 的四种 agent 语义是：

| 结果                                     | Agent 应记录的含义                           |
| ---------------------------------------- | -------------------------------------------- |
| `status: pushed`                         | `executed`；broker/simulator 已收到执行动作  |
| `status: skipped`, `paper_policy_denied` | `policy_denied`；没有执行，需记录 violations |
| `status: failed`                         | `failed`；执行链真实失败                     |
| 其他 skipped 或字段缺失                  | `awaiting_approval`；不能声称已成交          |

`pendingHash` 只表示仍在等待批准的 commit。已经 push 的 hash 应写到
`actions[].commitHash`，此时 `pendingHash` 必须为 `null`。

### 6.2 决策提交与 wake 完成

Agent 不直接编辑 ledger。当前提交协议是：

```text
native Write/Edit
  -> drafts/<wakeId>.json
  -> node .alice/steward/validate-ledger.mjs <wakeId>
  -> strict v2 schema + wake identity + prior integrity checks
  -> cross-process ledger lock
  -> temp file + fsync + atomic rename
  -> ledger/decisions.jsonl
  -> finalize/<wakeId>.json
  -> supervisor compares semantic fingerprint
  -> wake becomes done / blocked / error
```

Draft 写完不算完成，ledger 中出现一行也不一定算完成。对新 wake，只有 ledger entry 与
finalize marker 的 semantic fingerprint 匹配，supervisor 才允许 terminalize。

Supervisor 在第一次 terminal transition 时保存 ledger receipt，以后继续检查已完成条目
是否消失或发生语义修改。因为 wake、ledger、receipt 仍处于 agent 可写的同一 workspace
信任域，这套机制是 **corruption-evident**，不是 tamper-proof。真正不可由 agent 自述覆盖的
事实仍在 UTA 和 broker。

### 6.3 用户沟通与屏幕文本

- `alice-workspace inbox push`：给用户的正式异步沟通出口，可附 workspace 文档。
- PTY terminal prose：方便人观察和调试，但不是完成、交易或成交的权威证明。
- supervisor log、cost state、tool-call/audit refs：运行稳定性与成本证据。

## 7. 一次标准 wake 的完整时序

```mermaid
sequenceDiagram
  participant C as Selector / caller
  participant O as OpenAlice
  participant F as Workspace files
  participant A as Trading agent
  participant U as UTA
  participant B as Broker / simulator

  C->>O: request wake
  O->>F: create wakes/<wakeId>.json and account lock
  O->>A: PTY inject wake body, then delayed Enter
  A->>F: read wake, config, manifest, recent ledger
  A->>O: alice-uta checklist commands
  O->>U: scoped, validated, authz-gated tool calls
  U-->>O: account / orders / risk / market / history
  O-->>A: structured CLI output
  alt no trade or blocked
    A->>F: write decision draft
  else propose trade
    A->>F: write order JSON under tmp/
    A->>O: alice-uta ... --json-file
    O->>U: stage and commit intent
    U->>B: auto-push only if eligible and guards pass
    B-->>U: venue result
    U-->>O: autoPush / broker result
    O-->>A: structured CLI output
    A->>F: write decision draft with actual outcome
  end
  A->>F: run validator
  F->>F: atomic ledger write and finalize marker
  O->>F: supervisor reads entry, marker and fingerprint
  O->>O: terminalize wake, receipt, unlock, cost/audit
```

## 8. 什么是真相

发生冲突时，按以下顺序判断：

1. **Broker / venue result**：订单是否提交、成交、拒绝，最终以执行场所为准。
2. **UTA state、commit 与 mutation audit**：账户、pending、guard 和 broker carrier 的权威记录。
3. **Validated decision ledger**：agent 对本次 wake 做了什么、为什么、证据和成本是什么。
4. **Inbox 与 terminal prose**：解释和沟通，不覆盖前三层。

这四层回答的是不同问题。Ledger 是决策真相，不是账户真相；terminal prose 两者都不是。

## 9. 为什么这个系统会产生很多摩擦

这不是简单的“trading agent 与 OpenAlice 不兼容”，而是我们把一个面向人类编程工作的原生
CLI，包装成长期无人值守、可交易、可审计的 worker。每个原本由人在场吸收的小问题，都必须
变成明确协议：

| 阻抗失配                     | 具体表现                                                  | 结构性应对                                          |
| ---------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| 事件系统 vs 交互 TUI         | wake 靠 PTY 输入，Enter 可能被当作 paste                  | 分离正文与 Enter、supervisor liveness               |
| 结构化交易参数 vs shell      | thesis 中的引号、反引号、美元符号触发 Bash classifier     | native Write/Edit + `--json-file`                   |
| 多阶段执行 vs 一句“下单成功” | staged、committed、pushed、filled 被混为一谈              | 暴露 `autoPush`，typed action outcome，venue 对账   |
| LLM 宽松输出 vs 严格审计     | 字符串数字、漏字段、复制旧 wakeId                         | strict validator、有限 coercion、identity binding   |
| 持久 session vs 单轮任务     | 上下文污染、超时、恢复后状态不一致                        | transcript rotation、recovery wake、外部 supervisor |
| 文件状态 vs 数据库事务       | 半写、并发 writer、历史被改                               | 单 writer、lock、fsync+rename、marker、receipt      |
| 双实现协议                   | TS supervisor 与生成到 workspace 的 JS validator 可能漂移 | parity/golden tests 与 runtime refresh              |

这些 issue 多数在加强 agent 与基础设施之间的协议可靠性，而不是反复修同一个交易策略。
代价确实来自“模拟一个人坐在终端前”；收益则是 OpenAlice 不需要为每种 agent 能力重写模型
循环，workspace 可以隔离、迁移、并行，并继续使用原生 agent 的完整能力。

## 10. 当前仍不完整的地方

- 自动 market/risk selector 尚未成为完整生产输入面；目前主要靠 schedule、manual wake、
  campaign 和 recovery。
- `context-manifest.json` 只做行为版本追踪，还不是统一的 market/account/risk snapshot manifest。
- Manifest 生成器的 `decisionLedger` 版本仍停在 1，与当前 strict v2 writer 不一致；这是
  协议升级后留下的版本清单漂移。
- 当前 performance harness 的核心信息仍以单账户、有限 OHLCV、持仓和风险为主；新闻、宏观、
  基本面、多资产机会集和真实交易摩擦尚未系统进入每次 wake。
- Workspace ledger integrity 只能检测意外漂移，不能抵抗同一信任域内的协调篡改。更强保证
  需要把 receipt/签名或最终审计移出 agent 可写目录。
- PTY/TUI 控制面仍受不同 native CLI 版本和启动时序影响；它不是像 RPC 一样天然确定。

因此当前系统已经是一个较完整的**持久交易 worker runtime**，但还不是一个信息面完整、
事件驱动成熟、可直接放开实盘权限的 autonomous portfolio manager。

## 11. 减少摩擦的指导意见

### 11.1 总判断

当前实现的**方向是好的**，不应该因为这些摩擦退回 OpenAlice 内部自建模型循环，也不应该
让 agent 绕过 UTA 直接连接 broker。Persistent workspace、native agent CLI、独立 UTA、
无 `push` 权限、外部 supervisor、结构化 draft 和原子 ledger writer，这些边界都值得保留。

但结论也不是“保持现在的节奏继续加 issue 就可以”。系统已经从探索期进入协议收敛期：
接下来应减少依赖 prompt 和 TUI 偶然行为的补丁，把反复出现的失败类下沉为基础设施不变量，
并给 hardening 定义停止条件。否则每支持一个新 CLI、新模型或新 campaign 并发度，都会重新
暴露同一类边界问题。

### 11.2 每条协议面都要有明确 ACK

三个协议面分别定义“已收到”和“已完成”，不要让一个信号兼任两者：

| 协议面 | 已收到                                      | 已完成                                                |
| ------ | ------------------------------------------- | ----------------------------------------------------- |
| 控制面 | agent 对当前 wake 写出独立 started/ack 信号 | matching finalize marker                              |
| 工具面 | gateway 接受并校验结构化请求                | typed tool result 与 UTA/broker outcome 可对账        |
| 状态面 | draft 被 validator 接受                     | ledger 原子写入、marker 发布、supervisor receipt 保存 |

当前控制面从 `injectedAt` 直接跨到 finalize，中间没有 agent-side ACK。因此 wake 被吞、agent
尚未开始、agent 正在思考三种状态很难快速区分。一个很小的、由 validator 或专用 CLI 写入
的 started marker，可以让 supervisor 更早判断控制面故障，而不是等到 deadline。

每条命令和状态转换还应满足幂等或带 identity key：重复注入同一 wake、重复提交同一 draft、
重复读取同一 tool result，都不应制造第二笔交易或第二条 ledger entry。

### 11.3 能由基础设施执行的规则，不要长期留在 prompt

Prompt 应负责交易 mandate、证据标准和判断纪律，不应成为 transport、transaction 或 recovery
机制。判断方法很简单：如果一条 instruction 是因为 agent 曾经把格式写错、误解返回值或触发
shell/TUI 缺陷而不断加长，优先问它能否变成 deterministic enforcement。

当前已经做对的例子包括：

- 自由文本不进 argv，统一用 `--json-file`。
- `tradingPush` 从 agent tool surface 删除，而不是只写“不要 push”。
- `autoPush` 原样回传并映射为 typed outcomes，而不是让 agent 从 prose 猜是否执行。
- ledger 由 strict validator 单写，而不是要求 agent 小心追加 JSONL。

继续沿这个方向，prompt 会变短，模型差异和版本升级造成的行为漂移也会更小。

### 11.4 中期把 ledger commit point 移出 agent 可写信任域

当前 draft + generated `validate-ledger.mjs` 是正确的近期修复，但它仍有两个结构性成本：

1. Validator 代码位于 agent 可写的 workspace。
2. 同一协议同时存在于 TypeScript supervisor 和生成的 JavaScript validator，必须靠 parity
   tests 防止漂移。

更稳的中期形态是：agent 仍只用 native Write/Edit 写 draft，然后调用类似
`alice-workspace steward finalize --json-file <draft>` 的 CLI；Alice 在 workspace 外校验 wake
identity、schema、prior receipts，并持有 ledger/receipt 的权威 writer。这样可以保留原生 agent
与 JSON file 的 ergonomics，同时删除双实现和同信任域篡改问题。

在这个迁移完成前，应继续保留 golden/parity tests 和 runtime refresh，不要再增加第三个
ledger writer。

### 11.5 把行为版本栈当成一个整体发布

模型行为由 model、native CLI version、wrapper prompt、AGENTS/CLAUDE、skills、wake schema、
tool schema、validator 和 policy guards 共同决定。它们应形成一个可追溯的 behavior bundle：

- manifest 从共享常量生成真实 schema 版本，不能手写并落后于 writer；当前
  `decisionLedger: 1` 与 strict v2 的漂移应优先修复。
- 每次 campaign 报告记录整个 bundle 的 hash/version，而不只记录模型名称。
- 升级 native CLI、prompt 或 policy 后，先跑 protocol smoke，再跑 performance matrix。

否则同一个 PnL 变化无法区分是策略改进、模型升级、工具返回变化还是 ledger 记录变化。

### 11.6 基础设施验证与交易表现验证必须分开

一轮 campaign 先过 infrastructure gate，再进入 strategy/performance 评分：

```text
wake delivered and acknowledged
  -> checklist/tool path healthy
  -> no account lock or shared UTA contamination
  -> every action reconciles with UTA/broker
  -> ledger and marker integrity clean
  -> only then score participation, PnL and drawdown
```

如果 shared UTA cleanup、restart 或多个 runner 同时操作同一账户污染了结果，这一格应标为
invalid evidence，而不是拿它调 prompt。每个并行 cell 应有独立 account、workspace、runtime
root 和明确 cleanup owner；无法完全隔离时就顺序执行。

### 11.7 给 hardening 设置退出标准

Issue 数量本身不会自然归零。应定义一个基础设施 freeze gate，例如：

- Codex 与 Claude 两类 native CLI 都完成一组连续 wake，无吞输入、stuck 或 context-poisoned
  session 泄漏。
- 所有 proposal action 都能与 UTA 和 broker outcome 对账，零“committed 被误报为 executed”。
- 零 duplicate wake、ledger 半写、marker mismatch 和已完成历史静默漂移。
- 并行隔离矩阵没有共享账户、UTA restart 或 cleanup 交叉污染。
- context rotation/recovery 能在下一 wake 恢复，而不是靠人工进入 PTY 修复。
- 行为 bundle 版本完整，campaign 可复现。

达到 gate 后冻结 control/tool/state protocol 一段时间，把主要精力转向 selector、市场信息面和
交易能力；只有违反这些不变量的新证据才重新打开 runtime hardening。这样“继续执行”才有明确
终点，而不是把基础设施摩擦与策略调优永久混在一起。

### 11.8 不建议做的事

- 不要为了得到干净函数调用而重建 OpenAlice 内部 AI loop；那会丢掉 workspace 隔离和原生
  agent 能力，并重新引入已经删除的编排复杂度。
- 不要让 agent 直接持有 broker credential 或 `push` 权限来减少步骤。
- 不要把更多账户/成交真相塞进 ledger；ledger 只记录 agent 决策，UTA 和 venue 仍是权威。
- 不要用更多 prompt 段落掩盖可确定修复的 adapter、schema、transaction 或 supervisor 问题。
- 不要在共享 UTA 上并发跑无法隔离 cleanup/restart 的矩阵，然后把混杂结果当成模型证据。

## 12. 代码导航

| 问题                                | 主要实现                                                   |
| ----------------------------------- | ---------------------------------------------------------- |
| Wake 文本和 3000ms Enter            | `src/workspaces/steward/injector.ts`                       |
| Wake / ledger / marker schema       | `src/workspaces/steward/types.ts`                          |
| Workspace 行为 instruction          | `src/workspaces/templates/steward/files/instruction.md`    |
| Draft validator 与 runtime refresh  | `src/workspaces/templates/steward/bootstrap.mjs`           |
| Supervisor reconciliation           | `src/workspaces/steward/supervisor.ts`                     |
| Session 创建、恢复、轮换和定时 wake | `src/workspaces/service.ts`                                |
| CLI shim                            | `src/workspaces/cli/bin/alice-uta`（四个 binary 内容相同） |
| CLI gateway                         | `src/server/cli.ts`                                        |
| Workspace authz/tool catalog        | `src/core/workspace-tool-center.ts`                        |
| Alice 到 UTA 的 trading bridge      | `src/tool/trading.ts`、`src/services/uta-client/`          |
| Paper auto-push 与 guards           | `services/uta/src/domain/trading/paper-auto-push.ts`       |
| Alice / UTA wire shape              | `packages/uta-protocol/`                                   |
