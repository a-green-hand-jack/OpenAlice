import Decimal from 'decimal.js'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import type { OperationGuard, GuardContext, GuardEvaluation } from './types.js'
import type { Position } from '../brokers/types.js'

const DEFAULT_MAX_PERCENT = 25

export class MaxPositionSizeGuard implements OperationGuard {
  readonly name = 'max-position-size'
  private maxPercent: number
  private maxOrderPercent?: number

  constructor(options: Record<string, unknown>) {
    this.maxPercent = Number(options.maxPercentOfEquity ?? DEFAULT_MAX_PERCENT)
    this.maxOrderPercent = options.maxOrderPercentOfEquity == null
      ? undefined
      : Number(options.maxOrderPercentOfEquity)
  }

  async check(ctx: GuardContext): Promise<string | null> {
    return (await this.evaluate(ctx)).reason ?? null
  }

  async evaluate(ctx: GuardContext): Promise<GuardEvaluation> {
    if (ctx.operation.action !== 'placeOrder') return {}

    const { positions, account, operation } = ctx
    const symbol = operation.contract.symbol

    const existing = positions.find(p => p.contract.symbol === symbol)
    const currentValue = signedPositionValue(existing)

    // Estimate added value from IBKR Order fields
    const { order } = operation
    const cashQty = !order.cashQty.equals(UNSET_DECIMAL) ? order.cashQty : undefined
    const qty = !order.totalQuantity.equals(UNSET_DECIMAL) ? order.totalQuantity : undefined

    let addedValue = new Decimal(0)
    if (cashQty && cashQty.gt(0)) {
      addedValue = cashQty
    } else if (qty) {
      const price = await estimateUnitPrice(ctx, existing)
      if (price) addedValue = qty.mul(price)
    }
    // If we can't estimate, allow — broker/venue validation remains the final backstop.

    if (addedValue.isZero()) return {}

    const signedDelta = String(order.action || 'BUY').toUpperCase() === 'SELL'
      ? addedValue.neg()
      : addedValue
    const projectedValue = currentValue.plus(signedDelta).abs()
    const currentAbsValue = currentValue.abs()
    const netLiq = new Decimal(account.netLiquidation)
    const percent = netLiq.gt(0) ? projectedValue.div(netLiq).mul(100) : new Decimal(0)
    const orderPercent = netLiq.gt(0) ? addedValue.div(netLiq).mul(100) : new Decimal(0)
    const metrics = {
      positionValuePct: percent.toNumber(),
      threshold: this.maxPercent,
      orderValuePct: orderPercent.toNumber(),
      ...(this.maxOrderPercent == null ? {} : { orderThreshold: this.maxOrderPercent }),
    }

    if (!projectedValue.gt(currentAbsValue)) return { metrics }

    if (this.maxOrderPercent != null && orderPercent.gt(this.maxOrderPercent)) {
      return {
        reason: `Order for ${symbol} would add ${orderPercent.toFixed(1)}% of equity (single-order limit: ${this.maxOrderPercent}%)`,
        metrics,
      }
    }

    if (percent.gt(this.maxPercent)) {
      return {
        reason: `Position for ${symbol} would be ${percent.toFixed(1)}% of equity (limit: ${this.maxPercent}%)`,
        metrics,
      }
    }

    return { metrics }
  }
}

function signedPositionValue(position: Position | undefined): Decimal {
  if (!position) return new Decimal(0)
  const value = parseDecimal(position.marketValue)?.abs() ?? new Decimal(0)
  return position.side === 'short' ? value.neg() : value
}

async function estimateUnitPrice(ctx: GuardContext, existing: Position | undefined): Promise<Decimal | null> {
  if (existing) return parsePositiveDecimal(existing.marketPrice)

  const limitPrice = parseOrderPrice(ctx.operation.action === 'placeOrder' ? ctx.operation.order.lmtPrice : undefined)
  if (limitPrice) return limitPrice

  if (!ctx.getQuote || ctx.operation.action !== 'placeOrder') return null

  try {
    const quote = await ctx.getQuote(ctx.operation.contract)
    const action = String(ctx.operation.order.action || 'BUY').toUpperCase()
    const candidates = action === 'SELL'
      ? [quote.bid, quote.last, quote.ask]
      : [quote.ask, quote.last, quote.bid]
    for (const candidate of candidates) {
      const parsed = parsePositiveDecimal(candidate)
      if (parsed) return parsed
    }
  } catch {
    return null
  }

  return null
}

function parseOrderPrice(value: unknown): Decimal | null {
  if (!value) return null
  if (value instanceof Decimal) {
    if (value.equals(UNSET_DECIMAL) || value.lte(0)) return null
    return value
  }
  return parsePositiveDecimal(value)
}

function parsePositiveDecimal(value: unknown): Decimal | null {
  const parsed = parseDecimal(value)
  return parsed?.gt(0) ? parsed : null
}

function parseDecimal(value: unknown): Decimal | null {
  if (value == null || value === '') return null
  try {
    const parsed = new Decimal(String(value))
    return parsed.isFinite() ? parsed : null
  } catch {
    return null
  }
}
