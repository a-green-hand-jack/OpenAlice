import { describe, it, expect } from 'vitest'
import { resolveBarSource } from './source-resolve.js'
import type { BarService } from '@/domain/market-data/bars/index'

function svcWith(candidates: Array<{ barId: string; barCapability?: string; assetClass?: string }>): BarService {
  return {
    searchBarSources: async () => candidates,
    getBars: async () => ({ bars: [], meta: {} }),
  } as unknown as BarService
}

describe('resolveBarSource', () => {
  it('a pinned barId wins, no search', async () => {
    const r = await resolveBarSource(svcWith([]), { barId: 'alpaca|XLE' })
    expect(r).toEqual({ ref: { barId: 'alpaca|XLE' } })
  })

  it('auto-pick prefers a non-derivative over a same-freshness perp (perp = backup)', async () => {
    // search returns the crypto perp FIRST (as the live UTA search does), but the
    // equity should still win — a perp tracking a ticker is a backup, not the default.
    const svc = svcWith([
      { barId: 'binance|XLE/USDT:USDT', barCapability: 'realtime', assetClass: 'crypto' },
      { barId: 'okx|XLE/USDT:USDT', barCapability: 'realtime', assetClass: 'crypto' },
      { barId: 'alpaca|XLE', barCapability: 'realtime', assetClass: 'equity' },
    ])
    const r = await resolveBarSource(svc, { query: 'XLE' })
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.ref).toMatchObject({ barId: 'alpaca|XLE', assetClass: 'equity' })
  })

  it('still prefers a fresher source over freshness ties', async () => {
    const svc = svcWith([
      { barId: 'yfinance|AAPL', barCapability: 'delayed', assetClass: 'equity' },
      { barId: 'alpaca|AAPL', barCapability: 'realtime', assetClass: 'equity' },
    ])
    const r = await resolveBarSource(svc, { query: 'AAPL' })
    if ('error' in r) throw new Error(r.error)
    expect(r.ref).toMatchObject({ barId: 'alpaca|AAPL' })
  })

  it('a crypto query still resolves to the crypto source', async () => {
    const svc = svcWith([{ barId: 'binance|BTC/USDT', barCapability: 'realtime', assetClass: 'crypto' }])
    const r = await resolveBarSource(svc, { query: 'BTC' })
    if ('error' in r) throw new Error(r.error)
    expect(r.ref).toMatchObject({ barId: 'binance|BTC/USDT', assetClass: 'crypto' })
  })

  it('errors with neither query nor barId, and on no candidates', async () => {
    expect('error' in (await resolveBarSource(svcWith([]), {}))).toBe(true)
    expect('error' in (await resolveBarSource(svcWith([]), { query: 'NOPE' }))).toBe(true)
  })
})
