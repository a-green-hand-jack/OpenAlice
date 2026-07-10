/**
 * Trigger a Guardian-mediated UTA restart from Alice.
 *
 * Protocol:
 *   1. Atomic-write `data/control/restart-uta.flag` (write to .tmp + rename)
 *      with content = ISO timestamp of the request.
 *   2. Guardian's fs.watch fires (debounced 100ms), Guardian SIGTERMs UTA,
 *      waits exit, respawns with fresh `accounts.json`.
 *   3. Alice polls `${OPENALICE_UTA_URL}/__uta/health` until `startedAt` is
 *      newer than the pre-trigger value, or until timeout.
 *
 * Step 5 wires this into `trading-config.ts` so broker setup saves trigger
 * UTA reload automatically. Step 4 just exposes the helper.
 */

import { randomUUID } from 'crypto'
import { writeFile, rename, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { dataPath } from '@/core/paths.js'
import { isUTADisabled, resolveUTAUrl } from './url.js'

export interface TriggerOpts {
  /** UTA service base URL. Default: resolved local UTA carrier URL. */
  utaUrl?: string
  /** Flag path. Default: `dataPath('control', 'restart-uta.flag')`. */
  flagPath?: string
  /** Total wait budget for new UTA to come back. Default 20s. */
  timeoutMs?: number
  /** Health poll interval. Default 200ms. */
  intervalMs?: number
}

export interface TriggerResult {
  triggered: boolean
  ready: boolean
  /** UTA startedAt before trigger; useful for debugging churn. */
  oldStartedAt?: string
  /** UTA startedAt after trigger if ready. */
  newStartedAt?: string
  error?: string
}

interface HealthBody {
  ok?: boolean
  startedAt?: string
  utas?: number
}

async function fetchHealth(url: string): Promise<HealthBody | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as HealthBody
  } catch { return null }
}

// ==================== Coalescing restart scheduler (issue #127) ====================
//
// At most one restart runs at a time. While one is in flight, all further
// requests collapse into a SINGLE trailing restart that fires once the
// in-flight one settles. A burst of N config mutations therefore produces at
// most two restart generations — the in-flight one plus one trailing restart
// that picks up the final on-disk `accounts.json` — never N. This is a
// defense-in-depth coalescer: the primary fix for the double-restart is single
// ownership at the trading-config route layer, but coalescing bounds bursts and
// concurrent callers regardless of who triggers them.

let inFlight: Promise<TriggerResult> | null = null
let trailing: Promise<TriggerResult> | null = null
let trailingOpts: TriggerOpts | null = null

export function triggerUTARestart(opts: TriggerOpts = {}): Promise<TriggerResult> {
  if (!inFlight) {
    inFlight = driveRestart(opts)
    return inFlight
  }
  // A restart is already running. Register (or refresh) the single trailing
  // restart; every concurrent caller receives the same trailing promise, so
  // the whole burst collapses to one follow-up run.
  trailingOpts = opts
  if (!trailing) {
    trailing = inFlight
      .catch(() => undefined)
      .then(() => {
        const nextOpts = trailingOpts ?? {}
        trailing = null
        trailingOpts = null
        inFlight = driveRestart(nextOpts)
        return inFlight
      })
  }
  return trailing
}

/** Run one restart generation and release the in-flight slot when it settles. */
async function driveRestart(opts: TriggerOpts): Promise<TriggerResult> {
  try {
    return await triggerUTARestartOnce(opts)
  } finally {
    inFlight = null
  }
}

async function triggerUTARestartOnce(opts: TriggerOpts = {}): Promise<TriggerResult> {
  if (isUTADisabled()) {
    return { triggered: false, ready: false, error: 'UTA disabled by OPENALICE_LITE_MODE' }
  }
  const utaUrl = opts.utaUrl ?? resolveUTAUrl()
  const flagPath = opts.flagPath ?? dataPath('control', 'restart-uta.flag')
  const healthUrl = `${utaUrl.replace(/\/$/, '')}/__uta/health`
  const timeoutMs = opts.timeoutMs ?? 20_000
  const intervalMs = opts.intervalMs ?? 200

  const pre = await fetchHealth(healthUrl)
  const oldStartedAt = pre?.startedAt

  // Atomic-write so Guardian's watcher never sees a half-written flag.
  await mkdir(dirname(flagPath), { recursive: true })
  const tmpPath = `${flagPath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmpPath, new Date().toISOString(), 'utf-8')
  await rename(tmpPath, flagPath)

  // Poll for `startedAt` change.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const cur = await fetchHealth(healthUrl)
    if (cur?.startedAt && cur.startedAt !== oldStartedAt) {
      return { triggered: true, ready: true, oldStartedAt, newStartedAt: cur.startedAt }
    }
  }
  return { triggered: true, ready: false, oldStartedAt, error: 'UTA did not come back within timeout' }
}
