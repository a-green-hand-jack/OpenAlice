/**
 * Public surface of the steward machine driver: the interface Alice's
 * dispatch layer (S3) will program against, plus the event / telemetry /
 * error shapes it observes. The concrete implementation is
 * `CodexAppServerDriver`; keeping the contract here lets later slices depend
 * on the interface without importing the codex-specific wiring.
 */

import type { Writable, Readable } from 'node:stream';

import { z } from 'zod';

/** codex app-server sandbox modes (mirrors the `SandboxMode` schema enum). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** JSON-RPC request/response id. codex uses integer ids; strings are tolerated. */
export type JsonRpcId = string | number;

export interface EnsureThreadOptions {
  /** Resume this thread when set; otherwise a fresh thread is started. */
  readonly threadId?: string;
  readonly cwd: string;
  readonly model?: string;
  /** Reasoning effort is applied per-turn, not at thread creation; carried
   *  here only so callers can thread one config object through. */
  readonly effort?: string;
  readonly sandbox?: SandboxMode;
  /**
   * Request a network-enabled `workspace-write` sandbox for this thread (issue
   * #146 S3 review MAJOR-1). Mirrors the PTY codex adapter's unconditional
   * `-c sandbox_workspace_write.network_access=true` (`adapters/codex.ts`
   * `codexMcpHead`), which exists so `alice*` can reach the loopback CLI
   * gateway. app-server's protocol has NO thread-level field for this — the
   * `sandbox` field above is a coarse `SandboxMode` string enum whose
   * `workspace-write` variant defaults `networkAccess:false` (verified against
   * the S0-captured `thread/start` result, `fixtures/transcripts/single-turn
   * .jsonl`: `"sandbox":{"type":"workspaceWrite",...,"networkAccess":false}`).
   * The only schema-verified mechanism is `TurnStartParams.sandboxPolicy` (a
   * `SandboxPolicy` discriminated union whose `workspaceWrite` variant has a
   * `networkAccess` boolean — see `fixtures/schema/ClientRequest.json`),
   * documented as "Override the sandbox policy for this turn and subsequent
   * turns" — so the driver applies it once here and the app-server carries it
   * forward. The undocumented `config` passthrough field on `thread/start` /
   * `thread/resume` (`additionalProperties:true`, no schema description, no
   * fixture evidence of accepted keys) was considered and rejected — using an
   * unverified blob risks a silent no-op (the exact bug this fixes) or a
   * protocol rejection, whereas `sandboxPolicy` is fully typed and schema-
   * pinned (`protocol-contract.spec.ts` guards its shape).
   */
  readonly networkAccess?: boolean;
}

/**
 * The `turn/start` `sandboxPolicy` payload this driver sends when a thread
 * requested `networkAccess` (issue #146 MAJOR-1). Mirrors the app-server's
 * `WorkspaceWriteSandboxPolicy` schema variant — deliberately minimal: only the
 * fields this driver ever overrides. The remaining `WorkspaceWriteSandboxPolicy`
 * fields (`writableRoots`, `excludeTmpdirEnvVar`, `excludeSlashTmp`) keep the
 * server's documented defaults when omitted.
 */
export interface WorkspaceWriteSandboxPolicyOverride {
  readonly type: 'workspaceWrite';
  readonly networkAccess: boolean;
}

export interface RunTurnOptions {
  /** Interrupt the turn if it has not settled within this many ms. */
  readonly deadlineMs?: number;
  readonly effort?: string;
  readonly model?: string;
  readonly onEvent?: (ev: DriverEvent) => void;
}

export interface TurnOutcome {
  readonly turnId: string;
  /** codex turn status (`completed`, `failed`, …) or `interrupted` when the
   *  deadline fired. */
  readonly status: string;
  readonly agentMessage: string | null;
  readonly durationMs: number | null;
  readonly interrupted: boolean;
  /** Provider-reported model identities observed while executing this turn.
   * Callers with a frozen exact-model contract must reject a missing, extra,
   * aliased, or fallback identity rather than trusting the requested model. */
  readonly actualModelIds?: readonly string[];
  /** Direct main-loop assistant identities, when the provider exposes them.
   * Claude supplies this from assistant frames only; it deliberately excludes
   * init, fallback, usage-table, and subagent identities. */
  readonly primaryModelIds?: readonly string[];
  /** Complete primary-role guard identities. Claude includes the init model,
   * direct main-loop assistant models, and structured refusal original/fallback
   * models so callers can reject a primary-role substitution. */
  readonly primaryRoleGuardModelIds?: readonly string[];
  /** Exact provider per-model usage entries, when exposed by the driver. */
  readonly modelUsage?: readonly ProviderModelUsage[];
}

/** Lossless common representation of a provider's per-model usage record. */
export interface ProviderModelUsage {
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly webSearchRequests: number;
  readonly costUSD: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export interface ThreadTelemetry {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly contextWindow?: number | null;
  readonly updatedAt: string;
}

/**
 * Structured events surfaced through `RunTurnOptions.onEvent` as the turn
 * runs. Discriminated on `type`.
 */
export type DriverEvent =
  | { readonly type: 'turn-started'; readonly threadId: string; readonly turnId: string }
  | {
      readonly type: 'item-completed';
      readonly threadId: string;
      readonly turnId: string;
      readonly itemType: string;
      readonly text: string | null;
      readonly command?: string;
      readonly aggregatedOutput?: string;
      readonly exitCode?: number;
    }
  | {
      readonly type: 'token-usage';
      readonly threadId: string;
      readonly turnId: string;
      readonly telemetry: ThreadTelemetry;
    }
  | {
      readonly type: 'error-notification';
      readonly threadId: string;
      readonly turnId: string;
      readonly message: string;
      readonly willRetry: boolean;
    }
  | { readonly type: 'server-request-denied'; readonly requestId: JsonRpcId; readonly method: string };

export interface StewardMachineDriver {
  ensureThread(opts: EnsureThreadOptions): Promise<{
    threadId: string;
    resumed: boolean;
    resolvedModelId?: string;
  }>;
  runTurn(threadId: string, input: string, opts?: RunTurnOptions): Promise<TurnOutcome>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  /** true while a turn is in flight OR the thread is known and its process is alive. */
  isThreadLive(threadId: string): boolean;
  /** Latest `thread/tokenUsage/updated` snapshot for the thread, if any. */
  readTelemetry(threadId: string): ThreadTelemetry | null;
  /**
   * Whether this driver is still usable for a NEW acquire (issue #146 S5, item
   * 2). The registry evicts + recreates a driver that reports unhealthy so a
   * wake never reuses a dead client. Codex: the stdio transport is alive and the
   * driver is not disposed/closed. Claude: not disposed (no persistent daemon —
   * each turn spawns a fresh SDK query, so "unhealthy" only means disposed).
   */
  isHealthy(): boolean;
  /**
   * Interrupt whatever turn is currently in flight on `threadId`, settling it as
   * `interrupted` (issue #146 S5, item 3). No-op when nothing is in flight. Used
   * by the dispatch gate-timeout path to abort an orphan turn that was started
   * (`turn/start` accepted) but whose start signal never arrived, so it does not
   * keep running unowned. Codex interrupts via the tracked turnId; claude aborts
   * the turn's `AbortController`.
   */
  interruptInFlight(threadId: string): Promise<void>;
  /** Kill the child process and reject any pending work. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * The subset of a spawned child process the driver needs. A ChildProcess is
 * structurally assignable; tests inject a PassThrough-backed fake instead of
 * spawning a real `codex app-server` (CI has no codex login).
 */
export interface MachineTransport {
  readonly stdin: Writable;
  readonly stdout: Readable;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill?(signal?: NodeJS.Signals): boolean;
}

/** A protocol-level failure: bad handshake, a `turn/start` rejection, a
 *  non-retryable `error` notification, or the app-server exiting mid-turn. */
export class MachineDriverProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MachineDriverProtocolError';
  }
}

// --- Persisted control-face thread state (issue #146) -------------------
//
// One record per workspace at `.alice/steward/machine-thread.json`
// (`MachineThreadStore`). It carries just enough to RESUME the same native
// thread on the next wake — the provider + thread id (S0 proved resume needs
// only the id), the model the thread was started with, and coarse timestamps.
// Read lenient: a missing OR corrupt file is always a valid state (absence =
// "no thread yet"), so nothing here can break a workspace that has never run a
// machine wake. NOT `data/config/` state, so no migration framework applies.
export const MACHINE_THREAD_SCHEMA_VERSION = 1;

/** The native providers a steward machine thread can be pinned to (issue #146
 *  S5 adds `claude` alongside the original `codex`). */
export type MachineThreadProvider = 'codex' | 'claude';

export const machineThreadStateSchema = z.object({
  version: z.literal(MACHINE_THREAD_SCHEMA_VERSION),
  provider: z.enum(['codex', 'claude']),
  threadId: z.string().min(1),
  model: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  // ISO of the last turn that ran on this thread, or null when the thread was
  // created but has not yet taken a turn.
  lastTurnAt: z.string().min(1).nullable(),
  // The account this thread was last dispatched for (issue #155). Optional:
  // absence means a LEGACY (pre-#155) record, which `dispatchMachineWake`
  // treats as adoptable, not a mismatch — see `resolveStoredForAccount` in
  // `dispatch.ts`. A present value that differs from a later wake's
  // `envelope.accountId` is a cross-account resume risk; that wake starts a
  // fresh thread instead of resuming this record.
  accountId: z.string().min(1).optional(),
}).passthrough();
export type MachineThreadState = z.infer<typeof machineThreadStateSchema>;

export function parseMachineThreadState(value: unknown): MachineThreadState {
  return machineThreadStateSchema.parse(value);
}

/**
 * Raised when a turn overruns its `deadlineMs`. NOTE: the driver's chosen
 * semantic is to NOT throw this on a normal deadline — it interrupts the turn
 * and resolves `TurnOutcome{ interrupted: true, status: 'interrupted' }`. This
 * class is exported for callers that want to model a deadline as an error
 * (e.g. wrap an interrupted outcome), keeping a single consistent runtime path.
 */
export class TurnDeadlineExceededError extends Error {
  readonly threadId: string;
  readonly turnId: string;
  readonly deadlineMs: number;
  constructor(threadId: string, turnId: string, deadlineMs: number) {
    super(`turn ${turnId} on thread ${threadId} exceeded deadline of ${deadlineMs}ms`);
    this.name = 'TurnDeadlineExceededError';
    this.threadId = threadId;
    this.turnId = turnId;
    this.deadlineMs = deadlineMs;
  }
}
