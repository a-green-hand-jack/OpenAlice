import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryInboxStore } from '../../core/inbox-store.js'
import type { Logger } from '../logger.js'
import type { WorkspaceMeta, WorkspaceRegistry } from '../workspace-registry.js'

import { createStewardLockStore, createStewardWakeStore } from './index.js'
import { StewardSupervisorScanner, type SessionPoolLike } from './supervisor-scanner.js'
import type { StewardWakeEnvelope } from './types.js'

const NOW = 1_700_000_000_000 // realistic epoch ms, same convention as schedule/scanner.spec.ts

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

const envelope: StewardWakeEnvelope = {
  reason: 'scheduled_observe',
  accountId: 'mock-simulator-1',
  authzLevel: 'paper',
  expectedDecision: 'no_trade',
}

/** In-memory `SessionPoolLike` — a session is "running" iff it was marked live. */
class FakePool implements SessionPoolLike {
  private readonly live = new Set<string>()
  setLive(sessionId: string): void {
    this.live.add(sessionId)
  }
  get(sessionId: string): unknown {
    return this.live.has(sessionId) ? {} : undefined
  }
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'steward-scan-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeWs(id: string, template?: string): WorkspaceMeta {
  return {
    id,
    tag: id,
    dir: join(root, id),
    createdAt: new Date(NOW).toISOString(),
    agents: ['codex'],
    ...(template !== undefined ? { template } : {}),
  }
}

function scannerFor(
  workspaces: WorkspaceMeta[],
  opts: {
    pool?: FakePool
    inboxStore?: ReturnType<typeof createMemoryInboxStore>
    now?: number
    intervalMs?: number
  } = {},
) {
  const pool = opts.pool ?? new FakePool()
  const registry = { list: () => workspaces } as unknown as WorkspaceRegistry
  const scanner = new StewardSupervisorScanner({
    registry,
    pool,
    ...(opts.inboxStore ? { inboxStore: opts.inboxStore } : {}),
    logger: noopLogger,
    now: () => opts.now ?? NOW,
    ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
  })
  return { scanner, pool, registry }
}

describe('StewardSupervisorScanner', () => {
  it('flips a past-deadline wake to timeout and releases its account lock, purely via scan()', async () => {
    const ws = makeWs('w-timeout', 'steward')
    const wakeStore = createStewardWakeStore(ws.dir)
    const lockStore = createStewardLockStore(ws.dir)
    await wakeStore.create({
      wakeId: 'wake-timeout',
      deadline: new Date(NOW - 60_000).toISOString(), // already expired relative to NOW
      envelope,
      now: new Date(NOW - 120_000).toISOString(),
    })
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-timeout',
      now: new Date(NOW - 120_000).toISOString(),
      expiresAt: new Date(NOW - 60_000).toISOString(),
    })

    const { scanner } = scannerFor([ws])
    await scanner.scan()

    expect((await wakeStore.get('wake-timeout'))?.status).toBe('timeout')
    expect(await lockStore.get(envelope.accountId)).toBeNull()
  })

  it('flips an injected wake with a dead session to stuck and releases its account lock, purely via scan()', async () => {
    const ws = makeWs('w-stuck', 'steward')
    const wakeStore = createStewardWakeStore(ws.dir)
    const lockStore = createStewardLockStore(ws.dir)
    await wakeStore.create({
      wakeId: 'wake-stuck',
      deadline: new Date(NOW + 60_000).toISOString(), // NOT yet expired — isolates the liveness branch
      envelope,
      now: new Date(NOW - 120_000).toISOString(),
    })
    await wakeStore.updateStatus('wake-stuck', 'injected', {
      now: new Date(NOW - 60_000).toISOString(),
      injectedAt: new Date(NOW - 60_000).toISOString(),
      sessionId: 'dead-session',
    })
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-stuck',
      now: new Date(NOW - 120_000).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
    })

    // FakePool never marks 'dead-session' live → isSessionRunning('dead-session') is false.
    const { scanner } = scannerFor([ws])
    await scanner.scan()

    expect((await wakeStore.get('wake-stuck'))?.status).toBe('stuck')
    expect(await lockStore.get(envelope.accountId)).toBeNull()
  })

  it('pushes an Inbox comment for the stuck transition, reusing the same tick-runner the manual route uses', async () => {
    const ws = makeWs('w-stuck-inbox', 'steward')
    const wakeStore = createStewardWakeStore(ws.dir)
    const lockStore = createStewardLockStore(ws.dir)
    await wakeStore.create({
      wakeId: 'wake-stuck',
      deadline: new Date(NOW + 60_000).toISOString(),
      envelope,
      now: new Date(NOW - 120_000).toISOString(),
    })
    await wakeStore.updateStatus('wake-stuck', 'injected', {
      now: new Date(NOW - 60_000).toISOString(),
      injectedAt: new Date(NOW - 60_000).toISOString(),
      sessionId: 'dead-session',
    })
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-stuck',
      now: new Date(NOW - 120_000).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
    })

    const inboxStore = createMemoryInboxStore()
    const { scanner } = scannerFor([ws], { inboxStore })
    await scanner.scan()

    const { entries } = await inboxStore.read({ workspaceId: 'w-stuck-inbox' })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.comments).toContain('wake-stuck')
    expect(entries[0]?.comments).toContain('dead-session')
  })

  it('leaves a non-steward-templated workspace untouched, even with a stale wake that would otherwise time out', async () => {
    const ws = makeWs('w-chat', 'chat')
    const wakeStore = createStewardWakeStore(ws.dir)
    const lockStore = createStewardLockStore(ws.dir)
    await wakeStore.create({
      wakeId: 'wake-would-timeout',
      deadline: new Date(NOW - 60_000).toISOString(),
      envelope,
      now: new Date(NOW - 120_000).toISOString(),
    })
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-would-timeout',
      now: new Date(NOW - 120_000).toISOString(),
      expiresAt: new Date(NOW - 60_000).toISOString(),
    })

    const { scanner } = scannerFor([ws])
    await scanner.scan()

    // Untouched: still queued, lock still held — the scanner never reached
    // this workspace's `.alice/steward/*` state at all.
    expect((await wakeStore.get('wake-would-timeout'))?.status).toBe('queued')
    expect(await lockStore.get(envelope.accountId)).not.toBeNull()
  })

  it('ignores a workspace with no template field at all (pre-template legacy row)', async () => {
    const ws = makeWs('w-legacy') // no `template`
    const wakeStore = createStewardWakeStore(ws.dir)
    await wakeStore.create({
      wakeId: 'wake-legacy',
      deadline: new Date(NOW - 60_000).toISOString(),
      envelope,
      now: new Date(NOW - 120_000).toISOString(),
    })

    const { scanner } = scannerFor([ws])
    await scanner.scan()

    expect((await wakeStore.get('wake-legacy'))?.status).toBe('queued')
  })

  it('isolates a per-workspace failure: one steward workspace with an invalid config does not stop the sweep over the rest', async () => {
    const bad = makeWs('w-bad-config', 'steward')
    const good = makeWs('w-good', 'steward')

    // Invalid `.alice/steward/config.json` — an array, not an object — makes
    // `readStewardConfig` throw for this workspace only.
    await mkdir(join(bad.dir, '.alice', 'steward'), { recursive: true })
    await writeFile(join(bad.dir, '.alice', 'steward', 'config.json'), '[]\n', 'utf8')

    const goodWakeStore = createStewardWakeStore(good.dir)
    const goodLockStore = createStewardLockStore(good.dir)
    await goodWakeStore.create({
      wakeId: 'wake-good',
      deadline: new Date(NOW - 60_000).toISOString(),
      envelope,
      now: new Date(NOW - 120_000).toISOString(),
    })
    await goodLockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-good',
      now: new Date(NOW - 120_000).toISOString(),
      expiresAt: new Date(NOW - 60_000).toISOString(),
    })

    const { scanner } = scannerFor([bad, good])
    await expect(scanner.scan()).resolves.toBeUndefined()

    expect((await goodWakeStore.get('wake-good'))?.status).toBe('timeout')
    expect(await goodLockStore.get(envelope.accountId)).toBeNull()
  })

  // The timer mechanics (self-arm / re-arm / stop) are tested here in
  // isolation from real fs I/O — mixing vitest's fake timers with real
  // node:fs/promises calls (as the tick-behavior tests above do via real
  // temp dirs) is flaky (pending fs work can race the temp-dir cleanup in
  // `afterEach`). Actual tick BEHAVIOR (timeout / stuck / non-steward-skip /
  // per-workspace error isolation) is proven above via direct `scan()` calls
  // against real temp dirs, matching `schedule/scanner.spec.ts`'s approach.
  it('self-arms on start(): fires scan() on its own after each interval, and stop() ends further fires', async () => {
    vi.useFakeTimers()
    try {
      const registry = { list: () => [] } as unknown as WorkspaceRegistry
      const scanner = new StewardSupervisorScanner({
        registry,
        pool: new FakePool(),
        logger: noopLogger,
        intervalMs: 30_000,
      })
      const scanSpy = vi.spyOn(scanner, 'scan')

      scanner.start()
      expect(scanSpy).not.toHaveBeenCalled() // never ticks synchronously on start()

      await vi.advanceTimersByTimeAsync(30_000)
      expect(scanSpy).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(scanSpy).toHaveBeenCalledTimes(2) // re-armed after the first fire

      scanner.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(scanSpy).toHaveBeenCalledTimes(2) // no further fires once stopped
    } finally {
      vi.useRealTimers()
    }
  })
})
