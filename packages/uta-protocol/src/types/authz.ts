import { getBrokerPreset, isPaperPreset } from '../brokers/preset-catalog.js'

/**
 * Steward authorization levels.
 *
 * Do not call this `tier`: UTATier already names broker operational reach
 * (`data` / `account` / `trading`). AuthzLevel is the human-granted agent
 * authorization ladder, ordered from least to most exposure.
 */
export const AUTHZ_LEVELS = ['read_only', 'paper', 'small_live', 'limited_autonomy'] as const

export type AuthzLevel = typeof AUTHZ_LEVELS[number]

export const DEFAULT_AUTHZ_LEVEL: AuthzLevel = 'read_only'

export const AUTHZ_LEVEL_RANK: Record<AuthzLevel, number> = {
  read_only: 0,
  paper: 1,
  small_live: 2,
  limited_autonomy: 3,
}

export type AuthzAccountType = 'mock' | 'paper' | 'live' | 'unknown'

export function isAuthzLevel(value: unknown): value is AuthzLevel {
  return typeof value === 'string' && (AUTHZ_LEVELS as readonly string[]).includes(value)
}

export function normalizeAuthzLevel(value: AuthzLevel | null | undefined): AuthzLevel {
  return value ?? DEFAULT_AUTHZ_LEVEL
}

export function minAuthzLevel(
  a: AuthzLevel | null | undefined,
  b: AuthzLevel | null | undefined,
): AuthzLevel {
  const left = normalizeAuthzLevel(a)
  const right = normalizeAuthzLevel(b)
  return AUTHZ_LEVEL_RANK[left] <= AUTHZ_LEVEL_RANK[right] ? left : right
}

export function maxAuthzLevel(
  levels: readonly (AuthzLevel | null | undefined)[],
): AuthzLevel {
  let best = DEFAULT_AUTHZ_LEVEL
  for (const level of levels) {
    const normalized = normalizeAuthzLevel(level)
    if (AUTHZ_LEVEL_RANK[normalized] > AUTHZ_LEVEL_RANK[best]) best = normalized
  }
  return best
}

export function resolveEffectiveAuthzLevel(input: {
  readonly accountMaxAuthzLevel?: AuthzLevel | null
  readonly workspaceAuthzLevel?: AuthzLevel | null
  /** Omit for non-Steward callers. Explicit null means the mandatory account
   *  envelope is missing/invalid and therefore absorbs to read_only. */
  readonly riskEnvelopeAutonomyCeiling?: AuthzLevel | null
  readonly riskEnvelopeRevoked?: boolean
}): AuthzLevel {
  if (input.riskEnvelopeRevoked === true) return DEFAULT_AUTHZ_LEVEL
  const accountAndWorkspace = minAuthzLevel(
    input.accountMaxAuthzLevel,
    input.workspaceAuthzLevel,
  )
  if (!Object.prototype.hasOwnProperty.call(input, 'riskEnvelopeAutonomyCeiling')) {
    return accountAndWorkspace
  }
  return minAuthzLevel(accountAndWorkspace, input.riskEnvelopeAutonomyCeiling)
}

export function isPaperLikeAccountType(
  accountType: AuthzAccountType,
): accountType is Extract<AuthzAccountType, 'paper' | 'mock'> {
  return accountType === 'paper' || accountType === 'mock'
}

export function isAuthzLevelAllowedForAccountType(
  level: AuthzLevel,
  accountType: AuthzAccountType,
): boolean {
  return level !== 'paper' || isPaperLikeAccountType(accountType)
}

export function resolveAuthzAccountType(input: {
  readonly presetId?: string
  readonly presetConfig?: Record<string, unknown> | null
}): AuthzAccountType {
  if (!input.presetId) return 'unknown'
  try {
    const preset = getBrokerPreset(input.presetId)
    if (preset.engine === 'mock') return 'mock'
    return isPaperPreset(input.presetId, input.presetConfig ?? {}) ? 'paper' : 'live'
  } catch {
    return 'unknown'
  }
}
