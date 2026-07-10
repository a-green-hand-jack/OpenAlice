import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dataPath } from '@/core/paths.js'
import type { GitExportState } from './git/types.js'

const fsyncControl = vi.hoisted(() => ({
  calls: 0,
  directoryCalls: 0,
  directoryErrorCode: undefined as string | undefined,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync(fd: number): void {
      fsyncControl.calls += 1
      const isDirectoryFsync = actual.fstatSync(fd).isDirectory()
      if (isDirectoryFsync) fsyncControl.directoryCalls += 1
      if (isDirectoryFsync && fsyncControl.directoryErrorCode) {
        throw Object.assign(new Error(`simulated ${fsyncControl.directoryErrorCode}`), {
          code: fsyncControl.directoryErrorCode,
        })
      }
      actual.fsyncSync(fd)
    },
  }
})

import { createGitPersister } from './git-persistence.js'

let accountId: string
let accountDirectory: string

function state(head: string): GitExportState {
  return { commits: [], head, stagingArea: [], pendingMessage: null, pendingHash: null }
}

beforeEach(() => {
  accountId = `persistence-fsync-${randomUUID()}`
  accountDirectory = dataPath('trading', accountId)
  fsyncControl.calls = 0
  fsyncControl.directoryCalls = 0
  fsyncControl.directoryErrorCode = undefined
})

afterEach(async () => {
  await rm(accountDirectory, { recursive: true, force: true })
})

describe('git persistence directory fsync errors', () => {
  it('propagates an unexpected directory EIO after the atomic rename', async () => {
    mkdirSync(accountDirectory, { recursive: true })
    // Arm the failure only after the ancestor-chain fsync succeeded, so the
    // EIO hits the post-rename directory fsync specifically.
    const persister = createGitPersister(accountId, (boundary) => {
      if (boundary === 'before-rename') fsyncControl.directoryErrorCode = 'EIO'
    })

    expect(() => persister(state('durable-but-unacknowledged')))
      .toThrow(expect.objectContaining({ code: 'EIO' }))

    // The rename still leaves a complete canonical file. The caller must
    // nevertheless quarantine because directory durability was not proven.
    expect(JSON.parse(await readFile(`${accountDirectory}/commit.json`, 'utf8')))
      .toEqual(state('durable-but-unacknowledged'))
  })

  it('ignores a documented unsupported-directory EINVAL only', async () => {
    mkdirSync(accountDirectory, { recursive: true })
    fsyncControl.directoryErrorCode = 'EINVAL'

    expect(() => createGitPersister(accountId)(state('complete'))).not.toThrow()
    expect(JSON.parse(await readFile(`${accountDirectory}/commit.json`, 'utf8')))
      .toEqual(state('complete'))
  })

  it('fsyncs the ancestor chain on the first write, even for pre-existing directories', () => {
    mkdirSync(accountDirectory, { recursive: true })
    createGitPersister(accountId)(state('first-write'))

    // The chain walk fsyncs every ancestor entry (account dir parent up to
    // the root) exactly because directories left by a crashed mkdir may exist
    // without durable parent entries; plus the post-rename directory fsync.
    expect(fsyncControl.directoryCalls).toBeGreaterThanOrEqual(3)
  })
})
