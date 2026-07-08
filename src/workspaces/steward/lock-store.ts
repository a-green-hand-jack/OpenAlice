import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

export class StewardLockStore {
  constructor(private readonly workspaceDir: string) {}

  async acquire(input: AcquireStewardLockInput): Promise<StewardLockRecord> {
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
    await writeJsonAtomic(this.pathFor(input.accountId), next);
    return next;
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
