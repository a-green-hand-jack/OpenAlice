/**
 * Trading-as-Git type definitions
 *
 * Operation is a discriminated union — each variant carries typed IBKR objects.
 * No more Record<string, unknown> type erasure.
 */

import type { Contract, Order, OrderCancel } from '@traderalice/ibkr'
import type Decimal from 'decimal.js'
import type { Position, OpenOrder, TpSlParams, PlaceOrderLeg, RiskStateInfo } from './broker.js'
import type { AuthzAccountType, AuthzLevel } from './authz.js'
import './contract-ext.js'

// ==================== Commit Hash ====================

/** 8-character short SHA-256 hash. */
export type CommitHash = string

export interface ApproverIdentity {
  via: 'alice-bff' | 'loopback' | 'auto-push-paper'
  fingerprint?: string
  at: string
}

// ==================== Operation ====================

export type OperationAction = Operation['action']

export type Operation =
  | { action: 'placeOrder'; contract: Contract; order: Order; tpsl?: TpSlParams }
  | { action: 'modifyOrder'; orderId: string; changes: Partial<Order> }
  | { action: 'closePosition'; contract: Contract; quantity?: Decimal }
  | { action: 'cancelOrder'; orderId: string; orderCancel?: OrderCancel }
  | {
      // Human-only kill-switch audit event: an open broker order cancelled
      // directly by /emergency-stop, bypassing the stage/commit/push wall that
      // READ_ONLY/HALT intentionally enforce.
      action: 'emergencyCancelOrder'
      orderId: string
      contract: Contract
      order?: Order
    }
  | {
      // Human-only kill-switch audit event: an open position closed directly
      // by /flatten, bypassing the normal close-position pipeline so it still
      // works while the account is HALT.
      action: 'emergencyClosePosition'
      contract: Contract
      quantity: Decimal
      side?: Position['side']
    }
  | { action: 'syncOrders' }
  | {
      // Wallet-only event: an open order observed on the broker that Alice
      // never placed (user trading on the exchange app directly). The log is
      // a faithful record, not the source of final state — untracked orders
      // are themselves "commits without a message": N of them observed in
      // one pass get squashed into one [observed] commit. Once recorded with
      // orderId + submitted status, the regular pending scanner + sync
      // poller take over their lifecycle (fill / cancel) for free.
      action: 'observeExternalOrder'
      contract: Contract
      order: Order
    }
  | {
      // Wallet-only event: bridges the gap between Alice's order log and a
      // broker-reported balance change Alice did not initiate (first-sight
      // bootstrap, external transfer, staking reward, off-platform trade).
      // Treated as a virtual market buy/sell at observed price for cost-basis
      // purposes — sign of quantityDelta determines direction.
      //
      // Numeric fields stored as Decimal-as-string so they survive JSON
      // round-trip through git-persistence; reconstruct via `new Decimal(...)`
      // at consumption sites.
      action: 'reconcileBalance'
      aliceId: string
      quantityDelta: string
      markPrice: string
    }

// ==================== Operation Result ====================

export type OperationStatus =
  | 'submitted'
  | 'filled'
  | 'rejected'
  | 'cancelled'
  | 'user-rejected'
  | 'uncertain'

export type GuardVerdictStatus = 'pass' | 'reject' | 'skipped'

export type GuardMetricValue = string | number | boolean | null

export type GuardMetrics = Record<string, GuardMetricValue>

export interface GuardVerdict {
  guard: string
  verdict: GuardVerdictStatus
  reason?: string
  metrics?: GuardMetrics
}

/**
 * Strict allowlist of venue order-state scalars that may persist in
 * commit.json. The raw broker OrderState (IBKR) carries account identifiers
 * (orderAllocations[].account) and margin internals that must never be
 * persisted or exported — sanitization happens before any result is stored.
 */
export interface SanitizedOrderState {
  status?: string
  rejectReason?: string
  completedTime?: string
  completedStatus?: string
  commissionAndFees?: number
  commissionAndFeesCurrency?: string
}

/**
 * Strict allowlist of venue execution-receipt fields that may persist in
 * commit.json. Deliberately NOT the raw IBKR Execution (which carries
 * acctNumber and other account identifiers). Decimal quantities are stored
 * as strings so they survive the JSON round-trip losslessly.
 */
export interface SanitizedExecutionReceipt {
  orderId?: number
  execId?: string
  time?: string
  exchange?: string
  side?: string
  shares?: string
  price?: number
  permId?: number
  clientId?: number
  isLiquidation?: boolean
  cumQty?: string
  avgPrice?: number
  orderRef?: string
  lastLiquidity?: number
  isPriceRevisionPending?: boolean
}

export interface OperationResult {
  action: OperationAction
  success: boolean
  orderId?: string
  status: OperationStatus
  execution?: SanitizedExecutionReceipt
  orderState?: SanitizedOrderState
  /** Decimal as string — sub-satoshi fills must round-trip without loss. */
  filledQty?: string
  /** Decimal as string — see filledQty. */
  filledPrice?: string
  error?: string
  /** Bracket TP/SL child orders created alongside this placeOrder (tracked from birth). */
  legs?: PlaceOrderLeg[]
  /** Symbol for per-row attribution in multi-update sync commits (the op carries none). */
  symbol?: string
  /** Structured audit trail for configured operation guards. Optional for pre-issue-18 commits. */
  guardVerdicts?: GuardVerdict[]
  raw?: unknown
}

// ==================== Wallet State ====================

/** State snapshot taken after each commit. All monetary fields are strings to prevent IEEE 754 artifacts. */
export interface GitState {
  netLiquidation: string
  totalCashValue: string
  unrealizedPnL: string
  realizedPnL: string
  positions: Position[]
  pendingOrders: OpenOrder[]
}

// ==================== Commit ====================

export interface GitCommit {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  results: OperationResult[]
  stateAfter: GitState
  timestamp: string
  /** Human approval/trigger identity. Optional for pre-issue-31 commits. */
  approver?: ApproverIdentity
  /** Durable mutation/recovery provenance. Optional for pre-Stage-1 commits. */
  mutationAudit?: MutationCommitAuditV1
  round?: number
}

// ==================== API Results ====================

export interface AddResult {
  staged: true
  index: number
  operation: Operation
}

// ==================== Paper auto-push ====================
//
// UTA's POST /wallet/commit route resolves this synchronously in the same
// request (services/uta/src/http/routes-trading.ts) and splices it onto the
// CommitPrepareResult response as `autoPush` — it genuinely crosses the wire,
// so the type lives here rather than staying UTA-domain-local
// (services/uta/src/domain/trading/paper-auto-push.ts re-exports it; that
// file remains the single place the *values* are constructed).

export type PaperAutoPushSkipReason =
  | 'not_configured'
  | 'no_pending_commit'
  | 'pending_approval_changed'
  | 'mutation_recovery_required'
  | 'account_type_not_paper'
  | 'authz_below_paper'
  | 'risk_state_not_normal'
  | 'risk_envelope_missing'
  | 'risk_envelope_scope_unsupported'
  | 'risk_envelope_revoked'
  | 'envelope_version_changed'
  | 'paper_policy_denied'
  | 'push_in_flight'

export type PaperDecisionPolicyViolationCode =
  | 'missing_stop_loss'
  | 'stop_loss_wrong_side'
  | 'stop_loss_too_wide'
  | 'entry_price_unavailable'
  | 'adding_to_losing_position'

export interface PaperDecisionPolicyViolation {
  code: PaperDecisionPolicyViolationCode
  symbol: string
  reason: string
  metrics?: {
    entryPrice?: string
    stopLossPrice?: string
    stopLossPct?: number
    maxStopLossPct?: number
    unrealizedPnL?: string
  }
}

export type PaperAutoPushResult =
  | {
      status: 'pushed'
      hash: string
      push: PushResult
      approver: ApproverIdentity
      effectiveAuthzLevel: AuthzLevel
      envelopeVersion: number
    }
  | {
      status: 'skipped'
      reason: PaperAutoPushSkipReason
      pendingHash?: string
      accountType?: AuthzAccountType
      effectiveAuthzLevel?: AuthzLevel
      envelopeVersion?: number
      risk?: RiskStateInfo
      policyViolations?: PaperDecisionPolicyViolation[]
    }
  | {
      status: 'failed'
      reason: string
      pendingHash: string
      effectiveAuthzLevel: AuthzLevel
      risk?: RiskStateInfo
    }

export interface CommitPrepareResult {
  prepared: true
  hash: CommitHash
  message: string
  operationCount: number
  /**
   * Paper/mock accounts only — the result of UTA's deterministic auto-push
   * attempt for this commit (issue #111: previously computed server-side but
   * dropped before reaching the agent tool response). Absent for accounts
   * where the route never attempts auto-push (e.g. live/human-approval
   * accounts on older UTA builds, or non-HTTP commit() callers).
   */
  autoPush?: PaperAutoPushResult
}

export interface PushResult {
  hash: CommitHash
  message: string
  operationCount: number
  submitted: OperationResult[]
  rejected: OperationResult[]
}

export interface RejectResult {
  hash: CommitHash
  message: string
  operationCount: number
}

// ==================== Durable mutation attempts ====================

/**
 * Version of the crash-recovery envelope embedded in commit.json.
 *
 * This is deliberately independent from the broader UTA protocol version:
 * an unresolved broker mutation must remain readable across application
 * upgrades even when unrelated wire types change.
 */
export const MUTATION_SCHEMA_VERSION = 1 as const

export type MutationAttemptKind =
  | 'push'
  | 'emergency_cancel'
  | 'flatten'
  | 'human_reject'
  | 'steward_operation'

/**
 * `dispatching` is never replayable after a restart. A restored coordinator
 * projects it as `uncertain`, because the process may have died after the
 * venue accepted the request but before its receipt was persisted.
 */
export type MutationOperationState =
  | 'prepared'
  | 'dispatching'
  | 'confirmed'
  | 'definitely_rejected'
  | 'uncertain'

export interface MutationOperationV1 {
  operationId: string
  index: number
  operation: Operation
  state: MutationOperationState
  /** Normalized broker/guard outcome. Never synthesize a broker receipt. */
  result?: OperationResult
  /** JSON-safe supporting evidence retained for recovery and audit. */
  evidence?: unknown
  error?: string
  updatedAt?: string
}

/**
 * A synthetic emergency mutation temporarily hides an existing approval from
 * legacy readers. Finalization records these superseded operations as
 * user-rejected audit rows; they are never restored to a pushable state.
 */
export interface MutationSuspendedApprovalV1 {
  operations: Operation[]
  message: string | null
  hash: CommitHash | null
}

export interface MutationAttemptContextV1 {
  reason?: string
  cancelOrders?: boolean
  /** External idempotency identity for a D2 Steward operation. The payload
   * fingerprint covers the canonical deterministic operation + protection. */
  stewardMutation?: {
    utaMutationReference: string
    operationId: string
    payloadFingerprint: string
  }
}

export interface MutationAttemptV1 {
  attemptId: string
  kind: MutationAttemptKind
  /** Stable hash of the attempted operation batch. */
  hash: CommitHash
  message: string
  approver: ApproverIdentity
  createdAt: string
  updatedAt: string
  operations: MutationOperationV1[]
  suspendedApproval?: MutationSuspendedApprovalV1
  context?: MutationAttemptContextV1
  /** Append-only human decisions made while recovering this attempt. */
  resolutions?: MutationResolutionRecordV1[]
}

export interface MutationResolutionRecordV1 {
  action: MutationResolutionAction
  reason: string
  approver: ApproverIdentity
  at: string
}

export interface MutationCommitAuditV1 {
  schemaVersion: typeof MUTATION_SCHEMA_VERSION
  attemptId: string
  kind: MutationAttemptKind
  message: string
  operationCount: number
  initiator: ApproverIdentity
  /** Set when the post-mutation broker snapshot failed and stateAfter was
   *  filled from the previous commit (zero-operation attempts only — e.g. a
   *  HALT-only emergency stop while the broker is unreachable). */
  stateAfterDegraded?: true
  context?: MutationAttemptContextV1
  supersededApproval?: {
    hash: CommitHash | null
    message: string | null
    operationCount: number
  }
  resolutions: MutationResolutionRecordV1[]
}

export interface MutationEnvelopeV1 {
  schemaVersion: typeof MUTATION_SCHEMA_VERSION
  activeAttempt?: MutationAttemptV1
}

/**
 * Unknown future envelopes are intentionally representable. Readers must
 * inspect schemaVersion before touching activeAttempt and fail writes closed
 * for versions they do not understand.
 */
export interface UnsupportedMutationEnvelope {
  schemaVersion: number
  activeAttempt?: unknown
  [key: string]: unknown
}

export type MutationEnvelope = MutationEnvelopeV1 | UnsupportedMutationEnvelope

export function isMutationEnvelopeV1(
  envelope: MutationEnvelope | undefined,
): envelope is MutationEnvelopeV1 {
  return envelope?.schemaVersion === MUTATION_SCHEMA_VERSION
}

export type MutationReadiness =
  | 'ready'
  | 'legacy_review_required'
  | 'busy'
  | 'recovery_required'
  | 'unsupported_schema'

/** Status is a projection of persisted evidence, never permission to replay. */
export interface MutationOperationResultProjection {
  success: boolean
  status: OperationStatus
  orderId?: string
  filledQty?: string
  filledPrice?: string
  /** Safe, allowlisted broker acknowledgement fields; never account identifiers or raw payloads. */
  receipt?: MutationReceiptProjection
  error?: string
}

export interface MutationReceiptProjection {
  executionId?: string
  executedAt?: string
  brokerOrderId?: string
  permanentId?: string
  clientId?: string
  orderRef?: string
  exchange?: string
  side?: string
  cumulativeQty?: string
  lastLiquidity?: string
}

/**
 * Operator-safe description of the exact broker intent under quarantine.
 * This intentionally excludes full Contract/Order objects and raw venue data.
 */
export interface MutationOperationTargetProjection {
  action: OperationAction
  symbol?: string
  aliceId?: string
  localSymbol?: string
  orderId?: string
  side?: string
  orderType?: string
  quantity?: string
  cashQuantity?: string
  limitPrice?: string
  stopPrice?: string
  takeProfitPrice?: string
  stopLossPrice?: string
  orderRef?: string
}

export type MutationEvidenceType =
  | 'durable-before-broker-dispatch'
  | 'broker-success-receipt'
  | 'broker-failure-without-nonacceptance-proof'
  | 'typed-local-no-dispatch-proof'
  | 'typed-local-no-dispatch-error'
  | 'unclassified-dispatch-error'
  /** Dispatch outlived its timeout; the venue request was NOT cancelled and
   *  may still take effect. Resolution is blocked in-process until restart
   *  or until the orphaned call settles and its outcome is recorded. */
  | 'dispatch-timeout-orphaned'
  /** A timed-out dispatch later settled in this process; its real outcome
   *  was durably recorded after the fact. */
  | 'late-broker-outcome'
  | 'recovered-dispatching'
  | 'human-reject'
  | 'human-resolution'

export interface MutationEvidenceProjection {
  type: MutationEvidenceType
  action?: MutationResolutionAction
  reason?: string
  outcome?: 'still-uncertain'
}

export interface MutationOperationProjectionV1 {
  operationId: string
  index: number
  action: OperationAction
  symbol?: string
  operation: MutationOperationTargetProjection
  state: MutationOperationState
  result?: MutationOperationResultProjection
  evidence?: MutationEvidenceProjection
  error?: string
  updatedAt?: string
}

export interface MutationAttemptProjectionV1 {
  attemptId: string
  kind: MutationAttemptKind
  hash: CommitHash
  message: string
  createdAt: string
  updatedAt: string
  context?: MutationAttemptContextV1
  operations: MutationOperationProjectionV1[]
  resolutions?: MutationResolutionRecordV1[]
}

export interface MutationStatusProjection {
  schemaVersion: number
  readiness: MutationReadiness
  /** Set when recovery is blocked in this process (lost persistence ack, or a
   *  timed-out broker call whose Promise is still in flight). Restart UTA,
   *  reconcile against the venue, then resolve. */
  restartRequired?: boolean
  activeAttempt?: MutationAttemptProjectionV1
  /** Older binaries must not be used while an attempt is unresolved. */
  downgradeBlocked: boolean
}

export type MutationResolutionAction =
  | 'discard-never-dispatched'
  | 'acknowledge-uncertainty'
  | 'finalize-known-outcomes'

export interface MutationResolveResult {
  attemptId: string
  hash?: CommitHash
  resolved: boolean
  readiness: MutationReadiness
}

export interface GitStatus {
  staged: Operation[]
  pendingMessage: string | null
  pendingHash: CommitHash | null
  head: CommitHash | null
  commitCount: number
  riskState?: RiskStateInfo
  mutation?: MutationStatusProjection
}

export interface OperationSummary {
  symbol: string
  action: OperationAction
  change: string
  status: OperationStatus
}

export interface CommitLogEntry {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  timestamp: string
  round?: number
  operations: OperationSummary[]
}

// ==================== Export State ====================

export interface GitExportState {
  commits: GitCommit[]
  head: CommitHash | null
  /** Staged-but-not-committed operations. Optional for pre-issue-15 commit.json files. */
  stagingArea?: Operation[]
  /** Awaiting-approval message. Optional for pre-issue-15 commit.json files. */
  pendingMessage?: string | null
  /** Awaiting-approval hash. Optional for pre-issue-15 commit.json files. */
  pendingHash?: CommitHash | null
  /** Optional for all pre-durable-mutation commit.json files. */
  mutation?: MutationEnvelope
}

// ==================== Sync ====================

export interface OrderStatusUpdate {
  orderId: string
  symbol: string
  previousStatus: OperationStatus
  currentStatus: OperationStatus
  /** Decimal as string — same precision invariant as OperationResult. */
  filledPrice?: string
  filledQty?: string
}

export interface SyncResult {
  hash: CommitHash
  updatedCount: number
  updates: OrderStatusUpdate[]
}

// ==================== Simulate Price Change ====================

export interface PriceChangeInput {
  /** Contract aliceId or symbol, or "all". */
  symbol: string
  /** "@88000" (absolute) or "+10%" / "-5%" (relative). */
  change: string
}

export interface SimulationPositionCurrent {
  symbol: string
  side: 'long' | 'short'
  qty: string
  avgCost: string
  marketPrice: string
  unrealizedPnL: string
  marketValue: string
}

export interface SimulationPositionAfter {
  symbol: string
  side: 'long' | 'short'
  qty: string
  avgCost: string
  simulatedPrice: string
  unrealizedPnL: string
  marketValue: string
  pnlChange: string
  priceChangePercent: string
}

export interface SimulatePriceChangeResult {
  success: boolean
  error?: string
  currentState: {
    equity: string
    unrealizedPnL: string
    totalPnL: string
    positions: SimulationPositionCurrent[]
  }
  simulatedState: {
    equity: string
    unrealizedPnL: string
    totalPnL: string
    positions: SimulationPositionAfter[]
  }
  summary: {
    totalPnLChange: string
    equityChange: string
    equityChangePercent: string
    worstCase: string
  }
}

// ==================== Stage params (used by AI tool layer + SDK) ====================
//
// All numeric fields are decimal strings — Decimal precision is
// preserved through the staging layer into the persisted git operation
// records. Callers (AI tools, HTTP routes) that have a number must
// convert via `String(x)` at the boundary; that's deliberate friction
// so the precision-loss point is explicit.

export interface StagePlaceOrderParams {
  aliceId: string
  symbol?: string
  /**
   * Target sub-account (wallet) for multi-sub-account brokers (CCXT Binance:
   * 'spot' / 'derivatives'). REQUIRED when the broker exposes >1 sub-account —
   * the UTA layer loud-refuses a write without it rather than guessing. Ignored
   * by single-sub-account brokers. Not persisted in the Operation schema; it is
   * validated against the instrument and stamped into the commit message.
   */
  subAccountId?: string
  action: 'BUY' | 'SELL'
  orderType: string
  totalQuantity?: string
  cashQty?: string
  lmtPrice?: string
  auxPrice?: string
  trailStopPrice?: string
  trailingPercent?: string
  tif?: string
  goodTillDate?: string
  outsideRth?: boolean
  parentId?: string
  ocaGroup?: string
  takeProfit?: { price: string }
  stopLoss?: { price: string; limitPrice?: string }
}

export interface StageModifyOrderParams {
  orderId: string
  totalQuantity?: string
  lmtPrice?: string
  auxPrice?: string
  trailStopPrice?: string
  trailingPercent?: string
  orderType?: string
  tif?: string
  goodTillDate?: string
}

export interface StageClosePositionParams {
  aliceId: string
  symbol?: string
  /** Empty / undefined closes the full position. */
  qty?: string
  /**
   * Target sub-account — same semantics as `StagePlaceOrderParams.subAccountId`.
   * REQUIRED for multi-sub-account brokers, ignored otherwise.
   */
  subAccountId?: string
}

// ==================== Operation Helpers ====================

/** Extract the symbol from any Operation variant. */
export function getOperationSymbol(op: Operation | undefined): string {
  if (!op) return 'unknown'
  switch (op.action) {
    case 'placeOrder': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'modifyOrder': return 'unknown' // modifyOrder doesn't carry contract
    case 'closePosition': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'cancelOrder': return 'unknown'
    case 'emergencyCancelOrder': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'emergencyClosePosition': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'syncOrders': return 'unknown'
    case 'observeExternalOrder': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'reconcileBalance': return op.aliceId
  }
}
