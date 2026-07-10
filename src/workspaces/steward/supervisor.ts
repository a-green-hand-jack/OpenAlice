import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { buildStewardState, type StewardCostPolicyInput } from './cost.js';
import { createStewardLedgerStore } from './ledger-store.js';
import { createStewardLockStore } from './lock-store.js';
import { stewardStatePath, stewardSupervisorLogPath } from './paths.js';
import { createStewardWakeStore } from './wake-store.js';
import type { ContextTelemetry } from '../cli-adapter.js';
import type {
  StewardCostSummary,
  StewardState,
  StewardWakeAttribution,
  StewardWakeRecord,
  StewardWakeStatus,
} from './types.js';

export interface StewardSupervisorTickOptions {
  readonly now?: string;
  readonly isSessionRunning?: (sessionId: string) => boolean;
  readonly config?: StewardCostPolicyInput;
  /**
   * Best-effort context-window telemetry reader for a wake's session (issue
   * #132). When a wake hits its deadline, the supervisor consults this to tell
   * a context-overflow timeout (session poisoned past the window) apart from a
   * plain slow timeout. Optional and failure-isolated — absent, missing, or a
   * throw ⇒ the timeout is classified plainly.
   */
  readonly readContextTelemetry?: (sessionId: string) => Promise<ContextTelemetry | null>;
}

export interface StewardSupervisorTransition {
  readonly wakeId: string;
  readonly from: StewardWakeStatus;
  readonly to: StewardWakeStatus;
  readonly reason: string;
}

export interface StewardSupervisorTickResult {
  readonly at: string;
  readonly transitions: StewardSupervisorTransition[];
  readonly activeWakeIds: string[];
  readonly cost: StewardCostSummary;
  readonly warnings: string[];
}

export class StewardSupervisor {
  constructor(private readonly workspaceDir: string) {}

  async tick(opts: StewardSupervisorTickOptions = {}): Promise<StewardSupervisorTickResult> {
    const now = opts.now ?? new Date().toISOString();
    const wakeStore = createStewardWakeStore(this.workspaceDir);
    const ledgerStore = createStewardLedgerStore(this.workspaceDir);
    const lockStore = createStewardLockStore(this.workspaceDir);
    const transitions: StewardSupervisorTransition[] = [];
    // Issue #132 (PR #133 review): telemetry-degradation warnings collected
    // across the loop below — a timed-out wake whose session IS tracked but
    // whose rollout telemetry came back null/unreadable gets a distinct
    // warning here (not just a silent plain-timeout fallback), so campaign
    // reports and operators can see attribution silently went dark.
    const telemetryWarnings: string[] = [];
    const wakes = await wakeStore.list();

    for (const wake of wakes) {
      if (isTerminal(wake.status)) {
        await lockStore.release(wake.envelope.accountId, wake.wakeId);
        continue;
      }

      const ledgerEntry = await ledgerStore.findByWakeId(wake.wakeId);
      if (ledgerEntry) {
        const nextStatus = ledgerEntry.status === 'done'
          ? 'done'
          : ledgerEntry.status === 'blocked'
            ? 'blocked'
            : 'error';
        const updated = await wakeStore.updateStatus(wake.wakeId, nextStatus, {
          now,
          completedAt: ledgerEntry.at,
          error: nextStatus === 'error' ? ledgerEntry.completion.reason : null,
        });
        await lockStore.release(updated.envelope.accountId, updated.wakeId);
        transitions.push({
          wakeId: updated.wakeId,
          from: wake.status,
          to: updated.status,
          reason: `ledger:${ledgerEntry.status}`,
        });
        await appendSupervisorEvent(this.workspaceDir, {
          at: now,
          type: 'wake_completed',
          wakeId: updated.wakeId,
          from: wake.status,
          to: updated.status,
          ledgerAt: ledgerEntry.at,
          decision: ledgerEntry.decision,
        });
        continue;
      }

      if (Date.parse(wake.deadline) <= Date.parse(now)) {
        // Issue #132: attribute the timeout. If the session's rollout shows
        // input_tokens already at/past the model context window, this wake
        // died because the session was context-poisoned, not merely slow —
        // distinct in the terminal metadata and the supervisor event so
        // campaign reports can count context overflows apart from timeouts.
        const { attribution, warning: telemetryWarning } = await this.classifyTimeout(
          wake.sessionId,
          opts.readContextTelemetry,
        );
        if (telemetryWarning) telemetryWarnings.push(telemetryWarning);
        const updated = await wakeStore.updateStatus(wake.wakeId, 'timeout', {
          now,
          completedAt: now,
          error: attribution
            ? `deadline expired at ${wake.deadline}; context overflow ` +
              `(input_tokens ${attribution.inputTokens} >= window ${attribution.modelContextWindow})`
            : `deadline expired at ${wake.deadline}`,
          ...(attribution ? { attribution } : {}),
        });
        await lockStore.release(updated.envelope.accountId, updated.wakeId);
        transitions.push({
          wakeId: updated.wakeId,
          from: wake.status,
          to: updated.status,
          reason: 'deadline_expired',
        });
        await appendSupervisorEvent(this.workspaceDir, {
          at: now,
          type: 'wake_timeout',
          wakeId: updated.wakeId,
          from: wake.status,
          to: updated.status,
          deadline: wake.deadline,
          ...(attribution
            ? {
              attribution: 'context_overflow',
              inputTokens: attribution.inputTokens,
              modelContextWindow: attribution.modelContextWindow,
            }
            : {}),
          ...(telemetryWarning ? { telemetryWarning } : {}),
        });
        continue;
      }

      if (
        wake.status === 'injected' &&
        wake.sessionId &&
        opts.isSessionRunning &&
        !opts.isSessionRunning(wake.sessionId)
      ) {
        const updated = await wakeStore.updateStatus(wake.wakeId, 'stuck', {
          now,
          completedAt: now,
          error: `session not running: ${wake.sessionId}`,
        });
        await lockStore.release(updated.envelope.accountId, updated.wakeId);
        transitions.push({
          wakeId: updated.wakeId,
          from: wake.status,
          to: updated.status,
          reason: 'session_not_running',
        });
        await appendSupervisorEvent(this.workspaceDir, {
          at: now,
          type: 'wake_stuck',
          wakeId: updated.wakeId,
          from: wake.status,
          to: updated.status,
          sessionId: wake.sessionId,
        });
      }
    }

    const state = await writeCostState(this.workspaceDir, opts.config, now);
    await appendSupervisorEvent(this.workspaceDir, {
      at: now,
      type: 'cost_summary',
      cost: state.cost,
      warnings: state.warnings,
    });

    // Issue #125 D3: exactly one terminal entry per wakeId. Reconciliation
    // above already takes the first-wins entry; any later duplicate is a
    // tamper-evident violation the supervisor surfaces (never a hard failure of
    // the tick) so reports and operators can see it.
    const { duplicates, invalid } = await ledgerStore.readDiagnostics();
    const duplicateWarnings = duplicates.map(
      (dup) =>
        `duplicate ledger entry for wake ${dup.wakeId}: line ${dup.duplicateLine} ignored (first-wins line ${dup.firstLine})`,
    );
    if (duplicates.length > 0) {
      await appendSupervisorEvent(this.workspaceDir, {
        at: now,
        type: 'ledger_duplicates',
        duplicates,
      });
    }

    // A ledger line that fails to parse (bad JSON, missing required v2 field)
    // is otherwise invisible: findByWakeId simply never sees it, and the wake
    // just sits there until it times out with no visible cause. Symmetric to
    // the duplicates handling above.
    const invalidWarnings = invalid.map(
      (line) => `invalid ledger line ${line.line}: ${line.error}`,
    );
    if (invalid.length > 0) {
      await appendSupervisorEvent(this.workspaceDir, {
        at: now,
        type: 'ledger_invalid_lines',
        invalid,
      });
    }
    const warnings = [...state.warnings, ...duplicateWarnings, ...invalidWarnings, ...telemetryWarnings];

    const activeWakeIds = (await wakeStore.list())
      .filter((wake) => !isTerminal(wake.status))
      .map((wake) => wake.wakeId);

    return {
      at: now,
      transitions,
      activeWakeIds,
      cost: state.cost,
      warnings,
    };
  }

  /**
   * Best-effort context-overflow check for a timed-out wake (issue #132).
   * Returns a `context_overflow` attribution when the session's latest
   * telemetry has `input_tokens >= model_context_window`. Never throws — a
   * missing reader or no session classifies the timeout plainly with no
   * warning (nothing was expected to be tracked); a telemetry read that
   * throws OR resolves to `null` for a session that DOES have a tracked
   * sessionId classifies plainly too, but returns a `warning` string (PR #133
   * review) so the caller can surface that attribution silently went dark for
   * a session it should have been able to check.
   */
  private async classifyTimeout(
    sessionId: string | null,
    readContextTelemetry: StewardSupervisorTickOptions['readContextTelemetry'],
  ): Promise<{ attribution: StewardWakeAttribution | null; warning: string | null }> {
    if (!sessionId || !readContextTelemetry) return { attribution: null, warning: null };
    try {
      const telemetry = await readContextTelemetry(sessionId);
      if (!telemetry) {
        return {
          attribution: null,
          warning: `context telemetry unavailable for session ${sessionId} (timeout attribution skipped)`,
        };
      }
      if (telemetry.modelContextWindow > 0 && telemetry.inputTokens >= telemetry.modelContextWindow) {
        return {
          attribution: {
            kind: 'context_overflow',
            inputTokens: telemetry.inputTokens,
            modelContextWindow: telemetry.modelContextWindow,
          },
          warning: null,
        };
      }
      return { attribution: null, warning: null };
    } catch (err) {
      return {
        attribution: null,
        warning: `context telemetry read failed for session ${sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

export function createStewardSupervisor(workspaceDir: string): StewardSupervisor {
  return new StewardSupervisor(workspaceDir);
}

async function writeCostState(
  workspaceDir: string,
  config: StewardCostPolicyInput | undefined,
  now: string,
): Promise<StewardState> {
  const ledgerStore = createStewardLedgerStore(workspaceDir);
  const entries = await ledgerStore.read();
  const state = buildStewardState({ entries, config, now });
  await writeJsonAtomic(stewardStatePath(workspaceDir), state);
  return state;
}

async function appendSupervisorEvent(workspaceDir: string, event: Record<string, unknown>): Promise<void> {
  const path = stewardSupervisorLogPath(workspaceDir);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

function isTerminal(status: StewardWakeRecord['status']): boolean {
  return status === 'done' || status === 'blocked' || status === 'error' ||
    status === 'stuck' || status === 'timeout';
}
