/**
 * Guard Pipeline
 *
 * The only place that touches the account: assembles a GuardContext,
 * then passes it through the guard chain. Guards themselves never
 * see the account.
 */

import type { GuardVerdict, Operation } from '../git/types.js'
import type { IBroker } from '../brokers/types.js'
import type { OperationGuard, GuardContext, GuardEvaluation } from './types.js'

export function createGuardPipeline(
  dispatcher: (op: Operation) => Promise<unknown>,
  account: IBroker,
  guards: OperationGuard[],
  onContext?: (ctx: GuardContext) => Promise<void> | void,
): (op: Operation) => Promise<unknown> {
  if (guards.length === 0 && !onContext) return dispatcher

  return async (op: Operation): Promise<unknown> => {
    const [positions, accountInfo] = await Promise.all([
      account.getPositions(),
      account.getAccount(),
    ])

    const ctx: GuardContext = {
      operation: op,
      positions,
      account: accountInfo,
      getQuote: (contract) => account.getQuote(contract),
    }
    await onContext?.(ctx)
    const guardVerdicts: GuardVerdict[] = []

    for (let i = 0; i < guards.length; i++) {
      const guard = guards[i]
      const verdict = await evaluateGuard(guard, ctx)
      guardVerdicts.push(verdict)

      if (verdict.verdict === 'reject') {
        for (const skipped of guards.slice(i + 1)) {
          guardVerdicts.push({
            guard: skipped.name,
            verdict: 'skipped',
            reason: 'not evaluated after earlier guard rejection',
          })
        }
        return {
          success: false,
          error: `[guard:${guard.name}] ${verdict.reason}`,
          guardVerdicts,
        }
      }
    }

    try {
      return attachGuardVerdicts(await dispatcher(op), guardVerdicts)
    } catch (error) {
      throw attachGuardVerdictsToError(error, guardVerdicts)
    }
  }
}

async function evaluateGuard(guard: OperationGuard, ctx: GuardContext): Promise<GuardVerdict> {
  if (guard.evaluate) {
    return verdictFromEvaluation(guard.name, await guard.evaluate(ctx))
  }

  const reason = await guard.check(ctx)
  if (reason != null) return { guard: guard.name, verdict: 'reject', reason }
  return { guard: guard.name, verdict: 'pass' }
}

function verdictFromEvaluation(guard: string, evaluation: GuardEvaluation): GuardVerdict {
  if (evaluation.reason != null) {
    return {
      guard,
      verdict: 'reject',
      reason: evaluation.reason,
      ...(evaluation.metrics ? { metrics: evaluation.metrics } : {}),
    }
  }

  return {
    guard,
    verdict: 'pass',
    ...(evaluation.metrics ? { metrics: evaluation.metrics } : {}),
  }
}

function attachGuardVerdicts(raw: unknown, guardVerdicts: GuardVerdict[]): unknown {
  if (raw && typeof raw === 'object') {
    return { ...(raw as Record<string, unknown>), guardVerdicts }
  }
  return raw
}

function attachGuardVerdictsToError(error: unknown, guardVerdicts: GuardVerdict[]): Error {
  // Non-Error throws are normalized so verdicts can attach — a semantic
  // difference from master (which rethrew raw values), inert today because
  // TradingGit's catch already stringifies either shape identically.
  const err = error instanceof Error ? error : new Error(String(error))
  ;(err as Error & { guardVerdicts?: GuardVerdict[] }).guardVerdicts = guardVerdicts
  return err
}
