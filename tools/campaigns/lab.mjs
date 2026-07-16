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
 *   1. boot a fresh sandboxed `pnpm dev` stack (own OPENALICE_HOME +
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
 *   pnpm lab -- run experiments/<name>.json
 *
 * Exit codes: 0 = every run in the matrix succeeded; 2 = the matrix
 * completed but at least one run/arm failed or was skipped; 1 = a
 * runner-level fatal error (bad config, budget exceeded, missing cell, ...)
 * before any run was attempted.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { validateExperimentConfig, generateRunId, derivePortBlock, deriveExitCode, tokenFromLog, login, makeClient, sleep } from './_lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CELLS_DIR = join(REPO_ROOT, 'tools', 'campaigns', 'cells');
const RUNS_ROOT = join(REPO_ROOT, 'tools', 'campaigns', 'runs');

const STACK_READY_TIMEOUT_MS = 240_000;
const STACK_TEARDOWN_GRACE_MS = 15_000;
const STACK_TEARDOWN_KILL_TIMEOUT_MS = 10_000;
const PORT_FREE_TIMEOUT_MS = 30_000;

function log(msg) {
  process.stderr.write(`[lab] ${new Date().toISOString().slice(11, 19)} ${msg}\n`);
}

function parseArgs(argv) {
  const [cmd, configPath, ...rest] = argv;
  if (cmd !== 'run' || !configPath) throw new Error('usage: lab.mjs run <experiment.json>');
  if (rest.length) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);
  return { configPath };
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

// ── per-arm sandboxed stack lifecycle ────────────────────────────────────

function bootStack(arm, ports, armDir) {
  const home = join(armDir, '.home');
  const ws = join(armDir, '.ws');
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const logPath = join(armDir, 'stack.log');
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const buf = { text: '' };
  const env = {
    ...process.env,
    OPENALICE_HOME: home,
    AQ_LAUNCHER_ROOT: ws,
    OPENALICE_TRADING_MODE: 'pro',
    OPENALICE_WEB_PORT: String(ports.web),
    OPENALICE_MCP_PORT: String(ports.mcp),
    OPENALICE_UTA_PORT: String(ports.uta),
    OPENALICE_UI_PORT: String(ports.ui),
    ...(arm.overlayDir ? { AQ_TEMPLATE_OVERLAY_DIR: arm.overlayDir } : {}),
  };
  const child = spawn('pnpm', ['dev'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (chunk) => {
    buf.text += chunk.toString('utf8');
    logStream.write(chunk);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return { child, logPath, logStream, buf };
}

async function waitStackReady(webPort, buf, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (buf.text.includes('Alice ready') && buf.text.includes('UTA ready')) {
      try {
        const res = await fetch(`http://127.0.0.1:${webPort}/api/version`, { signal: AbortSignal.timeout(3_000) });
        if (res.ok) return true;
      } catch { /* not there yet */ }
    }
    await sleep(1_000);
  }
  return false;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolveExit(true); return; }
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolveExit(true); });
  });
}

async function stopStack(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  const exited = await waitForExit(child, STACK_TEARDOWN_GRACE_MS);
  if (!exited) {
    log('stack did not exit on SIGTERM — escalating to SIGKILL');
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await waitForExit(child, STACK_TEARDOWN_KILL_TIMEOUT_MS);
  }
}

async function waitPortFree(webPort, timeoutMs = PORT_FREE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${webPort}/api/version`, { signal: AbortSignal.timeout(1_500) });
    } catch {
      return true;
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
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    child.on('exit', (code) => { logStream.end(); resolveRun({ exitCode: code ?? 1 }); });
    child.on('error', (err) => { logStream.write(`\n[lab] spawn error: ${err.message}\n`); logStream.end(); resolveRun({ exitCode: 1 }); });
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

  log(`arm ${arm.id}: booting sandboxed stack on port ${ports.web} (overlay=${arm.overlayDir ?? 'none'})`);
  const stack = bootStack(arm, ports, armDir);

  const plannedRuns = () => {
    const out = [];
    for (const cell of config.cells) {
      for (let round = 1; round <= config.rounds; round++) out.push({ cell, round });
    }
    return out;
  };

  const ready = await waitStackReady(ports.web, stack.buf, STACK_READY_TIMEOUT_MS);
  if (!ready) {
    log(`arm ${arm.id}: stack did not become ready within ${STACK_READY_TIMEOUT_MS}ms — failing arm, skipping its runs`);
    await stopStack(stack.child);
    stack.logStream.end();
    for (const { cell, round } of plannedRuns()) {
      runsList.push({ runId: generateRunId(config.name, arm.id, cell, round), arm: arm.id, cell, round, status: 'skipped', exitCode: null, resultPath: null, reason: 'arm stack boot failed' });
    }
    return { id: arm.id, status: 'failed', reason: `stack did not become ready within ${STACK_READY_TIMEOUT_MS}ms`, dir: armDir };
  }
  log(`arm ${arm.id}: stack ready`);

  const token = tokenFromLog(stack.buf.text);
  if (!token) {
    log(`arm ${arm.id}: could not scrape first-run admin token from stack.log — failing arm, skipping its runs`);
    await stopStack(stack.child);
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
    ];
    const { exitCode } = await runChildToLog(args, runLogPath);
    const status = exitCode === 0 ? 'ok' : 'failed';
    const resultRelPath = join('tools', 'campaigns', 'runs', runId, 'result.json');
    const resultPath = existsSync(join(REPO_ROOT, resultRelPath)) ? resultRelPath : null;
    const rec = { runId, arm: arm.id, cell, round, status, exitCode, resultPath };
    log(`arm ${arm.id}: run ${runId} — ${status} (exit ${exitCode})`);
    armRuns.push(rec);
    runsList.push(rec);
  }

  await batchCleanup(armRuns, baseUrl, token, armDir);

  await stopStack(stack.child);
  stack.logStream.end();
  const freed = await waitPortFree(ports.web);
  if (!freed) log(`arm ${arm.id}: warning — port ${ports.web} did not free within ${PORT_FREE_TIMEOUT_MS}ms`);

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

async function main() {
  const { configPath } = parseArgs(process.argv.slice(2));
  const config = loadConfig(configPath);
  const startedAt = new Date().toISOString();
  log(`experiment "${config.name}": ${config.arms.length} arms × ${config.cells.length} cells × ${config.rounds} rounds = ${config.totalRuns} runs (maxRuns ${config.maxRuns})`);

  const experimentRoot = join(RUNS_ROOT, config.name);
  mkdirSync(experimentRoot, { recursive: true });

  const runsList = [];
  const armSummaries = [];
  for (const arm of config.arms) {
    armSummaries.push(await runArm(arm, config, experimentRoot, runsList));
  }

  const reportPath = await generateReport(config, runsList);
  const exitCode = deriveExitCode(runsList);
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
    config: {
      weeks: config.weeks,
      rounds: config.rounds,
      cells: config.cells,
      arms: config.arms,
      maxRuns: config.maxRuns,
      basePort: config.basePort,
      allowHoldout: config.allowHoldout,
    },
    arms: armSummaries,
    runs: runsList,
    totals,
    reportPath,
    exitCode,
  };
  const summaryPath = join(experimentRoot, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  log(`summary → ${summaryPath}`);
  log(`totals: ${totals.ok} ok / ${totals.failed} failed / ${totals.skipped} skipped (of ${totals.total})`);
  log(`exit code ${exitCode}`);
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`[lab] FATAL: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
