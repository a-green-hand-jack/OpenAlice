import Decimal from 'decimal.js'
import type { GuardContext, GuardEvaluation, GuardRuntimeOptions, OperationGuard } from './types.js'
import {
  createInMemoryPortfolioGuardStateStore,
  createPortfolioGuardStateStore,
  type PortfolioGuardStateStore,
} from './portfolio-state.js'
import { isClearlyRiskReducing } from './portfolio-risk.js'

const DEFAULT_MAX_DRAWDOWN_PCT = 10

export class MaxDrawdownGuard implements OperationGuard {
  readonly name = 'max-drawdown'
  private readonly maxDrawdownPct: number
  private readonly stateStore: PortfolioGuardStateStore

  constructor(options: Record<string, unknown>, runtime: GuardRuntimeOptions = {}) {
    this.maxDrawdownPct = Number(options.maxDrawdownPct ?? DEFAULT_MAX_DRAWDOWN_PCT)
    this.stateStore = runtime.stateStore
      ?? (runtime.accountId
        ? createPortfolioGuardStateStore(runtime.accountId, runtime.stateBaseDir ? { baseDir: runtime.stateBaseDir } : undefined)
        : createInMemoryPortfolioGuardStateStore())
  }

  async check(ctx: GuardContext): Promise<string | null> {
    return (await this.evaluate(ctx)).reason ?? null
  }

  async evaluate(ctx: GuardContext): Promise<GuardEvaluation> {
    if (isClearlyRiskReducing(ctx)) return {}

    const equity = new Decimal(ctx.account.netLiquidation)
    const state = await this.stateStore.update((draft) => {
      const current = new Decimal(draft.maxDrawdown?.highWaterMark ?? equity)
      if (!draft.maxDrawdown || equity.gt(current)) {
        /*
         * High-water marks ratchet on raw netLiquidation. External cash flows
         * are not netted out, so a deposit-then-withdrawal can fabricate
         * drawdown. Failure direction is conservative: this can block new risk,
         * but clearly risk-reducing operations return before state access and
         * are never blocked. Flow-aware baselines plus a human-only rebase route
         * are tracked in issue #26.
         */
        draft.maxDrawdown = { highWaterMark: equity.toString() }
      }
    })

    const highWaterMark = new Decimal(state.maxDrawdown?.highWaterMark ?? equity)
    const drawdownPct = highWaterMark.gt(0) && equity.lt(highWaterMark)
      ? highWaterMark.minus(equity).div(highWaterMark).mul(100)
      : new Decimal(0)

    const metrics = {
      drawdownPct: drawdownPct.toNumber(),
      maxDrawdownPct: this.maxDrawdownPct,
      highWaterMark: highWaterMark.toNumber(),
      equity: equity.toNumber(),
    }

    if (drawdownPct.gte(this.maxDrawdownPct)) {
      return {
        reason: `Drawdown is ${drawdownPct.toFixed(1)}% of equity (limit: ${this.maxDrawdownPct}%)`,
        metrics,
      }
    }

    return { metrics }
  }
}
