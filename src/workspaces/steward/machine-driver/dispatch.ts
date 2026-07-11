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
import type { CliAdapter } from '../../cli-adapter.js';
import type { Logger } from '../../logger.js';
import type { WorkspaceMeta } from '../../workspace-registry.js';
import { formatStewardWakeMessage } from '../injector.js';
import { appendSupervisorEvent } from '../supervisor.js';
import type { StewardWakeEnvelope } from '../types.js';
import type { StewardWakeStore } from '../wake-store.js';
import { CodexAppServerDriver } from './codex-app-server-driver.js';
import type { MachineThreadStore } from './thread-store.js';
import type { DriverEvent, EnsureThreadOptions, StewardMachineDriver } from './types.js';

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
 * Decide the control face for a steward wake. Machine is opt-in
 * (`config.controlFace === 'machine'`) and codex-only: a non-codex agent, or a
 * workspace that doesn't enable codex, declines to PTY with a reason (S3 never
 * fails a wake over this). A missing / 'pty' flag is a plain PTY decision with no
 * reason — byte-identical to pre-#146 behavior.
 */
export function decideStewardControlFace(input: {
  readonly config: Record<string, unknown>;
  readonly requestedAgent: string | undefined;
  readonly workspaceAgents: readonly string[];
}): StewardControlFaceDecision {
  const configuredAgent =
    typeof input.config['agent'] === 'string' ? (input.config['agent'] as string) : undefined;
  const agent = input.requestedAgent ?? configuredAgent ?? 'codex';
  if (input.config['controlFace'] !== 'machine') return { useMachine: false, agent };
  if (agent !== 'codex') {
    return { useMachine: false, agent, declineReason: `control face 'machine' is codex-only (agent: ${agent})` };
  }
  if (!input.workspaceAgents.includes('codex')) {
    return {
      useMachine: false,
      agent,
      declineReason: "control face 'machine' requires the workspace to enable codex",
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
  return new CodexAppServerDriver({
    cwd: input.cwd,
    env: input.env,
    ...(input.adapter.binary ? { codexBin: input.adapter.binary } : {}),
    logger: input.logger.child({ scope: 'machine-driver', wsId: input.ws.id, agent: input.adapter.id }),
  });
}

export interface DispatchMachineWakeInput {
  readonly workspaceDir: string;
  readonly wsId: string;
  /** cwd the codex thread runs in — normally the workspace dir. */
  readonly cwd: string;
  readonly driver: StewardMachineDriver;
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
  const { driver, threadStore, wakeStore, now } = input;
  const { wakeId, deadline, envelope } = input.wake;

  // (b) Resolve the native thread — resume the stored one, else start fresh. A
  // resume failure resets to a fresh thread (S3 policy) rather than failing.
  const resolved = await resolveMachineThread(input);
  await threadStore.write({
    threadId: resolved.threadId,
    createdAt: resolved.createdAt,
    lastTurnAt: now,
  });

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
  // supervisor's job (ledger + finalize markers), not the dispatcher's.
  await startDetachedTurn({
    driver,
    threadId: resolved.threadId,
    message: formatStewardWakeMessage(record),
    workspaceDir: input.workspaceDir,
    wsId: input.wsId,
    wakeId,
    logger: input.logger,
  });

  const injectedAt = new Date().toISOString();
  await wakeStore.updateStatus(wakeId, 'injected', {
    now: injectedAt,
    injectedAt,
    sessionId: resolved.threadId,
  });

  return { threadId: resolved.threadId, resumed: resolved.resumed, threadReset: resolved.reset, injectedAt };
}

interface ResolvedThread {
  readonly threadId: string;
  readonly resumed: boolean;
  readonly reset: boolean;
  readonly createdAt: string;
}

async function resolveMachineThread(input: DispatchMachineWakeInput): Promise<ResolvedThread> {
  const { driver, threadStore, cwd } = input;
  // Issue #146 MAJOR-2: apply the steward core-model override
  // (`.alice/steward/core-agent-model.txt`) the PTY path applies via `-m`
  // (`adapters/codex.ts` `codexModelHead`) — reused here, not reparsed, so both
  // control faces honor the SAME override file identically.
  const model = readCodexModelOverride(cwd) ?? undefined;
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

  const existing = await threadStore.read();
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
 * event OR a fast completion), leaving the turn running detached. Rejects ONLY
 * when the turn fails BEFORE it started — a failure AFTER start is logged +
 * evented but never rejects (the wake is already `injected`; the supervisor owns
 * terminal states).
 */
async function startDetachedTurn(input: {
  readonly driver: StewardMachineDriver;
  readonly threadId: string;
  readonly message: string;
  readonly workspaceDir: string;
  readonly wsId: string;
  readonly wakeId: string;
  readonly logger: Logger;
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

  const turn = driver.runTurn(threadId, message, {
    onEvent: (ev: DriverEvent) => {
      if (ev.type === 'turn-started') markStarted();
    },
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

  await started;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
