/**
 * Git state persistence — load/save Trading-as-Git commit history.
 *
 * A broker receipt is only as durable as commit.json. Writes therefore use a
 * same-directory atomic replacement and synchronously surface every failure
 * to the mutation coordinator.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { GitExportState } from './git/types.js'
import { dataPath } from '@/core/paths.js'

// ==================== Paths ====================

function gitFilePath(accountId: string): string {
  return dataPath('trading', accountId, 'commit.json')
}

/** Legacy paths for backward compat. TODO: remove before v1.0 */
const LEGACY_GIT_PATHS: Record<string, string> = {
  'bybit-main': dataPath('crypto-trading', 'commit.json'),
  'alpaca-paper': dataPath('securities-trading', 'commit.json'),
  'alpaca-live': dataPath('securities-trading', 'commit.json'),
}

function tempPrefix(filePath: string): string {
  return `.${basename(filePath)}.openalice-`
}

function tempFilePath(filePath: string): string {
  return join(dirname(filePath), `${tempPrefix(filePath)}${process.pid}-${randomUUID()}.tmp`)
}

// ==================== Errors ====================

export class GitStateRecoveryError extends Error {
  constructor(message: string, readonly filePath: string) {
    super(message)
    this.name = 'GitStateRecoveryError'
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function parseGitState(raw: string, filePath: string): GitExportState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new GitStateRecoveryError(
      `Trading state is not valid JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    )
  }

  if (
    typeof parsed !== 'object'
    || parsed === null
    || !Array.isArray((parsed as Partial<GitExportState>).commits)
    || !Object.prototype.hasOwnProperty.call(parsed, 'head')
  ) {
    throw new GitStateRecoveryError(
      `Trading state has an invalid top-level shape at ${filePath}`,
      filePath,
    )
  }

  // A present-but-malformed mutation envelope must fail closed here with a
  // recovery error, not reach the coordinator as a TypeError. Unknown FUTURE
  // schema versions are deliberately allowed through — the coordinator maps
  // them to `unsupported_schema` (read-only diagnostics, no writes).
  if (Object.prototype.hasOwnProperty.call(parsed, 'mutation')) {
    const mutation = (parsed as { mutation: unknown }).mutation
    const schemaVersion = mutation && typeof mutation === 'object'
      ? (mutation as { schemaVersion?: unknown }).schemaVersion
      : undefined
    if (mutation !== undefined
      && (typeof schemaVersion !== 'number' || !Number.isFinite(schemaVersion))) {
      throw new GitStateRecoveryError(
        `Trading state has a malformed mutation envelope at ${filePath}; refusing to guess at recovery state`,
        filePath,
      )
    }
  }

  return parsed as GitExportState
}

async function assertNoOrphanTemp(filePath: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dirname(filePath))
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }

  const orphan = entries.find((entry) => entry.startsWith(tempPrefix(filePath)) && entry.endsWith('.tmp'))
  if (orphan) {
    throw new GitStateRecoveryError(
      `Canonical trading state is missing while an interrupted-write file exists: ${orphan}`,
      filePath,
    )
  }
}

// ==================== Durable writer ====================

export type GitPersistenceBoundary =
  | 'after-directory-chain-fsync'
  | 'after-temp-open'
  | 'after-file-write'
  | 'after-file-fsync'
  | 'before-rename'
  | 'after-rename'
  | 'after-directory-fsync'

export type GitPersistenceBoundaryHook = (boundary: GitPersistenceBoundary) => void

function isUnsupportedDirectoryFsync(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'EINVAL'
    || code === 'ENOTSUP'
    || code === 'EOPNOTSUPP'
    || code === 'ENOSYS'
    || code === 'EISDIR'
    // Ancestors outside our data root (e.g. /Users) may not be openable;
    // durability there is best-effort — the entries we own still fsync.
    || code === 'EACCES'
    || (process.platform === 'win32' && code === 'EPERM')
}

function fsyncDirectorySync(directory: string): void {
  let fd: number
  try {
    fd = openSync(directory, 'r')
  } catch (error) {
    if (isUnsupportedDirectoryFsync(error)) return
    throw error
  }

  let syncError: unknown
  try {
    fsyncSync(fd)
  } catch (error) {
    if (!isUnsupportedDirectoryFsync(error)) syncError = error
  }

  let closeError: unknown
  try {
    closeSync(fd)
  } catch (error) {
    closeError = error
  }

  if (syncError) throw syncError
  if (closeError) throw closeError
}

/**
 * Fsync the FULL ancestor chain unconditionally, not just entries this call
 * created: a previous process may have crashed between its recursive mkdir
 * and the parent-directory fsync, leaving directories that exist in the page
 * cache but whose entries were never made durable. An existsSync-gated walk
 * would trust exactly those phantom directories. Memoized to once per
 * persister lifetime by the caller.
 */
function ensureDirectoryDurableSync(directory: string): void {
  mkdirSync(directory, { recursive: true })
  let cursor = directory
  for (;;) {
    const parent = dirname(cursor)
    fsyncDirectorySync(parent)
    if (parent === cursor) break
    cursor = parent
  }
}

function atomicWriteGitStateSync(
  filePath: string,
  state: GitExportState,
  ensureDirectory: () => void,
  onBoundary?: GitPersistenceBoundaryHook,
): void {
  const directory = dirname(filePath)
  const temporary = tempFilePath(filePath)
  const contents = JSON.stringify(state, null, 2)
  let fd: number | undefined
  let renamed = false

  ensureDirectory()

  try {
    fd = openSync(temporary, 'wx', 0o600)
    onBoundary?.('after-temp-open')

    writeFileSync(fd, contents, 'utf8')
    onBoundary?.('after-file-write')

    fsyncSync(fd)
    onBoundary?.('after-file-fsync')

    closeSync(fd)
    fd = undefined

    onBoundary?.('before-rename')
    renameSync(temporary, filePath)
    renamed = true
    onBoundary?.('after-rename')

    fsyncDirectorySync(directory)
    onBoundary?.('after-directory-fsync')
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Preserve the first durability error; a leftover temp is detected on load.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temporary)
      } catch (cleanupError) {
        if (!isMissing(cleanupError)) {
          // Cleanup is best-effort. An undeleted temp deliberately makes a
          // missing canonical file fail closed on the next load.
        }
      }
    }
    throw error
  }
}

// ==================== Public API ====================

/** Read canonical state, falling back to legacy only when canonical is absent. */
export async function loadGitState(accountId: string): Promise<GitExportState | undefined> {
  const primary = gitFilePath(accountId)
  try {
    return parseGitState(await readFile(primary, 'utf8'), primary)
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  await assertNoOrphanTemp(primary)

  const legacy = LEGACY_GIT_PATHS[accountId]
  if (!legacy) return undefined

  try {
    return parseGitState(await readFile(legacy, 'utf8'), legacy)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Create a synchronous, throwing persister for each git state transition. */
export function createGitPersister(
  accountId: string,
  onBoundary?: GitPersistenceBoundaryHook,
): (state: GitExportState) => void {
  const filePath = gitFilePath(accountId)
  const directory = dirname(filePath)
  // Full ancestor-chain fsync exactly once per persister (≈ once per process
  // per account); later writes only re-fsync the account directory itself as
  // part of the atomic rename sequence.
  let chainDurable = false
  const ensureDirectory = (): void => {
    if (chainDurable) {
      mkdirSync(directory, { recursive: true })
      return
    }
    ensureDirectoryDurableSync(directory)
    chainDurable = true
    onBoundary?.('after-directory-chain-fsync')
  }
  return (state: GitExportState) => atomicWriteGitStateSync(filePath, state, ensureDirectory, onBoundary)
}
