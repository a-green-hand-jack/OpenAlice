import type {
  GitExportState,
  MutationAttemptV1,
  MutationEvidenceProjection,
  MutationEnvelope,
  MutationOperationTargetProjection,
  MutationReadiness,
  MutationReceiptProjection,
  MutationStatusProjection,
  Operation,
} from './types.js'
import { UNSET_DECIMAL, type Order } from '@traderalice/ibkr'
import { MUTATION_SCHEMA_VERSION, isMutationEnvelopeV1 } from './types.js'
import { getOperationSymbol } from './types.js'

export const MUTATION_RECOVERY_REQUIRED = 'MUTATION_RECOVERY_REQUIRED' as const
export const MUTATION_BUSY = 'MUTATION_BUSY' as const
export const MUTATION_UNSUPPORTED_SCHEMA = 'MUTATION_UNSUPPORTED_SCHEMA' as const
export const PENDING_APPROVAL_CHANGED = 'PENDING_APPROVAL_CHANGED' as const

export class MutationRecoveryRequiredError extends Error {
  readonly code = MUTATION_RECOVERY_REQUIRED

  constructor(readonly attemptId: string, message?: string, cause?: unknown) {
    super(message ?? `Mutation recovery required for attempt ${attemptId}`, { cause })
    this.name = 'MutationRecoveryRequiredError'
  }
}

export class MutationBusyError extends Error {
  readonly code = MUTATION_BUSY

  constructor() {
    super('Another account mutation is already in progress')
    this.name = 'MutationBusyError'
  }
}

export class MutationUnsupportedSchemaError extends Error {
  readonly code = MUTATION_UNSUPPORTED_SCHEMA

  constructor(readonly schemaVersion: number) {
    super(`Mutation schema ${schemaVersion} is newer than this OpenAlice build; writes are disabled`)
    this.name = 'MutationUnsupportedSchemaError'
  }
}

export class PendingApprovalChangedError extends Error {
  readonly code = PENDING_APPROVAL_CHANGED

  constructor(
    readonly expectedHash: string,
    readonly actualHash: string | null,
  ) {
    super(`Pending approval changed: expected ${expectedHash}, found ${actualHash ?? 'none'}`)
    this.name = 'PendingApprovalChangedError'
  }
}

export interface OrphanedDispatchRecord {
  attemptId: string
  operationId: string
}

/**
 * The single per-account mutation lease and recovery gate.
 *
 * TradingGit owns exactly one instance. The coordinator intentionally does
 * not persist by itself: TradingGit first durably writes a candidate snapshot,
 * then calls replaceEnvelope so memory never gets ahead of disk.
 */
export class AccountMutationCoordinator {
  private envelope: MutationEnvelope | undefined
  private busy = false
  private poisonedReason: string | undefined
  /**
   * Latched when a broker dispatch outlives its timeout. A timeout never
   * cancels the underlying venue request, so the quarantine CANNOT be
   * human-resolved in this process — a resolved-and-replaced mutation could
   * otherwise coexist with the original request being accepted late at the
   * venue. The latch deliberately survives even a late settlement of the
   * orphaned Promise: only a REAL process restart (which provably drops every
   * in-flight call) lifts it. Late settlements are still recorded durably as
   * evidence for the post-restart human decision.
   */
  private orphanRestartLatch: OrphanedDispatchRecord | undefined
  private readonly orphanedDispatches = new Map<string, OrphanedDispatchRecord>()

  constructor(envelope?: MutationEnvelope) {
    this.replaceEnvelope(envelope)
  }

  getEnvelope(): MutationEnvelope | undefined {
    return this.envelope
  }

  /**
   * Every envelope entry point normalizes crashed `dispatching` operations to
   * `uncertain` — not just the constructor — so no caller can resurrect a
   * mid-dispatch record in a replayable state.
   */
  replaceEnvelope(envelope: MutationEnvelope | undefined): void {
    this.envelope = normalizeRestoredEnvelope(envelope)
  }

  registerOrphanedDispatch(record: OrphanedDispatchRecord): void {
    this.orphanRestartLatch ??= record
    this.orphanedDispatches.set(record.operationId, record)
  }

  /** The orphaned call settled locally — its outcome is recordable evidence,
   *  but the restart requirement stays latched for this process lifetime. */
  settleOrphanedDispatch(operationId: string): void {
    this.orphanedDispatches.delete(operationId)
  }

  restartRequiredForOrphan(): OrphanedDispatchRecord | undefined {
    return this.orphanRestartLatch
  }

  getActiveAttempt(): MutationAttemptV1 | undefined {
    if (!this.isSupportedEnvelope(this.envelope)) return undefined
    return this.envelope.activeAttempt
  }

  isBusy(): boolean {
    return this.busy
  }

  poison(reason: unknown): void {
    this.poisonedReason = reason instanceof Error ? reason.message : String(reason)
  }

  getReadiness(hasLegacyPending: boolean): MutationReadiness {
    if (this.isUnsupportedEnvelope(this.envelope)) return 'unsupported_schema'
    if (this.poisonedReason) return 'recovery_required'
    if (this.busy) return 'busy'
    if (this.getActiveAttempt()) return 'recovery_required'
    if (hasLegacyPending) return 'legacy_review_required'
    return 'ready'
  }

  getStatus(hasLegacyPending: boolean): MutationStatusProjection {
    const readiness = this.getReadiness(hasLegacyPending)
    const attempt = this.getActiveAttempt()
    return {
      schemaVersion: this.envelope?.schemaVersion ?? MUTATION_SCHEMA_VERSION,
      readiness,
      ...(this.poisonedReason !== undefined || this.orphanRestartLatch !== undefined
        ? { restartRequired: true }
        : {}),
      ...(attempt ? {
        activeAttempt: {
          attemptId: attempt.attemptId,
          kind: attempt.kind,
          hash: attempt.hash,
          message: attempt.message,
          createdAt: attempt.createdAt,
          updatedAt: attempt.updatedAt,
          ...(attempt.context ? { context: { ...attempt.context } } : {}),
          ...(attempt.resolutions?.length ? {
            resolutions: attempt.resolutions.map((resolution) => ({
              ...resolution,
              approver: { ...resolution.approver },
            })),
          } : {}),
          operations: attempt.operations.map((entry) => ({
            operationId: entry.operationId,
            index: entry.index,
            action: entry.operation.action,
            symbol: getOperationSymbol(entry.operation) || undefined,
            operation: projectOperationTarget(entry.operation),
            state: entry.state,
            ...(entry.result ? {
              result: {
                success: entry.result.success,
                status: entry.result.status,
                ...(entry.result.orderId ? { orderId: entry.result.orderId } : {}),
                ...(entry.result.filledQty ? { filledQty: entry.result.filledQty } : {}),
                ...(entry.result.filledPrice ? { filledPrice: entry.result.filledPrice } : {}),
                ...(projectReceipt(entry.result.execution)
                  ? { receipt: projectReceipt(entry.result.execution) }
                  : {}),
                ...(entry.result.error ? { error: entry.result.error } : {}),
              },
            } : {}),
            ...(projectEvidence(entry.evidence) ? { evidence: projectEvidence(entry.evidence) } : {}),
            ...(entry.error ? { error: entry.error } : {}),
            ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
          })),
        },
      } : {}),
      downgradeBlocked: Boolean(attempt)
        || this.poisonedReason !== undefined
        || readiness === 'unsupported_schema',
    }
  }

  assertLedgerWriteAllowed(operation: string): void {
    if (this.isUnsupportedEnvelope(this.envelope)) {
      throw new MutationUnsupportedSchemaError(this.envelope.schemaVersion)
    }
    const active = this.getActiveAttempt()
    if (this.poisonedReason) {
      throw new MutationRecoveryRequiredError(
        active?.attemptId ?? 'persistence-ack-unknown',
        `${operation} is blocked: mutation recovery required${active ? ` for attempt ${active.attemptId}` : ''}`,
      )
    }
    if (this.busy) throw new MutationBusyError()
    if (active) {
      throw new MutationRecoveryRequiredError(
        active.attemptId,
        `${operation} is blocked: mutation recovery required for attempt ${active.attemptId}`,
      )
    }
    // A legacy pending approval does not block other ledger writes; the human
    // re-review gate lives on push/reject themselves.
  }

  async withLease<T>(options: {
    allowActiveAttempt?: boolean
    /** Internal late-broker-outcome recorder only. Never expose to callers. */
    orphanBarrierExempt?: boolean
    hasLegacyPending: boolean
    operation: string
  }, task: () => Promise<T>): Promise<T> {
    if (this.isUnsupportedEnvelope(this.envelope)) {
      throw new MutationUnsupportedSchemaError(this.envelope.schemaVersion)
    }
    const active = this.getActiveAttempt()
    if (this.poisonedReason) {
      throw new MutationRecoveryRequiredError(
        active?.attemptId ?? 'persistence-ack-unknown',
        `${options.operation} is blocked in this process after a lost persistence acknowledgement; restart before recovery`,
      )
    }
    if (this.busy) throw new MutationBusyError()
    if (!options.orphanBarrierExempt && this.orphanRestartLatch) {
      const orphan = this.orphanRestartLatch
      throw new MutationRecoveryRequiredError(
        orphan.attemptId,
        `${options.operation} is blocked: a broker call from attempt ${orphan.attemptId} timed out `
        + 'in this process. A timeout never cancels the underlying venue request, so every new '
        + 'mutation and human resolution stays blocked until the UTA process is actually restarted.',
      )
    }
    if (!options.allowActiveAttempt && active) {
      throw new MutationRecoveryRequiredError(
        active.attemptId,
        `${options.operation} is blocked: mutation recovery required for attempt ${active.attemptId}`,
      )
    }
    if (options.allowActiveAttempt && !active) {
      throw new Error('No active mutation attempt to resolve')
    }

    this.busy = true
    try {
      return await task()
    } finally {
      this.busy = false
    }
  }

  private isSupportedEnvelope(envelope: MutationEnvelope | undefined): envelope is MutationEnvelope & {
    schemaVersion: typeof MUTATION_SCHEMA_VERSION
    activeAttempt?: MutationAttemptV1
  } {
    return envelope?.schemaVersion === MUTATION_SCHEMA_VERSION
  }

  private isUnsupportedEnvelope(envelope: MutationEnvelope | undefined): envelope is MutationEnvelope & {
    schemaVersion: number
  } {
    return envelope !== undefined && envelope.schemaVersion !== MUTATION_SCHEMA_VERSION
  }
}

function projectReceipt(execution: unknown): MutationReceiptProjection | undefined {
  if (!execution || typeof execution !== 'object') return undefined
  const receipt = execution as Record<string, unknown>
  const textValue = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return undefined
  }
  const projected = {
    ...(textValue(receipt.execId) ? { executionId: textValue(receipt.execId) } : {}),
    ...(textValue(receipt.time) ? { executedAt: textValue(receipt.time) } : {}),
    ...(textValue(receipt.orderId) ? { brokerOrderId: textValue(receipt.orderId) } : {}),
    ...(textValue(receipt.permId) ? { permanentId: textValue(receipt.permId) } : {}),
    ...(textValue(receipt.clientId) ? { clientId: textValue(receipt.clientId) } : {}),
    ...(textValue(receipt.orderRef) ? { orderRef: textValue(receipt.orderRef) } : {}),
    ...(textValue(receipt.exchange) ? { exchange: textValue(receipt.exchange) } : {}),
    ...(textValue(receipt.side) ? { side: textValue(receipt.side) } : {}),
    ...(textValue(receipt.cumQty) ? { cumulativeQty: textValue(receipt.cumQty) } : {}),
    ...(textValue(receipt.lastLiquidity) ? { lastLiquidity: textValue(receipt.lastLiquidity) } : {}),
  }
  return Object.keys(projected).length > 0 ? projected : undefined
}

function decimalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object' && 'equals' in value && typeof value.equals === 'function') {
    try {
      if (value.equals(UNSET_DECIMAL)) return undefined
    } catch {
      return undefined
    }
  }
  if (typeof value === 'object' && 'toFixed' in value && typeof value.toFixed === 'function') {
    try {
      return value.toFixed()
    } catch {
      return undefined
    }
  }
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function contractIdentity(operation: Operation): Pick<
  MutationOperationTargetProjection,
  'symbol' | 'aliceId' | 'localSymbol'
> {
  if (!('contract' in operation)) return {}
  return {
    ...(operation.contract.symbol ? { symbol: operation.contract.symbol } : {}),
    ...(operation.contract.aliceId ? { aliceId: operation.contract.aliceId } : {}),
    ...(operation.contract.localSymbol ? { localSymbol: operation.contract.localSymbol } : {}),
  }
}

function orderFields(order: Partial<Order>): Partial<MutationOperationTargetProjection> {
  const quantity = decimalString(order.totalQuantity)
  const cashQuantity = decimalString(order.cashQty)
  const limitPrice = decimalString(order.lmtPrice)
  const stopPrice = decimalString(order.auxPrice)
  return {
    ...(order.action ? { side: order.action } : {}),
    ...(order.orderType ? { orderType: order.orderType } : {}),
    ...(quantity ? { quantity } : {}),
    ...(cashQuantity ? { cashQuantity } : {}),
    ...(limitPrice ? { limitPrice } : {}),
    ...(stopPrice ? { stopPrice } : {}),
    ...(order.orderRef ? { orderRef: order.orderRef } : {}),
  }
}

function projectOperationTarget(operation: Operation): MutationOperationTargetProjection {
  const base = { action: operation.action, ...contractIdentity(operation) }
  switch (operation.action) {
    case 'placeOrder':
      return {
        ...base,
        ...orderFields(operation.order),
        ...(operation.tpsl?.takeProfit?.price
          ? { takeProfitPrice: operation.tpsl.takeProfit.price }
          : {}),
        ...(operation.tpsl?.stopLoss?.price
          ? { stopLossPrice: operation.tpsl.stopLoss.price }
          : {}),
      }
    case 'modifyOrder':
      return { ...base, orderId: operation.orderId, ...orderFields(operation.changes) }
    case 'cancelOrder':
      return { ...base, orderId: operation.orderId }
    case 'closePosition': {
      const quantity = decimalString(operation.quantity)
      return { ...base, ...(quantity ? { quantity } : {}) }
    }
    case 'emergencyCancelOrder':
      return { ...base, orderId: operation.orderId }
    case 'emergencyClosePosition': {
      const quantity = decimalString(operation.quantity)
      return {
        ...base,
        ...(operation.side ? { side: operation.side } : {}),
        ...(quantity ? { quantity } : {}),
      }
    }
    case 'observeExternalOrder':
      return { ...base, ...orderFields(operation.order) }
    case 'reconcileBalance':
      return {
        ...base,
        aliceId: operation.aliceId,
        quantity: operation.quantityDelta,
        limitPrice: operation.markPrice,
      }
    case 'syncOrders':
      return base
  }
}

const SAFE_EVIDENCE_TYPES = new Set<MutationEvidenceProjection['type']>([
  'durable-before-broker-dispatch',
  'broker-success-receipt',
  'broker-failure-without-nonacceptance-proof',
  'typed-local-no-dispatch-proof',
  'typed-local-no-dispatch-error',
  'unclassified-dispatch-error',
  'dispatch-timeout-orphaned',
  'late-broker-outcome',
  'recovered-dispatching',
  'human-reject',
  'human-resolution',
])

function projectEvidence(value: unknown): MutationEvidenceProjection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const evidence = value as Record<string, unknown>
  if (typeof evidence.type !== 'string'
    || !SAFE_EVIDENCE_TYPES.has(evidence.type as MutationEvidenceProjection['type'])) {
    return undefined
  }
  const action = evidence.action
  const resolutionAction = action === 'discard-never-dispatched'
    || action === 'acknowledge-uncertainty'
    || action === 'finalize-known-outcomes'
    ? action
    : undefined
  return {
    type: evidence.type as MutationEvidenceProjection['type'],
    ...(resolutionAction ? { action: resolutionAction } : {}),
    ...(typeof evidence.reason === 'string' ? { reason: evidence.reason } : {}),
    ...(evidence.outcome === 'still-uncertain' ? { outcome: evidence.outcome } : {}),
  }
}

function normalizeRestoredEnvelope(envelope: GitExportState['mutation']): MutationEnvelope | undefined {
  if (!isMutationEnvelopeV1(envelope) || !envelope.activeAttempt) {
    return envelope
  }

  let changed = false
  const operations = envelope.activeAttempt.operations.map((operation) => {
    if (operation.state !== 'dispatching') return operation
    changed = true
    return {
      ...operation,
      state: 'uncertain' as const,
      error: operation.error ?? 'Process stopped after dispatch began; broker acceptance is unknown',
      evidence: {
        type: 'recovered-dispatching',
        ...(operation.evidence !== undefined ? { prior: operation.evidence } : {}),
      },
    }
  })

  if (!changed) return envelope
  return {
    ...envelope,
    activeAttempt: {
      ...envelope.activeAttempt,
      operations,
    },
  }
}
