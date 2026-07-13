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

/**
 * Process-wide memoization of the `codex --version` probe (issue #152), keyed
 * by the resolved binary — multiple steward workspaces sharing the default
 * `codex` bin spawn the probe at most once per process, not once per driver.
 * Only exercised by the DEFAULT probe below; a test-injected `versionProbe`
 * (`CodexAppServerDriverOptions.versionProbe`) bypasses it entirely.
 */
const versionProbeCache = new Map<string, Promise<string | null>>();

/**
 * Spawn `<bin> --version` and parse the semver-shaped substring out of stdout
 * (codex prints e.g. `codex-cli 0.144.0`). Resolves `null` — NEVER rejects —
 * on any failure: binary missing, non-zero exit, unparsable output. A failed
 * probe is itself just a warning input (issue #152); it must never throw into
 * the wake path.
 */
function probeCodexVersion(bin: string): Promise<string | null> {
  const cached = versionProbeCache.get(bin);
  if (cached) return cached;
  const probe = new Promise<string | null>((resolve) => {
    try {
      const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      // A hung binary must not pin the event loop or leave the cached promise
      // pending forever — kill after a bound and settle null (warn-only path).
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve(null);
      }, 5000);
      timer.unref();
      child.unref();
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', () => { clearTimeout(timer); resolve(parseCodexVersionOutput(out)); });
    } catch {
      resolve(null);
    }
  });
  versionProbeCache.set(bin, probe);
  return probe;
}

function parseCodexVersionOutput(output: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match?.[1] ?? null;
}

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
  /** `inherit` preserves the historical parent-env merge. Security-sensitive
   * callers can select `replace` to launch from only the supplied environment. */
  readonly envInheritance?: 'inherit' | 'replace';
  readonly codexBin?: string;
  readonly logger?: Logger;
  /** Test seam: override how the app-server child is created. Production leaves
   *  this undefined and spawns `codex app-server`. */
  readonly spawn?: () => MachineTransport;
  /** Test seam: override the `codex --version` probe (issue #152). Production
   *  leaves this undefined and spawns `<codexBin> --version`, memoized per bin
   *  for the life of the process (see `probeCodexVersion`). */
  readonly versionProbe?: (bin: string) => Promise<string | null>;
}

export function resolveCodexAppServerEnvironment(
  configured: Readonly<Record<string, string>> | undefined,
  inheritance: 'inherit' | 'replace',
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (inheritance === 'replace') return configured === undefined ? {} : { ...configured };
  return configured === undefined ? parent : { ...parent, ...configured };
}

interface ThreadState {
  alive: boolean;
  /** Exact model reported by the app-server at the top level of the
   * `thread/start` / `thread/resume` response. Requested config is not proof. */
  resolvedModelId?: string;
  /** Every provider-reported identity observed for this thread. The app-server
   * can reroute a model between turns (or during one), so this set is
   * deliberately thread-persistent and never replaced by the latest value. */
  readonly reportedModelIds: Set<string>;
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
  private versionChecked = false;

  constructor(options: CodexAppServerDriverOptions) {
    this.options = options;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /**
   * Runtime guard against codex-cli protocol drift (issue #152): the driver's
   * wire usage is pinned to the committed schema snapshot generated from
   * `SUPPORTED_CODEX_VERSION`, but the system `codex` binary upgrades
   * independently of this repo. This probes `codex --version` and WARNS —
   * never blocks — on a mismatch or a failed probe (binary missing /
   * unparsable output): patch-level drift is usually wire-compatible, and a
   * genuine protocol break already degrades into the existing stuck→alert
   * supervisor path, so there is nothing safer to do here than make the drift
   * observable. Fire-and-forget (never awaited) and idempotent per driver
   * instance (a second call is a no-op) — the caller (`buildMachineDriver` via
   * `service.ts`'s `makeMachineDriver`) invokes this ONCE at driver init, NOT
   * on every wake, so it never adds dispatch latency. Not wired into the
   * connect/constructor lifecycle on purpose, so constructing or connecting a
   * driver directly (as this file's own unit tests do) never spawns a real
   * `codex --version` process.
   */
  checkCodexVersion(): void {
    if (this.versionChecked) return;
    this.versionChecked = true;
    const bin = this.options.codexBin ?? 'codex';
    const probe = this.options.versionProbe ?? probeCodexVersion;
    void probe(bin).then(
      (installed) => {
        if (installed === null) {
          this.logger.warn('steward.codex_version_probe_failed', {
            bin,
            supportedVersion: SUPPORTED_CODEX_VERSION,
          });
          return;
        }
        if (installed !== SUPPORTED_CODEX_VERSION) {
          this.logger.warn('steward.codex_version_mismatch', {
            bin,
            installedVersion: installed,
            supportedVersion: SUPPORTED_CODEX_VERSION,
          });
        }
      },
      (err: unknown) => {
        this.logger.warn('steward.codex_version_probe_failed', {
          bin,
          supportedVersion: SUPPORTED_CODEX_VERSION,
          err: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }

  async ensureThread(opts: EnsureThreadOptions): Promise<{
    threadId: string;
    resumed: boolean;
    resolvedModelId?: string;
  }> {
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
      const result = (await client.request('thread/resume', resumeParams)) as {
        thread?: { id?: string };
        model?: string;
      };
      const threadId = result?.thread?.id ?? opts.threadId;
      const resolvedModelId = typeof result.model === 'string' && result.model.trim() !== ''
        ? result.model
        : undefined;
      this.threads.set(threadId, {
        alive: true,
        networkAccess: opts.networkAccess,
        reportedModelIds: new Set(resolvedModelId === undefined ? [] : [resolvedModelId]),
        ...(resolvedModelId !== undefined ? { resolvedModelId } : {}),
      });
      return { threadId, resumed: true, ...(resolvedModelId !== undefined ? { resolvedModelId } : {}) };
    }
    const startParams: Record<string, unknown> = {
      cwd: opts.cwd,
      approvalPolicy: 'never',
      sandbox,
      ephemeral: false,
    };
    if (opts.model !== undefined) startParams.model = opts.model;
    const result = (await client.request('thread/start', startParams)) as {
      thread?: { id?: string };
      model?: string;
    };
    const threadId = result?.thread?.id;
    if (!threadId) throw new MachineDriverProtocolError('thread/start response missing thread.id');
    const resolvedModelId = typeof result.model === 'string' && result.model.trim() !== ''
      ? result.model
      : undefined;
    this.threads.set(threadId, {
      alive: true,
      networkAccess: opts.networkAccess,
      reportedModelIds: new Set(resolvedModelId === undefined ? [] : [resolvedModelId]),
      ...(resolvedModelId !== undefined ? { resolvedModelId } : {}),
    });
    return { threadId, resumed: false, ...(resolvedModelId !== undefined ? { resolvedModelId } : {}) };
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
      env: resolveCodexAppServerEnvironment(
        this.options.env,
        this.options.envInheritance ?? 'inherit',
      ),
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
      case 'model/rerouted':
        this.onModelRerouted(params);
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
      ...(typeof (item as { command?: unknown }).command === 'string'
        ? { command: (item as { command: string }).command }
        : {}),
      ...(typeof (item as { aggregatedOutput?: unknown }).aggregatedOutput === 'string'
        ? { aggregatedOutput: (item as { aggregatedOutput: string }).aggregatedOutput }
        : {}),
      ...(typeof (item as { exitCode?: unknown }).exitCode === 'number'
        ? { exitCode: (item as { exitCode: number }).exitCode }
        : {}),
    });
  }

  private onModelRerouted(params: unknown): void {
    const p = params as {
      threadId?: string;
      turnId?: string;
      fromModel?: string;
      toModel?: string;
      reason?: string;
    };
    if (
      !p.threadId
      || !p.turnId
      || typeof p.reason !== 'string'
      || typeof p.fromModel !== 'string'
      || typeof p.toModel !== 'string'
    ) return;
    const state = this.threads.get(p.threadId);
    if (!state) return;
    for (const model of [p.fromModel, p.toModel]) {
      const normalized = model.trim();
      if (normalized !== '') state.reportedModelIds.add(normalized);
    }
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
        actualModelIds: this.actualModelIds(waiter.threadId),
      });
      return;
    }
    this.settleWaiter(waiter, {
      turnId: waiter.turnId || p.turn?.id || '',
      status: p.turn?.status ?? 'completed',
      agentMessage: waiter.agentMessage,
      durationMs,
      interrupted: false,
      actualModelIds: this.actualModelIds(waiter.threadId),
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
        actualModelIds: this.actualModelIds(waiter.threadId),
      });
    }, INTERRUPT_GRACE_MS);
  }

  private emit(threadId: string, event: DriverEvent): void {
    this.inflight.get(threadId)?.onEvent?.(event);
  }

  private markAlive(threadId: string): void {
    const state = this.threads.get(threadId);
    if (state) state.alive = true;
    else this.threads.set(threadId, { alive: true, reportedModelIds: new Set<string>() });
  }

  private actualModelIds(threadId: string): readonly string[] {
    return [...(this.threads.get(threadId)?.reportedModelIds ?? [])].sort();
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
