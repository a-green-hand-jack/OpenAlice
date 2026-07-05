import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach, vi } from 'vitest'
import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import { createTradingRoutes } from './routes-trading.js'
import type { UTAEngineContext } from '../types.js'
import { UnifiedTradingAccount } from '../domain/trading/UnifiedTradingAccount.js'
import { MockBroker, makeContract, makePosition } from '../domain/trading/brokers/mock/index.js'
import { riskStatePath } from '../domain/trading/risk-state.js'
import type { ApproverIdentity } from '@traderalice/uta-protocol'

let tempDirs: string[] = []

function makeTempDir(): string {
  const dir = join(tmpdir(), `openalice-kill-switch-spec-${randomUUID()}`)
  tempDirs.push(dir)
  return dir
}

function createUTA(id = 'mock-paper'): { uta: UnifiedTradingAccount; broker: MockBroker; routes: ReturnType<typeof createTradingRoutes>; baseDir: string } {
  const baseDir = makeTempDir()
  const broker = new MockBroker({ id })
  const uta = new UnifiedTradingAccount(broker, {
    guardStateBaseDir: baseDir,
    riskStateBaseDir: baseDir,
  })
  const ctx = {
    utaManager: {
      get: (queryId: string) => (queryId === uta.id ? uta : undefined),
      listUTAs: () => [{
        id: uta.id,
        label: uta.label,
        capabilities: uta.getCapabilities(),
        health: uta.getHealthInfo(),
      }],
      resolve: () => [uta],
      getAggregatedEquity: vi.fn(),
    },
    fxService: {},
    snapshotService: undefined,
  } as unknown as UTAEngineContext
  return { uta, broker, routes: createTradingRoutes(ctx), baseDir }
}

async function post(
  routes: ReturnType<typeof createTradingRoutes>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await routes.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

const APPROVER_HEADER = 'X-OpenAlice-Approver'
const APPROVER_FINGERPRINT = 'fp-admin-session'
const RAW_ADMIN_TOKEN = 'raw-admin-token-never-persist'

function approverHeader(fingerprint = APPROVER_FINGERPRINT): Record<string, string> {
  return {
    [APPROVER_HEADER]: JSON.stringify({ via: 'alice-bff', fingerprint }),
  }
}

function expectAliceApprover(value: ApproverIdentity | undefined, fingerprint = APPROVER_FINGERPRINT): void {
  expect(value).toMatchObject({
    via: 'alice-bff',
    fingerprint,
    at: expect.any(String),
  })
}

async function placeRestingOrder(broker: MockBroker, symbol = 'AAPL'): Promise<string> {
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'LMT'
  order.totalQuantity = new Decimal(1)
  order.lmtPrice = new Decimal(1)
  const result = await broker.placeOrder(makeContract({ symbol, aliceId: `${broker.id}|${symbol}` }), order)
  if (!result.orderId) throw new Error('mock broker did not return orderId')
  return result.orderId
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('POST /uta/:id/wallet/push approver identity', () => {
  it('persists approver identity on a mock account and survives account rebuild', async () => {
    const { uta, routes, baseDir } = createUTA()
    await uta.waitForConnect()
    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      symbol: 'AAPL',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
    })
    uta.commit('human approved buy')

    const { status, body } = await post(routes, '/uta/mock-paper/wallet/push', {}, approverHeader())

    expect(status).toBe(200)
    const hash = (body as { hash: string }).hash
    expectAliceApprover(uta.show(hash)?.approver)
    const persisted = JSON.stringify(uta.exportGitState())
    expect(persisted).toContain(APPROVER_FINGERPRINT)
    expect(persisted).not.toContain(RAW_ADMIN_TOKEN)

    const savedState = JSON.parse(JSON.stringify(uta.exportGitState()))
    const restored = new UnifiedTradingAccount(new MockBroker({ id: 'mock-paper' }), {
      savedState,
      guardStateBaseDir: baseDir,
      riskStateBaseDir: baseDir,
    })
    expectAliceApprover(restored.show(hash)?.approver)
  })

  it('records loopback when UTA receives push without an Alice approver descriptor', async () => {
    const { uta, routes, baseDir } = createUTA()
    await uta.waitForConnect()
    uta.stageCancelOrder({ orderId: 'order-to-cancel' })
    uta.commit('cancel stale order')

    const { status, body } = await post(routes, '/uta/mock-paper/wallet/push', {})

    expect(status).toBe(200)
    const commit = uta.show((body as { hash: string }).hash)
    expect(commit?.approver).toMatchObject({
      via: 'loopback',
      at: expect.any(String),
    })
    expect(commit?.approver?.fingerprint).toBeUndefined()
  })
})

describe('POST /uta/:id/emergency-stop', () => {
  it.each(['NORMAL', 'CAUTIOUS', 'READ_ONLY'] as const)('sets HALT, records history, and broker-cancels all open orders from %s', async (priorState) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { uta, broker, routes } = createUTA()
    await uta.waitForConnect()
    if (priorState !== 'NORMAL') await uta.setRiskState(priorState, `${priorState} before emergency`)
    const orderId = await placeRestingOrder(broker)

    const { status, body } = await post(routes, '/uta/mock-paper/emergency-stop', {
      reason: 'human saw runaway orders',
    }, approverHeader())

    expect(status).toBe(200)
    expect(body).toMatchObject({
      riskState: {
        state: 'HALT',
        reason: 'human saw runaway orders',
      },
      cancelResults: [{
        orderId,
        success: true,
        status: 'Cancelled',
      }],
    })
    expect(uta.getRiskState().history.at(-1)).toMatchObject({
      from: priorState,
      to: 'HALT',
      by: 'human',
      reason: 'human saw runaway orders',
    })
    expectAliceApprover(uta.getRiskState().history.at(-1)?.triggerIdentity)
    expect(await broker.getOpenOrders()).toHaveLength(0)

    const hash = (body as { hash: string }).hash
    const commit = uta.show(hash)
    expect(commit).toMatchObject({
      message: expect.stringContaining('[emergency-stop]'),
      operations: [{ action: 'emergencyCancelOrder', orderId }],
      results: [{ action: 'emergencyCancelOrder', orderId, success: true, status: 'cancelled' }],
    })
    expectAliceApprover(commit?.approver)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMERGENCY STOP'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[emergency-stop] audit'))
  })

  it('is idempotent-ish: a second HALT call records another human transition and cancels newly-open broker orders', async () => {
    const { uta, broker, routes } = createUTA()
    await uta.waitForConnect()
    await placeRestingOrder(broker, 'AAPL')
    const first = await post(routes, '/uta/mock-paper/emergency-stop', { reason: 'first stop' })
    expect(first.status).toBe(200)
    expect(await broker.getOpenOrders()).toHaveLength(0)

    const newOrderId = await placeRestingOrder(broker, 'MSFT')
    const second = await post(routes, '/uta/mock-paper/emergency-stop', { reason: 'second stop' })

    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({
      riskState: { state: 'HALT', reason: 'second stop' },
      cancelResults: [{ orderId: newOrderId, success: true, status: 'Cancelled' }],
    })
    expect(uta.getRiskState().history.at(-1)).toMatchObject({
      from: 'HALT',
      to: 'HALT',
      by: 'human',
      reason: 'second stop',
    })
    expect(await broker.getOpenOrders()).toHaveLength(0)
    expect(uta.log({ limit: 2 }).map((entry) => entry.message)).toEqual([
      expect.stringContaining('[emergency-stop]'),
      expect.stringContaining('[emergency-stop]'),
    ])
  })

  it('continues after one broker cancel failure and keeps the failed order pending', async () => {
    const { uta, broker, routes } = createUTA()
    await uta.waitForConnect()
    const orderIds = [
      await placeRestingOrder(broker, 'AAPL'),
      await placeRestingOrder(broker, 'MSFT'),
      await placeRestingOrder(broker, 'NVDA'),
    ]
    const attempted: string[] = []
    const cancelOrder = broker.cancelOrder.bind(broker)
    vi.spyOn(broker, 'cancelOrder').mockImplementation(async (orderId: string) => {
      attempted.push(orderId)
      if (orderId === orderIds[1]) throw new Error('venue cancel exploded')
      return cancelOrder(orderId)
    })

    const { status, body } = await post(routes, '/uta/mock-paper/emergency-stop', {
      reason: 'partial cancel failure',
    })

    expect(status).toBe(200)
    expect(attempted).toEqual(orderIds)
    expect(body).toMatchObject({
      riskState: {
        state: 'HALT',
        reason: 'partial cancel failure',
      },
      cancelResults: [
        { orderId: orderIds[0], success: true, status: 'Cancelled' },
        { orderId: orderIds[1], success: false, status: 'Rejected', error: 'venue cancel exploded' },
        { orderId: orderIds[2], success: true, status: 'Cancelled' },
      ],
    })
    expect(uta.getRiskState().state).toBe('HALT')

    const hash = (body as { hash: string }).hash
    const commit = uta.show(hash)
    expect(commit?.message).toContain('[emergency-stop] HALT; cancelled 2/3 open order(s)')
    expect(commit?.results.filter((result) => result.success)).toHaveLength(2)
    expect(commit?.results.filter((result) => !result.success)).toEqual([
      expect.objectContaining({
        action: 'emergencyCancelOrder',
        orderId: orderIds[1],
        success: false,
        status: 'submitted',
        error: 'venue cancel exploded',
      }),
    ])
    expect(uta.getPendingOrderIds().map((order) => order.orderId)).toContain(orderIds[1])
  })
})

describe('POST /uta/:id/flatten', () => {
  it('refuses without the exact confirmation token', async () => {
    const { broker, routes } = createUTA()
    broker.setPositions([
      makePosition({ contract: makeContract({ symbol: 'AAPL' }), quantity: new Decimal(10) }),
    ])

    expect((await post(routes, '/uta/mock-paper/flatten', {})).status).toBe(400)
    expect((await post(routes, '/uta/mock-paper/flatten', { confirm: 'flatten' })).status).toBe(400)
    expect(await broker.getPositions()).toHaveLength(1)
  })

  it('closes all open positions at broker level and records a flatten commit', async () => {
    const { uta, broker, routes } = createUTA()
    await uta.waitForConnect()
    broker.setPositions([
      makePosition({ contract: makeContract({ symbol: 'AAPL', aliceId: 'mock-paper|AAPL' }), quantity: new Decimal(10) }),
      makePosition({ contract: makeContract({ symbol: 'MSFT', aliceId: 'mock-paper|MSFT' }), quantity: new Decimal(2) }),
    ])

    const { status, body } = await post(routes, '/uta/mock-paper/flatten', { confirm: 'FLATTEN' }, approverHeader())

    expect(status).toBe(200)
    expect(body).toMatchObject({
      results: [
        { symbol: 'AAPL', quantity: '10', success: true, status: 'Filled' },
        { symbol: 'MSFT', quantity: '2', success: true, status: 'Filled' },
      ],
    })
    expect(await broker.getPositions()).toHaveLength(0)
    const hash = (body as { hash: string }).hash
    const commit = uta.show(hash)
    expect(commit).toMatchObject({
      message: expect.stringContaining('[flatten]'),
      operations: [
        { action: 'emergencyClosePosition' },
        { action: 'emergencyClosePosition' },
      ],
      results: [
        { action: 'emergencyClosePosition', success: true, status: 'filled' },
        { action: 'emergencyClosePosition', success: true, status: 'filled' },
      ],
    })
    expectAliceApprover(commit?.approver)
  })

  it('bypasses the HALT pipeline wall: normal close-position is refused, flatten succeeds', async () => {
    const { uta, broker, routes } = createUTA()
    await uta.waitForConnect()
    broker.setPositions([
      makePosition({ contract: makeContract({ symbol: 'AAPL', aliceId: 'mock-paper|AAPL' }), quantity: new Decimal(10) }),
    ])
    await uta.setRiskState('HALT', 'halted before flatten')

    const oneShot = await post(routes, '/uta/mock-paper/wallet/close-position', {
      aliceId: 'mock-paper|AAPL',
      message: 'normal close should remain walled off',
    })
    expect(oneShot.status).toBe(400)
    expect(oneShot.body).toMatchObject({ phase: 'stage' })
    expect((oneShot.body as { error: string }).error).toContain('risk state HALT')

    const flattened = await post(routes, '/uta/mock-paper/flatten', { confirm: 'FLATTEN' })
    expect(flattened.status).toBe(200)
    expect(flattened.body).toMatchObject({
      results: [{ symbol: 'AAPL', success: true, status: 'Filled' }],
    })
    expect(await broker.getPositions()).toHaveLength(0)
    expect(uta.getRiskState().state).toBe('HALT')
  })

  it('continues after one broker close failure when flattening positions', async () => {
    const { uta, broker, routes } = createUTA()
    await uta.waitForConnect()
    broker.setPositions([
      makePosition({ contract: makeContract({ symbol: 'AAPL', aliceId: 'mock-paper|AAPL' }), quantity: new Decimal(10) }),
      makePosition({ contract: makeContract({ symbol: 'MSFT', aliceId: 'mock-paper|MSFT' }), quantity: new Decimal(2) }),
      makePosition({ contract: makeContract({ symbol: 'NVDA', aliceId: 'mock-paper|NVDA' }), quantity: new Decimal(3) }),
    ])
    const attempted: string[] = []
    const closePosition = broker.closePosition.bind(broker)
    vi.spyOn(broker, 'closePosition').mockImplementation(async (contract, quantity) => {
      attempted.push(contract.symbol)
      if (contract.symbol === 'MSFT') throw new Error('venue close exploded')
      return closePosition(contract, quantity)
    })

    const { status, body } = await post(routes, '/uta/mock-paper/flatten', { confirm: 'FLATTEN' })

    expect(status).toBe(200)
    expect(attempted).toEqual(['AAPL', 'MSFT', 'NVDA'])
    expect(body).toMatchObject({
      results: [
        { symbol: 'AAPL', quantity: '10', success: true, status: 'Filled' },
        { symbol: 'MSFT', quantity: '2', success: false, status: 'Rejected', error: 'venue close exploded' },
        { symbol: 'NVDA', quantity: '3', success: true, status: 'Filled' },
      ],
    })

    const hash = (body as { hash: string }).hash
    const commit = uta.show(hash)
    expect(commit?.message).toContain('[flatten] closed 2/3 open position(s)')
    expect(commit?.results.filter((result) => result.success)).toHaveLength(2)
    expect(commit?.results.filter((result) => !result.success)).toEqual([
      expect.objectContaining({
        action: 'emergencyClosePosition',
        success: false,
        status: 'rejected',
        error: 'venue close exploded',
      }),
    ])
    expect((await broker.getPositions()).map((position) => position.contract.symbol)).toEqual(['MSFT'])
  })
})

describe('HALT recovery', () => {
  it('recovers from HALT through the existing risk-state route without accepting HALT as a target', async () => {
    const { uta, routes, baseDir } = createUTA()
    await uta.waitForConnect()
    const stopped = await post(routes, '/uta/mock-paper/emergency-stop', { reason: 'manual stop', cancelOrders: false })
    expect(stopped.status).toBe(200)
    expect(uta.getRiskState().state).toBe('HALT')

    const recovered = await post(routes, '/uta/mock-paper/risk-state', {
      state: 'NORMAL',
      reason: 'human reviewed halted account',
    }, approverHeader())
    expect(recovered.status).toBe(200)
    expect(recovered.body).toMatchObject({ riskState: { state: 'NORMAL' } })
    expect(uta.getRiskState().history.at(-1)).toMatchObject({
      from: 'HALT',
      to: 'NORMAL',
      by: 'human',
      reason: 'human reviewed halted account',
    })
    expectAliceApprover(uta.getRiskState().history.at(-1)?.triggerIdentity)
    const riskStateFile = await readFile(riskStatePath('mock-paper', { baseDir }), 'utf-8')
    expect(riskStateFile).toContain(APPROVER_FINGERPRINT)
    expect(riskStateFile).not.toContain(RAW_ADMIN_TOKEN)

    const invalid = await post(routes, '/uta/mock-paper/risk-state', { state: 'HALT' })
    expect(invalid.status).toBe(400)
    expect(uta.getRiskState().state).toBe('NORMAL')
  })
})
