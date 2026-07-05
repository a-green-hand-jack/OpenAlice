import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createAuthMiddleware } from '../middleware/auth.js'
import { createEventsRoutes, type WebhookIngestEventTypes } from './events.js'
import type { EngineContext } from '../../core/types.js'
import type { ProducerHandle } from '../../core/producer.js'

const mockConfig = vi.hoisted(() => ({
  webhook: {
    tokens: [] as Array<{ id: string; token: string; createdAt: number }>,
  },
}))

vi.mock('../../core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/config.js')>()
  return {
    ...actual,
    readWebhookConfig: vi.fn(async () => mockConfig.webhook),
  }
})

const INTERNAL_TOKEN = 'internal-token'
const EXTERNAL_WEBHOOK_TOKEN = 'external-webhook-token'
const ADMIN_TOKEN = 'admin-token'

const tradePushedPayload = {
  id: 'abc12345',
  accountId: 'mock-paper',
  operationCount: 1,
  operations: [{ action: 'placeOrder', symbol: 'AAPL', status: 'filled' }],
  approver: { via: 'alice-bff', fingerprint: 'session:abc', at: '2026-07-05T00:00:00.000Z' },
  guards: [],
  guardSummary: { configured: [], evaluated: 0, passed: 0, rejected: 0, skipped: 0 },
  risk: { state: 'NORMAL' },
}

function envWithIp(ip: string | undefined) {
  return { incoming: { socket: { remoteAddress: ip } } }
}

function makeApp() {
  const emitted: Array<{ type: string; payload: unknown }> = []
  const ingestProducer = {
    emit: vi.fn(async (type: string, payload: unknown) => {
      emitted.push({ type, payload })
      return { seq: emitted.length, ts: 123, type, payload }
    }),
  }
  const app = new Hono()
  app.use('*', createAuthMiddleware({ trustedProxies: [], csrfTrustedOrigins: [] }))
  app.route('/api/events', createEventsRoutes({
    ctx: {} as EngineContext,
    ingestProducer: ingestProducer as unknown as ProducerHandle<WebhookIngestEventTypes>,
  }))
  return { app, ingestProducer, emitted }
}

let priorInternalToken: string | undefined

beforeEach(() => {
  priorInternalToken = process.env['OPENALICE_INTERNAL_EVENT_TOKEN']
  process.env['OPENALICE_INTERNAL_EVENT_TOKEN'] = INTERNAL_TOKEN
  mockConfig.webhook = {
    tokens: [{ id: 'external-review', token: EXTERNAL_WEBHOOK_TOKEN, createdAt: 0 }],
  }
})

afterEach(() => {
  if (priorInternalToken === undefined) delete process.env['OPENALICE_INTERNAL_EVENT_TOKEN']
  else process.env['OPENALICE_INTERNAL_EVENT_TOKEN'] = priorInternalToken
})

describe('POST /api/events/ingest auth boundary', () => {
  it('rejects non-loopback callers at the middleware even with the internal bearer token', async () => {
    const { app, ingestProducer } = makeApp()
    const res = await app.request('/api/events/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'trade.pushed', payload: tradePushedPayload }),
    }, envWithIp('203.0.113.5'))

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'NO_SESSION' })
    expect(ingestProducer.emit).not.toHaveBeenCalled()
  })

  it('allows the real UTA loopback caller through the middleware and internal bearer gate', async () => {
    const { app, ingestProducer } = makeApp()
    const res = await app.request('/api/events/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'trade.pushed', payload: tradePushedPayload }),
    }, envWithIp('127.0.0.1'))

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ seq: 1, type: 'trade.pushed' })
    expect(ingestProducer.emit).toHaveBeenCalledWith('trade.pushed', tradePushedPayload)
  })

  it.each<[string, Record<string, string>, number, string]>([
    ['no token', {}, 401, 'Missing auth token. Send Authorization: Bearer <token> or X-OpenAlice-Token header.'],
    ['garbage bearer', { authorization: 'Bearer garbage' }, 403, 'Invalid auth token'],
    ['configured external webhook token', { authorization: `Bearer ${EXTERNAL_WEBHOOK_TOKEN}` }, 403, "Event type 'trade.pushed' is not in the external allowlist"],
    ['admin token', { authorization: `Bearer ${ADMIN_TOKEN}` }, 403, 'Invalid auth token'],
  ])('rejects forged trade/risk events from loopback with %s', async (_name, authHeaders, status, error) => {
    const { app, ingestProducer } = makeApp()
    const res = await app.request('/api/events/ingest', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'trade.pushed', payload: tradePushedPayload }),
    }, envWithIp('127.0.0.1'))

    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ error })
    expect(ingestProducer.emit).not.toHaveBeenCalled()
  })
})
