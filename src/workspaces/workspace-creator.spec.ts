/**
 * Tests for runScript() — focuses on the platform branch added for
 * Windows compatibility. The actual subprocess is mocked; we only
 * verify the spawn call shape (cmd + args) and the ENOENT-on-Windows
 * error message.
 *
 * We can't run the real bash on a non-Windows CI when testing the
 * win32 branch (and vice versa on Windows), so this test stubs
 * `process.platform` and `child_process.spawn` to exercise both
 * branches deterministically regardless of where vitest runs.
 */

import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshWorkspaceInstructions } from './context-injector.js';
import { resolveCreateAgents, runScript, WorkspaceCreator } from './workspace-creator.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));
vi.mock('./context-injector.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context-injector.js')>()),
  refreshWorkspaceInstructions: vi.fn(async () => ({ changed: false })),
  writeStewardContextManifest: vi.fn(async () => undefined),
}));

const mockSpawn = vi.mocked(childProcess.spawn);

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.exitCode = null;
  return child;
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('resolveCreateAgents — single home of the agent policy', () => {
  const ALL = ['claude', 'codex', 'opencode', 'pi', 'shell'];

  it('enables EVERY registered adapter when the caller pins nothing', () => {
    // The quick-chat bug: it called create() with no explicit set, so it used
    // to get only the template head (claude+codex). Policy now expands here.
    expect(resolveCreateAgents(undefined, ['claude', 'codex'], ALL)).toEqual(ALL);
  });

  it('honors template defaultAgents as the agent-runtime order head', () => {
    // A template that wants codex first still gets all four, codex leading.
    expect(resolveCreateAgents(undefined, ['codex'], ALL)).toEqual([
      'codex', 'claude', 'opencode', 'pi', 'shell',
    ]);
  });

  it('first-wins dedupes when the head repeats a registered id', () => {
    expect(resolveCreateAgents(undefined, ['pi', 'claude'], ALL)).toEqual([
      'pi', 'claude', 'codex', 'opencode', 'shell',
    ]);
  });

  it('keeps shell enabled but never ahead of agent runtimes', () => {
    expect(resolveCreateAgents(undefined, ['shell', 'codex'], ALL)).toEqual([
      'codex', 'claude', 'opencode', 'pi', 'shell',
    ]);
  });

  it('an explicit non-empty request wins verbatim (subset pinning)', () => {
    expect(resolveCreateAgents(['claude'], ['claude', 'codex'], ALL)).toEqual(['claude']);
  });

  it('treats an empty explicit request as "not pinned" → full expansion', () => {
    expect(resolveCreateAgents([], ['claude', 'codex'], ALL)).toEqual(ALL);
  });
});

describe('runScript platform branching', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    setPlatform(originalPlatform);
    mockSpawn.mockReset();
  });

  it('on macOS / Linux, spawns the script directly so kernel reads the shebang', async () => {
    setPlatform('darwin');
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as childProcess.ChildProcess);

    const promise = runScript('/tmp/foo/bootstrap.sh', ['tag-1', '/out'], { FOO: 'bar' }, 60_000);
    child.emit('close', 0);
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      '/tmp/foo/bootstrap.sh',
      ['tag-1', '/out'],
      expect.objectContaining({
        env: expect.objectContaining({ FOO: 'bar' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });

  it('on win32, wraps bash with the script as first arg (kernel does not read shebang)', async () => {
    setPlatform('win32');
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as childProcess.ChildProcess);

    const promise = runScript(
      'C:\\Users\\me\\templates\\chat\\bootstrap.sh',
      ['tag-1', 'C:\\out'],
      {},
      60_000,
    );
    child.emit('close', 0);
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'bash',
      ['C:\\Users\\me\\templates\\chat\\bootstrap.sh', 'tag-1', 'C:\\out'],
      expect.any(Object),
    );
  });

  it('a .mjs bootstrap runs on the bundled Node (process.execPath), NOT bash, on win32', async () => {
    setPlatform('win32');
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as childProcess.ChildProcess);

    const promise = runScript(
      'C:\\Users\\me\\templates\\chat\\bootstrap.mjs',
      ['tag-1', 'C:\\out'],
      { FOO: 'bar' },
      60_000,
    );
    child.emit('close', 0);
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['C:\\Users\\me\\templates\\chat\\bootstrap.mjs', 'tag-1', 'C:\\out'],
      expect.objectContaining({
        env: expect.objectContaining({ FOO: 'bar', ELECTRON_RUN_AS_NODE: '1' }),
      }),
    );
  });

  it('a .mjs bootstrap runs on process.execpath on macOS too (no shebang/bash reliance)', async () => {
    setPlatform('darwin');
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as childProcess.ChildProcess);

    const promise = runScript('/tmp/foo/bootstrap.mjs', ['t', '/out'], {}, 60_000);
    child.emit('close', 0);
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/foo/bootstrap.mjs', 't', '/out'],
      expect.objectContaining({ env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }) }),
    );
  });

  it('on win32, ENOENT spawn error surfaces a Git-for-Windows install hint', async () => {
    setPlatform('win32');
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as childProcess.ChildProcess);

    const promise = runScript('C:\\bootstrap.sh', [], {}, 60_000);
    child.emit('error', new Error('spawn bash ENOENT'));
    const res = await promise;

    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/spawn bash ENOENT/);
    expect(res.stderr).toMatch(/gitforwindows\.org/);
    expect(res.stderr).toMatch(/WSL2/);
  });

  it('on macOS / Linux, ENOENT does NOT add the Windows hint', async () => {
    setPlatform('darwin');
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as childProcess.ChildProcess);

    const promise = runScript('/tmp/missing.sh', [], {}, 60_000);
    child.emit('error', new Error('spawn /tmp/missing.sh ENOENT'));
    const res = await promise;

    expect(res.ok).toBe(false);
    expect(res.stderr).not.toMatch(/gitforwindows\.org/);
  });
});

describe('WorkspaceCreator.refreshStewardRuntime (issue #140 merge gate)', () => {
  const statePath = (dir: string) => join(dir, '.alice/steward/runtime-state.json');

  afterEach(() => {
    mockSpawn.mockReset();
    vi.mocked(refreshWorkspaceInstructions).mockReset().mockResolvedValue({ changed: false });
  });

  function makeCreator(
    templateGet: (name: string) => unknown,
  ): WorkspaceCreator {
    return new WorkspaceCreator({
      workspacesRoot: '/ws-root',
      templateRegistry: { get: templateGet } as never,
      adapterRegistry: {} as never,
      bootstrapEnv: { templateDir: '/tpl', launcherRepoRoot: '/repo' },
      bootstrapTimeoutMs: 60_000,
      registry: {} as never,
      logger: { child: () => ({}) } as never,
    });
  }
  const stewardTemplate = {
    bootstrapScript: '/tpl/steward/bootstrap.mjs',
    filesDir: '/tpl/steward/files',
    instructionPath: '/tpl/steward/files/instruction.md',
    policyContent: '# overlay policy\n',
    policyContractVersion: 1,
    templateDir: '/tpl/steward',
  };

  async function prepareRuntimeArtifacts(
    dir: string,
    agents = '# steward agents v3\n',
  ): Promise<void> {
    await mkdir(join(dir, '.alice/steward'), { recursive: true });
    await Promise.all([
      writeFile(join(dir, '.alice/steward/runtime.json'), '{"protocol":3}\n', 'utf8'),
      writeFile(join(dir, 'AGENTS.md'), agents, 'utf8'),
      writeFile(join(dir, 'CLAUDE.md'), '# steward claude v3\n', 'utf8'),
    ]);
  }

  async function completeSuccessfulRefresh(
    creator: WorkspaceCreator,
    dir: string,
  ): Promise<Awaited<ReturnType<WorkspaceCreator['refreshStewardRuntime']>>> {
    const expectedCalls = mockSpawn.mock.calls.length + 1;
    const child = makeFakeChild();
    mockSpawn.mockReturnValueOnce(child as unknown as childProcess.ChildProcess);
    const pending = creator.refreshStewardRuntime({ template: 'steward', dir });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(expectedCalls));
    child.emit('close', 0);
    return pending;
  }

  it('is a no-op for a non-steward workspace (never spawns)', async () => {
    const creator = makeCreator(() => undefined);
    const res = await creator.refreshStewardRuntime({ template: 'chat', dir: '/ws' });
    expect(res).toEqual({ ok: true });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('runs the steward bootstrap in --refresh-runtime mode for the workspace dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-creator-runtime-mode-'));
    try {
      await prepareRuntimeArtifacts(dir);
      const creator = makeCreator((name) => (name === 'steward' ? stewardTemplate : undefined));
      const res = await completeSuccessfulRefresh(creator, dir);
      expect(res).toMatchObject({
        ok: true,
        desiredDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        forceFreshPty: true,
        forceFreshMachine: true,
      });
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('--refresh-runtime');
      expect(args).toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['pty', 'machine'] as const)('refreshes composed policy and mechanics before a %s wake', async (face) => {
    const dir = await mkdtemp(join(tmpdir(), `workspace-creator-runtime-${face}-overlay-`));
    try {
      await prepareRuntimeArtifacts(dir);
      const creator = makeCreator((name) => (name === 'steward' ? stewardTemplate : undefined));
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child as unknown as childProcess.ChildProcess);
      const pending = creator.withStewardRuntimeLease(
        { template: 'steward', dir },
        face,
        async () => undefined,
      );
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
      child.emit('close', 0);
      await expect(pending).resolves.toBeUndefined();
      expect(vi.mocked(refreshWorkspaceInstructions)).toHaveBeenLastCalledWith({
        template: expect.objectContaining({
          instructionPath: '/tpl/steward/files/instruction.md',
          policyContent: '# overlay policy\n',
        }),
        dir,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an actionable error when the refresh script exits non-zero', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as childProcess.ChildProcess);
    const creator = makeCreator((name) => (name === 'steward' ? stewardTemplate : undefined));
    const p = creator.refreshStewardRuntime({ template: 'steward', dir: '/ws' });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('validator write failed'));
    child.emit('close', 1);
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('validator write failed');
  });

  it('errors when the steward template is not registered', async () => {
    const creator = makeCreator(() => undefined);
    const res = await creator.refreshStewardRuntime({ template: 'steward', dir: '/ws' });
    expect(res.ok).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('requires both faces on first wake and persists exact-digest acknowledgements across refreshes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-creator-runtime-refresh-'));
    try {
      await prepareRuntimeArtifacts(dir);
      const creator = makeCreator((name) => (name === 'steward' ? stewardTemplate : undefined));
      const first = await completeSuccessfulRefresh(creator, dir);
      expect(first.ok).toBe(true);
      if (!first.ok || !first.desiredDigest) throw new Error('expected steward runtime digest');
      expect(first).toMatchObject({ forceFreshPty: true, forceFreshMachine: true });

      await expect(creator.acknowledgeStewardRuntimeFresh(
        { template: 'steward', dir },
        'pty',
        first.desiredDigest,
      )).resolves.toBe(true);

      await expect(completeSuccessfulRefresh(creator, dir)).resolves.toEqual({
        ok: true,
        desiredDigest: first.desiredDigest,
        forceFreshPty: false,
        forceFreshMachine: true,
      });
      expect(JSON.parse(await readFile(statePath(dir), 'utf8'))).toEqual({
        version: 1,
        desiredDigest: first.desiredDigest,
        acknowledged: { pty: first.desiredDigest, machine: null },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('repairs a partial state record without losing a valid face acknowledgement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-creator-runtime-repair-'));
    try {
      await prepareRuntimeArtifacts(dir);
      const creator = makeCreator((name) => (name === 'steward' ? stewardTemplate : undefined));
      const first = await completeSuccessfulRefresh(creator, dir);
      if (!first.ok || !first.desiredDigest) throw new Error('expected steward runtime digest');
      await writeFile(statePath(dir), `${JSON.stringify({
        version: 1,
        desiredDigest: first.desiredDigest,
        acknowledged: { pty: first.desiredDigest, machine: 'invalid-digest' },
      })}\n`, 'utf8');

      await expect(completeSuccessfulRefresh(creator, dir)).resolves.toEqual({
        ok: true,
        desiredDigest: first.desiredDigest,
        forceFreshPty: false,
        forceFreshMachine: true,
      });
      expect(JSON.parse(await readFile(statePath(dir), 'utf8'))).toEqual({
        version: 1,
        desiredDigest: first.desiredDigest,
        acknowledged: { pty: first.desiredDigest, machine: null },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refreshes authoritatively inside the lease and auto-acknowledges generation B after successful use', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-creator-runtime-lease-'));
    try {
      await prepareRuntimeArtifacts(dir, '# steward agents generation A\n');
      const creator = makeCreator((name) => (name === 'steward' ? stewardTemplate : undefined));
      const generationA = await completeSuccessfulRefresh(creator, dir);
      if (!generationA.ok || !generationA.desiredDigest) throw new Error('expected generation A');
      await creator.acknowledgeStewardRuntimeFresh(
        { template: 'steward', dir },
        'pty',
        generationA.desiredDigest,
      );

      // A caller observed acknowledged A before taking its account lock. B
      // publishes new authoritative instruction bytes before A enters its
      // post-lock lease.
      await writeFile(join(dir, 'AGENTS.md'), '# steward agents generation B\n', 'utf8');
      const leaseChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(leaseChild as unknown as childProcess.ChildProcess);
      const leased = creator.withStewardRuntimeLease(
        { template: 'steward', dir },
        'pty',
        async (runtime) => {
          expect(runtime.desiredDigest).not.toBe(generationA.desiredDigest);
          expect(runtime.forceFresh).toBe(true);
          const during = JSON.parse(await readFile(statePath(dir), 'utf8'));
          expect(during.acknowledged.pty).toBe(generationA.desiredDigest);
          return runtime.desiredDigest;
        },
      );
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      leaseChild.emit('close', 0);
      const generationB = await leased;

      expect(JSON.parse(await readFile(statePath(dir), 'utf8'))).toEqual({
        version: 1,
        desiredDigest: generationB,
        acknowledged: { pty: generationB, machine: null },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks competing refresh and ack transitions until the leased face finishes selecting and injecting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-creator-runtime-lease-block-'));
    try {
      await prepareRuntimeArtifacts(dir);
      const creator = makeCreator((name) => (name === 'steward' ? stewardTemplate : undefined));
      const leaseChild = makeFakeChild();
      const queuedRefreshChild = makeFakeChild();
      mockSpawn
        .mockReturnValueOnce(leaseChild as unknown as childProcess.ChildProcess)
        .mockReturnValueOnce(queuedRefreshChild as unknown as childProcess.ChildProcess);
      let operationStarted!: () => void;
      const started = new Promise<void>((resolve) => { operationStarted = resolve; });
      let finishOperation!: () => void;
      const operationGate = new Promise<void>((resolve) => { finishOperation = resolve; });
      let leasedDigest = '';

      const leased = creator.withStewardRuntimeLease(
        { template: 'steward', dir },
        'pty',
        async (runtime) => {
          leasedDigest = runtime.desiredDigest;
          operationStarted();
          await operationGate;
          return 'injected';
        },
      );
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
      leaseChild.emit('close', 0);
      await started;

      let acknowledgementSettled = false;
      const competingAcknowledgement = creator.acknowledgeStewardRuntimeFresh(
        { template: 'steward', dir },
        'machine',
        leasedDigest,
      ).then((value) => {
        acknowledgementSettled = true;
        return value;
      });
      const competingRefresh = creator.refreshStewardRuntime({ template: 'steward', dir });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(vi.mocked(refreshWorkspaceInstructions)).toHaveBeenCalledTimes(1);
      expect(acknowledgementSettled).toBe(false);

      finishOperation();
      await expect(leased).resolves.toBe('injected');
      await expect(competingAcknowledgement).resolves.toBe(true);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      queuedRefreshChild.emit('close', 0);
      await expect(competingRefresh).resolves.toMatchObject({ ok: true });
      expect(vi.mocked(refreshWorkspaceInstructions)).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not acknowledge a failed face operation and releases the lease for the next refresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-creator-runtime-lease-error-'));
    try {
      await prepareRuntimeArtifacts(dir);
      const creator = makeCreator((name) => (name === 'steward' ? stewardTemplate : undefined));
      const leaseChild = makeFakeChild();
      const nextRefreshChild = makeFakeChild();
      mockSpawn
        .mockReturnValueOnce(leaseChild as unknown as childProcess.ChildProcess)
        .mockReturnValueOnce(nextRefreshChild as unknown as childProcess.ChildProcess);

      const leased = creator.withStewardRuntimeLease(
        { template: 'steward', dir },
        'machine',
        async () => { throw new Error('turn did not start'); },
      );
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
      leaseChild.emit('close', 0);
      await expect(leased).rejects.toThrow('turn did not start');
      expect(JSON.parse(await readFile(statePath(dir), 'utf8')).acknowledged.machine).toBeNull();

      const nextRefresh = creator.refreshStewardRuntime({ template: 'steward', dir });
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      nextRefreshChild.emit('close', 0);
      await expect(nextRefresh).resolves.toMatchObject({ ok: true, forceFreshMachine: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects stale acknowledgements across an A-B-A runtime sequence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-creator-runtime-aba-'));
    try {
      const agentsA = '# steward agents generation A\n';
      await prepareRuntimeArtifacts(dir, agentsA);
      const creator = makeCreator((name) => (name === 'steward' ? stewardTemplate : undefined));

      const generationA = await completeSuccessfulRefresh(creator, dir);
      if (!generationA.ok || !generationA.desiredDigest) throw new Error('expected generation A');
      await expect(creator.acknowledgeStewardRuntimeFresh(
        { template: 'steward', dir },
        'pty',
        generationA.desiredDigest,
      )).resolves.toBe(true);

      await writeFile(join(dir, 'AGENTS.md'), '# steward agents generation B\n', 'utf8');
      const generationBChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(generationBChild as unknown as childProcess.ChildProcess);
      const generationBPending = creator.refreshStewardRuntime({ template: 'steward', dir });
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
      const staleGenerationAAck = creator.acknowledgeStewardRuntimeFresh(
        { template: 'steward', dir },
        'pty',
        generationA.desiredDigest,
      );
      generationBChild.emit('close', 0);
      const generationB = await generationBPending;
      if (!generationB.ok || !generationB.desiredDigest) throw new Error('expected generation B');
      expect(generationB.desiredDigest).not.toBe(generationA.desiredDigest);
      await expect(staleGenerationAAck).resolves.toBe(false);
      await expect(creator.acknowledgeStewardRuntimeFresh(
        { template: 'steward', dir },
        'pty',
        generationB.desiredDigest,
      )).resolves.toBe(true);

      await writeFile(join(dir, 'AGENTS.md'), agentsA, 'utf8');
      const generationAAgain = await completeSuccessfulRefresh(creator, dir);
      expect(generationAAgain).toEqual({
        ok: true,
        desiredDigest: generationA.desiredDigest,
        forceFreshPty: true,
        forceFreshMachine: true,
      });
      await expect(creator.acknowledgeStewardRuntimeFresh(
        { template: 'steward', dir },
        'pty',
        generationB.desiredDigest,
      )).resolves.toBe(false);
      expect(JSON.parse(await readFile(statePath(dir), 'utf8'))).toEqual({
        version: 1,
        desiredDigest: generationA.desiredDigest,
        acknowledged: { pty: generationB.desiredDigest, machine: null },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('coalesces concurrent refreshes so every caller observes the same desired digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workspace-creator-runtime-concurrent-'));
    try {
      await prepareRuntimeArtifacts(dir);
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child as unknown as childProcess.ChildProcess);
      const creator = makeCreator((name) => (name === 'steward' ? stewardTemplate : undefined));

      const first = creator.refreshStewardRuntime({ template: 'steward', dir });
      const second = creator.refreshStewardRuntime({ template: 'steward', dir });
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
      child.emit('close', 0);

      const firstResult = await first;
      const secondResult = await second;
      expect(firstResult).toEqual(secondResult);
      expect(firstResult).toMatchObject({
        ok: true,
        desiredDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        forceFreshPty: true,
        forceFreshMachine: true,
      });
      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(statePath(dir), 'utf8'))).toMatchObject({
        version: 1,
        desiredDigest: firstResult.ok ? firstResult.desiredDigest : undefined,
        acknowledged: { pty: null, machine: null },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
