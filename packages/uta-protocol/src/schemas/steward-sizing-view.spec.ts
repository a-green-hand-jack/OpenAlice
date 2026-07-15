import { describe, expect, it } from 'vitest'

import { stewardAuthoritativeSizingViewSchema } from './steward-sizing-view.js'

const view = {
  version: 1,
  account: {
    accountId: 'mock-d5', accountStateVersion: 'account:1', equity: '100000',
    instrument: {
      instrument: 'mock-d5|ASSET-A', positionQuantity: '0', markPrice: '100',
      contractMultiplier: '1', quantityIncrement: '1',
    },
  },
  risk: {
    accountId: 'mock-d5', riskStateVersion: 'risk:1',
    envelope: {
      kind: 'available', envelopeVersion: 3, scopeAllowed: true, increaseAllowed: true,
      caps: { maxPositionPctOfEquity: '25', maxSingleOrderPctOfEquity: '20', remainingLossPctOfEquity: '5' },
    },
  },
  brokerCapabilities: {
    capabilitiesStateVersion: 'caps:1', market: true, stop: true,
    stopLimit: { supported: true, limitOffsetBps: 25 },
  },
  sourceStateVersions: {
    accountState: 'account:1', riskState: 'risk:1', riskEnvelope: 3, brokerCapabilities: 'caps:1',
  },
}

describe('authoritative Steward sizing view wire', () => {
  it('requires the four source versions to match the read payload', () => {
    expect(stewardAuthoritativeSizingViewSchema.parse(view)).toEqual(view)
    expect(() => stewardAuthoritativeSizingViewSchema.parse({
      ...view,
      sourceStateVersions: { ...view.sourceStateVersions, riskEnvelope: 4 },
    })).toThrow(/risk envelope version mismatch/)
  })

  it('represents missing envelopes without inventing a version', () => {
    expect(stewardAuthoritativeSizingViewSchema.parse({
      ...view,
      risk: { accountId: 'mock-d5', riskStateVersion: 'risk:1', envelope: { kind: 'missing' } },
      sourceStateVersions: { ...view.sourceStateVersions, riskEnvelope: null },
    })).toMatchObject({ risk: { envelope: { kind: 'missing' } } })
  })
})
