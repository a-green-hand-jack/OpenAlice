import Decimal from 'decimal.js'
import type { GuardContext, GuardEvaluation, OperationGuard } from './types.js'
import { estimateInstrumentExposure, isClearlyRiskReducing } from './portfolio-risk.js'

const DEFAULT_MAX_INSTRUMENT_PCT = 25

export class ConcentrationGuard implements OperationGuard {
  readonly name = 'concentration'
  private readonly maxInstrumentPct: number

  constructor(options: Record<string, unknown>) {
    this.maxInstrumentPct = Number(options.maxInstrumentPct ?? DEFAULT_MAX_INSTRUMENT_PCT)
  }

  check(ctx: GuardContext): string | null {
    return this.evaluate(ctx).reason ?? null
  }

  evaluate(ctx: GuardContext): GuardEvaluation {
    if (ctx.operation.action !== 'placeOrder') {
      return { metrics: { instrumentPct: null, maxInstrumentPct: this.maxInstrumentPct, symbol: 'unknown' } }
    }

    const estimate = estimateInstrumentExposure(ctx)
    if (estimate.projectedValue == null || estimate.direction === 'unestimable') {
      return {
        metrics: {
          instrumentPct: null,
          maxInstrumentPct: this.maxInstrumentPct,
          symbol: estimate.symbol,
        },
      }
    }

    const equity = new Decimal(ctx.account.netLiquidation)
    const instrumentPct = equity.gt(0)
      ? estimate.projectedValue.div(equity).mul(100)
      : new Decimal(0)

    const metrics = {
      instrumentPct: instrumentPct.toNumber(),
      maxInstrumentPct: this.maxInstrumentPct,
      symbol: estimate.symbol,
    }

    if (instrumentPct.gt(this.maxInstrumentPct) && !isClearlyRiskReducing(ctx)) {
      return {
        reason: `Instrument ${estimate.symbol} would be ${instrumentPct.toFixed(1)}% of equity (limit: ${this.maxInstrumentPct}%)`,
        metrics,
      }
    }

    return { metrics }
  }
}
