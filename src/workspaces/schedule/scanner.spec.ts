import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Schedule } from '../../core/schedule-expr.js'
import type { CliAdapter } from '../cli-adapter.js'
import type { Logger } from '../logger.js'
import type { WorkspaceMeta, WorkspaceRegistry } from '../workspace-registry.js'

import { ScheduleScanner, type MarkerStore } from './scanner.js'

const NOW = 1_700_000_000_000 // realistic epoch ms — `every` is relative-from-0, so first-sight needs a large clock

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  event() {},
  child() {
    return noopLogger
  },
} as unknown as Logger

class FakeMarkers implements MarkerStore {
  private m = new Map<string, number>()
  pruned: Set<string> | null = null
  key(w: string, t: string): string {
    return `${w} ${t}`
  }
  get(w: string, t: string): number | undefined {
    return this.m.get(this.key(w, t))
  }
  async set(w: string, t: string, ts: number): Promise<void> {
    this.m.set(this.key(w, t), ts)
  }
  async prune(seen: Set<string>): Promise<void> {
    this.pruned = seen
    for (const k of [...this.m.keys()]) if (!seen.has(k)) this.m.delete(k)
  }
}

const headlessAdapter = {
  id: 'claude',
  capabilities: { headless: true },
  composeHeadlessCommand: () => [],
} as unknown as CliAdapter

const nonHeadlessAdapter = {
  id: 'shell',
  capabilities: { headless: false },
} as unknown as CliAdapter

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sched-scan-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

interface IssueSpec {
  id: string
  title: string
  when?: Schedule
  what?: string
  status?: string
  priority?: string
  agent?: string
  kind?: 'headless' | 'steward-wake'
  accountId?: string
  authzLevel?: string
  expectedDecision?: string
  wakeReason?: string
  deadlineMs?: number
  body?: string
}

/** Serialize one issue spec to its `.alice/issues/<id>.md` frontmatter form. */
function issueMd(spec: IssueSpec): string {
  const lines = [`title: ${spec.title}`]
  if (spec.status) lines.push(`status: ${spec.status}`)
  if (spec.priority) lines.push(`priority: ${spec.priority}`)
  if (spec.what) lines.push(`what: ${spec.what}`)
  if (spec.agent) lines.push(`agent: ${spec.agent}`)
  if (spec.kind) lines.push(`kind: ${spec.kind}`)
  if (spec.accountId) lines.push(`accountId: ${spec.accountId}`)
  if (spec.authzLevel) lines.push(`authzLevel: ${spec.authzLevel}`)
  if (spec.expectedDecision) lines.push(`expectedDecision: ${spec.expectedDecision}`)
  if (spec.wakeReason) lines.push(`wakeReason: ${spec.wakeReason}`)
  if (spec.deadlineMs) lines.push(`deadlineMs: ${spec.deadlineMs}`)
  if (spec.when) {
    const w = spec.when
    const inner =
      w.kind === 'at'
        ? `kind: at, at: "${w.at}"`
        : w.kind === 'every'
          ? `kind: every, every: "${w.every}"`
          : `kind: cron, cron: "${w.cron}"`
    lines.push(`when: { ${inner} }`)
  }
  return `---\n${lines.join('\n')}\n---\n${spec.body ?? ''}`
}

async function makeWs(id: string, issues: IssueSpec[]): Promise<WorkspaceMeta> {
  const dir = join(root, id)
  const issuesDir = join(dir, '.alice', 'issues')
  await mkdir(issuesDir, { recursive: true })
  for (const issue of issues) {
    await writeFile(join(issuesDir, `${issue.id}.md`), issueMd(issue), 'utf8')
  }
  return { id, tag: id, dir, createdAt: new Date(NOW).toISOString(), agents: ['claude'] }
}

function scannerFor(
  workspaces: WorkspaceMeta[],
  opts: {
    dispatch?: (
      m: WorkspaceMeta,
      a: CliAdapter,
      p: string,
      t: number,
      issueId?: string,
    ) => Promise<{ taskId: string }>
    markers?: MarkerStore
    now?: number
    adapter?: CliAdapter
    dispatchStewardWake?: any
  } = {},
) {
  const dispatch = opts.dispatch ?? vi.fn(async () => ({ taskId: 'run-1' }))
  const markers = opts.markers ?? new FakeMarkers()
  const scanner = new ScheduleScanner({
    registry: { list: () => workspaces } as unknown as WorkspaceRegistry,
    resolveAdapter: () => opts.adapter ?? headlessAdapter,
    dispatch,
    ...(opts.dispatchStewardWake ? { dispatchStewardWake: opts.dispatchStewardWake } : {}),
    markers,
    logger: noopLogger,
    now: () => opts.now ?? NOW,
  })
  return { scanner, dispatch, markers }
}

describe('ScheduleScanner', () => {
  it('fires a scheduled (every) issue on first sight and records the marker after dispatch', async () => {
    const ws = await makeWs('w1', [{ id: 't1', title: 'i1', when: { kind: 'every', every: '30m' }, what: 'go' }])
    const { scanner, dispatch, markers } = scannerFor([ws])
    await scanner.scan()
    expect(dispatch).toHaveBeenCalledTimes(1)
    // 5th arg = the firing issue's id, threaded so the run records its origin.
    expect(dispatch).toHaveBeenCalledWith(ws, headlessAdapter, 'go', expect.any(Number), 't1')
    expect(markers.get('w1', 't1')).toBe(NOW)
  })

  it('ignores an UNSCHEDULED issue (no when): never fires, never in the snapshot', async () => {
    const ws = await makeWs('w1', [{ id: 'work', title: 'a tracked work item' }])
    const { scanner, dispatch } = scannerFor([ws])
    await scanner.scan()
    expect(dispatch).not.toHaveBeenCalled()
    const w = scanner.snapshot()!.workspaces[0]
    expect(w.status).toBe('ok')
    expect(w.tasks).toHaveLength(0)
  })

  it('fires scheduled issues but skips unscheduled ones in the same workspace', async () => {
    const ws = await makeWs('w1', [
      { id: 'sched', title: 'scheduled', when: { kind: 'every', every: '30m' }, what: 'go' },
      { id: 'work', title: 'unscheduled work item' },
    ])
    const { scanner, dispatch } = scannerFor([ws])
    await scanner.scan()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(ws, headlessAdapter, 'go', expect.any(Number), 'sched')
    expect(scanner.snapshot()!.workspaces[0].tasks.map((t) => t.id)).toEqual(['sched'])
  })

  it('routes steward-wake scheduled issues through persistent wake dispatch, not headless', async () => {
    const ws = await makeWs('w1', [{
      id: 'steward-aapl',
      title: 'AAPL steward observe',
      when: { kind: 'every', every: '30m' },
      what: 'observe AAPL',
      agent: 'codex',
      kind: 'steward-wake',
      accountId: 'mock-simulator-1',
      authzLevel: 'paper',
      expectedDecision: 'no_trade',
      wakeReason: 'scheduled_observe',
      deadlineMs: 120000,
    }])
    const dispatchStewardWake = vi.fn(async () => ({ wakeId: 'wake-1' }))
    const { scanner, dispatch, markers } = scannerFor([ws], { dispatchStewardWake })

    await scanner.scan()

    expect(dispatch).not.toHaveBeenCalled()
    expect(dispatchStewardWake).toHaveBeenCalledWith(ws, expect.objectContaining({
      issueId: 'steward-aapl',
      wakeId: `${new Date(NOW).toISOString()}:steward-aapl`,
      reason: 'scheduled_observe',
      accountId: 'mock-simulator-1',
      authzLevel: 'paper',
      expectedDecision: 'no_trade',
      humanRequest: 'observe AAPL',
      deadlineMs: 120000,
      agent: 'codex',
      nowMs: NOW,
    }))
    expect(markers.get('w1', 'steward-aapl')).toBe(NOW)
  })

  it('wide-reads legacy propose_trade frontmatter as propose_change without rewriting the issue file', async () => {
    const ws = await makeWs('w1', [{
      id: 'legacy-steward',
      title: 'legacy steward observe',
      when: { kind: 'every', every: '30m' },
      kind: 'steward-wake',
      accountId: 'mock-simulator-1',
      authzLevel: 'paper',
      expectedDecision: 'propose_trade',
    }])
    const path = join(ws.dir, '.alice/issues/legacy-steward.md')
    const before = await readFile(path, 'utf8')
    const dispatchStewardWake = vi.fn(async () => ({ wakeId: 'wake-legacy' }))
    const { scanner } = scannerFor([ws], { dispatchStewardWake })

    await scanner.scan()

    expect(dispatchStewardWake).toHaveBeenCalledWith(ws, expect.objectContaining({
      expectedDecision: 'propose_change',
    }))
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(before).toContain('expectedDecision: propose_trade')
  })

  it('falls back to title+body for the fire prompt when `what` is absent', async () => {
    const ws = await makeWs('w1', [
      { id: 't1', title: 'Do research', when: { kind: 'every', every: '30m' }, body: 'scan movers' },
    ])
    const { scanner, dispatch } = scannerFor([ws])
    await scanner.scan()
    expect(dispatch).toHaveBeenCalledWith(ws, headlessAdapter, 'Do research\n\nscan movers', expect.any(Number), 't1')
  })

  it('fires a never-fired cron issue whose occurrence is within the last tick (not never)', async () => {
    // '* * * * *' fires every minute → an occurrence always falls in the last 60s.
    const ws = await makeWs('w1', [{ id: 'c1', title: 'i-cron', when: { kind: 'cron', cron: '* * * * *' }, what: 'tick' }])
    const { scanner, dispatch } = scannerFor([ws])
    await scanner.scan()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('does not fire a never-fired cron whose next occurrence is far in the future', async () => {
    // Jan 1 00:00 — NOW (mid-2023) is nowhere near it.
    const ws = await makeWs('w1', [{ id: 'c1', title: 'i-ny', when: { kind: 'cron', cron: '0 0 1 1 *' }, what: 'ny' }])
    const { scanner, dispatch } = scannerFor([ws])
    await scanner.scan()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not re-fire within the cadence', async () => {
    const ws = await makeWs('w1', [{ id: 't1', title: 'i1', when: { kind: 'every', every: '30m' }, what: 'go' }])
    const markers = new FakeMarkers()
    await markers.set('w1', 't1', NOW)
    const { scanner, dispatch } = scannerFor([ws], { markers, now: NOW + 10 * 60_000 })
    await scanner.scan()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('re-fires once the cadence elapses', async () => {
    const ws = await makeWs('w1', [{ id: 't1', title: 'i1', when: { kind: 'every', every: '30m' }, what: 'go' }])
    const markers = new FakeMarkers()
    await markers.set('w1', 't1', NOW)
    const { scanner, dispatch } = scannerFor([ws], { markers, now: NOW + 31 * 60_000 })
    await scanner.scan()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('skips a terminal-status (canceled) scheduled issue but still tracks it for prune', async () => {
    const ws = await makeWs('w1', [
      { id: 't1', title: 'i1', when: { kind: 'every', every: '1m' }, what: 'go', status: 'canceled' },
    ])
    const { scanner, dispatch, markers } = scannerFor([ws])
    await scanner.scan()
    expect(dispatch).not.toHaveBeenCalled()
    expect((markers as FakeMarkers).pruned?.has(markers.key('w1', 't1'))).toBe(true)
  })

  it('does not mark when dispatch hits capacity (so it retries next tick)', async () => {
    const ws = await makeWs('w1', [{ id: 't1', title: 'i1', when: { kind: 'every', every: '30m' }, what: 'go' }])
    const dispatch = vi.fn(async () => {
      throw new Error('headless capacity reached')
    })
    const { scanner, markers } = scannerFor([ws], { dispatch })
    await scanner.scan()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(markers.get('w1', 't1')).toBeUndefined()
  })

  it('skips an issue whose resolved adapter has no headless mode', async () => {
    const ws = await makeWs('w1', [{ id: 't1', title: 'i1', when: { kind: 'every', every: '30m' }, what: 'go' }])
    const { scanner, dispatch, markers } = scannerFor([ws], { adapter: nonHeadlessAdapter })
    await scanner.scan()
    expect(dispatch).not.toHaveBeenCalled()
    expect(markers.get('w1', 't1')).toBeUndefined()
  })

  it('ignores a workspace with no issues dir', async () => {
    const dir = join(root, 'empty')
    await mkdir(dir, { recursive: true })
    const ws: WorkspaceMeta = { id: 'empty', tag: 'empty', dir, createdAt: new Date(NOW).toISOString(), agents: ['claude'] }
    const { scanner, dispatch } = scannerFor([ws])
    await scanner.scan()
    expect(dispatch).not.toHaveBeenCalled()
    expect(scanner.snapshot()!.workspaces[0].status).toBe('absent')
  })

  it('marks a workspace invalid (loud hint) when only the legacy issue.json exists', async () => {
    const dir = join(root, 'legacy')
    await mkdir(join(dir, '.alice'), { recursive: true })
    await writeFile(join(dir, '.alice', 'issue.json'), JSON.stringify({ issues: [] }), 'utf8')
    const ws: WorkspaceMeta = { id: 'legacy', tag: 'legacy', dir, createdAt: new Date(NOW).toISOString(), agents: ['claude'] }
    const { scanner, dispatch } = scannerFor([ws])
    await scanner.scan()
    expect(dispatch).not.toHaveBeenCalled()
    const w = scanner.snapshot()!.workspaces[0]
    expect(w.status).toBe('invalid')
    expect(w.error).toContain('.alice/issue.json')
  })

  it('isolates a single invalid issue file: the workspace stays ok and good issues still fire', async () => {
    const ws = await makeWs('w1', [{ id: 'good', title: 'good', when: { kind: 'every', every: '30m' }, what: 'go' }])
    // Drop an unparseable file alongside the good one.
    await writeFile(join(ws.dir, '.alice', 'issues', 'broken.md'), '---\ntitle: : :\n  - x\n---\n', 'utf8')
    const { scanner, dispatch } = scannerFor([ws])
    await scanner.scan()
    expect(dispatch).toHaveBeenCalledTimes(1)
    const w = scanner.snapshot()!.workspaces[0]
    expect(w.status).toBe('ok')
    expect(w.tasks.map((t) => t.id)).toEqual(['good'])
  })

  it('caches a snapshot of scheduled issues (incl. terminal) after a scan', async () => {
    const ws = await makeWs('w1', [
      { id: 't1', title: 'i1', when: { kind: 'every', every: '30m' }, what: 'go' },
      { id: 't2', title: 'i2', when: { kind: 'every', every: '30m' }, what: 'stop', status: 'done' },
    ])
    const { scanner } = scannerFor([ws])
    expect(scanner.snapshot()).toBeNull() // cold before the first scan
    await scanner.scan()
    const snap = scanner.snapshot()
    expect(snap).not.toBeNull()
    expect(snap!.workspaces).toHaveLength(1)
    const w = snap!.workspaces[0]
    expect(w.status).toBe('ok')
    expect(w.tasks).toHaveLength(2)
    expect(w.tasks.find((t) => t.id === 't1')!.lastFiredAtMs).toBe(NOW) // t1 fired this scan
    expect(w.tasks.find((t) => t.id === 't1')!.nextDueAtMs).toBe(NOW + 30 * 60_000) // next cadence
    expect(w.tasks.find((t) => t.id === 't2')!.enabled).toBe(false) // done → never fires
    // never-fired `every` clamps next-due to now (due-now), never an epoch/1970 instant.
    expect(w.tasks.find((t) => t.id === 't2')!.nextDueAtMs).toBe(NOW)
  })

  it('prunes markers for issues no longer declared', async () => {
    const ws = await makeWs('w1', [{ id: 't1', title: 'i1', when: { kind: 'every', every: '30m' }, what: 'go' }])
    const markers = new FakeMarkers()
    await markers.set('w1', 'removed', 123)
    const { scanner } = scannerFor([ws], { markers })
    await scanner.scan()
    expect(markers.get('w1', 'removed')).toBeUndefined()
  })
})
