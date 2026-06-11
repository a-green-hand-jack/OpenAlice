import { describe, it, expect, vi } from 'vitest'
import { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import { MockBroker } from './brokers/mock/index.js'
import './contract-ext.js'
import { startOrderSyncPoller } from './order-sync-poller.js'

function createUTA() {
  const broker = new MockBroker()
  const uta = new UnifiedTradingAccount(broker)
  return { uta, broker }
}

async function placePendingLimitBuy(uta: UnifiedTradingAccount): Promise<string> {
  uta.stagePlaceOrder({
    aliceId: 'mock-paper|AAPL', symbol: 'AAPL',
    action: 'BUY', orderType: 'LMT', totalQuantity: '10', lmtPrice: '150',
  })
  uta.commit('limit buy')
  const pushResult = await uta.push()
  const orderId = pushResult.submitted[0]?.orderId
  expect(orderId).toBeDefined()
  return orderId!
}

describe('order-sync poller', () => {
  it('full lifecycle: push → pending → price crosses limit → poller records the fill in git', async () => {
    const { uta, broker } = createUTA()
    const poller = startOrderSyncPoller(() => [uta], { intervalMs: 60_000, log: () => {} })

    const orderId = await placePendingLimitBuy(uta)

    // Order still working — a tick must not invent a transition.
    await poller.tick()
    expect(uta.getPendingOrderIds()).toHaveLength(1)

    // Market comes to the order (auto-match fills at the crossed price).
    broker.setMarkPrice('AAPL', '149')

    await poller.tick()
    poller.stop()

    // Fill recorded as a sync commit, with execution data.
    expect(uta.getPendingOrderIds()).toHaveLength(0)
    const log = uta.log({ limit: 1 })
    expect(log[0].message).toContain('[sync]')
    expect(log[0].operations[0].status).toBe('filled')

    const head = uta.show(log[0].hash)!
    expect(head.results[0].orderId).toBe(orderId)
    expect(head.results[0].filledQty).toBe('10')
    expect(head.results[0].filledPrice).toBe('149')
  })

  it('skips keyless and unhealthy accounts, and accounts with no pending orders', async () => {
    const { uta } = createUTA()
    const syncSpy = vi.spyOn(uta, 'sync')

    const poller = startOrderSyncPoller(() => [uta], { intervalMs: 60_000, log: () => {} })
    await poller.tick() // no pending orders → no sync call
    expect(syncSpy).not.toHaveBeenCalled()

    await placePendingLimitBuy(uta)
    await poller.tick() // pending → sync called (even if no transition yet)
    expect(syncSpy).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('one account failing does not stop the others', async () => {
    const a = createUTA()
    const b = createUTA()
    await placePendingLimitBuy(a.uta)
    await placePendingLimitBuy(b.uta)
    vi.spyOn(a.uta, 'sync').mockRejectedValue(new Error('exchange down'))
    const bSync = vi.spyOn(b.uta, 'sync')

    const logs: string[] = []
    const poller = startOrderSyncPoller(() => [a.uta, b.uta], { intervalMs: 60_000, log: (m) => logs.push(m) })
    await poller.tick()
    poller.stop()

    expect(bSync).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes('sync failed') && l.includes('exchange down'))).toBe(true)
  })
})
