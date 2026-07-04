import Decimal from 'decimal.js'
import type { GuardContext, GuardEvaluation, GuardRuntimeOptions, OperationGuard } from './types.js'
import {
  createInMemoryPortfolioGuardStateStore,
  createPortfolioGuardStateStore,
  type PortfolioGuardStateStore,
} from './portfolio-state.js'
import { isClearlyRiskReducing } from './portfolio-risk.js'

const DEFAULT_MAX_DAILY_LOSS_PCT = 5

export class DailyLossGuard implements OperationGuard {
  readonly name = 'daily-loss'
  private readonly maxDailyLossPct: number
  private readonly stateStore: PortfolioGuardStateStore
  private readonly now: () => Date

  constructor(options: Record<string, unknown>, runtime: GuardRuntimeOptions = {}) {
    this.maxDailyLossPct = Number(options.maxDailyLossPct ?? DEFAULT_MAX_DAILY_LOSS_PCT)
    this.stateStore = runtime.stateStore
      ?? (runtime.accountId
        ? createPortfolioGuardStateStore(runtime.accountId, runtime.stateBaseDir ? { baseDir: runtime.stateBaseDir } : undefined)
        : createInMemoryPortfolioGuardStateStore())
    this.now = runtime.now ?? (() => new Date())
  }

  async check(ctx: GuardContext): Promise<string | null> {
    return (await this.evaluate(ctx)).reason ?? null
  }

  async evaluate(ctx: GuardContext): Promise<GuardEvaluation> {
    if (isClearlyRiskReducing(ctx)) return {}

    const equity = new Decimal(ctx.account.netLiquidation)
    // UTC is deliberate: UTA accounts can span brokers/exchanges with
    // different venue-local calendars, while persisted guard state needs one
    // deterministic rollover boundary across restarts.
    const utcDate = this.now().toISOString().slice(0, 10)

    const state = await this.stateStore.update((draft) => {
      if (!draft.dailyLoss || draft.dailyLoss.utcDate !== utcDate) {
        /*
         * Day-start equity baselines ratchet on raw netLiquidation. External
         * cash flows are not netted out, so a deposit-then-withdrawal can
         * fabricate drawdown. Failure direction is conservative: this can block
         * new risk, but clearly risk-reducing operations return before state
         * access and are never blocked. Flow-aware baselines plus a human-only
         * rebase route are tracked in issue #26.
         */
        draft.dailyLoss = { utcDate, dayStartEquity: equity.toString() }
      }
    })

    const dayStartEquity = new Decimal(state.dailyLoss?.dayStartEquity ?? equity)
    const dailyLossPct = dayStartEquity.gt(0) && equity.lt(dayStartEquity)
      ? dayStartEquity.minus(equity).div(dayStartEquity).mul(100)
      : new Decimal(0)

    const metrics = {
      dailyLossPct: dailyLossPct.toNumber(),
      maxDailyLossPct: this.maxDailyLossPct,
      dayStartEquity: dayStartEquity.toNumber(),
      equity: equity.toNumber(),
    }

    if (dailyLossPct.gt(this.maxDailyLossPct)) {
      return {
        reason: `Daily loss is ${dailyLossPct.toFixed(1)}% of day-start equity (limit: ${this.maxDailyLossPct}%)`,
        metrics,
      }
    }

    return { metrics }
  }
}
