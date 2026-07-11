/**
 * Machine control-face wake dispatch (issue #146, S3). The codex-only path that
 * replaces PTY spawn+inject for a steward workspace configured with
 * `controlFace:'machine'`: it resolves/resumes a native codex thread through a
 * `StewardMachineDriver`, creates the wake record keyed off that thread UUID,
 * and fires the wake as ONE detached turn. Completion detection is unchanged —
 * the supervisor terminalizes from the ledger + finalize markers exactly as for
 * a PTY wake; this module never terminalizes a wake itself.
 *
 * Kept out of `service.ts` so it is unit-testable with a mock driver + tmpdir
 * stores in the steward spec style (CI has no codex login).
 */

import { readCodexModelOverride } from '../../adapters/codex.js';
import type { CliAdapter, ContextTelemetry } from '../../cli-adapter.js';
import type { Logger } from '../../logger.js';
import type { WorkspaceMeta } from '../../workspace-registry.js';
import { formatStewardWakeMessage } from '../injector.js';
import { StewardLockConflictError, type StewardLockStore } from '../lock-store.js';
import {
  decideStewardRotation,
  recordStewardRotation,
  resolveRotationThreshold,
  type StewardRotationReason,
} from '../rotation.js';
import { appendSupervisorEvent } from '../supervisor.js';
import type { StewardWakeEnvelope, StewardWakeRecord } from '../types.js';
import type { StewardWakeStore } from '../wake-store.js';
import { ClaudeAgentSdkDriver } from './claude-agent-sdk-driver.js';
import { CodexAppServerDriver } from './codex-app-server-driver.js';
import type { MachineThreadStore } from './thread-store.js';
import type {
  DriverEvent,
  EnsureThreadOptions,
  MachineThreadProvider,
  MachineThreadState,
  StewardMachineDriver,
  ThreadTelemetry,
} from './types.js';

/** The steward agents that support the machine control face (issue #146 S5 adds
 *  `claude` alongside `codex`). */
export const MACHINE_FACE_AGENTS: readonly string[] = ['codex', 'claude'];

/** Map a resolved agent id to the persisted machine-thread provider. */
function agentProvider(agent: string): MachineThreadProvider {
  return agent === 'claude' ? 'claude' : 'codex';
}

/**
 * Bounded wait for the `turn/started` signal (issue #146 S4, item 3). A server
 * that accepts `turn/start` but never emits `turn/started` — nor completes nor
 * errors the turn — would otherwise block `startDetachedTurn` forever. On expiry
 * the dispatch is failed on the SAME path as a pre-start turn/start rejection
 * (the wake is marked error + the account lock is released by the caller).
 */
export const DEFAULT_TURN_STARTED_TIMEOUT_MS = 30_000;

export interface StewardControlFaceDecision {
  /** Take the machine (codex app-server) path when true; the PTY path otherwise. */
  readonly useMachine: boolean;
  /** The agent the wake resolved to (for logging / adapter lookup). */
  readonly agent: string;
  /**
   * Set ONLY when the machine face was requested but declined — the caller logs
   * this and falls back to PTY. Absent when machine wasn't requested (plain PTY)
   * or was honored.
   */
  readonly declineReason?: string;
}

/**
 * Decide the control face for a steward wake. Machine is the DEFAULT for an
 * unattended wake as of issue #146 S6: an ABSENT `controlFace` now attempts the
 * machine face (subject to the agent-support + workspace-enabled gates below), so
 * a `codex`/`claude` steward wakes through the native machine protocol with no
 * config at all. The two escape hatches:
 *   - An EXPLICIT `controlFace: 'pty'` FORCES the historical PTY inject face — a
 *     first-class escape hatch and the rollback lever if the machine face
 *     misbehaves in the field. It never attempts machine and carries no decline
 *     reason (it is a deliberate choice, not a fallback).
 *   - Any agent that isn't `codex` or `claude` (issue #146 S5), or a workspace
 *     that doesn't enable the resolved agent, declines to PTY WITH a reason (S3
 *     never fails a wake over this) — the existing decline logic that keeps every
 *     other agent on PTY automatically, absent config included.
 * `controlFace: 'machine'` is unchanged (explicit opt-in). Pre-S6 behavior was
 * absent → PTY; the flip is the single interpretation change of an ABSENT key —
 * it lives in ONE place (this function), no persisted data is transformed.
 */
export function decideStewardControlFace(input: {
  readonly config: Record<string, unknown>;
  readonly requestedAgent: string | undefined;
  readonly workspaceAgents: readonly string[];
}): StewardControlFaceDecision {
  const configuredAgent =
    typeof input.config['agent'] === 'string' ? (input.config['agent'] as string) : undefined;
  const agent = input.requestedAgent ?? configuredAgent ?? 'codex';
  if (input.config['controlFace'] === 'pty') return { useMachine: false, agent };
  if (!MACHINE_FACE_AGENTS.includes(agent)) {
    return {
      useMachine: false,
      agent,
      declineReason: `control face 'machine' supports codex or claude (agent: ${agent})`,
    };
  }
  if (!input.workspaceAgents.includes(agent)) {
    return {
      useMachine: false,
      agent,
      declineReason: `control face 'machine' requires the workspace to enable ${agent}`,
    };
  }
  return { useMachine: true, agent };
}

export interface ResolvedStewardControlFace extends StewardControlFaceDecision {
  /** Set only when `useMachine` is true — the resolved, confirmed-registered
   *  adapter instance. */
  readonly adapter?: CliAdapter;
}

/**
 * `decideStewardControlFace` plus adapter resolution (issue #146 MINOR-3
 * review): an honored machine decision whose agent has no registered adapter
 * declines to PTY with a reason, exactly like the non-codex / codex-not-enabled
 * cases `decideStewardControlFace` already handles — S3's principle is that
 * control-face reasons never fail the wake, so this must decline, not throw. In
 * practice `codex` is always registered (service.ts registers every built-in
 * adapter at startup); this only guards a future adapter-registry customization
 * that drops it. Deliberately does NOT touch the machine-driver registry or
 * construct a driver — that stays a side effect the caller triggers only once
 * it has actually committed to dispatching (after the wake-exists check + lock
 * acquisition), so a duplicate-wakeId early-throw never spins up a live driver.
 */
export function resolveStewardControlFace(input: {
  readonly config: Record<string, unknown>;
  readonly requestedAgent: string | undefined;
  readonly workspaceAgents: readonly string[];
  readonly getAdapter: (agentId: string) => CliAdapter | undefined;
}): ResolvedStewardControlFace {
  const decision = decideStewardControlFace({
    config: input.config,
    requestedAgent: input.requestedAgent,
    workspaceAgents: input.workspaceAgents,
  });
  if (!decision.useMachine) return decision;
  const adapter = input.getAdapter(decision.agent);
  if (!adapter) {
    return {
      useMachine: false,
      agent: decision.agent,
      declineReason: `machine control face: adapter not registered: ${decision.agent}`,
    };
  }
  return { useMachine: true, agent: decision.agent, adapter };
}

/**
 * Build (or reuse via `factory`) the driver for a machine-face workspace (issue
 * #146 MINOR-1 review). Extracted out of `service.ts`'s closure so the "factory
 * seam vs. real driver" decision is directly unit-testable without booting the
 * full `WorkspaceService` (process lock, disk registries, self-arming
 * scanners) — `factory` mirrors `CreateWorkspaceServiceOptions
 * .machineDriverFactory` exactly, so `service.ts` passes it straight through.
 */
export function buildMachineDriver(input: {
  readonly ws: WorkspaceMeta;
  readonly adapter: CliAdapter;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly logger: Logger;
  readonly factory?: (input: { ws: WorkspaceMeta; adapter: CliAdapter }) => StewardMachineDriver;
}): StewardMachineDriver {
  if (input.factory) return input.factory({ ws: input.ws, adapter: input.adapter });
  const logger = input.logger.child({ scope: 'machine-driver', wsId: input.ws.id, agent: input.adapter.id });
  // Per-agent driver (issue #146 S5): claude workspaces drive the SDK `query()`
  // face; everything else the codex app-server face. The SDK spawns its bundled
  // Claude Code CLI with the SAME `{cwd, env}` a PTY spawn uses, so credential /
  // toolbox parity holds without threading the adapter binary (which is a name,
  // not a path the SDK's `pathToClaudeCodeExecutable` could use).
  if (input.adapter.id === 'claude') {
    return new ClaudeAgentSdkDriver({ cwd: input.cwd, env: input.env, logger });
  }
  return new CodexAppServerDriver({
    cwd: input.cwd,
    env: input.env,
    ...(input.adapter.binary ? { codexBin: input.adapter.binary } : {}),
    logger,
  });
}

export interface DispatchMachineWakeInput {
  readonly workspaceDir: string;
  readonly wsId: string;
  /** cwd the codex thread runs in — normally the workspace dir. */
  readonly cwd: string;
  readonly driver: StewardMachineDriver;
  /**
   * The native provider this wake runs on (issue #146 S5). Governs (a) which
   * stored thread is resumable — a stored thread from the OTHER provider is
   * treated as absent + evented, never resumed — and (b) whether the codex
   * core-model override file applies (codex only). Defaults to `codex` so pre-S5
   * callers and tests are byte-identical.
   */
  readonly provider?: MachineThreadProvider;
  readonly wakeStore: StewardWakeStore;
  readonly threadStore: MachineThreadStore;
  readonly wake: {
    readonly wakeId: string;
    readonly deadline: string;
    readonly envelope: StewardWakeEnvelope;
  };
  /** ISO clock for wake/thread timestamps (the dispatch instant). */
  readonly now: string;
  readonly logger: Logger;
  /**
   * Fired once the wake RECORD exists on disk (controlFace:'machine',
   * sessionId=threadId). Lets the caller mirror its PTY error/lock bookkeeping —
   * a later throw marks the wake `error` + releases the lock.
   */
  readonly onWakeCreated?: () => void;
  /**
   * The workspace's `.alice/steward/config.json` (issue #146 S4, item 5). Only
   * `sessionRotation.threshold` is read here, via the SAME `resolveRotationThreshold`
   * policy the PTY path uses. Absent ⇒ the default threshold.
   */
  readonly config?: Record<string, unknown>;
  /**
   * Machine-thread rotation seam (issue #146 S4, item 5). Called BEFORE thread
   * resolution when the stored thread's driver telemetry is over the steward
   * rotation threshold: it must dispose the poisoned driver and return a FRESH
   * one (the registry side effect lives in the service closure). Absent ⇒ no
   * rotation (the cron/route callers always pass it; unit tests opt in). A wake
   * is never blocked on rotation — missing telemetry resumes.
   */
  readonly rotateThread?: (input: { readonly disposedThreadId: string }) => Promise<StewardMachineDriver>;
  /**
   * Override the `turn/started` bounded wait (issue #146 S4, item 3). Test seam;
   * production leaves it undefined and {@link DEFAULT_TURN_STARTED_TIMEOUT_MS} applies.
   */
  readonly startedTimeoutMs?: number;
}

export interface DispatchMachineWakeResult {
  readonly threadId: string;
  readonly resumed: boolean;
  /**
   * A prior thread id existed but `thread/resume` failed, so a FRESH thread was
   * started and the store overwritten (S3 reset policy).
   */
  readonly threadReset: boolean;
  readonly injectedAt: string;
}

export async function dispatchMachineWake(input: DispatchMachineWakeInput): Promise<DispatchMachineWakeResult> {
  const { threadStore, wakeStore, now } = input;
  const { wakeId, deadline, envelope } = input.wake;
  const provider = input.provider ?? 'codex';

  // (a) Machine-thread rotation on context overflow (issue #146 S4, item 5). The
  // machine equivalent of the PTY `evaluateStewardRotation` path: if the stored
  // thread's last driver telemetry is over the SAME rotation threshold, dispose
  // the poisoned driver, swap in a fresh one, and force a fresh thread below.
  // Reuses `resolveRotationThreshold` / `decideStewardRotation` — no new numbers.
  const stored = await resolveStoredForProvider(input, provider);
  const rotation = await maybeRotateMachineThread(input, stored);
  const driver = rotation.driver;

  // (b) Resolve the native thread — resume the stored one, else start fresh. A
  // resume failure resets to a fresh thread (S3 policy) rather than failing. A
  // rotation forces the fresh branch (the poisoned id is deliberately dropped).
  const resolved = await resolveMachineThread(input, driver, rotation.rotated ? null : stored);
  await threadStore.write({
    provider,
    threadId: resolved.threadId,
    createdAt: resolved.createdAt,
    lastTurnAt: now,
  });

  // Record the rotation now that the fresh thread id is known — the SAME
  // `session_rotated` event shape the PTY path emits (disposed/new session ids
  // are the disposed/new native thread UUIDs for a machine wake).
  if (rotation.rotated) {
    await recordStewardRotation(input.workspaceDir, {
      at: now,
      wsId: input.wsId,
      disposedSessionId: rotation.disposedThreadId,
      newSessionId: resolved.threadId,
      reason: rotation.reason,
      inputTokens: rotation.inputTokens,
      modelContextWindow: rotation.modelContextWindow,
      threshold: rotation.threshold,
    }).catch(() => undefined);
  }

  // (c) Create the wake keyed off the native thread UUID — the supervisor keys a
  // machine wake's liveness/telemetry off `sessionId`.
  const record = await wakeStore.create({
    wakeId,
    deadline,
    envelope,
    now,
    controlFace: 'machine',
    sessionId: resolved.threadId,
  });
  input.onWakeCreated?.();

  // (d)+(e) Fire the wake as ONE turn with the SAME body the PTY path injects (no
  // `\r`, no submit delay — those are PTY pathologies). Block only until
  // `turn/start` is accepted, then let the turn run DETACHED: completion is the
  // supervisor's job (ledger + finalize markers), not the dispatcher's. The
  // turn carries the wake's deadline so the driver actively interrupts at the
  // deadline instead of burning tokens until the supervisor marks `timeout`
  // (issue #146 S4, item 2).
  const deadlineMs = Date.parse(deadline) - Date.parse(now);
  await startDetachedTurn({
    driver,
    threadId: resolved.threadId,
    message: formatStewardWakeMessage(record),
    workspaceDir: input.workspaceDir,
    wsId: input.wsId,
    wakeId,
    logger: input.logger,
    ...(Number.isFinite(deadlineMs) && deadlineMs > 0 ? { deadlineMs } : {}),
    ...(input.startedTimeoutMs !== undefined ? { startedTimeoutMs: input.startedTimeoutMs } : {}),
  });

  const injectedAt = new Date().toISOString();
  await wakeStore.updateStatus(wakeId, 'injected', {
    now: injectedAt,
    injectedAt,
    sessionId: resolved.threadId,
  });

  return { threadId: resolved.threadId, resumed: resolved.resumed, threadReset: resolved.reset, injectedAt };
}

/**
 * Read the stored thread, but treat a record belonging to the OTHER provider as
 * ABSENT (issue #146 S5): a codex thread id is meaningless to the claude face and
 * vice versa, so resuming it would fail or cross wires. On a mismatch the stored
 * record is dropped (⇒ a fresh thread is started + the store overwritten with the
 * current provider) and a structured `machine_thread_provider_mismatch` event is
 * emitted. A matching or absent record passes through unchanged.
 */
async function resolveStoredForProvider(
  input: DispatchMachineWakeInput,
  provider: MachineThreadProvider,
): Promise<MachineThreadState | null> {
  const stored = await input.threadStore.read();
  if (!stored || stored.provider === provider) return stored;
  input.logger.warn('schedule.steward_machine_thread_provider_mismatch', {
    wsId: input.wsId,
    wakeId: input.wake.wakeId,
    priorThreadId: stored.threadId,
    storedProvider: stored.provider,
    provider,
  });
  await appendSupervisorEvent(input.workspaceDir, {
    at: input.now,
    type: 'machine_thread_provider_mismatch',
    wakeId: input.wake.wakeId,
    priorThreadId: stored.threadId,
    storedProvider: stored.provider,
    provider,
  }).catch(() => undefined);
  return null;
}

interface MachineRotationOutcome {
  /** The driver to run this wake on — the fresh one when `rotated`, else the
   *  input driver. */
  readonly driver: StewardMachineDriver;
  readonly rotated: boolean;
  readonly disposedThreadId: string;
  readonly reason: StewardRotationReason;
  readonly inputTokens: number | null;
  readonly modelContextWindow: number | null;
  readonly threshold: number;
}

/**
 * Machine-thread rotation decision (issue #146 S4, item 5). Reads the CURRENT
 * driver's last token-usage telemetry for the stored thread and, if it is over
 * the steward rotation threshold (`resolveRotationThreshold` + `decideStewardRotation`,
 * the same policy the PTY path uses), disposes the poisoned driver and returns a
 * fresh one via `rotateThread`. Never blocks a wake: no stored thread, no
 * `rotateThread` hook, or telemetry the driver hasn't reported (e.g. right after
 * an Alice restart, when the in-memory driver has no snapshot) all resume on the
 * existing driver.
 */
async function maybeRotateMachineThread(
  input: DispatchMachineWakeInput,
  stored: MachineThreadState | null,
): Promise<MachineRotationOutcome> {
  const threshold = resolveRotationThreshold(input.config ?? {});
  const noRotation = {
    driver: input.driver,
    rotated: false as const,
    disposedThreadId: '',
    reason: 'under_threshold' as StewardRotationReason,
    inputTokens: null,
    modelContextWindow: null,
    threshold,
  };
  if (!stored || !input.rotateThread) return noRotation;

  const raw = input.driver.readTelemetry(stored.threadId);
  const telemetry = adaptThreadTelemetry(raw, stored.threadId);
  const decision = decideStewardRotation(telemetry, threshold);
  if (!decision.rotate) return { ...noRotation, reason: decision.reason };

  const freshDriver = await input.rotateThread({ disposedThreadId: stored.threadId });
  input.logger.info('schedule.steward_machine_thread_rotated', {
    wsId: input.wsId,
    wakeId: input.wake.wakeId,
    disposedThreadId: stored.threadId,
    reason: decision.reason,
    inputTokens: decision.telemetry?.inputTokens ?? null,
    modelContextWindow: decision.telemetry?.modelContextWindow ?? null,
    threshold,
  });
  return {
    driver: freshDriver,
    rotated: true,
    disposedThreadId: stored.threadId,
    reason: decision.reason,
    inputTokens: decision.telemetry?.inputTokens ?? null,
    modelContextWindow: decision.telemetry?.modelContextWindow ?? null,
    threshold,
  };
}

/**
 * Adapt a machine driver's `ThreadTelemetry` snapshot into the `ContextTelemetry`
 * shape the shared rotation policy consumes (issue #146 S4). Mirrors the
 * supervisor's `machineTelemetryReader`: `contextWindow` maps to
 * `modelContextWindow` (0 when the driver has reported none — no window means no
 * overflow verdict). Null snapshot ⇒ null (no telemetry ⇒ never rotate).
 */
function adaptThreadTelemetry(raw: ThreadTelemetry | null, threadId: string): ContextTelemetry | null {
  if (!raw) return null;
  return {
    inputTokens: raw.inputTokens,
    modelContextWindow: raw.contextWindow ?? 0,
    source: `machine-driver:${threadId}`,
  };
}

interface ResolvedThread {
  readonly threadId: string;
  readonly resumed: boolean;
  readonly reset: boolean;
  readonly createdAt: string;
}

async function resolveMachineThread(
  input: DispatchMachineWakeInput,
  driver: StewardMachineDriver,
  existing: MachineThreadState | null,
): Promise<ResolvedThread> {
  const { cwd } = input;
  // Issue #146 MAJOR-2: apply the steward core-model override
  // (`.alice/steward/core-agent-model.txt`) the PTY path applies via `-m`
  // (`adapters/codex.ts` `codexModelHead`) — reused here, not reparsed, so both
  // codex control faces honor the SAME override file identically. It is CODEX-
  // ONLY (issue #146 S5): the file holds a codex model id, meaningless to claude,
  // whose model comes from the workspace `.claude/settings.local.json` the SDK
  // loads via its default `settingSources` (parity with a PTY claude spawn).
  const model = (input.provider ?? 'codex') === 'codex' ? (readCodexModelOverride(cwd) ?? undefined) : undefined;
  const ensureOpts = (threadId?: string): EnsureThreadOptions => ({
    cwd,
    // Issue #146 MAJOR-1: every steward machine thread requests network-enabled
    // workspace-write, mirroring the PTY codex adapter's unconditional
    // `-c sandbox_workspace_write.network_access=true` — without it `alice*`
    // cannot reach the loopback CLI gateway and the UTA checklist can't run.
    networkAccess: true,
    ...(model !== undefined ? { model } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  });

  if (existing) {
    try {
      const { threadId, resumed } = await driver.ensureThread(ensureOpts(existing.threadId));
      return { threadId, resumed, reset: false, createdAt: existing.createdAt };
    } catch (err) {
      // S3 resume-failure policy: don't fail the wake — start a FRESH thread,
      // overwrite the store, and record the reset as a structured event.
      input.logger.warn('schedule.steward_machine_thread_reset', {
        wsId: input.wsId,
        wakeId: input.wake.wakeId,
        priorThreadId: existing.threadId,
        err: errText(err),
      });
      await appendSupervisorEvent(input.workspaceDir, {
        at: input.now,
        type: 'machine_thread_reset',
        wakeId: input.wake.wakeId,
        priorThreadId: existing.threadId,
        reason: errText(err),
      }).catch(() => undefined);
      const fresh = await driver.ensureThread(ensureOpts());
      return { threadId: fresh.threadId, resumed: false, reset: true, createdAt: input.now };
    }
  }
  const fresh = await driver.ensureThread(ensureOpts());
  return { threadId: fresh.threadId, resumed: false, reset: false, createdAt: input.now };
}

/**
 * Start a turn and resolve once `turn/start` is accepted (the `turn-started`
 * event OR a fast completion), leaving the turn running detached. Rejects when
 * the turn fails BEFORE it started, OR when `turn/started` is not observed within
 * the bounded wait (issue #146 S4, item 3) — both are dispatch failures the
 * caller terminalizes (wake `error` + lock release). A failure AFTER start is
 * logged + evented but never rejects (the wake is already `injected`; the
 * supervisor owns terminal states). A deadline `interrupted` settle is a
 * distinct `machine_turn_interrupted` event, NOT `machine_turn_failed` (item 2).
 */
async function startDetachedTurn(input: {
  readonly driver: StewardMachineDriver;
  readonly threadId: string;
  readonly message: string;
  readonly workspaceDir: string;
  readonly wsId: string;
  readonly wakeId: string;
  readonly logger: Logger;
  /** Interrupt the turn at this many ms — the wake's remaining deadline (item 2). */
  readonly deadlineMs?: number;
  /** Bounded wait for `turn/started` (item 3). */
  readonly startedTimeoutMs?: number;
}): Promise<void> {
  const { driver, threadId, message } = input;
  let settled = false;
  let markStarted!: () => void;
  let markFailed!: (err: unknown) => void;
  const started = new Promise<void>((resolve, reject) => {
    markStarted = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    markFailed = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
  });

  // Item 3: bound the wait for `turn/started`. A server that accepts turn/start
  // but never emits turn/started (nor completes nor errors) would otherwise
  // block forever; on expiry we fail the dispatch on the same path as a
  // pre-start rejection and record a structured event.
  const startedTimeoutMs = input.startedTimeoutMs ?? DEFAULT_TURN_STARTED_TIMEOUT_MS;
  const startedTimer = setTimeout(() => {
    if (settled) return;
    input.logger.warn('schedule.steward_machine_turn_start_timeout', {
      wsId: input.wsId,
      wakeId: input.wakeId,
      threadId,
      timeoutMs: startedTimeoutMs,
    });
    void appendSupervisorEvent(input.workspaceDir, {
      at: new Date().toISOString(),
      type: 'machine_turn_dispatch_timeout',
      wakeId: input.wakeId,
      threadId,
      timeoutMs: startedTimeoutMs,
    }).catch(() => undefined);
    // Item 3 (issue #146 S5): the turn was started (`turn/start` accepted) but its
    // start signal never arrived — it is now an ORPHAN, deadline-bounded but
    // unowned. Abort it so it settles `interrupted` instead of burning tokens
    // until the deadline; the detached `turn.then` below consumes that outcome, so
    // no unhandled rejection escapes.
    void driver.interruptInFlight(threadId).catch((err: unknown) =>
      input.logger.warn('schedule.steward_machine_turn_interrupt_failed', {
        wsId: input.wsId,
        wakeId: input.wakeId,
        threadId,
        err: errText(err),
      }),
    );
    markFailed(new Error(`turn/started not observed within ${startedTimeoutMs}ms`));
  }, startedTimeoutMs);

  const turn = driver.runTurn(threadId, message, {
    onEvent: (ev: DriverEvent) => {
      if (ev.type === 'turn-started') markStarted();
    },
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
  });

  // Detached completion handling. A completed turn definitely started; a
  // rejection either (a) never started → rejects the `started` gate below (so the
  // caller marks the wake `error`), or (b) started already → log + event only,
  // NEVER touching the wake status.
  void turn.then(
    (outcome) => {
      markStarted();
      input.logger.info('schedule.steward_machine_turn_settled', {
        wsId: input.wsId,
        wakeId: input.wakeId,
        threadId,
        status: outcome.status,
        interrupted: outcome.interrupted,
      });
      // Item 2: a deadline-interrupted turn is a DISTINCT event, not a failure.
      // The supervisor still owns the `timeout` transition off the wake deadline;
      // this only records that the driver actively stopped the turn.
      if (outcome.interrupted) {
        void appendSupervisorEvent(input.workspaceDir, {
          at: new Date().toISOString(),
          type: 'machine_turn_interrupted',
          wakeId: input.wakeId,
          threadId,
          status: outcome.status,
        }).catch(() => undefined);
      }
    },
    (err) => {
      markFailed(err);
      input.logger.warn('schedule.steward_machine_turn_failed', {
        wsId: input.wsId,
        wakeId: input.wakeId,
        threadId,
        err: errText(err),
      });
      void appendSupervisorEvent(input.workspaceDir, {
        at: new Date().toISOString(),
        type: 'machine_turn_failed',
        wakeId: input.wakeId,
        threadId,
        reason: errText(err),
      }).catch(() => undefined);
    },
  );

  try {
    await started;
  } finally {
    clearTimeout(startedTimer);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Shared control-face gate + machine dispatch (issue #146 S4, item 1) ------
//
// The single code path the cron scanner AND the HTTP route go through to decide
// PTY-vs-machine and, for a machine wake, run the WHOLE machine branch — driver
// acquisition, the wake-exists + account-lock preflight, `dispatchMachineWake`,
// and error terminalization. The registry side effects (get-or-create /
// dispose the per-workspace driver) are injected as `acquireDriver`/`rotateDriver`
// callbacks so this stays unit-testable with mock stores + a mock driver factory
// while `service.ts` binds them to the live `MachineDriverRegistry` closure — the
// "surface what the route needs through the service interface, not by exporting
// globals" rule from the S3 review. The caller runs `refreshStewardRuntime`
// BEFORE this; on a `{ face: 'pty' }` outcome the caller owns its own PTY inline
// flow (byte-identical to pre-#146).

export interface StewardWakeControlFaceInput {
  /** The workspace's `.alice/steward/config.json` (already read by the caller). */
  readonly config: Record<string, unknown>;
  /** The wake's requested agent, if any (`wake.agent` / `body.session?.agent`). */
  readonly requestedAgent: string | undefined;
  readonly wakeId: string;
  /** ISO wake deadline. */
  readonly deadline: string;
  /** ISO dispatch instant. */
  readonly now: string;
  readonly envelope: StewardWakeEnvelope;
}

export type StewardWakeControlFaceOutcome =
  | {
      /** Take the historical PTY inline flow — the caller owns it. `declineReason`
       *  is set only when machine was REQUESTED but declined (the caller logs it). */
      readonly face: 'pty';
      readonly declineReason?: string;
    }
  | {
      readonly face: 'machine';
      /** The `injected` wake record, so the route can echo it in its 202 body. */
      readonly wake: StewardWakeRecord;
      readonly threadId: string;
      readonly resumed: boolean;
      readonly threadReset: boolean;
    };

export interface StewardWakeControlFaceDeps {
  readonly wsId: string;
  readonly workspaceDir: string;
  /** cwd the codex thread runs in — normally the workspace dir. */
  readonly cwd: string;
  readonly workspaceAgents: readonly string[];
  readonly getAdapter: (id: string) => CliAdapter | undefined;
  readonly wakeStore: StewardWakeStore;
  readonly lockStore: StewardLockStore;
  readonly threadStore: MachineThreadStore;
  readonly logger: Logger;
  /**
   * Get-or-create the workspace's machine driver (bound to the service's
   * `MachineDriverRegistry`). Called ONLY once the machine path commits — after
   * the wake-exists check + lock acquisition — so a duplicate-wakeId or lock
   * conflict never spins up a live driver.
   */
  readonly acquireDriver: (adapter: CliAdapter) => StewardMachineDriver;
  /**
   * Dispose the poisoned driver and return a fresh one (rotation, item 5). Bound
   * to the registry by the service; forwarded to `dispatchMachineWake` as its
   * `rotateThread` hook.
   */
  readonly rotateDriver: (adapter: CliAdapter, input: { readonly disposedThreadId: string }) => Promise<StewardMachineDriver>;
  /** Test seam for the `turn/started` bounded wait (item 3). */
  readonly startedTimeoutMs?: number;
}

export async function dispatchStewardWakeControlFace(
  input: StewardWakeControlFaceInput,
  deps: StewardWakeControlFaceDeps,
): Promise<StewardWakeControlFaceOutcome> {
  const decision = resolveStewardControlFace({
    config: input.config,
    requestedAgent: input.requestedAgent,
    workspaceAgents: deps.workspaceAgents,
    getAdapter: deps.getAdapter,
  });
  if (!decision.useMachine || !decision.adapter) {
    return decision.declineReason ? { face: 'pty', declineReason: decision.declineReason } : { face: 'pty' };
  }
  const adapter = decision.adapter;

  // Machine preflight — mirrors the PTY path's wake-exists + lock ordering.
  if (await deps.wakeStore.get(input.wakeId)) {
    throw new Error(`steward wake already exists: ${input.wakeId}`);
  }
  try {
    await deps.lockStore.acquire({
      accountId: input.envelope.accountId,
      wakeId: input.wakeId,
      now: input.now,
      expiresAt: input.deadline,
    });
  } catch (err) {
    if (err instanceof StewardLockConflictError) throw err;
    throw new Error(`steward lock failed: ${(err as Error).message}`);
  }

  let created = false;
  try {
    // Driver construction happens HERE, only once dispatch is committed (S3
    // MINOR-3): a duplicate-wakeId or lock conflict above never builds a driver.
    const driver = deps.acquireDriver(adapter);
    const result = await dispatchMachineWake({
      workspaceDir: deps.workspaceDir,
      wsId: deps.wsId,
      cwd: deps.cwd,
      driver,
      provider: agentProvider(adapter.id),
      wakeStore: deps.wakeStore,
      threadStore: deps.threadStore,
      wake: { wakeId: input.wakeId, deadline: input.deadline, envelope: input.envelope },
      now: input.now,
      logger: deps.logger,
      config: input.config,
      rotateThread: (rotInput) => deps.rotateDriver(adapter, rotInput),
      ...(deps.startedTimeoutMs !== undefined ? { startedTimeoutMs: deps.startedTimeoutMs } : {}),
      onWakeCreated: () => {
        created = true;
      },
    });
    const wake = await deps.wakeStore.get(input.wakeId);
    if (!wake) throw new Error(`machine wake vanished after dispatch: ${input.wakeId}`);
    return {
      face: 'machine',
      wake,
      threadId: result.threadId,
      resumed: result.resumed,
      threadReset: result.threadReset,
    };
  } catch (err) {
    if (created) {
      await deps.wakeStore
        .updateStatus(input.wakeId, 'error', {
          now: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        })
        .catch(() => undefined);
    }
    await deps.lockStore.release(input.envelope.accountId, input.wakeId).catch(() => undefined);
    throw err;
  }
}
