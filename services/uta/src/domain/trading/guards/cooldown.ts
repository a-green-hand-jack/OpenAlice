import type { OperationGuard, GuardContext, GuardEvaluation } from './types.js'
import { getOperationSymbol } from '../git/types.js'

const DEFAULT_MIN_INTERVAL_MS = 60_000

export class CooldownGuard implements OperationGuard {
  readonly name = 'cooldown'
  private minIntervalMs: number
  private lastTradeTime = new Map<string, number>()

  constructor(options: Record<string, unknown>) {
    this.minIntervalMs = Number(options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)
  }

  check(ctx: GuardContext): string | null {
    return this.evaluate(ctx).reason ?? null
  }

  evaluate(ctx: GuardContext): GuardEvaluation {
    if (ctx.operation.action !== 'placeOrder') return {}

    const symbol = getOperationSymbol(ctx.operation)
    const now = Date.now()
    const lastTime = this.lastTradeTime.get(symbol)
    let msSinceLast: number | null = null

    if (lastTime != null) {
      msSinceLast = now - lastTime
      if (msSinceLast < this.minIntervalMs) {
        const remaining = Math.ceil((this.minIntervalMs - msSinceLast) / 1000)
        return {
          reason: `Cooldown active for ${symbol}: ${remaining}s remaining`,
          metrics: { msSinceLast, cooldownMs: this.minIntervalMs },
        }
      }
    }

    this.lastTradeTime.set(symbol, now)
    return { metrics: { msSinceLast, cooldownMs: this.minIntervalMs } }
  }
}
