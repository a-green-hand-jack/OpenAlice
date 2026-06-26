/**
 * Shared bar-source resolution for the snapshot / simulate tools.
 *
 * A pinned barId always wins. For a bare symbol we auto-pick the BEST single
 * source: freshest first (realtime broker > delayed vendor), and within the
 * freshest tier a NON-derivative beats a derivative — so a plain equity/spot
 * ("alpaca|XLE") is preferred over a perp tracking the same ticker
 * ("binance|XLE/USDT:USDT"). Crypto perps stay valid candidates (and a fine
 * backup), they're just not the default pick for a bare ticker.
 */

import type { BarService, BarCapability } from '@/domain/market-data/bars/index'
import { parseBarId } from '@/domain/market-data/bars/index'
import type { AssetClass } from '@/domain/market-data/aggregate-search'

const FRESHNESS_RANK: Record<BarCapability, number> = {
  realtime: 0, iex: 1, subscription: 2, delayed: 3, free: 4,
}

type AssetArg = 'equity' | 'crypto' | 'currency' | 'commodity'
export type ResolvedRef =
  | { barId: string; assetClass?: AssetArg }
  | { symbol: string; assetClass: AssetArg }

export interface ResolveResult {
  ref: ResolvedRef
  /** Human note on what was auto-picked (undefined when a barId was pinned). */
  pickedFrom?: string
}

/** A perp/swap/dated derivative carries a quote-currency or expiry segment in
 *  its native symbol (`XLE/USDT:USDT`, `BTC/USD:USD-310613`). A plain ticker
 *  ("XLE") or spot pair without the `:` does not. */
function isDerivative(barId: string): boolean {
  return (parseBarId(barId)?.nativeSymbol ?? '').includes(':')
}

export async function resolveBarSource(
  barService: BarService,
  input: { query?: string; barId?: string; asset?: AssetArg },
): Promise<ResolveResult | { error: string }> {
  if (input.barId) {
    return { ref: { barId: input.barId, ...(input.asset ? { assetClass: input.asset } : {}) } }
  }
  if (!input.query) return { error: 'Pass either query (a symbol) or barId.' }

  const candidates = await barService.searchBarSources(input.query, { limit: 12 })
  if (candidates.length === 0) {
    return { error: `No bar source found for "${input.query}". Try searchBars to see candidates, or pass a barId.` }
  }
  const best = [...candidates].sort((a, b) => {
    const fa = a.barCapability ? FRESHNESS_RANK[a.barCapability] : 5
    const fb = b.barCapability ? FRESHNESS_RANK[b.barCapability] : 5
    if (fa !== fb) return fa - fb
    return Number(isDerivative(a.barId)) - Number(isDerivative(b.barId))
  })[0]

  const assetClass = best.assetClass !== 'unknown' ? (best.assetClass as AssetClass) : undefined
  return {
    ref: { barId: best.barId, ...(assetClass ? { assetClass: assetClass as AssetArg } : {}) },
    pickedFrom: `${best.barId} (${best.barCapability ?? 'unknown'})`,
  }
}
