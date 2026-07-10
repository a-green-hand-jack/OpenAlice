/**
 * Regression: one logical account-config mutation triggers exactly ONE UTA
 * restart (issue #127).
 *
 * Before the fix, every create/update/delete fired two `triggerUTARestart`
 * calls — one from the route (`notifyUTAReload`) and one from the
 * `UTAManagerSDK` lifecycle method the route also invoked — so Guardian ran two
 * SIGTERM/respawn cycles per change (12 mutations → 24 restarts in the field
 * report). This spec drives the real route handlers with the restart trigger
 * mocked and counts generations: exactly one per POST/PUT/DELETE, and one per
 * mutation across a burst (trigger-level coalescing to ≤2 restart generations
 * for concurrent bursts is covered in `restart-trigger.spec.ts`).
 */

import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// In-memory config store so we never touch the real `data/` directory.
let utaStore: unknown[] = []
vi.mock('../../core/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/config.js')>('../../core/config.js')
  return {
    ...actual,
    readUTAsConfig: vi.fn(async () => utaStore),
    writeUTAsConfig: vi.fn(async (next: unknown[]) => { utaStore = [...next] }),
    wipeUTATradingData: vi.fn(async () => {}),
  }
})

// Count every restart generation the route layer asks for.
const { restartCalls } = vi.hoisted(() => ({ restartCalls: [] as unknown[] }))
vi.mock('../../services/uta-supervisor/restart-trigger.js', () => ({
  triggerUTARestart: vi.fn(async (opts?: unknown) => {
    restartCalls.push(opts ?? {})
    return { triggered: true, ready: true }
  }),
}))

import { createTradingConfigRoutes } from './trading-config.js'
import type { EngineContext } from '../../core/types.js'

function makeRoutes() {
  const ctx = {
    utaManager: {
      get: vi.fn(),
      resolve: () => [],
      listUTAs: () => [],
      // These must NOT be the ones triggering restarts anymore — the route owns
      // it. Spy them so we can assert the route no longer bounces per-account.
      reconnectUTA: vi.fn(async () => ({ success: true })),
      removeUTA: vi.fn(async () => {}),
    },
    tradingModePolicy: () => ({ mode: 'pro', source: 'auto', envLocked: false, hasUTAConfig: true }),
  } as unknown as EngineContext
  return { routes: createTradingConfigRoutes(ctx), ctx }
}

async function req(
  routes: ReturnType<typeof createTradingConfigRoutes>,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
) {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await routes.request(path, init)
  const json = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, body: json }
}

/** Wait a macrotask so fire-and-forget `notifyUTAReload()` settles. */
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  utaStore = []
  restartCalls.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

const OKX_CONF = { mode: 'live', apiKey: 'k', secret: 's', password: 'p' }

describe('trading-config restart ownership (#127)', () => {
  it('POST /uta → exactly one restart generation', async () => {
    const { routes, ctx } = makeRoutes()
    const { status, body } = await req(routes, 'POST', '/uta', { presetId: 'okx', presetConfig: OKX_CONF })
    expect(status).toBe(201)
    await flush()
    expect(restartCalls).toHaveLength(1)
    // The route must not also bounce the account via the SDK (that was trigger #2).
    expect((ctx.utaManager.reconnectUTA as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    void body
  })

  it('PUT /uta/:id (rotation) → exactly one restart generation', async () => {
    const { routes, ctx } = makeRoutes()
    const created = await req(routes, 'POST', '/uta', { presetId: 'okx', presetConfig: OKX_CONF })
    const id = (created.body as { id: string }).id
    await flush()
    restartCalls.length = 0

    const edited = await req(routes, 'PUT', `/uta/${id}`, {
      id, presetId: 'okx', enabled: true, guards: [],
      presetConfig: { mode: 'live', apiKey: 'rotated', secret: 'rotated', password: 'p' },
    })
    expect(edited.status).toBe(200)
    await flush()
    expect(restartCalls).toHaveLength(1)
    expect((ctx.utaManager.reconnectUTA as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('PUT /uta/:id (disable) → exactly one restart generation', async () => {
    const { routes, ctx } = makeRoutes()
    const created = await req(routes, 'POST', '/uta', { presetId: 'okx', presetConfig: OKX_CONF })
    const id = (created.body as { id: string }).id
    await flush()
    restartCalls.length = 0

    const edited = await req(routes, 'PUT', `/uta/${id}`, {
      id, presetId: 'okx', enabled: false, guards: [], presetConfig: OKX_CONF,
    })
    expect(edited.status).toBe(200)
    await flush()
    expect(restartCalls).toHaveLength(1)
    expect((ctx.utaManager.removeUTA as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('DELETE /uta/:id → exactly one restart generation', async () => {
    const { routes, ctx } = makeRoutes()
    const created = await req(routes, 'POST', '/uta', { presetId: 'okx', presetConfig: OKX_CONF })
    const id = (created.body as { id: string }).id
    await flush()
    restartCalls.length = 0

    const deleted = await req(routes, 'DELETE', `/uta/${id}`)
    expect(deleted.status).toBe(200)
    await flush()
    expect(restartCalls).toHaveLength(1)
    expect((ctx.utaManager.removeUTA as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('N sequential mutations → exactly N restart generations (one each, not 2N)', async () => {
    const { routes } = makeRoutes()
    // Three distinct create mutations (unique fingerprints).
    for (let i = 0; i < 3; i++) {
      const { status } = await req(routes, 'POST', '/uta', {
        presetId: 'okx',
        presetConfig: { mode: 'live', apiKey: `k${i}`, secret: `s${i}`, password: 'p' },
      })
      expect(status).toBe(201)
    }
    await flush()
    // Pre-fix this was 6 (2 per mutation). Now it's exactly one per mutation;
    // the trigger layer coalesces overlapping generations down further.
    expect(restartCalls).toHaveLength(3)
  })
})
