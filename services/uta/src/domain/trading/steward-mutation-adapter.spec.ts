import { describe, expect, it, vi } from 'vitest'
import type { UTAConfig } from '@/core/config.js'
import type { GitExportState, StewardUtaMutationRequest } from '@traderalice/uta-protocol'

import { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import { MockBroker } from './brokers/mock/index.js'
import { createVerifiedMockStewardMutationAdapter } from './steward-mutation-adapter.js'
import { supportsStewardMutationRequest, UTAManager } from './uta-manager.js'

const ACCOUNT_ID = 'mock-d5-production'
const envelope = {
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

function config(overrides: Partial<UTAConfig> = {}): UTAConfig {
  return {
    id: ACCOUNT_ID, presetId: 'mock-simulator', enabled: true, guards: [],
    riskEnvelope: envelope, maxAuthzLevel: 'paper', presetConfig: { cash: 100_000 },
    keyless: false, readOnly: false, asVendor: true, editable: true,
    ...overrides,
  }
}

async function productionHarness(mode: 'readonly' | 'lite' | 'pro' = 'readonly') {
  let current = config()
  let durable: GitExportState | undefined
  const broker = new MockBroker({ id: ACCOUNT_ID })
  const uta = new UnifiedTradingAccount(broker, {
    tradingMode: mode, containmentClass: 'verified-isolated',
    onCommit: (state) => { durable = JSON.parse(JSON.stringify(state)) as GitExportState },
  })
  await uta.waitForConnect()
  let manager: UTAManager
  const adapter = createVerifiedMockStewardMutationAdapter((id) => manager.get(id))
  manager = new UTAManager({
    tradingMode: mode,
    stewardMutationFixtureProducer: adapter,
    stewardMutationCriticalSection: {
      run: async (_id, consume) => consume({
        riskEnvelope: current.riskEnvelope,
        accountMaxAuthzLevel: current.maxAuthzLevel ?? null,
        config: current,
      }),
    },
    stewardMutationDurableStateReader: async () => durable,
  })
  durable = uta.exportGitState()
  manager.add(uta, current)
  const view = await manager.readStewardSizingView(ACCOUNT_ID, {
    version: 1,
    instrument: `${ACCOUNT_ID}|ASSET-A`,
  })
  const request: StewardUtaMutationRequest = {
    version: 1, accountId: ACCOUNT_ID, utaMutationReference: 'd5:production',
    expectedSourceVersions: view.sourceStateVersions,
    operation: { operationId: 'd5:production:increase', kind: 'order_place', effect: 'increase', instrument: `${ACCOUNT_ID}|ASSET-A`, side: 'BUY', totalQuantity: '2' },
    protection: { kind: 'selected', operationId: 'd5:production:increase', instrument: `${ACCOUNT_ID}|ASSET-A`, exitSide: 'SELL', orderType: 'STP', triggerPrice: '90' },
  }
  return {
    manager, broker, adapter, request, view,
    setConfig(next: UTAConfig) { current = next },
    async close() { await manager.closeAll() },
  }
}

describe('verified Mock Steward mutation adapter', () => {
  it('maps a deterministic protected increase and dispatches only through the in-memory MockBroker', async () => {
    const broker = new MockBroker({ id: 'mock-d5' })
    const uta = new UnifiedTradingAccount(broker, {
      tradingMode: 'readonly',
      containmentClass: 'verified-isolated',
    })
    await uta.waitForConnect()
    const adapter = createVerifiedMockStewardMutationAdapter((id) => id === uta.id ? uta : undefined)
    const request = {
      version: 1 as const,
      accountId: uta.id,
      utaMutationReference: 'd5:mock:1',
      expectedSourceVersions: {
        accountState: 'account:1', riskState: 'risk:1', riskEnvelope: 1, brokerCapabilities: 'caps:1',
      },
      operation: {
        operationId: 'd5:increase:1', kind: 'order_place' as const, effect: 'increase' as const,
        instrument: `${uta.id}|ASSET-A`, side: 'BUY' as const, totalQuantity: '2',
      },
      protection: {
        kind: 'selected' as const, operationId: 'd5:increase:1', instrument: `${uta.id}|ASSET-A`,
        exitSide: 'SELL' as const, orderType: 'STP' as const, triggerPrice: '90',
      },
    }

    const operation = adapter.createOperation({ accountId: uta.id, request })
    await adapter.invokeOperation({ accountId: uta.id, request, operation })

    expect(adapter.productionAdapter).toBe(true)
    expect(operation).toMatchObject({ action: 'placeOrder', order: { orderType: 'MKT' } })
    expect(broker.callCount('placeOrder')).toBe(1)
    await uta.close()
  })

  it('refuses unsupported protection or market capabilities before adapter dispatch', () => {
    const request = {
      version: 1 as const, accountId: 'mock-d5', utaMutationReference: 'd5:capabilities',
      expectedSourceVersions: { accountState: 'a', riskState: 'r', riskEnvelope: 1, brokerCapabilities: 'c' },
      operation: { operationId: 'op', kind: 'order_place' as const, effect: 'increase' as const, instrument: 'mock-d5|A', side: 'BUY' as const, totalQuantity: '1' },
      protection: { kind: 'selected' as const, operationId: 'op', instrument: 'mock-d5|A', exitSide: 'SELL' as const, orderType: 'STP' as const, triggerPrice: '90' },
    }
    const view = {
      version: 1 as const,
      account: { accountId: 'mock-d5', accountStateVersion: 'a', equity: '100', instrument: { instrument: 'mock-d5|A', positionQuantity: '0', markPrice: '100', contractMultiplier: '1', quantityIncrement: '1' } },
      risk: { accountId: 'mock-d5', riskStateVersion: 'r', envelope: { kind: 'available' as const, envelopeVersion: 1, scopeAllowed: true, increaseAllowed: true, caps: { maxPositionPctOfEquity: '10', maxSingleOrderPctOfEquity: '10', remainingLossPctOfEquity: '1' } } },
      brokerCapabilities: { capabilitiesStateVersion: 'c', market: true, stop: false, stopLimit: { supported: false as const } },
      sourceStateVersions: { accountState: 'a', riskState: 'r', riskEnvelope: 1, brokerCapabilities: 'c' },
    }
    expect(supportsStewardMutationRequest(request, view)).toBe(false)
  })

  it('uses the production manager boundary for an in-memory MockBroker mutation', async () => {
    const harness = await productionHarness()
    try {
      expect(harness.view.risk.envelope).toMatchObject({
        kind: 'available', caps: { remainingLossPctOfEquity: '0' },
      })
      await expect(harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', harness.request))
        .resolves.toMatchObject({ status: 'accepted', deduplicated: false })
      expect(harness.broker.callCount('placeOrder')).toBe(1)
    } finally {
      await harness.close()
    }
  })

  it.each([
    ['non-mock config', config({ presetId: 'ibkr-tws', presetConfig: { host: '127.0.0.1', port: 7497, clientId: 0 } }), 'mutation_capability_unavailable'],
    ['unknown config', config({ presetId: 'unknown', presetConfig: {} }), 'mutation_capability_unavailable'],
    ['unverified config', config({ presetId: 'mock-simulator', presetConfig: { cash: 'invalid' } }), 'mutation_capability_unavailable'],
    ['missing envelope', config({ riskEnvelope: null }), 'risk_envelope_missing'],
    ['revoked envelope', config({ riskEnvelope: { ...envelope, revoked: true, revokedReason: 'stop' } }), 'risk_envelope_revoked'],
    ['envelope version drift', config({ riskEnvelope: { ...envelope, version: 4 } }), 'envelope_version_changed'],
  ] as const)('fails closed through UTAManager for %s', async (_label, freshConfig, code) => {
    const harness = await productionHarness()
    const invoke = vi.spyOn(harness.adapter, 'invokeOperation')
    const create = vi.spyOn(harness.adapter, 'createOperation')
    try {
      harness.setConfig(freshConfig)
      await expect(harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', harness.request))
        .resolves.toMatchObject({ status: 'rejected', code })
      expect(create).not.toHaveBeenCalled()
      expect(invoke).not.toHaveBeenCalled()
      expect(harness.broker.callCount('placeOrder')).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it.each(['lite', 'pro'] as const)('does not enable the production adapter in %s mode', async (mode) => {
    const harness = await productionHarness(mode)
    const create = vi.spyOn(harness.adapter, 'createOperation')
    const invoke = vi.spyOn(harness.adapter, 'invokeOperation')
    try {
      await expect(harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', harness.request))
        .resolves.toMatchObject({ status: 'rejected', code: 'mutation_capability_unavailable' })
      expect(create).not.toHaveBeenCalled()
      expect(invoke).not.toHaveBeenCalled()
      expect(harness.broker.callCount('placeOrder')).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('rejects stale account versions, wrong account, and capability drift before MockBroker dispatch', async () => {
    const harness = await productionHarness()
    const create = vi.spyOn(harness.adapter, 'createOperation')
    const invoke = vi.spyOn(harness.adapter, 'invokeOperation')
    try {
      harness.broker.setMarkPrice('ASSET-A', '101')
      await expect(harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', harness.request))
        .resolves.toMatchObject({ status: 'rejected', code: 'source_state_changed', changed: ['accountState'] })
      expect(invoke).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(harness.broker.callCount('placeOrder')).toBe(0)

      await expect(harness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', {
        ...harness.request, accountId: 'wrong-account',
      })).resolves.toMatchObject({ status: 'rejected', code: 'account_identity_mismatch' })
      expect(harness.broker.callCount('placeOrder')).toBe(0)
    } finally {
      await harness.close()
    }

    const capabilityHarness = await productionHarness()
    const capabilityCreate = vi.spyOn(capabilityHarness.adapter, 'createOperation')
    const capabilityInvoke = vi.spyOn(capabilityHarness.adapter, 'invokeOperation')
    try {
      capabilityHarness.broker.getCapabilities = () => ({
        supportedSecTypes: ['STK'], supportedOrderTypes: ['MKT'],
      })
      await expect(capabilityHarness.manager.invokeStewardMutation(ACCOUNT_ID, 'paper', capabilityHarness.request))
        .resolves.toMatchObject({ status: 'rejected', code: 'source_state_invalid' })
      expect(capabilityInvoke).not.toHaveBeenCalled()
      expect(capabilityCreate).not.toHaveBeenCalled()
      expect(capabilityHarness.broker.callCount('placeOrder')).toBe(0)
    } finally {
      await capabilityHarness.close()
    }
  })
})
