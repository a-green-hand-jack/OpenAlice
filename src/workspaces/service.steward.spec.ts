import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkspaceService, type WorkspaceService } from './service.js';
import type { ScheduleStewardWakeInput } from './schedule/scanner.js';
import {
  createStewardLockStore,
  createStewardWakeStore,
  publishStewardInformationSnapshot,
  stewardSnapshotPath,
} from './steward/index.js';
import type { WorkspaceMeta } from './workspace-registry.js';

describe('scheduled steward PTY cleanup (issue #177)', () => {
  it('uses the post-lock generation lease when B supersedes acknowledged A before scheduled PTY selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-service-steward-runtime-'));
    const launcherRoot = join(root, 'launcher');
    const workspaceDir = join(root, 'workspace');
    const previousLauncherRoot = process.env['AQ_LAUNCHER_ROOT'];
    let service: WorkspaceService | null = null;
    try {
      process.env['AQ_LAUNCHER_ROOT'] = launcherRoot;
      await mkdir(join(workspaceDir, '.alice/steward'), { recursive: true });
      await writeFile(
        join(workspaceDir, '.alice/steward/config.json'),
        JSON.stringify({
          version: 1,
          controlFace: 'pty',
          agent: 'shell',
          sessionId: 'stale-runtime-session',
        }),
        'utf8',
      );
      const svc = await createWorkspaceService({
        webPort: 47331,
        mcpPort: 47332,
        toolBaseUrl: 'http://127.0.0.1:47331/cli',
      });
      service = svc;
      const ws: WorkspaceMeta = {
        id: 'ws-scheduled-runtime',
        tag: 'scheduled-runtime',
        dir: workspaceDir,
        createdAt: '2026-07-12T00:00:00.000Z',
        template: 'steward',
        agents: ['shell'],
      };
      await svc.registry.add(ws);
      const earlyRefresh = vi.spyOn(svc.creator, 'refreshStewardRuntime');
      const runtimeLease = vi.spyOn(
        svc.creator,
        'withStewardRuntimeLease',
      ).mockImplementation(async (_meta, face, operation) => {
        expect(face).toBe('pty');
        expect(await createStewardLockStore(workspaceDir).get('mock-simulator-1')).toMatchObject({
          wakeId: 'wake-runtime-rotation',
        });
        // A observed acknowledged generation A before the account lock. B has
        // now published generation B, so the authoritative post-lock lease must
        // force a fresh face instead of reusing A's live session.
        return operation({ desiredDigest: 'b'.repeat(64), forceFresh: true });
      });
      const poolGet = vi.spyOn(svc.pool, 'get').mockImplementation((sessionId) => (
        sessionId === 'stale-runtime-session'
          ? { recordId: sessionId }
          : undefined
      ) as ReturnType<typeof svc.pool.get>);
      const disposeToken = vi.spyOn(svc.pool, 'disposeToken').mockImplementation(() => true);
      const spawn = vi.spyOn(svc.pool, 'spawn').mockImplementation((wsId, ctx) => ({
        recordId: ctx.recordId,
        wsId,
        name: ctx.recordName,
        pid: 4321,
        agentSessionId: null,
        startedAt: 1,
      }) as unknown as ReturnType<typeof svc.pool.spawn>);

      await expect(svc.dispatchStewardWake(ws, {
        issueId: 'issue-runtime-rotation',
        wakeId: 'wake-runtime-rotation',
        reason: 'scheduled_observe',
        accountId: 'mock-simulator-1',
        authzLevel: 'paper',
        expectedDecision: 'no_trade',
        humanRequest: 'Observe the paper account.',
        agent: 'shell',
        nowMs: Date.parse('2026-07-12T01:00:00.000Z'),
      })).resolves.toEqual({ wakeId: 'wake-runtime-rotation' });

      expect(poolGet).toHaveBeenCalledWith('stale-runtime-session');
      expect(disposeToken).toHaveBeenCalledWith(
        'stale-runtime-session',
        'steward_runtime_upgraded',
      );
      expect(spawn).toHaveBeenCalledOnce();
      expect(runtimeLease).toHaveBeenCalledOnce();
      expect(earlyRefresh).not.toHaveBeenCalled();
    } finally {
      await service?.dispose('scheduled runtime digest test complete');
      if (previousLauncherRoot === undefined) delete process.env['AQ_LAUNCHER_ROOT'];
      else process.env['AQ_LAUNCHER_ROOT'] = previousLauncherRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the live scheduled PTY wake and account lock when injected-status persistence fails after seeded dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-service-steward-committed-'));
    const launcherRoot = join(root, 'launcher');
    const workspaceDir = join(root, 'workspace');
    const accountId = 'mock-simulator-1';
    const wakeId = 'wake-scheduled-committed-bookkeeping-fail';
    const previousLauncherRoot = process.env['AQ_LAUNCHER_ROOT'];
    let service: WorkspaceService | null = null;
    try {
      process.env['AQ_LAUNCHER_ROOT'] = launcherRoot;
      await mkdir(join(workspaceDir, '.alice/steward'), { recursive: true });
      await writeFile(
        join(workspaceDir, '.alice/steward/config.json'),
        JSON.stringify({ version: 1, controlFace: 'pty', agent: 'shell', sessionId: null }),
        'utf8',
      );
      const svc = await createWorkspaceService({
        webPort: 47331,
        mcpPort: 47332,
        toolBaseUrl: 'http://127.0.0.1:47331/cli',
      });
      service = svc;
      const ws: WorkspaceMeta = {
        id: 'ws-scheduled-committed',
        tag: 'scheduled-committed',
        dir: workspaceDir,
        createdAt: '2026-07-12T00:00:00.000Z',
        template: 'steward',
        agents: ['shell'],
      };
      await svc.registry.add(ws);
      vi.spyOn(svc.creator, 'withStewardRuntimeLease').mockImplementation(
        async (_meta, _face, operation) => operation({ desiredDigest: 'a'.repeat(64), forceFresh: false }),
      );
      const updateTmp = join(
        workspaceDir,
        '.alice/steward/wakes',
        `${encodeURIComponent(wakeId)}.json.tmp`,
      );
      vi.spyOn(svc.pool, 'spawn').mockImplementation((wsId, ctx) => {
        mkdirSync(updateTmp, { recursive: true });
        return {
          recordId: ctx.recordId,
          wsId,
          name: ctx.recordName,
          pid: 4321,
          agentSessionId: null,
          startedAt: 1,
        } as unknown as ReturnType<typeof svc.pool.spawn>;
      });
      const wake = (id: string): ScheduleStewardWakeInput => ({
        issueId: `issue-${id}`,
        wakeId: id,
        reason: 'scheduled_observe',
        accountId,
        authzLevel: 'paper',
        expectedDecision: 'no_trade',
        humanRequest: 'Observe the paper account.',
        agent: 'shell',
        nowMs: Date.parse('2026-07-12T01:00:00.000Z'),
      });

      await expect(svc.dispatchStewardWake(ws, wake(wakeId))).resolves.toEqual({ wakeId });
      const retainedWake = await createStewardWakeStore(workspaceDir).require(wakeId);
      expect(retainedWake).toMatchObject({
        status: 'queued',
        injectedAt: null,
      });
      expect(retainedWake.completedAt).toBeUndefined();
      expect(retainedWake.error).toBeUndefined();
      expect(await createStewardLockStore(workspaceDir).get(accountId)).toMatchObject({ wakeId });

      await expect(svc.dispatchStewardWake(
        ws,
        wake('wake-scheduled-committed-retry'),
      )).rejects.toThrow(/lock already held/i);
      expect(await createStewardLockStore(workspaceDir).get(accountId)).toMatchObject({ wakeId });
    } finally {
      await service?.dispose('scheduled committed bookkeeping test complete');
      if (previousLauncherRoot === undefined) delete process.env['AQ_LAUNCHER_ROOT'];
      else process.env['AQ_LAUNCHER_ROOT'] = previousLauncherRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('has no side effects on publication failure and idempotently reuses a pre-wake snapshot for same-wake retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-service-steward-snapshot-'));
    const launcherRoot = join(root, 'launcher');
    const workspaceDir = join(root, 'workspace');
    const configPath = join(workspaceDir, '.alice/steward/config.json');
    const previousLauncherRoot = process.env['AQ_LAUNCHER_ROOT'];
    let service: WorkspaceService | null = null;
    let mode: 'normal' | 'publish-fail' | 'block-wake-create' = 'normal';
    try {
      process.env['AQ_LAUNCHER_ROOT'] = launcherRoot;
      await mkdir(join(workspaceDir, '.alice/steward'), { recursive: true });
      await writeFile(configPath, JSON.stringify({ controlFace: 'pty', agent: 'shell', sessionId: null }), 'utf8');
      const svc = await createWorkspaceService({
        webPort: 47331,
        mcpPort: 47332,
        toolBaseUrl: 'http://127.0.0.1:47331/cli',
        stewardSnapshotPublisher: async (dir, input) => {
          if (mode === 'publish-fail') throw new Error('scheduled snapshot publication failed');
          const published = await publishStewardInformationSnapshot(dir, input);
          if (mode === 'block-wake-create') {
            await mkdir(join(
              dir,
              '.alice/steward/wakes',
              `${encodeURIComponent(input.wakeId)}.json.tmp`,
            ), { recursive: true });
          }
          return published;
        },
      });
      service = svc;
      const ws: WorkspaceMeta = {
        id: 'ws-scheduled-snapshot',
        tag: 'scheduled-snapshot',
        dir: workspaceDir,
        createdAt: '2026-07-12T00:00:00.000Z',
        template: 'steward',
        agents: ['shell'],
      };
      await svc.registry.add(ws);
      vi.spyOn(svc.creator, 'withStewardRuntimeLease').mockImplementation(
        async (_meta, _face, operation) => operation({ desiredDigest: 'a'.repeat(64), forceFresh: false }),
      );
      const spawn = vi.spyOn(svc.pool, 'spawn').mockImplementation((wsId, ctx) => ({
        recordId: ctx.recordId,
        wsId,
        name: ctx.recordName,
        pid: 4321,
        agentSessionId: null,
        startedAt: 1,
      }) as unknown as ReturnType<typeof svc.pool.spawn>);
      const createRecord = vi.spyOn(svc.sessionRegistry, 'create');
      const wake = (wakeId: string, nowMs: number): ScheduleStewardWakeInput => ({
        issueId: `issue-${wakeId}`,
        wakeId,
        reason: 'scheduled_observe',
        accountId: 'mock-simulator-1',
        authzLevel: 'paper',
        expectedDecision: 'no_trade',
        humanRequest: 'Observe the paper account.',
        agent: 'shell',
        nowMs,
      });
      const wakeStore = createStewardWakeStore(workspaceDir);
      const lockStore = createStewardLockStore(workspaceDir);

      mode = 'publish-fail';
      await expect(svc.dispatchStewardWake(
        ws,
        wake('wake-scheduled-publish-fail', Date.parse('2026-07-12T01:00:00.000Z')),
      )).rejects.toThrow('scheduled snapshot publication failed');
      expect(await wakeStore.get('wake-scheduled-publish-fail')).toBeNull();
      expect(await lockStore.get('mock-simulator-1')).toBeNull();
      expect(existsSync(stewardSnapshotPath(workspaceDir, 'wake-scheduled-publish-fail'))).toBe(false);
      expect(createRecord).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();

      const retryWake = wake('wake-scheduled-create-retry', Date.parse('2026-07-12T01:01:00.000Z'));
      mode = 'block-wake-create';
      await expect(svc.dispatchStewardWake(ws, retryWake)).rejects.toThrow();
      expect(await wakeStore.get(retryWake.wakeId)).toBeNull();
      expect(await lockStore.get('mock-simulator-1')).toBeNull();
      const snapshotBeforeRetry = await readFile(stewardSnapshotPath(workspaceDir, retryWake.wakeId), 'utf8');
      expect(createRecord).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();

      await rm(join(
        workspaceDir,
        '.alice/steward/wakes',
        `${encodeURIComponent(retryWake.wakeId)}.json.tmp`,
      ), { recursive: true, force: true });
      mode = 'normal';
      await expect(svc.dispatchStewardWake(ws, retryWake)).resolves.toEqual({ wakeId: retryWake.wakeId });
      expect(await wakeStore.require(retryWake.wakeId)).toMatchObject({ status: 'injected' });
      expect(await readFile(stewardSnapshotPath(workspaceDir, retryWake.wakeId), 'utf8')).toBe(snapshotBeforeRetry);
      expect(createRecord).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await service?.dispose('scheduled snapshot test complete');
      if (previousLauncherRoot === undefined) delete process.env['AQ_LAUNCHER_ROOT'];
      else process.env['AQ_LAUNCHER_ROOT'] = previousLauncherRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compensates spawn failure, cleans pre-spawn config failure, and immediately retries the same account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-service-steward-'));
    const launcherRoot = join(root, 'launcher');
    const workspaceDir = join(root, 'workspace');
    const configPath = join(workspaceDir, '.alice/steward/config.json');
    const previousLauncherRoot = process.env['AQ_LAUNCHER_ROOT'];
    const priorConfig = `${JSON.stringify({
      version: 1,
      controlFace: 'pty',
      agent: 'shell',
      sessionId: null,
      preserved: 'scheduled-prior-config',
    }, null, 2)}\n`;
    const externalConfig = '{"version":1,"controlFace":"pty","agent":"shell","sessionId":null,"owner":"external"}\n';
    let service: WorkspaceService | null = null;

    try {
      process.env['AQ_LAUNCHER_ROOT'] = launcherRoot;
      await mkdir(join(workspaceDir, '.alice/steward'), { recursive: true });
      await writeFile(configPath, priorConfig, 'utf8');

      const svc = await createWorkspaceService({
        webPort: 47331,
        mcpPort: 47332,
        toolBaseUrl: 'http://127.0.0.1:47331/cli',
      });
      service = svc;
      const ws: WorkspaceMeta = {
        id: 'ws-scheduled-steward',
        tag: 'scheduled-steward',
        dir: workspaceDir,
        createdAt: '2026-07-12T00:00:00.000Z',
        template: 'steward',
        agents: ['shell'],
      };
      await svc.registry.add(ws);
      vi.spyOn(svc.creator, 'withStewardRuntimeLease').mockImplementation(
        async (_meta, _face, operation) => operation({ desiredDigest: 'a'.repeat(64), forceFresh: false }),
      );

      const createdRecordIds: string[] = [];
      let breakConfigAfterCreate = false;
      const createRecord = svc.sessionRegistry.create.bind(svc.sessionRegistry);
      vi.spyOn(svc.sessionRegistry, 'create').mockImplementation(async (record) => {
        await createRecord(record);
        expect(svc.sessionRegistry.get(ws.id, record.id)).toEqual(record);
        createdRecordIds.push(record.id);
        if (breakConfigAfterCreate) {
          await rm(configPath, { force: true });
          await mkdir(configPath, { recursive: true });
        }
      });

      const spawn = vi.spyOn(svc.pool, 'spawn').mockImplementation(() => {
        throw new Error('unexpected scheduled PTY spawn');
      });
      spawn.mockImplementationOnce(() => {
        throw new Error('scheduled PTY spawn failed after config preparation');
      });

      const wake = (wakeId: string, nowMs: number): ScheduleStewardWakeInput => ({
        issueId: `issue-${wakeId}`,
        wakeId,
        reason: 'scheduled_observe',
        accountId: 'mock-simulator-1',
        authzLevel: 'paper',
        expectedDecision: 'no_trade',
        humanRequest: 'Observe the paper account.',
        agent: 'shell',
        nowMs,
      });
      const wakeStore = createStewardWakeStore(workspaceDir);
      const lockStore = createStewardLockStore(workspaceDir);

      await expect(svc.dispatchStewardWake(
        ws,
        wake('wake-scheduled-spawn-fail', Date.parse('2026-07-12T01:00:00.000Z')),
      )).rejects.toThrow('scheduled PTY spawn failed after config preparation');

      const spawnFailedRecordId = createdRecordIds[0];
      expect(spawnFailedRecordId).toBeDefined();
      expect(svc.sessionRegistry.get(ws.id, spawnFailedRecordId!)).toBeUndefined();
      expect(await readFile(configPath, 'utf8')).toBe(priorConfig);
      expect(await wakeStore.require('wake-scheduled-spawn-fail')).toMatchObject({
        status: 'error',
        injectedAt: null,
        completedAt: expect.any(String),
        error: 'scheduled PTY spawn failed after config preparation',
      });
      expect(await lockStore.get('mock-simulator-1')).toBeNull();

      breakConfigAfterCreate = true;
      const spawnCallsBeforeConfigFailure = spawn.mock.calls.length;
      await expect(svc.dispatchStewardWake(
        ws,
        wake('wake-scheduled-config-fail', Date.parse('2026-07-12T01:01:00.000Z')),
      )).rejects.toThrow();
      breakConfigAfterCreate = false;

      const configFailedRecordId = createdRecordIds[1];
      expect(configFailedRecordId).toBeDefined();
      expect(spawn).toHaveBeenCalledTimes(spawnCallsBeforeConfigFailure);
      expect(svc.sessionRegistry.get(ws.id, configFailedRecordId!)).toBeUndefined();
      expect(await wakeStore.require('wake-scheduled-config-fail')).toMatchObject({
        status: 'error',
        injectedAt: null,
        completedAt: expect.any(String),
      });
      expect(await lockStore.get('mock-simulator-1')).toBeNull();

      await rm(configPath, { recursive: true, force: true });
      await writeFile(configPath, priorConfig, 'utf8');
      spawn.mockImplementationOnce(() => {
        writeFileSync(configPath, externalConfig, 'utf8');
        throw new Error('scheduled PTY spawn failed after external config publication');
      });
      await expect(svc.dispatchStewardWake(
        ws,
        wake('wake-scheduled-rollback-owner-lost', Date.parse('2026-07-12T01:02:00.000Z')),
      )).rejects.toThrow('refusing stale rollback');

      const rollbackFailedRecordId = createdRecordIds[2];
      expect(rollbackFailedRecordId).toBeDefined();
      expect(svc.sessionRegistry.get(ws.id, rollbackFailedRecordId!)).toBeUndefined();
      expect(await readFile(configPath, 'utf8')).toBe(externalConfig);
      expect(await wakeStore.require('wake-scheduled-rollback-owner-lost')).toMatchObject({
        status: 'error',
        injectedAt: null,
        completedAt: expect.any(String),
        error: expect.stringContaining('refusing stale rollback'),
      });
      expect(await lockStore.get('mock-simulator-1')).toBeNull();

      spawn.mockImplementationOnce((wsId, ctx) => ({
        recordId: ctx.recordId,
        wsId,
        name: ctx.recordName,
        pid: 4321,
        agentSessionId: null,
        startedAt: 1,
      }) as unknown as ReturnType<typeof svc.pool.spawn>);

      await expect(svc.dispatchStewardWake(
        ws,
        wake('wake-scheduled-retry', Date.parse('2026-07-12T01:03:00.000Z')),
      )).resolves.toEqual({ wakeId: 'wake-scheduled-retry' });
      expect(await wakeStore.require('wake-scheduled-retry')).toMatchObject({
        status: 'injected',
        injectedAt: expect.any(String),
      });
      expect(await lockStore.get('mock-simulator-1')).toMatchObject({
        wakeId: 'wake-scheduled-retry',
      });
      expect(svc.sessionRegistry.get(ws.id, createdRecordIds[3]!)).toBeDefined();
    } finally {
      await service?.dispose('scheduled steward test complete');
      if (previousLauncherRoot === undefined) {
        delete process.env['AQ_LAUNCHER_ROOT'];
      } else {
        process.env['AQ_LAUNCHER_ROOT'] = previousLauncherRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
