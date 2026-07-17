# Trading Agent capability reuse audit

Issue: [#264](https://github.com/a-green-hand-jack/OpenAlice/issues/264)
基线: `jieke/dev@399c0a6e`
参考分支: `issue-263-contract-version-fail-closed`

## 结论

OpenAlice 已经具备 Trading Agent Team 所需的执行、风控、持久会话、真实调度、恢复和评测主体。本 issue 不新增 runner、broker adapter、sizing、broker mutation 或第二套 harness。允许的实现仅限：

1. 把现有 `alice-lab` 的 stack child 从 dev Guardian 改接现有 production Guardian；
2. 把现有 `run-cell` wake 声明接到真实 `ScheduleScanner`；
3. 把 Team policy 作为受版本约束的 policy 输入，与 OpenAlice mechanics 组合，而不是替换 mechanics；
4. 在现有 wake -> Decision Intent -> ledger/artifact 链上补齐 v1 根委任与受任单元身份；
5. 给现有入口补 operator 文档和 fail-closed mode/authorization 检查。

除此之外的基础设施扩建均没有 reuse 证据，不应进入本 issue。

## 可执行真值表

| 能力 | 当前真源与测试/历史证据 | 判断 | 本 issue 动作 |
| --- | --- | --- | --- |
| Codex subscription OAuth | `src/workspaces/adapters/codex.ts:47-78` 明确默认不设置 `CODEX_HOME`，继承用户 `~/.codex/auth.json`；`composeHeadlessCommand` 在 `src/workspaces/adapters/codex.ts:119-145` 使用原生 `codex exec`。本机 `codex login status` 返回 `Logged in using ChatGPT`，环境无 `OPENAI_API_KEY`。 | 已存在 | 复用；operator preflight 必须验证 ChatGPT 登录并拒绝 API-key 环境。 |
| Claude subscription OAuth | `src/workspaces/adapters/claude.ts` 继承原生 Claude 配置；Docker 将 `HOME` 固定到持久卷 (`Dockerfile:110-123`)。 | 已存在；本轮不实跑 | 只文档化 `claude auth status`，真实验收固定 Codex。 |
| production Guardian | `scripts/guardian/prod.mjs:3-25` 是 Docker production entry；`scripts/guardian/prod.mjs:174-220` 启动 built UTA/Alice；`scripts/guardian/prod.mjs:236-280` 处理 UTA restart flag；`Dockerfile:128-131` 由 tini 托管；引入历史 `91b057a9`。 | 已存在 | 复用。`alice-lab` 当前 `tools/campaigns/lab.mjs:138-171` 却启动 `pnpm dev`，这是接线缺口。 |
| terminal 断开后的长期运行 | Docker Compose/tini 和 host system managers 已能托管 production Guardian。只读实测也证明不同 host 的 user-namespace/security 前置不同，不能写成产品依赖。 | 已存在的 OS/container supervisor 可复用 | repo canonical 仅保留 lab 和 production Guardian 命令；deployment manager 直接包装它们，不新增 repo daemon。 |
| persistent steward | `src/workspaces/service.ts` 暴露并实现 `dispatchStewardWake`；`src/workspaces/steward/wake-store.ts`、`ledger-store.ts`、`lock-store.ts`、`finalize-store.ts` 均落盘；`src/workspaces/service.ts:1231-1267` 启动 schedule/supervisor scanners。引入历史 `bdce1a8c`、`ccfb771c`。 | 已存在 | 复用，不新增 Team runtime。 |
| 真实 ScheduleScanner | `src/workspaces/schedule/scanner.ts:96-169` 是 production timer/scan loop；`src/workspaces/schedule/scanner.ts:203-220` 将 `kind: steward-wake` 路由到 persistent wake；`scanner.spec.ts` 覆盖 due/marker/dispatch。 | 已存在 | 仅让 `run-cell` 写现有 issue declaration 并等待 scanner，不自行 tick。 |
| headless fallback | `src/workspaces/service.ts:587-737` 使用同一 spawn env/tool injection 执行 headless task；schedule 的普通 issue 路由复用该入口。 | 已存在 | 不用于 v1 trading wake 主链，不删除。 |
| observation/tool injection | `src/workspaces/service.ts:587-632` 的 headless 与 PTY 共用 `composeSpawnInputs`；`src/main.ts:101-154` 注册 ToolCenter、workspace tools 和 UTA SDK；workspace CLI shims 通过 `OPENALICE_TOOL_BASE_URL` 接入。 | 已存在 | 复用。 |
| `alice-uta` -> UTA | `src/services/uta-client/` 通过 `@traderalice/uta-protocol` HTTP client；`src/main.ts:115-154` 绑定 UTA；`src/webui/routes/trading-proxy.ts` 转发 Guardian internal token。 | 已存在 | 不新增 execution bridge。 |
| UTA -> TradingGit -> Risk Envelope/guards -> broker | `services/uta/src/domain/trading/uta-manager.ts` 是账户边界；`git/TradingGit.ts` 是账本真源；`risk-envelope.ts` 与 `guards/` 执行硬约束；`packages/uta-protocol/src/schemas/steward-mutation.ts:84-178` 定义 fail-closed mutation boundary 与 source-version barrier；相关 specs 覆盖 identity mismatch、envelope change、idempotency 和 recovery。 | 已存在 | 复用，不把 sizing 或 mutation 搬回 Alice/Team。 |
| mock adapter | `services/uta/src/domain/trading/brokers/mock/MockBroker.ts`；`run-cell.mjs` 使用 `mock-simulator` 并创建 paper-ceiling Risk Envelope；`scripts/run-cell-risk-envelope.spec.ts` 锁定 payload。 | 已存在 | isolated mock 验收唯一允许 adapter。 |
| paper/live adapters | `brokers/alpaca/`、`brokers/ibkr/`、`brokers/ccxt/`、`brokers/longbridge/` 与 preset catalog 已存在；`docs/uta-live-testing.md` 定义真实 venue 验收规则。 | 已存在；禁止本轮实跑 | 只通过既有 account preset/adapter 选择表达，默认拒绝 live，不能新增 adapter。 |
| Evaluation Harness | `src/workspaces/steward/evaluation-harness.ts`、`evaluation-data-manifest.ts`、`evaluation-provenance-store.ts` 是纯评测/溯源契约；`tools/campaigns/run-cell.mjs` 是单 cell 端到端路径；`tools/campaigns/lab.mjs` 是现有单命令 matrix orchestration；引入历史 `788e4639`、`fbfa91b5`。 | 已存在 | 正式化现有入口；不新增第二套 harness。 |
| ledger-backed terminal outcome | `types.ts` v3 ledger schema、`validate-ledger.mjs`、finalize marker、ledger receipt 和 supervisor reconciliation 已存在；`run-cell.mjs:418-509` 以 ledger-backed wake 集合做 trust gate。 | 已存在 | 身份字段沿该链扩展；每 wake artifact 继续来自 `result.json`/ledger，不造旁路。 |
| root mandate / entrusted-unit identity | 当前 wake envelope 只有 reason/account/authz/context (`src/workspaces/steward/types.ts:119-150`)；Decision Intent 只有目标/证据/snapshot (`types.ts:385-427`)。没有 mandate id、entrusted-unit id、scope/validity/heartbeat contract，也没有 intent 身份戳。 | 真正缺失 | 只实现 v1 根委任 -> 一个交易受任单元 -> Trade Intent 的最小 schema/binding；不实现 Delegation Intent runtime 或树。 |
| Team policy/mechanics 分离 | 当前主线 overlay 可替换整份 `instruction.md` (`src/workspaces/template-registry.ts`)；Team repo `main@dfae5fa` 已只提供 `template.json` contract v1 + `files/policy.md`。两边目前不兼容。 | 真正缺失 | 复用参考提交的 policy composition 思路，未知版本/额外文件 fail closed；platform mechanics 永远保留。 |
| canonical operator guide | `docs/trading-agent-operator-guide.zh.md` 不存在；现有 campaign README 仍写 dev stack。 | 真正缺失 | 新增唯一 operator guide；不改 public `README.md`。 |

## Reference branch 逐提交裁决

### `961e7eb9` - 选择性复用

接受：

- `policy.md` + `contractVersion: 1` 的 fail-closed overlay shape；
- policy 与 OpenAlice mechanics 组合，policy 不能替换 authz/Risk Envelope/ledger/wake mechanics；
- built-in instruction 恢复 controlled `alice-uta` mechanics，同时默认 proposal-only，只有外部 policy 明确授权才可执行。

拒绝整提交照搬：文档行号与 D4 描述需按 #264 的 operator/evaluation 结论重写；测试只保留能证明边界的最小集合。

### `0ae0df95` - 不复用生成证据包

该提交主要保存 D4 generated runner/markdown evidence。它证明历史证据可追溯，但把 800+ 行生成 runner 放回 repo 会强化第二套 harness 的误解。OpenAlice 已有 `evaluation-provenance-store` 与 campaign artifact；仅保留“policy 不能成为 mechanics authority、provenance 不得丢失”的原则，不引入该提交的 generated artifacts。

### `d8ce21df` - 选择性复用

接受：

- `dispatch: scheduled` 配置；
- 由 `run-cell` 写 `kind: steward-wake` issue，再等待真实 `ScheduleScanner` 产生 wake；
- scheduled run 必须具有预期数量的 ledger-backed terminal wakes。

需要修正：该提交仍由 `alice-lab` 启动 `pnpm dev`，不满足 production Guardian；scheduled issue 还需带 v1 mandate/entrusted-unit identity。

### `48d91cc5` - 复用

接受 run-id/issue-id 的保守字符集与 traversal 防护。scheduled declaration 写文件前必须验证 id；这是安全边界，不是新 runtime。

## 第二次 durability reuse gate

监督核验把 host `setsid` 路径判定为真实验收失败：即使 scheduler 链已产生至少三个
ledger-backed terminal artifacts，该路径不能可靠证明命令返回/终端断开后的长期
存活；`runtime.json` 还把新 `status: running` 与旧 `stoppedAt/exitCode` 合并。

重新追踪得到：

- `docker-compose.yml` 从 `fd084da9` 起就是产品 detached 入口，明确
  `restart: unless-stopped`；
- `Dockerfile` 从 `91b057a9` 起以 tini 为 PID 1，并把
  `scripts/guardian/prod.mjs` 作为 CMD；
- `scripts/guardian/prod.mjs` 仍是唯一 Alice/UTA production supervisor，持有
  restart flag recovery；
- `alice-lab` 已是唯一 Evaluation Harness operator，不应复制。

detached Compose 探针随后证明 production compatibility 缺口：Codex subscription turn
能完成，但 Docker 默认 namespace policy 下 bundled/system bubblewrap 都不能写 steward
draft；该 run ledger 为 0，已明确判失败并归档。一次性探针证明只有同时授予
`SYS_ADMIN`、`seccomp=unconfined`、`apparmor=unconfined` 才能建立 namespace。该组合
扩大容器逃逸面，安全审查拒绝，因此删除 acceptance compose，不把危险配置发布给
paper/live。

继续 reuse gate 后确认：OpenAlice 的 repo-owned 进程入口仍只是
`node tools/campaigns/lab.mjs run <experiment>` 和 `node scripts/guardian/prod.mjs`。
systemd/container、linger、user namespace 和安全 profile 均是 host deployment 前置，
不得写成 OpenAlice canonical product dependency。host manager 托管时应直接包装
这两个既有命令，不新增 daemon/supervisor。unit/container state 是进程存活
真源；`runtime.json` 只是 lab artifact，并以原子写与启动时清空 stale
terminal 字段避免误导。

## 第五次验收纠偏：UTA checklist false green

2026-07-16T21:32:32Z 的 canonical user-systemd run 真实完成了 5 次
ScheduleScanner wake、ledger set equality、心跳与 wake 3 后的 Guardian/UTA recovery，
但五次决策都是 `blocked`，且 account/positions/orders/risk/market/history
全部因 `crypto is not defined` 失败。因此该 run 是 fail-closed 调度/审计证据，
不是 #264 无摩擦验收；其已写入的 `scheduledVerification.verified=true`和
summary `status=ok` 是错误分类，不得作为完成证据。

首个真实失败点不在 UTA/broker adapter，而在 Alice 已有 CLI/MCP 共享 bridge：

- `src/server/cli.ts` 复用 `src/core/mcp-export.ts` 的 `wrapToolExecute`；
- `wrapToolExecute` 在 ESM 内直接调用未导入的 `crypto.randomUUID()`，还没有
  进入任何 trading tool/UTA HTTP call 就抛错；
- canonical `systemd-run` 的 user-manager `PATH` 没有 Linuxbrew，`/usr/bin/env node`
  选中 `/usr/bin/node v18.19.1`。该版本在真实 `.mjs` 文件中
  `globalThis.crypto === undefined`；
- 交互 shell/dev 中 `node` 解析为 Linuxbrew v26.4.0，ESM 全局 WebCrypto 存在，
  所以 host 观察未复现。

最小兼容修复是与 repo 其他文件一致，从 `node:crypto` 显式导入
`randomUUID`；不新增 adapter、fallback 或 execution bridge。同时 campaign verifier
必须要求每个 trading wake 的六项 UTA checklist 命中逐字段 success allowlist：
account/positions/orders 只接受 `ok`，risk 接受 `ok|normal`，market 接受
`ok|open|closed`，history 接受 `ok|checked`。`blocked` 仍可以是合法的
risk/authz 决策，但 checklist 的 `skipped`/`blocked`/任意字符串/错误值全部
判基础设施失败。用修正后的分类器重放上述 artifact 得到
`effectiveVerified=false`。

## 最终策略边界与 D4 冻结证据

最终审查确认 built-in steward instruction 与 campaign market note 仍复制了 Team 的
交易判断、参与偏置和仓位区间。这不是 platform mechanics。现已从 OpenAlice 运行路径
删除；built-in instruction 只保留 workspace/wake/mandate/Trade Intent、UTA checklist、
controlled `alice-uta`、ledger/finalization/recovery/safety，以及没有外部政策时的
proposal-only/fail-closed 默认。Team policy 只通过既有 versioned policy overlay 组合。

D4 Smoke 是历史冻结证据，不是当前 steward instruction 的 execution truth。其 approved
instruction 仍绑定 baseline commit `c8071ebf` 的 Git blob 与既有 sha256；不更新
manifest、approved hash、runner 或 runtime tree。D4 test fixture 从该 Git blob 取冻结
bytes。会把当前 worktree instruction 当作 v9 prompt 的旧 `--verify` 入口明确保持
fail-closed/retired，避免把新 mechanics 冒充旧 approved prompt。

## 模式与 adapter 边界

- `isolated-mock`: Evaluation Harness 创建临时 `mock-simulator` account、paper ceiling Risk Envelope 和隔离 workspace；允许自动清理；本 issue 只实跑该模式。
- `paper`: 使用已由操作者配置的既有 paper account preset；同一 Team policy、mandate、wake、Trade Intent、UTA/TradingGit/guards/ledger 接口；OpenAlice 不模拟 venue，不新增 adapter。
- `live`: 使用既有 live account preset；默认禁止。只有显式 live authorization、非撤销 Risk Envelope、匹配的 account/mandate scope 与 operator 文档中的升级门同时成立才允许启动。

OpenAlice 的 `OPENALICE_TRADING_MODE=pro` 只表示 UTA 可用，不是 live 授权，也不是 adapter 选择。adapter 由既有 UTA account preset 决定。

## 停止条件与冻结建议

完成条件是：production Guardian + real ScheduleScanner + persistent steward + Codex
subscription OAuth 在 isolated mock 上完成五次 ledger-backed wake，六项 UTA
checklist 全部命中逐字段 success allowlist，wake 3 后恢复并继续，artifact
可机器读取，最终无孤儿进程。盈利不参与判断。

通过后，prompt/model/strategy/role/participation/profitability 只改 Team repo 或 experiment config。只有通用 lifecycle/schedule/recovery/security/audit 缺陷、既有 adapter 兼容缺陷、安全/数据损坏，或新的 reuse audit 证明现有能力无法表达，才重开 OpenAlice 基础设施。
