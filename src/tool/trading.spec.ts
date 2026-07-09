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

type AccOpts = {
  account?: Record<string, unknown>
  positions?: unknown[]
  orders?: unknown[]
  fail?: boolean
  connecting?: boolean
  asVendor?: boolean
  contracts?: unknown[]
}

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
  // `fail` → a real transient outage (NETWORK) → degraded bucket.
  // `connecting` → the broker connect is still in flight (CONNECTING, what
  // _callBroker throws during the initial-connect window) → connecting bucket,
  // NOT degraded.
  const guard = () => {
    if (o.connecting) throw new BrokerError('CONNECTING', `${id} is still connecting to the broker`)
    if (o.fail) throw new BrokerError('NETWORK', `${id} is offline and reconnecting`)
  }
  return {
    id, label: id,
    getAccount: async () => { guard(); return o.account ?? DEFAULT_ACCOUNT },
    getPositions: async () => { guard(); return o.positions ?? [] },
    getOrders: async () => { guard(); return o.orders ?? [] },
    searchContracts: async () => { guard(); return o.contracts ?? [] },
    getPendingOrderIds: () => [],
    asVendor: o.asVendor ?? true,
  }
}

function fakeManager(accounts: ReturnType<typeof fakeAccount>[]) {
  return {
    resolve: async (source?: string, _opts?: { tradingOnly?: boolean }) => source ? accounts.filter((a) => a.id === source) : accounts,
    listUTAs: async () => accounts.map((a) => ({ id: a.id, label: a.label, asVendor: a.asVendor })),
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

describe('searchContracts — data-source participation', () => {
  it('defaults to accounts with UTA data-source participation enabled', async () => {
    const tools = createTradingTools(fakeManager([
      fakeAccount('alpaca-paper', {
        contracts: [{ contract: { aliceId: 'alpaca-paper|AAPL', symbol: 'AAPL' }, derivativeSecTypes: [] }],
      }),
      fakeAccount('bybit-paper', {
        asVendor: false,
        contracts: [{ contract: { aliceId: 'bybit-paper|BTC/USDT', symbol: 'BTC' }, derivativeSecTypes: [] }],
      }),
    ]))

    const res = await run(tools.searchContracts, { pattern: 'AAPL' }) as Array<Record<string, unknown>>
    expect(res.map((r) => r.source)).toEqual(['alpaca-paper'])
  })

  it('allows an explicit source even when data-source participation is disabled', async () => {
    const tools = createTradingTools(fakeManager([
      fakeAccount('bybit-paper', {
        asVendor: false,
        contracts: [{ contract: { aliceId: 'bybit-paper|BTC/USDT', symbol: 'BTC' }, derivativeSecTypes: [] }],
      }),
    ]))

    const res = await run(tools.searchContracts, { pattern: 'BTC', source: 'bybit-paper' }) as Array<Record<string, unknown>>
    expect(res.map((r) => r.source)).toEqual(['bybit-paper'])
  })
})

/**
 * Cold-start non-blocking — an account still establishing its broker connection
 * surfaces as `connecting` (pending), NOT `degraded` (broken). This is what
 * stops the UI/agent from reporting a cold-starting account as a failure, and
 * is the aggregation half of the fix that made reads return fast instead of
 * blocking ~30s on CCXT loadMarkets.
 */
describe('trading tools — connecting state (cold-start)', () => {
  it('getPortfolio routes a still-connecting account to `connecting`, not `degraded`', async () => {
    const tools = createTradingTools(fakeManager([
      fakeAccount('binance-x', { positions: [pos('BTC')] }),
      fakeAccount('okx-readonly', { connecting: true }),
    ]))
    const res = await run(tools.getPortfolio, {}) as {
      positions: unknown[]; degraded?: unknown[]; connecting: Array<{ source: string; code: string; transient: boolean }>
    }
    expect(res.positions).toHaveLength(1)
    expect(res.degraded).toBeUndefined()
    expect(res.connecting).toHaveLength(1)
    expect(res.connecting[0].source).toBe('okx-readonly')
    expect(res.connecting[0].code).toBe('CONNECTING')
    expect(res.connecting[0].transient).toBe(true)
  })

  it('getPortfolio splits a real failure (degraded) from a pending connect (connecting) in one response', async () => {
    const tools = createTradingTools(fakeManager([
      fakeAccount('binance-x', { positions: [pos('BTC')] }),
      fakeAccount('bybit-readonly', { fail: true }),
      fakeAccount('okx-readonly', { connecting: true }),
    ]))
    const res = await run(tools.getPortfolio, {}) as {
      positions: unknown[]; degraded: Array<{ source: string }>; connecting: Array<{ source: string }>
    }
    expect(res.positions).toHaveLength(1)
    expect(res.degraded).toHaveLength(1)
    expect(res.degraded[0].source).toBe('bybit-readonly')
    expect(res.connecting).toHaveLength(1)
    expect(res.connecting[0].source).toBe('okx-readonly')
  })

  it('getOrders routes a connecting account to `connecting`, leaving `degraded` unset', async () => {
    const tools = createTradingTools(fakeManager([
      fakeAccount('binance-x', { orders: [] }),
      fakeAccount('okx-readonly', { connecting: true }),
    ]))
    const res = await run(tools.getOrders, {}) as { orders: unknown[]; degraded?: unknown[]; connecting: Array<{ source: string }> }
    expect(res.degraded).toBeUndefined()
    expect(res.connecting).toHaveLength(1)
    expect(res.connecting[0].source).toBe('okx-readonly')
  })

  it('getAccount surfaces a connecting account inline with code CONNECTING', async () => {
    const tools = createTradingTools(fakeManager([
      fakeAccount('binance-x', {}),
      fakeAccount('okx-readonly', { connecting: true }),
    ]))
    const res = await run(tools.getAccount, {}) as Array<Record<string, unknown>>
    expect(res).toHaveLength(2)
    expect(res.find((r) => r.source === 'okx-readonly')?.code).toBe('CONNECTING')
  })
})

/**
 * stageAndMaybeCommit — autoPush response surfacing (issue #111).
 *
 * `uta.commit()`'s HTTP response genuinely carries a `PaperAutoPushResult`
 * under `autoPush` (UTA's POST /wallet/commit route computes it and splices
 * it onto the JSON body). Before this fix, `stageAndMaybeCommit` discarded
 * everything except `hash`/`message` and always returned the same
 * hardcoded "Awaiting user approval…" string — so an agent whose order was
 * actually rejected by the paper-policy risk guard (e.g. missing stop-loss)
 * read the identical response as an agent whose order genuinely executed.
 * These tests drive `placeOrder` (one of the four `stageAndMaybeCommit`
 * call sites) with a fake commit() returning each `autoPush` shape and
 * assert the response differs meaningfully per case.
 */
describe('placeOrder + commitMessage — autoPush response surfacing (#111)', () => {
  function fakeCommitAccount(id: string, commit: () => unknown) {
    return {
      id,
      stagePlaceOrder: async () => ({ staged: true, index: 0, operation: { action: 'placeOrder', contract: {}, order: {} } }),
      commit: async () => commit(),
    }
  }

  function fakeManagerFor(account: ReturnType<typeof fakeCommitAccount>) {
    return { resolveOne: async () => account } as never
  }

  const placeArgs = (aliceId: string) => ({
    aliceId, action: 'BUY' as const, orderType: 'MKT' as const, totalQuantity: '1', commitMessage: 'Entry: momentum breakout',
  })

  it('reports EXECUTED distinctly when autoPush actually pushed the commit', async () => {
    const account = fakeCommitAccount('alpaca-paper', () => ({
      prepared: true, hash: 'aaaa1111', message: 'Entry: momentum breakout', operationCount: 1,
      autoPush: {
        status: 'pushed',
        hash: 'bbbb2222',
        push: {
          hash: 'bbbb2222', message: 'Entry: momentum breakout', operationCount: 1,
          submitted: [{ action: 'placeOrder', success: true, status: 'filled', filledQty: '1', filledPrice: '150' }],
          rejected: [],
        },
        approver: { via: 'auto-push-paper', at: '2026-01-01T00:00:00.000Z' },
        effectiveAuthzLevel: 'paper',
      },
    }))
    const tools = createTradingTools(fakeManagerFor(account))
    const res = await run(tools.placeOrder, placeArgs('alpaca-paper|AAPL')) as {
      committed: { hash: string }
      nextStep: string
      autoPush: { status: string; hash: string; push: { submitted: unknown[] } }
    }
    expect(res.committed.hash).toBe('aaaa1111')
    expect(res.nextStep).toMatch(/EXECUTED/)
    expect(res.autoPush.status).toBe('pushed')
    expect(res.autoPush.hash).toBe('bbbb2222')
    expect(res.autoPush.push.submitted).toHaveLength(1)
  })

  it('reports a policy REJECTION distinctly (missing_stop_loss) so the agent can correct + retry', async () => {
    const account = fakeCommitAccount('alpaca-paper', () => ({
      prepared: true, hash: 'cccc3333', message: 'Entry: momentum breakout', operationCount: 1,
      autoPush: {
        status: 'skipped',
        reason: 'paper_policy_denied',
        pendingHash: 'cccc3333',
        accountType: 'paper',
        effectiveAuthzLevel: 'paper',
        policyViolations: [{
          code: 'missing_stop_loss',
          symbol: 'BTC',
          reason: 'Paper auto-push requires an attached stopLoss for risk-increasing BTC orders',
        }],
      },
    }))
    const tools = createTradingTools(fakeManagerFor(account))
    const res = await run(tools.placeOrder, placeArgs('alpaca-paper|BTC')) as {
      nextStep: string
      autoPush: { status: string; reason: string; policyViolations: Array<{ code: string }> }
    }
    expect(res.nextStep).toMatch(/REJECTED/)
    expect(res.nextStep).toMatch(/stopLoss/)
    expect(res.autoPush.status).toBe('skipped')
    expect(res.autoPush.reason).toBe('paper_policy_denied')
    expect(res.autoPush.policyViolations).toHaveLength(1)
    expect(res.autoPush.policyViolations[0].code).toBe('missing_stop_loss')
  })

  it('reports a real FAILURE distinctly when autoPush status is failed', async () => {
    const account = fakeCommitAccount('alpaca-paper', () => ({
      prepared: true, hash: 'ffff6666', message: 'Entry: momentum breakout', operationCount: 1,
      autoPush: {
        status: 'failed', reason: 'broker rejected: insufficient buying power',
        pendingHash: 'ffff6666', effectiveAuthzLevel: 'paper',
      },
    }))
    const tools = createTradingTools(fakeManagerFor(account))
    const res = await run(tools.placeOrder, placeArgs('alpaca-paper|AAPL')) as {
      nextStep: string
      autoPush: { status: string; reason: string }
    }
    expect(res.nextStep).toMatch(/FAILED/)
    expect(res.nextStep).toMatch(/insufficient buying power/)
    expect(res.autoPush.status).toBe('failed')
  })

  it('keeps the benign "awaiting approval" framing for a structural (non-policy) skip', async () => {
    const account = fakeCommitAccount('ibkr-live', () => ({
      prepared: true, hash: 'dddd4444', message: 'Entry: momentum breakout', operationCount: 1,
      autoPush: { status: 'skipped', reason: 'account_type_not_paper', pendingHash: 'dddd4444', accountType: 'live' },
    }))
    const tools = createTradingTools(fakeManagerFor(account))
    const res = await run(tools.placeOrder, placeArgs('ibkr-live|AAPL')) as {
      nextStep: string
      autoPush: { status: string; reason: string }
    }
    expect(res.nextStep).toBe('Awaiting user approval or deterministic auto-push outside the agent tool surface.')
    expect(res.nextStep).not.toMatch(/REJECTED|FAILED|EXECUTED/)
    expect(res.autoPush.reason).toBe('account_type_not_paper')
  })

  it('falls back to the original generic message when autoPush is entirely absent (non-regression)', async () => {
    const account = fakeCommitAccount('ibkr-live', () => ({
      prepared: true, hash: 'eeee5555', message: 'Entry: momentum breakout', operationCount: 1,
    }))
    const tools = createTradingTools(fakeManagerFor(account))
    const res = await run(tools.placeOrder, placeArgs('ibkr-live|AAPL')) as { nextStep: string; autoPush?: unknown }
    expect(res.nextStep).toBe('Awaiting user approval or deterministic auto-push outside the agent tool surface.')
    expect(res.autoPush).toBeUndefined()
  })
})

describe('tradingPush — gated agent execution', () => {
  it('registers a push tool but defaults to manual approval', async () => {
    const account = {
      id: 'alpaca-paper',
      status: async () => ({
        staged: [{ action: 'cancelOrder', orderId: 'ord-1' }],
        pendingMessage: 'cancel stale order',
        pendingHash: 'abc12345',
      }),
      push: async () => {
        throw new Error('push should not run while AI trading is disabled')
      },
    }
    const manager = { resolve: async () => [account] } as never
    const tools = createTradingTools(manager)

    expect(Object.keys(tools)).toContain('tradingPush')
    const res = await run(tools.tradingPush, {}) as { message: string; pending: Array<{ source: string }> }
    expect(res.message).toMatch(/manual approval/)
    expect(res.pending[0].source).toBe('alpaca-paper')
  })
})
