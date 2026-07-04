# OSS Steward Runtime Due Diligence

## TradingAgents

- License and language:
  - License: Apache-2.0 (`LICENSE`).
  - Primary language: Python (`tradingagents/**/*.py`, `cli/main.py`).
- Architecture:
  - One-shot LLM analysis/trading-decision graph, not a production trading daemon.
  - `TradingAgentsGraph.propagate()` runs a LangGraph workflow for one company/date/asset and returns final state plus processed signal (`tradingagents/graph/trading_graph.py:TradingAgentsGraph.propagate`).
  - `GraphSetup.setup_graph()` wires analyst nodes, bull/bear researchers, trader, aggressive/neutral/conservative risk analysts, and portfolio manager into a graph ending at `END` (`tradingagents/graph/setup.py:GraphSetup.setup_graph`).
  - The CLI is an interactive analysis runner with progress display, not a broker loop (`cli/main.py`).
- Steward-relevant machinery:
  - Long-running operation loop / scheduler: absent. Checked `rg -n "while True|scheduler|cron|daemon|broker|place_order|submit_order|create_order|dry_run|paper" tradingagents cli`; hits are graph/checkpoint/reporting or schema text, not continuous broker operation.
  - Risk boundaries: prompt-level risk debate only. `create_conservative_debator()` critiques risky trader plans in natural language (`tradingagents/agents/risk_mgmt/conservative_debator.py`); `TraderProposal` has optional `stop_loss` and `position_sizing` fields, but no enforcement path (`tradingagents/agents/schemas.py:TraderProposal`).
  - Approval / authorization flow: absent. The portfolio manager produces a final decision from risk debate (`tradingagents/agents/managers/portfolio_manager.py:create_portfolio_manager`), but there is no human approval or order submission layer; checked `rg -n "approve|approval|human|place_order|submit_order|broker|exchange"` under `tradingagents/`.
  - Auditability: good for analysis artifacts. `_log_state()` writes full graph state JSON, `_run_graph()` logs state and stores decisions, and reporting writes markdown sections (`tradingagents/graph/trading_graph.py:_log_state`, `tradingagents/graph/trading_graph.py:_run_graph`, `tradingagents/reporting.py`).
  - Memory / reflection: strong for offline reflection. `TradingMemoryLog.store_decision()`, `get_past_context()`, `update_with_outcome()`, and `batch_update_with_outcomes()` maintain an append-only markdown memory log (`tradingagents/agents/utils/memory.py:TradingMemoryLog`); `Reflector.reflect_on_final_decision()` generates outcome-aware reflections (`tradingagents/graph/reflection.py:Reflector.reflect_on_final_decision`).
  - Broker/execution integration: absent. Checked `rg -n "alpaca|ibkr|ccxt|exchange|broker|place_order|submit_order|create_order"` under `tradingagents/`; no live broker abstraction or order API.
  - LLM-agent nature: yes. `TradingAgentsGraph.__init__()` creates LLM clients and graph components, and trader/risk/manager agents produce structured proposals/decisions (`tradingagents/graph/trading_graph.py:TradingAgentsGraph.__init__`, `tradingagents/agents/trader/trader.py:create_trader`).
- Verdict:
  - COMPONENT. Reusable for multi-agent decision structure, analysis audit, and reflection memory; not a runtime skeleton because it has no continuous broker loop, deterministic risk guard, or approval-to-execution path.

## FinRobot

- License and language:
  - License: Apache-2.0 (`LICENSE`).
  - Primary language: Python (`finrobot/**/*.py`, `finrobot_equity/**/*.py`).
- Architecture:
  - Mostly one-shot AutoGen financial-analysis workflows and report generation, not a live trading runtime.
  - `SingleAssistant.chat()` calls `UserProxyAgent.initiate_chat()` and then resets state; default `human_input_mode="NEVER"` and `max_consecutive_auto_reply=10` make it an autonomous bounded chat, not a scheduler (`finrobot/agents/workflow.py:SingleAssistant.chat`).
  - `MultiAssistantBase.chat()` and `MultiAssistantWithLeader` coordinate group/nested chats for analysis tasks (`finrobot/agents/workflow.py:MultiAssistantBase`, `finrobot/agents/workflow.py:MultiAssistantWithLeader`).
  - The equity web app runs report pipelines as FastAPI background jobs, not a trading loop (`finrobot_equity/web_app/main.py:execute_analysis_pipeline`).
- Steward-relevant machinery:
  - Long-running operation loop / scheduler: absent for trading. `execute_analysis_pipeline()` launches analysis/report subprocesses and stores status, but no broker loop (`finrobot_equity/web_app/main.py:execute_analysis_pipeline`); checked `rg -n "while True|scheduler|cron|broker|place_order|submit_order|create_order"` under `finrobot/`, `finrobot_equity/`, and `experiments/`.
  - Risk boundaries: only backtest/report metrics. `BackTraderUtils.back_test()` configures Backtrader cash and analyzers including DrawDown, Sharpe, Returns, and TradeAnalyzer (`finrobot/functional/quantitative.py:BackTraderUtils.back_test`); no live max-drawdown guard, kill switch, or position-limit enforcement found via `rg -n "kill_switch|max_drawdown|drawdown|stop_loss|position_limit|risk"` under source paths.
  - Approval / authorization flow: no order approval. AutoGen user proxy defaults to `human_input_mode="NEVER"` (`finrobot/agents/workflow.py:SingleAssistant.__init__`), and experiments use automated chat for research outputs (`experiments/portfolio_optimization.py`); checked `rg -n "approve|approval|human|place_order|submit_order|create_order"`.
  - Auditability: web-request and report status logging, not decision-to-order audit. `RequestLog` and `ReportRequest` persist web app requests and report status (`finrobot_equity/web_app/database/models.py:RequestLog`, `finrobot_equity/web_app/database/models.py:ReportRequest`); `crud.log_request()` records API calls (`finrobot_equity/web_app/database/crud.py:log_request`).
  - Memory / reflection: no durable trading memory. The AutoGen chat resets after each chat (`finrobot/agents/workflow.py:SingleAssistant.chat`); checked `rg -n "memory|reflection|remember|trace"` under `finrobot/` and `finrobot_equity/`.
  - Broker/execution integration: no live broker abstraction. `BackTraderUtils.back_test()` uses Backtrader's simulated broker only (`finrobot/functional/quantitative.py:BackTraderUtils.back_test`); checked `rg -n "alpaca|ibkr|ccxt|exchange|broker|place_order|submit_order|create_order"`.
  - LLM-agent nature: yes for analysis/report generation. `FinRobot` extends AutoGen `AssistantAgent` and registers toolkits (`finrobot/agents/workflow.py:FinRobot`); role configs live in `finrobot/agents/agent_library.py`.
- Verdict:
  - COMPONENT, weak. Useful for report-generation patterns and AutoGen role wiring; not a steward runtime because it has no live execution, hard risk boundary, approval gate, or durable trading memory.

## FinRL

- License and language:
  - License: MIT (`LICENSE`).
  - Primary language: Python (`finrl/**/*.py`, `examples/**/*.py`).
- Architecture:
  - Classic RL/backtesting toolkit with a paper-trading Alpaca loop.
  - `trade()` routes between backtesting and `paper_trading`; paper mode creates `PaperTradingAlpaca` and calls `run()` (`finrl/trade.py:trade`).
  - `PaperTradingAlpaca.run()` is a continuous market-hours loop: cancel open orders, await market open, repeatedly call `trade()`, append equity, sleep, and liquidate near close (`finrl/meta/paper_trading/alpaca.py:PaperTradingAlpaca.run`).
  - Most of the repo is training/data/env infrastructure rather than a conservative production daemon.
- Steward-relevant machinery:
  - Long-running operation loop / scheduler: present only for Alpaca paper trading. `PaperTradingAlpaca.run()` loops while market is open and calls `submitOrder()` inside `trade()` (`finrl/meta/paper_trading/alpaca.py:PaperTradingAlpaca.run`, `finrl/meta/paper_trading/alpaca.py:PaperTradingAlpaca.submitOrder`).
  - Risk boundaries: limited and model/env-level. `PaperTradingAlpaca.trade()` sells all positions when `self.turbulence >= self.turbulence_thresh` (`finrl/meta/paper_trading/alpaca.py:PaperTradingAlpaca.trade`); `env_stocktrading_stoploss.py` has simulated stop-loss/cash penalties, but that is an RL environment, not live enforcement (`finrl/meta/env_stock_trading/env_stocktrading_stoploss.py:StockTradingEnv`).
  - Approval / authorization flow: no human gate. `submitOrder()` calls `self.alpaca.submit_order(...)` directly (`finrl/meta/paper_trading/alpaca.py:PaperTradingAlpaca.submitOrder`); checked `rg -n "approve|approval|human|manual|dry_run|paper|live"` under `finrl/`.
  - Auditability: simulated memories and equity arrays, not full decision trace. `env_stocktrading.py` records `actions_memory` and account memory CSVs in backtests (`finrl/meta/env_stock_trading/env_stocktrading.py:StockTradingEnv.step`); paper loop appends `self.equities` (`finrl/meta/paper_trading/alpaca.py:PaperTradingAlpaca.run`).
  - Memory / reflection: no LLM-style reflection. RL models learn during training; no persistent decision/reflection store found via `rg -n "memory|reflection|remember|trace|lesson"` under `finrl/`.
  - Broker/execution integration: Alpaca REST only in the paper-trading path. `PaperTradingAlpaca.__init__()` constructs `tradeapi.REST(...)` and `submitOrder()` submits via Alpaca (`finrl/meta/paper_trading/alpaca.py:PaperTradingAlpaca.__init__`, `finrl/meta/paper_trading/alpaca.py:PaperTradingAlpaca.submitOrder`).
  - LLM-agent nature: no. Decisions come from trained RL policies (`self.model.predict(...)` in `PaperTradingAlpaca.trade()`), not an LLM (`finrl/meta/paper_trading/alpaca.py:PaperTradingAlpaca.trade`).
- Verdict:
  - COMPONENT. Useful for RL environments, training, and a minimal paper loop; not a steward skeleton because the live/paper operation is narrow, has no approval, and risk controls are mostly turbulence/env heuristics.

## qlib

- License and language:
  - License: MIT (`LICENSE`).
  - Primary language: Python (`qlib/**/*.py`).
- Architecture:
  - Quant research, dataset, workflow, and simulated backtest toolkit.
  - `backtest_loop()` resets executor/strategy and repeatedly asks the strategy for a trade decision, then lets a simulated executor collect/deal data until finished (`qlib/backtest/backtest.py:backtest_loop`).
  - `SimulatorExecutor._collect_data()` sends generated orders to a simulated exchange (`qlib/backtest/executor.py:SimulatorExecutor._collect_data`).
  - Online workflow managers update models/predictions/signals, but do not place broker orders (`qlib/workflow/online/manager.py:OnlineManager.routine`).
- Steward-relevant machinery:
  - Long-running operation loop / scheduler: simulated and workflow-only. `backtest_loop()` is a backtest loop (`qlib/backtest/backtest.py:backtest_loop`); `OnlineManager.routine()` handles model lifecycle tasks, not live execution (`qlib/workflow/online/manager.py:OnlineManager.routine`).
  - Risk boundaries: research/backtest constraints. `Exchange` enforces tradability, price limits, volume thresholds, and costs in simulation (`qlib/backtest/exchange.py:Exchange.check_order`, `qlib/backtest/exchange.py:Exchange.deal_order`); `BaseSignalStrategy.risk_degree` and `OrderGenWInteract` reserve cash via risk degree (`qlib/contrib/strategy/signal_strategy.py:BaseSignalStrategy`, `qlib/contrib/strategy/order_generator.py:OrderGenWInteract`).
  - Approval / authorization flow: absent. Checked `rg -n "approve|approval|human|manual|broker|live|paper"` under `qlib/backtest`, `qlib/contrib/strategy`, and `qlib/workflow/online`; no human gate or paper-to-live graduation.
  - Auditability: experiment artifacts and metrics, not live order audit. `Recorder` logs params, metrics, artifacts, and status (`qlib/workflow/recorder.py:Recorder`); `SignalRecord.generate()` saves prediction artifacts like `pred.pkl` (`qlib/workflow/record_temp.py:SignalRecord.generate`).
  - Memory / reflection: no decision reflection. Checked `rg -n "memory|reflection|remember|lesson|trace"` under `qlib/`; hits are workflow/experiment artifacts, not realized-decision learning.
  - Broker/execution integration: simulated exchange only. `Exchange.deal_order()` is an in-process simulator and `Order` is a backtest decision entity (`qlib/backtest/exchange.py:Exchange.deal_order`, `qlib/backtest/decision.py:Order`).
  - LLM-agent nature: no. Classic quant models/strategies; no LLM agent loop found via `rg -n "OpenAI|Anthropic|LLM|langchain|chat_completion"` under `qlib/`.
- Verdict:
  - COMPONENT. Strong for research, signals, and simulated portfolio evaluation; not a runtime skeleton for a steward because execution is simulated and no authorization or live risk state machine exists.

## RD-Agent

- License and language:
  - License: MIT (`LICENSE`).
  - Primary language: Python (`rdagent/**/*.py`).
- Architecture:
  - Long-running research-and-development loop for hypotheses, coding, running experiments, and feedback, not a trading daemon.
  - `RDLoop` sequences hypothesis generation, experiment generation, coding, running, feedback, and recording into a trace (`rdagent/components/workflow/rd_loop.py:RDLoop`).
  - `LoopBase` provides async session/step orchestration and trace folders (`rdagent/utils/workflow/loop.py:LoopBase`).
  - Quant apps run the RD loop with `asyncio.run(...)` for Qlib factor/model research (`rdagent/app/qlib_rd_loop/quant.py`).
- Steward-relevant machinery:
  - Long-running operation loop / scheduler: present for research iteration, not production trading. `RDLoop._propose()`, `coding()`, `running()`, `feedback()`, and `record()` advance research loops (`rdagent/components/workflow/rd_loop.py:RDLoop`); no broker loop.
  - Risk boundaries: absent for trading. Checked `rg -n "kill_switch|max_drawdown|stop_loss|position_limit|risk|broker|place_order|submit_order"` under `rdagent/`; hits are research/eval terminology, not live risk enforcement.
  - Approval / authorization flow: optional research interactivity only. `_interact_hypo()` and `_interact_feedback()` allow user modification of hypotheses/feedback, but not order approval (`rdagent/components/workflow/rd_loop.py:RDLoop._interact_hypo`, `rdagent/components/workflow/rd_loop.py:RDLoop._interact_feedback`).
  - Auditability: strong for experiment traces. `Trace` stores hypothesis/experiment feedback history and DAG lineage (`rdagent/core/proposal.py:Trace`); `RDAgentLog.log_object()` and file storage persist objects/messages (`rdagent/log/logger.py:RDAgentLog.log_object`, `rdagent/log/storage.py:FileStorage`).
  - Memory / reflection: research memory, not trading memory. `Trace.hist`, `Trace.dag_parent`, and evolving strategies maintain experiment history (`rdagent/core/proposal.py:Trace`, `rdagent/core/evolving_framework.py:EvolvingStrategy`, `rdagent/core/evolving_framework.py:RAGStrategy`).
  - Broker/execution integration: absent. Checked `rg -n "alpaca|ibkr|ccxt|exchange|broker|place_order|submit_order|create_order"` under `rdagent/`; no live broker abstraction.
  - LLM-agent nature: yes for research/coding. Proposal and coding components call LLM-backed generators/templates (`rdagent/components/proposal/__init__.py:HypothesisGen`, `rdagent/components/workflow/rd_loop.py:RDLoop.coding`).
- Verdict:
  - COMPONENT. Useful for autonomous research/evaluation trace infrastructure; not a runtime skeleton because it does not observe markets continuously or execute governed orders.

## OpenBB

- License and language:
  - License: AGPL-3.0 (`LICENSE`).
  - Primary language: Python for the platform/API/MCP surface (`openbb_platform/**/*.py`).
- Architecture:
  - Data platform, REST API, and MCP tool surface, not a trading bot.
  - `rest_api.py` creates the FastAPI app and mounts extension routers via `AppLoader.add_routers()` (`openbb_platform/core/openbb_core/api/rest_api.py`).
  - `build_api_wrapper()` routes API calls into `CommandRunner.run()` and validates returned command output (`openbb_platform/core/openbb_core/api/router/commands.py:build_api_wrapper`, `openbb_platform/core/openbb_core/app/command_runner.py:StaticCommandRunner.run`).
  - The MCP extension converts the FastAPI app into FastMCP tools and can restrict/default categories (`openbb_platform/extensions/mcp_server/openbb_mcp_server/app/app.py:create_mcp_server`).
- Steward-relevant machinery:
  - Long-running operation loop / scheduler: API server only. `rest_api.py` runs uvicorn/FastAPI, not a broker loop (`openbb_platform/core/openbb_core/api/rest_api.py`); checked `rg -n "scheduler|while True|daemon|place_order|submit_order|create_order"` in platform/API/MCP paths.
  - Risk boundaries: absent. The provider/interface layer is for market-data commands (`openbb_platform/core/openbb_core/app/provider_interface.py:create_executor`); checked `rg -n "kill_switch|max_drawdown|stop_loss|position_limit|risk|approval"` in `openbb_core`, `platform_api`, and `mcp_server`.
  - Approval / authorization flow: tool/category enablement, not trade approval. `MCPSettings` has `default_tool_categories`, `allowed_tool_categories`, and discovery settings (`openbb_platform/extensions/mcp_server/openbb_mcp_server/models/settings.py:MCPSettings`); no human order gate.
  - Auditability: command metadata, not decision/order audit. `StaticCommandRunner.run()` attaches route/arguments/duration/timestamp metadata when preferences enable metadata (`openbb_platform/core/openbb_core/app/command_runner.py:StaticCommandRunner.run`).
  - Memory / reflection: absent. Checked `rg -n "memory|reflection|remember|lesson|trace"` in platform/API/MCP paths; results are exceptions/tracebacks or provider data, not decision memory.
  - Broker/execution integration: absent in focused platform/API/MCP surface. Provider interface abstracts data providers, not brokers (`openbb_platform/core/openbb_core/app/provider_interface.py`); checked `rg -n "broker|place_order|submit_order|create_order|cancel_order"`.
  - LLM-agent nature: not a decision agent. MCP exposes data/API tools to external agents (`openbb_platform/extensions/mcp_server/openbb_mcp_server/app/app.py:create_mcp_server`), but OpenBB itself does not run an LLM decision loop.
- Verdict:
  - COMPONENT. Valuable for market-data/API/MCP integration; not a steward runtime because it has no live execution, risk state machine, approval, or memory.

## hummingbot

- License and language:
  - License: Apache-2.0 (`LICENSE`).
  - Primary language: Python/Cython (`hummingbot/**/*.py`, `hummingbot/**/*.pyx`).
- Architecture:
  - Long-running crypto trading daemon with connectors, realtime clock, strategies, recorder, and headless mode.
  - `HummingbotApplication.run_headless()` keeps the app alive in a `while True` sleep loop and shuts down trading core on exit (`hummingbot/client/hummingbot_application.py:HummingbotApplication.run_headless`).
  - `StartCommand._run_clock()` runs the trading clock, and `Clock.run_til()` ticks iterators in realtime mode (`hummingbot/client/command/start_command.py:StartCommand._run_clock`, `hummingbot/core/clock.pyx:Clock.run_til`).
  - `TradingCore.start_strategy()` wires connectors, strategy, `MarketsRecorder`, kill switch, and the realtime `Clock` (`hummingbot/core/trading_core.py:TradingCore.start_strategy`).
- Steward-relevant machinery:
  - Long-running operation loop / scheduler: yes. `TradingCore.start_clock()` creates `Clock(ClockMode.REALTIME, tick_size)` and `Clock.run_til()` continuously ticks child iterators (`hummingbot/core/trading_core.py:TradingCore.start_clock`, `hummingbot/core/clock.pyx:Clock.run_til`).
  - Risk boundaries: real machinery, mostly trading-bot oriented. `ActiveKillSwitch.check_profitability_loop()` checks profitability every 10 seconds and calls `trading_core.shutdown()` on threshold breach (`hummingbot/core/utils/kill_switch.py:ActiveKillSwitch.check_profitability_loop`); `BudgetChecker.adjust_candidate*()` constrains orders by balance/collateral (`hummingbot/connector/budget_checker.py:BudgetChecker`); `PositionExecutor.control_stop_loss()`, `control_take_profit()`, and `control_time_limit()` enforce triple-barrier exits (`hummingbot/strategy_v2/executors/position_executor/position_executor.py:PositionExecutor`).
  - Approval / authorization flow: no human-in-the-loop order approval. `ConnectorManager.get_connector()` creates live or paper connectors from config, and `StartCommand.start_check()` only warns/notifies about paper trading (`hummingbot/core/connector_manager.py:ConnectorManager.get_connector`, `hummingbot/client/command/start_command.py:StartCommand.start_check`); checked `rg -n "approval|approve|human|manual approval"` under `hummingbot/`, hits are not pre-order approval gates.
  - Auditability: order/event recorder and structured logs. `MarketsRecorder` listens for order created/filled/canceled/failed/completed and persists market/executor/order events (`hummingbot/connector/markets_recorder.py:MarketsRecorder`); connector base emits events/logs (`hummingbot/connector/connector_base.pyx:ConnectorBase`).
  - Memory / reflection: absent. Checked `rg -n "memory|reflection|remember|lesson|OpenAI|Anthropic|LLM|langchain"` under `hummingbot/`; no LLM decision memory/reflection layer.
  - Broker/execution integration: broad crypto exchange connector abstraction. `ExchangeBase` defines abstract buy/sell/cancel paths (`hummingbot/connector/exchange_base.pyx:ExchangeBase`); `ConnectorManager` creates real exchange connectors or paper-trade connectors (`hummingbot/core/connector_manager.py:ConnectorManager.get_connector`, `hummingbot/connector/exchange/paper_trade/paper_trade_exchange.pyx:PaperTradeExchange`).
  - LLM-agent nature: no. Decisions are strategy/executor driven; checked `rg -n "OpenAI|Anthropic|LLM|langchain|chat_completion"` under `hummingbot/`.
- Verdict:
  - RUNTIME SKELETON CANDIDATE for crypto execution. It contributes a real daemon, connector model, recorder, paper mode, kill switch, budget checks, and stop-loss machinery; it lacks LLM reasoning, progressive authorization, and fiduciary asset-management policy.

## freqtrade

- License and language:
  - License: GPL-3.0 (`LICENSE`).
  - Primary language: Python (`freqtrade/**/*.py`).
- Architecture:
  - Long-running crypto trading bot with live/dry-run exchange abstraction, strategy callbacks, protections, persistence, and FreqAI.
  - `Worker.run()` is the top-level infinite worker loop over bot states (`freqtrade/worker.py:Worker.run`).
  - `FreqtradeBot.process()` is the main trading cycle: reload markets, refresh data, run strategy analysis, manage open orders, handle exits, adjust positions, enter positions, process scheduler, and commit persistence (`freqtrade/freqtradebot.py:FreqtradeBot.process`).
  - `Exchange.create_order()` branches to `create_dry_run_order()` when `config["dry_run"]` is enabled, otherwise calls CCXT (`freqtrade/exchange/exchange.py:Exchange.create_order`, `freqtrade/exchange/exchange.py:Exchange.create_dry_run_order`).
- Steward-relevant machinery:
  - Long-running operation loop / scheduler: yes. `Worker.run()` and `_worker()` repeatedly call `freqtrade.process()` with RUNNING/PAUSED/STOPPED/RELOAD_CONFIG state handling (`freqtrade/worker.py:Worker.run`, `freqtrade/worker.py:Worker._worker`).
  - Risk boundaries: strong trading-bot protections. `ProtectionManager.global_stop()` and `stop_per_pair()` lock trading globally/per-pair (`freqtrade/plugins/protectionmanager.py:ProtectionManager`); `MaxDrawdown` locks after configured drawdown (`freqtrade/plugins/protections/max_drawdown_protection.py:MaxDrawdown`); `StoplossGuard` locks after repeated stoploss/liquidation exits (`freqtrade/plugins/protections/stoploss_guard.py:StoplossGuard`); `FreqtradeBot.create_stoploss_order()` and `handle_stoploss_on_exchange()` manage stoploss orders (`freqtrade/freqtradebot.py:FreqtradeBot.create_stoploss_order`, `freqtrade/freqtradebot.py:FreqtradeBot.handle_stoploss_on_exchange`).
  - Approval / authorization flow: no human approval, but dry-run/live split is real. `execute_entry()` calls strategy `confirm_trade_entry()` callback and then `exchange.create_order()` (`freqtrade/freqtradebot.py:FreqtradeBot.execute_entry`); `Exchange.create_order()` enforces dry-run branching via config (`freqtrade/exchange/exchange.py:Exchange.create_order`). Checked `rg -n "approval|approve|human|manual approval|OpenAI|Anthropic|LLM|langchain"` under `freqtrade/`; no human gate or LLM approval loop.
  - Auditability: good order/trade persistence, not rationale trace. `Order` and trade models persist CCXT/order fields (`freqtrade/persistence/trade_model.py:Order`); pair locks persist lock state (`freqtrade/persistence/pairlock_middleware.py:PairLocks`); DB commits happen each bot cycle (`freqtrade/freqtradebot.py:FreqtradeBot.process`).
  - Memory / reflection: no agent reflection. FreqAI saves model metadata/features/predictions for ML workflows (`freqtrade/freqai/data_drawer.py`), but checked `rg -n "memory|reflection|remember|lesson|rationale"` under `freqtrade/`; no decision memory/reflection.
  - Broker/execution integration: CCXT exchange abstraction for crypto. `Exchange.create_order()` calls `self._api.create_order(...)` in live mode and simulates dry-run orders in dry-run mode (`freqtrade/exchange/exchange.py:Exchange.create_order`, `freqtrade/exchange/exchange.py:Exchange.create_dry_run_order`).
  - LLM-agent nature: no. Classic algo/ML/RL bot; FreqAI includes RL model classes (`freqtrade/freqai/RL/BaseReinforcementLearningModel.py:BaseReinforcementLearningModel`) but no LLM decision loop.
- Verdict:
  - RUNTIME SKELETON CANDIDATE for crypto bot operation. It has the strongest long-running loop, dry-run/live switch, protections, and persistence; GPL and lack of LLM rationale/progressive human authorization are major constraints.

## agentkit

- License and language:
  - License: Apache-2.0 (`LICENSE.md`).
  - Primary language: TypeScript and Python (`typescript/agentkit/src/**/*.ts`, `python/coinbase-agentkit/coinbase_agentkit/**/*.py`).
- Architecture:
  - Library/toolkit that exposes wallet-bound onchain actions to agents; no bot loop.
  - TypeScript `AgentKit.from()` configures a wallet provider and action providers, defaulting to CDP smart wallet when no wallet is supplied (`typescript/agentkit/src/agentkit.ts:AgentKit.from`).
  - `ActionProvider.getActions()` binds decorated actions to a wallet provider (`typescript/agentkit/src/action-providers/actionProvider.ts:ActionProvider.getActions`); Python mirrors the same model (`python/coinbase-agentkit/coinbase_agentkit/agentkit.py:AgentKit`, `python/coinbase-agentkit/coinbase_agentkit/action_providers/action_provider.py:ActionProvider`).
  - The main loop, scheduling, and agent policy live outside the library.
- Steward-relevant machinery:
  - Long-running operation loop / scheduler: absent. Checked `rg -n "daemon|scheduler|while True|setInterval|cron"` under `typescript/agentkit/src` and `python/coinbase-agentkit/coinbase_agentkit`; no continuous runtime.
  - Risk boundaries: only local action validation/guardrails. ERC20 transfer checks balance and refuses transfers to token-contract destinations (`typescript/agentkit/src/action-providers/erc20/erc20ActionProvider.ts:ERC20ActionProvider.transfer`, `python/coinbase-agentkit/coinbase_agentkit/action_providers/erc20/erc20_action_provider.py:ERC20ActionProvider.transfer`); CDP swap checks network, liquidity, balance, allowance, and transaction receipt status (`typescript/agentkit/src/action-providers/cdp/cdpEvmWalletActionProvider.ts:CdpEvmWalletActionProvider.swap`). No portfolio limits, drawdown guard, or kill switch found via `rg -n "kill_switch|max_drawdown|position_limit|risk_limit|policy"`.
  - Approval / authorization flow: onchain allowance actions, not human approval. `ERC20ActionProvider.approve()` and CDP swap auto-approval send transactions (`typescript/agentkit/src/action-providers/erc20/erc20ActionProvider.ts:ERC20ActionProvider.approve`, `typescript/agentkit/src/action-providers/cdp/cdpEvmWalletActionProvider.ts:CdpEvmWalletActionProvider.swap`); checked `rg -n "human|manual approval|approval"` and found no pre-action human gate.
  - Auditability: transaction hashes returned, no durable audit log. Wallet/action methods return strings or JSON with transaction hashes (`typescript/agentkit/src/action-providers/wallet/walletActionProvider.ts:WalletActionProvider.nativeTransfer`, `typescript/agentkit/src/action-providers/cdp/cdpEvmWalletActionProvider.ts:CdpEvmWalletActionProvider.swap`); no append-only decision log found via `rg -n "audit|trace|memory|remember"`.
  - Memory / reflection: absent. Checked `rg -n "memory|reflection|remember|lesson|trace"` under TypeScript/Python core; no persistent decision memory.
  - Broker/execution integration: onchain wallet execution, not broker abstraction. `WalletProvider.nativeTransfer()` and `EvmWalletProvider.sendTransaction()` define signing/sending primitives (`typescript/agentkit/src/wallet-providers/walletProvider.ts:WalletProvider`, `typescript/agentkit/src/wallet-providers/evmWalletProvider.ts:EvmWalletProvider`); providers include CDP, Viem, Solana, Privy, ZeroDev, etc. via wallet-provider files.
  - LLM-agent nature: agent-facing tools, not an LLM itself. The library exposes actions for external frameworks; no model loop found via core source inspection.
- Verdict:
  - COMPONENT. Useful as an onchain execution/action adapter if a steward needs wallets/DeFi, but dangerous as a base runtime because it lacks scheduling, policy enforcement, approval, and audit memory.

## lumibot

- License and language:
  - License: GPL-3.0 (`LICENSE`).
  - Primary language: Python (`lumibot/**/*.py`).
- Architecture:
  - Trading framework with live/backtest strategy lifecycle, broker adapters, scheduler, and newer LLM-agent components.
  - `Trader.run_all()` validates live-vs-backtest mode, starts a `StrategyExecutor`, and joins it unless async (`lumibot/traders/trader.py:Trader.run_all`, `lumibot/traders/trader.py:Trader._start_pool`).
  - `StrategyExecutor._run_trading_session()` sets up market sessions, starts APScheduler for live trading, starts a background queue thread, and loops once per second while broker/scheduler/market conditions allow (`lumibot/strategies/strategy_executor.py:StrategyExecutor._run_trading_session`).
  - Orders are created through `Strategy.create_order()` and submitted directly to the active broker via `Strategy.submit_order()` (`lumibot/strategies/strategy.py:Strategy.create_order`, `lumibot/strategies/strategy.py:Strategy.submit_order`).
- Steward-relevant machinery:
  - Long-running operation loop / scheduler: yes. `StrategyExecutor._setup_live_trading_scheduler()` installs an APScheduler `OTIM` job for `_on_trading_iteration()`, and `_run_trading_session()` maintains the live loop (`lumibot/strategies/strategy_executor.py:StrategyExecutor._setup_live_trading_scheduler`, `lumibot/strategies/strategy_executor.py:StrategyExecutor._run_trading_session`).
  - Risk boundaries: order-level tools, weak global guardrails. `create_order()` supports stop, stop-limit, trailing stop, OCO, OTO, bracket, and smart-limit orders (`lumibot/strategies/strategy.py:Strategy.create_order`, `lumibot/entities/order.py:Order`); `submit_order()` handles SMART_LIMIT quote ladders/repricing (`lumibot/strategies/strategy.py:Strategy.submit_order`, `lumibot/strategies/strategy_executor.py:StrategyExecutor._process_smart_limit_orders`). Checked `rg -n "kill_switch|max_drawdown|daily_loss|loss_limit|position_limit|risk_limit|approval"` under `lumibot/`; max drawdown is reporting/tearsheet, not a live guard (`lumibot/tools/indicators.py:max_drawdown`).
  - Approval / authorization flow: no human-in-the-loop order gate. `submit_order()` validates an order and calls `self.broker.submit_order(order)` or `submit_orders()` (`lumibot/strategies/strategy.py:Strategy.submit_order`); paper/live is broker config for Alpaca/Tradier/Tradovate, not a progressive graduation flow (`lumibot/brokers/alpaca.py:Alpaca.__init__`, `lumibot/brokers/tradier.py:Tradier.__init__`, `lumibot/brokers/tradovate.py`).
  - Auditability: good backtest/trade/agent artifacts, mixed live durability. Broker initializes `_trade_event_log_rows` and can expose trade-event DataFrames (`lumibot/brokers/broker.py:Broker.__init__`, `lumibot/brokers/broker.py:Broker._trade_event_log_df`); `LUMIBOT_BACKTEST_AUDIT` adds richer cash/corporate-action rows (`lumibot/brokers/broker.py:Broker.record_cash_event`, `lumibot/brokers/broker.py:Broker.record_corporate_action_event`); `AgentHandle._write_trace()` and `_append_run_artifact_summary()` write JSON traces and JSONL run summaries (`lumibot/components/agents/manager.py:AgentHandle._write_trace`, `lumibot/components/agents/manager.py:AgentHandle._append_run_artifact_summary`).
  - Memory / reflection: present for LLM agents. `MemoryStore` is SQLite-backed append-only event/projection memory with decisions, proposals, risk notes, lessons, and theses (`lumibot/components/memory/store.py:MemoryStore`); `AgentHandle.run()` retrieves memory state and appends memory after runs/errors (`lumibot/components/agents/manager.py:AgentHandle.run`).
  - Broker/execution integration: broad broker abstraction. Broker files include Alpaca, Interactive Brokers, IBKR REST, Tradier, Schwab, CCXT, Bitunix, Tradovate, Polymarket, and ProjectX (`lumibot/brokers/*.py`); concrete submit methods exist per broker, e.g. Alpaca `_submit_order()`, CCXT `_submit_order()`, Interactive Brokers `_submit_order()` (`lumibot/brokers/alpaca.py:Alpaca._submit_order`, `lumibot/brokers/ccxt.py:Ccxt._submit_order`, `lumibot/brokers/interactive_brokers.py:InteractiveBrokers._submit_order`).
  - LLM-agent nature: optional yes. `AgentHandle.run()` builds prompts/tool surfaces, calls a runtime, records traces, warnings, usage, and errors, and returns no-op results on live provider failures (`lumibot/components/agents/manager.py:AgentHandle.run`, `lumibot/components/agents/runtime.py`); example strategies use LLM agents (`lumibot/example_strategies/ai_trading_team.py`, `lumibot/example_strategies/agent_m2_liquidity_openai.py`).
- Verdict:
  - COMPONENT / PARTIAL RUNTIME SKELETON. It is the closest project to combining a live trading loop, brokers, LLM-agent traces, and memory, but it is not conservative-by-default: hard portfolio risk gates and progressive human authorization must be added outside the current submit path.

## Ranked Shortlist

1. `freqtrade`
   - Best reusable long-running observe/act loop plus dry-run/live split, CCXT execution, protections, stoploss handling, pair/global locks, and order/trade persistence (`freqtrade/worker.py`, `freqtrade/freqtradebot.py`, `freqtrade/plugins/protections/*`, `freqtrade/exchange/exchange.py`, `freqtrade/persistence/*`).
   - Major gaps: GPL, crypto focus, no LLM reasoning/audit chain, no human approval/progressive authorization.

2. `hummingbot`
   - Best reusable daemon/exchange architecture for crypto market making: realtime clock, connector abstraction, paper-trade connector, recorder, kill switch, budget checker, and triple-barrier position executor (`hummingbot/core/clock.pyx`, `hummingbot/core/trading_core.py`, `hummingbot/core/utils/kill_switch.py`, `hummingbot/connector/budget_checker.py`, `hummingbot/connector/markets_recorder.py`, `hummingbot/strategy_v2/executors/position_executor/*`).
   - Major gaps: no LLM agent layer, no human approval, risk controls are bot/executor-level rather than steward policy-level.

3. `lumibot`
   - Best bridge between live broker runtime and LLM-agent observability/memory: APScheduler live strategy executor, many broker adapters, SQLite memory store, agent traces, and run summaries (`lumibot/strategies/strategy_executor.py`, `lumibot/brokers/*.py`, `lumibot/components/memory/store.py`, `lumibot/components/agents/manager.py`).
   - Major gaps: GPL, no deterministic global kill switch/drawdown guard, no pre-order approval gate, LLM agents are optional strategy components rather than a governed steward core.

Secondary component to mine: `TradingAgents` for multi-agent deliberation/reflection and decision logs (`tradingagents/graph/*`, `tradingagents/agents/utils/memory.py`), but not runtime skeleton code.

## Uncovered Gaps

- Progressive authorization state machine:
  - No repo implements staged authority such as observe-only -> propose-only -> paper -> small live -> expanded live with explicit human approvals, revocation, and limit escalation.

- Human pre-trade approval gate:
  - None combines proposed order, rationale, deterministic risk result, and broker order payload into a mandatory approve/reject flow before live execution.

- Steward-grade audit chain:
  - Bots persist orders/fills (`freqtrade`, `hummingbot`, `lumibot`) and LLM projects persist reasoning/traces (`TradingAgents`, `lumibot`), but no repo links observation -> LLM rationale -> risk checks -> approval -> order ID -> broker state in one tamper-evident append-only chain.

- Deterministic portfolio policy engine:
  - No project provides a conservative-by-default cross-asset policy engine with exposure caps, liquidity gates, correlated-risk limits, drawdown states, user mandate constraints, and forced de-risking independent of the strategy/LLM.

- Safe LLM-to-execution boundary:
  - No repo safely combines LLM decision-making with live order execution under hard deterministic constraints. Existing LLM systems are one-shot/research (`TradingAgents`, `FinRobot`, `RD-Agent`) or optional strategy helpers (`lumibot`).

- Outcome-aware live memory with governance:
  - TradingAgents and Lumibot have useful memory/reflection pieces, but no repo closes the loop from live decisions and realized outcomes into governed future behavior with audit, rollback, and review semantics.

- Custody and credential isolation:
  - No repo has a separated broker/custody process or hardware-wallet-style signer boundary for approvals and execution. AgentKit has wallet providers but not steward runtime isolation.

- Formal paper-to-live graduation:
  - `freqtrade` dry-run and `hummingbot`/`lumibot` paper/backtest modes are real, but no project defines formal promotion criteria, required review artifacts, or automatic rollback from live to paper after risk breaches.
