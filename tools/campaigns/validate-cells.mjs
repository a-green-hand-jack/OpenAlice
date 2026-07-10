#!/usr/bin/env node
/**
 * Validate checked-in steward campaign cells.
 *
 * This is intentionally lightweight and dependency-free so we can run it before
 * expensive agent campaigns. It checks that manifest entries point at real
 * cells, every cell has a clean 30-bar anonymized series, and the stored
 * buy-hold stats match the series.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { WINDOW_LEN, windowStats, classifyRegime, maxWeeklyLongReturnUnderExposure } from './_lib.mjs';

const ROOT = resolve('tools/campaigns/cells');
const EPS = 1e-9;

function fail(msg) {
  throw new Error(msg);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function closeEnough(a, b) {
  return Math.abs(Number(a) - Number(b)) <= EPS;
}

function validateCell(file, manifestEntry) {
  const cell = readJson(resolve(ROOT, file));
  if (cell.schema !== 'steward-campaign-cell/1') fail(`${file}: bad schema ${cell.schema}`);
  if (!['bull', 'bear', 'chop'].includes(cell.regime)) fail(`${file}: bad regime ${cell.regime}`);
  if (manifestEntry && manifestEntry.regime !== cell.regime) {
    fail(`${file}: manifest regime ${manifestEntry.regime} != cell regime ${cell.regime}`);
  }
  if (!Array.isArray(cell.series) || cell.series.length !== WINDOW_LEN) {
    fail(`${file}: expected ${WINDOW_LEN} bars, got ${cell.series?.length}`);
  }
  for (const [i, bar] of cell.series.entries()) {
    if (bar.day !== i) fail(`${file}: bar ${i} has day=${bar.day}`);
    for (const k of ['open', 'high', 'low', 'close']) {
      if (!Number.isFinite(Number(bar[k])) || Number(bar[k]) <= 0) fail(`${file}: bar ${i} invalid ${k}`);
    }
    if (!Number.isFinite(Number(bar.volume))) fail(`${file}: bar ${i} invalid volume`);
  }
  const stats = windowStats(cell.series);
  for (const k of ['netReturn', 'maxDD', 'dailyVol']) {
    if (!closeEnough(stats[k], cell.buyHold?.[k])) {
      fail(`${file}: buyHold.${k} drift (${cell.buyHold?.[k]} != ${stats[k]})`);
    }
  }
  const classified = classifyRegime(stats);
  if (classified !== cell.regime) fail(`${file}: stats classify as ${classified}, expected ${cell.regime}`);
  if (typeof cell.assetClassHint !== 'string' || cell.assetClassHint.trim() === '') {
    fail(`${file}: missing assetClassHint`);
  }
  if (!cell._provenance?.symbol || !cell._provenance?.asset) fail(`${file}: missing _provenance symbol/asset`);
  const maxGuardedLong = maxWeeklyLongReturnUnderExposure(cell.series, 60);
  if (cell.regime === 'bull' && (maxGuardedLong.return ?? Number.NEGATIVE_INFINITY) < 0.25) {
    console.warn(`${file}: WARN bull +25% target is infeasible under 60% max-position guard; max guarded weekly long is ${(maxGuardedLong.return * 100).toFixed(1)}% from wk${maxGuardedLong.week}`);
  }
  return { file, regime: cell.regime, symbol: cell._provenance.symbol };
}

function main() {
  const manifest = readJson(resolve(ROOT, 'manifest.json'));
  if (manifest.schema !== 'steward-campaign-cell-manifest/1') fail(`manifest: bad schema ${manifest.schema}`);
  const entries = manifest.cells ?? [];
  const byFile = new Map(entries.map((e) => [e.file, e]));
  if (byFile.size !== entries.length) fail('manifest: duplicate file entries');

  const files = readdirSync(ROOT).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();
  const missingFromManifest = files.filter((f) => !byFile.has(f));
  if (missingFromManifest.length) fail(`manifest missing files: ${missingFromManifest.join(', ')}`);
  const missingOnDisk = entries.map((e) => e.file).filter((f) => !files.includes(f));
  if (missingOnDisk.length) fail(`manifest points at missing files: ${missingOnDisk.join(', ')}`);

  const ok = files.map((f) => validateCell(f, byFile.get(f)));
  console.log(`validated ${ok.length} steward campaign cells`);
}

main();
