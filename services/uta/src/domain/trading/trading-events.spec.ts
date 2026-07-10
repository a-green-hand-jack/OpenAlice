import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Decimal from 'decimal.js'
import { OrderState } from '@traderalice/ibkr'
import { validateEventPayload, type AgentEventMap } from '@/core/agent-event.js'
import { UnifiedTradingAccount, type UnifiedTradingAccountOptions } from './UnifiedTradingAccount.js'
import { createUtaHttpEventSink, type UtaEventSink, type UtaLifecycleEventType } from './events.js'
import { MockBroker, makePosition } from './brokers/mock/index.js'

type CapturedEvent = {
  [K in UtaLifecycleEventType]: { type: K; payload: AgentEventMap[K] }
}[UtaLifecycleEventType]

function createCaptureSink(): UtaEventSink & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  return {
    events,
    emit(type, payload) {
      validateEventPayload(type, payload)
      events.push({ type, payload } as CapturedEvent)
    },
    async flush() {},
    async close() {},
  }
}

function createUTA(options: UnifiedTradingAccountOptions = {}): {
  uta: UnifiedTradingAccount
  broker: MockBroker
} {
  const broker = new MockBroker()
  const stateDir = mkdtempSync(join(tmpdir(), 'openalice-trading-events-'))
  const uta = new UnifiedTradingAccount(broker, {
    guardStateBaseDir: stateDir,
    riskStateBaseDir: stateDir,
    ...options,
  })
  return { uta, broker }
}

const APPROVER = {
  via: 'alice-bff',
  fingerprint: 'session:test',
  at: '2026-07-05T00:00:00.000Z',
} as const

const RESOLVER = {
  via: 'alice-bff',
  fingerprint: 'session:resolver',
  at: '2026-07-05T00:05:00.000Z',
} as const

describe('UTA trading lifecycle events', () => {
  it('emits trade.committed, trade.pushed, and trade.executed for a mock stage/commit/push/fill flow', async () => {
    const sink = createCaptureSink()
    const { uta } = createUTA({ eventSink: sink })

    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
    })
    const commit = uta.commit('buy one AAPL for lifecycle event coverage')
    const push = await uta.push(APPROVER)

    expect(push.hash).toBe(commit.hash)
    expect(sink.events.map((e) => e.type)).toEqual([
      'trade.committed',
      'trade.pushed',
      'trade.executed',
    ])

    const pushed = sink.events.find((e) => e.type === 'trade.pushed')
    expect(pushed?.payload).toMatchObject({
      id: commit.hash,
      accountId: 'mock-paper',
      approver: APPROVER,
      guards: [],
      guardSummary: { configured: [], evaluated: 0, passed: 0, rejected: 0, skipped: 0 },
      risk: { state: 'NORMAL' },
    })
    const executed = sink.events.find((e) => e.type === 'trade.executed')
    expect(executed?.payload).toMatchObject({
      accountId: 'mock-paper',
      commitHash: commit.hash,
      status: 'filled',
      source: 'push',
    })
  })

  it('emits trade.rejected with rejecting guard verdicts for a guard-refused push', async () => {
    const sink = createCaptureSink()
    const { uta } = createUTA({
      eventSink: sink,
      guards: [{ type: 'max-position-size', options: { maxPercentOfEquity: 1 } }],
    })

    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'BUY',
      orderType: 'MKT',
      cashQty: '1000000',
    })
    const commit = uta.commit('oversized order should be refused by guards')
    const push = await uta.push(APPROVER)

    expect(push.rejected).toHaveLength(1)
    const rejected = sink.events.find((e) => e.type === 'trade.rejected')
    expect(rejected?.payload).toMatchObject({
      id: commit.hash,
      accountId: 'mock-paper',
      operationCount: 1,
      risk: { state: 'NORMAL' },
    })
    expect(rejected?.payload.guards).toEqual([
      expect.objectContaining({
        guard: 'max-position-size',
        verdict: 'reject',
        operationIndex: 0,
        operationAction: 'placeOrder',
      }),
    ])
    expect(rejected?.payload.rejectingGuards).toHaveLength(1)
  })

  it('emits risk.state-changed and risk.emergency-stop with trigger identity and outcomes', async () => {
    const sink = createCaptureSink()
    const { uta } = createUTA({ eventSink: sink })

    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'BUY',
      orderType: 'LMT',
      totalQuantity: '1',
      lmtPrice: '1',
    })
    uta.commit('resting order for emergency stop')
    await uta.push(APPROVER)
    sink.events.length = 0

    await uta.setRiskState('HALT', 'manual emergency drill', APPROVER)
    const stop = await uta.emergencyCancelAllOpenOrders({
      reason: 'manual emergency drill',
      cancelOrders: true,
      triggerIdentity: APPROVER,
    })

    expect(stop.cancelResults).toHaveLength(1)
    expect(sink.events.map((e) => e.type)).toEqual([
      'risk.state-changed',
      'risk.emergency-stop',
    ])
    expect(sink.events[0]?.payload).toMatchObject({
      accountId: 'mock-paper',
      from: 'NORMAL',
      to: 'HALT',
      by: 'human',
      triggerIdentity: APPROVER,
    })
    expect(sink.events[1]?.payload).toMatchObject({
      accountId: 'mock-paper',
      reason: 'manual emergency drill',
      triggerIdentity: APPROVER,
      outcomes: [expect.objectContaining({ success: true, status: 'Cancelled' })],
    })
  })

  it('emits only evidence-backed push events after uncertain recovery is durably finalized', async () => {
    const sink = createCaptureSink()
    const onPostPush = vi.fn()
    let failFinalization = false
    let durableState: NonNullable<UnifiedTradingAccountOptions['savedState']> | undefined
    const { uta, broker } = createUTA({
      eventSink: sink,
      onPostPush,
      onCommit: (state) => {
        if (failFinalization && !state.mutation?.activeAttempt) {
          throw new Error('simulated durable finalization failure')
        }
        durableState = state
      },
    })
    await uta.waitForConnect()

    const filled = new OrderState()
    filled.status = 'Filled'
    vi.spyOn(broker, 'placeOrder')
      .mockResolvedValueOnce({ success: true, orderId: 'known-filled', orderState: filled })
      .mockResolvedValueOnce({ success: false, error: 'venue reply lost' })

    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
    })
    uta.stagePlaceOrder({
      aliceId: 'mock-paper|MSFT',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
    })
    uta.commit('partial known outcome followed by uncertain venue acceptance')
    await expect(uta.push(APPROVER)).rejects.toThrow(/acceptance is uncertain/i)

    const attemptId = uta.status().mutation?.activeAttempt?.attemptId
    expect(attemptId).toBeDefined()
    expect(onPostPush).not.toHaveBeenCalled()
    expect(sink.events.map((event) => event.type)).toEqual(['trade.committed'])
    sink.events.length = 0

    failFinalization = true
    await expect(uta.resolveMutation({
      attemptId: attemptId!,
      action: 'acknowledge-uncertainty',
      reason: 'Venue evidence cannot distinguish accept from reject',
      confirmation: attemptId!,
      approver: RESOLVER,
    })).rejects.toThrow(/durably finalize/i)
    expect(sink.events).toEqual([])
    expect(onPostPush).not.toHaveBeenCalled()

    failFinalization = false
    const { uta: restored } = createUTA({
      savedState: durableState,
      eventSink: sink,
      onPostPush,
      onCommit: (state) => { durableState = state },
    })
    await restored.waitForConnect()
    await expect(restored.resolveMutation({
      attemptId: attemptId!,
      action: 'acknowledge-uncertainty',
      reason: 'Operator accepts quarantine release without claiming an outcome',
      confirmation: attemptId!,
      approver: RESOLVER,
    })).resolves.toMatchObject({ resolved: true, readiness: 'ready' })

    expect(sink.events.map((event) => event.type)).toEqual([
      'trade.pushed',
      'trade.executed',
    ])
    expect(sink.events.find((event) => event.type === 'trade.pushed')?.payload).toMatchObject({
      approver: APPROVER,
      operationCount: 2,
      operations: [
        expect.objectContaining({ status: 'filled', orderId: 'known-filled' }),
        expect.objectContaining({ status: 'uncertain', error: 'venue reply lost' }),
      ],
    })
    expect(sink.events.some((event) => event.type === 'trade.rejected')).toBe(false)
    expect(sink.events.filter((event) => event.type === 'trade.executed')).toHaveLength(1)
    expect(onPostPush).toHaveBeenCalledTimes(1)
    expect(onPostPush).toHaveBeenCalledWith('mock-paper')
  })

  it('runs onPostReject only after a recovered human rejection is durably finalized', async () => {
    const onPostReject = vi.fn()
    const { uta, broker } = createUTA({ onPostReject })
    await uta.waitForConnect()

    uta.stageCancelOrder({ orderId: 'stale-order' })
    uta.commit('reject this pending cancellation proposal')
    vi.spyOn(broker, 'getAccount').mockRejectedValueOnce(new Error('snapshot transport failed'))

    await expect(uta.reject('proposal no longer wanted', APPROVER)).rejects.toThrow(/final state snapshot failed/i)
    expect(onPostReject).not.toHaveBeenCalled()
    const attemptId = uta.status().mutation?.activeAttempt?.attemptId
    expect(uta.status().mutation?.activeAttempt?.kind).toBe('human_reject')

    await uta.resolveMutation({
      attemptId: attemptId!,
      action: 'finalize-known-outcomes',
      reason: 'The local rejection outcome is known',
      confirmation: attemptId!,
      approver: RESOLVER,
    })
    expect(onPostReject).toHaveBeenCalledTimes(1)
    expect(onPostReject).toHaveBeenCalledWith('mock-paper')
  })

  it('emits an emergency-stop risk event after uncertain cancellation recovery', async () => {
    const sink = createCaptureSink()
    const { uta, broker } = createUTA({ eventSink: sink })

    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'BUY',
      orderType: 'LMT',
      totalQuantity: '1',
      lmtPrice: '1',
    })
    uta.commit('resting order for uncertain emergency cancellation')
    await uta.push(APPROVER)
    sink.events.length = 0

    vi.spyOn(broker, 'cancelOrder').mockResolvedValueOnce({
      success: false,
      error: 'cancel acknowledgement lost',
    })
    await expect(uta.emergencyCancelAllOpenOrders({
      reason: 'venue connectivity incident',
      cancelOrders: true,
      triggerIdentity: APPROVER,
    })).rejects.toThrow(/acceptance is uncertain/i)
    expect(sink.events).toEqual([])

    const attemptId = uta.status().mutation?.activeAttempt?.attemptId
    await uta.resolveMutation({
      attemptId: attemptId!,
      action: 'acknowledge-uncertainty',
      reason: 'Cancellation remains unknown after venue review',
      confirmation: attemptId!,
      approver: RESOLVER,
    })

    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]).toMatchObject({
      type: 'risk.emergency-stop',
      payload: {
        accountId: 'mock-paper',
        reason: 'venue connectivity incident',
        cancelOrders: true,
        triggerIdentity: APPROVER,
        outcomes: [expect.objectContaining({
          success: false,
          status: 'Uncertain',
          error: 'cancel acknowledgement lost',
        })],
      },
    })
  })

  it('emits a flatten risk event after uncertain position-close recovery', async () => {
    const sink = createCaptureSink()
    const { uta, broker } = createUTA({ eventSink: sink })
    broker.setPositions([makePosition({
      side: 'long',
      quantity: new Decimal(2),
    })])
    await uta.waitForConnect()

    vi.spyOn(broker, 'closePosition').mockResolvedValueOnce({
      success: false,
      error: 'close acknowledgement lost',
    })
    await expect(uta.flattenAllOpenPositions(APPROVER)).rejects.toThrow(/acceptance is uncertain/i)
    expect(sink.events).toEqual([])

    const attemptId = uta.status().mutation?.activeAttempt?.attemptId
    await uta.resolveMutation({
      attemptId: attemptId!,
      action: 'acknowledge-uncertainty',
      reason: 'Position close remains unknown after venue review',
      confirmation: attemptId!,
      approver: RESOLVER,
    })

    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]).toMatchObject({
      type: 'risk.flatten',
      payload: {
        accountId: 'mock-paper',
        triggerIdentity: APPROVER,
        outcomes: [expect.objectContaining({
          side: 'long',
          quantity: '2',
          success: false,
          status: 'Uncertain',
          error: 'close acknowledgement lost',
        })],
      },
    })
  })

  it('keeps push successful and logs loudly when Alice ingest is down', async () => {
    const logs: string[] = []
    const sink = createUtaHttpEventSink({
      ingestUrl: 'http://127.0.0.1:9/api/events/ingest',
      token: 'test-token',
      fetchImpl: async () => {
        throw new Error('Alice ingest down')
      },
      log: { error: (message: unknown) => logs.push(String(message)) },
    })
    const { uta } = createUTA({ eventSink: sink })

    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
    })
    uta.commit('buy despite ingest outage')
    const push = await uta.push(APPROVER)

    expect(push.submitted).toHaveLength(1)
    await sink.flush()
    expect(logs.some((line) => line.includes('[uta-events] dropped trade.pushed event'))).toBe(true)
  })
})
