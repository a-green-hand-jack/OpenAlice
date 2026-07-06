import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UTA_INTERNAL_TOKEN_HEADER } from '@traderalice/uta-protocol'
import {
  createUtaInternalAuth,
  UTA_AUTH_UNAUTHORIZED_ERROR,
  UTA_AUTH_UNCONFIGURED_ERROR,
  UTA_INTERNAL_TOKEN_ENV,
} from './internal-auth.js'

const PREVIOUS_TOKEN = process.env[UTA_INTERNAL_TOKEN_ENV]

afterEach(() => {
  if (PREVIOUS_TOKEN === undefined) delete process.env[UTA_INTERNAL_TOKEN_ENV]
  else process.env[UTA_INTERNAL_TOKEN_ENV] = PREVIOUS_TOKEN
  vi.restoreAllMocks()
})

describe('UTA internal auth middleware', () => {
  it('returns 401 when the internal token header is missing', async () => {
    process.env[UTA_INTERNAL_TOKEN_ENV] = 'expected-token'
    const app = createApp()

    const res = await app.request('/api/trading/ping')

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: UTA_AUTH_UNAUTHORIZED_ERROR })
  })

  it('returns 401 when the internal token header is wrong', async () => {
    process.env[UTA_INTERNAL_TOKEN_ENV] = 'expected-token'
    const app = createApp()

    const res = await app.request('/api/simulator/ping', {
      headers: { [UTA_INTERNAL_TOKEN_HEADER]: 'wrong-token' },
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: UTA_AUTH_UNAUTHORIZED_ERROR })
  })

  it('passes through when the internal token header matches', async () => {
    process.env[UTA_INTERNAL_TOKEN_ENV] = 'expected-token'
    const app = createApp()

    const res = await app.request('/api/trading/ping', {
      headers: { [UTA_INTERNAL_TOKEN_HEADER]: 'expected-token' },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, surface: 'trading' })
  })

  it('fails closed with 503 when the expected token is unconfigured', async () => {
    delete process.env[UTA_INTERNAL_TOKEN_ENV]
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp()

    const res = await app.request('/api/trading/ping', {
      headers: { [UTA_INTERNAL_TOKEN_HEADER]: 'anything' },
    })

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(UTA_AUTH_UNCONFIGURED_ERROR))
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({ error: UTA_AUTH_UNCONFIGURED_ERROR })
  })

  it('leaves the health route exempt from internal auth', async () => {
    delete process.env[UTA_INTERNAL_TOKEN_ENV]
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp()

    const res = await app.request('/__uta/health')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })
})

function createApp(): Hono {
  const app = new Hono()
  app.get('/__uta/health', (c) => c.json({ ok: true }))

  const authGate = createUtaInternalAuth()
  app.use('/api/trading', authGate)
  app.use('/api/trading/*', authGate)
  app.use('/api/simulator', authGate)
  app.use('/api/simulator/*', authGate)

  app.get('/api/trading/ping', (c) => c.json({ ok: true, surface: 'trading' }))
  app.get('/api/simulator/ping', (c) => c.json({ ok: true, surface: 'simulator' }))
  return app
}
