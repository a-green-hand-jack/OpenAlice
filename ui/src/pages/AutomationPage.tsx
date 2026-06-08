import { useState, useEffect, useCallback } from 'react'
import { formatRelativeTime, getIntlLocale } from '../lib/intl'
import { api, type CronJob, type CronSchedule } from '../api'
import { Toggle } from '../components/Toggle'
import { PageHeader } from '../components/PageHeader'
import { AutomationFlowSection } from './AutomationFlowSection'
import { AutomationWebhookSection } from './AutomationWebhookSection'
import { listWorkspaces, type Workspace } from '../components/workspace/api'
import { AutomationRunsSection } from './AutomationRunsSection'
import type { ViewSpec } from '../tabs/types'

type AutomationSection = Extract<ViewSpec, { kind: 'automation' }>['params']['section']

const SECTION_TITLE: Record<AutomationSection, string> = {
  flow: 'Flow',
  cron: 'Cron Jobs',
  webhook: 'Webhook',
  runs: 'Runs',
}

const SECTION_DESCRIPTION: Record<AutomationSection, string> = {
  flow: 'Producer-listener graph for the event bus.',
  cron: 'Scheduled jobs that fire events on the dispatch bus.',
  webhook: 'External HTTP triggers routed into the engine.',
  runs: 'Headless agent runs across workspaces — what the workers are doing.',
}

// ==================== Helpers ====================

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const date = d.toLocaleDateString(getIntlLocale(), { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(getIntlLocale(), { hour12: false })
  return `${date} ${time}`
}


function scheduleLabel(s: CronSchedule): string {
  switch (s.kind) {
    case 'at': return `at ${s.at}`
    case 'every': return `every ${s.every}`
    case 'cron': return `cron: ${s.cron}`
  }
}

// ==================== Cron Section ====================

function CronSection() {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)

  const loadJobs = useCallback(async () => {
    try {
      const { jobs } = await api.cron.list()
      setJobs(jobs)
    } catch (err) {
      console.warn('Failed to load cron jobs:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadJobs() }, [loadJobs])

  // Refresh periodically to update next-run times
  useEffect(() => {
    const id = setInterval(loadJobs, 15_000)
    return () => clearInterval(id)
  }, [loadJobs])

  const [error, setError] = useState<string | null>(null)

  const showError = (msg: string) => {
    setError(msg)
    setTimeout(() => setError(null), 3000)
  }

  const handleToggle = async (job: CronJob) => {
    try {
      await api.cron.update(job.id, { enabled: !job.enabled })
      await loadJobs()
    } catch {
      showError('Failed to toggle job')
    }
  }

  const handleRunNow = async (job: CronJob) => {
    try {
      await api.cron.runNow(job.id)
      await loadJobs()
    } catch {
      showError('Failed to run job')
    }
  }

  const handleDelete = async (job: CronJob) => {
    if (job.name === '__heartbeat__') return
    try {
      await api.cron.remove(job.id)
      await loadJobs()
    } catch {
      showError('Failed to delete job')
    }
  }

  if (loading) {
    return <div className="text-text-muted text-sm py-4">Loading cron jobs...</div>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-border/50 bg-bg-secondary/50 px-4 py-3">
        <p className="text-[13px] text-text-muted leading-relaxed">
          On schedule, a cron job runs its payload as a prompt inside the workspace
          you pick — headless. The workspace agent runs it and reports back via the
          Inbox; the run shows up live in the Runs tab. Use them for periodic checks,
          reports, or any recurring task.
        </p>
      </div>
      {error && <div className="text-xs text-red">{error}</div>}
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">{jobs.length} jobs</span>
        <button
          onClick={() => setShowAdd(true)}
          className="btn-secondary-sm"
        >
          + Add Job
        </button>
      </div>

      {showAdd && (
        <AddCronJobForm
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); loadJobs() }}
        />
      )}

      {jobs.length === 0 ? (
        <div className="text-text-muted text-sm text-center py-6">No cron jobs</div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <CronJobCard
              key={job.id}
              job={job}
              onToggle={() => handleToggle(job)}
              onRunNow={() => handleRunNow(job)}
              onDelete={() => handleDelete(job)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CronJobCard({ job, onToggle, onRunNow, onDelete }: {
  job: CronJob
  onToggle: () => void
  onRunNow: () => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isHeartbeat = job.name === '__heartbeat__'

  return (
    <div className={`rounded-lg border ${job.enabled ? 'border-border' : 'border-border/50 opacity-60'} bg-bg`}>
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Toggle */}
        <Toggle size="sm" checked={job.enabled} onChange={() => onToggle()} />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${isHeartbeat ? 'text-purple' : 'text-text'}`}>
              {isHeartbeat ? '💓 heartbeat' : job.name}
            </span>
            <span className="text-xs text-text-muted">{job.id}</span>
            {job.state.lastStatus === 'error' && (
              <span className="text-xs text-red">
                {job.state.consecutiveErrors}x err
              </span>
            )}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {scheduleLabel(job.schedule)}
            {job.state.nextRunAtMs && (
              <span className="ml-2">• next: {formatDateTime(job.state.nextRunAtMs)}</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onRunNow}
            title="Run now"
            className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-bg-tertiary transition-colors text-xs"
          >
            ▶
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            title="Details"
            className="p-1.5 rounded text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors text-xs"
          >
            {expanded ? '▾' : '▸'}
          </button>
          {!isHeartbeat && (
            <button
              onClick={onDelete}
              title="Delete"
              className="p-1.5 rounded text-text-muted hover:text-red hover:bg-bg-tertiary transition-colors text-xs"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/50 px-4 py-3 text-xs space-y-2">
          <div>
            <span className="text-text-muted">Runs in: </span>
            {job.workspaceId ? (
              <span className="text-text font-mono">
                {job.workspaceId}{job.agent ? ` · ${job.agent}` : ' · default agent'}
              </span>
            ) : (
              <span className="text-red">no workspace — won't run (assign one)</span>
            )}
          </div>
          <div>
            <span className="text-text-muted">Payload: </span>
            <pre className="inline text-text whitespace-pre-wrap break-all">{job.payload}</pre>
          </div>
          <div className="flex gap-4 text-text-muted">
            <span>Last run: {job.state.lastRunAtMs ? `${formatRelativeTime(job.state.lastRunAtMs)} (${formatDateTime(job.state.lastRunAtMs)})` : 'never'}</span>
            <span>Status: {job.state.lastStatus ?? 'n/a'}</span>
            <span>Created: {formatDateTime(job.createdAt)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function AddCronJobForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [payload, setPayload] = useState('')
  const [schedKind, setSchedKind] = useState<'every' | 'cron' | 'at'>('every')
  const [schedValue, setSchedValue] = useState('1h')
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [agent, setAgent] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void listWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([]))
  }, [])

  // Agent options follow the picked workspace's enabled adapters.
  const agentOptions = workspaces.find((w) => w.id === workspaceId)?.agents ?? []

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !payload.trim()) {
      setError('Name and payload are required')
      return
    }
    if (!workspaceId) {
      setError('Pick the workspace this job runs in')
      return
    }

    let schedule: CronSchedule
    if (schedKind === 'every') schedule = { kind: 'every', every: schedValue }
    else if (schedKind === 'cron') schedule = { kind: 'cron', cron: schedValue }
    else schedule = { kind: 'at', at: schedValue }

    setSaving(true)
    setError('')
    try {
      await api.cron.add({
        name: name.trim(),
        payload: payload.trim(),
        schedule,
        workspaceId,
        ...(agent ? { agent } : {}),
      })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-bg rounded-lg border border-accent/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text">New Cron Job</span>
        <button type="button" onClick={onClose} className="text-text-muted hover:text-text text-xs">✕</button>
      </div>

      <input
        type="text"
        placeholder="Job name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent"
      />

      {/* Where the job runs — a workspace + one of its enabled agents, headless. */}
      <div className="flex gap-2">
        <select
          value={workspaceId}
          onChange={(e) => { setWorkspaceId(e.target.value); setAgent('') }}
          className="flex-1 bg-bg-tertiary border border-border rounded-md px-2 py-2 text-sm text-text outline-none focus:border-accent"
        >
          <option value="">
            {workspaces.length === 0 ? '— no workspaces —' : '— run in workspace… —'}
          </option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.tag}</option>
          ))}
        </select>
        <select
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          disabled={!workspaceId}
          className="bg-bg-tertiary border border-border rounded-md px-2 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-40"
        >
          <option value="">{workspaceId ? 'default agent' : 'agent'}</option>
          {agentOptions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      <textarea
        placeholder="Payload / instruction text"
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        rows={2}
        className="w-full bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent resize-none"
      />

      <div className="flex gap-2">
        <select
          value={schedKind}
          onChange={(e) => {
            const k = e.target.value as 'every' | 'cron' | 'at'
            setSchedKind(k)
            if (k === 'every') setSchedValue('1h')
            else if (k === 'cron') setSchedValue('0 9 * * 1-5')
            else setSchedValue(new Date(Date.now() + 3600_000).toISOString())
          }}
          className="bg-bg-tertiary border border-border rounded-md px-2 py-2 text-sm text-text outline-none focus:border-accent"
        >
          <option value="every">Every</option>
          <option value="cron">Cron</option>
          <option value="at">At (one-shot)</option>
        </select>

        <input
          type="text"
          value={schedValue}
          onChange={(e) => setSchedValue(e.target.value)}
          placeholder={schedKind === 'every' ? '1h' : schedKind === 'cron' ? '0 9 * * 1-5' : 'ISO timestamp'}
          className="flex-1 bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent font-mono"
        />
      </div>

      {error && <div className="text-xs text-red">{error}</div>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-sm rounded-md text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="btn-primary-sm"
        >
          {saving ? 'Creating...' : 'Create'}
        </button>
      </div>
    </form>
  )
}

// ==================== Page ====================

interface AutomationPageProps {
  spec: Extract<ViewSpec, { kind: 'automation' }>
}

/**
 * Automation page is sub-section-driven — `spec.params.section` picks which
 * surface renders. The Automation sidebar holds one row per section so each
 * section is its own tab in the editor area.
 */
export function AutomationPage({ spec }: AutomationPageProps) {
  const section = spec.params.section

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title={SECTION_TITLE[section]}
        description={SECTION_DESCRIPTION[section]}
      />
      <div className="flex-1 flex flex-col min-h-0 px-4 md:px-6 py-5">
        <div className="flex-1 min-h-0">
          {section === 'flow' ? (
            <AutomationFlowSection />
          ) : section === 'cron' ? (
            <CronSection />
          ) : section === 'webhook' ? (
            <AutomationWebhookSection />
          ) : (
            <AutomationRunsSection />
          )}
        </div>
      </div>
    </div>
  )
}
