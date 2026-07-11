import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { stewardMachineThreadPath } from '../paths.js';
import {
  MACHINE_THREAD_SCHEMA_VERSION,
  parseMachineThreadState,
  type MachineThreadState,
} from './types.js';

export interface MachineThreadWriteInput {
  readonly threadId: string;
  readonly model?: string;
  readonly createdAt: string;
  /** ISO of the last turn; omit/null when the thread has not taken a turn yet. */
  readonly lastTurnAt?: string | null;
}

/**
 * Per-workspace machine control-face thread state (issue #146) — one file per
 * workspace at `.alice/steward/machine-thread.json`. This is the persistent
 * handle a later wake resumes the SAME codex thread from, across Alice restarts
 * (S0 proved thread/resume needs only the id). Same atomic tmp+rename write and
 * lenient read as the neighboring steward stores (`finalize-store`,
 * `wake-store`): a missing OR corrupt file resolves to null — absence is always
 * a valid state — never throws.
 */
export class MachineThreadStore {
  constructor(private readonly workspaceDir: string) {}

  async read(): Promise<MachineThreadState | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(), 'utf8');
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
    try {
      return parseMachineThreadState(JSON.parse(raw));
    } catch {
      // A partial/corrupt record is treated as "no thread yet" — the next wake
      // starts a fresh thread rather than resuming off a bad id.
      return null;
    }
  }

  /** Atomically write-or-replace the workspace's thread record. tmp+rename so a
   *  reader never observes a partial file. */
  async write(input: MachineThreadWriteInput): Promise<MachineThreadState> {
    const state = parseMachineThreadState({
      version: MACHINE_THREAD_SCHEMA_VERSION,
      provider: 'codex',
      threadId: input.threadId,
      ...(input.model !== undefined ? { model: input.model } : {}),
      createdAt: input.createdAt,
      lastTurnAt: input.lastTurnAt ?? null,
    });
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return state;
  }

  path(): string {
    return stewardMachineThreadPath(this.workspaceDir);
  }
}

export function createMachineThreadStore(workspaceDir: string): MachineThreadStore {
  return new MachineThreadStore(workspaceDir);
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
