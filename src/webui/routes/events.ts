import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { EngineContext } from '../../core/types.js'
import { isExternalEventType, validateEventPayload } from '../../core/agent-event.js'
import type { ProducerHandle } from '../../core/producer.js'
import { readWebhookConfig } from '../../core/config.js'
import { checkAuth, extractPresentedToken } from './webhook-auth.js'

export type WebhookIngestEventTypes = readonly [
  'agent.work.requested',
  'trade.committed',
  'trade.pushed',
  'trade.executed',
  'trade.rejected',
  'risk.state-changed',
  'risk.emergency-stop',
  'risk.flatten',
]

const INTERNAL_UTA_EVENT_TYPES = new Set<string>([
  'trade.committed',
  'trade.pushed',
  'trade.executed',
  'trade.rejected',
  'risk.state-changed',
  'risk.emergency-stop',
  'risk.flatten',
])

interface EventsDeps {
  ctx: EngineContext
  /** Producer for HTTP-ingested events. Public webhook types require
   *  `external: true`; internal UTA events require Guardian's runtime token. */
  ingestProducer: ProducerHandle<WebhookIngestEventTypes>
}

/** Event log routes: GET /, GET /recent, GET /stream (SSE), POST /ingest, GET /auth-status */
export function createEventsRoutes({ ctx, ingestProducer }: EventsDeps) {
  const app = new Hono()

  // Auth status — surfaces configuration state to the UI without leaking secrets.
  app.get('/auth-status', async (c) => {
    const cfg = await readWebhookConfig()
    return c.json({
      configured: cfg.tokens.length > 0,
      tokenCount: cfg.tokens.length,
      // Token ids are non-secret labels — safe to expose for the admin UI.
      tokenIds: cfg.tokens.map((t) => t.id),
    })
  })

  // Ingest external events — webhook / API producer surface.
  //
  // Body shape: { type: string, payload: unknown }
  // Gates, in order:
  //   1. Auth token (Authorization: Bearer / X-OpenAlice-Token) against
  //      `data/config/webhook.json` or Guardian's per-boot internal UTA
  //      event token. Empty allowlist + no internal token = 503 default-deny.
  //   2. isExternalEventType OR Guardian's internal UTA token for trade/risk
  //      lifecycle events — prevents ordinary webhook tokens from forging
  //      broker audit history.
  //   3. validateEventPayload — TypeBox schema validation.
  app.post('/ingest', async (c) => {
    const cfg = await readWebhookConfig()
    const presented = extractPresentedToken({
      authorization: c.req.header('authorization') ?? null,
      'x-openalice-token': c.req.header('x-openalice-token') ?? null,
    })
    const auth = checkAuth(cfg, presented, process.env['OPENALICE_INTERNAL_EVENT_TOKEN']
      ? [{ id: 'internal-uta-events', token: process.env['OPENALICE_INTERNAL_EVENT_TOKEN'] }]
      : [])
    const isInternalUtaCaller = auth.kind === 'ok' && auth.tokenId === 'internal-uta-events'
    switch (auth.kind) {
      case 'unconfigured':
        return c.json(
          { error: 'Webhook auth not configured. Add a token in data/config/webhook.json before using this endpoint.' },
          503,
        )
      case 'missing':
        return c.json(
          { error: 'Missing auth token. Send Authorization: Bearer <token> or X-OpenAlice-Token header.' },
          401,
        )
      case 'invalid':
        return c.json({ error: 'Invalid auth token' }, 403)
      case 'ok':
        break
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as { type?: unknown }).type !== 'string'
    ) {
      return c.json({ error: 'Body must be { type: string, payload: ... }' }, 400)
    }

    const { type, payload } = body as { type: string; payload: unknown }

    // Legacy alias: `task.requested` is the pre-AgentWork name for what
    // is now `agent.work.requested { source: 'task' }`. Accept it on
    // the wire and translate to the canonical form so existing external
    // integrations don't break. Memory: "Don't delete our own exports".
    let canonicalType = type
    let canonicalPayload = payload
    if (type === 'task.requested') {
      canonicalType = 'agent.work.requested'
      const p = (payload ?? {}) as { prompt?: string }
      canonicalPayload = { source: 'task', prompt: p.prompt ?? '' }
    }

    if (!isExternalEventType(canonicalType) && !(isInternalUtaCaller && INTERNAL_UTA_EVENT_TYPES.has(canonicalType))) {
      return c.json(
        { error: `Event type '${type}' is not in the external allowlist` },
        403,
      )
    }

    try {
      validateEventPayload(canonicalType, canonicalPayload)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 400)
    }

    const entry = await (
      ingestProducer.emit as unknown as (
        t: string,
        p: unknown,
      ) => Promise<{ seq: number; ts: number; type: string; payload: unknown }>
    )(canonicalType, canonicalPayload)
    return c.json(entry, 201)
  })

  // Paginated query from disk (full history)
  app.get('/', async (c) => {
    const page = Number(c.req.query('page')) || 1
    const pageSize = Number(c.req.query('pageSize')) || 100
    const type = c.req.query('type') || undefined
    const result = await ctx.eventLog.query({ page, pageSize, type })
    return c.json(result)
  })

  // Fast in-memory query (ring buffer)
  app.get('/recent', (c) => {
    const afterSeq = Number(c.req.query('afterSeq')) || 0
    const limit = Number(c.req.query('limit')) || 100
    const type = c.req.query('type') || undefined
    const entries = ctx.eventLog.recent({ afterSeq, limit, type })
    return c.json({ entries, lastSeq: ctx.eventLog.lastSeq() })
  })

  app.get('/stream', (c) => {
    return streamSSE(c, async (stream) => {
      const unsub = ctx.eventLog.subscribe((entry) => {
        stream.writeSSE({ data: JSON.stringify(entry) }).catch(() => {})
      })

      const pingInterval = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '' }).catch(() => {})
      }, 30_000)

      stream.onAbort(() => {
        clearInterval(pingInterval)
        unsub()
      })

      await new Promise<void>(() => {})
    })
  })

  return app
}
