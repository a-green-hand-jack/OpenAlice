import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Order } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { describe, expect, it, vi } from 'vitest'
import type {
  GitExportState,
  Operation,
  StewardSizingSourceVersions,
  StewardUtaMutationRequest,
} from '@traderalice/uta-protocol'

import { withAccountsConfigLock } from '@/core/accounts-config-lock.js'
import { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import { MockBroker, makeContract } from './brokers/mock/index.js'
import {
  UTAManager,
  type StewardMutationFixtureProducer,
} from './uta-manager.js'

const ACCOUNT_ID = 'mock-steward-d2'
const ENVELOPE = {
  version: 3,
  maxPositionPctOfEquity: 25,
  maxSingleOrderPctOfEquity: 20,
  maxDailyLossPct: 5,
  maxDrawdownPct: 10,
  scope: { kind: 'whitelist' as const, symbols: ['ASSET-A'] },
  autonomyCeiling: 'paper' as const,
  revoked: false,
  revokedReason: null,
}
const SOURCE_VERSIONS: StewardSizingSourceVersions = {
  accountState: 'account:1',
  riskState: 'risk:1',
  riskEnvelope: 3,
  brokerCapabilities: 'broker:1',
}

function request(overrides: Partial<StewardUtaMutationRequest> = {}): StewardUtaMutationRequest {
  return {
    version: 1,
    accountId: ACCOUNT_ID,
    utaMutationReference: 'uta-mutation:steward-d2',
    expectedSourceVersions: SOURCE_VERSIONS,
    operation: {
      operationId: 'operation:increase:1',
      kind: 'order_place',
      effect: 'increase',
      instrument: `${ACCOUNT_ID}/ASSET-A`,
      side: 'BUY',
      totalQuantity: '15',
    },
    protection: {
      kind: 'selected',
      operationId: 'operation:increase:1',
      instrument: `${ACCOUNT_ID}/ASSET-A`,
      exitSide: 'SELL',
      orderType: 'STP',
      triggerPrice: '90',
    },
    ...overrides,
  } as StewardUtaMutationRequest
}

function fixtureOperation(input: StewardUtaMutationRequest): Operation {
  const contract = makeContract({
    aliceId: input.operation.instrument,
    symbol: input.operation.instrument.split('/').at(-1) ?? 'ASSET-A',
  })
  if (!('protection' in input)) {
    return {
      action: 'closePosition',
      contract,
      quantity: new Decimal(input.operation.totalQuantity),
    }
  }
  const order = new Order()
  order.action = input.operation.side
  order.orderType = 'MKT'
  order.totalQuantity = new Decimal(input.operation.totalQuantity)
  return {
    action: 'placeOrder',
    contract,
    order,
    tpsl: {
      stopLoss: {
        price: input.protection.triggerPrice,
        ...(input.protection.orderType === 'STP_LMT'
          ? { limitPrice: input.protection.limitPrice }
          : {}),
      },
    },
  }
}

interface HarnessOptions {
  readonly versions?: StewardSizingSourceVersions
  readonly trustedSource?: typeof ENVELOPE | null
  readonly invoke?: StewardMutationFixtureProducer['invokeOperation']
  readonly producer?: boolean
  readonly sourceReadError?: boolean
}

async function createHarness(options: HarnessOptions = {}) {
  const lockRoot = await mkdtemp(join(tmpdir(), 'openalice-steward-mutation-lock-'))
  const durable = { state: undefined as GitExportState | undefined }
  const invokeOperation = vi.fn(options.invoke ?? (async ({ operation }) => ({
    action: operation.action,
    success: true,
    status: 'submitted' as const,
    orderId: 'fixture-order-1',
  })))
  const producer: StewardMutationFixtureProducer = {
    createOperation: ({ request: mutationRequest }) => fixtureOperation(mutationRequest),
    readSourceVersions: async () => {
      if (options.sourceReadError) throw new Error('fixture source unavailable')
      return options.versions ?? SOURCE_VERSIONS
    },
    invokeOperation,
  }
  const source = {
    riskEnvelope: options.trustedSource === undefined ? ENVELOPE : options.trustedSource,
    accountMaxAuthzLevel: 'paper' as const,
  }
  const criticalSection = {
    run: <T>(_accountId: string, consume: (value: typeof source) => Promise<T>) =>
      withAccountsConfigLock(lockRoot, () => consume(source)),
  }
  const manager = new UTAManager({
    ...(options.producer === false ? {} : { stewardMutationFixtureProducer: producer }),
    stewardMutationCriticalSection: criticalSection,
    stewardMutationDurableStateReader: async () => durable.state,
  })
  const broker = new MockBroker({ id: ACCOUNT_ID, label: ACCOUNT_ID })
  const uta = new UnifiedTradingAccount(broker, {
    onCommit: (state) => {
      durable.state = JSON.parse(JSON.stringify(state)) as GitExportState
    },
  })
  durable.state ??= uta.exportGitState()
  manager.add(uta)
  return {
    manager,
    invokeOperation,
    durable,
    async close() {
      await manager.closeAll()
      await rm(lockRoot, { recursive: true, force: true })
    },
  }
}

describe('UTA-owned Steward mutation boundary', () => {
  it('fails closed when the D2 fixture producer is not configured', async () => {
    const harness = await createHarness({ producer: false })
    try {
      await expect(harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', request()))
        .resolves.toMatchObject({ status: 'rejected', code: 'mutation_capability_unavailable' })
      expect(harness.invokeOperation).not.toHaveBeenCalled()
    } finally {
      await harness.close()
    }
  })

  it('uses trusted workspace authz with a fixed paper minimum', async () => {
    const harness = await createHarness()
    try {
      const response = await harness.manager.invokeStewardMutation(ACCOUNT_ID, 'read_only', request())
      expect(response).toMatchObject({ status: 'rejected', code: 'authz_below_required' })
      expect(harness.invokeOperation).not.toHaveBeenCalled()
    } finally {
      await harness.close()
    }
  })

  it('rejects a request whose account identity differs from the bound manager account', async () => {
    const harness = await createHarness()
    try {
      const response = await harness.manager.invokeStewardMutation(
        ACCOUNT_ID,
        'paper',
        request({ accountId: 'mock-steward-other' }),
      )
      expect(response).toMatchObject({ status: 'rejected', code: 'account_identity_mismatch' })
      expect(harness.invokeOperation).not.toHaveBeenCalled()
    } finally {
      await harness.close()
    }
  })

  it.each([
    ['accountState', 'account:2', 'source_state_changed'],
    ['riskState', 'risk:2', 'source_state_changed'],
    ['riskEnvelope', 4, 'envelope_version_changed'],
    ['brokerCapabilities', 'broker:2', 'source_state_changed'],
  ] as const)('rejects fresh %s drift before fixture invocation', async (key, value, code) => {
    const harness = await createHarness({ versions: { ...SOURCE_VERSIONS, [key]: value } })
    try {
      const response = await harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', request())
      expect(response).toMatchObject({ status: 'rejected', code, changed: [key] })
      if (response.status === 'rejected' && response.code === 'source_state_changed') {
        expect(response.changed.length).toBeGreaterThan(0)
      }
      expect(harness.invokeOperation).not.toHaveBeenCalled()
    } finally {
      await harness.close()
    }
  })

  it('fails closed when the trusted source-version producer is unavailable', async () => {
    const harness = await createHarness({ sourceReadError: true })
    try {
      await expect(harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', request()))
        .resolves.toMatchObject({ status: 'rejected', code: 'source_state_invalid' })
      expect(harness.invokeOperation).not.toHaveBeenCalled()
    } finally {
      await harness.close()
    }
  })

  it('deduplicates an accepted key and rejects the same key with a different operation/protection payload', async () => {
    const harness = await createHarness()
    try {
      const first = await harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', request())
      const retry = await harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', request())
      const base = request()
      const conflict = await harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', request({
        ...('protection' in base
          ? { protection: { ...base.protection, triggerPrice: '89' } }
          : {}),
      }))

      expect(first).toMatchObject({ status: 'accepted', deduplicated: false })
      expect(retry).toMatchObject({ status: 'accepted', deduplicated: true })
      expect(conflict).toMatchObject({ status: 'rejected', code: 'idempotency_conflict' })
      expect(harness.invokeOperation).toHaveBeenCalledTimes(1)
      expect(harness.invokeOperation.mock.calls[0]?.[0].request).toHaveProperty('protection')
      expect(harness.durable.state?.commits.at(-1)?.operations[0])
        .toHaveProperty('tpsl.stopLoss.price', '90')
    } finally {
      await harness.close()
    }
  })

  it('leaves a failed dispatching attempt in recovery and never redispatches it', async () => {
    const harness = await createHarness({
      invoke: async () => { throw new Error('fixture acknowledgement unknown') },
    })
    try {
      const first = await harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', request())
      const retry = await harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', request())
      expect(first).toMatchObject({ status: 'rejected', code: 'mutation_recovery_required' })
      expect(retry).toMatchObject({ status: 'rejected', code: 'mutation_recovery_required' })
      expect(harness.invokeOperation).toHaveBeenCalledTimes(1)
      expect(harness.durable.state?.mutation?.activeAttempt).toBeDefined()
    } finally {
      await harness.close()
    }
  })

  it('echoes only boundary identity and dedupe metadata, never fixture results', async () => {
    const harness = await createHarness()
    try {
      const response = await harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', request({
        utaMutationReference: `uta-mutation:${randomUUID()}`,
      }))
      expect(response).toMatchObject({
        status: 'accepted',
        accountId: ACCOUNT_ID,
        operationId: request().operation.operationId,
      })
      expect(response).not.toHaveProperty('result')
      expect(response).not.toHaveProperty('lifecycle')
      expect(response).not.toHaveProperty('reconciliation')
    } finally {
      await harness.close()
    }
  })
})
