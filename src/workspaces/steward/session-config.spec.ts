import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFile } from './ledger-writer.js';
import {
  prepareStewardSessionConfig,
  StewardSessionConfigLeaseQueue,
} from './session-config.js';

describe('steward session config preparation', () => {
  it.each(['rollback', 'commit'] as const)(
    'does not grant a second production preparation before the first owner settles via %s',
    async (mode) => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'steward-session-config-'));
      const configPath = join(workspaceDir, '.alice/steward/config.json');
      const prior = '{"version":1,"agent":"codex","sessionId":null}\n';
      const queue = new StewardSessionConfigLeaseQueue();
      const grants: string[] = [];
      try {
        await mkdir(join(workspaceDir, '.alice/steward'), { recursive: true });
        await writeFile(configPath, prior, 'utf8');
        const first = await prepareStewardSessionConfig(
          workspaceDir,
          JSON.parse(prior) as Record<string, unknown>,
          'first-session-id',
          'codex',
          { leaseQueue: queue, onLeaseGranted: () => grants.push('first') },
        );
        const secondPromise = prepareStewardSessionConfig(
          workspaceDir,
          JSON.parse(prior) as Record<string, unknown>,
          'second-session-id',
          'codex',
          { leaseQueue: queue, onLeaseGranted: () => grants.push('second') },
        );

        expect(grants).toEqual(['first']);
        if (mode === 'rollback') {
          await first.rollback();
        } else {
          await first.commit();
        }
        expect(grants).toEqual(['first', 'second']);

        const second = await secondPromise;
        await second.commit();
        expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
          sessionId: 'second-session-id',
        });
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')('leaves the prior complete config untouched when atomic preparation cannot publish', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'steward-session-config-'));
    const configDir = join(workspaceDir, '.alice/steward');
    const configPath = join(configDir, 'config.json');
    const prior = '{\n  "version": 1,\n  "agent": "codex",\n  "sessionId": null\n}\n';
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(configPath, prior, 'utf8');
      await chmod(configDir, 0o500);

      await expect(prepareStewardSessionConfig(
        workspaceDir,
        JSON.parse(prior) as Record<string, unknown>,
        'new-session-id',
        'codex',
      )).rejects.toMatchObject({ code: 'EACCES' });

      expect(await readFile(configPath, 'utf8')).toBe(prior);
      expect(await readdir(configDir)).toEqual(['config.json']);

      await chmod(configDir, 0o700);
      const retry = await prepareStewardSessionConfig(
        workspaceDir,
        JSON.parse(prior) as Record<string, unknown>,
        'retry-session-id',
        'codex',
      );
      await retry.commit();
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        sessionId: 'retry-session-id',
      });
    } finally {
      await chmod(configDir, 0o700).catch(() => undefined);
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('rolls a prior-absent config back to exact absence', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'steward-session-config-'));
    const configPath = join(workspaceDir, '.alice/steward/config.json');
    try {
      const preparation = await prepareStewardSessionConfig(
        workspaceDir,
        {},
        'temporary-session-id',
        'codex',
      );
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        sessionId: 'temporary-session-id',
      });

      await preparation.rollback();
      await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(preparation.rollback()).resolves.toBeUndefined();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('serializes overlapping preparations and refuses a stale rollback over a later value', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'steward-session-config-'));
    const configPath = join(workspaceDir, '.alice/steward/config.json');
    const prior = '{"version":1,"agent":"codex","sessionId":null}\n';
    try {
      await mkdir(join(workspaceDir, '.alice/steward'), { recursive: true });
      await writeFile(configPath, prior, 'utf8');
      const first = await prepareStewardSessionConfig(
        workspaceDir,
        JSON.parse(prior) as Record<string, unknown>,
        'first-session-id',
        'codex',
      );

      const external = '{"version":1,"agent":"codex","sessionId":"external-session-id"}\n';
      const secondPromise = prepareStewardSessionConfig(
        workspaceDir,
        JSON.parse(external) as Record<string, unknown>,
        'second-session-id',
        'codex',
      );

      await atomicWriteFile(configPath, external);
      await expect(first.rollback()).rejects.toThrow('refusing stale rollback');
      const second = await secondPromise;
      await second.commit();
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        sessionId: 'second-session-id',
      });

      await expect(first.rollback()).rejects.toThrow('refusing stale rollback');
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
        sessionId: 'second-session-id',
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
