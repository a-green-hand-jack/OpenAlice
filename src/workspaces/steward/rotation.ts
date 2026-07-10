/**
 * Threshold-triggered steward session rotation (issue #132).
 *
 * The steward runs ONE persistent codex PTY session; wakes are injected into it
 * over many hours. A single degenerate model turn can permanently poison that
 * session — the next wake opens with `input_tokens` already past the model's
 * context window and every turn times out at output-token speed. OpenAlice owns
 * no between-wake context governance to catch this.
 *
 * This module reads the running session's context telemetry BEFORE a wake is
 * injected and decides whether to rotate: dispose the poisoned session and
 * spawn a fresh one. Continuity is NOT carried over conversationally — the
 * steward's Wake Loop re-reads config/manifest/ledger-tail from workspace files
 * every wake (behavior contract), so a fresh session rebuilds its world from
 * disk. Rotation is codex-scoped for now (the failing adapter); the decision
 * runs through the optional `CliAdapter.readContextTelemetry` seam so another
 * adapter can opt in later without new machinery here.
 *
 * The dispose+spawn itself stays in each wake-dispatch caller (the HTTP route
 * and the scheduled path have their own spawn helpers); this module owns the
 * telemetry read, the decision, and the observable `session_rotated` event.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CliAdapter, ContextTelemetry } from '../cli-adapter.js';
import { stewardSupervisorLogPath } from './paths.js';

/** Default rotation trigger: rotate once the running session's input tokens
 *  reach ~65% of the model context window, leaving headroom for the wake turn
 *  itself before the hard limit. Overridable per workspace. */
export const DEFAULT_ROTATION_THRESHOLD = 0.65;

export type StewardRotationReason =
  | 'window_exceeded'
  | 'over_threshold'
  | 'under_threshold'
  | 'telemetry_unavailable';

export interface StewardRotationDecision {
  readonly rotate: boolean;
  readonly reason: StewardRotationReason;
  readonly telemetry: ContextTelemetry | null;
  readonly threshold: number;
}

/**
 * Read the rotation threshold from a workspace's `.alice/steward/config.json`
 * (`sessionRotation.threshold`, a fraction in (0, 1]). Falls back to
 * {@link DEFAULT_ROTATION_THRESHOLD} for any missing/out-of-range value.
 */
export function resolveRotationThreshold(config: Record<string, unknown>): number {
  const raw = config['sessionRotation'];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const t = (raw as Record<string, unknown>)['threshold'];
    if (typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= 1) return t;
  }
  return DEFAULT_ROTATION_THRESHOLD;
}

/**
 * Pure decision: rotate when telemetry says the window is already exceeded, or
 * when input tokens have crossed `threshold × window`. Null telemetry ⇒ do NOT
 * rotate (unknown is never a reason to disrupt a running session).
 */
export function decideStewardRotation(
  telemetry: ContextTelemetry | null,
  threshold: number,
): StewardRotationDecision {
  if (!telemetry) {
    return { rotate: false, reason: 'telemetry_unavailable', telemetry: null, threshold };
  }
  const { inputTokens, modelContextWindow } = telemetry;
  if (modelContextWindow > 0 && inputTokens >= modelContextWindow) {
    return { rotate: true, reason: 'window_exceeded', telemetry, threshold };
  }
  if (modelContextWindow > 0 && inputTokens >= modelContextWindow * threshold) {
    return { rotate: true, reason: 'over_threshold', telemetry, threshold };
  }
  return { rotate: false, reason: 'under_threshold', telemetry, threshold };
}

export interface EvaluateStewardRotationInput {
  readonly adapter: Pick<CliAdapter, 'id' | 'readContextTelemetry'>;
  readonly cwd: string;
  readonly sessionId: string;
  readonly config: Record<string, unknown>;
  /**
   * Warn sink for a degraded telemetry read (isolation: reuse, don't block).
   * Fires both when the adapter's read throws AND when it resolves to `null`
   * for a session the caller IS tracking (PR #133 review, issue #132) —
   * either way the rotation/attribution signal silently went dark for this
   * session, which is worth surfacing even though it's never fatal. Does NOT
   * fire when the adapter has no `readContextTelemetry` at all (a known,
   * expected omission — e.g. claude — not a degraded read).
   */
  readonly onWarn?: (message: string, detail: Record<string, unknown>) => void;
}

/**
 * Read the running session's telemetry via the adapter and decide. Failure
 * isolation: an adapter without `readContextTelemetry`, a read that throws, or
 * a read that resolves to `null` (rollout not found/unreadable) all yield a
 * `telemetry_unavailable` no-rotate decision — a wake is never blocked on
 * telemetry. The latter two additionally warn via `onWarn` so silent
 * disablement for a session that IS being tracked stays observable.
 */
export async function evaluateStewardRotation(
  input: EvaluateStewardRotationInput,
): Promise<StewardRotationDecision> {
  const threshold = resolveRotationThreshold(input.config);
  if (!input.adapter.readContextTelemetry) {
    return { rotate: false, reason: 'telemetry_unavailable', telemetry: null, threshold };
  }
  let telemetry: ContextTelemetry | null = null;
  try {
    telemetry = await input.adapter.readContextTelemetry(input.cwd, input.sessionId);
  } catch (err) {
    input.onWarn?.('steward.rotation_telemetry_failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { rotate: false, reason: 'telemetry_unavailable', telemetry: null, threshold };
  }
  if (!telemetry) {
    input.onWarn?.('steward.rotation_telemetry_unavailable', {
      sessionId: input.sessionId,
      cwd: input.cwd,
    });
  }
  return decideStewardRotation(telemetry, threshold);
}

export interface StewardRotationEvent {
  readonly at: string;
  readonly wsId: string;
  readonly disposedSessionId: string;
  readonly newSessionId: string;
  readonly reason: StewardRotationReason;
  readonly inputTokens: number | null;
  readonly modelContextWindow: number | null;
  readonly threshold: number;
}

/**
 * Append a `session_rotated` event to the workspace's supervisor log — the same
 * `.alice/steward/supervisor.jsonl` campaign reports already parse — so
 * rotations are countable alongside wake outcomes.
 */
export async function recordStewardRotation(
  workspaceDir: string,
  event: StewardRotationEvent,
): Promise<void> {
  const path = stewardSupervisorLogPath(workspaceDir);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ type: 'session_rotated', ...event })}\n`, 'utf8');
}
