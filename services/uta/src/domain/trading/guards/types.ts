import type { Operation } from '../git/types.js'
import type { Position, AccountInfo } from '../brokers/types.js'
import type { GuardMetrics } from '../git/types.js'

/** Read-only context assembled by the pipeline, consumed by guards. */
export interface GuardContext {
  readonly operation: Operation
  readonly positions: readonly Position[]
  readonly account: Readonly<AccountInfo>
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

/** Registry entry: type identifier + factory function. */
export interface GuardRegistryEntry {
  type: string
  create(options: Record<string, unknown>): OperationGuard
}
