import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkspaceService, type WorkspaceService } from './service.js';
import type { ScheduleStewardWakeInput } from './schedule/scanner.js';
import {
  createStewardLockStore,
  createStewardWakeStore,
} from './steward/index.js';
import type { WorkspaceMeta } from './workspace-registry.js';

describe('scheduled steward PTY cleanup (issue #177)', () => {
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
      vi.spyOn(svc.creator, 'refreshStewardRuntime').mockResolvedValue({ ok: true });

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
