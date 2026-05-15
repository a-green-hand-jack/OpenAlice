/**
 * Hono routes for the Workspaces feature, mounted at /api/workspaces.
 *
 * Thin adapter over WorkspaceService — each handler dispatches to the same
 * launcher domain modules (registry / pool / creator / sessionRegistry) that
 * the original `server/src/index.ts` `handleHttp` switch did.
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import { listDir, PathTraversal, readWorkspaceFile, writeWorkspaceFile } from '../../workspaces/file-service.js';
import { gitLog, gitStatus } from '../../workspaces/git-service.js';
import { logger as launcherLogger } from '../../workspaces/logger.js';
import type { SessionRecord } from '../../workspaces/session-registry.js';
import type { SessionFactoryContext, WorkspaceService } from '../../workspaces/service.js';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createWorkspaceRoutes(svc: WorkspaceService): Hono {
  const app = new Hono();

  // ── templates / agents ───────────────────────────────────────────────────

  app.get('/templates', (c) => {
    return c.json({
      templates: svc.templates.list().map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.displayName !== undefined ? { displayName: t.displayName } : {}),
        ...(t.groupOrder !== undefined ? { groupOrder: t.groupOrder } : {}),
        defaultAgents: t.defaultAgents,
      })),
    });
  });

  app.get('/agents', (c) => {
    return c.json({
      agents: svc.adapters.list().map((a) => ({
        id: a.id,
        displayName: a.displayName,
        capabilities: a.capabilities,
      })),
    });
  });

  // ── workspaces collection ────────────────────────────────────────────────

  app.get('/', async (c) => {
    const workspaces = await Promise.all(svc.registry.list().map((w) => svc.publicMeta(w)));
    return c.json({ workspaces });
  });

  app.post('/', async (c) => {
    const body = await safeJson(c);
    const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const tag = fields['tag'];
    if (typeof tag !== 'string') {
      return c.json({ error: 'tag_required' }, 400);
    }
    const rawTemplate = fields['template'];
    let templateName: string;
    if (typeof rawTemplate === 'string' && rawTemplate.length > 0) {
      templateName = rawTemplate;
    } else {
      const def = svc.templates.defaultName();
      if (!def) {
        return c.json({
          error: 'no_templates_configured',
          message: 'no templates discovered; set AQ_TEMPLATES_DIR or AQ_BOOTSTRAP_SCRIPT',
        }, 500);
      }
      templateName = def;
    }
    const rawAgents = fields['agents'];
    const agentsRequested = Array.isArray(rawAgents)
      ? rawAgents.filter((a): a is string => typeof a === 'string' && a.length > 0)
      : undefined;
    const result = await svc.creator.create(
      tag,
      templateName,
      agentsRequested && agentsRequested.length > 0 ? agentsRequested : undefined,
    );
    if (!result.ok) {
      const status =
        result.code === 'invalid_tag' ? 400
        : result.code === 'unknown_template' ? 400
        : result.code === 'unknown_agent' ? 400
        : result.code === 'tag_in_use' ? 409
        : 500;
      return c.json({
        error: result.code,
        message: result.message,
        stderr: 'stderr' in result && result.stderr ? result.stderr.slice(-4000) : undefined,
      }, status);
    }
    return c.json({ workspace: await svc.publicMeta(result.workspace) }, 201);
  });

  // ── single workspace (DELETE + git/files sub-resources) ──────────────────

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'not_found' }, 404);
    const purge = c.req.query('purge') === 'true';
    svc.pool.dispose(id, 'workspace deleted');
    const removed = await svc.registry.remove(id);
    if (!removed) return c.json({ error: 'not_found' }, 404);
    const droppedRecords = await svc.sessionRegistry
      .removeAllFor(id)
      .catch((err) => {
        launcherLogger.warn('session_registry.remove_all_failed', { id, err });
        return [] as readonly SessionRecord[];
      });
    await svc.scrollbackStore.removeAllFor(id);
    let purged = false;
    if (purge) {
      try {
        const { rm } = await import('node:fs/promises');
        await rm(removed.dir, { recursive: true, force: true });
        purged = true;
      } catch (err) {
        launcherLogger.error('workspace.purge_failed', { id, dir: removed.dir, err });
      }
    }
    launcherLogger.info('workspace.removed', {
      id,
      dir: removed.dir,
      purged,
      droppedSessions: droppedRecords.length,
    });
    return c.json({ ok: true, purged });
  });

  app.get('/:id/git/log', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'not_found' }, 404);
    const meta = svc.registry.get(id);
    if (!meta) return c.json({ error: 'not_found' }, 404);
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '30', 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 30;
    try {
      const entries = await gitLog(meta.dir, limit);
      return c.json({ entries });
    } catch (err) {
      launcherLogger.warn('git.log_failed', { id, err });
      return c.json({ error: 'git_failed', message: (err as Error).message }, 500);
    }
  });

  app.get('/:id/git/status', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'not_found' }, 404);
    const meta = svc.registry.get(id);
    if (!meta) return c.json({ error: 'not_found' }, 404);
    try {
      const status = await gitStatus(meta.dir);
      return c.json(status);
    } catch (err) {
      launcherLogger.warn('git.status_failed', { id, err });
      return c.json({ error: 'git_failed', message: (err as Error).message }, 500);
    }
  });

  app.get('/:id/files', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'not_found' }, 404);
    const meta = svc.registry.get(id);
    if (!meta) return c.json({ error: 'not_found' }, 404);
    const p = c.req.query('path') ?? '';
    try {
      const listing = await listDir(meta.dir, p);
      return c.json(listing);
    } catch (err) {
      if (err instanceof PathTraversal) {
        return c.json({ error: 'invalid_path', message: err.message }, 400);
      }
      launcherLogger.warn('files.list_failed', { id, path: p, err });
      return c.json({ error: 'list_failed', message: (err as Error).message }, 500);
    }
  });

  /**
   * Read a single UTF-8 text file from inside a workspace. Used by the
   * Inbox detail pane to render `docs` pointers live (no snapshot — the
   * workspace folder is the source of truth, see InboxStore doc).
   *
   * 404 when the workspace or the file is missing — callers (Inbox UI)
   * use this to render tombstone states. Larger than 1 MiB returns 413
   * so the inbox can't be weaponised into a large-file viewer.
   */
  app.get('/:id/file', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'not_found' }, 404);
    const meta = svc.registry.get(id);
    if (!meta) return c.json({ error: 'workspace_not_found' }, 404);
    const p = c.req.query('path') ?? '';
    if (!p) return c.json({ error: 'path required' }, 400);
    try {
      const content = await readWorkspaceFile(meta.dir, p);
      if (content === null) return c.json({ error: 'file_not_found' }, 404);
      if (content.length > 1024 * 1024) {
        return c.json({ error: 'file_too_large', sizeBytes: content.length }, 413);
      }
      return c.json({ path: p, content });
    } catch (err) {
      if (err instanceof PathTraversal) {
        return c.json({ error: 'invalid_path', message: err.message }, 400);
      }
      launcherLogger.warn('files.read_failed', { id, path: p, err });
      return c.json({ error: 'read_failed', message: (err as Error).message }, 500);
    }
  });

  // ── sessions ─────────────────────────────────────────────────────────────

  app.post('/:id/sessions/spawn', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'not_found' }, 404);
    const meta = svc.registry.get(id);
    if (!meta) return c.json({ error: 'not_found' }, 404);

    let resume: SessionFactoryContext['resume'];
    let agentId: string | undefined;
    try {
      const body = await safeJson(c);
      const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      const raw = fields['resume'];
      if (raw === 'last') resume = 'last';
      else if (typeof raw === 'string' && SESSION_ID_RE.test(raw)) resume = { sessionId: raw };
      const rawAgent = fields['agent'];
      if (typeof rawAgent === 'string' && rawAgent.length > 0) agentId = rawAgent;
    } catch (err) {
      return c.json({ error: 'bad_request', message: (err as Error).message }, 400);
    }
    if (agentId && !svc.adapters.get(agentId)) {
      return c.json({ error: 'unknown_agent', message: `no adapter: ${agentId}` }, 400);
    }
    const adapter = svc.resolveAdapter(meta, agentId);
    try {
      if (adapter.bootstrap) {
        await adapter.bootstrap({
          wsId: id,
          cwd: meta.dir,
          launcherRepoRoot: svc.config.launcherRepoRoot,
        });
      }
    } catch (err) {
      launcherLogger.error('adapter.bootstrap_failed', { id, agent: adapter.id, err });
      return c.json({ error: 'bootstrap_failed', message: (err as Error).message }, 500);
    }
    await svc.sessionRegistry.ensureLoaded(id);
    const prefix = adapter.namePrefix ?? adapter.id[0] ?? 's';
    const recordId = randomUUID();
    const recordName = svc.sessionRegistry.nextName(id, adapter.id, prefix);
    const nowIso = new Date().toISOString();
    const record: SessionRecord = {
      id: recordId,
      wsId: id,
      agent: adapter.id,
      name: recordName,
      createdAt: nowIso,
      lastActiveAt: nowIso,
      state: 'running',
    };
    try {
      await svc.sessionRegistry.create(record);
    } catch (err) {
      launcherLogger.error('session_registry.create_failed', { id, recordId, err });
      return c.json({ error: 'registry_failed', message: (err as Error).message }, 500);
    }
    try {
      const ctx: SessionFactoryContext = {
        ...(resume !== undefined ? { resume } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        recordId,
        recordName,
      };
      const session = svc.pool.spawn(id, ctx);
      launcherLogger.info('workspace.session_spawned', {
        id,
        sessionId: session.recordId,
        name: session.name,
        pid: session.pid,
        agent: adapter.id,
        resume: resume === undefined ? null : resume === 'last' ? 'last' : resume.sessionId,
      });
      return c.json({
        sessionId: session.recordId,
        wsId: session.wsId,
        name: session.name,
        pid: session.pid,
        agent: adapter.id,
        agentSessionId: session.agentSessionId,
        startedAt: session.startedAt,
      }, 201);
    } catch (err) {
      await svc.sessionRegistry.remove(id, recordId).catch(() => undefined);
      launcherLogger.error('workspace.session_spawn_failed', { id, err });
      return c.json({ error: 'spawn_failed', message: (err as Error).message }, 500);
    }
  });

  // pause / stop (alias)
  for (const action of ['pause', 'stop'] as const) {
    app.post(`/:id/sessions/:sid/${action}`, async (c) => {
      const id = c.req.param('id');
      const token = c.req.param('sid');
      if (!validId(id) || !SESSION_ID_RE.test(token)) {
        return c.json({ error: 'not_found' }, 404);
      }
      const record = svc.sessionRegistry.get(id, token);
      const live = svc.pool.get(token);
      if (!record && !live) return c.json({ error: 'not_found' }, 404);

      let scrollbackRel: string | null = null;
      if (record?.agent === 'shell' && live) {
        try {
          const dump = live.dumpReplayBuffer();
          if (dump.length > 0) {
            scrollbackRel = await svc.scrollbackStore.dump(id, token, dump);
          }
        } catch (err) {
          launcherLogger.warn('scrollback.dump_failed', { id, token, err });
        }
      }
      const wasRunning = svc.pool.disposeToken(token, action === 'pause' ? 'paused' : 'tab stop');
      if (record) {
        const patch: Partial<SessionRecord> = {
          state: 'paused',
          lastActiveAt: new Date().toISOString(),
        };
        if (scrollbackRel) patch.scrollbackFile = scrollbackRel;
        await svc.sessionRegistry
          .update(id, token, patch)
          .catch((err) =>
            launcherLogger.warn('session_registry.pause_update_failed', { id, token, err }),
          );
      }
      launcherLogger.info('workspace.session_paused', {
        id,
        sessionId: token,
        wasRunning,
        via: action,
        scrollback: scrollbackRel ?? null,
      });
      return c.json({ ok: true, wasRunning });
    });
  }

  app.post('/:id/sessions/:sid/resume', async (c) => {
    const id = c.req.param('id');
    const token = c.req.param('sid');
    if (!validId(id) || !SESSION_ID_RE.test(token)) {
      return c.json({ error: 'not_found' }, 404);
    }
    const record = svc.sessionRegistry.get(id, token);
    if (!record) return c.json({ error: 'not_found' }, 404);
    if (record.state === 'running' && svc.pool.get(token)) {
      return c.json({ ok: true, alreadyRunning: true });
    }
    const meta = svc.registry.get(id);
    if (!meta) return c.json({ error: 'workspace_not_found' }, 404);
    const adapter = svc.adapters.get(record.agent);
    if (!adapter) {
      return c.json({
        error: 'unknown_agent',
        message: `record references unknown adapter: ${record.agent}`,
      }, 500);
    }
    let resume: SessionFactoryContext['resume'];
    if (record.resumeHint && adapter.capabilities.resumeById) {
      resume = { sessionId: record.resumeHint.value };
    } else if (adapter.capabilities.resumeLast) {
      resume = 'last';
    }
    try {
      if (adapter.bootstrap) {
        await adapter.bootstrap({
          wsId: id,
          cwd: meta.dir,
          launcherRepoRoot: svc.config.launcherRepoRoot,
        });
      }
    } catch (err) {
      launcherLogger.error('adapter.bootstrap_failed_on_resume', { id, agent: adapter.id, err });
      return c.json({ error: 'bootstrap_failed', message: (err as Error).message }, 500);
    }
    let initialReplayBytes: Buffer | null = null;
    if (record.agent === 'shell' && record.scrollbackFile) {
      initialReplayBytes = await svc.scrollbackStore.read(record.scrollbackFile);
    }
    try {
      const ctx: SessionFactoryContext = {
        ...(resume !== undefined ? { resume } : {}),
        agentId: record.agent,
        recordId: record.id,
        recordName: record.name,
        ...(initialReplayBytes ? { initialReplayBytes } : {}),
      };
      const session = svc.pool.spawn(id, ctx);
      if (record.scrollbackFile) {
        await svc.scrollbackStore.remove(record.scrollbackFile);
        delete (record as { scrollbackFile?: string }).scrollbackFile;
      }
      await svc.sessionRegistry
        .update(id, token, { state: 'running', lastActiveAt: new Date().toISOString() })
        .catch((err) =>
          launcherLogger.warn('session_registry.resume_update_failed', { id, token, err }),
        );
      launcherLogger.info('workspace.session_resumed', {
        id,
        sessionId: token,
        name: session.name,
        pid: session.pid,
        agent: adapter.id,
        resume: resume === undefined ? null : resume === 'last' ? 'last' : resume.sessionId,
        scrollbackBytes: initialReplayBytes?.length ?? 0,
      });
      return c.json({
        ok: true,
        sessionId: session.recordId,
        wsId: session.wsId,
        name: session.name,
        pid: session.pid,
        agent: adapter.id,
        startedAt: session.startedAt,
      });
    } catch (err) {
      launcherLogger.error('workspace.session_resume_failed', { id, token, err });
      return c.json({ error: 'resume_failed', message: (err as Error).message }, 500);
    }
  });

  app.delete('/:id/sessions/:sid', async (c) => {
    const id = c.req.param('id');
    const token = c.req.param('sid');
    if (!validId(id) || !SESSION_ID_RE.test(token)) {
      return c.json({ error: 'not_found' }, 404);
    }
    const record = svc.sessionRegistry.get(id, token);
    if (!record) return c.json({ error: 'not_found' }, 404);
    const wasRunning = svc.pool.disposeToken(token, 'session deleted');
    if (record.scrollbackFile) {
      await svc.scrollbackStore.remove(record.scrollbackFile);
    }
    await svc.sessionRegistry.remove(id, token).catch((err) =>
      launcherLogger.warn('session_registry.delete_failed', { id, token, err }),
    );
    launcherLogger.info('workspace.session_deleted', { id, sessionId: token, wasRunning });
    return c.json({ ok: true, wasRunning });
  });

  // ── agent provider config ────────────────────────────────────────────────
  // Per-workspace AI provider config lives in CLI-native files inside the
  // workspace (`.claude/settings.local.json`, `.codex/config.toml`,
  // `.codex/env.json`). The CLIs read them directly via cwd-discovery /
  // CODEX_HOME. These routes are pure file IO over the launcher's
  // path-traversal guard.

  app.get('/agent-profiles', async (c) => {
    try {
      const raw = await readFile(resolvePath('data/config/ai-provider-manager.json'), 'utf8');
      const parsed = JSON.parse(raw) as { profiles?: Record<string, ProfileShape> };
      const profiles = parsed.profiles ?? {};
      const list = Object.entries(profiles).map(([name, p]) => ({
        name,
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : null,
        apiKey: typeof p.apiKey === 'string' ? p.apiKey : null,
        model: typeof p.model === 'string' ? p.model : null,
      }));
      return c.json({ profiles: list });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return c.json({ profiles: [] });
      launcherLogger.warn('agent_profiles.read_failed', { err });
      return c.json({ error: 'profiles_read_failed', message: (err as Error).message }, 500);
    }
  });

  app.get('/:id/agent-config', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'not_found' }, 404);
    const meta = svc.registry.get(id);
    if (!meta) return c.json({ error: 'not_found' }, 404);
    try {
      const [claude, codex] = await Promise.all([
        readClaudeConfig(meta.dir),
        readCodexConfig(meta.dir),
      ]);
      return c.json({ claude, codex });
    } catch (err) {
      if (err instanceof PathTraversal) return c.json({ error: 'invalid_path' }, 400);
      launcherLogger.warn('agent_config.read_failed', { id, err });
      return c.json({ error: 'read_failed', message: (err as Error).message }, 500);
    }
  });

  app.put('/:id/agent-config/:agent', async (c) => {
    const id = c.req.param('id');
    const agent = c.req.param('agent');
    if (!validId(id)) return c.json({ error: 'not_found' }, 404);
    if (agent !== 'claude' && agent !== 'codex') return c.json({ error: 'unknown_agent' }, 400);
    const meta = svc.registry.get(id);
    if (!meta) return c.json({ error: 'not_found' }, 404);

    const body = (await safeJson(c)) as AgentConfigInput | null;
    const cfg = body && typeof body === 'object' ? body : {};
    try {
      if (agent === 'claude') {
        await writeClaudeConfig(meta.dir, cfg);
      } else {
        await writeCodexConfig(meta.dir, cfg);
      }
      launcherLogger.info('agent_config.saved', { id, agent });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof PathTraversal) return c.json({ error: 'invalid_path' }, 400);
      launcherLogger.warn('agent_config.write_failed', { id, agent, err });
      return c.json({ error: 'write_failed', message: (err as Error).message }, 500);
    }
  });

  return app;
}

// ── Agent config helpers ────────────────────────────────────────────────────

interface ProfileShape {
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
}

interface AgentConfigInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  wireApi?: 'chat' | 'responses';
}

interface ClaudeConfigShape {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
}

interface CodexConfigShape {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  wireApi: 'chat' | 'responses' | null;
}

const CLAUDE_SETTINGS_PATH = '.claude/settings.local.json';
const CODEX_CONFIG_PATH = '.codex/config.toml';
const CODEX_ENV_PATH = '.codex/env.json';
const CODEX_KEY_ENV_NAME = 'OPENALICE_WORKSPACE_KEY';
const CODEX_PROVIDER_NAME = 'workspace';

async function readClaudeConfig(workspaceDir: string): Promise<ClaudeConfigShape | null> {
  const raw = await readWorkspaceFile(workspaceDir, CLAUDE_SETTINGS_PATH);
  if (raw === null) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const env = (parsed['env'] ?? {}) as Record<string, unknown>;
  const baseUrl = typeof env['ANTHROPIC_BASE_URL'] === 'string' ? (env['ANTHROPIC_BASE_URL'] as string) : null;
  const apiKey = typeof env['ANTHROPIC_API_KEY'] === 'string' ? (env['ANTHROPIC_API_KEY'] as string) : null;
  const model = typeof parsed['model'] === 'string' ? (parsed['model'] as string) : null;
  if (baseUrl === null && apiKey === null && model === null) return null;
  return { baseUrl, apiKey, model };
}

async function writeClaudeConfig(workspaceDir: string, cfg: AgentConfigInput): Promise<void> {
  const hasAny = cfg.baseUrl || cfg.apiKey || cfg.model;
  if (!hasAny) {
    // Reset: delete the settings file so claude falls back to its global
    // OAuth / settings. We don't leave an empty `{}` behind — workspace
    // files exist only when there's an actual override.
    const filePath = join(workspaceDir, CLAUDE_SETTINGS_PATH);
    await rm(filePath, { force: true });
    return;
  }
  const out: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  if (cfg.baseUrl) env['ANTHROPIC_BASE_URL'] = cfg.baseUrl;
  if (cfg.apiKey) env['ANTHROPIC_API_KEY'] = cfg.apiKey;
  if (Object.keys(env).length > 0) out['env'] = env;
  if (cfg.model) out['model'] = cfg.model;
  await writeWorkspaceFile(workspaceDir, CLAUDE_SETTINGS_PATH, JSON.stringify(out, null, 2) + '\n');
}

async function readCodexConfig(workspaceDir: string): Promise<CodexConfigShape | null> {
  const tomlRaw = await readWorkspaceFile(workspaceDir, CODEX_CONFIG_PATH);
  const envRaw = await readWorkspaceFile(workspaceDir, CODEX_ENV_PATH);
  if (tomlRaw === null && envRaw === null) return null;

  let baseUrl: string | null = null;
  let wireApi: 'chat' | 'responses' | null = null;
  let model: string | null = null;
  if (tomlRaw) {
    // Shape-specific extraction: we always write the provider section as
    // `[model_providers.workspace]` with `base_url`, `wire_api`, plus
    // top-level `model`. Regex is brittle in general but our shape is
    // controlled (writer below produces deterministic output).
    const providerBlock = tomlRaw.match(/\[model_providers\.workspace\][^\[]*/);
    if (providerBlock) {
      const block = providerBlock[0];
      const base = block.match(/base_url\s*=\s*"([^"]*)"/);
      if (base) baseUrl = base[1] ?? null;
      const wire = block.match(/wire_api\s*=\s*"(chat|responses)"/);
      if (wire) wireApi = wire[1] as 'chat' | 'responses';
    }
    const modelMatch = tomlRaw.match(/^model\s*=\s*"([^"]*)"\s*$/m);
    if (modelMatch) model = modelMatch[1] ?? null;
  }

  let apiKey: string | null = null;
  if (envRaw) {
    try {
      const env = JSON.parse(envRaw) as Record<string, unknown>;
      const k = env[CODEX_KEY_ENV_NAME];
      if (typeof k === 'string') apiKey = k;
    } catch { /* ignore parse error, leave apiKey null */ }
  }

  if (baseUrl === null && apiKey === null && model === null && wireApi === null) return null;
  return { baseUrl, apiKey, model, wireApi };
}

async function writeCodexConfig(workspaceDir: string, cfg: AgentConfigInput): Promise<void> {
  const hasProvider = !!(cfg.baseUrl || cfg.model);

  if (!hasProvider) {
    // Reset: tear down the workspace's entire `.codex/` directory. The
    // adapter's `composeEnv` won't set `CODEX_HOME` when the directory is
    // absent, so codex falls back to the user's global `~/.codex/`. We
    // don't leave empty stubs behind — workspace files exist only when
    // there's an actual override. Note: `CODEX_HOME` is exclusive (not a
    // merge layer), so a half-empty `.codex/` would *shadow* the user's
    // global login and break auth. Full teardown is the only safe reset.
    const codexDir = join(workspaceDir, '.codex');
    await rm(codexDir, { recursive: true, force: true });
    return;
  }

  // Provider override. config.toml carries only model / model_provider /
  // [model_providers.*] — the OpenAlice MCP server entry is wired per-spawn
  // via the codex adapter's `-c mcp_servers.openalice.url=...` flag, so we
  // don't repeat it here.
  let toml = '';
  if (cfg.model) toml += `model = ${tomlString(cfg.model)}\n`;
  if (cfg.baseUrl) toml += `model_provider = "${CODEX_PROVIDER_NAME}"\n`;
  if (cfg.baseUrl) {
    toml += '\n';
    toml += `[model_providers.${CODEX_PROVIDER_NAME}]\n`;
    toml += `name = "OpenAlice workspace provider"\n`;
    toml += `base_url = ${tomlString(cfg.baseUrl)}\n`;
    toml += `env_key = "${CODEX_KEY_ENV_NAME}"\n`;
    toml += `wire_api = "${cfg.wireApi ?? 'chat'}"\n`;
  }
  await writeWorkspaceFile(workspaceDir, CODEX_CONFIG_PATH, toml);

  // env.json: holds the per-workspace API key codex picks up via env_key.
  // Adapter's composeEnv reads this and exports at spawn.
  if (cfg.apiKey) {
    const envObj: Record<string, string> = { [CODEX_KEY_ENV_NAME]: cfg.apiKey };
    await writeWorkspaceFile(workspaceDir, CODEX_ENV_PATH, JSON.stringify(envObj, null, 2) + '\n');
  } else {
    await writeWorkspaceFile(workspaceDir, CODEX_ENV_PATH, '{}\n');
  }
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function validId(id: string | undefined): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
}

async function safeJson(c: import('hono').Context): Promise<unknown> {
  try {
    const body = await c.req.json();
    return body;
  } catch {
    return null;
  }
}
