import { open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { stewardLedgerLockPath, stewardLedgerPath } from './paths.js';

/**
 * Atomic, cross-process-locked writing of `decisions.jsonl` (issue #140).
 *
 * The steward's native Write/Edit does truncate+rewrite, which the supervisor's
 * `readFile` can sample mid-write → a spurious `entry_missing` #134 violation.
 * The structural fix (Solution A) is that the ledger is only ever written
 * through this atomic path: whole-file temp + fsync + atomic rename, so a reader
 * only ever sees the OLD-complete or NEW-complete file — never empty/partial.
 *
 * The generated `validate-ledger.mjs` re-implements the SAME lock protocol and
 * atomic-write steps in plain ESM (see templates/steward/bootstrap.mjs), so the
 * TS store and the in-workspace validator coordinate through one lock and never
 * lose each other's updates. Keep the two in lockstep if this changes.
 *
 * Protocol (shared, byte-compatible intent):
 *  - Lock file `<ledger>.lock` created with an exclusive `wx` open; contents
 *    `{pid, at}`. Held → retry with capped backoff. A lock older than
 *    `LOCK_TTL_MS` is treated as stale and reclaimed by renaming it aside (only
 *    one racer's rename wins — no TOCTOU delete). The holder unlinks the lock
 *    only after confirming it still owns it.
 *  - Writes go to a same-directory unique temp, are fsync'd, then atomically
 *    renamed over the target; rename is retried on Windows/macOS EPERM/EACCES/
 *    EEXIST with backoff and NEVER degrades to truncate-in-place.
 */

export const LOCK_TTL_MS = 30_000;
// Total acquire budget must OUTLAST the stale TTL so a lock left by a dead
// writer is always reclaimed rather than giving up first: after the short ramp
// this is ~200 attempts × 200ms ≈ 40s > LOCK_TTL_MS (30s). (Mirrored in the
// generated validator — see the parity test.)
const LOCK_ACQUIRE_ATTEMPTS = 200;
const LOCK_BACKOFF_BASE_MS = 15;
const LOCK_BACKOFF_CAP_MS = 200;
/** Retry codes a rename may transiently fail with on Windows/macOS. Shared,
 *  parity-checked against the generated validator. */
export const LEDGER_RENAME_RETRY_CODES = ['EPERM', 'EACCES', 'EEXIST', 'EBUSY'] as const;
const RENAME_ATTEMPTS = 20;
const RENAME_BACKOFF_MS = 25;

let tmpCounter = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCode(err: unknown, ...codes: string[]): boolean {
  return typeof err === 'object' && err !== null && codes.includes((err as NodeJS.ErrnoException).code ?? '');
}

/** A held ledger lock. `release()` is idempotent and only removes the lock file
 *  if this token still owns it. */
export interface LedgerLock {
  release(): Promise<void>;
}

export async function acquireLedgerLock(workspaceDir: string): Promise<LedgerLock> {
  const lockPath = stewardLedgerLockPath(workspaceDir);
  const token = `${process.pid}-${Date.now()}-${tmpCounter++}`;
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      const fh = await open(lockPath, 'wx');
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }));
        await fh.sync().catch(() => undefined);
      } finally {
        await fh.close();
      }
      return makeLock(lockPath, token);
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err;
      await reclaimIfStale(lockPath);
      await sleep(Math.min(LOCK_BACKOFF_BASE_MS * (attempt + 1), LOCK_BACKOFF_CAP_MS));
    }
  }
  throw new Error(
    `could not acquire steward ledger lock ${lockPath} within the acquire budget ` +
      `(a stale lock is auto-reclaimed after ${LOCK_TTL_MS}ms; this is safe to retry)`,
  );
}

function makeLock(lockPath: string, token: string): LedgerLock {
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Only remove the lock if it's still ours (guards against a prior stale
      // reclaim having handed it to someone else).
      try {
        const info = JSON.parse(await readFile(lockPath, 'utf8'));
        if (info?.token !== token) return;
      } catch {
        return;
      }
      await rm(lockPath, { force: true }).catch(() => undefined);
    },
  };
}

async function reclaimIfStale(lockPath: string): Promise<void> {
  let info: { at?: number } | null = null;
  try {
    info = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return; // unreadable or vanished mid-read — just retry
  }
  if (!info || typeof info.at !== 'number' || Date.now() - info.at <= LOCK_TTL_MS) return;
  // Stale: reclaim by renaming aside. Only one racer's rename succeeds; the loser
  // gets ENOENT and simply retries the exclusive create.
  const aside = `${lockPath}.stale-${process.pid}-${tmpCounter++}`;
  await rename(lockPath, aside).catch(() => undefined);
  await rm(aside, { force: true }).catch(() => undefined);
}

/**
 * Atomically replace `targetPath`'s contents: same-dir unique temp + fsync +
 * retried atomic rename + best-effort dir fsync. Throws (leaving the target's
 * OLD complete contents intact) rather than ever truncating in place.
 */
export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const dir = dirname(targetPath);
  const tmpPath = join(dir, `.${basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${tmpCounter++}`);
  const fh = await open(tmpPath, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameWithRetry(tmpPath, targetPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
  // Best-effort directory fsync so the rename is durable (unsupported on some
  // platforms — never fatal).
  try {
    const dh = await open(dir, 'r');
    await dh.sync().catch(() => undefined);
    await dh.close();
  } catch {
    /* directory fsync unsupported — ignore */
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      // Windows/macOS can transiently fail an atomic rename over an open target.
      if (attempt < RENAME_ATTEMPTS && isCode(err, ...LEDGER_RENAME_RETRY_CODES)) {
        await sleep(RENAME_BACKOFF_MS * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Run `mutate(currentRawContents)` under the ledger lock and atomically write its
 * result. `mutate` receives the current raw ledger text ('' if absent) and
 * returns the new full text. The read-modify-write is serialized by the lock,
 * so concurrent writers can't lose each other's updates.
 */
export async function withLedgerWrite(
  workspaceDir: string,
  mutate: (rawContents: string) => string | Promise<string>,
): Promise<void> {
  const lock = await acquireLedgerLock(workspaceDir);
  try {
    let raw = '';
    try {
      raw = await readFile(stewardLedgerPath(workspaceDir), 'utf8');
    } catch (err) {
      if (!isCode(err, 'ENOENT')) throw err;
    }
    const next = await mutate(raw);
    await atomicWriteFile(stewardLedgerPath(workspaceDir), next);
  } finally {
    await lock.release();
  }
}
