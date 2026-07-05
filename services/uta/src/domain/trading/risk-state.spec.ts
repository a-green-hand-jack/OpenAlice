import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach, vi } from 'vitest'
import Decimal from 'decimal.js'
import { UnifiedTradingAccount, type UnifiedTradingAccountOptions } from './UnifiedTradingAccount.js'
import { MockBroker, makeContract, makePosition } from './brokers/mock/index.js'
import { createRiskStateStore, riskStatePath } from './risk-state.js'
import { portfolioGuardStatePath } from './guards/portfolio-state.js'
import { createTradingRoutes } from '../../http/routes-trading.js'
import type { UTAEngineContext } from '../../types.js'

let tempDirs: string[] = []

function makeTempDir(): string {
  const dir = join(tmpdir(), `openalice-risk-state-spec-${randomUUID()}`)
  tempDirs.push(dir)
  return dir
}

function createUTA(
  broker = new MockBroker(),
  options: UnifiedTradingAccountOptions = {},
  baseDir = makeTempDir(),
): { uta: UnifiedTradingAccount; broker: MockBroker; baseDir: string } {
  const uta = new UnifiedTradingAccount(broker, {
    guardStateBaseDir: baseDir,
    riskStateBaseDir: baseDir,
    ...options,
  })
  return { uta, broker, baseDir }
}

function drawdownUTA(baseDir = makeTempDir(), broker = new MockBroker({
  accountInfo: {
    netLiquidation: '100000',
    totalCashValue: '100000',
    unrealizedPnL: '0',
    realizedPnL: '0',
  },
})) {
  return createUTA(broker, {
    guards: [{ type: 'max-drawdown', options: { maxDrawdownPct: 10 } }],
  }, baseDir)
}

async function post(routes: ReturnType<typeof createTradingRoutes>, path: string, body: unknown) {
  const res = await routes.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('Risk state machine — automatic transitions', () => {
  it('auto-downgrades to CAUTIOUS on drawdown breach and READ_ONLY on severe breach', async () => {
    const { uta, broker } = drawdownUTA()
    await uta.getAccount()
    expect(uta.getRiskState().state).toBe('NORMAL')

    broker.setAccountInfo({
      netLiquidation: '90000',
      totalCashValue: '90000',
      unrealizedPnL: '0',
      realizedPnL: '0',
    })
    await uta.getAccount()
    expect(uta.getRiskState()).toMatchObject({
      state: 'CAUTIOUS',
      reason: expect.stringContaining('MaxDrawdown breach'),
      metrics: expect.objectContaining({ drawdownPct: 10, maxDrawdownPct: 10 }),
    })

    broker.setAccountInfo({
      netLiquidation: '85000',
      totalCashValue: '85000',
      unrealizedPnL: '0',
      realizedPnL: '0',
    })
    await uta.getAccount()
    expect(uta.getRiskState()).toMatchObject({
      state: 'READ_ONLY',
      metrics: expect.objectContaining({ drawdownPct: 15, severeThresholdPct: 15 }),
    })
    expect(uta.getRiskState().history.map(h => h.to)).toEqual(['CAUTIOUS', 'READ_ONLY'])
  })

  it('auto path never loosens an already-tightened state', async () => {
    const { uta, broker } = drawdownUTA()
    await uta.getAccount()
    broker.setAccountInfo({ netLiquidation: '85000', totalCashValue: '85000', unrealizedPnL: '0', realizedPnL: '0' })
    await uta.getAccount()
    expect(uta.getRiskState().state).toBe('READ_ONLY')

    broker.setAccountInfo({ netLiquidation: '120000', totalCashValue: '120000', unrealizedPnL: '0', realizedPnL: '0' })
    await uta.getAccount()

    expect(uta.getRiskState().state).toBe('READ_ONLY')
    expect(uta.getRiskState().history.map(h => h.to)).toEqual(['READ_ONLY'])
  })

  it('rechecks auto rank at write time so queued weaker transitions cannot loosen state', async () => {
    const store = createRiskStateStore('auto-race', { baseDir: makeTempDir() })

    const readOnly = store.autoTighten({
      target: 'READ_ONLY',
      reason: 'severe breach',
      metrics: { drawdownPct: 15 },
    })
    const cautious = store.autoTighten({
      target: 'CAUTIOUS',
      reason: 'moderate breach',
      metrics: { drawdownPct: 10 },
    })

    await Promise.all([readOnly, cautious])

    expect(store.current().state).toBe('READ_ONLY')
    expect(store.current().history.map(h => h.to)).toEqual(['READ_ONLY'])
  })

  it('stays NORMAL when no drawdown or daily-loss guard is configured', async () => {
    const broker = new MockBroker({
      accountInfo: { netLiquidation: '100000', totalCashValue: '100000', unrealizedPnL: '0', realizedPnL: '0' },
    })
    const { uta } = createUTA(broker, { guards: [] })
    await uta.getAccount()

    broker.setAccountInfo({ netLiquidation: '1', totalCashValue: '1', unrealizedPnL: '0', realizedPnL: '0' })
    await uta.getAccount()

    expect(uta.getRiskState().state).toBe('NORMAL')
    expect(uta.getRiskState().history).toEqual([])
  })
})

describe('Risk state machine — enforcement', () => {
  it('CAUTIOUS refuses risk-increasing stage with state, reason, and recovery route', async () => {
    const { uta } = createUTA()
    await uta.setRiskState('CAUTIOUS', 'manual caution')

    expect(() => uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      symbol: 'AAPL',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
    })).toThrow(/CAUTIOUS.*manual caution.*POST \/uta\/mock-paper\/risk-state/s)
  })

  it('CAUTIOUS allows closePosition and cancelOrder stage-to-push end-to-end', async () => {
    const broker = new MockBroker()
    broker.setPositions([
      makePosition({
        contract: makeContract({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL' }),
        quantity: new Decimal(10),
      }),
    ])
    const { uta } = createUTA(broker)

    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      symbol: 'AAPL',
      action: 'BUY',
      orderType: 'LMT',
      totalQuantity: '1',
      lmtPrice: '1',
    })
    uta.commit('resting order')
    const openOrderId = (await uta.push()).submitted[0]!.orderId!

    await uta.setRiskState('CAUTIOUS', 'manual caution')

    uta.stageClosePosition({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL' })
    uta.commit('close in cautious')
    const closeResult = await uta.push()
    expect(closeResult.submitted).toHaveLength(1)
    expect(closeResult.rejected).toHaveLength(0)

    uta.stageCancelOrder({ orderId: openOrderId })
    uta.commit('cancel in cautious')
    const cancelResult = await uta.push()
    expect(cancelResult.submitted).toHaveLength(1)
    expect(cancelResult.rejected).toHaveLength(0)
  })

  it.each(['READ_ONLY', 'HALT'] as const)('%s refuses stage/commit/push while reject remains allowed', async (state) => {
    const stage = createUTA(new MockBroker({ id: `stage-${state}` }))
    await stage.uta.setRiskState(state, `${state} test`)
    expect(() => stage.uta.stageCancelOrder({ orderId: 'x' })).toThrow(new RegExp(`risk state ${state}`))

    const commit = createUTA(new MockBroker({ id: `commit-${state}` }))
    commit.uta.stageCancelOrder({ orderId: 'x' })
    await commit.uta.setRiskState(state, `${state} test`)
    expect(() => commit.uta.commit('cancel')).toThrow(new RegExp(`risk state ${state}`))

    const push = createUTA(new MockBroker({ id: `push-${state}` }))
    push.uta.stageCancelOrder({ orderId: 'x' })
    const prepared = push.uta.commit('cancel')
    await push.uta.setRiskState(state, `${state} test`)

    await expect(push.uta.push()).rejects.toThrow(new RegExp(`risk state ${state}`))
    await expect(push.uta.reject('human declined')).resolves.toMatchObject({
      hash: prepared.hash,
      message: '[rejected] cancel — human declined',
      operationCount: 1,
    })
  })
})

describe('Risk state machine — persistence', () => {
  it('persists current state and transition history across a new instance from disk', async () => {
    const baseDir = makeTempDir()
    const { uta } = createUTA(new MockBroker({ id: 'persist-risk' }), {}, baseDir)
    await uta.setRiskState('CAUTIOUS', 'human caution')

    const restored = new UnifiedTradingAccount(new MockBroker({ id: 'persist-risk' }), {
      riskStateBaseDir: baseDir,
      guardStateBaseDir: baseDir,
    })

    expect(restored.getRiskState()).toMatchObject({
      state: 'CAUTIOUS',
      reason: 'human caution',
      history: [{ from: 'NORMAL', to: 'CAUTIOUS', by: 'human', reason: 'human caution' }],
    })
  })

  it('loads legacy transition history without trigger identity', async () => {
    const baseDir = makeTempDir()
    const path = riskStatePath('legacy-risk', { baseDir })
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({
      version: 1,
      state: 'CAUTIOUS',
      reason: 'legacy caution',
      updatedAt: '2026-07-05T12:00:00.000Z',
      history: [{
        from: 'NORMAL',
        to: 'CAUTIOUS',
        by: 'human',
        reason: 'legacy caution',
        at: '2026-07-05T12:00:00.000Z',
      }],
    }), 'utf-8')

    const uta = new UnifiedTradingAccount(new MockBroker({ id: 'legacy-risk' }), {
      riskStateBaseDir: baseDir,
      guardStateBaseDir: baseDir,
    })

    expect(uta.getRiskState()).toMatchObject({
      state: 'CAUTIOUS',
      history: [{ from: 'NORMAL', to: 'CAUTIOUS', by: 'human', reason: 'legacy caution' }],
    })
    expect(uta.getRiskState().history[0].triggerIdentity).toBeUndefined()
  })

  it('treats corrupt risk-state files as READ_ONLY and logs loudly', async () => {
    const baseDir = makeTempDir()
    const path = riskStatePath('corrupt-risk', { baseDir })
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{"version":1,"state":', 'utf-8')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const uta = new UnifiedTradingAccount(new MockBroker({ id: 'corrupt-risk' }), {
      riskStateBaseDir: baseDir,
      guardStateBaseDir: baseDir,
    })

    expect(uta.getRiskState()).toMatchObject({
      state: 'READ_ONLY',
      metrics: { failClosed: true },
    })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('forcing READ_ONLY'))
    expect(() => uta.stageCancelOrder({ orderId: 'x' })).toThrow(/risk state READ_ONLY/)
  })

  it('quarantines a corrupt risk-state file before the first replacement write', async () => {
    const baseDir = makeTempDir()
    const path = riskStatePath('corrupt-quarantine', { baseDir })
    const corrupt = '{"version":1,"state":'
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, corrupt, 'utf-8')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const store = createRiskStateStore('corrupt-quarantine', { baseDir })
    expect(store.current().state).toBe('READ_ONLY')
    await store.humanSet({ state: 'NORMAL', reason: 'human reviewed corrupt file' })

    const files = await readdir(dirname(path))
    const quarantined = files.filter(file => /^risk-state\.json\.corrupt-\d+$/.test(file))
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(dirname(path), quarantined[0]!), 'utf-8')).toBe(corrupt)

    const fresh = JSON.parse(await readFile(path, 'utf-8')) as { state: string; history: unknown[] }
    expect(fresh.state).toBe('NORMAL')
    expect(fresh.history).toHaveLength(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`preserved unreadable risk state file at ${join(dirname(path), quarantined[0]!)}`))
  })
})

describe('Risk state machine — guard state write amplification', () => {
  it('does not rewrite max-drawdown guard state when the high-water mark is unchanged', async () => {
    const baseDir = makeTempDir()
    const { uta } = drawdownUTA(baseDir)
    await uta.getAccount()

    const path = portfolioGuardStatePath('mock-paper', { baseDir })
    const past = new Date('2026-07-04T00:00:00.000Z')
    await utimes(path, past, past)
    const before = await stat(path)

    await uta.getAccount()

    const after = await stat(path)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('does not rewrite daily-loss guard state when the UTC day baseline is unchanged', async () => {
    const baseDir = makeTempDir()
    const broker = new MockBroker({
      accountInfo: {
        netLiquidation: '100000',
        totalCashValue: '100000',
        unrealizedPnL: '0',
        realizedPnL: '0',
      },
    })
    const { uta } = createUTA(broker, {
      guards: [{ type: 'daily-loss', options: { maxDailyLossPct: 5 } }],
      riskStateNow: () => new Date('2026-07-04T10:00:00.000Z'),
    }, baseDir)
    await uta.getAccount()

    const path = portfolioGuardStatePath('mock-paper', { baseDir })
    const past = new Date('2026-07-04T00:00:00.000Z')
    await utimes(path, past, past)
    const before = await stat(path)

    await uta.getAccount()

    const after = await stat(path)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})

describe('Risk state machine — HTTP route and projections', () => {
  it('human route recovers to NORMAL, records history, and rejects invalid states', async () => {
    const { uta } = createUTA()
    await uta.setRiskState('READ_ONLY', 'auto severe breach')

    const ctx = {
      utaManager: {
        get: (id: string) => (id === uta.id ? uta : undefined),
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
    const routes = createTradingRoutes(ctx)

    const recovered = await post(routes, '/uta/mock-paper/risk-state', {
      state: 'NORMAL',
      reason: 'human reviewed account',
    })
    expect(recovered.status).toBe(200)
    expect((recovered.body as { riskState: { state: string } }).riskState.state).toBe('NORMAL')
    expect(uta.getRiskState().history.at(-1)).toMatchObject({
      from: 'READ_ONLY',
      to: 'NORMAL',
      by: 'human',
      reason: 'human reviewed account',
    })

    const list = await routes.request('/uta')
    const listBody = await list.json() as { utas: Array<{ health: { riskState: { state: string } } }> }
    expect(listBody.utas[0].health.riskState.state).toBe('NORMAL')

    const status = await routes.request('/uta/mock-paper/wallet/status')
    const statusBody = await status.json() as { riskState: { state: string } }
    expect(statusBody.riskState.state).toBe('NORMAL')

    const invalid = await post(routes, '/uta/mock-paper/risk-state', { state: 'HALT' })
    expect(invalid.status).toBe(400)
    expect(uta.getRiskState().state).toBe('NORMAL')
  })
})
