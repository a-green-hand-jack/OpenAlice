#!/usr/bin/env node
/**
 * Campaign step 3 — render a markdown report from one or more completed cell
 * runs (tools/campaigns/runs/<runId>/result.json), matching the shape of the
 * existing docs/appendix/steward-paper-campaign-*.md files: a results matrix
 * (per-cell H1/H2 + regime verdict), a cost breakdown, per-cell behavioral
 * narration, and the §4.3 residual-risk declaration.
 *
 * Usage:
 *   node tools/campaigns/report.mjs --run tools/campaigns/runs/<runId> [--run <dir>...] [--out report.md]
 * With no --out the report is written to stdout.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const out = { runs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`missing value for ${a}`); return v; };
    if (a === '--run') out.runs.push(next());
    else if (a === '--out') out.out = next();
    else if (a === '--help' || a === '-h') { console.log('report.mjs --run <dir> [--run <dir>...] [--out report.md]'); process.exit(0); }
    else throw new Error(`unknown arg: ${a}`);
  }
  if (out.runs.length === 0) throw new Error('at least one --run <dir> required');
  return out;
}

const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const usd = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `$${Number(x).toFixed(4)}`);
const money = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `$${Number(x).toFixed(2)}`);

function loadResult(runDir) {
  const p = join(resolve(runDir), 'result.json');
  if (!existsSync(p)) throw new Error(`no result.json in ${runDir}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function render(results) {
  const L = [];
  L.push('# Steward persistent-wake backtest — campaign report');
  L.push('');
  L.push(`> Generated ${new Date().toISOString()} by \`tools/campaigns/report.mjs\`.`);
  L.push('> Mechanism: persistent-wake steward (`/api/workspaces/:id/steward/wakes`), blind mode (#66),');
  L.push('> MockBroker historical-bar replay (#67), paper auto-push (P3-4a). Agent: claude + haiku-4.5.');
  L.push('> Windows: 6 weeks × 5 daily bars, one weekly decision each. Anonymized per §4.3');
  L.push('> (day-0 close = 100, fictional day index, symbol → codename). Guards: max-drawdown + max-position-size.');
  L.push('');

  // ── results matrix ──────────────────────────────────────────────────────
  L.push('## Results matrix');
  L.push('');
  L.push('| Run | Regime | Agent ret | Buy-hold | Agent maxDD | BH maxDD | H1 (ret/BH) | H2 (DD/BH-DD) | Model cost | Net PnL | Verdict |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const m = r.metrics;
    L.push(`| ${r.runId} | ${r.cell.regime} | ${pct(m.totalReturn)} | ${pct(m.buyHoldReturn)} | ${pct(m.agentMaxDD)} | ${pct(m.buyHoldMaxDD)} | ${pct(m.h1CaptureVsBuyHold)} | ${pct(m.h2DrawdownVsBuyHold)} | ${usd(r.cost.modelCostUsd)} | ${money(r.net.netPnL)} | ${r.verdict.pass ? 'PASS' : 'FAIL'} |`);
  }
  L.push('');
  L.push('Verdict rules (§4.6, regime-aware): ' + [...new Set(results.map((r) => `${r.cell.regime} → ${r.verdict.rule}`))].join('; ') + '.');
  L.push('');

  // ── cost breakdown ────────────────────────────────────────────────────
  L.push('## Cost breakdown');
  L.push('');
  L.push('| Run | Turns | Input tok | Output tok | Cache-read tok | Cache-write tok | Model cost | Ledger-reported cost |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const t = r.cost.transcript;
    L.push(`| ${r.runId} | ${t.turns} | ${t.inputTokens} | ${t.outputTokens} | ${t.cacheReadTokens} | ${t.cacheWriteTokens} | ${usd(r.cost.modelCostUsd)} | ${usd(r.cost.ledgerReportedCostUsd)} |`);
  }
  L.push('');
  L.push('Model cost = claude transcript token usage × Haiku 4.5 pricing ($1.00/$5.00 per 1M in/out, cache-read ×0.1, cache-write ×1.25).');
  L.push('"Ledger-reported cost" is the steward `state.json` cost summary — the agent leaves those fields null, so it aggregates to 0; the transcript-derived figure is the ground truth for model spend.');
  L.push('');

  // ── per-cell narration ────────────────────────────────────────────────
  L.push('## Per-cell behavior');
  L.push('');
  for (const r of results) {
    const m = r.metrics;
    L.push(`### ${r.runId} — ${r.cell.regime} (${r.cell.codename})`);
    L.push('');
    L.push(`- **Outcome**: gross PnL ${money(m.grossPnL)} (${pct(m.totalReturn)}), agent maxDD ${pct(m.agentMaxDD)}; buy-hold ${pct(m.buyHoldReturn)} / maxDD ${pct(m.buyHoldMaxDD)}. Verdict **${r.verdict.pass ? 'PASS' : 'FAIL'}** (${r.verdict.rule}).`);
    L.push(`- **Cost**: ${usd(r.cost.modelCostUsd)} model spend over ${r.weeksRun} weekly wakes → net PnL ${money(r.net.netPnL)}.`);
    L.push(`- **Equity curve** (start → weekly → final): ${m.equityCurve.map((e) => Math.round(e)).join(' → ')}`);
    L.push('- **Weekly decisions**:');
    for (const w of r.weeks) {
      const thesis = w.thesis ? ` — "${String(w.thesis).replace(/\s+/g, ' ').slice(0, 160)}"` : '';
      const acts = Array.isArray(w.actions) && w.actions.length ? ` [${w.actions.length} action(s)]` : '';
      L.push(`  - wk${w.week}: \`${w.status}\`/\`${w.decision ?? '—'}\`${acts} · equity ${Number.isFinite(w.equity) ? Math.round(w.equity) : 'n/a'} · qty ${w.positionQty ?? '?'}${thesis}`);
    }
    L.push('');
  }

  // ── methodology / residual risk ──────────────────────────────────────
  L.push('## §4.3 residual-risk declaration');
  L.push('');
  L.push('Symbols, price magnitudes, and calendar dates were anonymized (codename, day-0 = 100 rebasing, fictional day index), and blind mode (#66) seals the identity-revealing market/analysis/news/fundamentals tools at the tool layer — the agent can only reach the anonymized bar source for its own mock account. Residual risk (per §4.3): the *shape* of a famous window could still be recognized. These runs therefore measure **behavioral discipline** (does it stop-loss, size prudently, participate in clear uptrends, stay out of drawdowns) rather than alpha — consistent with how H1/H2 are defined relative to buy-hold, not absolute prediction skill.');
  L.push('');
  return L.join('\n') + '\n';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const results = opts.runs.map(loadResult);
  const md = render(results);
  if (opts.out) { writeFileSync(resolve(opts.out), md); process.stderr.write(`report → ${resolve(opts.out)}\n`); }
  else process.stdout.write(md);
}

main();
