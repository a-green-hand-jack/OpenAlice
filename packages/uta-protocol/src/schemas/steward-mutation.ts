import { z } from 'zod'
import Decimal from 'decimal.js'

import { stewardAdmissionRejectionCodeSchema } from './risk-envelope.js'

export const STEWARD_UTA_MUTATION_BOUNDARY_VERSION = 1 as const
export const STEWARD_UTA_MUTATION_MINIMUM_AUTHZ_LEVEL = 'paper' as const
export const UTA_STEWARD_WORKSPACE_AUTHZ_HEADER = 'x-openalice-steward-workspace-authz'

const nonEmptyStringSchema = z.string().trim().min(1)
const opaqueReferenceSchema = z.string().refine((value) => value.trim().length > 0, {
  message: 'expected a non-empty opaque UTA mutation reference',
})
const sourceVersionSchema = z.union([
  nonEmptyStringSchema,
  z.number().int().nonnegative(),
])

export const stewardSizingSourceVersionKeySchema = z.enum([
  'accountState',
  'riskState',
  'riskEnvelope',
  'brokerCapabilities',
])
export type StewardSizingSourceVersionKey = z.infer<typeof stewardSizingSourceVersionKeySchema>

export const stewardSizingSourceVersionsSchema = z.object({
  accountState: sourceVersionSchema,
  riskState: sourceVersionSchema,
  riskEnvelope: sourceVersionSchema.nullable(),
  brokerCapabilities: sourceVersionSchema,
}).strict()
export type StewardSizingSourceVersions = z.infer<typeof stewardSizingSourceVersionsSchema>

export const stewardMutationExpectedSourceVersionsSchema = stewardSizingSourceVersionsSchema.extend({
  riskEnvelope: z.number().int().positive(),
}).strict()
export type StewardMutationExpectedSourceVersions = z.infer<
  typeof stewardMutationExpectedSourceVersionsSchema
>

const decimalStringSchema = z.string().refine((value) => {
  if (!/^(?:\d+|\d+\.\d+|\.\d+)$/.test(value)) return false
  try {
    const parsed = new Decimal(value)
    return parsed.isFinite() && parsed.gt(0)
  } catch {
    return false
  }
}, { message: 'expected a finite positive decimal string' })

export const stewardDeterministicOperationSchema = z.object({
  operationId: nonEmptyStringSchema,
  kind: z.enum(['order_place', 'position_close']),
  effect: z.enum(['increase', 'reduce']),
  instrument: nonEmptyStringSchema,
  side: z.enum(['BUY', 'SELL']),
  totalQuantity: decimalStringSchema,
}).strict()
export type StewardDeterministicOperation = z.infer<typeof stewardDeterministicOperationSchema>

export const stewardProtectiveEntryPlanSchema = z.discriminatedUnion('orderType', [
  z.object({
    kind: z.literal('selected'),
    operationId: nonEmptyStringSchema,
    instrument: nonEmptyStringSchema,
    exitSide: z.enum(['BUY', 'SELL']),
    orderType: z.literal('STP'),
    triggerPrice: decimalStringSchema,
  }).strict(),
  z.object({
    kind: z.literal('selected'),
    operationId: nonEmptyStringSchema,
    instrument: nonEmptyStringSchema,
    exitSide: z.enum(['BUY', 'SELL']),
    orderType: z.literal('STP_LMT'),
    triggerPrice: decimalStringSchema,
    limitPrice: decimalStringSchema,
    limitOffsetBps: z.number().finite().positive().lt(10_000),
  }).strict(),
])
export type StewardProtectiveEntryPlan = z.infer<typeof stewardProtectiveEntryPlanSchema>

const mutationRequestIdentityShape = {
  version: z.literal(STEWARD_UTA_MUTATION_BOUNDARY_VERSION),
  accountId: nonEmptyStringSchema,
  utaMutationReference: opaqueReferenceSchema,
  expectedSourceVersions: stewardMutationExpectedSourceVersionsSchema,
}

export const stewardUtaMutationRequestSchema = z.union([
  z.object({
    ...mutationRequestIdentityShape,
    operation: stewardDeterministicOperationSchema.extend({ effect: z.literal('increase') }),
    protection: stewardProtectiveEntryPlanSchema,
  }).strict(),
  z.object({
    ...mutationRequestIdentityShape,
    operation: stewardDeterministicOperationSchema.extend({ effect: z.literal('reduce') }),
  }).strict(),
]).superRefine((request, ctx) => {
  if (!('protection' in request)) return
  if (request.protection.operationId !== request.operation.operationId) {
    ctx.addIssue({ code: 'custom', path: ['protection', 'operationId'], message: 'protection operationId mismatch' })
  }
  if (request.protection.instrument !== request.operation.instrument) {
    ctx.addIssue({ code: 'custom', path: ['protection', 'instrument'], message: 'protection instrument mismatch' })
  }
  const expectedExitSide = request.operation.side === 'BUY' ? 'SELL' : 'BUY'
  if (request.protection.exitSide !== expectedExitSide) {
    ctx.addIssue({ code: 'custom', path: ['protection', 'exitSide'], message: 'protection must oppose entry side' })
  }
})
export type StewardUtaMutationRequest = z.infer<typeof stewardUtaMutationRequestSchema>

const mutationIdentityShape = {
  version: z.literal(STEWARD_UTA_MUTATION_BOUNDARY_VERSION),
  accountId: nonEmptyStringSchema,
  utaMutationReference: opaqueReferenceSchema,
  operationId: nonEmptyStringSchema,
}

const mutationBoundaryOnlyRejectionCodeSchema = z.enum([
  'source_state_invalid',
  'source_state_changed',
  'mutation_capability_unavailable',
  'account_identity_mismatch',
  'idempotency_conflict',
  'mutation_busy',
  'mutation_recovery_required',
])

const otherMutationRejectionCodeSchema = z.union([
  stewardAdmissionRejectionCodeSchema,
  z.enum([
    'source_state_invalid',
    'mutation_capability_unavailable',
    'account_identity_mismatch',
    'idempotency_conflict',
    'mutation_busy',
    'mutation_recovery_required',
  ]),
])

export const stewardUtaMutationRejectionCodeSchema = z.union([
  stewardAdmissionRejectionCodeSchema,
  mutationBoundaryOnlyRejectionCodeSchema,
])
export type StewardUtaMutationRejectionCode = z.infer<
  typeof stewardUtaMutationRejectionCodeSchema
>

const acceptedMutationResponseSchema = z.object({
  ...mutationIdentityShape,
  status: z.literal('accepted'),
  deduplicated: z.boolean(),
}).strict()

const sourceChangedMutationResponseSchema = z.object({
  ...mutationIdentityShape,
  status: z.literal('rejected'),
  code: z.literal('source_state_changed'),
  changed: z.array(stewardSizingSourceVersionKeySchema).min(1),
}).strict()

const otherRejectedMutationResponseSchema = z.object({
  ...mutationIdentityShape,
  status: z.literal('rejected'),
  code: otherMutationRejectionCodeSchema,
  changed: z.array(stewardSizingSourceVersionKeySchema).min(1).optional(),
}).strict()

export const stewardUtaMutationResponseSchema = z.union([
  acceptedMutationResponseSchema,
  sourceChangedMutationResponseSchema,
  otherRejectedMutationResponseSchema,
])
export type StewardUtaMutationResponse = z.infer<typeof stewardUtaMutationResponseSchema>

export type StewardSourceVersionBarrierResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: 'envelope_version_changed' | 'source_state_changed'
      readonly changed: readonly StewardSizingSourceVersionKey[]
      readonly expected: StewardSizingSourceVersions
      readonly actual: StewardSizingSourceVersions
    }

export function compareStewardSizingSourceVersions(
  expectedInput: unknown,
  actualInput: unknown,
): StewardSourceVersionBarrierResult {
  const expected = stewardSizingSourceVersionsSchema.parse(expectedInput)
  const actual = stewardSizingSourceVersionsSchema.parse(actualInput)
  const keys = Object.keys(expected) as StewardSizingSourceVersionKey[]
  const changed = keys.filter((key) => !sameSourceVersion(expected[key], actual[key]))
  if (changed.length === 0) return { ok: true }
  return {
    ok: false,
    code: changed.includes('riskEnvelope') ? 'envelope_version_changed' : 'source_state_changed',
    changed,
    expected,
    actual,
  }
}

function sameSourceVersion(left: string | number | null, right: string | number | null): boolean {
  return typeof left === typeof right && left === right
}
