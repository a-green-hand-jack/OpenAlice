import { describe, expect, it } from 'vitest'

import {
  entrustedUnitIntentIdentitySchema,
  entrustedUnitMandateSchema,
} from './types.js'

const mandate = {
  version: 1,
  mandateId: 'root-264-run-1',
  entrustedUnitId: 'trading-team-v1',
  parentMandateId: null,
  accountId: 'mock-1',
  capital: { currency: 'USD', limit: '100000' },
  scope: { kind: 'instrument_whitelist', instruments: ['ASSET-A'] },
  validFrom: '2026-07-16T20:00:00.000Z',
  validUntil: '2026-07-17T20:00:00.000Z',
  heartbeat: { intervalMs: 900_000, graceMs: 120_000 },
  riskEnvelope: {
    version: 3,
    maxPositionPctOfEquity: 60,
    maxSingleOrderPctOfEquity: 60,
    maxDailyLossPct: 10,
    maxDrawdownPct: 10,
    scope: { kind: 'whitelist', symbols: ['ASSET-A'] },
    autonomyCeiling: 'paper',
    revoked: false,
    revokedReason: null,
  },
} as const

describe('v1 entrusted-unit contract', () => {
  it('accepts one root mandate bound to one account, Risk Envelope, scope, validity, and heartbeat', () => {
    expect(entrustedUnitMandateSchema.parse(mandate)).toEqual(mandate)
  })

  it('rejects child mandates and scope drift from the UTA Risk Envelope', () => {
    expect(() => entrustedUnitMandateSchema.parse({ ...mandate, parentMandateId: 'parent' })).toThrow()
    expect(() => entrustedUnitMandateSchema.parse({
      ...mandate,
      scope: { kind: 'instrument_whitelist', instruments: ['ASSET-B'] },
    })).toThrow(/mandate scope must equal the Risk Envelope whitelist/)
  })

  it('freezes the Trade Intent identity stamp without defining an LLM implementation', () => {
    expect(entrustedUnitIntentIdentitySchema.parse({
      mandateId: mandate.mandateId,
      entrustedUnitId: mandate.entrustedUnitId,
    })).toEqual({ mandateId: mandate.mandateId, entrustedUnitId: mandate.entrustedUnitId })
    expect(() => entrustedUnitIntentIdentitySchema.parse({ mandateId: mandate.mandateId })).toThrow()
  })
})
