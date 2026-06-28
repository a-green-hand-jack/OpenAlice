/**
 * Aggregate Symbol Search
 *
 * Cross-asset-class heuristic search that respects Alice's per-asset-class
 * provider config. Used both by the AI tool (marketSearchForResearch) and the
 * HTTP route (/api/market/search) — both surfaces must return the same thing.
 *
 * equity    — SymbolIndex (SEC/TMX local cache, regex, zero-latency)
 * commodity — CommodityCatalog (canonical catalog, ~25 items)
 * crypto    — cryptoClient.search on yfinance (online fuzzy)
 * currency  — currencyClient.search on yfinance (online fuzzy, XXXUSD filter)
 */
import type { SymbolIndex } from './equity/symbol-index.js'
import type { CommodityCatalog } from './commodity/commodity-catalog.js'
import type { CryptoClientLike, CurrencyClientLike, EquityClientLike } from './client/types.js'

export type AssetClass = 'equity' | 'crypto' | 'currency' | 'commodity'

export interface MarketSearchDeps {
  symbolIndex: SymbolIndex
  equityClient: EquityClientLike
  cryptoClient: CryptoClientLike
  currencyClient: CurrencyClientLike
  commodityCatalog: CommodityCatalog
}

export interface MarketSearchResult {
  /** Equity / crypto / currency have a symbol; commodity uses `id` instead (canonical). */
  symbol?: string
  id?: string
  name?: string | null
  assetClass: AssetClass
  [key: string]: unknown
}

/**
 * Score a result against the query. Higher is better.
 * Tiers:
 *   100  exact match on symbol, id, or name (case-insensitive)
 *    90  exact match on a commodity alias (e.g. "xau" → gold)
 *    80  symbol/id starts with the query
 *    70  name starts with the query (at a word boundary)
 *    50  name contains the query as a whole word
 *    30  name contains the query as a substring
 *    10  fallback — matched upstream but nothing we can explain
 */
function matchScore(query: string, r: MarketSearchResult): number {
  const q = query.toLowerCase()
  const sym = String(r.symbol ?? r.id ?? '').toLowerCase()
  const name = String(r.name ?? '').toLowerCase()
  const aliases = Array.isArray(r.aliases) ? (r.aliases as string[]).map((a) => a.toLowerCase()) : []

  if (sym === q || name === q) return 100
  if (aliases.includes(q)) return 90
  if (sym && sym.startsWith(q)) return 80
  // Name starts with query only counts as a strong match when the match
  // ends at a word boundary — otherwise "gold" would rank "goldman" above
  // "SPDR gold trust".
  if (name.startsWith(q) && (name.length === q.length || !/[a-z0-9]/i.test(name[q.length]))) return 70
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(name)) return 50
  if (name.includes(q)) return 30
  return 10
}

export async function aggregateSymbolSearch(
  deps: MarketSearchDeps,
  query: string,
  limit = 20,
): Promise<MarketSearchResult[]> {
  const q = query.trim()
  if (!q) return []

  // Local SEC index — US-only, zero-latency, authoritative for US tickers.
  const equityResults = deps.symbolIndex
    .search(q, limit)
    .map((r) => ({ ...r, assetClass: 'equity' as const }))

  const commodityResults = deps.commodityCatalog
    .search(q, limit)
    .map((r) => ({ ...r, assetClass: 'commodity' as const }))

  const [cryptoSettled, currencySettled, equityOnlineSettled] = await Promise.allSettled([
    deps.cryptoClient.search({ query: q, provider: 'yfinance' }),
    deps.currencyClient.search({ query: q, provider: 'yfinance' }),
    // Yahoo online search — reaches global exchanges (CN A-share .SS/.SZ, TW .TW,
    // VN .VN, HK, …) the SEC index can't. Returned tickers are Yahoo-native, so
    // they feed straight into getHistorical. Force yfinance regardless of the
    // configured equity provider, same as crypto/currency above.
    deps.equityClient.search({ query: q, provider: 'yfinance', is_symbol: false }),
  ])

  const cryptoResults = (cryptoSettled.status === 'fulfilled' ? cryptoSettled.value : []).map(
    (r) => ({ ...r, assetClass: 'crypto' as const }),
  )

  const currencyResults = (currencySettled.status === 'fulfilled' ? currencySettled.value : [])
    .filter((r) => {
      const sym = (r as Record<string, unknown>).symbol as string | undefined
      return sym?.endsWith('USD')
    })
    .map((r) => ({ ...r, assetClass: 'currency' as const }))

  // Merge online equity hits, de-duped against the local SEC index by symbol —
  // US names overlap both sources; keep the local entry (richer, authoritative).
  const seenEquity = new Set(
    equityResults.map((r) => String((r as Record<string, unknown>).symbol ?? '').toUpperCase()),
  )
  const equityOnlineResults = (equityOnlineSettled.status === 'fulfilled' ? equityOnlineSettled.value : [])
    .filter((r) => {
      const sym = String((r as Record<string, unknown>).symbol ?? '').toUpperCase()
      if (!sym || seenEquity.has(sym)) return false
      seenEquity.add(sym)
      return true
    })
    .map((r) => {
      const o = r as Record<string, unknown>
      return { ...o, symbol: String(o.symbol), assetClass: 'equity' as const }
    })

  const all: MarketSearchResult[] = [
    ...equityResults,
    ...equityOnlineResults,
    ...cryptoResults,
    ...currencyResults,
    ...commodityResults,
  ]

  // Stable sort by match quality descending; ties keep upstream order.
  return all
    .map((r, i) => ({ r, i, s: matchScore(q, r) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r)
}
