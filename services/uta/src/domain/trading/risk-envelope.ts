import {
  AUTHZ_LEVEL_RANK,
  STEWARD_ADMISSION_WIRE_VERSION,
  resolveEffectiveAuthzLevel,
  riskEnvelopeSchema,
  stewardAdmissionResponseSchema,
  type AuthzLevel,
  type ProductionRiskEnvelope,
  type StewardAdmissionRequest,
  type StewardAdmissionResponse,
  type StewardAdmissionRejectionCode,
} from '@traderalice/uta-protocol'
import type { IBroker } from './brokers/types.js'
import { resolveCanonicalInstrumentIdentity } from './instrument-identity.js'

export interface RiskEnvelopeAdmissionSource {
  readonly riskEnvelope: unknown
  readonly accountMaxAuthzLevel?: AuthzLevel | null
}

export interface GuardConfig {
  readonly type: string
  readonly options?: Record<string, unknown>
}

export type ProductionRiskEnvelopeResolution =
  | { ok: true; envelope: ProductionRiskEnvelope }
  | { ok: false; code: 'risk_envelope_missing' | 'risk_envelope_scope_unsupported'; message: string }

export class RiskEnvelopeRuntimeError extends Error {
  constructor(
    readonly code: 'risk_envelope_missing' | 'risk_envelope_scope_unsupported',
    message: string,
  ) {
    super(message)
    this.name = 'RiskEnvelopeRuntimeError'
  }
}

export function resolveProductionRiskEnvelope(input: unknown): ProductionRiskEnvelopeResolution {
  const parsed = riskEnvelopeSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'risk_envelope_missing',
      message: 'A complete account Risk Envelope is required before autonomous execution.',
    }
  }
  if (parsed.data.scope.kind !== 'whitelist') {
    return {
      ok: false,
      code: 'risk_envelope_scope_unsupported',
      message:
        'Risk Envelope scope "asset_class" is contract-reserved but unsupported by the v3 production runtime; ' +
        'configure scope.kind="whitelist" with explicit symbols.',
    }
  }
  return { ok: true, envelope: parsed.data as ProductionRiskEnvelope }
}

/** Compile into the existing guard pipeline. These configs are appended to
 * custom guards, so duplicate kinds both evaluate and the stricter one wins. */
export function compileRiskEnvelopeGuards(input: unknown, broker: IBroker): GuardConfig[] {
  const resolved = resolveProductionRiskEnvelope(input)
  if (!resolved.ok) throw new RiskEnvelopeRuntimeError(resolved.code, resolved.message)
  const envelope = resolved.envelope
  let canonicalInstrumentIds: string[]
  try {
    canonicalInstrumentIds = [...new Set(envelope.scope.symbols.map((entry) =>
      resolveCanonicalInstrumentIdentity(broker, entry, {
        allowNormalization: true,
        // CCXT market metadata is loaded asynchronously after account
        // construction. The operation-side resolver below still requires a
        // tradeable contract before any guard can pass or broker can dispatch.
        requireTradeableContract: false,
      }).canonicalId))]
  } catch (error) {
    throw new RiskEnvelopeRuntimeError(
      'risk_envelope_scope_unsupported',
      `Risk Envelope whitelist contains an unresolvable broker instrument: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return [
    {
      type: 'max-position-size',
      options: {
        maxPercentOfEquity: envelope.maxPositionPctOfEquity,
        maxOrderPercentOfEquity: envelope.maxSingleOrderPctOfEquity,
      },
    },
    { type: 'daily-loss', options: { maxDailyLossPct: envelope.maxDailyLossPct } },
    { type: 'max-drawdown', options: { maxDrawdownPct: envelope.maxDrawdownPct } },
    {
      type: 'symbol-whitelist',
      options: {
        canonicalInstrumentIds,
        strictEnvelopeScope: true,
      },
    },
  ]
}

export function evaluateStewardAdmission(input: {
  readonly accountId: string
  readonly source: RiskEnvelopeAdmissionSource
  readonly request: StewardAdmissionRequest
}): StewardAdmissionResponse {
  const resolved = resolveProductionRiskEnvelope(input.source.riskEnvelope)
  if (!resolved.ok) return rejected(input.accountId, resolved.code, resolved.message)

  const envelope = resolved.envelope
  if (
    input.request.expectedEnvelopeVersion !== undefined
    && input.request.expectedEnvelopeVersion !== envelope.version
  ) {
    return rejected(
      input.accountId,
      'envelope_version_changed',
      `Risk Envelope version changed from ${input.request.expectedEnvelopeVersion} to ${envelope.version}; recapture admission.`,
      { envelopeVersion: envelope.version },
    )
  }
  if (envelope.revoked) {
    return rejected(
      input.accountId,
      'risk_envelope_revoked',
      `Risk Envelope is revoked: ${envelope.revokedReason ?? 'no reason supplied'}`,
      { envelopeVersion: envelope.version, effectiveAuthzLevel: 'read_only' },
    )
  }

  const effectiveAuthzLevel = resolveEffectiveAuthzLevel({
    accountMaxAuthzLevel: input.source.accountMaxAuthzLevel,
    workspaceAuthzLevel: input.request.workspaceAuthzLevel,
    riskEnvelopeAutonomyCeiling: envelope.autonomyCeiling,
    riskEnvelopeRevoked: envelope.revoked,
  })
  if (AUTHZ_LEVEL_RANK[effectiveAuthzLevel] < AUTHZ_LEVEL_RANK[input.request.minimumAuthzLevel]) {
    return rejected(
      input.accountId,
      'authz_below_required',
      `Effective authorization ${effectiveAuthzLevel} is below required ${input.request.minimumAuthzLevel}.`,
      { envelopeVersion: envelope.version, effectiveAuthzLevel },
    )
  }

  return stewardAdmissionResponseSchema.parse({
    version: STEWARD_ADMISSION_WIRE_VERSION,
    status: 'admitted',
    accountId: input.accountId,
    envelopeVersion: envelope.version,
    effectiveAuthzLevel,
  })
}

function rejected(
  accountId: string,
  code: StewardAdmissionRejectionCode,
  message: string,
  extra: { envelopeVersion?: number; effectiveAuthzLevel?: AuthzLevel } = {},
): StewardAdmissionResponse {
  return stewardAdmissionResponseSchema.parse({
    version: STEWARD_ADMISSION_WIRE_VERSION,
    status: 'rejected',
    accountId,
    code,
    message,
    ...extra,
  })
}
