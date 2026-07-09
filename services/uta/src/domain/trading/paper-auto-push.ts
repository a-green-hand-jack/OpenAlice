import Decimal from 'decimal.js'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import {
  AUTHZ_LEVEL_RANK,
  DEFAULT_AUTHZ_LEVEL,
  isPaperLikeAccountType,
  resolveEffectiveAuthzLevel,
  type ApproverIdentity,
  type AuthzAccountType,
  type AuthzLevel,
  type Operation,
  type PaperAutoPushResult,
  type PaperAutoPushSkipReason,
  type PaperDecisionPolicyViolation,
  type PaperDecisionPolicyViolationCode,
  type Position,
  type PushResult,
  type RiskStateInfo,
} from '@traderalice/uta-protocol'
import type { UnifiedTradingAccount } from './UnifiedTradingAccount.js'

// PaperAutoPushResult (+ its skip-reason / policy-violation constituents) is
// declared in @traderalice/uta-protocol, not here: UTA's POST /wallet/commit
// route splices the value this module computes directly onto the HTTP
// response (`{ ...result, autoPush }`, routes-trading.ts), so the *type*
// genuinely crosses the wire and belongs in the shared protocol package
// (issue #111). This module remains the only place the *value* is
// constructed; re-export so existing in-repo imports (`from
// './paper-auto-push.js'`) keep working unchanged.
export type {
  PaperAutoPushResult,
  PaperAutoPushSkipReason,
  PaperDecisionPolicyViolation,
  PaperDecisionPolicyViolationCode,
}

export const AUTO_PUSH_PAPER_VIA = 'auto-push-paper' as const

// Ground truth (docs/steward-p3-campaign.zh.md §4.7): a bear-window
// over-participation failure got the paper steward long into a reversal
// with no protective stop. This cap plus the "must carry a stopLoss" /
// "no averaging down a loser" checks below are the paper-account policy
// countermeasure — deliberately paper-only, deliberately narrow (does not
// touch live/small_live authz tiers or risk-state liquidation behavior).
const PAPER_POLICY_MAX_STOP_LOSS_PCT = 8

export type PaperAutoPushAccountType = Extract<AuthzAccountType, 'mock' | 'paper'>

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

  let policyViolations: PaperDecisionPolicyViolation[]
  try {
    policyViolations = await evaluatePaperDecisionPolicy(eligibility.uta)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      status: 'failed',
      reason: `paper decision policy failed: ${reason}`,
      pendingHash: eligibility.pendingHash,
      effectiveAuthzLevel: eligibility.effectiveAuthzLevel,
      risk,
    }
  }
  if (policyViolations.length > 0) {
    return {
      status: 'skipped',
      reason: 'paper_policy_denied',
      pendingHash: eligibility.pendingHash,
      accountType: eligibility.accountType,
      effectiveAuthzLevel: eligibility.effectiveAuthzLevel,
      risk,
      policyViolations,
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

/**
 * The P3-campaign hard-guard policy (docs/steward-p3-campaign.zh.md §4.7):
 * evaluated against the currently-staged operations before a paper/mock
 * commit is allowed to auto-push. Three checks, each independent:
 *
 *   1. A risk-increasing placeOrder (opening new exposure, or adding to an
 *      existing position in the same direction) must carry an attached
 *      stopLoss.
 *   2. That stopLoss may not imply more than PAPER_POLICY_MAX_STOP_LOSS_PCT
 *      loss from the estimated entry price.
 *   3. An order may not add to an already-losing position (no averaging
 *      down) — reported independently of the stopLoss checks above.
 *
 * Risk-reducing operations (closePosition, or a placeOrder that trims an
 * existing position) are exempt — this mirrors `isClearlyRiskReducing` in
 * guards/portfolio-risk.ts, but is deliberately kept local: this policy is
 * paper-account-only and evaluated pre-commit against staged operations
 * directly, not through the GuardContext the guard pipeline builds.
 */
export async function evaluatePaperDecisionPolicy(uta: UnifiedTradingAccount): Promise<PaperDecisionPolicyViolation[]> {
  const operations = uta.status().staged
  if (operations.length === 0) return []

  const positions = await uta.getPositions()
  const violations: PaperDecisionPolicyViolation[] = []

  for (const operation of operations) {
    if (operation.action !== 'placeOrder') continue
    if (!isIncreasingPlaceOrder(operation, positions)) continue

    const symbol = operationSymbol(operation)
    const existing = findPositionForOperation(operation, positions)
    if (existing && new Decimal(existing.unrealizedPnL || '0').lt(0)) {
      violations.push({
        code: 'adding_to_losing_position',
        symbol,
        reason: `Paper auto-push refuses adding risk to losing position ${symbol}`,
        metrics: { unrealizedPnL: existing.unrealizedPnL },
      })
    }

    const stopLoss = decimalString(operation.tpsl?.stopLoss?.price)
    if (!stopLoss) {
      violations.push({
        code: 'missing_stop_loss',
        symbol,
        reason: `Paper auto-push requires an attached stopLoss for risk-increasing ${symbol} orders`,
        metrics: { maxStopLossPct: PAPER_POLICY_MAX_STOP_LOSS_PCT },
      })
      continue
    }

    const entryPrice = await estimateEntryPrice(uta, operation, existing)
    if (!entryPrice) {
      violations.push({
        code: 'entry_price_unavailable',
        symbol,
        reason: `Paper auto-push could not estimate entry price for ${symbol}; use a limit price or wait for a quote`,
        metrics: { stopLossPrice: stopLoss.toString(), maxStopLossPct: PAPER_POLICY_MAX_STOP_LOSS_PCT },
      })
      continue
    }

    const action = orderAction(operation)
    const rawLossPct = action === 'SELL'
      ? stopLoss.minus(entryPrice).div(entryPrice).mul(100)
      : entryPrice.minus(stopLoss).div(entryPrice).mul(100)
    const metrics = {
      entryPrice: entryPrice.toString(),
      stopLossPrice: stopLoss.toString(),
      stopLossPct: rawLossPct.toNumber(),
      maxStopLossPct: PAPER_POLICY_MAX_STOP_LOSS_PCT,
    }

    if (rawLossPct.lte(0)) {
      violations.push({
        code: 'stop_loss_wrong_side',
        symbol,
        reason: `Paper auto-push stopLoss for ${symbol} is on the wrong side of the estimated entry`,
        metrics,
      })
      continue
    }

    if (rawLossPct.gt(PAPER_POLICY_MAX_STOP_LOSS_PCT)) {
      violations.push({
        code: 'stop_loss_too_wide',
        symbol,
        reason: `Paper auto-push stopLoss for ${symbol} risks ${rawLossPct.toFixed(1)}% (limit: ${PAPER_POLICY_MAX_STOP_LOSS_PCT}%)`,
        metrics,
      })
    }
  }

  return violations
}

function isIncreasingPlaceOrder(operation: Operation, positions: readonly Position[]): boolean {
  if (operation.action !== 'placeOrder') return false
  const existing = findPositionForOperation(operation, positions)
  if (!existing) return true

  const action = orderAction(operation)
  if (existing.side === 'long') return action === 'BUY'
  if (existing.side === 'short') return action === 'SELL'
  return true
}

function findPositionForOperation(operation: Extract<Operation, { action: 'placeOrder' }>, positions: readonly Position[]): Position | undefined {
  const keys = new Set([
    operation.contract.aliceId,
    operation.contract.symbol,
    operation.contract.localSymbol,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0))

  return positions.find((position) => {
    const positionKeys = [
      position.contract.aliceId,
      position.contract.symbol,
      position.contract.localSymbol,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0)
    return positionKeys.some((key) => keys.has(key))
  })
}

async function estimateEntryPrice(
  uta: UnifiedTradingAccount,
  operation: Extract<Operation, { action: 'placeOrder' }>,
  existing: Position | undefined,
): Promise<Decimal | null> {
  const limitPrice = decimalField(operation.order.lmtPrice)
  if (limitPrice) return limitPrice

  if (existing) {
    const mark = decimalString(existing.marketPrice)
    if (mark?.gt(0)) return mark
  }

  try {
    const quote = await uta.getQuote(operation.contract)
    const action = orderAction(operation)
    const candidates = action === 'SELL'
      ? [quote.bid, quote.last, quote.ask]
      : [quote.ask, quote.last, quote.bid]
    for (const candidate of candidates) {
      const parsed = decimalString(candidate)
      if (parsed?.gt(0)) return parsed
    }
  } catch {
    return null
  }

  return null
}

function orderAction(operation: Extract<Operation, { action: 'placeOrder' }>): 'BUY' | 'SELL' {
  return String(operation.order.action || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY'
}

function operationSymbol(operation: Extract<Operation, { action: 'placeOrder' }>): string {
  return operation.contract.symbol || operation.contract.localSymbol || operation.contract.aliceId || 'unknown'
}

function decimalField(value: unknown): Decimal | null {
  if (!value) return null
  if (value instanceof Decimal) {
    if (value.equals(UNSET_DECIMAL) || value.lte(0)) return null
    return value
  }
  const parsed = decimalString(value)
  return parsed?.gt(0) ? parsed : null
}

function decimalString(value: unknown): Decimal | null {
  if (value == null || value === '') return null
  try {
    const parsed = new Decimal(String(value))
    return parsed.isFinite() ? parsed : null
  } catch {
    return null
  }
}
