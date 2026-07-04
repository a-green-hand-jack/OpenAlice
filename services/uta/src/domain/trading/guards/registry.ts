import type { GuardRuntimeOptions, OperationGuard, GuardRegistryEntry } from './types.js'
import { MaxPositionSizeGuard } from './max-position-size.js'
import { CooldownGuard } from './cooldown.js'
import { SymbolWhitelistGuard } from './symbol-whitelist.js'
import { MaxDrawdownGuard } from './max-drawdown.js'
import { DailyLossGuard } from './daily-loss.js'
import { ConcentrationGuard } from './concentration.js'
import { createPortfolioGuardStateStore } from './portfolio-state.js'

const builtinGuards: GuardRegistryEntry[] = [
  { type: 'max-position-size', create: (opts) => new MaxPositionSizeGuard(opts) },
  { type: 'cooldown',          create: (opts) => new CooldownGuard(opts) },
  { type: 'symbol-whitelist',  create: (opts) => new SymbolWhitelistGuard(opts) },
  { type: 'max-drawdown',      create: (opts, runtime) => new MaxDrawdownGuard(opts, runtime) },
  { type: 'daily-loss',        create: (opts, runtime) => new DailyLossGuard(opts, runtime) },
  { type: 'concentration',     create: (opts) => new ConcentrationGuard(opts) },
]

const registry = new Map<string, GuardRegistryEntry['create']>(
  builtinGuards.map(g => [g.type, g.create]),
)

/** Register a custom guard type (for third-party extensions). */
export function registerGuard(entry: GuardRegistryEntry): void {
  registry.set(entry.type, entry.create)
}

/** Resolve config entries into guard instances via the registry. */
export function resolveGuards(
  configs: Array<{ type: string; options?: Record<string, unknown> }>,
  runtime: GuardRuntimeOptions = {},
): OperationGuard[] {
  const sharedRuntime = {
    ...runtime,
    stateStore: runtime.stateStore
      ?? (runtime.accountId
        ? createPortfolioGuardStateStore(runtime.accountId, runtime.stateBaseDir ? { baseDir: runtime.stateBaseDir } : undefined)
        : undefined),
  }
  const guards: OperationGuard[] = []
  for (const cfg of configs) {
    const factory = registry.get(cfg.type)
    if (!factory) {
      console.warn(`guard: unknown type "${cfg.type}", skipped`)
      continue
    }
    guards.push(factory(cfg.options ?? {}, sharedRuntime))
  }
  return guards
}
