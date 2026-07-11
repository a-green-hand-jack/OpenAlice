import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  STEWARD_LOCK_SCHEMA_VERSION,
  parseStewardLockRecord,
  type StewardLockRecord,
} from './types.js';
import { stewardLockFilename, stewardLockPath, stewardLocksDir } from './paths.js';

export interface AcquireStewardLockInput {
  readonly accountId: string;
  readonly wakeId: string;
  readonly now: string;
  readonly expiresAt: string;
}

export class StewardLockConflictError extends Error {
  constructor(public readonly lock: StewardLockRecord) {
    super(`steward account lock already held for ${lock.accountId} by ${lock.wakeId}`);
    this.name = 'StewardLockConflictError';
  }
}

/**
 * Bounds the compare-and-set retry loop in `acquire` (issue #154). Each retry
 * round only happens when a concurrent acquirer changes the lock's state out
 * from under us (a released lock, or a race to reclaim an expired one) — real
 * contention resolves within one or two rounds (see `acquire` doc comment).
 * This is a defensive circuit breaker against pathological thrash, not a
 * value tuned for expected contention.
 */
const MAX_ACQUIRE_ATTEMPTS = 32;

export class StewardLockStore {
  constructor(private readonly workspaceDir: string) {}

  /**
   * Acquire-or-reject in a single atomic step (issue #154 — fixes a TOCTOU
   * where two concurrent wake triggers for the same account could both pass a
   * read-then-write acquire before either lock file landed, letting both
   * wakes proceed and interleave ledger writes).
   *
   * The primitive is exclusive file creation (`open(path, 'wx')`, i.e.
   * O_CREAT|O_EXCL) — the OS guarantees exactly one concurrent caller wins
   * the create; every loser observes `EEXIST` and falls back to reading the
   * lock that's actually there to decide: conflict (live, different wake),
   * idempotent re-acquire (live, same wake), or stale-lock takeover.
   *
   * Stale-lock takeover is itself made atomic: the reclaimer `rename`s the
   * expired lock file to a scratch path. A filesystem `rename` can only ever
   * remove its source once — every other concurrent reclaimer's `rename` of
   * the same source then fails with `ENOENT`, so exactly one caller wins the
   * takeover and clears the path for a fresh exclusive create. Losers of
   * either race simply retry the acquire from the top (bounded by
   * `MAX_ACQUIRE_ATTEMPTS`) — a released or freshly-reclaimed slot resolves
   * within a round; a genuinely live conflicting lock throws
   * `StewardLockConflictError` immediately, without any retry.
   */
  async acquire(input: AcquireStewardLockInput): Promise<StewardLockRecord> {
    return this.acquireAttempt(input, 0);
  }

  private async acquireAttempt(
    input: AcquireStewardLockInput,
    attempt: number,
  ): Promise<StewardLockRecord> {
    if (attempt >= MAX_ACQUIRE_ATTEMPTS) {
      throw new Error(
        `steward lock acquire for ${input.accountId} did not converge after ${MAX_ACQUIRE_ATTEMPTS} attempts`,
      );
    }
    const path = this.pathFor(input.accountId);
    const next = parseStewardLockRecord({
      version: STEWARD_LOCK_SCHEMA_VERSION,
      accountId: input.accountId,
      wakeId: input.wakeId,
      acquiredAt: input.now,
      expiresAt: input.expiresAt,
    });

    try {
      await writeJsonExclusive(path, next);
      return next;
    } catch (err) {
      if (!isEEXIST(err)) throw err;
    }

    // A lock file already exists — inspect it to decide the outcome. It may
    // have been removed again (released, or reclaimed by someone else)
    // between our failed create and this read; treat that as "retry".
    const current = await this.get(input.accountId);
    if (current === null) {
      return this.acquireAttempt(input, attempt + 1);
    }
    if (!isExpired(current, input.now)) {
      if (current.wakeId === input.wakeId) return current;
      throw new StewardLockConflictError(current);
    }

    // Stale (expired) lock — attempt an atomic takeover. If we lose the
    // takeover race, someone else is handling this slot; reassess from the
    // top rather than assume anything about the new state.
    await this.reclaimStaleLock(path);
    return this.acquireAttempt(input, attempt + 1);
  }

  /**
   * Atomically clear an expired lock file so the caller's next exclusive
   * create can claim the slot. `rename` only succeeds for the first caller
   * to move a given source path; concurrent reclaimers racing the same
   * source all but one get `ENOENT` and simply fall through (their retry
   * will re-read the (now-vacated-or-refreshed) lock state).
   */
  private async reclaimStaleLock(path: string): Promise<void> {
    const scratch = `${path}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await rename(path, scratch);
    } catch (err) {
      if (isENOENT(err)) return;
      throw err;
    }
    await rm(scratch, { force: true }).catch(() => undefined);
  }

  async get(accountId: string): Promise<StewardLockRecord | null> {
    try {
      return parseStewardLockRecord(JSON.parse(await readFile(this.pathFor(accountId), 'utf8')));
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  async list(): Promise<StewardLockRecord[]> {
    let names: string[];
    try {
      names = await readdir(stewardLocksDir(this.workspaceDir));
    } catch (err) {
      if (isENOENT(err)) return [];
      throw err;
    }
    const locks: StewardLockRecord[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (!name.endsWith('.json')) continue;
      locks.push(parseStewardLockRecord(JSON.parse(
        await readFile(join(stewardLocksDir(this.workspaceDir), name), 'utf8'),
      )));
    }
    return locks;
  }

  async release(accountId: string, wakeId: string): Promise<boolean> {
    const current = await this.get(accountId);
    if (!current || current.wakeId !== wakeId) return false;
    await rm(this.pathFor(accountId), { force: true });
    return true;
  }

  pathFor(accountId: string): string {
    return stewardLockPath(this.workspaceDir, accountId);
  }

  filenameFor(accountId: string): string {
    return stewardLockFilename(accountId);
  }
}

export function createStewardLockStore(workspaceDir: string): StewardLockStore {
  return new StewardLockStore(workspaceDir);
}

function isExpired(lock: StewardLockRecord, now: string): boolean {
  return Date.parse(lock.expiresAt) <= Date.parse(now);
}

/**
 * Exclusive create-and-write: fails with `EEXIST` if `path` already exists.
 * `open(path, 'wx')` maps to `O_CREAT|O_EXCL` (POSIX) / `CREATE_NEW`
 * (Windows) — the OS itself guarantees at most one concurrent caller wins,
 * which is the atomic primitive `acquire` builds its compare-and-set on.
 */
async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch((err) => {
    if (!isEEXIST(err)) throw err;
  });
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function isEEXIST(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EEXIST';
}
