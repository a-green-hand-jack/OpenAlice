import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'
import { Order } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UTA_INTERNAL_TOKEN_HEADER,
  UTA_STEWARD_WORKSPACE_AUTHZ_HEADER,
  createUTAClient,
  type GitExportState,
  type Operation,
  type StewardUtaMutationRequest,
} from '@traderalice/uta-protocol'

import { withAccountsConfigLock } from '@/core/accounts-config-lock.js'
import { UTAAccountSDK } from '@/services/uta-client/UTAAccountSDK.js'
import { UnifiedTradingAccount } from '../domain/trading/UnifiedTradingAccount.js'
import { MockBroker, makeContract } from '../domain/trading/brokers/mock/index.js'
import { UTAManager } from '../domain/trading/uta-manager.js'
import type { UTAEngineContext } from '../types.js'
import { createUtaInternalAuth, UTA_INTERNAL_TOKEN_ENV } from './internal-auth.js'
import { createTradingRoutes } from './routes-trading.js'

const ACCOUNT_ID = 'mock-steward-http'
const INTERNAL_TOKEN = 'steward-http-internal-token'
const previousToken = process.env[UTA_INTERNAL_TOKEN_ENV]

afterEach(() => {
  if (previousToken === undefined) delete process.env[UTA_INTERNAL_TOKEN_ENV]
  else process.env[UTA_INTERNAL_TOKEN_ENV] = previousToken
})

function mutationRequest(): StewardUtaMutationRequest {
  return {
    version: 1,
    accountId: ACCOUNT_ID,
    utaMutationReference: 'uta-mutation:http:1',
    expectedSourceVersions: {
      accountState: 'account:1',
      riskState: 'risk:1',
      riskEnvelope: 3,
      brokerCapabilities: 'broker:1',
    },
    operation: {
      operationId: 'operation:http:1',
      kind: 'order_place',
      effect: 'increase',
      instrument: `${ACCOUNT_ID}/ASSET-A`,
      side: 'BUY',
      totalQuantity: '15',
    },
    protection: {
      kind: 'selected',
      operationId: 'operation:http:1',
      instrument: `${ACCOUNT_ID}/ASSET-A`,
      exitSide: 'SELL',
      orderType: 'STP',
      triggerPrice: '90',
    },
  }
}

async function createHarness() {
  process.env[UTA_INTERNAL_TOKEN_ENV] = INTERNAL_TOKEN
  const root = await mkdtemp(join(tmpdir(), 'openalice-steward-http-'))
  let durableState: GitExportState | undefined
  let sourceVersions = mutationRequest().expectedSourceVersions
  const invokeOperation = vi.fn(async ({ operation }: { operation: Operation }) => {
    sourceVersions = { ...sourceVersions, accountState: 'account:2' }
    return {
      action: operation.action,
      success: true,
      status: 'submitted' as const,
      orderId: 'fixture-http-order',
    }
  })
  const riskEnvelope = {
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
  const manager = new UTAManager({
    stewardMutationFixtureProducer: {
      createOperation: ({ request }) => {
        const contract = makeContract({ aliceId: request.operation.instrument, symbol: 'ASSET-A' })
        const order = new Order()
        order.action = request.operation.side
        order.orderType = 'MKT'
        order.totalQuantity = new Decimal(request.operation.totalQuantity)
        return {
          action: 'placeOrder',
          contract,
          order,
          tpsl: { stopLoss: { price: 'protection' in request ? request.protection.triggerPrice : '0' } },
        }
      },
      readSourceVersions: async () => sourceVersions,
      invokeOperation,
    },
    stewardMutationCriticalSection: {
      run: <T>(_accountId: string, consume: (source: {
        riskEnvelope: typeof riskEnvelope
        accountMaxAuthzLevel: 'paper'
      }) => Promise<T>) => withAccountsConfigLock(root, () => consume({
        riskEnvelope,
        accountMaxAuthzLevel: 'paper',
      })),
    },
    stewardMutationDurableStateReader: async () => durableState,
  })
  const uta = new UnifiedTradingAccount(new MockBroker({ id: ACCOUNT_ID, label: ACCOUNT_ID }), {
    onCommit: (state) => {
      durableState = JSON.parse(JSON.stringify(state)) as GitExportState
    },
  })
  durableState = uta.exportGitState()
  manager.add(uta)

  const app = new Hono()
  const auth = createUtaInternalAuth()
  app.use('/api/trading', auth)
  app.use('/api/trading/*', auth)
  app.route('/api/trading', createTradingRoutes({ utaManager: manager } as unknown as UTAEngineContext))

  return {
    app,
    manager,
    invokeOperation,
    readSourceVersions: () => sourceVersions,
    async close() {
      await manager.closeAll()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('Steward mutation internal HTTP + SDK binding', () => {
  it('durably deduplicates a retry after the first HTTP acknowledgement is lost', async () => {
    const harness = await createHarness()
    let loseFirstAcceptedResponse = true
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await harness.app.fetch(new Request(input, init))
      const body = await response.clone().json() as { status?: string; deduplicated?: boolean }
      if (loseFirstAcceptedResponse && body.status === 'accepted' && body.deduplicated === false) {
        loseFirstAcceptedResponse = false
        throw new TypeError('loopback acknowledgement lost')
      }
      return response
    }
    const client = createUTAClient({
      baseUrl: 'http://uta.test',
      internalToken: INTERNAL_TOKEN,
      fetch,
    })
    const capability = new UTAAccountSDK({ client, id: ACCOUNT_ID })
      .bindStewardMutationCapability(() => 'paper')

    try {
      await expect(capability.invokeOperation(mutationRequest())).rejects.toThrow(/acknowledgement lost/)
      const retry = await capability.invokeOperation(mutationRequest())
      expect(retry).toEqual({
        version: 1,
        status: 'accepted',
        accountId: ACCOUNT_ID,
        utaMutationReference: mutationRequest().utaMutationReference,
        operationId: mutationRequest().operation.operationId,
        deduplicated: true,
      })
      expect(retry).not.toHaveProperty('result')
      expect(harness.readSourceVersions()).toMatchObject({ accountState: 'account:2' })
      expect(harness.invokeOperation).toHaveBeenCalledTimes(1)
    } finally {
      await harness.close()
    }
  })

  it('takes authz only from the bound SDK header and rejects body overrides', async () => {
    const harness = await createHarness()
    const client = createUTAClient({
      baseUrl: 'http://uta.test',
      internalToken: INTERNAL_TOKEN,
      fetch: async (input, init) => harness.app.fetch(new Request(input, init)),
    })
    try {
      const readOnly = new UTAAccountSDK({ client, id: ACCOUNT_ID })
        .bindStewardMutationCapability(() => 'read_only')
      await expect(readOnly.invokeOperation(mutationRequest())).resolves.toMatchObject({
        status: 'rejected',
        code: 'authz_below_required',
      })
      expect(harness.invokeOperation).not.toHaveBeenCalled()

      await expect(client.request(
        'POST',
        `/api/trading/uta/${ACCOUNT_ID}/steward/mutation`,
        {
          headers: { [UTA_STEWARD_WORKSPACE_AUTHZ_HEADER]: 'limited_autonomy' },
          body: { ...mutationRequest(), minimumAuthzLevel: 'read_only' },
        },
      )).rejects.toMatchObject({ status: 400 })
      await expect(client.request(
        'POST',
        `/api/trading/uta/${ACCOUNT_ID}/steward/mutation`,
        {
          headers: { [UTA_STEWARD_WORKSPACE_AUTHZ_HEADER]: 'paper' },
          body: { ...mutationRequest(), accountId: 'mock-steward-other' },
        },
      )).rejects.toMatchObject({ status: 400 })
      expect(harness.invokeOperation).not.toHaveBeenCalled()
    } finally {
      await harness.close()
    }
  })

  it('requires the Guardian internal token before the trusted authz header is considered', async () => {
    const harness = await createHarness()
    try {
      const response = await harness.app.request(
        `/api/trading/uta/${ACCOUNT_ID}/steward/mutation`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [UTA_STEWARD_WORKSPACE_AUTHZ_HEADER]: 'paper',
          },
          body: JSON.stringify(mutationRequest()),
        },
      )
      expect(response.status).toBe(401)
      expect(new Headers(response.headers).get(UTA_INTERNAL_TOKEN_HEADER)).toBeNull()
      expect(harness.invokeOperation).not.toHaveBeenCalled()
    } finally {
      await harness.close()
    }
  })
})
