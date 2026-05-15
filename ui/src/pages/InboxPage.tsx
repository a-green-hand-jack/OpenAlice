import { useEffect, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { MarkdownContent } from '../components/MarkdownContent'
import { inboxLive } from '../live/inbox'
import { useInboxRead } from '../live/inbox-read'
import { useInboxSelection } from '../live/inbox-selection'
import { readWorkspaceFile, type ReadFileResult } from '../components/workspace/api'
import type { InboxEntry, InboxKind, InboxDoc } from '../api/inbox'

const KIND_COLORS: Record<InboxKind, string> = {
  status: 'bg-accent/15 text-accent',
  done: 'bg-green/15 text-green',
  blocked: 'bg-red/15 text-red',
  question: 'bg-amber-500/15 text-amber-400',
}

const KIND_LABELS: Record<InboxKind, string> = {
  status: 'Status',
  done: 'Done',
  blocked: 'Blocked',
  question: 'Question',
}

interface InboxPageProps {
  visible: boolean
}

/**
 * Inbox detail pane. Renders the selected entry's docs (live from
 * workspace) on top, comments (agent's markdown body) below — fixed
 * order, mirroring Linear's issue-body + activity layout.
 *
 * Selection is owned by `useInboxSelection`; the sidebar drives it.
 */
export function InboxPage({ visible }: InboxPageProps) {
  const entries = inboxLive.useStore((s) => s.entries)
  const loading = inboxLive.useStore((s) => s.loading)
  const selectedId = useInboxSelection((s) => s.selectedEntryId)
  const markAllRead = useInboxRead((s) => s.markAllRead)
  const lastSeen = useInboxRead((s) => s.lastSeenTs)

  useEffect(() => {
    if (visible && entries.length > 0) markAllRead()
  }, [visible, entries.length, markAllRead])

  const selected = entries.find((e) => e.id === selectedId) ?? null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title="Inbox"
        description={`${entries.length} total · workspace status updates`}
      />
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && entries.length === 0 ? (
          <div className="px-6 py-8 text-text-muted text-sm">Loading…</div>
        ) : entries.length === 0 ? (
          <EmptyState />
        ) : !selected ? (
          <div className="px-6 py-8 text-text-muted text-sm">
            Select an entry from the sidebar.
          </div>
        ) : (
          <Detail entry={selected} unread={selected.ts > lastSeen} />
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="px-6 py-16 text-center max-w-[520px] mx-auto">
      <div className="text-[15px] text-text mb-2">No inbox messages yet</div>
      <p className="text-[13px] text-text-muted leading-relaxed">
        Workspaces will push status updates here as they work — finished
        analysis, blocked tasks, questions back to you. The integration
        path is still being designed; for now you can seed entries via
        <code className="mx-1 px-1 py-0.5 rounded bg-bg-tertiary text-[11px]">POST /api/inbox/seed</code>
        for testing.
      </p>
    </div>
  )
}

function Detail({ entry, unread }: { entry: InboxEntry; unread: boolean }) {
  const hasDocs = (entry.docs?.length ?? 0) > 0
  const hasComments = (entry.comments ?? '').trim().length > 0

  return (
    <div className="max-w-[820px] mx-auto py-6 px-4 md:px-8">
      {/* Header: workspace · kind · timestamp */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="text-[14px] font-medium text-text">
          {entry.workspaceLabel ?? entry.workspaceId}
        </span>
        {entry.kind && (
          <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${KIND_COLORS[entry.kind]}`}>
            {KIND_LABELS[entry.kind]}
          </span>
        )}
        {unread && (
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent/15 text-accent">
            New
          </span>
        )}
        <span className="text-[11px] text-text-muted/70 tabular-nums ml-auto">
          {formatAbsolute(entry.ts)}
          <span className="mx-1.5 text-text-muted/40">·</span>
          {formatRelative(entry.ts)}
        </span>
      </div>

      {/* Docs — top, live render from workspace */}
      {hasDocs && (
        <div className="space-y-6">
          {entry.docs!.map((doc) => (
            <DocBlock key={doc.path} workspaceId={entry.workspaceId} doc={doc} />
          ))}
        </div>
      )}

      {/* Comments — bottom, agent's voice */}
      {hasComments && (
        <div className={`${hasDocs ? 'mt-8 pt-6 border-t border-border' : ''}`}>
          <div className="text-[11px] font-medium text-text-muted/60 uppercase tracking-wider mb-3">
            Comments
          </div>
          <MarkdownContent text={entry.comments!} />
        </div>
      )}

      <div className="mt-8 pt-4 border-t border-border/50 text-[12px] text-text-muted/60 font-mono">
        workspace: {entry.workspaceId}
      </div>
    </div>
  )
}

// ==================== Doc block (live fetch from workspace) ====================

function DocBlock({ workspaceId, doc }: { workspaceId: string; doc: InboxDoc }) {
  const [result, setResult] = useState<ReadFileResult | null>(null)

  useEffect(() => {
    let cancelled = false
    setResult(null)
    readWorkspaceFile(workspaceId, doc.path).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => { cancelled = true }
  }, [workspaceId, doc.path])

  return (
    <div className="rounded-lg border border-border bg-bg/50">
      <div className="px-4 py-2 border-b border-border/50 flex items-center gap-2">
        <span className="text-[11px] text-text-muted/70">📄</span>
        <span className="text-[12px] font-mono text-text-muted">{doc.path}</span>
      </div>
      <div className="px-4 py-3">
        {result === null ? (
          <div className="text-[12px] text-text-muted">Loading…</div>
        ) : result.kind === 'ok' ? (
          <DocContent path={doc.path} content={result.content} />
        ) : (
          <DocTombstone result={result} />
        )}
      </div>
    </div>
  )
}

function DocContent({ path, content }: { path: string; content: string }) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return <MarkdownContent text={content} />
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    // DOMPurify sanitisation is inside MarkdownContent; for raw HTML we
    // run it through the markdown renderer too — marked passes HTML
    // through, then DOMPurify sanitises before insertion.
    return <MarkdownContent text={content} />
  }
  // Plain-text fallback (.txt, .log, no extension, code files…)
  return (
    <pre className="text-[12px] text-text whitespace-pre-wrap font-mono leading-relaxed">
      {content}
    </pre>
  )
}

function DocTombstone({ result }: { result: ReadFileResult }) {
  const message = (() => {
    switch (result.kind) {
      case 'workspace_missing':
        return 'Workspace no longer exists — it may have been deleted.'
      case 'file_missing':
        return 'File not found at this path — it may have been moved, renamed, or deleted in the workspace since this notification was sent.'
      case 'too_large':
        return `File too large to render in inbox (${(result.sizeBytes / 1024).toFixed(0)} KB). Open the workspace to view.`
      case 'invalid_path':
        return 'Invalid path.'
      case 'error':
        return `Could not read file: ${result.message}`
      case 'ok':
        return ''
    }
  })()
  return (
    <div className="text-[12px] text-text-muted italic">
      {message}
    </div>
  )
}

// ==================== Date formatting ====================

function formatAbsolute(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}
