import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateEventPayload, type AgentEventMap } from '@/core/agent-event.js'
import { UnifiedTradingAccount, type UnifiedTradingAccountOptions } from './UnifiedTradingAccount.js'
import { createUtaHttpEventSink, type UtaEventSink, type UtaLifecycleEventType } from './events.js'
import { MockBroker } from './brokers/mock/index.js'

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
