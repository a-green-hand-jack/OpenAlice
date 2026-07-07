import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DEFAULT_AUTHZ_LEVEL, isAuthzLevel, normalizeAuthzLevel, type AuthzLevel } from '@traderalice/uta-protocol';

import type { Logger } from './logger.js';

export interface WorkspaceMeta {
  /** Stable identifier; used as the wsId for sessions and the directory name. */
  readonly id: string;
  /** Human-facing tag; what the user typed when creating. */
  readonly tag: string;
  /** Absolute path the bootstrap script materialised the workspace at. */
  readonly dir: string;
  /** ISO timestamp. */
  readonly createdAt: string;
  /** Template that created this workspace. Optional for backward compatibility with pre-templates entries. */
  readonly template?: string;
  /**
   * Immutable lineage: the template's `version` at the moment this workspace
   * was spawned. Written once by the creator, never updated. Used by the
   * Overview UI to display "from {template} v{spawnedFromVersion}" and as a
   * fallback when the instance's own README is unreadable.
   *
   * Pre-version-tracking rows (loaded from older `workspaces.json`) are
   * missing this field — treat as unknown rather than back-filling.
   */
  readonly spawnedFromVersion?: string;
  /**
   * Launcher-owned Steward authorization level. This must stay in
   * workspaces.json, not `.alice/workspace.json`, because agent-editable
   * workspace files must never be able to self-escalate authorization.
   *
   * Optional for P3-1 compatibility; absent resolves to read_only.
   */
  readonly authzLevel?: AuthzLevel;
  /**
   * Blind workspaces are campaign sandboxes: their agent tool catalog is sealed
   * away from real vendor/ticker market data while preserving allowlisted mock
   * barIds.
   */
  readonly blind?: boolean;
  /** Allowlisted barId sources (`source` in `source|symbol`) for blind mode. */
  readonly blindAllowBarSources?: readonly string[];
  /**
   * Adapter ids enabled in this workspace. Order is significant: the first
   * entry is the default for one-click spawns. Legacy rows (missing this
   * field) are normalized to `['claude']` at load time.
   */
  readonly agents: readonly string[];
}

interface FileShape {
  readonly version: 1;
  readonly workspaces: WorkspaceMeta[];
}

/**
 * Source of truth for which workspaces exist.
 *
 * Persisted as a single JSON file at `$LAUNCHER_ROOT/workspaces.json`.
 * Writes are atomic (write-temp + rename) so a crash mid-write can't corrupt
 * the file — the previous version stays intact.
 */
export class WorkspaceRegistry {
  private readonly byId = new Map<string, WorkspaceMeta>();
  private readonly tagsInUse = new Set<string>();

  private constructor(private readonly path: string) {}

  static async load(path: string, logger: Logger): Promise<WorkspaceRegistry> {
    const reg = new WorkspaceRegistry(path);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const entries = validateFile(parsed);
      for (const ws of entries) {
        reg.byId.set(ws.id, ws);
        reg.tagsInUse.add(ws.tag);
      }
      logger.info('registry.loaded', { path, count: entries.length });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('registry.fresh', { path });
        await mkdir(dirname(path), { recursive: true });
        await reg.flush();
      } else {
        throw err;
      }
    }
    return reg;
  }

  list(): WorkspaceMeta[] {
    return Array.from(this.byId.values()).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  get(id: string): WorkspaceMeta | undefined {
    return this.byId.get(id);
  }

  hasId(id: string): boolean {
    return this.byId.has(id);
  }

  hasTag(tag: string): boolean {
    return this.tagsInUse.has(tag);
  }

  async add(ws: WorkspaceMeta): Promise<void> {
    if (this.byId.has(ws.id)) {
      throw new Error(`workspace id already registered: ${ws.id}`);
    }
    if (this.tagsInUse.has(ws.tag)) {
      throw new Error(`workspace tag already in use: ${ws.tag}`);
    }
    this.byId.set(ws.id, ws);
    this.tagsInUse.add(ws.tag);
    await this.flush();
  }

  async setAuthzLevel(id: string, authzLevel: AuthzLevel): Promise<{
    workspace: WorkspaceMeta;
    from: AuthzLevel;
    to: AuthzLevel;
    changed: boolean;
  } | undefined> {
    const current = this.byId.get(id);
    if (!current) return undefined;
    const from = normalizeAuthzLevel(current.authzLevel);
    const next: WorkspaceMeta = { ...current, authzLevel };
    this.byId.set(id, next);
    await this.flush();
    return { workspace: next, from, to: authzLevel, changed: from !== authzLevel };
  }

  async remove(id: string): Promise<WorkspaceMeta | undefined> {
    const ws = this.byId.get(id);
    if (!ws) return undefined;
    this.byId.delete(id);
    this.tagsInUse.delete(ws.tag);
    await this.flush();
    return ws;
  }

  private async flush(): Promise<void> {
    const payload: FileShape = {
      version: 1,
      workspaces: Array.from(this.byId.values()),
    };
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tmp, this.path);
  }
}

function validateFile(value: unknown): WorkspaceMeta[] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('workspaces.json: root must be an object');
  }
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1) {
    throw new Error(`workspaces.json: unsupported version ${String(v['version'])}`);
  }
  if (!Array.isArray(v['workspaces'])) {
    throw new Error('workspaces.json: workspaces must be an array');
  }
  return v['workspaces'].map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`workspaces.json: entry ${i} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e['id'] !== 'string' ||
      typeof e['tag'] !== 'string' ||
      typeof e['dir'] !== 'string' ||
      typeof e['createdAt'] !== 'string'
    ) {
      throw new Error(`workspaces.json: entry ${i} has wrong shape`);
    }
    const agents = Array.isArray(e['agents'])
      ? (e['agents'].filter((a): a is string => typeof a === 'string') as string[])
      : ['claude']; // legacy migration
    const base: WorkspaceMeta = {
      id: e['id'],
      tag: e['tag'],
      dir: e['dir'],
      createdAt: e['createdAt'],
      agents: agents.length > 0 ? agents : ['claude'],
    };
    let withTemplate: WorkspaceMeta = typeof e['template'] === 'string'
      ? { ...base, template: e['template'] }
      : base;
    if (typeof e['spawnedFromVersion'] === 'string') {
      withTemplate = { ...withTemplate, spawnedFromVersion: e['spawnedFromVersion'] };
    }
    if (e['authzLevel'] !== undefined) {
      if (!isAuthzLevel(e['authzLevel'])) {
        console.warn(
          `workspaces.json: entry ${i} (${e['id']}) has invalid authzLevel ` +
          `${JSON.stringify(e['authzLevel'])}; degrading that row to ${DEFAULT_AUTHZ_LEVEL}.`,
        );
        withTemplate = { ...withTemplate, authzLevel: DEFAULT_AUTHZ_LEVEL };
      } else {
        withTemplate = { ...withTemplate, authzLevel: e['authzLevel'] };
      }
    }
    if (e['blind'] !== undefined) {
      if (typeof e['blind'] === 'boolean') {
        if (e['blind']) withTemplate = { ...withTemplate, blind: true };
      } else {
        console.warn(
          `workspaces.json: entry ${i} (${e['id']}) has invalid blind ` +
          `${JSON.stringify(e['blind'])}; degrading that row to blind=false.`,
        );
      }
    }
    if (e['blindAllowBarSources'] !== undefined) {
      if (Array.isArray(e['blindAllowBarSources'])) {
        const sources = [...new Set(e['blindAllowBarSources']
          .filter((s): s is string => typeof s === 'string')
          .map((s) => s.trim())
          .filter((s) => s.length > 0))];
        withTemplate = { ...withTemplate, blindAllowBarSources: sources };
        if (sources.length !== e['blindAllowBarSources'].length) {
          console.warn(
            `workspaces.json: entry ${i} (${e['id']}) has invalid blindAllowBarSources entries; ` +
            'dropping non-string/empty values.',
          );
        }
      } else {
        console.warn(
          `workspaces.json: entry ${i} (${e['id']}) has invalid blindAllowBarSources ` +
          `${JSON.stringify(e['blindAllowBarSources'])}; degrading that row to an empty allowlist.`,
        );
        withTemplate = { ...withTemplate, blindAllowBarSources: [] };
      }
    }
    return withTemplate;
  });
}
