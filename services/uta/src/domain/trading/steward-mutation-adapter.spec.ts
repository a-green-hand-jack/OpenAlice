import { describe, expect, it } from 'vitest'

import { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import { MockBroker } from './brokers/mock/index.js'
import { createVerifiedMockStewardMutationAdapter } from './steward-mutation-adapter.js'
import { supportsStewardMutationRequest } from './uta-manager.js'

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
})
