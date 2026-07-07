import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order, UNSET_DECIMAL } from '@traderalice/ibkr'
import { MaxPositionSizeGuard } from './max-position-size.js'
import { CooldownGuard } from './cooldown.js'
import { SymbolWhitelistGuard } from './symbol-whitelist.js'
import { MaxDrawdownGuard } from './max-drawdown.js'
import { DailyLossGuard } from './daily-loss.js'
import { ConcentrationGuard } from './concentration.js'
import {
  createPortfolioGuardStateStore,
  portfolioGuardStatePath,
  type PortfolioGuardStateStore,
} from './portfolio-state.js'
import { createGuardPipeline } from './guard-pipeline.js'
import { resolveGuards, registerGuard } from './registry.js'
import type { GuardContext, OperationGuard } from './types.js'
import type { Operation } from '../git/types.js'
import type { AccountInfo, Position } from '../brokers/types.js'
import { MockBroker, makeContract, makePosition } from '../brokers/mock/index.js'
import '../contract-ext.js'

// ==================== Helpers ====================

let tempDirs: string[] = []

function makePlaceOrderOp(overrides: {
  symbol?: string
  action?: 'BUY' | 'SELL'
  orderType?: string
  cashQty?: number
  totalQuantity?: Decimal
  lmtPrice?: number
  auxPrice?: number
} = {}): Operation {
  const contract = makeContract({ symbol: overrides.symbol ?? 'AAPL' })
  const order = new Order()
  order.action = overrides.action ?? 'BUY'
  order.orderType = overrides.orderType ?? 'MKT'
  order.totalQuantity = overrides.totalQuantity ?? new Decimal(10)
  if (overrides.cashQty != null) {
    order.cashQty = new Decimal(overrides.cashQty)
  }
  if (overrides.lmtPrice != null) {
    order.lmtPrice = new Decimal(overrides.lmtPrice)
  }
  if (overrides.auxPrice != null) {
    order.auxPrice = new Decimal(overrides.auxPrice)
  }
  return { action: 'placeOrder', contract, order }
}

function makeContext(overrides: {
  operation?: Operation
  positions?: Position[]
  account?: Partial<AccountInfo>
} = {}): GuardContext {
  return {
    operation: overrides.operation ?? makePlaceOrderOp(),
    positions: overrides.positions ?? [],
    account: {
      baseCurrency: 'USD',
      netLiquidation: '100000',
      totalCashValue: '100000',
      unrealizedPnL: '0',
      realizedPnL: '0',
      ...overrides.account,
    },
  }
}

function makeTempStateBaseDir(): string {
  const dir = join(tmpdir(), `openalice-guard-spec-${randomUUID()}`)
  tempDirs.push(dir)
  return dir
}

function makeTempStateStore(accountId = `guard-${randomUUID()}`): PortfolioGuardStateStore {
  const dir = makeTempStateBaseDir()
  return createPortfolioGuardStateStore(accountId, { baseDir: dir })
}

async function makeCorruptStateStore(accountId = `guard-${randomUUID()}`): Promise<PortfolioGuardStateStore> {
  const dir = makeTempStateBaseDir()
  const path = portfolioGuardStatePath(accountId, { baseDir: dir })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '{"version":999}', 'utf-8')
  return createPortfolioGuardStateStore(accountId, { baseDir: dir })
}

afterEach(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

// ==================== MaxPositionSizeGuard ====================

describe('MaxPositionSizeGuard', () => {
  it('allows order within limit', async () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ cashQty: 20_000 }),
      account: { netLiquidation: '100000' },
    })

    await expect(guard.check(ctx)).resolves.toBeNull()
  })

  it('rejects order exceeding limit', async () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ cashQty: 30_000 }),
      account: { netLiquidation: '100000' },
    })

    const result = await guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('30.0%')
    expect(result).toContain('limit: 25%')
  })

  it('considers existing position value', async () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ cashQty: 10_000 }),
      positions: [makePosition({ contract: makeContract({ symbol: 'AAPL' }), marketValue: '20000' })],
      account: { netLiquidation: '100000' },
    })

    const result = await guard.check(ctx)
    expect(result).not.toBeNull()
    // 20k existing + 10k new = 30k = 30%
    expect(result).toContain('30.0%')
  })

  it('rejects a risk-increasing single order above the configured order cap', async () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 60, maxOrderPercentOfEquity: 20 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ cashQty: 30_000 }),
      account: { netLiquidation: '100000' },
    })

    const result = await guard.check(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('30.0%')
    expect(result).toContain('single-order limit: 20%')
  })

  it('allows risk-reducing sells even when the starting position is above the cap', async () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 60, maxOrderPercentOfEquity: 20 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ action: 'SELL', cashQty: 5_000 }),
      positions: [makePosition({ contract: makeContract({ symbol: 'AAPL' }), marketValue: '70000' })],
      account: { netLiquidation: '100000' },
    })

    await expect(guard.check(ctx)).resolves.toBeNull()
  })

  it('uses default 25% if no option provided', async () => {
    const guard = new MaxPositionSizeGuard({})
    const ctx = makeContext({
      operation: makePlaceOrderOp({ cashQty: 26_000 }),
      account: { netLiquidation: '100000' },
    })
    await expect(guard.check(ctx)).resolves.not.toBeNull()
  })

  it('skips non-placeOrder operations', async () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 1 })
    const contract = makeContract({ symbol: 'AAPL' })
    const ctx = makeContext({
      operation: { action: 'closePosition', contract },
    })
    await expect(guard.check(ctx)).resolves.toBeNull()
  })

  it('estimates qty-based new positions from limit price', async () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ symbol: 'NEW_STOCK', totalQuantity: new Decimal(300), lmtPrice: 100 }),
      account: { netLiquidation: '100000' },
    })

    const result = await guard.check(ctx)

    expect(result).not.toBeNull()
    expect(result).toContain('30.0%')
  })

  it('estimates qty-based new positions from quote when no limit price exists', async () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 25 })
    const contract = makeContract({ symbol: 'NEW_STOCK' })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ symbol: 'NEW_STOCK', totalQuantity: new Decimal(300) }),
      account: { netLiquidation: '100000' },
    })

    const result = await guard.check({
      ...ctx,
      getQuote: async () => ({
        contract,
        last: '100',
        bid: '99.99',
        ask: '100.01',
        volume: '0',
        timestamp: new Date('2026-07-07T00:00:00.000Z'),
      }),
    })

    expect(result).not.toBeNull()
    expect(result).toContain('30.0%')
  })

  it('allows when addedValue cannot be estimated (qty-based, no existing position, quote unavailable)', async () => {
    const guard = new MaxPositionSizeGuard({ maxPercentOfEquity: 1 })
    const ctx = makeContext({
      operation: makePlaceOrderOp({ symbol: 'NEW_STOCK', totalQuantity: new Decimal(100) }),
    })
    await expect(guard.check({
      ...ctx,
      getQuote: async () => { throw new Error('quote unavailable') },
    })).resolves.toBeNull()
  })
})

// ==================== CooldownGuard ====================

describe('CooldownGuard', () => {
  it('allows first trade', () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })
    const ctx = makeContext()
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects rapid repeat trade for same symbol', () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })
    const ctx = makeContext()

    guard.check(ctx) // first — allowed
    const result = guard.check(ctx) // second — rejected
    expect(result).not.toBeNull()
    expect(result).toContain('Cooldown active')
    expect(result).toContain('AAPL')
  })

  it('allows trade for different symbol', () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })

    guard.check(makeContext({
      operation: makePlaceOrderOp({ symbol: 'AAPL' }),
    }))

    const result = guard.check(makeContext({
      operation: makePlaceOrderOp({ symbol: 'GOOG' }),
    }))
    expect(result).toBeNull()
  })

  it('skips non-placeOrder operations', () => {
    const guard = new CooldownGuard({ minIntervalMs: 60_000 })
    const contract = makeContract({ symbol: 'AAPL' })
    const ctx = makeContext({
      operation: { action: 'closePosition', contract },
    })
    expect(guard.check(ctx)).toBeNull()
  })
})

// ==================== SymbolWhitelistGuard ====================

describe('SymbolWhitelistGuard', () => {
  it('allows whitelisted symbols', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['AAPL', 'GOOG'] })
    const ctx = makeContext()
    expect(guard.check(ctx)).toBeNull()
  })

  it('rejects non-whitelisted symbols', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['GOOG'] })
    const ctx = makeContext()
    expect(guard.check(ctx)).toContain('not in the allowed list')
  })

  it('throws on construction without symbols', () => {
    expect(() => new SymbolWhitelistGuard({})).toThrow('non-empty "symbols"')
    expect(() => new SymbolWhitelistGuard({ symbols: [] })).toThrow('non-empty "symbols"')
  })

  it('allows operations without a symbol param', () => {
    const guard = new SymbolWhitelistGuard({ symbols: ['AAPL'] })
    const ctx = makeContext({
      operation: { action: 'cancelOrder', orderId: '123' },
    })
    expect(guard.check(ctx)).toBeNull()
  })
})

// ==================== MaxDrawdownGuard ====================

describe('MaxDrawdownGuard', () => {
  it('allows order within max drawdown and reports metrics', async () => {
    const stateStore = makeTempStateStore()
    const guard = new MaxDrawdownGuard({ maxDrawdownPct: 10 }, { stateStore })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const result = await guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 1_000 }),
      account: { netLiquidation: '95000' },
    }))

    expect(result).toEqual({
      metrics: {
        drawdownPct: 5,
        maxDrawdownPct: 10,
        highWaterMark: 100000,
        equity: 95000,
      },
    })
  })

  it('rejects risk-increasing order above max drawdown and reports metrics', async () => {
    const stateStore = makeTempStateStore()
    const guard = new MaxDrawdownGuard({ maxDrawdownPct: 10 }, { stateStore })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const result = await guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 1_000 }),
      account: { netLiquidation: '85000' },
    }))

    expect(result.reason).toBe('Drawdown is 15.0% of equity (limit: 10%)')
    expect(result.metrics).toEqual({
      drawdownPct: 15,
      maxDrawdownPct: 10,
      highWaterMark: 100000,
      equity: 85000,
    })
  })

  it('allows closePosition and cancelOrder while max drawdown is breached', async () => {
    const stateStore = makeTempStateStore()
    const guard = new MaxDrawdownGuard({ maxDrawdownPct: 10 }, { stateStore })
    const contract = makeContract({ symbol: 'AAPL' })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    await expect(guard.evaluate(makeContext({
      operation: { action: 'closePosition', contract },
      account: { netLiquidation: '85000' },
    }))).resolves.toEqual({})

    await expect(guard.evaluate(makeContext({
      operation: { action: 'cancelOrder', orderId: 'ord-1' },
      account: { netLiquidation: '85000' },
    }))).resolves.toEqual({})
  })

  it('allows closePosition without reading corrupt max-drawdown state', async () => {
    const stateStore = await makeCorruptStateStore()
    const guard = new MaxDrawdownGuard({ maxDrawdownPct: 10 }, { stateStore })
    const contract = makeContract({ symbol: 'AAPL' })

    await expect(guard.evaluate(makeContext({
      operation: { action: 'closePosition', contract },
      account: { netLiquidation: '85000' },
    }))).resolves.toEqual({})
  })

  it('throws on corrupt max-drawdown state for risk-increasing placeOrder', async () => {
    const stateStore = await makeCorruptStateStore()
    const guard = new MaxDrawdownGuard({ maxDrawdownPct: 10 }, { stateStore })

    await expect(guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 1_000 }),
      account: { netLiquidation: '85000' },
    }))).rejects.toThrow('portfolio guard state: unsupported or corrupt state file')
  })

  it('rejects modifyOrder while max drawdown is breached', async () => {
    const stateStore = makeTempStateStore()
    const guard = new MaxDrawdownGuard({ maxDrawdownPct: 10 }, { stateStore })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const result = await guard.evaluate(makeContext({
      operation: { action: 'modifyOrder', orderId: 'ord-1', changes: { lmtPrice: new Decimal(150) } },
      account: { netLiquidation: '85000' },
    }))

    expect(result.reason).toBe('Drawdown is 15.0% of equity (limit: 10%)')
    expect(result.metrics).toEqual({
      drawdownPct: 15,
      maxDrawdownPct: 10,
      highWaterMark: 100000,
      equity: 85000,
    })
  })

  it('passes an unestimable placeOrder while drawdown is below the limit', async () => {
    const stateStore = makeTempStateStore()
    const guard = new MaxDrawdownGuard({ maxDrawdownPct: 10 }, { stateStore })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const result = await guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ symbol: 'NEW_STOCK', totalQuantity: new Decimal(100) }),
      account: { netLiquidation: '99000' },
    }))

    expect(result.reason).toBeUndefined()
    expect(result.metrics).toEqual({
      drawdownPct: 1,
      maxDrawdownPct: 10,
      highWaterMark: 100000,
      equity: 99000,
    })
  })

  it('persists high-water mark across a simulated restart', async () => {
    const stateStore = makeTempStateStore('acct-restart')
    const first = new MaxDrawdownGuard({ maxDrawdownPct: 10 }, { stateStore })
    await first.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const restarted = new MaxDrawdownGuard({ maxDrawdownPct: 10 }, { stateStore })
    const result = await restarted.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 1_000 }),
      account: { netLiquidation: '85000' },
    }))

    expect(result.reason).toBe('Drawdown is 15.0% of equity (limit: 10%)')
    expect(result.metrics).toEqual({
      drawdownPct: 15,
      maxDrawdownPct: 10,
      highWaterMark: 100000,
      equity: 85000,
    })
  })

  it('ratchets high-water mark up on new peaks and never down', async () => {
    const stateStore = makeTempStateStore()
    const guard = new MaxDrawdownGuard({ maxDrawdownPct: 10 }, { stateStore })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const newPeak = await guard.evaluate(makeContext({ account: { netLiquidation: '110000' } }))
    expect(newPeak.metrics).toEqual({
      drawdownPct: 0,
      maxDrawdownPct: 10,
      highWaterMark: 110000,
      equity: 110000,
    })

    const lower = await guard.evaluate(makeContext({ account: { netLiquidation: '105000' } }))
    expect(lower.metrics?.highWaterMark).toBe(110000)
    expect(lower.metrics?.equity).toBe(105000)
    expect(lower.metrics?.drawdownPct).toBeCloseTo(4.545454545)
  })
})

// ==================== DailyLossGuard ====================

describe('DailyLossGuard', () => {
  it('allows order within daily loss and reports metrics', async () => {
    const stateStore = makeTempStateStore()
    const now = () => new Date('2026-07-04T10:00:00.000Z')
    const guard = new DailyLossGuard({ maxDailyLossPct: 5 }, { stateStore, now })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const result = await guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 1_000 }),
      account: { netLiquidation: '98000' },
    }))

    expect(result).toEqual({
      metrics: {
        dailyLossPct: 2,
        maxDailyLossPct: 5,
        dayStartEquity: 100000,
        equity: 98000,
      },
    })
  })

  it('rejects risk-increasing order above daily loss and reports metrics', async () => {
    const stateStore = makeTempStateStore()
    const now = () => new Date('2026-07-04T10:00:00.000Z')
    const guard = new DailyLossGuard({ maxDailyLossPct: 5 }, { stateStore, now })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const result = await guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 1_000 }),
      account: { netLiquidation: '94000' },
    }))

    expect(result.reason).toBe('Daily loss is 6.0% of day-start equity (limit: 5%)')
    expect(result.metrics).toEqual({
      dailyLossPct: 6,
      maxDailyLossPct: 5,
      dayStartEquity: 100000,
      equity: 94000,
    })
  })

  it('allows closePosition and cancelOrder while daily loss is breached', async () => {
    const stateStore = makeTempStateStore()
    const now = () => new Date('2026-07-04T10:00:00.000Z')
    const guard = new DailyLossGuard({ maxDailyLossPct: 5 }, { stateStore, now })
    const contract = makeContract({ symbol: 'AAPL' })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    await expect(guard.evaluate(makeContext({
      operation: { action: 'closePosition', contract },
      account: { netLiquidation: '94000' },
    }))).resolves.toEqual({})

    await expect(guard.evaluate(makeContext({
      operation: { action: 'cancelOrder', orderId: 'ord-1' },
      account: { netLiquidation: '94000' },
    }))).resolves.toEqual({})
  })

  it('allows closePosition without reading corrupt daily-loss state', async () => {
    const stateStore = await makeCorruptStateStore()
    const now = () => new Date('2026-07-04T10:00:00.000Z')
    const guard = new DailyLossGuard({ maxDailyLossPct: 5 }, { stateStore, now })
    const contract = makeContract({ symbol: 'AAPL' })

    await expect(guard.evaluate(makeContext({
      operation: { action: 'closePosition', contract },
      account: { netLiquidation: '94000' },
    }))).resolves.toEqual({})
  })

  it('throws on corrupt daily-loss state for risk-increasing placeOrder', async () => {
    const stateStore = await makeCorruptStateStore()
    const now = () => new Date('2026-07-04T10:00:00.000Z')
    const guard = new DailyLossGuard({ maxDailyLossPct: 5 }, { stateStore, now })

    await expect(guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 1_000 }),
      account: { netLiquidation: '94000' },
    }))).rejects.toThrow('portfolio guard state: unsupported or corrupt state file')
  })

  it('rejects modifyOrder while daily loss is breached', async () => {
    const stateStore = makeTempStateStore()
    const now = () => new Date('2026-07-04T10:00:00.000Z')
    const guard = new DailyLossGuard({ maxDailyLossPct: 5 }, { stateStore, now })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const result = await guard.evaluate(makeContext({
      operation: { action: 'modifyOrder', orderId: 'ord-1', changes: { lmtPrice: new Decimal(150) } },
      account: { netLiquidation: '94000' },
    }))

    expect(result.reason).toBe('Daily loss is 6.0% of day-start equity (limit: 5%)')
    expect(result.metrics).toEqual({
      dailyLossPct: 6,
      maxDailyLossPct: 5,
      dayStartEquity: 100000,
      equity: 94000,
    })
  })

  it('passes an unestimable placeOrder while daily loss is below the limit', async () => {
    const stateStore = makeTempStateStore()
    const now = () => new Date('2026-07-04T10:00:00.000Z')
    const guard = new DailyLossGuard({ maxDailyLossPct: 5 }, { stateStore, now })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const result = await guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ symbol: 'NEW_STOCK', totalQuantity: new Decimal(100) }),
      account: { netLiquidation: '99000' },
    }))

    expect(result.reason).toBeUndefined()
    expect(result.metrics).toEqual({
      dailyLossPct: 1,
      maxDailyLossPct: 5,
      dayStartEquity: 100000,
      equity: 99000,
    })
  })

  it('persists day-start equity across a simulated restart', async () => {
    const stateStore = makeTempStateStore('acct-daily-restart')
    const now = () => new Date('2026-07-04T10:00:00.000Z')
    const first = new DailyLossGuard({ maxDailyLossPct: 5 }, { stateStore, now })
    await first.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const restarted = new DailyLossGuard({ maxDailyLossPct: 5 }, { stateStore, now })
    const result = await restarted.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 1_000 }),
      account: { netLiquidation: '94000' },
    }))

    expect(result.reason).toBe('Daily loss is 6.0% of day-start equity (limit: 5%)')
    expect(result.metrics).toEqual({
      dailyLossPct: 6,
      maxDailyLossPct: 5,
      dayStartEquity: 100000,
      equity: 94000,
    })
  })

  it('resets day-start equity across a UTC day boundary', async () => {
    const stateStore = makeTempStateStore()
    let currentTime = new Date('2026-07-04T23:59:59.000Z')
    const now = () => currentTime
    const guard = new DailyLossGuard({ maxDailyLossPct: 5 }, { stateStore, now })
    await guard.evaluate(makeContext({ account: { netLiquidation: '100000' } }))

    const beforeMidnight = await guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 1_000 }),
      account: { netLiquidation: '94000' },
    }))
    expect(beforeMidnight.reason).toBe('Daily loss is 6.0% of day-start equity (limit: 5%)')

    currentTime = new Date('2026-07-05T00:00:01.000Z')
    const afterMidnight = await guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 1_000 }),
      account: { netLiquidation: '94000' },
    }))

    expect(afterMidnight.reason).toBeUndefined()
    expect(afterMidnight.metrics).toEqual({
      dailyLossPct: 0,
      maxDailyLossPct: 5,
      dayStartEquity: 94000,
      equity: 94000,
    })
  })
})

// ==================== ConcentrationGuard ====================

describe('ConcentrationGuard', () => {
  it('allows order within instrument concentration and reports metrics', () => {
    const guard = new ConcentrationGuard({ maxInstrumentPct: 25 })
    const result = guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 10_000 }),
      account: { netLiquidation: '100000' },
    }))

    expect(result).toEqual({
      metrics: {
        instrumentPct: 10,
        maxInstrumentPct: 25,
        symbol: 'AAPL',
      },
    })
  })

  it('rejects exposure-increasing order above concentration and reports metrics', () => {
    const guard = new ConcentrationGuard({ maxInstrumentPct: 25 })
    const result = guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ cashQty: 30_000 }),
      account: { netLiquidation: '100000' },
    }))

    expect(result.reason).toBe('Instrument AAPL would be 30.0% of equity (limit: 25%)')
    expect(result.metrics).toEqual({
      instrumentPct: 30,
      maxInstrumentPct: 25,
      symbol: 'AAPL',
    })
  })

  it('rejects new-symbol LMT quantity order above concentration and reports metrics', () => {
    const guard = new ConcentrationGuard({ maxInstrumentPct: 25 })
    const result = guard.evaluate(makeContext({
      operation: makePlaceOrderOp({
        symbol: 'NEW_STOCK',
        orderType: 'LMT',
        totalQuantity: new Decimal(300),
        lmtPrice: 100,
      }),
      account: { netLiquidation: '100000' },
    }))

    expect(result.reason).toBe('Instrument NEW_STOCK would be 30.0% of equity (limit: 25%)')
    expect(result.metrics).toEqual({
      instrumentPct: 30,
      maxInstrumentPct: 25,
      symbol: 'NEW_STOCK',
    })
  })

  it('rejects new-symbol STP quantity order valued via auxPrice above concentration', () => {
    const guard = new ConcentrationGuard({ maxInstrumentPct: 25 })
    const result = guard.evaluate(makeContext({
      operation: makePlaceOrderOp({
        symbol: 'NEW_STOCK',
        orderType: 'STP',
        totalQuantity: new Decimal(300),
        auxPrice: 100,
      }),
      account: { netLiquidation: '100000' },
    }))

    expect(result.reason).toBe('Instrument NEW_STOCK would be 30.0% of equity (limit: 25%)')
    expect(result.metrics).toEqual({
      instrumentPct: 30,
      maxInstrumentPct: 25,
      symbol: 'NEW_STOCK',
    })
  })

  it('allows closePosition and cancelOrder while existing concentration is above the limit', () => {
    const guard = new ConcentrationGuard({ maxInstrumentPct: 25 })
    const contract = makeContract({ symbol: 'AAPL' })
    const positions = [makePosition({ contract, marketValue: '50000' })]

    expect(guard.evaluate(makeContext({
      operation: { action: 'closePosition', contract },
      positions,
      account: { netLiquidation: '100000' },
    }))).toEqual({
      metrics: { instrumentPct: null, maxInstrumentPct: 25, symbol: 'unknown' },
    })

    expect(guard.evaluate(makeContext({
      operation: { action: 'cancelOrder', orderId: 'ord-1' },
      positions,
      account: { netLiquidation: '100000' },
    }))).toEqual({
      metrics: { instrumentPct: null, maxInstrumentPct: 25, symbol: 'unknown' },
    })
  })

  it('allows exposure-reducing order even when post-fill concentration remains above the limit', () => {
    const guard = new ConcentrationGuard({ maxInstrumentPct: 25 })
    const contract = makeContract({ symbol: 'AAPL' })
    const result = guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ action: 'SELL', cashQty: 1_000 }),
      positions: [makePosition({ contract, marketValue: '40000' })],
      account: { netLiquidation: '100000' },
    }))

    expect(result.reason).toBeUndefined()
    expect(result.metrics).toEqual({
      instrumentPct: 39,
      maxInstrumentPct: 25,
      symbol: 'AAPL',
    })
  })

  it('allows MKT quantity order for a new symbol when post-fill exposure cannot be estimated', () => {
    const guard = new ConcentrationGuard({ maxInstrumentPct: 1 })
    const result = guard.evaluate(makeContext({
      operation: makePlaceOrderOp({ symbol: 'NEW_STOCK', totalQuantity: new Decimal(100) }),
    }))

    expect(result).toEqual({
      metrics: {
        instrumentPct: null,
        maxInstrumentPct: 1,
        symbol: 'NEW_STOCK',
      },
    })
  })

  it('allows modifyOrder regardless of concentration', () => {
    const guard = new ConcentrationGuard({ maxInstrumentPct: 1 })
    const result = guard.evaluate(makeContext({
      operation: { action: 'modifyOrder', orderId: 'ord-1', changes: { lmtPrice: new Decimal(150) } },
      positions: [makePosition({ contract: makeContract({ symbol: 'AAPL' }), marketValue: '50000' })],
      account: { netLiquidation: '100000' },
    }))

    expect(result).toEqual({
      metrics: { instrumentPct: null, maxInstrumentPct: 1, symbol: 'unknown' },
    })
  })
})

// ==================== Guard Pipeline ====================

describe('createGuardPipeline', () => {
  it('returns dispatcher directly when no guards', () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockBroker()
    const pipeline = createGuardPipeline(dispatcher, account, [])

    // Should be the same function reference
    expect(pipeline).toBe(dispatcher)
  })

  it('passes through when all guards allow', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockBroker()
    const allowGuard: OperationGuard = { name: 'allow-all', check: () => null }

    const pipeline = createGuardPipeline(dispatcher, account, [allowGuard])
    const op: Operation = makePlaceOrderOp()
    const result = await pipeline(op)

    expect(dispatcher).toHaveBeenCalledWith(op)
    expect(result).toEqual({
      success: true,
      guardVerdicts: [{ guard: 'allow-all', verdict: 'pass' }],
    })
  })

  it('blocks when a guard rejects', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockBroker()
    const denyGuard: OperationGuard = { name: 'deny-all', check: () => 'Denied!' }

    const pipeline = createGuardPipeline(dispatcher, account, [denyGuard])
    const op: Operation = makePlaceOrderOp()
    const result = await pipeline(op) as Record<string, unknown>

    expect(dispatcher).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toContain('[guard:deny-all]')
    expect(result.error).toContain('Denied!')
    expect(result.guardVerdicts).toEqual([
      { guard: 'deny-all', verdict: 'reject', reason: 'Denied!' },
    ])
  })

  it('stops at first rejecting guard', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockBroker()
    const guardA: OperationGuard = { name: 'A', check: vi.fn().mockReturnValue(null) }
    const guardB: OperationGuard = { name: 'B', check: vi.fn().mockReturnValue('Blocked by B') }
    const guardC: OperationGuard = { name: 'C', check: vi.fn().mockReturnValue(null) }

    const pipeline = createGuardPipeline(dispatcher, account, [guardA, guardB, guardC])
    const op: Operation = makePlaceOrderOp()
    const result = await pipeline(op) as Record<string, unknown>

    expect(guardA.check).toHaveBeenCalled()
    expect(guardB.check).toHaveBeenCalled()
    expect(guardC.check).not.toHaveBeenCalled()
    expect(result.guardVerdicts).toEqual([
      { guard: 'A', verdict: 'pass' },
      { guard: 'B', verdict: 'reject', reason: 'Blocked by B' },
      { guard: 'C', verdict: 'skipped', reason: 'not evaluated after earlier guard rejection' },
    ])
  })

  it('fetches positions and account info for guard context', async () => {
    const dispatcher = vi.fn().mockResolvedValue({ success: true })
    const account = new MockBroker({ accountInfo: { netLiquidation: '105000', totalCashValue: '100000', unrealizedPnL: '5000', realizedPnL: '1000' } })
    account.setPositions([makePosition()])

    let capturedCtx: GuardContext | undefined
    const spyGuard: OperationGuard = {
      name: 'spy',
      check: (ctx) => { capturedCtx = ctx; return null },
    }

    const pipeline = createGuardPipeline(dispatcher, account, [spyGuard])
    await pipeline(makePlaceOrderOp())

    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.positions).toHaveLength(1)
    expect(capturedCtx!.account.netLiquidation).toBe('105000')
  })
})

// ==================== Registry ====================

describe('resolveGuards', () => {
  it('resolves builtin guard types', () => {
    const guards = resolveGuards([
      { type: 'max-position-size', options: { maxPercentOfEquity: 25 } },
      { type: 'symbol-whitelist', options: { symbols: ['AAPL'] } },
    ])
    expect(guards).toHaveLength(2)
    expect(guards[0].name).toBe('max-position-size')
    expect(guards[1].name).toBe('symbol-whitelist')
  })

  it('resolves portfolio guard types', () => {
    const guards = resolveGuards([
      { type: 'max-drawdown', options: { maxDrawdownPct: 10 } },
      { type: 'daily-loss', options: { maxDailyLossPct: 5 } },
      { type: 'concentration', options: { maxInstrumentPct: 25 } },
    ], { accountId: 'mock-paper', stateBaseDir: join(tmpdir(), `openalice-registry-spec-${randomUUID()}`) })

    expect(guards.map(g => g.name)).toEqual(['max-drawdown', 'daily-loss', 'concentration'])
  })

  it('skips unknown guard types with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const guards = resolveGuards([{ type: 'nonexistent' }])
    expect(guards).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))
    warnSpy.mockRestore()
  })

  it('returns empty for empty config', () => {
    expect(resolveGuards([])).toEqual([])
  })
})

describe('registerGuard', () => {
  it('registers a custom guard type', () => {
    registerGuard({
      type: 'test-custom',
      create: () => ({ name: 'test-custom', check: () => null }),
    })

    const guards = resolveGuards([{ type: 'test-custom' }])
    expect(guards).toHaveLength(1)
    expect(guards[0].name).toBe('test-custom')
  })
})
