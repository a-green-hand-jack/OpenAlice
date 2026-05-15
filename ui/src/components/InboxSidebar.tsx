import { useEffect, useMemo, useRef } from 'react'
import { inboxLive } from '../live/inbox'
import { useInboxRead } from '../live/inbox-read'
import { useInboxSelection } from '../live/inbox-selection'
import type { InboxEntry, InboxKind } from '../api/inbox'

const KIND_DOT: Record<InboxKind, string> = {
  status: 'bg-accent',
  done: 'bg-green',
  blocked: 'bg-red',
  question: 'bg-amber-400',
}

/**
 * Inbox sidebar list. Linear-style:
 * - Date-grouped (Today / Yesterday / This week / Older), newest-first
 * - Each row: workspace label · relative time · text preview · unread state
 * - j/k keyboard navigation; Enter opens (no-op here, page is already
 *   rendering the selected detail)
 * - Default-selects the newest entry on first load if none is selected.
 *
 * Selection state lives in `useInboxSelection` so it survives sidebar
 * remounts and is read by the detail page in the editor area.
 */
export function InboxSidebar() {
  const entries = inboxLive.useStore((s) => s.entries)
  const loading = inboxLive.useStore((s) => s.loading)
  const selectedId = useInboxSelection((s) => s.selectedEntryId)
  const select = useInboxSelection((s) => s.select)
  const lastSeen = useInboxRead((s) => s.lastSeenTs)

  // Default-select latest on first non-empty load. Latch on selectedId
  // existing — once the user touches anything, never override.
  const everSelectedRef = useRef(false)
  useEffect(() => {
    if (everSelectedRef.current) return
    if (entries.length === 0) return
    if (!selectedId) {
      select(entries[0].id)
    }
    everSelectedRef.current = true
  }, [entries, selectedId, select])

  // Keyboard nav — j/k move within the flat newest-first sequence.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== 'j' && e.key !== 'k') return
      if (entries.length === 0) return
      const idx = entries.findIndex((x) => x.id === selectedId)
      const next = e.key === 'j' ? Math.min(entries.length - 1, idx + 1) : Math.max(0, idx - 1)
      if (next !== idx && entries[next]) select(entries[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [entries, selectedId, select])

  const groups = useMemo(() => groupByBucket(entries), [entries])

  if (loading && entries.length === 0) {
    return <div className="px-3 py-3 text-[12px] text-text-muted">Loading…</div>
  }

  if (entries.length === 0) {
    return (
      <div className="px-3 py-4 text-[12px] text-text-muted/70 leading-relaxed">
        No inbox messages.
        <div className="mt-1 text-text-muted/50">
          Workspaces will push status updates here.
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto py-0.5">
      {groups.map(([bucket, items]) => (
        <div key={bucket} className="mb-1">
          <div className="px-3 mt-2 mb-1 text-[10px] font-medium text-text-muted/60 uppercase tracking-wider">
            {bucket}
          </div>
          <div className="flex flex-col">
            {items.map((entry) => (
              <InboxRow
                key={entry.id}
                entry={entry}
                active={entry.id === selectedId}
                unread={entry.ts > lastSeen}
                onClick={() => select(entry.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function InboxRow({
  entry, active, unread, onClick,
}: {
  entry: InboxEntry
  active: boolean
  unread: boolean
  onClick: () => void
}) {
  const dotColor = entry.kind ? KIND_DOT[entry.kind] : 'bg-text-muted/30'
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={`group relative flex flex-col gap-0.5 px-3 py-2 cursor-pointer transition-colors outline-none focus-visible:bg-bg-tertiary/70 ${
        active ? 'bg-bg-tertiary' : 'hover:bg-bg-tertiary/50'
      }`}
    >
      {active && (
        <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent" />
      )}

      {/* Line 1: dot · workspace · time */}
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={`shrink-0 w-1.5 h-1.5 rounded-full ${unread ? dotColor : 'bg-transparent border border-text-muted/30'}`}
        />
        <span className={`flex-1 truncate text-[12px] ${unread ? 'font-medium text-text' : 'text-text'}`}>
          {entry.workspaceLabel ?? entry.workspaceId}
        </span>
        <span className="shrink-0 text-[10px] text-text-muted/60 tabular-nums">
          {formatRelative(entry.ts)}
        </span>
      </div>

      {/* Line 2: preview — comments first line if present, else docs[0].path */}
      <div className={`pl-3 text-[11px] truncate ${unread ? 'text-text-muted' : 'text-text-muted/70'}`}>
        {previewFor(entry)}
      </div>
    </div>
  )
}

// ==================== Preview ====================

/** Build the second-line preview text for a sidebar row.
 *  - If the entry has comments, use its first non-empty line (strip
 *    markdown markers minimally — `#`, `>`, `*`, `-` leaders).
 *  - Otherwise fall back to the first doc's path.
 *  - Otherwise empty (shouldn't happen — store rejects empty entries).
 */
function previewFor(entry: InboxEntry): string {
  const c = (entry.comments ?? '').trim()
  if (c) {
    const firstLine = c.split('\n').find((l) => l.trim().length > 0) ?? ''
    return firstLine.replace(/^[#>*\-]+\s*/, '').trim()
  }
  if (entry.docs && entry.docs.length > 0) {
    const d = entry.docs[0]
    if (d) {
      const suffix = entry.docs.length > 1 ? ` · +${entry.docs.length - 1} more` : ''
      return `📄 ${d.path}${suffix}`
    }
  }
  return ''
}

// ==================== Grouping ====================

type Bucket = 'Today' | 'Yesterday' | 'This week' | 'Older'

function groupByBucket(entries: readonly InboxEntry[]): Array<[Bucket, InboxEntry[]]> {
  const now = Date.now()
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const today = startOfDay.getTime()
  const yesterday = today - 86_400_000
  const weekStart = today - 6 * 86_400_000

  const buckets: Record<Bucket, InboxEntry[]> = {
    Today: [],
    Yesterday: [],
    'This week': [],
    Older: [],
  }

  for (const e of entries) {
    if (e.ts >= today) buckets.Today.push(e)
    else if (e.ts >= yesterday) buckets.Yesterday.push(e)
    else if (e.ts >= weekStart) buckets['This week'].push(e)
    else buckets.Older.push(e)
  }

  const order: Bucket[] = ['Today', 'Yesterday', 'This week', 'Older']
  return order
    .map((b): [Bucket, InboxEntry[]] => [b, buckets[b]])
    .filter(([, items]) => items.length > 0)
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}
