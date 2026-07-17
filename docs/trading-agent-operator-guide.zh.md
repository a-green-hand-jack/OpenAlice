# Trading Agent Operator Guide

本页是 Trading Agent 的唯一操作者入口。OpenAlice 只提供两个已有 lifecycle：
有限 isolated evaluation 走 `lab -> run-cell`；长期 paper/live 走
`production Guardian -> ScheduleScanner -> persistent steward`。不存在统一 selector
或第三个 runner。

## 1. 安全边界

- 首轮验收只运行 `isolated-mock`；不运行 paper/live、外部 broker、
  holdout、persistent real account 或真实资金。
- paper 与 live 只由已持久化 account 的 `presetId`/`presetConfig.mode`
  选择 broker adapter。`OPENALICE_TRADING_MODE=pro` 不是 live 授权。
- 缺失/撤销 Risk Envelope、过期 mandate、scope/account 不匹配、authz 不足、
  guard 拒绝、未知 Team policy contract 或多余 overlay 文件都 fail closed。
- 盈利、参与率和交易次数不是基础设施验收条件。正常 UTA 读取后的
  `no_trade` 有效；UTA checklist 失败导致的 `blocked` 无效。

## 2. 共享配置与前置

Codex 必须使用 ChatGPT subscription OAuth，不得设置 `OPENAI_API_KEY`：

```bash
test -z "${OPENAI_API_KEY+x}" && env -u OPENAI_API_KEY codex login status
```

预期包含 `Logged in using ChatGPT`。Claude 对应检查为 `claude auth status`。
首轮 canonical mock 固定使用 Codex。

Team policy overlay 是操作者提供的部署输入，不是 OpenAlice 私有路径：

```bash
export AQ_TEMPLATE_OVERLAY_DIR="<TRADING_TEAM_REPO>/openalice-template-overlays"
```

overlay 必须只含 `steward/template.json` 和 `steward/files/policy.md`，并声明
contract v1。运行前构建 production artifacts：`pnpm build`。

`experiments/issue-264-isolated-mock.json` 定义 isolated evaluation 的唯一 root
mandate、资本上限、scope、有效期、心跳、五次 scheduled wake 与 wake 3
后恢复点。paper/live 复用同一 mandate/observation/Trade Intent 契约，但
account、workspace authz、recurring `steward-wake` declaration 均由现有持久化
配置面管理。

### Experiment config 字段

| 字段 | 含义 |
| --- | --- |
| `name` | 安全的实验/产物 id |
| `weeks` / `rounds` | 每个 run 的 wake 数、每个 cell 的重复次数 |
| `cells` | `tools/campaigns/cells/` 中的非 holdout cell id |
| `arms` | 受任单元实例；v1 为 `{id, agent:"codex", model}`，可选 `overlayDir` |
| `maxRuns` | `arms * cells * rounds` 的硬上限 |
| `basePort` | isolated Guardian 端口块起点；省略时为 `49631` |
| `allowHoldout` | holdout 显式门；首轮必须为 `false` |
| `dispatch` | `direct` 或复用真实 ScheduleScanner 的 `scheduled` |
| `restartAfterWake` | 可选 UTA recovery 检查点，范围 `1..weeks-1` |
| `mandate` | scheduled 必需的 root mandate：id、受任单元、资本、有效期、心跳 |

最小 isolated-mock 示例：

```json
{
  "name": "issue-264-isolated-mock",
  "weeks": 5,
  "rounds": 1,
  "cells": ["dev-chop-spy"],
  "arms": [{ "id": "team-v1", "agent": "codex", "model": "gpt-5.5" }],
  "maxRuns": 1,
  "allowHoldout": false,
  "dispatch": "scheduled",
  "restartAfterWake": 3,
  "mandate": {
    "id": "root-issue-264",
    "entrustedUnitId": "trading-team-v1",
    "capital": { "currency": "USD", "limit": "100000" },
    "validForMs": 86400000,
    "heartbeat": { "intervalMs": 3600000, "graceMs": 300000 }
  }
}
```

## 3. Repo-owned Commands

### Isolated evaluation

```bash
env -u OPENAI_API_KEY node tools/campaigns/lab.mjs run ./experiments/issue-264-isolated-mock.json
```

lab 只创建 isolated `mock-simulator` account/workspace，使用 production Guardian、
真实 ScheduleScanner、persistent steward、UTA/TradingGit/Risk Envelope/ledger，
完成后拆除该 isolated stack。

### Paper / live

```bash
env -u OPENAI_API_KEY node scripts/guardian/prod.mjs
```

该命令不选择 paper 或 live。选择只来自已存在 account 的 broker preset/
mode，并受 account/workspace authz、Risk Envelope、mandate 与 Team policy 共同约束。
live 还必须有操作者独立授权与 venue checklist。本 issue 不实跑 paper/live。

## 4. Host Deployment Examples

OpenAlice 不依赖 systemd、特定 AppArmor profile、特定 worktree 或私有绝对路径。
主机管理员可用现有 system manager 包装上述 repo command。Linux user-systemd
示例：

```bash
systemd-run --user --unit=openalice-isolated-eval --collect --same-dir --property=KillMode=mixed --setenv=AQ_TEMPLATE_OVERLAY_DIR="$AQ_TEMPLATE_OVERLAY_DIR" /usr/bin/env -u OPENAI_API_KEY "$(command -v node)" tools/campaigns/lab.mjs run ./experiments/issue-264-isolated-mock.json
```

```bash
systemd-run --user --unit=openalice-trading-agent --collect --same-dir --property=Restart=on-failure --property=RestartSec=5s --property=KillMode=mixed --setenv=AQ_TEMPLATE_OVERLAY_DIR="$AQ_TEMPLATE_OVERLAY_DIR" /usr/bin/env -u OPENAI_API_KEY "$(command -v node)" scripts/guardian/prod.mjs
```

跨 logout/reboot 的 linger、container security policy、user namespace 和 service account 是
主机部署前置，不由 OpenAlice 修改。

## 5. Status / Health / Logs / Artifacts

repo 进程健康：`curl -fsS http://127.0.0.1:47331/api/version`。systemd 部署可用
`systemctl --user status <UNIT>` 和 `journalctl --user-unit <UNIT> -f`；unit state 是存活
真值，`runtime.json` 只是 lab 最后成功落盘的 artifact。

isolated artifacts：

```bash
jq '{oauth,totals,exitCode}' tools/campaigns/runs/issue-264-isolated-mock/summary.json
jq '{dispatch,scheduledVerification,restartRecovery,mandate,weeks,trustworthy}' tools/campaigns/runs/issue-264-isolated-mock-team-v1-dev-chop-spy-r1/result.json
```

有效验收要求 `terminalLedgerBackedWakes=5`、`trustworthy=true`，且
`heartbeatVerified`、`intentIdentityVerified`、`utaChecklistVerified`、
`recoveryVerified`、`verified` 全为 `true`。checklist 只接受：

- account/positions/orders: `ok`
- risk: `ok` / `normal`
- market: `ok` / `open` / `closed`
- history: `ok` / `checked`

其他任意值都是 infrastructure failure。非空 Trade Intent 必须包含与 wake
mandate 完全相同的 `mandateId` 和 `entrustedUnitId`。

## 6. Stop / Recovery / Cleanup

前台 repo command 使用 `Ctrl-C`；systemd 部署使用 `systemctl --user stop <UNIT>`。
isolated run 会在 wake 3 后触发现有 `restart-uta.flag`，必须在 Guardian 恢复
UTA/account 后继续 wake 4/5。最终检查 unit 已停止、健康端口已关闭，
且没有 lab/Guardian/Alice/UTA 孤儿进程。

## 7. False-green Incident

2026-07-16 首次 5-wake run 的 scheduler、ledger、heartbeat 和 recovery 虽然通过，
但 Node 18 ESM 中未导入的 `crypto.randomUUID()` 使六项 UTA checklist 全部
失败。旧 verifier 误报 `verified=true`。修正后的 verifier 使用上述逐字段
success allowlist，防止 ledger-backed `blocked` 掩盖不可用的 UTA 路径。

## 8. Infrastructure Freeze

验收通过后，prompt/model/strategy/role/participation/profitability 只改 Team repo
或 experiment config。只有通用 lifecycle/schedule/recovery/security/audit 缺陷、真实
adapter 兼容缺陷、安全/数据损坏，或 reuse audit 证明现有能力无法表达时，
才重开 OpenAlice 基础设施。
