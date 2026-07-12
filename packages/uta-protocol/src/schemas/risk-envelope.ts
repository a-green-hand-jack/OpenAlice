import { z } from 'zod'

import { AUTHZ_LEVELS } from '../types/authz.js'

export const RISK_ENVELOPE_SCHEMA_VERSION = 3 as const
export const STEWARD_ADMISSION_WIRE_VERSION = 1 as const

const nonEmptyStringSchema = z.string().trim().min(1)
const percentageSchema = z.number().finite().min(0).max(100)

export const riskEnvelopeScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('whitelist'),
    symbols: z.array(nonEmptyStringSchema).min(1),
  }).strict(),
  z.object({
    kind: z.literal('asset_class'),
    assetClasses: z.array(nonEmptyStringSchema).min(1),
  }).strict(),
])

/**
 * Account-level Risk Envelope contract. `asset_class` remains reserved by the
 * v3 contract, but the v3 production admission/compiler rejects it explicitly
 * until canonical asset-class enforcement is defined.
 */
export const riskEnvelopeSchema = z.object({
  version: z.number().int().positive(),
  maxPositionPctOfEquity: percentageSchema,
  maxSingleOrderPctOfEquity: percentageSchema,
  maxDailyLossPct: percentageSchema,
  maxDrawdownPct: percentageSchema,
  scope: riskEnvelopeScopeSchema,
  autonomyCeiling: z.enum(AUTHZ_LEVELS),
  revoked: z.boolean(),
  revokedReason: nonEmptyStringSchema.nullable(),
}).strict().superRefine((envelope, ctx) => {
  const values = envelope.scope.kind === 'whitelist'
    ? envelope.scope.symbols
    : envelope.scope.assetClasses
  if (new Set(values).size !== values.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['scope'],
      message: 'risk envelope scope values must be unique',
    })
  }
  if (envelope.revoked && envelope.revokedReason === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['revokedReason'],
      message: 'a revoked envelope requires a reason',
    })
  }
  if (!envelope.revoked && envelope.revokedReason !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['revokedReason'],
      message: 'a non-revoked envelope requires revokedReason to be null',
    })
  }
})

export type RiskEnvelope = z.infer<typeof riskEnvelopeSchema>
export type RiskEnvelopeScope = z.infer<typeof riskEnvelopeScopeSchema>
export type ProductionRiskEnvelope = RiskEnvelope & {
  scope: Extract<RiskEnvelopeScope, { kind: 'whitelist' }>
}

export const stewardAdmissionRequestSchema = z.object({
  version: z.literal(STEWARD_ADMISSION_WIRE_VERSION),
  workspaceAuthzLevel: z.enum(AUTHZ_LEVELS),
  minimumAuthzLevel: z.enum(AUTHZ_LEVELS),
  expectedEnvelopeVersion: z.number().int().positive().optional(),
}).strict()

export const stewardAdmissionRejectionCodeSchema = z.enum([
  'risk_envelope_missing',
  'risk_envelope_scope_unsupported',
  'risk_envelope_revoked',
  'authz_below_required',
  'envelope_version_changed',
])

export const stewardAdmissionResponseSchema = z.discriminatedUnion('status', [
  z.object({
    version: z.literal(STEWARD_ADMISSION_WIRE_VERSION),
    status: z.literal('admitted'),
    accountId: nonEmptyStringSchema,
    envelopeVersion: z.number().int().positive(),
    effectiveAuthzLevel: z.enum(AUTHZ_LEVELS),
  }).strict(),
  z.object({
    version: z.literal(STEWARD_ADMISSION_WIRE_VERSION),
    status: z.literal('rejected'),
    accountId: nonEmptyStringSchema,
    code: stewardAdmissionRejectionCodeSchema,
    message: nonEmptyStringSchema,
    envelopeVersion: z.number().int().positive().optional(),
    effectiveAuthzLevel: z.enum(AUTHZ_LEVELS).optional(),
  }).strict(),
])

export type StewardAdmissionRequest = z.infer<typeof stewardAdmissionRequestSchema>
export type StewardAdmissionResponse = z.infer<typeof stewardAdmissionResponseSchema>
export type StewardAdmissionRejectionCode = z.infer<typeof stewardAdmissionRejectionCodeSchema>
