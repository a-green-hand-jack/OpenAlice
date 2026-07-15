import Decimal from 'decimal.js'
import { z } from 'zod'

import { stewardSizingSourceVersionsSchema } from './steward-mutation.js'

export const STEWARD_SIZING_VIEW_WIRE_VERSION = 1 as const

const nonEmptyStringSchema = z.string().trim().min(1)
const sourceVersionSchema = z.union([nonEmptyStringSchema, z.number().int().nonnegative()])
const decimalStringSchema = (options: { positive?: boolean } = {}) => z.string().refine((value) => {
  if (!/^-?(?:\d+|\d+\.\d+|\.\d+)$/.test(value)) return false
  try {
    const parsed = new Decimal(value)
    return parsed.isFinite() && (!options.positive || parsed.gt(0))
  } catch {
    return false
  }
}, { message: options.positive ? 'expected a finite positive decimal string' : 'expected a finite decimal string' })

const positiveDecimalSchema = decimalStringSchema({ positive: true })
const percentDecimalSchema = positiveDecimalSchema.or(z.literal('0')).refine(
  (value) => new Decimal(value).lte(100),
  { message: 'expected a decimal percentage from 0 through 100' },
)

export const stewardSizingViewRequestSchema = z.object({
  version: z.literal(STEWARD_SIZING_VIEW_WIRE_VERSION),
  instrument: nonEmptyStringSchema,
}).strict()
export type StewardSizingViewRequest = z.infer<typeof stewardSizingViewRequestSchema>

export const stewardSizingAccountViewSchema = z.object({
  accountId: nonEmptyStringSchema,
  accountStateVersion: sourceVersionSchema,
  equity: positiveDecimalSchema,
  instrument: z.object({
    instrument: nonEmptyStringSchema,
    positionQuantity: decimalStringSchema(),
    markPrice: positiveDecimalSchema.nullable(),
    contractMultiplier: positiveDecimalSchema,
    quantityIncrement: positiveDecimalSchema,
  }).strict(),
}).strict()
export type StewardSizingAccountView = z.infer<typeof stewardSizingAccountViewSchema>

const normalizedRiskCapsSchema = z.object({
  maxPositionPctOfEquity: percentDecimalSchema,
  maxSingleOrderPctOfEquity: percentDecimalSchema,
  remainingLossPctOfEquity: percentDecimalSchema,
}).strict()

export const stewardSizingRiskViewSchema = z.object({
  accountId: nonEmptyStringSchema,
  riskStateVersion: sourceVersionSchema,
  envelope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('missing') }).strict(),
    z.object({
      kind: z.literal('available'),
      envelopeVersion: sourceVersionSchema,
      scopeAllowed: z.boolean(),
      increaseAllowed: z.boolean(),
      caps: normalizedRiskCapsSchema,
    }).strict(),
  ]),
}).strict()
export type StewardSizingRiskView = z.infer<typeof stewardSizingRiskViewSchema>

export const stewardBrokerProtectionCapabilitiesSchema = z.object({
  capabilitiesStateVersion: sourceVersionSchema,
  market: z.boolean(),
  stop: z.boolean(),
  stopLimit: z.discriminatedUnion('supported', [
    z.object({ supported: z.literal(false) }).strict(),
    z.object({ supported: z.literal(true), limitOffsetBps: z.number().finite().positive().lt(10_000) }).strict(),
  ]),
}).strict()
export type StewardBrokerProtectionCapabilities = z.infer<typeof stewardBrokerProtectionCapabilitiesSchema>

/** UTA-owned, single-read input to deterministic sizing. Source versions are
 * repeated at the wire boundary so a later mutation can compare exactly what
 * was sized, rather than accepting agent/runner-supplied state. */
export const stewardAuthoritativeSizingViewSchema = z.object({
  version: z.literal(STEWARD_SIZING_VIEW_WIRE_VERSION),
  account: stewardSizingAccountViewSchema,
  risk: stewardSizingRiskViewSchema,
  brokerCapabilities: stewardBrokerProtectionCapabilitiesSchema,
  sourceStateVersions: stewardSizingSourceVersionsSchema,
}).strict().superRefine((view, ctx) => {
  const expectedEnvelope = view.risk.envelope.kind === 'available'
    ? view.risk.envelope.envelopeVersion
    : null
  const actual = view.sourceStateVersions
  if (actual.accountState !== view.account.accountStateVersion) {
    ctx.addIssue({ code: 'custom', path: ['sourceStateVersions', 'accountState'], message: 'account state version mismatch' })
  }
  if (actual.riskState !== view.risk.riskStateVersion) {
    ctx.addIssue({ code: 'custom', path: ['sourceStateVersions', 'riskState'], message: 'risk state version mismatch' })
  }
  if (actual.riskEnvelope !== expectedEnvelope) {
    ctx.addIssue({ code: 'custom', path: ['sourceStateVersions', 'riskEnvelope'], message: 'risk envelope version mismatch' })
  }
  if (actual.brokerCapabilities !== view.brokerCapabilities.capabilitiesStateVersion) {
    ctx.addIssue({ code: 'custom', path: ['sourceStateVersions', 'brokerCapabilities'], message: 'broker capabilities version mismatch' })
  }
})
export type StewardAuthoritativeSizingView = z.infer<typeof stewardAuthoritativeSizingViewSchema>
