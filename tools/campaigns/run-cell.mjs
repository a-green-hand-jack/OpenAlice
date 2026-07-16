#!/usr/bin/env node
/**
 * Campaign step 2 — drive ONE cell end-to-end through the persistent-wake
 * steward mechanism against real (anonymized) historical bars.
 *
 * For a cell built by fetch-and-classify.mjs this script:
 *   1. creates a mock-simulator UTA (start cash 100k) with hard guards
 *      (max-drawdown / max-position-size) and lifts its maxAuthzLevel to `paper`
 *      so paper auto-push (P3-4a) executes the agent's commits;
 *   2. injects the anonymized daily series into the MockBroker so getQuote and
 *      the intra-week TP/SL protective-leg fills use it;
 *   3. creates a BLIND (#66) steward workspace running the selected agent/model, with
 *      the mock account whitelisted as the only allowed bar source, and lifts
 *      the workspace authz to `paper`;
 *   4. runs WEEKS weekly decision cycles: step the sim clock day-by-day through
 *      the week (firing any pending protective legs), then POST a steward wake
 *      whose marketContext carries the visible-so-far anonymized OHLCV, poll the
 *      supervisor until the wake reaches a terminal state, and snapshot equity;
 *   5. writes every artifact (ledger, wake records, supervisor state, per-week
 *      snapshots, computed metrics) to tools/campaigns/runs/<runId>/ (gitignored).
 *
 * Parallel-run note: deleting a mock UTA triggers a Guardian/UTA restart. If
 * multiple cells are running at once, one cell's early cleanup can reset the
 * other cells' in-memory MockBroker positions and injected bars. For parallel
 * experiments, run each cell with --keep, wait for all result.json files, then
 * delete the kept workspaces/accounts as a final batch.
 *
 * The agent's identity seal is enforced at the tool layer by blind mode; the
 * price series it reasons over is anonymized (day-0=100, fictional day index).
 *
 * Usage:
 *   node tools/campaigns/run-cell.mjs --cell tools/campaigns/cells/bull-cx.json \
 *     --base http://127.0.0.1:49631 --log /tmp/issue99-dev.log
 *
 * Auth (first match wins): --cookie <c> | --token <t> | --log <devlog> .
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  WEEKS, BARS_PER_WEEK, WINDOW_LEN, START_CASH, HAIKU_PRICE,
  sleep, maxDrawdown, regimeVerdict, maxWeeklyLongReturnUnderExposure, login, makeClient, tokenFromLog,
  finalizationTrust, buildCampaignAccountCreatePayload, shouldCleanup,
} from './_lib.mjs';

// Fictional sim-clock epoch: day 0 → 2020-01-01, +1 day per bar. Keeps the
// injected series date-anonymized while giving the MockBroker a monotonic clock.
const BASE_MS = Date.UTC(2020, 0, 1);
const DAY_MS = 86_400_000;
const dayToMs = (day) => BASE_MS + day * DAY_MS;

function parseArgs(argv) {
  const out = {
    base: process.env.OPENALICE_BASE_URL ?? 'http://127.0.0.1:49631',
    log: '/tmp/issue99-dev.log',
    agent: 'codex',
    model: null,
    maxDdPct: 10,
    maxPosPct: 60,
    weeks: WEEKS,
    deadlineMs: 600_000,
    pollMs: 8_000,
    wakeTimeoutMs: 720_000,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`missing value for ${a}`); return v; };
    if (a === '--cell') out.cell = next();
    else if (a === '--base') out.base = next().replace(/\/+$/, '');
    else if (a === '--cookie') out.cookie = next();
    else if (a === '--token') out.token = next();
    else if (a === '--log') out.log = next();
    else if (a === '--run-id') out.runId = next();
    else if (a === '--agent') out.agent = next();
    else if (a === '--model') out.model = next();
    else if (a === '--weeks') out.weeks = Number(next());
    else if (a === '--max-dd-pct') out.maxDdPct = Number(next());
    else if (a === '--max-pos-pct') out.maxPosPct = Number(next());
    else if (a === '--deadline-ms') out.deadlineMs = Number(next());
    else if (a === '--poll-ms') out.pollMs = Number(next());
    else if (a === '--wake-timeout-ms') out.wakeTimeoutMs = Number(next());
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') { console.log('see file header for usage'); process.exit(0); }
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.cell) throw new Error('--cell required');
  out.wakeTimeoutMs = Math.max(out.wakeTimeoutMs, out.deadlineMs + (out.pollMs * 2));
  return out;
}

const nowStamp = () => new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
function log(msg) { process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`); }
function workspaceTag(runId) {
  const hash = createHash('sha1').update(runId).digest('hex').slice(0, 6);
  const stem = `campaign-${runId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, 'c')
    .slice(0, 26)
    .replace(/[-_]+$/, '') || 'campaign';
  return `${stem}-${hash}`;
}

async function resolveCookie(opts) {
  if (opts.cookie) return opts.cookie;
  let token = opts.token;
  if (!token && opts.log && existsSync(opts.log)) token = tokenFromLog(readFileSync(opts.log, 'utf8'));
  if (!token) throw new Error('no auth: pass --cookie, --token, or a --log containing the first-run admin token');
  return login(opts.base, token);
}

/**
 * Wait for a UTA to be live. A config mutation (create/edit) triggers a
 * Guardian-mediated UTA restart (flag-file protocol), so the account 404s for a
 * few seconds mid-restart — hence the tolerant retry loop with a short
 * per-probe timeout (a wedged proxy can't stall the whole wait).
 */
async function waitAccountLive(c, id, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try { await c.get(`/api/trading/uta/${id}/account`, 5_000); return; }
    catch (err) { last = err.message; await sleep(2000); }
  }
  throw new Error(`account ${id} never became live: ${last}`);
}

/**
 * Wait until a UTA is *stably* live — a config mutation kicks off an async
 * Guardian restart, and `waitAccountLive` can return in the brief window after
 * the flag is written but before the restart lands. Sleeping first, then
 * requiring N consecutive OK probes, guarantees the restart has completed and
 * the (fresh) MockBroker instance is the one we then inject bars into.
 */
async function waitStable(c, id, { need = 4, gapMs = 1500, preSleepMs = 4000 } = {}) {
  await sleep(preSleepMs);
  const deadline = Date.now() + 90_000;
  let ok = 0, last = '';
  while (Date.now() < deadline && ok < need) {
    try { await c.get(`/api/trading/uta/${id}/account`, 5_000); ok++; }
    catch (err) { ok = 0; last = err.message; }
    if (ok < need) await sleep(gapMs);
  }
  if (ok < need) throw new Error(`account ${id} never stabilized: ${last}`);
}

async function netLiquidation(c, id) {
  const acct = await getAccountWithRestartTolerance(c, id);
  const nl = Number(acct.netLiquidation ?? acct.netLiquidationValue ?? acct.equity);
  return Number.isFinite(nl) ? nl : NaN;
}

async function getAccountWithRestartTolerance(c, id, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    await c.post(`/api/trading/uta/${id}/sync`, { delayMs: 150 }).catch(() => undefined);
    try {
      return await c.get(`/api/trading/uta/${id}/account`, 5_000);
    } catch (err) {
      last = err.message;
      await sleep(2000);
    }
  }
  throw new Error(`account ${id} unavailable while reading equity: ${last}`);
}

async function positionQty(c, id) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const body = await c.get(`/api/trading/uta/${id}/positions`, 5_000);
      const arr = Array.isArray(body) ? body : body?.positions ?? [];
      return arr.reduce((s, p) => s + Math.abs(Number(p.quantity ?? p.totalQuantity ?? 0)), 0);
    } catch {
      await sleep(2000);
    }
  }
  return null;
}

/** Read + sum native agent transcript token usage for a workspace. */
function transcriptCost(agent, wsDir) {
  if (agent === 'codex') return codexTranscriptUsage(wsDir);
  const projectKey = resolve(wsDir).replaceAll('/', '-').replaceAll('.', '-');
  const dir = join(homedir(), '.claude', 'projects', projectKey);
  const tally = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, files: [] };
  if (!existsSync(dir)) return { ...tally, transcriptDir: dir, found: false };
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    tally.files.push(f);
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      const u = evt?.message?.usage ?? evt?.usage;
      if (!u) continue;
      tally.inputTokens += Number(u.input_tokens ?? 0);
      tally.outputTokens += Number(u.output_tokens ?? 0);
      tally.cacheReadTokens += Number(u.cache_read_input_tokens ?? 0);
      tally.cacheWriteTokens += Number(u.cache_creation_input_tokens ?? 0);
      tally.turns++;
    }
  }
  const usd =
    (tally.inputTokens / 1e6) * HAIKU_PRICE.inputPerMTok +
    (tally.outputTokens / 1e6) * HAIKU_PRICE.outputPerMTok +
    (tally.cacheReadTokens / 1e6) * HAIKU_PRICE.cacheReadPerMTok +
    (tally.cacheWriteTokens / 1e6) * HAIKU_PRICE.cacheWritePerMTok;
  return { ...tally, transcriptDir: dir, found: true, modelCostUsd: Math.round(usd * 1e6) / 1e6 };
}

function codexTranscriptUsage(wsDir) {
  const root = join(homedir(), '.codex', 'sessions');
  const tally = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningOutputTokens: 0, turns: 0, files: [] };
  const target = resolve(wsDir);
  const leaves = recentCodexLeaves(root);
  for (const dir of leaves) {
    for (const f of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.jsonl'))) {
      const fp = join(dir, f.name);
      const lines = readFileSync(fp, 'utf8').split('\n').filter(Boolean);
      if (lines.length === 0) continue;
      let meta;
      try { meta = JSON.parse(lines[0]); } catch { continue; }
      if (resolve(meta?.payload?.cwd ?? '') !== target) continue;
      tally.files.push(fp);
      for (const line of lines) {
        let evt; try { evt = JSON.parse(line); } catch { continue; }
        const u = evt?.type === 'event_msg' && evt?.payload?.type === 'token_count'
          ? evt.payload.info?.last_token_usage
          : evt?.usage;
        if (!u) continue;
        tally.inputTokens += Number(u.input_tokens ?? 0);
        tally.outputTokens += Number(u.output_tokens ?? 0);
        tally.cacheReadTokens += Number(u.cached_input_tokens ?? 0);
        tally.cacheWriteTokens += Number(u.cache_creation_input_tokens ?? 0);
        tally.reasoningOutputTokens += Number(u.reasoning_output_tokens ?? 0);
        tally.turns++;
      }
    }
  }
  return { ...tally, transcriptDir: root, found: tally.files.length > 0, modelCostUsd: null };
}

function recentCodexLeaves(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const y of readdirSync(root).filter((n) => /^\d+$/.test(n)).sort().slice(-1)) {
    const yd = join(root, y);
    for (const m of readdirSync(yd).filter((n) => /^\d+$/.test(n)).sort().slice(-1)) {
      const md = join(yd, m);
      for (const d of readdirSync(md).filter((n) => /^\d+$/.test(n)).sort().slice(-2)) out.push(join(md, d));
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cell = JSON.parse(readFileSync(resolve(opts.cell), 'utf8'));
  if (cell.schema !== 'steward-campaign-cell/1') throw new Error(`unexpected cell schema: ${cell.schema}`);
  const { codename, regime, series, buyHold } = cell;
  if (series.length !== WINDOW_LEN) log(`WARN: cell has ${series.length} bars, expected ${WINDOW_LEN}`);

  const runId = opts.runId ?? `${regime}-${nowStamp()}`;
  const runDir = resolve('tools/campaigns/runs', runId);
  mkdirSync(runDir, { recursive: true });
  log(`run ${runId} → ${runDir}  (cell: ${regime} ${codename}, ${series.length} bars)`);

  const cookie = await resolveCookie(opts);
  const c = makeClient(opts.base, cookie);

  const weeks = [];
  let wsId, wsDir, acctId;
  let succeeded = false;
  try {
    // ── mock account + guards ────────────────────────────────────────────
    // NOTE: not `ephemeral` — an ephemeral mock account is purged on the very
    // UTA restart its own creation triggers (verified: "startup: purging
    // ephemeral UTA …"), so it never comes live. A normal account survives the
    // restart-reload and is cleaned up explicitly in the finally block.
    // The mandatory Risk Envelope (migration 0012) is provisioned at creation
    // so effective authz can reach `paper` (issue #253) — without one, a
    // missing/invalid envelope absorbs effective authz to `read_only` and
    // every mutation tool (placeOrder/tradingCommit/…) stays hidden even
    // after maxAuthzLevel is lifted below.
    const created = await c.post('/api/trading/config/uta', buildCampaignAccountCreatePayload(codename, runId, opts));
    acctId = created.id;
    log(`account ${acctId} created (guards: max-drawdown ${opts.maxDdPct}% + max-position-size ${opts.maxPosPct}%)`);
    log(`risk envelope provisioned (autonomyCeiling=paper, whitelist=[${codename}])`);
    await waitStable(c, acctId);

    // Lift maxAuthzLevel → paper (min(account, workspace) governs auto-push).
    // Both create AND this edit trigger a Guardian UTA restart; every restart
    // recreates the MockBroker instance, so bars MUST be injected only AFTER
    // the last config mutation has fully stabilized — otherwise the injected
    // series is dropped by the restart and mark-price hits a 502 mid-restart.
    const list = await c.get('/api/trading/config');
    const utas = Array.isArray(list) ? list : list.utas ?? [];
    const mine = utas.find((u) => u.id === acctId);
    if (!mine) throw new Error(`created account ${acctId} not found in config list`);
    await c.put(`/api/trading/config/uta/${acctId}`, { ...mine, maxAuthzLevel: 'paper' });
    await waitStable(c, acctId);
    log(`account maxAuthzLevel → paper (UTA stable)`);

    // ── inject anonymized series into the (now-final) MockBroker instance ──
    await c.post(`/api/simulator/uta/${acctId}/inject-bars`, {
      nativeKey: codename,
      interval: '1d',
      bars: series.map((b) => ({ t: dayToMs(b.day), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })),
    });
    log(`injected ${series.length} daily bars for ${codename}`);

    // ── blind steward workspace ─────────────────────────────────────────
    const wsRes = await c.post('/api/workspaces', {
      tag: workspaceTag(runId),
      template: 'steward',
      agents: [opts.agent],
      blind: true,
      blindAllowBarSources: [acctId],
    });
    wsId = wsRes.workspace.id;
    wsDir = wsRes.workspace.dir;
    log(`blind workspace ${wsId} (${opts.agent}) dir=${wsDir}`);
    if (opts.agent === 'codex' && opts.model) {
      const modelPath = join(wsDir, '.alice', 'steward', 'core-agent-model.txt');
      writeFileSync(modelPath, `${opts.model}\n`);
      log(`codex model override → ${opts.model}`);
    }
    // NOTE: on `--agent claude`, an unattended steward wake can stall when the
    // agent writes its ledger entry via a brace-quoted shell heredoc (Claude
    // Code's "expansion obfuscation" classifier forces an interactive approval —
    // see adapters/claude.ts). The harness does NOT relax the permission model
    // for the spawned agent; resolving that gate (an authorized Claude Code
    // permission mode, or a classifier-safe ledger-write in the steward skill —
    // issue #98) is out of scope here. `--agent codex` (the steward default) is
    // not affected.
    await c.patch(`/api/workspaces/${wsId}/authz-level`, { authzLevel: 'paper' });
    log(`workspace authz → paper`);

    // ── weekly decision cycles ────────────────────────────────────────────
    const totalWeeks = opts.weeks;
    for (let week = 1; week <= totalWeeks; week++) {
      const upto = Math.min(week * BARS_PER_WEEK, series.length); // exclusive-ish: visible days = [0, upto)
      // Step the sim clock day-by-day through this week (fires pending legs).
      for (let d = (week - 1) * BARS_PER_WEEK; d < upto; d++) {
        await c.post(`/api/simulator/uta/${acctId}/mark-price`, {
          nativeKey: codename, price: series[d].close, asOf: dayToMs(d),
        }).catch((e) => log(`  mark-price day ${d} failed: ${e.message}`));
      }
      const visible = series.slice(0, upto);
      const lastDay = visible[visible.length - 1];

      const marketContext = {
        instrument: codename,
        tradeableAliceId: `${acctId}|${codename}`,
        tradeableNativeKey: codename,
        assetClassHint: cell.assetClassHint ?? 'a single anonymized, high-volatility instrument',
        interval: '1d',
        priceBasis: 'day 0 close rebased to 100; day index is fictional (no real dates)',
        currentDay: lastDay.day,
        currentClose: lastDay.close,
        weeklyCadence: `week ${week} of ${totalWeeks} (one decision per simulated week)`,
        note: 'You manage a prudent, benchmark-aware paper portfolio. Below is the full daily OHLCV visible so far. No other identifying information exists — judge from price/volume alone. The only tradable contract for this wake is tradeableAliceId; do not use default/example contracts returned by blank search.',
        bars: visible,
      };

      log(`week ${week}: sim day ${lastDay.day} close=${lastDay.close} — posting wake…`);
      const wakeRes = await c.post(`/api/workspaces/${wsId}/steward/wakes`, {
        reason: 'scheduled_observe',
        accountId: acctId,
        authzLevel: 'paper',
        expectedDecision: 'no_trade',
        deadlineMs: opts.deadlineMs,
        marketContext,
        riskContext: { note: 'weekly scheduled observation; protective legs run between wakes' },
        session: { agent: opts.agent },
      });
      const wakeId = wakeRes.wake?.wakeId;
      if (!wakeId) throw new Error(`wake POST returned no wakeId: ${JSON.stringify(wakeRes).slice(0, 300)}`);

      // Poll the supervisor until the wake reaches a terminal state.
      const start = Date.now();
      let wake = wakeRes.wake, ledgerEntry = wakeRes.ledgerEntry ?? null, status = wake.status;
      const terminal = new Set(['done', 'blocked', 'error', 'timeout', 'stuck']);
      while (!terminal.has(status) && Date.now() - start < opts.wakeTimeoutMs) {
        await sleep(opts.pollMs);
        await c.post(`/api/workspaces/${wsId}/steward/supervisor/tick`, {}).catch(() => undefined);
        const got = await c.get(`/api/workspaces/${wsId}/steward/wakes/${encodeURIComponent(wakeId)}`);
        wake = got.wake; ledgerEntry = got.ledgerEntry ?? ledgerEntry; status = wake.status;
      }
      if (!terminal.has(status)) {
        throw new Error(`wake ${wakeId} did not reach a terminal state before ${opts.wakeTimeoutMs}ms (last status: ${status})`);
      }

      const equity = await netLiquidation(c, acctId);
      const qty = await positionQty(c, acctId);
      const rec = {
        week, wakeId, status,
        decision: ledgerEntry?.decision ?? null,
        ledgerStatus: ledgerEntry?.status ?? null,
        thesis: ledgerEntry?.thesis ?? null,
        actions: ledgerEntry?.actions ?? [],
        checklist: ledgerEntry?.checklist ?? null,
        equity, positionQty: qty, currentClose: lastDay.close, currentDay: lastDay.day,
        elapsedMs: Date.now() - start,
      };
      weeks.push(rec);
      log(`  week ${week}: status=${status} decision=${rec.decision ?? '—'} equity=${Number.isFinite(equity) ? equity.toFixed(0) : 'n/a'} qty=${qty ?? '?'} (${(rec.elapsedMs / 1000).toFixed(0)}s)`);
    }

    // ── finalize ──────────────────────────────────────────────────────────
    await c.post(`/api/workspaces/${wsId}/steward/supervisor/tick`, {}).catch(() => undefined);
    const finalEquity = await netLiquidation(c, acctId);
    const ledgerAll = await c.get(`/api/workspaces/${wsId}/steward/ledger?limit=100`).then((r) => r.entries ?? []).catch(() => []);

    // ── audit finalization / trust verdict (issue #134) ─────────────────────
    // The set of ledger-backed terminal wakes must equal the set of first-wins
    // wakeIds in the exported ledger, AND the supervisor must have flagged no
    // ledger_integrity_violation. If a completed decision disappeared or mutated
    // (as the persistent session once caused by deleting decisions.jsonl mid-run)
    // this diverges and the run is marked NOT trustworthy rather than written as
    // a normal result.
    let integrityViolations = [];
    const supervisorLogPath = join(wsDir, '.alice', 'steward', 'supervisor.jsonl');
    if (existsSync(supervisorLogPath)) {
      try {
        integrityViolations = readFileSync(supervisorLogPath, 'utf8')
          .split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((e) => e && e.type === 'ledger_integrity_violation')
          .map((e) => ({ wakeId: e.wakeId, kind: e.kind, status: e.status, detail: e.detail }));
      } catch { /* ignore */ }
    }
    const { trustworthy, audit } = finalizationTrust({ weeks, ledgerEntries: ledgerAll, integrityViolations });

    // Supervisor cost state (written to .alice/steward/state.json).
    let stewardState = null;
    const statePath = join(wsDir, '.alice', 'steward', 'state.json');
    if (existsSync(statePath)) { try { stewardState = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* ignore */ } }

    const cost = transcriptCost(opts.agent, wsDir);

    const equityCurve = [START_CASH, ...weeks.map((w) => (Number.isFinite(w.equity) ? w.equity : START_CASH)),
      (Number.isFinite(finalEquity) ? finalEquity : START_CASH)];
    const grossPnL = (Number.isFinite(finalEquity) ? finalEquity : START_CASH) - START_CASH;
    const totalReturn = grossPnL / START_CASH;
    const agentMaxDD = maxDrawdown(equityCurve);
    const maxGuardedLong = maxWeeklyLongReturnUnderExposure(series, opts.maxPosPct, START_CASH, BARS_PER_WEEK);
    const modelCostUsd = cost.found ? (cost.modelCostUsd ?? null) : null;
    const ledgerCostUsd = stewardState?.cost?.totalEstimatedCostUsd ?? 0;
    const netPnL = modelCostUsd === null ? null : grossPnL - modelCostUsd;
    const verdict = regimeVerdict(regime, totalReturn, agentMaxDD, buyHold.maxDD);

    const result = {
      schema: 'steward-campaign-result/1',
      runId, finishedAt: new Date().toISOString(), weeksRun: totalWeeks,
      cell: { codename, regime, weeks: WEEKS, buyHold },
      workspace: { id: wsId, dir: wsDir, agent: opts.agent, blind: true, model: opts.model ?? process.env.ANTHROPIC_MODEL ?? '(default)' },
      account: { id: acctId, startCash: START_CASH, guards: { maxDrawdownPct: opts.maxDdPct, maxPositionPct: opts.maxPosPct } },
      metrics: {
        startCash: START_CASH,
        finalEquity,
        grossPnL,
        totalReturn,
        agentMaxDD,
        buyHoldReturn: buyHold.netReturn,
        buyHoldMaxDD: buyHold.maxDD,
        h1CaptureVsBuyHold: buyHold.netReturn > 0 ? totalReturn / buyHold.netReturn : null,
        h2DrawdownVsBuyHold: buyHold.maxDD > 0 ? agentMaxDD / buyHold.maxDD : null,
        maxGuardedLongReturn: maxGuardedLong.return,
        maxGuardedLongEntryWeek: maxGuardedLong.week,
        maxGuardedLongShares: maxGuardedLong.shares,
        bullTargetFeasibleUnderGuard: regime === 'bull' ? (maxGuardedLong.return ?? Number.NEGATIVE_INFINITY) >= 0.25 : null,
        equityCurve,
      },
      cost: {
        modelCostUsd,
        ledgerReportedCostUsd: ledgerCostUsd,
        pricing: opts.agent === 'claude' ? HAIKU_PRICE : null,
        transcript: { found: cost.found, turns: cost.turns, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, cacheReadTokens: cost.cacheReadTokens, cacheWriteTokens: cost.cacheWriteTokens, reasoningOutputTokens: cost.reasoningOutputTokens ?? 0, dir: cost.transcriptDir, files: cost.files },
      },
      net: { netPnL, netReturn: netPnL === null ? null : netPnL / START_CASH },
      // Top-level trust gate (issue #134): a consumer must not read `verdict.pass`
      // as a clean result without seeing `trustworthy`. When false, the ledger
      // audit failed and the numbers below are not to be trusted.
      trustworthy,
      verdict: { regime, pass: verdict.pass, rule: verdict.rule, trustworthy },
      audit,
      weeks,
      decisions: ledgerAll.map((e) => ({ wakeId: e.wakeId, at: e.at, decision: e.decision, status: e.status, thesis: e.thesis, actions: e.actions, checklist: e.checklist })),
    };

    writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(runDir, 'ledger.jsonl'), ledgerAll.map((e) => JSON.stringify(e)).join('\n') + '\n');
    if (stewardState) writeFileSync(join(runDir, 'steward-state.json'), `${JSON.stringify(stewardState, null, 2)}\n`);
    log(`\n─── ${runId} ───`);
    log(`gross PnL $${grossPnL.toFixed(2)} (${(totalReturn * 100).toFixed(1)}%)  agent maxDD ${(agentMaxDD * 100).toFixed(1)}%  vs buy-hold ${(buyHold.netReturn * 100).toFixed(1)}% / ${(buyHold.maxDD * 100).toFixed(1)}%`);
    log(`model cost ${cost.modelCostUsd === null ? 'n/a' : `$${modelCostUsd.toFixed(4)}`} (${cost.inputTokens} in / ${cost.outputTokens} out tok, ${opts.model ?? opts.agent})  → net PnL ${netPnL === null ? 'n/a' : `$${netPnL.toFixed(2)}`}`);
    log(`verdict ${regime}: ${verdict.pass ? 'PASS' : 'FAIL'} (${verdict.rule})${trustworthy ? '' : ' [NOT TRUSTWORTHY]'}`);
    if (!trustworthy) {
      log(`AUDIT INVALID (issue #134): ${audit.terminalLedgerBackedWakes} ledger-backed terminal wakes vs ` +
        `${audit.finalLedgerEntries} final ledger entries; ` +
        `missing=[${audit.missingFromLedger.join(', ')}] extra=[${audit.extraInLedger.join(', ')}]` +
        `${integrityViolations.length ? ` integrityViolations=${integrityViolations.length}` : ''}. ` +
        `result.trustworthy=false — written for evidence but NOT a valid pass.`);
      process.exitCode = 1;
    }
    log(`result → ${join(runDir, 'result.json')}`);
    succeeded = true;
  } finally {
    if (shouldCleanup({ succeeded, keep: opts.keep })) {
      if (wsId) await c.del(`/api/workspaces/${wsId}?purge=true`).catch(() => undefined);
      if (acctId) await c.del(`/api/trading/config/uta/${acctId}`).catch(() => undefined);
      log('cleaned up workspace + account');
    } else if (!succeeded) {
      log(`run failed — keeping workspace ${wsId} (${wsDir}) and account ${acctId} for forensics; delete manually when done`);
    } else {
      log(`--keep: left workspace ${wsId} + account ${acctId} for inspection`);
    }
  }
}

main().catch((err) => { process.stderr.write(`ERROR: ${err.stack ?? err.message}\n`); process.exit(1); });
