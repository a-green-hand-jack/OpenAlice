import type { Operation } from '../git/types.js'
import type { Position, AccountInfo, Quote } from '../brokers/types.js'
import type { GuardMetrics } from '../git/types.js'
import type { PortfolioGuardStateStore } from './portfolio-state.js'

/** Read-only context assembled by the pipeline, consumed by guards. */
export interface GuardContext {
  readonly operation: Operation
  readonly positions: readonly Position[]
  readonly account: Readonly<AccountInfo>
  /**
   * Optional, lazy quote lookup for guards that need to estimate notional value
   * for qty-based orders without an existing position.
   */
  readonly getQuote?: (contract: Operation['contract']) => Promise<Quote>
}

export interface GuardEvaluation {
  reason?: string | null
  metrics?: GuardMetrics
}

/** A guard that can reject operations. Returns null to allow, or a rejection reason string. */
export interface OperationGuard {
  readonly name: string
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
