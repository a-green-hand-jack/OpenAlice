import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createSession, _reset, revokeAllSessions } from '@/services/auth/session-store.js'
import { createAuthMiddleware } from '../middleware/auth.js'
import { createTradingProxyRoutes } from './trading-proxy.js'

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
  it('persists alice-bff approver for a default loopback request with a valid session cookie', async () => {
    const session = await createSession()
    const expectedFingerprint = fingerprint(session.sid)
    const persisted = installRecordingUta()
    let sessionAttachedByMiddleware: unknown = 'not-observed'
    const app = createAuthedTradingApp((sessionValue) => {
      sessionAttachedByMiddleware = sessionValue
    })

    const res = await push(app, { Cookie: `alice_session=${encodeURIComponent(session.sid)}` })

    expect(res.status).toBe(200)
    expect(sessionAttachedByMiddleware).toBeUndefined()
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

  it('persists loopback approver for invalid, expired, or malformed loopback session cookies', async () => {
    const expired = await createSession({ ttlMs: -1_000 })
    const persisted = installRecordingUta()
    const app = createAuthedTradingApp()

    for (const cookie of [
      'alice_session=missing-session',
      `alice_session=${encodeURIComponent(expired.sid)}`,
      'alice_session=%E0%A4%A',
    ]) {
      const res = await push(app, { Cookie: cookie })
      expect(res.status).toBe(200)
    }

    expect(persisted.commits.map((commit) => commit.approver)).toEqual([
      expect.objectContaining({ via: 'loopback', at: expect.any(String) }),
      expect.objectContaining({ via: 'loopback', at: expect.any(String) }),
      expect.objectContaining({ via: 'loopback', at: expect.any(String) }),
    ])
    for (const commit of persisted.commits) {
      expect(commit.approver.fingerprint).toBeUndefined()
    }
  })

  it('keeps loopback push authorized without any session cookie and records loopback', async () => {
    const persisted = installRecordingUta()
    const app = createAuthedTradingApp()

    const res = await push(app)

    expect(res.status).toBe(200)
    expect(persisted.commits).toHaveLength(1)
    expect(persisted.commits[0].approver).toMatchObject({
      via: 'loopback',
      at: expect.any(String),
    })
    expect(persisted.commits[0].approver.fingerprint).toBeUndefined()
  })
})

function createAuthedTradingApp(onAfterAuth?: (sessionValue: unknown) => void): Hono {
  const app = new Hono()
  app.use('*', createAuthMiddleware({ trustedProxies: [], csrfTrustedOrigins: [] }))
  if (onAfterAuth) {
    app.use('*', async (c, next) => {
      onAfterAuth((c as unknown as { get: (key: string) => unknown }).get('session'))
      await next()
    })
  }
  app.route('/api/trading', createTradingProxyRoutes({ utaBaseUrl: 'http://127.0.0.1:47333' }))
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
