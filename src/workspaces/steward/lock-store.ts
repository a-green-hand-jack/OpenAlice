import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { logger } from '../logger.js';
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
 * Serializes `StewardLockStore.acquire` per resolved lock-file path (issue
 * #154 review, C1). `createStewardLockStore(workspaceDir)` is called fresh at
 * every call site (`service.ts` x2, the webui `/steward/wakes` route, the
 * machine-dispatch preflight) — there is no shared `StewardLockStore`
 * instance, so an instance-level mutex would not serialize concurrent
 * acquires that happen to run through different instances pointed at the
 * SAME on-disk lock file. Keying globally by the resolved absolute path
 * closes that gap: every acquire for the same account, regardless of which
 * instance issued it, funnels through the same queue.
 *
 * SINGLE-PROCESS ASSUMPTION — load-bearing, verified (issue #154 review):
 * `.alice/steward/locks/*.json` (the account lock this module owns) has
 * exactly one reader/writer in the whole codebase: this file, always
 * constructed and called from inside Alice's own Node process (never
 * cross-process). The workspace's generated `validate-ledger.mjs` — which
 * DOES run as a separate OS subprocess, spawned by the agent inside the
 * workspace — guards a completely different resource
 * (`.alice/steward/ledger/decisions.jsonl.lock`) with its own independent
 * open('wx')-retry protocol; it never touches `locks/*.json`. If a future
 * change introduces a second process that writes the account lock, this
 * in-process mutex stops being sufficient on its own and the acquire
 * protocol needs a cross-process primitive instead (e.g. write-to-scratch +
 * atomic link-publish) — this queue does not help across process
 * boundaries.
 */
const acquireQueueTailByPath = new Map<string, Promise<void>>();

async function withLockFileMutex<T>(lockFilePath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(lockFilePath);
  const previous = acquireQueueTailByPath.get(key) ?? Promise.resolve();
  let releaseOurs!: () => void;
  const ours = new Promise<void>((res) => {
    releaseOurs = res;
  });
  acquireQueueTailByPath.set(key, ours);

  await previous; // wait our turn — `ours` predecessors always resolve, never reject
  try {
    return await fn();
  } finally {
    releaseOurs();
    // Nobody queued behind us — drop the entry so the map doesn't grow
    // unbounded across the process lifetime for many distinct accounts.
    if (acquireQueueTailByPath.get(key) === ours) acquireQueueTailByPath.delete(key);
  }
}

export class StewardLockStore {
  constructor(private readonly workspaceDir: string) {}

  /**
   * Acquire-or-reject (issue #154 — fixes a TOCTOU where two concurrent wake
   * triggers for the same account could both pass a read-then-write acquire
   * before either lock file landed, letting both wakes proceed and
   * interleave ledger writes).
   *
   * The fix is a module-level async mutex (`withLockFileMutex`, keyed by the
   * resolved lock-file path — see its doc comment for the single-process
   * assumption this relies on): the whole check → expiry-check → write body
   * below runs as one serialized unit per account, so no interleaving
   * between two acquirers is possible by construction — there's no window
   * for a "yank a freshly-recreated live lock out from under its winner"
   * race the way a purely-atomic-per-step (create-then-steal) design could
   * still hit.
   *
   * The write itself is the original tmp+rename `writeJsonAtomic` (no
   * create-then-write window in the write step, so a mid-write crash/ENOSPC
   * can never leave a torn file at the canonical lock path — the OS `rename`
   * only ever swaps in a fully-written file). `get` additionally tolerates
   * torn/unparseable legacy residue (pre-dating this fix, or from a manual
   * edit) by treating it as absent rather than throwing — see `get`.
   */
  async acquire(input: AcquireStewardLockInput): Promise<StewardLockRecord> {
    const path = this.pathFor(input.accountId);
    return withLockFileMutex(path, async () => {
      const current = await this.get(input.accountId);
      if (current && current.wakeId !== input.wakeId && !isExpired(current, input.now)) {
        throw new StewardLockConflictError(current);
      }
      if (current && current.wakeId === input.wakeId && !isExpired(current, input.now)) {
        return current;
      }

      const next = parseStewardLockRecord({
        version: STEWARD_LOCK_SCHEMA_VERSION,
        accountId: input.accountId,
        wakeId: input.wakeId,
        acquiredAt: input.now,
        expiresAt: input.expiresAt,
      });
      await writeJsonAtomic(path, next);
      return next;
    });
  }

  /**
   * `null` means "no lock currently held", which covers both a genuinely
   * absent file (ENOENT) AND a torn/unparseable one (issue #154 review M1):
   * legacy crash residue, a manual edit, or any other corruption is treated
   * as stale rather than bricking the account — a structured warning is
   * logged so it's visible, and `acquire` (running under the path mutex)
   * will happily overwrite it with a fresh lock on the next attempt.
   */
  async get(accountId: string): Promise<StewardLockRecord | null> {
    const path = this.pathFor(accountId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
    try {
      return parseStewardLockRecord(JSON.parse(raw));
    } catch (err) {
      logger.warn('steward.lock_file_torn', {
        workspaceDir: this.workspaceDir,
        accountId,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
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

  /**
   * Serialized behind the same per-path mutex as `acquire` (#154 review m1):
   * unserialized, a LATE release of an already-expired lock could interleave
   * with a concurrent reclaim — its `get` reads the old record, the reclaimer
   * writes a fresh lock, then the release's `rm` deletes the reclaimer's
   * healthy lock, reopening the double-acquire this file exists to prevent.
   * Under the mutex the release either sees the reclaimer's record (wakeId
   * mismatch → no-op) or runs entirely before it (rm of its own lock).
   */
  async release(accountId: string, wakeId: string): Promise<boolean> {
    const path = this.pathFor(accountId);
    return withLockFileMutex(path, async () => {
      const current = await this.get(accountId);
      if (!current || current.wakeId !== wakeId) return false;
      await rm(path, { force: true });
      return true;
    });
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
