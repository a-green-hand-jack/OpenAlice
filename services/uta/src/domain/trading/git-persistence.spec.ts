import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GitExportState } from './git/types.js'
import type { GitPersistenceBoundary } from './git-persistence.js'

// SELF-ISOLATION: this suite writes corrupt state under REAL account ids
// (bybit-main, alpaca-paper — the legacy-path contract) and rm -rf's their
// directories. It must therefore never trust the ambient OPENALICE_HOME —
// even an explicitly exported real store — so it pins its own temp home and
// re-imports the path-dependent modules against it.
let dataPath: typeof import('@/core/paths.js')['dataPath']
let createGitPersister: typeof import('./git-persistence.js')['createGitPersister']
let loadGitState: typeof import('./git-persistence.js')['loadGitState']
let GitStateRecoveryError: typeof import('./git-persistence.js')['GitStateRecoveryError']

const originalHome = process.env['OPENALICE_HOME']

beforeAll(async () => {
  process.env['OPENALICE_HOME'] = mkdtempSync(join(tmpdir(), 'oa-git-persistence-'))
  vi.resetModules()
  const paths = await import('@/core/paths.js')
  dataPath = paths.dataPath
  const persistence = await import('./git-persistence.js')
  createGitPersister = persistence.createGitPersister
  loadGitState = persistence.loadGitState
  GitStateRecoveryError = persistence.GitStateRecoveryError
})

afterAll(() => {
  if (originalHome === undefined) delete process.env['OPENALICE_HOME']
  else process.env['OPENALICE_HOME'] = originalHome
  vi.resetModules()
})

const cleanupPaths = new Set<string>()

function accountFixture(): { accountId: string; directory: string; filePath: string } {
  const accountId = `persistence-${randomUUID()}`
  const directory = dataPath('trading', accountId)
  cleanupPaths.add(directory)
  return { accountId, directory, filePath: dataPath('trading', accountId, 'commit.json') }
}

function state(head: string): GitExportState {
  return { commits: [], head, stagingArea: [], pendingMessage: null, pendingHash: null }
}

afterEach(async () => {
  await Promise.all([...cleanupPaths].map((path) => rm(path, { recursive: true, force: true })))
  cleanupPaths.clear()
})

describe('git persistence', () => {
  it('fsyncs the ancestor chain once, then writes, fsyncs, renames, and fsyncs the directory', async () => {
    const { accountId, filePath } = accountFixture()
    const boundaries: GitPersistenceBoundary[] = []

    const persist = createGitPersister(accountId, (boundary) => boundaries.push(boundary))
    persist(state('new-head'))

    expect(boundaries).toEqual([
      'after-directory-chain-fsync',
      'after-temp-open',
      'after-file-write',
      'after-file-fsync',
      'before-rename',
      'after-rename',
      'after-directory-fsync',
    ])
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(state('new-head'))

    // The full chain walk is once-per-persister; later writes only carry the
    // atomic-sequence boundaries.
    boundaries.length = 0
    persist(state('second-head'))
    expect(boundaries).not.toContain('after-directory-chain-fsync')
    expect(boundaries).toContain('after-directory-fsync')
  })

  it('fsyncs the ancestor chain even when every directory already exists', async () => {
    // Crash-window contract: a previous process may have crashed between its
    // recursive mkdir and the parent fsync, so directories that EXIST are not
    // proof their entries are durable. A fresh persister must re-fsync the
    // chain instead of trusting existsSync.
    const { accountId, directory } = accountFixture()
    await mkdir(directory, { recursive: true })

    const boundaries: GitPersistenceBoundary[] = []
    createGitPersister(accountId, (boundary) => boundaries.push(boundary))(state('pre-existing'))

    expect(boundaries[0]).toBe('after-directory-chain-fsync')
  })

  it('preserves the old canonical file when interrupted before rename', async () => {
    const { accountId, directory, filePath } = accountFixture()
    createGitPersister(accountId)(state('old-head'))

    const interrupted = createGitPersister(accountId, (boundary) => {
      if (boundary === 'before-rename') throw new Error('simulated interruption')
    })

    expect(() => interrupted(state('new-head'))).toThrow('simulated interruption')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(state('old-head'))
    expect((await readdir(directory)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('leaves a complete new canonical file when interrupted after rename', async () => {
    const { accountId, filePath } = accountFixture()
    createGitPersister(accountId)(state('old-head'))

    const interrupted = createGitPersister(accountId, (boundary) => {
      if (boundary === 'after-rename') throw new Error('simulated process death')
    })

    expect(() => interrupted(state('new-head'))).toThrow('simulated process death')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(state('new-head'))
    await expect(loadGitState(accountId)).resolves.toEqual(state('new-head'))
  })

  it('keeps sequential writes complete and exposes the latest state', async () => {
    const { accountId, directory } = accountFixture()
    const persist = createGitPersister(accountId)

    persist(state('first'))
    persist(state('second'))

    await expect(loadGitState(accountId)).resolves.toEqual(state('second'))
    expect((await readdir(directory)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('fails closed on a corrupt canonical file instead of trying legacy state', async () => {
    const accountId = 'bybit-main'
    const primary = dataPath('trading', accountId, 'commit.json')
    const primaryDirectory = dirname(primary)
    const legacy = dataPath('crypto-trading', 'commit.json')
    const legacyDirectory = dirname(legacy)
    cleanupPaths.add(primaryDirectory)
    cleanupPaths.add(legacyDirectory)
    await mkdir(primaryDirectory, { recursive: true })
    await mkdir(legacyDirectory, { recursive: true })
    await writeFile(primary, '{broken', 'utf8')
    await writeFile(legacy, JSON.stringify(state('stale-legacy')), 'utf8')

    await expect(loadGitState(accountId)).rejects.toBeInstanceOf(GitStateRecoveryError)
  })

  it('uses legacy state only when the canonical file is absent', async () => {
    const accountId = 'alpaca-paper'
    const primaryDirectory = dataPath('trading', accountId)
    const legacy = dataPath('securities-trading', 'commit.json')
    const legacyDirectory = dirname(legacy)
    cleanupPaths.add(primaryDirectory)
    cleanupPaths.add(legacyDirectory)
    await mkdir(legacyDirectory, { recursive: true })
    await writeFile(legacy, JSON.stringify(state('legacy-head')), 'utf8')

    await expect(loadGitState(accountId)).resolves.toEqual(state('legacy-head'))
  })

  it('loads a valid canonical file even when an orphan temp also exists', async () => {
    const { accountId, directory } = accountFixture()
    createGitPersister(accountId)(state('canonical'))
    await writeFile(`${directory}/.commit.json.openalice-orphan.tmp`, '{partial', 'utf8')

    await expect(loadGitState(accountId)).resolves.toEqual(state('canonical'))
  })

  it('fails closed when only an interrupted-write temp exists', async () => {
    const { accountId, directory } = accountFixture()
    await mkdir(directory, { recursive: true })
    await writeFile(`${directory}/.commit.json.openalice-orphan.tmp`, '{partial', 'utf8')

    await expect(loadGitState(accountId)).rejects.toMatchObject({
      name: 'GitStateRecoveryError',
      filePath: dataPath('trading', accountId, 'commit.json'),
    })
  })

  it('fails closed on a structurally invalid canonical state', async () => {
    const { accountId, directory, filePath } = accountFixture()
    await mkdir(directory, { recursive: true })
    await writeFile(filePath, JSON.stringify({ commits: 'not-an-array', head: null }), 'utf8')

    await expect(loadGitState(accountId)).rejects.toBeInstanceOf(GitStateRecoveryError)
  })

  it('fails closed on a malformed mutation envelope instead of crashing the coordinator', async () => {
    const { accountId, directory, filePath } = accountFixture()
    await mkdir(directory, { recursive: true })

    // mutation: null and mutation without a numeric schemaVersion are both
    // recovery errors — the coordinator must never receive them.
    for (const mutation of [null, { activeAttempt: {} }, { schemaVersion: 'v1' }]) {
      await writeFile(filePath, JSON.stringify({ ...state('head-1'), mutation }), 'utf8')
      await expect(loadGitState(accountId)).rejects.toBeInstanceOf(GitStateRecoveryError)
    }

    // An unknown FUTURE schema version is deliberately readable — write
    // refusal happens in the coordinator, not at load.
    await writeFile(filePath, JSON.stringify({ ...state('head-1'), mutation: { schemaVersion: 99 } }), 'utf8')
    await expect(loadGitState(accountId)).resolves.toMatchObject({ mutation: { schemaVersion: 99 } })
  })
})
