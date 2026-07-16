/**
 * Shared helpers for the steward persistent-wake backtest campaign harness.
 *
 * Orchestrator-side eval tooling (NOT product code — lives outside src/ per the
 * steward-plan I6 invariant). Plain Node ESM, zero npm dependencies: uses the
 * built-in global `fetch` for HTTP and `node:https` is not needed.
 *
 * The campaign drives the NOW-WORKING persistent-wake steward mechanism
 * (`/api/workspaces/:id/steward/wakes`) through real historical daily bars,
 * anonymized per docs/steward-p3-campaign.zh.md §4.3, to produce trading-
 * behavior + cost evidence. This module holds everything the fetch / run / report
 * scripts share: regime classification (§4.6 thresholds), anonymization,
 * window selection, the authenticated HTTP client, and the regime verdict.
 */

// ── constants ──────────────────────────────────────────────────────────────

/** 6 weeks × 5 daily bars = 30-bar window, 6 weekly decision points (§4.6). */
export const WEEKS = 6;
export const BARS_PER_WEEK = 5;
export const WINDOW_LEN = WEEKS * BARS_PER_WEEK;
export const START_CASH = 100_000;

/** Haiku 4.5 sticker pricing, USD per 1M tokens (claude-api skill, 2026-06). */
export const HAIKU_PRICE = {
  model: 'claude-haiku-4-5',
  inputPerMTok: 1.0,
  outputPerMTok: 5.0,
  // Cache reads bill ~0.1x input; cache writes ~1.25x input (5-min TTL).
  cacheReadPerMTok: 0.1,
  cacheWritePerMTok: 1.25,
};

// ── math ─────────────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Peak-to-trough max drawdown of a value series, as a positive fraction. */
export function maxDrawdown(values) {
  let peak = values[0] ?? 0;
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
}

/** Buy-and-hold stats for one candidate window of raw daily bars. */
export function windowStats(bars) {
  const closes = bars.map((b) => Number(b.close));
  const netReturn = (closes[closes.length - 1] - closes[0]) / closes[0];
  const maxDD = maxDrawdown(closes);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  return { netReturn, maxDD, dailyVol: Math.sqrt(variance), bars: bars.length };
}

/**
 * Regime classification — the ACTUAL thresholds from campaign §4.6
 * (data.mjs `classify`), NOT the looser prose definitions in §4.1–4.4:
 *   bull  = net gain ≥ 30% AND maxDD < 35%
 *   bear  = net loss ≥ 30%
 *   chop  = |net| ≤ 15% AND maxDD < 30%
 * anything else is 'mixed' (unusable — a window that's neither cleanly trending
 * nor cleanly ranging).
 */
export function classifyRegime(stats) {
  if (stats.netReturn >= 0.3 && stats.maxDD < 0.35) return 'bull';
  if (stats.netReturn <= -0.3) return 'bear';
  if (Math.abs(stats.netReturn) <= 0.15 && stats.maxDD < 0.3) return 'chop';
  return 'mixed';
}

/**
 * Select the single most-typical non-overlapping window for the wanted regime
 * from a full daily-bar history. Slides a WINDOW_LEN window in 5-bar steps,
 * classifies each, then picks the most extreme match:
 *   bull → highest net return; bear → lowest (most negative); chop → smallest |net|.
 * Returns { i, stats } or null when no window in the history matches.
 */
export function selectWindow(bars, regime, len = WINDOW_LEN) {
  const candidates = [];
  for (let i = 0; i + len <= bars.length; i += 5) {
    const stats = windowStats(bars.slice(i, i + len));
    if (classifyRegime(stats) === regime) candidates.push({ i, stats });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    regime === 'bull' ? b.stats.netReturn - a.stats.netReturn
      : regime === 'bear' ? a.stats.netReturn - b.stats.netReturn
        : Math.abs(a.stats.netReturn) - Math.abs(b.stats.netReturn));
  return candidates[0];
}

/**
 * §4.3 anti-cheat anonymization (deterministic, per §4.6): rebase so the first
 * close = 100, drop real dates for a fictional day index. Blind mode (issue #66)
 * enforces the identity seal at the tool layer; this rebasing defends the
 * price-magnitude + calendar channels the tool seal doesn't cover.
 */
export function anonymize(bars) {
  const scale = 100 / Number(bars[0].close);
  const r2 = (x) => Math.round(x * 100) / 100;
  return bars.map((b, day) => ({
    day,
    open: r2(Number(b.open) * scale),
    high: r2(Number(b.high) * scale),
    low: r2(Number(b.low) * scale),
    close: r2(Number(b.close) * scale),
    volume: Math.round((Number(b.volume) || 0) * scale),
  }));
}

// ── regime verdict (§4.6 regime-aware pass/fail) ─────────────────────────────

/**
 * Regime-aware PASS/FAIL per campaign §4.6's "判据" row:
 *   bull → agent return ≥ 25% AND maxDD ≤ 10%
 *   bear → agent return ≥ −8%  AND maxDD ≤ max(12%, ½·buy-hold DD)
 *   chop → |agent return| ≤ 6% AND maxDD ≤ 8%
 * `agentReturn` / `agentMaxDD` are fractions; `bhMaxDD` is the buy-hold DD.
 */
export function regimeVerdict(regime, agentReturn, agentMaxDD, bhMaxDD) {
  if (regime === 'bull') {
    const pass = agentReturn >= 0.25 && agentMaxDD <= 0.1;
    return { pass, rule: 'ret ≥ +25% AND maxDD ≤ 10%' };
  }
  if (regime === 'bear') {
    const ddCap = Math.max(0.12, 0.5 * bhMaxDD);
    const pass = agentReturn >= -0.08 && agentMaxDD <= ddCap;
    return { pass, rule: `ret ≥ −8% AND maxDD ≤ ${(ddCap * 100).toFixed(1)}% (max(12%, ½·BH-DD))` };
  }
  if (regime === 'chop') {
    const pass = Math.abs(agentReturn) <= 0.06 && agentMaxDD <= 0.08;
    return { pass, rule: '|ret| ≤ 6% AND maxDD ≤ 8%' };
  }
  return { pass: false, rule: 'unknown regime' };
}

/** Terminal wake statuses that MUST leave a decision-ledger entry (issue #134).
 *  timeout/stuck are terminal but write no ledger entry. */
export const LEDGER_BACKED_TERMINAL = new Set(['done', 'blocked', 'error']);

/**
 * Audit finalization set-equality (issue #134). A clean run's set of
 * ledger-backed terminal wakes (`done|blocked|error` per-week status) must
 * exactly equal the set of first-wins wakeIds in the exported final ledger. The
 * original bug wrote a trustworthy-looking result claiming six done weeks while
 * only five decisions survived in decisions.jsonl (the persistent session
 * deleted and rebuilt the file). This makes that divergence a hard,
 * deterministic audit failure instead of a silent inconsistency.
 *
 * @param {{ weeks?: Array<{ wakeId?: string, status?: string }>, ledgerEntries?: Array<{ wakeId?: string }> }} input
 * @returns {{ valid: boolean, terminalLedgerBackedWakes: number, finalLedgerEntries: number, missingFromLedger: string[], extraInLedger: string[] }}
 */
export function auditFinalization({ weeks = [], ledgerEntries = [] } = {}) {
  const terminalLedgerBacked = [];
  const seenWake = new Set();
  for (const w of weeks) {
    if (w && typeof w.wakeId === 'string' && LEDGER_BACKED_TERMINAL.has(w.status) && !seenWake.has(w.wakeId)) {
      seenWake.add(w.wakeId);
      terminalLedgerBacked.push(w.wakeId);
    }
  }
  const finalLedgerWakeIds = [];
  const seenLedger = new Set();
  for (const e of ledgerEntries) {
    if (e && typeof e.wakeId === 'string' && !seenLedger.has(e.wakeId)) {
      seenLedger.add(e.wakeId);
      finalLedgerWakeIds.push(e.wakeId);
    }
  }
  const finalSet = new Set(finalLedgerWakeIds);
  const backedSet = new Set(terminalLedgerBacked);
  const missingFromLedger = terminalLedgerBacked.filter((id) => !finalSet.has(id));
  const extraInLedger = finalLedgerWakeIds.filter((id) => !backedSet.has(id));
  return {
    valid: missingFromLedger.length === 0 && extraInLedger.length === 0,
    terminalLedgerBackedWakes: terminalLedgerBacked.length,
    finalLedgerEntries: finalLedgerWakeIds.length,
    missingFromLedger,
    extraInLedger,
  };
}

/**
 * Compute the finalization trust verdict (issue #134, PR #135 review). Folds the
 * set-equality audit AND any structured `ledger_integrity_violation` events the
 * supervisor recorded into a single `trustworthy` boolean, and returns the audit
 * block a run result should persist. This is the wiring `run-cell.mjs` uses so a
 * run is `trustworthy:false` whenever EITHER the terminal-wake/ledger sets
 * diverge OR the supervisor flagged a corruption drift — a result must never
 * read as a normal pass while either is true.
 *
 * @param {{ weeks?: Array<{ wakeId?: string, status?: string }>, ledgerEntries?: Array<{ wakeId?: string }>, integrityViolations?: unknown[] }} input
 * @returns {{ trustworthy: boolean, audit: object }}
 */
export function finalizationTrust({ weeks = [], ledgerEntries = [], integrityViolations = [] } = {}) {
  const base = auditFinalization({ weeks, ledgerEntries });
  const trustworthy = base.valid && integrityViolations.length === 0;
  return {
    trustworthy,
    audit: {
      ...base,
      valid: trustworthy,
      setEqual: base.valid,
      integrityViolations,
    },
  };
}

/**
 * Optimistic upper bound for a long-only weekly steward under the configured
 * max-position guard: enter at each weekly decision close with max allowed
 * notional and hold to the final close, then keep the best result. This is not
 * an agent strategy; it is an evaluation sanity check. If a bull cell's target
 * return is above this bound, the cell/guard/threshold combination is
 * impossible before model behavior enters the picture.
 */
export function maxWeeklyLongReturnUnderExposure(series, maxPositionPct = 60, startCash = START_CASH, barsPerWeek = BARS_PER_WEEK) {
  const finalClose = Number(series[series.length - 1]?.close);
  const maxNotional = startCash * (maxPositionPct / 100);
  let best = {
    return: Number.NEGATIVE_INFINITY,
    week: null,
    entryClose: null,
    shares: 0,
    finalClose,
    maxPositionPct,
  };
  if (!Number.isFinite(finalClose) || finalClose <= 0) return { ...best, return: null };
  for (let i = barsPerWeek - 1, week = 1; i < series.length; i += barsPerWeek, week++) {
    const entryClose = Number(series[i]?.close);
    if (!Number.isFinite(entryClose) || entryClose <= 0) continue;
    const shares = Math.floor(maxNotional / entryClose);
    const ret = (shares * (finalClose - entryClose)) / startCash;
    if (ret > best.return) {
      best = { return: ret, week, entryClose, shares, finalClose, maxPositionPct };
    }
  }
  return best.return === Number.NEGATIVE_INFINITY ? { ...best, return: null } : best;
}

// ── risk envelope (issue #253) ───────────────────────────────────────────

/**
 * Build the mandatory Risk Envelope (migration 0012 / v3 admission wire —
 * `packages/uta-protocol/src/schemas/risk-envelope.ts`) for a campaign's
 * mock UTA account. Effective steward authz is
 * `min(account.maxAuthzLevel, workspace authz, envelope.autonomyCeiling)`
 * (`packages/uta-protocol/src/types/authz.ts` `resolveEffectiveAuthzLevel`);
 * without a valid, non-revoked, whitelist-scoped envelope the account absorbs
 * to `read_only` and every mutation tool (placeOrder/modifyOrder/
 * closePosition/cancelOrder/tradingCommit/tradingReject — all gated at
 * `paper`, `src/core/workspace-tool-center.ts` `TRADING_TOOL_MIN_AUTHZ_LEVEL`)
 * stays hidden from the steward workspace.
 *
 * @param {string} codename the cell's anonymized instrument id (whitelist scope)
 * @param {{ maxDdPct?: number, maxPosPct?: number }} [opts] mirrors the same
 *   guard percentages run-cell.mjs already applies via the account's
 *   `max-drawdown` / `max-position-size` guards, so the envelope doesn't
 *   introduce a second, inconsistent limit.
 */
export function buildCampaignRiskEnvelope(codename, opts = {}) {
  const maxPositionPctOfEquity = opts.maxPosPct ?? 60;
  const maxDrawdownPct = opts.maxDdPct ?? 10;
  return {
    version: 1,
    maxPositionPctOfEquity,
    maxSingleOrderPctOfEquity: maxPositionPctOfEquity,
    maxDailyLossPct: maxDrawdownPct,
    maxDrawdownPct,
    scope: { kind: 'whitelist', symbols: [codename] },
    autonomyCeiling: 'paper',
    revoked: false,
    revokedReason: null,
  };
}

/**
 * Build the exact `POST /api/trading/config/uta` body run-cell.mjs sends to
 * create the campaign's mock-simulator account, including the mandatory
 * `riskEnvelope` (issue #253 — see `buildCampaignRiskEnvelope` above for why
 * dropping this field silently absorbs effective authz to `read_only`).
 * Pulled out as a pure helper so the regression spec can assert on the
 * actual create-payload shape instead of only on `buildCampaignRiskEnvelope`
 * in isolation, closing the "field silently dropped from the POST body"
 * blind spot.
 *
 * @param {string} codename the cell's anonymized instrument id (whitelist scope)
 * @param {string} runId the campaign run id (used to label the account)
 * @param {{ maxDdPct?: number, maxPosPct?: number }} [opts] guard percentages,
 *   forwarded verbatim to both the guards array and `buildCampaignRiskEnvelope`
 *   so the envelope never drifts from the account's own guards.
 */
export function buildCampaignAccountCreatePayload(codename, runId, opts = {}) {
  return {
    presetId: 'mock-simulator',
    presetConfig: { cash: START_CASH },
    label: `campaign-${runId}`,
    guards: [
      { type: 'max-drawdown', options: { maxDrawdownPct: opts.maxDdPct } },
      { type: 'max-position-size', options: { maxPercentOfEquity: opts.maxPosPct } },
    ],
    riskEnvelope: buildCampaignRiskEnvelope(codename, opts),
  };
}

// ── cleanup decision (issue #256) ────────────────────────────────────────

/**
 * Whether run-cell.mjs should delete the workspace + mock account it created
 * for this run. A run that threw (`succeeded: false`) keeps both for
 * forensics regardless of `keep`; a run that completed keeps them only when
 * `--keep` was passed.
 *
 * @param {{ succeeded: boolean, keep: boolean }} input
 * @returns {boolean}
 */
export function shouldCleanup({ succeeded, keep }) {
  return Boolean(succeeded) && !keep;
}

// ── data sources ─────────────────────────────────────────────────────────

/**
 * Crypto daily bars via Binance public REST (no key). Returns newest-last
 * OHLCV objects. `limit` capped at 1000 by Binance.
 */
export async function fetchBinanceDaily(symbol, limit = 1000) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${symbol} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  // kline row: [openTime, open, high, low, close, volume, closeTime, ...]
  return rows.map((r) => ({
    date: new Date(r[0]).toISOString().slice(0, 10),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
}

// ── authenticated Alice HTTP client ──────────────────────────────────────

/** Log in with the first-run admin token; returns the alice_session cookie. */
export async function login(base, token) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/alice_session=[^;]+/);
  if (!m) throw new Error('login response had no alice_session cookie');
  return m[0];
}

/**
 * Minimal fetch wrapper carrying the session cookie + Origin (CSRF gate).
 * Every call gets a hard timeout (default 180s) so a wedged UTA proxy — e.g.
 * mid-restart — can never block the harness forever; callers that expect a
 * fast answer (liveness probes) pass a short `{ timeoutMs }`.
 */
export function makeClient(base, cookie, defaultTimeoutMs = 180_000) {
  async function req(method, path, body, timeoutMs = defaultTimeoutMs) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...(method === 'GET' ? {} : { Origin: base }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    if (!res.ok) {
      const msg = typeof json === 'string' ? json : JSON.stringify(json);
      throw new Error(`${method} ${path} -> ${res.status}: ${String(msg).slice(0, 500)}`);
    }
    return json;
  }
  return {
    base,
    cookie,
    get: (p, timeoutMs) => req('GET', p, undefined, timeoutMs),
    post: (p, b, timeoutMs) => req('POST', p, b, timeoutMs),
    put: (p, b, timeoutMs) => req('PUT', p, b, timeoutMs),
    patch: (p, b, timeoutMs) => req('PATCH', p, b, timeoutMs),
    del: (p, timeoutMs) => req('DELETE', p, undefined, timeoutMs),
  };
}

/**
 * Read the first-run admin token from the dev-stack log. Matches the
 * "First-run admin token" banner Guardian/Alice prints on a fresh sandbox.
 */
export function tokenFromLog(logText) {
  // The banner prints the token on its own; grab the first 40+ char base64url run
  // after the banner line.
  const idx = logText.indexOf('First-run admin token');
  const tail = idx >= 0 ? logText.slice(idx) : logText;
  const m = tail.match(/([A-Za-z0-9_-]{40,})/);
  return m ? m[1] : null;
}

// ── alice-lab experiment matrix (issue #259) ─────────────────────────────
//
// Pure decision logic for `lab.mjs` — config validation/normalization,
// run-id generation, port-block derivation, and exit-code derivation from
// completed run results. Process/stack-lifecycle orchestration stays in
// lab.mjs itself (not spec'd here — the smoke run covers that surface).

/** Default web port when an experiment.json doesn't set `basePort`. */
export const DEFAULT_LAB_BASE_PORT = 49631;

const EXPERIMENT_REQUIRED_FIELDS = ['name', 'weeks', 'rounds', 'cells', 'arms', 'maxRuns'];
const EXPERIMENT_ALLOWED_FIELDS = new Set([...EXPERIMENT_REQUIRED_FIELDS, 'basePort', 'allowHoldout']);
const ARM_ALLOWED_FIELDS = new Set(['id', 'agent', 'model', 'overlayDir']);

/**
 * Validate + normalize an experiment.json body (v1 shape — see issue #259).
 * Pure function: no filesystem access (cell-file-exists checks happen in
 * lab.mjs, which needs the real `tools/campaigns/cells/` directory).
 * Throws a descriptive Error on any violation; never partially validates.
 *
 * @param {unknown} config
 * @returns {{ name: string, weeks: number, rounds: number, cells: string[],
 *   arms: Array<{ id: string, agent: string, model: string, overlayDir?: string }>,
 *   maxRuns: number, allowHoldout: boolean, basePort: number, totalRuns: number }}
 */
export function validateExperimentConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('experiment config must be a JSON object');
  }
  const unknownFields = Object.keys(config).filter((k) => !EXPERIMENT_ALLOWED_FIELDS.has(k));
  if (unknownFields.length) {
    throw new Error(`experiment.json has unknown field(s): ${unknownFields.join(', ')}`);
  }
  for (const field of EXPERIMENT_REQUIRED_FIELDS) {
    if (config[field] === undefined) throw new Error(`experiment.json missing required field: ${field}`);
  }

  const { name, weeks, rounds, cells, arms, maxRuns } = config;
  if (typeof name !== 'string' || !name.trim()) throw new Error('experiment.json "name" must be a non-empty string');
  if (!Number.isInteger(weeks) || weeks <= 0) throw new Error('experiment.json "weeks" must be a positive integer');
  if (!Number.isInteger(rounds) || rounds <= 0) throw new Error('experiment.json "rounds" must be a positive integer');
  if (!Number.isInteger(maxRuns) || maxRuns <= 0) throw new Error('experiment.json "maxRuns" must be a positive integer');

  if (!Array.isArray(cells) || cells.length === 0) throw new Error('experiment.json "cells" must be a non-empty array');
  for (const cell of cells) {
    if (typeof cell !== 'string' || !cell.trim()) throw new Error(`experiment.json "cells" entries must be non-empty strings (got ${JSON.stringify(cell)})`);
  }

  const allowHoldout = config.allowHoldout ?? false;
  if (typeof allowHoldout !== 'boolean') throw new Error('experiment.json "allowHoldout" must be a boolean');
  if (!allowHoldout) {
    const holdoutCells = cells.filter((c) => c.startsWith('holdout-'));
    if (holdoutCells.length) {
      throw new Error(
        `experiment.json references holdout cell(s) [${holdoutCells.join(', ')}] without "allowHoldout": true — ` +
        'holdout discipline requires an explicit opt-in',
      );
    }
  }

  const basePort = config.basePort ?? DEFAULT_LAB_BASE_PORT;
  if (!Number.isInteger(basePort) || basePort <= 0 || basePort > 65_000) {
    throw new Error('experiment.json "basePort" must be an integer port number (<= 65000)');
  }

  if (!Array.isArray(arms) || arms.length === 0) throw new Error('experiment.json "arms" must be a non-empty array');
  const seenArmIds = new Set();
  const normalizedArms = arms.map((arm, i) => {
    if (!arm || typeof arm !== 'object' || Array.isArray(arm)) throw new Error(`experiment.json arms[${i}] must be an object`);
    const unknownArmFields = Object.keys(arm).filter((k) => !ARM_ALLOWED_FIELDS.has(k));
    if (unknownArmFields.length) throw new Error(`experiment.json arms[${i}] has unknown field(s): ${unknownArmFields.join(', ')}`);
    if (typeof arm.id !== 'string' || !arm.id.trim()) throw new Error(`experiment.json arms[${i}] missing required field: id`);
    if (seenArmIds.has(arm.id)) throw new Error(`experiment.json has duplicate arm id: "${arm.id}"`);
    seenArmIds.add(arm.id);
    if (arm.agent !== 'codex') {
      throw new Error(
        `experiment.json arms[${i}] ("${arm.id}") has agent "${arm.agent}" — v1 only supports "codex" arms ` +
        '(per-arm claude model pinning has no per-workspace write surface yet; see issue #259 audit §7)',
      );
    }
    if (typeof arm.model !== 'string' || !arm.model.trim()) throw new Error(`experiment.json arms[${i}] ("${arm.id}") missing required field: model`);
    if (arm.overlayDir !== undefined && (typeof arm.overlayDir !== 'string' || !arm.overlayDir.trim())) {
      throw new Error(`experiment.json arms[${i}] ("${arm.id}") "overlayDir" must be a non-empty string when present`);
    }
    return { id: arm.id, agent: arm.agent, model: arm.model, ...(arm.overlayDir ? { overlayDir: arm.overlayDir } : {}) };
  });

  const totalRuns = normalizedArms.length * cells.length * rounds;
  if (totalRuns > maxRuns) {
    throw new Error(
      `experiment.json budget exceeded: ${normalizedArms.length} arms × ${cells.length} cells × ${rounds} rounds ` +
      `= ${totalRuns} runs > maxRuns ${maxRuns} — refusing to start`,
    );
  }

  return { name, weeks, rounds, cells: [...cells], arms: normalizedArms, maxRuns, allowHoldout, basePort, totalRuns };
}

/** Deterministic run-id for one (arm, cell, round) cell of the matrix. */
export function generateRunId(name, armId, cell, round) {
  return `${name}-${armId}-${cell}-r${round}`;
}

/**
 * Derive the four dev-stack ports for one arm's sandboxed `pnpm dev` from a
 * single base port, matching `scripts/guardian/shared.ts` port roles
 * (web/mcp/uta/ui). Leaves a gap at +3 (mirrors the checked-in default
 * 49631/49632/49633/49635) so an adjacent manual dev stack on +3 doesn't
 * collide.
 */
export function derivePortBlock(basePort = DEFAULT_LAB_BASE_PORT) {
  return { web: basePort, mcp: basePort + 1, uta: basePort + 2, ui: basePort + 4 };
}

/**
 * Runner exit code from the final list of per-run results. 0 only when
 * every run in the matrix succeeded; 2 when the matrix completed but at
 * least one run failed or was skipped (arm boot failure). Runner-level
 * fatal errors (bad config, budget exceeded, etc.) are a separate path in
 * lab.mjs that exits 1 before any run result exists.
 *
 * @param {Array<{ status: 'ok' | 'failed' | 'skipped' }>} runs
 */
export function deriveExitCode(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return 2;
  return runs.every((r) => r.status === 'ok') ? 0 : 2;
}

// ── stack teardown / boot-race decision logic (issue #259 review) ───────
//
// Pure classification helpers pulled out of lab.mjs's process-lifecycle code
// so the decision logic itself (not the spawn/signal plumbing) can be unit
// spec'd without booting a real stack.

/**
 * Classify a `fetch()` rejection against a port lab.mjs is polling for
 * "freed". Only ECONNREFUSED means nothing is listening (the process that
 * held the port is gone) — any other rejection (abort/timeout, DNS oddity,
 * a transient network error) must NOT be read as "free", or a teardown poll
 * could declare victory while the old stack is still mid-shutdown holding
 * the port. Node's fetch (undici) wraps a refused TCP connect as
 * `TypeError('fetch failed')` with `err.cause` set to the underlying
 * `node:net` error carrying `.code`.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isPortFreeError(err) {
  return Boolean(err) && typeof err === 'object' && err.cause?.code === 'ECONNREFUSED';
}

/**
 * Pure decision for whether a stack teardown succeeded: given the final
 * port-free poll result after the SIGTERM→grace→SIGKILL sequence, either
 * teardown is done, or — since every arm in an experiment shares the same
 * port block (`derivePortBlock(config.basePort)` is derived once per
 * experiment, not per arm) — a still-bound port means a leaked process
 * would corrupt every subsequent arm's boot. That must stop the whole
 * matrix, not just fail one arm.
 *
 * @param {{ armId: string, port: number, freed: boolean, timeoutMs: number }} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function deriveTeardownOutcome({ armId, port, freed, timeoutMs }) {
  if (freed) return { ok: true };
  return {
    ok: false,
    reason: `arm ${armId}: stack teardown failed — port ${port} still bound ${timeoutMs}ms after SIGTERM+SIGKILL; ` +
      'refusing to continue (would corrupt subsequent arms sharing this port block)',
  };
}

/**
 * Pure decision for `waitStackReady`'s race between stack readiness and the
 * boot child dying early (e.g. a port conflict from a previous arm's
 * teardown not having freed in time). Distinguishes "timed out waiting" from
 * "the process is already dead, waiting longer can't help" so lab.mjs fails
 * the arm immediately in the latter case instead of polling for the full
 * `STACK_READY_TIMEOUT_MS`.
 *
 * @param {{ ready: boolean, exited: boolean, exitCode?: number | null, exitSignal?: string | null, timeoutMs: number }} input
 * @returns {{ ok: true } | { ok: false, status: 'exited' | 'timeout', reason: string }}
 */
export function deriveBootOutcome({ ready, exited, exitCode = null, exitSignal = null, timeoutMs }) {
  if (ready) return { ok: true };
  if (exited) {
    return {
      ok: false,
      status: 'exited',
      reason: `stack process exited during boot (code ${exitCode ?? 'null'} / signal ${exitSignal ?? 'null'})`,
    };
  }
  return { ok: false, status: 'timeout', reason: `stack did not become ready within ${timeoutMs}ms` };
}

/**
 * Last `n` lines of a log buffer, for embedding a compact tail in a
 * failure reason (e.g. "why did the stack die during boot"). Drops a single
 * trailing empty element from a final `\n` so typical log text (which
 * usually ends in a newline) isn't off-by-one on the line count.
 *
 * @param {string} text
 * @param {number} [n]
 * @returns {string}
 */
export function lastLogLines(text, n = 20) {
  const lines = String(text ?? '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}
