import Decimal from 'decimal.js'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import type { OperationGuard, GuardContext, GuardEvaluation } from './types.js'

const DEFAULT_MAX_PERCENT = 25

export class MaxPositionSizeGuard implements OperationGuard {
  readonly name = 'max-position-size'
  private maxPercent: number
  // Single-order cap (docs/steward-p3-campaign.zh.md §4.7 hard guards): a
  // separate, optional ceiling on how much equity ONE order may add, checked
  // independently of the aggregate post-fill position cap below — a single
  // outsized paper order can breach this even while the resulting position
  // stays under maxPercentOfEquity (e.g. a large order into a previously
  // small/empty position).
  private maxOrderPercent?: number

  constructor(options: Record<string, unknown>) {
    this.maxPercent = Number(options.maxPercentOfEquity ?? DEFAULT_MAX_PERCENT)
    this.maxOrderPercent = options.maxOrderPercentOfEquity == null
      ? undefined
      : Number(options.maxOrderPercentOfEquity)
  }

  check(ctx: GuardContext): string | null {
    return this.evaluate(ctx).reason ?? null
  }

  evaluate(ctx: GuardContext): GuardEvaluation {
    if (ctx.operation.action !== 'placeOrder') return {}

    const { positions, account, operation } = ctx
    const symbol = operation.contract.symbol

    const existing = positions.find(p => p.contract.symbol === symbol)
    const currentValue = new Decimal(existing?.marketValue ?? '0')

    // Estimate added value from IBKR Order fields
    const { order } = operation
    const cashQty = !order.cashQty.equals(UNSET_DECIMAL) ? order.cashQty : undefined
    const qty = !order.totalQuantity.equals(UNSET_DECIMAL) ? order.totalQuantity : undefined

    let addedValue = new Decimal(0)
    if (cashQty && cashQty.gt(0)) {
      addedValue = cashQty
    } else if (qty && existing) {
      addedValue = qty.mul(existing.marketPrice)
    }
    // If we can't estimate (new symbol + qty-based without existing position), allow — broker will validate

    if (addedValue.isZero()) return {}

    const projectedValue = currentValue.plus(addedValue)
    const netLiq = new Decimal(account.netLiquidation)
    const percent = netLiq.gt(0) ? projectedValue.div(netLiq).mul(100) : new Decimal(0)
    const orderPercent = netLiq.gt(0) ? addedValue.div(netLiq).mul(100) : new Decimal(0)
    const metrics = {
      positionValuePct: percent.toNumber(),
      threshold: this.maxPercent,
      ...(this.maxOrderPercent == null
        ? {}
        : { orderValuePct: orderPercent.toNumber(), orderThreshold: this.maxOrderPercent }),
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
