import { describe, expect, it, vi } from 'vitest'

import type { UTAEngineContext } from '../types.js'
import { createTradingRoutes } from './routes-trading.js'

function routesFor(response: unknown) {
  const checkStewardAdmission = vi.fn(async () => response)
  const ctx = {
    utaManager: {
      has: (id: string) => id === 'paper-1',
      checkStewardAdmission,
      listUTAs: () => [],
      getAggregatedEquity: vi.fn(),
    },
  } as unknown as UTAEngineContext
  return { routes: createTradingRoutes(ctx), checkStewardAdmission }
}

async function post(routes: ReturnType<typeof createTradingRoutes>, body: unknown) {
  const response = await routes.request('/uta/paper-1/steward/admission', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

describe('versioned Steward admission wire', () => {
  it('forwards a strict v1 request and returns the UTA admission result', async () => {
    const admitted = {
      version: 1,
      status: 'admitted',
      accountId: 'paper-1',
      envelopeVersion: 3,
      effectiveAuthzLevel: 'paper',
    }
    const { routes, checkStewardAdmission } = routesFor(admitted)
    const request = {
      version: 1,
      workspaceAuthzLevel: 'paper',
      minimumAuthzLevel: 'paper',
      expectedEnvelopeVersion: 3,
    }

    expect(await post(routes, request)).toEqual({ status: 200, body: admitted })
    expect(checkStewardAdmission).toHaveBeenCalledWith('paper-1', request)
  })

  it('rejects unknown wire versions before manager admission', async () => {
    const { routes, checkStewardAdmission } = routesFor(null)
    expect(await post(routes, {
      version: 2,
      workspaceAuthzLevel: 'paper',
      minimumAuthzLevel: 'paper',
    })).toMatchObject({ status: 400 })
    expect(checkStewardAdmission).not.toHaveBeenCalled()
  })

  it('returns 404 for an account outside the UTA registry', async () => {
    const { routes } = routesFor(null)
    const response = await routes.request('/uta/missing/steward/admission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, workspaceAuthzLevel: 'paper', minimumAuthzLevel: 'paper' }),
    })
    expect(response.status).toBe(404)
  })
})
