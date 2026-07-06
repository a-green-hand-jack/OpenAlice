import {
  AUTHZ_LEVEL_RANK,
  DEFAULT_AUTHZ_LEVEL,
  isPaperLikeAccountType,
  resolveEffectiveAuthzLevel,
  type ApproverIdentity,
  type AuthzAccountType,
  type AuthzLevel,
  type PushResult,
  type RiskStateInfo,
} from '@traderalice/uta-protocol'
import type { UnifiedTradingAccount } from './UnifiedTradingAccount.js'

export const AUTO_PUSH_PAPER_VIA = 'auto-push-paper' as const

export type PaperAutoPushAccountType = Extract<AuthzAccountType, 'mock' | 'paper'>

export type PaperAutoPushSkipReason =
  | 'not_configured'
  | 'no_pending_commit'
  | 'account_type_not_paper'
  | 'authz_below_paper'
  | 'risk_state_not_normal'
  | 'push_in_flight'

export type PaperAutoPushResult =
  | {
      status: 'pushed'
      hash: string
      push: PushResult
      approver: ApproverIdentity
      effectiveAuthzLevel: AuthzLevel
    }
  | {
      status: 'skipped'
      reason: PaperAutoPushSkipReason
      pendingHash?: string
      accountType?: AuthzAccountType
      effectiveAuthzLevel?: AuthzLevel
      risk?: RiskStateInfo
    }
  | {
      status: 'failed'
      reason: string
      pendingHash: string
      effectiveAuthzLevel: AuthzLevel
      risk?: RiskStateInfo
    }

export interface PaperAutoPushInput {
  uta: UnifiedTradingAccount
  accountType: AuthzAccountType
  accountMaxAuthzLevel?: AuthzLevel | null
  /**
   * The caller's already-resolved workspace/account effective level when the
   * commit came through the workspace tool surface. Missing is conservative:
   * direct/manual UTA commits do not get paper auto-push by accident.
   */
  effectiveAuthzLevel?: AuthzLevel | null
  now?: () => Date
}

interface PaperAutoPushEligibility {
  uta: UnifiedTradingAccount
  pendingHash: string
  accountType: PaperAutoPushAccountType
  effectiveAuthzLevel: AuthzLevel
  now: () => Date
}

export function assertPaperAutoPushAccountType(accountType: AuthzAccountType): PaperAutoPushAccountType {
  if (!isPaperLikeAccountType(accountType)) {
    throw new Error(`paper auto-push executor is unreachable for ${accountType} accounts`)
  }
  return accountType
}

export function resolvePaperAutoPushEligibility(
  input: PaperAutoPushInput,
): { ok: true; eligibility: PaperAutoPushEligibility } | { ok: false; result: PaperAutoPushResult } {
  const pendingHash = input.uta.status().pendingHash ?? undefined
  if (!pendingHash) {
    return { ok: false, result: { status: 'skipped', reason: 'no_pending_commit' } }
  }

  // Structural live-account gate: only a paper/mock typed value can construct
  // the executor input below. Live accounts return before any broker-capable
  // path exists, rather than relying on a disabled config flag.
  if (!isPaperLikeAccountType(input.accountType)) {
    return {
      ok: false,
      result: {
        status: 'skipped',
        reason: 'account_type_not_paper',
        pendingHash,
        accountType: input.accountType,
      },
    }
  }

  const effectiveAuthzLevel = resolveEffectiveAuthzLevel({
    accountMaxAuthzLevel: input.accountMaxAuthzLevel,
    workspaceAuthzLevel: input.effectiveAuthzLevel ?? DEFAULT_AUTHZ_LEVEL,
  })
  if (AUTHZ_LEVEL_RANK[effectiveAuthzLevel] < AUTHZ_LEVEL_RANK.paper) {
    return {
      ok: false,
      result: {
        status: 'skipped',
        reason: 'authz_below_paper',
        pendingHash,
        accountType: input.accountType,
        effectiveAuthzLevel,
      },
    }
  }

  return {
    ok: true,
    eligibility: {
      uta: input.uta,
      pendingHash,
      accountType: assertPaperAutoPushAccountType(input.accountType),
      effectiveAuthzLevel,
      now: input.now ?? (() => new Date()),
    },
  }
}

async function executePaperAutoPush(
  eligibility: PaperAutoPushEligibility,
): Promise<PaperAutoPushResult> {
  const status = eligibility.uta.status()
  if (status.pendingHash !== eligibility.pendingHash) {
    return { status: 'skipped', reason: 'no_pending_commit' }
  }

  const risk = eligibility.uta.getRiskState()
  if (risk.state !== 'NORMAL') {
    return {
      status: 'skipped',
      reason: 'risk_state_not_normal',
      pendingHash: eligibility.pendingHash,
      accountType: eligibility.accountType,
      effectiveAuthzLevel: eligibility.effectiveAuthzLevel,
      risk,
    }
  }

  const approver: ApproverIdentity = {
    via: AUTO_PUSH_PAPER_VIA,
    at: eligibility.now().toISOString(),
  }

  try {
    const push = await eligibility.uta.push(approver)
    return {
      status: 'pushed',
      hash: push.hash,
      push,
      approver,
      effectiveAuthzLevel: eligibility.effectiveAuthzLevel,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (/push already in progress/i.test(reason)) {
      return {
        status: 'skipped',
        reason: 'push_in_flight',
        pendingHash: eligibility.pendingHash,
        accountType: eligibility.accountType,
        effectiveAuthzLevel: eligibility.effectiveAuthzLevel,
        risk,
      }
    }
    return {
      status: 'failed',
      reason,
      pendingHash: eligibility.pendingHash,
      effectiveAuthzLevel: eligibility.effectiveAuthzLevel,
      risk,
    }
  }
}

export async function tryAutoPushPaper(input: PaperAutoPushInput): Promise<PaperAutoPushResult> {
  const resolved = resolvePaperAutoPushEligibility(input)
  if (!resolved.ok) return resolved.result
  return executePaperAutoPush(resolved.eligibility)
}
