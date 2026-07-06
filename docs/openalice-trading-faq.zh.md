# OpenAlice 交易架构与使用 FAQ

本文沉淀了一轮关于 OpenAlice、UTA、自动交易、策略 bot、资产统一管理和 VPS 部署的讨论。

更新日期：2026-07-03

注意：OpenAlice 的 live trading 仍应按 beta 能力看待。真实资金接入前，优先使用 simulator、paper、demo、testnet 账号完整测试。本文不是投资建议，也不是券商、交易所或税务合规建议。

## 1. OpenAlice 是什么

OpenAlice 可以理解为一个面向交易研究和交易执行的 AI workspace 系统。

从工程结构看，它主要分成两层：

- Alice process：workspace launcher 和 trading-context injector。
- UTA process：独立的 broker/trading 执行进程。

Alice 不直接持有 broker 连接的核心逻辑。它负责启动 workspace、把行情、新闻、分析、UTA SDK 等工具注入给 agent，并把 Web UI、MCP、workspace 和用户交互组织起来。

UTA 负责 broker 凭证、账户、订单、持仓、交易状态、FX、交易审批状态和真实下单路径。所有持久化状态是文件，没有数据库。

## 2. Broker、UTA、MCP 分别是什么

### Broker

Broker 是实际替你接入市场的交易服务或券商/交易所。

例子：

- IBKR：可以接入美股、港股、期权、期货、外汇等，具体看账户权限。
- Alpaca：API-first broker，主要用于美股/ETF 等。
- Longbridge：常用于美股、港股方向。
- Binance、OKX、Bybit、Bitget、Hyperliquid：加密货币交易所。
- CCXT Custom：通过 CCXT 接入更多加密交易所。
- Simulator：本地模拟交易。

Broker 决定账户能交易哪些市场，OpenAlice 只是通过 UTA 去使用这些 broker 能力。

### UTA

UTA 是 Unified Trading Account。它是 OpenAlice 里的交易执行边界。

一个 UTA 大致等于：

```text
Broker + Trading Git + Guard Pipeline
```

UTA 负责：

- 连接 broker。
- 查询账户、余额、持仓、订单。
- 搜索真实可交易合约。
- 接收交易操作。
- 做 stage、commit、push、sync 的交易工作流。
- 把真实下单和成交同步回来。

UTA 不是“策略脑”，也不是“LLM”。它更像交易执行和风控边界。

### MCP

MCP 是 agent 使用工具的协议入口。OpenAlice 通过 MCP 把行情、分析、新闻、交易工具暴露给 workspace 里的 agent。

关键点：

- MCP 不是实际执行交易的服务。
- agent 通过 MCP 调用交易工具。
- 交易工具再通过 UTA SDK/HTTP 去找 UTA。
- UTA 再连接 broker 执行真实交易。

路径可以简化成：

```text
LLM agent -> MCP tool -> Alice tool layer -> UTA SDK/HTTP -> UTA process -> broker -> market
```

## 3. 现在可以交易哪些市场

OpenAlice 能交易什么，取决于配置了哪些 broker，以及 broker 账户本身开通了哪些权限。

当前 UTA 预设里有这些 broker：

| Broker preset | 典型市场 |
| --- | --- |
| IBKR | 美股、港股、期权、期货、外汇、基金等，按 IBKR 账户权限决定 |
| Alpaca | 美股、ETF 等 API trading 场景，按 Alpaca 账户权限决定 |
| Longbridge | 美股、港股方向，按账户权限决定 |
| Hyperliquid | 加密衍生品 |
| Binance | 现货、USD-M/COIN-M futures 等，按地区和账户权限决定 |
| OKX | 加密现货/衍生品，按账户权限决定 |
| Bybit | 加密现货/衍生品，按账户权限决定 |
| Bitget | 加密现货/衍生品，按账户权限决定 |
| LeverUp | broker-specific 集成 |
| CCXT Custom | 其他 CCXT 支持的加密交易所 |
| Simulator | 本地模拟交易 |

所以，如果你同时持有美股、港股、虚拟货币、韩国股市，理论上需要分别配置能覆盖这些市场的 broker。OpenAlice 统一管理的是账户视图和交易执行入口，不是把资产从 broker 里托管出来。

## 4. 资产在哪里统一管理

OpenAlice 的统一资产管理在 UTA Manager 这一层。

它可以把多个 UTA 汇总成统一视图，例如：

- 多个 broker account。
- 每个账户的 equity。
- 每个账户的 cash。
- 每个账户的 positions。
- 每个账户的 orders。
- 汇总后的 portfolio。
- FX 换算后的总体权益。

但要区分两件事：

- 资产托管仍在 broker 或交易所。
- OpenAlice 提供统一查询、统一视图、统一交易入口和统一审批路径。

也就是说，OpenAlice 不是 Schwab、IBKR、Binance 之外的“新托管账户”。它更像一个统一控制台和执行层。

持仓信息里通常会带这些关键字段：

- `source`：来自哪个 UTA/broker。
- `symbol`：市场/数据层看到的符号。
- `secType`：资产类型，例如 stock、crypto、option、future 等。
- `aliceId`：broker 侧可交易合约的 canonical identity。

## 5. OpenAlice 怎么处理“标的”

“标的”这个词在交易系统里很容易混用。OpenAlice 现在把它拆成几种身份，这是合理的。

### 1. Tracked Entity

这是用户关注的语义对象或 watchlist anchor。

例子：

- `crypto-btc`
- `stock-nvda`
- `etf-smh`
- `ai-data-center-power`

它不一定可以直接交易。它可以是资产，也可以是主题。

### 2. Market Symbol

这是研究和行情数据用的 symbol。

例子：

- `AAPL`
- `NVDA`
- `BTC-USD`
- `BTC/USDT`

Market symbol 用于查行情、新闻、指标、K 线，但不等于 broker 可交易合约。

### 3. Bar ID

这是具体行情源下的 K 线身份。

格式类似：

```text
source|symbol
```

例子：

- `yfinance|AAPL`
- `alpaca-paper|AAPL`
- `binance-main|BTC/USDT`

同一个标的在不同数据源下可能有不同 bar identity。

### 4. Contract / aliceId

这是最重要的交易身份。

`aliceId` 是 broker 侧可交易合约的 canonical identity。真实下单应该使用这个身份，而不是只凭研究 symbol。

比如 `BTC` 这个概念可能对应：

- Binance spot `BTC/USDT`
- Binance perpetual `BTC/USDT:USDT`
- Coinbase spot `BTC/USD`
- IBKR 里的某个 crypto/futures product

所以 OpenAlice 会区分研究符号和交易合约，避免“看的是 A，买的是 B”。

## 6. 策略来源是什么

OpenAlice 里可以有三类策略来源。

### 1. 定时 issue

定时 issue 不是一个常驻 tick-level bot。

它的意思是：你在 OpenAlice 里创建一个带 schedule 的任务，比如：

```text
每天美股开盘前检查 NVDA、AMD、SMH 的风险和机会。
如果满足某些条件，写报告并提出交易计划。
```

调度器会定期扫描这些 issue，并启动一个 headless workspace run。这个 run 会让 agent 在 workspace 里执行任务，最后通常通过 Inbox 推送报告。

它适合：

- 每天/每小时做研究。
- 生成交易计划。
- 做风险检查。
- 做低频 rebalance 建议。

它不适合：

- 毫秒/秒级交易。
- 依赖 WebSocket tick 的策略。
- 需要 7x24 不中断的事件驱动策略 loop。

### 2. 策略代码

策略代码是 workspace 或 satellite repo 里的真实程序。

例子：Auto-Quant workspace 会让 agent 在一个量化项目里：

- 准备数据。
- 写或修改策略。
- 回测。
- 优化参数。
- 记录结果。
- 生成报告。
- 提交修改。

这类代码可以发展成真实 bot，但当前 Auto-Quant template 更偏研究、回测、优化，不是 out-of-box live trading bot runner。

### 3. LLM agent

LLM agent 是 workspace 里运行的原生 agent CLI，例如 `claude`、`codex`、`opencode`、`pi` 或 `shell`。

它可以：

- 读行情、新闻、财报和账户数据。
- 搜索 tradeable contract。
- 修改策略代码。
- 运行 backtest。
- 比较策略结果。
- 写交易报告。
- 提出交易计划。
- stage/commit 交易操作。
- 在配置允许时触发 push。

LLM agent 的价值不只是“预测涨跌”，更重要的是把研究、代码、风控、账户状态和执行工作流串起来。

## 7. 提出交易计划后会自动交易吗

默认不会直接自动交易。

OpenAlice 的交易工具分阶段：

```text
stage -> commit -> human approval / UTA auto-push -> sync
```

一般交易工具如 `placeOrder`、`modifyOrder`、`cancelOrder`、`closePosition` 主要是 stage 操作；带 commit message 时可以 stage + commit。

AI 不再拿 `tradingPush` 工具；它能做的是提出并 commit 交易方案。真正把订单推给 broker 的动作只来自 Web UI 人工审批，或后续 UTA 侧确定性 auto-push 组件。

因此，一句“写报告并提出交易计划”本身不会自动交易。是否交易取决于该任务是否明确要求下单、交易工具是否被调用、是否 commit，以及账户 / workspace 授权配置。

## 8. 谁决定什么时候、怎么交易

需要分清四个角色：

| 角色 | 负责什么 |
| --- | --- |
| 固定策略 bot | 根据固定规则产生交易信号 |
| LLM agent | 研究、解释、修改策略、调度流程、提出计划，也可以在允许时发起交易 |
| UTA | 审批状态、风控边界、统一执行和 broker 连接 |
| Broker/Exchange | 接收订单、撮合、成交、返回状态 |

“什么时候交易、怎么交易”可以由不同层决定：

- 如果是固定策略 bot，就是策略代码决定。
- 如果是研究型 workflow，就是 LLM agent 分析后提出计划。
- 如果需要人工审批，就是用户最终决定是否 push。
- 如果开启 AI trading，LLM agent 或 bot 可以在规则允许范围内触发真实交易。

UTA 不应该被理解为策略决策者。它是执行者和边界。

## 9. OpenAlice 和传统 auto-trading-bot 有什么区别

传统 auto-trading-bot 通常是：

```text
固定策略代码 -> 直接连 broker -> 自动下单
```

它的特点是：

- 策略逻辑固定。
- 循环常驻。
- 直接执行。
- 容易做 7x24。
- 但研究、解释、策略迭代、审批和跨账户治理通常较弱。

OpenAlice 更像：

```text
workspace agent + strategy code/bots + UTA execution boundary + human/AI approval + unified context
```

它的特点是：

- LLM agent 可以研究、写报告、改策略、跑回测。
- 策略能力最好放在 workspace template 或 satellite repo。
- 真实下单最好统一走 UTA。
- 默认保留人工审批边界。
- 可以逐步演进成 bot control plane。

所以 OpenAlice 不是简单替代一个 Python bot loop。它更适合作为交易研究、策略迭代、账户上下文和交易执行的统一工作台。

## 10. LLM agent 能不能控制固定策略 bot

架构上可以，而且这是一个合理方向。

比较好的做法是做一个 satellite repo 或 workspace template，里面有：

- bot registry：登记每个 bot 的名字、市场、标的 universe、策略类型、账户、风险预算。
- config：每个 bot 的参数、交易频率、最大仓位、最大亏损、冷却时间。
- logs：每次 signal、decision、order、error 的结构化日志。
- risk budget：账户级、市场级、bot 级预算。
- start/stop/restart/status 命令。
- paper/live mode 切换。
- 回测和仿真命令。
- UTA 下单适配层。

LLM agent 通过 CLI/API 做调度：

```text
list bots
start bot us-nvda-momentum
stop bot crypto-btc-mean-reversion
show bot logs crypto-btc-mean-reversion --last 24h
change risk budget us-smh-rotation --max-notional 5000
```

但真实下单仍然建议走 UTA，而不是让每个 bot 各自直接连 broker。这样可以保留统一审批、统一风控、统一记录和统一账户视图。

## 11. 一个固定策略 bot 一般盯几个标的

“产品”这个词在这里可以换成更准确的几个词：

- 标的
- 证券
- 合约
- 交易对
- instrument
- symbol
- universe

bot 不一定只盯一个标的。常见模式有：

| Bot 类型 | 例子 |
| --- | --- |
| Single-instrument bot | 只交易 BTC/USDT 或只交易 NVDA |
| Basket bot | 同时看 NVDA、AMD、SMH |
| Universe bot | 扫描一组股票，选择满足条件的若干只 |
| Portfolio bot | 负责整个组合的再平衡 |
| Market-making bot | 负责一个或多个交易对的报价 |
| Risk bot | 不主动开仓，只负责减仓、止损、风控 |

所以可以出现这样的结构：

- 美股 4 个 bot，每个 bot 一个策略。
- 港股 3 个 bot。
- 韩国市场 3 个 bot。
- 加密货币 10 个 bot。

更重要的是给每个 bot 明确：

- 交易市场。
- broker/UTA account。
- tradeable contract universe。
- 策略逻辑。
- 风险预算。
- 下单权限。
- 日志和审计要求。

## 12. OpenAlice 现在支持某个特定策略 bot 做真实交易吗

要分开说。

OpenAlice 现在已经有：

- UTA 交易执行层。
- 多 broker 配置。
- 账户、持仓、订单查询。
- stage/commit + Web UI 人工 push 工作流。
- 默认人工审批。
- workspace 授权档模型。
- workspace 运行 agent。
- Auto-Quant 类型的策略研究/回测 workspace。
- 定时 issue/headless run。

但它还不是一个完整的多 bot 生产运行平台。

当前更准确的判断是：

- 可以通过 UTA 做真实交易路径。
- 可以让 agent 修改策略、跑回测、提出计划。
- 可以做低频自动化任务。
- 但如果要“多个固定策略 bot 7x24 运行、LLM 统一调度它们”，最好新增一个 satellite repo/workspace template 来承载 bot runtime/control plane。

真实资金接入前，建议先跑 simulator/paper/demo/testnet。

## 13. 能不能支持 7x24 自动交易

OpenAlice 当前更适合低频/中频自动化，不适合直接当作高频或 tick-level 常驻 bot 引擎。

可以做的：

- 每 5 分钟/15 分钟/1 小时跑一次检查。
- 每天开盘前生成报告。
- 定时检查风险。
- 定时提出交易计划。
- 在明确配置下 stage/commit/push 交易。

不建议直接依赖当前定时 issue 做的：

- 秒级或毫秒级反应。
- 复杂 WebSocket tick loop。
- 高频交易。
- 对进程持续性要求极高的策略。

如果要做真正 7x24 bot，建议：

```text
专门 bot runtime -> UTA execution -> broker
        ^
        |
LLM agent 负责调度、审计、改参数、看日志、停启 bot
```

也就是说，长期常驻 loop 交给固定策略 bot；LLM agent 不一定自己一直循环，而是做更高层的管理和协作。

## 14. “未来 24 小时 BTC 低于持仓均价就买，高于均价就卖”能不能做

可以近似做，但不应直接一句话就上真钱。

一个安全实现至少需要定义：

- 哪个交易所/UTA account。
- 交易对，例如 `BTC/USDT` spot 还是 perpetual。
- 当前平均持仓价格用哪个账户字段计算。
- 每次买多少。
- 每次卖多少。
- 最大持仓。
- 最大日成交次数。
- 冷却时间。
- 手续费和滑点。
- 用 market order 还是 limit order。
- 如果 API 失败怎么办。
- 如果价格在均价附近来回震荡怎么办。
- 24 小时结束后是否自动停止。

用当前 OpenAlice 可以做成低频 scheduled issue，比如每 5 分钟检查一次，满足条件就 stage/commit 订单，并根据配置决定是否需要 UI 审批。

但如果要可靠 7x24 盯盘，最好写成固定策略 bot，并让 OpenAlice/LLM agent 负责创建、配置、审计和启停。

## 15. 本地怎么使用 OpenAlice

开发模式：

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会由 Guardian 启动：

- UTA：`47333`
- Alice backend：`47331`
- Vite UI：`5173`

本地开发时通常打开：

```text
http://localhost:5173
```

如果是 production/Docker 方式，通常访问 Alice Web 端口：

```text
http://localhost:47331
```

第一次启动时，后端会在日志里打印 admin token。登录 UI 时需要它。

关闭本地 dev server：

```text
Ctrl+C
```

如果用 Docker Compose：

```bash
docker compose down
```

## 16. VPS 上没有浏览器，怎么用 OpenAlice

可以把 OpenAlice 部署在 VPS 上，但在本地浏览器操作。

推荐方式是 SSH tunnel：

```bash
ssh -N -L 47331:127.0.0.1:47331 user@your-vps-ip
```

然后本地打开：

```text
http://localhost:47331
```

这样：

- OpenAlice/UTA 运行在 VPS。
- 你的本地浏览器操作 Web UI。
- broker 看到的是 VPS 的出口 IP。
- Web UI 不需要直接暴露公网。
- UTA/MCP 不需要开放公网。

如果 agent CLI 需要登录，例如 `claude` 或 `codex`，可以 SSH 到 VPS 或进入 Docker 容器执行登录命令。通常 CLI 会打印一个浏览器 URL 或 code，你在本地浏览器完成认证即可。

## 17. Broker IP 检查怎么处理

OpenAlice 不会绕过 broker 的 IP 检查。

broker 或交易所看到的是 UTA 发起请求的出口 IP。

如果 OpenAlice/UTA 跑在本机：

```text
broker sees your home/office IP
```

如果 OpenAlice/UTA 跑在 VPS：

```text
broker sees VPS public IPv4
```

如果 broker 支持 IP whitelist，应把 VPS 固定公网 IPv4 加进去。

加密交易所尤其要注意：

- API key 最好绑定 IP。
- 不要开启提现权限。
- 使用合规地区允许的交易所。
- 不要频繁切换 VPS 区域和 IP。
- 美国 VPS 可能影响某些非美国加密交易所的可用性。

OpenAlice 的 CCXT broker 支持通过环境变量配置 HTTP/SOCKS proxy，但交易场景下优先推荐固定 VPS/EIP，而不是复杂代理链。

## 18. 中国云服务器能不能交易美股

能不能交易美股主要由 broker 账号权限决定，不由 VPS 国家直接决定。

例如 IBKR 交易权限是按产品和国家/市场配置的。如果账户开通了美国股票权限，理论上 API 可以从某个公网 IP 发起交易。

但 VPS 位置会影响 broker 看到的出口 IP。

如果 OpenAlice/UTA 跑在中国大陆云服务器上，broker 看到的就是中国大陆机房 IP。只要 broker 接受这个 IP、账号风控不拦截、API 网络可达，就可能可以交易。

实际建议：

- 主要交易美股：优先美国 VPS。
- 折中：香港、新加坡、日本。
- 中国大陆节点：更适合测试、研究、低频提醒，不建议作为真实交易主执行节点。

## 19. VPS 推荐

建议规格：

```text
最低：2 vCPU / 2GB RAM / 40GB SSD
推荐：2 vCPU / 4GB RAM / 80GB SSD
系统：Ubuntu 24.04 LTS
网络：固定公网 IPv4
```

### 首选：DigitalOcean

推荐计划：

```text
Basic Droplet
2 vCPU / 4GB RAM / 80GB SSD
$24/mo
Region: NYC3
OS: Ubuntu 24.04 LTS
```

原因：

- GitHub Student Developer Pack 当前显示 DigitalOcean $200 platform credit / 1 year。
- 规格刚好符合 OpenAlice 推荐配置。
- 运维简单。
- 固定 IPv4/Reserved IP 机制清晰。
- 学生身份下性价比最高。

$200 credit 大概可覆盖 $24/mo 机器约 8 个月。

### 第二选择：AWS Lightsail

推荐计划：

```text
Linux/Unix Medium
2 vCPU / 4GB RAM / 80GB SSD
$24/mo with public IPv4
```

原因：

- 稳定。
- 价格清晰。
- Static IP 绑定实例时不额外收费。
- 适合长期运行简单服务。

缺点：

- 学生优惠不如 DigitalOcean 直接。
- AWS Educate 更偏学习实验，不是长期 VPS 额度。

### 其他备选

| Provider | 典型选择 | 判断 |
| --- | --- | --- |
| Vultr | Regular 2 vCPU / 4GB / 80GB，约 $20/mo | 便宜，US region 多，可以作为备选 |
| Akamai/Linode | Linode 4GB，约 $24/mo | 老牌 VPS，稳定，学生优惠不明显 |
| OVHcloud US | VPS 低价档 | 很便宜，但建议先 paper/demo 跑一周 |
| Hetzner US | 美国节点 | 2026 涨价后优势下降，买前重新核价 |
| Azure/GCP/EC2 | 学生/新用户 credit | 适合学习和短期试用，不是最省心的长期 VPS |

## 20. VPS 部署安全建议

最低安全线：

- 只开放 SSH。
- OpenAlice Web UI 用 SSH tunnel 访问。
- 不把 UTA/MCP 暴露到公网。
- 使用 SSH key 登录，关闭密码登录。
- 设置系统防火墙。
- broker API key 只开交易必要权限。
- 不开提现权限。
- 能绑定 IP whitelist 就绑定 VPS IPv4。
- workspace / account 授权默认保持 `read_only`。
- 真实资金前至少跑 paper/demo/testnet。
- 配置定期备份 `data/`。
- 定期检查订单、持仓和日志。

## 21. 推荐的下一步

如果目标是把 OpenAlice 变成更完整的自动交易平台，下一步应当不是把所有 bot 逻辑塞进 `src/`，而是做一个 satellite repo 或 workspace template。

建议这个 repo 包含：

- `bots.yaml`：bot registry。
- `accounts.yaml`：bot 到 UTA account 的映射。
- `risk.yaml`：账户级和 bot 级风险预算。
- `strategies/`：固定策略代码。
- `logs/`：结构化运行日志。
- `backtests/`：回测结果。
- `cli/`：`start`、`stop`、`status`、`logs`、`set-budget` 等命令。
- `uta/`：统一通过 UTA 下单的 adapter。
- `reports/`：LLM agent 输出的日报、周报、异常报告。

LLM agent 的角色是：

- 创建和修改策略。
- 跑回测和参数搜索。
- 阅读 bot 日志。
- 调整风险预算。
- 启停 bot。
- 汇总账户风险。
- 生成报告。
- 必要时请求用户审批交易。

固定策略 bot 的角色是：

- 7x24 运行。
- 监听行情。
- 按规则产生信号。
- 通过 UTA 下单。
- 写结构化日志。
- 遵守风险预算。

这样 OpenAlice、UTA、LLM agent 和固定策略 bot 的边界会比较清晰。

## 参考链接

- GitHub Student Developer Pack: https://education.github.com/pack
- DigitalOcean Droplet pricing: https://www.digitalocean.com/pricing/droplets
- DigitalOcean Reserved IP docs: https://docs.digitalocean.com/products/networking/reserved-ips/
- AWS Lightsail bundles: https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html
- AWS Lightsail static IP docs: https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-static-ip-addresses-in-amazon-lightsail.html
- AWS Educate: https://aws.amazon.com/education/awseducate/
- Azure for Students: https://azure.microsoft.com/en-us/free/students
- Google Cloud free trial: https://cloud.google.com/free
- Akamai/Linode plans API docs: https://techdocs.akamai.com/linode-api/reference/get-linode-types
- Vultr pricing: https://www.vultr.com/pricing/
- OVHcloud US VPS: https://us.ovhcloud.com/vps/
- Hetzner cloud: https://www.hetzner.com/cloud/
- Hetzner price adjustment: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- IBKR trading permissions: https://www.ibkrguides.com/clientportal/tradingpermissions.htm
- IBKR IP restrictions: https://www.ibkrguides.com/clientportal/usersettings/iprestrictions.htm
- IBKR API overview: https://www.interactivebrokers.com/en/trading/ib-api.php
