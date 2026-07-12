import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { readWorkspaceFile } from '../file-service.js';
import { atomicWriteFile } from './ledger-writer.js';

const STEWARD_CONFIG_PATH = '.alice/steward/config.json';

export interface StewardSessionConfigPreparation {
  /** Accept the published pointer and release this workspace's preparation lock. */
  commit(): Promise<void>;
  /** Restore the exact file state that preceded this preparation. */
  rollback(): Promise<void>;
}

export class StewardSessionConfigOwnershipError extends Error {
  constructor(path: string) {
    super(`steward session config changed after preparation; refusing stale rollback: ${path}`);
    this.name = 'StewardSessionConfigOwnershipError';
  }
}

export interface StewardSessionConfigLease {
  release(): void;
}

interface LeaseWaiter {
  grant(): void;
}

/** Per-config FIFO lease queue. Exported for deterministic contract tests; the
 * production preparation path uses the singleton immediately below. */
export class StewardSessionConfigLeaseQueue {
  private readonly waitersByKey = new Map<string, LeaseWaiter[]>();

  acquire(key: string, onGranted?: () => void): Promise<StewardSessionConfigLease> {
    return new Promise((resolveLease) => {
      const waiter: LeaseWaiter = {
        grant: () => {
          let released = false;
          onGranted?.();
          resolveLease({
            release: () => {
              if (released) return;
              released = true;
              const waiters = this.waitersByKey.get(key);
              if (!waiters || waiters[0] !== waiter) return;
              waiters.shift();
              if (waiters.length === 0) {
                this.waitersByKey.delete(key);
              } else {
                waiters[0]!.grant();
              }
            },
          });
        },
      };
      const waiters = this.waitersByKey.get(key);
      if (waiters) {
        waiters.push(waiter);
      } else {
        this.waitersByKey.set(key, [waiter]);
        waiter.grant();
      }
    });
  }
}

const preparationLeaseQueue = new StewardSessionConfigLeaseQueue();

export interface StewardSessionConfigPreparationOptions {
  /** Injectable only for deterministic ownership tests; production uses the
   * module singleton so every caller in the process shares one queue. */
  readonly leaseQueue?: StewardSessionConfigLeaseQueue;
  readonly onLeaseGranted?: () => void;
}

/**
 * Persist the session pointer before a seeded PTY can receive its wake, while
 * retaining an exact compensating action if the subsequent spawn fails.
 */
export async function prepareStewardSessionConfig(
  workspaceDir: string,
  current: Record<string, unknown>,
  sessionId: string,
  agent: string,
  opts: StewardSessionConfigPreparationOptions = {},
): Promise<StewardSessionConfigPreparation> {
  const targetPath = join(workspaceDir, STEWARD_CONFIG_PATH);
  const lease = await (opts.leaseQueue ?? preparationLeaseQueue).acquire(
    resolve(targetPath),
    opts.onLeaseGranted,
  );
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    const previousRaw = await readWorkspaceFile(workspaceDir, STEWARD_CONFIG_PATH);
    const next = {
      ...current,
      version: typeof current['version'] === 'number' ? current['version'] : 1,
      agent,
      sessionId,
    };
    const publishedRaw = `${JSON.stringify(next, null, 2)}\n`;
    // `atomicWriteFile` is the steward's established same-directory unique-temp
    // + file-fsync + retried-rename path. A failed preparation therefore leaves
    // the previous complete config visible and never needs a rollback handle to
    // repair a truncate-in-place write.
    await atomicWriteFile(targetPath, publishedRaw);

    let settlement: Promise<void> | null = null;
    const settle = (mode: 'commit' | 'rollback'): Promise<void> => {
      if (settlement) return settlement;
      settlement = (async () => {
        try {
          if (mode === 'commit') return;
          const currentRaw = await readWorkspaceFile(workspaceDir, STEWARD_CONFIG_PATH);
          if (currentRaw !== publishedRaw) {
            throw new StewardSessionConfigOwnershipError(targetPath);
          }
          if (previousRaw === null) {
            await rm(targetPath, { force: true });
            await syncDirectory(dirname(targetPath));
          } else {
            await atomicWriteFile(targetPath, previousRaw);
          }
        } finally {
          lease.release();
        }
      })();
      return settlement;
    };
    return {
      commit: () => settle('commit'),
      rollback: () => settle('rollback'),
    };
  } catch (err) {
    lease.release();
    throw err;
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unavailable on some platforms; removal is still an
    // atomic namespace operation there, with durability remaining best-effort.
  }
}
