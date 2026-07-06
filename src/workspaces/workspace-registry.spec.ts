import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { WorkspaceRegistry } from './workspace-registry.js'
import type { Logger } from './logger.js'

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  event: () => {},
  child: () => noopLogger,
}

async function withRegistry<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'openalice-workspace-registry-'))
  try {
    return await fn(join(dir, 'workspaces.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('WorkspaceRegistry authzLevel persistence', () => {
  it('loads legacy rows without authzLevel for tolerant read_only resolution elsewhere', async () => {
    await withRegistry(async (path) => {
      await writeFile(path, JSON.stringify({
        version: 1,
        workspaces: [{
          id: 'ws-old',
          tag: 'old',
          dir: '/tmp/ws-old',
          createdAt: '2026-07-06T00:00:00.000Z',
          agents: ['claude'],
        }],
      }), 'utf8')

      const reg = await WorkspaceRegistry.load(path, noopLogger)
      expect(reg.get('ws-old')?.authzLevel).toBeUndefined()
    })
  })

  it('persists launcher-owned authzLevel in workspaces.json', async () => {
    await withRegistry(async (path) => {
      const reg = await WorkspaceRegistry.load(path, noopLogger)
      await reg.add({
        id: 'ws-paper',
        tag: 'paper',
        dir: '/tmp/ws-paper',
        createdAt: '2026-07-06T00:00:00.000Z',
        agents: ['codex'],
        authzLevel: 'paper',
      })

      const raw = JSON.parse(await readFile(path, 'utf8')) as { workspaces: Array<{ authzLevel?: string }> }
      expect(raw.workspaces[0]?.authzLevel).toBe('paper')
      expect((await WorkspaceRegistry.load(path, noopLogger)).get('ws-paper')?.authzLevel).toBe('paper')
    })
  })

  it('rejects invalid persisted authzLevel values', async () => {
    await withRegistry(async (path) => {
      await writeFile(path, JSON.stringify({
        version: 1,
        workspaces: [{
          id: 'ws-bad',
          tag: 'bad',
          dir: '/tmp/ws-bad',
          createdAt: '2026-07-06T00:00:00.000Z',
          agents: ['claude'],
          authzLevel: 'tier_one',
        }],
      }), 'utf8')

      await expect(WorkspaceRegistry.load(path, noopLogger)).rejects.toThrow(/invalid authzLevel/)
    })
  })
})
