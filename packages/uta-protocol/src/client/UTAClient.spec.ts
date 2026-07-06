import { describe, expect, it, vi } from 'vitest'
import { createUTAClient, UTA_INTERNAL_TOKEN_HEADER } from './UTAClient.js'

describe('createUTAClient internal auth', () => {
  it('sends the internal token header when configured', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const client = createUTAClient({
      baseUrl: 'http://127.0.0.1:47333',
      internalToken: 'internal-secret',
      fetch: fetchSpy,
    })

    await client.get('/api/trading/uta')

    const init = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(new Headers(init.headers).get(UTA_INTERNAL_TOKEN_HEADER)).toBe('internal-secret')
  })

  it('omits the internal token header when unconfigured', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const client = createUTAClient({
      baseUrl: 'http://127.0.0.1:47333',
      fetch: fetchSpy,
    })

    await client.get('/api/trading/uta')

    const init = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(new Headers(init.headers).has(UTA_INTERNAL_TOKEN_HEADER)).toBe(false)
  })
})
