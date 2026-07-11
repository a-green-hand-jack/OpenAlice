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
import { stewardConfigSchema } from './types.js';

/** The slice of WorkspaceMeta this only needs — avoids a hard dependency on
 *  the full type for callers that only have a `dir`. */
export interface StewardConfigWorkspace {
  readonly dir: string;
}

export interface ReadStewardConfigOptions {
  /**
   * Structured warning sink (issue #153). Fired AT MOST ONCE per successful
   * read, and ONLY when the parsed config has a recognized key (`controlFace`,
   * `sessionRotation`, …) carrying a value of the wrong shape — e.g.
   * `controlFace: 'PTY'` (typo) or `sessionRotation.threshold: "high"`. Absent
   * recognized keys, or unrecognized ones, are never warned about — this
   * validates VALUES, not schema completeness, so a forward-compatible new key
   * never trips it. Mirrors `rotation.ts`'s `onWarn` convention: a plain
   * callback, not a `Logger`, so this module stays decoupled from the logger
   * type. Never blocks the read — the caller always gets the config back
   * exactly as parsed; the S6 fail-safe in `decideStewardControlFace` stays
   * the sole enforcement point for a bad `controlFace`.
   */
  readonly onWarn?: (message: string, detail: Record<string, unknown>) => void;
}

/**
 * Reads and parses `.alice/steward/config.json`. Returns `{}` when the file
 * is absent or empty. Throws if the file exists but isn't a JSON object (or
 * isn't valid JSON at all) — unchanged from the pre-#153 behavior; callers
 * already own mapping that failure to their own error surface (HTTP 500 vs a
 * logged skip). `opts.onWarn`, when provided, additionally surfaces a
 * load-time validation warning for a successfully-parsed object with
 * recognized-but-invalid field values (issue #153) — see
 * {@link ReadStewardConfigOptions.onWarn}.
 */
export async function readStewardConfig(
  ws: StewardConfigWorkspace,
  opts: ReadStewardConfigOptions = {},
): Promise<Record<string, unknown>> {
  const raw = await readWorkspaceFile(ws.dir, '.alice/steward/config.json');
  if (raw === null || raw.trim() === '') return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('.alice/steward/config.json must be an object');
  }
  const config = parsed as Record<string, unknown>;
  if (opts.onWarn) {
    const issues = describeStewardConfigIssues(config);
    if (issues.length > 0) opts.onWarn('steward.config_invalid', { issues });
  }
  return config;
}

/** One `key=value (reason)` string per recognized field whose value fails
 *  {@link stewardConfigSchema} — e.g. `controlFace="PTY" (Invalid option...)`. */
function describeStewardConfigIssues(config: Record<string, unknown>): string[] {
  const result = stewardConfigSchema.safeParse(config);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    return `${path}=${JSON.stringify(getAtPath(config, issue.path))} (${issue.message})`;
  });
}

function getAtPath(obj: Record<string, unknown>, path: readonly PropertyKey[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key as string];
  }
  return current;
}
