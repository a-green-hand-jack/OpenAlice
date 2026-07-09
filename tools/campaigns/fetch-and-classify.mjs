#!/usr/bin/env node
/**
 * Campaign step 1 — fetch real daily bars for a candidate symbol, classify
 * regimes over non-overlapping 6-week windows (§4.6 thresholds), select the
 * most-typical window for the wanted regime, anonymize it (§4.3), and write a
 * self-contained "cell" file that run-cell.mjs consumes.
 *
 * The cell file is the anti-cheat boundary: it carries a codename, the
 * anonymized (rebased day-0=100, fictional-day-index) series, and the buy-hold
 * stats — never the real symbol, price magnitude, or dates in the part
 * run-cell hands to the agent.
 *
 * Equity / FX / commodity proxies are pulled via yfinance through
 * `uv run --with yfinance` (yfinance is NOT pre-installed); crypto via
 * Binance public klines.
 *
 * Usage:
 *   node tools/campaigns/fetch-and-classify.mjs \
 *     --symbol BTCUSDT --asset crypto --regime bull \
 *     --out tools/campaigns/cells/bull-cx.json [--codename ASSET-A]
 *   node tools/campaigns/fetch-and-classify.mjs \
 *     --symbol NVDA --asset equity --regime bull --out tools/campaigns/cells/bull-nvda.json
 *     --symbol EURUSD=X --asset currency --regime chop --out tools/campaigns/cells/chop-eurusd.json
 *
 * --regime may be bull | bear | chop. --list dumps every classifiable window
 * (no selection) so you can eyeball the history before committing to a cell.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  WINDOW_LEN, WEEKS, BARS_PER_WEEK,
  windowStats, classifyRegime, selectWindow, anonymize, fetchBinanceDaily,
} from './_lib.mjs';

function parseArgs(argv) {
  const out = { asset: 'crypto', regime: 'bull', codename: 'ASSET-A', list: false, limit: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`missing value for ${a}`); return v; };
    if (a === '--symbol') out.symbol = next();
    else if (a === '--asset') out.asset = next();
    else if (a === '--regime') out.regime = next();
    else if (a === '--out') out.out = next();
    else if (a === '--codename') out.codename = next();
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.symbol) throw new Error('--symbol required');
  if (!['crypto', 'equity', 'currency', 'commodity'].includes(out.asset)) throw new Error('--asset must be crypto|equity|currency|commodity');
  if (!['bull', 'bear', 'chop'].includes(out.regime)) throw new Error('--regime must be bull|bear|chop');
  if (!out.list && !out.out) throw new Error('--out required (unless --list)');
  return out;
}

function printHelp() {
  console.log(`fetch-and-classify.mjs — build one anonymized campaign cell

  --symbol S     ticker (equity: NVDA, 0700.HK, 2330.TW), pair (crypto: BTCUSDT),
                 FX proxy (EURUSD=X), or commodity/futures proxy (GC=F, CL=F)
  --asset A      crypto | equity | currency | commodity  (default crypto)
  --regime R     bull | bear | chop         (default bull)
  --out PATH     write the cell JSON here
  --codename C   anonymized asset name      (default ASSET-A)
  --limit N      max daily bars to fetch    (default 1000)
  --list         print every classifiable window instead of writing a cell`);
}

/** Daily bars via yfinance (uv-managed, throwaway env). Newest-last. */
function fetchYfinanceDaily(symbol, limit) {
  const py = `
import json, sys
import math
import yfinance as yf
def finite_or_none(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None
t = yf.Ticker(${JSON.stringify(symbol)})
h = t.history(period="max", interval="1d", auto_adjust=True)
rows = []
for ts, r in h.tail(${Number(limit)}).iterrows():
    o = finite_or_none(r["Open"])
    hi = finite_or_none(r["High"])
    lo = finite_or_none(r["Low"])
    c = finite_or_none(r["Close"])
    if any(x is None for x in [o, hi, lo, c]):
        continue
    volume = finite_or_none(r["Volume"]) or 0.0
    rows.append({
        "date": ts.strftime("%Y-%m-%d"),
        "open": o, "high": hi,
        "low": lo, "close": c,
        "volume": volume,
    })
json.dump(rows, sys.stdout)
`;
  const stdout = execFileSync('uv', ['run', '--quiet', '--with', 'yfinance', 'python3', '-c', py], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000,
  });
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`yfinance returned no bars for ${symbol}`);
  return rows;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  process.stderr.write(`[fetch] ${opts.asset} ${opts.symbol} (limit ${opts.limit})…\n`);
  const bars = opts.asset === 'crypto'
    ? await fetchBinanceDaily(opts.symbol, opts.limit)
    : fetchYfinanceDaily(opts.symbol, opts.limit);
  process.stderr.write(`[fetch] got ${bars.length} daily bars (${bars[0].date} … ${bars[bars.length - 1].date})\n`);

  if (opts.list) {
    for (let i = 0; i + WINDOW_LEN <= bars.length; i += 5) {
      const w = bars.slice(i, i + WINDOW_LEN);
      const s = windowStats(w);
      const r = classifyRegime(s);
      if (r === 'mixed') continue;
      process.stdout.write(
        `${w[0].date}..${w[w.length - 1].date}  ${r.padEnd(4)}  net=${(s.netReturn * 100).toFixed(1)}%  maxDD=${(s.maxDD * 100).toFixed(1)}%\n`,
      );
    }
    return;
  }

  const pick = selectWindow(bars, opts.regime);
  if (!pick) throw new Error(`no ${opts.regime} window found in ${opts.symbol}'s history (${bars.length} bars)`);
  const rawWindow = bars.slice(pick.i, pick.i + WINDOW_LEN);
  const series = anonymize(rawWindow);

  const cell = {
    schema: 'steward-campaign-cell/1',
    createdAt: new Date().toISOString(),
    codename: opts.codename,
    regime: opts.regime,
    assetClassHint: assetClassHint(opts.asset),
    weeks: WEEKS,
    barsPerWeek: BARS_PER_WEEK,
    windowLen: WINDOW_LEN,
    // Buy-hold stats of the anonymized series (identical shape to the raw
    // window — rebasing preserves returns/DD). The baseline H1/H2 compares to.
    buyHold: windowStats(series),
    series,
    // Provenance — for the orchestrator's own audit only; NEVER handed to the
    // agent (run-cell reads only `series` + `codename` into the wake).
    _provenance: {
      symbol: opts.symbol,
      asset: opts.asset,
      firstDate: rawWindow[0].date,
      lastDate: rawWindow[rawWindow.length - 1].date,
      firstClose: Number(rawWindow[0].close),
      lastClose: Number(rawWindow[rawWindow.length - 1].close),
    },
  };

  const outPath = resolve(opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(cell, null, 2)}\n`);
  const bh = cell.buyHold;
  process.stderr.write(
    `[cell] ${opts.regime} ${opts.codename} → ${outPath}\n` +
    `       buy-hold net=${(bh.netReturn * 100).toFixed(1)}%  maxDD=${(bh.maxDD * 100).toFixed(1)}%  ` +
    `(real window ${cell._provenance.firstDate}..${cell._provenance.lastDate}, kept out of agent view)\n`,
  );
}

function assetClassHint(asset) {
  switch (asset) {
    case 'crypto': return 'a single anonymized crypto instrument';
    case 'equity': return 'a single anonymized listed security or fund';
    case 'currency': return 'a single anonymized FX pair';
    case 'commodity': return 'a single anonymized commodity or futures proxy';
    default: return 'a single anonymized instrument';
  }
}

main().catch((err) => { process.stderr.write(`ERROR: ${err.message}\n`); process.exit(1); });
