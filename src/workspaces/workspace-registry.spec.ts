import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

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

  it('persists blind mode and allowed bar sources in workspaces.json', async () => {
    await withRegistry(async (path) => {
      const reg = await WorkspaceRegistry.load(path, noopLogger)
      await reg.add({
        id: 'ws-blind',
        tag: 'blind',
        dir: '/tmp/ws-blind',
        createdAt: '2026-07-06T00:00:00.000Z',
        agents: ['codex'],
        blind: true,
        blindAllowBarSources: ['mock-paper', 'mock-campaign'],
      })

      const raw = JSON.parse(await readFile(path, 'utf8')) as {
        workspaces: Array<{ blind?: boolean; blindAllowBarSources?: string[] }>
      }
      expect(raw.workspaces[0]).toMatchObject({
        blind: true,
        blindAllowBarSources: ['mock-paper', 'mock-campaign'],
      })
      expect((await WorkspaceRegistry.load(path, noopLogger)).get('ws-blind')).toMatchObject({
        blind: true,
        blindAllowBarSources: ['mock-paper', 'mock-campaign'],
      })
    })
  })

  it('updates launcher-owned authzLevel in place', async () => {
    await withRegistry(async (path) => {
      const reg = await WorkspaceRegistry.load(path, noopLogger)
      await reg.add({
        id: 'ws-change',
        tag: 'change',
        dir: '/tmp/ws-change',
        createdAt: '2026-07-06T00:00:00.000Z',
        agents: ['codex'],
      })

      const changed = await reg.setAuthzLevel('ws-change', 'paper')
      expect(changed).toMatchObject({ from: 'read_only', to: 'paper', changed: true })
      expect((await WorkspaceRegistry.load(path, noopLogger)).get('ws-change')?.authzLevel).toBe('paper')
    })
  })

  it('degrades invalid persisted authzLevel values to read_only without aborting load', async () => {
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
        }, {
          id: 'ws-good',
          tag: 'good',
          dir: '/tmp/ws-good',
          createdAt: '2026-07-06T00:00:01.000Z',
          agents: ['claude'],
          authzLevel: 'paper',
        }],
      }), 'utf8')

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const reg = await WorkspaceRegistry.load(path, noopLogger)
        expect(reg.get('ws-bad')?.authzLevel).toBe('read_only')
        expect(reg.get('ws-good')?.authzLevel).toBe('paper')
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid authzLevel.*degrading/))
      } finally {
        warn.mockRestore()
      }
    })
  })

  it('degrades invalid blind fields without aborting load', async () => {
    await withRegistry(async (path) => {
      await writeFile(path, JSON.stringify({
        version: 1,
        workspaces: [{
          id: 'ws-bad-blind',
          tag: 'bad-blind',
          dir: '/tmp/ws-bad-blind',
          createdAt: '2026-07-06T00:00:00.000Z',
          agents: ['claude'],
          blind: 'yes',
          blindAllowBarSources: ['mock-paper', 7, '', ' mock-paper ', 'mock-two'],
        }],
      }), 'utf8')

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const reg = await WorkspaceRegistry.load(path, noopLogger)
        expect(reg.get('ws-bad-blind')).toMatchObject({
          blindAllowBarSources: ['mock-paper', 'mock-two'],
        })
        expect(reg.get('ws-bad-blind')?.blind).toBeUndefined()
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid blind/))
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid blindAllowBarSources entries/))
      } finally {
        warn.mockRestore()
      }
    })
  })
})
