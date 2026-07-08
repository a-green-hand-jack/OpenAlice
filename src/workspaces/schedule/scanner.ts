/**
 * ScheduleScanner - the dumb external scheduler for workspace self-declared
 * issues. Each tick it enumerates every workspace, reads that workspace's own
 * `.alice/issues/<id>.md` files live, and for every SCHEDULED + due issue (one
 * that carries a `when`) dispatches either a headless run (default) or a
 * persistent steward wake (`kind: steward-wake`). Issues without a `when` are
 * pure board work items and are ignored here. It interprets only the dispatch
 * kind and routing fields; ordinary fire prompt content is still opaque.
 *
 * The ~1-min tick is the scheduler's OWN control loop (a plain timer), NOT a
 * scheduled task - infrastructure periodicity never enters the self-description
 * system. Ordinary headless runs still rely only on the global headless
 * concurrency cap. Steward wakes use their own per-account lock in
 * `.alice/steward/locks`.
 *
 * Due-ness carries no external schedule state (see `fireBase`): from the last
 * fire, or a never-fired baseline — `every`/`at` from epoch (fire on first
 * sight), `cron` from `now - interval` (catches an occurrence that just passed,
 * without firing immediately on creation OR never firing at all — seeding cron
 * from `now` makes `computeNextRun` always strictly future, i.e. never due).
 * Then `computeNextRun(when, base) <= now`. The marker is written only AFTER a
 * successful dispatch, so a capacity-rejected `every`/`at` fire retries next
 * tick; a `cron` fire rejected at its exact occurrence may skip to the next
 * occurrence (rare — needs the pool full at that minute).
 */

import { computeNextRun, type Schedule } from '../../core/schedule-expr.js'
import type { CliAdapter } from '../cli-adapter.js'
import type { Logger } from '../logger.js'
import type { WorkspaceMeta, WorkspaceRegistry } from '../workspace-registry.js'

import { isFireable, issueFirePrompt, readWorkspaceIssues } from '../issues/declaration.js'
import type { IssueRecord } from '../issues/declaration.js'
import type { StewardExpectedDecision, StewardWakeEnvelope, StewardWakeReason } from '../steward/types.js'

import {
  fireBase,
  snapshotScheduledIssue,
  type ScheduleSnapshot,
  type ScheduleSnapshotTask,
  type ScheduleSnapshotWorkspace,
} from './declaration.js'

export const DEFAULT_INTERVAL_MS = 60_000
/** Matches the legacy cron-router's headless dispatch timeout. */
const RUN_TIMEOUT_MS = 30 * 60_000

/** The slice of ScheduleMarkerStore the scanner needs (structural, for testing). */
export interface MarkerStore {
  key(wsId: string, taskId: string): string
  get(wsId: string, taskId: string): number | undefined
  set(wsId: string, taskId: string, ts: number): Promise<void>
  prune(seenKeys: Set<string>): Promise<void>
}

export interface ScheduleScannerDeps {
  registry: WorkspaceRegistry
  resolveAdapter: (meta: WorkspaceMeta, agentId?: string) => CliAdapter | Promise<CliAdapter>
  dispatch: (
    meta: WorkspaceMeta,
    adapter: CliAdapter,
    prompt: string,
    timeoutMs: number,
    /** The firing issue's id — recorded on the run so the issue detail can show
     *  its real run history. The scanner ALWAYS passes it (it only fires from an
     *  issue); manual/external dispatch callers omit it. */
    issueId?: string,
  ) => Promise<{ taskId: string }>
  dispatchStewardWake?: (
    meta: WorkspaceMeta,
    wake: ScheduleStewardWakeInput,
  ) => Promise<{ wakeId: string }>
  markers: MarkerStore
  logger: Logger
  /** Injectable clock for tests. */
  now?: () => number
  /** Injectable tick interval for tests. */
  intervalMs?: number
}

export interface ScheduleStewardWakeInput {
  readonly issueId: string
  readonly wakeId: string
  readonly reason: StewardWakeReason
  readonly accountId: string
  readonly authzLevel: StewardWakeEnvelope['authzLevel']
  readonly expectedDecision: StewardExpectedDecision
  readonly humanRequest: string
  readonly deadlineMs?: number
  readonly marketContext?: Record<string, unknown>
  readonly riskContext?: Record<string, unknown>
  readonly agent?: string
  readonly nowMs: number
}

export class ScheduleScanner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private scanning = false
  /** Snapshot built as a side-effect of each scan; null until the first scan. */
  private lastSnapshot: ScheduleSnapshot | null = null
  private readonly now: () => number
  private readonly intervalMs: number

  constructor(private readonly deps: ScheduleScannerDeps) {
    this.now = deps.now ?? Date.now
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  /** Begin ticking. First scan happens after one interval (never on construct). */
  start(): void {
    if (this.timer || this.stopped) return
    this.arm()
    this.deps.logger.info('schedule.scanner_started', { intervalMs: this.intervalMs })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** The snapshot built by the last scan (warm cache for GET /api/schedule), or
   *  null before the first tick. The scanner already reads every declaration each
   *  tick, so this is free — the route serves it instead of re-walking disk. */
  snapshot(): ScheduleSnapshot | null {
    return this.lastSnapshot
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tickAndRearm(), this.intervalMs)
    // Don't hold the event loop / a test runner open on the scheduler's timer.
    this.timer.unref?.()
  }

  private async tickAndRearm(): Promise<void> {
    this.timer = null
    if (this.stopped) return
    try {
      await this.scan()
    } catch (err) {
      this.deps.logger.warn('schedule.scan_failed', { err })
    }
    if (!this.stopped) this.arm()
  }

  /** One full pass over all workspaces. Public for tests / a future "scan now". */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.deps.logger.info('schedule.scan_overlap_skipped', {})
      return
    }
    this.scanning = true
    const nowMs = this.now()
    const seen = new Set<string>()
    try {
      // registry.list() order is preserved by Promise.all → stable display order.
      const workspaces = await Promise.all(
        this.deps.registry.list().map((ws) => this.scanWorkspace(ws, nowMs, seen)),
      )
      await this.deps.markers.prune(seen)
      this.lastSnapshot = { workspaces }
    } finally {
      this.scanning = false
    }
  }

  /** Read one workspace's issues, fire its due SCHEDULED issues, and return its
   *  snapshot row (only scheduled issues — unscheduled board items never reach
   *  this layer). Reads issues ONCE — firing and the dashboard view come from the
   *  same read. Per-file-invalid issues isolate (they're surfaced to the board
   *  elsewhere); a workspace stays 'ok' as long as its issues dir read at all. */
  private async scanWorkspace(
    ws: WorkspaceMeta,
    nowMs: number,
    seen: Set<string>,
  ): Promise<ScheduleSnapshotWorkspace> {
    let res
    try {
      res = await readWorkspaceIssues(ws.dir)
    } catch (err) {
      this.deps.logger.warn('schedule.read_failed', { wsId: ws.id, err })
      return { wsId: ws.id, tag: ws.tag, status: 'invalid', error: 'failed to read issues', tasks: [] }
    }
    if (!res.ok) {
      if (res.reason === 'invalid') {
        this.deps.logger.warn('schedule.declaration_invalid', { wsId: ws.id, error: res.error })
        return { wsId: ws.id, tag: ws.tag, status: 'invalid', error: res.error, tasks: [] }
      }
      return { wsId: ws.id, tag: ws.tag, status: 'absent', tasks: [] }
    }
    if (res.invalid.length > 0) {
      this.deps.logger.warn('schedule.issue_files_invalid', {
        wsId: ws.id,
        invalid: res.invalid.map((i) => i.id),
      })
    }

    const tasks: ScheduleSnapshotTask[] = []
    for (const issue of res.issues) {
      // No `when` ⇒ pure board work item; the scanner does not touch it.
      const when = issue.when
      if (!when) continue
      seen.add(this.deps.markers.key(ws.id, issue.id))
      if (isFireable(issue) && this.isDue(ws.id, issue.id, when, nowMs)) {
        const prompt = issueFirePrompt(issue)
        if (issue.kind === 'steward-wake') {
          await this.fireStewardWake(ws, issue, prompt, nowMs)
        } else {
          await this.fire(ws, issue.id, prompt, issue.agent, nowMs)
        }
      }
      // Read the marker AFTER any fire so last/next reflect a just-fired run.
      const last = this.deps.markers.get(ws.id, issue.id) ?? null
      tasks.push(snapshotScheduledIssue(issue, when, last, nowMs, this.intervalMs))
    }
    return { wsId: ws.id, tag: ws.tag, status: 'ok', tasks }
  }

  private isDue(wsId: string, taskId: string, when: Schedule, nowMs: number): boolean {
    const last = this.deps.markers.get(wsId, taskId) ?? null
    const next = computeNextRun(when, fireBase(when, last, nowMs, this.intervalMs))
    return next !== null && next <= nowMs
  }

  private async fire(
    ws: WorkspaceMeta,
    taskId: string,
    what: string,
    agentId: string | undefined,
    nowMs: number,
  ): Promise<void> {
    const adapter = await this.deps.resolveAdapter(ws, agentId)
    if (!adapter.capabilities.headless || !adapter.composeHeadlessCommand) {
      this.deps.logger.warn('schedule.adapter_not_headless', { wsId: ws.id, taskId, agent: adapter.id })
      return
    }
    try {
      // `taskId` here is the firing ISSUE's id (keyed by filename stem) — thread
      // it so the run records which issue triggered it.
      const { taskId: runId } = await this.deps.dispatch(ws, adapter, what, RUN_TIMEOUT_MS, taskId)
      await this.deps.markers.set(ws.id, taskId, nowMs)
      this.deps.logger.info('schedule.fired', { wsId: ws.id, taskId, agent: adapter.id, runId })
    } catch (err) {
      // Capacity full (or transient) - do NOT mark; the task stays due and
      // retries on the next tick once a headless slot frees.
      this.deps.logger.info('schedule.fire_skipped', {
        wsId: ws.id,
        taskId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async fireStewardWake(
    ws: WorkspaceMeta,
    issue: IssueRecord,
    humanRequest: string,
    nowMs: number,
  ): Promise<void> {
    if (!this.deps.dispatchStewardWake) {
      this.deps.logger.warn('schedule.steward_wake_unavailable', { wsId: ws.id, taskId: issue.id })
      return
    }
    if (!issue.accountId || !issue.authzLevel || !issue.expectedDecision) {
      this.deps.logger.warn('schedule.steward_wake_invalid', { wsId: ws.id, taskId: issue.id })
      return
    }
    const wakeId = `${new Date(nowMs).toISOString()}:${issue.id}`
    try {
      const result = await this.deps.dispatchStewardWake(ws, {
        issueId: issue.id,
        wakeId,
        reason: issue.wakeReason ?? 'scheduled_observe',
        accountId: issue.accountId,
        authzLevel: issue.authzLevel,
        expectedDecision: issue.expectedDecision,
        humanRequest,
        ...(issue.deadlineMs !== undefined ? { deadlineMs: issue.deadlineMs } : {}),
        ...(issue.marketContext !== undefined ? { marketContext: issue.marketContext } : {}),
        ...(issue.riskContext !== undefined ? { riskContext: issue.riskContext } : {}),
        ...(issue.agent !== undefined ? { agent: issue.agent } : {}),
        nowMs,
      })
      await this.deps.markers.set(ws.id, issue.id, nowMs)
      this.deps.logger.info('schedule.steward_wake_fired', {
        wsId: ws.id,
        taskId: issue.id,
        wakeId: result.wakeId,
      })
    } catch (err) {
      this.deps.logger.info('schedule.steward_wake_skipped', {
        wsId: ws.id,
        taskId: issue.id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
