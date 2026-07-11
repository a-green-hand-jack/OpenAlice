import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { stewardMachineThreadPath } from '../paths.js';
import {
  MACHINE_THREAD_SCHEMA_VERSION,
  parseMachineThreadState,
  type MachineThreadProvider,
  type MachineThreadState,
} from './types.js';

export interface MachineThreadWriteInput {
  readonly threadId: string;
  /**
   * The native provider that owns this thread id (issue #146 S5). A resume only
   * happens when a later wake's provider matches this — a `codex` thread cannot
   * be resumed by the claude face, and vice versa. Defaults to `codex` for
   * backward compatibility with pre-S5 callers and records.
   */
  readonly provider?: MachineThreadProvider;
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
 *
 * SINGLE-THREAD-PER-WORKSPACE ASSUMPTION (issue #146 S4): there is exactly ONE
 * record per workspace, not one per account. A steward workspace that manages
 * several accounts multiplexes all of them onto the SAME native thread — the
 * per-account isolation the account lock gives PTY wakes is NOT extended to the
 * machine thread here. That is deliberate for S4 (a steward workspace is one
 * agent with one persistent context) and unenforced: nothing stops a caller
 * from dispatching two accounts' wakes onto one thread, and the driver's
 * one-turn-per-thread invariant would simply serialize them. Per-account thread
 * partitioning, if ever needed, is out of scope and would key this store by
 * accountId.
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
      provider: input.provider ?? 'codex',
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
