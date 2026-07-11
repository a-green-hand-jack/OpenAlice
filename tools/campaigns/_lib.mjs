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
