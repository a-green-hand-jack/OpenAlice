import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Decimal from 'decimal.js'
import { Hono } from 'hono'
import { Order } from '@traderalice/ibkr'
import {
  UTA_INTERNAL_TOKEN_HEADER,
  type BrokerMutationContainmentClass,
} from '@traderalice/uta-protocol'
import type { TradingMode } from '@/core/config.js'
import { UnifiedTradingAccount } from '../domain/trading/UnifiedTradingAccount.js'
import {
  MockBroker,
  makeContract,
  makePosition,
} from '../domain/trading/brokers/mock/index.js'
import type { UTAEngineContext } from '../types.js'
import {
  createUtaInternalAuth,
  UTA_INTERNAL_TOKEN_ENV,
} from './internal-auth.js'
import { createTradingRoutes } from './routes-trading.js'

const INTERNAL_TOKEN = 'readonly-containment-test-token'
const previousToken = process.env[UTA_INTERNAL_TOKEN_ENV]

interface Fixture {
  app: Hono
  broker: MockBroker
  uta: UnifiedTradingAccount
  stateDir: string
}

const fixtures: Fixture[] = []

beforeEach(() => {
  process.env[UTA_INTERNAL_TOKEN_ENV] = INTERNAL_TOKEN
})

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ uta, stateDir }) => {
    await uta.close().catch(() => {})
    await rm(stateDir, { recursive: true, force: true })
  }))
  if (previousToken === undefined) delete process.env[UTA_INTERNAL_TOKEN_ENV]
  else process.env[UTA_INTERNAL_TOKEN_ENV] = previousToken
})

async function createContainedFixture(
  tradingMode: TradingMode = 'readonly',
  containmentClass: BrokerMutationContainmentClass = 'unverified',
): Promise<Fixture> {
  const stateDir = await mkdtemp(join(tmpdir(), 'openalice-readonly-containment-'))
  const broker = new MockBroker({ id: 'mock-unverified', label: 'Mock-backed unverified preset fixture' })
  const uta = new UnifiedTradingAccount(broker, {
    tradingMode,
    containmentClass,
    guardStateBaseDir: stateDir,
    riskStateBaseDir: stateDir,
  })
  await uta.waitForConnect()

  const ctx = {
    utaManager: {
      get: (id: string) => id === uta.id ? uta : undefined,
      listUTAs: () => [],
      resolve: () => [uta],
      getAggregatedEquity: async () => ({}),
      maybeAutoPushPaperCommit: async () => ({ status: 'skipped', reason: 'account_type_not_paper' }),
    },
    fxService: {},
  } as unknown as UTAEngineContext

  const app = new Hono()
  const auth = createUtaInternalAuth()
  app.use('/api/trading', auth)
  app.use('/api/trading/*', auth)
  app.route('/api/trading', createTradingRoutes(ctx))

  const fixture = { app, broker, uta, stateDir }
  fixtures.push(fixture)
  return fixture
}

async function post(app: Hono, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [UTA_INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN,
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  }
}

function expectContainmentError(body: unknown): void {
  expect(body).toMatchObject({
    error: expect.stringContaining('UTA trading mode is'),
  })
}

describe('direct authenticated UTA readonly containment', () => {
  it.each(['readonly', 'lite'] as const)(
    'blocks normal push in %s mode before broker dispatch',
    async (tradingMode) => {
      const { app, broker, uta } = await createContainedFixture(tradingMode)
      uta.stagePlaceOrder({
        aliceId: `${uta.id}|AAPL`,
        action: 'BUY',
        orderType: 'MKT',
        totalQuantity: '1',
      })
      const pending = uta.commit('direct internal-token push must be contained')
      broker.resetCalls()

      const result = await post(app, `/api/trading/uta/${uta.id}/wallet/push`, {
        expectedHash: pending.hash,
      })

      expect(result.status).toBe(403)
      expectContainmentError(result.body)
      expect(uta.readOnly).toBe(false)
      expect(uta.tradingMode).toBe(tradingMode)
      expect(uta.containmentClass).toBe('unverified')
      expect(broker.callCount('placeOrder')).toBe(0)
      expect(uta.status().pendingHash).toBe(pending.hash)
    },
  )

  it('blocks place, modify, close, and cancel through outer UTA.push', async () => {
    const stages: Array<{
      action: string
      brokerMethod: 'placeOrder' | 'modifyOrder' | 'closePosition' | 'cancelOrder'
      stage: (uta: UnifiedTradingAccount) => void
    }> = [
      {
        action: 'place',
        brokerMethod: 'placeOrder',
        stage: (uta) => { uta.stagePlaceOrder({ aliceId: `${uta.id}|AAPL`, action: 'BUY', orderType: 'MKT', totalQuantity: '1' }) },
      },
      {
        action: 'modify',
        brokerMethod: 'modifyOrder',
        stage: (uta) => { uta.stageModifyOrder({ orderId: 'order-1', lmtPrice: '101' }) },
      },
      {
        action: 'close',
        brokerMethod: 'closePosition',
        stage: (uta) => { uta.stageClosePosition({ aliceId: `${uta.id}|AAPL`, qty: '1' }) },
      },
      {
        action: 'cancel',
        brokerMethod: 'cancelOrder',
        stage: (uta) => { uta.stageCancelOrder({ orderId: 'order-1' }) },
      },
    ]

    for (const scenario of stages) {
      const { app, broker, uta } = await createContainedFixture()
      scenario.stage(uta)
      const pending = uta.commit(`contained ${scenario.action}`)
      broker.resetCalls()

      const result = await post(app, `/api/trading/uta/${uta.id}/wallet/push`, {
        expectedHash: pending.hash,
      })

      expect(result.status).toBe(403)
      expectContainmentError(result.body)
      expect(broker.callCount(scenario.brokerMethod)).toBe(0)
    }
  })

  it('blocks place, modify, close, and cancel when TradingGit.push bypasses outer UTA.push', async () => {
    const stages: Array<{
      brokerMethod: 'placeOrder' | 'modifyOrder' | 'closePosition' | 'cancelOrder'
      stage: (uta: UnifiedTradingAccount) => void
    }> = [
      {
        brokerMethod: 'placeOrder',
        stage: (uta) => { uta.stagePlaceOrder({ aliceId: `${uta.id}|AAPL`, action: 'BUY', orderType: 'MKT', totalQuantity: '1' }) },
      },
      {
        brokerMethod: 'modifyOrder',
        stage: (uta) => { uta.stageModifyOrder({ orderId: 'order-1', lmtPrice: '101' }) },
      },
      {
        brokerMethod: 'closePosition',
        stage: (uta) => { uta.stageClosePosition({ aliceId: `${uta.id}|AAPL`, qty: '1' }) },
      },
      {
        brokerMethod: 'cancelOrder',
        stage: (uta) => { uta.stageCancelOrder({ orderId: 'order-1' }) },
      },
    ]

    for (const scenario of stages) {
      const { broker, uta } = await createContainedFixture()
      scenario.stage(uta)
      uta.commit(`dispatcher bypass ${scenario.brokerMethod}`)
      broker.resetCalls()

      const result = await uta.git.push()

      expect(result.submitted).toHaveLength(0)
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0]?.error).toContain('UTA trading mode is readonly')
      expect(broker.callCount(scenario.brokerMethod)).toBe(0)
    }
  })

  it('maps a direct one-shot order denial to 403 without broker execution', async () => {
    const { app, broker, uta } = await createContainedFixture()
    broker.resetCalls()

    const result = await post(app, `/api/trading/uta/${uta.id}/wallet/place-order`, {
      aliceId: `${uta.id}|AAPL`,
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
      message: 'contained one-shot order',
    })

    expect(result.status).toBe(403)
    expectContainmentError(result.body)
    expect(result.body).toMatchObject({ phase: 'push' })
    expect(broker.callCount('placeOrder')).toBe(0)
  })

  it('blocks emergency cancel before broker calls or a local HALT transition', async () => {
    const { app, broker, uta } = await createContainedFixture()
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'LMT'
    order.totalQuantity = new Decimal(1)
    order.lmtPrice = new Decimal(1)
    await broker.placeOrder(makeContract({ symbol: 'AAPL' }), order)
    broker.resetCalls()

    const result = await post(app, `/api/trading/uta/${uta.id}/emergency-stop`, {
      reason: 'contain direct emergency cancellation',
      cancelOrders: true,
    })

    expect(result.status).toBe(403)
    expectContainmentError(result.body)
    expect(broker.callCount('cancelOrder')).toBe(0)
    expect(uta.getRiskState().state).toBe('NORMAL')
  })

  it('allows emergency-stop without cancellation because local HALT only tightens risk', async () => {
    const { app, broker, uta } = await createContainedFixture()
    broker.resetCalls()

    const result = await post(app, `/api/trading/uta/${uta.id}/emergency-stop`, {
      reason: 'tighten risk without touching the broker',
      cancelOrders: false,
    })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      riskState: { state: 'HALT', reason: 'tighten risk without touching the broker' },
      cancelResults: [],
    })
    expect(broker.callCount('cancelOrder')).toBe(0)
    expect(broker.callCount('closePosition')).toBe(0)
    expect(uta.getRiskState().state).toBe('HALT')
  })

  it('blocks flatten before any broker position close', async () => {
    const { app, broker, uta } = await createContainedFixture()
    broker.setPositions([
      makePosition({
        contract: makeContract({ symbol: 'AAPL', aliceId: `${uta.id}|AAPL` }),
        quantity: new Decimal(10),
      }),
    ])
    broker.resetCalls()

    const result = await post(app, `/api/trading/uta/${uta.id}/flatten`, { confirm: 'FLATTEN' })

    expect(result.status).toBe(403)
    expectContainmentError(result.body)
    expect(broker.callCount('closePosition')).toBe(0)
    expect(await broker.getPositions()).toHaveLength(1)
  })
})
