/**
 * Reads a workspace's own `.alice/steward/config.json` (monthly budget /
 * cost-policy overrides, plus the persistent session pointer written by
 * `writeStewardSessionConfig`). Shared by every caller that needs the raw
 * config object — the manual wake/tick HTTP routes
 * (`src/webui/routes/workspaces.ts`) and the self-ticking
 * `StewardSupervisorScanner` (`./supervisor-scanner.ts`) — so the read +
 * shape-validation logic can't drift between them.
 */

import { readWorkspaceFile } from '../file-service.js';

/** The slice of WorkspaceMeta this only needs — avoids a hard dependency on
 *  the full type for callers that only have a `dir`. */
export interface StewardConfigWorkspace {
  readonly dir: string;
}

/**
 * Reads and parses `.alice/steward/config.json`. Returns `{}` when the file
 * is absent or empty. Throws if the file exists but isn't a JSON object.
 */
export async function readStewardConfig(ws: StewardConfigWorkspace): Promise<Record<string, unknown>> {
  const raw = await readWorkspaceFile(ws.dir, '.alice/steward/config.json');
  if (raw === null || raw.trim() === '') return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('.alice/steward/config.json must be an object');
  }
  return parsed as Record<string, unknown>;
}
