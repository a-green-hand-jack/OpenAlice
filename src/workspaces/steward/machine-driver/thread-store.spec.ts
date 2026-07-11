import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMachineThreadStore } from './thread-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steward-machine-thread-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('MachineThreadStore', () => {
  it('returns null when the record is absent', async () => {
    expect(await createMachineThreadStore(dir).read()).toBeNull();
  });

  it('round-trips a written record', async () => {
    const store = createMachineThreadStore(dir);
    const written = await store.write({
      threadId: 'thread-abc',
      model: 'gpt-5-codex',
      createdAt: '2026-07-08T14:00:00.000Z',
      lastTurnAt: '2026-07-08T14:02:00.000Z',
    });

    expect(written).toEqual({
      version: 1,
      provider: 'codex',
      threadId: 'thread-abc',
      model: 'gpt-5-codex',
      createdAt: '2026-07-08T14:00:00.000Z',
      lastTurnAt: '2026-07-08T14:02:00.000Z',
    });
    expect(existsSync(store.path())).toBe(true);
    expect(await store.read()).toEqual(written);
  });

  it('defaults lastTurnAt to null and omits an absent model', async () => {
    const store = createMachineThreadStore(dir);
    const written = await store.write({
      threadId: 'thread-fresh',
      createdAt: '2026-07-08T14:00:00.000Z',
    });

    expect(written.lastTurnAt).toBeNull();
    expect(written.model).toBeUndefined();
    expect(await store.read()).toEqual(written);
  });

  it('records an explicit provider and round-trips it (issue #146 S5)', async () => {
    const store = createMachineThreadStore(dir);
    const written = await store.write({
      provider: 'claude',
      threadId: 'claude-session-1',
      createdAt: '2026-07-11T00:00:00.000Z',
    });

    expect(written.provider).toBe('claude');
    expect(await store.read()).toEqual(written);
  });

  it('records an explicit accountId and round-trips it (issue #155)', async () => {
    const store = createMachineThreadStore(dir);
    const written = await store.write({
      threadId: 'thread-with-account',
      createdAt: '2026-07-11T00:00:00.000Z',
      accountId: 'account-1',
    });

    expect(written.accountId).toBe('account-1');
    expect(await store.read()).toEqual(written);
  });

  it('omits accountId when not provided (legacy shape, no key present)', async () => {
    const store = createMachineThreadStore(dir);
    const written = await store.write({
      threadId: 'thread-no-account',
      createdAt: '2026-07-11T00:00:00.000Z',
    });

    expect(written.accountId).toBeUndefined();
    expect(Object.keys(written)).not.toContain('accountId');
  });

  it('treats a corrupt file as no thread (null), never throwing', async () => {
    const store = createMachineThreadStore(dir);
    await mkdir(dirname(store.path()), { recursive: true });
    await writeFile(store.path(), '{ not: valid json', 'utf8');

    expect(await store.read()).toBeNull();
  });

  it('atomically overwrites a prior record', async () => {
    const store = createMachineThreadStore(dir);
    await store.write({ threadId: 'thread-1', createdAt: '2026-07-08T14:00:00.000Z' });
    const replaced = await store.write({
      threadId: 'thread-2',
      model: 'gpt-5-codex',
      createdAt: '2026-07-08T15:00:00.000Z',
      lastTurnAt: '2026-07-08T15:01:00.000Z',
    });

    const read = await store.read();
    expect(read).toEqual(replaced);
    expect(read?.threadId).toBe('thread-2');
  });
});
