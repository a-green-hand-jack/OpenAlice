/**
 * `ClaudeAgentSdkDriver` — drives the `@anthropic-ai/claude-agent-sdk` `query()`
 * API for unattended steward wakes on claude-agent workspaces (issue #146 S5).
 *
 * PROCESS MODEL vs. codex. There is NO persistent daemon. Each `runTurn` is one
 * `query()` invocation that spawns the SDK's bundled Claude Code CLI, streams to
 * completion, and exits. Session continuity is the SDK's own resume: the claude
 * session id IS the thread id. `ensureThread` pins that id up front via
 * `Options.sessionId` (a fresh UUID) so the dispatch layer knows the wake's
 * `sessionId = threadId` BEFORE the first turn ever runs — no handshake turn is
 * needed (verified: `Options.sessionId` accepts a caller-supplied UUID for a new
 * session; `Options.resume` continues an existing one).
 *
 * LIVENESS. Because there is no daemon, "the thread is live" means only "a turn
 * is in flight" (a `query()` generator is being iterated). A completed turn that
 * wrote no ledger therefore goes `stuck` PROMPTLY on the next supervisor tick —
 * which is acceptable and strictly faster than codex's process-alive liveness:
 * the supervisor checks the ledger BEFORE liveness, so a NORMAL completion (the
 * validator ran inside the turn and wrote the ledger) still terminalizes
 * cleanly. Every settle — completion, interrupt, fatal — clears the in-flight
 * entry, which for this driver IS the alive flag, so S4's "fatal clears alive"
 * semantic holds here by construction.
 *
 * PERMISSIONS. Unattended turns reuse the PTY adapter's `AUTOTRUST_SETTINGS`
 * (pre-approves `Bash(alice* *)`, `Write`, `Edit`) via `Options.settings`, plus
 * `permissionMode: 'dontAsk'` — deny-if-not-pre-approved, the parity of codex's
 * `approvalPolicy: 'never'`. `bypassPermissions` is deliberately NOT used (it is
 * broader than the established trust surface). Filesystem `settingSources` are
 * left at the SDK default (all sources), so the workspace
 * `.claude/settings.local.json` (vault-injected credentials + model) applies
 * exactly as a PTY spawn.
 */

import { randomUUID } from 'node:crypto';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { ModelUsage, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { AUTOTRUST_SETTINGS_OBJECT } from '../../adapters/claude.js';
import type { Logger } from '../../logger.js';
import { NOOP_LOGGER } from './jsonrpc-stdio.js';
import {
  MachineDriverProtocolError,
  type DriverEvent,
  type EnsureThreadOptions,
  type RunTurnOptions,
  type StewardMachineDriver,
  type ThreadTelemetry,
  type TurnOutcome,
} from './types.js';

/** The `@anthropic-ai/claude-agent-sdk` version this driver is written against
 *  (issue #146 S5 review minor) — the parity of the codex driver's
 *  `SUPPORTED_CODEX_VERSION` pin. `claude-agent-sdk-driver.spec.ts` asserts this
 *  equals the installed package's `package.json` version, so a silent SDK bump
 *  (which can change `Options`/`SDKMessage` shapes this driver hand-maps) fails
 *  CI instead of drifting unnoticed. */
export const SUPPORTED_CLAUDE_AGENT_SDK_VERSION = '0.3.206';

/** The `Options.effort` values the SDK accepts; a `RunTurnOptions.effort` outside
 *  this set is dropped rather than forwarded (an unknown effort would be
 *  rejected by the CLI). */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Test seam mirroring the codex driver's `spawn` seam: inject a fake `query`
 * implementation so specs never spawn a real claude (CI has no claude login).
 * The real `@anthropic-ai/claude-agent-sdk` `query` is structurally assignable
 * to this (its `Query` return extends `AsyncGenerator<SDKMessage, void>`).
 */
export type ClaudeQueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeAgentSdkDriverOptions {
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly logger?: Logger;
  /** Test seam: replace the SDK `query`. Production leaves this undefined. */
  readonly queryFn?: ClaudeQueryFn;
}

interface ClaudeThreadState {
  /** A turn has completed on this thread IN THIS PROCESS, so the session exists
   *  on disk and the NEXT turn must `resume` it rather than re-pin `sessionId`. */
  hasRun: boolean;
  /** `ensureThread` was called with a prior-process thread id — every turn on it
   *  resumes (the session already exists on disk from a previous Alice run). */
  readonly resumedFromStore: boolean;
  /** Model captured at `ensureThread`, applied to each turn's query. */
  readonly model?: string;
}

interface ClaudeInFlightTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly abort: AbortController;
  started: boolean;
  interrupted: boolean;
  agentMessage: string | null;
  durationMs: number | null;
  status: string;
  /** Set when the turn's `result` message reported an error subtype; surfaced as
   *  a rejected `runTurn` (fatal) once the stream ends. */
  resultError: string | null;
  readonly onEvent: ((ev: DriverEvent) => void) | undefined;
}

export class ClaudeAgentSdkDriver implements StewardMachineDriver {
  private readonly cwd: string;
  /**
   * Deliberately `undefined`, not `{}`, when the caller supplies no env (issue
   * #146 S5 review MAJOR-1). `undefined` means "omit `Options.env`, let the SDK
   * inherit `process.env` itself" (direct-driver/dev usage with no composed
   * env); `{}` would instead pass an explicit EMPTY env to the SDK, which is a
   * different — broken — thing (no PATH, no HOME, no credentials).
   */
  private readonly env: Record<string, string> | undefined;
  private readonly logger: Logger;
  private readonly queryFn: ClaudeQueryFn;
  private readonly threads = new Map<string, ClaudeThreadState>();
  private readonly telemetry = new Map<string, ThreadTelemetry>();
  private readonly inflight = new Map<string, ClaudeInFlightTurn>();
  private disposed = false;

  constructor(options: ClaudeAgentSdkDriverOptions) {
    this.cwd = options.cwd;
    this.env = options.env;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.queryFn = options.queryFn ?? ((params) => sdkQuery(params));
  }

  async ensureThread(opts: EnsureThreadOptions): Promise<{ threadId: string; resumed: boolean }> {
    if (this.disposed) throw new MachineDriverProtocolError('driver disposed');
    // No daemon and no round-trip: pinning the id is pure bookkeeping. A fresh
    // thread mints a UUID (pinned via `Options.sessionId` on its first turn); a
    // resume reuses the stored id (continued via `Options.resume`).
    if (opts.threadId) {
      this.threads.set(opts.threadId, {
        hasRun: false,
        resumedFromStore: true,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      });
      return { threadId: opts.threadId, resumed: true };
    }
    const threadId = randomUUID();
    this.threads.set(threadId, {
      hasRun: false,
      resumedFromStore: false,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
    return { threadId, resumed: false };
  }

  async runTurn(threadId: string, input: string, opts: RunTurnOptions = {}): Promise<TurnOutcome> {
    if (this.disposed) throw new MachineDriverProtocolError('driver disposed');
    const state = this.threads.get(threadId);
    if (!state) throw new MachineDriverProtocolError(`unknown thread ${threadId}; ensureThread first`);
    // One-turn-per-thread invariant, mirroring the codex driver.
    if (this.inflight.has(threadId)) {
      throw new MachineDriverProtocolError(`a turn is already in flight for thread ${threadId}`);
    }

    const abort = new AbortController();
    const turn: ClaudeInFlightTurn = {
      threadId,
      turnId: randomUUID(),
      abort,
      started: false,
      interrupted: false,
      agentMessage: null,
      durationMs: null,
      status: 'completed',
      resultError: null,
      onEvent: opts.onEvent,
    };
    this.inflight.set(threadId, turn);

    // A fresh thread's FIRST turn pins the caller-supplied id via `sessionId`;
    // every subsequent turn (and every resumed-from-store thread) continues via
    // `resume`. `sessionId` cannot combine with `resume`, so this is either/or.
    const useResume = state.resumedFromStore || state.hasRun;
    const model = opts.model ?? state.model;
    const effort = opts.effort !== undefined && EFFORT_LEVELS.has(opts.effort) ? opts.effort : undefined;
    const options: Options = {
      cwd: this.cwd,
      // `Options.env` REPLACES the subprocess env entirely — and the driver's
      // `this.env` (when supplied) is ALREADY a complete, composed env
      // (`composeSpawnInputs` -> `buildSpawnEnv`): PATH rebuilt, HOME/creds
      // present, and Alice-internal secrets (OPENALICE_UTA_INTERNAL_TOKEN,
      // OPENALICE_INTERNAL_EVENT_TOKEN, OPENALICE_EVENT_INGEST_TOKEN, …)
      // DELETED, not merely emptied, by `buildSpawnEnv`'s strip list — the
      // unattended machine-face claude child must not hold Alice's own broker
      // auth token; that would bypass the alice*/tool-gateway boundary the
      // credential vault + BFF proxy exist to enforce (issue #146 S5 review
      // MAJOR-1). Spreading raw `process.env` underneath would resurrect
      // exactly those stripped keys, so pass the provided env EXACTLY —
      // no merge. When no env is supplied at all (direct-driver/dev usage with
      // no composed env), OMIT the option entirely rather than defaulting to
      // `{}`: an explicit empty env is a broken env (no PATH/HOME), whereas
      // omitting the key lets the SDK apply its own `{...process.env}` default
      // (verified against the bundled `sdk.mjs`: `Options.env` is destructured
      // with a `{...process.env}` default, which JS applies whenever the value
      // is `undefined` — identical whether the key is absent or explicitly
      // `env: undefined`).
      ...(this.env !== undefined ? { env: this.env } : {}),
      abortController: abort,
      permissionMode: 'dontAsk',
      settings: AUTOTRUST_SETTINGS_OBJECT,
      ...(useResume ? { resume: threadId } : { sessionId: threadId }),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort: effort as Options['effort'] } : {}),
    };

    let deadlineTimer: NodeJS.Timeout | null = null;
    if (opts.deadlineMs !== undefined && opts.deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        turn.interrupted = true;
        abort.abort();
      }, opts.deadlineMs);
    }

    try {
      for await (const message of this.queryFn({ prompt: input, options })) {
        if (!turn.started) {
          turn.started = true;
          turn.onEvent?.({ type: 'turn-started', threadId, turnId: turn.turnId });
        }
        this.handleMessage(turn, message);
      }
      state.hasRun = true;
      if (turn.interrupted) return this.interruptedOutcome(turn);
      if (turn.resultError !== null) {
        throw new MachineDriverProtocolError(`claude turn failed: ${turn.resultError}`);
      }
      return {
        turnId: turn.turnId,
        status: turn.status,
        agentMessage: turn.agentMessage,
        durationMs: turn.durationMs,
        interrupted: false,
      };
    } catch (err) {
      // A dispose mid-turn is fatal (reject); a deadline/interruptInFlight abort
      // resolves `interrupted`. The abort surfaces here as a thrown AbortError OR
      // as a clean stream end (handled above) — both routes honor `interrupted`.
      if (this.disposed) throw new MachineDriverProtocolError('driver disposed', { cause: err });
      if (turn.interrupted) {
        // Defensive (issue #146 S5 review): a FIRST turn interrupted via a
        // thrown AbortError (rather than the SDK ending its stream cleanly)
        // never reaches the `state.hasRun = true` assignment above, but the
        // claude CLI may already have created + written the on-disk session
        // before the abort landed. Mark it run regardless, so the NEXT turn on
        // this thread correctly uses `resume` instead of re-pinning `sessionId`
        // (which the SDK would reject once the session file already exists).
        state.hasRun = true;
        return this.interruptedOutcome(turn);
      }
      throw err instanceof MachineDriverProtocolError
        ? err
        : new MachineDriverProtocolError(`claude query failed: ${errText(err)}`, { cause: err });
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      // The in-flight entry IS this driver's alive flag — clearing it on EVERY
      // settle path is what makes a completed/interrupted/failed turn report
      // not-live to the supervisor.
      this.inflight.delete(threadId);
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const turn = this.inflight.get(threadId);
    if (!turn || (turnId && turn.turnId !== turnId)) return;
    turn.interrupted = true;
    turn.abort.abort();
  }

  async interruptInFlight(threadId: string): Promise<void> {
    const turn = this.inflight.get(threadId);
    if (!turn) return;
    turn.interrupted = true;
    turn.abort.abort();
  }

  isThreadLive(threadId: string): boolean {
    return !this.disposed && this.inflight.has(threadId);
  }

  isHealthy(): boolean {
    // No persistent daemon to lose — a claude driver is unusable only once
    // disposed (issue #146 S5, item 2).
    return !this.disposed;
  }

  readTelemetry(threadId: string): ThreadTelemetry | null {
    return this.telemetry.get(threadId) ?? null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Abort every in-flight turn WITHOUT marking `interrupted`, so each rejects
    // with `driver disposed` (fatal) rather than resolving `interrupted`.
    for (const turn of this.inflight.values()) turn.abort.abort();
  }

  // --- message handling ---------------------------------------------------

  private handleMessage(turn: ClaudeInFlightTurn, message: SDKMessage): void {
    if (message.type !== 'result') return;
    turn.durationMs = typeof message.duration_ms === 'number' ? message.duration_ms : turn.durationMs;
    const telemetry = telemetryFromModelUsage(message.modelUsage);
    if (telemetry) {
      this.telemetry.set(turn.threadId, telemetry);
      turn.onEvent?.({ type: 'token-usage', threadId: turn.threadId, turnId: turn.turnId, telemetry });
    }
    if (message.subtype === 'success') {
      turn.status = 'completed';
      if (typeof message.result === 'string') turn.agentMessage = message.result;
      return;
    }
    // Any error subtype (error_during_execution / error_max_turns / …) is a fatal
    // turn error — surfaced as a rejected `runTurn`, clearing liveness (matching
    // the codex non-retryable-error settle).
    turn.status = message.subtype;
    turn.resultError = message.errors.length > 0 ? message.errors.join('; ') : message.subtype;
  }

  private interruptedOutcome(turn: ClaudeInFlightTurn): TurnOutcome {
    return {
      turnId: turn.turnId,
      status: 'interrupted',
      agentMessage: turn.agentMessage,
      durationMs: turn.durationMs,
      interrupted: true,
    };
  }
}

/**
 * Aggregate the SDK result's per-model usage into a `ThreadTelemetry` snapshot.
 * `inputTokens` is the full prompt size (uncached input + cache reads + cache
 * creation) so it mirrors codex's cumulative `inputTokens` as a context-fill
 * proxy for rotation; `cachedInputTokens` is the cache-read subset.
 * `contextWindow` comes straight from the SDK (`ModelUsage.contextWindow`) — the
 * claude face DOES expose it, so rotation gets a real window (not null). Returns
 * null when the result carried no model usage (⇒ no telemetry ⇒ never rotate).
 */
function telemetryFromModelUsage(modelUsage: Record<string, ModelUsage> | undefined): ThreadTelemetry | null {
  if (!modelUsage) return null;
  const models = Object.values(modelUsage);
  if (models.length === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let contextWindow = 0;
  for (const u of models) {
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    cacheRead += u.cacheReadInputTokens;
    cacheCreation += u.cacheCreationInputTokens;
    contextWindow = Math.max(contextWindow, u.contextWindow);
  }
  const promptTokens = inputTokens + cacheRead + cacheCreation;
  return {
    totalTokens: promptTokens + outputTokens,
    inputTokens: promptTokens,
    cachedInputTokens: cacheRead,
    outputTokens,
    contextWindow: contextWindow > 0 ? contextWindow : null,
    updatedAt: new Date().toISOString(),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
