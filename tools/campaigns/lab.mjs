#!/usr/bin/env node
/**
 * alice-lab — one-command experiment matrix runner (issue #259).
 *
 * Orchestrates an unattended `arms × cells × rounds` steward backtest matrix
 * on top of the EXISTING single-cell harness (`run-cell.mjs`) and reporter
 * (`report.mjs`) — this file adds only the orchestration loop, per-arm
 * sandboxed stack lifecycle, and config parsing. It does not reimplement or
 * import run-cell/report internals; every cell run and every aggregation
 * pass is a child-process invocation of the existing scripts.
 *
 * For each arm, SERIALLY:
 *   1. boot a fresh sandboxed production Guardian stack (own OPENALICE_HOME +
 *      AQ_LAUNCHER_ROOT + port block + optional AQ_TEMPLATE_OVERLAY_DIR —
 *      overlays are a startup snapshot, so an overlay variant arm needs its
 *      own stack, see issue #259 audit §7);
 *   2. for each cell × round (also strictly serial — deleting a mock UTA
 *      restarts Guardian/UTA and would reset concurrent cells' in-memory
 *      MockBroker state, per run-cell.mjs's own parallel-run note), spawn
 *      `run-cell.mjs --keep` and record its outcome;
 *   3. batch-clean the workspaces/accounts of runs that succeeded (failed
 *      runs keep everything for forensics);
 *   4. tear down the stack and move on to the next arm.
 *
 * A run-cell failure marks that run failed and the arm continues; a stack
 * boot failure marks the whole arm failed (its planned runs are recorded as
 * skipped) and the experiment continues to the next arm. After all arms,
 * every run that produced a result.json is aggregated through the existing
 * `report.mjs`, and a machine-readable `summary.json` is written.
 *
 * Usage:
 *   pnpm lab run experiments/<name>.json
 *   (a leading `--` is tolerated: `pnpm lab -- run experiments/<name>.json`)
 *
 * Exit codes: 0 = every run in the matrix succeeded; 2 = the matrix
 * completed but at least one run/arm failed or was skipped; 1 = a
 * runner-level fatal error (bad config, budget exceeded, missing cell, ...)
 * before any run was attempted.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, createWriteStream, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import {
  validateExperimentConfig, generateRunId, derivePortBlock, deriveExitCode, tokenFromLog, login, makeClient, sleep,
  isPortFreeError, deriveTeardownOutcome, deriveBootOutcome, lastLogLines, parseLabArgs, runCellDispatchArgs,
} from './_lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CELLS_DIR = join(REPO_ROOT, 'tools', 'campaigns', 'cells');
const RUNS_ROOT = join(REPO_ROOT, 'tools', 'campaigns', 'runs');

const STACK_READY_TIMEOUT_MS = 240_000;
const STACK_TEARDOWN_GRACE_MS = 15_000;
const PORT_FREE_TIMEOUT_MS = 30_000;
const LOG_TAIL_LINES = 20;

function log(msg) {
  process.stderr.write(`[lab] ${new Date().toISOString().slice(11, 19)} ${msg}\n`);
}

// ── signal handling (issue #259 review LOW 1) ────────────────────────────
//
// Populated as main() progresses so a SIGINT/SIGTERM mid-experiment (e.g.
// the operator Ctrl-C'ing an unattended run) still tears down the active
// sandboxed stack via group-kill instead of leaking it, and leaves a
// partial summary.json instead of no record at all. `runsList`/`armSummaries`
// are populated in place (push, not reassignment) so this object always
// reflects the latest state without extra plumbing.
const runState = {
  activeStack: null, // { child, ports, armId }
  activeRunChild: null,
  config: null,
  experimentRoot: null,
  startedAt: null,
  oauth: null,
  runsList: [],
  armSummaries: [],
};

let shuttingDown = false;

async function yieldToSignalHandler() {
  if (shuttingDown) await new Promise(() => {});
}

function writeRuntimeState(patch) {
  if (!runState.experimentRoot) return;
  const path = join(runState.experimentRoot, 'runtime.json');
  const temporary = `${path}.${process.pid}.tmp`;
  let current = {};
  try { current = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first publication */ }
  writeFileSync(temporary, `${JSON.stringify({ schema: 'alice-lab-runtime/1', ...current, ...patch }, null, 2)}\n`);
  renameSync(temporary, path);
}

async function stopActiveRunChild() {
  const child = runState.activeRunChild;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  await Promise.race([exited, sleep(5_000)]);
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await exited;
  }
  runState.activeRunChild = null;
}

function installSignalHandlers() {
  const onSignal = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${sig} — tearing down active stack and writing partial summary`);
    (async () => {
      await stopActiveRunChild();
      if (runState.activeStack) {
        const { child, ports, armId } = runState.activeStack;
        try {
          await stopStack(child, ports, armId);
        } catch (err) {
          log(`teardown during ${sig} handling failed (continuing to write partial summary): ${err.message}`);
        }
      }
      if (runState.config && runState.experimentRoot) {
        writeSummary({
          config: runState.config,
          startedAt: runState.startedAt,
          armSummaries: runState.armSummaries,
          runsList: runState.runsList,
          reportPath: null,
          experimentRoot: runState.experimentRoot,
          interrupted: sig,
        });
        writeRuntimeState({ status: 'interrupted', labPid: null, guardianPid: null, stoppedAt: new Date().toISOString(), signal: sig });
      }
      process.exit(1);
    })().catch((err) => {
      process.stderr.write(`[lab] FATAL during ${sig} shutdown: ${err.stack ?? err.message}\n`);
      process.exit(1);
    });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

function loadConfig(configPath) {
  const abs = resolve(configPath);
  if (!existsSync(abs)) throw new Error(`experiment config not found: ${abs}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`experiment config at ${abs} is not valid JSON: ${err.message}`);
  }
  const config = validateExperimentConfig(raw);
  for (const cell of config.cells) {
    const cellPath = join(CELLS_DIR, `${cell}.json`);
    if (!existsSync(cellPath)) throw new Error(`cell "${cell}" not found at ${cellPath}`);
  }
  return config;
}

function verifyCodexSubscriptionOAuth() {
  if (process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY must be unset: alice-lab requires Codex ChatGPT subscription OAuth');
  }
  const probe = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', env: process.env });
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  if (probe.status !== 0 || !output.includes('Logged in using ChatGPT')) {
    throw new Error('Codex subscription OAuth preflight failed; run "codex login" and verify "codex login status"');
  }
  return { provider: 'codex', auth: 'chatgpt-subscription-oauth', openAiApiKeyPresent: false };
}

// ── per-arm sandboxed stack lifecycle ────────────────────────────────────

function bootStack(arm, ports, armDir) {
  const home = join(armDir, '.home');
  const ws = join(armDir, '.ws');
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const logPath = join(armDir, 'stack.log');
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const buf = { text: '' };
  const overlayDir = arm.overlayDir ?? process.env.AQ_TEMPLATE_OVERLAY_DIR;
  const env = {
    ...process.env,
    OPENALICE_HOME: home,
    AQ_LAUNCHER_ROOT: ws,
    OPENALICE_TRADING_MODE: 'pro',
    OPENALICE_WEB_PORT: String(ports.web),
    OPENALICE_MCP_PORT: String(ports.mcp),
    OPENALICE_UTA_PORT: String(ports.uta),
    OPENALICE_UI_PORT: String(ports.ui),
    ...(overlayDir ? { AQ_TEMPLATE_OVERLAY_DIR: overlayDir } : {}),
  };
  // detached: true makes production Guardian the leader of a NEW process group
  // (POSIX
  // pgid == child.pid), so `process.kill(-child.pid, sig)` below reaches
  // every Alice/UTA descendant directly. This retains the proven group teardown
  // from issue #259 while removing pnpm/tsx/Vite from the production path.
  for (const artifact of ['dist/main.js', 'services/uta/dist/uta.js']) {
    if (!existsSync(join(REPO_ROOT, artifact))) {
      throw new Error(`production artifact missing: ${artifact}; run "pnpm build" before alice-lab`);
    }
  }
  const child = spawn(process.execPath, ['scripts/guardian/prod.mjs'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const onData = (chunk) => {
    buf.text += chunk.toString('utf8');
    logStream.write(chunk);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return { child, logPath, logStream, buf };
}

/**
 * Poll for stack readiness (log markers + a live `/api/version`), racing it
 * against the boot child dying early — e.g. a port still held by a leaked
 * previous arm. Without the race, a dead child was previously invisible
 * until the full `STACK_READY_TIMEOUT_MS` (240s) elapsed (issue #259 review
 * HIGH). Decision logic lives in `deriveBootOutcome` (`_lib.mjs`) so it can
 * be unit spec'd without spawning a process.
 */
async function waitStackReady(child, webPort, buf, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let exit = null;
  const onExit = (code, signal) => { exit = { code, signal }; };
  child.once('exit', onExit);
  try {
    while (Date.now() < deadline) {
      if (exit) return deriveBootOutcome({ ready: false, exited: true, exitCode: exit.code, exitSignal: exit.signal, timeoutMs });
      if (buf.text.includes('[guardian/prod] starting') && buf.text.includes('UTA ready') && buf.text.includes('engine: started')) {
        try {
          const res = await fetch(`http://127.0.0.1:${webPort}/api/version`, { signal: AbortSignal.timeout(3_000) });
          if (res.ok) return deriveBootOutcome({ ready: true });
        } catch { /* not there yet */ }
      }
      await sleep(1_000);
    }
    return deriveBootOutcome({ ready: false, exited: Boolean(exit), exitCode: exit?.code, exitSignal: exit?.signal, timeoutMs });
  } finally {
    child.off('exit', onExit);
  }
}

/** Signal the whole process GROUP (not just `pid`), tolerating a group that
 *  is already gone (ESRCH) — the normal case when the leader already exited
 *  on its own. */
function killProcessGroup(pid, signal) {
  if (pid == null) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (err && err.code === 'ESRCH') return;
    throw err;
  }
}

/**
 * Tear down a sandboxed stack: SIGTERM the whole process group, grace
 * period, SIGKILL the group, then gate "torn down" on the arm's web port
 * actually freeing (not on any child's `exit` event — pnpm itself exits
 * immediately on SIGTERM without waiting for its children, which made the
 * old SIGKILL-escalation branch dead code; see issue #259 review CRITICAL).
 * Since every arm in an experiment shares the same port block, a port that
 * never frees would corrupt every subsequent arm's boot — so this throws a
 * runner-fatal error instead of continuing.
 */
async function stopStack(child, ports, armId) {
  if (!child || child.pid == null) return;
  killProcessGroup(child.pid, 'SIGTERM');
  await sleep(STACK_TEARDOWN_GRACE_MS);
  killProcessGroup(child.pid, 'SIGKILL');
  const freed = await waitPortFree(ports.web, PORT_FREE_TIMEOUT_MS);
  const outcome = deriveTeardownOutcome({ armId, port: ports.web, freed, timeoutMs: PORT_FREE_TIMEOUT_MS });
  if (!outcome.ok) throw new Error(outcome.reason);
}

/** Only ECONNREFUSED means the port is actually free (classified by
 *  `isPortFreeError` in `_lib.mjs`) — any other rejection (abort/timeout,
 *  transient network hiccup) keeps polling until the bounded timeout
 *  instead of being misread as "freed" (issue #259 review LOW). */
async function waitPortFree(webPort, timeoutMs = PORT_FREE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${webPort}/api/version`, { signal: AbortSignal.timeout(1_500) });
    } catch (err) {
      if (isPortFreeError(err)) return true;
    }
    await sleep(1_000);
  }
  return false;
}

// ── run-cell / report child processes ────────────────────────────────────

function runChildToLog(args, logPath) {
  return new Promise((resolveRun) => {
    const logStream = createWriteStream(logPath, { flags: 'w' });
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    runState.activeRunChild = child;
    let settled = false;
    const settle = (exitCode) => {
      if (settled) return;
      settled = true;
      if (runState.activeRunChild === child) runState.activeRunChild = null;
      logStream.end();
      resolveRun({ exitCode });
    };
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    child.on('exit', (code) => settle(code ?? 1));
    child.on('error', (err) => { logStream.write(`\n[lab] spawn error: ${err.message}\n`); settle(1); });
  });
}

function runReportChild(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('exit', (code) => resolveRun({ exitCode: code ?? 1, stderr }));
    child.on('error', (err) => resolveRun({ exitCode: 1, stderr: err.message }));
  });
}

/** Best-effort scrape of the workspace/account ids run-cell.mjs logs on
 *  creation, for recording what a failed (kept) run left behind — the only
 *  source when the run threw before writing result.json. */
function parseKeptIdsFromLog(text) {
  const acctMatch = text.match(/account (\S+) created/);
  const wsMatch = text.match(/blind workspace (\S+) \(\S+\) dir=(\S+)/);
  return {
    accountId: acctMatch ? acctMatch[1] : null,
    workspaceId: wsMatch ? wsMatch[1] : null,
    workspaceDir: wsMatch ? wsMatch[2] : null,
  };
}

/** Cleans up (deletes) the workspace + mock account of every succeeded run
 *  in this arm; records what was left behind for failed runs. Never throws —
 *  cleanup failures are logged and swallowed (issue #259 binding fact #3). */
async function batchCleanup(armRuns, baseUrl, token, armDir) {
  for (const rec of armRuns) {
    if (rec.status !== 'failed') continue;
    try {
      const text = readFileSync(join(armDir, `${rec.runId}.log`), 'utf8');
      const kept = parseKeptIdsFromLog(text);
      rec.keptWorkspace = kept.workspaceId ? { id: kept.workspaceId, dir: kept.workspaceDir } : null;
      rec.keptAccount = kept.accountId ? { id: kept.accountId } : null;
    } catch (err) {
      log(`could not scrape kept-ids for failed run ${rec.runId} (continuing): ${err.message}`);
    }
  }

  const toClean = armRuns.filter((r) => r.status === 'ok' && r.resultPath);
  if (toClean.length === 0) return;
  try {
    const cookie = await login(baseUrl, token);
    const c = makeClient(baseUrl, cookie);
    for (const rec of toClean) {
      try {
        const result = JSON.parse(readFileSync(join(REPO_ROOT, rec.resultPath), 'utf8'));
        const wsId = result.workspace?.id;
        const acctId = result.account?.id;
        if (wsId) await c.del(`/api/workspaces/${wsId}?purge=true`).catch(() => undefined);
        if (acctId) await c.del(`/api/trading/config/uta/${acctId}`).catch(() => undefined);
        log(`cleaned up run ${rec.runId} (workspace ${wsId ?? '?'}, account ${acctId ?? '?'})`);
      } catch (err) {
        log(`cleanup for run ${rec.runId} failed (continuing, workspace/account left in place): ${err.message}`);
      }
    }
  } catch (err) {
    log(`batch cleanup login failed for this arm (continuing, all its succeeded workspaces/accounts left in place): ${err.message}`);
  }
}

// ── matrix execution ──────────────────────────────────────────────────────

async function runArm(arm, config, experimentRoot, runsList) {
  const armDir = join(experimentRoot, `arm-${arm.id}`);
  mkdirSync(armDir, { recursive: true });
  const ports = derivePortBlock(config.basePort);
  const baseUrl = `http://127.0.0.1:${ports.web}`;

  log(`arm ${arm.id}: booting sandboxed production Guardian on port ${ports.web} (overlay=${arm.overlayDir ?? process.env.AQ_TEMPLATE_OVERLAY_DIR ?? 'none'})`);
  const stack = bootStack(arm, ports, armDir);
  runState.activeStack = { child: stack.child, ports, armId: arm.id };
  writeRuntimeState({ status: 'running', guardianPid: stack.child.pid, armId: arm.id, ports, stackLog: stack.logPath });

  const plannedRuns = () => {
    const out = [];
    for (const cell of config.cells) {
      for (let round = 1; round <= config.rounds; round++) out.push({ cell, round });
    }
    return out;
  };

  const readiness = await waitStackReady(stack.child, ports.web, stack.buf, STACK_READY_TIMEOUT_MS);
  await yieldToSignalHandler();
  if (!readiness.ok) {
    let reason = readiness.reason;
    if (readiness.status === 'exited') {
      reason += `\n--- last ${LOG_TAIL_LINES} lines of stack.log ---\n${lastLogLines(stack.buf.text, LOG_TAIL_LINES)}`;
    }
    log(`arm ${arm.id}: ${readiness.reason} — failing arm, skipping its runs`);
    await stopStack(stack.child, ports, arm.id);
    runState.activeStack = null;
    writeRuntimeState({ guardianPid: null, armId: null });
    stack.logStream.end();
    for (const { cell, round } of plannedRuns()) {
      runsList.push({ runId: generateRunId(config.name, arm.id, cell, round), arm: arm.id, cell, round, status: 'skipped', exitCode: null, resultPath: null, reason });
    }
    return { id: arm.id, status: 'failed', reason, dir: armDir };
  }
  log(`arm ${arm.id}: stack ready`);

  const token = tokenFromLog(stack.buf.text);
  if (!token) {
    log(`arm ${arm.id}: could not scrape first-run admin token from stack.log — failing arm, skipping its runs`);
    await stopStack(stack.child, ports, arm.id);
    runState.activeStack = null;
    writeRuntimeState({ guardianPid: null, armId: null });
    stack.logStream.end();
    for (const { cell, round } of plannedRuns()) {
      runsList.push({ runId: generateRunId(config.name, arm.id, cell, round), arm: arm.id, cell, round, status: 'skipped', exitCode: null, resultPath: null, reason: 'no admin token found in stack.log' });
    }
    return { id: arm.id, status: 'failed', reason: 'no admin token found in stack.log', dir: armDir };
  }

  const armRuns = [];
  for (const { cell, round } of plannedRuns()) {
    const runId = generateRunId(config.name, arm.id, cell, round);
    const cellPath = join('tools', 'campaigns', 'cells', `${cell}.json`);
    const runLogPath = join(armDir, `${runId}.log`);
    log(`arm ${arm.id}: run ${runId} — starting`);
    const args = [
      'tools/campaigns/run-cell.mjs',
      '--cell', cellPath,
      '--base', baseUrl,
      '--log', stack.logPath,
      '--agent', arm.agent,
      '--model', arm.model,
      '--weeks', String(config.weeks),
      '--run-id', runId,
      '--keep',
      ...runCellDispatchArgs(config.dispatch),
      ...(config.mandate ? ['--mandate-config', JSON.stringify({
        ...config.mandate,
        mandateId: `${config.mandate.id}-${runId}`,
      })] : []),
      ...(config.restartAfterWake ? ['--restart-after-wake', String(config.restartAfterWake)] : []),
    ];
    const { exitCode } = await runChildToLog(args, runLogPath);
    await yieldToSignalHandler();
    const status = exitCode === 0 ? 'ok' : 'failed';
    const resultRelPath = join('tools', 'campaigns', 'runs', runId, 'result.json');
    const resultPath = existsSync(join(REPO_ROOT, resultRelPath)) ? resultRelPath : null;
    const rec = { runId, arm: arm.id, cell, round, status, exitCode, resultPath };
    log(`arm ${arm.id}: run ${runId} — ${status} (exit ${exitCode})`);
    armRuns.push(rec);
    runsList.push(rec);
  }

  await batchCleanup(armRuns, baseUrl, token, armDir);

  await stopStack(stack.child, ports, arm.id);
  runState.activeStack = null;
  writeRuntimeState({ guardianPid: null, armId: null });
  stack.logStream.end();

  return { id: arm.id, status: 'ok', dir: armDir };
}

async function generateReport(config, runsList) {
  const reportable = runsList.filter((r) => r.resultPath);
  if (reportable.length === 0) {
    log('no run produced a result.json — skipping report.mjs aggregation');
    return null;
  }
  const outPath = join(RUNS_ROOT, `${config.name}-report.md`);
  const args = ['tools/campaigns/report.mjs'];
  for (const r of reportable) args.push('--run', dirname(r.resultPath));
  args.push('--out', outPath);
  log(`aggregating ${reportable.length} run(s) into ${outPath}`);
  const { exitCode, stderr } = await runReportChild(args);
  if (exitCode !== 0) {
    log(`report.mjs aggregation failed (continuing without a report): ${stderr.trim()}`);
    return null;
  }
  return outPath;
}

/** Builds and writes summary.json. Shared by the normal completion path
 *  (main(), reportPath + a status-derived exitCode) and the SIGINT/SIGTERM
 *  handler (no report, exitCode forced to 1, `interrupted` records which
 *  signal cut the run short). */
function writeSummary({ config, startedAt, armSummaries, runsList, reportPath, experimentRoot, interrupted = null }) {
  const exitCode = interrupted ? 1 : deriveExitCode(runsList);
  const finishedAt = new Date().toISOString();
  const totals = {
    total: runsList.length,
    ok: runsList.filter((r) => r.status === 'ok').length,
    failed: runsList.filter((r) => r.status === 'failed').length,
    skipped: runsList.filter((r) => r.status === 'skipped').length,
  };

  const summary = {
    schema: 'alice-lab-summary/1',
    name: config.name,
    startedAt,
    finishedAt,
    ...(interrupted ? { interrupted } : {}),
    config: {
      weeks: config.weeks,
      rounds: config.rounds,
      cells: config.cells,
      arms: config.arms,
      maxRuns: config.maxRuns,
      basePort: config.basePort,
      allowHoldout: config.allowHoldout,
      dispatch: config.dispatch,
      mandate: config.mandate,
      restartAfterWake: config.restartAfterWake,
    },
    oauth: runState.oauth,
    arms: armSummaries,
    runs: runsList,
    totals,
    reportPath,
    exitCode,
  };
  const summaryPath = join(experimentRoot, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeRuntimeState({
    status: interrupted ? 'interrupted' : exitCode === 0 ? 'completed' : 'failed',
    labPid: null,
    guardianPid: null,
    stoppedAt: finishedAt,
    exitCode,
  });
  log(`summary → ${summaryPath}`);
  log(`totals: ${totals.ok} ok / ${totals.failed} failed / ${totals.skipped} skipped (of ${totals.total})`);
  return exitCode;
}

async function main() {
  installSignalHandlers();
  const oauth = verifyCodexSubscriptionOAuth();

  const { configPath } = parseLabArgs(process.argv.slice(2));
  const config = loadConfig(configPath);
  const startedAt = new Date().toISOString();
  log(`experiment "${config.name}": ${config.arms.length} arms × ${config.cells.length} cells × ${config.rounds} rounds = ${config.totalRuns} runs (maxRuns ${config.maxRuns})`);

  const experimentRoot = join(RUNS_ROOT, config.name);
  mkdirSync(experimentRoot, { recursive: true });

  runState.config = config;
  runState.oauth = oauth;
  runState.experimentRoot = experimentRoot;
  runState.startedAt = startedAt;
  writeRuntimeState({
    status: 'starting',
    labPid: process.pid,
    guardianPid: null,
    armId: null,
    ports: null,
    stackLog: null,
    startedAt,
    stoppedAt: null,
    exitCode: null,
    signal: null,
    configPath: resolve(configPath),
  });
  const runsList = runState.runsList;
  const armSummaries = runState.armSummaries;

  for (const arm of config.arms) {
    armSummaries.push(await runArm(arm, config, experimentRoot, runsList));
  }

  const reportPath = await generateReport(config, runsList);
  const exitCode = writeSummary({ config, startedAt, armSummaries, runsList, reportPath, experimentRoot });
  log(`exit code ${exitCode}`);
  process.exit(exitCode);
}

main().catch(async (err) => {
  process.stderr.write(`[lab] FATAL: ${err.stack ?? err.message}\n`);
  await stopActiveRunChild();
  if (runState.activeStack) {
    const { child, ports, armId } = runState.activeStack;
    try { await stopStack(child, ports, armId); }
    catch (teardownError) { process.stderr.write(`[lab] FATAL teardown failed: ${teardownError.message}\n`); }
    runState.activeStack = null;
  }
  if (runState.config && runState.experimentRoot) {
    writeSummary({
      config: runState.config,
      startedAt: runState.startedAt,
      armSummaries: runState.armSummaries,
      runsList: runState.runsList,
      reportPath: null,
      experimentRoot: runState.experimentRoot,
      interrupted: 'fatal',
    });
  }
  process.exit(1);
});
