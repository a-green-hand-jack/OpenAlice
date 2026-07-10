/**
 * TradingGit — Trading-as-Git implementation
 *
 * Unified git-like operation tracking for all trading accounts.
 */

import { createHash, randomUUID } from 'crypto'
import Decimal from 'decimal.js'
import { Contract, Order, UNSET_DECIMAL, UNSET_DOUBLE } from '@traderalice/ibkr'
import { OrderHelper } from '../OrderHelper.js'
import type {
  ITradingGit,
  RejectOptions,
  ResolveMutationParams,
  PushOptions,
  SyntheticMutationParams,
  TradingGitConfig,
} from './interfaces.js'
import type {
  CommitHash,
  Operation,
  OperationResult,
  OperationStatus,
  AddResult,
  CommitPrepareResult,
  PushResult,
  RejectResult,
  GitStatus,
  GitCommit,
  GitState,
  CommitLogEntry,
  GitExportState,
  ApproverIdentity,
  GuardVerdict,
  OperationSummary,
  PriceChangeInput,
  SimulatePriceChangeResult,
  OrderStatusUpdate,
  SyncResult,
  MutationAttemptKind,
  MutationAttemptV1,
  MutationEnvelope,
  MutationOperationV1,
  MutationResolveResult,
  SanitizedExecutionReceipt,
} from './types.js'
import { MUTATION_SCHEMA_VERSION } from './types.js'
import { getOperationSymbol } from './types.js'
import { hasLocalNoDispatchProof } from '../guards/guard-pipeline.js'
import {
  AccountMutationCoordinator,
  MutationRecoveryRequiredError,
  PendingApprovalChangedError,
} from './mutation-coordinator.js'

/** secTypes whose price does NOT track the underlying 1:1 — excluded from
 *  symbol-level price simulation (they share the underlying's symbol). */
const DERIVATIVE_SECTYPES = new Set(['OPT', 'FOP', 'WAR', 'IOPT', 'BAG'])
const DEFAULT_MUTATION_TIMEOUT_MS = 30_000

/**
 * A broker dispatch outlived its timeout. This is NOT proof of non-acceptance
 * — the request is still in flight at the venue — so it always classifies as
 * `uncertain`, and the orphaned Promise blocks in-process resolution.
 */
export class DispatchTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DispatchTimeoutError'
  }
}

function generateCommitHash(content: object): CommitHash {
  const hash = createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex')
  return hash.slice(0, 8)
}

function extractGuardVerdicts(value: unknown): GuardVerdict[] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const guardVerdicts = (value as { guardVerdicts?: unknown }).guardVerdicts
  if (!Array.isArray(guardVerdicts) || guardVerdicts.length === 0) return undefined
  return guardVerdicts as GuardVerdict[]
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Detach plain JSON data (approvers, contexts, resolutions) from caller-owned objects. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function decimalReceiptString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * Persisted orderState is a strict allowlist of venue-status scalars. The raw
 * IBKR OrderState carries account identifiers (orderAllocations[].account) and
 * a dozen margin fields that must never reach commit.json / show / export.
 */
function sanitizeOrderState(value: unknown): OperationResult['orderState'] {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const commission = finiteNumber(source.commissionAndFees)
  const sanitized = {
    ...(nonEmptyString(source.status) ? { status: nonEmptyString(source.status) } : {}),
    ...(nonEmptyString(source.rejectReason) ? { rejectReason: nonEmptyString(source.rejectReason) } : {}),
    ...(nonEmptyString(source.completedTime) ? { completedTime: nonEmptyString(source.completedTime) } : {}),
    ...(nonEmptyString(source.completedStatus) ? { completedStatus: nonEmptyString(source.completedStatus) } : {}),
    ...(commission !== undefined && commission !== UNSET_DOUBLE ? { commissionAndFees: commission } : {}),
    ...(nonEmptyString(source.commissionAndFeesCurrency)
      ? { commissionAndFeesCurrency: nonEmptyString(source.commissionAndFeesCurrency) }
      : {}),
  }
  return Object.keys(sanitized).length > 0
    ? sanitized as OperationResult['orderState']
    : undefined
}

/** Bracket legs persist as exactly {orderId, kind} — nothing else survives. */
function sanitizeLegs(value: unknown): OperationResult['legs'] {
  if (!Array.isArray(value)) return undefined
  const legs = value.flatMap((leg) => {
    if (!leg || typeof leg !== 'object') return []
    const source = leg as Record<string, unknown>
    const orderId = nonEmptyString(source.orderId)
      ?? (typeof source.orderId === 'number' && Number.isFinite(source.orderId)
        ? String(source.orderId)
        : undefined)
    const kind = source.kind === 'takeProfit'
      ? 'takeProfit' as const
      : source.kind === 'stopLoss' ? 'stopLoss' as const : undefined
    if (!orderId || !kind) return []
    return [{ orderId, kind }]
  })
  return legs.length > 0 ? legs : undefined
}

/** Decimal / number / string quantities → lossless string, everything else dropped. */
function quantityString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value && typeof value === 'object' && 'toFixed' in value
    && typeof (value as { toFixed: unknown }).toFixed === 'function') {
    try {
      return (value as { toFixed: () => string }).toFixed()
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Preserve useful venue acknowledgement fields without retaining account IDs or raw payloads. */
function sanitizeExecutionReceipt(value: unknown): SanitizedExecutionReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const receipt: SanitizedExecutionReceipt = {
    ...(finiteNumber(source.orderId) !== undefined ? { orderId: finiteNumber(source.orderId) } : {}),
    ...(nonEmptyString(source.execId) ? { execId: nonEmptyString(source.execId) } : {}),
    ...(nonEmptyString(source.time) ? { time: nonEmptyString(source.time) } : {}),
    ...(nonEmptyString(source.exchange) ? { exchange: nonEmptyString(source.exchange) } : {}),
    ...(nonEmptyString(source.side) ? { side: nonEmptyString(source.side) } : {}),
    ...(quantityString(source.shares) ? { shares: quantityString(source.shares) } : {}),
    ...(finiteNumber(source.price) !== undefined ? { price: finiteNumber(source.price) } : {}),
    ...(finiteNumber(source.permId) !== undefined ? { permId: finiteNumber(source.permId) } : {}),
    ...(finiteNumber(source.clientId) !== undefined ? { clientId: finiteNumber(source.clientId) } : {}),
    ...(typeof source.isLiquidation === 'boolean' ? { isLiquidation: source.isLiquidation } : {}),
    ...(quantityString(source.cumQty) ? { cumQty: quantityString(source.cumQty) } : {}),
    ...(finiteNumber(source.avgPrice) !== undefined ? { avgPrice: finiteNumber(source.avgPrice) } : {}),
    ...(nonEmptyString(source.orderRef) ? { orderRef: nonEmptyString(source.orderRef) } : {}),
    ...(finiteNumber(source.lastLiquidity) !== undefined
      ? { lastLiquidity: finiteNumber(source.lastLiquidity) }
      : {}),
    ...(typeof source.isPriceRevisionPending === 'boolean'
      ? { isPriceRevisionPending: source.isPriceRevisionPending }
      : {}),
  }
  return Object.keys(receipt).length > 0 ? receipt : undefined
}

interface PreparedMutationParams {
  kind: MutationAttemptKind
  operations: Operation[]
  message: string
  hash: CommitHash
  approver?: ApproverIdentity
  context?: MutationAttemptV1['context']
  execute: (operation: Operation) => Promise<unknown>
  suspendedApproval?: MutationAttemptV1['suspendedApproval']
}

interface ExportStateOverrides {
  commits?: GitCommit[]
  head?: CommitHash | null
  stagingArea?: Operation[]
  pendingMessage?: string | null
  pendingHash?: CommitHash | null
  mutation?: MutationEnvelope | undefined
}

export class TradingGit implements ITradingGit {
  private stagingArea: Operation[] = []
  private pendingMessage: string | null = null
  private pendingHash: CommitHash | null = null
  private commits: GitCommit[] = []
  private head: CommitHash | null = null
  private currentRound: number | undefined = undefined
  private readonly config: TradingGitConfig
  private readonly mutationCoordinator: AccountMutationCoordinator
  private legacyReviewRequired = false

  constructor(config: TradingGitConfig) {
    if (!config.onCommit && !config.allowEphemeralPersistence) {
      throw new Error('TradingGit requires a synchronous durable persister; ephemeral mutation state is unsafe')
    }
    if (config.onCommit && config.onCommit.constructor?.name === 'AsyncFunction') {
      throw new Error(
        'TradingGit persister must be synchronous: an async onCommit would let broker dispatch '
        + 'proceed before state reaches disk. Wrap durable writes in a synchronous function.',
      )
    }
    this.config = config
    this.mutationCoordinator = new AccountMutationCoordinator({
      schemaVersion: MUTATION_SCHEMA_VERSION,
    })
  }

  // ==================== git add / commit / push ====================

  add(operation: Operation): AddResult {
    this.assertLedgerWriteAllowed('stage')
    if (this.pendingMessage !== null || this.pendingHash !== null) {
      throw new Error('Pending approval already exists; push or reject it before staging another operation')
    }
    const storedOperation = TradingGit.cloneOperation(operation)
    const nextStaging = [...this.stagingArea, storedOperation]
    this.persistCandidate({ stagingArea: nextStaging })
    this.stagingArea = nextStaging
    return {
      staged: true,
      index: this.stagingArea.length - 1,
      operation: this.projectOperation(storedOperation),
    }
  }

  commit(message: string): CommitPrepareResult {
    this.assertLedgerWriteAllowed('commit')
    if (this.pendingMessage !== null || this.pendingHash !== null) {
      throw new Error('Pending approval already exists; push or reject it before committing again')
    }
    if (this.stagingArea.length === 0) {
      throw new Error('Nothing to commit: staging area is empty')
    }

    const timestamp = new Date().toISOString()
    const pendingHash = generateCommitHash({
      message,
      operations: this.stagingArea,
      timestamp,
      parentHash: this.head,
    })
    this.persistCandidate({ pendingMessage: message, pendingHash })
    this.pendingHash = pendingHash
    this.pendingMessage = message

    return {
      prepared: true,
      hash: pendingHash,
      message,
      operationCount: this.stagingArea.length,
    }
  }

  async push(approver?: ApproverIdentity, options: PushOptions = {}): Promise<PushResult> {
    if (this.legacyReviewRequired && !this.isAuthenticatedHumanApprover(approver)) {
      throw new Error('Legacy pending approval requires an authenticated human re-review before push')
    }
    return this.mutationCoordinator.withLease({
      hasLegacyPending: this.hasLegacyPending(),
      operation: 'push',
    }, async () => {
      if (options.expectedHash !== undefined && options.expectedHash !== this.pendingHash) {
        throw new PendingApprovalChangedError(options.expectedHash, this.pendingHash)
      }
      if (this.stagingArea.length === 0) {
        throw new Error('Nothing to push: staging area is empty')
      }
      if (this.pendingMessage === null || this.pendingHash === null) {
        throw new Error('Nothing to push: please commit first')
      }

      const operations = [...this.stagingArea]
      const message = this.pendingMessage
      const hash = this.pendingHash

      if (options.preflight) {
        await this.runMutationPhase('push preflight', () => options.preflight!({
          hash,
          message,
          operations: operations.map((operation) => this.projectOperation(operation)),
          approver,
        }))
      }

      if (this.pendingHash !== hash || this.pendingMessage !== message) {
        throw new PendingApprovalChangedError(hash, this.pendingHash)
      }

      return this.executePreparedMutation({
        kind: 'push',
        operations,
        message,
        hash,
        approver,
        execute: this.config.executeOperation,
      })
    })
  }

  async reject(
    reason?: string,
    approver?: ApproverIdentity,
    options: RejectOptions = {},
  ): Promise<RejectResult> {
    if (this.legacyReviewRequired && !this.isAuthenticatedHumanApprover(approver)) {
      throw new Error('Legacy pending approval requires an authenticated human re-review before reject')
    }
    return this.mutationCoordinator.withLease({
      hasLegacyPending: this.hasLegacyPending(),
      operation: 'reject',
    }, async () => {
      if (options.expectedHash !== undefined && options.expectedHash !== this.pendingHash) {
        throw new PendingApprovalChangedError(options.expectedHash, this.pendingHash)
      }
      if (this.stagingArea.length === 0) {
        throw new Error('Nothing to reject: staging area is empty')
      }
      if (this.pendingMessage === null || this.pendingHash === null) {
        throw new Error('Nothing to reject: please commit first')
      }

      const operations = [...this.stagingArea]
      const message = `[rejected] ${this.pendingMessage}${reason ? ` — ${reason}` : ''}`
      const hash = this.pendingHash
      const attempt = this.createAttempt({
        kind: 'human_reject',
        hash,
        message,
        operations,
      })
      const rejectedAttempt = {
        ...attempt,
        ...(approver ? { approver: cloneJson(approver) } : {}),
        operations: attempt.operations.map((entry) => ({
          ...entry,
          state: 'definitely_rejected' as const,
          result: {
            action: entry.operation.action,
            success: false,
            status: 'user-rejected' as const,
            error: reason || 'Rejected by user',
          },
          evidence: { type: 'human-reject', reason: reason || 'Rejected by user' },
        })),
      }

      // Phase 1 linearizes the human decision while clearing the replayable
      // legacy approval fields. A crash before phase 2 cannot resurrect it.
      this.persistAttempt(rejectedAttempt, { clearLegacyApproval: true })

      let stateAfter: GitState
      try {
        stateAfter = await this.runMutationPhase('reject final snapshot', this.config.getGitState)
      } catch (error) {
        throw new MutationRecoveryRequiredError(
          rejectedAttempt.attemptId,
          `Rejected mutation ${rejectedAttempt.attemptId} is durable but final state snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
          error,
        )
      }
      this.finalizeAttempt(rejectedAttempt, stateAfter)
      return { hash, message, operationCount: operations.length }
    })
  }

  async executeSyntheticMutation(params: SyntheticMutationParams): Promise<PushResult> {
    return this.mutationCoordinator.withLease({
      hasLegacyPending: this.hasLegacyPending(),
      operation: params.kind,
    }, async () => {
      // Enumeration happens inside the same account lease as dispatch. This
      // prevents sync/reconcile writers from racing the synthetic snapshot.
      const operations = await this.runMutationPhase(
        `${params.kind} prepare`,
        params.prepare,
      )
      const timestamp = new Date().toISOString()
      const suspendedApproval = this.stagingArea.length > 0
        ? {
            operations: [...this.stagingArea],
            message: this.pendingMessage,
            hash: this.pendingHash,
          }
        : undefined
      const hash = generateCommitHash({
        kind: params.kind,
        message: params.message,
        operations,
        suspendedApproval,
        timestamp,
        parentHash: this.head,
      })

      return this.executePreparedMutation({
        kind: params.kind,
        operations,
        message: params.message,
        hash,
        approver: params.approver,
        context: params.context,
        execute: params.execute,
        suspendedApproval,
      })
    })
  }

  async resolveMutation(params: ResolveMutationParams): Promise<MutationResolveResult> {
    return this.mutationCoordinator.withLease({
      allowActiveAttempt: true,
      hasLegacyPending: this.hasLegacyPending(),
      operation: 'resolve mutation',
    }, async () => {
      const active = this.mutationCoordinator.getActiveAttempt()
      if (!active) throw new Error('No active mutation attempt to resolve')
      if (params.attemptId !== active.attemptId || params.confirmation !== active.attemptId) {
        throw new Error(`Mutation confirmation must exactly match active attempt ${active.attemptId}`)
      }
      if (!params.reason.trim()) throw new Error('Mutation resolution requires a non-empty reason')
      if (params.approver.via !== 'alice-bff' || !params.approver.fingerprint) {
        throw new Error('Mutation resolution requires an authenticated alice-bff approver fingerprint')
      }

      let resolvedAttempt = active
      switch (params.action) {
        case 'discard-never-dispatched': {
          // Retry-idempotent: a first attempt that durably applied phase 1 but
          // failed before finalization leaves every operation already
          // definitely_rejected — accept that state and finish finalization.
          const allPrepared = active.operations.every((entry) => entry.state === 'prepared')
          const allDiscarded = active.operations.every((entry) => entry.state === 'definitely_rejected')
          if (!allPrepared && !allDiscarded) {
            throw new Error('discard-never-dispatched is allowed only when every operation is still prepared')
          }
          resolvedAttempt = allPrepared
            ? this.updateAttemptOperations(active, (entry) => ({
                ...entry,
                state: 'definitely_rejected',
                result: {
                  action: entry.operation.action,
                  success: false,
                  status: 'user-rejected',
                  error: params.reason,
                },
                evidence: {
                  type: 'human-resolution',
                  action: params.action,
                  reason: params.reason,
                  approverFingerprint: params.approver.fingerprint,
                },
                error: params.reason,
              }))
            : active
          break
        }
        case 'acknowledge-uncertainty': {
          if (!active.operations.some((entry) => entry.state === 'uncertain')) {
            throw new Error('acknowledge-uncertainty requires at least one uncertain operation')
          }
          resolvedAttempt = this.updateAttemptOperations(active, (entry) => {
            if (entry.state === 'prepared') {
              return {
                ...entry,
                state: 'definitely_rejected',
                result: {
                  action: entry.operation.action,
                  success: false,
                  status: 'user-rejected',
                  error: 'Not dispatched after an earlier uncertain outcome',
                },
                evidence: {
                  type: 'human-resolution',
                  action: params.action,
                  reason: params.reason,
                  approverFingerprint: params.approver.fingerprint,
                },
              }
            }
            if (entry.state !== 'uncertain') return entry
            return {
              ...entry,
              // Deliberately remain uncertain. Human acknowledgement releases
              // quarantine; it is not evidence of broker acceptance/rejection.
              state: 'uncertain',
              result: {
                ...entry.result,
                action: entry.operation.action,
                success: false,
                status: 'uncertain',
                error: entry.error ?? 'Broker acceptance remains unknown',
              },
              evidence: {
                type: 'human-resolution',
                action: params.action,
                reason: params.reason,
                approverFingerprint: params.approver.fingerprint,
                outcome: 'still-uncertain',
              },
            }
          })
          break
        }
        case 'finalize-known-outcomes': {
          // `prepared` is a known outcome too: it never dispatched (e.g. ops
          // after a timed-out one whose late settlement upgraded it to
          // confirmed). Only genuine uncertainty blocks this action.
          if (active.operations.some((entry) =>
            entry.state !== 'confirmed' && entry.state !== 'definitely_rejected' && entry.state !== 'prepared')) {
            throw new Error('finalize-known-outcomes requires every operation to have a known terminal outcome')
          }
          resolvedAttempt = this.updateAttemptOperations(active, (entry) => {
            if (entry.state !== 'prepared') return entry
            return {
              ...entry,
              state: 'definitely_rejected',
              result: {
                action: entry.operation.action,
                success: false,
                status: 'user-rejected',
                error: 'Never dispatched; discarded during finalize-known-outcomes',
              },
              evidence: {
                type: 'human-resolution',
                action: params.action,
                reason: params.reason,
                approverFingerprint: params.approver.fingerprint,
              },
            }
          })
          break
        }
      }

      const resolution = {
        action: params.action,
        reason: params.reason,
        approver: cloneJson(params.approver),
        at: new Date().toISOString(),
      }
      resolvedAttempt = {
        ...resolvedAttempt,
        updatedAt: resolution.at,
        resolutions: [...(active.resolutions ?? []), resolution],
      }
      // The human decision is itself durable before any snapshot/finalization
      // work. A retry may append another decision, but can never erase this one.
      this.persistAttempt(resolvedAttempt, { clearLegacyApproval: true })
      let stateAfter: GitState
      try {
        stateAfter = await this.runMutationPhase('resolution final snapshot', this.config.getGitState)
      } catch (error) {
        throw new MutationRecoveryRequiredError(
          active.attemptId,
          `Mutation ${active.attemptId} resolution is durable but final state snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
          error,
        )
      }
      this.finalizeAttempt(resolvedAttempt, stateAfter, params.approver, {
        action: params.action,
        reason: params.reason,
      })
      return {
        attemptId: active.attemptId,
        hash: active.hash,
        resolved: true,
        readiness: 'ready',
      }
    })
  }

  /**
   * Append a synthetic reconcileBalance commit to the log without going
   * through staging/push. Used by UTA when broker-reported balance differs
   * from what the order log projects (first-sight bootstrap, external
   * deposit/withdraw, staking reward, off-platform trade) — record the
   * delta as a virtual market trade at observed price so the cost-basis
   * pipeline naturally folds it in.
   *
   * The caller passes the post-reconcile GitState (typically built from
   * the in-flight `getPositions` data) to avoid recursing back through
   * `getGitState` → `broker.getPositions()`.
   */
  async recordReconcile(params: {
    aliceId: string
    quantityDelta: Decimal
    markPrice: Decimal
    stateAfter: GitState
    /**
     * Head observed when the caller took the broker snapshot its drift
     * decision is based on. If the ledger has advanced since (a sync recorded
     * a fill, a push landed), the decision is stale — the write is refused
     * with a null no-op and the next reconcile pass recomputes fresh drift.
     */
    expectedHead: CommitHash | null
    message?: string
  }): Promise<CommitHash | null> {
    return this.withLedgerWriter('record reconcile', async () => {
      if (this.head !== params.expectedHead) return null
      const { aliceId, quantityDelta, markPrice, stateAfter } = params
      const timestamp = new Date().toISOString()

      const qtyStr = quantityDelta.toFixed()
      const priceStr = markPrice.toFixed()

      const operation: Operation = {
        action: 'reconcileBalance',
        aliceId,
        quantityDelta: qtyStr,
        markPrice: priceStr,
      }

      const result: OperationResult = {
        action: 'reconcileBalance',
        success: true,
        status: 'filled',
        filledQty: quantityDelta.abs().toFixed(),
        filledPrice: priceStr,
      }

      const direction = quantityDelta.gte(0) ? 'observed' : 'released'
      const message = params.message
        ?? `reconcile: ${direction} ${quantityDelta.abs().toFixed()} ${aliceId} @ ${priceStr}`

      const hash = generateCommitHash({
        message,
        operations: [operation],
        timestamp,
        parentHash: this.head,
      })

      const commit: GitCommit = {
        hash,
        parentHash: this.head,
        message,
        operations: [operation],
        results: [result],
        stateAfter,
        timestamp,
        round: this.currentRound,
      }

      this.appendCommitDurably(commit)

      return hash
    })
  }

  /**
   * Record externally-observed open orders as ONE squashed commit — the
   * "commits without a message" the user made on the exchange directly.
   * The log is a faithful record, not the source of final state: once an
   * external order is in the log with orderId + submitted, the regular
   * pending scanner and sync poller track its fill/cancel like any
   * Alice-placed order.
   */
  async recordObservedOrders(params: {
    observed: Array<{ contract: Contract; order: Order; orderId: string }>
  }): Promise<{ hash: CommitHash | null; observed: number }> {
    return this.withLedgerWriter('record observed orders', async () => {
      const known = this.getKnownOrderIds()
      const observed = params.observed.filter((entry) => !known.has(entry.orderId))
      if (observed.length === 0) return { hash: null, observed: 0 }
      // Snapshot INSIDE the ledger lease: a push finishing between a
      // caller-captured snapshot and this commit would otherwise persist the
      // newest commit with stale pending orders.
      const stateAfter = await this.runMutationPhase(
        'observed orders state snapshot',
        this.config.getGitState,
      )
      const timestamp = new Date().toISOString()

      const operations: Operation[] = observed.map((o) => ({
        action: 'observeExternalOrder',
        contract: o.contract,
        order: o.order,
      }))
      const results: OperationResult[] = observed.map((o) => ({
        action: 'observeExternalOrder',
        success: true,
        orderId: o.orderId,
        status: 'submitted',
      }))

      const message = `[observed] ${observed.length} external order(s) not placed through Alice`
      const hash = generateCommitHash({ message, operations, timestamp, parentHash: this.head })

      const commit: GitCommit = {
        hash,
        parentHash: this.head,
        message,
        operations,
        results,
        stateAfter,
        timestamp,
        round: this.currentRound,
      }

      this.appendCommitDurably(commit)

      return { hash, observed: observed.length }
    })
  }

  /** Every broker orderId the log has ever seen — observation diffs against this. */
  getKnownOrderIds(): Set<string> {
    const known = new Set<string>()
    for (const commit of this.commits) {
      for (const result of commit.results) {
        if (result.orderId) known.add(result.orderId)
        for (const leg of result.legs ?? []) known.add(leg.orderId)
      }
    }
    return known
  }

  // ==================== git log / show / status ====================

  log(options: { limit?: number; symbol?: string } = {}): CommitLogEntry[] {
    const { limit = 10, symbol } = options

    let commits = this.commits.slice().reverse()

    if (symbol) {
      commits = commits.filter((c) =>
        c.operations.some((op) => getOperationSymbol(op) === symbol),
      )
    }

    commits = commits.slice(0, limit)

    return commits.map((c) => ({
      hash: c.hash,
      parentHash: c.parentHash,
      message: c.message,
      timestamp: c.timestamp,
      round: c.round,
      operations: this.buildOperationSummaries(c, symbol),
    }))
  }

  private buildOperationSummaries(
    commit: GitCommit,
    filterSymbol?: string,
  ): OperationSummary[] {
    const summaries: OperationSummary[] = []

    // Sync commits store ONE syncOrders op with N per-order results — iterate
    // the longer of the two so every update gets its own row, attributed by
    // the result's own symbol (the op carries none).
    const count = Math.max(commit.operations.length, commit.results.length)
    for (let i = 0; i < count; i++) {
      const op = commit.operations[i] ?? commit.operations[0]
      const result = commit.results[i]
      const symbol = result?.symbol || getOperationSymbol(op)

      if (filterSymbol && symbol !== filterSymbol) continue

      summaries.push({
        symbol,
        action: op.action,
        change: this.formatOperationChange(op, result),
        status: result?.status || 'rejected',
      })
    }

    return summaries
  }

  private formatOperationChange(op: Operation, result?: OperationResult): string {
    switch (op.action) {
      case 'placeOrder': {
        const side = op.order?.action || 'unknown' // BUY / SELL
        const qty = op.order?.totalQuantity
        const cashQty = op.order?.cashQty
        const hasQty = qty && !qty.equals(UNSET_DECIMAL)
        const hasCash = cashQty && !cashQty.equals(UNSET_DECIMAL) && cashQty.gt(0)
        const sizeStr = hasCash ? `$${cashQty.toFixed()}` : hasQty ? `${qty.toFixed()}` : '?'

        if (result?.status === 'user-rejected') {
          return `${side} ${sizeStr} (user-rejected)`
        }
        if (result?.status === 'filled') {
          const price = result.execution?.price ? ` @${result.execution.price}` : ''
          return `${side} ${sizeStr}${price}`
        }
        return `${side} ${sizeStr} (${result?.status || 'unknown'})`
      }

      case 'closePosition': {
        const qty = op.quantity
        if (result?.status === 'filled') {
          const price = result.execution?.price ? ` @${result.execution.price}` : ''
          const qtyStr = qty ? ` (partial: ${qty})` : ''
          return `closed${qtyStr}${price}`
        }
        return `close (${result?.status || 'unknown'})`
      }

      case 'modifyOrder': {
        return `modified ${op.orderId}`
      }

      case 'cancelOrder':
        return `cancelled order ${op.orderId}`

      case 'emergencyCancelOrder':
        return `emergency-cancelled order ${op.orderId}`

      case 'emergencyClosePosition': {
        if (result?.status === 'filled') {
          const price = result.execution?.price ? ` @${result.execution.price}` : ''
          return `flattened ${op.quantity.toFixed()}${price}`
        }
        return `flatten (${result?.status || 'unknown'})`
      }

      case 'syncOrders': {
        const status = result?.status || 'unknown'
        const price = result?.filledPrice ? ` @${result.filledPrice}`
          : result?.execution?.price ? ` @${result.execution.price}` : ''
        const qty = result?.filledQty ? ` (${result.filledQty} filled)` : ''
        return `synced → ${status}${price}${qty}`
      }

      case 'observeExternalOrder': {
        const side = op.order?.action || 'unknown'
        const qty = op.order?.totalQuantity
        const qtyStr = qty && !qty.equals(UNSET_DECIMAL) ? qty.toFixed() : '?'
        if (result?.status === 'filled') {
          const price = result.filledPrice ? ` @${result.filledPrice}` : ''
          return `external ${side} ${qtyStr}${price}`
        }
        return `external ${side} ${qtyStr} (${result?.status || 'observed'})`
      }

      case 'reconcileBalance': {
        const delta = new Decimal(op.quantityDelta)
        const direction = delta.gte(0) ? 'observed' : 'released'
        return `${direction} ${delta.abs().toFixed()} @${op.markPrice}`
      }
    }
  }

  show(hash: CommitHash): GitCommit | null {
    const commit = this.commits.find((c) => c.hash === hash)
    return commit ? this.projectCommit(commit) : null
  }

  status(): GitStatus {
    return {
      staged: this.stagingArea.map((op) => this.projectOperation(op)),
      pendingMessage: this.pendingMessage,
      pendingHash: this.pendingHash,
      head: this.head,
      commitCount: this.commits.length,
      mutation: this.projectMutationStatus(),
    }
  }

  // Strip IBKR sentinel defaults before any Operation leaves this class —
  // raw Order instances stay private to staging / push internals, never
  // observed by external callers (UI, MCP, c.json, on-disk commit.json).
  private projectOperation(op: Operation): Operation {
    const projected = TradingGit.cloneOperation(op)
    if (projected.action === 'placeOrder' || projected.action === 'observeExternalOrder') {
      return { ...projected, order: OrderHelper.toWire(projected.order) as unknown as Order }
    }
    if (projected.action === 'emergencyCancelOrder') {
      return projected.order
        ? { ...projected, order: OrderHelper.toWire(projected.order) as unknown as Order }
        : projected
    }
    if (projected.action === 'modifyOrder') {
      return { ...projected, changes: OrderHelper.toWire(projected.changes) as unknown as Partial<Order> }
    }
    return projected
  }

  private projectCommit(commit: GitCommit): GitCommit {
    return {
      ...commit,
      operations: commit.operations.map((op) => this.projectOperation(op)),
      results: commit.results.map((result) => this.sanitizeOperationResult(result)),
      ...(commit.mutationAudit
        ? { mutationAudit: JSON.parse(JSON.stringify(commit.mutationAudit)) as GitCommit['mutationAudit'] }
        : {}),
    }
  }

  // ==================== Serialization ====================

  exportState(): GitExportState {
    return this.buildExportState()
  }

  static restore(state: GitExportState, config: TradingGitConfig): TradingGit {
    const git = new TradingGit(config)
    git.commits = state.commits.map(TradingGit.rehydrateCommit)
    git.head = state.head
    TradingGit.restoreTransientState(git, state)
    const restoredEnvelope = TradingGit.rehydrateMutationEnvelope(state.mutation)
    const legacyReviewRequired = state.mutation === undefined
      && git.stagingArea.length > 0
      && git.pendingMessage !== null
      && git.pendingHash !== null
    // replaceEnvelope normalizes crashed `dispatching` operations to
    // `uncertain` on every entry — restore gets the quarantine for free.
    git.mutationCoordinator.replaceEnvelope(
      restoredEnvelope ?? (legacyReviewRequired ? undefined : { schemaVersion: MUTATION_SCHEMA_VERSION }),
    )
    git.legacyReviewRequired = legacyReviewRequired
    return git
  }

  private static restoreTransientState(git: TradingGit, state: GitExportState): void {
    const hasTransientFields =
      Object.prototype.hasOwnProperty.call(state, 'stagingArea') ||
      Object.prototype.hasOwnProperty.call(state, 'pendingMessage') ||
      Object.prototype.hasOwnProperty.call(state, 'pendingHash')

    if (!hasTransientFields) return

    if (state.stagingArea !== undefined && !Array.isArray(state.stagingArea)) {
      console.error('[TradingGit] Dropped malformed transient approval state during restore: stagingArea is not an array')
      return
    }

    let stagingArea: Operation[]
    try {
      stagingArea = (state.stagingArea ?? []).map(TradingGit.cloneOperation)
    } catch (error) {
      console.error('[TradingGit] Dropped malformed transient approval state during restore: stagingArea could not be rehydrated', error)
      return
    }

    const pendingMessage = state.pendingMessage ?? null
    const pendingHash = state.pendingHash ?? null
    const pendingMessageValid = pendingMessage === null || typeof pendingMessage === 'string'
    const pendingHashValid = pendingHash === null || (
      typeof pendingHash === 'string' && /^[a-f0-9]{8}$/.test(pendingHash)
    )

    git.stagingArea = stagingArea

    if (!pendingMessageValid || !pendingHashValid) {
      console.error('[TradingGit] Dropped malformed pending approval during restore: pendingMessage/pendingHash have invalid types or hash shape')
      return
    }

    const hasPending = pendingMessage !== null || pendingHash !== null
    if (!hasPending) {
      if (stagingArea.length > 0) {
        console.warn(
          `[TradingGit] Restored ${stagingArea.length} staged (uncommitted) operation(s) from disk`,
        )
      }
      return
    }

    if (pendingMessage === null || pendingHash === null || stagingArea.length === 0) {
      console.error('[TradingGit] Dropped malformed pending approval during restore: pending approval requires stagingArea, pendingMessage, and pendingHash')
      return
    }

    git.pendingMessage = pendingMessage
    git.pendingHash = pendingHash
    console.warn(
      `[TradingGit] Restored pending approval ${pendingHash} with ${stagingArea.length} staged operation(s): ${pendingMessage}`,
    )
  }

  /** Rehydrate Decimal fields lost during JSON round-trip. */
  private static rehydrateCommit(commit: GitCommit): GitCommit {
    return {
      ...commit,
      operations: commit.operations.map(TradingGit.cloneOperation),
      stateAfter: TradingGit.rehydrateGitState(commit.stateAfter),
    }
  }

  private static cloneOperation(op: Operation): Operation {
    let cloneable: Operation = op
    if (op.action === 'placeOrder' || op.action === 'observeExternalOrder') {
      cloneable = { ...op, order: OrderHelper.toWire(op.order) as unknown as Order }
    } else if (op.action === 'emergencyCancelOrder' && op.order) {
      cloneable = { ...op, order: OrderHelper.toWire(op.order) as unknown as Order }
    } else if (op.action === 'modifyOrder') {
      cloneable = { ...op, changes: OrderHelper.toWire(op.changes) as unknown as Partial<Order> }
    }
    return TradingGit.rehydrateOperation(JSON.parse(JSON.stringify(cloneable)) as Operation)
  }

  private static rehydrateOperation(op: Operation): Operation {
    switch (op.action) {
      case 'placeOrder':
      case 'observeExternalOrder':
        return {
          ...op,
          order: TradingGit.rehydrateOrder(op.order),
        }
      case 'emergencyCancelOrder':
        return {
          ...op,
          order: op.order ? TradingGit.rehydrateOrder(op.order) : op.order,
        }
      case 'closePosition':
        return {
          ...op,
          quantity: op.quantity != null ? new Decimal(String(op.quantity)) : op.quantity,
        }
      case 'emergencyClosePosition':
        return {
          ...op,
          quantity: op.quantity != null ? new Decimal(String(op.quantity)) : op.quantity,
        }
      case 'modifyOrder':
        return {
          ...op,
          changes: TradingGit.rehydrateOrderChanges(op.changes),
        }
      default:
        return op
    }
  }

  private static rehydrateOrderChanges(changes: Partial<Order>): Partial<Order> {
    const rehydrated = { ...changes }
    if (changes.totalQuantity != null) {
      rehydrated.totalQuantity = new Decimal(String(changes.totalQuantity))
    }
    if (changes.lmtPrice != null) {
      rehydrated.lmtPrice = new Decimal(String(changes.lmtPrice))
    }
    if (changes.auxPrice != null) {
      rehydrated.auxPrice = new Decimal(String(changes.auxPrice))
    }
    if (changes.trailStopPrice != null) {
      rehydrated.trailStopPrice = new Decimal(String(changes.trailStopPrice))
    }
    if (changes.trailingPercent != null) {
      rehydrated.trailingPercent = new Decimal(String(changes.trailingPercent))
    }
    if (changes.cashQty != null) {
      rehydrated.cashQty = new Decimal(String(changes.cashQty))
    }
    return rehydrated
  }

  private static rehydrateOrder(order: Order): Order {
    const rehydrated = Object.assign(new Order(), order)
    // Decimal fields need re-wrapping after JSON.parse — strings or numbers
    // become plain JS values, not Decimal instances. `new Decimal(String(x))`
    // accepts both legacy (number) and current (string) persisted forms.
    if (order.totalQuantity != null) {
      rehydrated.totalQuantity = new Decimal(String(order.totalQuantity))
    }
    if (order.lmtPrice != null) {
      rehydrated.lmtPrice = new Decimal(String(order.lmtPrice))
    }
    if (order.auxPrice != null) {
      rehydrated.auxPrice = new Decimal(String(order.auxPrice))
    }
    if (order.trailStopPrice != null) {
      rehydrated.trailStopPrice = new Decimal(String(order.trailStopPrice))
    }
    if (order.trailingPercent != null) {
      rehydrated.trailingPercent = new Decimal(String(order.trailingPercent))
    }
    if (order.cashQty != null) {
      rehydrated.cashQty = new Decimal(String(order.cashQty))
    }
    return rehydrated
  }

  private static rehydrateGitState(state: GitState): GitState {
    return {
      ...state,
      positions: state.positions.map((pos) => ({
        ...pos,
        quantity: new Decimal(String(pos.quantity)),
        // Position.multiplier became required in the IBKR-as-truth refactor
        // (Phase 1). Older commit.json files written under the optional
        // contract have positions with no multiplier set — fill the
        // canonical default so they don't fail downstream consumers that
        // expect every Position to declare one.
        multiplier: pos.multiplier ?? '1',
      })),
    }
  }

  setCurrentRound(round: number): void {
    this.currentRound = round
  }

  // ==================== Sync ====================

  async sync(updates: OrderStatusUpdate[]): Promise<SyncResult> {
    if (updates.length === 0) {
      return { hash: this.head ?? '', updatedCount: 0, updates: [] }
    }

    return this.withLedgerWriter('sync orders', async () => {
      const pendingIds = new Set(this.getPendingOrderIds().map((entry) => entry.orderId))
      const applicable = updates.filter((update) => pendingIds.has(update.orderId))
      if (applicable.length === 0) {
        return { hash: this.head ?? '', updatedCount: 0, updates: [] }
      }
      // Snapshot INSIDE the ledger lease — see recordObservedOrders.
      const currentState = await this.runMutationPhase(
        'sync state snapshot',
        this.config.getGitState,
      )
      const hash = generateCommitHash({
        updates: applicable,
        timestamp: new Date().toISOString(),
        parentHash: this.head,
      })

      const commit: GitCommit = {
        hash,
        parentHash: this.head,
        message: `[sync] ${applicable.slice(0, 3).map((u) => `${u.symbol} ${u.currentStatus}`).join(', ')}${applicable.length > 3 ? ` +${applicable.length - 3} more` : ''}`,
        operations: [{ action: 'syncOrders' as const }],
        results: applicable.map((u) => ({
          action: 'syncOrders' as const,
          success: true,
          orderId: u.orderId,
          symbol: u.symbol,
          status: u.currentStatus,
          filledQty: u.filledQty,
          filledPrice: u.filledPrice,
        })),
        stateAfter: currentState,
        timestamp: new Date().toISOString(),
        round: this.currentRound,
      }

      this.appendCommitDurably(commit)

      return { hash, updatedCount: applicable.length, updates: applicable }
    })
  }

  getPendingOrderIds(): Array<{ orderId: string; symbol: string; localSymbol?: string; aliceId?: string }> {
    // Scan newest→oldest to find latest known status per orderId.
    // Bracket TP/SL legs ride in result.legs — born 'submitted'; any later
    // sync row for a leg lives in a newer commit and wins (first-seen-wins
    // over a newest-first scan).
    const orderStatus = new Map<string, string>()
    const activeAttempt = this.mutationCoordinator.getActiveAttempt()

    // The final broker snapshot is taken before the attempt becomes a commit.
    // Treat its durable receipts as the newest status so a just-submitted
    // resting order (and bracket legs) is included in stateAfter.
    for (const entry of activeAttempt?.operations ?? []) {
      const result = entry.result
      if (!result) continue
      if (result.orderId && !orderStatus.has(result.orderId)) {
        orderStatus.set(result.orderId, result.status)
      }
      for (const leg of result.legs ?? []) {
        if (!orderStatus.has(leg.orderId)) orderStatus.set(leg.orderId, 'submitted')
      }
    }

    for (let i = this.commits.length - 1; i >= 0; i--) {
      for (const result of this.commits[i].results) {
        if (result.orderId && !orderStatus.has(result.orderId)) {
          orderStatus.set(result.orderId, result.status)
        }
        for (const leg of result.legs ?? []) {
          if (!orderStatus.has(leg.orderId)) orderStatus.set(leg.orderId, 'submitted')
        }
      }
    }

    // Collect orders still pending
    const pending: Array<{ orderId: string; symbol: string; localSymbol?: string; aliceId?: string }> = []
    const seen = new Set<string>()

    for (const commit of this.commits) {
      for (let j = 0; j < commit.results.length; j++) {
        const result = commit.results[j]
        // Sync commits store ONE syncOrders op with N per-order results —
        // operations[j] is undefined past index 0 (a multi-update sync
        // commit in the journal turned this into a BOOT-LOOP crash once).
        const op = commit.operations[j] ?? commit.operations[0]
        const symbol = getOperationSymbol(op)
        // Broker-native symbol for symbol-scoped order lookups (CCXT).
        // Persisted with the operation, so it survives process restarts
        // where the broker's in-memory orderId→symbol cache is empty.
        const hasContract =
          op?.action === 'placeOrder' ||
          op?.action === 'closePosition' ||
          op?.action === 'observeExternalOrder' ||
          op?.action === 'emergencyCancelOrder' ||
          op?.action === 'emergencyClosePosition'
        const localSymbol = hasContract ? op.contract?.localSymbol || undefined : undefined
        const aliceId = hasContract ? op.contract?.aliceId || undefined : undefined

        // Parent order + its bracket legs share the operation's contract.
        const candidates = [
          ...(result.orderId ? [result.orderId] : []),
          ...(result.legs ?? []).map((l) => l.orderId),
        ]
        for (const orderId of candidates) {
          if (seen.has(orderId) || orderStatus.get(orderId) !== 'submitted') continue
          pending.push({
            orderId,
            symbol,
            ...(localSymbol && { localSymbol }),
            ...(aliceId && { aliceId }),
          })
          seen.add(orderId)
        }
      }
    }

    for (const entry of activeAttempt?.operations ?? []) {
      const result = entry.result
      if (!result) continue
      const operation = entry.operation
      const hasContract = 'contract' in operation
      const symbol = getOperationSymbol(operation)
      const localSymbol = hasContract ? operation.contract.localSymbol || undefined : undefined
      const aliceId = hasContract ? operation.contract.aliceId || undefined : undefined
      const candidates = [
        ...(result.orderId ? [result.orderId] : []),
        ...(result.legs ?? []).map((leg) => leg.orderId),
      ]
      for (const orderId of candidates) {
        if (seen.has(orderId) || orderStatus.get(orderId) !== 'submitted') continue
        pending.push({
          orderId,
          symbol,
          ...(localSymbol ? { localSymbol } : {}),
          ...(aliceId ? { aliceId } : {}),
        })
        seen.add(orderId)
      }
    }

    return pending
  }

  // ==================== Simulation ====================

  async simulatePriceChange(
    priceChanges: PriceChangeInput[],
  ): Promise<SimulatePriceChangeResult> {
    const state = await this.config.getGitState()
    const { positions } = state
    const equity = new Decimal(state.netLiquidation)
    const unrealizedPnL = new Decimal(state.unrealizedPnL)
    const cash = new Decimal(state.totalCashValue)

    const currentTotalPnL = cash.gt(0) ? equity.minus(cash).div(cash).mul(100) : new Decimal(0)

    if (positions.length === 0) {
      return {
        success: true,
        currentState: { equity: equity.toString(), unrealizedPnL: unrealizedPnL.toString(), totalPnL: currentTotalPnL.toString(), positions: [] },
        simulatedState: { equity: equity.toString(), unrealizedPnL: unrealizedPnL.toString(), totalPnL: currentTotalPnL.toString(), positions: [] },
        summary: {
          totalPnLChange: '0',
          equityChange: '0',
          equityChangePercent: '0.0%',
          worstCase: 'No positions to simulate.',
        },
      }
    }

    // Parse price changes → per-position target prices. Index-keyed: bare
    // symbols collide between an underlying and its derivatives.
    const priceByIndex = new Map<number, Decimal>()
    const excludedDerivatives: string[] = []

    for (const { symbol, change } of priceChanges) {
      const parsed = this.parsePriceChange(change)
      if (!parsed.success) {
        return {
          success: false,
          error: `Invalid change format for ${symbol}: "${change}". Use "@150" for absolute or "+10%" / "-5%" for relative.`,
          currentState: { equity: equity.toString(), unrealizedPnL: unrealizedPnL.toString(), totalPnL: currentTotalPnL.toString(), positions: [] },
          simulatedState: { equity: equity.toString(), unrealizedPnL: unrealizedPnL.toString(), totalPnL: currentTotalPnL.toString(), positions: [] },
          summary: { totalPnLChange: '0', equityChange: '0', equityChangePercent: '0.0%', worstCase: '' },
        }
      }

      if (symbol === 'all') {
        for (let i = 0; i < positions.length; i++) {
          // 'all' scales each position's OWN mark — valid for derivatives too.
          priceByIndex.set(i, this.applyPriceChange(new Decimal(positions[i].marketPrice), parsed.type, parsed.value))
        }
      } else {
        for (let i = 0; i < positions.length; i++) {
          const pos = positions[i]
          if ((pos.contract.symbol || pos.contract.aliceId) !== symbol) continue
          // A symbol-level price change describes the UNDERLYING. Derivative
          // rows share the symbol but do NOT move 1:1 with it (an option's
          // own price is not the stock's price) — re-marking them with the
          // stock price produced +23,000% "moves" and inverted PnL. Exclude
          // loudly instead of pricing garbage.
          if (DERIVATIVE_SECTYPES.has(pos.contract.secType)) {
            excludedDerivatives.push(`${symbol} ${pos.contract.secType}${pos.contract.strike && !new Decimal(pos.contract.strike).equals(UNSET_DOUBLE) ? ' ' + pos.contract.strike : ''}`)
            continue
          }
          priceByIndex.set(i, this.applyPriceChange(new Decimal(pos.marketPrice), parsed.type, parsed.value))
        }
      }
    }

    // Current state
    const currentPositions = positions.map((pos) => ({
      symbol: pos.contract.symbol || pos.contract.aliceId || 'unknown',
      side: pos.side,
      qty: pos.quantity.toString(),
      avgCost: pos.avgCost,
      marketPrice: pos.marketPrice,
      unrealizedPnL: pos.unrealizedPnL,
      marketValue: pos.marketValue,
    }))

    // Simulated state
    let simulatedUnrealizedPnL = new Decimal(0)
    const simulatedPositions = positions.map((pos, i) => {
      const sym = pos.contract.symbol || pos.contract.aliceId || 'unknown'
      const mktPrice = new Decimal(pos.marketPrice)
      const simulatedPrice = priceByIndex.get(i) ?? mktPrice
      const priceChange = simulatedPrice.minus(mktPrice)
      const priceChangePct = mktPrice.gt(0) ? priceChange.div(mktPrice).mul(100) : new Decimal(0)
      const q = pos.quantity
      const avgCost = new Decimal(pos.avgCost)
      // Multiplier-aware: 1 option contract at price 1.15 is $115 of value.
      const mult = new Decimal(pos.multiplier || '1')

      const newPnL =
        pos.side === 'long'
          ? simulatedPrice.minus(avgCost).mul(q).mul(mult)
          : avgCost.minus(simulatedPrice).mul(q).mul(mult)

      const pnlChange = newPnL.minus(pos.unrealizedPnL)
      simulatedUnrealizedPnL = simulatedUnrealizedPnL.plus(newPnL)

      return {
        symbol: sym,
        side: pos.side,
        qty: q.toString(),
        avgCost: pos.avgCost,
        simulatedPrice: simulatedPrice.toString(),
        unrealizedPnL: newPnL.toString(),
        marketValue: simulatedPrice.mul(q).mul(mult).toString(),
        pnlChange: pnlChange.toString(),
        priceChangePercent: `${priceChangePct.gte(0) ? '+' : ''}${priceChangePct.toFixed(2)}%`,
      }
    })

    const pnlDiff = simulatedUnrealizedPnL.minus(unrealizedPnL)
    const simulatedEquity = equity.plus(pnlDiff)
    const simulatedTotalPnL = cash.gt(0) ? simulatedEquity.minus(cash).div(cash).mul(100) : new Decimal(0)
    const equityChangePct = equity.gt(0) ? pnlDiff.div(equity).mul(100) : new Decimal(0)

    const worst = simulatedPositions.reduce(
      (w, p) => (new Decimal(p.pnlChange).lt(w.pnlChange) ? { ...p, pnlChange: new Decimal(p.pnlChange) } : w),
      { ...simulatedPositions[0], pnlChange: new Decimal(simulatedPositions[0].pnlChange) },
    )

    const excludedNote = excludedDerivatives.length > 0
      ? ` NOTE: derivative positions not simulated (their price does not track the underlying 1:1): ${excludedDerivatives.join(', ')}.`
      : ''
    const worstCase =
      (worst.pnlChange.lt(0)
        ? `${worst.symbol} would lose $${worst.pnlChange.abs().toFixed(2)} (${worst.priceChangePercent})`
        : 'All positions would profit or break even.') + excludedNote

    return {
      success: true,
      currentState: { equity: equity.toString(), unrealizedPnL: unrealizedPnL.toString(), totalPnL: currentTotalPnL.toString(), positions: currentPositions },
      simulatedState: {
        equity: simulatedEquity.toString(),
        unrealizedPnL: simulatedUnrealizedPnL.toString(),
        totalPnL: simulatedTotalPnL.toString(),
        positions: simulatedPositions,
      },
      summary: {
        totalPnLChange: pnlDiff.toString(),
        equityChange: pnlDiff.toString(),
        equityChangePercent: `${equityChangePct.gte(0) ? '+' : ''}${equityChangePct.toFixed(2)}%`,
        worstCase,
      },
    }
  }

  private parsePriceChange(
    change: string,
  ): { success: true; type: 'absolute' | 'relative'; value: number } | { success: false } {
    const trimmed = change.trim()

    if (trimmed.startsWith('@')) {
      const value = parseFloat(trimmed.slice(1))
      if (isNaN(value) || value <= 0) return { success: false }
      return { success: true, type: 'absolute', value }
    }

    if (trimmed.endsWith('%')) {
      const value = parseFloat(trimmed.slice(0, -1))
      if (isNaN(value)) return { success: false }
      return { success: true, type: 'relative', value }
    }

    return { success: false }
  }

  private applyPriceChange(
    currentPrice: Decimal,
    type: 'absolute' | 'relative',
    value: number,
  ): Decimal {
    return type === 'absolute' ? new Decimal(value) : currentPrice.mul(new Decimal(1).plus(new Decimal(value).div(100)))
  }

  // ==================== Internal ====================

  /**
   * Bounded read-only phases (preflight, prepare, snapshots). Broker DISPATCH
   * never goes through here — it uses runBrokerDispatch, whose timeout
   * registers the orphaned call instead of silently dropping it.
   */
  private async runMutationPhase<T>(phase: string, task: () => Promise<T>): Promise<T> {
    const timeoutMs = this.mutationTimeoutMs()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${phase} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
    })

    try {
      return await Promise.race([Promise.resolve().then(task), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private hasLegacyPending(): boolean {
    return this.legacyReviewRequired
      && this.stagingArea.length > 0
      && this.pendingMessage !== null
      && this.pendingHash !== null
  }

  private isAuthenticatedHumanApprover(approver: ApproverIdentity | undefined): boolean {
    return approver?.via === 'alice-bff' && Boolean(approver.fingerprint)
  }

  private assertLedgerWriteAllowed(operation: string): void {
    this.mutationCoordinator.assertLedgerWriteAllowed(operation)
  }

  private withLedgerWriter<T>(operation: string, task: () => Promise<T>): Promise<T> {
    return this.mutationCoordinator.withLease({
      hasLegacyPending: this.hasLegacyPending(),
      operation,
    }, task)
  }

  private projectMutationStatus(): NonNullable<GitStatus['mutation']> {
    return this.mutationCoordinator.getStatus(this.hasLegacyPending())
  }

  private buildExportState(overrides: ExportStateOverrides = {}): GitExportState {
    const hasMutationOverride = Object.prototype.hasOwnProperty.call(overrides, 'mutation')
    const mutation = hasMutationOverride
      ? overrides.mutation
      : this.mutationCoordinator.getEnvelope()
    const commits = overrides.commits ?? this.commits
    const head = Object.prototype.hasOwnProperty.call(overrides, 'head') ? overrides.head! : this.head
    const stagingArea = overrides.stagingArea ?? this.stagingArea
    const pendingMessage = Object.prototype.hasOwnProperty.call(overrides, 'pendingMessage')
      ? overrides.pendingMessage!
      : this.pendingMessage
    const pendingHash = Object.prototype.hasOwnProperty.call(overrides, 'pendingHash')
      ? overrides.pendingHash!
      : this.pendingHash

    return {
      commits: commits.map((commit) => this.projectCommit(commit)),
      head,
      stagingArea: stagingArea.map((operation) => this.projectOperation(operation)),
      pendingMessage,
      pendingHash,
      ...(mutation ? { mutation: this.projectMutationEnvelope(mutation) } : {}),
    }
  }

  private projectMutationEnvelope(envelope: MutationEnvelope): MutationEnvelope {
    if (envelope.schemaVersion !== MUTATION_SCHEMA_VERSION) {
      return JSON.parse(JSON.stringify(envelope)) as MutationEnvelope
    }
    const activeAttempt = envelope.activeAttempt as MutationAttemptV1 | undefined
    if (!activeAttempt) return { schemaVersion: MUTATION_SCHEMA_VERSION }
    const projected: MutationEnvelope = {
      schemaVersion: MUTATION_SCHEMA_VERSION,
      activeAttempt: {
        ...activeAttempt,
        operations: activeAttempt.operations.map((entry) => ({
          ...entry,
          operation: this.projectOperation(entry.operation),
          ...(entry.result ? { result: this.sanitizeOperationResult(entry.result) } : {}),
        })),
        ...(activeAttempt.suspendedApproval ? {
          suspendedApproval: {
            ...activeAttempt.suspendedApproval,
            operations: activeAttempt.suspendedApproval.operations.map((operation) =>
              this.projectOperation(operation)),
          },
        } : {}),
      },
    }
    return JSON.parse(JSON.stringify(projected)) as MutationEnvelope
  }

  /**
   * The single durability boundary: synchronous, throwing, never thenable.
   * If the persister returns a Promise, durability is deferred past the point
   * this method returns — memory can no longer be trusted, so the coordinator
   * is poisoned exactly as for a thrown persistence error.
   */
  private persistCandidate(overrides: ExportStateOverrides): void {
    try {
      const result = this.config.onCommit?.(this.buildExportState(overrides)) as unknown
      if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
        throw new Error(
          'TradingGit persister must be synchronous: onCommit returned a thenable, so the write '
          + 'may complete after broker dispatch. Persistence state is now unknown; restart required.',
        )
      }
    } catch (error) {
      this.handlePersistenceFailure(error, overrides.mutation)
      throw error
    }
  }

  private handlePersistenceFailure(error: unknown, candidateEnvelope?: MutationEnvelope): void {
    this.mutationCoordinator.poison(error)
    const candidateAttempt = candidateEnvelope?.schemaVersion === MUTATION_SCHEMA_VERSION
      ? candidateEnvelope.activeAttempt as MutationAttemptV1 | undefined
      : undefined
    const attempt = candidateAttempt ?? this.mutationCoordinator.getActiveAttempt()
    // Deliberately no error.message here: persister errors can embed arbitrary
    // context (paths, URLs, upstream SDK payloads). Log stable classification
    // fields only; the full error propagates to the caller for handling.
    console.error('[TradingGit] CRITICAL mutation persistence failure', {
      accountId: this.config.accountId ?? 'unknown',
      pendingHash: attempt?.hash ?? this.pendingHash ?? undefined,
      attemptId: attempt?.attemptId ?? undefined,
      recovery: 'restart-and-resolve-before-any-further-write',
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined,
    })
  }

  private appendCommitDurably(commit: GitCommit): void {
    const commits = [...this.commits, commit]
    this.persistCandidate({ commits, head: commit.hash })
    this.commits = commits
    this.head = commit.hash
  }

  private createAttempt(params: {
    kind: MutationAttemptKind
    hash: CommitHash
    message: string
    operations: Operation[]
    approver?: ApproverIdentity
    context?: MutationAttemptV1['context']
    suspendedApproval?: MutationAttemptV1['suspendedApproval']
  }): MutationAttemptV1 {
    const now = new Date().toISOString()
    const attemptId = randomUUID()
    return {
      attemptId,
      kind: params.kind,
      hash: params.hash,
      message: params.message,
      approver: params.approver ? cloneJson(params.approver) : { via: 'loopback', at: now },
      createdAt: now,
      updatedAt: now,
      ...(params.context ? { context: cloneJson(params.context) } : {}),
      // Ownership boundary: everything stored in the durable attempt is a
      // private copy. A caller (or the broker) mutating its own objects after
      // this point cannot rewrite the recorded intent or finalized audit.
      operations: params.operations.map((operation, index) => ({
        operationId: `${attemptId}:${index}`,
        index,
        operation: TradingGit.cloneOperation(operation),
        state: 'prepared',
        updatedAt: now,
      })),
      ...(params.suspendedApproval ? {
        suspendedApproval: {
          operations: params.suspendedApproval.operations.map(TradingGit.cloneOperation),
          message: params.suspendedApproval.message,
          hash: params.suspendedApproval.hash,
        },
      } : {}),
    }
  }

  private updateAttemptOperations(
    attempt: MutationAttemptV1,
    update: (operation: MutationOperationV1) => MutationOperationV1,
  ): MutationAttemptV1 {
    const updatedAt = new Date().toISOString()
    return {
      ...attempt,
      updatedAt,
      operations: attempt.operations.map((operation) => {
        const updated = update(operation)
        return updated === operation ? operation : { ...updated, updatedAt }
      }),
    }
  }

  private persistAttempt(
    attempt: MutationAttemptV1,
    options: { clearLegacyApproval: boolean },
  ): void {
    const envelope: MutationEnvelope = {
      schemaVersion: MUTATION_SCHEMA_VERSION,
      activeAttempt: attempt,
    }
    const overrides: ExportStateOverrides = {
      mutation: envelope,
      ...(options.clearLegacyApproval ? {
        stagingArea: [],
        pendingMessage: null,
        pendingHash: null,
      } : {}),
    }
    try {
      this.persistCandidate(overrides)
    } catch (error) {
      throw new MutationRecoveryRequiredError(
        attempt.attemptId,
        `Failed to durably persist mutation ${attempt.attemptId}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      )
    }
    this.mutationCoordinator.replaceEnvelope(envelope)
    if (options.clearLegacyApproval) {
      this.stagingArea = []
      this.pendingMessage = null
      this.pendingHash = null
    }
  }

  private async executePreparedMutation(params: PreparedMutationParams): Promise<PushResult> {
    let attempt = this.createAttempt(params)
    this.persistAttempt(attempt, { clearLegacyApproval: true })

    for (const prepared of attempt.operations) {
      attempt = this.transitionAttemptOperation(attempt, prepared.index, {
        state: 'dispatching',
        result: undefined,
        evidence: { type: 'durable-before-broker-dispatch' },
        error: undefined,
      })

      const operation = attempt.operations[prepared.index].operation
      // The broker receives its own copy: venue SDKs mutate the objects they
      // are handed (e.g. assigning orderId onto the Order), which must never
      // rewrite the durable attempt record.
      const dispatchOperation = TradingGit.cloneOperation(operation)
      let terminal: Pick<MutationOperationV1, 'state' | 'result' | 'evidence' | 'error'>
      try {
        const raw = await this.runBrokerDispatch(
          attempt,
          attempt.operations[prepared.index].operationId,
          params.kind,
          () => params.execute(dispatchOperation),
        )
        terminal = this.classifyMutationOutcome(operation, raw)
      } catch (error) {
        terminal = this.classifyMutationError(operation, error)
      }

      attempt = this.transitionAttemptOperation(attempt, prepared.index, terminal)
      if (terminal.state === 'uncertain') {
        throw new MutationRecoveryRequiredError(
          attempt.attemptId,
          `Broker acceptance is uncertain for mutation attempt ${attempt.attemptId}; human resolution is required`,
        )
      }
    }

    let stateAfter: GitState
    try {
      stateAfter = await this.runMutationPhase('mutation final snapshot', this.config.getGitState)
    } catch (error) {
      if (attempt.operations.length === 0) {
        // Zero-operation attempts (HALT-only emergency stop, flatten with no
        // positions) made no venue call — there is nothing uncertain to
        // quarantine. Blocking here would turn an unreachable broker into a
        // recovery lockout for the containment action itself. Fall back to
        // the last known snapshot and finalize with a degraded-state marker.
        this.finalizeAttempt(attempt, this.lastKnownGitState(), undefined, undefined, {
          stateAfterDegraded: true,
        })
        return {
          hash: attempt.hash,
          message: attempt.message,
          operationCount: 0,
          submitted: [],
          rejected: [],
        }
      }
      throw new MutationRecoveryRequiredError(
        attempt.attemptId,
        `Mutation ${attempt.attemptId} has durable outcomes but final state snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      )
    }

    this.finalizeAttempt(attempt, stateAfter)
    const results = attempt.operations.map((entry) => this.resultForMutationEntry(entry))
    return {
      hash: attempt.hash,
      message: attempt.message,
      operationCount: attempt.operations.length,
      submitted: results.filter((result) => result.success),
      rejected: results.filter((result) => !result.success),
    }
  }

  /**
   * Run a broker dispatch under the configured timeout WITHOUT pretending the
   * timeout cancels anything. On timeout the still-pending Promise is
   * registered as an orphaned dispatch: the coordinator refuses resolution
   * and any further mutation IN THIS PROCESS until a real restart — even if
   * the orphaned call later settles (its outcome is still durably recorded as
   * evidence for the post-restart human decision).
   */
  private async runBrokerDispatch(
    attempt: MutationAttemptV1,
    operationId: string,
    kind: string,
    task: () => Promise<unknown>,
  ): Promise<unknown> {
    const timeoutMs = this.mutationTimeoutMs()
    const taskPromise = Promise.resolve().then(task)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutSentinel: unique symbol = Symbol('dispatch-timeout')
    const timeout = new Promise<typeof timeoutSentinel>((resolve) => {
      timer = setTimeout(() => resolve(timeoutSentinel), timeoutMs)
      timer.unref?.()
    })

    let raw: unknown
    try {
      raw = await Promise.race([taskPromise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (raw !== timeoutSentinel) return raw

    this.trackOrphanedDispatch(attempt.attemptId, operationId, taskPromise)
    throw new DispatchTimeoutError(
      `${kind} broker dispatch timed out after ${timeoutMs}ms; the venue request was NOT cancelled and may still take effect`,
    )
  }

  private trackOrphanedDispatch(
    attemptId: string,
    operationId: string,
    taskPromise: Promise<unknown>,
  ): void {
    this.mutationCoordinator.registerOrphanedDispatch({ attemptId, operationId })
    const settle = (outcome: { ok: true; raw: unknown } | { ok: false; error: unknown }): void => {
      void this.recordLateDispatchOutcome(attemptId, operationId, outcome)
        .finally(() => this.mutationCoordinator.settleOrphanedDispatch(operationId))
    }
    taskPromise.then(
      (value) => settle({ ok: true, raw: value }),
      (error) => settle({ ok: false, error }),
    )
  }

  /**
   * A timed-out dispatch settled after all. Its outcome is real evidence
   * (success = the venue accepted; typed local refusal = it never left), so
   * record it durably on the still-quarantined attempt. This does NOT lift
   * the restart requirement — the barrier is latched for the process
   * lifetime; the evidence exists for the post-restart human decision.
   */
  private async recordLateDispatchOutcome(
    attemptId: string,
    operationId: string,
    outcome: { ok: true; raw: unknown } | { ok: false; error: unknown },
  ): Promise<void> {
    try {
      await this.mutationCoordinator.withLease({
        allowActiveAttempt: true,
        orphanBarrierExempt: true,
        hasLegacyPending: this.hasLegacyPending(),
        operation: 'record late broker outcome',
      }, async () => {
        const active = this.mutationCoordinator.getActiveAttempt()
        if (!active || active.attemptId !== attemptId) return
        const entry = active.operations.find((op) => op.operationId === operationId)
        if (!entry || entry.state !== 'uncertain') return
        const base = outcome.ok
          ? this.classifyMutationOutcome(entry.operation, outcome.raw)
          : this.classifyMutationError(entry.operation, outcome.error)
        const next = this.updateAttemptOperations(active, (op) =>
          op.operationId === operationId
            ? {
                ...op,
                ...base,
                evidence: {
                  type: 'late-broker-outcome',
                  settledState: base.state,
                  inner: base.evidence,
                },
              }
            : op)
        this.persistAttempt(next, { clearLegacyApproval: true })
      })
    } catch (error) {
      console.error('[TradingGit] failed to durably record a late broker outcome; quarantine holds', {
        accountId: this.config.accountId ?? 'unknown',
        attemptId,
        operationId,
        errorName: error instanceof Error ? error.name : typeof error,
      })
    }
  }

  private mutationTimeoutMs(): number {
    const configured = this.config.mutationTimeoutMs
    return configured !== undefined && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MUTATION_TIMEOUT_MS
  }

  private transitionAttemptOperation(
    attempt: MutationAttemptV1,
    index: number,
    transition: Pick<MutationOperationV1, 'state' | 'result' | 'evidence' | 'error'>,
  ): MutationAttemptV1 {
    const current = this.mutationCoordinator.getActiveAttempt()
    if (!current || current.attemptId !== attempt.attemptId) {
      throw new MutationRecoveryRequiredError(attempt.attemptId, 'Active mutation attempt changed unexpectedly')
    }
    const next = this.updateAttemptOperations(current, (entry) =>
      entry.index === index ? { ...entry, ...transition } : entry)
    this.persistAttempt(next, { clearLegacyApproval: true })
    return next
  }

  private classifyMutationOutcome(
    operation: Operation,
    raw: unknown,
  ): Pick<MutationOperationV1, 'state' | 'result' | 'evidence' | 'error'> {
    const parsed = this.sanitizeOperationResult(this.parseOperationResult(operation, raw))
    if (hasLocalNoDispatchProof(raw)) {
      return {
        state: 'definitely_rejected',
        result: parsed,
        evidence: { type: 'typed-local-no-dispatch-proof' },
        error: parsed.error,
      }
    }
    if (parsed.success) {
      return {
        state: 'confirmed',
        result: parsed,
        evidence: { type: 'broker-success-receipt' },
        error: undefined,
      }
    }

    return {
      state: 'uncertain',
      result: { ...parsed, status: 'uncertain' },
      evidence: { type: 'broker-failure-without-nonacceptance-proof' },
      error: parsed.error ?? 'Broker acceptance is unknown',
    }
  }

  private classifyMutationError(
    operation: Operation,
    error: unknown,
  ): Pick<MutationOperationV1, 'state' | 'result' | 'evidence' | 'error'> {
    const message = error instanceof Error ? error.message : String(error)
    const guardVerdicts = extractGuardVerdicts(error)
    const result: OperationResult = {
      action: operation.action,
      success: false,
      status: hasLocalNoDispatchProof(error) ? 'rejected' : 'uncertain',
      error: message,
      ...(guardVerdicts ? { guardVerdicts } : {}),
    }
    if (hasLocalNoDispatchProof(error)) {
      return {
        state: 'definitely_rejected',
        result,
        evidence: { type: 'typed-local-no-dispatch-error' },
        error: message,
      }
    }
    return {
      state: 'uncertain',
      result,
      evidence: {
        type: error instanceof DispatchTimeoutError
          ? 'dispatch-timeout-orphaned'
          : 'unclassified-dispatch-error',
      },
      error: message,
    }
  }

  private resultForMutationEntry(entry: MutationOperationV1): OperationResult {
    return entry.result ?? {
      action: entry.operation.action,
      success: false,
      status: entry.state === 'uncertain' ? 'uncertain' : 'rejected',
      error: entry.error ?? `Mutation ended in ${entry.state}`,
    }
  }

  private sanitizeOperationResult(result: OperationResult): OperationResult {
    const { raw: _raw, execution, orderState: rawOrderState, legs: rawLegs, ...safe } = result
    const receipt = sanitizeExecutionReceipt(execution)
    const orderState = sanitizeOrderState(rawOrderState)
    const legs = sanitizeLegs(rawLegs)
    return {
      ...safe,
      ...(receipt ? { execution: receipt } : {}),
      ...(orderState ? { orderState } : {}),
      ...(legs ? { legs } : {}),
      ...(safe.guardVerdicts ? {
        guardVerdicts: safe.guardVerdicts.map((verdict) => ({
          ...verdict,
          ...(verdict.metrics ? { metrics: { ...verdict.metrics } } : {}),
        })),
      } : {}),
    }
  }

  /** Most recent durable snapshot, for degraded zero-operation finalization. */
  private lastKnownGitState(): GitState {
    const last = this.commits[this.commits.length - 1]
    if (last) return TradingGit.rehydrateGitState(cloneJson(last.stateAfter))
    return {
      netLiquidation: '0',
      totalCashValue: '0',
      unrealizedPnL: '0',
      realizedPnL: '0',
      positions: [],
      pendingOrders: [],
    }
  }

  private finalizeAttempt(
    attempt: MutationAttemptV1,
    stateAfter: GitState,
    approverOverride?: ApproverIdentity,
    resolution?: { action: ResolveMutationParams['action']; reason: string },
    options: { stateAfterDegraded?: boolean } = {},
  ): void {
    const active = this.mutationCoordinator.getActiveAttempt()
    if (!active || active.attemptId !== attempt.attemptId) {
      throw new MutationRecoveryRequiredError(attempt.attemptId, 'Mutation finalization lost its active attempt')
    }

    const suspended = attempt.suspendedApproval
    const supersededOperations = suspended?.operations ?? []
    const supersededResults: OperationResult[] = supersededOperations.map((operation) => ({
      action: operation.action,
      success: false,
      status: 'user-rejected',
      error: `Superseded by ${attempt.kind} before broker dispatch`,
    }))
    const commit: GitCommit = {
      hash: attempt.hash,
      parentHash: this.head,
      message: resolution
        ? `${attempt.message} [resolved:${resolution.action}] ${resolution.reason}`
        : attempt.message,
      operations: [
        ...attempt.operations.map((entry) => entry.operation),
        ...supersededOperations,
      ],
      results: [
        ...attempt.operations.map((entry) => this.resultForMutationEntry(entry)),
        ...supersededResults,
      ],
      stateAfter,
      timestamp: new Date().toISOString(),
      approver: cloneJson(approverOverride ?? attempt.approver),
      mutationAudit: {
        schemaVersion: MUTATION_SCHEMA_VERSION,
        attemptId: attempt.attemptId,
        kind: attempt.kind,
        message: attempt.message,
        operationCount: attempt.operations.length,
        initiator: cloneJson(attempt.approver),
        ...(options.stateAfterDegraded ? { stateAfterDegraded: true as const } : {}),
        ...(attempt.context ? { context: cloneJson(attempt.context) } : {}),
        ...(suspended ? {
          supersededApproval: {
            hash: suspended.hash,
            message: suspended.message,
            operationCount: suspended.operations.length,
          },
        } : {}),
        resolutions: cloneJson(attempt.resolutions ?? []),
      },
      round: this.currentRound,
    }
    const commits = [...this.commits, commit]
    const finalEnvelope: MutationEnvelope = { schemaVersion: MUTATION_SCHEMA_VERSION }

    try {
      this.persistCandidate({
        commits,
        head: commit.hash,
        stagingArea: [],
        pendingMessage: null,
        pendingHash: null,
        mutation: finalEnvelope,
      })
    } catch (error) {
      throw new MutationRecoveryRequiredError(
        attempt.attemptId,
        `Failed to durably finalize mutation ${attempt.attemptId}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      )
    }

    this.commits = commits
    this.head = commit.hash
    this.stagingArea = []
    this.pendingMessage = null
    this.pendingHash = null
    this.mutationCoordinator.replaceEnvelope(finalEnvelope)
    this.legacyReviewRequired = false
  }

  private static rehydrateMutationEnvelope(
    envelope: GitExportState['mutation'],
  ): GitExportState['mutation'] {
    if (!envelope || envelope.schemaVersion !== MUTATION_SCHEMA_VERSION) return envelope
    const activeAttempt = envelope.activeAttempt as MutationAttemptV1 | undefined
    if (!activeAttempt) return envelope
    return {
      schemaVersion: MUTATION_SCHEMA_VERSION,
      activeAttempt: {
        ...activeAttempt,
        operations: activeAttempt.operations.map((entry) => ({
          ...entry,
          operation: TradingGit.cloneOperation(entry.operation),
        })),
        ...(activeAttempt.suspendedApproval ? {
          suspendedApproval: {
            ...activeAttempt.suspendedApproval,
            operations: activeAttempt.suspendedApproval.operations.map(TradingGit.cloneOperation),
          },
        } : {}),
      },
    }
  }

  private parseOperationResult(op: Operation, raw: unknown): OperationResult {
    const rawObj = raw as Record<string, unknown>

    if (!rawObj || typeof rawObj !== 'object') {
      return {
        action: op.action,
        success: false,
        status: 'rejected',
        error: 'Invalid response from trading engine',
        raw,
      }
    }

    const success = rawObj.success === true
    const guardVerdicts = extractGuardVerdicts(rawObj)

    if (!success) {
      return {
        action: op.action,
        success: false,
        status: 'rejected',
        error: (rawObj.error as string) ?? 'Unknown error',
        ...(guardVerdicts ? { guardVerdicts } : {}),
        raw,
      }
    }

    const orderId = decimalReceiptString(rawObj.orderId)
    // Sanitize at intake — the raw broker orderState/legs shapes never enter
    // an OperationResult, even transiently.
    const orderState = sanitizeOrderState(rawObj.orderState)
    const legs = sanitizeLegs(rawObj.legs)
    const execution = sanitizeExecutionReceipt(rawObj.execution)
    const filledQty = decimalReceiptString(rawObj.filledQty)
      ?? decimalReceiptString(rawObj.filledQuantity)
      ?? execution?.shares
      ?? execution?.cumQty
    const filledPrice = decimalReceiptString(rawObj.filledPrice)
      ?? decimalReceiptString(execution?.price)
      ?? decimalReceiptString(execution?.avgPrice)

    const fallbackStatus: OperationStatus = op.action === 'emergencyCancelOrder'
      ? 'cancelled'
      : op.action === 'emergencyClosePosition'
        ? 'filled'
        : this.mapOrderStatus(orderState)

    return {
      action: op.action,
      success: true,
      orderId: orderId ?? (op.action === 'emergencyCancelOrder' ? op.orderId : undefined),
      status: orderState ? this.mapOrderStatus(orderState) : fallbackStatus,
      orderState,
      ...(execution ? { execution } : {}),
      ...(filledQty ? { filledQty } : {}),
      ...(filledPrice ? { filledPrice } : {}),
      ...(Array.isArray(legs) && legs.length > 0 ? { legs } : {}),
      ...(guardVerdicts ? { guardVerdicts } : {}),
      raw,
    }
  }

  /** Map IBKR-style OrderState.status to OperationStatus. */
  private mapOrderStatus(orderState?: { status?: string }): OperationStatus {
    switch (orderState?.status) {
      case 'Filled': return 'filled'
      case 'Cancelled': return 'cancelled'
      case 'Inactive': return 'rejected'
      default: return 'submitted'
    }
  }
}
