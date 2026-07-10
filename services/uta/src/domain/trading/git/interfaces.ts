/**
 * ITradingGit — Trading-as-Git interface
 *
 * Git-style three-phase workflow for trading operations:
 *   add → commit → push → log / show / status
 */

import type Decimal from 'decimal.js'
import type { Contract, Order } from '@traderalice/ibkr'
import type {
  CommitHash,
  Operation,
  AddResult,
  CommitPrepareResult,
  PushResult,
  RejectResult,
  GitStatus,
  GitCommit,
  CommitLogEntry,
  GitExportState,
  GitState,
  ApproverIdentity,
  PriceChangeInput,
  SimulatePriceChangeResult,
  OrderStatusUpdate,
  SyncResult,
  MutationAttemptKind,
  MutationAttemptContextV1,
  MutationResolutionAction,
  MutationResolveResult,
} from './types.js'

export interface SyntheticMutationParams {
  kind: Extract<MutationAttemptKind, 'emergency_cancel' | 'flatten'>
  message: string
  approver?: ApproverIdentity
  context?: MutationAttemptContextV1
  /** Runs after the account lease is acquired. */
  prepare: () => Promise<Operation[]>
  execute: (operation: Operation) => Promise<unknown>
}

export interface ResolveMutationParams {
  attemptId: string
  action: MutationResolutionAction
  reason: string
  /** Must repeat attemptId exactly; prevents stale-tab acknowledgement. */
  confirmation: string
  approver: ApproverIdentity
}

export interface PushPreflightContext {
  hash: CommitHash
  message: string
  operations: readonly Operation[]
  approver?: ApproverIdentity
}

export interface PushOptions {
  /** Bind the approval evaluated by the caller to the exact pushed hash. */
  expectedHash?: CommitHash
  /** Runs inside the account mutation lease, before any durable dispatch state. */
  preflight?: (context: PushPreflightContext) => Promise<void>
}

export interface RejectOptions {
  expectedHash?: CommitHash
}

export interface ITradingGit {
  // ---- git add / commit / push ----

  add(operation: Operation): AddResult
  commit(message: string): CommitPrepareResult
  push(approver?: ApproverIdentity, options?: PushOptions): Promise<PushResult>
  reject(reason?: string, approver?: ApproverIdentity, options?: RejectOptions): Promise<RejectResult>
  executeSyntheticMutation(params: SyntheticMutationParams): Promise<PushResult>
  resolveMutation(params: ResolveMutationParams): Promise<MutationResolveResult>

  // ---- wallet reconciliation (synthesized commits) ----

  /**
   * Head-CAS write: `expectedHead` is the head observed when the caller took
   * the broker snapshot behind its drift decision. Returns null (no-op) when
   * the ledger advanced in between — the next pass recomputes fresh drift.
   */
  recordReconcile(params: {
    aliceId: string
    quantityDelta: Decimal
    markPrice: Decimal
    stateAfter: GitState
    expectedHead: CommitHash | null
    message?: string
  }): Promise<CommitHash | null>

  // ---- git log / show / status ----

  log(options?: { limit?: number; symbol?: string }): CommitLogEntry[]
  show(hash: CommitHash): GitCommit | null
  status(): GitStatus

  // ---- git pull (sync pending orders) ----

  /** State snapshot is captured inside the ledger lease, never caller-supplied. */
  sync(updates: OrderStatusUpdate[]): Promise<SyncResult>
  /** `localSymbol` is the broker-native symbol from the order's operation
   *  contract — passed to IBroker.getOrder as the symbolHint so lookups
   *  survive restarts (CCXT's order API is symbol-scoped). */
  getPendingOrderIds(): Array<{ orderId: string; symbol: string; localSymbol?: string; aliceId?: string }>
  /** Squash externally-observed open orders into one [observed] commit.
   *  State snapshot is captured inside the ledger lease. */
  recordObservedOrders(params: {
    observed: Array<{ contract: Contract; order: Order; orderId: string }>
  }): Promise<{ hash: CommitHash | null; observed: number }>
  /** Every broker orderId the log has ever seen. */
  getKnownOrderIds(): Set<string>

  // ---- serialization ----

  exportState(): GitExportState
  setCurrentRound(round: number): void

  // ---- simulation ----

  simulatePriceChange(priceChanges: PriceChangeInput[]): Promise<SimulatePriceChangeResult>
}

export interface TradingGitConfig {
  /** Safe identifier used only in CRITICAL recovery logs. */
  accountId?: string
  /** Upper bound for preflight, broker dispatch, prepare, and final snapshots. */
  mutationTimeoutMs?: number
  /** Test-only escape hatch. Broker mutations must never use this in UTA. */
  allowEphemeralPersistence?: boolean
  executeOperation: (operation: Operation) => Promise<unknown>
  getGitState: () => Promise<GitState>
  /**
   * Called whenever exported git state changes (stage, commit, push/reject,
   * sync). MUST complete durably before returning: async functions are
   * rejected at construction and thenable return values are rejected (and
   * poison the coordinator) at call time, because a deferred write would let
   * broker dispatch run ahead of persistence.
   */
  onCommit?: (state: GitExportState) => void
}
