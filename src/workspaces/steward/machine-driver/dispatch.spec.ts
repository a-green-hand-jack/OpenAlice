import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CODEX_MODEL_OVERRIDE_PATH, codexAdapter } from '../../adapters/codex.js';
import type { WorkspaceMeta } from '../../workspace-registry.js';
import { CodexAppServerDriver } from './codex-app-server-driver.js';
import { NOOP_LOGGER } from './jsonrpc-stdio.js';
import {
  buildMachineDriver,
  decideStewardControlFace,
  dispatchMachineWake,
  resolveStewardControlFace,
  type DispatchMachineWakeInput,
} from './dispatch.js';
import { createMachineThreadStore } from './thread-store.js';
import type {
  DriverEvent,
  EnsureThreadOptions,
  RunTurnOptions,
  StewardMachineDriver,
  TurnOutcome,
} from './types.js';
import {
  createStewardLockStore,
  createStewardSupervisor,
  createStewardWakeStore,
  stewardSupervisorLogPath,
  type StewardWakeEnvelope,
} from '../index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steward-machine-dispatch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const envelope: StewardWakeEnvelope = {
  reason: 'scheduled_observe',
  accountId: 'mock-simulator-1',
  authzLevel: 'paper',
  expectedDecision: 'no_trade',
  marketContext: { symbols: ['AAPL'] },
  riskContext: { riskState: 'NORMAL', guards: [] },
};

const COMPLETED: TurnOutcome = {
  turnId: 'turn-1',
  status: 'completed',
  agentMessage: null,
  durationMs: 1,
  interrupted: false,
};

interface MockDriverOverrides {
  readonly ensureThread?: (o: EnsureThreadOptions) => Promise<{ threadId: string; resumed: boolean }>;
  readonly runTurn?: (threadId: string, input: string, o?: RunTurnOptions) => Promise<TurnOutcome>;
  readonly isThreadLive?: (threadId: string) => boolean;
}

interface MockDriver {
  readonly driver: StewardMachineDriver;
  readonly calls: {
    ensureThread: EnsureThreadOptions[];
    runTurn: { threadId: string; input: string }[];
  };
}

/** A `StewardMachineDriver` fake with call capture; overridable per test. The
 *  default `runTurn` fires `turn-started` (so the dispatcher marks `injected`)
 *  then resolves `completed`. */
function makeMockDriver(overrides: MockDriverOverrides = {}): MockDriver {
  const calls = {
    ensureThread: [] as EnsureThreadOptions[],
    runTurn: [] as { threadId: string; input: string }[],
  };
  const driver: StewardMachineDriver = {
    ensureThread: async (o) => {
      calls.ensureThread.push(o);
      if (overrides.ensureThread) return overrides.ensureThread(o);
      return { threadId: 'thread-fresh', resumed: o.threadId !== undefined };
    },
    runTurn: async (threadId, input, o) => {
      calls.runTurn.push({ threadId, input });
      if (overrides.runTurn) return overrides.runTurn(threadId, input, o);
      o?.onEvent?.({ type: 'turn-started', threadId, turnId: 'turn-1' });
      return COMPLETED;
    },
    interruptTurn: async () => {},
    isThreadLive: (threadId) => (overrides.isThreadLive ? overrides.isThreadLive(threadId) : true),
    readTelemetry: () => null,
    dispose: async () => {},
  };
  return { driver, calls };
}

function turnStarted(threadId: string): DriverEvent {
  return { type: 'turn-started', threadId, turnId: 'turn-1' };
}

async function readSupervisorEvents(): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met within timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const NOW = '2026-07-08T14:00:00.000Z';
const FUTURE_DEADLINE = '2999-01-01T00:00:00.000Z';

function baseInput(driver: StewardMachineDriver, over: Partial<DispatchMachineWakeInput> = {}): DispatchMachineWakeInput {
  return {
    workspaceDir: dir,
    wsId: 'ws-1',
    cwd: dir,
    driver,
    wakeStore: createStewardWakeStore(dir),
    threadStore: createMachineThreadStore(dir),
    wake: { wakeId: 'wake-m', deadline: FUTURE_DEADLINE, envelope },
    now: NOW,
    logger: NOOP_LOGGER,
    ...over,
  };
}

describe('decideStewardControlFace (issue #146)', () => {
  it('is PTY (no reason) when controlFace is absent — byte-identical pre-#146 default', () => {
    const d = decideStewardControlFace({ config: {}, requestedAgent: undefined, workspaceAgents: ['codex'] });
    expect(d.useMachine).toBe(false);
    expect(d.declineReason).toBeUndefined();
  });

  it("is PTY (no reason) when controlFace is explicitly 'pty'", () => {
    const d = decideStewardControlFace({
      config: { controlFace: 'pty' },
      requestedAgent: undefined,
      workspaceAgents: ['codex'],
    });
    expect(d.useMachine).toBe(false);
    expect(d.declineReason).toBeUndefined();
  });

  it('honors machine for a codex-enabled workspace', () => {
    const d = decideStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: undefined,
      workspaceAgents: ['codex', 'shell'],
    });
    expect(d).toEqual({ useMachine: true, agent: 'codex' });
  });

  it('declines to PTY with a reason when the resolved agent is not codex', () => {
    const d = decideStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: 'claude',
      workspaceAgents: ['codex', 'claude'],
    });
    expect(d.useMachine).toBe(false);
    expect(d.agent).toBe('claude');
    expect(d.declineReason).toMatch(/codex-only/);
  });

  it('declines to PTY when codex is not enabled on the workspace', () => {
    const d = decideStewardControlFace({
      config: { controlFace: 'machine', agent: 'codex' },
      requestedAgent: undefined,
      workspaceAgents: ['claude'],
    });
    expect(d.useMachine).toBe(false);
    expect(d.declineReason).toMatch(/enable codex/);
  });
});

describe('dispatchMachineWake (issue #146, S3)', () => {
  it('fresh dispatch: starts a thread, creates a machine wake keyed off the thread UUID, injects', async () => {
    const { driver, calls } = makeMockDriver({
      ensureThread: async (o) => {
        expect(o.threadId).toBeUndefined();
        return { threadId: 'thread-uuid-abc', resumed: false };
      },
    });
    const result = await dispatchMachineWake(baseInput(driver));

    // ensureThread THEN runTurn, in that order.
    expect(calls.ensureThread).toHaveLength(1);
    // Issue #146 MAJOR-1: every steward machine thread requests network-enabled
    // workspace-write, mirroring the PTY codex adapter's unconditional
    // `-c sandbox_workspace_write.network_access=true` — without this `alice*`
    // cannot reach the loopback CLI gateway and the UTA checklist can't run.
    expect(calls.ensureThread[0]).toMatchObject({ networkAccess: true });
    expect(calls.runTurn).toHaveLength(1);
    expect(calls.runTurn[0]?.threadId).toBe('thread-uuid-abc');
    // The turn body is the STEWARD_WAKE envelope (the PTY body), carrying the wake id.
    expect(calls.runTurn[0]?.input).toContain('STEWARD_WAKE');
    expect(calls.runTurn[0]?.input).toContain('wake-m');

    expect(result).toMatchObject({ threadId: 'thread-uuid-abc', resumed: false, threadReset: false });

    // Wake reached `injected` with controlFace machine + sessionId = thread UUID.
    const wake = await createStewardWakeStore(dir).get('wake-m');
    expect(wake?.status).toBe('injected');
    expect(wake?.controlFace).toBe('machine');
    expect(wake?.sessionId).toBe('thread-uuid-abc');

    // Thread store written for cross-restart resume.
    const stored = await createMachineThreadStore(dir).read();
    expect(stored?.threadId).toBe('thread-uuid-abc');
    expect(stored?.lastTurnAt).toBe(NOW);
    expect(stored?.createdAt).toBe(NOW);
  });

  it('resume path: reuses the stored thread id and refreshes lastTurnAt', async () => {
    // Seed a prior thread record with an older lastTurnAt.
    await createMachineThreadStore(dir).write({
      threadId: 'thread-prior',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastTurnAt: '2026-07-07T00:00:00.000Z',
    });
    const { driver, calls } = makeMockDriver({
      ensureThread: async (o) => {
        expect(o.threadId).toBe('thread-prior');
        return { threadId: 'thread-prior', resumed: true };
      },
    });
    const result = await dispatchMachineWake(baseInput(driver));

    expect(calls.ensureThread[0]?.threadId).toBe('thread-prior');
    expect(result).toMatchObject({ threadId: 'thread-prior', resumed: true, threadReset: false });

    const stored = await createMachineThreadStore(dir).read();
    expect(stored?.threadId).toBe('thread-prior');
    expect(stored?.createdAt).toBe('2026-07-01T00:00:00.000Z'); // preserved
    expect(stored?.lastTurnAt).toBe(NOW); // refreshed
    expect((await createStewardWakeStore(dir).get('wake-m'))?.sessionId).toBe('thread-prior');
  });

  it('resume-failure fallback: resets to a fresh thread, overwrites the store, and emits an event', async () => {
    await createMachineThreadStore(dir).write({
      threadId: 'thread-stale',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastTurnAt: '2026-07-07T00:00:00.000Z',
    });
    const { driver, calls } = makeMockDriver({
      ensureThread: async (o) => {
        if (o.threadId === 'thread-stale') throw new Error('thread/resume failed: unknown thread');
        return { threadId: 'thread-new', resumed: false };
      },
    });
    const result = await dispatchMachineWake(baseInput(driver));

    // Two ensureThread calls: the failed resume, then the fresh start. Both
    // still request network access (issue #146 MAJOR-1) — a reset must not
    // silently drop the sandbox override.
    expect(calls.ensureThread).toHaveLength(2);
    expect(calls.ensureThread[0]).toMatchObject({ threadId: 'thread-stale', networkAccess: true });
    expect(calls.ensureThread[1]?.threadId).toBeUndefined();
    expect(calls.ensureThread[1]).toMatchObject({ networkAccess: true });
    expect(result).toMatchObject({ threadId: 'thread-new', threadReset: true, resumed: false });

    // Store overwritten with the fresh id (and a fresh createdAt).
    const stored = await createMachineThreadStore(dir).read();
    expect(stored?.threadId).toBe('thread-new');
    expect(stored?.createdAt).toBe(NOW);

    // Wake proceeds to injected; reset recorded as a structured event.
    expect((await createStewardWakeStore(dir).get('wake-m'))?.status).toBe('injected');
    const events = await readSupervisorEvents();
    const reset = events.find((e) => e['type'] === 'machine_thread_reset');
    expect(reset).toMatchObject({ wakeId: 'wake-m', priorThreadId: 'thread-stale' });
  });

  it('applies the steward core-model override to ensureThread when the file is present (issue #146 MAJOR-2)', async () => {
    const overridePath = join(dir, CODEX_MODEL_OVERRIDE_PATH);
    await mkdir(dirname(overridePath), { recursive: true });
    await writeFile(overridePath, 'gpt-5.5-steward\n', 'utf8');
    const { driver, calls } = makeMockDriver();

    await dispatchMachineWake(baseInput(driver));

    expect(calls.ensureThread[0]).toMatchObject({ model: 'gpt-5.5-steward' });
  });

  it('omits model from ensureThread when no override file exists (issue #146 MAJOR-2)', async () => {
    const { driver, calls } = makeMockDriver();

    await dispatchMachineWake(baseInput(driver));

    expect(calls.ensureThread[0]?.model).toBeUndefined();
  });

  it('runTurn rejection AFTER start: wake stays injected (supervisor owns terminal states) + event emitted', async () => {
    const { driver } = makeMockDriver({
      runTurn: async (threadId, _input, o) => {
        o?.onEvent?.(turnStarted(threadId)); // turn/start accepted → injected
        // ...then the turn fails mid-flight, AFTER injection.
        throw new Error('turn error: model overloaded');
      },
    });
    const result = await dispatchMachineWake(baseInput(driver));
    expect(result.injectedAt).toBeTruthy();

    // The dispatcher marked it injected and did NOT terminalize it.
    const wake = await createStewardWakeStore(dir).get('wake-m');
    expect(wake?.status).toBe('injected');

    // The detached failure is logged as a structured supervisor event.
    await waitFor(async () => (await readSupervisorEvents()).some((e) => e['type'] === 'machine_turn_failed'));
    const failed = (await readSupervisorEvents()).find((e) => e['type'] === 'machine_turn_failed');
    expect(failed).toMatchObject({ wakeId: 'wake-m' });
  });

  it('turn/start rejection BEFORE start: rejects, but the wake record was created (caller owns lock/error)', async () => {
    let wakeCreated = false;
    const { driver } = makeMockDriver({
      runTurn: async () => {
        // Never fires turn-started — turn/start itself was rejected.
        throw new Error('turn/start rejected');
      },
    });
    await expect(
      dispatchMachineWake(baseInput(driver, { onWakeCreated: () => { wakeCreated = true; } })),
    ).rejects.toThrow(/turn\/start rejected/);

    expect(wakeCreated).toBe(true);
    const wake = await createStewardWakeStore(dir).get('wake-m');
    expect(wake).not.toBeNull();
    expect(wake?.status).toBe('queued'); // never reached injected
  });

  it('supervisor sanity: a dispatched machine wake stays injected while live, goes stuck when the thread is gone', async () => {
    const { driver } = makeMockDriver();
    await dispatchMachineWake(baseInput(driver));
    // Mirror the real dispatcher: the account lock is held for the wake's life.
    await createStewardLockStore(dir).acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-m',
      now: NOW,
      expiresAt: FUTURE_DEADLINE,
    });

    // Live thread → no stuck transition.
    const live = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:00.000Z',
      isMachineThreadLive: () => true,
      // A PTY probe would report the session gone — it must never be consulted.
      isSessionRunning: () => false,
    });
    expect(live.transitions).toHaveLength(0);
    expect((await createStewardWakeStore(dir).get('wake-m'))?.status).toBe('injected');

    // Dead thread → stuck.
    const dead = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:02:00.000Z',
      isMachineThreadLive: () => false,
    });
    expect(dead.transitions[0]).toMatchObject({ wakeId: 'wake-m', to: 'stuck', reason: 'session_not_running' });
    expect((await createStewardWakeStore(dir).get('wake-m'))?.status).toBe('stuck');
  });
});

describe('buildMachineDriver (issue #146 MINOR-1)', () => {
  const ws: WorkspaceMeta = { id: 'ws-1', tag: 'ws-1', dir: '/tmp/ws-1', createdAt: NOW, agents: ['codex'] };

  it('invokes the factory when provided, and never constructs a real CodexAppServerDriver', () => {
    const fakeDriver = makeMockDriver().driver;
    const factory = vi.fn(() => fakeDriver);

    const result = buildMachineDriver({
      ws,
      adapter: codexAdapter,
      cwd: ws.dir,
      env: {},
      logger: NOOP_LOGGER,
      factory,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({ ws, adapter: codexAdapter });
    expect(result).toBe(fakeDriver);
    expect(result).not.toBeInstanceOf(CodexAppServerDriver);
  });

  it('constructs a real CodexAppServerDriver when no factory is provided', () => {
    const result = buildMachineDriver({
      ws,
      adapter: codexAdapter,
      cwd: ws.dir,
      env: {},
      logger: NOOP_LOGGER,
    });

    expect(result).toBeInstanceOf(CodexAppServerDriver);
  });
});

describe('resolveStewardControlFace (issue #146 MINOR-1 + MINOR-3)', () => {
  it('never consults getAdapter when controlFace is absent/pty', () => {
    const getAdapter = vi.fn(() => codexAdapter);

    const result = resolveStewardControlFace({
      config: {},
      requestedAgent: undefined,
      workspaceAgents: ['codex'],
      getAdapter,
    });

    expect(result.useMachine).toBe(false);
    expect(result.adapter).toBeUndefined();
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('resolves the adapter and honors machine for a codex-enabled, adapter-registered workspace', () => {
    const getAdapter = vi.fn(() => codexAdapter);

    const result = resolveStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: undefined,
      workspaceAgents: ['codex'],
      getAdapter,
    });

    expect(result).toMatchObject({ useMachine: true, agent: 'codex' });
    expect(result.adapter).toBe(codexAdapter);
    expect(getAdapter).toHaveBeenCalledWith('codex');
  });

  it('declines to PTY (does not throw) when the resolved agent has no registered adapter (issue #146 MINOR-3)', () => {
    const getAdapter = vi.fn(() => undefined);

    const result = resolveStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: undefined,
      workspaceAgents: ['codex'],
      getAdapter,
    });

    expect(result.useMachine).toBe(false);
    expect(result.declineReason).toMatch(/adapter not registered/);
    expect(result.adapter).toBeUndefined();
  });

  it('declines to PTY for a non-codex agent without ever calling getAdapter', () => {
    const getAdapter = vi.fn(() => codexAdapter);

    const result = resolveStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: 'claude',
      workspaceAgents: ['codex', 'claude'],
      getAdapter,
    });

    expect(result.useMachine).toBe(false);
    expect(result.declineReason).toMatch(/codex-only/);
    expect(getAdapter).not.toHaveBeenCalled();
  });
});

/**
 * End-to-end composition of `resolveStewardControlFace` + `buildMachineDriver`
 * — the SAME two functions `service.ts`'s `dispatchStewardWakeMethod` calls,
 * wired together exactly as it wires them (issue #146 MINOR-1 review): "the
 * factory seam must be exercised." This is deliberately narrower than booting
 * `createWorkspaceService()` (process lock, disk registries, self-arming
 * scanners) — see the review's own escape hatch — while still exercising the
 * REAL production functions, not a re-implementation of their decision logic.
 */
describe('machine driver factory wiring end-to-end (issue #146 MINOR-1)', () => {
  const ws: WorkspaceMeta = { id: 'ws-1', tag: 'ws-1', dir: '/tmp/ws-1', createdAt: NOW, agents: ['codex'] };
  const getAdapter = (id: string): typeof codexAdapter | undefined => (id === 'codex' ? codexAdapter : undefined);

  /** Mirrors service.ts's `if (controlFace.useMachine && controlFace.adapter) { ... makeMachineDriver(...) }` guard. */
  function dispatchDriverOrUndefined(
    controlFace: ReturnType<typeof resolveStewardControlFace>,
    factory: (input: { ws: WorkspaceMeta; adapter: typeof codexAdapter }) => StewardMachineDriver,
  ): StewardMachineDriver | undefined {
    if (!controlFace.useMachine || !controlFace.adapter) return undefined;
    return buildMachineDriver({ ws, adapter: controlFace.adapter, cwd: ws.dir, env: {}, logger: NOOP_LOGGER, factory });
  }

  it('factory is NOT invoked when controlFace is absent/pty', () => {
    const factory = vi.fn(() => makeMockDriver().driver);
    const controlFace = resolveStewardControlFace({
      config: {},
      requestedAgent: undefined,
      workspaceAgents: ws.agents,
      getAdapter,
    });

    dispatchDriverOrUndefined(controlFace, factory);

    expect(factory).not.toHaveBeenCalled();
  });

  it('factory IS invoked on an honored machine config', () => {
    const fakeDriver = makeMockDriver().driver;
    const factory = vi.fn(() => fakeDriver);
    const controlFace = resolveStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: undefined,
      workspaceAgents: ws.agents,
      getAdapter,
    });

    const driver = dispatchDriverOrUndefined(controlFace, factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(driver).toBe(fakeDriver);
  });

  it('decline path (non-codex agent) falls back to PTY without constructing a driver', () => {
    const factory = vi.fn(() => makeMockDriver().driver);
    const controlFace = resolveStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: 'claude',
      workspaceAgents: ['codex', 'claude'],
      getAdapter,
    });

    const driver = dispatchDriverOrUndefined(controlFace, factory);

    expect(controlFace.declineReason).toMatch(/codex-only/);
    expect(driver).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });
});
