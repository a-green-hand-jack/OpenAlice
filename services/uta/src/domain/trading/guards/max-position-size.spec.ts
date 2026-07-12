import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import { describe, expect, it, vi } from 'vitest'

import { MockBroker, makeContract, makePosition } from '../brokers/mock/index.js'
import type { AccountInfo } from '../brokers/types.js'
import type { Operation } from '../git/types.js'
import { createGuardPipeline, hasLocalNoDispatchProof } from './guard-pipeline.js'
import { MaxPositionSizeGuard } from './max-position-size.js'
import type { GuardContext } from './types.js'

const ACCOUNT: AccountInfo = {
  baseCurrency: 'USD',
  netLiquidation: '100000',
  totalCashValue: '100000',
  unrealizedPnL: '0',
  realizedPnL: '0',
}

function placeOrder(overrides: {
  symbol?: string
  action?: string
  orderType?: string
  totalQuantity?: string
  cashQty?: string
  lmtPrice?: string
  auxPrice?: string
} = {}): Operation {
  const order = new Order()
  order.action = overrides.action ?? 'BUY'
  order.orderType = overrides.orderType ?? 'MKT'
  if (overrides.totalQuantity != null) order.totalQuantity = new Decimal(overrides.totalQuantity)
  if (overrides.cashQty != null) order.cashQty = new Decimal(overrides.cashQty)
  if (overrides.lmtPrice != null) order.lmtPrice = new Decimal(overrides.lmtPrice)
  if (overrides.auxPrice != null) order.auxPrice = new Decimal(overrides.auxPrice)
  return {
    action: 'placeOrder',
    contract: makeContract({ symbol: overrides.symbol ?? 'NEW_STOCK' }),
    order,
  }
}

function withRawOrderField(
  operation: Operation,
  field: 'cashQty' | 'totalQuantity' | 'lmtPrice' | 'auxPrice',
  value: unknown,
): Operation {
  if (operation.action !== 'placeOrder') throw new Error('expected placeOrder operation')
  ;(operation.order as unknown as Record<string, unknown>)[field] = value
  return operation
}

function context(
  operation: Operation,
  overrides: Partial<Pick<GuardContext, 'positions' | 'account'>> = {},
): GuardContext {
  return {
    operation,
    positions: overrides.positions ?? [],
    account: overrides.account ?? ACCOUNT,
  }
}

async function expectNoDispatch(
  operation: Operation,
  overrides: Partial<Pick<GuardContext, 'positions' | 'account'>> = {},
): Promise<unknown> {
  const dispatcher = vi.fn().mockResolvedValue({ success: true })
  const broker = new MockBroker({ accountInfo: overrides.account ?? ACCOUNT })
  vi.spyOn(broker, 'getPositions').mockResolvedValue([...(overrides.positions ?? [])])
  const pipeline = createGuardPipeline(
    dispatcher,
    broker,
    [new MaxPositionSizeGuard({ maxPercentOfEquity: 25, maxOrderPercentOfEquity: 10 })],
  )

  const result = await pipeline(operation)
  expect(dispatcher).not.toHaveBeenCalled()
  expect(result).toMatchObject({ success: false })
  expect(hasLocalNoDispatchProof(result)).toBe(true)
  return result
}

describe('MaxPositionSizeGuard first-entry and equity fail-closed regressions', () => {
  it('enforces both aggregate and single-order caps on a priceable first quantity entry', () => {
    const operation = placeOrder({ orderType: 'LMT', totalQuantity: '300', lmtPrice: '100' })

    const aggregate = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
      .evaluate(context(operation))
    expect(aggregate.reason).toBe('Position for NEW_STOCK would be 30.0% of equity (limit: 25%)')
    expect(aggregate.metrics).toMatchObject({ positionValuePct: 30, threshold: 25 })

    const singleOrder = new MaxPositionSizeGuard({
      maxPercentOfEquity: 50,
      maxOrderPercentOfEquity: 10,
    }).evaluate(context(operation))
    expect(singleOrder.reason).toBe(
      'Order for NEW_STOCK would add 30.0% of equity in a single order (limit: 10%)',
    )
    expect(singleOrder.metrics).toMatchObject({ orderValuePct: 30, orderThreshold: 10 })
  })

  it('fails closed with an actionable reason when a first quantity entry is unpriceable', () => {
    for (const operation of [
      placeOrder({ orderType: 'MKT', totalQuantity: '10' }),
      // lmtPrice remains the Order class's UNSET_DECIMAL sentinel.
      placeOrder({ orderType: 'LMT', totalQuantity: '10' }),
    ]) {
      const result = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
        .evaluate(context(operation))

      expect(result.reason).toMatch(/first entry NEW_STOCK/)
      expect(result.reason).toMatch(/no deterministic notional price/)
      expect(result.reason).toMatch(/Use cashQty.*LMT\/STP/)
      expect(result.metrics).toEqual({ positionValuePct: null, threshold: 25 })
    }
  })

  it.each([
    { netLiquidation: '0', operation: placeOrder({ cashQty: '1000' }) },
    { netLiquidation: '-1', operation: placeOrder({ cashQty: '1000' }) },
    { netLiquidation: 'NaN', operation: placeOrder({ cashQty: '1000' }) },
    { netLiquidation: '0', operation: placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }) },
    { netLiquidation: '-1', operation: placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }) },
  ])(
    'fails closed for positive notional when netLiquidation is $netLiquidation',
    ({ netLiquidation, operation }) => {
      const result = new MaxPositionSizeGuard({
        maxPercentOfEquity: 25,
        maxOrderPercentOfEquity: 10,
      }).evaluate(context(operation, {
        account: { ...ACCOUNT, netLiquidation },
      }))

      expect(result.reason).toMatch(/netLiquidation must be a finite positive value/)
      expect(result.reason).toContain(`received "${netLiquidation}"`)
      expect(result.metrics).toEqual({
        positionValuePct: null,
        threshold: 25,
        orderValuePct: null,
        orderThreshold: 10,
      })
    },
  )

  it('preserves existing-position market-price valuation and positive-equity cashQty behavior', () => {
    const existing = makePosition({
      contract: makeContract({ symbol: 'AAPL' }),
      marketPrice: '100',
      marketValue: '20000',
    })
    const existingResult = new MaxPositionSizeGuard({ maxPercentOfEquity: 50 }).evaluate(context(
      placeOrder({ symbol: 'AAPL', orderType: 'LMT', totalQuantity: '100', lmtPrice: '1000' }),
      { positions: [existing] },
    ))
    expect(existingResult).toEqual({
      metrics: { positionValuePct: 30, threshold: 50 },
    })

    const cashResult = new MaxPositionSizeGuard({
      maxPercentOfEquity: 50,
      maxOrderPercentOfEquity: 25,
    }).evaluate(context(placeOrder({ cashQty: '20000' })))
    expect(cashResult).toEqual({
      metrics: {
        positionValuePct: 20,
        threshold: 50,
        orderValuePct: 20,
        orderThreshold: 25,
      },
    })
  })

  it('never dispatches an unpriceable first quantity entry after guard rejection', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const broker = new MockBroker({ accountInfo: ACCOUNT })
    const pipeline = createGuardPipeline(
      dispatcher,
      broker,
      [new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })],
    )

    const result = await pipeline(placeOrder({ orderType: 'MKT', totalQuantity: '10' }))

    expect(dispatcher).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false })
    expect(hasLocalNoDispatchProof(result)).toBe(true)
  })

  it('rejects non-finite configured caps instead of silently disabling comparisons', () => {
    expect(() => new MaxPositionSizeGuard({ maxPercentOfEquity: 'not-a-number' }))
      .toThrow(/finite non-negative maxPercentOfEquity/)
    expect(() => new MaxPositionSizeGuard({ maxOrderPercentOfEquity: Number.POSITIVE_INFINITY }))
      .toThrow(/finite non-negative maxOrderPercentOfEquity/)
  })

  it.each([
    ['cashQty NaN', withRawOrderField(placeOrder({ cashQty: '1000' }), 'cashQty', new Decimal('NaN'))],
    ['cashQty infinity', withRawOrderField(placeOrder({ cashQty: '1000' }), 'cashQty', new Decimal('Infinity'))],
    ['cashQty negative', withRawOrderField(placeOrder({ cashQty: '1000' }), 'cashQty', new Decimal('-1'))],
    ['cashQty zero', withRawOrderField(placeOrder({ cashQty: '1000' }), 'cashQty', new Decimal('0'))],
    ['cashQty invalid', withRawOrderField(placeOrder({ cashQty: '1000' }), 'cashQty', 'not-a-decimal')],
    [
      'totalQuantity NaN',
      withRawOrderField(placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }), 'totalQuantity', new Decimal('NaN')),
    ],
    [
      'totalQuantity infinity',
      withRawOrderField(placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }), 'totalQuantity', new Decimal('Infinity')),
    ],
    [
      'totalQuantity negative',
      withRawOrderField(placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }), 'totalQuantity', new Decimal('-1')),
    ],
    [
      'totalQuantity zero',
      withRawOrderField(placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }), 'totalQuantity', new Decimal('0')),
    ],
    [
      'totalQuantity invalid',
      withRawOrderField(placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }), 'totalQuantity', 'not-a-decimal'),
    ],
    [
      'lmtPrice NaN',
      withRawOrderField(placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }), 'lmtPrice', new Decimal('NaN')),
    ],
    [
      'lmtPrice infinity',
      withRawOrderField(placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }), 'lmtPrice', new Decimal('Infinity')),
    ],
    [
      'lmtPrice negative',
      withRawOrderField(placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }), 'lmtPrice', new Decimal('-1')),
    ],
    [
      'lmtPrice invalid',
      withRawOrderField(placeOrder({ orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }), 'lmtPrice', 'not-a-decimal'),
    ],
    [
      'auxPrice NaN',
      withRawOrderField(placeOrder({ action: 'SELL', orderType: 'STP', totalQuantity: '10', auxPrice: '100' }), 'auxPrice', new Decimal('NaN')),
    ],
    [
      'auxPrice infinity',
      withRawOrderField(placeOrder({ action: 'SELL', orderType: 'STP', totalQuantity: '10', auxPrice: '100' }), 'auxPrice', new Decimal('Infinity')),
    ],
    [
      'auxPrice negative',
      withRawOrderField(placeOrder({ action: 'SELL', orderType: 'STP', totalQuantity: '10', auxPrice: '100' }), 'auxPrice', new Decimal('-1')),
    ],
    [
      'auxPrice invalid',
      withRawOrderField(placeOrder({ action: 'SELL', orderType: 'STP', totalQuantity: '10', auxPrice: '100' }), 'auxPrice', 'not-a-decimal'),
    ],
  ])('rejects malformed positive-risk order input without dispatch: %s', async (_label, operation) => {
    const result = await expectNoDispatch(operation)
    expect(result).toMatchObject({
      error: expect.stringMatching(/must be finite and positive|not a valid decimal/),
    })
  })

  it.each([
    ['marketPrice', 'NaN'],
    ['marketPrice', 'Infinity'],
    ['marketPrice', '-1'],
    ['marketPrice', '0'],
    ['marketPrice', 'not-a-decimal'],
    ['marketValue', 'NaN'],
    ['marketValue', 'Infinity'],
    ['marketValue', '-1'],
    ['marketValue', 'not-a-decimal'],
  ] as const)(
    'rejects malformed existing-position %s=%s without dispatch',
    async (field, value) => {
      const position = makePosition({
        contract: makeContract({ symbol: 'AAPL' }),
        marketPrice: field === 'marketPrice' ? value : '100',
        marketValue: field === 'marketValue' ? value : '20000',
      })
      const result = await expectNoDispatch(
        placeOrder({ symbol: 'AAPL', orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' }),
        { positions: [position] },
      )
      expect(result).toMatchObject({
        error: expect.stringContaining(`existing ${field} must be finite`),
      })
    },
  )

  it.each([
    ['SELL LMT', placeOrder({ action: 'SELL', orderType: 'LMT', totalQuantity: '10', lmtPrice: '100' })],
    ['BUY STP', placeOrder({ action: 'BUY', orderType: 'STP', totalQuantity: '10', auxPrice: '100' })],
    [
      'SELL STP LMT',
      placeOrder({ action: 'SELL', orderType: 'STP LMT', totalQuantity: '10', lmtPrice: '95', auxPrice: '100' }),
    ],
  ])('rejects first-entry %s because its carried price is not an upper bound', async (_label, operation) => {
    const result = await expectNoDispatch(operation)
    expect(result).toMatchObject({
      error: expect.stringContaining('conservative upper bound'),
    })
  })

  it.each([
    [
      'BUY STP LMT at its limit price',
      placeOrder({ action: 'BUY', orderType: 'STP LMT', totalQuantity: '300', lmtPrice: '100', auxPrice: '95' }),
    ],
    [
      'SELL STP at its stop price',
      placeOrder({ action: 'SELL', orderType: 'STP', totalQuantity: '300', auxPrice: '100' }),
    ],
  ])('uses a conservative first-entry upper bound for %s', (_label, operation) => {
    const result = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 }).evaluate(context(operation))
    expect(result).toMatchObject({
      reason: 'Position for NEW_STOCK would be 30.0% of equity (limit: 25%)',
      metrics: { positionValuePct: 30, threshold: 25 },
    })
  })
})
