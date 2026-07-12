import { describe, expect, it } from 'vitest'

import {
  STEWARD_UTA_MUTATION_BOUNDARY_VERSION,
  stewardUtaMutationRequestSchema,
  stewardUtaMutationResponseSchema,
} from './steward-mutation.js'

const versions = {
  accountState: 'account:1',
  riskState: 'risk:1',
  riskEnvelope: 3,
  brokerCapabilities: 'broker:1',
}

const increase = {
  operationId: 'operation:1',
  kind: 'order_place' as const,
  effect: 'increase' as const,
  instrument: 'mock-1/ASSET-A',
  side: 'BUY' as const,
  totalQuantity: '15',
}

const protection = {
  kind: 'selected' as const,
  operationId: increase.operationId,
  instrument: increase.instrument,
  exitSide: 'SELL' as const,
  orderType: 'STP' as const,
  triggerPrice: '90',
}

const request = {
  version: STEWARD_UTA_MUTATION_BOUNDARY_VERSION,
  accountId: 'mock-1',
  utaMutationReference: 'uta-mutation:1',
  expectedSourceVersions: versions,
  operation: increase,
  protection,
}

describe('Steward UTA mutation wire', () => {
  it('requires one matching protection for increases and none for reductions', () => {
    expect(stewardUtaMutationRequestSchema.parse(request)).toEqual(request)
    expect(() => stewardUtaMutationRequestSchema.parse({ ...request, protection: undefined })).toThrow()
    expect(() => stewardUtaMutationRequestSchema.parse({
      ...request,
      protection: { ...protection, operationId: 'different-operation' },
    })).toThrow(/operationId mismatch/)
    expect(() => stewardUtaMutationRequestSchema.parse({
      ...request,
      operation: { ...increase, effect: 'reduce' },
    })).toThrow()
    expect(stewardUtaMutationRequestSchema.parse({
      version: 1,
      accountId: 'mock-1',
      utaMutationReference: 'uta-mutation:reduce',
      expectedSourceVersions: versions,
      operation: { ...increase, effect: 'reduce' },
    })).not.toHaveProperty('protection')
  })

  it('rejects caller authorization fields from the strict body', () => {
    const { accountId: _accountId, ...withoutAccountId } = request
    expect(() => stewardUtaMutationRequestSchema.parse(withoutAccountId)).toThrow()
    expect(() => stewardUtaMutationRequestSchema.parse({
      ...request,
      workspaceAuthzLevel: 'limited_autonomy',
    })).toThrow()
    expect(() => stewardUtaMutationRequestSchema.parse({
      ...request,
      minimumAuthzLevel: 'read_only',
    })).toThrow()
  })

  it('requires a nonempty changed list for source_state_changed', () => {
    const identity = {
      version: 1,
      status: 'rejected' as const,
      accountId: 'mock-1',
      utaMutationReference: request.utaMutationReference,
      operationId: increase.operationId,
      code: 'source_state_changed' as const,
    }
    expect(() => stewardUtaMutationResponseSchema.parse({ ...identity, changed: [] })).toThrow()
    expect(stewardUtaMutationResponseSchema.parse({
      ...identity,
      changed: ['accountState'],
    })).toMatchObject({ changed: ['accountState'] })
  })
})
