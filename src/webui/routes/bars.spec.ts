import { describe, it, expect } from 'vitest'
import { createBarsRoutes } from './bars.js'
import type { EngineContext } from '../../core/types.js'

function mkCtx(overrides?: Partial<EngineContext['barService']>): EngineContext {
  return {
    barService: {
      searchBarSources: async (q: string) => [
        { barId: `yfinance|${q}`, source: 'vendor', sourceId: 'yfinance', symbol: q, assetClass: 'equity', label: q, barCapability: 'delayed' },
      ],
      getBars: async (ref: { barId?: string }) => ({
        bars: [{ date: '2024-01-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
        meta: { symbol: 'AAPL', from: '2024-01-01', to: '2024-01-01', bars: 1, source: 'vendor', sourceId: 'yfinance', barId: ref.barId ?? 'yfinance|AAPL', provider: 'yfinance', barCapability: 'delayed' },
      }),
      ...overrides,
    },
  } as unknown as EngineContext
}

describe('bars routes', () => {
  it('GET /search returns federated candidates', async () => {
    const res = await createBarsRoutes(mkCtx()).request('/search?query=AAPL')
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.candidates[0].barId).toBe('yfinance|AAPL')
  })

  it('GET /search with empty query → no candidates (no fetch)', async () => {
    const res = await createBarsRoutes(mkCtx()).request('/search?query=')
    expect((await res.json()).candidates).toEqual([])
  })

  it('GET / by barId returns bars + meta (explicit provider)', async () => {
    const res = await createBarsRoutes(mkCtx()).request('/?barId=yfinance|AAPL&interval=1d')
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.meta.sourceId).toBe('yfinance')
    expect(body.meta.barId).toBe('yfinance|AAPL')
  })

  it('GET / without barId or symbol → 400', async () => {
    const res = await createBarsRoutes(mkCtx()).request('/?interval=1d')
    expect(res.status).toBe(400)
  })

  it('GET / surfaces a getBars failure as { error }, not a crash', async () => {
    const ctx = mkCtx({ getBars: async () => { throw new Error('Vendor barId needs an assetClass') } })
    const res = await createBarsRoutes(ctx).request('/?barId=yfinance|AAPL&interval=1d')
    const body = await res.json()
    expect(body.results).toBeNull()
    expect(body.error).toMatch(/assetClass/)
  })
})
