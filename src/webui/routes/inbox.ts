/**
 * Inbox HTTP route — read history + dev-only seed.
 *
 *   GET  /history?limit=&before=&workspaceId=   paginated, newest-first
 *   POST /seed                                  dev-only: append an entry
 *
 * UI polls /history every 20s. Production write path is still deliberately
 * deferred — only /seed exists until the workspace integration pathway
 * (MCP tool + workspace identity) is decided.
 */
import { Hono } from 'hono'
import type { IInboxStore, InboxKind, InboxDoc } from '../../core/inbox-store.js'

const VALID_KINDS: ReadonlySet<InboxKind> = new Set(['status', 'done', 'blocked', 'question'])

export interface InboxRoutesDeps {
  inboxStore: IInboxStore
}

export function createInboxRoutes(deps: InboxRoutesDeps) {
  const app = new Hono()

  app.get('/history', async (c) => {
    const limit = Number(c.req.query('limit')) || 100
    const before = c.req.query('before') || undefined
    const workspaceId = c.req.query('workspaceId') || undefined
    const result = await deps.inboxStore.read({ limit, before, workspaceId })
    return c.json(result)
  })

  app.post('/seed', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid json' }, 400)
    }
    const b = body as Partial<{
      workspaceId: string
      workspaceLabel: string
      docs: unknown
      comments: string
      kind: string
    }>
    if (!b.workspaceId || typeof b.workspaceId !== 'string') {
      return c.json({ error: 'workspaceId required' }, 400)
    }

    // Validate docs shape if present
    let docs: InboxDoc[] | undefined
    if (b.docs !== undefined) {
      if (!Array.isArray(b.docs)) {
        return c.json({ error: 'docs must be an array' }, 400)
      }
      docs = []
      for (const d of b.docs) {
        if (typeof d !== 'object' || d === null) {
          return c.json({ error: 'each doc must be an object' }, 400)
        }
        const path = (d as { path?: unknown }).path
        if (typeof path !== 'string' || !path) {
          return c.json({ error: 'each doc must have a non-empty `path` string' }, 400)
        }
        docs.push({ path })
      }
    }

    const comments = typeof b.comments === 'string' ? b.comments : undefined
    const kind = b.kind && VALID_KINDS.has(b.kind as InboxKind) ? (b.kind as InboxKind) : undefined

    try {
      const entry = await deps.inboxStore.append({
        workspaceId: b.workspaceId,
        workspaceLabel: typeof b.workspaceLabel === 'string' ? b.workspaceLabel : undefined,
        docs,
        comments,
        kind,
      })
      return c.json({ entry })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  return app
}
