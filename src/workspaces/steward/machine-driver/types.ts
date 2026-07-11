/**
 * Public surface of the steward machine driver: the interface Alice's
 * dispatch layer (S3) will program against, plus the event / telemetry /
 * error shapes it observes. The concrete implementation is
 * `CodexAppServerDriver`; keeping the contract here lets later slices depend
 * on the interface without importing the codex-specific wiring.
 */

import type { Writable, Readable } from 'node:stream';

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
  ensureThread(opts: EnsureThreadOptions): Promise<{ threadId: string; resumed: boolean }>;
  runTurn(threadId: string, input: string, opts?: RunTurnOptions): Promise<TurnOutcome>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  /** true while a turn is in flight OR the thread is known and its process is alive. */
  isThreadLive(threadId: string): boolean;
  /** Latest `thread/tokenUsage/updated` snapshot for the thread, if any. */
  readTelemetry(threadId: string): ThreadTelemetry | null;
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
