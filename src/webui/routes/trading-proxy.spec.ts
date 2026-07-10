import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createSession, _reset, revokeAllSessions } from '@/services/auth/session-store.js'
import { createAuthMiddleware } from '../middleware/auth.js'
import { createTradingProxyRoutes } from './trading-proxy.js'
import { UTA_INTERNAL_TOKEN_HEADER } from '@traderalice/uta-protocol'

type RecordedApprover =
  | { via: 'alice-bff'; fingerprint?: string; at: string }
  | { via: 'loopback'; fingerprint?: undefined; at: string }

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const APPROVER_HEADER = 'x-openalice-approver'

let tmpDir: string | null = null

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'oa-trading-proxy-'))
  process.env['OPENALICE_SESSIONS_FILE'] = join(tmpDir, 'sessions.json')
  await _reset()
  await revokeAllSessions()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await _reset()
  delete process.env['OPENALICE_SESSIONS_FILE']
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  tmpDir = null
})

describe('trading proxy approver hand-off', () => {
  // Post-#55: /api/trading/* is loopback-exempt in the auth middleware — a
  // loopback request now requires a valid session, so the legitimate browser
  // path (valid cookie) still reaches the proxy and is attributed alice-bff,
  // while the old "loopback push with no/invalid session is authorized and
  // recorded as via:loopback" path is now rejected with 401 before it ever
  // reaches UTA. That anonymous-loopback push was the door #55 closes.
  it('validates the session and persists an alice-bff approver for a loopback request with a valid session cookie', async () => {
    const session = await createSession()
    const expectedFingerprint = fingerprint(session.sid)
    const persisted = installRecordingUta()
    let sessionAttachedByMiddleware: unknown = 'not-observed'
    const app = createAuthedTradingApp((sessionValue) => {
      sessionAttachedByMiddleware = sessionValue
    })

    const res = await push(app, { Cookie: `alice_session=${encodeURIComponent(session.sid)}` })

    expect(res.status).toBe(200)
    // The request went through the real session-check path (not the loopback
    // bypass, which is no longer honored for /api/trading/*), so the middleware
    // validated and attached the session.
    expect(sessionAttachedByMiddleware).not.toBe('not-observed')
    expect(sessionAttachedByMiddleware).toBeTruthy()
    expect(persisted.commits).toHaveLength(1)
    const persistedCommit = await readPersistedCommit(persisted.commitFile, 0)
    expect(persistedCommit.approver).toMatchObject({
      via: 'alice-bff',
      fingerprint: expectedFingerprint,
      at: expect.any(String),
    })
    const headers = forwardedHeaders(persisted.fetchSpy)
    expect(headers.get('cookie')).toBeNull()
    expect(JSON.stringify([...headers.entries()])).not.toContain(session.sid)
  })

  it('rejects a loopback push with invalid, expired, or malformed session cookies (401) and never reaches UTA', async () => {
    const expired = await createSession({ ttlMs: -1_000 })
    const persisted = installRecordingUta()
    const app = createAuthedTradingApp()

    for (const cookie of [
      'alice_session=missing-session',
      `alice_session=${encodeURIComponent(expired.sid)}`,
      'alice_session=%E0%A4%A',
    ]) {
      const res = await push(app, { Cookie: cookie })
      expect(res.status).toBe(401)
    }

    // The auth gate rejected every request before the proxy ran, so no commit
    // was ever forwarded to UTA.
    expect(persisted.commits).toHaveLength(0)
    expect(persisted.fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a loopback push with no session cookie (401) and never reaches UTA', async () => {
    const persisted = installRecordingUta()
    const app = createAuthedTradingApp()

    const res = await push(app)

    expect(res.status).toBe(401)
    expect(persisted.commits).toHaveLength(0)
    expect(persisted.fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards the Guardian internal token to UTA when configured (authenticated request)', async () => {
    const session = await createSession()
    const persisted = installRecordingUta()
    const app = createAuthedTradingApp(undefined, 'proxy-internal-token')

    const res = await push(app, { Cookie: `alice_session=${encodeURIComponent(session.sid)}` })

    expect(res.status).toBe(200)
    expect(forwardedHeaders(persisted.fetchSpy).get(UTA_INTERNAL_TOKEN_HEADER)).toBe('proxy-internal-token')
  })
})

describe('createTradingProxyRoutes — UTA optional carrier', () => {
  it('reports lite-mode status when the carrier is intentionally disabled', async () => {
    const app = createTradingProxyRoutes({ disabledReason: 'lite_mode' })
    const res = await app.request('/status')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      available: false,
      state: 'unavailable',
      reason: 'lite_mode',
    })
  })

  it('returns 503 for trading calls when lite mode disables the carrier', async () => {
    const app = createTradingProxyRoutes({ disabledReason: 'lite_mode' })
    const res = await app.request('/uta')
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: 'UTA disabled',
      detail: 'Trading mode is lite',
    })
  })

  it('reports the effective mode in status', async () => {
    const app = createTradingProxyRoutes({ disabledReason: 'lite_mode' })
    const res = await app.request('/status')
    await expect(res.json()).resolves.toMatchObject({
      mode: 'lite',
      modeSource: 'env',
      envLocked: true,
    })
  })

  it('blocks venue-mutating writes in readonly mode', async () => {
    const app = createTradingProxyRoutes({
      utaBaseUrl: 'http://127.0.0.1:47333',
      getPolicy: () => ({ mode: 'readonly', source: 'config', envLocked: false, hasUTAConfig: true }),
    })
    const res = await app.request('/api/trading/uta/alpaca/wallet/push', { method: 'POST' })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      error: 'Trading mode is readonly',
    })
  })

  it.each([
    '/api/trading/uta/alpaca/emergency-stop',
    '/api/trading/uta/alpaca/flatten',
  ])('blocks human emergency broker mutation in readonly mode: %s', async (path) => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const app = createTradingProxyRoutes({
      utaBaseUrl: 'http://127.0.0.1:47333',
      getPolicy: () => ({ mode: 'readonly', source: 'config', envLocked: false, hasUTAConfig: true }),
    })

    const res = await app.request(path, { method: 'POST', body: '{}' })

    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('allows readonly emergency-stop when cancelOrders is explicitly false', async () => {
    const payload = {
      reason: 'local halt only',
      cancelOrders: false,
      operatorContext: { incident: 'stage-0-forwarding-proof' },
    }
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await expect(new Response(init?.body).json()).resolves.toEqual(payload)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const app = createTradingProxyRoutes({
      utaBaseUrl: 'http://127.0.0.1:47333',
      getPolicy: () => ({ mode: 'readonly', source: 'config', envLocked: false, hasUTAConfig: true }),
    })

    const res = await app.request('/api/trading/uta/alpaca/emergency-stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing body', { method: 'POST' }],
    ['malformed JSON', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-json' }],
  ])('fails closed for readonly emergency-stop with %s', async (_label, init) => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const app = createTradingProxyRoutes({
      utaBaseUrl: 'http://127.0.0.1:47333',
      getPolicy: () => ({ mode: 'readonly', source: 'config', envLocked: false, hasUTAConfig: true }),
    })

    const res = await app.request('/api/trading/uta/alpaca/emergency-stop', init)

    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('allows local proposal writes in readonly mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))
    const app = createTradingProxyRoutes({
      utaBaseUrl: 'http://127.0.0.1:47333',
      getPolicy: () => ({ mode: 'readonly', source: 'config', envLocked: false, hasUTAConfig: true }),
    })
    const res = await app.request('/api/trading/uta/alpaca/wallet/stage-place-order', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
  })

  it('reports unavailable status when no carrier URL is configured', async () => {
    const app = createTradingProxyRoutes({})
    const res = await app.request('/status')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      available: false,
      state: 'unavailable',
      reason: 'not_configured',
    })
  })

  it('returns 503 for trading calls when no carrier URL is configured', async () => {
    const app = createTradingProxyRoutes({})
    const res = await app.request('/uta')
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: 'UTA unavailable',
    })
  })

  it('reports available status from UTA health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, startedAt: '2026-07-05T00:00:00.000Z', utas: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))
    const app = createTradingProxyRoutes({ utaBaseUrl: 'http://127.0.0.1:47333' })
    const res = await app.request('/status')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      available: true,
      state: 'available',
      startedAt: '2026-07-05T00:00:00.000Z',
      utas: 2,
    })
  })
})

function createAuthedTradingApp(onAfterAuth?: (sessionValue: unknown) => void, internalToken?: string): Hono {
  const app = new Hono()
  app.use('*', createAuthMiddleware({ trustedProxies: [], csrfTrustedOrigins: [] }))
  if (onAfterAuth) {
    app.use('*', async (c, next) => {
      onAfterAuth((c as unknown as { get: (key: string) => unknown }).get('session'))
      await next()
    })
  }
  app.route('/api/trading', createTradingProxyRoutes({ utaBaseUrl: 'http://127.0.0.1:47333', internalToken }))
  return app
}

async function push(app: Hono, headers: Record<string, string> = {}): Promise<Response> {
  return app.request('/api/trading/uta/mock-paper/wallet/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({}),
  }, LOOPBACK_ENV)
}

function installRecordingUta(): {
  commits: Array<{ approver: RecordedApprover }>
  commitFile: string
  fetchSpy: ReturnType<typeof vi.fn>
} {
  const commits: Array<{ approver: RecordedApprover }> = []
  const commitFile = join(requireTmpDir(), 'commit.json')
  const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    commits.push({ approver: approverFromForwardedHeaders(headers) })
    await writeFile(commitFile, JSON.stringify({ commits }, null, 2) + '\n')
    return new Response(JSON.stringify({ hash: `commit-${commits.length}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchSpy)
  return { commits, commitFile, fetchSpy }
}

function approverFromForwardedHeaders(headers: Headers): RecordedApprover {
  const at = new Date().toISOString()
  const raw = headers.get(APPROVER_HEADER)
  if (!raw) return { via: 'loopback', at }
  try {
    const parsed = JSON.parse(raw) as { via?: unknown; fingerprint?: unknown }
    if (parsed.via !== 'alice-bff') return { via: 'loopback', at }
    return {
      via: 'alice-bff',
      ...(typeof parsed.fingerprint === 'string' && parsed.fingerprint ? { fingerprint: parsed.fingerprint } : {}),
      at,
    }
  } catch {
    return { via: 'loopback', at }
  }
}

function fingerprint(sid: string): string {
  return createHash('sha256')
    .update(`openalice-admin-session:${sid}`)
    .digest('hex')
    .slice(0, 16)
}

function forwardedHeaders(fetchSpy: ReturnType<typeof vi.fn>): Headers {
  const init = (fetchSpy.mock.calls as Array<[unknown, RequestInit]>)[0][1]
  return init.headers as Headers
}

async function readPersistedCommit(path: string, index: number): Promise<{ approver: RecordedApprover }> {
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as { commits: Array<{ approver: RecordedApprover }> }
  return parsed.commits[index]
}

function requireTmpDir(): string {
  if (!tmpDir) throw new Error('test temp dir not initialized')
  return tmpDir
}
