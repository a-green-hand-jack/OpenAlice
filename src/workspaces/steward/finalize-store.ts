import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { stewardFinalizePath } from './paths.js';
import {
  STEWARD_FINALIZE_MARKER_SCHEMA_VERSION,
  parseStewardFinalizeMarker,
  type StewardFinalizeMarker,
} from './types.js';

/**
 * Per-wake finalization markers (issue #136 finalize barrier).
 *
 * The generated `validate-ledger.mjs` (plain JS, in-workspace) is the canonical
 * WRITER — it publishes a marker atomically after a wake's entry passes every
 * check. This TS store is the READER the supervisor uses to gate terminalization,
 * plus an atomic writer used by tests and any TS-side path. Marker read is
 * lenient and failure-isolated: a missing or unparseable marker resolves to
 * null (the wake simply isn't finalized yet), never throws.
 */
export class StewardFinalizeStore {
  constructor(private readonly workspaceDir: string) {}

  async read(wakeId: string): Promise<StewardFinalizeMarker | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(wakeId), 'utf8');
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
    try {
      return parseStewardFinalizeMarker(JSON.parse(raw));
    } catch {
      // A corrupt/partial marker is treated as "not finalized" — the wake waits
      // for a clean re-validation rather than terminalizing off a bad marker.
      return null;
    }
  }

  /** Atomically publish (write-or-replace) the marker for `wakeId`. tmp+rename
   *  so a reader never sees a partial file; a re-validation replaces it. */
  async write(input: {
    readonly wakeId: string;
    readonly fingerprint: string;
    readonly validatedAt: string;
    readonly schemaVersion?: number;
  }): Promise<StewardFinalizeMarker> {
    const marker = parseStewardFinalizeMarker({
      version: STEWARD_FINALIZE_MARKER_SCHEMA_VERSION,
      wakeId: input.wakeId,
      fingerprint: input.fingerprint,
      validatedAt: input.validatedAt,
      ...(input.schemaVersion !== undefined ? { schemaVersion: input.schemaVersion } : {}),
    });
    const path = this.path(input.wakeId);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return marker;
  }

  path(wakeId: string): string {
    return stewardFinalizePath(this.workspaceDir, wakeId);
  }
}

export function createStewardFinalizeStore(workspaceDir: string): StewardFinalizeStore {
  return new StewardFinalizeStore(workspaceDir);
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
