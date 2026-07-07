#!/usr/bin/env node
/*
 * Persistent workspace wake-loop campaign harness.
 *
 * This is an acceptance/backtest harness for PR #72's wake seam, not production
 * scheduling code. It reuses the existing paper-campaign cached market windows
 * and dispatches each decision period through:
 *
 *   POST /api/workspaces/:id/sessions/:sid/wake
 *
 * A single live shell PTY + one long-lived runner process handles all six wake
 * periods for a cell. The result proves stable session id, PTY pid, runner pid,
 * transcript, and wake timestamps across multiple decision cycles. It does not
 * claim to prove Codex interactive trading quality; Codex TUI lacks a stable
 * machine-readable per-turn completion boundary today.
 *
 * Example:
 *   node tools/persistent-wake-loop-backtest.mjs \
 *     --base http://127.0.0.1:48731 \
 *     --campaign-dir /tmp/.../scratchpad/campaign \
 *     --want 2,4,4
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import WebSocket from 'ws';

const START = 100000;
const WEEKS = 6;
const BPW = 5;
const LEN = WEEKS * BPW;
const SYMBOL = 'ASSET-A';
const DEFAULT_BASE = process.env['OPENALICE_BASE_URL'] ?? 'http://127.0.0.1:48731';
const DEFAULT_TIMEOUT_MS = 90000;
const EQUITY = ['NVDA', 'TSLA', 'AMD', 'PLTR', 'META', 'SMCI', 'COIN', 'MSTR', 'AVGO', '9988.HK', '0700.HK', 'D05.SI'];
const CRYPTO = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];

function parseArgs(argv) {
  const out = {
    base: DEFAULT_BASE,
    campaignDir: process.env['OPENALICE_CAMPAIGN_DIR'] ?? '',
    token: process.env['OPENALICE_ADMIN_TOKEN'] ?? '',
    cookie: process.env['OPENALICE_SESSION_COOKIE'] ?? '',
    outDir: '',
    want: { bull: 2, bear: 4, chop: 4 },
    limit: 0,
    keep: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === '--base') out.base = next().replace(/\/+$/, '');
    else if (arg === '--campaign-dir') out.campaignDir = next();
    else if (arg === '--token') out.token = next();
    else if (arg === '--cookie') out.cookie = next();
    else if (arg === '--out-dir') out.outDir = next();
    else if (arg === '--limit') out.limit = Number(next());
    else if (arg === '--timeout-ms') out.timeoutMs = Number(next());
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--want') {
      const [bull, bear, chop] = next().split(',').map((x) => Number(x.trim()));
      if (![bull, bear, chop].every((n) => Number.isFinite(n) && n >= 0)) {
        throw new Error('--want must be bull,bear,chop counts, e.g. 2,4,4');
      }
      out.want = { bull, bear, chop };
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.campaignDir) out.campaignDir = findDefaultCampaignDir();
  if (!out.campaignDir) throw new Error('campaign dir required; pass --campaign-dir or OPENALICE_CAMPAIGN_DIR');
  out.campaignDir = resolve(out.campaignDir);
  if (!out.outDir) out.outDir = join(out.campaignDir, 'persistent-wake-results');
  out.outDir = resolve(out.outDir);
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1000) throw new Error('--timeout-ms must be >= 1000');
  if (!Number.isFinite(out.limit) || out.limit < 0) throw new Error('--limit must be >= 0');
  return out;
}

function printHelp() {
  console.log(`Usage: node tools/persistent-wake-loop-backtest.mjs [options]

Options:
  --base URL             Alice backend URL (default: ${DEFAULT_BASE})
  --campaign-dir DIR     Existing scratchpad campaign dir with eq-*.json/cx-*.json
  --token TOKEN          Admin token; if omitted, token.txt or stack.log is read
  --cookie COOKIE        alice_session cookie; skips login
  --want BULL,BEAR,CHOP  Full campaign mix (default: 2,4,4)
  --limit N              Run only first N cells (smoke)
  --out-dir DIR          Results dir (default: <campaign-dir>/persistent-wake-results)
  --timeout-ms MS        Per-wake wait timeout (default: ${DEFAULT_TIMEOUT_MS})
  --keep                 Keep created workspace/account for inspection
`);
}

function findDefaultCampaignDir() {
  const known = '/tmp/claude-1000/-home-user-Projects-OpenAlice/75e8bbb3-d2d1-43a5-8f22-da152c2c22ac/scratchpad/campaign';
  return existsSync(known) ? known : '';
}

function log(line) {
  const msg = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(msg);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(opts.outDir, { recursive: true });
  const runId = `pwake-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const runLog = join(opts.outDir, `${runId}.log`);
  const runResults = join(opts.outDir, `${runId}.json`);
  const logBoth = (line) => {
    log(line);
    appendFileSync(runLog, `[${new Date().toISOString()}] ${line}\n`);
  };

  logBoth(`persistent wake campaign start base=${opts.base} campaign=${opts.campaignDir} want=${JSON.stringify(opts.want)}`);
  const cookie = opts.cookie || await login(opts.base, opts.token || readToken(opts.campaignDir));
  const c = makeClient(opts.base, cookie);
  await requireStack(c);
  const cells = opts.limit > 0 ? buildCells(opts.campaignDir, opts.want).slice(0, opts.limit) : buildCells(opts.campaignDir, opts.want);
  logBoth(`cells (${cells.length}): ${cells.map((x) => `${x.tag}[${x.regime}:${x.src}]`).join(', ')}`);

  const results = [];
  for (const cell of cells) {
    logBoth(`CELL ${cell.tag} regime=${cell.regime} src=${cell.src}`);
    const started = Date.now();
    try {
      const result = await runCell(c, opts, cell, logBoth);
      result.durationMs = Date.now() - started;
      result.verdict = verdict(result);
      results.push(result);
      logBoth(`  DONE ${cell.tag}: session=${result.session.sessionId} pid=${result.session.pid} runner=${result.session.runnerPid} wakes=${result.session.wakeCount} stable=${result.session.stableSession && result.session.stableRunner} ret=${pct(result.totalReturn)} DD=${pct(result.maxDrawdown)} -> ${result.verdict}`);
    } catch (err) {
      const failed = {
        tag: cell.tag,
        regime: cell.regime,
        src: cell.src,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
      results.push(failed);
      logBoth(`  ERROR ${cell.tag}: ${failed.error}`);
    }
  }

  const summary = summarize(results);
  const payload = {
    batch: runId,
    kind: 'persistent-wake-loop-backtest',
    dispatch: 'POST /api/workspaces/:id/sessions/:sid/wake',
    agentHarness: 'shell-pty-long-lived-runner',
    codexInteractiveNote: 'Not claimed: Codex interactive TUI has no stable machine-readable per-turn completion boundary for a 60-cycle automated backtest.',
    base: opts.base,
    campaignDir: opts.campaignDir,
    startedAt: new Date(Date.now() - results.reduce((s, r) => s + (r.durationMs ?? 0), 0)).toISOString(),
    finishedAt: new Date().toISOString(),
    summary,
    results,
  };
  writeFileSync(runResults, `${JSON.stringify(payload, null, 2)}\n`);
  logBoth(`results written: ${runResults}`);
  logBoth(`summary: ${summary.map((x) => `${x.regime} ${x.pass}/${x.count} pass`).join(' | ')}`);
  const errored = results.filter((r) => r.error);
  if (errored.length) {
    throw new Error(`persistent wake-loop run had harness errors: ${errored.map((r) => `${r.tag}:${r.error}`).join('; ')}`);
  }
  const unstable = results.filter((r) => !r.error && (!r.session?.stableSession || !r.session?.stableRunner || !r.session?.transcriptHasDoneMarkers));
  if (unstable.length) {
    throw new Error(`wake-loop proof failed for ${unstable.map((r) => r.tag).join(', ')}`);
  }
}

async function requireStack(c) {
  await c.get('/api/version');
}

async function login(base, token) {
  if (!token) throw new Error('admin token unavailable; pass --token/--cookie or provide token.txt/stack.log in campaign dir');
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/alice_session=[^;]+/);
  if (!match) throw new Error('login response did not include alice_session cookie');
  return match[0];
}

function readToken(campaignDir) {
  const tokenPath = join(campaignDir, 'token.txt');
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, 'utf8').trim();
    if (token) return token;
  }
  const logPath = join(campaignDir, 'stack.log');
  if (existsSync(logPath)) {
    const raw = readFileSync(logPath, 'utf8');
    const match = raw.match(/First-run admin token[^]*?\n\s*\[alice\]\s*\n\s*\[alice\]\s+([A-Za-z0-9_-]{30,})/);
    if (match) return match[1];
  }
  return '';
}

function makeClient(base, cookie) {
  async function req(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...(method === 'GET' ? {} : { Origin: base }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const msg = typeof json === 'string' ? json : JSON.stringify(json);
      throw new Error(`${method} ${path} -> ${res.status}: ${msg.slice(0, 500)}`);
    }
    return json;
  }
  return {
    cookie,
    base,
    get: (path) => req('GET', path),
    post: (path, body) => req('POST', path, body),
    put: (path, body) => req('PUT', path, body),
    patch: (path, body) => req('PATCH', path, body),
    del: (path) => req('DELETE', path),
  };
}

async function runCell(c, opts, cell, logBoth) {
  const acctId = await createPaperAccount(c, cell.tag);
  let wsId = '';
  let sessionId = '';
  let transcript = null;
  try {
    await waitAccountLive(c, acctId);
    await setAccountPaper(c, acctId, cell.tag);
    await waitStable(c, acctId);
    const ws = await c.post('/api/workspaces', { tag: cell.tag, template: 'chat', agents: ['shell'] });
    wsId = ws.workspace.id;
    const wsDir = ws.workspace.dir;
    await c.patch(`/api/workspaces/${wsId}/authz-level`, { authzLevel: 'paper' });
    writeFileSync(join(wsDir, '.persistent-wake-runner.mjs'), runnerSource(), 'utf8');
    const session = await c.post(`/api/workspaces/${wsId}/sessions/spawn`, { agent: 'shell' });
    sessionId = session.sessionId;
    transcript = attachTranscript(c.base, c.cookie, sessionId);
    await transcript.waitAttached(15000);
    const diag0 = await c.get(`/api/workspaces/${wsId}/sessions/${sessionId}/diagnostics`);
    const shellPid = diag0.live?.pid ?? session.pid;
    const eventFile = join(wsDir, 'persistent-wake-events.jsonl');
    const decisionFile = join(wsDir, 'persistent-wake-decisions.jsonl');

    await c.post(`/api/workspaces/${wsId}/sessions/${sessionId}/wake`, {
      message: 'node .persistent-wake-runner.mjs',
    });
    const ready = await waitForJsonl(eventFile, (e) => e.type === 'ready', opts.timeoutMs);
    logBoth(`  setup acct=${acctId} ws=${wsId} session=${sessionId} shellPid=${shellPid} runnerPid=${ready.pid}`);

    const eqCurve = [START];
    const decisions = [];
    const sessionPids = [];
    const runnerPids = [];
    let sawLong = false;
    await markPrice(c, acctId, cell.series[0].close);
    for (let week = 1; week <= WEEKS; week++) {
      const upto = week * BPW;
      for (let i = (week - 1) * BPW; i < upto && i < cell.series.length; i++) {
        await markPrice(c, acctId, cell.series[i].close);
      }
      const before = await positionQty(c, acctId);
      const envelope = {
        type: 'wake',
        cellTag: cell.tag,
        regime: cell.regime,
        source: cell.src,
        accountId: acctId,
        symbol: SYMBOL,
        week,
        totalWeeks: WEEKS,
        currentPrice: cell.series[Math.min(upto, cell.series.length) - 1].close,
        positionQty: before,
        series: cell.series.slice(0, Math.min(upto, cell.series.length)),
      };
      const wake = await c.post(`/api/workspaces/${wsId}/sessions/${sessionId}/wake`, {
        message: JSON.stringify(envelope),
      });
      const diag = await c.get(`/api/workspaces/${wsId}/sessions/${sessionId}/diagnostics`);
      sessionPids.push(diag.live?.pid ?? null);
      const dec = await waitForJsonl(
        decisionFile,
        (e) => e.type === 'decision' && e.cellTag === cell.tag && e.week === week,
        opts.timeoutMs,
      );
      runnerPids.push(dec.pid);
      decisions.push(dec);
      if (String(dec.action).startsWith('propose_trade')) sawLong = true;
      await c.post(`/api/trading/uta/${acctId}/sync`, { delayMs: 200 }).catch(() => undefined);
      const eq = Number((await c.get(`/api/trading/uta/${acctId}/account`)).netLiquidation);
      eqCurve.push(eq);
      logBoth(`    wk${week}: wakeLastInput=${wake.lastInputAt} sessionPid=${diag.live?.pid ?? 'n/a'} runnerPid=${dec.pid} decision=${dec.action} eq=${eq.toFixed(2)} qty=${await positionQty(c, acctId)}`);
    }
    await markPrice(c, acctId, cell.series[cell.series.length - 1].close);
    await c.post(`/api/trading/uta/${acctId}/sync`, { delayMs: 200 }).catch(() => undefined);
    const finalEq = Number((await c.get(`/api/trading/uta/${acctId}/account`)).netLiquidation);
    eqCurve.push(finalEq);
    const totalReturn = (finalEq - START) / START;
    const maxDrawdown = maxDrawdownFromEquity(eqCurve);
    const transcriptText = transcript.text();
    const doneMarkers = decisions.filter((d) => transcriptText.includes(`PWAKE_DONE ${d.cellTag} ${d.week}`)).length;

    await c.post(`/api/workspaces/${wsId}/sessions/${sessionId}/wake`, {
      message: JSON.stringify({ type: 'stop', cellTag: cell.tag }),
    }).catch(() => undefined);

    return {
      tag: cell.tag,
      regime: cell.regime,
      src: cell.src,
      totalReturn,
      maxDrawdown,
      buyHoldReturn: cell.stats.netReturn,
      buyHoldMaxDD: cell.stats.maxDD,
      H1_ratio: cell.stats.netReturn > 0 ? totalReturn / cell.stats.netReturn : null,
      H2_ratio: cell.stats.maxDD > 0 ? maxDrawdown / cell.stats.maxDD : null,
      decisions,
      session: {
        wsId,
        sessionId,
        pid: shellPid,
        runnerPid: ready.pid,
        wakeCount: decisions.length,
        stableSession: sessionPids.every((pid) => pid === shellPid),
        stableRunner: runnerPids.every((pid) => pid === ready.pid),
        transcriptBytes: Buffer.byteLength(transcriptText),
        transcriptHasDoneMarkers: doneMarkers === decisions.length,
        sessionPids,
        runnerPids,
        startedAt: session.startedAt,
      },
      sawLong,
    };
  } finally {
    if (transcript) transcript.close();
    if (!opts.keep) {
      if (wsId) await c.del(`/api/workspaces/${wsId}`).catch(() => undefined);
      if (acctId) await c.del(`/api/trading/config/uta/${acctId}`).catch(() => undefined);
    }
  }
}

async function createPaperAccount(c, label) {
  const created = await c.post('/api/trading/config/uta', {
    presetId: 'mock-simulator',
    presetConfig: { cash: START, ephemeral: true },
    label,
  });
  return created.id;
}

async function setAccountPaper(c, id, label) {
  await c.put(`/api/trading/config/uta/${id}`, {
    id,
    label,
    presetId: 'mock-simulator',
    enabled: true,
    guards: [],
    presetConfig: { cash: START, ephemeral: true },
    keyless: false,
    readOnly: false,
    maxAuthzLevel: 'paper',
    editable: true,
  });
}

async function waitAccountLive(c, id) {
  const deadline = Date.now() + 60000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      await c.get(`/api/trading/uta/${id}/account`);
      return;
    } catch (err) {
      last = err.message;
      await sleep(1500);
    }
  }
  throw new Error(`account ${id} did not become live: ${last}`);
}

async function waitStable(c, id, { need = 5, gapMs = 1500, preSleepMs = 3500 } = {}) {
  await sleep(preSleepMs);
  const deadline = Date.now() + 90000;
  let ok = 0;
  let last = '';
  while (Date.now() < deadline && ok < need) {
    try {
      await c.get(`/api/trading/uta/${id}/account`);
      ok++;
    } catch (err) {
      ok = 0;
      last = err.message;
    }
    if (ok < need) await sleep(gapMs);
  }
  if (ok < need) throw new Error(`account ${id} did not stabilize: ${last}`);
}

async function markPrice(c, accountId, price) {
  await c.post(`/api/simulator/uta/${accountId}/mark-price`, {
    nativeKey: SYMBOL,
    price,
  });
}

async function positionQty(c, accountId) {
  const body = await c.get(`/api/trading/uta/${accountId}/positions`);
  const arr = Array.isArray(body) ? body : body?.positions ?? [];
  return arr.reduce((sum, pos) => sum + Math.abs(Number(pos.quantity ?? pos.totalQuantity ?? 0)), 0);
}

function attachTranscript(base, cookie, sessionId) {
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/workspaces/pty?session=${encodeURIComponent(sessionId)}&cols=120&rows=40&client=pwake-harness&kind=harness&takeover=1`;
  const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  let chunks = '';
  let attached = false;
  let attachError = null;
  ws.on('message', (data, isBinary) => {
    if (isBinary) chunks += Buffer.from(data).toString('utf8');
    else {
      const text = Buffer.from(data).toString('utf8');
      chunks += text;
      try {
        const msg = JSON.parse(text);
        if (msg?.type === 'attached') attached = true;
      } catch {
        // ignore terminal text frames that are not control JSON
      }
    }
  });
  ws.on('error', (err) => {
    attachError = err;
  });
  return {
    waitAttached: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (!attached && Date.now() < deadline) {
        if (attachError) throw attachError;
        await sleep(100);
      }
      if (!attached) throw new Error(`PTY websocket did not attach for ${sessionId}`);
    },
    text: () => chunks,
    close: () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
  };
}

async function waitForJsonl(file, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = 0;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      lastSize = raw.length;
      const lines = raw.split(/\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try {
          entry = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (pred(entry)) return entry;
      }
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${basename(file)} (bytes=${lastSize})`);
}

function runnerSource() {
  return String.raw`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';

const EVENTS = 'persistent-wake-events.jsonl';
const DECISIONS = 'persistent-wake-decisions.jsonl';
const START = 100000;

function write(path, obj) {
  appendFileSync(path, JSON.stringify({ ...obj, at: new Date().toISOString() }) + '\n');
}

function cli(args) {
  const started = Date.now();
  try {
    const stdout = execFileSync('alice-uta', args, {
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    let json = null;
    try { json = JSON.parse(stdout); } catch { json = stdout.trim(); }
    return { ok: true, args, ms: Date.now() - started, json };
  } catch (err) {
    return {
      ok: false,
      args,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      stdout: err?.stdout?.toString?.() ?? '',
      stderr: err?.stderr?.toString?.() ?? '',
    };
  }
}

function tapeStats(series) {
  const closes = series.map((b) => Number(b.close));
  let peak = closes[0];
  let maxDD = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    const dd = (peak - close) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const ret = (closes[closes.length - 1] - closes[0]) / closes[0];
  const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, closes.length);
  const mom5 = closes.length > 5 ? (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] : 0;
  const mom10 = closes.length > 10 ? (closes[closes.length - 1] - closes[closes.length - 11]) / closes[closes.length - 11] : 0;
  return { ret, maxDD, sma5, mom5, mom10, last: closes[closes.length - 1] };
}

function decide(envelope) {
  const stats = tapeStats(envelope.series);
  const hasPosition = Number(envelope.positionQty || 0) > 0;
  const trend =
    stats.ret >= 0.12 &&
    stats.maxDD <= 0.12 &&
    stats.last >= stats.sma5 &&
    stats.mom5 >= 0 &&
    stats.mom10 >= 0.03;
  const danger = stats.ret <= -0.06 || stats.maxDD >= 0.14 || stats.last < stats.sma5 * 0.95;
  if (hasPosition && danger) return { kind: 'close_position', stats };
  if (!hasPosition && trend) return { kind: 'open_long', stats };
  return { kind: 'no_trade', stats };
}

async function handleWake(envelope) {
  const checklist = [
    cli(['git', 'log', '--source', envelope.accountId, '--limit', '3']),
    cli(['account', 'info', '--source', envelope.accountId]),
    cli(['account', 'portfolio', '--source', envelope.accountId]),
    cli(['git', 'status', '--source', envelope.accountId]),
  ];
  const decision = decide(envelope);
  const actionResults = [];
  const aliceId = envelope.accountId + '|' + envelope.symbol;
  if (decision.kind === 'open_long') {
    const qty = Math.max(1, Math.floor((START * 0.70) / Number(envelope.currentPrice)));
    const stop = (Number(envelope.currentPrice) * 0.92).toFixed(2);
    actionResults.push(cli([
      'order', 'place',
      '--aliceId', aliceId,
      '--action', 'BUY',
      '--orderType', 'MKT',
      '--totalQuantity', String(qty),
      '--stopLoss', JSON.stringify({ price: stop }),
      '--commitMessage', 'persistent wake long: trend evidence with protective stop',
    ]));
  } else if (decision.kind === 'close_position') {
    actionResults.push(cli([
      'position', 'close',
      '--aliceId', aliceId,
      '--commitMessage', 'persistent wake exit: thesis invalidated by drawdown or trend break',
    ]));
  }
  const action =
    decision.kind === 'open_long' ? 'propose_trade:open_long'
    : decision.kind === 'close_position' ? 'propose_trade:close_position'
    : 'no_trade';
  const record = {
    type: 'decision',
    pid: process.pid,
    cellTag: envelope.cellTag,
    regime: envelope.regime,
    week: envelope.week,
    action,
    stats: decision.stats,
    checklist: checklist.map((r) => ({ ok: r.ok, args: r.args, ms: r.ms, error: r.error ?? null })),
    actionResults: actionResults.map((r) => ({ ok: r.ok, args: r.args, ms: r.ms, error: r.error ?? null })),
  };
  write(DECISIONS, record);
  console.log('PWAKE_DONE ' + envelope.cellTag + ' ' + envelope.week + ' ' + action);
}

write(EVENTS, {
  type: 'ready',
  pid: process.pid,
  ppid: process.ppid,
  aqSessionId: process.env.AQ_SESSION_ID || null,
  aqWsId: process.env.AQ_WS_ID || null,
});
console.log('PWAKE_READY pid=' + process.pid);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let envelope;
  try {
    envelope = JSON.parse(trimmed);
  } catch (err) {
    write(EVENTS, { type: 'bad-json', pid: process.pid, text: trimmed.slice(0, 200) });
    continue;
  }
  if (envelope.type === 'stop') {
    write(EVENTS, { type: 'stopped', pid: process.pid, cellTag: envelope.cellTag ?? null });
    console.log('PWAKE_STOP pid=' + process.pid);
    process.exit(0);
  }
  if (envelope.type !== 'wake') {
    write(EVENTS, { type: 'ignored', pid: process.pid, envelopeType: envelope.type ?? null });
    continue;
  }
  write(EVENTS, { type: 'wake-received', pid: process.pid, cellTag: envelope.cellTag, week: envelope.week });
  await handleWake(envelope);
}
`;
}

function buildCells(campaignDir, want) {
  const cells = [];
  const need = { ...want };
  const harvest = (kind, syms) => {
    for (const sym of syms) {
      if (need.bull <= 0 && need.bear <= 0 && need.chop <= 0) break;
      const cache = join(campaignDir, `${kind === 'equity' ? 'eq' : 'cx'}-${sym}.json`);
      if (!existsSync(cache)) continue;
      const bars = JSON.parse(readFileSync(cache, 'utf8'));
      const picks = selectWindows(bars, LEN, ['bull', 'bear', 'chop']);
      for (const regime of ['bear', 'chop', 'bull']) {
        if (need[regime] <= 0 || !picks[regime]) continue;
        const window = bars.slice(picks[regime].i, picks[regime].i + LEN);
        const slug = String(sym).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        cells.push({
          tag: `pw-${regime}-${slug}`,
          regime,
          src: sym,
          stats: picks[regime].stats,
          series: anonymizeRich(window),
        });
        need[regime]--;
      }
    }
  };
  harvest('equity', EQUITY);
  harvest('crypto', CRYPTO);
  if (need.bull > 0 || need.bear > 0 || need.chop > 0) {
    throw new Error(`not enough campaign windows in ${campaignDir}; still need ${JSON.stringify(need)}`);
  }
  return cells;
}

function windowStats(bars) {
  const closes = bars.map((b) => Number(b.close));
  const netReturn = (closes[closes.length - 1] - closes[0]) / closes[0];
  let peak = closes[0];
  let maxDD = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    const dd = (peak - close) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return { netReturn, maxDD, dailyVol: Math.sqrt(variance), bars: bars.length };
}

function classify(stats) {
  if (stats.netReturn >= 0.30 && stats.maxDD < 0.35) return 'bull';
  if (stats.netReturn <= -0.30) return 'bear';
  if (Math.abs(stats.netReturn) <= 0.15 && stats.maxDD < 0.30) return 'chop';
  return 'mixed';
}

function selectWindows(bars, len, wanted) {
  const candidates = [];
  for (let i = 0; i + len <= bars.length; i += 5) {
    const stats = windowStats(bars.slice(i, i + len));
    candidates.push({ i, regime: classify(stats), stats });
  }
  const picks = {};
  for (const regime of wanted) {
    const pool = candidates.filter((c) => c.regime === regime);
    if (!pool.length) {
      picks[regime] = null;
      continue;
    }
    pool.sort((a, b) =>
      regime === 'bull' ? b.stats.netReturn - a.stats.netReturn
        : regime === 'bear' ? a.stats.netReturn - b.stats.netReturn
          : Math.abs(a.stats.netReturn) - Math.abs(b.stats.netReturn));
    picks[regime] = pool[0];
  }
  return picks;
}

function anonymizeRich(bars) {
  const ps = 100 / Number(bars[0].close);
  const vs = bars[0].volume ? 100 / Number(bars[0].volume) : 1;
  const r2 = (x) => Math.round(x * 100) / 100;
  return bars.map((b, day) => ({
    day,
    open: r2(Number(b.open) * ps),
    high: r2(Number(b.high) * ps),
    low: r2(Number(b.low) * ps),
    close: r2(Number(b.close) * ps),
    volume: Math.round((Number(b.volume) || 0) * vs),
  }));
}

function maxDrawdownFromEquity(equity) {
  let peak = equity[0];
  let maxDD = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function verdict(r) {
  if (r.error) return 'ERR';
  const ret = r.totalReturn;
  const dd = r.maxDrawdown;
  if (r.regime === 'bull') return r.H1_ratio != null && r.H1_ratio >= 0.25 && dd <= 0.10 ? 'PASS' : 'WEAK';
  if (r.regime === 'bear') return ret >= -0.08 && dd <= Math.max(0.12, r.buyHoldMaxDD * 0.5) ? 'PASS' : 'FAIL';
  return Math.abs(ret) <= 0.06 && dd <= 0.08 ? 'PASS' : 'FAIL';
}

function summarize(results) {
  return ['bull', 'bear', 'chop'].map((regime) => {
    const items = results.filter((r) => r.regime === regime);
    const complete = items.filter((r) => !r.error);
    return {
      regime,
      count: items.length,
      complete: complete.length,
      pass: complete.filter((r) => r.verdict === 'PASS').length,
      weak: complete.filter((r) => r.verdict === 'WEAK').length,
      fail: complete.filter((r) => r.verdict === 'FAIL').length,
      err: items.filter((r) => r.error).length,
      meanReturn: complete.length ? complete.reduce((s, r) => s + r.totalReturn, 0) / complete.length : null,
      meanDrawdown: complete.length ? complete.reduce((s, r) => s + r.maxDrawdown, 0) / complete.length : null,
    };
  });
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
