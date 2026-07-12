import type { OperationGuard, GuardContext, GuardEvaluation } from './types.js'
import { getOperationSymbol } from '../git/types.js'

export class SymbolWhitelistGuard implements OperationGuard {
  readonly name = 'symbol-whitelist'
  readonly requiresCanonicalInstrumentIdentity: boolean
  private readonly allowed: Set<string>

  constructor(options: Record<string, unknown>) {
    this.requiresCanonicalInstrumentIdentity = options.strictEnvelopeScope === true
    const symbols = (this.requiresCanonicalInstrumentIdentity
      ? options.canonicalInstrumentIds
      : options.symbols) as string[] | undefined
    if (!symbols || symbols.length === 0) {
      throw new Error(
        `symbol-whitelist guard requires a non-empty "${this.requiresCanonicalInstrumentIdentity
          ? 'canonicalInstrumentIds'
          : 'symbols'}" array in options`,
      )
    }
    this.allowed = new Set(symbols)
  }

  check(ctx: GuardContext): string | null {
    return this.evaluate(ctx).reason ?? null
  }

  evaluate(ctx: GuardContext): GuardEvaluation {
    if (this.requiresCanonicalInstrumentIdentity && ctx.operation.action === 'cancelOrder') {
      return { metrics: { symbol: 'unknown', protectiveOperation: true } }
    }

    if (this.requiresCanonicalInstrumentIdentity) {
      const canonicalInstrumentId = ctx.canonicalInstrumentId ?? 'unknown'
      const metrics = { symbol: canonicalInstrumentId }
      if (ctx.instrumentIdentityError) {
        return { reason: ctx.instrumentIdentityError, metrics }
      }
      if (canonicalInstrumentId === 'unknown') {
        return {
          reason:
            `Cannot verify instrument identity for ${ctx.operation.action}; ` +
            'the envelope-derived symbol whitelist fails closed.',
          metrics,
        }
      }
      if (!this.allowed.has(canonicalInstrumentId)) {
        return {
          reason: `Instrument ${canonicalInstrumentId} is not in the allowed list`,
          metrics,
        }
      }
      return { metrics }
    }

    const symbol = getOperationSymbol(ctx.operation)
    const metrics = { symbol }
    if (symbol === 'unknown') return { metrics }
    if (!this.allowed.has(symbol)) {
      return { reason: `Symbol ${symbol} is not in the allowed list`, metrics }
    }
    return { metrics }
  }
}
