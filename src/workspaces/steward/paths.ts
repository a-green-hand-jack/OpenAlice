import { join } from 'node:path';

export const STEWARD_ROOT_REL = '.alice/steward';
export const STEWARD_WAKES_REL = `${STEWARD_ROOT_REL}/wakes`;
export const STEWARD_LEDGER_REL = `${STEWARD_ROOT_REL}/ledger/decisions.jsonl`;
export const STEWARD_SUPERVISOR_REL = `${STEWARD_ROOT_REL}/supervisor.jsonl`;
export const STEWARD_STATE_REL = `${STEWARD_ROOT_REL}/state.json`;
export const STEWARD_LOCKS_REL = `${STEWARD_ROOT_REL}/locks`;
/** Per-wake finalization markers (issue #136 finalize barrier). Gitignored,
 *  operational — like locks/state. Written atomically by the generated
 *  validate-ledger.mjs once a wake's ledger entry passes all checks. */
export const STEWARD_FINALIZE_REL = `${STEWARD_ROOT_REL}/finalize`;
/** Per-wake decision DRAFTS (issue #140). The agent writes its decision here with
 *  its native Write/Edit tool; the generated validate-ledger.mjs is the ONLY
 *  supported writer of decisions.jsonl. Gitignored scratch. */
export const STEWARD_DRAFTS_REL = `${STEWARD_ROOT_REL}/drafts`;
/** Launcher-owned, immutable per-wake Information Snapshot M1 files. */
export const STEWARD_SNAPSHOTS_REL = `${STEWARD_ROOT_REL}/snapshots`;
/** Deterministic sizing audit records. These are launcher-owned, immutable,
 * and created lazily by the D2 core writer. */
export const STEWARD_EXECUTION_RECORDS_REL = `${STEWARD_ROOT_REL}/execution-records`;
/** Launcher-owned, content-addressed evidence and immutable per-wake
 * evaluation manifests. Created lazily by the D3 provenance store. */
export const STEWARD_EVALUATION_PROVENANCE_REL = `${STEWARD_ROOT_REL}/evaluation-provenance`;
/** Per-workspace machine control-face thread state (issue #146). ONE file per
 *  workspace (not per-wake) — a machine wake resumes the SAME native thread as
 *  the prior wake, so this id lets wake N+1 re-attach across Alice restarts.
 *  Gitignored operational state like locks/state; no migration framework. */
export const STEWARD_MACHINE_THREAD_REL = `${STEWARD_ROOT_REL}/machine-thread.json`;

export function stewardRootPath(workspaceDir: string): string {
  return join(workspaceDir, '.alice', 'steward');
}

export function stewardWakesDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'wakes');
}

export function stewardLedgerPath(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'ledger', 'decisions.jsonl');
}

export function stewardSupervisorLogPath(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'supervisor.jsonl');
}

export function stewardStatePath(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'state.json');
}

export function stewardLocksDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'locks');
}

export function stewardLockFilename(accountId: string): string {
  return `${encodeURIComponent(accountId)}.json`;
}

export function stewardLockPath(workspaceDir: string, accountId: string): string {
  return join(stewardLocksDir(workspaceDir), stewardLockFilename(accountId));
}

export function stewardWakeFilename(wakeId: string): string {
  return `${encodeURIComponent(wakeId)}.json`;
}

export function stewardWakePath(workspaceDir: string, wakeId: string): string {
  return join(stewardWakesDir(workspaceDir), stewardWakeFilename(wakeId));
}

export function stewardFinalizeDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'finalize');
}

/** Per-wake finalization-marker filename. Reuses the same URL-encoding as
 *  wake/lock filenames so an arbitrary wakeId is path-safe (issue #136). */
export function stewardFinalizeFilename(wakeId: string): string {
  return `${encodeURIComponent(wakeId)}.json`;
}

export function stewardFinalizePath(workspaceDir: string, wakeId: string): string {
  return join(stewardFinalizeDir(workspaceDir), stewardFinalizeFilename(wakeId));
}

export function stewardDraftsDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'drafts');
}

/** Per-wake draft filename (issue #140). Same URL-encoding as wake/lock/finalize
 *  filenames so an arbitrary wakeId is path-safe. */
export function stewardDraftFilename(wakeId: string): string {
  return `${encodeURIComponent(wakeId)}.json`;
}

export function stewardDraftPath(workspaceDir: string, wakeId: string): string {
  return join(stewardDraftsDir(workspaceDir), stewardDraftFilename(wakeId));
}

export function stewardSnapshotsDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'snapshots');
}

export function stewardSnapshotFilename(wakeId: string): string {
  return `${encodeURIComponent(wakeId)}.json`;
}

export function stewardSnapshotRelPath(wakeId: string): string {
  return `${STEWARD_SNAPSHOTS_REL}/${stewardSnapshotFilename(wakeId)}`;
}

export function stewardSnapshotPath(workspaceDir: string, wakeId: string): string {
  return join(stewardSnapshotsDir(workspaceDir), stewardSnapshotFilename(wakeId));
}

export function stewardExecutionRecordsDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'execution-records');
}

export function stewardExecutionRecordFilename(recordId: string): string {
  return `${encodeURIComponent(recordId)}.json`;
}

export function stewardExecutionRecordPath(workspaceDir: string, recordId: string): string {
  return join(stewardExecutionRecordsDir(workspaceDir), stewardExecutionRecordFilename(recordId));
}

export function stewardEvaluationProvenanceDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'evaluation-provenance');
}

/** The single machine control-face thread record for a workspace (issue #146). */
export function stewardMachineThreadPath(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'machine-thread.json');
}

/** The cross-process advisory lock guarding writes to decisions.jsonl (issue
 *  #140). Same protocol in the TS StewardLedgerStore and the generated
 *  validate-ledger.mjs, so a future concurrent writer never loses an update. */
export function stewardLedgerLockPath(workspaceDir: string): string {
  return `${stewardLedgerPath(workspaceDir)}.lock`;
}
