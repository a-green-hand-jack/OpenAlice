# Persistent Wake Loop Backtest Appendix

> 目的：把 PR #72 的 manual/API wake seam 从「单次 stdin smoke」推进到
> 「多周期、同一 live session、同一 transcript」的可复现验收路径。

## 1. 验证对象

脚本：

```bash
node tools/persistent-wake-loop-backtest.mjs \
  --base http://127.0.0.1:48731 \
  --campaign-dir /tmp/.../scratchpad/campaign \
  --want 2,4,4
```

它复用既有 campaign 的缓存行情窗口与 regime-aware 判据（6 周 × 5 日线，
6 个决策点）。区别是 dispatch 不再调用
`POST /api/workspaces/:id/headless`，而是：

1. 每个 cell 创建一个 mock/paper UTA account 与一个 shell workspace。
2. 启动一个 live shell PTY session。
3. 在这个 PTY 中启动一个长驻 Node runner。
4. 每个决策周期通过
   `POST /api/workspaces/:id/sessions/:sid/wake` 注入一行 JSON wake envelope。
5. runner 在同一进程里跑固定 UTA checklist：
   `alice-uta git log`、`account info`、`account portfolio`、`git status`，
   然后输出 `no_trade` 或 `propose_trade:*`，必要时通过 `alice-uta` 提交
   paper trade。

结果 JSON 会记录每个 cell 的 `wsId`、`sessionId`、PTY `pid`、runner `pid`、
6 次 wake 的 pid 列表、transcript marker 数量、收益/回撤与 PASS/WEAK/FAIL。

## 2. 证明边界

这条 harness 证明的是 **Mode 1b runtime/wake-loop plumbing**：

- 同一个 `sessionId` 接收多个 `/wake`。
- 同一个 PTY `pid` 在多个 wake 之间保持不变。
- 同一个 runner `pid` 在多个 wake 之间保持不变。
- 同一条 PTY transcript 中出现每轮 `PWAKE_DONE <cell> <week>` marker。
- 每轮不是 `/headless`，不会为每个交易点重新开 `codex exec`。

它不声称证明 Codex interactive steward 的完整交易质量。原因是当前 Codex
交互 TUI 只通过 PTY 输出 raw terminal bytes，没有像 headless JSON/exit code 那样
稳定的「本轮完成」事件；要自动跑 60 个周期会落到脆弱的屏幕解析、超时猜测和
不可控模型成本。Codex 的 Mode 1b 生产回测需要后续补一个机器可判停的 interactive
turn protocol 或 steward-side decision ledger/watchdog。

因此验收要分三层读：

| 层 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| Runtime wake smoke | `/wake` 能写入 live PTY stdin 并触发真实执行 | 多周期 campaign 行为 |
| Persistent wake-loop harness | 同一 live session/pid/transcript 跑完整 6 周周期 | Codex TUI 的自动判停与 LLM 决策质量 |
| 旧 headless stress | 既有 campaign/UTA/headless 兼容性 | Mode 1b；它每周期仍是 `/headless` |

## 3. 运行建议

先跑单 cell smoke：

```bash
node tools/persistent-wake-loop-backtest.mjs \
  --base http://127.0.0.1:48731 \
  --campaign-dir /tmp/.../scratchpad/campaign \
  --limit 1
```

再跑完整 10-cell campaign：

```bash
node tools/persistent-wake-loop-backtest.mjs \
  --base http://127.0.0.1:48731 \
  --campaign-dir /tmp/.../scratchpad/campaign \
  --want 2,4,4
```

推荐用隔离 dev stack：

```bash
OPENALICE_HOME=/tmp/openalice-pwake-home \
AQ_LAUNCHER_ROOT=/tmp/openalice-pwake-workspaces \
OPENALICE_WEB_PORT=48731 \
OPENALICE_MCP_PORT=48732 \
OPENALICE_UTA_PORT=48733 \
OPENALICE_UI_PORT=5873 \
pnpm dev
```

账户只用 `mock-simulator` paper account；脚本结束默认删除 workspace 与 account。
需要事后检查时加 `--keep`。

## 4. 本 PR 验证记录

运行环境：隔离 dev stack，`OPENALICE_HOME=/tmp/openalice-codex-wake-1783459861/home`，
`AQ_LAUNCHER_ROOT=/tmp/openalice-codex-wake-1783459861/workspaces`，
UTA/mock-simulator paper，backend 指向本 PR worktree。

额外 Codex smoke：真实 Codex interactive session 的第二轮 `/wake` 已验证可提交。
关键发现是 Codex TUI 不可靠接受单个 `message + "\r"` PTY chunk；默认 wake route
因此改为先写 message，短暂停顿，再写 terminal Enter（CR）。验证 marker：
`CODEX_READY_SPLIT_1783461618087` -> `CODEX_WAKE_SPLIT_1783461618087`，
同一 session `codex-simple-canvas-cloud`，PTY pid `2904068`。

Smoke：

```bash
node tools/persistent-wake-loop-backtest.mjs \
  --base http://127.0.0.1:49231 \
  --campaign-dir /tmp/claude-1000/-home-user-Projects-OpenAlice/75e8bbb3-d2d1-43a5-8f22-da152c2c22ac/scratchpad/campaign \
  --token <admin-token> \
  --limit 1
```

结果：`pwake-20260707220135`，1/1 cell 完成，6/6 wake 均保持同一
`sessionId` / PTY `pid` / runner `pid` / transcript marker，chop/NVDA PASS。

Full persistent wake-loop campaign：

```bash
node tools/persistent-wake-loop-backtest.mjs \
  --base http://127.0.0.1:49231 \
  --campaign-dir /tmp/claude-1000/-home-user-Projects-OpenAlice/75e8bbb3-d2d1-43a5-8f22-da152c2c22ac/scratchpad/campaign \
  --token <admin-token> \
  --want 2,4,4
```

结果文件：
`/tmp/claude-1000/-home-user-Projects-OpenAlice/75e8bbb3-d2d1-43a5-8f22-da152c2c22ac/scratchpad/campaign/persistent-wake-results/pwake-20260707220217.json`

汇总：

| Regime | 完成 | PASS | WEAK | FAIL | 证明状态 |
| --- | ---: | ---: | ---: | ---: | --- |
| bull | 2/2 | 1 | 1 | 0 | 所有 cell 均稳定同 session/pid/transcript |
| bear | 4/4 | 4 | 0 | 0 | 所有 cell 均稳定同 session/pid/transcript |
| chop | 4/4 | 3 | 0 | 1 | 所有 cell 均稳定同 session/pid/transcript |

逐 cell 的 `session.stableSession`、`session.stableRunner`、
`session.transcriptHasDoneMarkers` 全为 `true`，每个 cell 都是 6 次 `/wake`，
全量 10 cells 共 60 次 wake。
性能层面 `pw-bull-nvda` 为 WEAK、`pw-chop-tsla` 为 FAIL；这反映 shell proving
runner 的简单确定性 tape policy，不是 PR #72 wake seam 的 runtime 失败。
