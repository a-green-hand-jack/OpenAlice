/**
 * POST /:id/headless — the automation dispatch route. Covers the validation /
 * agent-resolution / dispatch branches against a stubbed WorkspaceService
 * (no real spawn). Modeled on trading-config.spec's harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkspaceRoutes } from './workspaces.js';
import { HeadlessCapacityError, type WorkspaceService } from '../../workspaces/service.js';
import { readWorkspaceMetadata } from '../../workspaces/workspace-metadata.js';
import { createSession, _reset, revokeAllSessions } from '@/services/auth/session-store.js';
import { adminSessionFingerprint } from './approver-identity.js';
import {
  buildWorkspaceToolCatalog,
  resolveWorkspaceToolAuthzLevel,
} from '../../core/workspace-tool-center.js';
import type { ProducerHandle } from '../../core/producer.js';
import { createStewardLedgerStore, DECISION_LEDGER_SCHEMA_VERSION } from '../../workspaces/steward/index.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HEADLESS_RESULT = {
  command: ['claude'],
  cwd: '/w',
  exitCode: 0,
  signal: null,
  killed: false,
  durationMs: 5,
  stdoutTail: 'ok',
  stderrTail: '',
};

let sessionTmpDir: string | null = null

beforeEach(async () => {
  sessionTmpDir = await mkdtemp(join(tmpdir(), 'oa-workspace-route-sessions-'))
  process.env['OPENALICE_SESSIONS_FILE'] = join(sessionTmpDir, 'sessions.json')
  await _reset()
  await revokeAllSessions()
})

afterEach(async () => {
  await _reset()
  delete process.env['OPENALICE_SESSIONS_FILE']
  if (sessionTmpDir) await rm(sessionTmpDir, { recursive: true, force: true })
  sessionTmpDir = null
})

function build(
  opts: {
    meta?: any
    adapters?: Record<string, any>
    resolveTo?: any
    dispatch?: any
    create?: any
    authzProducer?: ProducerHandle<readonly ['authz.level-changed']>
  } = {},
) {
  const claude = {
    id: 'claude',
    capabilities: { headless: true },
    composeHeadlessCommand: () => [],
    bootstrap: vi.fn(async () => {}),
  };
  const meta = opts.meta ?? { id: 'ws-1', dir: '/w', agents: ['claude'] };
  const adapters = opts.adapters ?? { claude };
  const runHeadlessTask = vi.fn(async () => HEADLESS_RESULT);
  const dispatchHeadlessTask = opts.dispatch ?? vi.fn(async () => ({ taskId: 'task-1' }));
  let liveMeta = meta;
  const createWorkspace = opts.create ?? vi.fn(async (tag: string, template: string, createOpts: any = {}) => {
    liveMeta = {
      id: 'ws-1',
      tag,
      dir: '/w',
      createdAt: '2026-07-06T00:00:00.000Z',
      template,
      agents: createOpts.agentsRequested ?? ['claude'],
      ...(createOpts.blind === true ? { blind: true } : {}),
      ...(createOpts.blindAllowBarSources !== undefined ? { blindAllowBarSources: createOpts.blindAllowBarSources } : {}),
    }
    return { ok: true, workspace: liveMeta }
  })
  const svc = {
    registry: {
      get: (id: string) => (id === 'ws-1' ? liveMeta : undefined),
      setAuthzLevel: vi.fn(async (id: string, authzLevel: any) => {
        if (id !== 'ws-1') return undefined
        const from = liveMeta.authzLevel ?? 'read_only'
        liveMeta = { ...liveMeta, authzLevel }
        return { workspace: liveMeta, from, to: authzLevel, changed: from !== authzLevel }
      }),
      list: () => [liveMeta],
    },
    templates: {
      defaultName: () => 'chat',
      get: (name: string) => ({ name, defaultAgents: ['claude'], version: '1.0.0' }),
      list: () => [],
    },
    creator: { create: createWorkspace },
    adapters: { get: (a: string) => adapters[a] },
    resolveAdapter: (_m: any, a?: string) => opts.resolveTo ?? adapters[a ?? 'claude'] ?? claude,
    config: { launcherRepoRoot: '/repo' },
    runHeadlessTask,
    dispatchHeadlessTask,
    publicMeta: vi.fn(async (m: any) => {
      const res = await readWorkspaceMetadata(m.dir);
      return { ...m, ...(res.ok ? res.metadata : {}) };
    }),
  } as unknown as WorkspaceService;
  return { app: createWorkspaceRoutes(svc, { authzProducer: opts.authzProducer }), runHeadlessTask, dispatchHeadlessTask, svc, createWorkspace };
}

async function post(app: any, path: string, body?: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body: json as any };
}

async function get(app: any, path: string) {
  const res = await app.request(path);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json as any };
}

async function patch(app: any, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await app.request(path, {
    method: 'PATCH',
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...(headers ?? {}) } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json as any };
}

function buildSteward(opts: { dir: string }) {
  const meta = {
    id: 'ws-1',
    tag: 'steward-test',
    dir: opts.dir,
    agents: ['codex'],
    template: 'steward',
  };
  const adapter = {
    id: 'codex',
    displayName: 'Codex',
    namePrefix: 'x',
    capabilities: { parallelPerCwd: true, resumeLast: true, resumeById: true, transcriptDiscovery: 'none' },
    composeCommand: (base: readonly string[]) => base,
    bootstrap: vi.fn(async () => {}),
  };
  const records = new Map<string, any>();
  const live = new Map<string, any>();
  const writtenInputs: Array<{ sessionId: string; input: string | Buffer; opts: unknown }> = [];
  let nextName = 1;
  const sessionRegistry = {
    ensureLoaded: vi.fn(async () => {}),
    findById: (id: string) => records.get(id),
    nextName: () => `x${nextName++}`,
    create: vi.fn(async (record: any) => {
      records.set(record.id, record);
    }),
    get: (_wsId: string, id: string) => records.get(id),
    update: vi.fn(async (_wsId: string, id: string, patch: any) => {
      const record = records.get(id);
      if (record) Object.assign(record, patch);
      return record;
    }),
    remove: vi.fn(async (_wsId: string, id: string) => {
      const record = records.get(id);
      records.delete(id);
      return record;
    }),
  };
  const pool = {
    get: (id: string) => live.get(id),
    spawn: vi.fn((_wsId: string, ctx: any) => {
      const session = {
        recordId: ctx.recordId,
        wsId: 'ws-1',
        name: ctx.recordName,
        pid: 4321,
        agentSessionId: null,
        startedAt: 1,
        waitForFirstExit: vi.fn(async () => null),
      };
      live.set(ctx.recordId, session);
      return session;
    }),
    disposeToken: vi.fn((sessionId: string) => live.delete(sessionId)),
    writeToSession: vi.fn((sessionId: string, input: string | Buffer, writeOpts: unknown) => {
      if (!live.has(sessionId)) return false;
      writtenInputs.push({ sessionId, input, opts: writeOpts });
      return true;
    }),
    liveSessionsFor: () => [],
  };
  const svc = {
    registry: {
      get: (id: string) => (id === 'ws-1' ? meta : undefined),
      list: () => [meta],
    },
    sessionRegistry,
    pool,
    adapters: { get: (id: string) => (id === 'codex' ? adapter : undefined) },
    resolveAdapter: () => adapter,
    config: { launcherRepoRoot: '/repo' },
    publicMeta: vi.fn(async (m: any) => m),
  } as unknown as WorkspaceService;
  return { app: createWorkspaceRoutes(svc), pool, sessionRegistry, writtenInputs, live };
}

describe('PATCH /:id/metadata', () => {
  it('writes workspace-owned display metadata without changing launcher identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-route-meta-'));
    try {
      const meta = { id: 'ws-1', tag: 'aapl-q1', dir, agents: ['claude'] };
      const { app } = build({ meta });

      const r = await patch(app, '/ws-1/metadata', { displayName: 'AAPL earnings review' });
      expect(r.status).toBe(200);
      expect(r.body.workspace).toMatchObject({
        id: 'ws-1',
        tag: 'aapl-q1',
        displayName: 'AAPL earnings review',
      });

      const readBack = await readWorkspaceMetadata(dir);
      expect(readBack).toEqual({ ok: true, metadata: { displayName: 'AAPL earnings review' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores attempts to smuggle registry fields into workspace metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-route-meta-'));
    try {
      const { app } = build({ meta: { id: 'ws-1', tag: 'stable-tag', dir, agents: ['claude'] } });
      const r = await patch(app, '/ws-1/metadata', { displayName: 'Nice label', id: 'different' });

      expect(r.status).toBe(200);
      expect(r.body.workspace.id).toBe('ws-1');
      expect(r.body.workspace.tag).toBe('stable-tag');
      expect(r.body.workspace.displayName).toBe('Nice label');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PATCH /:id/authz-level', () => {
  it('persists the launcher-owned level, emits authz.level-changed with approver fingerprint, and updates the effective catalog', async () => {
    const session = await createSession()
    const events: Array<{ type: string; payload: any }> = []
    const authzProducer = {
      name: 'authz-routes',
      emits: ['authz.level-changed'],
      emit: vi.fn(async (type: string, payload: any) => { events.push({ type, payload }) }),
      dispose: vi.fn(),
    } as unknown as ProducerHandle<readonly ['authz.level-changed']>
    const { app, svc } = build({
      meta: { id: 'ws-1', tag: 'stable-tag', dir: '/w', agents: ['claude'], authzLevel: 'read_only' },
      authzProducer,
    })

    const r = await patch(
      app,
      '/ws-1/authz-level',
      { authzLevel: 'paper' },
      { Cookie: `alice_session=${encodeURIComponent(session.sid)}` },
    )

    expect(r.status).toBe(200)
    expect(r.body.workspace).toMatchObject({ id: 'ws-1', authzLevel: 'paper' })
    expect(svc.registry.get('ws-1')?.authzLevel).toBe('paper')
    expect(events).toEqual([{
      type: 'authz.level-changed',
      payload: {
        scope: 'workspace',
        id: 'ws-1',
        from: 'read_only',
        to: 'paper',
        approver: {
          via: 'alice-bff',
          fingerprint: adminSessionFingerprint(session.sid),
          at: expect.any(String),
        },
      },
    }])

    const effective = resolveWorkspaceToolAuthzLevel({
      workspaceAuthzLevel: svc.registry.get('ws-1')?.authzLevel,
      accountMaxAuthzLevels: ['paper'],
    })
    const catalog = buildWorkspaceToolCatalog(
      {
        placeOrder: { description: 'place' } as any,
        getAccount: { description: 'account' } as any,
      },
      {},
      { authzLevel: effective, groupForTool: () => 'trading' },
    )
    expect(Object.keys(catalog).sort()).toEqual(['getAccount', 'placeOrder'])
  })

  it('rejects invalid levels before writing or emitting', async () => {
    const authzProducer = {
      name: 'authz-routes',
      emits: ['authz.level-changed'],
      emit: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ProducerHandle<readonly ['authz.level-changed']>
    const { app, svc } = build({
      meta: { id: 'ws-1', tag: 'stable-tag', dir: '/w', agents: ['claude'], authzLevel: 'read_only' },
      authzProducer,
    })

    const r = await patch(app, '/ws-1/authz-level', { authzLevel: 'root' })

    expect(r.status).toBe(400)
    expect(svc.registry.get('ws-1')?.authzLevel).toBe('read_only')
    expect(authzProducer.emit).not.toHaveBeenCalled()
  })
})

describe('steward wake API', () => {
  it('creates a wake file, spawns a Codex session, injects the wake, and records session config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-route-steward-'));
    try {
      const { app, pool, writtenInputs } = buildSteward({ dir });

      const r = await post(app, '/ws-1/steward/wakes', {
        wakeId: 'wake:1',
        reason: 'scheduled_observe',
        accountId: 'mock-simulator-1',
        authzLevel: 'paper',
        expectedDecision: 'no_trade',
        deadline: '2026-07-08T14:03:00.000Z',
        marketContext: { symbols: ['AAPL'] },
        riskContext: { riskState: 'NORMAL' },
      });

      expect(r.status).toBe(202);
      expect(r.body.wake).toMatchObject({
        wakeId: 'wake:1',
        status: 'injected',
        deadline: '2026-07-08T14:03:00.000Z',
        envelope: {
          reason: 'scheduled_observe',
          accountId: 'mock-simulator-1',
          authzLevel: 'paper',
          expectedDecision: 'no_trade',
        },
      });
      expect(r.body.session).toMatchObject({ agent: 'codex', reused: false });
      expect(pool.spawn).toHaveBeenCalledOnce();
      expect(writtenInputs).toHaveLength(1);
      expect(String(writtenInputs[0]?.input)).toContain('<STEWARD_WAKE id="wake:1"');
      expect(String(writtenInputs[0]?.input)).toContain('.alice/steward/wakes/wake%3A1.json');
      expect(writtenInputs[0]?.opts).toEqual({ source: 'steward-supervisor' });

      const config = JSON.parse(await readFile(join(dir, '.alice/steward/config.json'), 'utf8')) as {
        agent: string;
        sessionId: string;
      };
      expect(config.agent).toBe('codex');
      expect(config.sessionId).toBe(r.body.session.sessionId);

      const stored = JSON.parse(await readFile(join(dir, '.alice/steward/wakes/wake%3A1.json'), 'utf8')) as {
        status: string;
        sessionId: string;
      };
      expect(stored.status).toBe('injected');
      expect(stored.sessionId).toBe(r.body.session.sessionId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses a configured live steward session instead of spawning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-route-steward-'));
    try {
      await mkdir(join(dir, '.alice', 'steward'), { recursive: true });
      await writeFile(
        join(dir, '.alice/steward/config.json'),
        JSON.stringify({ version: 1, agent: 'codex', sessionId: 'configured-session' }, null, 2) + '\n',
        'utf8',
      );
      const { app, pool, writtenInputs, live } = buildSteward({ dir });
      live.set('configured-session', { recordId: 'configured-session' });

      const r = await post(app, '/ws-1/steward/wakes', {
        wakeId: 'wake-reuse',
        reason: 'user_request',
        accountId: 'mock-simulator-1',
        authzLevel: 'read_only',
        expectedDecision: 'blocked',
      });

      expect(r.status).toBe(202);
      expect(r.body.session).toEqual({
        sessionId: 'configured-session',
        agent: 'codex',
        reused: true,
        resumed: false,
      });
      expect(pool.spawn).not.toHaveBeenCalled();
      expect(writtenInputs[0]?.sessionId).toBe('configured-session');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resumes a configured paused steward session before injecting the wake', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-route-steward-'));
    try {
      await mkdir(join(dir, '.alice', 'steward'), { recursive: true });
      await writeFile(
        join(dir, '.alice/steward/config.json'),
        JSON.stringify({ version: 1, agent: 'codex', sessionId: 'paused-session' }, null, 2) + '\n',
        'utf8',
      );
      const { app, pool, sessionRegistry, writtenInputs } = buildSteward({ dir });
      await sessionRegistry.create({
        id: 'paused-session',
        wsId: 'ws-1',
        agent: 'codex',
        name: 'x1',
        createdAt: '2026-07-08T14:00:00.000Z',
        lastActiveAt: '2026-07-08T14:00:00.000Z',
        state: 'paused',
      });
      vi.mocked(sessionRegistry.create).mockClear();

      const r = await post(app, '/ws-1/steward/wakes', {
        wakeId: 'wake-resume',
        reason: 'supervisor_recovery',
        accountId: 'mock-simulator-1',
        authzLevel: 'paper',
        expectedDecision: 'blocked',
      });

      expect(r.status).toBe(202);
      expect(r.body.session).toEqual({
        sessionId: 'paused-session',
        agent: 'codex',
        reused: true,
        resumed: true,
      });
      expect(sessionRegistry.create).not.toHaveBeenCalled();
      expect(pool.spawn).toHaveBeenCalledWith('ws-1', expect.objectContaining({
        agentId: 'codex',
        recordId: 'paused-session',
        recordName: 'x1',
        resume: 'last',
      }));
      expect(writtenInputs[0]?.sessionId).toBe('paused-session');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads wake status and decision ledger entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-route-steward-'));
    try {
      const { app } = buildSteward({ dir });
      await post(app, '/ws-1/steward/wakes', {
        wakeId: 'wake-ledger',
        reason: 'scheduled_observe',
        accountId: 'mock-simulator-1',
        authzLevel: 'paper',
        expectedDecision: 'no_trade',
      });
      const ledger = createStewardLedgerStore(dir);
      await ledger.append({
        version: DECISION_LEDGER_SCHEMA_VERSION,
        wakeId: 'wake-ledger',
        at: '2026-07-08T14:01:23.000Z',
        accountId: 'mock-simulator-1',
        decision: 'no_trade',
        status: 'done',
        completion: { reason: 'no signal', evidenceRefs: ['wake:wake-ledger'] },
        checklist: {
          account: 'ok',
          positions: 'ok',
          orders: 'ok',
          risk: 'NORMAL',
          market: 'open',
          history: 'checked',
        },
        thesis: 'No entry signal.',
        actions: [],
        pendingHash: null,
        invalidation: 'new signal',
        cost: {
          model: 'codex',
          inputTokens: null,
          outputTokens: null,
          modelCostUsd: null,
          allocatedServerCostUsd: null,
          tradingFeesUsd: null,
          estimatedSlippageUsd: null,
          totalEstimatedCostUsd: null,
        },
      });

      const wake = await get(app, `/ws-1/steward/wakes/${encodeURIComponent('wake-ledger')}`);
      expect(wake.status).toBe(200);
      expect(wake.body.wake.status).toBe('injected');
      expect(wake.body.ledgerEntry.decision).toBe('no_trade');

      const listed = await get(app, '/ws-1/steward/ledger?limit=1');
      expect(listed.status).toBe(200);
      expect(listed.body.entries).toHaveLength(1);
      expect(listed.body.entries[0].wakeId).toBe('wake-ledger');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('locks overlapping account wakes until supervisor completes the active wake', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-route-steward-'));
    try {
      const { app } = buildSteward({ dir });
      const first = await post(app, '/ws-1/steward/wakes', {
        wakeId: 'wake-active',
        reason: 'scheduled_observe',
        accountId: 'mock-simulator-1',
        authzLevel: 'paper',
        expectedDecision: 'no_trade',
      });
      expect(first.status).toBe(202);

      const blocked = await post(app, '/ws-1/steward/wakes', {
        wakeId: 'wake-overlap',
        reason: 'market_event',
        accountId: 'mock-simulator-1',
        authzLevel: 'paper',
        expectedDecision: 'blocked',
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe('account_locked');
      expect(blocked.body.lock.wakeId).toBe('wake-active');

      const ledger = createStewardLedgerStore(dir);
      await ledger.append({
        version: DECISION_LEDGER_SCHEMA_VERSION,
        wakeId: 'wake-active',
        at: '2026-07-08T14:01:23.000Z',
        accountId: 'mock-simulator-1',
        decision: 'no_trade',
        status: 'done',
        completion: { reason: 'no signal', evidenceRefs: ['wake:wake-active'] },
        checklist: {
          account: 'ok',
          positions: 'ok',
          orders: 'ok',
          risk: 'NORMAL',
          market: 'open',
          history: 'checked',
        },
        thesis: 'No entry signal.',
        actions: [],
        pendingHash: null,
        invalidation: 'new signal',
        cost: {
          model: 'codex',
          inputTokens: 10,
          outputTokens: 5,
          modelCostUsd: 1,
          allocatedServerCostUsd: 2,
          tradingFeesUsd: 3,
          estimatedSlippageUsd: 4,
          totalEstimatedCostUsd: null,
        },
      });

      const tick = await post(app, '/ws-1/steward/supervisor/tick', {
        now: '2026-07-08T14:01:30.000Z',
      });
      expect(tick.status).toBe(200);
      expect(tick.body.transitions).toEqual([{
        wakeId: 'wake-active',
        from: 'injected',
        to: 'done',
        reason: 'ledger:done',
      }]);
      expect(tick.body.cost.totalEstimatedCostUsd).toBe(10);

      const second = await post(app, '/ws-1/steward/wakes', {
        wakeId: 'wake-overlap',
        reason: 'market_event',
        accountId: 'mock-simulator-1',
        authzLevel: 'paper',
        expectedDecision: 'blocked',
      });
      expect(second.status).toBe(202);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('POST /', () => {
  it('accepts blind mode fields and returns the registry/public metadata round-trip', async () => {
    const { app, createWorkspace } = build()

    const r = await post(app, '/', {
      tag: 'blind-lab',
      template: 'chat',
      agents: ['codex'],
      blind: true,
      blindAllowBarSources: [' mock-paper ', 'mock-paper', 'mock-campaign'],
    })

    expect(r.status).toBe(201)
    expect(createWorkspace).toHaveBeenCalledWith('blind-lab', 'chat', {
      agentsRequested: ['codex'],
      blind: true,
      blindAllowBarSources: ['mock-paper', 'mock-campaign'],
    })
    expect(r.body.workspace).toMatchObject({
      id: 'ws-1',
      tag: 'blind-lab',
      template: 'chat',
      agents: ['codex'],
      blind: true,
      blindAllowBarSources: ['mock-paper', 'mock-campaign'],
    })
  })

  it('rejects malformed blind create fields before workspace creation', async () => {
    const { app, createWorkspace } = build()

    const r = await post(app, '/', {
      tag: 'blind-lab',
      template: 'chat',
      blind: 'true',
      blindAllowBarSources: ['mock-paper'],
    })

    expect(r.status).toBe(400)
    expect(r.body.error).toBe('bad_request')
    expect(createWorkspace).not.toHaveBeenCalled()
  })
})

describe('POST /:id/headless', () => {
  it('404 on a malformed workspace id', async () => {
    const { app } = build();
    expect((await post(app, '/bad.id/headless', { prompt: 'x' })).status).toBe(404);
  });

  it('400 prompt_required on empty or whitespace-only prompt', async () => {
    const { app } = build();
    expect((await post(app, '/ws-1/headless', { prompt: '' })).body.error).toBe('prompt_required');
    expect((await post(app, '/ws-1/headless', { prompt: '   ' })).body.error).toBe('prompt_required');
  });

  it('400 prompt_too_long over 16000 chars', async () => {
    const { app } = build();
    expect((await post(app, '/ws-1/headless', { prompt: 'a'.repeat(16001) })).body.error).toBe('prompt_too_long');
  });

  it('404 workspace_not_found for an unknown workspace', async () => {
    const { app } = build();
    const r = await post(app, '/ws-nope/headless', { prompt: 'x' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('workspace_not_found');
  });

  it('400 unknown_agent when the agent is not a registered adapter', async () => {
    const { app } = build();
    expect((await post(app, '/ws-1/headless', { prompt: 'x', agent: 'ghost' })).body.error).toBe('unknown_agent');
  });

  it('400 agent_not_enabled when the agent exists but is not on the workspace', async () => {
    const codex = { id: 'codex', capabilities: { headless: true }, composeHeadlessCommand: () => [] };
    const { app } = build({
      meta: { id: 'ws-1', dir: '/w', agents: ['claude'] },
      adapters: { claude: { id: 'claude', capabilities: { headless: true } }, codex },
    });
    expect((await post(app, '/ws-1/headless', { prompt: 'x', agent: 'codex' })).body.error).toBe('agent_not_enabled');
  });

  it('400 no_headless when the resolved adapter has no headless mode', async () => {
    const shell = { id: 'shell', capabilities: {} };
    const { app } = build({ meta: { id: 'ws-1', dir: '/w', agents: ['shell'] }, adapters: { shell }, resolveTo: shell });
    expect((await post(app, '/ws-1/headless', { prompt: 'x', agent: 'shell' })).body.error).toBe('no_headless');
  });

  it('clamps timeoutMs to <= 1_800_000 and defaults to 300_000', async () => {
    const { app, dispatchHeadlessTask } = build();
    await post(app, '/ws-1/headless', { prompt: 'x', timeoutMs: 9e9 });
    expect(dispatchHeadlessTask).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'x', 1_800_000);
    await post(app, '/ws-1/headless', { prompt: 'x' });
    expect(dispatchHeadlessTask).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'x', 300_000);
  });

  it('async by default → 202 + taskId, dispatches in the background', async () => {
    const { app, dispatchHeadlessTask, runHeadlessTask } = build();
    const r = await post(app, '/ws-1/headless', { prompt: 'do the thing' });
    expect(r.status).toBe(202);
    expect(r.body.taskId).toBe('task-1');
    expect(r.body.status).toBe('running');
    expect(dispatchHeadlessTask).toHaveBeenCalledOnce();
    expect(runHeadlessTask).not.toHaveBeenCalled(); // async path doesn't await the run
  });

  it('wait:true → 200 + the full sync result', async () => {
    const { app, runHeadlessTask, dispatchHeadlessTask } = build();
    const r = await post(app, '/ws-1/headless', { prompt: 'do the thing', wait: true });
    expect(r.status).toBe(200);
    expect(r.body.exitCode).toBe(0);
    expect(runHeadlessTask).toHaveBeenCalledOnce();
    expect(dispatchHeadlessTask).not.toHaveBeenCalled();
  });

  it('429 when the concurrency cap is hit', async () => {
    const dispatch = vi.fn(async () => {
      throw new HeadlessCapacityError(8);
    });
    const { app } = build({ dispatch });
    const r = await post(app, '/ws-1/headless', { prompt: 'x' });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('capacity');
  });
});

describe('POST /:id/sessions/:sid/resume — concurrent coalescing (ANG-120)', () => {
  const TOKEN = 'claude-calm-amber-river';

  function buildResume() {
    const session = {
      recordId: TOKEN,
      wsId: 'ws-1',
      name: 'c1',
      pid: 4242,
      startedAt: 1,
      waitForFirstExit: vi.fn(async () => null), // stays up
    };
    let live: unknown = undefined; // what pool.get returns; set once spawned
    const spawn = vi.fn(() => {
      live = session;
      return session;
    });
    const record = {
      id: TOKEN,
      wsId: 'ws-1',
      agent: 'claude',
      name: 'c1',
      state: 'paused',
      resumeHint: { kind: 'agent-session-id', value: 'aid' },
    };
    const adapter = { id: 'claude', capabilities: { resumeById: true, resumeLast: false } };
    const svc = {
      sessionRegistry: { get: () => record, update: vi.fn(async () => {}) },
      pool: { get: () => live, spawn, disposeToken: vi.fn() },
      registry: { get: () => ({ id: 'ws-1', dir: '/w', agents: ['claude'] }) },
      adapters: { get: () => adapter },
      computeSpawnPlan: () => ({
        spawnCwd: '/w',
        envPWD: '/w',
        transcriptDir: null,
        projectKey: 'k',
        composedCommand: ['claude'],
        resumeMode: 'by-id',
        resumeId: 'aid',
      }),
      config: { launcherRepoRoot: '/repo' },
    } as unknown as WorkspaceService;
    return { app: createWorkspaceRoutes(svc), spawn };
  }

  it('two simultaneous resumes spawn the agent exactly once', async () => {
    const { app, spawn } = buildResume();
    const path = `/ws-1/sessions/${TOKEN}/resume`;
    const [a, b] = await Promise.all([post(app, path), post(app, path)]);

    expect(spawn).toHaveBeenCalledOnce(); // no double-spawn racing one transcript
    // both succeed: one really resumed, the other coalesced to alreadyRunning
    expect(a.body.ok).toBe(true);
    expect(b.body.ok).toBe(true);
    expect([a.body, b.body].filter((x) => x.alreadyRunning)).toHaveLength(1);
  });
});

describe('POST /:id/sessions/:sid/wake', () => {
  const TOKEN = 'codex-calm-amber-river';

  function buildWake(result: any = {
    ok: true,
    id: TOKEN,
    wsId: 'ws-1',
    lastInputAt: 101,
    lastOutputAt: 99,
    lastActivityAt: 101,
  }) {
    const wakeSession = vi.fn(async () => result);
    const svc = { wakeSession } as unknown as WorkspaceService;
    return { app: createWorkspaceRoutes(svc), wakeSession };
  }

  it('writes a wake message and default terminal Enter as separate PTY inputs', async () => {
    const { app, wakeSession } = buildWake();
    const r = await post(app, `/ws-1/sessions/${TOKEN}/wake`, { message: 'check ASSET-A' });

    expect(r.status).toBe(200);
    expect(wakeSession).toHaveBeenCalledTimes(2);
    expect(wakeSession).toHaveBeenNthCalledWith(1, 'ws-1', TOKEN, 'check ASSET-A');
    expect(wakeSession).toHaveBeenNthCalledWith(2, 'ws-1', TOKEN, '\r');
    expect(r.body).toMatchObject({
      ok: true,
      wsId: 'ws-1',
      sessionId: TOKEN,
      lastInputAt: 101,
      lastOutputAt: 99,
      lastActivityAt: 101,
    });
  });

  it('can preserve the exact message when appendNewline is false', async () => {
    const { app, wakeSession } = buildWake();
    const r = await post(app, `/ws-1/sessions/${TOKEN}/wake`, {
      message: 'raw bytes stay caller-controlled',
      appendNewline: false,
    });

    expect(r.status).toBe(200);
    expect(wakeSession).toHaveBeenCalledWith('ws-1', TOKEN, 'raw bytes stay caller-controlled');
  });

  it('can submit a terminal Enter without extra text', async () => {
    const { app, wakeSession } = buildWake();
    const r = await post(app, `/ws-1/sessions/${TOKEN}/wake`, { message: '' });

    expect(r.status).toBe(200);
    expect(wakeSession).toHaveBeenCalledTimes(1);
    expect(wakeSession).toHaveBeenCalledWith('ws-1', TOKEN, '\r');
  });

  it('404s missing sessions', async () => {
    const { app } = buildWake({ ok: false, reason: 'session-not-found' });
    const r = await post(app, `/ws-1/sessions/${TOKEN}/wake`, { message: 'wake' });

    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('409s known but not-live sessions without spawning a replacement', async () => {
    const { app } = buildWake({ ok: false, reason: 'not-running' });
    const r = await post(app, `/ws-1/sessions/${TOKEN}/wake`, { message: 'wake' });

    expect(r.status).toBe(409);
    expect(r.body.error).toBe('session_not_running');
  });

  it('rejects over-cap wake messages before touching the service', async () => {
    const { app, wakeSession } = buildWake();
    const r = await post(app, `/ws-1/sessions/${TOKEN}/wake`, {
      message: 'x'.repeat(16001),
    });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('message_too_long');
    expect(wakeSession).not.toHaveBeenCalled();
  });
});
