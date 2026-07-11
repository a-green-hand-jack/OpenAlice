# Steward Agent 观察面 —— 回测 / live 分别看到什么

> **归档状态（2026-07-11）**：blind replay 阶段的历史观察面。当前信息流和评测输入分别见
> [../../trading-agent-architecture.zh.md](../../trading-agent-architecture.zh.md) 与
> [../../trading-agent-runtime-and-market-testing.zh.md](../../trading-agent-runtime-and-market-testing.zh.md)。

> 版本：v0.2（2026-07-08）——对齐 #66 已落地后的代码现实：盲化封印已在
> `workspace-tool-center` 上线，且 trading 市场数据工具的 HIGH bypass 已补。
> 版本：v0.1（2026-07-07）
> 地位：**概念/方法论文档**，从属于 [steward-plan.zh.md](steward-plan.zh.md)（I1–I9 不变量）。
> 记录 agent 的**观察面**——它在盲化回测 / 普通 paper / live 三态下分别能看到哪些信息、
> 分为哪几类、由哪段代码裁剪。观察面既决定判断质量，又是反作弊的**唯一物理防线**
> （不变量「富信息但不泄漏」落地在此）。与 [working-modes](steward-agent-working-modes.zh.md)
> 互补：那份是「怎么处理」（决策侧），本份是「看到什么」（输入侧）。
> 用法：改动工具面 / 授权裁剪 / 盲化封印时同步更新本文件；涉及代码结构须按下方
> §6 与 [ANATOMY 漂移规则](../../../ANATOMY.md) 同步码侧锚点。
>
> 关联：[steward-prompt-anatomy.zh.md](../../steward-prompt-anatomy.zh.md)（§3 工具描述串——观察面的「how」侧）、
> [steward-p3-campaign.zh.md](steward-p3-campaign.zh.md)（§4.3 匿名化对策）、
> [src/ANATOMY.md](../../../src/ANATOMY.md)（工具层代码锚点）。

## 1. 先纠正一个直觉：市场观察不由 paper-vs-live 决定

paper 账户看到的行情与 live **是同一批真实 vendor 数据**——市场观察工具打的都是真实 vendor，与账户是模拟还是实盘无关。真正让 agent「看不见真实世界」的**只有盲化封印**（`blind`，#66），那是**回测战役专属的构造**，不是 paper 属性。paper-vs-live 在账户/执行层的唯一区别是：连的是 mock broker 还是真 broker、commit 是否自动成交（paper 自动 `via:auto-push-paper`，live 永不自动、必须人批）。

因此真正的分界是**三态**：① 盲化回测（现在跑的战役）、② 普通 paper 回测（不盲）、③ live。

## 2. 信息五类（按工具组 + 代码锚点）

| 类 | 工具组 | 代表工具 | 代码真源 |
|---|---|---|---|
| **A. 行情/量价** | quant, snapshot, market-board, market-search | `bars` `searchBars`（原始 OHLCV）、`marketSnapshot`、`marketGetBoard`、`marketSearchForResearch` | `src/tool/quant.ts:15-70`、`src/tool/snapshot.ts`、`src/tool/reference-board.ts`、`src/tool/market.ts` |
| **B. 分析/指标** | analysis, quant | `calculateIndicator`（TA 指标）、`calculateQuant`（量化脚本） | `src/tool/analysis.ts:36`、`src/tool/quant.ts:42` |
| **C. 基本面/衍生/宏观** | equity, etf, indices, derivatives, economy | 股票基本面（profile/financials/ratios/earnings/insider/short-interest/estimates）、ETF、指数、加密期权期货、~20 个 FRED/BLS/能源/CPI/利率/FOMC/美联储资产负债表 | `src/tool/{equity,etf,indices,derivatives,economy}.ts` |
| **D. 新闻/事件** | news, rss | RSS 收集 + 归档检索 | `src/tool/news.ts`、`src/domain/news/store.ts:43` |
| **E. 账户/持仓/订单/风控/审计** | trading | `getAccount` `getPortfolio` `getOrders` `getQuote` `riskStatus` `tradingLog` `orderHistory` `tradeHistory` `getContractDetails` `getMarketClock` …（+ 执行类 `placeOrder`/`closePosition`/`tradingCommit`/`tradingReject`） | `src/tool/trading.ts:193-196`（组起点） |

> 另有非市场类通用工具（不参与「观察真实世界」）：`thinking`（`calculate`）、`inbox_read/push`、`entity_search/upsert`、`issue_*`、`workspace_path`。

## 3. 三态可见性矩阵

| 类 | ① 盲化回测（现状） | ② 普通 paper 回测 | ③ Live |
|---|---|---|---|
| **A 行情/量价** | **仅**匿名 OHLCV——paste 内联 或 `bars`/`searchBars` 但**锁死在本战役的 mock barId**（源不在白名单即拒绝+审计） | ✅ 全部真实 vendor | ✅ 全部真实 vendor |
| **B 分析/指标** | ❌ 全封（`calculateIndicator`/`calculateQuant` 直接丢）——agent 只能用原始 bars **自算指标** | ✅ | ✅ |
| **C 基本面/衍生/宏观** | ❌ 全封 | ✅ | ✅ |
| **D 新闻/事件** | ❌ 全封 | ✅ | ✅ |
| **E 账户/风控/审计** | ✅ 本账户（mock broker）的仓位/现金/订单/风控/审计全可见 | ✅ mock broker | ✅ 真 broker |
| **执行** | mock 撮合，commit 自动 push | 同左 | 真 broker，commit **必须人批**，永不自动 |

**设计意图**：盲化回测 = **「盲但富」**——凡是能从**匿名价格序列**推导的（OHLCV、量、自算指标）都给；凡是能暴露**真实身份**的（真 ticker 指标、新闻、基本面、宏观、symbol 搜索）全封，强制 agent「判断」而非「回忆」，堵死作弊。这落实不变量「富信息但不泄漏」。

## 4. 两条正交的裁剪：授权档 vs 盲化封印

观察/操作面由**两条互相正交**的裁剪叠加而成：

1. **授权档裁剪（`authzLevel`，jieke/dev 已在）**：按 Steward 授权档（read_only → paper → small_live → …）裁**交易能力**的可见性——`isTradingToolVisibleAtAuthzLevel`（`src/core/workspace-tool-center.ts:126-128`）、目录构建 `buildWorkspaceToolCatalog`（`src/core/workspace-tool-center.ts:459-476`）。全局 MCP 还把 trading 组**统一修剪为只读**。管的是**「能不能交易、到什么程度」**。
2. **盲化封印（`blind`，jieke/dev 已在）**：裁**市场观察**的真实性——见 §5。管的是**「能看到多真实的世界」**。

两者互不替代：授权档控执行权限，盲化控信息泄漏。

## 5. 盲化封印怎么实现（jieke/dev 已在）

`src/core/workspace-tool-center.ts` 在 `buildWorkspaceToolCatalog` 之上叠加 `sealBlindWorkspaceToolCatalog`（`blind===true` 才生效）：

- **`BLIND_BLOCKED_GROUPS`** 整组丢弃：`analysis / derivatives / economy / equity / etf / indices / market-board / market-search / market-vendors / news / rss / sector-rotation / simulate / snapshot`（对应上表 B/C/D 全封）。
- **`BLIND_BLOCKED_TOOL_NAMES`** 逐个丢弃：`calculateIndicator / calculateQuant / marketSearchForResearch`。
- **`BLIND_BAR_TOOL_NAMES`**（`bars` / `searchBars`）**作用域化保留**：`wrapBlindBarTool` 解析 barId → 校验 sourceId ∈ 战役白名单（`blindAllowBarSources`），不在白名单则返回 `BLIND_BAR_SOURCE_DENIED` + 记审计。这是 A 类「仅匿名 OHLCV」的实现。
- **`BLIND_TRADING_MARKET_TOOL_NAMES`**（`searchContracts` / `getQuote` / `getContractDetails` / `expandContract` / `getMarketClock`）现在也走同一套 source 白名单：`wrapBlindTradingMarketTool` 从 `source` / `aliceId` 提取 sourceId，不在 `blindAllowBarSources` 内即拒绝并记审计。这修掉了 v0.1 记录的 trading 市场数据绕过。

落点：`src/core/workspace-tool-center.ts:155-188`（盲化常量）、`src/core/workspace-tool-center.ts:290-455`（bar/trading market wrappers 与 seal）、`src/server/mcp.ts:174-184` 和 `src/server/cli.ts:193-204`（MCP/CLI 两面都把 workspace blind 元数据传入）。

## 6. ANATOMY 同步纪律

- **观察面的代码真源**：`src/tool/*`（工具组）+ `src/core/workspace-tool-center.ts`（授权/盲化裁剪）+ `src/server/mcp.ts` / `src/server/cli.ts`（MCP/CLI 两面应用裁剪）。[src/ANATOMY.md](../../../src/ANATOMY.md) 已覆盖授权档裁剪和盲化封印锚点。
- **漂移规则**：后续如果新增观察工具组、移动 blind seal、或改变 trading 市场数据的 source gate，必须在同一 PR 更新本文件与 `src/ANATOMY.md`，并跑 `check-anatomy-drift`。
- 与 [prompt-anatomy §3](../../steward-prompt-anatomy.zh.md) 互补：工具 `description:` 串是观察面的「how to call」侧，本文件是「看得到什么」侧。
