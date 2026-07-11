import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { buildStewardState, type StewardCostPolicyInput } from './cost.js';
import { createStewardFinalizeStore } from './finalize-store.js';
import { buildLedgerReceipt } from './ledger-receipt.js';
import { createStewardLedgerStore, type LedgerIndex } from './ledger-store.js';
import { createStewardLockStore } from './lock-store.js';
import { stewardStatePath, stewardSupervisorLogPath } from './paths.js';
import { createStewardWakeStore } from './wake-store.js';
import type { ContextTelemetry } from '../cli-adapter.js';
import {
  STEWARD_LEDGER_INTEGRITY_SCHEMA_VERSION,
  type StewardCostSummary,
  type StewardDecisionLedgerEntry,
  type StewardLedgerIntegrityKind,
  type StewardLedgerReceipt,
  type StewardLedgerStatus,
  type StewardState,
  type StewardWakeAttribution,
  type StewardWakeRecord,
  type StewardWakeStatus,
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
    // Issue #134: ledger-integrity warnings from re-reconciling ALREADY-terminal
    // ledger-backed wakes (a completed wake whose first-wins entry later
    // disappeared or was mutated). Collected across the loop, surfaced in the
    // tick result and as structured supervisor events.
    const integrityWarnings: string[] = [];
    // Issue #136: finalize-barrier warnings — a marker-protocol wake whose
    // ledger entry changed after it validated (marker fingerprint no longer
    // matches), so the supervisor is holding off terminalization until the
    // corrected entry is re-validated.
    const finalizeWarnings: string[] = [];
    // Issue #134: parse the ledger ONCE per tick and reuse the index for active
    // transitions, terminal reconciliation, diagnostics, and cost — no per-wake
    // re-read (was O(n²) over wakes × file).
    const ledgerIndex = await ledgerStore.readIndex();
    const wakes = await wakeStore.list();

    for (const wake of wakes) {
      if (isTerminal(wake.status)) {
        await lockStore.release(wake.envelope.accountId, wake.wakeId);
        // Issue #134: a ledger-backed terminal wake (done|blocked|error) that
        // was actually DISPATCHED is not "finished business" — its first-wins
        // ledger entry must still exist and match the receipt captured at
        // completion. A wake that never dispatched (no injectedAt) and never
        // earned a receipt — e.g. a POST-time session-select/inject failure
        // marked `error` — was never ledger-backed, so it is NOT reconciled
        // (that would be a perpetual false alarm). timeout/stuck aren't
        // ledger-backed either.
        if (isLedgerBacked(wake.status) && wasLedgerBacked(wake)) {
          const warning = await this.reconcileTerminalLedger(wake, wakeStore, ledgerIndex, now);
          if (warning) integrityWarnings.push(warning);
        }
        continue;
      }

      const found = ledgerIndex.firstWins.get(wake.wakeId);
      // Only a schema-VALID first-wins line drives a status transition; a
      // JSON-valid-but-schema-invalid first-wins line is surfaced via the
      // invalid diagnostics below and the wake waits (deadline/liveness).
      //
      // Issue #136 finalize barrier: for a marker-protocol wake, raw ledger
      // presence is NOT enough — the generated validator must have published a
      // finalization marker whose fingerprint matches the CURRENT first-wins
      // entry. This closes the race where the supervisor terminalized a draft
      // that the agent then legally corrected in place (a #125-permitted edit),
      // making the correction look like a #134 post-terminal mutation. A missing
      // marker means "not validated yet" (wait); a mismatching marker means the
      // entry changed after validation (wait + warn until re-validated).
      const finalizeGate = found?.valid && found.entry
        ? await this.checkFinalizeBarrier(wake, found.fingerprint)
        : { transition: false as boolean, warning: null as string | null };
      if (finalizeGate.warning) finalizeWarnings.push(finalizeGate.warning);
      if (found?.valid && found.entry && finalizeGate.transition) {
        const ledgerEntry = found.entry;
        const nextStatus = ledgerEntry.status === 'done'
          ? 'done'
          : ledgerEntry.status === 'blocked'
            ? 'blocked'
            : 'error';
        // Capture the corruption-evidence receipt as part of the very transition
        // to terminal (issue #134). updateStatus never overwrites an existing
        // receipt, so this is a no-op on any later re-reconcile.
        const receipt = buildLedgerReceipt({
          entry: ledgerEntry,
          status: nextStatus,
          fingerprint: found.fingerprint,
          recordedAt: now,
        });
        const updated = await wakeStore.updateStatus(wake.wakeId, nextStatus, {
          now,
          completedAt: ledgerEntry.at,
          error: nextStatus === 'error' ? ledgerEntry.completion.reason : null,
          ledgerReceipt: receipt,
          // Issue #139: clear any pre-terminal active-identity-mismatch marker —
          // the wake is now correctly filed and terminal; #134 reconciliation
          // takes over from the receipt.
          ...(wake.ledgerIntegrity?.kind === 'active_identity_mismatch' ? { ledgerIntegrity: null } : {}),
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

      // Issue #139: the wake did not finalize this tick. If a ledger entry is
      // filed under a WRONG top-level wakeId but its evidence self-references
      // THIS active wake, surface it as an actionable event now instead of
      // silently waiting out the deadline.
      const identityWarning = await this.reconcileActiveIdentity(wake, wakeStore, ledgerIndex, now);
      if (identityWarning) finalizeWarnings.push(identityWarning);

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
          // Issue #139: a timeout is not ledger-backed — clear any stale
          // active-identity-mismatch marker so it doesn't linger on the record.
          ...(wake.ledgerIntegrity?.kind === 'active_identity_mismatch' ? { ledgerIntegrity: null } : {}),
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
          // Issue #139: stuck is not ledger-backed — clear any stale
          // active-identity-mismatch marker.
          ...(wake.ledgerIntegrity?.kind === 'active_identity_mismatch' ? { ledgerIntegrity: null } : {}),
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

    // Cost/state from the same single ledger parse (issue #134 — no re-read).
    const state = await writeCostState(this.workspaceDir, ledgerIndex.entries, opts.config, now);
    await appendSupervisorEvent(this.workspaceDir, {
      at: now,
      type: 'cost_summary',
      cost: state.cost,
      warnings: state.warnings,
    });

    // Issue #125 D3: exactly one terminal entry per wakeId. Reconciliation
    // above already takes the first-wins entry; any later duplicate is a
    // corruption-evident violation the supervisor surfaces (never a hard failure
    // of the tick) so reports and operators can see it.
    const { duplicates, invalid } = ledgerIndex;
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
    const warnings = [
      ...state.warnings,
      ...duplicateWarnings,
      ...invalidWarnings,
      ...telemetryWarnings,
      ...integrityWarnings,
      ...finalizeWarnings,
    ];

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

  /**
   * Finalize barrier (issue #136). Decide whether a nonterminal wake with a
   * schema-valid first-wins entry may transition NOW.
   *
   *  - Legacy wakes (created before the barrier shipped — no `finalizeProtocol`)
   *    keep the old behavior: raw ledger presence terminalizes. This is the
   *    BOUNDED compatibility rule — only in-flight wakes predating this change
   *    take this path; every new wake carries `finalizeProtocol: 'marker'`.
   *  - Marker-protocol wakes transition only when the generated validator has
   *    published a finalization marker whose fingerprint matches the CURRENT
   *    first-wins semantic fingerprint:
   *      · no marker            → not validated yet; wait (no warning);
   *      · fingerprint mismatch → entry changed after validation (a legal
   *        same-wake correction that hasn't been re-validated); wait + warn.
   */
  private async checkFinalizeBarrier(
    wake: StewardWakeRecord,
    currentFingerprint: string,
  ): Promise<{ transition: boolean; warning: string | null }> {
    if (!requiresFinalizeMarker(wake)) return { transition: true, warning: null };
    const marker = await createStewardFinalizeStore(this.workspaceDir).read(wake.wakeId);
    if (!marker) return { transition: false, warning: null };
    if (marker.fingerprint !== currentFingerprint) {
      return {
        transition: false,
        warning: `finalize marker for wake ${wake.wakeId} does not match the current ledger entry ` +
          `(the entry was edited after it validated); re-run validate-ledger to re-commit before it terminalizes`,
      };
    }
    return { transition: true, warning: null };
  }

  /**
   * Surface an active wake whose completion was filed under the WRONG top-level
   * wakeId (issue #139). If some ledger entry's `wake:` evidence self-references
   * this active wake but its top-level wakeId differs, the steward typo'd the
   * top-level id — the real wake would otherwise wait out the full deadline. We
   * emit an actionable `ledger_identity_mismatch` event (deduped once per
   * (wake, wrong-id) via the wake's `ledgerIntegrity` marker) and a per-tick
   * warning telling the steward to correct the top-level wakeId and re-validate.
   * On resolution the marker is cleared with a `ledger_identity_recovered` event.
   * This never terminalizes anything — an in-progress write is never mistaken
   * for a completion.
   */
  private async reconcileActiveIdentity(
    wake: StewardWakeRecord,
    wakeStore: ReturnType<typeof createStewardWakeStore>,
    ledgerIndex: LedgerIndex,
    now: string,
  ): Promise<string | null> {
    const mismatch = ledgerIndex.identityMismatches.find((m) => m.referencedWakeId === wake.wakeId) ?? null;
    const prior = wake.ledgerIntegrity;
    const priorIsActive = prior?.kind === 'active_identity_mismatch';

    if (!mismatch) {
      if (priorIsActive) {
        await wakeStore.updateStatus(wake.wakeId, wake.status, { now, ledgerIntegrity: null });
        await appendSupervisorEvent(this.workspaceDir, {
          at: now,
          type: 'ledger_identity_recovered',
          wakeId: wake.wakeId,
          previouslyFiledUnderWakeId: prior?.misfiledUnderWakeId ?? null,
        });
      }
      return null;
    }

    const warning = `ledger identity mismatch for active wake ${wake.wakeId}: a ledger entry filed under ` +
      `wakeId ${mismatch.entryWakeId} (line ${mismatch.line}) references this wake in its evidence; its ` +
      `top-level wakeId is wrong. Correct the entry's top-level wakeId to ${wake.wakeId} and re-run validate-ledger.`;
    if (priorIsActive && prior?.misfiledUnderWakeId === mismatch.entryWakeId) {
      return warning; // already recorded this exact mismatch; re-warn only
    }
    await appendSupervisorEvent(this.workspaceDir, {
      at: now,
      type: 'ledger_identity_mismatch',
      wakeId: wake.wakeId,
      filedUnderWakeId: mismatch.entryWakeId,
      line: mismatch.line,
      detail: warning,
    });
    await wakeStore.updateStatus(wake.wakeId, wake.status, {
      now,
      ledgerIntegrity: {
        version: STEWARD_LEDGER_INTEGRITY_SCHEMA_VERSION,
        kind: 'active_identity_mismatch',
        misfiledUnderWakeId: mismatch.entryWakeId,
        firstDetectedAt: now,
      },
    });
    return warning;
  }

  /**
   * Re-reconcile an ALREADY-terminal, ledger-backed, actually-dispatched wake
   * against the current ledger index (issue #134). The first terminal transition
   * recorded a receipt (canonical semantic fingerprint of the first-wins entry).
   * Every later tick re-checks that the entry still exists and still matches:
   *
   *  - receipt present, entry gone      → `entry_missing` (a completed decision
   *                                        was deleted from history);
   *  - receipt present, fingerprint ≠   → `entry_mutated` (history was rewritten
   *                                        in place);
   *  - receipt present, fingerprint =   → clean; clears any prior marker;
   *  - receipt ABSENT (pre-#134 wake):
   *      · entry present → back-fill a `bootstrapped` receipt once (honest: we
   *        adopt what's there, we never claim to have had the original);
   *      · entry gone → `entry_missing_no_receipt` (surfaced, never fabricated).
   *
   * Returns a per-tick warning string on a violation (null otherwise). The
   * structured `ledger_integrity_violation` event is written ONCE per distinct
   * (kind, expected/actual fingerprint) — deduped via `wake.ledgerIntegrity` —
   * so a persistent violation doesn't grow `supervisor.jsonl` unbounded. A
   * recovery (entry restored/matching) clears the marker and logs
   * `ledger_integrity_recovered`.
   */
  private async reconcileTerminalLedger(
    wake: StewardWakeRecord,
    wakeStore: ReturnType<typeof createStewardWakeStore>,
    ledgerIndex: LedgerIndex,
    now: string,
  ): Promise<string | null> {
    const status = wake.status as StewardLedgerStatus;
    const found = ledgerIndex.firstWins.get(wake.wakeId) ?? null;
    const receipt = wake.ledgerReceipt;

    let violation: IntegrityViolation | null = null;
    if (receipt) {
      if (!found) {
        violation = {
          kind: 'entry_missing',
          status,
          expectedFingerprint: receipt.fingerprint,
          detail: `first-wins ledger entry for terminal wake ${wake.wakeId} (${status}) is gone; ` +
            `it was recorded at ${receipt.recordedAt}`,
        };
      } else if (found.fingerprint !== receipt.fingerprint) {
        violation = {
          kind: 'entry_mutated',
          status,
          expectedFingerprint: receipt.fingerprint,
          actualFingerprint: found.fingerprint,
          detail: `first-wins ledger entry for terminal wake ${wake.wakeId} (${status}) changed since it was ` +
            `recorded; the original decision has been rewritten`,
        };
      }
    } else if (found?.valid && found.entry) {
      // No receipt but an entry is present: back-fill a bootstrapped receipt
      // exactly once (write-once guard in updateStatus makes re-runs no-ops).
      const bootstrapReceipt: StewardLedgerReceipt = buildLedgerReceipt({
        entry: found.entry,
        status,
        fingerprint: found.fingerprint,
        recordedAt: now,
        bootstrapped: true,
      });
      await wakeStore.updateStatus(wake.wakeId, wake.status, { now, ledgerReceipt: bootstrapReceipt });
    } else {
      // No receipt AND no usable entry: honest, un-fabricated violation.
      violation = {
        kind: 'entry_missing_no_receipt',
        status,
        detail: `terminal wake ${wake.wakeId} (${status}) has no valid ledger entry and no receipt to ` +
          `reconcile against; its completion evidence cannot be confirmed`,
      };
    }

    return this.applyIntegrityOutcome(wake, wakeStore, violation, now);
  }

  /**
   * Persist/append at most once per distinct violation, clear on recovery, and
   * return the per-tick warning (issue #134 event dedup). `wake.ledgerIntegrity`
   * is the dedup key: a violation whose (kind, expected, actual) already matches
   * the stored marker re-warns but does NOT append another event.
   */
  private async applyIntegrityOutcome(
    wake: StewardWakeRecord,
    wakeStore: ReturnType<typeof createStewardWakeStore>,
    violation: IntegrityViolation | null,
    now: string,
  ): Promise<string | null> {
    const prior = wake.ledgerIntegrity;

    if (!violation) {
      // Recovery: an entry that previously violated now reconciles.
      if (prior) {
        await wakeStore.updateStatus(wake.wakeId, wake.status, { now, ledgerIntegrity: null });
        await appendSupervisorEvent(this.workspaceDir, {
          at: now,
          type: 'ledger_integrity_recovered',
          wakeId: wake.wakeId,
          recoveredKind: prior.kind,
        });
      }
      return null;
    }

    const warning = `ledger integrity violation for wake ${wake.wakeId}: ${violation.detail}`;
    const sameAsPrior = prior !== undefined &&
      prior.kind === violation.kind &&
      prior.expectedFingerprint === violation.expectedFingerprint &&
      prior.actualFingerprint === violation.actualFingerprint;
    if (sameAsPrior) return warning; // already recorded; re-warn only

    await appendSupervisorEvent(this.workspaceDir, {
      at: now,
      type: 'ledger_integrity_violation',
      wakeId: wake.wakeId,
      kind: violation.kind,
      status: violation.status,
      ...(violation.expectedFingerprint ? { expectedFingerprint: violation.expectedFingerprint } : {}),
      ...(violation.actualFingerprint ? { actualFingerprint: violation.actualFingerprint } : {}),
      detail: violation.detail,
    });
    await wakeStore.updateStatus(wake.wakeId, wake.status, {
      now,
      ledgerIntegrity: {
        version: STEWARD_LEDGER_INTEGRITY_SCHEMA_VERSION,
        kind: violation.kind,
        ...(violation.expectedFingerprint ? { expectedFingerprint: violation.expectedFingerprint } : {}),
        ...(violation.actualFingerprint ? { actualFingerprint: violation.actualFingerprint } : {}),
        firstDetectedAt: now,
      },
    });
    return warning;
  }
}

interface IntegrityViolation {
  readonly kind: StewardLedgerIntegrityKind;
  readonly status: StewardLedgerStatus;
  readonly detail: string;
  readonly expectedFingerprint?: string;
  readonly actualFingerprint?: string;
}

export function createStewardSupervisor(workspaceDir: string): StewardSupervisor {
  return new StewardSupervisor(workspaceDir);
}

async function writeCostState(
  workspaceDir: string,
  entries: readonly StewardDecisionLedgerEntry[],
  config: StewardCostPolicyInput | undefined,
  now: string,
): Promise<StewardState> {
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

/** A terminal status that MUST be backed by a decision-ledger entry (issue
 *  #134). timeout/stuck are terminal but write no ledger entry, so they are
 *  excluded from ledger-integrity reconciliation. */
function isLedgerBacked(status: StewardWakeRecord['status']): boolean {
  return status === 'done' || status === 'blocked' || status === 'error';
}

/**
 * Whether a terminal wake was actually DISPATCHED and thus genuinely
 * ledger-backed for completeness reconciliation (issue #134, PR #135 review). A
 * wake that reached `error` at POST time — a session-select or inject failure
 * before it ever ran — has no `injectedAt` and never earned a receipt; it was
 * never expected to write a ledger entry, so reconciling it would be a
 * perpetual false alarm. A wake that already carries a receipt is, by
 * definition, dispatched.
 */
function wasLedgerBacked(wake: StewardWakeRecord): boolean {
  return wake.injectedAt != null || wake.ledgerReceipt !== undefined;
}

/** Whether a wake must clear the finalize barrier before terminalizing (issue
 *  #136). True for every wake created with the marker protocol; false only for
 *  legacy in-flight wakes that predate it (bounded compatibility). */
function requiresFinalizeMarker(wake: StewardWakeRecord): boolean {
  return wake.finalizeProtocol === 'marker';
}
