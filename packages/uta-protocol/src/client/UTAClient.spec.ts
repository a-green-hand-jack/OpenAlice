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

  it('allows an SDK binding header without allowing the Guardian token to be overridden', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    const client = createUTAClient({
      baseUrl: 'http://127.0.0.1:47333',
      internalToken: 'guardian-token',
      fetch: fetchSpy,
    })

    await client.request('POST', '/api/trading/uta/a/steward/mutation', {
      headers: {
        'x-openalice-steward-workspace-authz': 'paper',
        [UTA_INTERNAL_TOKEN_HEADER]: 'caller-override',
      },
      body: {},
    })

    const init = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('x-openalice-steward-workspace-authz')).toBe('paper')
    expect(headers.get(UTA_INTERNAL_TOKEN_HEADER)).toBe('guardian-token')
  })
})
