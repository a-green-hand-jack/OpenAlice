import { describe, it, expect, vi, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order, OrderState } from '@traderalice/ibkr'
import { TradingGit } from './TradingGit.js'
import { MutationRecoveryRequiredError } from './mutation-coordinator.js'
import { markNoBrokerDispatch } from '../guards/guard-pipeline.js'
import type { TradingGitConfig } from './interfaces.js'
import type { Operation, GitExportState, GitState } from './types.js'
import { isMutationEnvelopeV1 } from './types.js'
import '../contract-ext.js'

// ==================== Helpers ====================

function makeContract(overrides: { aliceId?: string; symbol?: string } = {}): Contract {
  const c = new Contract()
  c.aliceId = overrides.aliceId ?? 'mock-paper|AAPL'
  c.symbol = overrides.symbol ?? 'AAPL'
  c.secType = 'STK'
  c.exchange = 'NASDAQ'
  c.currency = 'USD'
  return c
}

function makeGitState(overrides: Partial<GitState> = {}): GitState {
  return {
    totalCashValue: '100000',
    netLiquidation: '105000',
    unrealizedPnL: '5000',
    realizedPnL: '1000',
    positions: [],
    pendingOrders: [],
    ...overrides,
  }
}

function makeConfig(overrides: Partial<TradingGitConfig> = {}): TradingGitConfig {
  return {
    executeOperation: overrides.executeOperation ?? vi.fn().mockResolvedValue({
      success: true,
      orderId: 'order-1',
      execution: { price: 150, shares: 10 },
    }),
    getGitState: overrides.getGitState ?? vi.fn().mockResolvedValue(makeGitState()),
    onCommit: overrides.onCommit,
    accountId: overrides.accountId,
    mutationTimeoutMs: overrides.mutationTimeoutMs,
    allowEphemeralPersistence: overrides.allowEphemeralPersistence ?? true,
  }
}

function buyOp(symbol = 'AAPL'): Operation {
  const contract = makeContract({ symbol })
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'MKT'
  order.totalQuantity = new Decimal(10)
  return { action: 'placeOrder', contract, order }
}

function sellOp(symbol = 'AAPL'): Operation {
  const contract = makeContract({ symbol })
  return { action: 'closePosition', contract }
}

// ==================== Tests ====================

describe('TradingGit', () => {
  let config: TradingGitConfig
  let git: TradingGit

  beforeEach(() => {
    config = makeConfig()
    git = new TradingGit(config)
  })

  // ==================== add ====================

  describe('add', () => {
    it('stages an operation and returns AddResult', () => {
      const result = git.add(buyOp())
      expect(result.staged).toBe(true)
      expect(result.index).toBe(0)
      expect(result.operation.action).toBe('placeOrder')
    })

    it('increments index for multiple adds', () => {
      git.add(buyOp('AAPL'))
      const r2 = git.add(buyOp('GOOG'))
      expect(r2.index).toBe(1)
    })

    it('shows staged operations in status', () => {
      git.add(buyOp())
      const status = git.status()
      expect(status.staged).toHaveLength(1)
      expect(status.pendingMessage).toBeNull()
    })
  })

  // ==================== commit ====================

  describe('commit', () => {
    it('prepares a commit with hash and message', () => {
      git.add(buyOp())
      const result = git.commit('Buy AAPL')
      expect(result.prepared).toBe(true)
      expect(result.hash).toHaveLength(8)
      expect(result.message).toBe('Buy AAPL')
      expect(result.operationCount).toBe(1)
    })

    it('throws when staging area is empty', () => {
      expect(() => git.commit('empty commit')).toThrow('Nothing to commit')
    })

    it('updates status with pending message', () => {
      git.add(buyOp())
      git.commit('msg')
      const status = git.status()
      expect(status.pendingMessage).toBe('msg')
    })
  })

  // ==================== push ====================

  describe('push', () => {
    it('executes operations and returns PushResult', async () => {
      git.add(buyOp())
      git.commit('Buy AAPL')
      const result = await git.push()

      expect(result.hash).toHaveLength(8)
      expect(result.message).toBe('Buy AAPL')
      expect(result.operationCount).toBe(1)
      expect(result.submitted).toHaveLength(1)
      expect(result.rejected).toHaveLength(0)
    })

    it('calls executeOperation for each staged op', async () => {
      git.add(buyOp('AAPL'))
      git.add(buyOp('GOOG'))
      git.commit('Two buys')
      await git.push()

      expect(config.executeOperation).toHaveBeenCalledTimes(2)
    })

    it('calls getGitState after execution', async () => {
      git.add(buyOp())
      git.commit('msg')
      await git.push()

      expect(config.getGitState).toHaveBeenCalled()
    })

    it('clears staging area after push', async () => {
      git.add(buyOp())
      git.commit('msg')
      await git.push()

      const status = git.status()
      expect(status.staged).toHaveLength(0)
      expect(status.pendingMessage).toBeNull()
    })

    it('throws when staging area is empty', async () => {
      await expect(git.push()).rejects.toThrow('Nothing to push')
    })

    it('throws when not committed', async () => {
      git.add(buyOp())
      await expect(git.push()).rejects.toThrow('please commit first')
    })

    it('calls onCommit callback with exported state after each state transition', async () => {
      const onCommit = vi.fn()
      const gitWithCb = new TradingGit({ ...config, onCommit })

      gitWithCb.add(buyOp())
      gitWithCb.commit('msg')
      await gitWithCb.push()

      // add, commit, prepared, dispatching, confirmed, final commit
      expect(onCommit).toHaveBeenCalledTimes(6)
      expect(onCommit.mock.calls[0][0]).toMatchObject({
        commits: [],
        head: null,
        stagingArea: expect.any(Array),
        pendingMessage: null,
        pendingHash: null,
      })
      expect(onCommit.mock.calls[1][0]).toMatchObject({
        commits: [],
        head: null,
        pendingMessage: 'msg',
      })
      const exported = onCommit.mock.calls[5][0]
      expect(exported.commits).toHaveLength(1)
      expect(exported.head).toHaveLength(8)
      expect(exported.stagingArea).toEqual([])
      expect(exported.pendingMessage).toBeNull()
      expect(exported.pendingHash).toBeNull()
    })

    it('quarantines generic failed broker responses as uncertain', async () => {
      const failConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: false, error: 'Insufficient funds' }),
      })
      const gitFail = new TradingGit(failConfig)

      gitFail.add(buyOp())
      gitFail.commit('msg')
      await expect(gitFail.push()).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      expect(gitFail.status().mutation).toMatchObject({
        readiness: 'recovery_required',
        activeAttempt: {
          operations: [{ state: 'uncertain', result: { status: 'uncertain' } }],
        },
      })
    })

    it('quarantines operation exceptions as uncertain', async () => {
      const failConfig = makeConfig({
        executeOperation: vi.fn().mockRejectedValue(new Error('Network error')),
      })
      const gitFail = new TradingGit(failConfig)

      gitFail.add(buyOp())
      gitFail.commit('msg')
      await expect(gitFail.push()).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      expect(gitFail.status().mutation?.activeAttempt?.operations[0]).toMatchObject({
        state: 'uncertain',
        error: 'Network error',
      })
    })

    it('categorizes pending orders correctly', async () => {
      const pendingConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'order-2',
        }),
      })
      const gitPending = new TradingGit(pendingConfig)

      gitPending.add(buyOp())
      gitPending.commit('limit order')
      const result = await gitPending.push()

      expect(result.submitted).toHaveLength(1)
      expect(result.rejected).toHaveLength(0)
    })

    it('maps Filled orderState to filled status', async () => {
      const orderState = new OrderState()
      orderState.status = 'Filled'
      const filledConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'order-filled',
          orderState,
        }),
      })
      const gitFilled = new TradingGit(filledConfig)

      gitFilled.add(buyOp())
      gitFilled.commit('market buy')
      const result = await gitFilled.push()

      expect(result.submitted).toHaveLength(1)
      expect(result.submitted[0].status).toBe('filled')
      expect(result.rejected).toHaveLength(0)
    })

    it('maps Cancelled orderState to cancelled status', async () => {
      const orderState = new OrderState()
      orderState.status = 'Cancelled'
      const cancelConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'order-cancel',
          orderState,
        }),
      })
      const gitCancel = new TradingGit(cancelConfig)

      gitCancel.add({ action: 'cancelOrder', orderId: 'order-cancel' })
      gitCancel.commit('cancel order')
      const result = await gitCancel.push()

      expect(result.submitted).toHaveLength(1)
      expect(result.submitted[0].status).toBe('cancelled')
      expect(result.rejected).toHaveLength(0)
    })

    it('defaults to submitted when no orderState', async () => {
      const noStateConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'order-async',
        }),
      })
      const gitAsync = new TradingGit(noStateConfig)

      gitAsync.add(buyOp())
      gitAsync.commit('async limit')
      const result = await gitAsync.push()

      expect(result.submitted).toHaveLength(1)
      expect(result.submitted[0].status).toBe('submitted')
    })

    it('maps Inactive orderState to rejected status', async () => {
      const orderState = new OrderState()
      orderState.status = 'Inactive'
      const inactiveConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'order-inactive',
          orderState,
        }),
      })
      const gitInactive = new TradingGit(inactiveConfig)

      gitInactive.add(buyOp())
      gitInactive.commit('rejected by exchange')
      const result = await gitInactive.push()

      // Inactive maps to rejected — but success is still true from broker
      // so it lands in submitted (success-based), with status 'rejected'
      expect(result.submitted).toHaveLength(1)
      expect(result.submitted[0].status).toBe('rejected')
    })

    it('quarantines a generic failed cancel response instead of treating it as non-acceptance proof', async () => {
      const failConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: false,
          error: 'Order not found',
        }),
      })
      const gitFail = new TradingGit(failConfig)

      gitFail.add({ action: 'cancelOrder', orderId: 'nonexistent' })
      gitFail.commit('cancel unknown')
      await expect(gitFail.push()).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      expect(gitFail.status().mutation?.activeAttempt?.operations[0]).toMatchObject({
        state: 'uncertain',
        error: 'Order not found',
      })
    })
  })

  describe('durable mutation coordinator', () => {
    const humanApprover = {
      via: 'alice-bff' as const,
      fingerprint: 'fp-human',
      at: '2026-07-10T00:00:00.000Z',
    }

    it('requires an explicit durable persister outside the test-only ephemeral mode', () => {
      expect(() => new TradingGit({
        executeOperation: vi.fn(),
        getGitState: vi.fn().mockResolvedValue(makeGitState()),
      })).toThrow(/requires a synchronous durable persister/i)
    })

    it('durably records dispatching and clears legacy replay fields before calling the broker', async () => {
      let latest: GitExportState | undefined
      const executeOperation = vi.fn(async () => {
        expect(latest?.stagingArea).toEqual([])
        expect(latest?.pendingMessage).toBeNull()
        expect(latest?.pendingHash).toBeNull()
        expect(latest?.mutation?.schemaVersion).toBe(1)
        expect((latest?.mutation as { activeAttempt?: { operations: Array<{ state: string }> } })
          .activeAttempt?.operations[0].state).toBe('dispatching')
        return { success: true, orderId: 'durable-1' }
      })
      const durable = new TradingGit(makeConfig({
        executeOperation,
        onCommit: (state) => { latest = JSON.parse(JSON.stringify(state)) },
      }))

      durable.add(buyOp())
      durable.commit('durable order')
      await durable.push(humanApprover)

      expect(executeOperation).toHaveBeenCalledOnce()
      expect(latest?.mutation).toEqual({ schemaVersion: 1 })
    })

    it('freezes a committed approval until it is pushed or rejected', () => {
      const durable = new TradingGit(makeConfig())
      durable.add(buyOp('AAPL'))
      const pending = durable.commit('approval A')

      expect(() => durable.add(buyOp('MSFT'))).toThrow(/pending approval already exists/i)
      expect(() => durable.commit('replacement B')).toThrow(/pending approval already exists/i)
      expect(durable.status()).toMatchObject({
        pendingHash: pending.hash,
        pendingMessage: 'approval A',
        staged: [expect.objectContaining({ action: 'placeOrder' })],
      })
    })

    it('binds async preflight and dispatch to one exact approval under the same lease', async () => {
      let enterPreflight!: () => void
      let releasePreflight!: () => void
      const entered = new Promise<void>((resolve) => { enterPreflight = resolve })
      const released = new Promise<void>((resolve) => { releasePreflight = resolve })
      const executeOperation = vi.fn().mockResolvedValue({ success: true, orderId: 'bound-A' })
      const durable = new TradingGit(makeConfig({ executeOperation }))
      durable.add(buyOp('AAPL'))
      const pending = durable.commit('approval A')

      const push = durable.push(humanApprover, {
        expectedHash: pending.hash,
        preflight: async (context) => {
          expect(context).toMatchObject({
            hash: pending.hash,
            message: 'approval A',
            operations: [expect.objectContaining({ action: 'placeOrder' })],
          })
          enterPreflight()
          await released
        },
      })
      await entered

      expect(durable.status().mutation).toMatchObject({ readiness: 'busy' })
      expect(durable.status().mutation?.activeAttempt).toBeUndefined()
      expect(() => durable.add(buyOp('MSFT'))).toThrow('Another account mutation')
      expect(() => durable.commit('replacement B')).toThrow('Another account mutation')
      expect(executeOperation).not.toHaveBeenCalled()

      releasePreflight()
      const result = await push
      expect(result.hash).toBe(pending.hash)
      expect(executeOperation).toHaveBeenCalledOnce()
      expect(durable.show(result.hash)?.operations).toHaveLength(1)
    })

    it('refuses a stale expected hash before preflight or broker dispatch', async () => {
      const preflight = vi.fn()
      const executeOperation = vi.fn()
      const durable = new TradingGit(makeConfig({ executeOperation }))
      durable.add(buyOp())
      const pending = durable.commit('approval A')

      await expect(durable.push(humanApprover, {
        expectedHash: 'deadbeef',
        preflight,
      })).rejects.toMatchObject({ code: 'PENDING_APPROVAL_CHANGED' })
      expect(preflight).not.toHaveBeenCalled()
      expect(executeOperation).not.toHaveBeenCalled()
      expect(durable.status().pendingHash).toBe(pending.hash)
    })

    it('does not call the broker when persisting dispatching fails', async () => {
      const executeOperation = vi.fn()
      const onCommit = vi.fn((state: GitExportState) => {
        const attempt = isMutationEnvelopeV1(state.mutation) ? state.mutation.activeAttempt : undefined
        if (attempt?.operations[0]?.state === 'dispatching') {
          throw new Error('disk full before dispatch')
        }
      })
      const durable = new TradingGit(makeConfig({ executeOperation, onCommit }))
      durable.add(buyOp())
      durable.commit('must not dispatch')

      await expect(durable.push(humanApprover)).rejects.toThrow('disk full before dispatch')
      expect(executeOperation).not.toHaveBeenCalled()
      expect(durable.status().mutation?.readiness).toBe('recovery_required')
      const attemptId = durable.status().mutation?.activeAttempt?.attemptId
      await expect(durable.resolveMutation({
        attemptId: attemptId!,
        action: 'discard-never-dispatched',
        reason: 'should require restart after lost fsync acknowledgement',
        confirmation: attemptId!,
        approver: humanApprover,
      })).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
    })

    it('logs a structured secret-free CRITICAL recovery record on persistence failure', async () => {
      const operation = buyOp()
      if (operation.action === 'placeOrder') operation.order.orderRef = 'must-not-reach-log'
      // The persister failure itself carries a secret in its MESSAGE — the
      // exact leak class this log once had: arbitrary error text can embed
      // API keys, paths, or upstream payloads. Only stable classification
      // fields (error name/code) may reach the structured log.
      class UpstreamWriteError extends Error {
        code = 'EIO'
      }
      const onCommit = vi.fn((state: GitExportState) => {
        const attempt = isMutationEnvelopeV1(state.mutation) ? state.mutation.activeAttempt : undefined
        if (attempt?.operations[0]?.state === 'dispatching') {
          throw new UpstreamWriteError('write failed for https://user:sk-SECRET-API-KEY@broker.example/api')
        }
      })
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const durable = new TradingGit(makeConfig({
        accountId: 'paper-safe-id',
        executeOperation: vi.fn(),
        onCommit,
      }))
      durable.add(operation)
      const pending = durable.commit('secret-free log')

      await expect(durable.push(humanApprover)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)

      const critical = error.mock.calls.find(([label]) =>
        label === '[TradingGit] CRITICAL mutation persistence failure')
      expect(critical).toBeDefined()
      expect(critical?.[1]).toMatchObject({
        accountId: 'paper-safe-id',
        pendingHash: pending.hash,
        attemptId: expect.any(String),
        recovery: 'restart-and-resolve-before-any-further-write',
        errorName: 'Error',
        errorCode: 'EIO',
      })
      const logged = JSON.stringify(critical)
      expect(logged).not.toContain('sk-SECRET-API-KEY')
      expect(logged).not.toContain('must-not-reach-log')
      expect(logged).not.toContain('write failed for')
      error.mockRestore()
    })

    it('quarantines broker success when the confirmed receipt cannot be durably acknowledged', async () => {
      let persisted: GitExportState | undefined
      const executeOperation = vi.fn().mockResolvedValue({ success: true, orderId: 'venue-once' })
      const onCommit = vi.fn((state: GitExportState) => {
        const attempt = isMutationEnvelopeV1(state.mutation) ? state.mutation.activeAttempt : undefined
        if (attempt?.operations[0]?.state === 'confirmed') {
          throw new Error('receipt fsync failed')
        }
        persisted = JSON.parse(JSON.stringify(state))
      })
      const durable = new TradingGit(makeConfig({ executeOperation, onCommit }))
      durable.add(buyOp())
      durable.commit('one venue call')

      await expect(durable.push(humanApprover)).rejects.toThrow('receipt fsync failed')
      expect(executeOperation).toHaveBeenCalledOnce()

      const retryBroker = vi.fn()
      const restored = TradingGit.restore(persisted!, makeConfig({ executeOperation: retryBroker }))
      expect(restored.status().mutation?.activeAttempt?.operations[0].state).toBe('uncertain')
      await expect(restored.push(humanApprover)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      expect(retryBroker).not.toHaveBeenCalled()
    })

    it('stops a multi-operation attempt at the first uncertain result', async () => {
      const executeOperation = vi.fn()
        .mockResolvedValueOnce({ success: true, orderId: 'confirmed-1' })
        .mockResolvedValueOnce(markNoBrokerDispatch({ success: false, error: 'local policy' }))
        .mockResolvedValueOnce({ success: false, error: 'transport gave no acceptance proof' })
        .mockResolvedValueOnce({ success: true, orderId: 'must-not-run' })
      const durable = new TradingGit(makeConfig({ executeOperation }))
      for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'GOOG']) durable.add(buyOp(symbol))
      durable.commit('mixed outcomes')

      await expect(durable.push(humanApprover)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      expect(executeOperation).toHaveBeenCalledTimes(3)
      expect(durable.status().mutation?.activeAttempt?.operations.map((entry) => entry.state)).toEqual([
        'confirmed',
        'definitely_rejected',
        'uncertain',
        'prepared',
      ])
    })

    it('times out a never-settling broker dispatch into durable uncertainty and releases the lease', async () => {
      const executeOperation = vi.fn(() => new Promise<never>(() => {}))
      const durable = new TradingGit(makeConfig({
        executeOperation,
        mutationTimeoutMs: 10,
      }))
      durable.add(buyOp())
      durable.commit('never settles')

      await expect(durable.push(humanApprover)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      expect(executeOperation).toHaveBeenCalledOnce()
      expect(durable.status().mutation).toMatchObject({
        readiness: 'recovery_required',
        restartRequired: true,
        activeAttempt: {
          operations: [{ state: 'uncertain', error: expect.stringContaining('timed out') }],
        },
      })
    })

    it('latches a timed-out dispatch as restart-required: no coexistence of the old call and a replacement', async () => {
      let settleDispatch!: (value: unknown) => void
      const orphanedCall = new Promise<unknown>((resolve) => { settleDispatch = resolve })
      let persisted: GitExportState | undefined
      const executeOperation = vi.fn().mockImplementationOnce(() => orphanedCall)
      const durable = new TradingGit(makeConfig({
        executeOperation,
        mutationTimeoutMs: 10,
        onCommit: (state) => { persisted = JSON.parse(JSON.stringify(state)) },
      }))
      durable.add(buyOp('AAPL'))
      durable.add(buyOp('MSFT')) // never reached — stays prepared
      durable.commit('dispatch will time out')

      await expect(durable.push(humanApprover)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      expect(executeOperation).toHaveBeenCalledTimes(1)
      const status = durable.status().mutation
      expect(status).toMatchObject({ readiness: 'recovery_required', restartRequired: true })
      const attemptId = status?.activeAttempt?.attemptId

      // While the venue request may still land, EVERY new mutation and EVERY
      // human resolution in this process must refuse with a restart demand.
      await expect(durable.push(humanApprover)).rejects.toThrow(/restarted/)
      const resolveInput = {
        attemptId: attemptId!,
        action: 'acknowledge-uncertainty' as const,
        reason: 'operator checked the venue',
        confirmation: attemptId!,
        approver: humanApprover,
      }
      await expect(durable.resolveMutation(resolveInput)).rejects.toThrow(/restarted/)

      // The orphaned call settles late with a venue ACCEPTANCE. The outcome is
      // recorded durably as evidence — but the restart latch must NOT lift:
      // this process still cannot resolve or start replacement mutations.
      settleDispatch({ success: true, orderId: 'venue-late-1' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const lateOps = isMutationEnvelopeV1(persisted?.mutation)
        ? persisted?.mutation.activeAttempt?.operations
        : undefined
      expect(lateOps?.[0].state).toBe('confirmed')
      expect(durable.status().mutation?.restartRequired).toBe(true)
      await expect(durable.resolveMutation(resolveInput)).rejects.toThrow(/restarted/)
      await expect(durable.push(humanApprover)).rejects.toThrow(/restarted/)

      // A REAL restart (fresh process restoring the durable state) is the only
      // exit. The late-recorded acceptance is present; finalization makes ZERO
      // broker calls — the old call and a replacement can never coexist.
      const retryBroker = vi.fn()
      const restored = TradingGit.restore(persisted!, makeConfig({ executeOperation: retryBroker }))
      const restoredOps = restored.status().mutation?.activeAttempt?.operations
      expect(restoredOps?.map((entry) => entry.state)).toEqual(['confirmed', 'prepared'])
      expect(restoredOps?.[0].evidence?.type).toBe('late-broker-outcome')
      const resolved = await restored.resolveMutation({
        ...resolveInput,
        action: 'finalize-known-outcomes',
        reason: 'venue reconciled after restart',
      })
      expect(resolved).toMatchObject({ resolved: true, readiness: 'ready' })
      expect(retryBroker).not.toHaveBeenCalled()
      const commit = restored.show(resolved.hash!)
      expect(commit?.results[0]).toMatchObject({ success: true, orderId: 'venue-late-1' })
      expect(commit?.results[1]).toMatchObject({ success: false, status: 'user-rejected' })
    })

    it('fails closed when the persister is asynchronous or returns a thenable', () => {
      expect(() => new TradingGit(makeConfig({
        onCommit: (async () => {}) as unknown as (state: GitExportState) => void,
      }))).toThrow(/must be synchronous/i)

      const executeOperation = vi.fn()
      const thenable = new TradingGit(makeConfig({
        executeOperation,
        onCommit: (() => Promise.resolve()) as unknown as (state: GitExportState) => void,
      }))
      expect(() => thenable.add(buyOp())).toThrow(/thenable/)
      // A started-but-unawaited write means memory can no longer be trusted:
      // poisoned, restart required, and the broker was never reachable.
      expect(thenable.status().mutation).toMatchObject({
        readiness: 'recovery_required',
        restartRequired: true,
      })
      expect(executeOperation).not.toHaveBeenCalled()
    })

    it('detaches durable audit from caller-owned objects (input aliasing)', async () => {
      let persisted: GitExportState | undefined
      const approver = { via: 'alice-bff' as const, fingerprint: 'original-reviewer', at: humanApprover.at }
      const context = { reason: 'halt requested by human', cancelOrders: true }
      const durable = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: true, orderId: 'ok-1' }),
        onCommit: (state) => { persisted = JSON.parse(JSON.stringify(state)) },
      }))
      durable.add(buyOp())
      durable.commit('aliasing probe')
      await durable.push(approver)
      await durable.executeSyntheticMutation({
        kind: 'emergency_cancel',
        message: 'halt audit',
        approver,
        context,
        prepare: async () => [],
        execute: vi.fn(),
      })

      // Caller mutates ITS objects after both mutations finalized…
      approver.fingerprint = 'tampered-after-push'
      context.reason = 'tampered-reason'
      // …and a later ledger write re-persists the full history.
      durable.add(sellOp())

      expect(persisted?.commits[0].approver?.fingerprint).toBe('original-reviewer')
      expect(persisted?.commits[0].mutationAudit?.initiator.fingerprint).toBe('original-reviewer')
      expect(persisted?.commits[1].mutationAudit?.context?.reason).toBe('halt requested by human')
    })

    it('allowlists persisted orderState and legs — account identifiers never reach disk', async () => {
      const durable = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'venue-1',
          orderState: {
            status: 'Filled',
            rejectReason: 'none',
            orderAllocations: [{ account: 'U-SECRET-7788' }],
            initMarginAfter: 'SECRET-MARGIN',
          },
          legs: [{ orderId: 'leg-1', kind: 'takeProfit', account: 'U-SECRET-LEG' }],
        }),
      }))
      durable.add(buyOp())
      durable.commit('hostile order state')
      await durable.push(humanApprover)

      const persisted = JSON.stringify(durable.exportState())
      expect(persisted).not.toContain('U-SECRET-7788')
      expect(persisted).not.toContain('U-SECRET-LEG')
      expect(persisted).not.toContain('SECRET-MARGIN')
      expect(persisted).not.toContain('orderAllocations')
      const result = durable.show(durable.status().head!)!.results[0]
      expect(result.orderState).toEqual({ status: 'Filled', rejectReason: 'none' })
      expect(result.legs).toEqual([{ orderId: 'leg-1', kind: 'takeProfit' }])
    })

    it('refuses a reconcile whose drift decision predates the current head', async () => {
      const durable = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: true, orderId: 'o-1' }),
      }))
      // Caller captures head (null), then the ledger advances before its
      // broker-snapshot-based drift decision reaches the writer.
      const staleHead = durable.status().head
      durable.add(buyOp())
      durable.commit('advance head')
      await durable.push(humanApprover)
      const before = durable.status().commitCount

      const stale = await durable.recordReconcile({
        aliceId: 'mock-paper|AAPL',
        quantityDelta: new Decimal('5'),
        markPrice: new Decimal('100'),
        stateAfter: makeGitState(),
        expectedHead: staleHead,
      })
      expect(stale).toBeNull()
      expect(durable.status().commitCount).toBe(before)

      const fresh = await durable.recordReconcile({
        aliceId: 'mock-paper|AAPL',
        quantityDelta: new Decimal('5'),
        markPrice: new Decimal('100'),
        stateAfter: makeGitState(),
        expectedHead: durable.status().head,
      })
      expect(fresh).toHaveLength(8)
      expect(durable.status().commitCount).toBe(before + 1)
    })

    it('captures the sync snapshot inside the ledger lease, never from the caller', async () => {
      let snapshotCount = 0
      const durable = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: true, orderId: 'order-1' }),
        getGitState: vi.fn(async () => makeGitState({ netLiquidation: String(100000 + ++snapshotCount) })),
      }))
      durable.add(buyOp())
      durable.commit('resting order')
      await durable.push(humanApprover) // consumes snapshot #1 for its own finalization

      await durable.sync([{
        orderId: 'order-1',
        symbol: 'AAPL',
        previousStatus: 'submitted',
        currentStatus: 'filled',
        filledPrice: '155',
        filledQty: '10',
      }])

      // The sync commit carries the state fetched DURING sync (#2) — a caller
      // snapshot taken before the lease could be stale by a whole push.
      const head = durable.show(durable.status().head!)
      expect(head?.stateAfter.netLiquidation).toBe('100002')
    })

    it('allows retrying discard-never-dispatched after a failed finalization snapshot', async () => {
      let persisted: GitExportState | undefined
      const failing = new TradingGit(makeConfig({
        executeOperation: vi.fn(),
        onCommit: (state) => {
          const attempt = isMutationEnvelopeV1(state.mutation) ? state.mutation.activeAttempt : undefined
          if (attempt?.operations.some((entry) => entry.state === 'dispatching')) {
            throw new Error('fsync fail before dispatch')
          }
          persisted = JSON.parse(JSON.stringify(state))
        },
      }))
      failing.add(buyOp())
      failing.commit('prepared only')
      await expect(failing.push(humanApprover)).rejects.toThrow('fsync fail before dispatch')

      // Fresh process restores the all-prepared attempt; the first discard
      // durably applies its decision but the finalization snapshot fails.
      const getGitState = vi.fn()
        .mockRejectedValueOnce(new Error('snapshot offline'))
        .mockResolvedValue(makeGitState())
      const restored = TradingGit.restore(persisted!, makeConfig({ getGitState }))
      const attemptId = restored.status().mutation?.activeAttempt?.attemptId
      const discard = {
        attemptId: attemptId!,
        action: 'discard-never-dispatched' as const,
        reason: 'durable state proves dispatch never began',
        confirmation: attemptId!,
        approver: humanApprover,
      }
      await expect(restored.resolveMutation(discard)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)

      // Retrying the SAME action completes: phase 1 already marked every
      // operation definitely_rejected, which the retry accepts idempotently.
      const resolved = await restored.resolveMutation(discard)
      expect(resolved).toMatchObject({ resolved: true, readiness: 'ready' })
      expect(restored.status().mutation?.activeAttempt).toBeUndefined()
    })

    it('bounds preflight before an attempt exists and leaves the approval pending', async () => {
      const executeOperation = vi.fn()
      const durable = new TradingGit(makeConfig({ executeOperation, mutationTimeoutMs: 10 }))
      durable.add(buyOp())
      const pending = durable.commit('bounded preflight')

      await expect(durable.push(humanApprover, {
        expectedHash: pending.hash,
        preflight: () => new Promise<never>(() => {}),
      })).rejects.toThrow('push preflight timed out')
      expect(executeOperation).not.toHaveBeenCalled()
      expect(durable.status()).toMatchObject({
        pendingHash: pending.hash,
        mutation: { readiness: 'ready' },
      })
      expect(durable.status().mutation?.activeAttempt).toBeUndefined()
    })

    it('bounds synthetic prepare without clearing an existing approval', async () => {
      const durable = new TradingGit(makeConfig({ mutationTimeoutMs: 10 }))
      durable.add(buyOp())
      const pending = durable.commit('keep while prepare hangs')

      await expect(durable.executeSyntheticMutation({
        kind: 'emergency_cancel',
        message: 'bounded prepare',
        prepare: () => new Promise<never>(() => {}),
        execute: vi.fn(),
      })).rejects.toThrow('emergency_cancel prepare timed out')
      expect(durable.status()).toMatchObject({
        pendingHash: pending.hash,
        mutation: { readiness: 'ready' },
      })
      expect(durable.status().mutation?.activeAttempt).toBeUndefined()
    })

    it('reports busy and fail-fast serializes every ledger writer while broker dispatch is in flight', async () => {
      let enterDispatch!: () => void
      let releaseDispatch!: (value: unknown) => void
      const entered = new Promise<void>((resolve) => { enterDispatch = resolve })
      const blockedResult = new Promise<unknown>((resolve) => { releaseDispatch = resolve })
      const durable = new TradingGit(makeConfig({
        executeOperation: vi.fn(async () => {
          enterDispatch()
          return blockedResult
        }),
      }))
      durable.add(buyOp())
      durable.commit('lease holder')
      const push = durable.push(humanApprover)
      await entered

      expect(durable.status().mutation?.readiness).toBe('busy')
      expect(() => durable.add(buyOp('MSFT'))).toThrow('Another account mutation')
      await expect(durable.recordReconcile({
        aliceId: 'mock-paper|CASH',
        quantityDelta: new Decimal(1),
        markPrice: new Decimal(1),
        stateAfter: makeGitState(),
        expectedHead: durable.status().head,
      })).rejects.toThrow('Another account mutation')

      releaseDispatch({ success: true, orderId: 'leased-1' })
      await push
      expect(durable.status().mutation?.readiness).toBe('ready')
    })

    it('keeps durable confirmed outcomes quarantined when the final state snapshot fails', async () => {
      const durable = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: true, orderId: 'confirmed-1' }),
        getGitState: vi.fn().mockRejectedValue(new Error('snapshot unavailable')),
      }))
      durable.add(buyOp())
      durable.commit('snapshot may fail')

      await expect(durable.push(humanApprover)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      expect(durable.status()).toMatchObject({
        commitCount: 0,
        pendingHash: null,
        mutation: {
          readiness: 'recovery_required',
          activeAttempt: { operations: [{ state: 'confirmed' }] },
        },
      })
    })

    it('preserves allowlisted broker receipt metadata and fill evidence without account secrets', async () => {
      const filled = new OrderState()
      filled.status = 'Filled'
      const durable = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'venue-order-42',
          orderState: filled,
          execution: {
            orderId: 42,
            execId: 'exec-42',
            time: '2026-07-10T12:34:56Z',
            acctNumber: 'SECRET-ACCOUNT',
            exchange: 'NASDAQ',
            side: 'BOT',
            shares: '0.125',
            price: 123.456789,
            permId: 9001,
            clientId: 7,
            cumQty: '0.125',
            orderRef: 'alice-request-7',
            modelCode: 'SECRET-MODEL',
            submitter: 'SECRET-SUBMITTER',
            lastLiquidity: 2,
          },
        }),
        getGitState: vi.fn().mockRejectedValue(new Error('hold receipt in quarantine')),
      }))
      durable.add(buyOp())
      durable.commit('receipt evidence')

      await expect(durable.push(humanApprover)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)

      const operation = durable.status().mutation?.activeAttempt?.operations[0]
      expect(operation?.result).toMatchObject({
        status: 'filled',
        filledQty: '0.125',
        filledPrice: '123.456789',
        receipt: {
          executionId: 'exec-42',
          executedAt: '2026-07-10T12:34:56Z',
          brokerOrderId: '42',
          permanentId: '9001',
          clientId: '7',
          orderRef: 'alice-request-7',
          exchange: 'NASDAQ',
          side: 'BOT',
          cumulativeQty: '0.125',
          lastLiquidity: '2',
        },
      })
      const persisted = JSON.parse(JSON.stringify(durable.exportState())) as GitExportState
      expect(JSON.stringify(persisted)).not.toContain('SECRET-ACCOUNT')
      expect(JSON.stringify(persisted)).not.toContain('SECRET-MODEL')
      expect(JSON.stringify(persisted)).not.toContain('SECRET-SUBMITTER')
      const restored = TradingGit.restore(persisted, makeConfig())
      expect(restored.status().mutation?.activeAttempt?.operations[0].result)
        .toEqual(operation?.result)
    })

    it('linearizes reject before final commit so a failed finalization cannot resurrect approval', async () => {
      let persisted: GitExportState | undefined
      const onCommit = vi.fn((state: GitExportState) => {
        const active = isMutationEnvelopeV1(state.mutation) ? state.mutation.activeAttempt : undefined
        if (!active && state.commits.length === 1) throw new Error('reject finalization fsync failed')
        persisted = JSON.parse(JSON.stringify(state))
      })
      const durable = new TradingGit(makeConfig({ onCommit }))
      durable.add(buyOp())
      durable.commit('reject me')

      await expect(durable.reject('human said no', humanApprover)).rejects.toThrow('reject finalization fsync failed')
      expect(persisted?.stagingArea).toEqual([])
      expect(persisted?.pendingHash).toBeNull()
      expect(isMutationEnvelopeV1(persisted?.mutation)
        ? persisted.mutation.activeAttempt?.kind
        : undefined).toBe('human_reject')

      const restored = TradingGit.restore(persisted!, makeConfig())
      expect(restored.status().mutation?.readiness).toBe('recovery_required')
      await expect(restored.push(humanApprover)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
    })

    it('fails all writes closed for a future mutation schema while preserving reads', async () => {
      const state: GitExportState = {
        commits: [],
        head: null,
        stagingArea: [],
        pendingMessage: null,
        pendingHash: null,
        mutation: { schemaVersion: 99, activeAttempt: { opaque: true } },
      }
      const future = TradingGit.restore(state, makeConfig())

      expect(future.status().mutation).toMatchObject({
        schemaVersion: 99,
        readiness: 'unsupported_schema',
        downgradeBlocked: true,
      })
      expect(future.log()).toEqual([])
      expect(() => future.add(buyOp())).toThrow(/schema 99/i)
      await expect(future.sync([
        { orderId: 'o-1', symbol: 'AAPL', previousStatus: 'submitted', currentStatus: 'filled' },
      ])).rejects.toThrow(/schema 99/i)
    })

    it('requires authenticated human re-review for a legacy pending approval', async () => {
      const original = new TradingGit(makeConfig())
      original.add(buyOp())
      original.commit('legacy pending')
      const legacy = JSON.parse(JSON.stringify(original.exportState())) as GitExportState
      delete legacy.mutation

      const executeOperation = vi.fn().mockResolvedValue({ success: true, orderId: 'reviewed' })
      const restored = TradingGit.restore(legacy, makeConfig({ executeOperation }))
      expect(restored.status().mutation?.readiness).toBe('legacy_review_required')
      await expect(restored.push({ via: 'auto-push-paper', at: humanApprover.at }))
        .rejects.toThrow(/human re-review/i)
      await expect(restored.push()).rejects.toThrow(/human re-review/i)
      expect(executeOperation).not.toHaveBeenCalled()

      await restored.push(humanApprover)
      expect(executeOperation).toHaveBeenCalledOnce()
      expect(restored.status().mutation?.readiness).toBe('ready')
    })

    it('runs a zero-operation synthetic mutation as a durable audit commit with no broker call', async () => {
      const execute = vi.fn()
      const durable = new TradingGit(makeConfig())
      const result = await durable.executeSyntheticMutation({
        kind: 'emergency_cancel',
        message: '[emergency-stop] HALT; cancelOrders=false',
        approver: humanApprover,
        prepare: async () => [],
        execute,
      })

      expect(execute).not.toHaveBeenCalled()
      expect(result.operationCount).toBe(0)
      expect(durable.status()).toMatchObject({ commitCount: 1, mutation: { readiness: 'ready' } })
      expect(durable.show(result.hash)?.message).toContain('cancelOrders=false')
    })

    it('retains uncertainty in the finalized audit after explicit human acknowledgement', async () => {
      const durable = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: false, error: 'timeout' }),
      }))
      durable.add(buyOp())
      durable.commit('uncertain order')
      await expect(durable.push(humanApprover)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      const attemptId = durable.status().mutation?.activeAttempt?.attemptId

      const resolution = await durable.resolveMutation({
        attemptId: attemptId!,
        action: 'acknowledge-uncertainty',
        reason: 'operator checked venue and accepts unresolved historical outcome',
        confirmation: attemptId!,
        approver: humanApprover,
      })

      expect(resolution).toMatchObject({ resolved: true, readiness: 'ready' })
      expect(durable.show(resolution.hash!)?.results[0]).toMatchObject({
        success: false,
        status: 'uncertain',
      })
      expect(durable.status().mutation?.activeAttempt).toBeUndefined()
    })

    it('keeps resolution decisions append-only across failed finalization and restart', async () => {
      let persisted: GitExportState | undefined
      const durable = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: false, error: 'ambiguous timeout' }),
        getGitState: vi.fn().mockRejectedValue(new Error('snapshot still unavailable')),
        onCommit: (state) => { persisted = JSON.parse(JSON.stringify(state)) },
      }))
      durable.add(buyOp())
      durable.commit('append-only decisions')
      await expect(durable.push(humanApprover)).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      const attemptId = durable.status().mutation?.activeAttempt?.attemptId
      const firstApprover = { ...humanApprover, fingerprint: 'first-reviewer' }

      await expect(durable.resolveMutation({
        attemptId: attemptId!,
        action: 'acknowledge-uncertainty',
        reason: 'first venue review',
        confirmation: attemptId!,
        approver: firstApprover,
      })).rejects.toBeInstanceOf(MutationRecoveryRequiredError)
      expect(isMutationEnvelopeV1(persisted?.mutation)
        ? persisted.mutation.activeAttempt?.resolutions
        : undefined).toHaveLength(1)

      const restarted = TradingGit.restore(persisted!, makeConfig({
        getGitState: vi.fn().mockResolvedValue(makeGitState()),
      }))
      const projected = restarted.status().mutation?.activeAttempt?.resolutions
      projected![0].approver.fingerprint = 'tampered-projection'
      expect(restarted.status().mutation?.activeAttempt?.resolutions?.[0].approver.fingerprint)
        .toBe('first-reviewer')
      const secondApprover = { ...humanApprover, fingerprint: 'second-reviewer' }
      const resolved = await restarted.resolveMutation({
        attemptId: attemptId!,
        action: 'acknowledge-uncertainty',
        reason: 'second venue review after restart',
        confirmation: attemptId!,
        approver: secondApprover,
      })

      expect(restarted.show(resolved.hash!)?.mutationAudit).toMatchObject({
        initiator: humanApprover,
        resolutions: [
          { reason: 'first venue review', approver: firstApprover },
          { reason: 'second venue review after restart', approver: secondApprover },
        ],
      })
    })

    it('supersedes an old approval during emergency handling instead of restoring it pushable', async () => {
      const original = new TradingGit(makeConfig())
      original.add(buyOp())
      original.commit('legacy pending')
      const legacy = JSON.parse(JSON.stringify(original.exportState())) as GitExportState
      delete legacy.mutation
      let persisted: GitExportState | undefined
      const restored = TradingGit.restore(legacy, makeConfig({
        onCommit: (state) => { persisted = JSON.parse(JSON.stringify(state)) },
      }))

      await restored.executeSyntheticMutation({
        kind: 'emergency_cancel',
        message: '[emergency-stop] HALT only',
        approver: humanApprover,
        prepare: async () => [],
        execute: vi.fn(),
      })
      const restarted = TradingGit.restore(persisted!, makeConfig())
      expect(restarted.status()).toMatchObject({
        staged: [],
        pendingMessage: null,
        pendingHash: null,
        mutation: { readiness: 'ready' },
      })
      const emergencyCommit = restarted.show(restarted.status().head!)
      expect(emergencyCommit?.results).toContainEqual(expect.objectContaining({
        status: 'user-rejected',
        error: expect.stringContaining('Superseded by emergency_cancel'),
      }))
      await expect(restarted.push({ via: 'auto-push-paper', at: humanApprover.at }))
        .rejects.toThrow('Nothing to push')
    })
  })

  // ==================== log ====================

  describe('log', () => {
    it('returns empty array when no commits', () => {
      expect(git.log()).toEqual([])
    })

    it('returns commits in reverse chronological order', async () => {
      git.add(buyOp('AAPL'))
      git.commit('First')
      await git.push()

      git.add(buyOp('GOOG'))
      git.commit('Second')
      await git.push()

      const entries = git.log()
      expect(entries).toHaveLength(2)
      expect(entries[0].message).toBe('Second')
      expect(entries[1].message).toBe('First')
    })

    it('filters by symbol', async () => {
      git.add(buyOp('AAPL'))
      git.commit('Buy AAPL')
      await git.push()

      git.add(buyOp('GOOG'))
      git.commit('Buy GOOG')
      await git.push()

      const entries = git.log({ symbol: 'AAPL' })
      expect(entries).toHaveLength(1)
      expect(entries[0].message).toBe('Buy AAPL')
    })

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        git.add(buyOp('AAPL'))
        git.commit(`Commit ${i}`)
        await git.push()
      }

      const entries = git.log({ limit: 2 })
      expect(entries).toHaveLength(2)
    })

    it('includes operation summaries', async () => {
      git.add(buyOp('AAPL'))
      git.commit('Buy')
      await git.push()

      const entries = git.log()
      expect(entries[0].operations).toHaveLength(1)
      expect(entries[0].operations[0].symbol).toBe('AAPL')
      expect(entries[0].operations[0].action).toBe('placeOrder')
    })
  })

  // ==================== show ====================

  describe('show', () => {
    it('returns null for unknown hash', () => {
      expect(git.show('deadbeef')).toBeNull()
    })

    it('returns the full commit for a known hash', async () => {
      git.add(buyOp())
      const { hash } = git.commit('msg')
      await git.push()

      const commit = git.show(hash)
      expect(commit).not.toBeNull()
      expect(commit!.hash).toBe(hash)
      expect(commit!.message).toBe('msg')
      expect(commit!.operations).toHaveLength(1)
      expect(commit!.results).toHaveLength(1)
    })
  })

  // ==================== status ====================

  describe('status', () => {
    it('reports clean state initially', () => {
      const s = git.status()
      expect(s.staged).toHaveLength(0)
      expect(s.pendingMessage).toBeNull()
      expect(s.head).toBeNull()
      expect(s.commitCount).toBe(0)
    })

    it('tracks head and commitCount after push', async () => {
      git.add(buyOp())
      git.commit('msg')
      await git.push()

      const s = git.status()
      expect(s.head).toHaveLength(8)
      expect(s.commitCount).toBe(1)
    })
  })

  // ==================== sentinel boundary ====================

  describe('sentinel boundary (OrderHelper.toWire)', () => {
    // Regression: 2026-05-13 — MKT order on Bybit rendered as
    // "BUY 0.0005 BTC/USDT MKT @ 1.70141183460469231731687303715884105727e+38"
    // in PushApprovalPanel. UNSET_DECIMAL (2^127-1) leaked from Order's
    // class defaults through c.json into the UI. Every public observer of
    // staged/committed Operations must strip Order-class sentinels.
    const UNSET_DECIMAL_STR = '1.70141183460469231731687303715884105727e+38'

    it('status().staged strips sentinel fields from a MKT placeOrder', () => {
      // MKT order — totalQuantity is the only price-shaped field user set.
      // lmtPrice / auxPrice / trailStopPrice / trailingPercent / cashQty
      // all hold the UNSET_DECIMAL class default and must NOT appear.
      git.add(buyOp())
      const s = git.status()
      const op = s.staged[0] as Extract<Operation, { action: 'placeOrder' }>
      expect(op.order).not.toHaveProperty('lmtPrice')
      expect(op.order).not.toHaveProperty('auxPrice')
      expect(op.order).not.toHaveProperty('trailStopPrice')
      expect(op.order).not.toHaveProperty('trailingPercent')
      expect(op.order).not.toHaveProperty('cashQty')
      expect(op.order).not.toHaveProperty('filledQuantity')
      // Real value passes through.
      expect(op.order.totalQuantity).toBeInstanceOf(Decimal)
      expect(op.order.totalQuantity.toFixed()).toBe('10')
    })

    it('show()/exportState()/status() JSON output contains no sentinel literal', async () => {
      git.add(buyOp())
      git.commit('mkt buy')
      await git.push()

      const head = git.status().head!
      for (const blob of [git.status(), git.show(head), git.exportState()]) {
        const serialised = JSON.stringify(blob)
        expect(serialised).not.toContain(UNSET_DECIMAL_STR)
        expect(serialised).not.toContain('170141183460469231731687303715884105727')
      }
    })

    it('modifyOrder.changes also strips sentinels', () => {
      const partialChanges = new Order()
      partialChanges.lmtPrice = new Decimal('150')
      // All other fields remain at UNSET_DECIMAL class defaults.
      git.add({ action: 'modifyOrder', orderId: 'o-1', changes: partialChanges })
      const s = git.status()
      const op = s.staged[0] as Extract<Operation, { action: 'modifyOrder' }>
      expect(op.changes.lmtPrice).toBeInstanceOf(Decimal)
      expect((op.changes.lmtPrice as Decimal).toFixed()).toBe('150')
      expect(op.changes).not.toHaveProperty('auxPrice')
      expect(op.changes).not.toHaveProperty('trailStopPrice')
      expect(op.changes).not.toHaveProperty('totalQuantity')
    })

    it('non-sentinel Decimal fields survive (round-trip safety)', async () => {
      const contract = makeContract({ symbol: 'ETH' })
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'LMT'
      order.totalQuantity = new Decimal('0.5')
      order.lmtPrice = new Decimal('3500.25')
      git.add({ action: 'placeOrder', contract, order })
      git.commit('lmt buy')
      await git.push()

      const exported = git.exportState()
      const op = exported.commits[0].operations[0] as Extract<Operation, { action: 'placeOrder' }>
      expect(op.order.lmtPrice).toBeInstanceOf(Decimal)
      expect((op.order.lmtPrice as Decimal).toFixed()).toBe('3500.25')
      expect(op.order.totalQuantity.toFixed()).toBe('0.5')
      // But unset auxPrice still gone.
      expect(op.order).not.toHaveProperty('auxPrice')
    })

    it('staging mutation after status() does not affect prior projection', () => {
      // Defensive: projectOperation must spread, not return raw ref.
      git.add(buyOp())
      const s1 = git.status()
      const op1 = s1.staged[0] as Extract<Operation, { action: 'placeOrder' }>
      // Mutate the projection — should not bleed back into staging.
      ;(op1.order as unknown as Record<string, unknown>).lmtPrice = 'tampered'
      const s2 = git.status()
      const op2 = s2.staged[0] as Extract<Operation, { action: 'placeOrder' }>
      expect(op2.order).not.toHaveProperty('lmtPrice')
    })
  })

  // ==================== exportState / restore ====================

  describe('exportState / restore', () => {
    it('round-trips state', async () => {
      git.add(buyOp('AAPL'))
      git.commit('Buy AAPL')
      await git.push()

      const exported = git.exportState()
      expect(exported.commits).toHaveLength(1)
      expect(exported.head).toHaveLength(8)

      const restored = TradingGit.restore(exported, config)
      expect(restored.status().commitCount).toBe(1)
      expect(restored.status().head).toBe(exported.head)

      const log = restored.log()
      expect(log).toHaveLength(1)
      expect(log[0].message).toBe('Buy AAPL')
    })

    it('persists complete pushed commit fields through JSON round-trip', async () => {
      const filledState = new OrderState()
      filledState.status = 'Filled'
      const executeOperation = vi.fn()
        .mockResolvedValueOnce({ success: true, orderId: 'order-1', orderState: filledState })
        .mockResolvedValueOnce({ success: true, orderId: 'order-2', orderState: filledState })
      const secondState = makeGitState({
        totalCashValue: '99750',
        netLiquidation: '100250',
        unrealizedPnL: '250',
        realizedPnL: '25',
        positions: [{
          contract: makeContract({ symbol: 'AAPL' }),
          currency: 'USD',
          side: 'long',
          quantity: new Decimal('2'),
          avgCost: '100',
          marketPrice: '125',
          marketValue: '250',
          unrealizedPnL: '50',
          realizedPnL: '25',
          multiplier: '1',
        }],
      })
      const getGitState = vi.fn()
        .mockResolvedValueOnce(makeGitState({ totalCashValue: '99900' }))
        .mockResolvedValueOnce(secondState)
      const onCommit = vi.fn()
      const persistedGit = new TradingGit(makeConfig({ executeOperation, getGitState, onCommit }))

      persistedGit.add(buyOp('AAPL'))
      const first = persistedGit.commit('thesis: enter AAPL')
      await persistedGit.push()
      persistedGit.add(sellOp('AAPL'))
      const second = persistedGit.commit('thesis: trim AAPL')
      await persistedGit.push()

      expect(onCommit).toHaveBeenCalledTimes(12)
      const persisted = JSON.parse(JSON.stringify(onCommit.mock.calls[onCommit.mock.calls.length - 1][0]))
      const restored = TradingGit.restore(persisted, config)
      const commit = restored.show(second.hash)!

      expect(persisted.head).toBe(second.hash)
      expect(commit.hash).toBe(second.hash)
      expect(commit.parentHash).toBe(first.hash)
      expect(commit.message).toBe('thesis: trim AAPL')
      expect(commit.operations).toHaveLength(1)
      expect((commit.operations[0] as Extract<Operation, { action: 'closePosition' }>).contract.symbol).toBe('AAPL')
      expect(commit.results).toHaveLength(1)
      expect(commit.results[0]).toMatchObject({
        action: 'closePosition',
        success: true,
        orderId: 'order-2',
        status: 'filled',
      })
      expect(commit.stateAfter).toMatchObject({
        totalCashValue: '99750',
        netLiquidation: '100250',
        unrealizedPnL: '250',
        realizedPnL: '25',
      })
      expect(commit.stateAfter.positions).toHaveLength(1)
      expect(commit.stateAfter.positions[0].quantity).toBeInstanceOf(Decimal)
      expect(commit.stateAfter.positions[0].quantity.toFixed()).toBe('2')
      expect(Number.isNaN(Date.parse(commit.timestamp))).toBe(false)
    })

    it('preserves guard verdicts through JSON round-trip', async () => {
      const guardVerdicts = [
        { guard: 'max-position-size', verdict: 'pass', metrics: { positionValuePct: 1, threshold: 25 } },
        { guard: 'cooldown', verdict: 'pass', metrics: { msSinceLast: null, cooldownMs: 60_000 } },
        { guard: 'symbol-whitelist', verdict: 'pass', metrics: { symbol: 'AAPL' } },
      ]
      const executeOperation = vi.fn().mockResolvedValue({
        success: true,
        orderId: 'guarded-order',
        guardVerdicts,
      })
      const guardedGit = new TradingGit(makeConfig({ executeOperation }))

      guardedGit.add(buyOp('AAPL'))
      const prepared = guardedGit.commit('guarded buy')
      await guardedGit.push()

      const persisted = JSON.parse(JSON.stringify(guardedGit.exportState())) as GitExportState
      const restored = TradingGit.restore(persisted, config)
      const commit = restored.show(prepared.hash)!

      expect(commit.results[0].guardVerdicts).toEqual(guardVerdicts)
    })

    it('preserves approver identity through JSON round-trip', async () => {
      git.add(buyOp('AAPL'))
      const prepared = git.commit('approved buy')
      await git.push({
        via: 'alice-bff',
        fingerprint: 'fp-admin-session',
        at: '2026-07-05T12:00:00.000Z',
      })

      const persisted = JSON.parse(JSON.stringify(git.exportState())) as GitExportState
      const restored = TradingGit.restore(persisted, config)

      expect(restored.show(prepared.hash)?.approver).toEqual({
        via: 'alice-bff',
        fingerprint: 'fp-admin-session',
        at: '2026-07-05T12:00:00.000Z',
      })
    })

    it('restores old commit results without guard verdicts', async () => {
      const guardVerdicts = [
        { guard: 'symbol-whitelist', verdict: 'pass', metrics: { symbol: 'AAPL' } },
      ]
      const oldGit = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'legacy-order',
          guardVerdicts,
        }),
      }))

      oldGit.add(buyOp('AAPL'))
      const prepared = oldGit.commit('legacy buy')
      await oldGit.push()

      const persisted = JSON.parse(JSON.stringify(oldGit.exportState())) as GitExportState
      delete persisted.commits[0].results[0].guardVerdicts

      const restored = TradingGit.restore(persisted, config)
      const commit = restored.show(prepared.hash)!
      expect(commit.results[0].guardVerdicts).toBeUndefined()
      expect(commit.results[0]).toMatchObject({
        action: 'placeOrder',
        success: true,
        orderId: 'legacy-order',
        status: 'submitted',
      })
    })

    it('restores legacy commits without approver identity', async () => {
      git.add(buyOp('AAPL'))
      const prepared = git.commit('legacy un-attributed buy')
      await git.push({
        via: 'alice-bff',
        fingerprint: 'fp-admin-session',
        at: '2026-07-05T12:00:00.000Z',
      })

      const persisted = JSON.parse(JSON.stringify(git.exportState())) as GitExportState
      delete persisted.commits[0].approver

      const restored = TradingGit.restore(persisted, config)
      const commit = restored.show(prepared.hash)!
      expect(commit.approver).toBeUndefined()
      expect(commit.message).toBe('legacy un-attributed buy')
    })

    it('rehydrates Decimal price fields through JSON round-trip', async () => {
      const contract = makeContract({ symbol: 'ETH' })
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'LMT'
      order.totalQuantity = new Decimal('0.12345678')
      order.lmtPrice = new Decimal('0.00001234')
      order.auxPrice = new Decimal('0.3')
      order.trailStopPrice = new Decimal('145.5')
      order.trailingPercent = new Decimal('2.5')
      order.cashQty = new Decimal('1000')
      git.add({ action: 'placeOrder', contract, order })
      git.commit('precise eth order')
      await git.push()

      // Simulate persist → reload by going through JSON.
      const exported = JSON.parse(JSON.stringify(git.exportState()))
      const restored = TradingGit.restore(exported, config)
      const commit = restored.show(restored.status().head!)
      const op = commit!.operations[0] as Extract<Operation, { action: 'placeOrder' }>
      expect(op.order.totalQuantity).toBeInstanceOf(Decimal)
      expect(op.order.totalQuantity.toFixed()).toBe('0.12345678')
      expect(op.order.lmtPrice).toBeInstanceOf(Decimal)
      expect(op.order.lmtPrice.toFixed()).toBe('0.00001234')
      expect(op.order.auxPrice.toFixed()).toBe('0.3')
      expect(op.order.trailStopPrice.toFixed()).toBe('145.5')
      expect(op.order.trailingPercent.toFixed()).toBe('2.5')
      expect(op.order.cashQty.toFixed()).toBe('1000')
    })

    it('rehydrates legacy number-typed price fields to Decimal', async () => {
      // Simulate an older persisted file where price fields were JSON numbers.
      const contract = makeContract({ symbol: 'AAPL' })
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'LMT'
      order.totalQuantity = new Decimal(10)
      order.lmtPrice = new Decimal(145.25)
      git.add({ action: 'placeOrder', contract, order })
      git.commit('legacy order')
      await git.push()

      const exported = git.exportState()
      // Tamper: rewrite lmtPrice as a bare number in the serialised form.
      const raw = JSON.parse(JSON.stringify(exported)) as typeof exported
      const committedOp = raw.commits[0].operations[0] as Extract<Operation, { action: 'placeOrder' }>
      ;(committedOp.order as unknown as { lmtPrice: number }).lmtPrice = 145.25
      const restored = TradingGit.restore(raw, config)
      const commit = restored.show(restored.status().head!)
      const op = commit!.operations[0] as Extract<Operation, { action: 'placeOrder' }>
      expect(op.order.lmtPrice).toBeInstanceOf(Decimal)
      expect(op.order.lmtPrice.toNumber()).toBe(145.25)
    })

    it('reconcileBalance commits survive JSON round-trip and log() does not throw', async () => {
      // Regression: previously stored quantityDelta/markPrice as Decimal in the
      // Operation type. After JSON.stringify (via onCommit persistence) they
      // came back as strings, and `formatOperationChange` calling .gte()/.toFixed()
      // exploded with "is not a function". Now the type is `string` end-to-end.
      await git.recordReconcile({
        aliceId: 'bybit-main|BTC',
        quantityDelta: new Decimal('1.0093'),
        markPrice: new Decimal('80569.90'),
        stateAfter: makeGitState(),
        expectedHead: git.status().head,
      })

      const exported = JSON.parse(JSON.stringify(git.exportState()))
      const restored = TradingGit.restore(exported, config)

      // Direct field check — values stay as strings.
      const commit = restored.show(restored.status().head!)
      const op = commit!.operations[0] as Extract<Operation, { action: 'reconcileBalance' }>
      expect(typeof op.quantityDelta).toBe('string')
      expect(typeof op.markPrice).toBe('string')
      expect(op.quantityDelta).toBe('1.0093')
      expect(op.markPrice).toBe('80569.9')

      // The crash path: log() walks commits, formatOperationChange parses
      // the string back to Decimal via `new Decimal(...)`. Should not throw.
      const log = restored.log()
      expect(log).toHaveLength(1)
      expect(log[0].operations[0].change).toContain('observed')
      expect(log[0].operations[0].change).toContain('1.0093')
    })

    it('restores an awaiting-approval commit and pushes with the original pending hash', async () => {
      const executeOperation = vi.fn().mockResolvedValue({ success: true, orderId: 'order-restored' })
      const original = new TradingGit(makeConfig({ executeOperation }))
      original.add(buyOp('AAPL'))
      const prepared = original.commit('Buy AAPL after restart')
      const exported = JSON.parse(JSON.stringify(original.exportState())) as GitExportState

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const restored = TradingGit.restore(exported, makeConfig({ executeOperation }))
      warn.mockRestore()

      expect(restored.status()).toMatchObject({
        pendingMessage: 'Buy AAPL after restart',
        pendingHash: prepared.hash,
      })
      expect(restored.status().staged).toHaveLength(1)

      const result = await restored.push()
      expect(result.hash).toBe(prepared.hash)
      expect(executeOperation).toHaveBeenCalledTimes(1)
      expect(restored.status().pendingMessage).toBeNull()
      expect(restored.status().staged).toEqual([])
      expect(restored.show(prepared.hash)?.hash).toBe(prepared.hash)
    })

    it('restores staged operations without a prepared commit and can commit + push them', async () => {
      const executeOperation = vi.fn().mockResolvedValue({ success: true, orderId: 'order-staged' })
      git.add(buyOp('MSFT'))
      const exported = JSON.parse(JSON.stringify(git.exportState())) as GitExportState
      expect(exported.stagingArea).toHaveLength(1)
      expect(exported.pendingMessage).toBeNull()

      const restored = TradingGit.restore(exported, makeConfig({ executeOperation }))
      expect(restored.status().staged).toHaveLength(1)
      expect(restored.status().pendingMessage).toBeNull()

      const prepared = restored.commit('Buy staged MSFT')
      const result = await restored.push()
      expect(result.hash).toBe(prepared.hash)
      expect(executeOperation).toHaveBeenCalledTimes(1)
      expect(restored.show(prepared.hash)?.message).toBe('Buy staged MSFT')
    })

    it('rejects a restored pending approval and records a user-rejected commit with the reason', async () => {
      git.add(buyOp('TSLA'))
      const prepared = git.commit('Buy TSLA after restart')
      const exported = JSON.parse(JSON.stringify(git.exportState())) as GitExportState

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const restored = TradingGit.restore(exported, config)
      warn.mockRestore()

      const result = await restored.reject('risk changed')
      expect(result.hash).toBe(prepared.hash)
      expect(result.message).toBe('[rejected] Buy TSLA after restart — risk changed')
      const commit = restored.show(prepared.hash)!
      expect(commit.results).toHaveLength(1)
      expect(commit.results[0]).toMatchObject({
        status: 'user-rejected',
        error: 'risk changed',
      })
      expect(restored.status().pendingMessage).toBeNull()
      expect(restored.status().staged).toEqual([])
    })

    it('restores old-shape commit history with empty transient approval state', async () => {
      git.add(buyOp('AAPL'))
      git.commit('Buy AAPL')
      await git.push()
      const exported = git.exportState()
      const oldShape = {
        commits: exported.commits,
        head: exported.head,
      } satisfies GitExportState

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const restored = TradingGit.restore(oldShape, config)
      warn.mockRestore()
      error.mockRestore()

      expect(restored.status()).toMatchObject({
        head: exported.head,
        commitCount: 1,
        staged: [],
        pendingMessage: null,
        pendingHash: null,
      })
    })

    it('drops malformed pending approval state loudly while preserving valid staged operations', () => {
      const malformed = {
        commits: [],
        head: null,
        stagingArea: [buyOp('AAPL')],
        pendingMessage: 'Buy AAPL',
        pendingHash: 'not-a-hash',
      } as unknown as GitExportState

      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const restored = TradingGit.restore(malformed, config)

      expect(error).toHaveBeenCalledWith(expect.stringContaining('Dropped malformed pending approval'))
      error.mockRestore()
      expect(restored.status().staged).toHaveLength(1)
      expect(restored.status().pendingMessage).toBeNull()
      expect(restored.status().pendingHash).toBeNull()
    })
  })

  // ==================== setCurrentRound ====================

  describe('setCurrentRound', () => {
    it('tags commits with the current round', async () => {
      git.setCurrentRound(42)
      git.add(buyOp())
      git.commit('msg')
      await git.push()

      const commit = git.show(git.status().head!)
      expect(commit!.round).toBe(42)
    })
  })

  // ==================== sync ====================

  describe('sync', () => {
    it('creates a sync commit for order updates', async () => {
      git.add(buyOp('AAPL'))
      git.commit('resting order')
      await git.push()
      const result = await git.sync([
        {
          orderId: 'order-1',
          symbol: 'AAPL',
          previousStatus: 'submitted',
          currentStatus: 'filled',
          filledPrice: '155',
          filledQty: '10',
        },
      ])

      expect(result.updatedCount).toBe(1)
      expect(result.hash).toHaveLength(8)
      expect(git.status().commitCount).toBe(2)
    })

    it('returns empty result for no updates', async () => {
      const result = await git.sync([])
      expect(result.updatedCount).toBe(0)
    })

    it('revalidates stale sync observations inside the ledger lease', async () => {
      git.add(buyOp('AAPL'))
      git.commit('resting order')
      await git.push()
      const update = {
        orderId: 'order-1',
        symbol: 'AAPL',
        previousStatus: 'submitted' as const,
        currentStatus: 'filled' as const,
        filledPrice: '155',
        filledQty: '10',
      }
      await git.sync([update])
      const before = git.status().commitCount
      const head = git.status().head

      const stale = await git.sync([update])

      expect(stale).toEqual({ hash: head, updatedCount: 0, updates: [] })
      expect(git.status().commitCount).toBe(before)
    })
  })

  describe('recordObservedOrders', () => {
    it('revalidates a stale external-order observation inside the ledger lease', async () => {
      git.add(buyOp('AAPL'))
      git.commit('Alice order')
      await git.push()
      const staleOrder = new Order()
      staleOrder.action = 'BUY'
      staleOrder.orderType = 'LMT'
      staleOrder.totalQuantity = new Decimal(10)
      const before = git.status().commitCount

      const result = await git.recordObservedOrders({
        observed: [{ contract: makeContract(), order: staleOrder, orderId: 'order-1' }],
      })

      expect(result).toEqual({ hash: null, observed: 0 })
      expect(git.status().commitCount).toBe(before)
    })
  })

  // ==================== getPendingOrderIds ====================

  describe('getPendingOrderIds', () => {
    it('returns empty when no commits', () => {
      expect(git.getPendingOrderIds()).toEqual([])
    })

    it('finds pending orders from commits', async () => {
      const pendingConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'lmt-1',
        }),
      })
      const gitP = new TradingGit(pendingConfig)

      gitP.add(buyOp('AAPL'))
      gitP.commit('limit buy')
      await gitP.push()

      const pending = gitP.getPendingOrderIds()
      expect(pending).toHaveLength(1)
      // localSymbol/aliceId ride along when the operation's contract has
      // them — broker lookup hint + reconcile race guard respectively.
      expect(pending[0]).toMatchObject({ orderId: 'lmt-1', symbol: 'AAPL' })
    })

    it('excludes orders that have been synced to filled', async () => {
      const pendingConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'lmt-1',
        }),
      })
      const gitP = new TradingGit(pendingConfig)

      gitP.add(buyOp('AAPL'))
      gitP.commit('limit buy')
      await gitP.push()

      // Sync to filled
      await gitP.sync([{
        orderId: 'lmt-1',
        symbol: 'AAPL',
        previousStatus: 'submitted',
        currentStatus: 'filled',
        filledPrice: '155',
        filledQty: '10',
      }])

      expect(gitP.getPendingOrderIds()).toHaveLength(0)
    })

    it('tracks bracket TP/SL legs from birth (Alpaca naked-ledger bug)', async () => {
      // The bug: bracket legs existed only on the exchange — order list,
      // sync poller, and cancel were all blind to them; the held SL leg
      // never even appears in the venue's open-orders listing.
      const legConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'parent-1',
          legs: [
            { orderId: 'leg-tp', kind: 'takeProfit' },
            { orderId: 'leg-sl', kind: 'stopLoss' },
          ],
        }),
      })
      const gitP = new TradingGit(legConfig)

      gitP.add(buyOp('AAPL'))
      gitP.commit('bracket buy')
      await gitP.push()

      const pending = gitP.getPendingOrderIds()
      expect(pending.map((p) => p.orderId).sort()).toEqual(['leg-sl', 'leg-tp', 'parent-1'])
      // Legs inherit the parent operation's contract (symbol-scoped lookups
      // + restart survival need it).
      for (const p of pending) expect(p.symbol).toBe('AAPL')

      // Observation pass must never re-record our own legs as external.
      const known = gitP.getKnownOrderIds()
      expect(known.has('leg-tp')).toBe(true)
      expect(known.has('leg-sl')).toBe(true)

      // A later sync resolving a leg removes it from pending, keeps the rest.
      await gitP.sync([{
        orderId: 'leg-tp', symbol: 'AAPL',
        previousStatus: 'submitted', currentStatus: 'filled',
        filledPrice: '297', filledQty: '1',
      }])
      expect(gitP.getPendingOrderIds().map((p) => p.orderId).sort()).toEqual(['leg-sl', 'parent-1'])
    })

    it('survives a multi-update sync commit (1 op, N results — boot-loop regression)', async () => {
      const gitP = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: true, orderId: 'o-1' }),
      }))
      gitP.add(buyOp('AAPL'))
      gitP.commit('buy')
      await gitP.push()

      // One sync commit carrying TWO updates → operations[1] is undefined;
      // the pending scan crashed the whole UTA process on every boot once
      // such a commit was persisted in the journal.
      await gitP.sync([
        { orderId: 'o-1', symbol: 'AAPL', previousStatus: 'submitted', currentStatus: 'filled', filledPrice: '10', filledQty: '1' },
        { orderId: 'o-2', symbol: 'MSFT', previousStatus: 'submitted', currentStatus: 'cancelled' },
      ])

      expect(() => gitP.getPendingOrderIds()).not.toThrow()
      expect(gitP.getPendingOrderIds()).toHaveLength(0)
    })

    it('excludes orders that were filled at push time (no sync needed)', async () => {
      const orderState = new OrderState()
      orderState.status = 'Filled'
      const filledConfig = makeConfig({
        executeOperation: vi.fn().mockResolvedValue({
          success: true,
          orderId: 'mkt-1',
          orderState,
        }),
      })
      const gitP = new TradingGit(filledConfig)

      gitP.add(buyOp('AAPL'))
      gitP.commit('market buy')
      await gitP.push()

      // Filled at push time → should NOT appear as pending
      expect(gitP.getPendingOrderIds()).toHaveLength(0)
    })
  })

  describe('log — sync commit attribution', () => {
    it('renders one row per sync update, attributed by the update symbol', async () => {
      const gitS = new TradingGit(makeConfig({
        executeOperation: vi.fn()
          .mockResolvedValueOnce({ success: true, orderId: 'o-1' })
          .mockResolvedValueOnce({ success: true, orderId: 'o-2' }),
      }))
      gitS.add(buyOp('AAPL'))
      gitS.add(buyOp('TSLA'))
      gitS.commit('two resting buys')
      await gitS.push()

      await gitS.sync([
        { orderId: 'o-1', symbol: 'AAPL', previousStatus: 'submitted', currentStatus: 'filled', filledPrice: '150', filledQty: '10' },
        { orderId: 'o-2', symbol: 'TSLA', previousStatus: 'submitted', currentStatus: 'cancelled' },
      ])

      const [head] = gitS.log({ limit: 1 })
      expect(head.operations).toHaveLength(2)
      expect(head.operations.map((o) => o.symbol)).toEqual(['AAPL', 'TSLA'])
      expect(head.operations[0].change).toContain('@150')
    })
  })

  // ==================== simulatePriceChange ====================

  describe('simulatePriceChange — derivative handling (community sign-flip report)', () => {
    it('excludes option rows from a symbol-level change and applies multiplier to applied rows', async () => {
      const optContract = makeContract({ symbol: 'AAPL' })
      optContract.secType = 'OPT'
      optContract.strike = 260
      optContract.right = 'P'
      const gitS = new TradingGit(makeConfig({
        getGitState: vi.fn().mockResolvedValue(makeGitState({
          positions: [
            { contract: makeContract({ symbol: 'AAPL' }), currency: 'USD', side: 'long',
              quantity: new Decimal(10), avgCost: '261', marketPrice: '290',
              marketValue: '2900', unrealizedPnL: '290', realizedPnL: '0', multiplier: '1' },
            // short put — its own price must NOT be replaced by the stock's
            { contract: optContract, currency: 'USD', side: 'short',
              quantity: new Decimal(1), avgCost: '1.03', marketPrice: '1.15',
              marketValue: '115', unrealizedPnL: '-12', realizedPnL: '0', multiplier: '100' },
          ] as never,
        })),
      }))

      const r = await gitS.simulatePriceChange([{ symbol: 'AAPL', change: '-5%' }])
      expect(r.success).toBe(true)
      const rows = r.simulatedState.positions
      // Stock row moved; option row untouched (no +23,000% garbage)
      expect(Number(rows[0].simulatedPrice)).toBeCloseTo(275.5, 1)
      expect(rows[1].simulatedPrice).toBe('1.15')
      expect(rows[1].pnlChange).toBe('0')
      // exclusion is loud, not silent
      expect(r.summary.worstCase).toMatch(/derivative positions not simulated/i)
      expect(r.summary.worstCase).toMatch(/OPT/)
    })

    it("'all' scales a derivative's OWN mark with multiplier-aware math", async () => {
      const optContract = makeContract({ symbol: 'AAPL' })
      optContract.secType = 'OPT'
      const gitS = new TradingGit(makeConfig({
        getGitState: vi.fn().mockResolvedValue(makeGitState({
          positions: [
            { contract: optContract, currency: 'USD', side: 'short',
              quantity: new Decimal(1), avgCost: '1.03', marketPrice: '1.00',
              marketValue: '100', unrealizedPnL: '3', realizedPnL: '0', multiplier: '100' },
          ] as never,
        })),
      }))
      const r = await gitS.simulatePriceChange([{ symbol: 'all', change: '+10%' }])
      const row = r.simulatedState.positions[0]
      // own mark 1.00 → 1.10; short: (1.03 − 1.10) × 1 × 100 = −7
      expect(Number(row.simulatedPrice)).toBeCloseTo(1.10, 8)
      expect(Number(row.unrealizedPnL)).toBeCloseTo(-7, 6)
      expect(Number(row.marketValue)).toBeCloseTo(110, 6)
    })
  })

  describe('simulatePriceChange', () => {
    it('returns empty state when no positions', async () => {
      const result = await git.simulatePriceChange([{ symbol: 'AAPL', change: '-10%' }])
      expect(result.success).toBe(true)
      expect(result.summary.totalPnLChange).toBe('0')
    })

    it('simulates relative price change on long position', async () => {
      const stateWithPositions = makeGitState({
        positions: [
          {
            contract: makeContract({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL' }),
            currency: 'USD',
            side: 'long',
            quantity: new Decimal(10),
            avgCost: '150',
            marketPrice: '160',
            marketValue: '1600',
            unrealizedPnL: '100',
            realizedPnL: '0',
            multiplier: '1',
          },
        ],
      })
      const simConfig = makeConfig({
        getGitState: vi.fn().mockResolvedValue(stateWithPositions),
      })
      const simGit = new TradingGit(simConfig)

      const result = await simGit.simulatePriceChange([{ symbol: 'AAPL', change: '-10%' }])
      expect(result.success).toBe(true)
      // Price drops 10%: 160 -> 144
      const simPos = result.simulatedState.positions[0]
      expect(simPos.simulatedPrice).toBe('144')
      // PnL: (144 - 150) * 10 = -60
      expect(simPos.unrealizedPnL).toBe('-60')
    })

    it('simulates absolute price change', async () => {
      const stateWithPositions = makeGitState({
        positions: [
          {
            contract: makeContract({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL' }),
            currency: 'USD',
            side: 'long',
            quantity: new Decimal(10),
            avgCost: '150',
            marketPrice: '160',
            marketValue: '1600',
            unrealizedPnL: '100',
            realizedPnL: '0',
            multiplier: '1',
          },
        ],
      })
      const simConfig = makeConfig({
        getGitState: vi.fn().mockResolvedValue(stateWithPositions),
      })
      const simGit = new TradingGit(simConfig)

      const result = await simGit.simulatePriceChange([{ symbol: 'AAPL', change: '@200' }])
      expect(result.success).toBe(true)
      expect(result.simulatedState.positions[0].simulatedPrice).toBe('200')
      // PnL: (200 - 150) * 10 = 500
      expect(result.simulatedState.positions[0].unrealizedPnL).toBe('500')
    })

    it('simulates "all" positions', async () => {
      const stateWithPositions = makeGitState({
        positions: [
          {
            contract: makeContract({ symbol: 'AAPL' }),
            currency: 'USD', side: 'long', quantity: new Decimal(10), avgCost: '100', marketPrice: '100',
            marketValue: '1000', unrealizedPnL: '0', realizedPnL: '0', multiplier: '1',
          },
          {
            contract: makeContract({ symbol: 'GOOG' }),
            currency: 'USD', side: 'long', quantity: new Decimal(5), avgCost: '200', marketPrice: '200',
            marketValue: '1000', unrealizedPnL: '0', realizedPnL: '0', multiplier: '1',
          },
        ],
      })
      const simConfig = makeConfig({ getGitState: vi.fn().mockResolvedValue(stateWithPositions) })
      const simGit = new TradingGit(simConfig)

      const result = await simGit.simulatePriceChange([{ symbol: 'all', change: '+10%' }])
      expect(result.success).toBe(true)
      expect(result.simulatedState.positions).toHaveLength(2)
      expect(Number(result.simulatedState.positions[0].simulatedPrice)).toBeCloseTo(110)
      expect(Number(result.simulatedState.positions[1].simulatedPrice)).toBeCloseTo(220)
    })

    it('returns error for invalid price change format', async () => {
      const stateWithPositions = makeGitState({
        positions: [
          {
            contract: makeContract({ symbol: 'AAPL' }),
            currency: 'USD', side: 'long', quantity: new Decimal(10), avgCost: '100', marketPrice: '100',
            marketValue: '1000', unrealizedPnL: '0', realizedPnL: '0', multiplier: '1',
          },
        ],
      })
      const simConfig = makeConfig({ getGitState: vi.fn().mockResolvedValue(stateWithPositions) })
      const simGit = new TradingGit(simConfig)

      const result = await simGit.simulatePriceChange([{ symbol: 'AAPL', change: 'bad' }])
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid change format')
    })
  })
})
