/**
 * Restart trigger coalescing (issue #127).
 *
 * A single logical mutation → exactly one flag-file write (one restart
 * generation). A concurrent burst of mutations → at most TWO generations (one
 * in-flight + one trailing that captures the final on-disk state), never N.
 *
 * We drive the real `triggerUTARestart` with an injected `flagPath` + `utaUrl`
 * and a stubbed health endpoint, and count `writeFile` calls to the flag as the
 * restart-generation counter.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Count flag writes: each restart generation writes exactly one `<flag>.*.tmp`.
const { flagWrites } = vi.hoisted(() => ({ flagWrites: [] as string[] }))
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn(async (path: unknown, data: unknown, opts?: unknown) => {
      flagWrites.push(String(path))
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, data, opts)
    }),
  }
})

import { triggerUTARestart } from './restart-trigger.js'

let dir: string
let flagPath: string
const utaUrl = 'http://127.0.0.1:59999'
const OPTS = () => ({ flagPath, utaUrl, intervalMs: 1, timeoutMs: 2000 })

/** Health stub: an ever-incrementing `startedAt` so every poll observes a
 *  change and each generation completes on its first poll. */
function stubHealth() {
  let tick = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    tick++
    return new Response(JSON.stringify({ ok: true, startedAt: `t${tick}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

const flagGenerations = () => flagWrites.filter((p) => p.startsWith(flagPath)).length

beforeEach(async () => {
  delete process.env['OPENALICE_LITE_MODE']
  delete process.env['OPENALICE_UTA_DISABLED']
  dir = await mkdtemp(join(tmpdir(), 'oa-restart-trigger-'))
  flagPath = join(dir, 'control', 'restart-uta.flag')
  flagWrites.length = 0
  stubHealth()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('triggerUTARestart coalescing (#127)', () => {
  it('a single call performs exactly one restart generation', async () => {
    const r = await triggerUTARestart(OPTS())
    expect(r).toMatchObject({ triggered: true, ready: true })
    expect(flagGenerations()).toBe(1)
  })

  it('a concurrent burst coalesces to at most two generations (never N)', async () => {
    const results = await Promise.all([
      triggerUTARestart(OPTS()),
      triggerUTARestart(OPTS()),
      triggerUTARestart(OPTS()),
      triggerUTARestart(OPTS()),
      triggerUTARestart(OPTS()),
    ])
    // Every caller resolves successfully...
    for (const r of results) expect(r.triggered).toBe(true)
    // ...but the whole burst collapses to one in-flight + one trailing restart.
    const gens = flagGenerations()
    expect(gens).toBeGreaterThanOrEqual(1)
    expect(gens).toBeLessThanOrEqual(2)
  })

  it('the trailing restart runs AFTER the in-flight one settles (serialized, not concurrent)', async () => {
    // First call starts the in-flight generation; a second, issued while the
    // first is still polling, becomes the single trailing generation.
    const first = triggerUTARestart(OPTS())
    const second = triggerUTARestart(OPTS())
    await Promise.all([first, second])
    expect(flagGenerations()).toBe(2)
  })

  it('sequential (awaited) calls each run once — state resets between generations', async () => {
    await triggerUTARestart(OPTS())
    await triggerUTARestart(OPTS())
    expect(flagGenerations()).toBe(2)
  })

  it('is disabled by OPENALICE_LITE_MODE without writing a flag', async () => {
    process.env['OPENALICE_LITE_MODE'] = '1'
    const r = await triggerUTARestart(OPTS())
    expect(r).toMatchObject({ triggered: false, ready: false })
    expect(flagGenerations()).toBe(0)
  })
})
