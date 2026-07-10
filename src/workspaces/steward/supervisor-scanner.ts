/**
 * StewardSupervisorScanner - the self-arming timer that makes
 * `StewardSupervisor.tick()` actually run in real (non-harness) use.
 *
 * Before this, `tick()` was reachable ONLY via `POST /:id/steward/supervisor/
 * tick` (`src/webui/routes/workspaces.ts`) - nothing in the running process
 * called it on its own. A hung/stuck wake's per-account lock (StewardLockStore)
 * would never release and cost tracking would go stale unless something
 * external polled the route (only `tools/campaigns/run-cell.mjs` does, and
 * only during backtests). This scanner closes that gap the same way
 * `ScheduleScanner` (`../schedule/scanner.ts`) closes the equivalent one for
 * scheduled issues: a plain `setTimeout` + `.unref()` self-rearm loop, with
 * overlap protection so two sweeps never run concurrently.
 *
 * Each tick enumerates every workspace, keeps only `template === 'steward'`
 * ones (the signal `WorkspaceMeta.template` already uses elsewhere to mean
 * "spawned from the steward template"), and runs the SAME tick-runner
 * (`runStewardSupervisorTick`) the manual HTTP route uses - the two callers
 * share this function precisely so their behavior (config read, the tick
 * itself, and the proactive stuck-wake Inbox push) can't drift apart. Errors
 * ticking one workspace are caught and logged so they never stop the sweep
 * over the rest.
 */

import type { ContextTelemetry } from '../cli-adapter.js';
import type { IInboxStore } from '../../core/inbox-store.js';
import type { Logger } from '../logger.js';
import type { WorkspaceMeta, WorkspaceRegistry } from '../workspace-registry.js';

import { readStewardConfig } from './config.js';
import { createStewardSupervisor, type StewardSupervisorTickResult } from './supervisor.js';
import { createStewardWakeStore } from './wake-store.js';

/** Cheap local-file operation, no LLM/network calls - can tick much faster
 *  than the schedule scanner's 60s without meaningful cost. */
export const DEFAULT_INTERVAL_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface StewardSupervisorTickDeps {
  /** Already-read `.alice/steward/config.json` contents (see
   *  `readStewardConfig`) - callers read it themselves so they can map a
   *  read/parse failure to their own error surface (HTTP 500 vs a logged
   *  skip). */
  readonly config: Record<string, unknown>;
  readonly isSessionRunning: (sessionId: string) => boolean;
  /** Best-effort context telemetry reader for timeout attribution (issue
   *  #132). Forwarded straight to `StewardSupervisor.tick`; optional so callers
   *  without an adapter wired just skip attribution. */
  readonly readContextTelemetry?: (sessionId: string) => Promise<ContextTelemetry | null>;
  /** Push surface for the "wake went stuck" proactive notification. Optional
   *  so callers without an Inbox wired (tests, satellite embedders) just skip
   *  the push. */
  readonly inboxStore?: IInboxStore;
  readonly logger: Logger;
  /** ISO timestamp override for tests / a caller with its own clock. Defaults
   *  to `new Date().toISOString()` inside `StewardSupervisor.tick()`. */
  readonly now?: string;
}

/**
 * Runs one `StewardSupervisor.tick()` for `meta` and, for any wake that just
 * transitioned to `stuck`, pushes an Inbox comment. This is the shared core
 * behind BOTH `POST /:id/steward/supervisor/tick` and
 * `StewardSupervisorScanner`'s own timer - pulled out so the two callers
 * can't independently drift on what a tick actually does.
 */
export async function runStewardSupervisorTick(
  meta: Pick<WorkspaceMeta, 'id' | 'dir'>,
  deps: StewardSupervisorTickDeps,
): Promise<StewardSupervisorTickResult> {
  const supervisor = createStewardSupervisor(meta.dir);
  const result = await supervisor.tick({
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    isSessionRunning: deps.isSessionRunning,
    ...(deps.readContextTelemetry ? { readContextTelemetry: deps.readContextTelemetry } : {}),
    config: {
      monthlyBudget: asRecord(deps.config['monthlyBudget']),
      costPolicy: asRecord(deps.config['costPolicy']),
    },
  });

  // Proactive push: a wake going `stuck` (session not running / repeated
  // respawn) is exactly the kind of event a human should be notified about
  // rather than having to poll GET /:id/steward/wakes/:wakeId or read the
  // supervisor log file. Every other transition (done/blocked/error/
  // timeout) stays log-only - narrower scope per the plan (docs/
  // steward-persistent-loop-implementation.zh.md §7).
  const stuckTransitions = result.transitions.filter((t) => t.to === 'stuck');
  if (stuckTransitions.length > 0 && deps.inboxStore) {
    const wakeStore = createStewardWakeStore(meta.dir);
    for (const t of stuckTransitions) {
      const wake = await wakeStore.get(t.wakeId).catch(() => null);
      const detail = wake?.error ?? t.reason;
      try {
        await deps.inboxStore.append({
          workspaceId: meta.id,
          comments: `Steward wake \`${t.wakeId}\` is stuck: ${detail}.`,
        });
      } catch (err) {
        deps.logger.error('steward supervisor: inbox push for stuck wake failed', {
          workspaceId: meta.id,
          wakeId: t.wakeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

/** Structural slice of SessionPool the scanner needs (liveness check only) -
 *  avoids importing the concrete pool type just to ask "is this session
 *  alive". Mirrors `MarkerStore` in `../schedule/scanner.ts`. */
export interface SessionPoolLike {
  get(sessionId: string): unknown;
}

export interface StewardSupervisorScannerDeps {
  readonly registry: WorkspaceRegistry;
  readonly pool: SessionPoolLike;
  /** Optional Inbox push surface - forwarded to `runStewardSupervisorTick`. */
  readonly inboxStore?: IInboxStore;
  /** Resolve the context-telemetry reader for a workspace (issue #132) - the
   *  composition root binds this to the workspace's runtime adapter + dir.
   *  Optional so embedders without adapter access skip timeout attribution. */
  readonly readContextTelemetry?: (
    ws: WorkspaceMeta,
    sessionId: string,
  ) => Promise<ContextTelemetry | null>;
  readonly logger: Logger;
  /** Injectable clock for tests - epoch ms, same convention as
   *  `ScheduleScanner`. */
  readonly now?: () => number;
  /** Injectable tick interval for tests. */
  readonly intervalMs?: number;
}

export class StewardSupervisorScanner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private scanning = false;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(private readonly deps: StewardSupervisorScannerDeps) {
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /** Begin ticking. First scan happens after one interval (never on construct). */
  start(): void {
    if (this.timer || this.stopped) return;
    this.arm();
    this.deps.logger.info('steward_supervisor_scanner.started', { intervalMs: this.intervalMs });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tickAndRearm(), this.intervalMs);
    // Don't hold the event loop / a test runner open on this timer.
    this.timer.unref?.();
  }

  private async tickAndRearm(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    try {
      await this.scan();
    } catch (err) {
      this.deps.logger.warn('steward_supervisor_scanner.scan_failed', { err });
    }
    if (!this.stopped) this.arm();
  }

  /** One full pass over every steward-templated workspace. Public for tests /
   *  a future "scan now". A single workspace's failure is caught and logged
   *  so it never stops the rest of the sweep. */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.deps.logger.info('steward_supervisor_scanner.scan_overlap_skipped', {});
      return;
    }
    this.scanning = true;
    try {
      const stewardWorkspaces = this.deps.registry.list().filter((ws) => ws.template === 'steward');
      for (const ws of stewardWorkspaces) {
        await this.tickWorkspace(ws);
      }
    } finally {
      this.scanning = false;
    }
  }

  private async tickWorkspace(ws: WorkspaceMeta): Promise<void> {
    try {
      const config = await readStewardConfig(ws);
      const readContextTelemetry = this.deps.readContextTelemetry;
      await runStewardSupervisorTick(ws, {
        config,
        now: new Date(this.now()).toISOString(),
        isSessionRunning: (sessionId) => this.deps.pool.get(sessionId) !== undefined,
        ...(readContextTelemetry
          ? { readContextTelemetry: (sessionId: string) => readContextTelemetry(ws, sessionId) }
          : {}),
        ...(this.deps.inboxStore ? { inboxStore: this.deps.inboxStore } : {}),
        logger: this.deps.logger,
      });
    } catch (err) {
      this.deps.logger.warn('steward_supervisor_scanner.tick_failed', { wsId: ws.id, err });
    }
  }
}
