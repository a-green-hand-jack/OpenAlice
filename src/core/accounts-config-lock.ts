import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'

const LOCK_FILE_NAME = '.accounts.json.lock'
const DEFAULT_INCOMPLETE_OWNER_TTL_MS = 30_000
const DEFAULT_ACQUIRE_ATTEMPTS = 8_000
const DEFAULT_ACQUIRE_BACKOFF_MS = 5

interface LockOwner {
  readonly pid: number
  readonly hostname: string
  readonly token: string
  readonly acquiredAt: string
}

interface FileIdentity {
  readonly dev: number
  readonly ino: number
}

interface OwnedPath {
  readonly path: string
  readonly identity: FileIdentity
  readonly owner: LockOwner
}

interface ObservedPath {
  readonly identity: FileIdentity
  readonly mtimeMs: number
  readonly owner: LockOwner | null
}

export interface AccountsConfigLockHookContext {
  readonly lockPath: string
  readonly identity: FileIdentity
  readonly owner: LockOwner
}

export interface AccountsConfigLockOptions {
  /** Test/diagnostic overrides. Production callers use the defaults. */
  readonly owner?: Partial<LockOwner>
  readonly incompleteOwnerTtlMs?: number
  readonly acquireAttempts?: number
  readonly acquireBackoffMs?: number
  readonly isProcessAlive?: (pid: number, hostname: string) => boolean
  readonly hooks?: {
    /** Runs after exclusive canonical creation but before owner publication. */
    readonly afterCanonicalCreate?: (ctx: AccountsConfigLockHookContext) => Promise<void> | void
    readonly afterOwnerPublished?: (ctx: AccountsConfigLockHookContext) => Promise<void> | void
    readonly afterOwnershipLost?: (ctx: AccountsConfigLockHookContext) => Promise<void> | void
    readonly afterStaleQuarantined?: (path: string, observed: ObservedPath) => Promise<void> | void
  }
}

/**
 * Cross-process accounts.json mutex.
 *
 * The canonical lock is a file opened with `O_EXCL`. Its owner record is
 * written through that already-open handle, never through the canonical path:
 * if stale recovery renames the file while its creator is paused, the creator
 * can only write its original inode and cannot corrupt a successor lock.
 *
 * Every transition that can grant entry or remove a path proves both the
 * acquired `(dev, ino)` identity and the owner token. A per-inode transition
 * gate serializes publication, stale quarantine, and release so a delayed
 * reclaimer cannot act on a successor created at the same canonical path.
 */
export async function withAccountsConfigLock<T>(
  configDir: string,
  fn: () => Promise<T>,
  options: AccountsConfigLockOptions = {},
): Promise<T> {
  const lockPath = join(configDir, LOCK_FILE_NAME)
  const owner: LockOwner = {
    pid: options.owner?.pid ?? process.pid,
    hostname: options.owner?.hostname ?? osHostname(),
    token: options.owner?.token ?? randomUUID(),
    acquiredAt: options.owner?.acquiredAt ?? new Date().toISOString(),
  }
  const attempts = options.acquireAttempts ?? DEFAULT_ACQUIRE_ATTEMPTS
  const backoffMs = options.acquireBackoffMs ?? DEFAULT_ACQUIRE_BACKOFF_MS
  await mkdir(configDir, { recursive: true })

  for (let attempt = 0; attempt < attempts; attempt++) {
    const acquired = await tryCreateCanonicalLock(configDir, lockPath, owner, options)
    if (acquired) {
      const gate = await acquireTransitionGate(configDir, acquired.identity, owner, options)
      let stillOwned = false
      try {
        stillOwned = await pathIsOwned(acquired)
      } finally {
        await removeOwnedPath(gate)
      }

      if (!stillOwned) {
        await options.hooks?.afterOwnershipLost?.(hookContext(acquired))
        continue
      }

      try {
        return await fn()
      } finally {
        await releaseCanonicalLock(configDir, acquired, options)
      }
    }

    const observed = await observePath(lockPath)
    if (observed && isReclaimable(observed, options)) {
      await quarantineObservedLock(configDir, lockPath, observed, owner, options)
    }
    await sleep(backoffMs)
  }

  throw new Error(`timed out acquiring accounts config lock ${lockPath}`)
}

async function tryCreateCanonicalLock(
  configDir: string,
  lockPath: string,
  owner: LockOwner,
  options: AccountsConfigLockOptions,
): Promise<OwnedPath | null> {
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (isCode(error, 'EEXIST')) return null
    throw error
  }

  const info = await handle.stat()
  const acquired: OwnedPath = {
    path: lockPath,
    identity: { dev: info.dev, ino: info.ino },
    owner,
  }

  try {
    await options.hooks?.afterCanonicalCreate?.(hookContext(acquired))
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    // Cleanup is conditional on BOTH the original inode and published token.
    // A partial/empty owner is deliberately left for stale recovery.
    await releaseCanonicalLock(configDir, acquired, options)
    throw error
  }
  await handle.close()
  await options.hooks?.afterOwnerPublished?.(hookContext(acquired))
  return acquired
}

async function releaseCanonicalLock(
  configDir: string,
  acquired: OwnedPath,
  options: AccountsConfigLockOptions,
): Promise<void> {
  const gate = await acquireTransitionGate(configDir, acquired.identity, acquired.owner, options)
  try {
    await removeOwnedPath(acquired)
  } finally {
    await removeOwnedPath(gate)
  }
}

/** Move only the exact stale inode observed before gate acquisition. Quarantine
 * files are intentionally retained: deleting a path whose owner token is
 * incomplete would violate the ownership rule, and they are non-canonical. */
async function quarantineObservedLock(
  configDir: string,
  lockPath: string,
  observed: ObservedPath,
  contender: LockOwner,
  options: AccountsConfigLockOptions,
): Promise<boolean> {
  const gate = await acquireTransitionGate(configDir, observed.identity, contender, options)
  try {
    const current = await observePath(lockPath)
    if (!sameObservation(current, observed) || !current || !isReclaimable(current, options)) {
      return false
    }

    const aside = `${lockPath}.stale-${identityKey(observed.identity)}-${randomUUID()}`
    try {
      await rename(lockPath, aside)
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false
      throw error
    }

    const moved = await observePath(aside)
    if (!sameObservation(moved, observed)) {
      // Never delete or otherwise mutate a path that is not the exact stale
      // owner we proved under the transition gate. Fail closed and retry.
      return false
    }
    await options.hooks?.afterStaleQuarantined?.(aside, observed)
    return true
  } finally {
    await removeOwnedPath(gate)
  }
}

/** The gate is atomically published as a hard link to a fully-written private
 * claim. It has no incomplete-owner window. Gate crashes intentionally fail
 * closed rather than allowing an unowned cleanup race. */
async function acquireTransitionGate(
  configDir: string,
  identity: FileIdentity,
  owner: LockOwner,
  options: AccountsConfigLockOptions,
): Promise<OwnedPath> {
  const gatePath = join(configDir, `.accounts.json.lock.transition-${identityKey(identity)}`)
  const attempts = options.acquireAttempts ?? DEFAULT_ACQUIRE_ATTEMPTS
  const backoffMs = options.acquireBackoffMs ?? DEFAULT_ACQUIRE_BACKOFF_MS

  for (let attempt = 0; attempt < attempts; attempt++) {
    const claim = await createPrivateClaim(configDir, owner)
    try {
      await link(claim.path, gatePath)
    } catch (error) {
      await removeOwnedPath(claim)
      if (isCode(error, 'EEXIST')) {
        await sleep(backoffMs)
        continue
      }
      throw error
    }

    const gate: OwnedPath = { ...claim, path: gatePath }
    await removeOwnedPath(claim)
    if (await pathIsOwned(gate)) return gate
    // The link was replaced or disappeared before proof. We never remove the
    // unknown path; simply retry and remain fail closed.
    await sleep(backoffMs)
  }

  throw new Error(`timed out acquiring accounts config transition gate ${gatePath}`)
}

async function createPrivateClaim(configDir: string, owner: LockOwner): Promise<OwnedPath> {
  const path = join(configDir, `.accounts.json.lock.claim-${process.pid}-${randomUUID()}`)
  const handle = await open(path, 'wx', 0o600)
  const info = await handle.stat()
  const claim: OwnedPath = {
    path,
    identity: { dev: info.dev, ino: info.ino },
    owner,
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await removeOwnedPath(claim)
    throw error
  }
  await handle.close()
  return claim
}

async function removeOwnedPath(owned: OwnedPath): Promise<boolean> {
  if (!(await pathIsOwned(owned))) return false
  await rm(owned.path, { recursive: true, force: true })
  return true
}

async function pathIsOwned(owned: OwnedPath): Promise<boolean> {
  const current = await observePath(owned.path)
  return current !== null
    && sameIdentity(current.identity, owned.identity)
    && current.owner?.token === owned.owner.token
}

async function observePath(path: string): Promise<ObservedPath | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }

  try {
    const info = await handle.stat()
    let raw = ''
    if (info.isDirectory()) {
      try {
        raw = await readFile(join(path, 'owner.json'), 'utf8')
      } catch {
        // An incomplete previous-generation directory has no readable owner.
      }
      const stillCanonical = await observeIdentity(path)
      if (!stillCanonical || !sameIdentity(stillCanonical, { dev: info.dev, ino: info.ino })) {
        return null
      }
    } else {
      try {
        raw = await handle.readFile('utf8')
      } catch {
        // Incomplete owner publication: identity/mtime remain usable.
      }
    }
    return {
      identity: { dev: info.dev, ino: info.ino },
      mtimeMs: info.mtimeMs,
      owner: parseOwner(raw),
    }
  } finally {
    await handle.close()
  }
}

async function observeIdentity(path: string): Promise<FileIdentity | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }
  try {
    const info = await handle.stat()
    return { dev: info.dev, ino: info.ino }
  } finally {
    await handle.close()
  }
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>
    if (
      typeof parsed.pid !== 'number'
      || typeof parsed.hostname !== 'string'
      || typeof parsed.token !== 'string'
      || typeof parsed.acquiredAt !== 'string'
    ) return null
    return parsed as LockOwner
  } catch {
    return null
  }
}

function isReclaimable(observed: ObservedPath, options: AccountsConfigLockOptions): boolean {
  if (!observed.owner) {
    const ttlMs = options.incompleteOwnerTtlMs ?? DEFAULT_INCOMPLETE_OWNER_TTL_MS
    return Date.now() - observed.mtimeMs > ttlMs
  }
  return !(options.isProcessAlive ?? defaultIsProcessAlive)(
    observed.owner.pid,
    observed.owner.hostname,
  )
}

function defaultIsProcessAlive(pid: number, hostname: string): boolean {
  if (hostname !== osHostname()) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isCode(error, 'EPERM')
  }
}

function sameObservation(current: ObservedPath | null, expected: ObservedPath): boolean {
  if (!current || !sameIdentity(current.identity, expected.identity)) return false
  if (current.owner === null || expected.owner === null) {
    return current.owner === expected.owner
  }
  return current.owner.token === expected.owner.token
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function identityKey(identity: FileIdentity): string {
  return `${identity.dev}-${identity.ino}`
}

function hookContext(owned: OwnedPath): AccountsConfigLockHookContext {
  return { lockPath: owned.path, identity: owned.identity, owner: owned.owner }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as NodeJS.ErrnoException).code === code
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
