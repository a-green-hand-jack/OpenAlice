import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Decimal from 'decimal.js'
import { validateEventPayload, type AgentEventMap } from '@/core/agent-event.js'
import { AUTHZ_LEVELS, type AuthzLevel, type RiskState } from '@traderalice/uta-protocol'
import { UnifiedTradingAccount, type UnifiedTradingAccountOptions } from './UnifiedTradingAccount.js'
import { MockBroker, makeContract, makePosition } from './brokers/mock/index.js'
import type { UtaEventSink, UtaLifecycleEventType } from './events.js'
import {
  AUTO_PUSH_PAPER_VIA,
  assertPaperAutoPushAccountType,
  tryAutoPushPaper,
} from './paper-auto-push.js'

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
  sink: UtaEventSink & { events: CapturedEvent[] }
} {
  const broker = new MockBroker()
  broker.setPositions([
    makePosition({
      contract: makeContract({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL' }),
      quantity: new Decimal(10),
      avgCost: '150',
      marketPrice: '160',
    }),
  ])
  const sink = createCaptureSink()
  const stateDir = mkdtempSync(join(tmpdir(), 'openalice-paper-auto-push-'))
  const uta = new UnifiedTradingAccount(broker, {
    guardStateBaseDir: stateDir,
    riskStateBaseDir: stateDir,
    eventSink: sink,
    ...options,
  })
  return { uta, broker, sink }
}

function stageAndCommitBuy(uta: UnifiedTradingAccount, message = 'paper auto-push buy'): string {
  uta.stagePlaceOrder({
    aliceId: 'mock-paper|AAPL',
    action: 'BUY',
    orderType: 'MKT',
    totalQuantity: '1',
  })
  return uta.commit(message).hash
}

const PAPER_INPUT = {
  accountType: 'mock' as const,
  accountMaxAuthzLevel: 'paper' as const,
  effectiveAuthzLevel: 'paper' as const,
  now: () => new Date('2026-07-06T00:00:00.000Z'),
}

describe('paper auto-push', () => {
  it('auto-executes paper/mock commits at effective paper authz through the normal push audit path', async () => {
    const { uta, broker, sink } = createUTA({
      guards: [{ type: 'max-position-size', options: { maxPercentOfEquity: 99 } }],
    })
    const hash = stageAndCommitBuy(uta)

    const result = await tryAutoPushPaper({ uta, ...PAPER_INPUT })

    expect(result.status).toBe('pushed')
    expect(broker.callCount('placeOrder')).toBe(1)
    expect(uta.status().pendingHash).toBeNull()
    expect(uta.show(hash)?.approver).toMatchObject({
      via: AUTO_PUSH_PAPER_VIA,
      at: '2026-07-06T00:00:00.000Z',
    })
    expect(sink.events.map((e) => e.type)).toEqual([
      'trade.committed',
      'trade.pushed',
      'trade.executed',
    ])
    const pushed = sink.events.find((e) => e.type === 'trade.pushed')
    expect(pushed?.payload).toMatchObject({
      id: hash,
      approver: { via: AUTO_PUSH_PAPER_VIA },
      risk: { state: 'NORMAL' },
    })
    expect(pushed?.payload.guards).toEqual([
      expect.objectContaining({ guard: 'max-position-size', verdict: 'pass' }),
    ])
    expect(sink.events.find((e) => e.type === 'trade.executed')?.payload).toMatchObject({
      commitHash: hash,
      status: 'filled',
      source: 'push',
    })
  })

  it('makes live accounts structurally ineligible under every authz permutation', async () => {
    expect(() => assertPaperAutoPushAccountType('live')).toThrow(/unreachable/)

    const { uta, broker } = createUTA()
    stageAndCommitBuy(uta)

    for (const accountMaxAuthzLevel of AUTHZ_LEVELS) {
      for (const effectiveAuthzLevel of AUTHZ_LEVELS) {
        const result = await tryAutoPushPaper({
          uta,
          accountType: 'live',
          accountMaxAuthzLevel,
          effectiveAuthzLevel,
        })
        expect(result).toMatchObject({
          status: 'skipped',
          reason: 'account_type_not_paper',
        })
      }
    }

    expect(broker.callCount('placeOrder')).toBe(0)
    expect(uta.status().pendingHash).not.toBeNull()
  })

  it.each(['CAUTIOUS', 'READ_ONLY', 'HALT'] as const)(
    'does not fire in risk state %s and leaves the commit pending',
    async (state: RiskState) => {
      const { uta, broker, sink } = createUTA()
      const hash = stageAndCommitBuy(uta)
      await uta.setRiskState(state, `test ${state}`)
      broker.resetCalls()

      const result = await tryAutoPushPaper({ uta, ...PAPER_INPUT })

      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'risk_state_not_normal',
        pendingHash: hash,
        risk: { state },
      })
      expect(broker.callCount('placeOrder')).toBe(0)
      expect(uta.status().pendingHash).toBe(hash)
      expect(sink.events.some((e) => e.type === 'trade.pushed')).toBe(false)
      expect(sink.events.some((e) => e.type === 'trade.rejected')).toBe(false)
    },
  )

  it('stops immediately after a degrade before a new commit', async () => {
    const { uta, broker } = createUTA()
    await uta.setRiskState('CAUTIOUS', 'test degrade before new commit')
    uta.stageCancelOrder({ orderId: 'mock-ord-1' })
    const hash = uta.commit('cancel stale order after degrade').hash
    broker.resetCalls()

    const result = await tryAutoPushPaper({ uta, ...PAPER_INPUT })

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'risk_state_not_normal',
      pendingHash: hash,
      risk: { state: 'CAUTIOUS' },
    })
    expect(broker.callCount('cancelOrder')).toBe(0)
    expect(uta.status().pendingHash).toBe(hash)
  })

  it('records guard rejection like a human push without broker execution', async () => {
    const { uta, broker, sink } = createUTA({
      guards: [{ type: 'max-position-size', options: { maxPercentOfEquity: 1 } }],
    })
    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'BUY',
      orderType: 'MKT',
      cashQty: '1000000',
    })
    const hash = uta.commit('oversized paper proposal').hash
    broker.resetCalls()

    const result = await tryAutoPushPaper({ uta, ...PAPER_INPUT })

    expect(result.status).toBe('pushed')
    if (result.status === 'pushed') {
      expect(result.push.submitted).toHaveLength(0)
      expect(result.push.rejected).toHaveLength(1)
    }
    expect(broker.callCount('placeOrder')).toBe(0)
    expect(uta.status().pendingHash).toBeNull()
    expect(uta.show(hash)?.results[0]).toMatchObject({ status: 'rejected' })
    const rejected = sink.events.find((e) => e.type === 'trade.rejected')
    expect(rejected?.payload).toMatchObject({
      id: hash,
      approver: { via: AUTO_PUSH_PAPER_VIA },
      reason: expect.stringContaining('max-position-size'),
    })
    expect(rejected?.payload.rejectingGuards).toEqual([
      expect.objectContaining({ guard: 'max-position-size', verdict: 'reject' }),
    ])
    expect(sink.events.some((e) => e.type === 'trade.executed')).toBe(false)
  })

  it('auto-pushes a commit exactly once across concurrent rescan and simulated restart', async () => {
    const { uta, broker } = createUTA()
    stageAndCommitBuy(uta)

    const first = tryAutoPushPaper({ uta, ...PAPER_INPUT })
    const second = tryAutoPushPaper({ uta, ...PAPER_INPUT })
    const results = await Promise.all([first, second])

    expect(results.filter((r) => r.status === 'pushed')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'skipped' && r.reason === 'push_in_flight')).toHaveLength(1)
    expect(broker.callCount('placeOrder')).toBe(1)

    const rescan = await tryAutoPushPaper({ uta, ...PAPER_INPUT })
    expect(rescan).toMatchObject({ status: 'skipped', reason: 'no_pending_commit' })
    expect(broker.callCount('placeOrder')).toBe(1)

    const restartedBroker = new MockBroker()
    const restarted = new UnifiedTradingAccount(restartedBroker, {
      savedState: uta.exportGitState(),
      guardStateBaseDir: mkdtempSync(join(tmpdir(), 'openalice-paper-auto-push-restart-')),
      riskStateBaseDir: mkdtempSync(join(tmpdir(), 'openalice-paper-auto-push-restart-risk-')),
    })
    const afterRestart = await tryAutoPushPaper({ uta: restarted, ...PAPER_INPUT })
    expect(afterRestart).toMatchObject({ status: 'skipped', reason: 'no_pending_commit' })
    expect(restartedBroker.callCount('placeOrder')).toBe(0)
  })

  it('does not auto-push when the target account ceiling resolves to read_only', async () => {
    const { uta, broker } = createUTA()
    const hash = stageAndCommitBuy(uta)

    const result = await tryAutoPushPaper({
      uta,
      accountType: 'mock',
      accountMaxAuthzLevel: 'read_only',
      effectiveAuthzLevel: 'paper',
    })

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'authz_below_paper',
      pendingHash: hash,
      effectiveAuthzLevel: 'read_only',
    })
    expect(broker.callCount('placeOrder')).toBe(0)
    expect(uta.status().pendingHash).toBe(hash)
  })

  it('defaults missing workspace/effective authz to read_only rather than auto-firing', async () => {
    const { uta, broker } = createUTA()
    stageAndCommitBuy(uta)

    const result = await tryAutoPushPaper({
      uta,
      accountType: 'mock',
      accountMaxAuthzLevel: 'paper',
    })

    expect(result).toMatchObject({ status: 'skipped', reason: 'authz_below_paper' })
    expect(broker.callCount('placeOrder')).toBe(0)
  })
})
