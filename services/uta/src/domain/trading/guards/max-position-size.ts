import Decimal from 'decimal.js'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import type { OperationGuard, GuardContext, GuardEvaluation } from './types.js'

const DEFAULT_MAX_PERCENT = 25

export class MaxPositionSizeGuard implements OperationGuard {
  readonly name = 'max-position-size'
  private readonly maxPercent: number
  // Single-order cap (docs/steward-p3-campaign.zh.md §4.7 hard guards): a
  // separate, optional ceiling on how much equity ONE order may add, checked
  // independently of the aggregate post-fill position cap below — a single
  // outsized paper order can breach this even while the resulting position
  // stays under maxPercentOfEquity (e.g. a large order into a previously
  // small/empty position).
  private readonly maxOrderPercent?: number

  constructor(options: Record<string, unknown>) {
    this.maxPercent = parseCap(options.maxPercentOfEquity, DEFAULT_MAX_PERCENT, 'maxPercentOfEquity')
    this.maxOrderPercent = options.maxOrderPercentOfEquity == null
      ? undefined
      : parseCap(options.maxOrderPercentOfEquity, undefined, 'maxOrderPercentOfEquity')
  }

  check(ctx: GuardContext): string | null {
    return this.evaluate(ctx).reason ?? null
  }

  evaluate(ctx: GuardContext): GuardEvaluation {
    if (ctx.operation.action !== 'placeOrder') return {}

    const { positions, account, operation } = ctx
    const symbol = operation.contract.symbol

    const existing = positions.find(p => p.contract.symbol === symbol)
    const { order } = operation
    const cashQty = parseOptionalPositiveDecimal(order.cashQty, 'cashQty')
    const qty = parseOptionalPositiveDecimal(order.totalQuantity, 'totalQuantity')
    const limitPrice = parseOptionalPositiveDecimal(order.lmtPrice, 'lmtPrice')
    const stopPrice = parseOptionalPositiveDecimal(order.auxPrice, 'auxPrice')
    const invalidOrderField = [cashQty, qty, limitPrice, stopPrice].find(field => field.error != null)
    if (invalidOrderField?.error) {
      return invalidInputResult(symbol, invalidOrderField.error, this.maxPercent, this.maxOrderPercent)
    }
    if (!cashQty.value && !qty.value) {
      return invalidInputResult(
        symbol,
        'the order must provide a finite positive cashQty or totalQuantity',
        this.maxPercent,
        this.maxOrderPercent,
      )
    }

    const orderType = normalizeOrderText(order.orderType)
    const currentValue = existing
      ? parseStateDecimal(existing.marketValue, 'existing marketValue', true)
      : { value: new Decimal(0), error: null }
    if (currentValue.error) {
      return invalidInputResult(symbol, currentValue.error, this.maxPercent, this.maxOrderPercent)
    }

    let addedValue: Decimal
    if (cashQty.value) {
      addedValue = cashQty.value
    } else if (existing) {
      const priceRequirement = missingRequiredPrice(orderType, limitPrice.value, stopPrice.value)
      if (priceRequirement) {
        return invalidInputResult(symbol, priceRequirement, this.maxPercent, this.maxOrderPercent)
      }
      const marketPrice = parseStateDecimal(existing.marketPrice, 'existing marketPrice', false)
      if (marketPrice.error) {
        return invalidInputResult(symbol, marketPrice.error, this.maxPercent, this.maxOrderPercent)
      }
      addedValue = qty.value!.mul(marketPrice.value)
    } else {
      const upperBoundPrice = firstEntryPriceUpperBound(
        normalizeOrderText(order.action),
        orderType,
        limitPrice.value,
        stopPrice.value,
      )
      if (upperBoundPrice == null) {
        return {
          reason:
            `Cannot enforce max position limits for first entry ${symbol}: ` +
            `${normalizeOrderText(order.action) || '<unset>'} ${orderType || '<unset>'} with totalQuantity ` +
            'has no deterministic notional price that is a conservative upper bound. ' +
            'Use cashQty, BUY LMT/STP LMT with valid prices, or SELL STP with a valid stop price.',
          metrics: unavailableMetrics(this.maxPercent, this.maxOrderPercent),
        }
      }
      addedValue = qty.value!.mul(upperBoundPrice)
    }

    if (!addedValue.isFinite() || addedValue.lte(0)) {
      return invalidInputResult(
        symbol,
        'the computed order notional must be finite and positive',
        this.maxPercent,
        this.maxOrderPercent,
      )
    }

    const projectedValue = currentValue.value.plus(addedValue)
    if (!projectedValue.isFinite() || projectedValue.lt(0)) {
      return invalidInputResult(
        symbol,
        'the projected position value must be finite and non-negative',
        this.maxPercent,
        this.maxOrderPercent,
      )
    }

    const netLiq = parseStateDecimal(account.netLiquidation, 'account netLiquidation', false)
    if (netLiq.error) {
      return invalidEquityResult(symbol, account.netLiquidation, this.maxPercent, this.maxOrderPercent)
    }

    const percent = projectedValue.div(netLiq.value).mul(100)
    const orderPercent = addedValue.div(netLiq.value).mul(100)
    if (!percent.isFinite() || !orderPercent.isFinite()) {
      return invalidInputResult(
        symbol,
        'position percentages could not be represented as finite values',
        this.maxPercent,
        this.maxOrderPercent,
      )
    }
    const metrics = {
      positionValuePct: finiteNumberOrNull(percent),
      threshold: this.maxPercent,
      ...(this.maxOrderPercent == null
        ? {}
        : { orderValuePct: finiteNumberOrNull(orderPercent), orderThreshold: this.maxOrderPercent }),
    }

    if (this.maxOrderPercent != null && orderPercent.gt(this.maxOrderPercent)) {
      return {
        reason: `Order for ${symbol} would add ${orderPercent.toFixed(1)}% of equity in a single order (limit: ${this.maxOrderPercent}%)`,
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

function parseCap(value: unknown, fallback: number | undefined, name: string): number {
  let cap: number
  try {
    cap = Number(value ?? fallback)
  } catch {
    throw new Error(`max-position-size guard requires a finite non-negative ${name}`)
  }
  if (!Number.isFinite(cap) || cap < 0) {
    throw new Error(`max-position-size guard requires a finite non-negative ${name}`)
  }
  return cap
}

interface ParsedDecimal {
  readonly value: Decimal | null
  readonly error: string | null
}

function parseOptionalPositiveDecimal(value: unknown, name: string): ParsedDecimal {
  if (value == null) return { value: null, error: null }
  const parsed = parseDecimal(value)
  if (parsed == null) {
    return { value: null, error: `order ${name} is not a valid decimal (${displayValue(value)})` }
  }
  if (parsed.equals(UNSET_DECIMAL)) return { value: null, error: null }
  if (!parsed.isFinite() || parsed.lte(0)) {
    return {
      value: null,
      error: `order ${name} must be finite and positive when set (${displayValue(value)})`,
    }
  }
  return { value: parsed, error: null }
}

function parseStateDecimal(value: unknown, name: string, allowZero: boolean): ParsedDecimal & { value: Decimal } {
  const parsed = parseDecimal(value)
  const invalid = parsed == null || !parsed.isFinite() || (allowZero ? parsed.lt(0) : parsed.lte(0))
  if (invalid) {
    return {
      value: new Decimal(0),
      error: `${name} must be finite and ${allowZero ? 'non-negative' : 'positive'} (${displayValue(value)})`,
    }
  }
  return { value: parsed, error: null }
}

function parseDecimal(value: unknown): Decimal | null {
  try {
    return new Decimal(value as Decimal.Value)
  } catch {
    return null
  }
}

function normalizeOrderText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

function missingRequiredPrice(
  orderType: string,
  limitPrice: Decimal | null,
  stopPrice: Decimal | null,
): string | null {
  if (orderType === 'LMT' && limitPrice == null) return 'LMT orders require a finite positive lmtPrice'
  if (orderType === 'STP' && stopPrice == null) return 'STP orders require a finite positive auxPrice'
  if (orderType === 'STP LMT') {
    if (limitPrice == null) return 'STP LMT orders require a finite positive lmtPrice'
    if (stopPrice == null) return 'STP LMT orders require a finite positive auxPrice'
  }
  return null
}

function firstEntryPriceUpperBound(
  action: string,
  orderType: string,
  limitPrice: Decimal | null,
  stopPrice: Decimal | null,
): Decimal | null {
  if (action === 'BUY' && orderType === 'LMT') return limitPrice
  if (action === 'BUY' && orderType === 'STP LMT' && limitPrice && stopPrice) return limitPrice
  if (action === 'SELL' && orderType === 'STP') return stopPrice
  return null
}

function finiteNumberOrNull(value: Decimal): number | null {
  const number = value.toNumber()
  return Number.isFinite(number) ? number : null
}

function displayValue(value: unknown): string {
  try {
    return `received "${String(value)}"`
  } catch {
    return 'received an unprintable value'
  }
}

function unavailableMetrics(maxPercent: number, maxOrderPercent?: number): Record<string, number | null> {
  return {
    positionValuePct: null,
    threshold: maxPercent,
    ...(maxOrderPercent == null
      ? {}
      : { orderValuePct: null, orderThreshold: maxOrderPercent }),
  }
}

function invalidInputResult(
  symbol: string,
  detail: string,
  maxPercent: number,
  maxOrderPercent?: number,
): GuardEvaluation {
  return {
    reason: `Cannot enforce max position limits for ${symbol}: ${detail}. Correct the order or source state before retrying.`,
    metrics: unavailableMetrics(maxPercent, maxOrderPercent),
  }
}

function invalidEquityResult(
  symbol: string,
  rawNetLiquidation: string,
  maxPercent: number,
  maxOrderPercent?: number,
): GuardEvaluation {
  return {
    reason:
      `Cannot enforce max position limits for ${symbol}: account netLiquidation must be a finite positive value, ` +
      `received "${rawNetLiquidation}". Refresh or restore the account equity state before retrying.`,
    metrics: unavailableMetrics(maxPercent, maxOrderPercent),
  }
}
