import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import { describe, expect, it, vi } from 'vitest'

import { MockBroker, makeContract, makeOpenOrder } from './brokers/mock/index.js'
import { CcxtBroker } from './brokers/ccxt/CcxtBroker.js'
import { IbkrBroker } from './brokers/ibkr/IbkrBroker.js'
import type { IBroker } from './brokers/types.js'
import type { Operation } from './git/types.js'
import { createGuardPipeline, hasLocalNoDispatchProof } from './guards/guard-pipeline.js'
import { resolveGuards } from './guards/registry.js'
import type { GuardContext } from './guards/types.js'
import {
  RiskEnvelopeRuntimeError,
  compileRiskEnvelopeGuards,
  evaluateStewardAdmission,
  resolveProductionRiskEnvelope,
} from './risk-envelope.js'

const ENVELOPE = {
  version: 3,
  maxPositionPctOfEquity: 25,
  maxSingleOrderPctOfEquity: 10,
  maxDailyLossPct: 5,
  maxDrawdownPct: 10,
  scope: { kind: 'whitelist' as const, symbols: ['AAPL'] },
  autonomyCeiling: 'paper' as const,
  revoked: false,
  revokedReason: null,
}

const REQUEST = {
  version: 1 as const,
  workspaceAuthzLevel: 'paper' as const,
  minimumAuthzLevel: 'paper' as const,
}

function compile(input: unknown, broker: IBroker = new MockBroker()) {
  return compileRiskEnvelopeGuards(input, broker)
}

function context(cashQty: string): GuardContext {
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'MKT'
  order.cashQty = new Decimal(cashQty)
  const operation: Operation = {
    action: 'placeOrder',
    contract: makeContract({ symbol: 'AAPL' }),
    order,
  }
  return {
    operation,
    positions: [],
    account: {
      baseCurrency: 'USD',
      netLiquidation: '100000',
      totalCashValue: '100000',
      unrealizedPnL: '0',
      realizedPnL: '0',
    },
  }
}

describe('production Risk Envelope', () => {
  it('compiles every required whitelist field into existing guards', () => {
    expect(compile(ENVELOPE)).toEqual([
      {
        type: 'max-position-size',
        options: { maxPercentOfEquity: 25, maxOrderPercentOfEquity: 10 },
      },
      { type: 'daily-loss', options: { maxDailyLossPct: 5 } },
      { type: 'max-drawdown', options: { maxDrawdownPct: 10 } },
      {
        type: 'symbol-whitelist',
        options: { canonicalInstrumentIds: ['mock-paper|AAPL'], strictEnvelopeScope: true },
      },
    ])
  })

  it('keeps custom and envelope guards as a stricter union', async () => {
    const customStricter = resolveGuards([
      { type: 'max-position-size', options: { maxPercentOfEquity: 5 } },
      ...compile(ENVELOPE),
    ]).filter((guard) => guard.name === 'max-position-size')
    expect(customStricter).toHaveLength(2)
    const customReasons = await Promise.all(customStricter.map((guard) => guard.check(context('6000'))))
    expect(customReasons.some((reason) => reason?.includes('limit: 5%'))).toBe(true)

    const envelopeStricter = resolveGuards([
      { type: 'max-position-size', options: { maxPercentOfEquity: 50, maxOrderPercentOfEquity: 50 } },
      ...compile(ENVELOPE),
    ]).filter((guard) => guard.name === 'max-position-size')
    const envelopeReasons = await Promise.all(envelopeStricter.map((guard) => guard.check(context('30000'))))
    expect(envelopeReasons.some((reason) => reason?.includes('limit: 10%'))).toBe(true)
  })

  it('classifies missing/partial and reserved asset_class scope distinctly', () => {
    for (const input of [undefined, null, { version: 3 }]) {
      expect(resolveProductionRiskEnvelope(input)).toMatchObject({
        ok: false,
        code: 'risk_envelope_missing',
      })
      expect(() => compile(input)).toThrow(RiskEnvelopeRuntimeError)
    }

    const reserved = { ...ENVELOPE, scope: { kind: 'asset_class', assetClasses: ['equity'] } }
    expect(resolveProductionRiskEnvelope(reserved)).toMatchObject({
      ok: false,
      code: 'risk_envelope_scope_unsupported',
      message: expect.stringContaining('configure scope.kind="whitelist"'),
    })
    expect(() => compile(reserved)).toThrow(/asset_class.*unsupported/)
  })

  it.each([
    ['unknown', undefined],
    ['outside scope', 'MSFT'],
  ])('rejects %s modifyOrder identity with local no-dispatch proof', async (_case, symbol) => {
    const broker = new MockBroker()
    if (symbol) {
      const order = makeOpenOrder({ contract: makeContract({ symbol }) })
      order.order.orderId = 42
      broker.setOrders([order])
    }
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const strictWhitelist = resolveGuards([
      compile(ENVELOPE, broker).find((guard) => guard.type === 'symbol-whitelist')!,
    ])
    const pipeline = createGuardPipeline(dispatcher, broker, strictWhitelist)

    const result = await pipeline({ action: 'modifyOrder', orderId: '42', changes: {} })

    expect(dispatcher).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(symbol ? /MSFT.*not in the allowed list/ : /Cannot resolve authoritative open-order contract/),
    })
    expect(hasLocalNoDispatchProof(result)).toBe(true)
  })

  it('keeps unknown and out-of-scope cancelOrder available as a protective operation', async () => {
    const broker = new MockBroker()
    const outside = makeOpenOrder({ contract: makeContract({ symbol: 'MSFT' }) })
    outside.order.orderId = 42
    broker.setOrders([outside])
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const strictWhitelist = resolveGuards([
      compile(ENVELOPE, broker).find((guard) => guard.type === 'symbol-whitelist')!,
    ])
    const pipeline = createGuardPipeline(dispatcher, broker, strictWhitelist)

    await expect(pipeline({ action: 'cancelOrder', orderId: '42' })).resolves.toMatchObject({ success: true })
    expect(dispatcher).toHaveBeenCalledOnce()
    expect(broker.callCount('getOrders')).toBe(0)

    const direct = strictWhitelist[0]!.evaluate!({
      operation: { action: 'cancelOrder', orderId: '42' },
      positions: [],
      account: context('1').account,
      orders: [outside],
    })
    expect(direct).toEqual({ metrics: { symbol: 'unknown', protectiveOperation: true } })
  })

  it('preserves legacy custom whitelist behavior for unknown modifyOrder identity', async () => {
    const broker = new MockBroker()
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const pipeline = createGuardPipeline(
      dispatcher,
      broker,
      resolveGuards([{ type: 'symbol-whitelist', options: { symbols: ['AAPL'] } }]),
    )

    await expect(pipeline({ action: 'modifyOrder', orderId: '42', changes: {} }))
      .resolves.toMatchObject({ success: true })
    expect(dispatcher).toHaveBeenCalledOnce()
    expect(broker.callCount('getOrders')).toBe(0)
  })

  it.each([
    ['aliceId', makeContract({ aliceId: 'mock-paper|MSFT', symbol: 'AAPL' })],
    ['localSymbol', Object.assign(makeContract({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL' }), { localSymbol: 'MSFT' })],
    ['conId', Object.assign(makeContract({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL' }), { conId: 999 })],
  ])('rejects whitelist-in display data with hostile whitelist-out %s before dispatch', async (_field, contract) => {
    const broker = new MockBroker()
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const strictWhitelist = resolveGuards([
      compile(ENVELOPE, broker).find((guard) => guard.type === 'symbol-whitelist')!,
    ])
    const pipeline = createGuardPipeline(dispatcher, broker, strictWhitelist)
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(1)

    const result = await pipeline({ action: 'placeOrder', contract, order })

    expect(dispatcher).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false })
    expect(hasLocalNoDispatchProof(result)).toBe(true)
  })

  it('normalizes a CCXT whitelist through the venue native key and rejects unknown keys before dispatch', async () => {
    const broker = new CcxtBroker({
      id: 'ccxt-paper',
      exchange: 'binance',
      keyless: true,
      sandbox: false,
    })
    const exchange = (broker as unknown as { exchange: { markets: Record<string, unknown> } }).exchange
    exchange.markets = {
      'BTC/USDT:USDT': {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT:USDT',
        base: 'BTC',
        quote: 'USDT',
        settle: 'USDT',
        type: 'swap',
        active: true,
      },
    }

    expect(compile({
      ...ENVELOPE,
      scope: { kind: 'whitelist', symbols: ['ccxt-paper|BTC/USDT:USDT'] },
    }, broker).at(-1)).toEqual({
      type: 'symbol-whitelist',
      options: {
        canonicalInstrumentIds: ['ccxt-paper|BTC/USDT:USDT'],
        strictEnvelopeScope: true,
      },
    })
    const unknownEnvelope = {
      ...ENVELOPE,
      scope: { kind: 'whitelist', symbols: ['DOGE/UNKNOWN'] },
    }
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const strictWhitelist = resolveGuards([
      compile(unknownEnvelope, broker).find((guard) => guard.type === 'symbol-whitelist')!,
    ])
    vi.spyOn(broker, 'getPositions').mockResolvedValue([])
    vi.spyOn(broker, 'getAccount').mockResolvedValue(context('1').account)
    const pipeline = createGuardPipeline(dispatcher, broker, strictWhitelist)
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(1)
    const contract = Object.assign(makeContract({
      aliceId: 'ccxt-paper|DOGE/UNKNOWN',
      symbol: 'DOGE',
      secType: '',
    }), { localSymbol: 'DOGE/UNKNOWN' })

    const result = await pipeline({ action: 'placeOrder', contract, order })

    expect(dispatcher).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('tradeable broker contract'),
    })

    const allowedPipeline = createGuardPipeline(
      dispatcher,
      broker,
      resolveGuards([
        compile({
          ...ENVELOPE,
          scope: { kind: 'whitelist', symbols: ['BTC/USDT:USDT'] },
        }, broker).find((guard) => guard.type === 'symbol-whitelist')!,
      ]),
    )
    const aliasSpoof = Object.assign(makeContract({
      aliceId: 'ccxt-paper|BTC/USDT:USDT',
      symbol: 'BTC',
      secType: 'CRYPTO_PERP',
    }), { localSymbol: 'ETH/USDT:USDT' })
    const spoofed = await allowedPipeline({ action: 'placeOrder', contract: aliasSpoof, order })

    expect(dispatcher).not.toHaveBeenCalled()
    expect(spoofed).toMatchObject({
      success: false,
      error: expect.stringContaining('localSymbol "ETH/USDT:USDT"'),
    })
  })

  it('binds IBKR modifyOrder scope to the broker open-order conId, not its display symbol', async () => {
    const broker = new IbkrBroker({ id: 'ibkr-paper' })
    const outside = makeOpenOrder({
      contract: Object.assign(makeContract({ symbol: 'AAPL', secType: 'STK' }), { conId: 999 }),
    })
    outside.order.orderId = 42
    vi.spyOn(broker, 'getPositions').mockResolvedValue([])
    vi.spyOn(broker, 'getAccount').mockResolvedValue(context('1').account)
    vi.spyOn(broker, 'getOrders').mockResolvedValue([outside])
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const envelope = {
      ...ENVELOPE,
      scope: { kind: 'whitelist' as const, symbols: ['ibkr-paper|265598'] },
    }
    const strictWhitelist = resolveGuards([
      compile(envelope, broker).find((guard) => guard.type === 'symbol-whitelist')!,
    ])
    const pipeline = createGuardPipeline(dispatcher, broker, strictWhitelist)

    const result = await pipeline({ action: 'modifyOrder', orderId: '42', changes: {} })

    expect(dispatcher).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('ibkr-paper|999'),
    })

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(1)
    const hostileContract = Object.assign(makeContract({
      aliceId: 'ibkr-paper|265598',
      symbol: '',
      secType: '',
    }), { conId: 999 })
    const hostilePlace = await pipeline({ action: 'placeOrder', contract: hostileContract, order })

    expect(dispatcher).not.toHaveBeenCalled()
    expect(hostilePlace).toMatchObject({
      success: false,
      error: expect.stringContaining('Caller conId "999"'),
    })
  })
})

describe('versioned Steward admission', () => {
  it('admits only through all three authorization ceilings', () => {
    expect(evaluateStewardAdmission({
      accountId: 'paper-1',
      source: { riskEnvelope: ENVELOPE, accountMaxAuthzLevel: 'limited_autonomy' },
      request: REQUEST,
    })).toEqual({
      version: 1,
      status: 'admitted',
      accountId: 'paper-1',
      envelopeVersion: 3,
      effectiveAuthzLevel: 'paper',
    })
  })

  it('rejects revoke, authorization downgrade, and version drift deterministically', () => {
    expect(evaluateStewardAdmission({
      accountId: 'paper-1',
      source: {
        riskEnvelope: { ...ENVELOPE, version: 4, revoked: true, revokedReason: 'human stop' },
        accountMaxAuthzLevel: 'paper',
      },
      request: REQUEST,
    })).toMatchObject({ status: 'rejected', code: 'risk_envelope_revoked', envelopeVersion: 4 })

    expect(evaluateStewardAdmission({
      accountId: 'paper-1',
      source: { riskEnvelope: ENVELOPE, accountMaxAuthzLevel: 'read_only' },
      request: REQUEST,
    })).toMatchObject({ status: 'rejected', code: 'authz_below_required', effectiveAuthzLevel: 'read_only' })

    expect(evaluateStewardAdmission({
      accountId: 'paper-1',
      source: { riskEnvelope: { ...ENVELOPE, version: 4 }, accountMaxAuthzLevel: 'paper' },
      request: { ...REQUEST, expectedEnvelopeVersion: 3 },
    })).toMatchObject({ status: 'rejected', code: 'envelope_version_changed', envelopeVersion: 4 })
  })
})
