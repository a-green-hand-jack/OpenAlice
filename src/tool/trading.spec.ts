/**
 * Trading tool aggregation — partial-tolerance (issue #390).
 *
 * One offline / region-blocked account must NOT blank every healthy account's
 * data. These tests drive a fake manager whose accounts selectively reject,
 * and assert the aggregating tools (getAccount / getPortfolio / getOrders)
 * degrade per-account instead of throwing the whole result away.
 */
import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { BrokerError } from '@traderalice/uta-protocol'
import { createTradingTools } from './trading.js'

type AccOpts = { account?: Record<string, unknown>; positions?: unknown[]; orders?: unknown[]; fail?: boolean }

const DEFAULT_ACCOUNT = { netLiquidation: '10000', baseCurrency: 'USD', totalCashValue: '10000', unrealizedPnL: '0', realizedPnL: '0' }

function pos(symbol: string) {
  return {
    contract: { symbol, secType: 'CRYPTO', aliceId: `acc|${symbol}` },
    currency: 'USD', side: 'long',
    quantity: new Decimal(1), avgCost: '100', marketPrice: '110',
    marketValue: '110', unrealizedPnL: '10', realizedPnL: '0',
  }
}

function fakeAccount(id: string, o: AccOpts) {
  const boom = () => { throw new BrokerError('NETWORK', `${id} is offline and reconnecting`) }
  return {
    id, label: id,
    getAccount: async () => { if (o.fail) boom(); return o.account ?? DEFAULT_ACCOUNT },
    getPositions: async () => { if (o.fail) boom(); return o.positions ?? [] },
    getOrders: async () => { if (o.fail) boom(); return o.orders ?? [] },
    getPendingOrderIds: () => [],
  }
}

function fakeManager(accounts: ReturnType<typeof fakeAccount>[]) {
  return {
    resolve: async (_source?: string, _opts?: { tradingOnly?: boolean }) => accounts,
    listUTAs: async () => accounts.map((a) => ({ id: a.id, label: a.label })),
    getFxRates: async () => [],
  } as never
}

// The AI-SDK tool wrapper exposes `.execute(args, options)`; our impls ignore
// the second arg. Typed loosely to dodge the Tool's strict ToolExecuteFunction
// param variance.
function run(tool: { execute?: unknown }, args: unknown): Promise<unknown> {
  return (tool.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, {})
}

describe('trading tools — partial tolerance (#390)', () => {
  it('getPortfolio returns healthy holdings + a degraded marker when one account is offline', async () => {
    const tools = createTradingTools(fakeManager([
      fakeAccount('binance-x', { positions: [pos('BTC')] }),
      fakeAccount('bybit-readonly', { fail: true }),
    ]))
    const res = await run(tools.getPortfolio, {}) as { positions: unknown[]; degraded: Array<{ source: string; transient: boolean }> }
    expect(res.positions).toHaveLength(1)
    expect(res.degraded).toHaveLength(1)
    expect(res.degraded[0].source).toBe('bybit-readonly')
    expect(res.degraded[0].transient).toBe(true)
  })

  it('getPortfolio returns a bare positions array (no degraded key) when all healthy', async () => {
    const tools = createTradingTools(fakeManager([
      fakeAccount('binance-x', { positions: [pos('BTC')] }),
      fakeAccount('alpaca', { positions: [pos('AAPL')] }),
    ]))
    const res = await run(tools.getPortfolio, {}) as unknown[]
    expect(Array.isArray(res)).toBe(true)
    expect(res).toHaveLength(2)
  })

  it('getAccount yields healthy account + error marker for the offline one', async () => {
    const tools = createTradingTools(fakeManager([
      fakeAccount('binance-x', {}),
      fakeAccount('bybit-readonly', { fail: true }),
    ]))
    const res = await run(tools.getAccount, {}) as Array<Record<string, unknown>>
    expect(res).toHaveLength(2)
    const healthy = res.find((r) => r.source === 'binance-x')!
    const broken = res.find((r) => r.source === 'bybit-readonly')!
    expect(healthy.netLiquidation).toBeDefined()
    expect(broken.error).toBeDefined()
    expect(broken.transient).toBe(true)
  })

  it('getAccount with a single offline account returns the error object directly', async () => {
    const tools = createTradingTools(fakeManager([fakeAccount('bybit-readonly', { fail: true })]))
    const res = await run(tools.getAccount, {}) as Record<string, unknown>
    expect(Array.isArray(res)).toBe(false)
    expect(res.error).toBeDefined()
    expect(res.source).toBe('bybit-readonly')
  })

  it('getAccount with a single healthy account returns the account object directly', async () => {
    const tools = createTradingTools(fakeManager([fakeAccount('binance-x', {})]))
    const res = await run(tools.getAccount, {}) as Record<string, unknown>
    expect(Array.isArray(res)).toBe(false)
    expect(res.source).toBe('binance-x')
    expect(res.netLiquidation).toBeDefined()
    expect(res.error).toBeUndefined()
  })

  it('getOrders returns healthy orders + degraded marker when one account is offline', async () => {
    const order = {
      orderId: 'o1', contract: { symbol: 'BTC', aliceId: 'acc|BTC' },
      orderState: { status: 'Submitted' }, order: { orderId: 1 },
    }
    const tools = createTradingTools(fakeManager([
      fakeAccount('binance-x', { orders: [order] }),
      fakeAccount('bybit-readonly', { fail: true }),
    ]))
    const res = await run(tools.getOrders, {}) as { orders: unknown[]; degraded: Array<{ source: string }> }
    expect(res.orders).toHaveLength(1)
    expect(res.degraded).toHaveLength(1)
    expect(res.degraded[0].source).toBe('bybit-readonly')
  })

  it('getOrders groupBy:contract degrades into { grouped, degraded } when an account fails', async () => {
    const order = {
      orderId: 'o1', contract: { symbol: 'BTC', aliceId: 'acc|BTC' },
      orderState: { status: 'Submitted' }, order: { orderId: 1 },
    }
    const tools = createTradingTools(fakeManager([
      fakeAccount('binance-x', { orders: [order] }),
      fakeAccount('bybit-readonly', { fail: true }),
    ]))
    const res = await run(tools.getOrders, { groupBy: 'contract' }) as { grouped: Record<string, unknown>; degraded: Array<{ source: string }> }
    expect(res.grouped['acc|BTC']).toBeDefined()
    expect(res.degraded).toHaveLength(1)
    expect(res.degraded[0].source).toBe('bybit-readonly')
  })

  it('getOrders groupBy:contract returns the bare grouped map when all healthy', async () => {
    const order = {
      orderId: 'o1', contract: { symbol: 'BTC', aliceId: 'acc|BTC' },
      orderState: { status: 'Submitted' }, order: { orderId: 1 },
    }
    const tools = createTradingTools(fakeManager([fakeAccount('binance-x', { orders: [order] })]))
    const res = await run(tools.getOrders, { groupBy: 'contract' }) as Record<string, unknown>
    expect(res['acc|BTC']).toBeDefined()
    expect(res.degraded).toBeUndefined()
  })
})
