import { describe, expect, it, vi } from 'vitest'
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
  resolvePaperAutoPushEligibility,
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
    stopLoss: { price: '150' },
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
  it('keeps verified built-in mock auto-push available under readonly containment', async () => {
    const { uta, broker } = createUTA({
      tradingMode: 'readonly',
      containmentClass: 'verified-isolated',
    })
    stageAndCommitBuy(uta)

    const result = await tryAutoPushPaper({ uta, ...PAPER_INPUT })

    expect(result.status).toBe('pushed')
    expect(uta.readOnly).toBe(false)
    expect(uta.tradingMode).toBe('readonly')
    expect(uta.containmentClass).toBe('verified-isolated')
    expect(broker.callCount('placeOrder')).toBe(1)
  })

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
      stopLoss: { price: '150' },
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

  it('requires a tight protective stop before paper auto-push', async () => {
    const { uta, broker, sink } = createUTA()
    const hash = stageAndCommitBuy(uta, 'protected paper buy')

    // Positive control: a well-formed order (attached stopLoss, within the
    // 8% cap) auto-pushes normally.
    const protectedResult = await tryAutoPushPaper({ uta, ...PAPER_INPUT })
    expect(protectedResult.status).toBe('pushed')

    const { uta: noStopUta, broker: noStopBroker } = createUTA()
    noStopUta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
    })
    const noStopHash = noStopUta.commit('unprotected paper buy').hash

    const noStop = await tryAutoPushPaper({ uta: noStopUta, ...PAPER_INPUT })

    expect(noStop).toMatchObject({
      status: 'skipped',
      reason: 'paper_policy_denied',
      pendingHash: noStopHash,
      policyViolations: [
        expect.objectContaining({ code: 'missing_stop_loss', symbol: 'AAPL' }),
      ],
    })
    expect(noStopBroker.callCount('placeOrder')).toBe(0)
    expect(noStopUta.status().pendingHash).toBe(noStopHash)

    const { uta: wideStopUta, broker: wideStopBroker } = createUTA()
    wideStopUta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
      stopLoss: { price: '100' },
    })
    const wideStopHash = wideStopUta.commit('too-wide paper buy').hash

    const wideStop = await tryAutoPushPaper({ uta: wideStopUta, ...PAPER_INPUT })

    expect(wideStop).toMatchObject({
      status: 'skipped',
      reason: 'paper_policy_denied',
      pendingHash: wideStopHash,
      policyViolations: [
        expect.objectContaining({ code: 'stop_loss_too_wide', symbol: 'AAPL' }),
      ],
    })
    expect(wideStopBroker.callCount('placeOrder')).toBe(0)

    expect(broker.callCount('placeOrder')).toBe(1)
    expect(uta.status().pendingHash).toBeNull()
    expect(sink.events.find((e) => e.type === 'trade.pushed')?.payload.id).toBe(hash)
  })

  it('does not auto-push paper adds to a losing position', async () => {
    const { uta, broker } = createUTA()
    broker.setPositions([
      makePosition({
        contract: makeContract({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL' }),
        quantity: new Decimal(10),
        avgCost: '150',
        marketPrice: '140',
      }),
    ])
    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
      stopLoss: { price: '130' },
    })
    const hash = uta.commit('add to loser').hash

    const result = await tryAutoPushPaper({ uta, ...PAPER_INPUT })

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'paper_policy_denied',
      pendingHash: hash,
      policyViolations: [
        expect.objectContaining({ code: 'adding_to_losing_position', symbol: 'AAPL' }),
      ],
    })
    expect(broker.callCount('placeOrder')).toBe(0)
    expect(uta.status().pendingHash).toBe(hash)
  })

  it('allows risk-reducing sells without requiring an entry stop', async () => {
    const { uta, broker } = createUTA()
    broker.setPositions([
      makePosition({
        contract: makeContract({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL' }),
        quantity: new Decimal(10),
        avgCost: '150',
        marketPrice: '140',
      }),
    ])
    uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      action: 'SELL',
      orderType: 'MKT',
      totalQuantity: '2',
    })
    const hash = uta.commit('trim losing position').hash

    const result = await tryAutoPushPaper({ uta, ...PAPER_INPUT })

    expect(result.status).toBe('pushed')
    expect(broker.callCount('placeOrder')).toBe(1)
    expect(uta.status().pendingHash).toBeNull()
    expect(uta.show(hash)?.results[0]).toMatchObject({ status: 'filled' })
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

  it('binds a blocked policy preflight to the approved hash and rejects concurrent replacement writers', async () => {
    const { uta, broker } = createUTA()
    const approvedHash = stageAndCommitBuy(uta, 'approved A')
    const originalGetPositions = broker.getPositions.bind(broker)
    let enterPolicy!: () => void
    let releasePolicy!: () => void
    const policyEntered = new Promise<void>((resolve) => { enterPolicy = resolve })
    const policyReleased = new Promise<void>((resolve) => { releasePolicy = resolve })
    vi.spyOn(broker, 'getPositions').mockImplementationOnce(async () => {
      enterPolicy()
      await policyReleased
      return originalGetPositions()
    })

    const autoPush = tryAutoPushPaper({ uta, ...PAPER_INPUT })
    await policyEntered

    expect(() => uta.stagePlaceOrder({
      aliceId: 'mock-paper|MSFT',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '2',
      stopLoss: { price: '95' },
    })).toThrow(/another account mutation|pending approval/i)
    expect(() => uta.commit('replacement B')).toThrow(/another account mutation|pending approval/i)
    expect(broker.callCount('placeOrder')).toBe(0)

    releasePolicy()
    const result = await autoPush
    expect(result).toMatchObject({ status: 'pushed', hash: approvedHash })
    expect(broker.callCount('placeOrder')).toBe(1)
    expect(uta.show(approvedHash)?.operations).toHaveLength(1)
    expect(uta.show(approvedHash)?.operations[0]).toMatchObject({
      action: 'placeOrder',
      contract: { symbol: 'AAPL' },
    })
    expect(uta.status().pendingHash).toBeNull()
  })

  it('reports a transiently busy mutation lease as push_in_flight, never as mutation_recovery_required', async () => {
    // Regression for a real mislabel bug: resolvePaperAutoPushEligibility must
    // treat status().mutation?.readiness === 'busy' as an in-flight lease
    // (usually this very hash already dispatching), not as a recovery
    // condition — mislabeling it would tell operators a healthy account needs
    // human intervention.
    const { uta, broker } = createUTA()
    const hash = stageAndCommitBuy(uta, 'busy lease probe')
    const originalGetPositions = broker.getPositions.bind(broker)
    let enterPolicy!: () => void
    let releasePolicy!: () => void
    const policyEntered = new Promise<void>((resolve) => { enterPolicy = resolve })
    const policyReleased = new Promise<void>((resolve) => { releasePolicy = resolve })
    vi.spyOn(broker, 'getPositions').mockImplementationOnce(async () => {
      enterPolicy()
      await policyReleased
      return originalGetPositions()
    })

    const autoPush = tryAutoPushPaper({ uta, ...PAPER_INPUT })
    await policyEntered

    expect(uta.status().mutation?.readiness).toBe('busy')
    const resolved = resolvePaperAutoPushEligibility({ uta, ...PAPER_INPUT })
    expect(resolved).toMatchObject({
      ok: false,
      result: { status: 'skipped', reason: 'push_in_flight', pendingHash: hash },
    })

    releasePolicy()
    await autoPush
  })

  it('skips with mutation_recovery_required and no mutation field when readiness is recovery_required', async () => {
    // Poison the mutation coordinator via a synchronous onCommit persistence
    // failure during push's durable-before-broker-dispatch write — the
    // account survives with an active attempt that requires human recovery.
    let commitCalls = 0
    const { uta, broker } = createUTA({
      onCommit: () => {
        commitCalls += 1
        // Calls 1-2 are stage()/commit() — let them succeed so a pending
        // approval exists. Call 3 is push()'s persistAttempt — fail it.
        if (commitCalls >= 3) throw new Error('simulated persistence failure')
      },
    })
    const hash = stageAndCommitBuy(uta, 'poisoned lease probe')

    // The first attempt hits the persistence failure mid-push; TradingGit
    // poisons the coordinator, and executePaperAutoPush's catch resolves it
    // to a skip (readiness recovery_required) rather than propagating.
    const firstAttempt = await tryAutoPushPaper({ uta, ...PAPER_INPUT })
    expect(firstAttempt).toMatchObject({ status: 'skipped', reason: 'mutation_recovery_required' })
    expect(uta.status().mutation?.readiness).toBe('recovery_required')
    expect(broker.callCount('placeOrder')).toBe(0)

    const result = await tryAutoPushPaper({ uta, ...PAPER_INPUT })
    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'mutation_recovery_required',
      pendingHash: hash,
    })
    expect(result).not.toHaveProperty('mutation')
    expect('mutation' in result).toBe(false)
    expect(broker.callCount('placeOrder')).toBe(0)
  })

  it('never auto-pushes a pre-upgrade pending approval before human re-review', async () => {
    const { uta } = createUTA()
    const hash = stageAndCommitBuy(uta, 'legacy pending approval')
    const legacyState = uta.exportGitState()
    delete legacyState.mutation

    const restartedBroker = new MockBroker()
    const restarted = new UnifiedTradingAccount(restartedBroker, {
      savedState: legacyState,
      guardStateBaseDir: mkdtempSync(join(tmpdir(), 'openalice-paper-legacy-guard-')),
      riskStateBaseDir: mkdtempSync(join(tmpdir(), 'openalice-paper-legacy-risk-')),
    })

    expect(restarted.status().mutation?.readiness).toBe('legacy_review_required')
    const result = await tryAutoPushPaper({ uta: restarted, ...PAPER_INPUT })
    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'mutation_recovery_required',
      pendingHash: hash,
    })
    // The `mutation` field was removed from PaperAutoPushResult entirely — a
    // recovery-required skip must not carry it.
    expect(result).not.toHaveProperty('mutation')
    expect('mutation' in result).toBe(false)
    expect(restartedBroker.callCount('placeOrder')).toBe(0)
    expect(restarted.status().pendingHash).toBe(hash)
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
