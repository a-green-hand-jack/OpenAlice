/**
 * `CodexAppServerDriver` — drives `codex app-server` over stdio JSON-RPC for
 * unattended steward wakes. It lazily spawns the app-server on first use,
 * performs the initialize handshake once, and exposes a thread/turn API that
 * blocks until a turn settles (via the `turn/completed` notification) rather
 * than streaming.
 *
 * Wire shapes are pinned against the committed schema snapshot
 * (`fixtures/schema/`, codex-cli SUPPORTED_CODEX_VERSION); `protocol-contract.spec.ts`
 * fails if a method string the driver uses drifts out of that schema.
 */

import { spawn } from 'node:child_process';

import type { Logger } from '../../logger.js';
import { JsonRpcStdioClient, NOOP_LOGGER } from './jsonrpc-stdio.js';
import {
  MachineDriverProtocolError,
  type DriverEvent,
  type EnsureThreadOptions,
  type JsonRpcId,
  type MachineTransport,
  type RunTurnOptions,
  type StewardMachineDriver,
  type ThreadTelemetry,
  type TurnOutcome,
  type WorkspaceWriteSandboxPolicyOverride,
} from './types.js';

/** The codex-cli version the committed schema snapshot was generated from. */
export const SUPPORTED_CODEX_VERSION = '0.144.0';

const CLIENT_INFO = {
  name: 'openalice-steward',
  title: 'OpenAlice steward machine driver',
  version: SUPPORTED_CODEX_VERSION,
} as const;

/** After a deadline-triggered `turn/interrupt`, wait this long for the turn to
 *  settle on its own before resolving `interrupted` unconditionally. */
const INTERRUPT_GRACE_MS = 2000;

export interface CodexAppServerDriverOptions {
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly codexBin?: string;
  readonly logger?: Logger;
  /** Test seam: override how the app-server child is created. Production leaves
   *  this undefined and spawns `codex app-server`. */
  readonly spawn?: () => MachineTransport;
}

interface ThreadState {
  alive: boolean;
  /** Set from `EnsureThreadOptions.networkAccess` (issue #146 MAJOR-1); read by
   *  `runTurn` to attach a `sandboxPolicy` override so every turn on this
   *  thread gets network-enabled workspace-write, mirroring the PTY codex
   *  adapter's unconditional `-c sandbox_workspace_write.network_access=true`. */
  networkAccess?: boolean;
}

/**
 * One in-flight turn on a thread. INVARIANT: at most one per thread — a second
 * `runTurn` on a thread with a live waiter is rejected. Notifications are
 * matched to the waiter by threadId (the single active turn).
 */
interface TurnWaiter {
  readonly threadId: string;
  turnId: string;
  settled: boolean;
  interrupted: boolean;
  agentMessage: string | null;
  deadlineTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
  readonly onEvent: ((ev: DriverEvent) => void) | undefined;
  resolve: (outcome: TurnOutcome) => void;
  reject: (err: Error) => void;
}

export class CodexAppServerDriver implements StewardMachineDriver {
  private readonly options: CodexAppServerDriverOptions;
  private readonly logger: Logger;
  private readonly threads = new Map<string, ThreadState>();
  private readonly telemetry = new Map<string, ThreadTelemetry>();
  private readonly inflight = new Map<string, TurnWaiter>();
  private transport: MachineTransport | null = null;
  private client: JsonRpcStdioClient | null = null;
  private connectPromise: Promise<JsonRpcStdioClient> | null = null;
  private closed = false;
  private disposed = false;

  constructor(options: CodexAppServerDriverOptions) {
    this.options = options;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async ensureThread(opts: EnsureThreadOptions): Promise<{ threadId: string; resumed: boolean }> {
    const client = await this.connect();
    const sandbox = opts.sandbox ?? 'workspace-write';
    if (opts.threadId) {
      const resumeParams: Record<string, unknown> = {
        threadId: opts.threadId,
        cwd: opts.cwd,
        approvalPolicy: 'never',
        sandbox,
      };
      // Issue #146 MAJOR-2: `.alice/steward/core-agent-model.txt` override, same
      // field `thread/start` already honors below — `ThreadResumeParams.model`
      // carries "Configuration overrides for the resumed thread, if any."
      if (opts.model !== undefined) resumeParams.model = opts.model;
      const result = (await client.request('thread/resume', resumeParams)) as { thread?: { id?: string } };
      const threadId = result?.thread?.id ?? opts.threadId;
      this.threads.set(threadId, { alive: true, networkAccess: opts.networkAccess });
      return { threadId, resumed: true };
    }
    const startParams: Record<string, unknown> = {
      cwd: opts.cwd,
      approvalPolicy: 'never',
      sandbox,
      ephemeral: false,
    };
    if (opts.model !== undefined) startParams.model = opts.model;
    const result = (await client.request('thread/start', startParams)) as { thread?: { id?: string } };
    const threadId = result?.thread?.id;
    if (!threadId) throw new MachineDriverProtocolError('thread/start response missing thread.id');
    this.threads.set(threadId, { alive: true, networkAccess: opts.networkAccess });
    return { threadId, resumed: false };
  }

  async runTurn(threadId: string, input: string, opts: RunTurnOptions = {}): Promise<TurnOutcome> {
    const client = await this.connect();
    if (this.disposed || this.closed) {
      throw new MachineDriverProtocolError('driver is not connected');
    }
    // One-turn-per-thread invariant.
    if (this.inflight.has(threadId)) {
      throw new MachineDriverProtocolError(`a turn is already in flight for thread ${threadId}`);
    }

    let resolveOutcome!: (outcome: TurnOutcome) => void;
    let rejectOutcome!: (err: Error) => void;
    const outcome = new Promise<TurnOutcome>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    const waiter: TurnWaiter = {
      threadId,
      turnId: '',
      settled: false,
      interrupted: false,
      agentMessage: null,
      deadlineTimer: null,
      graceTimer: null,
      onEvent: opts.onEvent,
      resolve: resolveOutcome,
      reject: rejectOutcome,
    };
    this.inflight.set(threadId, waiter);

    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text: input }],
    };
    if (opts.effort !== undefined) turnParams.effort = opts.effort;
    if (opts.model !== undefined) turnParams.model = opts.model;
    // Issue #146 MAJOR-1: a thread that requested `networkAccess` at ensureThread
    // time gets the override resent on EVERY turn (idempotent — the schema
    // documents it as persisting "for this turn and subsequent turns" anyway,
    // but resending is the robust choice against process-restart/resume edge
    // cases where in-process persistence can't be assumed). Minimal payload —
    // `writableRoots` / `excludeTmpdirEnvVar` / `excludeSlashTmp` keep the
    // server's documented defaults when omitted.
    if (this.threads.get(threadId)?.networkAccess) {
      const sandboxPolicy: WorkspaceWriteSandboxPolicyOverride = { type: 'workspaceWrite', networkAccess: true };
      turnParams.sandboxPolicy = sandboxPolicy;
    }

    try {
      const started = (await client.request('turn/start', turnParams)) as { turn?: { id?: string } };
      const turnId = started?.turn?.id;
      if (!turnId) throw new MachineDriverProtocolError('turn/start response missing turn.id');
      // Guard against the child dying (waiter rejected) between the await points.
      if (waiter.settled) return outcome;
      waiter.turnId = turnId;
      this.markAlive(threadId);
      if (opts.deadlineMs !== undefined && opts.deadlineMs > 0) {
        waiter.deadlineTimer = setTimeout(() => this.onDeadline(waiter, opts.deadlineMs as number), opts.deadlineMs);
      }
    } catch (err) {
      // onClose/dispose may have already rejected `outcome` while turn/start
      // was in flight; hand it back so the rejection is consumed exactly once
      // instead of orphaning a rejected promise (unhandled rejection).
      if (waiter.settled) return outcome;
      this.discardWaiter(waiter);
      throw err instanceof Error ? err : new MachineDriverProtocolError(String(err));
    }

    return outcome;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const client = this.client;
    if (!client || this.closed) return;
    await client.request('turn/interrupt', { threadId, turnId });
  }

  /**
   * Issue #146 S5 (item 3): interrupt the in-flight turn on `threadId` and settle
   * it `interrupted`, reusing the SAME `turn/interrupt` + grace-timer path as a
   * deadline overrun. No-op when nothing is in flight or the waiter already
   * settled. The dispatch gate-timeout path calls this so an orphan turn (started
   * but never confirmed) is actively stopped instead of burning tokens unowned.
   */
  async interruptInFlight(threadId: string): Promise<void> {
    const waiter = this.inflight.get(threadId);
    if (!waiter || waiter.settled) return;
    this.beginInterrupt(waiter);
  }

  isHealthy(): boolean {
    // Issue #146 S5 (item 2): "transport alive && not disposed/closed". `closed`
    // flips on the app-server exit (`onClose`) or dispose; a not-yet-connected
    // driver (transport still null, never used) is healthy — it connects lazily.
    return !this.disposed && !this.closed;
  }

  isThreadLive(threadId: string): boolean {
    if (this.disposed || this.closed) return false;
    if (this.inflight.has(threadId)) return true;
    const state = this.threads.get(threadId);
    return state !== undefined && state.alive && this.transport !== null;
  }

  readTelemetry(threadId: string): ThreadTelemetry | null {
    return this.telemetry.get(threadId) ?? null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    const err = new MachineDriverProtocolError('driver disposed');
    for (const waiter of [...this.inflight.values()]) this.failWaiter(waiter, err);
    for (const state of this.threads.values()) state.alive = false;
    const transport = this.transport;
    if (transport?.kill) {
      try {
        transport.kill('SIGTERM');
      } catch (killErr) {
        this.logger.warn('failed to SIGTERM codex app-server', { err: killErr });
      }
    }
  }

  // --- connection ---------------------------------------------------------

  private connect(): Promise<JsonRpcStdioClient> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect();
    return this.connectPromise;
  }

  private async doConnect(): Promise<JsonRpcStdioClient> {
    const transport = this.options.spawn ? this.options.spawn() : this.spawnCodex();
    this.transport = transport;
    const client = new JsonRpcStdioClient(transport, {
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (method, params, id) => this.onServerRequest(method, params, id),
      onClose: (err) => this.onClose(err),
      logger: this.logger,
    });
    this.client = client;
    await client.request('initialize', { clientInfo: CLIENT_INFO });
    client.notify('initialized');
    return client;
  }

  private spawnCodex(): MachineTransport {
    const bin = this.options.codexBin ?? 'codex';
    const child = spawn(bin, ['app-server'], {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!child.stdin || !child.stdout) {
      throw new MachineDriverProtocolError('codex app-server did not expose stdio pipes');
    }
    child.stderr?.on('data', (chunk: Buffer) =>
      this.logger.debug('codex app-server stderr', { chunk: chunk.toString('utf8') }),
    );
    return child as unknown as MachineTransport;
  }

  // --- notification handling ---------------------------------------------

  private onNotification(method: string, params: unknown): void {
    switch (method) {
      case 'turn/started':
        this.onTurnStarted(params);
        break;
      case 'item/completed':
        this.onItemCompleted(params);
        break;
      case 'thread/tokenUsage/updated':
        this.onTokenUsage(params);
        break;
      case 'turn/completed':
        this.onTurnCompleted(params);
        break;
      case 'error':
        this.onErrorNotification(params);
        break;
      default:
        // Every other app-server notification (hooks, mcp status, diffs, rate
        // limits, …) is telemetry we don't act on in the unattended path.
        break;
    }
  }

  private onTurnStarted(params: unknown): void {
    const p = params as { threadId?: string; turn?: { id?: string } };
    const threadId = p.threadId;
    const turnId = p.turn?.id;
    if (!threadId) return;
    this.markAlive(threadId);
    if (turnId) this.emit(threadId, { type: 'turn-started', threadId, turnId });
  }

  private onItemCompleted(params: unknown): void {
    const p = params as {
      threadId?: string;
      turnId?: string;
      item?: { type?: string; text?: string };
    };
    const threadId = p.threadId;
    const item = p.item;
    if (!threadId || !item) return;
    const waiter = this.inflight.get(threadId);
    const isAgentMessage = item.type === 'agentMessage';
    const text = isAgentMessage && typeof item.text === 'string' ? item.text : null;
    // Capture the final agent message so it's available when the turn settles.
    if (isAgentMessage && waiter) waiter.agentMessage = text;
    this.emit(threadId, {
      type: 'item-completed',
      threadId,
      turnId: p.turnId ?? waiter?.turnId ?? '',
      itemType: item.type ?? 'unknown',
      text,
    });
  }

  private onTokenUsage(params: unknown): void {
    const p = params as {
      threadId?: string;
      turnId?: string;
      tokenUsage?: {
        total?: {
          totalTokens?: number;
          inputTokens?: number;
          cachedInputTokens?: number;
          outputTokens?: number;
        };
        modelContextWindow?: number | null;
      };
    };
    const threadId = p.threadId;
    const total = p.tokenUsage?.total;
    if (!threadId || !total) return;
    const telemetry: ThreadTelemetry = {
      totalTokens: total.totalTokens ?? 0,
      inputTokens: total.inputTokens ?? 0,
      cachedInputTokens: total.cachedInputTokens ?? 0,
      outputTokens: total.outputTokens ?? 0,
      contextWindow: p.tokenUsage?.modelContextWindow ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.telemetry.set(threadId, telemetry);
    this.emit(threadId, { type: 'token-usage', threadId, turnId: p.turnId ?? '', telemetry });
  }

  private onTurnCompleted(params: unknown): void {
    const p = params as {
      threadId?: string;
      turn?: { id?: string; status?: string; durationMs?: number | null };
    };
    const threadId = p.threadId;
    if (!threadId) return;
    const waiter = this.inflight.get(threadId);
    if (!waiter) return;
    // Ignore a completion for a turn we didn't launch (should not happen given
    // the one-turn-per-thread invariant, but stay defensive).
    if (waiter.turnId && p.turn?.id && waiter.turnId !== p.turn.id) return;
    const durationMs = typeof p.turn?.durationMs === 'number' ? p.turn.durationMs : null;
    if (waiter.interrupted) {
      this.settleWaiter(waiter, {
        turnId: waiter.turnId,
        status: 'interrupted',
        agentMessage: waiter.agentMessage,
        durationMs,
        interrupted: true,
      });
      return;
    }
    this.settleWaiter(waiter, {
      turnId: waiter.turnId || p.turn?.id || '',
      status: p.turn?.status ?? 'completed',
      agentMessage: waiter.agentMessage,
      durationMs,
      interrupted: false,
    });
  }

  private onErrorNotification(params: unknown): void {
    const p = params as {
      error?: { message?: string };
      threadId?: string;
      turnId?: string;
      willRetry?: boolean;
    };
    const threadId = p.threadId;
    if (!threadId) return;
    const willRetry = p.willRetry === true;
    const message = p.error?.message ?? 'unknown turn error';
    this.emit(threadId, {
      type: 'error-notification',
      threadId,
      turnId: p.turnId ?? '',
      message,
      willRetry,
    });
    // Retryable errors are informational — the app-server keeps the turn alive.
    if (willRetry) return;
    const waiter = this.inflight.get(threadId);
    if (waiter) this.failWaiter(waiter, new MachineDriverProtocolError(`turn error: ${message}`));
  }

  private onServerRequest(method: string, _params: unknown, id: JsonRpcId): undefined {
    // Under `approvalPolicy: 'never'` the server shouldn't ask; if it does we
    // deny (via the client's default) and surface it to any active turn.
    const event: DriverEvent = { type: 'server-request-denied', requestId: id, method };
    for (const waiter of this.inflight.values()) waiter.onEvent?.(event);
    this.logger.warn('denied server->client request', { method });
    return undefined;
  }

  private onClose(err: Error): void {
    this.closed = true;
    for (const state of this.threads.values()) state.alive = false;
    for (const waiter of [...this.inflight.values()]) this.failWaiter(waiter, err);
  }

  // --- deadline / turn-waiter lifecycle ----------------------------------

  private onDeadline(waiter: TurnWaiter, deadlineMs: number): void {
    if (waiter.settled) return;
    this.logger.warn('turn deadline exceeded; interrupting', {
      threadId: waiter.threadId,
      turnId: waiter.turnId,
      deadlineMs,
    });
    this.beginInterrupt(waiter);
  }

  /**
   * Send `turn/interrupt` for the waiter's turn and arm the grace timer that
   * settles it `interrupted` even if the app-server never emits `turn/completed`.
   * Shared by the deadline path ({@link onDeadline}) and the explicit
   * {@link interruptInFlight} (issue #146 S5). Idempotent: a second call once
   * `interrupted` is set is a no-op, so no second interrupt or grace timer arms.
   */
  private beginInterrupt(waiter: TurnWaiter): void {
    if (waiter.settled || waiter.interrupted) return;
    waiter.interrupted = true;
    this.client
      ?.request('turn/interrupt', { threadId: waiter.threadId, turnId: waiter.turnId })
      .catch((err: unknown) => this.logger.warn('turn/interrupt request failed', { err }));
    // If the interrupt doesn't produce a `turn/completed`, settle anyway.
    waiter.graceTimer = setTimeout(() => {
      if (waiter.settled) return;
      this.settleWaiter(waiter, {
        turnId: waiter.turnId,
        status: 'interrupted',
        agentMessage: waiter.agentMessage,
        durationMs: null,
        interrupted: true,
      });
    }, INTERRUPT_GRACE_MS);
  }

  private emit(threadId: string, event: DriverEvent): void {
    this.inflight.get(threadId)?.onEvent?.(event);
  }

  private markAlive(threadId: string): void {
    const state = this.threads.get(threadId);
    if (state) state.alive = true;
    else this.threads.set(threadId, { alive: true });
  }

  private clearTimers(waiter: TurnWaiter): void {
    if (waiter.deadlineTimer) clearTimeout(waiter.deadlineTimer);
    if (waiter.graceTimer) clearTimeout(waiter.graceTimer);
    waiter.deadlineTimer = null;
    waiter.graceTimer = null;
  }

  private settleWaiter(waiter: TurnWaiter, outcome: TurnOutcome): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.clearTimers(waiter);
    this.inflight.delete(waiter.threadId);
    waiter.resolve(outcome);
  }

  private failWaiter(waiter: TurnWaiter, err: Error): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.clearTimers(waiter);
    this.inflight.delete(waiter.threadId);
    // Issue #146 S4 (first-review MINOR-2): a FATAL turn settle that is not a
    // completion — a non-retryable `error` notification, an app-server exit, or
    // a dispose — clears the thread's `alive` flag. Without this, a turn that
    // dies AFTER `turn/started` leaves `alive` true, so the supervisor never
    // sees the thread as vanished and waits out the full deadline. This mirrors
    // the PTY "session vanished → stuck" fast path: `isThreadLive` now reports
    // gone, so the next supervisor tick transitions the wake to `stuck`. The OS
    // process may still be running; `ensureThread` re-marks alive on the next
    // resume, so future wakes are unaffected. NOTE: a normally-completed turn
    // (including a deadline `interrupted` one) settles via `settleWaiter`, which
    // deliberately does NOT touch `alive`.
    const state = this.threads.get(waiter.threadId);
    if (state) state.alive = false;
    waiter.reject(err);
  }

  /** Tear down a waiter whose `turn/start` never succeeded (no promise settle). */
  private discardWaiter(waiter: TurnWaiter): void {
    waiter.settled = true;
    this.clearTimers(waiter);
    this.inflight.delete(waiter.threadId);
  }
}
