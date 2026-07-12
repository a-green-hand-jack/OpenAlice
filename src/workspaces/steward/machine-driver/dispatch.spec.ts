import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeAdapter } from '../../adapters/claude.js';
import { CODEX_MODEL_OVERRIDE_PATH, codexAdapter } from '../../adapters/codex.js';
import type { WorkspaceMeta } from '../../workspace-registry.js';
import { ClaudeAgentSdkDriver } from './claude-agent-sdk-driver.js';
import { CodexAppServerDriver } from './codex-app-server-driver.js';
import { NOOP_LOGGER } from './jsonrpc-stdio.js';
import {
  buildMachineDriver,
  decideStewardControlFace,
  dispatchMachineWake,
  dispatchStewardWakeControlFace,
  resolveStewardControlFace,
  type DispatchMachineWakeInput,
  type StewardWakeControlFaceDeps,
  type StewardWakeControlFaceInput,
} from './dispatch.js';
import { createMachineThreadStore } from './thread-store.js';
import type {
  DriverEvent,
  EnsureThreadOptions,
  RunTurnOptions,
  StewardMachineDriver,
  ThreadTelemetry,
  TurnOutcome,
} from './types.js';
import {
  createStewardLockStore,
  createStewardSupervisor,
  createStewardWakeStore,
  publishStewardInformationSnapshot,
  StewardLockConflictError,
  stewardSnapshotPath,
  stewardSupervisorLogPath,
  type StewardWakeEnvelope,
  type StewardWakeEnvelopeInput,
} from '../index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steward-machine-dispatch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const envelopeInput: StewardWakeEnvelopeInput = {
  reason: 'scheduled_observe',
  accountId: 'mock-simulator-1',
  authzLevel: 'paper',
  expectedDecision: 'no_trade',
  marketContext: { symbols: ['AAPL'] },
  riskContext: { riskState: 'NORMAL', guards: [] },
};

function boundEnvelope(wakeId: string): StewardWakeEnvelope {
  return {
    ...envelopeInput,
    version: 2,
    snapshotRef: {
      snapshotId: `snap:${wakeId}`,
      sha256: '0'.repeat(64),
      path: `.alice/steward/snapshots/${encodeURIComponent(wakeId)}.json`,
      asOf: NOW,
    },
  };
}

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
  readonly interruptInFlight?: (threadId: string) => Promise<void>;
  readonly isThreadLive?: (threadId: string) => boolean;
  readonly readTelemetry?: (threadId: string) => ThreadTelemetry | null;
}

interface MockDriver {
  readonly driver: StewardMachineDriver;
  readonly calls: {
    ensureThread: EnsureThreadOptions[];
    runTurn: { threadId: string; input: string; deadlineMs?: number }[];
    interruptInFlight: string[];
  };
}

/** A `StewardMachineDriver` fake with call capture; overridable per test. The
 *  default `runTurn` fires `turn-started` (so the dispatcher marks `injected`)
 *  then resolves `completed`. */
function makeMockDriver(overrides: MockDriverOverrides = {}): MockDriver {
  const calls = {
    ensureThread: [] as EnsureThreadOptions[],
    runTurn: [] as { threadId: string; input: string; deadlineMs?: number }[],
    interruptInFlight: [] as string[],
  };
  const driver: StewardMachineDriver = {
    ensureThread: async (o) => {
      calls.ensureThread.push(o);
      if (overrides.ensureThread) return overrides.ensureThread(o);
      return { threadId: 'thread-fresh', resumed: o.threadId !== undefined };
    },
    runTurn: async (threadId, input, o) => {
      calls.runTurn.push({ threadId, input, ...(o?.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {}) });
      if (overrides.runTurn) return overrides.runTurn(threadId, input, o);
      o?.onEvent?.({ type: 'turn-started', threadId, turnId: 'turn-1' });
      return COMPLETED;
    },
    interruptTurn: async () => {},
    interruptInFlight: async (threadId) => {
      calls.interruptInFlight.push(threadId);
      if (overrides.interruptInFlight) await overrides.interruptInFlight(threadId);
    },
    isThreadLive: (threadId) => (overrides.isThreadLive ? overrides.isThreadLive(threadId) : true),
    isHealthy: () => true,
    readTelemetry: (threadId) => (overrides.readTelemetry ? overrides.readTelemetry(threadId) : null),
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
    wake: { wakeId: 'wake-m', deadline: FUTURE_DEADLINE, envelope: boundEnvelope('wake-m') },
    now: NOW,
    logger: NOOP_LOGGER,
    ...over,
  };
}

describe('decideStewardControlFace (issue #146)', () => {
  it('defaults to machine when controlFace is absent for a codex workspace (issue #146 S6 flip)', () => {
    const d = decideStewardControlFace({ config: {}, requestedAgent: undefined, workspaceAgents: ['codex'] });
    expect(d).toEqual({ useMachine: true, agent: 'codex' });
  });

  it('defaults to machine when controlFace is absent for a claude workspace (issue #146 S6 flip)', () => {
    const d = decideStewardControlFace({
      config: {},
      requestedAgent: 'claude',
      workspaceAgents: ['codex', 'claude'],
    });
    expect(d).toEqual({ useMachine: true, agent: 'claude' });
  });

  it("forces PTY (no reason) when controlFace is explicitly 'pty' — the escape hatch / rollback lever", () => {
    const d = decideStewardControlFace({
      config: { controlFace: 'pty' },
      requestedAgent: undefined,
      workspaceAgents: ['codex'],
    });
    expect(d.useMachine).toBe(false);
    expect(d.declineReason).toBeUndefined();
  });

  it('fails SAFE on an unrecognized controlFace value — typo of the escape hatch must land on PTY, loudly (S6 review MAJOR)', () => {
    for (const junk of ['PTY', 'pty ', 'ptty', true, 0, null, {}]) {
      const d = decideStewardControlFace({
        config: { controlFace: junk },
        requestedAgent: undefined,
        workspaceAgents: ['codex'],
      });
      expect(d.useMachine).toBe(false);
      expect(d.declineReason).toMatch(/unrecognized controlFace/);
    }
  });

  it('OPENALICE_STEWARD_CONTROL_FACE=pty forces PTY fleet-wide, overriding config and the default', () => {
    const prior = process.env['OPENALICE_STEWARD_CONTROL_FACE'];
    process.env['OPENALICE_STEWARD_CONTROL_FACE'] = 'pty';
    try {
      for (const config of [{}, { controlFace: 'machine' }]) {
        const d = decideStewardControlFace({ config, requestedAgent: undefined, workspaceAgents: ['codex'] });
        expect(d.useMachine).toBe(false);
        expect(d.declineReason).toMatch(/OPENALICE_STEWARD_CONTROL_FACE/);
      }
    } finally {
      if (prior === undefined) delete process.env['OPENALICE_STEWARD_CONTROL_FACE'];
      else process.env['OPENALICE_STEWARD_CONTROL_FACE'] = prior;
    }
  });

  it('declines to PTY (with reason) when controlFace is absent but the agent is neither codex nor claude (issue #146 S6)', () => {
    const d = decideStewardControlFace({
      config: {},
      requestedAgent: 'opencode',
      workspaceAgents: ['codex', 'opencode'],
    });
    expect(d.useMachine).toBe(false);
    expect(d.agent).toBe('opencode');
    expect(d.declineReason).toMatch(/supports codex or claude/);
  });

  it('honors machine for a codex-enabled workspace', () => {
    const d = decideStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: undefined,
      workspaceAgents: ['codex', 'shell'],
    });
    expect(d).toEqual({ useMachine: true, agent: 'codex' });
  });

  it('honors machine for a claude-enabled workspace (issue #146 S5)', () => {
    const d = decideStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: 'claude',
      workspaceAgents: ['codex', 'claude'],
    });
    expect(d).toEqual({ useMachine: true, agent: 'claude' });
  });

  it('declines to PTY with a reason when the resolved agent is neither codex nor claude', () => {
    const d = decideStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: 'opencode',
      workspaceAgents: ['codex', 'opencode'],
    });
    expect(d.useMachine).toBe(false);
    expect(d.agent).toBe('opencode');
    expect(d.declineReason).toMatch(/supports codex or claude/);
  });

  it('declines to PTY when the resolved agent is not enabled on the workspace', () => {
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
      accountId: envelopeInput.accountId,
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

describe('dispatchMachineWake deadline + interrupt (issue #146 S4, item 2)', () => {
  it('threads the wake deadline into runTurn as deadlineMs (> 0)', async () => {
    const { driver, calls } = makeMockDriver();
    await dispatchMachineWake(baseInput(driver));
    expect(calls.runTurn[0]?.deadlineMs).toBeGreaterThan(0);
  });

  it('a deadline-interrupted turn emits machine_turn_interrupted (NOT _failed) and the wake stays injected', async () => {
    const { driver } = makeMockDriver({
      runTurn: async (threadId, _input, o) => {
        o?.onEvent?.(turnStarted(threadId)); // turn/start accepted → injected
        return { turnId: 'turn-1', status: 'interrupted', agentMessage: null, durationMs: null, interrupted: true };
      },
    });
    const result = await dispatchMachineWake(baseInput(driver));
    expect(result.injectedAt).toBeTruthy();

    // The dispatcher marked it injected — the supervisor still owns `timeout`.
    expect((await createStewardWakeStore(dir).get('wake-m'))?.status).toBe('injected');

    await waitFor(async () => (await readSupervisorEvents()).some((e) => e['type'] === 'machine_turn_interrupted'));
    const events = await readSupervisorEvents();
    expect(events.some((e) => e['type'] === 'machine_turn_failed')).toBe(false);
    expect(events.find((e) => e['type'] === 'machine_turn_interrupted')).toMatchObject({
      wakeId: 'wake-m',
      status: 'interrupted',
    });
  });
});

describe('dispatchMachineWake bounded turn/started wait (issue #146 S4, item 3)', () => {
  it('fails the dispatch when turn/started is never observed, leaving the wake queued + emitting an event', async () => {
    let wakeCreated = false;
    const { driver, calls } = makeMockDriver({
      // turn/start is accepted (never rejects) but turn/started never fires and
      // the turn never settles — the bounded wait must break the deadlock.
      runTurn: () => new Promise<TurnOutcome>(() => undefined),
    });
    await expect(
      dispatchMachineWake(baseInput(driver, { startedTimeoutMs: 20, onWakeCreated: () => { wakeCreated = true; } })),
    ).rejects.toThrow(/not observed within/);

    expect(wakeCreated).toBe(true);
    // Same path as a pre-start rejection: created but never injected.
    expect((await createStewardWakeStore(dir).get('wake-m'))?.status).toBe('queued');
    const timeout = (await readSupervisorEvents()).find((e) => e['type'] === 'machine_turn_dispatch_timeout');
    expect(timeout).toMatchObject({ wakeId: 'wake-m', timeoutMs: 20 });
    // Item 3 (issue #146 S5): the orphan turn is actively aborted, not left running.
    expect(calls.interruptInFlight).toEqual(['thread-fresh']);
  });

  it('aborts the orphan turn on gate timeout so it settles interrupted with no unhandled rejection (issue #146 S5, item 3)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let settleTurn!: (o: TurnOutcome) => void;
      const turnPromise = new Promise<TurnOutcome>((resolve) => {
        settleTurn = resolve;
      });
      const { driver, calls } = makeMockDriver({
        // turn/start accepted, turn-started never fires; the turn only settles
        // once interruptInFlight aborts it — exactly the orphan-turn shape.
        runTurn: () => turnPromise,
        interruptInFlight: async () => {
          settleTurn({ turnId: 'turn-1', status: 'interrupted', agentMessage: null, durationMs: null, interrupted: true });
        },
      });

      await expect(dispatchMachineWake(baseInput(driver, { startedTimeoutMs: 20 }))).rejects.toThrow(
        /not observed within/,
      );

      expect(calls.interruptInFlight).toEqual(['thread-fresh']);
      // The interrupted outcome is consumed by the detached turn handler → a
      // distinct `machine_turn_interrupted` event, and NO unhandled rejection.
      await waitFor(async () =>
        (await readSupervisorEvents()).some((e) => e['type'] === 'machine_turn_interrupted'),
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('machine-thread rotation on context overflow (issue #146 S4, item 5)', () => {
  const CONTEXT_WINDOW = 100_000;
  const overThreshold: ThreadTelemetry = {
    totalTokens: 80_000, inputTokens: 80_000, cachedInputTokens: 0, outputTokens: 0,
    contextWindow: CONTEXT_WINDOW, updatedAt: NOW,
  };
  const underThreshold: ThreadTelemetry = {
    totalTokens: 1_000, inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 0,
    contextWindow: CONTEXT_WINDOW, updatedAt: NOW,
  };
  const echoResume = async (o: EnsureThreadOptions): Promise<{ threadId: string; resumed: boolean }> => ({
    threadId: o.threadId ?? 'thread-fresh',
    resumed: o.threadId !== undefined,
  });

  async function seedThread(threadId = 'thread-old'): Promise<void> {
    await createMachineThreadStore(dir).write({
      threadId, createdAt: '2026-07-01T00:00:00.000Z', lastTurnAt: '2026-07-07T00:00:00.000Z',
    });
  }

  it('over threshold: disposes the poisoned driver, starts a fresh thread, records session_rotated', async () => {
    await seedThread('thread-old');
    const poisoned = makeMockDriver({ readTelemetry: () => overThreshold });
    const fresh = makeMockDriver({
      ensureThread: async (o) => {
        expect(o.threadId).toBeUndefined(); // rotation forces a FRESH thread
        return { threadId: 'thread-rotated', resumed: false };
      },
    });
    const rotateThread = vi.fn(async () => fresh.driver);

    const result = await dispatchMachineWake(baseInput(poisoned.driver, { rotateThread, config: {} }));

    expect(rotateThread).toHaveBeenCalledTimes(1);
    expect(result.threadId).toBe('thread-rotated');
    // The turn ran on the FRESH driver, never the poisoned one.
    expect(fresh.calls.runTurn).toHaveLength(1);
    expect(poisoned.calls.runTurn).toHaveLength(0);
    expect((await createStewardWakeStore(dir).get('wake-m'))?.sessionId).toBe('thread-rotated');
    expect((await createMachineThreadStore(dir).read())?.threadId).toBe('thread-rotated');
    const rotated = (await readSupervisorEvents()).find((e) => e['type'] === 'session_rotated');
    expect(rotated).toMatchObject({ disposedSessionId: 'thread-old', newSessionId: 'thread-rotated' });
  });

  it('under threshold: resumes the stored thread, never rotates', async () => {
    await seedThread('thread-old');
    const { driver } = makeMockDriver({ readTelemetry: () => underThreshold, ensureThread: echoResume });
    const rotateThread = vi.fn(async () => makeMockDriver().driver);

    const result = await dispatchMachineWake(baseInput(driver, { rotateThread, config: {} }));

    expect(rotateThread).not.toHaveBeenCalled();
    expect(result).toMatchObject({ threadId: 'thread-old', resumed: true });
    expect((await readSupervisorEvents()).some((e) => e['type'] === 'session_rotated')).toBe(false);
  });

  it('no telemetry: resumes the stored thread (never blocks a wake on a missing snapshot)', async () => {
    await seedThread('thread-old');
    const { driver } = makeMockDriver({ readTelemetry: () => null, ensureThread: echoResume });
    const rotateThread = vi.fn(async () => makeMockDriver().driver);

    const result = await dispatchMachineWake(baseInput(driver, { rotateThread, config: {} }));

    expect(rotateThread).not.toHaveBeenCalled();
    expect(result.threadId).toBe('thread-old');
  });
});

describe('machine-thread provider match (issue #146 S5)', () => {
  async function seedCodexThread(): Promise<void> {
    await createMachineThreadStore(dir).write({
      provider: 'codex',
      threadId: 'codex-old',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastTurnAt: '2026-07-07T00:00:00.000Z',
    });
  }

  it('a fresh claude dispatch records provider:claude in the thread store', async () => {
    const { driver } = makeMockDriver({
      ensureThread: async () => ({ threadId: 'claude-thread-1', resumed: false }),
    });
    await dispatchMachineWake(baseInput(driver, { provider: 'claude' }));

    const stored = await createMachineThreadStore(dir).read();
    expect(stored?.provider).toBe('claude');
    expect(stored?.threadId).toBe('claude-thread-1');
  });

  it('a stored codex thread is NOT resumed by a claude wake — fresh thread + mismatch event', async () => {
    await seedCodexThread();
    const { driver, calls } = makeMockDriver({
      ensureThread: async (o) => {
        expect(o.threadId).toBeUndefined(); // mismatch forces a FRESH thread, not resume
        return { threadId: 'claude-new', resumed: false };
      },
    });
    const result = await dispatchMachineWake(baseInput(driver, { provider: 'claude' }));

    expect(result).toMatchObject({ threadId: 'claude-new', resumed: false });
    expect(calls.ensureThread[0]?.threadId).toBeUndefined();
    const stored = await createMachineThreadStore(dir).read();
    expect(stored?.provider).toBe('claude');
    expect(stored?.threadId).toBe('claude-new');
    const mismatch = (await readSupervisorEvents()).find((e) => e['type'] === 'machine_thread_provider_mismatch');
    expect(mismatch).toMatchObject({ storedProvider: 'codex', provider: 'claude', priorThreadId: 'codex-old' });
  });

  it('a matching codex stored thread still resumes (no mismatch event)', async () => {
    await seedCodexThread();
    const { driver } = makeMockDriver({
      ensureThread: async (o) => ({ threadId: o.threadId ?? 'fresh', resumed: o.threadId !== undefined }),
    });
    const result = await dispatchMachineWake(baseInput(driver, { provider: 'codex' }));

    expect(result).toMatchObject({ threadId: 'codex-old', resumed: true });
    expect((await readSupervisorEvents()).some((e) => e['type'] === 'machine_thread_provider_mismatch')).toBe(false);
  });
});

describe('machine-thread account identity guard (issue #155)', () => {
  async function seedThread(accountId?: string): Promise<void> {
    await createMachineThreadStore(dir).write({
      provider: 'codex',
      threadId: 'thread-owned',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastTurnAt: '2026-07-07T00:00:00.000Z',
      ...(accountId !== undefined ? { accountId } : {}),
    });
  }

  it('a fresh dispatch records the wake envelope accountId in the thread store', async () => {
    const { driver } = makeMockDriver();
    await dispatchMachineWake(baseInput(driver));

    const stored = await createMachineThreadStore(dir).read();
    expect(stored?.accountId).toBe(envelopeInput.accountId);
  });

  it('a stored thread owned by the SAME account resumes normally — no mismatch event', async () => {
    await seedThread(envelopeInput.accountId);
    const { driver, calls } = makeMockDriver({
      ensureThread: async (o) => ({ threadId: o.threadId ?? 'fresh', resumed: o.threadId !== undefined }),
    });
    const result = await dispatchMachineWake(baseInput(driver));

    expect(result).toMatchObject({ threadId: 'thread-owned', resumed: true, threadReset: false });
    expect(calls.ensureThread[0]?.threadId).toBe('thread-owned');
    expect((await readSupervisorEvents()).some((e) => e['type'] === 'machine_thread_account_mismatch')).toBe(false);
    const stored = await createMachineThreadStore(dir).read();
    expect(stored?.accountId).toBe(envelopeInput.accountId);
  });

  it('a stored thread owned by a DIFFERENT account is NOT resumed — fresh thread + mismatch event, store adopts the current account', async () => {
    await seedThread('some-other-account');
    const { driver, calls } = makeMockDriver({
      ensureThread: async (o) => {
        expect(o.threadId).toBeUndefined(); // mismatch forces a FRESH thread, not resume
        return { threadId: 'thread-fresh-for-new-account', resumed: false };
      },
    });
    const result = await dispatchMachineWake(baseInput(driver));

    expect(result).toMatchObject({ threadId: 'thread-fresh-for-new-account', resumed: false });
    expect(calls.ensureThread[0]?.threadId).toBeUndefined();

    const stored = await createMachineThreadStore(dir).read();
    expect(stored?.threadId).toBe('thread-fresh-for-new-account');
    expect(stored?.accountId).toBe(envelopeInput.accountId);

    const mismatch = (await readSupervisorEvents()).find((e) => e['type'] === 'machine_thread_account_mismatch');
    expect(mismatch).toMatchObject({
      wakeId: 'wake-m',
      priorThreadId: 'thread-owned',
      storedAccountId: 'some-other-account',
      accountId: envelopeInput.accountId,
    });
  });

  it('a LEGACY stored thread (no accountId at all) resumes normally and is adopted on write — no mismatch, no reset', async () => {
    await seedThread(undefined);
    const { driver, calls } = makeMockDriver({
      ensureThread: async (o) => ({ threadId: o.threadId ?? 'fresh', resumed: o.threadId !== undefined }),
    });
    const result = await dispatchMachineWake(baseInput(driver));

    // Resumed, NOT reset — a legacy record is adoptable, not a mismatch.
    expect(result).toMatchObject({ threadId: 'thread-owned', resumed: true, threadReset: false });
    expect(calls.ensureThread[0]?.threadId).toBe('thread-owned');
    expect((await readSupervisorEvents()).some((e) => e['type'] === 'machine_thread_account_mismatch')).toBe(false);

    // Adopted on this write — the next wake for the same account now matches.
    const stored = await createMachineThreadStore(dir).read();
    expect(stored?.accountId).toBe(envelopeInput.accountId);
    expect(stored?.threadId).toBe('thread-owned');
  });
});

describe('dispatchStewardWakeControlFace — shared gate + factory seam (issue #146 S4, item 1)', () => {
  function baseDeps(
    acquireDriver: (adapter: unknown) => StewardMachineDriver,
    over: Partial<StewardWakeControlFaceDeps> = {},
  ): StewardWakeControlFaceDeps {
    return {
      wsId: 'ws-1',
      workspaceDir: dir,
      cwd: dir,
      workspaceAgents: ['codex'],
      getAdapter: (id) => (id === 'codex' ? codexAdapter : undefined),
      wakeStore: createStewardWakeStore(dir),
      lockStore: createStewardLockStore(dir),
      threadStore: createMachineThreadStore(dir),
      logger: NOOP_LOGGER,
      publishSnapshot: (snapshotInput) => publishStewardInformationSnapshot(dir, snapshotInput),
      acquireDriver,
      rotateDriver: async (adapter) => acquireDriver(adapter),
      withRuntimeLease: (operation) => operation({ forceFresh: false }),
      ...over,
    };
  }
  const input = (config: Record<string, unknown>): StewardWakeControlFaceInput => ({
    config, requestedAgent: undefined, wakeId: 'wake-cf', deadline: FUTURE_DEADLINE, now: NOW, envelope: envelopeInput,
  });

  it("explicit 'pty' config: returns face:pty, never invokes the driver factory, no wake/lock side effects", async () => {
    const factory = vi.fn(() => makeMockDriver().driver);
    const outcome = await dispatchStewardWakeControlFace(input({ controlFace: 'pty' }), baseDeps(factory));

    expect(outcome).toEqual({ face: 'pty' });
    expect(factory).not.toHaveBeenCalled();
    expect(await createStewardWakeStore(dir).get('wake-cf')).toBeNull();
  });

  it('absent config (issue #146 S6 default): invokes the factory once and dispatches machine', async () => {
    const factory = vi.fn(() => makeMockDriver().driver);
    const outcome = await dispatchStewardWakeControlFace(input({}), baseDeps(factory));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(outcome.face).toBe('machine');
  });

  it('machine config: invokes the factory once, dispatches, returns the injected wake', async () => {
    const factory = vi.fn(() => makeMockDriver().driver);
    const outcome = await dispatchStewardWakeControlFace(input({ controlFace: 'machine' }), baseDeps(factory));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(outcome.face).toBe('machine');
    if (outcome.face === 'machine') {
      expect(outcome.wake.status).toBe('injected');
      expect(outcome.wake.controlFace).toBe('machine');
      expect(outcome.threadId).toBe('thread-fresh');
      expect(outcome.wake.envelope).toHaveProperty('snapshotRef.snapshotId', 'snap:wake-cf');
      expect(JSON.parse(await readFile(stewardSnapshotPath(dir, 'wake-cf'), 'utf8')).wakeId).toBe('wake-cf');
    }
  });

  it('uses post-lock generation B when acknowledged A goes stale before shared machine dispatch', async () => {
    await createMachineThreadStore(dir).write({
      threadId: 'thread-stale-v2-instructions',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastTurnAt: '2026-07-07T00:00:00.000Z',
      accountId: envelopeInput.accountId,
    });
    const { driver, calls } = makeMockDriver({
      ensureThread: async (options) => {
        expect(options.threadId).toBeUndefined();
        return { threadId: 'thread-fresh-v3-instructions', resumed: false };
      },
    });
    const acquireDriver = vi.fn(() => driver);
    const rotateDriver = vi.fn(async () => driver);
    const outcome = await dispatchStewardWakeControlFace(
      input({ controlFace: 'machine' }),
      baseDeps(acquireDriver, {
        rotateDriver,
        withRuntimeLease: async (operation) => {
          expect(await createStewardLockStore(dir).get(envelopeInput.accountId)).toMatchObject({
            wakeId: 'wake-cf',
          });
          // A observed an acknowledged generation A pre-lock. The lease's
          // authoritative refresh observes B and must clear the A thread.
          return operation({ forceFresh: true });
        },
      }),
    );

    expect(outcome.face).toBe('machine');
    expect(acquireDriver).not.toHaveBeenCalled();
    expect(rotateDriver).toHaveBeenCalledWith(
      codexAdapter,
      { disposedThreadId: 'thread-stale-v2-instructions' },
    );
    expect(calls.ensureThread[0]?.threadId).toBeUndefined();
    expect((await createMachineThreadStore(dir).read())?.threadId).toBe('thread-fresh-v3-instructions');
  });

  it('retains the live machine wake and account lock when injected-status persistence fails after turn-start', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const updateStatus = wakeStore.updateStatus.bind(wakeStore);
    vi.spyOn(wakeStore, 'updateStatus').mockImplementation(async (wakeId, status, patch) => {
      if (status === 'injected') throw new Error('machine injected-status write failed');
      return updateStatus(wakeId, status, patch);
    });
    const factory = vi.fn(() => makeMockDriver().driver);
    const deps = baseDeps(factory, { wakeStore });

    const outcome = await dispatchStewardWakeControlFace(
      input({ controlFace: 'machine' }),
      deps,
    );

    expect(outcome.face).toBe('machine');
    if (outcome.face !== 'machine') throw new Error('machine face unexpectedly declined');
    expect(outcome.wake).toMatchObject({
      wakeId: 'wake-cf',
      status: 'queued',
      injectedAt: null,
    });
    expect(outcome.wake.completedAt).toBeUndefined();
    expect(outcome.wake.error).toBeUndefined();
    expect(await createStewardLockStore(dir).get(envelopeInput.accountId)).toMatchObject({
      wakeId: 'wake-cf',
    });

    await expect(dispatchStewardWakeControlFace(
      { ...input({ controlFace: 'machine' }), wakeId: 'wake-cf-committed-retry' },
      deps,
    )).rejects.toBeInstanceOf(StewardLockConflictError);
    expect(await createStewardLockStore(dir).get(envelopeInput.accountId)).toMatchObject({
      wakeId: 'wake-cf',
    });
  });

  it('snapshot failure releases the lock before any driver, thread, or wake side effect', async () => {
    const factory = vi.fn(() => makeMockDriver().driver);
    const publishSnapshot = vi.fn(async () => { throw new Error('snapshot disk failed'); });

    await expect(dispatchStewardWakeControlFace(
      input({ controlFace: 'machine' }),
      baseDeps(factory, { publishSnapshot }),
    )).rejects.toThrow(/snapshot disk failed/);

    expect(factory).not.toHaveBeenCalled();
    expect(await createStewardWakeStore(dir).get('wake-cf')).toBeNull();
    expect(await createMachineThreadStore(dir).read()).toBeNull();
    await expect(createStewardLockStore(dir).acquire({
      accountId: envelopeInput.accountId,
      wakeId: 'wake-after-snapshot-failure',
      now: NOW,
      expiresAt: FUTURE_DEADLINE,
    })).resolves.toBeTruthy();
  });

  it('keeps an immutable Snapshot when machine setup fails before wake creation, then retries the same wakeId', async () => {
    const workingDriver = makeMockDriver().driver;
    let failBeforeWake = true;
    const factory = vi.fn(() => {
      if (failBeforeWake) {
        failBeforeWake = false;
        throw new Error('driver construction failed before wake creation');
      }
      return workingDriver;
    });
    const machineInput = input({ controlFace: 'machine' });

    await expect(dispatchStewardWakeControlFace(machineInput, baseDeps(factory)))
      .rejects.toThrow(/driver construction failed/);
    expect(await createStewardWakeStore(dir).get(machineInput.wakeId)).toBeNull();
    expect(await createMachineThreadStore(dir).read()).toBeNull();
    expect(await createStewardLockStore(dir).get(envelopeInput.accountId)).toBeNull();
    const snapshotBytes = await readFile(stewardSnapshotPath(dir, machineInput.wakeId), 'utf8');

    const retried = await dispatchStewardWakeControlFace(machineInput, baseDeps(factory));
    expect(retried.face).toBe('machine');
    expect(await createStewardWakeStore(dir).get(machineInput.wakeId)).toMatchObject({ status: 'injected' });
    expect(await readFile(stewardSnapshotPath(dir, machineInput.wakeId), 'utf8')).toBe(snapshotBytes);
  });

  it('machine dispatch failure before injection releases the account lock and rethrows', async () => {
    const factory = vi.fn(() => makeMockDriver({
      runTurn: async () => { throw new Error('turn/start rejected'); },
    }).driver);

    await expect(
      dispatchStewardWakeControlFace(input({ controlFace: 'machine' }), baseDeps(factory)),
    ).rejects.toThrow(/turn\/start rejected/);

    // Lock released → the same account can be re-acquired for a new wake.
    await expect(
      createStewardLockStore(dir).acquire({
        accountId: envelopeInput.accountId, wakeId: 'wake-next', now: NOW, expiresAt: FUTURE_DEADLINE,
      }),
    ).resolves.toBeTruthy();
  });

  it('two fresh wakes fired near-simultaneously for the same account (issue #154): exactly one dispatches, the loser lands in the EXISTING StewardLockConflictError decline path with no wake record ever created for it', async () => {
    const factory = vi.fn(() => makeMockDriver().driver);
    const deps = baseDeps(factory);
    const makeCfInput = (wakeId: string): StewardWakeControlFaceInput => ({
      config: { controlFace: 'machine' },
      requestedAgent: undefined,
      wakeId,
      deadline: FUTURE_DEADLINE,
      now: NOW,
      envelope: envelopeInput,
    });

    // Mirrors the reported interleaving: a cron fire and a manual HTTP fire
    // for the SAME account, different wakeIds, landing at effectively the
    // same instant.
    const results = await Promise.allSettled([
      dispatchStewardWakeControlFace(makeCfInput('wake-cron'), deps),
      dispatchStewardWakeControlFace(makeCfInput('wake-http'), deps),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Winner: dispatched machine-face, wake record landed `injected` — the
    // ordinary single-wake outcome, unaffected by the race.
    const winner = fulfilled[0]!.status === 'fulfilled' ? fulfilled[0]!.value : undefined;
    expect(winner?.face).toBe('machine');
    const winnerWakeId = winner && winner.face === 'machine' ? winner.wake.wakeId : undefined;
    expect(winner && winner.face === 'machine' ? winner.wake.status : undefined).toBe('injected');

    // Loser: the EXISTING decline path (StewardLockConflictError, thrown
    // before any wake-record creation — see the machine preflight in
    // `dispatchStewardWakeControlFace`) — not a new terminal state.
    const rejection = rejected[0]!.status === 'rejected' ? rejected[0]!.reason : undefined;
    expect(rejection).toBeInstanceOf(StewardLockConflictError);
    expect((rejection as StewardLockConflictError).lock.wakeId).toBe(winnerWakeId);

    const loserWakeId = winnerWakeId === 'wake-cron' ? 'wake-http' : 'wake-cron';
    expect(await createStewardWakeStore(dir).get(loserWakeId)).toBeNull();
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

  it('constructs a ClaudeAgentSdkDriver for the claude adapter (issue #146 S5)', () => {
    const result = buildMachineDriver({
      ws: { ...ws, agents: ['claude'] },
      adapter: claudeAdapter,
      cwd: ws.dir,
      env: {},
      logger: NOOP_LOGGER,
    });

    expect(result).toBeInstanceOf(ClaudeAgentSdkDriver);
    expect(result).not.toBeInstanceOf(CodexAppServerDriver);
  });
});

describe('resolveStewardControlFace (issue #146 MINOR-1 + MINOR-3)', () => {
  it("never consults getAdapter when controlFace is explicitly 'pty' (escape hatch short-circuits before adapter resolution)", () => {
    const getAdapter = vi.fn(() => codexAdapter);

    const result = resolveStewardControlFace({
      config: { controlFace: 'pty' },
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

  it('resolves the claude adapter and honors machine for a claude-enabled workspace (issue #146 S5)', () => {
    const getAdapter = vi.fn((id: string) => (id === 'claude' ? claudeAdapter : undefined));

    const result = resolveStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: 'claude',
      workspaceAgents: ['codex', 'claude'],
      getAdapter,
    });

    expect(result).toMatchObject({ useMachine: true, agent: 'claude' });
    expect(result.adapter).toBe(claudeAdapter);
    expect(getAdapter).toHaveBeenCalledWith('claude');
  });

  it('declines to PTY for an unsupported agent without ever calling getAdapter', () => {
    const getAdapter = vi.fn(() => codexAdapter);

    const result = resolveStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: 'opencode',
      workspaceAgents: ['codex', 'opencode'],
      getAdapter,
    });

    expect(result.useMachine).toBe(false);
    expect(result.declineReason).toMatch(/supports codex or claude/);
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

  it("factory is NOT invoked when controlFace is explicitly 'pty' (escape hatch)", () => {
    const factory = vi.fn(() => makeMockDriver().driver);
    const controlFace = resolveStewardControlFace({
      config: { controlFace: 'pty' },
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

  it('decline path (unsupported agent) falls back to PTY without constructing a driver', () => {
    const factory = vi.fn(() => makeMockDriver().driver);
    const controlFace = resolveStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: 'opencode',
      workspaceAgents: ['codex', 'opencode'],
      getAdapter,
    });

    const driver = dispatchDriverOrUndefined(controlFace, factory);

    expect(controlFace.declineReason).toMatch(/supports codex or claude/);
    expect(driver).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('claude requested but no claude adapter registered declines to PTY (adapter not registered)', () => {
    const factory = vi.fn(() => makeMockDriver().driver);
    const controlFace = resolveStewardControlFace({
      config: { controlFace: 'machine' },
      requestedAgent: 'claude',
      workspaceAgents: ['codex', 'claude'],
      getAdapter, // only knows codex → undefined for claude
    });

    const driver = dispatchDriverOrUndefined(controlFace, factory);

    expect(controlFace.declineReason).toMatch(/adapter not registered/);
    expect(driver).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });
});
