import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  WAKE_SCHEMA_VERSION,
  parseStewardWakeRecord,
  type StewardWakeEnvelope,
  type StewardWakeRecord,
  type StewardWakeStatus,
} from './types.js';
import { stewardWakeFilename, stewardWakePath, stewardWakesDir } from './paths.js';

export interface CreateWakeInput {
  readonly wakeId: string;
  readonly deadline: string;
  readonly envelope: StewardWakeEnvelope;
  readonly now?: string;
  readonly sessionId?: string | null;
}

export interface WakeStatusPatch {
  readonly injectedAt?: string | null;
  readonly completedAt?: string | null;
  readonly sessionId?: string | null;
  readonly error?: string | null;
  readonly now?: string;
}

export class StewardWakeStore {
  constructor(private readonly workspaceDir: string) {}

  async create(input: CreateWakeInput): Promise<StewardWakeRecord> {
    if (await this.get(input.wakeId)) {
      throw new Error(`steward wake already exists: ${input.wakeId}`);
    }
    const now = input.now ?? new Date().toISOString();
    const record = parseStewardWakeRecord({
      version: WAKE_SCHEMA_VERSION,
      wakeId: input.wakeId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      injectedAt: null,
      deadline: input.deadline,
      sessionId: input.sessionId ?? null,
      envelope: input.envelope,
    });
    await writeJsonAtomic(this.pathFor(input.wakeId), record);
    return record;
  }

  async get(wakeId: string): Promise<StewardWakeRecord | null> {
    try {
      return parseStewardWakeRecord(JSON.parse(await readFile(this.pathFor(wakeId), 'utf8')));
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  async require(wakeId: string): Promise<StewardWakeRecord> {
    const record = await this.get(wakeId);
    if (!record) throw new Error(`steward wake not found: ${wakeId}`);
    return record;
  }

  async updateStatus(
    wakeId: string,
    status: StewardWakeStatus,
    patch: WakeStatusPatch = {},
  ): Promise<StewardWakeRecord> {
    const current = await this.require(wakeId);
    const candidate: Partial<StewardWakeRecord> = {
      ...current,
      status,
      updatedAt: patch.now ?? new Date().toISOString(),
      injectedAt: patch.injectedAt !== undefined ? patch.injectedAt : current.injectedAt,
      completedAt: patch.completedAt !== undefined ? patch.completedAt : current.completedAt,
      sessionId: patch.sessionId !== undefined ? patch.sessionId : current.sessionId,
    };
    if (patch.error === null) {
      delete candidate.error;
    } else if (patch.error !== undefined) {
      candidate.error = patch.error;
    }
    const next = parseStewardWakeRecord(candidate);
    await writeJsonAtomic(this.pathFor(wakeId), next);
    return next;
  }

  async list(): Promise<StewardWakeRecord[]> {
    let names: string[];
    try {
      names = await readdir(stewardWakesDir(this.workspaceDir));
    } catch (err) {
      if (isENOENT(err)) return [];
      throw err;
    }
    const records: StewardWakeRecord[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (!name.endsWith('.json')) continue;
      const raw = await readFile(join(stewardWakesDir(this.workspaceDir), name), 'utf8');
      records.push(parseStewardWakeRecord(JSON.parse(raw)));
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  pathFor(wakeId: string): string {
    return stewardWakePath(this.workspaceDir, wakeId);
  }

  filenameFor(wakeId: string): string {
    return stewardWakeFilename(wakeId);
  }
}

export function createStewardWakeStore(workspaceDir: string): StewardWakeStore {
  return new StewardWakeStore(workspaceDir);
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
