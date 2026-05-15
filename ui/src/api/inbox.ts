import { fetchJson } from './client'

export type InboxKind = 'status' | 'done' | 'blocked' | 'question'

export interface InboxDoc {
  path: string
}

export interface InboxEntry {
  id: string
  ts: number
  workspaceId: string
  workspaceLabel?: string
  /** Pointers to workspace files. Rendered live (no snapshot). */
  docs?: InboxDoc[]
  /** Agent's message body (markdown). Renders below docs. */
  comments?: string
  kind?: InboxKind
}

export interface InboxHistoryResponse {
  entries: InboxEntry[]
  hasMore: boolean
}

export interface InboxSeedBody {
  workspaceId: string
  workspaceLabel?: string
  docs?: InboxDoc[]
  comments?: string
  kind?: InboxKind
}

export const inboxApi = {
  async history(
    opts: { limit?: number; before?: string; workspaceId?: string } = {},
  ): Promise<InboxHistoryResponse> {
    const qs = new URLSearchParams()
    if (opts.limit != null) qs.set('limit', String(opts.limit))
    if (opts.before) qs.set('before', opts.before)
    if (opts.workspaceId) qs.set('workspaceId', opts.workspaceId)
    return fetchJson(`/api/inbox/history?${qs}`)
  },

  /** Dev-only — append an inbox entry. */
  async seed(body: InboxSeedBody): Promise<{ entry: InboxEntry }> {
    return fetchJson('/api/inbox/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },
}
