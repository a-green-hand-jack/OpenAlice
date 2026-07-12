import type { Operation } from '../git/types.js'
import type { Position, AccountInfo, OpenOrder } from '../brokers/types.js'
import type { GuardMetrics } from '../git/types.js'
import type { PortfolioGuardStateStore } from './portfolio-state.js'

/** Read-only context assembled by the pipeline, consumed by guards. */
export interface GuardContext {
  readonly operation: Operation
  readonly positions: readonly Position[]
  readonly account: Readonly<AccountInfo>
  /** Loaded only when a strict guard needs to bind modifyOrder.orderId to an
   * instrument. Ordinary/custom guard pipelines keep the previous read set. */
  readonly orders?: readonly OpenOrder[]
  /** Canonical account|nativeKey identity resolved through the same broker
   * codec used for the eventual mutation dispatch. */
  readonly canonicalInstrumentId?: string
  /** Resolution failures are data, not exceptions: the strict envelope guard
   * turns them into a typed local no-dispatch rejection. */
  readonly instrumentIdentityError?: string
}

export interface GuardEvaluation {
  reason?: string | null
  metrics?: GuardMetrics
}

/** A guard that can reject operations. Returns null to allow, or a rejection reason string. */
export interface OperationGuard {
  readonly name: string
  readonly requiresCanonicalInstrumentIdentity?: boolean
  check(ctx: GuardContext): Promise<string | null> | string | null
  evaluate?(ctx: GuardContext): Promise<GuardEvaluation> | GuardEvaluation
}

export interface GuardRuntimeOptions {
  /** UTA/account id used for per-account guard persistence. */
  accountId?: string
  /** Test-only override for data/trading/ base directory. */
  stateBaseDir?: string
  /** Shared per-account state store; resolveGuards supplies this to portfolio guards. */
  stateStore?: PortfolioGuardStateStore
  /** Test-only clock injection. Production uses the system clock. */
  now?: () => Date
}

/** Registry entry: type identifier + factory function. */
export interface GuardRegistryEntry {
  type: string
  create(options: Record<string, unknown>, runtime?: GuardRuntimeOptions): OperationGuard
}
