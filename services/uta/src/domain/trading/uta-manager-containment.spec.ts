import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TradingMode, UTAConfig } from '@/core/config.js'
import { MockBroker } from './brokers/mock/index.js'

const factoryMock = vi.hoisted(() => ({ createBroker: vi.fn() }))
const persistenceMock = vi.hoisted(() => ({
  loadGitState: vi.fn(async () => undefined),
  createGitPersister: vi.fn(() => () => {}),
}))

vi.mock('./brokers/factory.js', () => ({ createBroker: factoryMock.createBroker }))
vi.mock('./git-persistence.js', () => persistenceMock)

import { UTAManager } from './uta-manager.js'

const managers: UTAManager[] = []
let latestBroker: MockBroker

beforeEach(() => {
  vi.clearAllMocks()
  factoryMock.createBroker.mockImplementation((cfg: UTAConfig) => {
    latestBroker = new MockBroker({ id: cfg.id, label: cfg.label })
    return latestBroker
  })
})

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()))
})

function policyConfig(presetId: string, presetConfig: Record<string, unknown>): UTAConfig {
  return {
    id: 'manager-policy-fixture',
    presetId,
    enabled: true,
    guards: [],
    presetConfig,
    keyless: false,
    readOnly: false,
    asVendor: true,
    editable: true,
  }
}

const externalPaper = policyConfig('ibkr-tws', {
  host: '127.0.0.1',
  port: 7497,
  clientId: 0,
})
const verifiedMock = policyConfig('mock-simulator', { cash: 100_000 })

async function exercise(cfg: UTAConfig, tradingMode: TradingMode) {
  const manager = new UTAManager({ tradingMode })
  managers.push(manager)
  const uta = await manager.initUTA(cfg)
  await uta.waitForConnect()
  uta.stagePlaceOrder({
    aliceId: `${cfg.id}|AAPL`,
    action: 'BUY',
    orderType: 'MKT',
    totalQuantity: '1',
  })
  uta.commit(`${tradingMode} manager policy probe`)
  latestBroker.resetCalls()
  return { uta, broker: latestBroker }
}

describe('UTAManager containment propagation', () => {
  it.each(['readonly', 'lite'] as const)(
    '%s propagates real preset config as unverified and blocks broker mutation',
    async (tradingMode) => {
      const { uta, broker } = await exercise(externalPaper, tradingMode)

      await expect(uta.push()).rejects.toThrow(`UTA trading mode is ${tradingMode}`)
      expect(uta.containmentClass).toBe('unverified')
      expect(broker.callCount('placeOrder')).toBe(0)
    },
  )

  it('readonly propagates the built-in simulator as verified-isolated and permits it', async () => {
    const { uta, broker } = await exercise(verifiedMock, 'readonly')

    const result = await uta.push()
    expect(result.submitted).toHaveLength(1)
    expect(uta.containmentClass).toBe('verified-isolated')
    expect(broker.callCount('placeOrder')).toBe(1)
  })

  it('lite blocks even the verified built-in simulator if UTA starts manually', async () => {
    const { uta, broker } = await exercise(verifiedMock, 'lite')

    await expect(uta.push()).rejects.toThrow('UTA trading mode is lite')
    expect(uta.containmentClass).toBe('verified-isolated')
    expect(broker.callCount('placeOrder')).toBe(0)
  })

  it('pro permits an unverified preset subject to its independent account controls', async () => {
    const { uta, broker } = await exercise(externalPaper, 'pro')

    const result = await uta.push()
    expect(result.submitted).toHaveLength(1)
    expect(uta.containmentClass).toBe('unverified')
    expect(broker.callCount('placeOrder')).toBe(1)
  })
})
