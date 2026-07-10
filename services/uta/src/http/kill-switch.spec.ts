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
    const pending = uta.commit('human approved buy')

    const { status, body } = await post(routes, '/uta/mock-paper/wallet/push', {
      expectedHash: pending.hash,
    }, approverHeader())

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
    const { uta, broker, routes, baseDir } = createUTA()
    await uta.waitForConnect()
    const orderId = await placeRestingOrder(broker, 'AAPL')
    uta.stageCancelOrder({ orderId })
    const pending = uta.commit('cancel stale order')

    const { status, body } = await post(routes, '/uta/mock-paper/wallet/push', {
      expectedHash: pending.hash,
    })

    expect(status).toBe(200)
    const commit = uta.show((body as { hash: string }).hash)
    expect(commit?.approver).toMatchObject({
      via: 'loopback',
      at: expect.any(String),
    })
    expect(commit?.approver?.fingerprint).toBeUndefined()
  })
})

describe('POST /uta/:id/wallet/mutation/resolve', () => {
  it('requires an authenticated human and preserves uncertainty in the final audit', async () => {
    const { uta, broker, routes } = createUTA()
    await uta.waitForConnect()
    uta.stageCancelOrder({ orderId: 'unknown-at-venue' })
    const pending = uta.commit('cancel order with ambiguous venue response')

    const pushed = await post(
      routes,
      '/uta/mock-paper/wallet/push',
      { expectedHash: pending.hash },
      approverHeader(),
    )
    expect(pushed.status).toBe(409)
    expect(pushed.body).toMatchObject({
      code: 'MUTATION_RECOVERY_REQUIRED',
      mutation: {
        readiness: 'recovery_required',
        activeAttempt: {
          kind: 'push',
          operations: [expect.objectContaining({ state: 'uncertain' })],
        },
      },
    })
    const attemptId = (pushed.body as {
      mutation: { activeAttempt: { attemptId: string } }
    }).mutation.activeAttempt.attemptId
    expect(broker.callCount('cancelOrder')).toBe(1)

    const retry = await post(routes, '/uta/mock-paper/wallet/push', {}, approverHeader())
    expect(retry.status).toBe(409)
    expect(retry.body).toMatchObject({
      code: 'MUTATION_RECOVERY_REQUIRED',
      mutation: { activeAttempt: { attemptId } },
    })
    expect(broker.callCount('cancelOrder')).toBe(1)

    const anonymous = await post(routes, '/uta/mock-paper/wallet/mutation/resolve', {
      attemptId,
      confirmation: attemptId,
      action: 'acknowledge-uncertainty',
      reason: 'operator checked venue history',
    })
    expect(anonymous.status).toBe(403)

    const staleConfirmation = await post(routes, '/uta/mock-paper/wallet/mutation/resolve', {
      attemptId,
      confirmation: randomUUID(),
      action: 'acknowledge-uncertainty',
      reason: 'operator checked venue history',
    }, approverHeader())
    expect(staleConfirmation.status).toBe(400)
    expect(uta.status().mutation?.readiness).toBe('recovery_required')

    const resolved = await post(routes, '/uta/mock-paper/wallet/mutation/resolve', {
      attemptId,
      confirmation: attemptId,
      action: 'acknowledge-uncertainty',
      reason: 'operator checked venue history',
    }, approverHeader())
    expect(resolved.status).toBe(200)
    expect(resolved.body).toMatchObject({ attemptId, resolved: true, readiness: 'ready' })
    expect(uta.status()).toMatchObject({
      pendingMessage: null,
      pendingHash: null,
      mutation: { readiness: 'ready', downgradeBlocked: false },
    })
    const commit = uta.show((resolved.body as { hash: string }).hash)
    expect(commit?.message).toContain('[resolved:acknowledge-uncertainty]')
    expect(commit?.message).toContain('operator checked venue history')
    expect(commit?.results).toEqual([
      expect.objectContaining({ status: 'uncertain', success: false }),
    ])
    expectAliceApprover(commit?.approver)
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

  it('quarantines after an ambiguous broker cancel failure and does not call later orders', async () => {
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

    expect(status).toBe(409)
    expect(attempted).toEqual(orderIds.slice(0, 2))
    expect(body).toMatchObject({
      riskState: {
        state: 'HALT',
        reason: 'partial cancel failure',
      },
      code: 'MUTATION_RECOVERY_REQUIRED',
      mutation: {
        readiness: 'recovery_required',
        downgradeBlocked: true,
        activeAttempt: {
          kind: 'emergency_cancel',
          operations: [
            expect.objectContaining({ state: 'confirmed' }),
            expect.objectContaining({ state: 'uncertain', error: 'venue cancel exploded' }),
            expect.objectContaining({ state: 'prepared' }),
          ],
        },
      },
    })
    expect(uta.getRiskState().state).toBe('HALT')
    expect(uta.status().pendingHash).toBeNull()
    expect((await broker.getOpenOrders()).map((order) => order.orderId)).toEqual(orderIds.slice(1))
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

  it('quarantines after an ambiguous broker close failure and does not close later positions', async () => {
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

    expect(status).toBe(409)
    expect(attempted).toEqual(['AAPL', 'MSFT'])
    expect(body).toMatchObject({
      code: 'MUTATION_RECOVERY_REQUIRED',
      mutation: {
        readiness: 'recovery_required',
        activeAttempt: {
          kind: 'flatten',
          operations: [
            expect.objectContaining({ state: 'confirmed' }),
            expect.objectContaining({ state: 'uncertain', error: 'venue close exploded' }),
            expect.objectContaining({ state: 'prepared' }),
          ],
        },
      },
    })
    expect(uta.status().pendingHash).toBeNull()
    expect((await broker.getPositions()).map((position) => position.contract.symbol)).toEqual(['MSFT', 'NVDA'])
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
