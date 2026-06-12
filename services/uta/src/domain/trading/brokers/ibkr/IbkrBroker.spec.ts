import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import { IbkrBroker } from './IbkrBroker.js'

/**
 * The gate must fire BEFORE any bridge/client access, so it is testable on
 * a bare prototype instance — no TWS connection, no bridge construction.
 */
function bareBroker(): IbkrBroker {
  return Object.create(IbkrBroker.prototype) as IbkrBroker
}

function stkOrder(): { contract: Contract; order: Order } {
  const contract = new Contract()
  contract.symbol = 'AAPL'
  contract.secType = 'STK'
  contract.exchange = 'SMART'
  contract.currency = 'USD'
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'LMT'
  order.totalQuantity = new Decimal(1)
  order.lmtPrice = new Decimal(100)
  return { contract, order }
}

describe('IbkrBroker — attached TP/SL refusal gate', () => {
  // Guards the silent naked-entry failure: the tpsl param used to be
  // `_tpsl` (ignored) — the ledger recorded protection TWS never received.
  it('refuses placeOrder with takeProfit', async () => {
    const { contract, order } = stkOrder()
    const result = await bareBroker().placeOrder(contract, order, { takeProfit: { price: '120' } })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/TP\/SL.*not implemented|refusing/i)
  })

  it('refuses placeOrder with stopLoss', async () => {
    const { contract, order } = stkOrder()
    const result = await bareBroker().placeOrder(contract, order, { stopLoss: { price: '90' } })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/refusing/i)
  })

  it('an empty tpsl object does not trip the gate', async () => {
    const { contract, order } = stkOrder()
    // No bridge on the bare instance — passing the gate means it throws on
    // bridge access, NOT a refusal result.
    await expect(async () => {
      const r = await bareBroker().placeOrder(contract, order, {})
      if (r.success === false && /refusing/i.test(r.error ?? '')) throw new Error('gate tripped')
      return r
    }).not.toThrow(/gate tripped/)
  })
})

describe('IbkrBroker — nativeKey grammar (hub/leaf identity)', () => {
  // conId = canonical leaf; issuer: = bond-issuer directory; bare symbol =
  // STK convenience. Hubs must REFUSE resolution (directories aren't
  // tradeable) instead of the old silent assume-STK.
  it('getNativeKey prefers conId, falls back to issuer: for bond hubs, then symbol', () => {
    const b = bareBroker()

    const leaf = new Contract()
    leaf.conId = 265598
    leaf.symbol = 'AAPL'
    expect(b.getNativeKey(leaf)).toBe('265598')

    const bondHub = new Contract()
    bondHub.secType = 'BOND'
    bondHub.issuerId = 'e1400789'
    expect(b.getNativeKey(bondHub)).toBe('issuer:e1400789')

    const symbolOnly = new Contract()
    symbolOnly.symbol = 'AAPL'
    expect(b.getNativeKey(symbolOnly)).toBe('AAPL')
  })

  it('resolveNativeKey refuses issuer: directories with an actionable message', () => {
    const b = bareBroker()
    expect(() => b.resolveNativeKey('issuer:e1400789')).toThrow(/directory.*expand|expand.*directory/i)
  })

  it('resolveNativeKey round-trips conId and keeps the STK symbol convenience', () => {
    const b = bareBroker()
    expect(b.resolveNativeKey('265598').conId).toBe(265598)
    const sym = b.resolveNativeKey('AAPL')
    expect(sym.symbol).toBe('AAPL')
    expect(sym.secType).toBe('STK')
  })
})
