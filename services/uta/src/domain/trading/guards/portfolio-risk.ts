import Decimal from 'decimal.js'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import type { GuardContext } from './types.js'
import type { Position } from '../brokers/types.js'

export type RiskDirection = 'reducing' | 'increasing' | 'unestimable'

export interface InstrumentExposureEstimate {
  symbol: string
  currentValue: Decimal
  projectedValue: Decimal | null
  orderValue: Decimal | null
  direction: RiskDirection
}

export function isClearlyRiskReducing(ctx: GuardContext): boolean {
  const { operation } = ctx
  if (operation.action === 'closePosition' || operation.action === 'cancelOrder') return true
  if (operation.action !== 'placeOrder') return false
  return estimateInstrumentExposure(ctx).direction === 'reducing'
}

export function estimateInstrumentExposure(ctx: GuardContext): InstrumentExposureEstimate {
  const { operation, positions } = ctx
  if (operation.action !== 'placeOrder') {
    return {
      symbol: 'unknown',
      currentValue: new Decimal(0),
      projectedValue: null,
      orderValue: null,
      direction: 'unestimable',
    }
  }

  const symbol = operation.contract.symbol || operation.contract.aliceId || 'unknown'
  const existing = positions.find(p => p.contract.symbol === symbol)
  const currentValue = absDecimal(existing?.marketValue ?? '0')

  const orderValue = estimateOrderValue(ctx, existing)
  if (!orderValue || orderValue.lte(0)) {
    return {
      symbol,
      currentValue,
      projectedValue: null,
      orderValue: null,
      direction: 'unestimable',
    }
  }

  const action = operation.order.action.toUpperCase()
  if (!existing) {
    return {
      symbol,
      currentValue,
      projectedValue: orderValue,
      orderValue,
      direction: 'increasing',
    }
  }

  const reducingLong = existing.side === 'long' && action === 'SELL'
  const reducingShort = existing.side === 'short' && action === 'BUY'
  if (reducingLong || reducingShort) {
    if (orderValue.lte(currentValue)) {
      return {
        symbol,
        currentValue,
        projectedValue: currentValue.minus(orderValue),
        orderValue,
        direction: 'reducing',
      }
    }

    return {
      symbol,
      currentValue,
      projectedValue: orderValue.minus(currentValue),
      orderValue,
      direction: 'increasing',
    }
  }

  return {
    symbol,
    currentValue,
    projectedValue: currentValue.plus(orderValue),
    orderValue,
    direction: 'increasing',
  }
}

function estimateOrderValue(ctx: GuardContext, existing: Position | undefined): Decimal | null {
  if (ctx.operation.action !== 'placeOrder') return null
  const { order } = ctx.operation

  const cashQty = decimalField(order.cashQty)
  if (cashQty) return cashQty

  const qty = decimalField(order.totalQuantity)
  if (qty && existing) {
    // Mirrors MaxPositionSizeGuard's qty-based estimate: quantity × existing
    // marketPrice.
    return qty.mul(existing.marketPrice)
  }
  if (qty) {
    const orderType = order.orderType.toUpperCase()
    const limitPrice = decimalField(order.lmtPrice)
    if (limitPrice && orderType.includes('LMT')) return qty.mul(limitPrice)

    const stopPrice = decimalField(order.auxPrice)
    if (stopPrice && orderType === 'STP') return qty.mul(stopPrice)

    // Documented gap: MKT quantity orders for new symbols need quote-aware
    // valuation, which is tracked in issue #26. They remain
    // unestimable and pass through until then.
  }

  return null
}

function decimalField(value: Decimal | undefined): Decimal | null {
  if (!value || value.equals(UNSET_DECIMAL) || value.lte(0)) return null
  return value
}

function absDecimal(value: Decimal.Value): Decimal {
  const d = new Decimal(value)
  return d.abs()
}
